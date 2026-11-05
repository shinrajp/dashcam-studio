"""linetune.py — per-car calibration of the side cameras from road-line / kerb-foot alignment (LINE_TUNE in js/rig.js).

What it fits: for a secondary camera (a repeater) small extra yaw / pitch / roll (degrees, js/rig.js conventions) and an
outward shift of its position (metres), so that the road-plane edges it sees (lane lines, kerb feet, any painted or unpainted
ground edge) land on the same edges seen by the reference cameras (back, same-side pillar) in their overlap.

Generic by design: edges are plain image gradients (Canny), no colour; only edge pixels whose fused 3D point lies within
NEAR_ROAD of the road plane are used (road markings and kerb feet, not buildings). The cost is a truncated chamfer
distance on the road plane, so outliers cost at most TRUNC.

Parameters (physical, not tuned to any clip):
  BOUND_DEG = 3     largest mounting error expected from a bracket / glass tolerance
  BOUND_M   = 0.2   largest lateral position error (mirror / fender variation)
  MAX_D     = 12 m  beyond this a 1 px edge spans > 5 cm on the road
  NEAR_ROAD = 0.3 m  points this close to y = 0 count as road-plane edges
  TRUNC     = 0.3 m  chamfer truncation (half a lane-line spacing scale)
  GRID      = 0.02 m road-plane grid for the distance transform

This is a PER-CAR CALIBRATION: fit it on one drive, check it on another (cross-drive), store it switchable, never in MEASURED.
Usage: python linetune.py WORK_FIT [WORK_TEST ...] [--cam right_repeater]  (WORK = a build's work folder with fused/)
"""
import sys, os, re, json, math, argparse
import numpy as np, cv2
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "depth3d"))
import rig as rigpy

BOUND_DEG, BOUND_M, MAX_D, NEAR_ROAD, TRUNC, GRID = 3.0, 0.2, 12.0, 0.3, 0.3, 0.02
REFS = {"right_repeater": ["back", "right_pillar"], "left_repeater": ["back", "left_pillar"]}
S = np.diag([1.0, -1.0, 1.0])


def cam_angles(rigjs):
    """yaw/pitch/roll per camera as js/rig.js uses them (MEASURED + ROAD_TUNE; LINE_TUNE not applied)."""
    src = open(rigjs).read(); out = {}
    def block(name):
        m = re.search(name + r"\s*=\s*\{(.*?)\n\s*\};", src, re.S); return m.group(1) if m else ""
    for blk, add in [(block("MEASURED"), False), (block("ROAD_TUNE"), True)]:
        for cam, body in re.findall(r"(\w+):\s*\{([^}]*)\}", blk):
            v = {k: float(x) for k, x in re.findall(r"(yaw|pitch|roll):\s*(-?[\d.]+)", body)}
            if add and cam in out: out[cam] = {k: out[cam][k] + v.get(k, 0) for k in out[cam]}
            elif not add: out[cam] = v
    return out


def load(work, angles):
    F = os.path.join(work, "fused"); d = json.load(open(os.path.join(F, "frames.json"))); steps = {}
    for f in d["frames"]:
        img = cv2.resize(cv2.imread(os.path.join(F, f["name"]), cv2.IMREAD_GRAYSCALE), (f["w"], f["h"]))
        Z = np.load(os.path.join(F, f["name"][:-4] + ".npy"))
        e = cv2.Canny(cv2.GaussianBlur(img, (5, 5), 0), 40, 100) > 0
        vv, uu = np.nonzero(e)
        ray = np.stack([(uu + .5 - f["cx"]) / f["f"], (vv + .5 - f["cy"]) / f["f"], np.ones(len(uu))], 1)
        R, C = np.array(f["R"]), np.array(f["C"]); P = C + (ray @ R.T) * Z[vv, uu][:, None]
        keep = (Z[vv, uu] > 0) & (np.abs(P[:, 1]) < NEAR_ROAD) & (np.hypot(P[:, 0] - C[0], P[:, 2] - C[2]) < MAX_D)
        a = angles[f["cam"]]; Rv = S @ rigpy.rot(a["yaw"], rigpy.VIEW[f["cam"]]["pitch"], 0) @ S
        steps.setdefault(f["step"], {})[f["cam"]] = dict(ray=ray[keep], R=R, C=C, Rv=Rv, a=a)
    return steps


