/* autohide.js — ui-glass-2: controls over the video hide after a few seconds without input while a video plays.
 *  - Settings ▸ Appearance ▸ Auto-hide: 2 s · 3 s (default) · 5 s · Never. Pref `autohide`; `?autohide=2|3|5|never` overrides it for one visit.
 *  - Never hides while paused, while a pointer is held down (seeking, trimming, dragging), while drawing or picking a camera for redaction,
 *    while a panel, sheet, menu, Settings or a dialog is open, while a text field has focus, while the mouse is over a control, or during an export.
 *  - Comes back on mouse move, tap, key press or focus. On touch, a tap on the video while hidden only brings the controls back
 *    (js/focus.js swallows that tap's click, so it doesn't play/pause, enlarge a tile or press anything).
 *  - Hidden = body.idle (pointer-events: none, fades out), then body.ah-gone after the fade (visibility: hidden: no paint, no blur cost;
 *    js/glass.js leaves them out of the blur budget). A 2 px progress line (#ahLine) shows at the bottom of the video meanwhile.
 *  - Reduce motion: no fade, an instant switch. The redaction draw bar never hides. Export never reads any of this. */
(function () {
  "use strict";
  const T = window.TDC; if (!T) return;
  const VALUES = ["2", "3", "5", "never"], FADE = 260, body = () => document.body, $ = (id) => document.getElementById(id);
  const A = (T.autohide = { mode: "3", delay: 3000, hidden: false, why: "" });
  const mRM = (() => { try { return matchMedia("(prefers-reduced-motion: reduce)"); } catch (_) { return null; } })();
  // the pieces that hide (CSS in css/autohide.css uses the same list); the docked camera bar and the redaction draw bar stay
  A.SEL = ".stage .stage-bar, .stage-bar.bar-floating, .tile-expand, .map-panel.map-floating, .map-grip, .map-move, #transport";
  const CTL = ".stage-bar, .transport, .map-panel, .tile-expand, .cam-menu, .us-btn, #usBtn, #rdBtn, .bar-hint, .us-strip";
  A.override = () => { try { const m = /(?:[?&#])autohide=(2|3|5|never)\b/.exec(location.search + location.hash); return m ? m[1] : null; } catch (_) { return null; } };
  A.pref = () => { const v = String(T.prefs.autohide); return VALUES.includes(v) ? v : "3"; };
  A.isHidden = (el) => !!(A.hidden && el && el.matches && (el.matches(A.SEL) || (el.closest && el.closest("#transport"))));

  let last = performance.now(), down = 0, over = false, goneT = 0;
  const shown = (e) => !!(e && !e.hidden && e.getClientRects().length && getComputedStyle(e).display !== "none");
  const typing = () => { const a = document.activeElement; if (!a || a === document.body) return false;
    if (a.isContentEditable || a.tagName === "TEXTAREA" || a.tagName === "SELECT") return true;
    return a.tagName === "INPUT" && !/^(checkbox|radio|range|button|submit|reset|color|file|image)$/i.test(a.type || ""); };
  /** why the controls must stay (first reason), or "" when they may hide */
  A.hold = () => {
    const P = T.player, b = body(), F = T.focus || {};
    if (A.mode === "never") return "never";
    if (!P || !P.ev) return "no-video";
    if (!P.playing) return "paused";
    if (down) return "pointer-down";
    if (T.exporter && T.exporter.running) return "export";
    if (b.classList.contains("cr-drawing") || b.classList.contains("cr-picking") || b.classList.contains("cr-bar-on")) return "redact";
    if ($("settings") && !$("settings").hidden) return "settings";
    if ([...document.querySelectorAll(".modal, dialog[open]")].some(shown)) return "dialog";
    if (shown($("usPanel"))) return "panel";
    const tp = $("transport"); if (tp && tp.classList.contains("mb-open")) return "sheet";
    if (T.toggles && T.toggles.open) return "toggles";   // ui-glass-4: the eye popover (phone landscape)
    if (F.holdControls && F.holdControls()) return "camera-bar";
    if (over) return "pointer-over";
    if (typing()) return "typing";
    return "";
  };
  function show() {
    clearTimeout(goneT);
    if (!A.hidden && !body().classList.contains("idle")) return;
    A.hidden = false; body().classList.remove("idle", "ah-gone"); body().dataset.ah = "shown";
  }
  function hide() {
    if (A.hidden) return;
    A.hidden = true; body().classList.add("idle"); body().dataset.ah = "hidden"; line();
    clearTimeout(goneT);
    const rm = mRM && mRM.matches;
    if (rm) body().classList.add("ah-gone"); else goneT = setTimeout(() => { if (A.hidden) body().classList.add("ah-gone"); }, FADE);
  }
  A.wake = () => { last = performance.now(); show(); };
  A.check = () => {
    const why = A.hold(); A.why = why;
    if (why) { last = performance.now(); show(); return; }
    if (!A.hidden && performance.now() - last >= A.delay) hide();
  };
  A.hideNow = () => { last = -1e9; A.check(); };   // tests / screenshots
  function line() {
    const l = $("ahLine"), P = T.player; if (!l || !P || !P.ev) return;
    const d = P.duration ? P.duration() : 0, f = d > 0 ? Math.max(0, Math.min(1, P.time / d)) : 0;
    l.firstElementChild.style.transform = "scaleX(" + f.toFixed(4) + ")";
  }
  A.apply = () => {
    A.mode = A.override() || A.pref();
    A.delay = A.mode === "never" ? Infinity : +A.mode * 1000;
    const seg = $("segAutohide");
    if (seg) seg.querySelectorAll("button").forEach((b) => { b.classList.toggle("on", b.dataset.v === A.mode); b.setAttribute("aria-pressed", String(b.dataset.v === A.mode)); });
    const note = $("autohideNote"); if (note) note.textContent = A.override() ? "Set by ?autohide= in the address for this visit." : "";
    A.wake(); body().dataset.ah = A.hidden ? "hidden" : "shown";
  };
  const start = () => {
    const seg = $("segAutohide");
    if (seg && !seg._wired) { seg._wired = true; seg.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => T.setPref("autohide", b.dataset.v))); }
    const st = $("stage");
    if (st && !$("ahLine")) { const l = document.createElement("div"); l.id = "ahLine"; l.className = "ah-line"; l.setAttribute("aria-hidden", "true"); l.appendChild(document.createElement("i")); st.appendChild(l); }
    A.apply();
    ["pointermove", "keydown", "wheel", "focusin"].forEach((ev) => addEventListener(ev, A.wake, { passive: true, capture: ev === "focusin" }));
    addEventListener("pointerdown", (e) => { down++; A.wake(); }, { passive: true });
    const up = () => { down = 0; A.wake(); };
    addEventListener("pointerup", up, { passive: true }); addEventListener("pointercancel", up, { passive: true });
    addEventListener("blur", () => { down = 0; over = false; });
    addEventListener("pointerover", (e) => { if (e.pointerType === "mouse") over = !!(e.target && e.target.closest && e.target.closest(CTL)); }, { passive: true });
    document.addEventListener("pointerleave", () => { over = false; });
    setInterval(A.check, 250);
    if (T.on) {
      T.on("state", () => A.check());
      T.on("time", () => { if (A.hidden) line(); });
      T.on("prefs", (k) => { if (k === "autohide" || k === "*") A.apply(); });
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
