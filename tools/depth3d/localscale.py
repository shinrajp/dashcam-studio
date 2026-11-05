"""localscale.py — the AI depth scale refitted locally where two cameras overlap, so neighbours agree on the road there.

depth.py fits one disparity scale/shift per frame on the whole road. In an overlap band a camera's local scale can be off by tens of
percent (2026-10-19, right repeater at the right rear: its road read 1.2–1.45× the road plane), which pulls kerbs, cars and road
that the snap does not catch to the wrong place and makes the camera disagree with its neighbour.

For each overlapping pair the camera nearer the front of REF_ORDER is the reference (front, then pillars, then back, then
repeaters: the higher-resolution or less oblique view). The secondary camera's pixels whose road-plane point the reference sees
AS ROAD (its own AI depth within SNAP of the road plane there) are the fit points. The target is the reference's road point,
i.e. the ray-plane point; projected into the secondary camera that is exactly the secondary's own ray-plane depth at that pixel,
so the fit needs no reference depth sampling. Fit: 1/Z_true = α/Z_ai + β (affine in inverse depth, the form the model's
disparity takes), robust (6 rounds keeping the 60 % closest).
Guards (fall back to the frame's global fit, i.e. leave Z as is): at least MIN_PTS points; α in [A_MIN, A_MAX]; the fitted
relative error below MAX_REL and at least GAIN better than the global one; the corrected depth positive.
Blending: weight 1 on the overlap points (dilated), falling linearly to 0 over BLEND_FRAC of the picture width, so the
correction joins the global fit smoothly. Parameters (not tuned to any drive):
  MIN_PTS = 300 (sampled every 4 px), A_MIN, A_MAX = 0.5, 2.0 (the global fit is not more than 2× off locally, else something
  else is wrong), MAX_REL = 0.08 (depth.py's own acceptance for a road fit), GAIN = 0.01, BLEND_FRAC = 0.125, SNAP = fuse.SNAP.
"""
import numpy as np, cv2

REF_ORDER = ["front", "left_pillar", "right_pillar", "back", "left_repeater", "right_repeater"]
MIN_PTS, A_MIN, A_MAX, MAX_REL, GAIN, BLEND_FRAC, STEP = 300, 0.5, 2.0, 0.08, 0.01, 0.125, 4


def _proj(f, R, C, P):
    q = (P - C) @ R; z = q[:, 2]; zz = np.where(z > 0.3, z, 1)
    u = f["cx"] + f["f"] * q[:, 0] / zz; v = f["cy"] + f["f"] * q[:, 1] / zz
    return (z > 0.3) & (u >= 0) & (u < f["w"]) & (v >= 0) & (v < f["h"]), u.astype(int), v.astype(int)


def _robust(x, y):
    A = np.stack([x, np.ones_like(x)], 1); keep = np.ones(len(x), bool)
    for _ in range(6):
        p, *_ = np.linalg.lstsq(A[keep], y[keep], rcond=None); r = np.abs(A @ p - y); keep = r <= np.quantile(r, 0.6)
    return p, keep


def refit(cams, snap_tol, log=None):
    """cams: list of dict(cam, f, R, C, Z, Zr, wy, m). Changes Z in place; → {cam: dict(ok, why, alpha, beta, n, rel0, rel1)}."""
    by = {c["cam"]: c for c in cams}; out = {}
    for sec in cams:
        refs = [by[r] for r in REF_ORDER[:REF_ORDER.index(sec["cam"])] if r in by] if sec["cam"] in REF_ORDER else []
        f, Z, Zr = sec["f"], sec["Z"], sec["Zr"]; H, W = Z.shape
        vv, uu = np.mgrid[0:H:STEP, 0:W:STEP]; vv, uu = vv.ravel(), uu.ravel()
        cand = (Z[vv, uu] > 0) & np.isfinite(Zr[vv, uu]) & (Zr[vv, uu] > 1.5) & (Zr[vv, uu] < 35) & sec["m"][vv, uu]
        vv, uu = vv[cand], uu[cand]
        ray = np.stack([(uu + .5 - f["cx"]) / f["f"], (vv + .5 - f["cy"]) / f["f"], np.ones(len(uu))], 1)
        P = sec["C"] + (ray @ sec["R"].T) * Zr[vv, uu][:, None]                   # road-plane points
        seen = np.zeros(len(uu), bool)
        for ref in refs:
            ins, u2, v2 = _proj(ref["f"], ref["R"], ref["C"], P)
            u2, v2 = np.clip(u2, 0, ref["f"]["w"] - 1), np.clip(v2, 0, ref["f"]["h"] - 1)
            zr = ref["Z"][v2, u2]; y = ref["C"][1] + zr * ref["wy"][v2, u2]
            seen |= ins & ref["m"][v2, u2] & (zr > 0) & (np.abs(y) < snap_tol)
        res = dict(ok=False, n=int(seen.sum()), why="")
        if seen.sum() < MIN_PTS: res["why"] = f"{int(seen.sum())} overlap road points < {MIN_PTS}"; out[sec["cam"]] = res; continue
        x, yt = 1 / Z[vv[seen], uu[seen]], 1 / Zr[vv[seen], uu[seen]]
        (a, b), keep = _robust(x, yt)
        rel0 = float(np.median(np.abs(x[keep] / yt[keep] - 1))); rel1 = float(np.median(np.abs((a * x[keep] + b) / yt[keep] - 1)))
        res.update(alpha=round(float(a), 4), beta=round(float(b), 5), rel0=round(rel0, 4), rel1=round(rel1, 4))
        if not (A_MIN <= a <= A_MAX): res["why"] = f"alpha {a:.2f} outside [{A_MIN}, {A_MAX}]"
        elif rel1 > MAX_REL: res["why"] = f"fit error {rel1:.3f} > {MAX_REL}"
        elif rel0 - rel1 < GAIN: res["why"] = "no gain over the global fit"
        else:
            msk = np.zeros((H, W), np.uint8); msk[vv[seen], uu[seen]] = 255
            msk = cv2.dilate(msk, np.ones((2 * STEP + 1, 2 * STEP + 1), np.uint8))
            dist = cv2.distanceTransform(255 - msk, cv2.DIST_L2, 5); w = np.clip(1 - dist / (BLEND_FRAC * W), 0, 1)
            with np.errstate(divide="ignore", invalid="ignore"):
                inv = np.where(Z > 0, 1 / Z, 0); inv2 = (1 - w) * inv + w * (a * inv + b)
                Zn = np.where((Z > 0) & (inv2 > 1e-3), 1 / inv2, Z)
            Zn = np.where((Z > 0) & (Zn > 0), np.minimum(Zn, 70), Z); sec["Z"][...] = Zn.astype(Z.dtype); sec["ls_w"] = w; res["ok"] = True
        out[sec["cam"]] = res
    return out