def ground(fr, dp=(0, 0, 0, 0)):
    """road-plane (x, z) of a frame's edge rays with a mounting change dp = (dyaw, dpitch, droll, dx_out)."""
    R, C = fr["R"], fr["C"].copy()
    if any(dp):
        a = fr["a"]; M = rigpy.rot(a["yaw"] + dp[0], a["pitch"] + dp[1], a["roll"] + dp[2]) @ rigpy.rot(a["yaw"], a["pitch"], a["roll"]).T
        Cv = fr["Rv"]; A = R @ Cv.T; R = A @ (S @ M @ S) @ Cv
        side = 1.0 if "right" in fr.get("cam", "right") else -1.0
        C = C + A @ np.array([side * dp[3], 0, 0])
    dw = fr["ray"] @ R.T; ok = dw[:, 1] > 0.02; s = -C[1] / dw[ok, 1]
    return (C + dw[ok] * s[:, None])[:, [0, 2]]


def dt(P):
    lo = P.min(0) - TRUNC; n = np.ceil((P.max(0) + TRUNC - lo) / GRID).astype(int) + 1
    img = np.ones((n[1], n[0]), np.uint8); ij = ((P - lo) / GRID).astype(int); img[ij[:, 1], ij[:, 0]] = 0
    return lo, n, cv2.distanceTransform(img, cv2.DIST_L2, 5) * GRID


def prep(steps, cam):
    out = []
    for st, fr in steps.items():
        if cam not in fr: continue
        fr[cam]["cam"] = cam
        for ref in REFS[cam]:
            if ref not in fr or len(fr[ref]["ray"]) < 200: continue
            P = ground(fr[ref])
            if len(P) < 200: continue
            out.append((fr[cam], dt(P)))
    return out


def cost(pairs, dp):
    tot, n = 0.0, 0
    for sec, (lo, sz, D) in pairs:
        Q = ground(sec, dp); ij = ((Q - lo) / GRID).astype(int)
        ok = (ij[:, 0] >= 0) & (ij[:, 1] >= 0) & (ij[:, 0] < sz[0]) & (ij[:, 1] < sz[1])
        if ok.sum() < 50: continue
        d = np.minimum(D[ij[ok, 1], ij[ok, 0]], TRUNC); inside = d < TRUNC   # only where the ref sees edges nearby
        if inside.sum() < 50: continue
        tot += float(np.mean(d)); n += 1
    return tot / n if n else float("nan"), n


def fit(pairs):
    x = np.zeros(4); best = cost(pairs, x)[0]; steps = [1.0, 1.0, 1.0, 0.08]; bnd = [BOUND_DEG] * 3 + [BOUND_M]
    for _ in range(4):
        for i in range(4):
            for s in (steps[i], steps[i] / 2, steps[i] / 4):
                for sg in (1, -1):
                    while True:
                        y = x.copy(); y[i] = np.clip(y[i] + sg * s, -bnd[i], bnd[i])
                        if y[i] == x[i]: break
                        c = cost(pairs, y)[0]
                        if c < best - 1e-5: x, best = y, c
                        else: break
    return x, best


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("works", nargs="+"); ap.add_argument("--cam", default="right_repeater"); ap.add_argument("--joint", action="store_true", help="fit on all drives together")
    ap.add_argument("--rig", default=os.path.join(os.path.dirname(__file__), "..", "..", "js", "rig.js")); a = ap.parse_args()
    ang = cam_angles(a.rig); sets = [prep(load(w, ang), a.cam) for w in a.works]
    x, c = fit(sum(sets, []) if a.joint else sets[0]); res = {"cam": a.cam, "fit_on": "all" if a.joint else 0, "tune": dict(zip(["yaw", "pitch", "roll", "dx"], [round(float(v), 3) for v in x]))}
    res["drives"] = [{"before": round(cost(s, np.zeros(4))[0], 4), "after": round(cost(s, x)[0], 4), "pairs": len(s)} for s in sets]
    print(json.dumps(res))
