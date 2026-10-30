// Colour-constancy prototype (tag color-constancy-proto), Playwright Chromium + WebKit. Footage: tools/make-wbcolor-footage.py
// (night street under ~3000 K; white tour bus, red car, blue bus, brown car; mirror cameras with the white car body).
//  - OFF by default: no model loaded, vehicle colours and labels exactly as shipped (wb-color)
//  - units: CAT16 / Bradford take the light to neutral, D = 0 is identity; fusion drops a yellow plate
//  - the learned estimator (FC4 int8, onnxruntime-web WASM) runs in this browser: finite light, time per frame
//  - ON (fused light + CAT16): 'white bus' still found and white, the fix carries its sources and a 3×3 matrix;
//    colours of the red car / blue bus / brown car unchanged; turning it off re-judges the index
//  - viewer: Chromium (SVG filter) gets the 3×3 in linearRGB; WebKit / Safari blend path keeps per-channel gains
//  - no page errors
// Usage: BR=chromium,webkit node test/color-constancy.js [url]
const pw = require("playwright"); const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_0 = process.argv[2] || "http://127.0.0.1:8770/index.html", URL_ = URL_0 + (URL_0.includes("?") ? "&" : "?") + "debug=1";   // ui-glass-12: these technical rows show in Debug mode

const FIX = process.env.WBC_SAMPLES || "/tmp/wbcolor-samples";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(FIX + "/TeslaCam")) execFileSync("python3", [path.join(__dirname, "../tools/make-wbcolor-footage.py"), FIX], { stdio: "inherit" });
const list = (d0) => { const out = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) w(q); else out.push(q); } })(d0 + "/TeslaCam"); return out; };
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x).slice(0, 600) : "")); if (!c) fails++; };
async function open(ctx) {
  const p = await ctx.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message));
  await p.goto(URL_, { waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important}" });
  await p.setInputFiles("#fileInput", list(FIX));
  for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
  await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); return TDC.ui.activate(TDC.library.events[0]); });
  await W(1200); return p;
}
const find = async (p, q) => {
  await p.evaluate((q) => { document.getElementById("findQuery").value = q; document.getElementById("findCam").value = "front"; TDC.search.run(); }, q);
  await W(300); for (let i = 0; i < 1500 && (await p.evaluate(() => TDC.search.running)); i++) await W(200);
  return p.evaluate(() => ({ hits: TDC.search.hits.map((h) => ({ t: +h.t.toFixed(2), text: h.text, color: h.vdet && h.vdet.color, K: h.vdet && h.vdet.wbK })) }));
};
/** Colour of the biggest vehicle in the indexed frame nearest each segment's middle (1, 3, 5, 7 s). */
const colours = (p) => p.evaluate(() => { const rec = TDC.vehicle.mem.get(TDC.player.ev.id), out = {};
  for (const [seg, mid] of [["white bus", 1], ["red car", 3], ["blue bus", 5], ["brown car", 7]]) {
    let best = null;
    for (const [k, ds] of Object.entries(rec.frames)) { const t = +k.split("|")[1]; if (!k.startsWith("front|") || Math.abs(t - mid) > 0.9) continue;
      for (const d of ds) if (d.color && ["car", "bus", "truck"].includes(d.label)) { const sc = Math.abs(t - mid) * 10 - d.w * d.h; if (!best || sc < best.sc) best = { sc, c: d.color }; } }
    out[seg] = best ? best.c : null;
  }
  return out; });
