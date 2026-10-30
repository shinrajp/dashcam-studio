/* keyboard.js — ui-glass-12 (iPhone: "with the keyboard up, the player capsule floats over the Search / Settings sheet").
 * While a text field in a sheet or panel is focused on a touch screen (or the on-screen keyboard is up), body gets .kb-typing:
 *   - the player capsule (bottom bar / transport), the bubble and the floating camera pill / map hide (css/app.css), so they never
 *     cover the sheet, its field or its results;
 *   - the visible area above the keyboard is published from visualViewport as --kb (what the keyboard covers), --vvh (visible height)
 *     and --vv-bottom (the visible bottom edge), so Settings (and the Search sheet, js/search-ui.js) stay fully above the keyboard and
 *     their results scroll inside them.
 * On a desktop with a mouse nothing changes. Display only: nothing is saved, export never sees it. */
(function () {
  "use strict";
  const T = window.TDC; if (!T) return;
  const root = document.documentElement, body = () => document.body;
  const K = (T.keyboard = { typing: false, kb: 0 });
  const coarse = () => { try { return matchMedia("(pointer: coarse)").matches; } catch (_) { return false; } };
  const TEXT = /^(text|search|email|url|tel|password|number)$/i;
  const isText = (e) => !!e && (e.isContentEditable || e.tagName === "TEXTAREA" || (e.tagName === "INPUT" && TEXT.test(e.type || "text")));
  // a field in a sheet or panel (not one of the player's own controls)
  const inSheet = (e) => !!e.closest("#settings, #usPanel, #library, .drawer, .modal, [role=dialog], .us-panel") && !e.closest("#transport, #mbBar");
  let raf = 0;
  function measure() {
    raf = 0;
    const v = window.visualViewport, ih = window.innerHeight;
    const vh = v ? v.height : ih, top = v ? v.offsetTop || 0 : 0;
    const kb = Math.max(0, Math.round(ih - (vh + top)));
    const a = document.activeElement, typing = isText(a) && inSheet(a) && (coarse() || kb > 40);
    root.style.setProperty("--kb", (typing ? kb : 0) + "px");
    root.style.setProperty("--vvh", Math.round(vh) + "px");
    root.style.setProperty("--vv-bottom", Math.round(vh + top) + "px");
    const was = K.typing; K.typing = typing; K.kb = kb;
    const b = body(); if (b) { b.classList.toggle("kb-typing", typing); b.classList.toggle("kb-up", typing && kb > 40); }
    if (typing && kb > 40 && a && a.scrollIntoView) { try { const r = a.getBoundingClientRect(); if (r.bottom > vh + top - 8 || r.top < top) a.scrollIntoView({ block: "nearest" }); } catch (_) {} }
    if (was !== typing) { try { T.emit && T.emit("keyboard", typing); } catch (_) {} }
  }
  const later = () => { if (!raf) raf = requestAnimationFrame(measure); };
  K.measure = measure;
  document.addEventListener("focusin", later, true);
  document.addEventListener("focusout", () => setTimeout(later, 0), true);
  window.addEventListener("resize", later);
  if (window.visualViewport) { visualViewport.addEventListener("resize", later); visualViewport.addEventListener("scroll", later); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", later); else later();
})();
