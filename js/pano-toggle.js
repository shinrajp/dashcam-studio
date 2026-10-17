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
  const wire = () => { const btn = document.getElementById("btn360"); if (btn && !btn._wired) { btn._wired = true; btn.addEventListener("click", () => T.toggle360(!(T.pano && T.pano.on))); } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire();
})();
