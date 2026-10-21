// Plate blur (tag plate-blur-fix), Playwright Chromium + WebKit, real plate models (WASM).
// Footage: tools/make-plate-footage.py (synthetic CA-style plate 7TST123 on the front camera, made-up numbers).
//  - ticking Settings ▸ Plates & text ▸ "Blur plates" (no search yet) finds the plates in the background (status line)
//  - with blur on, plate search still reads the plate from RAW frames ("7TST123 … Best match"), also after a rescan
//  - viewer: the plate area on the redact layer is blurred (pixel spread far below the raw frame's)
//  - export: the compositor's redact hook (what every export frame calls) blurs the same area; Chromium also with the
//    no-canvas-filter fallback that Safari uses; turning blur off restores sharp pixels in both
//  - a failing blur lookup is shown in the status line (not swallowed); no page errors
// Usage: BR=chromium|webkit node test/plate-blur.js [url]
const pw = require("playwright"); const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.PLATE_FIXTURES || "/tmp/plate-samples";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(FIX + "/TeslaCam")) execFileSync("python3", [path.join(__dirname, "../tools/make-plate-footage.py"), FIX], { stdio: "inherit" });
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) w(q); else files.push(q); } })(FIX + "/TeslaCam");
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x).slice(0, 600) : "")); if (!c) fails++; };
const T_ = 4.2;
async function open(p) {
  await p.goto(URL_, { waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important}" });
  await p.setInputFiles("#fileInput", files);
  for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
  await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); return TDC.ui.activate(TDC.library.events[0]); });
  await W(1200);
}
const tick = (p, id, v) => p.evaluate(([id, v]) => { const c = document.getElementById(id); c.checked = v; c.dispatchEvent(new Event("change")); }, [id, v]);
const find = async (p, q) => { await p.evaluate((q) => { document.getElementById("findQuery").value = q; document.getElementById("findCam").value = "front"; return TDC.search.run(); }, q);
  for (let i = 0; i < 900 && (await p.evaluate(() => TDC.search.running)); i++) await W(200);
  return p.evaluate(() => ({ hits: TDC.search.hits.map((h) => ({ t: h.t, text: h.text, label: h.label })), status: document.getElementById("findStatus").textContent })); };
/** Pixel spread (luminance std) inside the plate box: viewer layer, raw frame, and the export hook's output. */
const measure = (p) => p.evaluate(async (t) => {
  TDC.player.pause(); await TDC.player.seek(t); await new Promise((r) => setTimeout(r, 700)); TDC.emit("layout"); await new Promise((r) => setTimeout(r, 250));
  const tile = TDC.player.tiles.front, video = tile.vids[TDC.player.active], cv = tile.tile.querySelector(".redact-layer");
  const boxes = TDC.plates.blurBoxesAt("front", t);
  const truth = TDC.__plateBox || null;
  const b = boxes[0] || TDC.__lastBox; if (!b) return { boxes: 0 };
  TDC.__lastBox = b;
  const inner = { x: b.x + b.w * 0.2, y: b.y + b.h * 0.25, w: b.w * 0.6, h: b.h * 0.5 };   // the plate itself
  const std = (d) => { let s = 0, s2 = 0, n = 0; for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 200) continue; const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; s += l; s2 += l * l; n++; } return n ? { std: Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)), n } : { std: -1, n: 0 }; };
  const vw = video.videoWidth, vh = video.videoHeight;
  // raw frame
  const rc = document.createElement("canvas"); rc.width = vw; rc.height = vh; const rx = rc.getContext("2d", { willReadFrequently: true }); rx.drawImage(video, 0, 0);
  const raw = std(rx.getImageData(inner.x * vw, inner.y * vh, inner.w * vw, inner.h * vh).data);
  // viewer layer (contain fit inside the tile, device pixels)
  let view = { std: -1, n: 0 };
  if (cv) { const s = Math.min(cv.width / vw, cv.height / vh), ox = (cv.width - vw * s) / 2, oy = (cv.height - vh * s) / 2;
    view = std(cv.getContext("2d").getImageData(ox + inner.x * vw * s, oy + inner.y * vh * s, Math.max(1, inner.w * vw * s), Math.max(1, inner.h * vh * s)).data); }
  // export hook: the compositor draws the frame, then T.redact.burn (compositor.js) — same call, same frame
  const ex = (soft) => { TDC.redact.forceSoftBlur = soft; const ec = document.createElement("canvas"); ec.width = vw; ec.height = vh; const x = ec.getContext("2d", { willReadFrequently: true }); x.drawImage(video, 0, 0); TDC.redact.burn(x, "front", t, { x: 0, y: 0, w: vw, h: vh }, vw, vh, video); TDC.redact.forceSoftBlur = false; return std(x.getImageData(inner.x * vw, inner.y * vh, inner.w * vw, inner.h * vh).data); };
  return { boxes: boxes.length, raw, view, exp: ex(false), expSoft: ex(true), canFilter: TDC.redact.canvasFilter() };
}, T_);

