#!/usr/bin/env node
/* Colour lock (tag color-lock): a vehicle keeps ONE colour tag while it is followed.
 * Synthetic readings (no footage): a white car drives across the front camera and grows; its frame-by-frame colour
 * readings wobble with the light (silver / gray at dusk), flash red with the brake lamps, read blue while a blue car
 * overlaps it, and it is lost for 1.2 s and found again. A red car in another lane, a red car that later appears where
 * the white one was lost long before, and a gray-then-truly-red track check that real colours are not suppressed.
 *   node test/color-lock.js                          (module only, node)
 *   node test/color-lock.js http://127.0.0.1:18847/  (+ Chromium and WebKit: module, viewer playing / paused,
 *                                                     export boxes, search label, pixels → decorateLive)
 * BR=chromium limits the browsers. Exit code 1 on any failure. */
"use strict";
const path = require("path");
const URL_ = process.argv[2];
let fails = 0;
const ok = (name, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + name + (cond || extra === undefined ? "" : "  " + JSON.stringify(extra).slice(0, 400))); if (!cond) fails++; };

/** Readings, frame by frame: [{ t, items:[{ det, c, pxW, who }] }]. Runs in node and in the page (toString). */
function scenario() {
  const frames = [], R = (a, b, t) => a + (b - a) * t;
  for (let k = 0; k <= 50; k++) {
    const t = 100 + k * 0.2, u = k / 50, items = [];
    // W: the white car — left to right, getting bigger; lost 105.6..106.8 (no reading), found again on its path
    if (!(t > 105.5 && t < 106.9)) {
      const w = R(0.12, 0.3, u), h = w * 0.6, x = R(0.08, 0.62, u), y = R(0.45, 0.4, u);
      let c = { name: "white", conf: 0.72 };
      if (t >= 101.6 && t < 102.6) c = { name: k % 2 ? "silver" : "gray", conf: 0.5, lowLight: true };   // dusk / shade
      if ([103.0, 103.2, 104.8, 107.6].some((b) => Math.abs(t - b) < 0.01)) c = { name: "red", conf: 0.6, rearLit: true, lamps: 0.09 };   // brake flashes
      if (t >= 104.0 && t < 104.5) c = { name: "blue", conf: 0.55 };   // the blue car overlaps it (crowd)
      items.push({ who: "W", det: { label: "car", conf: 0.9, x, y, w, h }, c, pxW: w * 1280 });
      if (t >= 104.0 && t < 104.5) items.push({ who: "B", det: { label: "car", conf: 0.8, x: x + w * 0.5, y: y + 0.02, w: w * 0.9, h: h * 0.9 }, c: { name: "blue", conf: 0.6 }, pxW: w * 0.9 * 1280 });
    }
    // R: a red car in the left lane from 107 s (new track, different colour: must read red, not white)
    if (t >= 107) items.push({ who: "R", det: { label: "car", conf: 0.88, x: 0.05, y: 0.55, w: 0.2, h: 0.13 }, c: { name: "red", conf: 0.7 }, pxW: 256 });
    frames.push({ t, items });
  }
  // N: long after W left (≥ 3 s), a red car turns up where W was lost → its own track, red
  for (let k = 0; k < 12; k++) frames.push({ t: 112 + k * 0.2, items: [{ who: "N", det: { label: "car", conf: 0.9, x: 0.42, y: 0.42, w: 0.22, h: 0.13 }, c: { name: "red", conf: 0.7 }, pxW: 280 }] });
  // G: read gray for 1.2 s, then clearly red for 4 s in good light (a real change of reading, e.g. the light estimate
  // settled): switches to red, but only after ≥ 1.5 s of red
  for (let k = 0; k < 27; k++) { const t = 120 + k * 0.2; frames.push({ t, items: [{ who: "G", det: { label: "car", conf: 0.9, x: 0.3 + k * 0.005, y: 0.4, w: 0.25, h: 0.15 }, c: t < 121.2 ? { name: "gray", conf: 0.7 } : { name: "red", conf: 0.8 }, pxW: 320 }] }); }
  return frames;
}

