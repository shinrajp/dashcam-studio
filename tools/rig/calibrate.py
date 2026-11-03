#!/usr/bin/env python3
"""calibrate.py — measure each camera of the rig from a real drive: lens, mounting angles, telemetry delay.

No chessboard: the car's own motion is the reference. The telemetry (SEI, tools/rig/sei-dump.js) gives speed and
heading at every frame, so between two frames of one camera the car's move is known (rear-axle bicycle model: the
rear axle moves along the heading, the body turns by the heading change). A point tracked across those frames
(tools/rig/tracks.py) must then lie on the epipolar plane that move implies. Fitting all of a camera's tracks gives:

  - lens: Kannala-Brandt fisheye r = f·θ(1 + k1θ² + k2θ⁴ + k3θ⁶), centre (cx, cy). The turns (known rotation) fix f.
  - mounting: yaw / pitch / roll in js/pano.js's convention (camera→car R = Ry(yaw)·Rx(pitch)·Rz(roll),
    car axes x right, y up, z forward; + yaw = to the right, + pitch = up)
  - delay: seconds between a frame and the telemetry stamped on it (video t + delay = telemetry t)

Then, with that fixed, ground points (tracked below the horizon) are triangulated with the metric move, and a plane
fitted to them gives the camera's height above the road. The mounting positions are priors (a 2024 Model X,
origin on the road under the middle of the rear axle) — they barely change the epipolar fit.

    python tools/rig/calibrate.py --sei DIR --tracks DIR --out rig.json [--cams front,back,...]
"""
import argparse, json, math, sys
import numpy as np
from scipy.optimize import least_squares

CAMS = ["front", "back", "left_pillar", "right_pillar", "left_repeater", "right_repeater"]
# priors: yaw/pitch (deg), horizontal fov (deg) for the starting lens, position (m: x right, y up, z forward of the rear axle).
# Positions: a 2024 Model X (5.06 m long, 2.0 m wide, wheelbase 2.97 m) — only the turns' lever arm depends on them.
PRIOR = {
    "front":          dict(yaw=0,    pitch=-3,  fov=50,  pos=[0.0, 1.45, 2.05]),
    "back":           dict(yaw=180,  pitch=-25, fov=130, pos=[0.0, 1.00, -1.03]),
    "left_pillar":    dict(yaw=-70,  pitch=-5,  fov=85,  pos=[-0.92, 1.35, 1.55]),
    "right_pillar":   dict(yaw=70,   pitch=-5,  fov=85,  pos=[0.92, 1.35, 1.55]),
    "left_repeater":  dict(yaw=-140, pitch=-5,  fov=85,  pos=[-1.02, 0.95, 2.45]),
    "right_repeater": dict(yaw=140,  pitch=-5,  fov=85,  pos=[1.02, 0.95, 2.45]),
}
R2D = 180 / math.pi


def rot(yaw, pitch, roll):
    """camera(GL: x right, y up, z forward)→car rotation, as js/pano.js rot()."""
    cy, sy, cp, sp, cr, sr = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch), math.cos(roll), math.sin(roll)
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]); Rx = np.array([[1, 0, 0], [0, cp, sp], [0, -sp, cp]])
    Rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
    return Ry @ Rx @ Rz


def Ry(a):
    c, s = math.cos(a), math.sin(a); return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def skew(t):
    return np.array([[0, -t[2], t[1]], [t[2], 0, -t[0]], [-t[1], t[0], 0]])


# ── telemetry → car path ──
class Path:
    """Rear-axle path from speed + heading, on a fine grid (world: east, north; heading clockwise from north)."""
    def __init__(self, rows):
        t = np.array([r["t"] for r in rows]); v = np.array([r.get("speed", 0.0) for r in rows])
        h = np.unwrap(np.radians([r.get("heading", 0.0) for r in rows]))
        self.g = np.arange(t[0] - 1, t[-1] + 1, 0.002)
        self.v = np.interp(self.g, t, v); self.h = np.interp(self.g, t, h)
        dt = np.diff(self.g, prepend=self.g[0]); hm = self.h
        self.e = np.cumsum(self.v * dt * np.sin(hm)); self.n = np.cumsum(self.v * dt * np.cos(hm))
        self.t, self.speed = t, v

    def at(self, t):
        return np.interp(t, self.g, self.e), np.interp(t, self.g, self.n), np.interp(t, self.g, self.h)

    def rel(self, t0, t1):
        """car-1 pose in car-0 coordinates: X0 = Ry(dpsi)·X1 + T."""
        e0, n0, h0 = self.at(t0); e1, n1, h1 = self.at(t1)
        de, dn = e1 - e0, n1 - n0
        right = (math.cos(h0), -math.sin(h0)); fwd = (math.sin(h0), math.cos(h0))
        T = np.array([de * right[0] + dn * right[1], 0.0, de * fwd[0] + dn * fwd[1]])
        return Ry(h1 - h0), T


