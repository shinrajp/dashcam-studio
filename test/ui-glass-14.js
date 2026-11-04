// ui-glass-14 (owner t224u / t225u / t226u):
//   1  Glass sliders in Settings ▸ Appearance with Debug off: Blur, Strength, Tint, Tint colour (Neutral / Colour), Panel opacity, Reset;
//      moving one switches Glass to Custom (Automatic / Clear / Solid still work), saved on release, survives a reload, Reset -> Automatic;
//      ?gcolor= sets the tint colour for the visit; readable sheets by default (panel >= 0.7; frosted drawer >= 0.85)
//   2  the telemetry HUD floats: drag its grip out of the video -> window-level, compact, saved per layout (prefs.hudFloat), survives a
//      reload; dropped back on the video it docks; Enter on the grip floats / docks; export prefs (panels.hud) untouched
//   3  Play / Pause keeps responding: 3+ rounds of play / pause by tapping where the button is after auto-hide faded the controls, after a
//      glass change and after the clip ended; Space bar too; the full-screen button still toggles full screen
//   4  no page errors.  Playwright, BR=chromium|webkit (default chromium), mock footage (/tmp/ho-mock). PORT (default 8834).
const fs = require("fs"), path = require("path"), http = require("http");
const ROOT = process.env.ROOT || path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", FIXP = process.env.FIXP || "/tmp/photo-mock", PORT = +(process.env.PORT || 8834);
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

const ST = () => { const $ = (id) => document.getElementById(id), cs = getComputedStyle(document.documentElement), pr = JSON.parse(localStorage.getItem("tdc.prefs.v1") || "{}");
  const alpha = (e) => { if (!e) return -1; const m = getComputedStyle(e).backgroundImage + " " + getComputedStyle(e).backgroundColor; const all = [...m.matchAll(/rgba?\(([^)]+)\)/g)].map((x) => x[1].split(",").map(Number)); const a = all.map((v) => v.length > 3 ? v[3] : 1); return a.length ? Math.max(...a) : -1; };
  return { pick: document.documentElement.dataset.glassPick, eff: document.documentElement.dataset.glass, pref: TDC.prefs.glass, savedGlass: pr.glass, saved: pr.glassTune || null, cur: TDC.glassTune.get(),
    rgb: cs.getPropertyValue("--g-rgb").trim(), panelF: cs.getPropertyValue("--g-panel-f").trim(), tune: TDC.refract.tune(), refr: document.documentElement.classList.contains("refract"),
    segOn: [...document.querySelectorAll("#segGlass button")].filter((b) => b.classList.contains("on")).map((b) => b.dataset.v),
    rows: ["gtBlur", "gtStr", "gtTint", "gtSheet", "glassTint", "gtColorSeg", "gtReset"].map((id) => { const e = $(id); return { id, vis: !!e && e.getClientRects().length > 0, v: e && e.value }; }),
    colorOn: [...document.querySelectorAll("#gtColorSeg button.on")].map((b) => b.dataset.v), drawerA: alpha($("settings")),
    sheetA: (TDC.refract.pieces.find((x) => x.kind === "sheet" && x.host.id === "settings") || { host: {} }).host._rft };
};
const showApp = (p) => p.evaluate(() => { TDC.settings.show("appearance"); });
const slide = (p, id, v, commit) => p.evaluate(([id, v, c]) => { const e = document.getElementById(id); e.value = String(v); e.dispatchEvent(new Event("input", { bubbles: true })); if (c) e.dispatchEvent(new Event("change", { bubbles: true })); }, [id, v, commit]);
const HUD = () => { const e = document.getElementById("panel-hud"), g = document.getElementById("hudGrip"), vp = document.getElementById("viewport"), r = e && e.getBoundingClientRect(), gr = g && g.getBoundingClientRect(), v = vp && vp.getBoundingClientRect();
  return { shown: !!e && !e.hidden && r.width > 0, floating: !!e && e.classList.contains("hud-floating"), inBody: !!e && e.parentElement === document.body, dock: TDC.prefs.hudDock, hf: TDC.prefs.hudFloat, panel: { ...TDC.prefs.panels.hud },
    r: r && { l: r.left, t: r.top, w: r.width, h: r.height }, g: gr && { x: gr.left + gr.width / 2, y: gr.top + gr.height / 2 }, v: v && { l: v.left, t: v.top, r: v.right, b: v.bottom, w: v.width, h: v.height },
    saved: (JSON.parse(localStorage.getItem("tdc.prefs.v1") || "{}")) };
};
async function drag(p, from, to) { await p.mouse.move(from[0], from[1]); await p.mouse.down(); const n = 14;
  for (let i = 1; i <= n; i++) { await p.mouse.move(from[0] + (to[0] - from[0]) * i / n, from[1] + (to[1] - from[1]) * i / n); await W(16); }
  await W(120); await p.mouse.up(); await W(500); }
