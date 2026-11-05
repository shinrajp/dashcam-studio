"""scenewb.py — the viewer's white balance, applied to the 3D scene's FINAL colours only (--scene-wb viewer).

Depth, kerbs, local scale and fuse run on the original frames; this rewrites the fused textures afterwards, so the
geometry is byte-identical to a run without it. It is a port of the app's own code, with the same constants and maths:
  js/wb.js                the white point from the white car body seen at the outer edge of the mirror cameras (strip,
                          body mask from temporal statistics, analyse, log-chroma EMA with jump / red-lamp rejection),
                          the viewer look (WB.viewGains: STRENGTH, temperature / tint limits for day / night, BLUE_MAX)
                          and camera matching (WB.neutralOf / WB.matchCams, ±MATCH_MAX toward the mirror cameras' mean);
  js/colour-constancy.js  the prototype: CAT16 / Bradford adaptation (CC.viewerMatrix, linear sRGB), and the multi-source
                          estimate (paint, lane markings, grey world, FC4) fused in log-chroma (CC.fuse).
What the viewer does with the White balance button ON: gains (WB.viewGains × the camera's match offset) in gamma sRGB
(an SVG feColorMatrix, color-interpolation-filters sRGB). With the colour-constancy prototype on (off by default) and an
SVG browser: one 3×3 matrix, CC.viewerMatrix(paint white, cat16 | bradford, strength) in LINEAR sRGB, no match offsets.
Note: in the viewer the matrix uses the car-paint white only; the fused estimate (CC.fixFor) is used for vehicle colour.
`source="fusion"` is offered here as an option on top. The viewer's estimate is smoothed in time (EMA); the scene uses one
white point per drive (the median of the smoothed estimate over the scene's time span), so there is no flicker.
Constants are copied verbatim, with the JS file and line; test/depth3d.test.py checks them against the JS source."""
import json, os
import numpy as np, cv2

# ── js/wb.js:23-77 (WB.C) ──
C = dict(STRENGTH=0.7, HZ=4.5, ZONE_W=0.14, ZONE_Y0=0.12, GW=32, GH=64, WEDGE=dict(y0=0.18, w0=0.012, w1=0.07), PCT=(0.60, 0.95),
         MIN_CELLS=12, CLIP=250, DARK_ABS=6, DARK_REL=0.2, PAINT_ABS=10, PAINT_REL=0.3, BLACK=3, OUTLIER=0.18, MAX_SPREAD=0.16,
         MAX_CHROMA=1.0, RED_RG=2.1, GREEN_RG=0.8, GREEN_BG=1.0, JUMP=0.22, JUMP_ACCEPT=14, LAMP_DR=0.15, LAMP_DB=-0.5,
         LAMP_ACCEPT=54, EMA=0.25, GAIN_MIN=0.65, GAIN_MAX=1.7, MATCH_EVERY=4, MATCH_S=0.3, MATCH_MAX=0.07, MATCH_EMA=0.25,
         MATCH_MIN=60, MATCH_W=48, MATCH_H=30, TINT_K=0.5, NIGHT_K=0.85, NIGHT_TEMP=0.26, BLUE_MAX=1.45, DAY_Y=(55, 95),
         DAY_K=0.25, DAY_TEMP=0.04, DAY_TINT=0.02, MASK_ALPHA=0.12, MASK_MIN_FRAMES=8, MOVE_STD=2.5, EDGE_STATIC=0.6,
         EDGE_MIN=10, VALLEY=0.75, ROWS_MIN=0.3, ROW_JUMP=4)
SIDE = {"left_repeater": "left", "right_repeater": "right"}      # js/wb.js:26
REP = ["left_repeater", "right_repeater"]                         # js/wb.js:79
# ── js/colour-constancy.js:17-23, 40-46, 66 (CC.C, matrices) ──
PRIOR = dict(paint=1.0, plate=0.8, lane=0.7, learned=0.5, greyworld=0.15)
ROBUST_DEG = 3
FC4_SIDE = 384
FC4_CAL = np.array([[0.8734, 0.4027, -0.2711], [-0.004, 0.7043, 0.3099], [0.041, -0.1881, 1.167]])
RGB2XYZ = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.072175], [0.0193339, 0.119192, 0.9503041]])
CATS = dict(bradford=np.array([[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]]),
            cat16=np.array([[0.401288, 0.650173, -0.051461], [-0.250268, 1.204414, 0.045854], [-0.002079, 0.048952, 0.953127]]))
