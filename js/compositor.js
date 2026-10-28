/* compositor.js — draws one complete output frame: 3×2 grid + labels + HUD + map + self-driving badge + time.
 * Used by the exporter; the live view uses the same renderers and the same panel geometry (WYSIWYG). */
(function () {
  "use strict";
  const T = window.TDC;
  const D = T.draw;
  const C = (T.compositor = {});

  /** Overlay unit scale for a grid of height gh px. */
  C.unitScale = (gh) => (gh / 900) * T.prefs.hudScale;
  /** Live view only: like unitScale, but capped by the width so overlays fit narrow layouts (portrait phone 2×3 grid).
   *  Identical to unitScale for the 3×2 grid and a focused camera (they are wider than 1300:900). Exports keep unitScale. */
  C.liveScale = (gw, gh) => Math.min(gh / 900, gw / 1300) * T.prefs.hudScale;
  /** Top-left of a panel (pw × ph px) inside grid rect g, from saved fractions. */
  C.place = (g, pw, ph, pos) => ({ x: g.x + T.clamp(pos.fx, 0, 1) * Math.max(0, g.w - pw), y: g.y + T.clamp(pos.fy, 0, 1) * Math.max(0, g.h - ph) });
  /** Cell i of a cols × rows grid (default 3 × 2, the six-camera grid) inside rect g. */
  C.cellRect = (g, i, gap, cols, rows) => {
    gap = gap || 0; cols = cols || 3; rows = rows || 2;
    const col = i % cols, row = Math.floor(i / cols);
    const cw = (g.w - gap * (cols - 1)) / cols, ch = (g.h - gap * (rows - 1)) / rows;
    return { x: g.x + col * (cw + gap), y: g.y + row * (ch + gap), w: cw, h: ch };
  };
  /** export-cams: grid shape for n exported cameras (n < 6 when the user unticks some). 6 and 5 keep the 3 × 2 grid (5 leaves one free cell);
   *  1–4 pick the cols × rows (with at most one free cell) whose tiles come out biggest in a 16:9 picture, so the cameras fill the frame at
   *  native tile size, with no letterbox beyond what the cameras' own shape gives. 1 → 1×1, 2 → 2×1, 3 → 2×2 (one free cell), 4 → 2×2. */
  C.shape = (n, tile) => {
    if (!(n >= 1 && n < 5)) return { cols: 3, rows: 2 };
    let best = null;
    for (const [c, r] of [[1, 1], [2, 1], [1, 2], [3, 1], [1, 3], [2, 2], [4, 1], [1, 4]]) {
      if (c * r < n || c * r > n + 1) continue;
      const s = Math.min(1920 / (c * tile.w), 1080 / (r * tile.h)), fill = n * s * s * tile.w * tile.h;
      if (!best || fill > best.fill * 1.0000001) best = { cols: c, rows: r, fill };
    }
    return { cols: best.cols, rows: best.rows };
  };

  /** Output geometry for a preset. tile = { w, h } native tile size. */
  C.geometry = (W, H, tile, exact, cols, rows) => {
    if (exact) return { W, H, grid: { x: 0, y: 0, w: W, h: H }, band: null };
    const aspect = ((cols || 3) * tile.w) / ((rows || 2) * tile.h);
    let gw = W, gh = W / aspect;
    if (gh > H) { gh = H; gw = H * aspect; }
    const band = H - gh;
    const grid = { x: (W - gw) / 2, y: band >= 40 ? 0 : (H - gh) / 2, w: gw, h: gh };
    return { W, H, grid, band: band >= 40 ? { x: 0, y: gh, w: W, h: band } : null };
  };

  // ── export-panel: where the car view, map and HUD go in the exported picture ──────────────────────────────
  //  "overlay"  (the old behaviour): panels float on the camera grid where they sit in the viewer.
  //  "fill"     the black letterbox strip of a fixed-size output (Most Compatible 1920×1080) holds the panels; nothing is added.
  //  "panel"    the output grows: a strip below the camera grid (a strip at the side if the grid is taller than wide). The grid keeps its own
  //             size, unscaled (Original resolution: native pixels; Most Compatible: its 1920-wide grid).
  C.EXTRA_MODES = ["overlay", "fill", "panel"];
  C.USABLE_BAND = 96;         // a letterbox thinner than this (px) is not worth filling
  C.STRIP_FRAC = 0.26;        // default strip size as a share of the grid's height (width for a side strip)
  C.STRIP_MIN = 120;          // never thinner than this (px) unless the grid itself is smaller
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);

  /** Which of HUD / map exist for the open event (the car view is judged by the dialog: it is on screen). */
  C.extrasAvailable = () => {
    const tel = T.telemetry, ev = T.player && T.player.ev;
    let hud = false;
    try { const lay = T.hud.layout(tel.status); hud = lay.mode === "full" || (lay.mode === "message" && tel.status !== "none"); } catch (_) {}
    const map = !!((tel.route && tel.route().length > 0) || (ev && ev.location && ev.location.lat != null));
    return { hud, map };
  };
  /** Aspect (w/h) of each panel; only the wanted + available ones. want = { hud, map, car }. */
  C.extraItems = (want, avail) => {
    avail = avail || C.extrasAvailable();
    const out = [];
    if (want.hud && avail.hud) { let a = 5; try { const l = T.hud.layout(T.telemetry.status); if (l.w && l.h) a = l.w / l.h; } catch (_) {} out.push({ k: "hud", a }); }
    if (want.map && avail.map) { const mp = T.prefs.panels.map; out.push({ k: "map", a: mp.wu / mp.hu }); }
    if (want.car && avail.car !== false) out.push({ k: "car", a: 1 });
    return out;
  };
  /** Pack panels into rect r (row, or column when vert), each as large as fits, centred. */
  C.arrange = (r, items, vert) => {
    if (!items.length || r.w < 8 || r.h < 8) return [];
    const pad = Math.max(6, Math.round(Math.min(r.w, r.h) * 0.05)), gap = pad, n = items.length;
    let out;
    if (!vert) {
      const sumA = items.reduce((a, i) => a + i.a, 0);
      const h = Math.max(4, Math.min(r.h - 2 * pad, (r.w - 2 * pad - gap * (n - 1)) / sumA));
      const tot = sumA * h + gap * (n - 1);
      let x = r.x + (r.w - tot) / 2; const y = r.y + (r.h - h) / 2;
      out = items.map((i) => { const o = { k: i.k, x, y, w: i.a * h, h }; x += i.a * h + gap; return o; });
    } else {
      const sumI = items.reduce((a, i) => a + 1 / i.a, 0);
      const w = Math.max(4, Math.min(r.w - 2 * pad, (r.h - 2 * pad - gap * (n - 1)) / sumI));
      const tot = sumI * w + gap * (n - 1);
      let y = r.y + (r.h - tot) / 2; const x = r.x + (r.w - w) / 2;
      out = items.map((i) => { const o = { k: i.k, x, y, w, h: w / i.a }; y += w / i.a + gap; return o; });
    }
    return out.map((o) => {
      const q = { k: o.k, x: Math.round(o.x), y: Math.round(o.y), w: Math.round(o.w), h: Math.round(o.h) };
      if (o.k === "map") { const mp = T.prefs.panels.map; q.su = q.h / mp.hu; q.hu = mp.hu; q.wu = q.w / q.su; }   // drawing units + scale for T.map.draw / prefetch
      return q;
    });
  };
  /** Like arrange, but tries a row and a column and keeps whichever makes the panels bigger (a free grid cell is nearly square). */
  C.arrangeBest = (r, items) => {
    const a = C.arrange(r, items, false), b = C.arrange(r, items, true), area = (l) => l.reduce((t, q) => t + q.w * q.h, 0);
    return area(b) > area(a) ? b : a;
  };
  /** Strip size (px) for a base grid gw × gh: the share of the long side's partner, capped so the strip never needs more than the panels fit. */
  C.stripSize = (gw, gh, items, frac) => {
    frac = frac || C.STRIP_FRAC;
    const vert = gh > gw;
    const base = vert ? gw : gh;
    let sz = Math.max(Math.min(C.STRIP_MIN, base), Math.round(base * frac));
    if (items.length) {   // no taller than the panels can use
      const pad = 12, n = items.length;
      if (!vert) { const sumA = items.reduce((a, i) => a + i.a, 0); sz = Math.min(sz, (gw - 2 * pad - pad * (n - 1)) / sumA + 2 * pad); }
      else { const sumI = items.reduce((a, i) => a + 1 / i.a, 0); sz = Math.min(sz, (gh - 2 * pad - pad * (n - 1)) / sumI + 2 * pad); }
    }
    return even(Math.max(sz, 2 * 12 + 24));
  };
  /** Full output layout. o = { mode, W, H, tile, exact, want:{hud,map,car}, avail, time, frac, order, mirror }.
   *  Returns { W, H, grid, band, mode, panels, strip, order, mirror, note } — geo for drawFrame. mode is what was really used. */
  C.layout = (o) => {
    const items = o.mode === "overlay" ? [] : C.extraItems(o.want || {}, o.avail);
    const n = o.order && o.order.length ? o.order.length : 6, shape = C.shape(n, o.tile), cols = shape.cols, rows = shape.rows;   // export-cams: fewer cameras → another grid shape
    const geom = (W, H, tile, exact) => C.geometry(W, H, tile, exact, cols, rows);
    const mk = (geo, mode, extra) => Object.assign(geo, { mode, order: o.order || null, mirror: o.mirror || [], cols, rows, panels: [], strip: null, note: null }, extra || {});
    if (o.mode !== "fill" && o.mode !== "panel") return mk(geom(o.W, o.H, o.tile, o.exact), "overlay");
    if (!items.length) return mk(geom(o.W, o.H, o.tile, o.exact), o.mode, { extrasOnly: true });   // nothing ticked: plain picture, overlays stay off
    let mode = o.mode, note = null;
    const g0 = geom(o.W, o.H, o.tile, o.exact);
    if (cols * rows > n) {   // export-cams: a free cell in the camera grid (3 or 5 cameras) holds the map / HUD / car view: no letterbox strip, no added strip
      const cell = C.cellRect(g0.grid, n, 0, cols, rows);
      return mk({ W: o.W, H: o.H, grid: g0.grid, band: g0.band }, "fill", { panels: C.arrangeBest(cell, items), strip: cell, freeCell: true });
    }
    if (mode === "fill" && !o.exact && n < 6 && (!g0.band || g0.band.h < C.USABLE_BAND) && g0.grid.h >= o.H - 2 && o.W - g0.grid.w >= C.USABLE_BAND) {
      // export-cams: 1 or 4 cameras are as tall as the frame and leave black areas left and right: grid flush left, the panels fill the right-hand area (no added strip)
      const gw = g0.grid.w, reg = { x: gw, y: 0, w: o.W - gw, h: o.H };
      return mk({ W: o.W, H: o.H, grid: { x: 0, y: 0, w: gw, h: g0.grid.h }, band: null }, "fill", { panels: C.arrange(reg, items, true), strip: reg, side: true });
    }
    if (mode === "fill") {
      if (o.exact || !g0.band || g0.band.h < C.USABLE_BAND || g0.grid.w < o.W - 8) { mode = "panel"; note = "This size has no black area to fill, so the panels get an added strip instead."; }
      else {
        const b = g0.band, tr = o.time === false ? 0 : Math.max(28, Math.min(56, Math.round(b.h * 0.2)));
        const reg = { x: 0, y: b.y + tr, w: o.W, h: b.h - tr };
        return mk({ W: o.W, H: o.H, grid: g0.grid, band: tr ? { x: 0, y: b.y, w: o.W, h: tr } : null }, "fill", { panels: C.arrange(reg, items, false), strip: { x: 0, y: b.y, w: o.W, h: b.h } });
      }
    }
    // add a strip: the base grid is native (exact) or the compatible preset's own 1920-wide grid
    let gw, gh;
    if (o.exact) { gw = o.W; gh = o.H; } else { const aspect = (cols * o.tile.w) / (rows * o.tile.h); gw = o.W; gh = even(o.W / aspect); }
    const vert = gh > gw, sz = C.stripSize(gw, gh, items, o.frac);
    const W = vert ? gw + sz : gw, H = vert ? gh : gh + sz;
    const strip = vert ? { x: gw, y: 0, w: sz, h: gh } : { x: 0, y: gh, w: gw, h: sz };
    return mk({ W, H, grid: { x: 0, y: 0, w: gw, h: gh }, band: null }, "panel", { panels: C.arrange(strip, items, vert), strip, note, gridW: gw, gridH: gh, stripSize: sz });
  };
  /** Camera order and flipped cameras for "Match viewer" (the viewer's layout preset) or "Standard fixed order". */
  C.cameraOrder = (how) => {
    const L = T.layout;
    if (how === "viewer" && L && L.gridOrder) return { order: L.gridOrder(L.preset), mirror: T.GRID.filter((c) => L.mirrored(c)) };
    return { order: T.GRID.slice(), mirror: [] };
  };

  function drawContain(ctx, img, iw, ih, r) {
    const s = Math.min(r.w / iw, r.h / ih);
    const w = iw * s, h = ih * s;
    ctx.drawImage(img, r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h);
  }

  function label(ctx, text, r, s) {
    ctx.font = D.font(15 * s, 700);
    const tw = ctx.measureText(text.toUpperCase()).width;
    const x = r.x + 10 * s, y = r.y + 10 * s, h = 26 * s;
    D.rr(ctx, x, y, tw + 22 * s, h, 7 * s);
    ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fill();
    ctx.fillStyle = "#fff"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(text.toUpperCase(), x + 11 * s, y + h / 2 + 0.5 * s);
  }

  function placeholder(ctx, r, cam, s, clip) {
    ctx.fillStyle = "#0d0f13"; ctx.fillRect(r.x, r.y, r.w, r.h);
    const it = clip && clip.files[cam];
    const msg = !it ? "No " + T.CAM_LABEL[cam].toLowerCase() + " footage" : it.kind === "encrypted" && !it.blob ? "Encrypted" : "Unavailable";
    D.text(ctx, msg, r.x + r.w / 2, r.y + r.h / 2, 18 * s, "rgba(255,255,255,0.35)", "center", 600);
  }

  /** Format the wall-clock time. */
  C.stamp = (d) => (d ? `${T.fmtDate(d)}  ${T.fmtClock(d)}` : "");

  /** Draw the HUD / map / car view into their own rectangles (export "Fill black area" and "Add panel"). */
  C.drawPanels = (ctx, panels, t) => {
    const tel = T.telemetry, st = tel.at(t);
    for (const p of panels) {
      try {
        ctx.save(); ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
        if (p.k === "hud") {
          const lay = T.hud.layout(tel.status);
          if (lay.w && lay.h) {
            const s = Math.min(p.w / lay.w, p.h / lay.h);
            ctx.translate(p.x + (p.w - lay.w * s) / 2, p.y + (p.h - lay.h * s) / 2); ctx.scale(s, s);
            T.hud.draw(ctx, lay, st, tel.status);
          }
        } else if (p.k === "map") {
          ctx.translate(p.x, p.y); ctx.scale(p.su, p.su);
          T.map.draw(ctx, p.wu, p.hu, p.su, t, { load: false });
        } else if (p.k === "car" && T.carView && T.carView.drawCanvas) {
          const S = Math.min(p.w, p.h);
          T.carView.drawCanvas(ctx, p.x + (p.w - S) / 2, p.y + (p.h - S) / 2, S, T.carView.itemsAt ? T.carView.itemsAt(t) : []);
        }
        ctx.restore();
      } catch (e) { try { ctx.restore(); } catch (_) {} console.warn("export panel", p.k, e); }
    }
  };

  /**
   * Draw a frame. geo from C.geometry; frames: { cam: { img, w, h } | null }; t = event time.
   * show = which overlays to burn in (defaults to the user's current toggles).
   */
  C.drawFrame = (ctx, geo, t, frames, show) => {
    show = show || T.prefs.show;
    const { W, H, grid } = geo;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    const ev = T.player.ev;
    const clip = ev ? ev.clips[T.player.clipIndexAt(t)] : null;
    const s = C.unitScale(grid.h);
    const xm = geo.mode === "fill" || geo.mode === "panel";   // panels live outside the grid: the floating overlays are off
    (geo.order || T.GRID).forEach((cam, i) => {
      const r = C.cellRect(grid, i, 0, geo.cols, geo.rows);
      const f = frames[cam];
      if (f && f.img) {
        const flip = !!(geo.mirror && geo.mirror.includes(cam)), wantBoxes = T.burnBoxes && (show.boxes !== undefined ? show.boxes : T.burnBoxes.enabled());
        if (flip) { ctx.save(); ctx.translate(r.x * 2 + r.w, 0); ctx.scale(-1, 1); }   // the viewer's mirrored bottom row: picture (and redaction patches) flipped
        drawContain(ctx, f.img, f.w, f.h, r);
        if (T.redact && T.redact.burn) T.redact.burn(ctx, cam, t, r, f.w, f.h, f.img);
        if (T.regions && T.regions.burn) { try { T.regions.burn(ctx, cam, t, r, f.w, f.h, f.img); } catch (e) { console.warn("custom regions", e); } }   // custom-redact: user-drawn regions, on top of the automatic redaction, in the same (flipped) cell
        if (flip) ctx.restore();
        if (wantBoxes) {
          if (flip && T.burnBoxes.at && T.layout) T.burnBoxes.draw(ctx, cam, t, r, f.w, f.h, T.burnBoxes.at(cam, t).map(T.layout.mirrorBox));   // boxes follow the flipped picture, their text stays readable
          else T.burnBoxes.draw(ctx, cam, t, r, f.w, f.h);
        }
      } else placeholder(ctx, r, cam, s, clip);
      if (show.labels) label(ctx, T.CAM_LABEL[cam], r, s * 0.9);
    });
    const tel = T.telemetry;
    const st = tel.at(t);
    if (show.hud && !xm) {
      const lay = T.hud.layout(tel.status);
      if (lay.mode === "full" || (lay.mode === "message" && tel.status !== "none")) {
        const p = C.place(grid, lay.w * s, lay.h * s, T.prefs.panels.hud);
        ctx.save(); ctx.translate(p.x, p.y); ctx.scale(s, s);
        T.hud.draw(ctx, lay, st, tel.status);
        ctx.restore();
      }
    }
    const hasRoute = tel.route().length > 0 || (ev && ev.location && ev.location.lat != null);
    if (show.map && hasRoute && !xm) {
      const mp = T.prefs.panels.map;
      const p = C.place(grid, mp.wu * s, mp.hu * s, mp);
      ctx.save(); ctx.translate(p.x, p.y); ctx.scale(s, s);
      T.map.draw(ctx, mp.wu, mp.hu, s, t, { load: false });
      ctx.restore();
    }
    if (show.fsd && st) {
      ctx.save();
      const bw = T.hud.badgeWidth(ctx, st);
      const p = C.place(grid, bw * s, T.hud.BADGE_H * s, T.prefs.panels.fsd);
      ctx.translate(p.x, p.y); ctx.scale(s, s);
      T.hud.drawBadge(ctx, bw, st);
      ctx.restore();
    }
    if (show.time) {
      const d = T.player.wallClock(t);
      const text = C.stamp(d) || T.fmtTime(t, true);
      if (geo.band) {
        const b = geo.band, bs = Math.min(b.h / 60, W / 1920 * 1.2);
        D.text(ctx, text, b.x + 28 * bs, b.y + b.h / 2, 26 * bs, "#fff", "left", 700, true);
        if (ev) {
          const right = [ev.trigger && ev.trigger.label, ev.location && ev.location.city].filter(Boolean).join("  ·  ");
          D.text(ctx, right, b.x + b.w - 28 * bs, b.y + b.h / 2, 22 * bs, "rgba(255,255,255,0.65)", "right", 600);
        }
      } else {
        ctx.font = D.font(17 * s, 700, true);
        const tw = ctx.measureText(text).width + 24 * s;
        const x = grid.x + grid.w - tw - 10 * s, y = grid.y + 10 * s;
        D.rr(ctx, x, y, tw, 28 * s, 7 * s); ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fill();
        D.text(ctx, text, x + tw / 2, y + 14.5 * s, 17 * s, "#fff", "center", 700, true);
      }
    }
    if (xm && geo.panels && geo.panels.length) C.drawPanels(ctx, geo.panels, t);
    if (show.carview && !xm && T.carView && T.carView.drawExport) { try { T.carView.drawExport(ctx, grid, t); } catch (e) { console.warn("car view export", e); } }   // ui-v3: "Include car view"
  };
})();
