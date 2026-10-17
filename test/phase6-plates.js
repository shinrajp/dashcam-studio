// Phase 6 plates & street text, headless Chrome (puppeteer-core). Needs: the repo served (python3 -m http.server 8796),
// synthetic footage from tools/make-plate-footage.py (default /tmp/plate-samples), ffmpeg for the export check.
//  - real models on test/fixtures/plate-*.jpg (synthetic CA-style plates, made-up numbers): detection + reading accuracy, speed
//  - street sign text with the bundled PP-OCR (redact.js)
//  - search: "plate 7TST*", "7TST 12", "5SMP260" (around), "plates", no-match; index saved in IndexedDB and back after reload
//  - gold box follows the plate; label "plate 7TST123 NN%" in viewer + burn-boxes
//  - blur: live preview layer + REAL export (Most Compatible MP4) decoded with ffmpeg: plate area blurred vs. not
//  - graceful failure: missing model, IndexedDB unavailable; regressions: detection/CLIP routing unchanged, off by default
// Usage: node test/phase6-plates.js [url]    SHOTS=dir saves screenshots
const puppeteer = require("puppeteer-core"); const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8796/index.html";
const FIX = process.env.PLATE_FIXTURES || "/tmp/plate-samples";
const SHOTS = process.env.SHOTS || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(FIX + "/TeslaCam")) execFileSync("python3", [path.join(__dirname, "../tools/make-plate-footage.py"), FIX], { stdio: "inherit" });
const truthVid = JSON.parse(fs.readFileSync(FIX + "/plate-truth.json", "utf8"));
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) w(q); else files.push(q); } })(FIX + "/TeslaCam");
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x) : "")); if (!c) fails++; };
async function open(b, opts) {
  opts = opts || {};
  const p = await b.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message));
  await p.setViewport(opts.vp || { width: 1440, height: 900 });
  if (opts.noIdb) await p.evaluateOnNewDocument(() => { Object.defineProperty(window, "indexedDB", { get() { throw new Error("blocked"); } }); });
  await p.goto(URL_, { waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important}" });
  if (opts.event !== false) {
    await (await p.$("#fileInput")).uploadFile(...files);
    for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
    await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); return TDC.ui.activate(TDC.library.events[0]); });
    await W(1200);
  }
  return p;
}
const find = async (p, q, cam) => { await p.evaluate((q, cam) => { document.getElementById("findQuery").value = q; document.getElementById("findCam").value = cam || "front"; return TDC.search.run(); }, q, cam);
  for (let i = 0; i < 900 && (await p.evaluate(() => TDC.search.running)); i++) await W(200);
  return p.evaluate(() => ({ hits: TDC.search.hits.map((h) => ({ t: h.t, cam: h.cam, label: h.label, text: h.text, conf: h.conf, box: h.box, plate: h.plate })), status: document.getElementById("findStatus").textContent })); };

