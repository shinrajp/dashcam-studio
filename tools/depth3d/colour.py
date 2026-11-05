"""colour.py — match the cameras' brightness and colour where they see the same road (the prototype's colour.py).

Road pixels are snapped to the true road plane (fuse.py), so a road point seen by two cameras is the same spot. Per pair the
median log ratio of their colours (per channel, linear light) gives log g_j - log g_i = m; a least-squares solve with the front
camera held at 1 (and every gain pulled gently toward 1) gives one gain per camera and channel for the whole stretch. The
textures (jpg) in <dir> are rewritten with the gains (gains.json next to them).

Road only (default; --no-road-colour turns it off): a pair's pixel counts only if it is road for BOTH cameras (each camera's
own fused point within ROAD_Y of the road plane), the two cameras' depths agree there (|Z_b − z_b| < DEPTH_TOL · z_b, z_b
the reference point's depth in camera b) and neither pixel is in a vehicle box. A kerb, a car or a wall that one camera puts
on the road and the other does not is left out of the fit. The reported "eval" colour difference always uses this strict
pixel set, so builds with and without it are compared on the same pixels.

Global match (global_match=True, after wb.py's neutral white balance): the same pair equations, but no camera is held at 1:
every gain is pulled toward 1 equally and their geometric mean is fixed at 1, so the solve only fixes residuals between
cameras and does not undo the neutral balance.
"""
import json, os
import numpy as np, cv2

ROAD_Y, DEPTH_TOL = 0.05, 0.05
lin = lambda im: (im.astype(np.float32) / 255) ** 2.2


def _load(d, data, f, vboxes=None):
    veh = np.zeros((f["h"], f["w"]), bool)
    for x0, y0, x1, y1 in (vboxes or {}).get(f["name"], []): veh[max(0, y0):max(0, y1), max(0, x0):max(0, x1)] = True
    Z = np.load(os.path.join(d, f["name"].replace(".jpg", ".npy")))
    im = cv2.resize(cv2.imread(os.path.join(data, "images", f["name"])), (f["w"], f["h"]))
    return dict(f=f, R=np.array(f["R"]), C=np.array(f["C"]), Z=Z, im=lin(im), veh=veh)


def _pairs(row, gains, strict=True):
    eqs, diff = [], []
    for i, a in enumerate(row):
        f = a["f"]; uu, vv = np.meshgrid(np.arange(0, f["w"], 3) + 0.5, np.arange(0, f["h"], 3) + 0.5)
        Z = a["Z"][vv.astype(int), uu.astype(int)]; ok = Z > 0
        v3 = np.stack([(uu - f["cx"]) / f["f"], (vv - f["cy"]) / f["f"], np.ones_like(uu)], -1)[ok]
        P = a["C"] + (v3 * Z[ok][:, None]) @ a["R"].T
        road = np.abs(P[:, 1]) < ROAD_Y
        if strict: road &= ~a["veh"][vv.astype(int)[ok], uu.astype(int)[ok]]
        P = P[road]; ca = a["im"][vv.astype(int)[ok][road], uu.astype(int)[ok][road]] * gains[i]
        for j, b in enumerate(row):
            if j == i: continue
            q = (P - b["C"]) @ b["R"]; z = q[:, 2]; g = b["f"]
            zz = np.where(z > 0.3, z, 1); u = g["cx"] + g["f"] * q[:, 0] / zz; v = g["cy"] + g["f"] * q[:, 1] / zz
            ins = (z > 0.3) & (u >= 2) & (u < g["w"] - 2) & (v >= 2) & (v < g["h"] - 2)
            if ins.sum() < 300: continue
            ui, vi = u[ins].astype(int), v[ins].astype(int)
            seen = b["Z"][vi, ui] > 0
            if strict:
                Zb = b["Z"][vi, ui]; g3 = np.stack([(ui + .5 - g["cx"]) / g["f"], (vi + .5 - g["cy"]) / g["f"], np.ones(len(ui))], -1)
                yb = b["C"][1] + (g3 @ b["R"].T)[:, 1] * Zb
                seen &= (np.abs(Zb - z[ins]) < DEPTH_TOL * z[ins]) & (np.abs(yb) < ROAD_Y) & ~b["veh"][vi, ui]
            if seen.sum() < 300: continue
            cb = b["im"][vi[seen], ui[seen]] * gains[j]; cA = ca[ins][seen]
            okc = (cA.min(1) > 0.01) & (cb.min(1) > 0.01) & (cA.max(1) < 0.95) & (cb.max(1) < 0.95)
            if okc.sum() < 300: continue
            m = np.median(np.log(cb[okc] / cA[okc]), 0)
            eqs.append((i, j, m, int(okc.sum()))); diff.append(np.abs(cb[okc] / cA[okc] - 1).mean(1))
    return eqs, (np.median(np.concatenate(diff)) if diff else np.nan)


