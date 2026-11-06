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
 6e. scenewb.py: constants = js/wb.js / js/colour-constancy.js; a painted cast recovered; day / night limits; camera
    match clamp; CAT16 / Bradford white → neutral; run() leaves the depth / frames byte-identical.
 7. boxes.py: a detector box round a point in the raw fisheye maps to a view rectangle round that point (also the back
    camera, whose view is pitched 14° off the camera).
 8. vehicles.py: a car on the road at a known pose, seen by the front camera, lifts to that ground point (±1 m) and a
    two-step track keeps a stable id; --vehicles off leaves fused depth byte-identical (no vehicles.json written by build).
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
def synth_pairs(cam, true):
    ftimes = [k / 30 for k in range(300)]; P = rig.pos(cam); trk = {}
    for i, t in enumerate(ftimes):
        e, n, h = path.at(t + true)   # the picture at clip t shows the car at telemetry time t + delay
        de, dn = pts_w[:, 0] - e, pts_w[:, 1] - n
        X = np.stack([de * math.cos(h) - dn * math.sin(h), pts_w[:, 2], de * math.sin(h) + dn * math.cos(h)], 1)
        uv, th = rig.fisheye_project(cam, X - P, 1, 1)
        vis = (th < rig.cams[cam]["thmax"]) & (uv[:, 0] > 0) & (uv[:, 0] < 1) & (uv[:, 1] > 0) & (uv[:, 1] < 1)
        uv = uv + rng.normal(0, 0.3 / 1448, uv.shape)   # 0.3 px tracking noise
        trk[i] = (np.flatnonzero(vis), uv[vis].astype(np.float32))
    prs = delay.pairs(trk, ftimes, 0.0, path)
    return ftimes, [(i, j, x0, x1, rig.fisheye_ray(cam, x0.astype(float), 1, 1), rig.fisheye_ray(cam, x1.astype(float), 1, 1)) for i, j, x0, x1 in prs]


for cam in ["left_pillar", "back"]:
    ftimes, prs2 = synth_pairs(cam, TRUE)
    d, info = delay.search(rig, cam, prs2, ftimes, 0.0, path)
    ok(info["ok"] and abs(d - TRUE) < 0.006, f"delay.py {cam}: delay {d * 1000:.1f} ms for a true {TRUE * 1000:.0f} ms ({info['pairs']} pairs)")
d, info = delay.search(rig, "front", [], [0], 0.0, path)
ok(not info["ok"] and d == 0, "delay.py: nothing to fit → 0 and not ok")
# out of range: the same synthetic street with the pictures 0.15 s behind is fitted near 0.15 s but rejected (beyond ±0.1 s)
ft_far, prs_far = synth_pairs("left_pillar", 0.15)
d_far, info_far = delay.search(rig, "left_pillar", prs_far, ft_far, 0.0, path)
ok(not info_far["ok"] and info_far.get("rejected") is not None and abs(info_far["rejected"] - 0.15) < 0.01 and d_far == 0,
   f"delay.py: a fitted 150 ms delay is rejected (beyond ±{delay.MAX_DELAY * 1000:.0f} ms): {info_far}")
ok(delay.choose("back", 0.03, {"ok": True}, {"back": -0.02}) == (0.03, "fit"), "delay.choose: a good fit wins")
ok(delay.choose("back", 0.0, {"ok": False}, {"back": -0.02}) == (-0.02, "rig"), "delay.choose: rejected fit → the rig's delay")
ok(delay.choose("back", 0.0, {"ok": False}, {}) == (0.0, "none"), "delay.choose: rejected fit and no rig delay → 0 (source none)")
ok(delay.choose("front", 0.0, None, {"front": 0.01}) == (0.01, "rig"), "delay.choose: --delays rig takes the rig's delay")

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

# ── 6b. kerb.py and localscale.py, synthetic: plain grey kerb (no paint), flat road, rig camera models ──
import kerb, localscale  # noqa: E402
KX, KH = 3.0, 0.15   # a kerb 3 m right of the car's centre line, 15 cm high, unpainted


