/* overlays.js — live floating panels (HUD, map, self-driving badge) over the grid: drag to move, map resize,
 * click the route to seek. Positions are saved as fractions of the grid's free space (shared with export).
 * The map has three homes (prefs.mapDock): "over" the video, "aside" (docked beside it) or "float": a window-level panel you drag by its
 * ⋮⋮ grip anywhere in the window (above the bottom controls), dropped near its dock spot (the right edge of the video area) it snaps back
 * to the dock. Its float position (prefs.mapFloat) is separate from the on-video position, so export is unchanged. */
(function () {
  "use strict";
  const T = window.TDC;
  const O = (T.overlays = { panels: {}, pending: false, stage: null });

  function makePanel(id, cls) {
    const el = T.el("div", "float-panel " + cls);
    el.id = "panel-" + id;
    const cv = document.createElement("canvas");
    el.appendChild(cv);
    O.layer.appendChild(el);
    const p = { id, el, cv, ctx: cv.getContext("2d"), w: 0, h: 0 };
    O.panels[id] = p;
    enableDrag(p);
    return p;
  }

  O.init = (stage, layer) => {
    O.stage = stage; O.layer = layer;
    makePanel("hud", "hud-panel");
    const map = makePanel("map", "map-panel");
    const grip = T.el("div", "resize-grip");
    grip.title = "Drag to resize the map";
    map.el.appendChild(grip);
    enableResize(map, grip);
    // grip: drag to float the map anywhere in the window (mouse, pen, touch); keyboard: Enter / Space floats or docks, arrows move it
    const mg = T.el("button", "map-grip");
    mg.type = "button"; mg.id = "mapGrip";
    mg.innerHTML = '<svg viewBox="0 0 14 22" aria-hidden="true"><circle cx="4" cy="4" r="1.7"/><circle cx="10" cy="4" r="1.7"/><circle cx="4" cy="11" r="1.7"/><circle cx="10" cy="11" r="1.7"/><circle cx="4" cy="18" r="1.7"/><circle cx="10" cy="18" r="1.7"/></svg>';
    map.el.appendChild(mg);
    wireFloat(map, mg);
    const move = T.el("button", "map-move", "Beside video");
    move.type = "button";
    move.title = "Move the map off the video. Export can still burn it in.";
    move.addEventListener("pointerdown", (e) => e.stopPropagation());
    move.addEventListener("click", (e) => {
      e.stopPropagation();
      T.setPref("mapDock", T.prefs.mapDock === "float" ? "aside" : T.prefs.mapDock === "aside" ? "over" : "aside");
      if (T.ui && T.ui.fit) T.ui.fit();
      O.invalidate();
    });
    map.el.appendChild(move);
    makePanel("fsd", "fsd-panel");
    ["time", "telemetry", "prefs", "map-tile", "player-open", "library", "layout"].forEach((e) => T.on(e, O.invalidate));
    new ResizeObserver(O.invalidate).observe(stage);
    addEventListener("resize", O.invalidate); addEventListener("orientationchange", () => setTimeout(O.invalidate, 60));
    if (window.visualViewport) visualViewport.addEventListener("resize", O.invalidate);
  };

  /** Free area for the panels: the stage, minus the bottom bars that float over it in full screen
   *  (transport, phone thumbnail strip), so the HUD is not hidden under them. */
  const grid = () => {
    const w = O.stage.clientWidth, h = O.stage.clientHeight;
    if (!document.body.classList.contains("fs")) return { x: 0, y: 0, w, h };
    const st = O.stage.getBoundingClientRect();
    let bottom = st.bottom;
    for (const id of ["transport", "usStrip"]) {
      const el = T.$(id);
      if (!el || el.hidden || !el.offsetHeight || getComputedStyle(el).position !== "fixed") continue;
      const r = el.getBoundingClientRect();
      if (r.top < bottom && r.bottom > st.top + h * 0.5) bottom = r.top;
    }
    return { x: 0, y: 0, w, h: Math.max(h * 0.5, Math.min(h, bottom - st.top)) };
  };
  const dpr = () => Math.min(3, window.devicePixelRatio || 1);

  function size(p, wCss, hCss) {
    const r = dpr();
    if (p.w !== wCss || p.h !== hCss) {
      p.w = wCss; p.h = hCss;
      p.el.style.width = wCss + "px"; p.el.style.height = hCss + "px";
    }
    const cw = Math.round(wCss * r), ch = Math.round(hCss * r);
    if (p.cv.width !== cw || p.cv.height !== ch) { p.cv.width = cw; p.cv.height = ch; }
    p.ctx.setTransform(1, 0, 0, 1, 0, 0);
    p.ctx.clearRect(0, 0, cw, ch);
  }
  function asideWanted() { return T.prefs.mapDock === "aside"; }
  const floatWanted = () => T.prefs.mapDock === "float";

  // ── floating map (window level) ──
  const FM = 8;   // margin to the window edges and the bottom controls
  const vw = () => document.documentElement.clientWidth || innerWidth, vh = () => innerHeight;
  /** y above which the floating map must stay: the top of the bottom controls (transport bar / phone bar, Search / Redact buttons, camera-bar chip). */
  O.floatFloor = () => {
    const H = vh(); let floor = H;
    for (const id of ["transport", "mbBar", "usBtn", "rdBtn", "chipCamBar", "btnFullscreen", "toolBubble"]) {
      const e = T.$(id); if (!e || e.hidden || !e.offsetParent && getComputedStyle(e).position !== "fixed") continue;
      if (id === "usBtn" || id === "rdBtn" ? !!e.closest("#toolBubble") : id === "toolBubble" && getComputedStyle(e).visibility === "hidden") continue;   // ui-glass-6: the bubble counts, not its fan
      const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || r.top < H * 0.4 || r.top >= H) continue;
      floor = Math.min(floor, r.top);
    }
    return floor;
  };
  function floatBox() {
    const mp = T.prefs.panels.map, W = vw(), floor = O.floatFloor(), phone = Math.min(W, vh()) < 600, portrait = vh() > W;
    const maxW = Math.max(160, Math.min(W - 2 * FM, phone ? (portrait ? W * 0.92 : W * 0.42) : Math.max(260, W * 0.36)));
    const maxH = Math.max(110, Math.min(floor - 2 * FM, phone ? (portrait ? vh() * 0.34 : (floor - 2 * FM)) : vh() * 0.5));
    const sc = Math.min(1, maxW / mp.wu, maxH / mp.hu);
    return { w: Math.round(mp.wu * sc), h: Math.round(mp.hu * sc), sc, floor };
  }
  /** spans the floating map can move in (left / top ranges) */
  const floatSpan = (w, h, floor) => ({ x0: FM, y0: FM, sx: Math.max(0, vw() - w - 2 * FM), sy: Math.max(0, floor - h - 2 * FM) });
  /** ui-glass-6: a map you place yourself may go further down than the floor, to the bottom of the window: only its grip (top left) has to stay
   *  above the bottom controls (transport bar / phone bar), so it can always be picked up again. Automatic placement still keeps above the floor. */
  const GRIP_KEEP = 44;
  O.deepFloor = () => {
    const H = vh(); let f = H;
    for (const id of ["transport", "mbBar"]) {
      const e = T.$(id); if (!e || e.hidden || !e.getClientRects().length) continue;
      const r = e.getBoundingClientRect(); if (r.height > 1 && r.top > H * 0.4 && r.top < f) f = r.top;
    }
    return f;
  };
  const deepMaxY = (s) => Math.max(s.y0 + s.sy, O.deepFloor() - GRIP_KEEP);
  function floatXY(w, h, floor) {
    const f = T.prefs.mapFloat || {}, s = floatSpan(w, h, floor);
    const fx = f.fx >= 0 ? f.fx : 1, fy = f.fy >= 0 ? f.fy : 0.08;   // default: top right
    const below = f.pin && f.below > 0 ? Math.min(f.below, deepMaxY(s) - s.y0 - s.sy) : 0;   // px you placed it below the floor
    return { x: s.x0 + T.clamp(fx, 0, 1) * s.sx, y: s.y0 + T.clamp(fy, 0, 1) * s.sy + Math.max(0, below) };
  }
  /** ui-glass-5: the floating map never covers the camera bar while that sits on (or beside) the video: it steps above or below the bar
   *  (else beside it), whichever is closer and fits. While the map is being dragged it goes where the finger is; it is placed again on drop. */
  function clearOfBar(x, y, w, h, s) {
    const b = T.$("stageBar");
    if (!b || b.hidden || b.classList.contains("bar-floating") || !b.getClientRects().length) return { x, y };
    const r = b.getBoundingClientRect(), m = 6;
    if (r.width < 2 || !(x < r.right + m && x + w > r.left - m && y < r.bottom + m && y + h > r.top - m)) return { x, y };
    const fitsY = (v) => v >= s.y0 - 0.5 && v <= s.y0 + s.sy + 0.5, fitsX = (v) => v >= s.x0 - 0.5 && v <= s.x0 + s.sx + 0.5;
    const ys = [r.top - m - h, r.bottom + m].filter(fitsY).sort((a, c) => Math.abs(a - y) - Math.abs(c - y));
    if (ys.length) return { x, y: ys[0] };
    const xs = [r.left - m - w, r.right + m].filter(fitsX).sort((a, c) => Math.abs(a - x) - Math.abs(c - x));
    return xs.length ? { x: xs[0], y } : { x, y };
  }
  function setFloatPos(p, x, y, save, live) {
    const s = floatSpan(p.w, p.h, O.floatFloor());
    const deep = live || save || (p.id === "map" && T.prefs.mapFloat && T.prefs.mapFloat.pin);   // placed by you: down to the window bottom, grip kept reachable
    x = T.clamp(x, s.x0, s.x0 + s.sx); y = T.clamp(y, s.y0, deep ? deepMaxY(s) : s.y0 + s.sy);
    // the map steps clear of the docked camera bar by itself, but a spot you chose (drag / keys: pin) is kept; the bar stays on top there
    if (!live && !save && p.id === "map" && !(T.prefs.mapFloat && T.prefs.mapFloat.pin)) { const c = clearOfBar(x, y, p.w, p.h, s); x = c.x; y = c.y; }
    p.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    if (save) {
      const below = Math.round(y - s.y0 - s.sy);
      T.prefs.mapFloat = { fx: s.sx ? +((x - s.x0) / s.sx).toFixed(4) : 0, fy: below > 0 ? 1 : s.sy ? +((y - s.y0) / s.sy).toFixed(4) : 0, pin: 1 };
      if (below > 0) T.prefs.mapFloat.below = below;
      T.savePrefs();
    }
    return { x, y };
  }
  /** dock spot = the right edge of the video area, where the docked map sits (body.map-aside puts it there) */
  function dockSpot() {
    const vp = T.$("viewport"); if (!vp) return null;
    const r = vp.getBoundingClientRect(); if (r.width < 50) return null;
    const w = Math.min(260, r.width * 0.3);
    return { l: r.right - w, t: r.top + r.height * 0.15, r: r.right, b: r.bottom - r.height * 0.15 };
  }
  const nearDock = (cx, cy) => { const d = dockSpot(); return !!d && cx >= d.l && cx <= d.r + 40 && cy >= d.t && cy <= d.b; };
  let dockHint = null;
  function showDockHint(on) {
    if (on && !dockHint) { dockHint = T.el("div", "map-dock-hint"); dockHint.textContent = "Release to dock the map"; document.body.appendChild(dockHint); }
    if (!dockHint) return;
    const d = dockSpot(); dockHint.hidden = !on || !d;
    if (on && d) Object.assign(dockHint.style, { left: d.l + "px", top: d.t + "px", width: (d.r - d.l - 6) + "px", height: (d.b - d.t) + "px" });
  }
  O.setMapHome = (home, quiet) => {
    T.setPref("mapDock", home);
    if (T.ui && T.ui.fit) T.ui.fit();
    O.invalidate();
    if (!quiet) T.toast(home === "float" ? "Map floats: drag ⋮⋮ anywhere, drop it at the right edge of the video to dock it" : home === "aside" ? "Map docked beside the video" : "Map is on the video", "ok", 2600);
  };
  /** grip drag (same feel as the camera bar's ⋮⋮: 5 px before it moves, edges snap, double-click / double-tap docks or floats) */
  function wireFloat(p, g) {
    let d = null, lastTap = 0, swallow = false;
    g.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();
      const r = p.el.getBoundingClientRect();
      d = { id: e.pointerId, x: e.clientX, y: e.clientY, l: r.left, t: r.top, moved: false };
      try { g.setPointerCapture(e.pointerId); } catch (_) {}
    });
    // move / up are read on the window: lifting the map re-parents it (out of the video or the dock), which drops pointer capture
    addEventListener("pointermove", (e) => {
      if (!d || e.pointerId !== d.id) return;
      e.preventDefault();
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved) {
        if (Math.hypot(dx, dy) < 5) return;
        d.moved = true; p.el.classList.add("dragging");
        if (!floatWanted()) {   // lift it out of the video / dock, keeping it under the finger
          T.prefs.mapDock = "float"; T.savePrefs(); T.emit("prefs", "mapDock"); if (T.ui && T.ui.fit) T.ui.fit(); O.render();
          d.l = e.clientX - 20; d.t = e.clientY - 18; d.x = e.clientX; d.y = e.clientY;   // grip (top-left) stays under the pointer
        }
      }
      setFloatPos(p, d.l + (e.clientX - d.x), d.t + (e.clientY - d.y), false, true);
      d.near = nearDock(e.clientX, e.clientY); showDockHint(d.near); p.el.classList.toggle("dock-near", d.near);
    });
    const end = (e) => {
      if (!d || e.pointerId !== d.id) return;
      const was = d; d = null; p.el.classList.remove("dragging", "dock-near"); showDockHint(false);
      if (was.moved) {
        swallow = true; setTimeout(() => { swallow = false; }, 0);
        if (was.near) { O.setMapHome("aside"); return; }
        const r = p.el.getBoundingClientRect(), s = floatSpan(p.w, p.h, O.floatFloor());
        let x = r.left, y = r.top; const SNAP = 18;
        if (x - s.x0 < SNAP) x = s.x0; else if (s.x0 + s.sx - x < SNAP) x = s.x0 + s.sx;
        if (y - s.y0 < SNAP) y = s.y0; else if (Math.abs(s.y0 + s.sy - y) < SNAP) y = s.y0 + s.sy;   // ui-glass-6: further down than the floor is kept (no snap back)
        setFloatPos(p, x, y, true); T.savePrefs();
      } else if (e.type === "pointerup") {
        const now = performance.now();
        if (now - lastTap < 400) { lastTap = 0; O.setMapHome(floatWanted() ? "aside" : "float"); } else lastTap = now;
      }
    };
    addEventListener("pointerup", end); addEventListener("pointercancel", end);
    g.addEventListener("click", (e) => {
      e.stopPropagation();
      if (swallow) return;
      if (e.detail === 0) O.setMapHome(floatWanted() ? "aside" : "float");   // keyboard Enter / Space (pointer taps use double-tap above)
    });
    g.addEventListener("dblclick", (e) => e.stopPropagation());
    g.addEventListener("keydown", (e) => {
      const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!k) return;
      e.preventDefault(); e.stopPropagation();
      if (!floatWanted()) { O.setMapHome("float", true); O.render(); }
      const r = p.el.getBoundingClientRect(), st = e.shiftKey ? 64 : 16;
      setFloatPos(p, r.left + k[0] * st, r.top + k[1] * st, true);
    });
  }
  O.dockWidth = (maxH, maxW) => {
    if (!asideWanted() || !T.prefs.show.map || !T.player.ev) return 0;
    const mp = T.prefs.panels.map;
    const capW = Math.min(520, Math.max(180, maxW * 0.4));
    const sc = Math.min(1, maxH / mp.hu, capW / mp.wu);
    return Math.round(mp.wu * Math.max(0.35, sc));
  };
  function dockBox() {
    const mp = T.prefs.panels.map;
    const vp = T.$("viewport");
    const maxH = Math.max(160, (vp ? vp.clientHeight : 600) - 24);
    const maxW = vp ? vp.clientWidth : 1200;
    const w = O.dockWidth(maxH, maxW);
    return { w, h: Math.round(mp.hu * (w / mp.wu)) };
  }
  function syncDock(mapOn) {
    const aside = mapOn && asideWanted();
    document.body.classList.toggle("map-aside", aside);
    const dock = T.$("mapDock");
    const map = O.panels.map;
    const fl = mapOn && floatWanted();
    map.el.classList.toggle("map-floating", fl);
    document.body.classList.toggle("map-float", fl);
    if (dock) {
      dock.hidden = !aside;
      if (aside) { if (map.el.parentElement !== dock) dock.appendChild(map.el); }
      else if (fl) { if (map.el.parentElement !== document.body) document.body.appendChild(map.el); }
      else if (map.el.parentElement !== O.layer) O.layer.appendChild(map.el);
    }
    const mg = T.$("mapGrip");
    if (mg) {
      const lbl = fl ? "Move the map (drag, or arrow keys). Enter docks it beside the video; drop it at the right edge of the video to dock" : "Float the map: drag it anywhere in the window (or press Enter, then arrow keys)";
      mg.setAttribute("aria-label", lbl); mg.title = fl ? "Drag to move · double-click to dock" : "Drag to float the map anywhere · double-click to float";
    }
    const btn = map.el.querySelector(".map-move");
    if (btn) {
      btn.textContent = fl ? "Dock" : aside ? "On video" : "Beside video";
      btn.title = fl ? "Dock the map beside the video" : aside ? "Put the map back on the video" : "Move the map off the video. Export can still burn it in.";
    }
    const cb = T.$("mapAside");
    if (cb && cb.checked !== aside) cb.checked = aside;
  }
  function place(p, pos) {
    const g = grid();
    const xy = T.compositor.place(g, p.w, p.h, pos);
    p.el.style.transform = `translate(${Math.round(xy.x)}px, ${Math.round(xy.y)}px)`;
  }

  O.invalidate = () => {
    if (O.pending) return;
    O.pending = true;
    requestAnimationFrame(() => { O.pending = false; O.render(); });
  };

  O.render = () => {
    if (!O.stage || !O.stage.clientHeight) return;
    const ev = T.player.ev;
    const t = T.player.time;
    const tel = T.telemetry;
    const show = T.prefs.show;
    const g = grid();
    const s = T.compositor.liveScale(g.w, g.h);
    const r = dpr();
    O.stage.classList.toggle("hide-labels", !show.labels);
    // HUD
    const hud = O.panels.hud;
    const lay = T.hud.layout(tel.status);
    const hudOn = !!ev && show.hud && lay.mode !== "empty";
    hud.el.hidden = !hudOn;
    if (hudOn) {
      size(hud, lay.w * s, lay.h * s);
      place(hud, T.prefs.panels.hud);
      hud.ctx.scale(s * r, s * r);
      const info = tel.total > 1 ? `Clip ${Math.min(tel.parsed + 1, tel.total)} of ${tel.total}` : "";
      T.hud.draw(hud.ctx, lay, tel.at(t), tel.status, info);
      if (tel.status === "parsing" || tel.status === "queued") O.invalidate();
    }
    // map
    const map = O.panels.map;
    const hasLoc = tel.route().length > 0 || (ev && ev.location && ev.location.lat != null);
    const mapOn = !!ev && show.map && (hasLoc || tel.status === "parsing" || tel.status === "partial");
    map.el.hidden = !mapOn;
    if (mapOn) {
      const mp = T.prefs.panels.map;
      const aside = asideWanted();
      if (floatWanted()) {
        const fb = floatBox();
        size(map, fb.w, fb.h);
        const xy = floatXY(fb.w, fb.h, fb.floor);
        if (!map.el.classList.contains("dragging")) setFloatPos(map, xy.x, xy.y, false);
        map.ctx.scale(fb.sc * r, fb.sc * r);
        T.map.draw(map.ctx, mp.wu, mp.hu, fb.sc * r, t);
      } else if (aside) {
        const box = dockBox();
        size(map, box.w, box.h);
        map.el.style.transform = "none";
        const sc = box.w / mp.wu;
        map.ctx.scale(sc * r, sc * r);
        T.map.draw(map.ctx, mp.wu, mp.hu, sc * r, t);
      } else {
        size(map, mp.wu * s, mp.hu * s);
        place(map, mp);
        map.ctx.scale(s * r, s * r);
        T.map.draw(map.ctx, mp.wu, mp.hu, s * r, t);
      }
    }
    syncDock(mapOn);
    // self-driving badge
    const fsd = O.panels.fsd;
    const st = tel.at(t);
    const fsdOn = !!ev && show.fsd && !!st;
    fsd.el.hidden = !fsdOn;
    if (fsdOn) {
      const bw = T.hud.badgeWidth(fsd.ctx, st);
      size(fsd, bw * s, T.hud.BADGE_H * s);
      place(fsd, T.prefs.panels.fsd);
      fsd.ctx.scale(s * r, s * r);
      T.hud.drawBadge(fsd.ctx, bw, st);
    }
    // timestamp pill
    const ts = T.$("stageTime");
    if (ts) {
      const d = T.player.wallClock();
      ts.hidden = !(ev && show.time);
      ts.textContent = d ? T.compositor.stamp(d) : T.fmtTime(t, true);
    }
  };

  function enableDrag(p) {
    let start = null;
    p.el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.classList.contains("resize-grip") || e.target.classList.contains("map-move")) return;
      if (p.id === "map" && asideWanted()) return;
      if (e.target.closest(".map-grip")) return;
      e.preventDefault();
      p.el.setPointerCapture(e.pointerId);
      const pos = T.prefs.panels[p.id];
      start = { x: e.clientX, y: e.clientY, fx: pos.fx, fy: pos.fy, moved: false, ox: e.offsetX, oy: e.offsetY };
      p.el.classList.add("dragging");
    });
    p.el.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 4) return;
      start.moved = true;
      if (p.id === "map" && floatWanted()) { const fr = start.fr || (start.fr = p.el.getBoundingClientRect()); setFloatPos(p, fr.left + dx, fr.top + dy, false, true); return; }
      const g = grid();
      const pos = T.prefs.panels[p.id];
      pos.fx = T.clamp(start.fx + dx / Math.max(1, g.w - p.w), 0, 1);
      pos.fy = T.clamp(start.fy + dy / Math.max(1, g.h - p.h), 0, 1);
      place(p, pos);
    });
    const end = (e) => {
      if (!start) return;
      p.el.classList.remove("dragging");
      if (start.moved && p.id === "map" && floatWanted()) { const r = p.el.getBoundingClientRect(); setFloatPos(p, r.left, r.top, true); }
      else if (start.moved) T.savePrefs();
      else if (p.id === "map") {
        const rect = p.cv.getBoundingClientRect();
        const r = dpr();
        const tm = T.map.hit((e.clientX - rect.left) * r, (e.clientY - rect.top) * r);
        if (tm != null) { T.player.seek(tm); T.toast("Jumped to " + T.fmtTime(tm, true) + " on the route"); }
      }
      start = null;
      O.invalidate();
    };
    p.el.addEventListener("pointerup", end);
    p.el.addEventListener("pointercancel", end);
  }

  function enableResize(p, grip) {
    let st = null;
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      const mp = T.prefs.panels.map;
      st = { x: e.clientX, y: e.clientY, wu: mp.wu, hu: mp.hu, s: Math.max(0.2, p.w / mp.wu) };
    });
    grip.addEventListener("pointermove", (e) => {
      if (!st) return;
      const mp = T.prefs.panels.map;
      mp.wu = T.clamp(st.wu + (e.clientX - st.x) / st.s, 220, 1100);
      mp.hu = T.clamp(st.hu + (e.clientY - st.y) / st.s, 160, 800);
      if (asideWanted() && T.ui && T.ui.fit) T.ui.fit();
      else O.invalidate();
    });
    const end = () => { if (st) { st = null; T.savePrefs(); } };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }
})();
