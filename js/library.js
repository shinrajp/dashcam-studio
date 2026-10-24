/* library.js — file intake (drop / picker / folders), classification, grouping into events, per-event prep. */
(function () {
  "use strict";
  const T = window.TDC;
  const TC = T.teslacam;

  const lib = (T.library = { readTimeout: 30000, items: new Map(), jsonByDir: {}, looseJson: new Map(), events: [], keyCache: new Map(), keyErrors: new Map() });

  // ── reading dropped folders ──
  async function walkEntry(entry, out, depth) {
    if (!entry || depth > 12) return;
    if (entry.isFile) {
      const file = await new Promise((res) => entry.file(res, () => res(null)));
      if (file) out.push({ file, path: entry.fullPath.replace(/^\//, "") });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
      if (!batch.length) break;
      for (const e of batch) await walkEntry(e, out, depth + 1);
    }
  }
  lib.filesFromDataTransfer = async (dt) => {
    const out = [];
    const entries = [];
    if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
      for (const it of dt.items) { const e = it.kind === "file" && it.webkitGetAsEntry(); if (e) entries.push(e); }
    }
    if (entries.length) { for (const e of entries) await walkEntry(e, out, 0); }
    else for (const f of dt.files || []) out.push({ file: f, path: f.name });
    return out;
  };
  lib.filesFromInput = (input) => Array.from(input.files || []).map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));

  const isVideo = (n) => /\.(mp4|mov|m4v)$/i.test(n);

  /** Add files; returns { added, events }. */
  lib.ingest = async (list, onProgress) => {
    let added = 0;
    const todo = [];
    for (const { file, path } of list) {
      const name = TC.baseName(path);
      if (/^event\.json$/i.test(name)) {
        try {
          const txt = await file.text(), j = JSON.parse(txt), dir = TC.dirOf(path);
          // No folder path (multi-file picker / single dropped files): several event.json files share the
          // name, so keep them all and let grouping match each one to its event by timestamp.
          if (dir) lib.jsonByDir[dir] = j; else lib.looseJson.set(txt.trim(), j);
        } catch (_) {}
        continue;
      }
      if (!isVideo(name) || name.startsWith("._")) continue; // skip macOS resource forks
      const key = path + "|" + file.size;
      if (lib.items.has(key)) continue;
      const it = { key, path, name, size: file.size, file, kind: "pending", blob: null, info: null };
      lib.items.set(key, it);
      todo.push(it);
    }
    let done = 0, unreadable = 0, firstReason = "";
    const total = todo.length;
    if (onProgress) onProgress(0, total);
    const worker = async () => {
      while (todo.length) {
        const it = todo.shift();
        try {
          // bounded read: a file the phone cannot deliver (cloud file not downloaded, network drive) fails with a message, never hangs
          const head = await T.crypto.readSlice(it.file, 0, T.crypto.PROBE, lib.readTimeout);
          const c = T.crypto.classify(head, it.size);
          it.kind = c.kind; it.header = c.header || null; it.reason = c.reason || null;
          if (c.kind === "plain") it.blob = it.file;
        } catch (e) { it.kind = "unknown"; it.reason = String(e.message || e); unreadable++; if (!firstReason) firstReason = it.reason; }
        added++; done++;
        if (onProgress) onProgress(done, total);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    lib.regroup();
    return { added, events: lib.events, unreadable, firstReason };
  };

  lib.regroup = () => {
    const prev = new Map(lib.events.map((e) => [e.id, e]));
    const items = [...lib.items.values()].filter((it) => it.kind !== "unknown" && it.kind !== "empty");
    const events = TC.group(items, lib.jsonByDir, undefined, [...lib.looseJson.values()]);
    for (const ev of events) {
      const old = prev.get(ev.id);
      ev.exported = old ? old.exported : null;
      ev.clips.forEach((c, i) => { c.index = i; c.dur = c.dur || 60; });
      layout(ev);
      ev.prepared = false;
      summarizeEvent(ev);
    }
    lib.events = events;
    T.emit("library");
  };

  function filesOf(ev) {
    const out = [];
    for (const c of ev.clips || []) for (const it of Object.values(c.files || {})) if (it) out.push(it);
    return out;
  }
  function dropUrl(it) {
    if (it && it.url) { try { URL.revokeObjectURL(it.url); } catch (_) {} it.url = null; }
  }
  /** Remove one event from the list. Does not delete files on disk. */
  lib.removeEvent = (id) => {
    const ev = lib.events.find((e) => e.id === id);
    if (!ev) return false;
    const keys = new Set(filesOf(ev).map((it) => it.key));
    for (const it of lib.items.values()) if (keys.has(it.key)) { dropUrl(it); lib.items.delete(it.key); }
    if (ev.dir && ![...lib.items.values()].some((it) => TC.dirOf(it.path) === ev.dir)) delete lib.jsonByDir[ev.dir];
    lib.regroup();
    return true;
  };
  /** Drop every loaded event and go back to an empty library. */
  lib.clear = () => {
    for (const it of lib.items.values()) dropUrl(it);
    lib.items.clear();
    for (const k of Object.keys(lib.jsonByDir)) delete lib.jsonByDir[k];
    lib.looseJson.clear();
    lib.events = [];
    T.emit("library");
  };

  function layout(ev) {
    let s = 0;
    for (const c of ev.clips) { c.start = s; s += c.dur; }
    ev.duration = s;
  }

  function summarizeEvent(ev) {
    let enc = 0, locked = 0, broken = 0, files = 0, bytes = 0;
    for (const c of ev.clips) for (const it of Object.values(c.files)) {
      files++; bytes += it.size || 0;
      if (it.kind === "encrypted") { enc++; if (!it.blob) locked++; }
      if (it.kind === "undecryptable") broken++;
    }
    Object.assign(ev, { encrypted: enc, locked, broken, fileCount: files, bytes });
  }
  lib.summarizeEvent = summarizeEvent;

  /** Demux every playable file of an event (durations, codec, native sizes). Idempotent. */
  lib.prepare = async (ev) => {
    const jobs = [];
    for (const c of ev.clips) for (const it of Object.values(c.files)) if (it.blob && !it.info && !it.infoFailed) jobs.push(it);
    const worker = async () => {
      while (jobs.length) {
        const it = jobs.shift();
        try { it.info = await T.mp4.demux(T.blobReader(it.blob)); }
        catch (e) { it.infoFailed = String(e.message || e); console.warn("demux failed", it.name, e); }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const knownDur = [];
    for (const c of ev.clips) {
      const durs = Object.values(c.files).filter((it) => it.info).map((it) => it.info.duration);
      if (durs.length) { c.dur = Math.max(...durs); knownDur.push(c.dur); }
    }
    for (const c of ev.clips) if (!Object.values(c.files).some((it) => it.info)) c.dur = knownDur.length ? knownDur[0] : 60;
    layout(ev);
    // native sizes per camera (largest seen)
    ev.sizes = {};
    let fps = 0;
    for (const c of ev.clips) for (const [cam, it] of Object.entries(c.files)) {
      if (!it.info) continue;
      const s = ev.sizes[cam];
      if (!s || it.info.width * it.info.height > s.w * s.h) ev.sizes[cam] = { w: it.info.width, h: it.info.height };
      fps = Math.max(fps, it.info.fps || 0);
    }
    ev.fps = fps || 36;
    ev.tile = tileSize(ev);
    summarizeEvent(ev);
    ev.prepared = true;
    return ev;
  };

  /** Native tile size: the most common camera resolution (side cameras), plus the largest one. */
  function tileSize(ev) {
    const list = Object.values(ev.sizes || {});
    if (!list.length) return { w: 1280, h: 960, maxW: 1280, maxH: 960 };
    const counts = new Map();
    for (const s of list) { const k = s.w + "x" + s.h; counts.set(k, (counts.get(k) || 0) + 1); }
    const common = [...counts.entries()].sort((a, b) => b[1] - a[1] || parseInt(a[0]) - parseInt(b[0]))[0][0].split("x").map(Number);
    const max = list.reduce((a, s) => (s.w * s.h > a.w * a.h ? s : a), list[0]);
    return { w: common[0], h: common[1], maxW: max.w, maxH: max.h };
  }

  // ── encryption ──
  let reqSeq = 0;
  lib.pendingKeyItems = () => {
    const seen = new Set(), out = [];
    for (const it of lib.items.values()) {
      if (it.kind !== "encrypted" || it.blob || lib.keyCache.has(it.header.wrappedHex)) continue;
      if (seen.has(it.header.wrappedHex)) continue;
      seen.add(it.header.wrappedHex);
      if (!it.requestId) {
        // The header id should be unique per file; if two different files share it, give this one its own id
        // so keys can't be mixed up and session batching doesn't drop it.
        const hid = it.header && it.header.id;
        const clash = hid && [...lib.items.values()].some((o) => o !== it && o.requestId === hid && o.header && o.header.wrappedHex !== it.header.wrappedHex);
        it.requestId = (hid && !clash) ? hid : ("r" + (++reqSeq) + "-" + Math.random().toString(36).slice(2, 8));
      }
      const h = it.header;
      out.push({ id: it.requestId, vin: h.vin, key_id: h.key_id, timestamp: h.timestamp, wrapped_key: h.wrapped_key, public_key: h.public_key });
    }
    return out;
  };
  /** Session-aware batches (≤ T.batching.MAX_PER_BATCH key requests each, whole 4/6-angle sessions together). */
  lib.pendingKeyBatches = (max) => {
    const reqs = lib.pendingKeyItems();
    if (!T.batching) return reqs.length ? [reqs] : [];
    const byId = new Map(reqs.map((r) => [r.id, r]));
    const entries = [];
    for (const it of lib.items.values()) if (it.requestId && byId.has(it.requestId)) { entries.push({ path: it.path, request: byId.get(it.requestId) }); byId.delete(it.requestId); }
    for (const r of byId.values()) entries.push({ path: "", request: r }); // never drop a request
    return T.batching.planBatches(entries, max).map((b) => b.entries.map((e) => e.request));
  };
  lib.lockedCount = () => [...lib.items.values()].filter((it) => it.kind === "encrypted" && !it.blob).length;

  /** Store key results [{id|wrapped_key, key | error}] → counts. */
  lib.applyKeys = (results) => {
    const out = { applied: 0, errors: 0, invalid: 0 };
    if (!Array.isArray(results)) return { ...out, invalid: 1 };
    const byReq = new Map([...lib.items.values()].filter((it) => it.requestId).map((it) => [it.requestId, it.header.wrappedHex]));
    for (const r of results.slice(0, 5000)) {
      if (!r || typeof r !== "object") { out.invalid++; continue; }
      let hex = typeof r.id === "string" ? byReq.get(r.id) : null;
      if (!hex && typeof r.wrapped_key === "string") { const w = T.crypto.unb64(r.wrapped_key); if (w && w.length === 44) hex = T.crypto.toHex(w); }
      if (!hex) { out.invalid++; continue; }
      if (r.error) { lib.keyErrors.set(hex, String(r.error.message || r.error).slice(0, 160)); out.errors++; continue; }
      const key = T.crypto.unb64(r.key);
      if (!key || key.length !== 16) { out.invalid++; continue; }
      lib.keyCache.set(hex, key);
      out.applied++;
    }
    return out;
  };

  /** Decrypt every encrypted file that now has a key. Reports progress three ways: onProgress(done, total, info), the
   *  "decrypt" bus event, and lib.decryptInfo. info = {done,total,bytes,totalBytes,mbps,eta,mode,fast,name}. Without Web Crypto
   *  (plain http) the work runs in worker lanes when the device has spare cores, 2-3 files at once; otherwise one file at a
   *  time with yields so the page keeps painting. */
  lib.decryptReady = async (onProgress) => {
    const todo = [...lib.items.values()].filter((it) => it.kind === "encrypted" && !it.blob && lib.keyCache.has(it.header.wrappedHex));
    const total = todo.length, queue = todo.slice();
    const totalBytes = todo.reduce((a, it) => a + (it.header.plaintext_size || 0), 0);
    const got = new Map(); let done = 0, failed = 0, lastEmit = 0, mode = "";
    const t0 = performance.now();
    const info = (name, force) => {
      const bytes = [...got.values()].reduce((a, v) => a + v, 0), sec = Math.max(0.001, (performance.now() - t0) / 1000), mbps = bytes / 1048576 / sec;
      const i = { done, total, name: name || "", bytes, totalBytes, mbps, eta: mbps > 0.05 && bytes > 0 ? Math.max(0, (totalBytes - bytes) / 1048576 / mbps) : null, mode, fast: T.crypto.fast };
      const t = performance.now();
      if (force || t - lastEmit > 150) { lastEmit = t; lib.decryptInfo = i; T.emit("decrypt", i); }
      return i;
    };
    if (total) info("", true);
    const conc = Math.min(total, T.crypto.concurrency());
    const run = async () => {
      while (queue.length) {
        const it = queue.shift();
        try {
          it.blob = await T.crypto.decryptFile(it.file, it.header.plaintext_size, lib.keyCache.get(it.header.wrappedHex), {
            name: it.name,
            onMode: (m) => { mode = m; },
            onProgress: (f) => { got.set(it, f * (it.header.plaintext_size || 0)); info(it.name); },
          });
          it.decrypted = true; got.set(it, it.header.plaintext_size || 0);
        } catch (e) { it.decryptError = e.message; failed++; console.warn("decrypt failed", it.name, e); }
        done++;
        const i = info(it.name, true);
        if (onProgress) onProgress(done, total, i);
        await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive on big libraries
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, conc) }, run));
    for (const ev of lib.events) { summarizeEvent(ev); ev.prepared = false; }
    if (total) T.emit("decrypt", { ...info("", true), finished: true });
    T.emit("library");
    return { done, failed };
  };

  lib.clear = () => {
    lib.items.clear(); lib.jsonByDir = {}; lib.looseJson.clear(); lib.events = [];
    T.emit("library");
  };
})();
