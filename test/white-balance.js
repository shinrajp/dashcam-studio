// Live white balance (tag white-balance): js/wb.js. Synthetic night footage (tools/make-wb-footage.py): four cameras under
// a ~3000 K streetlight cast, white car paint on the inner edge of both mirror cameras, a bright red lamp reflection on the
// left-mirror paint at 4.0–4.5 s; a second event with no paint. Playwright Chromium + WebKit.
// Checks: estimator unit cases (clipped / red / green / outlier pixels, jump rejection, smoothing, CCT + words), the
// estimated CCT and the readout, the red flash leaves the estimate steady, corrected VIDEO pixels (screenshot) move ~70 %
// toward neutral (SVG filter and blend fallback), overlay pixels unchanged, detection input + export output unchanged
// (frame-by-frame), toggle saved, paused when the tab is hidden, "Looking for your white paint…" without paint,
// focused + zoomed full-screen view and the 360 view.        Usage: node test/white-balance.js [url]   (BR=chromium,webkit)
const pw = require("playwright"); const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.WB_SAMPLES || "/tmp/wb-samples", FIX0 = process.env.WB_NOPAINT || "/tmp/wb-nopaint";
const SHOTS = process.env.WB_SHOTS || path.join(__dirname, "../screenshots");
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const gen = (dir, env) => { if (!fs.existsSync(dir + "/truth.json")) execFileSync("python3", [path.join(__dirname, "../tools/make-wb-footage.py"), dir], { stdio: "inherit", env: { ...process.env, ...env } }); };
gen(FIX, {}); gen(FIX0, { NOPAINT: "1" });
const truth = JSON.parse(fs.readFileSync(FIX + "/truth.json", "utf8"));
const list = (d0) => { const out = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) w(q); else out.push(q); } })(d0 + "/TeslaCam"); return out; };
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x).slice(0, 600) : "")); if (!c) fails++; };
const info = (n, x) => console.log("INFO " + n + (x !== undefined ? "  " + JSON.stringify(x).slice(0, 600) : ""));

