/* overlays.js — live floating panels (HUD, map, self-driving badge) over the grid: drag to move, map resize,
 * click the route to seek. Positions are saved as fractions of the grid's free space (shared with export). */
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
    const move = T.el("button", "map-move", "Beside video");
    move.type = "button";
    move.title = "Move the map off the video. Export can still burn it in.";
    move.addEventListener("pointerdown", (e) => e.stopPropagation());
    move.addEventListener("click", (e) => {
      e.stopPropagation();
      T.setPref("mapDock", T.prefs.mapDock === "aside" ? "over" : "aside");
      if (T.ui && T.ui.fit) T.ui.fit();
      O.invalidate();
    });
    map.el.appendChild(move);
    makePanel("fsd", "fsd-panel");
    ["time", "telemetry", "prefs", "map-tile", "player-open", "library", "layout"].forEach((e) => T.on(e, O.invalidate));
    new ResizeObserver(O.invalidate).observe(stage);
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
    if (dock) {
      dock.hidden = !aside;
      if (aside) { if (map.el.parentElement !== dock) dock.appendChild(map.el); }
      else if (map.el.parentElement !== O.layer) O.layer.appendChild(map.el);
    }
    const btn = map.el.querySelector(".map-move");
    if (btn) {
      btn.textContent = aside ? "On video" : "Beside video";
      btn.title = aside ? "Put the map back on the video" : "Move the map off the video. Export can still burn it in.";
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
      if (aside) {
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
      const g = grid();
      const pos = T.prefs.panels[p.id];
      pos.fx = T.clamp(start.fx + dx / Math.max(1, g.w - p.w), 0, 1);
      pos.fy = T.clamp(start.fy + dy / Math.max(1, g.h - p.h), 0, 1);
      place(p, pos);
    });
    const end = (e) => {
      if (!start) return;
      p.el.classList.remove("dragging");
      if (start.moved) T.savePrefs();
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
