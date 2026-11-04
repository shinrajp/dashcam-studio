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

## Next (open)

Make it one tool that works from any drive folder: clocks and delays from each clip's own telemetry (js/rig.js
clockOffsets / tools/rig), no splat-experiment tracks needed, detections run in the tool, one command to a page.