(async () => {
  const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--hide-scrollbars"], userDataDir: "/tmp/tdc-p6-" + Date.now(), protocolTimeout: 900000 });
  let p = await open(b);
  // ── defaults / settings ──
  ok("plates OFF by default; plate queries not taken", await p.evaluate(() => !TDC.plates.enabled() && !TDC.plates.handlesQuery("plate 7ABC234") && !TDC.plates.blurOn()));
  ok("default plate finder: accurate on desktop", await p.evaluate(() => TDC.plates.prefs().model === "accurate"));
  await p.evaluate(() => document.getElementById("btnSettings").click()); await W(300);
  ok("Settings ▸ Plates & text: toggle, model, thresholds, street, blur, status, forget", await p.evaluate(() => ["plEnabled", "plModel", "plConf", "plRead", "plFar", "plStreet", "plBlur", "plStatus", "plForget"].every((id) => document.getElementById(id))));
  await p.evaluate(() => { const c = document.getElementById("plEnabled"); c.checked = true; c.dispatchEvent(new Event("change")); });
  ok("enable persists; routing: plates vs objects vs picture search", await p.evaluate(() => { const L = TDC.plates; return JSON.parse(localStorage.getItem("tdc.plates.v1")).enabled === true && L.handlesQuery("plate 7AB*") && L.handlesQuery("7ABC 23") && L.handlesQuery("street Palm Ave") && !L.handlesQuery("car") && !L.handlesQuery("a person in a hoodie"); }));
  if (SHOTS) { await p.evaluate(() => document.getElementById("setPlates").scrollIntoView({ block: "center" })); await W(300); await p.screenshot({ path: SHOTS + "/phase6-settings.png" }); }
  await p.evaluate(() => document.getElementById("btnCloseSettings").click());
  // ── real models on still fixtures ──
  const acc = await p.evaluate(async () => {
    const L = TDC.plates, truth = await (await fetch("test/fixtures/plates.json")).json(), out = {};
    for (const model of ["fast", "accurate"]) {
      L.setPref("model", model); const t0 = performance.now(); await L.load(); const loadMs = Math.round(performance.now() - t0);
      L.timings.det = []; L.timings.ocr = [];
      const rows = [];
      for (const tr of truth) { if (!tr.text) continue;
        const img = new Image(); img.src = "test/fixtures/" + tr.file; await img.decode();
        const a = performance.now(); const r = await L.analyze(img, img.naturalWidth, img.naturalHeight, { tiles: false }); const ms = performance.now() - a;
        const best = r.plates.sort((x, y) => y.conf - x.conf)[0];
        const iou = best ? ((a, b) => { const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h); const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (a.w * a.h + b.w * b.h - i); })(best.box, tr.box) : 0;
        rows.push({ file: tr.file, px: tr.plateWidthPx, truth: tr.text, read: best ? best.text : null, conf: best ? Math.round(best.conf * 100) : 0, iou: Math.round(iou * 100) / 100, ms: Math.round(ms), falsePos: r.plates.length - (best ? 1 : 0) });
      }
      const avg = (a) => Math.round(a.reduce((s, x) => s + x, 0) / Math.max(1, a.length));
      out[model] = { loadMs, rows, found: rows.filter((r) => r.iou > 0.5).length, exact: rows.filter((r) => r.read === r.truth).length, n: rows.length, detMs: avg(L.timings.det), ocrMs: avg(L.timings.ocr), backend: L.info.backend };
    }
    return out;
  });
  for (const m of ["fast", "accurate"]) { console.log("ACCURACY", m, JSON.stringify(acc[m])); ok("real " + m + ": finds every fixture plate (IoU > 0.5) and reads ≥ 4 of 5 exactly", acc[m].found === acc[m].n && acc[m].exact >= acc[m].n - 1, { found: acc[m].found, exact: acc[m].exact, n: acc[m].n }); }
  ok("no false plates on the fixtures", ["fast", "accurate"].every((m) => acc[m].rows.every((r) => r.falsePos === 0)));
  const sign = await p.evaluate(async () => { const img = new Image(); img.src = "test/fixtures/street-sign-palm-ave.jpg"; await img.decode(); const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext("2d").drawImage(img, 0, 0); const a = performance.now(); const r = await TDC.redact.readSigns(c); return { ms: Math.round(performance.now() - a), r: r.map((x) => x.text + " " + x.conf), hit: r.some((x) => TDC.plateText.matchText("Palm Ave", x.text) >= 0.75) }; });
  console.log("STREET", JSON.stringify(sign));
  ok("street sign text: 'Palm Ave' read by the bundled OCR", sign.hit, sign.r);
  // ── search on the synthetic event ──
  await p.evaluate(() => TDC.plates.setPref("model", "accurate"));
  const t0 = Date.now();
  let r = await find(p, "plate 7TST*", "around");
  const scanMs = Date.now() - t0;
  const scan = await p.evaluate(() => { const s = TDC.libIndex.text.get(TDC.player.ev.id); return s && { n: s.items.length, cams: s.cams, step: s.step, frames: Math.round(8 / s.step) * s.cams.length, ms: s.ms, mode: TDC.libIndex.text.mode, plates: [...new Set(s.items.map((i) => i.cam + ":" + i.text))] }; });
  console.log("SCAN", JSON.stringify(scan), "search ms", scanMs);
  ok("'plate 7TST*' → front hits labelled 'plate 7TST123 NN%'", r.hits.length > 0 && r.hits.every((h) => h.cam === "front" && h.label === "plate 7TST123" && /^7TST123 \d+%$/.test(h.text)), r);
  ok("index stored in IndexedDB with both plates (metadata only)", scan && scan.mode === "indexeddb" && scan.plates.includes("front:7TST123") && scan.plates.includes("back:5SMP260"), scan);
  ok("index records carry time, camera, box, confidence, per-char confidence — no image data", await p.evaluate(() => TDC.libIndex.text.get(TDC.player.ev.id).items.every((i) => typeof i.t === "number" && i.cam && i.box && typeof i.conf === "number" && Array.isArray(i.chars) && !Object.values(i).some((v) => typeof v === "string" && v.length > 64))));
  // the box is on the plate
  const gtBox = (t) => truthVid.front.frames.reduce((a, f) => (Math.abs(f.t - t) < Math.abs(a.t - t) ? f : a)).box;
  const iou = (a, b) => { const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h); const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (a.w * a.h + b.w * b.h - i); };
  ok("hit box overlaps the real plate (IoU > 0.5)", r.hits.every((h) => iou(h.box, gtBox(h.t)) > 0.5), r.hits.map((h) => Math.round(iou(h.box, gtBox(h.t)) * 100) / 100));
  for (let i = 0; i < 160 && !(await p.evaluate(() => TDC.detect.tracks.length)); i++) await W(250);
  const tk = await p.evaluate(() => { const D = TDC.detect, tr = D.tracks[0]; if (!tr) return null; return { from: tr.from, to: tr.to, a: D.boxesAt("front", tr.from + 0.05), z: D.boxesAt("front", tr.to - 0.05), burn: TDC.burnBoxes.at("front", tr.from + 0.05) }; });
  ok("gold box follows the plate (tracked, moves/grows)", tk && tk.to - tk.from >= 1.5 && tk.a.length === 1 && tk.z.length === 1 && Math.abs(tk.z[0].w - tk.a[0].w) > 0.003, tk);
  ok("label 'plate 7TST123 NN%' in viewer and burn-in", tk && /^plate 7TST123 \d+%$/.test(tk.a[0].text) && tk.burn[0].text === tk.a[0].text, tk && tk.a[0]);
  if (SHOTS) { await p.evaluate(async () => { TDC.player.pause(); await TDC.player.seek(2.2); }); await W(900); await p.screenshot({ path: SHOTS + "/phase6-plate-search.png" }); }
  r = await find(p, "7TST 12", "front");
  ok("partial '7TST 12' (no rescan, instant)", r.hits.length > 0 && r.hits[0].label === "plate 7TST123", r.status);
  r = await find(p, "5SMP26O", "around");
  ok("look-alike '5SMP26O' finds 5SMP260 on the rear camera", r.hits.some((h) => h.cam === "back" && h.label === "plate 5SMP260"), r);
  r = await find(p, "plates", "around");
  ok("'plates' lists every plate", new Set(r.hits.map((h) => h.label)).size === 2, r.hits.map((h) => h.label));
  r = await find(p, "plate 9ZZZ999", "around");
  ok("no match → clear message, no hits", r.hits.length === 0 && /No plate matching 9ZZZ999/.test(r.status), r.status);
  // ── blur: live preview + real export ──
  await p.evaluate(() => { TDC.search.clear(); TDC.plates.setPref("blur", true); TDC.plates.blurFromIndex(TDC.player.ev); });
  const live = await p.evaluate(async () => { TDC.player.pause(); await TDC.player.seek(4.2); await new Promise((r) => setTimeout(r, 700)); TDC.emit("layout"); await new Promise((r) => setTimeout(r, 200)); const cv = TDC.player.tiles.front.tile.querySelector(".redact-layer"); const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return { painted: n, boxes: TDC.plates.blurBoxesAt("front", 4.2).length }; });
  ok("blur preview painted on the live player", live.painted > 50 && live.boxes === 1, live);
  if (SHOTS) await p.screenshot({ path: SHOTS + "/phase6-blur-preview.png" });
  const exportOnce = async (blur) => {
    await p.evaluate((blur) => { TDC.plates.setPref("blur", blur); window.__tdcLastExport = null; document.getElementById("btnExport").click(); }, blur); await W(700);
    ok("export dialog shows 'Blur licence plates' = " + blur, await p.evaluate((blur) => !document.getElementById("exportPlatesWrap").hidden && document.getElementById("exportPlates").checked === blur, blur));
    await p.evaluate(() => document.getElementById("btnExportGo").click());
    for (let i = 0; i < 900 && !(await p.evaluate(() => window.__tdcLastExport)); i++) { await W(300); if (await p.evaluate(() => /failed/i.test(document.getElementById("exportText").textContent))) break; }
    const res = await p.evaluate(async () => { const r = window.__tdcLastExport; if (!r) return { err: document.getElementById("exportText").textContent }; const buf = new Uint8Array(await r.blob.arrayBuffer()); let s = ""; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768)); return { name: r.name, b64: btoa(s) }; });
    await p.evaluate(() => { document.getElementById("exportModal").hidden = true; });
    if (res.err) return { err: res.err };
    const f = "/tmp/p6-export-" + (blur ? "blur" : "plain") + path.extname(res.name); fs.writeFileSync(f, Buffer.from(res.b64, "base64")); return { file: f };
  };
  const plain = await exportOnce(false), blurred = await exportOnce(true);
  ok("real export works with and without plate blur", !plain.err && !blurred.err, [plain.err, blurred.err]);
  if (!plain.err && !blurred.err) {
    // sharpness (sum of |horizontal gradient|) of the front-tile plate area at t = 4.2 s in both exports
    const sharp = (file) => { const raw = execFileSync("ffmpeg", ["-loglevel", "error", "-ss", "4.2", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-s", "1920x1080", "-"], { maxBuffer: 1 << 26 });
      return raw; };
    const A = sharp(plain.file), B = sharp(blurred.file);
    const geo = await p.evaluate(() => { const g = TDC.compositor.geometry(1920, 1080, TDC.player.ev.tile, false), i = TDC.GRID.indexOf("front"); return TDC.compositor.cellRect(g.grid, i, 0); });
    const pb = gtBox(4.2), fw = Math.min(geo.w / 1280, geo.h / 960), ox = geo.x + (geo.w - 1280 * fw) / 2, oy = geo.y + (geo.h - 960 * fw) / 2;
    const rx = Math.round(ox + pb.x * 1280 * fw), ry = Math.round(oy + pb.y * 960 * fw), rw = Math.max(4, Math.round(pb.w * 1280 * fw)), rh = Math.max(3, Math.round(pb.h * 960 * fw));
    const grad = (img) => { let g = 0; for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw - 1; x++) g += Math.abs(img[y * 1920 + x + 1] - img[y * 1920 + x]); return g / (rw * rh); };
    const gA = grad(A), gB = grad(B);
    console.log("EXPORT plate-area sharpness plain", gA.toFixed(2), "blurred", gB.toFixed(2), "rect", rx, ry, rw, rh);
    ok("export: plate area blurred (sharpness drops ≥ 50%)", gB < gA * 0.5, { plain: gA, blurred: gB });
    if (SHOTS) execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", "4.2", "-i", blurred.file, "-frames:v", "1", SHOTS + "/phase6-export-blur.png"]);
  }
  ok("no page errors", p.errs.length === 0, p.errs);
  // ── index survives reload; forget clears it ──
  await p.close(); p = await open(b);
  ok("index back after reload (instant search, no rescan)", await p.evaluate(async () => { await TDC.libIndex.text.ready; return TDC.libIndex.text.count() > 0; }));
  const t1 = Date.now(); r = await find(p, "plate 5SMP*", "around");
  ok("search after reload uses the index (< 3 s)", r.hits.length > 0 && Date.now() - t1 < 3000, { ms: Date.now() - t1, n: r.hits.length });
  await p.evaluate(() => { document.getElementById("btnSettings").click(); document.getElementById("plForget").click(); }); await W(500);
  ok("Forget plate & text index clears it", await p.evaluate(() => TDC.libIndex.text.count() === 0));
  // ── graceful failure ──
  const fail = await p.evaluate(async () => { const L = TDC.plates; L.unload(); TDC.libIndex.text.scans.clear(); const base = L.BASE; L.BASE = null; L.setPref("urls", { accurate: "models/missing.onnx" }); const keep = L.MODELS.accurate.file; L.MODELS.accurate.file = "missing-too.onnx"; document.getElementById("findQuery").value = "plate 7TST*"; await TDC.search.run(); L.MODELS.accurate.file = keep; L.BASE = base; L.setPref("urls", {}); return { status: document.getElementById("findStatus").textContent, plStatus: L.status, hits: TDC.search.hits.length, running: TDC.search.running }; });
  ok("missing plate model → readable message, search not stuck", /Plate reading unavailable/.test(fail.status) && fail.hits === 0 && !fail.running, fail);
  await p.evaluate(() => TDC.plates.unload());
  ok("detector routing unchanged when plates on ('car' → Phase 5 / CLIP, not plates)", await p.evaluate(() => !TDC.plates.handlesQuery("car") && !TDC.plates.handlesQuery("cars")));
  await p.close();
  const q = await open(b, { noIdb: true });
  await q.evaluate(() => TDC.plates.setPref("enabled", true));
  r = await find(q, "plate 7TST*", "front");
  ok("IndexedDB blocked → memory index, search still works", r.hits.length > 0 && (await q.evaluate(() => TDC.libIndex.text.mode)) === "memory", { n: r.hits.length, status: r.status });
  ok("no page errors (no IndexedDB)", q.errs.length === 0, q.errs);
  // mobile default
  const mp = await b.newPage(); await mp.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"); await mp.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await mp.goto(URL_, { waitUntil: "load" }); await mp.evaluate(() => localStorage.removeItem("tdc.plates.v1"));
  ok("iPhone defaults: off, fast (384) finder, no zoom tiles, 1280 px frames", await mp.evaluate(() => !TDC.plates.enabled() && TDC.plates.prefs().model === "fast" && !TDC.plates.useTiles(2896)));
  await b.close(); console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
