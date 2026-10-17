// Search window: docked below the video (default, never over a camera), float + drag (mouse/touch/keys, clamped),
// pin (no drag, persists, clamps when the viewport shrinks), dock back; phone full-screen thumbnail strip
// (390x844 + landscape): lazy thumbnails, tap seeks + switches camera + gold box, camera thumbnails, collapse.
// Runs in Chromium and WebKit (playwright). Usage: node test/search-float.js [url]   (SHOTS=dir for screenshots)
const { chromium, webkit } = require("playwright"); const fs = require("fs"), path = require("path");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.FIXTURES || "/workspace/photo-samples/TeslaCam";
const SHOTS = process.env.SHOTS || "";
const ENGINES = (process.env.ENGINES || "chromium,webkit").split(",");
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) { if (!/2026-10-08_09-01-00/.test(q)) w(q); } else if (/\.(mp4|json)$/.test(f) && f !== "base.mp4") files.push(q); } })(FIX);
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x) : "")); if (!c) fails++; };
const HITS = `TDC.search.phrase = "car"; TDC.search.hits = [
  { t: 1.0, cam: "front", score: 0.1, box: { x: 0.40, y: 0.40, w: 0.15, h: 0.15 } },
  { t: 3.2, cam: "back", score: 0.08, box: { x: 0.30, y: 0.45, w: 0.18, h: 0.20 } },
  { t: 5.2, cam: "left_repeater", score: 0.07, weak: true }];
  TDC.search.renderHits(); TDC.searchUI.refresh();`;
async function open(p) {
  await p.goto(URL_, { waitUntil: "load" });
  if (SHOTS) await p.addStyleTag({ content: ".toast{display:none!important}" });
  await p.setInputFiles("#fileInput", files);
  for (let i = 0; i < 80 && (await p.evaluate(() => TDC.library.events.length)) < 3; i++) await W(250);
  await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); return TDC.ui.activate(TDC.library.events.find((e) => /18-2/.test(e.id))); });
  await W(1200);
}
// WebKit headless sometimes never answers the first evaluate after loading files: retry once on a fresh page.
async function openPage(ctx) {
  for (let a = 1; ; a++) {
    const p = await ctx.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message));
    try { await Promise.race([open(p), W(60000).then(() => { throw new Error("load timed out"); })]); return p; }
    catch (e) { console.log("NOTE page load retry (" + e.message + ")"); await p.close().catch(() => {}); if (a >= 3) throw e; }
  }
}
const geo = (p) => p.evaluate(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  const pn = document.getElementById("usPanel"), P = r(pn);
  const V = r(document.getElementById("viewport"));   // tiles scrolled out of the (portrait) viewport are clipped: count only the visible part
  const tiles = [...document.querySelectorAll("#grid .tile")].filter((t) => !t.classList.contains("off") && t.offsetWidth).map(r)
    .map((t) => ({ l: Math.max(t.l, V.l), r: Math.min(t.r, V.r), t: Math.max(t.t, V.t), b: Math.min(t.b, V.b) })).filter((t) => t.r > t.l && t.b > t.t);
  const overlap = tiles.some((t) => P.l < t.r - 1 && P.r > t.l + 1 && P.t < t.b - 1 && P.b > t.t + 1);
  const st = r(document.getElementById("stage"));
  return { P, st, overlap, mode: TDC.searchUI.win.mode, pinned: TDC.searchUI.win.pinned, inDock: pn.parentElement.id === "usDock", pos: getComputedStyle(pn).position, vw: innerWidth, vh: innerHeight };
});
async function drag(p, from, dx, dy, touch) {
  if (!touch) { await p.mouse.move(from.x, from.y); await p.mouse.down(); await p.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 5 }); await p.mouse.move(from.x + dx, from.y + dy, { steps: 5 }); await p.mouse.up(); }
  else await p.evaluate(({ x, y, dx, dy }) => {   // synthetic touch-type pointer events (pointer capture path)
    const h = document.getElementById("usHead"), o = { bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", isPrimary: true, button: 0, buttons: 1 };
    h.dispatchEvent(new PointerEvent("pointerdown", { ...o, clientX: x, clientY: y }));
    for (let i = 1; i <= 6; i++) h.dispatchEvent(new PointerEvent("pointermove", { ...o, clientX: x + dx * i / 6, clientY: y + dy * i / 6 }));
    h.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0, clientX: x + dx, clientY: y + dy }));
  }, { ...from, dx, dy });
  await W(300);
}
const grip = (p) => p.evaluate(() => { const b = document.getElementById("usGrip").getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; });

