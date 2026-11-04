"""Fine-tune each camera's aim on this drive from where neighbouring cameras see the same road.

A road point (world y = 0) seen by two cameras must show the same texture in both. Each camera except the front gets a
small rotation (pitch, yaw, roll, degrees, in its own axes; the front is the reference) found by robust least squares on
the difference of the two pictures' local texture (each picture minus its 15-px local mean, so brightness differences
don't matter) over road grids round the car at many moments. Fit on every other moment, checked on the rest.
usage: python -I align.py <splat data dir> <out json> [--every 0.5]
"""
import json, os, sys, time
import numpy as np, cv2
from scipy.optimize import least_squares

DATA, OUT = sys.argv[1:3]
PRIOR = float(sys.argv[sys.argv.index("--prior") + 1]) if "--prior" in sys.argv else 0.0   # cost of 1° as a share of the starting cost
EVERY = float(sys.argv[sys.argv.index("--every") + 1]) if "--every" in sys.argv else 0.5
F = json.load(open(os.path.join(DATA, "frames.json")))
cams_txt = {}
for l in open(os.path.join(DATA, "sparse/0/cameras.txt")):
    s = l.split()
    if len(s) == 8: cams_txt[int(s[0])] = (float(s[4]), float(s[6]), float(s[7]), int(s[2]), int(s[3]))
camid = {}
for l in open(os.path.join(DATA, "sparse/0/images.txt")):
    s = l.split()
    if len(s) == 10: camid[s[9]] = int(s[8])
CAMS = ["front", "back", "left_pillar", "right_pillar", "left_repeater", "right_repeater"]
FREE = CAMS[1:]
by = {c: sorted([f for f in F["frames"] if f["cam"] == c], key=lambda f: f["t_ref"]) for c in CAMS}

def texture(name, sigma):
    im = cv2.imread(os.path.join(DATA, "images", name), cv2.IMREAD_GRAYSCALE).astype(np.float32) / 255
    im = cv2.GaussianBlur(im, (0, 0), sigma)
    t = im - cv2.blur(im, (15, 15)); return t / (np.std(t) + 1e-6)

def mask(name):
    p = os.path.join(DATA, "masks", name.replace(".jpg", ".png"))
    return cv2.imread(p, cv2.IMREAD_GRAYSCALE) > 127

def drot(a):   # (pitch, yaw, roll) degrees about the camera's x, y, z
    return cv2.Rodrigues(np.radians(np.array([a[0], a[1], a[2]], np.float64)))[0]

t0, t1 = by["front"][0]["t_ref"] + 0.2, by["front"][-1]["t_ref"] - 0.2
moments = np.arange(t0, t1, EVERY)
def group(t):
    g = {}
    for c in CAMS:
        f = min(by[c], key=lambda f: abs(f["t_ref"] - t))
        if abs(f["t_ref"] - t) < 0.06: g[c] = f
    return g if len(g) == 6 else None
groups = [g for g in (group(t) for t in moments) if g]
print(len(groups), "moments with all six cameras")

def build(groups, sigma):
    """per moment: road grid, each camera's texture / mask / pose."""
    data = []
    for g in groups:
        C0 = np.array(g["front"]["C"]); xs = np.arange(-14, 14, 0.12)
        X, Zg = np.meshgrid(C0[0] + xs, C0[2] - 3 + xs)
        P = np.stack([X.ravel(), np.zeros(X.size), Zg.ravel()], 1)
        cams = {}
        for c, f in g.items():
            fx, cx, cy, W, H = cams_txt[camid[f["name"]]]
            cams[c] = dict(R=np.array(f["R"]), C=np.array(f["C"]), K=(fx, cx, cy, W, H), tex=texture(f["name"], sigma), m=mask(f["name"]))
        data.append((P, cams))
    return data

