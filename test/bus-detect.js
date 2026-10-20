// Bus detection regression (tag bus-detect-fix). Real YOLO11 (WASM) + CLIP on a synthetic 3-minute event where a public-domain
// city bus (plates blurred) drives across the BACK camera from 75 s to 83 s and nowhere else (tools/make-moving-footage.py, LONG=3).
// Playwright Chromium + WebKit, "Detect while playing" on All cameras:
//   L  live: while playing, the viewer shows the bus box on the back camera and it follows the real bus; paused too
//   R  rate: detections per second for Fast / Balanced / Battery saver, and playback frame rate with live on vs off
//   S  search "bus" (camera picker left at its default): every bus moment the live view showed is in the results, on the back camera
//   V  vehicle details "city bus" and "tour bus": the YOLO bus moments are never dropped (confirmed or "not confirmed")
//   E  export 75–83 s with burned boxes: the back camera bus box is burned in, follows the bus, matches the paused viewer (IoU > 0.8)
// Usage: node test/bus-detect.js [url]   (BR=chromium|webkit, PHASES=L,R,S,V,E, LONG_SAMPLES=/tmp/long-samples)
const pw = require("playwright"); const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.LONG_SAMPLES || "/tmp/long-samples";
const PH = (process.env.PHASES || "L,R,S,V,E").split(",");
const W = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(FIX + "/truth.json")) execFileSync("python3", [path.join(__dirname, "../tools/make-moving-footage.py"), FIX], { stdio: "inherit", env: { ...process.env, LONG: "3", BUS_CAM: "back", BUS_AT: "75" } });
const truth = JSON.parse(fs.readFileSync(FIX + "/truth.json", "utf8")), CAM = truth.bus_cam || "back", A0 = truth.bus_at, A1 = truth.bus_at + truth.sec;
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) w(q); else files.push(q); } })(FIX + "/TeslaCam");
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x).slice(0, 700) : "")); if (!c) fails++; };
const iou = (a, b) => { const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h); const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (a.w * a.h + b.w * b.h - i || 1); };
const truthAt = (t) => truth[CAM].reduce((m, x) => (Math.abs(x.t - t) < Math.abs(m.t - t) ? x : m));
const busIoU = (boxes, t) => Math.max(0, ...(boxes || []).filter((b) => /bus/.test(b.text)).map((b) => iou(b, truthAt(t))));
const RANGES = [[A0, A1]];

