/* custom-redact.js — custom redaction regions (tag custom-redact).
 * A region is a user-drawn box or freehand shape on ONE camera's picture, hidden with a strong blur or an opaque black fill, for the whole
 * clip or a time range. It is for what the automatic redaction misses (a curved plate in the rear fisheye, a house number, a face).
 *
 *   region = { id, cam, shape: "rect" | "poly", x, y, w, h (bounding box), pts: [x0, y0, x1, y1, …] (poly only),
 *              mode: "blur" | "remove", start: seconds | null, end: seconds | null, on: true, v: 1 }
 *   Coordinates are 0..1 of the camera's RAW picture (the frame, without the black bars of the tile, before any mirroring). Times are seconds
 *   on the event timeline (the same t the player and the exporter use, so trimmed / joined sections need no special case).
 *
 * One painter (paint) serves the viewer's redact layer (redact.js paintLive → G.live: the layer is mirrored and zoomed together with the video by
 * CSS, so raw coordinates land on the same pixels) and the exporter (compositor.drawFrame → G.burn, inside the flipped cell of a mirrored camera).
 * Blur uses redact.js' own shrink-and-enlarge blur (no canvas filter: Safari has none) with a radius tied to the region's short side, so text
 * inside can't be read; Remove fills the shape with opaque black. 360 (flat equirect) export: the regions are burned into the camera frames
 * before they are projected (prepareFrames). Not covered: the live 360 "look around" view.
 * tap-redact: no camera dropdown. "Draw region" asks you to TAP the camera (several cameras on screen) and then draws on it: a tap enlarges that
 * camera and arms the drag, a drag starting on a camera draws right there. One camera on screen: it is the camera, no question asked. The draw bar
 * shows the chosen camera as a chip; tapping the chip picks again.
 * Storage: localStorage "tdc.regions.v1" keyed by a hash of the event's file names and sizes (nothing leaves the device); JSON file import / export. */
