/* focus.js — live-view only: focus one camera (enlarged to the whole stage), switch angles, digital zoom/pan,
 * show/hide cameras in the grid, and full screen with an auto-hiding control overlay.
 * Nothing here touches export: exports always render the full 3×2 grid from the decoded frames.
 * Hidden / non-focused tiles stay laid out full-size (just invisible), so their videos keep decoding in sync. */
(function () {
  "use strict";
  const T = window.TDC;
  const F = (T.focus = { cam: null, z: 1, x: 0, y: 0, since: 0 });
  /** Switcher / number-key order. */
  F.ORDER = ["front", "back", "left_pillar", "right_pillar", "left_repeater", "right_repeater"];
  const SHORT = { front: "Front", back: "Rear", left_pillar: "L Pillar", right_pillar: "R Pillar", left_repeater: "L Repeater", right_repeater: "R Repeater" };
  const MAX_Z = 4;
  const $ = (id) => document.getElementById(id);
  const P = () => T.player;
  const stage = () => $("stage");
  const present = (cam) => { const ev = P().ev; return !!ev && ev.cams.includes(cam); };
  const hidden = (cam) => !!(T.prefs.camsHidden && T.prefs.camsHidden[cam]);

  // ── layout ──
  /** Columns × rows of the live view: 1×1 when focused, otherwise fits the visible cameras. */
  F.dims = () => {
    if (F.cam) return { cols: 1, rows: 1 };
    const n = T.GRID.filter((c) => !hidden(c)).length;
    return n <= 1 ? { cols: 1, rows: 1 } : n === 2 ? { cols: 2, rows: 1 } : n === 3 ? { cols: 3, rows: 1 } : n === 4 ? { cols: 2, rows: 2 } : { cols: 3, rows: 2 };
  };
  function applyLayout() {
    const d = F.dims(), grid = $("grid");
    grid.style.gridTemplateColumns = `repeat(${d.cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${d.rows}, 1fr)`;
    for (const cam of T.GRID) {
      const t = P().tiles[cam];
      if (!t) continue;
      const on = F.cam ? cam === F.cam : !hidden(cam);
      t.tile.classList.toggle("off", !on);
      t.tile.classList.toggle("focused", F.cam === cam);
    }
    stage().classList.toggle("focus", !!F.cam);
    document.body.classList.toggle("focused", !!F.cam);
    resetZoom();
    syncBar();
    if (T.ui && T.ui.fit) T.ui.fit();
  }

  // ── focus / switch ──
  F.focus = (cam) => {
    if (!P().ev) return;
    if (cam && !present(cam)) { T.toast(`No ${T.CAM_LABEL[cam].toLowerCase()} footage in this event`, "err"); return; }
    if (cam && cam !== F.cam) F.since = performance.now();
    F.cam = cam || null;
    applyLayout();
    wake();
  };
  F.grid = () => F.focus(null);
  F.cycle = (dir) => {
    const cams = F.ORDER.filter(present);
    if (!cams.length) return;
    const i = F.cam ? cams.indexOf(F.cam) : -1;
    F.focus(i < 0 ? (dir > 0 ? cams[0] : cams[cams.length - 1]) : cams[(i + dir + cams.length) % cams.length]);
  };
  F.byNumber = (n) => { const cam = F.ORDER[n - 1]; if (cam) F.focus(cam); };

  // ── digital zoom (focused camera only) ──
  const focusedTile = () => (F.cam ? P().tiles[F.cam].tile : null);
  function applyZoom() {
    const tile = focusedTile();
    if (tile) {
      const W = tile.clientWidth, H = tile.clientHeight;
      const mx = ((F.z - 1) * W) / 2, my = ((F.z - 1) * H) / 2;
      F.x = T.clamp(F.x, -mx, mx); F.y = T.clamp(F.y, -my, my);
      const tf = F.z > 1.001 ? `translate(${F.x}px, ${F.y}px) scale(${F.z})` : "";
      P().tiles[F.cam].vids.forEach((v) => (v.style.transform = tf));
      tile.classList.toggle("zoomed", F.z > 1.001);
    }
    const lab = $("zoomLabel");
    if (lab) lab.textContent = (Math.round(F.z * 10) / 10).toFixed(1).replace(/\.0$/, "") + "×";
    if ($("btnZoomOut")) { $("btnZoomOut").disabled = F.z <= 1.001; $("btnZoomIn").disabled = F.z >= MAX_Z - 0.001; }
  }
  function resetZoom() {
    F.z = 1; F.x = 0; F.y = 0;
    for (const cam of T.GRID) { const t = P().tiles[cam]; if (t) { t.vids.forEach((v) => (v.style.transform = "")); t.tile.classList.remove("zoomed"); } }
    applyZoom();
  }
  F.resetZoom = resetZoom;
  /** Zoom to z around a point (cx, cy) given in px relative to the tile's centre. */
  F.zoomTo = (z, cx, cy) => {
    if (!F.cam) return;
    z = T.clamp(z, 1, MAX_Z);
    cx = cx || 0; cy = cy || 0;
    F.x = cx - ((cx - F.x) * z) / F.z;
    F.y = cy - ((cy - F.y) * z) / F.z;
    F.z = z;
    if (z <= 1.001) { F.x = 0; F.y = 0; }
    applyZoom();
  };
  F.zoomBy = (k, cx, cy) => F.zoomTo(F.z * k, cx, cy);
  const centreOf = (tile, e) => { const r = tile.getBoundingClientRect(); return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2]; };

  function zoomInput() {
    const st = stage();
    st.addEventListener("wheel", (e) => {
      const tile = focusedTile();
      if (!tile || !e.ctrlKey) return; // ctrl+wheel, and trackpad pinch in Chrome/Edge/Firefox
      e.preventDefault();
      const [cx, cy] = centreOf(tile, e);
      F.zoomBy(Math.exp(-e.deltaY * 0.01), cx, cy);
    }, { passive: false });
    // Safari (Mac trackpad pinch; iOS also sends these alongside touches — pointer pinch handles those)
    let g0 = 1;
    st.addEventListener("gesturestart", (e) => { if (!F.cam) return; e.preventDefault(); g0 = F.z; });
    st.addEventListener("gesturechange", (e) => { if (!F.cam || pts.size >= 2) return; e.preventDefault(); F.zoomTo(g0 * e.scale); });
    st.addEventListener("gestureend", (e) => { if (F.cam) e.preventDefault(); });

    // pointers: two-finger pinch, one-finger / mouse drag to pan when zoomed
    const pts = new Map();
    let pinch = null, pan = null;
    st.addEventListener("pointerdown", (e) => {
      const tile = focusedTile();
      if (!tile || !tile.contains(e.target)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { tile.setPointerCapture(e.pointerId); } catch (_) {}
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const mid = { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 };
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: F.z, c: centreOf(tile, mid), x: F.x, y: F.y };
        pan = null;
      } else if (pts.size === 1 && F.z > 1.001 && (e.pointerType !== "mouse" || e.button === 0)) {
        pan = { x: e.clientX, y: e.clientY, fx: F.x, fy: F.y };
      }
    });
    st.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        F.x = pinch.x; F.y = pinch.y; F.z = pinch.z;
        F.zoomTo(pinch.z * (d / pinch.d), pinch.c[0], pinch.c[1]);
      } else if (pan) {
        F.x = pan.fx + (e.clientX - pan.x); F.y = pan.fy + (e.clientY - pan.y);
        applyZoom();
      }
    });
    const up = (e) => {
      if (!pts.delete(e.pointerId)) return;
      if (pts.size < 2) pinch = null;
      if (!pts.size) pan = null;
    };
    st.addEventListener("pointerup", up);
    st.addEventListener("pointercancel", up);
  }

  // ── grid camera toggles ──
  F.setHidden = (cam, hide) => {
    const h = { ...(T.prefs.camsHidden || {}) };
    if (hide && T.GRID.filter((c) => !h[c] && c !== cam).length === 0) { T.toast("At least one camera has to stay visible", "err"); syncBar(); return false; }
    h[cam] = !!hide;
    T.setPref("camsHidden", h);
    applyLayout();
    return true;
  };

  // ── full screen (whole app in "theatre" layout; the native API where available, CSS-only otherwise) ──
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  F.isFullscreen = () => document.body.classList.contains("fs");
  F.fullscreen = (on) => {
    if (on == null) on = !F.isFullscreen();
    const root = document.documentElement;
    if (on) {
      document.body.classList.add("fs");
      F.native = false;
      const req = root.requestFullscreen ? () => root.requestFullscreen({ navigationUI: "hide" }) : root.webkitRequestFullscreen ? () => root.webkitRequestFullscreen() : null;
      F.lastRequest = req ? (root.requestFullscreen ? "requestFullscreen" : "webkitRequestFullscreen") : "none (CSS full-window)";
      if (req) {
        try {
          const p = req();
          F.native = true;
          if (p && p.catch) p.catch(() => { F.native = false; }); // denied (e.g. iPhone): keep the CSS full-window layout
        } catch (_) { F.native = false; }
      }
    } else {
      document.body.classList.remove("fs");
      if (fsEl()) { try { const p = (document.exitFullscreen || document.webkitExitFullscreen).call(document); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
      F.native = false;
    }
    syncBar(); wake();
    if (T.ui && T.ui.fit) requestAnimationFrame(() => T.ui.fit());
  };
  function onFsChange() {
    if (!fsEl() && F.native && F.isFullscreen()) { F.native = false; document.body.classList.remove("fs"); syncBar(); } // left via Esc / browser UI
    if (T.ui && T.ui.fit) requestAnimationFrame(() => T.ui.fit());
  }

  // ── auto-hiding controls (stage bar always; transport too in full screen) ──
  let idleTimer = 0, overBar = false;
  function wake() {
    document.body.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!overBar && !($("camMenu") && !$("camMenu").hidden)) document.body.classList.add("idle"); }, 2800);
  }
  F.wake = wake;

  // ── stage bar UI ──
  function buildBar() {
    const sw = $("camSwitch");
    sw.innerHTML = "";
    const g = T.el("button", "cam-chip grid-chip", "Grid");
    g.dataset.cam = ""; g.title = "Back to the grid (G or Esc)";
    sw.appendChild(g);
    F.ORDER.forEach((cam, i) => {
      const b = T.el("button", "cam-chip");
      b.dataset.cam = cam;
      b.innerHTML = `<kbd>${i + 1}</kbd><span></span>`;
      b.querySelector("span").textContent = SHORT[cam];
      b.title = `${T.CAM_LABEL[cam]} (${i + 1})`;
      sw.appendChild(b);
    });
    sw.addEventListener("click", (e) => { const b = e.target.closest(".cam-chip"); if (!b || b.disabled) return; e.stopPropagation(); F.focus(b.dataset.cam || null); });
    const menu = $("camMenu");
    menu.innerHTML = "<div class='cm-title'>Show in grid</div>";
    for (const cam of T.GRID) {
      const row = T.el("label", "cm-row");
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.dataset.cam = cam;
      cb.addEventListener("change", () => { if (!F.setHidden(cam, !cb.checked)) cb.checked = true; cb.blur(); }); // blur: keep keyboard shortcuts working
      row.append(cb, T.el("span", null, T.CAM_LABEL[cam]));
      menu.appendChild(row);
    }
    $("btnCams").addEventListener("click", (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; syncBar(); wake(); });
    document.addEventListener("pointerdown", (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== $("btnCams") && !$("btnCams").contains(e.target)) { menu.hidden = true; } });
    $("btnZoomIn").addEventListener("click", (e) => { e.stopPropagation(); F.zoomBy(1.5); });
    $("btnZoomOut").addEventListener("click", (e) => { e.stopPropagation(); F.zoomBy(1 / 1.5); });
    $("btnFsStage").addEventListener("click", (e) => { e.stopPropagation(); F.fullscreen(); });
    $("btnFullscreen").addEventListener("click", () => F.fullscreen());
    const bar = $("stageBar");
    for (const el of [bar, $("transport")]) {
      el.addEventListener("pointerenter", () => { overBar = true; wake(); });
      el.addEventListener("pointerleave", () => { overBar = false; wake(); });
    }
  }
  function syncBar() {
    const sw = $("camSwitch");
    if (!sw) return;
    sw.querySelectorAll(".cam-chip").forEach((b) => {
      const cam = b.dataset.cam;
      b.classList.toggle("on", cam ? F.cam === cam : !F.cam);
      if (cam) { b.disabled = !present(cam); b.title = present(cam) ? `${T.CAM_LABEL[cam]} (${F.ORDER.indexOf(cam) + 1})` : `No ${T.CAM_LABEL[cam].toLowerCase()} footage in this event`; }
    });
    $("camMenu").querySelectorAll("input").forEach((cb) => (cb.checked = !hidden(cb.dataset.cam)));
    $("btnCams").classList.toggle("on", !$("camMenu").hidden);
    const nh = T.GRID.filter(hidden).length;
    $("btnCams").querySelector("span").textContent = nh ? `Cameras · ${6 - nh}/6` : "Cameras";
    const fs = F.isFullscreen();
    for (const id of ["btnFsStage", "btnFullscreen"]) { const b = $(id); b.classList.toggle("is-fs", fs); b.title = fs ? "Exit full screen (F)" : "Full screen (F)"; }
    applyZoom();
  }
  F.sync = syncBar;

  F.init = () => {
    buildBar();
    // tap / click a tile in the grid → focus it; the corner button does the same (discoverable on hover)
    $("grid").addEventListener("click", (e) => {
      const tile = e.target.closest(".tile");
      if (!tile || F.cam || !P().ev) return;
      F.focus(tile.dataset.cam);
    });
    for (const cam of T.GRID) {
      const t = P().tiles[cam];
      const b = T.el("button", "tile-expand");
      b.type = "button"; b.title = `Enlarge ${T.CAM_LABEL[cam]}`; b.setAttribute("aria-label", b.title);
      b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
      t.tile.appendChild(b);
    }
    // double-click: reset the zoom, or (not zoomed) back to the grid. Ignore the 2nd click of the double-click that focused.
    stage().addEventListener("dblclick", (e) => {
      if (!F.cam || e.target.closest(".stage-bar, .float-panel")) return;
      if (F.z > 1.001) resetZoom();
      else if (performance.now() - F.since > 600) F.grid();
    });
    $("btnFocusClose").addEventListener("click", (e) => { e.stopPropagation(); F.grid(); });
    zoomInput();
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    ["pointermove", "pointerdown", "keydown", "wheel"].forEach((ev) => window.addEventListener(ev, wake, { passive: true }));
    window.addEventListener("resize", () => applyZoom());
    T.on("player-open", () => { if (F.cam && !present(F.cam)) F.cam = null; applyLayout(); });
    T.on("prefs", (p) => { if (p === "*" || p === "camsHidden") applyLayout(); });
    applyLayout();
    wake();
  };
})();
