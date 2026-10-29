// ui-quick (tag ui-quick): (A) "Show 360 view (beta)" setting, off by default; (B) the Search / Redact window scrolls and resizes vertically;
// (C) the draw bar's Options button is a toggle.   Playwright, Chromium (system Chrome) and WebKit (BR=chromium|webkit), desktop 1280x800 + phone 390x844.
// Mock footage only (tools/make-mock-footage.py, made into /tmp/ho-mock on first run). Serves the repo itself on PORT (default 8797).
//   A. 360: hidden by default (button, export preset, no pano.js request); Settings row; turning it on shows both and survives a reload; turning it off
//      again leaves the 360 view first and moves a selected 360 preset to Most Compatible; a saved 360 preset with the setting off opens as Most
//      Compatible; ?show360=1 / =0 override for the visit only; Reset all settings hides it again; the other export presets stay. Settings ▸ Calibration only shows while 360 is on (t213u).
//   B. panel: with 3+ regions saved, the Custom regions section is reachable by scrolling (docked, floating, phone sheet, short window); the header
//      stays put (sticky); the floating window grows past the old 620 px cap up to the screen height by dragging its corner, the bottom edge stays on
//      screen, no horizontal scrollbar.   C. Options toggles the panel and the label follows.
// Usage: BR=chromium|webkit node test/ui-quick.js    SHOTS=dir writes mock-data screenshots
const fs = require("fs"), path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", PORT = +(process.env.PORT || 8797), SHOTS = process.env.SHOTS || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 800) : "")); if (!c) fails++; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".onnx": "application/octet-stream", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html"; fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; return r.end(); } r.setHeader("Content-Type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }).listen(PORT, "127.0.0.1", () => res(s)); });
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const BASE = `http://127.0.0.1:${PORT}/index.html?nosw=1`;

async function openEvent(p, q, keep) {
  await p.goto(BASE + (q || ""), { waitUntil: "load" });
  if (!keep) { await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.prefs.v1"); localStorage.removeItem("tdc.regions.v1"); localStorage.removeItem("tdc.searchPanel.v1"); }); await p.reload({ waitUntil: "load" }); }
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events[0]); }); await W(1500);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); });
}
const vis = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return !e.hidden && getComputedStyle(e).display !== "none" && r.width > 0 && r.height > 0; }, sel);
const addRegions = (p, n) => p.evaluate((n) => { for (let i = 0; i < n; i++) TDC.regions.add({ cam: ["back", "front", "left_repeater", "right_repeater"][i % 4], shape: "rect", mode: i % 2 ? "remove" : "blur", x: 0.1 + 0.05 * i, y: 0.2, w: 0.2, h: 0.1 }); return TDC.regions.list.length; }, n);
const openExportDlg = async (p) => { await p.evaluate(() => document.getElementById("btnExport").click()); await W(500); };
const closeExportDlg = (p) => p.evaluate(() => { document.getElementById("exportModal").hidden = true; });
const advOn = async (p) => { await p.evaluate(() => { const c = document.getElementById("advToggle"); if (!c.checked) c.click(); }); await W(300); };
const calibShown = (p) => p.evaluate(() => { const s = document.getElementById("settings"), was = s.hidden; s.hidden = false; const v = [...document.querySelectorAll("#settings h3")].some((h) => h.textContent === "Calibration" && h.getBoundingClientRect().height > 0); s.hidden = was; return v; });
const settingsOpen = (p, on) => p.evaluate((on) => { document.getElementById("settings").hidden = !on; }, on);

