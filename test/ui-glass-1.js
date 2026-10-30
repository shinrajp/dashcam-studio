// ui-glass-1 (tag ui-glass-1): the Liquid Glass material on today's controls (css/glass.css, js/glass.js). Look only.
//   Playwright, BR=chromium|webkit (default both), mock footage (tools/make-mock-footage.py -> /tmp/ho-mock). Serves the repo on PORT (default 8811).
//   Desktop 1440x900 and 1280x720, phone 390x844 and 844x390.
//   Checks: 1 the pref (Settings ▸ Appearance ▸ Glass: Automatic default, Clear, Solid; saved; survives a reload; Reset all goes back to Automatic;
//   ?glass=solid overrides for one visit without saving); 2 fallbacks (no backdrop-filter support -> Solid; prefers-reduced-transparency -> Solid,
//   no blur (Chromium: CDP media emulation); prefers-reduced-motion -> no transitions on the glass pieces); 3 blur budget in busy states (Settings open,
//   Redact window floating, draw bar, full screen): at most 3 pieces with backdrop-filter, none inside another, every blur <= 22 px;
//   4 no layout change: every visible element with an id has the same box with glass.css on and off (main, Redact window, Settings, drawing);
//   5 contrast over a bright frame: Automatic samples a white frame -> darkest tint, and the text of the toast, camera bar and draw bar keeps >= 4.5:1
//   against the brightest pixel behind it while every camera picture is pure white; 6 no page errors.
// Usage: BR=chromium|webkit node test/ui-glass-1.js    DEV=desktop|phone    SHOTS=dir
const fs = require("fs"), path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", PORT = +(process.env.PORT || 8811), SHOTS = process.env.SHOTS || "";
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
const state = (p) => p.evaluate(() => ({ pick: TDC.glass.mode, eff: TDC.glass.effective, why: TDC.glass.why, pref: TDC.prefs.glass, cls: document.documentElement.className, data: document.documentElement.dataset.glass,
  seg: [...document.querySelectorAll("#segGlass button.on")].map((b) => b.dataset.v), saved: (JSON.parse(localStorage.getItem("tdc.prefs.v1") || "{}") || {}).glass }));
// every element painting a backdrop blur, its radius, and whether one sits inside another
const BLURS = () => { const out = []; document.querySelectorAll("*").forEach((e) => { const cs = getComputedStyle(e), f = cs.backdropFilter || cs.webkitBackdropFilter || "none";
  if (f === "none" || !e.getClientRects().length || cs.visibility === "hidden" || cs.display === "none") return; const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return;
  const m = /blur\(([\d.]+)px\)/.exec(f); out.push({ el: e, n: e.id || (typeof e.className === "string" ? e.className.split(" ")[0] : e.tagName), px: m ? +m[1] : 0 }); });
  return { n: out.length, names: out.map((o) => o.n + ":" + o.px), max: Math.max(0, ...out.map((o) => o.px)), nested: out.filter((o) => out.some((q) => q !== o && q.el.contains(o.el))).map((o) => o.n) }; };
