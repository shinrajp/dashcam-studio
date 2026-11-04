"""rig.py — the six-camera rig, the car's path and the level pinhole views of the depth replay (from the prototype's
experiments/depth3d/common.py, without its drive-specific tables).

The rig (lens, mounting, body boxes) is js/rig.js's — MEASURED, which includes the 2026-11 road fine-tune of the angles, or a
rig JSON loaded through js/rig.js set() — handed over by telemetry.js, so the tool uses exactly what the app uses. The car's
path is the rear-axle bicycle model of tools/rig/calibrate.py (speed + heading from the front file's telemetry).

Frames:
  car   x right, y up, z forward (js/rig.js)
  world car frame at the start of the stretch with y flipped: x right, y DOWN, z forward (OpenCV-like). Road ≈ y = 0.
  cv    view axes x right, y down, z forward.
"""
import math
import numpy as np

CAMS = ["front", "back", "left_pillar", "right_pillar", "left_repeater", "right_repeater"]
D2R = math.pi / 180
S = np.diag([1.0, -1.0, 1.0])  # car ↔ world / GL ↔ cv axis flip

# Virtual level pinhole view per camera: output size, horizontal field of view, pitch (deg). Yaw is the camera's own, roll 0.
VIEW = {
    "front":          dict(w=960, h=624, hfov=44, pitch=-1),
    "back":           dict(w=960, h=624, hfov=110, pitch=-18),
    "left_pillar":    dict(w=960, h=624, hfov=80, pitch=-5),
    "right_pillar":   dict(w=960, h=624, hfov=80, pitch=-5),
    "left_repeater":  dict(w=960, h=624, hfov=80, pitch=-5),
    "right_repeater": dict(w=960, h=624, hfov=80, pitch=-5),
}


def rot(yaw, pitch, roll):
    """camera GL (x right, y up, z forward) → car rotation, as js/rig.js rot() (degrees)."""
    cy, sy, cp, sp, cr, sr = [f(a * D2R) for a in (yaw, pitch, roll) for f in (math.cos, math.sin)]
    Ryy = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]); Rx = np.array([[1, 0, 0], [0, cp, sp], [0, -sp, cp]])
    Rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
    return Ryy @ Rx @ Rz


def Ry(a):
    c, s = math.cos(a), math.sin(a); return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def kb(th, k):
    t2 = th * th; return th * (1 + t2 * (k[0] + t2 * (k[1] + t2 * k[2])))


class Path:
    """Rear-axle path from speed + heading (as tools/rig/calibrate.py Path; world: east, north; heading clockwise from north)."""

    def __init__(self, rows):
        t = np.array([r["t"] for r in rows]); v = np.array([r.get("speed", 0.0) for r in rows])
        h = np.unwrap(np.radians([r.get("heading", 0.0) for r in rows]))
        self.g = np.arange(t[0] - 1, t[-1] + 1, 0.002)
        self.v = np.interp(self.g, t, v); self.h = np.interp(self.g, t, h)
        dt = np.diff(self.g, prepend=self.g[0])
        self.e = np.cumsum(self.v * dt * np.sin(self.h)); self.n = np.cumsum(self.v * dt * np.cos(self.h))
        self.t, self.speed = t, v

    def at(self, t):
        return np.interp(t, self.g, self.e), np.interp(t, self.g, self.n), np.interp(t, self.g, self.h)

    def rel(self, t0, t1):
        """car pose at t1 in car-at-t0 coordinates: X0 = R·X1 + T."""
        e0, n0, h0 = self.at(t0); e1, n1, h1 = self.at(t1)
        de, dn = e1 - e0, n1 - n0
        T = np.array([de * math.cos(h0) - dn * math.sin(h0), 0.0, de * math.sin(h0) + dn * math.cos(h0)])
        return Ry(h1 - h0), T


