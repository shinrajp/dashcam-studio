// Vehicle details (beta) accuracy on real public-domain / CC0 photos (Wikimedia Commons; fetched by tools/fetch-vehicle-fixtures.py,
// not stored in the repo). Real models: YOLO11 (detector) → colour from pixels → CLIP zero-shot type and make/model.
// Prints per-photo results and honest accuracy numbers. Chromium + WebKit (BR=chromium|webkit to pick one).
// Usage: node test/vehicle-attrs.js [url]    (needs internet the first time: CLIP ~150 MB from Hugging Face)
const pw = require("playwright"); const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FX = process.env.VEH_FIXTURES || "/tmp/vehicle-fixtures";
if (!fs.existsSync(FX + "/meta.json")) execFileSync("python3", [path.join(__dirname, "../tools/fetch-vehicle-fixtures.py"), FX], { stdio: "inherit" });
const meta = JSON.parse(fs.readFileSync(FX + "/meta.json", "utf8"));
const A = require("../js/vehicle-attrs.js");
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x) : "")); if (!c) fails++; };
const OUT = {};
(async () => {
  for (const bn of (process.env.BR || "chromium,webkit").split(",")) {
    const dir = "/tmp/tdc-veh-profile-" + bn;
    const ctx = await pw[bn].launchPersistentContext(dir, bn === "chromium" ? { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"], viewport: { width: 1280, height: 800 } } : { viewport: { width: 1280, height: 800 } });
    const p = ctx.pages()[0] || (await ctx.newPage()); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
    await p.route("**/__fx/**", (r) => r.fulfill({ path: path.join(FX, decodeURIComponent(r.request().url().split("/__fx/")[1])), contentType: "image/jpeg" }));
    await p.goto(URL_, { waitUntil: "load" });
    const t0 = Date.now();
    const res = await p.evaluate(async (meta) => {
      const out = [];
      await TDC.search.clip.load(() => {});
      for (const m of meta) {
        const img = new Image(); img.src = "__fx/" + m.file; await img.decode();
        const t = performance.now();
        const dets = (await TDC.detect.detectImage(img, img.naturalWidth, img.naturalHeight, { conf: 0.25 })).filter((d) => ["car", "bus", "truck", "motorcycle"].includes(d.label));
        const td = performance.now() - t;
        if (!dets.length) { out.push({ key: m.key, none: true }); continue; }
        const d0 = dets.sort((a, b) => b.w * b.h - a.w * a.h)[0];
        const d = { x: d0.x, y: d0.y, w: d0.w, h: d0.h, label: d0.label, conf: d0.conf };
        const t2 = performance.now();
        await TDC.vehicle.describe(img, img.naturalWidth, img.naturalHeight, d, { type: true, make: true });
        const tops = Object.entries(d.types || {}).sort((a, b) => b[1] - a[1]);
        out.push({ key: m.key, box: { x: d.x, y: d.y, w: d.w, h: d.h }, label: d.label, conf: d.conf, color: d.color, colorConf: d.colorConf, colors: d.colors, type: tops[0] && tops[0][0], typeP: tops[0] && tops[0][1], types: d.types, makes: (d.makes || []).slice(0, 3), detMs: Math.round(td), attrMs: Math.round(performance.now() - t2) });
      }
      return out;
    }, meta);
    const stats = { det: [0, 0], color: [0, 0], colorNear: [0, 0], type: [0, 0], typeQuery: [0, 0], make: [0, 0], model: [0, 0] };
    for (const r of res) {
      const m = meta.find((x) => x.key === r.key), tr = m.truth;
      if (r.none) { console.log("NONE ", r.key, "no vehicle detected"); stats.det[1]++; continue; }
      const typeDef = tr.type && A.TYPES.find((t) => t.id === tr.type);
      const detOk = typeDef ? typeDef.cls.includes(r.label) : r.label === tr.cls || (tr.cls === "truck" && r.label === "car");
      stats.det[0] += detOk ? 1 : 0; stats.det[1]++;
      if (tr.color) { stats.color[1]++; stats.colorNear[1]++; if (r.color === tr.color) stats.color[0]++; if (A.colorMatch(tr.color, { name: r.color, scores: r.colors }) >= 0.3) stats.colorNear[0]++; }
      if (tr.type) { stats.type[1]++; stats.typeQuery[1]++; if (r.type === tr.type) stats.type[0]++; const p = (r.types || {})[tr.type] || 0; if (p >= 0.2 || r.type === tr.type) stats.typeQuery[0]++; }
      if (tr.make) { stats.make[1]++; stats.model[1]++; if (r.makes[0] && r.makes[0][0] === tr.make) stats.make[0]++; if (r.makes[0] && r.makes[0][0] === tr.make && r.makes[0][1] === tr.model) stats.model[0]++; }
      console.log(bn.padEnd(8), r.key.padEnd(13), (r.label + " " + Math.round(r.conf * 100) + "%").padEnd(10), ("color " + r.color + (tr.color ? (r.color === tr.color ? " ✓" : " ✗ want " + tr.color) : "")).padEnd(26),
        ("type " + r.type + " " + Math.round((r.typeP || 0) * 100) + "%" + (tr.type ? (r.type === tr.type ? " ✓" : " ✗ want " + tr.type) : "")).padEnd(40),
        "make " + (r.makes && r.makes[0] ? r.makes[0][0] + " " + r.makes[0][1] + " " + Math.round(r.makes[0][2] * 100) + "%" : "-") + (tr.make ? (r.makes[0] && r.makes[0][0] === tr.make ? " ✓" : " ✗ want " + tr.make + " " + tr.model) : ""), " det " + r.detMs + "ms attrs " + r.attrMs + "ms");
    }
    const f = ([a, b]) => a + "/" + b + (b ? " (" + Math.round((100 * a) / b) + "%)" : "");
    console.log(bn, "ACCURACY detector class " + f(stats.det) + " · colour exact " + f(stats.color) + " · colour accepted by query " + f(stats.colorNear) + " · type top-1 " + f(stats.type) + " · type found by query " + f(stats.typeQuery) + " · make top-1 " + f(stats.make) + " · make+model top-1 " + f(stats.model) + " · total " + Math.round((Date.now() - t0) / 1000) + " s");
    OUT[bn] = { stats, res };
    // floors (regression guards, set below what was measured; numbers in models/README.md)
    ok(bn + " detector finds a vehicle of the right class", stats.det[0] / stats.det[1] >= 0.8, stats.det);
    ok(bn + " colour accepted by the query", stats.colorNear[0] / stats.colorNear[1] >= 0.75, stats.colorNear);
    ok(bn + " role/type found by the query", stats.typeQuery[0] / stats.typeQuery[1] >= 0.7, stats.typeQuery);
    ok(bn + " no page errors", errs.length === 0, errs.slice(0, 3));
    await ctx.close();
  }
  fs.writeFileSync("/tmp/vehicle-attrs-results.json", JSON.stringify(OUT, null, 1));
  console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
