/* compositor.js — draws one complete output frame: 3×2 grid + labels + HUD + map + self-driving badge + time.
 * Used by the exporter; the live view uses the same renderers and the same panel geometry (WYSIWYG). */
(function () {
  "use strict";
  const T = window.TDC;
  const D = T.draw;
  const C = (T.compositor = {});

  /** Overlay unit scale for a grid of height gh px. */
  C.unitScale = (gh) => (gh / 900) * T.prefs.hudScale;
  /** Top-left of a panel (pw × ph px) inside grid rect g, from saved fractions. */
  C.place = (g, pw, ph, pos) => ({ x: g.x + T.clamp(pos.fx, 0, 1) * Math.max(0, g.w - pw), y: g.y + T.clamp(pos.fy, 0, 1) * Math.max(0, g.h - ph) });
  C.cellRect = (g, i, gap) => {
    gap = gap || 0;
    const col = i % 3, row = Math.floor(i / 3);
    const cw = (g.w - gap * 2) / 3, ch = (g.h - gap) / 2;
    return { x: g.x + col * (cw + gap), y: g.y + row * (ch + gap), w: cw, h: ch };
  };

  /** Output geometry for a preset. tile = { w, h } native tile size. */
  C.geometry = (W, H, tile, exact) => {
    if (exact) return { W, H, grid: { x: 0, y: 0, w: W, h: H }, band: null };
    const aspect = (3 * tile.w) / (2 * tile.h);
    let gw = W, gh = W / aspect;
    if (gh > H) { gh = H; gw = H * aspect; }
    const band = H - gh;
    const grid = { x: (W - gw) / 2, y: band >= 40 ? 0 : (H - gh) / 2, w: gw, h: gh };
    return { W, H, grid, band: band >= 40 ? { x: 0, y: gh, w: W, h: band } : null };
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
    T.GRID.forEach((cam, i) => {
      const r = C.cellRect(grid, i, 0);
      const f = frames[cam];
      if (f && f.img) drawContain(ctx, f.img, f.w, f.h, r);
      else placeholder(ctx, r, cam, s, clip);
      if (show.labels) label(ctx, T.CAM_LABEL[cam], r, s * 0.9);
    });
    const tel = T.telemetry;
    const st = tel.at(t);
    if (show.hud) {
      const lay = T.hud.layout(tel.status);
      if (lay.mode === "full" || (lay.mode === "message" && tel.status !== "none")) {
        const p = C.place(grid, lay.w * s, lay.h * s, T.prefs.panels.hud);
        ctx.save(); ctx.translate(p.x, p.y); ctx.scale(s, s);
        T.hud.draw(ctx, lay, st, tel.status);
        ctx.restore();
      }
    }
    const hasRoute = tel.route().length > 0 || (ev && ev.location && ev.location.lat != null);
    if (show.map && hasRoute) {
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
  };
})();