BRIGHT_TARGET, BRIGHT_MAX = 0.75, 4
ADAPTS = ["gains", "cat16", "bradford"]


def luma(r, g, b): return 0.2126 * r + 0.7152 * g + 0.0722 * b                       # js/wb.js:108
def srgb_to_lin(v):                                                                     # js/colour-constancy.js:88
    c = np.asarray(v, float) / 255; return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
def lin_to_srgb(l):                                                                     # js/colour-constancy.js:89
    c = np.maximum(0, np.asarray(l, float)); return 255 * np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)
def _med(a):                                                                            # js/wb.js:133 (upper median)
    a = np.sort(np.asarray(a, float)); return float(a[len(a) >> 1]) if len(a) else 0.0


# ── viewer gains: js/wb.js:110-131 ──
def gains(w, strength=C["STRENGTH"]):
    ref = luma(*w); g = np.array([1 + (ref / max(c, 1) - 1) * strength for c in w])
    norm = ref / luma(*(np.array(w) * g)); return np.clip(g * norm, C["GAIN_MIN"], C["GAIN_MAX"])
def dayness(y):
    a, b = C["DAY_Y"]; return 0.0 if y is None or not (y >= 0) else max(0.0, min(1.0, (y - a) / (b - a)))
def view_gains(w, day, strength=C["STRENGTH"]):
    l = np.log(gains(w, strength)); temp = (l[2] - l[0]) / 2; tint = l[1] - (l[0] + l[2]) / 2
    d = max(0.0, min(1.0, day or 0)); lim = lambda x, m: max(-m, min(m, x)); mix = lambda a, b: a + (b - a) * d
    ks = max(1, strength / C["STRENGTH"])
    temp = lim(temp * mix(C["NIGHT_K"], C["DAY_K"]), mix(C["NIGHT_TEMP"], C["DAY_TEMP"]) * ks); tint = lim(tint * C["TINT_K"], mix(1, C["DAY_TINT"]))
    g = np.array([np.exp(-temp - tint / 3), np.exp(2 * tint / 3), np.exp(temp - tint / 3)])
    g = g * (luma(*w) / luma(*(np.array(w) * g)))
    if g[2] > C["BLUE_MAX"]: g = g * (C["BLUE_MAX"] / g[2])
    return np.clip(g, C["GAIN_MIN"], C["GAIN_MAX"])
def gains_for(g, m):                                                                    # js/wb.js:296-302
    if m is None: return np.array(g, float)
    out = np.array([g[0] * np.exp(m[0]), g[1], g[2] * np.exp(m[1])]); return out * (luma(*g) / max(1e-6, luma(*out)))


# ── CAT16 / Bradford: js/colour-constancy.js:52-79 ──
def adapt_matrix(white, method, D=1.0):
    D = max(0.0, min(1.0, D)); w = np.maximum(1e-6, np.asarray(white, float)); m = w.max()
    if method == "gains-linear": return np.diag(1 + (m / w - 1) * D)
    M = CATS.get(method, CATS["cat16"]); Xw = RGB2XYZ @ w; Lw = M @ (Xw / Xw[1]); Ld = M @ (RGB2XYZ @ np.ones(3))
    g = D * (Ld / Lw) + (1 - D); A = np.linalg.inv(RGB2XYZ) @ np.linalg.inv(M) @ np.diag(g) @ M @ RGB2XYZ
    o = A @ w; k = (D * m + (1 - D) * o.max()) / max(1e-6, o.max()); return A * k
def lum(w): return 0.2126 * w[0] + 0.7152 * w[1] + 0.0722 * w[2]                      # js/colour-constancy.js:65
def viewer_matrix(white255, method, D):
    w = srgb_to_lin(white255); A = adapt_matrix(w, method, D); return A * (lum(w) / max(1e-6, lum(A @ w)))
