// ui-glass-9: Automatic glass follows the video, and Lite mode (js/glass.js, css/glass.css, Settings ▸ Appearance). This test checks:
//   1  the tint follows the picture under each glass piece: over a bright frame the pieces get a higher opacity and a warmer tint than over
//      a dark one (per piece --g-a / --g-rgb, class g-tinted), the global --g-a still follows the whole picture;
//   2  contrast: for every tinted piece, at every step of a bright -> dark -> bright -> mixed sequence, the dimmest glass text (#aeb6c2)
//      over the worst cell (brightest cell + sheen) stays >= 4.5:1; going darker eases down (<= 0.04 a step), going brighter is at once;
//      a steady frame changes nothing (no flicker);
//   3  the throttle: about 4 samples a second while playing, none while paused (one after a pause / seek), none with the tab hidden;
//      a sample costs one small canvas (<= innerWidth/16 x innerHeight/16) and one read;
//   4  Lite mode: Settings ▸ Appearance ▸ Lite mode Auto / On / Off clicks save the pref and switch html[data-lite], Solid look, no blur
//      anywhere (computed backdrop-filter), no video tint; ?lite=on / ?lite=0 win for one visit and say so;
//   5  auto-lite by a frame-time simulation (LiteMon.feed): 60 fps stays off; 30 fps for 3 s turns it on with a one-time toast and a note;
//      a seek or a resize in the middle restarts the 3 s; one long stall is not slowness; picking Auto again resets it; low memory
//      (navigator.deviceMemory = 1) turns it on at load; Off wins over both;
//   6  Reduce motion: a static tint (global --g-a .9, no per-piece tint); Reduce transparency: solid (Chromium CDP only);
//   7  1440x900 and 430x932, export untouched (TDC.exporter has no glass hook), no page errors.
//   Playwright, BR=chromium|webkit (default both), mock footage (/tmp/ho-mock). PORT (default 8829). ROOT=dir serves another checkout.
const fs = require("fs"), path = require("path"), http = require("http");
const ROOT = process.env.ROOT || path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", PORT = +(process.env.PORT || 8829);
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".onnx": "application/octet-stream", ".wasm": "application/wasm" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html"; fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; r.end(); return; } r.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }).listen(PORT, "127.0.0.1", () => res(s)); });
async function open(p, q, prefs) {
  await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1${q || ""}`, { waitUntil: "load" });
  await p.evaluate((pr) => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.setItem("tdc.prefs.v1", JSON.stringify(Object.assign({ advanced: true, autohide: "never" }, pr || {}))); sessionStorage.clear(); }, prefs);
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events.find((e) => e.cams.length === 6) || TDC.library.events[0]); }); await W(1500);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); document.getElementById("settings").hidden = true; if (TDC.focus && TDC.focus.dismissHint) TDC.focus.dismissHint(); }); await W(400);
}
// in-page helpers: mock frames (a canvas), the state of the tinted pieces, the contrast of the dimmest text over each
const HELP = () => {
  window.ug9 = {
    frame(fill) { const c = document.createElement("canvas"); c.width = 64; c.height = 40; const x = c.getContext("2d");
      if (typeof fill === "string") { x.fillStyle = fill; x.fillRect(0, 0, 64, 40); } else fill(x); return c; },
    pieces() { return [...document.querySelectorAll(".g-tinted")].map((e) => { const g = e._gt; return { k: (e._ug9k = e._ug9k || (window._ug9n = (window._ug9n || 0) + 1)), n: (e.id || e.className.split(" ")[0]), a: +e.style.getPropertyValue("--g-a"), rgb: e.style.getPropertyValue("--g-rgb").split(",").map(Number), max: g.max, need: g.need, as: g.as }; }); },
    ratio(pc) { const G = TDC.glass, S = 0.10, o = [0, 1, 2].map((i) => S * 255 + (1 - S) * (pc.a * pc.rgb[i] + (1 - pc.a) * pc.max[i]));
      const L = G.lum(...o), T = G.lum(0xae, 0xb6, 0xc2); return (T + 0.05) / (L + 0.05); },
  };
};
const stageA = (p) => p.evaluate(() => { const e = document.querySelector(".tile-label.g-tinted") || document.querySelector(".g-tinted"); return e ? { a: +e.style.getPropertyValue("--g-a"), rgb: e.style.getPropertyValue("--g-rgb") } : null; });
async function goAppearance(p) {
  if (await p.evaluate(() => document.getElementById("settings").hidden)) {   // the gear is Advanced-only and not in the phone bar; open it directly there
    if (await p.locator("#btnSettings").isVisible()) await p.click("#btnSettings"); else await p.evaluate(() => { document.getElementById("settings").hidden = false; });
    await W(350); }
  if (await p.evaluate(() => TDC.settings.view()) !== "home") { await p.click("#setBack"); await W(150); }
  await p.click('.set-grp[data-g="appearance"]'); await W(250);
}
const blurCount = (p) => p.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => { const cs = getComputedStyle(e); const f = cs.backdropFilter || cs.webkitBackdropFilter || "none"; return f !== "none" && e.getClientRects().length; }).length);

async function run(b, BR) {
  for (const [vw, vh] of [[1440, 900], [430, 932]]) {
    const T = `${BR} ${vw}x${vh}`, mobile = vw < 600;
    const ctx = await b.newContext({ viewport: { width: vw, height: vh }, ...(mobile ? { hasTouch: true, isMobile: BR === "chromium" } : {}) });
    const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message)); await p.addInitScript(HELP);
    await open(p);
    ok(T + " 0 Automatic glass, lite off by default (auto, not triggered under automation)", await p.evaluate(() => TDC.glass.effective === "auto" && TDC.glass.liteMode === "auto" && !TDC.glass.lite && !document.documentElement.dataset.lite));
    // 1 bright vs dark
    const dark = await p.evaluate(() => { const G = TDC.glass; G.sample(ug9.frame("rgb(18,22,44)")); for (let i = 0; i < 30; i++) G.tick(); return { luma: G.luma, root: getComputedStyle(document.documentElement).getPropertyValue("--g-a").trim(), pcs: ug9.pieces() }; });
    const bright = await p.evaluate(() => { const G = TDC.glass; G.sample(ug9.frame("rgb(240,226,170)")); return { luma: G.luma, root: getComputedStyle(document.documentElement).getPropertyValue("--g-a").trim(), pcs: ug9.pieces() }; });
    const pick = (o, n) => o.pcs.find((x) => x.n === n) || o.pcs[0];
    const names = dark.pcs.map((x) => x.n);
    ok(T + " 1 glass pieces over the video are tinted (" + [...new Set(names)].join(",") + ")", dark.pcs.length >= 3 && names.some((n) => /tile-label|stageBar|stage-bar/.test(n)), names);
    const dS = pick(dark, "stageBar"), bS = pick(bright, "stageBar");
    ok(T + " 1 over a bright frame the opacity is higher than over a dark one (" + dS.a + " -> " + bS.a + "), global too", bS.a > dS.a + 0.1 && +bright.root > +dark.root && bright.luma > dark.luma, { dS, bS, dark: dark.root, bright: bright.root });
    ok(T + " 1 the tint colour follows the picture (dark blue frame: bluer; bright warm frame: warmer)", dS.rgb[2] - dS.rgb[0] > bS.rgb[2] - bS.rgb[0], { d: dS.rgb, b: bS.rgb });
    // 2 contrast at every step, easing, no flicker
    const seq = await p.evaluate(() => {
      const G = TDC.glass, steps = [], frames = [["rgb(240,226,170)", 2], ["rgb(10,12,20)", 25], ["#ffffff", 3], [(x) => { x.fillStyle = "#101418"; x.fillRect(0, 0, 64, 40); x.fillStyle = "#f4f4f0"; x.fillRect(0, 0, 64, 14); }, 12], ["rgb(120,170,220)", 15]];
      let prev = null, maxDown = 0, upAtOnce = true, worst = 99, bad = null;
      for (const [f, n] of frames) { const c = ug9.frame(f); G.sample(c);
        for (let i = 0; i < n; i++) { if (i) G.tick(); const pcs = ug9.pieces();
          const st = new Map();
          for (const pc of pcs) { worst = Math.min(worst, ug9.ratio(pc)); st.set(pc.k, pc.a);
            const q = prev && prev.get(pc.k); if (q !== undefined) { if (pc.a < q) maxDown = Math.max(maxDown, q - pc.a); if (pc.a < pc.need - 0.001) { upAtOnce = false; bad = bad || { pc, q }; } } }
          prev = st; steps.push(st.size); } }
      // steady frame: nothing changes
      const before = ug9.pieces().map((x) => x.as + "|" + x.rgb.join(",")).join(";"); for (let i = 0; i < 6; i++) G.tick(); const after = ug9.pieces().map((x) => x.as + "|" + x.rgb.join(",")).join(";");
      return { worst, maxDown, upAtOnce, bad, steady: before === after, n: steps.length };
    });
    ok(T + " 2 contrast of the dimmest glass text stays >= 4.5:1 on every piece at every step (worst " + seq.worst.toFixed(2) + ")", seq.worst >= 4.5, seq);
    ok(T + " 2 darker eases down (<= 0.04 a step, max " + seq.maxDown.toFixed(3) + "), brighter is at once, a steady frame changes nothing", seq.maxDown <= 0.0401 && seq.upAtOnce && seq.steady, seq);
    // a real pixel check: the label text over a white frame with the per-piece tint, rendered
    const px = await p.evaluate(async () => { TDC.glass.sample(ug9.frame("#ffffff")); const e = document.querySelector(".tile-label.g-tinted"); if (!e) return null;
      return { a: +e.style.getPropertyValue("--g-a"), bg: getComputedStyle(e).backgroundColor }; });
    ok(T + " 2 a label over a white frame renders with its own (high) opacity", px && px.a >= 0.8 && /rgba?\(/.test(px.bg) && px.bg.includes(String(px.a).slice(0, 4).replace(/0+$/, "")), px);
    // 3 throttle (real video; unpinned)
    const thr = await p.evaluate(async () => { const G = TDC.glass, w = (ms) => new Promise((r) => setTimeout(r, ms)); G.sample(null); G.hz = 4; G.stats.slow = ""; G.stats.steady = 0; G.tintOn = true;
      const o = {}; let t = G.stats.ticks; TDC.player.play(); await w(2600); o.playing = G.stats.ticks - t; o.hz = G.hz;
      o.canvas = (() => { const W = Math.ceil(innerWidth / 16), H = Math.ceil(innerHeight / 16); return W * H; })();
      t = G.stats.ticks; TDC.player.pause(); await w(1500); o.paused = G.stats.ticks - t;
      t = G.stats.ticks; TDC.player.seek(1.2); await w(900); o.seek = G.stats.ticks - t;
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange"));
      t = G.stats.ticks; TDC.player.play(); await w(1600); o.hidden = G.stats.ticks - t; TDC.player.pause();
      delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); await w(400);
      o.ms = G.stats.avg; o.tinted = document.querySelectorAll(".g-tinted").length; return o; });
    ok(T + " 3 while playing it samples a few times a second (" + thr.playing + " in 2.6 s at " + thr.hz + " Hz), not every frame", thr.playing >= 2 && thr.playing <= 13, thr);
    ok(T + " 3 paused: no repeating samples (" + thr.paused + " in 1.5 s), one after a seek (" + thr.seek + "); tab hidden: none (" + thr.hidden + ")", thr.paused <= 2 && thr.seek >= 1 && thr.seek <= 2 && thr.hidden === 0, thr);
    ok(T + " 3 real video tints the pieces too (" + thr.tinted + "), one tick ~" + (thr.ms || 0).toFixed(1) + " ms", thr.tinted >= 3, thr);
    // 4 lite toggles
    await p.evaluate(() => TDC.glass.sample(ug9.frame("#ffffff")));
    await goAppearance(p);
    ok(T + " 4 Settings ▸ Appearance has Lite mode Auto / On / Off with Auto picked", await p.evaluate(() => { const s = document.getElementById("segLite"); return !!s && s.getClientRects().length > 0 && [...s.querySelectorAll("button")].map((b) => b.dataset.v + (b.getAttribute("aria-pressed") === "true" ? "*" : "")).join() === "auto*,on,off"; }));
    if (mobile) { const hs = await p.evaluate(() => [...document.querySelectorAll("#segLite button")].map((b) => b.getBoundingClientRect().height)); ok(T + " 4 lite buttons are >= 44 px on touch", hs.every((h) => h >= 43.5), hs); }
    await p.click('#segLite button[data-v="on"]'); await W(400);
    const on = await p.evaluate(() => ({ pref: JSON.parse(localStorage.getItem("tdc.prefs.v1")).lite, lite: document.documentElement.dataset.lite, eff: TDC.glass.effective, why: TDC.glass.why, tinted: document.querySelectorAll(".g-tinted").length, gblur: document.querySelectorAll(".g-blur").length, note: document.getElementById("glassNote").textContent }));
    const onBlur = await blurCount(p);
    ok(T + " 4 On: saved, html[data-lite=on], Solid look, no video tint, no blur anywhere (" + onBlur + ")", on.pref === "on" && on.lite === "on" && on.eff === "solid" && on.why === "lite" && on.tinted === 0 && on.gblur === 0 && onBlur === 0 && /Lite mode is on/.test(on.note), on);
    const tk = await p.evaluate(async () => { const t = TDC.glass.stats.ticks; TDC.player.play(); await new Promise((r) => setTimeout(r, 1200)); TDC.player.pause(); return TDC.glass.stats.ticks - t; });
    ok(T + " 4 On: no sampling while playing (" + tk + ")", tk === 0);
    await p.click('#segLite button[data-v="off"]'); await W(400);
    const off = await p.evaluate(() => ({ pref: JSON.parse(localStorage.getItem("tdc.prefs.v1")).lite, lite: document.documentElement.dataset.lite || "", eff: TDC.glass.effective }));
    ok(T + " 4 Off: saved, no data-lite, Automatic again", off.pref === "off" && off.lite === "" && off.eff === "auto", off);
    await p.click('#segLite button[data-v="auto"]'); await W(300);
    ok(T + " 4 Auto: saved", (await p.evaluate(() => JSON.parse(localStorage.getItem("tdc.prefs.v1")).lite)) === "auto");
    // 5 auto-lite simulation
    const sim = await p.evaluate(() => {
      const G = TDC.glass, L = G.liteMon, feed = (from, ms, dt, o) => { let t = from; for (; t < from + ms; t += dt) L.feed(t, Object.assign({ playing: true, seeking: false }, o || {})); return t; };
      const o = {}; L.reset(); L.holdUntil = 0; L.holdMs = 0;
      let t = feed(1000, 5000, 16.7); o.fast = G.lite;
      t = feed(t, 2500, 33); t = feed(t, 50, 33, { seeking: true }); t = feed(t, 2500, 33); o.seek = G.lite;
      t = feed(t + 2000, 2500, 33); window.dispatchEvent(new Event("resize")); t = feed(t, 2500, 33); o.resize = G.lite;
      t = feed(t + 2000, 1500, 33); t = feed(t + 900, 2000, 33); o.stall = G.lite;
      t = feed(t + 2000, 2000, 25); t = feed(t, 400, 16.7); t = feed(t, 2000, 25); o.recover = G.lite;
      t = feed(t + 2000, 3600, 33); o.slow = G.lite; o.auto = G.autoLite; o.data = document.documentElement.dataset.lite;
      o.note = document.getElementById("liteNote").textContent; o.eff = G.effective;
      o.toast = [...document.querySelectorAll(".toast")].map((e) => e.textContent).join("|");
      return o; });
    ok(T + " 5 60 fps stays full glass; a seek, a resize, a long stall or a recovery to 60 fps restart the 3 s", !sim.fast && !sim.seek && !sim.resize && !sim.stall && !sim.recover, sim);
    ok(T + " 5 30 fps for 3 s turns Lite on (auto, slow) with a toast and a note", sim.slow && sim.auto === "slow" && sim.data === "slow" && sim.eff === "solid" && /Lite mode is on/.test(sim.toast) && /dropping frames/.test(sim.note), sim);
    const again = await p.evaluate(() => { const n = sessionStorage.getItem("tdc.liteSaid"); TDC.glass.autoLite = ""; TDC.glass.goLite("slow"); return n; });
    await p.click('#segLite button[data-v="on"]'); await W(200); await p.click('#segLite button[data-v="auto"]'); await W(300);
    const reset = await p.evaluate(() => ({ lite: TDC.glass.lite, auto: TDC.glass.autoLite, data: document.documentElement.dataset.lite || "" }));
    ok(T + " 5 the toast is once a session; picking Auto again resets auto-lite", again === "1" && !reset.lite && reset.auto === "" && reset.data === "", { again, reset });
    const live = await p.evaluate(async () => { const G = TDC.glass; G.autoLiteFps = true; G.liteMon.reset(); TDC.player.play(); await new Promise((r) => setTimeout(r, 2500)); const f = G.liteMon.fps; TDC.player.pause(); G.autoLiteFps = false; G.autoLite = ""; G.apply(); return f; });
    ok(T + " 5 the live monitor measures frame rate while playing (" + live.toFixed(0) + " fps)", live > 0, live);
    ok(T + " 7 export has no glass hook (tint is UI only)", await p.evaluate(() => !/glass|g-tinted/.test(String(TDC.exporter && TDC.exporter.start || "")) && !document.querySelector("canvas.g-tinted")));
    ok(T + " 7 no page errors", errs.length === 0, errs);
    await ctx.close();
    // overrides + low memory
    const c2 = await b.newContext({ viewport: { width: vw, height: vh } }); const p2 = await c2.newPage(); const e2 = []; p2.on("pageerror", (e) => e2.push(e.message));
    await open(p2, "&lite=on");
    const ov = await p2.evaluate(() => ({ lite: document.documentElement.dataset.lite, pref: TDC.prefs.lite, note: document.getElementById("liteNote").textContent, eff: TDC.glass.effective }));
    ok(T + " 4 ?lite=on wins for the visit without saving, and says so", ov.lite === "on" && ov.pref === "auto" && /\?lite=/.test(ov.note) && ov.eff === "solid", ov);
    await open(p2, "&lite=0", { lite: "on" });
    const ov0 = await p2.evaluate(() => ({ lite: document.documentElement.dataset.lite || "", pref: TDC.prefs.lite, eff: TDC.glass.effective }));
    ok(T + " 4 ?lite=0 turns a saved On off for the visit", ov0.lite === "" && ov0.pref === "on" && ov0.eff === "auto", ov0);
    await c2.close();
    const c3 = await b.newContext({ viewport: { width: vw, height: vh } }); const p3 = await c3.newPage();
    await p3.addInitScript(() => { try { Object.defineProperty(Navigator.prototype, "deviceMemory", { configurable: true, get: () => 1 }); } catch (_) {} });
    await open(p3);
    const lm = await p3.evaluate(() => ({ lite: document.documentElement.dataset.lite, auto: TDC.glass.autoLite, note: (document.getElementById("liteNote") || {}).textContent }));
    await p3.evaluate(() => TDC.setPref("lite", "off")); await W(200);
    const lmOff = await p3.evaluate(() => document.documentElement.dataset.lite || "");
    ok(T + " 5 low memory (deviceMemory 1) turns Auto lite on at load; Off wins", lm.lite === "low-memory" && /little memory/.test(lm.note) && lmOff === "", { lm, lmOff });
    await c3.close();
    // 6 reduced motion / transparency
    const c4 = await b.newContext({ viewport: { width: vw, height: vh }, reducedMotion: "reduce" }); const p4 = await c4.newPage(); await p4.addInitScript(HELP);
    await open(p4);
    const rm = await p4.evaluate(() => { TDC.glass.sample(ug9.frame("rgb(18,22,44)")); const a1 = getComputedStyle(document.documentElement).getPropertyValue("--g-a").trim(); TDC.glass.sample(ug9.frame("#fff")); return { a1, a2: getComputedStyle(document.documentElement).getPropertyValue("--g-a").trim(), tinted: document.querySelectorAll(".g-tinted").length, eff: TDC.glass.effective }; });
    ok(T + " 6 Reduce motion: static tint (.9 over dark and bright), no per-piece tint", rm.eff === "auto" && +rm.a1 === 0.9 && +rm.a2 === 0.9 && rm.tinted === 0, rm);
    if (BR === "chromium") {
      const cdp = await c4.newCDPSession(p4); await p4.emulateMedia({ reducedMotion: "no-preference" });
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] }); await W(400);
      const rt = await p4.evaluate(() => { TDC.glass.apply(); TDC.glass.sample(ug9.frame("#fff")); return { eff: TDC.glass.effective, tinted: document.querySelectorAll(".g-tinted").length }; });
      ok(T + " 6 Reduce transparency: solid, no per-piece tint", rt.eff === "solid" && rt.tinted === 0, rt);
    } else console.log("SKIP " + T + " 6 reduce transparency (Chromium CDP only)");
    await c4.close();
  }
}
(async () => {
  const pw = require("playwright"); const s = await server();
  const brs = (process.env.BR || "chromium,webkit").split(",");
  for (const BR of brs) {
    let b; try { b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || (fs.existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined), args: ["--autoplay-policy=no-user-gesture-required"] }); }
    catch (e) { console.log("SKIP " + BR + ": " + e.message.split("\n")[0]); continue; }
    try { await run(b, BR); } catch (e) { ok(BR + " run threw", false, e.stack); } finally { await b.close(); }
  }
  s.close(); console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})();
