/* glass-tune.js (ui-glass-13): manual glass controls, Settings ▸ Appearance (in the default UI, not only Debug).
 *  - Blur      0–12 px (default 4): the refraction blur of the controls; sheets add 6 px on top. Frosted backdrop blur = min(28, 5.5 × Blur)
 *              (default 22 px, unchanged).
 *  - Strength  0–2.5 (default 1): SDF refraction strength (edge displacement). Frosted has no refraction: the slider is disabled with a note.
 *  - Tint      0–0.8 (default 0.22, the clear demo look): neutral tint of the floating controls (capsule, pill, bubble). Frosted: a floor
 *              under its own tint (Automatic already uses 62–90 %, Clear 42 %).
 *  - Panel opacity 0.3–0.95 (default 0.72): the reading sheets (Settings, Events), separate from the controls, with the stronger blur;
 *              frosted sheets stay at least 90 %.
 *  - Reset to default. Prefs `glassTune` (localStorage); ?gblur= ?gstrength= ?gtint= ?gpanel= override one visit (the slider shows it, disabled).
 *  Applied once per change: CSS variables on <html> (--g-blur, --g-tint-floor) and one refraction re-render; nothing per frame. */
(function () {
  "use strict";
  const T = window.TDC; if (!T) return;
  const root = document.documentElement, $ = (id) => document.getElementById(id);
  const DEF = { blur: 4, str: 1, tint: 0.22, sheet: 0.72 };
  const RANGE = { blur: [0, 12, 0.5], str: [0, 2.5, 0.05], tint: [0, 0.8, 0.01], sheet: [0.3, 0.95, 0.01] };
  const URLK = { blur: "gblur", str: "gstrength", tint: "gtint", sheet: "gpanel" };
  const SHEET_BLUR = 6, FROST_K = 5.5, FROST_MAX = 28;
  const clamp = (k, v) => { const r = RANGE[k]; v = +v; return isFinite(v) ? Math.min(r[1], Math.max(r[0], v)) : DEF[k]; };
  const url = (() => { const o = {}; try { const s = location.search + location.hash; for (const k in URLK) { const m = new RegExp("(?:[?&#])" + URLK[k] + "=(-?[0-9.]+)").exec(s); if (m && isFinite(+m[1])) o[k] = clamp(k, m[1]); } } catch (_) {} return o; })();
  const saved = () => (T.prefs && T.prefs.glassTune) || {};
  const GT = (T.glassTune = { DEF, RANGE, URLK, url, SHEET_BLUR, cur: null });
  /** the values in use: ?g…= > prefs > defaults */
  GT.get = () => { const s = saved(), o = {}; for (const k in DEF) o[k] = k in url ? url[k] : clamp(k, s[k] == null ? DEF[k] : s[k]); return o; };
  GT.frostBlur = (b) => Math.round(Math.min(FROST_MAX, FROST_K * b));
  GT.apply = () => {
    const c = (GT.cur = GT.get());
    root.style.setProperty("--g-blur", GT.frostBlur(c.blur) + "px");
    root.style.setProperty("--g-tint-floor", c.tint.toFixed(3));
    if (T.glass && T.glass.tintFloorChanged) T.glass.tintFloorChanged(c.tint);
    if (T.refract && T.refract.on && T.refract.kick) T.refract.kick(120);
    sync();
  };
  GT.set = (k, v, save) => { if (!T.prefs.glassTune) T.prefs.glassTune = { ...DEF }; T.prefs.glassTune[k] = clamp(k, v); if (save) T.savePrefs(); GT.apply(); };
  GT.reset = () => { T.prefs.glassTune = { ...DEF }; T.savePrefs(); T.emit("prefs", "glassTune"); GT.apply(); };

  // ---- Settings ▸ Appearance ----
  const FMT = { blur: (v) => v.toFixed(1) + " px", str: (v) => v.toFixed(2), tint: (v) => Math.round(v * 100) + "%", sheet: (v) => Math.round(v * 100) + "%" };
  const LABEL = { blur: "Blur", str: "Strength", tint: "Tint", sheet: "Panel opacity" };
  const ID = { blur: "gtBlur", str: "gtStr", tint: "gtTint", sheet: "gtSheet" };
  function build() {
    const sec = $("appearSec"); if (!sec || $("glassTune")) return;
    const box = document.createElement("div"); box.id = "glassTune"; box.className = "glass-tune";
    for (const k of ["blur", "str", "tint", "sheet"]) {
      const r = document.createElement("label"); r.className = "row gt-row"; r.dataset.k = k;
      const sp = document.createElement("span"); sp.textContent = LABEL[k];
      const w = document.createElement("span"); w.className = "wb-range";
      const i = document.createElement("input"); i.type = "range"; i.id = ID[k]; i.min = RANGE[k][0]; i.max = RANGE[k][1]; i.step = RANGE[k][2]; i.setAttribute("aria-label", "Glass " + LABEL[k].toLowerCase());
      const o = document.createElement("output"); o.setAttribute("for", ID[k]);
      i.addEventListener("input", () => { o.textContent = FMT[k](+i.value); GT.set(k, +i.value, false); });
      i.addEventListener("change", () => { GT.set(k, +i.value, true); T.emit("prefs", "glassTune." + k); });
      w.append(i, o); r.append(sp, w); box.appendChild(r);
    }
    const note = document.createElement("p"); note.className = "hint"; note.id = "glassTuneNote"; box.appendChild(note);
    const reset = document.createElement("button"); reset.type = "button"; reset.className = "btn ghost wide"; reset.id = "gtReset"; reset.textContent = "Reset glass to default";
    reset.addEventListener("click", GT.reset); box.appendChild(reset);
    const after = $("segRefract") && $("segRefract").closest(".row"), hint = after && after.nextElementSibling && after.nextElementSibling.matches("p.hint") ? after.nextElementSibling : after;
    if (hint) hint.after(box); else sec.appendChild(box);
  }
  function sync() {
    const c = GT.cur || GT.get(), R = T.refract, refr = !!(R && R.on);
    for (const k in ID) { const i = $(ID[k]); if (!i) continue; if (+i.value !== c[k]) i.value = c[k]; const o = i.parentElement.querySelector("output"); if (o) o.textContent = FMT[k](c[k]);
      i.disabled = k in url || (k === "str" && !refr); const row = i.closest(".row"); if (row) row.classList.toggle("gt-off", i.disabled); }
    const n = $("glassTuneNote"); if (!n) return;
    const u = Object.keys(url).map((k) => "?" + URLK[k] + "=");
    n.textContent = (refr ? "Blur, Strength and Tint shape the floating controls; Panel opacity backs Settings and Events so their text stays readable over bright video."
      : "Frosted glass: Blur sets the backdrop blur and Tint the least tint; Strength needs Refraction (Glass style). Sheets stay at least 90 % opaque.")
      + (u.length ? " Set by " + u.join(", ") + " in the address for this visit." : "");
  }
  GT.sync = sync;
  function init() {
    build(); GT.apply();
    T.on("prefs", (k) => { if (k === "*" || k === "glassStyle" || k === "lite" || k === "glass") setTimeout(() => { if (k === "*") GT.apply(); else sync(); }, 20); });
    // refraction may switch itself to frosted (slow playback, Lite): keep the Strength note right
    try { new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["class"] }); } catch (_) {}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
