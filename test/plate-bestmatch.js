// Plates "Best match": merged sightings, one label format everywhere ("7TST123 · match 100% · read 91% · seen 2× · Best match"),
// best match badge on the top result(s) (ties shown), "Best match only" filter (panel + phone strip), persisted;
// gold box / burn-in follow the filter. Uses an injected plate index (no models needed), Chromium + WebKit.
// Usage: node test/plate-bestmatch.js [url]   (SHOTS=dir for screenshots, ENGINES=chromium,webkit)
const { chromium, webkit } = require("playwright"); const fs = require("fs"), path = require("path");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.FIXTURES || "/workspace/photo-samples/TeslaCam";
const SHOTS = process.env.SHOTS || "";
const ENGINES = (process.env.ENGINES || "chromium,webkit").split(",");
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) { if (!/2026-10-08_09-01-00/.test(q)) w(q); } else if (/\.(mp4|json)$/.test(f) && f !== "base.mp4") files.push(q); } })(FIX);
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x) : "")); if (!c) fails++; };
const LABEL = /^[0-9A-Z]{5,8}( · match \d+%)? · read \d+%( · checked by \w+)?( · seen \d+×)?( · Best match)?$/;

async function load(p) {
  await p.goto(URL_, { waitUntil: "load" });
  await p.addStyleTag({ content: ".toast{display:none!important}" });
  await p.setInputFiles("#fileInput", files);
  for (let i = 0; i < 80 && (await p.evaluate(() => TDC.library.events.length)) < 3; i++) await W(250);
  await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); return TDC.ui.activate(TDC.library.events.find((e) => /18-2/.test(e.id))); });
  await W(1200);
  // plates on (no model load needed: the index is injected), no tracking (the plate detector would load models)
  await p.evaluate(async () => {
    const L = TDC.plates; L.setPref("enabled", true); L.trackAround = async () => [];
    const ev = TDC.player.ev, B = (x, y) => ({ x, y, w: 0.09, h: 0.05 });
    const it = (text, cam, t, conf, box) => ({ kind: "plate", text, raw: text, conf, det: 0.8, chars: [], cam, t, box });
    await TDC.libIndex.text.put({ eventId: ev.id, at: Date.now(), cams: ["front", "back", "left_repeater", "right_repeater", "left_pillar", "right_pillar"], step: 1, street: true, model: "fast", items: [
      it("7TST123", "front", 1.0, 0.91, B(0.45, 0.62)), it("7TST123", "front", 1.5, 0.88, B(0.46, 0.62)), it("7TST123", "back", 2.0, 0.86, B(0.5, 0.6)),
      it("7TST128", "front", 4.0, 0.95, B(0.3, 0.6)), it("9TIE999", "back", 6.0, 0.95, B(0.6, 0.65)), it("8DEM042", "back", 8.0, 0.62, B(0.2, 0.7)) ] });
  });
}
// Headless WebKit sometimes never finishes the first load in a context: retry, in a fresh context after the first miss.
async function openPage(ctx) {
  for (let a = 1; ; a++) {
    const c = a === 1 ? ctx : await ctx.browser().newContext(ctx._opts);
    const p = await c.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message));
    try { await Promise.race([load(p), W(60000).then(() => { throw new Error("load timed out"); })]); return p; }
    catch (e) { console.log("NOTE page load retry (" + e.message + ")"); await p.close().catch(() => {}); if (a >= 4) throw e; }
  }
}
const newCtx = async (b, o) => { const c = await b.newContext(o); c._opts = o; return c; };
const search = async (p, q) => { await p.evaluate((q) => { document.getElementById("usQuery").value = q; document.getElementById("usCam").value = "around"; TDC.searchUI.find(q); }, q);
  for (let i = 0; i < 100 && (await p.evaluate(() => TDC.search.running)); i++) await W(150); await W(400); };
