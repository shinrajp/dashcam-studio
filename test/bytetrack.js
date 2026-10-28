// bytetrack (tag bytetrack): ByteTrack-style second association for people the detector scores under the cut-off (behind a van window, a pillar).
// Synthetic only: the tracker (D._track) and the detection path (D.detectImage / D._detectLive with a mock model) are fed boxes made here.
// They prove the LOGIC (weak boxes extend a track but never start one, are never shown as detections, retire after "Keep a hidden person",
// ghosts need two, strong boxes win, the export sample sees the same person). How well the real model sees a real person behind real glass is
// measured with tools/clip-eval.js on private clips (not here).
//   1  weak boxes alone never start a track (and are not detections)
//   2  strong → weak → strong: ONE identity, visible (not a ghost) during the weak part; with the setting off it is a ghost then
//   3  weak boxes alone keep a track only for "Keep a hidden person" seconds after the last strong one, then it retires; they never start a new one
//   4  a hidden (ghost) person needs two weak boxes to come back
//   5  two people: the weak box goes to the nearest track only, a far weak box extends nothing, a strong box that covers it wins
//   6  a head-only weak box moves the track but keeps its size; speed untouched
//   7  detectImage: pool boxes (person, under the cut-off) are returned on .pool only, never in the list; off when not asked; cars/crops not pooled
//   8  live path: the export sample holds the kept person (bt box), search rows ignore it, personTracks keeps its shape
//   9  D.buildTracks (search / export tracking): pool boxes extend, never start
//  10  Settings: the switch, the ?byte=0 override, "Keep a hidden person" off = byte off
// Usage: BR=chromium|webkit [DEV=desktop|phone] node test/bytetrack.js [url]
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
(async () => {
  const pw = require("playwright");
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium"])) {
    const b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
    for (const dev of [{ name: "desktop", viewport: { width: 1280, height: 800 } }, { name: "phone", viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, userAgent: UA, deviceScaleFactor: 2 }].filter((d) => !process.env.DEV || d.name === process.env.DEV)) {
      const tag = BR + " " + dev.name + ": ";
      const ctx = await b.newContext(dev), p = await ctx.newPage(), errs = [];
      p.on("pageerror", (e) => errs.push(e.message));
      await p.goto(URL_ + "?nosw=1", { waitUntil: "load" });
      await p.evaluate(() => { localStorage.setItem("tdc.seed", "off"); localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, live: true, model: "nano", speed: "balanced", occl: 3.5 })); });
      await p.reload({ waitUntil: "load" });
      // shared helpers inside the page
      await p.evaluate(() => {
        const D = TDC.detect;
        D.liveCams = () => ["front"]; D.liveEvery = () => 200; D.speed = () => "balanced";
        window.H = {
          reset(byte) { D.clear(); D.setPref("byte", byte || "on"); D.setPref("occl", 3.5); },
          P: (x, conf, o) => Object.assign({ x, y: 0.3, w: 0.08, h: 0.3, cls: 0, label: "person", conf }, o || {}),
          vis: (cam, t) => (D.liveTracks[cam] || []).filter((tr) => tr.label === "person" && !tr.weak && t - tr.seen <= 0.5),
          ids: (cam) => (D.liveTracks[cam] || []).map((tr) => tr.id),
        };
      });
      // ── 1. weak boxes alone never start a track ──
      const R1 = await p.evaluate(() => {
        H.reset(); const out = { n: 0 };
        for (let i = 0; i < 30; i++) { const t = i * 0.2; D = TDC.detect; const wm = D._track("front", t, [], [H.P(0.4 + i * 0.001, 0.25)]); out.n += (D.liveTracks.front || []).length + (wm ? wm.length : 0); }
        return out;
      });
      ok(tag + "weak person boxes alone never start a track (30 looks)", R1.n === 0, R1);
      // ── 2. strong → weak → strong keeps ONE identity and is visible; setting off: ghost ──
      const run = (byte) => p.evaluate((byte) => {
        H.reset(byte); const D = TDC.detect, vis = [], idsSeen = new Set(); let x = 0.3, weakVisible = 0, weakN = 0, bt = 0;
        for (let i = 0; i < 40; i++) {
          const t = i * 0.2; x += 0.012;
          const strongPart = t < 2 || t >= 5;   // weak between 2.2 s and 4.8 s (a van in front of him)
          const wm = D._track("front", t, strongPart ? [H.P(x, 0.8)] : [], strongPart ? [] : [H.P(x + 0.004, 0.22)]);
          const v = H.vis("front", t); v.forEach((tr) => idsSeen.add(tr.id));
          if (!strongPart) { weakN++; if (v.length === 1) weakVisible++; bt += wm ? wm.length : 0; }
          vis.push(v.length);
        }
        const tr = (D.liveTracks.front || []).filter((q) => q.label === "person");
        return { ids: [...idsSeen], weakVisible, weakN, bt, tracks: tr.length, finalVisible: vis[vis.length - 1] };
      }, byte);
      const on = await run("on"), off = await run("off");
      ok(tag + "setting on: one identity through a 2.6 s weak part, visible on every look, the end is the same person", on.ids.length === 1 && on.weakVisible === on.weakN && on.bt === on.weakN && on.tracks === 1 && on.finalVisible === 1, on);
      ok(tag + "setting off (the old behaviour): hidden (ghost, after the 0.5 s a look stays valid) during the weak part, same identity back after", off.weakVisible <= 3 && off.ids.length === 1 && off.bt === 0, off);
      // ── 3. retire after "Keep a hidden person" ──
      const R3 = await p.evaluate(() => {
        H.reset(); const D = TDC.detect, o = { aliveAt: {} }; let id = null;
        for (let i = 0; i < 80; i++) {
          const t = i * 0.2, strong = t < 2;
          D._track("front", t, strong ? [H.P(0.3 + t * 0.01, 0.8)] : [], strong ? [] : [H.P(0.32, 0.2)]);
          if (!id && (D.liveTracks.front || [])[0]) id = D.liveTracks.front[0].id;
          if ([3, 5, 5.4, 6, 8, 15].some((q) => Math.abs(t - q) < 0.01)) o.aliveAt[t.toFixed(1)] = H.vis("front", t).length;
        }
        o.tracks = (D.liveTracks.front || []).length; o.id = id; return o;
      });
      ok(tag + "weak boxes keep the person for 3.5 s after the last strong look, then he retires (nothing new is started by them)", R3.aliveAt["3.0"] === 1 && R3.aliveAt["5.0"] === 1 && R3.aliveAt["6.0"] === 0 && R3.aliveAt["8.0"] === 0 && R3.aliveAt["15.0"] === 0 && R3.tracks === 0, R3);
      const R3b = await p.evaluate(() => {
        H.reset(); const D = TDC.detect; D.setPref("occl", 2);
        for (let i = 0; i < 60; i++) { const t = i * 0.2, strong = t < 2; D._track("front", t, strong ? [H.P(0.3, 0.8)] : [], strong ? [] : [H.P(0.3, 0.2)]); }
        const a = (D.liveTracks.front || []).length; return { tracksAt12s: a };
      });
      ok(tag + "the retire time follows the setting (2 s: gone before 12 s)", R3b.tracksAt12s === 0, R3b);
      // ── 4. a ghost needs two weak boxes ──
      const R4 = await p.evaluate(() => {
        H.reset(); const D = TDC.detect, o = {};
        for (let i = 0; i <= 10; i++) D._track("front", i * 0.2, [H.P(0.3, 0.8)], []);   // seen to 2.0 s
        D._track("front", 3.0, [], []);   // nothing at 3.0: a ghost
        const tr = D.liveTracks.front[0]; o.id = tr.id;
        D._track("front", 3.2, [], [H.P(0.3, 0.22)]); o.after1 = H.vis("front", 3.2).length;
        D._track("front", 3.4, [], [H.P(0.3, 0.22)]); o.after2 = H.vis("front", 3.4).length; o.same = D.liveTracks.front.length === 1 && D.liveTracks.front[0].id === tr.id;
        return o;
      });
      ok(tag + "a ghost: one weak box is not enough, the second one brings the same person back", R4.after1 === 0 && R4.after2 === 1 && R4.same, R4);
      // ── 5. two people, strong wins, far weak box ──
      const R5 = await p.evaluate(() => {
        H.reset(); const D = TDC.detect, o = {};
        for (let i = 0; i < 8; i++) D._track("front", i * 0.2, [H.P(0.2, 0.8), H.P(0.6, 0.8)], []);
        const [A, B] = D.liveTracks.front.slice().sort((a, b) => a.x - b.x), ax = A.x, bx = B.x, bid = B.id;
        // A strong, B only weak (a bit to the right of it), another weak box far from both
        const wm = D._track("front", 1.6, [H.P(0.2, 0.8)], [H.P(0.63, 0.2), H.P(0.9, 0.25, { y: 0.1 })]);
        o.wm = wm.map((q) => q.id); o.bid = bid; o.aMoved = Math.abs(A.x - ax) < 0.02; o.bSeen = B.seen; o.n = D.liveTracks.front.length;
        // a strong box that covers the weak one: the weak box is ignored (B has no strong box so it would be the one it could extend)
        const wm2 = D._track("front", 1.8, [H.P(0.2, 0.8), H.P(0.62, 0.8)], [H.P(0.63, 0.2)]); o.coveredBt = wm2.length;
        return o;
      });
      ok(tag + "two people: the weak box extends only the nearest unmatched track, the far weak box nothing, no new track", R5.wm.length === 1 && R5.wm[0] === R5.bid && R5.aMoved && R5.n === 2, R5);
      ok(tag + "a strong box on the same person wins: the weak box is not used", R5.coveredBt === 0, R5);
      const R5b = await p.evaluate(() => {
        H.reset(); const D = TDC.detect, o = {};
        for (let i = 0; i < 8; i++) D._track("front", i * 0.2, [H.P(0.56, 0.42)], []);   // never scored 0.5: a headrest, a coat on a hook
        const wm = D._track("front", 1.6, [], [H.P(0.56, 0.2)]); o.lowPeak = wm.length;
        H.reset(); for (let i = 0; i < 8; i++) D._track("front", i * 0.2, [H.P(0.56, i === 3 ? 0.55 : 0.42)], []);   // one look at 0.55 is a person
        o.peak = D._track("front", 1.6, [], [H.P(0.56, 0.2)]).length; return o;
      });
      ok(tag + "a track that never scored 0.5 (headrest-like) is not kept alive by weak boxes; one that did is", R5b.lowPeak === 0 && R5b.peak === 1, R5b);
      // ── 6. head-only box keeps the size ──
      const R6 = await p.evaluate(() => {
        H.reset(); const D = TDC.detect;
        for (let i = 0; i < 8; i++) D._track("front", i * 0.2, [H.P(0.4, 0.8)], []);
        const tr = D.liveTracks.front[0], w0 = tr.w, h0 = tr.h, vx0 = tr.vx, vy0 = tr.vy;
        const wm = D._track("front", 1.6, [], [{ x: 0.405, y: 0.31, w: 0.07, h: 0.12, cls: 0, label: "person", conf: 0.18 }]);   // head and shoulders over a roof
        return { matched: wm.length, same: tr.w === w0 && tr.h === h0, v: tr.vx === vx0 && tr.vy === vy0, ys: tr.y, h0, score: D._btScore({ x: 0.4, y: 0.3, w: 0.08, h: 0.3 }, { x: 0.405, y: 0.31, w: 0.07, h: 0.12 }) };
      });
      ok(tag + "a head-only weak box (inside the person's box) is a match, the track keeps its size and speed", R6.matched === 1 && R6.same && R6.v && R6.score > 0, R6);
      // ── 7. detectImage pool ──
      const R7 = await p.evaluate(async () => {
        const D = TDC.detect, o = {}; D.setPref("byte", "on");
        const set = [{ x: 0.1, y: 0.2, w: 0.1, h: 0.4, cls: 0, conf: 0.8 }, { x: 0.5, y: 0.2, w: 0.1, h: 0.4, cls: 0, conf: 0.22 }, { x: 0.7, y: 0.5, w: 0.1, h: 0.1, cls: 2, conf: 0.22 }, { x: 0.8, y: 0.2, w: 0.1, h: 0.4, cls: 0, conf: 0.05 }];
        D._mock = async () => set.map((d) => ({ ...d }));
        const a = await D.detectImage({}, 1448, 938, { cam: "front", look: true, conf: 0.35, pool: 0.1 });
        o.dets = a.map((d) => d.label + ":" + d.conf); o.pool = (a.pool || []).map((d) => d.label + ":" + d.conf);
        const b0 = await D.detectImage({}, 1448, 938, { cam: "front", look: true, conf: 0.35 }); o.noAsk = b0.map((d) => d.label + ":" + d.conf); o.noAskPool = (b0.pool || []).length;
        const c = await D.detectImage({}, 1448, 938, { cam: "front", look: true, conf: 0.35, pool: 0.1, noFix: true }); o.noFix = c.map((d) => d.label + ":" + d.conf); o.noFixPool = (c.pool || []).length;
        D._mock = async () => [{ x: 0.0, y: 0.5, w: 0.12, h: 0.5, cls: 0, conf: 0.25 }, { x: 0.5, y: 0.2, w: 0.1, h: 0.4, cls: 0, conf: 0.22 }, { x: 0.8, y: 0.2, w: 0.1, h: 0.4, cls: 0, conf: 0.8 }];
        const d2 = await D.detectImage({}, 1448, 938, { cam: "back", look: true, conf: 0.35, pool: 0.1 }); o.rear = d2.map((d) => d.label + ":" + d.conf + (d.weak ? "w" : "")); o.rearPool = (d2.pool || []).map((d) => d.conf);
        D._mock = null; return o;
      });
      ok(tag + "detectImage(pool): person boxes under the cut-off come back on .pool only; the list has no weak box; car and 0.05 are not pooled", JSON.stringify(R7.dets) === '["person:0.8"]' && JSON.stringify(R7.pool) === '["person:0.22"]', R7);
      ok(tag + "detectImage without pool or with noFix: nothing is pooled or leaks into the list", R7.noAsk.length === 1 && R7.noAskPool === 0 && R7.noFix.length === 1 && R7.noFixPool === 1, R7);
      ok(tag + "rear camera: the existing low-person-at-the-edge legs look is unchanged (kept as a weak look, not pooled); another low person is pooled", R7.rear.includes("person:0.25w") && R7.rear.includes("person:0.8") && R7.rear.length === 2 && JSON.stringify(R7.rearPool) === "[0.22]", R7);
      // ── 8. live path + export sample ──
      const R8 = await p.evaluate(async () => {
        H.reset(); const D = TDC.detect, o = {}; let t = 0, phase = 0, x = 0.3;
        D._clock = () => t * 1000;
        D._mock = async (img, iw, ih, op) => {
          if (op.crops) return [];
          x += 0.01;
          if (phase === 0) return [{ x, y: 0.3, w: 0.08, h: 0.3, cls: 0, conf: 0.85 }];
          return [{ x: x + 0.003, y: 0.3, w: 0.08, h: 0.3, cls: 0, conf: 0.2 }];
        };
        const cv = document.createElement("canvas"); cv.width = 320; cv.height = 180;
        for (let i = 0; i < 19; i++) { t = i * 0.2; phase = t < 2 ? 0 : 1; await D._detectLive("front", cv, t); }   // to 3.6 s: 1.6 s of weak boxes
        const lv = D.live.front, smp = (D.liveSamples.front || []).filter((s) => s.t > 2.1 && s.t < 3.5);
        o.liveBt = lv.dets.filter((d) => d.bt).length; o.sampleBt = smp.map((s) => s.dets.filter((d) => d.bt).length);
        o.rows = D.liveRows("person").filter((r) => r.t > 2.1).length; o.visible = H.vis("front", t).length;
        const pt = D.personTracks(t); o.keys = pt[0] ? Object.keys(pt[0]).sort().join(",") : null; o.n = pt.length;
        D._mock = null; D._clock = null; return o;
      });
      ok(tag + "live: the kept person is on the export's samples (bt box), search rows ignore it, still ONE person", R8.liveBt === 1 && R8.visible === 1 && R8.sampleBt.length > 0 && R8.sampleBt.every((n) => n === 1) && R8.rows === 0 && R8.n === 1, R8);
      const keysOn = R8.keys;
      const R8b = await p.evaluate(async () => {
        H.reset("off"); const D = TDC.detect; let t = 0; D._clock = () => t * 1000; D._mock = async () => [{ x: 0.3, y: 0.3, w: 0.08, h: 0.3, cls: 0, conf: 0.85 }];
        const cv = document.createElement("canvas"); cv.width = 320; cv.height = 180;
        for (let i = 0; i < 6; i++) { t = i * 0.2; await D._detectLive("front", cv, t); }
        const pt = D.personTracks(t); D._mock = null; D._clock = null; return { keys: pt[0] ? Object.keys(pt[0]).sort().join(",") : null };
      });
      ok(tag + "personTracks output has the same fields as before (people.js / handoff.js unchanged)", !!keysOn && keysOn === R8b.keys, { on: keysOn, off: R8b.keys });
      // ── 9. buildTracks ──
      const R9 = await p.evaluate(() => {
        const D = TDC.detect, B = (x, c) => ({ x, y: 0.3, w: 0.08, h: 0.3, cls: 0, label: "person", conf: c });
        const fr = [{ t: 0, dets: [B(0.3, 0.8)] }, { t: 0.25, dets: [B(0.31, 0.8)] }, { t: 0.5, dets: [], pool: [B(0.32, 0.2), B(0.8, 0.25)] }, { t: 0.75, dets: [], pool: [B(0.33, 0.2)] }, { t: 1, dets: [B(0.34, 0.8)] }];
        const tr = D.buildTracks(fr), noPool = D.buildTracks(fr.map((f) => ({ t: f.t, dets: f.dets })));
        return { n: tr.length, pts: tr[0].pts.length, confs: tr[0].pts.map((p) => p.conf), size: tr[0].pts[2].w === tr[0].pts[1].w, noPoolN: noPool.length, noPoolPts: noPool.map((q) => q.pts.length) };
      });
      ok(tag + "buildTracks: pool boxes extend the track (5 points, one track) and a far one starts nothing; without pool the old result", R9.n === 1 && R9.pts === 5 && R9.size && R9.noPoolN === 1 && R9.noPoolPts[0] === 3, R9);
      // ── 10. settings ──
      const R10 = await p.evaluate(() => {
        const D = TDC.detect, o = {}; D.setPref("byte", "on"); D.setPref("occl", 3.5); o.on = D.byteOn(); D.setPref("byte", "off"); o.off = D.byteOn(); D.setPref("byte", "on"); D.setPref("occl", 0); o.occl0 = D.byteOn(); D.setPref("occl", 3.5);
        D.renderSettings && D.renderSettings(); const el = document.getElementById("detByte"); o.ui = !!el; if (el) { el.checked = false; el.onchange({ target: el }); o.afterUi = D.prefs().byte; D.setPref("byte", "on"); }
        o.def = D.defaults().byte;
        return o;
      });
      ok(tag + "setting: on/off works, 'Keep a hidden person' off turns it off, the Settings switch is wired", R10.on === true && R10.off === false && R10.occl0 === false && R10.def === "on", R10);
      const urlOff = await (async () => { const q = await ctx.newPage(); await q.goto(URL_ + "?nosw=1&byte=0", { waitUntil: "load" }); const v = await q.evaluate(() => TDC.detect.byteOn()); await q.goto(URL_ + "?nosw=1&byte=1", { waitUntil: "load" }); const w = await q.evaluate(() => { TDC.detect.setPref("byte", "off"); return TDC.detect.byteOn(); }); await q.close(); return [v, w]; })();
      ok(tag + "?byte=0 turns it off, ?byte=1 forces it on", urlOff[0] === false && urlOff[1] === true, urlOff);
      ok(tag + "no page errors", errs.length === 0, errs.slice(0, 3));
      await ctx.close();
    }
    await b.close();
  }
  console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
