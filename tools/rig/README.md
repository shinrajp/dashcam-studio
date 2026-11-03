# Camera rig calibration (tools/rig)

Measures the six cameras from one ordinary drive — no chessboard, no targets. The car's own telemetry (speed and heading in each
file's SEI) is the reference: between two frames the car's move is known, and every point tracked across those frames must agree
with it. The result feeds `js/rig.js` (picture ↔ road, the car's own body, entry prediction for the hand-off, file clocks).

Needs Python 3 with `numpy opencv-python-headless scipy` (and `onnxruntime` for the hand-off check), ffmpeg/ffprobe, node.

```bash
CLIPS="<folder with one event's six *-front.mp4 … *-right_repeater.mp4>"; OUT=/tmp/rig; mkdir -p $OUT
for c in front back left_pillar right_pillar left_repeater right_repeater; do
  node tools/rig/sei-dump.js "$CLIPS"/*-$c.mp4 $OUT/sei-$c.json              # telemetry per frame
  python tools/rig/tracks.py "$CLIPS"/*-$c.mp4 $OUT/tr-$c.npz                # KLT point tracks
  python tools/rig/calibrate.py --sei $OUT --tracks $OUT --out $OUT/rig-$c.json --cams $c   # lens + mounting (~10 min a camera)
done
python - <<'EOF'   # one file
import json; o = {}
for c in ["front","back","left_pillar","right_pillar","left_repeater","right_repeater"]: o.update(json.load(open(f"/tmp/rig/rig-{c}.json")))
json.dump(o, open("/tmp/rig/rig-all.json", "w"), indent=1)
EOF
python tools/rig/roadheight.py $OUT/rig-all.json "$CLIPS" $OUT          # height above the road (road-surface alignment)
python tools/rig/rectify.py $OUT/rig-all.json "$CLIPS" 10 $OUT/rect.png  # check by eye: level horizons, straight lines
python tools/rig/to-js.py $OUT/rig-all.json $OUT                        # write the MEASURED block of js/rig.js
python tools/rig/detect-tracks.py "$CLIPS" $OUT/dets.json --sei $OUT && node tools/rig/handoff-check.js $OUT/dets.json
```

A good drive: a minute or more, moving, with at least one real turn (the turns fix each lens's focal length; straight driving
alone can't tell a wide lens from a narrow one), some texture on the road.

## What each step does

- **sei-dump.js** — the SEI telemetry of every frame (js/sei.js), as JSON.
- **tracks.py** — pyramidal Lucas-Kanade point tracks with a forward-backward check, topped up with new corners.
- **calibrate.py** — for frame pairs where the car moved ≥ 0.6 m or turned ≥ 1.5°, the car's move from the telemetry (rear-axle
  bicycle model) gives each pair's epipolar geometry. Unknowns: Kannala-Brandt lens (f, centre, k1–k3), yaw / pitch / roll
  (js/pano.js convention), the telemetry delay, and a small body pitch/roll per pair (suspension, road camber — the telemetry has
  the heading only; without it the fit is 5–10 px off). Residual: distance from the epipolar plane in pixels at the lens's local
  scale; Cauchy loss, outliers (other cars) trimmed; multi-start over yaw and lens width. The lens must keep growing out to the
  farthest tracked point (a folded fisheye otherwise wins).
- **roadheight.py** — the road patch of a later frame, warped onto an earlier one through the road plane at a trial height, lines
  up only at the true height (NCC of gradient images). Works on plain asphalt where tracked points are few.
- **bodymask.py** — a picture-based guess of where the car's own body is (median optical flow). Plain road and sky look just as
  still, so `js/rig.js` uses a geometric body (boxes) instead; kept as a diagnostic.
- **rectify.py** — each camera re-rendered as a level pinhole view with the horizon and the car's straight-ahead/back marked.
- **to-js.py** — copies the measured values (and the files' clock offsets from their telemetry) into `js/rig.js`.
- **detect-tracks.py + handoff-check.js** — YOLO tracks in every camera; for each object leaving a camera, the predicted entry
  into the neighbour against the track that really appears there, with and without the clock offsets.

## Measured (2026-10-19, 2024 Model X, HW4, six cameras)

| camera | yaw | pitch | roll | horizontal view | height above road | fit (median) |
|---|---|---|---|---|---|---|
| front | 1.0° | −0.7° | 1.5° | 44° | 1.30 m | 0.17 px |
| left / right pillar | −70.6° / 71.7° | −4.8° / −5.3° | 0.4° / −0.2° | 85° / 85° | 1.32 m (1.38 / 1.26) | 0.16 / 0.22 px |
| left / right repeater | −139.8° / 140.1° | −4.9° / −4.9° | 0.3° / 1.3° | 83° / 83° | 0.99 m (1.06 / 0.92) | 0.19 / 0.18 px |
| back | 180° | −32.0° | 0.2° | ~187° fisheye | 1.00 m | 0.10 px |

Left/right heights differ by less than their spread (±0.13–0.19 m), so each pair gets their mean. The positions along and across
the car are a 2024 Model X's from its dimensions (other models mount their cameras elsewhere: measure them).

- **Blind wedges:** 8 m out, nothing sees the road from about 20° to 30° either side of straight ahead (between the 44° front
  camera and the pillars). Pillars ∩ repeaters and repeaters ∩ back overlap.
- **File clocks:** the six files of a clip don't start together. From their own telemetry: back +0.35 s, right pillar +0.18 s,
  left pillar +0.07 s, repeaters −0.03 s against the front. Each file's frames agree with its own telemetry within ±0.07 s
  (2 frames), so offsets above that are real; `js/rig.js` measures them per clip.
- **Hand-off check on this drive** (YOLO11s tracks, 103 objects leaving a camera through a side edge): 68 got a road-based
  prediction, all 68 matched a track in the neighbour; median timing error 0.2 s, place error 5 % of the picture width.
