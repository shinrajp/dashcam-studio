"""Bird's-eye map: camera coverage + every vehicle detected at a few moments, placed on the road, defaults vs fitted."""
import json, sys, numpy as np, copy
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from matplotlib.patches import Wedge, Rectangle
sys.path.insert(0, "."); from geo import *
D = json.load(open("dets.json")); F = json.load(open("fitted.json"))
FIT = copy.deepcopy(DEFAULTS)
for c in CAMS: FIT[c].update({k: F[c][k] for k in ("yaw", "pitch", "fov")})
COL = {"front": "#e6b450", "left_pillar": "#59c2ff", "right_pillar": "#ff8f40", "left_repeater": "#95e6cb", "right_repeater": "#f07178", "back": "#d2a6ff"}
NAME = {"front": "Front", "left_pillar": "Left pillar", "right_pillar": "Right pillar", "left_repeater": "Left repeater", "right_repeater": "Right repeater", "back": "Rear"}
TIMES = [float(a) for a in (sys.argv[1].split(",") if len(sys.argv) > 1 else ["11.0", "20.0", "33.0", "47.0"])]
def whole(d): return d[0] > 0.004 and d[0] + d[2] < 0.996 and d[1] + d[3] < 0.995
fig, axs = plt.subplots(1, 2, figsize=(14, 7.6), facecolor="#0e1116")
for ax, (C, title) in zip(axs, [(DEFAULTS, "App defaults"), (FIT, "Fitted on this clip")]):
    ax.set_facecolor("#0e1116"); ax.set_aspect("equal"); ax.set_xlim(-22, 22); ax.set_ylim(-22, 26)
    for sp in ax.spines.values(): sp.set_color("#333")
    ax.tick_params(colors="#888"); ax.set_title(title, color="#ddd", fontsize=13)
    ax.grid(color="#222", lw=0.6)
    for c in CAMS:   # coverage: the camera's horizontal field of view, from where it is mounted, out to 20 m
        g = C[c]; x, z = g["pos"][0], g["pos"][2]
        ax.add_patch(Wedge((x, z), 20, 90 - (g["yaw"] + g["fov"] / 2), 90 - (g["yaw"] - g["fov"] / 2), color=COL[c], alpha=0.07, lw=0))
    ax.add_patch(Rectangle((-0.95, -2.4), 1.9, 4.7, color="#bbb", alpha=0.9))   # the car (about 1.9 x 4.7 m)
    for c in CAMS:
        pts = []
        for row in D[c]:
            if not any(abs(row["t"] - t) < 0.01 for t in TIMES): continue
            ds = [d for d in row["d"] if d[4] in ("car", "truck", "bus") and whole(d)]
            if not ds: continue
            a = np.array([[d[0] + d[2] / 2, d[1] + d[3]] for d in ds]); gp, ok = ground(C[c], a[:, 0], a[:, 1], ASPECT[c]); pts += list(gp[ok])
        if pts: p = np.array(pts); ax.scatter(p[:, 0], p[:, 1], s=26, color=COL[c], edgecolors="#0e1116", linewidths=0.5, label=NAME[c], zorder=3)
    ax.set_xlabel("metres to the right of the car", color="#888"); ax.set_ylabel("metres ahead", color="#888")
leg = axs[1].legend(loc="upper right", facecolor="#161a22", edgecolor="#333", labelcolor="#ddd", fontsize=9)
fig.suptitle("Vehicles placed on the road from all six cameras at " + ", ".join("%g s" % t for t in TIMES) + "  (2026-10-19 10:53:18)", color="#eee", fontsize=13)
plt.tight_layout(rect=[0, 0, 1, 0.95]); plt.savefig("birdseye.png", dpi=110, facecolor=fig.get_facecolor()); print("saved")
