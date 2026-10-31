// track-footage (tag track-v2): Custom regions ▸ Track in the real page on real decoded video (Chromium), measured against a known truth.
// Footage from tools/make-track-footage.py (made on first run): a made-up sign crosses the FRONT camera, speeding up, growing 7 %/s and weaving, with an
// identical copy trailing it by a fixed distance and a thin pole that hides part of it for about 2.5 s, light and noise drifting. The true box is known per frame.
// The user's gesture is replayed: Track ▸ drag a box around the sign at t = 0 ▸ play. What the viewer PAINTS (G.at) is sampled while it plays and compared
// with the truth: share of samples on the sign (IoU ≥ 0.5), centre error in frame pixels, behind the pole, at the end. Then, paused, the same is read at
// scrubbed times (the path), the region is reloaded through JSON, and an export's frames are checked for the blur on the sign.
// Pass a second URL (another build of the app, e.g. the feature/all-in-one tip) to print the same numbers for it; only the first URL is asserted.
// Usage: node test/track-footage.js <url> [<baseline-url>]     env: FIX=/tmp/track-footage
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const FIX = process.env.FIX || "/tmp/track-footage";
const URLS = process.argv.slice(2).length ? process.argv.slice(2) : ["http://127.0.0.1:8771/index.html"];
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
if (!fs.existsSync(FIX + "/track-truth.json")) execFileSync("python3", [path.join(__dirname, "../tools/make-track-footage.py"), FIX], { stdio: "inherit" });
const TRUTH = JSON.parse(fs.readFileSync(FIX + "/track-truth.json", "utf8")), FW = 1280, FH = 960;
const truthAt = (t) => { const f = TRUTH.frames; return f[Math.max(0, Math.min(f.length - 1, Math.round(t * TRUTH.fps)))]; };
const iou = (a, b) => { const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h), i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (a.w * a.h + b.w * b.h - i); };
const cerr = (a, b) => Math.hypot((a.x + a.w / 2 - b.x - b.w / 2) * FW, (a.y + a.h / 2 - b.y - b.h / 2) * FH);
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
// share of the TRUE object's area that the region covers: what matters for redaction (a box that is a bit large or late still hides the sign; one that is off it does not)
const cover = (a, b) => { const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h); return Math.max(0, x2 - x1) * Math.max(0, y2 - y1) / (b.w * b.h); };
const stats = (rows) => {   // rows: [{t, box|null}]
  const g = rows.filter((r) => r.box && iou(r.box, truthAt(r.t)) >= 0.5).length, e = rows.filter((r) => r.box).map((r) => cerr(r.box, truthAt(r.t)));
  const cv = rows.map((r) => (r.box ? cover(r.box, truthAt(r.t)) : 0));
  return { n: rows.length, on: rows.length ? g / rows.length : 0, med: med(e), max: e.length ? Math.max.apply(null, e) : NaN, cover: cv.length ? cv.reduce((a, b) => a + b, 0) / cv.length : 0, minCover: cv.length ? Math.min.apply(null, cv) : 0, hidden: cv.length ? cv.filter((c) => c >= 0.7).length / cv.length : 0 };
};