const RECTS = () => { const o = {}; document.querySelectorAll("[id]").forEach((e) => { if (!e.getClientRects().length || e.closest("details:not([open]) > :not(summary)")) return;   /* closed <details> content is not on screen */ const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return; o[e.id] = [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 2) / 2); }); return o; };
async function layoutSame(p, t) {
  const on = await p.evaluate(RECTS);
  const off = await p.evaluate(async (R) => { const ss = [...document.styleSheets].find((s) => s.href && s.href.includes("glass.css")); ss.disabled = true; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); const o = (0, eval)("(" + R + ")")(); ss.disabled = false; return o; }, RECTS.toString());
  const on2 = await p.evaluate(RECTS), same = (x, y) => x && y && x.every((v, i) => Math.abs(v - y[i]) <= 0.6);
  for (const k of Object.keys(on)) if (!same(on[k], on2[k])) delete on[k];   // still moving by itself (async list, animation): not glass's doing
  for (const k of Object.keys(off)) if (!on[k] && on2[k]) delete off[k];   // it appeared after the first look (draw bar sliding in): timing, not glass's doing
  for (const k of Object.keys(off)) if (!on2[k] && !on[k]) { const again = await p.evaluate((id) => !!document.getElementById(id), k); if (!again) delete off[k]; }
  const diff = Object.keys(on).filter((k) => off[k] && on[k].some((v, i) => Math.abs(v - off[k][i]) > 0.6)).map((k) => k + " " + on[k] + " vs " + off[k]);
  const gone = Object.keys(on).filter((k) => !off[k]).concat(Object.keys(off).filter((k) => !on[k]));
  ok(t + " | no layout change: every visible element with an id has the same box with glass.css on and off (" + Object.keys(on).length + " elements)", diff.length === 0 && gone.length === 0, { diff: diff.slice(0, 6), gone: gone.slice(0, 6) });
}
const lum = (r, g, b) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
// contrast of an element's text colour against the brightest pixel of its background (text hidden while the picture is taken)
async function contrast(p, sel) {
  const r = await p.evaluate((sel) => { const e = document.querySelector(sel); if (!e || !e.getClientRects().length) return null; const b = e.getBoundingClientRect(); if (b.width < 8 || b.height < 8) return null;
    const c = getComputedStyle(e).color; const st = document.createElement("style"); st.id = "ugHideText";
    st.textContent = sel + " { opacity: 1 !important; transition: none !important; } " + sel + ", " + sel + " * { color: transparent !important; text-shadow: none !important; caret-color: transparent !important; } " + sel + " svg, " + sel + " img, " + sel + " input, " + sel + " .us-count, " + sel + " .mini-switch, " + sel + " button, " + sel + " select, " + sel + " .chip { visibility: hidden !important; }";
    document.head.appendChild(st);
    const rad = Math.min(b.height / 2, parseFloat(getComputedStyle(e).borderTopLeftRadius) || 0), ix = Math.max(4, rad);   // stay off the rounded corners and the rim
    return { l: b.left + ix, t: b.top + 4, w: b.width - 2 * ix, h: b.height - 8, color: c }; }, sel);
  if (r && (r.w < 4 || r.h < 4)) { await p.evaluate(() => { const s = document.getElementById("ugHideText"); if (s) s.remove(); }); return null; }
  if (!r) return null;
  await W(350);
  const png = await p.screenshot({ clip: { x: r.l, y: r.t, width: r.w, height: r.h } });
  if (process.env.DBG) fs.writeFileSync("/tmp/ug-clip-" + sel.replace(/\W/g, "") + ".png", png);
  await p.evaluate(() => { const s = document.getElementById("ugHideText"); if (s) s.remove(); });
  const mx = await p.evaluate(async (b64) => { const bm = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob()); const c = document.createElement("canvas"); c.width = bm.width; c.height = bm.height; const g = c.getContext("2d"); g.drawImage(bm, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data; let best = [0, 0, 0], bl = -1; for (let i = 0; i < d.length; i += 4) { const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; if (l > bl) { bl = l; best = [d[i], d[i + 1], d[i + 2]]; } } return best; }, png.toString("base64"));
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(r.color); const tl = lum(+m[1], +m[2], +m[3]), bl = lum(...mx);
  return { ratio: Math.round(((Math.max(tl, bl) + 0.05) / (Math.min(tl, bl) + 0.05)) * 100) / 100, text: r.color, bg: mx };
}
const shot = async (p, n) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, n + ".png") }); } };

