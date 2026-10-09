/* player.js — synchronized 3×2 playback across consecutive clips.
 * Each tile owns two <video> elements (slot 0/1). The next clip is preloaded into the hidden slot and swapped in
 * at the boundary, so multi-clip events play continuously. The first available camera is the clock master;
 * the others are nudged back into sync when they drift. */
(function () {
  "use strict";
  const T = window.TDC;
  const P = (T.player = {
    ev: null, time: 0, playing: false, rate: 1, active: 0, slotClip: [-1, -1], tiles: {}, raf: 0, lastWall: 0,
  });
  const MASTER_ORDER = ["front", "back", "left_repeater", "right_repeater", "left_pillar", "right_pillar"];

  P.init = (gridEl) => {
    gridEl.innerHTML = "";
    for (const cam of T.GRID) {
      const tile = T.el("div", "tile");
      tile.dataset.cam = cam;
      const vids = [0, 1].map((s) => {
        const v = document.createElement("video");
        v.muted = true; v.playsInline = true; v.preload = "auto"; v.className = "slot" + s;
        v.setAttribute("muted", ""); v.setAttribute("playsinline", "");
        tile.appendChild(v);
        return v;
      });
      const ph = T.el("div", "tile-empty");
      ph.innerHTML = '<div class="ph-icon"></div><div class="ph-text"></div>';
      const label = T.el("div", "tile-label", T.CAM_LABEL[cam]);
      tile.append(ph, label);
      gridEl.appendChild(tile);
      P.tiles[cam] = { tile, vids, ph, label };
    }
  };

  const urlOf = (it) => it.url || (it.url = URL.createObjectURL(it.blob));
  P.clipIndexAt = (t) => {
    const ev = P.ev;
    if (!ev) return 0;
    let lo = 0, hi = ev.clips.length - 1, i = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (ev.clips[mid].start <= t + 1e-6) { i = mid; lo = mid + 1; } else hi = mid - 1; }
    return i;
  };
  P.duration = () => (P.ev ? P.ev.duration : 0);
  P.clip = () => (P.ev ? P.ev.clips[P.clipIndexAt(P.time)] : null);
  /** Wall-clock time of the current frame (Date) or null. */
  P.wallClock = (t) => {
    const ev = P.ev;
    if (!ev) return null;
    const i = P.clipIndexAt(t == null ? P.time : t), c = ev.clips[i];
    if (!c.time) return null;
    return new Date(c.time + Math.round(((t == null ? P.time : t) - c.start) * 1000)); // ms-rounded: clip starts like 6.000044 s must not floor the clock a second early
  };

  function loadSlot(ci, slot) {
    const clip = P.ev.clips[ci];
    for (const cam of T.GRID) {
      const v = P.tiles[cam].vids[slot];
      const it = clip.files[cam];
      const url = it && it.blob ? urlOf(it) : null;
      if (v._url !== url) {
        v._url = url;
        if (url) v.src = url; else { v.removeAttribute("src"); try { v.load(); } catch (_) {} }
      }
      v.playbackRate = P.rate;
    }
    P.slotClip[slot] = ci;
  }

  function placeholderFor(cam, clip) {
    const it = clip && clip.files[cam];
    if (!it) return { cls: "missing", text: "No " + T.CAM_LABEL[cam].toLowerCase() + " footage" };
    if (it.blob) return null;
    if (it.kind === "encrypted") return { cls: "locked", text: "Encrypted — Unlock with Tesla" };
    if (it.kind === "undecryptable") return { cls: "broken", text: it.reason || "Can't be decrypted" };
    return { cls: "broken", text: "Unsupported file" };
  }

  function showActive() {
    const clip = P.ev ? P.ev.clips[P.slotClip[P.active]] : null;
    for (const cam of T.GRID) {
      const t = P.tiles[cam];
      t.vids.forEach((v, s) => v.classList.toggle("on", s === P.active && !!v._url));
      const ph = P.ev ? placeholderFor(cam, clip) : null;
      t.tile.classList.toggle("has-ph", !!ph);
      t.ph.className = "tile-empty" + (ph ? " " + ph.cls : "");
      t.ph.querySelector(".ph-text").textContent = ph ? ph.text : "";
    }
  }

  function ensureActive(ci) {
    if (P.slotClip[P.active] === ci) return false;
    const other = 1 - P.active;
    if (P.slotClip[other] !== ci) loadSlot(ci, other);
    for (const cam of T.GRID) { const v = P.tiles[cam].vids[P.active]; try { v.pause(); } catch (_) {} }
    P.active = other;
    showActive();
    return true;
  }
  const activeVideos = () => T.GRID.map((c) => P.tiles[c].vids[P.active]).filter((v) => v._url);

  P.open = (ev, startAt) => {
    P.pause();
    P.ev = ev;
    P.slotClip = [-1, -1];
    for (const cam of T.GRID) P.tiles[cam].vids.forEach((v) => { v._url = null; v.removeAttribute("src"); try { v.load(); } catch (_) {} });
    if (!ev) { showActive(); T.emit("time", 0); return; }
    P.active = 0;
    loadSlot(P.clipIndexAt(startAt || 0), 0);
    showActive();
    P.seek(startAt || 0);
    T.emit("player-open", ev);
  };

  /** Re-attach sources after files were decrypted, keeping the current time. */
  P.refresh = () => { if (P.ev) { const t = P.time, was = P.playing; P.open(P.ev, t); if (was) P.play(); } };

  function setLocal(local, vids) {
    for (const v of vids) {
      const d = Number.isFinite(v.duration) ? v.duration : Infinity;
      const target = Math.max(0, Math.min(local, d - 0.02));
      if (v.readyState < 1) {
        // Before metadata, currentTime is only a start-position hint and Chrome may paint frame 0 while
        // reporting the target. Defer: apply as a real seek once metadata is in.
        v._want = local;
        if (!v._wantHooked) {
          v._wantHooked = true;
          v.addEventListener("loadedmetadata", () => {
            if (v._want == null) return;
            const dd = Number.isFinite(v.duration) ? v.duration : Infinity;
            try { v.currentTime = Math.max(0, Math.min(v._want, dd - 0.02)); } catch (_) {}
            v._want = null;
          });
        }
        continue;
      }
      v._want = null;
      if (Math.abs(v.currentTime - target) > 0.001) { try { v.currentTime = target; } catch (_) {} }
    }
  }

  P.seek = (t) => {
    if (!P.ev) return;
    t = T.clamp(t, 0, Math.max(0, P.duration() - 0.001));
    const ci = P.clipIndexAt(t);
    ensureActive(ci);
    setLocal(t - P.ev.clips[ci].start, activeVideos());
    P.time = t;
    if (P.playing) activeVideos().forEach((v) => { if (v.paused && v.currentTime < (v.duration || Infinity) - 0.05) v.play().catch(() => {}); });
    T.emit("time", t);
  };

  P.play = () => {
    if (!P.ev || P.playing) return;
    if (P.time >= P.duration() - 0.05) P.seek(0);
    P.playing = true;
    activeVideos().forEach((v) => { v.playbackRate = P.rate; v.play().catch(() => {}); });
    P.lastWall = performance.now();
    cancelAnimationFrame(P.raf);
    P.raf = requestAnimationFrame(tick);
    T.emit("state");
  };
  P.pause = () => {
    if (!P.playing) return;
    P.playing = false;
    cancelAnimationFrame(P.raf);
    for (const cam of T.GRID) P.tiles[cam].vids.forEach((v) => { try { v.pause(); } catch (_) {} });
    if (P.ev) P.seek(P.time); // line everything up exactly on the paused frame
    T.emit("state");
  };
  P.toggle = () => (P.playing ? P.pause() : P.play());
  P.stop = () => { P.pause(); P.seek(0); };
  P.step = (dir) => { P.pause(); const fps = (P.ev && P.ev.fps) || 36; P.seek(Math.round(P.time * fps + dir) / fps); };
  P.setRate = (r) => {
    P.rate = r;
    for (const cam of T.GRID) P.tiles[cam].vids.forEach((v) => (v.playbackRate = r));
    T.emit("state");
  };

  function master() {
    const local = P.time - P.ev.clips[P.slotClip[P.active]].start;
    for (const cam of MASTER_ORDER) {
      const v = P.tiles[cam].vids[P.active];
      if (v._url && v.readyState >= 1 && !v.ended && local < (v.duration || Infinity) - 0.06) return v;
    }
    return null;
  }

  function tick(now) {
    if (!P.playing || !P.ev) return;
    const ev = P.ev;
    const ci = P.slotClip[P.active];
    const clip = ev.clips[ci];
    const wallDt = Math.min(0.25, (now - P.lastWall) / 1000) * P.rate;
    P.lastWall = now;
    const m = master();
    let local = m ? m.currentTime : P.time - clip.start + wallDt;
    if (m && m.paused) m.play().catch(() => {});
    // preload the next clip a few seconds early
    if (ci + 1 < ev.clips.length && local > clip.dur - 4 && P.slotClip[1 - P.active] !== ci + 1) {
      loadSlot(ci + 1, 1 - P.active);
      T.GRID.forEach((c) => { const v = P.tiles[c].vids[1 - P.active]; if (v._url) { try { v.currentTime = 0; } catch (_) {} } });
    }
    if (local >= clip.dur - 0.03 || (!m && local >= clip.dur - 0.03)) {
      if (ci + 1 < ev.clips.length) {
        P.time = ev.clips[ci + 1].start;
        ensureActive(ci + 1);
        setLocal(0, activeVideos());
        activeVideos().forEach((v) => { v.playbackRate = P.rate; v.play().catch(() => {}); });
      } else {
        P.time = ev.duration;
        P.playing = false;
        activeVideos().forEach((v) => { try { v.pause(); } catch (_) {} });
        T.emit("time", P.time);
        T.emit("state");
        return;
      }
    } else {
      P.time = clip.start + local;
      // keep followers in sync
      for (const v of activeVideos()) {
        if (v === m) continue;
        const d = Number.isFinite(v.duration) ? v.duration : Infinity;
        if (local >= d - 0.05) continue;
        if (Math.abs(v.currentTime - local) > 0.15) { try { v.currentTime = local; } catch (_) {} }
        if (v.paused) v.play().catch(() => {});
      }
    }
    T.emit("time", P.time);
    P.raf = requestAnimationFrame(tick);
  }
})();
