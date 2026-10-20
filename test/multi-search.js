// Multi-object search (tag multi-search). Playwright Chromium + WebKit, real YOLO11 (WASM) + CLIP.
//   P  parsing: separators (, ; + / & and or), multi-word classes and vehicle phrases kept whole, sentences for the picture
//      search kept whole, colour words joined ("black and white police car"), kinds (object / vehicle / plate / picture)
//   O  one pass "bus, person" on the moving-bus footage (tools/make-moving-footage.py): one detector run per frame for both
//      terms, results + chips per term with counts, chip filter, chips in the floating search and the phone strip, term box
//      colours in the viewer, gold for the opened result; export burns the bus AND the person (different colours, file checked)
//   V  "city bus, person": vehicle details refine only the vehicle term
//   X  speed: one pass vs separate searches (long footage, LONG=3; frame cache cleared before each)
// Usage: node test/multi-search.js [url]   (BR=chromium|webkit, PHASES=P,O,V,X)
const pw = require("playwright"); const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const PH = (process.env.PHASES || "P,O,V,X").split(",");
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const MOV = process.env.MOVING_SAMPLES || "/tmp/moving-samples", LONGF = process.env.LONG_SAMPLES || "/tmp/long-samples";
if (!fs.existsSync(MOV + "/truth.json")) execFileSync("python3", [path.join(__dirname, "../tools/make-moving-footage.py"), MOV], { stdio: "inherit" });
if (PH.includes("X") && !fs.existsSync(LONGF + "/truth.json")) execFileSync("python3", [path.join(__dirname, "../tools/make-moving-footage.py"), LONGF], { stdio: "inherit", env: { ...process.env, LONG: "3", BUS_CAM: "back", BUS_AT: "75" } });
const filesOf = (FIX) => { const out = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) w(q); else out.push(q); } })(FIX + "/TeslaCam"); return out; };
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x).slice(0, 700) : "")); if (!c) fails++; };
const CASES = [
  ["bus, person, police car", ["bus", "person", "police car"]],
  ["red car and cyclist", ["red car", "cyclist"]],
  ["traffic light and stop sign", ["traffic light", "stop sign"]],
  ["fire hydrant or tour bus", ["fire hydrant", "tour bus"]],
  ["white police car + person", ["white police car", "person"]],
  ["bus/truck", ["bus", "truck"]],
  ["dog & cat; bicycle", ["dog", "cat", "bicycle"]],
  ["find bus and person", ["bus", "person"]],
  ["black and white police car", ["black and white police car"]],
  ["a person in a hoodie and a mask", ["a person in a hoodie and a mask"]],
  ["plate 7AB* and bus", ["plate 7AB*", "bus"]],
  ["bus, a man walking a dog at night", ["bus", "man walking a dog at night"]],
  ["bus", ["bus"]],
  ["bus, bus", ["bus"]],
];
const KINDS = [["bus", "det"], ["traffic light", "det"], ["police car", "vehicle"], ["red tour bus", "vehicle"], ["plate 7AB*", "plate"], ["man walking a dog at night", "clip"], ["cyclist", "det"]];

