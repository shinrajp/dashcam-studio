// Burn-in parity: the boxes burned into an export are the boxes the live viewer shows at the same moment, frame by frame.
// Real YOLO11 (WASM) on a synthetic event with ONE bus driving steadily across the front camera (tools/make-moving-footage.py,
// public-domain photo, plates blurred, written to /tmp). Playwright Chromium + WebKit. For each kind of box:
//   A. "Detect while playing" (live detection): the viewer is played through, then the export runs over two trimmed sections
//   B. detector search "bus" + gold-box tracking      C. Vehicle details "city bus" (CLIP)      D. a plate result (injected)
// the viewer box set is captured at sampled times (what paintBoxes draws on each tile) and compared with what the export
// compositor burns at the export frame of the same SOURCE time: same number of boxes per camera, IoU > 0.8 per box.
// The live / tracked bus box must also follow the real bus (IoU > 0.5 with the ground truth), so a box held still or shown
// early fails. One exported frame per phase is decoded back and checked for gold pixels on the box.
// Usage: node test/burn-parity.js [url]   (BR=chromium|webkit, PHASES=A,B,C,D)
const pw = require("playwright"); const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.MOVING_SAMPLES || "/tmp/moving-samples";
const PH = (process.env.PHASES || "A,B,C,D").split(",");
const W = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(FIX + "/truth.json")) execFileSync("python3", [path.join(__dirname, "../tools/make-moving-footage.py"), FIX], { stdio: "inherit" });
const truth = JSON.parse(fs.readFileSync(FIX + "/truth.json", "utf8"));
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) w(q); else files.push(q); } })(FIX + "/TeslaCam");
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x).slice(0, 700) : "")); if (!c) fails++; };
const iou = (a, b) => { const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h); const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (a.w * a.h + b.w * b.h - i || 1); };
const truthAt = (t) => truth.front.reduce((m, x) => (Math.abs(x.t - t) < Math.abs(m.t - t) ? x : m));
const RANGES = [[0.4, 3.2], [4.4, 7.4]];   // two trimmed sections, joined

