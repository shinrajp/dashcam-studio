"""depth.py — AI depth on the level camera views, put into metres with the road the rig knows (prototype's depth.py).

Depth Anything V2 Small gives relative inverse depth (disparity up to an unknown scale and shift). Every pixel whose ray meets
the road (world y = 0, y down) within 3–35 m has a known true depth from the rig and the car's pose; a robust fit
disp = a / Z + b over those pixels (most are road; cars and kerbs are outliers) turns the whole picture into metres. Frames
whose fit is poor (> 8 % median error) borrow the camera's median scale; far (or beyond the fit) = a 70 m backdrop; sky dropped.

Out (per frame): <name>.npy (float32 depth along the optical axis, m, 0 = none), <name>.png (uint16 cm on a gw-wide grid),
<name>.jpg (640 px texture), and frames.json { frames, steps, cams } with the pose, intrinsics and fit of each.
"""
import json, os, time
import numpy as np, cv2

IW, IH = 518, 336
MEAN, STD = np.array([0.485, 0.456, 0.406], np.float32), np.array([0.229, 0.224, 0.225], np.float32)


class OnnxDepth:
    """Depth Anything V2 Small ONNX (fp16 export; input `pixel_values` 1×3×336×518) → disparity at the model's size."""
    name = "Depth Anything V2 Small (ONNX)"

    def __init__(self, path):
        import onnxruntime as ort
        av = ort.get_available_providers()
        prov = ["CoreMLExecutionProvider", "CPUExecutionProvider"] if "CoreMLExecutionProvider" in av else ["CPUExecutionProvider"]
        self.sess = ort.InferenceSession(path, providers=prov)
        inp = self.sess.get_inputs()[0]
        self.input = inp.name; self.half = "float16" in inp.type

    def __call__(self, img, fr=None):
        x = cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), (IW, IH), interpolation=cv2.INTER_AREA).astype(np.float32) / 255
        x = ((x - MEAN) / STD).transpose(2, 0, 1)[None]
        if self.half: x = x.astype(np.float16)
        return np.asarray(self.sess.run(None, {self.input: x})[0][0], np.float32)


def road_depth(fr):
    """true depth of every pixel's ray meeting the road plane (world y = 0), inf where it doesn't, and the rays' world y."""
    W, H = fr["w"], fr["h"]; R, C = np.array(fr["R"]), np.array(fr["C"])
    uu, vv = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    v3 = np.stack([(uu - fr["cx"]) / fr["f"], (vv - fr["cy"]) / fr["f"], np.ones_like(uu)], -1)
    wy = v3 @ R[1]
    with np.errstate(divide="ignore", invalid="ignore"): Zr = np.where(wy > 1e-4, -C[1] / wy, np.inf)
    return Zr, vv


def squash(Z):
    """how the AI depth squashes far road (prototype, 10-19: 30–60 m reads 10–20 m): true up to 12 m, then 0.15 m per metre."""
    return np.where(Z > 12, 12 + (Z - 12) * 0.15, Z)


class PlaneStub:
    """Stand-in for the AI model when it isn't at hand (tests): the disparity of a flat road world seen from the frame's own
    pose, with an unknown scale and shift per frame, far road squashed the way the real model squashes it (squash()), sky near
    0 and a little noise. It knows nothing of posts or cars."""
    name = "plane stub (no AI model: flat-road disparity with unknown scale/shift)"

    def __init__(self, seed=0, noise=0.01):
        self.rng = np.random.default_rng(seed); self.noise = noise

    def __call__(self, img, fr):
        Zr, _ = road_depth(fr)
        Z = np.where(np.isfinite(Zr) & (Zr < 400), Zr, np.inf)
        Z = squash(Z)
        a, b = self.rng.uniform(2, 8), self.rng.uniform(0.0, 0.05)
        disp = np.where(np.isfinite(Z), a / Z, 0.0) + b * (np.isfinite(Z))
        disp = disp * (1 + self.noise * self.rng.standard_normal(disp.shape))
        return cv2.resize(disp.astype(np.float32), (IW, IH), interpolation=cv2.INTER_AREA)


