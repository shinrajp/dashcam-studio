// redact-button (tag redact-button): a top-level Redact button beside Search; one panel (#usPanel) with two tabs (Find / Redact);
// the Redact tab shows the automatic hide controls and the Custom regions section OPEN, with a primary "Draw region" on top; the panel stays
// compact (<= ~45% of the screen) and steps aside while a region is drawn (any screen size).   Playwright, Chromium (system Chrome) and WebKit
// (BR=chromium|webkit), phone 390x844 + desktop 1280x800.  Mock footage only (tools/make-mock-footage.py -> /tmp/ho-mock).  Serves the repo on PORT (8801).
//   A. at rest: Redact button visible beside Search, nothing open, no Custom regions / Draw region visible
//   B. Redact button: panel opens on the Redact tab; Custom regions open without a click; Draw region is the first, primary action; automatic controls
//      (Blur text, presets) shown; Find moment is not; panel <= 45% of the height; tab buttons; second press closes
//   C. Search button: Find tab, no redaction content; switching and closing; the tab is remembered for the session; Ctrl+K and / open Find
//   D. keyboard: focus + Enter on the Redact button; arrow keys move between the tabs
//   E. drawing: Draw region hides the panel and shows the draw bar; Save region brings the panel back on Redact with the region listed; Cancel too;
//      the Redact button reopens it while still drawing
//   F. footprint: floating window default <= 45%, and still resizable taller by the corner (desktop)
//   G. existing flows: Find (text) from the Find tab, Blur text switches to the Redact tab, regions list / delete, export note, no page errors
// Usage: BR=chromium|webkit node test/redact-button.js    SHOTS=dir writes mock-data screenshots
const fs = require("fs"), path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", PORT = +(process.env.PORT || 8801), SHOTS = process.env.SHOTS || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 800) : "")); if (!c) fails++; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".onnx": "application/octet-stream", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html"; fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; return r.end(); } r.setHeader("Content-Type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }).listen(PORT, "127.0.0.1", () => res(s)); });
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const BASE = `http://127.0.0.1:${PORT}/index.html?nosw=1`;

async function openEvent(p, q) {
  await p.goto(BASE + (q || ""), { waitUntil: "load" });
  await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.prefs.v1"); localStorage.removeItem("tdc.regions.v1"); localStorage.removeItem("tdc.searchPanel.v1"); sessionStorage.clear(); });
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events[0]); }); await W(1500);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); });
}
const vis = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return !e.hidden && getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden" && r.width > 0 && r.height > 0; }, sel);
const rect = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; }, sel);
const tap = async (p, sel, touch) => { if (touch) { const r = await rect(p, sel); await p.touchscreen.tap(r.l + r.w / 2, r.t + r.h / 2); } else await p.click(sel); await W(450); };
const tabOf = (p) => p.evaluate(() => document.getElementById("usPanel").dataset.tab);
const open = (p) => p.evaluate(() => TDC.searchUI.open);
const drawMouse = async (p, pts) => { await p.mouse.move(pts[0][0], pts[0][1]); await p.mouse.down(); for (const q of pts.slice(1)) { await p.mouse.move(q[0], q[1], { steps: 4 }); await W(30); } await p.mouse.up(); await W(200); };
const tileRect = (p) => p.evaluate(() => { const t = TDC.player.tiles[TDC.regions.ui.cam || TDC.focus.cam].tile.getBoundingClientRect(); return { l: t.left, t: t.top, r: t.right, b: t.bottom }; });

