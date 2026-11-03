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
- **unwarp.py** — mock-up of the back camera without its fisheye (cylindrical panorama + three virtual pinhole cameras), with
  YOLO boxes on each, from the lens in `js/rig.js`.
- **detect-tracks.py + handoff-check.js** — YOLO tracks in every camera; for each object leaving a camera, the predicted entry
  into the neighbour against the track that really appears there, with and without the clock offsets.

## Measured (2024 Model X, HW4, six cameras; two drives averaged)

Drives: 2026-10-19 (60 s, two right-angle turns) and 2026-10-07 (46 s, turns of ~75° and ~45°, a stop). `js/rig.js` holds the mean;
heights are weighted by how precisely each drive measured them, left and right together.

| camera | yaw | pitch | roll | horizontal view | height above road | fit (median) |
|---|---|---|---|---|---|---|
| front | 0.7° | −1.0° | 1.2° | ~44° | 1.30 m | 0.19 px |
| left / right pillar | −70.8° / 71.8° | −5.4° / −5.8° | 0.5° / −0.4° | ~85° | 1.33 m | 0.17 / 0.21 px |
| left / right repeater | −139.9° / 139.5° | −4.8° / −4.5° | 0.2° / 1.4° | ~83° | 0.96 m | 0.21 / 0.19 px |
| back | −179.5° | −32.9° | 0.7° | ~187° fisheye | 1.00 m | 0.14 px |

**Repeatability (drive 10-07 against 10-19):** yaw within 1.1° (most within 0.8°); pitch within 1.8° — the front, back and
pillars all ~1° lower together, i.e. the car sat a little differently, not the cameras; roll within 1°; focal length within 0–5 %
for the wide cameras, 9 % for the narrow front lens (its 44° view gets least from the turns). Heights per drive and camera ranged
±0.1 m (repeater 0.79–1.06 m), so a profile should combine drives.

- **Blind wedges:** 8 m out, nothing sees the road from about 20° to 30° either side of straight ahead (between the 44° front
  camera and the pillars). Pillars ∩ repeaters and repeaters ∩ back overlap.
- **File clocks:** the six files of a clip don't start together. From their own telemetry: back +0.35 s, right pillar +0.18 s,
  left pillar +0.07 s, repeaters −0.03 s against the front. Each file's frames agree with its own telemetry within ±0.07 s
  (2 frames), so offsets above that are real; `js/rig.js` measures them per clip.
- **File clocks change from clip to clip:** on the 10-07 drive back −0.45 s, left pillar −0.41 s, right pillar −0.25 s, repeaters
  −0.14 / −0.36 s (10-19: +0.35, +0.07, +0.18, −0.03 / −0.03 s). Measure them per clip; never use a fixed table.