class Rig:
    """cams: { cam: js/rig.js camera (yaw, pitch, roll, f, cx, cy, k, thmax, pos[, delay]) }, body: js/rig.js body boxes."""

    def __init__(self, cams, body, aspect):
        self.cams, self.body, self.aspect = cams, body, aspect

    @classmethod
    def from_telemetry(cls, tel):
        return cls(tel["rig"], tel["body"], tel["aspect"])

    def R(self, cam):
        c = self.cams[cam]; return rot(c["yaw"], c["pitch"], c["roll"])

    def pos(self, cam):
        return np.array(self.cams[cam]["pos"], float)

    def fisheye_project(self, cam, d_car, W, H):
        """car-axis directions (N,3) → source pixels (N,2) and θ (deg), as js/rig.js pixel()."""
        c = self.cams[cam]; b = d_car @ self.R(cam)  # = Mᵀ d
        n = np.linalg.norm(b, axis=1); th = np.arccos(np.clip(b[:, 2] / n, -1, 1))
        r = c["f"] * kb(th, c["k"]); l = np.maximum(np.hypot(b[:, 0], b[:, 1]), 1e-12)
        u = 0.5 + c["cx"] + r * b[:, 0] / l; v = 0.5 + (c["cy"] - r * b[:, 1] / l) / self.aspect
        return np.stack([u * W, v * H], 1), th / D2R

    def fisheye_ray(self, cam, px, W, H):
        """source pixels (N,2) → unit directions in car axes (as js/rig.js ray())."""
        c = self.cams[cam]; u, v = px[:, 0] / W, px[:, 1] / H
        dx = (u - 0.5 - c["cx"]) / c["f"]; dy = ((v - 0.5) * self.aspect - c["cy"]) / c["f"]; rho = np.hypot(dx, dy); th = rho.copy()
        k = c["k"]
        for _ in range(8):
            t2 = th * th; dr = 1 + t2 * (3 * k[0] + t2 * (5 * k[1] + t2 * 7 * k[2]))
            th = np.maximum(0, th - (kb(th, k) - rho) / np.maximum(0.05, dr))
        s = np.where(rho > 1e-9, np.sin(th) / np.maximum(rho, 1e-9), 1.0)
        b = np.stack([dx * s, -dy * s, np.cos(th)], 1)
        return b @ self.R(cam).T

    def is_body(self, cam, d):
        """does each car-axis ray from the camera hit the car's own body boxes? (js/rig.js isBody, vectorised)"""
        o = self.pos(cam)[None] + d * 0.03; hit = np.zeros(len(d), bool)
        for b in self.body:
            if b.get("not") and cam in b["not"]: continue
            t0 = np.zeros(len(d)); t1 = np.full(len(d), 6.0); bad = np.zeros(len(d), bool)
            for lo, hi, ax in [(-b["x"], b["x"], 0), (b["y0"], b["y1"], 1), (b["z0"], b["z1"], 2)]:
                di = d[:, ax]; oi = o[:, ax]; small = np.abs(di) < 1e-9
                bad |= small & ((oi < lo) | (oi > hi))
                dd = np.where(small, 1e-9, di); a = (lo - oi) / dd; e = (hi - oi) / dd
                t0 = np.maximum(t0, np.where(small, -np.inf, np.minimum(a, e))); t1 = np.minimum(t1, np.where(small, np.inf, np.maximum(a, e)))
            hit |= (~bad) & (t0 <= t1)
        return hit

    def view(self, cam):
        """virtual level pinhole: (W, H, f, R_car_gl) — R maps the view's GL axes to car axes."""
        v = VIEW[cam]; f = v["w"] / 2 / math.tan(v["hfov"] / 2 * D2R)
        return v["w"], v["h"], f, rot(self.cams[cam]["yaw"], v["pitch"], 0)

    def view_rays(self, cam):
        """car-axis unit ray of every pixel centre of the virtual view (H, W, 3)."""
        W, H, f, R = self.view(cam)
        x, y = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
        g = np.stack([(x - W / 2) / f, -(y - H / 2) / f, np.ones_like(x)], -1).reshape(-1, 3)
        g /= np.linalg.norm(g, axis=1, keepdims=True)
        return (g @ R.T).reshape(H, W, 3)

    def remap_tables(self, cam, srcW, srcH):
        """cv2.remap maps from the source fisheye to the virtual view, and the valid mask (inside the lens's reach, not body)."""
        d = self.view_rays(cam).reshape(-1, 3); H, W = VIEW[cam]["h"], VIEW[cam]["w"]
        px, th = self.fisheye_project(cam, d, srcW, srcH)
        ok = (th < self.cams[cam]["thmax"] * 1.1) & (px[:, 0] >= 0) & (px[:, 0] < srcW) & (px[:, 1] >= 0) & (px[:, 1] < srcH) & ~self.is_body(cam, d)
        return px[:, 0].reshape(H, W).astype(np.float32) - 0.5, px[:, 1].reshape(H, W).astype(np.float32) - 0.5, ok.reshape(H, W)

    def raw_to_view(self, cam, uv01):
        """raw picture points (N,2, 0..1) → pixels of the level view (N,2), NaN where behind the view."""
        d = self.fisheye_ray(cam, np.asarray(uv01, float), 1.0, 1.0)
        W, H, f, R = self.view(cam); g = d @ R  # car → view GL
        z = g[:, 2]; ok = z > 1e-3; zz = np.where(ok, z, 1)
        u = W / 2 + f * g[:, 0] / zz; v = H / 2 - f * g[:, 1] / zz
        return np.where(ok[:, None], np.stack([u, v], 1), np.nan)


class Drive:
    """car poses on the front camera's telemetry clock, world = car frame at t_ref (y flipped).
    clocks: js/rig.js clockOffsets (cam clip t + clock = front clip t of the same moment); delays: per camera, video t + delay
    = that file's telemetry t (calibrate.py)."""

    def __init__(self, rig, front_rows, t_ref, clocks, delays):
        self.rig, self.path, self.t_ref, self.clocks, self.delays = rig, Path(front_rows), t_ref, clocks, delays

    def ref_time(self, cam, t_clip):
        """a camera's clip time → the front telemetry time of the moment its picture shows."""
        return t_clip + self.clocks.get(cam, 0.0) + self.delays.get(cam, 0.0)

    def car_pose(self, t_front):
        return self.path.rel(self.t_ref, t_front)

    def cam_to_world(self, cam, t_front):
        """virtual view's cv axes → world: (R_wc, C)."""
        R, T = self.car_pose(t_front); W, H, f, Rv = self.rig.view(cam)
        Rw = S @ (R @ Rv @ S); C = S @ (R @ self.rig.pos(cam) + T)
        return Rw, C
