// Highlight / Redact switches for search matches (tag redact-toggle). Playwright Chromium + WebKit.
// Footage: tools/make-moving-footage.py (synthetic bus moving across the front camera; truth.json has its box per frame).
//   U  UI: "Matches · Highlight · Redact" in the search panel (and the classic Find bar), Highlight = Boxes button / X,
//      Redact saved (off by default), R key, kept after a reload
//   M  the 4 modes (highlight only, redact only, both, none) on injected results (the bus box from truth.json):
//      viewer: blur layer (luminance spread in the bus vs the raw frame) and outline layer (opaque pixels on the box edge);
//      export: the frames the exporter encodes (compositor.drawFrame) — blur and outline the same way, also with
//      "Burn detection boxes" unticked (redaction is always burned in)
//   P  per term ("bus, sign"): chip buttons set redact / highlight for one term; viewer + export follow; a switch resets them
//   A  "Blur text / plates / faces" results: the panel's Show blur button toggles them (viewer + export)
//   R  real YOLO search "bus" (REAL=1, Chromium): redact only → the bus is blurred in an exported frame, no outline
// Usage: NODE_PATH=… node test/redact-toggle.js [url]   (BR=chromium,webkit  PHASES=U,M,P,A,R)
const pw = require("playwright"); const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const PH = (process.env.PHASES || "U,M,P,A" + (process.env.REAL ? ",R" : "")).split(",");
const FIX = process.env.MOVING_SAMPLES || "/tmp/moving-samples";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(FIX + "/truth.json")) execFileSync("python3", [path.join(__dirname, "../tools/make-moving-footage.py"), FIX], { stdio: "inherit" });
const TRUTH = JSON.parse(fs.readFileSync(FIX + "/truth.json", "utf8"));
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) w(q); else files.push(q); } })(FIX + "/TeslaCam");
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x).slice(0, 600) : "")); if (!c) fails++; };
const T0 = 1.5;   // the moment measured
const busAt = (t) => { const a = TRUTH.front; let b = a[0]; for (const x of a) if (Math.abs(x.t - t) < Math.abs(b.t - t)) b = x; return { x: b.x, y: b.y, w: b.w, h: b.h }; };
const SIGN = { x: 0.62, y: 0.08, w: 0.2, h: 0.14 };   // a second, still "term" box (sky area) for the per-term phase

async function open(p) {
  await p.goto(URL_, { waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important}" });
  await p.setInputFiles("#fileInput", files);
  for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
  await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); return TDC.ui.activate(TDC.library.events[0]); });
  await W(1200);
}
/** Results without running a model: the bus box (truth.json, every 0.25 s) as a detector result; with terms → "bus, sign". */
const inject = (p, multi) => p.evaluate(([bus, sign, multi]) => {
  const S = TDC.search, hits = [];
  for (const h of bus) hits.push({ t: h.t, cam: "front", box: h.box, det: true, label: "bus", cls: "bus", conf: 0.9, score: 0.9, ...(multi ? { ti: 0, term: "bus", termColor: "#4fc3f7", termKind: "det" } : {}) });
  if (multi) for (let t = 0; t <= 4; t += 0.5) hits.push({ t, cam: "front", box: sign, det: true, label: "stop sign", cls: "stop sign", conf: 0.8, score: 0.8, ti: 1, term: "sign", termColor: "#f06292", termKind: "det" });
  hits.sort((a, b) => a.t - b.t);
  S.allHits = hits; S.hits = hits.slice(); S.phrase = multi ? "bus, sign" : "bus"; S.anchor = null; S.openedHit = null;
  S.terms = multi ? [{ term: "bus", i: 0, color: "#4fc3f7", kind: "det" }, { term: "sign", i: 1, color: "#f06292", kind: "det" }] : null; S.termFilter = null;
  S.renderHits(); S.paintBoxes(); if (TDC.searchUI && TDC.searchUI.refresh) TDC.searchUI.refresh();
}, [[0, T0, 3.0, 4.5].map((t) => ({ t, box: busAt(t) })), SIGN, !!multi]);
const setMode = (p, hl, rd) => p.evaluate(([hl, rd]) => { TDC.search.setHighlight(hl); TDC.search.setRedact(rd); }, [hl, rd]);

