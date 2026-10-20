#!/usr/bin/env python3
"""make-wbcolor-footage.py — synthetic night event for the vehicle-colour-after-white-balance test (test/wb-color.js).
Front camera: the mock street at night under a warm ~3000 K streetlight cast (make-wb-footage.py's light), with
public-domain / CC0 vehicle photos (tools/fetch-vehicle-fixtures.py, plates blurred) lit by that same light:
  0–2 s white tour bus (tour-bus-1), 2–4 s red car (civic-1), 4–6 s blue bus (tour-bus-2), 6–8 s brown car (camry-brown).
Left + right repeater: make-wb-footage.py's mirror cameras (moving scene, dim white car body along the OUTER edge).
DAY=1 → the same vehicles without the cast (daylight reference). NOPAINT=1 → no car body in the mirrors (no white point).
Writes to /tmp (not stored in the repo).   Usage: [DAY=1] [NOPAINT=1] python3 tools/make-wbcolor-footage.py /tmp/wbcolor-samples"""
import json, os, sys, subprocess, importlib.util
import numpy as np
from PIL import Image, ImageFilter
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/wbcolor-samples"
FX = sys.argv[2] if len(sys.argv) > 2 else "/tmp/vehicle-fixtures"
DAY = os.environ.get("DAY") == "1"
def load(name, file):
    argv = sys.argv; sys.argv = [file, "/tmp/_unused"]
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, file)); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    sys.argv = argv; return m
wb = load("wbf", "make-wb-footage.py")
vf = load("vf", "make-vehicle-footage.py")
if not os.path.exists(os.path.join(FX, "meta.json")): subprocess.check_call([sys.executable, os.path.join(HERE, "fetch-vehicle-fixtures.py"), FX])
W, H, FPS, SEC = wb.W, wb.H, wb.FPS, wb.SEC
STAMP = "2026-10-20_22-00-00" if not DAY else "2026-10-20_12-00-00"
VEH = [("tour-bus-1", (0, 2), "white"), ("civic-1", (2, 4), "red"), ("tour-bus-2", (4, 6), "blue"), ("camry-brown", (6, 8.1), "brown")]
SCENE, LIT = 0.10, 0.55   # linear exposure: the street (dark) and the vehicles in the streetlight

def front():
    base = wb.to_lin(np.asarray(Image.open(os.path.join(HERE, "mock-stills", "front.jpg")).convert("RGB").resize((W, H)), dtype=np.float64))
    photos = {k: vf.anonymize(Image.open(os.path.join(FX, k + ".jpg")).convert("RGB")) for k, _, _ in VEH}
    cast = np.ones(3) if DAY else wb.CAST
    for i in range(FPS * SEC):
        t = i / FPS
        img = base * (1.0 if DAY else SCENE)
        for key, (a, b), _ in VEH:
            if not (a <= t < b): continue
            u = (t - a) / (b - a); ph = photos[key]
            pw = int(W * (0.62 + 0.06 * u)); phh = int(ph.height * pw / ph.width)
            x, y = int(W * 0.5 - pw / 2 + 30 * (u - 0.5)), int(H * 0.56 - phh / 2)
            p = wb.to_lin(np.asarray(ph.resize((pw, phh)).filter(ImageFilter.GaussianBlur(0.5)), dtype=np.float64)) * (1.0 if DAY else LIT)
            y0, x0 = max(0, y), max(0, x); y1, x1 = min(H, y + phh), min(W, x + pw)
            img = img.copy(); img[y0:y1, x0:x1] = p[y0 - y:y1 - y, x0 - x:x1 - x]
        yield wb.to_srgb(img * cast[None, None, :]).round().astype(np.uint8)

def encode_front(path):
    p = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H), "-r", str(FPS), "-i", "-",
                          "-vf", "scale=out_color_matrix=bt709:out_range=tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
                          "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path], stdin=subprocess.PIPE)
    for im in front(): p.stdin.write(im.tobytes())
    p.stdin.close(); p.wait()

def main():
    d = os.path.join(OUT, "TeslaCam", "SavedClips", STAMP); os.makedirs(d, exist_ok=True)
    encode_front(os.path.join(d, STAMP + "-front.mp4"))
    if not DAY:
        for cam in ("left_repeater", "right_repeater"): wb.encode(cam, os.path.join(d, STAMP + "-" + cam + ".mp4"))
    with open(os.path.join(d, "event.json"), "w") as f:
        json.dump({"timestamp": STAMP[:10] + "T" + STAMP[11:].replace("-", ":"), "city": "Sampleville", "est_lat": "0", "est_lon": "0", "reason": "user_interaction_honk", "camera": "0"}, f)
    with open(os.path.join(OUT, "truth.json"), "w") as f: json.dump({"cct": wb.CCT, "day": DAY, "paint": not wb.NOPAINT, "vehicles": VEH}, f)
    print(d)

if __name__ == "__main__": main()