async function partA(b, dev, tag) {
  const ctx = await b.newContext(dev.ctx); const p = await ctx.newPage(); const reqs = []; p.on("request", (r) => reqs.push(r.url())); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await openEvent(p, "");
  await advOn(p);
  ok(tag + " A1 default: show360 pref is false", (await p.evaluate(() => TDC.prefs.show360)) === false);
  ok(tag + " A1 default: 360 button hidden", !(await vis(p, "#btn360")));
  ok(tag + " A1 default: no pano.js request", !reqs.some((u) => /\/pano\.js/.test(u)) && (await p.evaluate(() => !TDC.pano)));
  await openExportDlg(p);
  const pre = await p.evaluate(() => [...document.querySelectorAll("input[name=preset]")].map((r) => ({ v: r.value, shown: r.closest("label").getBoundingClientRect().height > 0 })));
  ok(tag + " A1 default: export presets are Compatible + Original only", pre.filter((x) => x.shown).map((x) => x.v).join() === "compat,original", pre);
  ok(tag + " A1 default: other 360-only things not reachable (no Calibrate / look-around without the view)", !(await vis(p, "#panoWrap")) && !(await vis(p, "#panoCalibPanel")));
  await closeExportDlg(p);
  await settingsOpen(p, true); await W(200);
  const row = await p.evaluate(() => { const c = document.getElementById("show360"); return c ? { checked: c.checked, label: c.closest(".row").textContent.trim(), hint: !!c.closest("section").querySelector(".hint") } : null; });
  ok(tag + " A2 Settings row 'Show 360 view (beta)' with a hint, unticked", !!row && row.checked === false && /Show 360 view \(beta\)/.test(row.label) && row.hint, row);
  ok(tag + " A2 360 off: Calibration section hidden in Settings", !(await calibShown(p)));
  if (SHOTS && tag.includes("desktop")) { await p.evaluate(() => document.getElementById("show360").scrollIntoView({ block: "center" })); await W(200); await p.screenshot({ path: SHOTS + "/settings-show360-" + tag.replace(/\W+/g, "-") + ".png" }); }
  await p.evaluate(() => document.getElementById("show360").click()); await W(400);
  ok(tag + " A3 on: Calibration section back in Settings", await calibShown(p));
  ok(tag + " A3 ticking it saves the pref and shows the button", (await p.evaluate(() => TDC.prefs.show360 === true && JSON.parse(localStorage.getItem("tdc.prefs.v1")).show360 === true)) && (await vis(p, "#btn360")));
  await settingsOpen(p, false);
  await openExportDlg(p);
  ok(tag + " A3 on: 360 export preset shown", await vis(p, "#presetEquirect"));
  await p.evaluate(() => { document.querySelector("input[name=preset][value=equirect]").click(); }); await W(200);
  ok(tag + " A3 on: 360 preset selectable", (await p.evaluate(() => document.querySelector("input[name=preset]:checked").value)) === "equirect");
  await closeExportDlg(p);
  await p.reload({ waitUntil: "load" }); await W(500);
  ok(tag + " A4 after reload: still on (button shown)", (await p.evaluate(() => TDC.prefs.show360)) === true && (await vis(p, "#btn360")) || !(await p.evaluate(() => TDC.library.events.length)) && (await p.evaluate(() => { const b = document.getElementById("btn360"); return !b.hidden; })));
  // 360 view on, then switch the setting off: the view is left first; a selected 360 preset moves to Compatible
  await openEvent(p, "", true); await advOn(p);
  ok(tag + " A4 reopened event: button shown", await vis(p, "#btn360"));
  const opened = await p.evaluate(async () => { const v = await TDC.toggle360(true); await new Promise((r) => setTimeout(r, 1200)); return { v, on: !!(TDC.pano && TDC.pano.on) }; });
  if (opened.on) {
    await p.evaluate(() => TDC.setPref("show360", false)); await W(500);
    ok(tag + " A5 off while the 360 view is open: view closed, button hidden", (await p.evaluate(() => !TDC.pano.on && document.getElementById("panoWrap").hidden && !document.getElementById("stage").classList.contains("pano-on"))) && !(await vis(p, "#btn360")));
    ok(tag + " A5 grid tiles are back", await p.evaluate(() => [...document.querySelectorAll("#grid .tile")].some((t) => t.offsetWidth > 60)));
  } else console.log("INFO " + tag + " 360 view could not open here (WebGL?); close-while-open check skipped");
  await p.evaluate(() => TDC.setPref("show360", true)); await openExportDlg(p);
  await p.evaluate(() => { document.querySelector("input[name=preset][value=equirect]").click(); }); await p.evaluate(() => TDC.setPref("show360", false)); await W(300);
  ok(tag + " A5 off with the 360 preset selected: moves to Most Compatible", (await p.evaluate(() => document.querySelector("input[name=preset]:checked").value)) === "compat" && !(await vis(p, "#presetEquirect")));
  await closeExportDlg(p);
  // a saved 360 preset + setting off
  await p.evaluate(() => { TDC.prefs.export.preset = "equirect"; TDC.savePrefs(); });
  await openExportDlg(p);
  ok(tag + " A6 saved 360 preset with the setting off opens as Most Compatible", (await p.evaluate(() => document.querySelector("input[name=preset]:checked").value)) === "compat");
  await closeExportDlg(p);
  // deep links
  await p.evaluate(() => { TDC.prefs.export.preset = "compat"; TDC.savePrefs(); });
  await openEvent(p, "&show360=1", true); await advOn(p);
  ok(tag + " A7 ?show360=1 shows the button for this visit without saving the pref", (await vis(p, "#btn360")) && (await p.evaluate(() => TDC.prefs.show360)) === false);
  ok(tag + " A7 ?show360=1 also shows Calibration", await calibShown(p));
  await p.evaluate(() => TDC.setPref("show360", true));
  await openEvent(p, "&show360=0", true); await advOn(p);
  ok(tag + " A7 ?show360=0 hides it even when the setting is on", !(await vis(p, "#btn360")) && (await p.evaluate(() => TDC.prefs.show360)) === true);
  ok(tag + " A7 ?show360=0 also hides Calibration", !(await calibShown(p)));
  // reset all
  await openEvent(p, "", true); await advOn(p);
  ok(tag + " A8 (setting on) button shown", await vis(p, "#btn360"));
  await settingsOpen(p, true); await p.evaluate(() => document.getElementById("btnResetAll").click()); await W(400);
  ok(tag + " A8 Reset all settings hides it again", !(await vis(p, "#btn360")) && (await p.evaluate(() => document.getElementById("show360").checked === false)));
  ok(tag + " A8 Reset all settings hides Calibration again", !(await calibShown(p)));
  // keyboard shortcuts: nothing for 360 throws
  await p.keyboard.press("3"); await p.keyboard.press("6"); await p.keyboard.press("0");
  ok(tag + " A9 no page errors", errs.length === 0, errs);
  await ctx.close();
}

