// ui-glass-12 (iPhone 17 Pro Max feedback on ui-glass-11):
//   1  demo glass (labs/glass-sdf v5): clear and bright everywhere — every refraction piece gets the demo's light tint (0.22, no
//      video-following dark tint), the demo strength / blur; text stays readable with a halo (text-shadow); stale tuning prefs are IGNORED
//      unless Debug is on; in Debug the tuning (tint, strength) and the old adaptive tint apply
//   2  the floated camera pill drags all the way to the window's bottom edge (past the bottom controls, riding above them, grip on top)
//      and still docks back (drag to the dock spot, and Enter on the grip) — 430x932, 932x430, 1440x900
//   3  full screen with one camera: the camera pill shrinks to a small corner button; nothing covers the car view or the white-balance
//      readout / button (no overlap with the pill, the capsules, the Search strip); the button opens the pill for the visit (nothing saved)
//      and shrinks it again — 430x932, 932x430, 1440x900
//   4  Debug mode: off by default (technical controls hidden), Settings ▸ Advanced & Labs ▸ Debug mode switch (saved), ?debug=1 / ?debug=0
//      win for the visit (switch disabled, note), the perf overlay, manual white balance (K), prefs.advanced always matches body.simple
//   5  no page errors
//   Playwright, BR=chromium|webkit (default both), mock footage (/tmp/ho-mock, /tmp/photo-mock). PORT (default 8832). ROOT=dir serves another checkout.
const fs = require("fs"), path = require("path"), http = require("http");
const ROOT = process.env.ROOT || path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", FIXP = process.env.FIXP || "/tmp/photo-mock", PORT = +(process.env.PORT || 8832);
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".onnx": "application/octet-stream", ".wasm": "application/wasm" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html"; fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; r.end(); return; } r.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }).listen(PORT, "127.0.0.1", () => res(s)); });
async function open(p, q, prefs, fix) {
  await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1${q || ""}`, { waitUntil: "load" });
  await p.evaluate((pr) => { localStorage.clear(); localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.setItem("tdc.prefs.v1", JSON.stringify(Object.assign({ autohide: "never" }, pr || {}))); sessionStorage.clear(); }, prefs || null);
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", (fix || FIX) + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events.find((e) => e.cams.length === 6) || TDC.library.events[0]); }); await W(1500);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); document.getElementById("settings").hidden = true; if (TDC.focus && TDC.focus.dismissHint) TDC.focus.dismissHint(); }); await W(900);
}
async function drag(p, from, to, peek) {
  await p.mouse.move(from[0], from[1]); await p.mouse.down(); const n = 14;
  for (let i = 1; i <= n; i++) { await p.mouse.move(from[0] + (to[0] - from[0]) * i / n, from[1] + (to[1] - from[1]) * i / n); await W(16); }
  await W(120); const got = peek ? await peek() : null; await p.mouse.up(); await W(400); return got;
}
const R = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }, sel);
const GLASS = () => { const R_ = TDC.refract; return { on: R_.on, tune: R_.tune(), demo: R_.DEMO, pieces: R_.pieces.map((x) => ({ id: x.host.id || x.host.className.split(" ")[0], a: x.host._rft && +x.host._rft.a.toFixed(3), demo: !!(x.host._rft && x.host._rft.demo),
  // text: a text-shadow halo; icons: an svg drop-shadow (light / active buttons excepted, like the demo)
  halo: (() => { const lit = (e) => !!e.closest(".on, .active, [aria-pressed='true'], [aria-checked='true'], .primary, input, select");
    const txt = [...x.host.querySelectorAll("*")].filter((e) => e.getClientRects().length && !lit(e) && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
    const svg = [...x.host.querySelectorAll("svg")].filter((e) => e.getClientRects().length && !lit(e));
    return txt.length + svg.length > 0 && txt.every((e) => getComputedStyle(e).textShadow !== "none") && svg.every((e) => /drop-shadow/.test(getComputedStyle(e).filter)); })() })) }; };
// rects of what must stay clear in full screen
const FS = () => { const V = (e) => !!e && !e.hidden && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden" && +getComputedStyle(e).opacity > 0.05;
  const Rr = (id) => { const e = document.getElementById(id); if (!V(e)) return null; const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1 ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null; };
  const X = (a, b) => !!a && !!b && a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
  const keep = { car: Rr("carView"), wbr: Rr("wbReadout"), chipWb: Rr("chipWb") }, cover = { bar: Rr("stageBar"), restore: Rr("btnBarRestore"), transport: Rr("transport"), mb: Rr("mbBar"), us: Rr("usStrip"), bubble: Rr("toolBubble"), eye: Rr("tgEye") };
  const EL = { car: "carView", wbr: "wbReadout", chipWb: "chipWb", bar: "stageBar", restore: "btnBarRestore", transport: "transport", mb: "mbBar", us: "usStrip", bubble: "toolBubble", eye: "tgEye" };
  const inside = (k, c) => { const a = document.getElementById(EL[k]), b = document.getElementById(EL[c]); return !!a && !!b && b.contains(a); };   // (the WB button is part of the bottom capsule)
  const hits = []; for (const [k, a] of Object.entries(keep)) for (const [c, b] of Object.entries(cover)) if (X(a, b) && !inside(k, c)) hits.push(k + "×" + c);
  if (X(keep.car, keep.wbr)) hits.push("car×wbr");
  const inView = (a) => !a || (a.l >= -1 && a.t >= -1 && a.r <= innerWidth + 1 && a.b <= innerHeight + 1);
  const rb = document.getElementById("btnBarRestore");
  return { fs: document.body.classList.contains("fs"), mini: document.body.classList.contains("fs-mini"), rbMini: !!rb && rb.classList.contains("fs-mini") && V(rb), keep, cover, hits, inView: Object.values(keep).every(inView), barOn: TDC.prefs.cameraBar.on, fsOpen: TDC.focus.fsOpen, savedOn: ((JSON.parse(localStorage.getItem("tdc.prefs.v1") || "{}").cameraBar) || {}).on }; };

async function run(b, BR) {
  const mk = async (vw, vh, touch) => { const ctx = await b.newContext({ viewport: { width: vw, height: vh }, ...(touch ? { hasTouch: true, isMobile: BR === "chromium" } : {}) });
    const p = await ctx.newPage(); p._errs = []; p.on("pageerror", (e) => p._errs.push(e.message)); return { ctx, p }; };
  // ---------- 1 demo glass + 4 Debug (430x932 touch and 1440x900) ----------
  for (const [vw, vh, touch] of [[1440, 900, false], [430, 932, true]]) {
    const T = `${BR} ${vw}x${vh}`;
    // stale tuning saved with Debug off: ignored
    let { ctx, p } = await mk(vw, vh, touch);
    await open(p, "", { tune: { rfStr: 2.2, rfTint: 0.7, rfBlur: 9, rfAdaptive: true, liteFps: 55, perfHud: true, wbK: 3000, wbTint: 20 } });
    let g = await p.evaluate(GLASS);
    ok(T + " 1 demo glass: refraction on, every piece the demo tint 0.22 (no video-following tint), demo strength / blur", g.on && g.pieces.length >= 2 && g.pieces.every((x) => x.a === 0.22 && x.demo) && g.tune.str === g.demo.str && g.tune.blur === g.demo.blur && g.tune.tint === 0.22, g);
    ok(T + " 1 text and icons on the glass have the demo's halo (text-shadow / drop-shadow)", g.pieces.every((x) => x.halo), g.pieces);
    let d = await p.evaluate(() => { const vis = (s) => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0; }; document.getElementById("settings").hidden = false; TDC.settings.show("advanced");
      return { on: TDC.debugOn(), cls: document.documentElement.classList.contains("debug-on"), toggle: vis("#debugToggle"), tune: vis("#dbgTune"), calib: vis("#calibSec"), models: vis("#setModelsSec"), adv: vis("#recogAdv"), wbK: vis("#wbK"), hud: vis("#perfHud"), manual: TDC.wb.manual(), slow: TDC.refract.SLOW, simple: document.body.classList.contains("simple") }; });
    ok(T + " 4 Debug is off by default: the switch shows, the tuning / calibration / models / recognition internals / WB Kelvin are hidden, stale prefs ignored (no perf overlay, no manual WB, Lite at 40 fps)", !d.on && !d.cls && d.toggle && !d.tune && !d.calib && !d.models && !d.adv && !d.wbK && !d.hud && d.manual === null && d.slow === 40 && d.simple, d);
    // turn it on with the real switch
    await p.click("#debugToggle"); await W(500);
    d = await p.evaluate(() => { const vis = (s) => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0; }; return { on: TDC.debugOn(), saved: JSON.parse(localStorage.getItem("tdc.prefs.v1")).debug, cls: document.documentElement.classList.contains("debug-on"), tune: vis("#dbgTune"), models: vis("#setModelsSec"), hud: vis("#perfHud"), manual: TDC.wb.manual(), slow: TDC.refract.SLOW, t: TDC.refract.tune(), a: TDC.refract.pieces.map((x) => !!(x.host._rft && x.host._rft.demo)) }; });
    ok(T + " 4 the Debug mode switch turns it on (saved), shows the tuning and the model picker, and the saved tuning now applies (perf overlay, manual WB, Lite fps, adaptive tint)", d.on && d.saved === true && d.cls && d.tune && d.models && d.hud && d.manual && d.manual.k === 3000 && d.slow === 55 && d.t.tint === 0.7 && d.a.every((x) => x === false), d);
    await W(1200); const hud = await p.evaluate(() => (document.getElementById("perfHud") || {}).textContent || "");
    ok(T + " 4 the perf overlay shows fps and the refraction time", /\d+ fps/.test(hud) && /refraction|frosted/.test(hud), hud);
    await p.evaluate(() => { TDC.wb.set(true); }); await W(600);
    const wbt = await p.evaluate(() => ({ cur: TDC.wb.current(), text: TDC.wb.text() }));
    ok(T + " 4 Debug ▸ colour temperature 3000 K sets the viewer's white balance (Manual)", wbt.cur && wbt.cur.manual && wbt.cur.cct === 3000 && /3000 K/.test(wbt.text), wbt);
    // Debug tuning sliders
    await p.evaluate(() => { const i = document.getElementById("dbgRfAdaptive"); if (i.checked) i.click(); const t = document.getElementById("dbgRfTint"); t.value = "0.4"; t.dispatchEvent(new Event("input", { bubbles: true })); }); await W(500);
    g = await p.evaluate(GLASS);
    ok(T + " 4 Debug ▸ Glass tint 40 % (adaptive off) tints every piece 0.4", g.pieces.length >= 2 && g.pieces.every((x) => x.a === 0.4 && x.demo), g);
    // advanced pref: body.simple follows it whoever sets it, no drawing error
    const adv = await p.evaluate(async () => { const r = []; for (const v of [true, false, true, false]) { TDC.setPref("advanced", v); await new Promise((f) => setTimeout(f, 120)); if (TDC.ui.drawTimeline) TDC.ui.drawTimeline(); r.push(document.body.classList.contains("simple") === !v && document.getElementById("advToggle").checked === v); } return r; });
    ok(T + " 4 prefs.advanced set from code always matches body.simple and the switch (the old Advanced bug), the timeline still draws", adv.every(Boolean), adv);
    // switching Debug off: hides it all again and the stale tuning is ignored again
    await p.evaluate(() => { document.getElementById("settings").hidden = false; TDC.settings.show("advanced"); }); await W(200);
    await p.click("#debugToggle"); await W(500);
    d = await p.evaluate(() => ({ on: TDC.debugOn(), cls: document.documentElement.classList.contains("debug-on"), hud: !!document.getElementById("perfHud") && !document.getElementById("perfHud").hidden, manual: TDC.wb.manual(), cur: TDC.wb.current(), a: TDC.refract.pieces.map((x) => x.host._rft && x.host._rft.a), slow: TDC.refract.SLOW }));
    ok(T + " 4 Debug off again: simple, the tuning is ignored (demo tint, no overlay, no manual WB, Lite 40 fps)", !d.on && !d.cls && !d.hud && d.manual === null && !(d.cur && d.cur.manual) && d.a.every((x) => x === 0.22) && d.slow === 40, d);
    // Debug-off fit: each group still fits without scrolling
    const fit = await p.evaluate(async () => { const out = []; for (const g of ["playback", "appearance", "overlays", "redact", "export", "advanced", "keys"]) { TDC.settings.show(g); await new Promise((f) => setTimeout(f, 120)); const b = document.querySelector("#settings .drawer-body"); out.push({ g, ok: b.scrollHeight <= b.clientHeight + 2, sh: b.scrollHeight, ch: b.clientHeight }); } return out; });
    ok(T + " 4 with Debug off every Settings group fits without scrolling", fit.every((f) => f.ok), fit);
    ok(T + " 5 no page errors", p._errs.length === 0, p._errs);
    await ctx.close();
    // ?debug=1 / ?debug=0 win for the visit
    ({ ctx, p } = await mk(vw, vh, touch));
    await open(p, "&debug=1", { debug: false });
    d = await p.evaluate(() => { document.getElementById("settings").hidden = false; TDC.settings.show("advanced"); const t = document.getElementById("debugToggle"); return { on: TDC.debugOn(), dis: t.disabled, chk: t.checked, note: document.getElementById("debugNote").textContent, pref: TDC.prefs.debug }; });
    ok(T + " 4 ?debug=1 turns it on for the visit (switch disabled, with a note), the saved pref is untouched", d.on && d.dis && d.chk && /debug=/.test(d.note) && d.pref === false, d);
    await open(p, "&debug=0", { debug: true });
    d = await p.evaluate(() => ({ on: TDC.debugOn(), cls: document.documentElement.classList.contains("debug-on"), pref: TDC.prefs.debug }));
    ok(T + " 4 ?debug=0 wins over a saved Debug on", !d.on && !d.cls && d.pref === true, d);
    ok(T + " 5 no page errors (?debug)", p._errs.length === 0, p._errs);
    await ctx.close();
  }
  // ---------- 2 pill to the bottom edge, 3 full screen ----------
  for (const [vw, vh, touch] of [[430, 932, true], [932, 430, true], [1440, 900, false]]) {
    const T = `${BR} ${vw}x${vh}`;
    let { ctx, p } = await mk(vw, vh, touch);
    await open(p);
    await p.evaluate(() => TDC.focus.setBarDock("float")); await W(500);
    const g0 = await R(p, "#barGrip");
    await drag(p, [g0.cx, g0.cy], [g0.cx, vh - 3]); if (!touch) await p.mouse.move(vw - 5, 5); await W(300);
    const s2 = await p.evaluate(() => { const b = document.getElementById("stageBar"), r = b.getBoundingClientRect(), g = document.getElementById("barGrip").getBoundingClientRect(), top = document.elementFromPoint(g.left + g.width / 2, g.top + g.height / 2);
      return { dock: TDC.prefs.cameraBar.dock, b: r.bottom, H: innerHeight, deep: b.classList.contains("bar-deep"), gripTop: !!(top && top.closest("#stageBar")), inView: r.bottom <= innerHeight + 1 && r.top >= 0 }; });
    ok(T + " 2 the floated pill drags all the way to the bottom edge, rides above the bottom controls (grip on top), stays on screen", s2.dock === "float" && s2.b >= s2.H - 12 && s2.deep && s2.gripTop && s2.inView, s2);
    // docks back: drag the grip onto the dashed dock spot
    const g1 = await R(p, "#barGrip"), b1 = await R(p, "#stageBar");
    await p.mouse.move(g1.cx, g1.cy); await p.mouse.down(); for (let i = 1; i <= 8; i++) { await p.mouse.move(g1.cx, g1.cy - i * 20); await W(16); }
    const spot = await R(p, ".cam-dock-hint");
    let near = false;
    if (spot) { const tx = spot.cx - b1.w / 2 + (g1.cx - b1.l), ty = spot.t + (vw <= 760 ? 6 : 48) + (g1.cy - b1.t), sx = g1.cx, sy = g1.cy - 160;
      for (let i = 1; i <= 14; i++) { await p.mouse.move(sx + (tx - sx) * i / 14, sy + (ty - sy) * i / 14); await W(16); }
      await W(120); near = await p.evaluate(() => { const h = document.querySelector(".cam-dock-hint"); return !!h && h.classList.contains("near"); }); }
    await p.mouse.up(); await W(500);
    let s = await p.evaluate(() => ({ dock: TDC.prefs.cameraBar.dock, deep: document.getElementById("stageBar").classList.contains("bar-deep") }));
    if (!near) { // the spot is hard to hit on a short landscape phone: Enter on the grip docks it too
      await p.evaluate(() => TDC.focus.setBarDock("float")); await W(300); await p.focus("#barGrip"); await p.keyboard.press("Enter"); await W(500);
      s = await p.evaluate(() => ({ dock: TDC.prefs.cameraBar.dock, deep: document.getElementById("stageBar").classList.contains("bar-deep"), viaKey: true })); }
    ok(T + " 2 it still docks back (dragged onto the dock spot" + (near ? "" : ", or Enter on the grip") + ") and loses bar-deep", s.dock !== "float" && !s.deep, { s, near, spot: !!spot });
    ok(T + " 5 no page errors (pill)", p._errs.length === 0, p._errs);
    await ctx.close();
    // 3 full screen, one camera, car view + white balance on (photo mock)
    ({ ctx, p } = await mk(vw, vh, touch));
    await open(p, "", { carView: true }, FIXP);
    await p.evaluate(() => { TDC.focus.focus("front"); TDC.wb.set(true); }); await W(500);
    await p.evaluate(() => TDC.focus.fullscreen(true)); await W(1300);
    let f = await p.evaluate(FS);
    ok(T + " 3 full screen, one camera: the pill shrinks to the corner camera button (prefs untouched)", f.fs && f.mini && f.rbMini && !f.cover.bar && f.barOn === true, f);
    ok(T + " 3 nothing covers the car view or the white-balance readout / button, all on screen", f.keep.car && (f.keep.wbr || f.keep.chipWb) && f.hits.length === 0 && f.inView, f);
    await p.click("#btnBarRestore"); await W(500);
    f = await p.evaluate(FS);
    ok(T + " 3 the corner button opens the camera pill for this visit (nothing saved)", f.fsOpen && !f.mini && !!f.cover.bar && f.barOn === true && f.savedOn !== false, f);
    await p.evaluate(() => TDC.focus.setBar(false)); await W(400);
    f = await p.evaluate(FS);
    ok(T + " 3 its hide shrinks it back to the corner button; leaving full screen brings the normal pill back", f.mini && !f.cover.bar, f);
    await p.evaluate(() => TDC.focus.fullscreen(false)); await W(800);
    f = await p.evaluate(() => ({ fs: document.body.classList.contains("fs"), mini: document.body.classList.contains("fs-mini"), bar: !document.getElementById("stageBar").hidden && document.getElementById("stageBar").getClientRects().length > 0, on: TDC.prefs.cameraBar.on }));
    ok(T + " 3 out of full screen: the pill is back as before", !f.fs && !f.mini && f.bar && f.on === true, f);
    ok(T + " 5 no page errors (full screen)", p._errs.length === 0, p._errs);
    await ctx.close();
  }
}
(async () => {
  const pw = require("playwright"); const s = await server();
  for (const BR of (process.env.BR || "chromium,webkit").split(",")) {
    const b = BR === "chromium" ? await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] }) : await pw.webkit.launch();
    try { await run(b, BR); } catch (e) { ok(BR + " run", false, String(e && e.stack || e)); }
    await b.close();
  }
  s.close(); console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})();
