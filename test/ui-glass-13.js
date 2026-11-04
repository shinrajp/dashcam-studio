// ui-glass-13 (owner: "Give me glass UI config to optimize blur, strength and tint, manually. The glass panel in Settings is too
// transparent and difficult to read."):
//   1  Settings ▸ Appearance has the glass sliders in the default UI (Debug off): Blur, Strength, Tint, Panel opacity, defaults 4 / 1 / 0.22 /
//      0.72, a note, Reset glass to default
//   2  a live slider move changes the refraction uniforms (R.tune) and --g-blur at once, the change is saved (prefs.glassTune) and survives
//      a reload
//   3  ?gblur= ?gstrength= ?gtint= ?gpanel= override one visit (slider shows the value, disabled, note), nothing saved
//   4  Reset restores the defaults (slider, prefs, uniforms)
//   5  Frosted (?refract=0): Strength disabled with a note, Blur drives the frosted --g-blur, Tint is a floor under the frosted tint
//   6  readable sheets: the Settings sheet has its own backing (0.72) apart from the controls (0.22), with the stronger blur; over a white
//      frame its body text and hints are >= 4.5:1 (WCAG AA) against the rendered glass behind them
//   7  no page errors
//   Playwright, BR=chromium|webkit (default both), mock footage (/tmp/ho-mock). PORT (default 8833). ROOT=dir serves another checkout.
const fs = require("fs"), path = require("path"), http = require("http");
const ROOT = process.env.ROOT || path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", FIXP = process.env.FIXP || "/tmp/photo-mock", PORT = +(process.env.PORT || 8833);
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
const ST = () => { const R_ = TDC.refract, $ = (id) => document.getElementById(id), cs = getComputedStyle(document.documentElement);
  return { on: R_.on, tune: R_.tune(), cur: TDC.glassTune.get(), saved: (JSON.parse(localStorage.getItem("tdc.prefs.v1") || "{}").glassTune) || null,
    gblur: cs.getPropertyValue("--g-blur").trim(), floor: cs.getPropertyValue("--g-tint-floor").trim(), frosted: !document.documentElement.classList.contains("refract"),
    sl: ["gtBlur", "gtStr", "gtTint", "gtSheet"].map((id) => { const e = $(id); return e ? { id, v: +e.value, min: +e.min, max: +e.max, dis: e.disabled, vis: e.getClientRects().length > 0 } : { id, missing: true }; }),
    note: ($("glassTuneNote") || {}).textContent || "", reset: !!$("gtReset") && $("gtReset").getClientRects().length > 0,
    pieces: R_.pieces.map((x) => ({ id: x.host.id || x.host.className.split(" ")[0], kind: x.kind, a: x.host._rft && +x.host._rft.a.toFixed(3) })) }; };
const showApp = (p) => p.evaluate(() => { TDC.settings.show("appearance"); });
const slide = (p, id, v, commit) => p.evaluate(([id, v, c]) => { const e = document.getElementById(id); e.value = String(v); e.dispatchEvent(new Event("input", { bubbles: true })); if (c) e.dispatchEvent(new Event("change", { bubbles: true })); }, [id, v, commit]);
// contrast of the Settings text against the rendered glass right behind it, over a pinned white frame
const CONTRAST = () => { const R_ = TDC.refract, P = R_.pieces.find((x) => x.kind === "sheet" && x.host.id === "settings"); if (!P) return { err: "no sheet piece" };
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }, L = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const rgb = (s) => (s.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
  const c = P.c, x = c.getContext("2d"), cr = c.getBoundingClientRect(), k = c.width / cr.width, out = [];
  const els = [...P.host.querySelectorAll("p.hint, .row > span:first-child, h4, h3")].filter((e) => e.getClientRects().length && e.textContent.trim()).slice(0, 14);
  for (const e of els) { const r = e.getBoundingClientRect(); if (r.bottom > cr.bottom || r.top < cr.top) continue;
    const X = Math.max(0, Math.round((r.left - cr.left) * k)), Y = Math.max(0, Math.round((r.top - cr.top) * k)), w = Math.max(1, Math.min(c.width - X, Math.round(r.width * k))), h = Math.max(1, Math.min(c.height - Y, Math.round(r.height * k)));
    const d = x.getImageData(X, Y, w, h).data; let mx = 0; for (let i = 0; i < d.length; i += 16) { const a = d[i + 3] / 255, l = L(d[i] * a + 255 * (1 - a) * 0, d[i + 1] * a, d[i + 2] * a); if (d[i + 3] && l > mx) mx = l; }
    const fg = rgb(getComputedStyle(e).color), lf = L(...fg), cr_ = (Math.max(lf, mx) + 0.05) / (Math.min(lf, mx) + 0.05);
    out.push({ t: e.textContent.trim().slice(0, 24), fg: fg.join(","), bgL: +mx.toFixed(3), ratio: +cr_.toFixed(2) }); }
  return { n: out.length, min: out.length ? Math.min(...out.map((o) => o.ratio)) : 0, out, a: P.host._rft && P.host._rft.a }; };
