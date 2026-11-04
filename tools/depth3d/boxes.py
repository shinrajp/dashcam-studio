"""boxes.py — vehicle boxes for the road growing: the repo's detector (tools/rig/detect-tracks.py: YOLO + IoU tracks, boxes in
0..1 of the raw fisheye picture, times on each file's clip clock) run on the stretch only, then mapped into each level view
(prototype's boxes.js).

boxes.js took a raw box into the view through the lens but kept the camera's own axes; the level views have the camera's yaw
but their own pitch and no roll (the back view is 14° off the back camera's pitch), so here each box outline goes through
the full ray: raw pixel → car-axis ray (js/rig.js lens and mounting) → the view's pinhole.
"""
import importlib.util, json, os
import numpy as np
from video import frames

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CLASSES = ("car", "truck", "bus", "motorcycle", "bicycle", "person")


def _detect_tracks():
    spec = importlib.util.spec_from_file_location("detect_tracks", os.path.join(ROOT, "tools", "rig", "detect-tracks.py"))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


def detect(clips, ftimes, windows, model, every=2, log=print):
    """YOLO tracks per camera over its frames in windows[cam] = (first, last) frame index: as detect-tracks.py main(), with
    frame times from the file's own frame list. → { cam: [ { cls, keys: [[t_clip, box], …] } ] }"""
    import onnxruntime as ort
    DT = _detect_tracks()
    sess = ort.InferenceSession(model, providers=["CPUExecutionProvider"]); out = {}
    for cam, clip in clips.items():
        first, last = windows[cam]; ts = ftimes[cam]; tracks, live = [], []
        for i, img in frames(clip, 960, stop=last + 1):   # = detect-tracks.py frames() (960 wide), with indices
            if i < first or (i - first) % every: continue
            img = img[:, :, ::-1]   # BGR → RGB, as detect-tracks.py feeds YOLO
            t = ts[i]; dets = DT.detect(sess, img); used = set(); nxt = []
            for tr in live:
                lastb = tr["keys"][-1][1]; best, bi = 0.3, None
                for k, d in enumerate(dets):
                    if k in used or d["cls"] != tr["cls"]: continue
                    v = DT.iou(lastb, d)
                    if v > best: best, bi = v, k
                if bi is not None: used.add(bi); tr["keys"].append([t, dets[bi]]); tr["miss"] = 0; nxt.append(tr)
                elif tr["miss"] < 3: tr["miss"] += 1; nxt.append(tr)
            for k, d in enumerate(dets):
                if k not in used: tr = dict(cls=d["cls"], keys=[[t, d]], miss=0); tracks.append(tr); nxt.append(tr)
            live = nxt
        # short tracks too (≥ 2 keys): a car seen briefly in the stretch is still a car the road mustn't grow into
        out[cam] = [dict(cls=t["cls"], keys=t["keys"]) for t in tracks if len(t["keys"]) >= 2]
        log(f"  {cam}: {len(out[cam])} tracks")
    return out


def to_views(rig, frames, dets, tol=0.08):
    """detector boxes (raw 0..1) → rectangles [x0, y0, x1, y1] in each level view, per frame name (boxes.js)."""
    out = {}
    for f in frames:
        t, rects = f["t_clip"], []
        for tr in dets.get(f["cam"], []):
            if tr["cls"] not in CLASSES: continue
            best, bd = None, tol
            for kt, b in tr["keys"]:
                d = abs(kt - t)
                if d < bd: bd, best = d, b
            if best is None: continue
            s = np.linspace(0, 1, 9)
            outline = np.concatenate([np.stack([s, np.zeros_like(s)], 1), np.stack([s, np.ones_like(s)], 1),
                                      np.stack([np.zeros_like(s), s], 1), np.stack([np.ones_like(s), s], 1)])
            uv = np.stack([best["x"] + best["w"] * outline[:, 0], best["y"] + best["h"] * outline[:, 1]], 1)
            p = rig.raw_to_view(f["cam"], uv); p = p[np.isfinite(p).all(1)]
            if len(p) < 4: continue
            x0, y0 = np.clip(p.min(0), -1e4, 1e4); x1, y1 = np.clip(p.max(0), -1e4, 1e4)
            rects.append([int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1))])
        out[f["name"]] = rects
    return out
