/* ui.js — wires the page: library list, event activation, stage fitting, transport, timeline, toggles,
 * settings drawer, export dialog, unlock dialog, drag & drop, keyboard shortcuts. */
(function () {
  "use strict";
  const T = window.TDC;
  const $ = T.$;
  const U = (T.ui = { current: null, segs: [], selSeg: null, playSecs: false, playIdx: 0 });
  const P = () => T.player;

  // ── stage fitting: keep the grid's aspect (3×2, fewer cameras, or one focused camera) and fit the viewport ──
  U.fit = () => {
    const vp = $("viewport"), stage = $("stage");
    const ev = P().ev;
    const tile = ev && ev.tile ? ev.tile : { w: 1448, h: 938 };
    const d = T.focus ? T.focus.dims() : { cols: 3, rows: 2 };
    const aspect = (d.cols * tile.w) / (d.rows * tile.h);
    const cs = getComputedStyle(vp);
    const W = vp.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), H = vp.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    let w = W, h = W / aspect;
    if (h > H) { h = H; w = H * aspect; }
    stage.style.width = Math.floor(w) + "px";
    stage.style.height = Math.floor(h) + "px";
    T.emit("layout");
  };

  // ── library list ──
  const ICONS = {
    sentry: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/></svg>',
    user: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
    safety: '<svg viewBox="0 0 24 24"><path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.5"/></svg>',
    recent: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    files: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/></svg>',
  };
  U.renderLibrary = () => {
    const evs = T.library.events;
    $("library").hidden = !evs.length;
    const list = $("libList");
    list.innerHTML = "";
    let lastDay = "";
    for (const ev of evs) {
      const d = ev.time ? new Date(ev.time) : null;
      const day = d ? T.fmtDateLong(d) : "Other files";
      if (day !== lastDay) { list.appendChild(T.el("div", "lib-day", day)); lastDay = day; }
      const b = T.el("button", `ev k-${ev.trigger.kind}` + (ev === U.current ? " active" : ""));
      const dur = ev.prepared ? T.fmtTime(ev.duration) : `${ev.clips.length} clip${ev.clips.length > 1 ? "s" : ""}`;
      const meta = [ev.location.city, `${ev.cams.length} cam${ev.cams.length === 1 ? "" : "s"}`, ev.source !== "Files" ? ev.source.replace("Clips", "") : null].filter(Boolean).join(" · ");
      b.innerHTML = `<div class="ev-icon">${ICONS[ev.trigger.kind] || ICONS.files}</div>
        <div class="ev-main"><div class="ev-time"></div><div class="ev-label"></div><div class="ev-meta"></div></div>
        <div class="ev-badges"><span class="ev-dur"></span></div>`;
      b.querySelector(".ev-time").textContent = d ? T.fmtClock(d).slice(0, 5) : "—";
      b.querySelector(".ev-label").textContent = ev.trigger.label;
      b.querySelector(".ev-meta").textContent = meta;
      b.querySelector(".ev-dur").textContent = dur;
      const badges = b.querySelector(".ev-badges");
      if (ev.locked) badges.appendChild(T.el("span", "badge lock", "🔒 locked"));
      if (ev.exportState === "running") badges.appendChild(T.el("span", "badge run", "exporting"));
      else if (ev.exported) badges.appendChild(T.el("span", "badge ok", "✓ exported"));
      b.addEventListener("click", () => U.activate(ev));
      list.appendChild(b);
    }
    const n = evs.length;
    const pick = $("eventPick");
    pick.innerHTML = "";
    evs.forEach((ev, i) => {
      const d = ev.time ? new Date(ev.time) : null;
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = (d ? `${T.fmtDate(d).slice(5)} ${T.fmtClock(d).slice(0, 5)} · ` : "") + ev.trigger.label + (ev.locked ? " 🔒" : "");
      if (ev === U.current) o.selected = true;
      pick.appendChild(o);
    });
    document.body.classList.toggle("multi-ev", n > 1);
    $("libSub").textContent = `${n} event${n === 1 ? "" : "s"} · ${evs.reduce((a, e) => a + e.clips.length, 0)} clips`;
    $("btnExportAllText").textContent = n > 1 ? `Export all ${n} events` : "Export this event";
    const locked = T.library.lockedCount();
    $("btnUnlock").hidden = !locked;
    $("btnUnlockText").textContent = `Unlock ${locked} encrypted file${locked === 1 ? "" : "s"}`;
  };

  // ── event activation ──
  U.activate = async (ev, startAt) => {
    if (!ev) return;
    if (ev !== U.current) { U.segs = []; U.selSeg = null; U.playIdx = 0; view.z = 1; view.v0 = 0; } // sections belong to one event
    U.current = ev;
    busy(true, "Preparing event…");
    try { await T.library.prepare(ev); } finally { busy(false); }
    $("stage").hidden = false;
    $("emptyState").hidden = true;
    document.body.classList.remove("no-event");
    $("btnExport").disabled = false;
    U.fit();
    T.player.open(ev, startAt || 0);
    T.telemetry.load(ev, 0);
    const d = ev.time ? new Date(ev.time) : null;
    $("eventTitle").querySelector(".et-main").textContent = ev.trigger.label + (d ? " · " + T.fmtDateLong(d) + " " + T.fmtClock(d).slice(0, 5) : "");
    $("eventSub").textContent = [ev.location.city, `${ev.clips.length} clip${ev.clips.length > 1 ? "s" : ""} · ${T.fmtTime(ev.duration)}`, `${ev.cams.length} cameras`, ev.tile ? `${ev.tile.w}×${ev.tile.h} per camera` : null].filter(Boolean).join(" · ");
    U.renderLibrary();
    U.drawTimeline();
    U.syncSegUi();
    return ev;
  };

  function busy(on, text) { $("busy").hidden = !on; if (text) $("busyText").textContent = text; }
  U.busy = busy;

  U.ingest = async (list) => {
    if (!list.length) return;
    busy(true, `Reading ${list.length} file${list.length === 1 ? "" : "s"}…`);
    let r;
    try { r = await T.library.ingest(list, (n) => { $("busyText").textContent = `Indexing… ${n}`; }); }
    finally { busy(false); }
    if (!T.library.events.length) { T.toast("No Tesla camera files found there. Choose the TeslaCam folder (or its SavedClips / SentryClips / RecentClips).", "err", 6000); return; }
    const keep = U.current && T.library.events.find((e) => e.id === U.current.id);
    const playable = T.library.events.find((e) => e.locked < e.fileCount) || T.library.events[0];
    await U.activate(keep || playable, keep ? P().time : 0);
    const n = T.library.events.length;
    T.toast(`${n} event${n === 1 ? "" : "s"} found${T.library.lockedCount() ? ` · ${T.library.lockedCount()} encrypted file(s) — click Unlock with Tesla` : ""}`, "ok");
  };

  // ── timeline: its own full-width row (like the Grid Player's multi-trim bar). Upper band = scrub (Self-Driving,
  // brake, speed); lower lane = sections (Advanced). The visible window can be zoomed (Ctrl+scroll, trackpad or
  // two-finger pinch) and panned (scroll sideways); the playhead is followed while playing. ──
  const view = { z: 1, v0: 0 };
  const MAX_TL_Z = 40;
  const isCoarse = () => !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);
  const laneOn = () => !!(T.prefs.advanced && P().ev);
  function span() { const d = P().duration() || 0; return d / view.z; }
  function clampView() {
    const d = P().duration() || 0;
    view.z = T.clamp(view.z, 1, Math.max(1, Math.min(MAX_TL_Z, d / 0.8)));
    view.v0 = T.clamp(view.v0, 0, Math.max(0, d - d / view.z));
    const b = $("btnTlZoom");
    if (b) { b.hidden = view.z <= 1.01; b.textContent = (view.z < 10 ? view.z.toFixed(1) : Math.round(view.z)) + "×"; }
  }
  U.tlZoom = (z, tAnchor) => {
    const d = P().duration() || 0;
    if (!d) return;
    const old = span(), a = tAnchor == null ? view.v0 + old / 2 : tAnchor, frac = (a - view.v0) / old;
    view.z = z; clampView();
    view.v0 = a - frac * span(); clampView();
    U.drawTimeline();
  };
  U.tlReset = () => { view.z = 1; view.v0 = 0; clampView(); U.drawTimeline(); };
  /** Geometry of the bands in CSS px (relative to the timeline box). */
  function geom(h) {
    const top = 6, bottom = h - 3;
    if (!laneOn()) return { top, bh: bottom - top, laneTop: 0, laneH: 0 };
    const laneH = Math.max(24, Math.round((bottom - top) * 0.52));
    return { top, bh: bottom - top - laneH - 4, laneTop: bottom - laneH, laneH };
  }
  /** For tests and tools: page coordinates of the timeline, its visible window and band centres. */
  U.tlGeom = () => {
    const r = $("timeline").getBoundingClientRect(), g = geom(r.height), sp = span();
    return { left: r.left, top: r.top, w: r.width, h: r.height, v0: view.v0, span: sp, z: view.z,
      scrubY: r.top + g.top + g.bh / 2, laneY: g.laneH ? r.top + g.laneTop + g.laneH / 2 : null,
      x: (t) => r.left + ((t - view.v0) / sp) * r.width };
  };
  const NICE = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
  U.drawTimeline = () => {
    const cv = $("timelineCanvas"), ev = P().ev;
    const r = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w) return;
    if (cv.width !== Math.round(w * r) || cv.height !== Math.round(h * r)) { cv.width = Math.round(w * r); cv.height = Math.round(h * r); }
    const ctx = cv.getContext("2d");
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.clearRect(0, 0, w, h);
    clampView();
    const g = geom(h), top = g.top, bh = g.bh;
    T.draw.rr(ctx, 0, top, w, bh, 7); ctx.fillStyle = "#1c2028"; ctx.fill();
    if (g.laneH) { T.draw.rr(ctx, 0, g.laneTop, w, g.laneH, 7); ctx.fillStyle = "#12151b"; ctx.fill(); ctx.strokeStyle = "rgba(255,255,255,0.07)"; ctx.lineWidth = 1; ctx.stroke(); }
    if (!ev || !ev.duration) return;
    const sp = span(), v0 = view.v0;
    const X = (t) => ((t - v0) / sp) * w;
    const tl = $("timeline");
    tl.setAttribute("aria-valuemax", ev.duration.toFixed(1)); tl.setAttribute("aria-valuenow", P().time.toFixed(1));
    ctx.save(); T.draw.rr(ctx, 0, top, w, bh, 7); ctx.clip();
    // self-driving / autosteer bands + speed sparkline from parsed telemetry
    const tel = T.telemetry;
    let vmax = 1;
    ev.clips.forEach((c, i) => { const tr = tel.tracks[i]; if (tr) for (const m of tr.msgs) vmax = Math.max(vmax, m.speed || 0); });
    ev.clips.forEach((c, i) => {
      const tr = tel.tracks[i];
      if (!tr) return;
      const step = Math.max(1, Math.floor(tr.n / Math.max(1, (c.dur / sp) * w)));
      const bw = Math.max(1, ((tr.med * step) / sp) * w + 0.5);
      for (let k = 0; k < tr.n; k += step) {
        const m = tr.msgs[k], x = X(c.start + tr.pts[k]);
        if (x < -bw || x > w) continue;
        if (m.ap === 1 || m.ap === 2) { ctx.fillStyle = m.ap === 1 ? "rgba(62,106,225,0.45)" : "rgba(62,106,225,0.22)"; ctx.fillRect(x, top, bw, bh); }
        if (m.brake) { ctx.fillStyle = "rgba(255,90,79,0.6)"; ctx.fillRect(x, top + bh - 3, bw, 3); }
      }
      ctx.beginPath();
      for (let k = 0; k < tr.n; k += step) { const x = X(c.start + tr.pts[k]), y = top + bh - 4 - ((tr.msgs[k].speed || 0) / vmax) * (bh - 12); k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.strokeStyle = "rgba(255,255,255,0.45)"; ctx.lineWidth = 1.3; ctx.stroke();
    });
    // played
    ctx.fillStyle = "rgba(255,255,255,0.07)"; ctx.fillRect(0, top, Math.max(0, X(P().time)), bh);
    // time ticks (nice steps, ≥ 70 px apart)
    const stepT = NICE.find((s) => (s / sp) * w >= 70) || 3600;
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    for (let t = Math.ceil(v0 / stepT) * stepT; t <= v0 + sp + 1e-6; t += stepT) {
      const x = Math.round(X(t)) + 0.5;
      ctx.fillRect(x - 0.5, top, 1, 4);
      if (x > 4 && x < w - 30) T.draw.text(ctx, T.fmtTime(t, stepT < 1), x + 3, top + 9, 9, "rgba(255,255,255,0.42)", "left", 600);
    }
    const secs = U.activeSegs();
    if (secs.length) { // dim the gaps, tint the sections
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      let cover = 0;
      for (const sg of secs) { if (sg.start > cover) ctx.fillRect(X(cover), top, X(sg.start) - X(cover), bh); cover = Math.max(cover, sg.end); }
      if (cover < ev.duration) ctx.fillRect(X(cover), top, X(ev.duration) - X(cover), bh);
      secs.forEach((sg, i) => { ctx.fillStyle = SEG_COLORS[i % SEG_COLORS.length] + "26"; ctx.fillRect(X(sg.start), top, X(sg.end) - X(sg.start), bh); });
    }
    // clip boundaries
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ev.clips.forEach((c, i) => { if (i) ctx.fillRect(Math.round(X(c.start)), top, 1, bh); });
    ctx.restore();
    // section lane: labelled blocks with wide edge handles
    if (g.laneH) {
      const ly = g.laneTop + 3, lh = g.laneH - 6;
      ctx.save(); T.draw.rr(ctx, 0, g.laneTop, w, g.laneH, 7); ctx.clip();
      if (!secs.length) T.draw.text(ctx, isCoarse() ? "Sections: tap + to add one at the playhead" : "Sections: press + (or A) to add one at the playhead, then drag its edges", w / 2, g.laneTop + g.laneH / 2 + 0.5, 11, "rgba(255,255,255,0.32)", "center", 600);
      secs.forEach((sg, i) => {
        const col = SEG_COLORS[i % SEG_COLORS.length], x0 = X(sg.start), x1 = X(sg.end), sel = sg.id === U.selSeg;
        if (x1 < -10 || x0 > w + 10) return;
        T.draw.rr(ctx, x0, ly, Math.max(2, x1 - x0), lh, 6); ctx.fillStyle = col + (sel ? "f2" : "b8"); ctx.fill();
        if (sel) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }
        const len = sg.end - sg.start, bwid = x1 - x0;
        const lab = bwid > 110 ? `S${i + 1} · ${T.fmtTime(len, true)}` : bwid > 34 ? `S${i + 1}` : "";
        if (lab) T.draw.text(ctx, lab, T.clamp((Math.max(0, x0) + Math.min(w, x1)) / 2, x0 + 16, x1 - 16), ly + lh / 2 + 0.5, 11, "#0b0c0f", "center", 800);
      });
      ctx.restore();
      secs.forEach((sg) => { // handles (drawn unclipped so they stay visible at the ends)
        const x0 = X(sg.start), x1 = X(sg.end), sel = sg.id === U.selSeg;
        for (const x of [x0, x1]) {
          if (x < -8 || x > w + 8) continue;
          const hw = sel ? 8 : 6;
          T.draw.rr(ctx, x - hw / 2, g.laneTop + 1, hw, g.laneH - 2, 3);
          ctx.fillStyle = sel ? "#fff" : "rgba(255,255,255,0.78)"; ctx.fill();
          ctx.fillStyle = "rgba(0,0,0,0.45)";
          const cy = g.laneTop + g.laneH / 2;
          ctx.fillRect(x - 1.5, cy - 5, 1, 10); ctx.fillRect(x + 0.5, cy - 5, 1, 10);
        }
      });
    }
    // event marker (event.json timestamp)
    if (ev.eventTime && ev.clips[0].time) {
      const t = (ev.eventTime - ev.clips[0].time) / 1000;
      if (t >= v0 && t <= v0 + sp) {
        const x = X(t);
        ctx.fillStyle = "#FF5A4F";
        ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 7); ctx.closePath(); ctx.fill();
        ctx.fillRect(x - 0.75, 6, 1.5, bh + 2);
      }
    }
    // playhead: line through both bands + an easy-to-grab knob
    const x = X(P().time);
    if (x >= -6 && x <= w + 6) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(x - 1, 2, 2, h - 4);
      const kw = isCoarse() ? 14 : 12, kh = Math.min(bh, isCoarse() ? 20 : 16);
      ctx.save(); ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = 4;
      T.draw.rr(ctx, x - kw / 2, top + (bh - kh) / 2, kw, kh, 4); ctx.fill(); ctx.restore();
      ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.fillRect(x - 0.5, top + (bh - kh) / 2 + 4, 1, kh - 8);
    }
  };

  function timelineInput() {
    const tl = $("timeline"), tip = $("tlTip");
    let drag = false, segDrag = null, pinch = null;
    const pts = new Map();
    const tAt = (e) => { const r = tl.getBoundingClientRect(); return T.clamp(view.v0 + ((e.clientX - r.left) / r.width) * span(), 0, P().duration() || 0); };
    const showTip = (e) => {
      const t = tAt(e), r = tl.getBoundingClientRect();
      tip.hidden = false; tip.style.left = T.clamp(e.clientX - r.left, 40, r.width - 40) + "px";
      const d = P().wallClock(t);
      tip.textContent = T.fmtTime(t, true) + (d ? "  " + T.fmtClock(d) : "");
    };
    tl.addEventListener("pointerdown", (e) => {
      if (!P().ev || T.exporter.running) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      pts.set(e.pointerId, e.clientX);
      try { tl.setPointerCapture(e.pointerId); } catch (_) {}
      if (pts.size === 2) { // two fingers: pinch-zoom the timeline (undo whatever the first finger started)
        if (segDrag) { const sg = U.segs.find((x) => x.id === segDrag.id); if (sg) { sg.start = segDrag.a0; sg.end = segDrag.b0; } segDrag = null; }
        drag = false;
        const [a, b] = [...pts.values()], r = tl.getBoundingClientRect();
        pinch = { d: Math.abs(a - b) || 1, z: view.z, t: view.v0 + (((a + b) / 2 - r.left) / r.width) * span() };
        U.drawTimeline(); U.syncSegUi();
        return;
      }
      if (pts.size > 2) return;
      const hit = segHit(e);
      U.wasPlaying = P().playing; P().pause();
      showTip(e);
      if (hit) {
        // edge = trim that side, middle = move the whole section (pointer captured: keeps tracking outside the bar)
        U.selSeg = hit.seg.id;
        segDrag = { id: hit.seg.id, handle: hit.handle, x0: e.clientX, a0: hit.seg.start, b0: hit.seg.end, moved: false, pid: e.pointerId };
        if (hit.handle !== "body") P().seek(hit.handle === "start" ? hit.seg.start : Math.max(hit.seg.start, hit.seg.end - 0.001));
        U.drawTimeline(); U.syncSegUi();
        return;
      }
      drag = true; P().seek(tAt(e));
    });
    tl.addEventListener("pointermove", (e) => {
      if (!P().ev) return;
      if (pts.has(e.pointerId)) pts.set(e.pointerId, e.clientX);
      if (pinch) {
        if (pts.size < 2) return;
        const [a, b] = [...pts.values()], r = tl.getBoundingClientRect();
        const d = Math.abs(a - b) || 1;
        view.z = pinch.z * (d / pinch.d); clampView();
        view.v0 = pinch.t - (((a + b) / 2 - r.left) / r.width) * span(); clampView();
        U.drawTimeline();
        return;
      }
      if (e.pointerType === "mouse" || drag || segDrag) showTip(e);
      const r = tl.getBoundingClientRect();
      if (segDrag) {
        if (e.pointerId !== segDrag.pid) return;
        const sg = U.segs.find((x) => x.id === segDrag.id), dur = P().duration();
        if (!sg || !(r.width > 0)) return;
        if (Math.abs(e.clientX - segDrag.x0) >= 3) segDrag.moved = true;
        if (!segDrag.moved) return;
        const dt = ((e.clientX - segDrag.x0) / r.width) * span();
        if (segDrag.handle === "start") { sg.start = T.clamp(segDrag.a0 + dt, 0, sg.end - MIN_SEG); P().seek(sg.start); }
        else if (segDrag.handle === "end") { sg.end = T.clamp(segDrag.b0 + dt, sg.start + MIN_SEG, dur); P().seek(Math.max(sg.start, sg.end - 0.001)); }
        else { const len = segDrag.b0 - segDrag.a0; sg.start = T.clamp(segDrag.a0 + dt, 0, Math.max(0, dur - len)); sg.end = sg.start + len; }
        U.drawTimeline(); U.syncSegUi();
        return;
      }
      if (drag) P().seek(tAt(e));
      else if (e.pointerType === "mouse") { const h = segHit(e); tl.style.cursor = h ? (h.handle === "body" ? "grab" : "ew-resize") : ""; }
    });
    tl.addEventListener("pointerleave", (e) => { if (!drag && !segDrag) tip.hidden = true; });
    const up = (e) => {
      const had = pts.delete(e.pointerId);
      if (pinch) { if (pts.size < 2) pinch = null; if (!pts.size) tip.hidden = e.pointerType !== "mouse"; return; }
      if (!had && e.type !== "pointerup") return;
      if (e.pointerType !== "mouse") tip.hidden = true;
      if (segDrag) {
        if (e.pointerId !== segDrag.pid) return;
        const sd = segDrag; segDrag = null;
        if (!sd.moved && e.type === "pointerup") P().seek(tAt(e)); // a tap on a section selects it and moves the playhead there
        U.drawTimeline(); U.syncSegUi();
        if (U.wasPlaying) U.play();
        return;
      }
      if (drag) { drag = false; if (U.wasPlaying) U.play(); }
    };
    tl.addEventListener("pointerup", up); tl.addEventListener("pointercancel", up);
    // Ctrl/⌘+scroll (and trackpad pinch in Chrome/Edge/Firefox) zooms; sideways scroll pans when zoomed
    tl.addEventListener("wheel", (e) => {
      if (!P().ev) return;
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); U.tlZoom(view.z * Math.exp(-e.deltaY * 0.01), tAt(e)); return; }
      if (view.z <= 1.01) return;
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      e.preventDefault();
      view.v0 += (dx / Math.max(1, tl.clientWidth)) * span(); clampView(); U.drawTimeline();
    }, { passive: false });
    // Safari on a Mac trackpad sends gesture events for pinch
    let g0 = 1, gt = 0;
    tl.addEventListener("gesturestart", (e) => { e.preventDefault(); g0 = view.z; gt = view.v0 + span() / 2; });
    tl.addEventListener("gesturechange", (e) => { e.preventDefault(); if (pts.size < 2) U.tlZoom(g0 * e.scale, gt); });
    tl.addEventListener("gestureend", (e) => e.preventDefault());
    tl.addEventListener("dblclick", (e) => { if (view.z > 1.01 && !segHit(e)) U.tlReset(); });
    $("btnTlZoom").addEventListener("click", () => U.tlReset());
    tl.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  // ── multi-section trim (Advanced). No sections = the whole event, exactly as before. ──
  const SEG_COLORS = ["#38bdf8", "#a78bfa", "#34d399", "#fbbf24", "#f472b6", "#fb923c", "#67e8f9", "#c4b5fd"];
  const MIN_SEG = 0.15;
  let nextSegId = 1;
  U.sortedSegs = () => [...U.segs].sort((a, b) => a.start - b.start || a.end - b.end || a.id - b.id);
  /** Sections that are in effect (only with Advanced on). */
  U.activeSegs = () => (T.prefs.advanced && P().ev ? U.sortedSegs() : []);
  U.selectedSeg = () => U.segs.find((x) => x.id === U.selSeg) || null;
  function segHit(e) {
    const segs = U.activeSegs(), ev = P().ev;
    if (!segs.length || !ev || !ev.duration) return null;
    const tl = $("timeline"), r = tl.getBoundingClientRect(), g = geom(r.height);
    if (!g.laneH) return null;
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (y < g.laneTop - 4) return null; // the upper band always scrubs the playhead
    const sp = span(), X = (t) => ((t - view.v0) / sp) * r.width;
    const tol = e.pointerType === "touch" || e.pointerType === "pen" ? 22 : 10; // wide handles
    const sel = U.selectedSeg();
    const order = sel ? [sel, ...segs.filter((s) => s !== sel)] : segs;
    let best = null;
    for (const sg of order) {
      const t = Math.min(tol, Math.max(4, (X(sg.end) - X(sg.start)) / 3)); // keep a grabbable middle on short sections
      for (const [handle, ex] of [["start", X(sg.start)], ["end", X(sg.end)]]) {
        const d = Math.abs(x - ex) - (sg === sel ? 1.5 : 0);
        if (Math.abs(x - ex) <= t && (!best || d < best.d)) best = { seg: sg, handle, d };
      }
    }
    if (best) return best;
    const t = view.v0 + (x / r.width) * sp;
    const inside = order.filter((sg) => t >= sg.start && t <= sg.end);
    return inside.length ? { seg: inside[0], handle: "body" } : null;
  }
  function clampSeg(sg) {
    const dur = P().duration();
    sg.start = T.clamp(sg.start, 0, Math.max(0, dur - MIN_SEG));
    sg.end = T.clamp(sg.end, sg.start + MIN_SEG, dur);
    return sg;
  }
  /** Where a new section goes: centred on t in the free gap there (≤ 5 s), like the earlier Grid Player. */
  function gapAround(t) {
    const dur = P().duration(), sorted = U.sortedSegs();
    const near = (ns) => { ns = T.clamp(ns, 0, Math.max(0, dur - MIN_SEG)); return { start: ns, end: Math.min(dur, ns + Math.min(5, dur - ns)) }; };
    if (!sorted.length) return near(t - 2.5);
    for (let i = 0; i < sorted.length; i++) {
      const sg = sorted[i];
      if (t >= sg.start && t <= sg.end) {
        const nextStart = i + 1 < sorted.length ? sorted[i + 1].start : dur;
        if (nextStart - sg.end >= MIN_SEG) return { start: sg.end, end: Math.min(nextStart, sg.end + 5) };
        const prevEnd = i > 0 ? sorted[i - 1].end : 0;
        if (sg.start - prevEnd >= MIN_SEG) return { start: Math.max(prevEnd, sg.start - 5), end: sg.start };
        return near(t);
      }
    }
    let prevEnd = 0, nextStart = dur;
    for (const sg of sorted) { if (sg.end <= t) prevEnd = Math.max(prevEnd, sg.end); if (sg.start >= t) { nextStart = sg.start; break; } }
    const gap = nextStart - prevEnd;
    if (gap < MIN_SEG) return near(t);
    const ideal = Math.min(5, gap);
    const start = T.clamp(t - ideal / 2, prevEnd, nextStart - ideal);
    return { start, end: start + ideal };
  }
  function segsChanged() {
    if (U.segs.length && T.prefs.export.range === "full") T.setPref("export.range", "sections");
    if (!U.segs.length) T.setPref("export.range", "full");
    U.drawTimeline(); U.syncSegUi();
  }
  U.addSeg = (start, end) => {
    if (!P().ev || !P().duration()) return null;
    const g = start == null ? gapAround(P().time) : { start, end };
    const sg = clampSeg({ id: nextSegId++, start: g.start, end: g.end });
    U.segs.push(sg); U.selSeg = sg.id;
    segsChanged();
    return sg;
  };
  U.deleteSeg = () => {
    const sel = U.selectedSeg();
    if (!sel) return;
    const sorted = U.sortedSegs(), i = sorted.indexOf(sel);
    U.segs = U.segs.filter((x) => x !== sel);
    const nx = sorted[i + 1] || sorted[i - 1];
    U.selSeg = nx ? nx.id : null;
    segsChanged();
  };
  /** Split the section under the playhead (the selected one first) into two at the playhead. */
  U.splitSeg = () => {
    const t = P().time, sel = U.selectedSeg();
    const inside = (sg) => sg && t > sg.start + MIN_SEG - 1e-6 && t < sg.end - MIN_SEG + 1e-6;
    const sg = inside(sel) ? sel : U.sortedSegs().find(inside);
    if (!sg) { T.toast(U.segs.length ? "Move the playhead inside a section to split it" : "Add a section first, then split it at the playhead", "err"); return null; }
    const nw = { id: nextSegId++, start: t, end: sg.end };
    sg.end = t; U.segs.push(nw); U.selSeg = nw.id;
    T.toast(`Section split at ${T.fmtTime(t, true)}`);
    segsChanged();
    return nw;
  };
  U.clearSegs = () => { U.segs = []; U.selSeg = null; U.playIdx = 0; segsChanged(); };
  /** I / O: set the selected section's start / end to the playhead (creates a section if there is none). */
  U.setEdge = (which) => {
    const t = P().time, dur = P().duration();
    if (!P().ev || !dur) return;
    let sg = U.selectedSeg();
    if (!sg) { const g = which === "start" ? { start: t, end: Math.min(dur, t + 5) } : { start: Math.max(0, t - 5), end: t }; sg = U.addSeg(g.start, g.end); T.toast(`Section added · ${T.fmtTime(sg.start, true)} → ${T.fmtTime(sg.end, true)}`); return; }
    if (which === "start") { sg.start = Math.min(t, dur - MIN_SEG); if (sg.end < sg.start + MIN_SEG) sg.end = Math.min(dur, sg.start + 5); }
    else { sg.end = Math.max(t, MIN_SEG); if (sg.start > sg.end - MIN_SEG) sg.start = Math.max(0, sg.end - 5); }
    clampSeg(sg);
    T.toast(`Section ${which === "start" ? "start" : "end"} at ${T.fmtTime(which === "start" ? sg.start : sg.end, true)}`);
    segsChanged();
  };
  U.syncSegUi = () => {
    const segs = U.segs, sel = U.selectedSeg(), has = !!P().ev;
    const total = segs.reduce((a, x) => a + (x.end - x.start), 0);
    $("segInfo").textContent = segs.length ? `${segs.length} · ${T.fmtTime(total, true)}` : "";
    $("segInfo").title = U.sortedSegs().map((x, i) => `S${i + 1} ${T.fmtTime(x.start, true)} → ${T.fmtTime(x.end, true)}`).join("\n");
    $("btnAddSeg").disabled = !has;
    $("btnDelSeg").disabled = !sel;
    $("btnSplitSeg").disabled = !segs.length;
    $("btnClearSegs").disabled = !segs.length;
    $("btnPlaySecs").disabled = !segs.length;
    $("btnPlaySecs").setAttribute("aria-pressed", String(U.playSecs && !!segs.length));
  };
  /** Ranges to export: the sections in time order (joined), or the whole event. */
  U.ranges = () => {
    const ev = P().ev;
    if (!ev) return [[0, 0]];
    const segs = U.activeSegs();
    if (segs.length && T.prefs.export.range !== "full") return segs.map((x) => [x.start, x.end]);
    return [[0, ev.duration]];
  };
  U.range = () => { const r = U.ranges(); return [r[0][0], r[r.length - 1][1]]; };

  // "Play sections": Play runs the sections in time order and skips the gaps; Stop returns to the first section.
  const playingSecs = () => U.playSecs && U.activeSegs().length > 0;
  U.play = () => {
    const segs = U.activeSegs();
    if (playingSecs() && !P().playing) {
      const t = P().time;
      let i = segs.findIndex((x) => t >= x.start - 1e-3 && t < x.end - 0.05);
      if (i < 0) { i = segs.findIndex((x) => x.start > t); if (i < 0) i = 0; P().seek(segs[i].start); }
      U.playIdx = i;
    }
    P().play();
  };
  U.toggle = () => (P().playing ? P().pause() : U.play());
  U.stop = () => {
    const segs = U.activeSegs();
    if (!segs.length) return P().stop();
    P().pause(); U.playIdx = 0; P().seek(segs[0].start);
  };
  let secGuard = false;
  function enforceSections(t) {
    if (secGuard || !P().playing || T.exporter.running || !playingSecs()) return;
    const segs = U.activeSegs();
    let i = Math.min(U.playIdx, segs.length - 1), cur = segs[i];
    secGuard = true;
    try {
      if (t >= cur.start - 0.1 && t < cur.end - 0.03) return; // inside the current section
      if (t >= cur.end - 0.03 && t < cur.end + 0.6) { // reached its end by playing
        if (i + 1 < segs.length) { U.playIdx = i + 1; P().seek(segs[i + 1].start); }
        else { P().pause(); P().seek(Math.max(cur.start, cur.end - 0.001)); }
        return;
      }
      // scrubbed somewhere else while playing: follow the section there, or jump to the next one
      const j = segs.findIndex((x) => t >= x.start - 1e-3 && t < x.end - 0.03);
      if (j >= 0) { U.playIdx = j; return; }
      const k = segs.findIndex((x) => x.start > t);
      if (k >= 0) { U.playIdx = k; P().seek(segs[k].start); }
      else { P().pause(); }
    } finally { secGuard = false; }
  }

  function onTime(t) {
    enforceSections(t);
    t = P().time;
    const ev = P().ev;
    $("timeLabel").textContent = T.fmtTime(t, true);
    $("durLabel").textContent = T.fmtTime(ev ? ev.duration : 0, true);
    // zoomed timeline: keep the playhead in view while playing
    if (view.z > 1.01 && P().playing && (t < view.v0 || t > view.v0 + span() * 0.95)) { view.v0 = t - span() * 0.1; clampView(); }
    const d = P().wallClock(t);
    $("clockLabel").textContent = d ? T.fmtClock(d) : "—";
    U.drawTimeline();
  }

  // ── quick toggles + settings drawer ──
  function syncChips() {
    document.querySelectorAll("#chips .chip").forEach((c) => c.classList.toggle("on", !!T.prefs.show[c.dataset.show]));
  }
  function toggleShow(k) { T.setPref("show." + k, !T.prefs.show[k]); syncChips(); buildSettings(); }

  const SHOW_LABELS = [["labels", "Camera labels"], ["hud", "Telemetry HUD"], ["map", "Route map"], ["fsd", "Self-driving status"], ["time", "Date & time"]];
  function checkboxRow(label, checked, onChange) {
    const row = T.el("label", "row");
    row.appendChild(T.el("span", null, label));
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = checked;
    cb.addEventListener("change", () => onChange(cb.checked));
    row.appendChild(cb);
    return row;
  }
  function seg(el, value, onPick) {
    el.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("on", b.dataset.v === value);
      b.onclick = () => { onPick(b.dataset.v); el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); };
    });
  }
  function buildSettings() {
    const s = $("setShow"); s.innerHTML = "";
    for (const [k, l] of SHOW_LABELS) s.appendChild(checkboxRow(l, T.prefs.show[k], (v) => { T.setPref("show." + k, v); syncChips(); }));
    const h = $("setHud"); h.innerHTML = "";
    for (const [k, l] of T.hud.ITEMS) h.appendChild(checkboxRow(l, T.prefs.hudItems[k], (v) => T.setPref("hudItems." + k, v)));
    seg($("segUnits"), T.prefs.units, (v) => T.setPref("units", v));
    seg($("segMapStyle"), T.prefs.mapStyle, (v) => T.setPref("mapStyle", v));
    $("hudScale").value = T.prefs.hudScale;
    $("mapTiles").checked = T.prefs.mapTiles;
    $("mapFollow").checked = T.prefs.mapFollow;
    $("steerInvert").checked = T.prefs.steerInvert;
    $("accelSwap").checked = T.prefs.accelSwap;
  }

  // ── export dialog ──
  async function openExport() {
    const ev = P().ev;
    if (!ev) return;
    if (!ev.prepared) await T.library.prepare(ev);
    $("exportModal").hidden = false;
    $("exportProgress").hidden = true;
    $("exportForm").hidden = false;
    $("btnExportGo").hidden = false;
    $("btnExportCancel").textContent = "Close";
    $("exportTitle").textContent = "Export this event";
    const ep = T.prefs.export;
    const adv = T.prefs.advanced;
    document.querySelectorAll('input[name=preset]').forEach((r) => (r.checked = r.value === (adv ? ep.preset : "compat")));
    const sizes = T.exporter.sizeOptions(ev);
    $("exportSize").innerHTML = sizes.map((s) => `<option value="${s.id}">${s.label}</option>`).join("");
    $("exportSize").value = sizes.some((s) => s.id === ep.res) ? ep.res : "native";
    $("originalDesc").textContent = `All six cameras stitched pixel-for-pixel: ${sizes[0].W}×${sizes[0].H}, no upscaling`;
    const sel = $("exportCodec");
    sel.innerHTML = Object.entries(T.exporter.CODECS).map(([k, c]) => `<option value="${k}">${c.label} (${c.ext.toUpperCase()})</option>`).join("");
    sel.value = ep.codec;
    const hasSegs = U.activeSegs().length > 0;
    $("segRangeSections").disabled = !hasSegs;
    $("segRangeSections").title = hasSegs ? "" : "Add sections on the timeline first (+ Section)";
    seg($("segRange"), hasSegs && ep.range !== "full" ? "sections" : "full", (v) => { T.setPref("export.range", v); updateExportHint(); });
    const box = $("exportShow"); box.innerHTML = "";
    U.exportShow = { ...T.prefs.show };
    for (const [k, l] of SHOW_LABELS) {
      const c = T.el("button", "chip" + (U.exportShow[k] ? " on" : ""), l.replace("Telemetry ", "").replace("Self-driving status", "Self-Driving"));
      c.onclick = () => { U.exportShow[k] = !U.exportShow[k]; c.classList.toggle("on", U.exportShow[k]); };
      box.appendChild(c);
    }
    updateExportHint();
    const cap = T.exporter.capability();
    $("exportUnsupported").hidden = cap.mode !== "none";
    $("exportUnsupported").textContent = cap.reason || "";
    $("btnExportGo").disabled = cap.mode === "none";
    // mark unsupported codecs for the chosen size (async)
    const sz = sizes.find((s) => s.id === $("exportSize").value) || sizes[0];
    T.exporter.supportedCodecs(sz.W, sz.H, ev.fps).then((sup) => {
      [...sel.options].forEach((o) => { if (sup[o.value] === false) o.textContent = T.exporter.CODECS[o.value].label + " — not available here"; });
    });
  }
  function updateExportHint() {
    const ev = P().ev;
    const preset = document.querySelector('input[name=preset]:checked').value;
    const rs = U.ranges(), dur = rs.reduce((a, r) => a + (r[1] - r[0]), 0);
    const tel = T.telemetry.status;
    let hint = rs.length > 1 ? `${T.fmtTime(dur, true)} of video (${rs.length} sections joined in time order). ` : `${T.fmtTime(dur)} of video. `;
    hint += preset === "compat" ? "Best for sharing." : "Large file; HEVC/AV1 keep it smaller. If the encoder can't do this size, it steps down and tells you.";
    if (tel === "none") hint += " No telemetry in these clips, so the HUD is left out.";
    if (!T.exporter.webcodecs() && T.exporter.capability().mode === "realtime") hint += " This browser lacks WebCodecs: the export records in real time (keep this tab open and the screen on).";
    if (T.isIOS && T.exporter.webcodecs()) hint += " On iPhone/iPad keep this tab in front until it finishes; very long exports can run out of memory.";
    $("exportHint").textContent = hint;
    $("originalOpts").style.opacity = preset === "original" ? 1 : 0.4;
    if (ev && ev.locked) $("exportHint").textContent += ` ${ev.locked} encrypted file(s) are still locked and will appear as placeholders.`;
  }

  U.progressUi = (title) => {
    $("exportModal").hidden = false;
    $("exportForm").hidden = true;
    $("btnExportGo").hidden = true;
    $("exportProgress").hidden = false;
    $("btnExportCancel").textContent = "Cancel";
    $("exportTitle").textContent = title;
    $("exportBar").style.width = "0%";
    U.shareFiles = []; $("shareRow").hidden = true;
  };
  /** iPhone / iPad: hand finished exports to the share sheet (Save Video, Save to Files…) — needs a tap, so offer buttons. */
  const shareMode = () => T.isIOS && T.canShareFiles([new File([new Uint8Array(1)], "x.mp4", { type: "video/mp4" })]);
  U.shareFiles = [];
  async function shareNow() {
    const files = U.shareFiles.map((r) => new File([r.blob], r.name, { type: r.blob.type || "video/mp4" }));
    try { await navigator.share({ files, title: files.length > 1 ? "Dashcam exports" : files[0].name }); }
    catch (e) { if (e && e.name !== "AbortError") { T.toast("Sharing didn't work here — use Download instead", "err"); } }
  }
  U.progress = (pct, text) => { $("exportBar").style.width = T.clamp(pct, 0, 100).toFixed(1) + "%"; if (text != null) $("exportText").textContent = text; };

  /** Save an export: into the chosen folder (Chrome/Edge) or as a download. */
  U.save = async (res) => {
    if (U.outDir) {
      try {
        const fh = await U.outDir.getFileHandle(res.name, { create: true });
        const w = await fh.createWritable(); await w.write(res.blob); await w.close();
        return "saved to the folder you chose";
      } catch (e) { console.warn("folder write failed, downloading instead", e); }
    }
    window.__tdcLastExport = res;
    if (shareMode()) {
      U.shareFiles.push(res); $("shareRow").hidden = false;
      $("btnShare").textContent = U.shareFiles.length > 1 ? `Save / Share ${U.shareFiles.length} videos…` : "Save / Share…";
      return "ready: tap Save / Share to put it in Photos or Files";
    }
    T.download(res.blob, res.name);
    return "downloaded";
  };

  async function runSingleExport() {
    const ev = P().ev;
    const preset = T.prefs.advanced ? document.querySelector('input[name=preset]:checked').value : "compat";
    if (T.prefs.advanced) { T.prefs.export.preset = preset; T.prefs.export.codec = $("exportCodec").value; T.prefs.export.res = $("exportSize").value; T.savePrefs(); }
    U.progressUi("Exporting…");
    const t0 = performance.now();
    try {
      const res = await T.exporter.run({
        preset, codec: $("exportCodec").value, sizeId: $("exportSize").value, ranges: U.ranges(),
        show: T.prefs.advanced ? U.exportShow : { ...T.prefs.show },
        onStatus: (s) => U.progress(0, s),
        onProgress: (d, tot) => {
          const el = (performance.now() - t0) / 1000, pct = (d / tot) * 100;
          U.progress(pct, `${Math.floor(pct)}% · frame ${d}/${tot} · ${T.fmtTime(el)} elapsed · about ${T.fmtTime((el / d) * (tot - d))} left`);
        },
      });
      const how = await U.save(res);
      ev.exported = { name: res.name, at: Date.now() };
      U.progress(100, `✓ ${res.name} — ${T.fmtBytes(res.blob.size)}, ${how}. ${res.label || ""}${res.note ? " · " + res.note : ""}`);
      $("btnExportCancel").textContent = "Done";
      U.renderLibrary();
      T.emit("exported", res);
    } catch (e) {
      if (String(e.message) === "cancelled") { U.progress(0, "Export cancelled."); }
      else { console.error(e); U.progress(0, "Export failed: " + (e.message || e)); }
      $("btnExportCancel").textContent = "Close";
    }
  }

  // ── init ──
  U.init = () => {
    T.player.init($("grid"));
    T.overlays.init($("stage"), $("overlayLayer"));
    T.focus.init();
    T.auth.init();
    new ResizeObserver(() => { U.fit(); U.drawTimeline(); }).observe($("viewport"));
    document.body.classList.add("no-event");

    // first run: units from locale
    if (!localStorage.getItem("tdc.prefs.v1")) T.prefs.units = /^en-(US|GB|LR|MM)$/i.test(navigator.language || "en-US") ? "mph" : "kmh";
    $("advToggle").checked = T.prefs.advanced;
    document.body.classList.toggle("simple", !T.prefs.advanced);
    $("advToggle").addEventListener("change", (e) => { T.setPref("advanced", e.target.checked); document.body.classList.toggle("simple", !e.target.checked); if (!e.target.checked) $("settings").hidden = true; U.drawTimeline(); });

    // iPhone / iPad can't pick (or drag) folders: use the multi-file picker — in Files, open TeslaCam, tap Select, pick the clips
    const pickFolder = () => {
      if (T.isIOS) { T.toast("In the picker choose Browse / Files, open the TeslaCam folder, tap Select and pick the clips (and event.json)", "ok", 7000); return $("fileInput").click(); }
      $("folderInput").click();
    };
    const pickFiles = () => $("fileInput").click();
    $("btnOpenFolder").onclick = pickFolder; $("btnEmptyFolder").onclick = pickFolder;
    $("btnOpenFiles").onclick = pickFiles; $("btnEmptyFiles").onclick = pickFiles;
    $("folderInput").addEventListener("change", (e) => { U.ingest(T.library.filesFromInput(e.target)); e.target.value = ""; });
    $("fileInput").addEventListener("change", (e) => { U.ingest(T.library.filesFromInput(e.target)); e.target.value = ""; });

    // drag & drop anywhere
    let depth = 0;
    window.addEventListener("dragenter", (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { depth++; document.body.classList.add("dragover"); } });
    window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; document.body.classList.remove("dragover"); } });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", async (e) => {
      e.preventDefault(); depth = 0; document.body.classList.remove("dragover");
      U.ingest(await T.library.filesFromDataTransfer(e.dataTransfer));
    });

    $("eventPick").addEventListener("change", (e) => { const ev = T.library.events[+e.target.value]; if (ev) U.activate(ev); e.target.blur(); });
    // CSS knows the bar heights (drawer / toasts sit above the transport, full screen overlays it)
    const sizeVars = () => {
      document.documentElement.style.setProperty("--tp-h", $("transport").offsetHeight + "px");
      document.documentElement.style.setProperty("--top-h", document.querySelector(".topbar").offsetHeight + "px");
    };
    new ResizeObserver(() => { sizeVars(); U.drawTimeline(); }).observe($("transport"));
    sizeVars();

    // transport
    $("btnPlay").onclick = () => U.toggle();
    $("btnStop").onclick = () => U.stop();
    $("btnBack").onclick = () => P().step(-1);
    $("btnFwd").onclick = () => P().step(1);
    $("rateSelect").value = String(T.prefs.rate);
    $("rateSelect").onchange = (e) => { P().setRate(+e.target.value); T.setPref("rate", +e.target.value); };
    T.player.setRate(T.prefs.rate);
    $("btnAddSeg").onclick = () => U.addSeg();
    $("btnIn").onclick = () => U.setEdge("start");
    $("btnOut").onclick = () => U.setEdge("end");
    $("btnDelSeg").onclick = () => U.deleteSeg();
    $("btnSplitSeg").onclick = () => U.splitSeg();
    $("btnClearSegs").onclick = () => U.clearSegs();
    $("btnPlaySecs").onclick = () => {
      U.playSecs = !U.playSecs; U.syncSegUi();
      if (P().playing) { P().pause(); U.play(); } // switch mode on the fly
      T.toast(U.playSecs ? "Play sections: on — Play runs the sections in order and skips the gaps" : "Play sections: off");
    };
    U.syncSegUi();
    timelineInput();
    T.on("time", onTime);
    T.on("telemetry", () => U.drawTimeline());
    T.on("state", () => document.body.classList.toggle("playing", P().playing));
    T.on("library", () => U.renderLibrary());
    T.on("unlocked", async () => { if (U.current) { const t = P().time; U.current.prepared = false; await U.activate(U.current, t); } });

    // toggles
    document.querySelectorAll("#chips .chip").forEach((c) => (c.onclick = () => toggleShow(c.dataset.show)));
    syncChips();
    buildSettings();
    $("btnSettings").onclick = () => { $("settings").hidden = !$("settings").hidden; };
    $("btnCloseSettings").onclick = () => { $("settings").hidden = true; };
    $("hudScale").oninput = (e) => T.setPref("hudScale", +e.target.value);
    $("mapTiles").onchange = (e) => T.setPref("mapTiles", e.target.checked);
    $("mapFollow").onchange = (e) => T.setPref("mapFollow", e.target.checked);
    $("steerInvert").onchange = (e) => T.setPref("steerInvert", e.target.checked);
    $("accelSwap").onchange = (e) => T.setPref("accelSwap", e.target.checked);
    $("btnResetLayout").onclick = () => { T.resetPrefs("panels"); T.toast("Overlay positions reset"); };
    $("btnResetAll").onclick = () => { const adv = T.prefs.advanced; T.resetPrefs(); T.setPref("advanced", adv); buildSettings(); syncChips(); T.toast("Settings reset"); };

    // export
    $("btnExport").onclick = openExport;
    document.querySelectorAll('input[name=preset]').forEach((r) => (r.onchange = updateExportHint));
    $("btnExportGo").onclick = runSingleExport;
    $("btnExportCancel").onclick = () => { if (T.exporter.running) T.exporter.cancel(); else $("exportModal").hidden = true; };
    $("btnExportAll").onclick = () => T.auto.exportAllInteractive();
    $("btnShare").onclick = shareNow;
    $("btnShareDownload").onclick = () => U.shareFiles.forEach((r) => T.download(r.blob, r.name));

    // unlock
    $("btnUnlock").onclick = () => { $("unlockModal").hidden = false; };
    document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => { if (!T.exporter.running) b.closest(".modal").hidden = true; }));

    // keyboard
    window.addEventListener("keydown", (e) => {
      if (e.target.matches("input, textarea, select") || e.metaKey || e.ctrlKey) return;
      const k = e.key;
      if (k === " ") { e.preventDefault(); U.toggle(); }
      else if (k === "ArrowLeft") { e.preventDefault(); e.shiftKey ? P().seek(P().time - 5) : P().step(-1); }
      else if (k === "ArrowRight") { e.preventDefault(); e.shiftKey ? P().seek(P().time + 5) : P().step(1); }
      else if (k === "Home") U.stop();
      else if (k === "End") P().seek(P().duration());
      else if (k === "h" || k === "H") toggleShow("hud");
      else if (k === "m" || k === "M") toggleShow("map");
      else if (k === "f" || k === "F") T.focus.fullscreen();
      else if (k === "d" || k === "D") toggleShow("fsd");
      else if (k === "c" || k === "C") T.focus.setBar(!T.focus.barOn());
      else if (/^[1-6]$/.test(k) && !e.altKey && P().ev) T.focus.byNumber(+k);
      else if ((k === "g" || k === "G" || k === "0") && P().ev) T.focus.grid();
      else if (k === "]" && P().ev) T.focus.cycle(1);
      else if (k === "[" && P().ev) T.focus.cycle(-1);
      else if ((k === "+" || k === "=") && T.focus.cam) T.focus.zoomBy(1.5);
      else if ((k === "-" || k === "_") && T.focus.cam) T.focus.zoomBy(1 / 1.5);
      else if (k === "l" || k === "L") toggleShow("labels");
      else if ((k === "i" || k === "I") && T.prefs.advanced) $("btnIn").click();
      else if ((k === "o" || k === "O") && T.prefs.advanced) $("btnOut").click();
      else if ((k === "a" || k === "A") && T.prefs.advanced && P().ev) U.addSeg();
      else if ((k === "b" || k === "B") && T.prefs.advanced && P().ev) U.splitSeg();
      else if ((k === "s" || k === "S") && T.prefs.advanced && U.segs.length) $("btnPlaySecs").click();
      else if ((k === "Delete" || k === "Backspace") && T.prefs.advanced && U.selectedSeg()) { e.preventDefault(); U.deleteSeg(); }
      else if (k === "Escape") {
        const open = [...document.querySelectorAll(".modal")].some((m) => !m.hidden) || !$("settings").hidden || !$("camMenu").hidden;
        document.querySelectorAll(".modal").forEach((m) => { if (!T.exporter.running) m.hidden = true; }); $("settings").hidden = true; $("camMenu").hidden = true;
        if (open) return;
        if (T.focus.cam) T.focus.grid();                   // Esc: focused camera → grid → leave full screen
        else if (T.focus.isFullscreen()) T.focus.fullscreen(false);
      }
    });
    U.fit();
  };
})();
