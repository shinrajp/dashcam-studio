#!/usr/bin/env python3
"""make-wb-footage.py — synthetic night event for the white-balance test (test/white-balance.js).
Four cameras (front, back, left + right mirror/repeater) under a warm ~3000 K streetlight cast: the mock stills are
darkened and tinted in linear light. Each mirror camera sees "white car paint" along its INNER edge (left repeater:
right side of the image, right repeater: left side), lower part: a smooth paint gradient, a glossy highlight band and a
small clipped specular spot. A red lamp reflection flashes on the left-mirror paint at 4.0–4.5 s.
NOPAINT=1 → the same night scene without any paint (the 'Looking for your white paint' case).
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

def paint(lin_img, cam, t):
    x0, x1 = (int(W * 0.84), W) if cam == "left_repeater" else (0, int(W * 0.16))
    y0 = int(H * 0.55)
    h, w = H - y0, x1 - x0
    yy, xx = np.mgrid[0:h, 0:w]
    inner = (xx / max(w - 1, 1)) if cam == "left_repeater" else (1 - xx / max(w - 1, 1))   # 1 at the image edge (closest to the car)
    level = 0.25 + 0.20 * inner + 0.04 * np.sin(yy / 9.0)             # paint body: smooth gradient
    band = np.exp(-((yy - h * 0.35) / (h * 0.06)) ** 2) * 0.38         # glossy highlight band along the body line
    level = level + band
    reg = level[..., None] * CAST[None, None, :]
    # small clipped specular spot (neutral, saturated to 255): must be ignored
    cy, cx = int(h * 0.35), w // 2
    reg[cy - 4:cy + 4, cx - 4:cx + 4, :] = 1.2
    if cam == "left_repeater" and FLASH[0] <= t < FLASH[1]:          # red lamp reflection on the highlight
        m = band[..., None] > 0.2
        reg = np.where(m, np.array([0.95, 0.06, 0.04])[None, None, :] * (0.6 + band[..., None]), reg)
    lin_img[y0:H, x0:x1, :] = reg
    return lin_img

def encode(cam, path):
    b = base(cam + ".jpg")
    p = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H), "-r", str(FPS), "-i", "-",
                          "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path], stdin=subprocess.PIPE)
    for i in range(FPS * SEC):
        t = i / FPS
        img = b.copy()
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
