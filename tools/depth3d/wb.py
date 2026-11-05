"""wb.py — per-camera white balance before depth and fuse: one fixed von Kries gain per camera and channel (linear RGB),
fitted over the whole drive, relative to a reference camera (the front), not to neutral grey.

Which pixels: before depth exists the only geometry we can trust is the road plane, so a pixel of camera a whose ray meets the
road within MAX_D is projected into camera b; both rays must hit the road plane at the same point (true by construction) and
both pixels must be usable: inside the camera's body mask, outside every vehicle box (moving objects), below the horizon (no
sky), not clipped (each channel in CLIP_LO–CLIP_HI). Pixels that are not road (kerbs, parked cars missed by the detector,
walls) do not agree in colour and are outliers: the per-pair estimate is the MEDIAN log ratio per channel, and the camera
gains come from an iteratively reweighted (Huber, IRLS) least-squares solve over all pairs and steps, with the reference
held at 1 and every gain pulled gently toward 1. Gains are clamped to GAIN_LO–GAIN_HI per channel. One gain per camera for
the whole drive: no per-frame flicker.
Parameters (physical): MAX_D = 15 m (road texture still a few px per 5 cm), CLIP 0.01–0.95 (linear), GAIN 0.7–1.4 (a white
balance error larger than ±40 % per channel is a fault, not a cast), STEP 4 (every 4th time step), PX 3 (pixel stride).
"""
import json, os
import numpy as np, cv2

REF, MAX_D, CLIP_LO, CLIP_HI, GAIN_LO, GAIN_HI, STEP, PX, MIN_PTS, HUBER = "front", 15.0, 0.01, 0.95, 0.7, 1.4, 4, 3, 300, 0.05
lin = lambda im: (im.astype(np.float32) / 255) ** 2.2
unlin = lambda x: (np.clip(x, 0, 1) ** (1 / 2.2) * 255).round().astype(np.uint8)


def _valid(v):
    m = v["m"].copy()
    for x0, y0, x1, y1 in v.get("boxes", []): m[max(0, y0):max(0, y1), max(0, x0):max(0, x1)] = False
    return m


def pair_ratios(a, b):
    """median log(b / a) per channel over road-plane pixels both cameras see (None if too few)."""
    f = a["f"]; uu, vv = np.meshgrid(np.arange(0, f["w"], PX) + 0.5, np.arange(0, f["h"], PX) + 0.5)
    ui, vi = uu.astype(int), vv.astype(int); ok = _valid(a)[vi, ui]
    d = np.stack([(uu - f["cx"]) / f["f"], (vv - f["cy"]) / f["f"], np.ones_like(uu)], -1) @ a["R"].T
    ok &= d[..., 1] > 1e-3; s = np.where(ok, -a["C"][1] / np.where(ok, d[..., 1], 1), 0)
    P = a["C"] + d * s[..., None]; ok &= np.hypot(P[..., 0] - a["C"][0], P[..., 2] - a["C"][2]) < MAX_D
    P, ua, va = P[ok], ui[ok], vi[ok]
    g = b["f"]; q = (P - b["C"]) @ b["R"]; z = q[:, 2]; zz = np.where(z > 0.3, z, 1)
    u = g["cx"] + g["f"] * q[:, 0] / zz; v = g["cy"] + g["f"] * q[:, 1] / zz
    ins = (z > 0.3) & (u >= 1) & (u < g["w"] - 1) & (v >= 1) & (v < g["h"] - 1)
    if ins.sum() < MIN_PTS: return None
    ub, vb = u[ins].astype(int), v[ins].astype(int); okb = _valid(b)[vb, ub]
    ca = a["im"][va[ins][okb], ua[ins][okb]]; cb = b["im"][vb[okb], ub[okb]]
    good = (ca.min(1) > CLIP_LO) & (cb.min(1) > CLIP_LO) & (ca.max(1) < CLIP_HI) & (cb.max(1) < CLIP_HI)
    if good.sum() < MIN_PTS: return None
    return np.median(np.log(cb[good] / ca[good]), 0), int(good.sum())