/** One measurement page-side. region r (normalised): spread of luminance inside (blur) and count of outline-coloured pixels
 *  on a ring around it, in (a) the viewer's layers, (b) one exported frame (the exporter's own drawFrame call). */
const MEASURE = `(async ([t, regions, burnBoxes, doExport]) => {
  const T = TDC, P = T.player; P.pause(); await P.seek(t); await new Promise((r) => setTimeout(r, 600)); T.emit("layout"); T.emit("time"); await new Promise((r) => setTimeout(r, 300));
  const tile = P.tiles.front, video = tile.vids[P.active], vw = video.videoWidth, vh = video.videoHeight;
  const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  // detail = mean luminance step between neighbouring pixels (high frequencies: text, edges); blur removes it, big shapes don't count
  const spread = (im) => { const d = im.data, w = im.width, h = im.height; let s = 0, n = 0, op = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (d[i + 3] < 200) continue; op++;
      if (x + 1 < w && d[i + 7] >= 200) { s += Math.abs(lum(d, i) - lum(d, i + 4)); n++; } if (y + 1 < h && d[i + w * 4 + 3] >= 200) { s += Math.abs(lum(d, i) - lum(d, i + w * 4)); n++; } }
    return op < 20 || !n ? -1 : Math.round((s / n) * 100) / 100; };
  const inner = (b) => ({ x: b.x + b.w * 0.15, y: b.y + b.h * 0.2, w: b.w * 0.7, h: b.h * 0.6 });
  const near = (d, i, cols) => cols.some((c) => Math.abs(d[i] - c[0]) < 40 && Math.abs(d[i + 1] - c[1]) < 40 && Math.abs(d[i + 2] - c[2]) < 40);
  const COLS = [[230, 180, 80], [79, 195, 247], [240, 98, 146]];
  const ringCount = (x, fit, b, opaqueOnly) => {   // pixels on the box edge band (±4 px) in outline colours (or any opaque pixel on a layer)
    const x0 = Math.round(fit.x + b.x * fit.w) - 4, y0 = Math.round(fit.y + b.y * fit.h) - 4, w = Math.round(b.w * fit.w) + 8, h = Math.round(b.h * fit.h) + 8;
    const d = x.getImageData(x0, y0, w, h).data; let n = 0;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) { if (xx > 8 && xx < w - 9 && yy > 8 && yy < h - 9) continue; const i = (yy * w + xx) * 4; if (opaqueOnly ? d[i + 3] > 200 : near(d, i, COLS)) n++; }
    return n;
  };
  const fitIn = (W, H) => { const s = Math.min(W / vw, H / vh); return { x: (W - vw * s) / 2, y: (H - vh * s) / 2, w: vw * s, h: vh * s }; };
  const rc = document.createElement("canvas"); rc.width = vw; rc.height = vh; const rx = rc.getContext("2d", { willReadFrequently: true }); rx.drawImage(video, 0, 0);
  const out = { regions: {} };
  const rl = tile.tile.querySelector(".redact-layer"), fl = tile.tile.querySelector(".find-layer");
  for (const [k, b] of Object.entries(regions)) {
    const i = inner(b), o = { raw: spread(rx.getImageData(i.x * vw, i.y * vh, i.w * vw, i.h * vh)) };
    if (rl) { const f = fitIn(rl.width, rl.height); o.viewBlur = spread(rl.getContext("2d").getImageData(f.x + i.x * f.w, f.y + i.y * f.h, Math.max(1, i.w * f.w), Math.max(1, i.h * f.h))); }
    if (fl) { const f = fitIn(fl.width, fl.height); o.viewOutline = ringCount(fl.getContext("2d"), f, b, true); }
    out.regions[k] = o;
  }
  out.viewAt = T.burnBoxes.at("front", t).length; out.viewRedact = T.burnBoxes.redactAt("front", t).length;
  if (!doExport) return out;
  // a real export of a short range; the frame nearest t is measured as the exporter drew it (before encoding)
  const C = T.compositor, df = C.drawFrame; let best = null;
  C.drawFrame = function (ctx, geo, ft, frames, show) {
    const r = df.apply(this, arguments);
    try { if (!best || Math.abs(ft - t) < Math.abs(best.t - t)) {
      const ci = T.GRID.indexOf("front"), cell = C.cellRect(geo.grid, ci, 0), fr = frames.front; if (!fr) return r;
      const s = Math.min(cell.w / fr.w, cell.h / fr.h), fit = { x: cell.x + (cell.w - fr.w * s) / 2, y: cell.y + (cell.h - fr.h * s) / 2, w: fr.w * s, h: fr.h * s };
      const res = {};
      for (const [k, b] of Object.entries(regions)) { const i = inner(b); res[k] = { blur: spread(ctx.getImageData(fit.x + i.x * fit.w, fit.y + i.y * fit.h, Math.max(1, i.w * fit.w), Math.max(1, i.h * fit.h))), outline: ringCount(ctx, fit, b, false) }; }
      best = { t: ft, res };
    } } catch (e) { best = { t: ft, err: String(e) }; }
    return r;
  };
  let err = null;
  try { await T.exporter.run({ preset: "compat", ranges: [[t - 0.4, t + 0.4]], show: { ...T.prefs.show, labels: false, hud: false, map: false, fsd: false, time: false, boxes: burnBoxes }, onStatus: () => {}, onProgress: () => {} }); }
  catch (e) { err = String(e.message || e); } finally { C.drawFrame = df; }
  out.export = best; out.exportErr = err;
  return out;
})`;
const measure = (p, regions, burnBoxes, doExport) => p.evaluate(MEASURE + "(" + JSON.stringify([T0, regions, burnBoxes, doExport]) + ")");
const ui = (p) => p.evaluate(() => { const g = (id) => { const b = document.getElementById(id); return b ? { pressed: b.getAttribute("aria-pressed"), visible: !!(b.offsetParent && b.getBoundingClientRect().width > 0), text: b.textContent.trim() } : null; };
  return { usHl: g("usHl"), usRd: g("usRd"), findHl: g("findHl"), findRd: g("findRd"), boxes: g("btnBoxes"), gold: document.getElementById("findShow").checked, savedRd: localStorage.getItem("tdc.results.redact"), savedBoxes: localStorage.getItem("tdc.boxes.v1"), name: TDC.search.styleName(null) }; });

