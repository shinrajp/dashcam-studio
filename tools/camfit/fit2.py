"""Camera layout check / fit on real footage, scale-free.
 1. Pairs: the same vehicle seen by two neighbouring cameras at the same moment: the same direction round the car (azimuth from the car's
    centre) and the same distance (log ratio) -- shrinking the map can't fake these.
 2. Absolute scale, per camera: how tall a car looks gives its distance (a car is about 1.55 m tall); that must agree with where its bottom
    meets the road (which depends on the camera's tilt and height).
 3. Priors: every setting stays near the app's defaults (fixed bounds, they don't drift)."""
import json, numpy as np, sys, copy
from scipy.optimize import linear_sum_assignment, least_squares
sys.path.insert(0, "."); from geo import *
D = json.load(open("dets.json"))
PAIRS = [("front", "left_pillar"), ("front", "right_pillar"), ("left_pillar", "left_repeater"), ("right_pillar", "right_repeater"), ("left_repeater", "back"), ("right_repeater", "back")]
VEH = {"car", "truck", "bus"}; HCAR = 1.55
def whole(d): return d[0] > 0.004 and d[0] + d[2] < 0.996 and d[1] > 0.004 and d[1] + d[3] < 0.995 and d[2] * d[3] > 0.0006
def gpt(C, cam, ds):
    a = np.array([[d[0] + d[2] / 2, d[1] + d[3]] for d in ds]); return ground(C[cam], a[:, 0], a[:, 1], ASPECT[cam])
def az_rng(g): return np.degrees(np.arctan2(g[:, 0], g[:, 1])), np.linalg.norm(g, axis=1)
def match(C, gate_deg=12, gate_log=0.6):
    out = []
    for A, B in PAIRS:
        for ra, rb in zip(D[A], D[B]):
            da = [d for d in ra["d"] if d[4] in VEH and whole(d)]; db = [d for d in rb["d"] if d[4] in VEH and whole(d)]
            if not da or not db: continue
            ga, oa = gpt(C, A, da); gb, ob = gpt(C, B, db); aa, na = az_rng(ga); ab, nb = az_rng(gb)
            daz = np.abs((aa[:, None] - ab[None] + 180) % 360 - 180); dl = np.abs(np.log(na[:, None] / nb[None]))
            M = np.where(oa[:, None] & ob[None] & (daz < gate_deg) & (dl < gate_log), daz / 5 + dl / 0.25, 1e6)
            ii, jj = linear_sum_assignment(M)
            for i, j in zip(ii, jj):
                if M[i, j] < 1e5: out.append((A, B, da[i], db[j]))
    return out
# per-camera single detections for the height/scale check (cars only: trucks and buses vary too much)
SING = {c: [d for row in D[c] for d in row["d"] if d[4] == "car" and whole(d) and d[3] > 0.03] for c in CAMS}
rngs = np.random.default_rng(0)
for c in CAMS:
    if len(SING[c]) > 400: SING[c] = [SING[c][i] for i in rngs.choice(len(SING[c]), 400, replace=False)]
def height_dist(C, cam, ds):
    """distance from apparent height (car HCAR tall, standing on the road) vs from where its bottom meets the road → (log ratio, ok)"""
    a = np.array([[d[0] + d[2] / 2, d[1], d[1] + d[3]] for d in ds])
    rt = ray(C[cam], a[:, 0], a[:, 1], ASPECT[cam]); rb = ray(C[cam], a[:, 0], a[:, 2], ASPECT[cam]); h = C[cam]["pos"][1]
    eb = np.arctan2(-rb[:, 1], np.hypot(rb[:, 0], rb[:, 2])); et = np.arctan2(-rt[:, 1], np.hypot(rt[:, 0], rt[:, 2]))   # depression angles
    dg = h / np.tan(np.maximum(eb, 1e-3))
    # solve atan(h/d) - atan((h-HCAR)/d) = eb - et for d (monotonic): bisection in log space
    lo, hi = np.full(len(a), 0.5), np.full(len(a), 200.0)
    for _ in range(40):
        mid = np.sqrt(lo * hi); f = np.arctan(h / mid) - np.arctan((h - HCAR) / mid) - (eb - et)
        lo = np.where(f > 0, mid, lo); hi = np.where(f > 0, hi, mid)
    dh = np.sqrt(lo * hi); ok = (eb > 0.01) & (dg < 80) & (dh < 80)
    return np.log(dg / dh), ok
FREE = [("front", "pitch"), ("front", "fov")] + [(c, k) for c in CAMS[1:] for k in ("yaw", "pitch", "fov")]
SIG = {"yaw": 8.0, "pitch": 5.0, "fov": 12.0}; BND = {"yaw": 20, "pitch": 12, "fov": 30}
X0 = np.array([DEFAULTS[c][k] for c, k in FREE], float)
def apply(x):
    C = copy.deepcopy(DEFAULTS)
    for (c, k), v in zip(FREE, x): C[c][k] = float(v)
    return C
