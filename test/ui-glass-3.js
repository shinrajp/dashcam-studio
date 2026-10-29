// ui-glass-3 (timeline and trim capsule): the full-width transport is drawn as one Liquid Glass capsule (css/capsule.css; on phones the slim
// playback row and the trim group in the pull-up sheet). Skin only: every box, the timeline geometry, seek and trim results are the same as with
// the capsule stylesheet switched off.
//   Playwright, BR=chromium|webkit (default both), mock footage (tools/make-mock-footage.py -> /tmp/ho-mock). Serves the repo on PORT (default 8813).
//   Devices: desktop 1440x900 (mouse), phone 390x844 and 844x390 (touch; Chromium uses CDP touch events for drags).
//   Checks: 1 capsule shape (radius, inset, pointer-events none); 2 no layout change vs the capsule off (every element with an id, --tp-h, tlGeom);
//   3 touch targets >= 44 px (bar, sheet, trim buttons, timeline); 4 seek + trim (edge drag, middle drag) give the same results with the capsule on/off;
//   5 auto-hide hides the capsule with the controls; 6 glass modes (Automatic / Clear / Solid, full-screen blur moves onto the capsule, budget <= 3);
//   7 reduced motion: no capsule transition; 8 floated map and camera bar still hit-testable, nothing under the capsule takes taps; 9 no page errors.
//   SHOTS=dir PREFIX=before-|after- writes <prefix><dev>-controls.png (+ -sheet.png on phones). ONLY_SHOTS=1 only writes the pictures (for "before").
const fs = require("fs"), path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", PORT = +(process.env.PORT || 8813), SHOTS = process.env.SHOTS || "", PREFIX = process.env.PREFIX || "", ONLY = process.env.ONLY_SHOTS === "1";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
const info = (n, x) => console.log("INFO " + n + " " + JSON.stringify(x).slice(0, 600));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".onnx": "application/octet-stream", ".wasm": "application/wasm" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html"; fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; r.end(); return; } r.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }).listen(PORT, "127.0.0.1", () => res(s)); });
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

