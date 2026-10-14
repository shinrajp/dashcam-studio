#!/usr/bin/env python3
"""Generate realistic-looking MOCK-UP TeslaCam footage (procedural, no real footage) for demos and README screenshots.

A tiny 3D painter's-algorithm renderer draws a stylised suburban street on a sunny afternoon: sky with sun and clouds,
a 4-lane road with lane markings, parking lanes, curbs, sidewalks, trees, houses, parked and moving cars (generic
"DEMO" plates), a cyclist, a pedestrian silhouette and a signalised intersection. All six cameras look at the same
world from Tesla-like mounting points, then get a slight fisheye, vignette and sensor noise.

The drive's embedded SEI telemetry matches the picture: Self-Driving cruise at ~30 mph, left blinker + steering
during a lane change, braking to a stop at a red light, GPS following the same path.

Usage: python3 tools/make-mock-footage.py OUT_DIR [--encrypted] [--full] [--jobs N]
Creates OUT_DIR/TeslaCam/{SavedClips,SentryClips,RecentClips}/... like tools/make-samples.py.
--full renders HW4 resolutions (2896x1876 front); default is the "quick" sizes (1448x938 front, 724x470 sides).
"""
import base64, importlib.util, json, math, os, random, subprocess, sys, tempfile
from multiprocessing import Pool
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("make_samples", os.path.join(HERE, "make-samples.py"))
MS = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(MS)
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FPS = 36

# ───────────────────────── world layout (metres; x right, y forward along the road, z up) ─────────────────────────
LANE = 3.6
CURB = 9.6              # curb line (each side); lanes ±0..7.2, parking 7.2..9.6
SIDEWALK = (10.8, 12.6)  # planting strip 9.6..10.8 (trees), sidewalk, then front yards
SUN_AZ, SUN_EL = math.radians(-35), math.radians(38)     # sun ahead-left, afternoon
SUN = np.array([math.sin(SUN_AZ) * math.cos(SUN_EL), math.cos(SUN_AZ) * math.cos(SUN_EL), math.sin(SUN_EL)])
HAZE = np.array([206, 214, 222], float)

def smooth(a, b, t):
    if t <= a: return 0.0
    if t >= b: return 1.0
    u = (t - a) / (b - a); return u * u * (3 - 2 * u)

def stop_profile(t, v0, s0, s_stop, decel):
    """Cruise at v0 from s0, then brake at `decel` to stop exactly at s_stop. Returns (s, v, braking)."""
    d_brake = v0 * v0 / (2 * decel)
    tb = max(0.0, (s_stop - d_brake - s0) / v0)
    if t <= tb: return s0 + v0 * t, v0, False
    u = t - tb; ts = v0 / decel
    if u >= ts: return s_stop, 0.0, True
    return s0 + v0 * tb + v0 * u - 0.5 * decel * u * u, v0 - decel * u, True

class Scenario:
    """Ego drive + every moving actor, as functions of time."""
    def __init__(self, kind, total, seed):
        self.kind, self.total, self.seed = kind, total, seed
        if kind == "drive":
            self.v0 = 13.4                        # 30 mph
            self.t_brake = 8.4; self.decel = 4.2
            self.s_stop = self.v0 * self.t_brake + self.v0 ** 2 / (2 * self.decel)
            self.stop_line = self.s_stop + 3.4     # car front (+2.4) stops ~1 m before the line
            self.y_int = self.stop_line + 13.0     # cross-street centre
            self.lc = (2.6, 5.4); self.blink = (2.0, 5.6)
        elif kind == "recent":
            self.v0 = 11.0; self.t_brake = 99; self.decel = 4.0
            self.s_stop = 1e9; self.stop_line = 1e9; self.y_int = 1e9
            self.lc = (99, 100); self.blink = (99, 100)
        else:  # sentry: parked at the right curb
            self.v0 = 0.0; self.stop_line = 1e9; self.y_int = 1e9; self.lc = (99, 100); self.blink = (99, 100)

    def ego(self, t):
        if self.kind == "sentry": return 8.4, 0.0, 0.0, 0.0, False
        if t <= self.t_brake: s, v, br = self.v0 * t, self.v0, False
        else:
            u = t - self.t_brake; ts = self.v0 / self.decel
            if u >= ts: s, v, br = self.s_stop, 0.0, True
            else: s, v, br = self.v0 * self.t_brake + self.v0 * u - 0.5 * self.decel * u * u, self.v0 - self.decel * u, True
        a, b = self.lc
        x = 5.4 - 3.6 * smooth(a, b, t)
        eps = 1e-3
        dx = (-3.6 * (smooth(a, b, t + eps) - smooth(a, b, t - eps)) / (2 * eps))
        yaw = math.atan2(dx, max(v, 0.5)) if v > 0.1 else 0.0
        return x, s, yaw, v, br

    def light(self, t):
        if self.kind != "drive": return "green"
        return "green" if t < 7.6 else ("yellow" if t < 8.9 else "red")

    def actors(self, t):
        """Moving cars, cyclist, pedestrians at time t: list of dicts."""
        out = []
        if self.kind == "drive":
            # lead car in the right lane, slower; we pass it, then it stops for the red light beside/behind us
            s, v, br = stop_profile(t, 9.2, 26.0, self.s_stop - 3.0, 3.6)
            out.append(dict(type="car", x=5.4, y=s, yaw=0, color=(178, 34, 40), brake=br or t > 8.9, plate="DEMO 123"))
            # following car: left lane, ends up right behind us
            s, v, br = stop_profile(t, 13.4, -20.0, self.s_stop - 7.6, 4.6)
            out.append(dict(type="car", x=1.8, y=s, yaw=0, color=(40, 70, 128), brake=br, plate="DEMO 456", suv=True))
            # oncoming traffic
            for y0, x, col in ((150, -1.8, (230, 230, 226)), (215, -5.4, (60, 62, 66)), (95, -5.4, (196, 160, 60)), (290, -1.8, (150, 152, 158))):
                out.append(dict(type="car", x=x, y=y0 - 12.5 * t, yaw=math.pi, color=col, brake=False, plate=""))
            # cross traffic starts when our light is red
            if t > 9.6:
                out.append(dict(type="car", x=-40 + 12 * (t - 9.6) * 1.0, y=self.y_int + 2.2, yaw=math.pi / 2, color=(236, 236, 236), brake=False, plate=""))
            # cyclist in the right parking lane gap
            out.append(dict(type="bike", x=8.2, y=58 + 5.2 * t, yaw=0, phase=t * 5.0))
            # pedestrian on the left sidewalk
            out.append(dict(type="person", x=-11.6, y=70 + 1.3 * t, yaw=0, phase=t * 6.0, color=(70, 76, 92)))
        elif self.kind == "recent":
            out.append(dict(type="car", x=5.4, y=34 + 10.0 * t, yaw=0, color=(235, 235, 232), brake=False, plate="DEMO 789"))
            for y0, x, col in ((80, -1.8, (35, 80, 60)), (140, -5.4, (180, 40, 40))):
                out.append(dict(type="car", x=x, y=y0 - 12 * t, yaw=math.pi, color=col, brake=False, plate=""))
        else:
            # a faceless walker passes along the right sidewalk, from behind to in front of the parked car
            out.append(dict(type="person", x=11.5, y=-7.5 + 1.45 * t, yaw=0, phase=t * 6.4, color=(52, 56, 66)))
            out.append(dict(type="car", x=1.8, y=-60 + 12 * t, yaw=0, color=(120, 122, 128), brake=False, plate="DEMO 321"))
            out.append(dict(type="car", x=-5.4, y=90 - 11 * t, yaw=math.pi, color=(30, 60, 120), brake=False, plate=""))
        return out

    def telemetry(self):
        rows = []
        lat0, lon0, H = 37.39440, -122.15030, 35.0
        n = int(round(self.total * FPS)); dt = 1.0 / FPS
        h = math.radians(H)
        fwd = (math.cos(h), math.sin(h)); right = (math.cos(h + math.pi / 2), math.sin(h + math.pi / 2))  # (north, east)
        for k in range(n):
            t = k * dt
            x, s, yaw, v, br = self.ego(t)
            x2, s2, _, v2, _ = self.ego(t + dt)
            x0, s0, _, v0, _ = self.ego(max(0, t - dt))
            acc = (v2 - v0) / (2 * dt) if k else 0.0
            xdd = ((x2 - x) - (x - x0)) / (dt * dt)
            steer = 0.0
            if v > 1: steer = math.degrees(math.atan(2.9 * xdd / (v * v))) * 15.0
            north = s * fwd[0] + (x - 5.4) * right[0]; east = s * fwd[1] + (x - 5.4) * right[1]
            lat = lat0 + north / 111320.0; lon = lon0 + east / (111320.0 * math.cos(math.radians(lat0)))
            a, b = self.blink
            bl = a <= t < b and int((t - a) / 0.36) % 2 == 0
            ap = 1 if (self.kind == "drive" and t < 10.6) else (3 if self.kind == "recent" else 0)
            braking = br or (v == 0)
            rows.append(dict(gear=1, seq=k, speed=v, pedal=0.0 if braking else 0.19 + 0.02 * math.sin(t), steer=steer, bl=bl, br=False,
                             brake=braking, ap=ap, lat=lat, lon=lon, heading=(H + math.degrees(yaw)) % 360,
                             ax=acc, ay=xdd, az=9.81))
        return rows

