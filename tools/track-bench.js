#!/usr/bin/env node
/* track-bench.js — synthetic sequences for the region tracker, and the OLD matcher (custom-redact.js at c860247: one 32 × 32 patch, fixed scale,
 * 0.55-box window around the last spot, no motion model) next to the NEW one (js/patch-track.js), on identical frames.
 * Synthetic only: a smooth-noise background, a textured object that moves / grows / is covered / is lit differently, optional look-alike and noise.
 * It measures the tracker's LOGIC. How well it does on real dashcam footage is measured in the browser (test/track-footage.js).
 *
 * Usage: node tools/track-bench.js [--json]            prints a table (old vs new per scenario).
 * As a module: { SCENARIOS, runNew, runOld, score } for test/patch-track.js. */
"use strict";
const PT = require("../js/patch-track.js");

const FW = 1280, FH = 960, HZ = 10;

// ── the world ───────────────────────────────────────────────────────────────────────────────────────────────────
function hash2(ix, iy, seed) { let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967295; }
function vnoise(x, y, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed), c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed), sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function fbm(x, y, seed, oct) { let s = 0, a = 0.5, f = 1, n = 0; for (let o = 0; o < oct; o++) { s += a * vnoise(x * f, y * f, seed + o * 7); n += a; a *= 0.5; f *= 2; } return s / n; }
const bg = (u, v) => 40 + 170 * fbm(u * 12, v * 9, 11, 4);
const objTex = (lu, lv, seed) => {
  const edge = Math.min(lu, 1 - lu, lv, 1 - lv);
  return 30 + 200 * fbm(lu * 5, lv * 4, seed, 3) - (edge < 0.07 ? 60 : 0);
};

/** scenario: { name, dur, box(t) → {x,y,w,h}, dist?: [{box(t), seed}], occl?: [t0, t1], gain?(t), noise?, seed? } */
function lumAt(sc, u, v, t, frame) {
  const B = sc.box(t);
  let val = bg(u + (sc.pan || 0) * t, v);
  for (const d of sc.dist || []) { const b = d.box(t); if (u >= b.x && u < b.x + b.w && v >= b.y && v < b.y + b.h) val = objTex((u - b.x) / b.w, (v - b.y) / b.h, d.seed || sc.seed || 5); }
  if (u >= B.x && u < B.x + B.w && v >= B.y && v < B.y + B.h) {
    let lu = (u - B.x) / B.w, lv = (v - B.y) / B.h;
    if (sc.rot) { const a = sc.rot(t), c = Math.cos(a), s = Math.sin(a), du = (lu - 0.5) * B.w, dv = (lv - 0.5) * B.h; lu = 0.5 + (c * du + s * dv) / B.w; lv = 0.5 + (-s * du + c * dv) / B.h; }   // the object turns (its texture rotates inside its box)
    let o = objTex(lu, lv, sc.seed || 5);
    if (sc.morph) { const m = sc.morph(t); if (m > 0) o = o * (1 - m) + objTex(lu, lv, (sc.seed || 5) + 17) * m; }   // seen from another side: the look changes
    val = sc.contrast ? 110 + (o - 110) * sc.contrast : o;
  }
  if (sc.pole && u >= sc.pole[0] && u < sc.pole[1]) val = 90;
  if (sc.occl && t >= sc.occl[0] && t <= sc.occl[1]) { const c = sc.box(0.5 * (sc.occl[0] + sc.occl[1])), pad = 0.01; if (u >= c.x - pad - 0.02 && u < c.x + c.w + pad + 0.02 && v >= c.y - pad && v < c.y + c.h + pad) val = 90; }
  if (sc.gain) val = val * sc.gain(t);
  if (sc.noise) val += sc.noise * (hash2((u * 4093) | 0, (v * 4093) | 0, frame) - 0.5) * 3.46;
  return val < 0 ? 0 : val > 255 ? 255 : val;
}
/** Render the part `plan` of the frame at time t as a raster. */
function render(sc, t, plan) {
  const SW = plan.SW, SH = plan.SH, g = new Float32Array(SW * SH), fr = Math.round(t * 1000);
  for (let j = 0; j < SH; j++) for (let i = 0; i < SW; i++) g[j * SW + i] = lumAt(sc, plan.nx + (i + 0.5) / SW * plan.nw, plan.ny + (j + 0.5) / SH * plan.nh, t, fr);
  return { g, W: SW, H: SH, ox: plan.nx, oy: plan.ny, ow: plan.nw, oh: plan.nh };
}