const WHITE = () => { const cv = document.createElement("canvas"); cv.width = innerWidth; cv.height = innerHeight; const x = cv.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, cv.width, cv.height);
  x.fillStyle = "#f2f2ee"; for (let i = 0; i < 12; i++) x.fillRect(i * cv.width / 12, 0, cv.width / 24, cv.height); TDC.refract.sample(cv); TDC.refract.render(); };
async function run(b, BR) {
  const mk = async (vw, vh, touch) => { const ctx = await b.newContext({ viewport: { width: vw, height: vh }, ...(touch ? { hasTouch: true, isMobile: BR === "chromium" } : {}) });
    const p = await ctx.newPage(); p._errs = []; p.on("pageerror", (e) => p._errs.push(e.message)); return { ctx, p }; };
  for (const [vw, vh, touch] of [[1440, 900, false], [430, 932, true]]) {
    const T = `${BR} ${vw}x${vh}`;
    let { ctx, p } = await mk(vw, vh, touch);
    await open(p, "");
    await showApp(p); await W(700);
    let s = await p.evaluate(ST);
    const sl = (id) => s.sl.find((x) => x.id === id) || {};
    ok(T + " 1 Appearance shows Blur / Strength / Tint / Panel opacity with Debug off, plus a note and Reset", !(await p.evaluate(() => TDC.debugOn())) && s.sl.every((x) => !x.missing && x.vis && !x.dis) && s.reset && s.note.length > 10, s);
    ok(T + " 1 defaults 4 / 1 / 0.22 / 0.72 and ranges 0–12, 0–2.5, 0–0.8, 0.3–0.95", sl("gtBlur").v === 4 && sl("gtStr").v === 1 && sl("gtTint").v === 0.22 && sl("gtSheet").v === 0.72 && sl("gtBlur").max === 12 && sl("gtStr").max === 2.5 && sl("gtTint").max === 0.8 && sl("gtSheet").min === 0.3 && sl("gtSheet").max === 0.95 && s.tune.str === 1 && s.tune.blur === 4 && s.tune.tint === 0.22 && s.tune.sheet === 0.72, s);
    ok(T + " 6 the Settings sheet has its own backing (0.72, blur 4+6) apart from the controls (0.22)", s.pieces.some((x) => x.kind === "sheet" && x.a === 0.72) && s.pieces.filter((x) => x.kind === "ctl").every((x) => x.a === 0.22) && s.tune.sheetBlur === 10, s.pieces);
    // 2 live + saved
    await slide(p, "gtBlur", 7, false); await slide(p, "gtStr", 1.6, false); await slide(p, "gtTint", 0.5, false); await W(400);
    s = await p.evaluate(ST);
    ok(T + " 2 a live move (input) changes the uniforms and --g-blur at once; nothing saved yet", s.tune.blur === 7 && s.tune.str === 1.6 && s.tune.tint === 0.5 && s.gblur === "21px" && s.pieces.filter((x) => x.kind === "ctl").every((x) => x.a === 0.5) && (!s.saved || s.saved.blur === 4 && s.saved.tint === 0.22), s);
    await slide(p, "gtBlur", 7, true); await slide(p, "gtStr", 1.6, true); await slide(p, "gtTint", 0.5, true); await slide(p, "gtSheet", 0.85, true); await W(300);
    s = await p.evaluate(ST);
    ok(T + " 2 release (change) saves prefs.glassTune", s.saved && s.saved.blur === 7 && s.saved.str === 1.6 && s.saved.tint === 0.5 && s.saved.sheet === 0.85 && s.pieces.some((x) => x.kind === "sheet" && x.a === 0.85), s.saved);
    await p.reload({ waitUntil: "load" }); await W(1200); await showApp(p); await W(700);
    s = await p.evaluate(ST);
    ok(T + " 2 the values survive a reload (sliders + uniforms)", sl("gtBlur").v === 7 && sl("gtStr").v === 1.6 && sl("gtTint").v === 0.5 && sl("gtSheet").v === 0.85 && s.tune.blur === 7 && s.tune.str === 1.6 && s.tune.tint === 0.5 && s.tune.sheet === 0.85, s);
    // 4 reset
    await p.click("#gtReset"); await W(400);
    s = await p.evaluate(ST);
    ok(T + " 4 Reset glass to default restores 4 / 1 / 0.22 / 0.72 (sliders, saved prefs, uniforms, --g-blur 12px, ui-glass-14 frosted default)", sl("gtBlur").v === 4 && sl("gtStr").v === 1 && sl("gtTint").v === 0.22 && sl("gtSheet").v === 0.72 && s.tune.blur === 4 && s.tune.str === 1 && s.tune.tint === 0.22 && s.gblur === "12px" && s.saved && s.saved.blur === 4 && s.saved.tint === 0.22, s);
    // 6 contrast over white
    await p.evaluate(WHITE); await W(300);
    let cn = await p.evaluate(CONTRAST);
    ok(T + " 6 over a white frame the Settings text is >= 4.5:1 against the glass behind it (WCAG AA), " + cn.n + " samples, min " + cn.min, cn.n >= 4 && cn.min >= 4.5, cn);
    await p.evaluate(() => TDC.settings.show("playback")); await W(500); await p.evaluate(() => TDC.refract.render()); await W(200);
    cn = await p.evaluate(CONTRAST);
    ok(T + " 6 the same on Playback (hint-heavy), min " + cn.min, cn.n >= 4 && cn.min >= 4.5, cn);
    await p.evaluate(() => TDC.refract.sample(null));
    ok(T + " 7 no page errors", p._errs.length === 0, p._errs);
    await ctx.close();
    // 3 URL overrides
    ({ ctx, p } = await mk(vw, vh, touch));
    await open(p, "&gblur=9&gstrength=2&gtint=0.6&gpanel=0.9", { glassTune: { blur: 3, str: 0.5, tint: 0.1, sheet: 0.5 } });
    await showApp(p); await W(700);
    s = await p.evaluate(ST);
    ok(T + " 3 ?gblur=9 ?gstrength=2 ?gtint=0.6 ?gpanel=0.9 win over saved prefs for the visit", s.tune.blur === 9 && s.tune.str === 2 && s.tune.tint === 0.6 && s.tune.sheet === 0.9 && s.gblur === "27px" && s.pieces.some((x) => x.kind === "sheet" && x.a === 0.9), s);
    ok(T + " 3 the sliders show the URL values, disabled, with a note; saved prefs untouched", s.sl.every((x) => x.dis) && sl("gtBlur").v === 9 && sl("gtTint").v === 0.6 && /\?g/.test(s.note) && s.saved && s.saved.blur === 3 && s.saved.tint === 0.1, s);
    ok(T + " 7 no page errors (URL)", p._errs.length === 0, p._errs);
    await ctx.close();
    // 5 frosted
    ({ ctx, p } = await mk(vw, vh, touch));
    await open(p, "&refract=0", { glassTune: { blur: 2, str: 1, tint: 0.22, sheet: 0.72 } });
    await showApp(p); await W(700);
    s = await p.evaluate(ST);
    ok(T + " 5 Frosted: Strength is disabled with a note, Blur stays live and drives --g-blur (2 → 6px)", s.frosted && sl("gtStr").dis && !sl("gtBlur").dis && !sl("gtTint").dis && /frost/i.test(s.note) && s.gblur === "6px", s);
    await slide(p, "gtTint", 0.8, true); await W(500);
    s = await p.evaluate(ST);
    const fa = await p.evaluate(() => { const e = document.getElementById("stageBar") || document.querySelector(".g-blur"); return { root: getComputedStyle(document.documentElement).getPropertyValue("--g-a").trim(), el: e ? getComputedStyle(e).getPropertyValue("--g-a").trim() : null, floor: TDC.glass && TDC.glass.tintFloor }; });
    ok(T + " 5 Frosted: Tint 0.8 is a floor under the frosted tint (--g-a >= 0.8)", parseFloat(s.floor) === 0.8 && fa.floor === 0.8 && parseFloat(fa.root) >= 0.8 - 1e-6, fa);
    await p.click("#gtReset"); await W(300);
    s = await p.evaluate(ST);
    ok(T + " 5 Frosted Reset: --g-blur back to 12px", s.gblur === "12px" && s.tune.tint === 0.22, s);
    ok(T + " 7 no page errors (frosted)", p._errs.length === 0, p._errs);
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
