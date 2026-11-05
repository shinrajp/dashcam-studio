// Parity: tools/depth3d/scenewb.py (the build's port of the viewer's White Balance) vs the viewer's own js/wb.js and
// js/colour-constancy.js, on the same pixels. Node runs the JS; python runs the port; every output is compared.
//   node test/scenewb-parity.js            synthetic strips / images (seeded)
//   FRAMES=dir node test/scenewb-parity.js  also every dir/*.png (private real frames; never committed)
//   CHROMIUM=1 …                            also the SVG feColorMatrix the viewer applies, in Chromium (playwright), vs
//                                           scenewb.apply_gains / apply_matrix
// PY = python with numpy + opencv (default python3). Tolerance: 1/255 on every 0..255 output, 1e-9 on gains / matrices / fusion,
// 1e-6 on linear whites (js LIN is a Float32Array).
const fs = require("fs"), path = require("path"), cp = require("child_process"), os = require("os");
const store = {}; global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
global.window = { TDC: {} }; global.navigator = { userAgent: "node" }; global.document = { getElementById: () => null, addEventListener() {}, createElement: () => ({ getContext: () => null }) };
global.performance = global.performance || { now: () => Date.now() };
require(path.join(__dirname, "../js/colour-constancy.js")); const CC = window.TDC.cc;
require(path.join(__dirname, "../js/wb.js")); const WB = window.TDC.wb;
// gainsFor is private to wb.js: evaluate its own source text (js/wb.js "function gainsFor") with the same WB / luma
const src = fs.readFileSync(path.join(__dirname, "../js/wb.js"), "utf8");
const gfSrc = src.slice(src.indexOf("  function gainsFor(cam, g) {"), src.indexOf("  WB.gainsFor ="));
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b; if (!/const luma = \(r, g, b\) => 0\.2126 \* r \+ 0\.7152 \* g \+ 0\.0722 \* b/.test(src)) throw new Error("wb.js luma changed");
const gainsFor = new Function("WB", "luma", "per", gfSrc + "; return gainsFor;")(WB, luma, {});
const PY = process.env.PY || "python3";
let s = 12345; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
const cases = { analyse: [], view: [], match: [], cat: [], lanes: [], grey: [], fuse: [], apply: [] };
const CAMS = ["front", "back", "left_pillar", "right_pillar", "left_repeater", "right_repeater"];
// mirror strips (GW×GH): a painted body of width runs[y] with a cast, scene beyond, a few lamp / clipped cells
for (let k = 0; k < 40; k++) {
  const W = WB.C.GW, H = WB.C.GH, d = new Uint8ClampedArray(W * H * 4), cast = [0.7 + rnd() * 0.6, 1, 0.7 + rnd() * 0.6], Y = 40 + rnd() * 180, runs = WB.wedge(0.14);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, body = x < runs[y], v = body ? Y * (0.85 + 0.3 * rnd()) : 20 + rnd() * 200;
    d[i] = v * (body ? cast[0] : 0.5 + rnd()); d[i + 1] = v * (body ? 1 : 0.5 + rnd()); d[i + 2] = v * (body ? cast[2] : 0.5 + rnd()); d[i + 3] = 255; if (rnd() < 0.03) { d[i] = 255; d[i + 1] = 40; d[i + 2] = 30; } }
  const sceneY = k % 3 ? null : 30 + rnd() * 100;
  cases.analyse.push({ img: Array.from(d), w: W, h: H, runs: Array.from(runs), sceneY, js: WB.analyse({ data: d, width: W, height: H }, runs, sceneY) });
}
for (let k = 0; k < 200; k++) { const w = [40 + rnd() * 200, 40 + rnd() * 200, 40 + rnd() * 200], day = k % 4 === 0 ? 0 : k % 4 === 1 ? 1 : rnd(), st = k % 5 ? WB.C.STRENGTH : 0.3 + rnd() * 0.7;
  const g = WB.viewGains(w, day, st); cases.view.push({ w, day, st, js: g });
  const m = [(rnd() - 0.5) * 0.14, (rnd() - 0.5) * 0.14], cam = CAMS[k % 6]; WB.setMatch({ [cam]: m }); cases.match.push({ g, m, js: gainsFor(cam, g) });
  for (const a of ["cat16", "bradford"]) cases.cat.push({ w, a, D: k % 3 ? 0.7 : rnd(), js: CC.viewerMatrix(w, a, k % 3 ? 0.7 : (cases.cat.D = rnd())) }); }
