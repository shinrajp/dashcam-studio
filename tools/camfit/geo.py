"""Camera geometry, the same model as js/pano.js: world x right, y up, z forward (metres, car frame);
camera→world R = Ry(yaw)·Rx(pitch)·Rz(roll); lens "rect" (pinhole, r = tanθ/tan(half)) or "kb" (fisheye, k=0: r = θ/half)."""
import numpy as np
CAMS = ["front", "left_pillar", "right_pillar", "left_repeater", "right_repeater", "back"]
DEFAULTS = {
  "front":          dict(yaw=0,    pitch=-3,  roll=0, fov=70,  model="rect", pos=[0, 1.3, 0.6]),
  "back":           dict(yaw=180,  pitch=-18, roll=0, fov=125, model="kb",   pos=[0, 1.0, -2.3]),
  "left_pillar":    dict(yaw=-58,  pitch=-6,  roll=0, fov=90,  model="kb",   pos=[-0.85, 1.2, -0.1]),
  "right_pillar":   dict(yaw=58,   pitch=-6,  roll=0, fov=90,  model="kb",   pos=[0.85, 1.2, -0.1]),
  "left_repeater":  dict(yaw=-132, pitch=-8,  roll=0, fov=85,  model="kb",   pos=[-0.95, 0.9, 1.2]),
  "right_repeater": dict(yaw=132,  pitch=-8,  roll=0, fov=85,  model="kb",   pos=[0.95, 0.9, 1.2]),
}
ASPECT = {c: 938 / 1448 for c in CAMS}; ASPECT["front"] = 1876 / 2896
rad = np.radians
import os
VCONV = os.environ.get("VCONV", "phys")
def rot(yaw, pitch, roll):
    cy, sy, cp, sp, cr, sr = np.cos(rad(yaw)), np.sin(rad(yaw)), np.cos(rad(pitch)), np.sin(rad(pitch)), np.cos(rad(roll)), np.sin(rad(roll))
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]); Rx = np.array([[1, 0, 0], [0, cp, sp], [0, -sp, cp]]); Rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
    return Ry @ Rx @ Rz
def ray(c, u, v, aspect):
    """pixel (u, v in 0..1) → unit direction in the car frame (inverse of pano.js N.project)."""
    dx = (u - 0.5) * 2
    # VCONV "pano": as js/pano.js (vertical offset × aspect); "phys": square pixels (vertical offset in width units = (v-0.5)·h/w)
    dy = -(v - 0.5) * 2 / aspect if VCONV == "pano" else -(v - 0.5) * 2 * aspect
    r = np.hypot(dx, dy); half = rad(c["fov"] / 2)
    th = np.arctan(r * np.tan(half)) if c["model"] == "rect" else r * half
    s = np.where(r > 1e-9, np.sin(th) / np.maximum(r, 1e-9), 0)
    p = np.stack([dx * s, dy * s, np.cos(th)], -1)
    return p @ rot(c["yaw"], c["pitch"], c["roll"]).T
def ground(c, u, v, aspect, max_r=60):
    """where the ray through (u, v) meets the road (y = 0): [x, z] metres, or None above the horizon / too far."""
    d = ray(c, np.asarray(u, float), np.asarray(v, float), aspect); P = np.array(c["pos"], float)
    t = -P[1] / np.minimum(d[..., 1], -1e-6)
    g = P[None if d.ndim > 1 else ...] + (t[..., None] * d) if d.ndim > 1 else P + t * d
    ok = (d[..., 1] < -0.01) & (np.hypot(g[..., 0], g[..., 2]) < max_r)
    return g[..., [0, 2]], ok
def azimuth(c, u, v, aspect):
    d = ray(c, np.asarray(u, float), np.asarray(v, float), aspect); return np.degrees(np.arctan2(d[..., 0], d[..., 2]))
