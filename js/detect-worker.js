/* detect-worker.js — YOLO11 (COCO, 80 classes) object detection in a Web Worker with onnxruntime-web.
 * WebGPU when the browser has it, otherwise WASM. The main thread sends a 640×640 letterboxed RGBA frame;
 * we answer with boxes normalised to the original frame. No video ever leaves this computer. */
"use strict";
let RT = null, session = null, backend = null, modelUrl = null, inputName = null, outputName = null, size = 640;

// Report anything that goes wrong with a real message (a bare worker "error" event has none).
self.addEventListener("error", (e) => { try { postMessage({ type: "fatal", error: "worker: " + (e.message || "error") + (e.filename ? " (" + e.filename + ":" + e.lineno + ")" : "") }); } catch (_) {} });
self.addEventListener("unhandledrejection", (e) => { try { postMessage({ type: "fatal", error: "worker: " + String((e.reason && e.reason.message) || e.reason) }); } catch (_) {} });

async function realGpu(prefer) {
  if (!prefer || typeof navigator === "undefined" || !navigator.gpu) return false;
  try {   // skip software WebGPU (SwiftShader, llvmpipe): far slower than WASM
    const ad = await navigator.gpu.requestAdapter(); const inf = (ad && ad.info) || {};
    return !!ad && !ad.isFallbackAdapter && !inf.isFallbackAdapter && !/swiftshader|llvmpipe|software/i.test((inf.vendor || "") + " " + (inf.architecture || "") + " " + (inf.description || ""));
  } catch (_) { return false; }
}
// Fetch bytes (no MIME checks, unlike importScripts/import()), trying each base in turn; cached in IndexedDB.
async function getFile(bases, name, useCache) {
  let last = null;
  for (const base of bases) {
    const url = base + name;
    if (useCache) { const hit = await cacheGet(url); if (hit && hit.byteLength) return hit; }
    try { const r = await fetch(url); if (!r.ok) throw new Error("HTTP " + r.status + " " + url); const buf = await r.arrayBuffer(); if (useCache) cachePut(url, buf); return buf; }
    catch (e) { last = e; }
  }
  throw new Error("couldn't fetch " + name + ": " + ((last && last.message) || last));
}
let rtGpu = false;
async function loadOrt(msg) {
  if (RT) return;
  const bases = [].concat(msg.ortBases || msg.ortBase || []);
  rtGpu = await realGpu(msg.preferGpu !== false);
  const js = rtGpu ? "ort.webgpu.min.js" : "ort.wasm.min.js", core = rtGpu ? "ort-wasm-simd-threaded.jsep" : "ort-wasm-simd-threaded";
  try {
    const [src, mjs, wasm] = await Promise.all([getFile(bases, js, msg.useCache), getFile(bases, core + ".mjs", msg.useCache), getFile(bases, core + ".wasm", msg.useCache)]);
    // Load everything from blob: URLs with the right types, so a server that sends the wrong MIME type
    // (Windows python http.server, some NAS servers) or a blocked CDN can't break it.
    importScripts(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    if (!self.ort) throw new Error("onnxruntime-web did not initialise");
    RT = self.ort;
    RT.env.wasm.wasmPaths = { mjs: URL.createObjectURL(new Blob([mjs], { type: "text/javascript" })), wasm: URL.createObjectURL(new Blob([wasm], { type: "application/wasm" })) };
    RT.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, (navigator.hardwareConcurrency || 2)) : 1;   // threads need COOP/COEP
    RT.env.wasm.proxy = false;
  } catch (e) { RT = null; throw new Error("Could not load the detection runtime (onnxruntime-web): " + ((e && e.message) || e)); }
}

