// patch-track (tag track-v2): unit tests for js/patch-track.js, the tracker behind Custom regions ▸ Track. Node only, no browser, no footage.
// Synthetic sequences from tools/track-bench.js (smooth-noise background, textured object); the page itself is covered by test/track-footage.js.
//   1  tracker: a still object stays put (sub-pixel), each moving / growing / shrinking / lit / noisy / small / look-alike scenario stays on target;
//      a look-alike behind a pole (object half hidden for 2 s, or fully hidden for 1 s) is not mistaken for it; matches that stay weak don't wander
//   2  versus the old single-patch matcher on the same frames: clearly better on average, never clearly worse
//   3  a flat object (no texture) is never "found" in noise; a covered object is reported lost (not dragged onto the background) and is found again
//   4  the coarse-to-fine search is sub-pixel exact; the window follows the predicted spot (a speed the old window could not reach)
//   5  setBox / rewind / fork / rebase
//   6  path: add, replace, interpolate, hold across unrecorded gaps, extrapolate briefly, "lost" keys, thinning, validation, rebase
//   7  shapes: mapShape moves / scales a freehand outline with its box, view() is the region itself when nothing changes
// Usage: node test/patch-track.js
const PT = require("../js/patch-track.js");
const B = require("../tools/track-bench.js");
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 600) : "")); if (!c) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ── 1 / 2 scenarios ─────────────────────────────────────────────────────────────────────────────────────────────
const expect = {   // minimum share of looks that are on target (IoU ≥ 0.5 with the true box, shown)
  "slow drift": 0.99, "walking pace (0.3 box / look)": 0.99, "fast pan (0.8 box / look)": 0.95, "accelerating + weaving": 0.95,
  "approaching (grows 40 %/s)": 0.95, "receding (shrinks 25 %/s)": 0.95, "look-alike next to it": 0.99, "look-alike overtakes": 0.99,
  "twin + pole (partly hidden 2 s)": 0.95, "twin + pole, sign fully hidden 1 s": 0.85, "weak throughout (noise 22, dim)": 0.95,
  "covered for 0.8 s": 0.9, "lit 0.6x → 1.4x + noise": 0.99, "small + noise": 0.97
};
let sumOld = 0, sumNew = 0, worse = [];
for (const sc of B.SCENARIOS) {
  const o = B.score(sc, B.runOld(sc)), n = B.score(sc, B.runNew(sc));
  sumOld += o.good; sumNew += n.good;
  if (n.good < o.good - 0.05) worse.push(sc.name);
  if (expect[sc.name] != null) ok("1 " + sc.name + ": " + Math.round(n.good * 100) + "% on target (old " + Math.round(o.good * 100) + "%), median error " + n.medErr.toFixed(1) + " px", n.good >= expect[sc.name], { n, o });
}
{
  const sc = B.SCENARIOS.find((s) => s.name.startsWith("approaching")), run = B.runNew(sc), T = sc.box(run[run.length - 1].t), L = run[run.length - 1].box;
  ok("1 approaching: the box grows with the object (end width " + (L.w / T.w * 100).toFixed(0) + "% of the true width)", near(L.w / T.w, 1, 0.08), { L, T });
  const sc2 = B.SCENARIOS.find((s) => s.name.startsWith("receding")), r2 = B.runNew(sc2), T2 = sc2.box(r2[r2.length - 1].t), L2 = r2[r2.length - 1].box;
  ok("1 receding: the box shrinks with the object (end width " + (L2.w / T2.w * 100).toFixed(0) + "% of the true width)", near(L2.w / T2.w, 1, 0.08), { L2, T2 });
}
ok("2 mean on target: new " + Math.round(sumNew / B.SCENARIOS.length * 100) + "% vs old " + Math.round(sumOld / B.SCENARIOS.length * 100) + "%", sumNew / B.SCENARIOS.length > sumOld / B.SCENARIOS.length + 0.15);
ok("2 never clearly worse than the old matcher on any scenario", worse.length === 0, worse);

