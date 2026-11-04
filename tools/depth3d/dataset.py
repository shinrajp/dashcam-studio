"""dataset.py — one stretch of a six-camera drive as level pinhole views with known poses (the prototype's make_dataset.py
without the splat experiment's KLT point cloud, which depth does not need).

Each chosen fisheye frame is re-rendered as a level pinhole view (rig.VIEW) through the measured lens; pixels showing the car's
own body or beyond the lens's measured reach are masked out (masks/, white = use). Poses: js/rig.js mounting × the car's path
from the front file's telemetry at the moment that frame shows (its file clock from clockOffsets + its telemetry delay).

Frames are picked on one time grid for all cameras (t0, t0 + dt, … ≤ t1 on the front clock): per grid time and camera the
frame showing the nearest moment, so step k of every camera is the same moment (the prototype took every n-th frame per
camera, which only lines up when the files' clocks agree).

Writes <data>/images/<name>.jpg, masks/<name>.png, mask-<cam>.png and frames.json:
  { t0, t1, dt, views, cams, steps, frames: [{ name, cam, step, frame, t_clip, t_ref, R, C, f, cx, cy, w, h }] }
"""
import json, os
import numpy as np, cv2
from rig import CAMS, VIEW
from video import frames as decode


def pick(drive, cam, ftimes, grid):
    """per grid time, the frame index whose picture shows the nearest moment (None when beyond the clip by > a frame)."""
    tr = np.array([drive.ref_time(cam, t) for t in ftimes]); out = []
    dt = np.median(np.diff(tr)) if len(tr) > 1 else 0.03
    for g in grid:
        i = int(np.argmin(np.abs(tr - g))); out.append(i if abs(tr[i] - g) <= dt else None)
    return out


def build(drive, clips, ftimes, t0, t1, dt, out, src_width=1448, log=print):
    rig = drive.rig
    for d in ["images", "masks"]: os.makedirs(os.path.join(out, d), exist_ok=True)
    grid = list(np.arange(t0, t1 + 1e-6, dt))
    cams = [c for c in CAMS if c in clips]
    choice = {c: pick(drive, c, ftimes[c], grid) for c in cams}
    keep = [k for k in range(len(grid)) if all(choice[c][k] is not None for c in cams)]
    if len(keep) < len(grid): log(f"  {len(grid) - len(keep)} of {len(grid)} time steps dropped: not every camera has a frame there")
    if not keep: raise SystemExit("no time step in [t0, t1] that every camera covers — check --t0/--t1 against the clip length")
    meta = []
    for cam in cams:
        W, H, f, _ = rig.view(cam)
        want = {choice[cam][k]: s for s, k in enumerate(keep)}
        mx = my = ok = None
        for i, img in decode(clips[cam], src_width, stop=max(want) + 1):
            if i not in want: continue
            if mx is None:
                mx, my, ok = rig.remap_tables(cam, img.shape[1], img.shape[0])
                cv2.imwrite(os.path.join(out, f"mask-{cam}.png"), ok.astype(np.uint8) * 255)
            v = cv2.remap(img, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
            name = f"{cam}_{i:05d}.jpg"
            cv2.imwrite(os.path.join(out, "images", name), v, [cv2.IMWRITE_JPEG_QUALITY, 95])
            cv2.imwrite(os.path.join(out, "masks", name.replace(".jpg", ".png")), ok.astype(np.uint8) * 255)
            tr = drive.ref_time(cam, ftimes[cam][i]); Rw, C = drive.cam_to_world(cam, tr)
            meta.append(dict(name=name, cam=cam, step=want[i], frame=i, t_clip=float(ftimes[cam][i]), t_ref=float(tr), t_grid=float(grid[keep[want[i]]]),
                             R=Rw.tolist(), C=C.tolist(), f=f, cx=W / 2, cy=H / 2, w=W, h=H))
        n = sum(m["cam"] == cam for m in meta)
        if n < len(keep): raise SystemExit(f"{cam}: decoded only {n} of {len(keep)} frames — the clip is shorter than its telemetry says")
        log(f"  {cam}: {n} views")
    meta.sort(key=lambda m: (m["step"], cams.index(m["cam"])))
    d = dict(t0=t0, t1=t1, dt=dt, views=VIEW, cams=cams, steps=len(keep), frames=meta)
    json.dump(d, open(os.path.join(out, "frames.json"), "w"))
    return d
