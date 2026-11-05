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


# ── Stage 1: per-camera NEUTRAL white balance (every camera, the front included), exposure kept apart from chroma ──
# Neutral references on the road: grey asphalt (grey-world over road pixels) and white lane paint (white-patch: the brightest
# unclipped road pixels). Pixels whose chroma is far from the camera's own median road chroma (vegetation, red kerb paint,
# yellow lines, a car missed by the detector) are dropped, so a cast of the whole camera is kept but colourful things are not.
# Chroma gains keep luminance (Rec.601 weights in BGR order); the exposure gain is one scalar per camera that brings its road
# luminance to the median of all cameras' (no reference camera). Bounds: chroma 0.75–1.33 per channel, exposure 0.6–1.6.
CHROMA_LO, CHROMA_HI, EXPO_LO, EXPO_HI, CHROMA_DEV, PATCH_Q, MIN_PATCH = 0.75, 1.33, 0.6, 1.6, 0.2, 97, 200
LUMA = np.array([0.114, 0.587, 0.299])
DARK = 0.02


def road_pixels(v, n_max=20000, seed=0):
    """linear BGR of one view's usable road pixels (road plane within MAX_D, body mask, no vehicle box, no sky, not clipped)."""
    f = v["f"]; uu, vv = np.meshgrid(np.arange(0, f["w"], PX) + 0.5, np.arange(0, f["h"], PX) + 0.5)
    ui, vi = uu.astype(int), vv.astype(int); ok = _valid(v)[vi, ui]
    d = np.stack([(uu - f["cx"]) / f["f"], (vv - f["cy"]) / f["f"], np.ones_like(uu)], -1) @ v["R"].T
    ok &= d[..., 1] > 1e-3; s = np.where(ok, -v["C"][1] / np.where(ok, d[..., 1], 1), 0)
    P = v["C"] + d * s[..., None]; ok &= np.hypot(P[..., 0] - v["C"][0], P[..., 2] - v["C"][2]) < MAX_D
    c = v["im"][vi[ok], ui[ok]]; c = c[(c.min(1) > DARK) & (c.max(1) < CLIP_HI)]
    if len(c) > n_max: c = c[np.random.default_rng(seed).choice(len(c), n_max, replace=False)]
    return c


def neutral_cam(px):
    """px: linear BGR road samples of one camera → (chroma gains BGR, luminance, info)."""
    lc = np.log(px); ch = np.stack([lc[:, 0] - lc[:, 1], lc[:, 2] - lc[:, 1]], 1)
    keep = np.all(np.abs(ch - np.median(ch, 0)) < CHROMA_DEV, 1)          # drop vegetation, red/yellow paint, odd objects
    px, ch = px[keep], ch[keep]; Y = px @ LUMA
    gw = np.median(ch, 0)
    top = Y >= np.percentile(Y, PATCH_Q); wp = np.median(ch[top], 0) if top.sum() >= MIN_PATCH else None
    c = gw if wp is None else 0.5 * (gw + wp)
    g = np.array([np.exp(-c[0]), 1.0, np.exp(-c[1])])
    grey = np.median(px, 0); g *= (grey @ LUMA) / ((grey * g) @ LUMA)       # keep luminance
    return np.clip(g, CHROMA_LO, CHROMA_HI), float(np.median(Y)), dict(n=int(len(px)), grey_world=gw.tolist(), white_patch=None if wp is None else wp.tolist())


def neutral_fit(steps, cams):
    """→ chroma (NC, 3), exposure (NC,), total gains (NC, 3), info."""
    CH, L, info = [], [], {}
    for c in cams:
        px = np.concatenate([road_pixels(r[c], seed=k) for k, r in enumerate(steps) if c in r] or [np.zeros((0, 3))])
        if len(px) < MIN_PTS: CH.append(np.ones(3)); L.append(np.nan); info[c] = dict(n=int(len(px)), note="too few road pixels"); continue
        g, y, inf = neutral_cam(px); CH.append(g); L.append(y); info[c] = inf
    CH, L = np.array(CH), np.array(L)
    tgt = np.nanmedian(L); E = np.where(np.isfinite(L), np.clip(tgt / np.where(np.isfinite(L), L, 1), EXPO_LO, EXPO_HI), 1.0)
    return CH, E, CH * E[:, None], info


def run_neutral(data, vboxes, log=print):
    """Stage 1 on data/ (dataset.py level views): rewrite data/images, write data/wb.json."""
    d = json.load(open(os.path.join(data, "frames.json"))); cams = d["cams"]
    by = {c: [f for f in d["frames"] if f["cam"] == c] for c in cams}
    def view(f):
        im = cv2.resize(cv2.imread(os.path.join(data, "images", f["name"])), (f["w"], f["h"]))
        p = os.path.join(data, "masks", f["name"].replace(".jpg", ".png"))
        m = cv2.imread(p, cv2.IMREAD_GRAYSCALE) > 127 if os.path.exists(p) else np.ones((f["h"], f["w"]), bool)
        return dict(f=f, R=np.array(f["R"]), C=np.array(f["C"]), im=lin(im), m=m, boxes=vboxes.get(f["name"], []))
    steps = [{c: view(by[c][k]) for c in cams if k < len(by[c])} for k in range(0, d["steps"], STEP)]
    CH, E, G, info = neutral_fit(steps, cams)
    r = lambda a: [round(float(x), 4) for x in a]
    out = {c: dict(chroma_bgr=r(CH[i]), exposure=round(float(E[i]), 4), gains=r(G[i]), **info[c]) for i, c in enumerate(cams)}
    for i, c in enumerate(cams):
        flag = (" chroma CLAMPED" if np.any((CH[i] <= CHROMA_LO + 1e-9) | (CH[i] >= CHROMA_HI - 1e-9)) else "") + \
               (" exposure CLAMPED" if E[i] <= EXPO_LO + 1e-9 or E[i] >= EXPO_HI - 1e-9 else "")
        log(f"  neutral WB {c}: chroma (B, G, R) {r(CH[i])}, exposure {E[i]:.3f}{flag}")
        for f in by[c]:
            p = os.path.join(data, "images", f["name"]); cv2.imwrite(p, unlin(lin(cv2.imread(p)) * G[i]), [cv2.IMWRITE_JPEG_QUALITY, 92])
    json.dump(dict(mode="neutral", cams=out, gains={c: out[c]["gains"] for c in cams}), open(os.path.join(data, "wb.json"), "w"))
    return dict(mode="neutral", cams=out)
