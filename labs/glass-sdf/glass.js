/* Glass SDF lab: WebGL1 refraction for "Liquid Glass" controls over a mock video.
   Pass 1: video tiles -> offscreen FBO (scene). Pass 2: scene -> screen.
   Pass 3: one quad per glass control: rounded-rect SDF, bevel height profile,
   refraction along the SDF normal, small disc blur, chromatic edge, Fresnel rim,
   specular, tint. DOM text/icons stay on top. No WebGL2 features. */
(function () {
  'use strict';
  var Q = new URLSearchParams(location.search);
  var $ = function (id) { return document.getElementById(id); };
  var body = document.body, canvas = $('c'), note = $('note');
  var mqT = window.matchMedia('(prefers-reduced-transparency: reduce)');
  var mqM = window.matchMedia('(prefers-reduced-motion: reduce)');
  var state = { refr: true, str: 1, blur: 4, ca: true, six: false, auto: !Q.has('nofallback'), solid: false };
  var gl = null, glOK = false, progScene, progGlass, quadBuf, fbo = null, fboTex = null, fboW = 0, fboH = 0, dpr = 1;
  var videos = [$('v0')], vtex = [], vsrc = [];
  // The loop is fetched into a Blob typed video/mp4: raw.githack redirects binaries to raw.githubusercontent,
  // which serves application/octet-stream + nosniff. A same-origin blob URL avoids both. Falls back to the plain path.
  var SRC = 'mock-loop.mp4', srcURL = SRC;
  function loadSrc(cb) {
    if (!window.fetch || !window.Blob || !window.URL) return cb(SRC);
    fetch(SRC).then(function (r) { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then(function (b) { cb(URL.createObjectURL(new Blob([b], { type: 'video/mp4' }))); })
      .catch(function () { cb(SRC); });
  }
  var poster = new Image(); poster.src = 'poster.jpg'; // shown until the video has a frame (iOS before tap, or no H.264)

  function showNote(t, ms) { note.textContent = t; note.classList.add('on'); clearTimeout(showNote.t); showNote.t = setTimeout(function () { note.classList.remove('on'); }, ms || 5000); }

  /* ---------------- WebGL setup ---------------- */
  var VS = [
    'attribute vec2 aPos;',
    'uniform vec4 uRect;', // x, y, w, h in device px, top-left origin
    'uniform vec2 uRes;',
    'uniform vec4 uUV;',   // texcoord range for scene tiles
    'varying vec2 vP; varying vec2 vUV;',
    'void main(){',
    '  vec2 p = uRect.xy + aPos * uRect.zw; vP = p;',
    '  vUV = mix(uUV.xy, uUV.zw, aPos);',
    '  vec2 c = p / uRes * 2.0 - 1.0; gl_Position = vec4(c.x, -c.y, 0.0, 1.0);',
    '}'].join('\n');
  var FS_SCENE = [
    'precision mediump float;',
    'uniform sampler2D uTex; uniform float uFlip; varying vec2 vUV;',
    'void main(){ vec2 uv = vUV; if (uFlip > 0.5) uv.y = 1.0 - uv.y; gl_FragColor = vec4(texture2D(uTex, uv).rgb, 1.0); }'].join('\n');
  var FS_GLASS = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform sampler2D uScene; uniform vec2 uRes;',
    'uniform vec4 uBox;',   // center xy, half size zw (device px)
    'uniform float uRad, uStr, uBlur, uCA, uDpr, uTint;',
    'varying vec2 vP;',
    'float sdf(vec2 p){ vec2 q = abs(p - uBox.xy) - uBox.zw + uRad; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRad; }',
    'vec3 tap(vec2 p){ p = clamp(p, vec2(1.0), uRes - 1.0); return texture2D(uScene, vec2(p.x, uRes.y - p.y) / uRes).rgb; }',
    'vec3 blurred(vec2 p){',
    '  if (uBlur < 0.25) return tap(p);',
    '  float r = uBlur * uDpr; float h = r * 0.7071;',
    '  vec3 c = tap(p) * 0.2;',
    '  c += (tap(p + vec2(r, 0.0)) + tap(p - vec2(r, 0.0)) + tap(p + vec2(0.0, r)) + tap(p - vec2(0.0, r))) * 0.1;',
    '  c += (tap(p + vec2(h, h)) + tap(p - vec2(h, h)) + tap(p + vec2(h, -h)) + tap(p - vec2(h, -h))) * 0.1;',
    '  return c;',
    '}',
    'void main(){',
    '  float d = sdf(vP);',
    '  float aa = uDpr;',
    '  if (d > 0.5 * aa) {', // soft drop shadow outside the glass
    '    float ds = max(sdf(vP - vec2(0.0, 5.0 * uDpr)), 0.0);',
    '    float a = 0.26 * exp(-ds / (9.0 * uDpr)) * smoothstep(0.0, 3.0 * aa, d);',
    '    gl_FragColor = vec4(0.0, 0.0, 0.0, a); return;',
    '  }',
    '  float e = 1.0 * uDpr;',
    '  vec2 g = vec2(sdf(vP + vec2(e, 0.0)) - sdf(vP - vec2(e, 0.0)), sdf(vP + vec2(0.0, e)) - sdf(vP - vec2(0.0, e)));',
    '  vec2 n = dot(g, g) > 1e-6 ? normalize(g) : vec2(0.0);', // points outward
    '  float w = min(uRad * 0.9, 20.0 * uDpr);',                  // bevel width
    '  float t = clamp(-d / w, 0.0, 1.0);',                        // 0 at rim, 1 = flat top
    '  float s = 1.0 - t;',
    '  float rim = s * s * s;',                                    // slope of a squircle-ish convex bevel
    '  float off = uStr * w * (0.25 * s + 0.95 * rim);',
    '  vec2 c = uBox.xy;',
    '  vec2 sp = c + (vP - c) * (1.0 - 0.035 * uStr) + n * off;', // gentle lens + edge bend (pulls outside picture into the rim)
    '  vec3 col = blurred(sp);',
    '  if (uCA > 0.5) {',
    '    vec2 k = n * (2.0 * uDpr + off * 0.18) * s;',
    '    col.r = mix(col.r, tap(sp + k).r, 0.7 * s);',
    '    col.b = mix(col.b, tap(sp - k).b, 0.7 * s);',
    '  }',
    '  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));',
    '  col = mix(vec3(lum), col, 1.2);',                           // a little vibrancy
    '  col *= 1.0 - 0.32 * smoothstep(0.45, 0.95, lum);',            // tame highlights for white text
    '  col = mix(col, vec3(0.07, 0.07, 0.09), uTint);',             // legibility tint
    '  vec2 L = normalize(vec2(-0.55, -0.83));',                    // light from top-left (y down)
    '  float ndl = max(dot(n, L), 0.0); float ndl2 = max(dot(n, -L), 0.0);',
    '  float fres = pow(s, 4.0);',
    '  col += fres * (0.10 + 0.55 * ndl * ndl + 0.18 * ndl2);',
    '  float line = smoothstep(1.6 * uDpr, 0.0, abs(-d - 0.9 * uDpr));', // crisp inner hairline
    '  col += line * (0.18 + 0.5 * ndl + 0.2 * ndl2);',
    '  float topSheen = smoothstep(uBox.y - uBox.w, uBox.y, vP.y);',
    '  col += 0.05 * (1.0 - topSheen) * t;',
    '  float a = clamp(0.5 - d / aa, 0.0, 1.0);',
    '  gl_FragColor = vec4(clamp(col, 0.0, 1.0) * a, a);',
    '}'].join('\n');

  function sh(type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function prog(fs, names) {
    var p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    var u = {}; names.forEach(function (n) { u[n] = gl.getUniformLocation(p, n); });
    return { p: p, u: u };
  }
  function mkTex() {
    var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([20, 20, 24, 255]));
    return t;
  }
  function initGL() {
    try {
      var opts = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: Q.has('shot'), powerPreference: 'high-performance' };
      gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
      if (!gl) throw new Error('WebGL unavailable');
      progScene = prog(FS_SCENE, ['uRect', 'uRes', 'uUV', 'uTex', 'uFlip']);
      progGlass = prog(FS_GLASS, ['uRect', 'uRes', 'uUV', 'uScene', 'uBox', 'uRad', 'uStr', 'uBlur', 'uCA', 'uDpr', 'uTint']);
      quadBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      vtex = []; vsrc = []; fbo = null; fboW = fboH = 0;
      glOK = true;
    } catch (e) {
      glOK = false; console.warn('[glass-sdf] WebGL init failed:', e);
      showNote('WebGL not available: showing CSS frosted glass', 6000);
    }
  }
  function ensureFBO(w, h) {
    if (fbo && fboW === w && fboH === h) return;
    if (!fbo) { fbo = gl.createFramebuffer(); fboTex = mkTex(); }
    gl.bindTexture(gl.TEXTURE_2D, fboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); // NPOT ok: clamp + linear + no mips
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    fboW = w; fboH = h;
  }
  canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); glOK = false; applyMode(); showNote('GPU context lost: CSS glass until it returns'); });
  canvas.addEventListener('webglcontextrestored', function () { initGL(); applyMode(); });

  /* ---------------- video ---------------- */
  function setSix(on) {
    state.six = on;
    if (on && videos.length < 6) {
      for (var i = videos.length; i < 6; i++) {
        var v = document.createElement('video');
        v.src = srcURL; v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
        v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('crossorigin', 'anonymous');
        (function (v, i) { v.addEventListener('loadedmetadata', function () { try { v.currentTime = (i * 2) % (v.duration || 12); } catch (e) {} }); })(v, i);
        document.body.appendChild(v); videos.push(v);
        if (!videos[0].paused) v.play().catch(function () {});
      }
    } else if (!on) {
      while (videos.length > 1) { var x = videos.pop(); x.pause(); x.removeAttribute('src'); x.load(); x.remove(); }
      if (glOK) vtex.slice(1).forEach(function (t) { gl.deleteTexture(t); });
      vtex.length = Math.min(vtex.length, 1); vsrc.length = Math.min(vsrc.length, 1);
    }
  }
  function playAll() {
    var p = videos[0].play();
    videos.slice(1).forEach(function (v) { v.play().catch(function () {}); });
    if (p && p.then) p.then(function () { body.classList.remove('needtap'); }, function () { body.classList.add('needtap'); });
  }
  function pauseAll() { videos.forEach(function (v) { v.pause(); }); }
  $('tap').addEventListener('click', function () { playAll(); });
  videos[0].addEventListener('play', function () { $('playIc').setAttribute('d', 'M6 4h4v16H6zM14 4h4v16h-4z'); body.classList.remove('needtap'); });
  videos[0].addEventListener('pause', function () { $('playIc').setAttribute('d', 'M7 4l13 8-13 8z'); });

  /* ---------------- layout + dragging ---------------- */
  function place(el, x, y) { el.style.left = Math.round(x) + 'px'; el.style.top = Math.round(y) + 'px'; }
  function layout() {
    var W = innerWidth, H = innerHeight, phone = W < 600;
    var cam = $('cam'), tg = $('tg'), tl = $('tl'), fan = $('fan');
    tl.style.width = (phone ? W - 24 : Math.min(860, W - 200)) + 'px';
    var tlx = phone ? 12 : (W - tl.offsetWidth) / 2;
    var tly = H - 56 - (phone ? 24 : 22);
    place(tl, tlx, tly);
    if (phone) tg.style.maxWidth = (W - 24) + 'px';
    place(tg, phone ? 12 : (W - tg.offsetWidth) / 2, tly - 40 - 12);
    place(cam, (W - cam.offsetWidth) / 2, phone ? 64 : 18);
    place(fan, W - 60 - (phone ? 16 : 28), tly - 60 - (phone ? 64 : 16));
  }
  function draggable(el, handleTap) {
    var sx, sy, ox, oy, id = null, moved = false;
    el.addEventListener('pointerdown', function (e) {
      id = e.pointerId; moved = false; sx = e.clientX; sy = e.clientY; ox = el.offsetLeft; oy = el.offsetTop;
      try { el.setPointerCapture(id); } catch (x) {}
      el.style.cursor = 'grabbing';
    });
    el.addEventListener('pointermove', function (e) {
      if (e.pointerId !== id) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && dx * dx + dy * dy < 36) return;
      moved = true;
      var x = Math.max(-el.offsetWidth / 2, Math.min(innerWidth - el.offsetWidth / 2, ox + dx));
      var y = Math.max(0, Math.min(innerHeight - 40, oy + dy));
      place(el, x, y);
    });
    function up(e) {
      if (e.pointerId !== id) return; id = null; el.style.cursor = '';
      if (!moved && handleTap) handleTap(e);
    }
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', function () { id = null; });
  }
  draggable($('cam'), function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var bs = Array.prototype.slice.call($('cam').querySelectorAll('button')), i = bs.indexOf(b);
    if (i >= 0 && i < 5) bs.forEach(function (x, j) { if (j < 5) x.classList.toggle('on', x === b); });
  });
  draggable($('tg'), function (e) { var b = e.target.closest('button'); if (b) b.classList.toggle('on'); });
  draggable($('tl'), function (e) {
    if (e.target.closest('#playBtn')) { if (videos[0].paused) playAll(); else pauseAll(); return; }
    var tr = e.target.closest('.track');
    if (tr && videos[0].duration) { var r = tr.getBoundingClientRect(); var f = (e.clientX - r.left) / r.width; videos.forEach(function (v, i) { try { v.currentTime = ((f * v.duration) + i * 2) % v.duration; } catch (x) {} }); }
  });
  var fanOpen = true;
  draggable($('fan'), function (e) {
    if (e.target.closest('#bub')) { fanOpen = !fanOpen; $('fan').querySelectorAll('.sat').forEach(function (s) { s.style.display = fanOpen ? '' : 'none'; }); $('bub').querySelector('svg').style.transform = fanOpen ? 'rotate(45deg)' : 'none'; }
  });

  /* ---------------- lab panel ---------------- */
  var lab = $('lab');
  if (innerWidth >= 600 || Q.has('panel')) lab.classList.remove('closed');
  $('labBtn').addEventListener('click', function () { lab.classList.toggle('closed'); });
  function bind(id, key, out, fmt) {
    var el = $(id);
    el.addEventListener('input', function () {
      state[key] = el.type === 'checkbox' ? el.checked : parseFloat(el.value);
      if (out) $(out).textContent = fmt(state[key]);
      if (key === 'refr') { if (state.refr) slowSecs = 0; applyMode(); }
      if (key === 'six') setSix(state.six);
    });
  }
  bind('oRefr', 'refr'); bind('oStr', 'str', 'vStr', function (v) { return v.toFixed(2); });
  bind('oBlur', 'blur', 'vBlur', function (v) { return String(v); });
  bind('oCA', 'ca'); bind('oSix', 'six'); bind('oAuto', 'auto');
  function setRefr(on) { state.refr = on; $('oRefr').checked = on; applyMode(); }
  function applyMode() {
    var reducedT = mqT.matches;
    body.classList.toggle('solid', reducedT);
    body.classList.toggle('frost', !reducedT && !(state.refr && glOK));
  }
  if (mqT.matches) { state.refr = false; $('oRefr').checked = false; }
  if (mqT.addEventListener) mqT.addEventListener('change', function () { if (mqT.matches) setRefr(false); applyMode(); });

  // URL overrides (handy for testing): ?refr=0&str=1.4&blur=6&ca=0&six=1
  if (Q.get('refr') === '0') state.refr = false, $('oRefr').checked = false;
  if (Q.has('str')) state.str = parseFloat(Q.get('str')), $('oStr').value = state.str, $('vStr').textContent = state.str.toFixed(2);
  if (Q.has('blur')) state.blur = parseFloat(Q.get('blur')), $('oBlur').value = state.blur, $('vBlur').textContent = state.blur;
  if (Q.get('ca') === '0') state.ca = false, $('oCA').checked = false;
  if (!state.auto) $('oAuto').checked = false;

  /* ---------------- render ---------------- */
  var glassEls = Array.prototype.slice.call(document.querySelectorAll('.gc'));
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  function tileRects(n, W, H) {
    if (n === 1) return [[0, 0, W, H]];
    var cols = W >= H ? 3 : 2, rows = n / cols, out = [], tw = W / cols, th = H / rows;
    for (var i = 0; i < n; i++) out.push([(i % cols) * tw, Math.floor(i / cols) * th, tw, th]);
    return out;
  }
  function coverUV(vw, vh, tw, th) { // object-fit: cover
    var va = vw / vh, ta = tw / th, u0 = 0, v0 = 0, u1 = 1, v1 = 1;
    if (va > ta) { var k = ta / va; u0 = (1 - k) / 2; u1 = 1 - u0; } else { var m = va / ta; v0 = (1 - m) / 2; v1 = 1 - v0; }
    return [u0, v0, u1, v1];
  }
  function drawScene(W, H) {
    var P = progScene; gl.useProgram(P.p);
    gl.uniform2f(P.u.uRes, W, H); gl.uniform1i(P.u.uTex, 0); gl.uniform1f(P.u.uFlip, 0);
    gl.activeTexture(gl.TEXTURE0);
    var rects = tileRects(videos.length, W, H);
    for (var i = 0; i < videos.length; i++) {
      var v = videos[i];
      if (!vtex[i]) vtex[i] = mkTex();
      gl.bindTexture(gl.TEXTURE_2D, vtex[i]);
      // use the video once it really has frames (time advanced, or paused on a decoded frame); sticky after that
      var ready = v.readyState >= 2 && v.videoWidth && !v.error && (vsrc[i] === 'v' || v.currentTime > 0.05 || v.paused);
      if (ready) { try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v); vsrc[i] = 'v'; } catch (e) {} }
      else if ((v.error || vsrc[i] !== 'v') && vsrc[i] !== 'p' && poster.complete && poster.naturalWidth) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, poster); vsrc[i] = 'p'; }
      var r = rects[i], g = Math.round(2 * dpr * (videos.length > 1 ? 1 : 0));
      var uv = coverUV(v.videoWidth || 16, v.videoHeight || 9, r[2], r[3]);
      gl.uniform4f(P.u.uRect, r[0] + g / 2, r[1] + g / 2, r[2] - g, r[3] - g);
      gl.uniform4f(P.u.uUV, uv[0], uv[1], uv[2], uv[3]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }
  function render() {
    var W = canvas.width, H = canvas.height;
    var glass = state.refr && !mqT.matches;
    if (glass) { ensureFBO(W, H); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); }
    gl.viewport(0, 0, W, H); gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    drawScene(W, H);
    if (!glass) return 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    // blit scene
    var P = progScene; gl.useProgram(P.p);
    gl.uniform2f(P.u.uRes, W, H); gl.uniform1f(P.u.uFlip, 1); gl.uniform4f(P.u.uRect, 0, 0, W, H); gl.uniform4f(P.u.uUV, 0, 0, 1, 1);
    gl.bindTexture(gl.TEXTURE_2D, fboTex); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // glass quads, scissored to rect + shadow margin
    var G = progGlass; gl.useProgram(G.p);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.enable(gl.SCISSOR_TEST);
    gl.uniform2f(G.u.uRes, W, H); gl.uniform1i(G.u.uScene, 0);
    gl.uniform1f(G.u.uStr, state.str); gl.uniform1f(G.u.uBlur, state.blur); gl.uniform1f(G.u.uCA, state.ca ? 1 : 0);
    gl.uniform1f(G.u.uDpr, dpr); gl.uniform1f(G.u.uTint, 0.22); gl.uniform4f(G.u.uUV, 0, 0, 1, 1);
    var n = 0;
    for (var i = 0; i < glassEls.length; i++) {
      var el = glassEls[i]; if (!el.offsetParent) continue;
      var r = el.getBoundingClientRect(); if (r.width < 2) continue;
      var x = r.left * dpr, y = r.top * dpr, w = r.width * dpr, h = r.height * dpr, m = 26 * dpr;
      var rad = Math.min(w, h) / 2; // all controls are capsules / circles
      var qx = x - m, qy = y - m, qw = w + 2 * m, qh = h + 2 * m;
      var sx = Math.max(0, Math.floor(qx)), sy = Math.max(0, Math.floor(H - (qy + qh)));
      gl.scissor(sx, sy, Math.max(0, Math.ceil(Math.min(W, qx + qw)) - sx), Math.max(0, Math.ceil(Math.min(H, H - qy)) - sy));
      gl.uniform4f(G.u.uRect, qx, qy, qw, qh);
      gl.uniform4f(G.u.uBox, x + w / 2, y + h / 2, w / 2, h / 2);
      gl.uniform1f(G.u.uRad, rad);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); n++;
    }
    gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND);
    return n;
  }

  /* ---------------- loop + FPS monitor ---------------- */
  var last = 0, acc = 0, frames = 0, cpu = 0, worst = 0, winStart = 0, slowSecs = 0, nGlass = 0, stats = window.__glassStats = { fps: 0, frameMs: 0, cpuMs: 0, worstMs: 0, glass: 0, samples: [] };
  function frame(now) {
    requestAnimationFrame(frame);
    if (!winStart) { winStart = now; last = now; }
    var dt = now - last; last = now;
    if (dt > 0 && dt < 1000) { acc += dt; frames++; worst = Math.max(worst, dt); }
    resize();
    var t0 = performance.now();
    if (glOK) { nGlass = render(); if (Q.has('finish')) gl.finish(); }
    cpu += performance.now() - t0;
    var vd = videos[0].duration;
    if (vd) { var f = videos[0].currentTime / vd; $('tDone').style.width = (f * 100) + '%'; $('tHead').style.left = (f * 100) + '%'; $('tNow').textContent = '0:' + ('0' + Math.floor(videos[0].currentTime)).slice(-2); }
    if (now - winStart >= 1000 && frames) {
      stats.fps = 1000 * frames / acc; stats.frameMs = acc / frames; stats.cpuMs = cpu / frames; stats.worstMs = worst; stats.glass = nGlass;
      stats.samples.push({ fps: +stats.fps.toFixed(1), frameMs: +stats.frameMs.toFixed(2), cpuMs: +stats.cpuMs.toFixed(2), worstMs: +worst.toFixed(1), refr: state.refr && glOK, six: state.six });
      if (stats.samples.length > 60) stats.samples.shift();
      $('fpsChip').textContent = stats.fps.toFixed(0) + ' fps';
      $('fpsChip').style.color = stats.fps >= 55 ? '#30d158' : stats.fps >= 40 ? '#ffd60a' : '#ff453a';
      $('stats').textContent =
        'fps        ' + stats.fps.toFixed(1) + '\n' +
        'frame      ' + stats.frameMs.toFixed(1) + ' ms (worst ' + worst.toFixed(0) + ')\n' +
        'JS render  ' + stats.cpuMs.toFixed(2) + ' ms\n' +
        'mode       ' + (mqT.matches ? 'solid (reduced transparency)' : state.refr && glOK ? 'SDF refraction, ' + nGlass + ' glass' : 'CSS frosted') + '\n' +
        'videos     ' + videos.length + (videos[0].paused ? ' (paused)' : '') + '\n' +
        'canvas     ' + canvas.width + '×' + canvas.height + ' @' + dpr + 'x';
      var playing = !videos[0].paused && !document.hidden;
      if (state.auto && state.refr && glOK && playing && stats.fps < 40) {
        if (++slowSecs >= 2) { setRefr(false); slowSecs = 0; showNote('Running below 40 fps: switched to CSS frosted glass. Turn Refraction back on in the lab panel.', 7000); }
      } else slowSecs = 0;
      acc = 0; frames = 0; cpu = 0; worst = 0; winStart = now;
    }
  }

  initGL();
  applyMode();
  layout();
  addEventListener('resize', function () { layout(); });
  body.classList.add('needtap');
  loadSrc(function (u) {
    srcURL = u; videos[0].src = u;
    if (Q.get('six') === '1') { state.six = true; $('oSix').checked = true; setSix(true); }
    if (!(mqM.matches || Q.has('paused'))) playAll();
  });
  requestAnimationFrame(frame);
})();
