/* redact.js — blur or remove plates, faces, and text from the video already loaded in the window.
 * Text regions come from PP-OCRv4 (the same job as the Python CRAFT detector) running in the
 * browser through ONNX Runtime. Nothing is installed and the video is not uploaded.
 * The original files are not changed. Export burns the same boxes into the file. */
(function () {
  "use strict";
  const T = window.TDC;
  const R = (T.redact = {
    active: false, action: "blur", running: false, stop: false,
    frames: {}, eventId: null,
  });
  const $ = (id) => document.getElementById(id);
  const CAMS = {
    front: ["front"],
    around: ["front", "left_repeater", "right_repeater", "back", "left_pillar", "right_pillar"],
  };

  function status(text) {
    const n = $("redactStatus");
    if (!n) return;
    n.hidden = !text;
    n.textContent = text || "";
  }

  function parseInstruction(text) {
    const raw = String(text || "").trim();
    const t = raw.toLowerCase();
    const action = /\b(remove|erase|inpaint|delete)\b/.test(t) ? "remove" : "blur";
    const targets = [];
    if (/plate|licen[cs]e|number plate/.test(t)) targets.push("plate");
    if (/\b(face|faces|people|pedestrian)\b/.test(t)) targets.push("face");
    const allText = /\ball text\b|\bevery text\b|\ball words\b/.test(t);
    const wantSigns = /\b(street|road|traffic|highway)\s+(signs?|names?)\b/.test(t);
    const quoted = [...raw.matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => (m[1] || m[2]).trim()).filter((s) => s.length >= 2);
    let phrases = quoted;
    if (!phrases.length && !allText) {
      const rest = raw
        .replace(/"[^"]*"|'[^']*'/g, " ")
        .replace(/\b(street|road|traffic|highway)\s+(signs?|names?)\b/gi, " ")
        .replace(/\b(blur|remove|erase|inpaint|delete|redact|the|a|an|name|names|person'?s?|word|words|text|sign|signs|only|just|and|or)\b/gi, " ")
        .replace(/\b(plates?|licen[cs]es?|number plate|faces|people|pedestrians?)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (rest) phrases = rest.split(/[,;]+/).map((s) => s.trim()).filter((s) => s.length >= 2);
    }
    if (allText) targets.push("text");
    if (wantSigns) targets.push("sign");
    if (phrases.length) targets.push("phrase");
    return { action, targets, phrases };
  }

  function normWord(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function edits(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 2;
    const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
    for (let j = 1; j <= b.length; j++) {
      let prev = dp[0];
      dp[0] = j;
      for (let i = 1; i <= a.length; i++) {
        const cur = dp[i];
        dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i], dp[i - 1]);
        prev = cur;
      }
    }
    return dp[a.length];
  }

  const ABBR = { st: "street", ave: "avenue", av: "avenue", blvd: "boulevard", dr: "drive", rd: "road", ln: "lane", ct: "court", pl: "place", hwy: "highway", pkwy: "parkway" };

  function tokenHit(rt, n) {
    if (rt === n || ABBR[rt] === n || ABBR[n] === rt) return true;
    return n.length >= 4 && (rt.startsWith(n) || n.startsWith(rt) || edits(rt, n) <= 1);
  }

  function phraseHit(recognized, phrases) {
    const tokens = String(recognized || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const compact = tokens.join("");
    if (!compact) return false;
    return phrases.some((phrase) => {
      const whole = normWord(phrase);
      if (whole.length >= 4 && (compact.includes(whole) || (whole.includes(compact) && compact.length >= whole.length - 1))) return true;
      const words = [];
      for (const w of phrase.split(/[^A-Za-z0-9]+/)) {
        const n = normWord(w);
        if (!n) continue;
        if (ABBR[n]) { words.push(n, ABBR[n]); }
        else if (n.length >= 3) words.push(n);
      }
      return words.some((n) => tokens.some((rt) => tokenHit(rt, n)));
    });
  }

  function isPlateShape(box) {
    const ar = box.w / Math.max(1e-4, box.h);
    const cy = box.y + box.h / 2;
    return ar >= 1.45 && ar <= 8.5 && box.w >= 0.018 && box.w <= 0.55 && box.h >= 0.008 && box.h <= 0.16 && cy >= 0.26 && cy <= 0.94;
  }

  function mergeRun(parts) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const b of parts) {
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    }
    const padX = (x1 - x0) * 0.12, padY = (y1 - y0) * 0.45;
    return {
      x: Math.max(0, x0 - padX),
      y: Math.max(0, y0 - padY),
      w: Math.min(1 - Math.max(0, x0 - padX), x1 - x0 + padX * 2),
      h: Math.min(1 - Math.max(0, y0 - padY), y1 - y0 + padY * 2),
    };
  }

  function overlaps(a, b) {
    const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const inter = x * y;
    const area = Math.min(a.w * a.h, b.w * b.h);
    return area > 0 && inter / area > 0.45;
  }

  function plateBoxes(found) {
    const items = found.map((b) => ({ b, cx: b.x + b.w / 2, cy: b.y + b.h / 2 }));
    items.sort((a, c) => a.cy - c.cy);
    const lines = [];
    for (const it of items) {
      let placed = false;
      for (const line of lines) {
        const lh = line.reduce((s, p) => s + p.b.h, 0) / line.length;
        const ly = line.reduce((s, p) => s + p.cy, 0) / line.length;
        if (Math.abs(it.cy - ly) <= Math.max(lh, it.b.h) * 0.65 && it.b.h < lh * 2.4 && lh < it.b.h * 2.4) {
          line.push(it);
          placed = true;
          break;
        }
      }
      if (!placed) lines.push([it]);
    }
    const out = [];
    for (const line of lines) {
      line.sort((a, c) => a.cx - c.cx);
      let run = [line[0]];
      const flush = () => {
        if (!run.length) return;
        const merged = mergeRun(run.map((r) => r.b));
        const ar = merged.w / Math.max(1e-4, merged.h);
        const cy = merged.y + merged.h / 2;
        const glyphs = run.length >= 4 && run.length <= 10 && ar >= 1.7 && ar <= 9 && merged.w >= 0.025 && merged.w <= 0.5 && merged.h <= 0.16 && cy >= 0.28 && cy <= 0.93;
        if (glyphs || isPlateShape(merged)) out.push(merged);
        run = [];
      };
      for (let i = 1; i < line.length; i++) {
        const prev = run[run.length - 1];
        const gap = line[i].b.x - (prev.b.x + prev.b.w);
        const limit = Math.max(prev.b.w, line[i].b.w, 0.008) * 2.2;
        if (gap > limit) { flush(); run = [line[i]]; }
        else run.push(line[i]);
      }
      flush();
    }
    const kept = [];
    out.sort((a, b) => (b.w * b.h) - (a.w * a.h));
    for (const box of out) {
      if (!kept.some((k) => overlaps(k, box))) kept.push(box);
    }
    return kept;
  }

  function lerpBoxes(a, b, u) {
    if (!a.length) return b;
    if (!b.length || a.length !== b.length) return u < 0.5 ? a : b;
    const left = a.slice().sort((p, q) => p.x - q.x);
    const right = b.slice().sort((p, q) => p.x - q.x);
    return left.map((p, i) => {
      const q = right[i];
      return {
        x: p.x + (q.x - p.x) * u,
        y: p.y + (q.y - p.y) * u,
        w: p.w + (q.w - p.w) * u,
        h: p.h + (q.h - p.h) * u,
      };
    });
  }

  function boxesAt(cam, t) {
    const keys = R.frames[cam];
    if (!keys || !keys.length) return [];
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
    const a = keys[i];
    const b = keys[i + 1];
    if (!b || t < a.t - 0.2 || b.t - a.t > 1.2) return Math.abs((b && t > a.t ? b : a).t - t) <= 0.75 ? (t > a.t && b ? b.boxes : a.boxes) : [];
    const u = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
    return lerpBoxes(a.boxes, b.boxes, u);
  }

  function contain(iw, ih, r) {
    const s = Math.min(r.w / iw, r.h / ih);
    const w = iw * s, h = ih * s;
    return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
  }

  function boxesAt(cam, t) {
    const keys = R.frames[cam];
    if (!keys || !keys.length) return [];
    let best = null, dist = 1e9;
    for (let i = 0; i < keys.length; i++) {
      const d = Math.abs(keys[i].t - t);
      if (d < dist) { dist = d; best = keys[i]; }
    }
    return best && dist <= 0.85 ? best.boxes : [];
  }

  function paintBox(ctx, img, iw, ih, fit, box, action) {
    const dx = fit.x + box.x * fit.w, dy = fit.y + box.y * fit.h;
    const dw = Math.max(2, box.w * fit.w), dh = Math.max(2, box.h * fit.h);
    const sx = box.x * iw, sy = box.y * ih, sw = box.w * iw, sh = box.h * ih;
    ctx.save();
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    ctx.clip();
    if (action === "remove") {
      const srcY = Math.max(0, sy - sh * 0.55);
      const srcH = Math.max(2, sh * 0.4);
      ctx.drawImage(img, sx, srcY, Math.max(2, sw), srcH, dx, dy, dw, dh);
      ctx.filter = "blur(3px)";
      ctx.drawImage(img, sx, srcY, Math.max(2, sw), srcH, dx, dy, dw, dh);
    } else {
      const pad = 0.45;
      ctx.filter = "blur(" + Math.max(10, Math.round(dw * 0.22)) + "px)";
      ctx.drawImage(img, sx - sw * pad, sy - sh * pad, sw * (1 + 2 * pad), sh * (1 + 2 * pad), dx - dw * pad, dy - dh * pad, dw * (1 + 2 * pad), dh * (1 + 2 * pad));
    }
    ctx.restore();
  }

  function blurOn() {
    const box = $("redactShow");
    return !box || box.checked;
  }

  // Phase 6: plates found by the plate detector (Settings ▸ Plates & text ▸ Blur plates) are blurred too.
  function plateBlur(cam, t) { try { return T.plates && T.plates.blurOn() ? T.plates.blurBoxesAt(cam, t) : []; } catch (_) { return []; } }

  R.burn = (ctx, cam, t, cell, iw, ih, img) => {
    if (!iw || !ih) return;
    const pb = plateBlur(cam, t);
    if (pb.length) { const fit = contain(iw, ih, cell); for (const box of pb) paintBox(ctx, img, iw, ih, fit, box, "blur"); }
    if (!R.active || !blurOn()) return;
    const boxes = boxesAt(cam, t);
    if (!boxes.length) return;
    const fit = contain(iw, ih, cell);
    for (const box of boxes) paintBox(ctx, img, iw, ih, fit, box, R.action);
  };

  function ensureLayers() {
    for (const cam of T.GRID) {
      const tile = T.player.tiles[cam] && T.player.tiles[cam].tile;
      if (!tile || tile.querySelector(".redact-layer")) continue;
      const cv = document.createElement("canvas");
      cv.className = "redact-layer";
      tile.appendChild(cv);
    }
  }

  function paintLive() {
    if (!T.player.tiles) return;
    ensureLayers();
    const t = T.player.time;
    for (const cam of T.GRID) {
      const tile = T.player.tiles[cam];
      if (!tile) continue;
      const cv = tile.tile.querySelector(".redact-layer");
      if (!cv) continue;
      const video = tile.vids[T.player.active];
      cv.style.transform = video ? video.style.transform : "";
      const tw = tile.tile.clientWidth, th = tile.tile.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(tw * dpr)), h = Math.max(1, Math.round(th * dpr));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const ctx = cv.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, tw, th);
      if (!video || !video.videoWidth) continue;
      const pb = plateBlur(cam, t);
      if (pb.length) { const fit = contain(video.videoWidth, video.videoHeight, { x: 0, y: 0, w: tw, h: th }); for (const box of pb) paintBox(ctx, video, video.videoWidth, video.videoHeight, fit, box, "blur"); }
      if (!R.active || !blurOn()) continue;
      const boxes = boxesAt(cam, t);
      if (!boxes.length) continue;
      const fit = contain(video.videoWidth, video.videoHeight, { x: 0, y: 0, w: tw, h: th });
      for (const box of boxes) paintBox(ctx, video, video.videoWidth, video.videoHeight, fit, box, R.action);
    }
  }

  function b64ToU8(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function joinPart(value) {
    return Array.isArray(value) ? value.join("") : value;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Missing " + src));
      document.head.appendChild(s);
    });
  }

  async function ungzip(value) {
    const raw = b64ToU8(joinPart(value));
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function textSession() {
    if (R.session) return R.session;
    const pack = window.TDC_PACK;
    const ort = window.ort;
    if (!ort || !pack) throw new Error("The letter files are missing from the vendor folder. Open index.html from inside the tesla-dashcam-studio folder.");
    if (!pack.ready) {
      for (const src of pack.files || []) await loadScript(src);
      pack.ready = true;
    }
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    if (!R.wasmUrl) {
      const mjs = await ungzip(pack.mjs);
      const wasm = await ungzip(pack.wasm);
      R.wasmUrl = URL.createObjectURL(new Blob([mjs], { type: "text/javascript" }));
      R.wasmBin = URL.createObjectURL(new Blob([wasm], { type: "application/wasm" }));
      ort.env.wasm.wasmPaths = { mjs: R.wasmUrl, wasm: R.wasmBin };
    }
    R.ort = ort;
    R.session = await ort.InferenceSession.create(await ungzip(pack.det), { executionProviders: ["wasm"] });
    R.rec = await ort.InferenceSession.create(await ungzip(pack.rec), { executionProviders: ["wasm"] });
    if (!R.dict) R.dict = String(pack.dict || "").split(/\n/).filter((line) => line.length);
    return R.session;
  }

  function modelSize(vw, vh) {
    const limit = 960;
    const ratio = Math.max(vw, vh) > limit ? limit / Math.max(vw, vh) : 1;
    return {
      rw: Math.max(32, Math.round(vw * ratio / 32) * 32),
      rh: Math.max(32, Math.round(vh * ratio / 32) * 32),
    };
  }

  function components(mask, w, h, minCount) {
    const need = minCount || 24;
    const seen = new Uint8Array(w * h);
    const boxes = [];
    const stack = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const start = y * w + x;
        if (!mask[start] || seen[start]) continue;
        let minx = x, maxx = x, miny = y, maxy = y, count = 0;
        stack.push(start);
        seen[start] = 1;
        while (stack.length) {
          const p = stack.pop();
          const px = p % w, py = (p / w) | 0;
          count++;
          if (px < minx) minx = px;
          if (px > maxx) maxx = px;
          if (py < miny) miny = py;
          if (py > maxy) maxy = py;
          if (px > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
          if (px + 1 < w && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
          if (py > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack.push(p - w); }
          if (py + 1 < h && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack.push(p + w); }
        }
        if (count >= need) boxes.push({ minx, miny, maxx, maxy, count });
      }
    }
    return boxes;
  }

  async function regionBoxes(canvas, session) {
    const { rw, rh } = modelSize(canvas.width, canvas.height);
    const work = R.work || (R.work = document.createElement("canvas"));
    work.width = rw;
    work.height = rh;
    const wctx = work.getContext("2d", { willReadFrequently: true });
    wctx.drawImage(canvas, 0, 0, rw, rh);
    const px = wctx.getImageData(0, 0, rw, rh).data;
    const data = new Float32Array(3 * rw * rh);
    const plane = rw * rh;
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (let p = 0, i = 0; p < plane; p++, i += 4) {
      data[p] = (px[i] / 255 - mean[0]) / std[0];
      data[plane + p] = (px[i + 1] / 255 - mean[1]) / std[1];
      data[2 * plane + p] = (px[i + 2] / 255 - mean[2]) / std[2];
    }
    const tensor = new R.ort.Tensor("float32", data, [1, 3, rh, rw]);
    const result = await session.run({ x: tensor });
    const out = result[session.outputNames[0]];
    const oh = out.dims[2], ow = out.dims[3], map = out.data;
    const mask = new Uint8Array(ow * oh);
    for (let i = 0; i < mask.length; i++) if (map[i] > 0.3) mask[i] = 1;
    const found = components(mask, ow, oh);
    return found.map((b) => {
      const padX = (b.maxx - b.minx + 1) * 0.18, padY = (b.maxy - b.miny + 1) * 0.28;
      const box = {
        x: Math.max(0, (b.minx - padX) / ow),
        y: Math.max(0, (b.miny - padY) / oh),
        w: Math.min(1, (b.maxx - b.minx + 1 + padX * 2) / ow),
        h: Math.min(1, (b.maxy - b.miny + 1 + padY * 2) / oh),
      };
      return { box, area: box.w * box.h };
    }).filter((row) => row.box.w >= 0.01 && row.box.h >= 0.008 && row.box.w < 0.7).sort((a, b) => b.area - a.area);
  }

  function topCrop(canvas) {
    const crop = R.topCrop || (R.topCrop = document.createElement("canvas"));
    const ch = Math.max(32, Math.round(canvas.height * 0.55));
    crop.width = canvas.width;
    crop.height = ch;
    crop.getContext("2d").drawImage(canvas, 0, 0, canvas.width, ch, 0, 0, crop.width, ch);
    return crop;
  }

  function signColorBoxes(canvas) {
    const dw = Math.min(canvas.width, 960);
    const dh = Math.max(1, Math.round(canvas.height * (dw / canvas.width)));
    const scan = R.signScan || (R.signScan = document.createElement("canvas"));
    scan.width = dw;
    scan.height = dh;
    const ctx = scan.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, dw, dh);
    const px = ctx.getImageData(0, 0, dw, dh).data;
    const mask = new Uint8Array(dw * dh);
    const horizon = Math.round(dh * 0.62);
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      const y = (i / dw) | 0;
      if (y > horizon) continue;
      const r = px[p], g = px[p + 1], b = px[p + 2];
      const green = g > 50 && g < 200 && g > r * 1.15 && g > b * 1.02 && (g - r) > 15;
      const yellow = r > 165 && g > 130 && b < 100 && (r + g) > b * 3;
      const orange = r > 175 && g > 60 && g < 170 && b < 90 && r > g;
      if (green || yellow || orange) mask[i] = 1;
    }
    const boxes = [];
    for (const b of components(mask, dw, dh, 10)) {
      const bw = b.maxx - b.minx + 1, bh = b.maxy - b.miny + 1;
      const w = bw / dw, h = bh / dh;
      const fill = b.count / (bw * bh);
      const ar = w / Math.max(1e-4, h);
      if (w < 0.008 || h < 0.01 || w > 0.2 || h > 0.16) continue;
      if (fill < 0.42 || ar < 0.7 || ar > 8) continue;
      boxes.push({
        x: Math.max(0, b.minx / dw - w * 0.18),
        y: Math.max(0, b.miny / dh - h * 0.22),
        w: Math.min(1, w * 1.36),
        h: Math.min(1, h * 1.5),
      });
    }
    return boxes.slice(0, 8);
  }

  function hasLetters(text) {
    return normWord(text).length >= 3;
  }

  async function readText(canvas, targets, phrases) {
    const session = await textSession();
    const ranked = await regionBoxes(canvas, session);
    const boxes = [];
    const wantPhrase = targets.indexOf("phrase") >= 0;
    const wantAll = targets.indexOf("text") >= 0;
    const wantSign = targets.indexOf("sign") >= 0;
    let reads = 0;
    if (targets.indexOf("plate") >= 0) {
      // Phase 6: the real plate detector when Plates & text is on; the text-shape guess otherwise (or if it fails)
      let real = null;
      if (T.plates && T.plates.enabled()) {
        try { real = (await T.plates.detectPlates(canvas, canvas.width, canvas.height)).map((d) => ({ x: Math.max(0, d.x - d.w * 0.12), y: Math.max(0, d.y - d.h * 0.2), w: Math.min(1, d.w * 1.24), h: Math.min(1, d.h * 1.4) })); }
        catch (err) { console.warn("plate detector unavailable, using text shapes", err); real = null; }
      }
      for (const box of real || plateBoxes(ranked.map((row) => row.box))) boxes.push(box);
    }
    for (const row of ranked) {
      const box = row.box;
      if (!wantAll && !wantPhrase) continue;
      if (wantAll) { boxes.push(box); continue; }
      if (reads >= 16) continue;
      reads++;
      try {
        const text = await recognize(canvas, box);
        if (phraseHit(text, phrases)) boxes.push(box);
      } catch (err) { console.warn(err); }
    }
    if (wantPhrase || wantSign) {
      const extra = [];
      try {
        const zoom = await regionBoxes(topCrop(canvas), session);
        for (const row of zoom) {
          const box = { x: row.box.x, y: row.box.y * 0.55, w: row.box.w, h: row.box.h * 0.55 };
          if (box.h < 0.004 || box.w > 0.45) continue;
          extra.push({ box, sign: false });
        }
      } catch (err) { console.warn(err); }
      for (const box of signColorBoxes(canvas)) extra.push({ box, sign: true });
      extra.sort((a, b) => (b.sign - a.sign) || (a.box.w * a.box.h - b.box.w * b.box.h));
      let n = 0;
      for (const item of extra) {
        if (n >= 12) break;
        if (boxes.some((b) => overlaps(b, item.box))) continue;
        n++;
        try {
          const text = await recognize(canvas, item.box, true);
          const named = wantPhrase && phraseHit(text, phrases);
          const board = wantSign && hasLetters(text) && (item.sign || item.box.y < 0.58);
          if (named || board) boxes.push(item.box);
        } catch (err) { console.warn(err); }
      }
    }
    return boxes;
  }

  /** Phase 6: read street names / sign text in a frame (canvas). → [{box, text, conf}] (letters only, ≥ 3). */
  R.readSigns = async (canvas) => {
    const session = await textSession();
    const cand = [];
    for (const box of signColorBoxes(canvas)) cand.push({ box, pri: 3 });
    try {
      for (const row of await regionBoxes(topCrop(canvas), session)) {
        const box = { x: row.box.x, y: row.box.y * 0.55, w: row.box.w, h: row.box.h * 0.55 };
        if (box.h >= 0.004 && box.w <= 0.45) cand.push({ box, pri: 2 });
      }
    } catch (err) { console.warn(err); }
    for (const row of (await regionBoxes(canvas, session)).slice(0, 10)) cand.push({ box: row.box, pri: row.box.y < 0.55 ? 1 : 0 });
    cand.sort((a, b) => b.pri - a.pri);
    const out = [];
    for (const c of cand) {
      if (out.length >= 8 || out.some((o) => overlaps(o.box, c.box))) continue;
      let text = "";
      try { text = await recognize(canvas, c.box, true); } catch (err) { continue; }
      const letters = (text.match(/[A-Za-z]/g) || []).length;
      if (letters < 3 || letters < text.replace(/\s/g, "").length * 0.5 || (R.lastScore || 0) < 0.5) continue;
      out.push({ box: c.box, text: text.replace(/\s+/g, " ").trim(), conf: Math.round((R.lastScore || 0) * 100) / 100 });
    }
    return out;
  };

  async function recognize(canvas, box, boost) {
    const x = Math.max(0, Math.floor(box.x * canvas.width));
    const y = Math.max(0, Math.floor(box.y * canvas.height));
    const w = Math.max(2, Math.min(canvas.width - x, Math.ceil(box.w * canvas.width)));
    const h = Math.max(2, Math.min(canvas.height - y, Math.ceil(box.h * canvas.height)));
    const rh = 48;
    const rw = Math.max(8, Math.min(320, Math.ceil(rh * (w / h))));
    const work = R.recCanvas || (R.recCanvas = document.createElement("canvas"));
    work.width = rw;
    work.height = rh;
    const ctx = work.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, rw, rh);
    if (boost) ctx.filter = "contrast(1.7) brightness(1.12)";
    ctx.drawImage(canvas, x, y, w, h, 0, 0, rw, rh);
    ctx.filter = "none";
    const px = ctx.getImageData(0, 0, rw, rh).data;
    const data = new Float32Array(3 * rh * rw);
    const plane = rh * rw;
    for (let p = 0, i = 0; p < plane; p++, i += 4) {
      data[p] = (px[i] / 255 - 0.5) / 0.5;
      data[plane + p] = (px[i + 1] / 255 - 0.5) / 0.5;
      data[2 * plane + p] = (px[i + 2] / 255 - 0.5) / 0.5;
    }
    const tensor = new R.ort.Tensor("float32", data, [1, 3, rh, rw]);
    const result = await R.rec.run({ x: tensor });
    const out = result[R.rec.outputNames[0]];
    const time = out.dims[1], classes = out.dims[2], map = out.data, dict = R.dict;
    let prev = -1, text = "", sum = 0, cnt = 0;
    for (let t = 0; t < time; t++) {
      let best = 0, score = -1;
      const off = t * classes;
      for (let c = 0; c < classes; c++) if (map[off + c] > score) { score = map[off + c]; best = c; }
      if (best !== 0 && best !== prev && best - 1 < dict.length) { text += dict[best - 1]; sum += score; cnt++; }
      prev = best;
    }
    R.lastScore = cnt ? sum / cnt : 0;   // mean character confidence (Phase 6 street-text index)
    return text.trim();
  }

  async function faceDetector() {
    if (R.faces) return R.faces;
    if ("FaceDetector" in window) {
      R.faces = { kind: "native", det: new window.FaceDetector({ fastMode: true, maxDetectedFaces: 12 }) };
      return R.faces;
    }
    const mod = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/+esm");
    const files = await mod.FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/wasm");
    const det = await mod.FaceDetector.createFromOptions(files, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
        delegate: "CPU",
      },
      runningMode: "IMAGE",
      minDetectionConfidence: 0.6,
    });
    R.faces = { kind: "mp", det };
    return R.faces;
  }

  function wait(el, ev, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { el.removeEventListener(ev, ok); reject(new Error("frame timed out")); }, ms);
      const ok = () => { clearTimeout(timer); resolve(); };
      el.addEventListener(ev, ok, { once: true });
    });
  }

  async function grab(video, canvas, ctx, it, local) {
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
    const w = Math.min(960, video.videoWidth || 960);
    const h = Math.max(1, Math.round((video.videoHeight || 540) * (w / (video.videoWidth || w))));
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    return { w, h, vw: video.videoWidth, vh: video.videoHeight };
  }

  async function readFaces(canvas) {
    const faces = await faceDetector();
    const out = [];
    if (faces.kind === "native") {
      const found = await faces.det.detect(canvas);
      for (const f of found) {
        const b = f.boundingBox;
        const bw = b.width / canvas.width, bh = b.height / canvas.height;
        out.push({
          x: Math.max(0, b.x / canvas.width - bw * 0.15),
          y: Math.max(0, b.y / canvas.height - bh * 0.2),
          w: Math.min(1, bw * 1.3),
          h: Math.min(1, bh * 1.45),
        });
      }
      return out;
    }
    const found = faces.det.detect(canvas);
    for (const f of (found && found.detections) || []) {
      const b = f.boundingBox;
      if (!b) continue;
      const bw = b.width / canvas.width, bh = b.height / canvas.height;
      out.push({
        x: Math.max(0, b.originX / canvas.width - bw * 0.15),
        y: Math.max(0, b.originY / canvas.height - bh * 0.2),
        w: Math.min(1, bw * 1.3),
        h: Math.min(1, bh * 1.45),
      });
    }
    return out;
  }

  function samples(ev, cams) {
    const step = 0.5;
    const out = [];
    for (let t = 0.2; t < ev.duration - 0.05; t += step) {
      const clip = ev.clips[T.player.clipIndexAt(t)];
      for (const cam of cams) {
        const it = clip && clip.files[cam];
        if (!it || !it.blob) continue;
        out.push({ t, cam, it, local: Math.max(0, t - clip.start) });
      }
      if (out.length > 240) break;
    }
    return out;
  }

  function syncButtons() {
    const on = R.active && Object.keys(R.frames).length > 0;
    const stop = $("btnRedactStop"), clear = $("btnRedactClear"), go = $("btnRedact");
    if (stop) stop.hidden = !R.running;
    if (clear) clear.hidden = !on;
    if (go) go.disabled = R.running;
    const wrap = $("redactShowWrap");
    if (wrap) wrap.hidden = !on;
  }

  R.clear = () => {
    R.active = false;
    R.frames = {};
    paintLive();
    status("");
    syncButtons();
  };

  R.run = async (text) => {
    const ev = T.player.ev;
    const q = (text != null ? text : ($("redactQuery") && $("redactQuery").value) || "").trim();
    if (!ev) { T.toast("Open an event first.", "err"); return; }
    const parsed = parseInstruction(q);
    if (!parsed.targets.length) {
      T.toast("Type the words to hide, for example a name. Or use Blur plates, Blur faces, or All text.", "err");
      return;
    }
    const cams = (CAMS[$("redactCam").value] || CAMS.front).filter((c) => ev.clips.some((clip) => clip.files[c] && clip.files[c].blob));
    if (!cams.length) { T.toast("No playable camera yet. Unlock encrypted clips first.", "err"); return; }
    if (R.running) return;
    R.running = true;
    R.stop = false;
    R.action = parsed.action;
    R.frames = {};
    R.eventId = ev.id;
    syncButtons();
    const list = samples(ev, cams);
    const video = R.video || (R.video = document.createElement("video"));
    video.muted = true; video.playsInline = true;
    const canvas = R.canvas || (R.canvas = document.createElement("canvas"));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let hits = 0;
    try {
      status("Loading the text finder into this window. The first time downloads it (about 15 MB). Nothing to install. The video stays on this computer.");
      if (parsed.targets.indexOf("text") >= 0 || parsed.targets.indexOf("phrase") >= 0 || parsed.targets.indexOf("plate") >= 0) await textSession();
      if (parsed.targets.indexOf("face") >= 0) await faceDetector();
      for (let i = 0; i < list.length; i++) {
        if (R.stop) break;
        const sample = list[i];
        status("Looking at " + (i + 1) + " of " + list.length + " · " + T.CAM_LABEL[sample.cam] + " · " + T.fmtTime(sample.t, true));
        let shot;
        try { shot = await grab(video, canvas, ctx, sample.it, sample.local); }
        catch (err) { console.warn(err); continue; }
        const boxes = [];
        if (parsed.targets.indexOf("text") >= 0 || parsed.targets.indexOf("phrase") >= 0 || parsed.targets.indexOf("plate") >= 0) {
          try { boxes.push.apply(boxes, await readText(canvas, parsed.targets, parsed.phrases)); }
          catch (err) { console.warn(err); }
        }
        if (parsed.targets.indexOf("face") >= 0) {
          try { boxes.push.apply(boxes, await readFaces(canvas)); }
          catch (err) { console.warn(err); }
        }
        if (!R.frames[sample.cam]) R.frames[sample.cam] = [];
        R.frames[sample.cam].push({ t: sample.t, boxes });
        hits += boxes.length;
        if (boxes.length) { R.active = true; paintLive(); syncButtons(); }
      }
      R.active = hits > 0;
      paintLive();
      if (R.stop) status("Stopped.");
      else if (!hits) status(parsed.phrases && parsed.phrases.length ? "Didn't read “" + parsed.phrases.join(", ") + "” in this clip. Other words were left alone. Try the spelling as it appears." : "Nothing matched “" + q + "”. Try another camera, or a clearer moment in the clip.");
      else status((parsed.action === "remove" ? "Removed" : "Blurred") + " " + hits + " spot" + (hits === 1 ? "" : "s") + (parsed.phrases && parsed.phrases.length ? " matching “" + parsed.phrases.join(", ") + "”. Other text stays visible." : " for “" + q + "”.") + " Playback and export both use this. Clear removes the effect. The original file is unchanged.");
    } catch (err) {
      console.error(err);
      R.active = false;
      status("Could not start: " + (err && err.message ? err.message : err));
      T.toast("Redaction could not start. See the note under the box.", "err", 7000);
    } finally {
      R.running = false;
      R.stop = false;
      syncButtons();
    }
  };

  R.init = () => {
    ensureLayers();
    $("btnRedact").addEventListener("click", () => R.run());
    $("redactQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") R.run(); });
    $("btnRedactStop").addEventListener("click", () => { R.stop = true; status("Stopping…"); });
    $("btnRedactClear").addEventListener("click", () => R.clear());
    if ($("redactShow")) $("redactShow").addEventListener("change", () => paintLive());
    document.querySelectorAll(".redact-presets button").forEach((b) => {
      b.addEventListener("click", () => {
        $("redactQuery").value = b.getAttribute("data-q");
        R.run(b.getAttribute("data-q"));
      });
    });
    T.on("time", paintLive);
    T.on("layout", paintLive);
    T.on("player-open", (ev) => { if (!ev || ev.id !== R.eventId) R.clear(); });
    syncButtons();
  };
})();
