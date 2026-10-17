/* pano.js — 360 view (prototype). Loaded on demand by pano-toggle.js.
 * WebGL2 (WebGL1 fallback) shader: the six synced camera videos are textures. For every output pixel we take a
 * direction around the car, rotate it into each camera (yaw/pitch/roll), project it through a fisheye/wide lens
 * model (Kannala–Brandt: θd = θ(1 + k1θ² + k2θ⁴ + k3θ⁶ + k4θ⁸), or rectilinear), and feather-blend the cameras
 * that see it. Directions no camera sees are dark. Views: perspective look-around (drag / pinch / wheel / optional
 * gyro) or flat equirectangular (2:1).
 * Camera parameters are ESTIMATES from public info (Tesla: main forward ~50°, wide forward 120° fisheye,
 * B-pillar "forward looking side" 90°, fender repeaters aimed ~45° toward the rear, rear camera wide/fisheye).
 * Mounting offsets are recorded but not used yet (everything is projected as if at infinity), so near objects in
 * the overlaps show parallax/ghosting. Calibration panel: Advanced mode ▸ 360 ▸ Calibrate. */
(function () {
  "use strict";
  const T = window.TDC;
  const CAMS = ["front", "back", "left_pillar", "right_pillar", "left_repeater", "right_repeater"];
  const KEY = "tdc.pano.calib.v1", VKEY = "tdc.pano.view.v1";
  // yaw: + = to the right of straight ahead; pitch: + = up; fov = horizontal degrees; pos = metres (x right, y up, z forward) — not used yet
  const DEFAULTS = {
    front:          { yaw: 0,    pitch: -3,  roll: 0, fov: 70,  model: "rect", k1: 0, k2: 0, k3: 0, k4: 0, cx: 0, cy: 0, flip: false, pos: [0, 1.3, 0.6] },
    back:           { yaw: 180,  pitch: -18, roll: 0, fov: 125, model: "kb",   k1: 0, k2: 0, k3: 0, k4: 0, cx: 0, cy: 0, flip: false, pos: [0, 1.0, -2.3] },
    left_pillar:    { yaw: -58,  pitch: -6,  roll: 0, fov: 90,  model: "kb",   k1: 0, k2: 0, k3: 0, k4: 0, cx: 0, cy: 0, flip: false, pos: [-0.85, 1.2, -0.1] },
    right_pillar:   { yaw: 58,   pitch: -6,  roll: 0, fov: 90,  model: "kb",   k1: 0, k2: 0, k3: 0, k4: 0, cx: 0, cy: 0, flip: false, pos: [0.85, 1.2, -0.1] },
    left_repeater:  { yaw: -132, pitch: -8,  roll: 0, fov: 85,  model: "kb",   k1: 0, k2: 0, k3: 0, k4: 0, cx: 0, cy: 0, flip: false, pos: [-0.95, 0.9, 1.2] },
    right_repeater: { yaw: 132,  pitch: -8,  roll: 0, fov: 85,  model: "kb",   k1: 0, k2: 0, k3: 0, k4: 0, cx: 0, cy: 0, flip: false, pos: [0.95, 0.9, 1.2] },
  };
  const isMobile = () => { try { return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || matchMedia("(pointer: coarse)").matches; } catch (_) { return false; } };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const N = (T.pano = { on: false, CAMS, DEFAULTS, mode: "look", yaw: 0, pitch: -5, fov: 90, gl: null, gl2: false, frames: 0, scale: isMobile() ? 0.5 : 1 });

  // ── calibration storage ──
  N.calib = () => {
    const c = clone(DEFAULTS);
    try { const v = JSON.parse(localStorage.getItem(KEY) || "null"); if (v && typeof v === "object") for (const cam of CAMS) if (v[cam]) Object.assign(c[cam], sanitize(v[cam])); } catch (_) {}
    return c;
  };
  function sanitize(o) {
    const out = {}; const num = (k, lo, hi) => { const n = +o[k]; if (isFinite(n)) out[k] = Math.max(lo, Math.min(hi, n)); };
    num("yaw", -360, 360); num("pitch", -90, 90); num("roll", -180, 180); num("fov", 20, 220); for (const k of ["k1", "k2", "k3", "k4"]) num(k, -2, 2); num("cx", -0.5, 0.5); num("cy", -0.5, 0.5);
    if (o.model === "rect" || o.model === "kb") out.model = o.model; if (typeof o.flip === "boolean") out.flip = o.flip;
    if (Array.isArray(o.pos) && o.pos.length === 3 && o.pos.every((x) => isFinite(+x))) out.pos = o.pos.map(Number);
    return out;
  }
  N.saveCalib = (c) => { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (_) {} N.dirty = true; };
  N.resetCalib = () => { try { localStorage.removeItem(KEY); } catch (_) {} N.dirty = true; };
  N.exportCalib = () => JSON.stringify({ type: "tdc-pano-calibration", version: 1, cameras: N.calib() }, null, 2);
  N.importCalib = (text) => { const j = JSON.parse(text); const cams = j && (j.cameras || j); if (!cams || typeof cams !== "object") throw new Error("not a calibration file"); const c = N.calib(); let n = 0; for (const cam of CAMS) if (cams[cam]) { Object.assign(c[cam], sanitize(cams[cam])); n++; } if (!n) throw new Error("no cameras in the file"); N.saveCalib(c); return n; };

  // ── math ──
  const rad = (d) => (d * Math.PI) / 180;
  /** camera→world rotation (column-major mat3 for GL): R = Ry(yaw) · Rx(pitch) · Rz(roll); world: x right, y up, z forward. */
  function rot(yaw, pitch, roll) {
    const cy = Math.cos(rad(yaw)), sy = Math.sin(rad(yaw)), cp = Math.cos(rad(pitch)), sp = Math.sin(rad(pitch)), cr = Math.cos(rad(roll)), sr = Math.sin(rad(roll));
    // Ry: [cy 0 sy; 0 1 0; -sy 0 cy], Rx(pitch up = rotate z toward +y): [1 0 0; 0 cp sp; 0 -sp cp]·… use explicit product
    const Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], Rx = [[1, 0, 0], [0, cp, sp], [0, -sp, cp]], Rz = [[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]];
    const mul = (A, B) => A.map((r, i) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
    return mul(mul(Ry, Rx), Rz);
  }
  N.rot = rot;
  const kb = (th, c) => { const t2 = th * th; return th * (1 + t2 * (c.k1 + t2 * (c.k2 + t2 * (c.k3 + t2 * c.k4)))); };
  /** JS twin of the shader projection (used by tests): world dir → {u,v} in 0..1 of camera image, or null. */
  N.project = (d, c, aspect) => {
    const R = rot(c.yaw, c.pitch, c.roll);
    const x = R[0][0] * d[0] + R[1][0] * d[1] + R[2][0] * d[2], y = R[0][1] * d[0] + R[1][1] * d[1] + R[2][1] * d[2], z = R[0][2] * d[0] + R[1][2] * d[1] + R[2][2] * d[2];
    const th = Math.acos(Math.max(-1, Math.min(1, z / Math.hypot(x, y, z)))), half = rad(c.fov / 2);
    if (c.model === "rect" && th >= Math.PI / 2 - 0.01) return null;
    const r = c.model === "rect" ? Math.tan(th) / Math.tan(half) : kb(th, c) / kb(half, c);
    const l = Math.hypot(x, y) || 1;
    let u = 0.5 + c.cx + 0.5 * r * (x / l), v = 0.5 + c.cy - 0.5 * r * (y / l) * aspect;
    if (c.flip) u = 1 - u;
    return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? { u, v } : null;
  };

  // ── GL ──
  const VS1 = "attribute vec2 p; varying vec2 q; void main(){ q = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }";
  const FS_BODY = `
uniform sampler2D t0, t1, t2, t3, t4, t5;
uniform mat3 R[6]; uniform vec4 L[6]; uniform vec4 K[6]; uniform vec4 C[6];
uniform int mode; uniform mat3 V; uniform vec2 tanh; uniform float feather;
const float PI = 3.14159265;
float kb(float th, vec4 k) { float t2 = th * th; return th * (1.0 + t2 * (k.x + t2 * (k.y + t2 * (k.z + t2 * k.w)))); }
// L = (enabled, halfFov rad, aspect h/w, model: 0 kb / 1 rect); C = (cx, cy, flip, 0)
vec4 cam(sampler2D tex, mat3 Ri, vec4 l, vec4 k, vec4 c, vec3 d) {
  if (l.x < 0.5) return vec4(0.0);
  vec3 p = d * Ri;                       // world → camera (Ri is camera→world, orthonormal)
  float th = acos(clamp(p.z / length(p), -1.0, 1.0));
  float r;
  if (l.w > 0.5) { if (th > 1.5) return vec4(0.0); r = tan(th) / tan(l.y); }
  else { r = kb(th, k) / kb(l.y, k); }
  float len = max(length(p.xy), 1e-6);
  vec2 uv = vec2(0.5 + c.x + 0.5 * r * p.x / len, 0.5 + c.y - 0.5 * r * (p.y / len) * l.z);
  if (c.z > 0.5) uv.x = 1.0 - uv.x;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  float e = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  float w = smoothstep(0.0, feather, e) * max(0.05, 1.0 - th / (l.y * 1.15));   // feather at edges + favour the centre (angular weight)
  return vec4(TEX(tex, uv).rgb * w, w);
}
void main() {
  vec3 d;
  if (mode == 1) { float lon = (q.x - 0.5) * 2.0 * PI, lat = (q.y - 0.5) * PI; d = vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon)); }
  else { d = normalize(V * vec3((q.x * 2.0 - 1.0) * tanh.x, (q.y * 2.0 - 1.0) * tanh.y, 1.0)); }
  vec4 a = cam(t0, R[0], L[0], K[0], C[0], d) + cam(t1, R[1], L[1], K[1], C[1], d) + cam(t2, R[2], L[2], K[2], C[2], d)
         + cam(t3, R[3], L[3], K[3], C[3], d) + cam(t4, R[4], L[4], K[4], C[4], d) + cam(t5, R[5], L[5], K[5], C[5], d);
  vec3 dark = vec3(0.06, 0.065, 0.075) + 0.02 * step(0.5, fract((d.y + 2.0) * 6.0));   // blind spot: dark, faint bands so it reads as "no camera"
  OUT = vec4(a.w > 0.002 ? a.rgb / a.w : dark, 1.0);
}`;
  const FS1 = "precision highp float; varying vec2 q;\n#define TEX texture2D\n#define OUT gl_FragColor\n" + FS_BODY;
  const VS2 = "#version 300 es\nin vec2 p; out vec2 q; void main(){ q = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }";
  const FS2 = "#version 300 es\nprecision highp float; in vec2 q; out vec4 fragColor;\n#define TEX texture\n#define OUT fragColor\n" + FS_BODY;

  function compile(gl, type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const e = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error("shader: " + e); } return s; }
  /** Create a renderer on a canvas. Returns null (and N.error) if WebGL is unavailable. */
  N.makeRenderer = (canvas, prefer1) => {
    let gl = null, two = false;
    const opt = { alpha: false, antialias: false, preserveDrawingBuffer: true, powerPreference: "low-power" };
    if (!prefer1) { try { gl = canvas.getContext("webgl2", opt); two = !!gl; } catch (_) {} }
    if (!gl) { try { gl = canvas.getContext("webgl", opt) || canvas.getContext("experimental-webgl", opt); } catch (_) {} }
    if (!gl) { N.error = "WebGL isn't available in this browser"; return null; }
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, two ? VS2 : VS1));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, two ? FS2 : FS1));
    gl.bindAttribLocation(prog, 0, "p");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const U = (n) => gl.getUniformLocation(prog, n);
    const tex = CAMS.map((_, i) => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      gl.uniform1i(U("t" + i), i); return t; });
    const loc = { R: U("R"), L: U("L"), K: U("K"), C: U("C"), mode: U("mode"), V: U("V"), tanh: U("tanh"), feather: U("feather") };
    const r = { gl, two, canvas, lost: false };
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); r.lost = true; }, false);
    /** frames: { cam: { img, w, h } | null }; view: { mode: "look"|"equirect", yaw, pitch, fov } */
    r.draw = (frames, view, calib, W, H) => {
      if (r.lost) return false;
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      gl.viewport(0, 0, W, H);
      const Rm = new Float32Array(54), Lv = new Float32Array(24), Kv = new Float32Array(24), Cv = new Float32Array(24);
      CAMS.forEach((cam, i) => {
        const c = calib[cam], f = frames[cam], M = rot(c.yaw, c.pitch, c.roll);
        for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) Rm[i * 9 + col * 3 + row] = M[row][col];
        const ok = !!(f && f.img && f.w && f.h);
        if (ok) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tex[i]); try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f.img); } catch (e) { console.warn("pano texture", cam, e); } }
        Lv.set([ok ? 1 : 0, rad(c.fov / 2), ok ? f.h / f.w : 0.75, c.model === "rect" ? 1 : 0], i * 4);
        Kv.set([c.k1, c.k2, c.k3, c.k4], i * 4); Cv.set([c.cx, c.cy, c.flip ? 1 : 0, 0], i * 4);
      });
      gl.uniformMatrix3fv(loc.R, false, Rm); gl.uniform4fv(loc.L, Lv); gl.uniform4fv(loc.K, Kv); gl.uniform4fv(loc.C, Cv);
      gl.uniform1i(loc.mode, view.mode === "equirect" ? 1 : 0); gl.uniform1f(loc.feather, 0.06);
      const VM = rot(view.yaw, view.pitch, 0), Vf = new Float32Array(9);
      for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) Vf[col * 3 + row] = VM[row][col];
      gl.uniformMatrix3fv(loc.V, false, Vf);
      const th = Math.tan(rad(view.fov / 2)); gl.uniform2f(loc.tanh, th, th * H / W);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    };
    return r;
  };

  // ── live view ──
  let wrap = null, canvas = null, R = null, raf = 0, calibUI = null;
  N.view = () => { try { const v = JSON.parse(localStorage.getItem(VKEY) || "null"); if (v) { if (v.mode === "equirect" || v.mode === "look") N.mode = v.mode; } } catch (_) {} return { mode: N.mode, yaw: N.yaw, pitch: N.pitch, fov: N.fov }; };
  const saveView = () => { try { localStorage.setItem(VKEY, JSON.stringify({ mode: N.mode })); } catch (_) {} };
  N.liveFrames = () => {
    const P = T.player, out = {};
    for (const cam of CAMS) { const t = P.tiles && P.tiles[cam], v = t && t.vids[P.active]; out[cam] = v && v._url && v.videoWidth && v.readyState >= 2 ? { img: v, w: v.videoWidth, h: v.videoHeight } : null; }
    return out;
  };
  function build() {
    const stage = document.getElementById("stage");
    wrap = document.createElement("div"); wrap.className = "pano-wrap"; wrap.id = "panoWrap";
    canvas = document.createElement("canvas"); canvas.className = "pano-canvas"; canvas.id = "panoCanvas";
    const bar = document.createElement("div"); bar.className = "pano-bar";
    bar.innerHTML = '<div class="seg" id="panoMode"><button data-v="look">Look around</button><button data-v="equirect">Flat 360</button></div>' +
      '<button class="btn small ghost" id="panoGyro" type="button" title="Use the phone\'s motion sensor to look around">Gyro</button>' +
      '<button class="btn small ghost adv-only" id="panoCalib" type="button" title="Adjust camera angles and lens">Calibrate</button>' +
      '<span class="pano-note">Beta · camera angles are estimates</span>';
    wrap.append(canvas, bar); stage.appendChild(wrap);
    bar.querySelectorAll("#panoMode button").forEach((b) => b.onclick = () => { N.mode = b.dataset.v; saveView(); syncBar(); N.dirty = true; });
    bar.querySelector("#panoGyro").onclick = gyro;
    bar.querySelector("#panoCalib").onclick = () => toggleCalib();
    // drag / pinch / wheel
    const pts = new Map(); let pinch0 = 0, fov0 = 90;
    canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); fov0 = N.fov; } });
    canvas.addEventListener("pointermove", (e) => {
      const p = pts.get(e.pointerId); if (!p) return;
      if (pts.size === 2) { p.x = e.clientX; p.y = e.clientY; const [a, b] = [...pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); if (pinch0) { N.fov = Math.max(35, Math.min(130, fov0 * pinch0 / d)); N.dirty = true; } return; }
      const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
      const k = N.fov / Math.max(200, canvas.clientWidth);
      if (N.mode === "look") { N.yaw = (N.yaw - dx * k + 540) % 360 - 180; N.pitch = Math.max(-85, Math.min(85, N.pitch + dy * k)); }
      else N.yaw = (N.yaw - dx * 360 / Math.max(200, canvas.clientWidth) + 540) % 360 - 180;
      N.dirty = true;
    });
    const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch0 = 0; };
    canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("wheel", (e) => { e.preventDefault(); N.fov = Math.max(35, Math.min(130, N.fov * Math.exp(e.deltaY * 0.001))); N.dirty = true; }, { passive: false });
    canvas.addEventListener("dblclick", () => { N.yaw = 0; N.pitch = -5; N.fov = 90; N.dirty = true; });
    syncBar();
  }
  function syncBar() { if (!wrap) return; wrap.querySelectorAll("#panoMode button").forEach((b) => b.classList.toggle("on", b.dataset.v === N.mode)); }
  let gyroOn = false, gyro0 = null;
  async function gyro() {
    if (gyroOn) { gyroOn = false; window.removeEventListener("deviceorientation", onOri); wrap.querySelector("#panoGyro").classList.remove("on"); return; }
    try { if (typeof DeviceOrientationEvent !== "undefined" && DeviceOrientationEvent.requestPermission) { const r = await DeviceOrientationEvent.requestPermission(); if (r !== "granted") throw new Error("permission denied"); } }
    catch (e) { T.toast && T.toast("Motion sensor not available: " + (e.message || e), "err"); return; }
    gyroOn = true; gyro0 = null; window.addEventListener("deviceorientation", onOri); wrap.querySelector("#panoGyro").classList.add("on");
  }
  function onOri(e) { if (e.alpha == null) return; if (!gyro0) gyro0 = { a: e.alpha, y: N.yaw }; N.yaw = ((gyro0.y - (e.alpha - gyro0.a)) + 540) % 360 - 180; N.pitch = Math.max(-85, Math.min(85, (e.beta || 90) - 90)); N.dirty = true; }

  let lastT = -1, lastFrameAt = 0;
  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (!N.on || document.hidden || !canvas || !canvas.isConnected) return;
    const P = T.player, moving = P.playing;
    const minGap = isMobile() ? 1000 / 30 : 1000 / 60;   // cap at 30 fps on phones
    if (!moving && !N.dirty && lastT === P.time) return;  // paused and nothing changed: no work
    if (now - lastFrameAt < minGap) return;
    lastFrameAt = now; lastT = P.time; N.dirty = false;
    const cw = canvas.clientWidth, ch = canvas.clientHeight; if (!cw || !ch) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1) * N.scale;
    let W = Math.round(cw * dpr), H = Math.round(ch * dpr);
    const cap = isMobile() ? 1280 : 2560; if (W > cap) { H = Math.round(H * cap / W); W = cap; }
    try { if (R.draw(N.liveFrames(), { mode: N.mode, yaw: N.yaw, pitch: N.pitch, fov: N.fov }, N.calib(), W, H)) N.frames++; }
    catch (e) { console.warn("pano draw", e); }
  }
  N.toggle = (on) => {
    on = on == null ? !N.on : !!on;
    if (on && !T.player.ev) { T.toast && T.toast("Open an event first.", "err"); return false; }
    if (on) {
      N.view();
      if (!wrap) build();
      if (!R) { R = N.makeRenderer(canvas); if (!R) { wrap.remove(); wrap = null; throw new Error(N.error); } }
      wrap.hidden = false; document.getElementById("stage").classList.add("pano-on"); N.on = true; N.dirty = true;
      if (!raf) raf = requestAnimationFrame(loop);
    } else {
      N.on = false; if (raf) cancelAnimationFrame(raf); raf = 0;
      if (wrap) wrap.hidden = true; document.getElementById("stage").classList.remove("pano-on");
      if (calibUI) calibUI.hidden = true;
      if (gyroOn) gyro();
    }
    return N.on;
  };
  N.redraw = () => { N.dirty = true; };
  if (T.on) { T.on("player-open", () => { if (N.on) N.toggle(false); }); T.on("layout", () => { N.dirty = true; }); }
  document.addEventListener("visibilitychange", () => { N.dirty = true; });

  // ── calibration panel (Advanced) ──
  const FIELDS = [["yaw", -180, 180, 1, "°"], ["pitch", -60, 60, 0.5, "°"], ["roll", -30, 30, 0.5, "°"], ["fov", 30, 200, 1, "°"], ["k1", -0.5, 0.5, 0.005, ""]];
  function toggleCalib(show) {
    if (!calibUI) {
      calibUI = document.createElement("div"); calibUI.className = "pano-calib"; calibUI.id = "panoCalibPanel";
      wrap.appendChild(calibUI); renderCalib();
    } else calibUI.hidden = show === undefined ? !calibUI.hidden : !show;
  }
  N.toggleCalib = toggleCalib;
  let calibCam = "front";
  function renderCalib() {
    const c = N.calib(), cc = c[calibCam];
    calibUI.innerHTML = '<div class="pc-head"><b>Calibrate</b><select class="select small" id="pcCam">' + CAMS.map((k) => '<option value="' + k + '"' + (k === calibCam ? " selected" : "") + ">" + (T.CAM_LABEL[k] || k) + "</option>").join("") + '</select><button class="btn icon sm" id="pcClose" title="Close">×</button></div>' +
      FIELDS.map(([k, lo, hi, st, u]) => '<label class="pc-row"><span>' + k + '</span><input type="range" data-k="' + k + '" min="' + lo + '" max="' + hi + '" step="' + st + '" value="' + cc[k] + '"><b>' + (+cc[k]).toFixed(st < 1 ? (st < 0.01 ? 3 : 1) : 0) + u + "</b></label>").join("") +
      '<label class="pc-row"><span>lens</span><select class="select small" id="pcModel"><option value="kb"' + (cc.model === "kb" ? " selected" : "") + '>fisheye (Kannala–Brandt)</option><option value="rect"' + (cc.model === "rect" ? " selected" : "") + ">rectilinear</option></select></label>" +
      '<label class="pc-row"><span>mirror</span><input type="checkbox" id="pcFlip"' + (cc.flip ? " checked" : "") + "></label>" +
      '<div class="pc-btns"><button class="btn small ghost" id="pcExport">Export JSON</button><button class="btn small ghost" id="pcImport">Import JSON</button><button class="btn small ghost" id="pcReset">Reset all</button></div>' +
      '<p class="hint">Estimates from public Tesla info; drag the sliders until edges line up in the overlaps. Saved on this device. Auto-refine (feature matching) is not built yet.</p>';
    calibUI.querySelector("#pcCam").onchange = (e) => { calibCam = e.target.value; renderCalib(); };
    calibUI.querySelector("#pcClose").onclick = () => toggleCalib(false);
    calibUI.querySelectorAll("input[type=range]").forEach((inp) => inp.oninput = () => { const c2 = N.calib(); c2[calibCam][inp.dataset.k] = +inp.value; N.saveCalib(c2); inp.nextElementSibling.textContent = (+inp.value).toFixed(+inp.step < 1 ? (+inp.step < 0.01 ? 3 : 1) : 0) + (inp.dataset.k === "k1" ? "" : "°"); });
    calibUI.querySelector("#pcModel").onchange = (e) => { const c2 = N.calib(); c2[calibCam].model = e.target.value; N.saveCalib(c2); };
    calibUI.querySelector("#pcFlip").onchange = (e) => { const c2 = N.calib(); c2[calibCam].flip = e.target.checked; N.saveCalib(c2); };
    calibUI.querySelector("#pcReset").onclick = () => { N.resetCalib(); renderCalib(); };
    calibUI.querySelector("#pcExport").onclick = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([N.exportCalib()], { type: "application/json" })); a.download = "dashcam-360-calibration.json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); };
    calibUI.querySelector("#pcImport").onclick = () => { const i = document.createElement("input"); i.type = "file"; i.accept = "application/json,.json"; i.onchange = async () => { try { const n = N.importCalib(await i.files[0].text()); renderCalib(); T.toast && T.toast("Calibration imported (" + n + " cameras)", "ok"); } catch (e) { T.toast && T.toast("Import failed: " + e.message, "err"); } }; i.click(); };
  }

  // ── export helper: equirect frame onto a 2D canvas (used by export.js when "360 equirect" is chosen) ──
  let xr = null, xc = null;
  N.drawEquirect = (ctx, W, H, frames) => {
    if (!xr) { xc = document.createElement("canvas"); xr = N.makeRenderer(xc); if (!xr) throw new Error(N.error || "WebGL unavailable"); }
    xr.draw(frames, { mode: "equirect", yaw: 0, pitch: 0, fov: 90 }, N.calib(), W, H);
    ctx.drawImage(xc, 0, 0, W, H);
  };
})();
