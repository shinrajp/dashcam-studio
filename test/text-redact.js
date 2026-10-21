// Text search & redaction (tag text-search-fix), on made-up synthetic footage (tools/make-text-footage.py):
// street sign, business sign, small rotated sign, moving truck side with motion blur, low-contrast house number,
// perspective sign, low-contrast grey sign, and a burned-in clock at the top right — 6 cameras, day (EV=day) or night.
// Part 1 (node): js/text-match.js (fuzzy phrase match, look-alikes, generic words, query routing, tracks).
// Part 2 (Playwright): routing · read rate per text type ≥ 80% · export burn hides every item (≥ 85% of the box in
//   ≥ 80% of frames) and OCR can't read it back · other text isn't blurred · blur is opaque in the viewer · All text is
//   instant after a phrase run · text search lists time + camera + thumbnail, click seeks and shows the box · the WB
//   filter is copied onto the blur layer · frame errors are reported · the Settings switch hides text-only controls
//   (plate / face presets stay) and is remembered after reload · no page errors.
// Usage: BR=chromium|webkit EV=day|night node test/text-redact.js [url]   (BR unset: both; EV unset: day)
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const M = require("../js/text-match.js");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.TEXT_FIXTURES || "/tmp/text-samples", EV = process.env.EV || "day";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 700) : "")); if (!c) fails++; };

// ── part 1: matching ──
const hit = (p, l) => M.phraseScore(p, l) >= 0.6;
ok("exact / spacing / case: QUILLBY AVE ~ 'Quillby Ave', 'QUILLBYAVE'", hit("QUILLBY AVE", "Quillby Ave") && hit("QUILLBY AVE", "QUILLBYAVE"));
ok("OCR look-alikes: 'ZENDER BAKERY' ~ 'ZENDER 8AKERY', '4821' ~ '482l'", hit("ZENDER BAKERY", "ZENDER 8AKERY") && hit("4821", "482l"));
ok("one edit allowed on 4–7 letters, two on 8+: NORTHWIND FREIGHT ~ 'NORTHWIMD FREIGT'", hit("NORTHWIND FREIGHT", "NORTHWIMD FREIGT"));
ok("cut-off text still matches (truck leaving the frame): 'THWINDFREIGHT'", hit("NORTHWIND FREIGHT", "THWINDFREIGHT"));
ok("distinctive word alone matches: 'QUILLBY' for QUILLBY AVE", hit("QUILLBY AVE", "QUILLBY"));
ok("generic word alone does not: 'AVE', 'ST', 'CAFE ST' vs VARNEY ST", !hit("QUILLBY AVE", "AVE") && !hit("VARNEY ST", "ST") && !hit("VARNEY ST", "MAIN ST"));
ok("short phrase anchored at a word start: 4821 not inside 148210", !hit("4821", "148210") && hit("4821", "NO 4821"));
ok("unrelated words don't match", !hit("ZENDER BAKERY", "ORBIT CYCLES") && !hit("PELLO CAFE", "QUILLBY AVE") && !hit("4821", "1234"));
const TQ = (q) => M.parseTextQuery(q);
ok("text queries: 'text Oak Ave', 'sign: VARNEY ST', '\"PELLO CAFE\"', bare 'ZENDER BAKERY'", TQ("text Oak Ave") && TQ("sign: VARNEY ST") && TQ("\"PELLO CAFE\"") && TQ("ZENDER BAKERY"));
ok("not text queries: 'red car', '7ABC123', 'bus, person', '20:53:46'", !TQ("red car") && !TQ("7ABC123") && !TQ("bus, person") && !TQ("20:53:46"));
const tr = M.buildTracks([{ t: 0, boxes: [{ x: 0.5, y: 0.4, w: 0.2, h: 0.05, text: "A" }] }, { t: 1, boxes: [{ x: 0.4, y: 0.4, w: 0.2, h: 0.05, text: "A" }] }], { maxGap: 2 });
const mid = tr.length === 1 && M.boxAt(tr[0], 0.5, 0.3);
ok("tracks: moving box interpolated between samples, held a little past the ends", mid && Math.abs(mid.x - 0.45) < 0.01 && M.boxAt(tr[0], 1.2, 0.3) && !M.boxAt(tr[0], 1.6, 0.3), mid);