def cct_lin(w):                                                                         # js/colour-constancy.js:81
    X = RGB2XYZ @ np.asarray(w, float); s = X.sum(); x, y = X[0] / s, X[1] / s; n = (x - 0.332) / (0.1858 - y)
    return round(449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33)


# ── car body in the mirror cameras: js/wb.js:137-230 (images are RGB uint8 H×W×3 here, as the canvas' RGBA) ──
def analyse(img, runs, sceneY=None):
    H, W = img.shape[:2]; f = img.astype(float); L = luma(f[..., 0], f[..., 1], f[..., 2])
    if L.max() < C["BLACK"]: return dict(blank=True)
    sY = sceneY if sceneY is not None else _med(L.ravel()); dark = max(C["DARK_ABS"], C["DARK_REL"] * sY)
    px = []; rej = clipped = 0
    for y in range(H):
        n = W if runs is None else int(runs[y])
        for x in range(min(n, W)):
            r, g, b = (int(v) for v in img[y, x])
            if r >= C["CLIP"] or g >= C["CLIP"] or b >= C["CLIP"]: clipped += 1; continue
            l = luma(r, g, b)
            if l < dark: continue
            rg, bg = r / max(g, 1), b / max(g, 1)
            if rg > C["RED_RG"] or (rg < C["GREEN_RG"] and bg < C["GREEN_BG"]): rej += 1; continue
            px.append((l, r, g, b))
    if len(px) < C["MIN_CELLS"]: return dict(found=False, why="few")
    px.sort(key=lambda p: p[0]); a = int(np.floor(len(px) * C["PCT"][0])); cand = px[a:max(a + 1, int(np.ceil(len(px) * C["PCT"][1])))]
    yP = sum(p[0] for p in cand) / len(cand)
    if yP < max(C["PAINT_ABS"], C["PAINT_REL"] * sY): return dict(found=False, why="dark")
    lc = [(np.log(max(r, 1) / max(g, 1)), np.log(max(b, 1) / max(g, 1))) for _, r, g, b in cand]
    m = (_med([v[0] for v in lc]), _med([v[1] for v in lc])); dist = [np.hypot(v[0] - m[0], v[1] - m[1]) for v in lc]
    if _med(dist) > C["MAX_SPREAD"]: return dict(found=False, why="scattered")
    sel = [p for p, dd in zip(cand, dist) if dd <= C["OUTLIER"]]
    if len(sel) < max(4, len(cand) / 3): return dict(found=False, why="scattered")
    rgb = [sum(p[k] for p in sel) / len(sel) for k in (1, 2, 3)]
    if np.hypot(np.log(rgb[0] / rgb[1]), np.log(rgb[2] / rgb[1])) > C["MAX_CHROMA"]: return dict(found=False, why="too coloured", rgb=rgb)
    return dict(found=True, rgb=rgb, n=len(sel), y=yP)


def wedge(zw):                                                                          # js/wb.js:175-179
    out = np.zeros(C["GH"], int); Wd = C["WEDGE"]
    for y in range(C["GH"]):
        iy = C["ZONE_Y0"] + (1 - C["ZONE_Y0"]) * (y + 0.5) / C["GH"]
        if iy < Wd["y0"]: continue
        f = Wd["w0"] + (Wd["w1"] - Wd["w0"]) * (iy - Wd["y0"]) / (1 - Wd["y0"]); out[y] = max(1, min(C["GW"], int(np.floor((f / zw) * C["GW"] + 0.5))))
    return out


