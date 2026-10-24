// Re-identification evaluation on SYNTHETIC people (tag handoff-m4): drawn figures with known identities, rendered as seen by two different
// cameras (different brightness / colour cast / blur / scale / pose), no real footage or faces.
//   1. the bundled model (js/detect-worker.js, real worker) loads, passes its self-test and reports its backend; embeddings are 256-d unit vectors
//   2. identification: for N people, match a "camera B" look against the "camera A" gallery: rank-1 accuracy with colour / embedding / both
//   3. hand-offs: people.js Registry linking with spatio-temporal only vs + colour vs + embedding (precision / recall of links, wrong links)
//   4. latency of one embedding (and one colour descriptor)
// Usage: BR=chromium|webkit node test/reid-eval.js [url]    (webkit = WASM, the same as iOS Safari)   JSON=/tmp/out.json to keep the numbers
const fs = require("fs");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 700) : "")); if (!c) fails++; };
(async () => {
  const pw = require("playwright");
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium"])) {
    const b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
    const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } }); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
    await p.goto(URL_ + (process.env.GPU ? "?webgpu=" + process.env.GPU : ""), { waitUntil: "load" });
    const tag = BR + ": ";
    const info = await p.evaluate(async () => { const t0 = performance.now(); const i = await TDC.detect.loadReid(); return i && Object.assign({ loadMs: Math.round(performance.now() - t0) }, i); });
    ok(tag + "the bundled re-ID model loads in the worker and passes its self-test", !!info && (info.backend === "wasm" || info.backend === "webgpu"), info);
    console.log("   backend:", JSON.stringify(info));
    const R = await p.evaluate(async () => {
      const rnd = (s) => () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const rng = rnd(12345);
      const COL = [[200, 30, 30], [30, 60, 200], [30, 140, 60], [235, 200, 40], [20, 20, 20], [235, 235, 235], [120, 120, 120], [140, 60, 170], [240, 130, 30], [60, 160, 190], [120, 80, 50], [220, 120, 160], [20, 40, 90], [90, 100, 40]];
      const N = 12, ids = [];
      // identities: shirt + trouser colours + skin + a stripe/logo; some deliberately share a shirt or trousers (hard distractors)
      for (let i = 0; i < N; i++) ids.push({ shirt: COL[Math.floor(rng() * COL.length)], pants: COL[Math.floor(rng() * COL.length)], skin: [[240, 200, 170], [190, 140, 100], [120, 80, 55]][i % 3], stripe: rng() < 0.4, hair: [[20, 15, 10], [90, 60, 30], [200, 190, 160]][Math.floor(rng() * 3)] });
      ids[1].shirt = ids[0].shirt; ids[3].pants = ids[2].pants; ids[5].shirt = ids[4].shirt; ids[5].pants = ids[4].pants.map((v) => Math.min(255, v + 30));
      const cv = document.createElement("canvas"); cv.width = 128; cv.height = 256; const g = cv.getContext("2d", { willReadFrequently: true });
      const css = (c, k = 1) => "rgb(" + c.map((v) => Math.max(0, Math.min(255, Math.round(v * k)))).join(",") + ")";
      function render(id, cam, seed) {
        const r = rnd(seed), k = cam.bright, sc = 0.85 + r() * 0.2, ox = (r() - 0.5) * 10, sw = (r() - 0.5) * 14;
        g.filter = "none"; g.fillStyle = css([90 + r() * 60, 95 + r() * 50, 90 + r() * 50], k); g.fillRect(0, 0, 128, 256);
        g.save(); g.translate(64 + ox, 128); g.scale(sc, sc); g.translate(-64, -128);
        const fillc = (c) => css([c[0] * cam.gain[0], c[1] * cam.gain[1], c[2] * cam.gain[2]], k);
        g.fillStyle = fillc(id.pants); g.fillRect(44 + sw / 2, 138, 18, 84); g.fillRect(66 - sw / 2, 138, 18, 84);   // legs
        g.fillStyle = fillc([30, 30, 30]); g.fillRect(42 + sw / 2, 218, 22, 10); g.fillRect(64 - sw / 2, 218, 22, 10);   // shoes
        g.fillStyle = fillc(id.shirt); g.fillRect(40, 62, 48, 80); g.fillRect(28 - sw / 3, 64, 12, 62); g.fillRect(88 + sw / 3, 64, 12, 62);   // torso + arms
        if (id.stripe) { g.fillStyle = fillc([240, 240, 240]); g.fillRect(40, 96, 48, 8); }
        g.fillStyle = fillc(id.skin); g.beginPath(); g.arc(64, 44, 15, 0, 7); g.fill();
        g.fillStyle = fillc(id.hair); g.beginPath(); g.arc(64, 38, 15, Math.PI, 0); g.fill();
        g.restore();
        if (cam.blur) { g.filter = "blur(" + cam.blur + "px)"; g.drawImage(cv, 0, 0); g.filter = "none"; }
        // sensor noise
        const im = g.getImageData(0, 0, 128, 256), d = im.data; for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * cam.noise; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
        return im;
      }
      const CAMA = { bright: 1.0, gain: [1, 1, 1], blur: 0, noise: 6 }, CAMB = { bright: 0.72, gain: [1.08, 1.0, 0.9], blur: 1.2, noise: 16 }, CAMC = { bright: 1.2, gain: [0.94, 1.0, 1.1], blur: 0.6, noise: 10 };
      const embOf = async (im) => (await TDC.detect.embed(new Uint8ClampedArray(im.data).buffer));
      const hist = (im) => TDC.reid.histFromRGBA(im.data, 128, 256);
      // 2. identification
      const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
      const bh = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.sqrt(a[i] * b[i]); return s; };
      const gal = []; for (let i = 0; i < N; i++) { const im = render(ids[i], CAMA, 100 + i); gal.push({ h: hist(im), e: (await embOf(im)).emb }); }
      const stats = { colour: 0, emb: 0, both: 0, n: 0 }, embMs = [], descMs = [], sameC = [], diffC = [], sameB = [], diffB = [];
      for (const [camX, base] of [[CAMB, 500], [CAMC, 900]]) for (let rep = 0; rep < 3; rep++) for (let i = 0; i < N; i++) {
        const im = render(ids[i], camX, base + rep * 50 + i); let t0 = performance.now(); const h = hist(im); descMs.push(performance.now() - t0);
        const r = await embOf(im); embMs.push(r.ms);
        const sc = (fn) => gal.map((q, j) => [fn(q, j), j]).sort((a, b) => b[0] - a[0])[0][1] === i;
        stats.colour += sc((q) => bh(q.h, h)) ? 1 : 0; stats.emb += sc((q) => cos(q.e, r.emb)) ? 1 : 0;
        stats.both += sc((q) => 0.5 * ((bh(q.h, h) - 0.55) / 0.4) + 0.5 * ((cos(q.e, r.emb) - 0.35) / 0.5)) ? 1 : 0; stats.n++;
        gal.forEach((q, j) => { (j === i ? sameC : diffC).push(cos(q.e, r.emb)); (j === i ? sameB : diffB).push(bh(q.h, h)); });
      }
      const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)], mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      // 3. hand-offs through the Registry: a random order of people leaves RIGHT_REPEATER → appears on BACK 0.4–1.5 s later
      const Reg = TDC.people.Registry, view = (cam, x) => ({ cam, x, y: 0.4, w: 0.08, h: 0.3 });
      async function sim(mode, trials) {
        let right = 0, wrong = 0, none = 0, total = 0;
        const r2 = rnd(777);
        for (let tr = 0; tr < trials; tr++) {
          const reg = new Reg(), k = 2 + Math.floor(r2() * 3), pick = [];
          while (pick.length < k) { const j = Math.floor(r2() * N); if (!pick.includes(j)) pick.push(j); }
          let t = 0; const truth = new Map(), A = [], Bt = [];
          for (let q = 0; q < k; q++) {
            const j = pick[q], tA = t + 0.2 + r2() * 1.2, imA = render(ids[j], CAMA, 3000 + tr * 10 + q), imB = render(ids[j], CAMB, 4000 + tr * 10 + q);
            const ea = mode === "emb" || mode === "both" ? (await embOf(imA)).emb : null, eb = mode === "emb" || mode === "both" ? (await embOf(imB)).emb : null;
            const ha = mode === "colour" || mode === "both" ? hist(imA) : null, hb = mode === "colour" || mode === "both" ? hist(imB) : null;
            // each person walks on RR for 2 s, exits at tA+2, appears on BACK 0.3–1.2 s after (people are 1.0–2.5 s apart)
            A.push({ j, id: "RR" + q, first: tA, seen: tA + 2, hist: ha, emb: ea });
            Bt.push({ j, id: "B" + q, first: tA + 2 + 0.3 + r2() * 0.9, hist: hb, emb: eb });
            t = tA + 1.0 + r2() * 1.5;
          }
          const evs = [];
          for (const a of A) { evs.push([a.first, "RR", a]); }
          for (const bb of Bt) evs.push([bb.first, "B", bb]);
          // step through time in 0.1 s ticks
          const T1 = Math.max(...Bt.map((x) => x.first)) + 1.5, gid = new Map();
          for (let now = 0; now <= T1; now += 0.1) {
            const tracks = [];
            for (const a of A) if (now >= a.first && now <= a.seen + 0.1) tracks.push({ cam: "right_repeater", id: a.id, x: Math.min(0.9, 0.5 + 0.2 * (now - a.first)), y: 0.4, w: 0.08, h: 0.3, vx: 0.2, n: 5, seen: Math.min(now, a.seen), first: a.first, hist: a.hist, emb: a.emb });
            for (const bb of Bt) if (now >= bb.first && now <= bb.first + 2) tracks.push({ cam: "back", id: bb.id, x: Math.max(0.01, 0.0 + 0.2 * (now - bb.first)), y: 0.4, w: 0.08, h: 0.3, vx: 0.2, n: 5, seen: now, first: bb.first, hist: bb.hist, emb: bb.emb });
            const out = reg.update(tracks, now); for (const o of out) gid.set(o.cam + ":" + o.id, o.gid);
          }
          for (let q = 0; q < k; q++) { total++; const ga = gid.get("right_repeater:RR" + q), gb = gid.get("back:B" + q); if (gb == null || gb !== ga) { const other = A.some((a, z) => z !== q && gid.get("right_repeater:" + a.id) === gb); if (other) wrong++; else none++; } else right++; }
        }
        return { right, wrong, none, total, precision: +(right / Math.max(1, right + wrong)).toFixed(3), recall: +(right / total).toFixed(3) };
      }
      const hand = {}; for (const m of ["time", "colour", "emb"]) hand[m] = await sim(m, 40);
      return { N, id: { colour: stats.colour / stats.n, emb: stats.emb / stats.n, both: stats.both / stats.n, n: stats.n }, embMsMedian: Math.round(med(embMs)), embMsMean: Math.round(mean(embMs)), descMsMedian: +med(descMs).toFixed(2), sameCos: +mean(sameC).toFixed(3), diffCos: +mean(diffC).toFixed(3), sameBh: +mean(sameB).toFixed(3), diffBh: +mean(diffB).toFixed(3), hand };
    });
    console.log(JSON.stringify(R, null, 1));
    if (process.env.JSON) fs.writeFileSync(process.env.JSON, JSON.stringify({ browser: BR, info, R }, null, 1));
    ok(tag + "embedding cosine: same person scores higher than different people", R.sameCos > R.diffCos + 0.05, R);
    ok(tag + "rank-1 identification (12 people, 2 camera looks, chance 8 %): colour >= 55 %, embedding >= 80 % (synthetic cartoons: only a plumbing / robustness check, not an accuracy claim for real people)", R.id.colour >= 0.55 && R.id.emb >= 0.8, R.id);
    ok(tag + "hand-offs, colour only: more links found than timing alone, precision >= 0.85", R.hand.colour.right > R.hand.time.right * 1.5 && R.hand.colour.precision >= 0.85, R.hand);
    ok(tag + "hand-offs, embedding: recall >= 0.85 and precision >= 0.95", R.hand.emb.recall >= 0.85 && R.hand.emb.precision >= 0.95, R.hand);
    ok(tag + "one embedding takes < 150 ms and one colour descriptor < 5 ms on this machine", R.embMsMedian < 150 && R.descMsMedian < 5, [R.embMsMedian, R.descMsMedian]);
    ok(tag + "no page errors", errs.length === 0, errs);
    await b.close();
  }
  console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
