"""fuse.py — seams between cameras (the prototype's fuse2.py, as functions).

1. Road snap: depth points within 0.30 m of the road plane (and 0.6–1.6× its depth) take the plane's exact depth.
   Road growing (roadgrow.py): far road the AI depth squashes is grown by colour from the near road, never inside vehicle boxes.
2. Seam disagreement of off-road overlap points is measured and printed (the prototype's per-camera scale solve measured no
   gain on 10-19 and was never applied, so it is left out).
3. Soft ownership: a camera's weight falls from 1 to 0 as its score goes from the best camera's to 1.12× it, so overlapping
   cameras blend over a band; in the band a point moves along its own ray onto the best other camera's surface. Weights go
   out as an 8-bit grid next to the depth. Mesh rows are dense near each camera's horizon (a camera 1 m up sees all road past
   10 m within ~5° of it).
Out (per frame, in dst): <name>.npy, <name>.png (uint16 cm), <name>_w.png, <name>_rows.json, <name>.jpg; frames.json.
"""
import json, os, shutil
import numpy as np, cv2
from roadgrow import grow

SNAP, BAND = 0.30, 1.12


def _rays(f):
    W, H = f["w"], f["h"]; uu, vv = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    return np.stack([(uu - f["cx"]) / f["f"], (vv - f["cy"]) / f["f"], np.ones_like(uu)], -1)


