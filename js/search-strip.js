/* search-strip.js — phones, full screen or one camera: a compact, collapsible strip of thumbnails at the bottom.
 * "Results" = search matches (frame thumbnail + time + label); tap one to jump there (camera + time + gold box,
 * the same path as the search panel). "Cameras" = small snapshots of each camera; tap to switch.
 * Thumbnails are made lazily (only when scrolled into view), one at a time on a single hidden <video>, at 96 px,
 * cached as JPEG object URLs (max 40) and revoked when the results or the event change. If anything here
 * fails the strip simply never appears; the search panel and the camera bar keep working. */
(function () {
  "use strict";
  const T = window.TDC;
  const $ = (id) => document.getElementById(id);
  const CAM = { front: "Front", back: "Rear", left_repeater: "Left rep.", right_repeater: "Right rep.", left_pillar: "Left pillar", right_pillar: "Right pillar" };
  const ORDER = ["front", "back", "left_pillar", "right_pillar", "left_repeater", "right_repeater"];
  const KEY = "tdc.searchStrip.v1";
  const TW = 96, MAXC = 40;
  const SS = (T.searchStrip = { ok: false, shown: false, tab: "results", collapsed: false, made: 0, cache: new Map(), error: null });
  try { const o = JSON.parse(localStorage.getItem(KEY) || "null"); if (o) { SS.collapsed = !!o.collapsed; if (o.tab === "cams") SS.tab = "cams"; } } catch (e) {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ collapsed: SS.collapsed, tab: SS.tab })); } catch (e) {} };
  const fmt = (t) => (T.fmtTime ? T.fmtTime(t, true) : t.toFixed(1) + "s");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const mq = window.matchMedia ? window.matchMedia("(max-width: 760px), (pointer: coarse) and (max-width: 1024px)") : null;
  SS.phone = () => !!(mq && mq.matches) || /[?&]strip=1\b/.test(location.search);
  SS.wanted = () => {
    const b = document.body;
    return SS.phone() && !!(T.player && T.player.ev) && (b.classList.contains("fs") || !!(T.focus && T.focus.cam)) && !b.classList.contains("usearch-classic");
  };

  /* ---------- items ---------- */
  function label(h, best) {
    if ((h.plate || h.streetText) && h.text) return h.text + (h.weak ? " weak" : "");   // Phase 6: "7ABC234 91%" (· checked by …)
    if (h.label && h.conf != null) return h.label + " " + Math.round(h.conf * 100) + "%";
    try { if (h.box && T.burnBoxes && T.burnBoxes.labelFor) return T.burnBoxes.labelFor(h, T.search.phrase, best); } catch (e) {}
    return (T.search.phrase || "match") + "?" + (h.weak ? " weak" : "");
  }
  function items() {
    const out = [];
    const hits = (T.search && T.search.hits) || [];
    const best = hits.reduce((m, h) => Math.max(m, h.score || 0), 0);
    hits.forEach((h, i) => out.push({ kind: "find", i, t: h.t, cam: h.cam, box: h.box, text: label(h, best), picked: T.search.anchor != null && Math.abs(T.search.anchor - h.t) < 0.05 && T.search.pickedCam === h.cam }));
    const runs = (T.searchUI && T.searchUI.redactRuns && T.searchUI.redactRuns()) || [];
    runs.forEach((r, i) => out.push({ kind: "redact", i, t: r.t, cam: r.cam, box: r.boxes && r.boxes[0], text: (T.redact.action === "remove" ? "removed" : "blurred") + " · " + r.spots }));
    return out;
  }
  const keyOf = (it) => (T.player.ev ? T.player.ev.id : "") + "|" + it.cam + "|" + it.t.toFixed(2);

  /* ---------- lazy thumbnails (one hidden video, sequential) ---------- */
  let vid = null, queue = [], busy = false, io = null;
  function waitEv(el, ev, ms) {
    return new Promise((res, rej) => {
      const to = setTimeout(() => { el.removeEventListener(ev, ok); rej(new Error(ev + " timed out")); }, ms);
      const ok = () => { clearTimeout(to); res(); };
      el.addEventListener(ev, ok, { once: true });
    });
  }
  async function makeThumb(it) {
    const ev = T.player.ev; if (!ev) return null;
    const ci = T.player.clipIndexAt(it.t), clip = ev.clips[ci];
    const f = clip && clip.files[it.cam];
    if (!f || !f.blob) return null;                       // still encrypted / missing: keep the placeholder
    const url = f.url || (f.url = URL.createObjectURL(f.blob));   // shared with the player; never revoked here
    if (!vid) { vid = document.createElement("video"); vid.muted = true; vid.playsInline = true; vid.setAttribute("playsinline", ""); vid.preload = "auto"; }
    if (vid._src !== url) { vid.src = url; vid._src = url; await waitEv(vid, "loadeddata", 6000); }
    const local = Math.min(Math.max(0, it.t - clip.start), Math.max(0, (vid.duration || 1) - 0.05));
    if (Math.abs(vid.currentTime - local) > 0.04 || vid.readyState < 2) { vid.currentTime = local; await waitEv(vid, "seeked", 6000); }
    const vw = vid.videoWidth || 16, vh = vid.videoHeight || 9;
    const c = document.createElement("canvas"); c.width = TW; c.height = Math.round(TW * vh / vw);
    const x = c.getContext("2d"); x.drawImage(vid, 0, 0, c.width, c.height);
    if (it.box) { x.strokeStyle = "#e6b422"; x.lineWidth = 2; x.strokeRect(it.box.x * c.width, it.box.y * c.height, Math.max(3, it.box.w * c.width), Math.max(3, it.box.h * c.height)); }
    const blob = await new Promise((r) => (c.toBlob ? c.toBlob(r, "image/jpeg", 0.72) : r(null)));
    c.width = c.height = 0;
    return blob ? URL.createObjectURL(blob) : null;
  }
  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const it = queue.shift(), k = keyOf(it);
        if (SS.cache.has(k)) { paint(k); continue; }
        let u = null;
        try { u = await makeThumb(it); } catch (e) { u = null; }
        SS.cache.set(k, u || "");
        if (u) SS.made++;
        while (SS.cache.size > MAXC) { const [k0, u0] = SS.cache.entries().next().value; if (u0) URL.revokeObjectURL(u0); SS.cache.delete(k0); }
        paint(k);
      }
    } finally {
      busy = false;
      if (vid) { vid.removeAttribute("src"); vid._src = null; try { vid.load(); } catch (e) {} }   // free the decoder
    }
  }
  function paint(k) {
    const u = SS.cache.get(k);
    document.querySelectorAll('#ssRow .ss-item[data-k="' + CSS.escape(k) + '"] .ss-img').forEach((n) => {
      if (u && !n.querySelector("img")) { const im = new Image(); im.alt = ""; im.decoding = "async"; im.src = u; n.appendChild(im); }
      n.classList.toggle("none", !u);
    });
  }
  SS.clearThumbs = () => { for (const u of SS.cache.values()) if (u) URL.revokeObjectURL(u); SS.cache.clear(); queue = []; };

  /* ---------- camera snapshots (cheap: drawImage from the live tiles, throttled) ---------- */
  let camT = 0;
  function drawCams(force) {
    if (!SS.shown || SS.collapsed || SS.tab !== "cams") return;
    const now = performance.now();
    if (!force && now - camT < 2000) return;
    camT = now;
    const P = T.player;
    document.querySelectorAll("#ssRow .ss-cam").forEach((b) => {
      const t = P.tiles && P.tiles[b.dataset.cam], v = t && t.vids[P.active], c = b.querySelector("canvas");
      if (!v || !c || v.readyState < 2) return;
      try { c.getContext("2d").drawImage(v, 0, 0, c.width, c.height); } catch (e) {}
      b.classList.toggle("on", T.focus.cam === b.dataset.cam);
    });
  }

  /* ---------- render ---------- */
  let sig = "";
  function render() {
    const row = $("ssRow");
    const list = items();
    $("ssCount").textContent = list.length ? String(list.length) : "";
    $("ssTabRes").setAttribute("aria-pressed", String(SS.tab === "results"));
    $("ssTabCam").setAttribute("aria-pressed", String(SS.tab === "cams"));
    $("ssToggle").setAttribute("aria-expanded", String(!SS.collapsed));
    $("ssToggle").setAttribute("aria-label", SS.collapsed ? "Show thumbnails" : "Hide thumbnails");
    $("usStrip").classList.toggle("collapsed", SS.collapsed);
    row.hidden = SS.collapsed;
    if (SS.collapsed) { sig = ""; row.innerHTML = ""; return; }
    let h = "";
    if (SS.tab === "results") {
      if (!list.length) h = '<div class="ss-empty">No search results yet. Search, then tap a thumbnail to jump there.</div>';
      for (const it of list) {
        h += '<button type="button" class="ss-item' + (it.picked ? " picked" : "") + '" role="option" data-kind="' + it.kind + '" data-i="' + it.i + '" data-k="' + esc(keyOf(it)) + '" aria-label="' + esc(fmt(it.t) + ", " + (CAM[it.cam] || it.cam) + ", " + it.text) + '">' +
          '<span class="ss-img"></span><span class="ss-meta"><span class="ss-t">' + esc(fmt(it.t)) + '</span><span class="ss-c">' + esc(CAM[it.cam] || it.cam) + '</span></span><span class="ss-l">' + esc(it.text) + "</span></button>";
      }
    } else {
      const P = T.player;
      for (const cam of ORDER) {
        if (!P.tiles || !P.tiles[cam] || (P.ev && !P.ev.cams.includes(cam))) continue;
        h += '<button type="button" class="ss-cam' + (T.focus.cam === cam ? " on" : "") + '" data-cam="' + cam + '" aria-label="Show ' + esc(CAM[cam]) + '"><canvas width="' + TW + '" height="54"></canvas><span class="ss-l">' + esc(CAM[cam]) + "</span></button>";
      }
      h += '<button type="button" class="ss-cam ss-all" data-cam="" aria-label="All cameras"><span class="ss-grid" aria-hidden="true"></span><span class="ss-l">All</span></button>';
    }
    const s2 = SS.tab + "|" + h;
    if (s2 !== sig) {
      sig = s2; row.innerHTML = h;
      if (SS.tab === "results") row.querySelectorAll(".ss-item").forEach((b) => { if (SS.cache.has(b.dataset.k)) paint(b.dataset.k); else if (io) io.observe(b); else enqueue(b); });
      else drawCams(true);
    }
  }
  function enqueue(b) {
    const list = items(), it = list.find((x) => x.kind === b.dataset.kind && x.i === +b.dataset.i);
    if (it && !SS.cache.has(keyOf(it)) && !queue.some((q) => keyOf(q) === keyOf(it))) { queue.push(it); pump(); }
  }
  let lastEv = null;
  function update() {
    try {
      const strip = $("usStrip"); if (!strip) return;
      const ev = T.player && T.player.ev;
      if (ev !== lastEv) { SS.clearThumbs(); lastEv = ev; }
      if (SS.cache.size && !items().length) SS.clearThumbs();          // results cleared: free the thumbnails
      const want = SS.wanted();
      if (want !== SS.shown) {
        SS.shown = want; strip.hidden = !want;
        document.body.classList.toggle("ss-on", want);
        if (!want) { queue = []; sig = ""; $("ssRow").innerHTML = ""; }
      }
      if (want) { render(); const hgt = strip.offsetHeight; document.documentElement.style.setProperty("--ss-h", hgt + "px"); }
      else document.documentElement.style.setProperty("--ss-h", "0px");
    } catch (err) { SS.error = String(err && err.message || err); console.warn("[search-strip]", err); }
  }
  SS.update = update;
  SS.setTab = (t) => { SS.tab = t === "cams" ? "cams" : "results"; SS.collapsed = false; save(); update(); };
  SS.setCollapsed = (on) => { SS.collapsed = !!on; save(); update(); };

  function build() {
    const strip = document.createElement("div");
    strip.className = "us-strip"; strip.id = "usStrip"; strip.hidden = true;
    strip.setAttribute("role", "region"); strip.setAttribute("aria-label", "Thumbnails");
    strip.innerHTML =
      '<div class="ss-head">' +
      '<button type="button" class="ss-tab" id="ssTabRes" aria-pressed="true">Results <span class="ss-n" id="ssCount"></span></button>' +
      '<button type="button" class="ss-tab" id="ssTabCam" aria-pressed="false">Cameras</button>' +
      '<button type="button" class="ss-tog" id="ssToggle" aria-expanded="true" aria-controls="ssRow"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button></div>' +
      '<div class="ss-row" id="ssRow" role="listbox" aria-label="Search results"></div>';
    const tp = $("transport");
    tp.parentNode.insertBefore(strip, tp);
    $("ssTabRes").addEventListener("click", () => SS.setTab("results"));
    $("ssTabCam").addEventListener("click", () => SS.setTab("cams"));
    $("ssToggle").addEventListener("click", () => SS.setCollapsed(!SS.collapsed));
    $("ssRow").addEventListener("click", (e) => {
      const it = e.target.closest(".ss-item");
      if (it) { T.searchUI.select(it.dataset.kind, +it.dataset.i); setTimeout(update, 50); return; }
      const c = e.target.closest(".ss-cam");
      if (c) { c.dataset.cam ? T.focus.focus(c.dataset.cam) : T.focus.grid(); setTimeout(update, 50); }
    });
    if (typeof IntersectionObserver === "function") io = new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting) { io.unobserve(en.target); enqueue(en.target); } }), { root: $("ssRow"), rootMargin: "0px 120px" });
    let pend = false;   // coalesce bursts; rAF can stall (hidden tab, headless WebKit), so a timer backs it up
    const run = () => { if (!pend) return; pend = false; update(); };
    const soon = () => { if (pend) return; pend = true; requestAnimationFrame(run); setTimeout(run, 120); };
    const mo = new MutationObserver(soon);
    mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    for (const id of ["findHits", "redactStatus"]) if ($(id)) mo.observe($(id), { childList: true, subtree: true, characterData: true });
    if (mq && mq.addEventListener) mq.addEventListener("change", soon);
    window.addEventListener("resize", soon);
    if (T.on) { T.on("player-open", () => { SS.clearThumbs(); soon(); }); T.on("time", () => drawCams(false)); }
    SS.ok = true;
  }
  SS.init = () => {
    try { if (window.__TDC_STRIP_FAIL) throw new Error("forced failure (test)"); if (!T.searchUI || !T.searchUI.ok) return false; build(); update(); }
    catch (err) { SS.ok = false; SS.error = String((err && err.message) || err); const s = $("usStrip"); if (s) s.remove(); console.warn("[search-strip] off:", err); }
    return SS.ok;
  };
})();
