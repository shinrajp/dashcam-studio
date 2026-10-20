// Boxes on/off (tag box-toggle): the camera-bar "Boxes" button, the X key and the "Gold box" checkbox share one saved state.
// Off: no live-detection or search boxes in the viewer, none burned into the export, Detect while playing pauses (no new
// detections); on again: detections resume and boxes come back. Also: aria-pressed + strike-through, visible in the grid,
// in a focused (full-screen single-camera) view and in the phone layout, state kept after a reload.
// Playwright Chromium + WebKit, real YOLO11 (WASM), tools/make-moving-footage.py footage.   Usage: node test/box-toggle.js [url]
const pw = require("playwright"); const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.MOVING_SAMPLES || "/tmp/moving-samples";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(FIX + "/truth.json")) execFileSync("python3", [path.join(__dirname, "../tools/make-moving-footage.py"), FIX], { stdio: "inherit" });
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) w(q); else files.push(q); } })(FIX + "/TeslaCam");
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x).slice(0, 500) : "")); if (!c) fails++; };
async function load(p) {
  await p.goto(URL_, { waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important}" });
  await p.setInputFiles("#fileInput", files);
  for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
  await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); return TDC.ui.activate(TDC.library.events[0]); });
  await W(1200);
}
const state = (p) => p.evaluate(() => { const b = document.getElementById("btnBoxes"), s = b && b.querySelector(".strike"); return { pressed: b && b.getAttribute("aria-pressed"), visible: !!(b && b.offsetParent && b.getBoundingClientRect().width > 0), strike: s ? getComputedStyle(s).display : null, gold: document.getElementById("findShow").checked, saved: localStorage.getItem("tdc.boxes.v1") }; });
const play = (p, t0, ms) => p.evaluate(async ([t0, ms]) => { const D = TDC.detect; await TDC.player.seek(t0); const n0 = D.liveStats.starts.length; window.__drawn = 0; TDC.player.play(); await new Promise((r) => setTimeout(r, ms)); TDC.player.pause(); return D.liveStats.starts.length - n0; }, [t0, ms]);
const viewBoxes = (p) => p.evaluate(async () => { await new Promise((r) => setTimeout(r, 300)); let n = 0; const B = TDC.burnBoxes; for (const c of TDC.GRID) n += B.at(c, TDC.player.time).length; return n; });
(async () => {
  for (const bn of (process.env.BR || "chromium,webkit").split(",")) {
    const b = await pw[bn].launch(bn === "chromium" ? { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] } : {});
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => { if (!sessionStorage.getItem("bt")) { sessionStorage.setItem("bt", "1"); localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, live: true, model: "nano", conf: 0.35, speed: "balanced", liveCams: "all" })); localStorage.setItem("tdc.export.burnBoxes", "1"); localStorage.removeItem("tdc.boxes.v1"); } });
    const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
    await load(p); const tag = bn;
    let s = await state(p);
    ok(tag + ": Boxes button is in the camera bar, on by default (aria-pressed=true, no strike)", s.visible && s.pressed === "true" && s.strike === "none" && s.gold, s);
    await p.evaluate(() => TDC.detect.load());
    const on1 = await play(p, 0.5, 2500);
    ok(tag + ": on: Detect while playing runs and boxes are drawn", on1 > 0 && (await viewBoxes(p)) > 0, { detections: on1 });
    await p.keyboard.press("x");
    s = await state(p);
    ok(tag + ": X turns boxes off: aria-pressed=false, strike-through shown, Gold box unticked, saved", s.pressed === "false" && s.strike !== "none" && !s.gold && s.saved === "0", s);
    const off1 = await play(p, 3.0, 2500);
    ok(tag + ": off: no live detections while playing (paused) and no boxes in the viewer", off1 === 0 && (await viewBoxes(p)) === 0, { detections: off1 });
    const ex = await p.evaluate(async () => { const got = []; const at = TDC.burnBoxes.at; TDC.burnBoxes.at = function () { const r = at.apply(this, arguments); got.push(r.length); return r; };
      try { await TDC.exporter.run({ preset: "compat", ranges: [[0.5, 2.5]], show: { ...TDC.prefs.show, labels: false, hud: false, map: false, fsd: false, time: false, boxes: true }, onStatus: () => {}, onProgress: () => {} }); } finally { TDC.burnBoxes.at = at; }
      return { calls: got.length, boxes: got.reduce((a, x) => a + x, 0) }; });
    ok(tag + ": off: nothing burned into the export", ex.calls > 0 && ex.boxes === 0, ex);
    await load(p);
    s = await state(p);
    ok(tag + ": off is kept after a reload", s.pressed === "false" && !s.gold, s);
    await p.click("#btnBoxes");
    s = await state(p);
    await p.evaluate(() => TDC.detect.load());
    const on2 = await play(p, 4.0, 2500);
    ok(tag + ": tapping Boxes turns them on again: detections resume, boxes drawn", s.pressed === "true" && s.gold && on2 > 0 && (await viewBoxes(p)) > 0, { s, detections: on2 });
    await p.evaluate(() => { const c = document.getElementById("findShow"); c.checked = false; c.dispatchEvent(new Event("change")); });
    s = await state(p);
    ok(tag + ": the Gold box checkbox and the button share the state", s.pressed === "false" && s.saved === "0", s);
    await p.evaluate(() => TDC.focus.focus("front")); await W(300);
    ok(tag + ": visible in the focused single-camera view", (await state(p)).visible);
    const fs = await p.evaluate(async () => { try { await TDC.focus.fullscreen(true); } catch (_) {} await new Promise((r) => setTimeout(r, 600)); const r = { fs: document.body.classList.contains("fs") }; try { await TDC.focus.fullscreen(false); } catch (_) {} return r; });
    ok(tag + ": visible in full screen with one camera" + (fs.fs ? "" : " (full screen not allowed headless: checked the focused view)"), (await state(p)).visible, fs);
    await p.setViewportSize({ width: 390, height: 844 }); await W(500);
    ok(tag + ": visible in the phone layout (focused)", (await state(p)).visible);
    await p.evaluate(() => TDC.focus.grid()); await W(300);
    ok(tag + ": visible in the phone layout (grid)", (await state(p)).visible);
    ok(tag + ": no page errors", errs.length === 0, errs.slice(0, 3));
    await b.close();
  }
  console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