# ── lens ──
def unproject(u, v, p, w, h):
    """pixels → unit bearings in GL camera axes (x right, y up, z forward). p: f (× width), cx, cy (× width), k1..k3."""
    f, cx, cy, k1, k2, k3 = p[0] * w, w / 2 + p[1] * w, h / 2 + p[2] * w, p[3], p[4], p[5]
    dx, dy = (u - cx) / f, (v - cy) / f
    rho = np.hypot(dx, dy); th = rho.copy()
    for _ in range(8):
        t2 = th * th; r = th * (1 + t2 * (k1 + t2 * (k2 + t2 * k3))) - rho
        dr = 1 + t2 * (3 * k1 + t2 * (5 * k2 + t2 * 7 * k3))
        th = np.clip(th - r / np.maximum(dr, 0.05), 0, 3.0)
    s = np.where(rho > 1e-9, np.sin(th) / np.maximum(rho, 1e-9), 1.0)
    return np.stack([dx * s, -dy * s, np.cos(th)], 1)


def project(b, p, w, h):
    """unit bearings (GL camera axes) → pixels."""
    f, cx, cy, k1, k2, k3 = p[0] * w, w / 2 + p[1] * w, h / 2 + p[2] * w, p[3], p[4], p[5]
    th = np.arccos(np.clip(b[:, 2], -1, 1)); t2 = th * th
    r = th * (1 + t2 * (k1 + t2 * (k2 + t2 * k3)))
    l = np.maximum(np.hypot(b[:, 0], b[:, 1]), 1e-12)
    return np.stack([cx + f * r * b[:, 0] / l, cy - f * r * b[:, 1] / l], 1)


def px_per_rad(b, p, w):
    """pixels per radian of the picture round each bearing (geometric mean of the radial and the tangential scale)."""
    k1, k2, k3 = p[3], p[4], p[5]; th = np.arccos(np.clip(b[:, 2], -1, 1)); t2 = th * th
    r = th * (1 + t2 * (k1 + t2 * (k2 + t2 * k3))); dr = 1 + t2 * (3 * k1 + t2 * (5 * k2 + t2 * 7 * k3))
    tang = np.where(th > 1e-3, r / np.maximum(np.sin(th), 1e-3), 1.0)
    return p[0] * w * np.sqrt(np.maximum(dr, 1e-3) * np.maximum(tang, 1e-3))


def lens_fold(p, w, rpx, n=200):
    """the lens radius must keep growing out to the farthest tracked point (rpx pixels from the centre): n residuals,
    all zero when it does, else large — a single penalty term is lost among the thousands of point residuals."""
    need = rpx / (p[0] * w); k1, k2, k3 = p[3], p[4], p[5]
    th = np.linspace(0.01, 3.0, 600); t2 = th * th
    r = th * (1 + t2 * (k1 + t2 * (k2 + t2 * k3))); dr = 1 + t2 * (3 * k1 + t2 * (5 * k2 + t2 * 7 * k3))
    stop = np.argmax(dr < 0.15) if (dr < 0.15).any() else len(th) - 1
    short = max(0.0, need - r[stop])
    return np.full(n, 40.0 * short)


def f_for_fov(fov_deg, k=(0, 0, 0)):
    th = math.radians(fov_deg) / 2; t2 = th * th
    return 0.5 / (th * (1 + t2 * (k[0] + t2 * (k[1] + t2 * k[2]))))


