#!/usr/bin/env python3
"""Turn photorealistic STILLS (AI-generated mock-up images, one per camera) into short TeslaCam-style clips.

Each still gets gentle motion that follows the simulated drive (the same Scenario/telemetry as make-mock-footage.py):
  front          slow push-in while moving (stops when braking), slides sideways during the lane change
  back / repeaters  slow pull-out (scenery recedes), repeaters also slide during the lane change
  pillars        lateral pan (left pillar: scenery flows right→left, right pillar: left→right)
  Cybercab       a separate layer cut out of left_pillar against left_pillar_plate (clean plate): it overtakes in the
                 left lane while we signal, leaves the pillar view, then shows up ahead in the front camera
plus a little road shake, sensor grain and vignette. SEI telemetry (speed, left blinker from before the pass until after the lane change,
brake at the stop, Self-Driving, GPS) is injected exactly like make-mock-footage.py, so HUD/map/badge work.

Stills folder layout (JPEG or PNG; any size, ~3:2 for HW4 cams, ~4:3 for the Sentry set):
  front, back, left_pillar, right_pillar, left_repeater, right_repeater          → SavedClips drive (+ RecentClips)
  sentry_front, sentry_back, sentry_left_repeater, sentry_right_repeater         → SentryClips (optional;
                                                                                   falls back to the drive stills)
Stills may be any size/aspect (e.g. 1280x720 16:9); they are cropped per FRAMING and upscaled to the camera size.
The drive (18:22) and the parked Sentry event (18:40, same street) are both timed at golden hour to match the bundled stills.
Usage: python3 tools/make-photo-footage.py STILLS_DIR OUT_DIR [--encrypted] [--jobs N]
       python3 tools/make-photo-footage.py --export-stills RAW_DIR tools/mock-stills   (face blur + small JPEGs)
"""
import base64, glob, importlib.util, json, math, os, subprocess, sys, tempfile
from multiprocessing import Pool
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, file)); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
MOCK = _load("make_mock_footage", "make-mock-footage.py")
MS = MOCK.MS
FPS = MOCK.FPS
ALL = ["front", "back", "left_repeater", "right_repeater", "left_pillar", "right_pillar"]

def find_still(d, name):
    for ext in ("jpg", "jpeg", "png", "webp"):
        p = os.path.join(d, f"{name}.{ext}")
        if os.path.exists(p): return p
    return None