// ── 3 flat / covered ────────────────────────────────────────────────────────────────────────────────────────────
{
  // flat object: a mid-grey rectangle on the noisy background; its template has no texture, so a patch match must not claim anything
  const sc = { name: "flat", dur: 2, box: (t) => ({ x: 0.3 + 0.02 * t, y: 0.4, w: 0.08, h: 0.06 }), seed: 5 };
  const lum = B.render;   // use the world, but override the object texture by a constant through a tiny wrapper scenario
  const flat = Object.assign({}, sc, { flat: true });
  const orig = B.render;
  void orig; void lum;
  const b0 = sc.box(0), grey = (plan) => { const SW = plan.SW, SH = plan.SH, g = new Float32Array(SW * SH); for (let j = 0; j < SH; j++) for (let i = 0; i < SW; i++) { const u = plan.nx + (i + 0.5) / SW * plan.nw, v = plan.ny + (j + 0.5) / SH * plan.nh, b = sc.box(0.0); g[j * SW + i] = u >= b.x && u < b.x + b.w && v >= b.y && v < b.y + b.h ? 128 : 60 + 120 * ((Math.sin(u * 90) + Math.sin(v * 70) + 2) / 4); } return { g, W: SW, H: SH, ox: plan.nx, oy: plan.ny, ow: plan.nw, oh: plan.nh }; };
  const tr = PT.create(grey(PT.createPlan(b0, { fw: B.FW, fh: B.FH })), b0, 0, { fw: B.FW, fh: B.FH });
  let claimed = 0; for (let t = 0.1; t <= 1.5; t += 0.1) { const r = tr.update(grey(tr.plan(t)), t); if (r.ok) claimed++; }
  ok("3 a flat (textureless) object is never claimed from noise", tr.tm0.flat && claimed === 0, { flat: tr.tm0.flat, std: tr.tm0.std, claimed }); void flat;
}
{
  const sc = { name: "gone", dur: 7, box: (t) => ({ x: 0.20 + 0.05 * t, y: 0.40, w: 0.08, h: 0.06 }), occl: [2.0, 3.5] };
  const b0 = sc.box(0), tr = PT.create(B.render(sc, 0, PT.createPlan(b0, { fw: B.FW, fh: B.FH })), b0, 0, { fw: B.FW, fh: B.FH });
  let lostAt = null, back = null, drag = 0, shownWhileCovered = 0;
  for (let t = 0.1; t <= 7; t += 0.1) {
    const r = tr.update(B.render(sc, t, tr.plan(t)), t), T = sc.box(t), err = Math.hypot((r.box.x + r.box.w / 2 - T.x - T.w / 2) * B.FW, (r.box.y + r.box.h / 2 - T.y - T.h / 2) * B.FH);
    if (t > 2.05 && t < 3.45) { if (r.lostT >= 1.2 && lostAt == null) lostAt = t; if (r.ok) drag++; if (r.ok || r.lostT < 1.2) shownWhileCovered++; }
    if (t > 3.5 && r.ok && err < 8 && back == null) back = t;
  }
  ok("3 covered for 1.5 s: reported lost after ~1.2 s, never 'found' under the cover (" + drag + " false finds)", lostAt != null && lostAt < 3.6 && drag === 0, { lostAt, drag });
  ok("3 …and found again " + (back != null ? (back - 3.5).toFixed(1) : "never") + " s after it comes back", back != null && back - 3.5 <= 1.0, { back });
}

