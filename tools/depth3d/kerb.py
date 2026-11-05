"""kerb.py — kerbs and other low steps at the road edge kept as raised edges, from geometry only (no colour, no paint).

Why: fuse.py snaps every point within SNAP (0.30 m) of the road plane onto it. A kerb is 0.08–0.25 m high, so its face and top
were flattened onto the road and pushed outward along each camera's ray (a ray that really meets a 15 cm kerb top meets the
road plane further away), and each camera pushed it by a different amount, so neighbouring cameras drew it in two places.

How (per camera frame, per image column, scanning from the bottom of the picture outwards):
  * The road rows are recognised by the shape of the AI depth, not its scale: along a column, depth grows with the road's
    ray-plane depth Zr at a steady ratio r = dZ/dv ÷ dZr/dv (r ≈ the camera's local depth scale, whatever it is).
  * A vertical face is where depth stops growing while Zr keeps growing: r < R_FACE over at least MIN_FACE_PX rows, with
    at least ROAD_PX road-like rows (R_ROAD_LO ≤ r ≤ R_ROAD_HI) directly below it.
  * The face's height is computed from the rig alone: its foot is on the road (ray-plane point → horizontal distance d), the
    face is vertical at d, and the rays of its top and foot rows meet that vertical plane HEIGHT apart. Only H_MIN–H_MAX
    counts as a kerb; taller faces are cars, walls, posts. The AI depth's scale never enters the height or the distance.
    The height is the peak of the cumulative depth deficit up the face; a column counts only if that deficit actually
    peaks (falls back by DROP) within H_MAX + 0.1 m: a face still rising at the end of the scan is a taller step (a wall).
  * Along-edge check: a kerb is a line, so a column's step counts only if EDGE_MIN of the EDGE_WIN sampled columns on
    either side found a step at a similar distance (± EDGE_DREL) and height (± EDGE_DH). Isolated hits (noise, a tyre
    edge) are dropped.
  * Placement: face rows go onto the vertical plane at d; rows above the face go onto a raised plane at the neighbourhood's
    median height, outward for up to TOP_W of ground. Those pixels are excluded from road snap.
Parameters come from physical ranges, not from any one drive:
  H_MIN, H_MAX = 0.08, 0.25 m   kerb/step heights (road design guides: typical barrier and mountable kerbs 0.10–0.20 m;
                                 below 0.08 m a step is within the depth model's own noise, above 0.25 m it is not a kerb)
  MAX_D = 12 m                  at f ≈ 570 px (pillar/repeater views) an 8 cm face 12 m away is ~4 px tall: the resolution limit
  MIN_FACE_PX = 3               rows of a face, so a face is more than one or two rows of depth noise
  ROAD_PX = 6                   road rows below a face (a step stands on the road)
  R_FACE = 0.35                 a face's depth grows < 35 % of the road's rate (a vertical face: 0; road at any scale k: ≈ k ≥ 0.5)
  R_ROAD_LO, R_ROAD_HI = 0.4, 2.5   road rows' ratio RELATIVE to the column's median ratio kc (so any global depth scale
                                 works): 0.4–2.5× kc is road-like
  K_MIN, K_MAX = 0.3, 4.0       accepted local depth scale of a column (the AI's per-image scale is fitted to the road)
  BLUR_PX = 6                   the depth model smears a face over a few px (its 518 px input is ~2× coarser than the view)
  DROP = 0.03 m                 the deficit's fall-back that marks the top of the face
  EDGE_WIN, EDGE_MIN = 8, 5     a kerb seen in ≥ 5 of 16 neighbouring sampled columns (COL_STEP px apart)
  EDGE_DREL, EDGE_DH = 0.15, 0.06
  TOP_W = 1.5 m                 kerb top / footway placed on the raised plane up to 1.5 m beyond the face (a minimum footway width)
  COL_STEP = 2 px
Colour is not used.
"""
import numpy as np

H_MIN, H_MAX, MAX_D = 0.08, 0.25, 12.0
MIN_FACE_PX, ROAD_PX, R_FACE, R_ROAD_LO, R_ROAD_HI = 3, 6, 0.35, 0.4, 2.5
K_MIN, K_MAX = 0.3, 4.0
EDGE_WIN, EDGE_MIN, EDGE_DREL, EDGE_DH = 8, 5, 0.15, 0.06
TOP_W, COL_STEP, DROP, BLUR_PX = 1.5, 2, 0.03, 6


def _dirs(f, R):
    W, H = f["w"], f["h"]; uu, vv = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    return np.stack([(uu - f["cx"]) / f["f"], (vv - f["cy"]) / f["f"], np.ones_like(uu)], -1) @ R.T   # world ray per pixel, cam z = 1


def _smooth_col(z):
    out = z.copy(); out[2:-2] = np.median(np.stack([z[:-4], z[1:-3], z[2:-2], z[3:-1], z[4:]]), 0); return out


