/* detect.js — Phase 5 object detection (YOLO11 nano/small, experimental Grounding DINO) for search, the gold box and export.
 * Off until you turn it on in Settings ▸ Object detection. Runs in a Web Worker (WebGPU when available, else WASM).
 * Models load on first use and are kept in IndexedDB when the browser allows. Any failure → detection is skipped,
 * and the existing CLIP search, playback, export and keys keep working exactly as before. */
(function () {
  "use strict";
  const T = (window.TDC = window.TDC || {});
  const KEY = "tdc.detect.v1";
  const COCO = ["person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush"];
  const SYN = { people: "person", persons: "person", pedestrian: "person", pedestrians: "person", man: "person", woman: "person", men: "person", women: "person", kid: "person", kids: "person", child: "person", children: "person", human: "person", humans: "person",
    bike: "bicycle", bikes: "bicycle", cyclist: "bicycle", cyclists: "bicycle", motorbike: "motorcycle", motorbikes: "motorcycle", scooter: "motorcycle", vehicle: "car", vehicles: "car", automobile: "car", suv: "car", sedan: "car",
    lorry: "truck", lorries: "truck", pickup: "truck", semi: "truck", van: "truck", "traffic lights": "traffic light", "stop signs": "stop sign", "fire hydrants": "fire hydrant", puppy: "dog", kitty: "cat", phone: "cell phone", buses: "bus", trucks: "truck", cars: "car", dogs: "dog", cats: "cat" };
  const BASE = "https://raw.githubusercontent.com/shinrajp/dashcam-studio/feature/phase5-detection/models/";
  const MODELS = {
    nano: { label: "YOLO11 nano (fast, ~10 MB)", urls: ["models/yolo11n.onnx", BASE + "yolo11n.onnx"], worker: "js/detect-worker.js" },
    small: { label: "YOLO11 small (more accurate, ~38 MB)", urls: ["models/yolo11s.onnx", BASE + "yolo11s.onnx"], worker: "js/detect-worker.js" },
    gdino: { label: "Grounding DINO tiny (any words, experimental, ~150–200 MB)", model: "onnx-community/grounding-dino-tiny-ONNX", worker: "js/gdino-worker.js", module: true },
  };
  const D = (T.detect = { COCO, MODELS, tracks: [], live: {}, status: "", backend: null, info: null, busy: false, timings: [] });
  D.config = { ortBases: ["vendor/ort/", "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/"], tfUrl: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1", size: 640 };
  const isMobile = () => { try { return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 820); } catch (_) { return false; } };
  D.isMobile = isMobile;
  D.defaults = () => ({ enabled: false, model: isMobile() ? "nano" : "small", conf: 0.35, live: false, small: "auto", urls: {} });
  D.prefs = () => { const d = D.defaults(); try { const v = JSON.parse(localStorage.getItem(KEY) || "null"); if (v && typeof v === "object") { if (!MODELS[v.model]) delete v.model; const c = +v.conf; if (!(c >= 0.05 && c <= 0.95)) delete v.conf; return { ...d, ...v }; } } catch (_) {} return d; };
  D.setPref = (k, v) => { const p = D.prefs(); p[k] = v; try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (_) {} if (k === "model") D.unload(); D.renderSettings(); };
  D.enabled = () => D.prefs().enabled === true;

  /** Map a search phrase to a COCO class, or null (free text → CLIP search as before). */
  D.classFor = (q) => {
    const s = String(q || "").toLowerCase().trim().replace(/^(an?|the|any|all)\s+/, "").replace(/[?.!]+$/, "").replace(/\s+/g, " ");
    if (!s || s.length > 40) return null;
    if (COCO.includes(s)) return s;
    if (SYN[s]) return SYN[s];
    if (s.endsWith("s") && COCO.includes(s.slice(0, -1))) return s.slice(0, -1);
    if (s.endsWith("es") && COCO.includes(s.slice(0, -2))) return s.slice(0, -2);
    return null;
  };
  /** Which queries the detector takes over: enabled + (a COCO class for YOLO, or any phrase for Grounding DINO). */
  D.handlesQuery = (q) => D.enabled() && (D.prefs().model === "gdino" ? String(q || "").trim().length >= 3 : !!D.classFor(q));

  // ── worker ──
  let worker = null, wModel = null, seq = 0, loading = null;
  const pending = new Map();
  D.unload = () => { fastInfo = null; fastLoading = null; try { worker && worker.terminate(); } catch (_) {} worker = null; wModel = null; loading = null; D.backend = null; D.info = null; for (const p of pending.values()) p.reject(new Error("detector stopped")); pending.clear(); };
  function call(msg, transfer) { return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }, transfer || []); }); }
  function setStatus(s) { D.status = s; const n = document.getElementById("detStatus"); if (n) n.textContent = s; T.emit && T.emit("detect-status", s); }
  D.setStatus = setStatus;
  D.cacheOk = () => { try { return typeof indexedDB !== "undefined"; } catch (_) { return false; } };

  /** Load (once) the chosen model. Rejects with a readable message; never throws synchronously. */
  D.load = (name) => {
    name = name || D.prefs().model;
    if (D._mock) return Promise.resolve(D.info = { backend: "mock", mock: true });
    if (wModel === name && loading) return loading;
    D.unload();
    const m = MODELS[name];
    if (!m) return Promise.reject(new Error("unknown model " + name));
    if (typeof Worker === "undefined") return Promise.reject(new Error("This browser can't run background workers, so detection is off."));
    wModel = name;
    let stage = "";
    const started = makeWorker(m).then((w) => { worker = w; });
    const wire = () => { const w = worker; worker.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === "stage") { stage = d.stage; return; }
      if (d.type === "fatal") { const err = new Error(d.error); for (const p of pending.values()) p.reject(err); pending.clear(); return; }
      if (d.type === "progress") { const mb = (x) => (x / 1048576).toFixed(1); setStatus(d.phase === "cache" ? "Model loaded from this device." : "Downloading model… " + mb(d.loaded) + (d.total ? " / " + mb(d.total) : "") + " MB"); return; }
      const p = pending.get(d.id); if (!p) return; pending.delete(d.id);
      d.type === "error" ? p.reject(new Error(d.error)) : p.resolve(d);
    };
    worker.onerror = (e) => {
      e.preventDefault && e.preventDefault();
      const msg = e && e.message;
      setTimeout(() => {   // let the worker's own "fatal" report arrive first
        if (worker !== w) return;
        const why = T.workerStart ? T.workerStart.describe(e, stage, workerHow) : msg || "the worker script could not start (" + workerHow + ")";
        const err = new Error("Detection worker failed: " + why); for (const p of pending.values()) p.reject(err); pending.clear();
        if (!msg && D.info) D.unload();   // killed by the browser: start afresh next time
      }, msg ? 0 : 400);
    }; };
    const urls = (D.prefs().urls && D.prefs().urls[name] ? [D.prefs().urls[name]] : []).concat(m.urls || []);
    const abs = urls.map((u) => new URL(u, location.href).href);
    setStatus("Loading " + m.label + "…");
    loading = started.then(() => { wire(); return call({ type: "load", urls: abs, model: m.model, ortBases: D.config.ortBases.map((u) => new URL(u, location.href).href), tfUrl: D.config.tfUrl, size: D.config.size, useCache: D.cacheOk(), preferGpu: T.workerStart ? T.workerStart.gpuOk() : true }); })
      .then((info) => { D.backend = info.backend; D.info = info; setStatus("Ready · " + (info.backend === "webgpu" ? "WebGPU" : "WASM (CPU)") + (info.cached ? " · from this device" : info.saved ? " · saved on this device" : "")); return info; })
      .catch((e) => { setStatus("Detection unavailable: " + e.message); D.unload(); throw e; });
    return loading;
  };

  // The worker is started from a blob: URL of its fetched source, so a server sending the wrong MIME type for .js
  // (e.g. Windows python http.server) can't stop it. Falls back to a plain new Worker(url).
  let workerHow = "";
  async function makeWorker(m) {
    if (T.workerStart) { const st = await T.workerStart.start(m, "detection worker"); workerHow = st.how; return st.worker; }
    const opts = m.module ? { type: "module" } : undefined;
    try {
      const r = await fetch(m.worker, { cache: "no-cache" });
      if (!r.ok) throw new Error("HTTP " + r.status + " for " + m.worker);
      const src = await r.text();
      workerHow = "blob";
      return new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })), opts);
    } catch (e) {
      console.warn("detect: blob worker failed, trying the file directly", e);
      try { workerHow = "file " + m.worker; return new Worker(m.worker, opts); }
      catch (e2) { throw new Error("Couldn't start the detection worker: " + (e2.message || e2) + " (and " + (e.message || e) + ")"); }
    }
  }

  D.makeWorker = makeWorker;   // Phase 6 plates.js starts its own worker the same MIME-proof way

  // letterbox a frame into size×size
  let cv = null, cx = null;
  // the model's own input size (640, or 320 for the Fast live model), from the worker's load answer
  const slotSize = (slot) => (slot === "fast" ? (fastInfo && fastInfo.size) || 320 : (D.info && D.info.size) || D.config.size);
  function fitFor(S, iw, ih, crop) {
    const c = crop || { x: 0, y: 0, w: 1, h: 1 }, sw = iw * c.w, sh = ih * c.h;
    const scale = Math.min(S / sw, S / sh), w = Math.round(sw * scale), h = Math.round(sh * scale), padX = Math.floor((S - w) / 2), padY = Math.floor((S - h) / 2);
    return { lb: { sx: iw * c.x, sy: ih * c.y, sw, sh, padX, padY, w, h }, fit: { scale, padX, padY, w: sw, h: sh } };
  }
  let fastInfo = null, fastLoading = null;
  /** Fast live model (YOLO11 nano, 320 px) in the same worker, second session. Falls back to the main model if it can't load. */
  D.loadFast = async () => {
    await D.load();
    if (D._mock) return null;
    if (fastLoading) return fastLoading;
    fastLoading = call({ type: "load", slot: "fast", urls: [new URL("models/yolo11n-320.onnx", location.href).href, BASE + "yolo11n-320.onnx"], ortBases: D.config.ortBases.map((u) => new URL(u, location.href).href), size: 320, useCache: D.cacheOk(), preferGpu: T.workerStart ? T.workerStart.gpuOk() : true })
      .then((info) => (fastInfo = info)).catch((e) => { console.warn("fast live model unavailable, using the main model", e); fastInfo = null; return null; });
    return fastLoading;
  };
  let bitmapFails = 0, noBitmap = false;
  function letterbox(img, iw, ih, crop, S) {
    S = S || D.config.size;
    if (!cv || cv.width !== S) { cv = document.createElement("canvas"); cv.width = cv.height = S; cx = cv.getContext("2d", { willReadFrequently: true }); }
    const c = crop || { x: 0, y: 0, w: 1, h: 1 }, sw = iw * c.w, sh = ih * c.h;
    const scale = Math.min(S / sw, S / sh), w = Math.round(sw * scale), h = Math.round(sh * scale), padX = Math.floor((S - w) / 2), padY = Math.floor((S - h) / 2);
    cx.fillStyle = "rgb(114,114,114)"; cx.fillRect(0, 0, S, S); cx.drawImage(img, iw * c.x, ih * c.y, sw, sh, padX, padY, w, h);
    iw = sw; ih = sh;
    return { rgba: cx.getImageData(0, 0, S, S).data.buffer, fit: { scale, padX, padY, w: iw, h: ih } };
  }
  /** Detect objects in a video/canvas/image. Returns [{x,y,w,h,cls,conf,label}] (0..1), or [] on any problem. */
  D.pathInfo = () => ({ last: D.lastPath || null, bitmap: !noBitmap, fails: bitmapFails });
  D.detectImage = async (img, iw, ih, opts) => {
    opts = opts || {};
    const conf = opts.conf || D.prefs().conf;
    if (D._mock) { const r = await D._mock(img, iw, ih, opts); return (r || []).map(named).filter((b) => b.conf >= conf); }
    await D.load();
    let slot = "main";
    if (opts.slot === "fast" && D.prefs().model !== "gdino") { const fi = await D.loadFast(); if (fi) slot = "fast"; }
    const S = slotSize(slot);
    const one = async (crop) => {
      let r = null;
      // transferable ImageBitmap → the worker letterboxes it (no getImageData on the main thread); plain RGBA otherwise
      if (!noBitmap && typeof createImageBitmap === "function" && D.info && D.info.offscreen && !opts.prompt) {
        try {
          const bmp = await createImageBitmap(img), f = fitFor(S, iw, ih, crop);
          r = await call({ type: "detect", bitmap: bmp, lb: f.lb, fit: f.fit, conf, slot }, [bmp]);
          D.lastPath = "bitmap";
          bitmapFails = 0;
        } catch (e) {
          if (/not loaded|stopped/.test(String(e && e.message))) throw e;
          // a frame that isn't decodable yet (seeking) fails once; only a path that keeps failing is turned off
          if (++bitmapFails >= 3) { console.warn("ImageBitmap path failed, using RGBA", e); noBitmap = true; }
          r = null;
        }
      }
      if (!r) {
        const lb = letterbox(img, iw, ih, crop, S);
        r = await call({ type: "detect", rgba: lb.rgba, fit: lb.fit, conf, size: S, prompt: opts.prompt, slot }, [lb.rgba]);
        D.lastPath = "rgba";
      }
      D.timings.push(r.ms); if (D.timings.length > 50) D.timings.shift();
      return crop ? r.dets.map((b) => ({ ...b, x: crop.x + b.x * crop.w, y: crop.y + b.y * crop.h, w: b.w * crop.w, h: b.h * crop.h, tiled: true })) : r.dets;
    };
    let dets = opts.tilesOnly ? [] : await one(null);
    if (opts.tiles) { for (const c of D.TILES) dets = dets.concat(await one(c)); dets = D.nms(dets, 0.5); }
    return dets.map(named);
  };
  /** 2×2 overlapping tiles (60% of the frame each): small things are about 1.7× bigger for the model. */
  D.TILES = [{ x: 0, y: 0, w: 0.6, h: 0.6 }, { x: 0.4, y: 0, w: 0.6, h: 0.6 }, { x: 0, y: 0.4, w: 0.6, h: 0.6 }, { x: 0.4, y: 0.4, w: 0.6, h: 0.6 }];
  D.nms = (dets, thr) => { const out = []; for (const d of dets.slice().sort((a, b) => b.conf - a.conf)) { const k = d.label || d.cls; if (!out.some((o) => (o.label || o.cls) === k && (iou(o, d) > thr || contains(o, d)))) out.push(d); } return out; };
  const contains = (a, b) => { const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h); return Math.max(0, x2 - x1) * Math.max(0, y2 - y1) > 0.8 * Math.min(a.w * a.h, b.w * b.h); };
  /** Classes that are usually small in dashcam frames: lower threshold + tiles when searching for them. */
  D.SMALL = new Set(["umbrella", "backpack", "handbag", "suitcase", "sports ball", "traffic light", "stop sign", "parking meter", "fire hydrant", "bird", "cat", "dog", "cell phone", "bottle", "cup", "kite", "frisbee", "skateboard", "tie", "bench", "potted plant", "clock"]);
  D.classConf = (cls) => { const c = D.prefs().conf; return cls && D.SMALL.has(cls) ? Math.max(0.1, Math.round(c * 0.6 * 100) / 100) : c; };
  D.useTiles = (cls) => { const m = D.prefs().small; return m === "on" || (m !== "off" && !!cls && D.SMALL.has(cls)); };
  const named = (b) => ({ ...b, label: b.label || COCO[b.cls] || "object" });

  // ── tracking ──
  const iou = (a, b) => { const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h); const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (a.w * a.h + b.w * b.h - i || 1); };
  D.iou = iou;
  /** Greedy IoU tracker. frames: [{t, dets}] sorted by t → tracks [{id, label, pts:[{t,x,y,w,h,conf}]}]. */
  D.buildTracks = (frames, opt) => {
    opt = opt || {}; const minIou = opt.minIou || 0.2, maxGap = opt.maxGap || 1.2;
    const tracks = []; let next = 1;
    for (const f of frames.slice().sort((a, b) => a.t - b.t)) {
      const open = tracks.filter((tr) => f.t - tr.pts[tr.pts.length - 1].t <= maxGap);
      const pairs = [];
      f.dets.forEach((d, di) => open.forEach((tr) => { if (tr.label !== d.label) return; const v = iou(tr.pts[tr.pts.length - 1], d); if (v >= minIou) pairs.push([v, di, tr]); }));
      pairs.sort((a, b) => b[0] - a[0]);
      const usedD = new Set(), usedT = new Set();
      for (const [, di, tr] of pairs) { if (usedD.has(di) || usedT.has(tr)) continue; usedD.add(di); usedT.add(tr); const d = f.dets[di]; tr.pts.push({ t: f.t, x: d.x, y: d.y, w: d.w, h: d.h, conf: d.conf }); }
      f.dets.forEach((d, di) => { if (!usedD.has(di)) tracks.push({ id: next++, label: d.label, pts: [{ t: f.t, x: d.x, y: d.y, w: d.w, h: d.h, conf: d.conf }] }); });
    }
    return tracks;
  };
  /** Box of one track at time t (linear between samples), or null outside it. */
  D.trackAt = (tr, t, slack) => {
    const p = tr.pts, s = slack == null ? 0.3 : slack;
    if (!p.length || t < p[0].t - s || t > p[p.length - 1].t + s) return null;
    if (t <= p[0].t) return p[0];
    if (t >= p[p.length - 1].t) return p[p.length - 1];
    let i = 1; while (p[i].t < t) i++;
    const a = p[i - 1], b = p[i], u = (t - a.t) / (b.t - a.t || 1);
    const L = (k) => a[k] + (b[k] - a[k]) * u;
    return { t, x: L("x"), y: L("y"), w: L("w"), h: L("h"), conf: u < 0.5 ? a.conf : b.conf };
  };
  const pct = (c) => Math.round(Math.max(0, Math.min(1, c)) * 100) + "%";
  /** Followed boxes for a camera at time t, as burn-boxes items [{x,y,w,h,text}]. null = no tracking covers this moment. */
  D.boxesAt = (cam, t) => {
    try {
      const list = (D.tracks || []).filter((g) => g.cam === cam && t >= g.from - 0.05 && t <= g.to + 0.05);
      if (list.length) {
        const out = [];
        for (const g of list) {
          const b = D.trackAt(g.track, t); if (!b) continue;
          // Detector hit, or a picture-search phrase that names the same class → real "car 91%".
          // Otherwise (picture-search box that the tracker followed) keep "umbrella? (match)": the % would be for another class.
          const same = !g.text || D.classFor(g.text) === g.track.label;
          if (g.hit && g.hit.boxText) { out.push({ x: b.x, y: b.y, w: b.w, h: b.h, text: String(g.hit.boxText).slice(0, 80), hit: g.hit }); continue; }   // plates: shared label
          out.push({ x: b.x, y: b.y, w: b.w, h: b.h, text: same ? g.track.label + " " + pct(b.conf) : String(g.text).slice(0, 40) + "? (match)", hit: g.hit });
        }
        return out;
      }
      const tl = T.player && T.player.playing && D.prefs().live ? D.trackedLive(cam, t) : null;
      if (tl) return tl.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, text: (b.attr ? b.attr + " " : "") + b.label + " " + pct(b.conf), label: b.label, live: true }));
      const lv = D.liveAt(cam, t);
      if (lv) return lv.dets.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, text: (b.attr ? b.attr + " " : "") + b.label + " " + pct(b.conf), label: b.label, live: true }));
      return null;
    } catch (_) { return null; }
  };

  // ── frame access (hidden video, same approach as search.js) ──
  let vid = null;
  async function frameAt(cam, t) {
    const ev = T.player && T.player.ev; if (!ev) return null;
    const clip = ev.clips[T.player.clipIndexAt(t)]; const it = clip && clip.files[cam];
    if (!it || !it.blob) return null;
    vid = vid || Object.assign(document.createElement("video"), { muted: true, playsInline: true, preload: "auto" });
    await T.search.seekSample(vid, it, Math.max(0, t - clip.start));
    return vid.videoWidth ? vid : null;
  }
  D.frameAt = frameAt;

  /** Run the detector on sampled frames around each hit and keep the track that matches it, so the box follows the object. */
  D.trackAround = async (group, opts) => {
    opts = opts || {};
    const span = opts.span || 2.5, step = opts.step || (isMobile() ? 0.5 : 0.25);
    const out = [], until = performance.now() + (opts.budgetMs || 25000);
    for (const hit of group) {
      if (!hit || !hit.box) continue;
      const ev = T.player.ev, from = Math.max(0, hit.t - span), to = Math.min(ev ? ev.duration : hit.t + span, hit.t + span);
      const frames = [];
      // sample outward from the hit so a time budget still leaves frames on both sides
      const times = []; for (let k = 0; ; k++) { const a = hit.t - k * step, z = hit.t + k * step; if (a < from - 1e-6 && z > to + 1e-6) break; if (a >= from - 1e-6) times.push(a); if (k && z <= to + 1e-6) times.push(z); }
      for (const t of times) {
        if (performance.now() > until && frames.length >= 3) break;
        const v = await frameAt(hit.cam, t); if (!v) continue;
        let dets = []; try { dets = await D.detectImage(v, v.videoWidth, v.videoHeight, { prompt: opts.prompt, conf: hit.det && hit.label ? D.classConf(hit.label) : undefined, tiles: !!hit.tiled }); } catch (e) { console.warn("track frame", e); if (!frames.length) throw e; continue; }
        frames.push({ t, dets });
        if (opts.onProgress) opts.onProgress(frames.length, times.length);
      }
      const tracks = D.buildTracks(frames);
      // the track that overlaps the hit's box at the hit's time (same class for detector hits)
      let best = null, bestV = 0.1;
      for (const tr of tracks) { if (hit.cls != null && hit.label && tr.label !== hit.label) continue; const b = D.trackAt(tr, hit.t, step); if (!b) continue; const v = iou(b, hit.box); if (v > bestV) { bestV = v; best = tr; } }
      if (best) { out.push({ cam: hit.cam, hit, track: best, from: best.pts[0].t, to: best.pts[best.pts.length - 1].t, text: hit.det ? null : hit.phrase || null }); hit.tracked = true; }
    }
    return out;
  };

  /** Search for a COCO class (or a Grounding DINO phrase) with the detector. Fills T.search.hits like the CLIP search. */
  D.runSearch = async (q, list, ui) => {
    const P = D.prefs(), gd = P.model === "gdino", cls = gd ? null : D.classFor(q);
    const rows = [];
    const t0 = performance.now();
    for (let i = 0; i < list.length; i++) {
      if (ui.stopped()) break;
      const s = list[i];
      ui.status("Detecting " + (cls || "“" + q + "”") + " · frame " + (i + 1) + " of " + list.length + (D.backend ? " · " + (D.backend === "webgpu" ? "WebGPU" : "WASM") : "") + ". The video stays on this computer.");
      let dets, mine;
      const conf = gd ? P.conf : D.classConf(cls), key = s.cam + "|" + s.t.toFixed(2), cached = !gd && D.frameCache.get(key);
      const v = cached && cached.conf <= conf ? null : await frameAt(s.cam, s.t);
      if (!v && !(cached && cached.conf <= conf)) continue;
      try {
        if (cached && cached.conf <= conf) dets = cached.dets.filter((d) => d.conf >= conf);
        else { dets = await D.detectImage(v, v.videoWidth, v.videoHeight, { prompt: gd ? q : undefined, conf }); if (!gd) D.frameCache.set(key, { conf, dets }); }
        mine = gd ? dets : dets.filter((d) => d.label === cls);
        // small things: if the whole frame found none, look again at 2×2 zoomed tiles
        if (!mine.length && !gd && D.useTiles(cls) && v) { dets = await D.detectImage(v, v.videoWidth, v.videoHeight, { conf, tiles: true, tilesOnly: true }); mine = dets.filter((d) => d.label === cls); }
      }
      catch (e) { if (!rows.length && i === 0) throw e; console.warn(e); continue; }
      if (!mine.length) continue;
      const top = mine.reduce((a, b) => (b.conf > a.conf ? b : a));
      rows.push({ t: s.t, cam: s.cam, score: top.conf, conf: top.conf, cls: top.cls, label: top.label, det: true, tiled: !!top.tiled, count: mine.length, box: { x: top.x, y: top.y, w: top.w, h: top.h } });
      if ((i & 3) === 0) await new Promise((r) => setTimeout(r, 0));
    }
    D.lastSearchMs = performance.now() - t0; D.lastSearchFrames = list.length;
    return rows;
  };

  // ── live detection while playing: adaptive rate ──
  // The next detection starts as soon as the previous one is back (frames that arrive while the worker is busy are skipped),
  // limited by Settings ▸ Detection speed: Fast (no limit, YOLO11 nano at 320 px), Balanced (≤ 5 per second, default),
  // Battery saver (≤ 1 per second). Driven by requestVideoFrameCallback on the playing video (requestAnimationFrame where
  // that is missing). With "All cameras" each visible camera takes its turn (round robin). Inference stays in the worker; the
  // frame goes there as a transferable ImageBitmap. Between detections the viewer moves each box with a small tracker
  // (IoU matching, constant velocity, smoothed position and size); a box not matched again for ~0.5 s disappears.
  const SPEEDS = { fast: { gap: 0, label: "Fast" }, balanced: { gap: 200, label: "Balanced" }, battery: { gap: 1000, label: "Battery saver" } };
  D.SPEEDS = SPEEDS;
  let lowPower = null;   // iOS Low Power Mode / low battery guess (null = unknown)
  D.lowPower = () => lowPower;
  (function guessLowPower() {
    try {
      if (navigator.getBattery) navigator.getBattery().then((b) => { if (b.level <= 0.2 && !b.charging) lowPower = true; else if (lowPower == null) lowPower = false; }).catch(() => {});
      // iOS doesn't expose the battery; Low Power Mode caps requestAnimationFrame at 30 Hz, so a 30 Hz phone is a hint
      if (/iPhone|iPad|iPod/.test(navigator.userAgent) && typeof requestAnimationFrame === "function") {
        let n = 0, t0 = 0; const f = (ts) => { if (!t0) t0 = ts; if (++n < 31) return requestAnimationFrame(f); const per = (ts - t0) / 30; if (per > 27 && per < 40) lowPower = true; else if (lowPower == null) lowPower = false; };
        setTimeout(() => requestAnimationFrame(f), 1500);
      }
    } catch (_) {}
  })();
  D.speed = () => { const v = D.prefs().speed; return SPEEDS[v] ? v : lowPower && isMobile() ? "battery" : "balanced"; };
  D.liveCamsMode = () => { const v = D.prefs().liveCams; return v === "all" || v === "focused" ? v : isMobile() ? "focused" : "all"; };
  D.liveGap = () => SPEEDS[D.speed()].gap;
  D.liveEvery = () => Math.max(D.liveGap(), D.avgMs ? D.avgMs() : 300);   // ms between two detections (one camera)
  D.avgMs = () => { const a = D.liveStats.ms.slice(-10); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; };
  D.liveStats = { starts: [], ms: [], skipped: 0, frames: 0 };
  D.liveRate = (sec) => { const now = performance.now(), w = (sec || 5) * 1000; return D.liveStats.starts.filter((x) => now - x <= w).length / (sec || 5); };

  const visible = (cam) => { const tl = T.player.tiles && T.player.tiles[cam]; if (!tl) return null; const v = tl.vids[T.player.active]; if (!v || !v.videoWidth || !v._url && !v.src) return null; const el = tl.tile; if (!el || el.hidden || el.classList.contains("off") || el.offsetParent === null || el.clientWidth < 4) return null; return v; };   // .off = hidden behind a focused camera (WebKit hands back blank frames for it)
  D.liveCams = () => {
    const f = (T.focus && T.focus.cam) || "front";
    if (D.liveCamsMode() === "focused") return visible(f) ? [f] : [];
    return T.GRID.filter((c) => visible(c));
  };
  const frameTime = (v, meta) => {   // event time of the frame on screen: clip start + the video's own time
    let t = T.player.time;
    try { const ci = T.player.clipIndexAt(t), c = T.player.ev && T.player.ev.clips[ci]; const mt = meta && isFinite(meta.mediaTime) ? meta.mediaTime : v.currentTime; if (c && isFinite(mt)) { const vt = c.start + mt; if (Math.abs(vt - t) < 1) t = vt; } } catch (_) {}
    return t;
  };

  // per-camera viewer tracker
  D.liveTracks = {};
  const EMA_POS = 0.6, EMA_SIZE = 0.4;
  const expiry = (cam) => { const n = Math.max(1, D.liveCams().length); return Math.max(0.5, 1.5 * n * D.liveEvery() / 1000); };
  function track(cam, t, dets) {
    const list = (D.liveTracks[cam] = (D.liveTracks[cam] || []).filter((tr) => t - tr.seen <= expiry(cam) && tr.t <= t + 0.05));
    const pred = list.map((tr) => { const dt = Math.min(0.5, Math.max(0, t - tr.t)); return { x: tr.x + tr.vx * dt, y: tr.y + tr.vy * dt, w: tr.w, h: tr.h }; });
    const pairs = [];
    dets.forEach((d, i) => list.forEach((tr, j) => { if (tr.label === d.label && near2(pred[j], d)) pairs.push([iou(pred[j], d), i, j]); }));
    pairs.sort((a, b) => b[0] - a[0]);
    const ud = new Set(), ut = new Set();
    for (const [, i, j] of pairs) {
      if (ud.has(i) || ut.has(j)) continue; ud.add(i); ut.add(j);
      const d = dets[i], tr = list[j], p = pred[j], dt = Math.max(1e-3, t - tr.t);
      if (sizeJump(p, d) || iou(p, d) < 0.2) {
        // the object changed size a lot (a bus that drove past the car and pulled away) or the prediction is far off:
        // take the detection as it is. Smoothing here left a frame-wide box around a small, distant bus (tag taillight-fix).
        tr.x = d.x; tr.y = d.y; tr.w = d.w; tr.h = d.h; tr.vx = 0; tr.vy = 0;
      } else {
        // smooth the CENTRE and the size (smoothing the corner and the size separately drifts the box off the object)
        const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2, ncx = pcx + EMA_POS * (d.x + d.w / 2 - pcx), ncy = pcy + EMA_POS * (d.y + d.h / 2 - pcy);
        const ocx = tr.x + tr.w / 2, ocy = tr.y + tr.h / 2;
        tr.vx = 0.5 * tr.vx + 0.5 * ((ncx - ocx) / dt); tr.vy = 0.5 * tr.vy + 0.5 * ((ncy - ocy) / dt);
        tr.w += EMA_SIZE * (d.w - tr.w); tr.h += EMA_SIZE * (d.h - tr.h); tr.x = ncx - tr.w / 2; tr.y = ncy - tr.h / 2;
      }
      tr.t = t; tr.seen = t; tr.conf = d.conf; tr.attr = attrVote(tr, d);
    }
    dets.forEach((d, i) => { if (!ud.has(i)) { const tr = { label: d.label, x: d.x, y: d.y, w: d.w, h: d.h, vx: 0, vy: 0, t, seen: t, conf: d.conf }; tr.attr = attrVote(tr, d); list.push(tr); } });
  }
  D._track = track;   // tests
  /** Box w or h changed by more than 1.6× between two looks at the same object. */
  const sizeJump = (a, b) => Math.max(a.w / b.w, b.w / a.w, a.h / b.h, b.h / a.h) > 1.6;
  /** Colour word of a followed vehicle: votes over its detections (older ones fade), so one frame with the brake lamps
   *  flaring doesn't flip "white bus" to "red bus"; frames where lamps were masked or the light is poor count less. */
  function attrVote(tr, d) {
    if (!d.attrName) return d.attr;
    const v = (tr.av = tr.av || {});
    for (const k in v) v[k] *= 0.6;
    v[d.attrName] = (v[d.attrName] || 0) + Math.max(0.05, d.attrConf || 0.5) * (d.attrLow ? 0.5 : 1) * (d.attrLamps > 0.03 ? 0.6 : 1);
    let best = d.attrName; for (const k in v) if (v[k] > v[best]) best = k;
    return best + (d.attrLow ? "?" : "");
  }
  /** Viewer boxes from the tracker at time t (while playing), or null when it has nothing current for this camera. */
  D.trackedLive = (cam, t) => {
    const list = D.liveTracks[cam]; if (!list || !list.length) return null;
    const ex = expiry(cam), out = [];
    for (const tr of list) {
      if (t - tr.seen > ex || t < tr.t - 0.3) continue;
      const dt = Math.min(0.5, Math.max(-0.3, t - tr.t));
      out.push({ x: tr.x + tr.vx * dt, y: tr.y + tr.vy * dt, w: tr.w, h: tr.h, label: tr.label, conf: tr.conf, attr: tr.attr });
    }
    return out.length ? out : null;
  };

  let liveBusy = false, liveLast = 0, rr = 0, loopOn = false, loopVid = null;
  async function detectLive(cam, v, meta) {
    const t = frameTime(v, meta), t0 = performance.now();
    D.liveStats.starts.push(t0); if (D.liveStats.starts.length > 200) D.liveStats.starts.shift();
    const fast = D.speed() === "fast" && D.prefs().model !== "gdino";
    let dets = await D.detectImage(v, v.videoWidth, v.videoHeight, { slot: fast ? "fast" : "main" });
    D.liveStats.ms.push(performance.now() - t0); if (D.liveStats.ms.length > 50) D.liveStats.ms.shift();
    if (T.vehicle && T.vehicle.decorateLive) dets = T.vehicle.decorateLive(v, v.videoWidth, v.videoHeight, dets, t);   // "white car 91%" (colour after white balance when known)
    const n = Math.max(1, D.liveCams().length), hold = Math.max(0.6, 0.6 + (n * D.liveEvery()) / 1000);
    D.live[cam] = { t, dets, hold, src: "live" };
    addSample(cam, D.live[cam]);
    track(cam, t, dets);
    // while playing the boxes are repainted on every frame ("time"); a "layout" here would also re-place the dock/bar
    if (!T.player || !T.player.playing) T.emit("layout");
  }
  function onFrame(now, meta) {
    if (!loopOn) return;
    const P = D.prefs();
    const boxesOff = T.search && (T.search.needBoxes ? !T.search.needBoxes() : T.search.goldShown && !T.search.goldShown());   // nothing outlined or blurred: save the power
    if (!P.enabled || !P.live || !T.player || !T.player.playing || boxesOff) { loopOn = false; loopVid = null; return; }
    D.liveStats.frames++;
    const cams = D.liveCams();
    if (liveBusy || !cams.length || performance.now() - liveLast < D.liveGap()) { if (liveBusy) D.liveStats.skipped++; return arm(); }
    const cam = cams[rr++ % cams.length], v = visible(cam);
    if (!v) return arm();
    liveBusy = true; liveLast = performance.now();
    detectLive(cam, v, v === loopVid ? meta : null)
      .catch((e) => { console.warn("live detect", e); D.setPref("live", false); setStatus("Live detection turned off: " + e.message); })
      .finally(() => { liveBusy = false; });
    arm();
  }
  function arm() {
    if (!loopOn) return;
    const cams = D.liveCams(), v = cams.length ? visible(cams[0]) : null;
    loopVid = v;
    if (v && typeof v.requestVideoFrameCallback === "function") v.requestVideoFrameCallback(onFrame);
    else requestAnimationFrame((ts) => onFrame(ts, null));
  }
  D.liveRVFC = () => { const cams = D.liveCams(), v = cams.length ? visible(cams[0]) : null; return !!(v && typeof v.requestVideoFrameCallback === "function"); };
  /** Called on every player time update: starts the frame loop when playing with live detection on. */
  D.liveTick = () => {
    const P = D.prefs();
    if (!P.enabled || !P.live || !T.player || !T.player.playing || !T.player.tiles || loopOn) return;
    if (T.search && (T.search.needBoxes ? !T.search.needBoxes() : T.search.goldShown && !T.search.goldShown())) return;   // Boxes off (and nothing to redact): live detection paused
    loopOn = true; arm();
  };

  D.clear = () => { D.tracks = []; D.live = {}; D.liveSamples = {}; D.liveTracks = {}; D.frameCache.clear(); };
  D.clearTracks = () => { D.tracks = []; };
  D.frameCache = new Map();   // "cam|t" → { conf, dets }: frames the search already ran (all classes), reused by the next search
  /** Live detections seen so far, as search rows for a class (same threshold as the search). */
  D.liveRows = (q) => {
    const cls = D.classFor(q); if (!cls) return [];
    const conf = D.classConf(cls), out = [];
    for (const [cam, list] of Object.entries(D.liveSamples || {})) for (const smp of list) {
      const mine = (smp.dets || []).filter((d) => d.label === cls && d.conf >= conf); if (!mine.length) continue;
      const top = mine.reduce((a, b) => (b.conf > a.conf ? b : a));
      out.push({ t: smp.t, cam, score: top.conf, conf: top.conf, cls: top.cls, label: top.label, det: true, live: true, count: mine.length, box: { x: top.x, y: top.y, w: top.w, h: top.h } });
    }
    return out;
  };

  // Every live detection is kept by time (per camera), so the viewer and the export look up the same detection for a
  // given moment (the export no longer only sees the last one). Nearest sample within its hold time wins.
  D.liveSamples = {};
  const MAX_SAMPLES = 3000;
  function addSample(cam, smp) {
    const list = (D.liveSamples[cam] = D.liveSamples[cam] || []);
    const i = list.findIndex((x) => Math.abs(x.t - smp.t) < 0.05);
    if (i >= 0) list[i] = smp; else { list.push(smp); list.sort((a, b) => a.t - b.t); if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES); }
  }
  D.addLiveSample = addSample;
  // Between two samples the same object (same class, overlapping or close) is moved linearly, so the box follows it smoothly
  // instead of jumping once a second; an object seen in only one of them keeps the nearer sample's box.
  const near2 = (a, b) => { if (iou(a, b) >= 0.1) return true; const dx = a.x + a.w / 2 - (b.x + b.w / 2), dy = a.y + a.h / 2 - (b.y + b.h / 2); return Math.hypot(dx, dy) < 0.75 * Math.max(a.w, a.h, b.w, b.h); };
  const MAX_GAP = 2.6;   // seconds between two samples that may be joined
  D.liveAt = (cam, t) => {
    const lv = D.live[cam];
    const list = (D.liveSamples[cam] || []).slice();
    if (lv && !list.some((x) => Math.abs(x.t - lv.t) < 0.05)) { list.push(lv); list.sort((a, b) => a.t - b.t); }
    let a = null, b = null;
    for (const x of list) { if (x.t <= t + 1e-6) a = x; else { b = x; break; } }
    if (a && b && b.t - a.t <= MAX_GAP && t > a.t + 1e-6) {
      const u = (t - a.t) / (b.t - a.t), nearA = u < 0.5, out = [];
      const pairs = [];
      a.dets.forEach((d, i) => b.dets.forEach((e, j) => { if (d.label === e.label && near2(d, e) && !sizeJump(d, e)) pairs.push([iou(d, e) + 1 / (1 + Math.hypot(d.x - e.x, d.y - e.y)), i, j]); }));
      pairs.sort((p, q) => q[0] - p[0]);
      const ua = new Set(), ub = new Set();
      for (const [, i, j] of pairs) {
        if (ua.has(i) || ub.has(j)) continue; ua.add(i); ub.add(j);
        const d = a.dets[i], e = b.dets[j], L = (k) => d[k] + (e[k] - d[k]) * u, src = nearA ? d : e;
        out.push({ ...src, x: L("x"), y: L("y"), w: L("w"), h: L("h") });
      }
      const rest = nearA ? a.dets.filter((_, i) => !ua.has(i)) : b.dets.filter((_, j) => !ub.has(j));
      const restOk = nearA ? t - a.t <= (a.hold || 1.5) : b.t - t <= (b.hold || 1.5);
      if (restOk) out.push(...rest);
      return { t, dets: out, hold: a.hold };
    }
    let best = null, bd = Infinity;
    for (const x of list) { const d = Math.abs(x.t - t); if (d <= (x.hold || 1.5) && d < bd) { bd = d; best = x; } }
    return best;
  };
  /** Export: when "Detect while playing" is on, detect along export time at the chosen speed (one camera, or every camera
   *  with "All cameras") and let the viewer/export lookup interpolate between detections. Only missing samples are run; the
   *  total is capped so a long export doesn't take forever (the spacing widens instead). */
  D.prepareLive = async (ranges, onProgress, cancelled) => {
    const P = D.prefs();
    if (!P.enabled || !P.live) return 0;
    const ev = T.player.ev;
    const cams = D.liveCamsMode() === "all" ? T.GRID.filter((c) => ev && ev.clips.some((cl) => cl.files[c] && cl.files[c].blob)) : [(T.focus && T.focus.cam) || "front"];
    const rate = { fast: 10, balanced: 5, battery: 1 }[D.speed()];
    const total = ranges.reduce((a, r) => a + (r[1] - r[0]), 0), cap = isMobile() ? 200 : 900;
    let step = 1 / rate; if ((total / step) * cams.length > cap) step = (total * cams.length) / cap;
    const hold = Math.max(0.6, step + 0.6);
    const jobs = [];
    for (const cam of cams) for (const r of ranges) for (let t = r[0]; t < r[1] + 1e-6; t += step) if (!(D.liveSamples[cam] || []).some((x) => Math.abs(x.t - t) <= step / 2)) jobs.push([cam, t]);
    D.lastPrepare = { cams, step, jobs: jobs.length, ms: 0 };
    const t0 = performance.now(); let n = 0;
    for (const [cam, t] of jobs) {   // camera by camera: the hidden video keeps its file
      if (cancelled && cancelled()) break;
      const v = await frameAt(cam, t); if (!v) { n++; continue; }
      let dets = await D.detectImage(v, v.videoWidth, v.videoHeight);
      if (T.vehicle && T.vehicle.decorateLive) { let fx = T.wb && T.wb.colourFix ? await T.wb.colourFix(t) : null; if (T.cc && T.cc.on()) { try { fx = (await T.cc.fixFor(v, v.videoWidth, v.videoHeight, t, cam, fx)) || fx; } catch (e) { console.warn("cc fix", e); } } dets = T.vehicle.decorateLive(v, v.videoWidth, v.videoHeight, dets, t, fx); }   // same colour words as the viewer (pixels untouched)
      addSample(cam, { t, dets, hold, src: "export" });
      n++; if (onProgress) onProgress(n, jobs.length, cam);
    }
    D.lastPrepare.ms = performance.now() - t0;
    return n;
  };

  // ── Settings ▸ Object detection ──
  D.renderSettings = () => {
    const box = document.getElementById("setDetect"); if (!box) return;
    const P = D.prefs();
    const insecure = window.isSecureContext === false;
    box.innerHTML = "";
    const row = (html) => { const d = document.createElement("div"); d.className = "row"; d.innerHTML = html; box.appendChild(d); return d; };
    row('<label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" id="detEnabled"' + (P.enabled ? " checked" : "") + "> Use object detection for search (car, person, truck…)</label>");
    row('<span>Model</span><select class="select" id="detModel">' + Object.entries(MODELS).map(([k, m]) => '<option value="' + k + '"' + (k === P.model ? " selected" : "") + ">" + m.label + "</option>").join("") + "</select>");
    row('<span>Confidence</span><input type="range" id="detConf" min="0.1" max="0.9" step="0.05" value="' + P.conf + '"><b id="detConfV">' + Math.round(P.conf * 100) + "%</b>");
    row('<span>Small objects</span><select class="select" id="detSmall"><option value="auto"' + (P.small === "auto" ? " selected" : "") + '>Auto (umbrella, bag, sign…: zoomed second look)</option><option value="on"' + (P.small === "on" ? " selected" : "") + '>Always zoom (5× slower)</option><option value="off"' + (P.small === "off" ? " selected" : "") + ">Off</option></select>");
    row('<label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" id="detLive"' + (P.live ? " checked" : "") + "> Detect while playing (boxes follow objects every frame)</label>");
    const lc = D.liveCamsMode(), sp = D.speed();
    row('<span>Cameras</span><select class="select" id="detLiveCams"><option value="focused"' + (lc === "focused" ? " selected" : "") + '>Focused camera' + (isMobile() ? " (default on phones)" : "") + '</option><option value="all"' + (lc === "all" ? " selected" : "") + '>All cameras, in turn' + (isMobile() ? "" : " (default on computers)") + "</option></select>");
    row('<span>Detection speed</span><select class="select" id="detSpeed">' + Object.entries(SPEEDS).map(([k, v]) => '<option value="' + k + '"' + (k === sp ? " selected" : "") + ">" + v.label + (k === "fast" ? " (as fast as it can, small 320 px model)" : k === "balanced" ? " (up to 5 a second, default)" : " (about 1 a second" + (lowPower ? ", default now: low power" : "") + ")") + "</option>").join("") + "</select>");
    const st = row('<span class="hint" id="detStatus"></span>'); st.querySelector("#detStatus").textContent = D.status || (P.enabled ? "Model loads on first search." : "Off.");
    const note = document.createElement("p"); note.className = "hint";
    note.textContent = (P.model === "gdino" ? "Grounding DINO is experimental: a large download, slow without WebGPU, not recommended on phones. " : "") +
      (insecure ? "On a plain-http address the model is still saved in IndexedDB when possible; the CLIP search model is not cached here. " : "") +
      "YOLO11 weights are AGPL-3.0 (Ultralytics). Nothing is uploaded.";
    box.appendChild(note);
    const btn = document.createElement("button"); btn.className = "btn ghost"; btn.id = "detTest"; btn.textContent = "Load model now"; box.appendChild(btn);
    btn.onclick = () => D.load().catch(() => {});
    box.querySelector("#detEnabled").onchange = (e) => D.setPref("enabled", e.target.checked);
    box.querySelector("#detModel").onchange = (e) => D.setPref("model", e.target.value);
    box.querySelector("#detConf").oninput = (e) => { box.querySelector("#detConfV").textContent = Math.round(e.target.value * 100) + "%"; };
    box.querySelector("#detConf").onchange = (e) => D.setPref("conf", +e.target.value);
    box.querySelector("#detSmall").onchange = (e) => D.setPref("small", e.target.value);
    box.querySelector("#detLive").onchange = (e) => D.setPref("live", e.target.checked);
    box.querySelector("#detLiveCams").onchange = (e) => { D.setPref("liveCams", e.target.value); D.liveTracks = {}; };
    box.querySelector("#detSpeed").onchange = (e) => { D.setPref("speed", e.target.value); if (e.target.value === "fast" && D.enabled()) D.loadFast().catch(() => {}); };
  };

  D.init = () => {
    try {
      D.renderSettings();
      if (T.on) { T.on("time", () => { D.liveTick(); }); T.on("player-open", () => D.clear()); }
    } catch (e) { console.warn("detect init", e); }
  };
})();