# ── data ──
def load_pairs(tracks, path, ftimes, scale_back, rng, max_pairs=500, per_pair=120):
    """Frame pairs where the car moved enough (≥0.6 m or ≥1.5°), and the points tracked across each."""
    tid, fi, x, y = tracks["tid"], tracks["fi"], tracks["x"], tracks["y"]
    order = np.lexsort((tid, fi)); tid, fi, x, y = tid[order], fi[order], x[order], y[order]
    starts = np.searchsorted(fi, np.arange(int(tracks["nframes"]) + 1))
    n = min(len(ftimes), int(tracks["nframes"])); pairs = []
    for i in range(0, n - 1, 2):
        t0 = ftimes[i]
        if np.interp(t0, path.t, path.speed) < 1.0: continue
        for k in range(2, 16):
            j = i + k
            if j >= n: break
            R, T = path.rel(t0, ftimes[j]); dpsi = abs(math.atan2(R[0, 2], R[0, 0]))
            if np.linalg.norm(T) >= 0.6 or dpsi >= math.radians(1.5): break
        else: continue
        if j >= n: continue
        a, b = slice(starts[i], starts[i + 1]), slice(starts[j], starts[j + 1])
        common, ia, ib = np.intersect1d(tid[a], tid[b], return_indices=True)
        if len(common) < 25: continue
        sel = rng.choice(len(common), min(per_pair, len(common)), replace=False)
        pairs.append((i, j, x[a][ia[sel]], y[a][ia[sel]], x[b][ib[sel]], y[b][ib[sel]], dpsi))
    if len(pairs) > max_pairs:   # every turning pair (they fix the lens), then a sample of the straight ones
        turn = [k for k, p in enumerate(pairs) if p[6] >= math.radians(1.5)]; rest = [k for k, p in enumerate(pairs) if p[6] < math.radians(1.5)]
        n = max(0, max_pairs - len(turn))
        keep = sorted(turn + list(rng.choice(rest, min(n, len(rest)), replace=False))); pairs = [pairs[k] for k in keep]
    return [p[:6] for p in pairs]


class Problem:
    """Unknowns: yaw, pitch, roll (rad), f, cx, cy, k1, k2, k3, delay (s)."""
    def __init__(self, cam, pairs, path, ftimes, w, h, pos):
        self.cam, self.pairs, self.path, self.ft, self.w, self.h, self.P = cam, pairs, path, ftimes, w, h, np.array(pos)
        self.u0 = np.concatenate([p[2] for p in pairs]); self.v0 = np.concatenate([p[3] for p in pairs])
        self.u1 = np.concatenate([p[4] for p in pairs]); self.v1 = np.concatenate([p[5] for p in pairs])
        self.idx = np.concatenate([np.full(len(p[2]), k) for k, p in enumerate(pairs)])
        self.w8 = np.ones(len(self.u0))
        self.rpx = float(np.percentile(np.hypot(np.concatenate([self.u0, self.u1]) - w / 2, np.concatenate([self.v0, self.v1]) - h / 2), 99.5))

    def motions(self, delay, Rcam, body=None):
        """per pair: R01, t01 (camera-1 → camera-0, GL camera axes). body: per pair (pitch, roll) of the car body
        between the two frames (suspension, road camber) — the telemetry has the heading only."""
        Rcc = Rcam.T; out = []
        for k, (i, j, *_) in enumerate(self.pairs):
            R, T = self.path.rel(self.ft[i] + delay, self.ft[j] + delay)
            if body is not None: R = R @ rot(0, body[k, 0], body[k, 1])
            out.append((Rcc @ R @ Rcam, Rcc @ (R @ self.P + T - self.P)))
        return out

    NG = 10            # global unknowns: yaw, pitch, roll, f, cx, cy, k1, k2, k3, delay
    BODY_SIGMA = math.radians(0.4)

    def residual(self, q, raw=False):
        """distance from the epipolar plane in pixels (angle × the lens's local pixels per radian), then the body
        pitch/roll priors, then the lens-fold penalty."""
        Rcam = rot(q[0], q[1], q[2]); lens = q[3:9]; body = q[self.NG:].reshape(-1, 2)
        b0 = unproject(self.u0, self.v0, lens, self.w, self.h); b1 = unproject(self.u1, self.v1, lens, self.w, self.h)
        M = self.motions(q[9], Rcam, body)
        E = np.stack([skew(t / max(np.linalg.norm(t), 1e-9)) @ R for R, t in M])[self.idx]
        Eb1 = np.einsum("nij,nj->ni", E, b1); Etb0 = np.einsum("nji,nj->ni", E, b0)
        r0 = np.einsum("ni,ni->n", b0, Eb1) / np.maximum(np.linalg.norm(Eb1, axis=1), 1e-9)
        r1 = np.einsum("ni,ni->n", b1, Etb0) / np.maximum(np.linalg.norm(Etb0, axis=1), 1e-9)
        r = 0.5 * (r0 * px_per_rad(b0, lens, self.w) + r1 * px_per_rad(b1, lens, self.w))
        if raw: return r
        return np.concatenate([r * self.w8, body.ravel() / self.BODY_SIGMA, lens_fold(lens, self.w, self.rpx)])

    def sparsity(self):
        from scipy.sparse import lil_matrix
        n, npair = len(self.u0), len(self.pairs); J = lil_matrix((n + 2 * npair + 200, self.NG + 2 * npair), dtype=np.int8)
        J[:n, :self.NG] = 1
        rows = np.arange(n); J[rows, self.NG + 2 * self.idx] = 1; J[rows, self.NG + 2 * self.idx + 1] = 1
        for k in range(2 * npair): J[n + k, self.NG + k] = 1
        J[n + 2 * npair:, 3:9] = 1
        return J

    def pack(self, yaw, pitch, roll, fov, k=(0, 0, 0)):
        g = [math.radians(yaw), math.radians(pitch), math.radians(roll), f_for_fov(fov, k), 0, 0, *k, 0.0]
        return np.concatenate([g, np.zeros(2 * len(self.pairs))])


