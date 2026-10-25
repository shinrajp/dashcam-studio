#!/usr/bin/env node
// clip-eval.js — run the app's real detection pipeline (real model, real tracker, real people registry) on a folder of per-camera frames
// taken from a recording, to measure per-second person coverage and the number of identities. Nothing is written into the repo:
// pass the output folder yourself. Frames: DIR/<camera>_NNN.jpg (NNN from 001 at time 0, FPS frames per second), cameras:
// left_pillar front right_pillar right_repeater back left_repeater. No footage lives in this repo; the frames are made privately with ffmpeg.
// Usage: NODE_PATH=…/playwright DIR=/path/frames OUT=/path/out.json MODE=raw|live [FPS=2] [T0=0] [T1=45] [SEED=on|off] [OCCL=3.5] [MODEL=small|nano|medium]
//        [LOOKS=5] [REID=1] [URL=http://127.0.0.1:8770/index.html] node tools/clip-eval.js
// raw : every frame, every camera, the model's own answer at a low cut-off (persons, animals, bags, cars) — to see what it sees and misses
// live: simulates the viewer's loop (LOOKS looks per second, one camera each, the camera that waited longest × its motion weight, like pickCam)
//       on a simulated clock; frames at the nearest sample. Reports per second: persons tracked (any camera), people-registry ids, hidden ids.
const fs = require("fs"), path = require("path");
const E = process.env, DIR = E.DIR, OUT = E.OUT || "/tmp/clip-eval.json", MODE = E.MODE || "live", FPS = +(E.FPS || 2), T0 = +(E.T0 || 0), T1 = +(E.T1 || 45);
const URL_ = E.URL || "http://127.0.0.1:8770/index.html", CAMS = ["left_pillar", "front", "right_pillar", "right_repeater", "back", "left_repeater"];
(async () => {
  const pw = require("playwright");
  const b = await pw.chromium.launch({ executablePath: E.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } }), p = await ctx.newPage(), errs = [];
  p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await p.goto(URL_ + (E.QS || ""), { waitUntil: "load" });
  await p.evaluate((m) => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, live: true, model: m, speed: "balanced", seed: "auto", occl: 3.5, urls: m === "medium" ? { medium: "http://127.0.0.1:8770/models/yolo11m.onnx" } : {} })); }, E.MODEL || "small");
  await p.reload({ waitUntil: "load" });
  const frame = (cam, t) => { const k = Math.min(Math.round((t - 0) * FPS) + 1, 9999), f = path.join(DIR, cam + "_" + String(k).padStart(3, "0") + ".jpg"); return fs.existsSync(f) ? fs.readFileSync(f).toString("base64") : null; };
  const n = Math.round((T1 - T0) * FPS), res = { mode: MODE, env: { model: E.MODEL || "small", seed: E.SEED, occl: E.OCCL, looks: E.LOOKS }, rows: [] };
  await p.evaluate(async () => { await TDC.detect.load(); });
  const t00 = Date.now();
  if (MODE === "raw") {
    for (let i = 0; i < n; i++) {
      const t = T0 + i / FPS;
      for (const cam of CAMS) {
        const b64 = frame(cam, t); if (!b64) continue;
        const r = await p.evaluate(async ([b64, cam]) => {
          const D = TDC.detect, img = new Image(); img.src = "data:image/jpeg;base64," + b64; await img.decode();
          const keep = new Set(["person", "cat", "dog", "bear", "teddy bear", "backpack", "handbag", "suitcase", "car", "truck", "bench", "umbrella", "bird"]);
          const a = await D.detectImage(img, img.naturalWidth, img.naturalHeight, { cam, conf: 0.1, noFix: true });
          return a.filter((d) => keep.has(d.label)).map((d) => [d.label, +d.conf.toFixed(2), +d.x.toFixed(3), +d.y.toFixed(3), +d.w.toFixed(3), +d.h.toFixed(3)]);
        }, [b64, cam]);
        res.rows.push({ t, cam, d: r });
      }
      if (i % 10 === 0) console.log("raw", t.toFixed(1), Math.round((Date.now() - t00) / 1000) + "s");
    }
  } else {
    await p.evaluate(([seed, occl, looks, reid]) => {
      const D = TDC.detect; D._clock = null; D.setPref("occl", +occl);
      window.__sim = { wall: 0, last: {}, reg: new TDC.people.Registry(), perSec: {}, ids: new Map(), raw: [] };
      D._clock = () => window.__sim.wall;
      if (seed === "off") localStorage.setItem("tdc.seed", "off"); else localStorage.removeItem("tdc.seed");
      D.seed.budget = ((o) => () => Object.assign({}, o(), { maxAvg: 1e9 }))(D.seed.budget);   // the box CPU is slower than a Mac: don't let the speed guard hide the logic
      D.liveCams = () => ["left_pillar", "front", "right_pillar", "right_repeater", "back", "left_repeater"];
      D.speed = () => "balanced"; D.liveEvery = () => 1000 / looks; D.avgMs = () => 200;
    }, [E.SEED || "on", E.OCCL || "3.5", +(E.LOOKS || 5), !!E.REID]);
    const per = 1 / +(E.LOOKS || 5);
    for (let t = T0; t < T1; t += per) {
      const b64s = {};
      // camera that waited longest × motion weight (as pickCam)
      const cam = await p.evaluate((t) => { const S = window.__sim, D = TDC.detect; S.wall = t * 1000; let best = null, bs = -1; for (const c of D.liveCams()) { const age = S.last[c] == null ? 1e9 : S.wall - S.last[c], sc = age * D.camMoving(c); if (sc > bs) { bs = sc; best = c; } } S.last[best] = S.wall; return best; }, t);
      const b64 = frame(cam, t); if (!b64) continue;
      const out = await p.evaluate(async ([b64, cam, t, reid]) => {
        const D = TDC.detect, S = window.__sim, img = new Image(); img.src = "data:image/jpeg;base64," + b64; await img.decode();
        const cv = document.createElement("canvas"); cv.width = img.naturalWidth; cv.height = img.naturalHeight; cv.getContext("2d").drawImage(img, 0, 0);
        const t0 = performance.now(); await D._detectLive(cam, cv, t); const ms = performance.now() - t0;
        // people registry over the confirmed person tracks, with a colour descriptor from this frame when the track is on this camera
        const tr = D.personTracks(t);
        const hist = (x) => { if (x.cam !== cam) return x.hist; const w = cv.width, h = cv.height, bw = x.w * w, bh = x.h * h; if (bw < 14 || bh < 28) return x.hist; const c2 = document.createElement("canvas"); c2.width = 48; c2.height = 96; const g = c2.getContext("2d", { willReadFrequently: true }); g.drawImage(cv, Math.max(0, x.x * w), Math.max(0, x.y * h), Math.min(w, bw), Math.min(h, bh), 0, 0, 48, 96); const d = g.getImageData(0, 0, 48, 96).data; return TDC.reid.histFromRGBA(d, 48, 96); };
        S.mem = S.mem || {};
        const withH = tr.map((x) => { const k = x.cam + ":" + x.id, h = hist(x); if (h) S.mem[k] = S.mem[k] ? S.mem[k].map((v, i) => 0.6 * v + 0.4 * h[i]) : h; return Object.assign({}, x, { hist: S.mem[k] }); });
        const reg = S.reg.update(withH, t);
        const sec = Math.floor(t); const row = (S.perSec[sec] = S.perSec[sec] || { looks: 0, tracked: 0, cams: {}, gids: [], ghost: 0, ms: 0, seed: 0 });
        row.looks++; row.ms += ms;
        for (const r of reg) { row.tracked = Math.max(row.tracked, reg.length); row.cams[r.cam] = 1; if (!row.gids.includes(r.gid)) row.gids.push(r.gid); }
        row.ghost = Math.max(row.ghost, D.liveCams().reduce((a, c) => a + D.ghostsAt(c, t).length, 0));
        const dbg = D.seed.dbg[cam]; if (dbg && dbg.wins && dbg.wins.length && dbg.wall === S.wall) row.seed++;
        return { ms: Math.round(ms) };
      }, [b64, cam, t, !!E.REID]);
    }
    res.perSec = await p.evaluate(() => window.__sim.perSec);
    res.stats = await p.evaluate(() => { const s = TDC.detect.seed.stats; return { found: s.found, confirmed: s.confirmed, revived: s.revived, windows: s.windows, throttled: s.throttled, motionMs: s.motionMs.slice(-20), seedMs: s.seedMs.slice(-20), enhMs: s.enhMs.slice(-20), persons: TDC.detect.timings.slice(-20), regPersons: TDC.people ? 0 : 0 }; });
    res.gidCount = await p.evaluate(() => window.__sim.reg.persons.size);
  }
  res.errors = errs.slice(0, 5); res.secs = Math.round((Date.now() - t00) / 1000);
  fs.writeFileSync(OUT, JSON.stringify(res)); console.log("wrote", OUT, res.secs + "s", "errors", errs.length, errs.slice(0, 2).join(" | "));
  await b.close();
})().catch((e) => { console.error("ERR", e); process.exit(2); });
