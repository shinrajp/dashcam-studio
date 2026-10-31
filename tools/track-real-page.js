/* track-real-page.js — Custom regions ▸ Track on a real clip in the real page (Chromium): drag a box at t0, play, and sample what the viewer
 * paints (G.at) about every 0.1 s. Writes the same JSON as tools/track-real.js, so tools/track-real-score.py can score it against YOLO
 * reference boxes (tools/yolo-truth.js). env DET=1 turns Object detection on (the detector assist).
 * Usage: node tools/track-real-page.js <TeslaCam dir> <cam> <x,y,w,h> <t0> <t1> <out.json> [url] */
const pw = require("playwright"), fs = require("fs");
const [dir, cam, boxS, t0S, t1S, out, url0] = process.argv.slice(2);
const URL0 = url0 || "http://127.0.0.1:8771/index.html";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await pw.chromium.launch({ args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage(), errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(URL0 + "?nosw=1", { waitUntil: "load" });
  await p.evaluate((det) => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: det, model: "nano", live: false })); localStorage.removeItem("tdc.regions.v1"); localStorage.removeItem("tdc.prefs.v1"); }, !!process.env.DET);
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", dir);
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => TDC.ui.activate(TDC.library.events[0])); await W(1500);
  await p.evaluate((cam) => { TDC.player.pause(); TDC.setPref("mapTiles", false); TDC.setPref("layout", "current"); TDC.focus.focus(cam); }, cam);
  for (let i = 0; i < 60 && !(await p.evaluate((cam) => { const t = TDC.player.tiles[cam]; const v = t && t.vids && t.vids[TDC.player.active]; return v && v.videoWidth; }, cam)); i++) await W(150);
  if (process.env.DET) { await p.evaluate(() => TDC.detect.loadFast()); }
  const t0 = +t0S, t1 = +t1S, [x, y, w, h] = boxS.split(",").map(Number);
  await p.evaluate((t0) => TDC.player.seek(t0), t0); await W(900);
  if (process.env.DEBUG) await p.evaluate(() => { const PT = TDC.patchTrack, as = PT.Tracker.prototype.assist, up = PT.Tracker.prototype.update; window.__lg = []; PT.debug = true; PT.Tracker.prototype.assist = function (dets, td, boxAt, weak) { const r = as.call(this, dets, td, boxAt, weak); window.__lg.push({ k: "A", td: +td.toFixed(2), now: +TDC.player.time.toFixed(2), n: dets.length, weak, at: +(boxAt.x + boxAt.w / 2).toFixed(3), r: r && +(r.x + r.w / 2).toFixed(3), dbg: this._adbg }); return r; }; PT.Tracker.prototype.update = function (img, t) { const r = up.call(this, img, t); window.__lg.push({ k: "U", t: +t.toFixed(2), ok: r.ok, s: +(r.score || 0).toFixed(2), x: +(r.box.x + r.box.w / 2).toFixed(3) }); return r; }; });
  if (process.env.MARK) await p.evaluate((mk) => { TDC.regions.UI.setMode("mark"); TDC.regions.UI.setMark(mk, "#ffd400"); }, process.env.MARK);
  await p.evaluate(() => TDC.regions.UI.track(true));
  const pts = await p.evaluate(([cam, x0, y0, x1, y1]) => { const f = TDC.regions.screenFit(cam); return [TDC.regions.toScreen(f, x0, y0), TDC.regions.toScreen(f, x1, y1)]; }, [cam, x, y, x + w, y + h]);
  await p.mouse.move(pts[0][0], pts[0][1]); await p.mouse.down(); await p.mouse.move((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2, { steps: 4 }); await p.mouse.move(pts[1][0], pts[1][1], { steps: 4 }); await p.mouse.up(); await W(300);
  const made = await p.evaluate(() => TDC.regions.list.length);
  await p.evaluate(() => { TDC.regions.UI.track(false); TDC.player.play(); });
  const rows = await p.evaluate(([cam, t1]) => new Promise((res) => {
    const out = [], P = TDC.player, iv = setInterval(() => { const r = TDC.regions.at(cam, P.time)[0]; out.push({ t: P.time, box: r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null }); if (P.time >= t1) { clearInterval(iv); res(out); } }, 40);
    setTimeout(() => { clearInterval(iv); res(out); }, (t1 + 20) * 1000);
  }), [cam, t1]);
  await p.evaluate(() => TDC.player.pause());
  if (process.env.DEBUG) fs.writeFileSync(out + ".log.json", JSON.stringify(await p.evaluate(() => window.__lg)));
  // to the 0.1 s grid (the sample nearest each step)
  const grid = [];
  for (let t = Math.ceil(t0 * 10) / 10; t <= t1 + 1e-6; t += 0.1) { let bst = null, bd = 0.06; for (const r of rows) { const d = Math.abs(r.t - t); if (d < bd) { bd = d; bst = r; } } if (bst) grid.push({ t: +t.toFixed(1), box: bst.box, state: bst.box ? "shown" : "none" }); }
  fs.writeFileSync(out, JSON.stringify({ clip: dir, FW: 1448, FH: 938, rows: grid }));
  console.log("region made: " + made + " · samples " + grid.length + " · shown " + grid.filter((r) => r.box).length + (errs.length ? " · page errors: " + errs.join("; ") : "") + " → " + out);
  await b.close();
})();