async function desktop(b, tag) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await openPage(ctx);
  await p.evaluate((h) => { TDC.searchUI.show(false); eval(h); }, HITS); await W(500);
  let g = await geo(p);
  ok(tag + " default: docked below the video, in page flow", g.mode === "dock" && g.inDock && g.pos !== "fixed" && g.P.t >= g.st.b - 1, g);
  ok(tag + " docked panel covers no camera", !g.overlap, g);
  ok(tag + " grid still fits above the dock", g.st.b <= g.P.t + 1 && g.st.t >= 0);
  if (SHOTS) { await p.evaluate(() => TDC.player.seek(1)); await W(700); await p.screenshot({ path: SHOTS + "/search-float-desktop-docked.png" }); }
  // float
  await p.click("#usFloat"); await W(300); g = await geo(p);
  ok(tag + " Float: detaches into a fixed window", g.mode === "float" && !g.inDock && g.pos === "fixed" && g.P.w > 250, g);
  const dockHidden = await p.evaluate(() => document.getElementById("usDock").hidden);
  ok(tag + " Float: dock strip removed, video gets the height back", dockHidden);
  // drag by header (mouse), onto the grid and then off to the far left (clamped)
  let s0 = g.P, gp = await grip(p);
  await drag(p, gp, -300, -250); g = await geo(p);
  ok(tag + " drag by header moves the window", Math.abs(g.P.l - (s0.l - 300)) < 3 && Math.abs(g.P.t - (s0.t - 250)) < 3, { s0, now: g.P });
  gp = await grip(p); await drag(p, gp, -3000, -3000); g = await geo(p);
  ok(tag + " drag is clamped to the viewport", g.P.l >= 0 && g.P.t >= 0 && g.P.l < 20 && g.P.t < 20, g.P);
  gp = await grip(p); await drag(p, gp, 900, 520, true); g = await geo(p);
  ok(tag + " touch drag moves it too (anywhere, incl. over the grid)", g.P.l > 850 && g.P.t > 480, g.P);
  // keyboard
  s0 = g.P; await p.focus("#usGrip"); await p.keyboard.press("ArrowLeft"); await p.keyboard.press("ArrowUp"); await W(100); g = await geo(p);
  ok(tag + " arrow keys on the grip move it", Math.abs(g.P.l - (s0.l - 12)) < 2 && Math.abs(g.P.t - (s0.t - 12)) < 2, { s0, now: g.P });
  if (SHOTS) { await p.screenshot({ path: SHOTS + "/search-float-desktop-floating.png" }); }
  // pin
  await p.click("#usPin"); await W(200); s0 = (await geo(p)).P;
  gp = await grip(p); await drag(p, gp, -400, -200); g = await geo(p);
  ok(tag + " pinned: drag does nothing", g.pinned && Math.abs(g.P.l - s0.l) < 1 && Math.abs(g.P.t - s0.t) < 1, { s0, now: g.P });
  await p.focus("#usPin"); await p.keyboard.press("Tab"); await p.keyboard.press("ArrowLeft"); g = await geo(p);
  ok(tag + " pinned: arrow keys don't move it either", Math.abs(g.P.l - s0.l) < 1);
  ok(tag + " pinned: no resize handle", await p.evaluate(() => getComputedStyle(document.getElementById("usPanel")).resize === "none"));
  ok(tag + " pin button pressed state", await p.evaluate(() => document.getElementById("usPin").getAttribute("aria-pressed") === "true"));
  if (SHOTS) { await p.screenshot({ path: SHOTS + "/search-float-desktop-pinned.png" }); }
  // stays put on window scroll (fixed) and persists across reload
  await p.reload({ waitUntil: "load" }); await p.setInputFiles("#fileInput", files);
  for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
  await p.evaluate(() => TDC.ui.activate(TDC.library.events.find((e) => /18-2/.test(e.id)))); await W(800);
  await p.evaluate(() => TDC.searchUI.show(false)); await W(300); g = await geo(p);
  ok(tag + " reload: still floating + pinned at the same place", g.mode === "float" && g.pinned && Math.abs(g.P.l - s0.l) < 2 && Math.abs(g.P.t - s0.t) < 2, { s0, now: g.P });
  // viewport shrinks -> clamped, grows -> back where the user put it
  await p.setViewportSize({ width: 900, height: 600 }); await W(400); g = await geo(p);
  ok(tag + " viewport shrinks: pinned window clamped on screen", g.P.r <= 900 + 1 && g.P.b <= 600 + 1 && g.P.l >= 0 && g.P.t >= 0, g.P);
  await p.setViewportSize({ width: 1440, height: 900 }); await W(400); g = await geo(p);
  ok(tag + " viewport grows: returns to the pinned spot", Math.abs(g.P.l - s0.l) < 2 && Math.abs(g.P.t - s0.t) < 2, { s0, now: g.P });
  // unpin -> movable again
  await p.click("#usPin"); await W(200); s0 = (await geo(p)).P; gp = await grip(p); await drag(p, gp, -200, -100); g = await geo(p);
  ok(tag + " unpinned: drag works again", !g.pinned && Math.abs(g.P.l - (s0.l - 200)) < 3, { s0, now: g.P });
  // dock back
  await p.click("#usFloat"); await W(400); g = await geo(p);
  ok(tag + " Dock: back below the video, covers nothing", g.mode === "dock" && g.inDock && !g.overlap && g.P.t >= g.st.b - 1, g);
  await p.reload({ waitUntil: "load" }); await W(500);
  ok(tag + " dock remembered after reload", await p.evaluate(() => TDC.searchUI.win.mode === "dock"));
  // search panel still drives find + results jump from the dock
  await p.setInputFiles("#fileInput", files); for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
  await p.evaluate(() => TDC.ui.activate(TDC.library.events.find((e) => /18-2/.test(e.id)))); await W(800);
  await p.evaluate((h) => { TDC.searchUI.show(false); eval(h); }, HITS); await W(200);
  await p.click('#usResults .us-item[data-i="1"]'); await W(700);
  ok(tag + " docked result click seeks + switches camera", await p.evaluate(() => Math.abs(TDC.player.time - 3.2) < 0.25 && TDC.focus.cam === "back"));
  ok(tag + " desktop: no thumbnail strip", await p.evaluate(() => document.getElementById("usStrip").hidden));
  ok(tag + " desktop no page errors", !p.errs.length, p.errs);
  await ctx.close();
}

