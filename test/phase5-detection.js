// Phase 5 object detection: unit (classes, tracker), defaults/settings, mock detector end-to-end (search → follow → viewer label →
// export burn-in), graceful failure, and a REAL YOLO11 nano/small run on the sample clips (WASM in headless Chrome).
// Serve the repo (python3 -m http.server 8770). REAL=0 skips the real-model part. SHOTS=dir saves screenshots.
const puppeteer = require("puppeteer-core"); const fs = require("fs"), path = require("path");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.FIXTURES || "/workspace/photo-samples/TeslaCam";
const SHOTS = process.env.SHOTS || "", REAL = process.env.REAL !== "0";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) { if (!/2026-10-08_09-01-00/.test(q)) w(q); } else if (/\.(mp4|json)$/.test(f) && f !== "base.mp4") files.push(q); } })(FIX);
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x) : "")); if (!c) fails++; };
async function load(b, vp, ua) {
  const p = await b.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message)); await p.setViewport(vp); if (ua) await p.setUserAgent(ua);
  await p.goto(URL_, { waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important}" });
  await (await p.$("#fileInput")).uploadFile(...files);
  for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
  await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); const e = TDC.library.events.find((x) => !x.locked && x.cams.includes("front")) || TDC.library.events[0]; return TDC.ui.activate(e); });
  await W(1500); return p;
}
const runFind = async (p, q, cam) => { await p.evaluate((q, cam) => { TDC.searchUI && TDC.searchUI.classic && 0; document.getElementById("findQuery").value = q; if (cam) document.getElementById("findCam").value = cam; return TDC.search.run(); }, q, cam || "front");
  for (let i = 0; i < 600 && (await p.evaluate(() => TDC.search.running)); i++) await W(200); };
