"""Seams between cameras, second pass (after fuse.py's road snap and ownership).

1. Road snap (as fuse.py).
2. Seam scale matching: where two cameras see the same off-road point, their depths should agree. Per time step the
   median log ratio of each overlapping pair gives one equation log s_j - log s_i = -m_ij; a least-squares solve (each
   scale pulled gently toward 1, the front camera's road fit is the most reliable so it is held more firmly) gives each
   camera's scale, smoothed over time (median of 5 steps), applied to its off-road depth only.
3. Soft ownership: a camera's weight falls from 1 to 0 as its score goes from the best camera's to 1.25x it, so
   overlapping cameras blend over a band instead of a hard cut. Weights go out as an 8-bit grid next to the depth.
Prints the seam disagreement (median |depth ratio - 1| of off-road overlap points) before and after.
usage: python -I fuse2.py <splat data dir> <depth out dir> <new out dir>
"""
import json, os, sys, shutil
import numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from roadgrow import grow

DATA, SRC, DST = sys.argv[1:4]
VB = json.load(open(sys.argv[4])) if len(sys.argv) > 4 else {}   # detector vehicle boxes per frame (boxes.js): no road grown inside
SNAP, BAND = 0.30, 1.12
GROW = os.environ.get("GROW", "1") == "1"; GROWN = [0]
ROADOWN = os.environ.get("ROADOWN", "1") == "1"
os.makedirs(DST, exist_ok=True)
d = json.load(open(os.path.join(SRC, "frames.json")))
cams = d["cams"]; by = {c: [f for f in d["frames"] if f["cam"] == c] for c in cams}; NC = len(cams)

def rays(f):
    W, H = f["w"], f["h"]; uu, vv = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    return np.stack([(uu - f["cx"]) / f["f"], (vv - f["cy"]) / f["f"], np.ones_like(uu)], -1)
def mask(f):
    p = os.path.join(DATA, "masks", f["name"].replace(".jpg", ".png"))
    return cv2.imread(p, cv2.IMREAD_GRAYSCALE) > 127 if os.path.exists(p) else np.ones((f["h"], f["w"]), bool)
RAYS = {c: rays(by[c][0]) for c in cams}

def load(k):
    out = []
    for c in cams:
        f = by[c][k]; Z = np.load(os.path.join(SRC, f["name"].replace(".jpg", ".npy"))); R, C = np.array(f["R"]), np.array(f["C"])
        v3 = RAYS[c]; wy = v3 @ R[1]
        with np.errstate(divide="ignore", invalid="ignore"): Zr = np.where(wy > 1e-4, -C[1] / wy, np.inf)
        y = C[1] + Z * wy
        snap = (Z > 0) & (np.abs(y) < SNAP) & (Zr < 80) & (Z / Zr > 0.6) & (Z / Zr < 1.6)
        if GROW:
            m = mask(f); veh = np.zeros_like(snap)
            for x0, y0, x1, y1 in VB.get(f["name"], []): veh[max(0, y0):max(0, y1), max(0, x0):max(0, x1)] = True
            g = grow(cv2.imread(os.path.join(DATA, "images", f["name"])), Z, Zr, snap, m & ~veh)
            GROWN[0] += int((g & ~snap).sum()); snap = g
        out.append(dict(f=f, R=R, C=C, Z=np.where(snap, Zr, Z), snap=snap, m=mask(f)))
    return out

def project(g, pts):
    q = (pts - g["C"]) @ g["R"]; z = q[:, 2]; good = z > 0.3; f = g["f"]
    zz = np.where(good, z, 1); u = f["cx"] + f["f"] * q[:, 0] / zz; v = f["cy"] + f["f"] * q[:, 1] / zz
    inside = good & (u >= 0) & (u < f["w"]) & (v >= 0) & (v < f["h"])
    ui, vi = np.clip(u.astype(int), 0, f["w"] - 1), np.clip(v.astype(int), 0, f["h"] - 1)
    inside &= g["m"][vi, ui]
    return inside, z, u, v, ui, vi

def points(g, sel):
    return g["C"] + (RAYS[g["f"]["cam"]][sel] * g["Z"][sel][:, None]) @ g["R"].T

def pair_ratios(row):
    """median log(depth_j / depth of i's point in j) per overlapping pair, off-road points only, and the spread."""
    eqs, dis = [], []
    for i, a in enumerate(row):
        sel = (a["Z"] > 0) & ~a["snap"]; sel[::2, :] = False; sel[:, ::2] = False   # every 4th pixel is plenty
        if sel.sum() < 50: continue
        P = points(a, sel)
        for j, b in enumerate(row):
            if j == i: continue
            inside, z, u, v, ui, vi = project(b, P)
            zj = b["Z"][vi, ui]; ok = inside & (zj > 0) & ~b["snap"][vi, ui]
            r = np.log(zj[ok] / z[ok]); r = r[np.abs(r) < np.log(1.6)]   # beyond that: an occlusion, not a scale
            if len(r) < 200: continue
            eqs.append((i, j, float(np.median(r)), len(r))); dis.append(np.abs(np.exp(r) - 1))
    return eqs, (np.median(np.concatenate(dis)) if dis else np.nan)

# pass 1: scales per step
steps = d["steps"]; S = np.ones((steps, NC)); before = []
for k in range(steps):
    row = load(k); eqs, dis = pair_ratios(row); before.append(dis)
    if not eqs: continue
    A, b, w = [], [], []
    for i, j, m, n in eqs:
        r = np.zeros(NC); r[j] = 1; r[i] = -1; A.append(r); b.append(-m); w.append(np.sqrt(n))
    for c in range(NC):
        r = np.zeros(NC); r[c] = 1; A.append(r); b.append(0); w.append(200.0 if cams[c] == "front" else 40.0)
    A, b, w = np.array(A), np.array(b), np.array(w)
    x, *_ = np.linalg.lstsq(A * w[:, None], b * w, rcond=None); S[k] = np.exp(x)