// ── scenarios ───────────────────────────────────────────────────────────────────────────────────────────────────
/** the box a user draws: the object grown by `pad` of its size on every side (a loose outline holds background) */
const padBox = (b, p) => p ? { x: b.x - b.w * p, y: b.y - b.h * p, w: b.w * (1 + 2 * p), h: b.h * (1 + 2 * p) } : b;
const lin = (x0, y0, vx, vy, w, h) => (t) => ({ x: x0 + vx * t, y: y0 + vy * t, w, h });
// One look = 0.1 s. "0.3 box / look" means the object moves 0.3 of its own width between two looks.
const SCENARIOS = [
  { name: "slow drift", dur: 6, box: lin(0.30, 0.40, 0.020, 0.004, 0.08, 0.06) },
  { name: "walking pace (0.3 box / look)", dur: 2.9, box: lin(0.20, 0.40, 0.24, 0.01, 0.08, 0.06) },
  { name: "fast pan (0.8 box / look)", dur: 1.3, box: lin(0.10, 0.40, 0.64, 0.0, 0.08, 0.06) },
  { name: "very fast (1.6 box / look)", dur: 0.65, box: lin(0.08, 0.40, 1.28, 0.0, 0.08, 0.06) },
  { name: "accelerating + weaving", dur: 4, box: (t) => ({ x: 0.10 + 0.05 * t * t, y: 0.40 + 0.03 * Math.sin(t * 2), w: 0.08, h: 0.06 }) },
  { name: "approaching (grows 40 %/s)", dur: 5, box: (t) => { const s = Math.exp(0.34 * t); const w = 0.05 * s, h = 0.04 * s; return { x: 0.30 + 0.02 * t - (w - 0.05) / 2, y: 0.40 - (h - 0.04) / 2, w, h }; } },
  { name: "receding (shrinks 25 %/s)", dur: 5, box: (t) => { const s = Math.exp(-0.25 * t); const w = 0.14 * s, h = 0.11 * s; return { x: 0.40 - (w - 0.14) / 2 + 0.02 * t, y: 0.40 - (h - 0.11) / 2, w, h }; } },
  { name: "look-alike next to it", dur: 5, box: lin(0.30, 0.40, 0.03, 0.0, 0.08, 0.06), dist: [{ box: lin(0.30 + 0.095, 0.40, 0.03, 0.0, 0.08, 0.06), seed: 5 }] },
  { name: "look-alike overtakes", dur: 6, box: lin(0.20, 0.40, 0.03, 0.0, 0.08, 0.06), dist: [{ box: lin(0.05, 0.40, 0.09, 0.0, 0.08, 0.06), seed: 5 }] },
  { name: "twin + pole (partly hidden 2 s)", dur: 5, box: lin(0.10, 0.40, 0.07, 0.0, 0.14, 0.10), dist: [{ box: lin(0.10 - 0.22, 0.40, 0.07, 0.0, 0.14, 0.10), seed: 5 }], pole: [0.30, 0.345] },
  { name: "twin + pole, sign fully hidden 1 s", dur: 5, box: lin(0.10, 0.40, 0.07, 0.0, 0.14, 0.10), dist: [{ box: lin(0.10 - 0.22, 0.40, 0.07, 0.0, 0.14, 0.10), seed: 5 }], pole: [0.34, 0.50] },
  { name: "covered for 0.8 s", dur: 6, box: lin(0.20, 0.40, 0.05, 0.005, 0.08, 0.06), occl: [2.4, 3.2] },
  { name: "lit 0.6x → 1.4x + noise", dur: 6, box: lin(0.25, 0.40, 0.04, 0.0, 0.08, 0.06), gain: (t) => 0.6 + 0.8 * t / 6, noise: 14 },
  { name: "weak throughout (noise 22, dim)", dur: 6, box: (t) => ({ x: 0.15 + 0.05 * t + 0.01 * t * t, y: 0.40 + 0.02 * Math.sin(1.5 * t), w: 0.09, h: 0.07 }), gain: () => 0.7, noise: 22 },
  { name: "loose outline (+60 %), small car", dur: 5, pad: 0.6, box: lin(0.30, 0.45, 0.07, 0.0, 0.035, 0.026), noise: 6 },
  { name: "loose + panning scene", dur: 5, pad: 0.6, pan: 0.05, box: lin(0.30, 0.45, 0.10, 0.0, 0.04, 0.03), noise: 6 },
  { name: "loose + low contrast + pan", dur: 5, pad: 0.5, pan: 0.05, contrast: 0.4, box: lin(0.30, 0.45, 0.10, 0.0, 0.05, 0.035), noise: 6 },
  { name: "turning (rotates 90 deg in 3 s)", dur: 4, box: lin(0.25, 0.40, 0.05, 0.0, 0.09, 0.09), rot: (t) => Math.min(t, 3) * Math.PI / 6, noise: 6 },
  { name: "other side shows (look changes in 2 s)", dur: 5, box: lin(0.25, 0.40, 0.06, 0.005, 0.09, 0.07), morph: (t) => Math.max(0, Math.min(1, (t - 1) / 2)), noise: 6 },
  { name: "turning + look changes + pan", dur: 5, pan: 0.04, box: (t) => ({ x: 0.25 + 0.05 * t, y: 0.40 + 0.02 * Math.sin(t), w: 0.08 * (1 + 0.08 * t), h: 0.07 * (1 + 0.08 * t) }), rot: (t) => 0.35 * t, morph: (t) => Math.max(0, Math.min(1, (t - 1.5) / 2.5)), noise: 8 },
  { name: "drives out of the picture (blur must go)", dur: 4, box: lin(0.60, 0.40, 0.25, 0.0, 0.08, 0.06), noise: 6 },
  { name: "drives out, comes back 1.5 s later", dur: 6, box: (t) => ({ x: t < 3 ? 0.6 + 0.25 * t : 1.35 - 0.25 * (t - 3), y: 0.40, w: 0.08, h: 0.06 }), noise: 6 },
  { name: "hidden 3 s in the picture, then seen again", dur: 7, box: lin(0.30, 0.40, 0.03, 0.0, 0.08, 0.06), occl: [1.5, 4.5], noise: 6 },
  { name: "small + noise", dur: 6, box: lin(0.25, 0.40, 0.03, 0.002, 0.035, 0.026), noise: 10 }
];

