#!/usr/bin/env python3
"""make-moving-footage.py — synthetic TeslaCam event with ONE object moving steadily across the front camera, for the
burn-in parity test (test/burn-parity.js). A public-domain city-bus photo (tools/fetch-vehicle-fixtures.py, plates blurred)
is cropped to the bus and slides from left to right over 8 s on the front mock still; the back camera has no vehicle.
Writes /tmp/moving-samples/TeslaCam/SavedClips/2026-10-19_12-00-00 and truth.json (the bus box per frame, normalised).
Usage: python3 tools/make-moving-footage.py [out_dir] [fixtures_dir]   — needs ffmpeg + Pillow (+ onnxruntime for the plate blur).
Long variant (test/bus-detect.js):  LONG=3 BUS_CAM=back BUS_AT=75 python3 tools/make-moving-footage.py /tmp/long-samples
  → three 60 s clips (front + back), the bus passes on the BACK camera from 75 s to 83 s of the event and nowhere else."""
import json, os, sys, importlib.util
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("vf", os.path.join(HERE, "make-vehicle-footage.py")); vf = importlib.util.module_from_spec(spec)
sys.argv = sys.argv[:1] + sys.argv[1:]; spec.loader.exec_module(vf)
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/moving-samples"
FX = sys.argv[2] if len(sys.argv) > 2 else "/tmp/vehicle-fixtures"
STAMP = "2026-10-19_12-00-00"
W, H, FPS, SEC = 1280, 960, 24, 8
CROP = (0.20, 0.378, 0.72, 0.748)   # city-bus-8: the bus itself (YOLO11 box on the photo)

LONG = int(os.environ.get("LONG", "0")); BUS_CAM = os.environ.get("BUS_CAM", "front"); BUS_AT = float(os.environ.get("BUS_AT", "0"))

def frames(still, moving, n=None, t0=0.0):
    base = Image.open(os.path.join(vf.STILLS, still)).convert("RGB").resize((W, int(W * 720 / 1280)))
    top = (H - base.height) // 2
    bus = None
    if moving:
        ph = vf.anonymize(Image.open(os.path.join(FX, "city-bus-8.jpg")).convert("RGB"))
        pw, phh = ph.size
        bus = ph.crop((int(CROP[0] * pw), int(CROP[1] * phh), int(CROP[2] * pw), int(CROP[3] * phh)))
        bw = int(W * 0.30); bh = int(bus.height * bw / bus.width); bus = bus.resize((bw, bh))
    truth = []
    for i in range(n if n is not None else FPS * SEC):
        t = t0 + i / FPS - BUS_AT
        img = base.copy()
        if bus is not None and 0 <= t < SEC:
            u = t / SEC
            x = int(W * (0.04 + 0.56 * u)); y = int(base.height * 0.56 - bus.height / 2)
            img.paste(bus, (x, y))
            truth.append({"t": round(t + BUS_AT, 4), "x": x / W, "y": (y + top) / H, "w": bus.width / W, "h": bus.height / H})
        canvas = Image.new("RGB", (W, H)); canvas.paste(img, (0, top))
        yield canvas, truth

def main_long():
    vf.W, vf.H, vf.FPS = W, H, FPS
    truth = {}
    for k in range(LONG):
        stamp = "2026-10-19_12-%02d-00" % k
        d = os.path.join(OUT, "TeslaCam", "SavedClips", STAMP); os.makedirs(d, exist_ok=True)
        for cam in ("front", "back"):
            tr = vf.encode(frames(cam + ".jpg", cam == BUS_CAM, 60 * FPS, 60.0 * k), os.path.join(d, stamp + "-" + cam + ".mp4"))
            if cam == BUS_CAM: truth.setdefault(cam, []).extend(tr)
    with open(os.path.join(d, "event.json"), "w") as f:
        json.dump({"timestamp": "2026-10-19T12:%02d:00" % (LONG - 1), "city": "Sampleville", "est_lat": "0", "est_lon": "0", "reason": "user_interaction_honk", "camera": "0"}, f)
    with open(os.path.join(OUT, "truth.json"), "w") as f: json.dump({"fps": FPS, "bus_cam": BUS_CAM, "bus_at": BUS_AT, "sec": SEC, **truth}, f)
    print(d)

def main():
    if LONG: return main_long()
    d = os.path.join(OUT, "TeslaCam", "SavedClips", STAMP); os.makedirs(d, exist_ok=True)
    vf.W, vf.H, vf.FPS = W, H, FPS
    truth = vf.encode(frames("front.jpg", True), os.path.join(d, STAMP + "-front.mp4"))
    vf.encode(frames("back.jpg", False), os.path.join(d, STAMP + "-back.mp4"))
    with open(os.path.join(d, "event.json"), "w") as f:
        json.dump({"timestamp": "2026-10-19T12:00:00", "city": "Sampleville", "est_lat": "0", "est_lon": "0", "reason": "user_interaction_honk", "camera": "0"}, f)
    with open(os.path.join(OUT, "truth.json"), "w") as f: json.dump({"fps": FPS, "front": truth}, f)
    print(d)

if __name__ == "__main__":
    main()