def scene_depth(fr, kerb_on, kh=KH):
    """true camera-z depth of the flat road, or of the road with a vertical kerb face at x = KX and a raised top beyond it."""
    R, C = np.array(fr["R"]), np.array(fr["C"]); dw = kerb._dirs(fr, R); wy = dw[..., 1]
    with np.errstate(divide="ignore", invalid="ignore"):
        Zr = np.where(wy > 1e-4, -C[1] / wy, np.inf)
        if not kerb_on: return np.where(Zr < 200, Zr, np.inf)
        x_road = C[0] + Zr * dw[..., 0]
        Zt = np.where(wy > 1e-4, (-kh - C[1]) / wy, np.inf)                     # raised top plane
        Zf = np.where(dw[..., 0] > 1e-4, (KX - C[0]) / dw[..., 0], np.inf)       # vertical face plane
        yf = C[1] + Zf * wy
        Z = np.where(x_road < KX, Zr, np.where((yf <= 0) & (yf >= -kh), Zf, Zt))
    return np.where(Z < 200, Z, np.inf)


def ai_like(Z, a=4.0, b=0.03, blur=2.0, noise=0.005, seed=1):
    """what a monocular model returns: disparity a/Z + b, blurred over a few pixels, a little noise; → its depth with the scale known."""
    rng = np.random.default_rng(seed); d = np.where(np.isfinite(Z), a / Z + b, 0.0).astype(np.float32)
    d = cv2.GaussianBlur(d, (0, 0), blur) * (1 + noise * rng.standard_normal(d.shape)).astype(np.float32)
    with np.errstate(divide="ignore"): return np.where(d > b + 1e-4, a / (d - b), 0).astype(np.float32)


KC = {}
for cam in ("right_repeater", "back", "right_pillar"):
    Wk, Hk, fk, _ = rig.view(cam); Rk, Ck = dr.cam_to_world(cam, 2.0)
    KC[cam] = dict(name=f"{cam}_k.jpg", cam=cam, R=Rk.tolist(), C=Ck.tolist(), f=fk, cx=Wk / 2, cy=Hk / 2, w=Wk, h=Hk)
for cam in ("right_repeater", "right_pillar"):
    fr = KC[cam]; R, C = np.array(fr["R"]), np.array(fr["C"])
    band, Zk, kept = kerb.detect(fr, ai_like(scene_depth(fr, True)), R, C)
    # a vehicle box standing on that kerb: no band inside the box widened by fuse.KERB_PAD (the car's wheels / shadow step)
    if band.sum():
        ys, xs = np.nonzero(band); bx = (int(np.percentile(xs, 30)), int(ys.min()) - 40, int(np.percentile(xs, 70)), int(np.median(ys)))
        ex = fuse.kerb_exclusion([bx], band.shape); bandv, _, _ = kerb.detect(fr, ai_like(scene_depth(fr, True)), R, C, valid=~ex)
        ok(not (bandv & ex).any() and (bandv & ~ex).sum() >= 0.5 * (band & ~ex).sum() and ex[bx[3] + 1:, bx[0]:bx[2]].any(),
           f"fuse.kerb_exclusion {cam}: no band in a padded vehicle box ({int((band & ex).sum())} → {int((bandv & ex).sum())} px), "
           f"the kerb outside it kept ({int((bandv & ~ex).sum())} of {int((band & ~ex).sum())} px)")
    P = C + (kerb._dirs(fr, R)[band] * Zk[band][:, None]); hs = -P[:, 1]
    top = hs > 0.02
    ok(len(kept) > 20 and band.sum() > 200, f"kerb.py {cam}: an unpainted 15 cm kerb 3 m out is found as a raised band ({len(kept)} columns, {int(band.sum())} px)")
    if len(kept):
        A = np.array(kept); ok(abs(np.median(A[:, 4]) - KH) < 0.06 and abs(np.median(A[:, 3]) / np.median(np.hypot(*(np.array([KX, 0]) - [C[0], 0]))) - 1) < 0.5,
                               f"kerb.py {cam}: its height {np.median(A[:, 4]):.3f} m (true {KH}) from the rig's rays, not the depth scale")
        ok(top.any() and abs(np.median(P[top, 0]) - KX) < 0.6 and abs(np.median(hs[top]) - KH) < 0.06,
           f"kerb.py {cam}: band placed raised beyond the kerb line (x median {np.median(P[top, 0]):.2f} m, height {np.median(hs[top]):.3f} m)")
    for seed in range(3):
        band0, _, kept0 = kerb.detect(fr, ai_like(scene_depth(fr, False), noise=0.01, seed=seed), R, C)
        ok(band0.sum() == 0, f"kerb.py {cam}: flat road, no kerb, depth noise 1 % (seed {seed}) → no raised band ({int(band0.sum())} px)")
    for sc in (0.6, 1.8):   # the depth scale is wrong everywhere: the kerb is still found at its true height
        _, _, kept2 = kerb.detect(fr, ai_like(scene_depth(fr, True)) * sc, R, C)
        ok(len(kept2) > 20 and abs(np.median(np.array(kept2)[:, 4]) - KH) < 0.06, f"kerb.py {cam}: depth scale off ×{sc} → kerb still found ({len(kept2)} columns), {np.median(np.array(kept2)[:, 4]) if kept2 else 0:.3f} m high")
    for kh, want in ((0.10, True), (0.22, True), (0.04, False), (0.60, False)):   # kerb heights, a too-low lip, a wall-like step
        _, _, k3 = kerb.detect(fr, ai_like(scene_depth(fr, True, kh)), R, C)
        hm = float(np.median(np.array(k3)[:, 4])) if k3 else 0.0
        ok((len(k3) > 20 and abs(hm - kh) < 0.05) if want else len(k3) == 0,
           f"kerb.py {cam}: a {kh * 100:.0f} cm step → {'band' if want else 'no band'} ({len(k3)} columns, {hm:.3f} m)")


