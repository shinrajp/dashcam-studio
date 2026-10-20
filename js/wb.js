/* wb.js — live white balance for the viewer (tags white-balance, wb-real).
 * The car is white and each mirror (repeater) camera sees a sliver of the car body along its OUTER edge: the left
 * repeater along the far LEFT of its image, the right repeater along the far RIGHT, widening toward the bottom. At night
 * that paint is a dim grey/beige sliver lit by the streetlight. Its colour, followed over several frames, gives the
 * colour of the light (the "white point"). A partial correction (~70 %) is applied to the camera VIDEOS in the viewer:
 *   - an SVG feColorMatrix filter (per-channel gains) on the <video> elements, or
 *   - on Safari / iOS: brightness() on the video + a multiply-blend tint layer just above it.
 * Overlays keep their own colours; export, detection and search read raw frames (drawImage ignores CSS filters).
 * Finding the body: the body sits still in the image while the world moves past, and it ends at a dark, sharp
 * edge (the fender line) that also stays put. Over the sampled frames each grid cell near the outer edge keeps a
 * running mean and variance; per row the body runs from the image edge to the first cell that is a STATIC edge
 * (low temporal variance + a dark valley / strong gradient in the mean image). Rows are median-smoothed into one
 * connected region touching the edge. Until that is confident, a default wedge-shaped sliver is used; a learned
 * body shape is remembered per camera. Settings > White balance: strength, strip width, edge side per camera,
 * "Show sample area". */
