#!/usr/bin/env python3
"""make-wb-footage.py — synthetic night event for the white-balance test (test/white-balance.js).
Four cameras (front, back, left + right mirror/repeater) under a warm ~3000 K streetlight cast: the mock stills are
darkened and tinted in linear light, and the scene MOVES (it scrolls past, with a small bob), like driving.
Each mirror camera sees the white car body as a dim sliver along its OUTER edge, like the real cameras: the left
repeater along the far LEFT of its image, the right repeater along the far RIGHT, from ~18 % down, ~1 % wide at the
top widening to ~6.5 % at the bottom, ending at a dark fender line. The body does not move (static noise texture only).
Dim paint (sRGB ≈ 100, 70, 40: no bright highlight), a small clipped specular spot, and a red lamp reflection on the
left-mirror body at 4.0–4.5 s (strongly red: the hue gate must drop it).
NOPAINT=1 → the same moving night scene without any body at the edge (the 'Looking for your white paint' case).
Usage: [NOPAINT=1] [CCT=3000] python3 tools/make-wb-footage.py /tmp/wb-samples      — needs ffmpeg + Pillow + numpy."""
import json, os, sys, subprocess
import numpy as np
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/wb-samples"
NOPAINT = os.environ.get("NOPAINT") == "1"
CCT = float(os.environ.get("CCT", "3000"))
STAMP = "2026-10-20_21-00-00" if not NOPAINT else "2026-10-20_21-10-00"
W, H, FPS, SEC = 960, 720, 24, 8
FLASH = (4.0, 4.5)
PAINT = 0.12                    # night: dim paint, linear level → sRGB ≈ (97, 68, 38) under the cast
RED = (0.32, 0.035, 0.008)      # red lamp reflection on the body (sRGB ≈ 153, 52, 12): R/G ≈ 3
BODY = (0.18, 0.012, 0.065)     # body sliver: starts at 18 % of the height, 1.2 % wide there, 6.5 % wide at the bottom
SCROLL = 5                      # scene scroll, px per frame (the world moves, the body doesn't)

def planck_xy(T):   # Kim et al. cubic fit of the Planckian locus
    if T <= 4000: x = -0.2661239e9 / T**3 - 0.2343589e6 / T**2 + 0.8776956e3 / T + 0.179910
    else: x = -3.0258469e9 / T**3 + 2.1070379e6 / T**2 + 0.2226347e3 / T + 0.240390
    if T <= 2222: y = -1.1063814 * x**3 - 1.34811020 * x**2 + 2.18555832 * x - 0.20219683
    elif T <= 4000: y = -0.9549476 * x**3 - 1.37418593 * x**2 + 2.09137015 * x - 0.16748867
    else: y = 3.0817580 * x**3 - 5.87338670 * x**2 + 3.75112997 * x - 0.37001483
    return x, y
def cast_lin(T):
    x, y = planck_xy(T); X, Y, Z = x / y, 1.0, (1 - x - y) / y
    M = np.array([[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]])
    c = np.clip(M @ np.array([X, Y, Z]), 1e-4, None); return c / c.max()
def to_lin(a): a = a / 255.0; return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
def to_srgb(l): l = np.clip(l, 0, 1); return np.where(l <= 0.0031308, l * 12.92, 1.055 * l ** (1 / 2.4) - 0.055) * 255.0

CAST = cast_lin(CCT)
def base(still):
    im = Image.open(os.path.join(HERE, "mock-stills", still)).convert("RGB").resize((W, H))
    return to_lin(np.asarray(im, dtype=np.float64)) * 0.10 * CAST   # night: dim, everything lit by the streetlight

def body_width(y):
    f = (y / H - BODY[0]) / (1 - BODY[0])
    return 0 if f < 0 else int(round(W * (BODY[1] + (BODY[2] - BODY[1]) * f)))

RNG = np.random.default_rng(7)
TEX = RNG.normal(0, 0.006, (H, W))                                  # static paint texture (the same every frame)

def paint(lin_img, cam, t):
    for y in range(H):
        bw = body_width(y)
        if bw <= 0: continue
        yy = y / H
        level = PAINT * (0.85 + 0.35 * (yy - BODY[0])) + TEX[y, :bw]   # dim, a little brighter lower down
        row = np.clip(level, 0, 1)[:, None] * CAST[None, :]
        if cam == "left_repeater" and FLASH[0] <= t < FLASH[1] and 0.55 < yy < 0.75: row[:] = np.array(RED)[None, :]
        if 0.62 < yy < 0.635 and bw > 8: row[2:6] = 1.2                    # small clipped specular spot
        seam = 0.004 * CAST
        if cam == "left_repeater": lin_img[y, :bw] = row; lin_img[y, bw:bw + 4] = seam
        else: lin_img[y, W - bw:] = row[::-1]; lin_img[y, W - bw - 4:W - bw] = seam
    return lin_img

def encode(cam, path):
    b = base(cam + ".jpg")
    p = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H), "-r", str(FPS), "-i", "-",
                          "-vf", "scale=out_color_matrix=bt709:out_range=tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
                          "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path], stdin=subprocess.PIPE)
    for i in range(FPS * SEC):
        t = i / FPS
        img = np.roll(np.roll(b, -SCROLL * i, axis=1), int(round(3 * np.sin(i / 5.0))), axis=0)   # the world moves past
        if cam.endswith("repeater") and not NOPAINT: img = paint(img, cam, t)
        p.stdin.write(to_srgb(img).round().astype(np.uint8).tobytes())
    p.stdin.close(); p.wait()

def main():
    d = os.path.join(OUT, "TeslaCam", "SavedClips", STAMP); os.makedirs(d, exist_ok=True)
    for cam in ("front", "back", "left_repeater", "right_repeater"): encode(cam, os.path.join(d, STAMP + "-" + cam + ".mp4"))
    with open(os.path.join(d, "event.json"), "w") as f:
        json.dump({"timestamp": STAMP[:10] + "T" + STAMP[11:].replace("-", ":"), "city": "Sampleville", "est_lat": "0", "est_lon": "0", "reason": "user_interaction_honk", "camera": "0"}, f)
    white = [float(v) for v in to_srgb(CAST * 0.6)]
    with open(os.path.join(OUT, "truth.json"), "w") as f: json.dump({"cct": CCT, "paint": not NOPAINT, "flash": FLASH, "cast_lin": list(CAST), "white_srgb": white}, f)
    print(d, "cast", CAST.round(3), "white sRGB", [round(v) for v in white])

if __name__ == "__main__": main()
