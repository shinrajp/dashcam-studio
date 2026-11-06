"""pack.py — the replay page (the prototype's pack.py): scene.json (per time step the six frames' pose, intrinsics, depth grid
size and mesh rows, plus the drive's title and stretch), depth.json and weights.json (base64 grids), tex/ (textures), and
viewer.html as index.html (three.js 0.160 from a CDN). vehicles.json (solid car proxies) is written by vehicles.py, not here.
Everything in the page shows the drive: never commit it."""
import base64, json, os, shutil
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))


def run(src, dst, info=None):
    d = json.load(open(os.path.join(src, "frames.json"))); cams, steps = d["cams"], d["steps"]
    by = {c: [f for f in d["frames"] if f["cam"] == c] for c in cams}
    os.makedirs(os.path.join(dst, "tex"), exist_ok=True); dep, wts, meta = {}, {}, []
    for k in range(steps):
        row = []
        for c in cams:
            f = by[c][k]; base = os.path.join(src, f["name"][:-4])
            z = cv2.imread(base + ".png", cv2.IMREAD_UNCHANGED).astype("<u2")
            dep[f["name"]] = base64.b64encode(z.tobytes()).decode()
            if os.path.exists(base + "_w.png"): wts[f["name"]] = base64.b64encode(cv2.imread(base + "_w.png", cv2.IMREAD_GRAYSCALE).tobytes()).decode()
            shutil.copy(os.path.join(src, f["name"]), os.path.join(dst, "tex", f["name"]))
            e = dict(name=f["name"], cam=c, t=f["t"], R=[[round(v, 6) for v in r] for r in f["R"]], C=[round(v, 4) for v in f["C"]],
                     f=f["f"], cx=f["cx"], cy=f["cy"], w=f["w"], h=f["h"], gw=z.shape[1], gh=z.shape[0])
            if os.path.exists(base + "_rows.json"): e["rows"] = json.load(open(base + "_rows.json"))
            row.append(e)
        meta.append(row)
    json.dump(dict(steps=meta, info=info or {}), open(os.path.join(dst, "scene.json"), "w"))
    json.dump(dep, open(os.path.join(dst, "depth.json"), "w")); json.dump(wts, open(os.path.join(dst, "weights.json"), "w"))
    shutil.copy(os.path.join(HERE, "viewer.html"), os.path.join(dst, "index.html"))
    return dict(steps=steps, frames=steps * len(cams))
