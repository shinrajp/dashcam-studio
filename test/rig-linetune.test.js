// LINE_TUNE (js/rig.js): per-car calibration of the repeaters, off by default, switchable, never written into MEASURED_RAW.
let fails = 0, n = 0; const ok = (name, c, x) => { n++; console.log((c ? "PASS " : "FAIL ") + name + (c ? "" : "  " + JSON.stringify(x))); if (!c) fails++; };
const R = require("../js/rig.js");
const snap = () => JSON.stringify(R.CAMS.map((c) => R.get(c)));
ok("off by default", R.lineTune() === false);
const off = snap(), raw = JSON.stringify(R.MEASURED_RAW);
ok("bounded ±3° / ±0.2 m", Object.values(R.LINE_TUNE).every((t) => ["yaw", "pitch", "roll"].every((k) => Math.abs(t[k]) <= 3) && Math.abs(t.dx) <= 0.2));
R.lineTune(true);
for (const cam of R.CAMS) {
  const t = R.LINE_TUNE[cam], g = R.get(cam), b = JSON.parse(off)[R.CAMS.indexOf(cam)];
  if (!t) { ok(`on: ${cam} unchanged`, JSON.stringify(g) === JSON.stringify(b)); continue; }
  for (const k of ["yaw", "pitch", "roll"]) ok(`on: ${cam}.${k} += ${t[k]}`, Math.abs(g[k] - b[k] - t[k]) < 1e-6, [g[k], b[k]]);
  ok(`on: ${cam} moved outward by ${t.dx} m`, Math.abs(Math.abs(g.pos[0]) - Math.abs(b.pos[0]) - t.dx) < 1e-6, [g.pos, b.pos]);
}
ok("MEASURED_RAW untouched", JSON.stringify(R.MEASURED_RAW) === raw);
ok("road tune still on", R.roadTune() === true);
R.roadTune(false); R.roadTune(true); ok("road tune toggle keeps line tune", R.lineTune() === true && snap() !== off);
R.lineTune(false); ok("off again = original rig", snap() === off);
console.log(fails ? `${fails} of ${n} FAILED` : `ALL PASS (${n})`); process.exit(fails ? 1 : 0);