// ── 4 precision / prediction ────────────────────────────────────────────────────────────────────────────────────
{
  // a still object, 40 looks: error must be tiny and not wander
  const sc = { name: "still", dur: 4, box: () => ({ x: 0.43, y: 0.37, w: 0.07, h: 0.05 }), noise: 6 };
  const run = B.runNew(sc), T = sc.box(0), errs = run.map((r) => Math.hypot((r.box.x + r.box.w / 2 - T.x - T.w / 2) * B.FW, (r.box.y + r.box.h / 2 - T.y - T.h / 2) * B.FH));
  ok("4 a still object: max error " + Math.max.apply(null, errs).toFixed(2) + " px over " + run.length + " looks", Math.max.apply(null, errs) < 2.5, errs.slice(0, 10));
  // sub-pixel: shifts smaller than a template pixel are measured within 0.45 px (the limit is bilinear resampling, not the peak fit)
  const pitch = 0.08 / 44; let worst = 0, line = [];
  for (const shift of [0, 0.1, 0.37, 0.5, 0.75, 1, 1.5, -0.6]) {
    const b0 = { x: 0.30, y: 0.40, w: 0.08, h: 0.06 }, sc2 = { name: "half", dur: 1, box: (t) => ({ x: 0.30 + (t > 0 ? shift * pitch : 0), y: 0.40, w: 0.08, h: 0.06 }) };
    const tr = PT.create(B.render(sc2, 0, PT.createPlan(b0, { fw: B.FW, fh: B.FH })), b0, 0, { fw: B.FW, fh: B.FH }), r = tr.update(B.render(sc2, 0.1, tr.plan(0.1)), 0.1);
    const k = r.score >= 0.8 ? 0.9 : r.score >= 0.65 ? 0.7 : 0.5, got = (r.box.x - b0.x) / pitch / k;   // the box moves a share k of the way
    worst = Math.max(worst, Math.abs(got - shift)); line.push(shift + "→" + got.toFixed(2));
  }
  ok("4 sub-pixel: shifts of a fraction of a template pixel are measured within 0.45 px (worst " + worst.toFixed(2) + ")", worst < 0.45, line);
  // prediction: constant speed of 0.9 box per look found once the speed is known (the old window reaches 0.55)
  const scF = { name: "fastp", dur: 1.1, box: (t) => ({ x: 0.08 + 0.72 * t, y: 0.40, w: 0.08, h: 0.06 }) };
  const rn = B.runNew(scF), sN = B.score(scF, rn), sO = B.score(scF, B.runOld(scF));
  ok("4 0.9 box / look: new " + Math.round(sN.good * 100) + "% on target, old " + Math.round(sO.good * 100) + "%", sN.good >= 0.9 && sO.good < 0.2, { sN, sO });
}

// ── 5 setBox / rewind / fork / rebase ──────────────────────────────────────────────────────────────────────────
{
  const sc = { name: "s", dur: 3, box: (t) => ({ x: 0.2 + 0.05 * t, y: 0.4, w: 0.08, h: 0.06 }) };
  const b0 = sc.box(0), tr = PT.create(B.render(sc, 0, PT.createPlan(b0, { fw: B.FW, fh: B.FH })), b0, 0, { fw: B.FW, fh: B.FH });
  for (let t = 0.1; t <= 1; t += 0.1) tr.update(B.render(sc, t, tr.plan(t)), t);
  ok("5 the speed is learned (" + (tr.vx).toFixed(3) + " / s, true 0.050)", near(tr.vx, 0.05, 0.012), tr.vx);
  const f = tr.fork(); f.rewind({ x: 0.9, y: 0.1, w: 0.08, h: 0.06 }, 5);
  ok("5 fork is independent of the tracker it came from", near(tr.box.x, sc.box(1).x, 0.01) && f.box.x === 0.9 && f.tm0 === tr.tm0 && f.tm !== tr.tm, { a: tr.box, b: f.box });
  tr.setBox({ x: 0.5, y: 0.4, w: 0.08, h: 0.06 }, 1.1); const v1 = tr.vx;
  tr.setBox({ x: 0.51, y: 0.4, w: 0.08, h: 0.06 }, 1.2);
  ok("5 setBox follows an outside box and learns its speed", tr.box.x === 0.51 && tr.vx > v1 * 0.4 && tr.lost === 0, { vx: tr.vx });
  tr.rewind({ x: 0.3, y: 0.3, w: 0.08, h: 0.06 }, 0.2);
  ok("5 rewind forgets the speed and widens the first look", tr.vx === 0 && tr.n === 0 && tr.margin(0.1) > PT.DEFAULTS.margin + 0.4);
  const w0 = tr.size0.w; tr.rebase({ x: 0.3, y: 0.3, w: 0.16, h: 0.12 }, 0.3);
  ok("5 rebase after a resize keeps the size limits in proportion", near(tr.size0.w, w0 * 2, 1e-6) && tr.box.w === 0.16);
}

