// Mobile portrait grid: 2x3 (Front|Back, pillars, repeaters), 4-angle collapse to 2x2, min tile size with a
// scrolling grid on small phones, pinned controls, desktop arrangement in landscape, live rotation.
// Usage: node test/portrait-grid.js [url]   FIXTURES=dir with synthetic TeslaCam clips (encrypted events skipped).
const puppeteer = require("puppeteer-core"); const fs = require("fs"), path = require("path");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.FIXTURES || "/workspace/photo-samples/TeslaCam";
const SHOTS = process.env.SHOTS || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) { if (!/2026-10-08_09-01-00/.test(q)) w(q); } else if (/\.(mp4|json)$/.test(f) && f !== "base.mp4") files.push(q); } })(FIX);
let fails = 0; const ok = (name, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined && !cond ? "  " + JSON.stringify(extra) : "")); if (!cond) fails++; };
const DEV = [
  { name: "iPhone SE (1st gen)", w: 320, h: 568, dpr: 2 }, { name: "iPhone SE", w: 375, h: 667, dpr: 2 }, { name: "iPhone 15/16", w: 393, h: 852, dpr: 3 },
  { name: "iPhone Pro Max", w: 430, h: 932, dpr: 3 }, { name: "iPad", w: 820, h: 1180, dpr: 2 },
];
const P6 = ["front", "back", "left_pillar", "right_pillar", "left_repeater", "right_repeater"];
const P4 = ["front", "back", "left_repeater", "right_repeater"];
const L6 = ["left_pillar", "front", "right_pillar", "left_repeater", "back", "right_repeater"];

const layout = (p) => p.evaluate(() => {
  const tiles = [...document.querySelectorAll("#grid .tile")].filter((t) => !t.classList.contains("off")).map((t) => { const r = t.getBoundingClientRect(); return { cam: t.dataset.cam, x: Math.round(r.left), y: Math.round(r.top), w: r.width, h: r.height }; });
  tiles.sort((a, b) => a.y - b.y || a.x - b.x);
  const vp = document.getElementById("viewport"), tp = document.getElementById("transport").getBoundingClientRect();
  const ev = TDC.player.ev, tile = ev && ev.tile ? ev.tile : { w: 1448, h: 938 };
  return { order: tiles.map((t) => t.cam), tiles, rows: new Set(tiles.map((t) => t.y)).size, cols: new Set(tiles.map((t) => t.x)).size,
    portrait: document.body.classList.contains("portrait"), scroll: document.body.classList.contains("portrait-scroll"),
    vpScroll: vp.scrollHeight - vp.clientHeight, vpTop: vp.scrollTop, vpH: vp.clientHeight, aspect: tile.w / tile.h,
    tpTop: Math.round(tp.top), tpBottom: Math.round(tp.bottom), iw: innerWidth, ih: innerHeight };
});
async function open(p, re) { await p.evaluate((re) => { const e = TDC.library.events.find((x) => new RegExp(re).test(x.id)); return TDC.ui.activate(e); }, re); await W(900); }