// ── the NEW tracker, driven like the page drives it ─────────────────────────────────────────────────────────────
function runNew(sc, o) {
  const out = [], b0 = padBox(sc.box(0), sc.pad);
  const cp = PT.createPlan(b0, { fw: FW, fh: FH });
  const tr = PT.create(render(sc, 0, cp), b0, 0, Object.assign({ fw: FW, fh: FH }, o));
  let hidden = false, lastSearch = -9;   // like the page: a lost object's blur goes when it leaves the picture (or after coastT), then it is looked for every 0.3 s
  for (let t = 1 / HZ; t <= sc.dur + 1e-9; t += 1 / HZ) {
    if (hidden) {
      if (t - lastSearch >= 0.3 - 1e-9) {
        lastSearch = t;
        const r = tr.reacquire(render(sc, t, tr.searchPlan()), t);
        if (r) { hidden = false; out.push({ t, box: r.box, shown: false, ok: true, score: r.score, found: true }); continue; }   // shown once confirmed
      }
      out.push({ t, box: tr.box, shown: false, ok: false, score: 0 });
      continue;
    }
    const plan = tr.plan(t), res = tr.update(render(sc, t, plan), t);
    if (!res.ok && res.hide) { hidden = true; lastSearch = t; }
    out.push({ t, box: res.box, shown: (res.ok && !res.probation) || !res.hide, ok: res.ok, score: res.score });
  }
  return out;
}

