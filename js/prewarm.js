/* prewarm.js — load the detector / plate models when a clip is OPENED, not on the first play (tag safari-feedback).
 * The user's Mac Safari: plate blur and detection boxes appeared late after pressing play (the ONNX models were still
 * loading). On "player-open":
 *   - Detect while playing on → the detector (and the fast live model at speed "Fast") starts loading; once it is in,
 *     one detection on the paused frame of each visible camera, so the first boxes are there before play
 *   - Blur plates on → the plate finder + reader start loading (the background plate scan then starts at the playhead)
 * A small "Loading detector…" badge at the stage's bottom-left shows while models load or plates are being found.
 * Nothing loads when those features are off (phones: no extra memory or data). Viewer only. */
(function () {
  "use strict";
  const T = (window.TDC = window.TDC || {});
  const PW = (T.prewarm = { busy: new Map() });
  const $ = (id) => document.getElementById(id);
  function badge() {
    let b = $("modelLoading");
    if (!b) { const st = $("stage"); if (!st) return null; b = document.createElement("div"); b.id = "modelLoading"; b.className = "model-loading"; b.setAttribute("role", "status"); b.setAttribute("aria-live", "polite"); b.hidden = true; st.appendChild(b); }
    return b;
  }
  PW.render = () => {
    const b = badge(); if (!b) return;
    let s = [...PW.busy.values()][0] || "";
    const L = T.plates;
    if (!s && L && L.bgScan && L.progress && L.progress.total) s = "Finding plates to blur · " + Math.round((100 * L.progress.n) / L.progress.total) + " %";
    b.textContent = s; b.hidden = !s;
  };
  let tick = 0;
  const loop = () => { PW.render(); clearTimeout(tick); if (PW.busy.size || (T.plates && T.plates.bgScan)) tick = setTimeout(loop, 500); };
  PW.track = (key, text, promise) => {
    PW.busy.set(key, text); loop();
    return Promise.resolve(promise).catch((e) => { console.warn("prewarm " + key, e); return null; }).finally(() => { PW.busy.delete(key); loop(); });
  };
  /** One detection on the paused frame of each visible camera (the boxes are there before play). */
  async function firstLook() {
    const D = T.detect, P = T.player;
    if (!D || !P || !P.tiles || P.playing || !D.detectOnce) return;
    for (const cam of D.liveCams()) { if (P.playing) break; try { await D.detectOnce(cam); } catch (e) { console.warn("first look", e); break; } }
    T.emit && T.emit("layout");
  }
  PW.open = (ev) => {
    if (!ev) return;
    const D = T.detect, L = T.plates;
    try {
      if (D && D.enabled() && D.prefs().live) {
        const fast = D.speed && D.speed() === "fast" && D.prefs().model !== "gdino";
        PW.track("det", "Loading detector…", (fast ? D.loadFast() : D.load()).then(() => setTimeout(firstLook, 300)));
      }
      if (L && L.blurOn && L.blurOn()) PW.track("plates", "Loading plate finder…", L.load());
    } catch (e) { console.warn("prewarm", e); }
  };
  PW.init = () => {
    if (T.on) {
      T.on("player-open", (ev) => PW.open(ev));
      T.on("layout", () => { if (T.plates && T.plates.bgScan) loop(); });
    }
  };
})();
