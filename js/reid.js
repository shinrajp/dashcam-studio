/* Re-identification (Hand-off milestone 4): what a person looks like, so the same walker keeps one id and one colour on every camera.
 *   1. colour descriptor (always, cheap): a 32-bin clothing-colour histogram (upper body + lower body) from a small crop of the box.
 *   2. appearance embedding (when it pays): a 256-d vector from the bundled person re-identification model
 *      (models/reid/person-reidentification-retail-0288.onnx, Intel Open Model Zoo, Apache-2.0, 0.77 MB) in the detection worker —
 *      on WebGPU only when that worker really runs the WebGPU runtime (the app keeps WebGPU off on Safari/iOS; ?webgpu=on|off|auto overrides),
 *      otherwise on WASM, throttled to hand-off moments (a track near a picture edge, or one that just appeared) and a few crops a second.
 *   3. people.js combines either with where / when / which way (the fixed camera adjacency) → global id + colour, flagged "best guess".
 * Everything runs on this device. Pure helpers are node-testable (test/handoff.test.js). Perf guard: if describing crops, or the embedding model, is
 * too slow for the device it switches itself down (embedding off → colour only → matching off in Auto) instead of slowing playback. */
(function (root) {
  "use strict";
  const BINS = 32;   // 12 hue + 4 neutral (black, dark grey, light grey, white), for the upper body and the lower body
  /** Clothing colour histogram of a person crop: RGBA pixels (w×h). Upper body = 18–50 % of the height, lower = 50–90 %, middle 70 % of the width. */
  function histFromRGBA(px, w, h) {
    const hist = new Float32Array(BINS), x0 = Math.floor(w * 0.15), x1 = Math.ceil(w * 0.85);
    // exposure + colour-cast normalisation (grey-world over the body region): cameras differ in brightness and white balance, clothes should not
    let mr = 0, mg = 0, mb = 0, mn = 0;
    for (let y = Math.floor(h * 0.18); y < Math.floor(h * 0.9); y += 4) for (let x = x0; x < x1; x += 4) { const i = (y * w + x) * 4; mr += px[i]; mg += px[i + 1]; mb += px[i + 2]; mn++; }
    mn = mn || 1; mr = mr / mn + 1; mg = mg / mn + 1; mb = mb / mn + 1;
    const kr = Math.min(2.5, 118 / mr), kg = Math.min(2.5, 118 / mg), kb = Math.min(2.5, 118 / mb);
    const part = (y0, y1, off) => {
      let n = 0;
      for (let y = Math.floor(h * y0); y < Math.floor(h * y1); y += 2) for (let x = x0; x < x1; x += 2) {
        const i = (y * w + x) * 4, r = Math.min(1, px[i] * kr / 255), g = Math.min(1, px[i + 1] * kg / 255), b = Math.min(1, px[i + 2] * kb / 255);
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        let bin;
        if (mx < 0.2) bin = 12; else if (d < 0.14 || d / mx < 0.2) bin = mx < 0.45 ? 13 : mx < 0.78 ? 14 : 15;
        else { let hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; if (hh < 0) hh += 6; bin = Math.min(11, Math.floor((hh / 6) * 12)); }
        hist[off + bin]++; n++;
      }
      if (n) for (let k = 0; k < 16; k++) hist[off + k] /= 2 * n;   // each half sums to 0.5, the whole to 1
    };
    part(0.18, 0.5, 0); part(0.5, 0.9, 16);
    // soft-spread neighbouring hue bins a little (lighting changes between cameras move a colour by a bin)
    const o = new Float32Array(BINS);
    for (const off of [0, 16]) for (let k = 0; k < 16; k++) { const v = hist[off + k]; if (k < 12) { o[off + k] += v * 0.6; o[off + (k + 1) % 12] += v * 0.2; o[off + (k + 11) % 12] += v * 0.2; } else o[off + k] += v; }
    return Array.from(o);
  }
  /** Running average of unit vectors, re-normalised. */
  function mergeEmb(old, n, nu, keep) {
    if (!old) return nu;
    const k = keep == null ? 0.5 : keep, o = new Float32Array(nu.length); let s = 0;
    for (let i = 0; i < nu.length; i++) { o[i] = k * old[i] + (1 - k) * nu[i]; s += o[i] * o[i]; }
    s = Math.sqrt(s) || 1; for (let i = 0; i < o.length; i++) o[i] /= s; return o;
  }
  /** Budgets: how often to embed and when to give up, per backend and device class. */
  function budget(backend, mobile) {
    return backend === "webgpu" ? { every: 160, priorityOnly: false, maxMean: 120 } : mobile ? { every: 1100, priorityOnly: true, maxMean: 320 } : { every: 520, priorityOnly: true, maxMean: 220 };
  }
  /** Embedding priority of a track at event time `now`: leaving through an edge or just appeared (a hand-off moment) beats a steady track. */
  function priority(tr, now) {
    const edge = tr.x < 0.2 && tr.vx < -0.02 || tr.x + tr.w > 0.8 && tr.vx > 0.02, fresh = tr.first != null && now - tr.first < 2.5, nearEdge = tr.x < 0.12 || tr.x + tr.w > 0.88;
    return (edge ? 3 : 0) + (fresh ? 2 : 0) + (nearEdge ? 1 : 0);
  }
  const api = { BINS, histFromRGBA, mergeEmb, budget, priority };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!root.document || !root.TDC) return;

  const T = root.TDC, R = (T.reid = Object.assign({}, api));
  const mem = new Map();   // "cam:trackId" → { hist, emb, at (last descriptor), embAt, n, size }
  R.mem = mem;
  R.stats = { descMs: [], embMs: [], jobs: 0, embJobs: 0, skipped: 0, backend: null, loaded: false, error: null, demoted: null };
  const cvs = new Map();
  let busy = false, lastEmbed = 0, loading = false;
  const mobile = () => !!(T.detect && T.detect.isMobile && T.detect.isMobile());
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const push = (a, v) => { a.push(v); if (a.length > 24) a.shift(); };

  /** Heuristic cost guard for the Auto setting of Cross-camera matching: describing crops must stay cheap on this device. */
  R.autoOff = () => R.stats.descMs.length >= 8 && mean(R.stats.descMs) > (mobile() ? 14 : 8);
  R.backend = () => (R.stats.loaded && !R.stats.demoted ? R.stats.backend : null);

  /** Crop of a track's box from its live video into w×h pixels (null when the video isn't ready or the box is too small to say anything about clothes). */
  function crop(cam, tr, cw, ch) {
    const P = T.player; if (!P || !P.tiles || !P.tiles[cam]) return null;
    const v = P.tiles[cam].vids[P.active]; if (!v || v.readyState < 2 || !v.videoWidth) return null;
    const vw = v.videoWidth, vh = v.videoHeight, bw = tr.w * vw, bh = tr.h * vh;
    if (bw < 18 || bh < 36) return null;   // too small to say anything about clothes
    let c = cvs.get(cw); if (!c) { const el = document.createElement("canvas"); el.width = cw; el.height = ch; c = { el, g: el.getContext("2d", { willReadFrequently: true }) }; cvs.set(cw, c); }
    const cx = c.g;
    const sx = Math.max(0, tr.x * vw - bw * 0.06), sy = Math.max(0, tr.y * vh - bh * 0.03), sw = Math.min(vw - sx, bw * 1.12), sh = Math.min(vh - sy, bh * 1.06);
    try { cx.drawImage(v, sx, sy, sw, sh, 0, 0, cw, ch); return cx.getImageData(0, 0, cw, ch); } catch (_) { return null; }
  }
  const entry = (k) => { let e = mem.get(k); if (!e) { e = { hist: null, emb: null, at: -9, embAt: -9, n: 0 }; mem.set(k, e); } return e; };

  /** Adds hist / emb to person tracks (from what was learned on earlier calls) and schedules new looks. Synchronous; the model runs behind it. */
  R.annotate = (tracks, t) => {
    const now = performance.now() / 1000, mob = mobile(), gap = mob ? 1.0 : 0.6;
    const linking = T.people && T.people.linkOn ? T.people.linkOn() : true;
    if (!linking || !T.player || T.player.ev == null) return tracks;
    // colour descriptor: every track, at most one per `gap` seconds each, a couple per call
    let did = 0;
    for (const tr of tracks) {
      if (did >= (mob ? 2 : 3)) break;
      const e = entry(tr.cam + ":" + tr.id); if (now - e.at < gap) continue;
      const t0 = performance.now(), img = crop(tr.cam, tr, 48, 96); e.at = now; if (!img) continue;
      const h = histFromRGBA(img.data, 48, 96); e.hist = e.hist ? e.hist.map((v, i) => 0.6 * v + 0.4 * h[i]) : h; e.n++; did++;
      push(R.stats.descMs, performance.now() - t0); R.stats.jobs++;
      e._tr = tr;   // looked at in this call: a candidate for an embedding below (that one takes a bigger crop)
    }
    R.maybeEmbed(tracks, now);
    for (const e of mem.values()) if (e._tr) e._tr = null;
    return tracks.map((tr) => { const e = mem.get(tr.cam + ":" + tr.id); return e ? Object.assign({}, tr, { hist: e.hist || tr.hist, emb: e.emb || tr.emb }) : tr; });
  };

  R.maybeEmbed = (tracks, now) => {
    const D = T.detect; if (!D || !D.loadReid || R.stats.demoted || busy) return;
    const P = T.prefs && T.prefs.reid; if (P === false) return;
    if (!R.stats.loaded) { if (!loading && tracks.length && (D.prefs().enabled)) { loading = true; D.loadReid().then((info) => { R.stats.loaded = !!info; R.stats.backend = info && info.backend; R.stats.selfMs = info && info.selfTestMs; if (!info) R.stats.error = "model unavailable"; T.emit && T.emit("reid-status"); }).catch(() => {}).finally(() => { loading = false; }); } return; }
    const B = budget(R.stats.backend, mobile());
    if (now * 1000 - lastEmbed < B.every) return;
    if (D.avgMs && D.avgMs() > (mobile() ? 260 : 450)) { R.stats.skipped++; return; }   // the detector is already struggling: don't add work
    let best = null, bp = -1;
    for (const tr of tracks) {
      const e = mem.get(tr.cam + ":" + tr.id); if (!e || !e._tr) continue;
      const p = priority(tr, T.player.time || 0) + (e.emb ? 0 : 1) + (now - e.embAt > 4 ? 1 : 0);
      if (B.priorityOnly && p < 3 && e.emb) continue;
      if (!e.emb || now - e.embAt > (B.priorityOnly ? 4 : 1.2)) if (p > bp) { bp = p; best = [tr, e]; }
    }
    if (!best) return;
    const [tr, e] = best; busy = true; lastEmbed = now * 1000; e.embAt = now;
    const img = crop(tr.cam, tr, 128, 256); if (!img) { busy = false; return; }
    const buf = new Uint8ClampedArray(img.data).buffer;
    D.embed(buf).then((r) => {
      e.emb = mergeEmb(e.emb, e.n, r.emb, 0.5); R.stats.embJobs++; push(R.stats.embMs, r.ms); R.stats.backend = r.backend || R.stats.backend;
      const B2 = budget(R.stats.backend, mobile());
      if (R.stats.embMs.length >= 5 && mean(R.stats.embMs) > B2.maxMean) { R.stats.demoted = "too slow on this device (" + Math.round(mean(R.stats.embMs)) + " ms per crop): colour matching only"; T.emit && T.emit("reid-status"); }
    }).catch((err) => { R.stats.error = String((err && err.message) || err); R.stats.demoted = "re-identification model failed: colour matching only"; T.emit && T.emit("reid-status"); }).finally(() => { busy = false; });
  };

  /** Should a brand-new track wait before it is given an identity? Until its colour descriptor exists (and, when the model is running, its
   *  embedding), but never longer than ~0.7 s. */
  R.pending = (tr, now) => {
    const age = now - (tr.first != null ? tr.first : tr.seen), e = mem.get(tr.cam + ":" + tr.id);
    if (!e || !e.hist || e.emb || age > 1.0 || age < 0) return false;   // no descriptor possible (video not ready, box too small) or already embedded: don't wait
    if (!R.backend()) return false;   // no model running: colour only
    if (!e.wall) e.wall = performance.now();
    return performance.now() - e.wall < 700;   // and never longer than 0.7 s of wall time (a paused player doesn't advance event time)
  };
  R.reset = () => { mem.clear(); };
  R.statusText = () => {
    const S = R.stats, on = T.people && T.people.linkOn ? T.people.linkOn() : true;
    if (!on) return "Off. People are not linked across cameras.";
    const m = S.demoted ? S.demoted : S.loaded ? "appearance model on " + (S.backend === "webgpu" ? "WebGPU" : "WASM (CPU)") + (S.embMs.length ? " · " + Math.round(mean(S.embMs)) + " ms per crop" : "") : "colour, timing and direction (appearance model loads when someone is tracked)";
    return "On · " + m + ". Matches are best guesses.";
  };
  if (T.on) T.on("player-open", R.reset);
  if (T.on) T.on("reid-status", () => { const c = document.getElementById("detCrossStatus"); if (c) c.textContent = R.statusText(); });
})(typeof window !== "undefined" ? window : globalThis);