// ── the OLD matcher (a port of grabPatch / matchPatch / followPatches at c860247, same maths) ───────────────────────
function runOld(sc) {
  const b0 = sc.box(0), tw = 32, th = 32, out = [];
  const raster = (nx, ny, nw, nh, SW, SH, t) => render(sc, t, { nx, ny, nw, nh, SW, SH }).g;
  // grabPatch
  const g0 = raster(b0.x, b0.y, b0.w, b0.h, tw, th, 0), patch = { g: Float32Array.from(g0), tw, th, e: 1 };
  { let mean = 0; for (let i = 0; i < patch.g.length; i++) mean += patch.g[i]; mean /= patch.g.length; let e = 0; for (let i = 0; i < patch.g.length; i++) patch.g[i] -= mean; for (let j = 0; j < th; j += 2) for (let i = 0; i < tw; i += 2) { const v = patch.g[j * tw + i]; e += v * v; } patch.e = Math.sqrt(e) || 1; }
  const r = { x: b0.x, y: b0.y, w: b0.w, h: b0.h }; let lost = 0, upd = 0;
  const match = (lx, ly, lw, lh, t) => {
    const m = 0.55, hw = lw * (0.5 + m), hh = lh * (0.5 + m);
    const cx = Math.max(hw, Math.min(1 - hw, lx + lw / 2)), cy = Math.max(hh, Math.min(1 - hh, ly + lh / 2));
    const nx = cx - hw, ny = cy - hh, nw = hw * 2, nh = hh * 2;
    const SW = Math.max(tw + 4, Math.round(nw / lw * tw)), SH = Math.max(th + 4, Math.round(nh / lh * th));
    if (SW > 96 || SH > 96) return null;
    const d = raster(nx, ny, nw, nh, SW, SH, t);
    const expX = (lx - nx) / nw * SW, expY = (ly - ny) / nh * SH;
    let best = -1, bx = expX, by = expY;
    for (let oy = 0; oy <= SH - th; oy += 2) for (let ox = 0; ox <= SW - tw; ox += 2) {
      let mean = 0, n = 0;
      for (let j = 0; j < th; j += 2) for (let i = 0; i < tw; i += 2) { mean += d[(oy + j) * SW + ox + i]; n++; }
      mean /= n || 1;
      let dot = 0, e2 = 0;
      for (let j = 0; j < th; j += 2) for (let i = 0; i < tw; i += 2) { const g = d[(oy + j) * SW + ox + i] - mean, tt = patch.g[j * tw + i]; dot += g * tt; e2 += g * g; }
      const score = e2 > 1 ? dot / (Math.sqrt(e2) * patch.e) : -1;
      if (score > best) { best = score; bx = ox; by = oy; }
    }
    return { x: lx + (bx - expX) / SW * nw, y: ly + (by - expY) / SH * nh, score: best };
  };
  for (let t = 1 / HZ; t <= sc.dur + 1e-9; t += 1 / HZ) {
    const mm = match(r.x, r.y, r.w, r.h, t);
    let ok = false;
    if (mm && mm.score > 0.45) {
      const k = mm.score > 0.72 ? 0.8 : 0.45, dx = (mm.x - r.x) * k, dy = (mm.y - r.y) * k;
      r.x = Math.max(0, Math.min(1 - r.w, r.x + dx)); r.y = Math.max(0, Math.min(1 - r.h, r.y + dy)); lost = 0; ok = true;
      if (mm.score > 0.82 && (upd = upd + 1) % 5 === 0) {
        const fresh = raster(r.x, r.y, r.w, r.h, tw, th, t); let mean = 0; for (let i = 0; i < fresh.length; i++) mean += fresh[i]; mean /= fresh.length;
        for (let i = 0; i < fresh.length; i++) fresh[i] -= mean;
        for (let i = 0; i < fresh.length; i++) patch.g[i] = patch.g[i] * 0.8 + fresh[i] * 0.2;
        let e = 0; for (let j = 0; j < th; j += 2) for (let i = 0; i < tw; i += 2) { const v = patch.g[j * tw + i]; e += v * v; } patch.e = Math.sqrt(e) || 1;
      }
    } else lost++;
    out.push({ t, box: { x: r.x, y: r.y, w: r.w, h: r.h }, shown: lost <= 12, ok, score: mm ? mm.score : -1 });
  }
  return out;
}

