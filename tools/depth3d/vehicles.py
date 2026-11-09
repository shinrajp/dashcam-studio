"""vehicles.py — solid vehicle proxies for the depth street replay (opt-in: build.py --vehicles proxy).

For each tracked detection (boxes.py / tools/rig/detect-tracks.py), lift the box bottom to the road (or the fused
depth when the bottom is off the road), associate observations across the six cameras into one 3D oriented box per
vehicle per time step, smooth the track, sample a paint colour, and write vehicles.json for the viewer.

With --vehicles off (the default) this module is not run: scene / depth / weights stay byte-identical. The page
draws the proxies on top of the depth mesh and, when Solid cars is on, drops depth triangles whose footprint sits
inside a proxy so the cardboard faces go away.

No real footage is written; vehicles.json is poses, colours and a shape key only. The viewer loads glTF models from models/ (CC0 roadster + CC0 fleet — see models/LICENSES.md); motorcycle/bicycle stay procedural.
"""
from __future__ import annotations

import argparse, json, math, os, sys
import numpy as np

# class → (length, width, height) metres — typical values; YOLO has no SUV/Cybercab split, so car covers them
SIZE = {
    "car": (4.6, 1.85, 1.55),
    "truck": (7.2, 2.35, 2.5),
    "bus": (11.0, 2.55, 3.1),
    "motorcycle": (2.2, 0.85, 1.4),
    "bicycle": (1.75, 0.55, 1.15),
}
VEHICLE = set(SIZE)  # persons skipped
ASSOC_M = 2.4        # max ground distance to merge multi-cam observations of one car
TRACK_M = 3.2        # max ground distance to continue a track to the next time step
MIN_CONF = 0.30
MAX_RANGE = 40.0     # ignore lifts farther than this (noisy)
EGO_HALF = (1.15, 2.7)  # reject lifts inside the ego car footprint (width/2, length/2) at the origin
MIN_TRACK_STEPS = 2    # drop one-frame ghosts at the end
PARKED_TRAVEL_M = 2.5  # tracks that move less than this over their life are locked to a median pose
DEDUP_IOU = 0.45       # oriented-box overlap fraction to merge ghosts in one step
MODELS = ("roadster", "sedan", "hatchback", "suv", "pickup", "van", "bus", "truck", "cybercab")  # glTF stems in models/vehicles/


def _shape(cls, L, W, H):
    """YOLO class + fitted size → a viewer model stem."""
    if cls in ("motorcycle", "bicycle"):
        return "motorcycle"  # procedural in the viewer
    if cls == "bus":
        return "bus"
    if cls == "truck":
        return "truck" if (L >= 6.0 or H >= 2.2) else "pickup"
    # car: default to the realistic roadster/sports coupe (user request); other shapes by size
    if H >= 1.78:
        return "suv"
    if H <= 1.38 and L <= 4.0:
        return "cybercab"  # compact 2-seat stand-in
    if L <= 4.05 and H <= 1.55:
        return "hatchback"
    if L >= 5.4 and H >= 1.68:
        return "van"
    return "roadster"  # modern passenger car → realistic CC BY sports coupe


def _boxes_overlap(a, b, frac=DEDUP_IOU):
    """true when oriented footprints overlap enough (axis-aligned in a's frame)."""
    dx, dz = b["x"] - a["x"], b["z"] - a["z"]
    c, s = math.cos(a["yaw"]), math.sin(a["yaw"])
    lr = dx * c + dz * s
    fb = -dx * s + dz * c
    return abs(lr) < (a["W"] + b["W"]) * frac and abs(fb) < (a["L"] + b["L"]) * frac


def _dedupe_step(vehs):
    """merge ghosts that sit on top of each other in one time step; keep the stronger one."""
    if len(vehs) < 2:
        return vehs
    order = sorted(range(len(vehs)), key=lambda i: (-vehs[i].get("conf", 0.5), -vehs[i].get("n", 1), -vehs[i]["L"]))
    keep = []
    for i in order:
        v = vehs[i]
        if any(_boxes_overlap(v, k) for k in keep):
            continue
        keep.append(v)
    return keep