def fit_scale(disp, Zr, mask, vv, H):
    """robust line disp = a·(1/Z) + b over road candidates (iteratively keeping the 60 % closest) → (a, b, x, y, rel error)."""
    cand = (Zr > 3) & (Zr < 35) & (mask > 127) & (vv > H * 0.45)
    idx = np.flatnonzero(cand.ravel())[::7]
    if len(idx) < 50: return None
    x, y = 1 / Zr.ravel()[idx], disp.ravel()[idx]
    A = np.stack([x, np.ones_like(x)], 1); keep = np.ones(len(x), bool)
    for _ in range(6):
        p, *_ = np.linalg.lstsq(A[keep], y[keep], rcond=None); r = np.abs(A @ p - y)
        keep = r <= np.quantile(r, 0.6)
    sa, sb = p
    rel = float(np.median(np.abs(sa / (y[keep] - sb) - 1 / x[keep]) * x[keep]))
    return sa, sb, x, y, rel


def run(data, out, depth_fn, gw=160, log=print):
    os.makedirs(out, exist_ok=True)
    F = json.load(open(os.path.join(data, "frames.json")))
    cams, steps = F["cams"], F["steps"]
    GOOD, PEND, t_run = {}, [], 0.0
    for fr in F["frames"]:
        cam, name, W, H = fr["cam"], fr["name"], fr["w"], fr["h"]
        img = cv2.imread(os.path.join(data, "images", name))
        mpath = os.path.join(data, "masks", name.replace(".jpg", ".png"))
        mask = cv2.imread(mpath, cv2.IMREAD_GRAYSCALE) if os.path.exists(mpath) else np.full((H, W), 255, np.uint8)
        t = time.time(); disp = depth_fn(img, fr); t_run += time.time() - t
        disp = cv2.resize(disp, (W, H), interpolation=cv2.INTER_LINEAR)
        Zr, vv = road_depth(fr)
        res = fit_scale(disp, Zr, mask, vv, H)
        if res is None: sa, sb, x, y, rel = 0.0, 0.0, np.ones(1), np.ones(1), np.inf
        else: sa, sb, x, y, rel = res
        GOOD.setdefault(cam, [])
        if rel <= 0.08 and sa > 0: GOOD[cam].append((sa, sb))
        PEND.append((fr, img, mask, disp, x, y, sa, sb, rel))
    out_frames, fits = [], []
    for fr, img, mask, disp, x, y, sa, sb, rel in PEND:
        cam, name, W, H = fr["cam"], fr["name"], fr["w"], fr["h"]
        borrowed = False
        if (rel > 0.08 or sa <= 0) and GOOD.get(cam):
            sa, sb = np.median(np.array(GOOD[cam]), 0); borrowed = True
            rel = float(np.median(np.abs(sa / (y - sb) - 1 / x) * x))
        sky = disp < 0.03 * np.quantile(disp, 0.99)
        with np.errstate(divide="ignore", invalid="ignore"): Z = sa / (disp - sb)
        Z[~np.isfinite(Z) | (Z > 70) | (Z < 0)] = 70   # far: a backdrop at 70 m, not dropped
        Z[sky | (Z < 0.5) | (mask <= 127)] = 0
        if sa <= 0: Z[:] = 0                           # no usable scale for this camera at all
        fits.append(rel)
        gh = round(gw * H / W)
        Zg = cv2.resize(np.where(Z > 0, Z, np.nan).astype(np.float32), (gw, gh), interpolation=cv2.INTER_NEAREST)
        cv2.imwrite(os.path.join(out, name.replace(".jpg", ".png")), np.nan_to_num(np.clip(Zg * 100, 0, 65535)).astype(np.uint16))
        cv2.imwrite(os.path.join(out, name), cv2.resize(img, (640, round(640 * H / W)), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 80])
        np.save(os.path.join(out, name.replace(".jpg", ".npy")), Z.astype(np.float32))
        out_frames.append(dict(name=name, cam=cam, step=fr["step"], t=round(fr["t_grid"], 4), t_clip=fr["t_clip"], R=fr["R"], C=fr["C"],
                               f=fr["f"], cx=fr["cx"], cy=fr["cy"], w=W, h=H, fit=round(float(rel), 4) if np.isfinite(rel) else None, borrowed=borrowed))
    fin = [f for f in fits if np.isfinite(f)]
    log(f"  {len(out_frames)} frames, {t_run / max(1, len(out_frames)):.2f} s per frame; borrowed scale: {sum(f['borrowed'] for f in out_frames)} frames; "
        f"road fit error median {np.median(fin) * 100:.1f} % (max {np.max(fin) * 100:.1f} %)" if fin else "  no road fit at all")
    no_scale = [c for c in cams if not GOOD.get(c)]
    if no_scale: log(f"  WARNING: no frame of {', '.join(no_scale)} had a good road fit; its frames use their own (poor) fit")
    d = dict(frames=out_frames, steps=steps, cams=cams)
    json.dump(d, open(os.path.join(out, "frames.json"), "w"))
    return d
