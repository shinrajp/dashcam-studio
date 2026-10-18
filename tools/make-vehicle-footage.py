#!/usr/bin/env python3
"""make-vehicle-footage.py — a short synthetic TeslaCam event for the Vehicle details (beta) end-to-end test.
Public-domain / CC0 vehicle photos (tools/fetch-vehicle-fixtures.py) are pasted onto the synthetic mock stills:
front 0–2.6 s red double-decker tour bus, 2.6–5.3 s city transit bus, 5.3–8 s white police car;
back 0–4 s ambulance, 4–8 s fire truck. Written to /tmp (not stored in the repo).
Usage: python3 tools/make-vehicle-footage.py [out_dir] [fixtures_dir]   — needs ffmpeg + Pillow."""
import json, os, subprocess, sys
from PIL import Image, ImageFilter
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/vehicle-samples"
FX = sys.argv[2] if len(sys.argv) > 2 else "/tmp/vehicle-fixtures"
if not os.path.exists(os.path.join(FX, "meta.json")):
    subprocess.check_call([sys.executable, os.path.join(HERE, "fetch-vehicle-fixtures.py"), FX])
STAMP = "2026-10-17_15-30-00"
W, H, FPS, SEC = 1280, 960, 24, 8
STILLS = os.path.join(HERE, "mock-stills")

def anonymize(im):
    """Blur licence plates in the photos (repo plate detector, onnxruntime if installed) so no real plate shows up in screenshots."""
    try:
        import numpy as np, onnxruntime as ort
    except Exception:
        print("note: onnxruntime/numpy missing, plates in the photos are not blurred"); return im
    s = ort.InferenceSession(os.path.join(HERE, "..", "models", "plates", "yolo-v9-t-640-license-plates-end2end.onnx"))
    w, h = im.size; sc = 640 / max(w, h)
    c = Image.new("RGB", (640, 640), (114, 114, 114)); c.paste(im.resize((int(w * sc), int(h * sc))), (0, 0))
    x = (np.asarray(c).astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
    out = im.copy()
    for r in s.run(None, {s.get_inputs()[0].name: x})[0]:
        if r[6] < 0.05: continue
        x1, y1, x2, y2 = [v / sc for v in r[1:5]]; mw, mh = (x2 - x1) * 0.3, (y2 - y1) * 0.4
        box = tuple(int(v) for v in (max(0, x1 - mw), max(0, y1 - mh), min(w, x2 + mw), min(h, y2 + mh)))
        if box[2] > box[0] and box[3] > box[1]: out.paste(out.crop(box).filter(ImageFilter.GaussianBlur(8)), box[:2])
    return out

def scene(still, parts):
    base = Image.open(os.path.join(STILLS, still)).convert("RGB").resize((W, int(W * 720 / 1280)))
    canvas = Image.new("RGB", (W, H)); truth = []
    photos = {k: anonymize(Image.open(os.path.join(FX, k + ".jpg")).convert("RGB")) for k, _, _ in parts}
    for i in range(FPS * SEC):
        t = i / FPS
        img = base.copy()
        for key, (a, b), info in parts:
            if not (a <= t < b): continue
            u = (t - a) / (b - a)
            ph = photos[key]; pw = int(W * (0.42 + 0.12 * u)); phh = int(ph.height * pw / ph.width)
            x, y = int(W * 0.5 - pw / 2 + 40 * (u - 0.5)), int(img.height * 0.55 - phh / 2)
            img.paste(ph.resize((pw, phh)).filter(ImageFilter.GaussianBlur(0.5)), (x, y))
            if i % 6 == 0: truth.append({"t": t, "key": key, **info})
        canvas.paste(img, (0, (H - img.height) // 2))
        yield canvas, truth

def encode(gen, path):
    p = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H), "-r", str(FPS), "-i", "-",
                          "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path], stdin=subprocess.PIPE)
    truth = []
    for im, tr in gen: p.stdin.write(im.tobytes()); truth = tr
    p.stdin.close(); p.wait()
    return truth

FRONT = [("tour-bus-3", (0, 2.6), {"type": "tour bus", "color": "red"}), ("city-bus-8", (2.6, 5.3), {"type": "city bus"}), ("police-3", (5.3, 8.1), {"type": "police car", "color": "white"})]
BACK = [("ambulance-1", (0, 4), {"type": "ambulance", "color": "white"}), ("fire-1", (4, 8.1), {"type": "fire truck", "color": "red"})]

def main():
    d = os.path.join(OUT, "TeslaCam", "SavedClips", STAMP)
    os.makedirs(d, exist_ok=True)
    tf = encode(scene("front.jpg", FRONT), os.path.join(d, STAMP + "-front.mp4"))
    tb = encode(scene("back.jpg", BACK), os.path.join(d, STAMP + "-back.mp4"))
    with open(os.path.join(d, "event.json"), "w") as f:
        json.dump({"timestamp": "2026-10-17T15:30:00", "city": "Sampleville", "est_lat": "0", "est_lon": "0", "reason": "user_interaction_honk", "camera": "0"}, f)
    with open(os.path.join(OUT, "vehicle-truth.json"), "w") as f:
        json.dump({"front": FRONT, "back": BACK}, f)
    print(d)

if __name__ == "__main__":
    main()
