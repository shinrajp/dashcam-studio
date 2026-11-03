/* rig-calib.js — measure a car's own cameras from one of its drives, in the browser (the in-app version of tools/rig).
 *
 * The method is tools/rig/calibrate.py's: no chart, the car's own telemetry is the reference. Between two frames of one camera
 * the car's move is known from the speed and heading in that file's SEI (rear-axle bicycle model: the rear axle moves along the
 * heading, the body turns by the heading change), so every point tracked across those frames must lie on the epipolar plane
 * that move implies. Fitting a camera's tracks gives its mounting angles (yaw / pitch / roll), its lens width f and the two
 * lens terms k1, k2 (Kannala-Brandt, k3 = 0, kept tightly round the preset's: all HW4 cameras are the same modules), and the
 * delay between its pictures and its telemetry. The car body's pitch / roll on its suspension per frame pair (the telemetry
 * has the heading only) are nuisance unknowns: how it tilted between the two frames, as calibrate.py, and also how it was
 * tilted against the road (the nose dips when braking, so the body's forward axis is not the direction of travel). Then the road surface, warped from one frame onto the next through the
 * road plane at a trial height, lines up only at the camera's true height (tools/rig/roadheight.py); points triangulated on the
 * road are the fallback.
 *
 * Differences from the offline tools (they make it fit in a browser tab): frames are tracked at half width (724 px; the front
 * camera at 966 px of its 2896), the lens centre stays at the preset's, the start is the preset (a few yaw × lens-width starts
 * round it instead of a wide search), and the solver is a small Levenberg-Marquardt with the per-pair body unknowns folded out
 * (Schur complement), so a camera's fit takes about a second.
 *
 * Pure (no DOM): node tests load it with require(); the worker (js/rig-calib-worker.js) loads it with importScripts. */
