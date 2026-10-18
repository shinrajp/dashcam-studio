/* search.js — natural-language search over dashcam frames.
 * Frames are scored on this computer with a CLIP model. The video is never uploaded.
 * The model (about 150 MB) is downloaded once from Hugging Face and then cached by the browser. */
(function () {
  "use strict";
  const T = window.TDC;
  const S = (T.search = { hits: [], running: false, stop: false, cache: new Map(), cacheEvent: null, anchor: null, query: null });
  const MODEL = "Xenova/clip-vit-base-patch32";
  const CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";
  const CAM_LABEL = { front: "Front", back: "Rear", left_repeater: "Left", right_repeater: "Right", left_pillar: "Left pillar", right_pillar: "Right pillar" };

  const $ = (id) => document.getElementById(id);
  const status = (text) => { const n = $("findStatus"); if (!n) return; n.hidden = !text; n.textContent = text || ""; };

  function camsFor(mode, ev) {
    const want = mode === "around" ? ["front", "left_repeater", "right_repeater", "back", "left_pillar", "right_pillar"] : ["front"];
    return want.filter((c) => ev.clips.some((clip) => clip.files[c] && clip.files[c].blob));
  }

  function samples(ev, cams) {
    const budget = 140;
    const step = Math.max(1, ev.duration / Math.max(1, Math.floor(budget / cams.length)));
    const out = [];
    for (let t = 0.4; t < ev.duration - 0.15; t += step) {
      const i = T.player.clipIndexAt(t);
      const clip = ev.clips[i];
      for (const cam of cams) {
        const it = clip.files[cam];
        if (!it || !it.blob) continue;
        out.push({ t, cam, it, local: Math.max(0, t - clip.start) });
      }
    }
    return out;
  }

  function cluster(rows) {
    const sorted = rows.slice().sort((a, b) => a.t - b.t);
    const groups = [];
    for (const r of sorted) {
      const g = groups.find((x) => x.cam === r.cam && Math.abs(x.t - r.t) < 4);
      if (!g) groups.push({ ...r });
      else if (r.score > g.score) Object.assign(g, r);
    }
    groups.sort((a, b) => b.score - a.score);
    return groups.slice(0, 12).sort((a, b) => a.t - b.t);
  }

  function cos(a, b) {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return d / Math.sqrt(na * nb || 1);
  }

  let tf = null;
  const CACHE_NOTE = "Model cache unavailable on this connection (not https), so the model is downloaded again each visit.";
  async function cacheAvailable() {
    try {
      if (window.isSecureContext === false || typeof caches === "undefined" || !caches) return false;
      await caches.open("tdc-probe");   // can still throw (private mode, storage blocked)
      return true;
    } catch (e) { return false; }
  }
  S.cacheAvailable = cacheAvailable;
  function explain(err) {
    const m = String((err && err.message) || err || "");
    if (/cache|storage|quota/i.test(m)) return "Search could not start: the browser blocked storage for the vision model (" + m + "). Try again; on http:// the model is loaded without a cache. The video itself is not uploaded.";
    if (/fetch|network|load failed|offline|ERR_|import|dynamically imported module/i.test(m) || navigator.onLine === false) return "Search could not start: couldn't download the vision model (" + m + "). The first search needs internet to fetch it (about 150 MB). The video itself is not uploaded.";
    if (/memory|allocat|RangeError|wasm/i.test(m)) return "Search could not start: the vision model ran out of memory on this device (" + m + "). Close other tabs and try again, or use a computer.";
    return "Search could not start: " + m + ". The video itself is not uploaded.";
  }
  S.explain = explain;
  async function loadModel(onProgress) {
    if (tf) return tf;
    const mod = await import(CDN);
    mod.env.allowLocalModels = false;
    // Cache Storage (`caches`) only exists on https:// or localhost. On http://<LAN IP> (e.g. a phone testing
    // from the Mac) it's undefined and transformers.js throws if asked to use it, so load from the network instead.
    S.cacheOk = await cacheAvailable();
    mod.env.useBrowserCache = S.cacheOk;
    if ("useFSCache" in mod.env) mod.env.useFSCache = false;
    if ("useCustomCache" in mod.env) mod.env.useCustomCache = false;
    if (!S.cacheOk) onProgress(CACHE_NOTE);
    if (mod.env.backends && mod.env.backends.onnx && mod.env.backends.onnx.wasm) {
      mod.env.backends.onnx.wasm.proxy = false;
      mod.env.backends.onnx.wasm.numThreads = 1;
    }
    const opt = {
      dtype: "q8",
      device: "wasm",
      progress_callback: (p) => {
        if (!p) return;
        const pct = p.progress != null ? Math.round(p.progress) : null;
        onProgress("Downloading the vision model" + (p.file ? " · " + p.file : "") + (pct != null ? " · " + pct + "%" : "") + ". " + (S.cacheOk ? "" : "No model cache on this connection (not https). ") + "Your video stays on this computer.");
      },
    };
    onProgress(S.cacheOk ? "Loading the vision model. The first search downloads it once (about 150 MB). Your video is not uploaded." : "Loading the vision model (about 150 MB). " + CACHE_NOTE + " Your video is not uploaded.");
    const tokenizer = await mod.AutoTokenizer.from_pretrained(MODEL, opt);
    const textModel = await mod.CLIPTextModelWithProjection.from_pretrained(MODEL, opt);
    const processor = await mod.AutoProcessor.from_pretrained(MODEL);
    const visionModel = await mod.CLIPVisionModelWithProjection.from_pretrained(MODEL, opt);
    tf = { mod, tokenizer, textModel, processor, visionModel };
    return tf;
  }

  async function textVec(model, phrase) {
    const inputs = model.tokenizer(["a dashcam photo of " + phrase], { padding: true, truncation: true });
    const { text_embeds } = await model.textModel(inputs);
    return text_embeds.data.slice(0, text_embeds.dims[text_embeds.dims.length - 1]);
  }

  // Shared CLIP access for vehicle details (vehicle.js): same model and cache as the picture search, no extra download.
  const unit = (v) => { let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1; const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / n; return o; };
  S.clip = {
    load: (onProgress) => loadModel(onProgress || (() => {})),
    /** prompts → unit text vectors (raw prompts, no "dashcam photo" prefix) */
    texts: async (prompts) => {
      const model = await loadModel(() => {});
      const out = [];
      for (let i = 0; i < prompts.length; i += 16) {
        const inputs = model.tokenizer(prompts.slice(i, i + 16), { padding: true, truncation: true });
        const { text_embeds } = await model.textModel(inputs);
        const d = text_embeds.dims[text_embeds.dims.length - 1];
        for (let k = 0; k < text_embeds.dims[0]; k++) out.push(unit(text_embeds.data.slice(k * d, (k + 1) * d)));
      }
      return out;
    },
    /** canvas (any size; it's resized to 224) → unit image vector */
    image: async (canvas) => {
      const model = await loadModel(() => {});
      const inputs = await model.processor(model.mod.RawImage.fromCanvas(canvas));
      const { image_embeds } = await model.visionModel(inputs);
      return unit(image_embeds.data.slice(0, image_embeds.dims[image_embeds.dims.length - 1]));
    },
    ready: () => !!tf,
  };

  function wait(el, ev, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { el.removeEventListener(ev, ok); reject(new Error("frame timed out")); }, ms);
      const ok = () => { clearTimeout(timer); resolve(); };
      el.addEventListener(ev, ok, { once: true });
    });
  }

  async function frameEmbed(model, video, canvas, ctx, sample) {
    const key = sample.it.key + "|" + sample.local.toFixed(1);
    const cached = S.cache.get(key);
    if (cached) return cached;
    const url = sample.it.url || (sample.it.url = URL.createObjectURL(sample.it.blob));
    if (video._src !== url) {
      video.src = url;
      video._src = url;
      await wait(video, "loadeddata", 8000);
    }
    const local = Math.min(sample.local, Math.max(0, (video.duration || sample.local + 0.1) - 0.05));
    if (video.readyState < 2 || Math.abs(video.currentTime - local) > 0.08) {
      video.currentTime = local;
      await wait(video, "seeked", 8000);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = model.mod.RawImage.fromCanvas(canvas);
    const inputs = await model.processor(image);
    const { image_embeds } = await model.visionModel(inputs);
    const dim = image_embeds.dims[image_embeds.dims.length - 1];
    const vec = image_embeds.data.slice(0, dim);
    S.cache.set(key, vec);
    return vec;
  }

  function groupAt(t) {
    return S.hits.filter((h) => Math.abs(h.t - t) <= 1.6);
  }

  function contain(iw, ih, r) {
    const s = Math.min(r.w / iw, r.h / ih);
    const w = iw * s, h = ih * s;
    return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
  }

  function paintBoxes() {
    if (!T.player.tiles) return;
    const show = !!($("findShow") && $("findShow").checked) && S.anchor != null;
    const group = show ? groupAt(S.anchor) : [];
    const cams = new Set(group.map((h) => h.cam));
    const near = show && Math.abs((T.player.time || 0) - S.anchor) <= 2.5;
    for (const cam of T.GRID) {
      const tile = T.player.tiles[cam];
      if (!tile) continue;
      tile.tile.classList.toggle("find-on", show && cams.has(cam));
      let cv = tile.tile.querySelector(".find-layer");
      if (!cv) {
        cv = document.createElement("canvas");
        cv.className = "find-layer";
        tile.tile.appendChild(cv);
      }
      const video = tile.vids[T.player.active];
      cv.style.transform = video ? video.style.transform : "";
      cv.style.transformOrigin = "50% 50%";
      const tw = tile.tile.clientWidth, th = tile.tile.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(tw * dpr)), h = Math.max(1, Math.round(th * dpr));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const ctx = cv.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, tw, th);
      const goldOn = !$("findShow") || $("findShow").checked;
      const det = goldOn && video && video.videoWidth && T.detect && T.burnBoxes ? T.detect.boxesAt(cam, T.player.time || 0) : null;
      if (det) {   // Phase 5: boxes that follow the object (tracked) or live detections
        if (det.length) { tile.tile.classList.add("find-on"); T.burnBoxes.draw(ctx, cam, T.player.time, { x: 0, y: 0, w: tw, h: th }, video.videoWidth, video.videoHeight, det, 12); }
        continue;
      }
      if (!near || !cams.has(cam) || !video || !video.videoWidth) continue;
      const hit = group.find((g) => g.cam === cam && g.box && !g.tracked);
      if (!hit) continue;
      const item = T.burnBoxes && T.burnBoxes.forHit(hit);
      if (item) {   // same box + label text as "Burn detection boxes" in export; 12 px minimum on screen
        T.burnBoxes.draw(ctx, cam, S.anchor, { x: 0, y: 0, w: tw, h: th }, video.videoWidth, video.videoHeight, [item], 12);
        continue;
      }
      // fallback (burn-boxes.js missing): original plain box
      const fit = contain(video.videoWidth, video.videoHeight, { x: 0, y: 0, w: tw, h: th });
      const box = hit.box;
      ctx.strokeStyle = "#e6b450"; ctx.lineWidth = 3;
      ctx.strokeRect(fit.x + box.x * fit.w, fit.y + box.y * fit.h, box.w * fit.w, box.h * fit.h);
    }
  }

  S.seekSample = (v, it, local) => seekSample(v, it, local);
  // WebKit can hand back black frames from a video that isn't in the page; park sample videos in a tiny invisible holder.
  function park(video) {
    if (video.isConnected || !document.body) return;
    let h = document.getElementById("sampleVideos");
    if (!h) { h = document.createElement("div"); h.id = "sampleVideos"; h.setAttribute("aria-hidden", "true"); h.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none"; document.body.appendChild(h); }
    video.style.cssText = "width:2px;height:2px"; video.muted = true; video.setAttribute("muted", ""); video.setAttribute("playsinline", "");
    h.appendChild(video);
  }
  async function seekSample(video, it, local) {
    try { park(video); } catch (_) {}
    const url = it.url || (it.url = URL.createObjectURL(it.blob));
    if (video._src !== url) {
      video.src = url;
      video._src = url;
      await wait(video, "loadeddata", 8000);
    }
    const at = Math.min(local, Math.max(0, (video.duration || local + 0.1) - 0.05));
    if (video.readyState < 2 || Math.abs(video.currentTime - at) > 0.08) {
      video.currentTime = at;
      await wait(video, "seeked", 8000);
    }
  }

  async function cropScore(model, video, ctx, canvas, query, sx, sy, sw, sh) {
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const image = model.mod.RawImage.fromCanvas(canvas);
    const inputs = await model.processor(image);
    const { image_embeds } = await model.visionModel(inputs);
    const dim = image_embeds.dims[image_embeds.dims.length - 1];
    return cos(image_embeds.data.slice(0, dim), query);
  }

  async function bestWindow(model, video, ctx, canvas, query, vw, vh, region, fw, fh) {
    let best = null;
    const cols = 3, rows = 3;
    const spanX = Math.max(0, region.w - fw);
    const spanY = Math.max(0, region.h - fh);
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const x = Math.min(1 - fw, region.x + spanX * gx / (cols - 1));
        const y = Math.min(1 - fh, region.y + spanY * gy / (rows - 1));
        const score = await cropScore(model, video, ctx, canvas, query, x * vw, y * vh, fw * vw, fh * vh);
        if (!best || score > best.score) best = { x, y, w: fw, h: fh, score };
      }
    }
    return best;
  }

  async function locate(hit) {
    const ev = T.player.ev;
    if (!ev || !S.query) return null;
    const clip = ev.clips[T.player.clipIndexAt(hit.t)];
    const it = clip && clip.files[hit.cam];
    if (!it || !it.blob) return null;
    const model = await loadModel(status);
    const video = S.video || (S.video = document.createElement("video"));
    video.muted = true; video.playsInline = true;
    await seekSample(video, it, Math.max(0, hit.t - clip.start));
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const canvas = S.canvas || (S.canvas = document.createElement("canvas"));
    canvas.width = 224; canvas.height = 224;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const coarse = await bestWindow(model, video, ctx, canvas, S.query, vw, vh, { x: 0, y: 0, w: 1, h: 1 }, 0.5, 0.5);
    const mid = await bestWindow(model, video, ctx, canvas, S.query, vw, vh, coarse, 0.28, 0.28);
    return bestWindow(model, video, ctx, canvas, S.query, vw, vh, mid, 0.16, 0.16);
  }

  async function openHit(hit) {
    const vehSummary = hit.vehicle ? ($("findStatus").textContent || "") : "";
    S.anchor = hit.t;
    S.pickedCam = hit.cam;
    const group = groupAt(hit.t);
    const cams = [...new Set(group.map((g) => g.cam))];
    const follow = !$("findFollow") || $("findFollow").checked;
    if (follow && T.focus) {
      if (cams.length <= 1) T.focus.focus(cams[0] || hit.cam);
      else T.focus.grid();
    }
    T.player.seek(hit.t);
    renderHits();
    paintBoxes();
    const show = !$("findShow") || $("findShow").checked;
    if (show && !hit.vehicle) {
      status("Outlining “" + (S.phrase || "the match") + "”…");
      for (const g of group) {
        if (g.det || (g.box && g.box.w <= 0.2)) continue;
        try { g.box = await locate(g); }
        catch (err) { console.warn(err); }
      }
    }
    const n = group.filter((g) => g.box).length;
    const isDet = group.some((g) => g.det);
    const isVeh = group.some((g) => g.vehicle), summary = vehSummary.replace(/ (Following the vehicle…|The gold box follows it\.)$/, "");   // vehicle details: keep the result summary
    if ((follow || (show && n)) && !isVeh) {
      status((follow ? (cams.length <= 1 ? "Switched to " + (CAM_LABEL[cams[0] || hit.cam] || "that camera") + ". " : "Showing all " + cams.length + " cameras that see it. ") : "") + (show && n ? (isDet ? "The gold box is what the object detector found, with its confidence." : "The gold box is the part of the picture that best matches the words. It is a guess.") : ""));
    }
    paintBoxes();
    // Phase 5: follow the object across nearby frames with the detector (only when detection is turned on)
    if (show && n && T.plates && group.some((g) => g.plate)) {   // Phase 6: follow the plate with the plate detector
      const token = (S.trackToken = (S.trackToken || 0) + 1);
      try {
        status("Following the plate across nearby frames…");
        const tracks = await T.plates.trackAround(group.filter((g) => g.box && g.plate));
        if (token === S.trackToken && S.anchor === hit.t && T.detect) { T.detect.tracks = tracks; status(tracks.length ? "The gold box follows the plate. " + (hit.text ? "Read as " + hit.text + "." : "") : "Showing the plate at the match only."); }
      } catch (err) { console.warn("plate tracking skipped", err); status("Plate tracking unavailable (" + (err.message || err) + "). The gold box stays at the match."); }
      paintBoxes();
    } else if (show && n && group.some((g) => g.cloud && !g.plate)) {   // Phase 6 B: cloud answers are per frame; no local tracking
      status("The gold box is where the cloud model said it saw it" + (hit.text ? " (" + hit.text + ")" : "") + ". It may be wrong.");
} else if (show && n && T.detect && (T.detect.enabled() || group.some((g) => g.vehicle))) {
      const token = (S.trackToken = (S.trackToken || 0) + 1);
      try {
        group.forEach((g) => { g.phrase = g.det ? null : S.phrase; });
        status(isVeh ? summary + " Following the vehicle…" : "Following the object across nearby frames…");
        const tracks = await T.detect.trackAround(group.filter((g) => g.box), { prompt: T.detect.prefs().model === "gdino" ? S.phrase : undefined });
        if (token === S.trackToken && S.anchor === hit.t) { T.detect.tracks = tracks; status(isVeh ? summary + (tracks.length ? " The gold box follows it." : "") : tracks.length ? "The gold box now follows the object (" + tracks.length + " tracked)." : "Couldn't follow the object; showing the box at the match only."); }
      } catch (err) { console.warn("tracking skipped", err); status((isVeh ? summary + " " : "") + "Object tracking unavailable (" + (err.message || err) + "). The gold box stays at the match."); }
      paintBoxes();
    }
    if (T.ui && T.ui.drawTimeline) T.ui.drawTimeline();
  }

  function renderHits() {
    const box = $("findHits");
    if (!box) return;
    box.innerHTML = "";
    const group = S.anchor == null ? [] : groupAt(S.anchor);
    S.hits.forEach((h) => {
      const b = document.createElement("button");
      b.type = "button";
      const picked = group.indexOf(h) >= 0;
      b.className = "find-hit" + (h.weak ? " weak" : " on") + (picked ? " picked" : "");
      b.textContent = T.fmtTime(h.t, true) + " · " + (CAM_LABEL[h.cam] || h.cam) + (h.text ? " · " + h.text : "") + (h.weak ? " · weak" : "");
      b.title = "Jump to this moment and outline it";
      b.addEventListener("click", () => openHit(h));
      box.appendChild(b);
    });
    const has = S.hits.length > 0;
    $("btnFindClear").hidden = !has;
    $("btnFindMarks").hidden = !has;
    const show = $("findShow"), follow = $("findFollow");
    if (show) show.parentElement.hidden = !has;
    if (follow) follow.parentElement.hidden = !has;
    if (T.ui && T.ui.drawTimeline) T.ui.drawTimeline();
  }

  // ── "Best match only" (plate / street-text results carry .best): S.allHits keeps every result, S.hits is what is shown,
  // boxed, tracked, burned into the export and listed in the strip. Saved in localStorage. ──
  const BEST_KEY = "tdc.search.bestOnly";
  S.bestOnly = () => { try { return localStorage.getItem(BEST_KEY) === "1"; } catch (e) { return false; } };
  S.hasBest = () => !!(S.allHits && S.allHits.some((h) => h.best));
  function applyBest() {
    if (!S.allHits) return;
    const keep = S.bestOnly() && S.hasBest() ? S.allHits.filter((h) => h.best) : S.allHits.slice();
    S.hits = keep;
    if (T.detect && T.detect.tracks) T.detect.tracks = T.detect.tracks.filter((g) => !g.hit || keep.includes(g.hit));
  }
  S.setBestOnly = (on) => {
    try { on ? localStorage.setItem(BEST_KEY, "1") : localStorage.removeItem(BEST_KEY); } catch (e) {}
    applyBest();
    if (S.anchor != null && !S.hits.some((h) => Math.abs(h.t - S.anchor) < 0.05)) { S.anchor = null; const b = S.hits.find((h) => h.best) || S.hits[0]; if (b) openHit(b); }
    renderHits(); paintBoxes();
    T.emit && T.emit("search-filter", !!on);
  };
  S.openHit = (hit) => openHit(hit);       // used by the phone thumbnail strip / search panel when no classic button exists
  S.renderHits = () => renderHits();
  S.clear = () => {
    S.hits = []; S.allHits = null;
    S.anchor = null;
    S.query = null;
    S.phrase = "";
    if (T.detect) T.detect.clear();
    if (T.vehicle) T.vehicle.chips([]);
    renderHits();
    paintBoxes();
    status("");
  };

  S.markSections = () => {
    if (!S.hits.length || !T.ui || !T.ui.addSeg) return;
    const dur = T.player.duration();
    let n = 0;
    for (const h of S.hits) {
      if (T.ui.addSeg(Math.max(0, h.t - 2), Math.min(dur, h.t + 3))) n++;
    }
    T.toast(n + " section" + (n === 1 ? "" : "s") + " added around the matches", "ok");
  };

  S.run = async () => {
    const ev = T.player.ev;
    const q = ($("findQuery").value || "").trim();
    if (!ev) { T.toast("Open an event first.", "err"); return; }
    if (q.length < 3) { T.toast("Type what to look for, for example: a person in a hoodie and a mask", "err"); return; }
    if (S.running) return;
    const cams = camsFor($("findCam").value, ev);
    if (!cams.length) { T.toast("No playable camera in this event yet. Unlock encrypted clips first.", "err"); return; }
    if (S.cacheEvent !== ev.id) { S.cache.clear(); S.cacheEvent = ev.id; }
    const list = samples(ev, cams);
    if (!list.length) { T.toast("Nothing to scan in this event.", "err"); return; }

    S.running = true; S.stop = false;
    $("btnFind").disabled = true;
    $("btnFindStop").hidden = false;
    S.hits = []; S.allHits = null;
    if (T.detect) T.detect.clear();
    if (T.vehicle) T.vehicle.chips([]);
    renderHits();
    // Phase 6 part B: "ask <anything>" → the user's own cloud provider (opt-in, consent first), on a few sampled frames
    if (T.cloud && T.cloud.handlesQuery(q)) {
      try {
        S.phrase = T.cloud.queryOf(q); S.query = null; S.anchor = null;
        const rows = await T.cloud.find(q, ev, cams, { status, stopped: () => S.stop });
        S.hits = cluster(rows);
        renderHits();
        const who = T.cloud.PROVIDERS[T.cloud.provider()].label;
        status(S.hits.length ? S.hits.length + " moment" + (S.hits.length === 1 ? "" : "s") + " where " + who + " saw “" + S.phrase + "”. Answers from a cloud model can be wrong; check the video." : who + " found no “" + S.phrase + "” in the sampled frames.");
        if (S.hits.length) openHit(S.hits[0]);
      } catch (err) {
        console.warn("cloud search failed", err);
        status(String(err.message) === "cancelled" ? "Nothing was sent." : "Cloud search failed: " + (err.message || err) + " Nothing else changed.");
      } finally { S.running = false; S.stop = false; $("btnFind").disabled = false; $("btnFindStop").hidden = true; }
      return;
    }
    // Phase 6: plates ("plate 7AB*", "7ABC 23", "plates") and street names ("street Palm Ave"), read on this device
    // natural plate phrases ("blur the license plate", "find plate 9DZM") never go to the picture search
    const plateAsk = T.plates && T.plates.parse(q);
    if (plateAsk && plateAsk.explicit && !T.plates.enabled()) {
      S.running = false; $("btnFind").disabled = false; $("btnFindStop").hidden = true;
      if (T.vehicle) T.vehicle.chips(plateAsk.kind === "plate" ? [plateAsk.blur ? "blur" : "find", "plate", plateAsk.all ? "any" : plateAsk.label] : ["street", plateAsk.label]);
      status("That's a " + (plateAsk.kind === "plate" ? "plate" : "street text") + " search. Turn on Settings ▸ Plates & text (beta) to " + (plateAsk.blur ? "blur plates" : "find plates and street names") + "; it reads them on this device.");
      return;
    }
    // Vehicle details (beta): "red tour bus", "white police car", "ambulance", "Tesla Model Y", "blue Toyota"
    if (T.vehicle && T.vehicle.handlesQuery(q) && T.detect) {
      try {
        const vq = T.vehicle.parse(q);
        S.phrase = q; S.query = null; S.anchor = null;
        T.vehicle.chips(vq.chips.concat(vq.make && !T.vehicle.prefs().makes ? ["make & model: off (Settings)"] : []));
        const rows = await T.vehicle.runSearch(q, list, { status, stopped: () => S.stop });
        S.allHits = T.vehicle.cluster(rows);
        applyBest();
        renderHits();
        const ls = T.vehicle.lastSearch || {};
        const off = vq.make && !T.vehicle.prefs().makes ? " Make & model is off, so " + vq.make + " was not checked (Settings ▸ Vehicle details)." : "";
        if (!S.hits.length) status((S.stop ? "Stopped. " : "") + "No " + vq.label + " found in " + (ls.frames || 0) + " frames." + off + " Colours and types are guesses; try fewer words (\"bus\", \"red bus\") or more cameras.");
        else status((S.hits.length < S.allHits.length ? "Best match only: " + S.hits.length + " of " + S.allHits.length : String(S.hits.length)) + " result" + (S.allHits.length === 1 ? "" : "s") + " for " + vq.label + "." + off + " Colour, type and make are guesses from the picture; check the video." + (ls.reused ? " (" + ls.reused + " frames from the vehicle index)" : ""));
        if (S.hits.length) openHit(S.hits.find((h) => h.best) || S.hits[0]);
      } catch (err) {
        console.warn("vehicle search failed", err);
        status("Vehicle details unavailable (" + (err.message || err) + "). Nothing else changed; plain words still use the picture search.");
      } finally { S.running = false; S.stop = false; $("btnFind").disabled = false; $("btnFindStop").hidden = true; }
      return;
    }
    if (T.plates && T.plates.handlesQuery(q)) {
      try {
        S.phrase = q; S.query = null; S.anchor = null;
        const parsed = T.plates.parse(q);
        if (T.vehicle) T.vehicle.chips(parsed.kind === "plate" ? [parsed.blur ? "blur" : "find", "plate", parsed.all ? "any" : parsed.label] : ["street", parsed.label]);
        if (parsed.blur && parsed.kind === "plate" && !T.plates.prefs().blur) { T.plates.setPref("blur", true); T.toast("Plate blur is on (preview and export). Turn it off in Settings ▸ Plates & text.", "ok", 5000); }
        const rows = await T.plates.runSearch(q, ev, cams, { status, stopped: () => S.stop });
        S.allHits = T.plates.cluster ? T.plates.cluster(rows) : cluster(rows);
        applyBest();
        renderHits();
        const others = (T.plates.lastOthers || []).length;
        const more = others ? " Also seen in " + others + " other indexed event" + (others === 1 ? "" : "s") + "." : "";
        if (!S.hits.length) status("No " + (parsed.kind === "plate" ? "plate matching " + parsed.label : "street text matching “" + parsed.label + "”") + " in this event." + more + " Readings can be wrong; try a shorter pattern like 7AB*, or more cameras.");
        else status((S.hits.length < S.allHits.length ? "Best match only: " + S.hits.length + " of " + S.allHits.length : String(S.hits.length)) + " result" + (S.allHits.length === 1 ? "" : "s") + " with " + (parsed.kind === "plate" ? "plate " + parsed.label : "“" + parsed.label + "”") + " (same readings merged)." + more + " Read on this device; check the video, readings can be wrong.");
        if (S.hits.length) openHit(S.hits.find((h) => h.best) || S.hits[0]);
        if (T.cloud) T.cloud.syncButton();
      } catch (err) {
        console.warn("plate search failed", err);
        status(String(err.message) === "stopped" ? "Stopped." : "Plate reading unavailable (" + (err.message || err) + "). Nothing else changed.");
      } finally { S.running = false; S.stop = false; $("btnFind").disabled = false; $("btnFindStop").hidden = true; }
      return;
    }
    if (T.detect && T.detect.handlesQuery(q)) {
      let done = false;
      try {
        S.phrase = q; S.query = null; S.anchor = null;
        if (T.vehicle) T.vehicle.chips(["detector: " + (T.detect.classFor(q) || q)]);
        const rows = await T.detect.runSearch(q, list, { status, stopped: () => S.stop });
        S.hits = cluster(rows);
        renderHits();
        if (!S.hits.length) status("The detector found no " + (T.detect.classFor(q) || "“" + q + "”") + " above " + Math.round(T.detect.prefs().conf * 100) + "% confidence. Lower the confidence in Settings, or try other cameras.");
        else status(S.hits.length + " moment" + (S.hits.length === 1 ? "" : "s") + " with " + (T.detect.classFor(q) || "“" + q + "”") + ". Click one to jump there.");
        if (S.hits.length) openHit(S.hits[0]);
        done = true;
        return;
      } catch (err) {
        console.warn("detector search failed, using the picture search instead", err);
        T.toast("Object detection unavailable (" + (err.message || err) + "). Using the regular picture search.", "err", 6000);
      } finally {
        if (done) { S.running = false; S.stop = false; $("btnFind").disabled = false; $("btnFindStop").hidden = true; }
      }
    }
    try {
      const model = await loadModel(status);
      if (S.stop) return;
      status("Reading the search phrase…");
      S.phrase = q;
      if (T.vehicle) T.vehicle.chips(["picture search"]);
      S.query = await textVec(model, q);
      S.anchor = null;
      const query = S.query;
      const neutral = await textVec(model, "an ordinary road with cars and no matching subject");
      const video = S.video || (S.video = document.createElement("video"));
      video.muted = true; video.playsInline = true; video.preload = "auto";
      const canvas = S.canvas || (S.canvas = document.createElement("canvas"));
      canvas.width = 224; canvas.height = 224;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const scored = [];
      for (let i = 0; i < list.length; i++) {
        if (S.stop) break;
        const sample = list[i];
        status("Looking at " + (i + 1) + " of " + list.length + " · " + (CAM_LABEL[sample.cam] || sample.cam) + " · " + T.fmtTime(sample.t, true) + ". The video stays on this computer.");
        let vec;
        try { vec = await frameEmbed(model, video, canvas, ctx, sample); }
        catch (err) { console.warn("frame skipped", sample, err); continue; }
        const score = cos(vec, query) - cos(vec, neutral);
        scored.push({ t: sample.t, cam: sample.cam, score });
        if ((i & 3) === 0) await new Promise((r) => setTimeout(r, 0));
      }
      scored.sort((a, b) => b.score - a.score);
      const strong = scored.filter((r) => r.score >= 0.02);
      const picked = cluster(strong.length ? strong : scored.slice(0, 5).map((r) => ({ ...r, weak: true })));
      if (!strong.length) picked.forEach((r) => { r.weak = true; });
      S.hits = picked;
      renderHits();
      if (S.stop) status("Stopped. " + S.hits.length + " moment" + (S.hits.length === 1 ? "" : "s") + " marked so far.");
      else if (!S.hits.length) status("No moment stood out for “" + q + "”. Try a simpler phrase, or look at more cameras.");
      else status((S.hits.some((h) => h.weak) ? "Closest moments" : "Possible matches") + " for “" + q + "”. These are guesses from the picture, not proof. Click one to jump there. The yellow marks are on the timeline." + (T.vehicle && !T.vehicle.enabled() && (() => { const p = T.vehicle.parse(q); return p && (p.color || p.type || p.make); })() ? " Tip: turn on Settings ▸ Vehicle details (beta) to search by vehicle colour and type." : ""));
      if (S.hits.length) openHit(S.hits[0]);
    } catch (err) {
      console.error(err);
      status(explain(err));
      T.toast("Video search could not start. See the note under the search box.", "err", 7000);
    } finally {
      S.running = false; S.stop = false;
      $("btnFind").disabled = false;
      $("btnFindStop").hidden = true;
    }
  };

  S.init = () => {
    $("btnFind").addEventListener("click", () => S.run());
    $("findQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") S.run(); });
    $("btnFindStop").addEventListener("click", () => { S.stop = true; status("Stopping…"); });
    $("btnFindClear").addEventListener("click", () => S.clear());
    $("btnFindMarks").addEventListener("click", () => S.markSections());
    if ($("findShow")) $("findShow").addEventListener("change", () => {
      const on = $("findShow").checked;
      const group = S.anchor == null ? [] : groupAt(S.anchor);
      if (on && group.some((g) => !g.box)) openHit(group[0]);
      else paintBoxes();
    });
    if ($("findFollow")) $("findFollow").addEventListener("change", () => paintBoxes());
    T.on("time", paintBoxes);
    T.on("layout", paintBoxes);
    T.on("player-open", (ev) => { if (!ev || ev.id !== S.cacheEvent) S.clear(); });
  };
})();
