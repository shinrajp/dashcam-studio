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

  function contain(iw, ih, r) {
    const s = Math.min(r.w / iw, r.h / ih);
    const w = iw * s, h = ih * s;
    return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
  }

  // Boxes between samples: the same text in consecutive samples is linked into a track (text-match.js) and moved
  // smoothly between them, held about half a sample past the first / last sighting. Before, the nearest sample's boxes
  // were shown as they were (they jumped, and moving text such as a truck's side slid out from under its blur).
  function rebuild() {
    R.tracks = {};
    const M = T.textMatch;
    if (!M) return;
    for (const cam of Object.keys(R.frames)) R.tracks[cam] = M.buildTracks(R.frames[cam].filter((f) => f.boxes.length), { maxGap: (R.step || 0.5) * 2.6 + 0.05 });
  }
  R.rebuild = rebuild;
  function boxesAt(cam, t) {
    const M = T.textMatch, hold = Math.max(0.3, (R.step || 0.5) * 0.6);
    if (M && R.tracks && R.tracks[cam]) {
      const out = [];
      for (const tr of R.tracks[cam]) { const b = M.boxAt(tr, t, hold); if (b) out.push(M.pad(b, 0.03, 0.2)); }
      return out;
    }
    const keys = R.frames[cam];
    if (!keys || !keys.length) return [];
    let best = null, dist = 1e9;
    for (let i = 0; i < keys.length; i++) {
      const d = Math.abs(keys[i].t - t);
      if (d < dist) { dist = d; best = keys[i]; }
    }
    return best && dist <= 0.85 ? best.boxes : [];
  }
  R.boxesAt = (cam, t) => (R.active ? boxesAt(cam, t) : []);

  // Canvas 2D `filter` (blur) is missing in Safari (behind a flag up to Safari 27): setting it does nothing, and the
  // "blur" drew a sharp copy of the plate. Test it once; without it, blur by shrinking the area to a few pixels and
  // scaling it back up smoothly (two steps), which works in every browser.
  let canFilter = null;
  R.canvasFilter = () => {
    if (canFilter !== null) return canFilter;
    try {
      if (!("filter" in CanvasRenderingContext2D.prototype)) return (canFilter = false);
      const c = document.createElement("canvas"); c.width = c.height = 16;
      const x = c.getContext("2d", { willReadFrequently: true }); x.filter = "blur(3px)"; x.fillStyle = "#fff"; x.fillRect(8, 0, 8, 16);
      canFilter = x.getImageData(5, 8, 1, 1).data[3] > 0;
    } catch (_) { canFilter = false; }
    return canFilter;
  };
  R.forceSoftBlur = false;   // tests: use the fallback in Chromium too
  let sA = null, sB = null, sC = null, sV = null;
  let vfLast = null;
  function frameCanvas(vf, iw, ih) {
    const w = Math.round(iw || vf.displayWidth), h = Math.round(ih || vf.displayHeight);
    sV = sV || document.createElement("canvas");
    if (vfLast !== vf || sV.width !== w || sV.height !== h) {
      if (sV.width !== w || sV.height !== h) { sV.width = w; sV.height = h; }
      sV.getContext("2d").drawImage(vf, 0, 0, w, h);
      vfLast = vf;
    }
    return sV;
  }
  R.frameCanvas = frameCanvas;
  function softBlur(ctx, img, iw, ih, sx, sy, sw, sh, dx, dy, dw, dh, radius) {
    // keep the source inside the frame (Safari draws nothing for an out-of-bounds source rect); move the target to match
    if (iw && ih) {
      const kx = dw / sw, ky = dh / sh, x0 = Math.max(0, sx), y0 = Math.max(0, sy), x1 = Math.min(iw, sx + sw), y1 = Math.min(ih, sy + sh);
      if (x1 - x0 < 1 || y1 - y0 < 1) return;
      dx += (x0 - sx) * kx; dy += (y0 - sy) * ky; dw = (x1 - x0) * kx; dh = (y1 - y0) * ky; sx = x0; sy = y0; sw = x1 - x0; sh = y1 - y0;
    }
    // shrink by halves (each half averages 2×2 pixels, also in WebKit, whose single big downscale only samples),
    // down to about one pixel per blur radius, then scale up smoothly in two steps
    const tw = Math.max(2, Math.round(dw / Math.max(2, radius))), th = Math.max(2, Math.round(dh / Math.max(2, radius)));
    let w = Math.max(tw, Math.min(512, Math.round(sw))), h = Math.max(th, Math.min(512, Math.round(sh)));
    sA = sA || document.createElement("canvas"); sB = sB || document.createElement("canvas");
    // WebKit ignores the source rectangle of a decoded (I420) VideoFrame, the export's frames: drawImage(frame, sx, sy, sw, sh, …)
    // draws the WHOLE frame shrunk into the box (a tiny sharp copy, not a blur). Copy the frame to a canvas once, use that.
    if (typeof VideoFrame !== "undefined" && img instanceof VideoFrame) img = frameCanvas(img, iw, ih);
    const prep = (c, cw, ch) => { if (c.width < cw || c.height < ch) { c.width = Math.max(c.width, cw); c.height = Math.max(c.height, ch); } const x = c.getContext("2d"); x.imageSmoothingEnabled = true; try { x.imageSmoothingQuality = "high"; } catch (_) {} x.clearRect(0, 0, c.width, c.height); return x; };
    let src = sA, x = prep(sA, w, h); x.drawImage(img, sx, sy, Math.max(1, sw), Math.max(1, sh), 0, 0, w, h);
    while (w > tw || h > th) {
      const nw = Math.max(tw, Math.ceil(w / 2)), nh = Math.max(th, Math.ceil(h / 2));
      const dst = src === sA ? sB : sA; const y = prep(dst, nw, nh); y.drawImage(src, 0, 0, w, h, 0, 0, nw, nh);
      src = dst; w = nw; h = nh;
    }
    // up ×3 first (smooth ramps), then to the target
    const uw = Math.min(256, w * 3), uh = Math.min(256, h * 3);
    sC = sC || document.createElement("canvas"); prep(sC, uw, uh).drawImage(src, 0, 0, w, h, 0, 0, uw, uh);
    const s0 = ctx.imageSmoothingEnabled; ctx.imageSmoothingEnabled = true; try { ctx.imageSmoothingQuality = "high"; } catch (_) {}
    ctx.drawImage(sC, 0, 0, uw, uh, dx, dy, dw, dh);
    ctx.imageSmoothingEnabled = s0;
  }
  function paintBox(ctx, img, iw, ih, fit, box, action) {
    if (typeof VideoFrame !== "undefined" && img instanceof VideoFrame) img = frameCanvas(img, iw, ih);   // see softBlur (WebKit export)
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
      if (R.canvasFilter() && !R.forceSoftBlur) { ctx.filter = "blur(3px)"; ctx.drawImage(img, sx, srcY, Math.max(2, sw), srcH, dx, dy, dw, dh); }
      else softBlur(ctx, img, iw, ih, sx, srcY, Math.max(2, sw), srcH, dx, dy, dw, dh, 3);
    } else {
      // Radius from the SHORT side. It used to be 22% of the width: on a wide, short text line (a sign, a truck's side)
      // that is far taller than the line, and the canvas blur faded the patch to mostly transparent, so the sharp
      // text showed through. Now it is an opaque soft blur (shrink + smooth enlarge), the same in every browser.
      const pad = 0.45, r = Math.max(6, Math.round(Math.min(dw * 0.22, dh * 0.6)));
      softBlur(ctx, img, iw, ih, sx - sw * pad, sy - sh * pad, sw * (1 + 2 * pad), sh * (1 + 2 * pad), dx - dw * pad, dy - dh * pad, dw * (1 + 2 * pad), dh * (1 + 2 * pad), r);
      // (the same in every browser: Safari has no canvas blur filter, and preview, export and Safari now all match)
    }
    ctx.restore();
  }

  function blurOn() {
    const box = $("redactShow");
    return !box || box.checked;
  }

  // Phase 6: plates found by the plate detector (Settings ▸ Plates & text ▸ Blur plates) are blurred too.
  function plateBlur(cam, t) {
    try { return T.plates && T.plates.blurOn() ? T.plates.blurBoxesAt(cam, t) : []; }
    catch (e) { if (T.plates && T.plates.blurError) T.plates.blurError(e, "boxes"); else console.warn("plate blur", e); return []; }
  }

  // search matches with Redact on (burn-boxes.js redactAt: the same list in the viewer and the export)
  function matchBlur(cam, t) {
    try { return T.burnBoxes && T.burnBoxes.redactAt ? T.burnBoxes.redactAt(cam, t) : []; }
    catch (e) { console.warn("match redaction", e); return []; }
  }

  R.burn = (ctx, cam, t, cell, iw, ih, img) => {
    if (!iw || !ih) return;
    const pb = plateBlur(cam, t);
    if (pb.length) { const fit = contain(iw, ih, cell); for (const box of pb) paintBox(ctx, img, iw, ih, fit, box, "blur"); }
    const mb = matchBlur(cam, t);   // burned in whatever Highlight / "Burn detection boxes" say
    if (mb.length) { const fit = contain(iw, ih, cell); for (const box of mb) paintBox(ctx, img, iw, ih, fit, box, "blur"); }
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
      // live white balance colours the <video> with a CSS filter (wb.js); the blurred patches are drawn from the raw
      // frame, so give them the same filter, or they show as uncorrected (orange) rectangles on a corrected picture
      cv.style.filter = video && video.style.filter ? video.style.filter : "";   // SVG mode only (blend mode: tintLike below)
      const tw = tile.tile.clientWidth, th = tile.tile.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(tw * dpr)), h = Math.max(1, Math.round(th * dpr));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const ctx = cv.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, tw, th);
      if (!video || !video.videoWidth) continue;
      const pb = plateBlur(cam, t);
      if (pb.length) { const fit = contain(video.videoWidth, video.videoHeight, { x: 0, y: 0, w: tw, h: th }); for (const box of pb) paintBox(ctx, video, video.videoWidth, video.videoHeight, fit, box, "blur"); tintLike(ctx, fit, pb, cam); }
      const mb = matchBlur(cam, t);
      if (mb.length) { const fit = contain(video.videoWidth, video.videoHeight, { x: 0, y: 0, w: tw, h: th }); for (const box of mb) paintBox(ctx, video, video.videoWidth, video.videoHeight, fit, box, "blur"); tintLike(ctx, fit, mb, cam); }
      if (!R.active || !blurOn()) continue;
      const boxes = boxesAt(cam, t);
      if (!boxes.length) continue;
      const fit = contain(video.videoWidth, video.videoHeight, { x: 0, y: 0, w: tw, h: th });
      for (const box of boxes) paintBox(ctx, video, video.videoWidth, video.videoHeight, fit, box, R.action);
      tintLike(ctx, fit, boxes, cam);
    }
  }
  // wb.js "blend" mode tints with a multiply layer that sits under this canvas: tint the patches the same way
  // (multiply by g / max(g), then color-dodge = × max(g): the same two layers wb.js puts over the video)
  function tintLike(ctx, fit, boxes, cam) {
    try {
      const A = T.wb && T.wb.applied;
      if (!A || A.mode !== "blend" || !boxes.length) return;
      const g = (T.wb.gainsFor && T.wb.gainsFor(cam)) || A.gains, mx = Math.max(g[0], g[1], g[2]);
      const rect = (b) => ctx.fillRect(fit.x + b.x * fit.w, fit.y + b.y * fit.h, Math.max(2, b.w * fit.w), Math.max(2, b.h * fit.h));
      ctx.save(); ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = "rgb(" + g.map((x) => Math.round((255 * x) / mx)).join(",") + ")";
      for (const b of boxes) rect(b);
      if (mx > 1.001) { const c = Math.round(Math.max(0, 1 - 1 / mx) * 255); ctx.globalCompositeOperation = "color-dodge"; ctx.fillStyle = "rgb(" + c + "," + c + "," + c + ")"; for (const b of boxes) rect(b); }
      ctx.restore();
    } catch (e) { console.warn("redact tint", e); }
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

  R.loadText = () => textSession();
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

  // Contrast stretch (2nd–98th percentile of luminance) on RGBA pixels, in place. Night frames and low-contrast signs
  // otherwise reach the models as a few grey levels. Done by hand: the canvas `filter` used before is a no-op in Safari.
  function stretch(px, strong) {
    const hist = new Uint32Array(256); let n = 0;
    for (let i = 0; i < px.length; i += 16) { hist[(px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8]++; n++; }
    let lo = 0, hi = 255, acc = 0;
    const cut = n * (strong ? 0.02 : 0.01);
    for (; lo < 255 && acc + hist[lo] <= cut; lo++) acc += hist[lo];
    acc = 0; for (; hi > lo && acc + hist[hi] <= cut; hi--) acc += hist[hi];
    const span = hi - lo;
    if (span >= (strong ? 235 : 200) || span < 6) return false;
    const k = 255 / span;
    for (let i = 0; i < px.length; i += 4) {
      px[i] = Math.max(0, Math.min(255, (px[i] - lo) * k)); px[i + 1] = Math.max(0, Math.min(255, (px[i + 1] - lo) * k)); px[i + 2] = Math.max(0, Math.min(255, (px[i + 2] - lo) * k));
    }
    return true;
  }
  R.stretch = stretch;
  /** Local contrast (night): every pixel against the mean / spread of its ~48 px neighbourhood, so dim text next to a
   *  bright streetlight or sky still stands out. Block statistics, bilinear between blocks; ~10 ms for a 960 px frame. */
  function localContrast(px, w, h) {
    const B = 48, gw = Math.ceil(w / B), gh = Math.ceil(h / B), mean = new Float32Array(gw * gh), sd = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      let s1 = 0, s2 = 0, n = 0;
      for (let y = gy * B; y < Math.min(h, gy * B + B); y += 2) for (let x = gx * B; x < Math.min(w, gx * B + B); x += 2) { const i = (y * w + x) * 4, l = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8; s1 += l; s2 += l * l; n++; }
      const m = s1 / n; mean[gy * gw + gx] = m; sd[gy * gw + gx] = Math.sqrt(Math.max(0, s2 / n - m * m));
    }
    const at = (a, fx, fy) => { const x0 = Math.max(0, Math.min(gw - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(gh - 1, Math.floor(fy))), x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1), u = Math.max(0, Math.min(1, fx - x0)), v = Math.max(0, Math.min(1, fy - y0));
      return (a[y0 * gw + x0] * (1 - u) + a[y0 * gw + x1] * u) * (1 - v) + (a[y1 * gw + x0] * (1 - u) + a[y1 * gw + x1] * u) * v; };
    for (let y = 0; y < h; y++) { const fy = y / B - 0.5; for (let x = 0; x < w; x++) {
      const fx = x / B - 0.5, m = at(mean, fx, fy), k = 52 / (at(sd, fx, fy) + 6), i = (y * w + x) * 4;
      px[i] = Math.max(0, Math.min(255, 128 + (px[i] - m) * k)); px[i + 1] = Math.max(0, Math.min(255, 128 + (px[i + 1] - m) * k)); px[i + 2] = Math.max(0, Math.min(255, 128 + (px[i + 2] - m) * k));
    } }
  }
  R.isDark = (canvas) => { try { const c = document.createElement("canvas"); c.width = 32; c.height = 24; const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(canvas, 0, 0, 32, 24); const d = x.getImageData(0, 0, 32, 24).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; return s / (d.length / 4) < 80; } catch (_) { return false; } };
  // Dark frame (night): lift the shadows (gamma 0.5) so dim text on a dark background reaches the detector.
  let LIFT = null;
  function lift(px) {
    let sum = 0, n = 0;
    for (let i = 0; i < px.length; i += 64) { sum += px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29; n++; }
    if (!n || sum / n / 256 > 80) return false;
    if (!LIFT) { LIFT = new Uint8ClampedArray(256); for (let v = 0; v < 256; v++) LIFT[v] = Math.round(255 * Math.pow(v / 255, 0.5)); }
    for (let i = 0; i < px.length; i += 4) { px[i] = LIFT[px[i]]; px[i + 1] = LIFT[px[i + 1]]; px[i + 2] = LIFT[px[i + 2]]; }
    return true;
  }

  /** Text regions in a canvas (or a part of it: opt.rect in 0..1), as boxes in 0..1 of the whole canvas.
   *  opt.limit: longest side given to the detector (default 960); opt.minCount: smallest blob (detector pixels). */
  async function regionBoxes(canvas, session, opt) {
    opt = opt || {};
    const r = opt.rect || { x: 0, y: 0, w: 1, h: 1 };
    const sx = r.x * canvas.width, sy = r.y * canvas.height, sw = r.w * canvas.width, sh = r.h * canvas.height;
    const limit = opt.limit || 960;
    const ratio = Math.min(opt.maxScale || 1, limit / Math.max(sw, sh));
    const rw = Math.max(32, Math.round(sw * ratio / 32) * 32), rh = Math.max(32, Math.round(sh * ratio / 32) * 32);
    const work = R.work || (R.work = document.createElement("canvas"));
    work.width = rw;
    work.height = rh;
    const wctx = work.getContext("2d", { willReadFrequently: true });
    wctx.imageSmoothingEnabled = true;
    wctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, rw, rh);
    const px = wctx.getImageData(0, 0, rw, rh).data;
    if (opt.enhance === "local") localContrast(px, rw, rh);
    else if (opt.enhance !== false) { lift(px); stretch(px, false); }
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
    if (R.debugMap) R.debugMap.push({ map: Array.from(map, (v) => Math.round(v * 255)), ow, oh });
    const thr = opt.thresh || 0.3;
    // Text cores at 0.3 (PP-OCR's own threshold). A blob that is mostly empty (a sign touching palm fronds or a hedge, whose
    // texture also scores a little) is split again at 0.5 and 0.7 inside its box, so the sign gets its own tight box.
    const blobs = (t, x0, y0, x1, y1) => {
      const bw = x1 - x0, bh = y1 - y0, mask = new Uint8Array(bw * bh);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (map[(y + y0) * ow + x + x0] > t) mask[y * bw + x] = 1;
      return components(mask, bw, bh, opt.minCount).map((b) => ({ minx: b.minx + x0, maxx: b.maxx + x0, miny: b.miny + y0, maxy: b.maxy + y0, count: b.count }));
    };
    const fill = (b) => b.count / ((b.maxx - b.minx + 1) * (b.maxy - b.miny + 1));
    const meanProb = (b) => { let s = 0, n = 0; for (let y = b.miny; y <= b.maxy; y++) for (let x = b.minx; x <= b.maxx; x++) { const v = map[y * ow + x]; if (v > thr) { s += v; n++; } } return n ? s / n : 0; };
    let found = [];
    const split = (b, level) => {
      const ts = [thr, 0.5, 0.7];
      if (level < 2 && fill(b) < 0.45 && (b.maxy - b.miny) > 6) {
        const parts = blobs(ts[level + 1], b.minx, b.miny, b.maxx + 1, b.maxy + 1);
        if (parts.length) { for (const q of parts) split(q, level + 1); return; }
      }
      found.push(b);
    };
    for (const b of blobs(thr, 0, 0, ow, oh)) split(b, 0);
    found = found.filter((b) => meanProb(b) >= 0.5);
    return found.map((b) => {
      // the detector marks a shrunk core of each text line: grow it back (PP-OCR "unclip", about 0.7 × the core height)
      const bh = b.maxy - b.miny + 1, padX = bh * 0.7 + (b.maxx - b.minx + 1) * 0.03, padY = bh * 0.55;
      const x0 = Math.max(0, (b.minx - padX) / ow), y0 = Math.max(0, (b.miny - padY) / oh);
      const x1 = Math.min(1, (b.maxx + 1 + padX) / ow), y1 = Math.min(1, (b.maxy + 1 + padY) / oh);
      const box = { x: r.x + x0 * r.w, y: r.y + y0 * r.h, w: (x1 - x0) * r.w, h: (y1 - y0) * r.h };
      return { box, area: box.w * box.h };
    }).filter((row) => row.box.w >= 0.006 && row.box.h >= 0.006 && row.box.w <= 0.99 && row.box.h <= 0.5).sort((a, b) => b.area - a.area);
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
    ctx.imageSmoothingEnabled = true; try { ctx.imageSmoothingQuality = "high"; } catch (_) {}
    ctx.drawImage(canvas, x, y, w, h, 0, 0, rw, rh);
    const px = ctx.getImageData(0, 0, rw, rh).data;
    if (boost !== false) stretch(px, !!boost);   // every browser the same (the old ctx.filter boost did nothing in Safari)
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

  /** Every text line in a frame: [{box, text, conf}] (box 0..1). The whole frame goes to the detector at ≤ 960 px; with
   *  opt.tiles (desktop) four overlapping quarters are also searched at up to 1.4× so small and far text (house numbers,
   *  street signs) is found; lines found twice are merged. Each line is read from the full-resolution frame. */
  R.ocrFrame = async (canvas, opt) => {
    opt = opt || {};
    const session = await textSession();
    let rows = (await regionBoxes(canvas, session, { minCount: 14, limit: opt.detLimit || 960 })).map((r) => r.box);
    if (opt.night !== false && (opt.night || R.isDark(canvas))) {   // night: a second look with local contrast
      try { rows = rows.concat((await regionBoxes(canvas, session, { minCount: 14, limit: opt.detLimit || 960, enhance: "local" })).map((r) => r.box)); }
      catch (err) { console.warn("night text pass skipped", err); }
    }
    if (opt.tiles) {
      const ov = 0.14;
      for (const [x, y] of [[0, 0], [0.5 - ov / 2, 0], [0, 0.5 - ov / 2], [0.5 - ov / 2, 0.5 - ov / 2]]) {
        try { rows = rows.concat((await regionBoxes(canvas, session, { rect: { x, y, w: 0.5 + ov / 2, h: 0.5 + ov / 2 }, maxScale: 1.4, minCount: 14 })).map((r) => r.box)); }
        catch (err) { console.warn("text tile skipped", err); }
      }
    }
    // merge duplicates (same line seen by the full frame and a tile, or two tiles)
    const merged = [];
    rows.sort((a, b) => b.w * b.h - a.w * a.h);
    for (const b of rows) {
      // same line twice = similar height and mostly overlapping; a small sign inside a big blob is NOT merged into it
      const m = merged.find((k) => overlaps(k, b) && Math.max(k.h / b.h, b.h / k.h) < 1.5);
      if (!m) { merged.push({ ...b }); continue; }
      const x0 = Math.min(m.x, b.x), y0 = Math.min(m.y, b.y), x1 = Math.max(m.x + m.w, b.x + b.w), y1 = Math.max(m.y + m.h, b.y + b.h);
      m.x = x0; m.y = y0; m.w = x1 - x0; m.h = y1 - y0;
    }
    const out = [];
    const cap = opt.maxLines || 48;
    for (const box of merged.slice(0, cap)) {
      let text = "", conf = 0;
      try {
        text = await recognize(canvas, box); conf = R.lastScore || 0;
        if (conf < 0.75) {   // dim / low-contrast: a stronger stretch, keep the better reading
          const t2 = await recognize(canvas, box, true), c2 = R.lastScore || 0;
          if (c2 > conf) { text = t2; conf = c2; }
        }
      } catch (err) { R.ocrErrors = (R.ocrErrors || 0) + 1; R.lastOcrError = err; console.warn("text read failed", err); }
      out.push({ box, text: text.replace(/\s+/g, " ").trim(), conf: Math.round(conf * 100) / 100 });
    }
    return out;
  };

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
    // 0.5 s apart, wider when the event × cameras would exceed the budget. (It used to stop after 240 samples: with six
    // cameras that was the first 20 s of the event, and nothing after that was ever blurred.)
    const mob = T.detect && T.detect.isMobile && T.detect.isMobile();
    const budget = mob ? 240 : 720;
    const step = Math.min(4, Math.max(0.5, Math.ceil((ev.duration * cams.length / budget) * 4) / 4));
    const out = [];
    for (let t = Math.min(0.2, ev.duration / 2); t < ev.duration - 0.05; t += step) {
      const clip = ev.clips[T.player.clipIndexAt(t)];
      for (const cam of cams) {
        const it = clip && clip.files[cam];
        if (!it || !it.blob) continue;
        out.push({ t, cam, it, local: Math.max(0, t - clip.start) });
      }
    }
    out.step = step;
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
    const ub = $("usRedactShow");   // search panel copy of "Show blur"
    if (ub) { ub.hidden = !on; ub.setAttribute("aria-pressed", String(blurOn())); }
  }

  R.clear = () => {
    R.active = false;
    R.frames = {};
    R.tracks = {};
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
    const has = (k) => parsed.targets.indexOf(k) >= 0;
    const TS = T.textSearch;
    const wantText = has("text") || has("sign") || has("phrase");
    const textOff = wantText && TS && !TS.on();
    if (textOff && !has("plate") && !has("face")) {
      status("Text redaction is turned off (Settings ▸ Search ▸ Show text search & redaction). Plate and face blur still work.");
      return;
    }
    const useIndex = wantText && !textOff && !!(TS && T.textMatch);
    const cams = (CAMS[$("redactCam").value] || CAMS.front).filter((c) => ev.clips.some((clip) => clip.files[c] && clip.files[c].blob));
    if (!cams.length) { T.toast("No playable camera yet. Unlock encrypted clips first.", "err"); return; }
    if (R.running) return;
    R.running = true;
    R.stop = false;
    if ($("redactShow")) $("redactShow").checked = true;   // a new Blur text / plates / faces run is shown (Show blur back on)
    R.action = parsed.action;
    R.frames = {};
    R.tracks = {};
    R.eventId = ev.id;
    R.ocrErrors = 0;
    syncButtons();
    // plates / faces (and text when the text index isn't available) are looked for frame by frame here
    const frameTargets = parsed.targets.filter((k) => k === "plate" || k === "face" || (!useIndex && !textOff && (k === "text" || k === "sign" || k === "phrase")));
    const list = frameTargets.length ? samples(ev, cams) : [];
    const video = R.video || (R.video = document.createElement("video"));
    video.muted = true; video.playsInline = true;
    const canvas = R.canvas || (R.canvas = document.createElement("canvas"));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let hits = 0, skipped = 0, textCams = 0;
    const add = (cam, t, boxes) => { const a = R.frames[cam] || (R.frames[cam] = []); const f = a.find((x) => Math.abs(x.t - t) < 0.01); if (f) f.boxes.push(...boxes); else a.push({ t, boxes: boxes.slice() }); hits += boxes.length; };
    try {
      status("Loading the text finder into this window. The first time downloads it (about 15 MB). Nothing to install. The video stays on this computer.");
      if (useIndex) {
        // every camera: text to hide can be anywhere around the car, whatever the camera menu says
        const all = TS.camsWithVideo(ev); textCams = all.length;
        const X = await TS.scan(ev, all, { status, stopped: () => R.stop });
        R.step = X.step;
        skipped += X.errors || 0;
        const per = TS.redactSamples(ev, { phrases: parsed.phrases, all: has("text"), sign: has("sign") });
        for (const cam of Object.keys(per)) for (const f of per[cam]) add(cam, f.t, f.boxes);
        if (hits) { R.active = true; rebuild(); paintLive(); syncButtons(); }
      }
      if (list.length) {
        if (has("plate") || frameTargets.indexOf("text") >= 0 || frameTargets.indexOf("phrase") >= 0) await textSession();
        if (has("face")) await faceDetector();
        R.step = Math.min(R.step || 9, list.step || 0.5);
        for (let i = 0; i < list.length; i++) {
          if (R.stop) break;
          const sample = list[i];
          status("Looking at " + (i + 1) + " of " + list.length + " · " + T.CAM_LABEL[sample.cam] + " · " + T.fmtTime(sample.t, true));
          let shot;
          try { shot = await grab(video, canvas, ctx, sample.it, sample.local); }
          catch (err) { console.warn(err); skipped++; continue; }
          const boxes = [];
          const tt = frameTargets.filter((k) => k !== "face");
          if (tt.length) {
            try { boxes.push.apply(boxes, await readText(canvas, tt, parsed.phrases)); }
            catch (err) { console.warn(err); skipped++; R.lastError = err; }
          }
          if (has("face")) {
            try { boxes.push.apply(boxes, await readFaces(canvas)); }
            catch (err) { console.warn(err); skipped++; R.lastError = err; }
          }
          add(sample.cam, sample.t, boxes);
          if (boxes.length) { R.active = true; rebuild(); paintLive(); syncButtons(); }
        }
      }
      R.active = hits > 0;
      rebuild();
      paintLive();
      const what = parsed.phrases && parsed.phrases.length ? "“" + parsed.phrases.join(", ") + "”" : "“" + q + "”";
      const note = (skipped ? " " + skipped + " frame" + (skipped === 1 ? "" : "s") + " couldn't be read" + (R.lastError ? " (" + (R.lastError.message || R.lastError) + ")" : "") + "." : "") + (textOff ? " Text redaction is off in Settings, so only plates / faces were looked for." : "");
      const where = textCams ? " on all " + textCams + " camera" + (textCams === 1 ? "" : "s") : "";
      if (R.stop) status("Stopped." + (hits ? " " + hits + " spots blurred so far." : "") + note);
      else if (!hits) status((parsed.phrases && parsed.phrases.length ? "Didn't read " + what + where + ". Other words were left alone. Try the spelling as it appears, or one distinctive word." : "Nothing matched " + what + where + ". Try another camera, or a clearer moment in the clip.") + note);
      else status((parsed.action === "remove" ? "Removed" : "Blurred") + " " + hits + " spot" + (hits === 1 ? "" : "s") + (parsed.phrases && parsed.phrases.length ? " matching " + what + where + ". Other text stays visible." : " for " + what + where + ".") + " The blur follows the text between the frames that were read. Playback and export both use this. Clear removes the effect. The original file is unchanged." + note);
    } catch (err) {
      console.error(err);
      R.active = hits > 0;
      rebuild(); paintLive();
      if (String(err && err.message) === "stopped") status("Stopped." + (hits ? " " + hits + " spots blurred so far." : ""));
      else {
        status("Could not start: " + (err && err.message ? err.message : err));
        T.toast("Redaction could not start. See the note under the box.", "err", 7000);
      }
    } finally {
      R.running = false;
      R.stop = false;
      syncButtons();
    }
  };
  R.clearText = () => { if (R.active) R.clear(); };
  R.paint = () => { try { paintLive(); } catch (e) { console.warn("redact paint", e); } };
  /** "Show blur" for Blur text / plates / faces results (classic bar tick, search panel button). */
  R.shown = () => blurOn();
  R.setShown = (on) => { const b = $("redactShow"); if (b) b.checked = !!on; paintLive(); syncButtons(); if (T.emit) T.emit("redact-shown", !!on); };

  R.init = () => {
    ensureLayers();
    $("btnRedact").addEventListener("click", () => R.run());
    $("redactQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") R.run(); });
    $("btnRedactStop").addEventListener("click", () => { R.stop = true; status("Stopping…"); });
    $("btnRedactClear").addEventListener("click", () => R.clear());
    if ($("redactShow")) $("redactShow").addEventListener("change", () => { paintLive(); syncButtons(); });
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
