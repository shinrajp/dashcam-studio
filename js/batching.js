/* batching.js — session-aware batching of Tesla key requests (pure functions; browser + Node).
 * A "session" is one clip timestamp in one folder: 4 files (older cars: front/back/repeaters) or 6 (adds pillars).
 * planBatches packs whole sessions into batches of at most maxPerBatch key requests so Tesla's
 * /api/1/decrypt/batch endpoint is never sent more than its limit in one call. */
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else { root.TDC = root.TDC || {}; root.TDC.batching = m; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const MAX_PER_BATCH = 30;
  const NAME_RE = /(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-(front|back|rear|left_repeater|right_repeater|left_pillar|right_pillar)\.mp4$/i;
  const SIX = ["left_pillar", "right_pillar"];

  /** { stamp, cam } from a Tesla file name, or null. */
  function parse(name) {
    const m = NAME_RE.exec(String(name || "").split(/[\\/]/).pop());
    return m ? { stamp: m[1], cam: m[2].toLowerCase() === "rear" ? "back" : m[2].toLowerCase() } : null;
  }
  const dirOf = (p) => { const s = String(p || "").replace(/\\/g, "/"); const i = s.lastIndexOf("/"); return i < 0 ? "" : s.slice(0, i); };

  /** 6 when any pillar camera is present, 4 when only front/back/repeaters, else the count seen. */
  function angleCount(cams) {
    const set = new Set(cams);
    if (SIX.some((c) => set.has(c))) return 6;
    if (set.size && [...set].every((c) => ["front", "back", "left_repeater", "right_repeater"].includes(c))) return 4;
    return set.size;
  }

  /** entries: [{ path, request }] → sessions [{ key, dir, stamp, angles, entries }] sorted by folder then time. */
  function sessionsOf(entries) {
    const map = new Map();
    for (const e of entries) {
      const p = parse(e.path);
      const key = dirOf(e.path) + "|" + (p ? p.stamp : "loose:" + e.path);
      if (!map.has(key)) map.set(key, { key, dir: dirOf(e.path), stamp: p ? p.stamp : null, cams: [], entries: [] });
      const s = map.get(key);
      if (p) s.cams.push(p.cam);
      s.entries.push(e);
    }
    const out = [...map.values()];
    for (const s of out) s.angles = angleCount(s.cams);
    out.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : String(a.stamp) < String(b.stamp) ? -1 : 1));
    return out;
  }

  /** Pack whole sessions into batches of ≤ max entries; a session is only split if it alone exceeds max. */
  function planBatches(entries, max) {
    max = Math.max(1, Math.min(max || MAX_PER_BATCH, 500));
    const batches = [];
    let cur = [], sess = [];
    const flush = () => { if (cur.length) batches.push({ entries: cur, sessions: sess }); cur = []; sess = []; };
    for (const s of sessionsOf(entries)) {
      if (s.entries.length > max) {
        flush();
        for (let i = 0; i < s.entries.length; i += max) batches.push({ entries: s.entries.slice(i, i + max), sessions: [s.key], split: true });
        continue;
      }
      if (cur.length + s.entries.length > max) flush();
      cur = cur.concat(s.entries); sess.push(s.key);
    }
    flush();
    return batches;
  }

  /** Run batches one after another; per-batch errors are collected, never thrown. */
  async function runSequential(batches, send, onProgress) {
    const results = [], errors = [];
    for (let i = 0; i < batches.length; i++) {
      try {
        const r = await send(batches[i], i);
        if (Array.isArray(r)) results.push(...r);
      } catch (e) {
        errors.push({ batch: i + 1, of: batches.length, files: batches[i].entries.length, error: String((e && e.message) || e).slice(0, 300) });
      }
      if (onProgress) onProgress(i + 1, batches.length, errors.length);
      await new Promise((res) => setTimeout(res, 0)); // let the UI breathe between batches
    }
    return { results, errors };
  }

  return { MAX_PER_BATCH, parse, angleCount, sessionsOf, planBatches, runSequential };
});