async function open(p, q = "") {
  await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1${q}`, { waitUntil: "load" });
  await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.prefs.v1"); localStorage.removeItem("tdc.regions.v1"); sessionStorage.clear(); }); await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events.find((e) => e.cams.length === 6) || TDC.library.events[0]); }); await W(1800);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); TDC.setPref("autohide", "never"); const a = document.getElementById("advToggle"); if (!a.checked) { a.checked = true; a.dispatchEvent(new Event("change")); } document.getElementById("settings").hidden = true; }); await W(400);
  await p.evaluate(() => { TDC.ui.segs = []; TDC.ui.addSeg(1.5, 4); TDC.ui.addSeg(6.5, 9.5); TDC.player.seek(3); }); await W(500);
}
const capOff = (p, off) => p.evaluate((o) => { document.querySelectorAll('link[href*="capsule.css"]').forEach((l) => { l.disabled = o; }); window.dispatchEvent(new Event("resize")); }, off).then(() => W(400));
const RECTS = () => { const o = {}; document.querySelectorAll("[id]").forEach((e) => { if (!e.getClientRects().length) return; const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return; o[e.id] = [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 2) / 2); });
  const g = TDC.ui.tlGeom(); o["--tp-h"] = [getComputedStyle(document.documentElement).getPropertyValue("--tp-h")]; o["tlGeom"] = [g.left, g.top, g.w, g.h, g.scrubY, g.laneY].map((v) => (v == null ? v : Math.round(v * 2) / 2)); return o; };
const diff = (a, b) => Object.keys(a).concat(Object.keys(b)).filter((k, i, all) => all.indexOf(k) === i).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]) && !/^(ahLine|toast|tlTip)/.test(k));
// the capsule element: desktop = the transport's ::before; phones = the slim row's ::before (+ the trim group in the sheet)
const CAP = () => { const mb = document.body.classList.contains("mbar"), host = mb ? document.getElementById("mbRow") : document.getElementById("transport");
  const c = getComputedStyle(host, "::before"), hr = host.getBoundingClientRect(), tr = document.getElementById("transport").getBoundingClientRect();
  const l = parseFloat(c.left), t = parseFloat(c.top), w = parseFloat(c.width), h = parseFloat(c.height);
  return { mb, content: c.content, radius: parseFloat(c.borderTopLeftRadius), pe: c.pointerEvents, bg: c.backgroundColor, bgi: c.backgroundImage.slice(0, 40), bf: c.backdropFilter || c.webkitBackdropFilter || "none", vis: c.visibility, tr: c.transitionDuration,
    box: { l: hr.left + l, t: hr.top + t, r: hr.left + l + w, b: hr.top + t + h }, tp: { l: tr.left, t: tr.top, r: tr.right, b: tr.bottom }, vw: innerWidth, vh: innerHeight, glass: document.documentElement.dataset.glass, blurred: (TDC.glass.blurred || []).map((e) => e.id || e.className.split(" ")[0]) }; };
const alphaOf = (bg) => { const m = /rgba?\(([^)]+)\)/.exec(bg); if (!m) return 0; const v = m[1].split(",").map(parseFloat); return v.length > 3 ? v[3] : 1; };
const shot = async (p, n) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, PREFIX + n + ".png") }); } };
const segsNow = (p) => p.evaluate(() => TDC.ui.sortedSegs().map((s) => [Math.round(s.start * 1000) / 1000, Math.round(s.end * 1000) / 1000]).concat([[Math.round(TDC.player.time * 1000) / 1000]]));
const setSheet = (p, v) => p.evaluate((o) => { if (TDC.mobileBar && TDC.mobileBar.on) TDC.mobileBar.setOpen(o); }, v).then(() => W(450));

// a drag on the timeline: mouse on desktop; real touch events on phones (Chromium CDP; WebKit falls back to the mouse)
async function drag(p, ctx, BR, touch, x0, y, x1) {
  if (touch && BR === "chromium") {
    const c = await ctx.newCDPSession(p);
    await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
    for (let i = 1; i <= 8; i++) { await c.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + ((x1 - x0) * i) / 8, y }] }); await W(16); }
    await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await c.detach();
  } else { await p.mouse.move(x0, y); await p.mouse.down(); for (let i = 1; i <= 8; i++) { await p.mouse.move(x0 + ((x1 - x0) * i) / 8, y); await W(16); } await p.mouse.up(); }
  await W(250);
}
// seek + trim script: tap on the scrub band, drag S1's end handle +40 px, drag S2's middle -30 px. Returns sections + playhead after each step.
async function trimScript(p, ctx, BR, touch) {
  await p.evaluate(() => { TDC.ui.segs = []; TDC.ui.addSeg(1.5, 4); TDC.ui.addSeg(6.5, 9.5); TDC.player.seek(3); TDC.ui.tlReset(); }); await W(300);
  const g = await p.evaluate(() => { const g = TDC.ui.tlGeom(), s = TDC.ui.sortedSegs(); return { scrubY: g.scrubY, laneY: g.laneY, x: [g.x(5.2), g.x(s[0].end), g.x((s[1].start + s[1].end) / 2)] }; });
  const out = { g };
  if (touch && BR === "chromium") { const c = await ctx.newCDPSession(p); await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: g.x[0], y: g.scrubY }] }); await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await c.detach(); }
  else await p.mouse.click(g.x[0], g.scrubY);
  await W(250); out.seek = await segsNow(p);
  if (g.laneY == null) { out.lane = "off"; return out; }
  await drag(p, ctx, BR, touch, g.x[1], g.laneY, g.x[1] + 40); out.edge = await segsNow(p);
  await drag(p, ctx, BR, touch, g.x[2], g.laneY, g.x[2] - 30); out.move = await segsNow(p);
  return out;
}

async function run(b, BR, dev) {
  const tag = BR + " " + dev.name, touch = dev.touch;
  const ctx = await b.newContext({ viewport: { width: dev.w, height: dev.h }, isMobile: !!touch && BR === "chromium", hasTouch: !!touch, userAgent: touch ? UA : undefined, deviceScaleFactor: touch ? 2 : 1 });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await open(p);
  if (!touch) await p.mouse.move(dev.w - 5, 5);
  await shot(p, dev.name + "-controls");
  if (touch) { await setSheet(p, true); await shot(p, dev.name + "-sheet"); await setSheet(p, false); }
  if (ONLY) { await ctx.close(); return; }
  // 1 the capsule
  let c = await p.evaluate(CAP);
  const inset = c.box.l >= c.tp.l - 0.5 && c.box.r <= c.tp.r + 0.5 && c.box.t >= c.tp.t - 0.5 && c.box.b <= c.tp.b + 0.5 && (c.box.l > c.tp.l + 2 || c.mb);
  ok(tag + " 1 the transport is one glass capsule (rounded >= 18 px, inside the bar, takes no taps)", c.content !== "none" && c.radius >= 18 && c.pe === "none" && inset && alphaOf(c.bg) > 0.3, c);
  if (touch) {
    await setSheet(p, true);
    const t = await p.evaluate(() => { const e = document.getElementById("segBar"), cs = getComputedStyle(e); return { r: parseFloat(cs.borderTopLeftRadius), bg: cs.backgroundColor, sh: cs.boxShadow.slice(0, 60), shown: !!e.offsetParent }; });
    ok(tag + " 1 in the sheet the trim buttons sit in their own capsule", t.shown && t.r >= 18 && alphaOf(t.bg) > 0, t);
    await setSheet(p, false);
  }
  // 2 skin only
  for (const open of touch ? [false, true] : [false]) {
    await setSheet(p, open);
    const on = await p.evaluate(RECTS); await capOff(p, true); const off = await p.evaluate(RECTS); await capOff(p, false);
    const d = diff(on, off);
    ok(tag + " 2 no layout change from the capsule" + (touch ? (open ? " (sheet open)" : " (bar)") : "") + ": same box for every element with an id, same --tp-h and timeline geometry", d.length === 0, d.slice(0, 6).map((k) => [k, on[k], off[k]]));
  }
  await setSheet(p, false);
  // 3 touch targets
  if (touch) {
    for (const open of [false, true]) {
      await setSheet(p, open);
      const small = await p.evaluate(() => { const out = []; const scope = document.body.classList.contains("mb-open") || document.getElementById("transport").classList.contains("mb-open") ? "#transport" : "#mbBar";
        document.querySelectorAll(scope + " button, " + scope + " .timeline").forEach((e) => { if (!e.offsetParent || e.closest("[hidden]")) return; const cs = getComputedStyle(e); if (cs.visibility === "hidden" || cs.display === "none") return;
          const r = e.getBoundingClientRect(); if (r.width < 1) return; if (r.bottom < 0 || r.top > innerHeight) return; if (r.width < 43.5 || r.height < 43.5) out.push((e.id || e.className.split(" ")[0] || e.textContent.trim().slice(0, 12)) + " " + Math.round(r.width) + "x" + Math.round(r.height)); }); return out; });
      const trim = small.filter((s) => /^(btnAddSeg|btnSplitSeg|btnIn|btnOut|btnPlaySecs|btnDelSeg|btnClearSegs|btnPlay|btnBack|btnFwd|btnStop|mbMore|timeline|btnFullscreen)\b/.test(s));
      ok(tag + " 3 touch targets >= 44 px: play, frame step, trim buttons, ⌃ and the timeline" + (open ? " (sheet open)" : " (bar)"), trim.length === 0, trim);
      const other = small.filter((s) => !trim.includes(s)); if (other.length) info(tag + " 3 other buttons under 44 px (unchanged from base)", other);
    }
    await setSheet(p, false);
  }
  // 4 seek + trim: same results with the capsule on and off
  if (touch) await setSheet(p, true);
  const rOn = await trimScript(p, ctx, BR, touch); await capOff(p, true); const rOff = await trimScript(p, ctx, BR, touch); await capOff(p, false);
  const moved = rOn.edge && rOn.edge[0][1] > 4.05 && rOn.move && rOn.move[1][0] < 6.45;
  ok(tag + " 4 seek and trim (tap to seek, drag a section edge, drag a section) work and give identical results with the capsule on and off", JSON.stringify(rOn) === JSON.stringify(rOff) && rOn.seek[2][0] > 4.8 && rOn.seek[2][0] < 5.6 && moved, { on: rOn, off: rOff });
  if (touch) await setSheet(p, false);
  // 5 auto-hide
  if (!touch) await p.mouse.move(dev.w - 5, 5);
  await p.evaluate(() => { TDC.setPref("autohide", "2"); TDC.player.seek(0.5); TDC.player.play(); TDC.autohide.wake(); });
  let gone = false; for (let i = 0; i < 40 && !gone; i++) { await W(100); gone = await p.evaluate(() => document.body.classList.contains("ah-gone")); }
  c = await p.evaluate(CAP);
  const hidVis = await p.evaluate(() => getComputedStyle(document.getElementById("transport")).visibility);
  ok(tag + " 5 auto-hide: the capsule hides with the controls (visibility hidden, out of the blur budget)", gone && c.vis === "hidden" && hidVis === "hidden" && !c.blurred.includes("transport"), { gone, c, hidVis });
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("autohide", "never"); TDC.autohide.wake(); }); await W(400);
  // 6 glass modes
  const modes = {};
  for (const m of ["auto", "clear", "solid"]) { await p.evaluate((x) => TDC.setPref("glass", x), m); await W(250); const x = await p.evaluate(CAP); modes[m] = { a: alphaOf(x.bg), bf: x.bf, glass: x.glass }; }
  ok(tag + " 6 glass modes: Clear is more see-through than Solid, Solid has no blur and is near opaque", modes.clear.a < modes.solid.a && modes.solid.a >= 0.9 && modes.solid.bf === "none" && modes.solid.glass === "solid", modes);
  await p.evaluate(() => TDC.setPref("glass", "auto")); await W(200);
  const fsr = await p.evaluate(async () => { document.body.classList.add("fs"); window.dispatchEvent(new Event("resize")); await new Promise((r) => setTimeout(r, 300)); TDC.glass.budget();
    const tp = document.getElementById("transport"), host = document.body.classList.contains("mbar") ? document.getElementById("mbRow") : tp, own = getComputedStyle(tp), cap = getComputedStyle(host, "::before");
    const out = { blurred: TDC.glass.blurred.map((e) => e.id || e.className.split(" ")[0]), own: own.backdropFilter || own.webkitBackdropFilter || "none", cap: cap.backdropFilter || cap.webkitBackdropFilter || "none", tpBg: own.backgroundColor, n: TDC.glass.blurred.length };
    document.body.classList.remove("fs"); window.dispatchEvent(new Event("resize")); await new Promise((r) => setTimeout(r, 300)); TDC.glass.budget(); return out; });
  const fsOk = fsr.n <= 3 && (!fsr.blurred.includes("transport") || (/blur/.test(fsr.cap) && !/blur/.test(fsr.own)));
  ok(tag + " 6 full screen: when the transport gets blur it is on the capsule only (not the whole bar), budget <= 3", fsOk, fsr);
  // 7 reduced motion
  await p.emulateMedia({ reducedMotion: "reduce" }); await W(200);
  c = await p.evaluate(CAP);
  ok(tag + " 7 reduced motion: the capsule has no transition", c.tr.split(",").every((d) => parseFloat(d) <= 0.001), c.tr);
  await p.emulateMedia({ reducedMotion: "no-preference" });
  // 8 floated map + camera bar
  const hit = await p.evaluate(async () => {
    const at = (e) => { if (!e || e.hidden) return "none"; const r = e.getBoundingClientRect(); if (r.width < 2) return "none"; const h = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 12)); return h && (h === e || e.contains(h)) ? "ok" : h ? (h.id || h.className || h.tagName) : null; };
    const tl = document.getElementById("timeline"), sb = document.getElementById("stageBar");
    const out = { timeline: at(tl), stageBar: at(sb), play: at(document.getElementById("btnPlay")) };
    TDC.setPref("mapDock", "float"); await new Promise((r) => setTimeout(r, 500));
    out.map = at(document.querySelector(".map-panel.map-floating")); out.timeline2 = at(tl); out.play2 = at(document.getElementById("btnPlay"));
    TDC.setPref("mapDock", "over"); await new Promise((r) => setTimeout(r, 300)); return out; });
  ok(tag + " 8 the timeline, play button, camera bar and floated map still take their own taps", hit.timeline === "ok" && hit.stageBar === "ok" && hit.play === "ok" && hit.timeline2 === "ok" && hit.play2 === "ok" && (hit.map === "ok" || hit.map === "none"), hit);
  ok(tag + " 9 no page errors", errs.length === 0, errs.slice(0, 3));
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