async function open(ctx, files, qs) {
  const p = ctx.pages().find((x) => !x.__used) || (await ctx.newPage()); p.__used = true; p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message));
  await p.addInitScript(() => {
    window.__exp = []; window.__view = {}; let inFrame = false;
    const iv = setInterval(() => {
      const T = window.TDC; if (!T || !T.burnBoxes || !T.compositor || T.__hooked) return; T.__hooked = true; clearInterval(iv);
      const at = T.burnBoxes.at, draw = T.burnBoxes.draw, df = T.compositor.drawFrame;
      T.compositor.drawFrame = function () { inFrame = true; try { return df.apply(this, arguments); } finally { inFrame = false; } };
      T.burnBoxes.at = function (cam, t) { const r = at.apply(this, arguments); if (inFrame && window.__recording) window.__exp.push({ cam, t, boxes: r.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, text: b.text, color: b.color || null })) }); return r; };
      T.burnBoxes.draw = function (ctx, cam, t, r, iw, ih, list) { if (ctx && ctx.canvas && ctx.canvas.classList && ctx.canvas.classList.contains("find-layer")) window.__view[cam] = (list || []).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, text: b.text, color: b.color || null })); return draw.apply(this, arguments); };
    }, 20);
  });
  await p.goto(URL_ + (qs || ""), { waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important}" });
  await p.setInputFiles("#fileInput", files);
  for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
  await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); return TDC.ui.activate(TDC.library.events[0]); });
  await W(1500);
  return p;
}
async function search(p, q) {
  const t0 = Date.now();
  await p.evaluate((q) => { document.getElementById("findQuery").value = q; TDC.search.run(); }, q);
  await W(300); for (let i = 0; i < 3000 && (await p.evaluate(() => TDC.search.running)); i++) await W(200);
  const ms = Date.now() - t0;
  for (let i = 0; i < 300 && (await p.evaluate(() => !!TDC.search.pending)); i++) await W(200);
  return p.evaluate((ms) => ({ ms, status: document.getElementById("findStatus").textContent.slice(0, 300), last: TDC.multi.last || null,
    terms: (TDC.search.terms || []).map((c) => ({ term: c.term, kind: c.kind, color: c.color })),
    hits: TDC.search.hits.map((h) => ({ t: +h.t.toFixed(2), cam: h.cam, ti: h.ti, term: h.term, label: h.label, color: h.termColor, text: String(h.text || "").slice(0, 80), box: h.box })),
    chips: [...document.querySelectorAll("#findChips .term-chip")].map((c) => c.textContent) }), ms);
}
(async () => {
  const report = {};
  for (const bn of (process.env.BR || "chromium,webkit").split(",")) {
    const ctx = await pw[bn].launchPersistentContext("/tmp/tdc-veh-profile-" + bn, bn === "chromium" ? { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"], viewport: { width: 1440, height: 900 } } : { viewport: { width: 1440, height: 900 } });
    await ctx.route((u) => u.origin === new URL(URL_).origin, (r) => r.continue());
    await ctx.addInitScript(() => { try { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, live: false, model: "nano", conf: 0.35 })); localStorage.setItem("tdc.export.burnBoxes", "1"); localStorage.setItem("tdc.vehicle.v1", JSON.stringify({ enabled: true, makes: false })); localStorage.removeItem("tdc.plates.v1"); localStorage.removeItem("tdc.search.bestOnly"); } catch (e) {} });
    const tag = bn, rep = (report[bn] = {});
    const p = await open(ctx, filesOf(MOV), "?strip=1");
    if (PH.includes("P")) {
      const got = await p.evaluate((cases) => cases.map(([q]) => TDC.multi.split(q)), CASES);
      const bad = CASES.map(([q, want], i) => [q, want, got[i]]).filter(([, want, g]) => JSON.stringify(want) !== JSON.stringify(g));
      ok(tag + " P: query splitting (" + CASES.length + " cases: separators, multi-word classes, vehicle phrases, sentences, colours)", bad.length === 0, bad);
      const kinds = await p.evaluate((ks) => ks.map(([t]) => TDC.multi.classify(t, 0).kind), KINDS);
      const kb = KINDS.map(([t, k], i) => [t, k, kinds[i]]).filter(([, k, g]) => !(g === k || (k === "plate" && g === "plate-off")));
      ok(tag + " P: each term goes to the right search (object / vehicle / plate / picture)", kb.length === 0, kb);
    }
    if (PH.includes("O")) {
      await p.evaluate(() => TDC.detect.frameCache.clear());
      const r = await search(p, "bus, person");
      const bus = r.hits.filter((h) => h.term === "bus"), per = r.hits.filter((h) => h.term === "person");
      ok(tag + " O: one search finds the bus and the person", bus.length > 0 && per.length > 0, { status: r.status, hits: r.hits.length });
      ok(tag + " O: one pass: one detector run per sampled frame for both terms", r.last && r.last.detRuns <= r.last.frames && r.last.frames > 0, r.last);
      ok(tag + " O: a chip per term with its count, plus All", r.chips.length === 3 && /^All · \d+/.test(r.chips[0]) && r.chips.some((c) => /bus · [1-9]/.test(c)) && r.chips.some((c) => /person · [1-9]/.test(c)), r.chips);
      ok(tag + " O: each term has its own colour, not gold", r.terms.length === 2 && r.terms[0].color !== r.terms[1].color && r.terms.every((c) => !/e6b450/i.test(c.color)), r.terms);
      const ui = await p.evaluate(() => ({ us: [...document.querySelectorAll("#usChips .term-chip")].map((c) => c.textContent), ss: [...document.querySelectorAll("#ssChips .term-chip")].map((c) => c.textContent) }));
      ok(tag + " O: the chips are in the floating search and the phone strip too", ui.us.length === 3 && ui.ss.length === 3, ui);
      // filter: tap the person chip (in the strip), then All again (floating search)
      await p.evaluate(() => { const b = [...document.querySelectorAll("#ssChips .term-chip")].find((c) => /person/.test(c.textContent)); b.click(); });
      const f1 = await p.evaluate(() => ({ n: TDC.search.hits.length, terms: [...new Set(TDC.search.hits.map((h) => h.term))], strip: document.querySelectorAll("#ssRow .ss-item").length }));
      await p.evaluate(() => { [...document.querySelectorAll("#usChips .term-chip")].find((c) => /^All/.test(c.textContent)).click(); });
      const f2 = await p.evaluate(() => TDC.search.hits.length);
      ok(tag + " O: chip filter shows one term, All shows every term", f1.terms.length === 1 && f1.terms[0] === "person" && f2 === r.hits.length, { person: f1, all: f2 });
      // open the bus result: gold for it, the person keeps its colour, in the viewer
      const bh = await p.evaluate(async () => { const h = TDC.search.hits.filter((x) => x.term === "bus").sort((a, b) => b.score - a.score)[0]; await TDC.search.openHit(h); return { t: h.t, cam: h.cam }; });
      for (let i = 0; i < 300 && (await p.evaluate(() => !!TDC.search.pending)); i++) await W(200);
      const pc = r.terms.find((c) => c.term === "person").color;
      const view = await p.evaluate(async (t) => { TDC.player.pause(); await TDC.player.seek(t); await new Promise((r) => setTimeout(r, 400)); window.__view = {}; TDC.search.paintBoxes(); return window.__view; }, bh.t);
      const vb = (view[bh.cam] || []);
      ok(tag + " O: the viewer shows the opened bus in gold and the person in the person colour", vb.some((b) => /bus/.test(b.text) && !b.color) && vb.some((b) => /person/.test(b.text) && b.color === pc), vb.map((b) => [b.text, b.color]));
      // export around the bus moment: both burned, the person in its colour
      const range = [[Math.max(0, bh.t - 1.2), bh.t + 1.2]];
      const ex = await p.evaluate(async (ranges) => {
        window.__exp = []; window.__recording = true;
        try { const r = await TDC.exporter.run({ preset: "compat", ranges, show: { ...TDC.prefs.show, labels: false, hud: false, map: false, fsd: false, time: false, boxes: true }, onStatus: () => {}, onProgress: () => {} }); window.__lastExport = r.blob; return { ok: true, frames: r.frames }; }
        catch (e) { return { ok: false, err: String(e && e.message || e) }; } finally { window.__recording = false; }
      }, range);
      const exp = await p.evaluate((cam) => window.__exp.filter((e) => e.cam === cam), bh.cam);
      const both = exp.filter((e) => e.boxes.some((b) => /bus/.test(b.text)) && e.boxes.some((b) => /person/.test(b.text) && b.color === pc));
      ok(tag + " O: the export burns the bus and the person (person in its colour) into the same frames", ex.ok && both.length >= 5, { ex, frames: exp.length, both: both.length });
      const pb = (both[Math.floor(both.length / 2)] || {}).boxes, pbox = pb && pb.find((b) => /person/.test(b.text)), tau = both.length ? both[Math.floor(both.length / 2)].t - range[0][0] : 0;
      const px = pbox ? await p.evaluate(async ([tau, box, cam, col]) => {
        const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(window.__lastExport); if (TDC.search.park) TDC.search.park(v);
        await new Promise((r) => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 6000); }); v.currentTime = tau; await new Promise((r) => { v.onseeked = r; setTimeout(r, 4000); });
        const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext("2d"); g.drawImage(v, 0, 0);
        const geo = TDC.compositor.geometry(c.width, c.height, TDC.player.ev.tile, false), r = TDC.compositor.cellRect(geo.grid, TDC.GRID.indexOf(cam), 0);
        const s = Math.min(r.w / 1280, r.h / 960), fw = 1280 * s, fh = 960 * s, fx = r.x + (r.w - fw) / 2, fy = r.y + (r.h - fh) / 2;
        const x = Math.round(fx + box.x * fw), y = Math.round(fy + box.y * fh), w = Math.round(box.w * fw), h = Math.round(box.h * fh);
        const R = parseInt(col.slice(1, 3), 16), G = parseInt(col.slice(3, 5), 16), B = parseInt(col.slice(5, 7), 16);
        let n = 0; const scan = (x0, y0, ww, hh) => { const d = g.getImageData(Math.max(0, x0), Math.max(0, y0), Math.max(1, ww), Math.max(1, hh)).data; for (let k = 0; k < d.length; k += 4) if (Math.abs(d[k] - R) < 50 && Math.abs(d[k + 1] - G) < 50 && Math.abs(d[k + 2] - B) < 50) n++; };
        scan(x - 5, y + Math.round(h * 0.3), 11, Math.round(h * 0.4)); scan(x + w - 5, y + Math.round(h * 0.3), 11, Math.round(h * 0.4)); v.remove(); return n;
      }, [tau, pbox, bh.cam, pc]) : -1;
      ok(tag + " O: the exported file has the person box in the person colour", px > 6, { pixels: px });
      rep.one = { ms: r.ms, last: r.last };
    }
    if (PH.includes("V")) {
      await p.evaluate(() => TDC.search.clear());
      const r = await search(p, "city bus, person");
      const vb = r.hits.filter((h) => h.term === "city bus"), per = r.hits.filter((h) => h.term === "person");
      ok(tag + " V: 'city bus, person': vehicle details label the bus term, the person term stays a plain detection", vb.length > 0 && vb.every((h) => /bus/.test(h.text)) && per.length > 0 && per.every((h) => !/color/.test(h.text)), { terms: r.terms, hits: r.hits.slice(0, 5).map((h) => [h.term, h.text]) });
    }
    ok(tag + " no page errors", p.errs.length === 0, p.errs.slice(0, 3));
    if (PH.includes("X")) {
      const q = await open(ctx, filesOf(LONGF));
      const run = async (qq) => { await q.evaluate(() => { TDC.search.clear(); TDC.detect.frameCache.clear(); TDC.detect.liveSamples = {}; }); return search(q, qq); };
      const sep = []; for (const t of ["bus", "person", "car"]) sep.push(await run(t));   // separate first, then the one pass
      const one = await run("bus, person, car");
      const sepMs = sep.reduce((a, r) => a + r.ms, 0);
      rep.speed = { onePassMs: one.ms, separateMs: sep.map((r) => r.ms), sumMs: sepMs, frames: one.last && one.last.frames, hits: one.hits.length, sepHits: sep.map((r) => r.hits.length) };
      console.log(tag, "speed", JSON.stringify(rep.speed));
      ok(tag + " X: one pass for 3 terms is faster than 3 separate searches (≤ 60% of their total)", one.ms <= 0.6 * sepMs, rep.speed);
      ok(tag + " X: one pass finds what the separate searches find (per term counts)", ["bus", "person", "car"].every((t, i) => one.hits.filter((h) => h.term === t).length >= Math.min(1, sep[i].hits.length)), { one: ["bus", "person", "car"].map((t) => one.hits.filter((h) => h.term === t).length), sep: sep.map((r) => r.hits.length) });
      ok(tag + " X: no page errors", q.errs.length === 0, q.errs.slice(0, 3));
      await q.close();
    }
    await ctx.close();
  }
  console.log("REPORT " + JSON.stringify(report));
  console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