const state = (p) => p.evaluate(() => ({
  hits: TDC.search.hits.map((h) => ({ text: h.text, best: !!h.best, cam: h.cam, t: h.t, n: h.sightings ? h.sightings.length : 1 })),
  all: (TDC.search.allHits || []).length,
  list: [...document.querySelectorAll("#usResults .us-item")].map((b) => ({ txt: b.textContent, best: b.classList.contains("best") })),
  classic: document.querySelectorAll("#findHits .find-hit").length,
  toggle: { shown: !document.getElementById("usBestWrap").hidden, on: document.getElementById("usBest").checked },
}));

async function desktop(b, tag) {
  const ctx = await newCtx(b, { viewport: { width: 1440, height: 900 } });
  const p = await openPage(ctx);
  await p.evaluate(() => TDC.searchUI.show(false));
  await search(p, "plate 7TST123");
  let s = await state(p);
  const top = s.hits.find((h) => /^7TST123/.test(h.text));
  ok(tag + " duplicate sightings merged: 7TST123 read 3 times (front twice, rear once) is one result with 2 sightings", s.hits.filter((h) => /^7TST123/.test(h.text)).length === 1 && top && top.n === 2, s.hits);
  ok(tag + " label shows match % and read %", !!top && /^7TST123 · match 100% · read 91% · seen 2× · Best match$/.test(top.text), top);
  ok(tag + " every plate label uses the one format", s.hits.every((h) => LABEL.test(h.text)), s.hits);
  ok(tag + " only the top result is the Best match (match × read)", s.hits.filter((h) => h.best).length === 1 && top.best && s.hits.some((h) => /^7TST128 · match \d+% · read 95%$/.test(h.text) && !h.best), s.hits);
  ok(tag + " results list: badge on the best row", s.list.filter((x) => x.best).length === 1 && s.list.find((x) => x.best).txt.includes("Best match"), s.list);
  ok(tag + " filter toggle shown for plate results, off by default", s.toggle.shown && !s.toggle.on, s.toggle);
  const live = await p.evaluate(() => { const h = TDC.search.hits.find((x) => x.best); return { forHit: TDC.burnBoxes.forHit(h).text, burn: TDC.burnBoxes.at(h.cam, h.t).map((x) => x.text), other: TDC.burnBoxes.at("front", 4.0).map((x) => x.text) }; });
  ok(tag + " live gold-box label and export burn-in use the same text", live.forHit === top.text && live.burn.includes(top.text), live);
  ok(tag + " before filtering, the other plate is burned in at its time", live.other.some((t) => /^7TST128/.test(t)), live);
  if (SHOTS) { await p.evaluate(() => TDC.player.seek(1.0)); await W(900); await p.screenshot({ path: SHOTS + "/plate-bestmatch-desktop-all.png" }); }
  // filter on
  await p.click("#usBest"); await W(500); s = await state(p);
  ok(tag + " Best match only: one result in list, classic bar and S.hits", s.hits.length === 1 && s.hits[0].best && s.list.length === 1 && s.classic === 1 && s.all === 2, s);
  const after = await p.evaluate(() => ({ other: TDC.burnBoxes.at("front", 4.0).length, tl: TDC.search.hits.length }));
  ok(tag + " gold box / burn-in follow the filter (hidden plate not drawn)", after.other === 0, after);
  if (SHOTS) { await p.evaluate(() => TDC.player.seek(1.0)); await W(900); await p.screenshot({ path: SHOTS + "/plate-bestmatch-desktop-filter.png" }); }
  // ties: "plates" → 7TST128 and 9TIE999 both read 95% → both best
  await search(p, "plates"); s = await state(p);
  ok(tag + " 'plates': ties within a small margin are all best, filter keeps both", s.hits.length === 2 && s.hits.every((h) => h.best && /· read 95% · Best match$/.test(h.text) && !/match \d+%/.test(h.text.replace("Best match", ""))) && s.all === 4, s);
  // persists
  await p.reload({ waitUntil: "load" }); await W(400);
  ok(tag + " filter remembered after reload", await p.evaluate(() => TDC.search.bestOnly()));
  await ctx.close();
  const ctx2 = await newCtx(b, { viewport: { width: 1440, height: 900 } });
  const q = await openPage(ctx2);
  await q.evaluate(() => localStorage.setItem("tdc.search.bestOnly", "1"));
  await q.evaluate(() => TDC.searchUI.show(false)); await search(q, "plate 7TST123"); s = await state(q);
  ok(tag + " saved filter applies to a new search", s.hits.length === 1 && s.toggle.on && s.all === 2, s);
  await q.click("#usBest"); await W(400); s = await state(q);
  ok(tag + " unticking shows every result again", s.hits.length === 2 && !s.toggle.on && !(await q.evaluate(() => TDC.search.bestOnly())), s);
  await search(q, "white car"); s = await state(q);
  ok(tag + " toggle hidden for non-plate searches", !s.toggle.shown);
  ok(tag + " desktop no page errors", !p.errs.length && !q.errs.length, p.errs.concat(q.errs));
  await ctx2.close();
}

