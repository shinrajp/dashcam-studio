/* colour-constancy.js — PROTOTYPE (tag color-constancy-proto), Settings ▸ White balance ▸ "Colour constancy (prototype)",
 * OFF by default. Everything here is a second opinion on the light's colour and a better way to undo it:
 *   - chromatic adaptation: CAT16 (default) or Bradford, linear sRGB → XYZ → cone space → D65 → back, with a degree of
 *     adaptation D; compared with the shipped per-channel gains (in gamma-encoded sRGB, WB.classifyGains)
 *   - illuminant estimates: car paint (wb.js, the mirrors), lane / crosswalk markings, licence-plate background,
 *     grey world, and a learned estimator (FC4, SqueezeNet 1.1, confidence-weighted pooling; MIT, models/cc/README.md)
 *     run with onnxruntime-web (WASM), fused robustly in log-chroma
 *   - vehicle colour by CLIP zero-shot prompts on the corrected crop, fused with the pixel statistics
 * All whites are LINEAR sRGB [r,g,b] (any scale). Nothing here runs unless the setting is on (or a test calls it). */
(function () {
  "use strict";
  const T = (window.TDC = window.TDC || {});
  const CC = (T.cc = { status: "", timings: { fc4: [], refs: [] } });
  const KEY = "tdc.cc.v1";
  CC.C = {
    // log-chroma fusion: prior weight per source (× its own confidence), robust scale (degrees)
    PRIOR: { paint: 1.0, plate: 0.8, lane: 0.7, learned: 0.5, greyworld: 0.15 },
    ROBUST_DEG: 3,
    FC4_URL: "models/cc/fc4-squeezenet11-int8.onnx",
    FC4_SIDE: 384,
    // FC4 was trained on linear camera RGB (Canon, Gehler-Shi): this 3×3 maps its output to linear sRGB. Fitted on the
    // synthetic set's calibration half (tools/cc-eval: fold A), tested on the other half. Identity = uncalibrated.
    FC4_CAL: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    CLIP_W: 0.5,            // vehicle colour: CLIP share in the fused score (pixel stats get the rest)
  };
  CC.defaults = () => ({ on: false, estimator: "fusion", adapt: "cat16", clip: false });
  CC.prefs = () => { const d = CC.defaults(); try { const v = JSON.parse(localStorage.getItem(KEY) || "null"); if (v && typeof v === "object") return { ...d, ...v }; } catch (_) {} return d; };
  CC.setPref = (k, v) => { const p = CC.prefs(); p[k] = v; try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (_) {} CC.forget(); T.emit && T.emit("cc-changed", p); };
  CC.on = () => CC.prefs().on === true;

  // ── linear algebra ──
  const mul = (A, B) => A.map((r) => B[0].map((_, j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  const mv = (A, v) => [A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2], A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2], A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2]];
  const inv = (m) => {
    const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2], A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
    return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det], [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
  };
  const diag = (v) => [[v[0], 0, 0], [0, v[1], 0], [0, 0, v[2]]];
  CC.mat = { mul, mv, inv, diag };
  const RGB2XYZ = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.072175], [0.0193339, 0.119192, 0.9503041]];
  const XYZ2RGB = inv(RGB2XYZ);
  const CATS = {
    bradford: [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]],
    cat16: [[0.401288, 0.650173, -0.051461], [-0.250268, 1.204414, 0.045854], [-0.002079, 0.048952, 0.953127]],
  };
  const D65 = mv(RGB2XYZ, [1, 1, 1]);
  CC.ADAPT = ["gains", "gains-linear", "bradford", "cat16"];

  /** 3×3 in LINEAR sRGB that takes the light `white` to neutral (D65), degree of adaptation D (0..1).
   *  Brightness convention as the shipped gains: at D = 1 the white comes out at its brightest channel (m, m, m).
   *  method: "gains-linear" (von Kries on R,G,B), "bradford", "cat16". ("gains" = the shipped gamma-space gains: no matrix.) */
  CC.adaptMatrix = (white, method, D) => {
    D = D == null ? 1 : Math.max(0, Math.min(1, D));
    const w = white.map((v) => Math.max(1e-6, v)), m = Math.max(w[0], w[1], w[2]);
    if (method === "gains-linear") return diag(w.map((c) => 1 + (m / c - 1) * D));
    const M = CATS[method] || CATS.cat16;
    const Xw = mv(RGB2XYZ, w), Yw = Xw[1];
    const Lw = mv(M, Xw.map((v) => v / Yw)), Ld = mv(M, D65);
    const g = Lw.map((l, i) => D * (Ld[i] / l) + (1 - D));
    const A = mul(XYZ2RGB, mul(inv(M), mul(diag(g), mul(M, RGB2XYZ))));
    // scale: white → its brightest channel at D = 1, unchanged brightness at D = 0
    const out = mv(A, w), k = (D * m + (1 - D) * Math.max(out[0], out[1], out[2])) / Math.max(1e-6, Math.max(out[0], out[1], out[2]));
    return A.map((r) => r.map((v) => v * k));
  };
  /** CCT of a linear white (McCamy), for labels. */
  CC.cct = (w) => { const X = mv(RGB2XYZ, w), s = X[0] + X[1] + X[2], x = X[0] / s, y = X[1] / s, n = (x - 0.332) / (0.1858 - y); return Math.round(449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33); };
  /** Angle (degrees) between two RGB lights. */
  CC.angle = (a, b) => { const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2], n = Math.hypot(...a) * Math.hypot(...b); return (Math.acos(Math.max(-1, Math.min(1, d / n))) * 180) / Math.PI; };

  // ── sRGB helpers ──
  const LIN = new Float32Array(256); for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  CC.LIN = LIN;
  CC.srgbToLin = (v255) => v255.map((c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
  CC.linToSrgb = (l) => l.map((c) => { c = Math.max(0, c); return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055); });

  // ── illuminant estimates (each → { white (linear), conf 0..1, n, why }) ──
  /** Mean (linear) of the 60–95th luminance percentile of the given pixels (same rule as wb.js for the car paint). */
  CC.whitePercentile = (rgba, idx, lo = 0.6, hi = 0.95) => {
    const ls = [];
    for (const i of idx) { const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]; if (r > 250 || g > 250 || b > 250) continue; ls.push([0.2126 * LIN[r] + 0.7152 * LIN[g] + 0.0722 * LIN[b], i]); }
    if (ls.length < 12) return null;
    ls.sort((a, b) => a[0] - b[0]);
    const a = Math.floor(ls.length * lo), z = Math.max(a + 1, Math.floor(ls.length * hi)), s = [0, 0, 0];
    for (let k = a; k < z; k++) { const i = ls[k][1]; s[0] += LIN[rgba[i]]; s[1] += LIN[rgba[i + 1]]; s[2] += LIN[rgba[i + 2]]; }
    const n = z - a; return { white: s.map((v) => v / n), n, lum: ls[Math.floor(ls.length * 0.8)][0] };
  };
  /** Car paint: the mirrors' white point from wb.js (sRGB 0..255 mean) → linear. */
  CC.fromPaint = (fix) => (fix && fix.white ? { white: CC.srgbToLin(fix.white), conf: 0.9, why: "car paint (" + (fix.cams || []).join(", ") + ")" } : null);
  /** A white patch given as pixels (tests: the synthetic mirror body). */
  CC.fromPatch = (rgba) => { const idx = []; for (let i = 0; i < rgba.length; i += 4) idx.push(i); const r = CC.whitePercentile(rgba, idx); return r && { white: r.white, conf: Math.min(1, r.n / 200), why: "patch" }; };
  /** Lane / crosswalk markings: in the road area (lower part, middle), pixels much brighter than their row's median
   *  (paint on asphalt). Their chromaticity must agree with the asphalt's (both are near-neutral) — a yellow centre line
   *  doesn't, and is dropped. roi = {x0,x1,y0,y1} fractions. */
  CC.fromLanes = (rgba, w, h, roi) => {
    roi = roi || { x0: 0.15, x1: 0.85, y0: 0.62, y1: 0.98 };
    const X0 = Math.floor(roi.x0 * w), X1 = Math.ceil(roi.x1 * w), Y0 = Math.floor(roi.y0 * h), Y1 = Math.ceil(roi.y1 * h);
    const mark = [], road = [0, 0, 0]; let nr = 0, area = 0;
    for (let y = Y0; y < Y1; y++) {
      const row = []; for (let x = X0; x < X1; x++) { const i = (y * w + x) * 4; row.push(0.2126 * LIN[rgba[i]] + 0.7152 * LIN[rgba[i + 1]] + 0.0722 * LIN[rgba[i + 2]]); }
      const srt = row.slice().sort((a, b) => a - b), med = srt[srt.length >> 1];
      for (let x = X0; x < X1; x++) {
        const i = (y * w + x) * 4, l = row[x - X0]; area++;
        if (l > med * 2.2 && l > 0.004) mark.push(i);
        else if (l < med * 1.3 && l > med * 0.7) { road[0] += LIN[rgba[i]]; road[1] += LIN[rgba[i + 1]]; road[2] += LIN[rgba[i + 2]]; nr++; }
      }
    }
    if (mark.length < Math.max(30, area * 0.004) || nr < 100) return null;
    const r = CC.whitePercentile(rgba, mark, 0.3, 0.95); if (!r) return null;
    const asphalt = road.map((v) => v / nr), ang = CC.angle(r.white, asphalt);
    const agree = Math.max(0, 1 - Math.max(0, ang - 4) / 8);   // ≤ 4° apart: full trust, ≥ 12°: none (yellow paint, a lit sign)
    return { white: r.white, conf: Math.min(1, mark.length / (area * 0.02)) * agree, why: "lane markings (" + mark.length + " px, " + ang.toFixed(1) + "° from the asphalt)", asphalt };
  };
  /** Licence-plate background: inside each plate box (fractions), the bright 55–90 % of pixels (the characters are dark). */
  CC.fromPlates = (rgba, w, h, boxes) => {
    const idx = [];
    for (const b of boxes || []) {
      const x0 = Math.max(0, Math.floor((b.x + b.w * 0.08) * w)), x1 = Math.min(w, Math.ceil((b.x + b.w * 0.92) * w)), y0 = Math.max(0, Math.floor((b.y + b.h * 0.12) * h)), y1 = Math.min(h, Math.ceil((b.y + b.h * 0.88) * h));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) idx.push((y * w + x) * 4);
    }
    if (idx.length < 40) return null;
    const r = CC.whitePercentile(rgba, idx, 0.55, 0.9); if (!r) return null;
    return { white: r.white, conf: Math.min(1, idx.length / 400), why: "plate background (" + (boxes || []).length + ")" };
  };
  /** Grey world (cheap baseline): mean linear colour of the frame. */
  CC.fromGreyWorld = (rgba) => { const s = [0, 0, 0]; let n = 0; for (let i = 0; i < rgba.length; i += 16) { s[0] += LIN[rgba[i]]; s[1] += LIN[rgba[i + 1]]; s[2] += LIN[rgba[i + 2]]; n++; } return n ? { white: s.map((v) => v / n), conf: 0.5, why: "grey world" } : null; };

  // ── learned estimator: FC4 (SqueezeNet 1.1, confidence-weighted pooling), onnxruntime-web WASM ──
  let fc4 = null;
  CC.loadLearned = () => fc4 || (fc4 = (async () => {
    const ort = window.ort; if (!ort) throw new Error("onnxruntime-web isn't loaded");
    const t0 = performance.now();
    const s = await ort.InferenceSession.create(CC.C.FC4_URL, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    CC.info = { loadMs: Math.round(performance.now() - t0) };
    return s;
  })().catch((e) => { fc4 = null; throw e; }));
  let fcv = null;
  /** img: canvas / video / image. → { white (linear sRGB, calibrated), raw (network output), conf, ms } */
  CC.fromLearned = async (img, iw, ih) => {
    const s = await CC.loadLearned(), ort = window.ort;
    const k = Math.min(1, CC.C.FC4_SIDE / Math.max(iw, ih)), w = Math.max(64, Math.round((iw * k) / 16) * 16), h = Math.max(64, Math.round((ih * k) / 16) * 16);
    fcv = fcv || document.createElement("canvas"); fcv.width = w; fcv.height = h;
    const x = fcv.getContext("2d", { willReadFrequently: true }); x.drawImage(img, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data, n = w * h, lin = new Float32Array(3 * n); let mx = 1e-6;
    for (let p = 0; p < n; p++) for (let c = 0; c < 3; c++) { const v = LIN[d[p * 4 + c]]; lin[c * n + p] = v; if (v > mx) mx = v; }
    for (let p = 0; p < 3 * n; p++) lin[p] = Math.pow(lin[p] / mx, 1 / 2.2);   // as the training data: max-normalised, gamma 1/2.2
    const t0 = performance.now();
    const out = await s.run({ image: new ort.Tensor("float32", lin, [1, 3, h, w]) });
    const ms = performance.now() - t0; CC.timings.fc4.push(ms); if (CC.timings.fc4.length > 60) CC.timings.fc4.shift();
    const raw = Array.from(out.illum.data);
    // confidence: how much the confident patches agree (weighted angular spread of the per-patch estimates)
    const pr = out.patch_rgb.data, pc = out.patch_conf.data, np = pc.length; let sw = 0, sa = 0;
    for (let i = 0; i < np; i++) { const a = CC.angle([pr[i], pr[np + i], pr[2 * np + i]], raw); if (isFinite(a)) { sw += pc[i]; sa += pc[i] * a; } }
    const spread = sw ? sa / sw : 30;
    const white = mv(CC.C.FC4_CAL, raw).map((v) => Math.max(1e-4, v));
    return { white, raw, conf: Math.max(0.05, Math.min(1, 1 - (spread - 2) / 10)), spread, ms, why: "learned (FC4)" };
  };

  // ── fusion ──
  const lc = (w) => [Math.log(Math.max(1e-6, w[0]) / Math.max(1e-6, w[1])), Math.log(Math.max(1e-6, w[2]) / Math.max(1e-6, w[1]))];
  /** Robust fusion in log-chroma: weighted mean, then iteratively re-weighted (Cauchy, scale ROBUST_DEG) so one wrong
   *  reference (yellow line, coloured plate, odd lamp) can't pull the answer. ests: { name: estimate|null }.
   *  → { white, conf, used: [{name, w, deg}], spread } */
  CC.fuse = (ests, prior) => {
    prior = prior || CC.C.PRIOR;
    const L = Object.entries(ests).filter(([, e]) => e && e.white && e.conf > 0).map(([k, e]) => ({ k, e, p: lc(e.white), w0: (prior[k] != null ? prior[k] : 0.3) * e.conf }));
    if (!L.length) return null;
    let mu = [0, 0];
    const mean = (ws) => { let s = 0, a = 0, b = 0; L.forEach((x, i) => { s += ws[i]; a += ws[i] * x.p[0]; b += ws[i] * x.p[1]; }); return s ? [a / s, b / s] : [0, 0]; };
    let ws = L.map((x) => x.w0); mu = mean(ws);
    const sc = (CC.C.ROBUST_DEG * Math.PI) / 180 * 1.6;   // ~log-chroma units per degree near neutral
    for (let it = 0; it < 8; it++) { ws = L.map((x) => { const d = Math.hypot(x.p[0] - mu[0], x.p[1] - mu[1]) / sc; return x.w0 / (1 + d * d); }); mu = mean(ws); }
    const white = [Math.exp(mu[0]), 1, Math.exp(mu[1])];
    const used = L.map((x, i) => ({ name: x.k, w: Math.round((ws[i] / x.w0) * 100) / 100, deg: Math.round(CC.angle(x.e.white, white) * 10) / 10 }));
    const sw = ws.reduce((a, b) => a + b, 0), sw0 = L.reduce((a, x) => a + x.w0, 0);
    return { white, conf: Math.min(1, sw / Math.max(0.5, sw0) * Math.min(1, sw0)), used };
  };

  // ── vehicle colour by CLIP ──
  let clipTxt = null;
  CC.CLIP_COLOURS = ["white", "silver", "gray", "black", "red", "blue", "green", "yellow", "orange", "brown", "beige", "purple"];
  CC.clipColour = async (crop, cls) => {
    const S = T.search && T.search.clip; if (!S || !S.texts || !S.image) throw new Error("CLIP isn't available");
    const kind = cls === "bus" ? "bus" : cls === "truck" ? "truck" : cls === "motorcycle" ? "motorcycle" : "car";
    clipTxt = clipTxt || {};
    if (!clipTxt[kind]) clipTxt[kind] = await S.texts(CC.CLIP_COLOURS.map((c) => "a photo of a " + c + " " + kind));
    const v = await S.image(crop), sims = clipTxt[kind].map((t) => t.reduce((s, x, i) => s + x * v[i], 0));
    const mx = Math.max(...sims), ex = sims.map((s) => Math.exp((s - mx) * 100)), z = ex.reduce((a, b) => a + b, 0);
    const p = {}; CC.CLIP_COLOURS.forEach((c, i) => (p[c] = ex[i] / z));
    const best = CC.CLIP_COLOURS.reduce((a, c) => (p[c] > p[a] ? c : a));
    return { name: best, conf: p[best], probs: p };
  };
  /** Fuse CLIP probabilities with the pixel classifier's scores (shares of the body by colour). */
  CC.fuseColour = (pix, clip, wClip) => {
    wClip = wClip == null ? CC.C.CLIP_W : wClip;
    const sc = {}, ps = pix && pix.scores ? pix.scores : {}, tot = Object.values(ps).reduce((a, b) => a + b, 0) || 1;
    for (const c of CC.CLIP_COLOURS) sc[c] = (1 - wClip) * ((ps[c] || 0) / tot) + wClip * ((clip && clip.probs[c]) || 0);
    if (pix && pix.name && !CC.CLIP_COLOURS.includes(pix.name)) sc[pix.name] = (1 - wClip);
    const name = Object.keys(sc).reduce((a, c) => (sc[c] > sc[a] ? c : a));
    return { name, conf: sc[name], scores: sc };
  };

  CC.forget = () => { cache.clear(); };
  const cache = new Map();
  /** App hook (setting on): the fix for a vehicle-colour judgement at event time t from frame img of camera cam.
   *  paint = WB.colourFix(t) result (or null). → { matrix | gains, white (linear), cct, label, sources } or null. */
  CC.fixFor = async (img, iw, ih, t, cam, paint) => {
    if (!CC.on()) return null;
    const P = CC.prefs(), ev = T.player && T.player.ev, key = (ev ? ev.id : "") + "|" + cam + "|" + Math.floor(t / 4) + "|" + P.estimator + "|" + P.adapt;
    if (cache.has(key)) return cache.get(key);
    const t0 = performance.now(), ests = {};
    ests.paint = CC.fromPaint(paint);
    let rgba = null, w = 0, h = 0;
    try {
      const k = Math.min(1, 480 / Math.max(iw, ih)); w = Math.round(iw * k); h = Math.round(ih * k);
      const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(img, 0, 0, w, h); rgba = x.getImageData(0, 0, w, h).data;
    } catch (e) { console.warn("cc frame", e); }
    if (rgba && P.estimator !== "paint") {
      if (cam === "front" || cam === "back") ests.lane = CC.fromLanes(rgba, w, h);
      const sc = T.libIndex && T.libIndex.text && ev && T.libIndex.text.get(ev.id);
      const boxes = sc ? sc.items.filter((i) => i.kind === "plate" && i.cam === cam && Math.abs(i.t - t) < 1.5).map((i) => i.box) : [];
      if (boxes.length) ests.plate = CC.fromPlates(rgba, w, h, boxes);
      try { ests.learned = await CC.fromLearned(img, iw, ih); } catch (e) { console.warn("cc learned", e); CC.status = "Learned estimator unavailable: " + e.message; }
      ests.greyworld = CC.fromGreyWorld(rgba);
    }
    let est = null;
    if (P.estimator === "paint") est = ests.paint;
    else if (P.estimator === "learned") est = ests.learned;
    else est = CC.fuse(ests);
    CC.timings.refs.push(performance.now() - t0); if (CC.timings.refs.length > 60) CC.timings.refs.shift();
    let out = null;
    if (est && est.white) {
      const white = est.white, cct = CC.cct(white), D = T.wb && T.wb.C ? T.wb.C.CLASSIFY_STRENGTH : 1;
      out = { white, cct, conf: est.conf, sources: est.used || [{ name: P.estimator, w: 1 }], adapt: P.adapt, source: "cc-" + P.estimator };
      if (P.adapt === "gains") { const s = CC.linToSrgb(white), mx = Math.max(...s); out.gains = T.wb ? T.wb.classifyGains(s.map((v) => (v * 230) / mx)) : s.map((v) => mx / v); }
      else out.matrix = CC.adaptMatrix(white, P.adapt, D);
    }
    CC.last = { t, cam, ests, est: out };
    cache.set(key, out); if (cache.size > 200) cache.delete(cache.keys().next().value);
    return out;
  };
})();