// IndexedDB model cache (works on plain-http LAN pages too, where Cache Storage is not available). Failures are ignored.
function idb() {
  return new Promise((res, rej) => {
    try { const r = indexedDB.open("tdc-models", 1); r.onupgradeneeded = () => r.result.createObjectStore("m"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }
    catch (e) { rej(e); }
  });
}
async function cacheGet(key) { try { const db = await idb(); return await new Promise((res) => { const q = db.transaction("m").objectStore("m").get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); } catch (_) { return null; } }
async function cachePut(key, buf) { try { const db = await idb(); await new Promise((res) => { const tx = db.transaction("m", "readwrite"); tx.objectStore("m").put(buf, key); tx.oncomplete = res; tx.onerror = res; tx.onabort = res; }); return true; } catch (_) { return false; } }

async function fetchModel(urls, useCache, progress) {
  let lastErr = null;
  for (const url of urls) {
    if (useCache) { const hit = await cacheGet(url); if (hit && hit.byteLength > 1000) { progress({ phase: "cache", url, loaded: hit.byteLength, total: hit.byteLength }); return { buf: hit, url, cached: true }; } }
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
      const total = +r.headers.get("content-length") || 0;
      let buf;
      if (r.body && r.body.getReader) {
        const rd = r.body.getReader(), parts = []; let got = 0, last = 0;
        for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; if (got - last > 512 * 1024) { last = got; progress({ phase: "download", url, loaded: got, total }); } }
        const u8 = new Uint8Array(got); let o = 0; for (const p of parts) { u8.set(p, o); o += p.length; } buf = u8.buffer;
      } else buf = await r.arrayBuffer();
      progress({ phase: "download", url, loaded: buf.byteLength, total: buf.byteLength });
      const saved = useCache ? await cachePut(url, buf) : false;
      return { buf, url, cached: false, saved };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("No model URL");
}

async function load(msg) {
  await loadOrt(msg);
  if (session && modelUrl === msg.urls[0]) return { backend, url: modelUrl, cached: true };
  if (session) { try { await session.release(); } catch (_) {} session = null; }
  const t0 = Date.now();
  const got = await fetchModel(msg.urls, msg.useCache !== false, (p) => postMessage({ type: "progress", ...p }));
  const tDl = Date.now() - t0;
  const wantGpu = rtGpu;
  const order = wantGpu ? ["webgpu", "wasm"] : ["wasm"];
  let err = null;
  for (const ep of order) {
    try { session = await RT.InferenceSession.create(new Uint8Array(got.buf), { executionProviders: [ep], graphOptimizationLevel: "all" }); backend = ep; break; }
    catch (e) { err = e; session = null; }
  }
  if (!session) throw new Error("Could not start the model: " + ((err && err.message) || err));
  inputName = session.inputNames[0]; outputName = session.outputNames[0];
  const meta = session.inputMetadata && session.inputMetadata[0];
  if (meta && meta.shape && +meta.shape[2] > 0) size = +meta.shape[2];
  modelUrl = msg.urls[0];
  return { backend, url: got.url, cached: got.cached, saved: got.saved, bytes: got.buf.byteLength, downloadMs: tDl, loadMs: Date.now() - t0 - tDl, size };
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i || 1);
}

async function detect(msg) {
  if (!session) throw new Error("model not loaded");
  const S = size, px = new Uint8ClampedArray(msg.rgba), n = S * S, f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { f[i] = px[i * 4] / 255; f[n + i] = px[i * 4 + 1] / 255; f[2 * n + i] = px[i * 4 + 2] / 255; }
  const t0 = Date.now();
  const out = await session.run({ [inputName]: new RT.Tensor("float32", f, [1, 3, S, S]) });
  const ms = Date.now() - t0;
  const o = out[outputName], d = o.data, C = o.dims[1] - 4, N = o.dims[2];   // [1, 4+80, 8400]: cx, cy, w, h, class scores
  const conf = msg.conf || 0.35, cand = [];
  for (let j = 0; j < N; j++) {
    let best = 0, cls = -1;
    for (let c = 0; c < C; c++) { const v = d[(4 + c) * N + j]; if (v > best) { best = v; cls = c; } }
    if (best < conf) continue;
    const cx = d[j], cy = d[N + j], w = d[2 * N + j], h = d[3 * N + j];
    cand.push({ b: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], conf: best, cls });
  }
  cand.sort((a, b) => b.conf - a.conf);
  const keep = [];
  for (const c of cand) { if (keep.length >= 100) break; if (!keep.some((k) => k.cls === c.cls && iou(k.b, c.b) > 0.45)) keep.push(c); }
  const { scale, padX, padY, w: fw, h: fh } = msg.fit;   // undo the letterbox → 0..1 of the source frame
  const dets = keep.map((k) => {
    const x1 = Math.max(0, (k.b[0] - padX) / scale / fw), y1 = Math.max(0, (k.b[1] - padY) / scale / fh);
    const x2 = Math.min(1, (k.b[2] - padX) / scale / fw), y2 = Math.min(1, (k.b[3] - padY) / scale / fh);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1, cls: k.cls, conf: k.conf };
  }).filter((b) => b.w > 0.003 && b.h > 0.003);
  return { dets, ms, backend };
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === "load") postMessage({ type: "loaded", id: msg.id, ...(await load(msg)) });
    else if (msg.type === "detect") postMessage({ type: "result", id: msg.id, ...(await detect(msg)) });
  } catch (err) { postMessage({ type: "error", id: msg.id, error: String((err && err.message) || err) || "unknown worker error" }); }
};