(async () => {
  const BR = process.env.BR || "chromium";
  const b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage();
  const errs = [], warns = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => { if (m.type() === "warning" && /plate blur/.test(m.text())) warns.push(m.text()); });
  await open(p);
  await tick(p, "plEnabled", true);
  await tick(p, "plBlur", true);
  for (let i = 0; i < 600 && (await p.evaluate(() => !!TDC.plates.bgScan || TDC.plates.blurEvent !== TDC.player.ev.id)); i++) await W(250);
  const st = await p.evaluate(() => ({ status: document.getElementById("plStatus").textContent, tracks: (TDC.plates.blurTracks.front || []).length, canFilter: TDC.redact.canvasFilter() }));
  ok(BR + ": ticking 'Blur plates' finds plates in the background (no search needed), status line says so", st.tracks >= 1 && /Plates found and blurred/.test(st.status), st);
  let r = await find(p, "plate 7TST*");
  ok(BR + ": with blur on, 'plate 7TST*' still reads the plate: '7TST123 · … · Best match'", r.hits.length >= 1 && r.hits.some((h) => /^7TST123 · match \d+% · read \d+%.* · Best match$/.test(h.text)), r);
  await p.evaluate(() => TDC.search.clear());
  const on = await measure(p);
  console.log("SPREAD (luminance std in the plate) blur on:", JSON.stringify(on));
  ok(BR + ": viewer: plate area blurred (spread < 40% of the raw frame's)", on.boxes >= 1 && on.view.n > 20 && on.view.std < on.raw.std * 0.4, on);
  ok(BR + ": export frame (redact hook): plate area blurred (< 40% of raw)", on.exp.n > 20 && on.exp.std < on.raw.std * 0.4, on.exp);
  ok(BR + ": no-canvas-filter fallback (what Safari uses) also blurs (< 40% of raw)", on.expSoft.std < on.raw.std * 0.4, on.expSoft);
  const unread = await p.evaluate(async (t) => { const v = TDC.player.tiles.front.vids[TDC.player.active], b = TDC.__lastBox, out = {};
    for (const soft of [false, true]) { TDC.redact.forceSoftBlur = soft; const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; const x = c.getContext("2d"); x.drawImage(v, 0, 0); TDC.redact.burn(x, "front", t, { x: 0, y: 0, w: c.width, h: c.height }, c.width, c.height, v); TDC.redact.forceSoftBlur = false;
      const r = await TDC.plates.analyze(c, c.width, c.height, { street: false }); out[soft ? "soft" : "filter"] = r.plates.map((q) => q.text); }
    return out; }, T_);
  ok(BR + ": the plate reader can't read 7TST123 from a blurred export frame", !Object.values(unread).some((a) => a.some((x) => /7TST/.test(x))), unread);
  if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + "/plate-blur-after-" + BR + ".png", clip: await p.evaluate(() => { const r = TDC.player.tiles.front.tile.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }) });
  // the plate reader reads raw frames even while the blurred layer is shown: forget the index and search again
  await p.evaluate(async () => { await TDC.libIndex.text.clear(); });
  r = await find(p, "plate 7TST*");
  ok(BR + ": rescan with the blurred layer on screen still reads 7TST123 (reader uses raw frames)", r.hits.some((h) => /^7TST123 /.test(h.text)), r);
  await p.evaluate(() => TDC.search.clear());
  await tick(p, "plBlur", false);
  const off = await measure(p);
  console.log("SPREAD blur off:", JSON.stringify(off));
  ok(BR + ": blur off → viewer layer empty there, export frame sharp again (≈ raw)", off.boxes === 0 && off.view.n === 0 && Math.abs(off.exp.std - off.raw.std) < off.raw.std * 0.1, off);
  // errors are shown, not swallowed
  await tick(p, "plBlur", true); await W(500);
  const er = await p.evaluate(async () => { const D = TDC.detect, keep = D.trackAt; D.trackAt = () => { throw new Error("test failure in trackAt"); }; TDC.emit("layout"); await new Promise((r) => setTimeout(r, 200)); D.trackAt = keep; return document.getElementById("plStatus").textContent; });
  ok(BR + ": a failing blur lookup shows in the status line and the console", /Plate blur problem: test failure in trackAt/.test(er) && warns.some((w) => /test failure/.test(w)), { status: er, warns });
  ok(BR + ": no page errors", errs.length === 0, errs);
  await b.close();
  console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