// ── the matcher on feature/all-in-one (c65463a: wide search, centre weighting, velocity guess, rough scale step) ───────────────────────
function runBranch(sc) {
  const b0 = sc.box(0), out = [];
  const raster = (nx, ny, nw, nh, SW, SH, t) => render(sc, t, { nx, ny, nw, nh, SW, SH }).g;
  const aspect = b0.w / Math.max(b0.h, 1e-4);
  const ptw = aspect >= 1 ? 36 : Math.max(8, Math.round(36 * aspect)), pth = aspect >= 1 ? Math.max(8, Math.round(36 / aspect)) : 36;
  const pg = raster(b0.x, b0.y, b0.w, b0.h, ptw, pth, 0);
  { let m = 0; for (let i = 0; i < pg.length; i++) m += pg[i]; m /= pg.length; for (let i = 0; i < pg.length; i++) pg[i] -= m; }
  const patch = { g: pg, tw: ptw, th: pth };
  const prep = (tw, th) => {
    const g = new Float32Array(tw * th);
    for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
      const si = Math.min(patch.tw - 1, (i + 0.5) * patch.tw / tw | 0), sj = Math.min(patch.th - 1, (j + 0.5) * patch.th / th | 0);
      const dx = (i + 0.5) / tw - 0.5, dy = (j + 0.5) / th - 0.5, wt = 0.4 + 0.6 * Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / 0.72);
      g[j * tw + i] = patch.g[sj * patch.tw + si] * wt;
    }
    let mean = 0; for (let i = 0; i < g.length; i++) mean += g[i]; mean /= g.length;
    let e = 0; for (let j = 0; j < th; j += 2) for (let i = 0; i < tw; i += 2) { g[j * tw + i] -= mean; e += g[j * tw + i] * g[j * tw + i]; }
    return { g, e: Math.sqrt(e) || 1, tw, th };
  };
  const r = { x: b0.x, y: b0.y, w: b0.w, h: b0.h }; let lost = 0, vx = 0, vy = 0, upd = 0;
  const match = (lx, ly, lw, lh, pred, t) => {
    const radX = Math.max(lw * 2.4, 0.24), radY = Math.max(lh * 2.4, 0.24);
    let cx = (pred ? pred.x : lx) + lw / 2, cy = (pred ? pred.y : ly) + lh / 2;
    cx = Math.max(0.02, Math.min(0.98, cx)); cy = Math.max(0.02, Math.min(0.98, cy));
    let nx = cx - lw / 2 - radX, ny = cy - lh / 2 - radY, nw = lw + radX * 2, nh = lh + radY * 2;
    if (nx < 0) nx = 0; if (ny < 0) ny = 0;
    if (nx + nw > 1) nx = Math.max(0, 1 - nw); if (ny + nh > 1) ny = Math.max(0, 1 - nh);
    if (nx + nw > 1) nw = 1 - nx; if (ny + nh > 1) nh = 1 - ny;
    const fit = Math.min(1, 104 / (nw / lw * patch.tw), 104 / (nh / lh * patch.th));
    const tw = Math.max(6, Math.round(patch.tw * fit)), th = Math.max(6, Math.round(patch.th * fit));
    const SW = Math.max(tw + 2, Math.round(nw / lw * tw)), SH = Math.max(th + 2, Math.round(nh / lh * th));
    if (SW > 140 || SH > 140) return null;
    const tmpl = prep(tw, th), gray = raster(nx, ny, nw, nh, SW, SH, t);
    const ncc = (ox, oy, tt) => {
      const tw2 = tt.tw, th2 = tt.th;
      if (ox < 0 || oy < 0 || ox + tw2 > SW || oy + th2 > SH) return -1;
      let mean = 0, n = 0;
      for (let j = 0; j < th2; j += 2) for (let i = 0; i < tw2; i += 2) { mean += gray[(oy + j) * SW + ox + i]; n++; }
      mean /= n || 1;
      let dot = 0, e2 = 0;
      for (let j = 0; j < th2; j += 2) for (let i = 0; i < tw2; i += 2) {
        const dx = (i + 0.5) / tw2 - 0.5, dy = (j + 0.5) / th2 - 0.5, wt = 0.4 + 0.6 * Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / 0.72);
        const g = (gray[(oy + j) * SW + ox + i] - mean) * wt, tv = tt.g[j * tw2 + i]; dot += g * tv; e2 += g * g;
      }
      return e2 > 1 ? dot / (Math.sqrt(e2) * tt.e) : -1;
    };
    let best = -1, second = -1, bx = 0, by = 0; const step = tw > 18 ? 3 : 2;
    for (let oy = 0; oy <= SH - th; oy += step) for (let ox = 0; ox <= SW - tw; ox += step) {
      const sco = ncc(ox, oy, tmpl);
      if (sco > best) { if (Math.hypot(ox - bx, oy - by) > Math.max(tw, th) * 0.75) second = Math.max(second, best); best = sco; bx = ox; by = oy; }
      else if (sco > second && Math.hypot(ox - bx, oy - by) > Math.max(tw, th) * 0.75) second = sco;
    }
    for (let oy = Math.max(0, by - step); oy <= Math.min(SH - th, by + step); oy++) for (let ox = Math.max(0, bx - step); ox <= Math.min(SW - tw, bx + step); ox++) { const sco = ncc(ox, oy, tmpl); if (sco > best) { best = sco; bx = ox; by = oy; } }
    let scale = 1;
    for (const k of [0.86, 1.16]) { const t2 = prep(Math.max(6, Math.round(tw * k)), Math.max(6, Math.round(th * k))), sco = ncc(bx, by, t2); if (sco > best + 0.035) { best = sco; scale = k; } }
    return { x: nx + bx / SW * nw, y: ny + by / SH * nh, score: best, margin: best - Math.max(second, 0), scale };
  };
  const move = (dx, dy) => { const ax = Math.max(-r.x, Math.min(1 - r.w - r.x, dx)), ay = Math.max(-r.y, Math.min(1 - r.h - r.y, dy)); r.x += ax; r.y += ay; };
  const rescale = (k) => { if (!k || Math.abs(k - 1) < 0.03) return; const cx = r.x + r.w / 2, cy = r.y + r.h / 2, w = Math.max(0.012, Math.min(0.95, r.w * k)), h = Math.max(0.012, Math.min(0.95, r.h * k)); r.x = Math.max(0, Math.min(1 - w, cx - w / 2)); r.y = Math.max(0, Math.min(1 - h, cy - h / 2)); r.w = w; r.h = h; };
  for (let t = 1 / HZ; t <= sc.dur + 1e-9; t += 1 / HZ) {
    const pred = { x: r.x + vx, y: r.y + vy }, m = match(r.x, r.y, r.w, r.h, pred, t);
    const near = m && Math.hypot(m.x - pred.x, m.y - pred.y) < Math.max(r.w, r.h, 0.05), ok = m && (m.score >= 0.4 || (m.score >= 0.28 && (near || m.margin >= 0.06)));
    if (ok) {
      const dx = (m.x - r.x) * 0.9, dy = (m.y - r.y) * 0.9; move(dx, dy);
      if (m.scale && m.score >= 0.55 && m.margin >= 0.08) rescale(1 + (m.scale - 1) * 0.35);
      vx = dx; vy = dy; lost = 0;
      if (m.score > 0.62 && (upd = upd + 1) % 6 === 0) { const fresh = raster(r.x, r.y, r.w, r.h, patch.tw, patch.th, t); let mm = 0; for (let i = 0; i < fresh.length; i++) mm += fresh[i]; mm /= fresh.length; for (let i = 0; i < fresh.length; i++) patch.g[i] = patch.g[i] * 0.82 + (fresh[i] - mm) * 0.18; }
    } else { lost++; if (lost < 6 && (vx || vy)) move(vx * 0.55, vy * 0.55); }
    out.push({ t, box: { x: r.x, y: r.y, w: r.w, h: r.h }, shown: true, ok: !!ok, score: m ? m.score : -1 });   // the branch keeps the blur where it last matched: always shown
  }
  return out;
}

