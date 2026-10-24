// Layout presets (js/layout.js, tag handoff-m1): Current / Rear view / Mirrored bottom row / Auto.
//  Part 1 (node): pure helpers — Auto by trigger kind, order, which cameras mirror, box mirroring, side swap.
//  Part 2 (Playwright WebKit + Chromium, desktop 1440x900 and phone 430x932 touch): on a six-camera mock TeslaCam folder
//    - default is Auto, Sentry → Rear view (bottom row RIGHT REPEATER | REAR | LEFT REPEATER), Dashcam (Saved) → Current
//    - Rear view / Mirrored bottom row / Current chosen from the menu (on phones: from the pull-up sheet), choice persisted across a reload
//    - Mirrored: only the three bottom VIDEOS are flipped; tiles' labels are not (no transform on them), top row untouched
//    - zoom keeps natural dragging on a flipped camera, the un-flipped box layer gets the plain transform; boxes are mirrored in x
//    - GRID (export order) is untouched; focus + back to the grid keeps the preset
// Usage: BR=chromium|webkit node test/layout-presets.js [url]   MOCK=dir with make-mock-footage.py output (made on demand: /tmp/ho-mock)
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const L = require("../js/layout.js");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const MOCK = process.env.MOCK || "/tmp/ho-mock";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 600) : "")); if (!c) fails++; };

// ── part 1 ──
ok("Auto: sentry → rear; user/safety/recent/files/none → current", L.autoPreset({ trigger: { kind: "sentry" } }) === "rear" && ["user", "safety", "recent", "files"].every((k) => L.autoPreset({ trigger: { kind: k } }) === "current") && L.autoPreset(null) === "current" && L.autoPreset({}) === "current");
ok("resolve: explicit choice wins, junk → auto", L.resolve("current", { trigger: { kind: "sentry" } }) === "current" && L.resolve("mirror", { trigger: { kind: "user" } }) === "mirror" && L.resolve("zzz", { trigger: { kind: "sentry" } }) === "rear");
ok("order: Current bottom LR|REAR|RR, Rear/Mirror bottom RR|REAR|LR, top row unchanged", L.gridOrder("current").join() === "left_pillar,front,right_pillar,left_repeater,back,right_repeater" && L.gridOrder("rear").join() === "left_pillar,front,right_pillar,right_repeater,back,left_repeater" && L.gridOrder("mirror").join() === L.gridOrder("rear").join());
ok("mirror: only the three bottom cameras, only in Mirrored bottom row", ["left_repeater", "back", "right_repeater"].every((c) => L.isMirrored("mirror", c) && !L.isMirrored("rear", c) && !L.isMirrored("current", c)) && ["front", "left_pillar", "right_pillar"].every((c) => !L.isMirrored("mirror", c)));
ok("mirrorBox flips x about the centre, keeps y/w/h and extra fields", JSON.stringify(L.mirrorBox({ x: 0.1, y: 0.2, w: 0.2, h: 0.3, text: "p" })) === JSON.stringify({ x: 0.7, y: 0.2, w: 0.2, h: 0.3, text: "p" }) && L.screenSide(true, "left") === "right" && L.screenSide(false, "left") === "left");