async function run(b, BR) {
  const mk = async (vw, vh, touch) => { const ctx = await b.newContext({ viewport: { width: vw, height: vh }, ...(touch ? { hasTouch: true, isMobile: BR === "chromium" } : {}) });
    const p = await ctx.newPage(); p._errs = []; p.on("pageerror", (e) => p._errs.push(e.message)); return { ctx, p }; };
  for (const [vw, vh, touch] of [[1440, 900, false], [430, 932, true]]) {
    const T = `${BR} ${vw}x${vh}`; let { ctx, p } = await mk(vw, vh, touch), s;
    // ---------- 1 glass ----------
    await open(p); await showApp(p); await W(700); s = await p.evaluate(ST);
    ok(T + " 1 Glass sliders visible with Debug off (Blur, Strength, Tint, Tint colour, Panel opacity, Reset)", s.rows.filter((r) => r.id !== "gtStr" || s.refr).every((r) => r.vis), s.rows);
    ok(T + " 1 defaults: Automatic, 4 / 1 / 0.22 / 0.72, neutral", s.pick === "auto" && s.cur.blur === 4 && s.cur.str === 1 && s.cur.tint === 0.22 && s.cur.sheet === 0.72 && s.cur.color === "" && s.colorOn.join() === "neutral", s);
    ok(T + " 1 readable by default: Settings panel >= 0.7 (refraction backing) / frosted drawer >= 0.85", (s.refr ? s.sheetA && s.sheetA.a >= 0.7 : s.drawerA >= 0.85) && +s.panelF >= 0.85, { refr: s.refr, sheetA: s.sheetA, drawerA: s.drawerA, panelF: s.panelF });
    await slide(p, "gtTint", 0.5, false); await W(300); s = await p.evaluate(ST);
    ok(T + " 1 a live slider move switches Glass to Custom (segment shows it) without saving", s.pick === "custom" && s.segOn.join() === "custom" && s.tune.tint === 0.5 && s.savedGlass !== "custom", s);
    await slide(p, "gtTint", 0.5, true); await slide(p, "gtBlur", 6, true); await slide(p, "gtSheet", 0.8, true); await W(300); s = await p.evaluate(ST);
    ok(T + " 1 release saves glass=custom and prefs.glassTune", s.savedGlass === "custom" && s.saved && s.saved.tint === 0.5 && s.saved.blur === 6 && s.saved.sheet === 0.8, s);
    await p.evaluate(() => { const i = document.getElementById("glassTint"); i.value = "#336699"; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); }); await W(300); s = await p.evaluate(ST);
    ok(T + " 1 Tint colour: picking a colour sets --g-rgb and the refraction tint", s.rgb.replace(/\s/g, "") === "51,102,153" && s.tune.rgb.join() === "51,102,153" && s.colorOn.join() === "colour" && s.saved.color === "#336699", s);
    await p.reload({ waitUntil: "load" }); await W(1500); await showApp(p); await W(600); s = await p.evaluate(ST);
    ok(T + " 1 Custom glass survives a reload", s.pick === "custom" && s.cur.tint === 0.5 && s.cur.blur === 6 && s.cur.color === "#336699" && s.rgb.replace(/\s/g, "") === "51,102,153", s);
    await p.click('#segGlass button[data-v="solid"]'); await W(400); s = await p.evaluate(ST);
    ok(T + " 1 Solid still works (sliders kept, no colour tint on Solid)", s.eff === "solid" && s.pref === "solid" && s.saved.tint === 0.5 && s.rgb.replace(/\s/g, "") !== "51,102,153", s);
    await p.click('#segGlass button[data-v="clear"]'); await W(400); s = await p.evaluate(ST);
    ok(T + " 1 Clear still works", s.eff === "clear" && s.segOn.join() === "clear", s);
    await p.click("#gtReset"); await W(400); s = await p.evaluate(ST);
    ok(T + " 1 Reset: defaults, neutral, Glass back to Automatic only from Custom (Clear kept)", s.cur.tint === 0.22 && s.cur.blur === 4 && s.cur.sheet === 0.72 && s.cur.color === "" && s.pref === "clear", s);
    await slide(p, "gtStr", 1.4, true); await W(200); await p.click("#gtReset"); await W(400); s = await p.evaluate(ST);
    ok(T + " 1 Reset from Custom returns to Automatic", s.pref === "auto" && s.savedGlass === "auto" && s.cur.str === 1, s);
    ok(T + " 4 no page errors (glass)", p._errs.length === 0, p._errs);
    await ctx.close();
    ({ ctx, p } = await mk(vw, vh, touch));
    await open(p, "&gcolor=ff0000"); await showApp(p); await W(600); s = await p.evaluate(ST);
    ok(T + " 1 ?gcolor=ff0000 sets the tint colour for the visit (nothing saved)", s.rgb.replace(/\s/g, "") === "255,0,0" && (!s.saved || !s.saved.color), s);
    await ctx.close();
    // ---------- 2 floating HUD ----------
    ({ ctx, p } = await mk(vw, vh, touch));
    await open(p, "", { show: { labels: true, hud: true, map: false, fsd: true, time: true } });
    await p.evaluate(() => { TDC.player.seek(1); TDC.overlays.render(); }); await W(500);
    let h = await p.evaluate(HUD);
    ok(T + " 2 HUD shown on the video with a grip", h.shown && !h.floating && !!h.g, h);
    if (h.shown && h.g) {
      const panel0 = JSON.stringify(h.panel);
      const target = vw > vh ? [Math.max(30, h.v.l - 10 < 200 ? 30 : h.v.l / 2), 120] : [40, Math.min(vh - 220, h.v.b + 60)];
      await drag(p, [h.g.x, h.g.y], target); h = await p.evaluate(HUD);
      const lay = vw > vh ? "landscape" : "portrait";
      ok(T + " 2 dragged out it floats (window-level, compact) and is saved for this layout", h.floating && h.inBody && h.dock === "float" && h.saved.hudDock === "float" && h.saved.hudFloat && h.saved.hudFloat[lay] && h.saved.hudFloat[lay].pin === 1 && h.r.w <= Math.max(360, vw * 0.62) + 1, h);
      ok(T + " 2 export placement (panels.hud) unchanged", JSON.stringify(h.panel) === panel0, { before: panel0, after: h.panel });
      const r1 = h.r; await p.reload({ waitUntil: "load" }); await W(800); await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
      for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
      await p.evaluate(() => { TDC.ui.activate(TDC.library.events.find((e) => e.cams.length === 6) || TDC.library.events[0]); }); await W(1500);
      await p.evaluate(() => { TDC.player.pause(); TDC.player.seek(1); document.getElementById("settings").hidden = true; TDC.overlays.render(); }); await W(600);
      h = await p.evaluate(HUD);
      ok(T + " 2 the floating spot survives a reload", h.floating && Math.abs(h.r.l - r1.l) < 3 && Math.abs(h.r.t - r1.t) < 3, { r1, r: h.r });
      const sr = await p.evaluate(() => { const r = TDC.overlays.stage.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height * 0.7]; });
      await drag(p, [h.g.x, h.g.y], sr); h = await p.evaluate(HUD);
      ok(T + " 2 dropped back on the video it docks", !h.floating && h.dock === "over" && !h.inBody, h);
      await p.focus("#hudGrip"); await p.keyboard.press("Enter"); await W(400); h = await p.evaluate(HUD);
      ok(T + " 2 Enter on the grip floats it", h.floating && h.dock === "float", h);
      await p.keyboard.press("Enter"); await W(400); h = await p.evaluate(HUD);
      ok(T + " 2 Enter again docks it", !h.floating && h.dock === "over", h);
    }
    ok(T + " 4 no page errors (HUD)", p._errs.length === 0, p._errs);
    await ctx.close();
    // ---------- 3 play / pause ----------
    ({ ctx, p } = await mk(vw, vh, touch));
    await open(p, "", { autohide: "2" });
    const st = () => p.evaluate(() => ({ playing: TDC.player.playing, t: +TDC.player.time.toFixed(2), idle: document.body.classList.contains("idle") }));
    const tap = async () => { const r = await p.evaluate(() => { const r = document.getElementById("btnPlay").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
      if (touch) await p.touchscreen.tap(r[0], r[1]); else await p.mouse.click(r[0], r[1]); await W(350); };
    let good = 0, log = [];
    for (let i = 0; i < 3; i++) {
      await tap(); let a = await st(); if (touch) { await W(2900); a = { ...(await st()), was: a }; }   // let auto-hide fade the controls (touch)
      await tap(); const c = await st(); log.push({ a, c }); if (a.playing && !c.playing) good++;
      if (i === 1) { await showApp(p); await W(300); await slide(p, "gtTint", 0.4, true); await p.evaluate(() => TDC.settings && TDC.settings.hide ? TDC.settings.hide() : (document.getElementById("settings").hidden = true)); await W(400); }
    }
    ok(T + " 3 play / pause 3 rounds" + (touch ? " (pause tapped after auto-hide faded the controls)" : "") + ", incl. after a glass change", good === 3 && (!touch || log.every((x) => x.a.idle)), log);
    await p.evaluate(() => TDC.player.seek(TDC.player.duration() - 0.6)); await tap(); await W(1600); const e1 = await st();
    await tap(); const e2 = await st(); await tap(); const e3 = await st();
    ok(T + " 3 after the clip ends, Play plays again and Pause pauses", !e1.playing && e2.playing && !e3.playing, { e1, e2, e3 });
    await p.mouse.click(5, 5).catch(() => {}); await p.evaluate(() => document.activeElement && document.activeElement.blur());
    await p.keyboard.press("Space"); await W(300); const k1 = await st(); await p.keyboard.press("Space"); await W(300); const k2 = await st();
    ok(T + " 3 Space bar plays / pauses", k1.playing !== k2.playing, { k1, k2 });
    if (k2.playing) await p.keyboard.press("Space");
    const fs0 = await p.evaluate(() => document.body.classList.contains("fs"));
    await p.evaluate(() => document.getElementById("btnFsStage").click()); await W(700);
    const fs1 = await p.evaluate(() => document.body.classList.contains("fs"));
    await tap(); const f1 = await st(); await tap(); const f2 = await st();
    ok(T + " 3 full-screen button toggles full screen and Play / Pause works there", fs1 !== fs0 && f1.playing !== f2.playing, { fs0, fs1, f1, f2 });
    ok(T + " 4 no page errors (play / pause)", p._errs.length === 0, p._errs);
    await ctx.close();
  }
}
(async () => {
  const pw = require("playwright"); const s = await server();
  for (const BR of (process.env.BR || "chromium").split(",")) {
    const b = BR === "chromium" ? await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] }) : await pw.webkit.launch();
    try { await run(b, BR); } catch (e) { ok(BR + " run", false, String(e && e.stack || e)); }
    await b.close();
  }
  s.close(); console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})();