cases.cat.forEach((c) => { c.js = CC.viewerMatrix(c.w, c.a, c.D); }); delete cases.cat.D;
// road images: asphalt + lane paint (+ a yellow line), grey world, fusion
for (let k = 0; k < 12; k++) {
  const w = 96, h = 64, d = new Uint8ClampedArray(w * h * 4), cast = [0.8 + rnd() * 0.4, 1, 0.8 + rnd() * 0.4];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, lane = Math.abs(x - 30 - y * 0.3) < 2 || Math.abs(x - 70) < 2, yel = k % 4 === 0 && Math.abs(x - 50) < 2;
    const v = lane ? 200 + rnd() * 40 : 60 + rnd() * 20; d[i] = v * cast[0] * (yel ? 1.6 : 1); d[i + 1] = v * (yel ? 1.3 : 1); d[i + 2] = v * cast[2] * (yel ? 0.3 : 1); d[i + 3] = 255; }
  const L = CC.fromLanes(d, w, h), G = CC.fromGreyWorld(d), P = { white: CC.srgbToLin([150 + rnd() * 80, 200, 150 + rnd() * 80]), conf: 0.9 };
  cases.lanes.push({ img: Array.from(d), w, h, js: L && { white: L.white, conf: L.conf } }); cases.grey.push({ img: Array.from(d), w, h, js: G.white });
  const F = CC.fuse({ paint: P, lanes: L, grey: G }); cases.fuse.push({ ests: { paint: P, lanes: L && { white: L.white, conf: L.conf }, grey: G }, js: F && F.white });
}
const FR = process.env.FRAMES; const frames = FR && fs.existsSync(FR) ? fs.readdirSync(FR).filter((f) => /\.png$/.test(f)).map((f) => path.join(FR, f)) : [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swp-")); fs.writeFileSync(path.join(tmp, "cases.json"), JSON.stringify({ cases, frames }));
const py = `
import sys, json, numpy as np, cv2; sys.path.insert(0, ${JSON.stringify(path.join(__dirname, "../tools/depth3d"))}); import scenewb as S
J = json.load(open(sys.argv[1])); c = J["cases"]; o = {}
o["analyse"] = [S.analyse(np.array(x["img"], np.uint8).reshape(x["h"], x["w"], 4)[..., :3], x["runs"], x["sceneY"]) for x in c["analyse"]]
o["view"] = [S.view_gains(x["w"], x["day"], x["st"]).tolist() for x in c["view"]]
o["match"] = [S.gains_for(x["g"], x["m"]).tolist() for x in c["match"]]
o["cat"] = [S.viewer_matrix(x["w"], x["a"], x["D"]).tolist() for x in c["cat"]]
im = lambda x: np.array(x["img"], np.uint8).reshape(x["h"], x["w"], 4)[..., :3]
L = [S.from_lanes(im(x)) for x in c["lanes"]]; o["lanes"] = [l and dict(white=l["white"].tolist(), conf=l["conf"]) for l in L]
o["grey"] = [S.from_greyworld(im(x))["white"].tolist() for x in c["grey"]]
o["fuse"] = []
for x in c["fuse"]:
    e = {k: (v and dict(white=np.array(v["white"]), conf=v["conf"])) for k, v in x["ests"].items()}; f = S.fuse(e); o["fuse"].append(f and f["white"].tolist())
fr = []
for p in J["frames"]:
    rgb = cv2.cvtColor(cv2.imread(p), cv2.COLOR_BGR2RGB); side = "right" if "right" in p else "left"; st = S.strip_of(rgb, side)
    lw = S.from_lanes(rgb)
    fr.append(dict(name=p, strip=st.reshape(-1, 3).tolist(), sw=st.shape[1], sh=st.shape[0], runs=S.wedge(S.C["ZONE_W"]).tolist(), py=S.analyse(st, S.wedge(S.C["ZONE_W"])),
                   lanes=lw and dict(white=lw["white"].tolist(), conf=lw["conf"]), grey=S.from_greyworld(rgb)["white"].tolist(), w=rgb.shape[1], h=rgb.shape[0]))
o["frames"] = fr
json.dump(o, open(sys.argv[2], "w"), default=lambda v: v.tolist() if hasattr(v, "tolist") else float(v))
`;
fs.writeFileSync(path.join(tmp, "p.py"), py);
cp.execFileSync(PY, [path.join(tmp, "p.py"), path.join(tmp, "cases.json"), path.join(tmp, "out.json")], { stdio: "inherit" });
const O = JSON.parse(fs.readFileSync(path.join(tmp, "out.json"), "utf8"));
const worst = {}; let fail = 0;
const cmp = (name, a, b, tol, rel) => { if ((a == null) !== (b == null)) { fail++; console.log("FAIL", name, "null mismatch", a, b); return; } if (a == null) return;
  const fa = [a].flat(3), fb = [b].flat(3); for (let i = 0; i < fa.length; i++) { const e = Math.abs(fa[i] - fb[i]) / (rel ? Math.max(1e-9, Math.abs(fa[i])) : 1); worst[name] = Math.max(worst[name] || 0, e); if (!(e <= tol)) { fail++; console.log("FAIL", name, i, fa[i], fb[i]); return; } } };
cases.analyse.forEach((x, i) => { const p = O.analyse[i]; if (!!x.js.found !== !!p.found) { fail++; console.log("FAIL analyse found", i, x.js, p); } else if (p.found) { cmp("analyse.rgb (0..255)", x.js.rgb, p.rgb, 1 / 255); if (x.js.n !== p.n) { fail++; console.log("FAIL analyse n", x.js.n, p.n); } } });
cases.view.forEach((x, i) => cmp("viewGains (rel)", x.js, O.view[i], 1e-9, true));
cases.match.forEach((x, i) => cmp("gainsFor+match (rel)", x.js, O.match[i], 1e-9, true));
cases.cat.forEach((x, i) => cmp("viewerMatrix " + x.a + " (abs)", x.js, O.cat[i], 1e-9));
cases.lanes.forEach((x, i) => { cmp("fromLanes.white (lin)", x.js && x.js.white, O.lanes[i] && O.lanes[i].white, 1e-6); cmp("fromLanes.conf", x.js && x.js.conf, O.lanes[i] && O.lanes[i].conf, 1e-6); });
cases.grey.forEach((x, i) => cmp("greyWorld (lin)", x.js, O.grey[i], 1e-6));
cases.fuse.forEach((x, i) => cmp("fuse.white", x.js, O.fuse[i], 1e-9, true));
for (const f of O.frames) {
  const d = new Uint8ClampedArray(f.sw * f.sh * 4); f.strip.forEach((p, i) => { d[i * 4] = p[0]; d[i * 4 + 1] = p[1]; d[i * 4 + 2] = p[2]; d[i * 4 + 3] = 255; });
  const j = WB.analyse({ data: d, width: f.sw, height: f.sh }, Int16Array.from(f.runs), null);
  if (!!j.found !== !!f.py.found) { fail++; console.log("FAIL frame analyse", path.basename(f.name)); } else if (j.found) cmp("frames: analyse.rgb (0..255)", j.rgb, f.py.rgb, 1 / 255);
}
const rgbaOf = (p) => { const b = cp.execFileSync(PY, ["-c", `import cv2,sys; i=cv2.cvtColor(cv2.imread(sys.argv[1]),cv2.COLOR_BGR2RGBA); sys.stdout.buffer.write(i.tobytes())`, p], { maxBuffer: 1 << 28 }); return new Uint8ClampedArray(b); };
for (const f of O.frames) { const d = rgbaOf(f.name), L = CC.fromLanes(d, f.w, f.h); cmp("frames: fromLanes.white (lin)", L && L.white, f.lanes && f.lanes.white, 1e-6); cmp("frames: greyWorld (lin)", CC.fromGreyWorld(d).white, f.grey, 1e-6); }
console.log(JSON.stringify({ found: cases.analyse.filter((x) => x.js.found).length, lanesFound: cases.lanes.filter((x) => x.js).length, cases: Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, v.length])), frames: O.frames.length, worst }, null, 1));
fs.rmSync(tmp, { recursive: true, force: true });
if (fail) { console.log(fail + " FAILED"); process.exit(1); } console.log("scenewb parity: ok");