class Zone:                                                                             # js/wb.js:180-230
    def __init__(s): n = C["GW"] * C["GH"]; s.n = 0; s.mean = np.zeros(n); s.vr = np.zeros(n); s.runs = None; s.conf = False; s.sceneY = 0; s.noBody = False
    def feed(s, img):
        f = img.reshape(-1, 3).astype(float); l = luma(f[:, 0], f[:, 1], f[:, 2]); a = max(C["MASK_ALPHA"], 1 / (s.n + 1))
        if not s.n: s.mean[:] = l; s.vr[:] = 0
        else: dl = l - s.mean; s.mean += a * dl; s.vr = (1 - a) * (s.vr + a * dl * dl)
        s.n += 1
    def mask(s):
        GW, GH, M = C["GW"], C["GH"], s.mean; sd = np.sqrt(s.vr)
        sceneStd = _med([sd[y * GW + x] for y in range(GH) for x in range(GW >> 1, GW)]); s.sceneY = _med(M)
        if s.n < C["MASK_MIN_FRAMES"] or not sceneStd > C["MOVE_STD"]: s.conf = False; return
        raw = -np.ones(GH, int); thr = max(1.0, C["EDGE_STATIC"] * sceneStd)
        for y in range(GH):
            r = y * GW
            for x in range(1, GW - 2):
                i = r + x
                if sd[i] > thr: continue
                Lm = max(M[i - 1], M[i - 2] if x > 1 else M[i - 1]); Rm = max(M[i + 1], M[i + 2])
                valley = M[i] < C["VALLEY"] * min(Lm, Rm) and min(Lm, Rm) - M[i] >= C["EDGE_MIN"]
                step = abs(M[i + 1] - M[i - 1]) >= 2 * C["EDGE_MIN"] and sd[i - 1] <= thr
                if valley or step: raw[y] = x; break
        found = [y for y in range(GH) if raw[y] > 0]; s.rowsFound = len(found) / GH; runs = np.zeros(GH, int)
        if found:
            def sm(y):
                v = [raw[y + k] for k in range(-2, 3) if 0 <= y + k < GH and raw[y + k] > 0]; return _med(v) if v else -1
            good = [(y, sm(y)) for y in found if abs(raw[y] - sm(y)) <= C["ROW_JUMP"]]
            for y in range(GH):
                a = b = None
                for p in good:
                    if p[0] <= y: a = p
                    if p[0] >= y and b is None: b = p
                if a and b: runs[y] = int(np.floor((a[1] if a[0] == b[0] else a[1] + (b[1] - a[1]) * (y - a[0]) / (b[0] - a[0])) + 0.5))
                elif b and not a: runs[y] = 0
                elif a and not b: runs[y] = int(a[1])
            rowsGood = len(good) / GH
        else: rowsGood = 0
        jumps = sum(abs(runs[y] - runs[y - 1]) > C["ROW_JUMP"] for y in range(1, GH))
        s.conf = rowsGood >= C["ROWS_MIN"] and jumps <= 2 and (runs > 0).any()
        s.noBody = s.n >= 2 * C["MASK_MIN_FRAMES"] and s.rowsFound < 0.08
        if s.conf: s.runs = runs


def strip_of(frame_rgb, side, zw=C["ZONE_W"]):                                          # js/wb.js:434-443
    H, W = frame_rgb.shape[:2]; x0 = 0 if side == "left" else int(round((1 - zw) * W)); y0 = int(round(C["ZONE_Y0"] * H))
    s = cv2.resize(frame_rgb[y0:, x0:x0 + int(round(zw * W))], (C["GW"], C["GH"]), interpolation=cv2.INTER_AREA)
    return s[:, ::-1].copy() if side == "right" else s


def neutral_of(frame_rgb):                                                              # js/wb.js:320-332
    d = cv2.resize(frame_rgb, (C["MATCH_W"], C["MATCH_H"]), interpolation=cv2.INTER_AREA).reshape(-1, 3).astype(float)
    r, g, b = d[:, 0], d[:, 1], d[:, 2]; mx, mn, l = d.max(1), d.min(1), luma(r, g, b)
    ok = ~((l < 35) | (l > 215) | (mx >= 245) | (mn < 4) | ((mx - mn) / np.maximum(mx, 1e-9) >= C["MATCH_S"]))
    return [_med(np.log(r[ok] / g[ok])), _med(np.log(b[ok] / g[ok]))] if ok.sum() >= C["MATCH_MIN"] else None


