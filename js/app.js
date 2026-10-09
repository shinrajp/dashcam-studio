/* app.js — bootstrap. */
(function () {
  "use strict";
  const T = window.TDC;
  function start() {
    T.ui.init();
    if (T.auto.companion) T.auto.runCompanion().catch((e) => { console.error(e); document.title = "TDC-ERROR " + e.message; fetch("/api/progress?token=" + encodeURIComponent(T.auto.token), { method: "POST", headers: { "Content-Type": "application/json", "X-TDC-Token": T.auto.token }, body: JSON.stringify({ state: "fatal", error: String(e.message || e) }) }).catch(() => {}); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
