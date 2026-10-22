/* recog-settings.js — Settings ▸ Recognition (tag safari-feedback). The four beta sections (object detection, plates & text,
 * vehicle details, cloud boost) had ~20 controls in a row. Now five clearly named switches + one speed choice on top; every
 * other control (models, thresholds, cameras, street signs, make & model, cloud, index buttons) is under "Advanced
 * recognition settings", collapsed by default, open / closed remembered. The advanced controls are the same elements as
 * before (same ids), so nothing is lost; the five switches are hidden there to avoid two of each. Switches that need
 * another one turn it on (boxes while playing / vehicle colour need object detection; blur plates needs plate reading). */
(function () {
  "use strict";
  const T = (window.TDC = window.TDC || {});
  const RS = (T.recogSettings = {});
  const ADV_KEY = "tdc.recogAdv.v1";
  const $ = (id) => document.getElementById(id);
  RS.advOpen = () => { try { return localStorage.getItem(ADV_KEY) === "1"; } catch (_) { return false; } };
  const SW = [
    { id: "rsFind", label: "Find objects in search", hint: "car, person, bus, dog… (on-device model)", get: () => T.detect && T.detect.enabled(), set: (v) => T.detect.setPref("enabled", v) },
    { id: "rsLive", label: "Show boxes while playing", hint: "boxes follow cars and people as the video plays", get: () => T.detect && T.detect.enabled() && T.detect.prefs().live, set: (v) => { if (v && !T.detect.enabled()) T.detect.setPref("enabled", true); T.detect.setPref("live", v); } },
    { id: "rsVehicle", label: "Vehicle colour & type", hint: "\u201cred tour bus\u201d, \u201cwhite police car\u201d; labels say the colour", get: () => T.vehicle && T.vehicle.enabled(), set: (v) => { if (v && T.detect && !T.detect.enabled()) T.detect.setPref("enabled", true); T.vehicle.setPref("enabled", v); } },
    { id: "rsPlates", label: "Read licence plates", hint: "search \u201cplate 7ABC\u201d", get: () => T.plates && T.plates.enabled(), set: (v) => T.plates.setPref("enabled", v) },
    { id: "rsBlur", label: "Blur licence plates", hint: "in playback and in exports", get: () => T.plates && T.plates.blurOn(), set: (v) => { if (v && !T.plates.enabled()) T.plates.setPref("enabled", true); T.plates.setPref("blur", v); } },
  ];
  RS.render = () => {
    const box = $("setRecog"); if (!box) return;
    box.innerHTML = "";
    for (const s of SW) {
      if (!s.get) continue;
      let on = false; try { on = !!s.get(); } catch (_) {}
      const r = document.createElement("label"); r.className = "row rs-switch"; r.htmlFor = s.id;
      r.innerHTML = '<span class="rs-text"><b></b><small></small></span><input type="checkbox" role="switch">';
      r.querySelector("b").textContent = s.label; r.querySelector("small").textContent = s.hint;
      const cb = r.querySelector("input"); cb.id = s.id; cb.checked = on; cb.setAttribute("aria-checked", String(on));
      cb.addEventListener("change", () => { try { s.set(cb.checked); } catch (e) { console.warn("recognition setting", e); } RS.render(); });
      box.appendChild(r);
    }
    const D = T.detect;
    if (D && D.SPEEDS) {
      const r = document.createElement("div"); r.className = "row rs-speed";
      const sp = D.speed(), off = !(D.enabled() && D.prefs().live);
      r.innerHTML = '<span class="rs-text"><b>Speed while playing</b><small>faster boxes use more battery</small></span><div class="seg" id="rsSpeed" role="group" aria-label="Detection speed"></div>';
      const seg = r.querySelector("#rsSpeed");
      for (const [k, lab] of [["battery", "Battery"], ["balanced", "Balanced"], ["fast", "Fast"]]) {
        const b = document.createElement("button"); b.type = "button"; b.dataset.v = k; b.textContent = lab; b.className = k === sp ? "on" : ""; b.setAttribute("aria-pressed", String(k === sp)); b.disabled = off;
        b.addEventListener("click", () => { D.setPref("speed", k); if (k === "fast" && D.enabled()) D.loadFast().catch(() => {}); RS.render(); });
        seg.appendChild(b);
      }
      box.appendChild(r);
    }
    const adv = $("recogAdv"); if (adv && adv.open !== RS.advOpen()) adv.open = RS.advOpen();
  };
  RS.init = () => {
    const adv = $("recogAdv");
    if (adv) {
      adv.open = RS.advOpen();
      adv.addEventListener("toggle", () => { try { localStorage.setItem(ADV_KEY, adv.open ? "1" : "0"); } catch (_) {} });
      adv.addEventListener("change", () => setTimeout(RS.render, 0));   // an advanced control changed a pref the switches show
    }
    const sb = $("btnSettings"); if (sb) sb.addEventListener("click", () => setTimeout(RS.render, 0));   // changed elsewhere (export dialog, tests)
    RS.render();
    if (T.vehicle && T.vehicle.ready) T.vehicle.ready.then(() => RS.render()).catch(() => {});
  };
})();
