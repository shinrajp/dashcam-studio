#!/usr/bin/env python3
"""make-track-footage.py — a short synthetic TeslaCam event for test/track-footage.js: on the FRONT camera a made-up sign (a made-up plate image, no real
plate) crosses the scene, speeding up, growing and weaving; an identical copy trails it (a look-alike); a pole covers it for about half a second;
light and sensor noise drift. The other cameras are still pictures. Writes the true box of the sign for every frame to track-truth.json.
Needs ffmpeg, numpy and Pillow.
Usage: python3 tools/make-track-footage.py [out_dir] [--exit]     (default /tmp/track-footage)
   --exit: the sign drives out of the picture on the right at about 2.4 s and comes back at about 5.4 s (no look-alike, no pole)."""
import json, math, os, subprocess, sys
import numpy as np
from PIL import Image
import importlib.util
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("mpf", os.path.join(HERE, "make-plate-fixtures.py"))
mpf = importlib.util.module_from_spec(spec); spec.loader.exec_module(mpf)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
EXIT = "--exit" in sys.argv
OUT = ARGS[0] if ARGS else ("/tmp/track-footage-exit" if EXIT else "/tmp/track-footage")
STAMP = "2026-10-20_09-00-00"
W, H, FPS, SEC = 1280, 960, 24, 8
BASE_W = 0.12                      # sign width at t = 0, share of the frame
ASPECT = 0.5                       # plate texture is 2:1

def sign_box(t):
    s = 1 + 0.07 * t
    w = BASE_W * s; h = w * ASPECT * W / H
    if EXIT:
        cx = 0.55 + 0.25 * t if t < 3.5 else 1.425 - 0.25 * (t - 3.5)   # out on the right from about 2.4 s, back in from about 5 s
    else:
        cx = 0.12 + 0.055 * t + 0.004 * t * t
    cy = 0.50 + 0.035 * math.sin(0.9 * t)
    return cx - w / 2, cy - h / 2, w, h

POLE_T, POLE_HALF = 4.3, 0.022     # the pole stands where the sign is at POLE_T

def main():
    d = os.path.join(OUT, "TeslaCam", "SavedClips", STAMP)
    os.makedirs(d, exist_ok=True)
    tex = mpf.plate_img("7TRK321", 600).convert("RGB")
    bg = Image.open(os.path.join(mpf.STILLS, "front.jpg")).convert("RGB").resize((W, H), Image.BICUBIC)
    bgn = np.asarray(bg, dtype=np.float32)
    px, _, pw, _ = sign_box(POLE_T); pole_x = px + pw / 2
    rng = np.random.default_rng(7); truth = []
    dst = os.path.join(d, STAMP + "-front.mp4")
    ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H), "-r", str(FPS), "-i", "-",
                           "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", dst], stdin=subprocess.PIPE)
    for f in range(FPS * SEC):
        t = f / FPS
        im = bg.copy()
        x, y, w, h = sign_box(t)
        sz = (max(8, int(round(w * W))), max(4, int(round(h * H))))
        sign = tex.resize(sz, Image.LANCZOS)
        if x < 1 and x + w > 0: im.paste(sign, (int(round(x * W)), int(round(y * H))))
        if not EXIT: im.paste(sign, (int(round((x - 0.24) * W)), int(round((y + 0.02) * H))))          # the look-alike, trailing by a fixed distance
        a = np.asarray(im, dtype=np.float32)
        x0, x1 = int((pole_x - POLE_HALF) * W), int((pole_x + POLE_HALF) * W)             # the pole
        if not EXIT: a[:, x0:x1, :] = np.array([58, 56, 52], dtype=np.float32)
        a *= 0.92 + 0.16 * (t / SEC)                                                       # light drifts up
        a += rng.normal(0, 3.0, a.shape).astype(np.float32)                                # sensor noise
        ff.stdin.write(np.clip(a, 0, 255).astype(np.uint8).tobytes())
        truth.append({"t": round(t, 4), "x": x, "y": y, "w": w, "h": h})
    ff.stdin.close(); ff.wait()
    for cam in ("back", "left_repeater", "right_repeater"):
        png = os.path.join(OUT, cam + ".png")
        Image.open(os.path.join(mpf.STILLS, cam + ".jpg")).convert("RGB").resize((W, H), Image.BICUBIC).save(png)
        subprocess.check_call(["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-framerate", str(FPS), "-i", png, "-t", str(SEC), "-c:v", "libx264", "-preset", "veryfast",
                               "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", os.path.join(d, STAMP + "-" + cam + ".mp4")])
        os.remove(png)
    with open(os.path.join(d, "event.json"), "w") as fh:
        json.dump({"timestamp": "2026-10-20T09:00:00", "city": "Sampleville", "est_lat": "0", "est_lon": "0", "reason": "user_interaction_honk", "camera": "0"}, fh)
    with open(os.path.join(OUT, "track-truth.json"), "w") as fh:
        json.dump({"fps": FPS, "sec": SEC, "pole": {"x": pole_x, "half": POLE_HALF, "t": POLE_T}, "frames": truth}, fh)
    print(d)

if __name__ == "__main__":
    main()
