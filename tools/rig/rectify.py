#!/usr/bin/env python3
"""rectify.py — check a rig calibration by eye: each camera re-rendered as a level pinhole view.

With the right lens, straight lines (poles, kerbs, building edges) come out straight; with the right mounting angles the
horizon is level and sits on the marked centre line, and the dashed yellow line (the car's straight-ahead or
straight-back direction) points along the road.

    python tools/rig/rectify.py rig.json <clips dir> <time s> <out.png> [--fov 100]
"""
import argparse, glob, json, math, os, subprocess
import numpy as np, cv2
from calibrate import CAMS, project, rot


def frame(path, t, w):
    sw, sh = map(int, subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                                      "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip().split(","))
    h = round(sh * w / sw / 2) * 2
    b = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(t), "-i", path, "-frames:v", "1", "-vf", f"scale={w}:{h}",
                        "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], capture_output=True).stdout
    return np.frombuffer(b, np.uint8).reshape(h, w, 3)


def level_view(img, c, fov, W=640, H=420):
    """pinhole view looking along the camera's own yaw, level with the car (pitch 0, roll 0)."""
    f = (W / 2) / math.tan(math.radians(fov) / 2)
    xs, ys = np.meshgrid(np.arange(W) - W / 2 + 0.5, np.arange(H) - H / 2 + 0.5)
    d = np.stack([xs / f, -ys / f, np.ones_like(xs)], -1).reshape(-1, 3); d /= np.linalg.norm(d, axis=1, keepdims=True)
    Rv = rot(math.radians(c["yaw"]), 0, 0); Rc = rot(math.radians(c["yaw"]), math.radians(c["pitch"]), math.radians(c["roll"]))
    dc = (Rc.T @ (Rv @ d.T)).T                       # view ray → car → camera axes
    p = np.array([c["f"], c["cx"], c["cy"], *c["k"]])
    uv = project(dc, p, c["width"], c["height"]).astype(np.float32)
    bad = dc[:, 2] < math.cos(math.radians(c.get("thmax", 100)))
    uv[bad] = -1
    out = cv2.remap(img, uv[:, 0].reshape(H, W), uv[:, 1].reshape(H, W), cv2.INTER_LINEAR, borderValue=(40, 40, 40))
    cv2.line(out, (0, H // 2), (W, H // 2), (0, 255, 255), 1)           # horizon of a level road
    for k in range(-3, 4):                                              # 10° ticks
        x = int(W / 2 + f * math.tan(math.radians(10 * k)));
        if 0 <= x < W: cv2.line(out, (x, H // 2 - 6), (x, H // 2 + 6), (0, 255, 255), 1)
    # straight ahead (+z) or straight back (-z) of the car, if in view
    for ax in (0, 180):
        dv = Rv.T @ rot(math.radians(ax), 0, 0) @ np.array([0, 0, 1.0])
        if dv[2] > 0.1:
            x = int(W / 2 + f * dv[0] / dv[2]); cv2.circle(out, (x, H // 2), 7, (0, 200, 255), 2)
    cv2.putText(out, f"{c['name']}  yaw {c['yaw']:.1f}  pitch {c['pitch']:.1f}  roll {c['roll']:.1f}", (8, 20),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    return out


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("rig"); ap.add_argument("clips"); ap.add_argument("t", type=float); ap.add_argument("out")
    ap.add_argument("--fov", type=float, default=100); a = ap.parse_args()
    rig = json.load(open(a.rig)); rig = rig.get("cams", rig); tiles = []
    for cam in ["left_pillar", "front", "right_pillar", "left_repeater", "back", "right_repeater"]:
        c = dict(rig[cam], name=cam); clip = glob.glob(os.path.join(a.clips, f"*-{cam}.mp4"))[0]
        tiles.append(level_view(frame(clip, a.t, c["width"]), c, a.fov if cam != "front" else min(a.fov, 60)))
    cv2.imwrite(a.out, np.vstack([np.hstack(tiles[:3]), np.hstack(tiles[3:])]))


if __name__ == "__main__":
    main()
