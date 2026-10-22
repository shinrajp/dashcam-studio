/* app.js — bootstrap. */
(function () {
  "use strict";
  const T = window.TDC;
  function start() {
    T.ui.init();
    if (T.search) T.search.init();
    if (T.redact) T.redact.init();
    try { if (T.detect) T.detect.init(); } catch (e) { console.warn("detect init", e); }
    try { if (T.plates) T.plates.init(); } catch (e) { console.warn("plates init", e); }
    try { if (T.prewarm) T.prewarm.init(); } catch (e) { console.warn("prewarm init", e); }   // models load at clip open
    try { if (T.vehicle) T.vehicle.init(); } catch (e) { console.warn("vehicle init", e); }
    try { if (T.cloud) T.cloud.init(); } catch (e) { console.warn("cloud init", e); }
    try { if (T.recogSettings) T.recogSettings.init(); } catch (e) { console.warn("recognition settings init", e); }   // five switches + Advanced
    if (T.searchUI) { try { T.searchUI.init(); } catch (e) { console.warn(e); } }   // Phase 4; falls back to the classic bars
    try { if (T.textSearch) T.textSearch.init(); } catch (e) { console.warn("text search init", e); }   // text search & redaction switch
    try { if (T.wb) T.wb.init(); } catch (e) { console.warn("wb init", e); }   // live white balance (viewer only)
    if (T.searchStrip) { try { T.searchStrip.init(); } catch (e) { console.warn(e); } }   // phones: thumbnail strip in full screen
    if (T.auto.companion) T.auto.runCompanion().catch((e) => { console.error(e); document.title = "TDC-ERROR " + e.message; fetch("/api/progress?token=" + encodeURIComponent(T.auto.token), { method: "POST", headers: { "Content-Type": "application/json", "X-TDC-Token": T.auto.token }, body: JSON.stringify({ state: "fatal", error: String(e.message || e) }) }).catch(() => {}); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
