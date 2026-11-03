#!/usr/bin/env python3
"""unwarp.py — mock-up of the back camera without its fisheye: the raw picture, a cylindrical panorama (the whole width,
uprights straight) and three virtual pinhole cameras (left / centre / right), each with YOLO boxes drawn, from the
measured lens in js/rig.js (MEASURED.back) or a rig JSON.

    python tools/rig/unwarp.py <back.mp4> <time s> <out.png> [--rig rig.json] [--model models/yolo11s.onnx]
"""
import argparse, json, math, os, re, subprocess
import numpy as np, cv2
from calibrate import project, rot

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


def measured_back():
    s = open(os.path.join(ROOT, "js/rig.js")).read()
    m = re.search(r"back:\s*\{([^}]*)\}", s[s.index("const MEASURED"):]).group(1)
    num = lambda k: float(re.search(k + r":\s*(-?[\d.]+)", m).group(1))
    k = [float(v) for v in re.search(r"k:\s*\[([^\]]*)\]", m).group(1).split(",")]
    return dict(yaw=num("yaw"), pitch=num("pitch"), roll=num("roll"), f=num(r"\bf"), cx=num("cx"), cy=num("cy"), k=k)


def frame(path, t):
    b = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(t), "-i", path, "-frames:v", "1", "-vf", "scale=1448:938",
                        "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], capture_output=True).stdout
    return np.frombuffer(b, np.uint8).reshape(938, 1448, 3).copy()


def sample(img, c, dirs_car, W, H):
    """car-frame unit directions (H*W, 3) → remapped picture."""
    Rc = rot(math.radians(c["yaw"]), math.radians(c["pitch"]), math.radians(c["roll"]))
    dc = (Rc.T @ dirs_car.T).T
    p = np.array([c["f"], c["cx"], c["cy"], *c["k"]])
    uv = project(dc, p, 1448, 938).astype(np.float32)
    uv[dc[:, 2] < math.cos(math.radians(97))] = -1           # beyond what the lens was measured to see
    return cv2.remap(img, uv[:, 0].reshape(H, W), uv[:, 1].reshape(H, W), cv2.INTER_LINEAR, borderValue=(30, 30, 30))


def cylindrical(img, c, W=1500, H=560, hfov=190, pitch=-18):
    """azimuth along x (equal degrees), height along y as a cylinder (uprights stay straight)."""
    fc = (W / 2) / math.radians(hfov / 2)
    xs, ys = np.meshgrid(np.arange(W) - W / 2 + 0.5, np.arange(H) - H / 2 + 0.5)
    phi = xs / fc; h = -ys / fc
    d = np.stack([np.sin(phi), h, np.cos(phi)], -1).reshape(-1, 3); d /= np.linalg.norm(d, axis=1, keepdims=True)
    V = rot(math.radians(180), math.radians(pitch), 0)
    return sample(img, c, (V @ d.T).T, W, H)


def pinhole(img, c, yaw_off, fov=72, W=560, H=420, pitch=-14):
    f = (W / 2) / math.tan(math.radians(fov) / 2)
    xs, ys = np.meshgrid(np.arange(W) - W / 2 + 0.5, np.arange(H) - H / 2 + 0.5)
    d = np.stack([xs / f, -ys / f, np.ones_like(xs)], -1).reshape(-1, 3); d /= np.linalg.norm(d, axis=1, keepdims=True)
    V = rot(math.radians(180 + yaw_off), math.radians(pitch), 0)
    return sample(img, c, (V @ d.T).T, W, H)


NAMES = {0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}


def detect(sess, img, conf=0.3):
    h, w = img.shape[:2]; s = 640 / max(w, h); nw, nh = round(w * s), round(h * s)
    pad = np.full((640, 640, 3), 114, np.uint8); pad[:nh, :nw] = cv2.resize(img, (nw, nh))
    o = sess.run(None, {"images": pad[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255})[0][0].T
    sc = o[:, 4:].max(1); cl = o[:, 4:].argmax(1); m = (sc > conf) & np.isin(cl, list(NAMES)); o, sc, cl = o[m], sc[m], cl[m]
    b = np.stack([o[:, 0] - o[:, 2] / 2, o[:, 1] - o[:, 3] / 2, o[:, 2], o[:, 3]], 1) / s
    idx = cv2.dnn.NMSBoxes(b.tolist(), sc.tolist(), conf, 0.5); idx = np.array(idx).ravel() if len(idx) else []
    return [(b[i], NAMES[int(cl[i])], float(sc[i])) for i in idx]


def draw(img, dets, title):
    out = img.copy()
    for (x, y, w, h), name, s in dets:
        cv2.rectangle(out, (int(x), int(y)), (int(x + w), int(y + h)), (0, 215, 255), 2)
        cv2.putText(out, f"{name} {s:.0%}", (int(x), max(12, int(y) - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 215, 255), 1, cv2.LINE_AA)
    cv2.rectangle(out, (0, 0), (out.shape[1], 26), (20, 20, 20), -1)
    cv2.putText(out, f"{title}  -  {len(dets)} found", (8, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
    return out


def fit(img, W):
    return cv2.resize(img, (W, round(img.shape[0] * W / img.shape[1])), interpolation=cv2.INTER_AREA)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("clip"); ap.add_argument("t", type=float); ap.add_argument("out")
    ap.add_argument("--rig"); ap.add_argument("--model", default=os.path.join(ROOT, "models/yolo11s.onnx")); a = ap.parse_args()
    c = json.load(open(a.rig))["back"] if a.rig else measured_back()
    img = frame(a.clip, a.t); cyl = cylindrical(img, c); views = [pinhole(img, c, o) for o in (-62, 0, 62)]
    sess = None
    try:
        import onnxruntime as ort; sess = ort.InferenceSession(a.model, providers=["CPUExecutionProvider"])
    except Exception: pass
    dd = (lambda im: detect(sess, im)) if sess else (lambda im: [])
    W = 1680
    raw = fit(draw(img, dd(img), "Rear camera as recorded (fisheye)"), W)
    cy = fit(draw(cyl, dd(cyl), "Unwarped: cylindrical panorama, 190 deg"), W)
    names = ["Virtual camera: rear-right of the car", "Virtual camera: straight back", "Virtual camera: rear-left of the car"]
    # (looking backwards, the car's left is on the picture's right)
    row = np.hstack([draw(v, dd(v), n) for v, n in zip(views, names)])
    sep = np.full((10, W, 3), 255, np.uint8)
    cv2.imwrite(a.out, np.vstack([raw, sep, cy, sep, fit(row, W)]))


if __name__ == "__main__":
    main()