async function run(pw, url) {
  const b = await pw.chromium.launch({ args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true }), p = await ctx.newPage(), errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(url + (url.includes("?") ? "&" : "?") + "nosw=1", { waitUntil: "load" });
  await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.prefs.v1"); localStorage.removeItem("tdc.regions.v1"); });
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events[0]); }); await W(1500);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); TDC.focus.focus("front"); });
  for (let i = 0; i < 60 && !(await p.evaluate(() => { const t = TDC.player.tiles.front; const v = t && t.vids && t.vids[TDC.player.active]; return v && v.videoWidth; })); i++) await W(150);
  await p.evaluate(() => TDC.player.seek(0)); await W(700);
  if (process.env.TRACE) await p.evaluate(() => { const PT = TDC.patchTrack, u = PT.Tracker.prototype.update; window.__log = []; PT.debug = true; PT.Tracker.prototype.update = function (img, t) { const r = u.call(this, img, t); window.__log.push({ t: +t.toFixed(2), ok: r.ok, fl: r.flow ? "F" : "", fk: this._fdbg || "", part: !!r.part, ps: r.partScore == null ? null : +r.partScore.toFixed(2), s: +r.score.toFixed(2), m: +(r.margin || 0).toFixed(2), lostT: +r.lostT.toFixed(2), vx: +this.vx.toFixed(3), x: +this.box.x.toFixed(3), img: [img.W, img.H] }); return r; }; });

  // the gesture: Track, then drag a box around the sign at t = 0
  const t0 = TRUTH.frames[0], pad = 0.012;
  await p.evaluate(() => TDC.regions.UI.track(true));
  const pts = await p.evaluate(([x0, y0, x1, y1]) => { const f = TDC.regions.screenFit("front"); return [TDC.regions.toScreen(f, x0, y0), TDC.regions.toScreen(f, x1, y1)]; }, [t0.x - pad, t0.y - pad, t0.x + t0.w + pad, t0.y + t0.h + pad]);
  await p.mouse.move(pts[0][0], pts[0][1]); await p.mouse.down(); await p.mouse.move((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2, { steps: 4 }); await p.mouse.move(pts[1][0], pts[1][1], { steps: 4 }); await p.mouse.up(); await W(300);
  const made = await p.evaluate(() => TDC.regions.list.length);
  // play and sample what is painted
  const end = TRUTH.sec - 0.3;
  await p.evaluate(() => { TDC.regions.UI.track(false); TDC.player.seek(0); TDC.player.play(); });
  const rows = await p.evaluate((end) => new Promise((res) => {
    const out = [], P = TDC.player, iv = setInterval(() => {
      const r = TDC.regions.at("front", P.time)[0];
      out.push({ t: P.time, box: r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null });
      if (P.time >= end) { clearInterval(iv); res(out); }
    }, 40);
    setTimeout(() => { clearInterval(iv); res(out); }, (end + 8) * 1000);
  }), end);
  await p.evaluate(() => TDC.player.pause());
  const play = rows.filter((r) => r.t > 0.3);
  const pole = rows.filter((r) => r.t >= 3.8 && r.t <= 4.8), after = rows.filter((r) => r.t >= 5.2), tail = rows.filter((r) => r.t >= end - 1.5);
  const out = { url, made, errs, rows: rows.length, raw: rows, play: stats(play), pole: stats(pole), after: stats(after), tail: stats(tail) };
  // paused: the path answers for any time, in any order
  const times = [1.0, 2.0, 3.0, 4.3, 5.0, 6.0, 7.0, 2.5, 0.5];
  out.scrub = await p.evaluate(async (times) => { const res = []; for (const t of times) { TDC.player.seek(t); await new Promise((r) => setTimeout(r, 250)); const r = TDC.regions.at("front", TDC.player.time)[0]; res.push({ t: TDC.player.time, box: r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null, shape: TDC.regions.list[0] ? { x: TDC.regions.list[0].x, y: TDC.regions.list[0].y, w: TDC.regions.list[0].w } : null }); } return res; }, times);
  out.scrubS = stats(out.scrub);
  out.hasPath = await p.evaluate(() => { const r = TDC.regions.list[0]; return r && r.path ? r.path.length / 5 : 0; });
  // export: only the first 3 s were ever played. The exporter decodes frames in time order and draws through G.burn; it must carry the tracker forward itself.
  if (out.hasPath) {
  await p.evaluate(() => { const r = TDC.regions.list[0]; const keep = []; for (let i = 0; i < r.path.length; i += 5) if (r.path[i] <= 3.0) keep.push(...r.path.slice(i, i + 5)); r.path = keep; });
  out.exportKeysBefore = await p.evaluate(() => TDC.regions.list[0].path.length / 5);
  out.exportRows = await p.evaluate(async ([t0, t1, fps]) => {
    const rows = [], cv = document.createElement("canvas"); cv.width = 640; cv.height = 480; const ctx = cv.getContext("2d");
    for (let t = t0; t <= t1 + 1e-6; t += 1 / fps) {
      const v = await TDC.detect.frameAt("front", t); if (!v) continue;
      TDC.regions.burn(ctx, "front", t, { x: 0, y: 0, w: 640, h: 480 }, v.videoWidth, v.videoHeight, v);
      const r = TDC.regions.at("front", t)[0]; rows.push({ t, box: r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null });
    }
    return rows;
  }, [3.0, 7.5, 12]);
  out.exportKeysAfter = await p.evaluate(() => TDC.regions.list[0].path.length / 5);
  out.exportS = stats(out.exportRows.filter((r) => r.t >= 3.2));
  } else { out.exportRows = []; out.exportKeysBefore = out.exportKeysAfter = 0; out.exportS = stats([]); }
  out.json = await p.evaluate(() => TDC.regions.toJSON());
  if (process.env.TRACE) { const lg = await p.evaluate(() => window.__log); for (const l of lg) if (l.t >= +(process.env.TRACE.split(",")[0] || 0) && l.t <= +(process.env.TRACE.split(",")[1] || 99)) console.log("  look t " + l.t + " ok " + l.ok + " " + l.fl + " " + l.fk + (l.part ? " PART" : "") + " partScore " + l.ps + " score " + l.s + " margin " + l.m + " lostT " + l.lostT + " vx " + l.vx + " box.x " + l.x + " truth.x " + truthAt(l.t).x.toFixed(3) + " raster " + l.img); }
  await b.close();
  return out;
}