class Tracker:
    """WB.sampleNow + WB.update (js/wb.js:239-256, 453-505) and WB.matchCams (js/wb.js:334-346), fed one sample at a time."""
    def __init__(s): s.est = None; s.jumps = 0; s.reds = 0; s.camJumps = {}; s.camReds = {}; s.sceneY = None; s.zones = {}; s.match = {}; s.k = 0
    def red_lamp(s, c):
        if s.est is None: return False
        dr, db = c[0] - s.est[0], c[1] - s.est[1]; return dr > C["LAMP_DR"] and db > C["LAMP_DB"] * dr
    def update(s, rgb):
        if rgb is None: return "none"
        c = [np.log(rgb[0] / rgb[1]), np.log(rgb[2] / rgb[1])]
        if s.est is None: s.est = c; s.jumps = 0; return "init"
        if s.red_lamp(c):
            s.reds += 1
            if s.reds < C["LAMP_ACCEPT"]: return "red-lamp"
            s.est = c; s.reds = 0; s.jumps = 0; return "accept-red"
        s.reds = 0; d = np.hypot(c[0] - s.est[0], c[1] - s.est[1])
        if d > C["JUMP"]:
            s.jumps += 1
            if s.jumps < C["JUMP_ACCEPT"]: return "jump"
            s.est = c; s.jumps = 0; return "accept-jump"
        s.jumps = 0; a = C["EMA"]; s.est = [s.est[0] + a * (c[0] - s.est[0]), s.est[1] + a * (c[1] - s.est[1])]; return "ok"
    def sample(s, mirrors):
        """mirrors: cam → raw RGB frame (left/right repeater)."""
        whites, ys = [], []
        for cam, fr in mirrors.items():
            sides = [SIDE[cam], "right" if SIDE[cam] == "left" else "left"]; imgs = {}
            for sd in sides:
                im = strip_of(fr, sd)
                if im.max() < C["BLACK"]: continue
                Z = s.zones.setdefault(cam + ":" + sd, Zone()); Z.feed(im); Z.mask(); imgs[sd] = im
            if not imgs: continue
            side, runs = sides[0], wedge(C["ZONE_W"])
            for sd in sides:
                Z = s.zones.get(cam + ":" + sd)
                if Z and Z.conf and Z.runs is not None: side, runs = sd, Z.runs; break
            Z = s.zones.get(cam + ":" + side)
            if Z is None or side not in imgs: continue
            if Z.runs is None and all(s.zones.get(cam + ":" + sd) and s.zones[cam + ":" + sd].noBody for sd in sides): continue
            im = imgs[side]; f = im.reshape(-1, 3)[::4].astype(float); ys.append(_med(luma(f[:, 0], f[:, 1], f[:, 2])))
            a = analyse(im, runs, Z.sceneY if Z.n >= C["MASK_MIN_FRAMES"] else None)
            if not a.get("found"): continue
            if s.est is not None:
                lc = [np.log(a["rgb"][0] / a["rgb"][1]), np.log(a["rgb"][2] / a["rgb"][1])]
                if s.red_lamp(lc):
                    s.camReds[cam] = s.camReds.get(cam, 0) + 1
                    if s.camReds[cam] < C["LAMP_ACCEPT"]: continue
                else: s.camReds[cam] = 0
                d = np.hypot(lc[0] - s.est[0], lc[1] - s.est[1])
                if d > C["JUMP"] and not s.camReds.get(cam, 0) >= C["LAMP_ACCEPT"]:
                    s.camJumps[cam] = s.camJumps.get(cam, 0) + 1
                    if s.camJumps[cam] < C["JUMP_ACCEPT"]: continue
            s.camJumps[cam] = 0; whites.append(a["rgb"])
        if ys: y = sum(ys) / len(ys); s.sceneY = y if s.sceneY is None else s.sceneY + 0.2 * (y - s.sceneY)
        rgb = None
        if whites:
            l = [(np.log(w[0] / w[1]), np.log(w[2] / w[1])) for w in whites]; rgb = [np.exp(np.mean([v[0] for v in l])), 1, np.exp(np.mean([v[1] for v in l]))]
        return s.update(rgb)
    def match_cams(s, frames):
        n = {c: m for c, f in frames.items() if (m := neutral_of(f)) is not None}; refs = [c for c in REP if c in n]
        if not refs: return
        ref = [sum(n[c][k] for c in refs) / len(refs) for k in (0, 1)]; lim = lambda x: max(-C["MATCH_MAX"], min(C["MATCH_MAX"], x))
        for cam in n:
            tgt = [lim(ref[0] - n[cam][0]), lim(ref[1] - n[cam][1])]; o = s.match.get(cam, [0, 0])
            s.match[cam] = [o[0] + C["MATCH_EMA"] * (tgt[0] - o[0]), o[1] + C["MATCH_EMA"] * (tgt[1] - o[1])]
    def white(s):                                                                       # js/wb.js:258
        if s.est is None: return None
        w = np.array([np.exp(s.est[0]), 1, np.exp(s.est[1])]); return w * (230 / w.max())


