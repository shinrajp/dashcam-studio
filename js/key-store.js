/* key-store.js — opt-in "Remember keys on this device" (OFF by default).
 * When on, each clip's 16-byte decryption key is saved in IndexedDB database "tdc-saved-keys" (separate from the
 * metadata index), keyed by the clip's wrapped-key fingerprint from its encrypted header (unique per file, so it
 * still matches if the folder is moved or renamed). Keys are saved whenever keys are applied by any route, and
 * re-applied automatically when a folder is opened. If IndexedDB fails, nothing is saved (old behaviour). */
(function () {
  "use strict";
  const T = window.TDC, lib = T.library;
  const PREF = "tdc.rememberKeys", DB = "tdc-saved-keys";
  const S = (T.keyStore = { available: false });
  let db = null;

  S.enabled = () => { try { return localStorage.getItem(PREF) === "1"; } catch (_) { return false; } };
  S.setEnabled = (v) => { try { localStorage.setItem(PREF, v ? "1" : "0"); } catch (_) {} };

  S.ready = (async () => {
    try {
      if (!window.indexedDB) throw new Error("no IndexedDB");
      db = await new Promise((res, rej) => {
        const q = indexedDB.open(DB, 1);
        q.onupgradeneeded = () => q.result.createObjectStore("keys", { keyPath: "id" });
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); q.onblocked = () => rej(new Error("blocked"));
        setTimeout(() => rej(new Error("timeout")), 4000);
      });
      S.available = true;
    } catch (e) { console.warn("Saved keys unavailable (IndexedDB)", e); db = null; S.available = false; }
    T.emit("keystore");
  })();

  const run = (mode, fn) => new Promise((res, rej) => {
    const t = db.transaction("keys", mode), st = t.objectStore("keys"); let out;
    const r = fn(st); if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
  S.count = async () => { await S.ready; if (!db) return 0; try { return await run("readonly", (s) => s.count()); } catch (_) { return 0; } };
  S.getAll = async () => { await S.ready; if (!db) return []; try { return await run("readonly", (s) => s.getAll()); } catch (_) { return []; } };

  /** Persist the keys currently in lib.keyCache (only when enabled). */
  S.saveCached = async (hexes) => {
    if (!S.enabled()) return 0;
    const myGen = gen;
    await S.ready; if (!db || myGen !== gen) return 0;
    const meta = new Map();
    for (const it of lib.items.values()) if (it.header && it.header.wrappedHex) meta.set(it.header.wrappedHex, it);
    const recs = [];
    for (const hex of hexes || lib.keyCache.keys()) {
      const k = lib.keyCache.get(hex); if (!k) continue;
      const it = meta.get(hex);
      recs.push({ id: hex, key: btoa(String.fromCharCode(...k)), name: it ? it.name : null, size: it ? it.size : null, savedAt: Date.now() });
    }
    if (!recs.length) return 0;
    if (myGen !== gen) return 0;
    try { await run("readwrite", (s) => { for (const r of recs) s.put(r); }); T.emit("keystore"); return recs.length; }
    catch (e) { console.warn("saving keys failed", e); return 0; }
  };

  /** Put saved keys for locked clips into lib.keyCache. Returns how many matched. */
  S.loadForLocked = async () => {
    if (!S.enabled()) return 0;
    await S.ready; if (!db) return 0;
    const want = new Set();
    for (const it of lib.items.values()) if (it.kind === "encrypted" && !it.blob && it.header && !lib.keyCache.has(it.header.wrappedHex)) want.add(it.header.wrappedHex);
    if (!want.size) return 0;
    let n = 0;
    try {
      const recs = await Promise.all([...want].map((id) => run("readonly", (s) => s.get(id))));
      for (const r of recs) {
        if (!r || typeof r.key !== "string") continue;
        const k = Uint8Array.from(atob(r.key), (c) => c.charCodeAt(0));
        if (k.length === 16) { lib.keyCache.set(r.id, k); n++; }
      }
    } catch (e) { console.warn("reading saved keys failed", e); }
    return n;
  };

  let gen = 0; // bumped by forget(); saves started before it are dropped
  /** Forget everything: saved keys, keys in this tab's memory, pending saves, clipboard auto-apply, and relock
   * clips that were decrypted with them. */
  S.forget = async () => {
    gen++;
    lib.keyCache.clear(); if (lib.keyErrors) lib.keyErrors.clear();
    for (const it of lib.items.values()) {
      delete it.keySource;
      if (it.kind === "encrypted" && it.blob) {
        if (it.url) { try { URL.revokeObjectURL(it.url); } catch (_) {} it.url = null; }
        it.blob = null; it.decrypted = false; it.info = null; it.infoFailed = null; it.decryptError = null;
      }
    }
    for (const ev of lib.events) { if (lib.summarizeEvent) lib.summarizeEvent(ev); ev.prepared = false; ev.keyNote = ev.encrypted ? "locked — keys forgotten" : null; }
    if (T.auth) T.auth.suppressClipboard = true; try { localStorage.setItem("tdc.noClipboardApply", "1"); } catch (_) {} // until the user copies the helper or applies keys again
    for (const id of ["pasteKeys", "inAppKeyText"]) { const el = document.getElementById(id); if (el) el.value = ""; }
    await S.ready;
    if (db) { try { await run("readwrite", (s) => s.clear()); } catch (e) { console.warn(e); } }
    T.emit("keystore"); T.emit("library");
    try { T.emit("unlocked", { done: 0, failed: 0, relocked: true }); } catch (_) {}
  };

  // ── hooks: save on every applyKeys route; auto-apply after every ingest ──
  const applyKeys = lib.applyKeys;
  lib.applyKeys = (results) => {
    const before = new Set(lib.keyCache.keys());
    const r = applyKeys(results);
    const added = [...lib.keyCache.keys()].filter((h) => !before.has(h));
    if (added.length) S.saveCached(added);
    return r;
  };
  /** After any route adds clips (file picker, folder, drag-drop, re-adding a removed event): use saved keys and
   * keys already known in this tab, decrypt, and note per event what happened. */
  lib.autoUnlock = async () => {
    const locked = () => [...lib.items.values()].filter((it) => it.kind === "encrypted" && !it.blob && it.header);
    const inMemory = new Set(locked().filter((it) => lib.keyCache.has(it.header.wrappedHex)).map((it) => it.header.wrappedHex));
    let fromStore = 0;
    try { fromStore = await S.loadForLocked(); } catch (e) { console.warn("saved keys lookup failed", e); }
    const ready = locked().filter((it) => lib.keyCache.has(it.header.wrappedHex));
    for (const it of ready) it.keySource = inMemory.has(it.header.wrappedHex) ? "session" : "saved";
    let d = { done: 0, failed: 0 };
    if (ready.length) d = await lib.decryptReady();
    for (const ev of lib.events) {
      let enc = 0, saved = 0, session = 0, failed = 0, missing = 0;
      for (const c of ev.clips) for (const it of Object.values(c.files)) {
        if (it.kind !== "encrypted") continue;
        enc++;
        if (it.decryptError && !it.blob) failed++;
        else if (it.keySource === "saved") saved++;
        else if (it.keySource === "session") session++;
        else if (!it.blob) missing++;
      }
      ev.keyNote = !enc ? null
        : failed ? `${failed} saved key(s) failed to decrypt`
        : saved && !missing ? "unlocked with saved keys"
        : session && !missing ? "unlocked with keys from this session"
        : missing && (saved || session) ? `${missing} clip(s) have no saved key`
        : missing && !S.available ? "locked (saved keys unavailable in this browser)"
        : missing && S.enabled() ? "no saved key match"
        : missing ? "locked (Remember keys is off)" : null;
    }
    T.emit("library");
    return { fromStore, reused: inMemory.size, decrypted: d.done - d.failed, failed: d.failed };
  };
  const ingest = lib.ingest;
  lib.ingest = async (list, onProgress) => {
    const r = await ingest(list, onProgress);
    try {
      const a = await lib.autoUnlock();
      r.autoUnlocked = a.decrypted;
      if (a.decrypted || a.failed) setTimeout(() => T.toast(`Unlocked ${a.decrypted} clip(s) with ${a.fromStore ? "keys saved on this device" : "keys already used in this tab"}${a.failed ? `, ${a.failed} failed` : ""}.`, a.failed ? "err" : "ok", 6000), 300);
    } catch (e) { console.warn("auto-apply saved keys failed", e); }
    return r;
  };
  // Per-event note in the event list. ui.js re-renders the list in several places, so re-apply on every render.
  function paintNotes() {
    const els = [...document.querySelectorAll("#libList .ev")];
    els.forEach((el, i) => {
      const ev = lib.events[i]; const old = el.querySelector(".saved-note");
      const want = ev && ev.keyNote ? "🔑 " + ev.keyNote : null;
      if (old && old.textContent === want) return;
      if (old) old.remove();
      if (!want) return;
      const n = document.createElement("div"); n.className = "saved-note"; n.textContent = want;
      n.style.cssText = "font-size:0.7rem;opacity:.75;margin-top:2px";
      (el.querySelector(".ev-main") || el).appendChild(n);
    });
  }
  // Keep the key controls reachable: ui.js hides the Unlock button once nothing is locked (original behaviour);
  // re-show it as "🔑 Keys" whenever keys are saved or encrypted clips are loaded.
  let savedN = 0;
  S.openDialog = () => { const m = document.getElementById("unlockModal"); if (m) m.hidden = false; };
  function updateKeysButton() {
    const btn = document.getElementById("btnUnlock"), txt = document.getElementById("btnUnlockText");
    if (!btn || !txt) return;
    const locked = lib.lockedCount ? lib.lockedCount() : 0;
    if (locked) return; // ui.js already shows "Unlock N encrypted files"
    const anyEnc = [...lib.items.values()].some((it) => it.kind === "encrypted");
    if (savedN > 0 || anyEnc) { btn.hidden = false; txt.textContent = savedN ? `🔑 Keys (${savedN} saved)` : "🔑 Keys"; }
    else btn.hidden = true;
  }
  S.refreshButton = async () => { try { savedN = S.available ? await S.count() : 0; } catch (_) { savedN = 0; } updateKeysButton(); };
  function watchList() {
    const list = document.getElementById("libList");
    if (list && window.MutationObserver) new MutationObserver(() => { try { paintNotes(); } catch (_) {} setTimeout(updateKeysButton, 0); }).observe(list, { childList: true });
    T.on("library", () => setTimeout(updateKeysButton, 0));
    T.on("keystore", S.refreshButton);
    S.ready.then(S.refreshButton);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchList); else watchList();
  // Keys applied by hand (console paste, keys file, connector, token): refresh the notes.
  T.on("unlocked", (d) => {
    if (d && d.relocked) { paintNotes(); return; }
    for (const ev of lib.events) {
      lib.summarizeEvent(ev);
      if (!ev.encrypted) continue;
      if (!ev.locked) ev.keyNote = !S.available ? "unlocked (keys not saved — storage blocked)" : S.enabled() ? "unlocked · keys saved on this device" : "unlocked (keys not saved — Remember keys is off)";
      else if (ev.locked < ev.encrypted) ev.keyNote = `${ev.locked} clip(s) still locked`;
    }
    paintNotes();
  });

  // ── UI in the Unlock dialog ──
  function init() {
    try {
      const host = document.getElementById("inAppKeys");
      if (!host) return;
      const box = document.createElement("div");
      box.id = "savedKeysBox";
      box.style.cssText = "margin-top:0.6rem;padding-top:0.5rem;border-top:1px solid rgba(127,127,127,.25);font-size:0.8rem";
      box.innerHTML = `<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="chkRememberKeys"> Remember keys on this device</label>
        <div class="fine" id="savedKeysInfo" style="margin:0.25rem 0"></div>
        <div class="btn-row"><button class="btn small ghost" id="btnForgetKeys" type="button">Forget saved keys</button></div>`;
      host.appendChild(box);
      const chk = document.getElementById("chkRememberKeys"), info = document.getElementById("savedKeysInfo");
      const refresh = async () => {
        chk.checked = S.enabled();
        await S.ready;
        if (!S.available) { chk.disabled = true; info.textContent = "Not available in this browser (storage blocked) — keys are used for this session only."; return; }
        const n = await S.count();
        info.textContent = (S.enabled() ? "On: " : "Off: ") + `${n} key(s) saved on this device. Keys stay in this browser only; anyone using this browser profile could unlock these clips. "Clear index" does not remove saved keys.`;
      };
      chk.addEventListener("change", async () => {
        S.setEnabled(chk.checked);
        if (chk.checked) { await S.saveCached(); }
        else if ((await S.count()) && confirm("Stop remembering keys. Also forget the keys already saved on this device?")) await S.forget();
        refresh();
      });
      document.getElementById("btnForgetKeys").addEventListener("click", async () => {
        if (!confirm("Forget all keys? This removes keys saved on this device AND keys used in this tab, stops auto-applying keys from the clipboard, and re-locks clips already unlocked. You will need to supply keys again. Your video files are not touched.")) return;
        await S.forget(); T.toast("Saved keys forgotten", "ok"); refresh();
      });
      T.on("keystore", refresh);
      setTimeout(() => { const bar = document.getElementById("libIndexBar") || document.getElementById("library");
      if (bar) { const c = document.createElement("span"); c.id = "savedKeyCount"; c.style.cssText = "font-size:0.75rem;opacity:.8;cursor:pointer;text-decoration:underline dotted";
          c.setAttribute("role", "button"); c.tabIndex = 0; c.title = "Open key settings (Remember keys / Forget saved keys)";
          c.addEventListener("click", S.openDialog); c.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); S.openDialog(); } }); bar.appendChild(c);
        const upd = async () => { c.textContent = !S.available ? "🔑 keys not saved (storage blocked)" : `🔑 ${await S.count()} saved key(s)${S.enabled() ? "" : " · remembering off"}`; };
        T.on("keystore", upd); S.ready.then(upd); chk.addEventListener("change", () => setTimeout(upd, 300)); } }, 0);
      refresh();
    } catch (e) { console.warn("saved keys UI disabled", e); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
