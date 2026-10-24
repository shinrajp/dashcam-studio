// Desktop bottom bar (tag ui-v3): how much height the camera grid gets at 1440x900 and 1920x1080, with the default controls and with Advanced
// (trim) on, plus reachability / keyboard checks. Usage: BR=chromium|webkit node test/desktop-bottom.js [url]   SHOT=/tmp/dir saves screenshots
//   ASSERT=0 only prints the numbers (used for the "before" measurement)
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html", MOCK = process.env.MOCK || "/tmp/ho-mock", SHOT = process.env.SHOT, ASSERT = process.env.ASSERT !== "0";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { if (!ASSERT) return; console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 600) : "")); if (!c) fails++; };
const PROBE = () => {
  const r = (id) => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height), bottom: Math.round(b.bottom), w: Math.round(b.width) }; };
  const g = document.getElementById("grid").getBoundingClientRect();
  return { vh: innerHeight, grid: { w: Math.round(g.width), h: Math.round(g.height) }, stage: r("stage"), footer: document.querySelector("footer") ? (() => { const b = document.querySelector("footer").getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height) }; })() : null, transport: r("transport"), scrub: (() => { const e = document.querySelector(".tp-scrub"); return e ? Math.round(e.getBoundingClientRect().height) : null; })(), controls: (() => { const e = document.querySelector(".tp-controls"); return e ? Math.round(e.getBoundingClientRect().height) : null; })(), timeline: r("timeline"), docH: document.documentElement.scrollHeight, scrolls: document.documentElement.scrollHeight > innerHeight + 1 };
};
(async () => {
  const pw = require("playwright");
  if (!fs.existsSync(MOCK + "/TeslaCam")) execFileSync("python3", [path.join(__dirname, "../tools/make-mock-footage.py"), MOCK, "--jobs", "4"], { stdio: "inherit" });
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium"])) {
    const b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
    const res = {};
    for (const vp of ([{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 1440, height: 700 }, { width: 1366, height: 768 }, { width: 1280, height: 720 }]).filter(v => !process.env.ONLY || process.env.ONLY.split(',').includes(v.width + 'x' + v.height))) {
      for (const adv of (process.env.ADV === "1" ? [true] : process.env.ADV === "0" ? [false] : [false, true])) {
        const tag = BR + " " + vp.width + "x" + vp.height + (adv ? " advanced" : "") + ": ";
        const ctx = await b.newContext({ viewport: vp }); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
        await p.goto(URL_, { waitUntil: "load" });
        await p.evaluate((adv) => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); if (adv) localStorage.setItem("tdc.prefs.v1", JSON.stringify({ advanced: true })); }, adv); await p.reload({ waitUntil: "load" });   // detection off: only the layout is measured (and headless WebKit stays light)
        await p.setInputFiles("#folderInput", MOCK + "/TeslaCam");
        for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 2; i++) await W(250);
        await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
        await p.evaluate(() => TDC.ui.activate(TDC.library.events.find((e) => /Sentry/.test(e.source)))); await W(1200);
        const m = await p.evaluate(PROBE); res[vp.width + "x" + vp.height + (adv ? "A" : "")] = m;
        console.log("MEASURE " + tag + JSON.stringify(m));
        if (SHOT) { fs.mkdirSync(SHOT, { recursive: true }); await p.screenshot({ path: SHOT + "/bottom-" + BR + "-" + vp.width + (adv ? "-adv" : "") + ".png" }); }
        ok(tag + "no page scroll (everything fits in the window)", !m.scrolls, m);
        // every control reachable: visible, on screen, and focusable by keyboard
        const ids = ["btnStop", "btnBack", "btnPlay", "btnFwd", "rateSelect", "layoutSel", "chipCar", "chipCue", "btnFullscreen", "timeline"].concat(adv ? ["btnAddSeg", "btnSplitSeg", "btnIn", "btnOut", "btnPlaySecs", "btnDelSeg", "btnClearSegs"] : []);
        const reach = await p.evaluate((ids) => ids.map((id) => { const e = document.getElementById(id); if (!e) return [id, "missing"]; const r = e.getBoundingClientRect(), cs = getComputedStyle(e); const vis = r.width > 4 && r.height > 4 && cs.visibility !== "hidden" && cs.display !== "none" && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1 && r.top >= -1; return vis ? null : [id, [Math.round(r.top), Math.round(r.bottom), Math.round(r.width)]]; }).filter(Boolean), ids);
        ok(tag + "every control is visible and on screen", reach.length === 0, reach);
        const tab = await p.evaluate(() => { const seen = new Set(); const f = [...document.querySelectorAll("footer button, footer select, footer [tabindex], footer input")].filter((e) => e.tabIndex >= 0 && !e.disabled); return f.length; });
        ok(tag + "controls stay keyboard focusable (>= 10)", tab >= 10, tab);
        ok(tag + "no page errors", errs.length === 0, errs);
        await ctx.close();
      }
    }
    console.log("SUMMARY " + BR + " " + JSON.stringify(Object.fromEntries(Object.entries(res).map(([k, v]) => [k, { grid: v.grid.h, stage: v.stage && v.stage.h, footer: v.footer && v.footer.h }]))));
    await b.close();
  }
  if (ASSERT) console.log(fails ? "FAILED " + fails : "ALL PASS");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
