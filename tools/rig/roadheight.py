#!/usr/bin/env python3
"""roadheight.py — each camera's height above the road, from how the road surface moves.

Between two frames the car's move is known (telemetry). Ground pixels of the later frame, sent out as rays, meet the road
plane at a height h below the camera, are moved back by the car's move and projected into the earlier frame. Only at the
right h does the warped road line up with the earlier picture (normalised cross-correlation on the gradient images, so
light and shade don't matter). Uses every road pixel, not only corners, so it works on plain asphalt where tracked points
are few. Reads the lens and angles from calibrate.py's JSON and writes "road": {height, spread, pairs} into it.

    python tools/rig/roadheight.py rig.json <clips dir> <sei dir> [--cams front,...]
"""
import argparse, glob, json, math, os, subprocess, sys
import numpy as np, cv2
from calibrate import CAMS, Path, project, rot, unproject

W = 1448


def decode(path, frames, w):
    sw, sh = map(int, subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                                      "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip().split(","))
    h = round(sh * w / sw / 2) * 2; want = set(frames); out = {}
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={w}:{h}:flags=area,format=gray", "-f", "rawvideo", "-"], stdout=subprocess.PIPE)
    i = 0
    while want:
        b = p.stdout.read(w * h)
        if len(b) < w * h: break
        if i in want: out[i] = np.frombuffer(b, np.uint8).reshape(h, w).copy(); want.discard(i)
        i += 1
    p.kill(); return out


def grad(img):
    g = img.astype(np.float32); gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3); gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    return cv2.GaussianBlur(np.hypot(gx, gy), (0, 0), 1.0)


def bilinear(img, x, y):
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int); fx, fy = x - x0, y - y0
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy) + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy)


def ncc(a, b):
    a = a - a.mean(); b = b - b.mean(); d = math.sqrt(float((a * a).sum() * (b * b).sum()))
    return float((a * b).sum() / d) if d > 0 else -1


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("rig"); ap.add_argument("clips"); ap.add_argument("sei")
    ap.add_argument("--cams", default=",".join(CAMS)); a = ap.parse_args()
    rig = json.load(open(a.rig)); hs = np.arange(0.5, 2.21, 0.01)
    for cam in a.cams.split(","):
        c = rig[cam]; lens = np.array([c["f"], c["cx"], c["cy"], *c["k"]]); w, h = c["width"], c["height"]
        rows = json.load(open(f"{a.sei}/sei-{cam}.json"))["rows"]; path = Path(rows); ft = np.array([r["t"] for r in rows])
        Rcam = rot(math.radians(c["yaw"]), math.radians(c["pitch"]), math.radians(c["roll"])); P = np.array(c["pos"])
        # road pixels: rays at least 6° below level, within 9 m, not beyond the lens's measured reach
        ys, xs = np.mgrid[0:h:4, 0:w:4]; u, v = xs.ravel().astype(float), ys.ravel().astype(float)
        bc = unproject(u, v, lens, w, h); d = (Rcam @ bc.T).T
        thmax = math.radians(c.get("thmax", 80))
        sel = (d[:, 1] < -math.sin(math.radians(6))) & (bc[:, 2] > math.cos(thmax))
        u, v, bc, d = u[sel], v[sel], bc[sel], d[sel]
        # pairs: driving straight-ish at > 4 m/s, moved 0.8–1.6 m
        pairs = []
        for i in range(0, len(ft) - 60, 25):
            if np.interp(ft[i], path.t, path.speed) < 4: continue
            for j in range(i + 3, min(i + 60, len(ft))):
                R, T = path.rel(ft[i], ft[j])
                if np.linalg.norm(T) >= 1.0: break
            if abs(math.atan2(R[0, 2], R[0, 0])) < math.radians(3): pairs.append((i, j, R, T))
        imgs = decode(glob.glob(os.path.join(a.clips, f"*-{cam}.mp4"))[0], [f for p in pairs for f in p[:2]], W)
        best = []
        for i, j, R, T in pairs:
            if i not in imgs or j not in imgs: continue
            gi, gj = grad(imgs[i]), grad(imgs[j]); scores = []
            for hh in hs:
                s = -hh / d[:, 1]; keep = s < 12                          # ray length to the road
                Xc = P + s[:, None] * d                                   # road point in car-i axes (from the camera)
                Xj = (R.T @ (Xc - T).T).T                                 # the same point in car-j axes
                bj = (Rcam.T @ (Xj - P).T).T; bj /= np.linalg.norm(bj, axis=1, keepdims=True)
                uv = project(bj, lens, w, h)
                ok = keep & (np.hypot(Xc[:, 0] - P[0], Xc[:, 2] - P[2]) < 9) & (uv[:, 0] >= 1) & (uv[:, 1] >= 1) & (uv[:, 0] < w - 2) & (uv[:, 1] < h - 2)
                if ok.sum() < 500: scores.append(-1); continue
                a_ = bilinear(gj, uv[ok, 0], uv[ok, 1])
                b_ = gi[v[ok].astype(int), u[ok].astype(int)]
                scores.append(ncc(a_, b_))
            scores = np.array(scores); k = int(np.argmax(scores))
            if scores[k] > 0.3 and 0 < k < len(hs) - 1: best.append((hs[k], scores[k]))
        if not best: print(f"{cam}: no road found", file=sys.stderr); continue
        H = np.array([b[0] for b in best]); med = float(np.median(H)); mad = float(1.4826 * np.median(np.abs(H - med)))
        c["road"] = dict(height=round(med, 3), spread=round(mad, 3), pairs=len(best), ncc=round(float(np.median([b[1] for b in best])), 3))
        print(f"{cam}: road {med:.2f} m below the camera (± {mad:.2f}, {len(best)} pairs, ncc {c['road']['ncc']})", file=sys.stderr)
    json.dump(rig, open(a.rig, "w"), indent=1)


if __name__ == "__main__":
    main()
