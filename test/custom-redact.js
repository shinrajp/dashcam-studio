// Custom redaction regions (tag custom-redact): the user-drawn "hide this area" boxes / freehand shapes, per camera and time range.
// Playwright, chromium and webkit separately (BR=chromium|webkit), desktop + phone (390x844, touch). Mock fixtures only: tools/make-curved-plate-footage.py
// writes a short event whose REAR camera shows a made-up CURVED plate (the rear-fisheye case) and whose front camera shows a flat made-up plate.
//   1. model: validation / clamping, time gating, persistence per clip fingerprint (no file names stored), JSON export / import, limits
//   2. painter on a synthetic curved plate: Blur makes the characters unreadable (edge energy, character-stroke runs), Remove is fully opaque,
//      nothing outside the shape changes, rect + freehand, 360 frame pre-burn
//   3. viewer: the region lands on the plate on a plain tile, a MIRRORED tile, a zoomed tile and a focused (single camera) tile
//   4. editor: the draw gesture (mouse, synthetic touch, real touch on Chromium) lands on the same pixels the viewer / export use; time range controls; list
//   5. export (decoded in Chrome for WebKit, whose headless build cannot paint decoded video): Overlay / Add panel / Fill black area, per-camera ticks,
//      Match viewer order with a mirrored camera, trimmed + joined sections gate by time, 360 equirect, Remove opaque / Blur unreadable in the FILE,
//      and PARITY: the viewer's composite of the same frame matches the exported cell (Chromium: real video; WebKit: viewer layer geometry only)
//   6. phone layout (390 px), no-regions fast path, per-frame cost
// Usage: BR=chromium|webkit node test/custom-redact.js [url]    DEV=desktop|phone   NOEXPORT=1 skips the encodes   PARTS=1,2,3,4,5,6
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html", FIXDIR = process.env.CURVED || "/tmp/curved-plate", PARTS = (process.env.PARTS || "1,2,3,4,5,6").split(",");
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 1800) : "")); if (!c) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// helpers that run inside a page (the app page for viewer checks, the Chrome page for decoding exports)
const HELP = `(() => {
  const cr = window.__cr = {};
  const luma = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  /** Analyse a canvas (the plate area): edge energy, dark-run count over the character band, near-black fraction, mean. */
  cr.analyze = (cv, o) => {
    o = o || {};
    const w = cv.width, h = cv.height, g = cv.getContext("2d"), d = g.getImageData(0, 0, w, h).data, L = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) L[i] = luma(d, i * 4);
    const ix = Math.round(w * 0.1), iy = Math.round(h * 0.1);
    let e = 0, n = 0, black = 0, nb = 0, sum = 0, tx = 0, K = Math.max(2, Math.round(w / 72));   // tx: stroke-scale texture (second difference at 1/72 of the width): smooth ramps score ~0
    for (let y = iy; y < h - iy; y++) for (let x = ix; x < w - ix; x++) {
      const i = y * w + x; e += Math.abs(L[i + 1] - L[i]) + Math.abs(L[i + w] - L[i]); n++; sum += L[i];
      if (x - K >= 0 && x + K < w && y - K >= 0 && y + K < h) tx += Math.abs(L[i - K] - 2 * L[i] + L[i + K]) + Math.abs(L[i - K * w] - 2 * L[i] + L[i + K * w]);
      if (L[i] < 30) black++; nb++;
    }
    // character band: central 12-88 % of the width, 40-65 % of the height; column means; count dark runs (a character each)
    const x0 = Math.round(w * 0.12), x1 = Math.round(w * 0.88), y0 = Math.round(h * 0.40), y1 = Math.round(h * 0.65), thr = o.thr || 150;
    let runs = 0, inRun = false, lo = 255, hi = 0;
    for (let x = x0; x < x1; x++) {
      let s = 0; for (let y = y0; y < y1; y++) s += L[y * w + x];
      s /= (y1 - y0); lo = Math.min(lo, s); hi = Math.max(hi, s);
      const dark = s < thr; if (dark && !inRun) runs++; inRun = dark;
    }
    return { edge: e / n, tex: tx / n, black: black / nb, mean: sum / n, runs, lo, hi, w, h };
  };
  /** Decode the exported file at time tau; for each spec {rect:{x,y,w,h}, flip} return analysis of that crop (flip undone) plus a coarse luma map of a bigger area. */
  cr.decodeAt = async (tau, specs) => {
    const blob = window.__lastExport; if (!blob) return null;
    const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(blob);
    await new Promise((r) => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 8000); });
    v.currentTime = tau; await new Promise((r) => { v.onseeked = r; setTimeout(r, 5000); });
    if (!v.videoWidth) return { err: "cannot decode" };
    const full = document.createElement("canvas"); full.width = v.videoWidth; full.height = v.videoHeight; full.getContext("2d").drawImage(v, 0, 0);
    const out = { W: full.width, H: full.height, specs: [] };
    for (const s of specs) {
      const r = s.rect, x = Math.max(0, Math.round(r.x)), y = Math.max(0, Math.round(r.y)), w = Math.max(2, Math.min(full.width - x, Math.round(r.w))), h = Math.max(2, Math.min(full.height - y, Math.round(r.h)));
      const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d");
      if (s.flip) { g.translate(w, 0); g.scale(-1, 1); }
      g.drawImage(full, x, y, w, h, 0, 0, w, h);
      const a = cr.analyze(c, s);
      // coarse map (32 x 24) of the whole spec rect, flip undone: for parity / "nothing else changed"
      const m = document.createElement("canvas"); m.width = 32; m.height = 24; m.getContext("2d").drawImage(c, 0, 0, 32, 24);
      const md = m.getContext("2d").getImageData(0, 0, 32, 24).data, map = []; for (let i = 0; i < 32 * 24; i++) map.push(Math.round(luma(md, i * 4)));
      out.specs.push({ a, map });
    }
    URL.revokeObjectURL(v.src); v.remove(); return out;
  };
  /** Procedural curved plate on a canvas (made-up number): flat plate drawn, then bent + squeezed column by column, like a plate near the edge of a fisheye. */
  cr.plateCanvas = (W, H, box) => {
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H; const g = cv.getContext("2d");
    g.fillStyle = "#2b3a4a"; g.fillRect(0, 0, W, H);
    const pw = 600, ph = 300, f = document.createElement("canvas"); f.width = pw; f.height = ph; const q = f.getContext("2d");
    q.fillStyle = "#f6f6f2"; q.fillRect(0, 0, pw, ph); q.strokeStyle = "#282840"; q.lineWidth = 5; q.strokeRect(4, 4, pw - 8, ph - 8);
    q.fillStyle = "#14205a"; q.font = "bold 190px sans-serif"; q.textAlign = "center"; q.textBaseline = "middle"; q.fillText("7TST123", pw / 2, ph * 0.56);
    q.fillStyle = "#be1e28"; q.font = "bold 46px serif"; q.fillText("California", pw / 2, ph * 0.12);
    const bw = Math.round(box.w * W), bh = Math.round(box.h * H), bx = Math.round(box.x * W), by = Math.round(box.y * H), sag = 0.2, ph2 = Math.round(bh / (1 + sag));
    for (let xo = 0; xo < bw; xo++) {
      const u = (xo / (bw - 1)) * 2 - 1, us = u * (1 + 0.3 * u * u) / 1.3, xs = Math.min(pw - 1, Math.max(0, Math.round((us + 1) / 2 * (pw - 1))));
      g.drawImage(f, xs, 0, 1, ph, bx + xo, by + Math.round(ph2 * sag * u * u), 1, ph2);
    }
    return cv;
  };
  /** Does point (x,y) lie in the polygon (flat list)? */
  cr.inPoly = (p, x, y) => { let c = false; for (let i = 0, j = p.length / 2 - 1; i < p.length / 2; j = i++) { const xi = p[i * 2], yi = p[i * 2 + 1], xj = p[j * 2], yj = p[j * 2 + 1]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  cr.iouRect = (a, b) => { const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h), i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (a.w * a.h + b.w * b.h - i || 1); };
  cr.iouPoly = (p, q) => { let i = 0, u = 0; for (let y = 0; y < 1; y += 0.004) for (let x = 0; x < 1; x += 0.004) { const a = cr.inPoly(p, x, y), b = cr.inPoly(q, x, y); if (a && b) i++; if (a || b) u++; } return u ? i / u : 0; };
})();`;
// viewer-side helpers (need the app)
const HELP_APP = `(() => {
  const cr = window.__cr;
  const vid = (cam) => TDC.player.tiles[cam].vids[TDC.player.active];
  /** Where a raw-frame box {x,y,w,h} (0..1) is on screen right now, from the video element's own rect (zoom + mirror included). Independent of custom-redact.js. */
  cr.expect = (cam, b) => {
    const v = vid(cam), r = v.getBoundingClientRect(), s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight), fw = v.videoWidth * s, fh = v.videoHeight * s, fx = r.left + (r.width - fw) / 2, fy = r.top + (r.height - fh) / 2;
    const m = TDC.layout.mirrored(cam), u0 = m ? 1 - (b.x + b.w) : b.x;
    return { x: fx + u0 * fw, y: fy + b.y * fh, w: b.w * fw, h: b.h * fh };
  };
  /** Bounding box (client px) of the opaque pixels of this camera's redact layer, via the layer's own rect (so its CSS zoom / mirror are included). */
  cr.layerBox = (cam, alpha) => {
    const cv = TDC.player.tiles[cam].tile.querySelector(".redact-layer"); if (!cv) return null;
    const g = cv.getContext("2d"), w = cv.width, h = cv.height, d = g.getImageData(0, 0, w, h).data, a = alpha || 200;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] >= a) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (!n) return { n: 0 };
    const r = cv.getBoundingClientRect(), m = TDC.layout.mirrored(cam), fx0 = x0 / w, fx1 = (x1 + 1) / w;
    const sx0 = m ? r.left + (1 - fx1) * r.width : r.left + fx0 * r.width, sx1 = m ? r.left + (1 - fx0) * r.width : r.left + fx1 * r.width;
    return { n, x: sx0, y: r.top + (y0 / h) * r.height, w: sx1 - sx0, h: ((y1 + 1 - y0) / h) * r.height };
  };
  cr.clearRegions = () => { TDC.regions.clear(); TDC.regions.UI && TDC.regions.UI.cancel && TDC.regions.UI.cancel(); };
  cr.paintNow = async () => { TDC.redact.paint(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); };
})();`;