(function (root, factory) {
  const isNode = typeof module === "object" && module.exports;
  const m = factory(isNode ? require("./rig.js") : (root.TDC && root.TDC.rig));
  if (isNode) module.exports = m;
  else { const T = (root.TDC = root.TDC || {}); T.rigCalib = Object.assign(T.rigCalib || {}, m); }
})(typeof self !== "undefined" ? self : this, function (RIG) {
  "use strict";
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const ASPECT = RIG ? RIG.ASPECT : 938 / 1448;

  // ── small linear algebra (3×3 as flat arrays, row-major) ──
  function rot3(yaw, pitch, roll) {   // radians; camera(GL: x right, y up, z forward) → car, = Ry(yaw)·Rx(pitch)·Rz(roll) (js/rig.js rot)
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    const Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy], Rx = [1, 0, 0, 0, cp, sp, 0, -sp, cp], Rz = [cr, -sr, 0, sr, cr, 0, 0, 0, 1];
    return mul(mul(Ry, Rx), Rz);
  }
  function mul(A, B) {
    const C = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
    return C;
  }
  const tr = (A) => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
  const mv = (A, v) => [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]];
  const RyM = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
  /** Solve the n×n system A x = b (Gauss-Jordan with partial pivoting); A, b copied. null when singular. */
  function solveN(A, b, n) {
    const M = A.slice(), x = b.slice();
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
      if (!(Math.abs(M[p * n + c]) > 1e-300)) return null;
      if (p !== c) { for (let k = 0; k < n; k++) { const t = M[c * n + k]; M[c * n + k] = M[p * n + k]; M[p * n + k] = t; } const t = x[c]; x[c] = x[p]; x[p] = t; }
      const d = M[c * n + c];
      for (let r = 0; r < n; r++) {
        if (r === c) continue; const f = M[r * n + c] / d; if (!f) continue;
        for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
        x[r] -= f * x[c];
      }
    }
    for (let c = 0; c < n; c++) x[c] /= M[c * n + c];
    return x;
  }
  /** Seeded random numbers (mulberry32), so a calibration is repeatable. */
  function rng(seed) { let a = seed >>> 0 || 1; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const median = (a) => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); return s.length & 1 ? s[s.length >> 1] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2]); };

  // ── telemetry → car path ──
  /** Rear-axle path from speed + heading rows [[t, speed m/s, heading deg], …] (world: east, north; heading clockwise from
   *  north), on a 2 ms grid. rel(t0, t1): the car at t1 in the car-at-t0's axes: X0 = Ry(psi)·X1 + T. */
  function Path(rows) {
    const n = rows.length, t = new Float64Array(n), v = new Float64Array(n), h = new Float64Array(n);
    let prev = null, acc = 0;
    for (let i = 0; i < n; i++) {
      t[i] = rows[i][0]; v[i] = rows[i][1] || 0; const a = (rows[i][2] || 0) * D2R;
      if (prev == null) acc = a; else { let d = a - prev; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; acc += d; }
      prev = a; h[i] = acc;
    }
    const step = 0.002, g0 = t[0] - 1, m = Math.ceil((t[n - 1] + 1 - g0) / step) + 1;
    const gv = new Float64Array(m), gh = new Float64Array(m), ge = new Float64Array(m), gn = new Float64Array(m);
    let k = 0;
    for (let i = 0; i < m; i++) {
      const tt = g0 + i * step;
      while (k < n - 2 && t[k + 1] <= tt) k++;
      let a = (tt - t[k]) / ((t[k + 1] - t[k]) || 1); a = Math.max(0, Math.min(1, a));
      if (n === 1) a = 0;
      gv[i] = v[k] + a * ((n > 1 ? v[k + 1] : v[k]) - v[k]); gh[i] = h[k] + a * ((n > 1 ? h[k + 1] : h[k]) - h[k]);
      if (i) { ge[i] = ge[i - 1] + gv[i] * step * Math.sin(gh[i]); gn[i] = gn[i - 1] + gv[i] * step * Math.cos(gh[i]); }
    }
    const at = (tt) => {
      const x = (tt - g0) / step, i = Math.max(0, Math.min(m - 2, Math.floor(x))), a = Math.max(0, Math.min(1, x - i));
      return [ge[i] + a * (ge[i + 1] - ge[i]), gn[i] + a * (gn[i + 1] - gn[i]), gh[i] + a * (gh[i + 1] - gh[i]), gv[i] + a * (gv[i + 1] - gv[i])];
    };
    return {
      t, v, h, at,
      speed: (tt) => at(tt)[3],
      heading: (tt) => at(tt)[2],
      rel(t0, t1) {
        const [e0, n0, h0] = at(t0), [e1, n1, h1] = at(t1), de = e1 - e0, dn = n1 - n0;
        return { psi: h1 - h0, T: [de * Math.cos(h0) - dn * Math.sin(h0), 0, de * Math.sin(h0) + dn * Math.cos(h0)] };
      },
      /** world pose of the car at t: { e, n, h } */
      pose(tt) { const [e, n, hh] = at(tt); return { e, n, h: hh }; },
    };
  }
  /** How much the car turned while moving (degrees, total |heading change| at ≥ 1 m/s), how long it moved (s), and the
   *  biggest turn within any 15 s (degrees): a drive needs a real turn to fix the lenses. */
  function driveStats(rows) {
    let turn = 0, moving = 0, prev = null, best = 0; const acc = [];
    for (let i = 0; i < rows.length; i++) {
      const [t, v, hd] = rows[i];
      if (prev) {
        let d = hd - prev[2]; while (d > 180) d -= 360; while (d < -180) d += 360;
        if (v >= 1 || prev[1] >= 1) { turn += Math.abs(d); moving += t - prev[0]; }
        acc.push([t, (acc.length ? acc[acc.length - 1][1] : 0) + d]);
      } else acc.push([t, 0]);
      prev = rows[i];
    }
    for (let i = 0, j = 0; i < acc.length; i++) { while (acc[i][0] - acc[j][0] > 15) j++; for (let k = j; k < i; k += Math.max(1, (i - j) >> 4)) best = Math.max(best, Math.abs(acc[i][1] - acc[k][1])); }
    return { turnDeg: turn, movingS: moving, bestTurnDeg: best, duration: rows.length ? rows[rows.length - 1][0] - rows[0][0] : 0 };
  }

  // ── lens (js/rig.js convention: f, cx, cy in picture widths; u, v in 0..1; aspect = height / width) ──
  const kb = (th, k1, k2) => { const t2 = th * th; return th * (1 + t2 * (k1 + t2 * k2)); };
  const dkb = (th, k1, k2) => { const t2 = th * th; return 1 + t2 * (3 * k1 + t2 * 5 * k2); };
  /** picture (u, v in 0..1) → unit bearing in camera axes (x right, y up, z forward), written into out[o..o+2]; returns θ. */
  function unproject(u, v, f, cx, cy, k1, k2, a, out, o) {
    const dx = (u - 0.5 - cx) / f, dy = ((v - 0.5) * a - cy) / f, rho = Math.sqrt(dx * dx + dy * dy);
    let th = rho;
    for (let i = 0; i < 8; i++) { const t2 = th * th, r = th * (1 + t2 * (k1 + t2 * k2)) - rho, d = 1 + t2 * (3 * k1 + t2 * 5 * k2); th = Math.min(3, Math.max(0, th - r / Math.max(0.05, d))); }
    const s = rho > 1e-12 ? Math.sin(th) / rho : 1;
    out[o] = dx * s; out[o + 1] = -dy * s; out[o + 2] = Math.cos(th);
    return th;
  }
  function project(b, f, cx, cy, k1, k2, a) {
    const n = Math.hypot(b[0], b[1], b[2]); const th = Math.acos(Math.max(-1, Math.min(1, b[2] / n))), r = f * kb(th, k1, k2), l = Math.hypot(b[0], b[1]) || 1e-12;
    return { u: 0.5 + cx + r * b[0] / l, v: 0.5 + (cy - r * b[1] / l) / a, th };
  }
  /** picture widths per radian round a bearing at angle θ (geometric mean of the radial and the tangential scale) */
  function scaleAt(th, f, k1, k2) {
    const r = kb(th, k1, k2), dr = dkb(th, k1, k2), tang = th > 1e-3 ? r / Math.max(Math.sin(th), 1e-3) : 1;
    return f * Math.sqrt(Math.max(dr, 1e-3) * Math.max(tang, 1e-3));
  }
  /** Does the lens keep growing out to rhoMax (normalised radius / f) — no fold inside the tracked picture? */
  function lensOk(k1, k2, rhoMax) {
    for (let th = 0.01; th < 3; th += 0.01) { if (dkb(th, k1, k2) < 0.15) return false; if (kb(th, k1, k2) >= rhoMax) return true; }
    return false;
  }

  // ── tracking: pyramidal Lucas-Kanade on grey frames, forward-backward check, topped up with new corners ──
  function pyramid(grey, w, h, levels) {
    const L = [{ d: Float32Array.from(grey), w, h }];
    for (let l = 1; l < levels; l++) {
      const p = L[l - 1], nw = p.w >> 1, nh = p.h >> 1; if (nw < 16 || nh < 16) break;
      const d = new Float32Array(nw * nh);
      for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
        const i = 2 * y * p.w + 2 * x; d[y * nw + x] = 0.25 * (p.d[i] + p.d[i + 1] + p.d[i + p.w] + p.d[i + p.w + 1]);
      }
      L.push({ d, w: nw, h: nh });
    }
    return L;
  }
  function bil(img, x, y) {
    const w = img.w, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * w + x0, d = img.d;
    return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + w] * (1 - fx) + d[i + w + 1] * fx) * fy;
  }
  /** One point from pyramid A to pyramid B (start guess gx, gy at level 0); → [x, y] or null. */
  function lkPoint(A, B, x, y, gx, gy, win, iters) {
    const r = win >> 1, nw = win * win, Ix = new Float32Array(nw), Iy = new Float32Array(nw), I0 = new Float32Array(nw);
    let dx = (gx - x) / (1 << (A.length - 1)), dy = (gy - y) / (1 << (A.length - 1));
    for (let l = A.length - 1; l >= 0; l--) {
      const a = A[l], b = B[l], s = 1 / (1 << l), px = x * s, py = y * s;
      if (px - r - 2 < 0 || py - r - 2 < 0 || px + r + 2 >= a.w || py + r + 2 >= a.h) { if (l === 0) return null; dx *= 2; dy *= 2; continue; }
      let gxx = 0, gxy = 0, gyy = 0, k = 0;
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++, k++) {
        const X = px + i, Y = py + j; I0[k] = bil(a, X, Y);
        const ix = 0.5 * (bil(a, X + 1, Y) - bil(a, X - 1, Y)), iy = 0.5 * (bil(a, X, Y + 1) - bil(a, X, Y - 1));
        Ix[k] = ix; Iy[k] = iy; gxx += ix * ix; gxy += ix * iy; gyy += iy * iy;
      }
      const det = gxx * gyy - gxy * gxy, tr2 = 0.5 * (gxx + gyy), mine = tr2 - Math.sqrt(Math.max(0, tr2 * tr2 - det));
      if (mine / nw < 1e-2 || !(det > 0)) return null;
      for (let it = 0; it < iters; it++) {
        const qx = px + dx, qy = py + dy;
        if (qx - r - 1 < 0 || qy - r - 1 < 0 || qx + r + 1 >= b.w || qy + r + 1 >= b.h) return null;
        let bx = 0, by = 0; k = 0;
        for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++, k++) { const e = I0[k] - bil(b, qx + i, qy + j); bx += e * Ix[k]; by += e * Iy[k]; }
        const ux = (gyy * bx - gxy * by) / det, uy = (gxx * by - gxy * bx) / det;
        dx += ux; dy += uy;
        if (ux * ux + uy * uy < 1e-4) break;
      }
      if (l > 0) { dx *= 2; dy *= 2; }
    }
    return [x + dx, y + dy];
  }
  /** Shi-Tomasi corners: the best in each cell of a `cell`-px grid, above `quality` × the strongest; skip(x, y) → true leaves a spot out. */
  function corners(img, max, cell, skip) {
    const { d, w, h } = img, out = [];
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; gx[i] = 0.5 * (d[i + 1] - d[i - 1]); gy[i] = 0.5 * (d[i + w] - d[i - w]); }
    const cand = []; let top = 0; const r = 3, m = 12;
    for (let cy = m; cy + cell <= h - m; cy += cell) for (let cx = m; cx + cell <= w - m; cx += cell) {
      let best = 0, bx = 0, by = 0;
      for (let y = cy; y < cy + cell; y += 2) for (let x = cx; x < cx + cell; x += 2) {
        let a = 0, b = 0, c = 0;
        for (let j = -r; j <= r; j++) { let i = (y + j) * w + x - r; for (let k = -r; k <= r; k++, i++) { a += gx[i] * gx[i]; b += gx[i] * gy[i]; c += gy[i] * gy[i]; } }
        const t2 = 0.5 * (a + c), e = t2 - Math.sqrt(Math.max(0, t2 * t2 - (a * c - b * b)));
        if (e > best) { best = e; bx = x; by = y; }
      }
      if (best > 0 && !(skip && skip(bx, by))) { cand.push([best, bx, by]); if (best > top) top = best; }
    }
    cand.sort((p, q) => q[0] - p[0]);
    for (const c of cand) { if (c[0] < 0.01 * top || out.length >= max) break; out.push([c[1], c[2]]); }
    return out;
  }
  /** Frame-to-frame tracker. push(grey Uint8Array/Float32Array, w, h) per frame (in order); frames[] = { ids Int32Array,
   *  x, y Float32Array } in that picture's pixels. opt: max points (300), win (11), levels (3), fb limit px (0.35),
   *  mask(x, y) → true where not to start points (the car's own body), cell (corner grid, px). */
  function Tracker(opt) {
    const o = Object.assign({ max: 300, win: 11, levels: 3, fb: 0.35, iters: 12, cell: 0 }, opt || {});
    let prev = null, pts = [], next = 0; const frames = [];
    function push(grey, w, h) {
      const P = pyramid(grey, w, h, o.levels), cell = o.cell || Math.max(12, Math.round(Math.sqrt(w * h / (o.max * 1.6))));
      if (prev && pts.length) {
        const keep = [];
        for (const p of pts) {
          const q = lkPoint(prev, P, p[1], p[2], p[1], p[2], o.win, o.iters); if (!q) continue;
          const b = lkPoint(P, prev, q[0], q[1], p[1], p[2], o.win, o.iters); if (!b) continue;
          if ((b[0] - p[1]) ** 2 + (b[1] - p[2]) ** 2 > o.fb * o.fb) continue;
          keep.push([p[0], q[0], q[1]]);
        }
        pts = keep;
      }
      if (pts.length < o.max * 0.8) {
        const occ = new Set(pts.map((p) => Math.floor(p[1] / cell) + "," + Math.floor(p[2] / cell)));
        const c = corners(P[0], o.max - pts.length, cell, (x, y) => occ.has(Math.floor(x / cell) + "," + Math.floor(y / cell)) || (o.mask && o.mask(x / w, y / h)));
        for (const [x, y] of c) pts.push([next++, x, y]);
      }
      const n = pts.length, f = { ids: new Int32Array(n), x: new Float32Array(n), y: new Float32Array(n) };
      for (let i = 0; i < n; i++) { f.ids[i] = pts[i][0]; f.x[i] = pts[i][1]; f.y[i] = pts[i][2]; }
      frames.push(f); prev = P;
      return n;
    }
    return { push, frames, get count() { return next; } };
  }

  // ── frame pairs: the car moved ≥ 0.6 m or turned ≥ 1.5° between them, with the points tracked across both ──
  /** frames: [{ ids, x, y }] (picture px of a w-wide picture), ftimes: each frame's clip time (s). → { pairs, u0, v0, u1, v1, idx, turning } */
  function makePairs(frames, ftimes, path, w, h, opt) {
    const o = Object.assign({ maxPairs: 400, perPair: 60, minCommon: 25, step: 2, maxGap: 15, seed: 7 }, opt || {}), R = rng(o.seed);
    const cand = [], n = Math.min(frames.length, ftimes.length);
    for (let i = 0; i + 1 < n; i += o.step) {
      if (path.speed(ftimes[i]) < 1.0) continue;
      let j = -1, psi = 0;
      for (let k = 2; k <= o.maxGap && i + k < n; k++) {
        const m = path.rel(ftimes[i], ftimes[i + k]); psi = Math.abs(m.psi);
        if (Math.hypot(m.T[0], m.T[2]) >= 0.6 || psi >= 1.5 * D2R) { j = i + k; break; }
      }
      if (j < 0) continue;
      const A = frames[i], B = frames[j], at = new Map();
      for (let q = 0; q < B.ids.length; q++) at.set(B.ids[q], q);
      const common = [];
      for (let p = 0; p < A.ids.length; p++) { const q = at.get(A.ids[p]); if (q !== undefined) common.push([p, q]); }
      if (common.length < o.minCommon) continue;
      for (let k = common.length - 1; k > 0; k--) { const r = Math.floor(R() * (k + 1)); const t = common[k]; common[k] = common[r]; common[r] = t; }
      cand.push({ i, j, pts: common.slice(0, o.perPair), turn: psi >= 1.5 * D2R });
    }
    let pairs = cand;
    if (pairs.length > o.maxPairs) {   // every turning pair (they fix the lens), then a sample of the straight ones
      const turn = pairs.filter((p) => p.turn), rest = pairs.filter((p) => !p.turn);
      for (let k = rest.length - 1; k > 0; k--) { const r = Math.floor(R() * (k + 1)); const t = rest[k]; rest[k] = rest[r]; rest[r] = t; }
      pairs = turn.slice(0, o.maxPairs).concat(rest.slice(0, Math.max(0, o.maxPairs - turn.length))).sort((a, b) => a.i - b.i);
    }
    let N = 0; for (const p of pairs) N += p.pts.length;
    const u0 = new Float64Array(N), v0 = new Float64Array(N), u1 = new Float64Array(N), v1 = new Float64Array(N), idx = new Int32Array(N), start = new Int32Array(pairs.length + 1);
    let c = 0;
    pairs.forEach((p, k) => {
      start[k] = c; const A = frames[p.i], B = frames[p.j];
      for (const [a, b] of p.pts) { u0[c] = A.x[a] / w; v0[c] = A.y[a] / h; u1[c] = B.x[b] / w; v1[c] = B.y[b] / h; idx[c] = k; c++; }
    });
    start[pairs.length] = c;
    return { pairs: pairs.map((p) => ({ i: p.i, j: p.j, turn: p.turn })), u0, v0, u1, v1, idx, start, n: N, turning: pairs.filter((p) => p.turn).length };
  }

  // ── the fit ──
  const NG = 7;   // global unknowns: yaw, pitch, roll (rad), f, k1, k2, delay (s)
  /* Per frame pair, the car body's attitude on its suspension (the telemetry has the heading only): NB = 4 unknowns —
     how much it pitched / rolled between the two frames (Δ), and how it was pitched / rolled against the road at the first
     (B: under braking the nose dips, so the body's own forward axis is not the direction of travel). Without B, a sustained
     tilt can only be explained by tilting the camera, and the side cameras' pitch drifts by over half a degree. Their priors
     (and B averaging to level over the drive) keep each camera's angles relative to the car at rest. */
  const NB = 4, BODY_SIGMA = [0.25 * D2R, 0.25 * D2R, 0.5 * D2R, 0.5 * D2R], BODY_MAX = 0.05;
  /** pair motion with the body terms: X_body0 = R·X_body1 + t, R = Bᵀ·Ry(psi)·B·Δ, t = Bᵀ·T */
  function motion(m, body, k) {
    const o = NB * k, D = rot3(0, body[o], body[o + 1]), B = rot3(0, body[o + 2], body[o + 3]), Bt = tr(B);
    return [mul(mul(mul(Bt, RyM(m.psi)), B), D), mv(Bt, m.T)];
  }
  /** A camera's problem. data: makePairs(); ftimes; path; start: { yaw, pitch, roll (deg), f, cx, cy, k: [k1, k2], pos };
   *  wPx: pixels per picture width the residuals are counted in (the tracked picture's width). */
  function Problem(data, ftimes, path, start, wPx, opt) {
    const o = Object.assign({ aspect: ASPECT, scale: 0.5, yawRange: 25, pitchRange: 15, rollRange: 8, fRange: 0.12, k1Range: 0.05, k2Range: 0.03, delayRange: 0.3, back: false }, opt || {});
    const n = data.n, np = data.pairs.length, P = start.pos.slice();
    const b0 = new Float64Array(3 * n), b1 = new Float64Array(3 * n), s0 = new Float64Array(n), s1 = new Float64Array(n);
    let lensKey = null, rhoMax = 0;
    for (let i = 0; i < n; i++) for (const [u, v] of [[data.u0[i], data.v0[i]], [data.u1[i], data.v1[i]]]) rhoMax = Math.max(rhoMax, Math.hypot(u - 0.5 - start.cx, (v - 0.5) * o.aspect - start.cy));
    const k1b = o.back ? [-0.06, 0.12] : [-0.1, 0.4], k2b = o.back ? [0, 0.05] : [-0.03, 0.12];
    const lo = [(start.yaw - o.yawRange) * D2R, (start.pitch - o.pitchRange) * D2R, (start.roll - o.rollRange) * D2R, start.f * (1 - o.fRange), Math.max(k1b[0], start.k[0] - o.k1Range), Math.max(k2b[0], start.k[1] - o.k2Range), -o.delayRange];
    const hi = [(start.yaw + o.yawRange) * D2R, (start.pitch + o.pitchRange) * D2R, (start.roll + o.rollRange) * D2R, start.f * (1 + o.fRange), Math.min(k1b[1], start.k[0] + o.k1Range), Math.min(k2b[1], start.k[1] + o.k2Range), o.delayRange];
    function bearings(q) {
      const key = q[3] + "," + q[4] + "," + q[5]; if (key === lensKey) return; lensKey = key;
      for (let i = 0; i < n; i++) {
        const t0 = unproject(data.u0[i], data.v0[i], q[3], start.cx, start.cy, q[4], q[5], o.aspect, b0, 3 * i);
        const t1 = unproject(data.u1[i], data.v1[i], q[3], start.cx, start.cy, q[4], q[5], o.aspect, b1, 3 * i);
        s0[i] = scaleAt(t0, q[3], q[4], q[5]) * wPx; s1[i] = scaleAt(t1, q[3], q[4], q[5]) * wPx;
      }
    }
    /** residuals (pixels of the tracked picture: distance from the epipolar plane × the lens's local scale) into out */
    function residual(q, body, out) {
      bearings(q);
      const Rc = rot3(q[0], q[1], q[2]), Rct = tr(Rc);
      for (let k = 0; k < np; k++) {
        const pr = data.pairs[k], m = path.rel(ftimes[pr.i] + q[6], ftimes[pr.j] + q[6]), M = motion(m, body, k), R = M[0], tb = M[1];
        const R01 = mul(mul(Rct, R), Rc), RP = mv(R, P), t = mv(Rct, [RP[0] + tb[0] - P[0], RP[1] + tb[1] - P[1], RP[2] + tb[2] - P[2]]);
        const tn = Math.hypot(t[0], t[1], t[2]) || 1e-12, tx = t[0] / tn, ty = t[1] / tn, tz = t[2] / tn;
        // E = [t]x · R01
        const E = [
          -tz * R01[3] + ty * R01[6], -tz * R01[4] + ty * R01[7], -tz * R01[5] + ty * R01[8],
          tz * R01[0] - tx * R01[6], tz * R01[1] - tx * R01[7], tz * R01[2] - tx * R01[8],
          -ty * R01[0] + tx * R01[3], -ty * R01[1] + tx * R01[4], -ty * R01[2] + tx * R01[5]];
        for (let i = data.start[k]; i < data.start[k + 1]; i++) {
          const a0 = b0[3 * i], a1 = b0[3 * i + 1], a2 = b0[3 * i + 2], c0 = b1[3 * i], c1 = b1[3 * i + 1], c2 = b1[3 * i + 2];
          const e0 = E[0] * c0 + E[1] * c1 + E[2] * c2, e1 = E[3] * c0 + E[4] * c1 + E[5] * c2, e2 = E[6] * c0 + E[7] * c1 + E[8] * c2;
          const f0 = E[0] * a0 + E[3] * a1 + E[6] * a2, f1 = E[1] * a0 + E[4] * a1 + E[7] * a2, f2 = E[2] * a0 + E[5] * a1 + E[8] * a2;
          const num = a0 * e0 + a1 * e1 + a2 * e2;
          out[i] = 0.5 * (num / Math.max(1e-12, Math.sqrt(e0 * e0 + e1 * e1 + e2 * e2)) * s0[i] + num / Math.max(1e-12, Math.sqrt(f0 * f0 + f1 * f1 + f2 * f2)) * s1[i]);
        }
      }
      return out;
    }
    const clampQ = (q) => q.map((v, i) => Math.max(lo[i], Math.min(hi[i], v)));
    const pack = (yaw, pitch, roll, f, k1, k2, delay) => clampQ([yaw * D2R, pitch * D2R, roll * D2R, f, k1, k2, delay || 0]);
    return { n, np, data, residual, lo, hi, clampQ, pack, rhoMax, start, opt: o, wPx, lensOk: (q) => lensOk(q[4], q[5], rhoMax / q[3] * 1.02) };
  }

  /** Levenberg-Marquardt on the Cauchy-robust cost (IRLS weights), the NB body unknowns per pair folded out by a Schur
   *  complement. mask: Float64Array of 0/1 per residual (outliers trimmed). → { q, body, cost, iters } */
  function lm(pb, q, body, mask, iters) {
    const n = pb.n, np = pb.np, s2 = pb.opt.scale * pb.opt.scale, r = new Float64Array(n), rp = new Float64Array(n);
    const Jg = Array.from({ length: NG }, () => new Float64Array(n)), Jb = Array.from({ length: NB }, () => new Float64Array(n));
    const EPS = [1e-5, 1e-5, 1e-5, 1e-5 * pb.start.f, 1e-5, 1e-5, 2e-3], IS2 = BODY_SIGMA.map((x) => 1 / (x * x));
    const cost = (rr, bd) => { let c = 0; for (let i = 0; i < n; i++) if (mask[i]) c += 0.5 * s2 * Math.log1p(rr[i] * rr[i] / s2); for (let k = 0; k < NB * np; k++) c += 0.5 * bd[k] * bd[k] * IS2[k % NB]; return c; };
    pb.residual(q, body, r); let c0 = cost(r, body), lam = 1e-3, it = 0;
    const NN = NB * NB;
    for (; it < iters; it++) {
      // Jacobian (forward differences; a body unknown moves only its own pair's residuals, so one column for all pairs at once)
      for (let p = 0; p < NG; p++) {
        const qq = q.slice(); let e = EPS[p]; if (qq[p] + e > pb.hi[p]) e = -e; qq[p] += e;
        pb.residual(qq, body, rp); const J = Jg[p]; for (let i = 0; i < n; i++) J[i] = (rp[i] - r[i]) / e;
      }
      pb.residual(q, body, r);   // (restores the lens cache)
      for (let c = 0; c < NB; c++) {
        const bb = Float64Array.from(body); for (let k = 0; k < np; k++) bb[NB * k + c] += 1e-5;
        pb.residual(q, bb, rp); const J = Jb[c]; for (let i = 0; i < n; i++) J[i] = (rp[i] - r[i]) / 1e-5;
      }
      // weighted normal equations: A (NG×NG), per pair B_k (NG×NB), D_k (NB×NB), gradients g, gb
      const A = new Float64Array(NG * NG), g = new Float64Array(NG), Bk = new Float64Array(np * NG * NB), Dk = new Float64Array(np * NN), gb = new Float64Array(NB * np);
      for (let k = 0; k < np; k++) {
        const ob = k * NG * NB, od = k * NN;
        for (let i = pb.data.start[k]; i < pb.data.start[k + 1]; i++) {
          if (!mask[i]) continue;
          const w = 1 / (1 + r[i] * r[i] / s2), ri = r[i];
          for (let a = 0; a < NG; a++) {
            const ja = Jg[a][i] * w; g[a] += ja * ri;
            for (let b = a; b < NG; b++) A[a * NG + b] += ja * Jg[b][i];
            for (let c = 0; c < NB; c++) Bk[ob + a * NB + c] += ja * Jb[c][i];
          }
          for (let c = 0; c < NB; c++) { const jc = Jb[c][i] * w; gb[NB * k + c] += jc * ri; for (let d = c; d < NB; d++) Dk[od + c * NB + d] += jc * Jb[d][i]; }
        }
        for (let c = 0; c < NB; c++) { for (let d = 0; d < c; d++) Dk[od + c * NB + d] = Dk[od + d * NB + c]; Dk[od + c * NB + c] += IS2[c]; gb[NB * k + c] += body[NB * k + c] * IS2[c]; }
      }
      for (let a = 0; a < NG; a++) for (let b = 0; b < a; b++) A[a * NG + b] = A[b * NG + a];
      let accepted = false;
      for (let tries = 0; tries < 8 && !accepted; tries++) {
        // Schur: S = A' − Σ B D'^-1 Bᵀ, rhs = g − Σ B D'^-1 gb
        const S = new Float64Array(NG * NG), rhs = Float64Array.from(g), Y = new Float64Array(np * NB), Z = new Float64Array(np * NG * NB);
        for (let a = 0; a < NG; a++) { for (let b = 0; b < NG; b++) S[a * NG + b] = A[a * NG + b]; S[a * NG + a] += lam * Math.max(A[a * NG + a], 1e-9); }
        let bad = false;
        for (let k = 0; k < np && !bad; k++) {
          const od = k * NN, ob = k * NG * NB, D = Array.from(Dk.subarray(od, od + NN)); for (let c = 0; c < NB; c++) D[c * NB + c] *= 1 + lam;
          // D'^-1 gb and D'^-1 Bᵀ (columns) via one solve per right-hand side
          const y = solveN(D, Array.from(gb.subarray(NB * k, NB * k + NB)), NB); if (!y) { bad = true; break; }
          for (let c = 0; c < NB; c++) Y[NB * k + c] = y[c];
          for (let a = 0; a < NG; a++) {
            const z = solveN(D, Array.from(Bk.subarray(ob + a * NB, ob + a * NB + NB)), NB); if (!z) { bad = true; break; }
            for (let c = 0; c < NB; c++) Z[ob + a * NB + c] = z[c];
          }
          for (let a = 0; a < NG; a++) {
            let t = 0; for (let c = 0; c < NB; c++) t += Bk[ob + a * NB + c] * y[c]; rhs[a] -= t;
            for (let b = 0; b < NG; b++) { let u = 0; for (let c = 0; c < NB; c++) u += Z[ob + a * NB + c] * Bk[ob + b * NB + c]; S[a * NG + b] -= u; }
          }
        }
        const dg = bad ? null : solveN(Array.from(S), Array.from(rhs), NG);
        if (!dg) { lam *= 10; continue; }
        const qn = pb.clampQ(q.map((v, a) => v - dg[a])), bn = new Float64Array(NB * np);
        for (let k = 0; k < np; k++) {
          // δb_k = −D'^-1 (gb_k + B_kᵀ δg),  with δg = −dg:  = −Y_k + Z_kᵀ dg
          const ob = k * NG * NB;
          for (let c = 0; c < NB; c++) {
            let t = -Y[NB * k + c]; for (let a = 0; a < NG; a++) t += Z[ob + a * NB + c] * dg[a];
            bn[NB * k + c] = Math.max(-BODY_MAX, Math.min(BODY_MAX, body[NB * k + c] + t));
          }
        }
        if (!pb.lensOk(qn)) { lam *= 10; continue; }
        pb.residual(qn, bn, rp); const c1 = cost(rp, bn);
        if (c1 < c0) {
          const rel = (c0 - c1) / Math.max(c0, 1e-12); q = qn; body = bn; r.set(rp); c0 = c1; lam = Math.max(1e-7, lam / 3); accepted = true;
          if (rel < 1e-7) { pb.residual(q, body, r); return { q, body, cost: c0, iters: it + 1 }; }
        } else lam *= 6;
      }
      if (!accepted) break;
    }
    pb.residual(q, body, r);
    return { q, body, cost: c0, iters: it };
  }

  /** Fit one camera. start: the preset's camera ({ yaw, pitch, roll, f, cx, cy, k, pos }). → result with fit quality. */
  function fitCamera(data, ftimes, path, start, wPx, opt) {
    const o = Object.assign({ quick: false, seed: 7, wFull: 1448 }, opt || {});
    const pb = Problem(data, ftimes, path, start, wPx, o);
    if (pb.np < 8 || pb.n < 200) return { ok: false, why: "few-pairs", pairs: pb.np, matches: pb.n };
    const k = start.k;
    // a few starts round the preset on a subset of pairs: the cost is not convex in yaw, and a wrong lens width folds the turns
    const R = rng(o.seed), keepPairs = new Set();
    const order = [...Array(pb.np).keys()]; for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    order.slice(0, Math.min(pb.np, 120)).forEach((i) => keepPairs.add(i));
    const subMask = new Float64Array(pb.n); for (let i = 0; i < pb.n; i++) subMask[i] = keepPairs.has(data.idx[i]) ? 1 : 0;
    const starts = [];
    for (const dy of o.quick ? [0] : [-10, 0, 10]) for (const fs of o.quick ? [1] : [0.94, 1, 1.06]) starts.push(pb.pack(start.yaw + dy, start.pitch, start.roll, start.f * fs, k[0], k[1], 0));
    let best = null;
    for (const q0 of starts) {
      if (!pb.lensOk(q0)) continue;
      const r = lm(pb, q0, new Float64Array(NB * pb.np), subMask, 15);
      if (!best || r.cost < best.cost) best = r;
    }
    if (!best) return { ok: false, why: "lens" };
    // all pairs, then trim outliers (other cars, the car's own body) twice
    let mask = new Float64Array(pb.n).fill(1), fit = lm(pb, best.q, new Float64Array(NB * pb.np), mask, 40);
    const res = new Float64Array(pb.n);
    for (let pass = 0; pass < 2; pass++) {
      pb.residual(fit.q, fit.body, res);
      const s = 1.4826 * median(Array.from(res, Math.abs)), lim = Math.max(4 * s, 3 * pb.opt.scale);
      mask = new Float64Array(pb.n); for (let i = 0; i < pb.n; i++) mask[i] = Math.abs(res[i]) < lim ? 1 : 0;
      fit = lm(pb, fit.q, fit.body, mask, 40);
    }
    pb.residual(fit.q, fit.body, res);
    const inl = []; for (let i = 0; i < pb.n; i++) if (mask[i]) inl.push(Math.abs(res[i]));
    const q = fit.q, med = median(inl), full = o.wFull / wPx;
    // widest angle off the lens axis among the tracked points (beyond it the lens is a guess)
    let thmax = 0; const tmp = [0, 0, 0];
    for (let i = 0; i < pb.n; i++) if (mask[i]) thmax = Math.max(thmax, unproject(data.u0[i], data.v0[i], q[3], start.cx, start.cy, q[4], q[5], pb.opt.aspect, tmp, 0));
    const atBound = [0, 1, 2, 3].filter((i) => Math.abs(q[i] - pb.lo[i]) < 1e-6 || Math.abs(q[i] - pb.hi[i]) < 1e-6).map((i) => ["yaw", "pitch", "roll", "f"][i]);
    let brms = 0; for (let i = 0; i < fit.body.length; i++) brms += fit.body[i] ** 2;
    return {
      ok: true, yaw: ((q[0] * R2D + 540) % 360) - 180, pitch: q[1] * R2D, roll: q[2] * R2D, f: q[3], cx: start.cx, cy: start.cy, k: [q[4], q[5], 0], delay: q[6],
      thmax: thmax * R2D, pos: start.pos.slice(), body: fit.body, mask, q,
      fit: { pairs: pb.np, turning: data.turning, matches: pb.n, inliers: inl.length, inlierShare: inl.length / pb.n, median_px: med * full, median_track_px: med, atBound,
        body_rms_deg: Math.sqrt(brms / Math.max(1, fit.body.length)) * R2D },
    };
  }

  // ── road height ──
  /** Triangulated road points under the camera (tracked points on the road, with the metric move): the lowest dense layer
   *  of points round the car. → { height, points, inliers } or null. */
  function heightFromPoints(data, ftimes, path, cam) {
    const Rc = rot3(cam.yaw * D2R, cam.pitch * D2R, cam.roll * D2R), Rct = tr(Rc), P = cam.pos, a = ASPECT, ys = [];
    const b0 = [0, 0, 0], b1 = [0, 0, 0];
    data.pairs.forEach((pr, k) => {
      const m = path.rel(ftimes[pr.i] + (cam.delay || 0), ftimes[pr.j] + (cam.delay || 0));
      const M = motion(m, cam.body || new Float64Array(NB * (k + 1)), k), R = M[0], tb = M[1], R01 = mul(mul(Rct, R), Rc), RP = mv(R, P);
      const t = mv(Rct, [RP[0] + tb[0] - P[0], RP[1] + tb[1] - P[1], RP[2] + tb[2] - P[2]]);
      if (Math.hypot(t[0], t[1], t[2]) < 0.5) return;
      for (let i = data.start[k]; i < data.start[k + 1]; i++) {
        if (cam.mask && !cam.mask[i]) continue;
        unproject(data.u0[i], data.v0[i], cam.f, cam.cx, cam.cy, cam.k[0], cam.k[1], a, b0, 0);
        unproject(data.u1[i], data.v1[i], cam.f, cam.cx, cam.cy, cam.k[0], cam.k[1], a, b1, 0);
        const d1 = mv(R01, b1), A = b0[0] * b0[0] + b0[1] * b0[1] + b0[2] * b0[2], B = b0[0] * d1[0] + b0[1] * d1[1] + b0[2] * d1[2], C = d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2];
        const D = b0[0] * t[0] + b0[1] * t[1] + b0[2] * t[2], E = d1[0] * t[0] + d1[1] * t[1] + d1[2] * t[2], den = A * C - B * B;
        if (!(den > 1e-12)) continue;
        const s = (D * C - B * E) / den, u = (B * D - A * E) / den;
        if (s < 0.5 || u < 0.5 || Math.acos(Math.min(1, B / Math.sqrt(A * C))) < 1 * D2R) continue;
        const X = [0.5 * (s * b0[0] + t[0] + u * d1[0]), 0.5 * (s * b0[1] + t[1] + u * d1[1]), 0.5 * (s * b0[2] + t[2] + u * d1[2])];
        const Xc = mv(Rc, X); if (Xc[1] < -0.2 && Math.hypot(Xc[0], Xc[2]) < 12 && Math.abs(Xc[0]) < 6) ys.push(-Xc[1]);
      }
    });
    if (ys.length < 30) return null;
    const bins = new Float64Array(56); for (const y of ys) { const b = Math.floor((y - 0.2) / 0.05); if (b >= 0 && b < 56) bins[b]++; }
    const sm = bins.map((_, i) => [1, 2, 3, 2, 1].reduce((s, w, j) => s + w * (bins[i + j - 2] || 0), 0)), top = Math.max(...sm);
    let pk = -1; for (let i = 1; i < 55; i++) if (sm[i] >= sm[i - 1] && sm[i] >= sm[i + 1] && sm[i] >= 0.3 * top) pk = i;   // the lowest layer = the largest height
    if (pk < 0) return null;
    const h0 = 0.2 + (pk + 0.5) * 0.05, near = ys.filter((y) => Math.abs(y - h0) < 0.15);
    return { height: median(near), points: ys.length, inliers: near.length, method: "points" };
  }
  /** Road pairs: driving straight-ish at > 4 m/s, moved 0.8–1.6 m (picked from the telemetry before any picture is read). */
  function roadPairs(ftimes, path, opt) {
    const o = Object.assign({ every: 25, max: 16 }, opt || {}), out = [];
    for (let i = 0; i + 3 < ftimes.length && out.length < o.max; i += o.every) {
      if (path.speed(ftimes[i]) < 4) continue;
      for (let j = i + 1; j < Math.min(ftimes.length, i + 60); j++) {
        const m = path.rel(ftimes[i], ftimes[j]);
        if (Math.hypot(m.T[0], m.T[2]) >= 1.0) { if (Math.abs(m.psi) < 3 * D2R) out.push([i, j]); break; }
      }
    }
    return out;
  }
  function gradImg(g, w, h) {
    const o = new Float32Array(w * h), b = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, gx = (g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - 1] + g[i + w - 1]), gy = (g[i + w - 1] + 2 * g[i + w] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - w] + g[i - w + 1]);
      o[i] = Math.sqrt(gx * gx + gy * gy);
    }
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; b[i] = (4 * o[i] + o[i - 1] + o[i + 1] + o[i - w] + o[i + w]) / 8; }
    return b;
  }
  /** Height by road-surface alignment (tools/rig/roadheight.py): ground pixels of the later frame, sent out as rays, meet the
   *  road at a trial height, are moved back by the car's move and projected into the earlier frame; the gradient pictures line
   *  up (NCC) only at the true height. imgs: Map frame index → grey (w × h); pairs: roadPairs(); cam: fitted camera.
   *  isBody(u, v) → true on the car's own body. → { height, spread, pairs, ncc } or null. */
  function heightFromRoad(imgs, pairs, w, h, ftimes, path, cam, isBody) {
    const Rc = rot3(cam.yaw * D2R, cam.pitch * D2R, cam.roll * D2R), Rct = tr(Rc), P = cam.pos, a = h / w, best = [];
    const step = Math.max(2, Math.round(w / 362)), px = [];
    const thmax = (cam.thmax || 80) * D2R, bc = [0, 0, 0];
    for (let y = 2; y < h - 2; y += step) for (let x = 2; x < w - 2; x += step) {
      const u = x / w, v = y / h, th = unproject(u, v, cam.f, cam.cx, cam.cy, cam.k[0], cam.k[1], a, bc, 0);
      if (th > thmax) continue;
      const d = mv(Rc, bc); if (d[1] > -Math.sin(6 * D2R)) continue;
      if (isBody && isBody(u, v)) continue;
      px.push([x, y, d[0], d[1], d[2]]);
    }
    if (px.length < 500) return null;
    for (const [i, j] of pairs) {
      const gi = imgs.get(i), gj = imgs.get(j); if (!gi || !gj) continue;
      const Gi = gradImg(gi, w, h), Gj = gradImg(gj, w, h), m = path.rel(ftimes[i] + (cam.delay || 0), ftimes[j] + (cam.delay || 0)), R = RyM(m.psi), Rt = tr(R);
      let bestH = null, bestS = -1, at = -1; const scores = [];
      for (let hh = 0.5, hk = 0; hh <= 2.2001; hh += 0.01, hk++) {
        let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
        for (const p of px) {
          const s = -hh / p[3]; if (s > 12) continue;
          const X = [P[0] + s * p[2], P[1] + s * p[3], P[2] + s * p[4]];
          if (Math.hypot(X[0] - P[0], X[2] - P[2]) > 9) continue;
          const Xj = mv(Rt, [X[0] - m.T[0], X[1] - m.T[1], X[2] - m.T[2]]), bj = mv(Rct, [Xj[0] - P[0], Xj[1] - P[1], Xj[2] - P[2]]);
          const q = project(bj, cam.f, cam.cx, cam.cy, cam.k[0], cam.k[1], a), qx = q.u * w, qy = q.v * h;
          if (!(qx >= 1 && qy >= 1 && qx < w - 2 && qy < h - 2)) continue;
          const x0 = Math.floor(qx), y0 = Math.floor(qy), fx = qx - x0, fy = qy - y0, k = y0 * w + x0;
          const A = (Gj[k] * (1 - fx) + Gj[k + 1] * fx) * (1 - fy) + (Gj[k + w] * (1 - fx) + Gj[k + w + 1] * fx) * fy, B = Gi[p[1] * w + p[0]];
          n++; sa += A; sb += B; saa += A * A; sbb += B * B; sab += A * B;
        }
        let sc = -1;
        if (n >= 400) { const va = saa - sa * sa / n, vb = sbb - sb * sb / n; sc = va > 0 && vb > 0 ? (sab - sa * sb / n) / Math.sqrt(va * vb) : -1; }
        scores.push(sc); if (sc > bestS) { bestS = sc; bestH = hh; at = hk; }
      }
      if (bestS > 0.3 && at > 0 && at < scores.length - 1) best.push([bestH, bestS]);
    }
    if (!best.length) return null;
    const H = best.map((b) => b[0]), med = median(H), mad = 1.4826 * median(H.map((x) => Math.abs(x - med)));
    return { height: med, spread: mad, pairs: best.length, ncc: median(best.map((b) => b[1])), method: "road" };
  }

  /* ── quality gate: what a saved calibration must reach (per camera) ──
     The offline fit on full-width tracks reached 0.10–0.22 px; tracks at half width are noisier. These limits are a first
     guess, to be checked on real clips (see tools/rig/README.md). */
  const QUALITY = { good: 0.6, max: 1.2, minPairs: 40, minTurning: 6, minInlierShare: 0.5 };
  function judge(r) {
    if (!r || !r.ok) return { pass: false, why: r && r.why === "few-pairs" ? "too few tracked points while moving" : "the fit did not work" };
    const f = r.fit;
    if (f.pairs < QUALITY.minPairs) return { pass: false, why: "too little driving in view (" + f.pairs + " frame pairs)" };
    if (f.turning < QUALITY.minTurning) return { pass: false, why: "no turn in view" };
    if (f.inlierShare < QUALITY.minInlierShare) return { pass: false, why: "most points don't agree with the car's move" };
    if (f.atBound.length) return { pass: false, why: "the " + f.atBound.join(", ") + " ran to the end of its allowed range" };
    if (!(f.median_px <= QUALITY.max)) return { pass: false, why: "fit error " + f.median_px.toFixed(2) + " px (limit " + QUALITY.max + ")" };
    return { pass: true, grade: f.median_px <= QUALITY.good ? "good" : "fair" };
  }

  /** The whole job for one camera on data already tracked: fit, then road height. → { cam result, judge } */
  function calibrateTracked(frames, ftimes, path, start, w, h, opt) {
    const o = Object.assign({ wFull: 1448, roadImgs: null, roadPairs: null, isBody: null, back: false }, opt || {});
    const data = makePairs(frames, ftimes, path, w, h, o.pairs);
    const r = fitCamera(data, ftimes, path, start, w, Object.assign({}, o, { aspect: h / w }));
    if (r.ok) {
      let road = null;
      if (o.roadImgs && o.roadPairs) road = heightFromRoad(o.roadImgs, o.roadPairs, w, h, ftimes, path, r, o.isBody);
      const pts = heightFromPoints(data, ftimes, path, r);
      if (!road && pts) road = pts;
      r.road = road; r.roadPoints = pts;
      if (road && road.height > 0.3 && road.height < 2.5) r.pos[1] = road.height;
    }
    const j = judge(r);
    delete (r || {}).mask; delete (r || {}).q; if (r) delete r.body;
    return Object.assign(r || {}, { judge: j });
  }

  return { rot3, Path, driveStats, unproject, project, scaleAt, lensOk, pyramid, lkPoint, corners, Tracker, makePairs, Problem, lm, fitCamera,
    heightFromPoints, heightFromRoad, roadPairs, judge, calibrateTracked, QUALITY, rng, median };
});