# ───────────────────────── static scenery ─────────────────────────
def shade(col, n):
    """Lambert-ish shading of an RGB colour for a face with unit normal n."""
    k = 0.62 + 0.45 * max(0.0, float(np.dot(n, SUN))) + 0.08 * n[2]
    return tuple(min(255, max(0, c * k)) for c in col)

def box_faces(x0, x1, y0, y1, z0, z1, col, top=None, skip_bottom=True, taper=0.0):
    """Faces of an axis-aligned box (optionally tapered top, for car cabins). Returns list of (pts, normal, colour)."""
    tx = (x1 - x0) * taper; ty = (y1 - y0) * taper
    b = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)]
    u = [(x0 + tx, y0 + ty, z1), (x1 - tx, y0 + ty, z1), (x1 - tx, y1 - ty, z1), (x0 + tx, y1 - ty, z1)]
    F = [([b[0], b[1], u[1], u[0]], (0, -1, 0)), ([b[1], b[2], u[2], u[1]], (1, 0, 0)), ([b[2], b[3], u[3], u[2]], (0, 1, 0)),
         ([b[3], b[0], u[0], u[3]], (-1, 0, 0)), ([u[0], u[1], u[2], u[3]], (0, 0, 1))]
    if not skip_bottom: F.append(([b[3], b[2], b[1], b[0]], (0, 0, -1)))
    out = []
    for pts, n in F:
        c = top if (n[2] == 1 and top is not None) else col
        out.append((pts, np.array(n, float), c))
    return out

def gable_roof(x0, x1, y0, y1, z0, h, col, along_y=True):
    out = []
    if along_y:
        xm = (x0 + x1) / 2
        out.append(([(x0, y0, z0), (x0, y1, z0), (xm, y1, z0 + h), (xm, y0, z0 + h)], np.array([-h, 0, (xm - x0)]) / math.hypot(h, xm - x0), col))
        out.append(([(x1, y1, z0), (x1, y0, z0), (xm, y0, z0 + h), (xm, y1, z0 + h)], np.array([h, 0, (xm - x0)]) / math.hypot(h, xm - x0), col))
        out.append(([(x0, y0, z0), (xm, y0, z0 + h), (x1, y0, z0)], np.array([0, -1.0, 0]), None))
        out.append(([(x1, y1, z0), (xm, y1, z0 + h), (x0, y1, z0)], np.array([0, 1.0, 0]), None))
    return out

class Obj:
    __slots__ = ("faces", "c", "r", "kind", "extra")
    def __init__(self, faces, c, r, kind="poly", extra=None):
        self.faces, self.c, self.r, self.kind, self.extra = faces, np.array(c, float), r, kind, extra

