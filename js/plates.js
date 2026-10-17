/* plates.js — Phase 6: licence plates and street names, on this device.
 *  - Plate detector: open-image-models YOLOv9-tiny licence-plate model (MIT), "end2end" ONNX (NMS inside).
 *  - Plate reader: fast-plate-ocr CCT-S global model (MIT), 10 character slots, with per-character confidence.
 *  - Street names / sign text: the PP-OCR text finder already bundled for redaction (redact.js).
 * Off until Settings ▸ Plates & text (beta) is turned on. Runs in its own Web Worker (same MIME-proof start as
 * Phase 5), models cached in IndexedDB. Results go to the library's text index (metadata only: text, time,
 * camera, box, confidence — no images). Any failure → plate search says why, everything else works as before. */
(function () {
  "use strict";
  const T = (window.TDC = window.TDC || {});
  const KEY = "tdc.plates.v1";
  const BASE = "https://raw.githubusercontent.com/shinrajp/dashcam-studio/feature/phase6-plates-ocr/models/plates/";
  const MODELS = {
    fast: { label: "Fast (384 px, phones, ~8 MB)", file: "yolo-v9-t-384-license-plates-end2end.onnx" },
    accurate: { label: "Accurate (640 px, computers, ~8 MB)", file: "yolo-v9-t-640-license-plates-end2end.onnx" },
  };
  const OCR = { label: "Plate reader (CCT-S, ~5 MB)", file: "cct_s_v2_global.onnx", w: 128, h: 64 };
  const CAM_LABEL = { front: "Front", back: "Rear", left_repeater: "Left", right_repeater: "Right", left_pillar: "Left pillar", right_pillar: "Right pillar" };
  const PT = () => T.plateText;
  const isMobile = () => (T.detect && T.detect.isMobile ? T.detect.isMobile() : /iPhone|iPad|Android/i.test(navigator.userAgent));
  const L = (T.plates = { MODELS, OCR, BASE, status: "", info: null, scanning: false, blurTracks: {}, timings: { det: [], ocr: [] } });

  L.defaults = () => ({ enabled: false, model: isMobile() ? "fast" : "accurate", conf: 0.3, minRead: 0.4, far: "auto", street: false, blur: false, urls: {} });
  L.prefs = () => { const d = L.defaults(); try { const v = JSON.parse(localStorage.getItem(KEY) || "null"); if (v && typeof v === "object") { if (!MODELS[v.model]) delete v.model; return { ...d, ...v }; } } catch (_) {} return d; };
  L.setPref = (k, v) => { const p = L.prefs(); p[k] = v; try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (_) {} if (k === "model") L.unload(); L.renderSettings(); L.syncExport(); if (k === "blur" || k === "enabled") T.emit && T.emit("layout"); };
  L.enabled = () => L.prefs().enabled === true;
  L.blurOn = () => { const p = L.prefs(); return p.enabled && p.blur; };
  /** Queries Phase 6 answers: "plate 7AB*", "7ABC 23", "plates", "street Palm Ave". */
  L.parse = (q) => (PT() ? PT().parseQuery(q) : null);
  L.handlesQuery = (q) => L.enabled() && !!L.parse(q);

  function setStatus(s) { L.status = s; const n = document.getElementById("plStatus"); if (n) n.textContent = s; }
  L.setStatus = setStatus;

  // ── worker ──
  let worker = null, seq = 0, loading = null, loadedModel = null;
  const pending = new Map();
  L.unload = () => { try { worker && worker.terminate(); } catch (_) {} worker = null; loading = null; loadedModel = null; L.info = null; for (const p of pending.values()) p.reject(new Error("plate reader stopped")); pending.clear(); };
  const call = (msg, transfer) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }, transfer || []); });
  const urlsFor = (file, custom) => (custom ? [custom] : []).concat(["models/plates/" + file].concat(L.BASE ? [L.BASE + file] : [])).map((u) => new URL(u, location.href).href);
  async function startWorker() {
    const m = { worker: "js/detect-worker.js" };
    if (T.detect && T.detect.makeWorker) return T.detect.makeWorker(m);
    return new Worker(m.worker);
  }
  /** Load (once) detector + reader. Rejects with a readable reason. */
  L.load = () => {
    if (L._mock) return Promise.resolve((L.info = { backend: "mock", size: 640 }));
    const P = L.prefs(), name = P.model;
    if (loading && loadedModel === name) return loading;
    L.unload();
    if (typeof Worker === "undefined") return Promise.reject(new Error("This browser can't run background workers, so plate reading is off."));
    loadedModel = name;
    const D = T.detect || {}, cfg = D.config || { ortBases: ["vendor/ort/"] };
    const useCache = D.cacheOk ? D.cacheOk() : true;
    setStatus("Loading the plate finder…");
    loading = startWorker().then((w) => {
      worker = w;
      worker.onmessage = (e) => {
        const d = e.data || {};
        if (d.type === "fatal") { const err = new Error(d.error); for (const p of pending.values()) p.reject(err); pending.clear(); return; }
        if (d.type === "progress") { if (d.phase !== "cache") setStatus("Downloading " + (d.what === "ocr" ? "plate reader" : "plate finder") + "… " + (d.loaded / 1048576).toFixed(1) + (d.total ? " / " + (d.total / 1048576).toFixed(1) : "") + " MB"); return; }
        const p = pending.get(d.id); if (!p) return; pending.delete(d.id);
        d.type === "error" ? p.reject(new Error(d.error)) : p.resolve(d);
      };
      worker.onerror = (e) => { e.preventDefault && e.preventDefault(); const err = new Error("Plate worker failed: " + (e.message || "could not start")); for (const p of pending.values()) p.reject(err); pending.clear(); };
      const ortBases = cfg.ortBases.map((u) => new URL(u, location.href).href);
      return call({ type: "load", urls: urlsFor(MODELS[name].file, P.urls && P.urls[name]), ortBases, useCache, preferGpu: !isMobile() })
        .then((det) => call({ type: "loadOcr", urls: urlsFor(OCR.file, P.urls && P.urls.ocr), ortBases, useCache }).then((ocr) => ({ ...det, ocr })));
    }).then((info) => {
      L.info = info;
      setStatus("Ready · " + (info.backend === "webgpu" ? "WebGPU" : "WASM (CPU)") + " · " + MODELS[name].label.split(" (")[0] + (info.cached && info.ocr && info.ocr.cached ? " · from this device" : info.saved ? " · saved on this device" : ""));
      return info;
    }).catch((e) => { setStatus("Plate reading unavailable: " + e.message); L.unload(); throw e; });
    return loading;
  };

  // ── frames → plates ──
  let lbc = null, lbx = null;
  function letterbox(img, iw, ih, S, crop) {
    if (!lbc || lbc.width !== S) { lbc = document.createElement("canvas"); lbc.width = lbc.height = S; lbx = lbc.getContext("2d", { willReadFrequently: true }); }
    const c = crop || { x: 0, y: 0, w: 1, h: 1 }, sw = iw * c.w, sh = ih * c.h;
    const scale = Math.min(S / sw, S / sh), w = Math.round(sw * scale), h = Math.round(sh * scale), padX = Math.floor((S - w) / 2), padY = Math.floor((S - h) / 2);
    lbx.fillStyle = "rgb(114,114,114)"; lbx.fillRect(0, 0, S, S); lbx.drawImage(img, iw * c.x, ih * c.y, sw, sh, padX, padY, w, h);
    return { rgba: lbx.getImageData(0, 0, S, S).data.buffer, fit: { scale, padX, padY, w: sw, h: sh } };
  }
  const iou = (a, b) => { const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h); const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (a.w * a.h + b.w * b.h - i || 1); };
  function nms(list) { const out = []; for (const d of list.slice().sort((a, b) => b.conf - a.conf)) if (!out.some((o) => iou(o, d) > 0.3)) out.push(d); return out; }
  const TILES = [{ x: 0, y: 0, w: 0.6, h: 0.6 }, { x: 0.4, y: 0, w: 0.6, h: 0.6 }, { x: 0, y: 0.4, w: 0.6, h: 0.6 }, { x: 0.4, y: 0.4, w: 0.6, h: 0.6 }];
  // "auto": zoomed tiles only for big frames (HW4 cameras, ~2900 px wide) on computers, where a 640 px look makes plates tiny
  L.useTiles = (iw) => { const f = L.prefs().far; return f === "on" || (f === "auto" && !isMobile() && (iw || 0) > 1600); };

  /** Plate boxes in an image/video/canvas: [{x,y,w,h,conf}] normalised 0..1. */
  L.detectPlates = async (img, iw, ih, opts) => {
    opts = opts || {};
    const conf = opts.conf || L.prefs().conf;
    if (L._mock) return ((await L._mock.detect(img, iw, ih, opts)) || []).filter((d) => d.conf >= conf);
    const info = await L.load();
    const S = info.size || 640;
    const one = async (crop) => {
      const lb = letterbox(img, iw, ih, S, crop);
      const r = await call({ type: "detect", rgba: lb.rgba, fit: lb.fit, conf, size: S }, [lb.rgba]);
      L.timings.det.push(r.ms); if (L.timings.det.length > 50) L.timings.det.shift();
      return r.dets.map((b) => (crop ? { x: crop.x + b.x * crop.w, y: crop.y + b.y * crop.h, w: b.w * crop.w, h: b.h * crop.h, conf: b.conf, tiled: true } : { x: b.x, y: b.y, w: b.w, h: b.h, conf: b.conf }));
    };
    let dets = await one(null);
    if (opts.tiles != null ? opts.tiles : L.useTiles(iw)) for (const c of TILES) dets = dets.concat(await one(c));
    // plates are wider than tall; drop odd shapes
    return nms(dets).filter((d) => { const ar = (d.w * iw) / Math.max(1, d.h * ih); return ar > 0.9 && ar < 7; });
  };

  let ocrCv = null, ocrCx = null;
  /** Read plate text from boxes. → [{box, det, text, raw, conf, chars, format}] */
  L.readPlates = async (img, iw, ih, dets) => {
    if (!dets.length) return [];
    if (L._mock && L._mock.read) return L._mock.read(img, iw, ih, dets);
    const W = OCR.w, H = OCR.h, n = Math.min(dets.length, 12);
    if (!ocrCv) { ocrCv = document.createElement("canvas"); ocrCv.width = W; ocrCv.height = H * 12; ocrCx = ocrCv.getContext("2d", { willReadFrequently: true }); }
    for (let i = 0; i < n; i++) {
      const d = dets[i], px = d.w * 0.04, py = d.h * 0.08;
      const sx = Math.max(0, (d.x - px) * iw), sy = Math.max(0, (d.y - py) * ih), sw = Math.min(iw - sx, (d.w + 2 * px) * iw), sh = Math.min(ih - sy, (d.h + 2 * py) * ih);
      ocrCx.drawImage(img, sx, sy, Math.max(1, sw), Math.max(1, sh), 0, i * H, W, H);   // stretched, like fast-plate-ocr (keep_aspect_ratio: false)
    }
    const rgba = ocrCx.getImageData(0, 0, W, H * n).data.buffer;
    await L.load();
    const r = await call({ type: "ocr", rgba, n, w: W, h: H }, [rgba]);
    L.timings.ocr.push(r.ms); if (L.timings.ocr.length > 50) L.timings.ocr.shift();
    const per = r.slots * r.classes, out = [];
    for (let i = 0; i < n; i++) {
      const read = PT().decode(r.probs.subarray ? r.probs.subarray(i * per, (i + 1) * per) : r.probs.slice(i * per, (i + 1) * per), r.slots, r.classes);
      const norm = PT().normalizeCA(read);
      if (!norm.text || norm.text.length < 2) continue;
      out.push({ box: { x: dets[i].x, y: dets[i].y, w: dets[i].w, h: dets[i].h }, det: dets[i].conf, text: norm.text, raw: norm.raw, conf: norm.conf, chars: norm.chars.map((p) => Math.round(p * 100) / 100), format: norm.format });
    }
    return out;
  };

  /** One frame → plates (and street text when asked). */
  L.analyze = async (img, iw, ih, opts) => {
    opts = opts || {};
    const dets = await L.detectPlates(img, iw, ih, opts);
    const plates = await L.readPlates(img, iw, ih, dets);
    let texts = [];
    if (opts.street && T.redact && T.redact.readSigns) {
      try { texts = await T.redact.readSigns(img, iw, ih); } catch (e) { console.warn("street text skipped", e); }
      texts = texts.filter((x) => !plates.some((p) => iou(p.box, x.box) > 0.2));
    }
    return { dets, plates, texts };
  };

  // ── scanning an event (fills the text index) ──
  let vid = null, cv = null, cx = null;
  async function grab(cam, t) {
    const ev = T.player && T.player.ev; if (!ev) return null;
    const clip = ev.clips[T.player.clipIndexAt(t)], it = clip && clip.files[cam];
    if (!it || !it.blob) return null;
    vid = vid || Object.assign(document.createElement("video"), { muted: true, playsInline: true, preload: "auto" });
    await T.search.seekSample(vid, it, Math.max(0, t - clip.start));
    if (!vid.videoWidth) return null;
    // copy to a canvas: the reader and the text finder both crop from it, and the hidden video may move on
    const w = Math.min(isMobile() ? 1280 : 2048, vid.videoWidth), h = Math.round(vid.videoHeight * (w / vid.videoWidth));
    cv = cv || document.createElement("canvas"); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    cx = cx || cv.getContext("2d", { willReadFrequently: true });
    cx.drawImage(vid, 0, 0, w, h);
    return { img: cv, w, h };
  }
  L.grab = grab;
  const camsWithVideo = (ev, want) => (want || T.GRID || ["front"]).filter((c) => ev.clips.some((clip) => clip.files[c] && clip.files[c].blob));
  L.stepFor = (ev, cams, dense) => { const budget = isMobile() ? 120 : 360; return Math.max(dense ? 0.5 : 1, Math.round((ev.duration * cams.length / budget) * 2) / 2); };
  L.scanned = (ev, cams, street) => { const X = T.libIndex && T.libIndex.text, sc = X && X.get(ev.id); return !!sc && cams.every((c) => sc.cams.includes(c)) && (!street || sc.street); };

  /** Scan the open event (sampled frames on the given cameras). ui: {status(text), stopped()} */
  L.scan = async (ev, cams, ui) => {
    ui = ui || {}; const say = ui.status || setStatus, stopped = ui.stopped || (() => false);
    const P = L.prefs(), street = !!(ui.street != null ? ui.street : P.street);
    cams = camsWithVideo(ev, cams);
    if (!cams.length) throw new Error("No playable camera in this event yet. Unlock encrypted clips first.");
    const X = T.libIndex && T.libIndex.text, old = X && X.get(ev.id);
    const keep = old && old.items ? old.items.filter((it) => !cams.includes(it.cam)) : [];
    const step = L.stepFor(ev, cams, ui.dense);
    const items = [], frames = {};
    L.scanning = true;
    const t0 = performance.now();
    let n = 0, total = 0; for (let t = 0.2; t < ev.duration - 0.05; t += step) total += cams.length;
    try {
      await L.load();
      for (let t = 0.2; t < ev.duration - 0.05; t += step) {
        for (const cam of cams) {
          if (stopped()) throw new Error("stopped");
          n++;
          say("Reading plates" + (street ? " and street names" : "") + " · frame " + n + " of " + total + " · " + (CAM_LABEL[cam] || cam) + " · " + (T.fmtTime ? T.fmtTime(t, true) : t.toFixed(1)) + ". The video stays on this device.");
          let f; try { f = await grab(cam, t); } catch (e) { console.warn("frame skipped", e); continue; }
          if (!f) continue;
          const doStreet = street && (Math.round(t / step) % Math.max(1, Math.round(2 / step)) === 0);   // street text every ~2 s (slower model)
          const r = await L.analyze(f.img, f.w, f.h, { street: doStreet });
          (frames[cam] = frames[cam] || []).push({ t, dets: r.dets.map((d) => ({ ...d, label: "plate" })) });
          for (const p of r.plates) items.push({ kind: "plate", cam, t: Math.round(t * 100) / 100, ...p });
          for (const x of r.texts) items.push({ kind: "text", cam, t: Math.round(t * 100) / 100, text: x.text, conf: x.conf != null ? x.conf : 0.6, box: x.box });
          if ((n & 3) === 0) await new Promise((res) => setTimeout(res, 0));
        }
      }
    } finally { L.scanning = false; }
    const scan = { eventId: ev.id, at: Date.now(), cams: [...new Set(cams.concat(old ? old.cams : []))], step, street: street || !!(old && old.street), model: L.prefs().model, items: keep.concat(items), ms: Math.round(performance.now() - t0) };
    if (X) await X.put(scan); else L._scan = scan;
    L.buildBlur(ev, frames, step);
    return scan;
  };

  // ── blur tracks (redaction of plates in playback + export) ──
  L.buildBlur = (ev, frames, step) => {
    const D = T.detect; if (!D || !D.buildTracks) return;
    for (const cam of Object.keys(frames)) L.blurTracks[cam] = D.buildTracks(frames[cam], { minIou: 0.05, maxGap: step * 2.2 + 0.1 });
    L.blurEvent = ev.id; L.blurStep = step;
    T.emit && T.emit("layout");
  };
  /** Rebuild blur tracks from the saved index (after reload). Boxes are only kept for read plates, so it's a little sparser. */
  L.blurFromIndex = (ev) => {
    const X = T.libIndex && T.libIndex.text, sc = X && X.get(ev.id);
    if (!sc) return false;
    const frames = {};
    for (const it of sc.items || []) if (it.kind === "plate") { const f = (frames[it.cam] = frames[it.cam] || []); let fr = f.find((x) => x.t === it.t); if (!fr) f.push((fr = { t: it.t, dets: [] })); fr.dets.push({ ...it.box, conf: it.det || it.conf, label: "plate" }); }
    L.blurTracks = {};
    L.buildBlur(ev, frames, sc.step || 1);
    return true;
  };
  /** Plate boxes to blur on one camera at event time t (padded a little). */
  L.blurBoxesAt = (cam, t) => {
    try {
      if (!L.blurOn() || !T.player || !T.player.ev || L.blurEvent !== T.player.ev.id) return [];
      const D = T.detect, list = L.blurTracks[cam]; if (!list || !D) return [];
      const out = [], slack = (L.blurStep || 1) * 0.75;
      for (const tr of list) { const b = D.trackAt(tr, t, slack); if (b) out.push({ x: Math.max(0, b.x - b.w * 0.12), y: Math.max(0, b.y - b.h * 0.2), w: Math.min(1, b.w * 1.24), h: Math.min(1, b.h * 1.4) }); }
      return out;
    } catch (_) { return []; }
  };

  // ── search ──
  /** Merge sightings of the same reading (any camera, any time) into one result: the best sighting is the hit,
   *  the rest are kept in hit.sightings. Then mark the best match(es) and build the shared label text.
   *  Ranking = text match to the query × read confidence (hit.score). Distinct readings within BEST_EPS of the
   *  top score all count as best. At most 20 results, in time order. */
  L.BEST_EPS = 0.02;
  const groupKey = (r) => {
    const P = PT();
    return (r.plate ? "p:" : "t:") + (r.plate && P && P.canon && P.clean ? P.canon(P.clean(r.reading || "")) : String(r.reading || r.label || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
  };
  L.cluster = (rows) => {
    const groups = new Map();
    for (const r of rows.slice().sort((a, b) => b.score - a.score || b.conf - a.conf)) {
      const k = groupKey(r), g = groups.get(k);
      if (!g) { groups.set(k, { ...r, sightings: [{ t: r.t, cam: r.cam, conf: r.conf, box: r.box }] }); continue; }
      if (!g.sightings.some((x) => x.cam === r.cam && Math.abs(x.t - r.t) < 2)) g.sightings.push({ t: r.t, cam: r.cam, conf: r.conf, box: r.box });
    }
    const out = [...groups.values()].sort((a, b) => b.score - a.score).slice(0, 20);
    const top = out.length ? out[0].score : 0;
    out.forEach((h) => { h.best = top > 0 && h.score >= top - L.BEST_EPS; h.text = L.labelText(h); h.boxText = h.text; });
    return out.sort((a, b) => a.t - b.t);
  };
  const pc = (c) => Math.round(Math.max(0, Math.min(1, c)) * 100) + "%";
  /** One format everywhere (results list, gold box, export burn-in, phone strip):
   *  "7ABC234 · match 100% · read 91% · checked by Grok · seen 2× · Best match". "match" is left out for "plates"/"street" with
   *  no pattern (every reading matches), "· Best match" only on the top result(s). */
  L.labelText = (h) => {
    const parts = [String(h.reading || "").slice(0, 24)];
    if (h.match != null && !h.matchAll) parts.push("match " + pc(h.match));
    if (h.conf != null) parts.push("read " + pc(h.conf));
    if (h.cloud) parts.push("checked by " + ({ grok: "Grok", claude: "Claude", gemini: "Gemini" }[h.cloud] || "cloud"));
    if (h.sightings && h.sightings.length > 1) parts.push("seen " + h.sightings.length + "×");
    if (h.best) parts.push("Best match");
    return parts.join(" · ");
  };
  const pct = (c) => Math.round(Math.max(0, Math.min(1, c)) * 100) + "%";
  /** Search the open event (scanning it first if needed). Returns rows for search.js (like the detector's). */
  L.runSearch = async (q, ev, cams, ui) => {
    const parsed = L.parse(q); if (!parsed) return [];
    const street = parsed.kind === "text";
    cams = camsWithVideo(ev, cams);
    if (!L.scanned(ev, cams, street)) await L.scan(ev, cams, { status: ui.status, stopped: ui.stopped, street: street || L.prefs().street });
    else if (L.blurEvent !== ev.id) L.blurFromIndex(ev);
    const X = T.libIndex.text, PTX = PT(), minRead = L.prefs().minRead;
    const match = (it) => {
      if (parsed.kind === "plate") return it.kind === "plate" && (parsed.all ? it.conf >= minRead * 0.5 : true) ? PTX.matchPlate(parsed.pattern, it.text) : 0;
      return it.kind === "text" ? PTX.matchText(parsed.phrase, it.text) : 0;
    };
    const found = X.search(match);
    const here = found.filter((r) => r.eventId === ev.id && cams.includes(r.item.cam));
    const others = new Set(found.filter((r) => r.eventId !== ev.id).map((r) => r.eventId));
    L.lastOthers = [...others];
    return here.map((r) => {
      const it = r.item, isPlate = it.kind === "plate";
      const label = (isPlate ? "plate " : "") + it.text;
      const all = parsed.kind === "plate" ? !!parsed.all : !parsed.phrase;
      return { t: it.t, cam: it.cam, score: (all ? 1 : r.score) * it.conf, match: r.score, matchAll: all, reading: it.text, conf: it.conf, label, text: it.text + " " + pct(it.conf) + (it.cloud && it.cloud.text ? " · checked by " + ({ grok: "Grok", claude: "Claude", gemini: "Gemini" }[it.cloud.prov] || "cloud") : ""), cloud: it.cloud && it.cloud.text ? it.cloud.prov : undefined, det: true, plate: isPlate, streetText: !isPlate, box: { ...it.box }, chars: it.chars, raw: it.raw, detConf: it.det, weak: it.conf < minRead };
    });
  };

  /** Follow plate hits across nearby frames (detector only, no reading) so the gold box moves with the plate. */
  L.trackAround = async (group, opts) => {
    opts = opts || {};
    const D = T.detect, span = opts.span || 2.5, step = opts.step || (isMobile() ? 0.5 : 0.25), out = [];
    const until = performance.now() + (opts.budgetMs || 20000);
    for (const hit of group) {
      if (!hit || !hit.box || !hit.plate) continue;
      const ev = T.player.ev, from = Math.max(0, hit.t - span), to = Math.min(ev.duration, hit.t + span), frames = [];
      const times = []; for (let k = 0; ; k++) { const a = hit.t - k * step, z = hit.t + k * step; if (a < from - 1e-6 && z > to + 1e-6) break; if (a >= from - 1e-6) times.push(a); if (k && z <= to + 1e-6) times.push(z); }
      for (const t of times) {
        if (performance.now() > until && frames.length >= 3) break;
        const f = await grab(hit.cam, t); if (!f) continue;
        let dets = []; try { dets = await L.detectPlates(f.img, f.w, f.h, { conf: Math.max(0.15, L.prefs().conf * 0.7) }); } catch (e) { if (!frames.length) throw e; continue; }
        frames.push({ t, dets: dets.map((d) => ({ ...d, label: "plate" })) });
      }
      const tracks = D.buildTracks(frames, { minIou: 0.1, maxGap: step * 3 });
      let best = null, bestV = 0.05;
      for (const tr of tracks) { const b = D.trackAt(tr, hit.t, step); if (!b) continue; const v = iou(b, hit.box); if (v > bestV) { bestV = v; best = tr; } }
      if (best) {
        best.label = hit.label;   // "plate 7ABC234" + the reading confidence, same as the list
        best.pts.forEach((p) => { p.conf = hit.conf; });
        out.push({ cam: hit.cam, hit, track: best, from: best.pts[0].t, to: best.pts[best.pts.length - 1].t, text: null });
        hit.tracked = true;
      }
    }
    return out;
  };

  /** Export: when "Blur plates" is on, make sure every exported camera has been scanned. */
  L.exportPrep = async (ev, say) => {
    if (!L.blurOn() || !ev) return;
    const cams = camsWithVideo(ev);
    if (!L.scanned(ev, cams, false)) {
      say && say("Finding plates to blur before export (one time for this event)…");
      await L.scan(ev, cams, { status: say, street: false, dense: true });
    } else if (L.blurEvent !== ev.id) L.blurFromIndex(ev);
  };

  // ── Settings ▸ Plates & text (beta) ──
  L.renderSettings = () => {
    const box = document.getElementById("setPlates"); if (!box) return;
    const P = L.prefs();
    box.innerHTML = "";
    const row = (html) => { const d = document.createElement("div"); d.className = "row"; d.innerHTML = html; box.appendChild(d); return d; };
    row('<label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" id="plEnabled"' + (P.enabled ? " checked" : "") + "> Read licence plates (search: plate 7ABC234, 7AB*, plates)</label>");
    row('<span>Plate finder</span><select class="select" id="plModel">' + Object.entries(MODELS).map(([k, m]) => '<option value="' + k + '"' + (k === P.model ? " selected" : "") + ">" + m.label + "</option>").join("") + "</select>");
    row('<span>Find plates above</span><input type="range" id="plConf" min="0.1" max="0.9" step="0.05" value="' + P.conf + '"><b id="plConfV">' + Math.round(P.conf * 100) + "%</b>");
    row('<span>Trust readings above</span><input type="range" id="plRead" min="0.1" max="0.95" step="0.05" value="' + P.minRead + '"><b id="plReadV">' + Math.round(P.minRead * 100) + "%</b>");
    row('<span>Far plates</span><select class="select" id="plFar"><option value="auto"' + (P.far === "auto" ? " selected" : "") + '>Auto (zoomed look for big HW4 frames on computers)</option><option value="on"' + (P.far === "on" ? " selected" : "") + '>Always (5× slower)</option><option value="off"' + (P.far === "off" ? " selected" : "") + ">Off</option></select>");
    row('<label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" id="plStreet"' + (P.street ? " checked" : "") + "> Also read street names and signs (slower; search: street Palm Ave)</label>");
    row('<label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" id="plBlur"' + (P.blur ? " checked" : "") + "> Blur plates in playback and export</label>");
    const st = row('<span class="hint" id="plStatus"></span>'); st.querySelector("#plStatus").textContent = L.status || (P.enabled ? "Models load on the first plate search." : "Off.");
    const X = T.libIndex && T.libIndex.text;
    const note = document.createElement("p"); note.className = "hint";
    note.textContent = "Plates and text are read on this device. The index keeps only the text, time, camera and box (" + (X ? X.count() + " saved, " + (X.mode === "indexeddb" ? "on this device" : "this session only") : "not available") + "). Models: open-image-models plate finder and fast-plate-ocr reader (MIT). Readings can be wrong: check the video.";
    box.appendChild(note);
    const b1 = document.createElement("button"); b1.className = "btn ghost"; b1.textContent = "Load models now"; b1.onclick = () => L.load().catch(() => {}); box.appendChild(b1);
    const b2 = document.createElement("button"); b2.className = "btn ghost"; b2.id = "plForget"; b2.textContent = "Forget plate & text index"; b2.onclick = async () => { if (X) await X.clear(); L.blurTracks = {}; L.blurEvent = null; T.toast && T.toast("Plate and text index cleared", "ok"); L.renderSettings(); T.emit && T.emit("layout"); }; box.appendChild(b2);
    box.querySelector("#plEnabled").onchange = (e) => L.setPref("enabled", e.target.checked);
    box.querySelector("#plModel").onchange = (e) => L.setPref("model", e.target.value);
    box.querySelector("#plConf").oninput = (e) => { box.querySelector("#plConfV").textContent = Math.round(e.target.value * 100) + "%"; };
    box.querySelector("#plConf").onchange = (e) => L.setPref("conf", +e.target.value);
    box.querySelector("#plRead").oninput = (e) => { box.querySelector("#plReadV").textContent = Math.round(e.target.value * 100) + "%"; };
    box.querySelector("#plRead").onchange = (e) => L.setPref("minRead", +e.target.value);
    box.querySelector("#plFar").onchange = (e) => L.setPref("far", e.target.value);
    box.querySelector("#plStreet").onchange = (e) => L.setPref("street", e.target.checked);
    box.querySelector("#plBlur").onchange = (e) => L.setPref("blur", e.target.checked);
  };
  /** Export dialog checkbox "Blur licence plates" mirrors the same setting. */
  L.syncExport = () => {
    const wrap = document.getElementById("exportPlatesWrap"), c = document.getElementById("exportPlates");
    if (!wrap || !c) return;
    wrap.hidden = !L.enabled();
    c.checked = L.blurOn();
  };

  L.init = () => {
    try {
      L.renderSettings(); L.syncExport();
      const c = document.getElementById("exportPlates");
      if (c) c.onchange = () => L.setPref("blur", c.checked);
      const go = document.getElementById("btnExport"); if (go) go.addEventListener("click", () => setTimeout(L.syncExport, 0));
      if (T.on) {
        T.on("player-open", (ev) => { L.blurTracks = {}; L.blurEvent = null; if (ev && L.blurOn()) L.blurFromIndex(ev); });
        T.on("textindex", () => { const n = document.getElementById("setPlates"); if (n && !n.contains(document.activeElement)) L.renderSettings(); });
      }
    } catch (e) { console.warn("plates init", e); }
  };
})();
