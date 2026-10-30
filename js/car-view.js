/* Car view (Hand-off, milestone 3): a small top-down car with the six camera wedges and a tiny person (head + body) for every tracked
   person, in that person's colour (the same colour as their boxes on the tiles). Position is an estimate: the camera's heading plus the box's
   horizontal position gives the bearing, the box height gives the distance (bigger = closer). Tap a person (or a legend chip) to
   highlight their boxes on every camera. On/off with the "Car view" chip (remembered). Pure part is node-testable (test/handoff.test.js).
   ui-v3: the panel FLOATS (position: fixed on the page, so it never changes the layout of the grid): drag it by its header anywhere in the
   window (clamped to the viewport only), resize it with the corner handle, pin it (locks position and size, remembered per device in
   prefs.carPanel), collapse or close it while it is not pinned. Touch works (pointer events). The export tick "Include car view" draws the
   same diagram into the video (drawExport, called by the compositor / the 360 path) at the same relative place, kept fully inside the picture. */
(function (root) {
  "use strict";
  // Each camera covers a slice of the compass around the car (° clockwise from the nose, the picture's left edge = lo, right edge = hi).
  // The slices tile the circle (the real cameras overlap, so this is deliberately an approximation), which keeps a walker's icon continuous
  // when they leave one picture at its right edge and enter the next at its left edge — the same adjacency as js/handoff.js.
  const CAMS = {
    front: { lo: -45, hi: 45, tag: "F" },
    right_pillar: { lo: 45, hi: 100, tag: "RP" },
    right_repeater: { lo: 100, hi: 150, tag: "RR" },
    back: { lo: 150, hi: 210, tag: "B" },
    left_repeater: { lo: 210, hi: 260, tag: "LR" },
    left_pillar: { lo: 260, hi: 315, tag: "LP" },
  };
  const R_IN = 27, R_OUT = 45, C = 50;   // viewBox 0..100, car in the middle; people live between R_IN and R_OUT
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  /** Where a person seen on `cam` in `box` (raw, un-mirrored picture coordinates) stands around the car. */
  function position(cam, box) {
    const c = CAMS[cam]; if (!c || !box) return null;
    const cx = clamp(box.x + box.w / 2, 0, 1);
    const bearing = ((c.lo + cx * (c.hi - c.lo)) % 360 + 360) % 360;
    const near = clamp((box.h - 0.08) / 0.6, 0, 1);   // box height as a fraction of the frame: 0.08 far … 0.68+ right next to the car
    const r = R_IN + (R_OUT - R_IN) * (1 - near);
    const a = (bearing * Math.PI) / 180;
    return { bearing, r, x: C + r * Math.sin(a), y: C - r * Math.cos(a) };
  }
  const pt = (r, deg) => { const a = (deg * Math.PI) / 180; return [C + r * Math.sin(a), C - r * Math.cos(a)]; };
  function wedgePath(cam, r) {
    const c = CAMS[cam], p1 = pt(r, c.lo), p2 = pt(r, c.hi);
    return "M" + C + " " + C + " L" + p1[0].toFixed(1) + " " + p1[1].toFixed(1) + " A" + r + " " + r + " 0 0 1 " + p2[0].toFixed(1) + " " + p2[1].toFixed(1) + " Z";
  }
  const api = { CAMS, position, wedgePath, R_IN, R_OUT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!root.document || !root.TDC) return;

  const T = root.TDC, $ = (id) => document.getElementById(id), NS = "http://www.w3.org/2000/svg";
  const V = (T.carView = Object.assign({ el: null }, api));
  V.on = () => !!(T.prefs && T.prefs.carView);
  const el = (n, a, kids) => { const e = document.createElementNS(NS, n); for (const k in a || {}) e.setAttribute(k, a[k]); (kids || []).forEach((c) => e.appendChild(c)); return e; };
  let svg, gW, gP, legend, hint, last = 0, sig = "";

  V.build = () => {
    const stage = $("stage"); if (!stage || V.el) return;
    const box = document.createElement("div"); box.id = "carView"; box.className = "car-view"; box.hidden = true;
    box.setAttribute("role", "group"); box.setAttribute("aria-label", "Car view");
    const ic = (d) => '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="' + d + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    box.innerHTML = '<div class="cv-bar" id="cvHead" tabindex="0" title="Drag to move (arrow keys move it too)">' +
      '<span class="cv-grip" aria-hidden="true">' + ic("M5 3.5v.01M5 8v.01M5 12.5v.01M11 3.5v.01M11 8v.01M11 12.5v.01") + '</span><span class="cv-title">Car</span>' +
      '<button type="button" class="cv-btn" id="cvPin" aria-pressed="false" title="Pin: lock the position and size">' + ic("M9.5 2.5l4 4-2 .8-2.4 2.4.3 3-1 1-2.3-2.3-3.7 3.7M6 6.5l3.5-3.5") + '</button>' +
      '<button type="button" class="cv-btn" id="cvCollapse" aria-expanded="true" title="Collapse">' + ic("M3.5 8h9") + '</button>' +
      '<button type="button" class="cv-btn" id="cvClose" title="Close the car view (the Car view chip turns it back on)">' + ic("M4 4l8 8M12 4l-8 8") + '</button></div>' +
      '<div class="cv-body"><div class="cv-legend" aria-label="People"></div><div class="cv-hint"></div></div>' +
      '<div class="cv-resize" id="cvResize" tabindex="0" role="separator" aria-label="Resize the car view (arrow keys)" title="Drag to resize"></div>';
    svg = el("svg", { viewBox: "0 0 100 100", class: "cv-svg", role: "img", "aria-label": "Car view: nobody tracked" });
    gW = el("g", { class: "cv-wedges" }); gP = el("g", { class: "cv-people" });
    for (const cam of Object.keys(CAMS)) {
      const w = el("path", { d: wedgePath(cam, 48), class: "cv-wedge", "data-cam": cam }); const t = el("title"); t.textContent = (T.CAM_LABEL && T.CAM_LABEL[cam]) || cam; w.appendChild(t); gW.appendChild(w);
    }
    // top-down car: nose at the top
    const body = el("g", { class: "cv-car" }, [
      el("rect", { x: 40, y: 26, width: 20, height: 48, rx: 7 }),
      el("path", { d: "M42.5 38 Q50 34 57.5 38 L56.5 44 L43.5 44 Z", class: "cv-glass" }),
      el("path", { d: "M43.5 60 L56.5 60 L57.5 65 Q50 68 42.5 65 Z", class: "cv-glass" }),
      el("rect", { x: 41, y: 28, width: 3.4, height: 1.8, rx: 0.9, class: "cv-lamp" }), el("rect", { x: 55.6, y: 28, width: 3.4, height: 1.8, rx: 0.9, class: "cv-lamp" }),
    ]);
    svg.appendChild(gW); svg.appendChild(body); svg.appendChild(gP);
    const cvBody = box.querySelector(".cv-body"); cvBody.insertBefore(svg, cvBody.firstChild); document.body.appendChild(box);   // on the page, not in the stage: it can go anywhere and never shifts the grid
    legend = box.querySelector(".cv-legend"); hint = box.querySelector(".cv-hint");
    V.el = box;
  };

  const human = (p, sel) => {
    const g = el("g", { class: "cv-person" + (sel ? " sel" : ""), transform: "translate(" + p.x.toFixed(1) + " " + p.y.toFixed(1) + ")", "data-gid": String(p.gid), tabindex: "0", role: "button", "aria-label": p.name + (p.bestGuess ? " (best guess)" : "") });
    g.appendChild(el("circle", { r: 8, class: "cv-hit" }));
    if (sel) g.appendChild(el("circle", { r: 6.3, class: "cv-ring" }));
    g.appendChild(el("circle", { cx: 0, cy: -3.1, r: 1.8, fill: p.color, class: "cv-head" }));
    g.appendChild(el("path", { d: "M-2.7 4.2 L-2.7 0.4 Q-2.7 -1.1 0 -1.1 Q2.7 -1.1 2.7 0.4 L2.7 4.2 Z", fill: p.color, class: "cv-body" }));
    const t = el("title"); t.textContent = p.name + " · " + ((T.CAM_LABEL && T.CAM_LABEL[p.cam]) || p.cam) + (p.bestGuess ? " · best guess (cameras linked by timing, direction and clothing colour)" : ""); g.appendChild(t);
    return g;
  };

  V.render = (force) => {
    if (!V.el) return;
    const show = V.on() && !!(T.player && T.player.ev);
    const was = !V.el.hidden; V.el.hidden = !show; if (!show) return;
    if (!was) { V.sync(); V.place(); }
    const P = T.people, t = T.player.time || 0, D = T.detect, ppl = P && P.current ? P.current(t) : [];
    const cues = (T.handoff && T.handoff.cues) || [];
    const items = ppl.filter((m) => m.gid != null).map((m) => { const pos = position(m.cam, { x: m.x, y: m.y, w: m.w, h: m.h }); return pos ? Object.assign({ pos }, m, { x: pos.x, y: pos.y, name: P.name(m), box: { x: m.x, y: m.y, w: m.w, h: m.h } }) : null; }).filter(Boolean);
    // one icon per person: when several cameras see the same person, use the most recently seen box
    const byG = new Map(); for (const it of items) { const o = byG.get(it.gid); if (!o || it.seen > o.seen) byG.set(it.gid, it); }
    const list = [...byG.values()].sort((a, b) => P.num(a.gid) - P.num(b.gid));
    V.record(t, list);
    const s = list.map((p) => p.gid + "@" + Math.round(p.x * 2) + "," + Math.round(p.y * 2) + p.color + (P.selected === p.gid ? "*" : "") + (p.bestGuess ? "?" : "")).join("|") + "|" + cues.map((c) => c.to).join(",") + "|" + (D && D.prefs && D.prefs().enabled && D.prefs().live ? 1 : 0);
    if (s === sig && !force) return; sig = s;
    const camColor = {}; for (const m of items) camColor[m.cam] = camColor[m.cam] || m.color;
    for (const w of gW.children) { const cam = w.getAttribute("data-cam"); w.style.fill = camColor[cam] || ""; w.classList.toggle("on", !!camColor[cam]); w.classList.toggle("cue", cues.some((c) => c.to === cam)); }
    gP.textContent = ""; list.forEach((p) => gP.appendChild(human(p, P.selected === p.gid)));
    legend.textContent = "";
    list.forEach((p) => { const b = document.createElement("button"); b.type = "button"; b.className = "cv-chip" + (P.selected === p.gid ? " sel" : ""); b.setAttribute("data-gid", String(p.gid)); b.setAttribute("aria-pressed", String(P.selected === p.gid)); b.innerHTML = '<i style="background:' + p.color + '"></i>' + p.name; b.title = "Highlight " + p.name + " on every camera"; legend.appendChild(b); });
    const on = D && D.prefs && D.prefs().enabled && D.prefs().live;
    hint.textContent = list.length ? "" : on ? "Nobody tracked" : "Needs object detection + Detect while playing (Settings)";
    V.place();   // the legend chips change the panel's height: keep it inside the window
    svg.setAttribute("aria-label", list.length ? "Car view: " + list.map((p) => p.name + " on " + ((T.CAM_LABEL && T.CAM_LABEL[p.cam]) || p.cam)).join(", ") : "Car view: nobody tracked");
  };
  V.refresh = () => { const now = performance.now(); if (now - last < 100) return; last = now; V.render(false); };

  // ── floating panel: place / drag / resize / pin / collapse (prefs.carPanel: { pinned, collapsed, w, fx, fy }; fx, fy = left, top as fractions of the window, -1 = default corner) ──
  const MINW = 90, MAXW = 420;
  const cfg = () => (T.prefs.carPanel && typeof T.prefs.carPanel === "object" ? T.prefs.carPanel : (T.prefs.carPanel = { pinned: false, collapsed: false, w: 0, fx: -1, fy: -1 }));
  const vpW = () => document.documentElement.clientWidth || innerWidth, vpH = () => innerHeight;
  const defW = () => (document.body.classList.contains("portrait") ? 100 : 150);
  const curW = () => { const w = cfg().w; return clamp(w > 0 ? w : defW(), MINW, Math.max(MINW, Math.min(MAXW, vpW() - 8))); };
  const save = () => { try { T.savePrefs(); } catch (_) {} };
  const rectOf = () => V.el.getBoundingClientRect();
  const setPos = (x, y) => { const r = rectOf(); x = clamp(x, 0, Math.max(0, vpW() - r.width)); y = clamp(y, 0, Math.max(0, vpH() - r.height)); V.el.style.left = Math.round(x) + "px"; V.el.style.top = Math.round(y) + "px"; };
  const keepPos = () => { const c = cfg(), r = rectOf(); c.fx = +(r.left / vpW()).toFixed(4); c.fy = +(r.top / vpH()).toFixed(4); save(); };
  V.place = () => {
    const box = V.el; if (!box || box.hidden) return;
    const c = cfg(); box.style.width = curW() + "px";
    const h = box.offsetHeight, w = box.offsetWidth;
    let x, y;
    if (c.fx >= 0 && c.fy >= 0) { x = c.fx * vpW(); y = c.fy * vpH(); }
    else {   // default corner: bottom left of the video area (above the bar in full screen)
      const st = $("stage") ? $("stage").getBoundingClientRect() : { left: 0, bottom: vpH() };
      const fs = document.body.classList.contains("fs"), tp = fs ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tp-h")) || 62 : 0;
      // ui-glass-12: in full screen stay above everything at the bottom (results strip, Search / Redact, bubble), not just the transport
      let floor = vpH() - tp; if (fs) try { if (T.overlays && T.overlays.floatFloor) floor = Math.min(floor, T.overlays.floatFloor()); const us = $("usStrip"); if (us && !us.hidden && us.offsetHeight) floor = Math.min(floor, us.getBoundingClientRect().top); } catch (_) {}
      x = st.left + 8; y = Math.min(st.bottom, floor) - h - 8;
      if (fs && floor - st.bottom >= h + 16) y = st.bottom + 8;   // a tall phone in full screen: in the black band under the picture, off the video
      else if (fs && !(c.w > 0) && st.left - 16 >= MINW) {   // a phone held sideways: narrow enough for the black band beside the picture (not saved)
        box.style.width = Math.min(curW(), Math.floor(st.left - 16)) + "px";
        const h2 = box.offsetHeight; x = 8; y = Math.max(60, Math.min(st.bottom, floor) - h2 - 8);
      }
    }
    x = clamp(x, 0, Math.max(0, vpW() - w)); y = clamp(y, 0, Math.max(0, vpH() - h));
    box.style.left = Math.round(x) + "px"; box.style.top = Math.round(y) + "px";
  };
  V.sync = () => {
    const box = V.el; if (!box) return; const c = cfg();
    box.classList.toggle("pinned", !!c.pinned); box.classList.toggle("collapsed", !!c.collapsed && !c.pinned);
    const pin = $("cvPin"), col = $("cvCollapse");
    if (pin) { pin.setAttribute("aria-pressed", String(!!c.pinned)); pin.title = c.pinned ? "Unpin: let the car view move, resize, collapse and close" : "Pin: lock the position and size"; }
    if (col) { col.setAttribute("aria-expanded", String(!(c.collapsed && !c.pinned))); col.title = c.collapsed ? "Expand" : "Collapse"; }
    const cl = $("cvClose"); if (cl) cl.disabled = !!c.pinned; if (col) col.disabled = !!c.pinned;
    const hd = $("cvHead"); if (hd) hd.title = c.pinned ? "Pinned: unpin to move it" : "Drag to move (arrow keys move it too)";   // (no aria-disabled here: the pin button lives inside the header)
    const rz = $("cvResize"); if (rz) rz.setAttribute("aria-disabled", String(!!c.pinned));
  };
  function wirePanel() {
    const box = V.el, head = $("cvHead"), rz = $("cvResize"); if (!box || !head) return;
    let drag = null;
    const end = (e) => { if (!drag) return; const d = drag; drag = null; box.classList.remove("dragging"); try { d.el.releasePointerCapture(e.pointerId); } catch (_) {} if (d.moved) { if (d.kind === "size") { cfg().w = Math.round(box.offsetWidth); } keepPos(); T.emit && T.emit("carpanel"); } };
    head.addEventListener("pointerdown", (e) => {
      if (cfg().pinned || (e.button != null && e.button > 0) || (e.target.closest && e.target.closest("button"))) return;
      const r = rectOf(); drag = { kind: "move", el: head, x: e.clientX, y: e.clientY, l: r.left, t: r.top, moved: false };
      try { head.setPointerCapture(e.pointerId); } catch (_) {} box.classList.add("dragging"); e.preventDefault();
    });
    rz.addEventListener("pointerdown", (e) => {
      if (cfg().pinned || (e.button != null && e.button > 0)) return;
      const r = rectOf(); drag = { kind: "size", el: rz, x: e.clientX, y: e.clientY, l: r.left, t: r.top, w: r.width, moved: false };
      try { rz.setPointerCapture(e.pointerId); } catch (_) {} box.classList.add("dragging"); e.preventDefault(); e.stopPropagation();
    });
    const move = (e) => {
      if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;
      if (drag.kind === "move") setPos(drag.l + dx, drag.t + dy);
      else { const w = clamp(drag.w + (dx + dy) / 2, MINW, Math.max(MINW, Math.min(MAXW, vpW() - drag.l))); box.style.width = Math.round(w) + "px"; setPos(drag.l, drag.t); }
    };
    for (const el of [head, rz]) { el.addEventListener("pointermove", move); el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end); el.addEventListener("lostpointercapture", end); }
    head.addEventListener("keydown", (e) => {   // keyboard: arrows move the panel (Shift = bigger steps)
      if (cfg().pinned || e.target !== head) return; const st = e.shiftKey ? 40 : 10, k = e.key, r = rectOf();
      const d = k === "ArrowLeft" ? [-st, 0] : k === "ArrowRight" ? [st, 0] : k === "ArrowUp" ? [0, -st] : k === "ArrowDown" ? [0, st] : null; if (!d) return;
      e.preventDefault(); setPos(r.left + d[0], r.top + d[1]); keepPos();
    });
    rz.addEventListener("keydown", (e) => {
      if (cfg().pinned) return; const k = e.key, st = e.shiftKey ? 40 : 10, g = k === "ArrowRight" || k === "ArrowDown" ? st : k === "ArrowLeft" || k === "ArrowUp" ? -st : 0; if (!g) return;
      e.preventDefault(); const r = rectOf(); box.style.width = clamp(r.width + g, MINW, Math.max(MINW, Math.min(MAXW, vpW() - r.left))) + "px"; cfg().w = Math.round(box.offsetWidth); setPos(r.left, r.top); keepPos();
    });
    $("cvPin").addEventListener("click", () => { const c = cfg(); c.pinned = !c.pinned; if (c.pinned) c.collapsed = false; V.sync(); V.place(); keepPos(); T.emit && T.emit("carpanel"); });
    $("cvCollapse").addEventListener("click", () => { const c = cfg(); if (c.pinned) return; c.collapsed = !c.collapsed; V.sync(); V.place(); keepPos(); });
    $("cvClose").addEventListener("click", () => { if (cfg().pinned) return; T.setPref("carView", false); });
    T.on("layout", () => { const c = cfg(); if (!(c.fx >= 0 && c.fy >= 0) && V.el && !V.el.hidden) V.place(); });   // ui-glass-12: the default spot follows the video (full screen re-fits it)
    addEventListener("resize", () => V.place()); addEventListener("orientationchange", () => setTimeout(V.place, 250));
    if (typeof ResizeObserver !== "undefined" && $("stage")) new ResizeObserver(() => V.place()).observe($("stage"));
    if (T.on) { T.on("prefs", () => { V.sync(); V.place(); }); }
  }

  // ── history of what the viewer showed (so the export draws the same people in the same colours), + export ──
  const BIN = 5;   // 0.2 s bins
  V.history = { ev: null, map: new Map() };
  V.record = (t, list) => {
    const H = V.history, ev = T.player && T.player.ev; if (H.ev !== ev) { H.ev = ev; H.map = new Map(); }
    if (typeof t !== "number" || !isFinite(t)) return;
    H.map.set(Math.round(t * BIN), list.map((p) => ({ x: p.x, y: p.y, color: p.color, cam: p.cam, gid: p.gid })));
  };
  V.seed = (t, items) => { const H = V.history; H.ev = T.player && T.player.ev; H.map.set(Math.round(t * BIN), items.map((p) => ({ x: p.x, y: p.y, color: p.color, cam: p.cam || null, gid: p.gid }))); };   // test hook
  let fb = null, spec = null;
  const itemsAt = (t) => {
    const H = V.history, k = Math.round(t * BIN);
    if (H.ev === (T.player && T.player.ev)) for (const d of [0, 1, -1]) { const h = H.map.get(k + d); if (h && h.length) return h; }
    if (fb) { const q = Math.round(t / fb.step); for (const d of [0, 1, -1]) { const h = fb.map.get(q + d); if (h && h.length) return h; } }
    return [];
  };
  V.itemsAt = itemsAt;
  /** Where the panel's square card sits, relative to the video grid (centre and size as fractions); also used when no panel is on screen. */
  V.exportSpec = () => {
    const g = $("grid") ? $("grid").getBoundingClientRect() : null, box = V.el;
    if (!g || !g.width || !g.height || !box || box.hidden) return { cx: 0.1, cy: 0.82, sideH: 0.27 };
    const r = box.getBoundingClientRect(), bar = box.querySelector(".cv-bar"), top = r.top + (bar ? bar.offsetHeight : 0), side = r.width;
    return { cx: (r.left + side / 2 - g.left) / g.width, cy: (top + side / 2 - g.top) / g.height, sideH: side / g.height };
  };
  /** Before an export: fix the card's place, make sure detections exist for the ranges, and build people for the moments the viewer never played. */
  V.prepareExport = async (ranges, status, cancelled) => {
    status = status || (() => {}); spec = V.exportSpec(); fb = null;
    const D = T.detect;
    try { if (D && D.prepareLive && D.prefs().enabled && D.prefs().live) await D.prepareLive(ranges, (i, k) => status("Detecting people for the car view · " + i + " of " + k + "…"), cancelled); } catch (e) { console.warn("car view: live detection for export skipped", e); }
    if (!D || !D.liveAt) return;
    const total = ranges.reduce((a, r) => a + (r[1] - r[0]), 0), step = Math.max(0.2, total / 3000), map = new Map(), active = {}; let n = 0;
    const pal = (T.people && T.people.PALETTE) || ["#ffd23f"];
    for (const r of ranges) for (let t = r[0]; t <= r[1] + 1e-6; t += step) {
      const items = [];
      for (const cam of Object.keys(CAMS)) {
        const lv = D.liveAt(cam, t), dets = ((lv && lv.dets) || []).filter((d) => d.label === "person").sort((a, b) => b.w * b.h - a.w * a.h), tr = (active[cam] = (active[cam] || []).filter((a) => t - a.t < 1.5 && t >= a.t - 1e-6)), used = new Set();
        for (const d of dets) {
          const cx = d.x + d.w / 2, cy = d.y + d.h / 2; let best = null, bd = 0.25;
          for (const a of tr) { if (used.has(a)) continue; const dd = Math.hypot(a.cx - cx, a.cy - cy); if (dd < bd) { bd = dd; best = a; } }
          if (!best) { best = { color: pal[n++ % pal.length] }; tr.push(best); }
          Object.assign(best, { cx, cy, t }); used.add(best);
          const pos = position(cam, d); if (pos) items.push({ x: pos.x, y: pos.y, color: best.color, cam, gid: "f" });
        }
      }
      map.set(Math.round(t / step), items);
    }
    fb = { step, map };
  };
  const P2 = {}, path2 = (d) => (P2[d] || (P2[d] = new Path2D(d)));
  /** Draw the diagram as a square card (side S px, top-left x, y) on a canvas: same shapes and colours as the panel. */
  V.drawCanvas = (ctx, x, y, S, items) => {
    ctx.save();
    T.draw.rr(ctx, x, y, S, S, S * 0.08); ctx.fillStyle = "rgba(10,12,18,0.74)"; ctx.fill(); ctx.strokeStyle = "rgba(255,255,255,0.14)"; ctx.lineWidth = Math.max(1, S / 150); ctx.stroke();
    const k = (S * 0.92) / 100; ctx.translate(x + S * 0.04, y + S * 0.04); ctx.scale(k, k);
    const camColor = {}; for (const p of items) if (p.cam && !camColor[p.cam]) camColor[p.cam] = p.color;
    ctx.lineJoin = "round";
    for (const cam of Object.keys(CAMS)) {
      const w = path2(wedgePath(cam, 48)), c = camColor[cam];
      ctx.fillStyle = c || "rgba(255,255,255,0.07)"; ctx.globalAlpha = c ? 0.38 : 1; ctx.fill(w); ctx.globalAlpha = 1;
      ctx.strokeStyle = c ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.22)"; ctx.lineWidth = 0.5; ctx.stroke(w);
    }
    T.draw.rr(ctx, 40, 26, 20, 48, 7); ctx.fillStyle = "#c9d1e0"; ctx.fill(); ctx.strokeStyle = "#0b0d12"; ctx.lineWidth = 0.9; ctx.stroke();
    ctx.fillStyle = "#3a4357"; ctx.fill(path2("M42.5 38 Q50 34 57.5 38 L56.5 44 L43.5 44 Z")); ctx.fill(path2("M43.5 60 L56.5 60 L57.5 65 Q50 68 42.5 65 Z"));
    ctx.fillStyle = "#fff6c2"; ctx.fillRect(41, 28, 3.4, 1.8); ctx.fillRect(55.6, 28, 3.4, 1.8);
    for (const p of items) {
      ctx.save(); ctx.translate(p.x, p.y); ctx.lineWidth = 0.9; ctx.strokeStyle = "#0b0d12"; ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(0, -3.1, 1.8, 0, Math.PI * 2); ctx.stroke(); ctx.fill();
      const b = path2("M-2.7 4.2 L-2.7 0.4 Q-2.7 -1.1 0 -1.1 Q2.7 -1.1 2.7 0.4 L2.7 4.2 Z"); ctx.stroke(b); ctx.fill(b); ctx.restore();
    }
    ctx.restore();
  };
  /** Export: draw the car view into frame (time t) inside rect `grid` (the picture area). The card keeps the relative place and size it has on
   *  screen; a card that sits (partly or fully) outside the grid is moved to the nearest edge / corner so it is fully visible. */
  V.drawExport = (ctx, grid, t) => {
    const sp = spec || V.exportSpec();
    const S = Math.max(24, Math.min(sp.sideH * grid.h, grid.w, grid.h));
    const x = clamp(grid.x + sp.cx * grid.w - S / 2, grid.x, grid.x + grid.w - S), y = clamp(grid.y + sp.cy * grid.h - S / 2, grid.y, grid.y + grid.h - S);
    V.drawCanvas(ctx, x, y, S, itemsAt(t));
    return { x, y, S };
  };
  V.clearExport = () => { spec = null; fb = null; };

  V.init = () => {
    V.build(); wirePanel(); V.sync();
    const click = (e) => { const g = e.target.closest && e.target.closest("[data-gid]"); if (!g) return; const id = g.getAttribute("data-gid"); const m = (T.people.now || []).find((x) => String(x.gid) === id); if (m) { T.people.select(m.gid); sig = ""; V.render(true); } };
    if (V.el) { V.el.addEventListener("click", click); V.el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); click(e); } }); }
    if (T.on) { T.on("time", V.refresh); T.on("player-open", () => { sig = ""; V.render(true); }); T.on("handoff", () => V.render(false)); T.on("prefs", () => V.render(true)); }
    const chip = $("chipCar");
    if (chip) {
      const sync = () => { chip.setAttribute("aria-pressed", String(V.on())); chip.classList.toggle("on", V.on()); };
      chip.addEventListener("click", () => { T.setPref("carView", !V.on()); sync(); V.render(true); });
      T.on && T.on("prefs", sync); sync();
    }
    V.render(true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(V.init, 0)); else setTimeout(V.init, 0);
})(typeof window !== "undefined" ? window : globalThis);
