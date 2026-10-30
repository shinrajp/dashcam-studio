/* refract.js — ui-glass-11: SDF refraction for the glass controls (ported from labs/glass-sdf, tag glass-sdf-proto-v5).
 *  Pieces: the tools bubble (#tbMain) and its fan items, the camera pill (.stage-bar), the playback capsule (desktop .transport::before, phone .mb-row),
 *  the Events sheet (#library while open) and the Settings sheet (#settings).
 *  How: the camera pictures under the pieces are drawn into one small 2D "scene" canvas (half the window size); ONE shared WebGL canvas (never in the
 *  page) renders each piece in turn — rounded-rect SDF, convex bevel, refraction along the edge normal, a small blur, chromatic edge, Fresnel rim,
 *  specular — and the result is copied into a canvas inside the piece (.rf-c: z-index -1 in an isolated piece, so text and icons stay on top;
 *  pointer-events: none, so every tap and click reaches the controls; Mac Safari: nothing here captures the pointer).
 *  Readability: each piece gets the video-following tint (a dark tint of the colour under it) at the lowest opacity that keeps its dimmest text
 *  >= 4.5:1 over the brightest part under it (highlights included). Over dark video the glass stays clear; the rim is always clear and bright.
 *  When: only while something changes — about 30 times a second while playing, a few frames after a layout / class change (fan, sheets), never while
 *  the tab is hidden or an export runs. A piece's backing store follows the zoom only once it has been stable for 160 ms (no flicker).
 *  Falls back to today's frosted glass (css/glass.css): Settings ▸ Appearance ▸ Glass style ▸ Frosted (pref `glassStyle`), ?refract=0, Lite mode
 *  (manual or auto), Solid / Reduce transparency / no backdrop-filter, no WebGL or a lost context, and playback under 40 fps for 2 s (this session).
 *  ?refract=1 forces it on (still not with Reduce transparency or without WebGL). Export never reads any of this. */
