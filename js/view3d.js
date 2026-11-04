/* view3d.js — 3D view (debug mode only): the road round the car in 3D, from what the app already knows.
 *  - the car's own path: telemetry speed × heading integrated over the event (matches GPS within ~0.5 m over 500 m);
 *  - the six cameras' fields of view on the road, from the rig in use (js/rig.js), with the rig's name, so a wrong vehicle
 *    profile is visible at once;
 *  - every tracked object (the user's marks, joined into objects by the hand-off): where each camera places it on the road
 *    (the box's bottom middle, rig.footprint), as a box of its measured height and width, with its trail. When two cameras
 *    see one object, each camera's own estimate is drawn as a dot joined to the object, so a disagreement shows as a line;
 *  - optionally the detector's live boxes (grey), while Detect while playing is on.
 *  Drawn on a 2D canvas with a small perspective projection (no 3D library: the app stays offline and small).
 *  Views: Chase (behind the car), Top (from above, heading up), Orbit (drag to turn, wheel or pinch to zoom).
 *  Settings ▸ Advanced & Labs ▸ Debug on → a "3D view" chip; the floating panel can be dragged by its header.
 *  World axes: x east, y up, z north (metres), from where the event starts. Pure part (egoPath, poseAt, toWorld) is node-testable. */
(function (root) {
  "use strict";
  const D2R = Math.PI / 180;

  /** Integrate the car's path from telemetry rows [[t, speed m/s, heading °], …] (t ascending) → { t, x, z, h } arrays. */
  function egoPath(rows) {
    const n = rows.length, t = new Float64Array(n), x = new Float64Array(n), z = new Float64Array(n), h = new Float64Array(n);
    let X = 0, Z = 0;
    for (let i = 0; i < n; i++) {
      if (i) { const dt = rows[i][0] - rows[i - 1][0]; if (dt > 0 && dt < 2) { const a = rows[i - 1][2] * D2R, v = rows[i - 1][1]; X += v * dt * Math.sin(a); Z += v * dt * Math.cos(a); } }
      t[i] = rows[i][0]; x[i] = X; z[i] = Z; h[i] = rows[i][2];
    }
    return { t, x, z, h, n };
  }
  /** The car's pose at time t on the path (clamped to its ends). */
  function poseAt(p, t) {
    if (!p || !p.n) return { x: 0, z: 0, h: 0 };
    if (t <= p.t[0]) return { x: p.x[0], z: p.z[0], h: p.h[0] };
    if (t >= p.t[p.n - 1]) return { x: p.x[p.n - 1], z: p.z[p.n - 1], h: p.h[p.n - 1] };
    let lo = 0, hi = p.n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p.t[m] <= t) lo = m; else hi = m; }
    const f = (t - p.t[lo]) / (p.t[hi] - p.t[lo] || 1); let dh = p.h[hi] - p.h[lo]; if (dh > 180) dh -= 360; if (dh < -180) dh += 360;
    return { x: p.x[lo] + f * (p.x[hi] - p.x[lo]), z: p.z[lo] + f * (p.z[hi] - p.z[lo]), h: p.h[lo] + f * dh };
  }
  /** Car point (x right, z forward) → world (x east, z north) at pose p. */
  function toWorld(p, cx, cz) { const a = p.h * D2R, s = Math.sin(a), c = Math.cos(a); return [p.x + cx * c + cz * s, p.z - cx * s + cz * c]; }

  const pure = { egoPath, poseAt, toWorld };
  if (typeof module === "object" && module.exports) { module.exports = pure; return; }

  const T = root.TDC; if (!T) return;
  const V = (T.view3d = Object.assign({}, pure));
  const $ = (id) => document.getElementById(id);
  const CAM_COL = { front: "#4fb3ff", back: "#ff6b9a", left_pillar: "#7ee787", right_pillar: "#e6b450", left_repeater: "#3fd0c9", right_repeater: "#c39bff" };
  const KEY = "tdc.view3d";
  const st = { open: false, view: "chase", dets: true, yaw: -35, pitch: 32, dist: 26, path: null, pathEv: null, raf: 0 };
  try { const o = JSON.parse(localStorage.getItem(KEY) || "{}"); if (o.view) st.view = o.view; if (typeof o.dets === "boolean") st.dets = o.dets; st.open = !!o.open; } catch (_) {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ view: st.view, dets: st.dets, open: st.open })); } catch (_) {} };

  // ── data ──
  function path() {
    const tel = T.telemetry, ev = tel && tel.event; if (!ev) return null;
    const sig = ev.clips.map((c, i) => (tel.tracks[i] ? tel.tracks[i].n : 0)).join(",");
    if (st.pathEv === ev && st.pathSig === sig) return st.path;
    const rows = [];
    ev.clips.forEach((c, i) => { const tr = tel.tracks[i]; if (!tr) return; for (let k = 0; k < tr.n; k++) { const m = tr.msgs[k]; if (isFinite(m.speed) && isFinite(m.heading)) rows.push([c.start + tr.pts[k], Math.max(0, m.speed), m.heading]); } });
    rows.sort((a, b) => a[0] - b[0]);
    st.path = rows.length > 1 ? egoPath(rows) : null; st.pathEv = ev; st.pathSig = sig;
    return st.path;
  }
  const clk = (cam) => { try { return T.rig.clock(cam) || 0; } catch (_) { return 0; } };
  /** Where a box seen on `cam` at player time t stands in the world, or null. */
  function place(P, cam, box, t) {
    const R = T.rig; if (!R || !box) return null;
    if (R.bodyShare && R.bodyShare(cam, box) > 0.5) return null;
    const f = R.footprint(cam, box, 80); if (!f) return null;
    const pose = poseAt(P, t + clk(cam)), w = toWorld(pose, f.x, f.z);
    return { x: w[0], z: w[1], h: pose.h, dist: f.dist, hM: isFinite(f.hM) ? Math.min(4, Math.max(0.3, f.hM)) : 1.5, wM: isFinite(f.wM) ? Math.min(3.5, Math.max(0.3, f.wM)) : 1.8 };
  }
  function objectsAt(P, t) {
    const G = T.customRedact || T.regions, PT = T.patchTrack; if (!G || !G.objects || !PT) return [];
    const out = [];
    for (const o of G.objects()) {
      const est = [], trails = [];
      let color = null;
      for (const r of o.marks) {
        if (!r.on || !r.path) continue;
        color = color || (G.color ? G.color(r) : "#e6b450");
        const covers = t >= r.path[0] - 0.1 && t <= r.path[r.path.length - 5] + 0.5;   // only while this camera's track covers the moment
        const b = covers ? PT.pathAt(r.path, t) : null; if (b) { const p = place(P, r.cam, b, t); if (p) est.push(Object.assign(p, { cam: r.cam })); }
        const tr = []; for (let i = 0; i < r.path.length; i += 5) { if (!(r.path[i + 3] > 0)) continue; if (tr.length && r.path[i] - tr[tr.length - 1].t < 0.2) continue; const p = place(P, r.cam, { x: r.path[i + 1], y: r.path[i + 2], w: r.path[i + 3], h: r.path[i + 4] }, r.path[i]); if (p) tr.push({ t: r.path[i], x: p.x, z: p.z }); }
        if (tr.length > 1) trails.push({ cam: r.cam, pts: tr });
      }
      if (!est.length && !trails.length) continue;
      const m = est.length ? { x: est.reduce((s, e) => s + e.x, 0) / est.length, z: est.reduce((s, e) => s + e.z, 0) / est.length, hM: Math.max(...est.map((e) => e.hM)), wM: Math.max(...est.map((e) => e.wM)), h: est[0].h, dist: Math.min(...est.map((e) => e.dist)) } : null;
      out.push({ n: o.n, color: color || "#e6b450", est, trails, at: m });
    }
    return out;
  }
  function detsAt(P, t) {
    const D = T.detect; if (!st.dets || !D || !D.trackedLive) return [];
    const out = [];
    for (const cam of T.rig.CAMS) { const l = D.trackedLive(cam, t); if (l) for (const b of l) { const p = place(P, cam, b, t); if (p && p.dist < 60) out.push(Object.assign(p, { label: b.label })); } }
    return out;
  }
  /** A camera's field of view on the road: a fan from the camera out to `far` metres (car coordinates), or null. */
  const fanCache = {};
  function fan(cam, far) {
    const R = T.rig, c = R.get(cam); if (!c) return null;
    const sig = cam + JSON.stringify([c.yaw, c.pitch, c.f, c.pos]); if (fanCache[cam] && fanCache[cam].sig === sig) return fanCache[cam].pts;
    const pts = [[c.pos[0], c.pos[2]]];
    for (let u = 0.01; u <= 0.991; u += 0.035) {
      let d = null; for (const v of [0.5, 0.55, 0.45, 0.6, 0.4]) { d = R.ray(cam, u, v); if (d) break; }
      if (!d) continue; const l = Math.hypot(d[0], d[2]); if (l < 1e-3) continue;
      pts.push([c.pos[0] + d[0] / l * far, c.pos[2] + d[2] / l * far]);
    }
    fanCache[cam] = { sig, pts: pts.length > 2 ? pts : null };
    return fanCache[cam].pts;
  }

  // ── tiny 3D: camera, projection with near-plane clipping, painter's order ──
  function camera(W, H, pose) {
    let eye, tgt;
    const a = pose.h * D2R, fw = [Math.sin(a), Math.cos(a)];
    if (st.view === "top") { tgt = [pose.x + fw[0] * 4, 0, pose.z + fw[1] * 4]; eye = [tgt[0] - fw[0] * 0.01, 55, tgt[2] - fw[1] * 0.01]; }
    else if (st.view === "chase") { tgt = [pose.x + fw[0] * 8, 0.5, pose.z + fw[1] * 8]; eye = [pose.x - fw[0] * 14, 8, pose.z - fw[1] * 14]; }
    else { const y = (pose.h + st.yaw) * D2R, p = st.pitch * D2R; tgt = [pose.x, 0.5, pose.z]; eye = [tgt[0] - Math.sin(y) * Math.cos(p) * st.dist, tgt[1] + Math.sin(p) * st.dist, tgt[2] - Math.cos(y) * Math.cos(p) * st.dist]; }
    const f = norm([tgt[0] - eye[0], tgt[1] - eye[1], tgt[2] - eye[2]]);
    let r = norm(cross([0, 1, 0], f)); if (!isFinite(r[0])) r = [1, 0, 0];
    const u = cross(f, r), F = Math.min(W, H) * 1.1;
    return { eye, f, r, u, F, cx: W / 2, cy: H / 2 };
  }
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
  const NEAR = 0.3;
  const toCam = (C, p) => { const d = [p[0] - C.eye[0], p[1] - C.eye[1], p[2] - C.eye[2]]; return [d[0] * C.r[0] + d[1] * C.r[1] + d[2] * C.r[2], d[0] * C.u[0] + d[1] * C.u[1] + d[2] * C.u[2], d[0] * C.f[0] + d[1] * C.f[1] + d[2] * C.f[2]]; };
  const scr = (C, q) => [C.cx + C.F * q[0] / q[2], C.cy - C.F * q[1] / q[2]];
  function clipPoly(C, pts) {   // world points → screen polygon (clipped at the near plane) + mean depth
    const q = pts.map((p) => toCam(C, p)), out = [];
    for (let i = 0; i < q.length; i++) {
      const a = q[i], b = q[(i + 1) % q.length], ia = a[2] >= NEAR, ib = b[2] >= NEAR;
      if (ia) out.push(a);
      if (ia !== ib) { const k = (NEAR - a[2]) / (b[2] - a[2]); out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, NEAR]); }
    }
    if (out.length < 2) return null;
    return { s: out.map((x) => scr(C, x)), z: out.reduce((s, x) => s + x[2], 0) / out.length };
  }
  function line(ctx, C, a, b) {
    let p = toCam(C, a), q = toCam(C, b);
    if (p[2] < NEAR && q[2] < NEAR) return;
    if (p[2] < NEAR) { const k = (NEAR - p[2]) / (q[2] - p[2]); p = [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, NEAR]; }
    if (q[2] < NEAR) { const k = (NEAR - q[2]) / (p[2] - q[2]); q = [q[0] + (p[0] - q[0]) * k, q[1] + (p[1] - q[1]) * k, NEAR]; }
    const s = scr(C, p), e = scr(C, q); ctx.moveTo(s[0], s[1]); ctx.lineTo(e[0], e[1]);
  }
  /** Faces of an upright box standing at (x, z), turned to heading h (degrees), w wide, l long, ht tall. */
  function boxFaces(x, z, h, w, l, ht) {
    const a = h * D2R, s = Math.sin(a), c = Math.cos(a), cn = [];
    for (const [dx, dz] of [[-w / 2, -l / 2], [w / 2, -l / 2], [w / 2, l / 2], [-w / 2, l / 2]]) cn.push([x + dx * c + dz * s, z - dx * s + dz * c]);
    const P = (i, y) => [cn[i][0], y, cn[i][1]], f = [];
    for (let i = 0; i < 4; i++) f.push([P(i, 0), P((i + 1) % 4, 0), P((i + 1) % 4, ht), P(i, ht)]);
    f.push([P(0, ht), P(1, ht), P(2, ht), P(3, ht)]);
    return f;
  }

  // ── drawing ──
  function draw() {
    st.raf = 0;
    const cv = $("v3dCanvas"); if (!st.open || !cv || !V.el || V.el.hidden) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(V.el);
    ctx.fillStyle = "#0b1016"; ctx.fillRect(0, 0, W, H);
    const P = path(), t = T.player ? T.player.time || 0 : 0, pose = poseAt(P, t), C = camera(W, H, pose);
    const info = $("v3dInfo");
    if (!P) { ctx.fillStyle = "#93a3ab"; ctx.font = "12px system-ui"; ctx.textAlign = "center"; ctx.fillText(T.telemetry && T.telemetry.status === "parsing" ? "Reading the car's telemetry…" : "No telemetry in this event: the 3D view needs speed and heading.", W / 2, H / 2); if (info) info.textContent = ""; return; }

    // ground grid (5 m), centred on the car
    ctx.beginPath(); ctx.strokeStyle = "rgba(147,163,171,0.13)"; ctx.lineWidth = 1;
    const gx = Math.round(pose.x / 5) * 5, gz = Math.round(pose.z / 5) * 5, R = 60;
    for (let k = -R; k <= R; k += 5) { line(ctx, C, [gx + k, 0, gz - R], [gx + k, 0, gz + R]); line(ctx, C, [gx - R, 0, gz + k], [gx + R, 0, gz + k]); }
    ctx.stroke();
    // the car's path: driven (solid) and still to come (dashed)
    const drawPath = (a, b, dash, col) => { ctx.beginPath(); ctx.setLineDash(dash); ctx.strokeStyle = col; ctx.lineWidth = 2; let prev = null; for (let i = 0; i < P.n; i++) { if (P.t[i] < a || P.t[i] > b) continue; if (prev && Math.hypot(P.x[i] - pose.x, P.z[i] - pose.z) < 90) line(ctx, C, [prev[0], 0.02, prev[1]], [P.x[i], 0.02, P.z[i]]); prev = [P.x[i], P.z[i]]; } ctx.stroke(); ctx.setLineDash([]); };
    drawPath(-1e9, t, [], "rgba(230,236,239,0.35)"); drawPath(t, 1e9, [4, 5], "rgba(230,236,239,0.22)");

    // camera fields of view on the road
    const RG = T.rig;
    for (const cam of RG.CAMS) {
      const f = fan(cam, 30); if (!f) continue;
      const poly = clipPoly(C, f.map(([x, z]) => { const w = toWorld(pose, x, z); return [w[0], 0.01, w[1]]; })); if (!poly) continue;
      ctx.beginPath(); poly.s.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath();
      ctx.fillStyle = CAM_COL[cam] + "1c"; ctx.fill(); ctx.strokeStyle = CAM_COL[cam] + "55"; ctx.lineWidth = 1; ctx.stroke();
    }

    // solids, painter's order: the car, detector boxes, objects
    const faces = [];
    const addBox = (x, z, h, w, l, ht, fill, edge, tag) => { for (const q of boxFaces(x, z, h, w, l, ht)) { const p = clipPoly(C, q); if (p) faces.push({ p, fill, edge, tag }); } };
    { const mid = toWorld(pose, 0, 1.4); addBox(mid[0], mid[1], pose.h, 2.0, 5.06, 1.68, "rgba(233,238,241,0.85)", "rgba(20,26,30,0.6)"); }
    const dets = detsAt(P, t); for (const d of dets) addBox(d.x, d.z, d.h, d.wM, Math.max(1, d.wM), d.hM, "rgba(147,163,171,0.18)", "rgba(147,163,171,0.55)");
    const objs = objectsAt(P, t);
    for (const o of objs) if (o.at) addBox(o.at.x, o.at.z, o.at.h, o.at.wM, Math.max(1, Math.min(4.5, o.at.wM)), o.at.hM, o.color + "bb", "rgba(255,255,255,0.6)", o);
    faces.sort((a, b) => b.p.z - a.p.z);
    for (const f of faces) { ctx.beginPath(); f.p.s.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.fillStyle = f.fill; ctx.fill(); ctx.strokeStyle = f.edge; ctx.lineWidth = 1; ctx.stroke(); }

    // trails, each camera's own estimate (dot + line to the joined position), labels
    ctx.font = "600 11px system-ui"; ctx.textAlign = "center";
    for (const o of objs) {
      for (const tr of o.trails) { ctx.beginPath(); ctx.strokeStyle = o.color; ctx.globalAlpha = 0.75; ctx.lineWidth = 1.5; for (let i = 1; i < tr.pts.length; i++) { const a = tr.pts[i - 1], b = tr.pts[i]; if (b.t - a.t < 1.5) line(ctx, C, [a.x, 0.05, a.z], [b.x, 0.05, b.z]); } ctx.stroke(); ctx.globalAlpha = 1; }
      if (!o.at) continue;
      for (const e of o.est) {
        const q = toCam(C, [e.x, 0.1, e.z]); if (q[2] < NEAR) continue; const s = scr(C, q);
        if (o.est.length > 1) { ctx.beginPath(); ctx.strokeStyle = CAM_COL[e.cam]; ctx.lineWidth = 1.5; line(ctx, C, [e.x, 0.1, e.z], [o.at.x, 0.1, o.at.z]); ctx.stroke(); }
        ctx.beginPath(); ctx.fillStyle = CAM_COL[e.cam]; ctx.arc(s[0], s[1], 3.5, 0, 7); ctx.fill();
      }
      const q = toCam(C, [o.at.x, o.at.hM + 0.5, o.at.z]); if (q[2] < NEAR) continue; const s = scr(C, q);
      const spread = o.est.length > 1 ? Math.max(...o.est.map((e) => Math.hypot(e.x - o.at.x, e.z - o.at.z))) * 2 : 0;
      const txt = "#" + o.n + " · " + o.at.dist.toFixed(1) + " m" + (spread > 0.05 ? " · cams " + spread.toFixed(1) + " m apart" : "");
      const tw = ctx.measureText(txt).width + 10; ctx.fillStyle = "rgba(11,16,22,0.8)"; ctx.fillRect(s[0] - tw / 2, s[1] - 15, tw, 17); ctx.fillStyle = o.color; ctx.fillText(txt, s[0], s[1] - 3);
    }
    if (info) {
      const cur = RG.current ? RG.current() : {}, name = cur.name || (RG.PRESETS && cur.preset && RG.PRESETS[cur.preset] ? RG.PRESETS[cur.preset].name : cur.preset) || "custom";
      info.textContent = "Camera geometry: " + name + " (" + (cur.source || "?") + ") · " + objs.length + " tracked · " + dets.length + " detected";
    }
  }
  V.refresh = () => { if (st.open && !st.raf) st.raf = requestAnimationFrame(draw); };
  V.isOpen = () => st.open;

  // ── panel ──
  function build() {
    if (V.el) return V.el;
    const box = document.createElement("div"); box.id = "view3d"; box.className = "view3d"; box.hidden = true;
    box.innerHTML = '<div class="v3d-bar" id="v3dHead" title="Drag to move"><b>3D view</b><span class="v3d-tag">debug</span>' +
      '<span class="v3d-views" role="group" aria-label="Camera">' +
      '<button type="button" data-v="chase">Chase</button><button type="button" data-v="top">Top</button><button type="button" data-v="orbit" title="Drag to turn, wheel to zoom">Orbit</button></span>' +
      '<button type="button" id="v3dDets" title="Show the detector\'s live boxes (needs Detect while playing)">Detections</button>' +
      '<button type="button" class="v3d-x" id="v3dClose" aria-label="Close the 3D view">×</button></div>' +
      '<canvas id="v3dCanvas"></canvas><div class="v3d-info" id="v3dInfo"></div>' +
      '<div class="v3d-key">Dots: where each camera puts the object. A line between them = the cameras disagree.</div>';
    document.body.appendChild(box); V.el = box;
    const sync = () => { box.querySelectorAll("[data-v]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === st.view))); $("v3dDets").setAttribute("aria-pressed", String(st.dets)); };
    box.querySelectorAll("[data-v]").forEach((b) => b.addEventListener("click", () => { st.view = b.dataset.v; save(); sync(); V.refresh(); }));
    $("v3dDets").addEventListener("click", () => { st.dets = !st.dets; save(); sync(); V.refresh(); });
    $("v3dClose").addEventListener("click", () => V.setOpen(false));
    sync();
    // drag the panel by its header
    const head = $("v3dHead"); let drag = null;
    head.addEventListener("pointerdown", (e) => { if (e.target.closest("button")) return; const r = box.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }; head.setPointerCapture(e.pointerId); e.preventDefault(); });
    head.addEventListener("pointermove", (e) => { if (!drag) return; box.style.left = Math.max(0, Math.min(innerWidth - 80, e.clientX - drag.dx)) + "px"; box.style.top = Math.max(0, Math.min(innerHeight - 40, e.clientY - drag.dy)) + "px"; box.style.right = "auto"; box.style.bottom = "auto"; });
    head.addEventListener("pointerup", () => { drag = null; });
    // orbit: drag on the picture turns, wheel zooms (switches to Orbit)
    const cv = $("v3dCanvas"); let orb = null;
    cv.addEventListener("pointerdown", (e) => { orb = { x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); if (st.view !== "orbit") { st.view = "orbit"; sync(); save(); } });
    cv.addEventListener("pointermove", (e) => { if (!orb) return; st.yaw += (e.clientX - orb.x) * 0.4; st.pitch = Math.max(5, Math.min(85, st.pitch + (e.clientY - orb.y) * 0.3)); orb = { x: e.clientX, y: e.clientY }; V.refresh(); });
    cv.addEventListener("pointerup", () => { orb = null; });
    cv.addEventListener("wheel", (e) => { e.preventDefault(); if (st.view !== "orbit") { st.view = "orbit"; sync(); save(); } st.dist = Math.max(6, Math.min(90, st.dist * Math.exp(e.deltaY * 0.0015))); V.refresh(); }, { passive: false });
    return box;
  }
  V.setOpen = (on) => {
    st.open = !!on; save(); build();
    V.el.hidden = !(st.open && T.debugOn && T.debugOn());
    const chip = $("chip3d"); if (chip) { chip.setAttribute("aria-pressed", String(st.open)); chip.classList.toggle("on", st.open); }
    V.refresh();
  };

  function init() {
    const chip = $("chip3d");
    if (chip) chip.addEventListener("click", () => V.setOpen(!st.open));
    if (T.on) {
      ["time", "player-open", "telemetry", "handoff", "regions"].forEach((ev) => T.on(ev, V.refresh));
      T.on("prefs", () => V.setOpen(st.open));
    }
    V.setOpen(st.open);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})(typeof self !== "undefined" ? self : this);