def build_static(sc):
    rnd = random.Random(sc.seed)
    ground = []   # (pts, colour) drawn in order
    objs = []
    Y0, Y1 = -160, 420
    grass = (98, 132, 64); yard = (104, 140, 66)
    ground.append(([(-400, Y0, 0), (400, Y0, 0), (400, Y1, 0), (-400, Y1, 0)], (102, 124, 70)))
    for sgn in (-1, 1):
        def X(a): return sgn * a
        ground.append(([(X(9.6), Y0, 0), (X(60), Y0, 0), (X(60), Y1, 0), (X(9.6), Y1, 0)], yard))
        ground.append(([(X(SIDEWALK[0]), Y0, 0.0), (X(SIDEWALK[1]), Y0, 0), (X(SIDEWALK[1]), Y1, 0), (X(SIDEWALK[0]), Y1, 0)], (196, 192, 182)))
        ground.append(([(X(9.6), Y0, 0), (X(9.9), Y0, 0), (X(9.9), Y1, 0), (X(9.6), Y1, 0)], (176, 172, 164)))  # curb top
    ground.append(([(-9.6, Y0, 0), (9.6, Y0, 0), (9.6, Y1, 0), (-9.6, Y1, 0)], (74, 76, 80)))  # asphalt
    # cross street
    if sc.y_int < 1e8:
        yi = sc.y_int
        ground.append(([(-400, yi - 9, 0), (400, yi - 9, 0), (400, yi + 9, 0), (-400, yi + 9, 0)], (74, 76, 80)))
        for sgn in (-1, 1):
            for yy in (yi - 10.8, yi + 9):
                ground.append(([(sgn * 9.6, yy, 0), (sgn * 400, yy, 0), (sgn * 400, yy + 1.8, 0), (sgn * 9.6, yy + 1.8, 0)], (196, 192, 182)))
        # stop line + crosswalk
        ground.append(([(0.2, sc.stop_line, 0), (7.2, sc.stop_line, 0), (7.2, sc.stop_line + 0.45, 0), (0.2, sc.stop_line + 0.45, 0)], (236, 236, 230)))
        for k in range(16):
            x = -8.6 + k * 1.15
            ground.append(([(x, sc.stop_line + 1.2, 0), (x + 0.6, sc.stop_line + 1.2, 0), (x + 0.6, sc.stop_line + 3.6, 0), (x, sc.stop_line + 3.6, 0)], (230, 230, 224)))
    # lane markings: double yellow, dashed whites, parking edge lines
    def seg_ok(y): return not (sc.y_int < 1e8 and sc.stop_line - 0.2 < y < sc.y_int + 9.5)
    for xo in (-0.18, 0.08):
        for ya in range(Y0, Y1, 20):
            if seg_ok(ya) and seg_ok(ya + 20):
                ground.append(([(xo, ya, 0), (xo + 0.1, ya, 0), (xo + 0.1, ya + 20, 0), (xo, ya + 20, 0)], (222, 184, 52)))
    for x in (-3.6, 3.6):
        for ya in range(Y0, Y1, 12):
            if seg_ok(ya) and seg_ok(ya + 3):
                ground.append(([(x - 0.07, ya, 0), (x + 0.07, ya, 0), (x + 0.07, ya + 3, 0), (x - 0.07, ya + 3, 0)], (232, 232, 228)))
    for x in (-7.2, 7.2):
        for ya in range(Y0, Y1, 20):
            if seg_ok(ya) and seg_ok(ya + 20):
                ground.append(([(x - 0.06, ya, 0), (x + 0.06, ya, 0), (x + 0.06, ya + 20, 0), (x - 0.06, ya + 20, 0)], (220, 220, 214)))
    def in_cross(y0, y1): return sc.y_int < 1e8 and y1 > sc.y_int - 12 and y0 < sc.y_int + 12
    # curbs as thin boxes
    for sgn in (-1, 1):
        for ya in range(Y0, Y1, 20):
            if in_cross(ya, ya + 20): continue
            x0, x1 = (9.6, 9.75) if sgn > 0 else (-9.75, -9.6)
            objs.append(Obj(box_faces(x0, x1, ya, ya + 20, 0, 0.15, (168, 166, 160)), (sgn * 9.7, ya + 10, 0.1), 10.1))
    # houses, hedges, driveways, trees
    house_cols = [(230, 220, 196), (214, 196, 170), (196, 210, 214), (232, 232, 226), (206, 188, 160), (176, 196, 178), (222, 204, 186), (190, 186, 200)]
    roof_cols = [(92, 74, 66), (70, 72, 80), (120, 82, 60), (84, 88, 96), (106, 60, 50)]
    for sgn in (-1, 1):
        y = Y0 + rnd.uniform(0, 8)
        while y < Y1:
            w = rnd.uniform(11, 16); d = rnd.uniform(9, 13); hgt = rnd.uniform(3.2, 6.4)
            if not in_cross(y - 3, y + w + 3):
                xs = 17 + rnd.uniform(0, 4); x0, x1 = (xs, xs + d) if sgn > 0 else (-xs - d, -xs)
                col = rnd.choice(house_cols); rc = rnd.choice(roof_cols)
                f = box_faces(x0, x1, y, y + w, 0, hgt, col)
                f += gable_roof(x0 - 0.5, x1 + 0.5, y - 0.4, y + w + 0.4, hgt, rnd.uniform(2.0, 3.2), rc)
                # windows / door / garage on the road-facing wall
                xf = (x0 - 0.03) if sgn > 0 else (x1 + 0.03); nrm = np.array([-sgn, 0, 0.0])
                for k in range(int(w // 3.6)):
                    yy = y + 1.4 + k * 3.6
                    if yy + 1.6 > y + w - 0.8: break
                    if k == 1:
                        f.append(([(xf, yy + 0.3, 0), (xf, yy + 1.3, 0), (xf, yy + 1.3, 2.2), (xf, yy + 0.3, 2.2)], nrm, (110, 74, 54)))
                    else:
                        f.append(([(xf, yy, 1.0), (xf, yy + 1.6, 1.0), (xf, yy + 1.6, 2.3), (xf, yy, 2.3)], nrm, (70, 92, 116)))
                    if hgt > 5.4:
                        f.append(([(xf, yy, 3.6), (xf, yy + 1.6, 3.6), (xf, yy + 1.6, 4.8), (xf, yy, 4.8)], nrm, (70, 92, 116)))
                objs.append(Obj(f, ((x0 + x1) / 2, y + w / 2, hgt / 2), math.hypot(d, w) / 2 + 3))
                # driveway
                dy = y + w - 3.6 if rnd.random() < 0.5 else y + 0.6
                dx0, dx1 = (SIDEWALK[1], x0) if sgn > 0 else (x1, -SIDEWALK[1])
                ground.append(([(dx0, dy, 0), (dx1, dy, 0), (dx1, dy + 3.0, 0), (dx0, dy + 3.0, 0)], (170, 166, 158)))
                # hedge
                if rnd.random() < 0.6:
                    hy0, hy1 = (y, dy - 0.4) if dy > y + 3 else (dy + 3.4, y + w)
                    hx = 14.2 * sgn
                    if hy1 - hy0 > 2:
                        objs.append(Obj(box_faces(hx - 0.5, hx + 0.5, hy0, hy1, 0, 1.1, (58, 98, 46), top=(72, 116, 54)), (hx, (hy0 + hy1) / 2, 0.6), (hy1 - hy0) / 2 + 1))
            y += w + rnd.uniform(5, 10)
        # street trees on the planting strip
        y = Y0 + rnd.uniform(0, 6)
        while y < Y1:
            if not in_cross(y - 4, y + 4) and not (sc.kind == "sentry" and sgn > 0 and -12 < y < 12):
                objs.append(make_tree(sgn * 10.2 + rnd.uniform(-0.15, 0.15), y, rnd))
            y += rnd.uniform(11, 17)
        # street lights
        for y in range(Y0 + 15, Y1, 45):
            if in_cross(y - 3, y + 3): continue
            xl = sgn * 10.0
            f = box_faces(xl - 0.09, xl + 0.09, y - 0.09, y + 0.09, 0, 7.2, (92, 96, 100))
            f += box_faces(min(xl, xl - sgn * 1.8), max(xl, xl - sgn * 1.8), y - 0.07, y + 0.07, 7.0, 7.14, (92, 96, 100))
            objs.append(Obj(f, (xl, y, 3.6), 4.0))
    # parked cars (both curbs), leaving gaps (cyclist / intersection / our own spot in sentry)
    pal = [(220, 220, 216), (30, 32, 36), (120, 124, 130), (160, 30, 36), (36, 66, 120), (196, 180, 150), (60, 90, 70), (90, 96, 104)]
    for sgn in (-1, 1):
        y = Y0
        while y < Y1:
            y += rnd.uniform(6.2, 9.5)
            if in_cross(y - 8, y + 8) or (sc.y_int < 1e8 and sc.stop_line - 30 < y < sc.stop_line): continue
            if sgn > 0 and sc.kind == "drive" and 40 < y < 150: continue      # cyclist gap
            if sgn > 0 and sc.kind == "sentry" and -9 < y < 9: continue        # that's us
            if rnd.random() < 0.35: continue
            objs.append(car_obj(dict(x=sgn * 8.4, y=y, yaw=0 if sgn > 0 else math.pi, color=rnd.choice(pal), brake=False,
                                     plate="", suv=rnd.random() < 0.3)))
    # traffic signals
    if sc.y_int < 1e8:
        for (px, py, arm) in ((10.6, sc.stop_line - 0.5, 6.6), (10.6, sc.y_int + 10.5, 8.2), (-10.6, sc.y_int + 10.5, 0)):
            f = box_faces(px - 0.12, px + 0.12, py - 0.12, py + 0.12, 0, 6.2 if arm else 3.6, (64, 68, 72))
            if arm: f += box_faces(px - arm, px, py - 0.08, py + 0.08, 5.9, 6.06, (64, 68, 72))
            objs.append(Obj(f, (px - arm / 2, py, 3), max(4, arm / 2 + 3)))
            heads = [(px - arm + 0.6, py, 5.1)] if arm else [(px, py, 2.9)]
            if arm: heads.append((px - arm / 2 - 0.2, py, 5.1))
            for hx, hy, hz in heads:
                objs.append(Obj(box_faces(hx - 0.2, hx + 0.2, hy, hy + 0.3, hz - 0.55, hz + 0.55, (34, 36, 38)), (hx, hy, hz), 1.0,
                                kind="signal", extra=(hx, hy - 0.01, hz)))
    return ground, objs

def make_tree(x, y, rnd):
    h = rnd.uniform(4.2, 6.5); r = rnd.uniform(1.8, 2.8)
    f = box_faces(x - 0.16, x + 0.16, y - 0.16, y + 0.16, 0, h * 0.62, (92, 70, 52))
    base = rnd.choice([(58, 100, 44), (66, 110, 48), (52, 92, 46), (78, 116, 50)])
    blobs = []
    for _ in range(6):
        blobs.append((x + rnd.uniform(-0.7, 0.7) * r * 0.6, y + rnd.uniform(-0.7, 0.7) * r * 0.6, h * 0.62 + rnd.uniform(0, 1.1) * r, r * rnd.uniform(0.55, 0.8)))
    return Obj(f, (x, y, h * 0.7), r + 1.5, kind="tree", extra=(blobs, base))

def car_obj(a):
    """A generic car as boxes in local frame, placed at (x, y) with yaw (0 = facing +y)."""
    L, W = (4.8, 1.95) if a.get("suv") else (4.6, 1.86)
    hb, hc = (1.05, 1.72) if a.get("suv") else (0.92, 1.42)
    col = a["color"]
    glass = (40, 48, 58)
    parts = []
    parts += box_faces(-W / 2, W / 2, -L / 2, L / 2, 0.32, hb, col)
    cy0, cy1 = (-L / 2 + 0.5, L / 2 - 1.3) if a.get("suv") else (-L / 2 + 0.75, L / 2 - 1.35)
    if not a.get("ego"): parts += [(p, n, glass if n[2] < 0.5 else tuple(c * 0.9 for c in col)) for p, n, c in box_faces(-W / 2 + 0.12, W / 2 - 0.12, cy0, cy1, hb, hc, col, taper=0.08 if a.get("suv") else 0.16)]
    wheels = []
    if not a.get("ego"):
        for sx in (-1, 1):
            for wy in (-L / 2 + 0.95, L / 2 - 0.95):
                wx = sx * (W / 2 + 0.01)
                ring = [(wx, wy + 0.34 * math.cos(k * math.pi / 8), 0.34 + 0.34 * math.sin(k * math.pi / 8)) for k in range(16)]
                hub = [(wx + sx * 0.005, wy + 0.19 * math.cos(k * math.pi / 6), 0.34 + 0.19 * math.sin(k * math.pi / 6)) for k in range(12)]
                wheels.append((ring, np.array([sx, 0, 0.0]), hub))
        # dark lower skirt between the wheels
        parts += box_faces(-W / 2 + 0.03, W / 2 - 0.03, -L / 2 + 0.3, L / 2 - 0.3, 0.12, 0.33, (28, 28, 30))
    # rear lights + plate, headlights
    br = a.get("brake")
    tl = (255, 40, 40) if br else (150, 20, 24)
    yr = -L / 2 - 0.02; yf = L / 2 + 0.02
    for sx in ((-1, 1) if not a.get("ego") else ()):
        x0 = sx * (W / 2 - 0.08); x1 = sx * (W / 2 - 0.42)
        parts.append(([(min(x0, x1), yr, 0.74), (max(x0, x1), yr, 0.74), (max(x0, x1), yr, 0.86), (min(x0, x1), yr, 0.86)], np.array([0, -1.0, 0]), ("emit", tl)))
        parts.append(([(max(x0, x1), yf, 0.66), (min(x0, x1), yf, 0.66), (min(x0, x1), yf, 0.76), (max(x0, x1), yf, 0.76)], np.array([0, 1.0, 0]), ("emit", (236, 236, 222))))
    plate = None
    if a.get("plate") is not None:
        parts.append(([(-0.26, yr - 0.005, 0.44), (0.26, yr - 0.005, 0.44), (0.26, yr - 0.005, 0.58), (-0.26, yr - 0.005, 0.58)], np.array([0, -1.0, 0]), ("emit", (232, 232, 226))))
        plate = ((-0.26, yr - 0.01, 0.44), (0.26, yr - 0.01, 0.58), a.get("plate") or "")
    # shadow footprint (drawn as a ground decal)
    c, s = math.cos(a["yaw"]), math.sin(a["yaw"])
    def tr(p): return (a["x"] + p[0] * c + p[1] * s, a["y"] - p[0] * s + p[1] * c, p[2])
    faces = [([tr(p) for p in pts], np.array([n[0] * c + n[1] * s, -n[0] * s + n[1] * c, n[2]]), col_) for pts, n, col_ in parts]
    sh = [tr((-W / 2 - 0.15 + 0.25, -L / 2 - 0.1 + 0.2, 0.01)), tr((W / 2 + 0.15 + 0.25, -L / 2 - 0.1 + 0.2, 0.01)), tr((W / 2 + 0.15 + 0.25, L / 2 + 0.1 + 0.2, 0.01)), tr((-W / 2 - 0.15 + 0.25, L / 2 + 0.1 + 0.2, 0.01))]
    pl = (tr(plate[0]), tr(plate[1]), plate[2]) if plate else None
    wh = [([tr(p) for p in ring], np.array([n[0] * c + n[1] * s, -n[0] * s + n[1] * c, 0]), [tr(p) for p in hub]) for ring, n, hub in wheels]
    return Obj(faces, (a["x"], a["y"], 0.8), 3.0, kind="car", extra=dict(shadow=sh, plate=pl, wheels=wh))

def person_obj(a):
    """Faceless, generic walking silhouette (simple boxes + round head)."""
    x, y, ph = a["x"], a["y"], a["phase"]
    col = a["color"]; skin = (150, 128, 110)
    sw = 0.32 * math.sin(ph)
    f = []
    for side, k in ((-1, 1), (1, -1)):
        lx = x + side * 0.1
        dy = k * sw
        f += box_faces(lx - 0.07, lx + 0.07, y + dy * 0.5 - 0.07, y + dy * 0.5 + 0.07, 0, 0.9, (40, 44, 54))
        f += box_faces(x + side * 0.27 - 0.05, x + side * 0.27 + 0.05, y - dy * 0.4 - 0.05, y - dy * 0.4 + 0.05, 0.85, 1.42, col)
    f += box_faces(x - 0.21, x + 0.21, y - 0.12, y + 0.12, 0.88, 1.5, col)
    return Obj(f, (x, y, 0.9), 1.2, kind="person", extra=dict(head=(x, y, 1.64, 0.12), skin=skin))

def bike_obj(a):
    x, y, ph = a["x"], a["y"], a["phase"]
    f = []
    f += box_faces(x - 0.03, x + 0.03, y - 0.55, y + 0.55, 0.42, 0.48, (40, 120, 200))
    f += box_faces(x - 0.16, x + 0.16, y - 0.18, y + 0.14, 0.95, 1.5, (230, 110, 40))      # rider torso
    f += box_faces(x - 0.14, x + 0.14, y - 0.05, y + 0.3, 1.2, 1.32, (230, 110, 40))
    for side in (-1, 1):
        k = math.sin(ph + (0 if side > 0 else math.pi))
        f += box_faces(x + side * 0.1 - 0.05, x + side * 0.1 + 0.05, y + 0.05 * k - 0.05, y + 0.05 * k + 0.05, 0.45 + 0.1 * k, 0.98, (40, 44, 54))
    return Obj(f, (x, y, 0.8), 1.4, kind="bike", extra=dict(wheels=[(x, y - 0.55, 0.34, 0.34), (x, y + 0.55, 0.34, 0.34)], head=(x, y + 0.12, 1.62, 0.13)))

# ───────────────────────── cameras ─────────────────────────
# (position in ego frame, yaw deg (0 = forward, + = right), pitch down deg, horizontal fov deg, fisheye k)
CAMS = {
    "front":          ((0.0, 0.55, 1.38), 0, 4, 78, 0.10),
    "back":           ((0.0, -2.33, 1.02), 180, 10, 112, 0.24),
    "left_pillar":    ((-0.86, 0.15, 1.30), -68, 6, 86, 0.14),
    "right_pillar":   ((0.86, 0.15, 1.30), 68, 6, 86, 0.14),
    "left_repeater":  ((-1.0, 1.25, 0.98), -152, 8, 82, 0.16),
    "right_repeater": ((1.0, 1.25, 0.98), 152, 8, 82, 0.16),
}

class Cam:
    def __init__(self, name, W, H, ss):
        self.name = name; (pos, yaw, pitch, fov, k) = CAMS[name]
        self.pos = np.array(pos, float); self.yaw = math.radians(yaw); self.pitch = math.radians(pitch); self.k = k
        self.W, self.H, self.ss = W, H, ss
        self.RW, self.RH = int(W * ss), int(H * ss)
        self.f = (self.RW / 2) / math.tan(math.radians(fov) / 2)
        self.cx, self.cy = self.RW / 2, self.RH / 2
        self._remap()

    def _remap(self):
        """Output pixel → source pixel (barrel distortion) + vignette, precomputed."""
        W, H = self.W, self.H
        ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
        nx = (xs - W / 2) / (W / 2); ny = (ys - H / 2) / (W / 2)
        r2 = nx * nx + ny * ny
        k = self.k; scale = 1 + k * r2
        norm = 1 + k * 1.0           # keep the left/right edge at the edge... then zoom in slightly to hide corners
        sx = nx * scale / norm * 0.985; sy = ny * scale / norm * 0.985
        X = (sx * (self.RW / 2) + self.RW / 2 - 0.5).clip(0, self.RW - 1.001); Y = (sy * (self.RW / 2) + self.RH / 2 - 0.5).clip(0, self.RH - 1.001)
        self.x0 = X.astype(np.int32); self.y0 = Y.astype(np.int32)
        self.fx = (X - self.x0)[..., None]; self.fy = (Y - self.y0)[..., None]
        v = 1 - 0.38 * (r2 / r2.max()) ** 1.3
        self.vig = v[..., None].astype(np.float32)

    def set_pose(self, ex, ey, eyaw):
        """World pose for this frame: ego at (ex, ey) heading eyaw (rad, + = right)."""
        c, s = math.cos(eyaw), math.sin(eyaw)
        p = self.pos
        self.world = np.array([ex + p[0] * c + p[1] * s, ey - p[0] * s + p[1] * c, p[2]])
        yaw = self.yaw + eyaw
        fwd = np.array([math.sin(yaw), math.cos(yaw), 0.0]); right = np.array([math.cos(yaw), -math.sin(yaw), 0.0])
        cp, sp = math.cos(self.pitch), math.sin(self.pitch)
        self.F = fwd * cp + np.array([0, 0, -sp]); self.U = fwd * sp + np.array([0, 0, cp]); self.R = right
        self.M = np.stack([self.R, self.U, self.F])    # world-delta → (X, Z, D)
        self.ayaw = yaw

    def to_cam(self, pts):
        return (np.asarray(pts, float) - self.world) @ self.M.T

    def visible(self, c, r):
        q = (c - self.world) @ self.M.T
        if q[2] < -r: return False
        lim = (self.RW / 2) / self.f * 1.25
        return abs(q[0]) - r * 1.5 < lim * max(q[2], 0.1) + r and q[2] < 450

    def project_poly(self, pts):
        q = self.to_cam(pts)
        near = 0.15
        if (q[:, 2] < near).all(): return None, None
        if (q[:, 2] < near).any():
            out = []; n = len(q)
            for i in range(n):
                a, b = q[i], q[(i + 1) % n]
                ia, ib = a[2] >= near, b[2] >= near
                if ia: out.append(a)
                if ia != ib:
                    t = (near - a[2]) / (b[2] - a[2]); out.append(a + (b - a) * t)
            q = np.array(out)
        u = self.cx + self.f * q[:, 0] / q[:, 2]; v = self.cy - self.f * q[:, 1] / q[:, 2]
        return list(zip(u.tolist(), v.tolist())), q[:, 2].mean()

    def project_pt(self, p):
        q = self.to_cam([p])[0]
        if q[2] < 0.2: return None
        return self.cx + self.f * q[0] / q[2], self.cy - self.f * q[1] / q[2], q[2]

def fog(col, d):
    k = 1 - math.exp(-max(d, 0) / 420.0)
    return tuple(int(c * (1 - k) + h * k) for c, h in zip(col, HAZE))

# sky panorama (azimuth 0..360 × elevation -10..60), built once
def make_sky(seed):
    rnd = random.Random(seed + 7)
    AW, AH = 2048, 512
    el = np.linspace(60, -10, AH)[:, None]
    t = np.clip((el + 2) / 50, 0, 1) ** 0.6
    top = np.array([72, 132, 205.0]); hor = np.array([214, 226, 236.0])
    sky = hor * (1 - t[..., None]) + top * t[..., None]
    sky = np.repeat(sky, AW, axis=1)
    az = np.linspace(0, 2 * math.pi, AW, endpoint=False)[None, :]
    elr = np.radians(el)
    d = np.stack([np.sin(az) * np.cos(elr), np.cos(az) * np.cos(elr), np.sin(elr) * np.ones_like(az)], -1)
    cosang = np.clip(d @ SUN, -1, 1)
    ang = np.degrees(np.arccos(cosang))
    glow = np.exp(-ang / 9.0)[..., None] * np.array([70, 58, 30.0]) + np.exp(-ang / 1.4)[..., None] * 255
    sky = sky + glow
    img = Image.fromarray(np.clip(sky, 0, 255).astype(np.uint8))
    cl = Image.new("L", (AW * 3, AH), 0); dr = ImageDraw.Draw(cl)   # drawn 3× wide so clouds wrap seamlessly
    for _ in range(26):
        cx = rnd.uniform(0, AW); cy = rnd.uniform(AH * 0.12, AH * 0.62); w = rnd.uniform(60, 220)
        for _ in range(7):
            ox, oy, r = rnd.uniform(-w / 2, w / 2), rnd.uniform(-w / 9, w / 12), rnd.uniform(w / 7, w / 3.5)
            for rep in (0, AW, 2 * AW):
                dr.ellipse([rep + cx + ox - r * 1.4, cy + oy - r * 0.6, rep + cx + ox + r * 1.4, cy + oy + r * 0.6], fill=200)
    cl = cl.filter(ImageFilter.GaussianBlur(9)).crop((AW, 0, 2 * AW, AH))
    a = np.asarray(cl, np.float32)[..., None] / 255 * 0.85
    base = np.asarray(img, np.float32)
    sky = base * (1 - a) + np.array([248, 248, 250.0]) * a
    return sky.astype(np.uint8), AW, AH

def sky_lookup(cam):
    """Per-pixel (azimuth, elevation) for the camera at zero ego yaw; returns indices into the panorama."""
    ys, xs = np.mgrid[0:cam.RH, 0:cam.RW].astype(np.float32)
    X = (xs - cam.cx) / cam.f; Z = -(ys - cam.cy) / cam.f
    yaw, p = cam.yaw, cam.pitch
    fwd = np.array([math.sin(yaw), math.cos(yaw), 0]); right = np.array([math.cos(yaw), -math.sin(yaw), 0])
    F = fwd * math.cos(p) + np.array([0, 0, -math.sin(p)]); U = fwd * math.sin(p) + np.array([0, 0, math.cos(p)])
    d = X[..., None] * right + Z[..., None] * U + F
    az = np.arctan2(d[..., 0], d[..., 1]) % (2 * math.pi)
    el = np.degrees(np.arctan2(d[..., 2], np.hypot(d[..., 0], d[..., 1])))
    return az, el

# ───────────────────────── frame rendering ─────────────────────────
def draw_obj(dr, cam, o, sc, t, img):
    if o.kind == "signal":
        state = sc.light(t)
        faces = o.faces
    else:
        faces = o.faces
    polys = []
    for pts, n, col in faces:
        # back-face cull (normal vs. view direction)
        cpt = np.mean(pts, axis=0)
        if np.dot(n, cam.world - cpt) <= 0: continue
        sp, depth = cam.project_poly(pts)
        if sp is None or len(sp) < 3: continue
        if col is None: col = (210, 200, 180)
        if isinstance(col, tuple) and len(col) == 2 and col[0] == "emit": c = col[1]
        else: c = shade(col, n)
        polys.append((depth, sp, fog(c, depth)))
    polys.sort(key=lambda p: -p[0])
    for depth, sp, c in polys:
        dr.polygon(sp, fill=c)
    if o.kind == "car":
        for ring, n, hub in o.extra.get("wheels", []):
            if np.dot(n, cam.world - np.mean(ring, axis=0)) <= 0: continue
            sp, d = cam.project_poly(ring)
            if sp and len(sp) >= 3:
                dr.polygon(sp, fill=fog((22, 22, 24), d))
                sp2, d2 = cam.project_poly(hub)
                if sp2 and len(sp2) >= 3: dr.polygon(sp2, fill=fog((120, 124, 130), d2))
    if o.kind == "tree":
        blobs, base = o.extra
        items = []
        for bx, by, bz, br in blobs:
            pp = cam.project_pt((bx, by, bz))
            if pp: items.append((pp[2], pp, br))
        items.sort(key=lambda a: -a[0])
        for d, (u, v, _), br in items:
            r = cam.f * br / d
            dark = fog(tuple(c * 0.78 for c in base), d); lite = fog(tuple(min(255, c * 1.12) for c in base), d)
            dr.ellipse([u - r, v - r, u + r, v + r], fill=dark)
            dr.ellipse([u - r * 0.8 - r * 0.25, v - r * 0.85, u + r * 0.6 - r * 0.25, v + r * 0.55], fill=lite)
    elif o.kind == "signal":
        hx, hy, hz = o.extra
        lamps = {"red": 0.33, "yellow": 0.0, "green": -0.33}
        for name, dz in lamps.items():
            pp = cam.project_pt((hx, hy, hz + dz))
            if not pp: continue
            # only visible from the -y side (approaching traffic)
            if cam.world[1] > hy: continue
            u, v, d = pp; r = max(1.0, cam.f * 0.12 / d)
            on = sc.light(t) == name
            cmap = {"red": ((255, 60, 50), (70, 20, 20)), "yellow": ((255, 196, 40), (70, 56, 16)), "green": ((80, 255, 150), (16, 60, 36))}
            c = cmap[name][0 if on else 1]
            if on: dr.ellipse([u - r * 2.2, v - r * 2.2, u + r * 2.2, v + r * 2.2], fill=tuple(int(x * 0.5 + 30) for x in c))
            dr.ellipse([u - r, v - r, u + r, v + r], fill=c)
    elif o.kind in ("person", "bike"):
        if o.kind == "bike":
            for wx, wy, wz, wr in o.extra["wheels"]:
                pp = cam.project_pt((wx, wy, wz)); pp2 = cam.project_pt((wx, wy + wr, wz))
                if pp and pp2:
                    rx = max(1.5, abs(pp2[0] - pp[0])); ry = cam.f * wr / pp[2]
                    dr.ellipse([pp[0] - rx, pp[1] - ry, pp[0] + rx, pp[1] + ry], outline=(30, 30, 30), width=max(1, int(ry * 0.18)))
        hx, hy, hz, hr = o.extra["head"]
        pp = cam.project_pt((hx, hy, hz))
        if pp:
            r = cam.f * hr / pp[2]
            dr.ellipse([pp[0] - r, pp[1] - r, pp[0] + r, pp[1] + r], fill=(46, 44, 46) if o.kind == "person" else (240, 240, 240))
    elif o.kind == "car" and o.extra.get("plate") and o.extra["plate"][2]:
        p0, p1, txt = o.extra["plate"]
        a = cam.project_pt(p0); b = cam.project_pt(p1)
        if a and b and np.dot(np.array([0, -1.0, 0]), cam.world - np.array(p0)) > 0:
            w = abs(b[0] - a[0]); h = abs(b[1] - a[1])
            if w > 26:
                fnt = ImageFont.truetype(FONT, max(6, int(h * 0.62)))
                tw = dr.textlength(txt, font=fnt)
                dr.text(((a[0] + b[0]) / 2 - tw / 2, min(a[1], b[1]) + h * 0.14), txt, fill=(30, 50, 120), font=fnt)

def render_frame(cam, sc, ground, statics, t, sky, skyidx, noise):
    ex, ey, eyaw, v, br = sc.ego(t)
    cam.set_pose(ex, ey, eyaw)
    pano, AW, AH = sky
    az, el = skyidx
    ai = (((az + eyaw) % (2 * math.pi)) / (2 * math.pi) * AW).astype(np.int32) % AW
    ei = np.clip(((60 - el) / 70 * AH).astype(np.int32), 0, AH - 1)
    base = pano[ei, ai]
    img = Image.fromarray(base)
    dr = ImageDraw.Draw(img)
    # far ground below the horizon
    hz = cam.cy - cam.f * math.tan(cam.pitch) * -1   # horizon row (pitch down → horizon above centre)
    hz = cam.cy - cam.f * math.tan(cam.pitch)
    if hz < cam.RH: dr.rectangle([0, max(0, hz), cam.RW, cam.RH], fill=fog((100, 122, 74), 300))
    for pts, col in ground:
        sp, d = cam.project_poly(pts)
        if sp and len(sp) >= 3: dr.polygon(sp, fill=fog(col, d * 0.6))
    objs = [o for o in statics if cam.visible(o.c, o.r)]
    for a in sc.actors(t):
        o = car_obj(a) if a["type"] == "car" else (person_obj(a) if a["type"] == "person" else bike_obj(a))
        if cam.visible(o.c, o.r): objs.append(o)
    # ego car body (seen by back + repeaters + a sliver for pillars)
    if cam.name != "front" and sc.kind:
        eg = car_obj(dict(x=ex, y=ey, yaw=eyaw, color=(226, 228, 230), brake=br, plate=None, ego=True))
        eg.c = np.array([ex, ey, 0.8]); objs.append(eg)
    # car shadows as ground decals
    for o in objs:
        if o.kind == "car":
            sp, d = cam.project_poly(o.extra["shadow"])
            if sp and len(sp) >= 3: dr.polygon(sp, fill=fog((44, 46, 50), d))
    objs.sort(key=lambda o: -np.linalg.norm(o.c - cam.world))
    for o in objs: draw_obj(dr, cam, o, sc, t, img)
    src = np.asarray(img, np.float32)
    # fisheye remap (bilinear) + vignette + noise + light grade
    x0, y0, fx, fy = cam.x0, cam.y0, cam.fx, cam.fy
    a = src[y0, x0]; b = src[y0, x0 + 1]; c = src[y0 + 1, x0]; d = src[y0 + 1, x0 + 1]
    out = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
    out = out * cam.vig
    out = out * np.array([1.03, 1.0, 0.95], np.float32) + noise
    return np.clip(out, 0, 255).astype(np.uint8)

def render_cam_job(args):
    path, cam_name, W, H, t0, dur, kind, total, seed, rows = args
    sc = Scenario(kind, total, seed)
    ground, statics = build_static(sc)
    cam = Cam(cam_name, W, H, 1.5)
    sky = make_sky(seed); skyidx = sky_lookup(cam)
    rng = np.random.default_rng(seed + hash(cam_name) % 1000)
    noises = [rng.normal(0, 2.2, (H, W, 1)).astype(np.float32) for _ in range(6)]
    n = int(round(dur * FPS))
    with tempfile.TemporaryDirectory() as td:
        raw = os.path.join(td, "v.h264")
        p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                              "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-profile:v", "high", "-bf", "0", "-g", str(FPS),
                              "-crf", "28", "-f", "h264", raw], stdin=subprocess.PIPE)
        for k in range(n):
            fr = render_frame(cam, sc, ground, statics, t0 + k / FPS, sky, skyidx, noises[k % 6])
            p.stdin.write(fr.tobytes())
        p.stdin.close(); p.wait()
        data = open(raw, "rb").read()
        if rows is not None: data = MS.inject_sei(data, rows); open(raw, "wb").write(data)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(FPS), "-i", raw, "-c", "copy", "-video_track_timescale", "90000", path], check=True)
    return path