class Fuser:
    def __init__(self, data, src, vboxes=None, grow_road=True, road_own=True):
        self.data, self.src, self.VB, self.GROW, self.ROADOWN = data, src, vboxes or {}, grow_road, road_own
        d = json.load(open(os.path.join(src, "frames.json"))); self.d = d
        self.cams = d["cams"]; self.by = {c: [f for f in d["frames"] if f["cam"] == c] for c in self.cams}; self.NC = len(self.cams)
        self.RAYS = {c: _rays(self.by[c][0]) for c in self.cams}; self.grown = 0

    def mask(self, f):
        p = os.path.join(self.data, "masks", f["name"].replace(".jpg", ".png"))
        return cv2.imread(p, cv2.IMREAD_GRAYSCALE) > 127 if os.path.exists(p) else np.ones((f["h"], f["w"]), bool)

    def load(self, k):
        out = []
        for c in self.cams:
            f = self.by[c][k]; Z = np.load(os.path.join(self.src, f["name"].replace(".jpg", ".npy"))); R, C = np.array(f["R"]), np.array(f["C"])
            wy = self.RAYS[c] @ R[1]
            with np.errstate(divide="ignore", invalid="ignore"): Zr = np.where(wy > 1e-4, -C[1] / wy, np.inf)
            y = C[1] + Z * wy
            with np.errstate(divide="ignore", invalid="ignore"):
                snap = (Z > 0) & (np.abs(y) < SNAP) & (Zr < 80) & (Z / Zr > 0.6) & (Z / Zr < 1.6)
            m = self.mask(f)
            if self.GROW:
                veh = np.zeros_like(snap)
                for x0, y0, x1, y1 in self.VB.get(f["name"], []): veh[max(0, y0):max(0, y1), max(0, x0):max(0, x1)] = True
                g = grow(cv2.imread(os.path.join(self.data, "images", f["name"])), Z, Zr, snap, m & ~veh)
                self.grown += int((g & ~snap).sum()); snap = g
            out.append(dict(f=f, R=R, C=C, Z=np.where(snap, Zr, Z), snap=snap, m=m))
        return out

    @staticmethod
    def project(g, pts):
        q = (pts - g["C"]) @ g["R"]; z = q[:, 2]; good = z > 0.3; f = g["f"]
        zz = np.where(good, z, 1); u = f["cx"] + f["f"] * q[:, 0] / zz; v = f["cy"] + f["f"] * q[:, 1] / zz
        inside = good & (u >= 0) & (u < f["w"]) & (v >= 0) & (v < f["h"])
        ui, vi = np.clip(u.astype(int), 0, f["w"] - 1), np.clip(v.astype(int), 0, f["h"] - 1)
        inside &= g["m"][vi, ui]
        return inside, z, u, v, ui, vi

    def points(self, g, sel):
        return g["C"] + (self.RAYS[g["f"]["cam"]][sel] * g["Z"][sel][:, None]) @ g["R"].T

    def pair_ratios(self, row):
        """median log(depth_j / depth of i's point in j) per overlapping pair, off-road points only, and the spread."""
        eqs, dis = [], []
        for i, a in enumerate(row):
            sel = (a["Z"] > 0) & ~a["snap"]; sel[::2, :] = False; sel[:, ::2] = False
            if sel.sum() < 50: continue
            P = self.points(a, sel)
            for j, b in enumerate(row):
                if j == i: continue
                inside, z, u, v, ui, vi = self.project(b, P)
                zj = b["Z"][vi, ui]; ok = inside & (zj > 0) & ~b["snap"][vi, ui]
                r = np.log(zj[ok] / z[ok]); r = r[np.abs(r) < np.log(1.6)]
                if len(r) < 200: continue
                eqs.append((i, j, float(np.median(r)), len(r))); dis.append(np.abs(np.exp(r) - 1))
        return eqs, (np.median(np.concatenate(dis)) if dis else np.nan)

    def run(self, dst, gw=160, log=print):
        os.makedirs(dst, exist_ok=True)
        cams, NC, steps = self.cams, self.NC, self.d["steps"]
        after, SEAM = [], []   # (the prototype's per-camera scale solve measured no gain on 10-19 and was not applied: left out)
        for k in range(steps):
            row = self.load(k)
            _, dis = self.pair_ratios(row); after.append(dis)
            for i, a in enumerate(row):
                f = a["f"]; ok = a["Z"] > 0; pts = self.points(a, ok); rd = a["snap"][ok]
                sc = np.full((NC, len(pts)), np.inf)
                for j, b in enumerate(row):
                    inside, z, u, v, ui, vi = self.project(b, pts)
                    if j != i:
                        zj = b["Z"][vi, ui]; inside &= (zj > 0) & (zj >= 0.85 * z) & (zj <= 1.25 * z)
                        if self.ROADOWN: inside &= ~rd | b["snap"][vi, ui]
                    r2 = ((u - b["f"]["cx"]) / (b["f"]["w"] / 2)) ** 2 + ((v - b["f"]["cy"]) / (b["f"]["h"] / 2)) ** 2
                    s = np.linalg.norm(pts - b["C"], axis=1) / b["f"]["f"] * (1 + 0.5 * r2)
                    sc[j] = np.where(inside, s, np.inf)
                own = np.where(np.isfinite(sc[i]), sc[i], np.linalg.norm(pts - a["C"], axis=1) / f["f"])
                best = np.minimum(sc.min(0), own)
                wgt = np.clip((BAND * best - own) / ((BAND - 1) * best), 0, 1)
                sco = sc.copy(); sco[i] = np.inf; jb = sco.argmin(0); has = np.isfinite(sco.min(0)) & (wgt < 1) & (wgt > 0)
                znew = a["Z"][ok].copy()
                for j in range(NC):
                    m = has & (jb == j)
                    if not m.any(): continue
                    b = row[j]; inside, z, u, v, ui, vi = self.project(b, pts[m]); zj = b["Z"][vi, ui]
                    Pj = b["C"] + (self.RAYS[b["f"]["cam"]][vi, ui] * zj[:, None]) @ b["R"].T
                    zi = ((Pj - a["C"]) @ a["R"])[:, 2]
                    good = inside & (zj > 0) & (zi > 0.3) & (np.abs(np.log(np.maximum(zi, 1e-3) / znew[m])) < np.log(1.6))
                    w_ = wgt[m]; zz = znew[m]; zz[good] = w_[good] * zz[good] + (1 - w_[good]) * zi[good]; znew[m] = zz
                    SEAM.append(np.abs(zi[good] / a["Z"][ok][m][good] - 1))
                a["Z"][ok] = znew
                W = np.zeros(a["Z"].shape, np.float32); W[ok] = wgt
                Z = np.where(W > 0, a["Z"], 0).astype(np.float32)
                np.save(os.path.join(dst, f["name"].replace(".jpg", ".npy")), Z)
                vh = f["cy"] + f["f"] * (-a["R"][1][2] / a["R"][1][1]) if abs(a["R"][1][1]) > 1e-6 else -1e9
                rows, v = [], 1.0
                while v < f["h"]:
                    rows.append(v); v += 2.0 if vh - 30 <= v <= vh + 60 else 6.0
                ri = np.clip(np.array(rows).astype(int), 0, f["h"] - 1); ci = np.clip(((np.arange(gw) + 0.5) * f["w"] / gw).astype(int), 0, f["w"] - 1)
                Zg = np.where(Z > 0, Z, np.nan)[ri][:, ci]
                Wg = cv2.blur(W, (6, 3))[ri][:, ci]
                json.dump([round(float(r), 1) for r in rows], open(os.path.join(dst, f["name"].replace(".jpg", "_rows.json")), "w"))
                cv2.imwrite(os.path.join(dst, f["name"].replace(".jpg", ".png")), np.nan_to_num(np.clip(Zg * 100, 0, 65535)).astype(np.uint16))
                cv2.imwrite(os.path.join(dst, f["name"].replace(".jpg", "_w.png")), (np.clip(Wg, 0, 1) * 255).astype(np.uint8))
                shutil.copy(os.path.join(self.src, f["name"]), os.path.join(dst, f["name"]))
        shutil.copy(os.path.join(self.src, "frames.json"), os.path.join(dst, "frames.json"))
        seam = np.median(np.concatenate(SEAM)) * 100 if SEAM and sum(map(len, SEAM)) else float("nan")
        stats = dict(seam_band_pct=seam, seam_pct=np.nanmedian(after) * 100 if np.isfinite(after).any() else float("nan"), grown_px=self.grown)
        log(f"  in the blend bands, the two cameras' surfaces were {stats['seam_band_pct']:.1f} % apart (median); now they meet")
        log(f"  seam disagreement, off-road overlap points: {stats['seam_pct']:.1f} %")
        log(f"  road grown beyond the AI snap: {self.grown} pixels")
        return stats


def run(data, src, dst, vboxes=None, grow_road=True, road_own=True, log=print):
    return Fuser(data, src, vboxes, grow_road, road_own).run(dst, log=log)