(async () => {
  const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--hide-scrollbars"], userDataDir: "/tmp/tdc-pg-" + Date.now() });
  for (const d of DEV) {
    const p = await b.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
    await p.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1");
    await p.setViewport({ width: d.w, height: d.h, deviceScaleFactor: d.dpr, isMobile: true, hasTouch: true, isLandscape: false });
    await p.goto(URL_, { waitUntil: "load" });
    if (SHOTS) await p.addStyleTag({ content: ".toast{display:none!important}" });
    await (await p.$("#fileInput")).uploadFile(...files);
    for (let i = 0; i < 80 && (await p.evaluate(() => TDC.library.events.length)) < 3; i++) await W(250);
    await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
    const tag = d.name + " portrait";
    // 6-angle
    await open(p, "2026-10-07_18-2"); let L = await layout(p);
    ok(tag + " 6-cam order Front|Back, pillars, repeaters (2x3)", L.portrait && L.order.join() === P6.join() && L.cols === 2 && L.rows === 3, L.order);
    const minW = (d.w - 12 - 2) / 2 - 2;   // (viewport - padding - gap)/2
    const t0 = L.tiles[0];
    ok(tag + " tiles full half-width (>= " + Math.round(minW) + "px), not shrunk", L.tiles.every((t) => t.w >= minW), L.tiles.map((t) => Math.round(t.w)));
    ok(tag + " tiles keep camera aspect", Math.abs(t0.w / t0.h - L.aspect) / L.aspect < 0.03, { tile: t0.w / t0.h, cam: L.aspect });
    const scrollChecks = async (tag, L) => {
      const t0 = L.tiles[0];
      const needH = 3 * t0.h + 4;
      if (!(needH > L.vpH - 12)) { ok(tag + " all 3 rows fit, no scrolling", !L.scroll && L.vpScroll <= 0, L); return false; }
      ok(tag + " grid scrolls (rows don't fit: need " + Math.round(needH) + " > " + L.vpH + ")", L.scroll && L.vpScroll > 0, L);
      const tpBefore = L.tpTop;
      await p.evaluate(() => { const v = document.getElementById("viewport"); v.scrollTop = v.scrollHeight; }); await W(200);
      const L2 = await layout(p);
      const last = L2.tiles[L2.tiles.length - 1];
      ok(tag + " controls pinned while grid scrolls", L2.vpTop > 0 && L2.tpTop === tpBefore && L2.tpBottom === L2.ih, { vpTop: L2.vpTop, tp: [tpBefore, L2.tpTop, L2.tpBottom, L2.ih] });
      ok(tag + " last row reachable above the controls", last.y + last.h <= L2.tpTop + 1, { lastBottom: last.y + last.h, tpTop: L2.tpTop });
      // focus a camera: no scroll, single camera fits; back to grid restores the scrolling grid
      await p.evaluate(() => TDC.focus.focus("left_repeater")); await W(300);
      const Lf = await layout(p);
      ok(tag + " focused camera fits, no scrolling (pinch/pan stays inside the camera)", !Lf.scroll && Lf.vpScroll <= 0 && Lf.vpTop === 0 && Lf.order.join() === "left_repeater", Lf);
      await p.evaluate(() => TDC.focus.grid()); await W(300);
      ok(tag + " back to grid scrolls again", (await layout(p)).scroll);
      return true;
    };
    if (await scrollChecks(tag, L) && SHOTS) { await p.evaluate(() => { document.getElementById("viewport").scrollTop = 40; TDC.player.seek(4); }); await W(900); await p.screenshot({ path: `${SHOTS}/portrait-${d.w}-scrolling.png` }); }
    if (/SE/.test(d.name)) {   // force the scroll case: the classic search bars make the controls much taller
      await p.evaluate(() => TDC.searchUI.setClassic(true)); await W(400);
      const scrolled = await scrollChecks(tag + " + classic bars", await layout(p));
      ok(tag + " + classic bars: grid scrolled instead of shrinking", scrolled);
      await p.evaluate(() => { TDC.searchUI.setClassic(false); document.getElementById("viewport").scrollTop = 0; }); await W(400);
      ok(tag + " classic off: back to the normal state", (await layout(p)).scroll === L.scroll);
    }
    if (SHOTS && (d.w === 375 || /Pro Max|iPad/.test(d.name))) { await p.evaluate(() => { document.getElementById("viewport").scrollTop = 0; TDC.player.seek(4); }); await W(900); await p.screenshot({ path: `${SHOTS}/portrait-${d.name.replace(/\W+/g, "-").toLowerCase()}.png` }); }
    // search panel still works in portrait: docked under the grid (search-float), visible above the controls
    const sheet = await p.evaluate(() => { TDC.searchUI.show(false); const pn = document.getElementById("usPanel"), r = pn.getBoundingClientRect(), tp = document.getElementById("transport").getBoundingClientRect();
      const okk = pn.classList.contains("docked") && r.height > 60 && r.bottom <= tp.top + 1 && r.top >= document.getElementById("viewport").getBoundingClientRect().bottom - 1; TDC.searchUI.hide(); return okk; });
    ok(tag + " search panel docked under the grid works", sheet);
    // 4-angle
    await open(p, "2026-10-07_18-4"); L = await layout(p);
    ok(tag + " 4-cam collapses to Front|Back, repeaters (2x2, no pillar slots)", L.order.join() === P4.join() && L.rows === 2 && L.cols === 2, L.order);
    ok(tag + " 4-cam tiles full half-width", L.tiles.every((t) => t.w >= minW), L.tiles.map((t) => Math.round(t.w)));
    // 5-angle event (one pillar file missing) keeps all six slots so rows don't shift
    await open(p, "2026-10-08_08-15"); L = await layout(p);
    ok(tag + " 5-cam event keeps row positions", L.rows === 3 && L.cols === 2 && L.tiles.find((t) => t.cam === "right_repeater").y === L.tiles.find((t) => t.cam === "left_repeater").y, L.order);
    // rotate live to landscape
    await open(p, "2026-10-07_18-2");
    await p.setViewport({ width: d.h, height: d.w, deviceScaleFactor: d.dpr, isMobile: true, hasTouch: true, isLandscape: true }); await W(500);
    L = await layout(p);
    ok(d.name + " landscape: desktop arrangement 3x2, no scroll", !L.portrait && !L.scroll && L.order.join() === L6.join() && L.cols === 3 && L.rows === 2, L.order);
    await open(p, "2026-10-07_18-4"); L = await layout(p);
    ok(d.name + " landscape 4-cam: same as desktop (unchanged)", !L.portrait && L.cols === 3, L.order);
    if (SHOTS && d.name === "iPhone 15/16") { await open(p, "2026-10-07_18-2"); await p.evaluate(() => TDC.player.seek(4)); await W(900); await p.screenshot({ path: `${SHOTS}/landscape-iphone-15.png` }); }
    await p.setViewport({ width: d.w, height: d.h, deviceScaleFactor: d.dpr, isMobile: true, hasTouch: true, isLandscape: false }); await W(500);
    await open(p, "2026-10-07_18-2");
    ok(d.name + " rotate back to portrait: 2x3 again", (await layout(p)).order.join() === P6.join());
    ok(d.name + " no page errors", !errs.length, errs);
    await p.close();
  }
  // desktop unchanged
  const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 }); await p.goto(URL_, { waitUntil: "load" });
  await (await p.$("#fileInput")).uploadFile(...files);
  for (let i = 0; i < 80 && (await p.evaluate(() => TDC.library.events.length)) < 3; i++) await W(250);
  await open(p, "2026-10-07_18-2"); const L = await layout(p);
  ok("desktop 1440x900 unchanged (3x2, desktop order, no scroll)", !L.portrait && !L.scroll && L.order.join() === L6.join(), L.order);
  await b.close();
  console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