def solve(eqs, cams, ref=REF):
    """eqs: [(i, j, m(3), n)]: log g_j - log g_i = -m. IRLS (Huber) least squares, ref held at 1, gentle prior to 1, clamped."""
    NC = len(cams); A, B, w0 = [], [], []
    for i, j, m, n in eqs:
        r = np.zeros(NC); r[j] = 1; r[i] = -1; A.append(r); B.append(-np.asarray(m)); w0.append(np.sqrt(n))
    for c in range(NC):
        r = np.zeros(NC); r[c] = 1; A.append(r); B.append(np.zeros(3)); w0.append(1e4 if cams[c] == ref else 3.0)
    A, B, w0 = np.array(A), np.array(B), np.array(w0); x = np.zeros((NC, 3))
    for _ in range(8):
        res = np.abs(A @ x - B).max(1); w = w0 * np.where(res > HUBER, HUBER / np.maximum(res, 1e-9), 1)
        x, *_ = np.linalg.lstsq(A * w[:, None], B * w[:, None], rcond=None)
    G = np.exp(x); clamped = (G < GAIN_LO) | (G > GAIN_HI)
    return np.clip(G, GAIN_LO, GAIN_HI), clamped


def fit(steps, cams, ref=REF):
    """steps: [ {cam: view dict(f, R, C, im (linear RGB, f's size), m (bool usable mask), boxes)} ]."""
    eqs = []
    for row in steps:
        for i, a in enumerate(cams):
            for j, b in enumerate(cams):
                if i == j or a not in row or b not in row: continue
                r = pair_ratios(row[a], row[b])
                if r: eqs.append((i, j, r[0], r[1]))
    G, cl = solve(eqs, cams, ref) if eqs else (np.ones((len(cams), 3)), np.zeros((len(cams), 3), bool))
    return G, cl, len(eqs)


def run(data, vboxes, log=print):
    """fit on data/ (dataset.py level views), rewrite data/images with the gains, write data/wb.json."""
    d = json.load(open(os.path.join(data, "frames.json"))); cams = d["cams"]
    by = {c: [f for f in d["frames"] if f["cam"] == c] for c in cams}
    def view(f):
        im = cv2.resize(cv2.imread(os.path.join(data, "images", f["name"])), (f["w"], f["h"]))
        p = os.path.join(data, "masks", f["name"].replace(".jpg", ".png"))
        m = cv2.imread(p, cv2.IMREAD_GRAYSCALE) > 127 if os.path.exists(p) else np.ones((f["h"], f["w"]), bool)
        return dict(f=f, R=np.array(f["R"]), C=np.array(f["C"]), im=lin(im), m=m, boxes=vboxes.get(f["name"], []))
    steps = [{c: view(by[c][k]) for c in cams if k < len(by[c])} for k in range(0, d["steps"], STEP)]
    ref = REF if REF in cams else cams[0]
    G, cl, n = fit(steps, cams, ref)
    gains = {c: [round(float(v), 4) for v in G[i]] for i, c in enumerate(cams)}
    log(f"  white balance (B, G, R gains, reference {ref}, {n} pair estimates): {gains}")
    for i, c in enumerate(cams):
        if cl[i].any(): log(f"  WARNING: {c} white balance clamped to {GAIN_LO}–{GAIN_HI}")
        for f in by[c]:
            p = os.path.join(data, "images", f["name"]); cv2.imwrite(p, unlin(lin(cv2.imread(p)) * G[i]), [cv2.IMWRITE_JPEG_QUALITY, 92])
    json.dump(dict(ref=ref, gains=gains, pairs=n), open(os.path.join(data, "wb.json"), "w"))
    return dict(ref=ref, gains=gains, pairs=n, clamped=[c for i, c in enumerate(cams) if cl[i].any()])
