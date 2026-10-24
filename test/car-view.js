// Car view (tag handoff-m3): Playwright WebKit + Chromium, desktop 1440x900 and phone 430x932.
//  off by default, chip toggles + remembered; six wedges; one tiny person (head + body) per tracked person in distinct colours; the same colour
//  on the boxes of the tiles; tap a person / legend chip highlights their boxes; compact on phones and inside the stage; no page errors.
// Usage: BR=chromium|webkit node test/car-view.js [url]   SHOT=/tmp/cv.png (chromium) saves a screenshot
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
    for (const dev of [{ name: "desktop", viewport: { width: 1440, height: 900 } }, { name: "phone", viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, userAgent: UA, deviceScaleFactor: 2 }]) {
      const tag = BR + " " + dev.name + ": ";
      const ctx = await b.newContext(dev); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
      await p.goto(URL_, { waitUntil: "load" });
      await p.evaluate(() => localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, live: true, model: "nano" }))); await p.reload({ waitUntil: "load" });
      await p.setInputFiles("#folderInput", MOCK + "/TeslaCam");
      for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 2; i++) await W(250);
      await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
      await p.evaluate(() => TDC.ui.activate(TDC.library.events.find((e) => /Sentry/.test(e.source)))); await W(900);
      await p.evaluate(() => { TDC.player.pause(); });
      ok(tag + "Car view is off by default (no panel visible)", await p.evaluate(() => { const e = document.getElementById("carView"); return !!e && e.hidden && TDC.prefs.carView === false; }));
      if (dev.isMobile) { await p.evaluate(() => TDC.mobileBar && TDC.mobileBar.setOpen && TDC.mobileBar.setOpen(true)); await W(500); }
      const chipBox = await p.evaluate(() => { const r = document.getElementById("chipCar").getBoundingClientRect(); return { w: r.width, h: r.height }; });
      ok(tag + "the Car view chip is tappable (>= 28 px)", chipBox.h >= 28 && chipBox.w >= 28, chipBox);
      await p.click("#chipCar"); await W(300);
      if (dev.isMobile) { await p.evaluate(() => TDC.mobileBar.setOpen(false)); await W(400); }
      const s0 = await p.evaluate(() => { const e = document.getElementById("carView"), st = document.getElementById("stage").getBoundingClientRect(), r = e.getBoundingClientRect(); return { shown: !e.hidden, pref: TDC.prefs.carView, wedges: e.querySelectorAll(".cv-wedge").length, people: e.querySelectorAll(".cv-person").length, w: r.width, h: r.height, inStage: r.left >= st.left - 1 && r.right <= st.right + 1 && r.top >= st.top - 1 && r.bottom <= st.bottom + 1, areaPct: Math.round(100 * r.width * r.height / (st.width * st.height)), hint: e.querySelector(".cv-hint").textContent }; });
      ok(tag + "chip shows the panel (six wedges, nobody tracked yet, says what it needs), inside the stage", s0.shown && s0.pref === true && s0.wedges === 6 && s0.people <= 1 && (s0.people > 0 || /Nobody tracked|detection/i.test(s0.hint)) && s0.inStage, s0);
      ok(tag + (dev.isMobile ? "compact on the phone: <= 105 px wide, < 12% of the picture" : "desktop panel: <= 160 px wide, < 6% of the picture"), dev.isMobile ? s0.w <= 105 && s0.areaPct < 12 : s0.w <= 160 && s0.areaPct < 6, s0);
      // three people: two on different cameras, one more on a third; positions from camera + box
      const st = await p.evaluate(() => {
        const D = TDC.detect, t = TDC.player.time || 0; D.clear(); TDC.people.reset();
        const pe = (x, h) => [{ x, y: 0.3, w: 0.08, h, label: "person", conf: 0.8 }];
        for (const [cam, x, h] of [["front", 0.3, 0.5], ["back", 0.6, 0.2], ["left_pillar", 0.5, 0.35]]) { D._track(cam, t - 0.3, pe(x, h)); D._track(cam, t, pe(x, h)); }
        TDC.carView.render(true);
        const e = document.getElementById("carView");
        const ppl = [...e.querySelectorAll(".cv-person")].map((g) => ({ gid: g.getAttribute("data-gid"), fill: g.querySelector(".cv-head").getAttribute("fill"), shape: g.querySelectorAll("circle.cv-head").length === 1 && g.querySelectorAll("path.cv-body").length === 1, tf: g.getAttribute("transform") }));
        return { ppl, chips: [...e.querySelectorAll(".cv-chip")].map((c) => c.textContent), on: [...e.querySelectorAll(".cv-wedge.on")].map((w) => w.getAttribute("data-cam")), label: e.querySelector("svg").getAttribute("aria-label") };
      });
      ok(tag + "three people → three tiny human icons (one head + one body each) in three distinct colours, legend P1..P3, their wedges lit", st.ppl.length === 3 && st.ppl.every((x) => x.shape) && new Set(st.ppl.map((x) => x.fill)).size === 3 && st.chips.join() === "P1,P2,P3" && st.on.sort().join() === "back,front,left_pillar", st);
      const where = st.ppl.map((x) => { const m = /translate\(([\d.]+) ([\d.]+)\)/.exec(x.tf); return { x: +m[1], y: +m[2] }; });
      ok(tag + "icons sit where the cameras point: front person above the car, rear person below, left-pillar person on its left", where[0].y < 50 && where[1].y > 50 && where[2].x < 50, where);
      // colours on the tile boxes
      const col = await p.evaluate(() => { const P = TDC.people, bx = TDC.detect.trackedLive("front", TDC.player.time).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, text: "person 80%", label: "person", pid: b.id })); const st = P.styleBoxes("front", bx); const m = P.now.find((x) => x.cam === "front"); return { color: st[0].color, expect: m.color, text: st[0].text, hl: st[0].hl }; });
      ok(tag + "the front person's box gets the same colour as their icon and a name (P1)", col.color === col.expect && /P1/.test(col.text) && col.hl === false, col);
      // tap
      await p.evaluate(() => TDC.carView.render(true));
      if (dev.isMobile) await p.tap('.cv-chip[data-gid]:nth-child(2)'); else await p.click('.cv-chip[data-gid]:nth-child(2)'); await W(200);
      const sel = await p.evaluate(() => { const P = TDC.people; const m = P.now.find((x) => P.name(x) === "P2"); const bx = TDC.detect.trackedLive("back", TDC.player.time).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, text: "person", label: "person", pid: b.id })); return { selected: P.selected === m.gid, hlBack: P.styleBoxes("back", bx)[0].hl, hlFront: P.styleBoxes("front", TDC.detect.trackedLive("front", TDC.player.time).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, text: "person", label: "person", pid: b.id })))[0].hl, ring: document.querySelectorAll("#carView .cv-ring").length, pressed: document.querySelector('#carView .cv-chip.sel') && document.querySelector('#carView .cv-chip.sel').textContent }; });
      ok(tag + "tapping P2 highlights only P2's boxes (heavier outline) and rings their icon", sel.selected && sel.hlBack === true && sel.hlFront === false && sel.ring === 1 && sel.pressed === "P2", sel);
      // tap on the icon itself (svg)
      await p.evaluate(() => { const g = document.querySelector('#carView .cv-person[data-gid]'); g.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      await W(150);
      ok(tag + "tapping an icon toggles the highlight (first person selected now)", await p.evaluate(() => { const P = TDC.people, m = P.now.find((x) => P.name(x) === "P1"); return P.selected !== null && document.querySelectorAll("#carView .cv-ring").length === 1; }));
      if (process.env.SHOT && BR === "chromium") await p.screenshot({ path: process.env.SHOT.replace(/\.png$/, "-" + dev.name + ".png") });
      // remembered
      await p.reload({ waitUntil: "load" }); await p.setInputFiles("#folderInput", MOCK + "/TeslaCam");
      for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 2; i++) await W(250);
      await p.evaluate(() => TDC.ui.activate(TDC.library.events.find((e) => /Sentry/.test(e.source)))); await W(900);
      ok(tag + "the choice is remembered after a reload (panel back, chip pressed)", await p.evaluate(() => !document.getElementById("carView").hidden && document.getElementById("chipCar").getAttribute("aria-pressed") === "true"));
      await p.evaluate(() => { TDC.player.pause(); if (TDC.mobileBar && TDC.mobileBar.setOpen) TDC.mobileBar.setOpen(true); }); await W(400); await p.click("#chipCar"); await W(200);
      ok(tag + "chip off again → panel hidden, pref false", await p.evaluate(() => document.getElementById("carView").hidden && TDC.prefs.carView === false));
      ok(tag + "no page errors", errs.length === 0, errs);
      await ctx.close();
    }
    await b.close();
  }
  console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})();