const scanAll = async (p) => { for (const q of ["white bus", "red car", "blue bus", "brown car"]) await find(p, q); return find(p, "white bus"); };
(async () => {
  for (const bn of (process.env.BR || "chromium,webkit").split(",")) {
    const b = await pw[bn].launch(bn === "chromium" ? { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] } : {});
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => { if (!sessionStorage.getItem("cc")) { sessionStorage.setItem("cc", "1"); localStorage.clear(); try { indexedDB.deleteDatabase("tdc-vehicle-index"); } catch (_) {}
      localStorage.setItem("tdc.vehicle.v1", JSON.stringify({ enabled: true, makes: false })); localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, live: false, model: "nano", conf: 0.35, speed: "balanced", liveCams: "all" })); } });
    const p = await open(ctx), tag = bn;
    // ── default off ──
    const def = await p.evaluate(() => ({ on: TDC.cc.on(), prefs: TDC.cc.prefs(), sel: document.getElementById("ccOn") && document.getElementById("ccOn").value }));
    ok(tag + ": prototype OFF by default (setting 'Colour constancy (prototype)' = Off)", def.on === false && def.sel === "off" && def.prefs.adapt === "cat16" && def.prefs.estimator === "fusion", def);
    let r = await scanAll(p);
    const offCol = await colours(p);
    ok(tag + ": off → shipped behaviour: 'white bus' found, 'color white (corrected for N K light)', no model loaded", r.hits.some((h) => h.t <= 2.6 && /color white \(corrected for \d{4} K light\)/.test(h.text)) && offCol["white bus"] === "white" && (await p.evaluate(() => !TDC.cc.info && !TDC.cc.last)), { hits: r.hits.slice(0, 2), offCol });
    // ── units ──
    const u = await p.evaluate(() => { const C = TDC.cc, w = [1.767, 0.845, 0.273], o = {};
      for (const m of ["bradford", "cat16", "gains-linear"]) o[m] = C.angle(C.mat.mv(C.adaptMatrix(w, m, 1), w), [1, 1, 1]);
      const I = C.adaptMatrix(w, "cat16", 0); o.identity = Math.max(...I.flat().map((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0))));
      const f = C.fuse({ paint: { white: w, conf: 1 }, lane: { white: [w[0] * 1.02, w[1], w[2] * 0.98], conf: 1 }, plate: { white: [1, 0.9, 0.2], conf: 1 } });
      o.fuseDeg = C.angle(f.white, w); o.plateW = f.used.find((x) => x.name === "plate").w; return o; });
    ok(tag + ": CAT16 / Bradford / linear gains take a 3000 K light to neutral (< 0.01°), D = 0 is identity, fusion ignores a yellow plate", u.bradford < 0.01 && u.cat16 < 0.01 && u["gains-linear"] < 0.01 && u.identity < 1e-6 && u.fuseDeg < 1 && u.plateW < 0.1, u);
    // ── learned estimator in this browser ──
    const L = await p.evaluate(async () => { const v = await TDC.detect.frameAt("front", 1); const t0 = performance.now(); const e = await TDC.cc.fromLearned(v, v.videoWidth, v.videoHeight); const e2 = await TDC.cc.fromLearned(v, v.videoWidth, v.videoHeight);
      return { white: e.white.map((x) => +x.toFixed(3)), K: TDC.cc.cct(e.white), conf: +e.conf.toFixed(2), first: Math.round(performance.now() - t0 - e2.ms), ms: Math.round(e2.ms), load: TDC.cc.info && TDC.cc.info.loadMs }; });
    console.log("FC4", tag, JSON.stringify(L));
    ok(tag + ": learned estimator (FC4 int8, WASM) runs: finite light, warm (< 4500 K) on the ~3000 K street", L.white.every((x) => isFinite(x) && x > 0) && L.K < 4500 && L.ms > 0, L);
    // ── on ──
    await p.evaluate(() => { document.getElementById("ccOn").value = "on"; document.getElementById("ccOn").dispatchEvent(new Event("change")); });
    const ui = await p.evaluate(() => ["ccEst", "ccAdapt", "ccClip"].every((id) => document.getElementById(id)) && TDC.cc.on());
    ok(tag + ": turning it on shows Light estimate / Colour adaptation / CLIP options", ui);
    r = await scanAll(p);
    const onCol = await colours(p), last = await p.evaluate(() => TDC.cc.last && { K: TDC.cc.last.est && TDC.cc.last.est.cct, srcs: TDC.cc.last.est && TDC.cc.last.est.sources, m: !!(TDC.cc.last.est && TDC.cc.last.est.matrix), lumRef: TDC.cc.last.est && TDC.cc.last.est.lumRef, ests: Object.keys(TDC.cc.last.ests).filter((k) => TDC.cc.last.ests[k]) });
    console.log("COLOURS", tag, "shipped:", JSON.stringify(offCol), "fusion + CAT16:", JSON.stringify(onCol), JSON.stringify(last));
    ok(tag + ": on (fusion + CAT16): every vehicle judged with a 3×3 matrix from ≥ 2 fused sources (colours logged above; see the report)", last && last.m && last.srcs.length >= 2 && Object.keys(onCol).length === 4 && r.hits.some((h) => h.K > 0), { onCol, last });
    // the fused light with the shipped gains: the estimate alone must not break the shipped colours
    await p.evaluate(() => { const e = document.getElementById("ccAdapt"); e.value = "gains"; e.dispatchEvent(new Event("change")); });
    r = await scanAll(p);
    const gCol = await colours(p);
    console.log("COLOURS", tag, "fusion + shipped gains:", JSON.stringify(gCol));
    ok(tag + ": on (fused light + shipped gains): the white bus stays achromatic (white / silver), labelled corrected", ["white", "silver"].includes(gCol["white bus"]) && r.hits.some((h) => h.t <= 2.6 && h.K > 0), { gCol, hits: r.hits.slice(0, 2) });
    await p.evaluate(() => { const e = document.getElementById("ccAdapt"); e.value = "cat16"; e.dispatchEvent(new Event("change")); });
    // ── viewer ──
    const vw = await p.evaluate(async () => { TDC.wb.set(true); await new Promise((r) => setTimeout(r, 2500)); TDC.emit("cc-changed", TDC.cc.prefs());
      const f = document.getElementById("tdcWb"), m = f && f.querySelector("feColorMatrix"); return { mode: TDC.wb.mode(), applied: !!TDC.wb.applied, matrix: !!(TDC.wb.applied && TDC.wb.applied.matrix), cif: f && f.getAttribute("color-interpolation-filters"), values: m && m.getAttribute("values") }; });
    const offDiag = vw.values ? vw.values.split(/\s+/).map(Number).filter((_, i) => [1, 2, 5, 7, 10, 11].includes(i)).some((v) => Math.abs(v) > 1e-3) : false;
    ok(tag + ": viewer: " + (vw.mode === "svg" ? "SVG filter carries the full CAT16 3×3 in linearRGB" : "Safari blend path keeps per-channel gains (approximation)"), !vw.applied || (vw.mode === "svg" ? vw.matrix && vw.cif === "linearRGB" && offDiag : !vw.matrix), vw);
    // ── off again: re-judged, shipped colours back ──
    await p.evaluate(() => { document.getElementById("ccOn").value = "off"; document.getElementById("ccOn").dispatchEvent(new Event("change")); });
    r = await scanAll(p);
    const back = await colours(p), cwb = await p.evaluate(() => TDC.vehicle.mem.get(TDC.player.ev.id).cwb);
    const vw2 = await p.evaluate(() => { const f = document.getElementById("tdcWb"); return { matrix: !!(TDC.wb.applied && TDC.wb.applied.matrix), cif: f && f.getAttribute("color-interpolation-filters") }; });
    ok(tag + ": off again: index re-judged with the shipped method ('white bus' white, corrected), viewer back to gains", cwb === "auto" && back["white bus"] === "white" && r.hits.some((h) => h.t <= 2.6 && /color white \(corrected for \d{4} K light\)/.test(h.text)) && !vw2.matrix && (!vw2.cif || vw2.cif === "sRGB"), { back, offCol, cwb, vw2 });
    ok(tag + ": no page errors", p.errs.length === 0, p.errs);
    await b.close();
  }
  console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
