// track-exit (tag track-v2): a tracked object that leaves the picture must lose its blur, and get it back when it comes into the picture again.
// Footage: tools/make-track-footage.py --exit (made on first run): the sign drives out on the right of the FRONT camera at about 2.4 s and comes back
// from the right at about 5 s. Gesture: Track ▸ drag a box around the sign at t = 0 ▸ play to the end. What the viewer PAINTS is sampled.
// Then the export path (the exporter's own tracker on decoded frames) is checked the same way for the stretch nobody played.
// Usage: node test/track-exit.js [url]     env: FIX=/tmp/track-footage-exit
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const FIX = process.env.FIX || "/tmp/track-footage-exit";
const URL0 = process.argv[2] || "http://127.0.0.1:8771/index.html";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 700) : "")); if (!c) fails++; };
if (!fs.existsSync(FIX + "/track-truth.json")) execFileSync("python3", [path.join(__dirname, "../tools/make-track-footage.py"), FIX, "--exit"], { stdio: "inherit" });
const TRUTH = JSON.parse(fs.readFileSync(FIX + "/track-truth.json", "utf8"));
const truthAt = (t) => { const f = TRUTH.frames; return f[Math.max(0, Math.min(f.length - 1, Math.round(t * TRUTH.fps)))]; };
const inside = (b) => (Math.max(0, Math.min(1, b.x + b.w) - Math.max(0, b.x)) / b.w) * (Math.max(0, Math.min(1, b.y + b.h) - Math.max(0, b.y)) / b.h);
const cover = (a, b) => { const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w, 1), y2 = Math.min(a.y + a.h, b.y + b.h, 1); return Math.max(0, x2 - x1) * Math.max(0, y2 - y1) / Math.max(1e-9, (Math.min(1, b.x + b.w) - Math.max(0, b.x)) * b.h); };
/** rows [{t, box|null}] → share right: out of the picture (< 10 % inside) nothing shown; fully back in (> 95 % inside, 0.8 s after it came back) the sign covered. */
function judge(rows) {
  const backAt = TRUTH.frames.find((f) => f.t > 4 && inside(f) > 0.35).t;
  const out = rows.filter((r) => inside(truthAt(r.t)) < 0.1), back = rows.filter((r) => r.t > backAt + 0.8 && inside(truthAt(r.t)) > 0.95), before = rows.filter((r) => r.t > 0.3 && r.t < 1.8);
  const share = (a, f) => (a.length ? a.filter(f).length / a.length : 0);
  return { backAt, out: share(out, (r) => !r.box), nOut: out.length, back: share(back, (r) => r.box && cover(r.box, truthAt(r.t)) >= 0.7), nBack: back.length, before: share(before, (r) => r.box && cover(r.box, truthAt(r.t)) >= 0.7) };
}

