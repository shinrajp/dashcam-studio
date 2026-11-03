# camfit: fit the camera layout on real footage (ho-3d)

The hand-off places vehicles on the road round the car (`js/custom-redact.js`, `groundOf`) from each camera's direction, tilt, field of
view and mounting position. These scripts check and fit those numbers on a real minute of footage:

1. `python3 detect.py <folder>/<event>-` — YOLO11 nano (models/yolo11n.onnx) on all six cameras at 6 fps → `dets.json`.
2. `VCONV=phys python3 fit2.py` — vehicles seen by two neighbouring cameras at the same moment must land on the same place (direction from
   the car's centre and distance, scale-free), and a car's apparent height (≈ 1.55 m) must agree with where it meets the road. Fits yaw,
   pitch and field of view per camera (front yaw fixed at 0, mounting positions fixed) → `fitted.json`, with before / after numbers.
3. `VCONV=phys python3 plot.py 11,20,33,47` — bird's-eye picture of the vehicles at those seconds, defaults vs fitted → `birdseye.png`.

`geo.py` is the camera model of `js/pano.js` (world x right, y up, z forward; pinhole "rect" or equidistant fisheye "kb"), with one
difference: `VCONV=phys` (default) measures vertical offsets with square pixels (× h/w). pano.js multiplies by h/w where it should divide,
which squeezes vertical angles (by about (w/h)², ~2.4× on 1448 × 938): `VCONV=pano` reproduces it.

Result on 2026-10-19 10:53:18 (HW4): the same vehicles seen by two cameras agreed to 8.1 m / 12.9° / 94 % in distance with the defaults,
2.4 m / 3.7° / 21 % with the fitted (symmetric) layout now in `GEO_HW4`.
