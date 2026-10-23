// Phones: slim playback bar + pull-up sheet (js/mobile-bar.js, tag mobile-bar).
//  - 430×932 (iPhone Pro Max portrait) and 932×430 (landscape), WebKit + Chromium, touch emulation, iPhone UA
//  - slim bar: only play / time / timeline visible, ≤ 64 px (no safe-area inset in emulation); camera area height
//  - handle tap opens / closes; drag up opens, drag down closes; tap on the cameras closes (and does nothing else)
//  - the sheet overlays the cameras (the grid does not resize); every transport control is reachable in it
//  - open state remembered across a reload, first visit collapsed; reduced motion: no transition
//  - timeline scrub in the slim bar seeks (and doesn't open the sheet); Space still plays / pauses
//  - adding a section opens the sheet at the trim row; desktop 1280×800 unchanged (no slim bar)
// Usage: node test/mobile-bar.js [url]   BR=chromium,webkit  LIVE_FIX=synthetic footage dir (test/live-lag.js makes it)
//   MEASURE=1: only the camera-area numbers + screenshots (works on the old layout too)   SHOTS=dir for screenshots
const pw = require("playwright"); const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.LIVE_FIX || "/tmp/live-lag-fix", SHOTS = process.env.SHOTS || "", MEASURE = !!process.env.MEASURE;
const STAMP = "2026-10-16_12-00-00";
if (!fs.existsSync(FIX + "/plate-truth.json")) execFileSync("python3", [path.join(__dirname, "../tools/make-plate-footage.py"), FIX], { stdio: "inherit", env: { ...process.env, PLATE_MOTION: "fast" } });
const clipDir = path.join(FIX, "TeslaCam/SavedClips", STAMP);
const files = fs.readdirSync(clipDir).filter((f) => !f.startsWith(".")).map((f) => path.join(clipDir, f));
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 600) : "")); if (!c) fails++; };
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const results = [];
const SHEET_IDS = ["btnStop", "btnBack", "btnFwd", "rateSelect", "chipCamBar", "btnFullscreen", "btnAddSeg", "btnSplitSeg", "btnIn", "btnOut"];

