/* gdino-worker.js — EXPERIMENTAL open-vocabulary detection (Grounding DINO tiny, Apache-2.0) via transformers.js.
 * Module worker. About 150–200 MB download; meant for desktop with WebGPU. Same message format as detect-worker.js. */
let pipe = null, backend = null, mod = null;
self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === "load") {
      if (!pipe) {
        mod = await import(msg.tfUrl);
        mod.env.allowLocalModels = false;
        const gpu = msg.preferGpu !== false && self.navigator && navigator.gpu;
        const opts = gpu ? { device: "webgpu", dtype: "q4f16" } : { device: "wasm", dtype: "int8" };
        pipe = await mod.pipeline("zero-shot-object-detection", msg.model, { ...opts, progress_callback: (p) => { if (p && p.status === "progress") postMessage({ type: "progress", phase: "download", url: p.file, loaded: p.loaded, total: p.total }); } });
        backend = opts.device;
      }
      postMessage({ type: "loaded", id: msg.id, backend, url: msg.model, size: msg.size });
    } else if (msg.type === "detect") {
      const S = msg.size, img = new mod.RawImage(new Uint8ClampedArray(msg.rgba), S, S, 4).rgb();
      const labels = String(msg.prompt || "object").split(/[,.;]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const t0 = Date.now();
      const out = await pipe(img, labels.map((l) => l + "."), { threshold: msg.conf || 0.3 });
      const { scale, padX, padY, w: fw, h: fh } = msg.fit;
      const dets = out.map((o) => {
        const x1 = Math.max(0, (o.box.xmin - padX) / scale / fw), y1 = Math.max(0, (o.box.ymin - padY) / scale / fh);
        const x2 = Math.min(1, (o.box.xmax - padX) / scale / fw), y2 = Math.min(1, (o.box.ymax - padY) / scale / fh);
        return { x: x1, y: y1, w: x2 - x1, h: y2 - y1, label: String(o.label).replace(/\.$/, ""), conf: o.score };
      }).filter((b) => b.w > 0.003 && b.h > 0.003);
      postMessage({ type: "result", id: msg.id, dets, ms: Date.now() - t0, backend });
    }
  } catch (err) { postMessage({ type: "error", id: msg.id, error: String((err && err.message) || err) }); }
};
