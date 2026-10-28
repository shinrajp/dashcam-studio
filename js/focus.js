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
  // Camera-bar names in plain words (the tiles keep Tesla's names). Pillar cams sit in the door pillars and look out
  // to the side; repeater cams sit in the front fenders and look backward, like side mirrors.
  const NAMES = { front: "Front", back: "Back", left_pillar: "Left side", right_pillar: "Right side", left_repeater: "Left mirror", right_repeater: "Right mirror" };
  const TIPS = {
    front: "Front camera: looks ahead",
    back: "Back camera: looks behind the car",
    left_pillar: "Left side camera (left pillar): looks out of the left side",
    right_pillar: "Right side camera (right pillar): looks out of the right side",
    left_repeater: "Left mirror camera (left repeater): looks backward along the left side, like a side mirror",
    right_repeater: "Right mirror camera (right repeater): looks backward along the right side, like a side mirror",
  };
  // tiny top-down car with a "view cone" showing where each camera looks
  const CONE = { front: "M10 4.5L6.2 0h7.6z", back: "M10 15.5L6.2 20h7.6z", left_pillar: "M7.4 9.5L1 5.2v8.6z", right_pillar: "M12.6 9.5L19 5.2v8.6z", left_repeater: "M7.4 6.5L.6 12.4l3.3 5.4z", right_repeater: "M12.6 6.5l6.8 5.9-3.3 5.4z" };
  const camIcon = (cam) => `<svg class="cam-ico" viewBox="0 0 20 20" aria-hidden="true"><path class="cone" d="${CONE[cam]}"/><rect class="car" x="7" y="3.5" width="6" height="13" rx="2.6"/></svg>`;
  const GRID_ICON = '<svg class="cam-ico" viewBox="0 0 20 20" aria-hidden="true"><rect class="car" x="1.5" y="4" width="5" height="5" rx="1"/><rect class="car" x="7.5" y="4" width="5" height="5" rx="1"/><rect class="car" x="13.5" y="4" width="5" height="5" rx="1"/><rect class="car" x="1.5" y="11" width="5" height="5" rx="1"/><rect class="car" x="7.5" y="11" width="5" height="5" rx="1"/><rect class="car" x="13.5" y="11" width="5" height="5" rx="1"/></svg>';
  const MAX_Z = 4;
  const $ = (id) => document.getElementById(id);
  const P = () => T.player;
  const stage = () => $("stage");
  const present = (cam) => { const ev = P().ev; return !!ev && ev.cams.includes(cam); };
  const hidden = (cam) => !!(T.prefs.camsHidden && T.prefs.camsHidden[cam]);

  // ── layout ──
  /** Columns × rows of the live view: 1×1 when focused, otherwise fits the visible cameras. */
  // portrait phones stack the grid 2 columns × 3 rows (CSS orders the tiles: Front | Back, sides, mirrors)
  // portrait = portrait orientation on a narrow window or a touch tablet (iPad Pro 1024 included); decided by the window, not the device model
  const mqPortrait = window.matchMedia ? matchMedia("(orientation: portrait) and (max-width: 900px), (orientation: portrait) and (pointer: coarse) and (max-width: 1366px)") : { matches: false };
  F.portrait = () => !!mqPortrait.matches;
  F.dims = () => {
    if (F.cam) return { cols: 1, rows: 1 };
    const n = T.GRID.filter((c) => !hidden(c)).length;
    if (F.portrait()) {
      // 4-angle events (no pillar cameras) collapse to Front | Back, Left | Right repeater: no empty pillar slots
      try { const m = T.GRID.filter((c) => portraitOn(c)).length; if (m !== n) return m <= 1 ? { cols: 1, rows: 1 } : m <= 3 ? { cols: 1, rows: m } : { cols: 2, rows: Math.ceil(m / 2) }; } catch (e) { console.warn("portrait layout", e); }
    }
    if (F.portrait()) return n <= 1 ? { cols: 1, rows: 1 } : n <= 3 ? { cols: 1, rows: n } : n === 4 ? { cols: 2, rows: 2 } : { cols: 2, rows: 3 };
    return n <= 1 ? { cols: 1, rows: 1 } : n === 2 ? { cols: 2, rows: 1 } : n === 3 ? { cols: 3, rows: 1 } : n === 4 ? { cols: 2, rows: 2 } : { cols: 3, rows: 2 };
  };
  // portrait only: pillar slots are dropped for 4-angle cars (no pillar cameras)
  function portraitOn(cam) {
    if (hidden(cam)) return false;
    if (cam !== "left_pillar" && cam !== "right_pillar") return true;
    const ev = P().ev;   // collapse only when the car has no pillar cameras at all; one missing file keeps its slot
    return !(ev && ev.cams && ev.cams.length && !ev.cams.includes("left_pillar") && !ev.cams.includes("right_pillar"));
  }
  F.portraitOn = portraitOn;
  function applyLayout(keepZoom) {
    document.body.classList.toggle("portrait", F.portrait());
    const d = F.dims(), grid = $("grid");
    grid.style.gridTemplateColumns = `repeat(${d.cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${d.rows}, 1fr)`;
    for (const cam of T.GRID) {
      const t = P().tiles[cam];
      if (!t) continue;
      let on = F.cam ? cam === F.cam : !hidden(cam);
      if (on && !F.cam && F.portrait()) { try { on = portraitOn(cam); } catch (e) { /* keep the old layout */ } }
      t.tile.classList.toggle("off", !on);
      t.tile.classList.toggle("focused", F.cam === cam);
    }
    stage().classList.toggle("focus", !!F.cam);
    document.body.classList.toggle("focused", !!F.cam);
    if (!keepZoom) resetZoom();
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
      const tf = T.layout ? T.layout.zoomTf(F.cam, F.x, F.y, F.z) : { video: F.z > 1.001 ? `translate(${F.x}px, ${F.y}px) scale(${F.z})` : "" };
      P().tiles[F.cam].vids.forEach((v) => { v.style.transform = tf.video; v._zoomPlain = tf.plain != null ? tf.plain : tf.video; });
      tile.classList.toggle("zoomed", F.z > 1.001);
      try { if (T.redact && T.redact.paintSoon) T.redact.paintSoon(); } catch (_) {}   // the blur / custom-region layer follows the zoom even when paused
    }
    const lab = $("zoomLabel");
    if (lab) lab.textContent = (Math.round(F.z * 10) / 10).toFixed(1).replace(/\.0$/, "") + "×";
    if ($("btnZoomOut")) { $("btnZoomOut").disabled = F.z <= 1.001; $("btnZoomIn").disabled = F.z >= MAX_Z - 0.001; }
  }
  function resetZoom() {
    F.z = 1; F.x = 0; F.y = 0;
    for (const cam of T.GRID) { const t = P().tiles[cam]; if (t) { t.vids.forEach((v) => { v.style.transform = ""; v._zoomPlain = ""; }); t.tile.classList.remove("zoomed"); } }
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
    idleTimer = setTimeout(() => { if (!overBar && !F.dragging && hintHidden() && !($("camMenu") && !$("camMenu").hidden)) document.body.classList.add("idle"); }, 2800);
  }
  F.wake = wake;

  // ── stage bar UI ──
  function buildBar() {
    const sw = $("camSwitch");
    sw.innerHTML = "";
    const g = T.el("button", "cam-chip grid-chip");
    g.dataset.cam = ""; g.title = "See all cameras at once (G or Esc)";
    g.innerHTML = GRID_ICON + "<span class='nm'>All cameras</span>";
    sw.appendChild(g);
    F.ORDER.forEach((cam, i) => {
      const b = T.el("button", "cam-chip");
      b.dataset.cam = cam;
      b.innerHTML = `${camIcon(cam)}<span class="nm"></span><kbd>${i + 1}</kbd>`;
      b.querySelector(".nm").textContent = NAMES[cam];
      b.setAttribute("aria-label", NAMES[cam] + " camera");
      sw.appendChild(b);
    });
    sw.addEventListener("click", (e) => {
      const b = e.target.closest(".cam-chip");
      if (!b || b.disabled || performance.now() - (F.dragEnd || 0) < 250) return;
      e.stopPropagation(); hideHint(true); F.focus(b.dataset.cam || null);
    });
    const menu = $("camMenu");
    menu.innerHTML = "<div class='cm-title'>Show in grid</div>";
    for (const cam of T.GRID) {
      const row = T.el("label", "cm-row");
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.dataset.cam = cam;
      cb.addEventListener("change", () => { if (!F.setHidden(cam, !cb.checked)) cb.checked = true; cb.blur(); }); // blur: keep keyboard shortcuts working
      row.append(cb, T.el("span", null, T.CAM_LABEL[cam]));
      menu.appendChild(row);
    }
    camMenuInit(menu);
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
  // ── Cameras picker popover (tag cam-popover) ──
  // The menu lives in a top-level layer: it is moved to <body> and positioned with position: fixed, so no ancestor's
  // overflow / transform / backdrop-filter can clip it and it sits above the stage, tiles, overlays, map and floating
  // search (z-index in .cam-menu). It opens below the Cameras button, or upward when the bar is in the bottom half of
  // the video or docked below it (or there is more room above), or sideways when neither fits. It is clamped to the
  // viewport, scrolls when taller than the room, and follows the button (resize, scroll, bar drag, layout changes).
  const POP_M = 8, POP_GAP = 6;
  let popRaf = 0, popKey = "";
  function camMenuInit(menu) {
    const btn = $("btnCams");
    if (menu.parentElement !== document.body) document.body.appendChild(menu);
    menu.setAttribute("role", "group"); menu.setAttribute("aria-label", "Show in grid");
    btn.setAttribute("aria-haspopup", "true"); btn.setAttribute("aria-controls", "camMenu"); btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", (e) => { e.stopPropagation(); F.camMenu(menu.hidden, e.detail === 0); });
    document.addEventListener("pointerdown", (e) => { if (!menu.hidden && !menu.contains(e.target) && !(e.target.closest && e.target.closest("#stageBar"))) F.camMenu(false); }, true);   // the bar itself: dragging it keeps the menu open (it follows)
    menu.addEventListener("pointerdown", (e) => { e.stopPropagation(); wake(); });
    menu.addEventListener("pointerenter", () => { overBar = true; wake(); });
    menu.addEventListener("pointerleave", () => { overBar = false; wake(); });
    menu.addEventListener("keydown", (e) => {
      const boxes = [...menu.querySelectorAll("input")], i = boxes.indexOf(document.activeElement);
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); F.camMenu(false); btn.focus(); }
      else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && boxes.length) {
        e.preventDefault(); e.stopPropagation();
        boxes[(i + (e.key === "ArrowDown" ? 1 : -1) + boxes.length) % boxes.length].focus();
      }
    });
    const again = () => { if (!menu.hidden) placeCamMenu(true); };
    window.addEventListener("resize", again);
    window.addEventListener("scroll", again, true);
    if (window.visualViewport) { visualViewport.addEventListener("resize", again); visualViewport.addEventListener("scroll", again); }
    // hidden by other code (Esc in ui.js, bar off, …): keep the button state in step
    new MutationObserver(() => { if (menu.hidden) stopFollow(); syncCamBtn(); }).observe(menu, { attributes: true, attributeFilter: ["hidden"] });
  }
  function syncCamBtn() {
    const m = $("camMenu"), b = $("btnCams"); if (!m || !b) return;
    b.classList.toggle("on", !m.hidden); b.setAttribute("aria-expanded", String(!m.hidden));
  }
  function stopFollow() { cancelAnimationFrame(popRaf); popRaf = 0; popKey = ""; }
  /** Open / close the Cameras picker. kb: opened from the keyboard → focus the first camera. */
  F.camMenu = (open, kb) => {
    const menu = $("camMenu");
    if (!menu) return;
    menu.hidden = !open;
    if (open) {
      if (menu.parentElement !== document.body) document.body.appendChild(menu);   // never inside the (filtered) bar
      placeCamMenu(true);
      // place again once it has been laid out (Safari can measure a just-shown element late), then follow the button
      let first = true;
      const follow = () => { if (menu.hidden) return stopFollow(); placeCamMenu(first); first = false; popRaf = requestAnimationFrame(follow); };
      cancelAnimationFrame(popRaf); popRaf = requestAnimationFrame(follow);
      if (kb) { const cb = menu.querySelector("input"); if (cb) cb.focus({ preventScroll: true }); }
    } else stopFollow();
    syncBar(); wake();
  };
  F.camMenuOpen = () => !!$("camMenu") && !$("camMenu").hidden;
  /** Position the open menu next to the Cameras button. force: even if the button hasn't moved. */
  function placeCamMenu(force) {
    const menu = $("camMenu"), btn = $("btnCams");
    if (!menu || menu.hidden || !btn) return;
    const r = btn.getBoundingClientRect();
    const vv = window.visualViewport;
    const vw = vv ? vv.width : window.innerWidth, vh = vv ? vv.height : window.innerHeight;
    const ox = vv ? vv.offsetLeft : 0, oy = vv ? vv.offsetTop : 0;
    const bar = $("stageBar");
    if (!r.width || !r.height || (bar && bar.hidden)) { F.camMenu(false); return; }   // the button went away (focus view, bar off)
    const key = [r.left, r.top, r.width, r.height, vw, vh, ox, oy].map(Math.round).join(",");
    if (!force && key === popKey) return;
    popKey = key;
    // natural size
    menu.style.maxHeight = ""; menu.style.left = "0px"; menu.style.top = "0px"; menu.style.bottom = "auto";
    const w = Math.min(menu.offsetWidth, vw - 2 * POP_M), h = menu.scrollHeight + 2;
    // where is the bar? (bottom half of the video, or docked below it → open upward)
    const st = stage(), sr = st ? st.getBoundingClientRect() : { top: 0, height: vh };
    const br = bar ? bar.getBoundingClientRect() : r;
    const barMid = br.top + br.height / 2;
    const lowBar = document.body.classList.contains("bar-below") || barMid > sr.top + sr.height / 2 || r.top + r.height / 2 > oy + vh / 2;
    const below = oy + vh - r.bottom - POP_GAP - POP_M, above = r.top - oy - POP_GAP - POP_M;
    let dir;
    if (lowBar ? above >= Math.min(h, 120) || above >= below : !(below >= Math.min(h, 120) || below >= above)) dir = "up"; else dir = "down";
    const room = dir === "up" ? above : below;
    let left, top, maxH;
    if (room < Math.min(h, 120)) {
      // no room above or below (a short landscape window, the bar beside the video): open sideways
      const rightRoom = ox + vw - r.right - POP_GAP - POP_M, leftRoom = r.left - ox - POP_GAP - POP_M;
      dir = rightRoom >= w || rightRoom >= leftRoom ? "right" : "left";
      left = dir === "right" ? r.right + POP_GAP : r.left - POP_GAP - w;
      maxH = vh - 2 * POP_M;
      const hh = Math.min(h, maxH);
      top = r.top + r.height / 2 - hh / 2;
    } else {
      maxH = room;
      const hh = Math.min(h, maxH);
      top = dir === "up" ? r.top - POP_GAP - hh : r.bottom + POP_GAP;
      left = r.right - w;                                       // right-aligned with the button…
      if (left < ox + POP_M) left = r.left;                     // …or flipped to start at its left edge
    }
    left = Math.min(Math.max(left, ox + POP_M), ox + vw - POP_M - w);
    maxH = Math.max(60, Math.min(maxH, vh - 2 * POP_M));
    const hh = Math.min(h, maxH);
    top = Math.min(Math.max(top, oy + POP_M), oy + vh - POP_M - hh);
    menu.style.maxHeight = Math.floor(maxH) + "px";
    menu.style.left = Math.round(left) + "px";
    if (dir === "up") {   // anchored by its BOTTOM just above the button: right whatever its final height (Safari measures late)
      menu.style.top = "auto";
      menu.style.bottom = Math.round(window.innerHeight - (r.top - POP_GAP)) + "px";
    } else { menu.style.bottom = "auto"; menu.style.top = Math.round(top) + "px"; }
    menu.dataset.dir = dir;
    // a transformed / filtered ancestor would make position:fixed relative to it: measure and correct the offset
    const got = menu.getBoundingClientRect();
    const dx = got.left - Math.round(left);
    if (Math.abs(dx) > 1) menu.style.left = Math.round(left - dx) + "px";
    if (dir === "up") { const dy = got.bottom - Math.round(r.top - POP_GAP); if (Math.abs(dy) > 1) menu.style.bottom = Math.round(window.innerHeight - (r.top - POP_GAP) + dy) + "px"; }
    else { const dy = got.top - Math.round(top); if (Math.abs(dy) > 1) menu.style.top = Math.round(top - dy) + "px"; }
  }
  F.placeCamMenu = () => placeCamMenu(true);

  function syncBar() {
    const sw = $("camSwitch");
    if (!sw) return;
    sw.querySelectorAll(".cam-chip").forEach((b) => {
      const cam = b.dataset.cam;
      b.classList.toggle("on", cam ? F.cam === cam : !F.cam);
      if (cam) { b.disabled = !present(cam); b.title = present(cam) ? `${TIPS[cam]} · key ${F.ORDER.indexOf(cam) + 1}` : `This event has no ${NAMES[cam].toLowerCase()} camera video`; }
    });
    $("camMenu").querySelectorAll("input").forEach((cb) => (cb.checked = !hidden(cb.dataset.cam)));
    syncCamBtn();
    const nh = T.GRID.filter(hidden).length;
    $("btnCams").querySelector("span").textContent = nh ? `Cameras · ${6 - nh}/6` : "Cameras";
    const fs = F.isFullscreen();
    for (const id of ["btnFsStage", "btnFullscreen"]) { const b = $(id); b.classList.toggle("is-fs", fs); b.title = fs ? "Exit full screen (F)" : "Full screen (F)"; }
    applyZoom();
    syncBarVis();
  }
  F.sync = syncBar;

  // ── camera bar: on/off switch, floating position (per layout, fraction of the stage), first-time hint ──
  const CB = () => T.prefs.cameraBar;
  const MARGIN = 8, SNAP = 18;
  const layoutKey = () => (F.cam ? "focus" : "grid");
  F.barOn = () => !!CB().on;
  // ── dock: "over" (floating on the video, default) or "beside" (a strip above/below the video, like the map's dock) ──
  F.barDocked = () => CB().dock === "beside" && F.barOn() && !!P().ev;
  F.barDockH = () => { if (!F.barDocked()) return 0; const b = $("stageBar"); return (b && b.offsetHeight ? b.offsetHeight : 44) + 8; };
  function syncBarDock() {
    const bar = $("stageBar"), dock = $("barDock");
    if (!bar || !dock) return;
    const docked = F.barDocked();
    document.body.classList.toggle("bar-aside", docked);
    document.body.classList.toggle("bar-below", docked && CB().side === "bottom");
    dock.hidden = !docked;
    if (docked) { if (bar.parentElement !== dock) dock.appendChild(bar); bar.classList.remove("moved"); bar.style.left = bar.style.top = bar.style.transform = ""; }
    else if (bar.parentElement !== stage()) stage().insertBefore(bar, $("btnBarRestore"));
    const btn = $("btnBarDock");
    if (btn) {
      const on = CB().dock === "beside";
      btn.setAttribute("aria-pressed", String(on));
      btn.querySelector("span").textContent = on ? "On video" : "Beside video";
      btn.title = on ? "Put the camera bar back on the video" : "Move the camera bar off the video (above or below it)";
    }
    const cb = $("barAside"); if (cb) cb.checked = CB().dock === "beside";
    document.querySelectorAll("#segBarSide button").forEach((b) => b.classList.toggle("on", b.dataset.v === (CB().side || "top")));
  }
  /** Keep the dock strip glued to the stage's top or bottom edge (the stage itself is shifted by U.fit). */
  function placeDock() {
    const dock = $("barDock");
    if (!dock || dock.hidden) return;
    const st = stage(), h = F.barDockH();
    dock.style.left = st.offsetLeft + "px";
    dock.style.width = st.offsetWidth + "px";
    dock.style.top = (CB().side === "bottom" ? st.offsetTop + st.offsetHeight + 8 : st.offsetTop - h) + "px";
  }
  F.placeDock = placeDock;
  F.setBarDock = (dock, side) => {
    try {
      if (dock) T.prefs.cameraBar.dock = dock;
      if (side) T.prefs.cameraBar.side = side;
      T.savePrefs();
      syncBarDock();
      if (T.ui && T.ui.fit) T.ui.fit();
      placeBar();
    } catch (e) { console.warn("camera bar dock", e); T.prefs.cameraBar.dock = "over"; syncBarDock(); if (T.ui && T.ui.fit) T.ui.fit(); }
  };
  F.setBar = (on, quiet) => {
    T.setPref("cameraBar.on", !!on);
    if (!on) $("camMenu").hidden = true;
    syncBarVis();
    if (!quiet) T.toast(on ? "Camera bar is on" : "Camera bar hidden. Tap the little camera button on the video to bring it back.", on ? "ok" : "", 4500);
    wake();
  };
  function syncBarVis() {
    const on = F.barOn(), bar = $("stageBar");
    bar.hidden = !on;
    $("btnBarRestore").hidden = on || !P().ev;
    const sw = $("chipCamBar");
    sw.classList.toggle("on", on); sw.setAttribute("aria-pressed", String(on));
    sw.title = on ? "Camera bar is ON. Click to hide it (C)" : "Camera bar is OFF. Click to show it (C)";
    try { syncBarDock(); } catch (e) { console.warn(e); }
    if (on) { placeBar(); maybeHint(); } else $("barHint").hidden = true;
  }
  function spans() {
    const st = stage(), bar = $("stageBar");
    const W = st.clientWidth, H = st.clientHeight, bw = bar.offsetWidth, bh = bar.offsetHeight;
    return { W, H, bw, bh, sx: Math.max(0, W - bw - 2 * MARGIN), sy: Math.max(0, H - bh - 2 * MARGIN) };
  }
  /** Put the bar where it was left for this layout (default: top centre). Always inside the stage. */
  function placeBar() {
    const bar = $("stageBar");
    if (bar.hidden || F.dragging) return;
    if (F.barDocked()) { placeDock(); placeHint(); return; }
    const pos = CB()[layoutKey()];
    if (!(pos && pos.fx >= 0)) {
      bar.classList.remove("moved"); bar.style.left = bar.style.top = "";
      // default spot (top centre): step below the Self-Driving badge if they would overlap
      const fsd = $("panel-fsd");
      if (fsd && !fsd.hidden && fsd.offsetWidth) {
        const a = fsd.getBoundingClientRect(), b = bar.getBoundingClientRect(), sr = stage().getBoundingClientRect();
        if (a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right) bar.style.top = Math.round(a.bottom - sr.top + 6) + "px";
      }
      placeHint(); return;
    }
    bar.classList.add("moved");
    const s = spans();
    bar.style.left = Math.round(MARGIN + T.clamp(pos.fx, 0, 1) * s.sx) + "px";
    bar.style.top = Math.round(MARGIN + T.clamp(pos.fy, 0, 1) * s.sy) + "px";
    placeHint();
  }
  F.placeBar = placeBar;
  F.resetBarPos = () => {
    T.prefs.cameraBar[layoutKey()] = { fx: -1, fy: -1 }; T.savePrefs();
    placeBar(); T.toast("Camera bar is back at the top");
  };
  function barDrag() {
    const bar = $("stageBar");
    let d = null, lastTap = 0;
    bar.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); // never reaches tile focus or zoom-pan
      const grip = e.target.closest(".bar-grip");
      const empty = e.target === bar || e.target.matches(".cam-switch, .zoom-ctl, .cams-wrap, .zoom-label");
      if (!(grip || empty) || (e.pointerType === "mouse" && e.button !== 0)) return;
      e.preventDefault();
      const r = bar.getBoundingClientRect(), sr = stage().getBoundingClientRect();
      d = { id: e.pointerId, x: e.clientX, y: e.clientY, l: r.left - sr.left, t: r.top - sr.top, moved: false, grip: !!grip };
      try { bar.setPointerCapture(e.pointerId); } catch (_) {}
      F.dragging = true; bar.classList.add("dragging"); wake();
    });
    bar.addEventListener("pointermove", (e) => {
      if (!d || e.pointerId !== d.id) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 5) return;
      d.moved = true;
      if (F.barDocked()) { bar.style.transform = "translateY(" + Math.round(dy) + "px)"; return; }   // docked: drag up/down to switch side
      const s = spans();
      bar.classList.add("moved");
      bar.style.left = Math.round(T.clamp(d.l + dx, MARGIN, MARGIN + s.sx)) + "px";
      bar.style.top = Math.round(T.clamp(d.t + dy, MARGIN, MARGIN + s.sy)) + "px";
      placeHint(); wake();
    });
    const end = (e) => {
      if (!d || e.pointerId !== d.id) return;
      const was = d; d = null;
      F.dragging = false; bar.classList.remove("dragging");
      if (was.moved && F.barDocked()) {
        F.dragEnd = performance.now();
        bar.style.transform = "";
        const sr = stage().getBoundingClientRect();
        F.setBarDock("beside", e.clientY > sr.top + sr.height / 2 ? "bottom" : "top");
      } else if (was.moved) {
        F.dragEnd = performance.now();
        const s = spans();
        let l = parseFloat(bar.style.left) - MARGIN, t = parseFloat(bar.style.top) - MARGIN;
        // gentle snap: to the edges and to the horizontal centre
        if (l < SNAP) l = 0; else if (s.sx - l < SNAP) l = s.sx; else if (Math.abs(l - s.sx / 2) < SNAP) l = s.sx / 2;
        if (t < SNAP) t = 0; else if (s.sy - t < SNAP) t = s.sy;
        T.prefs.cameraBar[layoutKey()] = { fx: s.sx ? l / s.sx : 0.5, fy: s.sy ? t / s.sy : 0 };
        T.savePrefs();
        hideHint(true);
        placeBar();
      } else if (was.grip && e.type === "pointerup") {
        const now = performance.now();
        if (now - lastTap < 400) { lastTap = 0; F.resetBarPos(); } else lastTap = now; // double-click / double-tap the grip
      }
      wake();
    };
    bar.addEventListener("pointerup", end);
    bar.addEventListener("pointercancel", end);
    bar.addEventListener("dblclick", (e) => e.stopPropagation());
  }
  const hintHidden = () => !$("barHint") || $("barHint").hidden;
  function maybeHint() {
    if (CB().hintSeen || !P().ev || !F.barOn()) return;
    $("barHint").hidden = false; placeHint();
  }
  function hideHint(seen) {
    if ($("barHint")) $("barHint").hidden = true;
    if (seen && !CB().hintSeen) T.setPref("cameraBar.hintSeen", true);
    wake();
  }
  F.dismissHint = () => hideHint(true);
  function placeHint() {
    const h = $("barHint");
    if (!h || h.hidden) return;
    const bar = $("stageBar"), st = stage();
    h.classList.toggle("above", bar.offsetTop + bar.offsetHeight / 2 > st.clientHeight / 2);
  }

  F.init = () => {
    buildBar();
    // tap / click a tile in the grid → focus it; the corner button does the same (discoverable on hover)
    // on touch, a tap while the controls are faded only brings them back (it doesn't also enlarge a tile)
    window.addEventListener("pointerdown", (e) => {
      // only taps on the video wake-and-swallow (or anywhere in full screen, where every control fades);
      // the top bar and the transport never fade outside full screen, so taps there always act
      const onVideo = e.target && e.target.closest && e.target.closest("#stage");
      if (e.pointerType !== "mouse" && document.body.classList.contains("idle") && (F.isFullscreen() || (F.barOn() && onVideo))) F.tapWoke = performance.now();
      else F.tapWoke = 0; // controls already visible: the next tap acts normally
    }, { capture: true, passive: true });
    // the waking tap only wakes: the bar fades back in under the finger, so its click must not press a bar button
    // (or enlarge a tile). Swallowed once, in the capture phase, before any handler sees it.
    window.addEventListener("click", (e) => {
      if (!F.tapWoke || performance.now() - F.tapWoke > 700) return;
      F.tapWoke = 0;
      if (e.target.closest && e.target.closest(".tile-expand")) return;
      e.preventDefault(); e.stopPropagation();
    }, { capture: true });
    $("grid").addEventListener("click", (e) => {
      const tile = e.target.closest(".tile");
      if (!tile || F.cam || !P().ev) return;
      if (F.tapWoke && performance.now() - F.tapWoke < 700 && !e.target.closest(".tile-expand")) { F.tapWoke = 0; return; } // swallow only the waking tap
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
    $("chipCamBar").addEventListener("click", () => F.setBar(!F.barOn()));
    $("btnBarDock").addEventListener("pointerdown", (e) => e.stopPropagation());
    $("btnBarDock").addEventListener("click", (e) => { e.stopPropagation(); F.setBarDock(CB().dock === "beside" ? "over" : "beside"); });
    if ($("barAside")) $("barAside").addEventListener("change", (e) => F.setBarDock(e.target.checked ? "beside" : "over"));
    document.querySelectorAll("#segBarSide button").forEach((b) => b.addEventListener("click", () => F.setBarDock(null, b.dataset.v)));
    T.on("layout", placeDock);
    T.on("player-open", () => { syncBarDock(); });
    $("btnBarHide").addEventListener("click", (e) => { e.stopPropagation(); F.setBar(false); });
    $("btnBarRestore").addEventListener("click", (e) => { e.stopPropagation(); F.setBar(true); });
    $("btnHintOk").addEventListener("click", (e) => { e.stopPropagation(); hideHint(true); });
    barDrag();
    new ResizeObserver(() => placeBar()).observe(stage());
    T.on("layout", () => { placeBar(); requestAnimationFrame(() => placeBar()); });
    zoomInput();
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    ["pointermove", "pointerdown", "keydown", "wheel"].forEach((ev) => window.addEventListener(ev, wake, { passive: true }));
    window.addEventListener("resize", () => applyZoom());
    const onOrient = () => applyLayout(true); // rotating keeps the focus zoom/pan
    if (mqPortrait.addEventListener) mqPortrait.addEventListener("change", onOrient); else if (mqPortrait.addListener) mqPortrait.addListener(onOrient);
    T.on("player-open", () => { if (F.cam && !present(F.cam)) F.cam = null; applyLayout(); });
    T.on("prefs", (p) => { if (p === "*") syncBarVis(); });
    T.on("prefs", (p) => { if (p === "*" || p === "camsHidden") applyLayout(); });
    applyLayout();
    wake();
  };
})();
