#!/usr/bin/env python3
"""make-curved-plate-footage.py — a short synthetic TeslaCam event for test/custom-redact.js: the REAR camera shows a made-up
plate that is CURVED (bowed and squeezed towards its ends, like a plate near the edge of a fisheye lens), left of centre so a
mirrored tile puts it on the other side; the front camera shows a flat made-up plate. The plate numbers are invented. No real
footage, no real plates. Needs ffmpeg and Pillow.
Usage: python3 tools/make-curved-plate-footage.py [out_dir]     (default /tmp/curved-plate)
Writes out_dir/TeslaCam/SavedClips/<stamp>/ and out_dir/curved-truth.json (the plate's box + outline, 0..1 of the raw frame)."""
import json, os, subprocess, sys
from PIL import Image, ImageFilter
import importlib.util
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("mpf", os.path.join(HERE, "make-plate-fixtures.py"))
mpf = importlib.util.module_from_spec(spec); spec.loader.exec_module(mpf)

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/curved-plate"
STAMP = "2026-10-20_09-00-00"
W, H, FPS, SEC = 1280, 960, 24, 6
SAG, SQUEEZE = 0.20, 0.30        # bow (fraction of the plate height) and edge squeeze

def curve(plate):
    """Bow the plate (ends droop) and squeeze it towards its ends; returns (RGBA image, outline points in its own pixels)."""
    w, h = plate.size
    pad = int(h * SAG) + 4
    out = Image.new("RGBA", (w, h + pad), (0, 0, 0, 0))
    src = plate.convert("RGBA")
    # source column for each output column: dense in the middle, stretched at the ends (a wider piece of the plate is squeezed in)
    for xo in range(w):
        u = (xo / (w - 1)) * 2 - 1                       # -1..1
        us = u * (1 + SQUEEZE * u * u) / (1 + SQUEEZE)   # the plate coordinate shown at this output column
        xs = min(w - 1, max(0, int(round((us + 1) / 2 * (w - 1)))))
        dy = int(round(h * SAG * u * u))                 # the ends droop
        out.paste(src.crop((xs, 0, xs + 1, h)), (xo, dy))
    top = [(x, int(round(h * SAG * (((x / (w - 1)) * 2 - 1) ** 2)))) for x in range(0, w, w // 12)] + [(w - 1, int(round(h * SAG)))]
    bot = [(x, y + h - 1) for x, y in top]
    return out, top + bot[::-1]

def scene(cam):
    base = Image.open(os.path.join(mpf.STILLS, {"front": "front.jpg", "back": "back.jpg"}.get(cam, cam + ".jpg"))).convert("RGB").resize((W, H), Image.BICUBIC)
    truth = None
    if cam == "back":
        pw = 600; plate = mpf.plate_img("7TST123", pw)
        cur, outline = curve(plate)
        s = 200 / pw; sz = (int(cur.width * s), int(cur.height * s))
        small = cur.resize(sz, Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.6))
        x0, y0 = int(0.20 * W), int(0.56 * H)
        base.paste(small, (x0, y0), small)
        pts = [((x0 + x * s) / W, (y0 + y * s) / H) for x, y in outline]
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        truth = {"text": "7TST123", "box": {"x": min(xs), "y": min(ys), "w": max(xs) - min(xs), "h": max(ys) - min(ys)}, "outline": [c for p in pts for c in p]}
    elif cam == "front":
        plate = mpf.plate_img("7FLT456", 600).resize((170, 85), Image.LANCZOS)
        x0, y0 = int(0.62 * W), int(0.50 * H)
        base.paste(plate, (x0, y0))
        truth = {"text": "7FLT456", "box": {"x": x0 / W, "y": y0 / H, "w": 170 / W, "h": 85 / H}}
    return base, truth

def main():
    d = os.path.join(OUT, "TeslaCam", "SavedClips", STAMP)
    os.makedirs(d, exist_ok=True); truth = {}
    for cam in ("front", "back", "left_repeater", "right_repeater"):
        img, t = scene(cam)
        if t: truth[cam] = t
        png = os.path.join(OUT, cam + ".png"); img.save(png)
        subprocess.check_call(["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-framerate", str(FPS), "-i", png, "-t", str(SEC), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                               "-pix_fmt", "yuv420p", "-movflags", "+faststart", os.path.join(d, STAMP + "-" + cam + ".mp4")])
        os.remove(png)
    with open(os.path.join(d, "event.json"), "w") as f:
        json.dump({"timestamp": "2026-10-20T09:00:00", "city": "Sampleville", "est_lat": "0", "est_lon": "0", "reason": "user_interaction_honk", "camera": "0"}, f)
    with open(os.path.join(OUT, "curved-truth.json"), "w") as f: json.dump(truth, f)
    print(d)

if __name__ == "__main__":
    main()