# Per-still framing (coordinates are fractions of the still: x/width, y/height):
#   box   optional pre-crop          ax/ay  horizontal/vertical anchor when cropping to the camera aspect (3:2 HW4, 4:3 HW3)
#   vp    vanishing point: zoom (push-in / pull-out) is centred on it, so the road recedes naturally
#   body  polygon of the car's OWN body (bumper / fender / door) — kept fixed in frame while the scenery moves
#   faces ellipses (x0, y0, x1, y1) lightly blurred (AI-generated faces)
FRAMING = {
    "front":           dict(vp=(0.507, 0.488)),
    "back":            dict(box=(0, 0, 1, 0.94), vp=(0.50, 0.40), body=[(0.000, 0.871), (0.078, 0.854), (0.156, 0.857), (0.312, 0.887), (0.500, 0.892), (0.688, 0.885), (0.844, 0.857), (0.922, 0.857), (1.000, 0.868), (1.000, 1.000), (0.000, 1.000)]),   # bumper ~14% of the still → ~5-8% after trimming the bottom
    "left_repeater":   dict(box=(0.0000, 0.0556, 0.7719, 0.9464), vp=(0.50, 0.40), body=[(0.974, 0.000), (0.927, 0.139), (0.896, 0.208), (0.849, 0.278), (0.834, 0.306), (0.775, 0.389), (0.724, 0.472), (0.705, 0.500), (0.695, 0.556), (0.693, 0.625), (0.689, 0.694), (0.685, 0.750), (0.677, 0.806), (0.670, 0.861), (0.670, 0.944), (0.671, 1.000), (1.000, 1.000), (1.000, 0.000)]),   # trim from the body (right) side → body ≤13% of the frame
    "right_repeater":  dict(box=(0.2281, 0.0556, 1.0000, 0.9464), vp=(0.46, 0.39), body=[(0.000, 0.000), (0.018, 0.000), (0.120, 0.139), (0.139, 0.208), (0.155, 0.278), (0.166, 0.306), (0.198, 0.361), (0.229, 0.417), (0.264, 0.472), (0.280, 0.500), (0.303, 0.556), (0.303, 0.625), (0.311, 0.694), (0.315, 0.778), (0.323, 0.833), (0.329, 0.903), (0.330, 1.000), (0.000, 1.000)]),   # trim from the body (left) side
    "left_pillar":     dict(ax=1.0, body=[(0.906, 1.000), (0.910, 0.970), (0.915, 0.942), (0.925, 0.900), (0.939, 0.858), (0.960, 0.810), (0.980, 0.775), (1.000, 0.754), (1.000, 1.000)]),
    "right_pillar":    dict(ax=0.0, body=[(0.000, 0.718), (0.016, 0.735), (0.031, 0.754), (0.047, 0.776), (0.062, 0.801), (0.078, 0.840), (0.088, 0.875), (0.096, 0.897), (0.102, 0.926), (0.108, 0.965), (0.110, 1.000), (0.000, 1.000)]),
    "sentry_front":   dict(box=(0, 0, 1, 0.89), vp=(0.578, 0.47)),       # crop away the dark dash strip
    "sentry_back":    dict(vp=(0.50, 0.19), body=[(0.000, 0.854), (0.195, 0.835), (0.500, 0.826), (0.811, 0.833), (1.000, 0.854), (1.000, 1.000), (0.000, 1.000)]),
    "sentry_left_repeater":  dict(ax=1.0, vp=(0.735, 0.48), body=[(0.918, 0.000), (0.913, 0.260), (0.911, 0.608), (0.916, 1.000), (1.000, 1.000), (1.000, 0.000)]),
    "sentry_right_repeater": dict(ax=0.0, vp=(0.47, 0.42), body=[(0.000, 0.156), (0.029, 0.278), (0.059, 0.451), (0.083, 0.660), (0.098, 0.764), (0.101, 0.868), (0.096, 1.000), (0.000, 1.000)]),
}

def blur_faces(img, name):
    """Lightly blur any listed face regions (feathered ellipse)."""
    from PIL import ImageDraw, ImageFilter
    faces = FRAMING.get(name, {}).get("faces")
    if not faces: return img
    W, H = img.size
    m = Image.new("L", (W, H), 0); d = ImageDraw.Draw(m)
    for x0, y0, x1, y1 in faces: d.ellipse([x0 * W, y0 * H, x1 * W, y1 * H], fill=255)
    m = m.filter(ImageFilter.GaussianBlur(4))
    return Image.composite(img.filter(ImageFilter.GaussianBlur(4.5)), img, m)

def cover(img, W, H, over, name=""):
    """Scale/crop the still so it covers W*over × H*over (upscaling small stills as needed).
    Returns (image, mapper) where mapper(fx, fy) turns still fractions into source-pixel coordinates."""
    fr = FRAMING.get(name, {})
    ow, oh = img.size; bx0, by0, bx1, by1 = fr.get("box", (0, 0, 1, 1))
    img = img.crop((int(bx0 * ow), int(by0 * oh), int(bx1 * ow), int(by1 * oh)))
    tw, th = int(W * over), int(H * over)
    r = max(tw / img.width, th / img.height)
    im = img.resize((max(tw, round(img.width * r)), max(th, round(img.height * r))), Image.LANCZOS)
    l = int((im.width - tw) * fr.get("ax", 0.5)); t = int((im.height - th) * fr.get("ay", 0.5))
    def mapper(fx, fy): return ((fx * ow - int(bx0 * ow)) * r - l, (fy * oh - int(by0 * oh)) * r - t)
    return im.crop((l, t, l + tw, t + th)), mapper

def body_mask(name, size, mapper, feather=2.0):
    from PIL import ImageDraw, ImageFilter
    poly = FRAMING.get(name, {}).get("body")
    if not poly: return None
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).polygon([mapper(x, y) for x, y in poly], fill=255)
    return m.filter(ImageFilter.GaussianBlur(feather)) if feather else m

