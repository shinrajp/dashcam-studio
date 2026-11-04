"""common.py — the six-camera rig, the car's path and the virtual pinhole views shared by the splat experiment scripts.

The rig (lens, mounting, body boxes, clocks) is read from js/rig.js itself (through node), so this experiment uses
exactly what the app uses. The car's path is tools/rig/calibrate.py's Path (rear-axle bicycle model from the SEI speed
and heading).

Frames:
  car   x right, y up, z forward (js/rig.js; left-handed as written)
  world car frame at the start of the stretch with y flipped: x right, y DOWN, z forward (right-handed, like OpenCV), so
        COLMAP's camera rotations are proper rotations. Road ≈ y = 0, things above the road have y < 0.
  cv    camera axes x right, y down, z forward (COLMAP / OpenCV).
"""
import json, math, os, subprocess, sys
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tools", "rig"))
from calibrate import Path, Ry  # noqa: E402

CAMS = ["front", "back", "left_pillar", "right_pillar", "left_repeater", "right_repeater"]
D2R = math.pi / 180
S = np.diag([1.0, -1.0, 1.0])  # car ↔ world / GL ↔ cv axis flip

# Virtual level pinhole view per camera: output size, horizontal field of view, pitch (deg). Yaw is the camera's own.
VIEW = {
    "front":          dict(w=960, h=624, hfov=44, pitch=-1),
    "back":           dict(w=960, h=624, hfov=110, pitch=-18),
    "left_pillar":    dict(w=960, h=624, hfov=80, pitch=-5),
    "right_pillar":   dict(w=960, h=624, hfov=80, pitch=-5),
    "left_repeater":  dict(w=960, h=624, hfov=80, pitch=-5),
    "right_repeater": dict(w=960, h=624, hfov=80, pitch=-5),
}
# telemetry delay per camera on this drive (tools/rig/calibrate.py fit, /tmp rig-final.json): video t + delay = telemetry t
DELAY = {"front": -0.0668, "back": -0.0486, "left_pillar": 0.0382, "right_pillar": 0.0094, "left_repeater": -0.0648, "right_repeater": 0.0382}


def load_rig():
    js = "const r=require(%r);console.log(JSON.stringify({M:r.MEASURED,C:r.CLOCK0,B:r.BODY,A:r.ASPECT}))" % os.path.join(ROOT, "js", "rig.js")
    o = json.loads(subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True).stdout)
    return o["M"], o["C"], o["B"], o["A"]


RIG, CLOCK0, BODY, ASPECT = load_rig()


def rot(yaw, pitch, roll):
    """camera GL (x right, y up, z forward) → car rotation, as js/rig.js rot() (degrees)."""
    cy, sy, cp, sp, cr, sr = [f(a * D2R) for a in (yaw, pitch, roll) for f in (math.cos, math.sin)]
    Ryy = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]); Rx = np.array([[1, 0, 0], [0, cp, sp], [0, -sp, cp]])
    Rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
    return Ryy @ Rx @ Rz


def kb(th, k):
    t2 = th * th; return th * (1 + t2 * (k[0] + t2 * (k[1] + t2 * k[2])))


def fisheye_project(cam, d_car, W, H):
    """car-axis directions (N,3) → source pixels (N,2) and θ (deg), as js/rig.js pixel()."""
    c = RIG[cam]; M = rot(c["yaw"], c["pitch"], c["roll"]); b = d_car @ M  # = Mᵀ d
    n = np.linalg.norm(b, axis=1); th = np.arccos(np.clip(b[:, 2] / n, -1, 1))
    r = c["f"] * kb(th, c["k"]); l = np.maximum(np.hypot(b[:, 0], b[:, 1]), 1e-12)
    u = 0.5 + c["cx"] + r * b[:, 0] / l; v = 0.5 + (c["cy"] - r * b[:, 1] / l) / ASPECT
    return np.stack([u * W, v * H], 1), th / D2R


def fisheye_ray(cam, px, W, H):
    """source pixels (N,2) → unit directions in car axes (as js/rig.js ray())."""
    c = RIG[cam]; u, v = px[:, 0] / W, px[:, 1] / H
    dx = (u - 0.5 - c["cx"]) / c["f"]; dy = ((v - 0.5) * ASPECT - c["cy"]) / c["f"]; rho = np.hypot(dx, dy); th = rho.copy()
    k = c["k"]
    for _ in range(8):
        t2 = th * th; dr = 1 + t2 * (3 * k[0] + t2 * (5 * k[1] + t2 * 7 * k[2]))
        th = np.maximum(0, th - (kb(th, k) - rho) / np.maximum(0.05, dr))
    s = np.where(rho > 1e-9, np.sin(th) / np.maximum(rho, 1e-9), 1.0)
    b = np.stack([dx * s, -dy * s, np.cos(th)], 1)
    return b @ rot(c["yaw"], c["pitch"], c["roll"]).T


