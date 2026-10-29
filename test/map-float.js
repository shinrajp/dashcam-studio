// map-float (tag map-float): the route map can float anywhere in the window by its ⋮⋮ grip, outside the video viewer, and snaps back to its dock.
//   Playwright, BR=chromium|webkit (default both), mock footage (tools/make-mock-footage.py -> /tmp/ho-mock). Serves the repo on PORT (default 8807).
//   Desktop 1280x800 (mouse + keyboard), phone 390x844 portrait and 844x390 landscape (touch; Chromium drives real touch events through CDP).
//   Checks: grip present; drag lifts the map out of the video area (rect outside #viewport) and it follows the pointer; the position survives a reload;
//   dragged into the bottom-right corner it stops above the bottom controls (no overlap with the transport bar, phone bar, Search / Redact buttons);
//   a smaller window / rotation clamps it back on screen; dropped near the dock spot (right edge of the video area) it docks (mapDock "aside");
//   keyboard Enter floats / docks, arrows move it; the on-video (export) map position and size in prefs never change; no page errors.
// Usage: BR=chromium|webkit node test/map-float.js    DEV=desktop|phone (default all)   SHOTS=dir writes mock-data screenshots
const fs = require("fs"), path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", PORT = +(process.env.PORT || 8807), SHOTS = process.env.SHOTS || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".onnx": "application/octet-stream", ".wasm": "application/wasm" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html"; fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; r.end(); return; } r.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }).listen(PORT, "127.0.0.1", () => res(s)); });
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