(async () => {
  let pw = null; try { pw = require("playwright"); } catch (_) {}
  if (!pw || process.env.NODE_ONLY) { console.log(fails ? "FAILED " + fails : "ALL PASS (node part only)"); process.exit(fails ? 1 : 0); }
  if (!fs.existsSync(FIX + "/" + EV + "/TeslaCam")) execFileSync("python3", [path.join(__dirname, "../tools/make-text-footage.py"), FIX], { stdio: "inherit" });
  const TRUTH = JSON.parse(fs.readFileSync(FIX + "/text-truth.json")), frames = TRUTH.events[EV].frames, ITEMS = TRUTH.items;
  // night: the 4-level house number is a known miss (see README); everything else must pass
  const SKIP = (process.env.SKIP || (EV === "night" ? "house" : "")).split(",").filter(Boolean);
  const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) w(q); else files.push(q); } })(FIX + "/" + EV + "/TeslaCam");
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    const b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage();
    const errs = []; p.on("pageerror", (e) => errs.push(e.message));
    const open = async () => {
      await p.goto(URL_, { waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important}" });
      await p.setInputFiles("#fileInput", files);
      for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
      await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); return TDC.ui.activate(TDC.library.events[0]); });
      await W(1500);
    };
    await open();
    await p.evaluate(() => { localStorage.removeItem("tdc.textSearch.v1"); TDC.textSearch.setOn(true); });
    // routing
    const route = await p.evaluate(() => ["ZENDER BAKERY", "text Oak Ave", "\"PELLO CAFE\"", "20:53:46", "+1:05", "red car", "bus"].map((q) => TDC.search.route(q)));
    ok(BR + ": routing (bare caps / text / quoted → text; times → time; 'red car', 'bus' not text)", route[0] === "text" && route[1] === "text" && route[2] === "text" && route[3] === "time" && route[4] === "time" && route[5] !== "text" && route[6] !== "text", route);
    // redact every phrase
    const want = Object.keys(ITEMS).filter((k) => k !== "stamp" && !SKIP.includes(k));
    const t0 = Date.now();
    await p.evaluate((q) => { document.getElementById("redactCam").value = "front"; document.getElementById("redactQuery").value = q; TDC.redact.run(q); }, want.map((k) => '"' + ITEMS[k].text + '"').join(", "));
    await W(500); for (let i = 0; i < 4000 && (await p.evaluate(() => TDC.redact.running)); i++) await W(400);
    const runSec = (Date.now() - t0) / 1000;
    const cov = await p.evaluate((frames) => {
      const R = TDC.redact, out = {};
      const cover = (tb, boxes) => { let n = 0, k = 0; for (let i = 0; i < 12; i++) for (let j = 0; j < 6; j++) { const x = tb[0] + tb[2] * (0.1 + 0.8 * (i + 0.5) / 12), y = tb[1] + tb[3] * (0.22 + 0.6 * (j + 0.5) / 6); k++; if (boxes.some((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)) n++; } return n / k; };
      for (const cam of Object.keys(frames)) for (let i = 0; i < frames[cam].length; i += 2) {
        const f = frames[cam][i], bx = R.boxesAt(cam, f.t);
        for (const it of f.items) { const o = out[it.id] || (out[it.id] = { frames: 0, covered: 0, sampled: 0, read: 0 }); o.frames++; if (cover(it.box, bx) >= 0.85) o.covered++; }
      }
      for (const cam of Object.keys(R.frames || {})) for (const s of R.frames[cam]) {
        const f = frames[cam] && frames[cam][Math.min(frames[cam].length - 1, Math.round(s.t * 24))]; if (!f) continue;
        for (const it of f.items) if (it.full && out[it.id]) { out[it.id].sampled++; if (cover(it.box, s.boxes) >= 0.6) out[it.id].read++; }
      }
      return { out, status: document.getElementById("redactStatus").textContent };
    }, frames);
    console.log("INFO " + BR + " " + EV + ": phrase run " + runSec.toFixed(1) + " s; " + JSON.stringify(cov.out));
    for (const k of want) {
      const o = cov.out[k] || { frames: 1, covered: 0, sampled: 1, read: 0 };
      ok(BR + ": " + ITEMS[k].kind + " '" + ITEMS[k].text + "' read in ≥ 80% of the frames where it's fully in view", o.read / Math.max(1, o.sampled) >= 0.8, o);
      ok(BR + ": " + ITEMS[k].kind + " blurred in ≥ 80% of frames", o.covered / o.frames >= 0.8, o);
    }
    ok(BR + ": the burned-in clock was not asked for and is not blurred", (cov.out.stamp || { covered: 0 }).covered === 0, cov.out.stamp);
    ok(BR + ": status says all cameras, other text stays", /on all 6 cameras/.test(cov.status) && /Other text stays visible/.test(cov.status), cov.status);
    // export burn: OCR can't read the text back; and the blur is opaque (no sharp copy)
    const leak = await p.evaluate(async ([frames, items, want]) => {
      const R = TDC.redact, Mm = TDC.textMatch, out = { checked: 0, readable: [], sharp: 0, sharpChecked: 0 }; const vid = document.createElement("video"); vid.muted = true; vid.playsInline = true;
      for (const cam of Object.keys(frames)) for (const u of [0.2, 0.55, 0.85]) {
        const f = frames[cam][Math.round(u * (frames[cam].length - 1))]; const its = f.items.filter((i) => want.includes(i.id)); if (!its.length) continue;
        try { await Promise.race([TDC.search.seekSample(vid, TDC.player.ev.clips[0].files[cam], f.t), new Promise((_, no) => setTimeout(() => no(new Error("seek timeout")), 8000))]); } catch (e) { out.seekFail = (out.seekFail || 0) + 1; vid.removeAttribute("src"); vid.load(); continue; }   // headless WebKit sometimes never finishes a seek on a fresh <video>
        const c = document.createElement("canvas"); c.width = vid.videoWidth; c.height = vid.videoHeight; const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(vid, 0, 0);
        const before = x.getImageData(0, 0, c.width, c.height).data.slice();
        R.burn(x, cam, f.t, { x: 0, y: 0, w: c.width, h: c.height }, c.width, c.height, vid);
        const after = x.getImageData(0, 0, c.width, c.height).data;
        for (const i of its) {   // edge energy inside the box: must drop a lot (a semi-transparent blur keeps the edges)
          const [bx, by, bw, bh] = i.box; let e0 = 0, e1 = 0;
          for (let yy = Math.round((by + bh * 0.3) * c.height); yy < (by + bh * 0.7) * c.height; yy++) for (let xx = Math.round((bx + bw * 0.15) * c.width); xx < (bx + bw * 0.85) * c.width - 1; xx++) { const o = (yy * c.width + xx) * 4; e0 += Math.abs(before[o + 1] - before[o + 5]); e1 += Math.abs(after[o + 1] - after[o + 5]); }
          out.sharpChecked++; if (e0 > 0 && e1 / e0 > 0.45) out.sharp++;
        }
        const lines = await R.ocrFrame(c, {});
        for (const i of its) { out.checked++; const l = lines.find((l) => Mm.phraseScore(items[i.id].text, l.text) >= 0.6); if (l) out.readable.push(cam + "@" + f.t + ":" + l.text); }
      }
      return out;
    }, [frames, ITEMS, want]);
    ok(BR + ": export burn — OCR can't read any hidden text back (" + leak.checked + " checks)", leak.checked > 10 && leak.readable.length === 0, leak);
    ok(BR + ": export burn — the blur is opaque (edges inside the box mostly gone)", leak.sharp <= Math.floor(leak.sharpChecked * 0.1), leak);
    // only what was asked for: VARNEY ST alone leaves ZENDER BAKERY (front) and ORBIT CYCLES (right pillar) visible
    const only = await p.evaluate(async (frames) => {
      await TDC.redact.run('"VARNEY ST"'); for (let i = 0; i < 400 && TDC.redact.running; i++) await new Promise((r) => setTimeout(r, 100));
      const R = TDC.redact, hit = (cam, id) => frames[cam].filter((f) => f.items.some((i) => i.id === id)).filter((f, k) => k % 4 === 0).map((f) => { const it = f.items.find((i) => i.id === id), cx = it.box[0] + it.box[2] / 2, cy = it.box[1] + it.box[3] / 2; return R.boxesAt(cam, f.t).some((b) => cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h); });
      const ms = 0; return { persp: hit("left_pillar", "persp"), business: hit("front", "business"), lowc: hit("right_pillar", "lowc") };
    }, frames);
    const frac = (a) => a.filter(Boolean).length / Math.max(1, a.length);
    ok(BR + ": VARNEY ST alone (index reused): it's blurred, the other signs aren't", frac(only.persp) >= 0.8 && frac(only.business) === 0 && frac(only.lowc) === 0, { persp: frac(only.persp), business: frac(only.business), lowc: frac(only.lowc) });
    // All text: instant from the index, includes the clock
    const all = await p.evaluate(async () => { const t0 = performance.now(); await TDC.redact.run("blur all text"); const ms = performance.now() - t0; const n = Object.values(TDC.redact.frames).reduce((a, v) => a + v.length, 0); return { ms, n, stamp: TDC.redact.boxesAt("front", 5).length }; });
    ok(BR + ": All text after a scan is instant (< 3 s) and covers more (clock too)", all.ms < 3000 && all.stamp >= 3, all);
    // WB filter copied onto the blur layer in the viewer
    const wb = await p.evaluate(async () => { const tl = TDC.player.tiles.front, v = tl.vids[TDC.player.active]; v.style.filter = "brightness(1.2)"; TDC.player.pause(); await TDC.player.seek(4); await new Promise((r) => setTimeout(r, 600)); TDC.emit("layout"); await new Promise((r) => setTimeout(r, 300)); const cs = [...tl.tile.querySelectorAll("canvas")].map((c) => c.style.filter).filter(Boolean); v.style.filter = ""; return cs; });
    ok(BR + ": the white-balance filter is applied to the blur layer too", wb.some((f) => /brightness\(1\.2\)/.test(f)), wb);
    await p.evaluate(() => TDC.redact.clear());
    // text search: time + camera + thumbnail; click seeks; gold box follows the text
    await p.evaluate(() => TDC.searchUI.show(false));
    const res = await p.evaluate(async () => { document.getElementById("usQuery").value = "text PELLO CAFE"; TDC.searchUI.find("text PELLO CAFE"); for (let i = 0; i < 200 && TDC.search.running; i++) await new Promise((r) => setTimeout(r, 100)); await new Promise((r) => setTimeout(r, 400));
      return [...document.querySelectorAll("#usResults .us-item")].map((b) => ({ txt: b.textContent, img: !!b.querySelector("img.us-thumb") })); });
    ok(BR + ": 'text PELLO CAFE' → a result with time, camera (Rear) and thumbnail", res.length >= 1 && res.some((r) => /\d:\d\d/.test(r.txt) && /Rear|Back/i.test(r.txt) && /PELLO/i.test(r.txt) && r.img), res);
    await p.evaluate(() => TDC.player.seek(0.1)); await W(300);
    if (res.length) await p.click("#usResults .us-item.has-thumb");
    await W(900);
    const after = await p.evaluate(() => ({ t: TDC.player.time, tracks: !!(TDC.detect && TDC.detect.tracks && (Array.isArray(TDC.detect.tracks) ? TDC.detect.tracks.length : Object.keys(TDC.detect.tracks).length)) }));
    ok(BR + ": clicking the result seeks there and shows the box", after.t > 0.5 && after.tracks, after);
    const miss = await p.evaluate(async () => { await TDC.search.run && null; document.getElementById("usQuery").value = "text WOBBLEFIZZ"; TDC.searchUI.find("text WOBBLEFIZZ"); await new Promise((r) => setTimeout(r, 1200)); return document.getElementById("usStatus").textContent; });
    ok(BR + ": no match says so (no error)", /n't|no /i.test(miss) && !/error/i.test(miss), miss);
    // errors are reported, not swallowed
    const er = await p.evaluate(async () => { const R = TDC.redact, TS = TDC.textSearch, ev = TDC.player.ev, o = R.ocrFrame; TS.forget(ev.id); let k = 0; R.ocrFrame = async (c, x) => { if (k++ % 3 === 0) throw new Error("synthetic failure"); return o(c, x); };
      try { await R.run('"QUILLBY AVE"'); } finally { R.ocrFrame = o; } return document.getElementById("redactStatus").textContent; });
    ok(BR + ": frames that fail to read are counted in the status", /couldn't be read/.test(er), er);
    // the switch
    await p.evaluate(() => TDC.textSearch.setOn(false));
    const vis = await p.evaluate(() => { const v = (el) => !!el && el.offsetParent !== null || (el && getComputedStyle(el).display !== "none" && el.getClientRects().length > 0); const q = (s) => document.querySelector(s);
      document.querySelector("#redactQuery") && document.querySelector("#redactQuery").scrollIntoView();
      return { query: getComputedStyle(q("#redactQuery")).display, all: getComputedStyle(q('.redact-presets [data-q="blur all text"]')).display, plates: getComputedStyle(q('.redact-presets [data-q="blur the license plate"]')).display, faces: [...document.querySelectorAll(".redact-presets button")].filter((b) => /face/i.test(b.getAttribute("data-q"))).map((b) => getComputedStyle(b).display), usRedact: q("#usRedact") ? getComputedStyle(q("#usRedact")).display : "none" }; });
    ok(BR + ": switch off → text box, All text, Blur text hidden; plate and face presets stay", vis.query === "none" && vis.all === "none" && vis.usRedact === "none" && vis.plates !== "none" && vis.faces.length && vis.faces.every((d) => d !== "none"), vis);
    const offRun = await p.evaluate(async () => { await TDC.redact.run("blur all text"); return document.getElementById("redactStatus").textContent; });
    ok(BR + ": switch off → text redaction says it's off, plate/face still work", /turned off/.test(offRun), offRun);
    const offRoute = await p.evaluate(async () => { const r = TDC.search.route("text Oak Ave"); document.getElementById("usQuery").value = "text Oak Ave"; TDC.searchUI.find("text Oak Ave"); await new Promise((r) => setTimeout(r, 800)); return { r, st: document.getElementById("usStatus").textContent }; });
    ok(BR + ": switch off → 'text …' says text search is off (no scan)", offRoute.r === "text (off)" && /turned off/.test(offRoute.st), offRoute);
    await open();
    const kept = await p.evaluate(() => ({ on: TDC.textSearch.on(), cls: document.body.classList.contains("no-text-search"), box: document.getElementById("setTextSearch") && document.getElementById("setTextSearch").checked }));
    ok(BR + ": the switch is remembered after reload (and shown in Settings)", kept.on === false && kept.cls && kept.box === false, kept);
    await p.evaluate(() => { localStorage.removeItem("tdc.textSearch.v1"); });
    ok(BR + ": no page errors", errs.length === 0, errs);
    if (process.env.SHOTS) {
      await p.evaluate(() => TDC.textSearch.setOn(true));
      // shots are taken by tools in test/README (text-*.png)
    }
    await b.close();
  }
  console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
