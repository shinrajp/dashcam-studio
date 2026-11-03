#!/usr/bin/env python3
"""detect-tracks.py — YOLO detections + simple IoU tracks per camera of a clip, for checking hand-off predictions
(tools/rig/handoff-check.js). Times are each file's own clip time; boxes in 0..1 of the picture.

    python tools/rig/detect-tracks.py <clips dir> <out.json> [--model models/yolo11s.onnx] [--every 2]
"""
import argparse, glob, json, os, subprocess, sys
import numpy as np, cv2, onnxruntime as ort

CAMS = ["front", "back", "left_pillar", "right_pillar", "left_repeater", "right_repeater"]
KEEP = {0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}


def frames(path, w=960):
    sw, sh = map(int, subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                                      "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip().split(","))
    h = round(sh * w / sw / 2) * 2
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    while True:
        b = p.stdout.read(w * h * 3)
        if len(b) < w * h * 3: break
        yield np.frombuffer(b, np.uint8).reshape(h, w, 3)


def detect(sess, img, conf=0.35):
    h, w = img.shape[:2]; s = 640 / max(w, h); nw, nh = round(w * s), round(h * s)
    pad = np.full((640, 640, 3), 114, np.uint8); pad[:nh, :nw] = cv2.resize(img, (nw, nh))
    x = pad.transpose(2, 0, 1)[None].astype(np.float32) / 255
    o = sess.run(None, {"images": x})[0][0].T
    sc = o[:, 4:].max(1); cl = o[:, 4:].argmax(1); m = (sc > conf) & np.isin(cl, list(KEEP))
    o, sc, cl = o[m], sc[m], cl[m]
    b = np.stack([o[:, 0] - o[:, 2] / 2, o[:, 1] - o[:, 3] / 2, o[:, 2], o[:, 3]], 1) / s
    idx = cv2.dnn.NMSBoxes(b.tolist(), sc.tolist(), conf, 0.5)
    idx = np.array(idx).ravel() if len(idx) else []
    return [dict(x=float(b[i, 0] / w), y=float(b[i, 1] / h), w=float(b[i, 2] / w), h=float(b[i, 3] / h), conf=float(sc[i]), cls=KEEP[int(cl[i])]) for i in idx]


def iou(a, b):
    x1, y1 = max(a["x"], b["x"]), max(a["y"], b["y"]); x2, y2 = min(a["x"] + a["w"], b["x"] + b["w"]), min(a["y"] + a["h"], b["y"] + b["h"])
    i = max(0, x2 - x1) * max(0, y2 - y1); return i / (a["w"] * a["h"] + b["w"] * b["h"] - i + 1e-9)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("clips"); ap.add_argument("out"); ap.add_argument("--model", default="models/yolo11s.onnx")
    ap.add_argument("--every", type=int, default=2); ap.add_argument("--sei", default=None); a = ap.parse_args()
    sess = ort.InferenceSession(a.model, providers=["CPUExecutionProvider"]); out = {}
    for cam in CAMS:
        clip = glob.glob(os.path.join(a.clips, f"*-{cam}.mp4"))[0]
        ts = [r["t"] for r in json.load(open(os.path.join(a.sei, f"sei-{cam}.json")))["rows"]]
        tracks, live = [], []
        for i, img in enumerate(frames(clip)):
            if i % a.every or i >= len(ts): continue
            t = ts[i]; dets = detect(sess, img); used = set(); nxt = []
            for tr in live:
                last = tr["keys"][-1][1]; best, bi = 0.3, None
                for k, d in enumerate(dets):
                    if k in used or d["cls"] != tr["cls"]: continue
                    v = iou(last, d)
                    if v > best: best, bi = v, k
                if bi is not None: used.add(bi); tr["keys"].append([t, dets[bi]]); tr["miss"] = 0; nxt.append(tr)
                elif tr["miss"] < 3: tr["miss"] += 1; nxt.append(tr)
            for k, d in enumerate(dets):
                if k not in used: tr = dict(cls=d["cls"], keys=[[t, d]], miss=0); tracks.append(tr); nxt.append(tr)
            live = nxt
        out[cam] = [dict(cls=t["cls"], keys=[[round(k[0], 4), {q: round(v, 4) if isinstance(v, float) else v for q, v in k[1].items()}] for k in t["keys"]]) for t in tracks if len(t["keys"]) >= 4]
        print(f"{cam}: {len(out[cam])} tracks", file=sys.stderr)
    json.dump(out, open(a.out, "w"))


if __name__ == "__main__":
    main()
