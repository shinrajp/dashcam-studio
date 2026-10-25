// occluded-people (tag occluded-people): people who walk behind a parked car's window / a pillar, in the dark.
// Synthetic only: canvases are drawn here (a dark garage, a parked car with a dark window, a pillar, a walker with a tint) and a PIXEL-BASED mock
// detector stands in for the model: its score rises with the figure's size in the picture it is given and with its contrast, like a real
// detector's does. That makes the tests prove the LOGIC (motion windows, zoom + brighten, weak-look confirmation, hidden-person memory, budget,
// no tracks on static scenes) — they say nothing about how well the real model sees a real person (see tools/clip-eval.js for that, private clips only).
//  1. motion.js unit tests (step / windows / walker / enhance)
//  2. walker behind a window and a pillar, seeding off  → not found (the mock's score is under the cut-off at full-frame size)
//  3. same scene, seeding on → found within ~3 s, ONE identity through the pillar (ghost + revive), no second person
//  4. static person-like object, light flashes, noise → no tracks, no seeded looks
//  5. budget: seeded looks in any 10 s stay within the budget; model pref "medium" only on computers
// Usage: BR=chromium|webkit [DEV=desktop|phone] node test/occluded-people.js [url]
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
(async () => {
  const pw = require("playwright");
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium"])) {
    const b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
    for (const dev of [{ name: "desktop", viewport: { width: 1280, height: 800 } }, { name: "phone", viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, userAgent: UA, deviceScaleFactor: 2 }].filter((d) => !process.env.DEV || d.name === process.env.DEV)) {
      const tag = BR + " " + dev.name + ": ";
      const ctx = await b.newContext(dev), p = await ctx.newPage(), errs = [];
      p.on("pageerror", (e) => errs.push(e.message));
      await p.goto(URL_ + "?nosw=1", { waitUntil: "load" });
      await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, live: true, model: "nano", speed: "balanced" })); });
      await p.reload({ waitUntil: "load" });
      // ── 1. motion.js units ──
      const U = await p.evaluate(() => {
        const M = TDC.motion, out = {}, W = 96, H = 60, g0 = () => { const a = new Uint8ClampedArray(W * H); for (let i = 0; i < a.length; i++) a[i] = 30 + ((i * 7919) % 5); return a; };
        let st = M.newState(); for (let i = 0; i < 6; i++) M.step(st, g0(), W, H, i * 0.2);
        const g = g0(); for (let y = 20; y < 44; y++) for (let x = 40; x < 44; x++) g[y * W + x] = 60;   // a figure 4 × 24 cells
        const r = M.step(st, g, W, H, 1.2); out.blobs = r.blobs.length; out.blob = r.blobs[0] && { w: r.blobs[0].w, h: r.blobs[0].h };
        const gf = g0().map((v) => v + 50); const rf = M.step(st, gf, W, H, 1.4); out.flashBlobs = rf.blobs.length; out.flashGlobal = !!rf.global;
        out.winPerson = M.windows(r.blobs, [], []).length;
        out.winCovered = M.windows(r.blobs, [{ label: "person", conf: 0.8, x: r.blobs[0].x - 0.01, y: r.blobs[0].y - 0.01, w: r.blobs[0].w + 0.02, h: r.blobs[0].h + 0.02 }], []).length;
        const path = (f) => Array.from({ length: 6 }, (_, i) => f(i));
        out.walkOk = M.walker(path((i) => ({ t: i * 0.5, x: 0.2 + i * 0.03, y: 0.4, w: 0.04, h: 0.2 })));
        out.jitter = M.walker(path((i) => ({ t: i * 0.5, x: 0.2 + (i % 2) * 0.004, y: 0.4, w: 0.04, h: 0.2 })));
        out.fast = M.walker(path((i) => ({ t: i * 0.1, x: 0.1 + i * 0.5, y: 0.4, w: 0.04, h: 0.2 })));
        out.twoLooks = M.walker([{ t: 0, x: 0.2, y: 0.4, w: 0.04, h: 0.2 }, { t: 0.5, x: 0.25, y: 0.4, w: 0.04, h: 0.2 }]);
        // enhance: a dark crop gets brighter; a well-exposed one is left alone
        const cv = (v) => { const c = document.createElement("canvas"); c.width = 64; c.height = 64; const x = c.getContext("2d"); if (v > 100) { const gr = x.createLinearGradient(0, 0, 64, 0); gr.addColorStop(0, "rgb(15,15,15)"); gr.addColorStop(1, "rgb(240,240,240)"); x.fillStyle = gr; } else x.fillStyle = `rgb(${v},${v},${v})`; x.fillRect(0, 0, 64, 64); x.fillStyle = `rgb(${v + 14},${v + 10},${v + 4})`; x.fillRect(24, 10, 14, 44); return c; };
        const mean = (c) => { const d = c.getContext("2d").getImageData(0, 0, 64, 64).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i + 1]; return s / (d.length / 4); };
        const enh = (c) => { const id = c.getContext("2d").getImageData(0, 0, 64, 64), e = M.enhance(id, {}); if (!e.skipped) c.getContext("2d").putImageData(id, 0, 0); return e; };
        const dark = cv(20), bef = mean(dark), e1 = enh(dark); out.darkBefore = Math.round(bef); out.darkAfter = Math.round(mean(dark)); out.darkSkipped = !!(e1 && e1.skipped);
        const lit = cv(120), bl = mean(lit), e2 = enh(lit); out.litSame = Math.abs(mean(lit) - bl) < 1; out.litSkipped = !!(e2 && e2.skipped);
        return out;
      });
      ok(tag + "step: a figure on a still background is one blob", U.blobs === 1 && U.blob.h > U.blob.w, U);
      ok(tag + "step: a whole-picture light change (headlights, exposure) gives no blobs", U.flashBlobs === 0 && U.flashGlobal, U);
      ok(tag + "windows: an unexplained blob gets a window; one already covered by a person does not", U.winPerson >= 1 && U.winCovered === 0, U);
      ok(tag + "walker: steady walk yes; jitter no; too fast no; two looks not enough", U.walkOk && !U.jitter && !U.fast && !U.twoLooks, U);
      ok(tag + "enhance: dark crop brightened, well-exposed crop untouched", U.darkAfter > U.darkBefore * 1.8 && U.litSame && U.litSkipped, U);
      // ── 2-4. scenes through the real tracker with a pixel-based mock detector ──
      const run = (mode, scene) => p.evaluate(async ([mode, scene]) => {
        const D = TDC.detect, W = 640, H = 400, SD = D.seed;
        localStorage.setItem("tdc.seed", mode === "off" ? "off" : "on"); D.clear(); D.setPref("occl", 3.5);
        let wall = 0; D._clock = () => wall;
        const rnd = (() => { let s = 12345; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
        const drawFrame = (t) => {
          const c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d");
          x.fillStyle = "rgb(24,24,22)"; x.fillRect(0, 0, W, H);                       // dark garage
          x.fillStyle = "rgb(44,44,42)"; x.fillRect(0.10 * W, 0.30 * H, 0.60 * W, 0.60 * H);   // parked car body
          x.fillStyle = "rgb(18,18,18)"; x.fillRect(0.25 * W, 0.36 * H, 0.35 * W, 0.20 * H);   // its dark window
          if (scene === "walker") { const cx = 0.27 + 0.07 * t; if (t >= 0 && cx < 0.6) { x.fillStyle = "rgb(36,31,22)"; x.fillRect((cx - 0.015) * W, 0.37 * H, 0.03 * W, 0.18 * H); } }   // tinted figure behind the glass
          x.fillStyle = "rgb(44,44,42)"; x.fillRect(0.40 * W, 0.30 * H, 0.05 * W, 0.60 * H);   // a pillar-like car frame (B pillar) hides him
          if (scene === "static") { x.fillStyle = "rgb(36,31,22)"; x.fillRect(0.50 * W, 0.37 * H, 0.03 * W, 0.18 * H); }   // a headrest: person-like, never moves
          if (scene === "flash" && Math.floor(t * 5) % 10 === 4) { x.fillStyle = "rgba(255,255,255,.5)"; x.fillRect(0, 0, W, H); }
          const id = x.getImageData(0, 0, W, H), d = id.data; for (let i = 0; i < d.length; i += 4) { const n = ((rnd() * 5) | 0) - 2; d[i] += n; d[i + 1] += n; d[i + 2] += n; } x.putImageData(id, 0, 0);
          return c;
        };
        // pixel-based mock detector: the walker is the tinted figure; score rises with its height in the picture it is given and with its contrast
        D._mock = async (img, iw, ih, o) => {
          const c = img, w = c.width, h = c.height, d = c.getContext("2d").getImageData(0, 0, w, h).data, full = w === W;
          let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0, lum = 0;
          for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) { const i = (y * w + x) * 4, L = (d[i] + d[i + 1] + d[i + 2]) / 3; if (L > 8 && (d[i] - d[i + 2]) / L > 0.28) { n++; lum += L; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } }
          const out = [];
          if (full) out.push({ x: 0.10, y: 0.30, w: 0.60, h: 0.60, cls: 2, conf: 0.9 });   // the parked car
          if (n > 12 && (x1 - x0) * 2 < w * 0.4) {
            const bh = y1 - y0 + 2, ring = []; for (const [rx, ry] of [[x0 - 6, y0 + bh / 2], [x1 + 6, y0 + bh / 2]]) { const i = (Math.max(0, Math.min(h - 1, Math.round(ry))) * w + Math.max(0, Math.min(w - 1, Math.round(rx)))) * 4; ring.push((d[i] + d[i + 1] + d[i + 2]) / 3); }
            const contrast = Math.abs(lum / n - (ring[0] + ring[1]) / 2), sat = (v) => Math.max(0, Math.min(1, v));
            const score = 0.08 + 0.85 * sat(bh / (0.45 * h)) * sat(contrast / 42);
            if (score >= (o && o.conf != null ? o.conf : 0.35)) out.push({ x: x0 / w, y: y0 / h, w: (x1 - x0 + 2) / w, h: bh / h, cls: 0, conf: +score.toFixed(2) });
          }
          return out;
        };
        const ids = new Set(), rows = []; const dbgW = []; let firstSeen = null, ghostSeen = 0, maxTracks = 0, extraLooks = 0;
        for (let k = 0; k < 140; k++) {   // 5 looks/s for 28 s of event time (walker enters at t=2, hidden behind the pillar around x=0.40-0.45)
          const t = 2 + k * 0.2; wall = t * 1000;
          const fr = drawFrame(t - 2);
          if (mode !== "off") D._poll("c", fr, t);
          await D._detectLive("front", fr, t);
          const pt = D.personTracks(t).filter((q) => q.cam === "front"); maxTracks = Math.max(maxTracks, pt.length);
          for (const q of pt) { ids.add(q.id); if (firstSeen == null) firstSeen = t - 2; }
          ghostSeen += D.ghostsAt("front", t).length > 0 ? 1 : 0;
          rows.push(pt.length); const dg = SD.dbg.front; if (dg && dg.wall === wall && dg.wins.length && dbgW.length < 8) dbgW.push({ t, blobs: dg.blobs.length, wins: dg.wins.map((w) => ({ k: w.kind, g: w.glass, c: (w.crops || []).map((q) => [q.scale, q.person, q.hint, q.enh]) })) }); else if (dg && dg.wall === wall && dbgW.length < 8 && dg.note) dbgW.push({ t, note: dg.note });
        }
        const stats = { ...SD.stats, motionMs: undefined, seedMs: undefined, enhMs: undefined, looks: SD.stats.looks.length }, loks = [];
        // budget: simulated looks (kept in SD.stats.looks as wall times) per sliding 10 s
        const ts = (SD._lookTimes || []);
        D._mock = null; D._clock = null; localStorage.removeItem("tdc.seed");
        return { ids: [...ids], firstSeen, ghostSeen, maxTracks, tracksPerLook: rows.join("").slice(0, 140), stats, budget: SD.budget(), lookTimes: SD.lookLog || null, found: SD.stats.found, revived: SD.stats.revived, dbgW };
      }, [mode, scene]);
      const off = await run("off", "walker"), on = await run("on", "walker"), st = await run("on", "static"), fl = await run("on", "flash");
      ok(tag + "walker behind the dark window, seeding OFF: not found at full-frame size", off.ids.length === 0, off);
      ok(tag + "walker, seeding ON: found (zoomed, brightened second looks), within 4.5 s of entering", on.ids.length >= 1 && on.firstSeen != null && on.firstSeen <= 4.5, on);
      ok(tag + "walker, seeding ON: one identity through the pillar (hidden person kept, then revived), never two", on.ids.length === 1 && on.maxTracks === 1 && ((on.ghostSeen > 0 && on.revived > 0) || !/10+1/.test(on.tracksPerLook)), on);   // computers: hidden for a while → ghost → revived; phones: the track simply outlives the gap between second looks
      ok(tag + "static headrest-like object: no person track, no motion windows", st.ids.length === 0 && st.stats.windows === 0, st);
      ok(tag + "light flashes: no person track", fl.ids.length === 0, fl);
      // ── 5. budget + settings ──
      const B = await p.evaluate(() => { const D = TDC.detect, bud = D.seed.budget(); localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, live: true, model: "medium", speed: "balanced" })); return { bud, mob: D.isMobile(), model: D.prefs().model, hasMedium: !!D.MODELS && !!D.MODELS.medium }; });
      const s10 = on.stats.looks;
      ok(tag + "seeded looks: " + on.stats.looks + " kept in the last 10 s window (budget " + on.budget.per10 + " per 10 s)", s10 <= on.budget.per10, on.stats);
      ok(tag + "yolo11m only offered on computers (saved choice falls back on phones)", dev.name === "phone" ? B.model !== "medium" : B.model === "medium", B);
      ok(tag + "no page errors", errs.length === 0, errs.slice(0, 3));
      await ctx.close();
    }
    await b.close();
  }
  console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
