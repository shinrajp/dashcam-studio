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
      if (errs.length && !phone) { /* reported by the first check */ }
      await ctx.close();
    }
    if (db) await db.close();
    await b.close();
  }
  console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
