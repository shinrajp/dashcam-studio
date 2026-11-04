#!/usr/bin/env python3
"""depth3d.test.py — unit tests of tools/depth3d (the depth street replay builder) on synthetic data with known geometry; no
footage, no AI model (~1 min). `python3 test/depth3d.test.py`. Needs numpy, opencv-python-headless, ffmpeg, node.

 1. rig.py is js/rig.js: lens projection, rays and body test agree with js/rig.js pixel(), ray(), isBody().
 2. telemetry.js on tiny six-file clips with SEI telemetry whose file clocks are shifted by known offsets: frame times, rows
    and js/rig.js clockOffsets recover the shifts.
 3. delay.py: tracked points of a synthetic street, pictures lagging the telemetry by a known delay → the delay comes back.
 4. Drive / dataset poses: a camera's clip time → front telemetry time (clock + delay); the view's pose at t0.
 5. depth.py: a flat road with an upright box ("car") and sky, model disparity = a/Z + b with unknown a, b → road back at the
    road plane's depth, the box at its depth, sky dropped; a frame with a broken fit borrows the camera's scale.
 6. fuse.py + roadgrow.py: far road the depth squashes is grown back onto the road plane, but not inside a vehicle box.
 7. boxes.py: a detector box round a point in the raw fisheye maps to a view rectangle round that point (also the back
    camera, whose view is pitched 14° off the camera).
"""
import importlib.util, json, math, os, shutil, subprocess, sys, tempfile
import numpy as np, cv2

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "tools", "depth3d"))
import rig as RG  # noqa: E402
import depth, fuse, boxes, delay  # noqa: E402

fails = []


def ok(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)


def node(js):
    return json.loads(subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True, cwd=ROOT).stdout)


RJS = json.dumps(os.path.join(ROOT, "js", "rig.js"))
base = node(f"const R=require({RJS});const r={{}};for(const c of R.CAMS)r[c]=R.get(c);console.log(JSON.stringify({{rig:r,body:R.bodyBoxes(),aspect:R.ASPECT}}))")
rig = RG.Rig.from_telemetry(base)
TMP = tempfile.mkdtemp(prefix="depth3d-test-")

# ── 1. rig.py = js/rig.js ──
rng = np.random.default_rng(1); worst_px = worst_ray = 0; body_agree = []
for cam in RG.CAMS:
    pts = rng.uniform(-1, 1, (40, 2)) * 0.4 + 0.5
    js = node(f"const R=require({RJS});const P={json.dumps(pts.tolist())};console.log(JSON.stringify(P.map(([u,v])=>[R.ray('{cam}',u,v),R.isBody('{cam}',u,v)])))")
    for (u, v), (r, b) in zip(pts, js):
        if r is None: continue
        d = rig.fisheye_ray(cam, np.array([[u, v]]), 1, 1)[0]; worst_ray = max(worst_ray, np.degrees(np.arccos(np.clip(d @ np.array(r), -1, 1))))
        px, _ = rig.fisheye_project(cam, np.array([r]), 1, 1); worst_px = max(worst_px, np.hypot(px[0, 0] - u, px[0, 1] - v) * 1448)
        body_agree.append(bool(rig.is_body(cam, np.array([r]))[0]) == b)
ok(worst_ray < 0.01 and worst_px < 0.05, f"rig.py lens = js/rig.js ray()/pixel(): worst {worst_ray:.4f}°, {worst_px:.3f} px")
ok(np.mean(body_agree) > 0.99, f"rig.py body test = js/rig.js isBody() on {np.mean(body_agree) * 100:.0f} % of {len(body_agree)} rays")

