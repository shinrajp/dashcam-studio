/* export-cams.js — "Cameras" row of the Export dialog: which of the six cameras go into the exported video.
 *  - six chips (tick + name) laid out in the order the export uses (Match viewer / Standard), all ticked by default;
 *  - presets All · Front only · Front + Rear · Sides · (Focused camera, only while one is focused in the viewer);
 *  - at least one camera stays ticked (the last tick is locked, with a hint);
 *  - a one-line summary ("Exporting 3 of 6 cameras: … · 1920×1080") and a small picture of the layout that will result;
 *  - a ticked camera that has no footage in this event keeps today's "No … footage" placeholder (the chip says so; untick it to leave it out).
 * The choice lives in memory only: it is NOT saved across page loads or put in the preferences, so a normal export is always all six cameras
 * unless the user changed it in this session (no surprise partial exports days later).
 * Progressive enhancement: without this file the dialog has no Cameras row and the export is all six cameras, exactly as before. */
(function () {
  "use strict";
  const T = window.TDC, $ = (id) => document.getElementById(id);
  const EC = (T.exportCams = { sel: null });   // sel: ticked cameras this session, or null = all six
  const SHORT = { front: "F", back: "R", left_pillar: "LP", right_pillar: "RP", left_repeater: "LR", right_repeater: "RR" };
  const PRESETS = [
    { id: "all", label: "All", cams: () => T.GRID.slice(), title: "All six cameras (the default)" },
    { id: "front", label: "Front only", cams: () => ["front"], title: "Only the front camera" },
    { id: "fr", label: "Front + Rear", cams: () => ["front", "back"], title: "Front and rear cameras" },
    { id: "sides", label: "Sides", cams: () => ["left_pillar", "right_pillar", "left_repeater", "right_repeater"], title: "The four side cameras: both pillars and both repeaters" },
    { id: "focus", label: "Focused camera", cams: () => (T.focus && T.focus.cam ? [T.focus.cam] : null), title: "The camera you have zoomed to in the viewer", relevant: () => !!(T.focus && T.focus.cam) },
  ];
  const X = () => T.exporter;
  /** The ticked cameras (T.GRID order). */
  EC.get = () => X().normCams(EC.sel);
  EC.isAll = () => EC.get().length === 6;
  const same = (a, b) => a.length === b.length && a.every((c) => b.includes(c));
  /** The order the chips (and the picture) use: the same one the export uses. */
  EC.order = () => T.compositor.cameraOrder(T.prefs.export.order === "standard" ? "standard" : "viewer").order;
  EC.hasFootage = (ev, cam) => !!(ev && ev.clips && ev.clips.some((c) => c.files && c.files[cam]));
  EC.set = (list, quiet) => {
    const n = X().normCams(list);
    EC.sel = n.length === 6 ? null : n;
    if (!quiet) EC.changed(); else EC.render();
  };
  EC.reset = () => { EC.sel = null; };
  EC.changed = () => {
    const U = T.ui, ev = T.player && T.player.ev;
    if (ev && U.refreshSizes) U.refreshSizes(ev);
    if (U.syncExtras) U.syncExtras(); else EC.render();   // re-checks Fill black area, redraws the chips and the output size
  };
  const hint = (txt, warn) => { const h = $("camHint"); if (h) { h.textContent = txt || ""; h.classList.toggle("warn", !!warn); } };

  EC.render = () => {
    const grid = $("camGrid"), ev = T.player && T.player.ev;
    if (!grid || !ev) return;
    const on = EC.get(), last = on.length === 1;
    grid.innerHTML = "";
    for (const cam of EC.order()) {
      const has = EC.hasFootage(ev, cam), sel = on.includes(cam);
      const b = T.el("button", "cam-opt" + (sel ? " on" : "") + (has ? "" : " nofoot") + (sel && last ? " lock" : ""));
      b.type = "button"; b.dataset.cam = cam; b.setAttribute("role", "checkbox"); b.setAttribute("aria-checked", sel ? "true" : "false");
      if (sel && last) b.setAttribute("aria-disabled", "true");
      b.title = (sel && last ? "At least one camera must stay ticked. " : "") + (has ? "" : "No footage for this camera in this event. ") + "Click to " + (sel ? "leave out" : "include") + " " + T.CAM_LABEL[cam];
      b.innerHTML = '<span class="cam-tick" aria-hidden="true">' + (sel ? "✓" : "") + '</span><span class="cam-name"></span>' + (has ? "" : '<small class="cam-no">No footage</small>');
      b.querySelector(".cam-name").textContent = T.CAM_LABEL[cam];
      b.onclick = () => {
        const cur = EC.get();
        if (cur.includes(cam)) {
          if (cur.length === 1) { hint("At least one camera has to stay ticked.", true); return; }
          EC.set(cur.filter((c) => c !== cam));
        } else EC.set(cur.concat(cam));
      };
      grid.appendChild(b);
    }
    const pr = $("camPresets");
    if (pr) {
      pr.innerHTML = "";
      for (const p of PRESETS) {
        if (p.relevant && !p.relevant()) continue;
        const list = p.cams(); if (!list) continue;
        const c = T.el("button", "chip" + (same(on, list) ? " on" : ""), p.label);
        c.type = "button"; c.title = p.title; c.dataset.preset = p.id; c.setAttribute("aria-pressed", same(on, list) ? "true" : "false");
        c.onclick = () => EC.set(list);
        pr.appendChild(c);
      }
    }
    const missing = on.filter((c) => !EC.hasFootage(ev, c));
    hint(missing.length ? missing.map((c) => T.CAM_LABEL[c]).join(", ") + (missing.length > 1 ? " have" : " has") + " no footage in this event: the picture shows a placeholder. Untick to leave it out." : on.length === 6 ? "" : "Fewer cameras also exports faster: unticked cameras are not decoded.", missing.length > 0);
  };

  /** Summary line + layout picture for the planned output (cand = { W, H, geo } from X.plan). */
  EC.afterPlan = (cand) => {
    const s = $("camSummary"), ev = T.player && T.player.ev;
    if (!s || !ev) return;
    const on = EC.get(), W = cand ? cand.W : 0, H = cand ? cand.H : 0;
    s.textContent = "Exporting " + (on.length === 6 ? "all 6 cameras" : on.length + " of 6 cameras (" + EC.order().filter((c) => on.includes(c)).map((c) => T.CAM_LABEL[c]).join(", ") + ")") + (W ? " · " + W + "×" + H : "");
    EC.preview(cand);
  };
  const PANEL_NAME = { hud: "HUD", map: "Map", car: "Car" };
  EC.preview = (cand) => {
    const box = $("camPreview"); if (!box) return;
    box.innerHTML = "";
    if (!cand || !cand.geo) return;
    const g = cand.geo, W = cand.W, H = cand.H, k = Math.min(150 / W, 84 / H), C = T.compositor;
    const wrap = T.el("div", "cp-frame"); wrap.style.width = Math.round(W * k) + "px"; wrap.style.height = Math.round(H * k) + "px";
    const add = (cls, r, txt) => { const d = T.el("div", cls, txt || ""); d.style.left = r.x * k + "px"; d.style.top = r.y * k + "px"; d.style.width = Math.max(1, r.w * k) + "px"; d.style.height = Math.max(1, r.h * k) + "px"; wrap.appendChild(d); return d; };
    const order = g.order || T.GRID, cols = g.cols || 3, rows = g.rows || 2;
    for (let i = 0; i < cols * rows; i++) {
      const r = C.cellRect(g.grid, i, 0, cols, rows), cam = order[i];
      if (cam) { const has = EC.hasFootage(T.player.ev, cam); add("cp-cam" + (has ? "" : " nofoot") + (g.mirror && g.mirror.includes(cam) ? " flip" : ""), { x: r.x + 0.5 / k, y: r.y + 0.5 / k, w: r.w - 1 / k, h: r.h - 1 / k }, SHORT[cam]); }
      else add("cp-free", { x: r.x + 0.5 / k, y: r.y + 0.5 / k, w: r.w - 1 / k, h: r.h - 1 / k });
    }
    for (const p of g.panels || []) add("cp-panel", p, PANEL_NAME[p.k]);
    box.appendChild(wrap);
  };
  EC.show = (visible) => { const b = $("camsBlock"); if (b) b.hidden = !visible; };

})();