const metrics = (p) => p.evaluate(() => {
  const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, b: b.bottom }; };
  const vp = document.getElementById("viewport"), tp = document.getElementById("transport");
  const tiles = [...document.querySelectorAll("#grid .tile")].filter((t) => !t.classList.contains("off") && t.offsetParent).map(r);
  const cs = getComputedStyle(vp);
  return { ih: innerHeight, iw: innerWidth, vpH: vp.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom), vp: r(vp), tp: r(tp), bar: r(document.getElementById("mbBar")),
    tilesTop: Math.min(...tiles.map((t) => t.y)), tilesBottom: Math.max(...tiles.map((t) => t.b)), tileH: tiles.length ? tiles[0].h : 0, nTiles: tiles.length,
    mbar: document.body.classList.contains("mbar"), open: !!(window.TDC.mobileBar && TDC.mobileBar.open) };
});
// is the element the top-most thing at its own centre (= a finger can hit it)?
const hittable = (p, id) => p.evaluate((id) => {
  const e = document.getElementById(id); if (!e) return { id, missing: true };
  e.scrollIntoView({ block: "nearest", inline: "nearest" });
  const b = e.getBoundingClientRect(); if (!b.width || !b.height) return { id, hidden: true };
  const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
  return { id, ok: !!top && (top === e || e.contains(top)), w: b.width, h: b.height, top: top && (top.id || top.className) };
}, id);
const sheetY = (p) => p.evaluate(() => { const s = document.getElementById("mbSheet"); if (!s) return null; const b = s.getBoundingClientRect(); return { top: b.top, h: b.height, vis: getComputedStyle(s).visibility }; });
// wait until the sheet has finished sliding (headless WebKit here runs rAF at ~2 Hz with six videos: a 0.26 s slide
// takes seconds there)
async function settle(p) {
  for (let i = 0; i < 60; i++) {
    const s = await p.evaluate(() => { const e = document.getElementById("mbSheet"); if (!e) return true; const cs = getComputedStyle(e), open = e.closest(".mb-open"); return open ? cs.transform === "none" || /1, 0, 0, 1, 0, 0\)/.test(cs.transform) : cs.visibility === "hidden"; });
    if (s) return; await W(200);
  }
}
// a touch-style drag on an element: pointer events with pointerType touch (WebKit / Chromium both)
async function drag(p, sel, dy) {
  await p.evaluate(async ({ sel, dy }) => {
    const e = document.querySelector(sel), b = e.getBoundingClientRect(), x = b.left + b.width / 2, y0 = b.top + b.height / 2;
    const ev = (type, y) => e.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1 }));
    ev("pointerdown", y0);
    for (let i = 1; i <= 10; i++) { ev("pointermove", y0 + (dy * i) / 10); await new Promise((r) => setTimeout(r, 16)); }
    ev("pointerup", y0 + dy);
  }, { sel, dy });
  await W(300); await settle(p);
}
async function load(ctx, opts) {
  const p = await ctx.newPage(); p.setDefaultTimeout(120000); const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p._errs = errs;
  await p.goto(URL_, { waitUntil: "load" });
  if (opts && opts.fresh) await p.evaluate(() => { localStorage.removeItem("tdc.mbarOpen"); });
  await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false, live: false })); });
  await p.addStyleTag({ content: ".toast{display:none!important}" });
  await p.setInputFiles("#fileInput", opts && opts.few ? files.filter((f) => !/(pillar|repeater)/.test(f)) : files);   // few: front + back (headless WebKit's decoders here stall on the 3rd six-video page)
  for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(async () => { if (TDC.setPref) TDC.setPref("advanced", true); document.body.classList.remove("simple"); await TDC.ui.activate(TDC.library.events[0]); });
  await W(1200);
  return p;
}
(async () => {
  for (const bn of (process.env.BR || "chromium,webkit").split(",")) {
    const b = await pw[bn].launch(bn === "chromium" ? { executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] } : {});
    for (const [w, h, orient] of [[430, 932, "portrait"], [932, 430, "landscape"]]) {
      const tag = bn + " " + orient;
      const copts = { viewport: { width: w, height: h }, deviceScaleFactor: 3, isMobile: bn === "chromium", hasTouch: true, userAgent: UA };
      let ctx = await b.newContext(copts);
      // a reload: a fresh context with the same localStorage (headless WebKit here stalls on a second page with six
      // videos in one context)
      const reopen = async () => { const st = await ctx.storageState(); await ctx.close(); ctx = await b.newContext({ ...copts, storageState: st }); return load(ctx, { few: true }); };
      // (a new context: empty localStorage, so the first visit is collapsed)
      let p = await load(ctx);
      const M0 = await metrics(p);
      const res = { browser: bn, orient, w, h, camAreaH: Math.round(M0.vpH), tilesH: Math.round(M0.tilesBottom - M0.tilesTop), tileH: Math.round(M0.tileH), transportH: Math.round(M0.tp.h), mbar: M0.mbar };
      if (SHOTS) await p.screenshot({ path: path.join(SHOTS, bn + "-" + orient + (MEASURE ? "-measure" : "-collapsed") + ".png") });
      if (MEASURE) { results.push(res); console.log("RESULT " + JSON.stringify(res)); await ctx.close(); continue; }
      ok(tag + ": phone layout (body.mbar), starts collapsed", M0.mbar && !M0.open, M0);
      ok(tag + ": slim bar ≤ 64 px", M0.tp.h <= 64 && M0.tp.h >= 56, M0.tp);
      ok(tag + ": bar sits at the bottom", Math.abs(M0.tp.b - M0.ih) <= 1, M0.tp);
      for (const id of ["btnPlay", "timeline", "timeLabel", "mbMore", "mbGrip"]) { const r = await hittable(p, id); ok(tag + ": " + id + " visible in the slim bar", r.ok, r); }
      for (const id of ["btnPlay", "mbMore"]) { const r = await hittable(p, id); ok(tag + ": " + id + " ≥ 44 px", r.w >= 44 && r.h >= 44, r); }
      const hid = await p.evaluate((ids) => ids.filter((id) => { const e = document.getElementById(id); if (!e) return false; const b = e.getBoundingClientRect(); const t = b.width && document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return t && (t === e || e.contains(t)); }), SHEET_IDS);
      ok(tag + ": the other controls are hidden while collapsed", hid.length === 0, hid);
      const ta = await p.evaluate(() => [getComputedStyle(document.getElementById("mbGrip")).touchAction, getComputedStyle(document.getElementById("timeline")).touchAction]);
      ok(tag + ": touch-action none on the handle (and the timeline keeps its own)", ta[0] === "none" && ta[1] === "none", ta);
      ok(tag + ": no lane in the slim timeline", await p.evaluate(() => document.body.classList.contains("mb-slim")));
      // timeline scrub in the bar
      const dur = await p.evaluate(() => TDC.player.duration());
      const tl = await p.evaluate(() => { const b = document.getElementById("timeline").getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
      await p.touchscreen.tap(tl.x + tl.w * 0.75, tl.y + tl.h / 2); await W(400);
      const t1 = await p.evaluate(() => TDC.player.time);
      ok(tag + ": tap on the slim timeline seeks (≈75 %)", Math.abs(t1 / dur - 0.75) < 0.08 && !(await metrics(p)).open, { t1, dur });
      // tap the handle → open
      const g = await p.evaluate(() => { const b = document.getElementById("mbMore").getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; });
      await p.touchscreen.tap(g[0], g[1]); await W(300); await settle(p);
      let M1 = await metrics(p), S1 = await sheetY(p);
      ok(tag + ": tap ⌃ opens the sheet", M1.open && S1.vis === "visible" && Math.abs(S1.top + S1.h - M1.tp.y) <= 2, { M1, S1 });
      ok(tag + ": the sheet overlays (camera area unchanged)", Math.abs(M1.vpH - M0.vpH) <= 1, [M0.vpH, M1.vpH]);
      if (SHOTS) await p.screenshot({ path: path.join(SHOTS, bn + "-" + orient + "-open.png") });
      const reach = [];
      for (const id of SHEET_IDS) reach.push(await hittable(p, id));
      const chips = await p.evaluate(() => [...document.querySelectorAll("#chips .chip")].filter((c) => getComputedStyle(c).display !== "none").map((c) => c.id || c.dataset.show));
      for (const c of chips) { const id = await p.evaluate((c) => { const e = document.getElementById(c) || document.querySelector('#chips [data-show="' + c + '"]'); if (!e.id) e.id = "mbt-" + c; return e.id; }, c); reach.push(await hittable(p, id)); }
      const bad = reach.filter((r) => !r.ok || r.h < 44);
      ok(tag + ": every control reachable in the sheet, ≥ 44 px tall (" + reach.length + ")", bad.length === 0 && reach.length >= SHEET_IDS.length + 4, bad);
      ok(tag + ": the timeline is in the sheet with the sections lane", await p.evaluate(() => !!document.querySelector("#mbSheet #timeline") && !document.body.classList.contains("mb-slim")));
      await p.evaluate(() => document.getElementById("mbSheet").scrollTo(0, 0));
      // tap on the cameras closes, and doesn't switch to a single camera
      const foc0 = await p.evaluate(() => TDC.focus && TDC.focus.cam ? TDC.focus.cam : null);
      await p.touchscreen.tap(w / 2, M1.vp.y + 30); await W(300); await settle(p);
      const M2 = await metrics(p), foc1 = await p.evaluate(() => TDC.focus && TDC.focus.cam ? TDC.focus.cam : null);
      ok(tag + ": tap on the cameras closes the sheet (and nothing else)", !M2.open && foc0 === foc1 && (await sheetY(p)).vis === "hidden", { open: M2.open, foc0, foc1 });
      // drag up opens, drag down closes
      await drag(p, "#mbGrip", -260);
      ok(tag + ": drag the grip up opens", (await metrics(p)).open);
      await drag(p, "#mbGrip", 240);
      ok(tag + ": drag the grip down closes", !(await metrics(p)).open);
      await drag(p, "#mbGrip", -30);   // short slow drag: snaps back closed
      ok(tag + ": a short drag snaps back", !(await metrics(p)).open);
      // remembered state
      await p.touchscreen.tap(g[0], g[1]); await W(300); await settle(p);
      p = await reopen();
      ok(tag + ": open state remembered after reload", (await metrics(p)).open);
      await p.evaluate(() => TDC.mobileBar.setOpen(false)); await settle(p);
      p = await reopen();
      ok(tag + ": closed state remembered after reload", !(await metrics(p)).open);
      // Space still plays / pauses
      await p.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
      const pl0 = await p.evaluate(() => TDC.player.playing); await p.keyboard.press("Space"); await W(300);
      const pl1 = await p.evaluate(() => TDC.player.playing); await p.keyboard.press("Space"); await W(200);
      ok(tag + ": Space toggles play", pl0 !== pl1, [pl0, pl1]);
      // a new section opens the sheet at the trim row
      await p.evaluate(() => TDC.ui.addSeg()); await W(300); await settle(p);
      const sg = await hittable(p, "btnDelSeg");
      ok(tag + ": adding a section opens the sheet at the trim row", (await metrics(p)).open && sg.ok, sg);
      ok(tag + ": the handle shows the section count", await p.evaluate(() => { const b = document.getElementById("mbBadge"); return !b.hidden && +b.textContent >= 1; }));
      // Esc closes
      await p.keyboard.press("Escape"); await W(300); await settle(p);
      ok(tag + ": Esc closes", !(await metrics(p)).open);
      // reduced motion
      await p.emulateMedia({ reducedMotion: "reduce" });
      const tr = await p.evaluate(() => getComputedStyle(document.getElementById("mbSheet")).transitionDuration);
      ok(tag + ": reduced motion: no slide", tr.split(",").every((x) => parseFloat(x) < 0.02), tr);
      await p.emulateMedia({ reducedMotion: "no-preference" });
      ok(tag + ": no page errors", p._errs.length === 0, p._errs);
      results.push({ ...res, open: 1 });
      console.log("RESULT " + JSON.stringify(res));
      await ctx.close();
    }
    if (!MEASURE) {   // desktop: untouched
      const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
      const p = await load(ctx, { few: true }); const M = await metrics(p);
      const d = await p.evaluate(() => ({ inTp: !!document.querySelector("#transport > .tp-controls") && !!document.querySelector("#transport > .tp-scrub #timeline"), bar: !!document.getElementById("mbBar") }));
      ok(bn + " desktop: transport unchanged (no slim bar / sheet)", !M.mbar && d.inTp && !d.bar, { M, d });
      // narrow the window to phone width and back: nodes move to the sheet and back
      await p.setViewportSize({ width: 700, height: 800 }); await W(300);
      const n = await p.evaluate(() => document.body.classList.contains("mbar") && !!document.querySelector("#mbRow #btnPlay"));
      await p.setViewportSize({ width: 1280, height: 800 }); await W(300);
      const back = await p.evaluate(() => !document.body.classList.contains("mbar") && !!document.querySelector("#transport > .tp-controls .tp-buttons #btnPlay") && !!document.querySelector("#transport > .tp-scrub #timeline") && !document.getElementById("mbSheet"));
      ok(bn + " desktop: narrow → slim bar, wide again → the original transport", n && back, { n, back });
      ok(bn + " desktop: no page errors", p._errs.length === 0, p._errs);
      await ctx.close();
    }
    await b.close();
  }
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(results, null, 1));
  console.log(fails ? "FAILED " + fails : "ALL PASS");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