def ls_cam(cam, Z):
    fr = KC[cam]; R, C = np.array(fr["R"]), np.array(fr["C"]); dw = kerb._dirs(fr, R); wy = dw[..., 1]
    with np.errstate(divide="ignore", invalid="ignore"): Zr = np.where(wy > 1e-4, -C[1] / wy, np.inf)
    return dict(cam=cam, f=fr, R=R, C=C, Z=Z.copy(), Zr=Zr, wy=wy, m=np.ones(Z.shape, bool))


Zb = ai_like(scene_depth(KC["back"], False)); Zq = ai_like(scene_depth(KC["right_repeater"], False))
Zq_bad = np.where(Zq > 0, 1 / (0.8 / np.maximum(Zq, 1e-3) + 0.004), 0).astype(np.float32)    # repeater's local scale ~1.2× off
cams = [ls_cam("back", Zb), ls_cam("right_repeater", Zq_bad)]
res = localscale.refit(cams, fuse.SNAP)["right_repeater"]
q = cams[1]; ov = (q.get("ls_w", np.zeros(q["Z"].shape)) > 0.99) & np.isfinite(q["Zr"]) & (q["Zr"] < 20) & (q["Z"] > 0)
e0 = np.median(np.abs(Zq_bad[ov] / q["Zr"][ov] - 1)); e1 = np.median(np.abs(q["Z"][ov] / q["Zr"][ov] - 1))
ok(res["ok"] and e1 < 0.5 * e0, f"localscale.py: the repeater's off scale refitted on the back camera's road: error {e0 * 100:.1f} → {e1 * 100:.1f} % ({res})")
cams = [ls_cam("back", Zb), ls_cam("right_repeater", Zq_bad)]; cams[0]["m"][:] = False      # the reference sees nothing
res = localscale.refit(cams, fuse.SNAP)["right_repeater"]
ok(not res["ok"] and np.array_equal(cams[1]["Z"], Zq_bad), f"localscale.py guard: too few overlap points → global fit kept ({res['why']})")
Zq_3 = np.where(Zq > 0, Zq * 3.0, 0).astype(np.float32)
cams = [ls_cam("back", Zb), ls_cam("right_repeater", Zq_3)]
res = localscale.refit(cams, fuse.SNAP)["right_repeater"]
ok(not res["ok"] and np.array_equal(cams[1]["Z"], Zq_3), f"localscale.py guard: a 3× scale (alpha out of [0.5, 2]) → global fit kept ({res['why']})")


# ── 6c. wb.py (white balance before depth): synthetic grey road texture seen by the rig's cameras ──
import wb  # noqa: E402


def tex(P):
    """a grey road with mid-frequency texture (no colour of its own), linear RGB."""
    t = 0.25 + 0.1 * np.sin(P[..., 0] * 3.1) * np.cos(P[..., 2] * 2.3) + 0.05 * np.sin(P[..., 2] * 7.7)
    return np.repeat(t[..., None], 3, -1).astype(np.float32)


