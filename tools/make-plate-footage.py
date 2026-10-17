#!/usr/bin/env python3
"""make-plate-footage.py — a short synthetic TeslaCam event with made-up California-style plates, for the
Phase 6 end-to-end test (search → gold box → blur in export). Built from tools/mock-stills + the plate
renderer in make-plate-fixtures.py. No real footage, no real plates.
Usage: python3 tools/make-plate-footage.py [out_dir]   (default /tmp/plate-samples) — needs ffmpeg."""
import json, os, subprocess, sys
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util
spec = importlib.util.spec_from_file_location("mpf", os.path.join(os.path.dirname(os.path.abspath(__file__)), "make-plate-fixtures.py"))
mpf = importlib.util.module_from_spec(spec); spec.loader.exec_module(mpf)

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/plate-samples"
STAMP = "2026-10-16_12-00-00"
W, H, FPS, SEC = 1280, 960, 24, 8

def frames_front():
    base = Image.open(os.path.join(mpf.STILLS, "front.jpg")).convert("RGB").resize((W, int(W * 720 / 1280)))
    canvas = Image.new("RGB", (W, H)); plate = mpf.plate_img("7TST123")
    truth = []
    for i in range(FPS * SEC):
        u = i / (FPS * SEC - 1)
        z = 1.8 + 1.6 * u            # the car gets closer
        img, (x0, y0) = mpf.zoomed(base, 651, 430, z)
        cx, cy = (651 - x0) * z, (441 - y0) * z
        box = mpf.place(img, plate, cx, cy, int(23 * z), blur=0.6)
        canvas.paste(img, (0, (H - img.height) // 2))
        yield canvas, {"t": i / FPS, "box": {"x": box["x"], "y": (box["y"] * img.height + (H - img.height) / 2) / H, "w": box["w"], "h": box["h"] * img.height / H}}

def frames_back():
    base = Image.open(os.path.join(mpf.STILLS, "left_pillar_plate.jpg")).convert("RGB").resize((W, int(W * 720 / 1280)))
    canvas = Image.new("RGB", (W, H)); plate = mpf.plate_img("5SMP260")
    for i in range(FPS * SEC):
        u = i / (FPS * SEC - 1)
        img, (x0, y0) = mpf.zoomed(base, 360 - 40 * u, 340, 2.0)
        mpf.place(img, plate, (329 - x0) * 2, (398 - y0) * 2, 52, blur=0.8)
        canvas.paste(img, (0, (H - img.height) // 2))
        yield canvas, None

def encode(gen, path):
    p = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H), "-r", str(FPS), "-i", "-",
                          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path], stdin=subprocess.PIPE)
    truth = []
    for im, t in gen:
        p.stdin.write(im.tobytes())
        if t: truth.append(t)
    p.stdin.close(); p.wait()
    return truth

def main():
    d = os.path.join(OUT, "TeslaCam", "SavedClips", STAMP)
    os.makedirs(d, exist_ok=True)
    truth = encode(frames_front(), os.path.join(d, STAMP + "-front.mp4"))
    encode(frames_back(), os.path.join(d, STAMP + "-back.mp4"))
    with open(os.path.join(d, "event.json"), "w") as f:
        json.dump({"timestamp": STAMP.replace("_", "T").replace("-", ":")[:10].replace(":", "-") + "T12:00:00", "city": "Sampleville", "est_lat": "0", "est_lon": "0", "reason": "user_interaction_honk", "camera": "0"}, f)
    with open(os.path.join(OUT, "plate-truth.json"), "w") as f:
        json.dump({"front": {"text": "7TST123", "frames": truth}, "back": {"text": "5SMP260"}}, f)
    print(d)

if __name__ == "__main__":
    main()
