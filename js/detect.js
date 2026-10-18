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
  D.unload = () => { try { worker && worker.terminate(); } catch (_) {} worker = null; wModel = null; loading = null; D.backend = null; D.info = null; for (const p of pending.values()) p.reject(new Error("detector stopped")); pending.clear(); };
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
  function letterbox(img, iw, ih, crop) {
    const S = D.config.size;
    if (!cv) { cv = document.createElement("canvas"); cv.width = cv.height = S; cx = cv.getContext("2d", { willReadFrequently: true }); }
    const c = crop || { x: 0, y: 0, w: 1, h: 1 }, sw = iw * c.w, sh = ih * c.h;
    const scale = Math.min(S / sw, S / sh), w = Math.round(sw * scale), h = Math.round(sh * scale), padX = Math.floor((S - w) / 2), padY = Math.floor((S - h) / 2);
    cx.fillStyle = "rgb(114,114,114)"; cx.fillRect(0, 0, S, S); cx.drawImage(img, iw * c.x, ih * c.y, sw, sh, padX, padY, w, h);
    iw = sw; ih = sh;
    return { rgba: cx.getImageData(0, 0, S, S).data.buffer, fit: { scale, padX, padY, w: iw, h: ih } };
  }
  /** Detect objects in a video/canvas/image. Returns [{x,y,w,h,cls,conf,label}] (0..1), or [] on any problem. */
  D.detectImage = async (img, iw, ih, opts) => {
    opts = opts || {};
    const conf = opts.conf || D.prefs().conf;
    if (D._mock) { const r = await D._mock(img, iw, ih, opts); return (r || []).map(named).filter((b) => b.conf >= conf); }
    await D.load();
    const one = async (crop) => {
      const lb = letterbox(img, iw, ih, crop);
      const r = await call({ type: "detect", rgba: lb.rgba, fit: lb.fit, conf, size: D.config.size, prompt: opts.prompt }, [lb.rgba]);
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
          if (g.hit && g.hit.boxText) { out.push({ x: b.x, y: b.y, w: b.w, h: b.h, text: String(g.hit.boxText).slice(0, 80) }); continue; }   // plates: shared label
          out.push({ x: b.x, y: b.y, w: b.w, h: b.h, text: same ? g.track.label + " " + pct(b.conf) : String(g.text).slice(0, 40) + "? (match)" });
        }
        return out;
      }
      const lv = D.live[cam];
      if (lv && Math.abs(lv.t - t) <= (lv.hold || 1.5)) return lv.dets.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, text: (b.attr ? b.attr + " " : "") + b.label + " " + pct(b.conf) }));
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
      const v = await frameAt(s.cam, s.t); if (!v) continue;
      let dets, mine;
      const conf = gd ? P.conf : D.classConf(cls);
      try {
        dets = await D.detectImage(v, v.videoWidth, v.videoHeight, { prompt: gd ? q : undefined, conf });
        mine = gd ? dets : dets.filter((d) => d.label === cls);
        // small things: if the whole frame found none, look again at 2×2 zoomed tiles
        if (!mine.length && !gd && D.useTiles(cls)) { dets = await D.detectImage(v, v.videoWidth, v.videoHeight, { conf, tiles: true, tilesOnly: true }); mine = dets.filter((d) => d.label === cls); }
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

  // ── live detection while playing (optional, throttled) ──
  let liveBusy = false, liveLast = 0;
  D.liveTick = async () => {
    const P = D.prefs();
    if (!P.enabled || !P.live || liveBusy || !T.player || !T.player.playing || !T.player.tiles) return;
    const now = performance.now(), every = isMobile() ? 2000 : 900;
    if (now - liveLast < every) return;
    liveLast = now; liveBusy = true;
    try {
      const cam = (T.focus && T.focus.cam) || "front";
      const tile = T.player.tiles[cam], v = tile && tile.vids[T.player.active];
      if (!v || !v.videoWidth) return;
      const t = T.player.time;
      let dets = await D.detectImage(v, v.videoWidth, v.videoHeight);
      if (T.vehicle && T.vehicle.decorateLive) dets = T.vehicle.decorateLive(v, v.videoWidth, v.videoHeight, dets);   // "white car 91%"
      D.live = { [cam]: { t, dets, hold: every / 1000 + 0.6 } };
      T.emit("layout");
    } catch (e) { console.warn("live detect", e); D.setPref("live", false); setStatus("Live detection turned off: " + e.message); }
    finally { liveBusy = false; }
  };

  D.clear = () => { D.tracks = []; D.live = {}; };

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
    row('<label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" id="detLive"' + (P.live ? " checked" : "") + "> Detect while playing (focused camera, " + (isMobile() ? "every 2 s" : "about once a second") + ")</label>");
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
  };

  D.init = () => {
    try {
      D.renderSettings();
      if (T.on) { T.on("time", () => { D.liveTick(); }); T.on("player-open", () => D.clear()); }
    } catch (e) { console.warn("detect init", e); }
  };
})();
