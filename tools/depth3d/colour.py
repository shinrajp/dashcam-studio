"""colour.py — match the cameras' brightness and colour where they see the same road (the prototype's colour.py).

Road pixels are snapped to the true road plane (fuse.py), so a road point seen by two cameras is the same spot. Per pair the
median log ratio of their colours (per channel, linear light) gives log g_j - log g_i = m; a least-squares solve with the front
camera held at 1 (and every gain pulled gently toward 1) gives one gain per camera and channel for the whole stretch. The
textures (jpg) in <dir> are rewritten with the gains (gains.json next to them).
"""
import json, os
import numpy as np, cv2

lin = lambda im: (im.astype(np.float32) / 255) ** 2.2


def _load(d, data, f):
    Z = np.load(os.path.join(d, f["name"].replace(".jpg", ".npy")))
    im = cv2.resize(cv2.imread(os.path.join(data, "images", f["name"])), (f["w"], f["h"]))
    return dict(f=f, R=np.array(f["R"]), C=np.array(f["C"]), Z=Z, im=lin(im))


def _pairs(row, gains):
    eqs, diff = [], []
    for i, a in enumerate(row):
        f = a["f"]; uu, vv = np.meshgrid(np.arange(0, f["w"], 3) + 0.5, np.arange(0, f["h"], 3) + 0.5)
        Z = a["Z"][vv.astype(int), uu.astype(int)]; ok = Z > 0
        v3 = np.stack([(uu - f["cx"]) / f["f"], (vv - f["cy"]) / f["f"], np.ones_like(uu)], -1)[ok]
        P = a["C"] + (v3 * Z[ok][:, None]) @ a["R"].T
        road = np.abs(P[:, 1]) < 0.05
        P = P[road]; ca = a["im"][vv.astype(int)[ok][road], uu.astype(int)[ok][road]] * gains[i]
        for j, b in enumerate(row):
            if j == i: continue
            q = (P - b["C"]) @ b["R"]; z = q[:, 2]; g = b["f"]
            zz = np.where(z > 0.3, z, 1); u = g["cx"] + g["f"] * q[:, 0] / zz; v = g["cy"] + g["f"] * q[:, 1] / zz
            ins = (z > 0.3) & (u >= 2) & (u < g["w"] - 2) & (v >= 2) & (v < g["h"] - 2)
            if ins.sum() < 300: continue
            ui, vi = u[ins].astype(int), v[ins].astype(int)
            seen = b["Z"][vi, ui] > 0
            if seen.sum() < 300: continue
            cb = b["im"][vi[seen], ui[seen]] * gains[j]; cA = ca[ins][seen]
            okc = (cA.min(1) > 0.01) & (cb.min(1) > 0.01) & (cA.max(1) < 0.95) & (cb.max(1) < 0.95)
            if okc.sum() < 300: continue
            m = np.median(np.log(cb[okc] / cA[okc]), 0)
            eqs.append((i, j, m, int(okc.sum()))); diff.append(np.abs(cb[okc] / cA[okc] - 1).mean(1))
    return eqs, (np.median(np.concatenate(diff)) if diff else np.nan)


def run(d_dir, data, log=print):
    d = json.load(open(os.path.join(d_dir, "frames.json"))); cams = d["cams"]; NC = len(cams)
    by = {c: [f for f in d["frames"] if f["cam"] == c] for c in cams}
    ks = range(0, d["steps"], 4)
    G = np.ones((NC, 3)); allq, before = [], []
    for k in ks:
        row = [_load(d_dir, data, by[c][k]) for c in cams]; eqs, df = _pairs(row, G); before.append(df); allq += eqs
    A, B, w = [], [], []
    for i, j, m, n in allq:
        r = np.zeros(NC); r[j] = 1; r[i] = -1; A.append(r); B.append(-m); w.append(np.sqrt(n))
    for c in range(NC):
        r = np.zeros(NC); r[c] = 1; A.append(r); B.append(np.zeros(3)); w.append(500.0 if cams[c] == "front" else 30.0)
    A, B, w = np.array(A), np.array(B), np.array(w)
    x, *_ = np.linalg.lstsq(A * w[:, None], B * w[:, None], rcond=None); G = np.exp(x)
    after = []
    for k in ks:
        row = [_load(d_dir, data, by[c][k]) for c in cams]; _, df = _pairs(row, G); after.append(df)
    log("  gains (B, G, R): " + str({c: [round(float(v), 3) for v in G[i]] for i, c in enumerate(cams)}))
    nb, na = (np.nanmedian(before) * 100, np.nanmedian(after) * 100) if np.isfinite(before).any() else (float("nan"),) * 2
    log(f"  colour difference on shared road: before {nb:.1f} %  after {na:.1f} %" + ("" if allq else "  (no shared road found: gains left at 1)"))
    for i, c in enumerate(cams):
        for f in by[c]:
            p = os.path.join(d_dir, f["name"]); im = lin(cv2.imread(p)) * G[i]
            cv2.imwrite(p, (np.clip(im, 0, 1) ** (1 / 2.2) * 255).round().astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 82])
    json.dump({c: G[i].tolist() for i, c in enumerate(cams)}, open(os.path.join(d_dir, "gains.json"), "w"))
    return dict(gains={c: G[i].tolist() for i, c in enumerate(cams)}, before_pct=nb, after_pct=na, pairs=len(allq))
