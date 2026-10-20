/* wb.js — live white balance for the viewer (tag white-balance).
 * The car is white and the two mirror (repeater) cameras always see a piece of that white paint along their inner
 * edge. Its glossy highlight, followed over several frames, gives the colour of the light that falls on the car
 * (the streetlight "white point"). A partial correction (~70 %) is applied to the camera VIDEOS in the viewer only:
 *   - an SVG feColorMatrix filter (per-channel gains) on the <video> elements, or
 *   - on Safari / iOS a cheap equivalent: brightness() on the video + a multiply-blend tint layer just above it.
 * Overlays (HUD, map, labels, boxes, gold box, chips, self-driving badge, time) are separate elements and keep their
 * own colours. Export, detection, search and the 360 export read the decoded frames with drawImage, which ignores
 * CSS filters and the tint layer, so they always get the raw pixels.
 * Sampling: ~4–5 Hz, from small downscaled strips, only while it's on and the tab is visible. */
(function () {
  "use strict";
  const T = window.TDC;
  const WB = (T.wb = {});
  const $ = (id) => document.getElementById(id);

  // ── tunable constants ──
  WB.C = {
    STRENGTH: 0.7,          // share of the full correction that is applied
    HZ: 4.5,                // samples per second
    // inner edge of each mirror camera: left repeater → right side of its image, right repeater → left side
    STRIP: { left_repeater: { x0: 0.82, x1: 1.0 }, right_repeater: { x0: 0.0, x1: 0.18 }, y0: 0.5, y1: 1.0 },
    SW: 40, SH: 90,         // the strip is downscaled to SW × SH pixels before it is read
    TOP: 0.05,              // brightest share of the (unclipped) strip pixels that are candidates
    MIN_CAND: 8,            // fewer candidates than this = paint not seen
    CLIP: 250,              // a pixel with any channel ≥ CLIP is clipped and ignored
    MIN_Y: 80,              // candidates darker than this (sRGB luminance 0–255) are not paint
    BLACK: 3,               // a strip whose brightest pixel is below this is a blank frame (hidden video in WebKit)
    OUTLIER: 0.16,          // drop candidates whose log-chroma is farther than this from the candidates' median
    MAX_SPREAD: 0.14,       // candidates more scattered than this (median distance) are not one painted surface
    RED_RG: 2.1,            // hue gate: log-free ratios; R/G above this = red lamp / brake light
    GREEN_RG: 0.8, GREEN_BG: 1.0, // R/G below and B/G below = green traffic light
    JUMP: 0.22,             // per-frame chroma jump (log units) vs. the running estimate that is rejected
    JUMP_ACCEPT: 14,        // …unless it persists this many samples (~3 s): then the light really changed
    EMA: 0.25,              // smoothing weight of a new sample
    LOST_MS: 8000,          // paint unseen this long → correction fades back to none
    GAIN_MIN: 0.5, GAIN_MAX: 2.2,
  };
  const KEY = "tdc.wb.v1", MODE_KEY = "tdc.wb.mode";
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
    const k = strength == null ? WB.C.STRENGTH : strength, ref = luma(w[0], w[1], w[2]);
    let g = w.map((c) => 1 + (ref / Math.max(c, 1) - 1) * k);
    const norm = ref / luma(w[0] * g[0], w[1] * g[1], w[2] * g[2]);
    return g.map((x) => Math.min(WB.C.GAIN_MAX, Math.max(WB.C.GAIN_MIN, x * norm)));
  };

  /** Analyse one strip (ImageData-like {data,width,height}). → {blank} | {found:false} | {found:true, rgb, n} */
  WB.analyse = (img) => {
    const C = WB.C, d = img.data, px = [];
    let max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2], y = luma(r, g, b);
      if (y > max) max = y;
      if (r >= C.CLIP || g >= C.CLIP || b >= C.CLIP) continue;           // clipped: colour unknown
      px.push([y, r, g, b]);
    }
    if (max < C.BLACK) return { blank: true };
    if (px.length < C.MIN_CAND) return { found: false, why: "clipped" };
    px.sort((a, b) => b[0] - a[0]);
    let cand = px.slice(0, Math.max(C.MIN_CAND, Math.round(px.length * C.TOP)));
    const gated = cand.filter(([, r, g, b]) => { const rg = r / Math.max(g, 1), bg = b / Math.max(g, 1); return !(rg > C.RED_RG) && !(rg < C.GREEN_RG && bg < C.GREEN_BG); });
    const rejectedHue = cand.length - gated.length;
    cand = gated.filter((p) => p[0] >= C.MIN_Y);
    if (cand.length < C.MIN_CAND) return { found: false, why: rejectedHue > cand.length ? "hue" : "dark", rejectedHue };
    // log-chroma, median-trimmed: drops near-neutral specks and odd coloured reflections alike
    const lc = cand.map(([, r, g, b]) => [Math.log(Math.max(r, 1) / Math.max(g, 1)), Math.log(Math.max(b, 1) / Math.max(g, 1))]);
    const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
    const m = [med(lc.map((v) => v[0])), med(lc.map((v) => v[1]))];
    const dist = lc.map((v) => Math.hypot(v[0] - m[0], v[1] - m[1]));
    if (med(dist) > C.MAX_SPREAD) return { found: false, why: "scattered" };
    let R = 0, G = 0, B = 0, n = 0;
    cand.forEach((p, i) => { if (dist[i] <= C.OUTLIER) { R += p[1]; G += p[2]; B += p[3]; n++; } });
    if (n < C.MIN_CAND / 2) return { found: false, why: "scattered" };
    return { found: true, rgb: [R / n, G / n, B / n], n, rejectedHue };
  };

  // ── running estimate (log-chroma EMA with jump rejection) ──
  const st = (WB.state = { est: null, lum: 0, jumps: 0, lastSeen: 0, cams: [], samples: 0, accepted: 0, rejected: 0, raw: null });
  WB.reset = () => { st.est = null; st.lum = 0; st.jumps = 0; st.lastSeen = 0; st.cams = []; st.samples = st.accepted = st.rejected = 0; st.raw = null; apply(); render(); };
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
  WB.white = () => (st.est ? [200 * Math.exp(st.est[0]), 200, 200 * Math.exp(st.est[1])].map((v) => Math.min(255, v)) : null);
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
    if (!on) apply(); else tick(true);
    render(); schedule();
  };
  WB.toggle = () => WB.set(!WB.isOn());

  // ── sampling loop ──
  let cv = null, cx = null, timer = 0, lastKey = "";
  function strip(cam) {
    const P = T.player, t = P && P.tiles && P.tiles[cam];
    const v = t && t.vids[P.active];
    if (!v || !v._url || v.readyState < 2 || !v.videoWidth) return null;
    const C = WB.C, s = C.STRIP[cam], vw = v.videoWidth, vh = v.videoHeight;
    if (!cv) { cv = document.createElement("canvas"); cv.width = C.SW; cv.height = C.SH; cx = cv.getContext("2d", { willReadFrequently: true }); }
    try {
      cx.drawImage(v, s.x0 * vw, C.STRIP.y0 * vh, (s.x1 - s.x0) * vw, (C.STRIP.y1 - C.STRIP.y0) * vh, 0, 0, C.SW, C.SH);
      return cx.getImageData(0, 0, C.SW, C.SH);
    } catch (_) { return null; }
  }
  WB.sampleNow = () => {
    const seen = [], whites = [];
    let blank = 0;
    for (const cam of ["left_repeater", "right_repeater"]) {
      const img = strip(cam); if (!img) continue;
      const a = WB.analyse(img); a.cam = cam;
      if (a.blank) { blank++; continue; }
      if (a.found) { seen.push(cam); whites.push(a.rgb); }
    }
    if (!whites.length && blank) return "blank";      // nothing decoded to look at: keep the estimate as it is
    // both mirrors: average in log-chroma (each normalised to its green)
    let rgb = null;
    if (whites.length) { const l = whites.map((w) => [Math.log(w[0] / w[1]), Math.log(w[2] / w[1])]); const m = [0, 1].map((k) => l.reduce((s, v) => s + v[k], 0) / l.length); rgb = [200 * Math.exp(m[0]), 200, 200 * Math.exp(m[1])]; }
    const r = WB.update(rgb);
    st.cams = r === "jump" ? st.cams : seen;
    return r;
  };
  function tick(force) {
    timer = 0;
    const P = T.player;
    if (!WB.isOn() || document.hidden || !P || !P.ev) { render(); return; }
    const key = P.active + ":" + (P.time || 0).toFixed(3) + ":" + (P.ev.id || P.ev.name || "");
    if (force || P.playing || key !== lastKey) { lastKey = key; WB.sampleNow(); }
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
      T.on("player-open", () => { WB.reset(); lastKey = ""; schedule(); });
      T.on("time", () => { if (WB.isOn() && !timer) schedule(); });
      T.on("layout", () => { if (WB.applied) apply(); });   // new tiles / 360 canvas get the correction too
    }
    render(); apply(); schedule();
  };
})();
