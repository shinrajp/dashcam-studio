"""Match the six cameras' brightness and colour where they see the same road.

Road pixels are snapped to the true road plane (fuse2.py), so a road point seen by two cameras is the same spot. Per pair
the median log ratio of their colours (per channel, linear light) gives log g_j - log g_i = m; a least-squares solve with
the front camera held at 1 (and every gain pulled gently toward 1) gives one gain per camera and channel for the whole
stretch. The textures (jpg) in <dir> are rewritten with the gains; prints the colour difference at overlaps before/after.
usage: python -I colour.py <dir from fuse2.py> <splat data dir>
"""
import json, os, sys
import numpy as np, cv2
DIR, DATA = sys.argv[1:3]
d = json.load(open(os.path.join(DIR, "frames.json"))); cams = d["cams"]; NC = len(cams)
by = {c: [f for f in d["frames"] if f["cam"] == c] for c in cams}
lin = lambda im: (im.astype(np.float32) / 255) ** 2.2

def load(f):
    Z = np.load(os.path.join(DIR, f["name"].replace(".jpg", ".npy")))
    im = cv2.resize(cv2.imread(os.path.join(DATA, "images", f["name"])), (f["w"], f["h"]))
    return dict(f=f, R=np.array(f["R"]), C=np.array(f["C"]), Z=Z, im=lin(im))

def pairs(row, gains):
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
            seen = b["Z"][vi, ui] > 0                                   # that camera keeps the point too (same surface)
            if seen.sum() < 300: continue
            cb = b["im"][vi[seen], ui[seen]] * gains[j]; cA = ca[ins][seen]
            okc = (cA.min(1) > 0.01) & (cb.min(1) > 0.01) & (cA.max(1) < 0.95) & (cb.max(1) < 0.95)
            if okc.sum() < 300: continue
            m = np.median(np.log(cb[okc] / cA[okc]), 0)                # per channel
            eqs.append((i, j, m, int(okc.sum()))); diff.append(np.abs(np.exp(np.log(cb[okc] / cA[okc])) - 1).mean(1))
    return eqs, (np.median(np.concatenate(diff)) if diff else np.nan)

ks = range(0, d["steps"], 4)
G = np.ones((NC, 3)); allq = []
before = []
for k in ks:
    row = [load(by[c][k]) for c in cams]; eqs, df = pairs(row, G); before.append(df); allq += eqs
A, w = [], []; B = []
for i, j, m, n in allq:
    r = np.zeros(NC); r[j] = 1; r[i] = -1; A.append(r); B.append(-m); w.append(np.sqrt(n))
for c in range(NC):
    r = np.zeros(NC); r[c] = 1; A.append(r); B.append(np.zeros(3)); w.append(500.0 if cams[c] == "front" else 30.0)
A, B, w = np.array(A), np.array(B), np.array(w)
x, *_ = np.linalg.lstsq(A * w[:, None], B * w[:, None], rcond=None); G = np.exp(x)
after = []
for k in ks:
    row = [load(by[c][k]) for c in cams]; _, df = pairs(row, G); after.append(df)
print("gains (B, G, R):", {c: [round(float(v), 3) for v in G[i]] for i, c in enumerate(cams)})
print(f"colour difference on shared road: before {np.nanmedian(before) * 100:.1f} %  after {np.nanmedian(after) * 100:.1f} %")
for i, c in enumerate(cams):
    for f in by[c]:
        p = os.path.join(DIR, f["name"]); im = lin(cv2.imread(p)) * G[i]
        cv2.imwrite(p, (np.clip(im, 0, 1) ** (1 / 2.2) * 255).round().astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 82])
json.dump({c: G[i].tolist() for i, c in enumerate(cams)}, open(os.path.join(DIR, "gains.json"), "w"))