const geo = (p) => p.evaluate(() => {
  const e = document.getElementById("usPanel"), r = e.getBoundingClientRect(), h = document.getElementById("usHead").getBoundingClientRect(), f = document.getElementById("crFileRow").getBoundingClientRect(), cs = getComputedStyle(e);
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, h: r.height, scrollTop: e.scrollTop, scrollH: e.scrollHeight, clientH: e.clientHeight, headTop: h.top, headH: h.height, fileTop: f.top, fileBottom: f.bottom, vw: innerWidth, vh: innerHeight, hx: e.scrollWidth > e.clientWidth + 1, ov: cs.overflowY, cls: e.className };
});
const scrollPanel = (p, y) => p.evaluate((y) => { const e = document.getElementById("usPanel"); e.scrollTop = y; return e.scrollTop; }, y);
async function partB(b, dev, tag) {
  const ctx = await b.newContext(dev.ctx); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await openEvent(p, "");
  ok(tag + " B0 saved 3+ regions", (await addRegions(p, 4)) === 4);
  await p.click("#rdBtn"); await W(500);
  await p.evaluate(() => { document.getElementById("crSec").open = true; }); await W(400);
  let g = await geo(p);
  ok(tag + " B1 docked: panel scrolls (overflow-y auto) and the file row is within the viewport after scrolling to the bottom", g.ov === "auto", g);
  await scrollPanel(p, 99999); await W(150); g = await geo(p);
  if (SHOTS) await p.screenshot({ path: SHOTS + "/panel-docked-scrolled-to-custom-regions-" + tag.replace(/\W+/g, "-") + ".png" });
  const dockInView = g.fileBottom <= g.vh + 1 && g.fileBottom <= g.b + 1 && g.fileTop >= g.t - 1;
  ok(tag + " B1 docked: Custom regions' last row reachable (visible inside the panel and the screen)", dockInView, g);
  // a short window forces the cap
  await p.setViewportSize({ width: dev.ctx.viewport.width, height: dev.short }); await W(500);
  await scrollPanel(p, 0); g = await geo(p);
  ok(tag + " B2 short window (" + dev.short + " px): docked panel is capped below the screen height (" + Math.round(g.h) + " px)", g.h < g.vh - 60, g);
  await scrollPanel(p, 99999); await W(150); g = await geo(p);
  ok(tag + " B2 short window: last row reachable by scrolling", g.scrollTop > 0 && g.fileBottom <= g.b + 1 && g.fileBottom <= g.vh + 1, g);
  ok(tag + " B2 short window: header stays at the top of the panel while scrolled (sticky)", Math.abs(g.headTop - g.t) <= 3, g);
  await p.setViewportSize(dev.ctx.viewport); await W(400);
  // phone sheet (typing): simulate the sheet class + visual viewport height as the keyboard does
  await p.evaluate(() => { const e = document.getElementById("usPanel"); e.classList.add("sheet"); e.style.setProperty("--us-vvh", Math.round(innerHeight * 0.55) + "px"); }); await W(300);
  await scrollPanel(p, 0); g = await geo(p);
  ok(tag + " B3 sheet: capped to the room above the keyboard (" + Math.round(g.h) + " px)", g.h <= g.vh * 0.62 + 2, g);
  await scrollPanel(p, 99999); await W(150); g = await geo(p);
  ok(tag + " B3 sheet: last row reachable by scrolling", g.fileBottom <= g.b + 1 && g.fileBottom <= g.vh + 1 && g.fileTop >= g.t - 1, g);
  await p.evaluate(() => { const e = document.getElementById("usPanel"); e.classList.remove("sheet"); e.style.removeProperty("--us-vvh"); }); await W(200);
  if (dev.floating) {
    await p.click("#usFloat"); await W(500);
    await p.evaluate(() => { document.getElementById("crSec").open = true; }); await W(300);
    g = await geo(p);
    ok(tag + " B4 floating: panel scrolls (overflow-y auto), fits the screen", g.ov === "auto" && g.b <= g.vh && g.t >= 0, g);
    await scrollPanel(p, 99999); await W(150); g = await geo(p);
    ok(tag + " B4 floating: Custom regions' last row reachable", g.fileBottom <= g.b + 1 && g.fileBottom <= g.vh && g.fileTop >= g.t - 1, g);
    ok(tag + " B4 floating: header sticky while scrolled", Math.abs(g.headTop - g.t) <= 3, g);
    ok(tag + " B4 floating: no horizontal scrollbar", !g.hx, g);
    if (SHOTS) { await p.screenshot({ path: SHOTS + "/panel-floating-scrolled-to-custom-regions-" + tag.replace(/\W+/g, "-") + ".png" }); }
    await scrollPanel(p, 0);
    // resize: drag the corner down and right well past the old 620 px height cap
    const h0 = (await geo(p)).h;
    await p.evaluate(() => { const e = document.getElementById("usPanel"); e.style.top = "20px"; }); // start near the top so there is room to grow
    await p.evaluate(() => { TDC.searchUI.moveBy && TDC.searchUI.moveBy(0, -9999); }); await W(200);
    const r = await p.evaluate(() => { const r = document.getElementById("usPanel").getBoundingClientRect(); return { x: r.right, y: r.bottom }; });
    await p.mouse.move(r.x - 5, r.y - 5); await p.mouse.down(); await p.mouse.move(r.x + 20, r.y + 200, { steps: 8 }); await p.mouse.move(r.x + 40, r.y + 600, { steps: 8 }); await p.mouse.up(); await W(900);
    g = await geo(p);
    ok(tag + " B5 resize: the window grows taller than the old 620 px cap (" + Math.round(g.h) + " px) when the screen allows", g.h > Math.max(h0 + 100, 621) || g.h >= g.vh - 20, { h0, g });
    ok(tag + " B5 resize: bottom edge and top edge stay on screen", g.b <= g.vh + 1 && g.t >= -1 && g.r <= g.vw + 1, g);
    ok(tag + " B5 resize: never taller than the screen", g.h <= g.vh - 6, g);
    await scrollPanel(p, 99999); await W(150); g = await geo(p);
    ok(tag + " B5 resize: last row reachable", g.fileBottom <= g.b + 1 && g.fileBottom <= g.vh, g);
    // viewport shrinks: the window is re-clamped
    await p.setViewportSize({ width: dev.ctx.viewport.width, height: 520 }); await W(700); g = await geo(p);
    ok(tag + " B6 shrinking the window re-clamps the floating panel into view", g.b <= g.vh + 1 && g.t >= -1, g);
    await p.setViewportSize(dev.ctx.viewport); await W(500);
    await p.click("#usFloat"); await W(400);
    ok(tag + " B7 back to docked: panel inline again, no leftover inline max-height", await p.evaluate(() => { const e = document.getElementById("usPanel"); return e.classList.contains("docked") && !e.style.maxHeight && !e.style.height; }));
  }
  ok(tag + " B9 no page errors", errs.length === 0, errs);
  await ctx.close();
}

