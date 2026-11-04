// Hand-off accuracy on real footage, scored against hand labels (test/fixtures/handoff-labels.json: 92 nearby vehicles leaving one camera
// on two real HW4 drives, and which track in the next camera is the same one). For each labelled exit on the drive given, the app's own
// hand-off (js/custom-redact.js chainSearch, with the real detector and the vehicle appearance model) runs from the moment it left, once
// with place / time first (as before, G.hoLookFirst = false) and once look-first (ho-look); its first found stretch is compared with the
// labelled track(s): right (overlaps the labelled one), wrong (another object), missed (nothing found where there is one), or right for
// "nothing found" when the object wasn't detected in the next camera.
// Usage: node test/handoff-look.js <url> <folder with the drive's six .mp4> <drive: 10-19 | 10-07> [--only old|new] [--n N]
//   env: PW = playwright(-core) package; CHANNEL = chrome by default; MODEL = small (default); OUT = write the per-case results (JSON);
//        FOOT = scale the road distances of box feet (js/rig.js footScale), e.g. 1.19; REFUSE = 1 turns on the refusal of poor looks
const fs = require("fs"), path = require("path");
const [URL_, DIR, DRIVE] = process.argv.slice(2);
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/handoff-labels.json"), "utf8"));
const cases = FX.cases.filter((c) => c.drive === DRIVE).slice(0, +(arg("--n") || 1e9));
const iou = (a, b) => { const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]), i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (a[2] * a[3] + b[2] * b[3] - i || 1); };
/** right / wrong / missed / unknown for one found stretch (keys [[t, {x,y,w,h}]]) against the labelled tracks ([[t,x,y,w,h]]) */
function judge(found, truth) {
  if (!found) return truth.length ? "missed" : "right";
  if (!truth.length) return "wrong";
  let common = 0, hit = 0;
  for (const tr of truth) for (const [t, b] of found) {
    let q = null, bd = 0.08; for (const k of tr) { const d = Math.abs(k[0] - t); if (d < bd) { bd = d; q = k; } }
    if (!q) continue; common++; if (iou([b.x, b.y, b.w, b.h], q.slice(1)) > 0.3) hit++;
  }
  if (!common) return "unknown";   // found something, but never at a moment the labelled track was seen: can't tell
  return hit / common >= 0.5 ? "right" : "wrong";
}

(async () => {
  const pw = require(process.env.PW || "playwright");
  const b = await pw.chromium.launch({ channel: process.env.CHANNEL || "chrome" });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage(), errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(URL_ + (URL_.includes("?") ? "&" : "?") + "nosw=1", { waitUntil: "load" });
  await p.evaluate((m) => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, model: m })); localStorage.removeItem("tdc.regions.v1"); }, process.env.MODEL || "small");
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", DIR);
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events[0]); }); await W(2000);
  await p.evaluate(async () => { TDC.player.pause(); await TDC.detect.load(); await TDC.detect.loadVehReid(); });
  if (process.env.FOOT) console.log("road distances ×" + (await p.evaluate((f) => TDC.rig.footScale(+f), process.env.FOOT)));
  console.log(`${DRIVE}: ${cases.length} labelled hand-offs; detector ${await p.evaluate(() => TDC.detect.backend)}, appearance model ${await p.evaluate(() => !!TDC.detect.vreidInfo())}`);

  const only = arg("--only"), modes = only ? [only] : ["old", "new"], res = { old: [], new: [] };
  for (const mode of modes) {
    const t0 = Date.now();
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const out = await p.evaluate(async ({ c, i, lookFirst, refuse }) => {
        const G = TDC.regions; G.hoLookFirst = lookFirst; G.hoRefuse = refuse;
        const K = c.exit, L = K[K.length - 1], P0 = K[Math.max(0, K.length - 6)], mid = (k) => k[1] + k[3] / 2;
        const side = L[1] < 0.03 || mid(L) < mid(P0) ? "left" : "right", e = TDC.handoff.entryFor(c.cam, side);
        if (!e || e.to !== c.to) return { skip: "the labelled exit goes " + (e && e.to) };
        // the object as a tracked mark: its path in the camera it leaves
        const id = "lab" + i + (lookFirst ? "n" : "o"), pathA = []; for (const k of K) pathA.push(k[0], k[1], k[2], k[3], k[4]);
        G.list.push({ id, cam: c.cam, path: pathA, label: "car", kind: "vehicle", t0: K[0][0], t1: L[0] });
        try {
          const h = await G.hoRun({ from: id, cam: c.cam, to: c.to, entry: e.entry, side, t0: L[0], kind: "vehicle", col: null });
          const sg = h.chain && h.chain.find((q) => q.cam === c.to);
          return { found: sg ? sg.keys.map(([t, b]) => [t, { x: b.x, y: b.y, w: b.w, h: b.h }]) : null, like: sg && sg.app };
        } finally { const j = G.list.findIndex((r) => r.id === id); if (j >= 0) G.list.splice(j, 1); TDC.regions.appOf && 0; }
      }, { c, i, lookFirst: mode === "new", refuse: !!process.env.REFUSE });
      const r = out.skip ? "skip" : judge(out.found, c.truth);
      res[mode].push({ i, cam: c.cam, to: c.to, r, like: out.like });
      process.stdout.write(r[0]);
    }
    const n = (k) => res[mode].filter((x) => x.r === k).length;
    console.log(`\n${mode === "old" ? "place and time first (before)" : "look first (ho-look)        "}: right ${n("right")}  wrong ${n("wrong")}  missed ${n("missed")}  unknown ${n("unknown")}  skipped ${n("skip")}  of ${cases.length}   (${((Date.now() - t0) / cases.length / 1000).toFixed(1)} s per hand-off)`);
  }
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(res));
  console.log(errs.length ? "page errors: " + errs.slice(0, 3).join(" | ") : "no page errors");
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
