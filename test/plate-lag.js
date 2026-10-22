// Plate blur keeps up with a moving plate (tag safari-feedback). The user's Mac Safari: the blur trailed a moving car and
// the first boxes came late. Real plate models (WASM), Playwright Chromium + WebKit.
// Footage: PLATE_MOTION=fast tools/make-plate-footage.py (made-up plate sliding across the front camera, speeding up;
// plate-truth.json has its box per frame).
//  - prewarm: with Blur plates on, opening the clip starts loading the plate models at once (badge "Loading plate
//    finder…" / "Finding plates to blur · n %"), before any play
//  - the background scan starts at the playhead and the blur is there for the playhead's moment before the scan ends
//  - coverage: for every frame 0.4–7.6 s the blur boxes (L.blurBoxesAt, what viewer + export use) cover the true plate:
//    ≥ 97 % of frames fully covered (≥ 98 % of the plate area), worst frame ≥ 90 %; and the boxes stay tight (mean area
//    ≤ 6 × the plate)
//  - moving plates get extra looks between samples (refine) ; the viewer paints each camera at its own frame time
//    (R.camTime = clip start + that video's presented time, not the front camera's clock)
//  - Detect while playing (mock detector): opening a clip looks at the paused frame once (boxes before play); the live
//    tracker takes the measured speed on its second look
// Usage: node test/plate-lag.js [url]   (BR=chromium,webkit  PLATE_FAST=/tmp/plate-fast)
const pw = require("playwright"), fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.PLATE_FAST || "/tmp/plate-fast";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(FIX + "/plate-truth.json")) execFileSync("python3", [path.join(__dirname, "../tools/make-plate-footage.py"), FIX], { stdio: "inherit", env: { ...process.env, PLATE_MOTION: "fast" } });
const truth = JSON.parse(fs.readFileSync(FIX + "/plate-truth.json", "utf8")).front.frames;
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) w(q); else files.push(q); } })(FIX + "/TeslaCam");
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x).slice(0, 600) : "")); if (!c) fails++; };
/** share of box a covered by the union of boxes bs (grid sampling) */
const cover = (a, bs) => { let n = 0, hit = 0; for (let i = 0; i < 20; i++) for (let j = 0; j < 10; j++) { const x = a.x + (i + 0.5) / 20 * a.w, y = a.y + (j + 0.5) / 10 * a.h; n++; if (bs.some((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)) hit++; } return hit / n; };
(async () => {
  for (const bn of (process.env.BR || "chromium,webkit").split(",")) {
    const b = await pw[bn].launch(bn === "chromium" ? { executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] } : {});
    const p = await (await b.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    const errs = []; p.on("pageerror", (e) => errs.push(e.message));
    await p.goto(URL_, { waitUntil: "load" });
    await p.evaluate(() => { localStorage.setItem("tdc.plates.v1", JSON.stringify({ enabled: true, blur: true, model: "accurate" })); });
    await p.reload({ waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important}" });
    await p.setInputFiles("#fileInput", files);
    for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
    await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); });
    // open at 3.5 s: the scan should start there
    const pre = await p.evaluate(async () => { const t0 = performance.now(); await TDC.ui.activate(TDC.library.events[0]); TDC.player.seek(3.5); await new Promise((r) => setTimeout(r, 300)); const bd = document.getElementById("modelLoading"); return { badge: bd && !bd.hidden ? bd.textContent : null, busy: [...TDC.prewarm.busy.keys()], playing: TDC.player.playing, ms: Math.round(performance.now() - t0) }; });
    ok(bn + ": opening the clip starts loading the plate models at once (badge shown, not playing)", !pre.playing && (pre.busy.includes("plates") || /plate/i.test(pre.badge || "")), pre);
    let early = null;
    for (let i = 0; i < 600; i++) {
      const s = await p.evaluate(() => ({ bg: !!TDC.plates.bgScan, prog: TDC.plates.progress, at: TDC.plates.blurBoxesAt("front", 3.5).length, badge: (document.getElementById("modelLoading") || {}).textContent }));
      if (!early && s.bg && s.at && s.prog) early = s;
      if (!s.bg && i > 4) break; await W(250);
    }
    ok(bn + ": blur at the playhead (3.5 s) before the scan is done (scan starts at the playhead, tracks rebuilt as it goes)", !!early && early.prog.n < early.prog.total, early);
    const r = await p.evaluate((ts) => ts.map((t) => ({ t, bs: TDC.plates.blurBoxesAt("front", t) })), truth.filter((f) => f.t >= 0.4 && f.t <= 7.6).map((f) => f.t));
    const cov = r.map((x, i) => ({ t: x.t, c: cover(truth.find((f) => f.t === x.t).box, x.bs), area: x.bs.reduce((s, b) => s + b.w * b.h, 0) }));
    const full = cov.filter((x) => x.c >= 0.98).length / cov.length, worst = cov.reduce((a, x) => (x.c < a.c ? x : a)), pa = truth[0].box.w * truth[0].box.h, meanA = cov.reduce((s, x) => s + x.area, 0) / cov.length / pa;
    const info = await p.evaluate(() => ({ step: TDC.plates.blurStep, refined: TDC.plates.lastRefine, tracks: (TDC.plates.blurTracks.front || []).map((t) => t.pts.length) }));
    ok(bn + ": moving plate covered: ≥ 97 % of frames fully, worst frame ≥ 90 %, boxes tight (mean area ≤ 6 × plate)", full >= 0.97 && worst.c >= 0.9 && meanA <= 6, { full: +full.toFixed(3), worst: { t: +worst.t.toFixed(2), c: +worst.c.toFixed(2) }, meanArea: +meanA.toFixed(2), ...info });
    ok(bn + ": moving plate got extra looks between samples (refine)", info.refined > 0, info);
    // viewer: each camera at its own frame time
    const ct = await p.evaluate(async () => { const P = TDC.player; await P.seek(1.0); P.play(); await new Promise((r) => setTimeout(r, 1200)); const v = P.tiles.back.vids[P.active], f = P.tiles.front.vids[P.active]; const clip = P.ev.clips[P.slotClip[P.active]]; v.currentTime = f.currentTime + 0.12; await new Promise((r) => setTimeout(r, 300)); const out = { cam: TDC.redact.camTime("back", v), own: clip.start + v.currentTime, clock: P.time }; P.pause(); return out; });
    ok(bn + ": viewer paints a camera at its own frame time (rear 0.12 s ahead of the front clock)", Math.abs(ct.cam - ct.own) < 0.06, ct);
    // detector prewarm: Detect while playing on → opening a clip loads the detector and looks at the paused frame once
    const det = await p.evaluate(async () => {
      const D = TDC.detect; localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, live: true, model: "small" }));
      let calls = 0; D._mock = async () => { calls++; return [{ x: 0.4, y: 0.5, w: 0.1, h: 0.08, cls: 2, conf: 0.9 }]; };
      TDC.player.pause && TDC.player.pause();
      await TDC.ui.activate(TDC.library.events[0]);
      await new Promise((r) => setTimeout(r, 1500));
      const out = { calls, playing: TDC.player.playing, live: !!(D.live && D.live.front), boxes: (D.boxesAt("front", TDC.player.time) || []).length };
      // live tracker: the second look takes the measured speed (the box doesn't trail a moving car)
      D.liveTracks = {}; D._track("zz", 0, [{ label: "car", x: 0.3, y: 0.5, w: 0.1, h: 0.08, conf: 0.9 }]); D._track("zz", 0.2, [{ label: "car", x: 0.33, y: 0.5, w: 0.1, h: 0.08, conf: 0.9 }]);
      const tl = D.liveTracks.zz[0]; out.vx = tl.vx; out.pred = tl.x + tl.vx * 0.2;
      D._mock = null; localStorage.removeItem("tdc.detect.v1"); return out; });
    ok(bn + ": Detect while playing: opening a clip looks at the paused frame (boxes before play)", det.calls >= 1 && !det.playing && det.live && det.boxes >= 1, det);
    ok(bn + ": live tracker: second look takes the measured speed (0.15 /s; was 0.09), prediction 0.2 s on ≥ 0.345 (was 0.336)", Math.abs(det.vx - 0.15) < 0.02 && det.pred >= 0.345, det);
    ok(bn + ": no page errors", !errs.length, errs);
    await b.close();
  }
  console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})();
