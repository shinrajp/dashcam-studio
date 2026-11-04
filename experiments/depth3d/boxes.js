// Detector boxes (raw fisheye, js/rig.js lens) → rectangles in each rectified depth frame (same camera axes, pinhole f/cx/cy).
// usage: node boxes.js <frames.json of the depth run> <data frames.json (t_clip)> <dets.json> <out.json>
const fs = require("fs"), [FR, DF, DETS, OUT] = process.argv.slice(2);
const R = require(require("path").join(__dirname, "../../js/rig.js"));
const fr = JSON.parse(fs.readFileSync(FR)).frames, tclip = {}, dets = JSON.parse(fs.readFileSync(DETS));
for (const f of JSON.parse(fs.readFileSync(DF)).frames) tclip[f.name] = f.t_clip;
const c0 = R.MEASURED, ASP = R.ASPECT, kb = (th, k) => { const t2 = th * th; return th * (1 + t2 * (k[0] + t2 * (k[1] + t2 * k[2]))); };
function toRect(cam, u, v, f) {   // raw (0..1) → rectified pixel
  const c = c0[cam], dx = (u - 0.5 - c.cx) / c.f, dy = ((v - 0.5) * ASP - c.cy) / c.f, rho = Math.hypot(dx, dy);
  let th = rho; for (let i = 0; i < 10; i++) th -= (kb(th, c.k) - rho) / 1;   // fixed point is fine for small k
  if (th > 1.45) return null; const s = rho > 1e-9 ? Math.tan(th) / rho : 1;
  return [f.cx + f.f * dx * s, f.cy + f.f * dy * s];
}
const out = {};
for (const f of fr) {
  const t = tclip[f.name], rects = [];
  for (const tr of dets[f.cam] || []) {
    if (!/car|truck|bus|motorcycle|bicycle|person/.test(tr.cls)) continue;
    let best = null, bd = 0.08; for (const [kt, b] of tr.keys) { const d = Math.abs(kt - t); if (d < bd) { bd = d; best = b; } }
    if (!best) continue;
    const pts = []; for (let i = 0; i <= 8; i++) for (const [a, b] of [[i / 8, 0], [i / 8, 1], [0, i / 8], [1, i / 8]]) { const p = toRect(f.cam, best.x + best.w * a, best.y + best.h * b, f); if (p) pts.push(p); }
    if (pts.length < 4) continue;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round));
  }
  out[f.name] = rects;
}
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(Object.keys(out).length, "frames,", Object.values(out).reduce((s, r) => s + r.length, 0), "boxes");
