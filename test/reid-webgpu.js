// WebGPU path of the re-ID model (tag handoff-m4), Chromium only.
//  * gate: with the default settings a headless Chromium without a real GPU (software adapter) stays on WASM; WebKit / iOS Safari stay on WASM
//    unless ?webgpu=on; ?webgpu=off forces WASM
//  * numbers: with the TEST switch tdc.webgpu.soft=1 the worker also accepts the software (SwiftShader) adapter, so the WebGPU execution provider
//    really runs the bundled ONNX here; its embeddings must equal the WASM ones (cosine >= 0.99). Speed on a real GPU is NOT measured by this test.
// Usage: node test/reid-webgpu.js [url]
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 600) : "")); if (!c) fails++; };
const FLAGS = ["--no-sandbox", "--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-angle=swiftshader", "--use-webgpu-adapter=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const run = (page, soft) => page.evaluate(async () => {
  const D = TDC.detect, t0 = performance.now(); const info = await D.loadReid(); const loadMs = Math.round(performance.now() - t0);
  let s = 12345; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const out = [], ms = [];
  for (let k = 0; k < 6; k++) { const px = new Uint8ClampedArray(128 * 256 * 4); for (let y = 0; y < 256; y++) for (let x = 0; x < 128; x++) { const i = (y * 128 + x) * 4, torso = y > 60 && y < 140 && x > 30 && x < 98, legs = y >= 140 && y < 230 && x > 40 && x < 88; px[i] = torso ? 40 + k * 30 : legs ? 30 : 110 + rnd() * 20; px[i + 1] = torso ? 200 - k * 20 : legs ? 40 + k * 10 : 120 + rnd() * 20; px[i + 2] = torso ? 60 + k * 25 : legs ? 120 : 110 + rnd() * 20; px[i + 3] = 255; } const r = await D.embed(px.buffer); out.push(Array.from(r.emb)); ms.push(r.ms); }
  return { info, loadMs, out, ms, gpu: !!navigator.gpu, adapter: await (async () => { try { const a = await navigator.gpu.requestAdapter(); const i = a && (a.info || {}); return a ? { fallback: !!a.isFallbackAdapter || !!i.isFallbackAdapter, desc: (i.vendor || "") + " " + (i.architecture || "") + " " + (i.description || "") } : null; } catch (e) { return String(e); } })() };
});
(async () => {
  const pw = require("playwright");
  const b = await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: FLAGS });
  const page = async (q, soft) => { const ctx = await b.newContext({ viewport: { width: 1000, height: 700 } }), p = await ctx.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message)); await p.goto(URL_ + q, { waitUntil: "load" }); if (soft) { await p.evaluate(() => localStorage.setItem("tdc.webgpu.soft", "1")); await p.reload({ waitUntil: "load" }); } return p; };
  // default: software adapter → WASM
  const a = await page("", false); const A = await run(a, false);
  console.log("   adapter:", JSON.stringify(A.adapter), " default backend:", A.info && A.info.backend, A.info && A.info.selfTestMs + " ms self-test");
  ok("default settings: a software WebGPU adapter is not used (WASM), the model still works", A.info && A.info.backend === "wasm" && A.info.gpuRuntime === false && A.out.length === 6, A.info);
  // ?webgpu=off
  const o = await page("?webgpu=off", true); const O = await run(o, true);
  ok("?webgpu=off keeps WASM even with the test switch", O.info && O.info.backend === "wasm", O.info);
  // WebGPU EP on the software adapter
  const g = await page("?webgpu=on", true); const G = await run(g, true);
  console.log("   soft-GPU backend:", JSON.stringify(G.info), "load", G.loadMs, "ms; per-crop ms:", G.ms.map(Math.round).join(","));
  if (!A.adapter || typeof A.adapter === "string") ok("(skipped: this Chromium has no WebGPU adapter at all)", true);
  else {
    ok("with the test switch the model runs on the WebGPU execution provider", G.info && G.info.backend === "webgpu" && G.info.gpuRuntime === true, G.info);
    if (G.info && G.info.backend === "webgpu") {
      const cos = (x, y) => { let d = 0, nx = 0, ny = 0; for (let i = 0; i < x.length; i++) { d += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i]; } return d / Math.sqrt(nx * ny); };
      const cs = A.out.map((e, i) => cos(e, G.out[i]));
      console.log("   WASM vs WebGPU cosines:", cs.map((c) => c.toFixed(5)).join(" "));
      ok("WebGPU embeddings equal the WASM ones (cosine >= 0.99 for all 6 crops)", cs.every((c) => c >= 0.99), cs);
      ok("embeddings are 256-d unit vectors", G.out.every((e) => e.length === 256 && Math.abs(Math.hypot(...e) - 1) < 1e-3));
    }
  }
  for (const p of [a, o, g]) ok("no page errors", p.errs.length === 0, p.errs);
  await b.close();
  // WebKit: the gate keeps WASM; ?webgpu=on is honoured only as an override (no navigator.gpu on Linux WebKit → still WASM)
  const wb = await pw.webkit.launch(); const wc = await wb.newContext({ viewport: { width: 1000, height: 700 } }), wp = await wc.newPage(); await wp.goto(URL_, { waitUntil: "load" });
  const gate = await wp.evaluate(() => ({ webkit: TDC.workerStart.isWebKit(), gpuOk: TDC.workerStart.gpuOk() })); const wi = await wp.evaluate(() => TDC.detect.loadReid());
  ok("WebKit: the app's WebGPU gate is closed by default and the model runs on WASM", gate.webkit && gate.gpuOk === false && wi && wi.backend === "wasm", [gate, wi]);
  await wp.goto(URL_ + "?webgpu=on", { waitUntil: "load" }); ok("WebKit: ?webgpu=on opens the gate (override), ?webgpu=auto closes it again", await wp.evaluate(() => TDC.workerStart.gpuOk()) === true);
  await wp.goto(URL_ + "?webgpu=auto", { waitUntil: "load" }); ok("WebKit: ?webgpu=auto restores the default", await wp.evaluate(() => TDC.workerStart.gpuOk()) === false);
  await wb.close();
  console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
