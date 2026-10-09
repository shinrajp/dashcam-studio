/* map.js — route map renderer: OpenStreetMap tiles (or track-only when offline), full route, driven part,
 * moving car dot synced to playback, click-to-seek hit testing. Units-based like the HUD. */
(function () {
  "use strict";
  const T = window.TDC;
  const D = T.draw;
  const M = (T.map = { tiles: new Map(), failures: 0, lastView: null });
  const STYLES = {
    osm: { url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`, attr: "© OpenStreetMap contributors", dim: 0.18, bg: "#d9d4cc" },
    // "Dark" = the same OSM tiles, inverted in the canvas (no third-party tile service / API key needed).
    dark: { url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`, attr: "© OpenStreetMap contributors", dim: 0.12, bg: "#1b1f26", invert: true },
  };
  M.STYLES = STYLES;
  M.canFilter = typeof CanvasRenderingContext2D !== "undefined" && "filter" in CanvasRenderingContext2D.prototype;
  M.tilesEnabled = () => T.prefs.mapTiles && (typeof navigator === "undefined" || navigator.onLine !== false) && M.failures < 12;

  function tile(style, z, x, y, load) {
    const n = 1 << z;
    x = ((x % n) + n) % n;
    if (y < 0 || y >= n) return null;
    const key = `${style}/${z}/${x}/${y}`;
    let t = M.tiles.get(key);
    if (!t && load) {
      const img = new Image();
      img.crossOrigin = "anonymous"; // tiles must not taint the export canvas
      t = { img, ok: false, failed: false };
      img.onload = () => { t.ok = true; T.emit("map-tile"); };
      img.onerror = () => { t.failed = true; M.failures++; };
      img.src = STYLES[style].url(z, x, y);
      M.tiles.set(key, t);
      if (M.tiles.size > 600) { const first = M.tiles.keys().next().value; M.tiles.delete(first); }
    }
    return t || null;
  }

  /** Compute the view (zoom + centre in world px at zoom 0) for a w×h px box. */
  function view(route, w, h, pos, fallbackLL) {
    const pad = Math.max(24, Math.min(w, h) * 0.12);
    if (!route.length) {
      if (!fallbackLL) return null;
      const c = T.telemetry.merc(fallbackLL.lat, fallbackLL.lon);
      return { z: 15, cx: c[0], cy: c[1] };
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of route) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
    const bw = Math.max(x1 - x0, 1e-7), bh = Math.max(y1 - y0, 1e-7);
    let z = Math.floor(Math.log2(Math.min((w - pad * 2) / bw, (h - pad * 2) / bh)));
    z = T.clamp(z, 3, 18);
    if (T.prefs.mapFollow && pos) return { z: Math.min(18, z + 2), cx: pos.x, cy: pos.y };
    return { z, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }

  /** Tiles needed for a view (used for prefetch before export). */
  M.tileList = (v, w, h) => {
    const s = 1 << v.z, out = [];
    const left = v.cx * s - w / 2, top = v.cy * s - h / 2;
    for (let tx = Math.floor(left / 256); tx <= Math.floor((left + w) / 256); tx++)
      for (let ty = Math.floor(top / 256); ty <= Math.floor((top + h) / 256); ty++) out.push([v.z, tx, ty]);
    return out;
  };

  /**
   * Draw the map panel. ctx is already scaled so 1 unit = s px; box is wu × hu units.
   * px-accurate tile drawing needs the real pixel size, so we work in pixels inside (undo the scale).
   */
  M.draw = (ctx, wu, hu, s, t, opts) => {
    opts = opts || {};
    const w = wu * s, h = hu * s;
    ctx.save();
    ctx.scale(1 / s, 1 / s);
    D.rr(ctx, 0, 0, w, h, 18 * s);
    ctx.save();
    ctx.clip();
    const route = T.telemetry.route();
    const pos = T.telemetry.positionAt(t);
    const ev = T.telemetry.event;
    const ll = ev && ev.location && ev.location.lat != null ? ev.location : null;
    const v = view(route, w, h, pos, ll);
    const style = STYLES[T.prefs.mapStyle] || STYLES.osm;
    const useTiles = M.tilesEnabled() && v && opts.tiles !== false;
    ctx.fillStyle = useTiles ? style.bg : "#161a21";
    ctx.fillRect(0, 0, w, h);
    let drewTiles = 0;
    if (v) {
      const zs = 1 << v.z;
      const left = v.cx * zs - w / 2, top = v.cy * zs - h / 2;
      if (useTiles) {
        const inv = style.invert && M.canFilter;
        if (inv) ctx.filter = "invert(1) hue-rotate(180deg) brightness(0.95) contrast(0.9) saturate(0.6)";
        for (const [z, tx, ty] of M.tileList(v, w, h)) {
          const tl = tile("osm", z, tx, ty, opts.load !== false);
          if (tl && tl.ok) { ctx.drawImage(tl.img, Math.round(tx * 256 - left), Math.round(ty * 256 - top), 256, 256); drewTiles++; }
        }
        if (inv) ctx.filter = "none";
        if (style.dim || (style.invert && !M.canFilter)) { ctx.fillStyle = `rgba(10,12,16,${inv || !style.invert ? style.dim : 0.5})`; ctx.fillRect(0, 0, w, h); }
      }
      if (!drewTiles) {
        // track-only fallback: subtle grid
        ctx.strokeStyle = "rgba(255,255,255,0.05)"; ctx.lineWidth = 1;
        const step = 40 * s;
        for (let x = (-left % step + step) % step; x < w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
        for (let y = (-top % step + step) % step; y < h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      }
      const P = (p) => [p.x * zs - left, p.y * zs - top];
      M.lastView = { v, w, h, s, left, top, zs };
      if (route.length > 1) {
        const path = (from, to) => { ctx.beginPath(); for (let i = from; i <= to; i++) { const [x, y] = P(route[i]); i === from ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } };
        ctx.lineJoin = "round"; ctx.lineCap = "round";
        path(0, route.length - 1);
        ctx.strokeStyle = "rgba(0,0,0,0.45)"; ctx.lineWidth = 9 * s; ctx.stroke();
        ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = 5 * s; ctx.stroke();
        let k = 0;
        while (k < route.length - 1 && route[k + 1].t <= t) k++;
        if (k > 0 || (pos && !pos.before)) {
          path(0, k);
          if (pos && !pos.before) { const [x, y] = P(pos); ctx.lineTo(x, y); }
          ctx.strokeStyle = T.TESLA_BLUE; ctx.lineWidth = 6 * s; ctx.stroke();
        }
        const [sx, sy] = P(route[0]), [ex, ey] = P(route[route.length - 1]);
        ctx.fillStyle = "#2EE66E"; ctx.strokeStyle = "#0b0d10"; ctx.lineWidth = 2.5 * s;
        ctx.beginPath(); ctx.arc(sx, sy, 6 * s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#FF6B61";
        ctx.beginPath(); ctx.arc(ex, ey, 6 * s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      if (pos) {
        const [x, y] = P(pos);
        ctx.save();
        ctx.translate(x, y);
        ctx.fillStyle = "rgba(62,106,225,0.25)";
        ctx.beginPath(); ctx.arc(0, 0, 20 * s, 0, Math.PI * 2); ctx.fill();
        ctx.rotate(((pos.h || 0) * Math.PI) / 180);
        ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = 6 * s;
        ctx.fillStyle = "#fff";
        ctx.beginPath(); ctx.arc(0, 0, 10 * s, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = T.TESLA_BLUE;
        ctx.beginPath(); ctx.moveTo(0, -7.5 * s); ctx.lineTo(5.5 * s, 5 * s); ctx.lineTo(0, 2.5 * s); ctx.lineTo(-5.5 * s, 5 * s); ctx.closePath(); ctx.fill();
        ctx.restore();
      } else if (!route.length && ll) {
        const c = T.telemetry.merc(ll.lat, ll.lon);
        D.pin(ctx, c[0] * zs - left, c[1] * zs - top - 10 * s, 18 * s, "#FF6B61");
      }
    }
    // captions
    ctx.restore();
    ctx.save();
    ctx.scale(s, s);
    if (!route.length) {
      const msg = ll ? "Event location (from event.json)" : "No GPS in these clips";
      ctx.font = D.font(14, 600);
      const tw = ctx.measureText(msg).width + 24;
      D.rr(ctx, (wu - tw) / 2, 12, tw, 28, 14); ctx.fillStyle = "rgba(12,14,18,0.78)"; ctx.fill();
      D.text(ctx, msg, wu / 2, 27, 14, "rgba(255,255,255,0.8)", "center", 600);
    }
    if (drewTiles) {
      const a = style.attr;
      ctx.font = D.font(10.5, 500);
      const tw = ctx.measureText(a).width + 12;
      D.rr(ctx, wu - tw - 6, hu - 22, tw, 17, 5); ctx.fillStyle = "rgba(255,255,255,0.78)"; ctx.fill();
      D.text(ctx, a, wu - 12, hu - 13, 10.5, "#222", "right", 500);
    } else if (v && route.length) {
      D.text(ctx, M.tilesEnabled() ? "Loading map…" : "Track only (offline)", wu - 12, hu - 14, 11, "rgba(255,255,255,0.45)", "right", 600);
    }
    if (ev && ev.location && ev.location.city) {
      ctx.font = D.font(13, 700);
      const tw = ctx.measureText(ev.location.city).width + 34;
      D.rr(ctx, 10, hu - 36, tw, 26, 13); ctx.fillStyle = "rgba(12,14,18,0.78)"; ctx.fill();
      D.pin(ctx, 23, hu - 24, 7, "#FF6B61");
      D.text(ctx, ev.location.city, 33, hu - 22, 13, "#fff", "left", 700);
    }
    ctx.restore();
    ctx.lineWidth = 1.5 * 1; ctx.strokeStyle = "rgba(255,255,255,0.14)";
    D.rr(ctx, 0, 0, wu, hu, 18); ctx.stroke();
    ctx.restore();
  };

  /** Route time nearest to (xPx, yPx) in the panel's drawing pixels (same space as the last draw), or null. */
  M.hit = (xPx, yPx) => {
    const lv = M.lastView;
    const route = T.telemetry.route();
    if (!lv || !route.length) return null;
    let best = null, bd = Infinity;
    for (const p of route) {
      const dx = p.x * lv.zs - lv.left - xPx, dy = p.y * lv.zs - lv.top - yPx;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = p; }
    }
    return Math.sqrt(bd) <= 22 * lv.s ? best.t : null;
  };

  /** Load every tile an export at w×h px will need; resolves when loaded or after timeoutMs. */
  M.prefetch = async (wu, hu, s, times, timeoutMs) => {
    if (!M.tilesEnabled()) return;
    const route = T.telemetry.route();
    const ev = T.telemetry.event;
    const ll = ev && ev.location && ev.location.lat != null ? ev.location : null;
    const w = wu * s, h = hu * s;
    const need = new Map();
    for (const t of times) {
      const v = view(route, w, h, T.telemetry.positionAt(t), ll);
      if (!v) continue;
      for (const [z, x, y] of M.tileList(v, w, h)) { const tl = tile("osm", z, x, y, true); if (tl) need.set(`${z}/${x}/${y}`, tl); }
      if (!T.prefs.mapFollow) break;
    }
    const end = performance.now() + (timeoutMs || 8000);
    while (performance.now() < end && [...need.values()].some((t) => !t.ok && !t.failed)) await new Promise((r) => setTimeout(r, 100));
  };
})();
