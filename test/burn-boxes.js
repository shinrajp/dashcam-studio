// Burn detection boxes in export: default OFF, persisted, draws gold box + label scaled per tile,
// nothing without detections, survives missing data, export UI toggle. Saves an example frame if SHOTS is set.
// Serve the repo (python3 -m http.server 8770); clips from FIXTURES (default /workspace/photo-samples/TeslaCam).
const puppeteer = require("puppeteer-core"); const fs = require("fs"), path = require("path");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.FIXTURES || "/workspace/photo-samples/TeslaCam";
const SHOTS = process.env.SHOTS || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) { if (!/2026-10-08_09-01-00/.test(q)) w(q); } else if (/\.(mp4|json)$/.test(f) && f !== "base.mp4") files.push(q); } })(FIX);
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x) : "")); if (!c) fails++; };
(async () => {
  const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"], userDataDir: "/tmp/tdc-burn-" + Date.now() });
  const p = await b.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message)); await p.setViewport({ width: 1440, height: 900 });
  await p.goto(URL_, { waitUntil: "load" });
  await (await p.$("#fileInput")).uploadFile(...files);
  for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
  await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); const e = TDC.library.events.find((x) => !x.locked && x.cams.includes("front")) || TDC.library.events[0]; return TDC.ui.activate(e); });
  await W(2000);
  ok("module loaded", await p.evaluate(() => !!TDC.burnBoxes));
  ok("default OFF", await p.evaluate(() => TDC.burnBoxes.enabled() === false));
  // unit: label + selection
  const u = await p.evaluate(() => {
    const B = TDC.burnBoxes, box = { x: 0.2, y: 0.3, w: 0.3, h: 0.25 };
    return {
      det: B.labelFor({ cls: "car", conf: 0.92, box }, ""),
      rel: B.labelFor({ score: 0.05, box }, "red car", 0.1),
      none: B.at("front", 10, [{ t: 30, cam: "front", box }]).length,
      cam: B.at("back", 10, [{ t: 10, cam: "front", box }]).length,
      bad: B.at("front", 10, [{ t: 10, cam: "front", box: { x: NaN } }, null, { t: 10, cam: "front" }]).length,
      hit: B.at("front", 11, [{ t: 10, cam: "front", box, score: 1 }], "dog"),
      junk: B.at("front", 1, "nope").length,
    };
  });
  ok("label: class + confidence", u.det === "car 92%", u.det);
  ok("label: phrase + relative match", u.rel === "red car 50%", u.rel);
  ok("no detection near t → nothing", u.none === 0 && u.cam === 0);
  ok("bad / absent data → nothing, no throw", u.bad === 0 && u.junk === 0);
  ok("hit within window", u.hit.length === 1 && u.hit[0].text === "dog 100%");
  // render with real frames through the export compositor
  const r = await p.evaluate(async (wantShot) => {
    const P = TDC.player, ev = P.ev; P.pause(); const t = Math.min(2, ev.duration / 2); await P.seek(t); await new Promise((r) => setTimeout(r, 800));
    const frames = {}; for (const cam of TDC.GRID) { const tl = P.tiles[cam]; const v = tl && tl.vids[P.active]; frames[cam] = v && v.videoWidth ? { img: v, w: v.videoWidth, h: v.videoHeight } : null; }
    const out = {};
    for (const [W, H] of [[1920, 1080], [960, 540]]) {
      const c = document.createElement("canvas"); c.width = W; c.height = H; const ctx = c.getContext("2d");
      const geo = TDC.compositor.geometry(W, H, ev.tile, false);
      const show = { labels: false, hud: false, map: false, fsd: false, time: false };
      const save = TDC.search.hits, savePh = TDC.search.phrase;
      TDC.search.hits = [{ t, cam: "front", box: { x: 0.35, y: 0.4, w: 0.3, h: 0.3 }, score: 0.08 }, { t, cam: "back", box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, score: 0.04 }];
      TDC.search.phrase = "white car";
      const px = (x, y) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data];
      const fi = TDC.GRID.indexOf("front"), rc = TDC.compositor.cellRect(geo.grid, fi, 0), f = frames.front;
      const s = Math.min(rc.w / f.w, rc.h / f.h), fw = f.w * s, fh = f.h * s, fx = rc.x + (rc.w - fw) / 2, fy = rc.y + (rc.h - fh) / 2;
      const edge = [fx + 0.5 * fw, fy + 0.7 * fh];   // bottom edge of front box
      TDC.compositor.drawFrame(ctx, geo, t, frames, { ...show, boxes: false }); const off = px(...edge);
      TDC.compositor.drawFrame(ctx, geo, t, frames, { ...show, boxes: true }); const on = px(...edge);
      if (wantShot && W === 1920) out.shot = c.toDataURL("image/png");
      TDC.search.hits = []; TDC.compositor.drawFrame(ctx, geo, t, frames, { ...show, boxes: true }); const empty = px(...edge);
      TDC.search.hits = undefined; let threw = false; try { TDC.compositor.drawFrame(ctx, geo, t, frames, { ...show, boxes: true }); } catch (e) { threw = true; }
      TDC.search.hits = save; TDC.search.phrase = savePh;
      out[W] = { off, on, empty, threw, fs: Math.max(11, Math.round(fh * 0.045)) };
    }
    return out;
  }, !!SHOTS);
  for (const W of ["1920", "960"]) {
    const x = r[W], gold = (c) => c[0] > 160 && c[1] > 115 && c[0] - c[2] > 80;
    ok(W + ": gold box drawn when on", gold(x.on), x.on);
    ok(W + ": not drawn when off", !gold(x.off), x.off);
    ok(W + ": no detections → frame unchanged", x.empty.join() === x.off.join(), [x.empty, x.off]);
    ok(W + ": missing detection data doesn't throw", !x.threw);
  }
  ok("font scales with frame size", r["1920"].fs > r["960"].fs, [r["1920"].fs, r["960"].fs]);
  if (SHOTS && r.shot) { fs.writeFileSync(SHOTS, Buffer.from(r.shot.split(",")[1], "base64")); console.log("saved", SHOTS); }
  // UI toggle + persistence
  await p.evaluate(() => TDC.ui.openExport ? TDC.ui.openExport() : document.getElementById("btnExport").click()); await W(400);
  ok("toggle visible in export dialog, unchecked", await p.evaluate(() => { const c = document.getElementById("exportBoxes"); return !!c && c.offsetParent !== null && !c.checked; }));
  await p.click("#exportBoxes"); await W(100);
  ok("toggle saves to localStorage", await p.evaluate(() => localStorage.getItem("tdc.export.burnBoxes") === "1" && TDC.burnBoxes.enabled()));
  await p.reload({ waitUntil: "load" }); await W(500);
  ok("persists after reload", await p.evaluate(() => TDC.burnBoxes.enabled()));
  await p.evaluate(() => TDC.burnBoxes.setEnabled(false));
  ok("turns off", await p.evaluate(() => localStorage.getItem("tdc.export.burnBoxes") === null));
  ok("no page errors", p.errs.length === 0, p.errs);
  await b.close(); console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