// ── scoring ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** The object is out of the picture when less than 35 % of it is inside the frame. */
function absent(T) { const ix = Math.max(0, Math.min(1, T.x + T.w) - Math.max(0, T.x)) / T.w, iy = Math.max(0, Math.min(1, T.y + T.h) - Math.max(0, T.y)) / T.h; return ix * iy < 0.35; }
function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h), i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return i / (a.w * a.h + b.w * b.h - i);
}
/** good = the box overlaps the true box by at least 0.5 (IoU) and is shown. Pixel error is the centre distance in frame pixels. */
function score(sc, run) {
  let good = 0, errs = [], sizeErr = [], last = run.slice(-Math.max(5, run.length >> 2));
  for (const r of run) {
    const T = padBox(sc.box(r.t), sc.pad);
    if (absent(T)) { if (!r.shown) good++; errs.push(r.shown ? 999 : 0); sizeErr.push(0); continue; }   // out of the picture: right when nothing is shown
    const v = r.shown && iou(r.box, T) >= 0.5;
    if (v) good++;
    errs.push(Math.hypot((r.box.x + r.box.w / 2 - T.x - T.w / 2) * FW, (r.box.y + r.box.h / 2 - T.y - T.h / 2) * FH));
    sizeErr.push(Math.abs(r.box.w / T.w - 1));
  }
  errs.sort((a, b) => a - b); sizeErr.sort((a, b) => a - b);
  const endGood = last.filter((r) => { const T = padBox(sc.box(r.t), sc.pad); return absent(T) ? !r.shown : r.shown && iou(r.box, T) >= 0.5; }).length / last.length;
  return { good: good / run.length, endGood, medErr: errs[errs.length >> 1], p90Err: errs[Math.floor(errs.length * 0.9)], medSize: sizeErr[sizeErr.length >> 1] };
}