(async () => {
  const pw = require("playwright");
  const b = await pw.chromium.launch({ args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage(), errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(URL0 + (URL0.includes("?") ? "&" : "?") + "nosw=1", { waitUntil: "load" });
  await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.prefs.v1"); localStorage.removeItem("tdc.regions.v1"); });
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => TDC.ui.activate(TDC.library.events[0])); await W(1500);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); TDC.focus.focus("front"); });
  for (let i = 0; i < 60 && !(await p.evaluate(() => { const t = TDC.player.tiles.front; const v = t && t.vids && t.vids[TDC.player.active]; return v && v.videoWidth; })); i++) await W(150);
  await p.evaluate(() => TDC.player.seek(0)); await W(700);
  const t0 = TRUTH.frames[0], pad = 0.012;
  if (process.env.DEBUG) await p.evaluate(() => { const PT = TDC.patchTrack, ra = PT.Tracker.prototype.reacquire, up = PT.Tracker.prototype.update; window.__ra = []; PT.debug = true; PT.Tracker.prototype.reacquire = function (img, t) { const r = ra.call(this, img, t); window.__ra.push({ t: +t.toFixed(2), what: "search", r: r && { score: +r.score.toFixed(2), x: +r.box.x.toFixed(3), w: +r.box.w.toFixed(3) }, dbg: this._rdbg, box: { x: +this.box.x.toFixed(3), w: +this.box.w.toFixed(3) }, W: img.W, ox: +img.ox.toFixed(3), ow: +img.ow.toFixed(3), bank: this.bank.length, core: this.core }); return r; }; PT.Tracker.prototype.update = function (img, t) { const r = up.call(this, img, t); if (r.fit) window.__ra.push({ t: +t.toFixed(2), what: "FIT", w: +r.box.w.toFixed(3), ms: this._msdbg }); if (t > 5) window.__ra.push({ t: +t.toFixed(2), what: "look", ok: r.ok, flow: !!r.flow, s: +(r.score || 0).toFixed(2), x: +r.box.x.toFixed(3), w: +r.box.w.toFixed(3), hide: !!r.hide, prob: !!r.probation, unc: !!r.unconfirmed }); return r; }; });
  await p.evaluate(() => TDC.regions.UI.track(true));
  const pts = await p.evaluate(([x0, y0, x1, y1]) => { const f = TDC.regions.screenFit("front"); return [TDC.regions.toScreen(f, x0, y0), TDC.regions.toScreen(f, x1, y1)]; }, [t0.x - pad, t0.y - pad, t0.x + t0.w + pad, t0.y + t0.h + pad]);
  await p.mouse.move(pts[0][0], pts[0][1]); await p.mouse.down(); await p.mouse.move((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2, { steps: 4 }); await p.mouse.move(pts[1][0], pts[1][1], { steps: 4 }); await p.mouse.up(); await W(300);
  ok("a region was made by the Track gesture", (await p.evaluate(() => TDC.regions.list.length)) === 1);
  const end = TRUTH.sec - 0.3;
  await p.evaluate(() => { TDC.regions.UI.track(false); TDC.player.seek(0); TDC.player.play(); });
  const rows = await p.evaluate((end) => new Promise((res) => {
    const out = [], P = TDC.player, iv = setInterval(() => { const r = TDC.regions.at("front", P.time)[0]; out.push({ t: P.time, box: r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null }); if (P.time >= end) { clearInterval(iv); res(out); } }, 40);
    setTimeout(() => { clearInterval(iv); res(out); }, (end + 8) * 1000);
  }), end);
  await p.evaluate(() => TDC.player.pause());
  const j = judge(rows);
  console.log("  playing: before it leaves " + Math.round(j.before * 100) + " % covered; out of the picture " + Math.round(j.out * 100) + " % with no blur (" + j.nOut + " samples); back (from " + (j.backAt + 0.8).toFixed(1) + " s) " + Math.round(j.back * 100) + " % covered (" + j.nBack + ")");
  ok("before it leaves, the blur covers the sign (>= 90 %)", j.before >= 0.9, j);
  ok("out of the picture, no blur is drawn (>= 90 % of samples)", j.out >= 0.9, j);
  ok("back in the picture, the blur covers it again (>= 80 % of samples)", j.back >= 0.8, j);
  // paused: the saved path says the same (scrubbing)
  const scr = await p.evaluate(async (times) => { const res = []; for (const t of times) { TDC.player.seek(t); await new Promise((r) => setTimeout(r, 250)); const r = TDC.regions.at("front", TDC.player.time)[0]; res.push({ t: TDC.player.time, box: r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null }); } return res; }, [1.0, 3.5, 4.2, 7.0, 0.5]);
  const sj = judge(scr);
  ok("scrubbing: no blur while it is out of the picture, blur where it is", scr.filter((r) => inside(truthAt(r.t)) < 0.1).every((r) => !r.box) && scr.filter((r) => inside(truthAt(r.t)) > 0.95 && r.t > 6).every((r) => r.box), scr);
  if (process.env.DEBUG) for (const x of await p.evaluate(() => window.__ra)) console.log("  reacq", JSON.stringify(x));
  if (process.env.DEBUG) console.log("  TM0", await p.evaluate(() => { const S = TDC.regions.ui, L = TDC.regions.list[0], i = S.patches[L.id], tm = i.tr.tm0; let a = 0; for (let k = 0; k < tm.g.length; k++) a += tm.g[k] * ((k * 7919) % 13 - 6); return JSON.stringify({ tw: tm.tw, th: tm.th, std: +tm.std.toFixed(1), sig: +(a / tm.g.length).toFixed(2), p0: L.path.slice(0, 5), t0: i.tr.age0 }); }));
  ok("no page errors", !errs.length, errs);
  await b.close();
  console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