def fill_body(src, hard):
    """Cheap inpaint: replace the car-body area with a smooth fill of the surrounding scenery (normalised convolution),
    so the moving layer has no second copy of the body to slide out from under the fixed one."""
    from PIL import ImageFilter
    a = np.asarray(src, np.float32); m = np.asarray(hard, np.float32)[..., None] / 255.0
    valid = 1.0 - m; out = a.copy(); done = np.zeros_like(m)
    for rad in (96, 48, 24, 10):
        num = np.asarray(Image.fromarray(np.clip(a * valid, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(rad)), np.float32)
        den = np.asarray(Image.fromarray((valid[..., 0] * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(rad)), np.float32)[..., None] / 255.0
        est = num / np.maximum(den, 1e-3)
        use = (den > 0.02) * m
        out = np.where(use > 0, est, out)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))

# ───────── drive story (photo footage) ─────────
# The left pillar shows a Cybercab overtaking in the left lane. We signal first, hold our lane while it passes,
# steer into the left lane only once it has left the pillar view, then cancel the blinker. The red-light stop is unchanged.
BLINK_ON, PASS_DONE, LC_START, LC_END, BLINK_OFF = 1.0, 4.3, 4.6, 7.0, 7.4
def scenario(kind, total, seed):
    sc = MOCK.Scenario(kind, total, seed)
    if kind == "drive": sc.lc = (LC_START, LC_END); sc.blink = (BLINK_ON, BLINK_OFF)
    return sc

def smooth01(x): x = min(1.0, max(0.0, x)); return x * x * (3 - 2 * x)

# Overtaking car layer, cut out of left_pillar by difference against a clean plate of the same view.
CAB = dict(plate="left_pillar_plate", roi=(0.17, 0.43, 0.63, 0.83), seed=(0.40, 0.62),
           poly=[(x / 1024, y / 576) for x, y in [(335, 258), (470, 256), (548, 278), (602, 316), (624, 345), (630, 405), (562, 426),
                                                  (440, 468), (250, 462), (193, 440), (185, 380), (189, 330), (235, 298)]])

def cab_mask(still, plate, thr=45):
    """Difference mask (still vs clean plate), cleaned up and limited to the car's outline + shadow. Returns an L image (0/255)."""
    from PIL import ImageChops, ImageDraw, ImageFilter
    W, H = still.size
    A = np.asarray(plate.convert("RGB").resize((W, H), Image.LANCZOS), np.float32); B = np.asarray(still.convert("RGB"), np.float32)
    d = np.asarray(Image.fromarray(np.clip(np.abs(A - B).sum(2) / 3, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(4)), np.float32) * 3
    x0, y0, x1, y1 = [int(v * k) for v, k in zip(CAB["roi"], (W, H, W, H))]
    m = np.zeros((H, W), bool); m[y0:y1, x0:x1] = d[y0:y1, x0:x1] > thr
    im = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(15)).filter(ImageFilter.MinFilter(15))
    im = im.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(5))
    inv = im.point(lambda v: 0 if v > 127 else 255); ImageDraw.floodfill(inv, (0, 0), 128)     # fill holes
    im = Image.fromarray(np.where(np.asarray(inv) == 128, 0, 255).astype(np.uint8))
    pm = Image.new("L", (W, H), 0); ImageDraw.Draw(pm).polygon([(x * W, y * H) for x, y in CAB["poly"]], fill=255)
    im = ImageChops.multiply(im, pm)
    ImageDraw.floodfill(im, (int(CAB["seed"][0] * W), int(CAB["seed"][1] * H)), 128)            # keep the car's blob only
    return Image.fromarray(np.where(np.asarray(im) == 128, 255, 0).astype(np.uint8))

def cab_pillar(t, kind):
    """Cybercab in the left pillar: (dx, dy as fractions of the frame, scale). It overtakes (moves toward image-right =
    forward), easing in, shrinking a little as it pulls ahead, and has fully left the frame by PASS_DONE."""
    if kind == "drive":
        q = min(1.0, max(0.0, (t + 0.6) / (PASS_DONE + 0.6))) ** 1.8
        return -0.02 + 1.04 * q, -0.04 * q, 1.0 - 0.15 * q
    q = t / 6.0                                   # other drives: cruising alongside, creeping forward
    return -0.04 + 0.12 * q, -0.005 * q, 1.0 - 0.02 * q