def wb_view(cam, cast=(1, 1, 1), car=None):
    fr = KC[cam]; R, C = np.array(fr["R"]), np.array(fr["C"]); dw = kerb._dirs(fr, R)
    with np.errstate(divide="ignore", invalid="ignore"): s = np.where(dw[..., 1] > 1e-4, -C[1] / dw[..., 1], 0)
    P = C + dw * s[..., None]; im = tex(P) * np.array(cast, np.float32); im[dw[..., 1] <= 1e-4] = 0.6
    if car is not None: im[car(P) & (s > 0)] = (0.05, 0.05, 0.5)          # a red car (BGR), in no vehicle box
    return dict(f=fr, R=R, C=C, im=np.clip(im, 0, 1), m=np.ones(im.shape[:2], bool), boxes=[]), P


WBC = ["back", "right_repeater", "right_pillar"]
cast = (0.85, 1.0, 1.2)
row = {"back": wb_view("back")[0], "right_repeater": wb_view("right_repeater", cast)[0], "right_pillar": wb_view("right_pillar")[0]}
G, cl, n = wb.fit([row], WBC, ref="back")
want = 1 / np.array(cast)
ok(n >= 2 and np.abs(G[1] / want - 1).max() < 0.02 and np.abs(G[2] - 1).max() < 0.02,
   f"wb.py: a known colour cast {cast} on the repeater is recovered: gains {np.round(G[1], 3)} (want {np.round(want, 3)}), pillar {np.round(G[2], 3)}")
row2 = dict(row); row2["right_repeater"] = wb_view("right_repeater", (0.5, 1.0, 1.0))[0]
G2, cl2, _ = wb.fit([row2], WBC, ref="back")
ok(cl2[1, 0] and abs(G2[1, 0] - wb.GAIN_HI) < 1e-9 and np.all((G2 >= wb.GAIN_LO) & (G2 <= wb.GAIN_HI)),
   f"wb.py: a 2x cast is clamped to {wb.GAIN_HI} and flagged (gain {G2[1, 0]:.3f})")
_, Pq = wb_view("right_repeater")
Qb = (Pq - row["back"]["C"]) @ row["back"]["R"]; fb = row["back"]["f"]
with np.errstate(divide="ignore", invalid="ignore"):
    ub = fb["cx"] + fb["f"] * Qb[..., 0] / Qb[..., 2]; vb_ = fb["cy"] + fb["f"] * Qb[..., 1] / Qb[..., 2]
seen = (Qb[..., 2] > 0.3) & (ub > 0) & (ub < fb["w"]) & (vb_ > 0) & (vb_ < fb["h"]) & (np.hypot(Pq[..., 0], Pq[..., 2]) < 15)
z30, z60 = np.percentile(Pq[seen][:, 2], [30, 60])
car = lambda P: (P[..., 2] > z30) & (P[..., 2] < z60) & (np.hypot(P[..., 0], P[..., 2]) < 15)
row3 = dict(row); row3["right_repeater"] = wb_view("right_repeater", cast, car)[0]
G3, _, _ = wb.fit([row3], WBC, ref="back")
ok(np.abs(G3[1] / want - 1).max() < 0.04, f"wb.py: a red car over 30 % of the overlap (in no box) does not skew the fit: {np.round(G3[1], 3)} (want {np.round(want, 3)})")
ok(abs(wb.solve([(0, 1, np.log([0.9, 1.0, 1.1]), 1000)], ["back", "right_repeater"], "back")[0][1][0] - 1 / 0.9) < 0.02,
   "wb.py: the solve holds the reference at 1 and gives the other camera the inverse ratio")


