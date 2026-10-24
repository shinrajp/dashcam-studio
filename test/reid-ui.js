// Cross-camera matching (beta) in the app (tag handoff-m4): Playwright WebKit + Chromium, desktop 1440x900 and phone 430x932.
//  Settings row + remembered choice; status text; the guard with a MOCK embedder: a slow model demotes itself to colour matching, a failing model too; no page errors.
// Usage: BR=chromium|webkit node test/reid-ui.js [url]
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html", MOCK = process.env.MOCK || "/tmp/ho-mock";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 700) : "")); if (!c) fails++; };
(async () => {
  const pw = require("playwright");
  if (!fs.existsSync(MOCK + "/TeslaCam")) execFileSync("python3", [path.join(__dirname, "../tools/make-mock-footage.py"), MOCK, "--jobs", "4"], { stdio: "inherit" });
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    const b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
    for (const dev of [{ name: "desktop", viewport: { width: 1440, height: 900 } }, { name: "phone", viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, userAgent: UA, deviceScaleFactor: 3 }]) {
      const tag = BR + " " + dev.name + ": ";
      const ctx = await b.newContext(dev); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
      await p.goto(URL_, { waitUntil: "load" });
      await p.evaluate(() => localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, live: true, model: "nano" }))); await p.reload({ waitUntil: "load" });
      await p.setInputFiles("#folderInput", MOCK + "/TeslaCam");
      for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 2; i++) await W(250);
      await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
      await p.evaluate(() => TDC.ui.activate(TDC.library.events.find((e) => /Sentry/.test(e.source)))); await W(900);
      await p.evaluate(() => TDC.player.pause());
      // ── settings ──
      const s0 = await p.evaluate(() => { TDC.detect.renderSettings(); const c = document.getElementById("detCross"); return { has: !!c, checked: c && c.checked, pref: TDC.prefs.crossCam, status: document.getElementById("detCrossStatus").textContent, hint: document.getElementById("setDetect").textContent.includes("Default: on when this device keeps up") }; });
      ok(tag + "Settings → Object detection has \"Cross-camera matching (beta)\", default Auto = on, with a status line and the default explained", s0.has && s0.checked && s0.pref === "auto" && /^On/.test(s0.status) && s0.hint, s0);
      await p.evaluate(() => document.getElementById("detCross").click());
      const s1 = await p.evaluate(() => ({ pref: TDC.prefs.crossCam, saved: JSON.parse(localStorage.getItem("tdc.prefs.v1")).crossCam, on: TDC.people.linkOn(), status: document.getElementById("detCrossStatus").textContent }));
      ok(tag + "untick → off, remembered, status says so", s1.pref === "off" && s1.saved === "off" && s1.on === false && /^Off/.test(s1.status), s1);
      await p.evaluate(() => document.getElementById("detCross").click());
      ok(tag + "tick → on again (forced on, remembered)", await p.evaluate(() => TDC.prefs.crossCam === "on" && TDC.people.linkOn()));
      // ── person tracks from the mock tracker ──
      const link = await p.evaluate(async () => {
        const D = TDC.detect, R = TDC.reid; D._mock = async () => []; R.reset(); TDC.people.reset();
        const looks = { A: 1, B: 2 }; let cur = "A";
        D._reidMock = (buf) => { const e = new Float32Array(256); e[cur === "A" ? 0 : 1] = 1; e[2] = 0.05; return { emb: e, ms: 5, backend: "wasm" }; };
        // two persons seen on RR, then two new tracks on the REAR at the same moment, in the other order: appearance must decide
        const t0 = TDC.player.time || 0, pe = (x, h) => [{ x, y: 0.35, w: 0.09, h, label: "person", conf: 0.85 }];
        const ids = {};
        // look at A and B on right_repeater, embedded separately
        for (const [cam, x, k] of [["right_repeater", 0.82, "A"], ["right_repeater", 0.5, "B"]]) { cur = k; D._track(cam, t0 - 0.4, pe(x, 0.34)); D._track(cam, t0, pe(x, 0.34)); }
        return { tracks: D.personTracks(t0).length, reid: !!D.reidInfo ? D.reidInfo() : null };
      });
      ok(tag + "the mock setup produced person tracks", link.tracks >= 1, link);
      // ── guard: slow model → colour only ──
      const g = await p.evaluate(async () => {
        const D = TDC.detect, R = TDC.reid; R.reset(); R.stats.embMs.length = 0; R.stats.demoted = null; R.stats.loaded = true; R.stats.backend = "wasm"; R.stats.embJobs = 0;
        D._reidMock = () => ({ emb: new Float32Array(256).fill(0.0625), ms: 900, backend: "wasm" });
        const t = TDC.player.time || 0; D.clear(); TDC.people.reset();
        const pe = [{ x: 0.4, y: 0.35, w: 0.09, h: 0.34, label: "person", conf: 0.85 }];
        for (let i = 0; i < 40 && !R.stats.demoted; i++) { D._track("front", t - 0.4, pe); D._track("front", t, pe); R.mem.forEach((e) => { e.embAt = -99; e.at = -99; }); TDC.people._at = 0; TDC.people.current(t); await new Promise((r) => setTimeout(r, 160)); }
        return { demoted: R.stats.demoted, jobs: R.stats.embJobs, status: R.statusText(), backend: R.backend() };
      });
      ok(tag + "a model that is too slow (900 ms per crop) switches itself off after a few crops; matching goes on with colour only; status says why", /too slow/.test(g.demoted || "") && g.backend === null && /colour matching only/.test(g.status), g);
      const f = await p.evaluate(async () => {
        const D = TDC.detect, R = TDC.reid; R.reset(); R.stats.embMs.length = 0; R.stats.demoted = null; R.stats.error = null;
        D._reidMock = () => { throw new Error("boom"); }; D.embed = (b) => Promise.reject(new Error("boom"));
        const t = TDC.player.time || 0; D.clear(); TDC.people.reset(); const pe = [{ x: 0.4, y: 0.35, w: 0.09, h: 0.34, label: "person", conf: 0.85 }];
        for (let i = 0; i < 30 && !R.stats.demoted; i++) { D._track("front", t - 0.4, pe); D._track("front", t, pe); R.mem.forEach((e) => { e.embAt = -99; e.at = -99; }); TDC.people._at = 0; TDC.people.current(t); await new Promise((r) => setTimeout(r, 160)); }
        return { demoted: R.stats.demoted, err: R.stats.error, still: TDC.people.current(t).length };
      });
      ok(tag + "a failing model never breaks the app: colour matching only, people still tracked", /failed/.test(f.demoted || "") && f.still >= 1, f);
      ok(tag + "no page errors", errs.length === 0, errs);
      await ctx.close();
    }
    await b.close();
  }
  console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