async function load(p, dirs) {
  await p.goto(URL_, { waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important} .bar-hint{display:none!important}" });
  await p.setInputFiles("#fileInput", dirs.flatMap(list));
  for (let i = 0; i < 80 && (await p.evaluate(() => TDC.library.events.length)) < dirs.length; i++) await W(250);
  await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); });
  await openEv(p, true);
}
const openEv = (p, paint) => p.evaluate(async (paint) => { const ev = TDC.library.events.find((e) => (e.name || e.id || "").includes(paint ? "21-00-00" : "21-10-00")) || TDC.library.events[paint ? 0 : 1]; await TDC.ui.activate(ev); await new Promise((r) => setTimeout(r, 1200)); return ev.name || ev.id; }, paint);
const seek = (p, t) => p.evaluate(async (t) => { TDC.player.pause(); await TDC.player.seek(t); await new Promise((r) => setTimeout(r, 700)); }, t);
// mean colour of a region of a camera's picture (fractions of the video frame), read from a real screenshot (= what the user sees)
async function shotMean(p, cam, rx0, ry0, rx1, ry1) {
  const box = await p.evaluate(([cam, rx0, ry0, rx1, ry1]) => {
    const v = TDC.player.tiles[cam].vids[TDC.player.active], r = TDC.player.tiles[cam].tile.getBoundingClientRect(),   // untransformed box (the video is inset: 0)
      vw = v.videoWidth, vh = v.videoHeight;
    const s = Math.min(r.width / vw, r.height / vh), w = vw * s, h = vh * s, x = r.left + (r.width - w) / 2, y = r.top + (r.height - h) / 2;
    const m = new DOMMatrix(getComputedStyle(v).transform === "none" ? undefined : getComputedStyle(v).transform);   // focused + zoomed: scale about the centre
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2, tp = (px, py) => [cx + m.a * (px - cx) + m.e, cy + m.d * (py - cy) + m.f];
    const [X0, Y0] = tp(x + rx0 * w, y + ry0 * h), [X1, Y1] = tp(x + rx1 * w, y + ry1 * h);
    return { x: Math.max(0, X0) + 2, y: Math.max(0, Y0) + 2, width: Math.max(4, Math.min(innerWidth, X1) - Math.max(0, X0) - 4), height: Math.max(4, Math.min(innerHeight, Y1) - Math.max(0, Y0) - 4) };
  }, [cam, rx0, ry0, rx1, ry1]);
  const png = await p.screenshot({ clip: box });
  return p.evaluate(async (b64) => { const bm = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob()); const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext("2d"); x.drawImage(bm, 0, 0); const d = x.getImageData(0, 0, bm.width, bm.height).data; let r = 0, g = 0, b = 0, n = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; } return [r / n, g / n, b / n]; }, png.toString("base64"));
}
const chroma = (c) => Math.hypot(Math.log(c[0] / c[1]), Math.log(c[2] / c[1]));   // distance from neutral (log R/G, B/G)
// pixel diff of two PNG screenshots, done in Python (decoding megapixel PNGs inside WebKit's page can take the page down)
const pngDiff = async (p, a, b) => { fs.writeFileSync("/tmp/wb-diff-a.png", a); fs.writeFileSync("/tmp/wb-diff-b.png", b);
  return JSON.parse(execFileSync("python3", ["-c", `
import json; import numpy as np; from PIL import Image
A=np.asarray(Image.open('/tmp/wb-diff-a.png').convert('RGB')).astype(int); B=np.asarray(Image.open('/tmp/wb-diff-b.png').convert('RGB')).astype(int)
d=np.abs(A-B).max(2); h,w=d.shape; yy,xx=np.mgrid[0:h,0:w]; corner=((xx<12)|(xx>w-13))&((yy<12)|(yy>h-13))
ys,xs=np.nonzero((d>0)&~corner)
print(json.dumps({"len":int(d.size),"diff":int(len(xs)),"max":int(d.max()),"bbox":[int(xs.min()),int(ys.min()),int(xs.max()),int(ys.max())] if len(xs) else None,"cornerAA":int(((d>0)&corner).sum())}))`]).toString()); };
const setWb = (p, on) => p.evaluate(async (on) => { TDC.wb.set(on); await new Promise((r) => setTimeout(r, 600)); }, on);
const ui = (p) => p.evaluate(() => { const b = document.getElementById("chipWb"), r = document.getElementById("wbReadout"); return { pressed: b && b.getAttribute("aria-pressed"), chipVisible: !!(b && b.offsetParent), readout: r && !r.hidden ? r.textContent : null, readoutVisible: !!(r && !r.hidden && r.getBoundingClientRect().width > 0), saved: localStorage.getItem("tdc.wb.v1"), applied: TDC.wb.applied }; });

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const bn of (process.env.BR || "chromium,webkit").split(",")) {
    const b = await pw[bn].launch(bn === "chromium" ? { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } : {});
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => { if (!sessionStorage.getItem("wbt")) { sessionStorage.setItem("wbt", "1"); localStorage.removeItem("tdc.wb.v1"); localStorage.removeItem("tdc.wb.mode"); localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false, live: false })); } });
    const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("crash", () => { console.log("PAGE CRASHED"); process.exit(3); });
    const tag = bn;
    await load(p, [FIX, FIX0]);

    // ── unit: estimator ──
    const u = await p.evaluate(() => {
      const WB = TDC.wb, C = WB.C, mk = (fill) => { const w = 40, h = 90, d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { const c = fill(i % w, (i / w) | 0); d.set([c[0], c[1], c[2], 255], i * 4); } return { data: d, width: w, height: h }; };
      const paint = [150, 106, 60], dark = [20, 14, 9];
      const out = {};
      const scene = (extra) => mk((x, y) => (y > 40 && y < 50 ? paint : extra(x, y) || dark));
      out.base = WB.analyse(scene(() => null));
      out.clipped = WB.analyse(scene((x, y) => (y >= 50 && y < 60 ? [255, 255, 255] : null)));   // big neutral clipped specular
      out.red = WB.analyse(scene((x, y) => (y >= 50 && y < 60 ? [235, 95, 40] : null)));         // brighter red lamp
      out.green = WB.analyse(scene((x, y) => (y >= 50 && y < 60 ? [60, 240, 150] : null)));      // green traffic light
      out.speck = WB.analyse(scene((x, y) => (y === 45 && x < 3 ? [200, 200, 200] : null)));      // a few neutral specks among the paint top pixels
      out.absent = WB.analyse(mk(() => dark));
      out.blank = WB.analyse(mk(() => [0, 0, 0]));
      // running estimate
      WB.reset(); const base = [150, 106, 60], t0 = 1e9;
      WB.update(base, t0); const e0 = WB.state.est.slice();
      const spike = [WB.update([240, 90, 40], t0 + 1), WB.update([240, 90, 40], t0 + 2), WB.update([240, 90, 40], t0 + 3)];
      const afterSpike = Math.hypot(WB.state.est[0] - e0[0], WB.state.est[1] - e0[1]);
      // a real light change persists → accepted after JUMP_ACCEPT samples
      WB.reset(); WB.update(base, t0); let r = null, n = 0; for (; n < 40 && r !== "accept-jump"; n++) r = WB.update([110, 120, 140], t0 + n);
      out.persist = { r, n, need: C.JUMP_ACCEPT };
      // smoothing: a small step (below the jump threshold)
      WB.reset(); WB.update(base, t0); const tgt = [150 * 1.12, 106, 60 * 1.05], lt = [Math.log(tgt[0] / tgt[1]), Math.log(tgt[2] / tgt[1])], le = WB.state.est.slice();
      const step = Math.hypot(lt[0] - le[0], lt[1] - le[1]), prog = [];
      for (let i = 0; i < 14; i++) { WB.update(tgt, t0 + 10 + i); prog.push(1 - Math.hypot(lt[0] - WB.state.est[0], lt[1] - WB.state.est[1]) / step); }
      out.smooth = { step, after1: prog[0], after4: prog[3], after12: prog[11] };
      out.spike = { spike, afterSpike };
      out.cct = { d65: WB.cct([255, 255, 255]), k3000: WB.cct([203, 146, 86]), sodium: WB.describe(WB.cct([255, 150, 40]), [255, 150, 40]), d65w: WB.describe(WB.cct([255, 255, 255]), [255, 255, 255]), cool: WB.describe(WB.cct([225, 235, 255]), [225, 235, 255]) };
      out.gains = WB.gains([203, 146, 86]);
      WB.reset();
      return out;
    });
    const near = (a, b, tol) => a && Math.abs(a[0] / a[1] - b[0] / b[1]) < tol && Math.abs(a[2] / a[1] - b[2] / b[1]) < tol;
    ok(tag + " unit: paint found, a large clipped (≥250) neutral highlight ignored", u.base.found && near(u.clipped.rgb, [150, 106, 60], 0.02), { base: u.base.rgb, clipped: u.clipped });
    ok(tag + " unit: hue gate skips a brighter red lamp and a green light (paint still measured)", near(u.red.rgb, [150, 106, 60], 0.02) && u.red.rejectedHue > 0 && near(u.green.rgb, [150, 106, 60], 0.02) && u.green.rejectedHue > 0, { red: u.red, green: u.green });
    ok(tag + " unit: neutral specks among the top pixels are trimmed (median outlier rule)", near(u.speck.rgb, [150, 106, 60], 0.02), u.speck);
    ok(tag + " unit: no paint → not found; black frame → blank (hidden video)", !u.absent.found && !u.absent.blank && u.blank.blank, { absent: u.absent, blank: u.blank });
    ok(tag + " unit: a 3-sample red jump is rejected (estimate unchanged); a lasting change is accepted after JUMP_ACCEPT samples", u.spike.spike.every((s) => s === "jump") && u.spike.afterSpike < 1e-9 && u.persist.r === "accept-jump" && u.persist.n === u.persist.need, { ...u.spike, persist: u.persist });
    ok(tag + " unit: smoothing over several frames (1 sample < 35 %, 12 samples > 90 % of a step)", u.smooth.after1 < 0.35 && u.smooth.after4 > 0.5 && u.smooth.after12 > 0.9, u.smooth);
    ok(tag + " unit: CCT (McCamy) and words: white ≈ 6500 K Daylight, 3000 K white ≈ 3000 K, orange = Sodium, bluish = Cool/Daylight", Math.abs(u.cct.d65 - 6500) < 150 && Math.abs(u.cct.k3000 - 3000) < 150 && u.cct.sodium === "Sodium streetlight" && u.cct.d65w === "Daylight" && /Cool|Daylight/.test(u.cct.cool), u.cct);
    ok(tag + " unit: gains = lerp(1, ref/white, 0.7), red down / blue up, clamped", u.gains[0] < 1 && u.gains[2] > 1 && u.gains.every((g) => g >= 0.5 && g <= 2.2), u.gains);

    // ── off by default; turning it on ──
    let s = await ui(p);
    ok(tag + ": off by default: chip next to HUD/Map, aria-pressed=false, no readout, nothing applied", s.chipVisible && s.pressed === "false" && !s.readoutVisible && !s.applied && (await p.evaluate(() => { const c = document.getElementById("chipWb"); return c.parentElement.id === "chips" && !!c.parentElement.querySelector('[data-show="map"]'); })), s);
    await seek(p, 1.0);
    const rawShot = await p.screenshot();
    const off = { paint: await shotMean(p, "right_repeater", 0.02, 0.78, 0.12, 0.95), front: await shotMean(p, "front", 0.1, 0.1, 0.9, 0.9) };
    const det0 = await p.evaluate(() => { const v = TDC.player.tiles.front.vids[TDC.player.active], c = document.createElement("canvas"); c.width = 64; c.height = 48; const x = c.getContext("2d"); x.drawImage(v, 0, 0, 64, 48); return Array.from(x.getImageData(0, 0, 64, 48).data).join(","); });
    await p.click("#chipWb"); await W(1500);
    s = await ui(p);
    const cur = await p.evaluate(() => TDC.wb.current());
    ok(tag + ": tap → on (aria-pressed, saved), readout '<K> K · Warm streetlight · both mirrors'", s.pressed === "true" && s.saved === "1" && /^\d{4} K · Warm streetlight · both mirrors$/.test(s.readout || ""), s);
    ok(tag + ": estimated CCT is roughly the footage's light (" + truth.cct + " K ± 350)", cur && Math.abs(cur.cct - truth.cct) < 350, { cct: cur && Math.round(cur.cct), truth: truth.cct, white: cur && cur.white.map(Math.round) });
    const onShot = await p.screenshot();
    fs.writeFileSync(path.join(SHOTS, "white-balance-before-" + bn + ".png"), rawShot);
    fs.writeFileSync(path.join(SHOTS, "white-balance-after-" + bn + ".png"), onShot);

    // ── corrected pixels, both render paths ──
    for (const mode of ["svg", "blend"]) {
      await p.evaluate((m) => { localStorage.setItem("tdc.wb.mode", m); TDC.wb.apply(); }, mode); await W(400);
      const on = { paint: await shotMean(p, "right_repeater", 0.02, 0.78, 0.12, 0.95), front: await shotMean(p, "front", 0.1, 0.1, 0.9, 0.9) };
      const g = (await p.evaluate(() => TDC.wb.applied)).gains;
      const red = 1 - chroma(on.paint) / chroma(off.paint);
      // what per-channel gains predict for the paint (sRGB values × gains, clipped)
      const pred = off.paint.map((c, i) => Math.min(255, c * g[i])), predRed = 1 - chroma(pred) / chroma(off.paint);
      const lumOff = 0.2126 * off.paint[0] + 0.7152 * off.paint[1] + 0.0722 * off.paint[2], lumOn = 0.2126 * on.paint[0] + 0.7152 * on.paint[1] + 0.0722 * on.paint[2];
      ok(tag + " [" + mode + "]: white paint on screen moves toward neutral by ~70 % (55–85 %), brightness kept (±12 %)", red > 0.55 && red < 0.85 && Math.abs(lumOn / lumOff - 1) < 0.12, { off: off.paint.map(Math.round), on: on.paint.map(Math.round), reduction: +red.toFixed(3), predicted: +predRed.toFixed(3), lum: [lumOff, lumOn].map(Math.round), gains: g.map((x) => +x.toFixed(3)) });
      ok(tag + " [" + mode + "]: the whole front camera is corrected too (R/B ratio drops)", on.front[0] / on.front[2] < 0.85 * (off.front[0] / off.front[2]), { off: off.front.map(Math.round), on: on.front.map(Math.round) });
    }
    await p.evaluate(() => { localStorage.removeItem("tdc.wb.mode"); TDC.wb.apply(); });
    info(tag + " default render path", await p.evaluate(() => TDC.wb.mode()));

    // ── overlays keep their colours ──
    await p.evaluate(() => { for (const k of ["labels", "hud", "map", "fsd", "time"]) TDC.setPref("show." + k, true); });
    await p.evaluate(() => { const t = TDC.player.tiles.front.tile; let c = t.querySelector(".find-layer.wbtest"); if (!c) { c = document.createElement("canvas"); c.className = "find-layer wbtest"; c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none"; t.appendChild(c); } c.width = t.clientWidth; c.height = t.clientHeight; const x = c.getContext("2d"); x.strokeStyle = "#ffcc00"; x.lineWidth = 6; x.strokeRect(40, 40, 160, 100); x.fillStyle = "#00e5ff"; x.fillRect(60, 160, 60, 30); });
    await W(500);
    const ovBox = await p.evaluate(() => { const r = TDC.player.tiles.front.tile.getBoundingClientRect(); return { x: r.left + 40, y: r.top + 37, width: 170, height: 156 }; });
    const ovPix = async () => p.evaluate(async (b64) => { const bm = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob()); const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext("2d"); x.drawImage(bm, 0, 0); const d = (px, py) => Array.from(x.getImageData(px, py, 1, 1).data.slice(0, 3)); return { gold: d(80, 3), cyan: d(50, 140) }; }, (await p.screenshot({ clip: ovBox })).toString("base64"));
    const hideMedia = (h) => p.evaluate((h) => { document.querySelectorAll(".tile video, .wb-tint, #panoCanvas, .tile").forEach((e) => { if (e.classList.contains("tile")) e.style.background = h ? "#000" : ""; else e.style.visibility = h ? "hidden" : ""; }); document.getElementById("wbReadout").style.visibility = h ? "hidden" : ""; }, h);
    const ovOn = await ovPix(); await hideMedia(true); await W(300); const stOn = await p.screenshot({ clip: await p.evaluate(() => { const r = document.getElementById("stage").getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }) }); await hideMedia(false);
    await setWb(p, false);
    const ovOff = await ovPix(); await hideMedia(true); await W(300); const stOff = await p.screenshot({ clip: await p.evaluate(() => { const r = document.getElementById("stage").getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }) }); await hideMedia(false);
    const dS = await pngDiff(p, stOn, stOff);
    if (dS.diff) { fs.writeFileSync("/tmp/wb-stOn.png", stOn); fs.writeFileSync("/tmp/wb-stOff.png", stOff); info(tag + ": elements at the first differing pixel", await p.evaluate(([x, y]) => { const r = document.getElementById("stage").getBoundingClientRect(); return document.elementsFromPoint(r.left + x + 0.5, r.top + y + 0.5).slice(0, 6).map((e) => e.tagName + "#" + e.id + "." + e.className); }, [dS.bbox[0], dS.bbox[1]])); }
    ok(tag + ": overlays unchanged: with the videos hidden, the stage (HUD, map, labels, time, self-driving, bar, boxes) is pixel-identical on vs off (the stage's rounded-corner anti-aliasing is ignored)", dS.diff === 0 && dS.cornerAA <= 64, dS);
    ok(tag + ": box drawn over the corrected video keeps its colours (gold stroke, cyan fill)", JSON.stringify(ovOn) === JSON.stringify(ovOff) && ovOn.gold[0] > 240 && ovOn.gold[2] < 20 && ovOn.cyan[1] > 220, { on: ovOn, off: ovOff });
    const filt = () => p.evaluate(() => [...document.querySelectorAll("#stage *")].filter((e) => !e.matches(".tile video, #panoCanvas") && getComputedStyle(e).filter !== "none").map((e) => (e.id || e.className) + ": " + getComputedStyle(e).filter).join(" | "));
    const fOff = await filt(); await setWb(p, true); const fOn = await filt(); await setWb(p, false);
    ok(tag + ": overlay elements keep their own filters (white balance adds none outside the videos)", fOn === fOff && !/tdcWb/.test(fOn), { on: fOn.slice(0, 300), off: fOff.slice(0, 300) });
    await p.evaluate(() => document.querySelector(".find-layer.wbtest").remove());
    await setWb(p, true);

    // ── detection input + export unchanged ──
    await seek(p, 1.0);
    const det1 = await p.evaluate(() => { const v = TDC.player.tiles.front.vids[TDC.player.active], c = document.createElement("canvas"); c.width = 64; c.height = 48; const x = c.getContext("2d"); x.drawImage(v, 0, 0, 64, 48); return Array.from(x.getImageData(0, 0, 64, 48).data).join(","); });
    ok(tag + ": detection reads raw frames (drawImage of the video is identical with white balance on)", det1 === det0);
    const exportRun = () => p.evaluate(async () => {
      const C = TDC.compositor, d0 = C.drawFrame, hs = [];
      C.drawFrame = function (ctx) { const r = d0.apply(this, arguments); const im = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data; let h = 2166136261; for (let i = 0; i < im.length; i += 3) { h ^= im[i]; h = Math.imul(h, 16777619) >>> 0; } hs.push(h); return r; };
      let r; try { r = await TDC.exporter.run({ preset: "compat", ranges: [[1.0, 2.0]], show: { ...TDC.prefs.show }, onStatus: () => {}, onProgress: () => {} }); } finally { C.drawFrame = d0; }
      const u8 = new Uint8Array(await r.blob.arrayBuffer()); let h = 2166136261; for (const x of u8) { h ^= x; h = Math.imul(h, 16777619) >>> 0; }
      return { frames: hs, size: u8.length, fileHash: h };
    });
    const exOn = await exportRun(); await setWb(p, false); const exOff = await exportRun(); await setWb(p, true);
    ok(tag + ": export frames are identical with white balance on vs off (" + exOn.frames.length + " frames, pixel hash per frame)", exOn.frames.length > 10 && JSON.stringify(exOn.frames) === JSON.stringify(exOff.frames), { on: exOn.frames.slice(0, 4), off: exOff.frames.slice(0, 4), n: [exOn.frames.length, exOff.frames.length] });
    (exOn.fileHash === exOff.fileHash ? ok : info)(tag + ": exported file bytes identical on vs off", exOn.fileHash === exOff.fileHash, { on: [exOn.size, exOn.fileHash], off: [exOff.size, exOff.fileHash] });
    ok(tag + ": export left the viewer correction in place", !!(await ui(p)).applied);

    // ── red lamp flash: estimate steady ──
    const fl = await p.evaluate(async () => {
      await TDC.player.seek(3.2); const out = []; let rej = 0, hue = 0; TDC.player.play();
      const t1 = performance.now();
      while (performance.now() - t1 < 2600) { await new Promise((r) => setTimeout(r, 110)); const c = TDC.wb.current(), L = TDC.wb.last || {}, a = L.left_repeater || {}; hue = Math.max(hue, a.rejectedHue || 0); if (a.rejected) rej++; out.push({ t: +TDC.player.time.toFixed(2), k: c && Math.round(c.cct), txt: TDC.wb.text() }); }
      TDC.player.pause(); return { out, rej, hue };
    });
    const ks = fl.out.filter((x) => x.k).map((x) => x.k), inFlash = fl.out.filter((x) => x.t >= 4.0 && x.t < 4.6);
    ok(tag + ": red lamp flash (4.0–4.5 s) is rejected: CCT stays within ±150 K, readout keeps a white point", ks.length > 10 && Math.max(...ks) - Math.min(...ks) <= 150 && inFlash.length > 0 && inFlash.every((x) => / K · /.test(x.txt)), { range: [Math.min(...ks), Math.max(...ks)], hueRejected: fl.hue, jumpRejected: fl.rej, inFlash: inFlash.slice(0, 5) });
    ok(tag + ": the flash pixels were candidates that the hue gate removed", fl.hue > 0, { hue: fl.hue });

    // ── tab hidden → paused ──
    const hid = await p.evaluate(async () => { TDC.player.play(); await new Promise((r) => setTimeout(r, 400)); Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); await new Promise((r) => setTimeout(r, 400)); const n0 = TDC.wb.state.samples; await new Promise((r) => setTimeout(r, 1200)); const n1 = TDC.wb.state.samples; delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); await new Promise((r) => setTimeout(r, 900)); const n2 = TDC.wb.state.samples; TDC.player.pause(); return { hidden: n1 - n0, visible: n2 - n1 }; });
    ok(tag + ": sampling pauses while the tab is hidden and resumes after", hid.hidden === 0 && hid.visible > 0, hid);

    // ── saved across reloads; off removes it ──
    await load(p, [FIX, FIX0]); await seek(p, 2.0); await W(800);
    s = await ui(p);
    ok(tag + ": on is kept after a reload (and applied again)", s.pressed === "true" && !!s.applied && /both mirrors/.test(s.readout || ""), s);
    await p.click("#chipWb"); await W(500);
    s = await ui(p);
    const leftovers = await p.evaluate(() => [...document.querySelectorAll(".tile video")].filter((v) => v.style.filter).length + [...document.querySelectorAll(".wb-tint")].filter((t) => !t.hidden).length);
    ok(tag + ": tap again → off: saved '0', no readout, no filter or tint left on the videos", s.pressed === "false" && s.saved === "0" && !s.readoutVisible && !s.applied && leftovers === 0, { s, leftovers });
    await p.click("#chipWb"); await W(1200);

    // ── focused + zoomed (full screen single camera) ──
    await p.evaluate(async () => { TDC.focus.focus("right_repeater"); try { await TDC.focus.fullscreen(true); } catch (_) {} await new Promise((r) => setTimeout(r, 500)); const t = TDC.player.tiles.right_repeater.tile; TDC.focus.zoomTo(2, -t.clientWidth * 0.45, t.clientHeight * 0.3); }); await seek(p, 2.0); await W(800);
    const fz = await p.evaluate(() => ({ fs: document.body.classList.contains("fs"), z: TDC.focus.z, text: TDC.wb.text() }));
    const zOn = await shotMean(p, "right_repeater", 0.02, 0.80, 0.10, 0.92);
    await setWb(p, false); const zOff = await shotMean(p, "right_repeater", 0.02, 0.80, 0.10, 0.92); await setWb(p, true);
    const zr = 1 - chroma(zOn) / chroma(zOff);
    ok(tag + ": full screen + 2× zoom on the right mirror: corrected (~70 %), readout still from both mirrors", zr > 0.5 && zr < 0.9 && /both mirrors/.test(fz.text), { ...fz, off: zOff.map(Math.round), on: zOn.map(Math.round), reduction: +zr.toFixed(3) });
    // focused on the FRONT camera: the mirror videos are hidden behind it; the estimate must still come from them (or be held)
    await p.evaluate(async () => { TDC.focus.zoomTo(1); TDC.focus.focus("front"); TDC.wb.reset(); }); await seek(p, 2.5); await W(1200);
    const ff = await p.evaluate(() => ({ text: TDC.wb.text(), cur: TDC.wb.current(), last: TDC.wb.last }));
    if (ff.cur) ok(tag + ": focused on the front camera: the hidden mirror videos still give the white point", /K · Warm streetlight/.test(ff.text), { text: ff.text });
    else info(tag + ": focused on the front camera: hidden mirror videos hand back blank frames here, so the estimate is held", ff);
    await p.screenshot({ path: path.join(SHOTS, "white-balance-fullscreen-" + bn + ".png") });
    await p.evaluate(async () => { try { await TDC.focus.fullscreen(false); } catch (_) {} TDC.focus.grid(); }); await seek(p, 2.0); await W(800);

    // ── phone layout ──
    await p.setViewportSize({ width: 390, height: 844 }); await W(800);
    s = await ui(p);
    ok(tag + ": phone layout: chip and readout visible", s.chipVisible && s.readoutVisible, s);
    await p.screenshot({ path: path.join(SHOTS, "white-balance-phone-" + bn + ".png") });
    await p.setViewportSize({ width: 1440, height: 900 }); await W(500);

    // ── 360 view ──
    const pano = await p.evaluate(async () => { const b = document.getElementById("btn360"); if (!b || !TDC.pano) return { skipped: "no 360" }; b.click(); await new Promise((r) => setTimeout(r, 2500)); const c = document.getElementById("panoCanvas"); if (!c || !TDC.pano.on) return { skipped: "360 did not open (" + (TDC.pano.error || "WebGL?") + ")" }; TDC.wb.apply(); const tint = c.parentElement.querySelector(":scope > .wb-tint"); const r = { filter: c.style.filter, tint: !!(tint && !tint.hidden) }; b.click(); await new Promise((r) => setTimeout(r, 300)); return r; });
    if (pano.skipped) info(tag + ": 360 view", pano); else ok(tag + ": 360 view: the stitched picture gets the same correction", !!pano.filter || pano.tint, pano);

    // ── no paint: looking ──
    await openEv(p, false); await p.evaluate(async () => { await TDC.player.seek(0.5); TDC.player.play(); await new Promise((r) => setTimeout(r, 2500)); TDC.player.pause(); });
    s = await ui(p);
    ok(tag + ": no paint in the mirrors → 'Looking for your white paint in the mirror cameras', no correction", s.readout === "Looking for your white paint in the mirror cameras" && !s.applied, s);
    await p.screenshot({ path: path.join(SHOTS, "white-balance-looking-" + bn + ".png") });
    ok(tag + ": no page errors", errs.length === 0, errs.slice(0, 3));
    await b.close();
  }
  console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
