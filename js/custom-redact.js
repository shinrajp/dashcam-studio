/* custom-redact.js — custom redaction regions (tag custom-redact).
 * A region is a user-drawn box or freehand shape on ONE camera's picture, hidden with a strong blur or an opaque black fill, for the whole
 * clip or a time range. It is for what the automatic redaction misses (a curved plate in the rear fisheye, a house number, a face).
 *
 *   region = { id, cam, shape: "rect" | "poly", x, y, w, h (bounding box), pts: [x0, y0, x1, y1, …] (poly only),
 *              mode: "blur" | "remove" | "mark", start: seconds | null, end: seconds | null, on: true, v: 1,
 *              shape "ellipse": the circle tool (x, y, w, h is the box round it). mark: the shape's outline is drawn in mc ("#rrggbb"), nothing hidden,
 *              ci: colour index of the region on the timeline and in the list, link: id shared by the regions of one object followed across cameras }
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
 * Storage: localStorage "tdc.regions.v1" keyed by a hash of the event's file names and sizes (nothing leaves the device); JSON file import / export.
 * Track (tag track-v2): a tracked region also carries `path` (js/patch-track.js: flat keys t, x, y, w, h; w = h = 0 is "lost from here"). The path is
 *   what the viewer, scrubbing and the exporter read (G.at resolves the region's box at time t from it), so the region follows its object everywhere,
 *   not only while playing. Playback writes the keys; an export fills any stretch nobody played by tracking forward on the frames it decodes. The
 *   shape fields (x, y, w, h, pts) stay "where it is at the player's time" (G.sync) so Move, the list and the editor keep working on what you see. */