async function partC(b, dev, tag) {
  const ctx = await b.newContext(dev.ctx); const p = await ctx.newPage();
  await openEvent(p, "");
  await p.click("#rdBtn"); await W(400);
  await p.evaluate(() => { document.getElementById("crSec").open = true; }); await W(200);
  await p.evaluate(() => TDC.focus.focus("front")); await W(300); await p.evaluate(() => document.getElementById("crDraw").click()); await W(500);
  const narrow = await p.evaluate(() => TDC.searchUI.narrow());
  ok(tag + " C1 draw bar is shown while drawing", await vis(p, "#crBar"));
  if (!narrow) { console.log("INFO " + tag + " not a narrow window: the panel stays open while drawing; Options toggle checked on the phone run"); await ctx.close(); return; }
  ok(tag + " C1 panel stepped aside, label is Options", !(await vis(p, "#usPanel")) && (await p.evaluate(() => document.getElementById("crBarOpts").textContent)) === "Options");
  await p.evaluate(() => document.getElementById("crBarOpts").click()); await W(400);
  ok(tag + " C2 Options opens the panel; label becomes Back to drawing; still drawing", (await vis(p, "#usPanel")) && (await p.evaluate(() => document.getElementById("crBarOpts").textContent)) === "Back to drawing" && (await p.evaluate(() => TDC.regions.ui.drawing)));
  await p.evaluate(() => document.getElementById("crBarOpts").click()); await W(400);
  ok(tag + " C3 tapping again tucks the panel away (picture free to draw), label is Options", !(await vis(p, "#usPanel")) && (await p.evaluate(() => document.getElementById("crBarOpts").textContent)) === "Options");
  await p.evaluate(() => document.getElementById("crBarOpts").click()); await W(300);
  ok(tag + " C4 and it opens again", await vis(p, "#usPanel"));
  await ctx.close();
}

(async () => {
  if (!fs.existsSync(FIX + "/TeslaCam")) execFileSync("python3", [path.join(ROOT, "tools/make-mock-footage.py"), FIX], { stdio: "inherit" });
  const srv = await server(); const pw = require("playwright");
  const DEVS = [
    { name: "desktop", ctx: { viewport: { width: 1280, height: 800 } }, short: 520, floating: true },
    { name: "phone", ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: UA, deviceScaleFactor: 2 }, short: 560, floating: false },
  ].filter((d) => !process.env.DEV || d.name === process.env.DEV);
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    let b;
    try { b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] }); }
    catch (e) { console.log("SKIP " + BR + ": cannot launch (" + e.message.split("\n")[0] + ")"); continue; }
    for (const dev of DEVS) { const tag = BR + " " + dev.name; for (const part of [partA, partB, partC]) { try { await part(b, dev, tag); } catch (e) { ok(tag + " " + part.name + " threw: " + e.message.split("\n")[0], false); } } }
    await b.close();
  }
  srv.close(); console.log(fails ? "FAILED " + fails : "ALL PASSED"); process.exit(fails ? 1 : 0);
})();