def cab_front(t, kind):
    """Cybercab seen ahead in the front camera after it passes: None, or (depth Δy = how far below the horizon its
    wheels sit, as a fraction of the still height; lateral offset in metres from our lane centre)."""
    if kind != "drive" or t < PASS_DONE: return None
    d = 1 / 0.50 + (1 / 0.10 - 1 / 0.50) * (1 - math.exp(-(t - PASS_DONE) / 2.7))   # pulls away, then settles at the light
    return 1.0 / d

# front camera: lateral scale (still px per metre per unit Δy, at 1280 px) and Cybercab cut-out width per unit (Δy/0.162)
CAB_FRONT_LAT = 276.0
CAB_FRONT_W = 0.13
LEAD_CAR = [(0.476, 0.508), (0.540, 0.508), (0.552, 0.540), (0.563, 0.556), (0.563, 0.655), (0.452, 0.655), (0.452, 0.556), (0.463, 0.540)]   # red Model S ahead (front still)

class Motion:
    """Crop window (centre x/y offset in output px, zoom) for camera `cam` at time t, driven by the scenario."""
    def __init__(self, sc, cam, W, H, over):
        self.sc, self.cam, self.W, self.H, self.over = sc, cam, W, H, over
        self.total = sc.total
        self.s_end = max(1e-6, sc.ego(sc.total)[1])

    def at(self, t):
        """Returns (zoom, dx, dy): zoom ≥ 1 relative to the whole (covered) still, centred on its vanishing point;
        dx/dy in output pixels. Zoom 1 = the full frame, so the car-body sliver at the edges stays visible."""
        sc, cam, W = self.sc, self.cam, self.W
        x, s, yaw, v, br = sc.ego(t)
        u = s / self.s_end if self.s_end > 1e-3 else 0.0     # 0..1 progress along the drive (freezes when stopped)
        lane = (5.4 - x) / 3.6                                # 0 → 1 over the lane change (moving left)
        bump = math.sin(math.pi * min(1.0, max(0.0, lane)))   # transient sideways sway during the lane change
        zoom, dx, dy = 1.0, 0.0, 0.0
        if sc.kind == "sentry":                                 # parked: just a slow, steady push-in, no shake
            return 1.0 + 0.06 * t / self.total, 0.0, 0.0
        if cam == "front":
            zoom = 1.06 + 0.2 * u                              # push in toward the vanishing point
            dx = -0.10 * W * lane                              # crop moves left → scene slides right as we move left
        elif cam == "back":
            zoom = 1.0 + 0.14 * (1 - u)                        # pull out: scenery recedes as we drive forward
            dx = +0.03 * W * bump
        elif cam in ("left_repeater", "right_repeater"):
            zoom = 1.0 + 0.12 * (1 - u)                        # pull out (looking backward)
            dx = 0.03 * W * bump
        elif cam == "left_pillar":
            # looks left: forward is image-right, so passing scenery slides toward the rear = image-left
            zoom = 1.08 + 0.05 * min(1.0, max(0.0, lane)); dx = (u - 0.5) * 0.07 * W   # crop moves right → scenery flows right → left; median comes closer after the merge
        elif cam == "right_pillar":
            # looks right: forward is image-left (the curb's vanishing point), scenery slides toward the rear = image-right
            zoom = 1.08 - 0.04 * min(1.0, max(0.0, lane)); dx = -(u - 0.5) * 0.07 * W   # curb recedes after the merge
        sx, sy = self.shake(t)
        return zoom, dx + sx, dy + sy

    def shake(self, t):
        """Road shake in output px, stronger with speed."""
        x, s, yaw, v, br = self.sc.ego(t)
        if self.sc.kind == "sentry": return 0.0, 0.0
        k = min(1.0, v / 13.4)
        sx = k * (0.9 * math.sin(t * 13.1) + 0.5 * math.sin(t * 29.7 + 1.3))
        sy = k * (1.2 * math.sin(t * 17.3 + 0.4) + 0.6 * math.sin(t * 41.0)) + (0.0 if not br else 0.8 * math.sin(t * 6.0) * k)
        return sx, sy