(function () {
  "use strict";
  const T = window.TDC;
  const R = T.redact;
  const PT = T.patchTrack || null;   // js/patch-track.js (a stale cache without it just leaves tracking out)
  const $ = (id) => document.getElementById(id);
  const G = (T.regions = { list: [], key: null, MAX: 40, MAX_PTS: 96, KEY: "tdc.regions.v1", ui: { cam: null, shape: "rect", tool: "rect", mode: "blur", mc: "#ffd400", whole: true, from: 0, to: 0, draft: null, editId: null, drawing: false, pick: false } });
  const EMPTY = [];
  let byCam = {};

  // ── model ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const clamp01 = (v) => Math.min(1, Math.max(0, +v || 0));
  /** Highlight colours (mark mode) and the colours that tell regions apart on the timeline lanes and in the list. */
  const MARK_COLORS = (G.MARK_COLORS = ["#ffd400", "#ff3b30", "#34c759", "#0a84ff", "#ffffff"]);
  const LANE_COLORS = (G.LANE_COLORS = ["#e6b450", "#4fb3ff", "#ff6b9a", "#7ee787", "#c39bff", "#ff9f43", "#3fd0c9", "#f778ba"]);
  /** The region's colour on the timeline (stored ci; older regions: from the id). */
  G.color = (r) => LANE_COLORS[r && Number.isInteger(r.ci) ? r.ci : r ? (parseInt(fnvLite(r.id), 16) % LANE_COLORS.length) : 0];
  function fnvLite(s) { let h = 2166136261; s = String(s || ""); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }
  /** The next colour not used yet (a hand-off copy keeps its object's colour instead). */
  const nextCi = () => { const used = new Set(G.list.map((r) => r.ci)); for (let i = 0; i < LANE_COLORS.length; i++) if (!used.has(i)) return i; return G.list.length % LANE_COLORS.length; };
  const isNum = (v) => typeof v === "number" && isFinite(v);
  /** Validate / clamp one region (from storage, a file or the editor). Returns null when it is unusable. */
  G.clean = (o, keepId) => {
    if (!o || typeof o !== "object" || !T.GRID.includes(o.cam)) return null;
    const r = { id: keepId && o.id ? String(o.id) : "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), cam: o.cam, shape: o.shape === "poly" ? "poly" : o.shape === "ellipse" ? "ellipse" : "rect",
      mode: o.mode === "remove" ? "remove" : o.mode === "mark" ? "mark" : "blur", start: isNum(o.start) && o.start > 0 ? o.start : null, end: isNum(o.end) && o.end >= 0 ? o.end : null, on: o.on !== false, sticky: !!o.sticky, global: !!o.global, v: 1 };
    if (r.end != null && r.start != null && r.end < r.start) { const s = r.start; r.start = r.end; r.end = s; }
    if (r.mode === "mark") { r.mc = /^#[0-9a-f]{6}$/i.test(o.mc || "") ? o.mc.toLowerCase() : MARK_COLORS[0]; if (o.mk === "ring" && r.shape === "rect") r.shape = "ellipse"; }   // (older highlight regions kept a separate box / circle choice: the shape says it now)
    if (Number.isInteger(o.ci) && o.ci >= 0 && o.ci < LANE_COLORS.length) r.ci = o.ci;
    if (o.link && typeof o.link === "string") r.link = o.link.slice(0, 40);
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
    if (PT && o.path) { const tp = PT.cleanPath(o.path); if (tp) r.path = tp; }
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
    for (const r of l) {
      if ((r.start != null && t < r.start - 1e-6) || (r.end != null && t > r.end + 1e-6)) continue;
      if (r.path && PT) { const v = PT.view(r, t); if (!v) continue; (out = out || []).push(v); }   // tracked: where the object is at t (nothing while it is lost)
      else (out = out || []).push(r);
    }
    return out || EMPTY;
  };
  /** Make each tracked region's shape the one it has at time t (default: the player's time), so Move / the editor work on what is on screen. */
  G.sync = (t) => {
    if (!PT) return false;
    if (t == null) t = T.player ? T.player.time || 0 : 0;
    let changed = false;
    for (const r of G.list) {
      if (!r.path) continue;
      const b = PT.pathAt(r.path, t);
      if (b && (Math.abs(b.x - r.x) > 1e-6 || Math.abs(b.y - r.y) > 1e-6 || Math.abs(b.w - r.w) > 1e-6 || Math.abs(b.h - r.h) > 1e-6)) { PT.mapShape(r, b); changed = true; }
    }
    return changed;
  };
  G.any = () => G.list.some((r) => r.on);

  /** The style fields of a new region from the form (mark: its shape and colour). */
  const styleOf = () => (G.ui.mode === "mark" ? { mode: "mark", mc: G.ui.mc } : { mode: G.ui.mode });
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
  function readGlobal() { try { return JSON.parse(localStorage.getItem("tdc.regions.global") || "[]"); } catch (_) { return []; } }
  function sameRegion(a, b) {
    if (a.id && a.id === b.id) return true;
    if (a.cam !== b.cam || a.mode !== b.mode || a.shape !== b.shape) return false;
    if (Math.abs(a.x - b.x) > 0.002 || Math.abs(a.y - b.y) > 0.002 || Math.abs(a.w - b.w) > 0.002 || Math.abs(a.h - b.h) > 0.002) return false;
    return a.shape !== "poly" || JSON.stringify(a.pts) === JSON.stringify(b.pts);
  }
  function uniqueRegions(list) {
    const out = [];
    for (const r of list) if (r && !out.some((q) => sameRegion(q, r))) out.push(r);
    return out;
  }
  function saveGlobal() {
    const g = uniqueRegions(G.list.filter((r) => r.global));
    try { localStorage.setItem("tdc.regions.global", JSON.stringify(g)); } catch (_) {}
  }
  G.load = () => {
    const ev = T.player && T.player.ev;
    G.key = G.eventKey(ev);
    let l = [];
    if (G.key) {
      l = mem[G.key] || (readAll().events[G.key] || {}).regions || [];
    }
    const eventPins = l.map((o) => G.clean(o, true)).filter((r) => r && r.sticky && !r.global);
    const globalPins = readGlobal().map((o) => G.clean(o, true)).filter((r) => r && r.global);
    const merged = uniqueRegions(globalPins.concat(eventPins));
    const dup = eventPins.length + globalPins.length - merged.length;
    G.list = merged.slice(0, G.MAX);
    if (dup > 0) { saveGlobal(); G.save(); }
    G.resetHistory();
    rebuild();
    // repaint after videos have real dimensions so pinned regions land correctly
    const repaint = () => { if (R && R.paint) R.paint(); };
    setTimeout(repaint, 100);
    setTimeout(repaint, 500);
    setTimeout(repaint, 1500);
    if (typeof ResizeObserver !== "undefined" && T.player && T.player.tiles) {
      const ro = new ResizeObserver(repaint);
      for (const cam of Object.keys(T.player.tiles)) {
        const tile = T.player.tiles[cam];
        if (tile && tile.tile) ro.observe(tile.tile);
      }
      setTimeout(() => ro.disconnect(), 3000);
    }
    if (T.player && T.player.tiles) {
      for (const cam of Object.keys(T.player.tiles)) {
        const tile = T.player.tiles[cam];
        const v = tile && (tile.video || (tile.vids && tile.vids[T.player.active]));
        if (v && !v.videoWidth) v.addEventListener("loadedmetadata", repaint, { once: true });
      }
    }
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
    try { if (T.ui && T.ui.drawTimeline) T.ui.drawTimeline(); } catch (_) {}   // (the region bars, and the sections lane's hint, follow)
    if (R && R.paint) R.paint();
    if (UI.sync) UI.sync(keepUi);
    if (T.emit) T.emit("regions", G.list.length);
  }
  G.add = (o) => {
    const r = G.clean(o);
    if (!r) return null;
    if (r.ci == null) r.ci = nextCi();
    if (G.list.length >= G.MAX) return null;
    record(); G.list.push(r); changed(); return r;
  };
  G.update = (id, o) => {
    const i = G.list.findIndex((r) => r.id === id);
    if (i < 0) return null;
    const r = G.clean(Object.assign({}, G.list[i], o, { id }), true);
    if (!r) return null;
    const old = G.list[i];
    // (only a change of the shape itself: switching it on / off, its time range or its style must not touch the path; the stored shape is
    //  rounded to 1e-4, so a re-save alone would look like a tiny move and, where the object is out of sight, wipe the path)
    const shapeEdit = ["x", "y", "w", "h", "pts", "shape"].some((k) => k in o);
    let rearm = null;
    if (PT && shapeEdit && old.path && r.path && (Math.abs(r.x - old.x) > 2e-4 || Math.abs(r.y - old.y) > 2e-4 || Math.abs(r.w - old.w) > 2e-4 || Math.abs(r.h - old.h) > 2e-4)) {
      // the user moved / resized a tracked region at this moment: keep its offset from the object (every key moves the same way); where it was lost, start the path here
      const t = T.player ? T.player.time || 0 : 0, shown = PT.pathAt(old.path, t), nb = { x: r.x, y: r.y, w: r.w, h: r.h };
      if (shown) PT.pathRebase(r.path, shown, nb); else { r.path = []; PT.pathAdd(r.path, t, nb); }
      if (S.patches && S.patches[id]) rearm = t;   // tracked: followed again from here, on the new box
    }
    if (JSON.stringify(r) === JSON.stringify(old)) return r;   // nothing changed: no history step
    record();
    if (!RH[id]) RH[id] = { u: [], r: [] };
    RH[id].u.push(JSON.stringify(G.list[i])); if (RH[id].u.length > 20) RH[id].u.shift(); RH[id].r.length = 0;
    G.list[i] = r; changed();
    if (rearm != null) armRegion(r, rearm);
    return r;
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
  G.sticky = (id, mode) => {
    const r = G.list.find((x) => x.id === id); if (!r) return;
    if (mode === "global") { r.sticky = true; r.global = true; }
    else if (mode === "event") { r.sticky = true; r.global = false; }
    else { r.sticky = false; r.global = false; }
    saveGlobal(); changed(); return r.sticky ? (r.global ? "global" : "event") : "off";
  };
  /** When a region is on: from a to z (seconds), or the whole clip (null, null; also when a..z covers it all). One undo step. */
  G.setTimes = (id, a, z) => {
    const d = dur();
    if (a != null && z != null && a <= 0.05 && (!d || z >= d - 0.05)) { a = null; z = null; }
    return G.update(id, { start: a == null ? null : Math.max(0, a), end: z == null ? null : Math.max(0, z) });
  };
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
    if (r.shape === "ellipse") { const w = r.w * fit.w, h = r.h * fit.h; ctx.ellipse(fit.x + r.x * fit.w + w / 2, fit.y + r.y * fit.h + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2); return; }
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
  /** Highlight (mark mode): nothing is hidden; a box, a circle or the shape's outline is drawn round the object, with a dark edge so it reads on
   *  any background. Line width from the picture size, so the viewer and the export look alike. */
  function mark(ctx, fit, r) {
    const lw = Math.max(2, Math.min(fit.w, fit.h) * 0.007), x0 = fit.x + r.x * fit.w, y0 = fit.y + r.y * fit.h, w = r.w * fit.w, h = r.h * fit.h;
    ctx.save(); ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.beginPath();
    if (r.shape === "ellipse") ctx.ellipse(x0 + w / 2, y0 + h / 2, Math.max(2, w / 2), Math.max(2, h / 2), 0, 0, Math.PI * 2);
    else if (r.shape === "poly" && r.pts) trace(ctx, fit, r);
    else { const p = lw, rad = Math.min(w, h) * 0.12; T.draw && T.draw.rr ? T.draw.rr(ctx, x0 - p, y0 - p, w + 2 * p, h + 2 * p, rad) : ctx.rect(x0 - p, y0 - p, w + 2 * p, h + 2 * p); }
    ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = lw * 2.2; ctx.stroke();
    ctx.strokeStyle = r.mc || MARK_COLORS[0]; ctx.lineWidth = lw; ctx.stroke();
    ctx.restore();
  }
  G.mark = mark;
  function paint(ctx, img, iw, ih, fit, r) {
    if (r.mode === "mark") { mark(ctx, fit, r); return; }
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
    if (S.trackIds && S.trackIds.length) { try { exportTrack(cam, t, iw, ih, img); } catch (e) { console.warn("track (export)", e); } }
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
      if (S.trackIds && S.trackIds.includes(r.id) && r.mode !== "mark") {
        const lostIt = (S.patches[r.id] && S.patches[r.id].lost >= 6);   // not seen for a moment: the blur coasts on, outlined red (it goes when the object leaves the picture)
        ctx.save(); ctx.strokeStyle = lostIt ? "#e5534b" : "#e6b450"; ctx.lineWidth = 2; ctx.setLineDash(lostIt ? [3, 5] : [6, 4]);
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
      const f = frames[cam];
      if (f && f.img && S.trackIds && S.trackIds.length) { try { exportTrack(cam, t, f.w, f.h, f.img); } catch (e) { console.warn("track (export)", e); } }
      const rs = f && f.img ? G.at(cam, t) : EMPTY;
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
    const tr = tile.tile.getBoundingClientRect();
    const tw = tile.tile.clientWidth, th = tile.tile.clientHeight;
    if (!tw || !th) return null;
    const s = Math.min(tw / v.videoWidth, th / v.videoHeight), w = v.videoWidth * s, h = v.videoHeight * s;
    const f = { x: tr.left + (tw - w) / 2, y: tr.top + (th - h) / 2, w, h, mirrored: !!(T.layout && T.layout.mirrored(cam)), tile: tile.tile };
    // digital zoom (focus.js): the video and the redact layer are scaled by z about the tile's centre and shifted by (x, y) as seen on screen
    // (a mirrored camera is flipped after its own shift, so on screen it is the same plain zoom). Drawn points must go through it too, or a box
    // drawn zoomed in lands z times too big and off to the side once you zoom out.
    const F = T.focus;
    if (F && F.cam === cam && F.z > 1.001) {
      const cx = tr.left + tw / 2, cy = tr.top + th / 2;
      f.x = cx + F.x + (f.x - cx) * F.z; f.y = cy + F.y + (f.y - cy) * F.z; f.w *= F.z; f.h *= F.z; f.z = F.z;
    }
    return f;
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
      const ax = p[a * 2], ay = p[a * 2 + 1], bx = p[b * 2], by = p[b * 2 + 1], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
      for (let i = a + 1; i < b; i++) { const d = L < 1e-6 ? Math.hypot(p[i * 2] - ax, p[i * 2 + 1] - ay) : Math.abs((p[i * 2] - ax) * dy - (p[i * 2 + 1] - ay) * dx) / L; if (d > md) { md = d; mi = i; } }   // (a closed loop: its ends meet, so the distance from that end)
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
  const CAM_CONE = { front: "M10 4.5L6.2 0h7.6z", back: "M10 15.5L6.2 20h7.6z", left_pillar: "M7.4 9.5L1 5.2v8.6z", right_pillar: "M12.6 9.5L19 5.2v8.6z", left_repeater: "M7.4 6.5L.6 12.4l3.3 5.4z", right_repeater: "M12.6 6.5l6.8 5.9-3.3 5.4z" };
  const camIco = (c) => '<svg class="cam-ico" viewBox="0 0 20 20" aria-hidden="true"><path class="cone" d="' + (CAM_CONE[c] || "") + '"/><rect class="car" x="7" y="3.5" width="6" height="13" rx="2.6"/></svg>';
  const eventCams = () => T.GRID.filter((c) => T.player && T.player.ev && T.player.ev.cams && T.player.ev.cams.includes(c));
  function clearCamHover() { document.querySelectorAll(".tile.cr-cam-hover").forEach((t) => t.classList.remove("cr-cam-hover")); }
  function hoverCam(cam) {
    clearCamHover();
    const tile = T.player && T.player.tiles && T.player.tiles[cam] && T.player.tiles[cam].tile;
    if (tile) tile.classList.add("cr-cam-hover");
  }
  function openCamMenu(btn, r) {
    let pop = document.getElementById("crCamPop");
    if (pop && !pop.hidden && pop.dataset.for === r.id) { pop.hidden = true; clearCamHover(); return; }
    if (!pop) {
      pop = document.createElement("div");
      pop.id = "crCamPop"; pop.className = "cr-campop"; pop.setAttribute("role", "listbox");
      document.body.appendChild(pop);
      pop.addEventListener("pointerover", (e) => { const opt = e.target.closest("[data-cam]"); if (opt) hoverCam(opt.dataset.cam); });
      pop.addEventListener("pointerout", (e) => { if (!pop.contains(e.relatedTarget)) clearCamHover(); });
      pop.addEventListener("click", (e) => {
        const opt = e.target.closest("[data-cam]"); if (!opt) return;
        const reg = G.list.find((x) => x.id === pop.dataset.for), next = opt.dataset.cam;
        pop.hidden = true; clearCamHover();
        if (reg && next && next !== reg.cam) { G.update(reg.id, { cam: next }); msg("Moved to " + camName(next) + "."); }
      });
    }
    pop.dataset.for = r.id;
    pop.innerHTML = eventCams().map((c) => '<button type="button" class="cr-camopt' + (c === r.cam ? " on" : "") + '" data-cam="' + c + '" role="option" title="' + esc(camName(c)) + '">' + camIco(c) + '<span>' + esc(camName(c)) + '</span></button>').join("");
    pop.hidden = false;
    const box = btn.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    let left = Math.max(8, Math.min(box.left, window.innerWidth - w - 8));
    let top = box.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, box.top - h - 6);
    pop.style.left = left + "px"; pop.style.top = top + "px";
  }
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
  function shapeOf(o) { return o ? (o.shape === "poly" ? { shape: "poly", pts: o.pts } : { shape: o.shape === "ellipse" ? "ellipse" : "rect", x: o.x, y: o.y, w: o.w, h: o.h }) : null; }

  function drawOutline(ctx, f, tr, sh, strong, label) {
    ctx.beginPath();
    if (sh.shape === "poly") { sh.pts.forEach((v, i) => { if (i % 2) return; const [x, y] = G.toScreen(f, v, sh.pts[i + 1]); i ? ctx.lineTo(x - tr.left, y - tr.top) : ctx.moveTo(x - tr.left, y - tr.top); }); ctx.closePath(); }
    else { const [xa, ya] = G.toScreen(f, sh.x, sh.y), [xb, yb] = G.toScreen(f, sh.x + sh.w, sh.y + sh.h), x = Math.min(xa, xb) - tr.left, y = Math.min(ya, yb) - tr.top, w = Math.abs(xb - xa), h = Math.abs(yb - ya);
      if (sh.shape === "ellipse") ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2); else ctx.rect(x, y, w, h); }
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
      if (S.move && S.sel && cam === S.cam) { const r = G.list.find((x) => x.id === S.sel); if (r) { const sh = S.mv && S.mv.id === r.id ? S.mv.sh : shapeOf(r); drawOutline(ctx, f, tr, sh, true); drawHandles(ctx, f, tr, sh, (MODE_NAME[r.mode] || "Blur") + " · " + SHAPE_NAME[r.shape] + (isTracked(r) ? " · tracking" : "")); } }
      if (S.draft && cam === S.cam) drawOutline(ctx, f, tr, shapeOf(S.draft), true);
      if (S.peek && S.peek.cam === cam) drawOutline(ctx, f, tr, S.peek.sh, true);
      if (live) {
        const sh = S.shape === "free" ? { shape: "poly", pts: live.pts.length >= 4 ? live.pts : null } : { shape: S.tool === "circle" ? "ellipse" : "rect", x: Math.min(live.pts[0], live.pts[live.pts.length - 2]), y: Math.min(live.pts[1], live.pts[live.pts.length - 1]), w: Math.abs(live.pts[live.pts.length - 2] - live.pts[0]), h: Math.abs(live.pts[live.pts.length - 1] - live.pts[1]) };
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
      // Freehand (lasso): one stroke, closed when you let go. Outline: the shape stays open for more taps / drags; double-tap, the first point or Done closes it
      if (S.shape === "free" && S.tool === "free" && live.pts.length >= 6) { S.live = null; finishShape(cam, live); return; }
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
    const shown = new Set(G.at(cam, nowT()).map((r) => r.id));   // only what is on the picture now (not one switched off, out of its time range or out of sight)
    const sel = G.list.find((r) => r.id === S.sel && r.cam === cam && shown.has(r.id));
    const list = G.list.filter((r) => r.cam === cam && shown.has(r.id)).reverse();
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
        S.mv.sh = { shape: sh0.shape === "ellipse" ? "ellipse" : "rect", x, y, w: Math.max(0.01, Math.abs(q[0] - anchor[0])), h: Math.max(0.01, Math.abs(q[1] - anchor[1])) };
      } else {
        const du = Math.min(1 - bb.x - bb.w, Math.max(-bb.x, p[0] - p0[0])), dv = Math.min(1 - bb.y - bb.h, Math.max(-bb.y, p[1] - p0[1]));
        S.mv.sh = sh0.shape === "poly" ? { shape: "poly", pts: sh0.pts.map((t, i) => t + (i % 2 ? dv : du)) } : { shape: sh0.shape, x: sh0.x + du, y: sh0.y + dv, w: sh0.w, h: sh0.h };
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
  let moveCap = null;
  function armMoveCapture() {
    if (moveCap) return;
    moveCap = (e) => {
      if (!S.move || e.button !== 0) return;
      const tile = e.target.closest && e.target.closest(".tile");
      if (!tile) return;
      const cam = tile.dataset && tile.dataset.cam;
      if (!cam) return;
      if (cam !== S.cam) {   // a region on another camera: select that one
        const f = G.screenFit(cam), r = f && regionAt(cam, f, e.clientX, e.clientY); if (!r) return;
        S.cam = cam; S.sel = r.id;
      }
      e.preventDefault(); e.stopPropagation();
      moveDown(cam, e);
    };
    document.addEventListener("pointerdown", moveCap, true);
  }
  /* Any region can be pressed and dragged while the Redact panel (or the tray) is open, without pressing Move first: the press selects it
     (the tray shows it: its style, Track for it, Delete), the drag moves it, a box's or circle's corner resizes it. */
  const redactOpen = () => { const U = T.searchUI; return !!(U && U.open && U.tab === "redact") || !!($("crBar") && !$("crBar").hidden); };
  document.addEventListener("pointerdown", (e) => {
    if ((e.pointerType === "mouse" && e.button !== 0) || S.move || S.pick || !redactOpen()) return;
    const tile = e.target.closest && e.target.closest(".tile"), cam = tile && tile.dataset && tile.dataset.cam; if (!cam) return;
    if (S.drawing && S.live) return;   // (a stroke is under way)
    const f = G.screenFit(cam); if (!f) return;
    G.sync();
    const r = regionAt(cam, f, e.clientX, e.clientY); if (!r) return;
    if (S.drawing) return;   // drawing a new region: a press inside an old one still draws (Move, or Done first, picks it)
    e.preventDefault(); e.stopPropagation();
    addEventListener("pointerup", () => setTimeout(hidePanelForDrawing, 0), { once: true, capture: true });   // after the drag: the tray takes over (the panel comes back with Done), so the two don't sit on top of each other
    S.sel = r.id; S.cam = cam; UI.move(true);
    msg(camName(cam) + " · " + (MODE_NAME[r.mode] || "Blur") + " · " + SHAPE_NAME[r.shape] + " selected. Drag it to move it; Track follows it" + (isTracked(r) ? " (on)" : "") + "; Delete removes it.");
    moveDown(cam, e);
  }, true);
  function disarmMoveCapture() { if (moveCap) { document.removeEventListener("pointerdown", moveCap, true); moveCap = null; } }
  UI.move = (on) => {
    on = on === undefined ? !S.move : !!on;
    if (on) {
      const sel = S.sel && G.list.find((r) => r.id === S.sel);
      const cam = (sel && sel.cam) || S.cam;
      if (!cam) { msg("Select a region first.", true); return false; }
      const mine = G.list.filter((r) => r.cam === cam);
      if (!mine.length) { msg("No regions on the " + camName(cam).toLowerCase() + " camera.", true); return false; }
      G.sync();
      S.cam = cam; S.move = true; S.drawing = false; S.live = null; S.pick = false; S.draft = null; S.editId = null;
      if (!mine.some((r) => r.id === S.sel)) S.sel = mine[mine.length - 1].id;
      armMoveCapture();
      msg("Move: drag to move, drag a corner to resize.");
    } else { S.move = false; S.sel = null; S.mv = null; disarmMoveCapture(); }
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
    if (G.undo()) { msg("Undone."); kick(); if (R && R.paint) R.paint(); return true; }   // (also while drawing: the box / circle / highlight just saved goes)
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
  /** Track (tag track-v2). Two ways in:
   *  · a region is selected (press it while the Redact panel is open): Track switches following on / off for that region, from the frame on screen;
   *  · nothing selected: Track is a drawing mode. Every region you draw is followed; a "Track drawing" pill stays on screen (also in the six-camera
   *    view) while it is on, and turning it off ends the drawing completely. */
  S.track = false;
  S.trackIds = [];
  S.patches = {};
  UI.track = (on) => {
    const sel = S.move && S.sel && G.list.find((r) => r.id === S.sel);
    if (sel && on === undefined) return UI.trackRegion(sel.id);
    S.track = on === undefined ? !S.track : !!on;
    if (S.track) {
      if (S.draft && !S.editId) UI.save();   // a drawn, unsaved shape: saved now, and followed
      if (S.move) UI.move(false);
      if (!S.drawing && !S.pick) UI.draw();
      msg("Track: draw round an object on any camera. It is followed from this frame on.");
    } else { stopTrackDrawing(); msg("Track off."); }
    UI.sync(); kick(); syncTrackPill(); return true;
  };
  function stopTrackDrawing() {
    S.track = false; S.armOnSave = false;
    if (S.drawing || S.pick || S.draft) { resetForm(); reopenPanel(true); }
    syncTrackPill();
  }
  /** Follow / stop following one region (it stays where it is on screen now when following stops). */
  UI.trackRegion = (id, on) => {
    const r = G.list.find((x) => x.id === id); if (!r || !PT) return false;
    const now = isTracked(r);
    on = on === undefined ? !now : !!on;
    if (on && !now) { const info = armRegion(r, nowT()); msg(info ? "Tracking this region from " + fmt(nowT()) + ". The bar under the timeline fills as it is followed." : "Couldn't read the picture here. Seek a little, then press Track again.", !info); }
    else if (!on && now) { untrack(r); msg("Tracking off. The region stays where it is now."); }
    UI.sync(); kick(); if (R && R.paint) R.paint(); return true;
  };
  function untrack(r) {
    const inf = S.patches[r.id]; if (inf) { inf.passTok = null; closeReader(inf); }
    delete S.patches[r.id]; S.trackIds = S.trackIds.filter((x) => x !== r.id);
    const b = r.path && PT.pathAt(r.path, nowT()); if (b) PT.mapShape(r, b);
    delete r.path; rebuild(); G.save(); drawLanes();
  }
  G.untrack = (id) => { const r = G.list.find((x) => x.id === id); if (r) untrack(r); };
  /** The pill that says Track drawing is on (every camera view, the six-up grid included), with a button to turn it off. */
  function syncTrackPill() {
    let p = $("crTrackPill");
    if (!S.track) { if (p) p.hidden = true; document.body.classList.remove("cr-track-on"); return; }
    if (!p) {
      p = document.createElement("div"); p.id = "crTrackPill"; p.className = "cr-track-pill"; p.setAttribute("role", "status");
      p.innerHTML = '<span class="dot" aria-hidden="true"></span><span class="t">Track drawing is on: drag round an object on any camera</span><button type="button" class="btn small" id="crTrackOff">Turn off</button>';
      document.body.appendChild(p);
      $("crTrackOff").addEventListener("click", () => UI.track(false));
    }
    p.hidden = false; document.body.classList.add("cr-track-on");
  }
  function videoOf(cam) {
    const tile = T.player && T.player.tiles && T.player.tiles[cam];
    if (!tile) return null;
    const v = tile.vids && T.player ? tile.vids[T.player.active] : null;
    return v && v.videoWidth ? v : (tile.video && tile.video.videoWidth ? tile.video : null);
  }
  function iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const u = a.w * a.h + b.w * b.h - inter;
    return u > 0 ? inter / u : 0;
  }
  function detBoxes(cam) {
    const D = T.detect; if (!D || !D.trackedLive || !T.player) return [];
    return D.trackedLive(cam, T.player.time || 0) || [];
  }
  function lockDet(cam, r) {
    let best = null, sc = 0.22;
    for (const b of detBoxes(cam)) {
      const o = iou(r, b);
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      const inside = cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
      const s = Math.max(o, inside ? 0.36 : 0);
      if (s > sc) { sc = s; best = b; }
    }
    return best;
  }
  function rememberAnchor(r, hit) {
    return { cx: hit.x + hit.w / 2, cy: hit.y + hit.h / 2, hw: hit.w || 0.01, hh: hit.h || 0.01, rx: r.x, ry: r.y, rw: r.w, rh: r.h, pts: r.pts ? r.pts.slice() : null };
  }
  function placeOnHit(r, a, hit) {
    const sx = hit.w / a.hw, sy = hit.h / a.hh, ncx = hit.x + hit.w / 2, ncy = hit.y + hit.h / 2;
    if (a.pts) {
      const pts = [];
      for (let i = 0; i < a.pts.length; i += 2) pts.push(ncx + (a.pts[i] - a.cx) * sx, ncy + (a.pts[i + 1] - a.cy) * sy);
      r.pts = pts;
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]); }
      r.x = x0; r.y = y0; r.w = Math.max(0.01, x1 - x0); r.h = Math.max(0.01, y1 - y0);
    } else {
      r.w = Math.max(0.01, a.rw * sx); r.h = Math.max(0.01, a.rh * sy);
      r.x = ncx + (a.rx + a.rw / 2 - a.cx) * sx - r.w / 2;
      r.y = ncy + (a.ry + a.rh / 2 - a.cy) * sy - r.h / 2;
    }
    r.x = Math.max(0, Math.min(1 - r.w, r.x));
    r.y = Math.max(0, Math.min(1 - r.h, r.y));
  }
  // ── tracker glue (tag track-v2) ──────────────────────────────────────────────────────────────────────────────────
  // js/patch-track.js does the matching (motion model, scale, ambiguity test, sub-pixel). This part feeds it frames, keeps the region's PATH
  // (r.path) and handles the detector lock, seeks, replays and the exporter. A lost object keeps its blur while it coasts (behind a pole, a
  // red dashed outline says it is not seen); when it leaves the picture, or stays unseen for PT.DEFAULTS.coastT, the blur goes ("lost" key in the
  // path) and the whole frame is searched for any of its kept looks every 0.3 s: when it shows up again the blur comes back and tracking goes on.
  const grabCv = document.createElement("canvas");
  /** Grey raster of the part `plan` (0..1 of the picture) of a video / canvas / bitmap / decoded frame of size iw × ih. */
  function grabGrey(src, iw, ih, plan) {
    if (!src || !iw || !ih) return null;
    if (typeof VideoFrame !== "undefined" && src instanceof VideoFrame && R.frameCanvas) src = R.frameCanvas(src, iw, ih);   // WebKit ignores the source rect of a decoded frame
    grabCv.width = plan.SW; grabCv.height = plan.SH;
    const ctx = grabCv.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = plan.nw * iw > 3 * plan.SW ? "high" : "low";   // a big shrink (the whole-frame search): average, don't alias
    let d;
    try { ctx.drawImage(src, plan.nx * iw, plan.ny * ih, plan.nw * iw, plan.nh * ih, 0, 0, plan.SW, plan.SH); d = ctx.getImageData(0, 0, plan.SW, plan.SH).data; } catch (_) { return null; }
    const g = new Float32Array(plan.SW * plan.SH);
    for (let i = 0; i < g.length; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    return { g, W: plan.SW, H: plan.SH, ox: plan.nx, oy: plan.ny, ow: plan.nw, oh: plan.nh };
  }
  const nowT = () => (T.player && T.player.time) || 0;
  const boxOf = (r) => ({ x: r.x, y: r.y, w: r.w, h: r.h });
  // ── the tracking pass (track-v2) ─────────────────────────────────────────────────────────────────────────────────
  // Following an object does not depend on playback: a hidden <video> of the region's camera is stepped through the clip 0.1 s at a time
  // (seek, wait for the frame, look), from the moment tracking starts to the end of the clip, faster than real time. Each look writes the
  // region's path, which the viewer, scrubbing and the export read. The same result on every browser and every run (it used to depend on
  // how fast the page could keep up while playing: on a busy Mac the box fell behind). The region's bar under the timeline fills as it goes.
  // With Object detection on, the app's fast YOLO looks at a crop round the object every 0.5 s (0.25 s while the match is weak) and puts the
  // box right (PT assist). When the object leaves the picture its blur goes, the whole frame is searched every 0.3 s, and the neighbouring
  // camera is searched for it (hand-off, below).
  const PASS_DT = 0.1;
  const readerHost = (() => { let h = null; return () => { if (!h || !h.isConnected) { h = document.createElement("div"); h.className = "cr-readers"; h.setAttribute("aria-hidden", "true"); h.style.cssText = "position:fixed;left:-10000px;top:0;width:320px;height:200px;overflow:hidden;opacity:0;pointer-events:none"; document.body.appendChild(h); } return h; }; })();
  const once = (el, ev, ms) => new Promise((res) => { let done = false; const f = () => { if (done) return; done = true; el.removeEventListener(ev, f); clearTimeout(tm); res(true); }; const tm = setTimeout(() => { if (!done) { done = true; el.removeEventListener(ev, f); res(false); } }, ms); el.addEventListener(ev, f); });
  /** A hidden video of one camera that gives the frame at event time t (null when the camera has no footage there). */
  function makeReader(cam) {
    const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.preload = "auto"; v.setAttribute("playsinline", ""); v.style.cssText = "width:320px;height:200px";
    readerHost().appendChild(v);
    let ci = -1, busy = Promise.resolve(), rvfcOk = true, rvfcMiss = 0;
    const at = async (t) => {
      const P = T.player, ev = P && P.ev; if (!ev) return null;
      const i = P.clipIndexAt(t), c = ev.clips[i], it = c && c.files && c.files[cam];
      if (!it || !it.blob) return null;
      if (ci !== i) { ci = i; v.src = it.url || (it.url = URL.createObjectURL(it.blob)); if (v.readyState < 2) await once(v, "loadeddata", 4000); }
      const lt = Math.max(0, Math.min((isFinite(v.duration) ? v.duration : c.dur || 60) - 0.04, t - c.start));
      if (Math.abs(v.currentTime - lt) > 0.0005) {
        const fr = v.requestVideoFrameCallback && rvfcOk ? new Promise((res) => { try { v.requestVideoFrameCallback(() => res(true)); } catch (_) { res(false); } }) : null;
        v.currentTime = lt; await once(v, "seeked", 4000);
        if (fr) {   // (the decoded frame is really there, not the previous one). A browser that never calls back for a hidden video: seeked only, after twice
          const got = await Promise.race([fr, new Promise((res) => setTimeout(() => res(false), 120))]);
          if (got) rvfcMiss = 0; else if (++rvfcMiss >= 2) rvfcOk = false;
        }
      }
      return v.videoWidth && v.readyState >= 2 ? v : null;
    };
    return { cam, v, at: (t) => (busy = busy.then(() => at(t), () => at(t))), close: () => { try { v.removeAttribute("src"); v.load(); } catch (_) {} v.remove(); } };
  }
  function closeReader(info) { if (info && info.rd) { info.rd.close(); info.rd = null; } }
  /** The kept path up to (not including) time t: re-tracking from t replaces what came after. */
  function cutPath(path, t) { for (let i = 0; i < path.length; i += 5) if (path[i] >= t - 1e-6) { path.length = i; return; } }
  let saveTimer = 0;
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => G.save(), 1200); };
  /** Start following region r from time t (default now): a key at t where the region is drawn, then the pass. */
  function armRegion(r, t) {
    if (!r || !PT) return null;
    if (t == null) t = nowT();
    if (S.hoPending && S.hoPending.to === r.cam) {   // drawn after "Draw it myself": linked to the region it came from, its style and colour
      const src = G.list.find((x) => x.id === S.hoPending.from); S.hoPending = null;
      if (src) { const link = src.link || src.id; src.link = link; r.link = link; r.ci = src.ci; if (r.start == null) r.start = Math.max(0, t - 0.05); }
    }
    const old = S.patches[r.id]; if (old) { old.passTok = null; closeReader(old); }
    const info = { lost: 0, t0: t };
    if (!r.path) r.path = []; else cutPath(r.path, t);
    PT.pathAdd(r.path, t, boxOf(r));
    S.patches[r.id] = info; if (!S.trackIds.includes(r.id)) S.trackIds.push(r.id);
    rebuild(); G.save();
    runPass(r.id, info, t);
    return info;
  }
  G.arm = (id, t) => armRegion(G.list.find((x) => x.id === id), t);
  /** One detector look round the tracker's box on frame v at time t; the box it puts right (or null). */
  async function assistAt(tr, v, cam, t, weak) {
    const D = T.detect, b = tr.box, cw = Math.min(1, b.w * 2.2), ch = Math.min(1, b.h * 2.2);
    const crop = { x: Math.max(0, Math.min(1 - cw, b.x + b.w / 2 - cw / 2)), y: Math.max(0, Math.min(1 - ch, b.y + b.h / 2 - ch / 2)), w: cw, h: ch };
    let dets = null;
    try { dets = await D.detectImage(v, v.videoWidth, v.videoHeight, { conf: 0.3, noFix: true, cam, slot: "fast", crops: [crop], tilesOnly: true, cropConf: 0.3 }); } catch (_) { return null; }
    return tr.assist(dets, t, Object.assign({}, b), weak);
  }
  const detOn = () => { const D = T.detect; return !!(D && D.detectImage && D.enabled && D.enabled()); };
  /** The pass itself: from t0 to the end of the clip (or of the region's time range). Stops when the region is removed, re-armed or untracked. */
  async function runPass(id, info, t0) {
    const tok = (info.passTok = {}), ev = T.player && T.player.ev; if (!ev) return;
    const cur = () => { const r = G.list.find((x) => x.id === id); return r && r.path && S.patches[id] === info && info.passTok === tok ? r : null; };
    let r = cur(); if (!r) return;
    const rd = (info.rd = makeReader(r.cam));
    info.pass = { t0, t: t0, end: ev.duration, done: false };
    drawLanes();
    try {
      let v = await rd.at(t0); r = cur(); if (!r) return;
      if (!v) throw new Error("no picture at " + t0.toFixed(1) + " s");
      const o = { fw: v.videoWidth, fh: v.videoHeight }, box0 = boxOf(r), im0 = grabGrey(v, o.fw, o.fh, PT.createPlan(box0, o));
      if (!im0) throw new Error("the picture can't be read");
      const tr = (info.tr = PT.create(im0, box0, t0, o));
      info.col = colorSig(v, box0);
      const det = detOn();
      if (det) { try { if (T.detect.loadFast) await T.detect.loadFast(); } catch (_) {} await assistAt(tr, v, r.cam, t0, false); }   // the first look: which detection is it?
      let hidden = false, lastSearch = -9, lastDet = t0, n = 0, tPrev = t0;
      const P = T.player, sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      for (;;) {
        r = cur(); if (!r) return;
        const end = Math.min(ev.duration, r.end != null ? r.end : ev.duration); info.pass.end = end;
        // the frame to look at: while the video plays and has caught up with the pass, the picture on screen (its exact frame time; no
        // second decoder busy seeking); otherwise the hidden video, 0.1 s on from the last look (paused, or ahead of playback)
        // (fallen far behind playback, e.g. seeked forward: carry on from the picture on screen; the tracker searches wider after a gap)
        // (while it plays, never the hidden video: a second decoder seeking beside six playing ones is slow on many machines)
        if (P && P.playing && P.time < tPrev + 0.04) { await sleep(30); continue; }
        let t, lv = P && P.playing ? videoOf(r.cam) : null;
        if (lv) {
          const ft = R && R.camTime ? R.camTime(r.cam, lv) : P.time;
          if (!(ft > tPrev + 0.03)) { await sleep(25); continue; }   // the same frame as last time: wait for the next one
          t = +ft.toFixed(3); v = lv;
          if (t - tPrev < 0.08) { await sleep(Math.round((0.08 - (t - tPrev)) * 1000)); continue; }   // about 10 looks a second
        } else {
          t = +(tPrev + PASS_DT).toFixed(3);
          if (t > end + 1e-6) break;
          v = await rd.at(t);
        }
        if (t > end + 1e-6) break;
        r = cur(); if (!r) return; if (!v) break;
        tPrev = t;
        if (hidden) {
          if (t - lastSearch >= 0.3 - 1e-6) { lastSearch = t; const im = grabGrey(v, o.fw, o.fh, tr.searchPlan()); if (im && tr.reacquire(im, t)) { hidden = false; info.hidden = false; } }   // (keys again once two more looks confirm it)
        } else {
          const im = grabGrey(v, o.fw, o.fh, tr.plan(t));
          if (im) {
            const res = tr.update(im, t);
            let box = res.ok && res.probation ? null : res.ok || !res.hide ? res.box : null;
            const weak = !res.ok || res.score < 0.75;
            if (det && !res.hide && t - lastDet >= (weak || tr.assistSoon ? 0.25 : 0.5) - 1e-6) { lastDet = t; const nb = await assistAt(tr, v, r.cam, t, weak); r = cur(); if (!r) return; if (nb && box) box = nb; }
            if (res.ok && res.probation) { /* found again, not confirmed yet: nothing drawn */ }
            else if (box) { PT.pathAdd(r.path, t, box); info.lost = 0; if (res.ok && res.score >= 0.7 && t - (info.colT || -9) > 0.8) { info.col = colorSig(v, tr.box); info.colT = t; } }
            else if (res.hide) {
              hidden = true; info.hidden = true; lastSearch = t;
              if (!PT.pathLostAt(r.path, t)) PT.pathAdd(r.path, t, null);   // "lost from here": nothing is drawn
              if (res.gone && !info.hoDone) { info.hoDone = true; handoffFind(id, info, tr, t); }   // (looked for in the next camera, alongside)
            }
          }
        }
        info.pass.t = t;
        if (++n % 4 === 0) { drawLanes(); saveSoon(); passBadge(id, info); if (Math.abs(nowT() - t) < 1 && R && R.paint) R.paint(); await new Promise((res) => setTimeout(res, 0)); }
      }
      info.pass.done = true;
    } catch (e) { console.warn("track pass", e); if (info.pass) info.pass.err = String((e && e.message) || e); msg("Tracking stopped: " + ((e && e.message) || e) + ".", true); }
    finally {
      if (info.rd === rd) closeReader(info);
      if (info.passTok === tok) { G.save(); drawLanes(); if (R && R.paint) R.paint(); try { UI.sync(); } catch (_) {} }
    }
  }
  function passBadge(id, info) {
    const el = document.querySelector('#crList li[data-id="' + id + '"] .cr-badge.trk'); if (!el || !info.pass) return;
    const pct = Math.round(100 * Math.max(0, Math.min(1, (info.pass.t - info.pass.t0) / Math.max(0.1, info.pass.end - info.pass.t0))));
    el.lastChild.textContent = "Tracking " + pct + " %";
  }
  /** Wait for a region's pass to finish (tests and tools). */
  G.passDone = (id) => new Promise((res) => { const chk = () => { const inf = S.patches[id]; if (!inf || !inf.pass || inf.pass.done || inf.pass.err || !inf.passTok) res(inf && inf.pass); else setTimeout(chk, 100); }; chk(); });
  /** Where the regions sit at the player's time (Move, the list and the editor act on what is shown), and hand-off questions that are due. */
  function followPatches() {
    if (!T.player || !PT) return;
    const t = nowT();
    if (HO.queue.length || HO.active) { try { handoffTick(t); } catch (e) { console.warn("hand-off", e); } }
    if (!S.trackIds.length) return;
    S.trackIds = S.trackIds.filter((id) => G.list.some((r) => r.id === id));
    if (G.sync(t)) { if (R && R.paint) R.paint(); kick(); }
  }
  // ── camera hand-off (track-v2) ──────────────────────────────────────────────────────────────────────────────────────
  // A tracked object that leaves one camera's picture through a side edge goes into the neighbouring camera (js/handoff.js: front → right
  // pillar → right repeater → back → left repeater → left pillar → front). The pass then looks at that camera (its own hidden video) for
  // up to 4 s: the app's detector on the half of the picture it comes in on, the same kind of thing (car / person / bike …), a similar colour.
  // When playback reaches the moment it was found, the video pauses with a purple box: "Is this it?". Yes starts a tracked region there in
  // the same style and colour, linked to the first (1/2, 2/2 in the list). Not this one looks on; Draw it myself lets you point it out;
  // Stop ends it. Nothing is handed over without a yes. Off with the panel's "Follow into the next camera".
  const HOK = "tdc.regions.handoff";
  G.handoffOn = () => { try { return localStorage.getItem(HOK) !== "0"; } catch (_) { return true; } };
  G.setHandoff = (on) => { try { localStorage.setItem(HOK, on ? "1" : "0"); } catch (_) {} if (!on) { HO.queue.length = 0; handoffEnd(); } UI.sync(); };
  const HO = (G.ho = { active: null, queue: [] });
  const colCv = document.createElement("canvas"); colCv.width = colCv.height = 12;
  /** Colour of the middle of a box (mean red, green, blue, 0..255), from a video or decoded frame. */
  function colorSig(src, b) {
    if (!src || !b || !src.videoWidth) return null;
    const iw = src.videoWidth, ih = src.videoHeight, c = 0.6, x = (b.x + b.w * (1 - c) / 2) * iw, y = (b.y + b.h * (1 - c) / 2) * ih, w = Math.max(2, b.w * c * iw), h = Math.max(2, b.h * c * ih);
    try {
      const ctx = colCv.getContext("2d", { willReadFrequently: true }); ctx.drawImage(src, x, y, w, h, 0, 0, 12, 12);
      const d = ctx.getImageData(0, 0, 12, 12).data; let r = 0, g = 0, bl = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; bl += d[i + 2]; }
      const n = d.length / 4; return [r / n, g / n, bl / n];
    } catch (_) { return null; }
  }
  /** 0..1: how alike two colours are (hue and brightness; cameras differ in exposure, so brightness counts less). */
  function colorLike(a, b) {
    if (!a || !b) return 0.5;
    const la = (a[0] + a[1] + a[2]) / 3 + 1, lb = (b[0] + b[1] + b[2]) / 3 + 1;
    const ca = a.map((v) => v / la), cb = b.map((v) => v / lb), dc = Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]), dl = Math.abs(Math.log(la / lb));
    return Math.max(0, 1 - dc * 1.6 - dl * 0.35);
  }
  const KIND = { car: "vehicle", truck: "vehicle", bus: "vehicle", motorcycle: "vehicle", bicycle: "bike", person: "person" }, kindOf = (l) => KIND[l] || l;
  const KIND_NAME = { vehicle: "vehicle", bike: "bike", person: "person" };
  /** The object left region `id`'s camera at time t: which neighbour, and is it there? (runs alongside the pass) */
  function handoffFind(id, info, tr, t) {
    const r = G.list.find((x) => x.id === id);
    if (!r || !G.handoffOn() || !T.handoff || !T.handoff.entryFor) return;
    const b = tr.box, u = tr._u, cx = u ? u.cx : b.x + b.w / 2;
    const side = b.x + b.w >= 0.9 || cx > 0.85 ? "right" : b.x <= 0.1 || cx < 0.15 ? "left" : null;
    if (!side) return;   // it went out at the top or bottom, or faded away in the middle: no neighbour to look in
    const e = T.handoff.entryFor(r.cam, side), ev = T.player && T.player.ev;
    if (!e || !ev || !(ev.cams || []).includes(e.to)) return;
    const h = { from: id, cam: r.cam, to: e.to, entry: e.entry, side, t0: t, at: t, kind: tr._anchor ? tr._anchor.group : null, col: info.col, skip: [], cand: null, state: "search" };
    HO.queue.push(h); drawLanes();
    handoffSearch(h, t);
  }
  /** Look for it in the neighbour camera from time `from`, every 0.3 s, for up to 4 s after it left. No detector: ask the user at once. */
  async function handoffSearch(h, from) {
    if (!detOn()) { h.state = "ask"; h.cand = null; h.at = h.t0; return; }
    const ev = T.player.ev, rd = makeReader(h.to), until = Math.min(ev.duration, h.t0 + 4);
    h.state = "search";
    try {
      for (let tt = from; tt <= until + 1e-6; tt = +(tt + 0.3).toFixed(3)) {
        if (!HO.queue.includes(h)) return;
        const v = await rd.at(tt); if (!v) continue;
        const half = h.entry === "left" ? { x: 0, y: 0, w: 0.62, h: 1 } : { x: 0.38, y: 0, w: 0.62, h: 1 };
        let dets = [];
        try { dets = await T.detect.detectImage(v, v.videoWidth, v.videoHeight, { conf: 0.3, noFix: true, cam: h.to, slot: "fast", crops: [half], tilesOnly: true, cropConf: 0.3 }); } catch (_) { dets = []; }
        let best = null, bs = 0.35;
        for (const d of dets || []) {
          if (h.kind && kindOf(d.label) !== h.kind) continue;
          if (!h.kind && !KIND[d.label]) continue;   // unknown kind: only things that move about (vehicles, bikes, people)
          if (h.skip.some((q) => iou(q, d) > 0.3)) continue;
          const cx = d.x + d.w / 2, edge = h.entry === "left" ? cx : 1 - cx;   // near the edge it comes in on
          if (edge > 0.62 || d.w * d.h < 0.002) continue;
          const sc = 0.45 * (1 - edge / 0.62) + 0.35 * colorLike(h.col, colorSig(v, d)) + 0.2 * d.conf;
          if (sc > bs) { bs = sc; best = d; }
        }
        if (best) { h.cand = { x: best.x, y: best.y, w: best.w, h: best.h, label: best.label, score: bs, t: tt }; h.at = tt; h.state = "ask"; drawLanes(); return; }
      }
      h.state = "none"; HO.queue.splice(HO.queue.indexOf(h), 1); drawLanes();
      msg("The object left the " + camName(h.cam).toLowerCase() + " camera; it wasn't found in the " + camName(h.to).toLowerCase() + " camera. Draw a region there if it shows up.");
    } finally { rd.close(); }
  }
  /** Ask when playback reaches the moment (or at once when paused: the player goes there). */
  function handoffTick(t) {
    if (HO.active) return;
    const h = HO.queue.find((q) => q.state === "ask"); if (!h) return;
    const P = T.player;
    if (P.playing) { if (t < h.at - 0.06) return; }
    else if (Math.abs(t - h.at) > 0.06) { P.seek(h.at); setTimeout(() => handoffTick(h.at), 400); return; }
    HO.active = h; handoffAsk(h);
  }
  G.handoffTick = () => handoffTick(nowT());
  function handoffEnd(text) {
    const h = HO.active; HO.active = null;
    if (h) { const i = HO.queue.indexOf(h); if (i >= 0) HO.queue.splice(i, 1); }
    const c = $("crHo"); if (c) c.hidden = true;
    document.querySelectorAll(".cr-ho-box").forEach((x) => x.remove());
    if (text) msg(text);
    drawLanes();
  }
  function hoCard() {
    let c = $("crHo"); if (c) return c;
    c = document.createElement("div"); c.id = "crHo"; c.className = "cr-handoff"; c.hidden = true; c.setAttribute("role", "dialog"); c.setAttribute("aria-live", "polite"); c.setAttribute("aria-label", "Follow into the next camera");
    c.innerHTML = '<p id="crHoText"></p><div class="row"><button type="button" class="btn small primary" id="crHoYes">Yes, keep tracking</button><button type="button" class="btn small" id="crHoNo">Not this one</button><button type="button" class="btn small ghost" id="crHoDraw">Draw it myself</button><button type="button" class="btn small ghost" id="crHoStop">Stop</button></div>';
    document.body.appendChild(c);
    $("crHoYes").addEventListener("click", () => handoffAccept());
    $("crHoNo").addEventListener("click", () => {   // look on from just after this one
      const h = HO.active; if (!h) return;
      if (h.cand) h.skip.push(h.cand);
      const from = (h.cand ? h.cand.t : h.t0) + 0.3, was = h.wasPlaying; h.cand = null; HO.active = null;
      c.hidden = true; document.querySelectorAll(".cr-ho-box").forEach((x) => x.remove());
      msg("Still looking in the " + camName(h.to).toLowerCase() + " camera…");
      handoffSearch(h, from);
      if (was && T.player) T.player.play();
    });
    $("crHoDraw").addEventListener("click", () => handoffDraw());
    $("crHoStop").addEventListener("click", () => { const h = HO.active; handoffEnd("Hand-off stopped."); if (h && h.wasPlaying && T.player) T.player.play(); });
    return c;
  }
  /** Show the candidate (or, with no detector, ask the user to point it out), paused. */
  function handoffAsk(h) {
    const P = T.player, cand = h.cand; h.wasPlaying = !!(P && P.playing); if (h.wasPlaying) P.pause();
    if (T.focus && T.focus.cam && T.focus.cam !== h.to && T.focus.focus) T.focus.focus(h.to);   // one big camera on screen: show the one it went into
    const src = G.list.find((x) => x.id === h.from), what = h.kind ? KIND_NAME[h.kind] || h.kind : "object";
    const c = hoCard();
    $("crHoText").innerHTML = cand
      ? "The tracked " + esc(what) + " left the <b>" + esc(camName(h.cam)) + "</b> camera. Is this it in the <b>" + esc(camName(h.to)) + "</b> camera (purple box)?"
      : "The tracked " + esc(what) + " left the <b>" + esc(camName(h.cam)) + "</b> camera towards the <b>" + esc(camName(h.to)) + "</b> camera. Object detection is off, so it can't be found there for you: press <b>Draw it myself</b> and drag round it.";
    $("crHoYes").hidden = !cand; $("crHoNo").hidden = !cand;
    c.style.borderColor = src ? G.color(src) : "";
    c.hidden = false;
    document.querySelectorAll(".cr-ho-box").forEach((x) => x.remove());
    if (cand) for (const ms of [60, 250, 600, 1200]) setTimeout(placeHoBox, ms);   // (after the layout settles: the camera may just have been enlarged)
    try { $(cand ? "crHoYes" : "crHoDraw").focus({ preventScroll: true }); } catch (_) {}
  }
  function placeHoBox() {
    const h = HO.active; if (!h || !h.cand || !T.player || !T.player.tiles) return;
    const f = G.screenFit(h.to), tile = T.player.tiles[h.to]; if (!f || !tile) return;
    const tr = tile.tile.getBoundingClientRect(), a = G.toScreen(f, h.cand.x, h.cand.y), b = G.toScreen(f, h.cand.x + h.cand.w, h.cand.y + h.cand.h);
    let el = tile.tile.querySelector(".cr-ho-box"); if (!el) { el = document.createElement("div"); el.className = "cr-ho-box"; el.innerHTML = "<span>Same one?</span>"; tile.tile.appendChild(el); }
    el.style.left = Math.min(a[0], b[0]) - tr.left + "px"; el.style.top = Math.min(a[1], b[1]) - tr.top + "px"; el.style.width = Math.abs(b[0] - a[0]) + "px"; el.style.height = Math.abs(b[1] - a[1]) + "px";
  }
  G.placeHoBox = placeHoBox;
  /** A region on the neighbour camera round `box` at time t, in the source's style and colour, linked to it, tracked from t. */
  function handoffMake(h, box, t) {
    const src = G.list.find((x) => x.id === h.from); if (!src) return null;
    const tr = S.patches[src.id] && S.patches[src.id].tr, A = tr && tr._anchor, rw = A ? A.rw : src.mode === "mark" ? 1.15 : 1.25, rh = A ? A.rh : rw;
    const w = Math.min(1, box.w * rw), hh = Math.min(1, box.h * rh), nb = { x: Math.max(0, Math.min(1 - w, box.x + box.w / 2 - w / 2)), y: Math.max(0, Math.min(1 - hh, box.y + box.h / 2 - hh / 2)), w, h: hh };
    const link = src.link || src.id;
    if (!src.link) { src.link = link; G.save(); }
    const o = { cam: h.to, shape: src.shape === "ellipse" ? "ellipse" : "rect", x: nb.x, y: nb.y, w: nb.w, h: nb.h, mode: src.mode, mc: src.mc, ci: src.ci != null ? src.ci : LANE_COLORS.indexOf(G.color(src)), link, start: Math.max(0, t - 0.05), end: src.end, on: true };
    const r = G.add(o); if (!r) return null;
    armRegion(r, t);
    UI.sync(); kick();
    return r;
  }
  function handoffAccept() {
    const h = HO.active; if (!h || !h.cand) return;
    const r = handoffMake(h, h.cand, h.cand.t), was = h.wasPlaying;
    handoffEnd(r ? "Tracking continues in the " + camName(h.to).toLowerCase() + " camera (linked to the first region, same colour)." : "Couldn't add the region there.");
    if (r && was && T.player) T.player.play();
  }
  /** No detector, or the wrong one shown: the user drags round it on the neighbour camera; that region is linked like a found one. */
  function handoffDraw() {
    const h = HO.active; if (!h) return;
    handoffEnd();
    S.hoPending = { from: h.from, to: h.to }; S.hoDraw = true;
    const src = G.list.find((x) => x.id === h.from);
    if (src) { S.mode = src.mode; if (src.mode === "mark") S.mc = src.mc; }
    UI.setShape(src && src.shape === "ellipse" ? "circle" : "rect");
    S.track = true; syncTrackPill();
    if (T.focus && T.focus.focus) T.focus.focus(h.to);
    choose(h.to, "auto");
    msg(camName(h.to) + ": drag round it. It will be tracked and linked to the first region.");
  }
  /** Export: carry the tracker forward on the frames the exporter decodes, for stretches nobody played (the keys it writes are the region's path from then on). */
  const XT = {};
  function exportTrack(cam, t, iw, ih, src) {
    if (!PT) return;
    for (const id of S.trackIds) {
      const r = G.list.find((x) => x.id === id), info = S.patches[id];
      if (!r || !r.on || r.cam !== cam || !r.path || !info || !info.tr) continue;
      if ((r.start != null && t < r.start) || (r.end != null && t > r.end) || !PT.pathBefore(r.path, t)) continue;
      const ahead = PT.pathAhead(r.path, t);
      if (ahead - t <= 0.3 || (ahead < Infinity && PT.pathLostAt(r.path, t))) { delete XT[id]; continue; }   // already tracked (or out of sight until a later key)
      let x = XT[id];
      if (!x || t < x.t - 0.05 || t - x.t > 1.0) {
        const b = PT.lastBox(r.path, t); if (!b) continue;
        x = XT[id] = { tr: info.tr.fork(), t, hidden: PT.pathLostAt(r.path, t), last: -9 }; x.tr.rewind(b, t, PT.pathVelocity(r.path, t)); continue;   // the first look comes 0.1 s later
      }
      if (x.hidden) {   // out of sight: look for it every 0.3 s on the exporter's frames
        if (t - x.last < 0.3) { x.t = t; continue; }
        x.last = t; x.t = t;
        const im = grabGrey(src, iw, ih, x.tr.searchPlan()), found = im && x.tr.reacquire(im, t);
        if (found) x.hidden = false;   // (keys again once two more looks confirm it)
        continue;
      }
      if (t - x.t < 0.1) continue;
      const im = grabGrey(src, iw, ih, x.tr.plan(t)); if (!im) continue;
      const res = x.tr.update(im, t); x.t = t;
      if (res.ok && res.probation) continue;
      const box = res.ok || !res.hide ? res.box : null;
      if (box) { PT.pathAdd(r.path, t, box); saveSoon(); }
      else { x.hidden = true; x.last = t; if (!PT.pathLostAt(r.path, t)) { PT.pathAdd(r.path, t, null); saveSoon(); } }   // left the picture / lost for good: the blur goes until it is found
    }
  }
  if (T.on) T.on("time", followPatches);
  setInterval(followPatches, 180);


    /** Done: saves a drawn shape; in Move it simply closes the tray (the moves are already saved, and undoable). */
  UI.done = () => {
    const pendingShape = S.draft || (S.shape === "free" && S.live && S.live.pts && S.live.pts.length >= 6);
    if (S.track && !pendingShape) { stopTrackDrawing(); UI.sync(); kick(); msg(S.trackIds.length ? S.trackIds.length + " region" + (S.trackIds.length === 1 ? "" : "s") + " tracking." : "Done."); return true; }   // Done ends Track drawing too
    if (S.trackIds && S.trackIds.length && !pendingShape && !S.move) {
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
      if (w * f.w >= 8 && h * f.h >= 8) sh = { shape: S.tool === "circle" ? "ellipse" : "rect", x, y, w, h };
    }
    if (!sh) { S.drawing = true; msg("That was too small. Drag a bigger " + (S.shape === "free" ? "shape" : S.tool === "circle" ? "circle" : "box") + " on the picture.", true); UI.sync(); kick(); return; }
    S.drawing = false;
    S.draft = sh; S.undone = null;
    if (S.track && !S.editId) { UI.save(); return; }   // Track is on: the region is saved and followed right away, and you can draw the next one
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
    del: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
    done: '<path d="m5 12.5 4.5 4.5L19 7"/>',
    track: '<circle cx="12" cy="12" r="3"/><path d="M12 2a10 10 0 0 1 7 17M12 2a10 10 0 0 0-7 17"/>',
    mark: '<path d="M4 18 14.5 7.5l2 2L6 20H4z"/><path d="m13 9 2 2"/><path d="M15.5 6.5 17.5 4.5l2 2-2 2"/>',
    circle: '<ellipse cx="12" cy="12" rx="8" ry="6.5"/>',
    outline: '<path d="M5 17 8 6l7 2 4 8-9 3z"/><circle cx="5" cy="17" r="1.6" fill="currentColor"/><circle cx="8" cy="6" r="1.6" fill="currentColor"/><circle cx="15" cy="8" r="1.6" fill="currentColor"/><circle cx="19" cy="16" r="1.6" fill="currentColor"/>',
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
      '<span class="seg cr-tseg" id="crBarShape" role="group" aria-label="Shape">' + tb("crBarBox", "rect", "Box", " cr-sv").replace("<button", '<button data-v="rect" aria-pressed="true"') + tb("crBarCircle", "circle", "Circle", " cr-sv").replace("<button", '<button data-v="circle" aria-pressed="false"') +
        tb("crBarOutline", "outline", "Outline", " cr-sv").replace("<button", '<button data-v="outline" aria-pressed="false" title="Outline: tap point by point round it; tap the first point (or double-tap) to close"') + tb("crBarFree", "free", "Freehand", " cr-sv").replace("<button", '<button data-v="free" aria-pressed="false" title="Freehand: drag round it in one stroke; let go to close"') + "</span>" +
      '<span class="seg cr-tseg" id="crBarMode" role="group" aria-label="How to hide">' + tb("crBarBlur", "blur", "Blur", " cr-sv").replace("<button", '<button data-v="blur" aria-pressed="true"') + tb("crBarRemove", "remove", "Remove", " cr-sv").replace("<button", '<button data-v="remove" aria-pressed="false"') + tb("crBarMark", "mark", "Highlight", " cr-sv").replace("<button", '<button data-v="mark" aria-pressed="false"') + "</span>" +
      tb("crBarUndo", "undo", "Undo (" + mod + "Z)", " ghost cr-io").replace('<span class="t">Undo (' + mod + "Z)", '<span class="t">Undo') +
      tb("crBarRedo", "redo", "Redo (" + (mac ? "⇧⌘Z" : "Ctrl+Shift+Z") + ")", " ghost cr-io").replace(/<span class="t">Redo[^<]*/, '<span class="t">Redo') +
      tb("crBarTrack", "track", "Track", " ghost").replace("<button", '<button aria-pressed="false"') +
      '<button type="button" class="btn small ghost cr-tb" id="crBarResetTrack" title="Reset tracking to default">' + ico("undo") + '<span class="t">Reset</span></button>' +
      tb("crBarMove", "move", "Move", " ghost").replace("<button", '<button aria-pressed="false"') +
      tb("crBarDel", "del", "Delete", " ghost").replace("<button", "<button hidden") +
      tb("crBarAgain", "again", "Draw again", "") +
      '<button type="button" class="btn small ghost cr-tb" id="crBarOpts" title="Back to the Redact panel" aria-expanded="false">' + ico("opts") + '<span class="t">Options</span></button>' +
      tb("crBarCancel", "cancel", "Cancel", " ghost") +
      '<button type="button" class="btn small primary cr-tb cr-done" id="crBarSave" title="Save region" aria-label="Done: save region">' + ico("done") + '<span class="t">Done</span></button>' +
      "</span>" +
      '<span class="cr-bar-msg" id="crBarMsg" aria-live="polite"></span>' +
      '<span class="cr-markrow cr-bar-mark" id="crBarMarkRow" hidden>' + markRowHtml("crBarMk") + "</span>";
    document.body.appendChild(b);
    $("crBarSave").addEventListener("click", () => UI.done());
    $("crBarAgain").addEventListener("click", () => UI.draw());
    $("crBarCancel").addEventListener("click", () => UI.cancel());
    $("crBarUndo").addEventListener("click", () => UI.undo());
    $("crBarRedo").addEventListener("click", () => UI.redo());
    $("crBarMove").addEventListener("click", () => UI.move());
    $("crBarDel").addEventListener("click", () => { if (S.sel) { const id = S.sel; G.remove(id); S.sel = null; msg("Region deleted. Undo brings it back."); if (!G.list.length) UI.move(false); UI.sync(); kick(); } });
    $("crBarTrack").addEventListener("click", () => UI.track());
    $("crBarResetTrack").addEventListener("click", () => {
      for (const r of G.list.slice()) if (isTracked(r)) untrack(r);   // the regions stay where they are now; they stop following
      HO.queue.length = 0; handoffEnd(); stopTrackDrawing();
      msg("Tracking reset.");
      UI.sync(); kick();
    });
    $("crBarShape").addEventListener("click", (e) => { const x = e.target.closest("button"); if (x && !x.disabled) UI.setShape(x.dataset.v); });
    $("crBarMode").addEventListener("click", (e) => { const x = e.target.closest("button"); if (x && !x.disabled) UI.setMode(x.dataset.v); });
    wireMarkRow($("crBarMarkRow"));
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
  /** Highlight style: box / circle / outline, and its colour (the region being edited or moved changes with it). */
  UI.setMark = (mk, mc) => {
    if (mc) S.mc = mc;
    S.mode = "mark";
    const id = S.move ? S.sel : null; if (id) G.update(id, styleOf());
    UI.sync(); kick(); if (R && R.paint) R.paint();
  };
  UI.setShape = (v) => {
    if (S.move) return;
    S.tool = ["rect", "circle", "outline", "free"].includes(v) ? v : "rect";
    S.shape = S.tool === "outline" || S.tool === "free" ? "free" : "rect";   // (the drawing code knows two gestures: a drag box, and a point / stroke outline)
    if (!S.editId && S.draft) { S.draft = null; S.undone = null; if (S.cam) S.drawing = true; }   // a new tool: draw the shape again with it
    if (S.drawing) UI.draw();
    UI.sync();
  };
  UI.setMode = (v) => {
    S.mode = v === "remove" ? "remove" : v === "mark" ? "mark" : "blur";
    if (S.move && S.sel) G.update(S.sel, styleOf());
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
    setSeg("crBarShape", selR ? (selR.shape === "poly" ? "outline" : selR.shape === "ellipse" ? "circle" : "rect") : S.tool, !!S.move || !!S.pick);
    setSeg("crBarMode", selR ? selR.mode : S.mode, !!S.pick || (!!S.move && !selR));
    const u = $("crBarUndo"), r = $("crBarRedo");
    u.hidden = false; r.hidden = false;
    u.disabled = !UI.canUndo(); r.disabled = !UI.canRedo();
    u.classList.toggle("on", UI.canUndo()); r.classList.toggle("on", UI.canRedo());
    const trb = $("crBarTrack");
    if (trb) {   // with a region selected, Track is that region's following; otherwise the Track drawing mode
      const on = selR ? isTracked(selR) : !!S.track, t = trb.querySelector(".t");
      trb.classList.toggle("on", on); trb.setAttribute("aria-pressed", String(on));
      const lab = selR ? (on ? "Tracking" : "Track it") : "Track"; if (t) t.textContent = lab;
      trb.title = selR ? (on ? "Following this region's object. Press to stop following (it stays where it is now)." : "Follow this region's object from this frame on") : on ? "Track drawing is on: every region you draw follows its object. Press to turn it off." : "Track drawing: every region you draw follows its object";
    }
    const dlb = $("crBarDel"); if (dlb) dlb.hidden = !selR;
    const mvb = $("crBarMove"), canMove = G.list.length > 0;
    mvb.hidden = !!S.pick; mvb.disabled = !S.move && !canMove; mvb.setAttribute("aria-pressed", String(!!S.move)); mvb.classList.toggle("on", !!S.move);
    b.classList.toggle("moving", !!S.move);
    const chip = $("crBarCam"), has = !!S.cam && !S.pick;
    chip.hidden = !has;
    if (has) { chip.textContent = camName(S.cam); chip.disabled = !!S.editId; chip.title = S.editId ? "The camera of the region you are editing" : "Redacting the " + camName(S.cam) + " camera. Tap to pick a different camera"; chip.setAttribute("aria-label", chip.title); }
    b.classList.toggle("picking", !!S.pick);
    syncMarkRows();
    optsLabel();
  }
  UI.save = () => {
    if (!S.draft) { msg("Draw a region first.", true); return null; }
    const t = readTimes();
    const o = Object.assign({ cam: S.cam, start: t.start, end: t.end }, styleOf(), S.draft);
    let r;
    if (S.editId) r = G.update(S.editId, o);
    else { if (G.list.length >= G.MAX) { msg("That is the most regions for one event (" + G.MAX + "). Delete one first.", true); return null; } r = G.add(o); }
    if (!r) { msg("Couldn't save that region. Draw it again.", true); return null; }
    const was = S.editId;
    let tracking = false;
    if (!was && (S.track || S.armOnSave)) { tracking = !!armRegion(r); S.armOnSave = false; }   // Track was on when this was drawn: it follows the object
    if (!was && S.track && !S.hoDraw) {   // Track drawing stays on: draw the next one right away (same camera; in the grid any camera)
      const cam = r.cam; resetForm(); S.cam = isMulti() ? null : cam; S.drawing = !isMulti(); S.pick = isMulti(); changed();
      msg("Tracking it. Draw round another object, or turn Track off.");
      return r;
    }
    if (S.hoDraw) { S.hoDraw = false; S.track = false; syncTrackPill(); }
    resetForm(); changed(); reopenPanel(true);
    msg(was ? "Region updated." : tracking ? "Region saved and tracking. The bar under the timeline fills as it is followed." : MODE_NAME[r.mode] === "Highlight" ? "Region saved. It is outlined in the viewer and in the export." : "Region saved. It is hidden in the viewer and in the export.");
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
  UI.cancel = () => { const busy = !!(S.drawing || S.pick || S.draft || S.editId || S.move); if (S.track) { S.track = false; S.armOnSave = false; syncTrackPill(); } resetForm(); reopenPanel(busy); UI.sync(); kick(); if (R && R.paint) R.paint(); };
  UI.edit = (id) => {
    const r = G.list.find((x) => x.id === id); if (!r) return;
    S.pick = false; syncPicks([]);
    S.editId = id; S.cam = r.cam; S.shape = r.shape === "poly" ? "free" : "rect"; S.mode = r.mode; if (r.mode === "mark") S.mc = r.mc; S.tool = r.shape === "poly" ? "outline" : r.shape === "ellipse" ? "circle" : "rect"; S.draft = shapeOf(r); S.drawing = false;
    S.whole = r.start == null && r.end == null;
    $("crWhole").checked = S.whole; $("crFrom").value = fmt(r.start || 0); $("crTo").value = fmt(r.end == null ? dur() : r.end);
    if (T.focus && T.focus.focus && T.focus.cam !== r.cam) T.focus.focus(r.cam);
    msg("Editing the " + camName(r.cam).toLowerCase() + " region. Change the settings, or press Draw region to redraw the shape, then Save changes.");
    UI.sync(); kick();
  };
  const MODE_NAME = { blur: "Blur", remove: "Remove", mark: "Highlight" }, SHAPE_NAME = { rect: "box", ellipse: "circle", poly: "outline" };
  /** Is this region following an object? (tracking now, or it has a tracked path from before) */
  const isTracked = (r) => !!(r.path || (S.trackIds && S.trackIds.includes(r.id)));
  function trackState(r) {
    const inf = S.patches && S.patches[r.id];
    if (!inf || !S.trackIds || !S.trackIds.includes(r.id)) return "path";
    if (inf.pass && !inf.pass.done && !inf.pass.err && inf.passTok) return "pass";
    return "on";
  }
  function listHtml() {
    return G.list.map((r, i) => {
      const when = r.start == null && r.end == null ? "whole clip" : fmt(r.start || 0) + " to " + (r.end == null ? "end" : fmt(r.end));
      const tracked = isTracked(r), st = tracked ? trackState(r) : "", link = r.link ? G.list.filter((q) => q.link === r.link) : [];
      const inf = S.patches && S.patches[r.id], pct = st === "pass" ? Math.round(100 * Math.max(0, Math.min(1, (inf.pass.t - inf.pass.t0) / Math.max(0.1, inf.pass.end - inf.pass.t0)))) : 0;
      const badge = tracked ? '<span class="cr-badge trk ' + st + '" title="' + (st === "pass" ? "Following the object through the clip (" + pct + " %)" : "Follows its object (the bar under the timeline is solid where it is seen)") + '">' + ico("track") + (st === "pass" ? "Tracking " + pct + " %" : "Tracking") + "</span>" : "";
      const linkB = link.length > 1 ? '<span class="cr-badge lnk" title="The same object, handed over between cameras">' + (link.indexOf(r) + 1) + "/" + link.length + "</span>" : "";
      const style = r.mode === "mark" ? 'Highlight <i class="cr-dot" style="--sw:' + esc(r.mc) + '"></i>' : MODE_NAME[r.mode] || "Blur";
      const open = S.timeOpen === r.id, whole = r.start == null && r.end == null;
      return '<li class="cr-item' + (r.on ? "" : " off") + (r.id === S.editId ? " editing" : "") + (tracked ? " tracked" : "") + (r.id === S.laneSel ? " sel" : "") + '" data-id="' + esc(r.id) + '" style="--lane:' + G.color(r) + '">' +
        '<label class="cr-on" title="Switch this region on or off (off: not hidden in the viewer or the export)"><input type="checkbox" data-act="on"' + (r.on ? " checked" : "") + ' aria-label="Region ' + (i + 1) + ' on"></label>' +
        '<span class="cr-desc"><b><i class="cr-lane-dot" aria-hidden="true"></i>' + esc(camName(r.cam)) + "</b> · " + style + " · " + SHAPE_NAME[r.shape] +
        '<br><button type="button" class="cr-when" data-act="time" aria-expanded="' + open + '" title="Change when this region is on">' + esc(when) + " ▾</button>" + badge + linkB + "</span>" +
        '<button type="button" class="btn small ghost icon cr-cambtn" data-act="camopen" title="Move from ' + esc(camName(r.cam)) + '" aria-label="Choose camera" aria-haspopup="listbox">' + camIco(r.cam) + '</button>' +
        '<button type="button" class="btn small ghost cr-trkbtn' + (tracked ? " on" : "") + '" data-act="track" aria-pressed="' + tracked + '" title="' + (tracked ? "Stop following the object (the region stays where it is now)" : "Follow the object in this region from the frame on screen") + '">' + ico("track") + '<span>' + (tracked ? "Tracking" : "Track") + "</span></button>" +
        '<button type="button" class="btn small ghost" data-act="go" title="Show this region in the video">Show</button>' +
        '<button type="button" class="btn small ghost icon" data-act="sticky" title="' + (r.global ? 'Global pin' : (r.sticky ? 'Event pin' : 'Pin')) + '" aria-label="Pin" style="opacity:' + (r.sticky ? '1' : '0.4') + '">' +
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="' + (r.sticky ? '#e6b450' : 'none') + '" stroke="' + (r.sticky ? '#e6b450' : '#666') + '" stroke-width="2"><path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>' + (r.global ? '<circle cx="19" cy="5" r="3" fill="#e6b450" stroke="none"/>' : (r.sticky ? '<path d="M19 3l.5 1.5L21 5l-1.5.5L19 7l-.5-1.5L17 5l1.5-.5z" fill="#fff" stroke="none"/>' : '')) + '</svg></button>' +
        '<button type="button" class="btn small ghost" data-act="edit">Edit</button>' +
        '<button type="button" class="btn small ghost" data-act="del" aria-label="Delete region ' + (i + 1) + '">Delete</button>' +
        (open ? '<div class="cr-when-ed" data-ed="1"><label class="cr-chk"><input type="checkbox" data-act="whole"' + (whole ? " checked" : "") + '> Whole clip</label>' +
          '<span class="cr-when-t"' + (whole ? " hidden" : "") + '><label>From <input type="text" data-k="start" inputmode="decimal" autocomplete="off" spellcheck="false" value="' + fmt(r.start || 0) + '" aria-label="Start time"></label><button type="button" class="btn small ghost" data-act="tnow" data-k="start">Now</button>' +
          '<label>to <input type="text" data-k="end" inputmode="decimal" autocomplete="off" spellcheck="false" value="' + fmt(r.end == null ? dur() : r.end) + '" aria-label="End time"></label><button type="button" class="btn small ghost" data-act="tnow" data-k="end">Now</button>' +
          '<button type="button" class="btn small primary" data-act="tapply">Apply</button></span>' +
          '<small class="cr-when-tip">Or drag the ends of its bar under the timeline.</small></div>' : "") +
        "</li>";
    }).join("");
  }
  UI.sync = () => {
    const sec = $("crSec"); if (!sec) return;
    const ev = T.player && T.player.ev, cams = ev && ev.cams ? T.GRID.filter((c) => ev.cams.includes(c)) : [];
    if (S.cam && !cams.includes(S.cam)) S.cam = null;
    if (S.editId && !G.list.some((r) => r.id === S.editId)) { S.editId = null; S.draft = null; }   // ui-glass-7: an undo took away the region being edited
    if (S.sel && !G.list.some((r) => r.id === S.sel)) S.sel = null;
    document.querySelectorAll("#crShape button").forEach((b) => { b.setAttribute("aria-pressed", String(b.dataset.v === S.tool)); b.classList.toggle("on", b.dataset.v === S.tool); });
    document.querySelectorAll("#crMode button").forEach((b) => { b.setAttribute("aria-pressed", String(b.dataset.v === S.mode)); b.classList.toggle("on", b.dataset.v === S.mode); });
    syncMarkRows();
    $("crTimes").hidden = S.whole;
    if ($("crHandoff")) $("crHandoff").checked = G.handoffOn();
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
    if (!($("crList").contains(document.activeElement) && document.activeElement.matches("input[data-k]"))) $("crList").innerHTML = listHtml();   // (not while a time is being typed)
    $("crList").hidden = !n;
    try { drawLanes(); } catch (_) {}
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
    $("crShape").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; UI.setShape(b.dataset.v); });
    $("crMode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; UI.setMode(b.dataset.v); });
    wireMarkRow($("crMarkRow"));
    $("crWhole").addEventListener("change", () => {
      S.whole = $("crWhole").checked;
      if (!S.whole) { const t = T.player ? T.player.time || 0 : 0; if (!$("crFrom").value) $("crFrom").value = fmt(t); if (!$("crTo").value) $("crTo").value = fmt(Math.min(dur(), t + 5)); }
      UI.sync();
    });
    $("crHandoff").addEventListener("change", (e) => G.setHandoff(e.target.checked));
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
      else if (b.dataset.act === "track") { setTimeout(() => UI.trackRegion(id), 0); }
      else if (b.dataset.act === "time") { S.timeOpen = S.timeOpen === id ? null : id; S.laneSel = id; UI.sync(); }
      else if (b.dataset.act === "tnow") { const inp = li.querySelector('input[data-k="' + b.dataset.k + '"]'); if (inp) inp.value = fmt(nowT()); }
      else if (b.dataset.act === "tapply") {
        let a = parseT(li.querySelector('input[data-k="start"]').value), z = parseT(li.querySelector('input[data-k="end"]').value);
        if (!isFinite(a)) a = 0; if (!isFinite(z)) z = dur(); if (z < a) { const q = a; a = z; z = q; }
        G.setTimes(id, a, z); msg("Region on from " + fmt(a) + " to " + fmt(z) + ".");
      }
      else if (b.dataset.act === "camopen") openCamMenu(b, r);
      else if (b.dataset.act === "sticky") {
        const cur = r.global ? "global" : (r.sticky ? "event" : "off");
        const next = cur === "off" ? "event" : (cur === "event" ? "global" : "off");
        G.sticky(id, next);
        msg(next === "global" ? "Pinned globally — applies to every event." : (next === "event" ? "Pinned to this event." : "Unpinned."));
        UI.sync();
      }
      else if (b.dataset.act === "edit") { const U = T.searchUI; if (U && U.closePops) U.closePops(); UI.edit(id); }
      else if (b.dataset.act === "go") {
        if (T.focus && T.focus.focus && T.focus.cam !== r.cam) T.focus.focus(r.cam);
        if (T.player && r.start != null && (T.player.time < r.start || (r.end != null && T.player.time > r.end))) T.player.seek(r.start);
        S.peek = { cam: r.cam, sh: shapeOf(r) }; clearTimeout(S.peekT); S.peekT = setTimeout(() => { S.peek = null; kick(); }, 3500); kick();
      }
    });
    $("crList").addEventListener("change", (e) => {
      const li = e.target.closest("li[data-id]"); if (!li) return;
      if (e.target.dataset.act === "on") G.update(li.dataset.id, { on: e.target.checked });
      else if (e.target.dataset.act === "whole") {
        const r = G.list.find((x) => x.id === li.dataset.id); if (!r) return;
        if (e.target.checked) { G.setTimes(r.id, null, null); msg("Region on for the whole clip."); }
        else { const t = nowT(), a = Math.max(0, t - 2), z = Math.min(dur() || t + 5, t + 5); G.setTimes(r.id, a, z); msg("Region on from " + fmt(a) + " to " + fmt(z) + ". Drag its bar's ends under the timeline, or type the times."); }
      }
    });
    $("crList").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input[data-k]")) { const ap = e.target.closest("li").querySelector('[data-act="tapply"]'); if (ap) { e.preventDefault(); ap.click(); } } });
    document.addEventListener("pointerdown", (e) => {
      const pop = document.getElementById("crCamPop");
      if (!pop || pop.hidden) return;
      if (e.target.closest && (e.target.closest("#crCamPop") || e.target.closest("[data-act='camopen']"))) return;
      pop.hidden = true; clearCamHover();
    });
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
  /** Highlight options: Box / Circle / Outline and a few colours (shared by the panel and the tray). */
  function markRowHtml(pre) {
    return '<span class="cr-swatches" role="group" aria-label="Highlight colour">' + MARK_COLORS.map((c, i) => '<button type="button" class="cr-sw" data-mc="' + c + '" style="--sw:' + c + '" aria-label="Colour ' + (i + 1) + '" id="' + pre + i + '"></button>').join("") +
      '<label class="cr-sw cr-sw-any" title="Any colour" aria-label="Pick any colour"><input type="color" data-pick="1" value="#ff9500"></label></span>';
  }
  function wireMarkRow(el) {
    if (!el) return;
    el.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b && b.dataset.mc) UI.setMark(null, b.dataset.mc); });
    el.addEventListener("input", (e) => { if (e.target.dataset.pick) UI.setMark(null, e.target.value.toLowerCase()); });
  }
  function syncMarkRows() {
    const selR = S.move && G.list.find((r) => r.id === S.sel), on = selR ? selR.mode === "mark" : S.mode === "mark", mc = selR && selR.mode === "mark" ? selR.mc : S.mc;
    for (const id of ["crMarkRow", "crBarMarkRow"]) {
      const el = $(id); if (!el) continue;
      el.hidden = !on;
      let known = false;
      el.querySelectorAll("[data-mc]").forEach((b) => { const o = b.dataset.mc === mc; known = known || o; b.classList.toggle("on", o); b.setAttribute("aria-pressed", String(o)); });
      const any = el.querySelector(".cr-sw-any"); if (any) { any.classList.toggle("on", !known); any.style.setProperty("--sw", known ? "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" : mc); const inp = any.querySelector("input"); if (!known && inp && inp.value !== mc) inp.value = mc; }
    }
  }
  function build() {
    const sec = document.createElement("details");
    sec.className = "cr-sec us-t-redact"; sec.id = "crSec"; sec.open = true;   // always open: no accordion click needed (redact-button)
    sec.innerHTML =
      '<summary>Custom regions <span id="crCount"></span></summary>' +
      '<p class="cr-hint" id="crHint">For what automatic redaction misses, like a curved plate. Press <b>Draw region</b>, tap the camera you want, then drag over the area. Regions stay put on the picture and are burned into the export.</p>' +
      '<div class="cr-grid">' +
      '<div class="cr-f"><span>Shape</span><div class="seg" id="crShape" role="group" aria-label="Shape"><button type="button" data-v="rect" aria-pressed="true">Box</button><button type="button" data-v="circle" aria-pressed="false">Circle</button><button type="button" data-v="outline" aria-pressed="false" title="Tap point by point round it; tap the first point to close">Outline</button><button type="button" data-v="free" aria-pressed="false" title="Drag round it in one stroke">Freehand</button></div></div>' +
      '<div class="cr-f"><span>Hide with</span><div class="seg" id="crMode" role="group" aria-label="How to hide"><button type="button" data-v="blur" aria-pressed="true" title="A strong blur: the text can\'t be read">Blur</button><button type="button" data-v="remove" aria-pressed="false" title="A solid black shape">Remove (black)</button><button type="button" data-v="mark" aria-pressed="false" title="Nothing hidden: a box, circle or outline round it, to point it out">Highlight</button></div></div>' +
      '<div class="cr-f cr-markrow" id="crMarkRow" hidden><span>Colour</span>' + markRowHtml("crMk") + "</div>" +
      '<div class="cr-f"><span>When</span><label class="cr-chk"><input type="checkbox" id="crWhole" checked> Whole clip</label></div>' +
      '<div class="cr-f"><span>Tracking</span><label class="cr-chk" title="When a tracked object drives out of one camera, look for it in the next camera and ask you before following it there"><input type="checkbox" id="crHandoff" checked> Follow into the next camera (asks first)</label></div>' +
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
  // ── region lanes under the timeline (one colour-coded bar per region: when it is on; for a tracked region, solid where the object is
  //    followed and faint where it is out of sight). Drag a bar's ends to trim it; tap a bar to select the region and jump there. ──
  // Where: inside the timeline's lower lane while it holds no sections (no extra bar under the timeline); below the timeline, thin, otherwise.
  const GRAB = 9;
  let lanesEl = null, lanesCv = null, laneDrag = null, laneRows = [];
  /** The empty sections lane can hold the region bars. */
  G.lanesInLane = () => { try { const g = T.ui && T.ui.tlGeom && T.ui.tlGeom(); return !!(g && g.laneH && !g.sections && G.list.length && T.player && T.player.ev); } catch (_) { return false; } };
  function ensureLanes() {
    if (!lanesEl) {
      lanesEl = document.createElement("div"); lanesEl.className = "cr-lanes"; lanesEl.id = "crLanes"; lanesEl.hidden = true;
      lanesEl.setAttribute("role", "group"); lanesEl.setAttribute("aria-label", "Custom regions on the timeline: drag the ends of a bar to change when that region is on");
      lanesCv = document.createElement("canvas"); lanesCv.id = "crLanesCanvas";
      lanesEl.appendChild(lanesCv);
      wireLanes();
    }
    const tl = $("timeline"), scrub = document.querySelector(".tp-scrub"), inLane = G.lanesInLane();
    const want = inLane ? tl : scrub && scrub.parentNode;
    if (want && lanesEl.parentNode !== want) { if (inLane) want.appendChild(lanesEl); else want.insertBefore(lanesEl, scrub.nextSibling); }
    lanesEl.classList.toggle("in-lane", !!inLane);
    return want ? lanesEl : null;
  }
  /** Seen / out-of-sight stretches of a tracked region's path: [[t0, t1, seen], …] (flat keys t, x, y, w, h; w = 0 is "lost from here"). */
  function pathSpans(r, d) {
    const p = r.path; if (!p || p.length < 5) return null;
    const out = []; let t0 = p[0], seen = p[3] > 0;
    for (let i = 5; i < p.length; i += 5) { const sn = p[i + 3] > 0; if (sn !== seen) { out.push([t0, p[i], seen]); t0 = p[i]; seen = sn; } }
    out.push([t0, seen ? Math.min(d, p[p.length - 5] + 0.15) : d, seen]);
    return out;
  }
  const laneList = () => G.list.slice(0, 40);
  function laneGeom() {
    const U = T.ui; if (!U || !U.tlGeom || !lanesCv) return null;
    const g = U.tlGeom(), host = lanesCv.getBoundingClientRect();
    return { left: g.left - host.left, w: g.w, X: (t) => g.left - host.left + ((t - g.v0) / g.span) * g.w, T: (x) => g.v0 + ((x - (g.left - host.left)) / g.w) * g.span, g };
  }
  function drawLanes() {
    const el = ensureLanes(); if (!el) return;
    const ev = T.player && T.player.ev, list = laneList(), show = !!ev && list.length > 0 && !document.body.classList.contains("mb-slim");
    if (el.hidden === show) el.hidden = !show;
    if (!show) { if (T.ui && T.ui.drawTimeline && el._was) { el._was = false; } return; }
    const inLane = el.classList.contains("in-lane"), n = list.length, tg = T.ui.tlGeom();
    let H, rows = [];
    if (inLane) {   // inside the empty sections lane: bars share its height
      const top = tg.laneTop, lh = tg.laneH, bh = Math.max(3, Math.min(10, (lh - 4) / n - 2)), gap = Math.max(1, Math.min(3, (lh - n * bh) / (n + 1)));
      el.style.top = top + "px"; el.style.height = lh + "px"; H = lh;
      for (let i = 0; i < n; i++) rows.push({ y: gap + i * (bh + gap), h: bh });
    } else {
      const bh = 7, gap = 2; H = n * (bh + gap) + gap; el.style.top = ""; el.style.height = Math.min(H, 5 * (bh + gap) + gap) + "px";
      for (let i = 0; i < n; i++) rows.push({ y: gap + i * (bh + gap), h: bh });
    }
    laneRows = rows;
    const W = el.clientWidth, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!W) return;
    lanesCv.style.height = H + "px"; lanesCv.style.width = W + "px";
    if (lanesCv.width !== Math.round(W * dpr) || lanesCv.height !== Math.round(H * dpr)) { lanesCv.width = Math.round(W * dpr); lanesCv.height = Math.round(H * dpr); }
    const ctx = lanesCv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const g = laneGeom(); if (!g) return;
    const d = dur() || 0, X = (t) => Math.max(g.left - 2, Math.min(g.left + g.w + 2, g.X(t)));
    list.forEach((r, i) => {
      const { y, h: LH } = rows[i], col = G.color(r), rad = LH / 2;
      const live = laneDrag && laneDrag.id === r.id ? laneDrag : null;
      const a = live ? live.a : r.start == null ? 0 : r.start, z = live ? live.z : r.end == null ? d : r.end;
      if (!inLane) { ctx.fillStyle = "rgba(255,255,255,0.05)"; T.draw.rr(ctx, g.left, y, g.w, LH, rad); ctx.fill(); }
      const x0 = X(a), x1 = Math.max(x0 + 4, X(z));
      ctx.globalAlpha = r.on ? 1 : 0.35;
      const spans = isTracked(r) ? pathSpans(r, d) : null, inf = S.patches && S.patches[r.id], pass = inf && inf.pass && !inf.pass.done && inf.passTok ? inf.pass : null;
      if (spans) {   // the range faint, the stretches where the object is followed solid
        ctx.fillStyle = col + "40"; T.draw.rr(ctx, x0, y, x1 - x0, LH, rad); ctx.fill();
        ctx.save(); T.draw.rr(ctx, x0, y, x1 - x0, LH, rad); ctx.clip(); ctx.fillStyle = col;
        const upTo = pass ? pass.t : Infinity;
        for (const [s0, s1, seen] of spans) if (seen) { const sa = X(Math.max(a, s0)), sb = X(Math.min(z, s1, upTo)); if (sb > sa) ctx.fillRect(sa, y, Math.max(1.5, sb - sa), LH); }
        if (pass) {   // still being followed: stripes from where the pass is
          const px = X(pass.t); ctx.fillStyle = "rgba(255,255,255,0.18)";
          for (let x = px - (Date.now() / 40) % 8; x < x1; x += 8) ctx.fillRect(x, y, 3, LH);
          ctx.fillStyle = "#fff"; ctx.fillRect(px - 1, y, 2, LH);
        }
        ctx.restore();
      } else { ctx.fillStyle = col + (r.mode === "mark" ? "c0" : "e0"); T.draw.rr(ctx, x0, y, x1 - x0, LH, rad); ctx.fill(); }
      if (r.id === S.laneSel || r.id === S.sel || live) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.2; T.draw.rr(ctx, x0 + 0.6, y + 0.6, x1 - x0 - 1.2, LH - 1.2, rad); ctx.stroke(); }
      if (LH >= 5) { ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.fillRect(x0 + 2, y + 1.5, 2, LH - 3); ctx.fillRect(x1 - 4, y + 1.5, 2, LH - 3); }   // the trim handles
      ctx.globalAlpha = 1;
      for (const h of HO.queue) if (h.from === r.id && (h.state === "ask" || h.state === "search")) {   // a hand-off question waiting (purple)
        const hx = X(h.at), cy = y + LH / 2, s2 = Math.max(4, LH / 2 + 1.5);
        ctx.fillStyle = h.state === "ask" ? "#c39bff" : "rgba(195,155,255,0.45)"; ctx.beginPath(); ctx.moveTo(hx, cy - s2); ctx.lineTo(hx + s2, cy); ctx.lineTo(hx, cy + s2); ctx.lineTo(hx - s2, cy); ctx.closePath(); ctx.fill();
      }
    });
    const px = g.X(nowT());   // the playhead
    if (!inLane && px >= g.left && px <= g.left + g.w) { ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.fillRect(Math.round(px) - 0.5, 0, 1, H); }
    if (list.some((r) => { const inf = S.patches && S.patches[r.id]; return inf && inf.pass && !inf.pass.done && inf.passTok; }) && !lanesEl._anim) { lanesEl._anim = setTimeout(() => { lanesEl._anim = 0; drawLanes(); }, 120); }
  }
  G.drawLanes = drawLanes;
  /** Which region / end is under the pointer (client coords); a hand-off marker too. */
  function laneHit(e) {
    const g = laneGeom(); if (!g) return null;
    const rc = lanesCv.getBoundingClientRect(), x = e.clientX - rc.left, y = e.clientY - rc.top, list = laneList();
    let i = laneRows.findIndex((q) => y >= q.y - 2 && y <= q.y + q.h + 2); if (i < 0) return null;
    const r = list[i]; if (!r) return null;
    const d = dur() || 0, a = r.start == null ? 0 : r.start, z = r.end == null ? d : r.end, x0 = g.X(a), x1 = g.X(z);
    const ho = HO.queue.find((h) => h.from === r.id && h.state === "ask" && Math.abs(g.X(h.at) - x) <= 7);
    if (ho) return { r, end: "ho", ho, g };
    const end = Math.abs(x - x0) <= GRAB && Math.abs(x - x0) <= Math.abs(x - x1) ? "a" : Math.abs(x - x1) <= GRAB ? "z" : x > x0 && x < x1 ? "mid" : "out";
    return { r, end, t: Math.max(0, Math.min(d, g.T(x))), g };
  }
  function wireLanes() {
    lanesCv.addEventListener("pointermove", (e) => {
      if (laneDrag) return;
      const h = laneHit(e);
      lanesCv.style.cursor = h && (h.end === "a" || h.end === "z") ? "ew-resize" : h && (h.end === "mid" || h.end === "ho") ? "pointer" : "";
      lanesCv.title = !h ? "" : h.end === "ho" ? "Hand-off: the object may be in the " + camName(h.ho.to) + " camera here. Click to check." : camName(h.r.cam) + " · " + (MODE_NAME[h.r.mode] || "Blur") + (isTracked(h.r) ? " · tracking" : "") + " · " + (h.r.start == null && h.r.end == null ? "whole clip" : fmt(h.r.start || 0) + " to " + fmt(h.r.end == null ? dur() : h.r.end)) + ". Drag the ends to trim.";
    });
    lanesCv.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const h = laneHit(e); if (!h || h.end === "out") return;   // (anywhere else: the timeline scrubs as usual)
      e.preventDefault(); e.stopPropagation();
      S.laneSel = h.r.id;
      if (h.end === "ho") { if (T.player.playing) T.player.pause(); T.player.seek(h.ho.at); setTimeout(() => handoffTick(h.ho.at), 350); return; }
      if (h.end === "a" || h.end === "z") {
        const d = dur() || 0;
        laneDrag = { id: h.r.id, end: h.end, a: h.r.start == null ? 0 : h.r.start, z: h.r.end == null ? d : h.r.end, pid: e.pointerId };
        try { lanesCv.setPointerCapture(e.pointerId); } catch (_) {}
      } else if (h.end === "mid") { if (T.player && T.player.seek) T.player.seek(h.t); UI.sync(); }
      drawLanes();
    });
    const move = (e) => {
      if (!laneDrag || e.pointerId !== laneDrag.pid) return;
      e.stopPropagation();
      const g = laneGeom(); if (!g) return;
      const rc = lanesCv.getBoundingClientRect(), d = dur() || 0, t = Math.max(0, Math.min(d, g.T(e.clientX - rc.left)));
      if (laneDrag.end === "a") laneDrag.a = Math.min(t, laneDrag.z - 0.2); else laneDrag.z = Math.max(t, laneDrag.a + 0.2);
      if (T.player && T.player.seek) T.player.seek(laneDrag.end === "a" ? laneDrag.a : laneDrag.z);   // see the frame where it starts / ends
      drawLanes();
    };
    const up = (e) => {
      if (!laneDrag || e.pointerId !== laneDrag.pid) return;
      e.stopPropagation();
      const L = laneDrag; laneDrag = null;
      G.setTimes(L.id, L.a, L.z);
      const r = G.list.find((x) => x.id === L.id);
      msg(r && r.start == null && r.end == null ? "Region on for the whole clip." : "Region on from " + fmt(L.a) + " to " + fmt(L.z) + ".");
      drawLanes();
    };
    lanesCv.addEventListener("pointermove", move); lanesCv.addEventListener("pointerup", up); lanesCv.addEventListener("pointercancel", up);
    for (const ev of ["click", "dblclick"]) lanesCv.addEventListener(ev, (e) => { if (laneHit(e)) e.stopPropagation(); });
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
        T.on("player-open", () => {   // another event: its own regions; the passes and hand-off questions of the last one stop
          for (const id of Object.keys(S.patches)) { const inf = S.patches[id]; inf.passTok = null; closeReader(inf); }
          S.patches = {}; S.trackIds = []; HO.queue.length = 0; handoffEnd(); if (S.track) { S.track = false; syncTrackPill(); }
          resetForm(); removeOverlays(); G.load(); UI.sync();
        });
        T.on("layout", () => { if (R && R.paintSoon && G.any()) R.paintSoon(); kick(); if (HO.active && HO.active.cand) setTimeout(placeHoBox, 50); });   // only with regions: with none the viewer paints exactly as before
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
      // the lanes follow the timeline (zoom, pan, resize) and the playhead
      if (T.ui && T.ui.drawTimeline && !T.ui.drawTimeline._cr) { const dt0 = T.ui.drawTimeline; T.ui.drawTimeline = function () { const v = dt0.apply(this, arguments); try { drawLanes(); } catch (_) {} return v; }; T.ui.drawTimeline._cr = true; }
      if (T.on) { T.on("time", () => { try { drawLanes(); } catch (_) {} }); T.on("regions", () => { try { drawLanes(); } catch (_) {} }); }
      window.addEventListener("resize", () => { try { drawLanes(); } catch (_) {} });
      G.ready = true;
    } catch (err) { G.error = String((err && err.message) || err); console.warn("[custom-redact] UI failed; regions still burn in:", err); }
  };
})();
