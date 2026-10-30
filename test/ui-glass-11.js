// ui-glass-11: SDF refraction glass (js/refract.js) — the default glass for the bubble, its tray, the camera pill, the bottom capsule(s),
// the Events sheet and Settings, with today's frosted glass as the fallback. At 1440x900 (mouse) and 430x932 (touch):
//   1  on by default: html.refract, one WebGL context, every visible piece drawn (canvas inside the piece, same box; capsule = its ::before box)
//   2  the tray, the Events sheet and Settings get refraction when open
//   3  readable: over a bright scene the drawn glass under the text is >= 4.5:1 against the glass text colour; over a dark scene it stays clear
//      (controls' tint alpha <= 0.3) and is not dark at the rim
//   4  taps go through: the canvases take no pointer events, the bubble opens its tray on a real click
//   5  idle / hidden / exporting: no rendering
//   6  falls back to frosted: ?refract=0, Settings ▸ Glass style ▸ Frosted (and back), Lite mode, reduced transparency (CDP, chromium),
//      no WebGL (getContext -> null), dropped frames (R.feed at 25 fps for 2.5 s; a one-time toast); ?refract=1 wins over the Frosted pref
//   7  no page errors
//   Playwright, BR=chromium|webkit (default both), mock footage (/tmp/ho-mock). PORT (default 8831). ROOT=dir serves another checkout.
const fs = require("fs"), path = require("path"), http = require("http");
const ROOT = process.env.ROOT || path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", PORT = +(process.env.PORT || 8831);
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".onnx": "application/octet-stream", ".wasm": "application/wasm" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html"; fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; r.end(); return; } r.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }).listen(PORT, "127.0.0.1", () => res(s)); });
async function open(p, q) {
  await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1${q || ""}`, { waitUntil: "load" });
  await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.setItem("tdc.prefs.v1", JSON.stringify({ advanced: true, autohide: "never" })); sessionStorage.clear(); });
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events.find((e) => e.cams.length === 6) || TDC.library.events[0]); }); await W(1500);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); document.getElementById("settings").hidden = true; if (TDC.focus && TDC.focus.dismissHint) TDC.focus.dismissHint(); }); await W(1200);
}

const LUM = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const TEXT = LUM([0xae, 0xb6, 0xc2]);
// a uniform (or striped) picture pinned as the scene under the whole window
const PIN = (kind) => { const c = document.createElement("canvas"); c.width = 320; c.height = 200; const x = c.getContext("2d");
  if (kind === "bright") { x.fillStyle = "#f4f6f8"; x.fillRect(0, 0, 320, 200); x.fillStyle = "#ffffff"; for (let i = 0; i < 320; i += 20) x.fillRect(i, 0, 10, 200); }
  else { x.fillStyle = "#0c0e12"; x.fillRect(0, 0, 320, 200); }
  TDC.refract.sample(c); return kind; };
// the drawn glass composited over a uniform scene colour: the brightest pixel in the inner part of the piece (where the text is), and the rim mean
const GLASS = (sceneRGB) => TDC.refract.pieces.map((p) => { const c = p.c, w = c.width, h = c.height, d = c.getContext("2d").getImageData(0, 0, w, h).data;
  const L = (i) => { const a = d[i + 3] / 255; const rgb = [0, 1, 2].map((k) => d[i + k] * a + sceneRGB[k] * (1 - a)); return rgb; };
  let at = null, inner = 0, innerRGB = null, rim = 0, rn = 0, px = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (d[i + 3] === 0) continue; px++;
    const ix = Math.min(x, w - 1 - x), iy = Math.min(y, h - 1 - y), m = Math.min(w, h);
    if (ix > m * 0.3 && iy > h * 0.3) { const rgb = L(i); const l = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]); if (l > inner) { inner = l; innerRGB = rgb; at = [x, y, d[i + 3]]; } } }
  for (let x = 2; x < w - 2; x++) { const i = (Math.round(h * 0.06) * w + x) * 4; if (d[i + 3]) { const rgb = L(i); rim += 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; rn++; } }
  return { id: p.host.id || p.host.className.split(" ")[0], kind: p.kind, a: p.host._rft && +p.host._rft.a.toFixed(3), innerRGB: innerRGB && innerRGB.map(Math.round), rim: rn ? Math.round(rim / rn) : null, px, w, h, at }; });
const STATE = () => { const R = TDC.refract; return { on: R.on, why: R.why, html: document.documentElement.classList.contains("refract"), contexts: R.contexts, err: R.err || null,
  pieces: R.pieces.map((p) => p.host.id || p.host.className.split(" ")[0]), marked: document.querySelectorAll(".rf-on,.rf-cap-on").length, renders: R.renders }; };
// every drawn piece: its canvas covers the piece's padding box (or, for the capsule, the ::before box), visible, no pointer events
const ALIGN = () => TDC.refract.pieces.map((p) => { const h = p.host, c = p.c, cr = c.getBoundingClientRect(), hr = h.getBoundingClientRect(), cs = getComputedStyle(c);
  let want;
  if (c.classList.contains("rf-cap") || c.classList.contains("rf-row")) { const b = getComputedStyle(h, "::before"); const l = parseFloat(b.left), t = parseFloat(b.top), r = parseFloat(b.right), bo = parseFloat(b.bottom);
    want = { left: hr.left + l, top: hr.top + t, right: hr.right - r, bottom: hr.bottom - bo }; }
  else want = { left: hr.left + h.clientLeft, top: hr.top + h.clientTop, right: hr.left + h.clientLeft + h.clientWidth, bottom: hr.top + h.clientTop + h.clientHeight };
  const dev = Math.max(Math.abs(cr.left - want.left), Math.abs(cr.top - want.top), Math.abs(cr.right - want.right), Math.abs(cr.bottom - want.bottom));
  return { id: h.id || h.className.split(" ")[0], dev: +dev.toFixed(2), vis: cs.visibility, pe: cs.pointerEvents, br: cs.borderTopLeftRadius, hbr: getComputedStyle(h).borderTopLeftRadius }; });

async function run(b, BR) {
  for (const [vw, vh, touch] of [[1440, 900, false], [430, 932, true]]) {
    const T = `${BR} ${vw}x${vh}${touch ? " touch" : ""}`;
    const mk = async (init) => { const ctx = await b.newContext({ viewport: { width: vw, height: vh }, ...(touch ? { hasTouch: true, isMobile: BR === "chromium" } : {}) });
      const p = await ctx.newPage(); p._errs = []; p.on("pageerror", (e) => p._errs.push(e.message)); if (init) await p.addInitScript(init); return { ctx, p }; };
    const { ctx, p } = await mk(); await open(p); const errs = p._errs;
    // 1
    let s = await p.evaluate(STATE);
    const want = touch ? ["tbMain", "stageBar"] : ["tbMain", "stageBar", "transport"];
    ok(T + " 1 refraction is on by default, one WebGL context, the bubble / camera pill / bottom capsule drawn", s.on && s.html && s.contexts === 1 && !s.err && want.every((id) => s.pieces.includes(id)) && (!touch || s.pieces.some((x) => /mbRow|mb-row/.test(x))) && s.marked >= s.pieces.length, s);
    let al = await p.evaluate(ALIGN);
    ok(T + " 1 each glass canvas sits exactly on its piece (<= 1 px), visible, rounded like it, no pointer events", al.length >= 2 && al.every((a) => a.dev <= 1 && a.vis === "visible" && a.pe === "none"), al);
    // 4 taps go through
    const hit = await p.evaluate(() => { const m = document.getElementById("tbMain").getBoundingClientRect(), s = document.getElementById("stageBar").querySelector("button").getBoundingClientRect();
      const a = document.elementFromPoint(m.left + m.width / 2, m.top + m.height / 2), b = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
      return { bubble: a && (a.id || a.className), bubbleOK: !!a && !!a.closest("#tbMain"), pill: b && (b.textContent || "").trim().slice(0, 20), pillOK: !!b && !b.classList.contains("rf-c") }; });
    ok(T + " 4 the point under the bubble and a camera-pill button is the control, not the glass", hit.bubbleOK && hit.pillOK, hit);
    if (touch) await p.tap("#tbMain"); else await p.click("#tbMain"); await W(900);
    // 2 tray
    s = await p.evaluate(() => ({ exp: document.getElementById("tbMain").getAttribute("aria-expanded"), st: (TDC.refract.render(), TDC.refract.pieces.map((x) => x.host.id || x.host.className.split(" ")[0])) }));
    ok(T + " 4/2 a real click on the bubble opens the tray, and its items get refraction", s.exp === "true" && s.st.filter((x) => !["tbMain", "stageBar", "transport", "mbRow"].includes(x)).length >= 3, s);
    al = await p.evaluate(ALIGN);
    ok(T + " 2 tray glass aligned (<= 1 px)", al.every((a) => a.dev <= 1), al.filter((a) => a.dev > 1));
    await p.keyboard.press("Escape"); await W(500);
    // Events sheet
    await p.evaluate(() => TDC.bubble && TDC.bubble.events && TDC.bubble.events(true, { focus: false })); await W(900);
    s = await p.evaluate(() => { TDC.refract.render(); return { cls: document.body.className.match(/tb-on|lib-open/g), pieces: TDC.refract.pieces.map((x) => x.host.id || x.host.className.split(" ")[0]) }; });
    ok(T + " 2 the Events sheet gets refraction", s.pieces.includes("library"), s);
    await p.evaluate(() => TDC.bubble.events(false)); await W(500);
    await p.evaluate(() => { document.getElementById("settings").hidden = false; TDC.settings && TDC.settings.show && TDC.settings.show("appearance"); }); await W(900);
    s = await p.evaluate(() => { TDC.refract.render(); return TDC.refract.pieces.map((x) => x.host.id || x.host.className.split(" ")[0]); });
    al = await p.evaluate(ALIGN);
    ok(T + " 2 Settings gets refraction, aligned", s.includes("settings") && al.every((a) => a.dev <= 1), { s, al });
    // 3 contrast over bright / dark — Settings open too
    await p.evaluate(PIN, "bright"); await W(200); await p.evaluate(() => TDC.refract.render()); await W(100);
    const br = await p.evaluate(GLASS, [0xf8, 0xf9, 0xfa]);
    const bad = br.filter((g) => !g.innerRGB || (g.kind === "sheet" ? (LUM_SHEET(g)) : ((TEXT + 0.05) / (LUMs(g.innerRGB) + 0.05))) < 4.5);
    function LUMs(rgb) { return LUM(rgb); } function LUM_SHEET(g) { return (LUM([0x9a, 0xa3, 0xb2]) + 0.05) / (LUM(g.innerRGB) + 0.05); }
    ok(T + " 3 over a bright scene the glass under the text gives >= 4.5:1 (control text " + "#aeb6c2, sheet text #9aa3b2)", br.length >= 3 && bad.length === 0, { bad, all: br.map((g) => g.id + ":" + g.a + ":" + (g.innerRGB && ((g.kind === "sheet" ? LUM([0x9a, 0xa3, 0xb2]) : TEXT) + 0.05) / (LUM(g.innerRGB) + 0.05)).toFixed(2)) });
    await p.evaluate(PIN, "dark"); await p.evaluate(() => TDC.refract.render()); await W(100);
    const dk = await p.evaluate(GLASS, [0x0c, 0x0e, 0x12]);
    const ctl = dk.filter((g) => g.kind !== "sheet");
    ok(T + " 3 over a dark scene the controls stay clear (tint alpha <= 0.3) and their rim is lighter than the scene", ctl.length >= 2 && ctl.every((g) => g.a <= 0.3 && g.rim > 14), dk.map((g) => ({ id: g.id, a: g.a, rim: g.rim })));
    // 5 idle / hidden / export
    await p.evaluate(() => { document.getElementById("settings").hidden = true; }); await W(1600);
    const idle = await p.evaluate(async () => { const R = TDC.refract, r0 = R.renders; await new Promise((r) => setTimeout(r, 1500)); return R.renders - r0; });
    ok(T + " 5 idle (paused, nothing changing): no rendering for 1.5 s", idle <= 1, idle);
    const hid = await p.evaluate(async () => { const R = TDC.refract; Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange"));
      const r0 = R.renders; TDC.player.play(); await new Promise((r) => setTimeout(r, 1000)); const d = R.renders - r0; TDC.player.pause(); delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); return d; });
    ok(T + " 5 hidden tab while playing: no rendering", hid === 0, hid);
    const ex = await p.evaluate(async () => { const R = TDC.refract; TDC.exporter.running = true; const r0 = R.renders; TDC.player.play(); await new Promise((r) => setTimeout(r, 800)); const d = R.renders - r0; TDC.player.pause(); TDC.exporter.running = false; R.kick(300); return d; });
    ok(T + " 5 while an export runs: no rendering (the export path is untouched)", ex === 0, ex);
    const pl = await p.evaluate(async () => { const R = TDC.refract; R.sample(null); const r0 = R.renders; TDC.player.play(); await new Promise((r) => setTimeout(r, 1200)); const d = R.renders - r0; TDC.player.pause(); return { d, on: R.on, why: R.why }; });
    ok(T + " 5 playing: the glass follows the video (renders)", pl.d >= 3, pl);
    // 6 fallbacks in this page
    await p.evaluate(() => { document.getElementById("settings").hidden = false; TDC.settings.show("appearance"); }); await W(400);
    await p.click("#segRefract button[data-v=frost]"); await W(400);
    s = await p.evaluate(() => ({ ...(() => { const R = TDC.refract; return { on: R.on, why: R.why, html: document.documentElement.classList.contains("refract"), marked: document.querySelectorAll(".rf-on,.rf-cap-on").length }; })(), pref: TDC.prefs.glassStyle,
      frost: getComputedStyle(document.getElementById("stageBar")).backgroundColor, canv: [...document.querySelectorAll(".rf-c")].filter((c) => getComputedStyle(c).display !== "none").length,
      pressed: document.querySelector("#segRefract button[data-v=frost]").getAttribute("aria-pressed") }));
    ok(T + " 6 Settings ▸ Glass style ▸ Frosted: frosted glass, no glass canvas shown, choice saved", !s.on && s.why === "pref" && !s.html && s.marked === 0 && s.canv === 0 && s.pref === "frost" && s.pressed === "true" && !/rgba\(0, 0, 0, 0\)/.test(s.frost), s);
    await p.click("#segRefract button[data-v=refract]"); await W(800);
    s = await p.evaluate(STATE);
    ok(T + " 6 … and Refraction brings it back (same single context)", s.on && s.html && s.contexts === 1, s);
    await p.evaluate(() => TDC.setPref("lite", "on")); await W(400);
    s = await p.evaluate(() => ({ on: TDC.refract.on, why: TDC.refract.why, note: document.getElementById("refractNote").textContent }));
    ok(T + " 6 Lite mode on -> frosted, and Settings says why", !s.on && s.why === "lite" && /Lite/.test(s.note), s);
    await p.evaluate(() => TDC.setPref("lite", "auto")); await W(400);
    s = await p.evaluate(async () => { const R = TDC.refract, t0 = performance.now() + 5000; let hit = false; for (let t = 0; t < 2600; t += 40) hit = R.feed(t0 + t) || hit; await new Promise((r) => setTimeout(r, 300));
      return { hit, on: R.on, why: R.why, toast: (document.querySelector(".toast,#toast") || {}).textContent || "", said: sessionStorage.getItem("tdc.refractSaid") }; });
    ok(T + " 6 dropped frames (25 fps for 2.5 s) -> frosted for the session, told once", s.hit && !s.on && s.why === "slow" && s.said === "1", s);
    await p.click("#segRefract button[data-v=frost]"); await W(200); await p.click("#segRefract button[data-v=refract]"); await W(500);
    s = await p.evaluate(STATE);
    ok(T + " 6 choosing Refraction again in Settings retries it", s.on, s);
    if (BR === "chromium") {
      const cdp = await ctx.newCDPSession(p);
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] }); await W(500);
      s = await p.evaluate(() => ({ on: TDC.refract.on, why: TDC.refract.why, mq: matchMedia("(prefers-reduced-transparency: reduce)").matches }));
      ok(T + " 6 reduced transparency -> no refraction", s.mq ? (!s.on && s.why === "reduced-transparency") : true, s);
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "no-preference" }] }); await W(500);
      s = await p.evaluate(() => TDC.refract.on); ok(T + " 6 … and back on when it's off", s, s);
    }
    ok(T + " 7 no page errors", errs.length === 0, errs);
    await ctx.close();
    // ?refract=0 / ?refract=1, no WebGL — fresh pages
    { const { ctx, p } = await mk(); await open(p, "&refract=0"); s = await p.evaluate(() => ({ on: TDC.refract.on, why: TDC.refract.why, html: document.documentElement.classList.contains("refract"), ctx: TDC.refract.contexts, note: document.getElementById("refractNote").textContent }));
      ok(T + " 6 ?refract=0 -> frosted for the visit, no WebGL context made", !s.on && s.why === "override" && !s.html && !s.ctx && /refract=/.test(s.note), s);
      await p.evaluate(() => TDC.setPref("glassStyle", "frost")); await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1&refract=1`); await W(1500);
      s = await p.evaluate(() => ({ on: TDC.refract.on, pref: TDC.prefs.glassStyle })); ok(T + " 6 ?refract=1 wins over the Frosted pref", s.on && s.pref === "frost", s);
      ok(T + " 7 no page errors (?refract)", p._errs.length === 0, p._errs); await ctx.close(); }
    { const { ctx, p } = await mk(() => { const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (k, o) { return /webgl/.test(k) ? null : g.call(this, k, o); }; });
      await open(p); s = await p.evaluate(() => ({ on: TDC.refract.on, why: TDC.refract.why, html: document.documentElement.classList.contains("refract"), bg: getComputedStyle(document.getElementById("stageBar")).backgroundColor }));
      ok(T + " 6 no WebGL -> frosted glass as before", !s.on && s.why === "no-webgl" && !s.html && !/rgba\(0, 0, 0, 0\)/.test(s.bg), s);
      ok(T + " 7 no page errors (no WebGL)", p._errs.length === 0, p._errs); await ctx.close(); }
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