async function run(b, BR, dev) {
  const tag = BR + " " + dev.name, touch = dev.touch;
  const UA_ = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  const ctx = await b.newContext({ viewport: { width: dev.w, height: dev.h }, isMobile: !!touch && BR === "chromium", hasTouch: !!touch, userAgent: touch ? UA_ : undefined, deviceScaleFactor: touch ? 2 : 1 });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await open(p);
  // 1 the pref
  let s = await state(p);
  ok(tag + " 1 default: Glass Automatic (html.glass, data-glass=auto, Settings ▸ Appearance shows Automatic)", s.pick === "auto" && s.eff === "auto" && /\bglass\b/.test(s.cls) && s.data === "auto" && s.seg.join() === "auto" && !!(await p.$("#appearSec #segGlass")), s);
  await p.evaluate(() => { document.getElementById("settings").hidden = false; document.querySelector('#segGlass [data-v="clear"]').click(); }); await W(200); s = await state(p);
  ok(tag + " 1 picking Clear saves the pref and applies it", s.pref === "clear" && s.saved === "clear" && s.data === "clear" && s.seg.join() === "clear", s);
  await p.evaluate(() => document.querySelector('#segGlass [data-v="solid"]').click()); await W(300); s = await state(p);
  const bs = await p.evaluate(BLURS);
  ok(tag + " 1 Solid: applied, and nothing on screen is blurred", s.data === "solid" && s.saved === "solid" && bs.n === 0, { s, bs: bs.names });
  await p.reload({ waitUntil: "load" }); await W(400); s = await state(p);
  ok(tag + " 1 Solid survives a reload", s.data === "solid" && s.seg.join() === "solid", s);
  await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1&glass=clear`, { waitUntil: "load" }); await W(400); s = await state(p);
  ok(tag + " 1 ?glass=clear overrides for this visit without saving", s.data === "clear" && s.pref === "solid" && s.saved === "solid" && s.seg.join() === "clear", s);
  await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1`, { waitUntil: "load" }); await W(300);
  await p.evaluate(() => document.getElementById("btnResetAll").click()); await W(300); s = await state(p);
  ok(tag + " 1 Reset all goes back to Automatic", s.pref === "auto" && s.data === "auto" && s.seg.join() === "auto", s);

  // 2 fallbacks
  await p.addInitScript(() => { if (sessionStorage.getItem("ugNoBF")) { const o = CSS.supports.bind(CSS); CSS.supports = (a, b) => (/backdrop-filter/.test(String(a)) ? false : b === undefined ? o(a) : o(a, b)); } });
  await p.evaluate(() => sessionStorage.setItem("ugNoBF", "1")); await p.reload({ waitUntil: "load" }); await W(400); s = await state(p);
  ok(tag + " 2 no backdrop-filter support: Solid, Settings says why", s.eff === "solid" && s.why === "no-backdrop-filter" && s.pick === "auto" && /can't blur/.test(await p.textContent("#glassNote")), s);
  await p.evaluate(() => sessionStorage.removeItem("ugNoBF")); await p.reload({ waitUntil: "load" }); await W(300);
  let cdp = null; if (BR === "chromium") { try { cdp = await ctx.newCDPSession(p); } catch (_) {} }
  if (cdp) {
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] }); await W(400);
    s = await state(p);
    await p.evaluate(() => { document.getElementById("settings").hidden = false; TDC.glass.budget(); }); await W(200);
    const b2 = await p.evaluate(BLURS);
    ok(tag + " 2 prefers-reduced-transparency: Solid, no blur anywhere", s.eff === "solid" && s.why === "reduced-transparency" && b2.n === 0, { s, b: b2.names });
    await cdp.send("Emulation.setEmulatedMedia", { features: [] }); await W(300);
    await p.evaluate(() => { document.getElementById("settings").hidden = true; });
  } else console.log("SKIP " + tag + " 2 prefers-reduced-transparency (needs Chromium CDP media emulation)");
  await p.emulateMedia({ reducedMotion: "reduce" }); await W(300);
  const rm = await p.evaluate(() => ({ cls: document.documentElement.classList.contains("glass-rm"), t: getComputedStyle(document.getElementById("toast")).transitionDuration }));
  ok(tag + " 2 prefers-reduced-motion: glass pieces change without transitions", rm.cls && rm.t.split(",").every((d) => parseFloat(d) < 0.01), rm);
  await p.emulateMedia({ reducedMotion: "no-preference" });

  // 3 blur budget + 4 layout, in a few states
  await open(p);
  const states = [
    ["main", async () => { await p.evaluate(() => TDC.toast("A toast over the video", "ok", 60000)); }],
    ["redact", async () => { await p.evaluate(() => { document.getElementById("toast").classList.remove("show"); TDC.searchUI.show(false, "redact"); }); }],
    ["settings+redact", async () => { await p.evaluate(() => { document.getElementById("settings").hidden = false; TDC.toast("Another toast", "ok", 60000); }); }],
    ["drawing", async () => { await p.evaluate(() => { document.getElementById("settings").hidden = true; TDC.searchUI.hide(); try { TDC.focus.focus("front"); } catch (_) {} TDC.regions.UI.draw(); TDC.toast("Draw now", "ok", 60000); });
      await p.waitForFunction(() => { const e = document.getElementById("crBar"); return e && !e.hidden && e.getClientRects().length > 0; }, null, { timeout: 5000 }).catch(() => {}); }],
    ["fullscreen", async () => { await p.evaluate(() => { try { TDC.regions.UI.cancel(); } catch (_) {} document.body.classList.add("fs"); window.dispatchEvent(new Event("resize")); document.getElementById("settings").hidden = false; TDC.searchUI.show(false, "redact"); }); }],
  ];
  for (const [n, fn] of states) {
    await fn(); await W(700); await p.evaluate(() => TDC.glass.budget());
    const bb = await p.evaluate(BLURS);
    ok(tag + " 3 " + n + ": at most 3 blurred pieces, none inside another, every blur <= 22 px", bb.n <= 3 && bb.nested.length === 0 && bb.max <= 22, bb);
    if (n !== "fullscreen") await layoutSame(p, tag + " 4 " + n);
    await shot(p, dev.name + "-" + n);
  }
  await p.evaluate(() => { document.body.classList.remove("fs"); document.getElementById("settings").hidden = true; TDC.searchUI.hide(); window.dispatchEvent(new Event("resize")); }); await W(400);

  // 5 contrast over a bright frame (Automatic)
  const lumaW = await p.evaluate(() => { const c = document.createElement("canvas"); c.width = c.height = 16; const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, 16, 16); return TDC.glass.sample(c); });
  const a = await p.evaluate(() => [TDC.glass.alpha, getComputedStyle(document.documentElement).getPropertyValue("--g-a").trim()]);
  ok(tag + " 5 Automatic: a white frame samples bright and sets the darkest tint", lumaW >= 0.95 && +a[1] >= 0.89, { lumaW, a });
  const dark = await p.evaluate(() => { const c = document.createElement("canvas"); c.width = c.height = 16; const g = c.getContext("2d"); g.fillStyle = "#111"; g.fillRect(0, 0, 16, 16); TDC.glass.sample(c); return TDC.glass.alpha; });
  ok(tag + " 5 Automatic: a dark frame gets a lighter tint (still >= 0.62)", dark < +a[1] && dark >= 0.62, { dark, bright: a[1] });
  await p.evaluate(() => { const c = document.createElement("canvas"); c.width = c.height = 16; const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, 16, 16); TDC.glass.sample(c); });
  await p.addStyleTag({ content: "#viewport video, #viewport canvas:not(.overlay-canvas):not(.rf-c) { filter: brightness(0) invert(1) !important; } #stage, #viewport, .tile { background: #fff !important; }" });
  await p.evaluate(() => TDC.toast("Bright frame toast", "ok", 60000));
  await p.hover("#viewport").catch(() => {}); await W(500);
  for (const sel of [".toast.show", ".stage-bar"]) {
    const c = await contrast(p, sel);
    if (!c) { console.log("SKIP " + tag + " 5 contrast " + sel + " (not on screen here)"); continue; }
    ok(tag + " 5 contrast over a white frame, " + sel + " text >= 4.5:1", c.ratio >= 4.5, c);
  }
  await p.evaluate(() => { document.getElementById("toast").classList.remove("show"); try { TDC.focus.focus("front"); } catch (_) {} TDC.regions.UI.draw(); }); await W(700);
  const cb = await contrast(p, "#crBar");
  if (cb) ok(tag + " 5 contrast over a white frame, draw bar text >= 4.5:1", cb.ratio >= 4.5, cb); else console.log("SKIP " + tag + " 5 contrast #crBar (not on screen)");
  await shot(p, dev.name + "-bright-frame");
  await p.evaluate(() => { try { TDC.regions.UI.cancel(); } catch (_) {} TDC.setPref("glass", "clear"); }); await W(300);
  const cc = await contrast(p, ".stage-bar"); if (cc) info(tag + " 5 Clear (user's choice, more see-through) camera bar contrast over white", cc);
  ok(tag + " 6 no page errors", errs.length === 0, errs.slice(0, 3));
  await ctx.close();
}
(async () => {
  if (!fs.existsSync(FIX + "/TeslaCam")) execFileSync("python3", [path.join(ROOT, "tools/make-mock-footage.py"), FIX], { stdio: "inherit" });
  const srv = await server(); const pw = require("playwright");
  const DEVS = [{ name: "desktop-1440x900", w: 1440, h: 900, touch: 0 }, { name: "desktop-1280x720", w: 1280, h: 720, touch: 0 }, { name: "phone-390x844", w: 390, h: 844, touch: 1 }, { name: "phone-844x390", w: 844, h: 390, touch: 1 }];
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    let b;
    try { b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }); }
    catch (e) { console.log("SKIP " + BR + ": cannot launch (" + e.message.split("\n")[0] + ")"); continue; }
    for (const d of DEVS.filter((d) => !process.env.DEV || d.name.startsWith(process.env.DEV))) { try { await run(b, BR, d); } catch (e) { ok(BR + " " + d.name + " run threw: " + e.message.split("\n")[0], false); } }
    await b.close();
  }
  srv.close(); console.log(fails ? "FAILED " + fails : "ALL PASSED"); process.exit(fails ? 1 : 0);
})();
