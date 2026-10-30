// pill-dock (ui-glass-7): pulling the camera pill down docks it. Reported on Mac Safari at ~820 px with the 6-camera view: dragging the pill
// down past the video floated it as the full labelled one-row strip, stuck over the Rear tile. Now (js/focus.js barDrag / bottomZone):
//   - releasing it on the lower part of the video (or where the pill would cover it) docks it below the video (beside, bottom);
//     a labelled dashed strip shows that spot while dragging, next to the old dock spot;
//   - a floating pill is always compact (icon-only, no 1-6 badges), never the full labelled strip;
//   - the drag uses no pointer capture and the release point decides (Mac Safari); double-click on the grip and the Dock button still dock.
//   Playwright, BR=chromium|webkit (default both), mock footage (/tmp/ho-mock). PORT (default 8819). ROOT=dir serves another checkout.
//   SHOTS=dir PREFIX=before-|after- writes pill-dock-<prefix><dev>-dragging.png and -released.png.
const fs = require("fs"), path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const ROOT = process.env.ROOT || path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", PORT = +(process.env.PORT || 8819), SHOTS = process.env.SHOTS || "", PREFIX = process.env.PREFIX || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".onnx": "application/octet-stream", ".wasm": "application/wasm" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html"; fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; r.end(); return; } r.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }).listen(PORT, "127.0.0.1", () => res(s)); });
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const shot = async (p, n) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, "pill-dock-" + PREFIX + n + ".png") }); } };
const R = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }, sel);
const X = (a, b) => !!a && !!b && a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
const ST = (p) => p.evaluate(() => { const b = document.getElementById("stageBar"), cb = TDC.prefs.cameraBar; return { dock: cb.dock, from: cb.from, float: cb.float, floating: b.classList.contains("bar-floating"), inStage: !!b.closest("#stage"), inBody: b.parentElement === document.body, cam: TDC.focus.cam || null, saved: (JSON.parse(localStorage.getItem("tdc.prefs.v1") || "{}").cameraBar || {}).dock }; });
const hasFloat = (p) => p.evaluate(() => typeof TDC.focus.floatBar === "function");
async function drag(p, from, to, peek) {
  await p.mouse.move(from[0], from[1]); await p.mouse.down(); const n = 14;
  for (let i = 1; i <= n; i++) { await p.mouse.move(from[0] + (to[0] - from[0]) * i / n, from[1] + (to[1] - from[1]) * i / n); await W(16); }
  await W(120); const got = peek ? await peek() : null; await p.mouse.up(); await W(400); return got;
}
async function open(p, keep) {
  await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1`, { waitUntil: "load" });
  if (!keep) { await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.prefs.v1"); localStorage.removeItem("tdc.regions.v1"); localStorage.removeItem("tdc.mbarOpen"); sessionStorage.clear(); }); await p.reload({ waitUntil: "load" }); }
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events.find((e) => e.cams.length === 6) || TDC.library.events[0]); }); await W(1800);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); TDC.setPref("autohide", "never"); document.getElementById("settings").hidden = true; TDC.player.seek(3); if (TDC.focus.dismissHint) TDC.focus.dismissHint(); }); await W(500);
}

const SHAPE = (p) => p.evaluate(() => { const b = document.getElementById("stageBar"), r = b.getBoundingClientRect(), vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden";
  return { h: Math.round(r.height), w: Math.round(r.width), compact: b.classList.contains("pill-compact"), kbd: [...b.querySelectorAll(".cam-chip kbd")].filter(vis).length, names: [...b.querySelectorAll(".cam-chip .nm")].filter(vis).length,
    labels: [...b.querySelectorAll("#btnCams span, #btnBoxes span, .bar-dock-btn span")].filter(vis).length }; });
const HINT = (p) => p.evaluate(() => { const h = document.querySelector(".cam-dock-hint.dock-bottom"); if (!h || h.hidden || !h.getClientRects().length) return null; const r = h.getBoundingClientRect(); return { t: r.top, b: r.bottom, near: h.classList.contains("near"), dragging: document.getElementById("stageBar").classList.contains("dragging") }; });
async function run(b, BR, dev) {
  const tag = BR + " " + dev.name;
  const ctx = await b.newContext({ viewport: { width: dev.w, height: dev.h } });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await open(p); await p.mouse.move(dev.w - 5, 5);
  const dockedShape = await SHAPE(p);
  // A: the reported case: docked below the video, pulled down past it and let go near the bottom
  await p.evaluate(() => TDC.focus.setBarDock("beside", "bottom")); await W(500);
  for (const [k, from] of [["A", "below the video"], ["B", "on the video (top)"]]) {
    if (k === "B") { await p.evaluate(() => { TDC.focus.setBarDock("over"); }); await W(500); }
    const g = await R(p, "#barGrip"), st = await R(p, "#stage");
    // (ui-glass-12: released below the bottom controls it floats by the window's bottom edge instead, see test/ui-glass-12.js; so let go just under the video)
    const mid = await drag(p, [g.cx, g.cy], [g.cx + 30, Math.min(dev.h - 6, k === "A" ? g.cy + 40 : st.b + 30)], async () => { const h = await HINT(p); const s = await SHAPE(p); if (k === "A") await shot(p, dev.name + "-dragging"); return { h, s }; });
    await p.mouse.move(dev.w - 5, 5); await W(300);
    const s = await ST(p), bar = await R(p, "#stageBar"), st2 = await R(p, "#stage"), side = await p.evaluate(() => TDC.prefs.cameraBar.side);
    if (k === "A") await shot(p, dev.name + "-released");
    ok(tag + " " + k + " docked " + from + ", pulled down past the video: the labelled bottom dock strip shows while dragging", !!mid.h && mid.h.dragging, mid);
    ok(tag + " " + k + " while dragging, the floating pill is compact (icon-only, no 1-6 badges)", mid.s.compact && mid.s.kbd === 0 && mid.s.names === 0, mid.s);
    ok(tag + " " + k + " released near the bottom: it docks below the video and covers none of it", s.dock === "beside" && side === "bottom" && !s.floating && !X(bar, st2), { s, side, bar, st2 });
  }
  // C: floating pill shape: compact, the same height as docked, never wider
  await p.evaluate(() => TDC.focus.setBarDock("over")); await W(400);
  const over = await SHAPE(p);
  await p.evaluate(() => TDC.focus.floatBar(true)); await W(400);
  const fl = await SHAPE(p);
  ok(tag + " C a floating pill stays compact: icon-only chips, no number badges, no tool labels, same height as docked, no wider", fl.compact && fl.kbd === 0 && fl.names === 0 && fl.labels === 0 && Math.abs(fl.h - over.h) <= 2 && fl.w <= over.w + 1, { fl, over, dockedShape });
  // D: released in the middle of the video it still floats (only the bottom docks)
  const st = await R(p, "#stage"), g = await R(p, "#barGrip"), bb = await R(p, "#stageBar");
  await drag(p, [g.cx, g.cy], [st.l + 10 + (g.cx - bb.l), st.t + st.h * 0.45]);   // left side, middle: away from the top dock spot and the bottom zone await p.mouse.move(dev.w - 5, 5); await W(300);
  const sD = await ST(p);
  ok(tag + " D released in the middle of the video it stays floating where it was dropped", sD.floating && sD.dock === "float", sD);
  // E: double-click on the grip docks; F: the Dock button docks
  const gE = await R(p, "#barGrip"); await p.mouse.dblclick(gE.cx, gE.cy); await W(500);
  const sE = await ST(p);
  ok(tag + " E a double-click on the grip docks the floating pill", !sE.floating && sE.dock === "over", sE);
  await p.evaluate(() => TDC.focus.floatBar(true)); await W(300);
  const dk = await R(p, "#btnBarDock"); await p.mouse.click(dk.cx, dk.cy); await W(500);
  const sF = await ST(p);
  ok(tag + " F the Dock button docks the floating pill", !sF.floating && sF.dock === "over", sF);
  ok(tag + " G no page errors", errs.length === 0, errs.slice(0, 3));
  await ctx.close();
}
(async () => {
  if (!fs.existsSync(FIX + "/TeslaCam")) execFileSync("python3", [path.join(ROOT, "tools/make-mock-footage.py"), FIX], { stdio: "inherit" });
  const srv = await server(); const pw = require("playwright");
  const DEVS = [{ name: "desktop-820x440", w: 820, h: 440, touch: 0 }, { name: "desktop-1440x900", w: 1440, h: 900, touch: 0 }];
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    let b;
    try { b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }); }
    catch (e) { console.log("SKIP " + BR + ": cannot launch (" + e.message.split("\n")[0] + ")"); continue; }
    for (const d of DEVS.filter((d) => !process.env.DEV || d.name.startsWith(process.env.DEV))) { try { await run(b, BR, d); } catch (e) { ok(BR + " " + d.name + " run threw: " + e.message.split("\n")[0], false); } }
    await b.close();
  }
  srv.close(); console.log(fails ? "FAILED " + fails : "ALL PASSED"); process.exit(fails ? 1 : 0);
})();