(function () {
  "use strict";
  const T = window.TDC;
  const R = T.redact;
  const $ = (id) => document.getElementById(id);
  const G = (T.regions = { list: [], key: null, MAX: 40, MAX_PTS: 96, KEY: "tdc.regions.v1", ui: { cam: null, shape: "rect", mode: "blur", whole: true, from: 0, to: 0, draft: null, editId: null, drawing: false, pick: false } });
  const EMPTY = [];
  let byCam = {};

  // ── model ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const clamp01 = (v) => Math.min(1, Math.max(0, +v || 0));
  const isNum = (v) => typeof v === "number" && isFinite(v);
  /** Validate / clamp one region (from storage, a file or the editor). Returns null when it is unusable. */
  G.clean = (o, keepId) => {
    if (!o || typeof o !== "object" || !T.GRID.includes(o.cam)) return null;
    const r = { id: keepId && o.id ? String(o.id) : "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), cam: o.cam, shape: o.shape === "poly" ? "poly" : "rect",
      mode: o.mode === "remove" ? "remove" : "blur", start: isNum(o.start) && o.start > 0 ? o.start : null, end: isNum(o.end) && o.end >= 0 ? o.end : null, on: o.on !== false, sticky: !!o.sticky, v: 1 };
    if (r.end != null && r.start != null && r.end < r.start) { const s = r.start; r.start = r.end; r.end = s; }
    if (r.shape === "poly") {
      let p = Array.isArray(o.pts) ? o.pts.map(Number) : [];
      if (p.length % 2) p.pop();
      if (p.length < 6 || p.some((v) => !isFinite(v))) return null;
      p = p.map(clamp01);
      if (p.length > G.MAX_PTS * 2) { const q = []; const n = p.length / 2, st = n / G.MAX_PTS; for (let i = 0; i < G.MAX_PTS; i++) { const j = Math.floor(i * st); q.push(p[j * 2], p[j * 2 + 1]); } p = q; }
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
      r.pts = p.map((v) => Math.round(v * 10000) / 10000); r.x = x0; r.y = y0; r.w = x1 - x0; r.h = y1 - y0;
    } else { r.x = clamp01(o.x); r.y = clamp01(o.y); r.w = Math.min(1 - r.x, clamp01(o.w)); r.h = Math.min(1 - r.y, clamp01(o.h)); }
    if (r.w < 0.004 || r.h < 0.004) return null;
    for (const k of ["x", "y", "w", "h"]) r[k] = Math.round(r[k] * 10000) / 10000;
    return r;
  };
  function rebuild() {
    byCam = {};
    for (const r of G.list) if (r.on) (byCam[r.cam] = byCam[r.cam] || []).push(r);
  }
  /** Regions that apply to this camera at event time t (shared empty array when none: no cost on the playback path). */
  G.at = (cam, t) => {
    const l = byCam[cam];
    if (!l) return EMPTY;
    let out = null;
    for (const r of l) if ((r.start == null || t >= r.start - 1e-6) && (r.end == null || t <= r.end + 1e-6)) (out = out || []).push(r);
    return out || EMPTY;
  };
  G.any = () => G.list.some((r) => r.on);

  // ── storage ────────────────────────────────────────────────────────────────────────────────────────────────────
  const mem = {};
  function fnv(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }
  /** Fingerprint of an event: its file names and sizes and length (not the footage itself, not shown anywhere). */
  G.eventKey = (ev) => {
    if (!ev) return null;
    let s = (ev.id || "") + "|" + Math.round(ev.duration || 0);
    try { for (const c of ev.clips || []) for (const cam of Object.keys(c.files || {})) { const f = c.files[cam]; s += "|" + cam + ":" + (f && (f.name || f.path) || "") + ":" + (f && f.size || 0); } } catch (_) {}
    return "e" + fnv(s) + "-" + (s.length % 997);
  };
  function readAll() { try { const o = JSON.parse(localStorage.getItem(G.KEY) || "null"); return o && o.events ? o : { v: 1, events: {} }; } catch (_) { return { v: 1, events: {} }; } }
  G.save = () => {
    if (!G.key) return;
    mem[G.key] = JSON.parse(JSON.stringify(G.list));
    try {
      const all = readAll();
      if (G.list.length) all.events[G.key] = { at: Date.now(), regions: G.list }; else delete all.events[G.key];
      const keys = Object.keys(all.events).sort((a, b) => all.events[b].at - all.events[a].at);
      keys.slice(60).forEach((k) => delete all.events[k]);
      localStorage.setItem(G.KEY, JSON.stringify(all));
      G.storeOk = true;
    } catch (_) { G.storeOk = false; }
  };
  G.load = () => {
    const ev = T.player && T.player.ev;
    G.key = G.eventKey(ev);
    let l = [];
    if (G.key) {
      l = mem[G.key] || (readAll().events[G.key] || {}).regions || [];
    }
    G.list = l.map((o) => G.clean(o, true)).filter((r) => r && r.sticky).slice(0, G.MAX);
    G.resetHistory();
    rebuild();
  };
  /* ui-glass-7: undo / redo of region changes (add, edit, move, delete, on/off, clear, load from file) for this session and this event.
     Snapshots of the list (at most 40 small objects); the stored format and the burn-in are untouched. A new event starts a fresh history. */
  const H = (G.hist = { u: [], r: [], MAX: 60 });
  const RH = {};   // per-region undo/redo: RH[id] = { u: [snapshots], r: [snapshots] }
  const snap = () => JSON.stringify(G.list);
  function record() { H.u.push(snap()); if (H.u.length > H.MAX) H.u.shift(); H.r.length = 0; }
  G.canUndo = () => H.u.length > 0;
  G.canRedo = () => H.r.length > 0;
  function restore(json) { G.list = JSON.parse(json).map((o) => G.clean(o, true)).filter(Boolean).slice(0, G.MAX); changed(); }
  G.undo = () => { if (!H.u.length) return false; H.r.push(snap()); restore(H.u.pop()); return true; };
  G.redo = () => { if (!H.r.length) return false; H.u.push(snap()); restore(H.r.pop()); return true; };
  G.resetHistory = () => { H.u.length = 0; H.r.length = 0; };
  function changed(keepUi) {
    rebuild(); G.save();
    if (R && R.paint) R.paint();
    if (UI.sync) UI.sync(keepUi);
    if (T.emit) T.emit("regions", G.list.length);
  }
  G.add = (o) => {
    const r = G.clean(o);
    if (!r) return null;
    if (G.list.length >= G.MAX) return null;
    record(); G.list.push(r); changed(); return r;
  };
  G.update = (id, o) => {
    const i = G.list.findIndex((r) => r.id === id);
    if (i < 0) return null;
    const r = G.clean(Object.assign({}, G.list[i], o, { id }), true);
    if (!r) return null;
    if (JSON.stringify(r) === JSON.stringify(G.list[i])) return r;   // nothing changed: no history step
    record();
    if (!RH[id]) RH[id] = { u: [], r: [] };
    RH[id].u.push(JSON.stringify(G.list[i])); if (RH[id].u.length > 20) RH[id].u.shift(); RH[id].r.length = 0;
    G.list[i] = r; changed(); return r;
  };
  G.undoRegion = (id) => {
    const h = RH[id]; if (!h || !h.u.length) return false;
    const cur = G.list.find((r) => r.id === id); if (!cur) return false;
    h.r.push(JSON.stringify(cur));
    const prev = JSON.parse(h.u.pop());
    const i = G.list.findIndex((r) => r.id === id);
    if (i >= 0) G.list[i] = G.clean(Object.assign(prev, { id }), true);
    changed(); return true;
  };
  G.redoRegion = (id) => {
    const h = RH[id]; if (!h || !h.r.length) return false;
    const cur = G.list.find((r) => r.id === id); if (!cur) return false;
    h.u.push(JSON.stringify(cur));
    const next = JSON.parse(h.r.pop());
    const i = G.list.findIndex((r) => r.id === id);
    if (i >= 0) G.list[i] = G.clean(Object.assign(next, { id }), true);
    changed(); return true;
  };
  G.canUndoRegion = (id) => !!(RH[id] && RH[id].u.length);
  G.canRedoRegion = (id) => !!(RH[id] && RH[id].r.length);
  G.remove = (id) => { if (!G.list.some((r) => r.id === id)) return; record(); delete RH[id]; G.list = G.list.filter((r) => r.id !== id); if (S.trackIds) { S.trackIds = S.trackIds.filter((x) => x !== id); delete S.patches[id]; } changed(); };
  G.sticky = (id, on) => { const r = G.list.find((x) => x.id === id); if (!r) return; r.sticky = on === undefined ? !r.sticky : !!on; changed(); return r.sticky; };
  G.clear = () => { if (G.list.length) { record(); G.list = []; changed(); } };
  G.toJSON = () => JSON.stringify({ type: "dashcam-studio-regions", version: 1, regions: G.list.map((r) => { const o = Object.assign({}, r); delete o.id; return o; }) }, null, 2);
  /** Add regions from a JSON file's text. Returns { added, skipped } or throws a plain-English Error. */
  G.fromJSON = (text) => {
    let o; try { o = JSON.parse(text); } catch (_) { throw new Error("That file is not a Dashcam Studio regions file."); }
    const arr = Array.isArray(o) ? o : o && o.type === "dashcam-studio-regions" && Array.isArray(o.regions) ? o.regions : null;
    if (!arr) throw new Error("That file is not a Dashcam Studio regions file.");
    let added = 0, skipped = 0; const before = snap();
    for (const x of arr) { const r = G.clean(x); if (r && G.list.length < G.MAX) { G.list.push(r); added++; } else skipped++; }
    if (added) { H.u.push(before); if (H.u.length > H.MAX) H.u.shift(); H.r.length = 0; changed(); }
    return { added, skipped };
  };

  // ── painter ────────────────────────────────────────────────────────────────────────────────────────────────────
  /** Trace the region's outline (pixel rect of the contain-fit `fit`). Rectangles snap OUTWARD to whole pixels so Remove leaves no seam. */
  function trace(ctx, fit, r) {
    if (r.shape === "poly" && r.pts) {
      ctx.moveTo(fit.x + r.pts[0] * fit.w, fit.y + r.pts[1] * fit.h);
      for (let i = 2; i < r.pts.length; i += 2) ctx.lineTo(fit.x + r.pts[i] * fit.w, fit.y + r.pts[i + 1] * fit.h);
      ctx.closePath();
    } else {
      const x0 = Math.floor(fit.x + r.x * fit.w), y0 = Math.floor(fit.y + r.y * fit.h), x1 = Math.ceil(fit.x + (r.x + r.w) * fit.w), y1 = Math.ceil(fit.y + (r.y + r.h) * fit.h);
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
    }
  }
  /** Blur strength: cells about 40% of the region's short side, never smaller than 6 px. A 200 × 30 px plate becomes ~17 × 2 cells: no stroke survives. */
  G.radius = (dw, dh) => Math.max(6, Math.round(Math.min(dw, dh) * 0.4));
  function paint(ctx, img, iw, ih, fit, r) {
    ctx.save();
    ctx.beginPath(); trace(ctx, fit, r);
    if (r.mode === "remove") {
      ctx.fillStyle = "#000"; ctx.globalAlpha = 1; ctx.fill();
      if (r.shape === "poly") { ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5; ctx.lineJoin = "round"; ctx.stroke(); }   // the anti-aliased edge: no light fringe
    } else {
      ctx.clip();
      if (typeof VideoFrame !== "undefined" && img instanceof VideoFrame) img = R.frameCanvas(img, iw, ih);   // WebKit ignores the source rect of a decoded frame
      const dx = fit.x + r.x * fit.w, dy = fit.y + r.y * fit.h, dw = Math.max(2, r.w * fit.w), dh = Math.max(2, r.h * fit.h);
      const sx = r.x * iw, sy = r.y * ih, sw = r.w * iw, sh = r.h * ih, pad = 0.25;
      R.softBlur(ctx, img, iw, ih, sx - sw * pad, sy - sh * pad, sw * (1 + 2 * pad), sh * (1 + 2 * pad), dx - dw * pad, dy - dh * pad, dw * (1 + 2 * pad), dh * (1 + 2 * pad), G.radius(dw, dh));
    }
    ctx.restore();
  }
  G.paint = paint;
  /** Export: draw this camera's regions at time t into cell `cell` (ctx is already flipped for a mirrored camera). */
  G.burn = (ctx, cam, t, cell, iw, ih, img) => {
    const rs = G.at(cam, t);
    if (!rs.length || !iw || !ih) return;
    const fit = R.contain(iw, ih, cell);
    for (const r of rs) paint(ctx, img, iw, ih, fit, r);
  };
  /** Viewer: the redact layer of this camera (tile tw × th css px); video is the <video>. */
  G.live = (ctx, cam, t, video, tw, th) => {
    const rs = G.at(cam, t);
    if (!rs.length) return;
    const iw = video.videoWidth, ih = video.videoHeight, fit = R.contain(iw, ih, { x: 0, y: 0, w: tw, h: th });
    for (const r of rs) {
      paint(ctx, video, iw, ih, fit, r);
      if (S.trackIds && S.trackIds.includes(r.id)) {
        ctx.save(); ctx.strokeStyle = "#e6b450"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.beginPath(); trace(ctx, fit, r); ctx.stroke(); ctx.restore();
      }
      if (r.mode === "blur" && R.tintLike) { ctx.save(); ctx.beginPath(); trace(ctx, fit, r); ctx.clip(); R.tintLike(ctx, fit, [{ x: r.x, y: r.y, w: r.w, h: r.h }], cam); ctx.restore(); }
    }
  };
  const pf = {};
  /** 360 equirect export: frames with the regions burned in (a copy per camera that has an active region; the others pass through untouched). */
  G.prepareFrames = (frames, t) => {
    let out = frames;
    for (const cam of Object.keys(frames || {})) {
      const f = frames[cam], rs = f && f.img ? G.at(cam, t) : EMPTY;
      if (!rs.length) continue;
      if (out === frames) out = Object.assign({}, frames);
      const c = pf[cam] || (pf[cam] = document.createElement("canvas"));
      if (c.width !== f.w || c.height !== f.h) { c.width = f.w; c.height = f.h; }
      const x = c.getContext("2d"); x.drawImage(f.img, 0, 0, f.w, f.h);
      const fit = { x: 0, y: 0, w: f.w, h: f.h };
      for (const r of rs) paint(x, c, f.w, f.h, fit, r);
      out[cam] = Object.assign({}, f, { img: c });
    }
    return out;
  };

  // ── screen mapping (editor) ────────────────────────────────────────────────────────────────────────────────────
  /** Where the camera's raw picture is on screen right now (client px), after the tile's contain-fit, zoom and mirror. */
  G.screenFit = (cam) => {
    const tile = T.player && T.player.tiles && T.player.tiles[cam];
    if (!tile) return null;
    const v = tile.vids[T.player.active];
    if (!v || !v.videoWidth) return null;
    const vr = v.getBoundingClientRect();
    if (!vr.width || !vr.height) return null;
    const s = Math.min(vr.width / v.videoWidth, vr.height / v.videoHeight), w = v.videoWidth * s, h = v.videoHeight * s;
    return { x: vr.left + (vr.width - w) / 2, y: vr.top + (vr.height - h) / 2, w, h, mirrored: !!(T.layout && T.layout.mirrored(cam)), tile: tile.tile };
  };
  /** client px → raw 0..1 (mirror undone); and back. */
  G.toRaw = (f, cx, cy) => { let u = (cx - f.x) / f.w; const v = (cy - f.y) / f.h; if (f.mirrored) u = 1 - u; return [clamp01(u), clamp01(v)]; };
  G.toScreen = (f, u, v) => [f.x + (f.mirrored ? 1 - u : u) * f.w, f.y + v * f.h];
  /** Ramer–Douglas–Peucker on a flat [x, y, …] list (iterative). */
  G.simplify = (p, eps) => {
    const n = p.length / 2;
    if (n < 3) return p.slice();
    const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
    const st = [[0, n - 1]];
    while (st.length) {
      const [a, b] = st.pop(); let md = 0, mi = -1;
      const ax = p[a * 2], ay = p[a * 2 + 1], bx = p[b * 2], by = p[b * 2 + 1], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
      for (let i = a + 1; i < b; i++) { const d = Math.abs((p[i * 2] - ax) * dy - (p[i * 2 + 1] - ay) * dx) / L; if (d > md) { md = d; mi = i; } }
      if (md > eps && mi > 0) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
    }
    const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
    return out;
  };

  // ── editor UI ──────────────────────────────────────────────────────────────────────────────────────────────────
  const UI = (G.UI = {});
  const S = G.ui;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const camName = (c) => (T.CAM_LABEL && T.CAM_LABEL[c]) || c;
  const fmt = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = t - m * 60; return m + ":" + (s < 10 ? "0" : "") + s.toFixed(1); };
  const parseT = (s) => { s = String(s || "").trim(); if (!s) return NaN; const m = s.split(":").map(Number); if (m.some((x) => !isFinite(x) || x < 0) || m.length > 3) return NaN; return m.reduce((a, x) => a * 60 + x, 0); };
  const dur = () => (T.player && T.player.ev ? T.player.ev.duration || 0 : 0);
  function msg(text, bad) {
    const m = $("crMsg"), b = $("crBarMsg");
    if (m) { m.textContent = text || ""; m.classList.toggle("bad", !!bad); }
    if (b) { b.textContent = text || ""; b.classList.toggle("bad", !!bad); }
  }
  const overlays = {};
  function overlayFor(cam) {
    const tile = T.player.tiles[cam]; if (!tile) return null;
    let o = overlays[cam];
    if (!o || o.cv.parentNode !== tile.tile) {
      const cv = document.createElement("canvas"); cv.className = "cr-overlay"; cv.setAttribute("aria-hidden", "true");
      tile.tile.appendChild(cv); o = overlays[cam] = { cv, sig: "" };
      wirePointer(cam, cv);
    }
    return o;
  }
  function removeOverlays() { for (const c of Object.keys(overlays)) { overlays[c].cv.remove(); delete overlays[c]; } syncPicks([]); }
  /** Cameras showing on screen right now (present in the event, tile not hidden, laid out). */
  function visibleCams() {
    const P = T.player, ev = P && P.ev; if (!ev || !P.tiles) return [];
    return T.GRID.filter((c) => { const t = P.tiles[c]; if (!t || !(ev.cams || []).includes(c) || t.tile.classList.contains("off")) return false; const r = t.tile.getBoundingClientRect(); return r.width > 4 && r.height > 4; });
  }
  /** Several cameras on screen (grid / 6-up): the user has to say which one. One big camera: that one is it. */
  const isMulti = () => !(T.focus && T.focus.cam) && visibleCams().length > 1;
  // the pick layer: one real <button> per camera tile (Tab / Enter work, a label says what to do). It lets the pointer through: the tile's drawing canvas takes the tap or the drag.
  const picks = {};
  function syncPicks(want) {
    for (const c of Object.keys(picks)) if (!want.includes(c) || picks[c].parentNode !== (T.player.tiles[c] || {}).tile) { picks[c].remove(); delete picks[c]; }
    for (const c of want) {
      if (picks[c]) continue;
      const tile = T.player.tiles[c]; if (!tile) continue;
      const b = document.createElement("button"); b.type = "button"; b.className = "cr-pick"; b.dataset.cam = c;
      b.setAttribute("aria-label", "Redact the " + camName(c) + " camera");
      b.innerHTML = '<span class="cr-pick-n">' + esc(camName(c)) + '</span><span class="cr-pick-h">Tap to redact</span>';
      b.addEventListener("click", (e) => { e.stopPropagation(); choose(c, "key"); });   // keyboard Enter / Space (a pointer tap lands on the canvas instead)
      tile.tile.appendChild(b); picks[c] = b;
    }
  }
  const hot = (cam, on) => { const b = picks[cam]; if (b) b.classList.toggle("hot", !!on); };
  function shapeOf(o) { return o ? (o.shape === "poly" ? { shape: "poly", pts: o.pts } : { shape: "rect", x: o.x, y: o.y, w: o.w, h: o.h }) : null; }

  function drawOutline(ctx, f, tr, sh, strong, label) {
    ctx.beginPath();
    if (sh.shape === "poly") { sh.pts.forEach((v, i) => { if (i % 2) return; const [x, y] = G.toScreen(f, v, sh.pts[i + 1]); i ? ctx.lineTo(x - tr.left, y - tr.top) : ctx.moveTo(x - tr.left, y - tr.top); }); ctx.closePath(); }
    else { const [xa, ya] = G.toScreen(f, sh.x, sh.y), [xb, yb] = G.toScreen(f, sh.x + sh.w, sh.y + sh.h); ctx.rect(Math.min(xa, xb) - tr.left, Math.min(ya, yb) - tr.top, Math.abs(xb - xa), Math.abs(yb - ya)); }
    if (strong) { ctx.fillStyle = "rgba(230,180,80,0.18)"; ctx.fill(); }
    ctx.lineWidth = strong ? 2.5 : 1.5; ctx.strokeStyle = "rgba(0,0,0,0.75)"; ctx.setLineDash([]); ctx.stroke();
    ctx.lineWidth = strong ? 1.5 : 1; ctx.strokeStyle = strong ? "#ffd27a" : "rgba(255,255,255,0.8)"; ctx.setLineDash(strong ? [] : [5, 4]); ctx.stroke(); ctx.setLineDash([]);
  }
  /** ui-glass-7: the selected region in Move: corner handles (a box can be resized from them) and a small tag ("Blur · Box"). */
  function bboxOf(sh) {
    if (sh.shape !== "poly") return { x: sh.x, y: sh.y, w: sh.w, h: sh.h };
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0; const p = sh.pts;
    for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function cornersOf(f, sh) {   // screen corners of a box: [raw corner, anchor (the opposite corner), screen point]
    const b = bboxOf(sh), c = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]];
    return c.map((k, i) => ({ k, a: c[3 - i], s: G.toScreen(f, k[0], k[1]) }));
  }
  function drawHandles(ctx, f, tr, sh, tag) {
    if (sh.shape !== "poly") for (const c of cornersOf(f, sh)) { ctx.fillStyle = "#ffd27a"; ctx.strokeStyle = "rgba(0,0,0,.8)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.rect(c.s[0] - tr.left - 5, c.s[1] - tr.top - 5, 10, 10); ctx.fill(); ctx.stroke(); }
    const cs = cornersOf(f, sh), x = Math.min(...cs.map((c) => c.s[0])) - tr.left, y = Math.min(...cs.map((c) => c.s[1])) - tr.top;
    ctx.font = "600 11px -apple-system, system-ui, sans-serif"; const w = ctx.measureText(tag).width + 12, ty = y > 22 ? y - 20 : y + 4;
    ctx.fillStyle = "rgba(20,24,32,.85)"; ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, ty, w, 16, 8); else ctx.rect(x, ty, w, 16); ctx.fill();
    ctx.fillStyle = "#ffe3a3"; ctx.fillText(tag, x + 6, ty + 12);
  }
  let raf = 0;
  const drawClass = () => { document.body.classList.toggle("cr-drawing", !!(S.drawing || S.pick || S.move)); document.body.classList.toggle("cr-picking", !!S.pick); };   // while you draw, the HUD / map / car-view panels let the pointer through (they used to grab a stroke that began over them)
  function frame() {
    raf = 0; drawClass();
    const cams = new Set();
    let multi = false;
    if (S.pick || S.drawing) {
      multi = isMulti();
      if (S.pick && !multi) { const one = (T.focus && T.focus.cam) || visibleCams()[0]; if (one) choose(one, "auto"); }   // the user showed one camera some other way (camera bar, number key): that is the camera
    }
    if (multi) visibleCams().forEach((c) => cams.add(c));
    if (S.cam && (S.drawing || S.draft || S.editId || S.move)) cams.add(S.cam);
    if (S.peek) cams.add(S.peek.cam);
    syncPicks(S.pick && multi ? [...cams] : []);
    for (const c of Object.keys(overlays)) if (!cams.has(c)) { const o = overlays[c]; if (o.sig !== "") { const x = o.cv.getContext("2d"); x.clearRect(0, 0, o.cv.width, o.cv.height); o.sig = ""; } o.cv.style.pointerEvents = "none"; }
    for (const cam of cams) {
      const o = overlayFor(cam), f = G.screenFit(cam); if (!o) continue;
      const tr = f ? f.tile.getBoundingClientRect() : o.cv.parentNode.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.max(1, Math.round(tr.width * dpr)), h = Math.max(1, Math.round(tr.height * dpr));
      const live = S.live;   // the shape being dragged
      const sig = [w, h, f ? [f.x, f.y, f.w, f.h, f.mirrored].map((v) => Math.round(v)).join(",") : "x", JSON.stringify(shapeOf(S.draft)), S.peek ? JSON.stringify(S.peek.sh) : "", live ? live.pts.length + ":" + live.pts[live.pts.length - 1] + live.pts[live.pts.length - 2] : "", G.list.map((r) => r.id + r.x + r.y + r.w + r.h + r.mode).join(), S.editId, S.drawing, S.pick, S.cam, S.move, S.sel, S.mv ? JSON.stringify(S.mv.sh) : ""].join("|");
      o.cv.style.pointerEvents = (S.pick && multi) || (S.drawing && f && (cam === S.cam || multi)) || (S.move && f && cam === S.cam) ? "auto" : "none";
      if (o.sig === sig) continue;
      o.sig = sig;
      if (o.cv.width !== w || o.cv.height !== h) { o.cv.width = w; o.cv.height = h; }
      const ctx = o.cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, tr.width, tr.height);
      if (!f) continue;
      for (const r of G.list) if (r.cam === cam && r.id !== S.editId && !(S.move && r.id === S.sel)) drawOutline(ctx, f, tr, shapeOf(r), false);
      if (S.move && S.sel && cam === S.cam) { const r = G.list.find((x) => x.id === S.sel); if (r) { const sh = S.mv && S.mv.id === r.id ? S.mv.sh : shapeOf(r); drawOutline(ctx, f, tr, sh, true); drawHandles(ctx, f, tr, sh, (r.mode === "remove" ? "Remove" : "Blur") + " · " + (r.shape === "poly" ? "Freehand" : "Box")); } }
      if (S.draft && cam === S.cam) drawOutline(ctx, f, tr, shapeOf(S.draft), true);
      if (S.peek && S.peek.cam === cam) drawOutline(ctx, f, tr, S.peek.sh, true);
      if (live) {
        const sh = S.shape === "free" ? { shape: "poly", pts: live.pts.length >= 4 ? live.pts : null } : { shape: "rect", x: Math.min(live.pts[0], live.pts[live.pts.length - 2]), y: Math.min(live.pts[1], live.pts[live.pts.length - 1]), w: Math.abs(live.pts[live.pts.length - 2] - live.pts[0]), h: Math.abs(live.pts[live.pts.length - 1] - live.pts[1]) };
        if (sh.shape === "rect" || sh.pts) drawOutline(ctx, f, tr, sh, true);
        else { ctx.beginPath(); live.pts.forEach((v, i) => { if (i % 2) return; const [x, y] = G.toScreen(f, v, live.pts[i + 1]); i ? ctx.lineTo(x - tr.left, y - tr.top) : ctx.moveTo(x - tr.left, y - tr.top); }); ctx.lineWidth = 2; ctx.strokeStyle = "#ffd27a"; ctx.stroke(); }
        // freehand: show only key points (start, end, and tap points) — not every intermediate sample
        if (S.shape === "free" && live.pts.length >= 2) {
          ctx.fillStyle = "#ffd27a"; ctx.strokeStyle = "rgba(0,0,0,.8)"; ctx.lineWidth = 1.5;
          const marks = new Set([0, live.pts.length - 2]);
          if (live.strokes) for (const s of live.strokes) marks.add(s);
          for (const i of marks) {
            if (i < 0 || i >= live.pts.length) continue;
            const [x, y] = G.toScreen(f, live.pts[i], live.pts[i + 1]);
            ctx.beginPath(); ctx.arc(x - tr.left, y - tr.top, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          }
        }
      }
    }
    if ((S.drawing || S.pick || S.draft || S.editId || S.peek || S.move) && !raf) raf = requestAnimationFrame(frame);
  }
  function kick() { if (!raf) raf = requestAnimationFrame(frame); }

  function wirePointer(cam, cv) {
    let id = null, pend = null;
    const stop = (e) => { e.stopPropagation(); };
    const SLOP = (e) => (e.pointerType === "mouse" ? 6 : 12);
    cv.addEventListener("click", stop); cv.addEventListener("dblclick", stop);
    /** A stroke begins at client point (x, y) on this camera: raw coordinates, mirror undone. */
    function begin(x, y) {
      const f = G.screenFit(cam); if (!f) return false;
      const [u, v] = G.toRaw(f, x, y);
      // freehand: single point; box: two points for the rect
      S.live = { pts: S.shape === "free" ? [u, v] : [u, v, u, v], strokes: [0], f, c0: [x, y], cb: [x, y, x, y] };
      UI.avoidBar(x, y, S.live.cb);
      kick(); return true;
    }
    cv.addEventListener("pointerover", (e) => { if (S.pick && e.pointerType === "mouse") hot(cam, true); });
    cv.addEventListener("pointerout", (e) => { if (e.pointerType === "mouse" && id === null) hot(cam, false); });
    cv.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (id !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
      if (S.move && cam === S.cam) { moveDown(cam, e); return; }
      // Track mode: always capture the gesture, even if no camera chosen yet
      if (S.track) {
        e.preventDefault(); id = e.pointerId; try { cv.setPointerCapture(id); } catch (_) {}
        pend = { x: e.clientX, y: e.clientY, track: true, cam }; return;
      }
      if (S.pick || (S.drawing && S.cam !== cam)) {   // no camera chosen yet (or another camera of the grid): wait to see whether this is a tap or a drag
        if (!S.pick && !S.drawing) return;
        e.preventDefault(); id = e.pointerId; try { cv.setPointerCapture(id); } catch (_) {}
        pend = { x: e.clientX, y: e.clientY }; hot(cam, true); return;
      }
      if (!S.drawing) return;
      const f = G.screenFit(cam); if (!f) return;
      e.preventDefault(); id = e.pointerId;
      try { cv.setPointerCapture(id); } catch (_) {}
      // freehand: press on a key point moves it; otherwise short press adds a point, drag continues
      if (S.shape === "free") {
        if (S.live && S.live.pts.length >= 2) {
          const f2 = G.screenFit(cam) || S.live.f;
          const R = e.pointerType === "mouse" ? 14 : 24;
          const marks = new Set([0, S.live.pts.length - 2]);
          if (S.live.strokes) for (const s of S.live.strokes) marks.add(s);
          for (const i of [...marks].reverse()) {
            if (i < 0 || i >= S.live.pts.length) continue;
            const [sx, sy] = G.toScreen(f2, S.live.pts[i], S.live.pts[i + 1]);
            if (Math.hypot(sx - e.clientX, sy - e.clientY) <= R) {
              S.live.dragIdx = i;
              return;
            }
          }
        }
        pend = { x: e.clientX, y: e.clientY, freeTap: true };
        return;
      }
      begin(e.clientX, e.clientY);
    });
    cv.addEventListener("pointermove", (e) => {
      if (id !== e.pointerId) return;
      if (S.live && S.live.dragIdx != null) {
        e.stopPropagation(); e.preventDefault();
        const f = G.screenFit(cam) || S.live.f, [u, v] = G.toRaw(f, e.clientX, e.clientY);
        S.live.pts[S.live.dragIdx] = u; S.live.pts[S.live.dragIdx + 1] = v;
        S.live.last = [u, v];
        kick(); return;
      }
      if (pend) {   // a drag that starts on a camera: that camera is the one, and the stroke goes on right there
        e.stopPropagation(); e.preventDefault();
        const dist = Math.hypot(e.clientX - pend.x, e.clientY - pend.y);
        // freehand: a short move stays a tap; a drag continues the same shape
        const need = pend.freeTap ? 12 : SLOP(e);
        if (dist < need) return;
        const p0 = pend; pend = null;
        S.cam = cam; S.pick = false; S.draft = null; S.drawing = true; hot(cam, false);
        UI.sync();
        if (S.shape === "free" && S.live) {
          // continue the same shape: add the drag start point, then pointermove adds more
          const f = G.screenFit(cam) || S.live.f, [u, v] = G.toRaw(f, p0.x, p0.y);
          const pts = S.live.pts;
          if (pts.length < 4000) { if (!S.live.strokes) S.live.strokes = [0]; S.live.strokes.push(pts.length); pts.push(u, v); S.live.redo = []; }
          S.live.last = [u, v];
        } else if (!begin(p0.x, p0.y)) { id = null; try { cv.releasePointerCapture(e.pointerId); } catch (_) {} return; }
      }
      if (!S.live) return;
      e.stopPropagation(); e.preventDefault();
      const f = G.screenFit(cam) || S.live.f, [u, v] = G.toRaw(f, e.clientX, e.clientY), p = S.live.pts;
      if (S.shape === "free") {
        const lx = p[p.length - 2], ly = p[p.length - 1];
        if (Math.hypot((u - lx) * f.w, (v - ly) * f.h) >= 3 && p.length < 4000) p.push(u, v);
      } else { p[2] = u; p[3] = v; }
      S.live.last = [u, v];
      const L = S.live, c = L.cb, c0 = L.c0;
      if (S.shape === "free") { c[0] = Math.min(c[0], e.clientX); c[1] = Math.min(c[1], e.clientY); c[2] = Math.max(c[2], e.clientX); c[3] = Math.max(c[3], e.clientY); }
      else { c[0] = Math.min(c0[0], e.clientX); c[1] = Math.min(c0[1], e.clientY); c[2] = Math.max(c0[0], e.clientX); c[3] = Math.max(c0[1], e.clientY); }
      UI.avoidBar(e.clientX, e.clientY, c);
    });
    const end = (e) => {
      if (id !== e.pointerId) return;
      e.stopPropagation(); id = null;
      try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
      if (S.live && S.live.dragIdx != null) { S.live.dragIdx = null; kick(); return; }
      if (pend && pend.track) {
        const p0 = pend; pend = null;
        dbg("gesture captured on " + cam);
        const tc = p0.cam || cam;
        const f = G.screenFit(tc); if (!f) { msg("Camera not ready.", true); return; }
        const [u, v] = G.toRaw(f, p0.x, p0.y);
        const [u2, v2] = G.toRaw(f, e.clientX, e.clientY);
        const x = Math.min(u, u2), y = Math.min(v, v2), w = Math.max(0.02, Math.abs(u2 - u)), h = Math.max(0.02, Math.abs(v2 - v));
        S.cam = tc;
        trackAt(tc, x, y, w, h);
        return;
      }
      if (pend) {   // a tap
        const wasFreeTap = pend.freeTap;
        pend = null; hot(cam, false);
        if (e.type === "pointercancel") return;
        // freehand: tap adds a point (non-continuous); double-tap or close to start completes
        if (S.drawing && S.shape === "free" && (wasFreeTap || S.cam === cam)) {
          if (!S.live) begin(e.clientX, e.clientY);
          if (!S.live) return;
          const f = G.screenFit(cam) || S.live.f, [u, v] = G.toRaw(f, e.clientX, e.clientY);
          const pts = S.live.pts;
          const lx = pts[pts.length - 2], ly = pts[pts.length - 1];
          const nearStart = pts.length >= 6 && Math.hypot((u - pts[0]) * f.w, (v - pts[1]) * f.h) < 20;
          const nearLast = Math.hypot((u - lx) * f.w, (v - ly) * f.h) < 8;
          const now = Date.now(), last = S.live.lastTap || 0;
          const isDbl = (now - last) < 400 && nearLast;
          S.live.lastTap = now;
          if (nearStart || (isDbl && pts.length >= 6)) {
            finishShape(cam, S.live);
            return;
          }
          // always add the point; nearLast only skips if it's truly the same spot and we already have points
          if (pts.length < 4000 && !(nearLast && pts.length > 2)) { if (!S.live.strokes) S.live.strokes = [0]; S.live.strokes.push(pts.length); pts.push(u, v); S.live.redo = []; }
          S.live.last = [u, v];
          msg("Tap to add points. Double-tap or tap near the start to finish.");
          UI.sync(); kick();
          if (R && R.paint) R.paint();
          return;
        }
        if (!S.drawing || S.cam !== cam) choose(cam, "tap");
        return;
      }
      const live = S.live;
      if (!live || e.type === "pointercancel") return;
      // freehand: leave the shape open so more taps or drags can continue it; only double-tap / Done finishes
      if (S.shape === "free") {
        msg("Tap or drag to add. Double-tap or tap near the start to finish.");
        UI.sync(); kick();
        if (R && R.paint) R.paint();
        return;
      }
      S.live = null;
      finishShape(cam, live);
    };
    cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
    cv.addEventListener("touchmove", (e) => { if (S.drawing || S.pick || S.move) e.preventDefault(); }, { passive: false });   // iOS Safari: no page scroll / rubber band while drawing or picking
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  /* ---- ui-glass-7: Move / adjust a saved region ----
     A press on a region of the camera selects it; a drag moves it, a drag from a corner handle of a box resizes it. One history step per drag.
     No pointer capture (Mac Safari): the drag follows window pointermove / pointerup. */
  const rawOf = (f, cx, cy) => { let u = (cx - f.x) / f.w; if (f.mirrored) u = 1 - u; return [u, (cy - f.y) / f.h]; };
  function regionAt(cam, f, cx, cy) {
    const [u, v] = rawOf(f, cx, cy), pad = 8 / Math.max(1, Math.min(f.w, f.h));
    const sel = G.list.find((r) => r.id === S.sel && r.cam === cam);
    const list = G.list.filter((r) => r.cam === cam).reverse();
    if (sel) list.unshift(sel);
    return list.find((r) => u >= r.x - pad && u <= r.x + r.w + pad && v >= r.y - pad && v <= r.y + r.h + pad) || null;
  }
  function moveDown(cam, e) {
    const f = G.screenFit(cam); if (!f) return;
    e.preventDefault();
    const R0 = e.pointerType === "mouse" ? 10 : 22;
    let r = G.list.find((x) => x.id === S.sel && x.cam === cam), kind = "move", anchor = null;
    if (r && r.shape !== "poly") { const c = cornersOf(f, r).find((k) => Math.hypot(k.s[0] - e.clientX, k.s[1] - e.clientY) <= R0); if (c) { kind = "size"; anchor = c.a; } }
    if (kind === "move") r = regionAt(cam, f, e.clientX, e.clientY);
    if (!r) { S.sel = null; msg("Press a region to select it, then drag it. Drag a box's corner to resize it.", false); UI.sync(); kick(); return; }
    S.sel = r.id; const pid = e.pointerId, p0 = rawOf(f, e.clientX, e.clientY), sh0 = shapeOf(r), bb = bboxOf(sh0);
    S.mv = { id: r.id, sh: sh0 };
    const mv = (ev) => {
      if (ev.pointerId !== pid) return; ev.preventDefault();
      const ff = G.screenFit(cam) || f, p = rawOf(ff, ev.clientX, ev.clientY);
      if (kind === "size") {
        const q = [clamp01(p[0]), clamp01(p[1])], x = Math.min(anchor[0], q[0]), y = Math.min(anchor[1], q[1]);
        S.mv.sh = { shape: "rect", x, y, w: Math.max(0.01, Math.abs(q[0] - anchor[0])), h: Math.max(0.01, Math.abs(q[1] - anchor[1])) };
      } else {
        const du = Math.min(1 - bb.x - bb.w, Math.max(-bb.x, p[0] - p0[0])), dv = Math.min(1 - bb.y - bb.h, Math.max(-bb.y, p[1] - p0[1]));
        S.mv.sh = sh0.shape === "poly" ? { shape: "poly", pts: sh0.pts.map((t, i) => t + (i % 2 ? dv : du)) } : { shape: "rect", x: sh0.x + du, y: sh0.y + dv, w: sh0.w, h: sh0.h };
      }
      UI.avoidBar(ev.clientX, ev.clientY, null); kick();
    };
    const up = (ev) => {
      if (ev.pointerId !== pid) return;
      removeEventListener("pointermove", mv, true); removeEventListener("pointerup", up, true); removeEventListener("pointercancel", up, true);
      const m = S.mv; S.mv = null;
      if (m && ev.type !== "pointercancel") { const { shape, ...rest } = m.sh; void shape; G.update(m.id, rest); }
      UI.sync(); kick();
    };
    addEventListener("pointermove", mv, true); addEventListener("pointerup", up, true); addEventListener("pointercancel", up, true);
    UI.sync(); kick();
  }
  /** Move mode on / off. On: the drawing pauses, the regions of this camera can be pressed and dragged. Off: back to drawing on the same camera. */
  UI.move = (on) => {
    on = on === undefined ? !S.move : !!on;
    if (on) {
      if (!S.cam || S.pick || S.draft || S.editId) return false;
      const mine = G.list.filter((r) => r.cam === S.cam);
      if (!mine.length) { msg("No saved regions on the " + camName(S.cam).toLowerCase() + " camera to move yet.", true); return false; }
      S.move = true; S.drawing = false; S.live = null; if (!mine.some((r) => r.id === S.sel)) S.sel = mine[mine.length - 1].id;
      msg("Move: drag a region to move it, drag a corner to resize. Arrow keys nudge it.");
    } else { S.move = false; S.sel = null; S.mv = null; if (S.cam) { S.drawing = true; msg(camName(S.cam) + ": drag on the picture to draw."); } }
    UI.sync(); kick(); return true;
  };
  UI.nudge = (dx, dy) => {
    const r = G.list.find((x) => x.id === S.sel); if (!r) return;
    const sh = shapeOf(r), bb = bboxOf(sh), du = Math.min(1 - bb.x - bb.w, Math.max(-bb.x, dx)), dv = Math.min(1 - bb.y - bb.h, Math.max(-bb.y, dy));
    G.update(r.id, sh.shape === "poly" ? { pts: sh.pts.map((t, i) => t + (i % 2 ? dv : du)) } : { x: r.x + du, y: r.y + dv });
  };
  /** Undo / redo: an unsaved shape first (it is not in the list yet), then the region history. */
  UI.canUndo = () => !!(S.draft && !S.editId) || (S.shape === "free" && S.live && S.live.pts && S.live.pts.length > 2) || G.canUndo();
  UI.canRedo = () => !!(S.undone && !S.draft) || (S.live && S.live.redo && S.live.redo.length) || G.canRedo();
  UI.undo = () => {
    // while drawing freehand: undo removes the last stroke (tap or drag segment)
    if (S.shape === "free" && S.live && S.live.pts && S.live.pts.length > 2 && S.drawing) {
      const st = S.live.strokes || [0];
      const cut = st.length > 1 ? st.pop() : 0;
      const removed = S.live.pts.slice(cut);
      if (!S.live.redo) S.live.redo = [];
      S.live.redo.push({ cut, pts: removed });
      S.live.pts.length = Math.max(2, cut);
      if (S.live.pts.length <= 2) {
        // keep the shape restorable: stash it so redo can bring it back
        S.undone = { shape: "poly", pts: removed, cam: S.cam, mode: S.mode };
        S.live = null; msg("Shape undone. Redo to restore.");
      } else msg("Last point undone.");
      UI.sync(); kick();
      if (R && R.paint) R.paint();
      return true;
    }
    if (S.draft && !S.editId && !S.move) { S.undone = S.draft; S.draft = null; S.drawing = !!S.cam; msg("Shape undone. Redo to restore."); UI.sync(); kick(); return true; }
    if (S.sel && G.undoRegion && G.undoRegion(S.sel)) { msg("Region undone."); kick(); return true; }
    if (S.editId && G.undoRegion && G.undoRegion(S.editId)) { msg("Region undone."); kick(); return true; }
    if (!S.drawing && G.undo()) { msg("Undone."); kick(); return true; }
    return false;
  };
  UI.redo = () => {
    // freehand shape was fully undone: restore it as a draft
    if (S.undone && S.undone.shape === "poly" && !S.draft && !S.live && S.drawing) {
      S.draft = S.undone; S.undone = null; S.drawing = false;
      msg("Shape restored."); UI.sync(); kick();
      if (R && R.paint) R.paint();
      return true;
    }
    // while drawing freehand: redo restores the last undone stroke
    if (S.shape === "free" && S.live && S.live.redo && S.live.redo.length && S.drawing) {
      const r = S.live.redo.pop();
      if (!S.live.strokes) S.live.strokes = [0];
      S.live.strokes.push(S.live.pts.length);
      S.live.pts.push(...r.pts);
      msg("Point redone.");
      UI.sync(); kick();
      if (R && R.paint) R.paint();
      return true;
    }
    if (S.undone && !S.draft && !S.move) { S.draft = S.undone; S.undone = null; S.drawing = false; msg("Shape back."); UI.sync(); kick(); return true; }
    if (G.redo()) { msg("Redone."); kick(); return true; }
    return false;
  };
  /** Track mode: circle anything; a patch tracker follows it (signs, cats, logos, cars). */
  S.track = false;
  S.trackIds = [];
  S.patches = {};
  UI.track = (on) => {
    S.track = on === undefined ? !S.track : !!on;
    if (S.track) {
      S.drawing = true; S.pick = false; armTrackCapture();
      const latest = S.draft || (G.list.length && G.list[G.list.length - 1]);
      if (latest && latest.cam && !S.trackIds.includes(latest.id)) {
        const patch = grabPatch(latest.cam, latest.x, latest.y, latest.w, latest.h);
        if (patch) { S.trackIds.push(latest.id); S.patches[latest.id] = patch; msg("Tracking the region you already drew."); }
        else msg("Track on. Circle anything, or redraw the region.");
      } else msg("Track: circle anything. It follows by matching the look.");
    }
    else { msg("Track off."); disarmTrackCapture(); }
    UI.sync(); kick(); return true;
  };
  let trackCap = null;
  function armTrackCapture() {
    if (trackCap) return;
    trackCap = (e) => {
      if (!S.track || e.button !== 0) return;
      const tile = e.target.closest && e.target.closest(".tile");
      if (!tile) return;
      const cam = tile.dataset && tile.dataset.cam;
      if (!cam) return;
      e.preventDefault(); e.stopPropagation();
      const p0 = { x: e.clientX, y: e.clientY, cam };
      const ring = document.createElement("div"); ring.style.cssText = "position:fixed;border:2px solid #e6b450;border-radius:4px;pointer-events:none;z-index:90;"; document.body.appendChild(ring);
      const move = (ev) => {
        p0.x2 = ev.clientX; p0.y2 = ev.clientY;
        const x = Math.min(p0.x, p0.x2), y = Math.min(p0.y, p0.y2), w = Math.abs(p0.x2 - p0.x), h = Math.abs(p0.y2 - p0.y);
        ring.style.left = x + "px"; ring.style.top = y + "px"; ring.style.width = w + "px"; ring.style.height = h + "px";
      };
      const up = (ev) => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        ring.remove();
        const f = G.screenFit(cam); if (!f) return;
        const [u, v] = G.toRaw(f, p0.x, p0.y);
        const [u2, v2] = G.toRaw(f, p0.x2 || p0.x, p0.y2 || p0.y);
        const x = Math.min(u, u2), y = Math.min(v, v2), w = Math.max(0.03, Math.abs(u2 - u)), h = Math.max(0.03, Math.abs(v2 - v));
        startTrack(cam, x, y, w, h);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    };
    document.addEventListener("pointerdown", trackCap, true);
  }
  function disarmTrackCapture() { if (trackCap) { document.removeEventListener("pointerdown", trackCap, true); trackCap = null; } }
  function grabPatch(cam, x, y, w, h) {
    const tile = T.player && T.player.tiles && T.player.tiles[cam];
    const v = tile && (tile.video || (tile.vids && tile.vids[T.player.active]));
    if (!v || !v.videoWidth) return null;
    const c = document.createElement("canvas"); c.width = 24; c.height = 24;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    try { ctx.drawImage(v, x * v.videoWidth, y * v.videoHeight, w * v.videoWidth, h * v.videoHeight, 0, 0, 24, 24); } catch (_) { return null; }
    const d = ctx.getImageData(0, 0, 24, 24).data;
    const g = new Float32Array(24 * 24);
    let mean = 0;
    for (let i = 0; i < g.length; i++) { g[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3; mean += g[i]; }
    mean /= g.length;
    for (let i = 0; i < g.length; i++) g[i] -= mean;
    return g;
  }
  function matchPatch(cam, patch, lx, ly, lw, lh) {
    const tile = T.player && T.player.tiles && T.player.tiles[cam];
    const v = tile && (tile.video || (tile.vids && tile.vids[T.player.active]));
    if (!v || !v.videoWidth || !patch) return null;
    const c = document.createElement("canvas"); c.width = 40; c.height = 40;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const pad = Math.max(lw, lh) * 0.5;
    const sx = Math.max(0, (lx - pad) * v.videoWidth), sy = Math.max(0, (ly - pad) * v.videoHeight);
    const sw = Math.min(v.videoWidth - sx, (lw + pad * 2) * v.videoWidth), sh = Math.min(v.videoHeight - sy, (lh + pad * 2) * v.videoHeight);
    try { ctx.drawImage(v, sx, sy, sw, sh, 0, 0, 40, 40); } catch (_) { return null; }
    const d = ctx.getImageData(0, 0, 40, 40).data;
    let best = -1e9, bx = 8, by = 8;
    for (let oy = 0; oy <= 16; oy += 2) for (let ox = 0; ox <= 16; ox += 2) {
      let dot = 0, n2 = 0, mean = 0, n = 0;
      for (let j = 0; j < 24; j += 2) for (let i = 0; i < 24; i += 2) {
        const p = ((oy + j) * 40 + (ox + i)) * 4;
        mean += (d[p] + d[p + 1] + d[p + 2]) / 3; n++;
      }
      mean /= n;
      for (let j = 0; j < 24; j += 2) for (let i = 0; i < 24; i += 2) {
        const p = ((oy + j) * 40 + (ox + i)) * 4;
        const g = (d[p] + d[p + 1] + d[p + 2]) / 3 - mean;
        const t = patch[j * 24 + i];
        dot += g * t; n2 += g * g;
      }
      const score = n2 > 1 ? dot / Math.sqrt(n2) : 0;
      if (score > best) { best = score; bx = ox; by = oy; }
    }
    const cx = (lx * v.videoWidth - sx) / sw * 40, cy = (ly * v.videoHeight - sy) / sh * 40;
    const dx = (bx - cx) / 40 * sw / v.videoWidth, dy = (by - cy) / 40 * sh / v.videoHeight;
    return { x: lx + dx, y: ly + dy, w: lw, h: lh, score: best };
  }
  function startTrack(cam, x, y, w, h) {
    const patch = grabPatch(cam, x, y, w, h);
    if (!patch) { msg("Couldn't read the picture. Seek or play, then circle again.", true); return; }
    let r;
    if (S.shape === "free" && S.draft && S.draft.cam === cam && S.draft.pts) {
      r = G.add({ cam, shape: "poly", pts: S.draft.pts.slice(), mode: S.mode, on: true });
      S.draft = null;
    } else {
      r = G.add({ cam, shape: "rect", x, y, w, h, mode: S.mode, on: true });
    }
    if (r) { S.trackIds.push(r.id); S.patches[r.id] = { patch, ox: r.x, oy: r.y }; msg("Tracking. Play to follow. Circle more, or press Done."); UI.sync(); kick(); }
  }
  function dbg(s) {
    let n = document.getElementById("trackDbg");
    if (!n) { n = document.createElement("div"); n.id = "trackDbg"; n.style.cssText = "position:fixed;top:8px;left:8px;z-index:9999;background:#000;color:#0f0;padding:8px 10px;font:12px monospace;border-radius:6px;max-width:360px;pointer-events:none;white-space:pre-line;"; document.body.appendChild(n); }
    n.textContent = s;
  }
  function followPatches() {
    if (!S.trackIds.length || !T.player) return;
    const playing = T.player.playing || (T.player.tiles && Object.values(T.player.tiles).some(t => { const v = t.video || (t.vids && t.vids[T.player.active]); return v && !v.paused; }));
    if (!playing) return;
    let moved = 0;
    S.trackIds = S.trackIds.filter((id) => G.list.some((r) => r.id === id));
    for (const id of S.trackIds) {
      const r = G.list.find((x) => x.id === id); if (!r) continue;
      const info = S.patches[id] || {};
      const m = matchPatch(r.cam, info.patch || info, r.x, r.y, r.w, r.h);
      if (m && m.score > 8) {
        const dx = m.x - r.x, dy = m.y - r.y;
        info.vx = (info.vx || 0) * 0.5 + dx * 0.5;
        info.vy = (info.vy || 0) * 0.5 + dy * 0.5;
        r.x = m.x; r.y = m.y;
        if (r.pts) for (let i = 0; i < r.pts.length; i += 2) { r.pts[i] += dx; r.pts[i + 1] += dy; }
        info.lost = 0; moved++;
      } else if ((info.vx || info.vy) && (info.lost || 0) < 8) {
        const dx = info.vx || 0, dy = info.vy || 0;
        r.x += dx; r.y += dy;
        if (r.pts) for (let i = 0; i < r.pts.length; i += 2) { r.pts[i] += dx; r.pts[i + 1] += dy; }
        info.lost = (info.lost || 0) + 1; moved++;
      }
      S.patches[id] = info;
    }
    if (moved && R && R.paint) R.paint();
  }
  setInterval(followPatches, 120);

    /** Done: saves a drawn shape; in Move it simply closes the tray (the moves are already saved, and undoable). */
  UI.done = () => {
    if (S.trackIds && S.trackIds.length) {
      const n = S.trackIds.length;
      S.drawing = false; S.pick = false;
      const b = $("crBar"); if (b) b.hidden = true;
      document.body.classList.remove("cr-bar-on");
      reopenPanel(true); UI.sync(); kick();
      msg(n + " region" + (n === 1 ? "" : "s") + " tracking in the background.");
      return true;
    }
    if (S.shape === "free" && S.live && S.live.pts && S.live.pts.length >= 6 && S.cam) {
      finishShape(S.cam, S.live);
    }
    if (S.draft) return UI.save();
    if (S.move) { resetForm(); reopenPanel(true); UI.sync(); kick(); msg("Done."); return true; }
    return null;
  };
  /** A camera was chosen (tap, key, drag or the only one on screen): enlarge it when it was a tap / key (not a drag, which draws in place), arm the drag. */
  function choose(cam, how) {
    if (!cam) return;
    S.cam = cam; S.pick = false; S.draft = S.editId ? S.draft : null; S.live = null;
    if ((how === "tap" || how === "key") && T.focus && T.focus.focus && T.focus.cam !== cam) T.focus.focus(cam);
    S.drawing = true;
    for (const c of Object.keys(picks)) hot(c, false);
    syncPicks([]);
    hidePanelForDrawing();
    msg(camName(cam) + ": " + (S.shape === "free" ? "tap to add points, or drag. Double-tap or tap near the start to finish." : "drag on the picture to draw a box."));
    UI.sync(); kick();
    setTimeout(() => { if (S.drawing && S.cam === cam && !G.screenFit(cam)) msg("The camera picture isn't showing yet. Play or seek the video, then press Draw region again.", true); }, 600);
  }
  /** The drag ended: turn the points into a rectangle or a simplified freehand polygon. */
  function finishShape(cam, live) {
    const f = G.screenFit(cam) || live.f, p = live.pts;
    let sh = null;
    if (S.shape === "free") {
      const q = G.simplify(p, 1.8 / Math.max(1, Math.min(f.w, f.h)));
      const r = G.clean({ cam, shape: "poly", pts: q, mode: "blur" });
      if (r && r.w * f.w >= 8 && r.h * f.h >= 8) sh = { shape: "poly", pts: r.pts };
    } else {
      const x = Math.min(p[0], p[2]), y = Math.min(p[1], p[3]), w = Math.abs(p[2] - p[0]), h = Math.abs(p[3] - p[1]);
      if (w * f.w >= 8 && h * f.h >= 8) sh = { shape: "rect", x, y, w, h };
    }
    if (!sh) { S.drawing = true; msg("That was too small. Drag a bigger " + (S.shape === "free" ? "shape" : "box") + " on the picture.", true); UI.sync(); kick(); return; }
    S.drawing = false;
    S.draft = sh; S.undone = null;
    msg(S.editId ? "Shape changed. Press Save changes." : "Shape drawn. Press Save region (or Draw again).");
    UI.sync(); kick();
    if (R && R.paint) R.paint();
  }

  function readTimes() {
    if (S.whole) return { start: null, end: null };
    let a = parseT($("crFrom").value), b = parseT($("crTo").value);
    if (!isFinite(a)) a = 0;
    if (!isFinite(b)) b = dur();
    if (b < a) { const x = a; a = b; b = x; }
    return { start: a, end: Math.min(b, dur() || b) };
  }
  function resetForm() {
    S.drawing = false; S.pick = false; S.cam = null; S.draft = null; S.editId = null; S.live = null; S.peek = null; S.move = false; S.sel = null; S.mv = null; S.undone = null;
    S.whole = true; syncPicks([]);
    if ($("crWhole")) $("crWhole").checked = true;
    msg("");
  }
  /** The Redact panel steps aside while you draw (any screen size), so the whole picture is free, and a small bar (Save / Draw again / Cancel / Options) sits over the video instead. The Redact button, Save and Cancel bring it back. */
  function hidePanelForDrawing() {
    const U = T.searchUI;
    if (U && U.ok && U.open && U.hide) { U.hide(); S.reopen = true; S.hid = true; }
  }
  function reopenPanel(busy) {
    const U = T.searchUI;
    if ((S.reopen || S.hid || (busy && U && U.narrow && U.narrow())) && U && U.show) {   // phones: Save / Cancel of a drawing always bring the panel back (also after Options, then the panel's X)
      S.reopen = false; S.hid = false; U.show(false, "redact"); const s = $("crSec"); if (s) s.open = true; }
  }
  /* ---- ui-glass-7: the Redact tray (the draw bar, rebuilt like the iOS markup pen tray) ----
     camera chip · Box / Freehand · Blur / Remove · Undo · Redo · Move · Draw again · Options · Cancel · Done.
     Same ids as the bar-fix draw bar (crBar, crBarGrip, crBarCam, crBarSave = Done, crBarAgain, crBarCancel, crBarOpts, crBarMsg). Real <button>s with
     click handlers (Mac Safari mouse / trackpad clicks); icons only on phones; 44 px targets on touch (CSS). */
  const ICON = {
    rect: '<rect x="4" y="6" width="16" height="12" rx="2"/>',
    free: '<path d="M4 15c2-6 5-8 7-5s3 6 5 3 3-6 4-6"/>',
    blur: '<circle cx="12" cy="12" r="7" stroke-dasharray="2.5 2.5"/><circle cx="12" cy="12" r="2.5"/>',
    remove: '<rect x="5" y="7" width="14" height="10" rx="1.5" fill="currentColor"/>',
    undo: '<path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 0 12h-3" transform="translate(0 -6)"/>',
    redo: '<path d="m15 7 5 5-5 5"/><path d="M20 12H10a6 6 0 0 0 0 12h3" transform="translate(0 -6)"/>',
    move: '<path d="M12 3v18M3 12h18M12 3l-3 3m3-3 3 3M12 21l-3-3m3 3 3-3M3 12l3-3m-3 3 3 3M21 12l-3-3m3 3-3 3"/>',
    again: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>',
    opts: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    cancel: '<path d="M6 6l12 12M18 6 6 18"/>',
    done: '<path d="m5 12.5 4.5 4.5L19 7"/>',
    track: '<circle cx="12" cy="12" r="3"/><path d="M12 2a10 10 0 0 1 7 17M12 2a10 10 0 0 0-7 17"/>',
  };
  const ico = (k) => '<svg class="cr-ico" viewBox="0 0 24 24" aria-hidden="true">' + ICON[k] + "</svg>";
  const tb = (id, k, label, extra) => '<button type="button" class="btn small cr-tb' + (extra || "") + '" id="' + id + '" title="' + label + '" aria-label="' + label + '">' + ico(k) + '<span class="t">' + label + "</span></button>";
  function ensureBar() {
    let b = $("crBar");
    if (b) return b;
    b = document.createElement("div"); b.id = "crBar"; b.className = "cr-bar cr-tray"; b.hidden = true; b.setAttribute("role", "toolbar"); b.setAttribute("aria-label", "Redact tray");
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || ""), mod = mac ? "⌘" : "Ctrl+";
    b.innerHTML = '<button type="button" class="cr-grip" id="crBarGrip" aria-label="Move this tray (drag, or press Up / Down)" title="Drag to move this tray"><svg viewBox="0 0 14 22" aria-hidden="true"><circle cx="4" cy="4" r="1.7"/><circle cx="10" cy="4" r="1.7"/><circle cx="4" cy="11" r="1.7"/><circle cx="10" cy="11" r="1.7"/><circle cx="4" cy="18" r="1.7"/><circle cx="10" cy="18" r="1.7"/></svg></button>' +
      '<button type="button" class="btn small cr-chip" id="crBarCam" hidden></button>' +
      '<span class="cr-bar-btns">' +
      '<span class="seg cr-tseg" id="crBarShape" role="group" aria-label="Tool">' + tb("crBarBox", "rect", "Box", " cr-sv").replace("<button", '<button data-v="rect" aria-pressed="true"') + tb("crBarFree", "free", "Freehand", " cr-sv").replace("<button", '<button data-v="free" aria-pressed="false"') + "</span>" +
      '<span class="seg cr-tseg" id="crBarMode" role="group" aria-label="How to hide">' + tb("crBarBlur", "blur", "Blur", " cr-sv").replace("<button", '<button data-v="blur" aria-pressed="true"') + tb("crBarRemove", "remove", "Remove", " cr-sv").replace("<button", '<button data-v="remove" aria-pressed="false"') + "</span>" +
      tb("crBarUndo", "undo", "Undo (" + mod + "Z)", " ghost cr-io").replace('<span class="t">Undo (' + mod + "Z)", '<span class="t">Undo') +
      tb("crBarRedo", "redo", "Redo (" + (mac ? "⇧⌘Z" : "Ctrl+Shift+Z") + ")", " ghost cr-io").replace(/<span class="t">Redo[^<]*/, '<span class="t">Redo') +
      tb("crBarTrack", "track", "Track", " ghost").replace("<button", '<button aria-pressed="false"') +
      tb("crBarMove", "move", "Move", " ghost").replace("<button", '<button aria-pressed="false"') +
      tb("crBarAgain", "again", "Draw again", "") +
      '<button type="button" class="btn small ghost cr-tb" id="crBarOpts" title="Back to the Redact panel" aria-expanded="false">' + ico("opts") + '<span class="t">Options</span></button>' +
      tb("crBarCancel", "cancel", "Cancel", " ghost") +
      '<button type="button" class="btn small primary cr-tb cr-done" id="crBarSave" title="Save region" aria-label="Done: save region">' + ico("done") + '<span class="t">Done</span></button>' +
      "</span>" +
      '<span class="cr-bar-msg" id="crBarMsg" aria-live="polite"></span>';
    document.body.appendChild(b);
    $("crBarSave").addEventListener("click", () => UI.done());
    $("crBarAgain").addEventListener("click", () => UI.draw());
    $("crBarCancel").addEventListener("click", () => UI.cancel());
    $("crBarUndo").addEventListener("click", () => UI.undo());
    $("crBarRedo").addEventListener("click", () => UI.redo());
    $("crBarMove").addEventListener("click", () => UI.move());
    $("crBarTrack").addEventListener("click", () => UI.track());
    $("crBarShape").addEventListener("click", (e) => { const x = e.target.closest("button"); if (x && !x.disabled) UI.setShape(x.dataset.v); });
    $("crBarMode").addEventListener("click", (e) => { const x = e.target.closest("button"); if (x && !x.disabled) UI.setMode(x.dataset.v); });
    $("crBarCam").addEventListener("click", () => UI.draw(true));   // the chip names the camera; tapping it picks another one (no dropdown)
    $("crBarOpts").addEventListener("click", () => {   // a toggle: Options opens the Redact panel, "Back to drawing" tucks it away again (the picture is never left covered with no way back)
      const U = T.searchUI;
      if (U && U.open) { if (U.hide) U.hide(); S.reopen = true; } else { S.reopen = true; reopenPanel(); }
      optsLabel();
    });
    wireGrip(b);
    return b;
  }
  /** Tool (Box / Freehand) and mode (Blur / Remove), shared by the tray and the panel. In Move, Blur / Remove changes the selected region (one undo step). */
  UI.setShape = (v) => {
    if (S.move) return;
    S.shape = v === "free" ? "free" : "rect";
    if (!S.editId && S.draft) { S.draft = null; S.undone = null; if (S.cam) S.drawing = true; }   // a new tool: draw the shape again with it
    if (S.drawing) UI.draw();
    UI.sync();
  };
  UI.setMode = (v) => {
    S.mode = v === "remove" ? "remove" : "blur";
    if (S.move && S.sel) G.update(S.sel, { mode: S.mode });
    UI.sync(); kick();
  };
  /* ---- draw bar position (bar-fix) ----
     The bar is click-through (only its grip and buttons catch the pointer). It sits above the transport bar at the bottom; when a stroke starts or
     grows near it, or the shape being drawn reaches it, it glides to the opposite screen edge (never under the finger). The grip drags it anywhere;
     the position is remembered for the session. */
  const POSKEY = "dcs.crBarPos.v1", NEAR = 28;
  const bp = { edge: "bottom", free: null };
  try { const j = JSON.parse(sessionStorage.getItem(POSKEY) || "null"); if (j && (j.edge === "top" || j.edge === "bottom")) { bp.edge = j.edge; if (j.free && isFinite(j.free.x) && isFinite(j.free.y)) bp.free = { x: +j.free.x, y: +j.free.y }; } } catch (_) {}
  const savePos = () => { try { sessionStorage.setItem(POSKEY, JSON.stringify(bp)); } catch (_) {} };
  let probe = null;
  function safe() {   // iOS safe-area insets in px (0 elsewhere)
    try {
      if (!probe) { probe = document.createElement("div"); probe.setAttribute("aria-hidden", "true"); probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)"; document.body.appendChild(probe); }
      const cs = getComputedStyle(probe); return { t: parseFloat(cs.paddingTop) || 0, b: parseFloat(cs.paddingBottom) || 0 };
    } catch (_) { return { t: 0, b: 0 }; }
  }
  function bottomGap() {
    const tp = $("transport"), fs = document.body.classList.contains("fs");
    return (tp && !fs ? tp.offsetHeight : 0) + 8 + (fs || !tp ? safe().b : 0);
  }
  function edgeRect(edge, W, H) {   // where the bar would sit pinned to an edge (centred)
    const sf = safe(), l = Math.max(8, (innerWidth - W) / 2), t = edge === "top" ? sf.t + 8 : innerHeight - bottomGap() - H;
    return { l, t, r: l + W, b: t + H };
  }
  function clampFree(x, y, W, H) {
    const sf = safe();
    return { x: Math.min(Math.max(4, x), Math.max(4, innerWidth - W - 4)), y: Math.min(Math.max(sf.t + 4, y), Math.max(sf.t + 4, innerHeight - H - sf.b - 4)) };
  }
  function applyPos(animate) {
    const b = $("crBar"); if (!b || b.hidden) return;
    const before = animate ? b.getBoundingClientRect() : null;
    if (bp.free) {
      const W = b.offsetWidth, H = b.offsetHeight, c = clampFree(bp.free.x, bp.free.y, W, H);
      b.classList.add("free"); b.style.left = c.x + "px"; b.style.top = c.y + "px"; b.style.bottom = "auto";
      b.dataset.edge = c.y + H / 2 < innerHeight / 2 ? "top" : "bottom";
    } else {
      b.classList.remove("free"); b.style.left = ""; b.dataset.edge = bp.edge;
      if (bp.edge === "top") { b.style.top = "calc(env(safe-area-inset-top, 0px) + 8px)"; b.style.bottom = "auto"; }
      else { b.style.top = "auto"; b.style.bottom = bottomGap() + "px"; }
    }
    if (before && b.animate && !(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches)) {
      const a = b.getBoundingClientRect(), dx = before.left - a.left, dy = before.top - a.top;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) { try { b.animate([{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "none" }], { duration: 200, easing: "ease-out" }); } catch (_) {} }
    }
  }
  const hit = (r, x0, y0, x1, y1, m) => !(x1 < r.l - m || x0 > r.r + m || y1 < r.t - m || y0 > r.b + m);
  /** A stroke is at (x, y) with client bounds bb = [x0, y0, x1, y1]: step the bar out of the way if it is close. Returns true when it moved. */
  UI.avoidBar = (x, y, bb) => {
    const b = $("crBar"); if (!b || b.hidden || !(S.drawing || S.move)) return false;
    const W = b.offsetWidth, H = b.offsetHeight, rc = b.getBoundingClientRect();
    const cur = bp.free ? { l: rc.left, t: rc.top, r: rc.left + W, b: rc.top + H } : edgeRect(bp.edge, W, H);
    const pt = hit(cur, x, y, x, y, NEAR), box = !!bb && hit(cur, bb[0], bb[1], bb[2], bb[3], NEAR);
    if (!pt && !box) return false;
    const edge = y > innerHeight / 2 ? "top" : "bottom";
    if (!bp.free && edge === bp.edge) return false;
    const to = edgeRect(edge, W, H);
    if (hit(to, x, y, x, y, NEAR)) return false;                       // the other edge is just as close to the finger: stay
    if (!pt && bb && hit(to, bb[0], bb[1], bb[2], bb[3], NEAR)) return false;   // only the shape's bounds are near, and they reach the other edge too
    bp.free = null; bp.edge = edge; savePos(); applyPos(true);
    return true;
  };
  function wireGrip(b) {
    const g = b.querySelector("#crBarGrip"); let id = null, ox = 0, oy = 0;
    g.addEventListener("pointerdown", (e) => {
      if (id !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
      e.preventDefault(); e.stopPropagation(); id = e.pointerId;   // ui-glass-7: no pointer capture (Mac Safari); the drag follows the window
      const r = b.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top; g.classList.add("on");
      addEventListener("pointermove", mv, true); addEventListener("pointerup", end, true); addEventListener("pointercancel", end, true);
    });
    const mv = (e) => {
      if (id !== e.pointerId) return; e.preventDefault();
      bp.free = { x: e.clientX - ox, y: e.clientY - oy }; applyPos(false);
    };
    const end = (e) => {
      if (id !== e.pointerId) return; id = null; g.classList.remove("on");
      removeEventListener("pointermove", mv, true); removeEventListener("pointerup", end, true); removeEventListener("pointercancel", end, true);
      if (bp.free) { const c = clampFree(bp.free.x, bp.free.y, b.offsetWidth, b.offsetHeight); bp.free = c; savePos(); applyPos(false); }
    };
    g.addEventListener("click", (e) => e.stopPropagation());
    g.addEventListener("keydown", (e) => {   // keyboard: Up / Down pins the bar to the top / bottom edge
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault(); bp.free = null; bp.edge = e.key === "ArrowUp" ? "top" : "bottom"; savePos(); applyPos(true);
    });
  }
  UI.barReset = () => { bp.free = null; bp.edge = "bottom"; savePos(); applyPos(false); };   // back to the default spot (bottom edge)
  let rsz = 0;
  addEventListener("resize", () => { clearTimeout(rsz); rsz = setTimeout(() => applyPos(false), 80); });
  addEventListener("orientationchange", () => setTimeout(() => applyPos(false), 250));
  function optsLabel() {
    const o = $("crBarOpts"), U = T.searchUI; if (!o) return;
    const open = !!(U && U.open);
    const t = o.querySelector(".t"); (t || o).textContent = open ? "Back to drawing" : "Options"; o.setAttribute("aria-expanded", String(open)); o.setAttribute("aria-label", open ? "Back to drawing" : "Options");
    o.title = open ? "Hide the panel so you can draw" : "Back to the Redact panel";
  }
  function syncBar() {
    const b = ensureBar(), show = !!(S.drawing || S.draft || S.pick || S.move || (S.live && S.live.pts && S.live.pts.length));
    drawClass();
    b.hidden = !show; document.body.classList.toggle("cr-bar-on", !!show);
    if (!show) return;
    applyPos(false);
    const sv = $("crBarSave"), what = S.move ? "Done moving" : S.editId ? "Save changes" : "Save region";
    const freeReady = S.shape === "free" && S.live && S.live.pts && S.live.pts.length >= 6;
    sv.disabled = !(S.move || (S.draft && !S.drawing) || freeReady || S.trackId); sv.title = what; sv.setAttribute("aria-label", "Done: " + what.toLowerCase());
    sv.hidden = !!S.pick && !S.trackId;
    if (S.trackIds && S.trackIds.length) { sv.disabled = false; sv.style.opacity = "1"; }
    $("crBarAgain").hidden = !!S.drawing || !!S.pick || !!S.move;
    const setSeg = (id, v, dis) => document.querySelectorAll("#" + id + " button").forEach((x) => { x.setAttribute("aria-pressed", String(x.dataset.v === v)); x.classList.toggle("on", x.dataset.v === v); x.disabled = dis; });
    const selR = S.move && G.list.find((r) => r.id === S.sel);
    setSeg("crBarShape", selR ? (selR.shape === "poly" ? "free" : "rect") : S.shape, !!S.move || !!S.pick);
    setSeg("crBarMode", selR ? selR.mode : S.mode, !!S.pick || (!!S.move && !selR));
    const u = $("crBarUndo"), r = $("crBarRedo");
    u.hidden = false; r.hidden = false;
    u.disabled = !UI.canUndo(); r.disabled = !UI.canRedo();
    u.classList.toggle("on", UI.canUndo()); r.classList.toggle("on", UI.canRedo());
    const trb = $("crBarTrack"); if (trb) { trb.classList.toggle("on", !!S.track); trb.setAttribute("aria-pressed", String(!!S.track)); }
    const mvb = $("crBarMove"), canMove = !!S.cam && !S.pick && !S.draft && !S.editId && G.list.some((r) => r.cam === S.cam);
    mvb.hidden = !!S.pick; mvb.disabled = !S.move && !canMove; mvb.setAttribute("aria-pressed", String(!!S.move)); mvb.classList.toggle("on", !!S.move);
    b.classList.toggle("moving", !!S.move);
    const chip = $("crBarCam"), has = !!S.cam && !S.pick;
    chip.hidden = !has;
    if (has) { chip.textContent = camName(S.cam); chip.disabled = !!S.editId; chip.title = S.editId ? "The camera of the region you are editing" : "Redacting the " + camName(S.cam) + " camera. Tap to pick a different camera"; chip.setAttribute("aria-label", chip.title); }
    b.classList.toggle("picking", !!S.pick);
    optsLabel();
  }
  UI.save = () => {
    if (!S.draft) { msg("Draw a region first.", true); return null; }
    const t = readTimes();
    const o = Object.assign({ cam: S.cam, mode: S.mode, start: t.start, end: t.end }, S.draft);
    let r;
    if (S.editId) r = G.update(S.editId, o);
    else { if (G.list.length >= G.MAX) { msg("That is the most regions for one event (" + G.MAX + "). Delete one first.", true); return null; } r = G.add(o); }
    if (!r) { msg("Couldn't save that region. Draw it again.", true); return null; }
    const was = S.editId;
    resetForm(); changed(); reopenPanel(true); msg(was ? "Region updated." : "Region saved. It is hidden in the viewer and in the export.");
    return r;
  };
  /** Draw region. With several cameras on screen: "tap the camera you want to redact" (a tap enlarges it and arms the drag, a drag starts drawing on it).
   *  With one camera on screen: that is the camera. `repick` (the chip) forgets the camera and asks again. */
  UI.draw = (repick) => {
    if (!T.player || !T.player.ev) { msg("Open an event first.", true); return; }
    repick = repick === true && !S.editId;
    if (repick) { S.draft = null; S.live = null; S.cam = null; S.drawing = false; }
    const redo = !repick && !!S.cam && (S.editId || S.draft || (S.drawing && !S.pick));   // Draw again / a shape change keeps the camera
    if (redo) {
      if (T.player.ev.cams && !T.player.ev.cams.includes(S.cam)) { msg("This event has no " + camName(S.cam).toLowerCase() + " footage.", true); return; }
      if (!isMulti() && T.focus && T.focus.focus && T.focus.cam !== S.cam) T.focus.focus(S.cam);
      S.pick = false; S.drawing = true; S.draft = S.editId ? S.draft : null; S.live = null; S.undone = null;
      hidePanelForDrawing();
      msg(camName(S.cam) + ": " + (S.shape === "free" ? "drag on the picture to draw around the area (freehand)." : "drag on the picture to draw a box."));
      UI.sync(); kick();
      return;
    }
    if (repick && T.focus && T.focus.cam && T.focus.grid) T.focus.grid();   // back to all the cameras, so there is something to tap
    hidePanelForDrawing();   // first: a docked panel (landscape phone) squeezes the pictures to nothing, and we need to see which cameras are really on screen
    const one = T.focus && T.focus.cam, vis = visibleCams();
    if (!vis.length && !one) { reopenPanel(); msg("The cameras aren't showing yet. Play or seek the video, then press Draw region again.", true); return; }
    S.cam = null; S.draft = null; S.live = null; S.drawing = false;
    if (isMulti()) {
      S.pick = true;
      hidePanelForDrawing();
      msg("Tap the camera you want to redact", false);
      UI.sync(); kick();
      const fp = (n) => {   // the camera buttons appear on the next painted frame: wait for them (up to ~1 s on a busy page) instead of giving up
        if (!S.pick) return;
        const b = document.querySelector(".cr-pick"), a = document.activeElement;
        if (!b) { if (n < 12) setTimeout(() => fp(n + 1), 80); return; }
        if (!(a && a.classList && a.classList.contains("cr-pick"))) { try { b.focus({ preventScroll: true }); } catch (_) {} }
      };
      setTimeout(() => fp(0), 120);   // keyboard: Tab moves between the cameras, Enter picks, Esc cancels
    } else choose(one || vis[0], "auto");
  };
  UI.cancel = () => { const busy = !!(S.drawing || S.pick || S.draft || S.editId || S.move); resetForm(); reopenPanel(busy); UI.sync(); kick(); if (R && R.paint) R.paint(); };
  UI.edit = (id) => {
    const r = G.list.find((x) => x.id === id); if (!r) return;
    S.pick = false; syncPicks([]);
    S.editId = id; S.cam = r.cam; S.shape = r.shape === "poly" ? "free" : "rect"; S.mode = r.mode; S.draft = shapeOf(r); S.drawing = false;
    S.whole = r.start == null && r.end == null;
    $("crWhole").checked = S.whole; $("crFrom").value = fmt(r.start || 0); $("crTo").value = fmt(r.end == null ? dur() : r.end);
    if (T.focus && T.focus.focus && T.focus.cam !== r.cam) T.focus.focus(r.cam);
    msg("Editing the " + camName(r.cam).toLowerCase() + " region. Change the settings, or press Draw region to redraw the shape, then Save changes.");
    UI.sync(); kick();
  };
  function listHtml() {
    return G.list.map((r, i) => {
      const when = r.start == null && r.end == null ? "whole clip" : fmt(r.start || 0) + " to " + (r.end == null ? "end" : fmt(r.end));
      return '<li class="cr-item' + (r.on ? "" : " off") + (r.id === S.editId ? " editing" : "") + '" data-id="' + esc(r.id) + '">' +
        '<label class="cr-on" title="Switch this region on or off (off: not hidden in the viewer or the export)"><input type="checkbox" data-act="on"' + (r.on ? " checked" : "") + ' aria-label="Region ' + (i + 1) + ' on"></label>' +
        '<span class="cr-desc"><b>' + esc(camName(r.cam)) + "</b> · " + (r.mode === "remove" ? "Remove" : "Blur") + " · " + (r.shape === "poly" ? "freehand" : "box") + "<br><small>" + esc(when) + "</small></span>" +
        '<button type="button" class="btn small ghost" data-act="go" title="Show this region in the video">Show</button>' +
        '<button type="button" class="btn small ghost icon" data-act="sticky" title="' + (r.sticky ? 'Unpin' : 'Pin') + '" aria-label="Pin">' + (r.sticky ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="#e6b450" stroke="#e6b450" stroke-width="2"><path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>' : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#888" stroke-width="2"><path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/><line x1="4" y1="4" x2="20" y2="20" stroke="#888"/></svg>') + '</button>' +
        '<button type="button" class="btn small ghost" data-act="edit">Edit</button>' +
        '<button type="button" class="btn small ghost" data-act="del" aria-label="Delete region ' + (i + 1) + '">Delete</button></li>';
    }).join("");
  }
  UI.sync = () => {
    const sec = $("crSec"); if (!sec) return;
    const ev = T.player && T.player.ev, cams = ev && ev.cams ? T.GRID.filter((c) => ev.cams.includes(c)) : [];
    if (S.cam && !cams.includes(S.cam)) S.cam = null;
    if (S.editId && !G.list.some((r) => r.id === S.editId)) { S.editId = null; S.draft = null; }   // ui-glass-7: an undo took away the region being edited
    if (S.sel && !G.list.some((r) => r.id === S.sel)) S.sel = null;
    document.querySelectorAll("#crShape button").forEach((b) => { b.setAttribute("aria-pressed", String(b.dataset.v === S.shape)); b.classList.toggle("on", b.dataset.v === S.shape); });
    document.querySelectorAll("#crMode button").forEach((b) => { b.setAttribute("aria-pressed", String(b.dataset.v === S.mode)); b.classList.toggle("on", b.dataset.v === S.mode); });
    $("crTimes").hidden = S.whole;
    $("crTrim").hidden = !(T.ui && T.ui.activeSegs && T.ui.activeSegs().length);
    $("crDraw").textContent = S.pick ? "Tap a camera…" : S.drawing ? "Drawing… drag on the picture" : S.draft ? "Draw again" : "Draw region";
    $("crDraw").disabled = !ev || !cams.length;
    $("crSave").disabled = !S.draft || S.drawing;
    $("crSave").textContent = S.editId ? "Save changes" : "Save region";
    $("crCancel").hidden = !(S.drawing || S.pick || S.draft || S.editId);
    syncBar();
    const n = G.list.length, on = G.list.filter((r) => r.on).length;
    $("crCount").textContent = n ? "(" + n + ")" : "";
    const rb = $("crRegBtn"); if (rb) { $("crRegN").textContent = "(" + n + ")"; rb.hidden = !n; if (!n && sec.classList.contains("list-open")) { sec.classList.remove("list-open"); rb.setAttribute("aria-expanded", "false"); } }
    $("crList").innerHTML = listHtml();
    $("crList").hidden = !n;
    const cu = $("crUndo"), cr = $("crRedo");
    if (cu) { cu.disabled = !UI.canUndo(); cu.classList.toggle("on", UI.canUndo()); }
    if (cr) { cr.disabled = !UI.canRedo(); cr.classList.toggle("on", UI.canRedo()); }
    $("crFileRow").hidden = false; $("crExportFile").disabled = !n;
    $("crStore").hidden = G.storeOk !== false;
    // Export dialog note
    const note = $("exportRegionsNote");
    if (note) { note.hidden = !on; note.textContent = on ? on + " custom region" + (on === 1 ? "" : "s") + " will be hidden in the export (Redact ▸ Custom regions)." : ""; }
    if (S.drawing || S.pick || S.draft || S.editId || S.peek) kick();
  };
  function bind() {
    const sec = $("crSec");
    sec.addEventListener("toggle", () => { if (!sec.open) sec.open = true; });   // the section never folds away
    const sm = sec.querySelector("summary"); if (sm) sm.addEventListener("click", (e) => e.preventDefault());
    const pop = (id, cls) => { const b = $(id); if (b) b.addEventListener("click", () => { const U = T.searchUI, on = !sec.classList.contains(cls); if (U && U.closePops) U.closePops(id); sec.classList.toggle(cls, on); b.setAttribute("aria-expanded", String(on)); }); };
    pop("crInfo", "hint-open"); pop("crRegBtn", "list-open");
    $("crShape").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.shape = b.dataset.v; if (!S.editId) S.draft = null; if (S.drawing) UI.draw(); UI.sync(); });
    $("crMode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; UI.setMode(b.dataset.v); });
    $("crWhole").addEventListener("change", () => {
      S.whole = $("crWhole").checked;
      if (!S.whole) { const t = T.player ? T.player.time || 0 : 0; if (!$("crFrom").value) $("crFrom").value = fmt(t); if (!$("crTo").value) $("crTo").value = fmt(Math.min(dur(), t + 5)); }
      UI.sync();
    });
    $("crFromNow").addEventListener("click", () => { $("crFrom").value = fmt(T.player.time || 0); });
    $("crToNow").addEventListener("click", () => { $("crTo").value = fmt(T.player.time || 0); });
    $("crTrim").addEventListener("click", () => { try { const r = T.ui.range(); $("crFrom").value = fmt(r[0]); $("crTo").value = fmt(r[1]); } catch (_) {} });
    $("crDraw").addEventListener("click", () => UI.draw());
    $("crSave").addEventListener("click", UI.save);
    $("crCancel").addEventListener("click", UI.cancel);
    $("crUndo").addEventListener("click", () => UI.undo());
    $("crRedo").addEventListener("click", () => UI.redo());
    $("crList").addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]"), li = e.target.closest("li[data-id]"); if (!b || !li) return;
      const id = li.dataset.id, r = G.list.find((x) => x.id === id); if (!r) return;
      if (b.dataset.act === "del") { if (S.editId === id) resetForm(); G.remove(id); msg("Region deleted. Undo brings it back."); }
      else if (b.dataset.act === "sticky") { const on = G.sticky(id); msg(on ? "Pinned — this region comes back next time." : "Unpinned — this region is for this session only."); UI.sync(); }
      else if (b.dataset.act === "edit") { const U = T.searchUI; if (U && U.closePops) U.closePops(); UI.edit(id); }
      else if (b.dataset.act === "go") {
        if (T.focus && T.focus.focus && T.focus.cam !== r.cam) T.focus.focus(r.cam);
        if (T.player && r.start != null && (T.player.time < r.start || (r.end != null && T.player.time > r.end))) T.player.seek(r.start);
        S.peek = { cam: r.cam, sh: shapeOf(r) }; clearTimeout(S.peekT); S.peekT = setTimeout(() => { S.peek = null; kick(); }, 3500); kick();
      }
    });
    $("crList").addEventListener("change", (e) => { const li = e.target.closest("li[data-id]"); if (li && e.target.dataset.act === "on") G.update(li.dataset.id, { on: e.target.checked }); });
    $("crClearPinned").addEventListener("click", () => {
      const pinned = G.list.filter((r) => r.sticky);
      if (!pinned.length) { msg("No pinned regions."); return; }
      for (const r of pinned) G.remove(r.id);
      msg(pinned.length + " pinned region" + (pinned.length === 1 ? "" : "s") + " cleared.");
      UI.sync();
    });
    $("crExportFile").addEventListener("click", () => {
      try {
        const a = document.createElement("a"), u = URL.createObjectURL(new Blob([G.toJSON()], { type: "application/json" }));
        a.href = u; a.download = "dashcam-regions.json"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000);
        msg("Saved dashcam-regions.json.");
      } catch (e) { msg("Couldn't save the file: " + (e.message || e), true); }
    });
    $("crImportFile").addEventListener("click", () => $("crFile").click());
    $("crFile").addEventListener("change", async () => {
      const f = $("crFile").files && $("crFile").files[0]; $("crFile").value = "";
      if (!f) return;
      try { const r = G.fromJSON(await f.text()); msg(r.added ? "Added " + r.added + " region" + (r.added === 1 ? "" : "s") + (r.skipped ? " (" + r.skipped + " skipped)" : "") + "." : "Nothing usable in that file.", !r.added); }
      catch (e) { msg(e.message || String(e), true); }
    });
  }
  function build() {
    const sec = document.createElement("details");
    sec.className = "cr-sec us-t-redact"; sec.id = "crSec"; sec.open = true;   // always open: no accordion click needed (redact-button)
    sec.innerHTML =
      '<summary>Custom regions <span id="crCount"></span></summary>' +
      '<p class="cr-hint" id="crHint">For what automatic redaction misses, like a curved plate. Press <b>Draw region</b>, tap the camera you want, then drag over the area. Regions stay put on the picture and are burned into the export.</p>' +
      '<div class="cr-grid">' +
      '<div class="cr-f"><span>Shape</span><div class="seg" id="crShape" role="group" aria-label="Shape"><button type="button" data-v="rect" aria-pressed="true">Box</button><button type="button" data-v="free" aria-pressed="false">Freehand</button></div></div>' +
      '<div class="cr-f"><span>Hide with</span><div class="seg" id="crMode" role="group" aria-label="How to hide"><button type="button" data-v="blur" aria-pressed="true" title="A strong blur: the text can\'t be read">Blur</button><button type="button" data-v="remove" aria-pressed="false" title="A solid black shape">Remove (black)</button></div></div>' +
      '<div class="cr-f"><span>When</span><label class="cr-chk"><input type="checkbox" id="crWhole" checked> Whole clip</label></div>' +
      "</div>" +
      // ui-glass-6: the thin docked strip folds the help behind (i) and the saved regions behind "Regions (n)" (popovers; hidden by CSS elsewhere)
      '<button type="button" class="cr-info" id="crInfo" aria-expanded="false" aria-controls="crHint" aria-label="How custom regions work" title="How custom regions work">i</button>' +
      '<button type="button" class="btn small cr-regbtn" id="crRegBtn" aria-expanded="false" aria-controls="crList" hidden>Regions <span id="crRegN"></span></button>' +
      '<div class="cr-times" id="crTimes" hidden><label>From <input id="crFrom" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="0:00.0" aria-label="Start time"></label><button type="button" class="btn small ghost" id="crFromNow" title="Use the current position">Now</button>' +
      '<label>to <input id="crTo" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="0:05.0" aria-label="End time"></label><button type="button" class="btn small ghost" id="crToNow" title="Use the current position">Now</button>' +
      '<button type="button" class="btn small ghost" id="crTrim" hidden title="Use the time span of your sections">Use my sections</button></div>' +
      '<div class="cr-actions" id="crActions"><button type="button" class="btn primary small" id="crDraw">Draw region</button><button type="button" class="btn small" id="crSave" disabled>Save region</button><button type="button" class="btn ghost small" id="crCancel" hidden>Cancel</button></div>' +
      '<div class="cr-msg" id="crMsg" aria-live="polite"></div>' +
      '<ul class="cr-list" id="crList" hidden></ul>' +
      '<div class="cr-actions" id="crHistRow"><button type="button" class="btn ghost small" id="crUndo" disabled>Undo</button><button type="button" class="btn ghost small" id="crRedo" disabled>Redo</button></div>' +
      '<div class="cr-actions" id="crFileRow"><button type="button" class="btn ghost small" id="crExportFile" title="Save the regions as a small file">Save as file</button><button type="button" class="btn ghost small" id="crImportFile" title="Add regions from a file">Load from file</button><button type="button" class="btn ghost small" id="crClearPinned" title="Remove all pinned regions">Clear pinned</button><input type="file" id="crFile" accept=".json,application/json" hidden></div>' +
      '<p class="cr-hint" id="crStore" hidden>This browser is not keeping the regions between visits (storage is blocked). Use Save as file.</p>';
    return sec;
  }
  /** Put the section where the Redact controls are: inside the floating search panel when it exists, else under the classic Redact bar. */
  UI.place = () => {
    let sec = $("crSec"), fresh = false;
    const panel = $("usPanel");
    if (!sec) { sec = build(); fresh = true; }
    const acts = sec.querySelector("#crActions") || $("crActions");
    if (panel && T.searchUI && T.searchUI.ok) {
      // the Redact tab: Draw region / Save / Cancel on top, then the Custom regions form (always open), then the automatic controls
      let row = $("usDrawRow");
      if (!row) { row = document.createElement("div"); row.id = "usDrawRow"; row.className = "us-drawrow us-t-redact"; }
      const head = $("usHead");
      if (row.parentNode !== panel) panel.insertBefore(row, head ? head.nextSibling : panel.firstChild);
      if (sec.parentNode !== panel) panel.insertBefore(sec, row.nextSibling);
      if (acts && acts.parentNode !== row) row.appendChild(acts);
      sec.classList.add("us-t-redact");
    } else {
      const st = $("redactStatus");
      if (st && sec.parentNode !== st.parentNode) st.parentNode.insertBefore(sec, st.nextSibling);
      sec.classList.remove("us-t-redact");
      if (acts && acts.parentNode !== sec) { const msgEl = $("crMsg"); sec.insertBefore(acts, msgEl); }
    }
    if (fresh) bind();
    return sec;
  };
  UI.init = () => {
    try {
      UI.place();
      if (T.on) {
        T.on("player-open", () => { resetForm(); removeOverlays(); G.load(); UI.sync(); });
        T.on("layout", () => { if (R && R.paintSoon && G.any()) R.paintSoon(); kick(); });   // only with regions: with none the viewer paints exactly as before
      }
      window.addEventListener("resize", () => { if (R && R.paintSoon && G.any()) R.paintSoon(); kick(); });
      window.addEventListener("keydown", (e) => { if (e.key === "Escape" && (S.drawing || S.pick || S.draft || S.editId || S.move) && !(e.target.matches && e.target.matches("input, textarea, select"))) { UI.cancel(); } });
      // ui-glass-7: Cmd/Ctrl+Z undo, Shift+Cmd/Ctrl+Z (or Ctrl+Y) redo; in Move the arrow keys nudge the selected region and Delete removes it
      window.addEventListener("keydown", (e) => {
        const tg = e.target; if (tg && tg.matches && (tg.matches("input, textarea, select, #crBarGrip") || tg.isContentEditable)) return;
        const k = (e.key || "").toLowerCase(), mod = e.metaKey || e.ctrlKey;
        if (mod && !e.altKey && (k === "z" || (k === "y" && e.ctrlKey && !e.metaKey))) {
          const redo = k === "y" || e.shiftKey;
          if (redo ? !UI.canRedo() : !UI.canUndo()) return;
          e.preventDefault(); e.stopImmediatePropagation(); redo ? UI.redo() : UI.undo(); return;
        }
        if (!S.move || !S.sel || mod || e.altKey) return;
        const st = e.shiftKey ? 0.02 : 0.004, d = { arrowleft: [-st, 0], arrowright: [st, 0], arrowup: [0, -st], arrowdown: [0, st] }[k];
        if (d) { e.preventDefault(); e.stopImmediatePropagation(); const f = G.screenFit(S.cam); UI.nudge(f && f.mirrored ? -d[0] : d[0], d[1]); }
        else if (k === "delete" || k === "backspace") { e.preventDefault(); e.stopImmediatePropagation(); G.remove(S.sel); msg("Region deleted. " + (navigator.platform && /Mac/.test(navigator.platform) ? "⌘Z" : "Ctrl+Z") + " brings it back."); }
      }, true);
      G.load(); UI.sync();
      G.ready = true;
    } catch (err) { G.error = String((err && err.message) || err); console.warn("[custom-redact] UI failed; regions still burn in:", err); }
  };
})();
