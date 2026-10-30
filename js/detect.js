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
    medium: { label: "YOLO11 medium (most accurate, ~80 MB, computers only: you choose the file once)", urls: ["models/yolo11m.onnx"], worker: "js/detect-worker.js", desktopOnly: true },
    gdino: { label: "Grounding DINO tiny (any words, experimental, ~150–200 MB)", model: "onnx-community/grounding-dino-tiny-ONNX", worker: "js/gdino-worker.js", module: true },
  };
  const D = (T.detect = { COCO, MODELS, tracks: [], live: {}, status: "", backend: null, info: null, busy: false, timings: [] });
  D.config = { ortBases: ["vendor/ort/", "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/"], tfUrl: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1", size: 640 };
  const isMobile = () => { try { return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 820); } catch (_) { return false; } };
  D.isMobile = isMobile;
  D.defaults = () => ({ enabled: false, model: isMobile() ? "nano" : "small", conf: 0.35, live: false, small: "auto", seed: "auto", occl: 3.5, byte: "on", urls: {} });
  D.prefs = () => { const d = D.defaults(); try { const v = JSON.parse(localStorage.getItem(KEY) || "null"); if (v && typeof v === "object") { if (!MODELS[v.model] || (MODELS[v.model].desktopOnly && isMobile())) delete v.model; const c = +v.conf; if (!(c >= 0.05 && c <= 0.95)) delete v.conf; return { ...d, ...v }; } } catch (_) {} return d; };
  D.setPref = (k, v) => { const p = D.prefs(); p[k] = v; try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (_) {} if (k === "model") { D.unload(); if (T.modelStore) T.modelStore.noteFailure(false); } D.renderSettings(); };
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
  let worker = null, wModel = null, seq = 0, loading = null, reidInfo = null, reidLoading = null;
  const pending = new Map();
  D.unload = () => { fastInfo = null; fastLoading = null; reidInfo = null; reidLoading = null; try { worker && worker.terminate(); } catch (_) {} worker = null; wModel = null; loading = null; D.backend = null; D.info = null; for (const p of pending.values()) p.reject(new Error("detector stopped")); pending.clear(); };
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
      if (d.type === "progress") { const mb = (x) => (x / 1048576).toFixed(1); setStatus(d.phase === "cache" || d.phase === "stored" ? "Model loaded from this device." : "Downloading model… " + mb(d.loaded) + (d.total ? " / " + mb(d.total) : "") + " MB"); return; }
      const p = pending.get(d.id); if (!p) return; pending.delete(d.id);
      d.type === "error" ? p.reject(new Error(d.error)) : p.resolve(d);
    };
    worker.onerror = (e) => {
      e.preventDefault && e.preventDefault();
      const msg = e && e.message;
      setTimeout(async () => {   // let the worker's own "fatal" report arrive first
        if (worker !== w) return;
        const why = T.workerStart ? await T.workerStart.explain(e, stage, workerHow, workerFirst, m) : msg || "the worker script could not start (" + workerHow + ")";
        if (worker !== w) return;
        const err = new Error("Detection worker failed: " + why); for (const p of pending.values()) p.reject(err); pending.clear();
        if (!msg && D.info) D.unload();   // killed by the browser: start afresh next time
      }, msg ? 0 : 400);
    }; };
    const pu = D.prefs().urls && D.prefs().urls[name] ? [D.prefs().urls[name]] : [];
    // YOLO11 medium (optional AGPL file): the file the user chose on this device → models/ next to the app → the urls pref
    const urls = name === "medium" ? (m.urls || []).concat(pu) : pu.concat(m.urls || []);
    const abs = urls.map((u) => new URL(u, location.href).href);
    setStatus("Loading " + m.label + "…");
    loading = started.then(async () => {
      wire();
      let userBlob = null, ids = abs;
      if (name === "medium" && T.modelStore) { try { const meta = await T.modelStore.meta("medium"); userBlob = meta ? await T.modelStore.blob("medium") : null; if (userBlob) ids = ["user:medium#" + (meta.added || 0)].concat(abs); } catch (_) { userBlob = null; } }
      return call({ type: "load", urls: ids, userBlob, model: m.model, ortBases: D.config.ortBases.map((u) => new URL(u, location.href).href), tfUrl: D.config.tfUrl, size: D.config.size, useCache: D.cacheOk(), preferGpu: gpuPref() }, userBlob instanceof ArrayBuffer ? [userBlob] : []); })
      .then((info) => { D.backend = info.backend; D.info = info; setStatus("Ready · " + (info.backend === "webgpu" ? "WebGPU" : "WASM (CPU)") + (info.cached ? " · from this device" : info.saved ? " · saved on this device" : "")); return info; })
      .catch((e) => {
        const MS = T.modelStore;
        if (name === "medium" && MS && MS.isMissing(e)) { MS.noteFailure(true); setStatus(MS.MSG); const n = document.getElementById("detMedPanel"); if (n) MS.render(n); }   // friendly text instead of a bare 404
        else setStatus("Detection unavailable: " + e.message);
        D.unload(); throw e; });
    return loading;
  };

  // The worker is started from a blob: URL of its fetched source, so a server sending the wrong MIME type for .js
  // (e.g. Windows python http.server) can't stop it. Falls back to a plain new Worker(url).
  let workerHow = "", workerFirst = "";
  async function makeWorker(m) {
    if (T.workerStart) { const st = await T.workerStart.start(m, "detection worker"); workerHow = st.how; workerFirst = st.first || ""; return st.worker; }
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
    fastLoading = call({ type: "load", slot: "fast", urls: [new URL("models/yolo11n-320.onnx", location.href).href, BASE + "yolo11n-320.onnx"], ortBases: D.config.ortBases.map((u) => new URL(u, location.href).href), size: 320, useCache: D.cacheOk(), preferGpu: gpuPref() })
      .then((info) => (fastInfo = info)).catch((e) => { console.warn("fast live model unavailable, using the main model", e); fastInfo = null; return null; });
    return fastLoading;
  };
  /** Person re-identification model (models/reid, Apache-2.0) in the same worker. Resolves to { backend, selfTestMs, … } or null when it can't load
   *  (the app then links cameras with the colour-histogram heuristic only). */
  /** WebGPU wanted? (the WebKit / iOS gate lives in worker-start.js gpuOk). localStorage tdc.webgpu.soft = "1" is a TEST switch: also accept a software (SwiftShader) adapter, to check the WebGPU path's numbers on machines without a GPU. */
  function gpuPref() { const ok = T.workerStart ? T.workerStart.gpuOk() : true; try { if (ok && localStorage.getItem("tdc.webgpu.soft") === "1") return "soft"; } catch (_) {} return ok; }
  D.loadReid = async () => {
    await D.load();
    if (D._mock) return D._reidMock ? (reidInfo = { backend: "mock" }) : null;
    if (reidLoading) return reidLoading;
    reidLoading = call({ type: "loadReid", urls: [new URL("models/reid/person-reidentification-retail-0288.onnx", location.href).href], ortBases: D.config.ortBases.map((u) => new URL(u, location.href).href), useCache: D.cacheOk(), preferGpu: gpuPref() })
      .then((info) => (reidInfo = info)).catch((e) => { console.warn("re-identification model unavailable, heuristic only", e); reidInfo = null; return null; });
    return reidLoading;
  };
  D.reidInfo = () => reidInfo;
  /** One embedding (Float32Array(256), L2-normalised) for a 128×256 RGBA crop (ArrayBuffer, transferred). */
  D.embed = (rgbaBuf) => D._reidMock ? Promise.resolve(D._reidMock(rgbaBuf)) : call({ type: "embed", rgba: rgbaBuf }, [rgbaBuf]).then((r) => ({ emb: new Float32Array(r.emb), ms: r.ms, backend: r.backend }));
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
  const detectRaw = async (img, iw, ih, opts) => {
    opts = opts || {};
    const conf = opts.conf || D.prefs().conf;
    if (D._mock) { const r = await D._mock(img, iw, ih, opts); return (r || []).map(named).filter((b) => b.conf >= (opts.crops && opts.cropConf ? opts.cropConf : conf) || (opts.pool > 0 && b.label === "person" && b.conf >= opts.pool && !opts.crops)); }
    await D.load();
    let slot = "main";
    if (opts.slot === "fast" && D.prefs().model !== "gdino") { const fi = await D.loadFast(); if (fi) slot = "fast"; }
    const S = slotSize(slot);
    const one = async (crop, cf) => {
      const conf0 = cf || conf;
      let r = null;
      // transferable ImageBitmap → the worker letterboxes it (no getImageData on the main thread); plain RGBA otherwise
      if (!noBitmap && typeof createImageBitmap === "function" && D.info && D.info.offscreen && !opts.prompt) {
        try {
          const bmp = await createImageBitmap(img), f = fitFor(S, iw, ih, crop);
          r = await call({ type: "detect", bitmap: bmp, lb: f.lb, fit: f.fit, conf: conf0, slot, pool: crop ? 0 : opts.pool || 0 }, [bmp]);
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
        r = await call({ type: "detect", rgba: lb.rgba, fit: lb.fit, conf: conf0, size: S, prompt: opts.prompt, slot, pool: crop ? 0 : opts.pool || 0 }, [lb.rgba]);
        D.lastPath = "rgba";
      }
      D.timings.push(r.ms); if (D.timings.length > 50) D.timings.shift();
      return crop ? r.dets.map((b) => ({ ...b, x: crop.x + b.x * crop.w, y: crop.y + b.y * crop.h, w: b.w * crop.w, h: b.h * crop.h, tiled: true })) : r.dets;
    };
    let dets = opts.tilesOnly ? [] : await one(null);
    if (opts.tiles) { for (const c of D.TILES) dets = dets.concat(await one(c)); dets = D.nms(dets, 0.5); }
    // opts.crops: zoomed second looks at given regions (hand-off cue: small or half-hidden people), own cut-off opts.cropConf
    if (opts.crops && opts.crops.length) { for (const c of opts.crops) dets = dets.concat(await one(c, opts.cropConf)); dets = D.nms(dets, 0.5); }
    return dets.map(named);
  };

  // ── legs-fix (tag legs-fix): a person walking right behind the car (REAR camera, fisheye) fills the frame with a dark, headless
  // shape that COCO models call "cat" (measured on a real frame: cat 0.87, person 0.003, in yolo11n, yolo11s and yolo11n-320), so a
  // score cut-off can't help. A cat that fills a big part of a car camera is not plausible, so a big animal box is a person candidate:
  //   "extreme" (rear: >= 20 % of the frame, other cameras: >= 30 %, and there only cat / dog / teddy bear; the rear camera takes every animal class)  → person at once;
  //   "large"   (rear: >= 10 %, or >= 5 % and 30 % tall touching an edge; other cameras 18 % / 10 % and 40 % tall) → a WEAK person that the
  //             tracker confirms over 3 looks (js/detect.js weakHit), unless a zoomed second look on the legs finds a person >= 25 %.
  // Small or distant animals are not touched. Also on the rear camera a low-scoring person box that touches the frame edge (legs only) is
  // kept as a weak look from 20 % up. localStorage tdc.legsfix=0 turns all of it off.
  const ANIMALS = new Set(["cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "teddy bear"]);
  D.LEGS = { rear: { area: 0.10, edgeArea: 0.05, extreme: 0.20 }, other: { area: 0.18, edgeArea: 0.10, extreme: 0.30 }, weakConf: 0.3, lowCut: 0.2, lookGap: 1500, lookConf: 0.25 };
  D.legsOn = () => { try { return localStorage.getItem("tdc.legsfix") !== "0"; } catch (_) { return true; } };
  const HOUSEHOLD = new Set(["cat", "dog", "teddy bear"]);   // on the side and front cameras only these: a horse or cow in a field next to the road can really fill a big part of the frame
  const edgeTouch = (d) => d.y + d.h > 0.94 || d.x < 0.02 || d.x + d.w > 0.98 || d.y < 0.02;
  /** null (leave as is), "large" or "extreme" for an animal-class box. */
  D.legsLevel = (d, cam) => {
    if (!d || !ANIMALS.has(d.label) || (cam !== "back" && !HOUSEHOLD.has(d.label))) return null;
    const L = cam === "back" ? D.LEGS.rear : D.LEGS.other, a = d.w * d.h;
    if (a >= L.extreme) return "extreme";
    if (a >= L.area || (edgeTouch(d) && a >= L.edgeArea && d.h >= (cam === "back" ? 0.3 : 0.4))) return "large";
    return null;
  };
  /** The zoomed second look: lower part of the box, padded, and the leg area. Returns the best person score found (0 if none). */
  async function legsLook(img, iw, ih, d, opts) {
    const cl = (c) => { c.w = Math.min(1, c.w); c.h = Math.min(1, c.h); c.x = Math.max(0, Math.min(1 - c.w, c.x)); c.y = Math.max(0, Math.min(1 - c.h, c.y)); return c; };
    const crops = [cl({ x: d.x - 0.3 * d.w, y: d.y + 0.4 * d.h, w: 1.6 * d.w, h: 0.7 * d.h }), cl({ x: d.x + 0.15 * d.w, y: d.y + 0.55 * d.h, w: 0.9 * d.w, h: 0.5 * d.h })];
    const r = await detectRaw(img, iw, ih, { slot: "main", crops, tilesOnly: true, cropConf: 0.15 });
    return r.filter((x) => x.label === "person").reduce((m, x) => Math.max(m, x.conf), 0);
  }
  /** (tag bytetrack) Person boxes under the cut-off, asked for with opts.pool (live viewer only): they leave the detections here and travel
   *  on the returned array as .pool, for the tracker to extend a track it already has. A weak box never becomes a detection or a track. */
  const takePool = (dets, cut, opts, keep) => {
    if (!(opts.pool > 0)) return { dets, pool: [] };
    const pool = dets.filter((d) => d.label === "person" && d.conf < cut && d.conf >= opts.pool && !(keep && keep(d)));
    return { dets: pool.length ? dets.filter((d) => !pool.includes(d)) : dets, pool };
  };
  D.detectImage = async (img, iw, ih, opts) => {
    opts = opts || {};
    const cut = opts.conf || D.prefs().conf;
    if (opts.noFix || opts.crops || opts.tilesOnly || opts.prompt || !D.legsOn()) { const r = takePool(await detectRaw(img, iw, ih, opts), cut, opts); r.dets.pool = r.pool; return r.dets; }
    const cam = opts.cam, rear = cam === "back" && !!opts.look;
    let dets = await detectRaw(img, iw, ih, rear ? { ...opts, conf: Math.min(cut, D.LEGS.lowCut) } : opts);
    const tp = takePool(dets, cut, opts, rear ? (d) => edgeTouch(d) && d.h >= 0.25 : null); dets = tp.dets;   // rear: a low person box touching the edge is a legs look (below), not a pool box
    if (rear) dets = dets.filter((d) => d.conf >= cut || (d.label === "person" && edgeTouch(d) && d.h >= 0.25)).map((d) => (d.conf < cut ? { ...d, weak: true, legs: true } : d));
    const out = D.fixAnimals ? await D.fixAnimals(dets, cam, cut, async (d) => {
      const now = performance.now(); D._legsLast = D._legsLast || {};
      if (!opts.look || now - (D._legsLast[cam] || 0) < D.LEGS.lookGap) return 0;
      D._legsLast[cam] = now;
      try { return await legsLook(img, iw, ih, d, opts); } catch (e) { if (/not loaded|stopped/.test(String(e && e.message))) throw e; return 0; }
    }, !!opts.look) : dets;
    out.pool = tp.pool;
    return out;
  };
  /** Pure part (tests): relabel big animal boxes as people. look(d) → person score of a second look (optional); live = the weak/confirm rule applies (search and export have no tracker, so they take the box as a person). */
  D.fixAnimals = async (dets, cam, cut, look, live) => {
    cut = cut || D.prefs().conf;
    const out = [], fixed = [];
    for (const d of dets) {
      const lv = D.legsLevel(d, cam);
      if (!lv) { out.push(d); continue; }
      if (dets.some((o) => o !== d && o.label === "person" && !o.weak && (iou(o, d) > 0.3 || contains(o, d)))) continue;   // a real person box is already there: drop the animal
      let ev = 0; if (look && lv === "large") ev = await look(d);
      const strong = lv === "extreme" || !live || ev >= D.LEGS.lookConf;   // live: a "large" one is weak until the tracker confirms it (3 looks)
      fixed.push({ x: d.x, y: d.y, w: d.w, h: d.h, cls: 0, label: "person", conf: strong ? Math.max(ev, Math.max(cut, 0.45)) : D.LEGS.weakConf, weak: !strong, legs: true, from: d.label, fromConf: d.conf, look: ev || undefined });
    }
    return out.concat(D.nms(fixed, 0.5));
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
      f.dets.forEach((d, di) => open.forEach((tr) => {
        if (tr.label !== d.label) return; const l = tr.pts[tr.pts.length - 1], v = iou(l, d);
        if (v >= minIou) pairs.push([v, di, tr]);
        else if (opt.near) {   // (plates, tag safari-feedback) a small object that moved more than its own width between samples: same size, close enough
          const dist = Math.hypot(l.x + l.w / 2 - d.x - d.w / 2, l.y + l.h / 2 - d.y - d.h / 2) / Math.max(l.w, d.w, 1e-3), sz = Math.max(l.w / d.w, d.w / l.w, l.h / d.h, d.h / l.h);
          if (dist <= opt.near * Math.max(1, f.t - l.t) && sz < 1.8) pairs.push([minIou * 0.5 / (1 + dist), di, tr]);
        }
      }));
      pairs.sort((a, b) => b[0] - a[0]);
      const usedD = new Set(), usedT = new Set();
      for (const [, di, tr] of pairs) { if (usedD.has(di) || usedT.has(tr)) continue; usedD.add(di); usedT.add(tr); const d = f.dets[di]; tr.pts.push({ t: f.t, x: d.x, y: d.y, w: d.w, h: d.h, conf: d.conf }); }
      // (tag bytetrack) second association: weak person boxes (f.pool, under the cut-off) extend the person tracks the strong boxes left over;
      // they never start a track, and the box keeps its size (a half-hidden person's weak box is only a part of him)
      if (f.pool && f.pool.length && opt.pool !== false) {
        const p2 = [];
        f.pool.forEach((d, di) => { if (d.label !== "person") return; open.forEach((tr) => { if (usedT.has(tr) || tr.label !== "person") return; const l = tr.pts[tr.pts.length - 1], v = D.BYTE ? btScore(l, d) : 0; if (v > 0) p2.push([v, di, tr]); }); });
        p2.sort((a, b) => b[0] - a[0]);
        const u2 = new Set();
        for (const [, di, tr] of p2) { if (u2.has(di) || usedT.has(tr)) continue; u2.add(di); usedT.add(tr); const d = f.pool[di], l = tr.pts[tr.pts.length - 1], g = D.BYTE.gain; tr.pts.push({ t: f.t, x: l.x + g * (d.x + d.w / 2 - l.x - l.w / 2), y: l.y + g * (d.y + d.h / 2 - l.y - l.h / 2), w: l.w, h: l.h, conf: d.conf }); }
      }
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
          if (g.hit && g.hit.boxText) { out.push({ x: b.x, y: b.y, w: b.w, h: b.h, text: String(T.vehicle && T.vehicle.hitText ? T.vehicle.hitText(g.hit) : g.hit.boxText).slice(0, 80), hit: g.hit }); continue; }   // plates / vehicles: shared label (vehicle colour = locked colour)
          out.push({ x: b.x, y: b.y, w: b.w, h: b.h, text: same ? g.track.label + " " + pct(b.conf) : String(g.text).slice(0, 40) + "? (match)", hit: g.hit });
        }
        return out;
      }
      const tl = T.player && T.player.playing && D.prefs().live ? D.trackedLive(cam, t) : null;
      if (tl) return tl.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, text: liveText(b), label: b.label, live: true, pid: b.id }));
      const lv = D.liveAt(cam, t);
      if (lv) return lv.dets.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, text: liveText(b), label: b.label, live: true }));
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
        let dets = []; try { dets = await D.detectImage(v, v.videoWidth, v.videoHeight, { prompt: opts.prompt, conf: hit.det && hit.label ? D.classConf(hit.label) : undefined, tiles: !!hit.tiled, pool: hit.label === "person" && !opts.prompt && D.byteOn() ? D.BYTE.floor : 0 }); } catch (e) { console.warn("track frame", e); if (!frames.length) throw e; continue; }
        frames.push({ t, dets, pool: dets.pool });
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
        else { dets = await D.detectImage(v, v.videoWidth, v.videoHeight, { prompt: gd ? q : undefined, conf, cam: s.cam }); if (!gd) D.frameCache.set(key, { conf, dets }); }
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
  D.liveCamsMode = () => { const v = D.prefs().liveCams; if (v === "all" || v === "focused") return v; if (T.handoff && T.handoff.forceAll && T.handoff.forceAll()) return "all"; return isMobile() ? "focused" : "all"; };   // unset: Sentry events (hand-off cue) track people on every camera, weighted scheduling keeps the budget
  D.liveGap = () => SPEEDS[D.speed()].gap;
  D.liveEvery = () => Math.max(D.liveGap(), D.avgMs ? D.avgMs() : 300);   // ms between two detections (one camera)
  D.avgMs = () => { const a = D.liveStats.ms.slice(-10); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; };
  D.liveStats = { starts: [], ms: [], skipped: 0, frames: 0, byCam: {} };
  D.liveRate = (sec) => { const now = performance.now(), w = (sec || 5) * 1000; return D.liveStats.starts.filter((x) => now - x <= w).length / (sec || 5); };

  const visible = (cam) => { const tl = T.player.tiles && T.player.tiles[cam]; if (!tl) return null; const v = tl.vids[T.player.active]; if (!v || !v.videoWidth || !v._url && !v.src) return null; const el = tl.tile; if (!el || el.hidden || el.classList.contains("off") || el.offsetParent === null || el.clientWidth < 4) return null; return v; };   // .off = hidden behind a focused camera (WebKit hands back blank frames for it)
  D.liveCams = () => {
    const f = (T.focus && T.focus.cam) || "front";
    if (D.liveCamsMode() === "focused") return visible(f) ? [f] : [];
    return T.GRID.filter((c) => visible(c));
  };
  const frameTime = (v, meta) => {   // event time of the frame on screen: clip start + the video's own time
    if (meta && meta.testT != null) return meta.testT;
    let t = T.player.time;
    try { const ci = T.player.clipIndexAt(t), c = T.player.ev && T.player.ev.clips[ci]; const mt = meta && isFinite(meta.mediaTime) ? meta.mediaTime : v.currentTime; if (c && isFinite(mt)) { const vt = c.start + mt; if (Math.abs(vt - t) < 1) t = vt; } } catch (_) {}
    return t;
  };

  // per-camera viewer tracker (tag live-lag: alpha-beta filter, prediction to the painted frame, damped past the next look)
  // The user's iPhone: the boxes trailed moving cars, worst in the grid. Causes: the prediction stopped after 0.5 s (in the grid
  // a camera's next look is often later than that), a missed match (the car moved more than its own width) froze the box,
  // and the speed was smoothed from the smoothed position (always behind an accelerating car). Now: position and speed are
  // corrected by the measured miss (alpha-beta), the second look and a re-found fast car take the measured speed, and the
  // box is moved to the painted frame's time on every paint, at full speed until a little after the next look is due, then
  // slowing down (no runaway when the car stopped or the detector lost it). The viewer only: the export stays frame-exact
  // (liveAt, between two real detections).
  D.liveTracks = {};
  const EMA_POS = 0.7, BETA = 0.5, EMA_SIZE = 0.4, VMAX = 2.5;   // VMAX: picture widths per second
  D.camGap = {};   // seconds between two looks at a camera (event time, smoothed)
  const gapOf = (cam) => { const n = Math.max(1, D.liveCams().length); return Math.max(D.camGap[cam] || 0, Math.min(3, n * D.liveEvery() / 1000)); };
  const expiry = (cam) => Math.max(1.2, 2.2 * gapOf(cam) + 0.4);   // ui-det: longer hold so boxes survive slow looks
  // a track whose latest looks were SECOND looks (zoomed windows, 0.5-2 s apart) must outlive the gap between them, or it flickers and every look starts a new track
  const exOf = (tr, ex) => ((tr.ls != null ? tr.ls : tr.seeded === true) ? Math.max(ex, Math.min(3, 1.5 * 10 / Math.max(1, D.seed.budget().per10) + 0.3)) : ex);
  /** Prediction on (default) or off (?pred=0 or localStorage "tdc.livePredict" = "off": boxes stay where the detector saw them). */
  D.predictOn = () => { try { if (/(?:[?&#])pred=0\b/.test(location.search + location.hash)) return false; return localStorage.getItem("tdc.livePredict") !== "off"; } catch (_) { return true; } };
  const clampV = (v) => Math.max(-VMAX, Math.min(VMAX, v));
  /** Where track tr is at event time t: full speed up to ~1.3 looks ahead, then slowing down (τ 0.3 s), at most 2 s. */
  const predictAt = (tr, t, gap) => {
    let dt = t - tr.t;
    if (dt < 0) dt = Math.max(-0.3, dt);
    else { const h = Math.max(0.4, 1.8 * (gap || 0.5)); if (dt > h) dt = h + 0.4 * (1 - Math.exp(-(dt - h) / 0.4)); dt = Math.min(4, dt); }   // ui-det: predict up to 4s
    let cx = tr.x + tr.w / 2 + tr.vx * dt, cy = tr.y + tr.h / 2 + tr.vy * dt;
    cx = Math.max(-0.02, Math.min(1.02, cx)); cy = Math.max(-0.02, Math.min(1.02, cy));
    return { x: cx - tr.w / 2, y: cy - tr.h / 2, w: tr.w, h: tr.h };
  };
  D._predictAt = predictAt;   // tests
  // ── ByteTrack-style second association (tag bytetrack) ──
  // Strong boxes (>= the confidence setting) match first, exactly as before. Then the tracks that found nothing get a second chance with the
  // WEAK person boxes (floor..cut-off) the detector returned for the tracker only: a person behind a minivan's window or a pillar scores
  // 0.15–0.34 for a second or two and used to turn into a ghost, then a second person when the strong box came back. A weak box
  //  · never starts a track and is never shown or counted as a detection by itself,
  //  · only extends a person track that once scored >= 0.5 (a headrest or coat that flickers at 0.2–0.45 must not be kept alive by weaker boxes: measured on a real clip, tag bytetrack) and was seen strongly within the last "Keep a hidden person" seconds (so a coat or headrest that scores 0.2
  //    for a minute can't keep anything alive: after that time the track is retired, weak box or not),
  //  · moves the track by a part of the miss and keeps its size (a head over a van roof is not the whole person), the speed is left alone.
  // A ghost needs two weak boxes in 3 s to come back (like the weak second looks). Switch: Settings ▸ Object detection, or ?byte=0 / ?byte=1.
  D.BYTE = { floor: 0.10, iou: 0.2, cover: 0.7, gain: 0.35, peak: 0.5 };
  D.byteOn = () => { try { const m = /(?:[?&#])byte=([01])\b/.exec(location.search + location.hash); if (m) return m[1] === "1"; } catch (_) {} return D.prefs().byte !== "off" && D.occlKeep() > 0; };
  /** Weak person box d vs the predicted box p of a track: overlap, or d lying inside p (a head-and-shoulders over a roof). 0 = no match. */
  const btScore = (p, d) => {
    const v = iou(p, d); if (v >= D.BYTE.iou) return v;
    const x1 = Math.max(p.x, d.x), y1 = Math.max(p.y, d.y), x2 = Math.min(p.x + p.w, d.x + d.w), y2 = Math.min(p.y + p.h, d.y + d.h), i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return i >= D.BYTE.cover * d.w * d.h && d.h >= 0.3 * p.h && d.w <= 1.3 * p.w ? 0.1 * i / (d.w * d.h) : 0;
  };
  D._btScore = btScore;
  function track(cam, t, dets, pool) {
    // occluded-people: a person who was tracked for a few looks and vanished (behind a car window, a pillar, another car) stays
    // in the list as a GHOST for D.occlKeep() seconds — not drawn, not counted — and takes its identity back when a person shows up
    // near where it should be. A person who walked out through the picture's edge is not kept (the hand-off cue links the next camera).
    const ex0 = expiry(cam), keep = D.occlKeep();
    const list = (D.liveTracks[cam] = (D.liveTracks[cam] || []).filter((tr) => tr.t <= t + 0.05 && !btStale(tr, t, keep) && (t - tr.seen <= exOf(tr, ex0) || ghostOk(tr, t, keep))));
    const gap = gapOf(cam);
    const pred = list.map((tr) => predictAt(tr, t, gap));
    const isGhost = list.map((tr) => t - tr.seen > exOf(tr, ex0));
    // a weak look that sits on a track we already trust adds nothing (a head-only box must not drag a good box around)
    dets = dets.filter((d) => !d.weak || !list.some((tr, j) => !tr.weak && !isGhost[j] && tr.label === d.label && iou(pred[j], d) > 0.15));
    const pairs = [];
    dets.forEach((d, i) => list.forEach((tr, j) => { if (tr.label === d.label && (near2(pred[j], d) || (isGhost[j] && ghostNear(pred[j], d, t - tr.seen)))) pairs.push([iou(pred[j], d) + (isGhost[j] ? 0 : 0.05), i, j]); }));
    pairs.sort((a, b) => b[0] - a[0]);
    const ud = new Set(), ut = new Set();
    for (const [, i, j] of pairs) {
      if (ud.has(i) || ut.has(j)) continue; ud.add(i); ut.add(j);
      let d = dets[i]; const tr = list[j], p = pred[j], dt = Math.max(1e-3, t - tr.t);
      if (isGhost[j]) {   // a hidden person: a strong look brings it back at once, weak looks need two (they are not turned into a second person meanwhile)
        if (d.weak) { if (t - (tr.rct == null ? -99 : tr.rct) > 3) tr.rc = 0; tr.rct = t; tr.rc = (tr.rc || 0) + 1; if (tr.rc < 2) continue; }
        tr.revived = (tr.revived || 0) + 1; tr.hidden = t - tr.seen; tr.rc = 0; D.seed.stats.revived++;
        if (d.weak) { d = Object.assign({}, d, { weak: false, conf: Math.max(d.conf, 0.35) }); }
      }
      const dcx = d.x + d.w / 2, dcy = d.y + d.h / 2, mdt = t - (tr.mt != null ? tr.mt : tr.t);
      // speed measured between the last two looks (raw detections, not the smoothed box)
      const vmx = mdt > 0.02 ? clampV((dcx - (tr.mcx != null ? tr.mcx : tr.x + tr.w / 2)) / mdt) : tr.vx, vmy = mdt > 0.02 ? clampV((dcy - (tr.mcy != null ? tr.mcy : tr.y + tr.h / 2)) / mdt) : tr.vy;
      if (sizeJump(p, d)) {
        // the object changed size a lot (a bus that drove past the car and pulled away): take the detection as it is.
        // Smoothing here left a frame-wide box around a small, distant bus (tag taillight-fix).
        tr.x = d.x; tr.y = d.y; tr.w = d.w; tr.h = d.h; tr.vx = 0; tr.vy = 0; tr.n = 0;
      } else if (iou(p, d) < 0.2 || (tr.n || 1) === 1) {
        // the prediction missed (a fast car moved more than its own width) or this is the second look: the detection's
        // position and the measured speed as they are (from 0 it took 3–4 looks to catch up, tag safari-feedback; a miss
        // used to stop the box until the next look, tag live-lag)
        // A miss takes the detection's position as it is; the second look (overlapping) still smooths it (EMA_POS) so a
        // parked car's jitter stays calm (test/taillight-color.js)
        const miss = iou(p, d) < 0.2, a = miss ? 1 : EMA_POS, pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
        tr.w += EMA_SIZE * (d.w - tr.w); tr.h += EMA_SIZE * (d.h - tr.h);
        tr.x = pcx + a * (dcx - pcx) - tr.w / 2; tr.y = pcy + a * (dcy - pcy) - tr.h / 2;
        tr.vx = vmx; tr.vy = vmy; if (miss) tr.n = 0;
      } else {
        // alpha-beta: correct the predicted centre and the speed by the miss (small jitter stays calm)
        const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2, rx = dcx - pcx, ry = dcy - pcy, k = BETA / Math.max(0.05, dt);
        const ncx = pcx + EMA_POS * rx, ncy = pcy + EMA_POS * ry;
        tr.vx = clampV(tr.vx + k * rx); tr.vy = clampV(tr.vy + k * ry);
        tr.w += EMA_SIZE * (d.w - tr.w); tr.h += EMA_SIZE * (d.h - tr.h); tr.x = ncx - tr.w / 2; tr.y = ncy - tr.h / 2;
      }
      tr.mcx = dcx; tr.mcy = dcy; tr.mt = t;
      if (tr.c0x == null) { tr.c0x = dcx; tr.c0y = dcy; tr.mc = 0; tr.disp = 0; } tr.mc = Math.max(tr.mc, d.conf); tr.disp = Math.max(tr.disp, Math.hypot(dcx - tr.c0x, dcy - tr.c0y));
      if (tr.label === "person" && !d.seeded && tr.disp < D.STATIC.disp && tr.mc < D.STATIC.conf && (tr.n || 1) >= 2) stillZoneNote(cam, tr, t);
      tr.t = t; tr.seen = t; tr.sst = t; tr.pk = Math.max(tr.pk || 0, d.conf); tr.ls = !!d.seeded; tr.conf = d.conf; tr.attr = d.attr; tr.clObs = d.clObs; tr.n = (tr.n || 1) + 1;
      if (d.seeded && tr.seeded !== false) { tr.seeded = true; seedPath(tr, d, t); } else if (!d.seeded && tr.weak) tr.seeded = false;
      if (tr.weak) weakHit(tr, d, t);   // multi-frame score accumulation (zoomed person looks below the normal cut-off)
      else if (d.zoom) tr.zoom = true;
    }
    // second association: weak person boxes extend the tracks the strong boxes left over (never start one)
    const wm = [];
    if (pool && pool.length && keep > 0 && D.byteOn()) {
      const cand = [];
      pool.forEach((d, i) => {
        if (d.label !== "person" || dets.some((o) => o.label === "person" && !o.weak && (iou(o, d) > 0.4 || contains(o, d)))) return;   // a strong box covers it
        list.forEach((tr, j) => { if (ut.has(j) || tr.label !== "person" || tr.weak || tr.seeded === true || (tr.n || 1) < 2 || (tr.pk || 0) < D.BYTE.peak || t - (tr.sst != null ? tr.sst : tr.seen) > keep) return; const v = btScore(pred[j], d); if (v > 0) cand.push([v + (isGhost[j] ? 0 : 0.05), i, j]); });
      });
      cand.sort((a, b) => b[0] - a[0]);
      const pu = new Set();
      for (const [, i, j] of cand) {
        if (pu.has(i) || ut.has(j)) continue; pu.add(i); ut.add(j);
        const d = pool[i], tr = list[j], p = pred[j];
        if (isGhost[j]) {   // two weak boxes within 3 s bring a hidden person back
          if (t - (tr.rct == null ? -99 : tr.rct) > 3) tr.rc = 0; tr.rct = t; tr.rc = (tr.rc || 0) + 1; if (tr.rc < 2) continue;
          tr.revived = (tr.revived || 0) + 1; tr.hidden = t - tr.seen; tr.rc = 0; D.seed.stats.revived++;
        }
        const g = D.BYTE.gain, pcx = p.x + p.w / 2, pcy = p.y + p.h / 2, dcx = d.x + d.w / 2, dcy = d.y + d.h / 2;
        tr.x = pcx + g * (dcx - pcx) - tr.w / 2; tr.y = pcy + g * (dcy - pcy) - tr.h / 2;
        tr.t = t; tr.seen = t; tr.conf = d.conf; tr.n = (tr.n || 1) + 1; tr.bt = (tr.bt || 0) + 1; tr.btt = t;
        wm.push({ x: tr.x, y: tr.y, w: tr.w, h: tr.h, cls: 0, label: "person", conf: d.conf, bt: true, id: tr.id });
      }
    }
    dets.forEach((d, i) => { if (!ud.has(i)) { const tr = { id: newId(cam), cam, first: t, sst: t, pk: d.conf, seeded: d.seeded ? true : undefined, path: d.seeded ? [{ t, x: d.x, y: d.y, w: d.w, h: d.h }] : undefined, weakLooks: d.seeded ? [{ t, d }] : undefined, weak: !!d.weak, acc: d.weak ? d.conf : 0, hits: 1, wt: t, zoom: !!d.zoom, label: d.label, x: d.x, y: d.y, w: d.w, h: d.h, vx: 0, vy: 0, t, seen: t, conf: d.conf, attr: d.attr, clObs: d.clObs, mcx: d.x + d.w / 2, mcy: d.y + d.h / 2, mt: t }; if (d.label === "person" && !d.seeded) { const z = stillZoneAt(cam, d, t); if (z) { tr.first = z.first; tr.n = z.n; tr.c0x = z.cx; tr.c0y = z.cy; tr.mc = z.mc; tr.disp = 0; } } list.push(tr); } });
    return wm;   // the weak boxes that extended a track, at the track's box (the export sees the same person the viewer draws)
  }
  D._track = track;   // tests
  D._detectLive = (cam, src, t) => detectLive(cam, src, { testT: t });
  // stable per-camera track ids ("RR3": right repeater, third track since the event opened) — the hand-off cue and the people registry key on them
  const idN = {};
  const newId = (cam) => ((T.handoff && T.handoff.SHORT && T.handoff.SHORT[cam]) || cam) + (idN[cam] = (idN[cam] || 0) + 1);
  D.resetIds = () => { for (const k of Object.keys(idN)) delete idN[k]; D.stillZones = {}; };
  // A weak person look (zoomed, score between PERSON_ZOOM_CONF and the normal cut-off) only becomes a real track once evidence adds up:
  // score = decayed sum of the looks' confidences (x0.8 per look); 3 looks within 3 s and score >= 0.55 (3 looks at >= ~0.23), or one normal-strength look.
  D.PERSON_ZOOM_CONF = 0.2;
  D.WEAK = { hits: 3, score: 0.55, window: 3, decay: 0.8 };
  // seeded looks (motion windows, js/motion.js): own thresholds (3 looks at ~0.17 add up to ~0.4) plus a walker-like path
  D.SEEDW = { hits: 3, score: 0.4, window: 3.5, decay: 0.85 };
  function seedPath(tr, d, t) { (tr.path = tr.path || []).push({ t, x: d.x, y: d.y, w: d.w, h: d.h }); if (tr.path.length > 12) tr.path.shift(); (tr.weakLooks = tr.weakLooks || []).push({ t, d }); if (tr.weakLooks.length > 12) tr.weakLooks.shift(); }
  function weakHit(tr, d, t) {
    const sd = tr.seeded === true, W = sd ? D.SEEDW : D.WEAK;
    if (t - (tr.wt || t) > W.window) { tr.acc = 0; tr.hits = 0; if (sd) { tr.path = tr.path.slice(-1); tr.weakLooks = tr.weakLooks.slice(-1); } }
    tr.wt = t; tr.hits = (tr.hits || 0) + 1; tr.acc = (tr.acc || 0) * W.decay + d.conf + (d.hint ? 0.06 : 0);
    const walks = !sd || (T.motion && T.motion.walker(tr.path));
    if (!d.weak || (tr.hits >= W.hits && tr.acc >= W.score && walks)) { tr.weak = false; tr.confirmed = true; if (sd) { D.seed.stats.confirmed++; backfill(tr); } }
  }
  /** A confirmed seeded track: the looks that built it become normal detections too, so the export and search see the person from the first look. */
  function backfill(tr) {
    const cam = tr.cam; if (!cam) return;
    for (const w of tr.weakLooks || []) {
      const smp = (D.liveSamples[cam] || []).find((x) => Math.abs(x.t - w.t) < 0.05); if (!smp) continue;
      if (smp.dets.some((o) => o.label === "person" && iou(o, w.d) > 0.3)) continue;
      smp.dets = smp.dets.concat([{ x: w.d.x, y: w.d.y, w: w.d.w, h: w.d.h, cls: 0, label: "person", conf: Math.max(w.d.conf, 0.3), zoom: true, seeded: true }]);
    }
    tr.weakLooks = undefined;
  }
  // A "person" that has not moved for STATIC.secs, never scored above STATIC.conf and was not found by motion: a headrest seen through
  // a car window, a fender, a coat on a hook (measured on a real garage clip: two such boxes sat at 0.2-0.47 for 40 s and made a second
  // "person" next to the real one). It stays in the list (it can start to move) but is neither drawn nor counted.
  D.STATIC = { secs: 5, conf: 0.5, disp: 0.03, n: 5 };
  // where such boxes were seen per camera (a box that flickers out and back re-creates its track: the zone hands the age back)
  D.stillZones = {};
  const stillZoneAt = (cam, d, t) => { const zs = D.stillZones[cam]; if (!zs) return null; for (const z of zs) if (t - z.t < 40 && t >= z.t - 0.3 && iou(z, d) > 0.5) return z; return null; };
  const stillZoneNote = (cam, tr, t) => {
    const zs = (D.stillZones[cam] = (D.stillZones[cam] || []).filter((z) => t - z.t < 40 && t >= z.t - 0.3)); let z = zs.find((q) => iou(q, tr) > 0.5);
    if (!z) { z = { first: tr.first != null ? tr.first : t, n: 0, mc: 0 }; zs.push(z); }
    z.x = tr.x; z.y = tr.y; z.w = tr.w; z.h = tr.h; z.cx = tr.c0x; z.cy = tr.c0y; z.t = t; z.n = Math.max(z.n, tr.n || 1); z.mc = Math.max(z.mc, tr.mc || 0);
    if (zs.length > 8) zs.shift();
  };
  const stillFalse = (tr, t) => tr.label === "person" && !tr.seeded && (tr.n || 1) >= D.STATIC.n && tr.c0x != null && tr.disp < D.STATIC.disp && (tr.mc || 0) < D.STATIC.conf && t - (tr.first != null ? tr.first : tr.seen) >= D.STATIC.secs;
  /** Confirmed, current person tracks as they are at event time t (predicted like the painted boxes). */
  D.personTracks = (t) => {
    const out = [], pr = D.predictOn();
    for (const cam of Object.keys(D.liveTracks)) {
      const list = D.liveTracks[cam] || [], ex = expiry(cam), gap = gapOf(cam);
      for (const tr of list) {
        if (tr.label !== "person" || tr.weak || t - tr.seen > exOf(tr, ex) || t < tr.t - 0.3 || stillFalse(tr, t)) continue;
        const b = pr ? predictAt(tr, t, gap) : tr;
        out.push({ cam, id: tr.id, x: b.x, y: b.y, w: tr.w, h: tr.h, vx: tr.vx, vy: tr.vy, n: tr.n || 1, seen: tr.seen, t, conf: tr.conf, ex: exOf(tr, ex), hist: tr.hist, emb: tr.emb, zoom: !!tr.zoom, first: tr.first != null ? tr.first : (tr.first = tr.seen) });
      }
    }
    return out;
  };
  /** Box w or h changed by more than k (default 1.6) × between two looks at the same object. */
  const sizeJump = (a, b, k) => Math.max(a.w / b.w, b.w / a.w, a.h / b.h, b.h / a.h) > (k || 1.6);   // interpolation (liveAt) uses 2.5: a fast-approaching bus still slides
  /** Live / export box label. The colour word is the vehicle's LOCKED colour (js/color-lock.js: confidence-weighted
   *  evidence over the vehicle's whole track, hysteresis before a change), so it doesn't flicker as the car moves
   *  and the viewer, the search result and the export all say the same colour. */
  const liveText = (b) => { const w = T.vehicle && T.vehicle.liveWord ? T.vehicle.liveWord(b) : b.attr; return (w ? w + " " : "") + b.label + " " + pct(b.conf); };
  D.liveText = liveText;
  /** Viewer boxes from the tracker at time t (while playing), or null when it has nothing current for this camera. */
  D.trackedLive = (cam, t) => {
    const list = D.liveTracks[cam]; if (!list || !list.length) return null;
    const ex = expiry(cam), gap = gapOf(cam), pr = D.predictOn(), out = [];
    for (const tr of list) {
      if (t - tr.seen > exOf(tr, ex) || t < tr.t - 0.3 || tr.weak || stillFalse(tr, t)) continue;
      const b = pr ? predictAt(tr, t, gap) : tr;
      out.push({ x: b.x, y: b.y, w: tr.w, h: tr.h, label: tr.label, conf: tr.conf, attr: tr.attr, clObs: tr.clObs, id: tr.id });
    }
    return out.length ? out : null;
  };


  // ── occluded-people (tag occluded-people): people behind a car window, a pillar or another car; dark garages ──
  // 1. Motion-seeded second looks. Per look at a camera a 96-px grey copy of the frame is compared with that camera's running
  //    background (js/motion.js); moving blobs (not the whole frame, not a moving car) become crop windows. A window is zoomed,
  //    contrast-enhanced (CLAHE-style, glare compressed for windows of parked cars) and shown to the person detector with a LOW cut-off
  //    (D.seed.CONF) — only there. Such a look is weak: it becomes a person after 3 looks whose score adds up and whose path looks like
  //    a walking person (moved, steady direction, upright). Backpack / handbag next to the window add a little evidence.
  // 2. Ghost tracks (see track()): a person who disappears is kept hidden for a few seconds and takes the same id back.
  // The budget: a look every ≥ 1.2 s per camera on phones (0.5 s on computers), ≤ 5 (14) seeded looks per 10 s, one window (two) per look,
  // none while the normal looks are slow (the same limits as the hand-off zoom). Off in "Battery saver" and "Fast" speed (Auto), or
  // Settings ▸ Object detection ▸ Hard-to-see people, or ?seed=off / localStorage tdc.seed = "off".
  const SD = (D.seed = { st: {}, dbg: {}, lastAt: {}, hot: {}, last: {}, pollAt: {}, flip: {}, CONF: 0.18, HINT: 0.25, HINT_CLASSES: new Set(["backpack", "handbag"]), stats: { looks: [], motionMs: [], seedMs: [], enhMs: [], throttled: 0, windows: 0, confirmed: 0, revived: 0, found: 0, polls: 0 } });
  SD.now = () => (D._clock ? D._clock() : performance.now());
  SD.mode = () => { try { const m = /(?:[?&#])seed=(off|on)\b/.exec(location.search + location.hash); if (m) return m[1]; const v = localStorage.getItem("tdc.seed"); if (v === "off" || v === "on") return v; } catch (_) {} const v = D.prefs().seed; return v === "off" || v === "on" ? v : "auto"; };
  SD.enabled = () => { const m = SD.mode(); if (m === "off" || !T.motion) return false; if (m === "on") return true; const sp = D.speed(); return sp === "balanced"; };
  SD.budget = () => { const mob = isMobile(); return mob ? { gap: 1200, per10: 5, maxWin: 1, both: false, size: 352, maxAvg: 260 } : { gap: 500, per10: 14, maxWin: 2, both: true, size: 512, maxAvg: 450 }; };
  SD.rate = () => { const now = SD.now(); return SD.stats.looks.filter((x) => now - x <= 10000).length / 10; };
  SD.allow = (cam, now) => {
    const B = SD.budget();
    if (D.avgMs && D.avgMs() > B.maxAvg) return false;   // auto-throttle: the normal looks are already slow
    if (now - (SD.lastAt[cam] || -1e9) < B.gap) return false;
    return SD.stats.looks.filter((x) => now - x <= 10000).length < B.per10;
  };
  /** Camera has fresh motion windows (looked at more often: see camMoving). */
  SD.isHot = (cam) => (SD.hot[cam] || -1e9) > SD.now() - 2500;
  SD.reset = () => { SD.st = {}; SD.dbg = {}; SD.last = {}; SD.pollAt = {}; SD.lastAt = {}; SD.hot = {}; SD.flip = {}; SD.stats = { looks: [], motionMs: [], seedMs: [], enhMs: [], throttled: 0, windows: 0, confirmed: 0, revived: 0, found: 0, polls: 0 }; };
  const push50 = (a, v) => { a.push(v); if (a.length > 50) a.shift(); };
  /** Hidden-person keep time in seconds (Settings, or ?occl=N): 0 = off. */
  D.occlKeep = () => { try { const m = /(?:[?&#])occl=([\d.]+)/.exec(location.search + location.hash); if (m) return Math.max(0, Math.min(8, +m[1])); } catch (_) {} const v = +D.prefs().occl; return v >= 0 && v <= 8 ? v : 3.5; };
  const leftEdge = (tr) => (tr.x + tr.w > 0.96 && tr.vx > 0.01) || (tr.x < 0.04 && tr.vx < -0.01) || (tr.y + tr.h > 0.97 && tr.vy > 0.02);
  const btStale = (tr, t, keep) => tr.sst != null && tr.btt != null && t - tr.sst > Math.max(keep, 0);   // kept alive by weak boxes only for longer than "keep a hidden person": retire
  const ghostOk = (tr, t, keep) => keep > 0 && tr.label === "person" && !tr.weak && (tr.n || 1) >= 3 && t - tr.seen <= keep && !leftEdge(tr);
  const ghostNear = (p, d, hid) => Math.hypot(p.x + p.w / 2 - d.x - d.w / 2, p.y + p.h / 2 - d.y - d.h / 2) < 0.75 * Math.max(p.w, p.h, d.w, d.h) + 0.06 * Math.min(hid, 6) && !sizeJump(p, d, 2.2);
  /** Hidden (ghost) people of a camera at event time t, as boxes where they should be now. */
  D.ghostsAt = (cam, t) => {
    const ex = expiry(cam), keep = D.occlKeep(), gap = gapOf(cam);
    return (D.liveTracks[cam] || []).filter((tr) => t - tr.seen > exOf(tr, ex) && ghostOk(tr, t, keep)).map((tr) => Object.assign(predictAt(tr, t, gap), { id: tr.id, age: t - tr.seen }));
  };
  const frameSize = (v) => ({ iw: v.videoWidth || v.width, ih: v.videoHeight || v.height });
  /** Motion step + (when the budget allows) zoomed, enhanced second looks. dets: this look's normal detections. Returns weak seeded person looks. */
  /** Cheap motion check of a camera that is not being looked at (about 0.3 ms): a camera with motion that no known person explains is looked at more often (camMoving). */
  SD.pollGap = () => (isMobile() ? 400 : 250);
  SD.poll = (cam, v, t) => {
    const M = T.motion; if (!M || !SD.enabled() || !v) return;
    const now = SD.now(); if (now - (SD.pollAt[cam] || -1e9) < SD.pollGap()) return; SD.pollAt[cam] = now;
    const { iw, ih } = frameSize(v), t0 = performance.now(), g = M.grab(v, iw, ih); if (!g) return;
    const r = M.step(SD.st[cam] || (SD.st[cam] = M.newState()), g.gray, g.w, g.h, t); SD.last[cam] = { wall: now, r }; push50(SD.stats.motionMs, performance.now() - t0); SD.stats.polls++;
    const lv = D.live[cam], wins = M.windows(r.blobs, (lv && lv.dets) || [], D.ghostsAt(cam, t).slice(0, 2));
    if (wins.length) SD.hot[cam] = now;
  };
  D.pollMotion = (t) => { for (const c of D.liveCams()) { const v = visible(c); if (v) SD.poll(c, v, t == null ? v.currentTime : t); } };
  D._poll = (cam, src, t) => SD.poll(cam, src, t);
  async function seedLooks(cam, v, t, dets, fast) {
    const M = T.motion, out = [];
    if (!M || !SD.enabled()) return out;
    const { iw, ih } = frameSize(v), now = SD.now(), dbg = (SD.dbg[cam] = { t, wall: now, blobs: [], wins: [], note: "", global: false });
    const t0 = performance.now(), lm = SD.last[cam];
    let r;
    if (lm && now - lm.wall < 100) r = lm.r;   // the background poll just did this
    else { const g = M.grab(v, iw, ih); if (!g) { dbg.note = "no pixels"; return out; } r = M.step(SD.st[cam] || (SD.st[cam] = M.newState()), g.gray, g.w, g.h, t); SD.last[cam] = { wall: now, r }; push50(SD.stats.motionMs, performance.now() - t0); }
    dbg.blobs = r.blobs.slice(0, 6).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h })); dbg.global = !!r.global; dbg.thr = r.thr;
    const ghosts = D.ghostsAt(cam, t).slice(0, 2), wins = M.windows(r.blobs, dets, ghosts);
    if (!wins.length) return out;
    SD.hot[cam] = now; SD.stats.windows += wins.length;
    if (!SD.allow(cam, now)) { dbg.note = "throttled"; SD.stats.throttled++; dbg.wins = wins.map((w) => ({ kind: w.kind, box: w.box, skipped: true })); return out; }
    SD.lastAt[cam] = now; SD.stats.looks.push(now); if (SD.stats.looks.length > 200) SD.stats.looks.shift();
    const B = SD.budget(), t1 = performance.now();
    const blobWins = wins.filter((w) => w.kind !== "ghost"), ghostWins = wins.filter((w) => w.kind === "ghost");
    // one window per look on phones: a ghost's expected spot and a motion blob take turns
    let pick = blobWins.concat(ghostWins);
    if (B.maxWin === 1 && blobWins.length && ghostWins.length && (SD.flip[cam + "g"] = !SD.flip[cam + "g"])) pick = ghostWins;
    pick = pick.slice(0, B.maxWin);
    for (const w of pick) {
      const rec = { kind: w.kind, box: w.box, glass: w.glass, crops: [] }; dbg.wins.push(rec);
      const scales = B.both ? [1, 2] : [(SD.flip[cam] = !SD.flip[cam]) ? 1 : 2];
      let bestP = null, bestH = null;
      for (const sc of scales) {
        const crop = M.cropFor(w.box, sc, 1.2), te = performance.now();
        const cc = M.cropCanvas(v, iw, ih, crop, B.size, { glare: !!w.glass });
        if (!cc) continue; push50(SD.stats.enhMs, performance.now() - te);
        let rd = []; try { rd = await detectRaw(cc.canvas, cc.w, cc.h, { slot: fast ? "fast" : "main", conf: 0.12 }); } catch (e) { if (/not loaded|stopped/.test(String(e && e.message))) throw e; }
        const map = (b) => ({ ...b, x: crop.x + b.x * crop.w, y: crop.y + b.y * crop.h, w: b.w * crop.w, h: b.h * crop.h });
        const ppl = rd.filter((b) => b.label === "person").map(map), hints = rd.filter((b) => SD.HINT_CLASSES.has(b.label) && b.conf >= SD.HINT).map(map);
        const near = (b) => { const bx = b.x + b.w / 2, by = b.y + b.h / 2, e = 0.5 * sc; return bx >= w.box.x - e * w.box.w - 0.03 && bx <= w.box.x + w.box.w * (1 + e) + 0.03 && by >= w.box.y - e * w.box.h - 0.03 && by <= w.box.y + w.box.h * (1 + e) + 0.03; };
        const okP = ppl.filter((b) => b.conf >= SD.CONF && b.h >= 0.04 && (w.kind === "ghost" || near(b)) && !dets.some((o) => o.label === "person" && !o.weak && (iou(o, b) > 0.3 || contains(o, b))));
        rec.crops.push({ scale: sc, crop, enh: !cc.stats.skipped, person: ppl.length ? +Math.max(...ppl.map((b) => b.conf)).toFixed(2) : 0, hint: hints.length ? +Math.max(...hints.map((b) => b.conf)).toFixed(2) : 0, kept: okP.length });
        for (const b of okP) if (!bestP || b.conf > bestP.conf) bestP = b;
        for (const b of hints) if (near(b) && (!bestH || b.conf > bestH.conf)) bestH = b;
      }
      if (bestP) { out.push({ x: bestP.x, y: bestP.y, w: bestP.w, h: bestP.h, cls: 0, label: "person", conf: bestP.conf, weak: true, seeded: true, zoom: true, hint: !!bestH, win: w.kind }); SD.stats.found++; rec.person = +bestP.conf.toFixed(2); }
      else if (bestH && w.kind !== "ghost" && w.box.h >= 0.08) { out.push({ x: w.box.x, y: w.box.y, w: w.box.w, h: w.box.h, cls: 0, label: "person", conf: 0.2, weak: true, seeded: true, zoom: true, hint: true, win: "hint" }); rec.hint = +bestH.conf.toFixed(2); }
    }
    push50(SD.stats.seedMs, performance.now() - t1);
    dbg.ms = Math.round(performance.now() - t0);
    return out;
  }

  let liveBusy = false, liveLast = 0, rr = 0, loopOn = false, loopVid = null;
  async function detectLive(cam, v, meta) {
    const t = frameTime(v, meta), t0 = performance.now();
    D.liveStats.starts.push(t0); if (D.liveStats.starts.length > 200) D.liveStats.starts.shift();
    const bc = (D.liveStats.byCam[cam] = D.liveStats.byCam[cam] || []); bc.push(t0); if (bc.length > 60) bc.shift();
    const fast = D.speed() === "fast" && D.prefs().model !== "gdino";
    const fs0 = frameSize(v);
    let dets = await D.detectImage(v, fs0.iw, fs0.ih, { slot: fast ? "fast" : "main", cam, look: true, pool: D.byteOn() ? D.BYTE.floor : 0 });
    const pool = dets.pool || [];
    let weakDets = dets.filter((d) => d.weak); if (weakDets.length) dets = dets.filter((d) => !d.weak);   // legs-fix: weak person looks wait for 3-look confirmation
    try {
      const plan = T.handoff && T.handoff.zoomPlan ? T.handoff.zoomPlan(cam, dets, t) : null;
      if (plan && plan.length) {
        const pz = D.PERSON_ZOOM_CONF, cut = D.prefs().conf;
        let zd = await D.detectImage(v, fs0.iw, fs0.ih, { slot: fast ? "fast" : "main", crops: plan, tilesOnly: true, cropConf: pz });
        zd = zd.filter((d) => d.label === "person" && d.conf >= pz && !dets.some((o) => o.label === "person" && (iou(o, d) > 0.35 || contains(o, d))));
        for (const d of zd) { d.zoom = true; if (d.conf >= cut) dets.push(d); else { d.weak = true; weakDets.push(d); } }   // strong zoomed people join the normal detections
        D.liveStats.zoom = (D.liveStats.zoom || 0) + 1;
      }
    } catch (e) { if (/not loaded|stopped/.test(String(e && e.message))) throw e; }
    try { const sw = await seedLooks(cam, v, t, dets, fast); if (sw.length) weakDets = weakDets.concat(sw); } catch (e) { if (/not loaded|stopped/.test(String(e && e.message))) throw e; console.warn("seeded look", e); }
    D.liveStats.ms.push(performance.now() - t0); if (D.liveStats.ms.length > 50) D.liveStats.ms.shift();
    if (T.vehicle && T.vehicle.decorateLive) dets = T.vehicle.decorateLive(v, fs0.iw, fs0.ih, dets, t, undefined, cam);   // "white car 91%" (colour after white balance when known)
    const n = Math.max(1, D.liveCams().length), hold = Math.max(0.6, 0.6 + (n * D.liveEvery()) / 1000);
    const prev = D.live[cam]; if (prev && t > prev.t && t - prev.t < 3) D.camGap[cam] = D.camGap[cam] ? 0.7 * D.camGap[cam] + 0.3 * (t - prev.t) : t - prev.t;
    D.live[cam] = { t, dets, hold, src: "live" };
    addSample(cam, D.live[cam]);
    const wm = track(cam, t, weakDets.length ? dets.concat(weakDets) : dets, pool);
    if (wm && wm.length) D.live[cam].dets = dets.concat(wm);   // (tag bytetrack) a person the tracker kept through weak boxes is in the export's sample too
    // while playing the boxes are repainted on every frame ("time"); a "layout" here would also re-place the dock/bar
    if (!T.player || !T.player.playing) T.emit("layout");
  }
  // Which camera looks next (tag live-lag). Was a plain round robin: in the 6-camera grid the camera with the moving car
  // got one look in six (about 1 per second on the user's iPhone) like five cameras showing parked cars. Now the camera
  // that has waited longest, weighted: a camera with a moving box ×1, one with a new box (speed not known yet) ×0.6, a
  // still or empty camera ×0.25 (still looked at, so new cars appear), and the tile's size on screen (√ of its share of
  // the largest tile, at least 0.4). One camera, or Focused camera: every look goes to it.
  const lastLook = {};
  D.camMoving = (cam) => { const list = D.liveTracks[cam] || []; let m = SD.isHot(cam) ? 0.8 : 0; for (const tr of list) { if ((tr.n || 1) < 2 || tr.weak) m = Math.max(m, 0.6); else if (Math.hypot(tr.vx, tr.vy) > 0.02) return 1; } return m || 0.25; };
  D.lastLook = lastLook;
  function pickCam(cams) {
    if (cams.length === 1) return cams[0];
    const now = performance.now(), area = {}; let amax = 1;
    for (const c of cams) { const el = T.player.tiles[c].tile; area[c] = Math.max(1, el.clientWidth * el.clientHeight); amax = Math.max(amax, area[c]); }
    let best = cams[rr++ % cams.length], bs = -1;
    for (const c of cams) {
      const age = lastLook[c] == null ? 1e9 : now - lastLook[c];
      const sc = age * D.camMoving(c) * Math.max(0.4, Math.sqrt(area[c] / amax)) * (T.handoff && T.handoff.boost ? T.handoff.boost(c) : 1);   // ×(1..2.5): the neighbour of a camera someone is leaving
      if (sc > bs) { bs = sc; best = c; }
    }
    lastLook[best] = now;
    return best;
  }
  function onFrame(now, meta) {
    if (!loopOn) return;
    const P = D.prefs();
    const boxesOff = T.search && (T.search.needBoxes ? !T.search.needBoxes() : T.search.goldShown && !T.search.goldShown()) && !(T.handoff && T.handoff.wantsLive && T.handoff.wantsLive());   // nothing outlined or blurred: save the power
    if (!P.enabled || !P.live || !T.player || !T.player.playing || boxesOff) { loopOn = false; loopVid = null; return; }
    D.liveStats.frames++;
    try { D.pollMotion(); } catch (_) {}
    const cams = D.liveCams();
    if (liveBusy || !cams.length || performance.now() - liveLast < D.liveGap()) { if (liveBusy) D.liveStats.skipped++; return arm(); }
    const cam = pickCam(cams), v = visible(cam);
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
  /** One live detection on the current (paused) frame of a camera (prewarm.js: boxes before the first play). */
  D.detectOnce = async (cam) => {
    const v = visible(cam); if (!v || liveBusy || v.readyState < 2) return false;
    liveBusy = true;
    try { await detectLive(cam, v, null); return true; } finally { liveBusy = false; }
  };
  /** ?debug=det: what the second-look machinery sees now (js/det-debug.js draws it on the tiles). Boxes are fractions of the picture. */
  D.debugSeed = (t) => {
    const now = SD.now(), cams = {}, st = SD.stats;
    for (const c of D.liveCams()) {
      const lm = SD.last[c], dbg = SD.dbg[c], fresh = lm && now - lm.wall < 1500;
      cams[c] = { motion: fresh ? lm.r.blobs.slice(0, 6).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h })) : [], global: !!(fresh && lm.r.global), hot: SD.isHot(c), ghosts: D.ghostsAt(c, t == null ? 0 : t).map((g) => ({ x: g.x, y: g.y, w: g.w, h: g.h, hidden: +g.age.toFixed(1) })),
        wins: dbg && now - dbg.wall < 2500 ? dbg.wins.map((w) => ({ kind: w.kind, box: w.box, skipped: !!w.skipped, glass: !!w.glass, person: w.person || 0, hint: w.hint || 0, crops: (w.crops || []).map((k) => ({ scale: k.scale, crop: k.crop, person: k.person, hint: k.hint, enh: k.enh })) })) : [], note: dbg && now - dbg.wall < 2500 ? dbg.note : "" };
    }
    const avg = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null);
    return { on: SD.enabled(), mode: SD.mode(), occl: D.occlKeep(), rate: +SD.rate().toFixed(2), budget: SD.budget(), polls: st.polls, looks: st.looks.length, windows: st.windows, throttled: st.throttled, found: st.found, confirmed: st.confirmed, revived: st.revived, motionMs: avg(st.motionMs), enhMs: avg(st.enhMs), seedMs: avg(st.seedMs), cams };
  };
  /** ?debug=det readout (js/det-debug.js): backend, frame path, threads, per-camera looks per second, inference time, prediction. */
  D.debugInfo = () => {
    const now = performance.now(), hz = (a) => +((a || []).filter((x) => now - x <= 3000).length / 3).toFixed(1), avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
    const cams = {};
    for (const c of T.GRID) { const tl = T.player && T.player.tiles && T.player.tiles[c]; if (!tl || tl.tile.classList.contains("off")) continue; cams[c] = { hz: hz(D.liveStats.byCam[c]), gap: D.camGap[c] ? Math.round(D.camGap[c] * 1000) : null, tracks: (D.liveTracks[c] || []).length, moving: D.camMoving(c) === 1, px: tl.tile.clientWidth + "×" + tl.tile.clientHeight }; }
    const fi = fastInfo || null, P = D.prefs();
    return { backend: (D.speed() === "fast" && fi ? fi.backend : D.backend) || (D._mock ? "mock" : "not loaded"), model: D.speed() === "fast" && fi ? "yolo11n-" + (fi.size || 320) : P.model, input: slotSize(D.speed() === "fast" && fi ? "fast" : "main"),
      threads: (fi || D.info || {}).threads || null, path: D.lastPath || null, coi: !!self.crossOriginIsolated, secure: !!self.isSecureContext, gpuApi: !!navigator.gpu, gpuAllowed: T.workerStart ? T.workerStart.gpuOk() : null,
      speed: D.speed(), camsMode: D.liveCamsMode(), live: !!(P.enabled && P.live), playing: !!(T.player && T.player.playing), totalHz: +D.liveRate(3).toFixed(1),
      lookMs: avg(D.liveStats.ms.slice(-10)), inferMs: avg(D.timings.slice(-10)), skipped: D.liveStats.skipped, predict: D.predictOn(), cams };
  };
  D.liveRVFC = () => { const cams = D.liveCams(), v = cams.length ? visible(cams[0]) : null; return !!(v && typeof v.requestVideoFrameCallback === "function"); };
  /** Called on every player time update: starts the frame loop when playing with live detection on. */
  D.liveTick = () => {
    if (loopOn && performance.now() - liveLast > 8000 && T.player && T.player.playing) { loopOn = false; loopVid = null; }   // ui-det: stalled loop restarts
    const P = D.prefs();
    if (!P.enabled || !P.live || !T.player || !T.player.playing || !T.player.tiles || loopOn) return;
    if (T.search && (T.search.needBoxes ? !T.search.needBoxes() : T.search.goldShown && !T.search.goldShown()) && !(T.handoff && T.handoff.wantsLive && T.handoff.wantsLive())) return;   // Boxes off (and nothing to redact, no hand-off cue): live detection paused
    loopOn = true; arm();
  };

  D.clear = () => { D.resetIds && D.resetIds(); SD.reset(); D.tracks = []; D.live = {}; D.liveSamples = {}; D.liveTracks = {}; D.camGap = {}; D.frameCache.clear(); if (T.colorLock) T.colorLock.clear(); };
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
      a.dets.forEach((d, i) => b.dets.forEach((e, j) => { if (d.label === e.label && near2(d, e) && !sizeJump(d, e, 2.5)) pairs.push([iou(d, e) + 1 / (1 + Math.hypot(d.x - e.x, d.y - e.y)), i, j]); }));
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
      if (T.vehicle && T.vehicle.decorateLive) { let fx = T.wb && T.wb.colourFix ? await T.wb.colourFix(t) : null; if (T.cc && T.cc.on()) { try { fx = (await T.cc.fixFor(v, v.videoWidth, v.videoHeight, t, cam, fx)) || fx; } catch (e) { console.warn("cc fix", e); } } dets = T.vehicle.decorateLive(v, v.videoWidth, v.videoHeight, dets, t, fx, cam); }   // same colour words as the viewer (pixels untouched)
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
    row('<span>Model</span><select class="select" id="detModel">' + Object.entries(MODELS).filter(([, m]) => !(m.desktopOnly && isMobile())).map(([k, m]) => '<option value="' + k + '"' + (k === P.model ? " selected" : "") + ">" + m.label + "</option>").join("") + "</select>");
    if (P.model === "medium" && T.modelStore && !isMobile()) { const mp = document.createElement("div"); mp.id = "detMedPanel"; box.appendChild(mp); T.modelStore.render(mp); }   // js/model-picker.js
    row('<span>Confidence</span><input type="range" id="detConf" min="0.1" max="0.9" step="0.05" value="' + P.conf + '"><b id="detConfV">' + Math.round(P.conf * 100) + "%</b>");
    row('<span>Small objects</span><select class="select" id="detSmall"><option value="auto"' + (P.small === "auto" ? " selected" : "") + '>Auto (umbrella, bag, sign…: zoomed second look)</option><option value="on"' + (P.small === "on" ? " selected" : "") + '>Always zoom (5× slower)</option><option value="off"' + (P.small === "off" ? " selected" : "") + ">Off</option></select>");
    row('<label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" id="detLive"' + (P.live ? " checked" : "") + "> Detect while playing (boxes follow objects every frame)</label>");
    const lc = D.liveCamsMode(), sp = D.speed();
    row('<span>Cameras</span><select class="select" id="detLiveCams"><option value="focused"' + (lc === "focused" ? " selected" : "") + '>Focused camera' + (isMobile() ? " (default on phones)" : "") + '</option><option value="all"' + (lc === "all" ? " selected" : "") + '>All cameras, in turn' + (isMobile() ? "" : " (default on computers)") + "</option></select>");
    row('<span>Detection speed</span><select class="select" id="detSpeed">' + Object.entries(SPEEDS).map(([k, v]) => '<option value="' + k + '"' + (k === sp ? " selected" : "") + ">" + v.label + (k === "fast" ? " (as fast as it can, small 320 px model)" : k === "balanced" ? " (up to 5 a second, default)" : " (about 1 a second" + (lowPower ? ", default now: low power" : "") + ")") + "</option>").join("") + "</select>");
    const sm = SD.mode(), oc = D.occlKeep();
    row('<span>Hard-to-see people</span><select class="select" id="detSeed"><option value="auto"' + (P.seed === "auto" || !P.seed ? " selected" : "") + '>Auto (zoomed, brightened second looks at moving things; Balanced speed)</option><option value="on"' + (P.seed === "on" ? " selected" : "") + '>Always (any speed)</option><option value="off"' + (P.seed === "off" ? " selected" : "") + ">Off</option></select>");
    row('<span>Keep a hidden person</span><select class="select" id="detOccl">' + [[0, "Off"], [2, "2 seconds"], [3.5, "3.5 seconds (default)"], [6, "6 seconds"]].map(([v, l]) => '<option value="' + v + '"' + (oc === v ? " selected" : "") + ">" + l + "</option>").join("") + "</select>");
    row('<label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" id="detByte"' + (D.byteOn() ? " checked" : "") + (oc > 0 ? "" : " disabled") + "> Follow half-hidden people (behind a van window or pillar: same number; needs “Keep a hidden person”)</label>");
    const cc = row('<label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" id="detCross"' + (T.people && T.people.linkOn && T.people.linkOn() ? " checked" : "") + "> Cross-camera matching (beta): the same person keeps one colour on every camera</label>");
    const cs = document.createElement("span"); cs.className = "hint"; cs.id = "detCrossStatus"; cs.style.display = "block"; cs.textContent = T.reid && T.reid.statusText ? T.reid.statusText() : ""; cc.appendChild(cs);
    const ch = document.createElement("span"); ch.className = "hint"; ch.style.display = "block"; ch.textContent = "Default: on when this device keeps up, off when it would slow playback. Uses a small appearance model (0.8 MB, Apache-2.0) stored with the app; nothing is uploaded."; cc.appendChild(ch);
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
    box.querySelector("#detSeed").onchange = (e) => D.setPref("seed", e.target.value);
    box.querySelector("#detOccl").onchange = (e) => D.setPref("occl", +e.target.value);
    box.querySelector("#detByte").onchange = (e) => D.setPref("byte", e.target.checked ? "on" : "off");
    box.querySelector("#detSmall").onchange = (e) => D.setPref("small", e.target.value);
    box.querySelector("#detCross").onchange = (e) => { T.setPref("crossCam", e.target.checked ? "on" : "off"); if (T.people && T.people.reset) T.people.reset(); const c = box.querySelector("#detCrossStatus"); if (c && T.reid) c.textContent = T.reid.statusText(); };
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