def render_job(args):
    path, cam, still, W, H, t0, dur, kind, total, seed, rows = args
    sc = scenario(kind, total, seed)
    over = 1.3                                                    # render the source a bit larger than the output (sharper zooms)
    name = os.path.splitext(os.path.basename(still))[0]
    still_img = blur_faces(Image.open(still).convert("RGB"), name)
    plate = find_still(os.path.dirname(still), CAB["plate"])
    cab_src = cab_cut = None
    if name == "left_pillar" and plate and kind != "sentry":
        # moving-car layer: the Cybercab (with its shadow) cut out of the still; the clean plate becomes the scenery
        from PIL import ImageFilter
        cm = cab_mask(still_img, Image.open(plate)).filter(ImageFilter.GaussianBlur(2.5))
        rgba = still_img.copy(); rgba.putalpha(cm)
        cab_src, _ = cover(rgba, W, H, over * 1.02, name)
        bb = cm.getbbox(); cab_anchor = ((bb[0] + bb[2]) / 2 / still_img.width, bb[3] / still_img.height)
        still_img = Image.open(plate).convert("RGB").resize(still_img.size, Image.LANCZOS)
    if name == "front" and kind == "drive":
        pd = os.path.dirname(still); lp = find_still(pd, "left_pillar"); pl = find_still(pd, CAB["plate"])
        if lp and pl:
            from PIL import ImageFilter
            li = Image.open(lp).convert("RGB"); cm = cab_mask(li, Image.open(pl)).filter(ImageFilter.GaussianBlur(2.5))
            rgba = li.copy(); rgba.putalpha(cm); cab_cut = rgba.crop(cm.getbbox())
    src, mapper = cover(still_img, W, H, over * 1.02, name)
    SW, SH = src.size
    ow, oh = still_img.size
    r_still = (mapper(1, 0)[0] - mapper(0, 0)[0]) / ow                # still px → source px
    vpx, vpy = mapper(*FRAMING.get(name, {}).get("vp", (0.5, 0.5)))
    # fixed car body: render it once from the unmoved view, and inpaint it out of the moving layer
    static_box = (0, 0, SW, SH)                                   # zoom 1 = the whole covered still
    soft = body_mask(name, (SW, SH), mapper)
    body_rgb = body_a = None
    if soft is not None:
        body_rgb = np.asarray(src.transform((W, H), Image.EXTENT, static_box, Image.BILINEAR), np.float32)
        body_a = np.asarray(soft.transform((W, H), Image.EXTENT, static_box, Image.BILINEAR), np.float32)[..., None] / 255.0
        from PIL import ImageFilter
        src = fill_body(src, body_mask(name, (SW, SH), mapper, 0).filter(ImageFilter.MaxFilter(9)))
    lead_mask = None
    if cab_cut is not None:
        from PIL import ImageDraw, ImageFilter
        lead_mask = Image.new("L", (SW, SH), 0)
        ImageDraw.Draw(lead_mask).polygon([mapper(x, y) for x, y in LEAD_CAR], fill=255)
        lead_mask = lead_mask.filter(ImageFilter.GaussianBlur(1.5))
    mo = Motion(sc, cam, W, H, over)
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    r2 = ((xs - W / 2) / (W / 2)) ** 2 + ((ys - H / 2) / (W / 2)) ** 2
    vig = (1 - 0.30 * (r2 / r2.max()) ** 1.4)[..., None].astype(np.float32)
    rng = np.random.default_rng(seed * 7 + ALL.index(cam) if cam in ALL else seed)
    noises = [rng.normal(0, 2.4, (H, W, 1)).astype(np.float32) for _ in range(6)]
    n = int(round(dur * FPS))
    with tempfile.TemporaryDirectory() as td:
        raw = os.path.join(td, "v.h264")
        p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                              "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-profile:v", "high", "-bf", "0", "-g", str(FPS),
                              "-crf", "27", "-f", "h264", raw], stdin=subprocess.PIPE)
        for k in range(n):
            t = t0 + k / FPS
            zoom, dx, dy = mo.at(t)
            # crop box in source pixels (source covers over×output); clamp inside
            cw, ch = SW / zoom, SH / zoom
            # zoom about the vanishing point, then offset (dx/dy are output pixels)
            cx = vpx + (SW / 2 - vpx) / zoom + dx * SW / W; cy = vpy + (SH / 2 - vpy) / zoom + dy * SH / H
            cx = min(max(cx, cw / 2), SW - cw / 2); cy = min(max(cy, ch / 2), SH - ch / 2)
            fr = src.transform((W, H), Image.EXTENT, (cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2), Image.BILINEAR)
            a = np.asarray(fr, np.float32)
            kx = cw / W; bx0, by0 = cx - cw / 2, cy - ch / 2           # output px → source px
            if cab_src is not None:
                # the car keeps its own (static) view plus road shake and moves forward on top of the panning scenery
                z0 = 1.08; cw0, ch0 = SW / z0, SH / z0
                sx0 = vpx + (SW / 2 - vpx) / z0; sy0 = vpy + (SH / 2 - vpy) / z0
                sh_x, sh_y = mo.shake(t)
                sx0 = min(max(sx0, cw0 / 2), SW - cw0 / 2) - sh_x * SW / W; sy0 = min(max(sy0, ch0 / 2), SH - ch0 / 2) - sh_y * SH / H
                k0 = cw0 / W; b0x, b0y = sx0 - cw0 / 2, sy0 - ch0 / 2
                ax_, ay_ = mapper(*cab_anchor); Ax, Ay = (ax_ - b0x) / k0, (ay_ - b0y) / k0
                cdx, cdy, cs = cab_pillar(t, kind); Tx, Ty = cdx * W, cdy * H
                coeffs = (k0 / cs, 0, b0x + k0 * (Ax + (-Tx - Ax) / cs), 0, k0 / cs, b0y + k0 * (Ay + (-Ty - Ay) / cs))
                layer = np.asarray(cab_src.transform((W, H), Image.AFFINE, coeffs, Image.BILINEAR), np.float32)
                al = layer[..., 3:4] / 255.0; a = a * (1 - al) + layer[..., :3] * al
            if cab_cut is not None:
                dy_ = cab_front(t, kind)
                if dy_ is not None:
                    pre = a.copy()
                    vfx, vfy = FRAMING["front"]["vp"]
                    enter = 4.5 * (1 - smooth01((t - PASS_DONE) / 0.9))               # slides in from the left edge (wide-angle FOV entry)
                    bxs = vfx * ow - CAB_FRONT_LAT * (3.6 + enter) * dy_ * ow / 1280   # stays in the left lane (scene coordinates)
                    bys = (vfy + dy_) * oh
                    wst = CAB_FRONT_W * (dy_ / 0.162) * ow                         # still px, sized against the car ahead
                    sq = 0.62 + 0.30 * min(1.0, dy_ / 0.5)                         # side foreshortens as it pulls away
                    px, py = mapper(bxs / ow, bys / oh); X = (px - bx0) / kx; Y = (py - by0) / kx
                    wo = max(2, int(wst * r_still / kx * sq)); ho = max(2, int(wst * r_still / kx * cab_cut.height / cab_cut.width))
                    cut = np.asarray(cab_cut.resize((wo, ho), Image.LANCZOS), np.float32)
                    x0, y0 = int(round(X - wo / 2)), int(round(Y - ho))
                    xa, ya, xb, yb = max(0, x0), max(0, y0), min(W, x0 + wo), min(H, y0 + ho)
                    if xb > xa and yb > ya:
                        c = cut[ya - y0:yb - y0, xa - x0:xb - x0]; al = c[..., 3:4] / 255.0
                        a[ya:yb, xa:xb] = a[ya:yb, xa:xb] * (1 - al) + c[..., :3] * 0.82 * al   # its rear faces the low sun → a bit darker
                    if dy_ < 0.162 and lead_mask is not None:              # farther than the car ahead → behind it
                        lm = np.asarray(lead_mask.transform((W, H), Image.EXTENT, (bx0, by0, bx0 + cw, by0 + ch), Image.BILINEAR), np.float32)[..., None] / 255.0
                        a = a * (1 - lm) + pre * lm
            if body_a is not None: a = a * (1 - body_a) + body_rgb * body_a
            a = a * vig + noises[k % 6]
            p.stdin.write(np.clip(a, 0, 255).astype(np.uint8).tobytes())
        p.stdin.close(); p.wait()
        data = open(raw, "rb").read()
        if rows is not None: data = MS.inject_sei(data, rows); open(raw, "wb").write(data)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(FPS), "-i", raw, "-c", "copy", "-video_track_timescale", "90000", path], check=True)
    return path