Ssm = np.ones((steps, NC))   # global per-camera scale measured no gain (12.2 % → 12.2 %): not applied
print("scale per camera (median over time):", {c: round(float(np.median(Ssm[:, i])), 3) for i, c in enumerate(cams)})

# pass 2: apply scales, soft ownership, write
after = []; SEAM = []
for k in range(steps):
    row = load(k)
    for i, a in enumerate(row): a["Z"] = np.where(a["snap"] | (a["Z"] <= 0), a["Z"], a["Z"] * Ssm[k, i])
    _, dis = pair_ratios(row); after.append(dis)
    for i, a in enumerate(row):
        f = a["f"]; ok = a["Z"] > 0; pts = points(a, ok); rd = a["snap"][ok]   # this camera's road points
        sc = np.full((NC, len(pts)), np.inf)
        for j, b in enumerate(row):
            inside, z, u, v, ui, vi = project(b, pts)
            if j != i:
                zj = b["Z"][vi, ui]; inside &= (zj > 0) & (zj >= 0.85 * z) & (zj <= 1.25 * z)
                if ROADOWN: inside &= ~rd | b["snap"][vi, ui]   # a road point is only taken by a camera that also has it as road
            r2 = ((u - b["f"]["cx"]) / (b["f"]["w"] / 2)) ** 2 + ((v - b["f"]["cy"]) / (b["f"]["h"] / 2)) ** 2
            s = np.linalg.norm(pts - b["C"], axis=1) / b["f"]["f"] * (1 + 0.5 * r2)
            sc[j] = np.where(inside, s, np.inf)
        own = np.where(np.isfinite(sc[i]), sc[i], np.linalg.norm(pts - a["C"], axis=1) / f["f"])
        best = np.minimum(sc.min(0), own)
        wgt = np.clip((BAND * best - own) / ((BAND - 1) * best), 0, 1)
        # in the band (0 < weight < 1) move this camera's point along its own ray onto the best other camera's surface
        sco = sc.copy(); sco[i] = np.inf; jb = sco.argmin(0); has = np.isfinite(sco.min(0)) & (wgt < 1) & (wgt > 0)
        znew = a["Z"][ok].copy()
        for j in range(NC):
            m = has & (jb == j)
            if not m.any(): continue
            b = row[j]; inside, z, u, v, ui, vi = project(b, pts[m]); zj = b["Z"][vi, ui]
            Pj = b["C"] + (RAYS[b["f"]["cam"]][vi, ui] * zj[:, None]) @ b["R"].T
            zi = ((Pj - a["C"]) @ a["R"])[:, 2]                      # that point's depth in this camera
            good = inside & (zj > 0) & (zi > 0.3) & (np.abs(np.log(np.maximum(zi, 1e-3) / znew[m])) < np.log(1.6))
            w_ = wgt[m]; zz = znew[m]; zz[good] = w_[good] * zz[good] + (1 - w_[good]) * zi[good]; znew[m] = zz
            SEAM.append(np.abs(zi[good] / a["Z"][ok][m][good] - 1))
        a["Z"][ok] = znew
        W = np.zeros(a["Z"].shape, np.float32); W[ok] = wgt
        Z = np.where(W > 0, a["Z"], 0).astype(np.float32)
        np.save(os.path.join(DST, f["name"].replace(".jpg", ".npy")), Z)
        gw = 160
        # mesh rows: every 2 px near the horizon (a camera 1 m up sees all road past 10 m within ~5 degrees of it), every 6 px elsewhere
        vh = f["cy"] + f["f"] * (-a["R"][1][2] / a["R"][1][1]) if abs(a["R"][1][1]) > 1e-6 else -1e9
        rows, v = [], 1.0
        while v < f["h"]:
            rows.append(v); v += 2.0 if vh - 30 <= v <= vh + 60 else 6.0
        ri = np.clip(np.array(rows).astype(int), 0, f["h"] - 1); ci = np.clip(((np.arange(gw) + 0.5) * f["w"] / gw).astype(int), 0, f["w"] - 1)
        Zg = np.where(Z > 0, Z, np.nan)[ri][:, ci]
        Wg = cv2.blur(W, (6, 3))[ri][:, ci]
        json.dump([round(float(r), 1) for r in rows], open(os.path.join(DST, f["name"].replace(".jpg", "_rows.json")), "w"))
        cv2.imwrite(os.path.join(DST, f["name"].replace(".jpg", ".png")), np.nan_to_num(np.clip(Zg * 100, 0, 65535)).astype(np.uint16))
        cv2.imwrite(os.path.join(DST, f["name"].replace(".jpg", "_w.png")), (np.clip(Wg, 0, 1) * 255).astype(np.uint8))
        shutil.copy(os.path.join(SRC, f["name"]), os.path.join(DST, f["name"]))
shutil.copy(os.path.join(SRC, "frames.json"), os.path.join(DST, "frames.json"))
print(f"in the blend bands, the two cameras' surfaces were {np.median(np.concatenate(SEAM)) * 100:.1f} % apart (median); now they meet")
print(f"seam disagreement, off-road overlap points: before {np.nanmedian(before) * 100:.1f} %   after scale matching {np.nanmedian(after) * 100:.1f} %")
print(f"road grown beyond the AI snap: {GROWN[0]} pixels")