const waitTracks = async (p) => { for (let i = 0; i < 400 && !(await p.evaluate(() => TDC.detect.tracks.length)); i++) await W(250); };
(async () => {
  const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--hide-scrollbars", "--enable-unsafe-webgpu"], userDataDir: "/tmp/tdc-p5-" + Date.now(), protocolTimeout: 600000 });
  const p = await load(b, { width: 1440, height: 900 });
  // ── unit ──
  const u = await p.evaluate(() => {
    const D = TDC.detect;
    const fr = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ t, dets: [{ x: 0.1 + t * 0.2, y: 0.4, w: 0.2, h: 0.2, conf: 0.9, label: "car" }, { x: 0.7, y: 0.1, w: 0.1, h: 0.3, conf: 0.6, label: "person" }] }));
    fr[2].dets.push({ x: 0.12, y: 0.42, w: 0.2, h: 0.2, conf: 0.5, label: "truck" });
    const tr = D.buildTracks(fr), car = tr.find((x) => x.label === "car");
    return { cls: ["car", "Cars", "a person", "people", "trucks", "bike", "red car in the lane", "dog?", "xyz"].map(D.classFor), n: tr.length, carPts: car.pts.length,
      mid: D.trackAt(car, 0.625), out: D.trackAt(car, 3), iou: D.iou({ x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 0.5, h: 1 }) };
  });
  ok("class names map to COCO", JSON.stringify(u.cls) === JSON.stringify(["car", "car", "person", "person", "truck", "bicycle", null, "dog", null]), u.cls);
  ok("tracker keeps one track per object (+1 stray)", u.n === 3 && u.carPts === 5, u);
  ok("track interpolates between samples", Math.abs(u.mid.x - 0.225) < 1e-6 && u.out === null, u.mid);
  ok("IoU", Math.abs(u.iou - 0.5) < 1e-9);
  // ── defaults + settings ──
  ok("detection OFF by default", await p.evaluate(() => !TDC.detect.enabled() && !TDC.detect.handlesQuery("car")));
  ok("default model: small on desktop", await p.evaluate(() => TDC.detect.prefs().model === "small"));
  await p.evaluate(() => { document.getElementById("btnSettings") && document.getElementById("btnSettings").click(); }); await W(300);
  ok("Settings has model picker, toggle, threshold, status", await p.evaluate(() => ["detEnabled", "detModel", "detConf", "detLive", "detStatus"].every((id) => document.getElementById(id)) && document.getElementById("detModel").options.length === 3));
  await p.evaluate(() => { const c = document.getElementById("detEnabled"); c.checked = true; c.dispatchEvent(new Event("change")); const m = document.getElementById("detModel"); m.value = "nano"; m.dispatchEvent(new Event("change")); });
  ok("settings persist", await p.evaluate(() => { const v = JSON.parse(localStorage.getItem("tdc.detect.v1")); return v.enabled === true && v.model === "nano" && TDC.detect.handlesQuery("cars") && !TDC.detect.handlesQuery("a red car turning left"); }));
  if (SHOTS) { await p.evaluate(() => document.getElementById("setDetect").scrollIntoView({ block: "center" })); await W(300); await p.screenshot({ path: SHOTS + "/phase5-settings.png" }); }
  await p.evaluate(() => document.getElementById("btnCloseSettings").click()); await W(300);
  // ── graceful failure ──
  const fail = await p.evaluate(async () => { const D = TDC.detect; D.setPref("urls", { nano: "models/missing.onnx" }); const keep = D.MODELS.nano.urls; D.MODELS.nano.urls = []; let msg = null; try { await D.load("nano"); } catch (e) { msg = e.message; } D.MODELS.nano.urls = keep; D.setPref("urls", {}); return { msg, status: D.status, boxes: D.boxesAt("front", 1) }; });
  ok("missing model → readable error, nothing drawn", !!fail.msg && /unavailable/i.test(fail.status) && fail.boxes === null, fail);
  // ── mock detector end-to-end ──
  await p.evaluate(() => { TDC.detect._mock = async (img) => { const t = TDC.detect._mt = (TDC.detect._mt || 0) + 1; const x = 0.2 + ((img.currentTime || 0) * 0.08); return [{ x, y: 0.45, w: 0.22, h: 0.2, cls: 2, conf: 0.92 }, { x: 0.7, y: 0.3, w: 0.08, h: 0.25, cls: 0, conf: 0.41 }]; }; });
  await runFind(p, "cars");
  const m = await p.evaluate(() => ({ hits: TDC.search.hits.map((h) => ({ t: h.t, cam: h.cam, label: h.label, conf: h.conf, det: h.det })), status: document.getElementById("findStatus").textContent }));
  ok("mock: 'cars' → detector hits with class + confidence", m.hits.length > 0 && m.hits.every((h) => h.det && h.label === "car" && h.conf === 0.92), m);
  await waitTracks(p);
  const tk = await p.evaluate(async () => { const D = TDC.detect, tr = D.tracks[0]; const a = D.boxesAt(tr.cam, tr.from + 0.3), z = D.boxesAt(tr.cam, tr.to - 0.3); return { n: D.tracks.length, from: tr.from, to: tr.to, a, z, burn: TDC.burnBoxes.at(tr.cam, tr.from + 0.3) }; });
  ok("mock: box follows the object (moves between frames)", tk.n >= 1 && tk.a.length === 1 && tk.z.length === 1 && tk.z[0].x > tk.a[0].x + 0.05, tk);
  ok("mock: label is 'car 92%' in viewer and export", tk.a[0].text === "car 92%" && tk.burn[0].text === "car 92%", tk.a);
  // export frame through the compositor uses the followed box
  const ex = await p.evaluate(async () => { const D = TDC.detect, tr = D.tracks[0], P = TDC.player; await P.seek(tr.from + 0.5); await new Promise((r) => setTimeout(r, 600));
    const frames = {}; for (const cam of TDC.GRID) { const v = P.tiles[cam] && P.tiles[cam].vids[P.active]; frames[cam] = v && v.videoWidth ? { img: v, w: v.videoWidth, h: v.videoHeight } : null; }
    const c = document.createElement("canvas"); c.width = 1920; c.height = 1080; const ctx = c.getContext("2d"); const geo = TDC.compositor.geometry(1920, 1080, P.ev.tile, false);
    TDC.compositor.drawFrame(ctx, geo, tr.from + 0.5, frames, { labels: true, hud: false, map: false, fsd: false, time: false, boxes: true });
    const d = ctx.getImageData(0, 0, 1920, 1080).data; let g = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 150 && d[i + 1] < 200 && d[i + 2] < 110) g++; return g; });
  ok("mock: export burn-in draws the followed box", ex > 200, ex);
  ok("no page errors (mock)", p.errs.length === 0, p.errs);
  await p.evaluate(() => { TDC.detect._mock = null; TDC.search.clear(); });
  // ── real YOLO11 ──
  if (REAL) {
    for (const model of ["nano", "small"]) {
      const r = await p.evaluate(async (model) => {
        const D = TDC.detect; D.setPref("model", model); const t0 = performance.now();
        let info; try { info = await D.load(model); } catch (e) { return { err: e.message }; }
        const loadMs = performance.now() - t0, v = await D.frameAt("front", 2), out = [];
        let dets = []; for (let i = 0; i < 4; i++) { const a = performance.now(); dets = await D.detectImage(v, v.videoWidth, v.videoHeight); out.push(performance.now() - a); }
        return { info, loadMs, ms: out, dets: dets.map((d) => d.label + " " + Math.round(d.conf * 100) + "%") };
      }, model);
      console.log("REAL", model, JSON.stringify(r));
      ok("real " + model + ": loads + finds a car on the front camera", !r.err && r.dets.some((d) => /^car /.test(d)), r.err || r.dets);
    }
    await p.evaluate(() => TDC.detect.setPref("model", "nano"));
    await runFind(p, "car", "around");
    const rh = await p.evaluate(() => TDC.search.hits.map((h) => h.cam + "@" + h.t.toFixed(1) + " " + h.label + " " + Math.round(h.conf * 100) + "%"));
    console.log("REAL search hits", JSON.stringify(rh), "ms", await p.evaluate(() => Math.round(TDC.detect.lastSearchMs)), "frames", await p.evaluate(() => TDC.detect.lastSearchFrames));
    ok("real: 'car' search returns detector hits", rh.length > 0 && rh.every((h) => / car \d+%$/.test(h)), rh);
    await waitTracks(p);
    ok("real: tracking built", await p.evaluate(() => TDC.detect.tracks.length > 0));
    if (SHOTS) {
      await p.evaluate(async () => { document.getElementById("settings").hidden = true; TDC.ui.fit && TDC.ui.fit(); const tr = TDC.detect.tracks[0]; TDC.player.pause(); await TDC.player.seek(Math.min(tr.to, tr.from + 1)); }); await W(900);
      await p.screenshot({ path: SHOTS + "/phase5-live.png" });
      const png = await p.evaluate(async () => { const P = TDC.player, t = P.time; const frames = {}; for (const cam of TDC.GRID) { const v = P.tiles[cam] && P.tiles[cam].vids[P.active]; frames[cam] = v && v.videoWidth ? { img: v, w: v.videoWidth, h: v.videoHeight } : null; }
        const c = document.createElement("canvas"); c.width = 1920; c.height = 1080; const geo = TDC.compositor.geometry(1920, 1080, P.ev.tile, false); TDC.compositor.drawFrame(c.getContext("2d"), geo, t, frames, { labels: true, hud: false, map: false, fsd: false, time: true, boxes: true }); return c.toDataURL("image/png"); });
      fs.writeFileSync(SHOTS + "/phase5-export.png", Buffer.from(png.split(",")[1], "base64")); console.log("saved screenshots");
    }
    ok("no page errors (real)", p.errs.length === 0, p.errs);
  }
  // ── mobile default ──
  const mp = await b.newPage(); await mp.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"); await mp.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await mp.goto(URL_, { waitUntil: "load" }); await mp.evaluate(() => localStorage.removeItem("tdc.detect.v1"));
  ok("default model: nano on iPhone", await mp.evaluate(() => TDC.detect.prefs().model === "nano" && !TDC.detect.enabled()));
  await b.close(); console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