def event_jobs(folder, stamps, cams, sizes, clip_dur, kind, seed, telemetry, stills, prefix=""):
    os.makedirs(folder, exist_ok=True)
    total = clip_dur * len(stamps)
    rows_all = scenario(kind, total, seed).telemetry() if telemetry else None
    per = int(round(clip_dur * FPS)); jobs = []
    for ci, st in enumerate(stamps):
        rows = rows_all[ci * per:(ci + 1) * per] if rows_all else None
        for cam in cams:
            still = (find_still(stills, prefix + cam) if prefix else None) or find_still(stills, cam)
            if not still: sys.exit(f"missing still for {prefix + cam} in {stills}")
            W, H = sizes["front"] if cam == "front" else sizes["side"]
            jobs.append((os.path.join(folder, f"{st}-{cam}.mp4"), cam, still, W, H, ci * clip_dur, clip_dur, kind, total, seed, rows))
    return jobs

def export_stills(raw, out):
    """Prepare the committed stills: blur listed faces, save as compact progressive JPEGs."""
    os.makedirs(out, exist_ok=True)
    for f in sorted(glob.glob(os.path.join(raw, "*.jpg")) + glob.glob(os.path.join(raw, "*.png"))):
        name = os.path.splitext(os.path.basename(f))[0]
        im = blur_faces(Image.open(f).convert("RGB"), name)
        o = os.path.join(out, name + ".jpg"); im.save(o, quality=86, optimize=True, progressive=True)
        print(f"  {name}.jpg {os.path.getsize(o) // 1024} KB")

