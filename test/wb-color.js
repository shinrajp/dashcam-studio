// Vehicle colour after white balance (tag wb-color), Playwright Chromium + WebKit, real YOLO11 (WASM).
// Footage: tools/make-wbcolor-footage.py — a night street under a ~3000 K streetlight, front camera: white tour bus,
// red car, blue bus, brown car (public-domain / CC0 photos lit by that light), mirror cameras with the dim white car body.
//  - classifier units: a dim warm grey reads gray (not brown); real brown, beige, red, blue stay colours
//  - per vehicle: raw colour (before) vs colour after the mirrors' white point (after): white bus → white, red stays red,
//    blue stays blue, brown stays brown; the white point is found with the viewer's White balance toggle OFF (auto)
//  - search "white bus": found, label "color white (corrected for NNNN K light)"; setting off → raw colour, no "corrected"
//  - old index entries (raw colours, no version) are judged again; the setting change re-judges too
//  - no car body in the mirrors → no white point → raw colours, no "corrected"
//  - live label (Detect while playing) says white for the bus; YOLO input and export pixels are untouched
// Usage: node test/wb-color.js [url]
const pw = require("playwright"); const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.WBC_SAMPLES || "/tmp/wbcolor-samples", NOP = process.env.WBC_NOPAINT || "/tmp/wbcolor-nopaint", DAY = process.env.WBC_DAY || "/tmp/wbcolor-day";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const gen = (dir, env) => { if (!fs.existsSync(dir + "/TeslaCam")) execFileSync("python3", [path.join(__dirname, "../tools/make-wbcolor-footage.py"), dir], { stdio: "inherit", env: { ...process.env, ...env } }); };
gen(FIX, {}); gen(NOP, { NOPAINT: "1" }); gen(DAY, { DAY: "1" });
const list = (d0) => { const out = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) w(q); else out.push(q); } })(d0 + "/TeslaCam"); return out; };
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x).slice(0, 700) : "")); if (!c) fails++; };
const SEG = [["white bus", 1.0, "bus", "white"], ["red car", 3.0, "car", "red"], ["blue bus", 5.0, "bus", "blue"], ["brown car", 7.0, "car", "brown"]];
async function open(ctx, dir) {
  const p = ctx.pages().find((x) => !x.__used) || (await ctx.newPage()); p.__used = true; p.errs = p.errs || []; if (!p.__h) { p.__h = 1; p.on("pageerror", (e) => p.errs.push(e.message)); }
  await p.goto(URL_, { waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important}" });
  await p.setInputFiles("#fileInput", list(dir));
  for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
  await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); return TDC.ui.activate(TDC.library.events[0]); });
  await W(1200);
  return p;
}
/** Raw vs corrected colour of the biggest vehicle at time t on the front camera. */
const colours = (p) => p.evaluate(async (SEG) => {
  const out = [];
  for (const [name, t, cls] of SEG) {
    const fix = await TDC.wb.colourFix(t);   // first: it seeks its own hidden video, never the detector's
    const v = await TDC.detect.frameAt("front", t);
    const dets = (await TDC.detect.detectImage(v, v.videoWidth, v.videoHeight, { conf: 0.25 })).filter((d) => ["car", "bus", "truck"].includes(d.label)).sort((a, b) => b.w * b.h - a.w * a.h);
    const d = dets[0]; if (!d) { out.push({ name, none: true }); continue; }
    const c = document.createElement("canvas"), W = 64, H = Math.max(8, Math.round((d.h * v.videoHeight / (d.w * v.videoWidth)) * 64)); c.width = W; c.height = H;
    const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(v, (d.x + d.w * 0.06) * v.videoWidth, (d.y + d.h * 0.06) * v.videoHeight, d.w * 0.88 * v.videoWidth, d.h * 0.88 * v.videoHeight, 0, 0, W, H);
    const px = x.getImageData(0, 0, W, H).data, A = TDC.vehicleAttrs;
    const raw = A.colorFromPixels(px, W, H), cor = fix ? A.colorFromPixels(px, W, H, { gains: fix.gains, night: fix.cct < 4500 }) : null;
    out.push({ probe: TDC.wb.lastColourProbe, name, t, det: d.label, raw: raw.name, after: cor && cor.name, K: fix && Math.round(fix.cct), src: fix && fix.source, gains: fix && fix.gains.map((g) => +g.toFixed(2)) });
  }
  return out;
}, SEG);
const find = async (p, q) => {
  await p.evaluate((q) => { document.getElementById("findQuery").value = q; document.getElementById("findCam").value = "front"; TDC.search.run(); }, q);
  await W(300);
  for (let i = 0; i < 1500 && (await p.evaluate(() => TDC.search.running)); i++) await W(200);
  return p.evaluate(() => ({ status: document.getElementById("findStatus").textContent, hits: TDC.search.hits.map((h) => ({ t: +h.t.toFixed(2), cam: h.cam, text: h.text, best: !!h.best, color: h.vdet && h.vdet.color, raw: h.vdet && h.vdet.rawColor, K: h.vdet && h.vdet.wbK })) }));
};
(async () => {
  for (const bn of (process.env.BR || "chromium,webkit").split(",")) {
    const b = await pw[bn].launch(bn === "chromium" ? { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] } : {});
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => { if (!sessionStorage.getItem("wbc")) { sessionStorage.setItem("wbc", "1"); localStorage.clear(); try { indexedDB.deleteDatabase("tdc-vehicle-index"); } catch (_) {}
      localStorage.setItem("tdc.vehicle.v1", JSON.stringify({ enabled: true, makes: false })); localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, live: false, model: "nano", conf: 0.35, speed: "balanced", liveCams: "all" })); } });
    const tag = bn;
    let p = await open(ctx, FIX);
    // ── classifier units ──
    const u = await p.evaluate(() => {
      const A = TDC.vehicleAttrs, solid = (rgb) => { const d = new Uint8ClampedArray(32 * 32 * 4); for (let i = 0; i < d.length; i += 4) { const n = ((i * 7919) % 13) - 6; d[i] = rgb[0] + n; d[i + 1] = rgb[1] + n; d[i + 2] = rgb[2] + n; d[i + 3] = 255; } return A.colorFromPixels(d, 32, 32).name; };
      return { dimWarmGrey: solid([95, 85, 70]), brown: solid([110, 70, 40]), beige: solid([225, 205, 170]), red: solid([180, 30, 35]), blue: solid([35, 60, 170]), white: solid([235, 235, 232]), silver: solid([160, 162, 166]),
        warmWhiteRaw: solid([200, 150, 90]), warmWhiteFixed: (() => { const g = TDC.wb.classifyGains([230, 172, 104]); const d = new Uint8ClampedArray(32 * 32 * 4); for (let i = 0; i < d.length; i += 4) { d[i] = 200; d[i + 1] = 150; d[i + 2] = 90; d[i + 3] = 255; } return A.colorFromPixels(d, 32, 32, { gains: g, night: true }).name; })() };
    });
    ok(tag + ": classifier: dim warm grey → gray (chroma vs lightness in CIELAB); brown, beige, red, blue, white, silver unchanged; a warm-lit white → beige/orange raw, white after full correction",
      u.dimWarmGrey === "gray" && u.brown === "brown" && u.beige === "beige" && u.red === "red" && u.blue === "blue" && u.white === "white" && u.silver === "silver" && u.warmWhiteRaw !== "white" && u.warmWhiteFixed === "white", u);
    const st0 = await p.evaluate(() => ({ viewerOn: TDC.wb.isOn(), mode: TDC.wb.colourMode(), sel: !!document.getElementById("wbColour") }));
    ok(tag + ": setting 'Colour search uses white balance' exists, default auto; the viewer's White balance toggle is OFF", st0.mode === "auto" && st0.sel && !st0.viewerOn, st0);
    // ── per vehicle: before / after ──
    const c = await colours(p);
    console.log("  colours " + tag + ": " + c.map((x) => x.name + ": raw " + x.raw + " → " + x.after + " (" + x.K + " K)").join(" | "));
    const by = Object.fromEntries(c.map((x) => [x.name, x]));
    ok(tag + ": white point found from the mirrors (viewer toggle off), ~3000 K (2600–3500)", c.every((x) => x.K >= 2600 && x.K <= 3500), c.map((x) => [x.K, x.src, x.gains]));
    ok(tag + ": white bus under 3000 K: raw is NOT white (brown / beige / orange), corrected → white", by["white bus"].raw !== "white" && by["white bus"].after === "white", by["white bus"]);
    ok(tag + ": red car stays red, blue bus stays blue, brown car stays brown after the correction", by["red car"].after === "red" && by["blue bus"].after === "blue" && by["brown car"].after === "brown", c);
    // ── search ──
    let r = await find(p, "white bus");
    const wb = r.hits.filter((h) => h.t <= 2.6);
    ok(tag + ": search 'white bus' finds the bus (0–2 s) labelled 'color white (corrected for NNNN K light)'", wb.length > 0 && wb.some((h) => /color white \(corrected for \d{4} K light\)/.test(h.text)) && !r.hits.some((h) => h.t > 4.4 && h.t < 6.2 && h.color === "blue" && h.best), r.hits.slice(0, 4));
    const before = wb[0] ? wb[0].raw : null;
    r = await find(p, "brown car");
    ok(tag + ": search 'brown car' finds the brown car (6–8 s), not the white bus", r.hits.some((h) => h.t >= 5.4 && /color brown/.test(h.text)) && !r.hits.some((h) => h.t < 2.2 && h.best), r.hits.slice(0, 4));
    // ── setting off: raw colours again (index re-judged) ──
    await p.evaluate(() => { TDC.wb.setCfg({ colour: "off" }); TDC.vehicle.colourModeChanged(); });
    r = await find(p, "white bus");
    const idx = await p.evaluate(() => { const rec = TDC.vehicle.mem.get(TDC.player.ev.id); return Object.entries(rec.frames).filter(([k]) => /^front\|(0\.|1\.)/.test(k)).flatMap(([k, ds]) => ds.filter((d) => d.label === "bus" && d.color).map((d) => ({ k, color: d.color, wbK: d.wbK || null }))); });
    const busOff = idx[0];
    ok(tag + ": setting off → the same bus is judged on raw pixels again (" + (busOff && busOff.color) + "), no white bus found, no 'corrected'", idx.length > 0 && idx.every((d) => d.color !== "white" && !d.wbK) && !r.hits.some((h) => h.t <= 2.6 && h.color === "white") && !r.hits.some((h) => /corrected/.test(h.text)), { idx, hits: r.hits.slice(0, 3) });
    // ── an old index entry (version 1: raw colour) is judged again ──
    await p.evaluate(() => { TDC.wb.setCfg({ colour: "auto" }); const id = TDC.player.ev.id, rec = TDC.vehicle.mem.get(id); delete rec.cver; delete rec.cwb; for (const k of Object.keys(rec.frames)) for (const d of rec.frames[k]) { d.color = "brown"; delete d.wbK; } });
    r = await find(p, "white bus");
    ok(tag + ": old index entries (raw colours, no version) are judged again: 'white bus' found, corrected", r.hits.some((h) => h.t <= 2.6 && h.color === "white" && h.K > 0), r.hits.slice(0, 3));
    console.log("  label " + tag + ": before (raw) bus colour = " + before + " (setting off: " + (busOff && busOff.color) + ") →  after: " + ((r.hits.find((h) => h.t <= 2.6) || {}).text));
    // ── live label ──
    const live = await p.evaluate(async () => {
      const D = TDC.detect; D.setPref ? D.setPref("live", true) : null; const pr = D.prefs(); localStorage.setItem("tdc.detect.v1", JSON.stringify({ ...pr, live: true, liveCams: "all" }));
      await D.load(); TDC.search.clear && TDC.search.clear(); await TDC.player.seek(0.3);
      TDC.wb.whiteAt(0.5); await new Promise((r) => setTimeout(r, 600));
      const seen = []; TDC.player.play(); const until = performance.now() + 2500;
      while (performance.now() < until) { await new Promise((r) => setTimeout(r, 150)); const l = D.live.front; if (l) for (const d of l.dets) if (d.label === "bus" && d.attr) seen.push(d.attr + "|" + (d.attrWbK || "")); }
      TDC.player.pause(); return seen;
    });
    ok(tag + ": live label while playing reads 'white' for the bus (colour after the white point)", live.some((s) => /^white/.test(s)) && live.filter((s) => /^white/.test(s)).length >= live.length / 2, live.slice(0, 8));
    // ── YOLO input untouched: detectImage gets the raw frame (same detections with the setting on / off) ──
    const yolo = await p.evaluate(async () => { const run = async () => { const v = await TDC.detect.frameAt("front", 1.0); return (await TDC.detect.detectImage(v, v.videoWidth, v.videoHeight, { conf: 0.25 })).map((d) => d.label + Math.round(d.conf * 100)).join(","); };
      TDC.player.pause(); await run(); TDC.wb.setCfg({ colour: "off" }); const a = await run(); TDC.wb.setCfg({ colour: "auto" }); await TDC.wb.colourFix(1.0); const b = await run(); return { a, b }; });
    ok(tag + ": detector input is the raw frame (identical detections, setting off vs auto)", yolo.a === yolo.b && /bus/.test(yolo.a), yolo);
    // ── no white point ──
    p = await open(ctx, NOP);
    const n = await colours(p);
    ok(tag + ": no car body in the mirrors → no white point → raw colours (white bus stays " + n[0].raw + ")", n.every((x) => x.K == null && x.after == null), n);
    r = await find(p, "bus");
    ok(tag + ": …and no 'corrected' in the labels", r.hits.length > 0 && !r.hits.some((h) => /corrected/.test(h.text)), r.hits.slice(0, 3));
    // ── daylight reference (no cast): what the classifier says for these vehicles in daylight ──
    p = await open(ctx, DAY);
    const d = await colours(p);
    console.log("  daylight " + tag + ": " + d.map((x) => x.name + ": " + x.raw).join(" | "));
    ok(tag + ": daylight reference (informative): the same vehicles without the cast give no white point (no mirror cameras) and are judged raw", d.every((x) => x.K == null), d);
    const errs = ctx.pages().flatMap((x) => x.errs || []);
    ok(tag + ": no page errors", errs.length === 0, errs.slice(0, 3));
    await b.close();
  }
  console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