# ── 6d. wb.py stage 1 (neutral, every camera) and colour.py global solve (no reference camera) ──
import colour as COL  # noqa: E402
fcast = (0.8, 1.0, 1.2)
nrow = {"back": wb_view("back")[0], "right_repeater": wb_view("right_repeater")[0], "right_pillar": wb_view("right_pillar")[0]}
nrow["back"]["im"] = np.clip(nrow["back"]["im"] * np.array(fcast, np.float32), 0, 1)       # the camera that used to be the reference
CH, E, Gn, _ = wb.neutral_fit([nrow], WBC)
px = wb.road_pixels(dict(nrow["back"], im=np.clip(nrow["back"]["im"] * Gn[0], 0, 1)))
res = np.abs(np.log(np.median(px, 0)[[0, 2]] / np.median(px, 0)[1])).max()
ok(res < 0.02, f"wb.py stage 1: a cast {fcast} on the reference-like camera is brought to neutral (chroma {np.round(CH[0], 3)}, residual {res:.3f})")
erow = dict(nrow); erow["right_repeater"] = dict(nrow["right_repeater"], im=np.clip(nrow["right_repeater"]["im"] * 0.7, 0, 1))
CH2, E2, _, _ = wb.neutral_fit([erow], WBC)
ok(np.abs(CH2[1] - 1).max() < 0.02 and abs(E2[1] / E2[2] - 1 / 0.7) < 0.05,
   f"wb.py stage 1: a dark camera (×0.7) gets exposure {E2[1] / E2[2]:.2f}× (want {1 / 0.7:.2f}) and no chroma change {np.round(CH2[1], 3)}")
crow = dict(nrow); crow["right_pillar"] = dict(nrow["right_pillar"], im=np.clip(nrow["right_pillar"]["im"] * np.array((0.45, 1, 1.0), np.float32), 0, 1))
CH3, _, _, _ = wb.neutral_fit([crow], WBC)
ok(abs(CH3[2, 0] - wb.CHROMA_HI) < 1e-9 and np.all((CH3 >= wb.CHROMA_LO) & (CH3 <= wb.CHROMA_HI)), f"wb.py stage 1: chroma clamped to {wb.CHROMA_LO}–{wb.CHROMA_HI} ({np.round(CH3[2], 3)})")
drow = dict(nrow); drow["right_pillar"] = dict(nrow["right_pillar"], im=np.clip(nrow["right_pillar"]["im"] * 0.2, 0, 1))
_, E4, _, _ = wb.neutral_fit([drow], WBC)
ok(E4.max() <= wb.EXPO_HI + 1e-9, f"wb.py stage 1: exposure clamped to {wb.EXPO_HI} (got {E4.max():.3f})")
rng = np.random.default_rng(3); C6 = ["front", "back", "left_pillar", "right_pillar", "left_repeater", "right_repeater"]
true = np.exp(rng.normal(0, 0.08, (6, 3))); true /= np.exp(np.log(true).mean(0))     # geometric mean 1: a global solve can see only ratios
eqs = [(i, j, np.log(true[j] / true[i]), 200000) for i in range(6) for j in range(6) if i != j and (abs(i - j) <= 2)]
Gs = COL.solve_gains(eqs, C6, global_match=True)
ok(np.abs(Gs * true - 1).max() < 0.02, f"colour.py global solve: six cameras with known casts recovered with no reference camera (worst {np.abs(Gs * true - 1).max():.3f})")
G0 = COL.solve_gains([], C6, global_match=True); ok(np.allclose(G0, 1), "colour.py global solve: no shared road → identity")

# ── 6e. scenewb.py (the viewer's white balance on the final textures): constants = the JS, synthetic casts ──
import re, scenewb as SW  # noqa: E402
js = open(os.path.join(ROOT, "js", "wb.js")).read(); blk = js[js.index("  WB.C = {"):js.index("  };", js.index("  WB.C = {"))]
jsC = {k: float(v) for k, v in re.findall(r"\b([A-Z_0-9]+): (-?[0-9.]+)\b(?![\]0-9.])", blk)}
for k in ["DAY_Y", "PCT"]: jsC[k] = tuple(float(x) for x in re.search(k + r": \[([^\]]+)\]", blk).group(1).split(","))
miss = [k for k, v in jsC.items() if k in SW.C and (tuple(SW.C[k]) if isinstance(v, tuple) else SW.C[k]) != v]
need = ["STRENGTH", "TINT_K", "NIGHT_K", "NIGHT_TEMP", "BLUE_MAX", "DAY_K", "DAY_TEMP", "DAY_TINT", "MATCH_MAX", "MATCH_EMA", "GAIN_MIN", "GAIN_MAX", "EMA", "JUMP"]
ok(not miss and all(k in jsC and k in SW.C for k in need), f"scenewb.C = js/wb.js WB.C (differ: {miss})")
cc = open(os.path.join(ROOT, "js", "colour-constancy.js")).read()
pri = dict(re.findall(r"(\w+): ([0-9.]+)", re.search(r"PRIOR: \{([^}]+)\}", cc).group(1)))
ok({k: float(v) for k, v in pri.items()} == SW.PRIOR and float(re.search(r"ROBUST_DEG: ([0-9.]+)", cc).group(1)) == SW.ROBUST_DEG,
   f"scenewb PRIOR / ROBUST_DEG = js/colour-constancy.js ({pri})")
