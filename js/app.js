/* app.js — bootstrap. */
(function () {
  "use strict";
  const T = window.TDC;
  function start() {
    T.ui.init();
    if (T.search) T.search.init();
    if (T.redact) T.redact.init();
    if (T.searchUI) { try { T.searchUI.init(); } catch (e) { console.warn(e); } }   // Phase 4; falls back to the classic bars
    if (T.auto.companion) T.auto.runCompanion().catch((e) => { console.error(e); document.title = "TDC-ERROR " + e.message; fetch("/api/progress?token=" + encodeURIComponent(T.auto.token), { method: "POST", headers: { "Content-Type": "application/json", "X-TDC-Token": T.auto.token }, body: JSON.stringify({ state: "fatal", error: String(e.message || e) }) }).catch(() => {}); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
