"""AI depth on the six undistorted camera views, put into metres with the road the rig knows.

Depth Anything V2 Small gives relative inverse depth (disparity up to an unknown scale and shift). Every pixel whose ray meets
the road (world y = 0, y down) within 3-35 m has a known true depth from the rig and the car's pose; a robust fit
disp = a / Z + b over those pixels (most are road; cars and kerbs are outliers) turns the whole picture into metres.

usage: python -I depth.py <splat data dir> <model.onnx> <out dir> --t0 8.5 --t1 12.5 --step 2 [--rows depth_rows.json]
out: <out>/<name>.png (uint16 depth along the optical axis in cm, 0 = none), <out>/<name>.jpg (640 px texture),
     <out>/frames.json (pose, intrinsics, fit), and a validation printout against multi-view distances.
"""
import argparse, json, os, sys, time
import numpy as np, cv2, onnxruntime as ort

ap = argparse.ArgumentParser()
ap.add_argument("data"); ap.add_argument("model"); ap.add_argument("out")
ap.add_argument("--t0", type=float, default=8.5); ap.add_argument("--t1", type=float, default=12.5); ap.add_argument("--step", type=int, default=2)
ap.add_argument("--rows"); ap.add_argument("--gw", type=int, default=160)
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
F = json.load(open(os.path.join(a.data, "frames.json")))
cams = {}
for l in open(os.path.join(a.data, "sparse/0/cameras.txt")):
    s = l.split()
    if len(s) == 8: cams[int(s[0])] = dict(w=int(s[2]), h=int(s[3]), f=float(s[4]), cx=float(s[6]), cy=float(s[7]))
camid = {}
for l in open(os.path.join(a.data, "sparse/0/images.txt")):
    s = l.split()
    if len(s) == 10: camid[s[9]] = int(s[8])

sess = ort.InferenceSession(a.model, providers=["CoreMLExecutionProvider", "CPUExecutionProvider"] if "CoreMLExecutionProvider" in ort.get_available_providers() else ["CPUExecutionProvider"])
IW, IH = 518, 336
MEAN, STD = np.array([0.485, 0.456, 0.406], np.float32), np.array([0.229, 0.224, 0.225], np.float32)

def infer(img):
    x = cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), (IW, IH), interpolation=cv2.INTER_AREA).astype(np.float32) / 255
    x = ((x - MEAN) / STD).transpose(2, 0, 1)[None]
    return sess.run(None, {"pixel_values": x})[0][0]

# pick frames: per camera, the frames in [t0, t1], every `step`-th; group by time step across cameras
sel = [fr for fr in F["frames"] if a.t0 <= fr["t_ref"] <= a.t1]
bycam = {}
for fr in sorted(sel, key=lambda f: f["t_ref"]): bycam.setdefault(fr["cam"], []).append(fr)
for c in bycam: bycam[c] = bycam[c][::a.step]
nsteps = min(len(v) for v in bycam.values())
print("cameras", {c: len(v) for c, v in bycam.items()}, "steps", nsteps)

out_frames, fits, t_run = [], [], 0
GOOD, PEND = {}, []
for cam, frs in bycam.items():
    for fr in frs[:nsteps]:
        name = fr["name"]; K = cams[camid[name]]; W, H = K["w"], K["h"]
        img = cv2.imread(os.path.join(a.data, "images", name))
        mpath = os.path.join(a.data, "masks", name.replace(".jpg", ".png"))
        mask = cv2.imread(mpath, cv2.IMREAD_GRAYSCALE) if os.path.exists(mpath) else np.full((H, W), 255, np.uint8)
        t = time.time(); disp = infer(img); t_run += time.time() - t
        disp = cv2.resize(disp, (W, H), interpolation=cv2.INTER_LINEAR)
        R, C = np.array(fr["R"]), np.array(fr["C"])
        # true depth of road pixels: C_y + Z (R v)_y = 0 with v = ((u-cx)/f, (v-cy)/f, 1)
        uu, vv = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
        v3 = np.stack([(uu - K["cx"]) / K["f"], (vv - K["cy"]) / K["f"], np.ones_like(uu)], -1)
        wy = v3 @ R[1]
        with np.errstate(divide="ignore", invalid="ignore"): Zr = np.where(wy > 1e-4, -C[1] / wy, np.inf)
        cand = (Zr > 3) & (Zr < 35) & (mask > 127) & (vv > H * 0.45)
        idx = np.flatnonzero(cand.ravel())[::7]
        x, y = 1 / Zr.ravel()[idx], disp.ravel()[idx]
        # robust line y = a x + b: iteratively reweighted, keeping the 60 % closest (road; cars stick out)
        A = np.stack([x, np.ones_like(x)], 1); keep = np.ones(len(x), bool)
        for _ in range(6):
            p, *_ = np.linalg.lstsq(A[keep], y[keep], rcond=None); r = np.abs(A @ p - y)
            keep = r <= np.quantile(r, 0.6)
        sa, sb = p
        rel0 = np.median(np.abs(sa / (y[keep] - sb) - 1 / x[keep]) * x[keep])
        GOOD.setdefault(cam, [])
        if rel0 <= 0.08: GOOD[cam].append((sa, sb))
        PEND.append((cam, fr, name, K, W, H, img, mask, disp, x, y, sa, sb, rel0))
        continue
        with np.errstate(divide="ignore", invalid="ignore"): Z = sa / (disp - sb)
        Z[(disp - sb) <= sa / 200] = 0   # farther than 200 m (sky): none
        Z[(Z < 0.5) | (mask <= 127)] = 0
        rel = np.median(np.abs(sa / (y[keep] - sb) - 1 / x[keep]) * x[keep])   # road fit error, fraction of depth
        fits.append(rel)
        gw = a.gw; gh = round(gw * H / W)
        Zg = cv2.resize(np.where(Z > 0, Z, np.nan).astype(np.float32), (gw, gh), interpolation=cv2.INTER_NEAREST)   # nearest: keep edges sharp
        cv2.imwrite(os.path.join(a.out, name.replace(".jpg", ".png")), np.nan_to_num(np.clip(Zg * 100, 0, 65535)).astype(np.uint16))
        cv2.imwrite(os.path.join(a.out, name), cv2.resize(img, (640, round(640 * H / W)), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 80])
        np.save(os.path.join(a.out, name.replace(".jpg", ".npy")), Z.astype(np.float32))
        out_frames.append(dict(name=name, cam=cam, t=round(fr["t_ref"], 4), R=fr["R"], C=fr["C"], f=K["f"], cx=K["cx"], cy=K["cy"], w=W, h=H, fit=round(float(rel), 4)))