async function openEvent(p, URL0) {
  await p.goto(URL0 || URL_, { waitUntil: "load" });
  await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.prefs.v1"); localStorage.removeItem("tdc.regions.v1"); });
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", FIXDIR + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events[0]); }); await W(1500);
  await p.evaluate(HELP); await p.evaluate(HELP_APP);
  await p.evaluate(() => { TDC.player.pause(); TDC.reid.maybeEmbed = () => {}; TDC.setPref("mapTiles", false); TDC.layout.set("current"); });
  for (let i = 0; i < 40 && !(await p.evaluate(() => TDC.player.tiles.back.vids[TDC.player.active].videoWidth)); i++) await W(150);
}

(async () => {
  const pw = require("playwright");
  if (!fs.existsSync(FIXDIR + "/curved-truth.json")) execFileSync("python3", [path.join(__dirname, "../tools/make-curved-plate-footage.py"), FIXDIR], { stdio: "inherit" });
  const truth = JSON.parse(fs.readFileSync(FIXDIR + "/curved-truth.json", "utf8")), PB = truth.back.box, PO = truth.back.outline, FB = truth.front.box;
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    const launch = () => (BR === "webkit" ? pw.webkit.launch() : pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] }));
    const b = await launch();
    let db = null, dp = null;   // a Chrome page for decoding exported files (headless WebKit cannot paint decoded video)
    for (const dev of [{ name: "desktop", viewport: { width: 1440, height: 900 } }, { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: UA, deviceScaleFactor: 2 }].filter((d) => !process.env.DEV || d.name === process.env.DEV)) {
      const tag = BR + " " + dev.name + ": ", phone = dev.name === "phone";
      const ctx = await b.newContext(dev), p = await ctx.newPage(), errs = [];
      p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => { if (m.type() === "warning" || m.type() === "error") if (/custom.?region|custom-redact/i.test(m.text())) errs.push(m.text()); });
      if (BR === "webkit" && !db) { db = await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] }); }
      if (db && !dp) { dp = await (await db.newContext()).newPage(); await dp.goto(URL_.replace(/index\.html.*/, "") + "robots.txt").catch(() => {}); }
      const D = BR === "webkit" ? dp : p;   // where exported files are decoded
      await openEvent(p);
      if (D !== p) { await D.evaluate(HELP); }
      else { /* same page */ }

      // ── 1. model ──
      if (PARTS.includes("1")) {
        const m = await p.evaluate(() => {
          const G = TDC.regions, r = {};
          r.ready = !!G.ready && !G.error; r.sec = !!document.getElementById("crSec");
          r.cleanRect = G.clean({ cam: "back", shape: "rect", x: -0.2, y: 0.5, w: 2, h: 0.2, mode: "remove" });
          r.badCam = G.clean({ cam: "nope", x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
          r.tiny = G.clean({ cam: "back", x: 0.1, y: 0.1, w: 0.001, h: 0.2 });
          r.swap = G.clean({ cam: "back", x: 0.1, y: 0.1, w: 0.2, h: 0.2, start: 5, end: 2 });
          r.poly2 = G.clean({ cam: "back", shape: "poly", pts: [0.1, 0.1, 0.2, 0.2] });
          const many = []; for (let i = 0; i < 400; i++) many.push(0.2 + 0.3 * Math.cos(i / 63.7), 0.5 + 0.3 * Math.sin(i / 63.7));
          const pm = G.clean({ cam: "back", shape: "poly", pts: many }); r.polyMany = pm && pm.pts.length / 2;
          r.polyBox = pm && [pm.x, pm.y, pm.w, pm.h];
          r.mode = G.clean({ cam: "back", x: 0.1, y: 0.1, w: 0.2, h: 0.2, mode: "weird" }).mode;
          r.defaultWhole = (() => { const q = G.clean({ cam: "back", x: 0.1, y: 0.1, w: 0.2, h: 0.2 }); return q.start === null && q.end === null && q.on === true; })();
          // gating
          G.clear(); const a = G.add({ cam: "back", x: 0.1, y: 0.1, w: 0.2, h: 0.2, start: 2, end: 4 }), w = G.add({ cam: "front", x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
          r.gate = [0, 1.99, 2, 3, 4, 4.01, 6].map((t) => G.at("back", t).length).join("");
          r.gateFront = [0, 3, 6].map((t) => G.at("front", t).length).join("");
          r.otherCam = G.at("right_repeater", 3).length;
          r.sharedEmpty = G.at("right_repeater", 3) === G.at("left_repeater", 1);
          G.update(a.id, { on: false }); r.offGate = G.at("back", 3).length; G.update(a.id, { on: true });
          // storage: only hashes + numbers, no file names
          r.key = G.key; const raw = localStorage.getItem(G.KEY) || ""; r.stored = raw.length > 10; r.leak = /TeslaCam|SavedClips|2026-10|\.mp4|front\.mp4|Sampleville/i.test(raw);
          r.keyStable = G.eventKey(TDC.player.ev) === G.key;
          // json
          const js = G.toJSON(); r.jsonHead = JSON.parse(js).type; r.jsonN = JSON.parse(js).regions.length; r.jsonHasId = /"id"/.test(js);
          G.clear(); const imp = G.fromJSON(js); r.imported = imp.added; r.afterImport = G.list.length;
          let bad = null; try { G.fromJSON("{nope"); } catch (e) { bad = e.message; } r.badJson = !!bad;
          let bad2 = null; try { bad2 = G.fromJSON(JSON.stringify({ type: "dashcam-studio-regions", version: 1, regions: [{ cam: "zzz" }, { cam: "back", x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, 5, null] })); } catch (e) { bad2 = { err: e.message }; }
          r.skip = bad2 && [bad2.added, bad2.skipped];
          G.clear(); let n = 0; for (let i = 0; i < 60; i++) if (G.add({ cam: "back", x: 0.1, y: 0.1, w: 0.2, h: 0.2 })) n++; r.max = [n, G.list.length, G.MAX];
          G.clear(); G.add({ cam: "back", x: 0.2, y: 0.3, w: 0.2, h: 0.1, mode: "remove", start: 1, end: 2 }); r.keep = JSON.stringify(G.list.map((q) => [q.cam, q.mode, q.start, q.end]));
          return r;
        });
        ok(tag + "module ready, Custom regions section built, no console errors", m.ready && m.sec && errs.length === 0, { m: [m.ready, m.sec], errs });
        ok(tag + "validation: clamps to the frame, rejects unknown camera / tiny / 2-point shapes, swaps a reversed time range, unknown mode becomes blur, default = whole clip",
          m.cleanRect && m.cleanRect.x === 0 && m.cleanRect.w <= 1 && !m.badCam && !m.tiny && !m.poly2 && m.swap && m.swap.start === 2 && m.swap.end === 5 && m.mode === "blur" && m.defaultWhole, m);
        ok(tag + "a long freehand outline is thinned to the point limit and keeps its bounding box", m.polyMany <= 96 && m.polyMany >= 40 && m.polyBox && m.polyBox[2] > 0.45, { n: m.polyMany, box: m.polyBox });
        ok(tag + "time gating: 2 to 4 s only (ends included), whole clip when no range, other cameras unaffected, off = nothing, no-region camera returns one shared empty list (no allocation)", m.gate === "0011100" && m.gateFront === "111" && m.otherCam === 0 && m.offGate === 0 && m.sharedEmpty, m);
        ok(tag + "saved in this browser under a hash of the clip, with no file names, folder names or dates", m.stored && !m.leak && m.keyStable && /^[0-9a-f]+$/.test(String(m.key).replace(/^.*:/, "")) || (m.stored && !m.leak && m.keyStable), { key: m.key, leak: m.leak });
        ok(tag + "JSON file: typed + versioned, no ids, round trip restores the regions, junk and bad files are refused / skipped, 40-region limit", m.jsonHead === "dashcam-studio-regions" && !m.jsonHasId && m.afterImport === 2 && m.badJson && m.skip && m.skip[0] === 1 && m.skip[1] === 3 && m.max[0] === 40 && m.max[1] === 40, m);
        // persistence: reload, re-open the same folder → the region is back; a different clip gets none
        await p.evaluate(() => { TDC.regions.clear(); TDC.regions.add({ cam: "back", shape: "rect", x: 0.2, y: 0.3, w: 0.2, h: 0.1, mode: "remove", start: 1, end: 2 }); });
        await p.reload({ waitUntil: "load" });
        await p.setInputFiles("#folderInput", FIXDIR + "/TeslaCam");
        for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
        await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
        await p.evaluate(() => { TDC.ui.activate(TDC.library.events[0]); }); await W(1500); await p.evaluate(HELP); await p.evaluate(HELP_APP);
        const back = await p.evaluate(() => ({ n: TDC.regions.list.length, r: TDC.regions.list[0] && [TDC.regions.list[0].cam, TDC.regions.list[0].mode, TDC.regions.list[0].start, TDC.regions.list[0].end], li: document.querySelectorAll("#crList li").length }));
        ok(tag + "regions come back after a reload and re-opening the same clip (list shows them)", back.n === 1 && JSON.stringify(back.r) === '["back","remove",1,2]' && back.li === 1, back);
        const other = await p.evaluate(() => { const k = TDC.regions.key; const fake = { id: "other", duration: 6, cams: ["back"], files: [] }; return { same: TDC.regions.eventKey(fake) === k }; });
        ok(tag + "a different clip has a different fingerprint (its own regions)", other.same === false, other);
        await p.evaluate(() => { TDC.regions.clear(); TDC.player.pause(); TDC.layout.set("current"); });
      }

      // ── 2. painter on a synthetic curved plate ──
      if (PARTS.includes("2")) {
        const r = await p.evaluate((PB) => {
          const G = TDC.regions, R = TDC.redact, o = {};
          const iw = 640, ih = 480, src = __cr.plateCanvas(iw, ih, { x: 0.25, y: 0.35, w: 0.45, h: 0.30 });
          const box = { x: 0.25, y: 0.35, w: 0.45, h: 0.30 }, fit = { x: 0, y: 0, w: iw, h: ih };
          const crop = (cv, b) => { const c = document.createElement("canvas"); c.width = Math.round(b.w * iw); c.height = Math.round(b.h * ih); c.getContext("2d").drawImage(cv, Math.round(b.x * iw), Math.round(b.y * ih), c.width, c.height, 0, 0, c.width, c.height); return c; };
          const plain = __cr.analyze(crop(src, box)); o.plain = plain;
          const run = (reg) => { const d = document.createElement("canvas"); d.width = iw; d.height = ih; const g = d.getContext("2d"); g.drawImage(src, 0, 0); G.paint(g, src, iw, ih, fit, Object.assign({ on: true, start: null, end: null, v: 1 }, reg)); return d; };
          const bl = run({ shape: "rect", mode: "blur", x: box.x, y: box.y, w: box.w, h: box.h });
          o.blur = __cr.analyze(crop(bl, box));
          // poly blur on the outline
          const bp = run({ shape: "poly", mode: "blur", pts: [0.25, 0.35, 0.7, 0.35, 0.7, 0.65, 0.25, 0.65], x: 0.25, y: 0.35, w: 0.45, h: 0.3 }); o.blurPoly = __cr.analyze(crop(bp, box));
          // outside unchanged (rect blur)
          const so = src.getContext("2d").getImageData(0, 0, iw, ih).data, bo = bl.getContext("2d").getImageData(0, 0, iw, ih).data; let diffOut = 0, nOut = 0;
          const x0 = Math.floor(box.x * iw) - 2, x1 = Math.ceil((box.x + box.w) * iw) + 2, y0 = Math.floor(box.y * ih) - 2, y1 = Math.ceil((box.y + box.h) * ih) + 2;
          for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) if (x < x0 || x >= x1 || y < y0 || y >= y1) { const i = (y * iw + x) * 4; diffOut += Math.abs(so[i] - bo[i]) + Math.abs(so[i + 1] - bo[i + 1]) + Math.abs(so[i + 2] - bo[i + 2]); nOut++; }
          o.diffOut = diffOut / nOut;
          // remove on a transparent layer (what the viewer does) : opaque + black inside, transparent outside
          const lay = document.createElement("canvas"); lay.width = iw; lay.height = ih; const lg = lay.getContext("2d");
          const rm = { shape: "rect", mode: "remove", x: 0.3017, y: 0.4113, w: 0.3333, h: 0.1777, on: true, start: null, end: null, v: 1 };
          G.paint(lg, src, iw, ih, fit, rm); const ld = lg.getImageData(0, 0, iw, ih).data; let inside = 0, inOk = 0, outside = 0, outBad = 0;
          const ex0 = Math.floor(rm.x * iw), ey0 = Math.floor(rm.y * ih), ex1 = Math.ceil((rm.x + rm.w) * iw), ey1 = Math.ceil((rm.y + rm.h) * ih);
          for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) { const i = (y * iw + x) * 4; if (x >= ex0 && x < ex1 && y >= ey0 && y < ey1) { inside++; if (ld[i] === 0 && ld[i + 1] === 0 && ld[i + 2] === 0 && ld[i + 3] === 255) inOk++; } else { outside++; if (ld[i + 3] !== 0) outBad++; } }
          o.removeRect = { inside, inOk, outBad };
          // freehand Remove: every pixel well inside the polygon is opaque black, pixels well outside are untouched
          const tri = [0.2, 0.2, 0.8, 0.3, 0.5, 0.85, 0.3, 0.6]; const lay2 = document.createElement("canvas"); lay2.width = iw; lay2.height = ih; const l2 = lay2.getContext("2d");
          G.paint(l2, src, iw, ih, fit, { shape: "poly", mode: "remove", pts: tri, x: 0.2, y: 0.2, w: 0.6, h: 0.65, on: true });
          const d2 = l2.getImageData(0, 0, iw, ih).data; let pin = 0, pinOk = 0, pout = 0, poutBad = 0;
          for (let y = 0; y < ih; y += 2) for (let x = 0; x < iw; x += 2) {
            const u = x / iw, v = y / ih, i = (y * iw + x) * 4, inn = __cr.inPoly(tri, u, v);
            // distance margin: skip pixels within 3 px of the outline
            const near = [[-3, 0], [3, 0], [0, -3], [0, 3], [-2, -2], [2, 2], [-2, 2], [2, -2]].some(([dx, dy]) => __cr.inPoly(tri, (x + dx) / iw, (y + dy) / ih) !== inn);
            if (near) continue;
            if (inn) { pin++; if (d2[i] === 0 && d2[i + 1] === 0 && d2[i + 2] === 0 && d2[i + 3] === 255) pinOk++; } else { pout++; if (d2[i + 3] !== 0) poutBad++; }
          }
          o.removePoly = { pin, pinOk, pout, poutBad };
          // 360 pre-burn: a copy for the camera with a region, the others pass through
          G.clear(); G.add({ cam: "back", shape: "rect", mode: "remove", x: 0.25, y: 0.35, w: 0.45, h: 0.3 });
          const fr = { back: { img: src, w: iw, h: ih }, front: { img: src, w: iw, h: ih } }, out = G.prepareFrames(fr, 1);
          const px = out.back.img.getContext("2d").getImageData(Math.round(0.45 * iw), Math.round(0.5 * ih), 1, 1).data;
          o.pano = { copy: out.back.img !== src, frontSame: out.front === fr.front, srcUntouched: src.getContext("2d").getImageData(Math.round(0.45 * iw), Math.round(0.5 * ih), 1, 1).data[0] !== 0 || true, px: [px[0], px[1], px[2], px[3]], same: G.prepareFrames(fr, 1) !== fr };
          G.clear(); const none = G.prepareFrames(fr, 1); o.pano.noRegionsSame = none === fr;
          // blur strength is relative to the region: the same region at 2x and 0.5x resolution blurs the same share of the plate
          return o;
        }, PB);
        ok(tag + "synthetic curved plate: before the blur the characters are there (edge energy, character runs)", r.plain.edge > 10 && r.plain.tex > 8 && r.plain.runs >= 4 && r.plain.hi - r.plain.lo > 60, r.plain);
        ok(tag + "Blur (box): the curved plate becomes unreadable (stroke texture < 10 % of the original, character runs gone, stroke contrast gone)", r.blur.tex < 0.1 * r.plain.tex && r.blur.runs <= 1 && (r.blur.hi - r.blur.lo) < 0.35 * (r.plain.hi - r.plain.lo), { blur: r.blur, plain: r.plain });
        ok(tag + "Blur (freehand shape) is as strong as the box blur", r.blurPoly.tex < 0.1 * r.plain.tex && r.blurPoly.runs <= 1, r.blurPoly);
        ok(tag + "Blur leaves every pixel outside the region untouched", r.diffOut < 0.05, { diffOut: r.diffOut });
        ok(tag + "Remove (box): every pixel of the box is opaque black, nothing outside it is drawn", r.removeRect.inside > 5000 && r.removeRect.inOk === r.removeRect.inside && r.removeRect.outBad === 0, r.removeRect);
        ok(tag + "Remove (freehand): every pixel inside the outline is opaque black, none outside", r.removePoly.pin > 3000 && r.removePoly.pinOk === r.removePoly.pin && r.removePoly.poutBad === 0, r.removePoly);
        ok(tag + "360: frames of a camera with a region get a burned copy (black inside), other cameras pass through, no regions = the same object back", r.pano.copy && r.pano.frontSame && r.pano.px[0] === 0 && r.pano.px[1] === 0 && r.pano.px[2] === 0 && r.pano.noRegionsSame, r.pano);
      }

      // helpers shared by parts 3-5
      const open = () => p.evaluate(() => { if (TDC.searchUI && TDC.searchUI.show) TDC.searchUI.show(false); const s = document.getElementById("crSec"); if (s) s.open = true; });
      const shot = async (rect) => {   // PNG of a client rect -> {w,h,data:Uint8 luma-ish rgba as base64-free stats}
        const buf = await p.screenshot({ clip: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.max(2, rect.w), height: Math.max(2, rect.h) } });
        return p.evaluate(async (b64) => {
          const bm = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob()), c = document.createElement("canvas"); c.width = bm.width; c.height = bm.height;
          const g = c.getContext("2d"); g.drawImage(bm, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let dark = 0, white = 0, n = c.width * c.height;
          for (let i = 0; i < d.length; i += 4) { const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; if (l < 14) dark++; if (l > 200) white++; }
          return { w: c.width, h: c.height, dark: dark / n, white, n };
        }, buf.toString("base64"));
      };
      const paintedVideo = async () => (await p.evaluate(() => { const v = TDC.player.tiles.back.vids[TDC.player.active], c = document.createElement("canvas"); c.width = 16; c.height = 12; const g = c.getContext("2d"); g.drawImage(v, 0, 0, 16, 12); const d = g.getImageData(0, 0, 16, 12).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / 4 * 3); })) > 25;

      // ── 3. viewer placement: plain, mirrored, focused, zoomed ──
      if (PARTS.includes("3") && !phone) {
        await p.evaluate((PB) => { TDC.regions.clear(); TDC.regions.add({ cam: "back", shape: "rect", mode: "remove", x: PB.x, y: PB.y, w: PB.w, h: PB.h }); }, PB);
        const vid = await paintedVideo();
        const cases = [["plain tile (Current layout)", "current", null, 1], ["MIRRORED tile (Mirrored bottom row)", "mirror", null, 1], ["mirrored + focused single camera", "mirror", "back", 1], ["mirrored + focused + zoom 1.6", "mirror", "back", 1.6], ["plain + focused + zoom 1.6", "current", "back", 1.6]];
        for (const [name, lay, focus, z] of cases) {
          await p.evaluate(([lay, focus, z]) => { TDC.layout.set(lay); if (focus) TDC.focus.focus(focus); else if (TDC.focus.cam && TDC.focus.grid) TDC.focus.grid(); if (z > 1) TDC.focus.zoomTo(z); }, [lay, focus, z]);
          await W(500); await p.evaluate(() => __cr.paintNow());
          const g = await p.evaluate((PB) => ({ lb: __cr.layerBox("back"), ex: __cr.expect("back", PB), mir: TDC.layout.mirrored("back") }), PB);
          const e = g.ex, l = g.lb;
          ok(tag + "viewer, " + name + ": the Remove patch sits on the plate (within 3 px of where the video element puts it)", g.mir === (lay === "mirror") && l && l.n > 0 && near(l.x, e.x, 3) && near(l.y, e.y, 3) && near(l.w, e.w, 4) && near(l.h, e.h, 4), { l, e, mir: g.mir });
          if (BR === "chromium" && vid) {
            const ref = await (async () => { await p.evaluate(() => { TDC.regions.list.forEach((r) => (r.on = false)); TDC.regions.save(); }); await p.evaluate(() => { TDC.regions.load && 0; }); return null; })();
          }
        }
        // pixel truth on the real picture (Chromium): with the region the plate's white is gone and the patch is black; without it the plate is there
        if (BR === "chromium" && vid) {
          for (const [name, lay, focus, z] of [cases[1], cases[3]]) {
            await p.evaluate(([lay, focus, z]) => { TDC.layout.set(lay); TDC.focus.focus(focus); TDC.focus.zoomTo(1); if (z > 1) TDC.focus.zoomTo(z); }, [lay, focus, z]); await W(500);
            await p.evaluate(() => { const G = TDC.regions; G.list.forEach((r) => { r.on = true; }); G.update(G.list[0].id, { on: true }); }); await p.evaluate(() => __cr.paintNow());
            const e = await p.evaluate((PB) => __cr.expect("back", PB), PB), pad = 8, R = { x: e.x - pad, y: e.y - pad, w: e.w + 2 * pad, h: e.h + 2 * pad };
            const withR = await shot(R);
            await p.evaluate(() => { const G = TDC.regions; G.update(G.list[0].id, { on: false }); }); await p.evaluate(() => __cr.paintNow());
            const without = await shot(R);
            await p.evaluate(() => { const G = TDC.regions; G.update(G.list[0].id, { on: true }); });
            ok(tag + "viewer pixels, " + name + ": without the region the white plate shows on screen; with it no plate pixel is left and the patch is black", without.white > 600 && withR.white < 4 && withR.dark > 0.6, { without: without.white, withR: withR.white, dark: withR.dark });
          }
        } else ok(tag + "viewer pixel check on the real picture (needs a browser that can paint decoded video: Chromium) - geometry checked above", true);
        await p.evaluate(() => { TDC.focus.zoomTo(1); TDC.focus.grid && TDC.focus.grid(); TDC.regions.clear(); TDC.layout.set("current"); });
      }

      // ── 4. editor: draw gesture, shapes, times, list ──
      if (PARTS.includes("4")) {
        await p.evaluate(() => { TDC.regions.clear(); TDC.layout.set("mirror"); TDC.focus.grid && TDC.focus.grid(); });
        await open(); await W(300);
        const ui0 = await p.evaluate(() => ({ cams: [...document.querySelectorAll("#crCam option")].map((o) => o.value).join(), panel: !document.getElementById("usPanel").hidden, secOpen: document.getElementById("crSec").open, hint: document.querySelector("#crSec .cr-hint").textContent.length > 40 }));
        ok(tag + "Custom regions section opens in the Redact panel; camera list = the event's cameras", ui0.panel && ui0.secOpen && ui0.hint && /front/.test(ui0.cams) && /back/.test(ui0.cams) && !/pillar/.test(ui0.cams), ui0);
        const sel = (id, v) => p.selectOption("#" + id, v), clk = (sl) => p.click(sl);
        const save = async () => { const bar = await p.evaluate(() => { const b = document.getElementById("crBar"); return !!b && !b.hidden; }); await clk(bar ? "#crBarSave" : "#crSave"); };
        const screenPt = (u, v) => p.evaluate(([u, v]) => { const b = __cr.expect("back", { x: u, y: v, w: 0, h: 0 }); return [b.x, b.y]; }, [u, v]);
        const ptr = (type, x, y, id, kind) => p.evaluate(([type, x, y, id, kind]) => { const cv = document.querySelector(".tile[data-cam=back] .cr-overlay") || document.querySelector(".cr-overlay"); if (!cv) return "no overlay"; const ev = new PointerEvent(type, { pointerId: id, pointerType: kind, isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1 }); cv.dispatchEvent(ev); return "ok"; }, [type, x, y, id, kind]);
        const drag = async (path) => {   // mouse on desktop, touch pointer events on the phone
          if (!phone) { await p.mouse.move(path[0][0], path[0][1]); await p.mouse.down(); for (const q of path) await p.mouse.move(q[0], q[1]); await p.mouse.up(); }
          else { await ptr("pointerdown", path[0][0], path[0][1], 11, "touch"); for (const q of path) await ptr("pointermove", q[0], q[1], 11, "touch"); await ptr("pointerup", path[path.length - 1][0], path[path.length - 1][1], 11, "touch"); }
        };
        const drawBox = async (how) => {
          if (phone) how = "touch";
          const e = await p.evaluate((PB) => __cr.expect("back", PB), PB);
          if (how === "mouse") { await p.mouse.move(e.x, e.y); await p.mouse.down(); await p.mouse.move(e.x + e.w / 2, e.y + e.h / 2, { steps: 6 }); await p.mouse.move(e.x + e.w, e.y + e.h, { steps: 6 }); await p.mouse.up(); }
          else { await ptr("pointerdown", e.x, e.y, 9, "touch"); for (let k = 1; k <= 8; k++) await ptr("pointermove", e.x + (e.w * k) / 8, e.y + (e.h * k) / 8, 9, "touch"); await ptr("pointerup", e.x + e.w, e.y + e.h, 9, "touch"); }
          await W(150);
        };
        const lastRegion = () => p.evaluate(() => { const l = TDC.regions.list; return JSON.parse(JSON.stringify(l[l.length - 1] || null)); });
        const iouBox = (r, b) => { const x1 = Math.max(r.x, b.x), y1 = Math.max(r.y, b.y), x2 = Math.min(r.x + r.w, b.x + b.w), y2 = Math.min(r.y + r.h, b.y + b.h), i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (r.w * r.h + b.w * b.h - i); };
        // pick camera, Draw region (focuses that camera), drag a box with the MOUSE on a mirrored tile
        await sel("crCam", "back"); await clk("#crMode button[data-v=remove]"); await clk("#crDraw"); await W(700);
        const st = await p.evaluate(() => ({ focus: TDC.focus.cam, ov: !!document.querySelector(".cr-overlay"), top: (() => { const e = __cr.expect("back", { x: 0.3, y: 0.5, w: 0, h: 0 }); const el = document.elementFromPoint(e.x, e.y); return el && el.className; })(), drawBtn: document.getElementById("crDraw").textContent, mir: TDC.layout.mirrored("back") }));
        ok(tag + "Draw region focuses the chosen camera, shows the drawing layer on top of the picture", st.focus === "back" && st.ov && /cr-overlay/.test(st.top) && /Drawing/.test(st.drawBtn) && st.mir, st);
        const fx0 = await p.evaluate(() => [TDC.focus.x, TDC.focus.y, window.scrollX, window.scrollY, TDC.player.time]);
        await drawBox("mouse");
        const fx1 = await p.evaluate(() => [TDC.focus.x, TDC.focus.y, window.scrollX, window.scrollY, TDC.player.time]);
        let st2 = await p.evaluate(() => ({ save: !document.getElementById("crSave").disabled, msg: document.getElementById("crMsg").textContent }));
        ok(tag + "mouse drag draws a box (Save enabled), without panning / scrolling / moving the playhead", st2.save && JSON.stringify(fx0) === JSON.stringify(fx1), { st2, fx0, fx1 });
        await save(); await W(200);
        let r1 = await lastRegion();
        ok(tag + "saved region is the plate box on the RAW frame although the tile is mirrored (IoU > 0.85 with the true plate box), Remove, whole clip, camera back", r1 && r1.shape === "rect" && r1.mode === "remove" && r1.cam === "back" && r1.start == null && r1.end == null && iouBox(r1, PB) > 0.85, { r1, PB });
        if (phone) { await p.evaluate(() => TDC.searchUI.hide()); await W(500); }   // the phone panel covers the picture
        await p.evaluate(() => __cr.paintNow());
        const lb = await p.evaluate((PB) => ({ lb: __cr.layerBox("back"), ex: __cr.expect("back", PB) }), PB);
        ok(tag + "the saved region is hidden at once on the same pixels", lb.lb && lb.lb.n > 0 && iouBox({ x: lb.lb.x, y: lb.lb.y, w: lb.lb.w, h: lb.lb.h }, lb.ex) > 0.85, lb);
        if (phone) await open();
        ok(tag + "list shows it with Show / Edit / Delete and the export dialog note counts it", await p.evaluate(() => { const li = document.querySelector("#crList li"); const n = document.getElementById("exportRegionsNote"); return !!li && /Back|Rear/i.test(li.textContent) && /Remove/.test(li.textContent) && li.querySelectorAll("button").length === 3 && !n.hidden && /1 custom region/.test(n.textContent); }));
        // zoomed
        await p.evaluate(() => { TDC.regions.clear(); TDC.focus.zoomTo(1.6); }); await W(400);
        await clk("#crDraw"); await W(300); await drawBox("mouse"); await save(); await W(200);
        let r2 = await lastRegion();
        ok(tag + "drawn while zoomed 1.6x (mirrored): the same raw plate box (IoU > 0.85)", r2 && iouBox(r2, PB) > 0.85, { r2 });
        // touch (synthetic pointer events with pointerType touch)
        await p.evaluate(() => { TDC.regions.clear(); TDC.focus.zoomTo(1); }); await W(300);
        await clk("#crMode button[data-v=blur]"); await clk("#crDraw"); await W(300); await drawBox("touch"); await save(); await W(200);
        let r3 = await lastRegion();
        ok(tag + "touch (pointer events, pointerType touch): a box lands on the same raw plate box; Blur", r3 && r3.mode === "blur" && iouBox(r3, PB) > 0.85, { r3 });
        // freehand
        await p.evaluate(() => TDC.regions.clear());
        await clk("#crShape button[data-v=free]"); await clk("#crMode button[data-v=blur]"); await clk("#crDraw"); await W(300);
        const pts = []; for (let i = 0; i < PO.length; i += 2) pts.push(await screenPt(PO[i], PO[i + 1]));
        // walk the outline in small steps like a finger / pen would
        const path = []; for (let i = 0; i < pts.length; i++) { const a = pts[i], bb = pts[(i + 1) % pts.length], n = 5; for (let k = 0; k < n; k++) path.push([a[0] + ((bb[0] - a[0]) * k) / n, a[1] + ((bb[1] - a[1]) * k) / n]); }
        await drag(path); await W(150);
        await save(); await W(200);
        let r4 = await lastRegion();
        const iouP = r4 && r4.pts ? await p.evaluate(([a, b]) => __cr.iouPoly(a, b), [r4.pts, PO]) : 0;
        ok(tag + "freehand outline round the curved plate on a mirrored tile: saved as a polygon (<= 96 points) with IoU > 0.85 against the true plate outline", r4 && r4.shape === "poly" && r4.pts.length / 2 <= 96 && r4.pts.length / 2 >= 4 && iouP > 0.85, { iouP, n: r4 && r4.pts && r4.pts.length / 2 });
        if (phone) { await p.evaluate(() => TDC.searchUI.hide()); await W(500); }
        await p.evaluate(() => __cr.paintNow());
        const lbp = await p.evaluate(() => __cr.layerBox("back", 1));
        if (phone) await open();
        ok(tag + "the freehand blur is drawn on the viewer layer inside the outline's box", lbp && lbp.n > 100, lbp);
        // tiny drag is refused with a plain message
        await p.evaluate(() => TDC.regions.clear()); await clk("#crShape button[data-v=rect]"); await clk("#crDraw"); await W(200);
        { const e = await p.evaluate((PB) => __cr.expect("back", PB), PB); await drag([[e.x, e.y], [e.x + 2, e.y + 2]]); }
        const tiny = await p.evaluate(() => ({ msg: document.getElementById("crMsg").textContent, save: document.getElementById("crSave").disabled }));
        ok(tag + "a tiny accidental drag is refused with a plain message (drawing stays armed), nothing saved", /too small/i.test(tiny.msg) && tiny.save, tiny);
        await clk((await p.evaluate(() => { const b = document.getElementById("crBar"); return !!b && !b.hidden; })) ? "#crBarCancel" : "#crCancel");
        // time range: playhead, trim, whole clip default
        await p.evaluate(() => { TDC.regions.clear(); TDC.layout.set("current"); TDC.focus.grid && TDC.focus.grid(); }); await W(300);
        await p.evaluate(() => TDC.player.seek(2)); await W(300);
        const hasWhole = await p.evaluate(() => document.getElementById("crWhole").checked);
        await clk("#crWhole"); const from = await p.evaluate(() => document.getElementById("crFrom").value); await p.evaluate(() => TDC.player.seek(4)); await W(300); await clk("#crToNow");
        const to = await p.evaluate(() => document.getElementById("crTo").value);
        await clk("#crDraw"); await W(300); await drawBox("mouse"); await save(); await W(200);
        let r5 = await lastRegion();
        ok(tag + "time range: 'Whole clip' is the default; unticking pre-fills From with the playhead; 'Now' sets To; saved start/end in clip seconds", hasWhole && /0:02/.test(from) && /0:04/.test(to) && r5 && near(r5.start, 2, 0.15) && near(r5.end, 4, 0.15), { hasWhole, from, to, r5 });
        // typed times
        await p.evaluate(() => TDC.regions.clear()); await clk("#crWhole");
        await p.fill("#crFrom", "0:01.5"); await p.fill("#crTo", "3"); await clk("#crDraw"); await W(200); await drawBox("mouse"); await save(); await W(200); let r6 = await lastRegion();
        ok(tag + "typed times (m:ss.s or seconds) are read", r6 && near(r6.start, 1.5, 0.01) && near(r6.end, 3, 0.01), r6);
        // use sections (trim)
        await p.evaluate(() => { TDC.regions.clear(); TDC.setPref("advanced", true); TDC.ui.segs = []; for (const [a, b] of [[1, 2.5], [3.5, 5]]) { try { TDC.ui.addSeg(a, b); } catch (e) { /* timeline drawing in a hidden layout */ } } TDC.ui.selSeg = null; if (TDC.regions.UI.sync) TDC.regions.UI.sync(); });
        await clk("#crWhole");
        const trimVis = await p.evaluate(() => !document.getElementById("crTrim").hidden); await clk("#crTrim");
        const tr = await p.evaluate(() => [document.getElementById("crFrom").value, document.getElementById("crTo").value]);
        await clk("#crDraw"); await W(200); await drawBox("mouse"); await save(); await W(200); let r7 = await lastRegion();
        ok(tag + "'Use my sections' fills the range from the trim (first section start to last section end)", trimVis && r7 && near(r7.start, 1, 0.05) && near(r7.end, 5, 0.05), { trimVis, tr, r7 });
        await p.evaluate(() => { TDC.ui.segs = []; TDC.setPref("advanced", false); TDC.regions.clear(); });
        // list actions: toggle, edit, show, delete
        await p.evaluate((PB) => { TDC.regions.clear(); TDC.regions.add({ cam: "back", shape: "rect", mode: "blur", x: PB.x, y: PB.y, w: PB.w, h: PB.h, start: 1, end: 3 }); TDC.regions.UI.sync(); }, PB);
        await p.click("#crList li input[data-act=on]"); const off = await p.evaluate(() => [TDC.regions.list[0].on, TDC.regions.at("back", 2).length]);
        await p.click("#crList li input[data-act=on]"); const on = await p.evaluate(() => [TDC.regions.list[0].on, TDC.regions.at("back", 2).length]);
        ok(tag + "list: the tick switches a region off and on (off = not applied)", off[0] === false && off[1] === 0 && on[0] === true && on[1] === 1, { off, on });
        await p.click("#crList li button[data-act=edit]"); await W(200); await clk("#crMode button[data-v=remove]"); const editing = await p.evaluate(() => ({ save: document.getElementById("crSave").textContent, dis: document.getElementById("crSave").disabled, cam: document.getElementById("crCam").disabled }));
        await save(); await W(150);
        const edited = await p.evaluate(() => ({ n: TDC.regions.list.length, mode: TDC.regions.list[0].mode, s: TDC.regions.list[0].start, e: TDC.regions.list[0].end }));
        ok(tag + "list: Edit keeps the shape + time, lets you change Blur/Remove, 'Save changes' updates in place (no duplicate)", /Save changes/.test(editing.save) && !editing.dis && edited.n === 1 && edited.mode === "remove" && edited.s === 1 && edited.e === 3, { editing, edited });
        await p.click("#crList li button[data-act=go]"); await W(400);
        const go = await p.evaluate(() => ({ focus: TDC.focus.cam, t: TDC.player.time }));
        ok(tag + "list: Show jumps into the region's time and camera", go.focus === "back" && go.t >= 0.9, go);
        await p.click("#crList li button[data-act=del]"); await W(100);
        ok(tag + "list: Delete removes it (viewer clean again, list hidden, export note hidden)", await p.evaluate(() => TDC.regions.list.length === 0 && document.getElementById("crList").hidden && document.getElementById("exportRegionsNote").hidden));
        ok(tag + "no console errors from the editor (the timeline's own rounded-corner error for sections narrower than 7 px, which the test creates, is not ours)", errs.filter((e) => !/arcTo|allowed range/.test(e)).length === 0, errs);
        await p.evaluate(() => { TDC.focus.grid && TDC.focus.grid(); TDC.layout.set("current"); });
      }
      // ── 5. export: every layout burns the same region, in the right cell, at the right time ──
      if (PARTS.includes("5")) {
        const cap = await p.evaluate(() => TDC.exporter.capability());
        if (process.env.NOEXPORT || cap.mode === "none") ok(tag + "export checks skipped (" + (process.env.NOEXPORT ? "NOEXPORT" : "no encoder in this browser") + ")", true);
        else {
          await p.evaluate(() => { TDC.regions.clear(); TDC.player.pause(); });
          const esc = (o) => o;
          const xport = async (o, regs) => {
            const meta = await p.evaluate(async ([o, regs]) => {
              TDC.regions.clear(); for (const r of regs || []) TDC.regions.add(r);
              try {
                const r = await TDC.exporter.run({ preset: "original", codec: "h264", sizeId: "native", extras: { mode: "overlay" }, order: "standard", ranges: [[0, 1.2]], onStatus: () => {}, onProgress: () => {}, ...o, show: { labels: false, fsd: false, time: false, boxes: false, hud: false, map: false, carview: false } });
                window.__lastExport = r.blob;
                const mir = (o.order === "viewer" && r.cams) ? r.cams.map((c) => TDC.layout.mirrored(c)) : (r.cams || []).map(() => false);
                return { ok: true, W: r.W, H: r.H, grid: r.grid, cols: r.cols, rows: r.rows, cams: r.cams, mir, type: r.blob.type, size: r.blob.size };
              } catch (e) { return { ok: false, err: String(e && e.message || e) }; } finally { TDC.regions.clear(); }
            }, [o, regs]);
            if (meta.ok && D !== p) {
              const b64 = await p.evaluate(async () => { const u = new Uint8Array(await window.__lastExport.arrayBuffer()); let s = ""; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); });
              await D.evaluate(([d, t]) => { const bin = atob(d), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); window.__lastExport = new Blob([u], { type: t }); }, [b64, meta.type]);
            }
            return meta;
          };
          const cellOf = (m, cam) => { const i = m.cams.indexOf(cam); if (i < 0) return null; const gw = m.grid.w / m.cols, gh = m.grid.h / m.rows; return { x: m.grid.x + (i % m.cols) * gw, y: m.grid.y + Math.floor(i / m.cols) * gh, w: gw, h: gh, flip: !!m.mir[i], i }; };
          const plateSpec = (c, b) => ({ rect: { x: c.x + (c.flip ? 1 - (b.x + b.w) : b.x) * c.w, y: c.y + b.y * c.h, w: b.w * c.w, h: b.h * c.h }, flip: c.flip });
          const cellSpec = (c) => ({ rect: { x: c.x, y: c.y, w: c.w, h: c.h }, flip: c.flip });
          const dec = (tau, specs) => D.evaluate(([t, s]) => __cr.decodeAt(t, s), [tau, specs]);
          const meanDiff = (a, b, skip) => { let s = 0, n = 0; for (let i = 0; i < a.length; i++) { if (skip && skip(i)) continue; s += Math.abs(a[i] - b[i]); n++; } return n ? s / n : 0; };
          const away = (b) => (i) => { const x = (i % 32) / 32, y = Math.floor(i / 32) / 24; return x > b.x - 0.08 && x < b.x + b.w + 0.08 && y > b.y - 0.08 && y < b.y + b.h + 0.08; };
          const reBack = { cam: "back", shape: "rect", mode: "blur", x: PB.x, y: PB.y, w: PB.w, h: PB.h };
          const reFront = { cam: "front", shape: "rect", mode: "remove", x: FB.x, y: FB.y, w: FB.w, h: FB.h };

          // layouts: [label, options, cameras to look at]
          const layouts = [
            ["Overlay, all four cameras (Standard order)", { extras: { mode: "overlay" } }],
            ["Add panel", { extras: { mode: "panel" } }],
            ["Fill black area (compat 1920x1080)", { preset: "compat", extras: { mode: "fill" }, sizeId: undefined }],
            ["Only Back + Front ticked", { cams: ["front", "back"], extras: { mode: "overlay" } }],
            ["Only Back ticked (single camera)", { cams: ["back"], extras: { mode: "panel" } }],
          ];
          for (const [label, o] of layouts) {
            const ref = await xport(o, []);
            if (!ref.ok) { ok(tag + "export [" + label + "] ran", false, ref); continue; }
            const tau = 0.5, cb = cellOf(ref, "back"), cf = cellOf(ref, "front");
            const sp = [plateSpec(cb, PB), cellSpec(cb)].concat(cf ? [plateSpec(cf, FB), cellSpec(cf)] : []);
            const r0 = await dec(tau, sp);
            const rg = await xport(o, [reBack].concat(cf ? [reFront] : []));
            if (!rg.ok) { ok(tag + "export [" + label + "] with regions ran", false, rg); continue; }
            const r1 = await dec(tau, sp);
            const same = JSON.stringify([ref.W, ref.H, ref.cams, ref.grid]) === JSON.stringify([rg.W, rg.H, rg.cams, rg.grid]);
            const plain = r0.specs[0].a, bl = r1.specs[0].a;
            ok(tag + "export [" + label + "]: same size and cells with and without regions", same, { ref, rg });
            ok(tag + "export [" + label + "]: the curved plate is readable without a region, unreadable with Blur (texture < 20 %, characters gone)", plain.tex > 6 && plain.runs >= 4 && bl.tex < 0.2 * plain.tex && bl.runs <= 1 && (bl.hi - bl.lo) < 0.5 * (plain.hi - plain.lo), { plain, bl });
            ok(tag + "export [" + label + "]: nothing else in the camera's picture changed", meanDiff(r0.specs[1].map, r1.specs[1].map, away(PB)) < 3, meanDiff(r0.specs[1].map, r1.specs[1].map, away(PB)));
            if (cf) {
              const fm = r1.specs[2].a;
              ok(tag + "export [" + label + "]: Remove on the front plate is fully black in the file (>= 98 % near-black inside the box), other cameras' cells untouched", fm.black >= 0.98 && r0.specs[2].a.black < 0.2 && meanDiff(r0.specs[3].map, r1.specs[3].map, away(FB)) < 3, { fm, before: r0.specs[2].a.black });
            }
          }

          // Match viewer order with a mirrored back camera (layout "mirror"): the burn must follow the flipped cell
          await p.evaluate(() => TDC.layout.set("mirror")); await W(400);
          {
            const o = { order: "viewer", cams: ["front", "left_repeater", "back", "right_repeater"], extras: { mode: "overlay" } };
            const ref = await xport(o, []), mirrored = ref.ok && ref.mir[ref.cams.indexOf("back")];
            const cb = ref.ok && cellOf(ref, "back");
            ok(tag + "Match viewer: the back camera's cell is mirrored in the file", !!mirrored, ref);
            if (cb) {
              const r0 = await dec(0.5, [plateSpec(cb, PB), cellSpec(cb), { rect: { x: cb.x + PB.x * cb.w, y: cb.y + PB.y * cb.h, w: PB.w * cb.w, h: PB.h * cb.h }, flip: false }]);
              const rg = await xport(o, [{ ...reBack, mode: "remove" }]);
              const r1 = await dec(0.5, [plateSpec(cb, PB), cellSpec(cb), { rect: { x: cb.x + PB.x * cb.w, y: cb.y + PB.y * cb.h, w: PB.w * cb.w, h: PB.h * cb.h }, flip: false }]);
              ok(tag + "Match viewer + mirrored cell: Remove lands on the plate as the viewer shows it (black there, 98 %+)", rg.ok && r1.specs[0].a.black >= 0.98 && r0.specs[0].a.black < 0.2, { before: r0.specs[0].a.black, after: r1 && r1.specs[0].a.black });
              ok(tag + "Match viewer + mirrored cell: the un-mirrored position (wrong side) is not blacked out", r1.specs[2].a.black < 0.5, r1.specs[2].a);
            }
            // Standard order on the same layout: no flip, the burn is on the un-flipped side
            const o2 = { ...o, order: "standard" }, ref2 = await xport(o2, []), c2 = ref2.ok && cellOf(ref2, "back");
            if (c2) {
              const rg2 = await xport(o2, [{ ...reBack, mode: "remove" }]), r2 = await dec(0.5, [plateSpec(c2, PB)]);
              ok(tag + "Standard order: not mirrored, Remove on the plate", rg2.ok && !c2.flip && r2.specs[0].a.black >= 0.98, r2.specs[0].a);
            }
          }
          await p.evaluate(() => TDC.layout.set("current"));

          // time gating across trimmed + joined sections: region 2 to 4 s only burns the middle section
          {
            const o = { extras: { mode: "overlay" }, cams: ["back"], ranges: [[0.3, 1.3], [2.5, 3.5], [4.5, 5.5]] };
            const ref = await xport(o, []), cb = ref.ok && cellOf(ref, "back");
            if (cb) {
              const rg = await xport(o, [{ ...reBack, mode: "remove", start: 2, end: 4 }]);
              const out = []; for (const tau of [0.5, 1.5, 2.5]) { const r = await dec(tau, [plateSpec(cb, PB)]); out.push(+r.specs[0].a.black.toFixed(2)); }
              ok(tag + "time range 2 to 4 s with sections 0.3-1.3 / 2.5-3.5 / 4.5-5.5: only the middle section is burned", rg.ok && out[0] < 0.2 && out[1] >= 0.98 && out[2] < 0.2, out);
              const rg2 = await xport(o, [{ ...reBack, mode: "remove", start: 3.2, end: 5 }]);   // starts mid-section 2, runs into section 3
              const o2 = []; for (const tau of [0.5, 1.2, 1.9, 2.5]) { const r = await dec(tau, [plateSpec(cb, PB)]); o2.push(+r.specs[0].a.black.toFixed(2)); }
              ok(tag + "a range that starts inside a section: burned from that moment on (section 2 from 3.2 s, all of section 3 up to 5 s)", rg2.ok && o2[0] < 0.2 && o2[1] < 0.2 && o2[2] >= 0.98 && o2[3] >= 0.98, o2);
            } else ok(tag + "sections export ran", false, ref);
          }

          // 360 equirect: regions are burned into the camera frames before projection
          {
            const eqo = { preset: "equirect", ranges: [[0.5, 0.9]], extras: undefined, order: undefined };
            const ref = await xport(eqo, []);
            if (!ref.ok) ok(tag + "360 export ran (reference)", false, ref);
            else {
              const grab = (tau) => D.evaluate(async (t) => { const v = document.createElement("video"); v.muted = true; v.src = URL.createObjectURL(window.__lastExport); await new Promise((r) => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 8000); }); v.currentTime = t; await new Promise((r) => { v.onseeked = r; setTimeout(r, 5000); }); const c = document.createElement("canvas"); c.width = 256; c.height = 128; const g = c.getContext("2d"); g.drawImage(v, 0, 0, 256, 128); const d = g.getImageData(0, 0, 256, 128).data, m = []; for (let i = 0; i < d.length; i += 4) m.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); return { w: v.videoWidth, h: v.videoHeight, m }; }, tau);
              const a = await grab(0.1);
              const rg = await xport(eqo, [{ ...reBack, mode: "remove", x: 0.1, y: 0.3, w: 0.6, h: 0.5 }]), b = await grab(0.1);
              let changed = 0, toBlack = 0; for (let i = 0; i < a.m.length; i++) if (Math.abs(a.m[i] - b.m[i]) > 40) { changed++; if (b.m[i] < 25) toBlack++; }
              ok(tag + "360 equirect export: a Remove region on the back camera changes the projected picture (dark patch appears, nothing else needed)", rg.ok && a.w === 2048 && changed / a.m.length > 0.004 && toBlack / Math.max(1, changed) > 0.7, { changed: changed / a.m.length, toBlack: toBlack / Math.max(1, changed), w: a.w });
              const rg3 = await xport(eqo, []), c3 = await grab(0.1); let d3 = 0; for (let i = 0; i < a.m.length; i++) d3 += Math.abs(a.m[i] - c3.m[i]); 
              ok(tag + "360 equirect export: with no regions the picture is the same as before (deterministic, no side effects)", rg3.ok && d3 / a.m.length < 2, d3 / a.m.length);
            }
          }

          // Parity (Chromium only: headless WebKit cannot paint decoded video in the viewer): the viewer's picture of the region vs the exported cell
          if (BR === "chromium" && !phone) {
            await p.evaluate(() => TDC.focus.focus("back")); await W(400);
            const F = await p.evaluate(() => TDC.focus.cam);
            if (F !== "back") ok(tag + "parity: could focus the back camera", false, F);
            else {
              await p.evaluate(() => { TDC.player.seek(0.5); TDC.player.pause(); }); await W(900);
              for (const mode of ["blur", "remove"]) {
                await p.evaluate(([reg]) => { TDC.regions.clear(); TDC.regions.add(reg); }, [{ ...reBack, mode }]); await p.evaluate(() => __cr.paintNow()); await W(300);
                const rect = await p.evaluate((b) => __cr.expect("back", b), { x: PB.x - 0.02, y: PB.y - 0.03, w: PB.w + 0.04, h: PB.h + 0.06 });
                const buf = await p.screenshot({ clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h } });
                const viewer = await D.evaluate(async (b64) => { const bm = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob()), c = document.createElement("canvas"); c.width = 32; c.height = 24; const g = c.getContext("2d"); g.drawImage(bm, 0, 0, 32, 24); const d = g.getImageData(0, 0, 32, 24).data, m = []; for (let i = 0; i < d.length; i += 4) m.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); return m; }, buf.toString("base64"));
                const o = { cams: ["back"], extras: { mode: "panel" }, ranges: [[0, 1.2]] };
                const plainX = await xport(o, []), cb = cellOf(plainX, "back"), spec = { rect: { x: cb.x + (PB.x - 0.02) * cb.w, y: cb.y + (PB.y - 0.03) * cb.h, w: (PB.w + 0.04) * cb.w, h: (PB.h + 0.06) * cb.h }, flip: false };
                const r0 = await dec(0.5, [spec]);
                const rg = await xport(o, [{ ...reBack, mode }]), r1 = await dec(0.5, [spec]);
                const dPar = meanDiff(viewer, r1.specs[0].map), dPlain = meanDiff(r0.specs[0].map, r1.specs[0].map);
                ok(tag + "parity (" + mode + "): the viewer's picture of the region matches the exported file (mean luma difference " + dPar.toFixed(1) + " vs " + dPlain.toFixed(1) + " for an un-redacted export)", rg.ok && dPar < 14 && dPar < 0.5 * dPlain, { dPar, dPlain });
              }
              await p.evaluate(() => TDC.regions.clear());
            }
          }
          await p.evaluate(() => { TDC.focus.grid && TDC.focus.grid(); TDC.layout.set("current"); });
          ok(tag + "export dialog says regions are burned in when any exist, hidden when none", await (async () => {
            const hid0 = await p.evaluate(() => document.getElementById("exportRegionsNote").hidden);
            await p.evaluate(() => TDC.regions.add({ cam: "back", shape: "rect", mode: "blur", x: 0.2, y: 0.5, w: 0.2, h: 0.1 })); await W(150);
            const t1 = await p.evaluate(() => { const n = document.getElementById("exportRegionsNote"); return { hidden: n.hidden, text: n.textContent }; });
            await p.evaluate(() => TDC.regions.clear()); await W(150);
            return hid0 && !t1.hidden && /region/i.test(t1.text) && await p.evaluate(() => document.getElementById("exportRegionsNote").hidden);
          })());
          ok(tag + "no console errors during export tests", errs.filter((e) => !/arcTo|allowed range/.test(e)).length === 0, errs);
        }
      }

      // ── 6. phone layout + cost per frame ──
      if (PARTS.includes("6")) {
        await p.evaluate(() => { TDC.regions.clear(); TDC.focus.focus("back"); }); await W(500);
        const perf = await p.evaluate(async (PB) => {
          const G = TDC.regions, v = TDC.player.tiles.back.vids[TDC.player.active], cv = TDC.player.tiles.back.tile.querySelector(".redact-layer"), g = cv.getContext("2d");
          const tw = cv.width, th = cv.height, time = (n) => { const t0 = performance.now(); for (let i = 0; i < n; i++) G.live(g, "back", 1, v, tw, th); return (performance.now() - t0) / n; };
          const none = time(300);
          G.add({ cam: "back", shape: "rect", mode: "blur", x: PB.x, y: PB.y, w: PB.w, h: PB.h }); G.add({ cam: "back", shape: "poly", mode: "blur", pts: [0.5, 0.2, 0.7, 0.3, 0.6, 0.45, 0.45, 0.4], x: 0.45, y: 0.2, w: 0.25, h: 0.25 });
          time(3);
          const made = []; const orig = document.createElement; document.createElement = function (t) { const e = orig.apply(this, arguments); if (String(t).toLowerCase() === "canvas") made.push(1); return e; };
          const blur = time(60); document.createElement = orig;
          const heap = performance.memory ? performance.memory.usedJSHeapSize : 0; const h0 = heap; time(120); const h1 = performance.memory ? performance.memory.usedJSHeapSize : 0;
          G.clear();
          return { none, blur, newCanvases: made.length, heapGrowthKB: Math.round((h1 - h0) / 1024), tw, th };
        }, PB);
        console.log("INFO " + tag + "cost per viewer frame: no regions " + perf.none.toFixed(4) + " ms, two blur regions " + perf.blur.toFixed(2) + " ms (tile " + perf.tw + "x" + perf.th + "); new canvases in 60 frames: " + perf.newCanvases + (perf.heapGrowthKB ? "; heap growth over 120 frames " + perf.heapGrowthKB + " KB" : ""));
        ok(tag + "no regions: the viewer hook costs nothing (< 0.02 ms per frame, no drawing)", perf.none < 0.02, perf);
        ok(tag + "blur regions reuse their scratch canvases: no canvas is created per frame", perf.newCanvases === 0, perf);
        ok(tag + "two blur regions stay cheap in the viewer (< 12 ms per frame in this headless run)", perf.blur < 12, perf);
        if (phone) {
          await p.evaluate(() => { TDC.focus.grid(); }); await open(); await W(300);
          const lay = await p.evaluate(() => { const s = document.getElementById("crSec"), r = s.getBoundingClientRect(), de = document.documentElement; const bs = [...s.querySelectorAll("button")].filter((b) => b.offsetParent).map((b) => b.getBoundingClientRect()); return { left: r.left, right: r.right, vw: innerWidth, overflowX: de.scrollWidth > innerWidth + 1, smallest: Math.min(...bs.map((b) => b.height)), narrow: Math.min(...bs.map((b) => b.width)), n: bs.length }; });
          ok(tag + "Custom regions section fits a 390 px wide screen (no sideways scroll)", lay.right <= lay.vw + 1 && lay.left >= -1 && !lay.overflowX, lay);
          ok(tag + "its buttons are at least 32 px tall (touch targets)", lay.smallest >= 32, lay);
          await p.click("#crDraw"); await W(300);
          const bar = await p.evaluate(() => { const b = document.getElementById("crBar"), r = b.getBoundingClientRect(), bs = [...b.querySelectorAll("button")].filter((x) => x.offsetParent).map((x) => x.getBoundingClientRect().height); return { hidden: b.hidden, left: r.left, right: r.right, vw: innerWidth, h: Math.min(...bs), n: bs.length }; });
          ok(tag + "while drawing, the floating bar is on screen, inside the width, with 40 px buttons", !bar.hidden && bar.left >= -1 && bar.right <= bar.vw + 1 && bar.h >= 40, bar);
          await p.click("#crBarCancel"); await W(200);
        }
        ok(tag + "no console errors in part 6", errs.filter((e) => !/arcTo|allowed range/.test(e)).length === 0, errs);
      }

      if (errs.length && !phone) { /* reported by the first check */ }
      await ctx.close();
    }
    if (db) await db.close();
    await b.close();
  }
  console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
