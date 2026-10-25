/* model-picker.js — "Choose model file…" for the optional YOLO11 medium model (AGPL-3.0, so it is not shipped with the app).
 * The user picks yolo11m.onnx from their device once; the file is kept in this browser's IndexedDB (as a Blob: it is only read
 * into memory when the detection worker starts the model) and handed to the worker on load (Blob → structured clone, no copy).
 * It lives in its own database ("tdc-user-models"), outside the service worker's caches, so app updates never remove it.
 * Nothing is uploaded. If IndexedDB refuses (private mode, no quota) the file still works until the page is closed. */
(function () {
  "use strict";
  const T = (window.TDC = window.TDC || {});
  const DB = "tdc-user-models", ST = "m", MIN_BYTES = 10 * 1048576;
  const KNOWN = { medium: { file: "yolo11m.onnx", sha256: "cae48f8e2f78e2e5d91e47daab545258cc5f7720fe5c97eb83faaa4aca6297a4" } };
  const MSG = "YOLO11 medium isn't included in the app (it's an optional AGPL model). Choose the yolo11m.onnx file from your device.";
  const session = {};   // name → { blob, meta } kept in memory when IndexedDB can't store it
  const mb = (n) => (n / 1e6).toFixed(1) + " MB";   // decimal MB, like the 80.7 MB in the docs

  function idb() {
    return new Promise((res, rej) => {
      try { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(ST); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error || new Error("IndexedDB error")); r.onblocked = () => rej(new Error("IndexedDB blocked")); }
      catch (e) { rej(e); }
    });
  }
  const req = (db, mode, fn) => new Promise((res, rej) => { try { const tx = db.transaction(ST, mode); let out; const q = fn(tx.objectStore(ST)); if (q) q.onsuccess = () => { out = q.result; }; tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error || new Error("IndexedDB write failed")); tx.onabort = () => rej(tx.error || new Error("IndexedDB write aborted (storage full?)")); } catch (e) { rej(e); } });

  const MS = (T.modelStore = {
    KNOWN, MSG, MIN_BYTES,
    /** { name, size, lastModified, added, sha256?, sessionOnly? } or null */
    async meta(name) {
      try { const db = await idb(); const m = await req(db, "readonly", (s) => s.get(name + ":meta")); db.close(); if (m) return m; } catch (_) { /* fall through */ }
      return session[name] ? session[name].meta : null;
    },
    /** the stored Blob (a handle: bytes are not read into memory here; an ArrayBuffer on browsers that can't store Blobs) or null */
    async blob(name) {
      try { const db = await idb(); const b = await req(db, "readonly", (s) => s.get(name + ":blob")); db.close(); if (b) return b; } catch (_) { /* fall through */ }
      return session[name] ? session[name].blob : null;
    },
    async put(name, file) {
      const meta = { name: file.name, size: file.size, lastModified: file.lastModified || 0, added: Date.now(), kind: "blob" };
      delete session[name];
      try {
        const db = await idb();
        try {
          try { await req(db, "readwrite", (s) => { s.put(file.slice(0, file.size, "application/octet-stream"), name + ":blob"); s.put(meta, name + ":meta"); }); }
          catch (e1) {   // some WebKit builds can't keep a Blob in IndexedDB: keep the bytes as an ArrayBuffer instead (one extra copy in memory, once)
            console.warn("model-picker: Blob not storable, trying an ArrayBuffer", e1);
            meta.kind = "buffer"; const ab = await file.arrayBuffer();
            await req(db, "readwrite", (s) => { s.put(ab, name + ":blob"); s.put(meta, name + ":meta"); });
          }
        } finally { db.close(); }
        try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (_) {}
        return meta;
      } catch (e) {
        meta.sessionOnly = true; meta.kind = "blob"; session[name] = { blob: file, meta };   // works until the page is closed
        console.warn("model-picker: couldn't store the file, keeping it for this session only", e);
        return meta;
      }
    },
    async remove(name) {
      delete session[name];
      try { const db = await idb(); try { await req(db, "readwrite", (s) => { s.delete(name + ":blob"); s.delete(name + ":meta"); }); } finally { db.close(); } } catch (_) {}
    },
    /** SHA-256 of a file, or null when this page has no crypto.subtle (plain http) */
    async sha256(file) {
      try { if (!(window.crypto && crypto.subtle && file.arrayBuffer)) return null; const h = await crypto.subtle.digest("SHA-256", await file.arrayBuffer()); return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0")).join(""); }
      catch (_) { return null; }
    },
    /** does this look like "model not found / not there" (as opposed to a broken file)? */
    isMissing(e) { return /HTTP 40[34]|Failed to fetch|NetworkError|Load failed|not stored|No model URL|couldn't fetch/i.test((e && e.message) || String(e || "")); },
  });

  // ── Settings panel under the Model row (only while "YOLO11 medium" is selected) ──
  let failed = false, busy = "", note = "", warn = "";
  MS.noteFailure = (flag) => { failed = !!flag; };
  const probeCache = {};
  async function sameOrigin() {   // is models/yolo11m.onnx served next to the app? (HEAD only; a page that answers with HTML doesn't count)
    const url = new URL("models/yolo11m.onnx", location.href).href;
    if (probeCache[url] !== undefined) return probeCache[url];
    let ok = false;
    try { const r = await fetch(url, { method: "HEAD", cache: "no-store" }); ok = r.ok && !/text\/html/i.test(r.headers.get("content-type") || "") && (+r.headers.get("content-length") || MIN_BYTES) >= MIN_BYTES; } catch (_) {}
    return (probeCache[url] = ok);
  }
  MS.render = async function (panel) {
    if (!panel) return;
    const D = T.detect, meta = await MS.meta("medium"), here = meta ? false : await sameOrigin();
    if (!panel.isConnected) return;
    panel.innerHTML = "";
    const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt) n.textContent = txt; return n; };
    const line = el("div", "hint"); line.id = "medState"; line.style.display = "block";
    if (busy) line.textContent = busy;
    else if (meta) line.textContent = "Stored on this device: " + meta.name + ", " + mb(meta.size) + (meta.sessionOnly ? " (this browser wouldn't keep it: it works until you close the page)" : "") + ".";
    else if (here) line.textContent = "Using models/yolo11m.onnx from this site. You can also choose a file from your device.";
    else line.textContent = failed ? MSG : "YOLO11 medium needs a file from you: it's an optional AGPL model that isn't included in the app. Choose yolo11m.onnx from your device (once per device).";
    panel.appendChild(line);
    if (note) { const n = el("div", "hint", note); n.id = "medNote"; n.style.display = "block"; panel.appendChild(n); }
    if (warn) { const n = el("div", "hint", warn); n.id = "medWarn"; n.style.display = "block"; panel.appendChild(n); }
    const bar = el("div"); bar.style.cssText = "display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:.35rem 0";
    const pick = el("label", "btn ghost", meta ? "Replace model file…" : "Choose model file…"); pick.id = "medChoose"; pick.style.cursor = "pointer";
    const inp = document.createElement("input"); inp.type = "file"; inp.id = "medFile"; inp.accept = ".onnx,application/octet-stream";
    inp.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;overflow:hidden";   // visually hidden but still clickable through the label (Safari-safe)
    pick.appendChild(inp); bar.appendChild(pick);
    if (meta) { const rm = el("button", "btn ghost", "Remove stored model"); rm.id = "medRemove"; rm.type = "button"; rm.onclick = async () => { await MS.remove("medium"); D.unload(); failed = false; note = "Removed the stored model from this device."; warn = ""; D.setStatus("Stored YOLO11 medium removed."); MS.render(panel); }; bar.appendChild(rm); }
    if (failed || !meta) { const sm = el("button", "btn ghost", "Use YOLO11 small instead"); sm.id = "medUseSmall"; sm.type = "button"; sm.onclick = () => { failed = false; note = ""; warn = ""; D.setPref("model", "small"); }; bar.appendChild(sm); }
    panel.appendChild(bar);
    const help = document.createElement("details"); help.id = "medHelp"; help.className = "hint";
    const sum = el("summary", null, "How do I get yolo11m.onnx?"); help.appendChild(sum);
    const body = el("div"); body.style.cssText = "margin:.35rem 0;line-height:1.45";
    body.appendChild(el("p", null, "YOLO11 weights are AGPL-3.0 (Ultralytics), so the app can't hand them out. Export the file yourself from the official yolo11m.pt (the official weights come from github.com/ultralytics/assets, release v8.3.0; the command downloads them for you):"));
    const code = el("pre"); code.style.cssText = "white-space:pre-wrap;user-select:all;font-size:11px;padding:.4rem;background:rgba(255,255,255,.06);border-radius:6px;margin:.25rem 0";
    code.textContent = "pip install ultralytics onnx onnxslim\nyolo export model=yolo11m.pt format=onnx imgsz=640 opset=17 simplify=True";
    body.appendChild(code);
    body.appendChild(el("p", null, "That writes yolo11m.onnx (about 80 MB). Then press Choose model file… and pick it. The file is read in this browser and kept on this device only; nothing is uploaded."));
    help.appendChild(body); panel.appendChild(help);
    panel.appendChild(el("div", "hint", "AGPL-3.0 note: you are using weights you exported yourself; Dashcam Studio does not host a copy. Nothing is uploaded."));
    inp.onchange = async () => { const f = inp.files && inp.files[0]; inp.value = ""; if (f) await MS.choose(f, panel); };
  };

  /** validate, store, then really start the model with it; a file the runtime can't open is removed again */
  MS.choose = async function (file, panel) {
    const D = T.detect; warn = ""; note = ""; failed = false;
    const refresh = () => { const p = panel && panel.isConnected ? panel : document.getElementById("detMedPanel"); if (p) return MS.render(p); };
    if (!file || file.size < MIN_BYTES) { note = "That file is too small (" + (file ? mb(file.size) : "0 MB") + ") to be YOLO11 medium (about 80 MB). Nothing was stored."; return refresh(); }
    const before = await MS.meta("medium"), beforeBlob = before ? await MS.blob("medium") : null;
    busy = "Storing " + file.name + " (" + mb(file.size) + ") on this device…"; await refresh();
    const meta = await MS.put("medium", file);
    busy = "Checking the model…"; await refresh();
    D.unload();
    try {
      if (D.prefs().model !== "medium") D.setPref("model", "medium");
      await D.load("medium");
      busy = ""; note = "Loaded " + file.name + ". " + (meta.sessionOnly ? "Your browser wouldn't keep it, so it works until you close the page." : "It stays on this device; you won't need to pick it again.");
      const info = D.info || {};
      if (info.outShape && info.outShape.length >= 2 && +info.outShape[1] !== 84) warn = "Heads up: this model's output shape (" + info.outShape.join("×") + ") isn't the usual YOLO11 COCO one (1×84×8400), so results may be wrong.";
      if (file.size < 60 * 1048576 || file.size > 120 * 1048576) warn = (warn ? warn + " " : "") + "The size (" + mb(file.size) + ") differs from the usual ~80 MB export.";
      refresh();
      MS.sha256(file).then((h) => { if (!h) return; meta.sha256 = h; if (h !== KNOWN.medium.sha256) { warn = (warn ? warn + " " : "") + "This file differs from the export Dashcam Studio was tested with (a different ultralytics version gives a different file; that's fine if it loads and detects)."; refresh(); } });
    } catch (e) {
      busy = ""; await MS.remove("medium");
      if (before && beforeBlob) { try { await MS.put("medium", new File([beforeBlob], before.name, { lastModified: before.lastModified })); } catch (_) {} }   // keep the earlier file
      failed = false; note = "That file couldn't be opened as an ONNX model (" + ((e && e.message) || e) + "). Nothing was kept" + (before ? "; your earlier file is still stored." : ".");
      D.setStatus("Detection unavailable: " + note); refresh();
    }
  };
})();
