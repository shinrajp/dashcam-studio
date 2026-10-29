// ui-glass-8: Settings is a compact grouped glass panel (js/settings-groups.js, css/settings.css). The same sections, ids and handlers,
// sorted into groups (Playback, Appearance, Overlays & HUD, Redaction & detection, Export, Advanced & Labs, Keys & unlock) behind a
// list with a back button and a search field. This test checks:
//   1  every id the old (ui-glass-7) Settings panel had is still in it;
//   2  every control that was visible in the old long list can be reached: open its group (and "Show all" / its <details>) and it shows;
//      the search field finds it too, by its label;
//   3  real clicks still change the same saved prefs (Overlays, HUD items, units, map, glass, auto-hide, calibration, overlay size),
//      ?glass= / ?autohide= overrides still win; the reset buttons are untouched;
//   4  × folds it, Esc folds it, ‹ Settings goes back and refocuses the group, Up/Down move through the groups, aria roles;
//   5  each group fits without scrolling at 1440x900 and 430x932; touch targets are 44 px; a row tap on touch toggles its switch once;
//   6  Export… and Unlock… open the same dialogs as the toolbar buttons; no page errors.
//   Playwright, BR=chromium|webkit (default both), mock footage (/tmp/ho-mock). PORT (default 8823). ROOT=dir serves another checkout.
const fs = require("fs"), path = require("path"), http = require("http");
const ROOT = process.env.ROOT || path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", PORT = +(process.env.PORT || 8823);
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".onnx": "application/octet-stream", ".wasm": "application/wasm" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html"; fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; r.end(); return; } r.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }).listen(PORT, "127.0.0.1", () => res(s)); });
// the ids inside #settings at ui-glass-7 (1831f8d), mock footage loaded
const OLD_IDS = ["btnCloseSettings", "setShow", "setHud", "segUnits", "hudScale", "mapTiles", "segMapStyle", "mapFollow", "mapAside", "barAside", "segBarSide", "appearSec", "segGlass", "glassNote", "segAutohide", "autohideNote", "show360", "calibSec", "steerInvert", "accelSwap", "setWb", "wbStrength", "wbWidth", "wbSideLeft", "wbSideRight", "wbMatch", "wbShowMask", "wbColour", "ccOn", "wbForget", "recogSec", "setRecog", "rsFind", "rsLive", "rsVehicle", "rsPlates", "rsBlur", "rsSpeed", "recogAdv", "setDetect", "detEnabled", "detModel", "detConf", "detConfV", "detSmall", "detLive", "detLiveCams", "detSpeed", "detSeed", "detOccl", "detByte", "detCross", "detCrossStatus", "detStatus", "detTest", "setPlates", "plEnabled", "plModel", "plConf", "plConfV", "plRead", "plReadV", "plFar", "plStreet", "plBlur", "plStatus", "plForget", "setVehicle", "vehEnabled", "vehMakes", "vehClear", "setCloud", "cbProvider", "setSearchSec", "setClassicSearch", "setTextSearch", "setTextSearchHint", "btnResetLayout", "btnResetAll"];
async function open(p, q) {
  await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1${q || ""}`, { waitUntil: "load" });
  await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.setItem("tdc.prefs.v1", JSON.stringify({ advanced: true })); sessionStorage.clear(); });
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events.find((e) => e.cams.length === 6) || TDC.library.events[0]); }); await W(1500);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); document.getElementById("settings").hidden = true; if (TDC.focus && TDC.focus.dismissHint) TDC.focus.dismissHint(); }); await W(300);
}
const openSettings = async (p) => { if (await p.evaluate(() => document.getElementById("settings").hidden)) { await p.click("#btnSettings"); await W(350); } };
const vis = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden"; }, sel);
const pref = (p, k) => p.evaluate((k) => { const v = k.split(".").reduce((o, x) => o && o[x], TDC.prefs); const s = JSON.parse(localStorage.getItem("tdc.prefs.v1") || "{}"); return { v, saved: k.split(".").reduce((o, x) => o && o[x], s) }; }, k);
async function go(p, g) { await openSettings(p); if (await p.evaluate(() => TDC.settings.view()) !== "home") { await p.click("#setBack"); await W(150); } await p.click(`.set-grp[data-g="${g}"]`); await W(200); }

async function run(b, BR) {
  // ---------- desktop 1440x900 ----------
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await open(p); await openSettings(p);
  const T = BR + " 1440x900";
  // 1 ids
  const missing = await p.evaluate((ids) => ids.filter((id) => { const e = document.getElementById(id); return !e || !e.closest("#settings"); }), OLD_IDS);
  ok(T + " 1 every id from the old Settings panel is still inside it (" + OLD_IDS.length + ")", missing.length === 0, missing);
  ok(T + " 1 it opens on the group list with 7 groups and a search field", (await p.evaluate(() => TDC.settings.view())) === "home" && (await p.locator(".set-grp").count()) === 7 && await vis(p, "#setFilter"));
  // 2 reachability: the controls visible when the panel is un-grouped (= the old long list, <details> open) must show in their group
  const all = await p.evaluate(() => {
    const st = document.getElementById("settings"); st.querySelectorAll("details").forEach((d) => { d.dataset.wasOpen = d.open ? "1" : ""; d.open = true; });
    st.classList.remove("set-panel"); const out = [];
    st.querySelectorAll(".drawer-body section input, .drawer-body section select, .drawer-body section button, .drawer-body section textarea").forEach((e, i) => {
      if (e.closest("#setHome, .set-more") || /^setOpen/.test(e.id)) return;
      if (!e.getClientRects().length) return; e.dataset.ug8 = String(i);
      const row = e.closest(".row, label"); out.push({ k: String(i), id: e.id, g: TDC.settings.groupOf(e), label: ((row && row !== e ? row.textContent : e.getAttribute("aria-label") || e.textContent) || "").trim().replace(/\s+/g, " ").slice(0, 30) });
    });
    st.classList.add("set-panel"); st.querySelectorAll("details").forEach((d) => { d.open = d.dataset.wasOpen === "1"; }); return out;
  });
  const lost = [];
  for (const c of all) {
    await go(p, c.g);
    await p.evaluate((k) => { const e = document.querySelector(`[data-ug8="${k}"]`), sec = e.closest("section");
      const d = e.closest("details"); if (d) d.open = true;
      if (e.closest(".set-x") && sec && !sec.classList.contains("open")) sec.querySelector(".set-more").click(); }, c.k);
    await W(60);
    if (!await vis(p, `[data-ug8="${c.k}"]`)) lost.push(c);
  }
  ok(T + " 2 all " + all.length + " old controls show in their group (with Show all / Advanced opened)", all.length > 60 && lost.length === 0, { n: all.length, lost });
  ok(T + " 2 no control is left without a group", all.every((c) => TDC_GROUPS.includes(c.g)), all.filter((c) => !TDC_GROUPS.includes(c.g)));
  // search by label
  await p.click("#setBack"); const notFound = [];
  for (const c of all.filter((c) => c.label && c.label.length > 3 && !/^\d/.test(c.label))) {
    const word = c.label.split(" ").filter((w) => w.length > 3)[0] || c.label;
    await p.fill("#setFilter", word); await W(80);
    const seen = await p.evaluate((k) => { const e = document.querySelector(`[data-ug8="${k}"]`); const d = e.closest("details"); if (d && !d.open) return !d.closest(".set-off, .set-miss") && getComputedStyle(d).display !== "none"; return e.getClientRects().length > 0; }, c.k);
    if (!seen) notFound.push([c.label, word]);
  }
  ok(T + " 2 the search field finds each labelled control by a word of its label", notFound.length === 0, notFound);
  await p.fill("#setFilter", "zzqx"); await W(80);
  ok(T + " 2 a search with no match says so", await vis(p, "#setEmpty"));
  await p.fill("#setFilter", "auto-hide"); await W(80);
  ok(T + " 2 search 'auto-hide' shows the Auto-hide switch and its group name", await vis(p, "#segAutohide") && (await p.evaluate(() => getComputedStyle(document.querySelector("#appearSec"), "::before").content)).includes("Appearance"));
  await p.focus("#setFilter"); await p.keyboard.press("Escape"); await W(80);
  ok(T + " 4 Esc in the search clears it first (panel stays)", (await p.inputValue("#setFilter")) === "" && !(await p.evaluate(() => document.getElementById("settings").hidden)));
  // 3 behaviour: real clicks, same prefs
  await go(p, "overlays");
  const k0 = await p.evaluate(() => Object.keys(TDC.prefs.show)[0]); const s0 = (await pref(p, "show." + k0)).v;
  await p.locator("#setShow input").first().click(); await W(100);
  let a = await pref(p, "show." + k0); ok(T + " 3 Overlays: first switch flips prefs.show." + k0 + " and saves it", a.v === !s0 && a.saved === !s0, a);
  const h0 = await p.evaluate(() => TDC.hud.ITEMS[0][0]); const hv = (await pref(p, "hudItems." + h0)).v;
  await p.locator("#setHud input").first().click(); await W(100);
  a = await pref(p, "hudItems." + h0); ok(T + " 3 HUD items: first switch flips prefs.hudItems." + h0, a.v === !hv && a.saved === !hv, a);
  await go(p, "playback");
  const uOther = await p.evaluate(() => [...document.querySelectorAll("#segUnits button")].find((b) => b.dataset.v !== TDC.prefs.units).dataset.v);
  await p.click(`#segUnits button[data-v="${uOther}"]`); await W(100);
  a = await pref(p, "units"); ok(T + " 3 Units: " + uOther + " saved", a.v === uOther && a.saved === uOther, a);
  const mt = !(await p.isChecked("#mapTiles"));
  await p.click("#mapTiles"); await W(100); a = await pref(p, "mapTiles"); ok(T + " 3 Map tiles switch saves prefs.mapTiles", a.v === mt && a.saved === mt, { a, mt });
  await p.click("#mapTiles"); await W(100);
  await p.evaluate(() => { const r = document.getElementById("hudScale"); r.value = String(+r.min + (+r.max - +r.min) * 0.75); r.dispatchEvent(new Event("input", { bubbles: true })); }); await W(80);
  a = await pref(p, "hudScale"); ok(T + " 3 Overlay size slider saves prefs.hudScale", a.v === a.saved && a.v === +(await p.inputValue("#hudScale")), a);
  await go(p, "appearance");
  await p.click('#segGlass button[data-v="solid"]'); await W(150); a = await pref(p, "glass");
  ok(T + " 3 Glass: Solid saves prefs.glass and applies it", a.v === "solid" && a.saved === "solid" && (await p.evaluate(() => document.documentElement.dataset.glass || document.body.dataset.glass || "")).includes("solid"), a);
  await p.click('#segAutohide button[data-v="3"]'); await W(100); a = await pref(p, "autohide"); ok(T + " 3 Auto-hide: 3 s saves prefs.autohide", a.v === "3" && a.saved === "3", a);
  await p.click('#segAutohide button[data-v="never"]'); await W(80);
  await go(p, "advanced");
  if (!await vis(p, "#steerInvert")) await p.click("#show360"); await W(150);
  await p.click("#steerInvert"); await W(80); a = await pref(p, "steerInvert"); ok(T + " 3 Calibration: steering switch saves prefs.steerInvert", a.v === true && a.saved === true, a);
  ok(T + " 3 the reset buttons are still in Advanced", await vis(p, "#btnResetLayout") && await vis(p, "#btnResetAll"));
  // 4 navigation, keyboard, aria
  await p.click("#setBack"); await W(150);
  ok(T + " 4 ‹ Settings goes back and focuses the group it came from", (await p.evaluate(() => TDC.settings.view() + "|" + document.activeElement.dataset.g)) === "home|advanced");
  await p.keyboard.press("ArrowDown"); ok(T + " 4 Down moves to the next group", (await p.evaluate(() => document.activeElement.dataset.g)) === "keys");
  await p.keyboard.press("Home"); ok(T + " 4 Home moves to the first group", (await p.evaluate(() => document.activeElement.dataset.g)) === "playback");
  await p.keyboard.press("Enter"); await W(150); ok(T + " 4 Enter opens it, title says Playback", (await p.evaluate(() => TDC.settings.view() + "|" + document.getElementById("setTitle").textContent)) === "playback|Playback");
  ok(T + " 4 aria: dialog with label, back and search labelled", await p.evaluate(() => { const s = document.getElementById("settings"); return s.getAttribute("role") === "dialog" && !!s.getAttribute("aria-label") && !!document.getElementById("setBack").getAttribute("aria-label") && !!document.getElementById("setFilter").getAttribute("aria-label"); }));
  await p.click("#btnCloseSettings"); await W(200);
  ok(T + " 4 × folds it", await p.evaluate(() => document.getElementById("settings").hidden));
  await openSettings(p); ok(T + " 4 it reopens on the group list", (await p.evaluate(() => TDC.settings.view())) === "home");
  await p.focus("#setFilter"); await p.keyboard.press("Escape"); await W(150);
  ok(T + " 4 Esc in an empty search folds it", await p.evaluate(() => document.getElementById("settings").hidden));
  // 5 fit
  const fit = await fitAll(p); ok(T + " 5 every group fits without scrolling", fit.every((f) => f.sh <= f.ch + 2), fit);
  // 6 shortcuts
  await go(p, "export"); await p.click("#setOpenExport"); await W(500);
  ok(T + " 6 Export… folds Settings and opens the export dialog", await p.evaluate(() => document.getElementById("settings").hidden && !document.getElementById("exportModal").hidden));
  await p.evaluate(() => { document.getElementById("exportModal").hidden = true; });
  await go(p, "keys"); await p.click("#setOpenUnlock"); await W(300);
  ok(T + " 6 Unlock… opens the unlock dialog", await p.evaluate(() => document.getElementById("settings").hidden && !document.getElementById("unlockModal").hidden));
  await p.evaluate(() => { document.getElementById("unlockModal").hidden = true; });
  ok(T + " 6 no page errors", errs.length === 0, errs);
  // overrides still win
  const p2 = await ctx.newPage(); await open(p2, "&glass=clear&autohide=5"); await p2.evaluate(() => { TDC.setPref("glass", "solid"); TDC.setPref("autohide", "never"); });
  await go(p2, "appearance");
  ok(T + " 3 ?glass=clear and ?autohide=5 still win over the saved prefs, with the note", await p2.evaluate(() => document.querySelector('#segGlass button.on').dataset.v === "clear" && document.querySelector('#segAutohide button.on').dataset.v === "5" && /autohide=/.test(document.getElementById("autohideNote").textContent)));
  await ctx.close();

  // ---------- phone 430x932, touch ----------
  const c2 = await b.newContext({ viewport: { width: 430, height: 932 }, hasTouch: true, isMobile: BR === "chromium", deviceScaleFactor: 2 });
  const q = await c2.newPage(); const e2 = []; q.on("pageerror", (e) => e2.push(e.message));
  await open(q); const P = BR + " 430x932";
  await q.evaluate(() => { document.getElementById("settings").hidden = false; }); await W(400);
  const sz = await q.evaluate(() => { const h = (s) => [...document.querySelectorAll(s)].filter((e) => e.getClientRects().length).map((e) => Math.round(e.getBoundingClientRect().height)); return { grp: h(".set-grp"), close: h("#btnCloseSettings"), filter: h("#setFilter") }; });
  ok(P + " 5 group rows, × and search are ≥ 44 px", [...sz.grp, ...sz.close, ...sz.filter].every((v) => v >= 44), sz);
  const sheet = await q.evaluate(() => { const r = document.getElementById("settings").getBoundingClientRect(); return { l: r.left, r: r.right, b: r.bottom, ih: innerHeight }; });
  ok(P + " 5 it is a full-width bottom sheet", sheet.l <= 1 && sheet.r >= 429, sheet);
  await q.tap('.set-grp[data-g="overlays"]'); await W(250);
  ok(P + " 5 back is ≥ 44 px", (await q.evaluate(() => document.getElementById("setBack").getBoundingClientRect().height)) >= 44);
  const rows = await q.evaluate(() => [...document.querySelectorAll('#settings section:not(.set-off) .row')].filter((e) => e.getClientRects().length).map((e) => Math.round(e.getBoundingClientRect().height)));
  ok(P + " 5 setting rows are ≥ 44 px on touch", rows.length > 5 && rows.every((h) => h >= 43.5), rows);
  const k1 = await q.evaluate(() => Object.keys(TDC.prefs.show)[1]), v1 = (await pref(q, "show." + k1)).v;
  const rr = await q.evaluate(() => { const r = document.querySelectorAll("#setShow .row")[1].getBoundingClientRect(); return { x: r.left + 8, y: r.top + r.height / 2 }; });
  await q.touchscreen.tap(rr.x, rr.y); await W(200);
  a = await pref(q, "show." + k1); ok(P + " 5 a tap on a row's label toggles its switch exactly once", a.v === !v1 && a.saved === !v1, { a, v1 });
  const fit2 = await fitAll(q); ok(P + " 5 every group fits without scrolling", fit2.every((f) => f.sh <= f.ch + 2), fit2);
  ok(P + " 6 no page errors", e2.length === 0, e2);
  await c2.close();
}
async function fitAll(p) {
  const out = [];   // as a fresh visit: "Show all" and Advanced <details> closed
  await p.evaluate(() => { document.querySelectorAll("#settings section.open").forEach((s) => s.classList.remove("open")); const d = document.getElementById("recogAdv"); if (d) d.open = false; });
  for (const g of ["home", ...TDC_GROUPS]) {
    await p.evaluate((g) => { document.getElementById("settings").hidden = false; TDC.settings.show(g); }, g); await W(120);
    const m = await p.evaluate(() => { const b = document.querySelector("#settings .drawer-body"); return { sh: b.scrollHeight, ch: b.clientHeight }; });
    out.push({ g, ...m });
  }
  return out;
}
const TDC_GROUPS = ["playback", "appearance", "overlays", "redact", "export", "advanced", "keys"];
(async () => {
  const pw = require("playwright"); const s = await server();
  const brs = (process.env.BR || "chromium,webkit").split(",");
  for (const BR of brs) {
    let b; try { b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || (fs.existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined) }); }
    catch (e) { console.log("SKIP " + BR + ": " + e.message.split("\n")[0]); continue; }
    try { await run(b, BR); } catch (e) { ok(BR + " run threw", false, e.stack); } finally { await b.close(); }
  }
  s.close(); console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})();
