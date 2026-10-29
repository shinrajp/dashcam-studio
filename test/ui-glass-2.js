// ui-glass-2 (tag ui-glass-2): auto-hiding controls while a video plays (js/autohide.js, css/autohide.css).
//   Playwright, BR=chromium|webkit (default both), mock footage (tools/make-mock-footage.py -> /tmp/ho-mock). Serves the repo on PORT (default 8812).
//   Desktop 1440x900 (mouse) and phone 390x844 (real touch: touchscreen.tap / CDP touch events).
//   Checks: 1 default 3 s, Settings ▸ Appearance ▸ Auto-hide shows 3 s; 2 paused: never hides; 3 playing: still shown at 2.4 s, hidden by ~3.6 s
//   (fades, lets taps through, then visibility: hidden), 2 px progress line at the bottom of the video, hidden pieces out of the blur budget,
//   no layout change; 4 coming back: mouse move / tap / key / focus; on touch the waking tap does nothing else (still playing, no tile enlarged);
//   5 holds: pointer held down, Settings, a dialog, Search/Redact panel, mobile sheet, text field focus, mouse over the camera bar, export running,
//   redaction draw bar (never hides); 6 floated map hides with the rest; 7 the pref: 2 s / 5 s / Never, saved, ?autohide= overrides without saving,
//   Reset all -> 3 s; 8 reduced motion: instant switch, no transition; 9 no page errors.
// Usage: BR=chromium|webkit node test/ui-glass-2.js    DEV=desktop|phone    SHOTS=dir
const fs = require("fs"), path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", PORT = +(process.env.PORT || 8812), SHOTS = process.env.SHOTS || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
const info = (n, x) => console.log("INFO " + n + " " + JSON.stringify(x).slice(0, 600));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".onnx": "application/octet-stream", ".wasm": "application/wasm" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html"; fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; r.end(); return; } r.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }).listen(PORT, "127.0.0.1", () => res(s)); });
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

