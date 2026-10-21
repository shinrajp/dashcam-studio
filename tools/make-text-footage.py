#!/usr/bin/env python3
"""make-text-footage.py — synthetic TeslaCam events with made-up text, for the text search / redaction tests
(test/text-redact.js, test/time-search.js). No real footage, no real places: every word below is invented.
  day   event  2026-10-16_14-20-00  six cameras, 10 s
  night event  2026-10-16_20-53-40  six cameras, 10 s (dark, warm light, sensor noise)
  long  event  2026-10-16_20-51-31  front + back, three 60 s clips, tiny (for time search across clips)
Text types: street sign (small, approaching), business sign (perspective), truck side (moving, motion blur),
house number (low contrast, angled), small rotated sign, perspective sign, low-contrast grey sign, and the burned-in
Tesla-style timestamp at the top right of the front camera. Ground truth (per camera, per frame, normalised boxes) goes
to <out>/text-truth.json.  Usage: python3 tools/make-text-footage.py [out_dir]  (default /tmp/text-samples) — needs ffmpeg."""
import json, os, subprocess, sys, datetime, math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STILLS = os.path.join(ROOT, "tools", "mock-stills")
SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/text-samples"
W, H, FPS, SEC = 1280, 960, 24, 10
CAMS = ["front", "back", "left_repeater", "right_repeater", "left_pillar", "right_pillar"]

# id, cam, text, kind, fg, bg, path(u) -> (cx, cy, text height px, rotation deg, skew), visible (u0,u1), extra
def lerp(a, b, u): return a + (b - a) * u
ITEMS = [
  dict(id="street", cam="front", text="QUILLBY AVE", kind="street sign", fg=(245, 245, 245), bg=(20, 110, 60),
       path=lambda u: (lerp(330, 180, u), lerp(250, 200, u), lerp(11, 26, u), 0, 0.10), vis=(0.0, 1.0)),
  dict(id="business", cam="front", text="ZENDER BAKERY", kind="business sign", fg=(250, 230, 120), bg=(120, 30, 30),
       path=lambda u: (lerp(900, 1060, u), lerp(330, 300, u), lerp(14, 30, u), 0, -0.35), vis=(0.0, 1.0)),
  dict(id="truck", cam="left_repeater", text="NORTHWIND FREIGHT", kind="truck side", fg=(30, 60, 150), bg=(235, 235, 235),
       path=lambda u: (lerp(1100, 150, u), 470, 56, 0, 0.0), vis=(0.0, 1.0), blur=10),
  dict(id="house", cam="right_repeater", text="4821", kind="house number", fg=(150, 120, 80), bg=(205, 190, 160),
       path=lambda u: (lerp(820, 380, u), 360, 24, 6, 0.0), vis=(0.0, 1.0)),
  dict(id="small", cam="back", text="PELLO CAFE", kind="small rotated sign", fg=(255, 255, 255), bg=(30, 30, 30),
       path=lambda u: (lerp(560, 610, u), lerp(390, 410, u), lerp(17, 11, u), -8, 0.0), vis=(0.0, 1.0)),
  dict(id="persp", cam="left_pillar", text="VARNEY ST", kind="perspective street sign", fg=(245, 245, 245), bg=(20, 110, 60),
       path=lambda u: (lerp(700, 560, u), 300, lerp(18, 24, u), 0, 0.55), vis=(0.0, 1.0)),
  dict(id="lowc", cam="right_pillar", text="ORBIT CYCLES", kind="low-contrast sign", fg=(150, 150, 150), bg=(118, 118, 118),
       path=lambda u: (lerp(640, 700, u), 330, 22, 3, 0.0), vis=(0.0, 1.0)),
]

