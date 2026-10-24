/* layout.js — camera layout presets (tag handoff-1).
 *   Current                 top: LEFT PILLAR | FRONT | RIGHT PILLAR   bottom: LEFT REPEATER | REAR | RIGHT REPEATER
 *   Rear view               top row unchanged; bottom: RIGHT REPEATER | REAR | LEFT REPEATER (the view you get looking back at the car)
 *   Mirrored bottom row     bottom: LEFT REPEATER | REAR | RIGHT REPEATER (ui-v3: left and right swapped vs. the first version, which used the
 *                           Rear view order), and the three bottom VIDEOS are flipped (like a mirror). Labels, detection boxes, redaction
 *                           and white balance overlays are NOT flipped: their positions follow the flipped picture, their text stays readable.
 *   Auto (default)          Sentry events: Rear view. Dashcam / saved / recent / anything else: Current.
 * The order is CSS `order` on `.tile[data-cam]` (rules in app.css keyed on `.grid[data-layout]`), so nothing is re-parented and the
 * videos keep decoding. The mirror is the individual CSS `scale: -1 1` property on the VIDEO (and on the canvases that copy picture
 * pixels: redact patches, white-balance mask) — zoom keeps using `transform`, composed after it (see focus.js).
 * Export, the compositor and the 360 view always use their own fixed camera order and the raw, unflipped frames.
 * Pure helpers are exported for node tests (module.exports). */
(function (root) {
  "use strict";
  const PRESETS = {
    current: { label: "Current", bottom: ["left_repeater", "back", "right_repeater"], mirror: [] },
    rear: { label: "Rear view", bottom: ["right_repeater", "back", "left_repeater"], mirror: [] },
    mirror: { label: "Mirrored bottom row", bottom: ["left_repeater", "back", "right_repeater"], mirror: ["left_repeater", "back", "right_repeater"] },
  };
  const AUTO_LABEL = "Auto (Sentry: Rear view, Dashcam: Current)";
  const CHOICES = ["auto", "current", "rear", "mirror"];
  /** Which preset Auto picks for an event (ev.trigger.kind from teslacam.js). */
  function autoPreset(ev) {
    const k = ev && ev.trigger && ev.trigger.kind;
    return k === "sentry" ? "rear" : "current";
  }
  /** Effective preset name for a stored choice + event. Unknown choices fall back to Auto. */
  function resolve(choice, ev) {
    if (!CHOICES.includes(choice)) choice = "auto";
    return choice === "auto" ? autoPreset(ev) : choice;
  }
  /** Is this camera's picture flipped in the viewer under that preset? (Only the bottom row of "Mirrored bottom row".) */
  function isMirrored(preset, cam) { return !!(PRESETS[preset] && PRESETS[preset].mirror.includes(cam)); }
  /** Left-to-right order of the six cameras on a landscape grid (top row, then bottom row). */
  function gridOrder(preset) {
    const p = PRESETS[preset] || PRESETS.current;
    return ["left_pillar", "front", "right_pillar"].concat(p.bottom);
  }
  /** A normalised box {x,y,w,h} (fractions of the unflipped frame) as it lies on the picture the viewer shows. */
  function mirrorBox(b) { return b ? Object.assign({}, b, { x: 1 - b.x - b.w }) : b; }
  /** A horizontal side ("left"/"right") of the raw frame, as seen on screen. */
  function screenSide(mirrored, side) { return mirrored ? (side === "left" ? "right" : "left") : side; }
  const api = { PRESETS, CHOICES, AUTO_LABEL, autoPreset, resolve, isMirrored, gridOrder, mirrorBox, screenSide };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }

  const T = (root.TDC = root.TDC || {});
  const L = (T.layout = Object.assign({ preset: "current" }, api));
  L.supported = (() => { try { return !!(root.CSS && CSS.supports && CSS.supports("scale", "-1 1")); } catch (_) { return false; } })();
  L.choice = () => { const c = T.prefs && T.prefs.layout; return CHOICES.includes(c) ? c : "auto"; };
  L.current = () => resolve(L.choice(), T.player && T.player.ev);
  /** Is this camera's video flipped right now? */
  L.mirrored = (cam) => L.supported && isMirrored(L.preset, cam);
  /** Box on the shown picture (flipped x for a mirrored camera), box unchanged otherwise. */
  L.box = (cam, b) => (L.mirrored(cam) ? mirrorBox(b) : b);
  L.side = (cam, side) => screenSide(L.mirrored(cam), side);
  /** The zoom transform for the VIDEO of this camera: the mirror is the `scale` property, which is applied BEFORE `transform`,
   *  so a mirrored camera's x pan is negated here to keep dragging natural. `plain` is what un-flipped layers use. */
  L.zoomTf = (cam, x, y, z) => {
    const plain = z > 1.001 ? "translate(" + x + "px, " + y + "px) scale(" + z + ")" : "";
    const video = z > 1.001 && L.mirrored(cam) ? "translate(" + -x + "px, " + y + "px) scale(" + z + ")" : plain;
    return { video, plain };
  };
  /** Current on-screen rectangle of a camera's tile (null when hidden) — where hand-off cues must go. */
  L.rect = (cam) => {
    const t = T.player && T.player.tiles && T.player.tiles[cam]; if (!t) return null;
    const r = t.tile.getBoundingClientRect();
    return t.tile.classList.contains("off") || !r.width ? null : r;
  };
  L.apply = () => {
    L.preset = L.current();
    const grid = document.getElementById("grid");
    if (grid) grid.setAttribute("data-layout", L.preset);
    const sel = document.getElementById("layoutSel");
    if (sel && sel.value !== L.choice()) sel.value = L.choice();
    const tiles = T.player && T.player.tiles;
    let changed = false;
    if (tiles) for (const cam of T.GRID) {
      const t = tiles[cam]; if (!t) continue;
      const m = L.mirrored(cam);
      if (t.tile.classList.contains("mirrored") !== m) { t.tile.classList.toggle("mirrored", m); changed = true; }
    }
    if (changed && T.focus && T.focus.resetZoom) { try { T.focus.resetZoom(); } catch (_) {} }
    if (document.body) document.body.dataset.layout = L.preset;
    T.emit("layout", L.preset);
  };
  L.set = (choice) => { if (!CHOICES.includes(choice)) choice = "auto"; T.setPref("layout", choice); L.apply(); };
  L.init = () => {
    const sel = document.getElementById("layoutSel");
    if (sel && !sel.options.length) {
      for (const c of CHOICES) { const o = document.createElement("option"); o.value = c; o.textContent = c === "auto" ? AUTO_LABEL : PRESETS[c].label; if (c === "mirror" && !L.supported) { o.disabled = true; } sel.appendChild(o); }
      sel.addEventListener("change", () => L.set(sel.value));
    }
    if (T.on) T.on("player-open", () => L.apply());
    L.apply();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(L.init, 0)); else setTimeout(L.init, 0);
})(typeof window !== "undefined" ? window : globalThis);
