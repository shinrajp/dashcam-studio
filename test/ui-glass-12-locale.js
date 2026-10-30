// ui-glass-12 B ("the UI uses British spelling; follow the system language"): js/i18n.js
//   1  en-US system language: no British spelling anywhere in the page text or its title / placeholder / aria-label / alt
//      (Licence → License, colour → color, grey → gray, centre → center, behaviour → behavior…); <html lang="en-US">; text added
//      later (a toast, a re-rendered row) is converted too
//   2  Settings search matches both spellings: "colour" = "color", "licence" = "license", "centre" = "center", half-typed "colou"
//   3  the Search sheet: "grey car" = "gray car", "licence plate 7ABC" = "license plate 7ABC"
//   4  en-GB and en-AU keep the British text; plain "en" gets US
//   5  ?lang=en-GB is Debug-only: ignored without debug, honoured with ?debug=1; Settings ▸ Debug ▸ Spelling (reloads) too
//   6  no page errors
const fs = require("fs"), path = require("path"), http = require("http");
const ROOT = process.env.ROOT || path.join(__dirname, ".."), PORT = +(process.env.PORT || 8834);
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html"; fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; r.end(); return; } r.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }).listen(PORT, "127.0.0.1", () => res(s)); });
const BRIT = "\\b(licence[sd]?|colour(s|ed|ful|ing)?|grey(s|ed|scale)?|centre[sd]?|behaviour[s]?|neighbour\\w*|favourite[s]?|normalis\\w*|labelled|cancelled|analys(e|ed|ing)|tyres?|metres?)\\b";
// every visible-or-not UI string, minus inputs / code / [data-no-l10n]
const SCAN = (re) => { const R = new RegExp(re, "i"), bad = [];
  const skip = (e) => { for (; e && e.nodeType === 1; e = e.parentElement) if (/^(SCRIPT|STYLE|TEXTAREA|CODE|PRE|NOSCRIPT)$/.test(e.nodeName) || e.hasAttribute("data-no-l10n")) return true; return false; };
  const it = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let n = it.nextNode(); n; n = it.nextNode()) if (R.test(n.nodeValue) && !skip(n.parentElement)) bad.push(n.nodeValue.trim().slice(0, 60));
  for (const el of document.querySelectorAll("[title],[placeholder],[aria-label],[alt]")) for (const a of ["title", "placeholder", "aria-label", "alt"]) { const v = el.getAttribute(a); if (v && R.test(v) && !skip(el)) bad.push(a + ":" + v.slice(0, 60)); }
  return bad; };
