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
  /** Start a worker for m = { worker: "js/x.js", module?: bool }. Resolves to { worker, how }. */
  W.start = async (m, what) => {
    const opts = m.module ? { type: "module" } : undefined;
    let first = null;
    try {
      const r = await fetch(m.worker, { cache: "no-cache" });
      if (!r.ok) throw new Error("HTTP " + r.status + " for " + m.worker);
      const src = await r.text();
      return { worker: new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })), opts), how: "blob" };
    } catch (e) { first = e; console.warn((what || "worker") + ": blob start failed, trying the file directly", e); }
    try { return { worker: new Worker(m.worker, opts), how: "file " + m.worker }; }
    catch (e2) { throw new Error("Couldn't start the " + (what || "worker") + ": " + (e2.message || e2) + " (and " + ((first && first.message) || first) + ")"); }
  };
  /** Readable text for a worker "error" event (they often carry no message at all). */
  W.describe = (e, stage, how) => {
    if (e && e.message) return e.message + (e.filename ? " (" + String(e.filename).split("/").pop() + ":" + e.lineno + ")" : "");
    if (!stage) return "the worker script could not start (" + (how || "?") + ")";
    return "the browser stopped the worker while " + stage + " (often out of memory, or a WebGPU problem in this browser)";
  };
})();
