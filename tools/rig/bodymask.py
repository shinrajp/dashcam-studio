#!/usr/bin/env python3
"""bodymask.py — where the car's own body (and the lens hood / vignette) is in each camera's picture.

While the car drives, the world moves through the picture; the car's own body does not. Motion between frames, over the moving part of the drive, is low there (median dense optical flow, Farneback, 0.22 s apart). The low regions that touch the picture's border
(bodywork comes in from an edge) form the mask. Output: a grid of 64 columns (rows from the camera's aspect), 1 = body,
as rows of '0'/'1' strings in rig JSON, plus a preview PNG.

    python tools/rig/bodymask.py <clip.mp4> <sei.json> <out.json> [preview.png]
"""
import json, subprocess, sys
import numpy as np, cv2

GW = 64


def main():
    clip, sei, out = sys.argv[1:4]; prev_png = sys.argv[4] if len(sys.argv) > 4 else None
    rows = json.load(open(sei))["rows"]; t = np.array([r["t"] for r in rows]); v = np.array([r.get("speed", 0) for r in rows])
    w = 362
    sw, sh = map(int, subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                                      "-of", "csv=p=0", clip], capture_output=True, text=True).stdout.strip().split(","))
    h = round(sh * w / sw / 2) * 2
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", clip, "-vf", f"scale={w}:{h}:flags=area,format=gray", "-f", "rawvideo", "-"], stdout=subprocess.PIPE)
    buf, flows, i, mean = [], [], 0, np.zeros((h, w))
    while True:
        b = p.stdout.read(w * h)
        if len(b) < w * h: break
        g = np.frombuffer(b, np.uint8).reshape(h, w); buf.append(g); mean += g
        if len(buf) > 9: buf.pop(0)
        if len(buf) == 9 and i % 3 == 0 and i < len(v) and v[i] > 3:
            f = cv2.calcOpticalFlowFarneback(buf[0], g, None, 0.5, 4, 21, 3, 5, 1.1, 0)
            flows.append(np.hypot(f[..., 0], f[..., 1]).astype(np.float16))
        i += 1
    p.wait(); mean /= max(i, 1); n = len(flows)
    # median motion over the drive: the road and the world stream past, the car's body (even reflecting) stays put
    chg = cv2.GaussianBlur(np.median(np.stack(flows), 0).astype(np.float32), (0, 0), 2)
    if len(sys.argv) > 5: cv2.imwrite(sys.argv[5], np.clip(chg / np.percentile(chg, 99) * 255, 0, 255).astype(np.uint8))
    thr = max(0.6, 0.12 * np.median(chg))
    low = (chg < thr).astype(np.uint8)
    # dark vignette corners count too (nothing to see there)
    low |= (cv2.GaussianBlur(mean, (0, 0), 2) < 14).astype(np.uint8)
    low = cv2.morphologyEx(low, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    nl, lab, stats, _ = cv2.connectedComponentsWithStats(low, 8)
    m = np.zeros_like(low)
    for k in range(1, nl):
        x, y, ww, hh, area = stats[k]
        touches = x == 0 or y == 0 or x + ww >= w or y + hh >= h
        if touches and area >= 0.004 * w * h: m[lab == k] = 1
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    gh = max(1, round(GW * h / w))
    grid = cv2.resize(m.astype(np.float32), (GW, gh), interpolation=cv2.INTER_AREA) > 0.5
    res = dict(cols=GW, rows=gh, frac=round(float(grid.mean()), 4), grid=["".join("1" if c else "0" for c in r) for r in grid])
    json.dump(res, open(out, "w"))
    if prev_png:
        col = cv2.cvtColor(mean.astype(np.uint8), cv2.COLOR_GRAY2BGR)
        over = cv2.resize(grid.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST).astype(bool)
        col[over] = (0.5 * col[over] + [0, 0, 120]).astype(np.uint8)
        cv2.imwrite(prev_png, col)
    print(f"{out}: body {res['frac'] * 100:.1f}% of the picture ({n} moving frame pairs)", file=sys.stderr)


if __name__ == "__main__":
    main()