def main():
    if "--export-stills" in sys.argv:
        a = [x for x in sys.argv[1:] if not x.startswith("--")]
        return export_stills(a[0], a[1])
    args = [a for a in sys.argv[1:] if not a.startswith("--") and not a.isdigit()]
    if len(args) < 2: sys.exit(__doc__)
    stills, out = args[0], args[1]; enc = "--encrypted" in sys.argv
    jobsn = int(sys.argv[sys.argv.index("--jobs") + 1]) if "--jobs" in sys.argv else os.cpu_count()
    tc = os.path.join(out, "TeslaCam")
    HW4 = {"front": (1448, 938), "side": (724, 470)}
    HW3 = {"front": (960, 720), "side": (960, 720)}
    saved = os.path.join(tc, "SavedClips", "2026-10-07_18-23-41")
    sentry = os.path.join(tc, "SentryClips", "2026-10-07_18-41-05")
    recent = os.path.join(tc, "RecentClips")
    jobs = event_jobs(saved, ["2026-10-07_18-22-41", "2026-10-07_18-23-41"], ALL, HW4, 6.0, "drive", 11, True, stills)
    jobs += event_jobs(sentry, ["2026-10-07_18-40-05"], ["front", "back", "left_repeater", "right_repeater"], HW3, 6.0, "sentry", 23, False, stills, "sentry_")
    jobs += event_jobs(recent, ["2026-10-08_08-15-00"], [c for c in ALL if c != "right_pillar"], HW4, 5.0, "recent", 37, True, stills)
    enc_tmp = None
    if enc:
        enc_tmp = tempfile.mkdtemp()
        jobs += event_jobs(enc_tmp, ["2026-10-08_09-00-00"], ALL, HW4, 4.0, "recent", 41, True, stills)
    with Pool(jobsn) as pool:
        for p in pool.imap_unordered(render_job, jobs): print("  rendered", os.path.basename(p), flush=True)
    json.dump({"timestamp": "2026-10-07T18:23:41", "city": "Palo Alto", "est_lat": "37.3944", "est_lon": "-122.1503",
               "reason": "user_interaction_dashcam_icon_tapped", "camera": "0"}, open(os.path.join(saved, "event.json"), "w"), indent=1)
    json.dump({"timestamp": "2026-10-07T18:40:07", "city": "Palo Alto", "est_lat": "37.3951", "est_lon": "-122.1497",
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