# ── colour-constancy sources and fusion: js/colour-constancy.js:93-140, 155-193 ──
LIN = srgb_to_lin(np.arange(256))
def white_percentile(px, lo=0.6, hi=0.95):
    px = px[(px < 251).all(1)] if len(px) else px                                       # r > 250 … skipped
    if len(px) < 12: return None
    L = LIN[px]; ls = luma(L[:, 0], L[:, 1], L[:, 2]); o = np.argsort(ls, kind="stable")
    a = int(np.floor(len(ls) * lo)); z = max(a + 1, int(np.floor(len(ls) * hi))); return dict(white=L[o[a:z]].mean(0), n=z - a, lum=ls[o[int(np.floor(len(ls) * 0.8))]])
def angle(a, b):
    d = float(np.dot(a, b)) / (np.linalg.norm(a) * np.linalg.norm(b)); return float(np.degrees(np.arccos(max(-1, min(1, d)))))
def from_lanes(rgb):
    h, w = rgb.shape[:2]; X0, X1, Y0, Y1 = int(np.floor(0.15 * w)), int(np.ceil(0.85 * w)), int(np.floor(0.62 * h)), int(np.ceil(0.98 * h))
    R = rgb[Y0:Y1, X0:X1].reshape(-1, X1 - X0, 3); L = LIN[R]; l = luma(L[..., 0], L[..., 1], L[..., 2])
    med = np.sort(l, 1)[:, (X1 - X0) >> 1][:, None]; mark = (l > med * 2.2) & (l > 0.004); road = ~mark & (l < med * 1.3) & (l > med * 0.7)
    area = l.size
    if mark.sum() < max(30, area * 0.004) or road.sum() < 100: return None
    r = white_percentile(R[mark], 0.3, 0.95)
    if not r: return None
    asphalt = L[road].mean(0); ang = angle(r["white"], asphalt); agree = max(0, 1 - max(0, ang - 4) / 8)
    return dict(white=r["white"], conf=min(1, mark.sum() / (area * 0.02)) * agree, lum=r["lum"])
def from_greyworld(rgb):
    p = rgb.reshape(-1, 3)[::4]; return dict(white=LIN[p].mean(0), conf=0.5)
_fc4 = None
def from_learned(rgb, model):
    global _fc4
    import onnxruntime as ort
    if _fc4 is None: _fc4 = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
    ih, iw = rgb.shape[:2]; k = min(1, FC4_SIDE / max(iw, ih)); w = max(64, round(iw * k / 16) * 16); h = max(64, round(ih * k / 16) * 16)
    x = LIN[cv2.resize(rgb, (w, h), interpolation=cv2.INTER_AREA)].astype(np.float32); x = (x / max(1e-6, x.max())) ** (1 / 2.2)
    out = _fc4.run(None, {"image": x.transpose(2, 0, 1)[None]}); names = [o.name for o in _fc4.get_outputs()]; o = dict(zip(names, out))
    raw = o["illum"].ravel(); pr = o["patch_rgb"].reshape(3, -1); pc = o["patch_conf"].ravel()
    a = np.array([angle(pr[:, i], raw) if np.linalg.norm(pr[:, i]) > 0 else np.nan for i in range(len(pc))]); ok = np.isfinite(a)
    spread = float((pc[ok] * a[ok]).sum() / pc[ok].sum()) if pc[ok].sum() else 30
    return dict(white=np.maximum(1e-4, FC4_CAL @ raw), conf=max(0.05, min(1, 1 - (spread - 2) / 10)))