def text_patch(text, hpx, fg, bg, scale=4):
    """Sign: text on a coloured panel, rendered big then reduced (anti-aliased)."""
    f = ImageFont.truetype(SANS, int(hpx * scale))
    tw = f.getlength(text); a, d = f.getmetrics()
    pad = int(hpx * scale * 0.35)
    im = Image.new("RGBA", (int(tw) + 2 * pad, a + d + pad), bg + (255,))
    ImageDraw.Draw(im).text((pad, pad // 2), text, font=f, fill=fg + (255,))
    return im

def warp(im, rot, skew):
    """rotation (deg) + horizontal perspective (skew: one side taller than the other)."""
    w, h = im.size
    if skew:
        k = abs(skew); big = int(h * (1 + k)); out = Image.new("RGBA", (w, big), (0, 0, 0, 0))
        # map target quad → source: left edge height h*(1+k) vs right edge h (or mirrored)
        src = im
        coeffs = find_coeffs([(0, 0), (w, (big - h) / 2), (w, (big + h) / 2), (0, big)] if skew > 0 else [(0, (big - h) / 2), (w, 0), (w, big), (0, (big + h) / 2)],
                             [(0, 0), (w, 0), (w, h), (0, h)])
        im = src.transform((w, big), Image.PERSPECTIVE, coeffs, Image.BICUBIC)
    if rot: im = im.rotate(rot, resample=Image.BICUBIC, expand=True)
    return im

def find_coeffs(pa, pb):
    m = []
    for p1, p2 in zip(pa, pb):
        m.append([p1[0], p1[1], 1, 0, 0, 0, -p2[0] * p1[0], -p2[0] * p1[1]])
        m.append([0, 0, 0, p1[0], p1[1], 1, -p2[1] * p1[0], -p2[1] * p1[1]])
    A = np.array(m, dtype=float); B = np.array([c for p in pb for c in p], dtype=float)
    return np.linalg.lstsq(A, B, rcond=None)[0].tolist()

def hblur(im, n):
    a = np.asarray(im).astype(np.float32); acc = np.zeros_like(a)
    for k in range(n): acc += np.roll(a, k - n // 2, axis=1)
    return Image.fromarray((acc / n).astype(np.uint8), im.mode)

def base_for(cam, night):
    b = Image.open(os.path.join(STILLS, cam + ".jpg")).convert("RGB").resize((W, H))
    if night:
        a = np.asarray(b).astype(np.float32) / 255.0
        a = (a ** 1.8) * 0.33
        a = a * np.array([1.0, 0.78, 0.5])     # warm streetlight
        b = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))
    return b

def stamp_patch(s):
    f = ImageFont.truetype(SANS, 22); tw = int(f.getlength(s)) + 16
    im = Image.new("RGBA", (tw, 34), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.text((9, 6), s, font=f, fill=(0, 0, 0, 200)); d.text((8, 5), s, font=f, fill=(255, 255, 255, 255))
    return im

def render(cam, night, start, rng):
    base = base_for(cam, night); truth = []
    items = [it for it in ITEMS if it["cam"] == cam]
    for i in range(FPS * SEC):
        u = i / (FPS * SEC - 1); t = i / FPS
        dx = int(3 * math.sin(t * 2.1)); img = base.transform(base.size, Image.AFFINE, (1, 0, dx, 0, 1, 0), Image.BILINEAR)
        rows = []
        for it in items:
            if not (it["vis"][0] <= u <= it["vis"][1]): continue
            cx, cy, hpx, rot, skew = it["path"](u)
            fg, bg = it["fg"], it["bg"]
            if night:
                dim = 0.55 if it["id"] in ("street", "persp") else 0.75 if it["id"] in ("business",) else 0.32
                fg = tuple(int(c * dim) for c in fg); bg = tuple(int(c * dim * 0.8) for c in bg)
            p = text_patch(it["text"], 40, fg, bg)
            s = hpx / 160.0; p = p.resize((max(4, int(p.width * s)), max(4, int(p.height * s))), Image.LANCZOS)
            p = warp(p, rot, skew)
            if it.get("blur"): p = hblur(p, it["blur"])
            x0, y0 = int(cx - p.width / 2), int(cy - p.height / 2)
            img.paste(p, (x0, y0), p)
            bx0, by0, bx1, by1 = max(0, x0), max(0, y0), min(W, x0 + p.width), min(H, y0 + p.height)
            if bx1 - bx0 > 4 and by1 - by0 > 3:
                rows.append({"id": it["id"], "box": [round(bx0 / W, 4), round(by0 / H, 4), round((bx1 - bx0) / W, 4), round((by1 - by0) / H, 4)], "full": x0 >= 0 and x0 + p.width <= W})
        if cam == "front":
            s = (start + datetime.timedelta(seconds=int(t))).strftime("%Y-%m-%d %H:%M:%S")
            sp = stamp_patch(s); x0, y0 = W - sp.width - 12, 10; img.paste(sp, (x0, y0), sp)
            rows.append({"id": "stamp", "text": s, "box": [round(x0 / W, 4), round(y0 / H, 4), round(sp.width / W, 4), round(sp.height / H, 4)], "full": True})
        if night:
            a = np.asarray(img).astype(np.float32) + rng.normal(0, 5, (H, W, 1)).astype(np.float32)
            img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
        truth.append({"t": round(t, 4), "items": rows})
        yield img, truth

def encode(gen, path, w=W, h=H, fps=FPS):
    p = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (w, h), "-r", str(fps), "-i", "-",
                          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path], stdin=subprocess.PIPE)
    last = None
    for im, tr in gen: p.stdin.write(im.tobytes()); last = tr
    p.stdin.close(); p.wait()
    return last

