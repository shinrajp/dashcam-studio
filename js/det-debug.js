/* det-debug.js — hidden live-detection readout (tag live-lag). Off unless the page URL has ?debug=det (or #debug=det).
 * Shows: the model backend (WASM / WebGPU), the WASM threads, the frame path to the worker (bitmap / rgba), whether the page
 * is cross-origin isolated and a secure context (threads and WebGPU need them), the model and its input size, the speed
 * and camera setting, looks per second (all cameras and per camera), the time of one look (frame grab → boxes back) and
 * of the model alone, whether a camera has a moving box, and Prediction on/off. Refreshes every 500 ms; "Copy" puts the
 * numbers on the clipboard; "Prediction" flips the viewer's box prediction (saved as localStorage "tdc.livePredict").
 * Reads only, apart from that switch. */
(function () {
  "use strict";
  const T = (window.TDC = window.TDC || {});
  const on = () => { try { return /(?:[?&#])debug=det\b/.test(location.search + location.hash); } catch (_) { return false; } };
  T.detDebugInit = () => {
    if (!on() || !T.detect || !T.detect.debugInfo) return;
    const box = document.createElement("div"); box.id = "detDebug";
    box.style.cssText = "position:fixed;left:6px;bottom:6px;z-index:99999;max-width:min(560px,calc(100vw - 12px));max-height:45vh;overflow:auto;padding:6px 8px;border-radius:8px;background:rgba(0,0,0,.82);color:#ffe9a8;font:10px/1.35 ui-monospace,Menlo,monospace;white-space:pre;pointer-events:auto";
    const pre = document.createElement("div"), copy = document.createElement("button"), pred = document.createElement("button");
    for (const b of [copy, pred]) { b.type = "button"; b.style.cssText = "float:right;font:inherit;margin-left:6px"; }
    copy.textContent = "Copy";
    copy.addEventListener("click", () => { const s = JSON.stringify(T.detect.debugInfo()); console.log("det-debug", s); try { navigator.clipboard.writeText(s); copy.textContent = "Copied"; setTimeout(() => (copy.textContent = "Copy"), 1200); } catch (_) {} });
    pred.addEventListener("click", () => { try { localStorage.setItem("tdc.livePredict", T.detect.predictOn() ? "off" : "on"); } catch (_) {} draw(); });
    box.append(copy, pred, pre); document.body.appendChild(box);
    const draw = () => {
      let s; try { s = T.detect.debugInfo(); } catch (e) { pre.textContent = "det-debug: " + e.message; return; }
      pred.textContent = "Prediction " + (s.predict ? "on" : "off");
      pre.textContent = `det-debug  ${s.backend}${s.threads ? " · " + s.threads + " thread" + (s.threads > 1 ? "s" : "") : ""} · ${s.model} @${s.input}px · frame ${s.path || "-"}\n` +
        `isolated ${s.coi ? "yes" : "no"} · secure ${s.secure ? "yes" : "no"} · WebGPU api ${s.gpuApi ? "yes" : "no"} (allowed ${s.gpuAllowed ? "yes" : "no"})\n` +
        `speed ${s.speed} · cameras ${s.camsMode} · live ${s.live ? "on" : "off"} · ${s.playing ? "playing" : "paused"} · prediction ${s.predict ? "on" : "off"}\n` +
        `looks ${s.totalHz}/s · look ${s.lookMs != null ? s.lookMs + " ms" : "-"} · model ${s.inferMs != null ? s.inferMs + " ms" : "-"} · skipped ${s.skipped}\n` +
        Object.entries(s.cams).map(([c, x]) => `${c.padEnd(15)} ${String(x.hz).padStart(4)}/s  gap ${x.gap != null ? x.gap + " ms" : "-"}  boxes ${x.tracks}${x.moving ? " moving" : ""}  tile ${x.px}`).join("\n");
    };
    setInterval(draw, 500); draw();
  };
})();
