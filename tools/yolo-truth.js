/* yolo-truth.js — reference boxes for an object in a real clip, from the app's own YOLO detector (run in the page, Chromium), to measure the
 * region tracker against (tools/track-real.js). Starting from a box at t0, each 0.1 s the detection of the same class that best continues the
 * chain (overlap with the last box, then distance) is kept; a gap of more than 0.5 s ends the chain.
 * Usage: node tools/yolo-truth.js <TeslaCam dir> <cam> <x,y,w,h at t0> <t0> <t1> <out.json> [url]     (serve the app on the url first) */
const pw = require("playwright"), fs = require("fs");
const [dir, cam, boxS, t0S, t1S, out, url0] = process.argv.slice(2);
const URL0 = url0 || "http://127.0.0.1:8771/index.html";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await pw.chromium.launch({ args: ["--no-sandbox"] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  p.on("pageerror", (e) => console.error("pageerror", e.message));
  await p.goto(URL0 + "?nosw=1", { waitUntil: "load" });
  await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, model: "nano", live: false })); localStorage.removeItem("tdc.regions.v1"); });
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", dir);
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => TDC.ui.activate(TDC.library.events[0])); await W(1500);
  await p.evaluate((cam) => { TDC.player.pause(); TDC.focus.focus(cam); }, cam); await W(1000);
  await p.evaluate(() => TDC.detect.load("nano"));
  const [bx, by, bw, bh] = boxS.split(",").map(Number);
  const rows = await p.evaluate(async ([cam, t0, t1, box]) => {
    const tile = TDC.player.tiles[cam], v = (tile.vids && tile.vids[TDC.player.active] && tile.vids[TDC.player.active].videoWidth) ? tile.vids[TDC.player.active] : tile.video;
    const iou = (a, b) => { const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h), i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (a.w * a.h + b.w * b.h - i); };
    const out = [], all = []; let last = box, lastT = t0, label = null, ended = false;
    for (let t = t0; t <= t1 + 1e-6; t += 0.1) {
      TDC.player.seek(t); await new Promise((r) => setTimeout(r, 30));
      await new Promise((r) => { const go = () => (v.seeking ? setTimeout(go, 20) : r()); go(); });
      const dets = (await TDC.detect.detectImage(v, v.videoWidth, v.videoHeight, { conf: 0.25, noFix: true })).filter((d) => d.conf >= 0.25);
      const same = dets.filter((d) => !label || d.label === label || (["car", "truck", "bus"].includes(d.label) && ["car", "truck", "bus"].includes(label)));
      let best = null, bs = 0;
      for (const d of same) { const o = iou(d, last), dc = Math.hypot(d.x + d.w / 2 - last.x - last.w / 2, d.y + d.h / 2 - last.y - last.h / 2) / Math.max(last.w, last.h); const s = o + Math.max(0, 0.6 - dc) * 0.5; if (s > bs && (o > 0.15 || dc < 0.8)) { bs = s; best = d; } }
      all.push({ t: +t.toFixed(2), dets: dets.map((d) => ({ x: +d.x.toFixed(4), y: +d.y.toFixed(4), w: +d.w.toFixed(4), h: +d.h.toFixed(4), label: d.label, conf: +d.conf.toFixed(2) })) });
      if (best && !ended) { if (!label) label = best.label; last = { x: best.x, y: best.y, w: best.w, h: best.h }; lastT = t; out.push({ t: +t.toFixed(2), box: last, conf: +best.conf.toFixed(2), label: best.label }); }
      else if (!ended) { out.push({ t: +t.toFixed(2), box: null }); if (t - lastT > 0.5) ended = true; }
    }
    return { out, all };
  }, [cam, +t0S, +t1S, { x: bx, y: by, w: bw, h: bh }]);
  fs.writeFileSync(out, JSON.stringify({ cam, rows: rows.out, dets: rows.all }));
  console.log("truth rows " + rows.out.length + ", with a box " + rows.out.filter((r) => r.box).length + ", detections for " + rows.all.length + " frames → " + out);
  await b.close();
})();
