# Depth street replay (prototype)

A drive's six cameras turned into a textured 3D street you can turn around: each camera frame is lifted into 3D by an
AI depth model (Depth Anything V2 Small, ONNX) and painted with its own video pixels. This is the prototype behind the
private "Depth Street Replay" page (2026-11); it was built and tuned on the 2026-10-19 drive only. Not part of the app.

**Never commit outputs**: frames, depth maps, textures and pages show the drives and the repository is public (`.gitignore`).

## Pipeline (as run on 2026-10-19, 8.5–12.5 s)

1. `make_dataset.py` (from the splat experiment): six fisheye clips → level pinhole views + masks of the car's own body,
   with known poses (js/rig.js mounting × the telemetry path), as `<data>/frames.json`, `images/`, `masks/`, `sparse/0`.
   `common.py` holds that drive's clock offsets and telemetry delays (hard-coded for 10-19: must come from the clip).
2. Optional angle fine-tune: `align.py <data> <out.json> --prior 0.02` fits small per-camera rotations so neighbouring
   cameras show the same road; the corrected R was written into `<data>/frames.json` (its averaged result is now in
   js/rig.js MEASURED).
3. `depth.py <data> model_fp16.onnx <outA> --t0 8.5 --t1 12.5 --step 2` — AI depth, put into metres by a fit on road
   pixels (true depth from the road plane); bad frames borrow the camera's median scale; far = 70 m backdrop; sky dropped.
4. `node boxes.js <outA>/frames.json <data>/frames.json <dets.json> vboxes.json` — detector vehicle boxes (from
   tools/rig/detect-tracks.py) mapped into the pinhole views.
5. `fuse2.py <data> <outA> <out> vboxes.json` — road snap; road growing (`roadgrow.py`: far road the AI depth squashes,
   grown by colour from the near road, never inside vehicle boxes); per-pixel camera ownership with soft seams; mesh rows
   dense near each camera's horizon (a camera 1 m up sees all road past 10 m within ~5° of it).
6. `colour.py <out> <data>` — per-camera colour gains matched on shared road.
7. `pack.py <out> <page>` — `scene.json`, `depth.json`, `weights.json`, `tex/`, and `viewer.html` as `index.html`
   (three.js 0.160 from a CDN). `node shot.js <page> <shotdir> <tag>` renders Rear / Chase / Top views headless.

Results on 10-19: distances vs multi-view reference 3–10 m 0.87 m median error; seams meet; far road behind the car
reaches the cross street. Known gaps: blind spot behind the bumper, sky, what no camera saw.

## One command, any drive: `tools/depth3d/build.py`

The pipeline above is now one tool that works from any HW4 drive folder (no splat experiment, no hard-coded clocks):

```bash
python3 tools/depth3d/build.py "<drive folder>" "<page folder>" --t0 8.5 --t1 12.5 --model model_fp16.onnx
```

The folder holds a clip's six files (`<stamp>-front.mp4` … `-right_repeater.mp4`; for a SavedClips event with several clips
add `--clip <stamp>`); `t0`/`t1` are seconds of that clip on the front file's clock. The page folder gets `index.html` +
`scene.json`, `depth.json`, `weights.json`, `tex/` (serve it, e.g. `python3 -m http.server -d "<page folder>"`); intermediate
files and `report.json` go to `<page folder>.work`. Both show the drive: the tool refuses to write inside this repository.
Needs python3 with numpy, opencv-python-headless, onnxruntime; ffmpeg/ffprobe; node. The model (Depth Anything V2 Small, ONNX
fp16, input `pixel_values` 518×336) is not in the repository: pass its path.

What changed against the prototype steps:
- **Clocks** from each clip's own telemetry (`tools/depth3d/telemetry.js`: js/sei.js + js/rig.js `clockOffsets`), not
  `common.py`'s 10-19 table. **Telemetry delays**: from `--rig` (an in-app calibration export or tools/rig output with per-camera
  `delay`), else fitted from the clip with the rig held fixed (`delay.py`: KLT tracks + epipolar error of the telemetry move,
  1-D search per camera; 0 with a warning where the drive can't tell, e.g. parked). `--delays zero|rig|fit` overrides.
- **Poses**: js/rig.js MEASURED (with the road fine-tune) or `--rig`, × the front file's telemetry path. Views are picked on one
  time grid (`--dt`, default 1/6 s) for all cameras, so step k is the same moment in every camera even when the files' clocks
  differ (the prototype took every n-th frame per camera). No KLT point cloud.
- **Vehicle boxes**: `tools/rig/detect-tracks.py`'s YOLO + IoU tracks (default `models/yolo11s.onnx`), run on the stretch only;
  mapped into the views through the full ray (boxes.js kept the camera's own axes, 14° off for the back view's pitch). Without
  a detector model or onnxruntime the step is skipped with a warning (road growing then has no exclusion).
- depth → fuse (road snap, `roadgrow.py`, seams) → colour → pack are the prototype's, as importable modules
  (`tools/depth3d/{depth,fuse,colour,pack}.py`). Left out: the per-camera seam scale solve (measured no gain, never applied) and
  depth.py's validation against the splat experiment's multi-view rows (needs that dataset).
- `viewer.html` takes the drive, stretch and number of steps from `scene.json`.

Tests (synthetic, no footage): `python3 test/depth3d.test.py` (~10 s) and `python3 test/depth3d-e2e.py` (~8 min: renders a
synthetic six-camera drive with a known rig, file clocks and delays via `tools/rig/make-footage.py`, builds it with the depth
**stand-in** `--depth-stub`, and checks clocks, delays, poses, road depth, road growing and the page). Not yet run on real
footage or with the real model.

## Next (open)

Run `build.py` on 10-19 (8.5–12.5 s) with the real model and compare with the prototype page (distances 3–10 m, seams, far
road), then on 10-07 and a drive the prototype never saw.