async function phone(b, tag) {
  const ctx = await newCtx(b, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await openPage(ctx);
  await search(p, "plate 7TST123");
  await p.evaluate(() => { TDC.searchUI.hide(); TDC.focus.focus("front"); TDC.focus.fullscreen(true); }); await W(900);
  let st = await p.evaluate(() => ({ shown: !document.getElementById("usStrip").hidden, best: !document.getElementById("ssBest").hidden, pressed: document.getElementById("ssBest").getAttribute("aria-pressed"),
    items: [...document.querySelectorAll("#ssRow .ss-item")].map((b) => ({ l: b.querySelector(".ss-l").textContent, best: b.classList.contains("best") })) }));
  ok(tag + " strip: plate thumbnails with the shared label, Best badge on the top one", st.shown && st.items.length === 2 && st.items.filter((x) => x.best).length === 1 && st.items.find((x) => x.best).l === "7TST123 · match 100% · read 91% · seen 2× · Best match", st);
  ok(tag + " strip: 'Best only' button shown", st.best && st.pressed === "false", st);
  if (SHOTS) { await W(1200); await p.screenshot({ path: SHOTS + "/plate-bestmatch-mobile-strip.png" }); }
  await p.tap("#ssBest"); await W(500);
  st = await p.evaluate(() => ({ n: document.querySelectorAll("#ssRow .ss-item").length, pressed: document.getElementById("ssBest").getAttribute("aria-pressed"), saved: TDC.search.bestOnly(), hits: TDC.search.hits.length }));
  ok(tag + " strip respects the filter (one thumbnail), saved", st.n === 1 && st.pressed === "true" && st.saved && st.hits === 1, st);
  if (SHOTS) { await W(800); await p.screenshot({ path: SHOTS + "/plate-bestmatch-mobile-strip-filter.png" }); }
  await p.tap('#ssRow .ss-item[data-i="0"]'); await W(800);
  ok(tag + " tap best thumbnail → seeks to the best sighting", await p.evaluate(() => Math.abs(TDC.player.time - 1.0) < 0.3 && TDC.focus.cam === "front"));
  await p.evaluate(() => { TDC.focus.fullscreen(false); TDC.searchUI.show(false); }); await W(400);
  ok(tag + " panel checkbox in sync with the strip", await p.evaluate(() => document.getElementById("usBest").checked && !document.getElementById("usBestWrap").hidden));
  ok(tag + " phone no page errors", !p.errs.length, p.errs);
  await ctx.close();
}

(async () => {
  for (const name of ENGINES) {
    const bt = name === "webkit" ? webkit : chromium;
    const b = await bt.launch(name === "webkit" ? {} : { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--hide-scrollbars"] });
    await desktop(b, name);
    await phone(b, name + " 390x844");
    await b.close();
  }
  console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
