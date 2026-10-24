/* Car view (Hand-off, milestone 3): a small top-down car with the six camera wedges and a tiny person (head + body) for every tracked
   person, in that person's colour (the same colour as their boxes on the tiles). Position is an estimate: the camera's heading plus the box's
   horizontal position gives the bearing, the box height gives the distance (bigger = closer). Tap a person (or a legend chip) to
   highlight their boxes on every camera. On/off with the "Car view" chip (remembered). Pure part is node-testable (test/handoff.test.js). */
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
    box.innerHTML = '<div class="cv-legend" aria-label="People"></div><div class="cv-hint"></div>';
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
    box.insertBefore(svg, box.firstChild); stage.appendChild(box);
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
    V.el.hidden = !show; if (!show) return;
    const P = T.people, t = T.player.time || 0, D = T.detect, ppl = P && P.current ? P.current(t) : [];
    const cues = (T.handoff && T.handoff.cues) || [];
    const items = ppl.map((m) => { const pos = position(m.cam, { x: m.x, y: m.y, w: m.w, h: m.h }); return pos ? Object.assign({ pos }, m, { x: pos.x, y: pos.y, name: P.name(m), box: { x: m.x, y: m.y, w: m.w, h: m.h } }) : null; }).filter(Boolean);
    // one icon per person: when several cameras see the same person, use the most recently seen box
    const byG = new Map(); for (const it of items) { const o = byG.get(it.gid); if (!o || it.seen > o.seen) byG.set(it.gid, it); }
    const list = [...byG.values()].sort((a, b) => P.num(a.gid) - P.num(b.gid));
    const s = list.map((p) => p.gid + "@" + Math.round(p.x * 2) + "," + Math.round(p.y * 2) + p.color + (P.selected === p.gid ? "*" : "") + (p.bestGuess ? "?" : "")).join("|") + "|" + cues.map((c) => c.to).join(",") + "|" + (D && D.prefs && D.prefs().enabled && D.prefs().live ? 1 : 0);
    if (s === sig && !force) return; sig = s;
    const camColor = {}; for (const m of items) camColor[m.cam] = camColor[m.cam] || m.color;
    for (const w of gW.children) { const cam = w.getAttribute("data-cam"); w.style.fill = camColor[cam] || ""; w.classList.toggle("on", !!camColor[cam]); w.classList.toggle("cue", cues.some((c) => c.to === cam)); }
    gP.textContent = ""; list.forEach((p) => gP.appendChild(human(p, P.selected === p.gid)));
    legend.textContent = "";
    list.forEach((p) => { const b = document.createElement("button"); b.type = "button"; b.className = "cv-chip" + (P.selected === p.gid ? " sel" : ""); b.setAttribute("data-gid", String(p.gid)); b.setAttribute("aria-pressed", String(P.selected === p.gid)); b.innerHTML = '<i style="background:' + p.color + '"></i>' + p.name; b.title = "Highlight " + p.name + " on every camera"; legend.appendChild(b); });
    const on = D && D.prefs && D.prefs().enabled && D.prefs().live;
    hint.textContent = list.length ? "" : on ? "Nobody tracked" : "Needs object detection + Detect while playing (Settings)";
    svg.setAttribute("aria-label", list.length ? "Car view: " + list.map((p) => p.name + " on " + ((T.CAM_LABEL && T.CAM_LABEL[p.cam]) || p.cam)).join(", ") : "Car view: nobody tracked");
  };
  V.refresh = () => { const now = performance.now(); if (now - last < 100) return; last = now; V.render(false); };

  V.init = () => {
    V.build();
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
