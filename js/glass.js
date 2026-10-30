/* glass.js — ui-glass-1: the Liquid Glass material for today's controls (css/glass.css). Look only: no layout or behaviour change.
 *  - Settings ▸ Appearance ▸ Glass: Automatic (default) · Clear · Solid. Pref `glass`; `?glass=auto|clear|solid` overrides it for one visit.
 *  - Effective mode is Solid when the browser has no backdrop-filter, or the system asks for Reduce transparency.
 *  - Blur budget: at most 3 blurred pieces at once (BLUR_MAX), radius <= 22 px, nothing blurred inside a blurred piece. Pieces that miss the budget
 *    keep the same tint without blur. The budget is re-checked (throttled) when something opens, closes or the window changes.
 *  - Automatic: about once a second while a video is on screen, an 8x8 sample of the visible camera videos sets --g-a (tint opacity): darker over
 *    bright video, so white text stays >= 4.5:1 even over a white sky. No sample is taken in Clear / Solid, or while the tab is hidden.
 *  ui-glass-9: Automatic follows the video under each glass piece (TINT_SEL): about 4 times a second while playing (once after a pause, seek or
 *    layout change; never while the tab is hidden, during an export, in Clear / Solid / Lite or with Reduce motion, which keeps a static safe
 *    tint), the visible camera pictures are drawn into one tiny canvas (1/16 of the window) and each piece gets its own --g-rgb (a dark tint
 *    of the dominant colour) and --g-a (the lowest opacity that keeps its dimmest text >= 4.5:1 over the brightest part under it, sheen
 *    included; never below the old alphaFor). Opacity goes up at once and eases down; the colour eases; tiny changes are ignored (no flicker).
 *    If a sample gets slow it drops to once a second, then to the single global tint.
 *  Lite mode (pref `lite` auto | on | off, `?lite=auto|on|off|1|0`): Solid look, no blur anywhere, no video tint. Auto turns it on for the
 *    session when playback stays under ~40 fps for 3 s (rAF frame times; seeking, resizing, play start and stalls are ignored; back above 45
 *    resets) or the device reports <= 2 GB memory. Not from frame times under automation (navigator.webdriver: software rendering), unless
 *    G.autoLiteFps is set.
 *  Export never reads any of this (it draws on its own canvas). */