def bounds(npair, cam=None):
    """lens terms kept where real lenses are: between an equisolid fisheye (k1 = −1/24) and a rectilinear one (tan: k1 ≈ +1/3) —
    a lens whose radius stops growing squeezes many angles into a few pixels and so "fits" anything; k3 is left out."""
    nb = 2 * npair
    k1, k2 = ((-0.06, 0.12), (0.0, 0.05)) if cam == "back" else ((-0.1, 0.4), (-0.03, 0.12))
    lo = np.concatenate([[-2 * math.pi, -1.2, -0.6, 0.2, -0.08, -0.08, k1[0], k2[0], -1e-9, -0.6], np.full(nb, -0.05)])
    hi = np.concatenate([[2 * math.pi, 1.2, 0.6, 2.5, 0.08, 0.08, k1[1], k2[1], 1e-9, 0.6], np.full(nb, 0.05)])
    return lo, hi


def fit(pb, q0, n):
    lo, hi = bounds(len(pb.pairs), pb.cam)
    return least_squares(pb.residual, np.clip(q0, lo + 1e-9, hi - 1e-9), bounds=(lo, hi), loss="cauchy", f_scale=1.0,
                         max_nfev=n, x_scale="jac", jac_sparsity=pb.sparsity(), tr_solver="lsmr")


def solve(pb, small, prior, quick=False):
    """multi-start (yaw × lens width) on a small set of pairs — the cost is not convex in yaw, and a bad lens guess
    folds the turns — then the best start on every pair, trimming outliers (other cars, the car's own body)."""
    best = None
    for dyaw in ([0] if quick else [-40, 0, 40]):
        for fov in sorted({prior["fov"], 60, 90, 120, 150}):
            r = fit(small, small.pack(prior["yaw"] + dyaw, prior["pitch"], 0, fov), 40)
            if best is None or r.cost < best.cost: best = r
    q0 = np.concatenate([best.x[:pb.NG], np.zeros(2 * len(pb.pairs))])
    r = fit(pb, q0, 300)
    for _ in range(2):
        res = np.abs(pb.residual(r.x, raw=True))
        s = 1.4826 * np.median(res); pb.w8 = (res < max(4 * s, 1.5)).astype(float)
        r = fit(pb, r.x, 300)
    return r


# ── ground plane / height ──
def triangulate(b0, b1, R01, t01):
    """midpoint triangulation; returns points in camera-0 axes and the ray angle between them."""
    d1 = (R01 @ b1.T).T; c1 = t01
    # solve s·b0 - u·d1 = c1 for s, u per point (least squares)
    a = np.einsum("ni,ni->n", b0, b0); bb = np.einsum("ni,ni->n", b0, d1); c = np.einsum("ni,ni->n", d1, d1)
    d = b0 @ c1; e = d1 @ c1; den = a * c - bb * bb
    s = (d * c - bb * e) / np.maximum(den, 1e-12); u = (bb * d - a * e) / np.maximum(den, 1e-12)
    X = 0.5 * (s[:, None] * b0 + (c1 + u[:, None] * d1))
    ang = np.arccos(np.clip(np.einsum("ni,ni->n", b0, d1), -1, 1))
    return X, s, u, ang