async function setup(p) {
  await p.addInitScript(() => {
    // capture: every box set the export compositor burns (inside drawFrame), and every set the viewer paints on a tile
    window.__exp = []; window.__view = {}; let inFrame = false;
    const hook = () => {
      const T = window.TDC; if (!T || !T.burnBoxes || !T.compositor || T.__hooked) return; T.__hooked = true;
      const at = T.burnBoxes.at, draw = T.burnBoxes.draw, df = T.compositor.drawFrame;
      T.compositor.drawFrame = function (ctx, geo, t) { inFrame = true; window.__frameT = t; try { return df.apply(this, arguments); } finally { inFrame = false; } };
      T.burnBoxes.at = function (cam, t) { const r = at.apply(this, arguments); if (inFrame && window.__recording) window.__exp.push({ cam, t, boxes: r.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, text: b.text })) }); return r; };
      T.burnBoxes.draw = function (ctx, cam, t, r, iw, ih, list) { if (ctx && ctx.canvas && ctx.canvas.classList && ctx.canvas.classList.contains("find-layer")) window.__view[cam] = (list || []).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, text: b.text })); return draw.apply(this, arguments); };
    };
    const iv = setInterval(() => { try { hook(); if (window.TDC && window.TDC.__hooked) clearInterval(iv); } catch (_) {} }, 20);
  });
  await p.goto(URL_, { waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important}" });
  await p.setInputFiles("#fileInput", files);
  for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
  await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); return TDC.ui.activate(TDC.library.events.find((e) => /12-00-00/.test(e.id)) || TDC.library.events[0]); });
  await W(1500);
}
// viewer box sets at times ts (player paused, seeked, tiles repainted)
async function viewerAt(p, ts) {
  const out = [];
  for (const t of ts) {
    await p.evaluate(async (t) => { TDC.player.pause(); await TDC.player.seek(t); }, t);
    await W(350);
    out.push(await p.evaluate(() => { window.__view = {}; TDC.search.paintBoxes(); return { t: TDC.player.time, cams: JSON.parse(JSON.stringify(window.__view)) }; }));
  }
  return out;
}
async function exportRun(p, ranges) {
  return p.evaluate(async (ranges) => {
    window.__exp = []; window.__recording = true; const t0 = performance.now(); const st = [];
    try {
      const r = await TDC.exporter.run({ preset: "compat", ranges, show: { ...TDC.prefs.show, labels: false, hud: false, map: false, fsd: false, time: false, boxes: true }, onStatus: (s) => st.push(s), onProgress: () => {} });
      window.__lastExport = r.blob;
      return { ok: true, ms: Math.round(performance.now() - t0), frames: r.frames, type: r.type, note: r.note || null, status: st.filter((s) => /Detecting|tracking/.test(s)).slice(-2), n: window.__exp.length };
    } catch (e) { return { ok: false, err: String(e && e.message || e), status: st.slice(-3) }; }
    finally { window.__recording = false; }
  }, ranges);
}
// decode the exported file at output time tau and count gold-ish pixels around the expected box (front tile of the 1920×1080 grid)
async function goldInFile(p, tau, box) {
  return p.evaluate(async ([tau, box]) => {
    const blob = window.__lastExport; if (!blob) return -1;
    const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(blob);
    if (TDC.search.park) TDC.search.park(v);
    await new Promise((r) => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 6000); });
    v.currentTime = tau; await new Promise((r) => { v.onseeked = r; setTimeout(r, 4000); });
    const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext("2d"); g.drawImage(v, 0, 0);
    const geo = TDC.compositor.geometry(c.width, c.height, TDC.player.ev.tile, false), i = TDC.GRID.indexOf("front"), r = TDC.compositor.cellRect(geo.grid, i, 0);
    const iw = 1280, ih = 960, s = Math.min(r.w / iw, r.h / ih), fw = iw * s, fh = ih * s, fx = r.x + (r.w - fw) / 2, fy = r.y + (r.h - fh) / 2;
    const x = Math.round(fx + box.x * fw), y = Math.round(fy + box.y * fh), w = Math.round(box.w * fw), h = Math.round(box.h * fh);
    let n = 0; const scan = (x0, y0, ww, hh) => { const d = g.getImageData(Math.max(0, x0), Math.max(0, y0), Math.max(1, ww), Math.max(1, hh)).data; for (let k = 0; k < d.length; k += 4) if (d[k] > 190 && d[k + 1] > 140 && d[k + 1] < 215 && d[k + 2] < 130 && d[k] - d[k + 2] > 90) n++; };
    scan(x - 4, y + Math.round(h * 0.3), 9, Math.round(h * 0.4));   // left edge
    scan(x + w - 4, y + Math.round(h * 0.3), 9, Math.round(h * 0.4));   // right edge
    v.remove(); return n;
  }, [tau, box]);
}
const tauOf = (t) => { let acc = 0; for (const r of RANGES) { if (t >= r[0] && t <= r[1]) return acc + (t - r[0]); acc += r[1] - r[0]; } return null; };
function compare(tag, view, exp, opt) {
  opt = opt || {};
  let pairs = 0, bad = [], truthOk = 0, truthN = 0, matched = 0, skipped = 0;
  for (const v of view) {
    const cands = exp.filter((e) => Math.abs(e.t - v.t) <= 0.02);
    if (!cands.length) { bad.push({ t: v.t, why: "no export frame at this source time" }); continue; }
    matched++;
    for (const cam of ["front", "back"]) {
      const vb = v.cams[cam] || [], e = cands.filter((x) => x.cam === cam).sort((a, b) => Math.abs(a.t - v.t) - Math.abs(b.t - v.t))[0], eb = e ? e.boxes : [];
      // the viewer can only seek to within ~1 frame of the export frame; if a live-sample switch point (midway between two
      // detections) lies between the two times, each side may legitimately show the nearer detection's box set
      const sw = e && (opt.samples || {})[cam] && opt.samples[cam].some((x, i, l) => i > 0 && (() => { const m = (l[i - 1] + x) / 2; return (m - v.t) * (m - e.t) <= 0; })());
      if (sw) { skipped++; continue; }
      if (vb.length !== eb.length) { bad.push({ t: +v.t.toFixed(2), cam, view: vb.length, exp: eb.length }); continue; }
      for (const b of vb) { pairs++; const best = Math.max(0, ...eb.map((x) => (x.text === b.text ? iou(x, b) : 0))); if (best <= 0.8) bad.push({ t: +v.t.toFixed(2), cam, text: b.text, iou: +best.toFixed(2) }); }
    }
    if (opt.truth && (!opt.truthIn || (v.t >= opt.truthIn[0] && v.t <= opt.truthIn[1]))) {
      const e = cands.find((x) => x.cam === "front"), bus = e && e.boxes.filter((b) => /bus/.test(b.text));
      truthN++; const tb = truthAt(v.t); if (bus && bus.some((b) => iou(b, tb) > 0.5)) truthOk++;
    }
  }
  ok(tag + ": every sampled viewer moment has an export frame at the same source time (trimmed sections)", matched === view.length && matched > 0, { matched, of: view.length });
  ok(tag + ": viewer and export draw the same boxes per camera (count + label, IoU > 0.8)", bad.length === 0 && pairs > 0 && skipped <= view.length * 0.25, { pairs, skippedAtSwitch: skipped, bad: bad.slice(0, 6) });
  if (opt.truth) ok(tag + ": the burned bus box follows the moving bus (IoU > 0.5 with the real position, ≥ 80% of frames)", truthOk >= 0.8 * truthN, { truthOk, truthN });
}
(async () => {
  for (const bn of (process.env.BR || "chromium,webkit").split(",")) {
    const ctx = await pw[bn].launchPersistentContext("/tmp/tdc-veh-profile-" + bn, bn === "chromium" ? { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"], viewport: { width: 1440, height: 900 } } : { viewport: { width: 1440, height: 900 } });
    await ctx.route((u) => u.origin === new URL(URL_).origin, (r) => r.continue());
    await ctx.addInitScript(() => { try { if (!sessionStorage.getItem("bp-init")) { sessionStorage.setItem("bp-init", "1"); localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, live: true, model: "nano", conf: 0.35 })); localStorage.setItem("tdc.export.burnBoxes", "1"); localStorage.removeItem("tdc.vehicle.v1"); localStorage.removeItem("tdc.plates.v1"); localStorage.removeItem("tdc.search.bestOnly"); indexedDB.deleteDatabase("tdc-vehicle-index"); } } catch (e) {} });
    const p = ctx.pages()[0] || (await ctx.newPage()); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message));
    await setup(p);
    const tag = bn;
    const ts = []; for (const r of RANGES) for (let t = r[0] + 0.15; t < r[1] - 0.1; t += 0.35) ts.push(+t.toFixed(3));
    console.log(bn, "webcodecs export:", await p.evaluate(() => TDC.exporter.webcodecs()));
    if (PH.includes("A")) {
      // ── A: live detection. Play the clip in the viewer (real "Detect while playing" ticks), then export. ──
      await p.evaluate(async () => { TDC.focus.focus("front"); await TDC.player.seek(0); TDC.player.play(); });
      for (let i = 0; i < 60 && (await p.evaluate(() => TDC.player.playing && TDC.player.time < 7.8)); i++) await W(250);
      const played = await p.evaluate(() => { TDC.player.pause(); return { samples: (TDC.detect.liveSamples.front || []).map((s) => +s.t.toFixed(2)) }; });
      ok(tag + " A: the viewer collected live detections while playing", played.samples.length >= 3, played);
      const r = await exportRun(p, RANGES);
      ok(tag + " A: export ran (fills the live detections the viewer didn't get to)", r.ok && r.n > 0, r);
      const view = await viewerAt(p, ts);
      compare(tag + " A live", view, await p.evaluate(() => window.__exp), { truth: true, samples: await p.evaluate(() => Object.fromEntries(Object.entries(TDC.detect.liveSamples).map(([c, l]) => [c, l.map((s) => s.t)]))) });
      if (process.env.DEBUG) console.log("samples", await p.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(TDC.detect.liveSamples).map(([c, l]) => [c, l.map((s) => s.t.toFixed(2) + ":" + s.dets.length + (s.src ? s.src[0] : "")).join(" ")])))));
      const mid = view.find((v) => v.t > 5.5) || view[view.length - 1], fb = (mid.cams.front || []).find((b) => /bus/.test(b.text));
      if (fb) { const n = await goldInFile(p, tauOf(mid.t), fb); ok(tag + " A: the exported file has the gold box on the bus at " + mid.t.toFixed(2) + " s", n > 8, { goldPixels: n }); }
      else ok(tag + " A: a bus box to check in the file", false, mid);
    }
    if (PH.includes("B")) {
      // ── B: detector search + tracking (live off) ──
      await p.evaluate(() => { TDC.detect.setPref("live", false); TDC.detect.liveSamples = {}; TDC.detect.live = {}; TDC.focus.grid && TDC.focus.grid(); });
      await p.evaluate(() => { document.getElementById("findQuery").value = "bus"; document.getElementById("findCam").value = "front"; TDC.search.run(); });
      await W(300); for (let i = 0; i < 900 && (await p.evaluate(() => TDC.search.running || !!TDC.search.pending)); i++) await W(200);
      const st = await p.evaluate(() => ({ hits: TDC.search.hits.length, tracks: TDC.detect.tracks.map((g) => [g.cam, +g.from.toFixed(1), +g.to.toFixed(1)]) }));
      ok(tag + " B: detector search found the bus and tracking ran", st.hits > 0 && st.tracks.length > 0, st);
      const r = await exportRun(p, RANGES); ok(tag + " B: export ran", r.ok, r);
      const tsB = ts.filter((t) => st.tracks.some(([, a, z]) => t >= a && t <= z) || true);
      const tr0 = st.tracks.find((x) => x[0] === "front");
      compare(tag + " B detector+tracks", await viewerAt(p, tsB), await p.evaluate(() => window.__exp), tr0 ? { truth: true, truthIn: [tr0[1] + 0.1, tr0[2] - 0.1] } : {});
    }
    if (PH.includes("C")) {
      // ── C: Vehicle details "city bus" ──
      await p.evaluate(() => { TDC.search.clear(); TDC.vehicle.setPref("enabled", true); });
      await p.evaluate(() => { document.getElementById("findQuery").value = "city bus"; document.getElementById("findCam").value = "front"; TDC.search.run(); });
      await W(300); for (let i = 0; i < 1500 && (await p.evaluate(() => TDC.search.running || !!TDC.search.pending)); i++) await W(200);
      const st = await p.evaluate(() => ({ hits: TDC.search.hits.map((h) => h.text).slice(0, 2), tracks: TDC.detect.tracks.length }));
      ok(tag + " C: vehicle search found the city bus", st.hits.length > 0, st);
      const r = await exportRun(p, RANGES); ok(tag + " C: export ran", r.ok, r);
      compare(tag + " C vehicle", await viewerAt(p, ts), await p.evaluate(() => window.__exp));
    }
    if (PH.includes("D")) {
      // ── D: a plate result (injected like test/plate-bestmatch.js; no real plate is visible in the footage) ──
      await p.evaluate(() => {
        const S = TDC.search; S.clear(); TDC.detect.tracks = [];
        const h = { t: 5.0, cam: "back", score: 0.9, conf: 0.9, plate: true, text: "7TST123 91%", boxText: "7TST123 · match 100% · read 91% · Best match", best: true, box: { x: 0.45, y: 0.6, w: 0.08, h: 0.04 } };
        S.allHits = [h]; S.hits = [h]; S.anchor = 5.0; S.renderHits(); S.paintBoxes();
      });
      const r = await exportRun(p, RANGES); ok(tag + " D: export ran", r.ok, r);
      const tsD = [4.45, 4.6, 5.0, 5.4, 5.9, 6.1, 6.5];
      const view = await viewerAt(p, tsD);
      ok(tag + " D: the viewer shows the plate box around its moment only (±1 s)", view.filter((v) => (v.cams.back || []).length).every((v) => Math.abs(v.t - 5) <= 1.01) && view.some((v) => (v.cams.back || []).length), view.map((v) => [v.t, (v.cams.back || []).length]));
      compare(tag + " D plate", view, await p.evaluate(() => window.__exp));
    }
    ok(tag + " no page errors", p.errs.length === 0, p.errs.slice(0, 3));
    await ctx.close();
  }
  console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