# ── 2. telemetry.js: frame times, rows, clock offsets from shifted telemetry ──
spec = importlib.util.spec_from_file_location("ms", os.path.join(ROOT, "tools", "make-samples.py")); MS = importlib.util.module_from_spec(spec); spec.loader.exec_module(MS)
fx = json.load(open(os.path.join(ROOT, "test", "fixtures", "rig-telemetry-2026-10-19.json")))["cams"]["front"]
ft = np.array([r[0] for r in fx]); fs = np.array([r[1] for r in fx]); fh = np.unwrap(np.radians([r[2] for r in fx]))
SHIFT = {"front": 0, "back": 0.42, "left_pillar": -0.33, "right_pillar": 0.15, "left_repeater": -0.08, "right_repeater": 0.27}
FPS, SEC, T0 = 24, 10, 36.0
clipdir = os.path.join(TMP, "clips"); os.makedirs(clipdir)
for cam, sh in SHIFT.items():
    raw = os.path.join(TMP, cam + ".h264")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=s=128x96:r={FPS}:d={SEC}", "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high",
                    "-pix_fmt", "yuv420p", "-bf", "0", "-g", str(FPS), "-f", "h264", raw], check=True)
    rows = []
    for k in range(FPS * SEC):
        t = T0 + k / FPS + sh   # this file's clip time k/FPS is the front's k/FPS + shift
        rows.append(dict(gear=1, seq=k, speed=float(np.interp(t, ft, fs)), pedal=0, steer=0, bl=0, br=0, brake=0, ap=0, lat=37.39, lon=-122.15,
                         heading=math.degrees(float(np.interp(t, ft, fh))) % 360, ax=0, ay=0, az=0))
    data_ = MS.inject_sei(open(raw, "rb").read(), rows); open(raw, "wb").write(data_)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(FPS), "-i", raw, "-c", "copy", "-video_track_timescale", "90000",
                    os.path.join(clipdir, f"2026-01-02_03-04-05-{cam}.mp4")], check=True)
sys.path.insert(0, os.path.join(ROOT, "tools", "depth3d"))
import build  # noqa: E402
stamp, clips = build.find_clips(clipdir)
tel = build.telemetry(clips, os.path.join(TMP, "tel.json"))
ok(stamp == "2026-01-02_03-04-05" and len(clips) == 6, "find_clips: one clip of six files")
ok(all(len(tel["cams"][c]["frames"]) == FPS * SEC and len(tel["cams"][c]["rows"]) == FPS * SEC for c in SHIFT),
   f"telemetry.js: {FPS * SEC} frame times and telemetry rows per file")
ok(abs(tel["cams"]["back"]["frames"][1] - 1 / FPS) < 1e-4, "telemetry.js: frame times in seconds of the clip")
err = max(abs(tel["clocks"][c] - SHIFT[c]) for c in SHIFT)
ok(err < 0.01, f"clock offsets recovered from shifted telemetry (js/rig.js clockOffsets): max error {err * 1000:.1f} ms  {tel['clocks']}")
ok(build.inside_repo(os.path.join(ROOT, "x")) and not build.inside_repo(TMP), "build refuses output inside the (public) repository")

# ── 3. delay.py on synthetic tracks ──
rows = [dict(t=float(t), speed=float(s), heading=float(np.degrees(h))) for t, s, h in zip(ft - T0, fs, fh)]
path = RG.Path(rows); TRUE = 0.045
pts_w = []   # a street of static points round the route (world east/north/up), 0–3 m high, 3–15 m from the path
for t in np.arange(-2, 14, 0.05):
    e, n, h = path.at(t)
    for side in (-1, 1):
        lat = side * rng.uniform(3, 15); ah = rng.uniform(-3, 3)
        pts_w.append((e + math.cos(h) * lat + math.sin(h) * ah, n - math.sin(h) * lat + math.cos(h) * ah, rng.uniform(0, 3)))
pts_w = np.array(pts_w)
for cam in ["left_pillar", "back"]:
    ftimes = [k / 30 for k in range(300)]; P = rig.pos(cam); trk = {}
    for i, t in enumerate(ftimes):
        e, n, h = path.at(t + TRUE)   # the picture at clip t shows the car at telemetry time t + delay
        de, dn = pts_w[:, 0] - e, pts_w[:, 1] - n
        X = np.stack([de * math.cos(h) - dn * math.sin(h), pts_w[:, 2], de * math.sin(h) + dn * math.cos(h)], 1)
        uv, th = rig.fisheye_project(cam, X - P, 1, 1)
        vis = (th < rig.cams[cam]["thmax"]) & (uv[:, 0] > 0) & (uv[:, 0] < 1) & (uv[:, 1] > 0) & (uv[:, 1] < 1)
        uv = uv + rng.normal(0, 0.3 / 1448, uv.shape)   # 0.3 px tracking noise
        trk[i] = (np.flatnonzero(vis), uv[vis].astype(np.float32))
    prs = delay.pairs(trk, ftimes, 0.0, path)
    prs2 = [(i, j, x0, x1, rig.fisheye_ray(cam, x0.astype(float), 1, 1), rig.fisheye_ray(cam, x1.astype(float), 1, 1)) for i, j, x0, x1 in prs]
    d, info = delay.search(rig, cam, prs2, ftimes, 0.0, path)
    ok(info["ok"] and abs(d - TRUE) < 0.006, f"delay.py {cam}: delay {d * 1000:.1f} ms for a true {TRUE * 1000:.0f} ms ({info['pairs']} pairs)")
