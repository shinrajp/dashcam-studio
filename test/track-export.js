// track-export (tag track-v2): tracked regions are burned into a REAL export (TDC.exporter.run → mp4, decoded back with ffmpeg).
//   1. a tracked Highlight CIRCLE (red) on the sign of the front camera: in the exported front video the red ring sits on the sign
//      (red pixels on the ellipse round where the sign is), the sign inside is not blurred (it matches the source), and once the sign
//      has left the picture no ring is drawn
//   2. a hand-off region on the right pillar (stubbed detector, "Is this it?" → Yes), Blur: in the exported right-pillar video the area
//      is blurred from the hand-off time on (detail gone compared with the source), and not before it
// Footage: /tmp/track-footage-ho (tools/make-track-footage.py --exit plus a right_pillar copy of the front video). Needs ffmpeg.
// Usage: node test/track-export.js [url]
const fs = require("fs"), path = require("path"), os = require("os"), { execFileSync } = require("child_process");
const URL0 = process.argv[2] || "http://127.0.0.1:8771/index.html";
const FIX = process.env.FIX || "/tmp/track-footage-ho";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x).slice(0, 500) : "")); if (!c) fails++; };
if (!fs.existsSync(FIX + "/track-truth.json")) execFileSync("python3", [path.join(__dirname, "../tools/make-track-footage.py"), FIX, "--exit"], { stdio: "inherit" });
const DIR = path.join(FIX, "TeslaCam/SavedClips", fs.readdirSync(path.join(FIX, "TeslaCam/SavedClips"))[0]);
const FRONT = path.join(DIR, fs.readdirSync(DIR).find((x) => x.endsWith("-front.mp4")));
if (!fs.existsSync(FRONT.replace("-front.mp4", "-right_pillar.mp4"))) fs.copyFileSync(FRONT, FRONT.replace("-front.mp4", "-right_pillar.mp4"));
const TRUTH = JSON.parse(fs.readFileSync(FIX + "/track-truth.json", "utf8"));
const truthAt = (t) => TRUTH.frames[Math.max(0, Math.min(TRUTH.frames.length - 1, Math.round(t * TRUTH.fps)))];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "track-export-"));

/** One RGB frame of a video at time t (seconds), as { w, h, px(x, y) → [r, g, b] }. */
function frame(file, t) {
  const [w, h] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]).toString().trim().split(",").map(Number);
  const buf = execFileSync("ffmpeg", ["-loglevel", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 << 20 });
  return { w, h, px: (x, y) => { x = Math.max(0, Math.min(w - 1, Math.round(x))); y = Math.max(0, Math.min(h - 1, Math.round(y))); const i = (y * w + x) * 3; return [buf[i], buf[i + 1], buf[i + 2]]; } };
}
/** Detail inside a box (0..1 of the picture): mean absolute difference between neighbouring pixels (a blur takes it away). */
function detail(F, b) {
  let s = 0, n = 0;
  for (let j = 0; j < 24; j++) for (let i = 0; i < 24; i++) {
    const x = (b.x + (i + 0.5) / 24 * b.w) * F.w, y = (b.y + (j + 0.5) / 24 * b.h) * F.h, a = F.px(x, y), c = F.px(x + 1, y), d = F.px(x, y + 1);
    s += Math.abs(a[0] - c[0]) + Math.abs(a[1] - c[1]) + Math.abs(a[0] - d[0]) + Math.abs(a[1] - d[1]); n++;
  }
  return s / n;
}

