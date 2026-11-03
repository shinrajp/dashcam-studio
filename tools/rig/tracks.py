#!/usr/bin/env python3
"""tracks.py — point tracks of one camera's clip, for the rig calibration (tools/rig/calibrate.py).

KLT (pyramidal Lucas-Kanade) frame to frame with a forward-backward check, topped up with new corners where the
picture has few. Frames are decoded grey by ffmpeg at 1448 px wide (the front camera is halved; calibrate.py scales
its lens back). Output .npz: tid, fi (frame index), x, y (float32, decoded pixels), plus w, h, scale.

    python tools/rig/tracks.py <clip.mp4> <out.npz> [--every 1] [--max 900]
"""
import argparse, subprocess, sys
import numpy as np, cv2

W = 1448


def frames(path, w):
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                            "-of", "csv=p=0", path], capture_output=True, text=True, check=True).stdout.strip().split(",")
    sw, sh = int(probe[0]), int(probe[1]); h = round(sh * w / sw / 2) * 2
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={w}:{h}:flags=area,format=gray",
                          "-f", "rawvideo", "-"], stdout=subprocess.PIPE, bufsize=w * h * 4)
    n = w * h
    while True:
        b = p.stdout.read(n)
        if len(b) < n: break
        yield np.frombuffer(b, np.uint8).reshape(h, w)
    p.wait()
    frames.size = (sw, sh, w, h)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clip"); ap.add_argument("out")
    ap.add_argument("--max", type=int, default=900, help="corners kept per frame")
    ap.add_argument("--fb", type=float, default=0.7, help="forward-backward limit (px)")
    a = ap.parse_args()
    lk = dict(winSize=(21, 21), maxLevel=4, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
    prev = None; pts = np.zeros((0, 2), np.float32); ids = np.zeros(0, np.int64); nxt = 0
    T, F, X, Y = [], [], [], []
    for fi, g in enumerate(frames(a.clip, W)):
        if prev is not None and len(pts):
            p1, st, _ = cv2.calcOpticalFlowPyrLK(prev, g, pts, None, **lk)
            p0, st2, _ = cv2.calcOpticalFlowPyrLK(g, prev, p1, None, **lk)
            fb = np.linalg.norm(p0 - pts, axis=1)
            h, w = g.shape
            ok = (st[:, 0] == 1) & (st2[:, 0] == 1) & (fb < a.fb) & (p1[:, 0] >= 0) & (p1[:, 1] >= 0) & (p1[:, 0] < w) & (p1[:, 1] < h)
            pts, ids = p1[ok], ids[ok]
        if len(pts) < a.max * 0.8:
            mask = np.full(g.shape, 255, np.uint8)
            for x, y in pts: cv2.circle(mask, (int(x), int(y)), 12, 0, -1)
            c = cv2.goodFeaturesToTrack(g, a.max - len(pts), 0.01, 12, mask=mask, blockSize=7)
            if c is not None:
                c = c.reshape(-1, 2).astype(np.float32)
                c = cv2.cornerSubPix(g, c, (5, 5), (-1, -1), (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, 0.03))
                pts = np.vstack([pts, c]); ids = np.concatenate([ids, np.arange(nxt, nxt + len(c))]); nxt += len(c)
        T.append(ids.copy()); F.append(np.full(len(ids), fi, np.int32)); X.append(pts[:, 0].copy()); Y.append(pts[:, 1].copy())
        prev = g
        if fi % 200 == 0: print(f"  frame {fi}: {len(pts)} points", file=sys.stderr)
    sw, sh, w, h = frames.size
    np.savez_compressed(a.out, tid=np.concatenate(T), fi=np.concatenate(F), x=np.concatenate(X), y=np.concatenate(Y),
                        w=w, h=h, scale=sw / w, nframes=fi + 1)
    print(f"{a.out}: {fi + 1} frames, {nxt} tracks", file=sys.stderr)


if __name__ == "__main__":
    main()
