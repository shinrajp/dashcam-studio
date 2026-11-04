"""Road grow: the AI depth squashes far road (30–60 m reads 10–20 m), so it fails the road snap. Grow the snapped near road into
connected pixels below the horizon that look like the same road surface (colour close to the snapped road's, in Lab, Mahalanobis,
on a blurred picture) and whose AI depth isn't far nearer than the road plane would put them (an upright close by). They get the
road plane's depth."""
import numpy as np, cv2
def grow(im, Z, Zr, snap, ok_mask, thr=3.0, near=0.25, zmin=12):
    H, W = Z.shape
    lab = cv2.cvtColor(cv2.GaussianBlur(cv2.resize(im, (W, H)), (0, 0), 2), cv2.COLOR_BGR2LAB).astype(np.float32)
    ref = lab[snap & (Zr < 15)]
    if len(ref) < 500: return snap
    mu = ref.mean(0); cov = np.cov(ref.T) + np.eye(3) * 4; ic = np.linalg.inv(cov)
    dlt = lab - mu; md = np.sqrt(np.einsum("hwi,ij,hwj->hw", dlt, ic, dlt))
    cand = (md < thr) & np.isfinite(Zr) & (Zr > zmin) & (Zr < 200) & ok_mask & (Z > 0) & (Z > near * Zr)
    cand |= snap
    n, lbl = cv2.connectedComponents(cand.astype(np.uint8), connectivity=4)
    keep = np.zeros(n, bool); keep[np.unique(lbl[snap])] = True; keep[0] = False
    return keep[lbl]
