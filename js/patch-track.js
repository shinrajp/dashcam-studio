/* patch-track.js — the template tracker behind Custom regions ▸ Track (tag track-v2).
 * Pure functions on grey rasters. No DOM and no globals except the export, so the same code runs in the page, in Node (test/patch-track.js)
 * and in the old-vs-new benchmark (tools/track-bench.js).
 *
 * What it adds over the single 32 × 32 patch matcher it replaces:
 *   · motion model     alpha-beta filter on the box centre: the search window is centred where the object should be, so fast or accelerating
 *                      things (a sign sliding past, a car overtaking) stay inside it. The first looks use a wider window to learn the speed.
 *   · scale            the match is tried at several sizes (±6 %, wider after a loss) and the box grows / shrinks with the object.
 *   · precision        coarse stride-2 normalised cross-correlation, then a stride-1 refine and a parabolic sub-pixel peak.
 *   · ambiguity        the best peak is compared with the best peak elsewhere: a look-alike (a second sign, a repeating texture) is refused
 *                      unless the match is excellent; a mild pull towards the predicted spot breaks ties.
 *   · no drift         the working template is blended slowly and only from very good looks that still agree with the ORIGINAL template.
 *   · recovery         after a miss the box coasts on its speed for a moment, the window widens, and the original template is tried too.
 *
 * Coordinates are 0..1 of the camera's raw frame. A raster ("Img") is { g: grey values, W, H, ox, oy, ow, oh }: the part [ox,oy,ow,oh] of the frame
 * drawn at W × H pixels. Tracker.plan(t) says which part to draw; Tracker.update(img, t) looks at it.
 *
 * A region that is tracked also carries a PATH (flat array, 5 numbers per key: t, x, y, w, h; w = h = 0 is a "lost from here" key). The path is the
 * truth the viewer, scrubbing and the exporter all read (G.at), so a tracked region follows its object everywhere, not only while playing. */