def event_jobs(folder, stamps, cams, sizes, clip_dur, kind, seed, telemetry):
    os.makedirs(folder, exist_ok=True)
    total = clip_dur * len(stamps)
    rows_all = Scenario(kind, total, seed).telemetry() if telemetry else None
    per = int(round(clip_dur * FPS)); jobs = []
    for ci, st in enumerate(stamps):
        rows = rows_all[ci * per:(ci + 1) * per] if rows_all else None
        for cam in cams:
            W, H = sizes["front"] if cam == "front" else sizes["side"]
            jobs.append((os.path.join(folder, f"{st}-{cam}.mp4"), cam, W, H, ci * clip_dur, clip_dur, kind, total, seed, rows))
    return jobs

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args: sys.exit(__doc__)
    out = args[0]; full = "--full" in sys.argv; enc = "--encrypted" in sys.argv
    jobsn = int(sys.argv[sys.argv.index("--jobs") + 1]) if "--jobs" in sys.argv else os.cpu_count()
    tc = os.path.join(out, "TeslaCam")
    HW4 = {"front": (2896, 1876), "side": (1448, 938)} if full else {"front": (1448, 938), "side": (724, 470)}
    HW3 = {"front": (1280, 960), "side": (1280, 960)} if full else {"front": (960, 720), "side": (960, 720)}
    ALL = ["front", "back", "left_repeater", "right_repeater", "left_pillar", "right_pillar"]
    saved = os.path.join(tc, "SavedClips", "2026-10-07_14-33-41")
    sentry = os.path.join(tc, "SentryClips", "2026-10-06_16-10-05")
    recent = os.path.join(tc, "RecentClips")
    jobs = event_jobs(saved, ["2026-10-07_14-32-41", "2026-10-07_14-33-41"], ALL, HW4, 6.0, "drive", 11, True)
    jobs += event_jobs(sentry, ["2026-10-06_16-09-05"], ["front", "back", "left_repeater", "right_repeater"], HW3, 6.0, "sentry", 23, False)
    jobs += event_jobs(recent, ["2026-10-08_08-15-00"], [c for c in ALL if c != "right_pillar"], HW4, 5.0, "recent", 37, True)
    enc_tmp = None
    if enc:
        enc_tmp = tempfile.mkdtemp()
        jobs += event_jobs(enc_tmp, ["2026-10-08_09-00-00"], ALL, HW4, 4.0, "recent", 41, True)
    jobs.sort(key=lambda j: -(j[2] * j[3]))
    with Pool(jobsn) as pool:
        for p in pool.imap_unordered(render_cam_job, jobs): print("  rendered", os.path.relpath(p, out) if out in p else os.path.basename(p), flush=True)
    json.dump({"timestamp": "2026-10-07T14:33:41", "city": "Palo Alto", "est_lat": "37.3944", "est_lon": "-122.1503",
               "reason": "user_interaction_dashcam_icon_tapped", "camera": "0"}, open(os.path.join(saved, "event.json"), "w"), indent=1)
    json.dump({"timestamp": "2026-10-06T16:09:07", "city": "Fremont", "est_lat": "37.5485", "est_lon": "-121.9886",
               "reason": "sentry_aware_object_detection", "camera": "6"}, open(os.path.join(sentry, "event.json"), "w"), indent=1)
    if enc:
        ev = os.path.join(tc, "SavedClips", "2026-10-08_09-01-00"); os.makedirs(ev, exist_ok=True)
        key = os.urandom(16); keys = {}
        for cam in ALL:
            wk = MS.encrypt_file(os.path.join(enc_tmp, f"2026-10-08_09-00-00-{cam}.mp4"), os.path.join(ev, f"2026-10-08_09-00-00-{cam}.mp4"),
                                 key, "7SAYGDEE0PF000001", 7, 1791475200000)
            keys[wk] = base64.b64encode(key).decode()
        json.dump({"timestamp": "2026-10-08T09:00:30", "city": "Mountain View", "est_lat": "37.4000", "est_lon": "-122.1100",
                   "reason": "vehicle_auto_emergency_braking", "camera": "0"}, open(os.path.join(ev, "event.json"), "w"))
        json.dump(keys, open(os.path.join(out, "synthetic-keys.json"), "w"), indent=1)
    print("done", out)

if __name__ == "__main__":
    main()
