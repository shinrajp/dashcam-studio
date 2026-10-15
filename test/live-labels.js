// Live viewer labels on the gold box: same text as export burn-in, scales with tile, stays inside the tile,
// doesn't take clicks, works with the camera bar docked beside the video. Desktop + iPhone portrait.
// Serve the repo (python3 -m http.server 8770). SHOTS=file.png saves a screenshot of the desktop view.
const puppeteer = require("puppeteer-core"); const fs = require("fs"), path = require("path");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.FIXTURES || "/workspace/photo-samples/TeslaCam";
const SHOTS = process.env.SHOTS || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) { if (!/2026-10-08_09-01-00/.test(q)) w(q); } else if (/\.(mp4|json)$/.test(f) && f !== "base.mp4") files.push(q); } })(FIX);
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x) : "")); if (!c) fails++; };
async function load(b, vp, ua) {
  const p = await b.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message)); await p.setViewport(vp); if (ua) await p.setUserAgent(ua);
  await p.goto(URL_, { waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important}" });
  await (await p.$("#fileInput")).uploadFile(...files);
  for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
  await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); const e = TDC.library.events.find((x) => !x.locked && x.cams.includes("front")) || TDC.library.events[0]; return TDC.ui.activate(e); });
  await W(1500); return p;
}
const paint = (p) => p.evaluate(async () => {
  const P = TDC.player, S = TDC.search; P.pause(); const t = Math.min(2, P.ev.duration / 2); await P.seek(t); await new Promise((r) => setTimeout(r, 600));
  S.hits = [{ t, cam: "front", box: { x: 0.35, y: 0.38, w: 0.28, h: 0.3 }, score: 0.08 }, { t, cam: "back", box: { x: 0.02, y: 0.0, w: 0.25, h: 0.2 }, score: 0.04 }];
  S.phrase = "white car"; S.anchor = t; TDC.emit("layout"); await new Promise((r) => setTimeout(r, 300));
  const res = {};
  for (const cam of ["front", "back", "left_repeater"]) {
    const tile = P.tiles[cam].tile, cv = tile.querySelector(".find-layer"); if (!cv) { res[cam] = null; continue; }
    const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; let gold = 0, label = 0, minY = 1e9, maxX = 0;
    for (let i = 0; i < d.length; i += 4) { if (!d[i + 3]) continue; const y = Math.floor(i / 4 / cv.width), x = (i / 4) % cv.width;
      if (d[i] > 200 && d[i + 1] > 150 && d[i + 2] < 120) gold++; if (d[i] > 240 && d[i + 1] > 200 && d[i + 2] > 140 && d[i + 2] < 190) label++; minY = Math.min(minY, y); maxX = Math.max(maxX, x); }
    res[cam] = { gold, label, minY, maxX, w: cv.width, h: cv.height, pe: getComputedStyle(cv).pointerEvents, tileW: tile.clientWidth };
  }
  res.text = [TDC.burnBoxes.forHit(S.hits[0]).text, TDC.burnBoxes.forHit(S.hits[1]).text];
  res.exportText = TDC.burnBoxes.at("front", t).map((b) => b.text);
  return res;
});
function check(tag, r) {
  ok(tag + ": front box + label painted", r.front && r.front.gold > 20 && r.front.label > 5, r.front);
  ok(tag + ": label at top edge stays in tile", r.back && r.back.label > 5 && r.back.minY >= 0 && r.back.maxX < r.back.w, r.back);
  ok(tag + ": camera without a hit is empty", r.left_repeater && r.left_repeater.gold === 0);
  ok(tag + ": overlay doesn't take clicks", r.front.pe === "none");
  ok(tag + ": text matches export burn-in", r.text[0] === "white car? (best match)" && r.text[1] === "white car? (match)" && r.exportText[0] === r.text[0], r.text);
}
(async () => {
  const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--hide-scrollbars"], userDataDir: "/tmp/tdc-live-" + Date.now() });
  const d = await load(b, { width: 1440, height: 900 });
  check("desktop", await paint(d));
  await d.click("#btnBarDock"); await W(500);
  ok("bar is docked beside the video", await d.evaluate(() => TDC.focus.barDocked() && document.getElementById("stageBar").parentElement.id === "barDock"));
  const dk = await paint(d); check("desktop, bar docked", dk);
  if (SHOTS) { await d.screenshot({ path: SHOTS }); console.log("saved", SHOTS); }
  ok("docked bar doesn't cover the label", await d.evaluate(() => { const bar = document.getElementById("stageBar").getBoundingClientRect(); return ["front", "back"].every((c) => { const t = TDC.player.tiles[c].tile.getBoundingClientRect(); return !(bar.left < t.right && bar.right > t.left && bar.top < t.bottom && bar.bottom > t.top); }); }));
  ok("desktop no page errors", d.errs.length === 0, d.errs);
  const m = await load(b, { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1");
  const mr = await paint(m); check("iPhone portrait", mr);
  if (SHOTS) { const mp = SHOTS.replace(/\.png$/, "-mobile.png"); await m.screenshot({ path: mp }); console.log("saved", mp); }
  ok("mobile no page errors", m.errs.length === 0, m.errs);
  // fallback: no burn-boxes module → plain box still drawn, no error
  await m.evaluate(() => { delete TDC.burnBoxes; }); const fb = await m.evaluate(() => { TDC.emit("layout"); const cv = TDC.player.tiles.front.tile.querySelector(".find-layer"); const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; let g = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 150 && d[i + 2] < 120) g++; return g; });
  ok("fallback without burn-boxes.js still draws the box", fb > 20, fb);
  ok("fallback no page errors", m.errs.length === 0, m.errs);
  await b.close(); console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
