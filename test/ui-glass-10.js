// ui-glass-10: accessibility pass over the Liquid Glass controls. Checks, at 1440x900 (mouse) and 430x932 (touch):
//   1  every visible control in the bubble, its tray, the camera pill, the map handles, the bottom bar and every Settings group has a name
//      (aria-label, label, text or title);
//   2  touch: each of those is at least 44 x 44 px, or its hit area is (map handles: elementFromPoint 4 / 7 px outside the box still hits it);
//      switches and sliders count by their row; known exception: the phone bar's drag grip (#mbGrip, 30 px hit area; More is 44 px);
//   3  focus: opening the bubble sets aria-expanded and moves focus into the tray, Esc closes it and returns focus to the bubble;
//      Settings is a labelled dialog; the pill grip and map grip are keyboard buttons; no page errors.
//   Playwright, BR=chromium|webkit (default both), mock footage (/tmp/ho-mock). PORT (default 8830). ROOT=dir serves another checkout.
const fs = require("fs"), path = require("path"), http = require("http");
const ROOT = process.env.ROOT || path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", PORT = +(process.env.PORT || 8830);
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".onnx": "application/octet-stream", ".wasm": "application/wasm" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html"; fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; r.end(); return; } r.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }).listen(PORT, "127.0.0.1", () => res(s)); });
const AUDIT = (scopeSel, touch) => {
  const sc = document.querySelector(scopeSel); if (!sc) return { missing: true, n: 0, noname: [], small: [] };
  const SELF = sc.matches('button, [role="button"], [tabindex]:not([tabindex="-1"])') ? [sc] : [];
  const els = [...SELF, ...sc.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="switch"], [role="slider"], [tabindex]:not([tabindex="-1"]), summary')].filter((e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && +cs.opacity > 0.05 && !e.closest("[hidden],[inert]"); });
  const name = (e) => (e.getAttribute("aria-label") || (e.getAttribute("aria-labelledby") && e.getAttribute("aria-labelledby").split(" ").map((i) => (document.getElementById(i) || {}).textContent || "").join(" ")) || (e.labels && e.labels[0] && e.labels[0].textContent) || (e.closest("label") && e.closest("label").textContent) || e.textContent || e.title || e.getAttribute("placeholder") || "").trim();
  const hits = (e, dx, dy) => { const r = e.getBoundingClientRect(); return [[r.left - dx, r.top + r.height / 2], [r.right + dx, r.top + r.height / 2], [r.left + r.width / 2, r.top - dy], [r.left + r.width / 2, r.bottom + dy]].every(([x, y]) => { const h = document.elementFromPoint(x, y); return h === e || e.contains(h); }); };
  const small = [], noname = [];
  for (const e of els) {
    const r = e.getBoundingClientRect(), id = e.id || (typeof e.className === "string" && e.className.split(" ")[0]) || e.tagName;
    if (!name(e)) noname.push(id);
    if (!touch || e.id === "mbGrip") continue;
    if (e.type === "range" || e.type === "checkbox") { const row = e.closest(".row,label"), rr = row ? row.getBoundingClientRect() : r; if (rr.height < 43.5) small.push(id + " row " + Math.round(rr.height)); continue; }
    const dx = r.width >= 43.5 ? -1 : (44 - r.width) / 2 - 0.5, dy = r.height >= 43.5 ? -1 : (44 - r.height) / 2 - 0.5;   // probe just outside the box up to 44 px (inside when already 44)
    if ((r.width < 43.5 || r.height < 43.5) && !(dx <= 4.5 && dy <= 7.5 && hits(e, dx, dy))) small.push(id + " " + Math.round(r.width) + "x" + Math.round(r.height));
  }
  return { n: els.length, noname, small };
};
async function open(p) {
  await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1`, { waitUntil: "load" });
  await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.setItem("tdc.prefs.v1", JSON.stringify({ advanced: true, autohide: "never" })); sessionStorage.clear(); });
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events.find((e) => e.cams.length === 6) || TDC.library.events[0]); }); await W(1500);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); document.getElementById("settings").hidden = true; if (TDC.focus && TDC.focus.dismissHint) TDC.focus.dismissHint(); }); await W(300);
}
async function run(b, BR) {
  for (const [vw, vh, touch] of [[1440, 900, false], [430, 932, true]]) {
    const T = `${BR} ${vw}x${vh}${touch ? " touch" : ""}`;
    const ctx = await b.newContext({ viewport: { width: vw, height: vh }, ...(touch ? { hasTouch: true, isMobile: BR === "chromium" } : {}) });
    const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message)); await open(p);
    const A = (sel) => p.evaluate(`(${AUDIT})(${JSON.stringify(sel)}, ${touch})`);
    for (const [label, sel] of [["camera pill", "#stageBar"], ["bubble", "#tbMain"], ["map grip", "#mapGrip"], ["map move", ".map-move"], ["bottom bar", touch ? "#mbBar" : ".transport"]]) {
      const a = await A(sel);
      ok(T + " 1 " + label + ": every control has a name (" + a.n + ")", a.n > 0 && a.noname.length === 0, a);
      if (touch) ok(T + " 2 " + label + ": 44 px touch targets", a.small.length === 0, a);
    }
    // 3 bubble -> tray
    await p.evaluate(() => document.getElementById("tbMain").focus()); await p.keyboard.press("Enter"); await W(500);
    const tr = await p.evaluate(() => ({ exp: document.getElementById("tbMain").getAttribute("aria-expanded"), inFan: !!(document.activeElement && document.activeElement.closest("#tbFan")), focus: document.activeElement && document.activeElement.id }));
    const fan = await A("#tbFan");
    ok(T + " 3 the bubble opens the tray (aria-expanded) and focus moves into it", tr.exp === "true" && tr.inFan, tr);
    ok(T + " 1 tray: every control has a name (" + fan.n + ")" + (touch ? ", 44 px" : ""), fan.n >= 3 && fan.noname.length === 0 && fan.small.length === 0, fan);
    await p.keyboard.press("Escape"); await W(400);
    const esc = await p.evaluate(() => ({ exp: document.getElementById("tbMain").getAttribute("aria-expanded"), focus: document.activeElement && document.activeElement.id }));
    ok(T + " 3 Esc closes the tray and focus goes back to the bubble", esc.exp !== "true" && esc.focus === "tbMain", esc);
    const kb = await p.evaluate(() => ["barGrip", "mapGrip"].map((id) => { const e = document.getElementById(id); return e ? id + ":" + (e.getAttribute("role") || e.tagName.toLowerCase()) + ":" + e.tabIndex : id + ":none"; }));
    ok(T + " 3 the pill grip and the map grip are keyboard buttons", kb.every((s) => /:(button):0$/.test(s)), kb);
    // Settings, every group
    await p.evaluate(() => { document.getElementById("settings").hidden = false; }); await W(300);
    const dlg = await p.evaluate(() => { const s = document.getElementById("settings"); return { role: s.getAttribute("role"), name: s.getAttribute("aria-label") || s.getAttribute("aria-labelledby") }; });
    ok(T + " 3 Settings is a labelled dialog", dlg.role === "dialog" && !!dlg.name, dlg);
    const bad = [];
    for (const g of [null, "playback", "appearance", "overlays", "redact", "export", "advanced", "keys"]) {
      await p.evaluate((g) => { if (g) TDC.settings.show(g); }, g); await W(200);
      const a = await A("#settings"); if (a.noname.length || a.small.length) bad.push({ g: g || "home", noname: a.noname, small: a.small });
    }
    ok(T + " 1/2 Settings: every group's controls have names" + (touch ? " and are 44 px" : ""), bad.length === 0, bad);
    ok(T + " no page errors", errs.length === 0, errs);
    await ctx.close();
  }
}
(async () => {
  const pw = require("playwright"); const s = await server();
  for (const BR of (process.env.BR || "chromium,webkit").split(",")) {
    let b; try { b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || (fs.existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined) }); }
    catch (e) { console.log("SKIP " + BR + ": " + e.message.split("\n")[0]); continue; }
    try { await run(b, BR); } catch (e) { ok(BR + " run threw", false, e.stack); } finally { await b.close(); }
  }
  s.close(); console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})();
