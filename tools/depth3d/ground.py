"""ground.py — one top-down picture of the road under and around the car for the whole stretch, from every moment's views.

The road is still while the car drives over it, so a spot one camera can't see now (behind the bumper, under the car, between
two cameras' views, behind a passing car) was usually filmed by another camera a moment earlier or later. Each cell of a grid
on the road plane (world y = 0) takes the sharpest view of it that any camera had at any time step (nearest camera), but only
where that camera's fused depth says it really sees the road there (not a car or a post in front of it).
What no camera ever saw stays a hole; holes near the car's path are what fill.py hands to the diffusion model.

    python ground.py <work folder of build.py> [--res 0.08] [--margin 22] [--near 8]
    python ground.py <work folder> --export <page folder>      (after fill_sd.py: the layer files for the replay page)

Writes <work>/ground/: real.png (seen road, RGBA: alpha 0 = never seen), hole.png (white = to fill: never seen and within
--near metres of the car's path), meta.json (extent in world metres, resolution, coverage). World: x right, y down, z forward
(car at the start of the stretch), as frames.json.
"""
import argparse, json, os, sys
import numpy as np, cv2


def export(work, page):
    """fill.png / est.png → <page>/ground.jpg (the layer), ground-mark.jpg (estimated part tinted blue and hatched),
    ground-alpha.png (where the layer is drawn), ground.json (extent and how much is estimated)."""
    g = os.path.join(work, "ground"); meta = json.load(open(os.path.join(g, "meta.json")))
    f = cv2.imread(os.path.join(g, "fill.png"), cv2.IMREAD_UNCHANGED)
    if f is None: f = cv2.imread(os.path.join(g, "real.png"), cv2.IMREAD_UNCHANGED)
    e = cv2.imread(os.path.join(g, "est.png"), cv2.IMREAD_GRAYSCALE); e = e > 127 if e is not None else np.zeros(f.shape[:2], bool)
    rgb = f[:, :, :3].copy(); cv2.imwrite(os.path.join(page, "ground.jpg"), rgb, [cv2.IMWRITE_JPEG_QUALITY, 88])
    yy, xx = np.mgrid[:rgb.shape[0], :rgb.shape[1]]; hatch = ((xx + yy) // 4) % 4 == 0
    mk = rgb.astype(np.float32); mk[e] = mk[e] * 0.55 + np.array([200, 110, 30]) * 0.45    # BGR: blue
    mk[e & hatch] = mk[e & hatch] * 0.6 + 255 * 0.4
    cv2.imwrite(os.path.join(page, "ground-mark.jpg"), mk.clip(0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 88])
    cv2.imwrite(os.path.join(page, "ground-alpha.png"), (f[:, :, 3] > 127).astype(np.uint8) * 255)
    out = {k: meta[k] for k in ("x0", "x1", "z0", "z1", "res")}
    out.update(estimated_m2=round(meta.get("estimated_m2", 0.0), 1), real_m2=round(float(((f[:, :, 3] > 127) & ~e).sum() * meta["res"] ** 2), 1),
               fill_model=meta.get("fill_model"))
    json.dump(out, open(os.path.join(page, "ground.json"), "w"))
    print(f"ground layer → {page}: {out['real_m2']:.0f} m² real footage from other moments, {out['estimated_m2']:.0f} m² estimated")


def main(argv=None):
    if argv is None and "--export" in sys.argv:
        i = sys.argv.index("--export"); return export(sys.argv[1], sys.argv[i + 1])
    ap = argparse.ArgumentParser(); ap.add_argument("work")
    ap.add_argument("--res", type=float, default=0.08, help="metres per pixel")
    ap.add_argument("--margin", type=float, default=22, help="metres round the cameras' path")
    ap.add_argument("--near", type=float, default=8, help="fill holes up to this far from the car's path (m)")
    ap.add_argument("--reach", type=float, default=18, help="use a camera's view of the road up to this far (m)")
    a = ap.parse_args(argv)
    fused = os.path.join(a.work, "fused"); out = os.path.join(a.work, "ground"); os.makedirs(out, exist_ok=True)
    F = json.load(open(os.path.join(fused, "frames.json")))["frames"]
    Cs = np.array([f["C"] for f in F])
    x0, x1 = Cs[:, 0].min() - a.margin, Cs[:, 0].max() + a.margin
    z0, z1 = Cs[:, 2].min() - a.margin, Cs[:, 2].max() + a.margin
    W, H = int(np.ceil((x1 - x0) / a.res)), int(np.ceil((z1 - z0) / a.res))
    xs = x0 + (np.arange(W) + 0.5) * a.res; zs = z1 - (np.arange(H) + 0.5) * a.res      # row 0 = farthest forward
    X, Zw = np.meshgrid(xs, zs); P = np.stack([X.ravel(), np.zeros(X.size), Zw.ravel()], 1)
    vb_path = os.path.join(a.work, "vboxes.json"); VB = json.load(open(vb_path)) if os.path.exists(vb_path) else {}
    best = np.full(X.size, np.inf, np.float32); rgb = np.zeros((X.size, 3), np.uint8); step = np.full(X.size, -1, np.int16)
    for f in F:
        Z = np.load(os.path.join(fused, f["name"].replace(".jpg", ".npy")))
        tex = cv2.imread(os.path.join(fused, f["name"])); th, tw = tex.shape[:2]
        R, C = np.array(f["R"]), np.array(f["C"])
        near = np.hypot(P[:, 0] - C[0], P[:, 2] - C[2]) < a.reach
        idx = np.flatnonzero(near); q = (P[idx] - C) @ R; z = q[:, 2]
        ok = z > 0.3; idx, q, z = idx[ok], q[ok], z[ok]
        u = f["cx"] + f["f"] * q[:, 0] / z; v = f["cy"] + f["f"] * q[:, 1] / z
        ok = (u >= 0) & (u < f["w"] - 1) & (v >= 0) & (v < f["h"] - 1); idx, z, u, v = idx[ok], z[ok], u[ok], v[ok]
        zf = Z[v.astype(int), u.astype(int)]
        ok = (zf > 0) & (np.abs(zf - z) < 0.15 + 0.01 * z)            # the camera sees the road there, nothing in front
        if VB.get(f["name"]):                                           # not a parked car's lower body flattened onto the road
            veh = np.zeros((f["h"], f["w"]), bool)
            for x0b, y0b, x1b, y1b in VB[f["name"]]: veh[max(0, y0b):max(0, y1b), max(0, x0b):max(0, x1b)] = True
            ok &= ~veh[v.astype(int), u.astype(int)]
        idx, z, u, v = idx[ok], z[ok], u[ok], v[ok]
        d = np.linalg.norm(P[idx] - C, axis=1)
        win = d < best[idx]; idx, u, v, d = idx[win], u[win], v[win], d[win]
        best[idx] = d; step[idx] = f["step"]
        rgb[idx] = tex[np.clip((v * th / f["h"]).astype(int), 0, th - 1), np.clip((u * tw / f["w"]).astype(int), 0, tw - 1)]
    seen = np.isfinite(best).reshape(H, W)
    img = rgb.reshape(H, W, 3)
    # the car's path (front camera positions → middle of the car) and the area near it
    path = np.zeros((H, W), np.uint8)
    pc = [(f["C"][0], f["C"][2] - 1.4) for f in F if f["cam"] == "front"]
    pts = np.array([[(x - x0) / a.res, (z1 - z) / a.res] for x, z in pc], np.int32)
    cv2.polylines(path, [pts], False, 255, 1)
    dist = cv2.distanceTransform(255 - path, cv2.DIST_L2, 5) * a.res
    # seen pixels that are isolated specks (a single far view) are not trusted: open the seen mask a little
    seen = cv2.morphologyEx(seen.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)).astype(bool)
    hole = (~seen) & (dist < a.near)
    keep = seen & (dist < a.near + 2)                              # farther out the per-moment 3D shows it already
    rgba = np.dstack([img, keep.astype(np.uint8) * 255])
    cv2.imwrite(os.path.join(out, "real.png"), rgba); cv2.imwrite(os.path.join(out, "hole.png"), hole.astype(np.uint8) * 255)
    near_area = dist < a.near
    meta = dict(x0=x0, x1=x1, z0=z0, z1=z1, res=a.res, w=W, h=H, near=a.near,
                seen_near=float(seen[near_area].mean()), hole_px=int(hole.sum()), hole_m2=float(hole.sum() * a.res ** 2))
    json.dump(meta, open(os.path.join(out, "meta.json"), "w"), indent=1)
    print(f"ground {W}×{H} px ({x1 - x0:.0f} × {z1 - z0:.0f} m at {a.res} m/px); within {a.near} m of the path "
          f"{meta['seen_near'] * 100:.0f} % seen by some camera at some moment; to fill: {meta['hole_m2']:.0f} m²")
    return meta


if __name__ == "__main__":
    main()
