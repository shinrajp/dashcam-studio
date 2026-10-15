// Camera bar dock: "On video" (default) vs "Beside video" (strip above/below the video, never over a camera).
// Desktop, desktop + map beside, phone portrait (tiles keep size), phone landscape; persistence; drag to switch side.
const puppeteer = require("puppeteer-core"); const fs = require("fs"), path = require("path");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.FIXTURES || "/workspace/photo-samples/TeslaCam";
const SHOTS = process.env.SHOTS || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) { if (!/2026-10-08_09-01-00/.test(q)) w(q); } else if (/\.(mp4|json)$/.test(f) && f !== "base.mp4") files.push(q); } })(FIX);
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x) : "")); if (!c) fails++; };
const geo = (p) => p.evaluate(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  const bar = document.getElementById("stageBar"), st = document.getElementById("stage");
  const tiles = [...document.querySelectorAll("#grid .tile")].filter((t) => !t.classList.contains("off")).map(r);
  const B = r(bar), S = r(st);
  const overlap = tiles.some((t) => B.l < t.r && B.r > t.l && B.t < t.b && B.b > t.t);
  return { bar: B, stage: S, tiles, overlap, inDock: bar.parentElement.id === "barDock", visible: !bar.hidden && B.h > 0, docked: TDC.focus.barDocked(), pref: TDC.prefs.cameraBar.dock, side: TDC.prefs.cameraBar.side };
});
async function load(b, vp) {
  const p = await b.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message)); await p.setViewport(vp);
  await p.goto(URL_, { waitUntil: "load" }); if (SHOTS) await p.addStyleTag({ content: ".toast{display:none!important}" });
  await (await p.$("#fileInput")).uploadFile(...files);
  for (let i = 0; i < 80 && (await p.evaluate(() => TDC.library.events.length)) < 3; i++) await W(250);
  await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); return TDC.ui.activate(TDC.library.events.find((e) => /18-2/.test(e.id))); });
  await W(1200); return p;
}
(async () => {
  const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--hide-scrollbars"], userDataDir: "/tmp/tdc-dock-" + Date.now() });
  const d = await load(b, { width: 1440, height: 900 });
  let g = await geo(d);
  ok("default: bar floats on the video", !g.docked && !g.inDock && g.pref === "over" && g.overlap);
  const stageH0 = g.stage.h;
  await d.click("#btnBarDock"); await W(400); g = await geo(d);
  ok("Beside video: bar in dock strip above, covers no camera", g.docked && g.inDock && g.visible && !g.overlap && g.bar.b <= g.stage.t + 1, g);
  ok("stage + strip fit in the viewport, tiles keep aspect", g.stage.h <= stageH0 && (await d.evaluate(() => { const v = document.getElementById("viewport").getBoundingClientRect(), s = document.getElementById("stage").getBoundingClientRect(), bb = document.getElementById("stageBar").getBoundingClientRect(); return Math.min(s.top, bb.top) >= v.top && Math.max(s.bottom, bb.bottom) <= v.bottom; })) && Math.abs(g.tiles[0].w / g.tiles[0].h - 724 / 470) < 0.05, { h0: stageH0, h: g.stage.h });
  ok("Settings checkbox reflects dock", await d.evaluate(() => document.getElementById("barAside").checked));
  if (SHOTS) { await d.evaluate(() => TDC.player.seek(4)); await W(800); await d.screenshot({ path: SHOTS + "/camera-bar-beside-desktop.png" }); }
  // camera switching + focus zoom still work from the docked bar
  await d.evaluate(() => document.querySelector('#camSwitch [data-cam="front"]').click()); await W(400);
  ok("docked bar switches camera", await d.evaluate(() => TDC.focus.cam === "front"));
  await d.click("#btnZoomIn"); await W(200);
  ok("docked bar zoom works in focus", await d.evaluate(() => document.getElementById("zoomLabel").textContent !== "1×"));
  g = await geo(d); ok("focused: still no overlap", !g.overlap && g.inDock);
  await d.evaluate(() => TDC.focus.grid()); await W(300);
  // drag the grip below the video -> bottom
  const gr = await d.$eval("#barGrip", (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await d.mouse.move(gr.x, gr.y); await d.mouse.down(); await d.mouse.move(gr.x, gr.y + 300, { steps: 6 }); await d.mouse.move(gr.x, 860, { steps: 6 }); await d.mouse.up(); await W(400);
  g = await geo(d); ok("drag grip down: dock moves below the video", g.side === "bottom" && g.bar.t >= g.stage.b - 1 && !g.overlap, g);
  // map beside + bar beside together
  await d.evaluate(() => { TDC.setPref("mapDock", "aside"); TDC.ui.fit(); }); await W(500); g = await geo(d);
  ok("with map beside too: bar still covers nothing", !g.overlap && g.inDock && g.bar.t >= g.stage.b - 1, g);
  await d.evaluate(() => { TDC.setPref("mapDock", "over"); TDC.ui.fit(); });
  // persistence
  await d.reload({ waitUntil: "load" }); await (await d.$("#fileInput")).uploadFile(...files);
  for (let i = 0; i < 80 && !(await d.evaluate(() => TDC.library.events.length)); i++) await W(250);
  await d.evaluate(() => TDC.ui.activate(TDC.library.events.find((e) => /18-2/.test(e.id)))); await W(1000);
  g = await geo(d); ok("remembered after reload (beside, below)", g.docked && g.side === "bottom" && !g.overlap, g);
  // hide/show bar while docked
  await d.evaluate(() => TDC.focus.setBar(false, true)); await W(300);
  ok("bar off: stage takes full height again", await d.evaluate(() => !TDC.focus.barDocked() && !document.body.classList.contains("bar-aside")));
  await d.evaluate(() => TDC.focus.setBar(true, true)); await W(300);
  await d.click("#btnBarDock"); await W(300); g = await geo(d);
  ok("back On video: floats again, full stage", !g.docked && !g.inDock && Math.abs(g.stage.h - stageH0) < 2, { h: g.stage.h, h0: stageH0 });
  ok("desktop no page errors", !d.errs.length, d.errs);
  // phones
  for (const vp of [{ name: "phone portrait", width: 393, height: 852 }, { name: "phone landscape", width: 852, height: 393 }]) {
    const p = await load(b, { width: vp.width, height: vp.height, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: vp.width > vp.height });
    const g0 = await geo(p);
    await p.evaluate(() => TDC.focus.setBarDock("beside", "top")); await W(500);
    const g1 = await geo(p);
    ok(vp.name + ": docked bar covers no camera", g1.docked && !g1.overlap && g1.bar.b <= g1.stage.t + 1, g1);
    if (vp.width < vp.height) ok(vp.name + ": tiles keep their size (not shrunk)", Math.abs(g1.tiles[0].w - g0.tiles[0].w) < 1, { before: g0.tiles[0].w, after: g1.tiles[0].w });
    else ok(vp.name + ": desktop arrangement kept (3 columns)", new Set(g1.tiles.map((t) => Math.round(t.l))).size === 3);
    if (SHOTS) { await p.evaluate(() => TDC.player.seek(4)); await W(800); await p.screenshot({ path: SHOTS + "/camera-bar-beside-" + vp.name.replace(" ", "-") + ".png" }); }
    await p.evaluate(() => TDC.focus.setBarDock("over")); ok(vp.name + " no page errors", !p.errs.length, p.errs); await p.close();
  }
  await b.close(); console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
