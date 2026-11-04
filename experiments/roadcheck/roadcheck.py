#!/usr/bin/env python3
"""roadcheck.py — anything that isn't flat road, without knowing what it is.

Between two frames of one camera the car's move is known (telemetry) and so is the camera (measured rig). If every pixel below the horizon
were flat road, the earlier frame warped through the road plane would line up with the later one exactly. What doesn't line up either
sticks up from the road (a car, a person, a pole, a tyre, a box) or moves. The difference is taken against the frame before AND the frame
after, and the smaller of the two kept (something truly off the road misaligns both ways; a flicker or a passing shadow edge in one).

    python roadcheck.py <rig.json> <clips dir> <sei dir> <dets.json> <out dir> [--every 1.0] [--cams front,...]
Writes <out>/res.json (per sampled frame: blobs, detector boxes and which were found) and overlay pictures.
"""
import argparse, glob, json, math, os, subprocess, sys
import numpy as np, cv2
sys.path.insert(0, "/Users/clementlaw/Documents/GitHub/dashcam-studio/tools/rig")
from calibrate import Path, project, rot, unproject

SW, SH = 724, 469            # working size (half of 1448 × 938)
MAXD = 150.0                 # road looked at out to 150 m (a car standing 10 m away covers rays that meet the road 40+ m behind it)
MIN_DOWN = math.radians(0.6) # rays at least 0.6° below level


def decode(path, frames):
    want = set(frames); out = {}
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={SW}:{SH}:flags=area,format=gray", "-f", "rawvideo", "-"], stdout=subprocess.PIPE)
    i = 0
    while want:
        b = p.stdout.read(SW * SH)
        if len(b) < SW * SH: break
        if i in want: out[i] = np.frombuffer(b, np.uint8).reshape(SH, SW).astype(np.float32); want.discard(i)
        i += 1
    p.kill(); return out


def road_grid(c):
    """road pixels of this camera: their ground points (car axes) and mask"""
    lens = np.array([c["f"], c["cx"], c["cy"], *c["k"]])
    ys, xs = np.mgrid[0:SH, 0:SW]; u = (xs.ravel() + 0.5) * (1448 / SW); v = (ys.ravel() + 0.5) * (938 / SH)
    bc = unproject(u, v, lens, 1448, 938); Rc = rot(math.radians(c["yaw"]), math.radians(c["pitch"]), math.radians(c["roll"]))
    d = (Rc @ bc.T).T; P = np.array(c["pos"])
    down = d[:, 1] < -math.sin(MIN_DOWN)
    s = np.where(down, -P[1] / np.minimum(d[:, 1], -1e-6), 0)
    X = P + s[:, None] * d
    dist = np.hypot(X[:, 0] - P[0], X[:, 2] - P[2])
    inside = bc[:, 2] > math.cos(math.radians(c.get("thmax", 80)))
    body = np.array([[ch == "1" for ch in row] for row in c["body"]], np.uint8)
    body = cv2.resize(body, (SW, SH), interpolation=cv2.INTER_NEAREST).ravel().astype(bool)
    body = cv2.dilate(body.reshape(SH, SW).astype(np.uint8), np.ones((9, 9), np.uint8)).ravel().astype(bool)
    m = down & (dist < MAXD) & inside & ~body
    return X, m.reshape(SH, SW), lens, Rc, P


def warp(img_n, X, m, R, T, lens, Rc, P):
    """frame n sampled at where each road pixel of frame j lands in it (X: ground points in car-j axes; X_n = R X_j + T)"""
    Xn = (R @ X.T).T + T
    bn = (Rc.T @ (Xn - P).T).T; bn /= np.linalg.norm(bn, axis=1, keepdims=True)
    uv = project(bn, lens, 1448, 938) * (SW / 1448)
    mx = np.clip(uv[:, 0] - 0.5, -2, SW + 1).astype(np.float32).reshape(SH, SW); my = np.clip(uv[:, 1] - 0.5, -2, SH + 1).astype(np.float32).reshape(SH, SW)
    ok = m & (mx >= 0) & (my >= 0) & (mx < SW - 1) & (my < SH - 1) & (bn[:, 2] > 0).reshape(SH, SW)
    return cv2.remap(img_n, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE), ok


def residual(a, b, ok):
    """|a − b| after matching brightness, relative to how much edge is there (a sliver of misalignment on a lane line is not an object)"""
    a = cv2.GaussianBlur(a, (0, 0), 1.2); b = cv2.GaussianBlur(b, (0, 0), 1.2)
    if ok.sum() < 500: return None
    g = np.median(a[ok]) / max(1e-3, np.median(b[ok])); b = b * g
    gx = cv2.Sobel(a, cv2.CV_32F, 1, 0, ksize=3); gy = cv2.Sobel(a, cv2.CV_32F, 0, 1, ksize=3)
    edge = cv2.GaussianBlur(np.hypot(gx, gy), (0, 0), 2.0)
    r = np.abs(a - b) / (6.0 + 0.35 * edge)
    r[~ok] = 0
    return r


