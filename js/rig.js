/* rig.js — the six cameras as measured instruments: lens, where each is mounted and points, the road under it, the
 * car's own body in its picture, and its clock.
 *
 * Measured by tools/rig on a real drive (2024 Model X, HW4, six cameras, 2026-10-19, 60 s with two right-angle turns), without a chart:
 * the car's own motion is the reference. The telemetry (speed, heading) says how the car moved between two frames; points
 * tracked across those frames must agree with that move, which fixes each camera's lens (Kannala-Brandt fisheye
 * r = f·θ(1 + k1θ² + k2θ⁴ + k3θ⁶)) and mounting angles (tools/rig/calibrate.py; 0.12–0.22 px median error). The road
 * surface, warped from one frame onto the next, lines up only at the camera's true height (tools/rig/roadheight.py).
 * The car's body pitches and rolls ~0.1° between frames on its suspension; the fit allows for it.
 *
 * Axes (as js/pano.js): car x right, y up, z forward, metres; origin on the road under the middle of the rear axle (the
 * point that moves along the heading). Camera yaw + = to the right of straight ahead, pitch + = up. Pictures: raw
 * (un-mirrored) u, v in 0..1 of width and height. The along/across positions (x, z) are a 2024 Model X's (from its
 * dimensions); the heights are measured. Other models (3, Y, Cybertruck…) mount their cameras elsewhere: PRESETS has a
 * starting point per model (positions from published dimensions, ESTIMATED), and js/rig-calib.js measures a car's own
 * cameras from one of its drives in the browser (Settings ▸ Advanced & Labs ▸ Camera calibration); set() loads the result.
 *
 * Clocks: the six files of a clip do not start together. Each file carries the telemetry stamped on its own frames, so
 * matching the speed and heading curves gives each camera's offset (on the drive above: back +0.35 s, right pillar
 * +0.18 s, left pillar +0.07 s, repeaters −0.03 s against the front). clock(cam) = seconds to add to that camera's
 * clip time to get the front camera's clip time of the same moment.
 *
 * Pure functions (node tests: module.exports); the browser part adds per-clip clocks from the files' telemetry. */
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else { const T = (root.TDC = root.TDC || {}); T.rig = Object.assign(m, T.rig || {}); m.factory = factory; if (m.browser && typeof document !== "undefined") m.browser(T); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const CAMS = ["front", "back", "left_pillar", "right_pillar", "left_repeater", "right_repeater"];
  const D2R = Math.PI / 180;
  // ── measured (tools/rig/to-js.py writes this block) ──
  // f, cx, cy in picture widths; thmax: the widest angle off the lens axis the drive showed (beyond it the lens is a guess);
  // aspect = height / width of the measured picture (HW4 1448×938, front 2896×1876)
  const MEASURED = {
    front:          { yaw: 0.98, pitch: -0.7, roll: 1.46, f: 1.32617, cx: 0.00957, cy: -0.01206, k: [-0.06024, -0.02021, 0.0], thmax: 24.1, pos: [0, 1.3, 2.05], px: 0.172 },
    back:           { yaw: -179.9, pitch: -32.01, roll: 0.19, f: 0.33678, cx: 0.00437, cy: -0.02206, k: [-0.03411, 0.00032, 0.0], thmax: 96.9, pos: [0, 1.0, -1.04], px: 0.101 },
    left_pillar:    { yaw: -70.63, pitch: -4.82, roll: 0.42, f: 0.70043, cx: -0.00278, cy: -0.00142, k: [-0.05474, -0.02416, 0.0], thmax: 46.4, pos: [-0.92, 1.317, 1.55], px: 0.157 },
    right_pillar:   { yaw: 71.66, pitch: -5.25, roll: -0.16, f: 0.70242, cx: 0.00221, cy: -0.00104, k: [-0.0597, -0.01962, 0.0], thmax: 48.8, pos: [0.92, 1.317, 1.55], px: 0.22 },
    left_repeater:  { yaw: -139.84, pitch: -4.88, roll: 0.26, f: 0.69812, cx: 0.00476, cy: 0.00147, k: [-0.02037, -0.01163, 0.0], thmax: 42.1, pos: [-1.02, 0.99, 2.45], px: 0.186 },
    right_repeater: { yaw: 140.07, pitch: -4.92, roll: 1.31, f: 0.71164, cx: -0.00294, cy: 0.0128, k: [-0.05051, -0.02271, 0.0], thmax: 42.4, pos: [1.02, 0.99, 2.45], px: 0.179 },
  };
  const ASPECT = 938 / 1448;
  const CLOCK0 = { front: 0, back: 0.346, left_pillar: 0.067, right_pillar: 0.175, left_repeater: -0.025, right_repeater: -0.029 };
  // ── end measured ──
  /* The car's body as boxes (2024 Model X: 5.06 m long, 2.0 m wide, 1.68 m high, wheelbase 2.97 m; x half-width, y from–to,
     z from–to). `not`: cameras that don't see that part — the windscreen camera looks out through the cabin's glass, and the
     bonnet slopes away below its view (the measured drive shows none of it). The bumper lip sticks out under the back
     camera: the bottom of its fisheye. */
  const BODY = [
    { x: 1.0, y0: 0.15, y1: 1.05, z0: -1.03, z1: 2.6 },                   // body below the belt line
    { x: 1.0, y0: 0.15, y1: 0.95, z0: 2.6, z1: 4.03, not: ["front"] },     // bonnet
    { x: 0.85, y0: 1.05, y1: 1.68, z0: -0.6, z1: 2.5, not: ["front"] },    // cabin
    { x: 0.95, y0: 0.25, y1: 0.62, z0: -1.25, z1: -1.03 },                 // rear bumper lip
  ];

  /* ── presets: one per model, as the starting point for a car's own calibration (js/rig-calib.js) ──
     The files don't say which model recorded them, and each model mounts its cameras in other places. All HW4 cars use the
     same camera modules, so every preset takes the lenses and the mounting ANGLES measured on the Model X (MEASURED above):
     those are a starting point to refine by calibration, not a measurement of that model.
       MEASURED (2026-10-19 drive): Model X — angles, lenses, the six heights above the road.
       ESTIMATED: everything else — every other model's camera positions and heights, and all body boxes (also the Model X's
         positions along and across the car), from published dimensions (length, width without mirrors, height, wheelbase)
         and where the cameras sit on photos of each car (windscreen top, B-pillar badge, front-fender repeater, above the
         number plate / on the tailgate). Expect ±0.1 m on heights and ±0.2 m along the car until calibrated.
     dims: [length, width (no mirrors), height, wheelbase] in metres; pos: camera [x, y, z] (origin on the road under the
     middle of the rear axle). One side only: the other side mirrors x. body: as BODY above. */
  const PRESETS = {
    model_x: { name: "Model X", note: "2021 on (HW4); heights measured", measured: true, dims: [5.057, 1.999, 1.68, 2.965],
      pos: { front: [0, 1.3, 2.05], back: [0, 1.0, -1.04], pillar: [0.92, 1.317, 1.55], repeater: [1.02, 0.99, 2.45] }, body: BODY },
    model_s: { name: "Model S", note: "2021 on (HW4); estimated", dims: [5.021, 1.987, 1.431, 2.96],
      pos: { front: [0, 1.2, 1.95], back: [0, 0.98, -1.08], pillar: [0.9, 1.12, 1.45], repeater: [0.98, 0.88, 2.45] },
      body: [{ x: 0.99, y0: 0.15, y1: 0.95, z0: -1.08, z1: 2.5 }, { x: 0.99, y0: 0.15, y1: 0.85, z0: 2.5, z1: 3.9, not: ["front"] },
        { x: 0.8, y0: 0.95, y1: 1.43, z0: -0.5, z1: 2.35, not: ["front"] }, { x: 0.94, y0: 0.25, y1: 0.58, z0: -1.25, z1: -1.08 }] },
    model_3: { name: "Model 3", note: "incl. Highland (HW4); estimated", dims: [4.72, 1.85, 1.441, 2.875],
      pos: { front: [0, 1.18, 1.9], back: [0, 0.95, -0.97], pillar: [0.84, 1.1, 1.4], repeater: [0.92, 0.86, 2.38] },
      body: [{ x: 0.925, y0: 0.15, y1: 0.95, z0: -0.97, z1: 2.4 }, { x: 0.925, y0: 0.15, y1: 0.82, z0: 2.4, z1: 3.72, not: ["front"] },
        { x: 0.76, y0: 0.95, y1: 1.44, z0: -0.4, z1: 2.3, not: ["front"] }, { x: 0.88, y0: 0.25, y1: 0.56, z0: -1.12, z1: -0.97 }] },
    model_y: { name: "Model Y", note: "incl. Juniper (HW4); estimated", dims: [4.797, 1.921, 1.624, 2.89],
      pos: { front: [0, 1.35, 1.95], back: [0, 1.02, -1.02], pillar: [0.88, 1.24, 1.45], repeater: [0.96, 0.95, 2.4] },
      body: [{ x: 0.96, y0: 0.17, y1: 1.02, z0: -1.02, z1: 2.45 }, { x: 0.96, y0: 0.17, y1: 0.92, z0: 2.45, z1: 3.77, not: ["front"] },
        { x: 0.8, y0: 1.02, y1: 1.62, z0: -0.6, z1: 2.35, not: ["front"] }, { x: 0.92, y0: 0.27, y1: 0.6, z0: -1.18, z1: -1.02 }] },
    model_yl: { name: "Model YL", note: "Model Y L, six seats (HW4); estimated", dims: [4.976, 1.92, 1.668, 3.04],
      pos: { front: [0, 1.38, 2.1], back: [0, 1.04, -1.05], pillar: [0.88, 1.27, 1.55], repeater: [0.96, 0.96, 2.55] },
      body: [{ x: 0.96, y0: 0.17, y1: 1.04, z0: -1.05, z1: 2.6 }, { x: 0.96, y0: 0.17, y1: 0.93, z0: 2.6, z1: 3.92, not: ["front"] },
        { x: 0.8, y0: 1.04, y1: 1.67, z0: -0.7, z1: 2.5, not: ["front"] }, { x: 0.92, y0: 0.27, y1: 0.6, z0: -1.21, z1: -1.05 }] },
    cybertruck: { name: "Cybertruck", note: "estimated", dims: [5.683, 2.201, 1.791, 3.807],
      pos: { front: [0, 1.65, 2.45], back: [0, 1.12, -0.95], pillar: [1.0, 1.45, 2.0], repeater: [1.08, 1.15, 3.0] },
      body: [{ x: 1.1, y0: 0.3, y1: 1.2, z0: -0.95, z1: 3.2 }, { x: 1.1, y0: 0.3, y1: 1.12, z0: 3.2, z1: 4.75, not: ["front"] },
        { x: 0.95, y0: 1.2, y1: 1.79, z0: 0.6, z1: 2.9, not: ["front"] }, { x: 1.05, y0: 1.2, y1: 1.28, z0: -0.95, z1: 0.6, not: ["back"] },
        { x: 1.05, y0: 0.45, y1: 0.75, z0: -1.1, z1: -0.95 }] },
  };
  const posOf = (p, cam) => {
    if (cam === "front" || cam === "back") return p.pos[cam].slice();
    const a = p.pos[cam.endsWith("pillar") ? "pillar" : "repeater"];
    return [cam.startsWith("left") ? -a[0] : a[0], a[1], a[2]];
  };
  /** A model's preset as a rig JSON for set(): the measured Model X lenses and angles, that model's positions and body. */
  function preset(id) {
    const p = PRESETS[id]; if (!p) return null;
    const out = { preset: id, source: "preset", cams: {}, body: clone(p.body) };
    for (const cam of CAMS) out.cams[cam] = Object.assign(clone(MEASURED[cam]), { pos: posOf(p, cam) });
    return out;
  }
  /** Which preset a measured rig looks like: by the cameras' heights above the road (the angles are the same modules on
   *  every model; positions along the car can't be measured from the pictures). heights: { cam: metres }. →
   *  [{ id, name, rms (m), n }] best first. Left and right are averaged (their difference is within the measuring spread). */
  function closestPreset(heights) {
    const grp = (h, a, b) => [h[a], h[b]].filter((v) => isFinite(v) && v > 0);
    const meas = {}; const H = heights || {};
    for (const [k, a, b] of [["front", "front"], ["back", "back"], ["pillar", "left_pillar", "right_pillar"], ["repeater", "left_repeater", "right_repeater"]]) {
      const v = grp(H, a, b || a); if (v.length) meas[k] = v.reduce((s, x) => s + x, 0) / v.length;
    }
    const keys = Object.keys(meas); if (!keys.length) return [];
    return Object.keys(PRESETS).map((id) => {
      const p = PRESETS[id]; let e = 0; for (const k of keys) e += (meas[k] - p.pos[k][1]) ** 2;
      return { id, name: p.name, rms: Math.sqrt(e / keys.length), n: keys.length };
    }).sort((a, b) => a.rms - b.rms);
  }
  // typical real heights (m) of what the detector finds: a box far off these is the wrong size for where it stands
  const HEIGHT = { car: 1.5, truck: 2.8, bus: 3.1, motorcycle: 1.4, bicycle: 1.5, person: 1.7, vehicle: 1.6 };

  let cams = clone(MEASURED), body = BODY, info = { preset: "model_x", source: "measured" };
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  const R = {};   // rotation matrices, camera → car (cached per camera)

  function rot(yaw, pitch, roll) {
    const cy = Math.cos(yaw * D2R), sy = Math.sin(yaw * D2R), cp = Math.cos(pitch * D2R), sp = Math.sin(pitch * D2R), cr = Math.cos(roll * D2R), sr = Math.sin(roll * D2R);
    const Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], Rx = [[1, 0, 0], [0, cp, sp], [0, -sp, cp]], Rz = [[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]];
    const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
    return mul(mul(Ry, Rx), Rz);
  }
  function rotOf(cam) { if (!R[cam]) { const c = cams[cam]; R[cam] = rot(c.yaw, c.pitch, c.roll); } return R[cam]; }
  const kb = (th, k) => { const t2 = th * th; return th * (1 + t2 * (k[0] + t2 * (k[1] + t2 * k[2]))); };
  const dkb = (th, k) => { const t2 = th * th; return 1 + t2 * (3 * k[0] + t2 * (5 * k[1] + t2 * 7 * k[2])); };

  /** Is the measured rig usable for this camera's picture (same shape as measured)? w, h optional (pixels). */
  function ok(cam, w, h) {
    if (!cams[cam]) return false;
    return !(w > 0 && h > 0) || Math.abs(h / w - ASPECT) < 0.03;
  }

  /** Picture position (u, v in 0..1) → unit direction in car axes, or null outside the lens's measured reach. */
  function ray(cam, u, v) {
    const c = cams[cam]; if (!c) return null;
    const dx = (u - 0.5 - c.cx) / c.f, dy = ((v - 0.5) * ASPECT - c.cy) / c.f, rho = Math.hypot(dx, dy);
    let th = rho;
    for (let i = 0; i < 8; i++) th = Math.max(0, th - (kb(th, c.k) - rho) / Math.max(0.05, dkb(th, c.k)));
    if (th > c.thmax * D2R * 1.15) return null;
    const s = rho > 1e-9 ? Math.sin(th) / rho : 1, b = [dx * s, -dy * s, Math.cos(th)], M = rotOf(cam);
    return [M[0][0] * b[0] + M[0][1] * b[1] + M[0][2] * b[2], M[1][0] * b[0] + M[1][1] * b[1] + M[1][2] * b[2], M[2][0] * b[0] + M[2][1] * b[1] + M[2][2] * b[2]];
  }

  /** A point (metres, car axes) → { u, v, th } in the camera's picture (may lie outside 0..1), or null behind / beyond reach. */
  function pixel(cam, P) {
    const c = cams[cam]; if (!c) return null;
    const M = rotOf(cam), d = [P[0] - c.pos[0], P[1] - c.pos[1], P[2] - c.pos[2]];
    const x = M[0][0] * d[0] + M[1][0] * d[1] + M[2][0] * d[2], y = M[0][1] * d[0] + M[1][1] * d[1] + M[2][1] * d[2], z = M[0][2] * d[0] + M[1][2] * d[1] + M[2][2] * d[2];
    const n = Math.hypot(x, y, z); if (!(n > 1e-9)) return null;
    const th = Math.acos(Math.max(-1, Math.min(1, z / n))); if (th > c.thmax * D2R * 1.15) return null;
    const r = c.f * kb(th, c.k), l = Math.hypot(x, y) || 1;
    return { u: 0.5 + c.cx + r * x / l, v: 0.5 + (c.cy - r * y / l) / ASPECT, th: th / D2R };
  }
  const inside = (p, m) => p && p.u >= (m || 0) && p.u <= 1 - (m || 0) && p.v >= (m || 0) && p.v <= 1 - (m || 0);

  /** Where a picture position meets the road: { x, z, dist (from the camera, along the road), bearing } or null (sky,
   *  car body, or farther than maxDist, 60 m by default: there a pixel spans metres). */
  function ground(cam, u, v, maxDist) {
    const c = cams[cam], d = ray(cam, u, v); if (!d || d[1] > -0.004) return null;
    const s = -c.pos[1] / d[1], x = c.pos[0] + s * d[0], z = c.pos[2] + s * d[2], dist = Math.hypot(x - c.pos[0], z - c.pos[2]);
    if (dist > (maxDist || 60)) return null;
    return { x, z, dist, bearing: Math.atan2(x, z) / D2R };
  }

  /** Direction round the car (degrees, 0 = straight ahead, + = clockwise / to the right) of a picture position. */
  function bearing(cam, u, v) {
    const d = ray(cam, u, v == null ? 0.5 : v); return d ? Math.atan2(d[0], d[2]) / D2R : null;
  }

  /** Does the ray through (u, v) hit the car itself? (slab test against the body boxes) */
  function isBody(cam, u, v) {
    const c = cams[cam], d = ray(cam, u, v); if (!d) return false;   // (beyond the lens's measured reach: unknown, not body)
    const o = c.pos.map((p, i) => p + d[i] * 0.03);
    for (const b of body) {
      if (b.not && b.not.includes(cam)) continue;
      let t0 = 0, t1 = 6;
      for (const [lo, hi, oi, di] of [[-b.x, b.x, o[0], d[0]], [b.y0, b.y1, o[1], d[1]], [b.z0, b.z1, o[2], d[2]]]) {
        if (Math.abs(di) < 1e-9) { if (oi < lo || oi > hi) { t0 = 1; t1 = 0; break; } continue; }
        let a = (lo - oi) / di, e = (hi - oi) / di; if (a > e) [a, e] = [e, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, e); if (t0 > t1) break;
      }
      if (t0 <= t1) return true;
    }
    return false;
  }
  const bodyGrids = {};
  /** Share (0..1) of a box { x, y, w, h } that shows the car's own body (8 × 8 samples, grid cached per camera). */
  function bodyShare(cam, box) {
    if (!cams[cam]) return 0;
    let g = bodyGrids[cam];
    if (!g) { g = bodyGrids[cam] = new Uint8Array(64 * 42); for (let j = 0; j < 42; j++) for (let i = 0; i < 64; i++) g[j * 64 + i] = isBody(cam, (i + 0.5) / 64, (j + 0.5) / 42) ? 1 : 0; }
    let n = 0;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
      const gi = Math.min(63, Math.max(0, Math.floor((box.x + box.w * (i + 0.5) / 8) * 64))), gj = Math.min(41, Math.max(0, Math.floor((box.y + box.h * (j + 0.5) / 8) * 42)));
      n += g[gj * 64 + gi];
    }
    return n / 64;
  }

  /** Where a detection box stands and how big it is: { x, z, dist, bearing, hM, wM } (metres) from its bottom middle
   *  on the road, or null (its foot is above the horizon, cut off by the picture's bottom edge, or too far). */
  function footprint(cam, box, maxDist) {
    const c = cams[cam]; if (!c || !box) return null;
    if (box.y + box.h > 0.985) return null;                       // the foot is out of the picture: where it stands is unknown
    const g = ground(cam, box.x + box.w / 2, box.y + box.h, maxDist); if (!g) return null;
    // height: the top's ray meets the upright line above the foot (closest approach)
    const top = ray(cam, box.x + box.w / 2, box.y), lft = ground(cam, box.x, box.y + box.h, 200), rgt = ground(cam, box.x + box.w, box.y + box.h, 200);
    let hM = null;
    if (top) {
      const hz = Math.hypot(top[0], top[2]); if (hz > 1e-6) hM = c.pos[1] + top[1] * (Math.hypot(g.x - c.pos[0], g.z - c.pos[2]) / hz);
    }
    const wM = lft && rgt ? Math.hypot(rgt.x - lft.x, rgt.z - lft.z) : null;
    return Object.assign(g, { hM, wM });
  }

  /** How well a box's size fits its kind where it stands: measured height ÷ typical (1 = as expected), or null. */
  function sizeRatio(cam, box, cls) {
    const f = footprint(cam, box); const H = HEIGHT[cls] || HEIGHT[(cls || "").toLowerCase()];
    return f && f.hM > 0 && H ? f.hM / H : null;
  }

  /** The box an object (standing at x, z, hM tall, wM wide) makes in a camera's picture, or null if not in view. */
  function boxAt(cam, x, z, hM, wM) {
    const c = cams[cam]; if (!c) return null;
    const dx = x - c.pos[0], dz = z - c.pos[2], l = Math.hypot(dx, dz) || 1, px = -dz / l, pz = dx / l, hw = (wM || 1.8) / 2;
    const pts = [];
    for (const s of [-1, 1]) for (const y of [0, hM || 1.5]) { const p = pixel(cam, [x + s * hw * px, y, z + s * hw * pz]); if (!p) return null; pts.push(p); }
    const us = pts.map((p) => p.u), vs = pts.map((p) => p.v);
    const b = { x: Math.min(...us), y: Math.min(...vs), w: Math.max(...us) - Math.min(...us), h: Math.max(...vs) - Math.min(...vs) };
    const mid = pixel(cam, [x, (hM || 1.5) / 2, z]);
    return inside(mid, 0.01) && !isBody(cam, mid.u, mid.v) ? b : null;
  }

  /** When, where and how big an object followed on `fromCam` (keys: [[t, {x,y,w,h}], …], raw picture coords) comes into
   *  `toCam`: its feet on the road give where it is round the car; their last ~0.6 s give how it moves relative to the
   *  car (a parked car slides back as the car drives past). → { t, sigma, box, dist, speed, hM, wM } in fromCam's clip
   *  time (add clock(fromCam) − clock(toCam) for toCam's), or null when its feet can't be placed (far, cut off, sky). */
  function predictEntry(fromCam, keys, toCam, opt) {
    const o = Object.assign({ span: 0.6, horizon: 5, dt: 1 / 30 }, opt || {});
    if (!cams[fromCam] || !cams[toCam] || !keys || keys.length < 3) return null;
    const tEnd = keys[keys.length - 1][0], pts = [];
    for (const [t, b] of keys) { if (tEnd - t > o.span) continue; const f = footprint(fromCam, b, 40); if (f && f.dist > 1) pts.push([t, f]); }
    if (pts.length < 3 || pts[pts.length - 1][0] - pts[0][0] < 0.15) return null;
    // straight-line fit of x(t), z(t) (least squares), robust to one bad foot: the median of the heights and widths
    const n = pts.length, tm = pts.reduce((s, p) => s + p[0], 0) / n;
    let stt = 0, sx = 0, sz = 0, mx = 0, mz = 0;
    for (const [t, f] of pts) { mx += f.x / n; mz += f.z / n; }
    for (const [t, f] of pts) { const d = t - tm; stt += d * d; sx += d * (f.x - mx); sz += d * (f.z - mz); }
    if (!(stt > 0)) return null;
    const vx = sx / stt, vz = sz / stt, x0 = mx + vx * (tEnd - tm), z0 = mz + vz * (tEnd - tm);
    let res = 0; for (const [t, f] of pts) res += (f.x - (mx + vx * (t - tm))) ** 2 + (f.z - (mz + vz * (t - tm))) ** 2;
    res = Math.sqrt(res / n);
    const med = (a) => { const s = a.filter((v) => v > 0).sort((p, q) => p - q); return s.length ? s[s.length >> 1] : null; };
    const hM = Math.min(4, Math.max(0.8, med(pts.map((p) => p[1].hM)) || 1.5)), wM = Math.min(3, Math.max(0.4, med(pts.map((p) => p[1].wM)) || 1.8));
    for (let dt = 0; dt <= o.horizon + 1e-9; dt += o.dt) {
      const x = x0 + vx * dt, z = z0 + vz * dt, box = boxAt(toCam, x, z, hM, wM);
      if (box) {
        const dist = Math.hypot(x - cams[toCam].pos[0], z - cams[toCam].pos[2]);
        return { t: tEnd + dt, sigma: 0.15 + 0.3 * dt + Math.min(0.5, res / Math.max(0.5, Math.hypot(vx, vz))), box, dist, speed: Math.hypot(vx, vz), hM, wM, x, z };
      }
    }
    return null;
  }

  /** Offsets of the six files of a clip from their telemetry: rows = { cam: [[t, msg], …] } (js/sei.js parseClip rows).
   *  → { cam: seconds to add to that camera's clip time to get the reference camera's (front, else the first) }; a
   *  camera is left out when its telemetry is missing or the car hardly moved (nothing to match). */
  function clockOffsets(rows, opt) {
    const o = Object.assign({ range: 1.2, step: 1 / 240 }, opt || {});
    const ref = rows.front && rows.front.length ? "front" : CAMS.find((c) => rows[c] && rows[c].length);
    if (!ref) return {};
    const series = (r) => {
      const t = r.map((x) => x[0]), v = r.map((x) => x[1].speed || 0), h = [];
      let prev = null, acc = 0;
      for (const x of r) { const a = (x[1].heading || 0); if (prev != null) { let d = a - prev; while (d > 180) d -= 360; while (d < -180) d += 360; acc += d; } else acc = a; prev = a; h.push(acc); }
      return { t, v, h };
    };
    const interp = (ts, ys, t) => {
      if (t <= ts[0]) return ys[0]; if (t >= ts[ts.length - 1]) return ys[ys.length - 1];
      let lo = 0, hi = ts.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= t) lo = m; else hi = m; }
      const a = (t - ts[lo]) / (ts[hi] - ts[lo] || 1); return ys[lo] + a * (ys[hi] - ys[lo]);
    };
    const A = series(rows[ref]), out = { [ref]: 0 };
    const t0 = A.t[0] + o.range, t1 = A.t[A.t.length - 1] - o.range;
    if (!(t1 - t0 > 3)) return out;
    const grid = []; for (let t = t0; t <= t1; t += 0.05) grid.push(t);
    const va = grid.map((t) => interp(A.t, A.v, t)), ha = grid.map((t) => interp(A.t, A.h, t));
    const sd = (a) => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };
    if (sd(va) < 0.3 && sd(ha) < 1.5) return out;   // parked or crawling straight: nothing to line up
    for (const cam of CAMS) {
      if (cam === ref || !rows[cam] || rows[cam].length < 30) continue;
      const B = series(rows[cam]); let best = null;
      for (let off = -o.range; off <= o.range + 1e-9; off += o.step) {
        let e = 0;
        for (let i = 0; i < grid.length; i++) {
          const dv = va[i] - interp(B.t, B.v, grid[i] - off), dh = ha[i] - interp(B.t, B.h, grid[i] - off);
          e += dv * dv + 0.25 * dh * dh;
        }
        if (!best || e < best.e) best = { off, e };
      }
      out[cam] = +best.off.toFixed(4);
    }
    return out;
  }

  /** Which cameras see each direction round the car at road level (every 5°, 8 m out): the neighbours and their overlaps. */
  function coverage(dist) {
    const out = [];
    for (let b = -180; b < 180; b += 5) {
      const x = Math.sin(b * D2R) * (dist || 8), z = 1.4 + Math.cos(b * D2R) * (dist || 8), seen = [];
      for (const cam of CAMS) { const p = pixel(cam, [x, 0.7, z]); if (inside(p, 0) && !isBody(cam, p.u, p.v)) seen.push(cam); }
      out.push({ bearing: b, cams: seen });
    }
    return out;
  }

  /** Replace the rig (a JSON from tools/rig or js/rig-calib.js, a preset(), or { cams: … }); returns the cameras taken.
   *  Optional: j.body (body boxes, e.g. a preset's), j.preset (the model it starts from), j.source ("preset" | "calibrated"),
   *  per camera `delay` (seconds: its pictures' lag behind its own telemetry, added in clock()). reset() goes back to the
   *  measured Model X. */
  function set(j) {
    const src = (j && (j.cams || j)) || {}, took = [];
    for (const cam of CAMS) {
      const c = src[cam]; if (!c) continue;
      const nums = ["yaw", "pitch", "roll", "f", "cx", "cy"].every((k) => isFinite(+c[k])) && Array.isArray(c.k) && c.k.length >= 3;
      if (!nums || !(+c.f > 0.1 && +c.f < 3)) continue;
      cams[cam] = { yaw: +c.yaw, pitch: +c.pitch, roll: +c.roll, f: +c.f, cx: +c.cx, cy: +c.cy, k: c.k.slice(0, 3).map(Number),
        thmax: isFinite(+c.thmax) ? +c.thmax : MEASURED[cam].thmax,
        pos: Array.isArray(c.pos) && c.pos.length === 3 && c.pos.every((v) => isFinite(+v)) ? c.pos.map(Number) : MEASURED[cam].pos.slice(), px: c.px };
      if (isFinite(+c.delay) && Math.abs(+c.delay) < 0.5) cams[cam].delay = +c.delay;
      if (c.road && isFinite(+c.road.height)) cams[cam].pos[1] = +c.road.height;
      took.push(cam); delete R[cam]; delete bodyGrids[cam];
    }
    if (j && Array.isArray(j.body) && j.body.length && j.body.every((b) => b && ["x", "y0", "y1", "z0", "z1"].every((k) => isFinite(+b[k])))) {
      body = j.body.map((b) => ({ x: +b.x, y0: +b.y0, y1: +b.y1, z0: +b.z0, z1: +b.z1, not: Array.isArray(b.not) ? b.not.slice() : undefined }));
      for (const k of Object.keys(bodyGrids)) delete bodyGrids[k];
    }
    if (took.length && j && typeof j === "object") info = { preset: PRESETS[j.preset] ? j.preset : null, source: j.source || "custom", name: j.name || null };
    return took;
  }
  function reset() { cams = clone(MEASURED); body = BODY; info = { preset: "model_x", source: "measured" }; for (const k of Object.keys(R)) delete R[k]; for (const k of Object.keys(bodyGrids)) delete bodyGrids[k]; }
  /** What the rig in use is: { preset, source: "measured" | "preset" | "calibrated" | "custom", name }. */
  const current = () => Object.assign({}, info);
  const bodyBoxes = () => clone(body);
  const get = (cam) => cams[cam] || null;

  /* ── browser: per-clip clocks from the six files' own telemetry (read when first asked for, then kept) ── */
  function browser(T) {
    const RG = T.rig, cache = new Map();
    RG.clocks = {};   // the current clip's offsets (as last loaded); clock(cam) reads it
    /** Offsets for clip `i` of event `ev` (null while unknown); reads the six files' telemetry once. */
    RG.clocksFor = async (ev, i) => {
      const clip = ev && ev.clips && ev.clips[i]; if (!clip || !T.sei) return null;
      const key = clip; if (cache.has(key)) return (RG.clocks = cache.get(key));
      const rows = {};
      for (const cam of CAMS) {
        const e = clip.files && clip.files[cam]; if (!e || !e.blob || !e.info) continue;
        try { const r = await T.sei.parseClip(T.blobReader(e.blob), e.info, { yieldFn: T.yieldNow }); if (r && r.rows.length) rows[cam] = r.rows; } catch (_) {}
      }
      const off = clockOffsets(rows); cache.set(key, off); RG.clocks = off; return off;
    };
  }
  /** Seconds to add to `cam`'s clip time for the reference camera's clip time (0 while unknown). */
  function clock(cam, offs) {
    const o = offs || (this && this.clocks) || {}, ref = isFinite(o.front) ? "front" : Object.keys(o).find((k) => o[k] === 0);
    // a calibrated camera's pictures lag its own telemetry by `delay`: the same moment is that much later on its clip
    const d = (c) => (cams[c] && isFinite(cams[c].delay) ? cams[c].delay : 0);
    return (isFinite(o[cam]) ? o[cam] : 0) + (isFinite(o[cam]) && ref ? d(cam) - d(ref) : 0);
  }

  return { CAMS, MEASURED, CLOCK0, BODY, PRESETS, HEIGHT, ASPECT, rot, ok, ray, pixel, ground, bearing, isBody, bodyShare, footprint,
    sizeRatio, boxAt, predictEntry, clockOffsets, coverage, clock, set, reset, get, current, bodyBoxes, preset, closestPreset, browser };
});
