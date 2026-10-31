#!/usr/bin/env python3
"""track-real-score.py — score a tools/track-real.js run against reference boxes (tools/yolo-truth.js): per second, the share of the object the box
covers, the object's centre offset from the box centre (in object widths) and the box/object size ratio. Usage: track-real-score.py run.json truth.json"""
import json, sys
run = {round(r["t"], 1): r for r in json.load(open(sys.argv[1]))["rows"]}
truth = [r for r in json.load(open(sys.argv[2]))["rows"] if r["box"]]
def cover(a, b):
    x1, y1 = max(a["x"], b["x"]), max(a["y"], b["y"]); x2, y2 = min(a["x"] + a["w"], b["x"] + b["w"]), min(a["y"] + a["h"], b["y"] + b["h"])
    return max(0, x2 - x1) * max(0, y2 - y1) / (b["w"] * b["h"])
rows = []
for tr in truth:
    r = run.get(round(tr["t"], 1))
    if not r: continue
    b, T = r["box"], tr["box"]
    if not b: rows.append((tr["t"], 0, None, None)); continue
    off = ((b["x"] + b["w"] / 2 - T["x"] - T["w"] / 2) ** 2 + (b["y"] + b["h"] / 2 - T["y"] - T["h"] / 2) ** 2) ** 0.5 / T["w"]
    rows.append((tr["t"], cover(b, T), off, b["w"] / T["w"]))
full = sum(1 for r in rows if r[1] >= 0.95) / len(rows); most = sum(1 for r in rows if r[1] >= 0.8) / len(rows)
print("samples %d · object fully covered (>=95%%) %d%% · mostly (>=80%%) %d%% · worst %d%%" % (len(rows), full * 100, most * 100, min(r[1] for r in rows) * 100))
for s in range(0, int(rows[-1][0]) + 1):
    g = [r for r in rows if s <= r[0] < s + 1]
    if not g: continue
    c = min(r[1] for r in g); o = [r[2] for r in g if r[2] is not None]; z = [r[3] for r in g if r[3] is not None]
    print("  %2d s  cover min %3d%%   centre off %s   box/object %s" % (s, c * 100, ("%.2f" % max(o)) if o else "  - ", ("%.1f" % (sum(z) / len(z))) if z else " - "))