def pack(pairs):
    P = {}
    for k, (A, B, da, db) in enumerate(pairs):
        q = P.setdefault((A, B), [[], [], []]); q[0].append([da[0] + da[2] / 2, da[1] + da[3]]); q[1].append([db[0] + db[2] / 2, db[1] + db[3]]); q[2].append(k)
    return {k: (np.array(a), np.array(b), np.array(i)) for k, (a, b, i) in P.items()}
def residuals(x, pk, npairs):
    C = apply(x); r1 = np.zeros(2 * npairs)
    for (A, B), (ua, ub, idx) in pk.items():
        ga, oa = ground(C[A], ua[:, 0], ua[:, 1], ASPECT[A]); gb, ob = ground(C[B], ub[:, 0], ub[:, 1], ASPECT[B])
        aa, na = az_rng(ga); ab, nb = az_rng(gb); ok = oa & ob
        r1[2 * idx] = np.where(ok, ((aa - ab + 180) % 360 - 180) / 5.0, 3.0); r1[2 * idx + 1] = np.where(ok, np.log(na / nb) / 0.25, 3.0)
    r2 = []
    for c in CAMS:
        lr, ok = height_dist(C, c, SING[c]); r2.append(np.where(ok, lr / 0.3, 2.0) * 0.5)
    pri = (x - X0) / SIGW
    return np.concatenate([r1, np.concatenate(r2), pri])
def report(C, pairs, tag):
    by = {}
    for A, B, da, db in pairs:
        ga, oa = gpt(C, A, [da]); gb, ob = gpt(C, B, [db])
        if oa[0] and ob[0]: by.setdefault(A + "/" + B, []).append((np.linalg.norm(ga[0] - gb[0]), abs(((az_rng(ga)[0] - az_rng(gb)[0] + 180) % 360 - 180)[0]), abs(np.log(az_rng(ga)[1][0] / az_rng(gb)[1][0]))))
    allv = np.array([x for v in by.values() for x in v])
    hs = np.concatenate([height_dist(C, c, SING[c])[0][height_dist(C, c, SING[c])[1]] for c in CAMS])
    print(tag, "pairs n=%d: position diff median %.2f m · direction diff median %.1f° · distance ratio median %.0f %%   | height-vs-road distance agreement median %.0f %%" % (
        len(allv), np.median(allv[:, 0]), np.median(allv[:, 1]), 100 * (np.exp(np.median(allv[:, 2])) - 1), 100 * (np.exp(np.median(np.abs(hs))) - 1)))
    for k, v in by.items(): v = np.array(v); print("   ", k, "n=%d  %.2f m  %.1f°" % (len(v), np.median(v[:, 0]), np.median(v[:, 1])))
    return allv
C = copy.deepcopy(DEFAULTS); pairs = match(C, 15, 0.8)
base = report(C, pairs, "DEFAULTS")
# limits for this camera set (HW4-style: wider lenses, the rear a near-circular fisheye that looks well down)
LIM = {("front", "pitch"): (-15, 5), ("front", "fov"): (50, 130), ("back", "yaw"): (170, 190), ("back", "pitch"): (-60, 0), ("back", "fov"): (100, 200)}
lo = np.array([LIM.get((c, k), (X0[i] - (25 if k == "yaw" else 20 if k == "pitch" else 40), X0[i] + (25 if k == "yaw" else 12 if k == "pitch" else 45)))[0] for i, (c, k) in enumerate(FREE)], float)
hi = np.array([LIM.get((c, k), (X0[i] - (25 if k == "yaw" else 20 if k == "pitch" else 40), X0[i] + (25 if k == "yaw" else 12 if k == "pitch" else 45)))[1] for i, (c, k) in enumerate(FREE)], float)
SIGW = np.array([30.0 if (c == "back" and k != "yaw") or (c == "front" and k == "fov") else SIG[k] for c, k in FREE])   # (weak pull where the defaults are known not to fit)
x = np.clip(X0.copy(), lo + 1e-6, hi - 1e-6)
for it in range(4):
    pk = pack(pairs)
    sol = least_squares(residuals, x, args=(pk, len(pairs)), bounds=(lo, hi), loss="huber", f_scale=1.0, x_scale=np.array([SIG[k] for c, k in FREE]))
    x = sol.x; C = apply(x); pairs = match(C, 12, 0.6)
    report(C, pairs, "FIT %d   " % (it + 1))
# fair comparison: the same final pairs scored with the defaults
print("--- same pairs, defaults vs fitted:")
report(DEFAULTS, pairs, "DEFAULTS"); report(C, pairs, "FITTED  ")
json.dump({c: {k: (round(float(C[c][k]), 2) if isinstance(C[c][k], (int, float, np.floating)) else C[c][k]) for k in ("yaw", "pitch", "roll", "fov", "model", "pos")} for c in CAMS}, open("fitted.json", "w"), indent=1)
for c in CAMS: print("%-15s yaw %7.1f pitch %6.1f fov %6.1f   (default %d / %d / %d)" % (c, C[c]["yaw"], C[c]["pitch"], C[c]["fov"], DEFAULTS[c]["yaw"], DEFAULTS[c]["pitch"], DEFAULTS[c]["fov"]))
