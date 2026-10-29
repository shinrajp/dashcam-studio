/* pano-toggle.js — tiny always-loaded part of the 360 view: the "360" button. js/pano.js (the WebGL renderer)
 * is only fetched the first time you turn 360 on, so with it off nothing else loads or runs. */
(function () {
  "use strict";
  const T = (window.TDC = window.TDC || {});
  let loading = null;
  T.loadPano = () => loading || (loading = new Promise((res, rej) => {
    if (T.pano) return res(T.pano);
    const s = document.createElement("script"); s.src = "js/pano.js";
    s.onload = () => (T.pano ? res(T.pano) : rej(new Error("pano.js did not initialise")));
    s.onerror = () => { loading = null; rej(new Error("Couldn't load js/pano.js")); };
    document.head.appendChild(s);
  }));
  T.toggle360 = async (on) => {
    const btn = document.getElementById("btn360");
    try {
      if (on === false && !T.pano) return;
      const P = await T.loadPano();
      const v = P.toggle(on);
      if (btn) { btn.classList.toggle("on", v); btn.setAttribute("aria-pressed", String(v)); }
      return v;
    } catch (e) {
      console.warn("360 view", e);
      if (T.toast) T.toast("360 view isn't available here: " + (e.message || e), "err", 6000);
      if (btn) { btn.classList.remove("on"); btn.setAttribute("aria-pressed", "false"); }
      return false;
    }
  };
  /** Show or hide everything that only exists for the 360 view (beta): the camera-bar button, the 360 export preset and Settings ▸ Calibration (and, via
   *  pano.js's own bar, Calibrate and Gyro, which are only reachable through the 360 view). Safe to call any time. */
  T.apply360 = () => {
    const on = T.show360On ? T.show360On() : false;
    document.body.classList.toggle("no360", !on);
    const btn = document.getElementById("btn360"); if (btn) btn.hidden = !on;
    const pre = document.getElementById("presetEquirect"); if (pre) pre.hidden = !on;
    // Calibration (Settings section, and the 360 view's Calibrate panel) only shows while 360 is on (user decision t213u). Prefs keep their values.
    document.querySelectorAll(".need360").forEach((el) => { el.hidden = !on; });
    const cp = document.getElementById("panoCalibPanel"); if (cp && !on) cp.hidden = true;
    if (!on) {
      if (T.pano && T.pano.on) T.toggle360(false);   // leave the 360 view first so nothing is left covering the grid
      const r = document.querySelector('input[name=preset][value=equirect]');
      if (r && r.checked) { const c = document.querySelector('input[name=preset][value=compat]'); if (c) { c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true })); } }
    }
    const cb = document.getElementById("show360"); if (cb) cb.checked = on;
  };
  const wire360 = () => { if (T.on) T.on("prefs", (k) => { if (k === "show360" || k === "*") T.apply360(); }); T.apply360(); };
  const wireBtn = () => { const btn = document.getElementById("btn360"); if (btn && !btn._wired) { btn._wired = true; btn.addEventListener("click", () => T.toggle360(!(T.pano && T.pano.on))); } };
  const wire = () => { wireBtn(); wire360(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire();
})();