def ground_height(pb, q, rng):
    Rcam = rot(q[0], q[1], q[2]); lens = q[3:9]; M = pb.motions(q[9], Rcam, q[pb.NG:].reshape(-1, 2)); pts = []
    for k, (i, j, u0, v0, u1, v1) in enumerate(pb.pairs):
        b0 = unproject(u0, v0, lens, pb.w, pb.h); b1 = unproject(u1, v1, lens, pb.w, pb.h)
        R01, t01 = M[k]
        if np.linalg.norm(t01) < 0.5: continue
        X, s, u, ang = triangulate(b0, b1, R01, t01)
        Xc = (Rcam @ X.T).T            # car-aligned axes at the camera (x right, y up, z forward)
        ok = (s > 0.5) & (u > 0.5) & (ang > math.radians(1.0)) & (Xc[:, 1] < -0.2) & (np.hypot(Xc[:, 0], Xc[:, 2]) < 12)
        pts.append(Xc[ok])
    P = np.concatenate(pts) if pts else np.zeros((0, 3))
    if len(P) < 50: return None
    # the road is the lowest dense layer of points near the car (cars, kerbs, walls sit above it)
    P = P[np.abs(P[:, 0]) < 6]
    if len(P) < 30: return None
    d = -P[:, 1]; hist, edges = np.histogram(d, bins=np.arange(0.2, 3.0, 0.05))
    sm = np.convolve(hist, [1, 2, 3, 2, 1], "same"); peaks = [i for i in range(1, len(sm) - 1) if sm[i] >= sm[i - 1] and sm[i] >= sm[i + 1] and sm[i] >= 0.3 * sm.max()]
    i = max(peaks); h0 = 0.5 * (edges[i] + edges[i + 1])
    Q = P[np.abs(d - h0) < 0.15]
    c = Q.mean(0); _, _, vt = np.linalg.svd(Q - c); n = vt[2] * np.sign(vt[2][1])
    return dict(height=round(float(abs(n @ c)), 3), normal=[round(v, 4) for v in n.tolist()], inliers=int(len(Q)), points=int(len(P)),
                tilt_deg=round(float(math.degrees(math.acos(min(1, abs(n[1]))))), 2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sei", required=True); ap.add_argument("--tracks", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--cams", default=",".join(CAMS)); ap.add_argument("--quick", action="store_true")
    a = ap.parse_args(); rng = np.random.default_rng(7); out = {}
    for cam in a.cams.split(","):
        rows = json.load(open(f"{a.sei}/sei-{cam}.json"))["rows"]; tr = np.load(f"{a.tracks}/tr-{cam}.npz")
        path = Path(rows); ft = np.array([r["t"] for r in rows]); w, h = int(tr["w"]), int(tr["h"])
        nf = int(tr["nframes"])
        if nf != len(ft): print(f"{cam}: {nf} frames vs {len(ft)} telemetry rows", file=sys.stderr); ft = ft[:nf] if len(ft) > nf else ft
        pairs = load_pairs(tr, path, ft, float(tr["scale"]), rng)
        pb = Problem(cam, pairs, path, ft, w, h, PRIOR[cam]["pos"])
        print(f"{cam}: {len(pairs)} pairs, {len(pb.u0)} matches", file=sys.stderr)
        small = Problem(cam, [pairs[k] for k in rng.choice(len(pairs), min(150, len(pairs)), replace=False)], path, ft, w, h, PRIOR[cam]["pos"])
        r = solve(pb, small, PRIOR[cam], a.quick); q = r.x
        res = np.abs(pb.residual(q, raw=True))[pb.w8 > 0]
        g = ground_height(pb, q, rng)
        yaw = (math.degrees(q[0]) + 180) % 360 - 180
        f = q[3]; th_edge = None
        # horizontal field of view: angle at the picture's left/right edge through the centre row
        b = unproject(np.array([0.0, w - 1.0]), np.array([h / 2, h / 2]), q[3:9], w, h)
        hfov = math.degrees(math.acos(np.clip(b[0] @ b[1], -1, 1))) if b[0][2] > -1 else None
        hfov = math.degrees(math.atan2(np.linalg.norm(b[0][:2]), b[0][2]) + math.atan2(np.linalg.norm(b[1][:2]), b[1][2]))
        out[cam] = dict(yaw=round(yaw, 2), pitch=round(math.degrees(q[1]), 2), roll=round(math.degrees(q[2]), 2),
                        f=round(f, 5), cx=round(q[4], 5), cy=round(q[5], 5), k=[round(v, 5) for v in q[6:9]],
                        hfov=round(hfov, 1), delay=round(q[9], 4), width=w, height=h, scale=float(tr["scale"]),
                        pos=PRIOR[cam]["pos"], ground=g,
                        fit=dict(pairs=len(pairs), matches=int(len(pb.u0)), inliers=int((pb.w8 > 0).sum()),
                                 median_px=round(float(np.median(res)), 3), cost=float(r.cost)),
                        body_rms_deg=round(math.degrees(float(np.sqrt(np.mean(q[pb.NG:] ** 2)))), 3))
        print(json.dumps({cam: out[cam]}), file=sys.stderr)
    json.dump(out, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
