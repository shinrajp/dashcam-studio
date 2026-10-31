const pw = require("playwright"); const fs = require("fs");
const FIX = process.env.FIX || "/tmp/track-footage", TR = JSON.parse(fs.readFileSync(FIX + "/track-truth.json")), t0 = TR.frames[0];
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const ORDER = process.env.ORDER || "track-first";   // track-first: Freehand, Track, draw, Done | draw-first: Freehand, draw, Track, Done
(async () => {
  const b = await pw.chromium.launch({ args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage(), errs = [];
  p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
  await p.goto((process.argv[2] || "http://127.0.0.1:8771/index.html?nosw=1"), { waitUntil: "load" });
  await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.prefs.v1"); localStorage.removeItem("tdc.regions.v1"); });
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => TDC.ui.activate(TDC.library.events[0])); await W(1500);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); TDC.setPref("layout", "current"); TDC.focus.focus("front"); });
  await W(1200); for (let i = 0; i < 60 && !(await p.evaluate(() => { const t = TDC.player.tiles.front; const v = t && t.vids && t.vids[TDC.player.active]; return v && v.videoWidth; })); i++) await W(150); await p.evaluate(() => TDC.player.seek(0)); await W(700);
  const U = "TDC.regions.UI";
  await p.evaluate(`${U}.draw && ${U}.draw(true)`); await W(600); await p.mouse.click(640, 234); await W(1200); 
  await p.evaluate(`${U}.setShape("${ORDER === "rect" ? "rect" : "free"}")`);
  if (ORDER === "track-first" || ORDER === "rect") await p.evaluate(`${U}.track(true)`);
  await W(1500);
  // outline the sign (an ellipse of points) with taps; then tap the start to close
  const cx = t0.x + t0.w / 2, cy = t0.y + t0.h / 2, rx = t0.w * 0.62, ry = t0.h * 0.75, N = 10;
  const pts = await p.evaluate(([cx, cy, rx, ry, N]) => { const vs = [...document.querySelectorAll("video")].filter((v) => v.getBoundingClientRect().width > 300).sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width); const R = { x: 208, y: 68, width: 864, height: 648 }; window.__R = [R.x, R.y, R.width, R.height]; const o = []; for (let i = 0; i < N; i++) { const a = i / N * 2 * Math.PI; o.push([R.x + (cx + rx * Math.cos(a)) * R.width, R.y + (cy + ry * Math.sin(a)) * R.height]); } return o; }, [cx, cy, rx, ry, N]);
  for (const [x, y] of pts) { await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.up(); await W(120); }
  if (ORDER !== "rect") { await p.mouse.move(pts[0][0], pts[0][1]); await p.mouse.down(); await p.mouse.up(); } await W(400);
  if (ORDER !== "track-first") { await p.evaluate(`${U}.track(true)`); await W(300); }
  const before = await p.evaluate(() => ({ n: TDC.regions.list.length, hasDraft: !!(TDC.regions.ui && TDC.regions.ui.draft) }));
  await p.evaluate(`${U}.done()`); await W(500);
  const after = await p.evaluate(() => ({ n: TDC.regions.list.length, path: TDC.regions.list[0] && TDC.regions.list[0].path ? TDC.regions.list[0].path.length / 5 : 0, r: TDC.regions.list[0] && { x: TDC.regions.list[0].x, w: TDC.regions.list[0].w } }));
  await p.evaluate(() => { TDC.player.seek(0); TDC.player.play(); }); await W(4500);
  const end = await p.evaluate(() => { const L = TDC.regions.list[0], pa = L.path; const r = TDC.regions.at("front", TDC.player.time)[0] || (pa && { x: pa[pa.length-4] }); return { t: TDC.player.time, x: r && r.x, path: TDC.regions.list[0] && TDC.regions.list[0].path ? TDC.regions.list[0].path.length / 5 : 0 }; });
  const tr = TR.frames[Math.round(end.t * TR.fps)];
  const ok = !!(after.n === 1 && after.path >= 1 && end.x != null && tr && end.x > t0.x + 0.15 && Math.abs(end.x - tr.x) < 0.08 && !errs.length);
  console.log((ok ? "PASS" : "FAIL") + " freehand " + ORDER + ": the outlined region follows the sign (x " + (end.x && end.x.toFixed(3)) + " vs " + (tr && tr.x.toFixed(3)) + ")" + (errs.length ? " errors: " + errs.join(";") : ""));
  await b.close(); process.exit(ok ? 0 : 1);
})();