async function setup(p) {
  await p.addInitScript(() => {
    window.__exp = []; window.__view = {}; let inFrame = false;
    const hook = () => {
      const T = window.TDC; if (!T || !T.burnBoxes || !T.compositor || T.__hooked) return; T.__hooked = true;
      const at = T.burnBoxes.at, draw = T.burnBoxes.draw, df = T.compositor.drawFrame;
      T.compositor.drawFrame = function () { inFrame = true; try { return df.apply(this, arguments); } finally { inFrame = false; } };
      T.burnBoxes.at = function (cam, t) { const r = at.apply(this, arguments); if (inFrame && window.__recording) window.__exp.push({ cam, t, boxes: r.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, text: b.text })) }); return r; };
      T.burnBoxes.draw = function (ctx, cam, t, r, iw, ih, list) { if (ctx && ctx.canvas && ctx.canvas.classList && ctx.canvas.classList.contains("find-layer")) window.__view[cam] = { t: TDC.player.time, boxes: (list || []).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, text: b.text })) }; return draw.apply(this, arguments); };
    };
    const iv = setInterval(() => { try { hook(); if (window.TDC && window.TDC.__hooked) clearInterval(iv); } catch (_) {} }, 20);
  });
  await p.goto(URL_, { waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important}" });
  await p.setInputFiles("#fileInput", files);
  for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
  await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); return TDC.ui.activate(TDC.library.events[0]); });
  await W(1500);
}
// play from t0 to t1, sampling the viewer's box set on CAM (what the tile shows while playing) and counting frames
async function playThrough(p, t0, t1) {
  await p.evaluate(async (t0) => {
    TDC.player.pause(); await TDC.player.seek(t0); window.__view = {}; window.__play = { view: [], raf: 0, vf: 0 };
    const tl = TDC.player.tiles.front, v = tl && tl.vids[TDC.player.active], gen = (window.__gen = (window.__gen || 0) + 1);
    const vf = () => { if (gen !== window.__gen) return; window.__play.vf++; if (TDC.player.playing) v.requestVideoFrameCallback(vf); };
    if (v && v.requestVideoFrameCallback) v.requestVideoFrameCallback(vf);
    const raf = () => { if (gen !== window.__gen) return; window.__play.raf++; if (TDC.player.playing) requestAnimationFrame(raf); };
    TDC.player.play(); requestAnimationFrame(raf); window.__play.t0 = performance.now();
  }, t0);
  for (let i = 0; i < 200 && (await p.evaluate((t1) => TDC.player.playing && TDC.player.time < t1, t1)); i++) {
    await W(150);
    await p.evaluate((cam) => { const x = window.__view[cam]; if (x) window.__play.view.push(x); window.__view = {}; }, CAM);
  }
  return p.evaluate(() => { TDC.player.pause(); const s = (performance.now() - window.__play.t0) / 1000; return { sec: +s.toFixed(1), rafFps: +(window.__play.raf / s).toFixed(1), videoFps: +(window.__play.vf / s).toFixed(1), view: window.__play.view }; });
}
async function viewerAt(p, t) {
  await p.evaluate(async (t) => { TDC.player.pause(); await TDC.player.seek(t); }, t); await W(400);
  return p.evaluate(() => { window.__view = {}; TDC.search.paintBoxes(); return { t: TDC.player.time, cams: JSON.parse(JSON.stringify(window.__view)) }; });
}
async function runSearch(p, q) {
  await p.evaluate((q) => { document.getElementById("findQuery").value = q; TDC.search.run(); }, q);   // camera picker left as it is
  await W(300); for (let i = 0; i < 2500 && (await p.evaluate(() => TDC.search.running || !!TDC.search.pending)); i++) await W(200);
  return p.evaluate(() => ({ status: document.getElementById("findStatus").textContent.slice(0, 220), findCam: document.getElementById("findCam").value,
    hits: (TDC.search.allHits || TDC.search.hits).map((h) => ({ cam: h.cam, t: +h.t.toFixed(2), live: !!h.live, unconfirmed: !!h.unconfirmed, label: h.label || "", text: String(h.boxText || h.text || "").slice(0, 80) })) }));
}
(async () => {
  const report = {};
  for (const bn of (process.env.BR || "chromium,webkit").split(",")) {
    const ctx = await pw[bn].launchPersistentContext("/tmp/tdc-veh-profile-" + bn, bn === "chromium" ? { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"], viewport: { width: 1440, height: 900 } } : { viewport: { width: 1440, height: 900 } });
    await ctx.route((u) => u.origin === new URL(URL_).origin, (r) => r.continue());
    await ctx.addInitScript(() => { try { if (!sessionStorage.getItem("bd-init")) { sessionStorage.setItem("bd-init", "1"); localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, live: true, model: "nano", conf: 0.35, liveCams: "all", speed: "balanced" })); localStorage.setItem("tdc.export.burnBoxes", "1"); localStorage.removeItem("tdc.vehicle.v1"); localStorage.removeItem("tdc.plates.v1"); localStorage.removeItem("tdc.search.bestOnly"); indexedDB.deleteDatabase("tdc-vehicle-index"); } } catch (e) {} });
    const p = ctx.pages()[0] || (await ctx.newPage()); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message)); p.on("console", (m) => { if (/ImageBitmap|live detect/.test(m.text())) console.log(bn, "console:", m.text().slice(0, 300)); });
    await setup(p); const tag = bn; const rep = (report[bn] = {});
    await p.evaluate(() => TDC.detect.load ? TDC.detect.load() : null).catch(() => {});
    let liveSeen = [];
    if (PH.includes("L")) {
      const r = await playThrough(p, A0 - 1, A1);
      const inside = r.view.filter((x) => x.t >= A0 + 1 && x.t <= A1 - 1), good = inside.filter((x) => busIoU(x.boxes, x.t) > 0.3);
      ok(tag + " L: while playing, the " + CAM + " camera shows the bus box and it follows the bus (IoU > 0.3, ≥ 60% of samples)", inside.length >= 5 && good.length >= 0.6 * inside.length, { samples: inside.length, good: good.length, eg: inside.slice(2, 4) });
      liveSeen = await p.evaluate((cam) => (TDC.detect.liveSamples[cam] || []).filter((s) => s.dets.some((d) => d.label === "bus" && d.conf >= 0.35)).map((s) => +s.t.toFixed(2)), CAM);
      ok(tag + " L: live detection recorded bus moments on the " + CAM + " camera (All cameras)", liveSeen.length >= 3, { liveSeen });
      const paused = await viewerAt(p, A0 + 4.5), pb = (paused.cams[CAM] || {}).boxes || [];
      ok(tag + " L: paused, the " + CAM + " camera still shows the bus box on the bus", busIoU(pb, paused.t) > 0.5, { t: paused.t, boxes: pb.map((b) => b.text) });
      rep.live = { samples: inside.length, good: good.length, rafFps: r.rafFps, videoFps: r.videoFps };
    }
    if (PH.includes("R")) {
      await p.evaluate(() => TDC.detect.setPref("live", false));
      const offR = await playThrough(p, 10, 16);
      await p.evaluate(() => TDC.detect.setPref("live", true));
      rep.rates = {}; rep.fpsOff = { raf: offR.rafFps, video: offR.videoFps };
      for (const sp of ["fast", "balanced", "battery"]) {
        await p.evaluate((sp) => { TDC.detect.setPref("speed", sp); TDC.detect.liveStats.starts = []; TDC.detect.liveStats.ms = []; TDC.detect.liveStats.skipped = 0; TDC.detect.liveStats.frames = 0; }, sp);
        const r = await playThrough(p, 20, 28.5);
        const st = await p.evaluate(() => ({ perSec: +TDC.detect.liveRate(6).toFixed(2), avgMs: Math.round(TDC.detect.avgMs()), path: TDC.detect.pathInfo ? TDC.detect.pathInfo() : TDC.detect.lastPath, rvfc: TDC.detect.liveRVFC(), cams: TDC.detect.liveCams(), skipped: TDC.detect.liveStats.skipped, frames: TDC.detect.liveStats.frames }));
        rep.rates[sp] = { ...st, rafFps: r.rafFps, videoFps: r.videoFps };
      }
      await p.evaluate(() => TDC.detect.setPref("speed", "balanced"));
      console.log(tag, "rates", JSON.stringify(rep.rates), "fps live off", JSON.stringify(rep.fpsOff));
      const R = rep.rates;
      ok(tag + " R: Fast ≥ Balanced ≥ Battery saver detections/s, Balanced ≤ ~5/s, Battery ≈ 1/s", R.fast.perSec >= R.balanced.perSec * 0.9 && R.balanced.perSec <= 5.6 && R.battery.perSec <= 1.3 && R.battery.perSec >= 0.5, R);
      ok(tag + " R: playback frame rate is not hurt by live detection (Balanced video fps ≥ 85% of live off)", R.balanced.videoFps >= 0.85 * offR.videoFps || R.balanced.rafFps >= 0.85 * offR.rafFps, { off: rep.fpsOff, balanced: [R.balanced.rafFps, R.balanced.videoFps] });
    }
    if (PH.includes("S")) {
      const s = await runSearch(p, "bus"); rep.search = { status: s.status, n: s.hits.length };
      const onCam = s.hits.filter((h) => h.cam === CAM && h.t >= A0 - 0.5 && h.t <= A1 + 0.5), wrong = s.hits.filter((h) => !(h.cam === CAM && h.t >= A0 - 1 && h.t <= A1 + 1));
      ok(tag + " S: search 'bus' (camera picker '" + s.findCam + "') finds the bus on the " + CAM + " camera", onCam.length > 0, { status: s.status, hits: s.hits.slice(0, 6) });
      ok(tag + " S: no bus results where there is no bus", wrong.length === 0, wrong.slice(0, 4));
      const missing = liveSeen.filter((t) => !s.hits.some((h) => h.cam === CAM && Math.abs(h.t - t) <= 4.0));
      ok(tag + " S: every bus moment the live view showed is covered by a search result (results group a camera's sightings within 4 s)", liveSeen.length > 0 ? missing.length === 0 : true, { liveSeen, missing });
    }
    if (PH.includes("V")) {
      await p.evaluate(() => { TDC.search.clear(); TDC.vehicle.setPref("enabled", true); });
      for (const q of ["city bus", "tour bus"]) {
        const s = await runSearch(p, q), onCam = s.hits.filter((h) => h.cam === CAM && h.t >= A0 - 1 && h.t <= A1 + 1);
        ok(tag + " V: vehicle search '" + q + "' keeps the bus on the " + CAM + " camera (confirmed or 'not confirmed')", onCam.length > 0, { status: s.status, hits: s.hits.slice(0, 4) });
      }
      await p.evaluate(() => { TDC.search.clear(); TDC.vehicle.setPref("enabled", false); TDC.detect.tracks = []; });
    }
    if (PH.includes("E")) {
      const r = await p.evaluate(async (ranges) => {
        window.__exp = []; window.__recording = true; const st = [];
        try { const r = await TDC.exporter.run({ preset: "compat", ranges, show: { ...TDC.prefs.show, labels: false, hud: false, map: false, fsd: false, time: false, boxes: true }, onStatus: (s) => st.push(s), onProgress: () => {} }); window.__lastExport = r.blob; return { ok: true, frames: r.frames, prog: st.filter((s) => /Detecting objects/.test(s)) }; }
        catch (e) { return { ok: false, err: String(e && e.message || e), st: st.slice(-3) }; } finally { window.__recording = false; }
      }, RANGES);
      ok(tag + " E: export ran", r.ok, { frames: r.frames, err: r.err });
      ok(tag + " E: the export shows detection progress per camera", (r.prog || []).some((s) => /of \d+/.test(s) && /Back|Front/.test(s)), (r.prog || []).slice(-2));
      const exp = await p.evaluate((cam) => window.__exp.filter((e) => e.cam === cam), CAM);
      const inside = exp.filter((e) => e.t >= A0 + 0.5 && e.t <= A1 - 0.5), good = inside.filter((e) => busIoU(e.boxes, e.t) > 0.5);
      ok(tag + " E: the " + CAM + " camera bus box is burned in and follows the bus (IoU > 0.5, ≥ 80% of frames)", inside.length > 20 && good.length >= 0.8 * inside.length, { frames: inside.length, good: good.length });
      let bad = [];
      for (const t of [A0 + 1.2, A0 + 3.3, A0 + 5.1, A0 + 6.6]) {
        const v = await viewerAt(p, t), vb = ((v.cams[CAM] || {}).boxes || []).filter((b) => /bus/.test(b.text));
        const e = exp.filter((x) => Math.abs(x.t - v.t) <= 0.03).sort((a, b) => Math.abs(a.t - v.t) - Math.abs(b.t - v.t))[0], eb = e ? e.boxes.filter((b) => /bus/.test(b.text)) : [];
        if (!vb.length || vb.length !== eb.length || vb.some((b) => Math.max(0, ...eb.map((x) => iou(x, b))) <= 0.8)) bad.push({ t: +v.t.toFixed(2), view: vb.length, exp: eb.length });
      }
      ok(tag + " E: the paused viewer and the export show the same bus box (IoU > 0.8)", bad.length === 0, bad);
      const t = A0 + 4.2, tb = truthAt(t);
      const gold = await p.evaluate(async ([tau, box, cam]) => {
        const blob = window.__lastExport; if (!blob) return -1;
        const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(blob); if (TDC.search.park) TDC.search.park(v);
        await new Promise((r) => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 6000); }); v.currentTime = tau; await new Promise((r) => { v.onseeked = r; setTimeout(r, 4000); });
        const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext("2d"); g.drawImage(v, 0, 0);
        const geo = TDC.compositor.geometry(c.width, c.height, TDC.player.ev.tile, false), r = TDC.compositor.cellRect(geo.grid, TDC.GRID.indexOf(cam), 0);
        const s = Math.min(r.w / 1280, r.h / 960), fw = 1280 * s, fh = 960 * s, fx = r.x + (r.w - fw) / 2, fy = r.y + (r.h - fh) / 2;
        const x = Math.round(fx + box.x * fw), y = Math.round(fy + box.y * fh), w = Math.round(box.w * fw), h = Math.round(box.h * fh);
        let n = 0; const scan = (x0, y0, ww, hh) => { const d = g.getImageData(Math.max(0, x0), Math.max(0, y0), Math.max(1, ww), Math.max(1, hh)).data; for (let k = 0; k < d.length; k += 4) if (d[k] > 190 && d[k + 1] > 140 && d[k + 1] < 215 && d[k + 2] < 130 && d[k] - d[k + 2] > 90) n++; };
        scan(x - 6, y + Math.round(h * 0.3), 13, Math.round(h * 0.4)); scan(x + w - 6, y + Math.round(h * 0.3), 13, Math.round(h * 0.4)); v.remove(); return n;
      }, [t - A0, tb, CAM]);
      ok(tag + " E: the exported file has the gold box on the " + CAM + " camera bus at " + t.toFixed(1) + " s", gold > 8, { goldPixels: gold });
    }
    ok(tag + " no page errors", p.errs.length === 0, p.errs.slice(0, 3));
    await ctx.close();
  }
  console.log("REPORT " + JSON.stringify(report));
  console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