(async () => {
  let pw = null; try { pw = require("playwright"); } catch (_) {}
  if (!pw || process.env.NODE_ONLY) { console.log(fails ? "FAILED " + fails : "ALL PASS (node part only)"); process.exit(fails ? 1 : 0); }
  if (!fs.existsSync(MOCK + "/TeslaCam")) execFileSync("python3", [path.join(__dirname, "../tools/make-mock-footage.py"), MOCK, "--jobs", "4"], { stdio: "inherit" });
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    const b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
    for (const dev of [{ name: "desktop", viewport: { width: 1440, height: 900 } }, { name: "phone", viewport: { width: 430, height: 932 }, isMobile: BR !== "webkit" || true, hasTouch: true, userAgent: UA, deviceScaleFactor: 2 }]) {
      const tag = BR + " " + dev.name + ": ";
      const ctx = await b.newContext(Object.assign({}, dev, { name: undefined })); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
      await p.goto(URL_, { waitUntil: "load" });
      await p.setInputFiles("#folderInput", MOCK + "/TeslaCam");
      for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 2; i++) await W(250);
      await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
      const kinds = await p.evaluate(() => TDC.library.events.map((e) => e.source + ":" + e.trigger.kind));
      ok(tag + "mock folder has a Sentry and a Saved (Dashcam) event", kinds.some((k) => /Sentry/.test(k) && /sentry$/.test(k)) && kinds.some((k) => /SavedClips/.test(k)), kinds);
      const open = async (re) => { await p.evaluate((re) => TDC.ui.activate(TDC.library.events.find((e) => new RegExp(re).test(e.source))), re); await W(900); };
      const info = () => p.evaluate(() => {
        const g = document.getElementById("grid"), tiles = [...g.querySelectorAll(".tile")].filter((t) => !t.classList.contains("off") && t.offsetParent).map((t) => { const r = t.getBoundingClientRect(); const v = t.querySelector("video.on") || t.querySelector("video"); const lab = t.querySelector(".tile-label"); return { cam: t.dataset.cam, x: Math.round(r.left), y: Math.round(r.top), vScale: getComputedStyle(v).scale, vTf: getComputedStyle(v).transform, mirrored: t.classList.contains("mirrored"), labScale: getComputedStyle(lab).scale, labTf: getComputedStyle(lab).transform }; });
        tiles.sort((a, b) => a.y - b.y || a.x - b.x);
        return { layout: g.getAttribute("data-layout"), order: tiles.map((t) => t.cam), tiles, pref: TDC.prefs.layout, sel: document.getElementById("layoutSel").value, grid: TDC.GRID.join() };
      });
      const GRID0 = "left_pillar,front,right_pillar,left_repeater,back,right_repeater";
      const rowsOk = (I, bottom) => { const o = I.tiles.map((t) => t.cam); return dev.name === "desktop" ? o.join() === ["left_pillar", "front", "right_pillar"].concat(bottom).join() : true; };
      const choose = async (v) => {
        if (dev.name === "phone") { await p.evaluate(() => TDC.mobileBar && TDC.mobileBar.setOpen(true)); await W(500); }
        await p.selectOption("#layoutSel", v); await W(500);
        if (dev.name === "phone") { await p.evaluate(() => TDC.mobileBar && TDC.mobileBar.setOpen(false)); await W(400); }
      };
      if (dev.name === "phone") {
        ok(tag + "layout menu lives in the pull-up sheet", await p.evaluate(() => !!document.querySelector("#mbSheet #layoutSel")));
        await p.evaluate(() => TDC.mobileBar.setOpen(true)); await W(500);
        const hb = await p.evaluate(() => { const e = document.getElementById("layoutSel"); e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(), t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { w: r.width, h: r.height, hit: t === e, right: r.right, iw: innerWidth }; });
        ok(tag + "layout menu is tappable in the open sheet (>= 40 px high, on screen, top-most)", hb.h >= 40 && hb.hit && hb.right <= hb.iw + 1, hb);
        await p.evaluate(() => TDC.mobileBar.setOpen(false)); await W(300);
      }
      ok(tag + "Auto is the default", (await p.evaluate(() => TDC.prefs.layout)) === "auto" && (await p.evaluate(() => document.getElementById("layoutSel").value)) === "auto");
      ok(tag + "menu text", JSON.stringify(await p.evaluate(() => [...document.querySelectorAll("#layoutSel option")].map((o) => o.textContent))) === JSON.stringify(["Auto (Sentry: Rear view, Dashcam: Current)", "Current", "Rear view", "Mirrored bottom row"]));
      await open("Sentry"); let I = await info();
      ok(tag + "Auto + Sentry event → Rear view, bottom row RIGHT REPEATER | REAR | LEFT REPEATER", I.layout === "rear" && rowsOk(I, ["right_repeater", "back", "left_repeater"]) && I.tiles.every((t) => !t.mirrored), I);
      if (dev.name === "phone") ok(tag + "portrait: repeater row is RIGHT then LEFT", I.order.slice(-2).join() === "right_repeater,left_repeater", I.order);
      await open("SavedClips"); I = await info();
      ok(tag + "Auto + Saved (Dashcam) event → Current", I.layout === "current" && rowsOk(I, ["left_repeater", "back", "right_repeater"]), I);
      await choose("mirror"); I = await info();
      const mir = I.tiles.filter((t) => t.mirrored).map((t) => t.cam).sort().join();
      ok(tag + "Mirrored bottom row on a Dashcam event: order Rear view", I.layout === "mirror" && I.pref === "mirror" && rowsOk(I, ["right_repeater", "back", "left_repeater"]), I);
      ok(tag + "only the 3 bottom videos are flipped (scale -1 1)", mir === "back,left_repeater,right_repeater" && I.tiles.filter((t) => t.mirrored).every((t) => t.vScale === "-1 1") && I.tiles.filter((t) => !t.mirrored).every((t) => t.vScale === "none"), I.tiles.map((t) => [t.cam, t.vScale]));
      ok(tag + "labels are NOT flipped", I.tiles.every((t) => t.labScale === "none" && (t.labTf === "none" || /^matrix\(1, 0, 0, 1/.test(t.labTf))), I.tiles.map((t) => [t.cam, t.labScale, t.labTf]));
      ok(tag + "export order (T.GRID) untouched", I.grid === GRID0);
      await open("Sentry"); I = await info();
      ok(tag + "explicit choice beats Auto (Sentry event stays Mirrored)", I.layout === "mirror" && I.tiles.filter((t) => t.mirrored).length === 3, I);
      // zoom a mirrored camera, check dragging direction + un-flipped layers
      const z = await p.evaluate(async () => {
        const F = TDC.focus; F.focus("back"); await new Promise((r) => setTimeout(r, 400));
        F.zoomTo(2, 0, 0); F.x = 40; F.y = 10; F.zoomTo(2, 0, 0);
        const v = TDC.player.tiles.back.vids[TDC.player.active];
        const before = { vid: v.style.transform, plain: v._zoomPlain, F: [F.x, F.y, F.z] };
        try { TDC.search.paintBoxes(); } catch (e) {}
        const fl = TDC.player.tiles.back.tile.querySelector(".find-layer");
        return Object.assign(before, { find: fl ? fl.style.transform : null, mirrored: TDC.layout.mirrored("back") });
      });
      ok(tag + "zoom on a flipped camera: video pan x negated (so dragging stays natural), plain transform kept for un-flipped layers", z.mirrored && z.F[2] > 1.5 && z.vid.includes("translate(" + -z.F[0] + "px") && z.plain.includes("translate(" + z.F[0] + "px") && (z.find === null || z.find === z.plain), z);
      await p.evaluate(() => TDC.focus.focus(null)); await W(300); await p.evaluate(() => TDC.focus.resetZoom && TDC.focus.resetZoom());
      I = await info(); ok(tag + "back to the grid: preset kept", I.layout === "mirror" && rowsOk(I, ["right_repeater", "back", "left_repeater"]), I);
      await p.reload({ waitUntil: "load" }); await W(500);
      ok(tag + "choice is remembered after a reload", (await p.evaluate(() => [TDC.prefs.layout, document.getElementById("layoutSel").value])).join() === "mirror,mirror");
      await choose("auto"); await choose("rear"); I = await info();
      ok(tag + "Rear view chosen: no mirroring", I.layout === "rear" && I.tiles.every((t) => !t.mirrored && t.vScale === "none"), I.tiles.map((t) => [t.cam, t.vScale]));
      ok(tag + "no page errors", errs.length === 0, errs);
      await ctx.close();
    }
    await b.close();
  }
  console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})();
