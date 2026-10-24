// Perf budget for Cross-camera matching (beta) (tag handoff-m4): phone emulation (iPhone UA, 430x932 @3x), Chromium with a CDP CPU throttle
// (THR, default 4x; a mid-range phone is about 4-6x slower than the test box). Three walkers on three cameras for DUR seconds with the REAL re-ID
// model in the worker and the real colour descriptors; the detector is a mock that answers after INF ms (as in test/live-lag.js), so what is measured
// is what cross-camera matching adds: main-thread frame times (rAF gaps), descriptor / embedding cost, and the demotion guard.
// Chromium compares crossCam off vs on. WebKit (iPhone UA, no throttle available) is run too as a smoke test.
// Usage: BR=chromium|webkit THR=4 INF=150 DUR=12 node test/reid-perf.js    (JSON=/tmp/x.json)    ASSERT=1 fails when over budget
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html", MOCK = process.env.MOCK || "/tmp/ho-mock";
const THR = +(process.env.THR || 4), INF = +(process.env.INF || 150), DUR = +(process.env.DUR || 12);
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 600) : "")); if (!c && process.env.ASSERT !== "0") fails++; };
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
(async () => {
  const pw = require("playwright");
  if (!fs.existsSync(MOCK + "/TeslaCam")) execFileSync("python3", [path.join(__dirname, "../tools/make-mock-footage.py"), MOCK, "--jobs", "4"], { stdio: "inherit" });
  const BR = process.env.BR || "chromium", res = {};
  const b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  for (const mode of ["off", "on"]) {
    const ctx = await b.newContext({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, userAgent: UA, deviceScaleFactor: 3 }); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
    await p.goto(URL_, { waitUntil: "load" });
    await p.evaluate((m) => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, live: true, model: "nano" })); const pr = JSON.parse(localStorage.getItem("tdc.prefs.v1") || "{}"); pr.crossCam = m; pr.cue = true; localStorage.setItem("tdc.prefs.v1", JSON.stringify(pr)); }, mode);
    await p.reload({ waitUntil: "load" });
    await p.setInputFiles("#folderInput", MOCK + "/TeslaCam");
    for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 2; i++) await W(250);
    await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
    await p.evaluate(() => TDC.ui.activate(TDC.library.events.find((e) => /Sentry/.test(e.source)))); await W(900);
    await p.evaluate(() => TDC.detect.load()); // real YOLO worker up (idle: the detector below is a mock answering after INF ms)
    if (BR === "chromium") { const cdp = await ctx.newCDPSession(p); await cdp.send("Emulation.setCPUThrottlingRate", { rate: THR }); }
    await p.evaluate((inf) => {
      const D = TDC.detect; window.__gaps = []; let last = performance.now(); (function tick() { const n = performance.now(); window.__gaps.push(n - last); last = n; requestAnimationFrame(tick); })();
      D.detectImage = async (img, iw, ih, opts) => {
        const P = TDC.player, cam = Object.keys(P.tiles).find((c) => P.tiles[c].vids.includes(img)), t = P.time; await new Promise((r) => setTimeout(r, inf));
        if (opts && opts.crops) return [];
        const mk = (x, y) => ({ x, y, w: 0.09, h: 0.34, cls: 0, conf: 0.85, label: "person" });
        if (cam === "right_repeater") return [mk(0.15 + 0.06 * t, 0.35), mk(0.6, 0.4)];
        if (cam === "back") return [mk(0.3 + 0.03 * t, 0.38)];
        if (cam === "front") return [mk(0.7 - 0.02 * t, 0.36)];
        return [];
      };
      TDC.player.seek(0); TDC.player.play();
    }, INF);
    await W(1500); await p.evaluate(() => { window.__gaps.length = 0; });
    await W(DUR * 1000);
    const r = await p.evaluate(() => {
      const g = window.__gaps.slice().sort((a, b) => a - b), q = (f) => g[Math.min(g.length - 1, Math.floor(g.length * f))], R = TDC.reid, S = R.stats, mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
      return { frames: g.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), p99: +q(0.99).toFixed(1), max: +g[g.length - 1].toFixed(0), over100: g.filter((x) => x > 100).length,
        linkOn: TDC.people.linkOn(), jobs: S.jobs, embJobs: S.embJobs, descMs: +mean(S.descMs).toFixed(2), embMs: +mean(S.embMs).toFixed(0), backend: S.backend, loaded: S.loaded, demoted: S.demoted, error: S.error, skipped: S.skipped, autoOff: R.autoOff(),
        persons: TDC.people.reg.persons.size, withEmb: [...R.mem.values()].filter((e) => e.emb).length, withHist: [...R.mem.values()].filter((e) => e.hist).length, status: R.statusText() };
    });
    res[mode] = r; console.log(BR + " crossCam=" + mode + " THR=" + THR + ": " + JSON.stringify(r));
    ok(BR + " crossCam=" + mode + ": no page errors", errs.length === 0, errs);
    await ctx.close();
  }
  await b.close();
  const on = res.on, off = res.off;
  ok("when off: no descriptors, no model work", off.jobs === 0 && off.embJobs === 0 && !off.loaded, off);
  ok("when on: colour descriptors for the walkers" + (BR === "chromium" ? " and appearance embeddings from the real model" : ""), on.jobs > 10 && on.withHist >= 3 && (BR !== "chromium" || on.withEmb >= 2), on);
  ok("frame pacing: p95 frame gap with matching on is at most 8 ms above off (" + off.p95 + " → " + on.p95 + " ms), no more than 6 extra frames over 100 ms", on.p95 <= off.p95 + 8 && on.over100 <= off.over100 + 6, [off, on]);
  ok("descriptor cost: mean " + on.descMs + " ms per crop is under the Auto limit (14 ms on phones) so matching stays on", on.descMs < 14 && !on.autoOff, on);
  if (process.env.JSON) fs.writeFileSync(process.env.JSON, JSON.stringify({ BR, THR, INF, DUR, res }, null, 1));
  console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
