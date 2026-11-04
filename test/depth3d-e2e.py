#!/usr/bin/env python3
"""depth3d-e2e.py — tools/depth3d/build.py end to end on a synthetic six-camera drive with a KNOWN rig, file clocks and
telemetry delays (tools/rig/make-footage.py: textured flat road + posts, the 2026-10-19 fixture's path, SEI on every frame).

    python3 test/depth3d-e2e.py [--drive DIR --truth truth.json] [--keep DIR] [--model model_fp16.onnx]

Without --drive it renders a 12 s drive first (~5 min on 4 cores), then builds 2–6 s (~3 min). Without --model the AI depth
is the plane stub (tools/depth3d/depth.py PlaneStub), so this checks everything AROUND the model: clocks, delays, poses, views,
masks, detector run, metric scaling, road snap, road growing (the stub squashes far road like the model does), seams, colour,
page. Checks: clock offsets within 10 ms and delays within 15 ms of truth; every view's pose within 8 cm / 0.2° of the truth
pose; fused depth on the road within 2 % of the true road depth (and the far 30–60 m road grown back to within 5 %); page files;
and, when Playwright and the three.js CDN are reachable, the page renders without errors; viewer.html's own logic is always run on the page data with a stand-in three.js.
"""
import argparse, json, os, subprocess, sys, tempfile
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "tools", "depth3d"))
from rig import Rig, Drive  # noqa: E402
from depth import road_depth  # noqa: E402

CLOCK = {"front": 0, "back": 0.31, "left_pillar": 0.07, "right_pillar": -0.18, "left_repeater": 0.12, "right_repeater": -0.06}
DELAY = {"front": 0.03, "back": -0.05, "left_pillar": 0.04, "right_pillar": -0.02, "left_repeater": 0.06, "right_repeater": -0.04}
fails = []


def check(ok, msg):
    print(("ok   " if ok else "FAIL ") + msg); (None if ok else fails.append(msg))


def render(dst):
    truth = os.path.join(dst, "truth.json")
    js = "const R=require(%r);process.stdout.write(JSON.stringify({cams:R.MEASURED,delay:%s,clock:%s}))" % (
        os.path.join(ROOT, "js", "rig.js"), json.dumps(DELAY), json.dumps(CLOCK))
    open(truth, "w").write(subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True).stdout)
    subprocess.run([sys.executable, os.path.join(ROOT, "tools", "rig", "make-footage.py"), truth, os.path.join(dst, "drive"), "--sec", "12"], check=True)
    return os.path.join(dst, "drive"), truth


FAKE_THREE = r"""
// a do-nothing stand-in for three.js (no WebGL): enough for viewer.html's own logic to run on the data
export const SRGBColorSpace = 'srgb'; export const STATS = { meshes: 0, tris: 0 }; globalThis.__three = STATS;
export class Vector3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } setY(y) { this.y = y; return this; } clone() { return new Vector3(this.x, this.y, this.z); }
  copy(v) { return this.set(v.x, v.y, v.z); } add(v) { return this.set(this.x + v.x, this.y + v.y, this.z + v.z); } sub(v) { return this.set(this.x - v.x, this.y - v.y, this.z - v.z); }
  addScaledVector(v, s) { return this.set(this.x + v.x * s, this.y + v.y * s, this.z + v.z * s); }
  normalize() { const n = Math.hypot(this.x, this.y, this.z) || 1; return this.set(this.x / n, this.y / n, this.z / n); } }
class Obj { constructor() { this.position = new Vector3(); this.children = []; this.visible = true; } add(o) { this.children.push(o); } lookAt() {} }
export class Color { constructor(c) { this.c = c; } set(c) { this.c = c; } }
export class Scene extends Obj {} export class PerspectiveCamera extends Obj { updateProjectionMatrix() {} }
export class WebGLRenderer { constructor() { this.domElement = document.createElement('canvas'); } setPixelRatio() {} setSize() {} render() {} setAnimationLoop(f) { this.f = f; } }
export class TextureLoader { load(u) { return { url: u }; } }
export class BufferAttribute { constructor(a, n) { this.array = a; this.n = n; } }
export class BufferGeometry { setAttribute(k, v) { this[k] = v; } setIndex(i) { this.index = i; STATS.tris += i.length / 3; } }
export class Mesh extends Obj { constructor(g, m) { super(); this.geometry = g; this.material = Object.assign({ color: new Color() }, m && m.o); STATS.meshes++; } }
export class MeshBasicMaterial { constructor(o) { this.o = o; this.color = new Color(); } } export class LineBasicMaterial extends MeshBasicMaterial {}
export class BoxGeometry {} export class EdgesGeometry {} export class LineSegments extends Obj {} export class GridHelper extends Obj {}
"""
FAKE_ORBIT = "import { Vector3 } from 'three'; export class OrbitControls { constructor() { this.target = new Vector3(); } update() {} }"


