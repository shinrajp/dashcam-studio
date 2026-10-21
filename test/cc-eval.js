// Colour-constancy prototype: accuracy + speed on the synthetic night set (tools/make-cc-testset.py) and, when present,
// the real night photos (tools/fetch-cc-night.py). Playwright Chromium runs the app's own code (YOLO boxes, FC4 via
// onnxruntime-web, CLIP); the numbers are computed here in node with js/vehicle-attrs.js + js/colour-constancy.js.
// Needs the repo served with cc-data → /tmp/cc-testset, cc-fixtures → /tmp/vehicle-fixtures (and cc-night) symlinks.
// Usage: node test/cc-eval.js [url]   OUT=file.json writes every number; CLIP=0 skips the CLIP pass.
const pw = require("playwright"); const fs = require("fs"), path = require("path");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const SET = JSON.parse(fs.readFileSync("/tmp/cc-testset/truth.json", "utf8"));
const NIGHT = fs.existsSync("/tmp/cc-night/truth.json") ? JSON.parse(fs.readFileSync("/tmp/cc-night/truth.json", "utf8")) : null;
global.window = {}; require(path.join(__dirname, "../js/colour-constancy.js")); const CC = window.TDC.cc; const A = require(path.join(__dirname, "../js/vehicle-attrs.js"));
const ACHRO = new Set(["white", "silver", "gray"]);
const okStrict = (got, want) => got === want, okLenient = (got, want) => got === want || (ACHRO.has(got) && ACHRO.has(want) && !(want === "white" && got === "gray"));