(function () {
  "use strict";
  const T = window.TDC;
  const WB = (T.wb = {});
  const $ = (id) => document.getElementById(id);

  // ── tunable constants ──
  WB.C = {
    STRENGTH: 0.7,          // default share of the full correction (Settings > Strength)
    HZ: 4.5,                // samples per second
    SIDE: { left_repeater: "left", right_repeater: "right" },   // the body's edge of each camera's image (outer edge)
    ZONE_W: 0.14,           // default search strip width (fraction of the image width, Settings > Strip width)
    ZONE_Y0: 0.12,          // the strip starts this far down (the very top is sky / the label)
    GW: 32, GH: 64,         // the strip is downscaled to GW × GH cells
    WEDGE: { y0: 0.18, w0: 0.012, w1: 0.07 },   // default sliver: from y0 down, width w0 → w1 of the image width
    PCT: [0.60, 0.95],      // white point = mean of the 60–95th luminance percentile of the body pixels
    MIN_CELLS: 12,          // fewer usable body cells = paint not seen
    CLIP: 250,              // any channel ≥ CLIP is clipped: ignored
    DARK_ABS: 6, DARK_REL: 0.2,     // body cells darker than max(DARK_ABS, DARK_REL × scene median) are ignored
    PAINT_ABS: 10, PAINT_REL: 0.3,  // "paint seen" needs its 60–95 % luminance ≥ max(PAINT_ABS, PAINT_REL × scene median)
    BLACK: 3,               // a strip whose brightest cell is below this is a blank frame (hidden video)
    OUTLIER: 0.18, MAX_SPREAD: 0.16,  // log-chroma trimming / "not one painted surface"
    MAX_CHROMA: 1.0,        // a "white" farther than this from neutral (log units) is not believable paint
    RED_RG: 2.1, GREEN_RG: 0.8, GREEN_BG: 1.0,   // hue gate for lamp reflections
    JUMP: 0.22, JUMP_ACCEPT: 14,   // per-camera chroma-jump rejection (unless it lasts ~3 s)
    EMA: 0.25,              // smoothing weight of a new sample
    LOST_MS: 8000,          // paint unseen this long → correction fades back to none
    GAIN_MIN: 0.65, GAIN_MAX: 1.7,   // clamp: the paint isn't perfectly neutral, never over-correct
    // body mask
    MASK_ALPHA: 0.12,       // running mean / variance weight per new frame
    MASK_MIN_FRAMES: 8,     // distinct frames before a mask can be trusted
    MOVE_STD: 2.5,          // the scene must move (median temporal std of the inner cells, 0–255) to learn
    EDGE_STATIC: 0.6,       // an edge cell's std must be ≤ this × the scene's std (it doesn't move)
    EDGE_MIN: 10,           // …and be a dark valley or step of at least this many levels in the mean image
    VALLEY: 0.75,           // valley: mean < VALLEY × the brighter neighbours on both sides
    ROWS_MIN: 0.3,          // confident when an edge is found in ≥ 30 % of the rows…
    ROW_JUMP: 4,            // …and neighbouring rows' widths differ by ≤ this many cells (a smooth curve)
    // colour classification (vehicle colour in searches and live labels; tag wb-color)
    CLASSIFY_STRENGTH: 1.0, // FULL correction for recognition (the viewer uses ~70 % for looks): see WB.classifyGains
    CLASSIFY_GAIN: [0.4, 2.8],   // wider clamp than the viewer: a 3000 K white needs ~2.2× blue to read as white
    WINDOW: 4,              // s: one white-point estimate per window of the event during a search scan
    HIST_NEAR: 2,           // s: a live (smoothed) estimate this close in time is used instead
    PROBE: [-1, -0.6, -0.2, 0, 0.2, 0.6, 1],   // s: frames around t read from each mirror for that estimate
    BODY_REL: 0.17,         // …and the body must be static: median std of each cell's brightness relative to the body's
  };
  const KEY = "tdc.wb.v1", MODE_KEY = "tdc.wb.mode", CFG_KEY = "tdc.wb.cfg.v1", MASK_KEY = "tdc.wb.mask.v1";
  const REP = ["left_repeater", "right_repeater"];
  // user settings: strength, strip width, edge side per camera ("auto" | "left" | "right"), show the sample area
  WB.cfg = () => { let c = {}; try { c = JSON.parse(localStorage.getItem(CFG_KEY) || "{}") || {}; } catch (_) {} return { strength: c.strength > 0 ? Math.min(1, c.strength) : WB.C.STRENGTH, width: c.width > 0 ? c.width : WB.C.ZONE_W, side: Object.assign({ left_repeater: "auto", right_repeater: "auto" }, c.side || {}), showMask: !!c.showMask, colour: c.colour === "on" || c.colour === "off" ? c.colour : "auto" }; };
  WB.setCfg = (patch) => { const c = Object.assign(WB.cfg(), patch); if (patch.side) c.side = Object.assign(WB.cfg().side, patch.side); try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (_) {} if (patch.width || patch.side) resetZones(false); apply(); render(); drawMasks(); return c; };
  const NAME = { left_repeater: "left mirror", right_repeater: "right mirror" };

  WB.isOn = () => { try { return localStorage.getItem(KEY) === "1"; } catch (_) { return false; } };
  const ua = navigator.userAgent;
  const appleWebKit = /AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Edg|Android/.test(ua);
  WB.mode = () => { let m = null; try { m = localStorage.getItem(MODE_KEY); } catch (_) {} return m === "svg" || m === "blend" ? m : appleWebKit ? "blend" : "svg"; };

  // ── colour maths ──
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  /** CCT (K) of an sRGB white (0–255) via linear sRGB → XYZ → xy → McCamy. */
  WB.cct = (rgb) => {
    const r = lin(rgb[0]), g = lin(rgb[1]), b = lin(rgb[2]);
    const X = 0.4124 * r + 0.3576 * g + 0.1805 * b, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
    const s = X + Y + Z; if (!(s > 0)) return null;
    const x = X / s, y = Y / s, n = (x - 0.3320) / (0.1858 - y);
    return 449 * n * n * n + 3525 * n * n + 6823.3 * n + 5520.33;
  };
  WB.describe = (k, rgb) => {
    const rg = rgb ? rgb[0] / rgb[1] : 1, bg = rgb ? rgb[2] / rgb[1] : 1;
    if (k < 2300 || (rg > 1.45 && bg < 0.45)) return "Sodium streetlight";
    if (k < 3600) return "Warm streetlight";
    if (k < 4800) return "Neutral light";
    if (k < 6200) return "Cool light";
    return "Daylight";
  };
  const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  /** Per-channel gains for an sRGB white point: lerp(1, ref/white, strength), brightness kept, clamped. */
  WB.gains = (w, strength) => {
    const k = strength == null ? WB.cfg().strength : strength, ref = luma(w[0], w[1], w[2]);
    let g = w.map((c) => 1 + (ref / Math.max(c, 1) - 1) * k);
    const norm = ref / luma(w[0] * g[0], w[1] * g[1], w[2] * g[2]);
    return g.map((x) => Math.min(WB.C.GAIN_MAX, Math.max(WB.C.GAIN_MIN, x * norm)));
  };

  const med = (a) => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); return s[s.length >> 1]; };
  /** White point of the body cells. img: {data (RGBA), width, height} oriented so column 0 = the image edge;
   *  runs[y] = body width (cells) in row y (null = every cell); sceneY = scene median luminance (adaptive thresholds).
   *  → {blank} | {found:false, why} | {found:true, rgb, n, rejectedHue, y} */
  WB.analyse = (img, runs, sceneY) => {
    const C = WB.C, d = img.data, W = img.width, H = img.height, px = [];
    let max = 0, all = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, l = luma(d[i], d[i + 1], d[i + 2]); if (l > max) max = l; all.push(l); }
    if (max < C.BLACK) return { blank: true };
    const sY = sceneY != null ? sceneY : med(all);
    const dark = Math.max(C.DARK_ABS, C.DARK_REL * sY);
    let rejectedHue = 0, clipped = 0;
    for (let y = 0; y < H; y++) {
      const n = runs ? runs[y] | 0 : W;
      for (let x = 0; x < Math.min(n, W); x++) {
        const i = (y * W + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
        if (r >= C.CLIP || g >= C.CLIP || b >= C.CLIP) { clipped++; continue; }
        const l = luma(r, g, b); if (l < dark) continue;
        const rg = r / Math.max(g, 1), bg = b / Math.max(g, 1);
        if (rg > C.RED_RG || (rg < C.GREEN_RG && bg < C.GREEN_BG)) { rejectedHue++; continue; }   // lamp reflection
        px.push([l, r, g, b]);
      }
    }
    if (px.length < C.MIN_CELLS) return { found: false, why: px.length + rejectedHue + clipped < C.MIN_CELLS ? "dark" : rejectedHue > clipped ? "hue" : "clipped", rejectedHue, n: px.length };
    px.sort((a, b) => a[0] - b[0]);
    const cand = px.slice(Math.floor(px.length * C.PCT[0]), Math.max(Math.floor(px.length * C.PCT[0]) + 1, Math.ceil(px.length * C.PCT[1])));
    const yP = cand.reduce((s, p) => s + p[0], 0) / cand.length;
    if (yP < Math.max(C.PAINT_ABS, C.PAINT_REL * sY)) return { found: false, why: "dark", rejectedHue, y: yP };
    const lc = cand.map(([, r, g, b]) => [Math.log(Math.max(r, 1) / Math.max(g, 1)), Math.log(Math.max(b, 1) / Math.max(g, 1))]);
    const m = [med(lc.map((v) => v[0])), med(lc.map((v) => v[1]))];
    const dist = lc.map((v) => Math.hypot(v[0] - m[0], v[1] - m[1]));
    if (med(dist) > C.MAX_SPREAD) return { found: false, why: "scattered", rejectedHue };
    let R = 0, G = 0, B = 0, n = 0;
    cand.forEach((p, i) => { if (dist[i] <= C.OUTLIER) { R += p[1]; G += p[2]; B += p[3]; n++; } });
    if (n < Math.max(4, cand.length / 3)) return { found: false, why: "scattered", rejectedHue };
    const rgb = [R / n, G / n, B / n];
    if (Math.hypot(Math.log(rgb[0] / rgb[1]), Math.log(rgb[2] / rgb[1])) > C.MAX_CHROMA) return { found: false, why: "too coloured", rejectedHue, rgb };
    return { found: true, rgb, n, rejectedHue, y: yP };
  };

  // ── body mask from temporal statistics ──
  /** Default wedge-shaped sliver: body width (cells) per row of a strip of width zw (fraction of the image). */
  WB.wedge = (zw) => {
    const C = WB.C, W = C.WEDGE, out = new Int16Array(C.GH);
    for (let y = 0; y < C.GH; y++) { const iy = C.ZONE_Y0 + (1 - C.ZONE_Y0) * (y + 0.5) / C.GH; if (iy < W.y0) continue; const f = W.w0 + (W.w1 - W.w0) * (iy - W.y0) / (1 - W.y0); out[y] = Math.max(1, Math.min(C.GW, Math.round((f / zw) * C.GW))); }
    return out;
  };
  WB.newZone = () => { const n = WB.C.GW * WB.C.GH; return { n: 0, mean: new Float32Array(n), vr: new Float32Array(n), runs: null, conf: false, moving: false, sceneStd: 0, sceneY: 0, rowsFound: 0, noBody: false, img: null }; };
  /** Feed one oriented strip image into a zone's running mean / variance. */
  WB.feedZone = (Z, img) => {
    const C = WB.C, d = img.data, n = C.GW * C.GH, a = Math.max(C.MASK_ALPHA, 1 / (Z.n + 1));
    for (let i = 0; i < n; i++) {
      const l = luma(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
      if (!Z.n) { Z.mean[i] = l; Z.vr[i] = 0; continue; }
      const dl = l - Z.mean[i]; Z.mean[i] += a * dl; Z.vr[i] = (1 - a) * (Z.vr[i] + a * dl * dl);
    }
    Z.n++; Z.img = img;
  };
  /** Find the body: per row, from the image edge to the first static edge cell. */
  WB.maskZone = (Z) => {
    const C = WB.C, GW = C.GW, GH = C.GH, M = Z.mean, sd = (i) => Math.sqrt(Z.vr[i]);
    const inner = []; for (let y = 0; y < GH; y++) for (let x = GW >> 1; x < GW; x++) inner.push(sd(y * GW + x));
    Z.sceneStd = med(inner); Z.sceneY = med(Array.from(M)); Z.moving = Z.sceneStd > C.MOVE_STD;
    if (Z.n < C.MASK_MIN_FRAMES || !Z.moving) { Z.conf = false; return Z; }
    const raw = new Int16Array(GH).fill(-1), thr = Math.max(1.0, C.EDGE_STATIC * Z.sceneStd);
    for (let y = 0; y < GH; y++) {
      const r = y * GW;
      for (let x = 1; x < GW - 2; x++) {
        const i = r + x; if (sd(i) > thr) continue;
        const L = Math.max(M[i - 1], x > 1 ? M[i - 2] : M[i - 1]), R = Math.max(M[i + 1], M[i + 2]);
        const valley = M[i] < C.VALLEY * Math.min(L, R) && Math.min(L, R) - M[i] >= C.EDGE_MIN;
        const step = Math.abs(M[i + 1] - M[i - 1]) >= 2 * C.EDGE_MIN && sd(i - 1) <= thr;   // static step: body side static too
        if (valley || step) { raw[y] = x; break; }
      }
    }
    // smooth: median of 5 rows over the found rows, fill gaps by interpolation, keep one connected run per row
    const found = []; for (let y = 0; y < GH; y++) if (raw[y] > 0) found.push(y);
    Z.rowsFound = found.length / GH;
    const runs = new Int16Array(GH);
    if (found.length) {
      const sm = (y) => { const v = []; for (let k = -2; k <= 2; k++) if (raw[y + k] > 0) v.push(raw[y + k]); return v.length ? med(v) : -1; };
      const pts = found.map((y) => [y, sm(y)]);
      // drop rows that jump away from the smoothed curve (a moving edge that was briefly static)
      const good = pts.filter(([y, v]) => Math.abs(raw[y] - v) <= C.ROW_JUMP);
      for (let y = 0; y < GH; y++) {
        let a = null, b = null; for (const p of good) { if (p[0] <= y) a = p; if (p[0] >= y && !b) b = p; }
        if (a && b) runs[y] = Math.round(a[0] === b[0] ? a[1] : a[1] + (b[1] - a[1]) * (y - a[0]) / (b[0] - a[0]));
        else if (b && !a) runs[y] = 0;                  // above the first edge: no body (sky / top of the fender)
        else if (a && !b) runs[y] = a[1];               // below the last edge: keep the width (bottom of the image)
      }
      Z.rowsGood = good.length / GH;
    } else Z.rowsGood = 0;
    let jumps = 0; for (let y = 1; y < GH; y++) if (Math.abs(runs[y] - runs[y - 1]) > C.ROW_JUMP) jumps++;
    Z.conf = Z.rowsGood >= C.ROWS_MIN && jumps <= 2 && runs.some((v) => v > 0);
    Z.noBody = Z.n >= 2 * C.MASK_MIN_FRAMES && Z.rowsFound < 0.08;   // the world moves and nothing static at the edge
    if (Z.conf) Z.runs = runs;
    return Z;
  };

  // ── running estimate (log-chroma EMA with jump rejection) ──
  const st = (WB.state = { est: null, lum: 0, jumps: 0, lastSeen: 0, cams: [], samples: 0, accepted: 0, rejected: 0, raw: null, camJumps: {} });
  WB.reset = () => { st.est = null; st.lum = 0; st.jumps = 0; st.lastSeen = 0; st.cams = []; st.samples = st.accepted = st.rejected = 0; st.raw = null; st.camJumps = {}; apply(); render(); };
  /** Feed one measurement (sRGB white, or null when not seen). Returns "init" | "ok" | "jump" | "accept-jump" | "none". */
  WB.update = (rgb, now) => {
    now = now == null ? performance.now() : now;
    st.samples++;
    if (!rgb) { if (st.est && now - st.lastSeen > WB.C.LOST_MS) { st.est = null; st.jumps = 0; } return "none"; }
    const c = [Math.log(rgb[0] / rgb[1]), Math.log(rgb[2] / rgb[1])];
    st.raw = c; st.lastSeen = now;
    if (!st.est) { st.est = c; st.jumps = 0; st.accepted++; return "init"; }
    const d = Math.hypot(c[0] - st.est[0], c[1] - st.est[1]);
    if (d > WB.C.JUMP) {
      if (++st.jumps < WB.C.JUMP_ACCEPT) { st.rejected++; return "jump"; }
      st.est = c; st.jumps = 0; st.accepted++; return "accept-jump";
    }
    st.jumps = 0; st.accepted++;
    const a = WB.C.EMA; st.est = [st.est[0] + a * (c[0] - st.est[0]), st.est[1] + a * (c[1] - st.est[1])];
    return "ok";
  };
  /** Current smoothed white point as sRGB (green = 200), or null. */
  WB.white = () => { if (!st.est) return null; const w = [Math.exp(st.est[0]), 1, Math.exp(st.est[1])], k = 230 / Math.max(w[0], w[1], w[2]); return w.map((v) => v * k); };   // brightest channel = 230
  WB.current = () => { const w = WB.white(); if (!w) return null; const k = WB.cct(w); return { white: w, cct: k, label: WB.describe(k, w), gains: WB.gains(w), cams: st.cams.slice() }; };

  // ── rendering the correction ──
  let svgM = null;
  function ensureSvg() {
    if (svgM) return;
    const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", "0"); svg.setAttribute("height", "0"); svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    const f = document.createElementNS(ns, "filter"); f.id = "tdcWb"; f.setAttribute("color-interpolation-filters", "sRGB");
    f.setAttribute("x", "0"); f.setAttribute("y", "0"); f.setAttribute("width", "1"); f.setAttribute("height", "1");
    svgM = document.createElementNS(ns, "feColorMatrix"); svgM.setAttribute("type", "matrix");
    f.appendChild(svgM); svg.appendChild(f); document.body.appendChild(svg);
  }
  const fmt = (x) => x.toFixed(4);
  function targets() {
    const P = T.player, out = [];
    if (P && P.tiles) for (const cam of Object.keys(P.tiles)) { const t = P.tiles[cam]; out.push({ host: t.tile, after: t.vids[t.vids.length - 1], media: t.vids }); }
    const pc = $("panoCanvas"); if (pc) out.push({ host: pc.parentElement, after: pc, media: [pc] });
    return out;
  }
  WB.applied = null;
  function apply() {
    const cur = WB.isOn() && WB.current();
    const g = cur ? cur.gains : null, mode = WB.mode();
    WB.applied = g ? { gains: g, mode } : null;
    document.body.classList.toggle("wb-on", !!g);
    if (g && mode === "svg") {
      ensureSvg();
      svgM.setAttribute("values", `${fmt(g[0])} 0 0 0 0  0 ${fmt(g[1])} 0 0 0  0 0 ${fmt(g[2])} 0 0  0 0 0 1 0`);
    }
    const mx = g ? Math.max(g[0], g[1], g[2]) : 1;
    for (const t of targets()) {
      let tint = t.host.querySelector(":scope > .wb-tint");
      if (g && mode === "blend") {
        if (!tint) { tint = document.createElement("div"); tint.className = "wb-tint"; tint.setAttribute("aria-hidden", "true"); t.after.after(tint); }
        tint.style.background = `rgb(${g.map((x) => ((255 * x) / mx).toFixed(2)).join(",")})`;
        tint.hidden = false;
      } else if (tint) tint.hidden = true;
      for (const m of t.media) m.style.filter = !g ? "" : mode === "svg" ? "url(#tdcWb)" : mx > 1.001 ? `brightness(${mx.toFixed(4)})` : "";
    }
  }
  WB.apply = apply;

  // ── readout + toggle ──
  WB.text = () => {
    if (!WB.isOn()) return "";
    const ev = T.player && T.player.ev;
    if (ev && ev.cams && !ev.cams.some((c) => c === "left_repeater" || c === "right_repeater")) return "No mirror cameras in this event";
    const cur = WB.current();
    if (!cur || !st.cams.length && performance.now() - st.lastSeen > 1500) return "Looking for your white paint in the mirror cameras";
    const where = st.cams.length === 2 ? "both mirrors" : st.cams.length === 1 ? NAME[st.cams[0]] : "held";
    return `${Math.round(cur.cct / 100) * 100} K · ${cur.label} · ${where}`;
  };
  function render() {
    const on = WB.isOn(), b = $("chipWb"), r = $("wbReadout");
    if (b) { b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); }
    if (r) { const s = WB.text(); r.textContent = s; r.hidden = !on || !s || !(T.player && T.player.ev); }
  }
  WB.render = render;
  WB.set = (on) => {
    try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (_) {}
    if (!on) { apply(); drawMasks(); } else tick(true);
    render(); schedule();
  };
  WB.toggle = () => WB.set(!WB.isOn());

  // ── sampling loop ──
  let cv = null, cx = null, timer = 0, lastKey = "";
  const zones = {};          // "cam:side" → zone stats
  WB.zones = zones;
  const sides = (cam) => { const c = WB.cfg().side[cam]; return c === "left" || c === "right" ? [c] : [WB.C.SIDE[cam], WB.C.SIDE[cam] === "left" ? "right" : "left"]; };
  function loadMasks() { try { return JSON.parse(localStorage.getItem(MASK_KEY) || "{}") || {}; } catch (_) { return {}; } }
  const saveAt = {};
  function saveMask(cam, side, runs, zw) { const now = performance.now(); if (now - (saveAt[cam] || -1e9) < 4000) return; saveAt[cam] = now; const m = loadMasks(); m[cam] = { side, zw, runs: Array.from(runs), at: Date.now() }; try { localStorage.setItem(MASK_KEY, JSON.stringify(m)); } catch (_) {} }
  WB.forgetMasks = () => { try { localStorage.removeItem(MASK_KEY); } catch (_) {} resetZones(true); drawMasks(); };
  function resetZones() { for (const k of Object.keys(zones)) delete zones[k]; }
  /** The strip along one edge of a camera's frame, oriented so column 0 = the image edge. */
  function strip(cam, side) {
    const P = T.player, t = P && P.tiles && P.tiles[cam];
    const v = t && t.vids[P.active];
    if (!v || !v._url || v.readyState < 2 || !v.videoWidth) return null;
    return stripOf(v, side);
  }
  function stripOf(v, side) {
    const C = WB.C, zw = WB.cfg().width, vw = v.videoWidth, vh = v.videoHeight;
    if (!cv) { cv = document.createElement("canvas"); cv.width = C.GW; cv.height = C.GH; cx = cv.getContext("2d", { willReadFrequently: true }); }
    try {
      cx.drawImage(v, side === "left" ? 0 : (1 - zw) * vw, C.ZONE_Y0 * vh, zw * vw, (1 - C.ZONE_Y0) * vh, 0, 0, C.GW, C.GH);
      const im = cx.getImageData(0, 0, C.GW, C.GH);
      if (side === "right") { const d = im.data, W = C.GW; for (let y = 0; y < C.GH; y++) for (let x = 0; x < W >> 1; x++) { const a = (y * W + x) * 4, b = (y * W + W - 1 - x) * 4; for (let k = 0; k < 4; k++) { const tmp = d[a + k]; d[a + k] = d[b + k]; d[b + k] = tmp; } } }
      return im;
    } catch (_) { return null; }
  }
  /** Which body shape to use for a camera now: learned (this clip) > remembered (stored) > default sliver. */
  WB.maskFor = (cam) => {
    const C = WB.C, zw = WB.cfg().width, list = sides(cam);
    for (const side of list) { const Z = zones[cam + ":" + side]; if (Z && Z.conf && Z.runs) return { side, runs: Z.runs, source: "learned", Z }; }
    const m = loadMasks()[cam];
    if (m && list.includes(m.side) && Math.abs(m.zw - zw) < 1e-6 && m.runs && m.runs.length === C.GH) return { side: m.side, runs: Int16Array.from(m.runs), source: "remembered", Z: zones[cam + ":" + m.side] };
    const side = list[0];
    return { side, runs: WB.wedge(zw), source: "default sliver", Z: zones[cam + ":" + side] };
  };
  WB.sampleNow = (fresh) => {
    const seen = [], whites = [];
    WB.last = {};
    let blank = 0, noBody = 0, present = 0;
    const ev = T.player && T.player.ev;
    for (const cam of REP) {
      if (ev && ev.cams && !ev.cams.includes(cam)) continue;
      present++;
      let gotAny = false, allBlank = true;
      for (const side of sides(cam)) {
        const img = strip(cam, side); if (!img) continue;
        gotAny = true;
        let mx = 0; for (let i = 0; i < img.data.length; i += 4) mx = Math.max(mx, img.data[i], img.data[i + 1], img.data[i + 2]);
        if (mx < WB.C.BLACK) continue;
        allBlank = false;
        const key = cam + ":" + side, Z = zones[key] || (zones[key] = WB.newZone());
        if (fresh !== false) { WB.feedZone(Z, img); WB.maskZone(Z); } else Z.img = img;
        if (Z.conf && Z.runs) saveMask(cam, side, Z.runs, WB.cfg().width);
      }
      if (!gotAny || allBlank) { blank++; continue; }   // not decoded yet (seeking) or a hidden video's blank frame
      const mk = WB.maskFor(cam), Z = mk.Z;
      if (!Z || !Z.img) { blank++; continue; }
      if (mk.source !== "learned" && Z.noBody && sides(cam).every((sd) => { const z = zones[cam + ":" + sd]; return z && z.noBody; })) { WB.last[cam] = { found: false, why: "no body at the edge", side: mk.side, source: mk.source }; noBody++; continue; }
      const a = WB.analyse(Z.img, mk.runs, Z.n >= WB.C.MASK_MIN_FRAMES ? Z.sceneY : null);
      Object.assign(a, { cam, side: mk.side, source: mk.source, cells: mk.runs.reduce((s, v) => s + v, 0) });
      WB.last[cam] = a;
      if (a.blank) { blank++; continue; }
      if (!a.found) continue;
      // per-camera chroma-jump rejection against the running estimate (a lamp reflection on ONE mirror)
      if (st.est) {
        const d = Math.hypot(Math.log(a.rgb[0] / a.rgb[1]) - st.est[0], Math.log(a.rgb[2] / a.rgb[1]) - st.est[1]);
        a.jump = d;
        if (d > WB.C.JUMP && (st.camJumps[cam] = (st.camJumps[cam] || 0) + 1) < WB.C.JUMP_ACCEPT) { a.rejected = "jump"; st.rejected++; continue; }
      }
      st.camJumps[cam] = 0;
      seen.push(cam); whites.push(a.rgb);
    }
    if (!whites.length && blank) return "blank";
    if (!whites.length && Object.values(WB.last).some((a) => a.rejected)) return "jump";   // only a rejected lamp flash: hold
    if (!whites.length && present && noBody === present) { st.est = null; st.cams = []; st.camJumps = {}; drawMasks(); return "no-body"; }   // the world moves past both edges and no car body is there: nothing to measure
    let rgb = null;
    if (whites.length) { const l = whites.map((w) => [Math.log(w[0] / w[1]), Math.log(w[2] / w[1])]); const m = [0, 1].map((k) => l.reduce((s, v) => s + v[k], 0) / l.length); rgb = [Math.exp(m[0]), 1, Math.exp(m[1])]; }
    const r = WB.update(rgb);
    st.cams = r === "jump" ? st.cams : seen;
    if (st.est && rgb && ev) remember(ev, T.player.time, st.est, st.cams);
    drawMasks();
    return r;
  };

  // ── white point for colour classification (tag wb-color) ──
  // Vehicle colour (vehicle-attrs.js) is read from raw frames; under a warm streetlight a white bus reads brown / beige.
  // When a white point is known for that moment, the crop is corrected first. Where it comes from:
  //   1. the live, smoothed viewer estimate within ±HIST_NEAR s of that time (recorded while white balance samples), else
  //   2. one estimate per WINDOW s of the event, measured on demand from both mirror cameras' frames at that time
  //      (own hidden video, so it never disturbs the frame being classified), with the learned / remembered body shape
  //      or the default sliver. No jump rejection there (a single frame), but the hue gate still drops lamp pixels.
  // Setting "Colour search uses white balance": auto (default: whenever a white point is found, even with the viewer
  // toggle off) / on (also falls back to the viewer's last estimate) / off (raw pixels, as before).
  const hist = new Map();    // event id → [{t, est, cams}] (live estimates, time-sorted on use)
  function remember(ev, t, est, cams) {
    if (!(t >= 0)) return;
    const id = ev.id || ev.name || ""; let a = hist.get(id); if (!a) hist.set(id, (a = []));
    const last = a[a.length - 1];
    if (last && Math.abs(last.t - t) < 0.2) { last.est = est.slice(); last.cams = cams.slice(); return; }
    a.push({ t, est: est.slice(), cams: cams.slice() }); if (a.length > 4000) a.splice(0, a.length - 4000);
  }
  function nearestHist(ev, t) {
    const a = hist.get(ev.id || ev.name || ""); if (!a || !a.length) return null;
    let best = null; for (const h of a) if (!best || Math.abs(h.t - t) < Math.abs(best.t - t)) best = h;
    return best && Math.abs(best.t - t) <= WB.C.HIST_NEAR ? best : null;
  }
  WB.colourMode = () => WB.cfg().colour;
  /** Gains used for COLOUR CLASSIFICATION: the viewer's formula at CLASSIFY_STRENGTH (100 %), but scaled so the white
   *  maps to its own brightest channel (not to its luminance): colour names depend on brightness (white / silver / gray),
   *  and keeping the luminance of a warm white would push it down to "silver". Clamped to CLASSIFY_GAIN. */
  WB.classifyGains = (w) => {
    const k = WB.C.CLASSIFY_STRENGTH, mx = Math.max(w[0], w[1], w[2]), [lo, hi] = WB.C.CLASSIFY_GAIN;
    return w.map((c) => Math.min(hi, Math.max(lo, 1 + (mx / Math.max(c, 1) - 1) * k)));
  };
  function pack(est, source, cams, t) {
    const w = [Math.exp(est[0]), 1, Math.exp(est[1])], k0 = 230 / Math.max(w[0], w[1], w[2]), white = w.map((v) => v * k0), cct = WB.cct(white);
    return { white, cct, label: WB.describe(cct, white), gains: WB.classifyGains(white), source, cams: (cams || []).slice(), t };
  }
  const wcache = new Map(), wdone = new Map();   // "event|window" → promise / resolved estimate
  let wv = null, wq = Promise.resolve();
  async function estimateAt(ev, t) {
    const P = T.player, ci = P.clipIndexAt ? P.clipIndexAt(t) : 0, clip = ev.clips && ev.clips[ci];
    if (!clip || !T.search || !T.search.seekSample) return null;
    if (!wv) wv = Object.assign(document.createElement("video"), { muted: true, playsInline: true, preload: "auto" });
    const C = WB.C, whites = [], cams = [];
    WB.lastColourProbe = {};
    for (const cam of REP) {
      const it = clip.files && clip.files[cam]; if (!it || !it.blob) continue;
      const mk0 = WB.maskFor(cam), local = Math.max(0, t - clip.start);
      // a few frames around t: the body must be STATIC while the scene moves (else the "body" is just the street),
      // and if no body shape is known yet, learn one from these frames
      const Z = WB.newZone(); let img0 = null; const ims = [];
      for (const dt of C.PROBE) {
        try { await T.search.seekSample(wv, it, Math.max(0, local + dt)); } catch (_) { continue; }
        if (!wv.videoWidth) continue;
        const im = stripOf(wv, mk0.side); if (!im) continue;
        WB.feedZone(Z, im); ims.push(im); if (dt === 0) img0 = im;
      }
      if (!img0 || Z.n < 3) continue;
      const n = Z.n; Z.n = Math.max(Z.n, C.MASK_MIN_FRAMES); WB.maskZone(Z); Z.n = n;
      let runs = mk0.runs, source = mk0.source;
      if (source === "default sliver" && Z.conf && Z.runs) { runs = Z.runs; source = "learned here"; }
      // static body: each body cell keeps its brightness RELATIVE to the whole body from frame to frame (passing lamps
      // brighten the whole body at once, but street texture slides through the sliver); median over cells of the std of
      // (cell / body median) across the frames
      let staticOk = true, bodySd = 0;
      if (Z.moving) {
        const idx = []; for (let y = 0; y < C.GH; y++) for (let x = 0; x < Math.min(runs[y] | 0, C.GW); x++) idx.push(y * C.GW + x);
        const rel = idx.map(() => []);
        for (const im of ims) {
          const L = idx.map((i) => luma(im.data[i * 4], im.data[i * 4 + 1], im.data[i * 4 + 2])), m = Math.max(1, med(L));
          L.forEach((l, k) => rel[k].push(l / m));
        }
        const sd = (a) => { const mu = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - mu) * (v - mu), 0) / a.length); };
        bodySd = idx.length ? med(rel.map(sd)) : 1;
        staticOk = idx.length >= C.MIN_CELLS && bodySd <= C.BODY_REL;
      }
      const a = staticOk ? WB.analyse(img0, runs, null) : { found: false, why: "not static (no car body)" };
      WB.lastColourProbe[cam] = { found: !!a.found, why: a.why, source, moving: Z.moving, sceneStd: +Z.sceneStd.toFixed(1), bodySd: +bodySd.toFixed(3), frames: n };
      if (a.found) { whites.push(a.rgb); cams.push(cam); }
    }
    if (!whites.length) return null;
    const l = whites.map((w) => [Math.log(w[0] / w[1]), Math.log(w[2] / w[1])]);
    return pack([0, 1].map((k) => l.reduce((s, v) => s + v[k], 0) / l.length), "mirrors at " + t.toFixed(1) + " s", cams, t);
  }
  WB.estimateAt = (t) => (T.player && T.player.ev ? estimateAt(T.player.ev, t) : Promise.resolve(null));   // on-demand, no cache (tests)
  const wkey = (ev, t) => (ev.id || ev.name || "") + "|" + Math.floor(Math.max(0, t) / WB.C.WINDOW);
  /** The white point at time t of the open event (live estimate nearby, else measured from the mirrors), or null. */
  WB.whiteAt = (t) => {
    const ev = T.player && T.player.ev; if (!ev) return Promise.resolve(null);
    const h = nearestHist(ev, t); if (h) return Promise.resolve(pack(h.est, "live", h.cams, h.t));
    const key = wkey(ev, t);
    if (!wcache.has(key)) {
      const p = (wq = wq.then(() => estimateAt(ev, t)).catch(() => null)).then((r) => { wdone.set(key, r); return r; });
      wcache.set(key, p);
    }
    return wcache.get(key);
  };
  /** For colour classification at time t: { gains, cct, label, source } or null (raw pixels), per the setting. */
  WB.colourFix = async (t) => {
    const mode = WB.colourMode(); if (mode === "off") return null;
    let r = null; try { r = await WB.whiteAt(t); } catch (_) {}
    if (!r && mode === "on" && st.est) r = pack(st.est, "viewer", st.cams);
    return r;
  };
  /** Same, without waiting (live labels): what is known now; starts a measurement for this window when none is. */
  WB.colourFixNow = (t) => {
    const mode = WB.colourMode(), ev = T.player && T.player.ev; if (mode === "off" || !ev) return null;
    const h = nearestHist(ev, t); if (h) return pack(h.est, "live", h.cams, h.t);
    const key = wkey(ev, t);
    if (wdone.has(key)) { const r = wdone.get(key); if (r) return r; }
    else if (!wcache.has(key)) WB.whiteAt(t);
    return mode === "on" && st.est ? pack(st.est, "viewer", st.cams) : null;
  };
  WB.forgetColourCache = () => { wcache.clear(); wdone.clear(); };
  /** Summary for the debug overlay / tests. */
  WB.maskInfo = () => { const out = {}; for (const cam of REP) { const m = WB.maskFor(cam), Z = m.Z; const rows = Array.from(m.runs); const used = rows.filter((v) => v > 0); out[cam] = { side: m.side, source: m.source, rowsWithBody: used.length, maxWidthPct: +((Math.max(0, ...rows) / WB.C.GW) * WB.cfg().width * 100).toFixed(1), widthTopPct: used.length ? +((used[0] / WB.C.GW) * WB.cfg().width * 100).toFixed(1) : 0, widthBottomPct: +((rows[rows.length - 1] / WB.C.GW) * WB.cfg().width * 100).toFixed(1), frames: Z ? Z.n : 0, moving: Z ? Z.moving : false, sceneStd: Z ? +Z.sceneStd.toFixed(1) : 0, rowsFound: Z ? +(Z.rowsFound || 0).toFixed(2) : 0 }; } return out; };

  // ── debug overlay: Settings > White balance > Show sample area ──
  function drawMasks() {
    const show = WB.cfg().showMask && WB.isOn(), P = T.player;
    for (const cam of REP) {
      const t = P && P.tiles && P.tiles[cam]; if (!t) continue;
      let c = t.tile.querySelector(":scope > .wb-mask-layer");
      if (!show) { if (c) c.hidden = true; continue; }
      const v = t.vids[P.active]; if (!v || !v.videoWidth) continue;
      if (!c) { c = document.createElement("canvas"); c.className = "wb-mask-layer"; c.setAttribute("aria-hidden", "true"); t.tile.appendChild(c); }
      c.hidden = false;
      const tw = t.tile.clientWidth, th = t.tile.clientHeight, dpr = Math.min(2, devicePixelRatio || 1);
      if (c.width !== Math.round(tw * dpr) || c.height !== Math.round(th * dpr)) { c.width = Math.round(tw * dpr); c.height = Math.round(th * dpr); }
      c.style.transform = v.style.transform || ""; c.style.transformOrigin = "50% 50%";
      const x = c.getContext("2d"); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, tw, th);
      const s = Math.min(tw / v.videoWidth, th / v.videoHeight), w = v.videoWidth * s, h = v.videoHeight * s, ox = (tw - w) / 2, oy = (th - h) / 2;
      const C = WB.C, zw = WB.cfg().width, m = WB.maskFor(cam), cw = (zw * w) / C.GW, ch = ((1 - C.ZONE_Y0) * h) / C.GH, y0 = oy + C.ZONE_Y0 * h;
      const X = (col) => (m.side === "left" ? ox + col * cw : ox + w - (col + 1) * cw);
      // the search strip
      x.setLineDash([5, 4]); x.strokeStyle = "rgba(255,255,255,0.7)"; x.lineWidth = 1;
      x.strokeRect(m.side === "left" ? ox + 0.5 : ox + w - zw * w + 0.5, y0 + 0.5, zw * w - 1, (1 - C.ZONE_Y0) * h - 1); x.setLineDash([]);
      // the body cells that are sampled
      x.fillStyle = m.source === "learned" ? "rgba(255,0,200,0.45)" : m.source === "remembered" ? "rgba(140,90,255,0.45)" : "rgba(255,200,0,0.4)";
      for (let r = 0; r < C.GH; r++) for (let col = 0; col < m.runs[r]; col++) x.fillRect(X(col), y0 + r * ch, cw + 0.5, ch + 0.5);
      const a = WB.last && WB.last[cam];
      const label = (m.source === "learned" ? "Body found" : m.source === "remembered" ? "Remembered body" : "Default sliver") + " · " + m.side + " edge" + (a && a.found ? "" : a ? " · " + (a.why || "no paint") : "");
      x.font = "600 11px system-ui, sans-serif"; const tw2 = x.measureText(label).width + 10, lx = m.side === "left" ? ox + 4 : ox + w - tw2 - 4, ly = oy + h - 24;
      x.fillStyle = "rgba(0,0,0,0.65)"; x.fillRect(lx, ly, tw2, 18); x.fillStyle = "#fff"; x.fillText(label, lx + 5, ly + 13);
    }
  }
  WB.drawMasks = drawMasks;

  // ── Settings > White balance ──
  function buildSettings() {
    const host = $("setWb"); if (!host) return;
    const c = WB.cfg(); host.innerHTML = "";
    const row = (label, el) => { const r = T.el ? T.el("label", "row") : document.createElement("label"); r.className = "row"; const sp = document.createElement("span"); sp.textContent = label; r.append(sp, el); host.appendChild(r); return r; };
    const range = (id, min, max, step, val, fmt, on) => { const w = document.createElement("span"); w.className = "wb-range"; const i = document.createElement("input"); i.type = "range"; i.id = id; i.min = min; i.max = max; i.step = step; i.value = val; const o = document.createElement("output"); o.textContent = fmt(val); i.addEventListener("input", () => { o.textContent = fmt(+i.value); on(+i.value); }); w.append(i, o); return w; };
    row("Strength", range("wbStrength", 0.3, 1, 0.05, c.strength, (v) => Math.round(v * 100) + "%", (v) => WB.setCfg({ strength: v })));
    row("Strip width", range("wbWidth", 0.06, 0.24, 0.01, c.width, (v) => Math.round(v * 100) + "%", (v) => WB.setCfg({ width: v })));
    for (const cam of REP) {
      const sel = document.createElement("select"); sel.id = cam === "left_repeater" ? "wbSideLeft" : "wbSideRight";
      sel.innerHTML = '<option value="auto">Auto (' + WB.C.SIDE[cam] + ' edge)</option><option value="left">Left edge</option><option value="right">Right edge</option>';
      sel.value = c.side[cam]; sel.addEventListener("change", () => WB.setCfg({ side: { [cam]: sel.value } }));
      row((cam === "left_repeater" ? "Left" : "Right") + " mirror: car body at", sel);
    }
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.id = "wbShowMask"; cb.checked = c.showMask; cb.addEventListener("change", () => WB.setCfg({ showMask: cb.checked }));
    row("Show sample area", cb);
    const cs = document.createElement("select"); cs.id = "wbColour";
    cs.innerHTML = '<option value="auto">Auto (when a white point is found)</option><option value="on">On</option><option value="off">Off (raw colours)</option>';
    cs.value = c.colour; cs.addEventListener("change", () => { WB.setCfg({ colour: cs.value }); if (T.vehicle && T.vehicle.colourModeChanged) T.vehicle.colourModeChanged(); });
    cs.title = "Vehicle colour (searches like 'white bus' and live labels) is judged on pixels corrected with the white point from the mirror cameras: a white bus under an orange streetlight then reads white, not brown. Auto: whenever a white point is found, even with the White balance toggle off.";
    row("Colour search uses white balance", cs);
    const btn = document.createElement("button"); btn.className = "btn ghost wide"; btn.type = "button"; btn.id = "wbForget"; btn.textContent = "Forget the learned car-body shape"; btn.addEventListener("click", () => WB.forgetMasks());
    host.appendChild(btn);
    const p = document.createElement("p"); p.className = "hint"; p.textContent = "White balance uses the white car body seen at the outer edge of the mirror cameras. Show sample area outlines the strip it searches and fills the part it samples (pink: found on this clip, violet: remembered, yellow: default sliver). Viewer only: exports are never changed.";
    host.appendChild(p);
  }
  WB.buildSettings = buildSettings;
  function tick(force) {
    timer = 0;
    const P = T.player;
    if (!WB.isOn() || document.hidden || !P || !P.ev) { render(); return; }
    const key = P.active + ":" + (P.time || 0).toFixed(3) + ":" + (P.ev.id || P.ev.name || "");
    const fresh = key !== lastKey;   // only a NEW frame feeds the body-mask statistics
    if (force || P.playing || fresh) { lastKey = key; if (WB.sampleNow(fresh) === "blank") lastKey = ""; }
    apply();   // also picks up a 360 canvas or tiles created since the last tick
    render(); schedule();
  }
  function schedule() {
    if (timer || !WB.isOn() || document.hidden) return;
    timer = setTimeout(tick, 1000 / WB.C.HZ);
  }

  WB.init = () => {
    const b = $("chipWb");
    if (b) b.addEventListener("click", () => WB.toggle());
    document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });
    if (T.on) {
      T.on("player-open", () => { WB.reset(); resetZones(); lastKey = ""; wcache.clear(); wdone.clear(); schedule(); });
      T.on("time", () => { if (WB.isOn() && !timer) schedule(); });
      T.on("layout", () => { if (WB.applied) apply(); drawMasks(); });   // new tiles / 360 canvas get the correction too
    }
    buildSettings();
    render(); apply(); schedule();
  };
})();
