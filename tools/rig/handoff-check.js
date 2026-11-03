#!/usr/bin/env node
/* handoff-check.js — how well js/rig.js predicts where and when real objects come into the next camera.
 * Input: tools/rig/detect-tracks.py's JSON (tracks per camera, own clip times). For every track that leaves its picture through a
 * side edge, predictEntry() gives when and where it comes into the neighbour (js/handoff.js entryFor); the neighbour's track of the
 * same kind that starts nearest that time and place is taken as the truth. Run with and without the files' clock offsets.
 *   node tools/rig/handoff-check.js dets.json [--clocks back=0.348,…]   (default: js/rig.js CLOCK0) */
"use strict";
const R = require("../../js/rig.js"), H = require("../../js/handoff.js"), fs = require("fs");
const dets = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let clocks = R.CLOCK0; const ci = process.argv.indexOf("--clocks");
if (ci > 0) { clocks = { front: 0 }; for (const kv of process.argv[ci + 1].split(",")) { const [k, v] = kv.split("="); clocks[k] = +v; } }
const kind = (c) => (c === "person" ? "person" : c === "bicycle" || c === "motorcycle" ? "bike" : "vehicle");
const mid = (b) => [b.x + b.w / 2, b.y + b.h / 2];

function run(useClocks) {
  const rows = [];
  for (const cam of R.CAMS) for (const tr of dets[cam] || []) {
    const k = tr.keys; if (k.length < 6) continue;
    const L = k[k.length - 1][1], P = k[Math.max(0, k.length - 6)][1];
    const side = L.x < 0.03 && mid(L)[0] < mid(P)[0] ? "left" : L.x + L.w > 0.97 && mid(L)[0] > mid(P)[0] ? "right" : null;
    if (!side) continue;
    const e = H.entryFor(cam, side); if (!e) continue;
    const p = R.predictEntry(cam, k, e.to); if (!p) { rows.push({ cam, to: e.to, cls: tr.cls, pred: null }); continue; }
    const shift = useClocks ? R.clock(cam, clocks) - R.clock(e.to, clocks) : 0, tp = p.t + shift;
    // the truth: a track of the same kind in the neighbour, visible near the predicted moment, nearest the predicted box
    let best = null;
    for (const u of dets[e.to] || []) {
      if (kind(u.cls) !== kind(tr.cls)) continue;
      const t0 = u.keys[0][0], t1 = u.keys[u.keys.length - 1][0]; if (t1 < tp - 2 || t0 > tp + 2) continue;
      let kk = u.keys[0]; for (const q of u.keys) if (Math.abs(q[0] - tp) < Math.abs(kk[0] - tp)) kk = q;
      const dc = Math.hypot(mid(kk[1])[0] - mid(p.box)[0], mid(kk[1])[1] - mid(p.box)[1]);
      const enter = Math.max(t0, k[k.length - 1][0] + shift - 3);   // (when it came into view of the neighbour, as far as its track shows)
      const sc = dc / 0.25 + Math.abs(t0 - tp) / 1.5;
      if (dc < 0.35 && (!best || sc < best.sc)) best = { sc, dc, dt: t0 - tp, t0, overlap: t0 < k[k.length - 1][0] + shift - 0.1 };
    }
    rows.push({ cam, to: e.to, cls: tr.cls, pred: +tp.toFixed(2), dist: +p.dist.toFixed(1), hit: best && { dt: +best.dt.toFixed(2), dc: +best.dc.toFixed(3), overlap: best.overlap } });
  }
  return rows;
}
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
for (const use of [true, false]) {
  const rows = run(use), pr = rows.filter((r) => r.pred != null), hit = pr.filter((r) => r.hit), seq = hit.filter((r) => !r.hit.overlap);
  console.log(`\n${use ? "WITH" : "WITHOUT"} clock offsets: ${rows.length} exits, ${pr.length} predicted, ${hit.length} matched (${seq.length} came in after leaving)`);
  console.log(`  time error (entering after leaving): median |dt| ${med(seq.map((r) => Math.abs(r.hit.dt))).toFixed(2)} s, median dt ${med(seq.map((r) => r.hit.dt)).toFixed(2)} s`);
  console.log(`  place error: median ${med(hit.map((r) => r.hit.dc)).toFixed(3)} of the picture width`);
  const by = {}; for (const r of seq) { const k = r.cam + "→" + r.to; (by[k] = by[k] || []).push(r.hit.dt); }
  for (const [k, v] of Object.entries(by)) console.log(`   ${k.padEnd(30)} n=${v.length}  median dt ${med(v).toFixed(2)} s`);
  if (process.argv.includes("-v")) for (const r of rows) console.log("   ", JSON.stringify(r));
}