(async () => {
  const b = await pw.chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } }); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(URL_, { waitUntil: "load" });
  await p.waitForFunction(() => window.TDC && TDC.cc && TDC.detect && TDC.vehicleAttrs);
  // ── pass 1: boxes, references, FC4 ──
  const res = await p.evaluate(async ({ items, night }) => {
    const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error("load " + src)); i.src = src; });
    const px = (img, w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(img, 0, 0, w, h); return { c, d: x.getImageData(0, 0, w, h).data }; };
    const crop = (img, iw, ih, b) => { const x = Math.max(0, (b.x + b.w * 0.06) * iw), y = Math.max(0, (b.y + b.h * 0.06) * ih), w = Math.max(2, b.w * 0.88 * iw), h = Math.max(2, b.h * 0.88 * ih);
      const Wc = Math.max(8, Math.min(64, Math.round(w))), Hc = Math.max(8, Math.min(64, Math.round((h / w) * Wc))); const c = document.createElement("canvas"); c.width = Wc; c.height = Hc; const k = c.getContext("2d", { willReadFrequently: true }); k.drawImage(img, x, y, w, h, 0, 0, Wc, Hc);
      const d = k.getImageData(0, 0, Wc, Hc).data; let s = ""; for (let i = 0; i < d.length; i += 8192) s += String.fromCharCode.apply(null, d.subarray(i, i + 8192)); return { b64: btoa(s), w: Wc, h: Hc }; };
    const CC = TDC.cc, boxes = {}, t0 = performance.now();
    const biggest = async (img) => { const dets = (await TDC.detect.detectImage(img, img.naturalWidth, img.naturalHeight, { conf: 0.25 })).filter((d) => ["car", "bus", "truck", "motorcycle"].includes(d.label)).sort((a, b) => b.w * b.h - a.w * a.h); return dets[0] || null; };
    const ceil = {};
    for (const src of [...new Set(items.map((i) => i.src))]) { const img = await load("cc-fixtures/" + src); boxes[src] = await biggest(img); if (boxes[src]) ceil[src] = crop(img, img.naturalWidth, img.naturalHeight, boxes[src]); }
    const detMs = performance.now() - t0;
    const out = [];
    const l0 = performance.now(); await CC.loadLearned(); const loadMs = performance.now() - l0;
    for (const it of items) {
      const img = await load("cc-data/" + it.file), w = img.naturalWidth, h = img.naturalHeight, { d } = px(img, w, h);
      const mir = await load("cc-data/" + it.mirror), md = px(mir, mir.naturalWidth, mir.naturalHeight).d;
      const bx = boxes[it.src]; if (!bx) { out.push({ file: it.file, none: true }); continue; }
      const box = { x: bx.x, y: bx.y * it.photo.h, w: bx.w, h: bx.h * it.photo.h };
      const r0 = performance.now();
      const e = { paint: CC.fromPatch(md), lane: CC.fromLanes(d, w, h, it.lanes), plate: CC.fromPlates(d, w, h, [it.plate]), greyworld: CC.fromGreyWorld(d) };
      const refMs = performance.now() - r0;
      e.learned = await CC.fromLearned(img, w, h);
      out.push({ file: it.file, box, cls: bx.label, est: Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v && { white: v.white, raw: v.raw, conf: v.conf, spread: v.spread }])), crop: crop(img, w, h, box), refMs, fc4Ms: e.learned.ms });
    }
    const nout = [];
    for (const it of night || []) {
      const img = await load("cc-night/" + it.file), w = img.naturalWidth, h = img.naturalHeight, { d } = px(img, w, h);
      const bx = await biggest(img); if (!bx) { nout.push({ file: it.file, none: true }); continue; }
      const e = { lane: CC.fromLanes(d, w, h), greyworld: CC.fromGreyWorld(d), learned: await CC.fromLearned(img, w, h) };
      nout.push({ file: it.file, box: bx, cls: bx.label, est: Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v && { white: v.white, raw: v.raw, conf: v.conf }])), crop: crop(img, w, h, bx), w, h });
    }
    return { out, nout, detMs, loadMs, ceil };
  }, { items: SET.items, night: NIGHT && NIGHT.items });
  console.log("pass 1:", res.out.length, "scenes,", res.nout.length, "night photos; FC4 load", Math.round(res.loadMs), "ms");

  // ── node: FC4 calibration (2-fold), illuminant errors, colour accuracy ──
  const items = SET.items.map((it, i) => ({ ...it, ...res.out[i] })).filter((x) => !x.none);
  const norm = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
  const fitCal = (rows) => {   // least squares M: M·r ≈ t (unit vectors)
    const R = rows.map((r) => norm(r.est.learned.raw)), Tt = rows.map((r) => norm(r.illum));
    const RtR = [0, 1, 2].map((i) => [0, 1, 2].map((j) => R.reduce((s, r) => s + r[i] * r[j], 0)));
    const inv = CC.mat.inv(RtR);
    return [0, 1, 2].map((k) => { const RtT = [0, 1, 2].map((i) => R.reduce((s, r, n) => s + r[i] * Tt[n][k], 0)); return CC.mat.mv(inv, RtT); });
  };
  const calA = fitCal(items.filter((x) => x.fold === "A")), calB = fitCal(items.filter((x) => x.fold === "B")), calAll = fitCal(items);
  for (const x of items) { const M = x.fold === "A" ? calB : calA; x.est.learnedCal = { white: CC.mat.mv(M, x.est.learned.raw).map((v) => Math.max(1e-4, v)), conf: x.est.learned.conf }; x.est.learnedUncal = x.est.learned; }
  for (const x of items) {
    x.est.fusion = CC.fuse({ paint: x.est.paint, lane: x.est.lane, plate: x.est.plate, learned: x.est.learnedCal, greyworld: x.est.greyworld });
    x.est.fusionNoPaint = CC.fuse({ lane: x.est.lane, plate: x.est.plate, learned: x.est.learnedCal, greyworld: x.est.greyworld });
    x.est.refsOnly = CC.fuse({ paint: x.est.paint, lane: x.est.lane, plate: x.est.plate });
    x.est.none = { white: [1, 1, 1], conf: 1 };
    const Y = (w) => 0.2126 * w[0] + 0.7152 * w[1] + 0.0722 * w[2], f = x.est.fusion;
    const ls = ["paint", "plate", "lane"].map((k) => x.est[k]).filter((e) => e && e.conf > 0.3 && f && CC.angle(e.white, f.white) < 5).map((e) => Y(e.white)).sort((a, b) => a - b);
    x.lumRef = ls.length ? ls[ls.length >> 1] : null;
  }
  const stats = (a) => { const s = a.slice().sort((p, q) => p - q), m = s.reduce((p, q) => p + q, 0) / s.length, w = s.slice(Math.floor(s.length * 0.75)); return { mean: +m.toFixed(2), median: +s[s.length >> 1].toFixed(2), worst25: +(w.reduce((p, q) => p + q, 0) / w.length).toFixed(2), n: s.length }; };
  const ESTS = ["none", "greyworld", "paint", "lane", "plate", "learnedUncal", "learnedCal", "refsOnly", "fusion", "fusionNoPaint"];
  const illum = {}; for (const k of ESTS) { const e2 = items.filter((x) => x.est[k]).map((x) => CC.angle(x.est[k].white, x.illum)); illum[k] = { ...stats(e2), found: e2.length + "/" + items.length }; }
  const cropOf = (c) => ({ d: Uint8ClampedArray.from(Buffer.from(c.b64, "base64")), w: c.w, h: c.h });
  const judgeR = (x, est, adapt, D) => {
    const c = cropOf(x.crop);
    if (!est || est === "raw") return A.colorFromPixels(c.d, c.w, c.h);
    const white = x.est[est] && x.est[est].white; if (!white) return A.colorFromPixels(c.d, c.w, c.h);
    const cct = CC.cct(white), night = cct < 4500;
    if (adapt === "gains") { const s = CC.linToSrgb(white.map((v) => v / Math.max(...white))), mx = Math.max(...s); const g = s.map((c) => Math.min(2.8, Math.max(0.4, 1 + (mx / Math.max(c, 1) - 1) * D))); return A.colorFromPixels(c.d, c.w, c.h, { gains: g, night }); }
    return A.colorFromPixels(c.d, c.w, c.h, { matrix: CC.adaptMatrix(white, adapt, D), night });
  };
  const judge = (x, est, adapt, D) => judgeR(x, est, adapt, D).name;
  /** brightness too: the reference white's level (lane / plate / paint that agree with the fused light) → 0.75, ×1…4 */
  const judgeB = (x, est, adapt, nightRule) => { const c = cropOf(x.crop), white = x.est[est] && x.est[est].white; if (!white) return A.colorFromPixels(c.d, c.w, c.h).name;
    const k = x.lumRef ? Math.max(1, Math.min(4, 0.75 / x.lumRef)) : 1, night = nightRule === "day" ? false : CC.cct(white) < 4500;
    if (adapt === "gains") { const s = CC.linToSrgb(white.map((v) => v / Math.max(...white))), mx = Math.max(...s), kb = Math.pow(k * (CC.lum(white) / Math.max(...white)), 1 / 2.4);
      return A.colorFromPixels(c.d, c.w, c.h, { gains: s.map((v) => Math.min(4, Math.max(0.4, (mx / Math.max(v, 1)) * kb))), night }).name; }
    return A.colorFromPixels(c.d, c.w, c.h, { matrix: CC.brighten(CC.adaptMatrix(white, adapt, 1), white, x.lumRef), night }).name; };
  const acc = (rows, f) => { let s = 0, l = 0; for (const x of rows) { const g = f(x), alt = x.alt || []; if (okStrict(g, x.color) || alt.includes(g)) s++; if (okLenient(g, x.color) || alt.includes(g)) l++; } return { strict: +(100 * s / rows.length).toFixed(1), lenient: +(100 * l / rows.length).toFixed(1), n: rows.length }; };
  const colour = { raw: acc(items, (x) => judge(x, "raw")) };
  for (const est of ["paint", "learnedCal", "fusion", "fusionNoPaint"]) for (const ad of ["gains", "gains-linear", "bradford", "cat16"]) for (const D of [1, 0.7]) colour[est + "|" + ad + "|D" + D] = acc(items, (x) => judge(x, est, ad, D));
  for (const est of ["paint", "learnedCal", "fusion", "fusionNoPaint"]) for (const ad of ["gains", "gains-linear", "bradford", "cat16"]) colour[est + "|" + ad + "|D1|bright"] = acc(items, (x) => judgeB(x, est, ad, "night"));
  colour["fusion|cat16|D1|bright-dayrules"] = acc(items, (x) => judgeB(x, "fusion", "cat16", "day"));
  { const cr = res.ceil; colour.ceilingDaylightOriginal = acc(items.filter((x, i, a) => a.findIndex((y) => y.src === x.src) === i), (x) => { const c = cropOf(cr[x.src]); return A.colorFromPixels(c.d, c.w, c.h).name; }); }
  const byLight = {}; for (const L of [...new Set(items.map((x) => x.light))]) { const r = items.filter((x) => x.light === L); byLight[L] = { raw: acc(r, (x) => judge(x, "raw")).strict, current: acc(r, (x) => judge(x, "paint", "gains", 1)).strict, fusionCat16: acc(r, (x) => judge(x, "fusion", "cat16", 1)).strict, fusionBradford: acc(r, (x) => judge(x, "fusion", "bradford", 1)).strict, gainsBright: acc(r, (x) => judgeB(x, "fusion", "gains", "night")).strict, bradfordBright: acc(r, (x) => judgeB(x, "fusion", "bradford", "night")).strict, cat16Bright: acc(r, (x) => judgeB(x, "fusion", "cat16", "night")).strict }; }
  // ── pass 2: CLIP colour on raw and on the corrected crop (fusion + CAT16) ──
  let clip = null;
  if (process.env.CLIP !== "0") {
    const jobs = items.map((x) => ({ file: x.file, box: x.box, cls: x.cls, M: x.est.fusion ? CC.brighten(CC.adaptMatrix(x.est.fusion.white, "cat16", 1), x.est.fusion.white, x.lumRef) : null }));
    const cr = await p.evaluate(async (jobs) => {
      const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error(src)); i.src = src; });
      const LIN = TDC.cc.LIN, enc = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
      const mk = (img, b, M) => { const iw = img.naturalWidth, ih = img.naturalHeight, pad = 0.06, x = Math.max(0, (b.x - b.w * pad) * iw), y = Math.max(0, (b.y - b.h * pad) * ih), w = Math.min(iw - x, b.w * (1 + 2 * pad) * iw), h = Math.min(ih - y, b.h * (1 + 2 * pad) * ih);
        const c = document.createElement("canvas"); c.width = c.height = 224; const k = c.getContext("2d", { willReadFrequently: true }), s = 224 / Math.max(w, h), dw = w * s, dh = h * s;
        k.fillStyle = "rgb(124,116,104)"; k.fillRect(0, 0, 224, 224); k.drawImage(img, x, y, w, h, (224 - dw) / 2, (224 - dh) / 2, dw, dh);
        if (M) { const id = k.getImageData(0, 0, 224, 224), d = id.data; for (let i = 0; i < d.length; i += 4) { const r = LIN[d[i]], g = LIN[d[i + 1]], bb = LIN[d[i + 2]]; d[i] = enc(M[0][0] * r + M[0][1] * g + M[0][2] * bb); d[i + 1] = enc(M[1][0] * r + M[1][1] * g + M[1][2] * bb); d[i + 2] = enc(M[2][0] * r + M[2][1] * g + M[2][2] * bb); } k.putImageData(id, 0, 0); }
        return c; };
      if (TDC.search.clip.load) await TDC.search.clip.load();
      const o = [], t0 = performance.now(); let n = 0;
      for (const j of jobs) { const img = await load("cc-data/" + j.file); const a = await TDC.cc.clipColour(mk(img, j.box, null), j.cls); const b2 = j.M ? await TDC.cc.clipColour(mk(img, j.box, j.M), j.cls) : a; n += 2; o.push({ raw: a, fixed: b2 }); }
      return { o, ms: (performance.now() - t0) / n };
    }, jobs);
    items.forEach((x, i) => { x.clip = cr.o[i]; });
    const pix = (x, est) => { const c = cropOf(x.crop), white = est && x.est[est] && x.est[est].white; return white ? A.colorFromPixels(c.d, c.w, c.h, { matrix: CC.brighten(CC.adaptMatrix(white, "cat16", 1), white, x.lumRef), night: CC.cct(white) < 4500 }) : A.colorFromPixels(c.d, c.w, c.h); };
    clip = { msPerCrop: Math.round(cr.ms),
      rawPixels: acc(items, (x) => pix(x, null).name), rawClip: acc(items, (x) => x.clip.raw.name), rawFused: acc(items, (x) => CC.fuseColour(pix(x, null), x.clip.raw).name),
      fixedPixels: acc(items, (x) => pix(x, "fusion").name), fixedClip: acc(items, (x) => x.clip.fixed.name), fixedFused: acc(items, (x) => CC.fuseColour(pix(x, "fusion"), x.clip.fixed).name) };
    for (const wc of [0.3, 0.7]) clip["fixedFused_w" + wc] = acc(items, (x) => CC.fuseColour(pix(x, "fusion"), x.clip.fixed, wc).name);
  }
  // ── real night photos: colour only (no light truth, no mirrors) ──
  let night = null;
  if (NIGHT) {
    const rows = NIGHT.items.map((it, i) => ({ ...it, ...res.nout[i] })).filter((x) => !x.none);
    for (const x of rows) { x.est.learnedCal = { white: CC.mat.mv(calAll, x.est.learned.raw).map((v) => Math.max(1e-4, v)), conf: x.est.learned.conf }; x.est.fusionNoPaint = CC.fuse({ lane: x.est.lane, learned: x.est.learnedCal, greyworld: x.est.greyworld }); }
    for (const x of rows) x.lumRef = x.est.lane && x.est.lane.conf > 0.3 ? CC.lum(x.est.lane.white) : null;
    night = { n: rows.length, raw: acc(rows, (x) => judge(x, "raw")) };
    for (const est of ["learnedCal", "fusionNoPaint", "greyworld"]) for (const ad of ["gains", "bradford", "cat16"]) night[est + "|" + ad + "|bright"] = acc(rows, (x) => judgeB(x, est, ad, "night"));
    for (const est of ["learnedCal", "fusionNoPaint", "greyworld"]) for (const ad of ["gains", "bradford", "cat16"]) night[est + "|" + ad] = acc(rows, (x) => judge(x, est, ad, 1));
    night.rows = rows.map((x) => ({ file: x.file, truth: x.color, raw: judge(x, "raw"), fusionCat16: judge(x, "fusionNoPaint", "cat16", 1), learnedCat16: judge(x, "learnedCal", "cat16", 1), fusionCat16Bright: judgeB(x, "fusionNoPaint", "cat16", "night"), lane: !!x.lumRef, K: x.est.fusionNoPaint ? CC.cct(x.est.fusionNoPaint.white) : null }));
  }
  const med = (a) => a.slice().sort((p, q) => p - q)[a.length >> 1];
  const speed = { fc4LoadMs: Math.round(res.loadMs), fc4MsMedian: Math.round(med(items.map((x) => x.fc4Ms))), refsMsMedian: +med(items.map((x) => x.refMs)).toFixed(1), yoloBoxesMs: Math.round(res.detMs), modelBytes: fs.statSync(path.join(__dirname, "../models/cc/fc4-squeezenet11-int8.onnx")).size };
  const report = { n: items.length, illum, colour, byLight, clip, night, speed, calAll, pageErrors: errs };
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ illum, speed, pageErrors: errs }));
  console.log("COLOUR", JSON.stringify(colour)); console.log("BYLIGHT", JSON.stringify(byLight)); console.log("CLIP", JSON.stringify(clip)); if (night) console.log("NIGHT", JSON.stringify(night));
  console.log("CAL_ALL", JSON.stringify(calAll.map((r) => r.map((v) => +v.toFixed(4)))));
  await b.close();
})().catch((e) => { console.error(e); process.exit(2); });