// ── 6 path ─────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const p = [];
  PT.pathAdd(p, 1, { x: 0.1, y: 0.2, w: 0.1, h: 0.1 }); PT.pathAdd(p, 1.5, { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }); PT.pathAdd(p, 0.5, { x: 0.0, y: 0.2, w: 0.1, h: 0.1 });
  ok("6 keys stay sorted by time", p[0] === 0.5 && p[5] === 1 && p[10] === 1.5 && p.length === 15, p);
  PT.pathAdd(p, 1.02, { x: 0.15, y: 0.2, w: 0.1, h: 0.1 });
  ok("6 a key within 45 ms replaces the old one", p.length === 15 && p[6] === 0.15, p);
  const a = PT.pathAt(p, 1.25);
  ok("6 between two close keys: linear (x " + a.x.toFixed(3) + ")", near(a.x, 0.15 + 0.05 * (1.25 - 1.02) / (1.5 - 1.02), 1e-4), a);
  ok("6 before the first key: the first box; no path: undefined", PT.pathAt(p, 0).x === 0 && PT.pathAt([], 3) === undefined && PT.pathAt(null, 3) === undefined);
  const e = PT.pathAt(p, 1.62), h = PT.pathAt(p, 3);
  ok("6 just after the last key it carries on at the last speed (x " + e.x.toFixed(3) + "), later it holds (x " + h.x + ")", near(e.x, 0.2 + (0.2 - 0.15) / 0.48 * 0.12, 0.004) && h.x === 0.2, { e, h });
  const q = []; PT.pathAdd(q, 0, { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }); PT.pathAdd(q, 10, { x: 0.8, y: 0.1, w: 0.1, h: 0.1 });
  ok("6 an unrecorded stretch (10 s) is not interpolated: the nearer end holds", PT.pathAt(q, 3).x === 0.1 && PT.pathAt(q, 7).x === 0.8);
  PT.pathAdd(q, 12, null); PT.pathAdd(q, 14, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 });
  ok("6 a 'lost' key hides the region until the next good key", PT.pathAt(q, 11.9).x === 0.8 && PT.pathAt(q, 12.5) === null && PT.pathAt(q, 13.9) === null && PT.pathAt(q, 14.1).x === 0.5, q);
  ok("6 pathGap is the distance to the nearest key", near(PT.pathGap(q, 11), 1, 1e-9) && PT.pathGap([], 1) === Infinity);
  const big = []; for (let i = 0; i < 900; i++) PT.pathAdd(big, i * 0.1, { x: 0.001 * i % 0.8, y: 0.2, w: 0.05, h: 0.05 });
  ok("6 thinning keeps at most " + PT.MAXKEYS + " keys and both ends (" + big.length / 5 + ")", big.length / 5 <= PT.MAXKEYS && big[0] === 0 && near(big[big.length - 5], 89.9, 1e-6));
  ok("6 cleanPath accepts a good path and rejects broken ones", PT.cleanPath(p) && PT.cleanPath([1, 0.1, 0.1, 0.1, 0.1, 0.5, 0.1, 0.1, 0.1, 0.1]) === null && PT.cleanPath([1, 0.1, 0.1]) === null && PT.cleanPath([1, NaN, 0, 0.1, 0.1]) === null && PT.cleanPath("x") === null);
  const c = PT.cleanPath([0, -0.5, 0.95, 0.2, 0.2]); ok("6 cleanPath keeps boxes inside the frame", c && c[1] === 0 && near(c[2] + c[4], 1, 1e-9), c);
  const r = [0, 0.1, 0.1, 0.1, 0.1, 1, 0.3, 0.1, 0.1, 0.1]; PT.pathRebase(r, { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, { x: 0.15, y: 0.12, w: 0.2, h: 0.1 });
  ok("6 rebase: the key at the edit time becomes the new box, the others keep their offset from it and their size ratio", near(r[1], 0.15, 1e-4) && near(r[6], 0.35, 1e-4) && near(r[3], 0.2, 1e-9) && near(r[8], 0.2, 1e-9) && near(r[2] + r[4] / 2, 0.17, 1e-4), r);
}