nums = lambda name: [float(x) for x in re.findall(r"-?[0-9]+\.[0-9]+", re.search(name + r"[^\[]*(\[\[[^;]+?\]\])", cc).group(1))]
ok(np.allclose(nums("RGB2XYZ"), SW.RGB2XYZ.ravel()) and np.allclose(nums("cat16"), SW.CATS["cat16"].ravel()) and np.allclose(nums("bradford"), SW.CATS["bradford"].ravel()),
   "scenewb RGB2XYZ / CAT16 / Bradford matrices = js/colour-constancy.js")
# a painted body with a known cast in the mirror strip: analyse + the tracker recover it
rng = np.random.default_rng(3); cast = np.array([0.82, 1.0, 1.12])
strip = (rng.uniform(30, 200, (SW.C["GH"], SW.C["GW"], 1)) * rng.uniform(0.5, 1.5, (SW.C["GH"], SW.C["GW"], 3))).clip(0, 255)
runs = SW.wedge(SW.C["ZONE_W"])
for y in range(SW.C["GH"]): strip[y, :runs[y]] = 170 * cast * rng.uniform(0.95, 1.05, (runs[y], 1))
a = SW.analyse(strip.astype(np.uint8), runs); T = SW.Tracker()
for _ in range(10): T.update(a.get("rgb"))
w = T.white(); got = w / w[1]
ok(a.get("found") and np.allclose(got, cast, atol=0.03), f"scenewb.analyse: painted body cast {cast.tolist()} recovered as {np.round(got, 3).tolist()}")
# the viewer's limits: by day ±DAY_TEMP temperature / ±DAY_TINT tint, at night ±NIGHT_TEMP and blue ≤ BLUE_MAX
for wt in ([125, 210, 230], [230, 180, 110], [200, 140, 210]):
    for day, mt, mn in [(1, SW.C["DAY_TEMP"], SW.C["DAY_TINT"]), (0, SW.C["NIGHT_TEMP"], 1)]:
        l = np.log(SW.view_gains(wt, day)); temp = (l[2] - l[0]) / 2; tint = l[1] - (l[0] + l[2]) / 2
        ok(abs(temp) <= mt + 1e-9 and abs(tint) <= mn + 1e-9 and np.exp(l[2]) <= SW.C["BLUE_MAX"] + 1e-9,
           f"scenewb.view_gains {wt} day={day}: temperature {temp:.3f} (≤ {mt}), tint {tint:.3f} (≤ {mn}), blue {np.exp(l[2]):.2f}")
# camera matching: a camera far off the mirror cameras is pulled at most MATCH_MAX (log) toward them
def flat(c): return np.clip(rng.normal(1, 0.08, (60, 96, 1)) * 120 * np.array(c), 0, 255).astype(np.uint8)
T = SW.Tracker()
for _ in range(60): T.match_cams({"left_repeater": flat([1, 1, 1]), "right_repeater": flat([1, 1, 1]), "front": flat([1.12, 1, 0.9]), "back": flat([0.98, 1, 1.03])})
mf, mb = np.array(T.match["front"]), np.array(T.match["back"])
ok(np.all(np.abs(mf) <= SW.C["MATCH_MAX"] + 1e-9) and abs(abs(mf[0]) - SW.C["MATCH_MAX"]) < 1e-3 and mf[0] < 0 < mf[1] and np.all(np.abs(mb - [0.02, -0.03]) < 0.02),
   f"scenewb.match_cams: front (+12 % red) clamped at ±{SW.C['MATCH_MAX']}: {np.round(mf, 3).tolist()}; back small: {np.round(mb, 3).tolist()}")
