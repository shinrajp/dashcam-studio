// Parity of the APPLIED colours: the viewer's own js/wb.js (+ js/colour-constancy.js) turns White Balance on for a
// stubbed player tile in Chromium (its real SVG feColorMatrix on the picture), the screenshot is compared pixel by pixel
// with tools/depth3d/scenewb.py apply_gains / apply_matrix for the same white point, dayness and camera offset.
//   node test/scenewb-apply.js                  synthetic images (seeded)
//   FRAMES=dir node test/scenewb-apply.js       also dir/*.png (private real frames; never committed)
//   JOBS=file.json …                            only these jobs: [{p, adapt, white, sceneY, match}] (e.g. a drive's own white point)
//   SHOT=dir …                                  writes dir/<name>-<adapt>.png (the viewer's WB-ON picture) for each frame
// PY = python with numpy + opencv. Pass: ≥ 99 % of channel values within 1/255, worst ≤ 2/255.
const pw = require("playwright"), fs = require("fs"), path = require("path"), cp = require("child_process"), os = require("os");
const ROOT = path.join(__dirname, ".."), PY = process.env.PY || "python3";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swa-"));
const FR = process.env.FRAMES, SHOT = process.env.SHOT;
const frames = FR && fs.existsSync(FR) ? fs.readdirSync(FR).filter((f) => /\.png$/.test(f)).sort().map((f) => path.join(FR, f)) : [];
const py = (code, ...args) => cp.execFileSync(PY, ["-c", `import sys, json, numpy as np, cv2; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "tools/depth3d"))}); import scenewb as S\n` + code, ...args], { maxBuffer: 1 << 28 }).toString();
// synthetic pictures: smooth ramps of every hue + grey steps (240×160)
py(`
H, W = 160, 240; y, x = np.mgrid[0:H, 0:W]
for k in range(3):
    r = (x * (1 + k) * 255 // W) % 256; g = (y * 255 // H); b = ((x + y) * (2 - k) * 255 // (W + H)) % 256
    im = np.stack([r, g, b], -1).astype(np.uint8); im[:20] = (x[:20] * 255 // W)[..., None]
    cv2.imwrite(sys.argv[1] + f"/syn{k}.png", cv2.cvtColor(im, cv2.COLOR_RGB2BGR))`, tmp);
const pics = [0, 1, 2].map((k) => path.join(tmp, `syn${k}.png`)).concat(frames);
const WH = [[199.6, 230, 196.8], [125.2, 210.2, 230], [230, 190, 140], [180, 230, 200]];
const jobs = process.env.JOBS ? JSON.parse(fs.readFileSync(process.env.JOBS, "utf8")) : []; if (!process.env.JOBS) pics.forEach((p, i) => { for (const adapt of ["gains", "cat16", "bradford"]) jobs.push({ p, adapt, white: WH[i % WH.length], sceneY: [100, 70, 30, 120][i % 4], match: adapt === "gains" ? [[0.05, -0.03], [-0.07, 0.07], [0, 0], [0.02, 0.06]][i % 4] : null }); });
(async () => {
  const b = await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--force-color-profile=srgb"] });
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.route("http://swb.test/**", (r) => { const u = new URL(r.request().url()).pathname;
    if (u === "/") return r.fulfill({ contentType: "text/html", body: "<!doctype html><body style='margin:0;background:#000'><div id='tile'><img id='v'></div></body>" });
    const f = path.join(ROOT, u); return r.fulfill({ path: f }); });
  await p.goto("http://swb.test/");
  await p.addScriptTag({ content: "window.TDC = {}; localStorage.setItem('tdc.wb.v1', '1'); localStorage.setItem('tdc.wb.mode', 'svg');" });
  await p.addScriptTag({ url: "http://swb.test/js/colour-constancy.js" }); await p.addScriptTag({ url: "http://swb.test/js/wb.js" });
  let worst = 0, n = 0, over1 = 0; const res = [];
  for (const j of jobs) {
    const b64 = fs.readFileSync(j.p).toString("base64");
    const info = await p.evaluate(async ({ b64, j }) => {
      const T = window.TDC, WB = T.wb, img = document.getElementById("v"), tile = document.getElementById("tile");
      await new Promise((ok) => { img.onload = ok; img.src = "data:image/png;base64," + b64; });
      T.player = { tiles: { front: { tile, vids: [img] } }, active: 0 };
      localStorage.setItem("tdc.cc.v1", JSON.stringify({ on: j.adapt !== "gains", estimator: "fusion", adapt: j.adapt === "gains" ? "cat16" : j.adapt, clip: false }));
      WB.state.est = null; WB.update(j.white, 0); WB.state.sceneY = j.sceneY; WB.setMatch(j.match ? { front: j.match } : {}); WB.apply();
      const A = WB.applied; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { w: img.naturalWidth, h: img.naturalHeight, white: WB.white(), gains: A && A.gains, per: A && A.per && A.per.front, matrix: A && A.matrix, filter: img.style.filter, day: WB.current().day };
    }, { b64, j });
    const shot = path.join(tmp, "shot.png"); await p.screenshot({ path: shot, clip: { x: 0, y: 0, width: info.w, height: info.h } });
    if (SHOT) fs.copyFileSync(shot, path.join(SHOT, path.basename(j.p, ".png") + "-viewer-" + j.adapt + ".png"));
    fs.writeFileSync(path.join(tmp, "j.json"), JSON.stringify({ j, info }));
    const r = JSON.parse(py(`
J = json.load(open(sys.argv[1])); j, info = J["j"], J["info"]
src = cv2.cvtColor(cv2.imread(j["p"]), cv2.COLOR_BGR2RGB); got = cv2.cvtColor(cv2.imread(sys.argv[2]), cv2.COLOR_BGR2RGB)
w = S.np.array(info["white"]); day = S.dayness(j["sceneY"])
if j["adapt"] == "gains": T = S.gains_for(S.view_gains(w, day), j["match"]); out = S.apply_gains(src, T); dT = float(np.abs(np.array(T) - np.array(info["per"])).max())
else: T = S.viewer_matrix(w, j["adapt"], S.C["STRENGTH"]); out = S.apply_matrix(src, T); dT = float(np.abs(np.array(T) - np.array(info["matrix"])).max())
d = np.abs(out.astype(int) - got.astype(int))
print(json.dumps(dict(max=int(d.max()), mean=float(d.mean()), over1=int((d > 1).sum()), n=int(d.size), dT=dT, unchanged=int((src != got).sum() == 0))))`, path.join(tmp, "j.json"), shot));
    res.push({ pic: path.basename(j.p), adapt: j.adapt, day: info.day, ...r }); worst = Math.max(worst, r.max); n += r.n; over1 += r.over1;
  }
  await b.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(JSON.stringify(res)); console.log(JSON.stringify({ jobs: jobs.length, worst, share_within_1: 1 - over1 / n, errs }));
  const bad = res.filter((r) => r.unchanged || r.dT > 1e-4);
  if (errs.length || bad.length || worst > 2 || over1 / n > 0.01) { console.log("FAIL", JSON.stringify(bad)); process.exit(1); } console.log("scenewb apply parity: ok");
})();
