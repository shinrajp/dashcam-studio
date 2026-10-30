/* debug.js — ui-glass-12: Debug mode. Settings ▸ Advanced & Labs ▸ Debug (pref `debug`, OFF by default; ?debug=1|0 overrides it for one visit).
 *  Off (default): the app stays simple — the technical controls are hidden (class .dbg-only: calibration, the model picker and the advanced
 *  recognition settings with their thresholds, the white-balance technical rows, the glass / Lite tuning, the perf overlay) and every tuning
 *  value below is IGNORED (the defaults apply), so stale saved prefs can never leave the app in an odd state.
 *  On: html.debug-on shows them, plus this section's tuning:
 *    - glass: refraction strength, tint, blur, and the ui-glass-11 adaptive (video-following) tint (js/refract.js R.tune);
 *    - Lite: the frame rate under which auto Lite / the frosted fallback kick in (glass.js liteMon.SLOW, refract.js R.SLOW);
 *    - an FPS / perf overlay (#perfHud: frames per second, refraction ms per frame, glass mode, Lite);
 *    - white balance: colour temperature (K) and tint (Settings ▸ White balance, js/wb.js WB.manual).
 *  Export never reads any of this. */
(function () {
  "use strict";
  const T = window.TDC; if (!T) return;
  const $ = (id) => document.getElementById(id), root = document.documentElement;
  const D = (T.debug = { on: () => T.debugOn(), hud: null });
  const tune = () => (T.prefs.tune && typeof T.prefs.tune === "object" ? T.prefs.tune : (T.prefs.tune = JSON.parse(JSON.stringify(T.DEFAULT_PREFS.tune))));
  const num = (v, lo, hi, d) => (typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

  function applyLite() {
    const on = T.debugOn(), slow = on ? num(tune().liteFps, 15, 58, 40) : 40;
    try { if (T.glass && T.glass.liteMon) { T.glass.liteMon.SLOW = slow; T.glass.liteMon.OK = slow + 5; } } catch (_) {}
    try { if (T.refract) { T.refract.SLOW = slow; T.refract.OK = slow + 5; } } catch (_) {}
  }
  function rerender() { try { if (T.refract && T.refract.on && T.refract.render) T.refract.render(); } catch (_) {} }

  // ── perf overlay ──
  let raf = 0, frames = 0, t0 = 0, lastPaint = 0;
  function hudWanted() { return T.debugOn() && !!tune().perfHud; }
  function hudLoop(t) {
    raf = 0; if (!hudWanted()) { if (D.hud) D.hud.hidden = true; return; }
    frames++; if (!t0) t0 = t;
    if (t - lastPaint >= 500) {
      const fps = frames * 1000 / Math.max(1, t - t0), R = T.refract, G = T.glass;
      D.fps = Math.round(fps);
      D.hud.textContent = D.fps + " fps · " + (R && R.on ? "refraction " + (R.stats && R.stats.avg ? R.stats.avg.toFixed(1) : "0.0") + " ms" : "frosted" + (R && R.why ? " (" + R.why + ")" : "")) + " · Lite " + (G && G.lite ? "on" : "off");
      frames = 0; t0 = t; lastPaint = t;
    }
    if (!document.hidden) raf = requestAnimationFrame(hudLoop);
  }
  function syncHud() {
    if (hudWanted()) {
      if (!D.hud) { D.hud = document.createElement("div"); D.hud.id = "perfHud"; D.hud.className = "perf-hud"; D.hud.setAttribute("aria-hidden", "true"); document.body.appendChild(D.hud); }
      D.hud.hidden = false; if (!raf && !document.hidden) { t0 = 0; frames = 0; lastPaint = 0; raf = requestAnimationFrame(hudLoop); }
    } else { if (D.hud) D.hud.hidden = true; if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  }

  // ── Settings ▸ Advanced & Labs ▸ Debug ──
  function range(id, label, min, max, step, val, fmt, on) {
    const r = document.createElement("label"); r.className = "row"; const sp = document.createElement("span"); sp.textContent = label;
    const w = document.createElement("span"); w.className = "wb-range"; const i = document.createElement("input"); i.type = "range"; i.id = id; i.min = min; i.max = max; i.step = step; i.value = val; i.setAttribute("aria-label", label);
    const o = document.createElement("output"); o.textContent = fmt(+val); i.addEventListener("input", () => { o.textContent = fmt(+i.value); on(+i.value); });
    w.append(i, o); r.append(sp, w); return r;
  }
  function check(id, label, val, on) {
    const r = document.createElement("label"); r.className = "row"; const sp = document.createElement("span"); sp.textContent = label;
    const i = document.createElement("input"); i.type = "checkbox"; i.id = id; i.checked = !!val; i.addEventListener("change", () => on(i.checked)); r.append(sp, i); return r;
  }
  /** Spelling (ui-glass-12): System / US / British; the page reloads to apply it. ?lang= in the address wins for that visit. */
  function spellRow(tu, set) {
    const r = document.createElement("label"); r.className = "row"; const sp = document.createElement("span"); sp.textContent = "Spelling";
    const L = T.l10n || {}, sel = document.createElement("select"); sel.id = "dbgLang"; sel.setAttribute("data-no-l10n", "");
    sel.innerHTML = '<option value="">System (' + (L.system || "?") + ')</option><option value="en-US">US (color, license)</option><option value="en-GB">British (colour, licence)</option>';
    sel.value = tu.lang === "en-US" || tu.lang === "en-GB" ? tu.lang : "";
    sel.addEventListener("change", () => { set("lang", sel.value); setTimeout(() => location.reload(), 60); });
    r.append(sp, sel); return r;
  }
  function build() {
    const panel = $("settings"); if (!panel || $("debugSec")) return;
    const body = panel.querySelector(".drawer-body"); if (!body) return;
    const sec = document.createElement("section"); sec.id = "debugSec";
    sec.innerHTML = '<h3>Debug</h3>';
    sec.appendChild(check("debugToggle", "Debug mode", T.debugOn(), (v) => { T.setPref("debug", v); }));
    const note = document.createElement("p"); note.className = "hint"; note.id = "debugNote"; sec.appendChild(note);
    const box = document.createElement("div"); box.id = "dbgTune"; box.className = "toggles dbg-only";
    const tu = tune(), set = (k, v) => { tune()[k] = v; T.savePrefs(); T.emit("prefs", "tune." + k); };
    box.append(
      range("dbgRfStr", "Refraction strength", 0, 2.5, 0.05, num(tu.rfStr, 0, 2.5, 1), (v) => v.toFixed(2), (v) => { set("rfStr", v); rerender(); }),
      range("dbgRfTint", "Glass tint", 0, 0.9, 0.01, num(tu.rfTint, 0, 0.9, 0.22), (v) => Math.round(v * 100) + "%", (v) => { set("rfTint", v); rerender(); }),
      range("dbgRfBlur", "Glass blur", 0, 10, 0.5, num(tu.rfBlur, 0, 10, 4), (v) => v.toFixed(1) + " px", (v) => { set("rfBlur", v); rerender(); }),
      check("dbgRfAdaptive", "Tint follows the video (ui-glass-11)", tu.rfAdaptive, (v) => { set("rfAdaptive", v); rerender(); }),
      range("dbgLiteFps", "Lite below", 15, 58, 1, num(tu.liteFps, 15, 58, 40), (v) => Math.round(v) + " fps", (v) => { set("liteFps", v); applyLite(); }),
      check("dbgPerf", "FPS / perf overlay", tu.perfHud, (v) => { set("perfHud", v); syncHud(); }),
      spellRow(tu, set));
    const reset = document.createElement("button"); reset.type = "button"; reset.className = "btn ghost wide"; reset.id = "dbgReset"; reset.textContent = "Reset debug tuning";
    reset.addEventListener("click", () => { T.prefs.tune = JSON.parse(JSON.stringify(T.DEFAULT_PREFS.tune)); T.savePrefs(); T.emit("prefs", "tune"); syncInputs(); });
    box.appendChild(reset);
    sec.appendChild(box);
    const last = [...body.children].find((s) => s.querySelector && s.querySelector("#btnResetAll"));
    body.insertBefore(sec, last || null);
  }
  function syncInputs() {
    const tu = tune(), v = (id, x) => { const e = $(id); if (!e) return; if (e.type === "checkbox") e.checked = !!x; else { e.value = x; const o = e.parentElement.querySelector("output"); if (o) e.dispatchEvent(new Event("input")); } };
    // (input events re-save the same values; harmless)
    v("dbgRfStr", num(tu.rfStr, 0, 2.5, 1)); v("dbgRfTint", num(tu.rfTint, 0, 0.9, 0.22)); v("dbgRfBlur", num(tu.rfBlur, 0, 10, 4)); v("dbgRfAdaptive", tu.rfAdaptive);
    v("dbgLiteFps", num(tu.liteFps, 15, 58, 40)); v("dbgPerf", tu.perfHud);
    const k = $("wbK"); if (k) { k.value = +tu.wbK || 0; k.dispatchEvent(new Event("input")); } const tn = $("wbTint"); if (tn) { tn.value = +tu.wbTint || 0; tn.dispatchEvent(new Event("input")); }
  }
  function sync() {
    const on = T.debugOn();
    root.classList.toggle("debug-on", on);
    const t = $("debugToggle"); if (t) { t.checked = on; t.disabled = T.debugOverride != null; }
    const n = $("debugNote");
    const ln = T.l10n ? " Spelling: " + (T.l10n.spelling === "us" ? "US" : "British") + " (" + T.l10n.lang + (T.l10n.by === "system" ? ", from the system" : T.l10n.by === "url" ? ", from ?lang=" : ", set here") + ")." : "";
    if (n) n.textContent = (T.debugOverride != null ? "Set by ?debug=" + (T.debugOverride ? "1" : "0") + " in the address for this visit." : on ? "Shows the technical settings: glass and Lite tuning, a perf overlay, white-balance temperature and tint, calibration, models and recognition thresholds." : "Off: the technical settings stay hidden and their defaults apply.") + (on ? ln : "");
    applyLite(); syncHud(); rerender();
    try { if (T.settings && T.settings.refresh) T.settings.refresh(); } catch (_) {}
  }
  D.sync = sync;
  function init() {
    build(); sync();
    T.on("prefs", (k) => { if (k === "debug" || k === "*" || k === "tune") { if (k === "*" || k === "tune") syncInputs(); sync(); } });
    document.addEventListener("visibilitychange", syncHud);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
