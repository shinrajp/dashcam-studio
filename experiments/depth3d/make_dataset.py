#!/usr/bin/env python3
"""make_dataset.py — one stretch of a six-camera drive as a COLMAP dataset with KNOWN poses (no SfM), for Brush.

Each fisheye frame is re-rendered as a level pinhole view (common.VIEW) through the measured lens; pixels showing the
car's own body or beyond the lens's measured reach are masked out (masks/, white = use). Poses: js/rig.js mounting ×
the car's path from the telemetry at that frame's moment (file clock CLOCK0 + per-camera telemetry delay). The initial
point cloud is the KLT tracks of tools/rig/tracks.py triangulated with those poses (static points only survive the
residual test).

    python experiments/splat/make_dataset.py --clips DIR --sei DIR --tracks DIR --out DATA --t0 4 --t1 20 --every 3
"""
import argparse, glob, os, subprocess, sys
import numpy as np, cv2

sys.path.insert(0, os.path.dirname(__file__))
from common import CAMS, VIEW, Drive, view, remap_tables, fisheye_ray, qvec, S  # noqa: E402


def decode(path, w):
    sw, sh = map(int, subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                                      "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip().split(","))
    h = round(sh * w / sw / 2) * 2
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={w}:{h}:flags=area", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                         stdout=subprocess.PIPE, bufsize=w * h * 6)
    while True:
        b = p.stdout.read(w * h * 3)
        if len(b) < w * h * 3: break
        yield np.frombuffer(b, np.uint8).reshape(h, w, 3)
    p.wait()


def triangulate(drive, tracks_dir, frames_wanted, t0, t1, max_pts=150000):
    """KLT tracks → world points: least-squares ray intersection, kept when the rays meet within 0.4 % of the range,
    the baseline angle is ≥ 3° and the point is 1–80 m from every camera that saw it."""
    out = []
    for cam in CAMS:
        z = np.load(os.path.join(tracks_dir, f"tr-{cam}.npz")); W, H, sc = int(z["w"]), int(z["h"]), float(z["scale"])
        ts = drive.ts[cam]; fi = z["fi"]; tref = np.array([drive.ref_time(cam, ts[min(i, len(ts) - 1)]) for i in range(len(ts))])
        keep = (fi < len(ts)) & (tref[np.minimum(fi, len(ts) - 1)] >= t0) & (tref[np.minimum(fi, len(ts) - 1)] <= t1)
        tid, fi, x, y = z["tid"][keep], fi[keep], z["x"][keep], z["y"][keep]
        # every 2nd frame is plenty; rays in car axes then world
        sel = fi % 2 == 0; tid, fi, x, y = tid[sel], fi[sel], x[sel], y[sel]
        d = fisheye_ray(cam, np.stack([x, y], 1).astype(np.float64), W, H)  # tracks are in 1448-wide pixels; rig is in 0..1
        poses = {}
        for f in np.unique(fi):
            R, T = drive.car_pose(tref[f]); poses[f] = (S @ R, S @ (R @ np.array(drive_rig_pos(cam)) + T))
        Rw = np.stack([poses[f][0] for f in fi]); C = np.stack([poses[f][1] for f in fi])
        dw = np.einsum("nij,nj->ni", Rw, d)
        order = np.argsort(tid, kind="stable"); tid, dw, C = tid[order], dw[order], C[order]
        starts = np.flatnonzero(np.r_[True, tid[1:] != tid[:-1]]); ends = np.r_[starts[1:], len(tid)]
        n_ok = 0
        for a, b in zip(starts, ends):
            if b - a < 4: continue
            D, O = dw[a:b], C[a:b]
            if np.degrees(np.arccos(np.clip(D[0] @ D[-1], -1, 1))) < 3: continue
            A = np.zeros((3, 3)); r = np.zeros(3)
            for di, oi in zip(D, O):
                P = np.eye(3) - np.outer(di, di); A += P; r += P @ oi
            X = np.linalg.solve(A, r); v = X - O; rng = np.linalg.norm(v, axis=1)
            if rng.min() < 1 or rng.max() > 80 or (np.einsum("ij,ij->i", v, D) <= 0).any(): continue
            perp = np.linalg.norm(v - np.einsum("ij,ij->i", v, D)[:, None] * D, axis=1)
            if (perp / rng).max() > 0.004: continue
            out.append(X); n_ok += 1
        print(f"  {cam}: {n_ok} triangulated points", file=sys.stderr)
    P = np.array(out)
    if len(P) > max_pts: P = P[np.random.default_rng(0).choice(len(P), max_pts, replace=False)]
    return P


def drive_rig_pos(cam):
    from common import RIG
    return RIG[cam]["pos"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", required=True); ap.add_argument("--sei", required=True); ap.add_argument("--tracks", required=True)
    ap.add_argument("--out", required=True); ap.add_argument("--t0", type=float, default=4); ap.add_argument("--t1", type=float, default=20)
    ap.add_argument("--every", type=int, default=3); ap.add_argument("--no-delay", action="store_true")
    a = ap.parse_args()
    drive = Drive(a.sei, a.t0, use_delay=not a.no_delay)
    for d in ["images", "masks", "sparse/0"]: os.makedirs(os.path.join(a.out, d), exist_ok=True)
    cams_txt, imgs_txt, meta = [], [], []
    img_id = 0
    for ci, cam in enumerate(CAMS):
        W, H, f, _ = view(cam)
        cams_txt.append(f"{ci + 1} PINHOLE {W} {H} {f:.4f} {f:.4f} {W / 2:.4f} {H / 2:.4f}")
        clip = glob.glob(os.path.join(a.clips, f"*-{cam}.mp4"))[0]
        mx = my = ok = None; ts = drive.ts[cam]; k = 0
        for i, img in enumerate(decode(clip, 1448)):
            if i >= len(ts): break
            tr = drive.ref_time(cam, ts[i])
            if tr < a.t0 or tr > a.t1: continue
            k += 1
            if (k - 1) % a.every: continue
            if mx is None:
                mx, my, ok = remap_tables(cam, img.shape[1], img.shape[0])
                cv2.imwrite(os.path.join(a.out, f"mask-{cam}.png"), ok.astype(np.uint8) * 255)
            v = cv2.remap(img, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
            name = f"{cam}_{i:05d}.jpg"
            cv2.imwrite(os.path.join(a.out, "images", name), v, [cv2.IMWRITE_JPEG_QUALITY, 95])
            cv2.imwrite(os.path.join(a.out, "masks", name.replace(".jpg", ".png")), ok.astype(np.uint8) * 255)
            Rw, C = drive.cam_to_world(cam, tr); Rcw = Rw.T; t = -Rcw @ C; q = qvec(Rcw)
            img_id += 1
            imgs_txt.append(f"{img_id} {q[0]:.9f} {q[1]:.9f} {q[2]:.9f} {q[3]:.9f} {t[0]:.6f} {t[1]:.6f} {t[2]:.6f} {ci + 1} {name}\n")
            meta.append(dict(name=name, cam=cam, frame=i, t_clip=float(ts[i]), t_ref=float(tr), R=Rw.tolist(), C=C.tolist()))
        print(f"{cam}: {sum(m['cam'] == cam for m in meta)} frames", file=sys.stderr)
    P = triangulate(drive, a.tracks, None, a.t0, a.t1)
    with open(os.path.join(a.out, "sparse/0/cameras.txt"), "w") as fh: fh.write("\n".join(cams_txt) + "\n")
    with open(os.path.join(a.out, "sparse/0/images.txt"), "w") as fh: fh.write("".join(m + "\n" for m in imgs_txt))  # 2nd line: no 2D points
    with open(os.path.join(a.out, "sparse/0/points3D.txt"), "w") as fh:
        for j, p in enumerate(P): fh.write(f"{j + 1} {p[0]:.4f} {p[1]:.4f} {p[2]:.4f} 128 128 128 0\n")
    import json
    json.dump(dict(t0=a.t0, t1=a.t1, every=a.every, delay=not a.no_delay, views=VIEW, frames=meta), open(os.path.join(a.out, "frames.json"), "w"))
    print(f"{len(meta)} images, {len(P)} initial points → {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
