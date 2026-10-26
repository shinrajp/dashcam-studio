/* worker-start.js — one MIME-proof way to start the model workers (object detection and plates), plus the
 * WebGPU policy they share. Loaded before detect.js and plates.js, so plates never depend on the detection setting.
 *  - start(): fetch the worker source and run it from a blob: URL (a server that sends the wrong MIME type for .js
 *    can't stop it); falls back to new Worker(url). Errors say which way was tried.
 *  - gpuOk(): onnxruntime-web 1.22's WebGPU (JSEP) build runs away with memory/CPU in Safari/WebKit 26+ and the
 *    browser kills the worker without an error message (onnxruntime issue #26827), so Safari, and every iOS
 *    browser, uses the plain WASM build. localStorage "tdc.webgpu" = "on" / "off" overrides. */
(function () {
  "use strict";
  const T = (window.TDC = window.TDC || {});
  const W = (T.workerStart = {});
  W.isWebKit = (ua) => { ua = ua == null ? navigator.userAgent : ua; return /AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Android/.test(ua) || /iPhone|iPad|iPod/.test(ua); };
  // ?webgpu=on / ?webgpu=off (tag live-lag): the same override from the address bar, kept for later visits; WebGPU also
  // needs a secure context (https or localhost: an iPhone opening the Mac by its LAN address over http has no WebGPU)
  try { const m = /(?:[?&#])webgpu=(on|off|auto)\b/.exec(location.search + location.hash); if (m) { if (m[1] === "auto") localStorage.removeItem("tdc.webgpu"); else localStorage.setItem("tdc.webgpu", m[1]); } } catch (_) {}
  W.gpuOk = () => { let o = ""; try { o = localStorage.getItem("tdc.webgpu") || ""; } catch (_) {} if (o === "on") return true; if (o === "off") return false; return !W.isWebKit(); };
  /** Start a worker for m = { worker: "js/x.js", module?: bool }. Resolves to { worker, how, first } (first = why the blob start failed, if it did). */
  W.start = async (m, what) => {
    const opts = m.module ? { type: "module" } : undefined;
    let first = null;
    try {
      const r = await fetch(m.worker, { cache: "no-cache" });
      if (!r.ok) throw new Error("HTTP " + r.status + " for " + m.worker);
      const src = await r.text();
      return { worker: new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })), opts), how: "blob", first: null };
    } catch (e) { first = e; console.warn((what || "worker") + ": blob start failed, trying the file directly", e); }
    const why = (first && (first.name && first.name !== "Error" ? first.name + ": " : "") + (first.message || first)) || "";
    try { return { worker: new Worker(m.worker, opts), how: "file " + m.worker, first: why }; }
    catch (e2) { throw new Error("Couldn't start the " + (what || "worker") + ": " + (e2.message || e2) + " (and " + why + ")"); }
  };
  /** Readable text for a worker "error" event (they often carry no message at all). first = why the blob start failed (W.start). */
  W.describe = (e, stage, how, first) => {
    if (e && e.message) return e.message + (e.filename ? " (" + String(e.filename).split("/").pop() + ":" + e.lineno + ")" : "") + (/Unexpected token '?<|expected expression, got '<'|Unexpected identifier 'DOCTYPE'/i.test(e.message) ? ". The server sent a web page instead of the script. " + W.TRY : "");
    if (!stage) return "the worker script could not start (" + (how || "?") + (first ? "; the first try failed with: " + first : "") + ")";
    return "the browser stopped the worker while " + stage + " (often out of memory, or a WebGPU problem in this browser)";
  };
  W.TRY = "What to try: reload with ?nosw=1 added to the address, clear this site's data (Safari: Settings ▸ Privacy ▸ Manage Website Data), update Safari/macOS, turn off content blockers for this page, and if the page is on githack wait a minute (it caches and rate-limits).";
  // A worker that starts, reports what it can do, and says what failed. Runs from a blob: URL; its name carries the script's address.
  const PROBE = "const r={};self.onerror=function(e){r.err=(e&&e.message)||'error'};r.importScripts=typeof importScripts;r.wasm=typeof WebAssembly;r.idb=typeof indexedDB;r.sab=typeof SharedArrayBuffer;r.offscreen=typeof OffscreenCanvas;" +
    "(async function(){try{const x=await fetch(self.name,{cache:'no-cache'});r.fetch=x.status}catch(e){r.fetch='failed: '+((e&&e.message)||e)}" +
    "try{await new Promise(function(ok,no){const q=indexedDB.open('tdc-probe');q.onsuccess=function(){try{q.result.close()}catch(_){}ok()};q.onerror=function(){no(q.error)};q.onblocked=ok});r.idbOpen='ok'}catch(e){r.idbOpen='failed: '+((e&&e.message)||e)}" +
    "try{new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));r.wasmOk=true}catch(e){r.wasmOk=false}postMessage(r)})();";
  const wait = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(() => res("timeout"), ms))]);
  /** Find out why a worker would not start: the script's HTTP answer and syntax, a tiny test worker, and the browser's abilities.
   *  Resolves to { text, data }; never rejects. Takes at most about 4 s. */
  W.diagnose = async (m) => {
    const d = { ua: (/(Version\/[\d.]+|Chrome\/[\d.]+|Firefox\/[\d.]+|CriOS\/[\d.]+)/.exec(navigator.userAgent) || [""])[0], secure: !!window.isSecureContext, online: navigator.onLine, host: location.host };
    const abs = new URL(m.worker, location.href).href;
    try {
      const r = await wait(fetch(abs, { cache: "reload" }), 4000);
      if (r === "timeout") d.script = "no answer in 4 s";
      else {
        const t = await r.text(); const ct = (r.headers.get("content-type") || "?").split(";")[0];
        d.script = "HTTP " + r.status + " " + ct + " " + (t.length < 1024 ? t.length + " bytes" : Math.round(t.length / 1024) + " KB") + (/^\s*</.test(t) ? " (this is a web page, not the script)" : "");
        if (r.ok && !m.module) { try { new Function(t); d.syntax = "ok"; } catch (e) { d.syntax = String((e && e.message) || e); } }
      }
    } catch (e) { d.script = "request failed: " + ((e && e.message) || e); }
    try {
      const url = URL.createObjectURL(new Blob([PROBE], { type: "text/javascript" }));
      const w = new Worker(url, { name: abs });
      const res = await wait(new Promise((ok) => { w.onmessage = (e) => ok(e.data); w.onerror = (e) => { try { e.preventDefault(); } catch (_) {} ok({ err: (e && e.message) || "the test worker failed too, with no message" }); }; }), 3500);
      try { w.terminate(); URL.revokeObjectURL(url); } catch (_) {}
      d.probe = res === "timeout" ? "no answer in 3.5 s" : res;
    } catch (e) { d.probe = "can't start a test worker: " + ((e && (e.name + ": " + e.message)) || e); }
    const pr = d.probe;
    const probeTxt = typeof pr === "string" ? pr : "started" + (pr.err ? ", error: " + pr.err : "") + "; fetch " + pr.fetch + ", IndexedDB " + pr.idbOpen + ", WebAssembly " + (pr.wasmOk ? "ok" : pr.wasm) + ", importScripts " + pr.importScripts;
    d.text = "Checked: " + m.worker + " → " + d.script + (d.syntax ? "; syntax " + d.syntax : "") + ". Test worker: " + probeTxt + ". " + [d.ua, d.secure ? "https/secure" : "not a secure address", d.online === false ? "offline" : "online", d.host].filter(Boolean).join(" · ") + ". " + W.TRY;
    return d;
  };
  /** Readable, complete reason for a worker "error" event; a message-less one that happened before the script reported in gets the diagnostics. */
  W.explain = async (e, stage, how, first, m) => {
    let why = W.describe(e, stage, how, first);
    if (!(e && e.message) && !stage && m) { try { const d = await W.diagnose(m); console.warn("worker diagnostics", d); why += ". " + d.text; } catch (_) {} }
    return why;
  };
})();