g = SW.gains_for([1.1, 1.0, 0.9], [0.05, -0.05]); ok(abs(SW.luma(*g) - SW.luma(1.1, 1.0, 0.9)) < 1e-12, "scenewb.gains_for keeps the brightness (js/wb.js gainsFor)")
# CAT16 / Bradford at D = 1 map the white to neutral; at D = 0.7 part way
for m in ["cat16", "bradford"]:
    wl = SW.srgb_to_lin([125, 210, 230]); o = SW.viewer_matrix([125, 210, 230], m, 1.0) @ wl; o7 = SW.viewer_matrix([125, 210, 230], m, 0.7) @ wl
    ch = lambda v: np.hypot(np.log(v[0] / v[1]), np.log(v[2] / v[1]))
    ok(ch(o) < 1e-3 and ch(wl) * 0.2 < ch(o7) < ch(wl) * 0.5, f"scenewb.viewer_matrix {m}: white → neutral at D=1 ({ch(o):.4f}), D=0.7 part way ({ch(o7):.3f} of {ch(wl):.3f})")
# run(): rewrites only the textures; depth (.npy) and frames.json untouched (geometry identical)
fd = os.path.join(TMP, "swfused"); os.makedirs(fd, exist_ok=True)
fj = dict(cams=["front", "left_repeater"], frames=[dict(name=f"{c}_0.jpg", cam=c) for c in ["front", "left_repeater"]])
json.dump(fj, open(os.path.join(fd, "frames.json"), "w"))
for f in fj["frames"]: cv2.imwrite(os.path.join(fd, f["name"]), np.full((40, 60, 3), (200, 150, 110), np.uint8)); np.save(os.path.join(fd, f["name"][:-4] + ".npy"), np.arange(2400.).reshape(40, 60))
before = {n: open(os.path.join(fd, n), "rb").read() for n in os.listdir(fd) if not n.endswith(".jpg")}
real = SW.estimate; SW.estimate = lambda *a, **k: dict(white=np.array([125, 210, 230.]), sceneY=110, day=1.0, match={"front": [0.07, -0.07]}, source="paint")
for adapt in ["gains", "cat16"]:
    for f in fj["frames"]: cv2.imwrite(os.path.join(fd, f["name"]), np.full((40, 60, 3), (200, 150, 110), np.uint8))
    out = SW.run(fd, {}, {}, 0, 1, None, adapt=adapt, log=lambda *a: None); px = cv2.imread(os.path.join(fd, "front_0.jpg"))[20, 30]
    ok(out["applied"] and all(open(os.path.join(fd, n), "rb").read() == b for n, b in before.items()) and px[0] < 200 and px[2] > 110,
       f"scenewb.run {adapt}: blue-cast texture warmed ({px[::-1].tolist()}), .npy / frames.json byte-identical")
SW.estimate = real

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


# ── 8. vehicles.py ──
import vehicles as VH
# synthetic: one car 8 m ahead on the road, front camera at the origin looking +z
vd = os.path.join(TMP, "veh"); os.makedirs(os.path.join(vd, "fused"), exist_ok=True); os.makedirs(os.path.join(vd, "data"), exist_ok=True)
# two time steps, front only; pose identity-ish
R_id = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
C_front = [0.0, -1.3, 2.1]   # front cam ~2.1 m ahead, 1.3 m up (y down → negative)
frames = []
for step, tclip, fname in [(0, 1.0, "front_00001.jpg"), (1, 1.17, "front_00002.jpg")]:
    frames.append(dict(name=fname, cam="front", step=step, frame=step, t_clip=tclip, t_ref=tclip, t_grid=tclip,
                       R=R_id, C=C_front, f=900.0, cx=480.0, cy=312.0, w=960, h=624))
json.dump(dict(t0=1.0, t1=1.2, dt=0.17, views={}, cams=["front"], steps=2, frames=frames),
          open(os.path.join(vd, "data", "frames.json"), "w"))