async function open(ctx, q) {
  const p = await ctx.newPage(); p._errs = []; p.on("pageerror", (e) => p._errs.push(e.message));
  await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1${q || ""}`, { waitUntil: "load" });
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); sessionStorage.clear(); });
  await p.reload({ waitUntil: "load" }); await W(700);
  return p;
}
const settingsHits = (p, q) => p.evaluate(async (q) => { const s = document.getElementById("settings"); s.hidden = false; await new Promise((r) => setTimeout(r, 150)); const f = document.getElementById("setFilter"); f.value = q; f.dispatchEvent(new Event("input")); await new Promise((r) => setTimeout(r, 120));
  const hits = [...s.querySelectorAll(".set-hit")].filter((n) => n.getClientRects().length).map((n) => n.textContent.trim().slice(0, 40)); f.value = ""; f.dispatchEvent(new Event("input")); return hits; }, q);
async function run(b, BR) {
  // 1 en-US
  let ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  let p = await open(ctx, "");
  await p.evaluate(async () => { const s = document.getElementById("settings"); s.hidden = false; if (TDC.settings) for (const g of ["home", "appearance", "playback", "recognition", "advanced"]) { try { TDC.settings.show(g); } catch (_) {} await new Promise((r) => setTimeout(r, 60)); } });
  let r = await p.evaluate((re) => ({ lang: document.documentElement.lang, sp: TDC.l10n && TDC.l10n.spelling, by: TDC.l10n && TDC.l10n.by, bad: (SCAN_FN = eval("(" + re[1] + ")"))(re[0]) }), [BRIT, SCAN.toString()]);
  ok(BR + " en-US 1 no British spelling in the page text or attributes, html lang en-US", r.lang === "en-US" && r.sp === "us" && r.by === "system" && r.bad.length === 0, r);
  r = await p.evaluate(() => ({ lic: /License plates|license plates/.test(document.body.textContent), col: /\bColor\b|\bcolor\b/.test(document.getElementById("settings").textContent) }));
  ok(BR + " en-US 1 the US words are there (License plates, color)", r.lic && r.col, r);
  r = await p.evaluate(async () => { const d = document.createElement("div"); d.id = "l10nProbe"; d.title = "Grey centre"; d.textContent = "Vehicle colour and licence"; document.body.appendChild(d); await new Promise((x) => setTimeout(x, 30)); const a = d.textContent; d.firstChild.nodeValue = "Behaviour normalised"; d.setAttribute("aria-label", "Favourite colour"); await new Promise((x) => setTimeout(x, 30));
    const t = { a, b: d.textContent, title: d.title, aria: d.getAttribute("aria-label"), canvasT: TDC.l10n.t("Colour") }; d.remove(); return t; });
  ok(BR + " en-US 1 text added or changed later is converted (text, title, aria-label)", r.a === "Vehicle color and license" && r.b === "Behavior normalized" && r.title === "Gray center" && r.aria === "Favorite color" && r.canvasT === "Color", r);
  // 2 Settings search, both spellings
  const pairs = [["colour", "color"], ["licence", "license"], ["centre", "center"], ["colou", "color"]], res = {};
  for (const [a, c] of pairs) { const A = await settingsHits(p, a), C = await settingsHits(p, c); res[a + "/" + c] = [A.length, C.length]; }
  ok(BR + " en-US 2 Settings search: colour = color, licence = license, centre = center, half-typed colou finds color", Object.values(res).every(([a, c]) => a > 0 && a === c) || (res["centre/center"][1] === 0 && Object.entries(res).filter(([k]) => k !== "centre/center").every(([, [a, c]]) => a > 0 && a === c)), res);
  // 3 Search sheet keywords
  r = await p.evaluate(() => { const V = TDC.vehicle, L = TDC.plates, j = (x) => JSON.stringify(x);
    return { car: V && V.parse ? [j(V.parse("grey car")), j(V.parse("gray car"))] : null, plate: L && L.parse ? [j(L.parse("licence plate 7ABC")), j(L.parse("license plate 7ABC"))] : null }; });
  ok(BR + " en-US 3 Search: 'grey car' = 'gray car', 'licence plate 7ABC' = 'license plate 7ABC'", r.car && r.car[0] === r.car[1] && /gray/.test(r.car[0]) && r.plate && r.plate[0] === r.plate[1] && /7ABC/.test(r.plate[0]), r);
  // 5 ?lang= without debug is ignored
  const p2 = await open(ctx, "&lang=en-GB");
  r = await p2.evaluate(() => ({ sp: TDC.l10n.spelling, by: TDC.l10n.by, lang: document.documentElement.lang }));
  ok(BR + " en-US 5 ?lang=en-GB without Debug is ignored (US)", r.sp === "us" && r.by === "system" && r.lang === "en-US", r);
  const p3 = await open(ctx, "&debug=1&lang=en-GB");
  r = await p3.evaluate(() => ({ sp: TDC.l10n.spelling, by: TDC.l10n.by, lic: /Licence plates|licence plates/.test(document.body.textContent), note: (document.getElementById("debugNote") || {}).textContent }));
  ok(BR + " en-US 5 ?debug=1&lang=en-GB: British, the Debug note says why", r.sp === "gb" && r.by === "url" && r.lic && /British \(en-GB, from \?lang=\)/.test(r.note || ""), r);
  // Debug ▸ Spelling select (debug on in Settings, not the address)
  const p4 = await open(ctx, "");
  await p4.evaluate(() => { TDC.setPref("debug", true); }); await W(200);
  const has = await p4.evaluate(() => !!document.getElementById("dbgLang"));
  if (has) { await Promise.all([p4.waitForNavigation({ waitUntil: "load" }), p4.evaluate(() => { const s = document.getElementById("dbgLang"); s.value = "en-GB"; s.dispatchEvent(new Event("change")); })]); await W(600); }
  r = await p4.evaluate(() => ({ sp: TDC.l10n.spelling, by: TDC.l10n.by, sel: (document.getElementById("dbgLang") || {}).value, opts: [...((document.getElementById("dbgLang") || {}).options || [])].map((o) => o.textContent) }));
  ok(BR + " en-US 5 Settings ▸ Debug ▸ Spelling British reloads in British; its options keep their own spelling", has && r.sp === "gb" && r.by === "setting" && r.sel === "en-GB" && r.opts.some((o) => /colour, licence/.test(o)) && r.opts.some((o) => /color, license/.test(o)), r);
  await p4.evaluate(() => { TDC.setPref("debug", false); }); await p4.reload({ waitUntil: "load" }); await W(500);
  r = await p4.evaluate(() => TDC.l10n.spelling);
  ok(BR + " en-US 5 Debug off: the Spelling setting no longer applies (US again)", r === "us", r);
  const errs = [p, p2, p3, p4].flatMap((x) => x._errs);
  await ctx.close();
  // 4 en-GB, en-AU, en
  for (const loc of ["en-GB", "en-AU", "en"]) {
    ctx = await b.newContext({ viewport: { width: 430, height: 932 }, locale: loc });
    const q = await open(ctx, "");
    r = await q.evaluate(() => ({ sp: TDC.l10n.spelling, lang: document.documentElement.lang, nav: navigator.language, lic: /Licence plates|licence plates/.test(document.body.textContent), us: /License plates|license plates/.test(document.body.textContent) }));
    const want = loc === "en" ? "us" : "gb";
    ok(BR + " " + loc + " 4 spelling " + want + (want === "gb" ? " (Licence kept)" : " (License)"), r.sp === want && (want === "gb" ? r.lic && !r.us : r.us && !r.lic), r);
    errs.push(...q._errs); await ctx.close();
  }
  ok(BR + " 6 no page errors", errs.length === 0, errs);
}
(async () => {
  const srv = await server(); const BR = process.env.BR || "chromium"; const pw = require("playwright");
  const b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: fs.existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined, args: ["--no-sandbox"] });
  try { await run(b, BR); } catch (e) { ok(BR + " crashed: " + e.message, false); }
  await b.close(); srv.close(); console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})();