module.exports = { SCENARIOS, runNew, runOld, runBranch, score, iou, render, FW, FH, HZ };

if (require.main === module) {
  const rows = [];
  for (const sc of SCENARIOS) { const t0 = Date.now(); const o = score(sc, runOld(sc)), b = score(sc, runBranch(sc)), t1 = Date.now(), n = score(sc, runNew(sc)), t2 = Date.now(); rows.push({ name: sc.name, old: o, branch: b, now: n, msOld: t1 - t0, msNew: t2 - t1 }); }
  if (process.argv.includes("--json")) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }
  const pad = (s, n) => String(s).padEnd(n), pc = (v) => (Math.round(v * 100) + "%").padStart(5), px = (v) => (v < 10 ? v.toFixed(1) : Math.round(v) + "").padStart(5);
  console.log("on target = box overlaps the true object (IoU >= 0.5).  c860247 = earlier commit, branch = feature/all-in-one tip c65463a, new = js/patch-track.js");
  console.log(pad("scenario", 32) + " | on target: c860247  branch   new | at the end: branch   new | median px error: branch   new");
  for (const r of rows) console.log(pad(r.name, 32) + " |            " + pc(r.old.good) + " " + pc(r.branch.good) + " " + pc(r.now.good) + " |          " + pc(r.branch.endGood) + " " + pc(r.now.endGood) + " |                  " + px(r.branch.medErr) + " " + px(r.now.medErr));
  const avg = (k, w) => rows.reduce((s, r) => s + r[w][k], 0) / rows.length;
  console.log("\nmean on target: c860247 " + pc(avg("good", "old")) + "  branch " + pc(avg("good", "branch")) + "  new " + pc(avg("good", "now")) + "   mean at the end: branch " + pc(avg("endGood", "branch")) + "  new " + pc(avg("endGood", "now")));
  console.log("time per scenario (all looks): branch+old " + rows.reduce((s, r) => s + r.msOld, 0) + " ms, new " + rows.reduce((s, r) => s + r.msNew, 0) + " ms");
}