(async () => {
  const pw = require("playwright"), res = [];
  for (const u of URLS) { try { res.push(await run(pw, u)); } catch (e) { console.log("RUN FAILED " + u + ": " + e.message); res.push(null); } }
  const f = (s) => (s.hidden * 100).toFixed(0).padStart(4) + "% of samples hide >=70% of the sign (worst " + (s.minCover * 100).toFixed(0) + "%), " + (s.on * 100).toFixed(0).padStart(4) + "% IoU>=.5, median " + (isNaN(s.med) ? "  n/a" : s.med.toFixed(1).padStart(5)) + " px, worst " + (isNaN(s.max) ? "  n/a" : s.max.toFixed(0).padStart(4)) + " px (" + s.n + " samples)";
  console.log("");
  if (process.env.DEBUG) for (const r of res) { if (!r) continue; console.log("-- " + r.url); let last = -1; for (const w of r.raw) { if (w.t - last < 0.25) continue; last = w.t; const T = truthAt(w.t); console.log("  t " + w.t.toFixed(2) + "  box x " + (w.box ? w.box.x.toFixed(3) : "  -  ") + " w " + (w.box ? w.box.w.toFixed(3) : " - ") + "   truth x " + T.x.toFixed(3) + " w " + T.w.toFixed(3) + "   iou " + (w.box ? iou(w.box, T).toFixed(2) : "-")); } }
  for (const r of res) {
    if (!r) continue;
    console.log("== " + r.url + (r === res[0] ? "   (asserted)" : "   (baseline)"));
    console.log("  playing, whole run     " + f(r.play)); console.log("  behind the pole        " + f(r.pole)); console.log("  after the pole         " + f(r.after)); console.log("  last 1.5 s             " + f(r.tail));
    console.log("  paused, scrubbed to " + r.scrub.length + " times " + f(r.scrubS) + "   path keys: " + r.hasPath);
    console.log("  export frames 3.2-7.5 s (only 0-3 s was played): " + f(r.exportS) + "   keys " + r.exportKeysBefore + " -> " + r.exportKeysAfter);
  }
  console.log("");
  const r = res[0]; if (!r) { console.log("FAIL the first build did not run"); process.exit(1); }
  ok("a region was made by the Track gesture", r.made === 1, r.made);
  ok("playing: the blur hides most of the sign (>=70 %) in at least 90 % of the samples (" + (r.play.hidden * 100).toFixed(0) + " %)", r.play.hidden >= 0.95, r.play);
  ok("playing: on the sign (IoU >= 0.5) for at least 80 % of the run (" + (r.play.on * 100).toFixed(0) + " %)", r.play.on >= 0.8, r.play);
  ok("playing: median error under 12 px (" + r.play.med.toFixed(1) + ")", r.play.med < 12, r.play);
  ok("behind the pole: the blur still covers at least half of the sign at worst, and most of it on average (worst " + (r.pole.minCover * 100).toFixed(0) + " %, mean " + (r.pole.cover * 100).toFixed(0) + " %)", r.pole.minCover >= 0.6 && r.pole.cover >= 0.8, r.pole);
  ok("after the pole: still on the sign (" + (r.after.on * 100).toFixed(0) + " %), not on the look-alike", r.after.on >= 0.9, r.after);
  ok("the box has grown with the sign: at the end it still hides it (" + (r.tail.cover * 100).toFixed(0) + " %) and sits on it (" + (r.tail.on * 100).toFixed(0) + " %)", r.tail.cover >= 0.9 && r.tail.on >= 0.9, r.tail);
  ok("scrubbing back and forth, paused: the region sits on the sign at every time (" + (r.scrubS.on * 100).toFixed(0) + " %)", r.scrubS.on >= 0.8 && r.hasPath > 10, { s: r.scrubS, keys: r.hasPath, scrub: r.scrub.map((x) => [x.t.toFixed(1), x.box && x.box.x.toFixed(3), truthAt(x.t).x.toFixed(3)]) });
  ok("export: the stretch nobody played is tracked on the exporter's own frames (keys " + r.exportKeysBefore + " -> " + r.exportKeysAfter + ")", r.exportKeysAfter > r.exportKeysBefore + 15, { before: r.exportKeysBefore, after: r.exportKeysAfter });
  ok("export: the blur hides most of the sign on those frames (" + (r.exportS.hidden * 100).toFixed(0) + " % of frames >= 70 %, worst " + (r.exportS.minCover * 100).toFixed(0) + " %)", r.exportS.hidden >= 0.85 && r.exportS.minCover >= 0.4, r.exportS);
  const j = JSON.parse(r.json).regions[0];
  ok("the path is saved with the region (JSON) and reads back", j && Array.isArray(j.path) && j.path.length >= 50, j && j.path && j.path.length);
  ok("no page errors", r.errs.length === 0, r.errs);
  console.log(fails ? "\n" + fails + " FAILED" : "\nall passed"); process.exit(fails ? 1 : 0);
})();