(async () => {
  for (const bn of (process.env.BR || "chromium,webkit").split(",")) {
    const b = await pw[bn].launch(bn === "chromium" ? { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] } : {});
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => { if (!sessionStorage.getItem("rt")) { sessionStorage.setItem("rt", "1"); localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false, live: false })); localStorage.setItem("tdc.export.burnBoxes", "1"); localStorage.removeItem("tdc.boxes.v1"); localStorage.removeItem("tdc.results.redact"); } });
    const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
    await open(p); const tag = bn;
    const BUS = busAt(T0);

    if (PH.includes("U")) {
      await p.evaluate(() => TDC.searchUI && TDC.searchUI.show && TDC.searchUI.show()); await W(400);
      let s = await ui(p);
      ok(tag + ": U panel shows 'Highlight' (on) and 'Redact' (off) by default", s.usHl && s.usHl.visible && s.usHl.pressed === "true" && /Highlight/.test(s.usHl.text) && s.usRd && s.usRd.visible && s.usRd.pressed === "false" && /Redact/.test(s.usRd.text) && s.name === "highlight", s);
      await p.click("#usRd"); s = await ui(p);
      ok(tag + ": U tapping Redact turns it on (saved), mode = both", s.usRd.pressed === "true" && s.findRd.pressed === "true" && s.savedRd === "1" && s.name === "both", s);
      await p.click("#usHl"); s = await ui(p);
      ok(tag + ": U tapping Highlight turns it off = the Boxes button / Gold box state, mode = redact", s.usHl.pressed === "false" && s.boxes.pressed === "false" && !s.gold && s.savedBoxes === "0" && s.name === "redact", s);
      await p.evaluate(() => document.activeElement && document.activeElement.blur()); await p.keyboard.press("x"); s = await ui(p);
      ok(tag + ": U X turns Highlight back on (both switches follow)", s.usHl.pressed === "true" && s.findHl.pressed === "true" && s.boxes.pressed === "true", s);
      await p.keyboard.press("r"); s = await ui(p);
      ok(tag + ": U R turns Redact off, mode = highlight", s.usRd.pressed === "false" && s.savedRd === null && s.name === "highlight", s);
      await p.keyboard.press("r"); await p.keyboard.press("x");
      await open(p); await p.evaluate(() => TDC.searchUI && TDC.searchUI.show && TDC.searchUI.show()); await W(300); s = await ui(p);
      ok(tag + ": U Redact on + Highlight off are kept after a reload", s.usRd.pressed === "true" && s.usHl.pressed === "false" && s.name === "redact", s);
      await p.evaluate(() => { TDC.search.setHighlight(true); TDC.search.setRedact(false); });
    }

    if (PH.includes("M")) {
      await inject(p, false);
      const modes = [["none", false, false], ["highlight", true, false], ["redact", false, true], ["both", true, true]];
      const R = {};
      for (const [name, hl, rd] of modes) { await setMode(p, hl, rd); R[name] = await measure(p, { bus: BUS }, true, true); R[name].name = await p.evaluate(() => TDC.search.styleName(null)); }
      console.log("MODES", JSON.stringify(Object.fromEntries(Object.entries(R).map(([k, v]) => [k, { raw: v.regions.bus.raw, viewBlur: v.regions.bus.viewBlur, viewOutline: v.regions.bus.viewOutline, exp: v.export && v.export.res && v.export.res.bus, expT: v.export && v.export.t, err: v.exportErr }]))));
      const raw = R.none.regions.bus.raw, base = R.none.export.res.bus;
      ok(tag + ": M footage has detail in the bus (raw detail > 2)", raw > 2, { raw });
      for (const [name, hl, rd] of modes) {
        const v = R[name].regions.bus, e = R[name].export && R[name].export.res && R[name].export.res.bus;
        ok(tag + ": M " + name + ": mode name", R[name].name === name, R[name].name);
        ok(tag + ": M " + name + ": viewer blur " + (rd ? "present (spread < 45% of raw)" : "absent (layer empty)"), rd ? v.viewBlur >= 0 && v.viewBlur < raw * 0.45 : v.viewBlur === -1, v);
        ok(tag + ": M " + name + ": viewer outline " + (hl ? "present" : "absent"), hl ? v.viewOutline > 50 : v.viewOutline === 0, v);
        ok(tag + ": M " + name + ": export frame blur " + (rd ? "burned in (spread < 45% of the plain export)" : "absent (≈ plain export)"), !!e && (rd ? e.blur < base.blur * 0.45 : Math.abs(e.blur - base.blur) <= Math.max(0.3, base.blur * 0.08)), { e, base, err: R[name].exportErr });
        ok(tag + ": M " + name + ": export frame outline " + (hl ? "burned in" : "absent"), !!e && (hl ? e.outline > base.outline + 50 : e.outline <= base.outline + 10), { e, base });
      }
      // redaction is burned in even with "Burn detection boxes" unticked; the outline is not
      await setMode(p, true, true);
      const nb = await measure(p, { bus: BUS }, false, true), e = nb.export && nb.export.res && nb.export.res.bus;
      ok(tag + ": M both + 'Burn detection boxes' unticked: export still blurred, no outline", !!e && e.blur < base.blur * 0.45 && e.outline <= base.outline + 10, { e, base });
      // the Safari path: no canvas filter → the shrink/enlarge blur is used everywhere for matches; check it in Chromium too
      const sb = await p.evaluate(() => { TDC.redact.forceSoftBlur = true; return TDC.redact.canvasFilter(); });
      const soft = await measure(p, { bus: BUS }, true, true); await p.evaluate(() => { TDC.redact.forceSoftBlur = false; });
      ok(tag + ": M blur works with the no-canvas-filter fallback (Safari path; canvas filter here: " + sb + ")", soft.export.res.bus.blur < base.blur * 0.45 && soft.regions.bus.viewBlur < raw * 0.45, soft.export.res.bus);
      await setMode(p, true, false);
    }

    if (PH.includes("P")) {
      await inject(p, true);
      await p.evaluate(() => TDC.searchUI && TDC.searchUI.show && TDC.searchUI.show()); await W(300);
      const chips = await p.evaluate(() => [...document.querySelectorAll("#usChips .term-mode")].map((b) => ({ ti: b.dataset.ti, m: b.dataset.m, pressed: b.getAttribute("aria-pressed"), vis: b.getBoundingClientRect().width > 0 })));
      ok(tag + ": P every term chip has a highlight and a redact button (visible), reflecting the switches", chips.length === 4 && chips.every((c) => c.vis) && chips.filter((c) => c.m === "hl").every((c) => c.pressed === "true") && chips.filter((c) => c.m === "rd").every((c) => c.pressed === "false"), chips);
      // bus: redact, not highlighted; sign: highlighted, not redacted
      await p.click('#usChips .term-mode[data-ti="0"][data-m="rd"]'); await p.click('#usChips .term-mode[data-ti="0"][data-m="hl"]');
      const pm = await p.evaluate(() => ({ bus: TDC.search.styleName(0), sign: TDC.search.styleName(1), filter: TDC.search.termFilter }));
      ok(tag + ": P clicking the bus's buttons → bus = redact, sign = highlight; the chip filter is untouched", pm.bus === "redact" && pm.sign === "highlight" && pm.filter == null, pm);
      const m = await measure(p, { bus: BUS, sign: SIGN }, true, true);
      const e = m.export && m.export.res;
      console.log("PER-TERM", JSON.stringify({ view: m.regions, exp: e }));
      ok(tag + ": P viewer: bus blurred without outline, sign outlined without blur", m.regions.bus.viewBlur >= 0 && m.regions.bus.viewBlur < m.regions.bus.raw * 0.45 && m.regions.bus.viewOutline === 0 && m.regions.sign.viewOutline > 50 && m.regions.sign.viewBlur === -1, m.regions);
      ok(tag + ": P export: bus blurred without outline, sign outlined and sharp", !!e && e.bus.blur < m.regions.bus.raw * 0.5 && e.bus.outline < 300 && e.sign.outline > 600 && e.sign.blur > m.regions.sign.raw * 0.6, e);
      // the switch resets the per-term choice
      await p.click("#usRd"); const after = await p.evaluate(() => ({ bus: TDC.search.styleName(0), sign: TDC.search.styleName(1) }));
      ok(tag + ": P tapping the Redact switch applies it to every term (bus = redact, sign = both)", after.bus === "redact" && after.sign === "both", after);
      await p.click("#usHl"); await p.click("#usHl"); await p.click("#usRd");
      const reset = await p.evaluate(() => ({ bus: TDC.search.styleName(0), sign: TDC.search.styleName(1) }));
      ok(tag + ": P switches back → every term follows them again (highlight)", reset.bus === "highlight" && reset.sign === "highlight", reset);
      // a chip filter does not un-redact the other terms
      await p.evaluate(() => { TDC.search.setRedact(true); TDC.search.setTermFilter(1); });
      const fm = await measure(p, { bus: BUS }, true, false);
      ok(tag + ": P showing one term's results (chip filter) keeps the other term redacted", fm.regions.bus.viewBlur >= 0 && fm.regions.bus.viewBlur < fm.regions.bus.raw * 0.45, fm.regions.bus);
      await p.evaluate(() => { TDC.search.setTermFilter(null); TDC.search.setRedact(false); TDC.search.clear(); });
    }

    if (PH.includes("A")) {
      // a "Blur text"-style result (redact.js frames, here over the bus's lettering), injected: the panel's Show blur button
      // toggles it, the export follows
      await p.evaluate(([b]) => { const R = TDC.redact; R.frames = { front: [0, 0.5, 1, 1.5, 2, 2.5, 3].map((t) => ({ t, boxes: [b] })) }; R.step = 0.5; R.action = "blur"; R.active = true; R.eventId = TDC.player.ev.id; R.rebuild(); R.setShown(true); }, [BUS]);
      await p.evaluate(() => TDC.searchUI && TDC.searchUI.show && TDC.searchUI.show()); await W(200);
      const vis = await p.evaluate(() => { const b = document.getElementById("usRedactShow"); return { vis: !!(b && b.getBoundingClientRect().width > 0), pressed: b && b.getAttribute("aria-pressed") }; });
      ok(tag + ": A 'Show blur' appears in the search panel once something is blurred (pressed)", vis.vis && vis.pressed === "true", vis);
      const on = await measure(p, { bus: BUS }, false, true);
      await p.click("#usRedactShow");
      const off = await measure(p, { bus: BUS }, false, true);
      const st = await p.evaluate(() => ({ pressed: document.getElementById("usRedactShow").getAttribute("aria-pressed"), classic: document.getElementById("redactShow").checked }));
      console.log("APPLIED", JSON.stringify({ on: [on.regions.bus, on.export && on.export.res], off: [off.regions.bus, off.export && off.export.res] }));
      ok(tag + ": A on: blurred in the viewer and the export", on.regions.bus.viewBlur >= 0 && on.regions.bus.viewBlur < on.regions.bus.raw * 0.45 && on.export.res.bus.blur < off.export.res.bus.blur * 0.45, { on: on.export.res, off: off.export.res });
      ok(tag + ": A Show blur off (button + classic tick follow): sharp in the viewer and the export", st.pressed === "false" && !st.classic && off.regions.bus.viewBlur === -1 && off.export.res.bus.blur > on.regions.bus.raw * 0.8, { st, v: off.regions.bus, e: off.export.res });
      await p.evaluate(() => TDC.redact.clear());
    }

    if (PH.includes("R") && bn === "chromium") {
      await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, live: false, model: "nano", conf: 0.35 })); });
      await open(p);
      await p.evaluate(() => { TDC.search.setHighlight(false); TDC.search.setRedact(true); document.getElementById("findQuery").value = "bus"; document.getElementById("findCam").value = "front"; return TDC.search.run(); });
      for (let i = 0; i < 1500 && (await p.evaluate(() => TDC.search.running || !!TDC.search.pending)); i++) await W(200);
      const hits = await p.evaluate(() => TDC.search.hits.filter((h) => h.cam === "front" && h.box).length);
      const m = await measure(p, { bus: BUS }, true, true);
      ok(tag + ": R real 'bus' search, redact only: bus blurred in the viewer and the exported frame, no outline", hits > 0 && m.viewAt === 0 && m.viewRedact > 0 && m.regions.bus.viewBlur < m.regions.bus.raw * 0.6 && m.export.res.bus.blur < m.regions.bus.raw * 0.6 && m.export.res.bus.outline < 300, { hits, m });
    }

    ok(tag + ": no page errors", errs.length === 0, errs.slice(0, 3));
    await b.close();
  }
  console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