(function (root) {
  "use strict";
  const PT = {};
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // ── rasters ────────────────────────────────────────────────────────────────────────────────────────────────────
  /** Bilinear resample of the part of the frame that starts at (u0, v0) with pixel pitch (du, dv), onto SW × SH pixels. */
  function resample(img, u0, v0, du, dv, SW, SH) {
    const out = new Float32Array(SW * SH), W = img.W, H = img.H, g = img.g, kx = W / img.ow, ky = H / img.oh;
    for (let j = 0; j < SH; j++) {
      let y = (v0 + (j + 0.5) * dv - img.oy) * ky - 0.5;
      y = y < 0 ? 0 : y > H - 1 ? H - 1 : y;
      const y0 = y | 0, y1 = y0 + 1 < H ? y0 + 1 : y0, fy = y - y0, r0 = y0 * W, r1 = y1 * W;
      for (let i = 0; i < SW; i++) {
        let x = (u0 + (i + 0.5) * du - img.ox) * kx - 0.5;
        x = x < 0 ? 0 : x > W - 1 ? W - 1 : x;
        const x0 = x | 0, x1 = x0 + 1 < W ? x0 + 1 : x0, fx = x - x0;
        const a = g[r0 + x0], b = g[r0 + x1], c = g[r1 + x0], d = g[r1 + x1];
        out[j * SW + i] = a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
      }
    }
    return out;
  }
  PT.resample = resample;

  // ── templates ──────────────────────────────────────────────────────────────────────────────────────────────────
  /** Zero-mean template with its energy, plus the stride-2 lattice used by the coarse search. */
  function finishTemplate(g, tw, th) {
    const n = g.length; let m = 0;
    for (let i = 0; i < n; i++) m += g[i];
    m /= n;
    let e = 0;
    for (let i = 0; i < n; i++) { g[i] -= m; e += g[i] * g[i]; }
    const lw = (tw + 1) >> 1, lh = (th + 1) >> 1, l = new Float32Array(lw * lh);
    let k = 0, lm = 0;
    for (let j = 0; j < th; j += 2) for (let i = 0; i < tw; i += 2) { l[k] = g[j * tw + i]; lm += l[k++]; }
    lm /= l.length;
    let le = 0;
    for (let i = 0; i < l.length; i++) { l[i] -= lm; le += l[i] * l[i]; }
    const std = Math.sqrt(e / n);
    return { g, tw, th, e: Math.sqrt(e) || 1, std, flat: std < 2.5, l, lw, lh, le: Math.sqrt(le) || 1 };
  }
  /** The middle `c` (share of width and height) of a template as a template of its own. */
  function cropTemplate(T, c) {
    const w = Math.max(8, Math.round(T.tw * c)), h = Math.max(8, Math.round(T.th * c)), ox = (T.tw - w) >> 1, oy = (T.th - h) >> 1, g = new Float32Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) g[j * w + i] = T.g[(oy + j) * T.tw + ox + i];
    return finishTemplate(g, w, h);
  }
  function cloneTemplate(T) { return finishTemplate(Float32Array.from(T.g), T.tw, T.th); }
  /** Template size in pixels for a box: the object's own pixels, long side at most maxT, short side at least minT. */
  PT.templateDims = (box, o) => {
    o = Object.assign({}, DEFAULTS, o);
    const pw = box.w * o.fw, ph = box.h * o.fh, s = Math.min(1, o.maxT / Math.max(pw, ph, 1));
    return { tw: Math.max(o.minT, Math.round(pw * s)), th: Math.max(o.minT, Math.round(ph * s)) };
  };
  /** The part of the frame to draw (and at what size) to start a tracker on `box`: the box plus a little all round. */
  PT.createPlan = (box, o) => {
    const d = PT.templateDims(box, o), pad = 0.08;
    const nx = clamp(box.x - box.w * pad, 0, 1), ny = clamp(box.y - box.h * pad, 0, 1);
    const nw = Math.min(1 - nx, box.w * (1 + 2 * pad)), nh = Math.min(1 - ny, box.h * (1 + 2 * pad));
    return { nx, ny, nw, nh, SW: Math.max(d.tw + 2, Math.round(nw / box.w * d.tw)), SH: Math.max(d.th + 2, Math.round(nh / box.h * d.th)) };
  };

  // ── correlation ────────────────────────────────────────────────────────────────────────────────────────────────
  /** Normalised cross-correlation of the template with the raster window at (px, py), every pixel. -1 for a flat window. */
  function nccFull(R, SW, px, py, T) {
    const tw = T.tw, th = T.th, g = T.g;
    let sI = 0, sII = 0, sIT = 0;
    for (let j = 0; j < th; j++) {
      let o = (py + j) * SW + px, k = j * tw;
      for (let i = 0; i < tw; i++, o++, k++) { const v = R[o]; sI += v; sII += v * v; sIT += v * g[k]; }
    }
    const n = tw * th, ev = sII - sI * sI / n;
    return ev > n ? sIT / (Math.sqrt(ev) * T.e) : -1;
  }
  /** The same on every second pixel (4 × cheaper): the coarse search. */
  function nccLat(R, SW, px, py, T) {
    const l = T.l, lw = T.lw, lh = T.lh;
    let sI = 0, sII = 0, sIT = 0, k = 0;
    for (let j = 0; j < lh; j++) {
      let o = (py + 2 * j) * SW + px;
      for (let i = 0; i < lw; i++, o += 2, k++) { const v = R[o]; sI += v; sII += v * v; sIT += v * l[k]; }
    }
    const n = lw * lh, ev = sII - sI * sI / n;
    return ev > n ? sIT / (Math.sqrt(ev) * T.le) : -1;
  }
  /** Correlation of two equal-size zero-mean templates. */
  function corr(a, b) { let d = 0; for (let i = 0; i < a.g.length; i++) d += a.g[i] * b.g[i]; return d / (a.e * b.e); }

  /** The four halves of a template (left, right, top, bottom) as templates of their own, with where each sits inside it. Cached on the template. */
  function makeParts(T) {
    const tw = T.tw, th = T.th, hw = tw >> 1, hh = th >> 1, out = [];
    if (hw < 8 || hh < 8) return out;
    const cut = (ox, oy, w, h) => {
      const g = new Float32Array(w * h);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) g[j * w + i] = T.g[(oy + j) * tw + ox + i];
      const q = finishTemplate(g, w, h); q.ox = ox; q.oy = oy; return q;
    };
    for (const q of [cut(0, 0, hw, th), cut(tw - hw, 0, hw, th), cut(0, 0, tw, hh), cut(0, th - hh, tw, hh)]) if (!q.flat) out.push(q);
    return out;
  }

  // ── tracker ────────────────────────────────────────────────────────────────────────────────────────────────────
  const DEFAULTS = {
    fw: 1280, fh: 960,               // the frame in pixels: decides how finely the template samples the object
    minT: 12, maxT: 44,              // template size limits (pixels)
    margin: 0.7, maxMargin: 2.4, maxRaster: 150,    // motion gate: how far (in box sizes) from the predicted spot a match may be; raster side cap
    gateGrow: 0.5, coastKeep: 0.8,   // the gate grows this much per second without a match; the speed is kept this long (s) before it fades
    partOk: 0.78, partGain: 0.12,     // a half of the template must score this well, and this much better than the whole, to stand in for it
    weakPull: 0.03, weakRamp: 0.8, weakJump: 0.6,   // a weak match moves the box this share of the way, and only if it is within this many box sizes of the prediction
    accept: 0.5, trust: 0.65, minMargin: 0.04, sure: 0.8, weak: 0.38, strongMargin: 0.15,   // acceptance: score, ambiguity margin
    cores: [0.6, 0.42], coreWeak: 0.75, coreOk: 0.72, coreGain: 0.1, coreWindow: 0.7,   // a loose outline holds background that stays put while the object moves: when the whole template matches poorly but its middle (one of these shares) matches well, the middle is tracked
    prior: 0.05, sprior: 0.012,      // pull towards the predicted spot / towards the current size
    minScale: 0.2, maxScale: 10,     // box size limits relative to the one the region started with (a sign far away that drives up to you)
    coastT: 2.0                      // seconds the box keeps moving on its speed after a miss (then it holds)
  };
  PT.DEFAULTS = DEFAULTS;
  /** Sizes to try, relative to the current box: ± one step (longer between looks = bigger step), two more steps either side after a miss. */
  function scalesFor(dt, wide) {
    const st = clamp(0.03 + 0.4 * dt, 0.05, 0.15);
    return { st, list: wide ? [1, 1 - st, 1 + st, 1 - 2 * st, 1 + 2 * st] : [1, 1 - st, 1 + st] };
  }

  function Tracker(img, box, t, o) {
    o = Object.assign({}, DEFAULTS, o);
    const d = PT.templateDims(box, o);
    this.o = o;
    this.tm0 = finishTemplate(resample(img, box.x, box.y, box.w / d.tw, box.h / d.th, d.tw, d.th), d.tw, d.th);
    this.tm = cloneTemplate(this.tm0);
    this.box = { x: box.x, y: box.y, w: box.w, h: box.h };
    this.size0 = { w: box.w, h: box.h };
    this.core = 1; this.age0 = null;   // 1 = the template is the whole box; less = only its middle (see update)
    this.t = t; this.vx = 0; this.vy = 0;
    this.lost = 0; this.lostT = 0; this.n = 0; this.score = 1; this.good = 0; this.weakT = 0;
  }
  PT.Tracker = Tracker;
  PT.create = (img, box, t, o) => new Tracker(img, box, t, o);
  const P = Tracker.prototype;

  /** Where the box centre should be at time t. */
  P.predict = function (t) {
    const dt = clamp(t - this.t, 0, 0.6), b = this.box, k = 1;
    return { cx: b.x + b.w / 2 + this.vx * dt * k, cy: b.y + b.h / 2 + this.vy * dt * k, dt };
  };
  /** The motion gate in box sizes: a match further than this from where the object should be is refused, and the search window ends there.
   *  It grows with the SECONDS since the last match (an object behind a pole keeps moving; a look-alike that stays behind must not be mistaken for it),
   *  is wider while the speed is still unknown, and widens a little with the speed. */
  P.margin = function (dt) {
    const b = this.box, sp = Math.hypot(this.vx / b.w, this.vy / b.h);
    return Math.min(this.o.maxMargin, this.o.margin + this.o.gateGrow * Math.min(2, this.lostT) + (this.n < 3 ? 0.5 : 0) + Math.min(0.5, sp * dt * 0.25));
  };
  /** The part of the frame update() wants to see, and the raster size to draw it at. */
  P.plan = function (t) {
    const o = this.o, p = this.predict(t), m = this.margin(p.dt), b = this.box, smax = Math.max.apply(null, scalesFor(p.dt, this.lost >= 2).list);
    const hw = (0.5 + m) * b.w * smax, hh = (0.5 + m) * b.h * smax;
    const x0 = Math.max(0, p.cx - hw), y0 = Math.max(0, p.cy - hh), x1 = Math.min(1, p.cx + hw), y1 = Math.min(1, p.cy + hh);
    const nw = Math.max(1e-3, x1 - x0), nh = Math.max(1e-3, y1 - y0);
    return {
      nx: x0, ny: y0, nw, nh,
      SW: Math.min(o.maxRaster, Math.max(this.tm.tw + 4, Math.round(nw / (b.w * this.core) * this.tm.tw))),
      SH: Math.min(o.maxRaster, Math.max(this.tm.th + 4, Math.round(nh / (b.h * this.core) * this.tm.th)))
    };
  };

  /** Partial occlusion (a pole, a trunk, a wiper hides part of the object): match each half of the template around where the object should be and
   *  return the best, as the position the WHOLE template would have. Null when no half stands out. */
  P._parts = function (best, tw, th, p) {
    const T = best.T, parts = T._parts || (T._parts = makeParts(T));
    if (!parts.length) return null;
    const R = Math.max(6, Math.round(0.6 * Math.min(tw, th))), pcx = (p.cx - best.ua) / best.du - tw / 2, pcy = (p.cy - best.va) / best.dv - th / 2;
    let top = null;
    for (const q of parts) {
      const cx = Math.round(pcx) + q.ox, cy = Math.round(pcy) + q.oy;
      let bs = -2, bx = cx, by = cy;
      const at = (x, y) => (x < 0 || y < 0 || x > best.SW - q.tw || y > best.SH - q.th) ? -2 : nccFull(best.R, best.SW, x, y, q);
      for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) { const v = at(cx + dx, cy + dy); if (v > bs) { bs = v; bx = cx + dx; by = cy + dy; } }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const v = at(bx + dx, by + dy); if (v > bs) { bs = v; bx += dx; by += dy; } }
      if (!top || bs > top.score) top = { score: bs, x: bx - q.ox, y: by - q.oy };
    }
    return top;
  };
  /** Look for the object in `img` at time t. Returns { ok, score, margin, scale, box, lost, lostT }; the tracker's own box follows. */
  P.update = function (img, t) {
    const o = this.o, b = this.box, p = this.predict(t), dt = p.dt, m = this.margin(dt);
    const wide = this.lost >= 2, sf = scalesFor(dt, wide), scales = sf.list, tms = wide ? [this.tm, this.tm0] : [this.tm];
    const tw = this.tm.tw, th = this.tm.th;
    let best = null;
    for (const s of scales) {
      const du = b.w * this.core * s / tw, dv = b.h * this.core * s / th;
      const hw = Math.min((0.5 + m) * b.w * s, 0.5 * o.maxRaster * du), hh = Math.min((0.5 + m) * b.h * s, 0.5 * o.maxRaster * dv);
      const ua = Math.max(img.ox, p.cx - hw), ub = Math.min(img.ox + img.ow, p.cx + hw);
      const va = Math.max(img.oy, p.cy - hh), vb = Math.min(img.oy + img.oh, p.cy + hh);
      const SW = Math.floor((ub - ua) / du), SH = Math.floor((vb - va) / dv);
      if (SW < tw + 2 || SH < th + 2) continue;
      const R = resample(img, ua, va, du, dv, SW, SH), sp = o.sprior * Math.abs(Math.log(s)) / Math.log(1 + sf.st);
      for (const T of tms) {
        if (T.flat) continue;
        const cols = ((SW - tw) >> 1) + 1, rows = ((SH - th) >> 1) + 1, map = new Float32Array(cols * rows).fill(-1);
        let bs = -9, bi = 0, braw = -9;
        for (let jy = 0; jy < rows; jy++) for (let ix = 0; ix < cols; ix++) {
          const ccx = ua + (ix * 2 + tw / 2) * du, ccy = va + (jy * 2 + th / 2) * dv;
          if (Math.hypot((ccx - p.cx) / b.w, (ccy - p.cy) / b.h) > m) continue;   // the motion gate, on the candidate itself (a larger scale step widens the window, not the gate)
          const sc = nccLat(R, SW, ix * 2, jy * 2, T);
          map[jy * cols + ix] = sc;
          const eff = sc - o.prior * Math.min(2, Math.hypot((ccx - p.cx) / (b.w * s), (ccy - p.cy) / (b.h * s))) - sp;
          if (eff > bs) { bs = eff; bi = jy * cols + ix; braw = sc; }
        }
        if (!best || bs > best.eff) best = { eff: bs, raw: braw, bi, cols, rows, map, s, R, SW, SH, ua, va, du, dv, T };
      }
    }
    if (!best) return this._miss(t, dt, p, -1, 0);

    // the best peak against the best peak somewhere else (a look-alike makes the match ambiguous)
    const bix = best.bi % best.cols, biy = (best.bi / best.cols) | 0, rad = Math.max(2, Math.ceil(0.3 * tw / 2));
    let second = -1;
    for (let jy = 0; jy < best.rows; jy++) for (let ix = 0; ix < best.cols; ix++) {
      if (Math.abs(ix - bix) <= rad && Math.abs(jy - biy) <= rad) continue;
      const v = best.map[jy * best.cols + ix]; if (v > second) second = v;
    }
    let margin = best.raw - second;

    // refine on every pixel around the coarse peak, then a parabola through the peak and its neighbours
    const memo = new Map();
    const at = (x, y) => {
      if (x < 0 || y < 0 || x > best.SW - tw || y > best.SH - th) return -2;
      const k = y * best.SW + x; let v = memo.get(k);
      if (v === undefined) { v = nccFull(best.R, best.SW, x, y, best.T); memo.set(k, v); }
      return v;
    };
    let fx = bix * 2, fy = biy * 2, fs = at(fx, fy);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const v = at(bix * 2 + dx, biy * 2 + dy); if (v > fs) { fs = v; fx = bix * 2 + dx; fy = biy * 2 + dy; } }
    const sub = (l, c, r) => { const d = l - 2 * c + r; return d < -1e-6 ? clamp(0.5 * (l - r) / d, -0.5, 0.5) : 0; };
    const l = at(fx - 1, fy), r = at(fx + 1, fy), u = at(fx, fy - 1), dn = at(fx, fy + 1);
    let sx = l > -2 && r > -2 ? sub(l, fs, r) : 0, sy = u > -2 && dn > -2 ? sub(u, fs, dn) : 0;
    // second pass: score the template at half-pixel offsets around that estimate (a parabola fits the peak much better there)
    const frac = (ox, oy) => nccFull(resample(img, best.ua + (fx + ox) * best.du, best.va + (fy + oy) * best.dv, best.du, best.dv, tw, th), tw, 0, 0, best.T);
    let sc = fs;
    if (fx > 0 && fy > 0 && fx < best.SW - tw && fy < best.SH - th) {
      const c0 = frac(sx, sy), xl = frac(sx - 0.5, sy), xr = frac(sx + 0.5, sy), yu = frac(sx, sy - 0.5), yd = frac(sx, sy + 0.5);
      const dxx = xl - 2 * c0 + xr, dyy = yu - 2 * c0 + yd;
      if (dxx < -1e-6) sx += clamp(0.25 * (xl - xr) / dxx, -0.5, 0.5);
      if (dyy < -1e-6) sy += clamp(0.25 * (yu - yd) / dyy, -0.5, 0.5);
      sc = Math.max(fs, c0, xl, xr, yu, yd);
    }
    let mcx = best.ua + (fx + sx + tw / 2) * best.du, mcy = best.va + (fy + sy + th / 2) * best.dv;

    // a loose outline: the whole template matches poorly (the background in it did not move with the object) but a middle part of it matches well -> track that part from now on
    let switched = false;
    if (this.age0 == null) this.age0 = t;
    if (this.core === 1 && sc < o.coreWeak && t - this.age0 <= o.coreWindow) {   // (only in the first moments: a loose outline shows at once; later a weak match means the object is partly hidden)
      let pick = null;
      for (const c of o.cores) {
        const ct = (this._cores || (this._cores = {}))[c] || (this._cores[c] = cropTemplate(this.tm, c));
        if (ct.flat) continue;
        let cs = -2, cbx = 0, cby = 0;
        for (let y = 0; y <= best.SH - ct.th; y++) for (let x = 0; x <= best.SW - ct.tw; x++) {
          const dd = Math.hypot((best.ua + (x + ct.tw / 2) * best.du - p.cx) / b.w, (best.va + (y + ct.th / 2) * best.dv - p.cy) / b.h); if (dd > m) continue;
          const v = nccFull(best.R, best.SW, x, y, ct) - o.prior * Math.min(2, dd);
          if (v > cs) { cs = v; cbx = x; cby = y; }
        }
        if (cs >= o.coreOk && cs > sc + (margin < o.minMargin ? 0.02 : o.coreGain) && (!pick || cs > pick.cs + 0.03)) pick = { cs, c, ct, x: cbx, y: cby };
      }
      if (pick) {
        mcx = best.ua + (pick.x + pick.ct.tw / 2) * best.du; mcy = best.va + (pick.y + pick.ct.th / 2) * best.dv; sc = pick.cs; margin = 1; switched = true;
        this.tm = cropTemplate(this.tm, pick.c); this.tm0 = cropTemplate(this.tm0, pick.c); this._cores = null; this.core = pick.c;
      }
    }
    let viaPart = false, partScore = null;
    if (!switched && sc < o.trust) {   // the whole template matches poorly: is a half of it clearly seen? (a thin thing in front of the object)
      const pr = this._parts(best, tw, th, p);
      partScore = pr ? pr.score : null;
      if (pr && pr.score >= o.partOk && pr.score > sc + o.partGain) {
        mcx = best.ua + (pr.x + tw / 2) * best.du; mcy = best.va + (pr.y + th / 2) * best.dv;
        sc = pr.score * 0.85; margin = 1; viaPart = true;
      }
    }
    const farWeak = !viaPart && sc < o.trust && Math.hypot((mcx - p.cx) / b.w, (mcy - p.cy) / b.h) > o.weakJump;
    const ok = !farWeak && (viaPart || (sc >= o.accept && (margin >= o.minMargin || sc >= o.sure)) || (sc >= o.weak && margin >= o.strongMargin));
    if (!ok) return this._miss(t, dt, p, sc, margin);

    // accept: blend the measurement with the prediction (alpha-beta), grow / shrink the box with the matched scale
    // a weak match (a part of the object is hidden: the score sits near 0.5 and the peak is a plateau biased towards the old spot) only nudges the
    // position and never changes the speed: the object keeps moving at the speed it had when it was still seen well
    const good = sc >= o.trust, k = sc >= 0.8 ? 0.9 : good ? 0.7 : Math.min(0.5, o.weakPull + Math.max(0, this.weakT - o.weakRamp) * 0.5), beta = good ? 0.5 * k * k / (2 - k) : 0, rx = mcx - p.cx, ry = mcy - p.cy;
    const ncx = p.cx + k * rx, ncy = p.cy + k * ry;
    if (dt > 0.02) { this.vx += beta * rx / dt; this.vy += beta * ry / dt; }
    const f = 1 + k * (best.s - 1);
    let nw = clamp(b.w * f, this.size0.w * o.minScale, this.size0.w * o.maxScale), nh = clamp(b.h * f, this.size0.h * o.minScale, this.size0.h * o.maxScale);
    nw = Math.min(nw, 1); nh = Math.min(nh, 1);
    this.box = { x: clamp(ncx - nw / 2, 0, 1 - nw), y: clamp(ncy - nh / 2, 0, 1 - nh), w: nw, h: nh };
    this.t = t; this.lost = 0; this.lostT = 0; this.n++; this.score = sc; this.good++;
    this.weakT = good ? 0 : this.weakT + dt;

    // template upkeep: only from a very good, same-size look that still agrees with the original (no drift onto the background)
    if (!switched && sc > 0.85 && Math.abs(best.s - 1) < 0.02 && this.good % 3 === 0) {
      const nb = this.box;
      if (nb.x >= img.ox && nb.y >= img.oy && nb.x + nb.w <= img.ox + img.ow && nb.y + nb.h <= img.oy + img.oh) {
        const cw = nb.w * this.core, ch = nb.h * this.core, fresh = finishTemplate(resample(img, nb.x + (nb.w - cw) / 2, nb.y + (nb.h - ch) / 2, cw / tw, ch / th, tw, th), tw, th);
        if (!fresh.flat && corr(fresh, this.tm0) > 0.55) {
          const g = this.tm.g; for (let i = 0; i < g.length; i++) g[i] = g[i] * 0.88 + fresh.g[i] * 0.12;
          this.tm = finishTemplate(g, tw, th);
        }
      }
    }
    return { ok: true, score: sc, margin, scale: best.s, box: Object.assign({}, this.box), lost: 0, lostT: 0, part: viaPart, partScore };
  };
  P._miss = function (t, dt, p, sc, margin) {
    this.lost++; this.lostT += dt; this.score = sc;
    const b = this.box, o = this.o;
    if (this.lostT <= o.coastT) {   // keep moving on the speed (an object behind a pole carries on), fading after coastKeep seconds
      b.x = clamp(p.cx - b.w / 2, 0, 1 - b.w); b.y = clamp(p.cy - b.h / 2, 0, 1 - b.h);
      if (this.lostT > o.coastKeep) { const f = 1 - dt / Math.max(0.1, o.coastT - o.coastKeep); this.vx *= f; this.vy *= f; }
    } else { this.vx = 0; this.vy = 0; }
    this.t = t;
    return { ok: false, score: sc, margin, scale: 1, box: Object.assign({}, b), lost: this.lost, lostT: this.lostT };
  };
  /** An outside measurement of the box at time t (a detector box, the user's edit): follow it, learn the speed from it. */
  P.setBox = function (box, t) {
    const b = this.box, dt = t - this.t, ocx = b.x + b.w / 2, ocy = b.y + b.h / 2, ncx = box.x + box.w / 2, ncy = box.y + box.h / 2;
    if (dt > 0.02 && dt <= 0.6 && this.lost === 0) { this.vx = 0.5 * this.vx + 0.5 * (ncx - ocx) / dt; this.vy = 0.5 * this.vy + 0.5 * (ncy - ocy) / dt; }
    else if (dt < -0.05 || dt > 0.6) { this.vx = 0; this.vy = 0; }
    this.box = { x: box.x, y: box.y, w: box.w, h: box.h }; this.t = t; this.lost = 0; this.lostT = 0;
  };
  /** Jump to a known box at time t (a seek, the start of an export pass): speed unknown again, wide first look. */
  P.rewind = function (box, t, v) {   // v = { vx, vy } when the speed is known (from the path): then the first look need not be wide
    this.box = { x: box.x, y: box.y, w: box.w, h: box.h }; this.t = t; this.vx = v ? v.vx : 0; this.vy = v ? v.vy : 0; this.lost = 0; this.lostT = 0; this.n = v ? 3 : 0; this.weakT = 0;
  };
  /** An independent copy that shares the (read-only) original template: the exporter tracks on its own while the viewer's tracker is left alone. */
  P.fork = function () {
    const c = Object.create(P);
    c.o = this.o; c.core = this.core; c.age0 = this.age0; c.tm0 = this.tm0; c.tm = cloneTemplate(this.tm); c.box = Object.assign({}, this.box); c.size0 = this.size0;
    c.t = this.t; c.vx = this.vx; c.vy = this.vy; c.lost = this.lost; c.lostT = this.lostT; c.n = this.n; c.score = this.score; c.good = this.good; c.weakT = this.weakT;
    return c;
  };
  /** The user moved / resized the shape: the template follows the object at its new box size. */
  P.rebase = function (box, t) {
    const fw = box.w / Math.max(1e-6, this.box.w), fh = box.h / Math.max(1e-6, this.box.h);
    this.size0 = { w: this.size0.w * fw, h: this.size0.h * fh };
    this.age0 = null;
    this.setBox(box, t);
  };

  // ── path ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const KEY = 5, MAXKEYS = 600, HOLD_GAP = 1.2, EXTRAP = 0.25;
  PT.MAXKEYS = MAXKEYS;
  const r4 = (v) => Math.round(v * 10000) / 10000, r3 = (v) => Math.round(v * 1000) / 1000;
  /** Index of the first key with time > t (binary search). */
  function upper(path, t) {
    let lo = 0, hi = path.length / KEY;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (path[mid * KEY] <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  const keyBox = (p, i) => ({ x: p[i * KEY + 1], y: p[i * KEY + 2], w: p[i * KEY + 3], h: p[i * KEY + 4] });
  const isLost = (p, i) => !(p[i * KEY + 3] > 0 && p[i * KEY + 4] > 0);
  /** Validate / round a stored path. Returns null when there is nothing usable. */
  PT.cleanPath = (a) => {
    if (!Array.isArray(a) || a.length < KEY || a.length % KEY) return null;
    const out = []; let last = -1;
    for (let i = 0; i < a.length; i += KEY) {
      const t = +a[i], x = +a[i + 1], y = +a[i + 2], w = +a[i + 3], h = +a[i + 4];
      if (![t, x, y, w, h].every(isFinite) || t < 0 || t <= last || w < 0 || h < 0) return null;
      last = t;
      if (w > 0 && h > 0) { const cw = clamp(w, 0.004, 1), ch = clamp(h, 0.004, 1); out.push(r3(t), r4(clamp(x, 0, 1 - cw)), r4(clamp(y, 0, 1 - ch)), r4(cw), r4(ch)); }
      else out.push(r3(t), r4(clamp(x, 0, 1)), r4(clamp(y, 0, 1)), 0, 0);
    }
    if (out.length > MAXKEYS * KEY) { PT.thin(out, MAXKEYS); }
    return out;
  };
  /** Add (or replace the key within 45 ms of) a key. box = null writes a "lost from here" key. */
  PT.pathAdd = (path, t, box, max) => {
    const i = upper(path, t), n = path.length / KEY;
    const vals = box ? [r3(t), r4(box.x), r4(box.y), r4(box.w), r4(box.h)] : [r3(t), 0, 0, 0, 0];
    if (!box && n && i > 0) { vals[1] = path[(i - 1) * KEY + 1]; vals[2] = path[(i - 1) * KEY + 2]; }
    let at = i;
    if (i > 0 && t - path[(i - 1) * KEY] < 0.045) at = i - 1;
    else if (i < n && path[i * KEY] - t < 0.045) at = i;
    else { path.splice(i * KEY, 0, 0, 0, 0, 0, 0); }
    for (let k = 0; k < KEY; k++) path[at * KEY + k] = vals[k];
    if (path.length > (max || MAXKEYS) * KEY) PT.thin(path, max || MAXKEYS);
    return path;
  };
  /** Drop the keys that sit closest to their neighbours until at most `max` remain (first, last and lost keys stay). */
  PT.thin = (path, max) => {
    while (path.length / KEY > max) {
      const n = path.length / KEY; let bi = -1, bg = Infinity;
      for (let i = 1; i < n - 1; i++) { if (isLost(path, i) || isLost(path, i - 1)) continue; const g = path[(i + 1) * KEY] - path[(i - 1) * KEY]; if (g < bg) { bg = g; bi = i; } }
      if (bi < 0) break;
      path.splice(bi * KEY, KEY);
    }
    return path;
  };
  /** Seconds from t to the nearest key (Infinity without a path). */
  PT.pathGap = (path, t) => {
    if (!path || !path.length) return Infinity;
    const i = upper(path, t), n = path.length / KEY; let g = Infinity;
    if (i > 0) g = Math.min(g, t - path[(i - 1) * KEY]);
    if (i < n) g = Math.min(g, path[i * KEY] - t);
    return g;
  };
  /** Time of the first key after t (+ a hair), Infinity when there is none: a stretch with keys ahead of the playhead has already been tracked. */
  PT.pathAhead = (path, t) => {
    if (!path || !path.length) return Infinity;
    const i = upper(path, t + 0.02);
    return i < path.length / KEY ? path[i * KEY] : Infinity;
  };
  /** True when some key lies at or before t. */
  PT.pathBefore = (path, t) => !!(path && path.length && path[0] <= t + 1e-6);
  /** The last box that was really seen at or before t (skips "lost" keys), or null. Where a lost region was last, and where an export carries on from. */
  PT.lastBox = (path, t) => {
    if (!path || !path.length) return null;
    for (let i = upper(path, t) - 1; i >= 0; i--) if (!isLost(path, i)) return keyBox(path, i);
    return null;
  };
  /** The centre's speed (frame shares per second) from the last seen keys at or before t: the newest one and an earlier one at least 0.25 s before it. */
  PT.pathVelocity = (path, t) => {
    if (!path || !path.length) return null;
    let i = upper(path, t) - 1;
    while (i >= 0 && isLost(path, i)) i--;
    if (i < 0) return null;
    const t1 = path[i * KEY];
    for (let j = i - 1; j >= 0; j--) {
      if (isLost(path, j) || t1 - path[j * KEY] < 0.25) continue;
      const dt = t1 - path[j * KEY]; if (dt > 1.5) return null;
      return { vx: (path[i * KEY + 1] + path[i * KEY + 3] / 2 - path[j * KEY + 1] - path[j * KEY + 3] / 2) / dt, vy: (path[i * KEY + 2] + path[i * KEY + 4] / 2 - path[j * KEY + 2] - path[j * KEY + 4] / 2) / dt };
    }
    return null;
  };
  /** The box at time t: a box, null (the object is lost here: draw nothing), or undefined (no path at all: use the stored shape). */
  PT.pathAt = (path, t) => {
    if (!path || !path.length) return undefined;
    const n = path.length / KEY, i = upper(path, t) - 1;
    if (i < 0) return isLost(path, 0) ? null : keyBox(path, 0);   // before the first key: where it was drawn
    if (isLost(path, i)) return null;
    const a = keyBox(path, i), ta = path[i * KEY];
    if (i === n - 1) {   // after the last key: carry on at the last speed for a moment, then hold
      if (i >= 1 && !isLost(path, i - 1) && t - ta <= EXTRAP) {
        const tp = path[(i - 1) * KEY], dt = ta - tp;
        if (dt > 0.02 && dt < 0.6) {
          const k = (t - ta) / dt, p = keyBox(path, i - 1);
          const cx = a.x + a.w / 2 + (a.x + a.w / 2 - p.x - p.w / 2) * k, cy = a.y + a.h / 2 + (a.y + a.h / 2 - p.y - p.h / 2) * k;
          return { x: clamp(cx - a.w / 2, 0, 1 - a.w), y: clamp(cy - a.h / 2, 0, 1 - a.h), w: a.w, h: a.h };
        }
      }
      return a;
    }
    if (isLost(path, i + 1)) return a;   // held until the "lost" key
    const b = keyBox(path, i + 1), tb = path[(i + 1) * KEY], gap = tb - ta;
    if (gap > HOLD_GAP) return t - ta < tb - t ? a : b;   // unrecorded stretch: the nearer end, no made-up motion
    const f = (t - ta) / gap;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, w: a.w + (b.w - a.w) * f, h: a.h + (b.h - a.h) * f };
  };
  /** The user moved / resized the shape at one moment: apply the same offset and size ratio to every key. */
  PT.pathRebase = (path, ob, nb) => {
    const sx = ob.w > 1e-6 ? nb.w / ob.w : 1, sy = ob.h > 1e-6 ? nb.h / ob.h : 1, dx = nb.x + nb.w / 2 - ob.x - ob.w / 2, dy = nb.y + nb.h / 2 - ob.y - ob.h / 2;
    for (let i = 0; i < path.length; i += KEY) {
      if (!(path[i + 3] > 0 && path[i + 4] > 0)) continue;
      const w = clamp(path[i + 3] * sx, 0.004, 1), h = clamp(path[i + 4] * sy, 0.004, 1), cx = path[i + 1] + path[i + 3] / 2 + dx, cy = path[i + 2] + path[i + 4] / 2 + dy;
      path[i + 1] = r4(clamp(cx - w / 2, 0, 1 - w)); path[i + 2] = r4(clamp(cy - h / 2, 0, 1 - h)); path[i + 3] = r4(w); path[i + 4] = r4(h);
    }
    return path;
  };

  // ── shapes ─────────────────────────────────────────────────────────────────────────────────────────────────────
  /** Move / scale the shape of region r so that its bounding box becomes nb. Writes into `out` (default r). */
  PT.mapShape = (r, nb, out) => {
    out = out || r;
    if (r.pts) {
      const ox = r.x, oy = r.y, sx = r.w > 1e-6 ? nb.w / r.w : 1, sy = r.h > 1e-6 ? nb.h / r.h : 1, p = r.pts, q = new Array(p.length);
      for (let i = 0; i < p.length; i += 2) { q[i] = clamp(nb.x + (p[i] - ox) * sx, 0, 1); q[i + 1] = clamp(nb.y + (p[i + 1] - oy) * sy, 0, 1); }
      out.pts = q;
    }
    out.x = nb.x; out.y = nb.y; out.w = nb.w; out.h = nb.h;
    return out;
  };
  /** The region as it is at time t: r itself without a path or when it already sits there, null when the object is lost, else a view of r. */
  PT.view = (r, t) => {
    const b = PT.pathAt(r.path, t);
    if (b === undefined) return r;
    if (b === null) return null;
    if (Math.abs(b.x - r.x) < 1e-5 && Math.abs(b.y - r.y) < 1e-5 && Math.abs(b.w - r.w) < 1e-5 && Math.abs(b.h - r.h) < 1e-5) return r;
    return PT.mapShape(r, b, Object.create(r));
  };

  if (typeof module !== "undefined" && module.exports) module.exports = PT;
  else { root.TDC = root.TDC || {}; root.TDC.patchTrack = PT; }
})(typeof window !== "undefined" ? window : globalThis);