(function () {
  "use strict";
  const T = window.TDC; if (!T) return;
  const MODES = ["auto", "clear", "solid"], BLUR_MAX = 3, root = document.documentElement;
  const G = (T.glass = { mode: "auto", effective: "auto", luma: -1, alpha: 0, blurred: [] });
  const mq = (q) => { try { return window.matchMedia(q); } catch (_) { return null; } };
  const mRT = mq("(prefers-reduced-transparency: reduce)"), mRM = mq("(prefers-reduced-motion: reduce)");
  G.supported = () => { try { return CSS.supports("backdrop-filter", "blur(1px)") || CSS.supports("-webkit-backdrop-filter", "blur(1px)"); } catch (_) { return false; } };
  G.override = () => { try { const m = /(?:[?&#])glass=(auto|clear|solid)\b/.exec(location.search + location.hash); return m ? m[1] : null; } catch (_) { return null; } };
  G.pref = () => (MODES.includes(T.prefs.glass) ? T.prefs.glass : "auto");
  // ---- lite mode -----------------------------------------------------------------------------------------------------------------------------
  G.liteOverride = () => { try { const m = /(?:[?&#])lite=(auto|on|off|1|0)\b/.exec(location.search + location.hash); return m ? ({ 1: "on", 0: "off" }[m[1]] || m[1]) : null; } catch (_) { return null; } };
  G.litePref = () => (["auto", "on", "off"].includes(T.prefs.lite) ? T.prefs.lite : "auto");
  G.lowMem = () => { try { const m = navigator.deviceMemory; return typeof m === "number" && m > 0 && m <= 2; } catch (_) { return false; } };
  G.autoLite = "";   // "" | "slow" | "low-memory" (Auto lite, this session)
  G.autoLiteFps = !(typeof navigator !== "undefined" && navigator.webdriver);

  // tint opacity for Automatic: >= 0.62 always (white text over a white background stays >= 4.5:1 through it), up to 0.9 over bright video
  G.alphaFor = (luma) => (luma < 0 ? 0.7 : luma > 0.85 ? 0.9 : 0.62 + 0.28 * Math.max(0, luma - 0.15) / 0.7);
  G.setLuma = (l) => {
    G.luma = l; G.alpha = G.alphaFor(l);
    if (G.effective === "auto") root.style.setProperty("--g-a", G.alpha.toFixed(3)); else root.style.removeProperty("--g-a");
  };

  G.apply = () => {
    G.mode = G.override() || G.pref();
    G.liteMode = G.liteOverride() || G.litePref();
    if (G.liteMode === "auto" && !G.autoLite && G.lowMem()) G.autoLite = "low-memory";
    G.lite = G.liteMode === "on" || (G.liteMode === "auto" && !!G.autoLite);
    G.rm = !!(mRM && mRM.matches);
    const why = !G.supported() ? "no-backdrop-filter" : mRT && mRT.matches ? "reduced-transparency" : G.lite ? "lite" : "";
    G.effective = why ? "solid" : G.mode; G.why = why;
    root.classList.add("glass");
    root.dataset.glass = G.effective; root.dataset.glassPick = G.mode;
    root.classList.toggle("glass-rm", G.rm);
    if (G.lite) root.dataset.lite = G.liteMode === "on" ? "on" : G.autoLite; else delete root.dataset.lite;
    if (G.effective === "auto") G.setLuma(G.rm ? STATIC_LUMA : G.luma); else root.style.removeProperty("--g-a");
    if (!G.following()) clearTints();
    const ls = document.getElementById("segLite");
    if (ls) ls.querySelectorAll("button").forEach((b) => { b.classList.toggle("on", b.dataset.v === G.liteMode); b.setAttribute("aria-pressed", String(b.dataset.v === G.liteMode)); });
    const ln = document.getElementById("liteNote");
    if (ln) ln.hidden = !(ln.textContent = G.liteOverride() ? "Set by ?lite= in the address for this visit." : G.liteMode !== "auto" ? "" : G.autoLite === "slow" ? "On now: playback was dropping frames." : G.autoLite === "low-memory" ? "On now: this device has little memory." : "");
    const seg = document.getElementById("segGlass");
    if (seg) seg.querySelectorAll("button").forEach((b) => { b.classList.toggle("on", b.dataset.v === G.mode); b.setAttribute("aria-pressed", String(b.dataset.v === G.mode)); });
    const note = document.getElementById("glassNote");
    if (note) note.textContent = why === "lite" ? "Lite mode is on, so the controls are solid with no blur." : why === "reduced-transparency" ? "Reduce transparency is on in your system, so the controls are solid." : why ? "This browser can't blur behind the controls, so they are solid." : G.override() ? "Set by ?glass= in the address for this visit." : "";
    G.budget();
  };

  // ---- blur budget -------------------------------------------------------------------------------------------------------------------------
  const shown = (e) => { if (!e || e.hidden || !e.isConnected) return false; const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(e); return cs.display !== "none" && cs.visibility !== "hidden" && +cs.opacity > 0.05; };
  const $ = (id) => document.getElementById(id);
  function candidates() {   // highest priority first
    const b = document.body, out = [];
    document.querySelectorAll(".modal").forEach((m) => out.push(m));
    out.push($("crBar"));
    const up = $("usPanel"); if (up && !up.classList.contains("docked")) out.push(up);
    out.push($("settings"));
    if (T.bubble && T.bubble.open) document.querySelectorAll("#tbFan .tb-item").forEach((e) => out.push(e));   // ui-glass-6: the fan is on top while it is out
    out.push($("tgPop"));   // ui-glass-4: the toggles popover (phone landscape), only while it is open
    document.querySelectorAll(".stage-bar").forEach((e) => out.push(e));
    if (b.classList.contains("fs")) { out.push($("transport")); document.querySelectorAll(".us-strip").forEach((e) => out.push(e)); }
    ["usBtn", "rdBtn"].forEach((id) => { const e = $(id); if (e && getComputedStyle(e).position === "fixed") out.push(e); });
    const tb = $("toolBubble");   // ui-glass-6: the tools bubble (not while it is a faint idle dot); its fan items only while they are out
    if (tb && !b.classList.contains("idle") && !(T.bubble && T.bubble.away)) { out.push($("tbMain")); if (T.bubble && T.bubble.open) tb.querySelectorAll(".tb-item").forEach((e) => out.push(e)); }
    if (b.classList.contains("lib-open")) out.push($("library"));
    document.querySelectorAll(".car-view").forEach((e) => out.push(e));
    const t = $("toast"); if (t && t.classList.contains("show")) out.push(t);
    return out.filter(Boolean);
  }
  G.budget = () => {
    const want = [];
    if (G.effective !== "solid") for (const e of candidates()) {
      if (want.length >= BLUR_MAX) break;
      if (e.classList.contains("rf-on")) continue;   // ui-glass-11: a refraction piece draws its own glass (js/refract.js)
      if (!shown(e) || (T.autohide && T.autohide.isHidden(e)) || want.some((w) => w.contains(e) || e.contains(w))) continue;   // never a blurred piece inside a blurred piece
      want.push(e);
    }
    document.querySelectorAll(".g-blur").forEach((e) => { if (!want.includes(e)) e.classList.remove("g-blur"); });
    want.forEach((e) => { if (!e.classList.contains("g-blur")) e.classList.add("g-blur"); });
    if (want.length !== G.blurred.length || want.some((e, i) => e !== G.blurred[i])) { G.blurred = want; if (G.tintSoon) G.tintSoon(); }   // a piece came or went: re-tint once
    G.blurred = want;
  };
  let bt = 0, bq = false;
  const budgetSoon = () => { if (bq) return; bq = true; const run = () => { bq = false; bt = Date.now(); G.budget(); };
    const wait = Math.max(0, 120 - (Date.now() - bt)); setTimeout(() => requestAnimationFrame(run), wait); };
  G.budgetSoon = budgetSoon;

  // ---- Automatic: the tint follows the video under each glass piece (ui-glass-9) ---------------------------------------------------------------
  const STATIC_LUMA = 0.9;   // Reduce motion: a static tint, the darkest Automatic one (readable over any frame)
  const TINT_SEL = ".stage-bar, .cr-bar, .car-view, .tile-label, .tile-expand, .toast.show, .map-grip, .map-move, #tbMain, .us-btn, body.fs .transport, body.fs .us-strip";
  const CELL = 16, BASE = [16, 18, 24], TEXT_L = 0.46, RATIO = 4.6, SHEEN = 0.10, A_MAX = 0.96;   // TEXT_L: the dimmest text on glass (#aeb6c2)
  const L_MAX = (TEXT_L + 0.05) / RATIO - 0.05;   // the brightest backdrop (after tint + sheen) that keeps that text >= 4.6:1
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  G.lum = lum; G.L_MAX = L_MAX;
  // what a piece looks like over pixel `b` with tint `t` at opacity a, worst case (the sheen's top-left corner)
  const over = (t, b, a) => [0, 1, 2].map((i) => SHEEN * 255 + (1 - SHEEN) * (a * t[i] + (1 - a) * b[i]));
  G.alphaNeeded = (t, b, floor) => {   // lowest opacity >= floor with lum(over) <= L_MAX
    let lo = Math.max(0, floor || 0), hi = A_MAX;
    if (lum(...over(t, b, lo)) <= L_MAX) return lo;
    for (let k = 0; k < 14; k++) { const m = (lo + hi) / 2; if (lum(...over(t, b, m)) <= L_MAX) hi = m; else lo = m; }
    return hi;
  };
  G.tintFor = (dom) => BASE.map((c, i) => Math.round(0.5 * c + 0.5 * 0.22 * dom[i]));   // a dark tint of the dominant colour
  G.hz = 4; G.tintOn = true; G.stats = { ticks: 0, ms: 0, avg: 0, pieces: 0, slow: "" };
  G.following = () => G.effective === "auto" && !G.rm;
  const tinted = new Set();
  function clearTints() { tinted.forEach((e) => { e.style.removeProperty("--g-a"); e.style.removeProperty("--g-rgb"); e.classList.remove("g-tinted"); delete e._gt; }); tinted.clear(); }
  G.clearTints = clearTints;
  let cv = null, cx = null, pin = null, lastSig = "", drawSeq = 0; const drawnAt = new WeakMap();
  G.perTick = 8;
  const contained = (v, r) => {   // the picture inside a object-fit: contain video box
    const vw = v.videoWidth || v.width, vh = v.videoHeight || v.height; if (!vw || !vh) return r;
    const s = Math.min(r.width / vw, r.height / vh), w = vw * s, h = vh * s;
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
  };
  function sources() {
    if (pin) return pin.map((img) => ({ img, r: { left: 0, top: 0, width: innerWidth, height: innerHeight }, flip: false }));
    return [...document.querySelectorAll("#viewport video, .stage video")].filter((v) => v.readyState >= 2 && v.videoWidth && shown(v)).slice(0, 8)
      .map((v) => ({ img: v, r: contained(v, v.getBoundingClientRect()), flip: !!v.closest(".tile.mirrored") }));
  }
  /** One sample. src (tests): a drawable or a list, used as the picture under the whole window until G.sample(null). Returns the global luma. */
  G.sample = (src) => { if (src !== undefined) pin = src ? [].concat(src) : null; tick(); return G.luma; };
  function tick() {
    if (G.effective !== "auto") return;
    if (G.rm) { G.setLuma(STATIC_LUMA); clearTints(); return; }
    const t0 = performance.now(), list = sources(); if (!list.length) return;
    const W = Math.max(8, Math.ceil(innerWidth / CELL)), H = Math.max(8, Math.ceil(innerHeight / CELL));
    let d, full = false;
    try {
      if (!cv) { cv = document.createElement("canvas"); cx = cv.getContext("2d", { willReadFrequently: true }); }
      // the small canvas keeps what it had: each tick redraws only the stalest pictures (as many as fit ~4 ms), all of them after a layout change
      const sig = W + "x" + H + ":" + list.map((s) => [s.r.left, s.r.top, s.r.width, s.r.height].map(Math.round).join(",") + (s.flip ? "m" : "")).join(";");
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      let todo = list;
      if (sig !== lastSig || pin) { full = true; lastSig = pin ? "" : sig; cx.fillStyle = "#000"; cx.fillRect(0, 0, W, H); }
      else todo = list.slice().sort((a, b) => (drawnAt.get(a.img) || 0) - (drawnAt.get(b.img) || 0)).slice(0, G.perTick);
      const d0 = performance.now();
      for (const s of todo) {
        const x = s.r.left / CELL, y = s.r.top / CELL, w = s.r.width / CELL, h = s.r.height / CELL; if (w < 0.5 || h < 0.5) continue;
        if (s.flip) { cx.save(); cx.translate(x + w, y); cx.scale(-1, 1); cx.drawImage(s.img, 0, 0, w, h); cx.restore(); } else cx.drawImage(s.img, x, y, w, h);
        drawnAt.set(s.img, t0 + (++drawSeq) / 1000);
      }
      if (todo.length && !pin) { const per = (performance.now() - d0) / todo.length; G.stats.vidMs = G.stats.vidMs ? G.stats.vidMs * 0.7 + per * 0.3 : per; G.perTick = Math.max(1, Math.min(8, Math.floor(4 / Math.max(0.05, G.stats.vidMs)))); }
      d = cx.getImageData(0, 0, W, H).data;
    } catch (_) { G.setLuma(0.9); clearTints(); return; }   // unreadable: assume bright (darkest tint), never less readable
    const cov = new Uint8Array(W * H);
    for (const s of list) { const x0 = Math.max(0, Math.floor(s.r.left / CELL)), y0 = Math.max(0, Math.floor(s.r.top / CELL)), x1 = Math.min(W, Math.ceil((s.r.left + s.r.width) / CELL)), y1 = Math.min(H, Math.ceil((s.r.top + s.r.height) / CELL));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cov[y * W + x] = 1; }
    const region = (x0, y0, x1, y1) => {   // average colour, brightest cell colour and luma (0..1, perceptual-ish as before) over the covered cells
      let n = 0, r = 0, g = 0, b = 0, sl = 0, ml = -1, mi = 0;
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
        const k = y * W + x; if (!cov[k]) continue; const i = k * 4, l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        n++; r += d[i]; g += d[i + 1]; b += d[i + 2]; sl += l; if (l > ml) { ml = l; mi = i; } }
      return n ? { n, avg: [r / n, g / n, b / n], max: [d[mi], d[mi + 1], d[mi + 2]], luma: 0.5 * (sl / n) + 0.5 * ml } : null;
    };
    const all = region(0, 0, W, H);
    if (all) G.setLuma(Math.round(all.luma * 100) / 100);
    let pieces = 0;
    if (G.tintOn) {
      const seen = new Set();
      for (const e of document.querySelectorAll(TINT_SEL)) {
        if (pieces >= 24 || !shown(e) || (T.autohide && T.autohide.isHidden && T.autohide.isHidden(e))) continue;
        const r = e.getBoundingClientRect(), g = region(Math.floor(r.left / CELL), Math.floor(r.top / CELL), Math.ceil(r.right / CELL), Math.ceil(r.bottom / CELL));
        if (!g) continue;
        seen.add(e); pieces++; paint(e, g);
      }
      tinted.forEach((e) => { if (!seen.has(e)) { e.style.removeProperty("--g-a"); e.style.removeProperty("--g-rgb"); e.classList.remove("g-tinted"); delete e._gt; tinted.delete(e); } });
    }
    const ms = performance.now() - t0, st = G.stats;
    st.ticks++; st.ms = ms; st.total = (st.total || 0) + ms; st.pieces = pieces;
    if (!full) { st.steady = (st.steady || 0) + 1; st.avg = st.steady === 1 ? ms : st.avg * 0.8 + ms * 0.2; }   // full redraws (layout changes) are rare and not counted
    if (!pin && st.steady > 5) {   // too slow on this device: fewer samples, then only the global tint
      if (st.avg > 20 && G.tintOn) { G.tintOn = false; st.slow = "global"; clearTints(); }
      else if (st.avg > 8 && G.hz > 1) { G.hz = 1; st.slow = "1hz"; }
    }
  }
  function paint(e, g) {
    const floor = G.alphaFor(g.luma), want = G.tintFor(g.avg), cur = e._gt;
    // colour eases; opacity goes up at once (contrast first) and eases down, at most 0.04 a step
    const rgb = cur ? cur.rgb.map((c, i) => (Math.abs(want[i] - c) < 1.5 ? c : c + (want[i] - c) * 0.3)) : want;
    const need = G.alphaNeeded(rgb, g.max, floor);
    let a = !cur ? need : need >= cur.a ? need : Math.max(need, cur.a - Math.min(0.04, (cur.a - need) * 0.3));
    if (cur && Math.abs(a - cur.a) < 0.006 && cur.a >= need) a = cur.a;   // dead band: no shimmer from noise
    const rs = rgb.map((c) => Math.round(c)).join(", "), as = a.toFixed(3);
    if (!cur || cur.as !== as) e.style.setProperty("--g-a", as);
    if (!cur || cur.rs !== rs) e.style.setProperty("--g-rgb", rs);
    e._gt = { rgb, a, as, rs, need, max: g.max }; e.classList.add("g-tinted"); tinted.add(e);
  }
  G.tick = tick;
  // when: ~4 Hz while playing; once (debounced) after a pause, seek, new clip, resize or a piece showing; never while hidden or exporting
  let timer = 0, soon = 0;
  const busy = () => document.hidden || (T.exporter && T.exporter.running);
  const loop = () => { timer = 0; if (!(T.player && T.player.playing) || busy() || !G.following()) return; tick(); timer = setTimeout(loop, 1000 / G.hz); };
  function tintSoon() { if (soon || !G.following() || (T.player && T.player.playing && timer)) return; soon = setTimeout(() => { soon = 0; if (!busy()) tick(); }, 180); }
  G.tintSoon = tintSoon;
  function sched() {
    const playing = !!(T.player && T.player.playing);
    if (playing && !timer && !busy() && G.following()) timer = setTimeout(loop, 60);
    if (!playing) { clearTimeout(timer); timer = 0; tintSoon(); }
    monStart();
  }
  G.sched = sched;

  // ---- Auto lite: frame times while playing --------------------------------------------------------------------------------------------------
  const LM = (G.liteMon = { frames: [], last: 0, slowSince: 0, fps: 0, holdMs: 0, holdUntil: 0, SLOW: 40, OK: 45, FOR: 3000 });
  LM.reset = () => { LM.frames.length = 0; LM.last = 0; LM.slowSince = 0; LM.fps = 0; };
  LM.hold = (ms) => { LM.reset(); LM.holdMs = Math.max(LM.holdMs, ms || 1200); };   // seeking, resizing, play start, tab switch: not a slowdown
  /** One frame timestamp (rAF). o.playing / o.seeking override the player (tests). Returns true when it turned lite on. */
  LM.feed = (t, o) => {
    o = o || {};
    const playing = o.playing !== undefined ? o.playing : !!(T.player && T.player.playing);
    const seeking = o.seeking !== undefined ? o.seeking : [...document.querySelectorAll("#viewport video.on")].some((v) => v.seeking);
    if (!playing || G.liteMode !== "auto" || G.lite || document.hidden) { LM.reset(); return false; }
    if (seeking) { LM.hold(); return false; }
    if (LM.holdMs) { LM.holdUntil = t + LM.holdMs; LM.holdMs = 0; }
    if (t < LM.holdUntil) { LM.reset(); return false; }
    if (LM.last && t - LM.last > 400) { LM.reset(); LM.last = t; return false; }   // one long stall is not steady slowness
    LM.last = t; LM.frames.push(t); while (LM.frames.length > 2 && t - LM.frames[0] > 1000) LM.frames.shift();
    const span = t - LM.frames[0]; if (span < 500) return false;
    LM.fps = (LM.frames.length - 1) * 1000 / span;
    if (LM.fps < LM.SLOW) { if (!LM.slowSince) LM.slowSince = t; if (t - LM.slowSince >= LM.FOR) { G.goLite("slow"); return true; } }
    else if (LM.fps >= LM.OK) LM.slowSince = 0;
    return false;
  };
  G.goLite = (why) => {
    G.autoLite = why; G.apply(); sched();
    try { if (why === "slow" && !sessionStorage.getItem("tdc.liteSaid")) { sessionStorage.setItem("tdc.liteSaid", "1"); T.toast && T.toast("Lite mode is on: playback was dropping frames. Settings ▸ Appearance ▸ Lite mode", null, 6000); } } catch (_) {}
  };
  let monRaf = 0;
  const monOn = () => G.autoLiteFps && G.liteMode === "auto" && !G.lite && !!(T.player && T.player.playing) && !document.hidden;
  function mon(ts) { monRaf = 0; if (!monOn()) { LM.reset(); return; } LM.feed(ts); if (!G.lite) monRaf = requestAnimationFrame(mon); }
  function monStart() { if (!monRaf && monOn()) { LM.hold(); monRaf = requestAnimationFrame(mon); } }
  // ---- wiring ------------------------------------------------------------------------------------------------------------------------------
  function wireSeg() {
    const seg = document.getElementById("segGlass"); if (!seg || seg._wired) return; seg._wired = true;
    seg.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { T.setPref("glass", b.dataset.v); }));
  }
  function wireLite() {
    const seg = document.getElementById("segLite"); if (!seg || seg._wired) return; seg._wired = true;
    seg.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { T.setPref("lite", b.dataset.v); }));
  }
  G.apply();
  if (T.on) T.on("prefs", (k) => {
    if (k === "lite" || k === "*") { G.autoLite = ""; LM.reset(); }   // choosing again gives Auto a fresh start
    if (k === "glass" || k === "lite" || k === "*") { G.apply(); sched(); }
  });
  if (T.on) { T.on("state", sched); T.on("time", () => { if (!(T.player && T.player.playing)) tintSoon(); }); T.on("player-open", () => { LM.hold(); tintSoon(); }); }
  document.addEventListener("visibilitychange", () => { LM.hold(); sched(); });
  document.addEventListener("seeking", () => LM.hold(), true);
  ["resize", "orientationchange"].forEach((ev) => addEventListener(ev, () => { LM.hold(); tintSoon(); }));
  document.addEventListener("fullscreenchange", () => LM.hold());
  [mRT, mRM].forEach((m) => { if (m) { try { m.addEventListener("change", G.apply); } catch (_) { try { m.addListener(G.apply); } catch (__) {} } } });
  const start = () => {
    wireSeg(); wireLite(); G.apply(); sched();
    try { new MutationObserver(budgetSoon).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden", "class"] }); } catch (_) {}
    addEventListener("resize", budgetSoon);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