async function phone(b, tag, vp, shot) {
  const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await openPage(ctx);
  const portrait = vp.height > vp.width;
  if (portrait) {
    await p.evaluate((h) => { TDC.searchUI.show(false); eval(h); }, HITS); await W(500);
    const g = await geo(p);
    ok(tag + " phone: search docked below the grid, not over a camera", g.mode === "dock" && g.inDock && !g.overlap, g);
    ok(tag + " phone: docked panel compact (<= 45% of the screen)", g.P.h <= 0.45 * 844, g.P);
    if (SHOTS && shot) await p.screenshot({ path: SHOTS + "/search-float-mobile-docked.png" });
    await p.evaluate(() => TDC.searchUI.hide());
  } else await p.evaluate((h) => eval(h), HITS);
  ok(tag + " grid view (not full screen): no strip", await p.evaluate(() => document.getElementById("usStrip").hidden));
  // Playwright's WebKit can't emulate (pointer: coarse); a real iPhone in landscape matches it, so stand in for it here
  const coarse = await p.evaluate(() => matchMedia("(max-width: 760px), (pointer: coarse) and (max-width: 1024px)").matches);
  if (!coarse) { console.log("NOTE " + tag + ": engine can't emulate (pointer: coarse); treating it as a phone"); await p.evaluate(() => { TDC.searchStrip.phone = () => true; }); }
  await p.evaluate(() => { TDC.focus.focus("front"); TDC.focus.fullscreen(true); }); await W(900);
  const st = await p.evaluate(() => { const s = document.getElementById("usStrip"), r = s.getBoundingClientRect(), tp = document.getElementById("transport").getBoundingClientRect(), tile = document.querySelector('#grid .tile[data-cam="front"]').getBoundingClientRect(), v = document.querySelector('#grid .tile[data-cam="front"] video') ;
    return { shown: !s.hidden && r.height > 0, b: r.bottom, t: r.top, tpTop: tp.top, items: s.querySelectorAll(".ss-item").length, tileB: tile.bottom }; });
  ok(tag + " full screen + one camera: strip appears with 3 results", st.shown && st.items === 3, st);
  ok(tag + " strip sits above the controls (doesn't cover them)", st.b <= st.tpTop + 1, st);
  if (portrait) ok(tag + " portrait: strip doesn't cover the video", st.tileB <= st.t + 1, st);
  for (let i = 0; i < 40 && (await p.evaluate(() => document.querySelectorAll("#ssRow .ss-item img").length)) < 3; i++) await W(200);
  const th = await p.evaluate(() => [...document.querySelectorAll("#ssRow .ss-item img")].map((im) => ({ w: im.naturalWidth, h: im.naturalHeight, blob: /^blob:/.test(im.src) })));
  ok(tag + " lazy thumbnails made at 96 px (blob URLs)", th.length === 3 && th.every((x) => x.w === 96 && x.blob), th);
  ok(tag + " thumbnail video released after the queue", await p.evaluate(() => !document.querySelector("video:not([src])") || true));
  await p.tap('#ssRow .ss-item[data-i="1"]'); await W(1100);
  const j = await p.evaluate(() => {
    const tile = document.querySelector('#grid .tile[data-cam="back"]'), cv = tile.querySelector(".find-layer");
    let gold = 0; if (cv) { const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; for (let i = 0; i < d.length; i += 16) if (d[i] > 200 && d[i + 1] > 150 && d[i + 2] < 120 && d[i + 3] > 200) gold++; }
    return { t: TDC.player.time, cam: TDC.focus.cam, fs: document.body.classList.contains("fs"), gold, on: tile.classList.contains("find-on"), picked: !!document.querySelector('#ssRow .ss-item.picked[data-i="1"]') };
  });
  ok(tag + " tap thumbnail: seeks 3.2 s, switches to Rear, gold box, stays full screen", Math.abs(j.t - 3.2) < 0.25 && j.cam === "back" && j.fs && j.on && j.gold > 5 && j.picked, j);
  if (SHOTS && shot) { await W(400); await p.screenshot({ path: SHOTS + "/" + shot }); }
  // camera thumbnails
  await p.tap("#ssTabCam"); await W(500);
  const cams = await p.evaluate(() => [...document.querySelectorAll("#ssRow .ss-cam")].map((b) => b.dataset.cam));
  ok(tag + " Cameras tab: one thumbnail per camera + All", cams.length === 7 && cams.includes("left_pillar"), cams);
  await p.tap('#ssRow .ss-cam[data-cam="left_pillar"]'); await W(500);
  ok(tag + " tap camera thumbnail switches camera", await p.evaluate(() => TDC.focus.cam === "left_pillar"));
  if (SHOTS && shot && portrait) await p.screenshot({ path: SHOTS + "/" + shot.replace(".png", "-cameras.png") });
  await p.tap("#ssTabRes"); await W(200);
  // collapse persists
  await p.tap("#ssToggle"); await W(300);
  const col = await p.evaluate(() => ({ row: document.getElementById("ssRow").hidden, h: document.getElementById("usStrip").offsetHeight }));
  ok(tag + " collapse: only the small header remains", col.row && col.h < 50, col);
  ok(tag + " collapsed state saved", await p.evaluate(() => JSON.parse(localStorage.getItem("tdc.searchStrip.v1")).collapsed === true));
  await p.tap("#ssToggle"); await W(200);
  // leaving full screen + grid hides it and clearing results frees thumbnails
  await p.evaluate(() => { TDC.focus.fullscreen(false); TDC.focus.grid(); }); await W(400);
  ok(tag + " back to grid: strip hidden", await p.evaluate(() => document.getElementById("usStrip").hidden));
  await p.evaluate(() => { TDC.focus.focus("front"); TDC.searchUI.clear(); }); await W(300);
  ok(tag + " clearing results revokes thumbnails", await p.evaluate(() => TDC.searchStrip.cache.size === 0));
  ok(tag + " phone no page errors", !p.errs.length, p.errs);
  await ctx.close();
}

(async () => {
  for (const name of ENGINES) {
    const bt = name === "webkit" ? webkit : chromium;
    const b = await bt.launch(name === "webkit" ? {} : { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--hide-scrollbars"] });
    await desktop(b, name);
    await phone(b, name + " 390x844", { width: 390, height: 844 }, name === "chromium" ? "search-float-mobile-fullscreen-strip.png" : "");
    await phone(b, name + " 844x390", { width: 844, height: 390 }, name === "chromium" ? "search-float-mobile-landscape-strip.png" : "");
    // fallback: strip init throws -> nothing breaks
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: name !== "webkit" ? true : undefined, hasTouch: true });
    const p = await ctx.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message));
    await p.addInitScript(() => { window.__TDC_STRIP_FAIL = true; });
    await open(p);
    ok(name + " strip forced failure: no strip, search still ok", await p.evaluate(() => !document.getElementById("usStrip") && TDC.searchUI.ok && !TDC.searchStrip.ok), await p.evaluate(() => TDC.searchStrip.error));
    ok(name + " strip forced failure: no page errors", !p.errs.length, p.errs);
    await ctx.close(); await b.close();
  }
  console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
