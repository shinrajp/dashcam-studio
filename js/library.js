/* library.js — file intake (drop / picker / folders), classification, grouping into events, per-event prep. */
(function () {
  "use strict";
  const T = window.TDC;
  const TC = T.teslacam;

  const lib = (T.library = { items: new Map(), jsonByDir: {}, looseJson: new Map(), events: [], keyCache: new Map(), keyErrors: new Map() });

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
    let done = 0;
    const worker = async () => {
      while (todo.length) {
        const it = todo.shift();
        try {
          const head = new Uint8Array(await it.file.slice(0, T.crypto.PROBE).arrayBuffer());
          const c = T.crypto.classify(head, it.size);
          it.kind = c.kind; it.header = c.header || null; it.reason = c.reason || null;
          if (c.kind === "plain") it.blob = it.file;
        } catch (e) { it.kind = "unknown"; it.reason = String(e.message || e); }
        added++; done++;
        if (onProgress && (done & 15) === 0) onProgress(done);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    lib.regroup();
    return { added, events: lib.events };
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
      if (!it.requestId) it.requestId = "r" + (++reqSeq) + "-" + Math.random().toString(36).slice(2, 8);
      const h = it.header;
      out.push({ id: it.requestId, vin: h.vin, key_id: h.key_id, timestamp: h.timestamp, wrapped_key: h.wrapped_key, public_key: h.public_key });
    }
    return out;
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

  /** Decrypt every encrypted file that now has a key. */
  lib.decryptReady = async (onProgress) => {
    const todo = [...lib.items.values()].filter((it) => it.kind === "encrypted" && !it.blob && lib.keyCache.has(it.header.wrappedHex));
    let done = 0, failed = 0;
    for (const it of todo) {
      try {
        it.blob = await T.crypto.decryptFile(it.file, it.header.plaintext_size, lib.keyCache.get(it.header.wrappedHex), { name: it.name });
        it.decrypted = true;
      } catch (e) { it.decryptError = e.message; failed++; console.warn("decrypt failed", it.name, e); }
      done++;
      if (onProgress) onProgress(done, todo.length);
    }
    for (const ev of lib.events) { summarizeEvent(ev); ev.prepared = false; }
    T.emit("library");
    return { done, failed };
  };

  lib.clear = () => {
    lib.items.clear(); lib.jsonByDir = {}; lib.looseJson.clear(); lib.events = [];
    T.emit("library");
  };
})();
