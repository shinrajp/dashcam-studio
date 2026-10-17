/* lib-index.js — persistent metadata index of the TeslaCam library (Phase 3).
 * Stores ONLY metadata in IndexedDB (path, name, size, timestamp, camera count, event id, decrypted status,
 * reviewed flag) — never video or keys. If IndexedDB is missing, blocked or corrupt, it silently falls back
 * to an in-memory map for this session and the rest of the app behaves exactly as before. */
(function () {
  "use strict";
  const T = window.TDC;
  const DB = "tdc-library-index", VER = 1;
  const X = (T.libIndex = { mode: "memory", events: new Map(), filter: "all", lastScan: null });
  let db = null;

  function open() {
    return new Promise((res, rej) => {
      let req;
      try { req = indexedDB.open(DB, VER); } catch (e) { return rej(e); }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("events")) d.createObjectStore("events", { keyPath: "id" });
        if (!d.objectStoreNames.contains("files")) d.createObjectStore("files", { keyPath: "key" });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
      req.onblocked = () => rej(new Error("IndexedDB blocked"));
      setTimeout(() => rej(new Error("IndexedDB open timeout")), 4000);
    });
  }
  const tx = (store, mode, fn) => new Promise((res, rej) => {
    const t = db.transaction(store, mode); const s = t.objectStore(store); let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error("aborted"));
  });
  const getAll = (store) => tx(store, "readonly", (s) => new Promise((r, j) => { const q = s.getAll(); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); }));

  function degrade(e) { if (X.mode !== "memory") console.warn("Library index: IndexedDB unavailable, using memory only", e); X.mode = "memory"; db = null; }

  X.ready = (async () => {
    try {
      if (!("indexedDB" in window) || !window.indexedDB) throw new Error("no IndexedDB");
      db = await open();
      for (const e of await getAll("events")) X.events.set(e.id, e);
      X.mode = "indexeddb";
    } catch (e) { degrade(e); }
    T.emit("libindex");
  })();

  /** Status of an event from its loaded state. */
  function statusOf(ev) {
    if (!ev.encrypted) return "plain";
    return ev.locked ? "undecrypted" : "decrypted";
  }
  function recordOf(ev) {
    const old = X.events.get(ev.id) || {};
    const files = [];
    for (const c of ev.clips) for (const it of Object.values(c.files)) files.push({ key: it.key, path: it.path, name: it.name, size: it.size || 0, lastModified: (it.file && it.file.lastModified) || 0, cam: it.cam, stamp: c.stamp, kind: it.kind, decrypted: !!it.decrypted, eventId: ev.id });
    return {
      id: ev.id, time: ev.time || null, label: ev.trigger ? ev.trigger.label : "", source: ev.source, dir: ev.dir,
      cameraCount: (ev.cams || []).length, angles: (ev.cams || []).some((c) => /pillar/.test(c)) ? 6 : (ev.cams || []).length >= 4 ? 4 : (ev.cams || []).length,
      clips: ev.clips.length, fileCount: ev.fileCount || files.length, bytes: ev.bytes || 0,
      encrypted: ev.encrypted || 0, locked: ev.locked || 0,
      status: statusOf(ev) === "plain" ? "plain" : (statusOf(ev) === "decrypted" || old.everDecrypted) ? "decrypted" : "undecrypted",
      everDecrypted: !!(old.everDecrypted || (ev.encrypted && !ev.locked)),
      reviewed: !!old.reviewed, firstSeen: old.firstSeen || Date.now(), lastSeen: Date.now(), files,
    };
  }
  const sig = (r) => [r.fileCount, r.bytes, r.locked, r.encrypted, r.status, r.reviewed].join("|");

  /** Incremental update: only events whose signature changed are written. Returns { added, changed, unchanged }. */
  X.sync = async (events) => {
    const stats = { added: 0, changed: 0, unchanged: 0 };
    const dirty = [];
    for (const ev of events || []) {
      const r = recordOf(ev), old = X.events.get(ev.id);
      if (!old) stats.added++; else if (sig(old) !== sig(r)) stats.changed++; else { stats.unchanged++; continue; }
      X.events.set(ev.id, r); dirty.push(r);
    }
    if (dirty.length && db) {
      try { await tx("events", "readwrite", (s) => { for (const r of dirty) s.put(r); }); }
      catch (e) { degrade(e); }
    }
    X.lastScan = stats;
    if (dirty.length) T.emit("libindex");
    return stats;
  };

  X.isKnownFile = (path, size) => { for (const e of X.events.values()) if (e.files && e.files.some((f) => f.path === path && f.size === size)) return true; return false; };

  X.setReviewed = async (id, v) => {
    const r = X.events.get(id); if (!r) return;
    r.reviewed = !!v;
    if (db) try { await tx("events", "readwrite", (s) => s.put(r)); } catch (e) { degrade(e); }
    T.emit("libindex");
  };

  X.clear = async () => {
    X.events.clear();
    if (db) try { await tx("events", "readwrite", (s) => s.clear()); await tx("files", "readwrite", (s) => s.clear()); } catch (e) { degrade(e); }
    T.emit("libindex");
  };

  // ── Phase 6: plate & street-text index (metadata only: text, time, camera, box, confidence — never video or images).
  // Kept in its own IndexedDB database ("tdc-text-index") so the events database version stays 1 for older builds.
  // If IndexedDB fails, scans live in memory for this session only.
  const TX = (X.text = { mode: "memory", scans: new Map() });
  let tdb = null;
  const topen = () => new Promise((res, rej) => {
    let req; try { req = indexedDB.open("tdc-text-index", 1); } catch (e) { return rej(e); }
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains("scans")) req.result.createObjectStore("scans", { keyPath: "eventId" }); };
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); req.onblocked = () => rej(new Error("IndexedDB blocked"));
    setTimeout(() => rej(new Error("IndexedDB open timeout")), 4000);
  });
  const ttx = (mode, fn) => new Promise((res, rej) => { const t = tdb.transaction("scans", mode); const st = t.objectStore("scans"); let out; Promise.resolve(fn(st)).then((v) => { out = v; }); t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error("aborted")); });
  const tdegrade = (e) => { if (TX.mode !== "memory") console.warn("Text index: IndexedDB unavailable, memory only", e); TX.mode = "memory"; tdb = null; };
  TX.ready = (async () => {
    try {
      if (!("indexedDB" in window) || !window.indexedDB) throw new Error("no IndexedDB");
      tdb = await topen();
      const all = await ttx("readonly", (st) => new Promise((r, j) => { const q = st.getAll(); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); }));
      for (const sc of all || []) TX.scans.set(sc.eventId, sc);
      TX.mode = "indexeddb";
    } catch (e) { tdegrade(e); }
  })();
  /** scan = { eventId, at, cams:[], step, model, items:[{kind:"plate"|"text", text, raw, conf, det, chars, cam, t, box}] } */
  TX.put = async (scan) => {
    TX.scans.set(scan.eventId, scan);
    if (tdb) try { await ttx("readwrite", (st) => st.put(scan)); } catch (e) { tdegrade(e); }
    T.emit && T.emit("textindex");
  };
  TX.get = (eventId) => TX.scans.get(eventId) || null;
  TX.all = () => [...TX.scans.values()];
  TX.count = () => TX.all().reduce((n, sc) => n + (sc.items ? sc.items.length : 0), 0);
  TX.clear = async () => {
    TX.scans.clear();
    if (tdb) try { await ttx("readwrite", (st) => st.clear()); } catch (e) { tdegrade(e); }
    T.emit && T.emit("textindex");
  };
  /** Search every indexed event. match(item) → score (0 = no). Returns [{eventId, item, score}] best first. */
  TX.search = (match, onlyEvent) => {
    const out = [];
    for (const sc of TX.scans.values()) {
      if (onlyEvent && sc.eventId !== onlyEvent) continue;
      for (const it of sc.items || []) { const s = match(it); if (s > 0) out.push({ eventId: sc.eventId, item: it, score: s }); }
    }
    return out.sort((a, b) => b.score - a.score || b.item.conf - a.item.conf);
  };

  X.matches = (rec, filter) => filter === "undecrypted" ? rec.status === "undecrypted" : filter === "decrypted" ? rec.status === "decrypted" : true;
  X.list = (filter) => [...X.events.values()].filter((r) => X.matches(r, filter || X.filter)).sort((a, b) => (b.time || 0) - (a.time || 0));
})();