_SELF = {}
def self_mask(clips, cam, path, ft):
    """the car's own body in this camera (bonnet, bumper, mirror housings): what stays the same in the picture while the car drives"""
    key = (clips, cam)
    if key in _SELF: return _SELF[key]
    js = [j for j in range(40, len(ft) - 40, 70) if np.interp(ft[j], path.t, path.speed) > 4][:24]
    imgs = decode(glob.glob(os.path.join(clips, f"*-{cam}.mp4"))[0], [f for j in js for f in (j, j - 30)])
    ds = [np.abs(cv2.GaussianBlur(imgs[j], (0, 0), 1.5) - cv2.GaussianBlur(imgs[j - 30], (0, 0), 1.5)) for j in js if j in imgs and j - 30 in imgs]
    if len(ds) < 6: _SELF[key] = np.zeros((SH, SW), bool); return _SELF[key]
    still = np.median(np.stack(ds), 0) < 3.0
    # keep the big still regions only (the body), then grow them a little
    n, lab, st, _ = cv2.connectedComponentsWithStats(still.astype(np.uint8))
    body = np.zeros((SH, SW), np.uint8)
    for i in range(1, n):
        if st[i, 4] > 1500: body[lab == i] = 1
    body = cv2.dilate(body, np.ones((11, 11), np.uint8)).astype(bool)
    _SELF[key] = body; return body


def rx(d):
    a = math.radians(d); return np.array([[1, 0, 0], [0, math.cos(a), math.sin(a)], [0, -math.sin(a), math.cos(a)]])
def rz(d):
    a = math.radians(d); return np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1]])
def body_turn(img_j, img_n, X, m, R, T, lens, Rc, P):
    """the car's pitch / roll change between the two frames (±0.8°), from how well the road lines up (rows of the road far from objects:
    the median over the whole road is robust to the few things on it)"""
    sub = np.zeros_like(m); sub[::3, ::3] = True; mm = m & sub
    def cost(B):
        w, ok = warp(img_n, X, mm, B @ R, T, lens, Rc, P)
        if ok.sum() < 300: return 9
        d = np.abs(cv2.GaussianBlur(img_j, (0, 0), 1.2) - cv2.GaussianBlur(w, (0, 0), 1.2))
        return float(np.median(d[ok]))
    best = (cost(np.eye(3)), 0.0, 0.0)
    for p in (-0.8, -0.5, -0.3, -0.15, 0.15, 0.3, 0.5, 0.8):
        c = cost(rx(p)); best = min(best, (c, p, 0.0))
    p0 = best[1]
    for p in (p0 - 0.08, p0 + 0.08):
        c = cost(rx(p)); best = min(best, (c, p, 0.0))
    p0 = best[1]
    for r in (-0.6, -0.3, -0.15, 0.15, 0.3, 0.6):
        c = cost(rz(r) @ rx(p0)); best = min(best, (c, p0, r))
    return rz(best[2]) @ rx(best[1])