def _finalize(steps, ego_path=None, two_way=True):
    """parked-lock, world-space motion yaw for movers, side/appearance yaw for parked, shape, de-dupe.

    ego_path: optional list of (ego_x, ego_z, ego_yaw) per step — used for the side-of-road prior.
    Movers use the longest world-space displacement direction *without* the old ±90° snap-to-prior
    that forced every car to face with ego. Poses are already world-frame, so ego motion is not
    subtracted from travel (that would make parked cars look oncoming).
    """
    from collections import defaultdict
    poses = defaultdict(list)
    for si, row in enumerate(steps):
        for v in row:
            poses[v["id"]].append((si, v))
    locked = {}
    for vid, pts in poses.items():
        xs = [p[1]["x"] for p in pts]; zs = [p[1]["z"] for p in pts]
        sis = [p[0] for p in pts]
        # World-frame poses: parked detection and motion yaw use RAW world displacement.
        # (Subtracting ego motion would make a static world point look like it travels
        # opposite the ego — the bug that faced every car oncoming.)
        travel = 0.0
        for i in range(1, len(xs)):
            travel += math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1])
        best_d, best_dx, best_dz = 0.0, 0.0, 0.0
        for i in range(len(xs)):
            for j in range(i + 1, len(xs)):
                dx, dz = xs[j] - xs[i], zs[j] - zs[i]
                d = math.hypot(dx, dz)
                if d > best_d:
                    best_d, best_dx, best_dz = d, dx, dz
        # side vs ego (median pose)
        mx, mz = float(np.median(xs)), float(np.median(zs))
        if ego_path is not None and pts:
            si_mid = pts[len(pts) // 2][0]
            if si_mid < len(ego_path):
                ex, ez, ey = ego_path[si_mid]
            else:
                ex, ez, ey = ego_path[-1]
        else:
            ex = ez = ey = 0.0
            # fall back: circular mean of existing yaws as ego stand-in
            ey = math.atan2(sum(math.sin(p[1]["yaw"]) for p in pts), sum(math.cos(p[1]["yaw"]) for p in pts))
        side = _side_of_ego(mx, mz, ex, ez, ey)
        if travel < PARKED_TRAVEL_M and len(pts) >= 2:
            yaws = [p[1]["yaw"] for p in pts]
            yaw_mean = math.atan2(sum(math.sin(y) for y in yaws) / len(yaws),
                                  sum(math.cos(y) for y in yaws) / len(yaws))
            # appearance over the track's fused poses (face_hint may be absent → side prior)
            yaw_app = _appearance_facing([p[1] for p in pts])
            if yaw_app is not None:
                yaw = yaw_app
            else:
                yaw = _yaw_from_side(ey, side, two_way=two_way)
                # if mean yaw already agrees with prior within 60°, keep the finer mean
                if abs(_wrap(yaw_mean - yaw)) < math.radians(60):
                    yaw = yaw_mean
                elif abs(_wrap(yaw_mean + math.pi - yaw)) < math.radians(60):
                    yaw = _wrap(yaw_mean + math.pi)
            locked[vid] = dict(x=mx, z=mz, yaw=_wrap(yaw),
                               L=float(np.median([p[1]["L"] for p in pts])),
                               W=float(np.median([p[1]["W"] for p in pts])),
                               H=float(np.median([p[1]["H"] for p in pts])),
                               rgb=[int(round(x)) for x in np.median([p[1]["rgb"] for p in pts], 0)],
                               parked=True, side=side)
        else:
            if best_d > 1.2:
                # world / compensated motion direction — do NOT flip to match prior yaw
                locked[vid] = dict(motion_yaw=_wrap(math.atan2(best_dx, best_dz)), parked=False, side=side)
            else:
                # short moving track: side prior
                locked[vid] = dict(yaw=_yaw_from_side(ey, side, two_way=two_way), parked=False, side=side)
    out = []
    for row in steps:
        nrow = []
        for v in row:
            info = locked.get(v["id"], {})
            nv = dict(v)
            if info.get("parked"):
                for k in ("x", "z", "yaw", "L", "W", "H", "rgb"):
                    nv[k] = info[k] if k != "rgb" else list(info[k])
                nv["yaw"] = round(info["yaw"], 4)
                nv["x"] = round(info["x"], 3); nv["z"] = round(info["z"], 3)
            elif "motion_yaw" in info:
                nv["yaw"] = round(info["motion_yaw"], 4)
            elif "yaw" in info:
                nv["yaw"] = round(info["yaw"], 4)
            nv["shape"] = _shape(nv["cls"], nv["L"], nv["W"], nv["H"])
            nv["parked"] = bool(info.get("parked"))
            if "side" in info:
                nv["side"] = int(info["side"])
            nrow.append(nv)
        out.append(_dedupe_step(nrow))
    ids = {v["id"] for row in out for v in row}
    return out, len(ids)


FUTURE_LOOKS = ("crossover", "coupe")   # 2.5D concept impostors in models/future/ (viewer "Concept cars (2.5D)")
COUPE_MIN_L = 4.4                          # moving passenger cars at least this long get the low sports coupe


def future_looks(doc):
    """opt-in (--style future): tag passenger cars with a concept look; poses / shapes stay untouched.

    The detector only says "car" and the height is a fixed prior, so a sports car cannot be told from a
    crossover. Rule (documented, deterministic): parked cars and short/compact/SUV-sized cars → crossover;
    moving sedan-sized cars (shape roadster, L >= COUPE_MIN_L) → coupe. Trucks, buses, vans, pickups and
    two-wheelers keep their glTF model (no look). The viewer falls back to the shape glTF for views the
    concept images do not cover (high top-down angles)."""
    n = {"crossover": 0, "coupe": 0}
    looks = {}
    for row in doc["steps"]:
        for v in row:
            if v.get("cls") != "car" or v.get("shape") in ("van", "pickup", "truck", "bus", "motorcycle"):
                continue
            if v["id"] not in looks:
                sporty = v.get("shape") == "roadster" and not v.get("parked") and v["L"] >= COUPE_MIN_L
                looks[v["id"]] = "coupe" if sporty else "crossover"
            v["look"] = looks[v["id"]]
    for k in looks.values():
        n[k] += 1
    doc["style"] = "future"
    doc["looks"] = n
    return doc


def _copy_future(page):
    """copy the concept impostor views (webp + futurecars.json) into page/models/future/."""
    import shutil
    here = os.path.dirname(os.path.abspath(__file__))
    src = os.path.join(here, "models", "future")
    if not os.path.isdir(src):
        return 0
    dst = os.path.join(page, "models", "future")
    os.makedirs(dst, exist_ok=True)
    n = 0
    for f in sorted(os.listdir(src)):
        if f.endswith((".webp", ".json")):
            shutil.copy2(os.path.join(src, f), os.path.join(dst, f)); n += 1
    return n


def _copy_models(page):
    """copy the CC0 glTF set + licence note into page/models/ for the viewer."""
    import shutil
    here = os.path.dirname(os.path.abspath(__file__))
    src = os.path.join(here, "models", "vehicles")
    if not os.path.isdir(src):
        return 0
    dst = os.path.join(page, "models")
    os.makedirs(dst, exist_ok=True)
    n = 0
    for name in MODELS:
        f = os.path.join(src, name + ".glb")
        if os.path.exists(f):
            shutil.copy2(f, os.path.join(dst, name + ".glb")); n += 1
    lic = os.path.join(here, "models", "LICENSES.md")
    if os.path.exists(lic):
        shutil.copy2(lic, os.path.join(dst, "LICENSES.md"))
    return n


def _load_depth(fused, name):
    import cv2
    base = os.path.join(fused, name[:-4])
    z = cv2.imread(base + ".png", cv2.IMREAD_UNCHANGED)
    if z is None:
        return None, None
    rows = None
    rp = base + "_rows.json"
    if os.path.exists(rp):
        rows = np.asarray(json.load(open(rp)), float)
    return z.astype(np.float32) / 100.0, rows


def _sample_depth(Z, rows, u, v, w, h):
    if Z is None:
        return None
    gh, gw = Z.shape
    i = int(np.clip(u * gw / w, 0, gw - 1))
    if rows is not None and len(rows) == gh:
        j = int(np.argmin(np.abs(rows - v)))
    else:
        j = int(np.clip(v * gh / h, 0, gh - 1))
    # median of a small window so a single hole doesn't sink the car
    j0, j1 = max(0, j - 1), min(gh, j + 2)
    i0, i1 = max(0, i - 1), min(gw, i + 2)
    patch = Z[j0:j1, i0:i1]
    vals = patch[patch > 0.3]
    return float(np.median(vals)) if len(vals) else None


def _paint(fused, name, box):
    """median RGB of the middle of the box (skip wheels / road / glass), 0..255."""
    import cv2
    im = cv2.imread(os.path.join(fused, name), cv2.IMREAD_COLOR)
    if im is None:
        return [160, 160, 165]
    H, W = im.shape[:2]
    x0, y0, x1, y1 = box
    x0 = int(np.clip(x0, 0, W - 1)); x1 = int(np.clip(x1, 0, W))
    y0 = int(np.clip(y0, 0, H - 1)); y1 = int(np.clip(y1, 0, H))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return [160, 160, 165]
    # keep the central 50% width × middle 40% height (body paint)
    dx, dy = x1 - x0, y1 - y0
    xa, xb = x0 + int(0.25 * dx), x0 + int(0.75 * dx)
    ya, yb = y0 + int(0.25 * dy), y0 + int(0.65 * dy)
    patch = im[ya:yb, xa:xb]
    if patch.size == 0:
        return [160, 160, 165]
    # drop near-black (tyre / shadow) and near-white (sky / specular)
    bgr = patch.reshape(-1, 3).astype(np.float32)
    lum = bgr.mean(1)
    keep = (lum > 25) & (lum < 230)
    if keep.sum() < 8:
        keep = np.ones(len(bgr), bool)
    med = np.median(bgr[keep], 0)  # BGR
    return [int(med[2]), int(med[1]), int(med[0])]


def _face_hint_from_box(fused, name, box):
    """+1 headlights facing cam, -1 taillights, 0 unknown — from the upper band of the detector box."""
    import cv2
    im = cv2.imread(os.path.join(fused, name), cv2.IMREAD_COLOR)
    if im is None:
        return 0
    H, W = im.shape[:2]
    x0, y0, x1, y1 = [int(v) for v in box]
    x0 = int(np.clip(x0, 0, W - 1)); x1 = int(np.clip(x1, 0, W))
    y0 = int(np.clip(y0, 0, H - 1)); y1 = int(np.clip(y1, 0, H))
    if x1 - x0 < 6 or y1 - y0 < 6:
        return 0
    dy = y1 - y0
    # upper 35% of the box (where light bars sit on a car facing the camera)
    ya, yb = y0 + int(0.05 * dy), y0 + int(0.40 * dy)
    patch = im[ya:yb, x0:x1]
    if patch.size < 20:
        return 0
    bgr = patch.reshape(-1, 3).astype(np.float32)
    med = np.median(bgr, 0)  # BGR
    b, g, r = float(med[0]), float(med[1]), float(med[2])
    lum = (r + g + b) / 3.0
    if r > g + 30 and r > b + 30 and lum < 160:
        return -1
    if lum > 165 and (b + g) >= 1.5 * max(r, 1.0):
        return +1
    if lum > 190:
        return +1
    return 0


def _lift(fr, box, Z, rows):
    """view-pixel box → ground (x, z) in world metres + distance + apparent width. Prefer fused depth; fall back to y=0."""
    x0, y0, x1, y1 = box
    if x1 <= x0 or y1 <= y0:
        return None
    u = 0.5 * (x0 + x1)
    v = y1 - 1.0  # bottom edge ≈ road contact for a car standing on the road
    R = np.asarray(fr["R"], float)
    C = np.asarray(fr["C"], float)
    f, cx, cy = fr["f"], fr["cx"], fr["cy"]
    d = np.array([(u - cx) / f, (v - cy) / f, 1.0])
    rd = R @ d
    z_dep = _sample_depth(Z, rows, u, max(y0, y1 - 0.35 * (y1 - y0)), fr["w"], fr["h"])
    P = None
    if z_dep is not None and z_dep < MAX_RANGE:
        P = C + z_dep * rd
        # if depth put the point more than ~1.2 m off the road, re-snap with ground
        if abs(P[1]) > 1.2 and abs(rd[1]) > 1e-5:
            t = -C[1] / rd[1]
            if 0.5 < t < MAX_RANGE * 1.5:
                P = C + t * rd
    elif abs(rd[1]) > 1e-5:
        t = -C[1] / rd[1]
        if 0.5 < t < MAX_RANGE * 1.5:
            P = C + t * rd
    if P is None:
        return None
    dist = float(np.linalg.norm(P - C))
    if not (0.8 < dist < MAX_RANGE):
        return None
    # apparent width at this distance (metres across the view)
    app_w = abs(x1 - x0) / f * max(dist, 1.0)
    return dict(x=float(P[0]), y=float(P[1]), z=float(P[2]), dist=dist, app_w=app_w, u=u, v=v)




def _view_box(rig, fr, raw):
    """raw 0..1 detector box → axis-aligned view rectangle [x0,y0,x1,y1], or None."""
    s = np.linspace(0, 1, 9)
    outline = np.concatenate([np.stack([s, np.zeros_like(s)], 1), np.stack([s, np.ones_like(s)], 1),
                              np.stack([np.zeros_like(s), s], 1), np.stack([np.ones_like(s), s], 1)])
    uv = np.stack([raw["x"] + raw["w"] * outline[:, 0], raw["y"] + raw["h"] * outline[:, 1]], 1)
    p = rig.raw_to_view(fr["cam"], uv); p = p[np.isfinite(p).all(1)]
    if len(p) < 4:
        return None
    x0, y0 = np.clip(p.min(0), -2000, 2000); x1, y1 = np.clip(p.max(0), -2000, 2000)
    if x1 - x0 < 2 or y1 - y0 < 2:
        return None
    return [float(x0), float(y0), float(x1), float(y1)]


def _cluster(obs):
    """greedy cluster observations within ASSOC_M metres on the ground."""
    used = [False] * len(obs)
    groups = []
    order = sorted(range(len(obs)), key=lambda i: -obs[i]["conf"])
    for i in order:
        if used[i]:
            continue
        g = [obs[i]]; used[i] = True
        for j in order:
            if used[j]:
                continue
            if math.hypot(obs[j]["x"] - g[0]["x"], obs[j]["z"] - g[0]["z"]) < ASSOC_M:
                # also reject if another cam already in the group at a very different spot (keep closest)
                g.append(obs[j]); used[j] = True
        groups.append(g)
    return groups


def _side_of_ego(x, z, ego_x, ego_z, ego_yaw):
    """+1 = right of ego (US kerb), -1 = left. Uses road-plane cross product."""
    fx, fz = math.sin(ego_yaw), math.cos(ego_yaw)
    # right = rotate fwd +90° in xz: (fz, -fx)
    lat = (x - ego_x) * fz + (z - ego_z) * (-fx)
    return 1 if lat >= 0 else -1


def _yaw_from_side(ego_yaw, side, two_way=True):
    """US right-hand traffic prior: right kerb / same-dir = with ego; left on a two-way = against."""
    if two_way and side < 0:
        return _wrap(ego_yaw + math.pi)
    return _wrap(ego_yaw)


def _appearance_facing(g):
    """Vote whether the vehicle faces the observing camera (+1) or away (-1), else 0.

    Front/back cameras: bright/white upper band → headlights facing cam; red upper band → taillights.
    Stored per-lift as face_hint when available; falls back to rgb redness vs brightness.
    """
    votes = []
    for o in g:
        hint = o.get("face_hint")
        if hint is None:
            r, g_, b = o.get("rgb", [128, 128, 128])
            lum = (r + g_ + b) / 3.0
            # crude: very red and not bright → tail; bright and cool → head
            if r > g_ + 25 and r > b + 25 and lum < 140:
                hint = -1  # taillights → facing away from a forward-looking cam
            elif lum > 170 and b >= r - 10:
                hint = +1  # headlights
            else:
                hint = 0
        cam = o.get("cam", "")
        if cam in ("front", "back", "left_repeater", "right_repeater", "left_pillar", "right_pillar") and hint:
            # +1 means facing that camera → vehicle yaw ≈ cam_yaw + π
            votes.append((hint, o.get("yaw_cam", 0.0), o.get("conf", 0.5)))
    if not votes:
        return None
    # confidence-weighted: convert each vote to a vehicle yaw suggestion
    sx = sy = wsum = 0.0
    for hint, yaw_cam, conf in votes:
        yaw = _wrap(yaw_cam + math.pi) if hint > 0 else _wrap(yaw_cam)
        sx += conf * math.sin(yaw); sy += conf * math.cos(yaw); wsum += conf
    if wsum < 1e-6:
        return None
    return math.atan2(sx / wsum, sy / wsum)


def _fuse_group(g, ego_yaw, ego_xz=(0.0, 0.0), two_way=True):
    """cluster of lifts → one vehicle dict. Heading allows oncoming (no ±90° ego clamp)."""
    xs = np.array([o["x"] for o in g]); zs = np.array([o["z"] for o in g])
    ws = np.array([o["conf"] for o in g])
    x = float(np.average(xs, weights=ws)); z = float(np.average(zs, weights=ws))
    # class by confidence vote
    vote = {}
    for o in g:
        vote[o["cls"]] = vote.get(o["cls"], 0) + o["conf"]
    cls = max(vote, key=vote.get)
    L, W, H = SIZE[cls]
    apps = [o["app_w"] for o in g]
    app = float(np.median(apps))
    if app > 0.5:
        if app > W * 1.25:
            L = float(np.clip(app, L * 0.7, L * 1.35))
        else:
            W = float(np.clip(app, W * 0.7, W * 1.35))
    side = _side_of_ego(x, z, ego_xz[0], ego_xz[1], ego_yaw)
    # appearance (head/tail lights) first; else US RHT side-of-road prior
    yaw_app = _appearance_facing(g)
    if yaw_app is not None:
        yaw = yaw_app
    else:
        yaw = _yaw_from_side(ego_yaw, side, two_way=two_way)
    # side-camera length view can nudge toward road-parallel without flipping across traffic
    side_views = [o for o in g if o["app_w"] > W * 1.4 and o["cam"] in ("left_repeater", "right_repeater", "left_pillar", "right_pillar")]
    if side_views:
        o = max(side_views, key=lambda o: o["app_w"])
        cand = _wrap(o["yaw_cam"] + math.pi / 2)
        # pick the ±π of cand closest to our chosen yaw (keep oncoming if already set)
        if abs(_wrap(cand - yaw)) > math.pi / 2:
            cand = _wrap(cand + math.pi)
        if abs(_wrap(cand - yaw)) < math.radians(40):
            yaw = cand
    yaw = _wrap(yaw)
    rgb = [int(round(x)) for x in np.median([o["rgb"] for o in g], 0)]
    return dict(cls=cls, x=x, z=z, yaw=yaw, L=round(L, 2), W=round(W, 2), H=round(H, 2),
                rgb=rgb, conf=float(sum(ws) / len(ws)), n=len(g), est=True, side=side)


def _wrap(a):
    while a > math.pi:
        a -= 2 * math.pi
    while a < -math.pi:
        a += 2 * math.pi
    return a


def _smooth(steps):
    """assign stable ids across time and exponential-smooth x,z,yaw,L,W + rgb."""
    tracks = []  # live: {id, x, z, yaw, L, W, H, rgb, cls, miss, vx, vz, seen}
    next_id = 1
    out = []
    for vehs in steps:
        used = set(); placed = []
        for tr in tracks:
            # predict with last velocity (dt ≈ 1/6 s)
            px = tr["x"] + tr.get("vx", 0.0); pz = tr["z"] + tr.get("vz", 0.0)
            best, bi = TRACK_M, None
            for i, v in enumerate(vehs):
                if i in used:
                    continue
                if v["cls"] != tr["cls"] and not ({v["cls"], tr["cls"]} <= {"car", "truck"}):
                    continue
                d = math.hypot(v["x"] - px, v["z"] - pz)
                if d < best:
                    best, bi = d, i
            if bi is None:
                tr["miss"] = tr.get("miss", 0) + 1
                # parked tracks stay put on a miss; only coast when previously moving > ~1 m/s
                if tr["miss"] <= 2:
                    spd0 = math.hypot(tr.get("vx", 0), tr.get("vz", 0)) * 6.0
                    if spd0 > 1.0:
                        tr["x"], tr["z"] = px, pz
                    placed.append(tr)
                continue
            used.add(bi); v = vehs[bi]
            # gate: a match that jumps farther than ~2 m for a previously-slow track is a different car
            jump = math.hypot(v["x"] - tr["x"], v["z"] - tr["z"])
            spd0 = math.hypot(tr.get("vx", 0), tr.get("vz", 0)) * 6.0
            if spd0 < 1.0 and jump > 2.2:
                tr["miss"] = tr.get("miss", 0) + 1
                if tr["miss"] <= 2:
                    placed.append(tr)
                continue
            a = 0.4
            nx = (1 - a) * tr["x"] + a * v["x"]; nz = (1 - a) * tr["z"] + a * v["z"]
            tr["vx"] = nx - tr["x"]; tr["vz"] = nz - tr["z"]
            speed = math.hypot(tr["vx"], tr["vz"]) * 6.0  # m/s roughly
            tr["x"], tr["z"] = nx, nz
            dy = _wrap(v["yaw"] - tr["yaw"])
            # slow / parked: keep yaw locked (road-aligned); only turn when clearly moving
            if speed > 1.5:
                tr["yaw"] = _wrap(tr["yaw"] + a * dy)
            else:
                tr["yaw"] = _wrap(tr["yaw"] + 0.15 * dy)
                # damp velocity so parked cars don't accumulate drift into the next bay
                tr["vx"] *= 0.3; tr["vz"] *= 0.3
            tr["L"] = (1 - a) * tr["L"] + a * v["L"]
            tr["W"] = (1 - a) * tr["W"] + a * v["W"]
            tr["H"] = (1 - a) * tr["H"] + a * v["H"]
            tr["rgb"] = [int(round((1 - a) * tr["rgb"][k] + a * v["rgb"][k])) for k in range(3)]
            tr["cls"] = v["cls"]; tr["miss"] = 0; tr["est"] = True
            tr["seen"] = tr.get("seen", 0) + 1
            placed.append(tr)
        for i, v in enumerate(vehs):
            if i in used:
                continue
            # prefer multi-cam or higher-conf new tracks (conf lives on v via n)
            if v.get("n", 1) < 1:
                continue
            tr = dict(id=next_id, vx=0.0, vz=0.0, seen=1, miss=0,
                      **{k: v[k] for k in ("cls", "x", "z", "yaw", "L", "W", "H", "rgb", "est")})
            next_id += 1; tracks.append(tr); placed.append(tr)
        tracks = [t for t in tracks if t.get("miss", 0) < 3]
        out.append([dict(id=t["id"], cls=t["cls"], x=round(t["x"], 3), z=round(t["z"], 3),
                         yaw=round(t["yaw"], 4), L=round(t["L"], 2), W=round(t["W"], 2), H=round(t["H"], 2),
                         rgb=list(t["rgb"]), est=True, seen=t.get("seen", 1)) for t in placed])
    # drop tracks that never lived MIN_TRACK_STEPS frames
    keep_ids = set()
    for row in out:
        for v in row:
            if v.get("seen", 1) >= MIN_TRACK_STEPS or True:
                pass
    # recount seen across all steps
    life = {}
    for row in out:
        for v in row:
            life[v["id"]] = life.get(v["id"], 0) + 1
    keep_ids = {i for i, n in life.items() if n >= MIN_TRACK_STEPS}
    out = [[dict({k: v[k] for k in v if k != "seen"}) for v in row if v["id"] in keep_ids] for row in out]
    return out, len(keep_ids)


def run(work, page=None, log=print, rig=None, style=None):
    """Build vehicles.json from a finished work folder. page: also write into the page folder (for the viewer)."""
    from rig import Rig

    data = os.path.join(work, "data")
    fused = os.path.join(work, "fused")
    dets_path = os.path.join(work, "dets.json")
    tel_path = os.path.join(work, "telemetry.json")
    if not os.path.exists(dets_path):
        log("vehicles: no dets.json — run the detector step first (build without --no-detector)")
        return dict(n=0, steps=0)
    if not os.path.isdir(fused):
        raise SystemExit(f"vehicles: no fused/ in {work}")
    F = json.load(open(os.path.join(data, "frames.json")))
    dets = json.load(open(dets_path))
    if rig is None:
        if os.path.exists(tel_path):
            rig = Rig.from_telemetry(json.load(open(tel_path)))
        else:
            raise SystemExit("vehicles: need telemetry.json (or pass a Rig) to project detector boxes")

    # group frames by time step
    by_step = [[] for _ in range(F["steps"])]
    for fr in F["frames"]:
        by_step[fr["step"]].append(fr)

    # ego yaw per step from the front camera
    def ego_yaw(frames):
        fr = next((f for f in frames if f["cam"] == "front"), frames[0])
        R = np.asarray(fr["R"], float)
        return math.atan2(R[0, 2], R[2, 2])

    raw_steps = []
    ego_path = []  # (x, z, yaw) per step for heading priors / ego-compensated motion
    for frames in by_step:
        ey = ego_yaw(frames)
        # ego centre on the road: front camera C projected, then back 2.05 m along heading to the rear axle, +1.4 m to mid
        fr0 = next((f for f in frames if f["cam"] == "front"), frames[0])
        C0 = np.asarray(fr0["C"], float); R0 = np.asarray(fr0["R"], float)
        # camera is ~2.05 m ahead of rear axle; car mid is 1.4 m ahead of rear axle → mid is 0.65 m behind the front cam
        fwd = np.array([R0[0, 2], 0.0, R0[2, 2]]); fwd = fwd / (np.linalg.norm(fwd) + 1e-9)
        ego = np.array([C0[0], 0.0, C0[2]]) - 0.65 * fwd
        lifts = []
        for fr in frames:
            cam = fr["cam"]; t = fr["t_clip"]
            Z, rows = _load_depth(fused, fr["name"])
            R = np.asarray(fr["R"], float)
            yaw_cam = math.atan2(R[0, 2], R[2, 2])
            for tr in dets.get(cam, []):
                if tr.get("cls") not in VEHICLE:
                    continue
                best, bd = None, 0.09
                for kt, b in tr["keys"]:
                    d = abs(kt - t)
                    if d < bd:
                        bd, best = d, b
                if best is None or best.get("conf", 1) < MIN_CONF:
                    continue
                box = _view_box(rig, fr, best)
                if box is None:
                    continue
                hit = _lift(fr, box, Z, rows)
                if hit is None:
                    continue
                # reject hits on the ego body (oriented box around ego mid)
                dx, dz = hit["x"] - ego[0], hit["z"] - ego[2]
                c, s = math.cos(ey), math.sin(ey)
                lr, fb = dx * c + dz * s, -dx * s + dz * c
                if abs(lr) < EGO_HALF[0] and abs(fb) < EGO_HALF[1]:
                    continue
                rgb = _paint(fused, fr["name"], box)
                face_hint = _face_hint_from_box(fused, fr["name"], box)
                lifts.append(dict(cam=cam, cls=tr["cls"], conf=float(best.get("conf", 0.5)),
                                  x=hit["x"], z=hit["z"], app_w=hit["app_w"], rgb=rgb, yaw_cam=yaw_cam,
                                  face_hint=face_hint))
        groups = _cluster(lifts)
        # prefer multi-cam groups; keep strong single-cam ones within 25 m
        fused_g = []
        for g in groups:
            v = _fuse_group(g, ey, ego_xz=(float(ego[0]), float(ego[2])), two_way=True)
            if v["n"] >= 2 or (v["conf"] >= 0.45 and math.hypot(v["x"] - ego[0], v["z"] - ego[2]) < 25):
                fused_g.append(v)
        raw_steps.append(fused_g)
        ego_path.append((float(ego[0]), float(ego[2]), float(ey)))

    steps, n_ids = _smooth(raw_steps)
    for i, row in enumerate(steps):
        steps[i] = [v for v in row if v["L"] >= 1.2]
    # also de-dupe raw per-step before finalize already partly done; finalize locks parked + shapes
    n_before = sum(len(s) for s in steps)
    steps, n_ids = _finalize(steps, ego_path=ego_path, two_way=True)
    n_after = sum(len(s) for s in steps)
    parked_n = len({v["id"] for s in steps for v in s if v.get("parked")})

    doc = dict(mode="proxy", n=n_ids, models=list(MODELS), sizes={k: list(v) for k, v in SIZE.items()},
               steps=steps, stats=dict(poses_before=n_before, poses_after=n_after, parked=parked_n))
    if style == "future":
        future_looks(doc)
    out_work = os.path.join(work, "vehicles.json")
    json.dump(doc, open(out_work, "w"))
    if page:
        import shutil
        os.makedirs(page, exist_ok=True)
        json.dump(doc, open(os.path.join(page, "vehicles.json"), "w"))
        shutil.copy(os.path.join(os.path.dirname(__file__), "viewer.html"), os.path.join(page, "index.html"))
        n_models = _copy_models(page)
        log(f"  models: {n_models} glTF files → {page}/models/")
        if style == "future":
            log(f"  concept looks {doc['looks']}: {_copy_future(page)} files → {page}/models/future/")
    n_veh = sum(len(s) for s in steps)
    log(f"vehicles: {n_ids} tracks, {n_veh} poses over {len(steps)} steps "
        f"(dedupe {n_before}→{n_after}, parked={parked_n}) → {out_work}"
        + (f", {page}/vehicles.json" if page else ""))
    return dict(n=n_ids, poses=n_veh, steps=len(steps), poses_before=n_before, parked=parked_n)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("work", help="build work folder (has dets.json, fused/, data/)")
    ap.add_argument("--export", help="page folder to write vehicles.json + refreshed index.html into")
    ap.add_argument("--style", default=None, choices=["future"], help="future: tag cars with 2.5D concept looks (crossover / coupe)")
    ap.add_argument("--restyle", metavar="PAGE", help="only re-tag an existing page's vehicles.json (no refit) with --style, refresh index.html + models")
    a = ap.parse_args(argv)
    if a.restyle:
        import shutil
        f = os.path.join(a.restyle, "vehicles.json")
        doc = json.load(open(f))
        if a.style == "future":
            future_looks(doc)
        json.dump(doc, open(f, "w"))
        shutil.copy(os.path.join(os.path.dirname(__file__), "viewer.html"), os.path.join(a.restyle, "index.html"))
        _copy_models(a.restyle)
        n = _copy_future(a.restyle) if a.style == "future" else 0
        print(f"restyled {f}: looks {doc.get('looks')}, {n} concept files")
        return
    run(a.work, a.export, style=a.style)


if __name__ == "__main__":
    main()
