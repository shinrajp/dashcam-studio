/* motion.js — motion-seeded second looks for people the detector misses (tag occluded-people).
 * A person walking behind a parked car's window, behind a pillar, in a dark garage, scores far below the normal cut-off in the whole frame:
 * small, dark, behind glass, partly hidden. The picture does show something moving, though. This file finds it cheaply:
 *   grab    a 96-wide grey copy of the frame (one tiny canvas read per look)
 *   step    per camera: running background + difference → moving blobs (adaptive to noise and to the scene brightness; a whole-frame
 *           change such as headlights or an exposure jump is ignored and re-learned)
 *   windows blobs → crop windows (person-shaped, padded), ranked; "glass" when inside a parked car's box
 *   enhance contrast stretch + gamma + a CLAHE-style local contrast + highlight (glare) compression on the zoomed crop, before the model sees it
 *   walker  does a candidate's path look like a walking person (moved, steady direction, upright box)?
 * Pure functions (no DOM) so node tests can run them; the sampler/crop helpers at the bottom use a canvas when there is one. */
(function (root) {
  "use strict";
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const CFG = { gw: 96, minThr: 8, maxThr: 40, noiseK: 4, globalFrac: 0.35, maxBlobFrac: 0.5, minCells: 3, merge: 2, bgFast: 0.2, bgSlow: 0.06, minH: 0.05, minW: 0.015, maxWin: 3 };

  /** Fresh per-camera state. */
  const newState = () => ({ w: 0, h: 0, bg: null, t: null, n: 0, last: null });

  /** gray: Uint8 array w*h. Returns { blobs:[{x,y,w,h,cx,cy,cells,energy}], global:bool, thr, mean }. */
  function step(st, gray, w, h, t, cfg) {
    const C = Object.assign({}, CFG, cfg || {});
    const N = w * h;
    let mean = 0; for (let i = 0; i < N; i++) mean += gray[i]; mean /= N;
    if (!st.bg || st.w !== w || st.h !== h) { st.w = w; st.h = h; st.bg = Float32Array.from(gray); st.t = t; st.n = 1; return (st.last = { blobs: [], global: false, thr: 0, mean, learn: true }); }
    if (t < st.t - 0.05 || t - st.t > 12) { st.bg = Float32Array.from(gray); st.t = t; st.n = 1; return (st.last = { blobs: [], global: false, thr: 0, mean, learn: true }); }   // seek: start again
    const bg = st.bg, d = new Uint8Array(N), hist = new Uint32Array(256);
    for (let i = 0; i < N; i++) { const v = Math.min(255, Math.abs(gray[i] - bg[i]) + 0.5) | 0; d[i] = v; hist[v]++; }
    let acc = 0, med = 0; for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= N / 2) { med = k; break; } }
    const dark = clamp(mean / 100, 0, 1), thr = clamp(Math.max(C.minThr + 8 * dark, C.noiseK * 1.48 * med + 2), C.minThr, C.maxThr);
    let over = 0; for (let i = 0; i < N; i++) if (d[i] > thr) over++;
    if (over / N > C.globalFrac) {   // headlights / exposure change / the camera was switched: nothing to seed, learn the new picture
      for (let i = 0; i < N; i++) bg[i] += (gray[i] - bg[i]) * 0.6;
      st.t = t; st.n++; return (st.last = { blobs: [], global: true, thr, mean });
    }
    const mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) { const mv = d[i] > thr; mask[i] = mv ? 1 : 0; bg[i] += (gray[i] - bg[i]) * (mv ? C.bgSlow : C.bgFast); }
    st.t = t; st.n++;
    // dilate (merges the old and the new position of a walker between two looks), then label
    const r = C.merge, dm = new Uint8Array(N);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) dm[yy * w + xx] = 1;
    }
    const seen = new Uint8Array(N), blobs = [], stack = [];
    for (let s = 0; s < N; s++) {
      if (!dm[s] || seen[s]) continue;
      let x0 = w, y0 = h, x1 = 0, y1 = 0, cells = 0, energy = 0; stack.length = 0; stack.push(s); seen[s] = 1;
      while (stack.length) {
        const p = stack.pop(), px = p % w, py = (p / w) | 0;
        if (mask[p]) { cells++; energy += d[p]; }
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
        if (px > 0 && dm[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
        if (px < w - 1 && dm[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
        if (py > 0 && dm[p - w] && !seen[p - w]) { seen[p - w] = 1; stack.push(p - w); }
        if (py < h - 1 && dm[p + w] && !seen[p + w]) { seen[p + w] = 1; stack.push(p + w); }
      }
      if (cells < C.minCells) continue;
      // the dilation grew the box by r on every side
      const bx0 = Math.max(0, x0 + r), by0 = Math.max(0, y0 + r), bx1 = Math.min(w - 1, x1 - r), by1 = Math.min(h - 1, y1 - r);
      const b = { x: bx0 / w, y: by0 / h, w: Math.max(1, bx1 - bx0 + 1) / w, h: Math.max(1, by1 - by0 + 1) / h, cells, energy };
      b.cx = b.x + b.w / 2; b.cy = b.y + b.h / 2;
      if (b.w * b.h > C.maxBlobFrac) continue;
      blobs.push(b);
    }
    blobs.sort((a, b) => b.energy - a.energy);
    return (st.last = { blobs, global: false, thr, mean });
  }

  const iouF = (a, b) => { const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h); const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (a.w * a.h + b.w * b.h - i || 1); };
  const inside = (a, b, frac) => { const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h); return Math.max(0, x2 - x1) * Math.max(0, y2 - y1) >= frac * a.w * a.h; };
  const VEH = new Set(["car", "truck", "bus", "motorcycle"]);

  /** Crop box (0..1) for a person-shaped thing around box b, padded by pad (1 = the usual, 2 = wide for context such as a backpack). */
  function cropFor(b, pad, aspect) {
    pad = pad || 1;
    const px = Math.max(0.03, 0.6 * b.w) * pad, py = Math.max(0.04, 0.35 * b.h) * pad;
    let w = b.w + 2 * px, h = b.h + 2 * py;
    w = Math.max(w, 0.16 * pad); h = Math.max(h, 0.22 * pad, w * (aspect || 1.2));
    w = Math.min(1, w); h = Math.min(1, h);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
  }

  /** Motion blobs → ranked crop windows. dets: this look's detections (cars give "glass", a found person hides the blob). ghosts: [{x,y,w,h,age}] predicted spots of hidden people. */
  function windows(blobs, dets, ghosts, cfg) {
    const C = Object.assign({}, CFG, cfg || {}), out = [];
    const cars = (dets || []).filter((d) => VEH.has(d.label)), people = (dets || []).filter((d) => d.label === "person" && !d.weak);
    for (const b of blobs || []) {
      if (b.h < C.minH || b.w < C.minW) continue;
      if (people.some((p) => iouF(p, b) > 0.15 || inside(b, p, 0.6) || inside(p, b, 0.6))) continue;   // already a person there
      let glass = false, skip = false;
      for (const c of cars) {
        const ca = c.w * c.h, ba = b.w * b.h;
        if (inside(b, c, 0.7) && ba > 0.55 * ca) { skip = true; break; }   // the car itself is moving, not somebody behind its window
        if (inside(b, c, 0.5) && b.cy < c.y + 0.75 * c.h) glass = true;
      }
      if (skip) continue;
      const edge = b.x < 0.12 || b.x + b.w > 0.88;
      out.push({ kind: glass ? "glass" : "motion", box: { x: b.x, y: b.y, w: b.w, h: b.h }, rank: b.energy * (glass ? 1.5 : 1) * (edge ? 1.2 : 1), glass, blob: b });
    }
    out.sort((a, b) => b.rank - a.rank);
    const res = out.slice(0, C.maxWin);
    for (const g of ghosts || []) res.push({ kind: "ghost", box: { x: g.x, y: g.y, w: g.w, h: g.h }, rank: 0, glass: !!g.glass, ghost: g });
    return res;
  }

  /** Does a path look like a person walking? pts [{t,x,y,w,h}] (box, 0..1). Needs >= 3 looks. */
  function walker(pts, opt) {
    const o = Object.assign({ minN: 3, minMove: 0.03, minSpeed: 0.004, maxSpeed: 0.7, straight: 0.5, minAspect: 0.8 }, opt || {});
    if (!pts || pts.length < o.minN) return false;
    const c = pts.map((p) => ({ t: p.t, x: p.x + p.w / 2, y: p.y + p.h / 2, w: p.w, h: p.h }));
    let path = 0; for (let i = 1; i < c.length; i++) path += Math.hypot(c[i].x - c[i - 1].x, c[i].y - c[i - 1].y);
    const net = Math.hypot(c[c.length - 1].x - c[0].x, c[c.length - 1].y - c[0].y), dt = c[c.length - 1].t - c[0].t;
    if (dt <= 0.05) return false;
    const sp = net / dt, asp = c.map((p) => p.h / Math.max(1e-3, p.w)).sort((a, b) => a - b)[c.length >> 1];
    const moved = net >= Math.max(o.minMove, 0.25 * Math.max(...c.map((p) => p.w)));
    return moved && sp >= o.minSpeed && sp <= o.maxSpeed && net / (path || 1) >= o.straight && asp >= o.minAspect;
  }

  /** Enhance an RGBA image in place for the detector: contrast stretch, gamma for dark crops, glare compression, CLAHE-style local contrast.
   *  img: {data: Uint8ClampedArray, width, height}. opt: {glare:bool, tiles:4, clip:3, force:bool}. Returns stats (and { skipped:true } when the crop is already well exposed). */
  function enhance(img, opt) {
    const o = Object.assign({ glare: false, tiles: 4, clip: 3, force: false }, opt || {});
    const { data, width: W, height: H } = img, N = W * H, Y = new Uint8Array(N), hist = new Uint32Array(256);
    let sum = 0;
    for (let i = 0, p = 0; i < N; i++, p += 4) { const y = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) | 0; Y[i] = y; hist[y]++; sum += y; }
    const mean = sum / N;
    let acc = 0, p2 = 0, p98 = 255; for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= 0.02 * N) { p2 = k; break; } }
    acc = 0; for (let k = 255; k >= 0; k--) { acc += hist[k]; if (acc >= 0.02 * N) { p98 = k; break; } }
    const range = p98 - p2;
    if (!o.force && !o.glare && range > 150 && mean > 70 && mean < 185) return { skipped: true, mean, p2, p98 };
    // 1. stretch (gain capped, a flat dark crop is mostly noise), 2. gamma toward a mid-grey mean, 3. glare: soft knee on the top
    const gain = Math.min(6, 235 / Math.max(25, range)), lo = Math.max(0, p2 - 4);
    const lut = new Uint8Array(256); let mid = clamp((mean - lo) * gain / 255, 0.02, 0.98);
    const gamma = clamp(Math.log(0.42) / Math.log(mid), 0.45, 1.0);
    for (let k = 0; k < 256; k++) {
      let v = clamp((k - lo) * gain / 255, 0, 1);
      v = Math.pow(v, gamma);
      if (o.glare && v > 0.8) v = 0.8 + 0.2 * (1 - Math.exp(-(v - 0.8) / 0.12)) * (1 / (1 - Math.exp(-0.2 / 0.12)));
      lut[k] = Math.round(clamp(v, 0, 1) * 255);
    }
    for (let i = 0; i < N; i++) Y[i] = lut[Y[i]];
    // 4. CLAHE-style: per-tile histograms with a clip limit, bilinear blending of the tile mappings
    const T = o.tiles, tw = W / T, th = H / T, maps = new Array(T * T);
    for (let ty = 0; ty < T; ty++) for (let tx = 0; tx < T; tx++) {
      const h = new Float32Array(256), x0 = Math.floor(tx * tw), x1 = Math.floor((tx + 1) * tw), y0 = Math.floor(ty * th), y1 = Math.floor((ty + 1) * th);
      let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { h[Y[y * W + x]]++; n++; }
      const lim = Math.max(1, o.clip * n / 256); let ex = 0; for (let k = 0; k < 256; k++) if (h[k] > lim) { ex += h[k] - lim; h[k] = lim; }
      const add = ex / 256, m = new Uint8Array(256); let c = 0; for (let k = 0; k < 256; k++) { c += h[k] + add; m[k] = Math.round(255 * c / (n || 1)); }
      maps[ty * T + tx] = m;
    }
    const at = (cx, cy, v) => maps[clamp(cy, 0, T - 1) * T + clamp(cx, 0, T - 1)][v];
    for (let y = 0; y < H; y++) {
      const fy = (y + 0.5) / th - 0.5, ty0 = Math.floor(fy), wy = fy - ty0;
      for (let x = 0; x < W; x++) {
        const fx = (x + 0.5) / tw - 0.5, tx0 = Math.floor(fx), wx = fx - tx0, i = y * W + x, v = Y[i];
        const ny = (at(tx0, ty0, v) * (1 - wx) + at(tx0 + 1, ty0, v) * wx) * (1 - wy) + (at(tx0, ty0 + 1, v) * (1 - wx) + at(tx0 + 1, ty0 + 1, v) * wx) * wy;
        Y[i] = ny < 0 ? 0 : ny > 255 ? 255 : ny | 0;
      }
    }
    // apply as a luma gain on the colour pixels (hue kept), ratio capped so noise isn't blown up
    for (let i = 0, p = 0; i < N; i++, p += 4) {
      const y0 = Math.max(6, 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]);
      const r = Math.min(5, Y[i] / y0);
      data[p] = clamp(data[p] * r, 0, 255); data[p + 1] = clamp(data[p + 1] * r, 0, 255); data[p + 2] = clamp(data[p + 2] * r, 0, 255);
    }
    return { skipped: false, mean, p2, p98, gain, gamma };
  }

  const api = { CFG, newState, step, windows, cropFor, walker, enhance, iou: iouF };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }

  // ── browser helpers ──
  const T = (root.TDC = root.TDC || {});
  const M = (T.motion = api);
  let gcv = null, gctx = null, ccv = null, cctx = null;
  /** Grey copy of a video / canvas, gw wide: { gray, w, h } or null when the frame can't be read. */
  M.grab = (src, iw, ih) => {
    try {
      const w = CFG.gw, h = Math.max(8, Math.round(w * ih / iw));
      if (!gcv || gcv.width !== w || gcv.height !== h) { gcv = document.createElement("canvas"); gcv.width = w; gcv.height = h; gctx = gcv.getContext("2d", { willReadFrequently: true }); }
      gctx.drawImage(src, 0, 0, w, h);
      const px = gctx.getImageData(0, 0, w, h).data, g = new Uint8Array(w * h);
      for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = (0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2]) | 0;
      return { gray: g, w, h };
    } catch (_) { return null; }
  };
  /** Zoomed, enhanced copy of crop c (0..1 of the frame) as a canvas, longest side `size` px. Returns { canvas, w, h, stats } or null. */
  M.cropCanvas = (src, iw, ih, c, size, opt) => {
    try {
      const sw = iw * c.w, sh = ih * c.h, sc = Math.min(size / sw, size / sh, 6), w = Math.max(16, Math.round(sw * sc)), h = Math.max(16, Math.round(sh * sc));
      if (!ccv) { ccv = document.createElement("canvas"); cctx = ccv.getContext("2d", { willReadFrequently: true }); }
      ccv.width = w; ccv.height = h;   // (resets the canvas)
      cctx.imageSmoothingQuality = "high";
      cctx.drawImage(src, iw * c.x, ih * c.y, sw, sh, 0, 0, w, h);
      let stats = { skipped: true };
      if (!opt || opt.enhance !== false) { const id = cctx.getImageData(0, 0, w, h); stats = enhance(id, opt); if (!stats.skipped) cctx.putImageData(id, 0, 0); }
      return { canvas: ccv, w, h, stats };
    } catch (_) { return null; }
  };
})(typeof window !== "undefined" ? window : globalThis);