def fuse(ests, prior=PRIOR):
    Ls = [(k, e, np.array([np.log(max(1e-6, e["white"][0]) / max(1e-6, e["white"][1])), np.log(max(1e-6, e["white"][2]) / max(1e-6, e["white"][1]))]),
           prior.get(k, 0.3) * e["conf"]) for k, e in ests.items() if e is not None and e["conf"] > 0]
    if not Ls: return None
    P = np.array([x[2] for x in Ls]); w0 = np.array([x[3] for x in Ls]); mu = (w0[:, None] * P).sum(0) / w0.sum()
    sc = ROBUST_DEG * np.pi / 180 * 1.6
    for _ in range(8): ws = w0 / (1 + (np.hypot(*(P - mu).T) / sc) ** 2); mu = (ws[:, None] * P).sum(0) / ws.sum()
    return dict(white=np.array([np.exp(mu[0]), 1, np.exp(mu[1])]), used={x[0]: round(float(ws[i] / x[3]), 3) for i, x in enumerate(Ls)})


# ── applying it (what the viewer's SVG filter does) ──
def apply_gains(rgb, g):
    """feColorMatrix (per-channel) with color-interpolation-filters sRGB: out = clamp(g · c) on 0..1, 8-bit."""
    return np.clip(np.floor(rgb.astype(float) * np.asarray(g)[None, None] + 0.5), 0, 255).astype(np.uint8)
def apply_matrix(rgb, M):
    """feColorMatrix (3×3) with color-interpolation-filters linearRGB."""
    l = LIN[rgb] @ np.asarray(M).T; return np.clip(np.floor(lin_to_srgb(np.clip(l, 0, 1)) + 0.5), 0, 255).astype(np.uint8)