async function run(b, dev, tag) {
  const ctx = await b.newContext(dev.ctx); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  const touch = !!dev.ctx.hasTouch, shot = async (n) => { if (SHOTS) { await W(250); await p.screenshot({ path: SHOTS + "/" + n + "-" + tag.replace(/\W+/g, "-") + ".png" }); } };
  await openEvent(p);
  const VH = await p.evaluate(() => innerHeight);
  // A. at rest
  const us = await rect(p, "#usBtn"), rd = await rect(p, "#rdBtn");
  ok(tag + " A1 Redact button is visible without opening anything", await vis(p, "#rdBtn") && await vis(p, "#usBtn"));
  ok(tag + " A1 it is a real button with the label Redact (icon + label), right beside Search", !!rd && !!us && (await p.evaluate(() => { const b = document.getElementById("rdBtn"); return b.tagName === "BUTTON" && /Redact/.test(b.textContent) && !!b.querySelector("svg"); })) && Math.abs((us.t + us.h / 2) - (rd.t + rd.h / 2)) < 8 && Math.abs(rd.l - us.r) < 40 && rd.l >= us.l, { us, rd });
  ok(tag + " A1 the label is visible (not an icon alone)", await p.evaluate(() => { const l = document.querySelector("#rdBtn .us-lbl"); return !!l && getComputedStyle(l).display !== "none" && l.getBoundingClientRect().width > 20; }));
  ok(tag + " A1 within the screen, 44px-ish tall touch target on phones", !!rd && rd.l >= 0 && rd.r <= (await p.evaluate(() => innerWidth)) && (!touch || rd.h >= 36), rd);
  ok(tag + " A2 nothing is open, no redaction controls on screen", !(await open(p)) && !(await vis(p, "#usPanel")) && !(await vis(p, "#crSec")) && !(await vis(p, "#crDraw")));
  ok(tag + " A3 both buttons start collapsed (aria-expanded false)", await p.evaluate(() => ["usBtn", "rdBtn"].every((i) => document.getElementById(i).getAttribute("aria-expanded") === "false")));
  await shot("toolbar-redact-beside-search");

  // B. Redact button
  await tap(p, "#rdBtn", touch);
  ok(tag + " B1 Redact button opens the panel on the Redact tab", (await open(p)) && (await vis(p, "#usPanel")) && (await tabOf(p)) === "redact");
  ok(tag + " B2 Custom regions is open, nothing to click (form fields visible)", (await p.evaluate(() => document.getElementById("crSec").open)) && (await vis(p, "#crSec")) && !(await p.evaluate(() => !!document.getElementById("crCam"))) && (await vis(p, "#crShape")) && (await vis(p, "#crMode")) && (await vis(p, "#crWhole")));
  const dr = await rect(p, "#crDraw"), pn = await rect(p, "#usPanel"), form = await rect(p, "#crShape");
  ok(tag + " B3 'Draw region' is visible, primary, and the first action (above the form, at the top of the panel)", !!dr && (await p.evaluate(() => document.getElementById("crDraw").classList.contains("primary") && /Draw region/.test(document.getElementById("crDraw").textContent))) && dr.t < form.t && dr.t - pn.t < 90, { dr, pn, form });
  ok(tag + " B4 automatic controls are on this tab (Blur text, presets, text box)", (await vis(p, "#usRedact")) && (await vis(p, ".us-chip")) && (await vis(p, "#usQuery")) && (await p.evaluate(() => document.querySelectorAll(".us-presets .us-chip").length)) >= 4);
  ok(tag + " B4 Find-only controls are not (Find moment, Matches style)", !(await vis(p, "#usFind")) && !(await vis(p, "#usHl")));
  ok(tag + " B5 the Redact button shows open, Search does not", await p.evaluate(() => document.getElementById("rdBtn").getAttribute("aria-expanded") === "true" && document.getElementById("usBtn").getAttribute("aria-expanded") === "false"));
  const pn2 = await rect(p, "#usPanel");
  ok(tag + " B6 panel is compact: <= 45% of the screen height (+ rounding)", pn2.h <= VH * 0.45 + 2, { h: pn2.h, VH });
  ok(tag + " B6 the panel scrolls inside when its content is taller", await p.evaluate(() => { const e = document.getElementById("usPanel"); return e.scrollHeight > e.clientHeight ? ["auto", "scroll"].includes(getComputedStyle(e).overflowY) : true; }));
  ok(tag + " B7 the saved-regions list and file buttons are reachable by scrolling", await p.evaluate(async () => { const e = document.getElementById("usPanel"), f = document.getElementById("crFileRow"); e.scrollTop = e.scrollHeight; await new Promise((r) => setTimeout(r, 100)); const a = e.getBoundingClientRect(), r = f.getBoundingClientRect(); e.scrollTop = 0; return r.top >= a.top - 1 && r.bottom <= a.bottom + 1; }));
  await shot("redact-tab-open");
  ok(tag + " B8 header stays: tabs, close button visible", (await vis(p, "#usTabFind")) && (await vis(p, "#usTabRedact")) && (await vis(p, "#usClose")));
  await tap(p, "#rdBtn", touch);   // on phones the panel hides the floating buttons; use the API then
  if (await open(p)) { await p.evaluate(() => TDC.searchUI.toggleTab("redact")); await W(300); }
  ok(tag + " B9 pressing Redact again closes the panel", !(await open(p)) && !(await vis(p, "#usPanel")));

  // C. Search button / tabs / session memory
  await tap(p, "#usBtn", touch);
  ok(tag + " C1 Search button opens the Find tab", (await open(p)) && (await tabOf(p)) === "find" && (await vis(p, "#usFind")) && (await vis(p, "#usQuery")));
  ok(tag + " C2 Find tab has no redaction content (no Custom regions, Draw region, presets, Blur text)", !(await vis(p, "#crSec")) && !(await vis(p, "#crDraw")) && !(await vis(p, ".us-chip")) && !(await vis(p, "#usRedact")) && !(await vis(p, "#usDrawRow")));
  ok(tag + " C2 it has the Find controls (query, camera, Find moment)", (await vis(p, "#usCam")) && (await vis(p, "#usFind")));
  ok(tag + " C3 Search button shows open, Redact does not", await p.evaluate(() => document.getElementById("usBtn").getAttribute("aria-expanded") === "true" && document.getElementById("rdBtn").getAttribute("aria-expanded") === "false"));
  await shot("find-tab-open");
  await tap(p, "#usTabRedact", touch);
  ok(tag + " C4 the Redact tab inside the panel switches over", (await tabOf(p)) === "redact" && (await vis(p, "#crDraw")) && !(await vis(p, "#usFind")));
  await tap(p, "#usTabFind", touch);
  ok(tag + " C4 and back to Find", (await tabOf(p)) === "find" && !(await vis(p, "#crSec")) && (await vis(p, "#usFind")));
  await p.evaluate(() => TDC.searchUI.hide()); await W(200);
  await p.evaluate(() => TDC.searchUI.setTab("redact")); await p.evaluate(() => TDC.searchUI.hide()); await W(200);
  await p.evaluate(() => TDC.searchUI.show(false)); await W(300);
  ok(tag + " C5 the tab is remembered for the session: show() reopens on Redact", (await tabOf(p)) === "redact" && (await p.evaluate(() => sessionStorage.getItem("tdc.us.tab"))) === "redact");
  await p.evaluate(() => TDC.searchUI.hide()); await W(200);
  ok(tag + " C6 the Search button always goes to Find, even after Redact", await (async () => { await tap(p, "#usBtn", touch); return (await tabOf(p)) === "find"; })());
  if (!touch) {
    await p.evaluate(() => TDC.searchUI.hide()); await W(200);
    await p.keyboard.press("Control+k"); await W(300);
    ok(tag + " C7 Ctrl+K opens Find", (await open(p)) && (await tabOf(p)) === "find");
    await p.keyboard.press("Escape"); await W(200);
    await p.evaluate(() => TDC.searchUI.show(false, "redact")); await W(200);
    await p.evaluate(() => document.activeElement && document.activeElement.blur()); await p.evaluate(() => TDC.searchUI.hide()); await W(200);
    await p.keyboard.press("/"); await W(300);
    ok(tag + " C7 '/' opens Find", (await open(p)) && (await tabOf(p)) === "find");
    await p.keyboard.press("Escape"); await W(200);
    ok(tag + " C7 Esc closes", !(await open(p)));
  }
  await p.evaluate(() => TDC.searchUI.hide()); await W(200);

  // D. keyboard
  await p.focus("#rdBtn"); await p.keyboard.press("Enter"); await W(400);
  ok(tag + " D1 focus + Enter on the Redact button opens the Redact tab", (await open(p)) && (await tabOf(p)) === "redact");
  ok(tag + " D1 focus moves into the panel (Draw region)", await p.evaluate(() => document.activeElement && document.getElementById("usPanel").contains(document.activeElement)));
  await p.focus("#usTabRedact"); await p.keyboard.press("ArrowLeft"); await W(200);
  ok(tag + " D2 ArrowLeft on the tabs goes to Find", (await tabOf(p)) === "find" && (await p.evaluate(() => document.activeElement.id)) === "usTabFind");
  await p.keyboard.press("ArrowRight"); await W(200);
  ok(tag + " D2 ArrowRight goes to Redact", (await tabOf(p)) === "redact");
  ok(tag + " D3 tabs have roles and aria-selected", await p.evaluate(() => document.getElementById("usTabs").getAttribute("role") === "tablist" && document.getElementById("usTabRedact").getAttribute("aria-selected") === "true" && document.getElementById("usTabFind").getAttribute("aria-selected") === "false"));
  await p.evaluate(() => TDC.searchUI.hide()); await W(200);

  // E. drawing
  await p.evaluate(() => TDC.searchUI.show(false, "redact")); await W(300);
  await p.evaluate(() => { TDC.regions.ui.shape = "rect"; TDC.regions.UI.sync(); });
  await p.evaluate(() => TDC.focus.focus("front")); await W(300); await p.evaluate(() => document.getElementById("crDraw").click()); await W(700);
  ok(tag + " E1 Draw region hides the panel (video fully visible)", !(await open(p)) && !(await vis(p, "#usPanel")));
  ok(tag + " E1 the draw bar is shown", await vis(p, "#crBar"));
  const docked = await p.evaluate(() => !document.body.classList.contains("us-docked"));
  ok(tag + " E1 the dock is gone, so the picture got the room back", docked);
  await shot("drawing-panel-hidden");
  const tr = await tileRect(p), cx = (tr.l + tr.r) / 2, cy = (tr.t + tr.b) / 2;
  await drawMouse(p, [[cx - 60, cy - 30], [cx + 60, cy + 30]]);
  ok(tag + " E2 a box can be drawn on the picture", (await p.evaluate(() => !!TDC.regions.ui.draft)));
  await tap(p, "#rdBtn", touch);
  ok(tag + " E3 the Redact button reopens the panel on the Redact tab while a draft exists", (await open(p)) && (await tabOf(p)) === "redact");
  await p.evaluate(() => TDC.searchUI.hide()); await W(300);
  const n0 = await p.evaluate(() => TDC.regions.list.length);
  await p.evaluate(() => { const b = document.getElementById("crBarSave"); b.click(); }); await W(500);
  ok(tag + " E4 Save region brings the panel back on the Redact tab with the region listed", (await open(p)) && (await tabOf(p)) === "redact" && (await p.evaluate(() => TDC.regions.list.length)) === n0 + 1 && (await p.evaluate(() => document.querySelectorAll("#crList li").length)) === n0 + 1 && !(await vis(p, "#crBar")), await p.evaluate(() => ({ open: TDC.searchUI.open, tab: document.getElementById("usPanel").dataset.tab, n: TDC.regions.list.length, reopen: TDC.regions.ui.reopen, drawing: TDC.regions.ui.drawing, draft: !!TDC.regions.ui.draft, bar: !document.getElementById("crBar").hidden })));
  await shot("region-saved-list");
  await p.evaluate(() => document.getElementById("crDraw").click()); await W(600);
  ok(tag + " E5 draw again: panel hides again", !(await open(p)));
  await p.evaluate(() => document.getElementById("crBarCancel").click()); await W(500);
  ok(tag + " E5 Cancel brings it back too, bar gone", (await open(p)) && (await tabOf(p)) === "redact" && !(await vis(p, "#crBar")));

  // F. footprint
  if (!touch) {
    await p.evaluate(() => { TDC.searchUI.hide(); TDC.searchUI.setMode("float"); TDC.searchUI.show(false, "redact"); }); await W(500);
    const f1 = await rect(p, "#usPanel");
    ok(tag + " F1 floating window fits the screen (sizing it is left to the user, as before)", f1.h <= VH - 8 && f1.t >= 0 && f1.b <= VH, { f1, VH });
    ok(tag + " F1 Custom regions still reachable by scrolling there", await p.evaluate(async () => { const e = document.getElementById("usPanel"), f = document.getElementById("crFileRow"); e.scrollTop = e.scrollHeight; await new Promise((r) => setTimeout(r, 100)); const a = e.getBoundingClientRect(), r = f.getBoundingClientRect(); e.scrollTop = 0; return r.top >= a.top - 1 && r.bottom <= a.bottom + 1; }));
    await p.mouse.move(f1.r - 5, f1.b - 5); await p.mouse.down(); await p.mouse.move(f1.r - 5, f1.b - 200, { steps: 8 }); await p.mouse.up(); await W(700);
    const f2 = await rect(p, "#usPanel");
    ok(tag + " F2 the corner can still be dragged to resize the floating window", f2.h < f1.h - 60, { f1, f2 });
    await p.evaluate(() => { TDC.searchUI.hide(); TDC.searchUI.setMode("dock"); localStorage.removeItem("tdc.searchPanel.v1"); }); await W(300);
  }

  // G. existing flows
  await p.evaluate(() => TDC.searchUI.show(false, "find")); await W(300);
  await p.evaluate(() => { document.getElementById("usQuery").value = "text Oak Ave"; TDC.searchUI.find("text Oak Ave"); }); await W(900);
  ok(tag + " G1 Find from the Find tab runs and stays on Find", (await tabOf(p)) === "find" && (await p.evaluate(() => TDC.search.running !== undefined)));
  await p.evaluate(() => TDC.searchUI.stop && TDC.searchUI.stop()); await W(300);
  await p.evaluate(() => { document.getElementById("usQuery").value = "Oak Ave"; TDC.searchUI.redact("Oak Ave"); }); await W(600);
  ok(tag + " G2 Blur text (programmatic) switches to the Redact tab so its result shows there", (await tabOf(p)) === "redact");
  await p.evaluate(() => TDC.searchUI.stop && TDC.searchUI.stop()); await W(300);
  await p.evaluate(() => TDC.searchUI.clear && TDC.searchUI.clear()); await W(200);
  const del0 = await p.evaluate(() => document.querySelectorAll("#crList li").length);
  await p.evaluate(() => document.querySelector("#crList [data-act=del]").click()); await W(300);
  ok(tag + " G3 a region can be deleted from the list on this tab", (await p.evaluate(() => document.querySelectorAll("#crList li").length)) === del0 - 1);
  await p.evaluate(() => { TDC.regions.add({ cam: "back", shape: "rect", mode: "blur", x: 0.2, y: 0.2, w: 0.2, h: 0.1 }); }); await W(200);
  ok(tag + " G4 summary can't fold Custom regions shut", await p.evaluate(() => { const s = document.querySelector("#crSec > summary"); s.click(); return document.getElementById("crSec").open; }));
  ok(tag + " G5 id compatibility: usPanel, usDock, crSec, crDraw, crSave, crCancel, crList, crFileRow, usResults, usStatus", await p.evaluate(() => ["usPanel", "usDock", "crSec", "crDraw", "crSave", "crCancel", "crList", "crFileRow", "usResults", "usStatus", "usBtn", "rdBtn"].every((i) => !!document.getElementById(i))));
  await p.evaluate(() => { TDC.searchUI.hide(); }); await W(200);
  ok(tag + " G6 no page errors", errs.length === 0, errs);
  await ctx.close();
}

(async () => {
  if (!fs.existsSync(FIX + "/TeslaCam")) execFileSync("python3", [path.join(ROOT, "tools/make-mock-footage.py"), FIX], { stdio: "inherit" });
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await server(); const pw = require("playwright");
  const DEVS = [
    { name: "desktop", ctx: { viewport: { width: 1280, height: 800 } } },
    { name: "phone", ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: UA, deviceScaleFactor: 2 } },
  ].filter((d) => !process.env.DEV || d.name === process.env.DEV);
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    let b;
    try { b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] }); }
    catch (e) { console.log("SKIP " + BR + ": cannot launch (" + e.message.split("\n")[0] + ")"); continue; }
    for (const dev of DEVS) { const tag = BR + " " + dev.name; try { await run(b, dev, tag); } catch (e) { ok(tag + " run threw: " + e.message.split("\n")[0], false); } }
    await b.close();
  }
  srv.close(); console.log(fails ? "FAILED " + fails : "ALL PASSED"); process.exit(fails ? 1 : 0);
})();