d, info = delay.search(rig, "front", [], [0], 0.0, path)
ok(not info["ok"] and d == 0, "delay.py: nothing to fit → 0 and not ok")

# ── 4. Drive / poses ──
dr = RG.Drive(rig, rows, 2.0, {"back": 0.3}, {"back": -0.05})
ok(abs(dr.ref_time("back", 1.0) - 1.25) < 1e-12, "Drive.ref_time = clip t + clock + delay")
Rw, C = dr.cam_to_world("front", 2.0)
ok(np.allclose(C, [0, -rig.pos("front")[1], rig.pos("front")[2]], atol=1e-6), f"front camera at t0 sits at its mounting, y down (C = {np.round(C, 3).tolist()})")
ok(abs(np.degrees(math.asin(-Rw[1, 2])) - RG.VIEW["front"]["pitch"]) < 1e-6 and abs(Rw[1, 0]) < 1e-9, "front view is level (no roll) at its view pitch")

# ── 5. depth.py: metric scale from the road ──
data = os.path.join(TMP, "data"); os.makedirs(os.path.join(data, "images")); os.makedirs(os.path.join(data, "masks"))
W, H, f, _ = rig.view("left_pillar")
frs = []
for s in range(3):
    Rw, C = dr.cam_to_world("left_pillar", 2.0 + s * 0.2)
    frs.append(dict(name=f"left_pillar_{s:05d}.jpg", cam="left_pillar", step=s, frame=s, t_clip=2.0 + s * 0.2, t_ref=2.0 + s * 0.2, t_grid=2.0 + s * 0.2,
                    R=Rw.tolist(), C=C.tolist(), f=f, cx=W / 2, cy=H / 2, w=W, h=H))
for fr in frs:   # grey road wherever the view sees the road plane, a blue-ish sky above
    Zr_, _ = depth.road_depth(fr); img = np.zeros((H, W, 3), np.uint8); img[:] = (200, 160, 120); img[np.isfinite(Zr_) & (Zr_ < 400)] = (90, 90, 90)
    cv2.imwrite(os.path.join(data, "images", fr["name"]), img); cv2.imwrite(os.path.join(data, "masks", fr["name"][:-4] + ".png"), np.full((H, W), 255, np.uint8))
json.dump(dict(cams=["left_pillar"], steps=3, frames=frs), open(os.path.join(data, "frames.json"), "w"))
BOX = (400, 520, 230, 330)   # x0, x1, y0, y1 of an upright 9 m away (a car's side)


def truth_depth(fr, squash=False):
    Zr, _ = depth.road_depth(fr); Z = np.where(np.isfinite(Zr) & (Zr < 200), Zr, np.inf)
    Z[BOX[2]:BOX[3], BOX[0]:BOX[1]] = 9.0
    if squash: Z = depth.squash(Z)
    return Z


class Model:   # stand-in AI model: true disparity, unknown scale/shift; frame 2 broken (inverted) to force a borrowed scale
    def __init__(self, squash=False): self.squash = squash
    def __call__(self, im, fr):
        Z = truth_depth(fr, self.squash); a, b = 3.0 + fr["step"], 0.02
        disp = np.where(np.isfinite(Z), a / Z + b, 0.0)
        if fr["step"] == 2: disp = np.where(np.isfinite(Z), disp[::-1], 0.0)
        return cv2.resize(disp.astype(np.float32), (depth.IW, depth.IH), interpolation=cv2.INTER_NEAREST)