def estimate(clips, ftimes, t0, t1, decode, source="paint", fc4=None, log=print, width=1448):
    """The viewer's sampler (WB.sampleNow at HZ, WB.matchCams every MATCH_EVERY samples) over the clip from 0 s to t1;
    one white point = the median of the smoothed estimate over [t0, t1] (no flicker). → dict(white sRGB 0..255, day, match, …)."""
    times = np.arange(0, t1 + 1e-6, 1 / C["HZ"]); cams = [c for c in clips if c in ftimes]
    idx = {c: {} for c in cams}
    for c in cams:
        ft = np.asarray(ftimes[c])
        for k, t in enumerate(times):
            if c in REP or k % C["MATCH_EVERY"] == 0: idx[c].setdefault(int(np.argmin(np.abs(ft - t))), []).append(k)
    mir, small = {c: {} for c in cams}, {c: {} for c in cams}
    for c in cams:
        if not idx[c]: continue
        for i, img in decode(clips[c], width if c in REP else 480, stop=max(idx[c]) + 1):
            if i not in idx[c]: continue
            rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            sm = rgb if c not in REP else cv2.resize(rgb, (480, round(rgb.shape[0] * 480 / rgb.shape[1])), interpolation=cv2.INTER_AREA)
            for k in idx[c][i]:
                if c in REP: mir[c][k] = rgb
                if k % C["MATCH_EVERY"] == 0: small[c][k] = sm
    tr = Tracker(); hist = []
    for k, t in enumerate(times):
        tr.sample({c: mir[c][k] for c in REP if c in mir and k in mir[c]})
        if k % C["MATCH_EVERY"] == 0 and tr.est is not None: tr.match_cams({c: small[c][k] for c in cams if k in small[c]})
        if t >= t0 - 1e-9 and tr.est is not None: hist.append((list(tr.est), tr.sceneY, {c: list(v) for c, v in tr.match.items()}))
    if not hist: return None
    est = np.median([h[0] for h in hist], 0); w = np.array([np.exp(est[0]), 1, np.exp(est[1])]); w = w * (230 / w.max())
    ys = [h[1] for h in hist if h[1] is not None]; sy = float(np.median(ys)) if ys else None
    match = {c: np.median([h[2][c] for h in hist if c in h[2]], 0).tolist() for c in cams if any(c in h[2] for h in hist)}
    out = dict(white=w.tolist(), sceneY=sy, day=dayness(sy), match=match, samples=len(hist),
               est_range_log=float(np.max(np.ptp([h[0] for h in hist], 0))), source="paint")
    if source == "fusion":                       # CC.fuse over the scene's frames: paint + lanes (front, back) + grey world (+ FC4)
        ests = dict(paint=dict(white=srgb_to_lin(w), conf=0.9)); lanes, gws, fcs = [], [], []
        for k in [k for k, t in enumerate(times) if t >= t0 - 1e-9 and k % C["MATCH_EVERY"] == 0]:
            for c in ("front", "back"):
                if k in small.get(c, {}): e = from_lanes(small[c][k]); lanes += [e] if e else []
            if k in small.get("front", {}):
                gws.append(from_greyworld(small["front"][k]))
                if fc4 and os.path.exists(fc4):
                    try: fcs.append(from_learned(small["front"][k], fc4))
                    except Exception as e: log(f"  scene white balance: FC4 unavailable ({e})"); fc4 = None
        gm = lambda L: dict(white=np.exp(np.median([np.log(e["white"]) for e in L], 0)), conf=float(np.median([e["conf"] for e in L])))
        if lanes: ests["lane"] = gm(lanes)
        if gws: ests["greyworld"] = gm(gws)
        if fcs: ests["learned"] = gm(fcs)
        f = fuse(ests); wl = f["white"]; ws = lin_to_srgb(wl / wl.max()); ws = ws * (230 / ws.max())
        out.update(white_paint=out["white"], white=ws.tolist(), source="fusion", used=f["used"])
    return out


def transform(cam, info, adapt, strength=C["STRENGTH"]):
    """('gains', g) or ('matrix', M) for one camera, as the viewer's apply() (js/wb.js:348-388)."""
    if adapt == "gains": return "gains", gains_for(view_gains(info["white"], info["day"], strength), info["match"].get(cam))
    return "matrix", viewer_matrix(info["white"], adapt, strength)


def run(fused, clips, ftimes, t0, t1, decode, adapt="gains", source="paint", fc4=None, log=print):
    """rewrite the fused textures (fused/frames.json) with the viewer's white balance; write fused/scenewb.json."""
    info = estimate(clips, ftimes, t0, t1, decode, source=source, fc4=fc4, log=log)
    if info is None: log("  scene white balance: no car paint seen in the mirror cameras: left off"); return dict(applied=False)
    d = json.load(open(os.path.join(fused, "frames.json"))); per = {}
    for c in d["cams"]:
        kind, T = transform(c, info, adapt); per[c] = dict(kind=kind, value=np.asarray(T).tolist())
        for f in [f for f in d["frames"] if f["cam"] == c]:
            p = os.path.join(fused, f["name"]); im = cv2.cvtColor(cv2.imread(p), cv2.COLOR_BGR2RGB)
            im = apply_gains(im, T) if kind == "gains" else apply_matrix(im, T)
            cv2.imwrite(p, cv2.cvtColor(im, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 82])
    wl = srgb_to_lin(info["white"]); out = dict(applied=True, adapt=adapt, cct=cct_lin(wl), white_lin=(wl / wl.max()).tolist(), per=per, **info)
    log(f"  scene white balance (viewer, {adapt}, {info['source']}): white {np.round(info['white'], 1).tolist()} ≈ {out['cct']} K, day {info['day']:.2f}, "
        f"match {{{', '.join(f'{c}: {np.round(v, 3).tolist()}' for c, v in info['match'].items())}}}")
    json.dump(out, open(os.path.join(fused, "scenewb.json"), "w"), default=float)
    return out
