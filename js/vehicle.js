/* vehicle.js — Vehicle details (beta): colour, type/role and (optionally) make & model of the cars, buses and trucks
 * the object detector finds, so searches like "red tour bus", "white police car", "ambulance", "blue Toyota" work.
 * Two stages, all on this device:
 *   1. the YOLO11 detector (detect.js) finds car / bus / truck / motorcycle boxes;
 *   2. on each box: dominant colour from the pixels (vehicle-attrs.js, instant), type/role and make/model by CLIP
 *      zero-shot on the crop — the same CLIP model the picture search already downloads, so nothing extra is fetched.
 * Off until Settings ▸ Vehicle details (beta). Make & model is a separate, rough sub-option. Results are kept in the
 * vehicle index (metadata only: time, camera, box, class, colour, type/make scores — no images) so repeat searches are fast.
 * Any failure → the search says why; detection, plates, picture search, playback and export work as before. */
(function () {
  "use strict";
  const T = (window.TDC = window.TDC || {});
  const A = () => T.vehicleAttrs;
  const KEY = "tdc.vehicle.v1";
  const VEH = new Set(["car", "bus", "truck", "motorcycle"]);
  const CAM_LABEL = { front: "Front", back: "Rear", left_repeater: "Left", right_repeater: "Right", left_pillar: "Left pillar", right_pillar: "Right pillar" };
  const V = (T.vehicle = { status: "", timings: { det: [], color: [], clip: [] }, mem: new Map() });
  const isMobile = () => (T.detect && T.detect.isMobile ? T.detect.isMobile() : /iPhone|iPad|Android/i.test(navigator.userAgent));
  const pct = (c) => Math.round(Math.max(0, Math.min(1, c)) * 100) + "%";
  const $ = (id) => document.getElementById(id);

  V.defaults = () => ({ enabled: false, makes: false });
  V.prefs = () => { const d = V.defaults(); try { const v = JSON.parse(localStorage.getItem(KEY) || "null"); if (v && typeof v === "object") return { ...d, ...v }; } catch (_) {} return d; };
  V.setPref = (k, v) => { const p = V.prefs(); p[k] = v; try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (_) {} V.renderSettings(); };
  V.enabled = () => V.prefs().enabled === true;
  V.parse = (q) => (A() ? A().parse(q) : null);
  /** Queries this answers: an attribute was named (colour, role, make/model). Plain "car"/"bus" stay with the detector. */
  V.handlesQuery = (q) => { if (!V.enabled()) return false; const p = V.parse(q); return !!(p && (p.color || p.type || p.make)); };

  // ── query chips (what the search understood) ──
  V.chips = (list) => {
    const html = (list || []).filter(Boolean).map((c) => '<span class="q-chip">' + String(c).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])) + "</span>").join("");
    for (const id of ["findChips", "usChips"]) { const n = $(id); if (n) { n.innerHTML = html; n.hidden = !html; } }
  };

  // ── vehicle index: metadata only, its own IndexedDB database; memory only if IndexedDB is unavailable ──
  let db = null; V.mode = "memory";
  const dbOpen = () => new Promise((res, rej) => {
    let req; try { req = indexedDB.open("tdc-vehicle-index", 1); } catch (e) { return rej(e); }
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains("events")) req.result.createObjectStore("events", { keyPath: "eventId" }); };
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); req.onblocked = () => rej(new Error("IndexedDB blocked"));
    setTimeout(() => rej(new Error("IndexedDB open timeout")), 4000);
  });
  V.ready = (async () => {
    try {
      if (!("indexedDB" in window) || !window.indexedDB) throw new Error("no IndexedDB");
      db = await dbOpen();
      const all = await new Promise((r, j) => { const q = db.transaction("events").objectStore("events").getAll(); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
      for (const rec of all || []) V.mem.set(rec.eventId, rec);
      V.mode = "indexeddb";
    } catch (e) { db = null; V.mode = "memory"; }
  })();
  const save = async (rec) => {
    rec.at = Date.now(); V.mem.set(rec.eventId, rec);
    if (db) try { await new Promise((r, j) => { const tx = db.transaction("events", "readwrite"); tx.objectStore("events").put(rec); tx.oncomplete = r; tx.onerror = () => j(tx.error); }); } catch (e) { db = null; V.mode = "memory"; }
  };
  V.indexCount = () => [...V.mem.values()].reduce((n, r) => n + Object.values(r.frames || {}).reduce((m, f) => m + f.length, 0), 0);
  V.clearIndex = async () => { V.mem.clear(); if (db) try { await new Promise((r) => { const tx = db.transaction("events", "readwrite"); tx.objectStore("events").clear(); tx.oncomplete = r; tx.onerror = r; }); } catch (_) {} V.renderSettings(); };

  // ── CLIP zero-shot text side (computed once per session) ──
  let typeVecs = null, makeVecs = null;
  async function getTypeVecs() {
    if (typeVecs) return typeVecs;
    const out = [];
    for (const t of A().TYPES) { const vs = await T.search.clip.texts(t.prompts); out.push({ id: t.id, cls: t.cls, vec: mean(vs) }); }
    return (typeVecs = out);
  }
  async function getMakeVecs() {
    if (makeVecs) return makeVecs;
    const ps = A().makePrompts();
    const vs = await T.search.clip.texts(ps.map((p) => p.prompt));
    return (makeVecs = ps.map((p, i) => ({ make: p.make, model: p.model, vec: vs[i] })));
  }
  function mean(vs) { const o = new Float32Array(vs[0].length); for (const v of vs) for (let i = 0; i < o.length; i++) o[i] += v[i]; let n = 0; for (const x of o) n += x * x; n = Math.sqrt(n) || 1; for (let i = 0; i < o.length; i++) o[i] /= n; return o; }
  const dot = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };
  function softmax(xs, scale) { const m = Math.max(...xs); const e = xs.map((x) => Math.exp((x - m) * scale)); const s = e.reduce((a, b) => a + b, 0); return e.map((x) => x / s); }

  // ── crops ──
  let cc = null, cctx = null, kc = null, kctx = null;
  function cropPixels(img, iw, ih, b) {   // small crop for colour (≤ 64 px wide), slightly inset to drop background
    const x = Math.max(0, (b.x + b.w * 0.06) * iw), y = Math.max(0, (b.y + b.h * 0.06) * ih), w = Math.max(2, b.w * 0.88 * iw), h = Math.max(2, b.h * 0.88 * ih);
    const W = Math.max(8, Math.min(64, Math.round(w))), H = Math.max(8, Math.min(64, Math.round((h / w) * W)));
    if (!cc) { cc = document.createElement("canvas"); cctx = cc.getContext("2d", { willReadFrequently: true }); }
    cc.width = W; cc.height = H; cctx.drawImage(img, x, y, w, h, 0, 0, W, H);
    return { data: cctx.getImageData(0, 0, W, H).data, w: W, h: H };
  }
  function cropCanvas(img, iw, ih, b) {    // 224×224 letterboxed crop with a little context for CLIP
    const pad = 0.06, x = Math.max(0, (b.x - b.w * pad) * iw), y = Math.max(0, (b.y - b.h * pad) * ih);
    const w = Math.min(iw - x, b.w * (1 + 2 * pad) * iw), h = Math.min(ih - y, b.h * (1 + 2 * pad) * ih);
    if (!kc) { kc = document.createElement("canvas"); kc.width = kc.height = 224; kctx = kc.getContext("2d", { willReadFrequently: true }); }
    const s = 224 / Math.max(w, h), dw = w * s, dh = h * s;
    kctx.fillStyle = "rgb(124,116,104)"; kctx.fillRect(0, 0, 224, 224); kctx.drawImage(img, x, y, w, h, (224 - dw) / 2, (224 - dh) / 2, dw, dh);
    return kc;
  }

  /** Attributes for one detected vehicle. need = { type, make } decides whether CLIP runs. Fills d.color/colorConf/colors/lowLight, d.types, d.makes. */
  /** fix = T.wb.colourFix(t) result ({gains, cct}) or null: the crop's colour is judged after that white balance. */
  V.describe = async (img, iw, ih, d, need, fix) => {
    if (!d.color) {
      const t0 = performance.now();
      const px = cropPixels(img, iw, ih, d);
      const c = A().colorFromPixels(px.data, px.w, px.h, fix ? (fix.matrix ? { matrix: fix.matrix, night: fix.cct < 4500 } : { gains: fix.gains, night: fix.cct < 4500 }) : null);
      if (fix) { d.wbK = Math.round(fix.cct / 100) * 100; d.rawColor = A().colorFromPixels(px.data, px.w, px.h).name; } else { delete d.wbK; delete d.rawColor; }
      d.color = c.name; d.colorConf = c.conf; d.lowLight = c.lowLight; d.colorQ = { lamps: c.lamps || 0, rearLit: !!c.rearLit, dark: !!c.dark, thin: !!c.thin };
      d.colors = Object.fromEntries(Object.entries(c.scores).filter(([, v]) => v >= 0.08).map(([k, v]) => [k, Math.round(v * 100) / 100]));
      V.timings.color.push(performance.now() - t0);
    }
    if (need.make && !d.makes && d.label === "bus") d.makes = [];
    if ((need.type && !d.types) || (need.make && !d.makes)) {
      const t0 = performance.now();
      const vec = await T.search.clip.image(cropCanvas(img, iw, ih, d));
      if (need.type && !d.types) {
        const tv = (await getTypeVecs()).filter((t) => t.cls.includes(d.label));
        if (tv.length) { const p = softmax(tv.map((t) => dot(vec, t.vec)), 100); d.types = Object.fromEntries(tv.map((t, i) => [t.id, Math.round(p[i] * 1000) / 1000])); }
        else d.types = {};
      }
      if (need.make && !d.makes && d.label === "bus") d.makes = [];   // buses: no make/model list
      else if (need.make && !d.makes) {
        const mv = await getMakeVecs();
        const p = softmax(mv.map((m) => dot(vec, m.vec)), 100);
        d.makes = mv.map((m, i) => [m.make, m.model, Math.round(p[i] * 1000) / 1000]).sort((a, b) => b[2] - a[2]).slice(0, 8);
      }
      V.timings.clip.push(performance.now() - t0); if (V.timings.clip.length > 60) V.timings.clip.shift();
      d._vec = vec;
    }
    // colour-constancy prototype (off by default): CLIP's colour on the crop, fused with the pixel statistics
    const CCp = T.cc && T.cc.on() ? T.cc.prefs() : null;
    if (CCp && CCp.clip && d.color && !d.clipColor && T.search && T.search.clip) {
      try {
        const vec = d._vec || (await T.search.clip.image(cropCanvas(img, iw, ih, d)));
        const cl = await T.cc.clipColourVec(vec, d.label), f = T.cc.fuseColour({ name: d.color, scores: d.colors }, cl);
        d.pixColor = d.color; d.clipColor = cl.name; d.color = f.name; d.colorConf = Math.round(f.conf * 100) / 100;
      } catch (e) { console.warn("cc clip colour", e); }
    }
    delete d._vec;
    return d;
  };

  /** Score one described vehicle against the parsed query. → { score, parts } or null (doesn't match). */
  V.score = (q, d) => {
    if (!q.cls.includes(d.label)) return null;
    const parts = { det: d.conf };
    let s = Math.sqrt(d.conf);
    if (q.color) { const cm = A().colorMatch(q.color, { name: d.color, scores: d.colors }); if (cm < 0.3) return null; parts.color = cm; s *= cm * (d.lowLight ? 0.7 : 1); }
    if (q.type) {
      const ps = d.types || {}, p = ps[q.type] || 0, top = Object.entries(ps).sort((a, b) => b[1] - a[1])[0];
      // the asked-for role must be the best guess, or close to it (a tour bus is not also a "city bus")
      if (!(top && (top[0] === q.type ? p > 0.1 : p >= 0.35 && p >= 0.8 * top[1]))) return null;
      parts.type = p; s *= Math.pow(p, 0.7);
    }
    if (q.make && d.makes) {
      const mk = d.makes.filter((m) => m[0] === q.make && (!q.model || m[1] === q.model)).reduce((a, m) => a + m[2], 0);
      const topMake = d.makes[0];
      if (!(mk >= 0.15 || (topMake && topMake[0] === q.make && (!q.model || topMake[1] === q.model)))) return null;
      parts.make = mk; s *= Math.pow(mk, 0.5);
    }
    return { score: s, parts };
  };

  /** "red tour bus · bus 88% · type 71% · color red" (+ make, "· Best match"). Same text in results, gold box, export, phone strip. */
  /** The colour a result shows: its vehicle's locked colour (same as the live box and the export), else the frame's reading. */
  V.shownColor = (h) => {
    const d = h.vdet; if (!d) return null;
    const L = T.colorLock; if (!L || !h.box) return d.color;
    if (h._clv !== L.version) { h._clv = L.version; const c = L.colourAt(h.cam, h.t, h.box); h._clc = c && c.locked ? c.name : null; }
    return h._clc || d.color;
  };
  /** Current label of a search hit: vehicle hits follow their colour lock (it may firm up after the search ran). */
  V.hitText = (h) => (h && h.vdet && h.vehicle ? V.labelText(h) : h && h.boxText);
  V.labelText = (h) => {
    const d0 = h.vdet, q = h.vq || {}, sc = V.shownColor(h), d = sc && sc !== d0.color ? { ...d0, color: sc, colorConf: Math.max(0.5, d0.colorConf || 0), lowLight: false } : d0;
    const name = [d.color && (q.color || d.colorConf >= 0.3) ? d.color : null, q.make && d.makes && d.makes[0] ? d.makes[0][0] + (q.model ? " " + d.makes[0][1] : "") : null, q.type || (q.make ? null : d.label)].filter(Boolean).join(" ") || d.label;
    if (h.unconfirmed) return [d.label + " " + pct(d.conf), (q.label || "") + "? not confirmed", "color " + d.color + (d.wbK ? " (corrected for " + d.wbK + " K light)" : "")].concat(h.best ? ["Best match"] : []).join(" · ");
    const parts = [name, d.label + " " + pct(d.conf)];
    if (h.parts.type != null) parts.push("type " + pct(h.parts.type));
    if (h.parts.make != null) parts.push((q.model ? "model " : "make ") + pct(h.parts.make));
    parts.push("color " + d.color + (d.wbK ? " (corrected for " + d.wbK + " K light)" : "") + (d.lowLight ? "? (low light)" : ""));
    if (h.best) parts.push("Best match");
    return parts.join(" · ");
  };

  /** Set up one vehicle query for a scan: parsed query, what CLIP has to check, budgets. Loads CLIP when the query needs it. */
  V.begin = async (q, ui) => {
    const P = V.prefs(), parsed = V.parse(q);
    if (!parsed) return null;
    const need = { type: !!parsed.type, make: !!parsed.make && P.makes };
    if (parsed.make && !P.makes) parsed.makeOff = true;
    const useClip = need.type || need.make;
    if (useClip) { ui.status("Loading the vision model for vehicle type" + (need.make ? " and make" : "") + "… (the same one picture search uses; first time about 150 MB). Your video stays on this computer."); await T.search.clip.load(ui.status); }
    await V.ready;
    const ev = T.player.ev;
    const rec = V.mem.get(ev.id) || { eventId: ev.id, frames: {} };
    const wbMode = (T.wb && T.wb.colourMode ? T.wb.colourMode() : "off") + (T.cc && T.cc.on() ? "|cc:" + JSON.stringify(T.cc.prefs()) : "");
    // colours stored by older versions were read from raw pixels (and the setting may have changed): judge them again
    if (rec.cver !== COLOR_VER || rec.cwb !== wbMode) { for (const k of Object.keys(rec.frames || {})) for (const d of rec.frames[k]) for (const f of COLOR_FIELDS) delete d[f]; rec.cver = COLOR_VER; rec.cwb = wbMode; }
    const wbFix = async (t, img, iw, ih, cam) => {
      const f = T.wb && T.wb.colourFix ? await T.wb.colourFix(t) : null;
      if (img && T.cc && T.cc.on()) { try { const c = await T.cc.fixFor(img, iw, ih, t, cam || "front", f); if (c) return c; } catch (e) { console.warn("cc fix", e); } }
      return f;
    };
    return { q, parsed, need, useClip, rec, wbFix, clipLeft: isMobile() ? 60 : 240, perFrame: isMobile() ? 2 : 4, rows: [], plain: [], fresh: 0, reused: 0 };
  };
  const COLOR_VER = 3;   // 3: lit lamps masked, red cast on a pale body is neutral (tag taillight-fix); 2: after white balance (tag wb-color); 1 (none): raw pixels
  const COLOR_FIELDS = ["color", "colorConf", "colors", "lowLight", "wbK", "rawColor", "pixColor", "clipColor", "colorQ"];
  V.COLOR_VER = COLOR_VER;
  V.colourModeChanged = () => { for (const rec of V.mem.values()) rec.cwb = "?"; };   // re-judged on the next search
  V.detConf = () => Math.max(0.2, Math.round(T.detect.prefs().conf * 0.75 * 100) / 100);
  /** The vehicle boxes of one frame, from the frame's detector output (all classes, conf ≥ V.detConf()). */
  V.vehicleDets = (all) => all.filter((d) => VEH.has(d.label) && d.conf >= V.detConf() && d.w * d.h >= 0.0015 && d.w >= 0.025).sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 6)
    .map((d) => ({ x: +d.x.toFixed(4), y: +d.y.toFixed(4), w: +d.w.toFixed(4), h: +d.h.toFixed(4), label: d.label, conf: +d.conf.toFixed(3) }));
  /** One sampled frame for one vehicle query. st = V.begin(...); getAll() → the frame's detector output (all classes) or null;
   *  getFrame() → the decoded frame (for colour / CLIP crops). Rows go to st.rows (confirmed) / st.plain (detector only). */
  const clSeen = new WeakSet();
  V.frame = async (st, s, getAll, getFrame) => {
    const key = s.cam + "|" + s.t.toFixed(2), parsed = st.parsed, need = st.need;
    let dets = st.rec.frames[key];
    if (!dets) {
      const all = await getAll(); if (!all) return;
      dets = V.vehicleDets(all); st.rec.frames[key] = dets; st.fresh++;
    } else st.reused++;
    const cand = dets.filter((d) => parsed.cls.includes(d.label));
    let n = 0, v = null;
    for (const d of cand) {
      const wantClip = (need.type && !d.types) || (need.make && !d.makes);
      if (!d.color || (wantClip && n < st.perFrame)) {
        if (!(v = v || (await getFrame()))) break;
        if (!d.color) {
          // prototype on: the light estimate takes a while (learned model) and the shared frame video can move on
          // meanwhile, so judge a still copy of this frame
          let img = v, iw = v.videoWidth, ih = v.videoHeight;
          if (T.cc && T.cc.on()) { if (!st.snap || st.snapT !== s.t || st.snapCam !== s.cam) { st.snap = st.snap || document.createElement("canvas"); st.snap.width = iw; st.snap.height = ih; st.snap.getContext("2d").drawImage(v, 0, 0); st.snapT = s.t; st.snapCam = s.cam; } img = st.snap; }
          const fix = await st.wbFix(s.t, img, iw, ih, s.cam); await V.describe(img, iw, ih, d, {}, fix);
        }
        // colour first: no CLIP for a box whose colour is clearly wrong
        if (parsed.color && A().colorMatch(parsed.color, { name: d.color, scores: d.colors }) < 0.3) continue;
        if (wantClip && n < st.perFrame && st.clipLeft > 0) { n++; st.clipLeft--; try { await V.describe(v, v.videoWidth, v.videoHeight, d, need); } catch (e) { if (!st.rows.length) throw e; console.warn("vehicle crop", e); } }
      }
      const m = V.score(parsed, d);
      if (!m) { st.plain.push({ t: s.t, cam: s.cam, score: d.conf * 0.5, conf: d.conf, label: d.label, det: true, vehicle: true, unconfirmed: true, vdet: d, vq: parsed, parts: {}, box: { x: d.x, y: d.y, w: d.w, h: d.h } }); continue; }
      st.rows.push({ t: s.t, cam: s.cam, score: m.score, conf: d.conf, label: d.label, det: true, vehicle: true, vdet: d, vq: parsed, parts: m.parts, box: { x: d.x, y: d.y, w: d.w, h: d.h } });
    }
    // colour lock: this frame's colour readings join the vehicles' colour tracks (once per session; index records stay clean)
    if (T.colorLock) { const items = dets.filter((d) => d.color && !clSeen.has(d)).map((d) => { clSeen.add(d); return { det: d, c: { name: d.color, conf: d.colorConf, lowLight: d.lowLight, ...(d.colorQ || {}) }, pxW: d.w * (v && v.videoWidth ? v.videoWidth : 1280) }; });
      if (items.length) try { T.colorLock.observeFrame(s.cam, s.t, items, true); } catch (_) {} }
  };
  /** Finish: save the vehicle index; refinement, never a gate: when nothing passes the colour / type / make check, return what
   *  the detector saw (marked "not confirmed"). */
  V.end = async (st, ms, frames) => {
    V.lastSearch = { ms, frames, fresh: st.fresh, reused: st.reused, unconfirmed: !st.rows.length && st.plain.length > 0 };
    try { await save(st.rec); } catch (_) {}
    return st.rows.length ? st.rows : st.plain;
  };

  /** Search the sampled frames. list = [{t, cam}] (search.js samples). Returns rows like the detector's, with .vehicle. */
  V.runSearch = async (q, list, ui) => {
    const st = await V.begin(q, ui);
    if (!st) return [];
    // every sampled frame is detected (same spacing as the detector search, every camera); CLIP has its own crop budget
    const cap = isMobile() ? 180 : 600;
    const step = Math.max(1, Math.ceil(list.length / cap));
    const frames = list.filter((_, i) => i % step === 0);
    const detConf = V.detConf();
    const t0 = performance.now();
    for (let i = 0; i < frames.length; i++) {
      if (ui.stopped()) break;
      const s = frames[i];
      ui.status("Looking for " + st.parsed.label + " · frame " + (i + 1) + " of " + frames.length + " · " + (CAM_LABEL[s.cam] || s.cam) + (st.useClip ? " · checking type" + (st.need.make ? " and make" : "") : "") + ". The video stays on this computer.");
      let v = null;
      const getFrame = async () => (v = v || (await T.detect.frameAt(s.cam, s.t)));
      const getAll = async () => {
        if (!(await getFrame())) return null;
        const td = performance.now();
        try { const all = await T.detect.detectImage(v, v.videoWidth, v.videoHeight, { conf: detConf }); V.timings.det.push(performance.now() - td); return all; }
        catch (e) { if (!st.rows.length && i === 0) throw e; console.warn(e); return null; }
      };
      await V.frame(st, s, getAll, getFrame);
      if ((i & 3) === 0) await new Promise((r) => setTimeout(r, 0));
    }
    return V.end(st, performance.now() - t0, frames.length);
  };

  /** Group sightings (same camera within 2.5 s), keep the best of each, mark Best match, set the shared label. */
  V.cluster = (rows) => {
    const groups = [];
    // colour lock: a box whose vehicle has locked onto a colour the query rules out ranks lower (the frame's own reading
    // was a lamp / shadow flash; the label will show the locked colour)
    for (const r of rows) { const q = r.vq && r.vq.color, sc = q && r.vdet ? V.shownColor(r) : null;
      if (sc && sc !== r.vdet.color && A() && A().colorMatch(q, { name: sc }) < 0.3) { r.score *= 0.5; r.lockMismatch = sc; } }
    for (const r of rows.slice().sort((a, b) => b.score - a.score)) {
      const g = groups.find((x) => x.cam === r.cam && Math.abs(x.t - r.t) < 2.5);
      if (!g) groups.push({ ...r, seen: 1 }); else g.seen++;
    }
    const out = groups.slice(0, 20), top = out.length ? out[0].score : 0;
    out.forEach((h) => { h.best = top > 0 && h.score >= top * 0.85; h.text = V.labelText(h); h.boxText = h.text; });
    return out.sort((a, b) => a.t - b.t);
  };

  /** Live labels while playing: add the colour of vehicles (cheap, no CLIP). */
  /** t: the frame's time (white balance for colour at that moment); fix: a known colourFix (export prepare), else the
   *  white point known now (T.wb.colourFixNow). */
  /** cam: the camera (colour lock: every reading joins its vehicle's colour track, js/color-lock.js). */
  V.decorateLive = (img, iw, ih, dets, t, fix, cam) => {
    if (!V.enabled() || !A()) return dets;
    if (fix === undefined) fix = T.wb && T.wb.colourFixNow && t != null ? T.wb.colourFixNow(t) : null;
    const items = [];
    for (const d of dets) if (VEH.has(d.label)) { try { const px = cropPixels(img, iw, ih, d); const c = A().colorFromPixels(px.data, px.w, px.h, fix ? (fix.matrix ? { matrix: fix.matrix, night: fix.cct < 4500 } : { gains: fix.gains, night: fix.cct < 4500 }) : null); d.attr = c.name + (c.lowLight ? "?" : ""); if (fix) d.attrWbK = Math.round(fix.cct / 100) * 100; items.push({ det: d, c, pxW: d.w * iw }); } catch (_) {} }
    if (cam && T.colorLock && items.length) { try { T.colorLock.observeFrame(cam, t, items); } catch (e) { console.warn("color lock", e); } }
    return dets;
  };
  /** Colour word of a live / exported box: its colour track's locked colour ("~white" while still deciding), else the
   *  frame's own reading. */
  V.liveWord = (b) => { try { if (b && b.clObs && T.colorLock) return T.colorLock.word(b.clObs); } catch (_) {} return b && b.attr ? b.attr : ""; };

  // ── Settings ▸ Vehicle details (beta) ──
  V.renderSettings = () => {
    const box = $("setVehicle"); if (!box) return;
    const P = V.prefs();
    box.innerHTML = "";
    const row = (html) => { const d = document.createElement("div"); d.className = "row"; d.innerHTML = html; box.appendChild(d); return d; };
    row('<label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" id="vehEnabled"' + (P.enabled ? " checked" : "") + "> Vehicle details: colour and type (tour bus, city bus, police car, ambulance, fire truck, taxi…)</label>");
    row('<label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" id="vehMakes"' + (P.makes ? " checked" : "") + (P.enabled ? "" : " disabled") + "> Make &amp; model (rough guess: Tesla Model Y, Toyota Prius…)</label>");
    const note = document.createElement("p"); note.className = "hint";
    note.textContent = "Uses the object detector to find vehicles, then reads the colour from the pixels and asks the picture-search model (CLIP) what kind of vehicle it is. Try: red tour bus, white police car, ambulance, blue Toyota. " +
      "Colours are unreliable at night and under orange street lights. Make & model is a guess from the picture and is often wrong for similar-looking cars. Nothing is uploaded. " +
      "Index: " + V.indexCount() + " vehicles saved (" + (V.mode === "indexeddb" ? "on this device" : "this session only") + ").";
    box.appendChild(note);
    const clr = document.createElement("button"); clr.className = "btn ghost"; clr.id = "vehClear"; clr.textContent = "Forget vehicle index"; box.appendChild(clr);
    clr.onclick = () => V.clearIndex();
    box.querySelector("#vehEnabled").onchange = (e) => V.setPref("enabled", e.target.checked);
    box.querySelector("#vehMakes").onchange = (e) => V.setPref("makes", e.target.checked);
  };

  V.init = () => { try { V.renderSettings(); V.ready.then(() => V.renderSettings()); } catch (e) { console.warn("vehicle init", e); } };
})();