def proj(cam, P, d):
    R = cam["R"] @ drot(d); fx, cx, cy, W, H = cam["K"]
    q = (P - cam["C"]) @ R; z = q[:, 2]; zz = np.where(z > 0.5, z, 1)
    u = cx + fx * q[:, 0] / zz - 0.5; v = cy + fx * q[:, 1] / zz - 0.5
    ok = (z > 0.5) & (u > 8) & (u < W - 9) & (v > 8) & (v < H - 9) & (np.hypot(P[:, 0] - cam["C"][0], P[:, 2] - cam["C"][2]) < 15)
    ui, vi = np.clip(u.astype(int), 0, W - 1), np.clip(v.astype(int), 0, H - 1)
    ok &= cam["m"][vi, ui]
    return u.astype(np.float32), v.astype(np.float32), ok

def pairs_of(data):
    """fixed pairs and point sets (decided at the starting angles, so the residual vector keeps its length)."""
    sets = []
    for P, cams in data:
        vis = {c: proj(cams[c], P, (0, 0, 0))[2] for c in CAMS}
        for i, a in enumerate(CAMS):
            for b in CAMS[i + 1:]:
                both = vis[a] & vis[b]
                if both.sum() > 1500: sets.append((P[both][::2], cams, a, b))
    return sets

LAM = [0.0]
def residuals(x, sets):
    d = {c: (0, 0, 0) for c in CAMS}
    for k, c in enumerate(FREE): d[c] = x[3 * k:3 * k + 3]
    out = []
    for P, cams, a, b in sets:
        ua, va, oka = proj(cams[a], P, d[a]); ub, vb, okb = proj(cams[b], P, d[b])
        sa = cv2.remap(cams[a]["tex"], ua.reshape(1, -1), va.reshape(1, -1), cv2.INTER_LINEAR)[0]
        sb = cv2.remap(cams[b]["tex"], ub.reshape(1, -1), vb.reshape(1, -1), cv2.INTER_LINEAR)[0]
        out.append(np.where(oka & okb, sa - sb, 0) / np.sqrt(len(P)) * 30)
    return np.concatenate(out + [x * LAM[0]])   # pull toward the measured rig: costs a little per degree

fit_g, chk_g = groups[0::2], groups[1::2]
x = np.zeros(3 * len(FREE)); t = time.time()
APPLY = sys.argv[sys.argv.index("--apply") + 1] if "--apply" in sys.argv else None
if APPLY:   # no fit: score another drive's corrections on this drive
    cc = json.load(open(APPLY))["corr"]; x = np.array([v for c in FREE for v in cc[c]], float)
for sigma in (() if APPLY else (3.0, 1.5)):
    sets = pairs_of(build(fit_g, sigma))
    LAM[0] = 0
    r0 = residuals(x, sets); LAM[0] = float(np.sqrt(PRIOR * np.sum(r0 ** 2)))
    res = least_squares(residuals, x, args=(sets,), loss="soft_l1", f_scale=0.5, diff_step=1e-3, x_scale=0.2, max_nfev=60)
    x = res.x; print(f"blur {sigma}: cost {np.mean(np.abs(r0)):.4f} → {np.mean(np.abs(res.fun)):.4f}  ({time.time() - t:.0f} s)")

def pair_cost(groups, xx, sigma=1.5):
    LAM[0] = 0; sets = pairs_of(build(groups, sigma)); per = {}
    r = residuals(xx, sets); i = 0
    for P, cams, a, b in sets:
        n = len(P)
        if i + n > len(r) - len(xx): break
        per.setdefault((a, b), []).append(np.mean(np.abs(r[i:i + n])) * np.sqrt(n) / 30); i += n
    return {k: float(np.mean(v)) for k, v in per.items()}
before, after = pair_cost(chk_g, np.zeros_like(x)), pair_cost(chk_g, x)
print("checked on", len(chk_g), "moments the fit didn't use (texture difference, lower = better aligned):")
for k in before: print(f"  {k[0]:>14s} – {k[1]:<15s} {before[k]:.3f} → {after[k]:.3f}  ({(after[k] / before[k] - 1) * 100:+.0f} %)")
corr = {c: [round(float(v), 3) for v in x[3 * k:3 * k + 3]] for k, c in enumerate(FREE)}
print("angle corrections (pitch, yaw, roll °):", corr)
json.dump(dict(corr=corr, before={f"{a}|{b}": v for (a, b), v in before.items()}, after={f"{a}|{b}": v for (a, b), v in after.items()}), open(OUT, "w"), indent=1)