def page_render(page, fake=False):
    """load the page in headless Chromium (served by a local http server). fake: serve FAKE_THREE for the CDN's three.js.
    → { ok, cdn, errs, info } or { skip }."""
    js = r"""
const path = require('path'), http = require('http'), fs = require('fs');
let pw; try { pw = require('playwright'); } catch (_) { console.log(JSON.stringify({ skip: 'no playwright' })); process.exit(0); }
const [root, fake, orbit] = [process.argv[1], process.argv[2] || '', process.argv[3] || ''];
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(root, u === '/' ? 'index.html' : u);
  fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : f.endsWith('.json') ? 'application/json' : 'image/jpeg' });
  r.end(f.endsWith('index.html') ? '<!doctype html><html><head><meta charset="utf-8"></head><body>' + b + '</body></html>' : b); }); }).listen(0, async () => {
  const b = await pw.chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-gl=swiftshader'] }); const p = await b.newPage({ viewport: { width: 900, height: 600 } }); const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  let cdn = true; p.on('requestfailed', (q) => { if (/jsdelivr/.test(q.url())) cdn = false; });
  if (fake) await p.route(/cdn\.jsdelivr\.net/, (q) => q.fulfill({ contentType: 'text/javascript', body: /OrbitControls/.test(q.request().url()) ? orbit : fake }));
  await p.route(/fonts\.(googleapis|gstatic)\.com/, (q) => q.fulfill({ contentType: 'text/css', body: '' }));
  await p.goto('http://127.0.0.1:' + srv.address().port + '/index.html');
  const ok = await p.waitForFunction(() => document.getElementById('status').hidden, null, { timeout: 60000 }).then(() => true, () => false);
  if (ok) { await p.fill('#pos', '12'); await p.dispatchEvent('#pos', 'input'); await p.click('[data-v=top]'); await p.click('#tint'); }
  const info = await p.evaluate(() => ({ max: document.getElementById('pos').max, read: document.getElementById('read').textContent,
    what: document.querySelector('.note p').textContent, three: globalThis.__three || null }));
  console.log(JSON.stringify({ ok, cdn, errs, info })); await b.close(); srv.close();
});"""
    args = [page] + ([FAKE_THREE, FAKE_ORBIT] if fake else [])
    r = subprocess.run(["node", "-e", js, *args], capture_output=True, text=True, cwd=ROOT, timeout=240)
    try: return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception: return {"skip": "node failed: " + r.stderr[-300:]}


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--drive"); ap.add_argument("--truth"); ap.add_argument("--keep"); ap.add_argument("--model")
    ap.add_argument("--no-page", action="store_true"); a = ap.parse_args()
    tmp = a.keep or tempfile.mkdtemp(prefix="depth3d-e2e-"); os.makedirs(tmp, exist_ok=True)
    drive, truth_f = (a.drive, a.truth) if a.drive else render(tmp)
    truth = json.load(open(truth_f)); tclock, tdelay = truth.get("clock", {}), truth.get("delay", {})
    page, work = os.path.join(tmp, "page"), os.path.join(tmp, "page.work")
    cmd = [sys.executable, os.path.join(ROOT, "tools", "depth3d", "build.py"), drive, page, "--t0", "2", "--t1", "6"]
    cmd += ["--model", a.model] if a.model else ["--depth-stub"]
    subprocess.run(cmd, check=True)
    rep = json.load(open(os.path.join(work, "report.json")))

    e = {c: abs(rep["clocks"][c] - tclock.get(c, 0)) for c in rep["clocks"]}
    check(max(e.values()) < 0.010, "clock offsets from the files' telemetry, max error %.1f ms" % (max(e.values()) * 1000))
    e = {c: abs(rep["delays"][c] - tdelay.get(c, 0)) for c in rep["delays"]}
    check(max(e.values()) < 0.015, "telemetry delays fitted from the clip, max error %.1f ms (%s)" % (max(e.values()) * 1000,
          ", ".join(f"{c} {rep['delays'][c]:+.3f}/{tdelay.get(c, 0):+.3f}" for c in rep["delays"])))

    tel = json.load(open(os.path.join(work, "telemetry.json"))); rig = Rig.from_telemetry(tel)
    tdrive = Drive(rig, tel["cams"]["front"]["rows"], 2.0, tclock, tdelay)
    F = json.load(open(os.path.join(work, "data", "frames.json")))
    dC, dR = [], []
    for f in F["frames"]:
        Rt, Ct = tdrive.cam_to_world(f["cam"], f["t_clip"] + tclock.get(f["cam"], 0) + tdelay.get(f["cam"], 0))
        dC.append(np.linalg.norm(np.array(f["C"]) - Ct))
        dR.append(np.degrees(np.arccos(np.clip((np.trace(Rt.T @ np.array(f["R"])) - 1) / 2, -1, 1))))
    check(max(dC) < 0.08 and max(dR) < 0.2, f"view poses vs truth: max {max(dC) * 100:.1f} cm, {max(dR):.3f}°  ({len(F['frames'])} views)")
    check(F["steps"] == 25 and len(F["cams"]) == 6, f"{F['steps']} time steps × {len(F['cams'])} cameras")

    # fused depth against the true road plane (truth poses), on road pixels the fused page keeps
    D = json.load(open(os.path.join(work, "fused", "frames.json"))); near, far, kept, place = [], [], [], []
    for f in D["frames"]:
        Z = np.load(os.path.join(work, "fused", f["name"].replace(".jpg", ".npy")))
        Rt, Ct = tdrive.cam_to_world(f["cam"], f["t_clip"] + tclock.get(f["cam"], 0) + tdelay.get(f["cam"], 0))
        Zr, _ = road_depth(dict(f, R=Rt.tolist(), C=Ct.tolist()))
        m = (Z > 0) & np.isfinite(Zr)
        # where on the road the pipeline puts each kept road pixel vs where it truly is (poses' translation shows here)
        sel = m & (Zr < 25); W_, H_ = f["w"], f["h"]; uu, vv = np.meshgrid(np.arange(W_) + 0.5, np.arange(H_) + 0.5)
        v3 = np.stack([(uu - f["cx"]) / f["f"], (vv - f["cy"]) / f["f"], np.ones_like(uu)], -1)[sel]
        Pp = np.array(f["C"]) + (v3 * Z[sel][:, None]) @ np.array(f["R"]).T; Pt = Ct + (v3 * Zr[sel][:, None]) @ Rt.T
        place.append(np.linalg.norm(Pp - Pt, axis=1))
        near.append(np.abs(Z[m & (Zr < 25)] / Zr[m & (Zr < 25)] - 1)); far.append(np.abs(Z[m & (Zr > 30) & (Zr < 60)] / Zr[m & (Zr > 30) & (Zr < 60)] - 1))
        kept.append(((Z > 0) & (Zr < 25)).sum() / max(1, (Zr < 25).sum()))
    near, far = np.concatenate(near), np.concatenate(far)
    check(np.median(near) < 0.02, f"road under 25 m: fused depth vs true road depth median error {np.median(near) * 100:.2f} % (90th pct {np.percentile(near, 90) * 100:.1f} %)")
    check(len(far) > 1000 and np.median(far) < 0.05, f"far road 30–60 m (squashed by the depth stand-in, grown back): median error {np.median(far) * 100:.2f} % over {len(far)} px")
    place = np.concatenate(place)
    check(np.median(place) < 0.08, f"road points under 25 m land within {np.median(place) * 100:.1f} cm (median; 90th pct {np.percentile(place, 90) * 100:.1f} cm) of their true place")
    check(np.median(kept) > 0.5, f"share of each view's true road under 25 m kept in the page: median {np.median(kept) * 100:.0f} %")
    check(rep["fuse"]["grown_px"] > 0, f"road growing added {rep['fuse']['grown_px']} px")
    for n in ["index.html", "scene.json", "depth.json", "weights.json"]: check(os.path.exists(os.path.join(page, n)), "page has " + n)
    sc = json.load(open(os.path.join(page, "scene.json")))
    check(len(sc["steps"]) == 25 and len(os.listdir(os.path.join(page, "tex"))) == 150 and sc["info"].get("clip"), f"scene.json: {len(sc['steps'])} steps, info {sc['info']}")
    if not a.no_page:
        r = page_render(page, fake=True)   # viewer.html's own logic on this data, three.js replaced by a stand-in
        if r.get("skip"): print("skip viewer check:", r["skip"])
        else:
            t3 = r["info"]["three"] or {}
            check(r["ok"] and not r["errs"] and r["info"]["max"] == "24" and t3.get("meshes", 0) >= 150 and t3.get("tris", 0) > 150 * 1000,
                  f"viewer.html runs on the page data (three.js stand-in): {t3.get('meshes')} meshes, {t3.get('tris')} triangles, "
                  f"slider max {r['info']['max']}, at step 12 {r['info']['read']!r}; errors: {r['errs'] or 'none'}; note: {r['info']['what'][:70]}…")
        r = page_render(page)              # the real thing, when the CDN is reachable
        if r.get("skip"): print("skip WebGL page render:", r["skip"])
        elif not r["cdn"]: print("skip WebGL page render: the three.js CDN (cdn.jsdelivr.net) is not reachable from here")
        else: check(r["ok"] and not r["errs"], f"page renders with three.js in headless Chromium (errors: {r['errs'] or 'none'})")
    print(f"\n{'ALL OK' if not fails else str(len(fails)) + ' FAILED'}  (work in {tmp}: synthetic, no real footage)")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
