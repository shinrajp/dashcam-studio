// False-positive check for zoomed person looks (cut-off 0.2) with the REAL bundled detector on the synthetic mock footage (tag handoff-m2).
// The mock contains one drawn pedestrian (front); other cameras / frames have none. Counts weak (0.2..0.35) person hits per look and how many
// would survive the 3-look accumulation rule. Chromium only (wasm, no GPU). Usage: node test/handoff-fp.js [url]
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html", MOCK = process.env.MOCK || "/tmp/ho-mock";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const pw = require("playwright");
  if (!fs.existsSync(MOCK + "/TeslaCam")) execFileSync("python3", [path.join(__dirname, "../tools/make-mock-footage.py"), MOCK, "--jobs", "4"], { stdio: "inherit" });
  const b = await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage(); p.on("pageerror", (e) => console.log("pageerror", e.message));
  await p.goto(URL_, { waitUntil: "load" });
  await p.evaluate(() => localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, live: true, model: "nano", speed: "balanced" }))); await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", MOCK + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 2; i++) await W(250);
  await p.evaluate(() => TDC.ui.activate(TDC.library.events.find((e) => /Sentry/.test(e.source)))); await W(1000);
  const r = await p.evaluate(async () => {
    const D = TDC.detect, P = TDC.player, out = { looks: 0, weakPerson: 0, strongPerson: 0, perCam: {}, ms: [], accumulated: 0 };
    const seek = (v, t) => new Promise((res) => { const f = () => { v.removeEventListener("seeked", f); res(); }; v.addEventListener("seeked", f); v.currentTime = t; setTimeout(res, 1500); });
    const crops = [{ x: 0, y: 0.2, w: 0.45, h: 0.6 }, { x: 0.55, y: 0.2, w: 0.45, h: 0.6 }, { x: 0.25, y: 0.1, w: 0.5, h: 0.7 }, { x: 0, y: 0.4, w: 0.4, h: 0.5 }];
    const hist = {};
    for (const cam of Object.keys(P.tiles)) {
      const v = P.tiles[cam].vids[P.active]; if (!v || !v.videoWidth) continue;
      for (const t of [0.4, 1.2, 2.0, 2.8, 3.6, 4.4, 5.2]) {
        await seek(v, t);
        const t0 = performance.now();
        const dets = await D.detectImage(v, v.videoWidth, v.videoHeight, { slot: "main", crops: crops, tilesOnly: true, cropConf: 0.2 });
        out.ms.push(performance.now() - t0); out.looks++;
        const pe = dets.filter((d) => d.label === "person"); const c = (out.perCam[cam] = out.perCam[cam] || { weak: 0, strong: 0, looks: 0 }); c.looks++;
        for (const d of pe) { if (d.conf >= D.prefs().conf) { c.strong++; out.strongPerson++; } else { c.weak++; out.weakPerson++; (hist[cam] = hist[cam] || []).push({ t, d }); } }
      }
    }
    // would the weak hits have accumulated into a track? feed them in time order through the real tracker (3 hits inside 3 s, same place)
    D.clear();
    for (const cam of Object.keys(hist)) for (const h of hist[cam]) D._track(cam, h.t, [{ ...h.d, weak: true, zoom: true }]);
    out.accumulated = D.personTracks(5.3).length; D.clear();
    out.ms.sort((x, y) => x - y); out.medianMs = Math.round(out.ms[out.ms.length >> 1]); out.p90Ms = Math.round(out.ms[Math.floor(out.ms.length * 0.9)]); delete out.ms;
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
  console.log(r.accumulated === 0 ? "PASS no weak-hit accumulates into a phantom person on the synthetic footage" : "NOTE " + r.accumulated + " weak hits accumulated into a track (cartoon pedestrian included)");
  await b.close();
})();
