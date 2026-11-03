// Rear camera unwarp in the page (js/rear-unwarp.js through js/detect.js) on a real six-camera HW4 event, with the real detector.
// For rear frames every 2 s: the detector on the recorded picture vs on the panorama (boxes mapped back). Checks the panorama is
// used, its boxes land on the recorded picture where the plain look finds the same things, it finds at least as many vehicles
// and scores them higher, the setting turns it off, and the cost per frame.
// Usage: node test/rear-unwarp-page.js <url> <folder with the event's six .mp4>
//   env: PW = path of a playwright(-core) package; CHANNEL = chrome by default; MODEL = small (default) | nano; STEP = 2 (s)
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const [URL_, DIR] = process.argv.slice(2);
let fails = 0, n = 0; const ok = (name, c, x) => { n++; console.log((c ? "PASS " : "FAIL ") + name + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 600) : "")); if (!c) fails++; };
const iou = (a, b) => { const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h), i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (a.w * a.h + b.w * b.h - i); };
const VEH = new Set(["car", "truck", "bus", "motorcycle", "bicycle", "person"]);

(async () => {
  const pw = require(process.env.PW || "playwright");
  const b = await pw.chromium.launch({ channel: process.env.CHANNEL || "chrome" });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage(), errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(URL_ + (URL_.includes("?") ? "&" : "?") + "nosw=1", { waitUntil: "load" });
  await p.evaluate((m) => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, model: m })); localStorage.removeItem("tdc.rearpano"); }, process.env.MODEL || "small");
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", DIR);
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events[0]); }); await W(2000);
  await p.evaluate(() => TDC.player.pause());
  ok("js/rear-unwarp.js is loaded and on by default", await p.evaluate(() => !!(TDC.rearUnwarp && TDC.rearUnwarp.on())));
  ok("the rear picture is one the panorama is for (HW4)", await p.evaluate(() => { const i = TDC.player.ev.clips[0].files.back.info; return TDC.rearUnwarp.usable(TDC.rig, i.width, i.height); }));
  await p.evaluate(() => TDC.detect.load());

  const step = +(process.env.STEP || 2);
  const rows = await p.evaluate(async (step) => {
    const D = TDC.detect, RU = TDC.rearUnwarp, dur = TDC.player.ev.duration, out = [];
    for (let t = 1; t < dur - 0.5; t += step) {
      const v = await D.frameAt("back", t); if (!v) continue;
      RU.setOn(false); const t0 = performance.now(); const plain = await D.detectImage(v, v.videoWidth, v.videoHeight, { cam: "back", conf: 0.3, noFix: true }); const msPlain = performance.now() - t0;
      RU.setOn(true); const t1 = performance.now(); const pano = await D.detectImage(v, v.videoWidth, v.videoHeight, { cam: "back", conf: 0.3, noFix: true }); const msPano = performance.now() - t1;
      out.push({ t, plain: plain.map((d) => ({ x: d.x, y: d.y, w: d.w, h: d.h, label: d.label, conf: d.conf })), pano: pano.map((d) => ({ x: d.x, y: d.y, w: d.w, h: d.h, label: d.label, conf: d.conf, unwarped: d.unwarped })), msPlain, msPano, unwarpMs: D.lastUnwarpMs });
    }
    return out;
  }, step);
  ok("rear frames looked at (" + rows.length + ")", rows.length >= 10, rows.length);
  const all = rows.flatMap((r) => r.pano);
  ok("every box from the panorama is marked unwarped and lies on the recorded picture", all.length > 0 && all.every((d) => d.unwarped && d.x >= 0 && d.y >= 0 && d.x + d.w <= 1.0001 && d.y + d.h <= 1.0001), all.slice(0, 3));

  // the same things: plain boxes matched to panorama boxes of the same kind
  let pairs = 0, onlyPlain = 0, onlyPano = 0, confPlain = 0, confPano = 0; const ious = [];
  for (const r of rows) {
    const P = r.plain.filter((d) => VEH.has(d.label)), Q = r.pano.filter((d) => VEH.has(d.label)), used = new Set();
    for (const a of P) {
      let best = -1, bi = 0; Q.forEach((q, i) => { if (used.has(i) || q.label !== a.label && !(a.label + q.label).match(/^(car|truck)(car|truck)$/)) return; const v = iou(a, q); if (v > bi) { bi = v; best = i; } });
      if (best >= 0 && bi > 0.3) { used.add(best); pairs++; ious.push(bi); confPlain += a.conf; confPano += Q[best].conf; } else onlyPlain++;
    }
    onlyPano += Q.length - used.size;
  }
  ious.sort((a, b) => a - b);
  const medIou = ious.length ? ious[ious.length >> 1] : 0;
  console.log(`  vehicles & people: ${pairs} found both ways (median overlap ${medIou.toFixed(2)}, mean score ${(confPlain / Math.max(1, pairs)).toFixed(2)} → ${(confPano / Math.max(1, pairs)).toFixed(2)}), ${onlyPano} only unwarped, ${onlyPlain} only as recorded`);
  ok("boxes mapped back sit on the same things the plain look finds (median overlap ≥ 0.5)", pairs >= 3 && medIou >= 0.5, { pairs, medIou });
  ok("the panorama finds at least as many vehicles and people", pairs + onlyPano >= pairs + onlyPlain, { onlyPano, onlyPlain });
  ok("things found both ways score at least as high unwarped (mean)", confPano >= confPlain - 0.02 * pairs, { confPlain, confPano });
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const mu = med(rows.map((r) => r.unwarpMs)), mp = med(rows.map((r) => r.msPlain)), mq = med(rows.map((r) => r.msPano));
  console.log(`  per frame: unwarp ${mu.toFixed(1)} ms; detector + unwarp ${mq.toFixed(0)} ms vs ${mp.toFixed(0)} ms plain`);
  ok("unwarping a frame costs under 40 ms", mu < 40, mu);

  // switched off in Settings: the plain picture again
  await p.evaluate(() => TDC.rearUnwarp.setOn(false));
  const off = await p.evaluate(async () => { const v = await TDC.detect.frameAt("back", 3); return (await TDC.detect.detectImage(v, v.videoWidth, v.videoHeight, { cam: "back", conf: 0.3, noFix: true })).some((d) => d.unwarped); });
  ok("turned off (tdc.rearpano = 0): the recorded picture is used", off === false);
  // other cameras never go through it
  await p.evaluate(() => TDC.rearUnwarp.setOn(true));
  const front = await p.evaluate(async () => { const v = await TDC.detect.frameAt("front", 3); return (await TDC.detect.detectImage(v, v.videoWidth, v.videoHeight, { cam: "front", conf: 0.3, noFix: true })).some((d) => d.unwarped); });
  ok("other cameras are not unwarped", front === false);
  // the Settings checkbox
  const box = await p.evaluate(() => { TDC.detect.renderSettings(); const c = document.getElementById("detRearPano"); if (!c) return null; c.checked = false; c.dispatchEvent(new Event("change")); const v = localStorage.getItem("tdc.rearpano"); c.checked = true; c.dispatchEvent(new Event("change")); return [v, localStorage.getItem("tdc.rearpano")]; });
  ok("Settings ▸ Object detection has the rear-camera checkbox, and it saves", box && box[0] === "0" && box[1] === "1", box);
  ok("no page errors", errs.length === 0, errs);
  if (process.env.OUT) require("fs").writeFileSync(process.env.OUT, JSON.stringify(rows));
  await b.close();
  console.log(fails ? `${fails} FAILED of ${n}` : `ALL PASS (${n})`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
