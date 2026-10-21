/* color-lock.js — one colour per vehicle, held for the whole time it is followed (tag color-lock).
 * Every colour reading of a vehicle (live detection while playing, export preparation, vehicle search frames) is an
 * OBSERVATION: camera, time, box, class, colour name + confidence, and how much to trust it (crop size, lit lamps, low
 * light / dark, frame edge, overlap with another vehicle). Observations of one camera are chained into colour tracks by
 * position, size and time (a vehicle lost for up to REACQ s and found again near where it was heading keeps its track),
 * and each track keeps confidence-weighted evidence over its whole life:
 *   - provisional until the evidence is strong (≥ LOCK_W good-frame equivalents, top colour ≥ LOCK_SHARE of it);
 *   - LOCKED after that, and it changes only when a different colour wins a clear majority (≥ SWITCH_SHARE) of the good
 *     evidence seen over the last SWITCH_SPAN s, spanning at least SWITCH_MIN_S s and SWITCH_N readings (hysteresis).
 * The viewer (playing or paused), the burned-in export boxes and the vehicle search results all ask this module, so
 * they print the same colour for the same vehicle. Pure JS, no DOM; cheap: work only when a reading is added. */
(function (root) {
  "use strict";
  const C = { REACQ: 3.0, LOCK_W: 2.2, LOCK_SHARE: 0.6, SWITCH_SHARE: 0.72, SWITCH_SPAN: 2.5, SWITCH_MIN_S: 1.5, SWITCH_N: 3, SWITCH_W: 1.6, MAX_OBS: 6000 };
  const VEH = { car: "v", truck: "v", bus: "b", motorcycle: "m" };   // YOLO flips car / truck for SUVs and vans: one family
  const iou = (a, b) => { const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h); const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (a.w * a.h + b.w * b.h - i || 1); };
  const L = { C, cams: {}, nextId: 1, version: 0 };   // version: bumps on every change (callers cache lookups on it)

  /** How much one reading counts (0..1). o: { conf, lamps, rearLit, lowLight, dark, thin, pxW (box width in source px), x,y,w,h, crowd }. */
  L.weight = (o) => {
    let w = Math.max(0.05, Math.min(1, o.conf == null ? 0.5 : o.conf));
    w *= Math.max(0.15, Math.min(1, (o.pxW || 120) / 120));             // small / distant crops say little
    if (o.lamps > 0.02) w *= Math.max(0.2, 1 - 2.5 * o.lamps);            // lamps masked: what's left is less reliable
    if (o.rearLit) w *= 0.35;                                             // its own lamps are lit (brake flash, tail bar: glare)
    if (o.bar) w *= 0.7;                                                  // a full-width light bar lights the whole rear
    if (o.castFix) w *= 0.6;                                              // only judged after taking the frame's red cast out
    if (o.cast > 0.4) w *= Math.max(0.35, 1 - 0.6 * (o.cast - 0.4));      // strong red cast over the frame (night, flare)
    if (o.lowLight) w *= 0.5;
    if (o.dark) w *= 0.6;
    if (o.thin) w *= 0.4;
    const e = 0.012;   // touching the frame edge: cut off (part of the vehicle only)
    if (o.x < e || o.y < e || o.x + o.w > 1 - e || o.y + o.h > 1 - e) w *= 0.4;
    if (o.crowd) w *= 0.5;                                                // overlaps another vehicle (partly hidden)
    return w;
  };

  function camState(cam) { return (L.cams[cam] = L.cams[cam] || { obs: [], tracks: [], lastT: -Infinity }); }
  L.clear = () => { L.cams = {}; L.version++; };

  /** Add one frame's readings. items: [{ det:{x,y,w,h,label}, c:{name, conf, lamps, rearLit, lowLight, dark, thin}, pxW }]
   *  (pxW = box width in source pixels). Each det gets .clObs (its reading). Overlapping vehicles count less (occlusion). */
  L.observeFrame = (cam, t, items, noAttach) => {
    if (!(t >= 0) || !items || !items.length) return [];
    L.version++;
    const S = camState(cam), add = [];
    const dets = items.map((it) => it.det);
    for (const it of items) {
      const det = it.det, c = it.c;
      if (!det || !c || !c.name || !VEH[det.label]) continue;
      const crowd = dets.some((o) => o !== det && o && VEH[o.label] && iou(o, det) > 0.15);
      const o = { cam, t, x: det.x, y: det.y, w: det.w, h: det.h, label: det.label, fam: VEH[det.label], name: c.name, conf: c.conf, lamps: c.lamps || 0, rearLit: !!c.rearLit, bar: !!c.bar, castFix: !!c.castFix, cast: c.cast || 0, lowLight: !!c.lowLight, dark: !!c.dark, thin: !!c.thin, pxW: it.pxW, crowd, tr: null };
      o.wt = L.weight(o);
      // same moment, same box (export prepare re-reading a live frame, a search frame read twice): replace
      const dup = S.obs.find((p) => Math.abs(p.t - t) < 0.02 && p.fam === o.fam && iou(p, o) > 0.8);
      if (dup) { Object.assign(dup, o, { tr: dup.tr }); S.dirty = true; if (!noAttach) det.clObs = dup; continue; }
      S.obs.push(o); add.push(o); if (!noAttach) det.clObs = o;
    }
    if (S.obs.length > C.MAX_OBS) { S.obs.splice(0, S.obs.length - C.MAX_OBS); S.dirty = true; }
    if (add.length) {
      if (t < S.lastT + 1e-4) S.dirty = true;   // out of order (export fills gaps, search frames): rebuild on the next lookup
      else if (!S.dirty) { assignFrame(S, add); S.lastT = t; }
    }
    return add;
  };
  L.observe = (cam, t, det, c, pxW) => (L.observeFrame(cam, t, [{ det, c, pxW }]), det.clObs || null);

  // ── chaining readings into tracks (in time order) ──
  function predict(tr, t) {
    const a = tr.last, b = tr.prev, dt = t - a.t;
    let vx = 0, vy = 0;
    if (b && a.t - b.t > 1e-3 && a.t - b.t < 2) { vx = ((a.x + a.w / 2) - (b.x + b.w / 2)) / (a.t - b.t); vy = ((a.y + a.h / 2) - (b.y + b.h / 2)) / (a.t - b.t); }
    const k = Math.min(dt, 1.5);   // don't extrapolate far
    return { x: a.x + vx * k, y: a.y + vy * k, w: a.w, h: a.h };
  }
  function matchScore(tr, o) {
    const dt = o.t - tr.last.t;
    if (dt <= 1e-4 || dt > C.REACQ || tr.last.fam !== o.fam) return -1;
    const p = predict(tr, o.t);
    const r = Math.max(p.w / o.w, o.w / p.w, p.h / o.h, o.h / p.h);
    if (r > (dt > 0.8 ? 2.6 : 2.2)) return -1;
    const v = iou(p, o), d = Math.hypot(p.x + p.w / 2 - (o.x + o.w / 2), p.y + p.h / 2 - (o.y + o.h / 2)) / Math.max(p.w, p.h, o.w, o.h);
    const near = v >= 0.15 || d < (dt > 0.8 ? 1.0 : 0.7);
    if (!near) return -1;
    let s = v + (1 - Math.min(1, d)) * 0.5 - dt * 0.1;
    // re-acquire after a gap: a clearly different locked colour must also overlap well (two different cars passing the spot)
    if (tr.locked && o.name !== tr.locked && o.wt >= 0.35 && !neighbour(o.name, tr.locked)) { if (dt > 0.6 && v < 0.4) return -1; s -= 0.3; }
    return s;
  }
  const NEAR = { white: ["silver"], silver: ["white", "gray"], gray: ["silver", "black"], black: ["gray"], red: ["orange", "purple"], orange: ["red", "yellow", "brown"], brown: ["orange", "beige"], beige: ["brown", "white"], yellow: ["orange"], purple: ["red", "blue"], blue: ["purple"], green: [] };
  const neighbour = (a, b) => a === b || (NEAR[a] || []).includes(b);
  /** Chain one frame's readings (same t) to tracks: best (track, reading) scores first, one reading per track. */
  function assignFrame(S, list) {
    const pairs = [];
    for (let i = 0; i < list.length; i++) for (const tr of S.tracks) { if (list[0].t - tr.last.t > C.REACQ || tr.last.t >= list[0].t - 1e-4) continue; const sc = matchScore(tr, list[i]); if (sc >= 0) pairs.push([sc, i, tr]); }
    pairs.sort((a, b) => b[0] - a[0]);
    const usedO = new Set(), usedT = new Set();
    for (const [, i, tr] of pairs) { if (usedO.has(i) || usedT.has(tr)) continue; usedO.add(i); usedT.add(tr); link(tr, list[i]); }
    list.forEach((o, i) => { if (!usedO.has(i)) { const tr = { id: L.nextId++, n: 0, ev: {}, total: 0, locked: null, lockT: null, recent: [], prev: null, last: null, switches: 0 }; S.tracks.push(tr); link(tr, o); } });
    if (S.tracks.length > 400) S.tracks = S.tracks.filter((tr) => list[0].t - tr.last.t <= 30);
  }
  function link(tr, o) { tr.prev = tr.last; tr.last = o; tr.n++; o.tr = tr; feed(tr, o); }
  function rebuild(S) {
    S.obs.sort((a, b) => a.t - b.t);
    S.tracks = []; for (const o of S.obs) o.tr = null;
    for (let i = 0; i < S.obs.length; ) { let j = i + 1; while (j < S.obs.length && S.obs[j].t - S.obs[i].t < 1e-4) j++; assignFrame(S, S.obs.slice(i, j)); i = j; }
    S.lastT = S.obs.length ? S.obs[S.obs.length - 1].t : -Infinity; S.dirty = false;
  }

  // ── evidence, lock and hysteresis ──
  function feed(tr, o) {
    tr.ev[o.name] = (tr.ev[o.name] || 0) + o.wt; tr.total += o.wt;
    tr.recent.push(o); while (tr.recent.length && o.t - tr.recent[0].t > C.SWITCH_SPAN) tr.recent.shift();
    const top = Object.keys(tr.ev).reduce((a, b) => (tr.ev[b] > tr.ev[a] ? b : a));
    if (!tr.locked) {
      if (tr.total >= C.LOCK_W && tr.ev[top] >= C.LOCK_SHARE * tr.total) { tr.locked = top; tr.lockT = o.t; }
      return;
    }
    if (o.name === tr.locked) return;
    // contrary: a different colour must hold a clear majority of the recent GOOD readings, for long enough
    const good = tr.recent.filter((r) => r.wt >= 0.25);
    let sum = 0, alt = 0, n = 0, t0 = Infinity, t1 = -Infinity;
    for (const r of good) { sum += r.wt; if (r.name === o.name) { alt += r.wt; n++; t0 = Math.min(t0, r.t); t1 = Math.max(t1, r.t); } }
    if (n >= C.SWITCH_N && t1 - t0 >= C.SWITCH_MIN_S && alt >= C.SWITCH_W && alt >= C.SWITCH_SHARE * sum) {
      tr.locked = o.name; tr.lockT = o.t; tr.switches++;
      // the old evidence was wrong: keep a little of it, so it can't snap back on one reading
      for (const k in tr.ev) tr.ev[k] *= 0.3; tr.ev[o.name] = (tr.ev[o.name] || 0) + alt; tr.total = Object.values(tr.ev).reduce((a, b) => a + b, 0);
    }
  }

  /** The colour to print for a reading's track: { name, locked, id, n }. Unlocked → the leading colour, provisional. */
  L.colourOf = (o) => {
    if (!o) return null;
    const S = L.cams[o.cam]; if (S && S.dirty) rebuild(S);
    const tr = o.tr; if (!tr) return { name: o.name, locked: false, id: null, n: 1 };
    if (tr.locked) return { name: tr.locked, locked: true, id: tr.id, n: tr.n };
    const top = Object.keys(tr.ev).reduce((a, b) => (tr.ev[b] > tr.ev[a] ? b : a));
    return { name: top, locked: false, id: tr.id, n: tr.n };
  };
  /** Same, for a box at (cam, t) without its reading at hand (search results, followed tracks): the nearest reading within
   *  ±win s overlapping the box (IoU ≥ 0.3), else null. */
  L.colourAt = (cam, t, box, win) => {
    const S = L.cams[cam]; if (!S || !box) return null;
    if (S.dirty) rebuild(S);
    win = win == null ? 0.75 : win;
    let best = null, bs = 0;
    for (const o of S.obs) { const dt = Math.abs(o.t - t); if (dt > win) continue; const v = iou(o, box); if (v < 0.3) continue; const s = v - dt * 0.3; if (s > bs) { bs = s; best = o; } }
    return best ? L.colourOf(best) : null;
  };
  /** Label word: the locked colour, or "~colour" while provisional (a subtle marker: still deciding). */
  L.word = (o) => { const c = L.colourOf(o); return c ? (c.locked ? c.name : "~" + c.name) : ""; };
  L.stats = () => { const out = {}; for (const cam in L.cams) { const S = L.cams[cam]; if (S.dirty) rebuild(S); out[cam] = { obs: S.obs.length, tracks: S.tracks.length, locked: S.tracks.filter((t) => t.locked).length }; } return out; };
  L.tracksOf = (cam) => { const S = L.cams[cam]; if (!S) return []; if (S.dirty) rebuild(S); return S.tracks; };

  if (typeof module !== "undefined" && module.exports) module.exports = L;
  if (typeof window !== "undefined") { root.TDC = root.TDC || {}; root.TDC.colorLock = L; }
})(typeof window !== "undefined" ? window : globalThis);