def _face_rows(f, R, C, u, va, d, h):
    """image rows a vertical face h high spans, foot at row va and horizontal distance d, in column u."""
    ray = np.array([(u + .5 - f["cx"]) / f["f"], (va + .5 - f["cy"]) / f["f"], 1.0]) @ R.T
    hn = np.hypot(ray[0], ray[2]); P = C + ray * (d / hn); P[1] -= h
    q = (P - C) @ R
    return max(0.0, va + .5 - (f["cy"] + f["f"] * q[1] / q[2])) if q[2] > 0 else 0.0


def detect(f, Z, R, C, valid=None):
    """→ (band mask, Z for the band (0 elsewhere), list of (col, foot row, top row, d, h) kept). Z: the AI depth (camera z)."""
    H, W = Z.shape; dw = _dirs(f, R); wy = dw[..., 1]; hn = np.hypot(dw[..., 0], dw[..., 2])
    with np.errstate(divide="ignore", invalid="ignore"): Zr = np.where(wy > 1e-4, -C[1] / wy, np.inf)
    ok = (Z > 0) & np.isfinite(Zr) & (Zr * hn < MAX_D * 1.6)
    if valid is not None: ok &= valid
    hits = []
    Hc = -C[1]
    for u in range(0, W, COL_STEP):
        z, zr, good = _smooth_col(Z[:, u].astype(np.float64)), Zr[:, u], ok[:, u]
        dz = np.full(H, np.nan); dzr = np.full(H, np.nan)
        with np.errstate(invalid="ignore"): dz[4:-4] = z[:-8] - z[8:]; dzr[4:-4] = zr[:-8] - zr[8:]   # growth going up (outwards)
        with np.errstate(divide="ignore", invalid="ignore"): r = np.where(good & (dzr > 0) & np.isfinite(dzr), dz / dzr, np.nan)
        if not np.isfinite(r).any(): continue
        kc = float(np.nanmedian(r))                     # the column's depth-growth ratio (mostly road): road rows are judged against it
        if not (K_MIN <= kc <= K_MAX): continue
        v = H - 5; road = 0
        while v > 2:
            if not np.isfinite(r[v]): road = 0; v -= 1; continue
            if road >= ROAD_PX:
                k = float(np.median(r[v + 1:v + 1 + min(road, 16)]))          # this column's local depth scale on the road
                if r[v] < R_FACE * k:
                    va = v + 1; d = zr[va] * hn[va, u]
                    if d > MAX_D: break
                    # a vertical face of H_MAX at d spans rows va..vmax (plus the model's blur): look for the top only there
                    vmin = va - int(np.ceil(_face_rows(f, R, C, u, va, d, H_MAX))) - BLUR_PX
                    vscan = va - int(np.ceil(_face_rows(f, R, C, u, va, d, H_MAX + 0.15))) - 2 * BLUR_PX   # look past it: a taller step keeps rising
                    best, vb, w = -1.0, va, va - 1
                    while w > max(0, vscan) and good[w] and wy[w, u] > 1e-4:
                        h = Hc * (1 - (zr[va] + (z[w] - z[va]) / k) / zr[w])         # height deficit: see the docstring
                        if h > best: best, vb = h, w
                        if h < best - DROP or best > H_MAX + 0.1: break
                        w -= 1
                    dip = r[vb:va]; dip = dip[np.isfinite(dip)]
                    if H_MIN <= best <= H_MAX and vb >= vmin and va - vb >= MIN_FACE_PX and len(dip) and np.median(dip) < R_FACE * k:
                        hits.append((u, va, vb, d, best))
                    break                                                  # the first step up from the car decides this column
            if R_ROAD_LO * kc <= r[v] <= R_ROAD_HI * kc: road += 1
            else: road = 0
            v -= 1
    kept = []
    if hits:
        A = np.array(hits, float)
        for i, (u, vf, vt, d, h) in enumerate(hits):
            near = (np.abs(A[:, 0] - u) <= EDGE_WIN * COL_STEP) & (A[:, 0] != u)
            sim = near & (np.abs(A[:, 3] - d) <= EDGE_DREL * d) & (np.abs(A[:, 4] - h) <= EDGE_DH)
            if sim.sum() >= EDGE_MIN: kept.append((u, vf, vt, d, float(np.median(np.r_[A[sim, 4], h]))))
    band = np.zeros((H, W), bool); Zk = np.zeros((H, W), np.float32)
    for u, vf, vt, d, h in kept:
        for uc in range(u, min(W, u + COL_STEP)):
            for v in range(int(vt), int(vf) + 1):                  # face: vertical plane at d
                if ok[v, uc]: band[v, uc] = True; Zk[v, uc] = d / hn[v, uc]
            v = int(vt) - 1
            while v >= 0 and ok[v, uc] and wy[v, uc] > 1e-4:     # top: raised plane y = -h, up to TOP_W beyond the face
                zt = (-h - C[1]) / wy[v, uc]
                if zt <= 0 or zt * hn[v, uc] > d + TOP_W: break
                band[v, uc] = True; Zk[v, uc] = zt; v -= 1
    return band, Zk, kept
