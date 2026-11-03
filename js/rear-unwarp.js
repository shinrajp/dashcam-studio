/* rear-unwarp.js — the rear camera without its fisheye, for the detector.
 *
 * The rear camera sees ~190° through a fisheye: a car close behind is bent round the picture's edge and the detector misses
 * it or scores it low (measured on the 2026-10-19 drive: a white car right behind, 54 % as recorded → 91 % unwarped;
 * tools/rig/unwarp.py makes the side-by-side picture). Here each rear frame is redrawn as a cylindrical panorama (equal
 * degrees across, uprights stay upright) from the measured lens in js/rig.js, the detector looks at that, and its boxes are
 * mapped back to the picture as recorded, so everything after the detector (tracker, hand-off, blur, export) is unchanged.
 * Zoomed second looks (crops round a known box) stay on the recorded picture.
 *
 * Only for a rear picture of the shape the rig was measured on (HW4, 1448×938); HW3 cars keep the plain picture.
 * Off with localStorage tdc.rearpano = "0" (Settings ▸ Object detection).
 * Pure parts (build, boxBack, sample) run in node: test/rear-unwarp.test.js. */
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else { const T = (root.TDC = root.TDC || {}); T.rearUnwarp = m; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const KEY = "tdc.rearpano";
  // 190° across (a little past the lens's measured 2 × 96.9° edge is cut off by the lens itself), centred 18° below level
  // (the camera looks 33° down; the far road and what stands on it sit higher than the picture's middle)
  const VIEW = { W: 1280, H: 480, hfov: 190, pitch: -18 };
  const D2R = Math.PI / 180;

  function on() { try { return localStorage.getItem(KEY) !== "0"; } catch (_) { return true; } }
  function setOn(v) { try { localStorage.setItem(KEY, v ? "1" : "0"); } catch (_) {} }

  /** Can the rig unwarp this rear picture? (a measured back camera, a picture of the measured shape) */
  function usable(rig, iw, ih) { return !!(rig && rig.get && rig.get("back") && rig.ok("back", iw, ih)); }

  /** Car-axes unit direction for panorama pixel (x, y) (pixel centres at +0.5). */
  function dirAt(rig, view, x, y, M) {
    const fc = (view.W / 2) / (view.hfov / 2 * D2R), phi = (x - view.W / 2) / fc, h = -(y - view.H / 2) / fc;
    const n = Math.hypot(Math.sin(phi), h, Math.cos(phi)), d = [Math.sin(phi) / n, h / n, Math.cos(phi) / n];
    M = M || rig.rot(180, view.pitch, 0);
    return [M[0][0] * d[0] + M[0][1] * d[1] + M[0][2] * d[2], M[1][0] * d[0] + M[1][1] * d[1] + M[1][2] * d[2], M[2][0] * d[0] + M[2][1] * d[1] + M[2][2] * d[2]];
  }

  /** The look-up table: for each panorama pixel, where it is in the recorded picture (u, v in 0..1; NaN where the lens
   *  doesn't see). Kept until the back camera's calibration changes. */
  let cached = null;
  function build(rig, view) {
    view = view || VIEW;
    const c = rig.get("back"), key = JSON.stringify([c, view]);
    if (cached && cached.key === key) return cached;
    const { W, H } = view, map = new Float32Array(W * H * 2), M = rig.rot(180, view.pitch, 0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const d = dirAt(rig, view, x + 0.5, y + 0.5, M), p = rig.pixel("back", [c.pos[0] + 10 * d[0], c.pos[1] + 10 * d[1], c.pos[2] + 10 * d[2]]);
      const i = 2 * (y * W + x);
      if (p && p.u >= 0 && p.u <= 1 && p.v >= 0 && p.v <= 1) { map[i] = p.u; map[i + 1] = p.v; } else { map[i] = NaN; map[i + 1] = NaN; }
    }
    cached = { key, view, W, H, map, plans: new Map() };
    return cached;
  }

  /** Per source size: the four source pixels and weights of every panorama pixel (bilinear), built once. */
  function plan(lut, iw, ih) {
    const k = iw + "x" + ih; let p = lut.plans.get(k); if (p) return p;
    const n = lut.W * lut.H, idx = new Int32Array(n), wx = new Uint8Array(n), wy = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const u = lut.map[2 * i], v = lut.map[2 * i + 1];
      if (!(u === u)) { idx[i] = -1; continue; }
      const sx = Math.min(iw - 1.001, Math.max(0, u * iw - 0.5)), sy = Math.min(ih - 1.001, Math.max(0, v * ih - 0.5));
      const x0 = sx | 0, y0 = sy | 0; idx[i] = y0 * iw + x0; wx[i] = Math.round((sx - x0) * 255); wy[i] = Math.round((sy - y0) * 255);
    }
    p = { idx, wx, wy }; lut.plans.set(k, p); return p;
  }

  /** Redraw an RGBA source (Uint8ClampedArray, iw × ih) into the panorama's RGBA (a dark grey where the lens doesn't see). */
  function sample(lut, src, iw, ih, out) {
    const { idx, wx, wy } = plan(lut, iw, ih), n = lut.W * lut.H, row = iw * 4;
    out = out || new Uint8ClampedArray(n * 4);
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const s = idx[i];
      if (s < 0) { out[o] = out[o + 1] = out[o + 2] = 30; out[o + 3] = 255; continue; }
      const a = s * 4, b = a + 4, c = a + row, d = c + 4, fx = wx[i], fy = wy[i], gx = 255 - fx, gy = 255 - fy;
      for (let ch = 0; ch < 3; ch++) out[o + ch] = ((src[a + ch] * gx + src[b + ch] * fx) * gy + (src[c + ch] * gx + src[d + ch] * fx) * fy) / 65025;
      out[o + 3] = 255;
    }
    return out;
  }

  /** A box found on the panorama (x, y, w, h in 0..1 of it) → the box round the same thing in the recorded picture
   *  (0..1), or null when most of it is where the lens doesn't see. Its outline is followed, not just its corners: straight
   *  edges in the panorama are curves in the fisheye. */
  function boxBack(lut, b) {
    const { W, H, map } = lut, N = 8; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, good = 0, all = 0;
    const at = (px, py) => {
      all++;
      const x = Math.max(0, Math.min(W - 1, Math.round(px * W - 0.5))), y = Math.max(0, Math.min(H - 1, Math.round(py * H - 0.5))), i = 2 * (y * W + x), u = map[i], v = map[i + 1];
      if (!(u === u)) return; good++;
      if (u < x0) x0 = u; if (u > x1) x1 = u; if (v < y0) y0 = v; if (v > y1) y1 = v;
    };
    for (let k = 0; k <= N; k++) { const f = k / N; at(b.x + f * b.w, b.y); at(b.x + f * b.w, b.y + b.h); at(b.x, b.y + f * b.h); at(b.x + b.w, b.y + f * b.h); }
    at(b.x + b.w / 2, b.y + b.h / 2);
    if (good < all / 2 || !(x1 > x0) || !(y1 > y0)) return null;
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(1, x1); y1 = Math.min(1, y1);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /* ── browser: a frame (video, bitmap or canvas) → the panorama on a canvas the detector can take ── */
  let srcCv = null, srcCx = null, outCv = null, outCx = null, outImg = null;
  const mk = (w, h) => (typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h }));
  /** → { img (canvas), iw, ih, lut, ms } */
  function frame(rig, img, iw, ih) {
    const t0 = (typeof performance !== "undefined" ? performance : Date).now(), lut = build(rig);
    if (!srcCv || srcCv.width !== iw || srcCv.height !== ih) { srcCv = mk(iw, ih); srcCx = srcCv.getContext("2d", { willReadFrequently: true }); }
    srcCx.drawImage(img, 0, 0, iw, ih);
    const src = srcCx.getImageData(0, 0, iw, ih).data;
    if (!outCv) { outCv = mk(lut.W, lut.H); outCx = outCv.getContext("2d"); outImg = outCx.createImageData(lut.W, lut.H); }
    sample(lut, src, iw, ih, outImg.data); outCx.putImageData(outImg, 0, 0);
    return { img: outCv, iw: lut.W, ih: lut.H, lut, ms: (typeof performance !== "undefined" ? performance : Date).now() - t0 };
  }
  /** Detector boxes on the panorama → boxes on the recorded picture (dropped where they can't be mapped). */
  function back(dets, fr) {
    const out = [];
    for (const d of dets) { const b = boxBack(fr.lut, d); if (b) out.push(Object.assign({}, d, b, { unwarped: true })); }
    return out;
  }

  return { VIEW, KEY, on, setOn, usable, dirAt, build, sample, boxBack, frame, back };
});