def is_body(cam, d):
    """does each car-axis ray from the camera hit the car's own body boxes? (js/rig.js isBody, vectorised)"""
    o = np.array(RIG[cam]["pos"])[None] + d * 0.03; hit = np.zeros(len(d), bool)
    for b in BODY:
        if b.get("not") and cam in b["not"]: continue
        t0 = np.zeros(len(d)); t1 = np.full(len(d), 6.0); bad = np.zeros(len(d), bool)
        for lo, hi, ax in [(-b["x"], b["x"], 0), (b["y0"], b["y1"], 1), (b["z0"], b["z1"], 2)]:
            di = d[:, ax]; oi = o[:, ax]; small = np.abs(di) < 1e-9
            bad |= small & ((oi < lo) | (oi > hi))
            dd = np.where(small, 1e-9, di); a = (lo - oi) / dd; e = (hi - oi) / dd
            t0 = np.maximum(t0, np.where(small, -np.inf, np.minimum(a, e))); t1 = np.minimum(t1, np.where(small, np.inf, np.maximum(a, e)))
        hit |= (~bad) & (t0 <= t1)
    return hit


def view(cam):
    """virtual pinhole: (W, H, f, R_car_gl) — R maps the view's GL axes to car axes."""
    v = VIEW[cam]; f = v["w"] / 2 / math.tan(v["hfov"] / 2 * D2R)
    return v["w"], v["h"], f, rot(RIG[cam]["yaw"], v["pitch"], 0)


def view_rays(cam):
    """car-axis unit ray of every pixel centre of the virtual view (H, W, 3)."""
    W, H, f, R = view(cam)
    x, y = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    g = np.stack([(x - W / 2) / f, -(y - H / 2) / f, np.ones_like(x)], -1).reshape(-1, 3)
    g /= np.linalg.norm(g, axis=1, keepdims=True)
    return (g @ R.T).reshape(H, W, 3)


def remap_tables(cam, srcW, srcH):
    """cv2.remap maps from the source fisheye to the virtual view, and the valid mask (inside the lens's reach, not body)."""
    d = view_rays(cam).reshape(-1, 3); H, W = VIEW[cam]["h"], VIEW[cam]["w"]
    px, th = fisheye_project(cam, d, srcW, srcH)
    ok = (th < RIG[cam]["thmax"] * 1.1) & (px[:, 0] >= 0) & (px[:, 0] < srcW) & (px[:, 1] >= 0) & (px[:, 1] < srcH) & ~is_body(cam, d)
    return px[:, 0].reshape(H, W).astype(np.float32) - 0.5, px[:, 1].reshape(H, W).astype(np.float32) - 0.5, ok.reshape(H, W)


def load_sei(sei_dir, cam):
    return json.load(open(os.path.join(sei_dir, f"sei-{cam}.json")))["rows"]


class Drive:
    """car poses on the front camera's telemetry clock, world = car frame at t_ref (y flipped)."""

    def __init__(self, sei_dir, t_ref, use_delay=True):
        self.path = Path(load_sei(sei_dir, "front")); self.t_ref = t_ref; self.use_delay = use_delay
        self.ts = {c: np.array([r["t"] for r in load_sei(sei_dir, c)]) for c in CAMS}

    def ref_time(self, cam, t_clip):
        """a camera's clip time → the front telemetry time of the same moment."""
        # picture at clip t shows the moment its own telemetry labels t + delay; CLOCK0 maps that label to the front's
        return t_clip + CLOCK0[cam] + (DELAY[cam] if self.use_delay else 0.0)

    def car_pose(self, t_front):
        """car at front-telemetry time t → (R, T): X_car0 = R·X_car + T."""
        R, T = self.path.rel(self.t_ref, t_front); return R, T

    def car_to_world(self, t_front):
        R, T = self.car_pose(t_front); return S @ R @ S, S @ T  # X_w = Rw·X_car' + Tw where X_car' = S X_car

    def cam_to_world(self, cam, t_front):
        """virtual view's cv axes → world: (R_wc, C)."""
        R, T = self.car_pose(t_front); W, H, f, Rv = view(cam)
        Rcar = R @ Rv @ S  # cv → GL (S) → car(t) → car0
        Rw = S @ Rcar; C = S @ (R @ np.array(RIG[cam]["pos"]) + T)
        return Rw, C


def qvec(R):
    """rotation matrix → COLMAP quaternion (w, x, y, z)."""
    t = np.trace(R)
    if t > 0:
        s = math.sqrt(t + 1) * 2; return np.array([s / 4, (R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s])
    i = int(np.argmax(np.diag(R)))
    if i == 0:
        s = math.sqrt(1 + R[0, 0] - R[1, 1] - R[2, 2]) * 2; return np.array([(R[2, 1] - R[1, 2]) / s, s / 4, (R[0, 1] + R[1, 0]) / s, (R[0, 2] + R[2, 0]) / s])
    if i == 1:
        s = math.sqrt(1 + R[1, 1] - R[0, 0] - R[2, 2]) * 2; return np.array([(R[0, 2] - R[2, 0]) / s, (R[0, 1] + R[1, 0]) / s, s / 4, (R[1, 2] + R[2, 1]) / s])
    s = math.sqrt(1 + R[2, 2] - R[0, 0] - R[1, 1]) * 2; return np.array([(R[1, 0] - R[0, 1]) / s, (R[0, 2] + R[2, 0]) / s, (R[1, 2] + R[2, 1]) / s, s / 4])