D = depth.run(data, os.path.join(TMP, "depth"), Model(), log=lambda *a: None)
Z0 = np.load(os.path.join(TMP, "depth", frs[0]["name"][:-4] + ".npy")); Zt = truth_depth(frs[0]); Zr, vv = depth.road_depth(frs[0])
road = np.isfinite(Zr) & (Zr < 60) & (Z0 > 0); road[BOX[2] - 4:BOX[3] + 4, BOX[0] - 4:BOX[1] + 4] = False
e_road = np.median(np.abs(Z0[road] / Zr[road] - 1)); e_box = np.median(np.abs(Z0[BOX[2] + 5:BOX[3] - 5, BOX[0] + 5:BOX[1] - 5] / 9.0 - 1))
ok(e_road < 0.02, f"depth.py: flat road back at the road plane's depth (median error {e_road * 100:.2f} %, scale/shift unknown to it)")
ok(e_box < 0.03, f"depth.py: upright box back at 9 m (median error {e_box * 100:.2f} %)")
ok((Z0[:H // 3] == 0).mean() > 0.95, "depth.py: sky dropped")
ok(D["frames"][2]["borrowed"] and not D["frames"][0]["borrowed"], "depth.py: a frame with a broken road fit borrows the camera's scale")

# ── 6. fuse.py + roadgrow.py ──
shutil.rmtree(os.path.join(TMP, "depth"))
for squash_box in (False, True):
    depth.run(data, os.path.join(TMP, "depth"), Model(squash=True), log=lambda *a: None)
    rows_far = np.flatnonzero((np.isfinite(Zr) & (Zr > 25) & (Zr < 200)).any(1))   # the rows showing road past 25 m
    vb = {fr["name"]: [[0, int(rows_far.min()) - 1, W // 2, int(rows_far.max()) + 2]] for fr in frs} if squash_box else {}
    st = fuse.run(data, os.path.join(TMP, "depth"), os.path.join(TMP, "fused"), vb, log=lambda *a: None)
    Zf = np.load(os.path.join(TMP, "fused", frs[0]["name"][:-4] + ".npy"))
    far = np.isfinite(Zr) & (Zr > 30) & (Zr < 60); far[BOX[2] - 4:BOX[3] + 4, BOX[0] - 4:BOX[1] + 4] = False
    good = far & (Zf > 0) & (np.abs(Zf / np.where(far, Zr, 1) - 1) < 0.02)
    left, right = good[:, :W // 2][far[:, :W // 2]].mean(), good[:, W // 2:][far[:, W // 2:]].mean()
    if not squash_box: ok(left > 0.8 and right > 0.8 and st["grown_px"] > 0, f"fuse.py: far road (30–60 m, squashed by the depth) grown back onto the road plane: {left * 100:.0f} % / {right * 100:.0f} %")
    else: ok(left < 0.2 and right > 0.8, f"fuse.py: no road grown inside a vehicle box (left half boxed: {left * 100:.0f} % grown, right {right * 100:.0f} %)")
    shutil.rmtree(os.path.join(TMP, "depth")); shutil.rmtree(os.path.join(TMP, "fused"))

# ── 7. boxes.py ──
for cam, P in [("left_pillar", [-6.0, 0.8, 4.0]), ("back", [0.5, 0.6, -8.0]), ("right_repeater", [5, 0.7, -3])]:
    uv, _ = rig.fisheye_project(cam, np.array([P]) - rig.pos(cam), 1, 1); u, v = uv[0]
    W, H, f, Rv = rig.view(cam); g = (np.array(P) - rig.pos(cam)) @ Rv; pu, pv = W / 2 + f * g[0] / g[2], H / 2 - f * g[1] / g[2]
    fr = dict(name="x.jpg", cam=cam, t_clip=1.0)
    rect = boxes.to_views(rig, [fr], {cam: [dict(cls="car", keys=[[1.01, dict(x=u - 0.03, y=v - 0.03, w=0.06, h=0.06)]])]})["x.jpg"]
    ok(len(rect) == 1 and rect[0][0] < pu < rect[0][2] and rect[0][1] < pv < rect[0][3] and (rect[0][2] - rect[0][0]) < W / 2,
       f"boxes.py {cam}: a raw box round a point → view rectangle {rect[0] if rect else None} round its view pixel ({pu:.0f}, {pv:.0f})")
ok(boxes.to_views(rig, [dict(name="x.jpg", cam="back", t_clip=5.0)], {"back": [dict(cls="car", keys=[[1.0, dict(x=.4, y=.4, w=.1, h=.1)]])]})["x.jpg"] == [],
   "boxes.py: a box from another moment (> 0.08 s away) is not used")

shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{'ALL OK' if not fails else str(len(fails)) + ' FAILED'}")
sys.exit(1 if fails else 0)