async function open(p, q = "", fresh = true) {
  await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1${q}`, { waitUntil: "load" });
  if (fresh) { await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.prefs.v1"); localStorage.removeItem("tdc.regions.v1"); }); await p.reload({ waitUntil: "load" }); }
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events.find((e) => e.cams.length === 6) || TDC.library.events[0]); }); await W(1800);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); }); await W(300);
}
// play from the start with no input event (so only the timer can hide); restartable since the mock clip is ~12 s
const play = (p) => p.evaluate(() => { TDC.player.pause(); TDC.player.seek(0.5); TDC.player.play(); TDC.autohide.wake(); });
const S = (p) => p.evaluate(() => { const b = document.body, cs = (id) => { const e = document.getElementById(id); if (!e) return null; const c = getComputedStyle(e); return { o: +c.opacity, v: c.visibility, pe: c.pointerEvents }; };
  const l = document.getElementById("ahLine"), lr = l && l.getBoundingClientRect(), st = document.getElementById("stage").getBoundingClientRect();
  return { ah: b.dataset.ah, idle: b.classList.contains("idle"), gone: b.classList.contains("ah-gone"), why: TDC.autohide.why, mode: TDC.autohide.mode, pref: TDC.prefs.autohide, playing: TDC.player.playing,
    saved: (JSON.parse(localStorage.getItem("tdc.prefs.v1") || "{}") || {}).autohide, seg: [...document.querySelectorAll("#segAutohide button.on")].map((x) => x.dataset.v),
    bar: cs("stageBar"), tp: cs("transport"), line: l ? { o: +getComputedStyle(l).opacity, h: Math.round(lr.height), b: Math.round(lr.bottom), stB: Math.round(st.bottom), f: l.firstElementChild.style.transform } : null,
    blurred: (TDC.glass.blurred || []).map((e) => e.id || e.className.split(" ")[0]), cam: TDC.focus.cam || null }; });
const until = async (p, fn, ms) => { const t0 = Date.now(); let s; do { s = await S(p); if (fn(s)) return { s, t: Date.now() - t0 }; await W(100); } while (Date.now() - t0 < ms); return { s, t: -1 }; };
const RECTS = () => { const o = {}; document.querySelectorAll("[id]").forEach((e) => { if (!e.getClientRects().length || e.closest("details:not([open]) > :not(summary)")) return; const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return; o[e.id] = [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 2) / 2); }); return o; };
const center = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
const shot = async (p, n) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, n + ".png") }); } };

async function run(b, BR, dev) {
  const tag = BR + " " + dev.name, touch = dev.touch;
  const ctx = await b.newContext({ viewport: { width: dev.w, height: dev.h }, isMobile: !!touch && BR === "chromium", hasTouch: !!touch, userAgent: touch ? UA : undefined, deviceScaleFactor: touch ? 2 : 1 });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await open(p);
  if (!touch) await p.mouse.move(dev.w - 5, 5);   // park the mouse on the top bar corner (not over a control)
  // 1 default
  let s = await S(p);
  ok(tag + " 1 default: Auto-hide 3 s (Settings ▸ Appearance shows 3 s), controls shown", s.mode === "3" && s.pref === "3" && s.seg.join() === "3" && s.ah === "shown" && !!(await p.$("#appearSec #segAutohide")), s);
  // 2 paused never hides
  await W(3800); s = await S(p);
  ok(tag + " 2 paused: still shown after 3.8 s without input", !s.idle && s.why === "paused" && s.bar.v === "visible" && s.tp.o > 0.9, s);
  await shot(p, dev.name + "-paused-kept");
  // 3 playing: hides after 3 s
  const before = await p.evaluate(RECTS);
  await play(p); await W(2400); s = await S(p);
  ok(tag + " 3 playing: still shown at 2.4 s", !s.idle && s.playing, s);
  let r = await until(p, (x) => x.gone, 2500); await W(350); s = await S(p);   // let the .25 s fade finish (slow software rendering here)
  ok(tag + " 3 playing: hidden by ~3.6 s (camera bar + timeline fade, then visibility: hidden; taps go through)", r.t >= 0 && s.idle && s.bar.v === "hidden" && s.bar.pe === "none" && s.tp.v === "hidden" && s.tp.pe === "none" && s.bar.o < 0.05, s);
  ok(tag + " 3 a 2 px progress line shows at the bottom of the video", s.line && s.line.o > 0.9 && s.line.h === 2 && Math.abs(s.line.b - s.line.stB) <= 1 && /scaleX\(0\.[0-9]*[1-9]/.test(s.line.f), s.line);
  await W(300); s = await S(p);
  ok(tag + " 3 hidden controls are out of the blur budget", !s.blurred.includes("stageBar") && !s.blurred.includes("transport"), s.blurred);
  const after = await p.evaluate(RECTS), moved = Object.keys(before).filter((k) => after[k] && before[k].some((v, i) => Math.abs(v - after[k][i]) > 0.6) && !/^(ahLine|timeline|tl|hud|panel-|wb)/.test(k) && !/^(toolBubble|tbFan|tbMain|tbEvents|tbSettings|rdBtn|usBtn)$/.test(k));   // ui-glass-6: the tools bubble shrinks to a dot with a transform (no layout change)
  ok(tag + " 3 no layout change when the controls hide (same boxes for every element with an id)", moved.length === 0, moved.slice(0, 8));
  const hit = await p.evaluate(() => { const r = document.getElementById("stageBar").getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e ? (e.closest("#stageBar") ? "bar" : e.closest("#stage") ? "video" : e.tagName) : null; });
  ok(tag + " 3 the hidden camera bar does not block a tap on the video under it", hit === "video", hit);
  await shot(p, dev.name + "-hidden-progress-line");
  // 4 coming back
  if (!touch) {
    await p.mouse.move(dev.w / 2, dev.h / 3); await p.mouse.move(dev.w / 2 + 10, dev.h / 3 + 5); await W(80); s = await S(p);
    ok(tag + " 4 mouse move brings the controls back", !s.idle && !s.gone && s.bar.v === "visible", s);
    await shot(p, dev.name + "-visible-playing");
  } else {
    const cam0 = s.cam, pt = await center(p, "#grid");
    await p.touchscreen.tap(pt.x, pt.y); await W(350); s = await S(p);
    ok(tag + " 4 a real tap on the video brings the controls back and does nothing else (still playing, no camera enlarged)", !s.idle && s.playing && s.cam === cam0, s);
    await shot(p, dev.name + "-visible-playing");
    await p.touchscreen.tap(pt.x, pt.y); await W(350); s = await S(p);
    ok(tag + " 4 with the controls up, the next tap acts normally (enlarges that camera)", !!s.cam, s);
    await p.evaluate(() => TDC.focus.focus(null)); await W(200);
  }
  r = await until(p, (x) => x.gone, 4500);
  await p.keyboard.press("Shift"); await W(80); s = await S(p);
  ok(tag + " 4 a key press brings them back", r.t >= 0 && !s.idle, { t: r.t, s });
  await play(p); r = await until(p, (x) => x.gone, 4500);
  await p.evaluate(() => document.querySelector(".topbar button").focus()); await W(80); s = await S(p);
  ok(tag + " 4 focus moving (keyboard / screen reader) brings them back", r.t >= 0 && !s.idle && s.tp.v === "visible", { t: r.t, s });
  await p.evaluate(() => document.activeElement && document.activeElement.blur());
  // 5 holds: each kept for delay + 1 s while playing
  const hold = async (name, on, off, why) => {
    await play(p); await on(); await W(4000); const x = await S(p); await off(); await W(100);
    ok(tag + " 5 never hides while " + name, !x.idle && x.why === why && x.playing, x);
  };
  if (!touch) {
    await p.mouse.move(dev.w / 2, dev.h / 3);
    await hold("a pointer is held down (seeking / trimming / dragging)", () => p.mouse.down(), () => p.mouse.up(), "pointer-down");
    const bc = await center(p, "#stageBar");
    await hold("the mouse is over a control (camera bar)", () => p.mouse.move(bc.x, bc.y), () => p.mouse.move(dev.w - 5, 5), "camera-bar");
  } else {
    const c = await ctx.newCDPSession(p), pt = await center(p, "#grid");
    await hold("a finger is held down", () => c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: pt.x, y: pt.y }] }), () => c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }), "pointer-down");
    await hold("the bottom sheet is open", () => p.evaluate(() => TDC.mobileBar.setOpen(true)), () => p.evaluate(() => TDC.mobileBar.setOpen(false)), "sheet");
  }
  await hold("Settings is open", () => p.evaluate(() => { document.getElementById("settings").hidden = false; }), () => p.evaluate(() => { document.getElementById("settings").hidden = true; }), "settings");
  await hold("a dialog is open", () => p.evaluate(() => { document.getElementById("exportModal").hidden = false; }), () => p.evaluate(() => { document.getElementById("exportModal").hidden = true; }), "dialog");
  await hold("the Search / Redact panel is open", () => p.evaluate(() => document.getElementById("usBtn").click()), () => p.evaluate(() => { const b = document.querySelector("#usPanel [data-close], #usClose"); if (b) b.click(); else document.getElementById("usBtn").click(); }), "panel");
  await p.evaluate(() => { const u = document.getElementById("usPanel"); if (u && !u.hidden) { u.hidden = true; document.body.classList.remove("us-open"); } });
  await hold("a text field has focus", () => p.evaluate(() => { const i = document.createElement("input"); i.type = "text"; i.id = "ugText"; i.style.cssText = "position:fixed;left:0;top:0;width:40px;opacity:.01"; document.querySelector(".topbar").appendChild(i); i.focus(); }), () => p.evaluate(() => document.getElementById("ugText").remove()), "typing");
  await hold("an export is running", () => p.evaluate(() => { TDC.exporter.running = true; }), () => p.evaluate(() => { TDC.exporter.running = false; }), "export");
  await hold("drawing / picking for redaction (the draw bar never hides)", () => p.evaluate(() => { document.body.classList.add("cr-drawing", "cr-bar-on"); }), () => p.evaluate(() => { document.body.classList.remove("cr-drawing", "cr-bar-on"); }), "redact");
  const crNever = await p.evaluate(() => { const b = document.getElementById("crBar"); if (!b) return "no crBar"; const h = b.hidden; b.hidden = false; const c0 = getComputedStyle(b), pe0 = c0.pointerEvents; document.body.classList.add("idle", "ah-gone"); const c = getComputedStyle(b), out = { v: c.visibility, pe: c.pointerEvents, pe0, o: +c.opacity, inSel: TDC.autohide.isHidden(b) }; document.body.classList.remove("idle", "ah-gone"); b.hidden = h; return out; });
  ok(tag + " 5 the redaction draw bar is never part of the hidden set", crNever.v === "visible" && crNever.pe === crNever.pe0 && crNever.o > 0.9 && !crNever.inSel, crNever);
  // 6 floated map hides with the rest
  const fl = await p.evaluate(() => { TDC.setPref("mapDock", "float"); return new Promise((r) => setTimeout(() => r(!!document.querySelector(".map-panel.map-floating")), 400)); });
  if (fl) {
    await play(p); r = await until(p, (x) => x.gone, 4500);
    const m = await p.evaluate(() => { const e = document.querySelector(".map-panel.map-floating"), c = getComputedStyle(e); return { v: c.visibility, pe: c.pointerEvents }; });
    ok(tag + " 6 the floated map hides with the controls", r.t >= 0 && m.v === "hidden" && m.pe === "none", m);
    await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapDock", "over"); }); await W(300);
  } else ok(tag + " 6 map could be floated for the check", false);
  // 7 the pref
  await p.evaluate(() => { document.getElementById("settings").hidden = false; document.querySelector('#segAutohide [data-v="2"]').click(); document.getElementById("settings").hidden = true; }); await W(100);
  s = await S(p); ok(tag + " 7 picking 2 s saves the pref", s.pref === "2" && s.saved === "2" && s.seg.join() === "2", s);
  await play(p); r = await until(p, (x) => x.idle, 3200);
  ok(tag + " 7 2 s: hides after ~2 s", r.t >= 1500 && r.t <= 2800, { t: r.t });
  await p.evaluate(() => document.querySelector('#segAutohide [data-v="5"]').click()); await play(p); await W(4000); s = await S(p);
  r = await until(p, (x) => x.idle, 2600);
  ok(tag + " 7 5 s: still shown at 4 s, hidden by ~5.5 s", !s.idle && r.t >= 0, { s, t: r.t });
  await p.evaluate(() => document.querySelector('#segAutohide [data-v="never"]').click()); await play(p); await W(5500); s = await S(p);
  ok(tag + " 7 Never: still shown after 5.5 s of playing", !s.idle && s.why === "never" && s.pref === "never", s);
  await p.evaluate(() => TDC.player.pause());
  await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1&autohide=2`, { waitUntil: "load" }); await W(400);
  s = await p.evaluate(() => ({ mode: TDC.autohide.mode, pref: TDC.prefs.autohide, seg: [...document.querySelectorAll("#segAutohide button.on")].map((x) => x.dataset.v), note: document.getElementById("autohideNote").textContent }));
  ok(tag + " 7 ?autohide=2 overrides for this visit without saving", s.mode === "2" && s.pref === "never" && s.seg.join() === "2" && /autohide=/.test(s.note), s);
  await p.evaluate(() => document.getElementById("btnResetAll").click()); await W(300);
  s = await p.evaluate(() => ({ pref: TDC.prefs.autohide }));
  ok(tag + " 7 Reset all goes back to 3 s", s.pref === "3", s);
  // 8 reduced motion
  await p.emulateMedia({ reducedMotion: "reduce" });
  await open(p, "", false); if (!touch) await p.mouse.move(dev.w - 5, 5);
  await play(p); r = await until(p, (x) => x.idle, 4500); s = r.s;
  const tr = await p.evaluate(() => getComputedStyle(document.getElementById("transport")).transitionDuration);
  ok(tag + " 8 reduced motion: instant switch (hidden in the same step, no transition)", r.t >= 0 && s.gone && s.tp.v === "hidden" && tr.split(",").every((d) => parseFloat(d) === 0), { s, tr });
  await p.emulateMedia({ reducedMotion: "no-preference" });
  await p.evaluate(() => TDC.player.pause());
  ok(tag + " 9 no page errors", errs.length === 0, errs.slice(0, 3));
  await ctx.close();
}
(async () => {
  if (!fs.existsSync(FIX + "/TeslaCam")) execFileSync("python3", [path.join(ROOT, "tools/make-mock-footage.py"), FIX], { stdio: "inherit" });
  const srv = await server(); const pw = require("playwright");
  const DEVS = [{ name: "desktop-1440x900", w: 1440, h: 900, touch: 0 }, { name: "phone-390x844", w: 390, h: 844, touch: 1 }];
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    let b;
    try { b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }); }
    catch (e) { console.log("SKIP " + BR + ": cannot launch (" + e.message.split("\n")[0] + ")"); continue; }
    for (const d of DEVS.filter((d) => !process.env.DEV || d.name.startsWith(process.env.DEV))) { try { await run(b, BR, d); } catch (e) { ok(BR + " " + d.name + " run threw: " + e.message.split("\n")[0], false); } }
    await b.close();
  }
  srv.close(); console.log(fails ? "FAILED " + fails : "ALL PASSED"); process.exit(fails ? 1 : 0);
})();