def blobs(r, thr, min_area):
    m = (cv2.GaussianBlur(r, (0, 0), 2.0) > thr).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)); m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m)
    out = []
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if a >= min_area: out.append({"x": x / SW, "y": y / SH, "w": w / SW, "h": h / SH, "area": int(a)})
    return out, m


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("rig"); ap.add_argument("clips"); ap.add_argument("sei"); ap.add_argument("dets"); ap.add_argument("out")
    ap.add_argument("--every", type=float, default=1.0); ap.add_argument("--cams", default="front,back,left_pillar,right_pillar,left_repeater,right_repeater")
    ap.add_argument("--thr", type=float, default=1.0); ap.add_argument("--area", type=int, default=120); ap.add_argument("--move", type=float, default=0.8); ap.add_argument("--body", type=int, default=1)
    a = ap.parse_args(); os.makedirs(a.out, exist_ok=True)
    rig = json.load(open(a.rig)); dets = json.load(open(a.dets)); res = []
    for cam in a.cams.split(","):
        c = rig[cam]; rows = json.load(open(f"{a.sei}/sei-{cam}.json"))["rows"]; path = Path(rows); ft = np.array([r["t"] for r in rows])
        X, m, lens, Rc, P = road_grid(c)
        m = m & ~self_mask(a.clips, cam, path, ft)
        # sampled frames, and for each a frame before and after about `move` metres away (or 5 frames when standing still)
        plan = []
        for t in np.arange(1.0, ft[-1] - 1.0, a.every):
            j = int(np.searchsorted(ft, t)); sp = np.interp(ft[j], path.t, path.speed)
            k = int(np.clip(round(a.move / max(sp, 0.1) * 36.1), 2, 12)) if sp > 0.5 else 5
            if j - k < 0 or j + k >= len(ft): continue
            plan.append((j, j - k, j + k, sp))
        imgs = decode(glob.glob(os.path.join(a.clips, f"*-{cam}.mp4"))[0], [f for p in plan for f in p[:3]])
        for j, i0, i1, sp in plan:
            if j not in imgs or i0 not in imgs or i1 not in imgs: continue
            rs = []
            for n in (i0, i1):
                R_, T_ = path.rel(ft[n], ft[j])          # X_n = R X_j + T
                if a.body:   # the car pitches and rolls on its suspension between frames: find that small turn on the road first
                    R_ = body_turn(imgs[j], imgs[n], X, m, R_, T_, lens, Rc, P) @ R_
                    T_ = T_  # (turn about the rear-axle point under the car: T unchanged to first order)
                w, ok = warp(imgs[n], X, m, R_, T_, lens, Rc, P)
                r = residual(imgs[j], w, ok)
                if r is not None: rs.append(r)
            if len(rs) < 2: continue
            r = np.minimum(rs[0], rs[1])
            bl, bm = blobs(r, a.thr, a.area)
            # the detector's boxes at this moment (tracks' keys nearest in time), those whose foot is on the looked-at road
            t = float(ft[j]); boxes = []
            for tr in dets.get(cam, []):
                ks = tr["keys"]
                if ks[0][0] > t + 0.05 or ks[-1][0] < t - 0.05: continue
                k = min(ks, key=lambda q: abs(q[0] - t))
                if abs(k[0] - t) > 0.06: continue
                b = k[1]; fx, fy = int(min(SW - 1, (b["x"] + b["w"] / 2) * SW)), int(min(SH - 1, (b["y"] + b["h"]) * SH))
                onroad = bool(m[min(SH - 1, fy + 1), fx]) or bool(m[fy, fx])
                # found: road-check pixels cover ≥ 12 % of the box's lower 60 %
                x0, x1 = int(b["x"] * SW), int((b["x"] + b["w"]) * SW); y0, y1 = int((b["y"] + 0.4 * b["h"]) * SH), int((b["y"] + b["h"]) * SH)
                sub = bm[max(0, y0):max(y0 + 1, y1), max(0, x0):max(x0 + 1, x1)]
                cover = float(sub.mean()) if sub.size else 0.0
                boxes.append({"cls": tr["cls"], "box": b, "onroad": onroad, "cover": round(cover, 3), "found": cover >= 0.12})
            for B in bl:   # a blob with no detector box over it
                B["box"] = any(min(B["x"] + B["w"], q["box"]["x"] + q["box"]["w"]) > max(B["x"], q["box"]["x"]) and min(B["y"] + B["h"], q["box"]["y"] + q["box"]["h"]) > max(B["y"], q["box"]["y"]) for q in boxes)
            res.append({"cam": cam, "t": round(t, 3), "speed": round(float(sp), 1), "blobs": bl, "boxes": boxes})
            # overlay: residual in red over the frame; detector boxes green (found) / orange (missed) / grey (foot not on the looked-at road); blobs with no box cyan
            o = cv2.cvtColor(imgs[j].astype(np.uint8), cv2.COLOR_GRAY2BGR)
            o[m] = (o[m] * 0.85 + np.array([20, 20, 0]) * 0.15).astype(np.uint8)
            heat = np.clip(cv2.GaussianBlur(r, (0, 0), 2.0) / (2 * a.thr), 0, 1)
            o = (o * (1 - 0.6 * heat[..., None]) + np.array([0, 0, 255]) * 0.6 * heat[..., None]).astype(np.uint8)
            for q in boxes:
                b = q["box"]; col = (0, 220, 0) if q["found"] and q["onroad"] else (0, 140, 255) if q["onroad"] else (150, 150, 150)
                cv2.rectangle(o, (int(b["x"] * SW), int(b["y"] * SH)), (int((b["x"] + b["w"]) * SW), int((b["y"] + b["h"]) * SH)), col, 1)
            for B in bl:
                if not B["box"]: cv2.rectangle(o, (int(B["x"] * SW), int(B["y"] * SH)), (int((B["x"] + B["w"]) * SW), int((B["y"] + B["h"]) * SH)), (255, 255, 0), 1)
            cv2.putText(o, f"{cam} t={t:.1f} {sp * 3.6:.0f} km/h", (5, 14), 0, 0.42, (255, 255, 255), 1, cv2.LINE_AA)
            cv2.imwrite(os.path.join(a.out, f"{cam}-{t:05.1f}.jpg"), o, [cv2.IMWRITE_JPEG_QUALITY, 75])
        print(cam, "done", file=sys.stderr)
    json.dump(res, open(os.path.join(a.out, "res.json"), "w"))


if __name__ == "__main__":
    main()
