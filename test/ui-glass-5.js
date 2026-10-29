// ui-glass-5 (camera pill): the camera bar (#stageBar) is a short glass pill that never scrolls to pick a camera (icon-only chips, then two rows
// with the cameras on top; css/camera-pill.css + fitPill in js/focus.js). Drag its grip off the video and it floats anywhere in the window
// (prefs.cameraBar.dock = "float", a window-level layer like the floating map), remembered and kept on screen. It docks again when dropped on
// the dashed dock spot, on a double-tap / double-click of the grip, or with Enter on the grip (the arrow keys float and move it).
//   Playwright, BR=chromium|webkit (default both), mock footage (tools/make-mock-footage.py -> /tmp/ho-mock). Serves the repo on PORT (default 8815).
//   Devices: desktop 1440x900 (mouse), phone 390x844 and 844x390 (touch).
//   Checks: 1 pill: rounded, every camera chip fully shown (no scroll), grid and focus view; 2 touch targets >= 44 px;
//   3 camera picking is unchanged (chips, keys 1-6, All); 4 drag off the video -> floats (outside the video, dock spot shown while dragging,
//   prefs saved), cameras still pick while floating; 5 remembered after a reload; kept on screen when the window shrinks;
//   6 docks when dropped on the spot; 7 double-click / double-tap the grip docks; 8 keyboard (Enter floats / docks, arrows move, focus kept);
//   9 auto-hide (a floating pill hides with the controls and comes back); 10 glass modes (tinted, blur budget, none in Solid);
//   11 reduced motion; 12 no overlap (floating pill above the bottom controls, docked bar vs bottom bar, the floated map does not cover the bar);
//   13 beside-the-video dock: lifts off and docks back beside; 14 tap-redact picking ignores the floating pill; 15 no page errors.
//   SHOTS=dir PREFIX=before-|after- writes <prefix><dev>-docked.png, -floated.png (dragged outside the video) and, on phones, -map.png
//   (floated map + camera bar). ONLY_SHOTS=1 only writes the pictures (for "before": the old bar cannot leave the video).
const fs = require("fs"), path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", PORT = +(process.env.PORT || 8815), SHOTS = process.env.SHOTS || "", PREFIX = process.env.PREFIX || "", ONLY = process.env.ONLY_SHOTS === "1";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".onnx": "application/octet-stream", ".wasm": "application/wasm" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html"; fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; r.end(); return; } r.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }).listen(PORT, "127.0.0.1", () => res(s)); });
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const shot = async (p, n) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, PREFIX + n + ".png") }); } };
const R = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }, sel);
const X = (a, b) => !!a && !!b && a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
const ST = (p) => p.evaluate(() => { const b = document.getElementById("stageBar"), cb = TDC.prefs.cameraBar; return { dock: cb.dock, from: cb.from, float: cb.float, floating: b.classList.contains("bar-floating"), inStage: !!b.closest("#stage"), inBody: b.parentElement === document.body, cam: TDC.focus.cam || null, saved: (JSON.parse(localStorage.getItem("tdc.prefs.v1") || "{}").cameraBar || {}).dock }; });
const hasFloat = (p) => p.evaluate(() => typeof TDC.focus.floatBar === "function");
async function drag(p, from, to, peek) {
  await p.mouse.move(from[0], from[1]); await p.mouse.down(); const n = 14;
  for (let i = 1; i <= n; i++) { await p.mouse.move(from[0] + (to[0] - from[0]) * i / n, from[1] + (to[1] - from[1]) * i / n); await W(16); }
  await W(120); const got = peek ? await peek() : null; await p.mouse.up(); await W(400); return got;
}
async function open(p, keep) {
  await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1`, { waitUntil: "load" });
  if (!keep) { await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.prefs.v1"); localStorage.removeItem("tdc.regions.v1"); localStorage.removeItem("tdc.mbarOpen"); sessionStorage.clear(); }); await p.reload({ waitUntil: "load" }); }
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events.find((e) => e.cams.length === 6) || TDC.library.events[0]); }); await W(1800);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); TDC.setPref("autohide", "never"); document.getElementById("settings").hidden = true; TDC.player.seek(3); if (TDC.focus.dismissHint) TDC.focus.dismissHint(); }); await W(500);
}
// where to drop the grip so the pill lands outside the video: desktop = the black band above it, portrait = under it, landscape = the top edge
async function outsideTarget(p, dev) {
  const st = await R(p, "#stage"), g = await R(p, "#barGrip"), b = await R(p, "#stageBar");
  const gx = g.cx - b.l, gy = g.cy - b.t;   // grip offset inside the pill
  if (dev.w > dev.h && dev.touch) return [Math.max(gx + 10, 60), gy + 8];
  if (dev.touch) return [gx + 12, st.b + 14 + gy];
  return [st.cx - b.w / 2 + gx, st.t - 14 - b.h + gy];
}
const touchTargets = (p) => p.evaluate(() => { const bar = document.getElementById("stageBar"); return [...bar.querySelectorAll(".bar-grip, button")].filter((e) => e.getClientRects().length && getComputedStyle(e).display !== "none" && !e.closest("#barHint")).map((e) => { const r = e.getBoundingClientRect(); return { id: e.id || e.dataset.cam || e.className.split(" ")[0], w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; }).filter((t) => t.w < 43.5 || t.h < 43.5); });
const chipsShown = (p) => p.evaluate(() => { const bar = document.getElementById("stageBar"), sw = document.getElementById("camSwitch"), br = bar.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = innerHeight;
  const chips = [...sw.querySelectorAll(".cam-chip")].map((c) => { const r = c.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { cam: c.dataset.cam || "all", inBar: r.left >= br.left - 0.5 && r.right <= br.right + 0.5 && r.top >= br.top - 0.5 && r.bottom <= br.bottom + 0.5, onScreen: r.left >= -0.5 && r.right <= vw + 0.5 && r.top >= -0.5 && r.bottom <= vh + 0.5, hit: h === c || c.contains(h), w: r.width }; });
  return { n: chips.length, noScroll: sw.scrollWidth <= sw.clientWidth + 1 && sw.scrollLeft === 0, bad: chips.filter((c) => !c.inBar || !c.onScreen || !c.hit), radius: parseFloat(getComputedStyle(bar).borderTopLeftRadius), cls: bar.className, h: Math.round(br.height), w: Math.round(br.width) }; });

async function run(b, BR, dev) {
  const tag = BR + " " + dev.name, touch = dev.touch, land = dev.w > dev.h && touch;
  const ctx = await b.newContext({ viewport: { width: dev.w, height: dev.h }, isMobile: !!touch && BR === "chromium", hasTouch: !!touch, userAgent: touch ? UA : undefined, deviceScaleFactor: touch ? 2 : 1 });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await open(p);
  if (!touch) await p.mouse.move(dev.w - 5, dev.h - 120);
  await shot(p, dev.name + "-docked");
  if (ONLY) {
    const tgt = await outsideTarget(p, dev), g = await R(p, "#barGrip");
    await drag(p, [g.cx, g.cy], tgt); if (!touch) await p.mouse.move(dev.w - 5, dev.h - 120); await W(300);
    await shot(p, dev.name + "-floated");
    if (touch) { await p.evaluate(() => { if (TDC.focus.dockBar) TDC.focus.dockBar(true); else TDC.focus.resetBarPos(); TDC.setPref("mapDock", "float"); TDC.setPref("mapTiles", false); TDC.overlays.invalidate(); }); await W(900); await shot(p, dev.name + "-map"); }
    await ctx.close(); return;
  }
  // 1 pill, no scroll (grid and focus view)
  const c1 = await chipsShown(p);
  await p.evaluate(() => TDC.focus.focus("front")); await W(600);
  const c1f = await chipsShown(p);
  await p.evaluate(() => TDC.focus.grid()); await W(500);
  ok(tag + " 1 the camera bar is a pill and all 7 camera chips (All + 6) are fully shown and tappable, no scrolling (grid view)", c1.n === 7 && c1.noScroll && c1.bad.length === 0 && c1.radius >= 18, c1);
  ok(tag + " 1 the same in the focus view", c1f.n === 7 && c1f.noScroll && c1f.bad.length === 0, c1f);
  // 2 touch targets
  if (touch) { const t = await touchTargets(p); ok(tag + " 2 every camera-bar target is at least 44 x 44 px", t.length === 0, t); }
  // 3 camera picking unchanged
  const pick = await p.evaluate(async () => { const S = (ms) => new Promise((r) => setTimeout(r, ms)), o = {};
    document.querySelector('#camSwitch .cam-chip[data-cam="back"]').click(); await S(300); o.chipBack = TDC.focus.cam;
    o.on = document.querySelector('#camSwitch .cam-chip[data-cam="back"]').classList.contains("on");
    document.querySelector('#camSwitch .cam-chip.grid-chip').click(); await S(300); o.all = TDC.focus.cam || null; return o; });
  await p.keyboard.press("1"); await W(300); const k1 = await p.evaluate(() => TDC.focus.cam || null); await p.keyboard.press("Escape"); await W(300);
  ok(tag + " 3 camera picking is unchanged (tap a chip, All, key 1)", pick.chipBack === "back" && pick.on && pick.all === null && !!k1, { pick, k1 });
  // 4 drag off the video -> floats
  const can = await hasFloat(p);
  const st0 = await R(p, "#stage"), g0 = await R(p, "#barGrip"), tgt = await outsideTarget(p, dev);
  const mid = await drag(p, [g0.cx, g0.cy], tgt, () => p.evaluate(() => { const h = document.querySelector(".cam-dock-hint"); return { hint: !!h && !h.hidden && h.getClientRects().length > 0, dragging: document.getElementById("stageBar").classList.contains("dragging") }; }));
  if (!touch) await p.mouse.move(dev.w - 5, dev.h - 120);
  await W(300);
  const s4 = await ST(p), b4 = await R(p, "#stageBar"), vw = await p.evaluate(() => document.documentElement.clientWidth);
  const outside = land ? b4.t < st0.t && b4.b - st0.t < b4.h * 0.5 : !X(b4, st0);
  ok(tag + " 4 dragging the grip off the video floats the pill (window level, saved) with the dashed dock spot shown while dragging", can && s4.dock === "float" && s4.from === "over" && s4.floating && s4.inBody && s4.saved === "float" && s4.float.fx >= 0 && mid && mid.hint && mid.dragging, { can, s4, mid });
  ok(tag + " 4 the floated pill sits outside the video" + (land ? " (mostly: over the top bar; the video fills the height)" : "") + " and fully on screen", outside && b4.l >= 0 && b4.t >= 0 && b4.r <= vw + 0.5 && b4.b <= dev.h + 0.5, { b4, st0 });
  await shot(p, dev.name + "-floated");
  const c4 = await chipsShown(p);
  const fpick = await p.evaluate(async () => { document.querySelector('#camSwitch .cam-chip[data-cam="left_repeater"]').click(); await new Promise((r) => setTimeout(r, 300)); const a = TDC.focus.cam; document.querySelector("#camSwitch .grid-chip").click(); await new Promise((r) => setTimeout(r, 300)); return [a, TDC.focus.cam || null]; });
  ok(tag + " 4 floating: all chips shown and cameras still pick (left mirror, then All)", c4.bad.length === 0 && c4.noScroll && fpick[0] === "left_repeater" && fpick[1] === null, { c4, fpick });
  if (touch) { const t = await touchTargets(p); ok(tag + " 4 floating: targets still >= 44 px", t.length === 0, t); }
  // 5 remembered + kept on screen
  await open(p, true); if (!touch) await p.mouse.move(dev.w - 5, dev.h - 120); await W(300);
  const s5 = await ST(p), b5 = await R(p, "#stageBar");
  ok(tag + " 5 the floating spot is remembered after a reload", s5.floating && Math.abs(b5.l - b4.l) <= 3 && Math.abs(b5.t - b4.t) <= 3, { b4, b5, s5 });
  await p.setViewportSize({ width: Math.round(dev.w * 0.7), height: Math.round(dev.h * 0.8) }); await W(700);
  const b5s = await R(p, "#stageBar"), vw5 = await p.evaluate(() => [document.documentElement.clientWidth, innerHeight]);
  await p.setViewportSize({ width: dev.w, height: dev.h }); await W(700);
  ok(tag + " 5 a smaller window keeps the floating pill on screen", b5s.l >= 0 && b5s.t >= 0 && b5s.r <= vw5[0] + 0.5 && b5s.b <= vw5[1] + 0.5, { b5s, vw5 });
  // 6 dock on the spot
  const spot = await p.evaluate(() => { const st = document.getElementById("stage").getBoundingClientRect(); return { cx: st.left + st.width / 2, t: st.top }; });
  const g6 = await R(p, "#barGrip"), b6 = await R(p, "#stageBar");
  const near = await drag(p, [g6.cx, g6.cy], [spot.cx - b6.w / 2 + (g6.cx - b6.l), spot.t + (dev.w <= 760 ? 6 : 48) + (g6.cy - b6.t)], () => p.evaluate(() => { const h = document.querySelector(".cam-dock-hint"); return !!h && h.classList.contains("near"); }));
  const s6 = await ST(p);
  ok(tag + " 6 dropping it on the dashed spot docks it on the video again", near && s6.dock === "over" && !s6.floating && s6.inStage, { near, s6 });
  // 7 double-click / double-tap the grip docks
  await p.evaluate(() => TDC.focus.floatBar(true)); await W(300);
  const s7a = await ST(p), g7 = await R(p, "#barGrip");
  if (touch) { await p.touchscreen.tap(g7.cx, g7.cy); await W(120); await p.touchscreen.tap(g7.cx, g7.cy); } else await p.mouse.dblclick(g7.cx, g7.cy);
  await W(500); const s7 = await ST(p);
  ok(tag + " 7 a double-" + (touch ? "tap" : "click") + " on the grip docks the floating pill", s7a.floating && s7.dock === "over" && !s7.floating, { s7a, s7 });
  // 8 keyboard
  await p.evaluate(() => document.getElementById("barGrip").focus()); await p.keyboard.press("Enter"); await W(300);
  const k8a = await ST(p), r8a = await R(p, "#stageBar"), f8a = await p.evaluate(() => document.activeElement && document.activeElement.id);
  await p.keyboard.press("ArrowLeft"); await W(150); await p.keyboard.press("ArrowDown"); await W(200);
  const r8b = await R(p, "#stageBar");
  await p.keyboard.press("Enter"); await W(400);
  const k8c = await ST(p), f8c = await p.evaluate(() => document.activeElement && document.activeElement.id), lbl = await p.evaluate(() => document.getElementById("barGrip").getAttribute("role") + "|" + document.getElementById("barGrip").tabIndex);
  ok(tag + " 8 keyboard: Enter on the grip floats it (focus kept), arrows move it, Enter docks it again", k8a.floating && f8a === "barGrip" && (Math.abs(r8b.l - r8a.l) >= 8 || r8a.l <= 9) && (Math.abs(r8b.t - r8a.t) >= 8) && !k8c.floating && k8c.dock === "over" && f8c === "barGrip" && lbl === "button|0", { k8a, f8a, r8a, r8b, k8c, f8c, lbl });
  // 9 auto-hide (floating)
  await p.evaluate(() => { document.activeElement && document.activeElement.blur(); TDC.focus.floatBar(true); }); await W(300);
  await p.mouse.move(dev.w - 5, dev.h - 120);
  await p.evaluate(() => { TDC.setPref("autohide", "2"); TDC.player.seek(0.5); TDC.player.play(); TDC.autohide.wake(); });
  let gone = false; for (let i = 0; i < 50 && !gone; i++) { await W(100); gone = await p.evaluate(() => document.body.classList.contains("ah-gone")); }
  const ah = await p.evaluate(() => { const cs = getComputedStyle(document.getElementById("stageBar")); return { vis: cs.visibility, op: cs.opacity, pe: cs.pointerEvents, sel: TDC.autohide.isHidden(document.getElementById("stageBar")), why: TDC.autohide.why, playing: !!TDC.player.playing }; });
  // comes back: pause first (it never hides while paused, so the 2 s timer cannot race the check), wake, then wait for the fade-in to finish
  await p.evaluate(() => { TDC.player.pause(); TDC.autohide.wake(); });
  let back = null; for (let i = 0; i < 30; i++) { await W(100); back = await p.evaluate(() => { const cs = getComputedStyle(document.getElementById("stageBar")); return { vis: cs.visibility, op: cs.opacity }; }); if (back.vis === "visible" && +back.op > 0.9) break; }
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("autohide", "never"); TDC.autohide.wake(); }); await W(300);
  ok(tag + " 9 auto-hide: the floating pill hides with the controls (like the floating map) and comes back", gone && ah.vis === "hidden" && ah.sel && back.vis === "visible" && +back.op > 0.9, { gone, ah, back });
  // 10 glass modes (floating)
  const modes = {};
  for (const m of ["auto", "clear", "solid"]) { await p.evaluate((x) => { TDC.setPref("glass", x); TDC.glass.budget(); }, m); await W(300);
    modes[m] = await p.evaluate(() => { const e = document.getElementById("stageBar"), cs = getComputedStyle(e); const mm = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor), v = mm ? mm[1].split(",").map(parseFloat) : [0, 0, 0, 0]; return { a: v.length > 3 ? v[3] : 1, bf: cs.backdropFilter || cs.webkitBackdropFilter || "none", n: TDC.glass.blurred.length, sh: cs.boxShadow.length > 20, r: parseFloat(cs.borderTopLeftRadius) }; }); }
  await p.evaluate(() => TDC.setPref("glass", "auto")); await W(200);
  ok(tag + " 10 glass modes: the floating pill is tinted glass with a lifted shadow, blur within the budget (<= 3), none in Solid", ["auto", "clear", "solid"].every((m) => modes[m].a > 0 && modes[m].sh && modes[m].r >= 18 && modes[m].n <= 3) && modes.solid.bf === "none" && modes.clear.a <= modes.solid.a, modes);
  // 11 reduced motion
  await p.emulateMedia({ reducedMotion: "reduce" }); await W(200);
  const rm = await p.evaluate(() => { const g = document.querySelector(".cam-dock-hint"); return { bar: getComputedStyle(document.getElementById("stageBar")).transitionDuration, hint: g ? getComputedStyle(g).transitionDuration : "0s" }; });
  await p.emulateMedia({ reducedMotion: "no-preference" });
  ok(tag + " 11 reduced motion: no transition on the floating pill or the dock spot", rm.bar.split(",").every((d) => parseFloat(d) <= 0.011) && rm.hint.split(",").every((d) => parseFloat(d) <= 0.011), rm);
  // 12 no overlap: drag the floating pill to the very bottom -> it stays above the bottom controls
  const g12 = await R(p, "#barGrip");
  await drag(p, [g12.cx, g12.cy], [g12.cx, dev.h - 4]); if (!touch) await p.mouse.move(dev.w - 5, 5); await W(300);
  const ov = await p.evaluate(() => { const Rr = (e) => { if (!e || e.hidden || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1 ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null; };
    const Xx = (a, b) => !!a && !!b && a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5; const bar = Rr(document.getElementById("stageBar"));
    return { bar, hits: ["transport", "mbBar", "usBtn", "rdBtn", "chipCamBar", "btnFullscreen"].filter((id) => Xx(bar, Rr(document.getElementById(id)))) }; });
  ok(tag + " 12 the floating pill never covers the bottom controls (dragged to the bottom edge)", ov.hits.length === 0, ov);
  await p.evaluate(() => TDC.focus.dockBar(true)); await W(400);
  const ovd = await p.evaluate(() => { const Rr = (e) => { if (!e || e.hidden || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1 ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null; };
    const Xx = (a, b) => !!a && !!b && a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5; const bar = Rr(document.getElementById("stageBar"));
    return { bar, hits: ["transport", "mbBar", "usBtn", "rdBtn", "chipCamBar"].filter((id) => Xx(bar, Rr(document.getElementById(id)))), pageX: document.documentElement.scrollWidth <= innerWidth + 1 }; });
  ok(tag + " 12 the docked pill does not touch the bottom controls and the page does not scroll sideways", ovd.hits.length === 0 && ovd.pageX, ovd);
  await p.evaluate(() => { TDC.setPref("mapDock", "float"); TDC.overlays.invalidate(); }); await W(900);
  const mo = await p.evaluate(() => { const b = document.getElementById("stageBar"), m = document.querySelector(".map-panel.map-floating"); if (!m || m.hidden) return { noMap: true }; const br = b.getBoundingClientRect(), mr = m.getBoundingClientRect();
    const over = br.left < mr.right && mr.left < br.right && br.top < mr.bottom && mr.top < br.bottom;
    const pts = [...b.querySelectorAll(".cam-chip, .bar-grip, button")].filter((e) => e.getClientRects().length && getComputedStyle(e).display !== "none").map((e) => { const r = e.getBoundingClientRect(), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return h === e || e.contains(h); });
    return { over, allHit: pts.every(Boolean), br: [br.left, br.top, br.width, br.height].map(Math.round), mr: [mr.left, mr.top, mr.width, mr.height].map(Math.round) }; });
  if (touch) await shot(p, dev.name + "-map");
  ok(tag + " 12 the floated map never covers the camera bar" + (dev.w === 390 ? " (390 phone: it steps clear)" : ""), !mo.noMap && mo.allHit && (dev.w === 390 ? !mo.over : true), mo);
  await p.evaluate(() => TDC.setPref("mapDock", "over")); await W(400);
  // 13 beside-the-video dock (desktop: lifted upward over the top bar; since ui-glass-7 a pill pulled down onto the video docks below it, test/pill-dock.js)
  await p.evaluate(() => TDC.focus.setBarDock("beside", "top")); await W(500);
  const g13 = await R(p, "#barGrip"), st13 = await R(p, "#stage"), tg13 = land ? [st13.r + 60, st13.t + 60] : touch ? [g13.cx + 20, st13.b + 60] : [g13.cx - 100, Math.max(24, g13.cy - 70)];
  await drag(p, [g13.cx, g13.cy], tg13); await W(300);
  const s13 = await ST(p);
  await p.evaluate(() => TDC.focus.dockBar(true)); await W(500);
  const s13b = await p.evaluate(() => ({ dock: TDC.prefs.cameraBar.dock, inDock: !!document.getElementById("stageBar").closest("#barDock") }));
  await p.evaluate(() => TDC.focus.setBarDock("over")); await W(400);
  ok(tag + " 13 a pill docked beside the video lifts off when dragged away and docks back beside it", s13.floating && s13.from === "beside" && s13b.dock === "beside" && s13b.inDock, { s13, s13b });
  // 14 tap-redact picking: the floating pill lets taps through
  await p.evaluate(() => TDC.focus.floatBar(true)); await W(300);
  const pe = await p.evaluate(() => { document.body.classList.add("cr-picking"); const b = document.getElementById("stageBar"), r = b.getBoundingClientRect(), o = { pe: getComputedStyle(b).pointerEvents, chip: getComputedStyle(b.querySelector(".cam-chip")).pointerEvents }; document.body.classList.remove("cr-picking"); return o; });
  await p.evaluate(() => TDC.focus.dockBar(true)); await W(300);
  ok(tag + " 14 while picking a region (tap-redact) the floating pill takes no taps, as the docked one", pe.pe === "none" && pe.chip === "none", pe);
  ok(tag + " 15 no page errors", errs.length === 0, errs.slice(0, 3));
  await ctx.close();
}
(async () => {
  if (!fs.existsSync(FIX + "/TeslaCam")) execFileSync("python3", [path.join(ROOT, "tools/make-mock-footage.py"), FIX], { stdio: "inherit" });
  const srv = await server(); const pw = require("playwright");
  const DEVS = [{ name: "desktop-1440x900", w: 1440, h: 900, touch: 0 }, { name: "phone-390x844", w: 390, h: 844, touch: 1 }, { name: "phone-844x390", w: 844, h: 390, touch: 1 }];
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    let b;
    try { b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }); }
    catch (e) { console.log("SKIP " + BR + ": cannot launch (" + e.message.split("\n")[0] + ")"); continue; }
    for (const d of DEVS.filter((d) => !process.env.DEV || d.name.startsWith(process.env.DEV))) { try { await run(b, BR, d); } catch (e) { ok(BR + " " + d.name + " run threw: " + e.message.split("\n")[0], false); } }
    await b.close();
  }
  srv.close(); console.log(fails ? "FAILED " + fails : "ALL PASSED"); process.exit(fails ? 1 : 0);
})();
