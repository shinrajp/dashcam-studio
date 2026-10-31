#!/usr/bin/env python3
"""track-real-draw.py — contact sheet of a tools/track-real.js run: frames every `step` seconds with the tracked box drawn (green = matched,
cyan = optical flow, yellow = coasting, no box = blur off). Usage: python3 tools/track-real-draw.py run.json out.png [step=1.0] [t0] [t1] [crop x,y,w,h]"""
import json, subprocess, sys
from PIL import Image, ImageDraw
run = json.load(open(sys.argv[1])); out = sys.argv[2]
step = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
t0 = float(sys.argv[4]) if len(sys.argv) > 4 else 0; t1 = float(sys.argv[5]) if len(sys.argv) > 5 else 1e9
crop = [float(v) for v in sys.argv[6].split(",")] if len(sys.argv) > 6 else None
FW, FH = run["FW"], run["FH"]
rows = [r for r in run["rows"] if t0 - 1e-6 <= r["t"] <= t1]
picks, nxt = [], t0
for r in rows:
    if r["t"] >= nxt - 1e-6: picks.append(r); nxt = r["t"] + step
col = {"ok": "#3fdc5a", "start": "#ffffff", "flow": "#3fd0ff", "part": "#9a6bff", "coast": "#ffd23f", "found": "#ff7ad9"}
tiles = []
for r in picks[:24]:
    png = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", str(r["t"]), "-i", run["clip"], "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True).stdout
    from io import BytesIO
    im = Image.open(BytesIO(png)).convert("RGB"); d = ImageDraw.Draw(im)
    if r["box"]:
        b = r["box"]; d.rectangle([b["x"] * FW, b["y"] * FH, (b["x"] + b["w"]) * FW, (b["y"] + b["h"]) * FH], outline=col.get(r["state"], "#ff0000"), width=4)
    d.rectangle([0, 0, 420, 44], fill="#000000"); d.text((8, 8), "t %.1f  %s  %s" % (r["t"], r["state"], r.get("score", "")), fill="#ffffff", font_size=28) if hasattr(d, "text") else None
    if crop: im = im.crop((int(crop[0] * FW), int(crop[1] * FH), int((crop[0] + crop[2]) * FW), int((crop[1] + crop[3]) * FH)))
    im.thumbnail((640, 640)); tiles.append(im)
if not tiles: sys.exit("no frames")
w, h = tiles[0].size; cols = 4; rows_n = (len(tiles) + cols - 1) // cols
S = Image.new("RGB", (w * cols, h * rows_n))
for i, t in enumerate(tiles): S.paste(t, ((i % cols) * w, (i // cols) * h))
S.save(out); print(out, S.size)
