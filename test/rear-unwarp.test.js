// Rear camera unwarp (js/rear-unwarp.js) — panorama look-up table, box mapping back, sampling. Usage: node test/rear-unwarp.test.js
const R = require("../js/rig.js"), U = require("../js/rear-unwarp.js");
let fails = 0, n = 0; const ok = (name, c, x) => { n++; console.log((c ? "PASS " : "FAIL ") + name + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 400) : "")); if (!c) fails++; };

const t0 = Date.now(), lut = U.build(R), ms = Date.now() - t0;
ok("table builds for the measured rear camera (" + lut.W + "×" + lut.H + ", " + ms + " ms)", lut.map.length === lut.W * lut.H * 2 && ms < 3000, ms);
ok("built once: same table while the calibration is unchanged", U.build(R) === lut);

// the panorama's centre column looks straight back; its left half is the car's right (as the recorded picture)
const mid = U.dirAt(R, U.VIEW, lut.W / 2, lut.H / 2);
ok("panorama centre looks straight back, 18° down", Math.abs(mid[0]) < 1e-9 && mid[2] < -0.9 && Math.abs(Math.asin(mid[1]) * 180 / Math.PI + 18) < 0.5, mid);
const left = U.dirAt(R, U.VIEW, lut.W * 0.25, lut.H / 2);
ok("left of the panorama is the car's right side (x > 0), as in the recorded picture", left[0] > 0.5, left);
const iu = (x, y) => lut.map[2 * (y * lut.W + x)];
ok("recorded picture's left half on the panorama's left half", iu(lut.W * 0.3 | 0, lut.H / 2) < 0.5 && iu(lut.W * 0.7 | 0, lut.H / 2) > 0.5);

// how much of the panorama the lens sees
let seen = 0; for (let i = 0; i < lut.W * lut.H; i++) if (lut.map[2 * i] === lut.map[2 * i]) seen++;
ok("the lens fills most of the panorama (> 80 %)", seen / (lut.W * lut.H) > 0.8, seen / (lut.W * lut.H));

// a box round a point on the panorama maps back to a box round that point's place in the recorded picture
let worst = 0, missed = 0;
for (const [px, py] of [[0.2, 0.5], [0.5, 0.5], [0.8, 0.45], [0.1, 0.6], [0.9, 0.6], [0.5, 0.8]]) {
  const x = Math.round(px * lut.W), y = Math.round(py * lut.H), u = iu(x, y), v = lut.map[2 * (y * lut.W + x) + 1];
  if (!(u === u)) continue;
  const b = U.boxBack(lut, { x: px - 0.03, y: py - 0.06, w: 0.06, h: 0.12 });
  if (!b || u < b.x || u > b.x + b.w || v < b.y || v > b.y + b.h) missed++;
  else worst = Math.max(worst, b.w, b.h);
}
ok("boxes map back round the same place (6 places)", missed === 0, missed);
ok("mapped boxes stay compact (< 0.35 of the picture)", worst < 0.35, worst);
const blind = { W: 4, H: 4, map: new Float32Array(32).fill(NaN) };
ok("a box where the lens sees nothing maps to nothing", U.boxBack(blind, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }) === null);

// round trip: a recorded-picture point → its ray → panorama pixel → back to the same point
let rt = 0;
for (const [u, v] of [[0.5, 0.6], [0.25, 0.55], [0.75, 0.55], [0.4, 0.8]]) {
  const d = R.ray("back", u, v); if (!d) continue;
  // invert dirAt: undo the view rotation, then azimuth / height
  const M = R.rot(180, U.VIEW.pitch, 0), e = [0, 1, 2].map((j) => M[0][j] * d[0] + M[1][j] * d[1] + M[2][j] * d[2]);
  const fc = (U.VIEW.W / 2) / (U.VIEW.hfov / 2 * Math.PI / 180), phi = Math.atan2(e[0], e[2]), h = e[1] / Math.hypot(e[0], e[2]);
  const x = Math.round(phi * fc + U.VIEW.W / 2 - 0.5), y = Math.round(-h * fc + U.VIEW.H / 2 - 0.5);
  if (x < 0 || y < 0 || x >= lut.W || y >= lut.H) continue;
  rt = Math.max(rt, Math.hypot(iu(x, y) - u, lut.map[2 * (y * lut.W + x) + 1] - v));
}
ok("picture → panorama → picture lands within a pixel or two", rt < 0.003, rt);

// sampling: a picture whose red = column, green = row comes out with the table's positions
const iw = 1448, ih = 938, src = new Uint8ClampedArray(iw * ih * 4);
for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) { const o = 4 * (y * iw + x); src[o] = (x / iw) * 255; src[o + 1] = (y / ih) * 255; src[o + 2] = 0; src[o + 3] = 255; }
const t1 = Date.now(), out = U.sample(lut, src, iw, ih), sm = Date.now() - t1, t2 = Date.now(); U.sample(lut, src, iw, ih, out); const sm2 = Date.now() - t2;
let err = 0;
for (let k = 0; k < 2000; k++) { const i = (k * 7919) % (lut.W * lut.H), u = lut.map[2 * i]; if (!(u === u)) { if (out[4 * i] !== 30) err = 99; continue; } err = Math.max(err, Math.abs(out[4 * i] - u * 255), Math.abs(out[4 * i + 1] - lut.map[2 * i + 1] * 255)); }
ok("sampling puts each recorded pixel where the table says (≤ 2 levels)", err <= 2, err);
ok("sampling a frame is quick (" + sm2 + " ms after the first, " + sm + " ms with set-up)", sm2 < 60, sm2);

// HW3 (4:3) rear pictures are left alone
ok("only for pictures of the measured shape (HW4 yes, HW3 no)", U.usable(R, 1448, 938) && !U.usable(R, 1280, 960));

// boxes carry their score and kind through, and are marked
const b = U.back([{ x: 0.45, y: 0.4, w: 0.1, h: 0.2, conf: 0.9, label: "car" }], { lut });
ok("mapped detections keep score and kind and say they were unwarped", b.length === 1 && b[0].conf === 0.9 && b[0].label === "car" && b[0].unwarped === true, b);

// a changed calibration builds a new table
R.set({ cams: { back: Object.assign({}, R.get("back"), { yaw: R.get("back").yaw + 3 }) } });
ok("a new back-camera calibration builds a new table", U.build(R) !== lut);
R.reset();

console.log(`\n${n - fails}/${n} passed`); process.exit(fails ? 1 : 0);
