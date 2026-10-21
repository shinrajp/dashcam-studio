#!/usr/bin/env python3
"""Synthetic night test set for the colour-constancy prototype (tools/cc-eval, test/color-constancy.js).
Each public-domain / CC0 vehicle photo (tools/fetch-vehicle-fixtures.py, plates blurred, colour truth in meta.json) is
treated as reflectance and lit by a known light: Planckian 2100–5500 K, a greenish mercury / fluorescent lamp and a
neutral LED, at two night exposures, with sensor noise. Under it: a road strip (asphalt, white lane dashes, a yellow
centre line in half the scenes) and a white licence plate (a yellow one in a quarter of them); and a separate 'mirror'
patch of white car paint (slightly off-white, shaded, with clipped highlights) like the repeater cameras see.
Usage: make-cc-testset.py [outdir=/tmp/cc-testset] [fixtures=/tmp/vehicle-fixtures]"""
import json, os, sys, subprocess, numpy as np
from PIL import Image, ImageDraw
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/cc-testset"
FX = sys.argv[2] if len(sys.argv) > 2 else "/tmp/vehicle-fixtures"
HERE = os.path.dirname(os.path.abspath(__file__))
if not os.path.exists(os.path.join(FX, "meta.json")): subprocess.check_call([sys.executable, os.path.join(HERE, "fetch-vehicle-fixtures.py"), FX])
os.makedirs(OUT, exist_ok=True)
meta = [m for m in json.load(open(os.path.join(FX, "meta.json"))) if m["truth"].get("color")]
M = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.072175], [0.0193339, 0.119192, 0.9503041]]); Mi = np.linalg.inv(M)
def planck(t):
    x = (-0.2661239e9 / t**3 - 0.2343589e6 / t**2 + 0.8776956e3 / t + 0.17991) if t <= 4000 else (-3.0258469e9 / t**3 + 2.1070379e6 / t**2 + 0.2226347e3 / t + 0.24039)
    y = (-1.1063814 * x**3 - 1.3481102 * x**2 + 2.18555832 * x - 0.20219683) if t <= 2222 else (-0.9549476 * x**3 - 1.37418593 * x**2 + 2.09137015 * x - 0.16748867) if t <= 4000 else (3.081758 * x**3 - 5.8733867 * x**2 + 3.75112997 * x - 0.37001483)
    rgb = Mi @ np.array([x / y, 1, (1 - x - y) / y]); return rgb / rgb.max()
LIGHTS = [("2100K", planck(2100)), ("2700K", planck(2700)), ("3000K", planck(3000)), ("3500K", planck(3500)), ("4200K", planck(4200)), ("5500K", planck(5500)),
          ("mercury", (lambda v: v / v.max())(planck(4000) * np.array([0.9, 1.15, 1.0]))), ("LED6500", planck(6500))]
EXPO = [0.3, 0.6]
lin = lambda a: np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
enc = lambda a: np.where(a <= 0.0031308, a * 12.92, 1.055 * np.clip(a, 0, None) ** (1 / 2.4) - 0.055)
W, H, RH = 640, 480, 160
truth = []
for vi, m in enumerate(meta):
    rng = np.random.default_rng(1000 + vi)
    photo = lin(np.asarray(Image.open(os.path.join(FX, m["file"])).convert("RGB").resize((W, H), Image.BILINEAR), dtype=np.float64) / 255)
    # road strip reflectance
    road = np.full((RH, W, 3), 0.09) * (1 + 0.25 * rng.standard_normal((RH, W, 1))).clip(0.4, 1.8)
    im = Image.new("L", (W, RH), 0); d = ImageDraw.Draw(im)
    for k in range(3): x0 = 40 + k * 150; d.polygon([(x0, RH), (x0 + 36, RH), (x0 + 70, 0), (x0 + 58, 0)], fill=255)   # white dashes
    lane = np.asarray(im, dtype=np.float64)[..., None] / 255
    road = road * (1 - lane) + lane * (0.62 * (1 + 0.03 * rng.standard_normal(3)))
    yellow = vi % 2 == 0
    if yellow:
        im = Image.new("L", (W, RH), 0); ImageDraw.Draw(im).rectangle([300, 0, 312, RH], fill=255); yl = np.asarray(im, dtype=np.float64)[..., None] / 255
        road = road * (1 - yl) + yl * np.array([0.55, 0.40, 0.06])
    # plate on the right of the strip
    pbg = np.array([0.85, 0.7, 0.18]) if vi % 4 == 1 else 0.72 * (1 + 0.02 * rng.standard_normal(3))
    px0, py0, pw, ph = 532, 40, 96, 48
    road[py0:py0 + ph, px0:px0 + pw] = pbg
    im = Image.new("L", (pw, ph), 0); ImageDraw.Draw(im).text((10, 14), "7CC%03d" % vi, fill=255); im = im.resize((pw, ph)); chars = np.asarray(im, dtype=np.float64)[..., None] / 255
    road[py0:py0 + ph, px0:px0 + pw] = road[py0:py0 + ph, px0:px0 + pw] * (1 - chars) + chars * 0.04
    scene = np.concatenate([photo, road], 0)
    # mirror patch: off-white paint, shaded top→bottom, a few clipped highlights
    paint = 0.7 * (1 + 0.02 * rng.standard_normal(3))
    mir = np.ones((96, 96, 3)) * paint * np.linspace(0.55, 1.0, 96)[:, None, None]
    for _ in range(6): y, x = rng.integers(0, 90, 2); mir[y:y + 4, x:x + 6] = 3.0
    for (ln, L) in LIGHTS:
        for e in EXPO:
            def shoot(refl, seed):
                r = np.random.default_rng(seed); a = refl * L * e; a = a + r.normal(0, 0.003, a.shape) + r.normal(0, 0.006, a.shape) * np.sqrt(np.clip(a, 0, None))
                return Image.fromarray((enc(np.clip(a, 0, 1)) * 255 + 0.5).astype(np.uint8))
            name = "%s-%s-%d" % (m["key"], ln, int(e * 100))
            shoot(scene, vi * 97 + 1).save(os.path.join(OUT, name + ".png")); shoot(mir, vi * 97 + 2).save(os.path.join(OUT, name + "-mirror.png"))
            truth.append({"file": name + ".png", "mirror": name + "-mirror.png", "key": m["key"], "src": m["file"], "color": m["truth"]["color"], "cls": m["truth"]["cls"],
                          "light": ln, "illum": [round(float(v), 5) for v in L], "exposure": e, "fold": "A" if vi % 2 == 0 else "B",
                          "photo": {"x": 0, "y": 0, "w": 1, "h": H / (H + RH)}, "lanes": {"x0": 0.0, "x1": 0.78, "y0": (H + 2) / (H + RH), "y1": 0.995},
                          "plate": {"x": px0 / W, "y": (H + py0) / (H + RH), "w": pw / W, "h": ph / (H + RH)}, "yellowLine": yellow, "yellowPlate": vi % 4 == 1})
json.dump({"items": truth, "sources": [{k: m[k] for k in ("key", "file", "title", "page", "license")} for m in meta]}, open(os.path.join(OUT, "truth.json"), "w"), indent=1)
print(len(truth), "scenes in", OUT)