(function () {
  "use strict";
  const T = window.TDC; if (!T || !T.glass) return;
  const G = T.glass, root = document.documentElement;
  const R = (T.refract = { on: false, why: "", frames: 0, renders: 0, pieces: [], slow: "", contexts: 0, str: 1, blur: 4, ca: true,
    stats: { ms: 0, avg: 0, n: 0 }, autoFps: G.autoLiteFps, SLOW: 40, OK: 45, FOR: 2000 });
  R.override = () => { try { const m = /(?:[?&#])refract=(0|1)\b/.exec(location.search + location.hash); return m ? (m[1] === "1" ? "refract" : "frost") : null; } catch (_) { return null; } };
  R.pref = () => (T.prefs.glassStyle === "frost" ? "frost" : "refract");
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const TEXT = { ctl: lum(0xae, 0xb6, 0xc2), sheet: lum(0x9a, 0xa3, 0xb2) }, FLOOR = { ctl: 0.12, sheet: 0.5 }, SHEEN = 0.12, A_MAX = 0.96, RIM_A = 0.35;
  R.TEXT = TEXT; R.lum = lum; R.SHEEN = SHEEN;
  const lMax = (tl) => (tl + 0.05) / 4.6 - 0.05;
  const over = (t, b, a) => [0, 1, 2].map((i) => SHEEN * 255 + (1 - SHEEN) * (a * t[i] + (1 - a) * b[i]));
  R.alphaNeeded = (t, b, floor, tl) => { const L = lMax(tl); let lo = floor, hi = A_MAX;
    if (lum(...over(t, b, lo)) <= L) return lo;
    for (let k = 0; k < 14; k++) { const m = (lo + hi) / 2; if (lum(...over(t, b, m)) <= L) hi = m; else lo = m; }
    return hi; };

  // ---- WebGL (WebGL 1 only; one context for the whole app) --------------------------------------------------------------------------------
  const VS = "attribute vec2 aPos; uniform vec2 uSize; varying vec2 vP; void main(){ vP = aPos * uSize; gl_Position = vec4(aPos.x * 2.0 - 1.0, 1.0 - aPos.y * 2.0, 0.0, 1.0); }";
  const FS = [
    "#ifdef GL_FRAGMENT_PRECISION_HIGH", "precision highp float;", "#else", "precision mediump float;", "#endif",
    "uniform sampler2D uScene; uniform vec2 uSize, uOrigin, uSceneSize; uniform float uS, uK, uSS;",
    "uniform vec4 uBox; uniform vec4 uRad; uniform float uStr, uBlur, uCA, uTintA, uRimA; uniform vec3 uTint;",
    "varying vec2 vP;",
    // per-corner rounded box (r = br, tr, bl, tl; y down)
    "float sdf(vec2 p){ p -= uBox.xy; vec4 r = uRad; r.xy = (p.x > 0.0) ? r.xy : r.zw; r.x = (p.y > 0.0) ? r.x : r.y;",
    "  vec2 q = abs(p) - uBox.zw + r.x; return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r.x; }",
    // a point in this piece's render px -> the scene picture (screen CSS px * uSS)
    "vec3 tap(vec2 p){ vec2 css = uOrigin + p / uS * uK; vec2 uv = clamp(css * uSS / uSceneSize, vec2(0.0), vec2(1.0)); return texture2D(uScene, uv).rgb; }",
    "vec3 blurred(vec2 p){ if (uBlur < 0.25) return tap(p); float r = uBlur * uS; float h = r * 0.7071; vec3 c = tap(p) * 0.2;",
    "  c += (tap(p + vec2(r, 0.0)) + tap(p - vec2(r, 0.0)) + tap(p + vec2(0.0, r)) + tap(p - vec2(0.0, r))) * 0.1;",
    "  c += (tap(p + vec2(h, h)) + tap(p - vec2(h, h)) + tap(p + vec2(h, -h)) + tap(p - vec2(h, -h))) * 0.1; return c; }",
    "void main(){",
    "  float d = sdf(vP); float aa = uS;",
    "  if (d > 0.5 * aa) { gl_FragColor = vec4(0.0); return; }",
    "  float e = uS; vec2 g = vec2(sdf(vP + vec2(e, 0.0)) - sdf(vP - vec2(e, 0.0)), sdf(vP + vec2(0.0, e)) - sdf(vP - vec2(0.0, e)));",
    "  vec2 n = dot(g, g) > 1e-6 ? normalize(g) : vec2(0.0);",
    "  float w = max(min(min(uBox.z, uBox.w) * 0.9, 20.0 * uS), 2.0 * uS);",   // bevel width
    "  float t = clamp(-d / w, 0.0, 1.0); float s = 1.0 - t; float rim = s * s * s;",
    "  float off = uStr * w * (0.25 * s + 0.95 * rim);",
    "  vec2 c = uBox.xy; vec2 sp = c + (vP - c) * (1.0 - 0.035 * uStr) + n * off;",
    "  vec3 col = blurred(sp);",
    "  if (uCA > 0.5) { vec2 k = n * (2.0 * uS + off * 0.18) * s; col.r = mix(col.r, tap(sp + k).r, 0.7 * s); col.b = mix(col.b, tap(sp - k).b, 0.7 * s); }",
    "  float lu = dot(col, vec3(0.2126, 0.7152, 0.0722));",
    "  col = clamp(mix(vec3(lu), col, 1.2), 0.0, 1.0);",
    "  col *= 1.0 - 0.32 * smoothstep(0.45, 0.95, lu);",
    "  float ta = uTintA * mix(1.0, uRimA, smoothstep(0.6, 1.0, s));",   // the tint (for the text) eases off in the outer rim: a clear, bright edge
    "  col = mix(col, uTint, ta);",
    "  vec2 L = normalize(vec2(-0.55, -0.83)); float ndl = max(dot(n, L), 0.0); float ndl2 = max(dot(n, -L), 0.0);",
    "  float fres = pow(s, 4.0); col += fres * (0.10 + 0.55 * ndl * ndl + 0.18 * ndl2);",
    "  float line = smoothstep(1.6 * uS, 0.0, abs(-d - 0.9 * uS)); col += line * (0.18 + 0.5 * ndl + 0.2 * ndl2);",
    "  col += 0.05 * (1.0 - smoothstep(uBox.y - uBox.w, uBox.y, vP.y)) * t;",
    "  float a = clamp(0.5 - d / aa, 0.0, 1.0); gl_FragColor = vec4(clamp(col, 0.0, 1.0) * a, a);",
    "}"].join("\n");
  let gl = null, glc = null, prog = null, U = {}, sceneTex = null, glOK = false, glTried = false;
  function initGL() {
    glTried = true;
    try {
      glc = document.createElement("canvas"); glc.width = 64; glc.height = 64;
      const o = { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: true };
      gl = R.noWebGL ? null : (glc.getContext("webgl", o) || glc.getContext("experimental-webgl", o));
      if (!gl) throw new Error("no WebGL");
      const sh = (ty, src) => { const s = gl.createShader(ty); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.bindAttribLocation(prog, 0, "aPos"); gl.linkProgram(prog); if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      ["uScene", "uSize", "uOrigin", "uSceneSize", "uS", "uK", "uSS", "uBox", "uRad", "uStr", "uBlur", "uCA", "uTintA", "uRimA", "uTint"].forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      sceneTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]].forEach((p) => gl.texParameteri(gl.TEXTURE_2D, p[0], p[1]));
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.uniform1i(U.uScene, 0);
      glc.addEventListener("webglcontextlost", (e) => { e.preventDefault(); glOK = false; R.apply(); });
      glc.addEventListener("webglcontextrestored", () => { glTried = false; gl = null; R.apply(); });
      glOK = true; R.contexts = 1;
    } catch (e) { glOK = false; gl = null; R.glError = String(e && e.message || e); }
  }

  // ---- pieces -------------------------------------------------------------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const shown = (e) => { if (!e || e.hidden || !e.isConnected) return false; const r = e.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(e); return cs.display !== "none" && cs.visibility !== "hidden" && +cs.opacity > 0.05; };
  function wanted() {   // [{ host, kind: ctl | sheet, cap: 'cap' | 'row' | '' }]
    const b = document.body, out = [], tb = $("toolBubble");
    if (tb && !(T.bubble && T.bubble.away)) {
      out.push({ host: $("tbMain"), kind: "ctl" });
      if (T.bubble && T.bubble.open) tb.querySelectorAll("#tbFan .tb-item").forEach((e) => { if (e.getAttribute("aria-expanded") !== "true") out.push({ host: e, kind: "ctl" }); });
    }
    document.querySelectorAll(".stage-bar").forEach((e) => out.push({ host: e, kind: "ctl" }));
    if (b.classList.contains("mbar")) { const r = document.querySelector(".mb-row"); if (r) out.push({ host: r, kind: "ctl", cap: "row" }); }
    else { const t = $("transport"); if (t) out.push({ host: t, kind: "ctl", cap: "cap" }); }
    if (b.classList.contains("tb-on") && b.classList.contains("lib-open")) out.push({ host: $("library"), kind: "sheet" });
    out.push({ host: $("settings"), kind: "sheet" });
    return out.filter((p) => p.host && shown(p.host) && !(T.autohide && T.autohide.isHidden && T.autohide.isHidden(p.host)));
  }
  const canvasOf = (host, cap) => {
    let c = host._rfc;
    if (!c || c.parentNode !== host) { c = host._rfc = document.createElement("canvas"); c.className = "rf-c" + (cap ? " rf-" + cap : ""); c.setAttribute("aria-hidden", "true");
      c.width = c.height = 1; host.insertBefore(c, host.firstChild); c._ctx = c.getContext("2d"); }
    return c;
  };
  const unmark = (h) => { if (h.classList.contains("rf-on") || h.classList.contains("rf-cap-on")) h.classList.remove("rf-on", "rf-cap-on"); };
  const px = (v, w, h) => { const n = parseFloat(v) || 0; return String(v).indexOf("%") > 0 ? n / 100 * Math.min(w, h) : n; };
  function radii(el, w, h) {   // br, tr, bl, tl in CSS px, clamped like CSS
    const cs = getComputedStyle(el), m = Math.min(w, h) / 2;
    return [cs.borderBottomRightRadius, cs.borderTopRightRadius, cs.borderBottomLeftRadius, cs.borderTopLeftRadius].map((v) => Math.min(px(v, w, h), m));
  }

  // ---- the scene: the camera pictures under the pieces ----------------------------------------------------------------------------------------
  let sc = null, sx = null, tiny = null, tx = null, pin = null, bg = [11, 13, 18];
  const contained = (v, r) => { const vw = v.videoWidth || v.width, vh = v.videoHeight || v.height; if (!vw || !vh) return r;
    const s = Math.min(r.width / vw, r.height / vh), w = vw * s, h = vh * s; return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h }; };
  function sources() {
    if (pin) return pin.map((img) => ({ img, r: { left: 0, top: 0, width: innerWidth, height: innerHeight }, flip: false }));
    return [...document.querySelectorAll("#viewport video, .stage video")].filter((v) => v.readyState >= 2 && v.videoWidth && shown(v)).slice(0, 8)
      .map((v) => ({ img: v, r: contained(v, v.getBoundingClientRect()), flip: !!v.closest(".tile.mirrored") }));
  }
  const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  function drawScene(list, SS) {
    const W = Math.max(8, Math.ceil(innerWidth * SS)), H = Math.max(8, Math.ceil(innerHeight * SS));
    if (!sc) { sc = document.createElement("canvas"); sx = sc.getContext("2d"); }
    if (sc.width !== W || sc.height !== H) { sc.width = W; sc.height = H; }
    sx.fillStyle = "rgb(" + bg.join(",") + ")"; sx.fillRect(0, 0, W, H);
    const U = list.reduce((u, p) => ({ left: Math.min(u.left, p.r.left - 30), top: Math.min(u.top, p.r.top - 30), right: Math.max(u.right, p.r.right + 30), bottom: Math.max(u.bottom, p.r.bottom + 30) }), { left: 1e9, top: 1e9, right: -1e9, bottom: -1e9 });
    let n = 0;
    for (const s of sources()) {
      const r = s.r, rr = { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height };
      if (!pin && !list.some((p) => hit({ left: p.r.left - 30, top: p.r.top - 30, right: p.r.right + 30, bottom: p.r.bottom + 30 }, rr))) continue;
      if (!hit(U, rr)) continue;
      const x = r.left * SS, y = r.top * SS, w = r.width * SS, h = r.height * SS;
      try { if (s.flip) { sx.save(); sx.translate(x + w, y); sx.scale(-1, 1); sx.drawImage(s.img, 0, 0, w, h); sx.restore(); } else sx.drawImage(s.img, x, y, w, h); n++; } catch (_) {}
    }
    return n;
  }
  // tint per piece (~4 Hz while playing, at once after a change): the dominant colour and the brightest spot under it, from a 1/4-size copy
  let tintAt = 0;
  function tints(list, snap) {
    const TW = Math.max(4, Math.ceil(innerWidth / 4)), TH = Math.max(4, Math.ceil(innerHeight / 4));
    if (!tiny) { tiny = document.createElement("canvas"); tx = tiny.getContext("2d", { willReadFrequently: true }); }
    if (tiny.width !== TW || tiny.height !== TH) { tiny.width = TW; tiny.height = TH; }
    let d;
    try { tx.drawImage(sc, 0, 0, TW, TH); d = tx.getImageData(0, 0, TW, TH).data; } catch (_) { d = null; }
    for (const p of list) {
      const cur = p.host._rft;
      let avg = bg, mx = [255, 255, 255];
      if (d) {
        const x0 = Math.max(0, Math.floor((p.r.left - 8) / 4)), y0 = Math.max(0, Math.floor((p.r.top - 8) / 4)), x1 = Math.min(TW, Math.ceil((p.r.right + 8) / 4)), y1 = Math.min(TH, Math.ceil((p.r.bottom + 8) / 4));
        let n = 0, r = 0, g = 0, b = 0, ml = -1; mx = bg;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * TW + x) * 4; n++; r += d[i]; g += d[i + 1]; b += d[i + 2];
          const l = lum(d[i], d[i + 1], d[i + 2]); if (l > ml) { ml = l; mx = [d[i], d[i + 1], d[i + 2]]; } }
        if (n) avg = [r / n, g / n, b / n];
        mx = mx.map((c) => Math.min(255, c * 1.03 + 2));   // a little headroom: the shader samples the half-size picture, not these averages
      }
      const want = G.tintFor ? G.tintFor(avg) : [16, 18, 24];
      const rgb = cur && !snap ? cur.rgb.map((c, i) => (Math.abs(want[i] - c) < 1.5 ? c : c + (want[i] - c) * 0.3)) : want;
      const need = R.alphaNeeded(rgb, mx, FLOOR[p.kind], TEXT[p.kind]);
      let a = !cur || snap ? need : need >= cur.a ? need : Math.max(need, cur.a - Math.min(0.04, (cur.a - need) * 0.3));
      if (cur && !snap && Math.abs(a - cur.a) < 0.006 && cur.a >= need) a = cur.a;   // paused: straight to the target (nothing to flicker)
      p.host._rft = { rgb, a, need, max: mx };
    }
  }

  // ---- render ----------------------------------------------------------------------------------------------------------------------------------
  const SETTLE = 160;
  function render(now, doTint) {
    const t0 = performance.now(), list = [];
    const dpr = window.devicePixelRatio || 1, RS = Math.min(dpr, 2);
    for (const w of wanted()) {
      const c = canvasOf(w.host, w.cap), r = c.getBoundingClientRect(), cw = c.offsetWidth, ch = c.offsetHeight;
      if (cw < 4 || ch < 4 || r.width < 2) continue;
      list.push({ host: w.host, kind: w.kind, c, r, cw, ch, k: r.width / cw });
    }
    const keep = new Set(list.map((p) => p.host));
    R.pieces.forEach((p) => { if (!keep.has(p.host)) unmark(p.host); });
    R.pieces = list;
    if (!list.length) return;
    try { bg = (getComputedStyle(document.body).backgroundColor.match(/\d+/g) || bg).slice(0, 3).map(Number); } catch (_) {}
    const SS = innerWidth * innerHeight > 2.6e6 ? 0.4 : 0.5;
    R.stats.videos = drawScene(list, SS);
    if (doTint || list.some((p) => !p.host._rft)) { tints(list, !playing()); tintAt = now; }
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sc); } catch (_) {}
    // the shared canvas only grows (no reallocation while a piece resizes)
    // every piece gets its own band of the shared canvas (stacked), drawn first and copied out after: a WebGL canvas read by drawImage in the
    // same task can show a later draw (seen in Chromium), so no two pieces share pixels
    let needW = 1, needH = 0;
    for (const p of list) {
      const tw = Math.max(1, Math.round(p.cw * RS)), th = Math.max(1, Math.round(p.ch * RS)), c = p.c;
      if (tw !== c._tw || th !== c._th) { c._tw = tw; c._th = th; c._since = now; }
      if ((c.width !== tw || c.height !== th) && (c.width <= 1 || now - c._since >= SETTLE)) { c.width = tw; c.height = th; c._ra = (c._ra || 0) + 1; }
      p.y = needH; needW = Math.max(needW, c.width); needH += c.height;
    }
    if (glc.width < needW || glc.height < needH) { glc.width = Math.max(glc.width, needW); glc.height = Math.max(glc.height, needH); R.glReallocs = (R.glReallocs || 0) + 1; }
    gl.useProgram(prog); gl.disable(gl.BLEND);
    gl.uniform2f(U.uSceneSize, sc.width, sc.height); gl.uniform1f(U.uSS, SS);
    gl.uniform1f(U.uStr, R.str); gl.uniform1f(U.uBlur, R.blur); gl.uniform1f(U.uCA, R.ca ? 1 : 0); gl.uniform1f(U.uRimA, RIM_A);
    for (const p of list) {
      const c = p.c, w = c.width, h = c.height, S = w / p.cw, rad = radii(p.c, p.cw, p.ch).map((v) => v * S), tt = p.host._rft || { rgb: [16, 18, 24], a: 0.7 };
      const y0 = glc.height - p.y - h;   // GL rows count from the bottom
      gl.viewport(0, y0, w, h); gl.enable(gl.SCISSOR_TEST); gl.scissor(0, y0, w, h);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(U.uSize, w, h); gl.uniform2f(U.uOrigin, p.r.left, p.r.top); gl.uniform1f(U.uS, S); gl.uniform1f(U.uK, p.k);
      gl.uniform4f(U.uBox, w / 2, h / 2, w / 2, h / 2); gl.uniform4f(U.uRad, rad[0], rad[1], rad[2], rad[3]);
      gl.uniform3f(U.uTint, tt.rgb[0] / 255, tt.rgb[1] / 255, tt.rgb[2] / 255); gl.uniform1f(U.uTintA, tt.a);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.SCISSOR_TEST);
    for (const p of list) {
      const c = p.c, w = c.width, h = c.height, x = c._ctx; x.clearRect(0, 0, w, h); x.drawImage(glc, 0, p.y, w, h, 0, 0, w, h);
      const on = p.c.classList.contains("rf-cap") || p.c.classList.contains("rf-row") ? "rf-cap-on" : "rf-on";
      if (!p.host.classList.contains(on)) p.host.classList.add(on);   // (add() of a present class still writes the attribute)
    }
    R.renders++; const ms = performance.now() - t0; R.stats.ms = ms; R.stats.n++; R.stats.avg = R.stats.n === 1 ? ms : R.stats.avg * 0.9 + ms * 0.1;
  }

  // ---- loop: only while something changes ----------------------------------------------------------------------------------------------------
  let raf = 0, lastR = 0, lastT = 0, busyUntil = 0, dirty = true;
  const playing = () => !!(T.player && T.player.playing);
  const busy = () => document.hidden || !!(T.exporter && T.exporter.running);
  R.idle = () => !raf;
  function frame(now) {
    raf = 0; if (!R.on || busy()) return;
    R.frames++;
    const pl = playing();
    if (pl) feed(now);
    if (!R.on) return;
    if (dirty || now < busyUntil || (pl && now - lastR >= 30)) {
      dirty = false; lastR = now;
      try { render(now, now - tintAt >= 250 || !pl); } catch (e) { R.err = String(e && e.message || e); }
    }
    if (pl || now < busyUntil || dirty) raf = requestAnimationFrame(frame);
  }
  const kick = (ms) => { dirty = true; if (ms) busyUntil = Math.max(busyUntil, performance.now() + ms); if (!raf && R.on && !busy()) raf = requestAnimationFrame(frame); };
  R.kick = kick;
  // frame drops while playing (like auto-lite): under 40 fps for 2 s -> frosted for this session; seeking, resizing, play start and stalls don't count
  const FM = (R.mon = { frames: [], last: 0, slowSince: 0, holdUntil: 0, fps: 0 });
  FM.reset = () => { FM.frames.length = 0; FM.last = 0; FM.slowSince = 0; };
  FM.hold = (ms) => { FM.reset(); FM.holdUntil = performance.now() + (ms || 1200); };
  function feed(t, force) {
    if (!(R.autoFps || force)) return false;
    if (t < FM.holdUntil || [...document.querySelectorAll("#viewport video.on")].some((v) => v.seeking)) { FM.reset(); return false; }
    if (FM.last && t - FM.last > 400) { FM.reset(); FM.last = t; return false; }
    FM.last = t; FM.frames.push(t); while (FM.frames.length > 2 && t - FM.frames[0] > 1000) FM.frames.shift();
    const span = t - FM.frames[0]; if (span < 500) return false;
    FM.fps = (FM.frames.length - 1) * 1000 / span;
    if (FM.fps < R.SLOW) { if (!FM.slowSince) FM.slowSince = t; if (t - FM.slowSince >= R.FOR) { R.goFrost("slow"); return true; } }
    else if (FM.fps >= R.OK) FM.slowSince = 0;
    return false;
  }
  R.feed = (t) => feed(t, true);
  R.goFrost = (why) => {
    R.slow = why; R.apply();
    try { if (!sessionStorage.getItem("tdc.refractSaid")) { sessionStorage.setItem("tdc.refractSaid", "1"); T.toast && T.toast("Frosted glass for now: playback was dropping frames. Settings ▸ Appearance ▸ Glass style", null, 6000); } } catch (_) {}
  };

  // ---- on / off ------------------------------------------------------------------------------------------------------------------------------
  const mRT = (() => { try { return matchMedia("(prefers-reduced-transparency: reduce)"); } catch (_) { return null; } })();
  R.apply = () => {
    R.style = R.override() || R.pref();
    let why = R.style === "frost" ? (R.override() ? "override" : "pref") : mRT && mRT.matches ? "reduced-transparency" : G.lite ? "lite"
      : G.effective === "solid" ? "solid" : R.slow ? "slow" : "";
    if (!why && !glOK) { if (!glTried) initGL(); if (!glOK) why = "no-webgl"; }
    const was = R.on; R.on = !why; R.why = why;
    root.classList.toggle("refract", R.on);
    if (!R.on) { R.pieces.forEach((p) => unmark(p.host)); R.pieces = []; if (raf) { cancelAnimationFrame(raf); raf = 0; } }
    else { if (!was) FM.hold(); kick(400); }
    const seg = $("segRefract");
    if (seg) seg.querySelectorAll("button").forEach((b) => { b.classList.toggle("on", b.dataset.v === R.style); b.setAttribute("aria-pressed", String(b.dataset.v === R.style)); });
    const note = $("refractNote");
    if (note) { note.textContent = R.override() ? "Set by ?refract= in the address for this visit." : R.style === "frost" ? ""
      : { "reduced-transparency": "Reduce transparency is on in your system, so the controls are solid.", lite: "Lite mode is on, so the glass is frosted.", solid: "Glass is set to Solid (or this browser can't blur), so the controls are solid.",
          slow: "Frosted for now: playback was dropping frames.", "no-webgl": "This browser has no WebGL, so the glass is frosted." }[why] || ""; note.hidden = !note.textContent; }
    if (G.budgetSoon) G.budgetSoon();
  };
  /** Tests: a drawable (or list) used as the picture under the whole window until R.sample(null); renders once. */
  R.sample = (src) => { if (src !== undefined) pin = src ? [].concat(src) : null; if (R.on && !busy()) { const now = performance.now(); render(now, true); } return R.pieces.length; };
  R.render = () => { if (R.on) render(performance.now(), true); };

  function wire() {
    const seg = $("segRefract"); if (seg && !seg._wired) { seg._wired = true; seg.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => T.setPref("glassStyle", b.dataset.v))); }
  }
  const start = () => {
    wire(); R.apply();
    try { new MutationObserver((ms) => { if (!R.on) return; for (const m of ms) { const t = m.target; if (t && t.classList && t.classList.contains("rf-c")) continue; kick(700); return; } })
      .observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden", "class", "style", "aria-expanded"] }); } catch (_) {}
    const onResize = () => { FM.hold(); kick(400); };
    addEventListener("resize", onResize); addEventListener("orientationchange", onResize);
    if (window.visualViewport) visualViewport.addEventListener("resize", onResize);
    (function watchDpr() { try { const mq = matchMedia("(resolution: " + (window.devicePixelRatio || 1) + "dppx)"); let done = false;
      const h = () => { if (done) return; done = true; try { mq.removeEventListener("change", h); } catch (_) {} onResize(); watchDpr(); };
      if (mq.addEventListener) mq.addEventListener("change", h); else if (mq.addListener) mq.addListener(h); } catch (_) {} })();
    document.addEventListener("visibilitychange", () => { FM.hold(); if (!document.hidden) kick(200); });
    document.addEventListener("seeked", () => kick(), true);
    document.addEventListener("loadeddata", () => kick(300), true);
    document.addEventListener("scroll", () => kick(), true);
    if (mRT) { try { mRT.addEventListener("change", R.apply); } catch (_) { try { mRT.addListener(R.apply); } catch (__) {} } }
  };
  if (T.on) {
    T.on("prefs", (k) => { if (k === "glassStyle" || k === "glass" || k === "lite" || k === "*") { if (k === "glassStyle" || k === "*") R.slow = ""; setTimeout(R.apply, 0); } });
    T.on("state", () => { FM.hold(); kick(200); }); T.on("time", () => { if (!playing()) kick(); }); T.on("player-open", () => { FM.hold(); kick(600); });
  }
  // glass.js re-applies on lite / solid changes: follow it (auto-lite turns refraction off with the rest)
  const gApply = G.apply; G.apply = function () { const r = gApply.apply(this, arguments); if (R.apply && T.refract === R) { try { R.apply(); } catch (_) {} } return r; };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
