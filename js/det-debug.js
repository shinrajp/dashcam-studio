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
    const seedPre = document.createElement("div"); seedPre.style.cssText = "margin-top:4px;color:#9fe8ff;white-space:pre"; box.appendChild(seedPre);
    const tick = () => { draw(); drawSeed(); };
    // second-look layer: motion blobs (cyan), second-look windows (orange motion, magenta through glass, white hidden-person spot) with the zoomed crops'
    // person / bag scores, and the hidden people the tracker keeps (dashed white). Coordinates as search.js .find-layer: contain-fit, mirror, zoom.
    const fit = (vw, vh, tw, th) => { const k = Math.min(tw / vw, th / vh), w = vw * k, h = vh * k; return { x: (tw - w) / 2, y: (th - h) / 2, w, h }; };
    function drawSeed() {
      let d; try { d = T.detect.debugSeed(T.player && T.player.time); } catch (e) { seedPre.textContent = "seed: " + e.message; return; }
      seedPre.textContent = `second looks ${d.on ? "on" : "off"} (${d.mode}) · keep hidden ${d.occl}s · ${d.rate}/s of ${d.budget.per10 / 10}/s · motion ${d.motionMs != null ? d.motionMs + " ms" : "-"} · zoom+enhance ${d.enhMs != null ? d.enhMs + " ms" : "-"} · looks ${d.looks} windows ${d.windows} throttled ${d.throttled}\nfound ${d.found} confirmed ${d.confirmed} revived ${d.revived} · polls ${d.polls}` +
        Object.entries(d.cams).filter(([, x]) => x.wins.length || x.ghosts.length).map(([c, x]) => "\n" + c.padEnd(15) + x.wins.map((w) => w.kind + (w.skipped ? " skipped" : "") + w.crops.map((k) => ` x${k.scale}:${k.person}${k.hint ? "+bag" + k.hint : ""}`).join("")).join(" | ") + x.ghosts.map((g) => ` hidden ${g.hidden}s`).join(""));
      if (!T.player || !T.player.tiles) return;
      for (const cam of T.GRID) {
        const tile = T.player.tiles[cam]; if (!tile) continue;
        let cv = tile.tile.querySelector(".det-layer");
        if (!cv) { cv = document.createElement("canvas"); cv.className = "det-layer"; cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;transform-origin:50% 50%"; tile.tile.appendChild(cv); }
        const video = tile.vids && tile.vids[T.player.active], tw = tile.tile.clientWidth, th = tile.tile.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
        cv.style.transform = video ? (video._zoomPlain != null ? video._zoomPlain : video.style.transform) : "";
        const w = Math.max(1, Math.round(tw * dpr)), h = Math.max(1, Math.round(th * dpr)); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
        const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, tw, th);
        const x = d.cams[cam]; if (!x || !video || !video.videoWidth) continue;
        const f = fit(video.videoWidth, video.videoHeight, tw, th), mir = T.layout && T.layout.mirrored(cam);
        const R = (b) => { let bx = b.x; if (mir) bx = 1 - b.x - b.w; return [f.x + bx * f.w, f.y + b.y * f.h, b.w * f.w, b.h * f.h]; };
        const rect = (b, col, dash, label) => { const r = R(b); ctx.setLineDash(dash || []); ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.strokeRect(r[0], r[1], r[2], r[3]); ctx.setLineDash([]); if (label) { ctx.fillStyle = col; ctx.font = "10px ui-monospace,Menlo,monospace"; ctx.fillText(label, r[0] + 2, Math.max(10, r[1] - 2)); } };
        if (x.global) { ctx.fillStyle = "rgba(255,200,0,.9)"; ctx.font = "10px ui-monospace,Menlo,monospace"; ctx.fillText("light change: motion ignored", 6, 12); }
        for (const b of x.motion) rect(b, "#00e5ff", [3, 2]);
        for (const g of x.ghosts) rect(g, "#ffffff", [5, 4], "hidden " + g.hidden + "s");
        for (const wn of x.wins) {
          const col = wn.kind === "ghost" ? "#ffffff" : wn.glass || wn.kind === "glass" ? "#ff4dff" : "#ff9f1a";
          rect(wn.box, col, wn.skipped ? [2, 3] : [], wn.kind + (wn.skipped ? " (throttled)" : "") + (wn.person ? " " + wn.person : ""));
          for (const k of wn.crops) rect(k.crop, col, [1, 4], "x" + k.scale + " " + k.person + (k.hint ? " bag " + k.hint : ""));
        }
      }
    }
    setInterval(tick, 500); tick();
  };
})();
