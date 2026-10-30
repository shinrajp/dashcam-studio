// ui-glass-12 (iPhone: "with the keyboard up, the player capsule floats over the Search / Settings sheet and covers the results"):
// with a simulated on-screen keyboard (window.visualViewport replaced by a fake whose height shrinks, ~500 px portrait, ~200 px
// landscape) at 430x932 and 932x430 (touch):
//   1  Settings: typing in its search field hides the player capsule / bubble / floating pill; the sheet, its field and its results
//      are fully above the keyboard, nothing is on top of them, the results scroll inside the sheet
//   2  the Search sheet (Find): the same
//   3  keyboard down / field blurred: the capsule is back; 4 no page errors
// SHOTS=dir writes <PREFIX><vp>-settings-kb.png / -search-kb.png. ROOT=dir serves another checkout (the "before" pictures).
const fs = require("fs"), path = require("path"), http = require("http");
const ROOT = process.env.ROOT || path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", PORT = +(process.env.PORT || 8833), SHOTS = process.env.SHOTS || "", PREFIX = process.env.PREFIX || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".onnx": "application/octet-stream", ".wasm": "application/wasm" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html"; fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; r.end(); return; } r.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }).listen(PORT, "127.0.0.1", () => res(s)); });
// a fake visualViewport the test can shrink like the iOS keyboard does
const FAKE_VV = () => { const f = new EventTarget(); Object.assign(f, { width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
  try { Object.defineProperty(window, "visualViewport", { configurable: true, get: () => f }); } catch (_) {}
  window.__kb = (h) => { f.width = innerWidth; f.height = h == null ? innerHeight : h; f.dispatchEvent(new Event("resize")); }; };
async function open(p) {
  await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1&lang=en-GB`, { waitUntil: "load" });
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.setItem("tdc.prefs.v1", JSON.stringify({ autohide: "never" })); sessionStorage.clear(); });
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events.find((e) => e.cams.length === 6) || TDC.library.events[0]); }); await W(1500);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); if (TDC.focus && TDC.focus.dismissHint) TDC.focus.dismissHint(); }); await W(700);
}
// is the sheet (and what is in it) clear: inside the visible area, nothing of the player on top?
const CLEAR = ([sheetSel, fieldSel, itemSel]) => { const v = window.visualViewport, vb = v.offsetTop + v.height;
  const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const sh = document.querySelector(sheetSel), f = document.querySelector(fieldSel), sr = sh.getBoundingClientRect(), fr = f.getBoundingClientRect();
  const items = [...sh.querySelectorAll(itemSel)].filter((e) => vis(e)).map((e) => e.getBoundingClientRect()).filter((r) => r.top >= sr.top && r.bottom <= Math.min(sr.bottom, vb) && r.height > 4);
  const covered = []; const probe = (r, tag) => { for (const [x, y] of [[r.left + 6, r.top + r.height / 2], [r.left + r.width / 2, r.top + r.height / 2], [r.right - 6, r.top + r.height / 2]]) { const h = document.elementFromPoint(x, y); if (h && !sh.contains(h)) covered.push(tag + ":" + (h.id || h.className || h.tagName)); } };
  probe(fr, "field"); items.forEach((r, i) => probe(r, "item" + i));
  const player = ["transport", "mbBar", "toolBubble"].map((id) => document.getElementById(id)).filter((e) => e && vis(e) && e.getBoundingClientRect().height > 1).map((e) => e.id);
  const body = sh.querySelector(".drawer-body, .us-results, .us-body") || sh;
  return { typing: document.body.classList.contains("kb-typing"), vb: Math.round(vb), sheet: [sr.top, sr.bottom].map(Math.round), field: [fr.top, fr.bottom].map(Math.round), items: items.length, covered, player,
    inside: sr.top >= -1 && sr.bottom <= vb + 1 && fr.top >= sr.top && fr.bottom <= vb, scrolls: body.scrollHeight <= body.clientHeight + 2 || /auto|scroll/.test(getComputedStyle(body).overflowY) };
};
async function run(b, BR) {
  for (const [vw, vh, kbH] of [[430, 932, 500], [932, 430, 200]]) {
    const T = `${BR} ${vw}x${vh} keyboard ${kbH}`;
    const ctx = await b.newContext({ viewport: { width: vw, height: vh }, hasTouch: true, isMobile: BR === "chromium", deviceScaleFactor: 2 });
    await ctx.addInitScript(FAKE_VV);
    const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
    await open(p);
    // 1 Settings search
    await p.evaluate(() => { document.getElementById("settings").hidden = false; if (TDC.settings) TDC.settings.show("home"); }); await W(400);
    await p.tap("#setFilter"); await p.evaluate((h) => window.__kb(h), kbH); await p.keyboard.type("recog"); await W(600);
    let c = await p.evaluate(CLEAR, ["#settings", "#setFilter", ".row, .set-grp, section:not(.set-off) h3"]);
    if (SHOTS) { await W(1500); await p.screenshot({ path: path.join(SHOTS, PREFIX + vw + "x" + vh + "-settings-kb.png") }); }
    ok(T + " 1 Settings search with the keyboard up: the player capsule and the bubble hide", c.typing && c.player.length === 0, c);
    ok(T + " 1 the sheet, its field and its results are fully above the keyboard, nothing on top, results scroll", c.inside && c.items > 0 && c.covered.length === 0 && c.scrolls, c);
    await p.evaluate(() => { window.__kb(null); document.activeElement.blur(); }); await W(500);
    c = await p.evaluate(() => ({ typing: document.body.classList.contains("kb-typing"), vis: getComputedStyle(document.getElementById(innerWidth < 600 ? "mbBar" : "transport") || document.getElementById("transport")).visibility }));
    ok(T + " 3 keyboard down: the player capsule is back", !c.typing && c.vis === "visible", c);
    await p.evaluate(() => { document.getElementById("settings").hidden = true; }); await W(300);
    // 2 Search sheet
    const us = await p.evaluate(() => { const b = document.getElementById("usBtn"); if (b && b.getClientRects().length) { b.click(); return true; } if (TDC.searchUI && TDC.searchUI.show) { TDC.searchUI.show("find"); return true; } return false; }); await W(600);
    if (us && await p.evaluate(() => !!document.getElementById("usQuery") && document.getElementById("usQuery").getClientRects().length > 0)) {
      await p.tap("#usQuery"); await p.evaluate((h) => window.__kb(h), kbH); await p.keyboard.type("car"); await W(700);
      c = await p.evaluate(CLEAR, ["#usPanel", "#usQuery", ".us-item, .us-chip, .us-row"]);
      if (SHOTS) { await W(1500); await p.screenshot({ path: path.join(SHOTS, PREFIX + vw + "x" + vh + "-search-kb.png") }); }
      ok(T + " 2 the Search sheet with the keyboard up: the capsule hides, the sheet and its field sit above the keyboard, nothing on top", c.typing && c.player.length === 0 && c.inside && c.covered.length === 0, c);
      await p.evaluate(() => { window.__kb(null); document.activeElement.blur(); }); await W(500);
      ok(T + " 3 Search: keyboard down, capsule back", !(await p.evaluate(() => document.body.classList.contains("kb-typing"))));
    } else ok(T + " 2 the Search sheet opens", false, { us });
    ok(T + " 4 no page errors", errs.length === 0, errs);
    await ctx.close();
  }
  // desktop with a mouse: focusing the Settings search changes nothing
  { const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage(); await open(p);
    await p.evaluate(() => { document.getElementById("settings").hidden = false; }); await W(300); await p.click("#setFilter"); await W(300);
    const c = await p.evaluate(() => ({ typing: document.body.classList.contains("kb-typing"), vis: getComputedStyle(document.getElementById("transport")).visibility }));
    ok(BR + " 1440x900 mouse: focusing the Settings search leaves the transport as it is", !c.typing && c.vis === "visible", c); await ctx.close(); }
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