(async () => {
  const pw = require("playwright");
  const b = await pw.chromium.launch({ args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true }), p = await ctx.newPage(), errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(URL0 + (URL0.includes("?") ? "&" : "?") + "nosw=1", { waitUntil: "load" });
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); });
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => TDC.ui.activate(TDC.library.events[0])); await W(1500);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); TDC.setPref("layout", "current"); TDC.focus.focus("front"); TDC.player.seek(0); }); await W(900);
  await p.evaluate(() => {   // the detector, stubbed: a car near the left edge of the right pillar's picture (the hand-off finds it); nothing elsewhere
    const D = TDC.detect; D.enabled = () => true; D.loadFast = async () => null;
    D.detectImage = async (img, iw, ih, o) => (o && o.cam === "right_pillar" ? [{ x: 0.06, y: 0.42, w: 0.12, h: 0.1, label: "car", conf: 0.9 }] : []);
  });
  // 1. Track drawing, Circle, Highlight red, round the sign at t = 0
  const t0 = TRUTH.frames[0], pad = 0.015;
  await p.evaluate(() => { const U = TDC.regions.UI; U.setShape("circle"); U.setMode("mark"); U.setMark(null, "#ff3b30"); U.track(true); }); await W(300);
  const pts = await p.evaluate(([a, c, d, e]) => { const f = TDC.regions.screenFit("front"); return [TDC.regions.toScreen(f, a, c), TDC.regions.toScreen(f, d, e)]; }, [t0.x - pad, t0.y - pad, t0.x + t0.w + pad, t0.y + t0.h + pad]);
  await p.mouse.move(...pts[0]); await p.mouse.down(); await p.mouse.move(...pts[1], { steps: 8 }); await p.mouse.up(); await W(300);
  await p.evaluate(() => TDC.regions.UI.track(false));
  // 2. the hand-off question comes (the player goes to it); Yes, in Blur
  let asked = null;
  for (let i = 0; i < 150 && !asked; i++) { await W(200); asked = await p.evaluate(() => { const c = document.getElementById("crHo"); return c && !c.hidden ? TDC.player.time : null; }); }
  ok("the hand-off question came", asked != null, asked);
  if (asked != null) await p.evaluate(() => document.getElementById("crHoYes").click());
  await W(500);
  await p.evaluate(() => { const r = TDC.regions.list[1]; if (r) TDC.regions.update(r.id, { mode: "blur" }); });   // (the copy takes the first region's style; make it a blur for the check)
  await p.evaluate(() => Promise.all(TDC.regions.list.map((r) => TDC.regions.passDone(r.id))));
  const regs = await p.evaluate(() => TDC.regions.list.map((r) => ({ id: r.id, cam: r.cam, shape: r.shape, mode: r.mode, mc: r.mc, start: r.start, path: r.path })));
  ok("two tracked regions: a red Highlight circle on the front, a Blur on the right pillar from the hand-off", regs.length === 2 && regs[0].cam === "front" && regs[0].shape === "ellipse" && regs[0].mode === "mark" && regs[0].mc === "#ff3b30" && regs[1].cam === "right_pillar" && regs[1].mode === "blur" && regs[1].path && regs[1].start > 1.5, regs.map((r) => ({ cam: r.cam, shape: r.shape, mode: r.mode, start: r.start, keys: r.path && r.path.length / 5 })));
  // 3. real exports, one camera each (the whole picture is that camera)
  const RANGE = [0, 5];
  async function exportCam(cam) {
    const info = await p.evaluate(async ([cam, range]) => {
      const r = await TDC.exporter.run({ preset: "original", codec: "h264", sizeId: "native", cams: [cam], ranges: [range], onStatus: () => {}, onProgress: () => {}, show: { labels: false, fsd: false, time: false, boxes: false, hud: false, map: false, carview: false } });
      window.__blob = r.blob; return { W: r.W, H: r.H, fps: r.fps, name: r.name, layout: r.layout };
    }, [cam, RANGE]);
    const [dl] = await Promise.all([p.waitForEvent("download"), p.evaluate(() => { const a = document.createElement("a"); a.href = URL.createObjectURL(window.__blob); a.download = "x.mp4"; document.body.appendChild(a); a.click(); a.remove(); })]);
    const file = path.join(TMP, cam + ".mp4"); await dl.saveAs(file);
    return Object.assign(info, { file });
  }
  const ef = await exportCam("front"), er = await exportCam("right_pillar");
  ok("both exports made (" + ef.W + "×" + ef.H + ", " + er.W + "×" + er.H + ")", fs.statSync(ef.file).size > 10000 && fs.statSync(er.file).size > 10000, { ef, er });
  // where a region was at time t (its path), 0..1 of the picture
  const boxAt = (r, t) => { const P = r.path; let k = -1; for (let i = 0; i < P.length; i += 5) if (P[i] <= t + 1e-6) k = i; return k < 0 ? null : P[k + 3] > 0 ? { x: P[k + 1], y: P[k + 2], w: P[k + 3], h: P[k + 4] } : null; };
  // the export's picture is the camera's picture fitted into W × H (contain); a point 0..1 of the camera → pixel of the export
  const fit = (F, cw, ch) => { const s = Math.min(F.w / cw, F.h / ch), w = cw * s, h = ch * s; return { x: (F.w - w) / 2, y: (F.h - h) / 2, w, h }; };
  // 1. the red ring on the sign in the front export
  const ring = [], inside = [];
  for (const t of [0.5, 1.0, 1.4]) {
    const F = frame(ef.file, t - RANGE[0]), S = frame(FRONT, t), q = fit(F, 1280, 960), bx = boxAt(regs[0], t), T = truthAt(t);
    let red = 0, n = 0;
    for (let k = 0; k < 36; k++) {   // points on the ellipse of the region's box at t
      const a = k / 36 * 2 * Math.PI, u = bx.x + bx.w / 2 + Math.cos(a) * bx.w / 2, v = bx.y + bx.h / 2 + Math.sin(a) * bx.h / 2;
      const c = F.px(q.x + u * q.w, q.y + v * q.h); n++; if (c[0] > 170 && c[1] < 110 && c[2] < 110) red++;
    }
    ring.push(+(red / n).toFixed(2));
    const cx = T.x + T.w / 2, cy = T.y + T.h / 2, a = F.px(q.x + cx * q.w, q.y + cy * q.h), s = S.px(cx * 1280, cy * 960);
    inside.push(Math.abs(a[0] - s[0]) + Math.abs(a[1] - s[1]) + Math.abs(a[2] - s[2]));
    // and the ring is on the sign: the region's box centre is near the sign's
    if (Math.abs(bx.x + bx.w / 2 - cx) > 0.04) ring.push("off at " + t);
  }
  ok("front export: a red ring on the ellipse round the sign (>= 60 % of its points red at 0.5 / 1.0 / 1.4 s)", ring.every((r) => typeof r === "number" && r >= 0.6), ring);
  ok("front export: the sign inside the ring is not blurred (its centre matches the source)", inside.every((d) => d < 60), inside);
  {
    const t = 3.5, F = frame(ef.file, t - RANGE[0]), q = fit(F, 1280, 960);
    let red = 0, n = 0; for (let j = 0; j < 40; j++) for (let i = 0; i < 60; i++) { const c = F.px(q.x + (0.5 + i / 120) * q.w, q.y + (0.3 + j / 100) * q.h); n++; if (c[0] > 170 && c[1] < 110 && c[2] < 110) red++; }
    ok("front export: after the sign has left (3.5 s), no ring is drawn", red / n < 0.002, { red, n });
  }
  // 2. the right pillar export: blurred from the hand-off on, not before
  const r1 = regs[1], tA = r1.start;
  const after = [], before = [];
  for (const t of [tA + 0.4, tA + 1.0, Math.min(RANGE[1] - 0.2, tA + 1.8)]) {
    const F = frame(er.file, t - RANGE[0]), S = frame(FRONT.replace("-front.mp4", "-right_pillar.mp4"), t), q = fit(F, 1280, 960), bx = boxAt(r1, t);
    if (!bx) { after.push("no box at " + t.toFixed(1)); continue; }
    const inner = { x: bx.x + bx.w * 0.25, y: bx.y + bx.h * 0.25, w: bx.w * 0.5, h: bx.h * 0.5 };
    const dE = detail({ w: q.w, h: q.h, px: (x, y) => F.px(q.x + x, q.y + y) }, inner), dS = detail(S, inner);
    after.push(+(dE / Math.max(1, dS)).toFixed(2));
  }
  for (const t of [Math.max(0.3, tA - 1.2), Math.max(0.3, tA - 0.6)]) {
    const F = frame(er.file, t - RANGE[0]), S = frame(FRONT.replace("-front.mp4", "-right_pillar.mp4"), t), q = fit(F, 1280, 960), bx = boxAt(r1, tA + 0.1);
    const inner = { x: bx.x + bx.w * 0.25, y: bx.y + bx.h * 0.25, w: bx.w * 0.5, h: bx.h * 0.5 };
    const E = { w: q.w, h: q.h, px: (x, y) => F.px(q.x + x, q.y + y) }, dE = detail(E, inner), dS = detail(S, inner);
    // the same measure on a part of the picture no region touches: what the video encoder alone keeps of the detail
    const ctl = { x: inner.x, y: Math.min(0.9 - inner.h, inner.y + 0.3), w: inner.w, h: inner.h }, kept = detail(E, ctl) / Math.max(1, detail(S, ctl));
    before.push({ region: +(dE / Math.max(1, dS)).toFixed(2), untouched: +kept.toFixed(2) });
  }
  ok("right pillar export: blurred after the hand-off (detail <= 35 % of the source's)", after.every((x) => typeof x === "number" && x <= 0.35), { tA, after });
  ok("right pillar export: not blurred before the hand-off (as much detail kept there as in untouched parts)", before.every((x) => x.region >= 0.85 * x.untouched), { tA, before });
  ok("no page errors", !errs.length, errs);
  await b.close();
  console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