# car at world (0, 0, 10): bottom centre projects to u=480, v = cy + f * (0 - C_y) / (10 - C_z) ...
# ray: C + t * R @ [(u-cx)/f, (v-cy)/f, 1]; for ground y=0 through (0,0,10):
# from C=(0,-1.3,2.1) to (0,0,10): dir ≈ (0, 1.3, 7.9); in view: x=0 → u=cx; y_cv = 1.3/7.9 ≈ 0.165 → v = cy + f*0.165
car_z = 10.0
v_bottom = 312.0 + 900.0 * (0.0 - (-1.3)) / (car_z - 2.1)
# box ~1.85 m wide, 1.55 m tall at 8 m from cam (dist ≈ 8): w_px = 1.85/8*900, h_px = 1.55/8*900
dist = car_z - 2.1; w_px = 1.85 / dist * 900; h_px = 1.55 / dist * 900
u0, u1 = 480 - w_px / 2, 480 + w_px / 2
v0, v1 = v_bottom - h_px, v_bottom
# write depth grids (Z = view-forward metres) and textures
for fr in frames:
    Z = np.zeros((62, 96), np.float32)
    # fill a blob at the car with depth ≈ dist
    for j in range(62):
        for i in range(96):
            u = (i + 0.5) * 960 / 96; v = (j + 0.5) * 624 / 62
            if u0 - 5 <= u <= u1 + 5 and v0 - 5 <= v <= v1 + 5:
                Z[j, i] = dist
            elif v > 400:  # road band
                # ground depth along ray
                dy = (v - 312) / 900;  # y_cv
                # C_y + t*dy = 0 → t = 1.3/dy when dy>0
                if dy > 0.02:
                    Z[j, i] = 1.3 / dy
    cv2.imwrite(os.path.join(vd, "fused", fr["name"][:-4] + ".png"), (Z * 100).astype(np.uint16))
    json.dump([float((j + 0.5) * 624 / 62) for j in range(62)], open(os.path.join(vd, "fused", fr["name"][:-4] + "_rows.json"), "w"))
    # grey car, darker road
    im = np.full((624, 960, 3), 40, np.uint8)
    im[int(v0):int(v1), int(u0):int(u1)] = (40, 40, 200)  # reddish BGR paint
    cv2.imwrite(os.path.join(vd, "fused", fr["name"]), im)
# dets: raw box that maps near our view box — use a generous raw box at centre of front fisheye
# easier path: monkey-patch _view_box to return our known view rectangle
real_vb = VH._view_box
VH._view_box = lambda rig, fr, raw: [u0, v0, u1, v1]
# minimal telemetry so Rig loads — reuse the test rig from earlier via a tiny tel dump
tel = dict(rig={c: rig.cams[c] for c in RG.CAMS}, body=rig.body, aspect=rig.aspect,
           cams={c: dict(frames=[0.0, 1.0], rows=[]) for c in RG.CAMS}, clocks={}, rigSource="test")
json.dump(tel, open(os.path.join(vd, "telemetry.json"), "w"))
# one track, two keys
dets = dict(front=[dict(cls="car", keys=[[1.0, dict(x=0.4, y=0.4, w=0.1, h=0.15, conf=0.9, cls="car")],
                                         [1.17, dict(x=0.4, y=0.4, w=0.1, h=0.15, conf=0.9, cls="car")]])])
json.dump(dets, open(os.path.join(vd, "dets.json"), "w"))
page = os.path.join(vd, "page"); os.makedirs(page, exist_ok=True)
rep = VH.run(vd, page, log=lambda *a: None, rig=rig)
VH._view_box = real_vb
doc = json.load(open(os.path.join(page, "vehicles.json")))
# expect one stable track near (0, 10)
xs = [v["x"] for s in doc["steps"] for v in s]
zs = [v["z"] for s in doc["steps"] for v in s]
ids = {v["id"] for s in doc["steps"] for v in s}
ok(rep["n"] >= 1 and len(ids) >= 1 and any(abs(z - 10) < 1.5 for z in zs) and any(abs(x) < 1.5 for x in xs),
   f"vehicles.py: synthetic car at (0,10) lifts to x≈{xs[:3]} z≈{zs[:3]} (n={rep['n']}, ids={ids})")
ok(os.path.exists(os.path.join(page, "index.html")), "vehicles.py --export refreshes index.html")
# paint roughly red (we wrote BGR 40,40,200)
rgbs = [v["rgb"] for s in doc["steps"] for v in s]
ok(any(r[0] > r[2] for r in rgbs), f"vehicles.py: paint sampled reddish {rgbs[:2]}")

shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{'ALL OK' if not fails else str(len(fails)) + ' FAILED'}")
sys.exit(1 if fails else 0)
