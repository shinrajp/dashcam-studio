"""delay.py — each camera's telemetry delay (its pictures' lag behind the telemetry; video t + delay = telemetry t) from the
clip itself, with the rig held fixed.

tools/rig/calibrate.py fits the delay together with the lens and angles (minutes per camera). Here the rig is known, so the
delay is a 1-D search: points are tracked across frames (pyramidal Lucas-Kanade with a forward-backward check, as
tools/rig/tracks.py), and for each trial delay the car's move between two frames comes from the front file's telemetry
path at those frames' moments; static points must then lie on the epipolar plane of the camera's move. The delay with the
smallest robust (Cauchy) epipolar error wins, refined by a parabola. Only frames where the car accelerates or turns can
tell delays apart; when the error curve is too flat (parked, steady straight driving) the camera gets 0 and a warning.
"""
import math, sys
import numpy as np, cv2
from video import frames

LK = dict(winSize=(21, 21), maxLevel=4, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))


def track(clip, first, last, w=724, max_pts=500, fb_max=0.7):
    """KLT tracks of frames first..last (inclusive): list per frame of (ids, xy) in 0..1 of the picture."""
    out, prev, pts, ids, nxt = {}, None, np.zeros((0, 2), np.float32), np.zeros(0, np.int64), 0
    for fi, g in frames(clip, w, gray=True, stop=last + 1):
        if fi < first: continue
        h = g.shape[0]
        if prev is not None and len(pts):
            p1, st, _ = cv2.calcOpticalFlowPyrLK(prev, g, pts, None, **LK)
            p0, st2, _ = cv2.calcOpticalFlowPyrLK(g, prev, p1, None, **LK)
            fb = np.linalg.norm(p0 - pts, axis=1)
            ok = (st[:, 0] == 1) & (st2[:, 0] == 1) & (fb < fb_max) & (p1[:, 0] >= 0) & (p1[:, 1] >= 0) & (p1[:, 0] < w) & (p1[:, 1] < h)
            pts, ids = p1[ok], ids[ok]
        if len(pts) < max_pts * 0.8:
            mask = np.full(g.shape, 255, np.uint8)
            for x, y in pts: cv2.circle(mask, (int(x), int(y)), 10, 0, -1)
            c = cv2.goodFeaturesToTrack(g, max_pts - len(pts), 0.01, 10, mask=mask, blockSize=7)
            if c is not None:
                c = c.reshape(-1, 2).astype(np.float32)
                pts = np.vstack([pts, c]); ids = np.concatenate([ids, np.arange(nxt, nxt + len(c))]); nxt += len(c)
        out[fi] = (ids.copy(), (pts + 0.5) / np.array([w, h], np.float32))
        prev = g
    return out


def pairs(tracks, ftimes, clock, path, min_move=0.6, min_turn=1.5):
    """frame pairs (i, j) the car moved ≥ min_move m or turned ≥ min_turn° between, with their common points."""
    keys = sorted(tracks); out = []
    for a in range(0, len(keys) - 1, 2):
        i = keys[a]
        if np.interp(ftimes[i] + clock, path.t, path.speed) < 1.0: continue
        j = None
        for b in range(a + 1, min(len(keys), a + 20)):
            R, T = path.rel(ftimes[i] + clock, ftimes[keys[b]] + clock)
            if np.linalg.norm(T) >= min_move or abs(math.degrees(math.atan2(R[0, 2], R[0, 0]))) >= min_turn: j = keys[b]; break
        if j is None: continue
        ci, ia, ib = np.intersect1d(tracks[i][0], tracks[j][0], return_indices=True)
        if len(ci) < 20: continue
        out.append((i, j, tracks[i][1][ia], tracks[j][1][ib]))
    return out


def epipolar_cost(rig, cam, prs, ftimes, clock, path, d, scale=0.002):
    """robust epipolar error (radians, Cauchy with `scale`) of every pair at trial delay d."""
    P = rig.pos(cam); tot, n = 0.0, 0
    for i, j, x0, x1, b0, b1 in prs:
        R, T = path.rel(ftimes[i] + clock + d, ftimes[j] + clock + d)
        t = R @ P + T - P; nt = np.linalg.norm(t)
        if nt < 1e-3: continue
        b1w = b1 @ R.T; nrm = np.cross(t / nt, b1w); nn = np.linalg.norm(nrm, axis=1)
        r = np.einsum("ij,ij->i", b0, nrm) / np.maximum(nn, 1e-9)
        tot += float(np.sum(np.log1p((r / scale) ** 2))); n += len(r)
    return tot / max(n, 1)


def fit(rig, cam, clip, ftimes, clock, path, t_lo, t_hi, span=0.2, step=0.005, log=print):
    """→ (delay s, info dict). t_lo, t_hi: the stretch of front time to use."""
    idx = [i for i, t in enumerate(ftimes) if t_lo <= t + clock <= t_hi]
    if len(idx) < 30: return 0.0, dict(ok=False, why="too few frames")
    tr = track(clip, idx[0], idx[-1])
    prs = pairs(tr, ftimes, clock, path)
    if len(prs) < 15: return 0.0, dict(ok=False, why=f"only {len(prs)} frame pairs with motion")
    # bearings once; drop points on the car's own body or beyond the lens's measured reach (they don't move with the road)
    prs2, thmax = [], rig.cams[cam]["thmax"] * 1.05 * math.pi / 180
    for i, j, x0, x1 in prs:
        b0 = rig.fisheye_ray(cam, x0.astype(float), 1, 1); b1 = rig.fisheye_ray(cam, x1.astype(float), 1, 1)
        ax = rig.R(cam)[:, 2]; ok = (b0 @ ax > math.cos(thmax)) & ~rig.is_body(cam, b0) & ~rig.is_body(cam, b1)
        if ok.sum() >= 15: prs2.append((i, j, x0[ok], x1[ok], b0[ok], b1[ok]))
    return search(rig, cam, prs2, ftimes, clock, path, span, step)


def search(rig, cam, prs, ftimes, clock, path, span=0.2, step=0.005):
    """1-D search of the delay over prepared pairs (i, j, x0, x1, b0, b1) → (delay, info)."""
    prs2 = prs
    ds = np.arange(-span, span + 1e-9, step)
    cost = np.array([epipolar_cost(rig, cam, prs2, ftimes, clock, path, d) for d in ds])
    k = int(np.argmin(cost)); d = float(ds[k])
    if 0 < k < len(ds) - 1:
        c0, c1, c2 = cost[k - 1], cost[k], cost[k + 1]; den = c0 - 2 * c1 + c2
        if den > 0: d += 0.5 * step * (c0 - c2) / den
    contrast = float((np.median(cost) - cost[k]) / max(cost[k], 1e-12))
    info = dict(pairs=len(prs2), contrast=round(contrast, 3), edge=k in (0, len(ds) - 1))
    if info["edge"] or contrast < 0.03:
        info.update(ok=False, why="error curve too flat or minimum on the search edge"); return 0.0, info
    info["ok"] = True
    return round(d, 4), info