/** Feed the scenario into a colour-lock module and summarise what each vehicle was labelled. order: "time" | "shuffled". */
function runScenario(L, frames, cam, order) {
  L.clear();
  const list = frames.slice();
  if (order === "shuffled") { let s = 7; for (let i = list.length - 1; i > 0; i--) { s = (s * 9301 + 49297) % 233280; const j = Math.floor((s / 233280) * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } }
  const causal = {};   // words while playing (what the label said right after each reading)
  for (const f of list) {
    const items = f.items.map((it) => ({ det: Object.assign({}, it.det), c: it.c, pxW: it.pxW, who: it.who }));
    L.observeFrame(cam, f.t, items);
    for (const it of items) (causal[it.who] = causal[it.who] || []).push({ t: f.t, w: L.word(it.det.clObs), id: L.colourOf(it.det.clObs).id, o: it.det.clObs });
  }
  const out = {};
  for (const who in causal) {
    const seq = causal[who].sort((a, b) => a.t - b.t);
    const fin = seq.map((r) => L.colourOf(r.o));   // after everything was seen (paused viewer / export)
    let flips = 0, last = null, firstLock = null;
    for (const r of seq) { if (!r.w.startsWith("~")) { if (firstLock == null) firstLock = r.t; if (last != null && r.w !== last) flips++; last = r.w; } }
    out[who] = { causal: seq.map((r) => r.w), ids: [...new Set(seq.map((r) => r.id))], finals: [...new Set(fin.map((c) => c.name + (c.locked ? "" : "~")))], finalIds: [...new Set(fin.map((c) => c.id))], flips, firstLock: firstLock == null ? null : +(firstLock - seq[0].t).toFixed(2), switchAt: (() => { const i = seq.findIndex((r) => r.w === "red"); return i < 0 ? null : +(seq[i].t - seq[0].t).toFixed(2); })() };
  }
  return out;
}

function check(tag, r) {
  const W = r.W, B = r.B, R = r.R, N = r.N, G = r.G;
  ok(tag + ": white car is one colour track the whole way (incl. 1.2 s loss)", W && W.finalIds.length === 1, W && W.finalIds);
  ok(tag + ": white car locks on white within 1.5 s", W && W.firstLock != null && W.firstLock <= 1.5 && W.causal.find((w) => !w.startsWith("~")) === "white", W && W.causal.slice(0, 10));
  ok(tag + ": white car never flickers (dusk, brake flashes, overlap, loss)", W && W.flips === 0 && W.causal.every((w) => w === "white" || w === "~white"), W && W.causal);
  ok(tag + ": white car final colour white (paused viewer / export)", W && W.finals.length === 1 && W.finals[0] === "white", W && W.finals);
  ok(tag + ": overlapping blue car is its own track", B && !B.finalIds.some((id) => W.finalIds.includes(id)), B);
  ok(tag + ": red car in the next lane reads red (not suppressed)", R && R.finals.length === 1 && R.finals[0] === "red" && R.causal.slice(-3).every((w) => w === "red"), R);
  ok(tag + ": red car where the white one was lost long before: new track, red", N && !N.finalIds.some((id) => W.finalIds.includes(id)) && N.finals[0] === "red", N);
  ok(tag + ": sustained real change gray→red switches (once, after ≥ 1.5 s of red)", G && G.causal.includes("gray") && G.switchAt != null && G.switchAt >= 1.2 + 1.5 - 0.01 && G.flips === 1, G);
}

(async () => {
  const L = require(path.join(__dirname, "../js/color-lock.js"));
  const frames = scenario();
  const t0 = process.hrtime.bigint();
  const r = runScenario(L, frames, "front", "time");
  const ms = Number(process.hrtime.bigint() - t0) / 1e6, n = frames.reduce((a, f) => a + f.items.length, 0);
  check("node", r);
  // export prepare fills gaps out of order: the full rebuild must give the same answer as playing through
  const rs = runScenario(L, frames, "front", "shuffled");
  for (const who of ["W", "R", "N"]) ok("node: out-of-order readings (export / search) → same final colour for " + who, rs[who] && JSON.stringify(rs[who].finals) === JSON.stringify(r[who].finals), [rs[who] && rs[who].finals, r[who].finals]);
  ok("node: out-of-order readings keep the white car on one track", rs.W && rs.W.finalIds.length === 1, rs.W && rs.W.finalIds);
  // lookups by box (search results): nearest reading of the same vehicle
  const fW = frames.find((f) => Math.abs(f.t - 104.8) < 0.01).items.find((i) => i.who === "W");
  const at = L.colourAt("front", 104.85, fW.det);
  ok("node: colourAt (search result on a brake-flash frame) → locked white", at && at.locked && at.name === "white", at);
  ok("node: cost per reading < 0.5 ms (" + (ms / n).toFixed(3) + " ms)", ms / n < 0.5);
  // weights
  ok("node: weights — lamps, night, small, edge, overlap all count less than a clean big crop",
    ["lamps", "lowLight", "small", "edge", "crowd", "rearLit"].every((k) => { const base = { conf: 0.8, pxW: 300, x: 0.3, y: 0.3, w: 0.2, h: 0.12 }; const o = Object.assign({}, base, k === "lamps" ? { lamps: 0.1 } : k === "small" ? { pxW: 30 } : k === "edge" ? { x: 0 } : { [k]: true }); return L.weight(o) < L.weight(base) * 0.85; }));

  if (URL_) {
    const pw = require("playwright");
    for (const bn of (process.env.BR || "chromium,webkit").split(",")) {
      const b = await pw[bn].launch(bn === "chromium" ? { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] } : {});
      const p = await (await b.newContext()).newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
      await p.goto(URL_, { waitUntil: "load" }); await new Promise((res) => setTimeout(res, 800));
      ok(bn + ": TDC.colorLock loaded", await p.evaluate(() => !!(window.TDC && TDC.colorLock && TDC.colorLock.observeFrame)));
      const rb = await p.evaluate(`(${runScenario.toString()})(TDC.colorLock, (${scenario.toString()})(), "front", "time")`);
      check(bn, rb);
      // the app paths: viewer playing (tracker), viewer paused + export (liveAt → burnBoxes.at), search result label
      const app = await p.evaluate(`(() => {
        const frames = (${scenario.toString()})(), T = TDC, D = T.detect, L = T.colorLock, V = T.vehicle, cam = "front";
        D.clear(); D.tracks = []; if (T.search) { T.search.hits = []; }
        const playWords = [];
        for (const f of frames) {
          if (f.t > 109.95) break;
          const dets = f.items.map((it) => Object.assign({ attr: it.c.name, _who: it.who }, it.det));
          L.observeFrame(cam, f.t, dets.map((d, i) => ({ det: d, c: f.items[i].c, pxW: f.items[i].pxW })));
          D.addLiveSample(cam, { t: f.t, dets, hold: 0.8, src: "live" });
          D._track(cam, f.t, dets);
          const tl = D.trackedLive(cam, f.t + 0.05) || [];
          for (const bx of tl) if (Math.abs(bx.x + bx.w / 2 - (dets.find((d) => d._who === "W") || { x: -9, w: 0 }).x - ((dets.find((d) => d._who === "W") || { w: 0 }).w / 2)) < 0.05) playWords.push(D.liveText(bx).split(" ")[0]);
        }
        const T0 = T.player && T.player.playing;
        const paused = [], exp = [];
        for (let t = 100.1; t < 109.9; t += 0.3) {
          const lv = D.boxesAt(cam, t) || [];
          const w = lv.find((x) => x.label === "car" && x.w > 0.11 && x.y > 0.38 && x.y < 0.47 && x.x > 0.07);
          if (w) paused.push(w.text.split(" ")[0]);
          const bb = T.burnBoxes && T.burnBoxes.at ? T.burnBoxes.at(cam, t, [], "") : [];
          const e = bb.find((x) => x.w > 0.11 && x.y > 0.38 && x.y < 0.47 && x.x > 0.07); if (e) exp.push(e.text.split(" ")[0]);
        }
        // search result on the brake-flash frame (its own reading said red): label shows the locked colour
        const fr = frames.find((f) => Math.abs(f.t - 104.8) < 0.01).items.find((i) => i.who === "W");
        const hit = { t: 104.8, cam, vehicle: true, det: true, label: "car", conf: 0.9, score: 0.8, vdet: { label: "car", conf: 0.9, color: "red", colorConf: 0.6, x: fr.det.x, y: fr.det.y, w: fr.det.w, h: fr.det.h }, vq: { label: "car", cls: ["car"] }, parts: {}, box: { x: fr.det.x, y: fr.det.y, w: fr.det.w, h: fr.det.h } };
        const cl = V.cluster([hit]);
        const searchText = cl[0] && cl[0].text, liveHitText = V.hitText(cl[0]);
        const burnHit = T.burnBoxes.labelFor(cl[0], "", 0.8);
        return { playWords, paused, exp, searchText, liveHitText, burnHit, playing: T0 };
      })()`);
      ok(bn + ": viewer while playing: white car label never flickers", app.playWords.length > 10 && app.playWords.every((w) => w === "white" || w === "~white") && app.playWords.filter((w) => w === "white").length > app.playWords.length / 2, app.playWords);
      ok(bn + ": viewer paused: white everywhere", app.paused.length > 10 && app.paused.every((w) => w === "white"), app.paused);
      ok(bn + ": export boxes (burnBoxes.at) = viewer", app.exp.length > 10 && JSON.stringify(app.exp) === JSON.stringify(app.paused), [app.exp, app.paused]);
      ok(bn + ": search result on a brake-flash frame says white (locked), as viewer and export", /^white car/.test(app.searchText || "") && app.liveHitText === app.searchText && app.burnHit === app.searchText.slice(0, 80), app);
      // pixels → decorateLive (the real colour reading) → lock: a white car whose lamps flare red and light dims
      const px = await p.evaluate(() => {
        const T = TDC, V = T.vehicle, L = T.colorLock; L.clear();
        const prefs = V.prefs; V.prefs = () => Object.assign({}, prefs(), { enabled: true });
        const cv = document.createElement("canvas"); cv.width = 640; cv.height = 360; const g = cv.getContext("2d");
        const words = [], raw = [];
        try {
          for (let k = 0; k < 30; k++) {
            const t = 50 + k * 0.2, x = 60 + k * 12, w = 150 + k * 2, h = 90, y = 160, dim = k >= 10 && k < 16 ? 0.45 : 1;
            g.fillStyle = "rgb(" + [70, 72, 78].map((v) => Math.round(v * dim)).join(",") + ")"; g.fillRect(0, 0, 640, 360);
            g.fillStyle = "rgb(" + [232, 234, 236].map((v) => Math.round(v * dim)).join(",") + ")"; g.fillRect(x, y, w, h);
            g.fillStyle = "rgb(" + [28, 30, 34].map((v) => Math.round(v * dim)).join(",") + ")"; g.fillRect(x + w * 0.15, y + 10, w * 0.7, 22);   // rear window
            if (k % 7 === 3) { g.fillStyle = "rgb(255,30,20)"; g.fillRect(x + 4, y + 36, w * 0.3, 30); g.fillRect(x + w * 0.7 - 4, y + 36, w * 0.3, 30); }   // brake lamps flare
            const det = { label: "car", conf: 0.9, x: x / 640, y: y / 360, w: w / 640, h: h / 360 };
            V.decorateLive(cv, 640, 360, [det], t, null, "front");
            raw.push(det.attr); words.push(V.liveWord(det));
          }
        } finally { V.prefs = prefs; }
        return { words, raw };
      });
      const locked = px.words.filter((w) => !w.startsWith("~"));
      let flips = 0; for (let i = 1; i < locked.length; i++) if (locked[i] !== locked[i - 1]) flips++;
      ok(bn + ": pixels → decorateLive → lock: white, no flicker (raw readings: " + [...new Set(px.raw)].join("/") + ")", locked.length >= 20 && flips === 0 && locked[locked.length - 1] === "white", px);
      ok(bn + ": no page errors", errs.length === 0, errs);
      await b.close();
    }
  }
  console.log(fails ? fails + " FAILED" : "all passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