async function open(p, fresh) {
  await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1`, { waitUntil: "load" });
  if (fresh) { await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.prefs.v1"); localStorage.removeItem("tdc.regions.v1"); }); await p.reload({ waitUntil: "load" }); }
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events.find((e) => e.cams.length === 6) || TDC.library.events[0]); }); await W(1800);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); }); await W(300);
}
const G = (p) => p.evaluate(() => {
  const R = (e) => { if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden" ? { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height } : null; };
  const m = document.getElementById("panel-map"), g = document.getElementById("mapGrip");
  const bottom = ["transport", "mbBar", "usBtn", "rdBtn", "chipCamBar", "btnFullscreen", "toolBubble"].map((id) => [id, R(document.getElementById(id))]).filter((x) => x[1]);
  return { dock: TDC.prefs.mapDock, float: { ...TDC.prefs.mapFloat }, onVideo: { ...TDC.prefs.panels.map }, map: R(m), grip: R(g), vp: R(document.getElementById("viewport")), parent: m && m.parentElement && (m.parentElement.id || m.parentElement.tagName),
    vw: document.documentElement.clientWidth, vh: innerHeight, floor: TDC.overlays.floatFloor(), bottom, sx: scrollX, sy: scrollY };
});
const overlaps = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1;
const onScreen = (g) => g.map && g.map.l >= -0.5 && g.map.t >= -0.5 && g.map.r <= g.vw + 0.5 && g.map.b <= g.vh + 0.5;
const clearOfBottom = (g) => g.bottom.filter(([id, r]) => overlaps(g.map, r)).map(([id]) => id);
// ui-glass-6: a map you drag yourself may go down to the window bottom (and past it); it stays partly on screen and its grip stays above the bar
const ctlTop = (g) => Math.min(g.vh, ...g.bottom.filter(([id, r]) => (id === "transport" || id === "mbBar") && r.t > g.vh * 0.4).map(([, r]) => r.t));
const gripOk = (g) => !!g.grip && g.grip.l >= -0.5 && g.grip.t >= -0.5 && g.grip.r <= g.vw + 0.5 && g.grip.b <= ctlTop(g) + 0.5;
const partlyOn = (g) => !!g.map && g.map.l >= -0.5 && g.map.r <= g.vw + 0.5 && g.map.t >= -0.5 && g.map.t < g.vh - 30;

async function drag(p, ctx, touch, from, to, steps = 12) {
  if (!touch) { await p.mouse.move(from.x, from.y); await p.mouse.down(); for (let i = 1; i <= steps; i++) await p.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps); await W(60); await p.mouse.up(); await W(300); return true; }
  if (!ctx._cdp) { try { ctx._cdp = await ctx.newCDPSession(p); } catch (_) { return false; } }
  const c = ctx._cdp;
  await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= steps; i++) { await c.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }] }); await W(16); }
  await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await W(300); return true;
}
const gripC = (g) => ({ x: g.grip.l + g.grip.w / 2, y: g.grip.t + g.grip.h / 2 });
const shot = async (p, n) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, n + ".png") }); } };

async function run(b, BR, dev) {
  const touch = dev.touch, tag = BR + " " + dev.name;
  const ctx = await b.newContext({ viewport: { width: dev.w, height: dev.h }, isMobile: !!touch && BR === "chromium", hasTouch: !!touch, userAgent: touch ? UA : undefined, deviceScaleFactor: touch ? 2 : 1 });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await open(p, true);
  let g = await G(p); const onVideo0 = g.onVideo;
  ok(tag + " 1 map shown on the video by default with a ⋮⋮ grip", g.dock === "over" && !!g.map && !!g.grip, g);
  if (!touch) await shot(p, dev.name + "-1-on-video");
  // 2. drag it out of the video viewer
  const target = touch ? { x: 30, y: 40 } : { x: 40, y: 30 };
  const can = await drag(p, ctx, touch, gripC(g), target);
  if (!can) { ok(tag + " touch drag (skipped: no touch-move API in this browser)", true); }
  else {
    g = await G(p);
    const outside = g.map && g.vp && (g.map.t < g.vp.t - 4 || g.map.l < g.vp.l - 4 || g.map.r > g.vp.r + 4 || g.map.b > g.vp.b + 4);
    ok(tag + " 2 drag by the grip floats the map", g.dock === "float" && g.parent === "BODY", { dock: g.dock, parent: g.parent });
    ok(tag + " 2 it sits where it was dropped (grip near the pointer)", g.grip && Math.abs(gripC(g).x - target.x) < 40 && Math.abs(gripC(g).y - target.y) < 40, { grip: g.grip, target });
    if (!touch) ok(tag + " 2 desktop: the map is outside the video viewer (#viewport)", outside, { map: g.map, vp: g.vp });
    else ok(tag + " 2 phone: the map is on screen", onScreen(g), g.map);
    ok(tag + " 2 on-video (export) map position and size unchanged", JSON.stringify(g.onVideo) === JSON.stringify(onVideo0), [g.onVideo, onVideo0]);
    await shot(p, dev.name + "-2-floating");
    // 3. reload keeps it
    const before = g.map; await open(p, false); g = await G(p);
    ok(tag + " 3 after a reload: still floating at the same spot", g.dock === "float" && g.map && Math.abs(g.map.l - before.l) < 3 && Math.abs(g.map.t - before.t) < 3, { before, after: g.map, dock: g.dock });
    // 4. into the bottom-right corner: ui-glass-6 (iPhone feedback) it goes past the button row towards the window bottom, grip kept above the bar
    await drag(p, ctx, touch, gripC(g), { x: g.vw - 5, y: g.vh - 5 });
    g = await G(p);
    ok(tag + " 4 dragged into the bottom-right corner: further down than the old floor (no hard stop above the buttons)", g.map && g.map.b > g.floor + 20, { map: g.map, floor: g.floor });
    ok(tag + " 4 ... partly on screen, the grip on screen and above the bottom bar", partlyOn(g) && gripOk(g), { map: g.map, grip: g.grip, ctl: ctlTop(g) });
    ok(tag + " 4 ... the spot is kept (pinned, below the floor)", g.float && g.float.pin === 1 && g.float.below > 0, g.float);
    { const b4 = g.map; await open(p, false); g = await G(p);
      ok(tag + " 4 ... and after a reload it is still down there", g.map && Math.abs(g.map.t - b4.t) < 3 && gripOk(g), { before: b4, after: g.map }); }
    ok(tag + " 4 page does not scroll", g.sx === 0 && (touch || g.sy === 0), { sx: g.sx, sy: g.sy });
    if (touch) await shot(p, dev.name + "-4-floating-corner");
    // 5. smaller window / rotation clamps it back
    const sz = touch ? { width: dev.h, height: dev.w } : { width: 900, height: 600 };
    await p.setViewportSize(sz); await W(700); g = await G(p);
    ok(tag + " 5 window " + sz.width + "x" + sz.height + ": map clamped: partly on screen, grip reachable above the bottom bar", partlyOn(g) && gripOk(g), { map: g.map, grip: g.grip, ctl: ctlTop(g), vw: g.vw, vh: g.vh });
    if (touch) await shot(p, dev.name + "-5-rotated");
    await p.setViewportSize({ width: dev.w, height: dev.h }); await W(700); g = await G(p);
    ok(tag + " 5 back to " + dev.w + "x" + dev.h + ": still partly on screen, grip reachable", partlyOn(g) && gripOk(g), { map: g.map, grip: g.grip });
    // automatic placement (not pinned, default fy) still keeps the whole map above the bottom controls
    await p.evaluate(() => { TDC.prefs.mapFloat = { fx: 1, fy: 1 }; TDC.savePrefs(); TDC.overlays.invalidate && TDC.overlays.invalidate(); dispatchEvent(new Event("resize")); }); await W(600); g = await G(p);
    ok(tag + " 5 not pinned (fy 1): whole map on screen and above the bottom controls", onScreen(g) && clearOfBottom(g).length === 0, { map: g.map, hit: clearOfBottom(g) });
    // 6. drop near the dock spot -> docked
    const dockAt = { x: g.vp.r - 30, y: g.vp.t + g.vp.h / 2 };
    await drag(p, ctx, touch, gripC(g), dockAt); g = await G(p);
    ok(tag + " 6 dropped at the right edge of the video: docks beside it", g.dock === "aside" && g.parent === "mapDock", { dock: g.dock, parent: g.parent });
    if (!touch) await shot(p, dev.name + "-6-docked");
    ok(tag + " 6 on-video (export) map unchanged after float + dock", JSON.stringify(g.onVideo) === JSON.stringify(onVideo0), [g.onVideo, onVideo0]);
  }
  // 7. keyboard
  if (!touch) {
    await p.focus("#mapGrip"); await p.keyboard.press("Enter"); await W(400); g = await G(p);
    ok(tag + " 7 keyboard: Enter on the grip floats the map", g.dock === "float", g.dock);
    const l0 = g.map.l; await p.focus("#mapGrip"); await p.keyboard.press("ArrowLeft"); await W(200); g = await G(p);
    ok(tag + " 7 keyboard: ArrowLeft moves it 16 px", Math.abs(g.map.l - (l0 - 16)) < 2, [l0, g.map.l]);
    await p.keyboard.press("Shift+ArrowDown"); await W(200);
    await p.focus("#mapGrip"); await p.keyboard.press("Enter"); await W(400); g = await G(p);
    ok(tag + " 7 keyboard: Enter again docks it", g.dock === "aside", g.dock);
    // the Dock / On video button and Settings checkbox still work
    await p.evaluate(() => { TDC.overlays.setMapHome("float", true); }); await W(300);
    await p.evaluate(() => document.querySelector("#panel-map .map-move").click()); await W(400); g = await G(p);
    ok(tag + " 7 the map's Dock button docks a floating map", g.dock === "aside", g.dock);
  }
  ok(tag + " no page errors", errs.length === 0, errs.slice(0, 3));
  await ctx.close();
}
(async () => {
  if (!fs.existsSync(FIX + "/TeslaCam")) execFileSync("python3", [path.join(ROOT, "tools/make-mock-footage.py"), FIX], { stdio: "inherit" });
  const srv = await server(); const pw = require("playwright");
  const DEVS = [{ name: "desktop-1280x800", w: 1280, h: 800, touch: 0 }, { name: "phone-390x844", w: 390, h: 844, touch: 1 }, { name: "phone-844x390", w: 844, h: 390, touch: 1 }];
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    let b;
    try { b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }); }
    catch (e) { console.log("SKIP " + BR + ": cannot launch (" + e.message.split("\n")[0] + ")"); continue; }
    for (const d of DEVS.filter((d) => !process.env.DEV || d.name.startsWith(process.env.DEV))) { try { await run(b, BR, d); } catch (e) { ok(BR + " " + d.name + " run threw: " + e.message.split("\n")[0], false); } }
    await b.close();
  }
  srv.close(); console.log(fails ? "FAILED " + fails : "ALL PASSED"); process.exit(fails ? 1 : 0);
})();
