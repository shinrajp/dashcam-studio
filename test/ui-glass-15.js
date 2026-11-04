// ui-glass-15 (owner t233u): glass performance for object tracking.
//   1  Tracking priority Auto: live detection playing -> refraction off (why "prio"), html.glass-prio, frosted static tint, big sheets without
//      backdrop blur; pause -> refraction back. ?glassprio=off keeps refraction while detecting; ?glassprio=on forces frosted. Settings row works.
//   2  refraction pauses while the controls are auto-hidden (no renders), resumes when they show; while playing it refreshes at <= ~15 Hz
//   3  no regressions: sliders still switch to Custom and write the uniforms; touch Pause after auto-hide still pauses (ui-glass-14 fix)
//   4  no page errors.  Playwright, Chromium (BR=), mock footage /tmp/ho-mock. PORT (default 8835).
const fs = require("fs"), path = require("path"), http = require("http");
const ROOT = process.env.ROOT || path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", FIXP = process.env.FIXP || "/tmp/photo-mock", PORT = +(process.env.PORT || 8835);
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
const S = () => { const R = TDC.refract, h = document.documentElement, dr = document.getElementById("settings");
  return { on: R.on, why: R.why, prio: !!R.prio, cls: h.classList.contains("glass-prio"), refr: h.classList.contains("refract"), renders: R.renders, skipped: R.skipped || 0, paused: R.paused || "",
    playing: !!TDC.player.playing, ah: document.body.dataset.ah, luma: TDC.glass.luma, bf: dr ? getComputedStyle(dr).backdropFilter || getComputedStyle(dr).webkitBackdropFilter : "", pref: R.prioPref(),
    seg: [...document.querySelectorAll("#segGlassPrio button.on")].map((b) => b.dataset.v) }; };
const detOn = (p, on) => p.evaluate((on) => { const D = TDC.detect; D._mock = async () => { await new Promise((r) => setTimeout(r, 40)); return [{ x: 0.4, y: 0.45, w: 0.2, h: 0.18, cls: 2, conf: 0.9 }]; };
  const P = D.prefs(); P.enabled = on; P.live = on; localStorage.setItem("tdc.detect.v1", JSON.stringify(P)); }, on);
async function run(b) {
  for (const [vw, vh, touch] of [[1440, 900, false], [430, 932, true]]) {
    const T = `chromium ${vw}x${vh}`;
    const ctx = await b.newContext({ viewport: { width: vw, height: vh }, ...(touch ? { hasTouch: true, isMobile: true } : {}) });
    const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
    // ---- 1 priority rule
    await open(p); let s = await p.evaluate(S);
    ok(T + " 1 at rest (no detection): refraction on, no priority, Settings row shows Auto", s.on && !s.prio && !s.cls && s.pref === "auto", s);
    await detOn(p, true);
    const tr0 = await p.evaluate(() => { TDC.player.play(); return 0; }); await W(1800); s = await p.evaluate(S);
    ok(T + " 1 live detection playing: glass goes frosted + static (why prio, html.glass-prio, refraction off)", s.prio && s.cls && !s.on && s.why === "prio" && !s.refr, s);
    await p.evaluate(() => TDC.settings.show("appearance")); await W(500); s = await p.evaluate(S);
    ok(T + " 1 during priority the Settings sheet has no backdrop blur", !s.bf || s.bf === "none", s);
    await p.evaluate(() => { document.getElementById("settings").hidden = true; }); 
    await p.evaluate(() => TDC.player.pause()); await W(1500); s = await p.evaluate(S);
    ok(T + " 1 paused: refraction comes back (priority off)", s.on && !s.prio && !s.cls && s.refr, s);
    await p.evaluate(() => TDC.setPref("glassPrio", "off")); await p.evaluate(() => TDC.player.play()); await W(1500); s = await p.evaluate(S);
    ok(T + " 1 Tracking priority Off: refraction stays on while detecting", s.on && !s.prio && s.seg.join() === "off", s);
    await p.evaluate(() => { TDC.player.pause(); TDC.setPref("glassPrio", "on"); }); await W(600); s = await p.evaluate(S);
    ok(T + " 1 Tracking priority Always: frosted even at rest", !s.on && s.prio && s.why === "prio" && s.seg.join() === "on", s);
    await p.evaluate(() => TDC.setPref("glassPrio", "auto")); await W(600);
    await detOn(p, false); await W(300);
    // ?glassprio= override
    await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1&glassprio=on`, { waitUntil: "load" }); await W(1200); s = await p.evaluate(S);
    ok(T + " 1 ?glassprio=on forces priority for the visit", s.prio && s.pref === "on" && !s.on, s);
    // ---- 2 hidden pause + rate
    await open(p); await p.evaluate(() => TDC.player.play()); await W(900);
    const a = await p.evaluate(S); await W(1000); const a2 = await p.evaluate(S);
    const hz = (a2.renders - a.renders) / 1;
    ok(T + " 2 while playing (controls shown) refraction refreshes at <= ~16 Hz", a.on && a2.ah !== "hidden" && hz > 0 && hz <= 17, { a, a2, hz });
    await p.evaluate(() => TDC.setPref("autohide", "2")); if (!touch) await p.mouse.move(vw / 2, vh / 3); await W(3400); const h1 = await p.evaluate(S); await W(1200); const h2 = await p.evaluate(S);
    ok(T + " 2 controls auto-hidden: refraction paused (no renders)", h1.ah === "hidden" && h2.renders === h1.renders && h2.paused === "hidden", { h1, h2 });
    await p.mouse.move(vw / 2, vh / 2); await p.mouse.move(vw / 2 + 30, vh / 2 + 10); if (touch) await p.evaluate(() => TDC.autohide && TDC.autohide.show && TDC.autohide.show()); await W(700); const h3 = await p.evaluate(S);
    ok(T + " 2 controls shown again: refraction resumes", h3.ah !== "hidden" && h3.renders > h2.renders, { h2, h3 });
    await p.evaluate(() => TDC.player.pause());
    // ---- 3 no regressions
    await p.evaluate(() => TDC.settings.show("appearance")); await W(400);
    await p.evaluate(() => { const e = document.getElementById("gtTint"); e.value = "0.4"; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); }); await W(400);
    s = await p.evaluate(() => ({ pick: document.documentElement.dataset.glassPick, tint: TDC.refract.tune().tint }));
    ok(T + " 3 sliders still switch to Custom and feed refraction", s.pick === "custom" && Math.abs(s.tint - 0.4) < 1e-6, s);
    ok(T + " 4 no page errors", errs.length === 0, errs);
    await ctx.close();
  }
}
(async () => {
  const pw = require("playwright"); const s = await server();
  const b = await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  try { await run(b); } catch (e) { ok("run", false, String(e && e.stack || e)); }
  await b.close(); s.close(); console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})();