{
  const p = []; for (let i = 0; i <= 10; i++) PT.pathAdd(p, i * 0.1, { x: 0.2 + 0.05 * i * 0.1 - 0.05, y: 0.4, w: 0.1, h: 0.1 });   // centre moves 0.05 / s
  const v = PT.pathVelocity(p, 1.0);
  ok("6 pathVelocity reads the speed from the last seen keys (" + (v && v.vx.toFixed(3)) + " / s)", v && near(v.vx, 0.05, 0.003) && near(v.vy, 0, 1e-6), v);
  ok("6 pathVelocity needs two keys 0.25 s apart; none for an empty / one-key path", PT.pathVelocity([], 1) === null && PT.pathVelocity([0, 0.1, 0.1, 0.1, 0.1], 1) === null);
  const tr = PT.create({ g: new Float32Array(100 * 100).map((_, i) => (i * 7919) % 255), W: 100, H: 100, ox: 0, oy: 0, ow: 1, oh: 1 }, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, 0, { fw: 100, fh: 100 });
  tr.rewind({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, 5, v);
  ok("6 rewind with a known speed keeps it and skips the wide first look", near(tr.vx, 0.05, 0.003) && tr.n === 3 && tr.margin(0.1) < PT.DEFAULTS.margin + 0.3, { vx: tr.vx, n: tr.n });
}

// ── 7 shapes ───────────────────────────────────────────────────────────────────────────────────────────────────
{
  const poly = { shape: "poly", pts: [0.2, 0.2, 0.4, 0.2, 0.3, 0.4], x: 0.2, y: 0.2, w: 0.2, h: 0.2, path: [0, 0.2, 0.2, 0.2, 0.2, 1, 0.5, 0.5, 0.4, 0.4] };
  const v = PT.view(poly, 1);
  ok("7 a freehand outline moves and scales with its box", v !== poly && near(v.x, 0.5, 1e-9) && near(v.w, 0.4, 1e-9) && near(v.pts[0], 0.5, 1e-9) && near(v.pts[2], 0.9, 1e-9) && near(v.pts[5], 0.9, 1e-9) && poly.pts[0] === 0.2, v);
  ok("7 the view reads through to the region (mode, id)", Object.create(poly).shape === "poly" && PT.view(Object.assign({ mode: "blur", id: "r1" }, poly), 1).id === "r1");
  ok("7 view is the region itself where nothing changed and without a path", PT.view(poly, 0) === poly && PT.view({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, 5).x === 0.1);
  ok("7 view is null where the object is lost", PT.view(Object.assign({}, poly, { path: [0, 0.2, 0.2, 0.2, 0.2, 1, 0, 0, 0, 0] }), 1.5) === null);
  const r = { x: 0.2, y: 0.2, w: 0.2, h: 0.2 }, same = PT.mapShape(r, { x: 0.6, y: 0.5, w: 0.1, h: 0.1 });
  ok("7 mapShape in place", same === r && r.x === 0.6 && r.h === 0.1);
}

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
