// Vehicle details (beta) end to end, Playwright Chromium + WebKit, real models (YOLO11 + CLIP), synthetic event from
// tools/make-vehicle-footage.py (public-domain / CC0 photos pasted on the mock stills, plates blurred; written to /tmp).
//  - off by default: "red tour bus" is not taken over; plate phrases say how to turn plates on (no picture search)
//  - "red tour bus" / "city bus" / "white police car" (front), "ambulance" / "fire truck" (all cameras): right moment + label
//  - query chips, Best match, gold box on the tile, tracking, export burn-in label, phone strip label, live colour label
//  - repeat search reuses the vehicle index (IndexedDB) and is faster; graceful failure when CLIP can't load
// Usage: node test/vehicle-search.js [url] [shotDir]
const pw = require("playwright"); const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html", SHOTS = process.argv[3] || "";
const FIX = process.env.VEH_SAMPLES || "/tmp/vehicle-samples";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(FIX + "/TeslaCam")) execFileSync("python3", [path.join(__dirname, "../tools/make-vehicle-footage.py"), FIX], { stdio: "inherit" });
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) w(q); else files.push(q); } })(FIX + "/TeslaCam");
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x) : "")); if (!c) fails++; };
const inRange = (hits, a, b) => hits.length > 0 && hits.filter((h) => h.best).every((h) => h.t >= a - 0.6 && h.t <= b + 0.6);
async function open(ctx, vp) {
  const p = await ctx.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message));
  if (vp) await p.setViewportSize(vp);
  await p.goto(URL_, { waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important}" });
  await p.setInputFiles("#fileInput", files);
  for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
  await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); return TDC.ui.activate(TDC.library.events.find((e) => /15-30/.test(e.id)) || TDC.library.events[0]); });
  await W(1200);
  return p;
}
const find = async (p, q, cam) => {
  const t0 = Date.now();
  await p.evaluate(([q, cam]) => { document.getElementById("findQuery").value = q; document.getElementById("findCam").value = cam || "front"; TDC.search.run(); }, [q, cam]);
  await W(300);
  for (let i = 0; i < 1500 && (await p.evaluate(() => TDC.search.running)); i++) await W(200);
  const ms = Date.now() - t0;
  for (let i = 0; i < 150 && (await p.evaluate(() => /Following/.test(document.getElementById("findStatus").textContent))); i++) await W(200);   // gold-box tracking
  return p.evaluate((ms) => ({ ms, hits: TDC.search.hits.map((h) => ({ t: +h.t.toFixed(2), cam: h.cam, text: h.text, best: !!h.best, vehicle: !!h.vehicle, box: h.box })), all: (TDC.search.allHits || []).length, status: document.getElementById("findStatus").textContent,
    chips: [...document.querySelectorAll("#findChips .q-chip")].map((c) => c.textContent), last: TDC.vehicle.lastSearch }), ms);
};
(async () => {
  for (const bn of (process.env.BR || "chromium,webkit").split(",")) {
    const ctx = await pw[bn].launchPersistentContext("/tmp/tdc-veh-profile-" + bn, bn === "chromium" ? { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"], viewport: { width: 1440, height: 900 } } : { viewport: { width: 1440, height: 900 } });
    await ctx.route((u) => u.origin === new URL(URL_).origin, (r) => r.continue());   // routing turns off the HTTP cache: always test the current files
    await ctx.addInitScript(() => { try { if (!sessionStorage.getItem("veh-init")) { sessionStorage.setItem("veh-init", "1"); localStorage.removeItem("tdc.vehicle.v1"); localStorage.removeItem("tdc.plates.v1"); localStorage.removeItem("tdc.detect.v1"); indexedDB.deleteDatabase("tdc-vehicle-index"); } } catch (e) {} });
    let p = await open(ctx);
    const tag = bn;
    // ── defaults ──
    let r = await p.evaluate(() => ({ off: !TDC.vehicle.enabled(), makes: TDC.vehicle.prefs().makes, takes: TDC.vehicle.handlesQuery("red tour bus"), ui: !!document.getElementById("vehEnabled") }));
    ok(tag + " vehicle details off by default, settings toggle present", r.off && !r.makes && !r.takes && r.ui, r);
    r = await find(p, "blur the license plate");
    ok(tag + " 'blur the license plate' with plates off: says how to turn plates on, no picture search", /Plates & text/.test(r.status) && r.chips.includes("plate") && !r.hits.length, r);
    r = await find(p, "find plate 9DZM");
    ok(tag + " 'find plate 9DZM' with plates off: plate route, chip shows the pattern", /plate search/.test(r.status) && r.chips.includes("9DZM"), r.chips);
    // ── turn on ──
    await p.evaluate(() => { TDC.vehicle.setPref("enabled", true); });
    r = await find(p, "red tour bus");
    ok(tag + " 'red tour bus' → tour bus moment (0–2.6 s), front", inRange(r.hits, 0, 2.6) && r.hits.every((h) => h.cam === "front" && h.vehicle), r.hits.slice(0, 4));
    ok(tag + " label 'red tour bus · bus NN% · type NN% · color red · Best match'", r.hits.some((h) => /^red tour bus · bus \d+% · type \d+% · color red · Best match$/.test(h.text)), r.hits.map((h) => h.text).slice(0, 3));
    ok(tag + " chips show the parsed query", ["color: red", "type: tour bus", "detector: bus"].every((c) => r.chips.includes(c)), r.chips);
    const first = r;
    const box = await p.evaluate(() => { const t = TDC.player.tiles.front.tile; return { findOn: t.classList.contains("find-on"), label: TDC.burnBoxes.at("front", TDC.player.time).map((b) => b.text), tracked: (TDC.detect.tracks || []).length }; });
    ok(tag + " gold box on the front tile with the same label (viewer + export burn-in)", box.findOn && box.label.some((t) => /tour bus/.test(t)), box);
    if (SHOTS) await p.screenshot({ path: SHOTS + "/vehicle-attrs-" + bn + "-tour-bus.png" });
    r = await find(p, "red tour bus");
    ok(tag + " repeat search uses the vehicle index (no new detection) and is faster", r.last && r.last.fresh === 0 && r.last.reused > 0 && r.ms < first.ms, { first: first.ms, again: r.ms, last: r.last });
    r = await find(p, "city bus");
    ok(tag + " 'city bus' → city bus moment (2.6–5.3 s), not the tour bus", inRange(r.hits, 2.6, 5.3), r.hits.slice(0, 4));
    r = await find(p, "tour bus and regular local street buses");
    ok(tag + " long natural phrase still parses (tour bus)", r.chips.includes("type: tour bus"), r.chips);
    r = await find(p, "white police car");
    ok(tag + " 'white police car' → police moment (5.3–8 s), not the white car in the background", inRange(r.hits.filter((h) => h.cam === "front"), 5.3, 8) && r.hits.some((h) => h.cam === "front" && /police car/.test(h.text)), r.hits.slice(0, 4));   // vehicle searches check every camera since bus-detect-fix: the white ambulance on the rear may also come up
    if (SHOTS) await p.screenshot({ path: SHOTS + "/vehicle-attrs-" + bn + "-police.png" });
    r = await find(p, "ambulance", "around");
    ok(tag + " 'ambulance' (all cameras) → rear camera 0–4 s", r.hits.some((h) => h.best && h.cam === "back" && h.t < 4.6), r.hits.slice(0, 4));
    r = await find(p, "red fire truck", "around");
    ok(tag + " 'red fire truck' (all cameras) → rear camera 4–8 s", r.hits.some((h) => h.best && h.cam === "back" && h.t > 3.4), r.hits.slice(0, 4));
    // make/model: off → chip says so; on → runs (accuracy is measured in test/vehicle-attrs.js)
    r = await find(p, "blue Toyota");
    ok(tag + " 'blue Toyota' with make & model off → chip 'make & model: off'", r.chips.some((c) => /make & model: off/.test(c)), r.chips);
    await p.evaluate(() => TDC.vehicle.setPref("makes", true));
    r = await find(p, "Toyota Prius");
    ok(tag + " 'Toyota Prius' with make & model on runs and answers (no error)", /result|No Toyota Prius/.test(r.status) && r.chips.includes("model: Prius"), { status: r.status, hits: r.hits.slice(0, 2) });
    // plates on: natural phrases route to the plate search
    await p.evaluate(() => TDC.plates.setPref("enabled", true));
    r = await find(p, "blur the license plate");
    const bl = await p.evaluate(() => TDC.plates.prefs().blur);
    ok(tag + " 'blur the license plate' with plates on → plate search + blur turned on", r.chips.includes("blur") && bl && !/picture/.test(r.status), { chips: r.chips, blur: bl, status: r.status.slice(0, 120) });
    await p.evaluate(() => { TDC.plates.setPref("blur", false); TDC.plates.setPref("enabled", false); });
    // live labels: colour added to detector labels
    const live = await p.evaluate(async () => { const v = TDC.player.tiles.front.vids[TDC.player.active]; const d = await TDC.detect.detectImage(v, v.videoWidth, v.videoHeight); return TDC.vehicle.decorateLive(v, v.videoWidth, v.videoHeight, d).filter((x) => x.attr).map((x) => x.attr + " " + x.label); });
    ok(tag + " live labels get the colour ('white car')", live.length > 0, live);
    // graceful: CLIP can't load → readable status, colour-only search still works without CLIP
    await p.evaluate(() => { window.__clipLoad = TDC.search.clip.load; TDC.search.clip.load = () => Promise.reject(new Error("couldn't download the vision model (offline)")); return TDC.vehicle.clearIndex(); });
    r = await find(p, "police car");
    ok(tag + " CLIP unavailable → 'Vehicle details unavailable (…)', no crash", /Vehicle details unavailable/.test(r.status), r.status);
    r = await find(p, "red bus");
    ok(tag + " colour-only 'red bus' works without CLIP", inRange(r.hits, 0, 2.6), { hits: r.hits.slice(0, 3), status: r.status, chips: r.chips });
    await p.evaluate(() => { TDC.search.clip.load = window.__clipLoad; });
    if (SHOTS) { await p.evaluate(() => { document.getElementById("btnSettings") && document.getElementById("btnSettings").click(); }); await W(400); const s = await p.$("#setVehicle"); if (s) { await s.scrollIntoViewIfNeeded(); await W(200); await p.screenshot({ path: SHOTS + "/vehicle-attrs-" + bn + "-settings.png" }); } }
    ok(tag + " no page errors", p.errs.length === 0, p.errs.slice(0, 3));
    await p.close();
    // ── phone: full screen + thumbnail strip shows the same label ──
    p = await open(ctx, { width: 390, height: 844 });
    await p.evaluate(() => TDC.vehicle.setPref("enabled", true));
    r = await find(p, "red tour bus");
    await p.evaluate(() => { TDC.searchStrip.phone = () => true; TDC.focus.focus("front"); TDC.focus.fullscreen(true); }); await W(900);
    const strip = await p.evaluate(() => [...document.querySelectorAll("#ssRow .ss-item .ss-l")].map((n) => n.textContent));
    ok(tag + " phone strip label 'red tour bus · …'", strip.some((s) => /red tour bus · bus \d+%/.test(s)), strip);
    await W(1500);
    const lum = await p.evaluate(async () => { const im = document.querySelector("#ssRow .ss-item img"); if (!im) return -1; await im.decode().catch(() => {}); const c = document.createElement("canvas"); c.width = 32; c.height = 18; const g = c.getContext("2d"); g.drawImage(im, 0, 0, 32, 18); const d = g.getImageData(0, 0, 32, 18).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / 4) / 3; });
    ok(tag + " phone strip thumbnail shows the picture (not black)", lum > 20, lum);
    if (SHOTS) await p.screenshot({ path: SHOTS + "/vehicle-attrs-" + bn + "-phone-strip.png" });
    ok(tag + " phone: no page errors", p.errs.length === 0, p.errs.slice(0, 3));
    await ctx.close();
  }
  console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