def solve_gains(allq, cams, global_match=False):
    """pair equations (i, j, m, n): log g_j - log g_i = -m → one gain per camera and channel (least squares)."""
    NC = len(cams); A, B, w = [], [], []
    for i, j, m, n in allq:
        r = np.zeros(NC); r[j] = 1; r[i] = -1; A.append(r); B.append(-np.asarray(m)); w.append(np.sqrt(n))
    for c in range(NC):
        r = np.zeros(NC); r[c] = 1; A.append(r); B.append(np.zeros(3)); w.append(30.0 if global_match else (500.0 if cams[c] == "front" else 30.0))
    if global_match:                                   # no reference camera: the gains' geometric mean is held at 1
        A.append(np.ones(NC)); B.append(np.zeros(3)); w.append(300.0)
    A, B, w = np.array(A), np.array(B), np.array(w)
    x, *_ = np.linalg.lstsq(A * w[:, None], B * w[:, None], rcond=None); return np.exp(x)


def run(d_dir, data, log=print, road_only=True, vboxes=None, global_match=False, match=True):
    d = json.load(open(os.path.join(d_dir, "frames.json"))); cams = d["cams"]; NC = len(cams)
    by = {c: [f for f in d["frames"] if f["cam"] == c] for c in cams}
    ks = range(0, d["steps"], 4)
    G = np.ones((NC, 3)); allq, before, ev0 = [], [], []
    for k in ks:
        row = [_load(d_dir, data, by[c][k], vboxes) for c in cams]; eqs, df = _pairs(row, G, road_only); before.append(df); allq += eqs
        ev0.append(_pairs(row, G, True)[1])
    G = solve_gains(allq, cams, global_match) if match else np.ones((NC, 3))
    after, ev1 = [], []
    for k in ks:
        row = [_load(d_dir, data, by[c][k], vboxes) for c in cams]; _, df = _pairs(row, G, road_only); after.append(df)
        ev1.append(_pairs(row, G, True)[1])
    e0, e1 = np.nanmedian(ev0) * 100, np.nanmedian(ev1) * 100
    log("  gains (B, G, R): " + str({c: [round(float(v), 3) for v in G[i]] for i, c in enumerate(cams)}))
    nb, na = (np.nanmedian(before) * 100, np.nanmedian(after) * 100) if np.isfinite(before).any() else (float("nan"),) * 2
    log(f"  colour difference on shared road: before {nb:.1f} %  after {na:.1f} %" + ("" if allq else "  (no shared road found: gains left at 1)"))
    for i, c in enumerate(cams):
        for f in by[c]:
            p = os.path.join(d_dir, f["name"]); im = lin(cv2.imread(p)) * G[i]
            cv2.imwrite(p, (np.clip(im, 0, 1) ** (1 / 2.2) * 255).round().astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 82])
    json.dump({c: G[i].tolist() for i, c in enumerate(cams)}, open(os.path.join(d_dir, "gains.json"), "w"))
    log(f"  colour difference on strict shared road (road for both, depth agrees, no vehicles): before {e0:.1f} %  after {e1:.1f} %")
    return dict(gains={c: G[i].tolist() for i, c in enumerate(cams)}, before_pct=nb, after_pct=na, eval_before_pct=e0, eval_after_pct=e1,
                pairs=len(allq), road_only=road_only)