- **Hand-off check with the averaged rig** (YOLO11s tracks, objects leaving a camera through a side edge, each clip's own clocks):
  10-19: 73 road-based predictions, all matched a track in the neighbour, median timing error 0.21 s, place error 5.4 % of the
  picture width; 10-07: 55 predictions, 52 matched, 0.22 s, 5.8 %.
- **Rear camera unwarped** (`unwarp.py`): the fisheye re-rendered as a cylindrical panorama and as three virtual pinhole cameras
  with the measured lens. YOLO on 10-19: the white car close behind 54 % with an oversized box on the fisheye → 91 % (panorama) /
  94 % (pinhole), parked cars down the street 42–80 % → 62–91 %; on 10-07 the panorama finds 6 objects against 4. The pinhole
  views split an object across their seams (one van read as a bus and a truck); the panorama has no seams.

## In the app: Calibrate from this drive (`js/rig-calib.js`, `js/rig-calib-ui.js`)

The same method runs in the browser, for any HW4 car, from a drive opened in the app: Settings ▸ Advanced & Labs ▸ Camera
calibration ▸ **Calibrate from this drive**. A Web Worker (started from a blob, so it works from `file://` and behind servers with
wrong MIME types) decodes each camera's file with WebCodecs, follows points with pyramidal Lucas-Kanade (half width: 724 px; the
2896-px front camera at a third, 966 px; every frame up to 30 fps, every 2nd above), builds the car's path from that file's own SEI
(rear-axle bicycle model, as `calibrate.py`) and fits, per camera: yaw, pitch, roll, lens width f and k1, k2 (k3 = 0, centre kept),
and the delay between the pictures and the telemetry. Then the height above the road by road-surface alignment
(`roadheight.py`'s NCC on gradient pictures), with triangulated road points as the fallback.

What differs from the offline fit, and why:
- **Start from a preset, tightly bounded.** `js/rig.js` PRESETS has one per model (Model 3 incl. Highland, Model Y incl. Juniper,
  Model YL, Model S, Model X, Cybertruck). All take the Model X's measured lenses and angles (same HW4 camera modules); positions
  and body boxes come from published dimensions and are **estimates** (only the Model X heights are measured). The fit allows
  yaw ±25°, pitch ±15°, roll ±8°, f ±12 %, k1 ±0.05, k2 ±0.03 round the preset and starts at 3 yaws × 3 lens widths; a value that
  ends on its bound fails the quality gate.
- **The body's attitude, two ways.** Per frame pair the car body can tilt between the two frames (Δ pitch/roll, as `calibrate.py`)
  *and* be tilted against the road at the first frame (B: the nose dips when braking, so the body's forward axis is not the
  direction of travel). Synthetic drives with ~0.1° of suspension motion showed that with Δ alone a side camera's pitch drifts
  0.5–0.7° (B can only be explained by tilting the camera); with B (prior 0.5°) it stays within 0.3°. `calibrate.py` has Δ only:
  the measured Model X pitches may carry part of that bias (worth re-running with B added).
- **Solver:** Levenberg-Marquardt on the Cauchy cost (IRLS), the 4 body unknowns per pair folded out by a Schur complement, outliers
  trimmed twice (4 × the robust spread). About 30–45 s per camera on 300 pairs × 60 points in Chromium.
- **Quality gate** (`QUALITY` in `js/rig-calib.js`): a camera is saved only with ≥ 40 frame pairs, ≥ 6 of them turning, ≥ 50 % of
  its points agreeing, no angle or lens width on its bound, and a median error ≤ 1.2 px in full-resolution pixels (≤ 0.6 = "good").
  Cameras that fail keep the starting values; nothing is saved when none passes. These limits are a first guess (see below).
- **Which model:** the measured heights are compared with each preset's (`closestPreset`, left and right averaged); the saved rig
  takes that model's positions along and across the car and its body boxes. Model Y and Model YL differ by only 2–3 cm in camera
  height and can't be told apart this way.
- **Per car:** `localStorage` `tdc.rig.v1` (several named cars; one active, applied with `T.rig.set()` at load). Export / import as
  JSON (`format: "dashcam-studio-rig"`, the same fields `set()` reads). A calibrated camera's `delay` is added to its file clock in
  `T.rig.clock()`.

Tests: `node test/rig-calib.test.js` (presets, path, tracker, the solver on synthetic tracks from the fixture drive's real motion:
angles within 0.5°, f within 1.5 %, delay within 20 ms, height within 5 cm; road-surface height on rendered pictures; the gate;
`--all` for all six cameras). `node test/rig-calib-page.js <url>` renders a synthetic six-camera clip of a known rig with
`tools/rig/make-footage.py` (textured road + posts, the fixture's path, SEI on every frame; ~7 min on 4 cores) and runs the whole
thing in the page: Settings section, worker, progress, page stays responsive, result vs truth, save, reload, export / import, reset.

**In-page result on the synthetic clip** (`test/rig-calib-page.js`, 30 s, four cameras, Chromium, 358 s in all, page answering
within 0.33 s throughout): front Δ yaw/pitch/roll 0.00/0.05/−0.09°, left pillar −0.18/0.06/−0.03°, right repeater **0.90**/0.21/0.09°
(f 3.5 % wide), back 0.37/0.45/**0.70**°; delays within 4 ms, heights within 4 cm, medians 0.29–0.47 px; model guess Model Y/YL.
The node solver test on the same motion with 3D points everywhere gets all within 0.3°, so the remaining error is the scene
(mostly flat road, a few posts, 30 s) letting yaw trade against lens width on the repeater and roll on the fisheye: real streets
(kerbs, cars, walls, a 60 s drive) should do better, but that is exactly what the real-clip check must show. The quality gate
does not catch a 0.9° yaw error at 0.3 px: on real clips compare against the measured Model X before trusting the gate.

**Still to check on real clips** (not possible without the footage):
1. Calibrate the 2026-10-19 Model X drive in the app (Chrome and Safari): each camera's angles against the MEASURED block of
   `js/rig.js` (expect within ~0.5°; pillar / repeater pitch may differ by up to ~0.5° because of the body-tilt term above), lens
   width within ~2 %, heights within ~5 cm, delays within ±0.07 s, and the closest preset = Model X.
2. The median error on real half-width tracks, to set `QUALITY.good` / `QUALITY.max` (offline full-width: 0.10–0.22 px).
3. The time it takes per camera on the Mac and on an iPhone/iPad (Safari's VideoDecoder in a worker; frames of `format` null take
   the OffscreenCanvas path), and that playback stays smooth meanwhile.
4. Hand-off with the in-app rig: `node tools/rig/handoff-check.js dets.json --rig <exported.json>` (68/68 matched with the offline rig).
5. Another model (a Model 3 or Y) if one is at hand: does `closestPreset` name it, and do the estimated positions need correcting?