for cam, fr, name, K, W, H, img, mask, disp, x, y, sa, sb, rel in PEND:
        borrowed = False
        if rel > 0.08 and GOOD.get(cam):
            sa, sb = np.median(np.array(GOOD[cam]), 0); borrowed = True
            rel = np.median(np.abs(sa / (y - sb) - 1 / x) * x)
        sky = disp < 0.03 * np.quantile(disp, 0.99)
        with np.errstate(divide="ignore", invalid="ignore"): Z = sa / (disp - sb)
        Z[~np.isfinite(Z) | (Z > 70) | (Z < 0)] = 70   # far: a backdrop at 70 m, not dropped
        Z[sky | (Z < 0.5) | (mask <= 127)] = 0
        fits.append(rel)
        gw = a.gw; gh = round(gw * H / W)
        Zg = cv2.resize(np.where(Z > 0, Z, np.nan).astype(np.float32), (gw, gh), interpolation=cv2.INTER_NEAREST)
        cv2.imwrite(os.path.join(a.out, name.replace(".jpg", ".png")), np.nan_to_num(np.clip(Zg * 100, 0, 65535)).astype(np.uint16))
        cv2.imwrite(os.path.join(a.out, name), cv2.resize(img, (640, round(640 * H / W)), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 80])
        np.save(os.path.join(a.out, name.replace(".jpg", ".npy")), Z.astype(np.float32))
        out_frames.append(dict(name=name, cam=cam, t=round(fr["t_ref"], 4), R=fr["R"], C=fr["C"], f=K["f"], cx=K["cx"], cy=K["cy"], w=W, h=H, fit=round(float(rel), 4), borrowed=borrowed))
print("borrowed scale:", sum(f["borrowed"] for f in out_frames), "frames")
print(f"{len(out_frames)} frames, {t_run / max(1, len(out_frames)):.2f} s per frame; road fit error median {np.median(fits) * 100:.1f} % (max {np.max(fits) * 100:.1f} %)")
json.dump(dict(frames=out_frames, steps=nsteps, cams=list(bycam)), open(os.path.join(a.out, "frames.json"), "w"))

# validation: our depth at boxes whose distance multi-view geometry knows (KLT points; splat for the rest)
if a.rows:
    rows = json.load(open(a.rows)); names = {f["name"]: f for f in out_frames}; err = {"klt": [], "foot": []}
    for r in rows:
        f = names.get(r["name"]); ref = r.get("klt")
        if not f or not ref or not r.get("splat_w"): continue
        Z = np.load(os.path.join(a.out, f["name"].replace(".jpg", ".npy")))
        R, C = np.array(f["R"]), np.array(f["C"])
        P = np.array([r["splat_w"][0], -0.6, r["splat_w"][1]]); q = R.T @ (P - C)
        if q[2] < 1: continue
        u, v = f["cx"] + f["f"] * q[0] / q[2], f["cy"] + f["f"] * q[1] / q[2]
        if not (5 <= u < f["w"] - 5 and 5 <= v < f["h"] - 5): continue
        win = Z[int(v) - 4:int(v) + 5, int(u) - 4:int(u) + 5]; win = win[win > 0]
        if not len(win): continue
        z = np.median(win); pt = C + R @ (np.array([(u - f["cx"]) / f["f"], (v - f["cy"]) / f["f"], 1]) * z)
        cc = C  # horizontal distance from the camera, as the rows measure it
        d = np.hypot(pt[0] - cc[0], pt[2] - cc[2])
        err["klt"].append((ref, abs(d - ref))); err["foot"].append((ref, abs(r["foot"] - ref)))
    for lo, hi in [(3, 10), (10, 20), (20, 40)]:
        e = [x for r_, x in err["klt"] if lo <= r_ < hi]; g = [x for r_, x in err["foot"] if lo <= r_ < hi]
        if e: print(f"{lo}-{hi} m: n={len(e)}  AI depth median |err| {np.median(e):.2f} m   footprint {np.median(g):.2f} m   (vs multi-view KLT)")