def event_json(d, stamp):
    dt = datetime.datetime.strptime(stamp, "%Y-%m-%d_%H-%M-%S")
    with open(os.path.join(d, "event.json"), "w") as f:
        json.dump({"timestamp": dt.strftime("%Y-%m-%dT%H:%M:%S"), "city": "Sampleville", "est_lat": "0", "est_lon": "0", "reason": "user_interaction_honk", "camera": "0"}, f)

def main():
    truth = {"items": {it["id"]: {"text": it["text"], "kind": it["kind"], "cam": it["cam"]} for it in ITEMS}, "events": {}}
    truth["items"]["stamp"] = {"text": "(clock)", "kind": "burned-in timestamp", "cam": "front"}
    for name, stamp, night in (("day", "2026-10-16_14-20-00", False), ("night", "2026-10-16_20-53-40", True)):
        d = os.path.join(OUT, name, "TeslaCam", "SavedClips", stamp); os.makedirs(d, exist_ok=True)
        start = datetime.datetime.strptime(stamp, "%Y-%m-%d_%H-%M-%S"); ev = {}
        for cam in CAMS:
            rng = np.random.default_rng(7)
            ev[cam] = encode(render(cam, night, start, rng), os.path.join(d, stamp + "-" + cam + ".mp4"))
        event_json(d, stamp); truth["events"][name] = {"stamp": stamp, "fps": FPS, "frames": ev}
        print(d)
    # long event for time search: three 60 s clips, tiny, front + back
    stamp0 = datetime.datetime(2026, 10, 16, 20, 51, 31)
    d = os.path.join(OUT, "long", "TeslaCam", "SavedClips", stamp0.strftime("%Y-%m-%d_%H-%M-%S")); os.makedirs(d, exist_ok=True)
    for k in range(3):
        st = (stamp0 + datetime.timedelta(seconds=60 * k)).strftime("%Y-%m-%d_%H-%M-%S")
        for cam in ("front", "back"):
            path = os.path.join(d, st + "-" + cam + ".mp4")
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10:duration=60", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path], check=True)
    event_json(d, stamp0.strftime("%Y-%m-%d_%H-%M-%S")); print(d)
    with open(os.path.join(OUT, "text-truth.json"), "w") as f: json.dump(truth, f)

if __name__ == "__main__":
    main()
