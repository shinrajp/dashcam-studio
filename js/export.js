/* export.js — frame-by-frame export with WebCodecs (decode each camera → composite → encode → mux).
 * Presets: "compat" = H.264 MP4 1920×1080 @30 fps; "original" = stitched 3×2 at native tile size, codec of choice.
 * Hardware encoders are tried first, then software; if a size is refused we step DOWN (never up).
 * Browsers without VideoEncoder fall back to real-time MediaRecorder capture. */
(function () {
  "use strict";
  const T = window.TDC;
  const X = (T.exporter = { running: false, cancelled: false });
  const TOL_US = 500;

  X.CODECS = {
    h264: { label: "H.264", ext: "mp4", mux: "avc" },
    hevc: { label: "HEVC (H.265)", ext: "mp4", mux: "hevc" },
    av1: { label: "AV1", ext: "mp4", mux: "av1" },
    vp9: { label: "VP9", ext: "webm", mux: "V_VP9" },
  };
  X.webcodecs = () => typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined" && typeof VideoFrame !== "undefined" && typeof Mp4Muxer !== "undefined";
  /** How this browser can export: "webcodecs" (fast, frame-exact), "realtime" (MediaRecorder capture while playing), or "none". */
  X.capability = () => {
    if (X.webcodecs()) return { mode: "webcodecs" };
    const c = document.createElement("canvas");
    if (window.MediaRecorder && typeof c.captureStream === "function") return { mode: "realtime" };
    return { mode: "none", reason: "This browser has neither WebCodecs (VideoEncoder) nor MediaRecorder canvas capture, so it can't make a video file. Playback, sections and screenshots still work — export on a computer with Chrome, Edge or Safari 16.4+." };
  };
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");

  /** Size options for the "original" preset (never larger than the source). */
  X.sizeOptions = (ev, shape) => {   // shape: { cols, rows } of the camera grid (export-cams); default 3 × 2 = all six cameras
    const t = ev.tile, cols = (shape && shape.cols) || 3, rows = (shape && shape.rows) || 2;
    const out = [];
    out.push({ id: "native", W: even(t.w * cols), H: even(t.h * rows), label: `Native ${even(t.w * cols)}×${even(t.h * rows)} (1:1 side cameras)` });
    if (t.maxW * t.maxH > t.w * t.h) out.push({ id: "max", W: even(t.maxW * cols), H: even(t.maxH * rows), label: `Largest ${even(t.maxW * cols)}×${even(t.maxH * rows)} (1:1 front camera)` });
    for (const f of [0.75, 0.5]) out.push({ id: "p" + f * 100, W: even(t.w * cols * f), H: even(t.h * rows * f), label: `${Math.round(f * 100)}% ${even(t.w * cols * f)}×${even(t.h * rows * f)}` });
    return out;
  };
  // ── export-cams: which cameras go into the file ──
  /** The ticked cameras as a list in T.GRID order; anything missing / unknown / empty means all six (the default). */
  X.normCams = (cams) => {
    if (!Array.isArray(cams)) return T.GRID.slice();
    const out = T.GRID.filter((c) => cams.includes(c));
    return out.length ? out : T.GRID.slice();
  };
  X.camsTag = (cams) => { const c = X.normCams(cams); return c.length === 6 ? "" : c.length === 1 ? c[0].replace(/_/g, "-") : c.length + "cams"; };   // file name part: "front", "3cams"; nothing for all six
  /** Grid shape the export will use for these cameras (opts.cams). */
  X.shapeFor = (opts, ev) => T.compositor.shape(X.normCams(opts && opts.cams).length, ev.tile);

  function codecStrings(key, w, h, fps) {
    const ps = w * h, rate = ps * fps, fs = Math.ceil(w / 16) * Math.ceil(h / 16), mbps = fs * fps;
    const pick = (levels, fits) => { const ok = levels.filter(fits); return ok.concat(levels.filter((l) => !ok.includes(l)).slice(-2)); };
    if (key === "h264") return pick([[0x28, 8192, 245760], [0x2A, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600], [0x3C, 139264, 4177920], [0x3D, 139264, 8355840], [0x3E, 139264, 16711680]], (l) => l[1] >= fs && l[2] >= mbps).map((l) => "avc1.6400" + hex2(l[0]));
    if (key === "hevc") return pick([[120, 2228224, 66846720], [123, 2228224, 133693440], [150, 8912896, 267386880], [153, 8912896, 534773760], [156, 8912896, 1069547520], [180, 35651584, 1069547520], [183, 35651584, 2139095040]], (l) => l[1] >= ps && l[2] >= rate).map((l) => `hvc1.1.6.L${l[0]}.B0`);
    if (key === "av1") return pick([[8, 2228224, 133693440], [9, 2228224, 267386880], [12, 8912896, 267386880], [13, 8912896, 534773760], [16, 35651584, 1069547520], [17, 35651584, 2139095040]], (l) => l[1] >= ps && l[2] >= rate).map((l) => `av01.0.${String(l[0]).padStart(2, "0")}M.08`);
    if (key === "vp9") return pick([[40, 2228224, 83558400], [41, 2228224, 160432128], [50, 8912896, 311951360], [51, 8912896, 588251136], [60, 35651584, 1176502272], [61, 35651584, 2353004544]], (l) => l[1] >= ps && l[2] >= rate).map((l) => `vp09.00.${l[0]}.08`);
    return [];
  }
  const bitrate = (w, h, fps, key) => Math.round(T.clamp(w * h * fps * (key === "h264" ? 0.11 : 0.07), 2e6, 80e6));

  async function encoderConfig(key, w, h, fps) {
    for (const hardwareAcceleration of ["prefer-hardware", "no-preference"]) {
      for (const codec of codecStrings(key, w, h, fps)) {
        const cfg = { codec, width: w, height: h, bitrate: bitrate(w, h, fps, key), framerate: fps, hardwareAcceleration, latencyMode: "quality", bitrateMode: "variable" };
        if (key === "h264") cfg.avc = { format: "avc" };
        if (key === "hevc") cfg.hevc = { format: "hevc" };
        try {
          const r = await VideoEncoder.isConfigSupported(cfg);
          if (r && r.supported) return { ...cfg, ...(r.config || {}), hardwareAcceleration, codec };
        } catch (_) {}
      }
    }
    return null;
  }
  /** Which codecs can encode w×h here (for the codec picker). */
  X.supportedCodecs = async (w, h, fps) => {
    const out = {};
    if (!X.webcodecs()) return out;
    for (const k of Object.keys(X.CODECS)) out[k] = !!(await encoderConfig(k, w, h, fps || 30));
    return out;
  };

  // ── decoding sources ──
  class DecodeSource {
    constructor(item) {
      this.item = item; this.tr = item.info; this.queue = []; this.feed = 0; this.ended = false; this.err = null;
      this.waiters = []; this.lastT = -Infinity; this.buf = null;
      const k = []; for (let i = 0; i < this.tr.n; i++) if (this.tr.isKey[i]) k.push(i);
      this.keys = k.length ? k : [0];
    }
    async init() {
      const base = { codec: this.tr.codec, codedWidth: this.tr.width, codedHeight: this.tr.height, description: this.tr.description, optimizeForLatency: false };
      for (const hardwareAcceleration of ["prefer-hardware", "no-preference"]) {
        try { const r = await VideoDecoder.isConfigSupported({ ...base, hardwareAcceleration }); if (r && r.supported) { this.config = { ...base, hardwareAcceleration }; this.hw = hardwareAcceleration === "prefer-hardware"; break; } } catch (_) {}
      }
      if (!this.config) throw new Error("decoder can't handle " + this.tr.codec);
      this.make();
    }
    make() {
      this.decoder = new VideoDecoder({
        output: (f) => { let i = this.queue.length; while (i > 0 && this.queue[i - 1].timestamp > f.timestamp) i--; this.queue.splice(i, 0, f); this.wake(); },
        error: (e) => { this.err = e; this.wake(); },
      });
      this.decoder.ondequeue = () => this.wake();
      this.decoder.configure(this.config);
    }
    wake() { const w = this.waiters; this.waiters = []; w.forEach((r) => r()); }
    wait() { return new Promise((r) => { this.waiters.push(r); setTimeout(r, 15); }); } // timer: Safari has no 'dequeue' event
    clear() { this.queue.forEach((f) => { try { f.close(); } catch (_) {} }); this.queue = []; }
    keyFor(tUs) { let b = this.keys[0]; for (const k of this.keys) { if (this.tr.pts[k] <= tUs) b = k; else break; } return b; }
    restart(tUs) {
      this.clear(); this.err = null;
      if (this.decoder.state === "closed") this.make(); else { this.decoder.reset(); this.decoder.configure(this.config); }
      this.feed = this.keyFor(tUs); this.ended = false; this.flushing = null;
    }
    async sample(i) {
      const off = this.tr.offsets[i], size = this.tr.sizes[i];
      if (!this.buf || off < this.buf.start || off + size > this.buf.start + this.buf.u8.length) {
        const blob = this.item.blob;
        this.buf = { start: off, u8: new Uint8Array(await blob.slice(off, Math.min(blob.size, off + Math.max(size, 4 << 20))).arrayBuffer()) };
      }
      return this.buf.u8.subarray(off - this.buf.start, off - this.buf.start + size);
    }
    async frameAt(t) {
      const tUs = Math.round(t * 1e6) + TOL_US;
      if (tUs < this.lastT || this.keyFor(tUs) > this.feed) this.restart(tUs);
      this.lastT = tUs;
      for (;;) {
        if (this.err) throw this.err;
        if (X.cancelled) throw new Error("cancelled");
        const q = this.queue;
        if ((q.length && q[q.length - 1].timestamp > tUs) || this.ended) break;
        if (this.feed < this.tr.n) {
          if (this.decoder.decodeQueueSize >= 6) { await this.wait(); continue; }
          const i = this.feed++;
          const data = await this.sample(i);
          this.decoder.decode(new EncodedVideoChunk({ type: this.tr.isKey[i] ? "key" : "delta", timestamp: this.tr.pts[i], duration: this.tr.frameUs, data }));
          if (this.decoder.decodeQueueSize >= 3) await this.wait();
        } else {
          if (!this.flushing) this.flushing = this.decoder.flush().catch((e) => { this.err = this.err || e; });
          await this.flushing;
          this.ended = true;
        }
      }
      const q = this.queue;
      let idx = -1;
      for (let i = 0; i < q.length; i++) if (q[i].timestamp <= tUs) idx = i;
      if (idx > 0) { q.splice(0, idx).forEach((f) => f.close()); idx = 0; }
      const f = idx === 0 ? q[0] : q[0] || null;
      return f ? { img: f, w: f.displayWidth, h: f.displayHeight } : null;
    }
    close() { this.clear(); try { if (this.decoder && this.decoder.state !== "closed") this.decoder.close(); } catch (_) {} this.buf = null; }
  }

  /** Fallback: seek a hidden <video> to each frame time. */
  class SeekSource {
    constructor(item) { this.item = item; }
    async init() {
      const v = (this.v = document.createElement("video"));
      v.muted = true; v.playsInline = true; v.preload = "auto";
      v.src = this.item.url || (this.item.url = URL.createObjectURL(this.item.blob));
      await new Promise((r) => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 5000); });
    }
    frameAt(t) {
      const v = this.v;
      if (!v.videoWidth) return Promise.resolve(null);
      return new Promise((resolve) => {
        let done = false;
        const fin = () => { if (done) return; done = true; v.removeEventListener("seeked", fin); resolve({ img: v, w: v.videoWidth, h: v.videoHeight }); };
        const target = Math.min(t + TOL_US / 1e6, (v.duration || t + 1) - 0.001);
        if (Math.abs(v.currentTime - target) < 1e-4) return fin();
        v.addEventListener("seeked", fin);
        v.currentTime = Math.max(0, target);
        setTimeout(fin, 3000);
      });
    }
    close() { if (this.v) { this.v.removeAttribute("src"); try { this.v.load(); } catch (_) {} } }
  }

  /** Per-clip source manager. */
  class Sources {
    constructor(ev, cams) { this.ev = ev; this.cams = cams || null; this.ci = -1; this.src = {}; this.notes = { hw: 0, sw: 0, seek: 0 }; }   // cams: only these cameras are decoded (export-cams); null = all six
    async frames(t) {
      const ci = T.player.clipIndexAt(t);
      if (ci !== this.ci) await this.open(ci);
      const local = t - this.ev.clips[ci].start;
      const out = {};
      await Promise.all(Object.entries(this.src).map(async ([cam, s]) => {
        try { out[cam] = await s.frameAt(Math.min(local, (s.item.info ? s.item.info.duration : Infinity) - 0.001)); }
        catch (e) {
          if (X.cancelled) throw e;
          console.warn("decoder failed, switching to <video> seeking", cam, e);
          try { s.close(); } catch (_) {}
          const f = new SeekSource(s.item); await f.init(); this.src[cam] = f; this.notes.seek++;
          out[cam] = await f.frameAt(local);
        }
      }));
      return out;
    }
    async open(ci) {
      this.close();
      this.ci = ci;
      const clip = this.ev.clips[ci];
      for (const cam of T.GRID) {
        if (this.cams && !this.cams.includes(cam)) continue;   // export-cams: an unticked camera is never decoded
        const it = clip.files[cam];
        if (!it || !it.blob) continue;
        let s = null;
        if (it.info && typeof VideoDecoder !== "undefined") {
          try { s = new DecodeSource(it); await s.init(); this.notes[s.hw ? "hw" : "sw"]++; } catch (e) { console.warn("WebCodecs decode unavailable for", it.name, e); s = null; }
        }
        if (!s) { s = new SeekSource(it); await s.init(); this.notes.seek++; }
        this.src[cam] = s;
      }
    }
    close() { Object.values(this.src).forEach((s) => { try { s.close(); } catch (_) {} }); this.src = {}; }
  }

  function makeMuxer(key, w, h, fps) {
    const c = X.CODECS[key];
    if (c.ext === "mp4") {
      const target = new Mp4Muxer.ArrayBufferTarget();
      const muxer = new Mp4Muxer.Muxer({ target, fastStart: "in-memory", firstTimestampBehavior: "offset", video: { codec: c.mux, width: w, height: h, frameRate: fps } });
      return { muxer, target, type: "video/mp4" };
    }
    const target = new WebMMuxer.ArrayBufferTarget();
    const muxer = new WebMMuxer.Muxer({ target, firstTimestampBehavior: "offset", video: { codec: c.mux, width: w, height: h, frameRate: fps } });
    return { muxer, target, type: "video/webm" };
  }

  /**
   * Output frame k → source time. Ranges are joined back to back: output time runs continuously while the
   * source time jumps at each cut, so overlays (clock, telemetry, blinker phase, map, FSD badge) show the
   * SOURCE moment of every frame. total = round(sum of range lengths × fps).
   */
  function frameMap(ranges, fps) {
    const cum = [0];
    for (const r of ranges) cum.push(cum[cum.length - 1] + (r[1] - r[0]));
    const total = Math.max(1, Math.round(cum[cum.length - 1] * fps));
    let i = 0;
    return {
      total,
      at(k) { // k increases monotonically
        const tau = k / fps;
        while (i < ranges.length - 1 && tau >= cum[i + 1] - 1e-9) i++;
        return { t: Math.min(ranges[i][0] + (tau - cum[i]), ranges[i][1] - 1e-4), seg: i };
      },
    };
  }
  X.frameMap = frameMap;

  // ── export-panel: layout options, candidate sizes, hardware-aware strip cap ──────────────────────────────
  /** Layout options shared by the dialog's size read-out and the run. opts: { extras:{mode}, order:"viewer"|"standard", show }. */
  X.layoutBase = (opts) => {
    const C = T.compositor, show = opts.show || {}, ex = opts.extras || {};
    const mode = C.EXTRA_MODES.includes(ex.mode) ? ex.mode : "overlay";
    const co = C.cameraOrder(opts.order === "viewer" ? "viewer" : "standard"), cams = X.normCams(opts.cams);
    return { mode, want: { hud: !!show.hud, map: !!show.map, car: !!show.carview }, time: !!show.time, order: cams.length === 6 ? co.order : co.order.filter((c) => cams.includes(c)), mirror: cams.length === 6 ? co.mirror : co.mirror.filter((c) => cams.includes(c)) };
  };
  /** Candidate outputs, best first: the layout the user asked for at its full size, a thinner strip, 75%, 50%, then a plain 1920×1080. */
  X.candidates = (opts, ev) => {
    const C = T.compositor, base = X.layoutBase(opts), compat = opts.preset !== "original", out = [], seen = new Set();
    const add = (W, H, exact, frac, mode, tag) => {
      const lay = C.layout({ ...base, mode, W, H, tile: ev.tile, exact, frac });
      const id = lay.W + "x" + lay.H + (lay.mode === base.mode ? "" : ":" + lay.mode) + ":" + lay.panels.length;
      if (seen.has(id)) return; seen.add(id);
      out.push({ W: lay.W, H: lay.H, exact: !!exact, geo: lay, tag });
    };
    if (compat) {
      add(1920, 1080, false, null, base.mode, "full");
      if (base.mode === "panel") add(1920, 1080, false, null, "fill", "fill");   // no encoder for the taller picture: back to exactly 1920×1080
      if (base.mode !== "overlay") add(1920, 1080, false, null, "overlay", "plain");
    } else {
      const so = X.sizeOptions(ev, C.shape(base.order.length, ev.tile)), pk = so.find((z) => z.id === opts.sizeId) || so[0];
      add(pk.W, pk.H, true, null, base.mode, "full");
      if (base.mode === "panel") add(pk.W, pk.H, true, 0.14, base.mode, "thin");
      for (const f of [0.75, 0.5]) add(even(pk.W * f), even(pk.H * f), true, null, base.mode, "p" + f * 100);
      add(1920, 1080, false, null, base.mode === "overlay" ? "overlay" : "fill", "compat");
    }
    return out;
  };
  X.codecKeys = (opts) => { const compat = opts.preset !== "original", key = compat ? "h264" : opts.codec || "h264"; return { key, keys: compat ? ["h264", "vp9", "av1"] : [key, ...["h264", "hevc", "vp9", "av1"].filter((k) => k !== key)] }; };
  /** Plan an export: ordered candidates + the first one this browser can encode. A strip that would push the picture past what the
   *  HARDWARE encoder takes (while the plain grid fits) is thinned first; the result says what changed (note) so the dialog can warn. */
  X.plan = async (opts, ev) => {
    const compat = opts.preset !== "original", fps = compat ? 30 : ev.fps || 36, { key, keys } = X.codecKeys(opts);
    let cands = X.candidates(opts, ev);
    const hwOf = async (W, H) => { const c = await encoderConfig(key, W, H, fps); return c ? c.hardwareAcceleration === "prefer-hardware" : null; };
    let note = null;
    if (!X.webcodecs()) return { cands, fps, key, keys, pick: null, note: "This browser records in real time (no WebCodecs encoder).", realtime: true };
    const c0 = cands[0];
    if (c0.geo.mode === "panel" && cands[1] && cands[1].tag === "thin") {
      const hw0 = await hwOf(c0.W, c0.H);
      if (hw0 === false && (await hwOf(c0.geo.gridW, c0.geo.gridH)) === true && (await hwOf(cands[1].W, cands[1].H)) === true) {
        cands = [cands[1], c0, ...cands.slice(2)];
        note = "The full panel strip would not fit this device's hardware encoder, so the strip is thinner (" + cands[0].W + "×" + cands[0].H + ") to keep the export fast.";
      }
    }
    let pick = null;
    outer: for (const c of cands) for (const k of keys) {
      const cfg = await encoderConfig(k, c.W, c.H, fps);
      if (cfg) { pick = { cand: c, k, cfg }; break outer; }
    }
    if (pick && pick.cand !== cands[0] && !note) {
      const a = cands[0], b = pick.cand;
      note = a.W + "×" + a.H + " can't be encoded here — " + (pick.cand.geo.panels.length || a.geo.panels.length ? "using " : "using ") + b.W + "×" + b.H + (b.geo.mode !== a.geo.mode ? " (" + (b.geo.mode === "overlay" ? "panels float on the picture" : b.geo.mode === "fill" ? "panels fill the black area" : "with a panel strip") + ")" : "") + ".";
    } else if (pick && pick.k !== key && !note) note = X.CODECS[key].label + " isn't available at this size — using " + X.CODECS[pick.k].label + ".";
    if (!pick) note = "No encoder in this browser can make " + cands[0].W + "×" + cands[0].H + ".";
    return { cands, fps, key, keys, pick, note };
  };
  /** Pre-load the map tiles the export will draw (overlay map or the panel map) for this candidate. */
  async function prefetchMap(geo, show, ranges, status) {
    const times = []; for (const r of ranges) { for (let t = r[0]; t < r[1]; t += 1) times.push(t); times.push(r[1]); }
    const mp = geo.panels && geo.panels.find((p) => p.k === "map");
    if (mp) { status("Loading map tiles…"); await T.map.prefetch(mp.wu, mp.hu, mp.su, times, 8000); }
    else if (show.map && geo.mode !== "fill" && geo.mode !== "panel") { status("Loading map tiles…"); await T.map.prefetch(T.prefs.panels.map.wu, T.prefs.panels.map.hu, T.compositor.unitScale(geo.grid.h), times, 8000); }
  }

  async function encodeOnce(cand, ev, ranges, fps, show, onProgress) {
    const { W, H } = cand;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d", { alpha: false });
    const geo = cand.geo || T.compositor.geometry(W, H, ev.tile, cand.exact);
    const { muxer, target, type } = makeMuxer(cand.key, W, H, fps);
    let encErr = null;
    const waiters = [];
    const wake = () => waiters.splice(0).forEach((r) => r());
    const encoder = new VideoEncoder({ output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { encErr = encErr || e; } }, error: (e) => { encErr = e; wake(); } });
    encoder.ondequeue = wake;
    const sources = new Sources(ev, cand.equirect || !geo.order || geo.order.length === 6 ? null : T.GRID.filter((c) => geo.order.includes(c)));   // only the ticked cameras are decoded
    const fm = frameMap(ranges, fps), total = fm.total;
    try {
      encoder.configure(cand.cfg);
      const gop = Math.round(fps * 2), fd = 1e6 / fps;
      let lastYield = performance.now(), lastSeg = -1, sinceKey = 0;
      for (let k = 0; k < total; k++) {
        if (X.cancelled) throw new Error("cancelled");
        if (encErr) throw encErr;
        const { t, seg } = fm.at(k); // t = SOURCE time of this output frame
        const frames = await sources.frames(t);
        if (cand.equirect) { T.pano.drawEquirect(ctx, W, H, frames); if (show && show.carview && T.carView && T.carView.drawExport) { try { T.carView.drawExport(ctx, { x: 0, y: 0, w: W, h: H }, t); } catch (e) { console.warn("car view export", e); } } }   // 360 (beta): 2:1 equirectangular
        else T.compositor.drawFrame(ctx, geo, t, frames, show);
        const vf = new VideoFrame(canvas, { timestamp: Math.round(k * fd), duration: Math.round(fd) });
        const key = seg !== lastSeg || sinceKey >= gop; // key frame at every cut (clean seeking) and every 2 s
        lastSeg = seg; sinceKey = key ? 1 : sinceKey + 1;
        encoder.encode(vf, { keyFrame: key });
        vf.close();
        while (encoder.encodeQueueSize > 4 && !encErr && !X.cancelled) await new Promise((r) => { waiters.push(r); setTimeout(r, 15); }); // timer: Safari has no 'dequeue' event
        onProgress(k + 1, total);
        if (performance.now() - lastYield > 40) { await T.yieldNow(); lastYield = performance.now(); }
      }
      await encoder.flush();
      if (encErr) throw encErr;
      encoder.close();
      muxer.finalize();
      return { blob: new Blob([target.buffer], { type }), frames: total, type, notes: sources.notes };
    } catch (e) {
      try { if (encoder.state !== "closed") encoder.close(); } catch (_) {}
      throw e;
    } finally { sources.close(); }
  }

  /** Real-time fallback for browsers without WebCodecs encoding. */
  async function recordRealtime(ev, ranges, W, H, show, onProgress, geo0) {
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const geo = geo0 || T.compositor.geometry(W, H, ev.tile, false);
    const mime = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error("This browser can't record video (no WebCodecs or MediaRecorder).");
    const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: mime, videoBitsPerSecond: 10e6 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const P = T.player;
    const prevRate = P.rate;
    const totalDur = ranges.reduce((a, r) => a + (r[1] - r[0]), 0);
    const draw = () => {
      const frames = {};
      for (const cam of geo.order || T.GRID) { const v = P.tiles[cam].vids[P.active]; if (v._url && v.videoWidth) frames[cam] = { img: v, w: v.videoWidth, h: v.videoHeight }; }
      T.compositor.drawFrame(ctx, geo, P.time, frames, show); // P.time = source time
    };
    P.setRate(1);
    let done = 0;
    try {
      // Each range plays in real time; between ranges the recorder is paused while the player seeks, so the
      // recording's own timestamps stay continuous and the sections are joined in order.
      for (let i = 0; i < ranges.length && !X.cancelled; i++) {
        const range = ranges[i];
        P.seek(range[0]);
        await settle(P);
        draw();
        if (i === 0) rec.start(1000); else rec.resume();
        P.play();
        await new Promise((resolve, reject) => {
          let lastT = -1, lastMove = performance.now(), nudges = 0;
          const loop = () => {
            const t = P.time;
            draw();
            onProgress(done + Math.max(0, t - range[0]), totalDur);
            if (X.cancelled || t >= range[1] - 0.02 || !P.playing) return resolve();
            // Watchdog: a <video> seek can occasionally hang in Chrome; re-issue it instead of waiting forever.
            const now = performance.now();
            if (t !== lastT) { lastT = t; lastMove = now; }
            else if (now - lastMove > 2000) {
              if (++nudges > 3) return reject(new Error("Playback stalled during real-time recording"));
              console.warn("real-time export: playback stalled at", t.toFixed(3), "— re-seeking");
              const ci = P.clipIndexAt(t), local = t - ev.clips[ci].start;
              for (const cam of T.GRID) { const v = P.tiles[cam].vids[P.active]; if (v._url) { try { v.currentTime = Math.max(0, local + 0.001 * nudges); v.play().catch(() => {}); } catch (_) {} } }
              lastMove = now;
            }
            requestAnimationFrame(loop);
          };
          loop();
        });
        P.pause();
        if (i + 1 < ranges.length) rec.pause();
        done += range[1] - range[0];
      }
    } catch (e) {
      try { if (rec.state !== "inactive") rec.stop(); } catch (_) {}
      throw e;
    } finally {
      P.pause(); P.setRate(prevRate);
    }
    if (rec.state !== "inactive") await new Promise((r) => { rec.onstop = r; rec.stop(); });
    if (X.cancelled) throw new Error("cancelled");
    return { blob: new Blob(chunks, { type: mime.split(";")[0] }), type: mime.split(";")[0], frames: null, notes: { realtime: true } };
  }

  /** Wait until the player's visible videos have the seeked frame (re-issues a seek that hangs; gives up after 3 s). */
  async function settle(P) {
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 400)); // as before: give the seek a moment
    let nudged = false;
    while (performance.now() - t0 < 3000) {
      const vs = T.GRID.map((c) => P.tiles[c].vids[P.active]).filter((v) => v._url);
      if (vs.every((v) => v.readyState >= 2 && !v.seeking)) break;
      if (!nudged && performance.now() - t0 > 1500) { nudged = true; vs.forEach((v) => { if (v.seeking || v.readyState < 2) { try { v.currentTime = v.currentTime + 0.001; } catch (_) {} } }); } // re-issue a stuck seek
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  /** Clamp / order export ranges; drops empty ones. Falls back to the whole event. */
  X.normRanges = (ev, ranges) => {
    const out = (ranges || []).map((r) => [T.clamp(+r[0] || 0, 0, ev.duration), T.clamp(+r[1] || 0, 0, ev.duration)])
      .map((r) => [Math.min(r[0], r[1]), Math.max(r[0], r[1])]).filter((r) => r[1] - r[0] > 0.01);
    return out.length ? out : [[0, ev.duration]];
  };

  /**
   * Run an export of the player's current event.
   * opts: { preset: "compat"|"original", codec, sizeId, range: [a, b] | ranges: [[a, b], …] (joined in that order),
   *         show, onProgress(done,total), onStatus(text) }
   */
  X.run = async (opts) => {
    const ev = T.player.ev;
    if (!ev) throw new Error("No event loaded");
    if (X.running) throw new Error("An export is already running");
    X.running = true; X.cancelled = false;
    const wasPlaying = T.player.playing;
    T.player.pause();
    const status = opts.onStatus || (() => {});
    try {
      if (!ev.prepared) await T.library.prepare(ev);
      status("Reading telemetry…");
      await T.telemetry.whenComplete();
      const ranges = X.normRanges(ev, opts.ranges || [opts.range || [0, ev.duration]]);
      const show = opts.show || { ...T.prefs.show };
      // burned-in boxes: make sure every frame's boxes exist before encoding (tracking finished, live detections for these ranges)
      const redacting = !!(T.search && T.search.anyRd && T.search.anyRd() && T.search.needBoxes && T.search.needBoxes());   // redacted matches are always burned in
      if (T.burnBoxes && T.burnBoxes.prepare && (redacting || (show.boxes !== undefined ? show.boxes : T.burnBoxes.enabled()))) await T.burnBoxes.prepare(ranges, status, () => X.cancelled);
      if (show.carview && T.carView && T.carView.prepareExport) { try { await T.carView.prepareExport(ranges, status, () => X.cancelled); } catch (e) { console.warn("car view export prep", e); } }   // ui-v3: where the card sits, people for the moments never played
      if (X.cancelled) throw new Error("cancelled");
      const equi = opts.preset === "equirect";
      if (equi) {   // 360 (beta): equirectangular 2:1 from the pano renderer; needs WebCodecs
        if (!X.webcodecs()) throw new Error("360 export needs WebCodecs (Chrome, Edge, Safari 17+).");
        await T.loadPano();
        const sizes = [{ W: 2048, H: 1024 }, { W: 1920, H: 960 }, { W: 1440, H: 720 }], tried = [];
        for (const sz of sizes) for (const k of ["h264", "vp9", "av1"]) {
          const cfg = await encoderConfig(k, sz.W, sz.H, 30); if (!cfg) { tried.push(k + " " + sz.W + "×" + sz.H + ": not supported"); continue; }
          status("Exporting 360 · " + X.CODECS[k].label + " · " + sz.W + "×" + sz.H);
          try {
            const r = await encodeOnce({ key: k, W: sz.W, H: sz.H, exact: true, cfg, equirect: true }, ev, ranges, 30, show, opts.onProgress || (() => {}));
            return { ...r, name: fileName(ev, "360", sz, k), W: sz.W, H: sz.H, codec: cfg.codec, key: k, fps: 30, label: "360 equirect", note: "360 file has no spherical metadata yet: for YouTube/players to treat it as 360, run Google's Spatial Media Metadata Injector on it." };
          } catch (e) { if (X.cancelled || String(e && e.message) === "cancelled") throw new Error("cancelled"); tried.push(k + ": " + (e.message || e)); }
        }
        throw new Error("No encoder worked for 360: " + tried.join("; "));
      }
      const compat = opts.preset !== "original";
      const fps = compat ? 30 : ev.fps || 36;
      const { key, keys } = X.codecKeys(opts);
      const kind = compat ? "compatible" : "original";
      const camsUsed = X.normCams(opts.cams), nameFor = (sz, k) => fileName(ev, kind, sz, k, camsUsed);
      if (!X.webcodecs()) {
        const c = X.candidates({ ...opts, preset: "compat" }, ev)[0];   // the real-time recorder is always 1920-wide
        await prefetchMap(c.geo, show, ranges, status);
        status("Recording in real time (this browser has no WebCodecs encoder)…");
        const r = await recordRealtime(ev, ranges, c.W, c.H, show, opts.onProgress || (() => {}), c.geo);
        const ext = r.type === "video/mp4" ? "mp4" : "webm";
        return { ...r, name: nameFor(c, key).replace(/\.\w+$/, "." + ext), W: c.W, H: c.H, codec: r.type, note: "real-time capture", layout: c.geo.mode };
      }
      // candidate chain: requested layout/codec/size first, then fall back (never upscale)
      const plan = await X.plan(opts, ev), target = plan.cands[0];
      const tried = [];
      for (const sz of plan.cands) for (const k of keys) {
        if (X.cancelled) throw new Error("cancelled");
        const cfg = await encoderConfig(k, sz.W, sz.H, fps);
        if (!cfg) { tried.push(`${X.CODECS[k].label} ${sz.W}×${sz.H}: not supported`); continue; }
        const label = `${X.CODECS[k].label} · ${cfg.hardwareAcceleration === "prefer-hardware" ? "hardware" : "software"} · ${sz.W}×${sz.H} · ${fps} fps`;
        await prefetchMap(sz.geo, show, ranges, status);
        status("Exporting · " + label);
        try {
          const r = await encodeOnce({ key: k, W: sz.W, H: sz.H, exact: sz.exact, cfg, geo: sz.geo }, ev, ranges, fps, show, opts.onProgress || (() => {}));
          let note = null;
          if (k !== key || sz.W !== target.W || sz.H !== target.H || sz.geo.mode !== target.geo.mode) note = `${X.CODECS[key].label} at ${target.W}×${target.H} wasn't available here — used ${X.CODECS[k].label} at ${sz.W}×${sz.H}` + (tried.length ? ` (tried: ${tried.join("; ")})` : "");
          else if (plan.note) note = plan.note;
          if (sz.geo.note) note = (note ? note + " " : "") + sz.geo.note;
          return { ...r, name: nameFor(sz, k), W: sz.W, H: sz.H, codec: cfg.codec, key: k, hw: cfg.hardwareAcceleration === "prefer-hardware", fps, label, note, layout: sz.geo.mode, grid: sz.geo.grid, panels: sz.geo.panels, cams: sz.geo.order || camsUsed, cols: sz.geo.cols, rows: sz.geo.rows };
        } catch (e) {
          if (X.cancelled || String(e && e.message) === "cancelled") throw new Error("cancelled");
          console.warn("encode attempt failed", k, sz.W + "x" + sz.H, e);
          tried.push(`${label}: ${e.message || e}`);
        }
      }
      throw new Error("No encoder worked: " + tried.join("; "));
    } finally {
      X.running = false;
      if (wasPlaying && !X.cancelled) { /* leave paused after export */ }
    }
  };
  X.cancel = () => { X.cancelled = true; };

  function fileName(ev, kind, sz, key, cams) {
    const d = ev.clips[0].time ? new Date(ev.clips[0].time) : new Date();
    const stamp = `${T.fmtDate(d)}_${T.pad2(d.getHours())}-${T.pad2(d.getMinutes())}-${T.pad2(d.getSeconds())}`;
    const trig = (ev.trigger && ev.trigger.kind) || "event";
    const ct = cams ? X.camsTag(cams) : "";   // export-cams: "_front" / "_3cams" when not all six cameras; all six = the old name
    return `TeslaCam_${stamp}_${trig}${ct ? "_" + ct : ""}_${kind}_${sz.W}x${sz.H}_${key}.${X.CODECS[key].ext}`;
  }
  X.fileName = fileName;
})();
