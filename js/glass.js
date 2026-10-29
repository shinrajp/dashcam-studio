/* glass.js — ui-glass-1: the Liquid Glass material for today's controls (css/glass.css). Look only: no layout or behaviour change.
 *  - Settings ▸ Appearance ▸ Glass: Automatic (default) · Clear · Solid. Pref `glass`; `?glass=auto|clear|solid` overrides it for one visit.
 *  - Effective mode is Solid when the browser has no backdrop-filter, or the system asks for Reduce transparency.
 *  - Blur budget: at most 3 blurred pieces at once (BLUR_MAX), radius <= 22 px, nothing blurred inside a blurred piece. Pieces that miss the budget
 *    keep the same tint without blur. The budget is re-checked (throttled) when something opens, closes or the window changes.
 *  - Automatic: about once a second while a video is on screen, an 8x8 sample of the visible camera videos sets --g-a (tint opacity): darker over
 *    bright video, so white text stays >= 4.5:1 even over a white sky. No sample is taken in Clear / Solid, or while the tab is hidden.
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

  // tint opacity for Automatic: >= 0.62 always (white text over a white background stays >= 4.5:1 through it), up to 0.9 over bright video
  G.alphaFor = (luma) => (luma < 0 ? 0.7 : luma > 0.85 ? 0.9 : 0.62 + 0.28 * Math.max(0, luma - 0.15) / 0.7);
  G.setLuma = (l) => {
    G.luma = l; G.alpha = G.alphaFor(l);
    if (G.effective === "auto") root.style.setProperty("--g-a", G.alpha.toFixed(3)); else root.style.removeProperty("--g-a");
  };

  G.apply = () => {
    G.mode = G.override() || G.pref();
    const why = !G.supported() ? "no-backdrop-filter" : mRT && mRT.matches ? "reduced-transparency" : "";
    G.effective = why ? "solid" : G.mode; G.why = why;
    root.classList.add("glass");
    root.dataset.glass = G.effective; root.dataset.glassPick = G.mode;
    root.classList.toggle("glass-rm", !!(mRM && mRM.matches));
    if (G.effective === "auto") G.setLuma(G.luma); else root.style.removeProperty("--g-a");
    const seg = document.getElementById("segGlass");
    if (seg) seg.querySelectorAll("button").forEach((b) => { b.classList.toggle("on", b.dataset.v === G.mode); b.setAttribute("aria-pressed", String(b.dataset.v === G.mode)); });
    const note = document.getElementById("glassNote");
    if (note) note.textContent = why === "reduced-transparency" ? "Reduce transparency is on in your system, so the controls are solid." : why ? "This browser can't blur behind the controls, so they are solid." : G.override() ? "Set by ?glass= in the address for this visit." : "";
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
    document.querySelectorAll(".stage-bar").forEach((e) => out.push(e));
    if (b.classList.contains("fs")) { out.push($("transport")); document.querySelectorAll(".us-strip").forEach((e) => out.push(e)); }
    ["usBtn", "rdBtn"].forEach((id) => { const e = $(id); if (e && getComputedStyle(e).position === "fixed") out.push(e); });
    document.querySelectorAll(".car-view").forEach((e) => out.push(e));
    const t = $("toast"); if (t && t.classList.contains("show")) out.push(t);
    return out.filter(Boolean);
  }
  G.budget = () => {
    const want = [];
    if (G.effective !== "solid") for (const e of candidates()) {
      if (want.length >= BLUR_MAX) break;
      if (!shown(e) || want.some((w) => w.contains(e) || e.contains(w))) continue;   // never a blurred piece inside a blurred piece
      want.push(e);
    }
    document.querySelectorAll(".g-blur").forEach((e) => { if (!want.includes(e)) e.classList.remove("g-blur"); });
    want.forEach((e) => { if (!e.classList.contains("g-blur")) e.classList.add("g-blur"); });
    G.blurred = want;
  };
  let bt = 0, bq = false;
  const budgetSoon = () => { if (bq) return; bq = true; const run = () => { bq = false; bt = Date.now(); G.budget(); };
    const wait = Math.max(0, 120 - (Date.now() - bt)); setTimeout(() => requestAnimationFrame(run), wait); };
  G.budgetSoon = budgetSoon;

  // ---- Automatic: sample the video under the glass about once a second ------------------------------------------------------------------------
  let cv = null, cx = null;
  G.sample = (src) => {   // src: optional drawable(s) (tests); default = the camera videos on screen
    if (G.effective !== "auto") return G.luma;
    const list = src ? [].concat(src) : [...document.querySelectorAll("#viewport video, .stage video")].filter((v) => v.readyState >= 2 && v.videoWidth && shown(v)).slice(0, 6);
    if (!list.length) return G.luma;
    try {
      if (!cv) { cv = document.createElement("canvas"); cv.width = cv.height = 8; cx = cv.getContext("2d", { willReadFrequently: true }); }
      let sum = 0, n = 0, mx = 0;
      for (const v of list) {
        cx.clearRect(0, 0, 8, 8); cx.drawImage(v, 0, 0, 8, 8);
        const d = cx.getImageData(0, 0, 8, 8).data;
        for (let i = 0; i < d.length; i += 4) { const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; sum += l; n++; if (l > mx) mx = l; }
      }
      // lean on the bright end: a bright sky strip matters more than a dark road under the same capsule
      const l = n ? 0.5 * (sum / n) + 0.5 * mx : -1;
      G.setLuma(Math.round(l * 100) / 100);
    } catch (_) { G.setLuma(0.9); }   // unreadable: assume bright (darkest tint), never less readable
    return G.luma;
  };
  setInterval(() => { if (!document.hidden && G.effective === "auto") G.sample(); }, 1000);

  // ---- wiring ------------------------------------------------------------------------------------------------------------------------------
  function wireSeg() {
    const seg = document.getElementById("segGlass"); if (!seg || seg._wired) return; seg._wired = true;
    seg.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { T.setPref("glass", b.dataset.v); }));
  }
  G.apply();
  if (T.on) T.on("prefs", (k) => { if (k === "glass" || k === "*") G.apply(); });
  [mRT, mRM].forEach((m) => { if (m) { try { m.addEventListener("change", G.apply); } catch (_) { try { m.addListener(G.apply); } catch (__) {} } } });
  const start = () => {
    wireSeg(); G.apply();
    try { new MutationObserver(budgetSoon).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden", "class"] }); } catch (_) {}
    addEventListener("resize", budgetSoon);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
