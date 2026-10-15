/* detect-worker.js — YOLO11 (COCO, 80 classes) object detection in a Web Worker with onnxruntime-web.
 * WebGPU when the browser has it, otherwise WASM. The main thread sends a 640×640 letterboxed RGBA frame;
 * we answer with boxes normalised to the original frame. No video ever leaves this computer. */
"use strict";
let RT = null, session = null, backend = null, modelUrl = null, inputName = null, outputName = null, size = 640;

function loadOrt(base) {
  if (RT) return;
  const tries = [base + "ort.all.min.js", base + "ort.wasm.min.js"];
  let err = null;
  for (const src of tries) { try { importScripts(src); if (self.ort) { RT = self.ort; RT.env.wasm.wasmPaths = base; return; } } catch (e) { err = e; } }
  throw new Error("Could not load the detection runtime (onnxruntime-web) from " + base + (err ? ": " + (err.message || err) : ""));
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
  loadOrt(msg.ortBase);
  if (session && modelUrl === msg.urls[0]) return { backend, url: modelUrl, cached: true };
  if (session) { try { await session.release(); } catch (_) {} session = null; }
  const t0 = Date.now();
  const got = await fetchModel(msg.urls, msg.useCache !== false, (p) => postMessage({ type: "progress", ...p }));
  const tDl = Date.now() - t0;
  let wantGpu = msg.preferGpu !== false && typeof navigator !== "undefined" && !!navigator.gpu;
  if (wantGpu) {   // skip software WebGPU (SwiftShader etc.): it is far slower than WASM
    try { const ad = await navigator.gpu.requestAdapter(); const inf = ad && (ad.info || {}); wantGpu = !!ad && !ad.isFallbackAdapter && !inf.isFallbackAdapter && !/swiftshader|llvmpipe|software/i.test((inf.vendor || "") + " " + (inf.architecture || "") + " " + (inf.description || "")); }
    catch (_) { wantGpu = false; }
  }
  const order = wantGpu ? ["webgpu", "wasm"] : ["wasm"];
  let err = null;
  RT.env.wasm.numThreads = msg.threads || 1;
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
  } catch (err) { postMessage({ type: "error", id: msg.id, error: String((err && err.message) || err) }); }
};
