/* search-ui.js — Phase 4: one floating search for both Find (object/scene) and Redact (text/plates/faces).
 * It drives the classic Find and Redact bars underneath (same inputs, same buttons), so search.js and
 * redact.js are unchanged. Collapsed to an icon by default; expands on tap, "/" or Cmd/Ctrl+K; Esc closes.
 * On phones it is a bottom sheet pinned above the on-screen keyboard with visualViewport (position: fixed,
 * the video grid is never resized). If anything here fails, body never gets the "usearch" class, so the
 * classic bars stay visible. Settings → "Classic search bars" (or ?search=classic) also shows them.
 * Window modes (search-float): "dock" (default) puts the panel in normal page flow BELOW the video, so it never
 * covers a camera (the grid is refitted into the remaining height, like the camera bar's "Beside video" dock).
 * "float" detaches it into a draggable window (drag the header; mouse, pen or touch; arrow keys on the grip),
 * clamped to the viewport and resizable; "pin" locks it where the user put it. Saved in localStorage.
 * redact-button: the panel has two tabs, Find and Redact. The Search button opens Find, the new Redact button (#rdBtn, right
 * beside it) opens Redact: the automatic hide controls (text, plates, faces) and the Custom regions section, always open, with
 * a primary "Draw region" at the top. The tab is remembered for the session (sessionStorage tdc.us.tab). One panel, same ids. */
(function () {
  "use strict";
  const T = window.TDC;
  const $ = (id) => document.getElementById(id);
  const KEY = "tdc.classicSearch";
  const U = (T.searchUI = { ok: false, open: false, error: null, mode: null });
  const CAM = { front: "Front", back: "Rear", left_repeater: "Left repeater", right_repeater: "Right repeater", left_pillar: "Left pillar", right_pillar: "Right pillar" };
  const vv = () => window.visualViewport || null;
  const fmt = (t) => (T.fmtTime ? T.fmtTime(t, true) : t.toFixed(1) + "s");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  let built = [];
  const TABKEY = "tdc.us.tab";
  U.tab = "find";
  try { if (sessionStorage.getItem(TABKEY) === "redact") U.tab = "redact"; } catch (e) {}

  U.classic = () => { try { return localStorage.getItem(KEY) === "1" || /[?&]search=classic\b/.test(location.search); } catch (e) { return false; } };
  U.setClassic = (on) => {
    try { on ? localStorage.setItem(KEY, "1") : localStorage.removeItem(KEY); } catch (e) {}
    document.body.classList.toggle("usearch-classic", !!on);
    [$("usClassic"), $("setClassicSearch")].forEach((c) => { if (c) c.checked = !!on; });
    if (T.ui && T.ui.fit) try { T.ui.fit(); } catch (e) {}
  };
  U.narrow = () => window.matchMedia("(max-width: 760px), (pointer: coarse) and (max-width: 1024px)").matches;

  function el(tag, attrs, html) {
    const n = document.createElement(tag);
    for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
    if (html != null) n.innerHTML = html;
    return n;
  }

  /* ---------- keyboard / visualViewport ---------- */
  function placeSheet() {
    const p = $("usPanel");
    if (!p) return;
    const v = vv();
    const ih = window.innerHeight;
    const vh = v ? v.height : ih, top = v ? v.offsetTop : 0;
    const kb = Math.max(0, Math.round(ih - (vh + top)));          // what the keyboard covers
    p.style.setProperty("--us-kb", kb + "px");
    p.style.setProperty("--us-vvh", Math.round(vh) + "px");
    U.keyboard = kb;
    const tp = $("transport");
    p.style.setProperty("--us-tp", (tp && !document.body.classList.contains("fs") ? tp.offsetHeight : 90) + "px");
    // phone, docked, typing: lift the panel above the keyboard (a spacer keeps the grid exactly where it was)
    typing(U.open && W.mode === "dock" && U.narrow() && kb > 40 && document.activeElement === $("usQuery"));
    if (W.mode === "float") placeFloat();
  }
  function typing(on) {
    const p = $("usPanel"), d = $("usDock");
    if (!p || !d) return;
    if (on && !p.classList.contains("sheet")) { d.style.height = d.offsetHeight + "px"; p.classList.add("sheet"); }
    else if (!on && p.classList.contains("sheet")) { p.classList.remove("sheet"); d.style.height = ""; }
  }

  /* ---------- window: dock below the video / float / pin ---------- */
  const WKEY = "tdc.searchPanel.v1";
  const W = (U.win = { mode: "dock", x: null, y: null, w: null, h: null, pinned: false });
  try { const o = JSON.parse(localStorage.getItem(WKEY) || "null"); if (o && typeof o === "object") { if (o.mode === "float") W.mode = "float"; ["x", "y", "w", "h"].forEach((k) => { if (Number.isFinite(o[k])) W[k] = o[k]; }); W.pinned = !!o.pinned; } } catch (e) {}
  function saveWin() { try { localStorage.setItem(WKEY, JSON.stringify(W)); } catch (e) {} }
  function view() {   // the visible area: the visual viewport when the keyboard shrinks it
    const v = vv();
    return v ? { l: v.offsetLeft || 0, t: v.offsetTop || 0, w: v.width, h: v.height } : { l: 0, t: 0, w: window.innerWidth, h: window.innerHeight };
  }
  const M = 6;
  /** Clamp the floating window into the visible area. The saved x/y stay as the user set them, so the window
   *  goes back there when the viewport grows again. */
  function placeFloat() {
    const p = $("usPanel");
    if (!p || W.mode !== "float") return;
    const v = view();
    if (W.w) p.style.width = Math.min(W.w, v.w - 2 * M) + "px";
    if (W.h) p.style.height = Math.min(W.h, v.h - 2 * M) + "px";
    // never taller than the visible area (the window scrolls inside). The 45% cap (redact-button) is for the docked panel and the phone sheet; a floating window the user places and sizes is left as before
    p.style.maxHeight = Math.max(150, Math.round(v.h - 2 * M)) + "px";
    const pw = p.offsetWidth || 360, ph = p.offsetHeight || 200;
    let x = W.x == null ? v.w - pw - 16 : W.x, y = W.y == null ? 70 : W.y;
    x = Math.max(v.l + M, Math.min(x, v.l + v.w - pw - M));
    y = Math.max(v.t + M, Math.min(y, v.t + v.h - ph - M));
    p.style.left = Math.round(x) + "px";
    p.style.top = Math.round(y) + "px";
  }
  U.placeFloat = placeFloat;
  function applyMode() {
    const p = $("usPanel"), d = $("usDock");
    if (!p || !d) return;
    const fl = W.mode === "float";
    p.classList.toggle("floating", fl);
    p.classList.toggle("docked", !fl);
    p.classList.toggle("pinned", fl && W.pinned);
    if (fl) {
      if (p.parentNode !== document.body) document.body.appendChild(p);
      placeFloat();
    } else {
      if (p.parentNode !== d) d.appendChild(p);
      p.style.left = p.style.top = p.style.width = p.style.height = p.style.maxHeight = "";
    }
    const dockShown = !fl && U.open;
    if (d.hidden === dockShown) { d.hidden = !dockShown; if (T.ui && T.ui.fit) requestAnimationFrame(() => { try { T.ui.fit(); } catch (e) {} }); }
    document.body.classList.toggle("us-docked", dockShown);
    const fb = $("usFloat"), pb = $("usPin");
    if (fb) {
      fb.setAttribute("aria-pressed", String(fl));
      fb.title = fl ? "Dock below the video" : "Float: move the search window anywhere";
      fb.setAttribute("aria-label", fl ? "Dock search below the video" : "Float the search window");
      fb.classList.toggle("is-float", fl);
    }
    if (pb) {
      pb.hidden = !fl;
      pb.setAttribute("aria-pressed", String(fl && W.pinned));
      pb.title = W.pinned ? "Unpin: allow moving and resizing" : "Pin: lock the window where it is";
      pb.setAttribute("aria-label", W.pinned ? "Unpin the search window" : "Pin the search window in place");
    }
    const g = $("usGrip");
    if (g) { g.tabIndex = fl && !W.pinned ? 0 : -1; g.setAttribute("aria-disabled", String(!fl || W.pinned)); }
  }
  U.applyMode = applyMode;
  /** mode: "dock" | "float". Floating starts where the docked panel was, unless a position was saved. */
  U.setMode = (mode) => {
    const p = $("usPanel");
    if (mode === "float" && W.mode !== "float" && p && W.x == null) {
      const r = p.getBoundingClientRect();
      const w = Math.min(480, window.innerWidth - 2 * M);
      W.w = W.w || w;
      W.x = r.width ? r.left + Math.max(0, (r.width - w) / 2) : null;
      W.y = r.height ? Math.max(70, r.top - 260) : null;
    }
    W.mode = mode === "float" ? "float" : "dock";
    if (W.mode === "dock") typing(false);
    saveWin(); applyMode();
  };
  U.setPinned = (on) => { W.pinned = !!on; saveWin(); applyMode(); };
  U.moveBy = (dx, dy) => {
    if (W.mode !== "float" || W.pinned) return false;
    const p = $("usPanel"), r = p.getBoundingClientRect();
    W.x = r.left + dx; W.y = r.top + dy; placeFloat();
    const r2 = p.getBoundingClientRect(); W.x = r2.left; W.y = r2.top; saveWin();
    return true;
  };
  function wireDrag(p) {
    const head = $("usHead");
    let drag = null;
    head.addEventListener("pointerdown", (e) => {
      if (W.mode !== "float" || W.pinned || e.button > 0 || e.target.closest("button, input, select")) return;
      const r = p.getBoundingClientRect();
      drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
      try { head.setPointerCapture(e.pointerId); } catch (err) {}
      p.classList.add("dragging");
      e.preventDefault();
    });
    head.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      W.x = e.clientX - drag.dx; W.y = e.clientY - drag.dy; placeFloat();
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null; p.classList.remove("dragging");
      const r = p.getBoundingClientRect(); W.x = r.left; W.y = r.top; saveWin();
    };
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
    head.addEventListener("dblclick", (e) => { if (!e.target.closest("button")) U.setMode(W.mode === "float" ? "dock" : "float"); });
    $("usGrip").addEventListener("keydown", (e) => {
      const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!k) return;
      e.preventDefault(); e.stopPropagation();
      const step = e.shiftKey ? 60 : 12;
      U.moveBy(k[0] * step, k[1] * step);
    });
    // user resize (CSS resize handle on the floating window): remember the size
    if (typeof ResizeObserver === "function") {
      let t = 0;
      new ResizeObserver(() => {
        if (W.mode !== "float" || W.pinned || p.hidden || drag) return;
        clearTimeout(t);
        t = setTimeout(() => {   // the browser writes the new size into style.width/height; ignore our own clamping
          const v = view(), sw = parseFloat(p.style.width), sh = parseFloat(p.style.height);
          if (Number.isFinite(sw) && sw < v.w - 2 * M - 1 && sw !== W.w) W.w = Math.round(sw);
          if (Number.isFinite(sh) && sh < v.h - 2 * M - 1 && sh !== W.h) W.h = Math.round(sh);
          else if (Number.isFinite(sh) && sh >= v.h - 2 * M - 1) W.h = Math.round(v.h - 2 * M);   // dragged taller than the screen: keep it at the biggest that fits
          saveWin(); placeFloat();   // re-clamp so the bottom edge (and the resize corner) never ends up off screen
        }, 250);
      }).observe(p);
    }
  }
  function setOverlaysContent(on) {   // Android Chrome: keyboard overlays the page instead of resizing it
    const m = document.querySelector('meta[name="viewport"]');
    if (!m) return;
    if (on && !m.dataset.usOrig) { m.dataset.usOrig = m.content; if (!/interactive-widget/.test(m.content)) m.content += ", interactive-widget=overlays-content"; }
    else if (!on && m.dataset.usOrig) { m.content = m.dataset.usOrig; delete m.dataset.usOrig; }
  }

  /** Switch the tab ("find" | "redact"). Remembered for the session. */
  function setTab(tab, opt) {
    tab = tab === "redact" ? "redact" : "find";
    const p = $("usPanel"); if (!p) return;
    U.tab = tab;
    if (!opt || opt.remember !== false) { try { sessionStorage.setItem(TABKEY, tab); } catch (e) {} }
    p.dataset.tab = tab;
    for (const [id, t] of [["usTabFind", "find"], ["usTabRedact", "redact"]]) { const b = $(id); if (b) { b.setAttribute("aria-selected", String(t === tab)); b.tabIndex = t === tab ? 0 : -1; } }
    const q = $("usQuery");
    if (q) { q.placeholder = tab === "redact" ? "Text to hide: Oak Ave, a name, a plate" : "A cyclist in the bike lane · text Oak Ave · 20:53:46 · 2:30"; q.setAttribute("aria-label", tab === "redact" ? "Text to hide" : "Search"); }
    const h = $("usHeadLbl"); if (h) h.textContent = tab === "redact" ? "Redact" : "Search";
    p.setAttribute("aria-label", tab === "redact" ? "Redact the video" : "Search the video");
    syncBtns();
    if (U.ok || p) { try { results(); } catch (e) {} }
    if (W.mode === "float") placeFloat();
    if (T.ui && T.ui.fit && W.mode !== "float" && U.open) requestAnimationFrame(() => { try { T.ui.fit(); } catch (e) {} });
  }
  U.setTab = (tab) => setTab(tab);
  function syncBtns() {
    const f = $("usBtn"), r = $("rdBtn");
    if (f) f.setAttribute("aria-expanded", String(U.open && U.tab === "find"));
    if (r) r.setAttribute("aria-expanded", String(U.open && U.tab === "redact"));
  }
  /** show(focus, tab): tab "find" | "redact"; without it the remembered tab opens. */
  U.show = (focus, tab) => {
    const p = $("usPanel");
    if (!p) return;
    if (tab === "find" || tab === "redact") setTab(tab);
    else if (p.dataset.tab !== U.tab) setTab(U.tab, { remember: false });
    U.open = true;
    p.hidden = false;
    document.body.classList.add("us-open");
    syncBtns();
    if (U.narrow()) setOverlaysContent(true);
    applyMode();
    placeSheet();
    refresh();
    if (focus !== false) {
      const q = U.tab === "redact" ? $("crDraw") : $("usQuery");   // Redact: don't pop the phone keyboard, land on Draw region
      try { q.focus({ preventScroll: true }); } catch (e) { q.focus(); }
    }
  };
  /* ui-glass-6: the thin docked strip (wide screens) keeps a few things in small popovers above it: the saved regions (#crRegBtn),
     the help (#crInfo) and the ⋯ menu (#usMore: Save / Load regions file, Classic search bars). Elsewhere these buttons are hidden by CSS. */
  const POPS = [["usMore", "usPanel", "more-open"], ["crRegBtn", "crSec", "list-open"], ["crInfo", "crSec", "hint-open"]];
  function setPop(id, on) { const d = POPS.find((x) => x[0] === id), b = d && $(d[0]), h = d && $(d[1]); if (!b || !h) return; h.classList.toggle(d[2], on); b.setAttribute("aria-expanded", String(on)); }
  U.setPop = setPop;
  U.closePops = (except) => {
    let any = false;
    for (const [b, h, c] of POPS) { if (b === except) continue; const host = $(h); if (!host || !host.classList.contains(c)) continue;
      const a = document.activeElement, pop = { "more-open": ["crFileRow", "usFoot"], "list-open": ["crList"], "hint-open": ["crHint"] }[c].map($);
      setPop(b, false); any = true; if (a && pop.some((x) => x && x.contains(a))) { const bt = $(b); if (bt) bt.focus({ preventScroll: true }); } }
    return any;
  };
  U.hide = () => {
    U.closePops();
    const p = $("usPanel");
    if (!p) return;
    U.open = false;
    p.hidden = true;
    document.body.classList.remove("us-open");
    syncBtns();
    if (document.activeElement && p.contains(document.activeElement)) document.activeElement.blur();
    setOverlaysContent(false);
    typing(false);
    applyMode();
  };
  U.toggle = () => (U.open ? U.hide() : U.show());
  /** The Search button: opens Find; on the other tab it switches to Find; on Find it closes. The Redact button does the same for Redact. */
  U.toggleTab = (tab) => { if (U.open && U.tab === tab) U.hide(); else U.show(true, tab); };

  /* ---------- actions: drive the classic bars ---------- */
  function syncCam() { const v = $("usCam").value; if ($("findCam")) $("findCam").value = v; if ($("redactCam")) $("redactCam").value = v; }
  U.find = (q) => {
    q = (q != null ? q : $("usQuery").value).trim();
    if (!q) { $("usQuery").focus(); return; }
    if (U.open) setTab("find");
    syncCam(); $("findQuery").value = q; U.mode = "find"; $("btnFind").click(); refresh();
  };
  U.redact = (q) => {
    q = (q != null ? q : $("usQuery").value).trim();
    if (!q) { $("usQuery").focus(); return; }
    if (U.open) setTab("redact");
    syncCam(); $("redactQuery").value = q; U.mode = "redact"; $("btnRedact").click(); refresh();
  };
  U.stop = () => { const a = $("btnFindStop"), b = $("btnRedactStop"); if (a && !a.hidden) a.click(); if (b && !b.hidden) b.click(); };
  U.clear = () => { if (T.search) T.search.clear(); if (T.redact) T.redact.clear(); clearHighlight(); refresh(); if (T.searchStrip && T.searchStrip.ok) T.searchStrip.update(); };

  /* ---------- results ---------- */
  U.redactRuns = () => {   // consecutive samples with boxes, per camera, grouped into runs
    const R = T.redact;
    if (!R || !R.active || !R.frames) return [];
    const out = [];
    for (const cam of Object.keys(R.frames)) {
      let run = null;
      for (const f of R.frames[cam].slice().sort((a, b) => a.t - b.t)) {
        if (!f.boxes || !f.boxes.length) { run = null; continue; }
        if (run && f.t - run.end <= 1.6) { run.end = f.t; run.spots = Math.max(run.spots, f.boxes.length); continue; }
        run = { cam, t: f.t, end: f.t, spots: f.boxes.length, boxes: f.boxes };
        out.push(run);
      }
    }
    return out.sort((a, b) => a.t - b.t || a.cam.localeCompare(b.cam));
  };

  function results() {
    const box = $("usResults");
    const hits = (T.search && T.search.hits) || [];
    const runs = U.redactRuns();
    let h = "";
    if (hits.length) {
      h += '<div class="us-group us-r-find">Find matches <span>' + hits.length + "</span></div>";
      hits.forEach((x, i) => {
        if (x.timeJump) { h += '<button type="button" class="us-r-find us-item us-time' + (x.inRange === false ? " out" : "") + '" role="option" data-kind="find" data-i="' + i + '"><span class="us-t">⏱ ' + esc(fmt(x.t)) + "</span><span>" + esc(x.text) + "</span></button>"; return; }
        h += '<button type="button" class="us-r-find us-item' + (x.best ? " best" : "") + (x.thumb ? " has-thumb" : "") + '" role="option" data-kind="find" data-i="' + i + '">' + (x.thumb ? '<img class="us-thumb" alt="" src="' + esc(x.thumb) + '">' : "") + '<span class="us-t">' + esc(fmt(x.t)) + "</span><span>" + (x.termColor ? '<i class="term-dot" style="background:' + esc(x.termColor) + '"></i>' : "") + esc(CAM[x.cam] || x.cam) + (x.term ? " · " + esc(x.term) : "") + (x.text ? " · " + esc(x.text) : "") + (x.weak ? ' <em>weak</em>' : "") + "</span></button>";
      });
    }
    if (runs.length) {
      h += '<div class="us-group us-r-redact">' + (T.redact.action === "remove" ? "Removed" : "Blurred") + " text / regions <span>" + runs.length + "</span></div>";
      runs.forEach((r, i) => {
        h += '<button type="button" class="us-r-redact us-item" role="option" data-kind="redact" data-i="' + i + '"><span class="us-t">' + esc(fmt(r.t)) + "</span><span>" + esc(CAM[r.cam] || r.cam) + " · " + r.spots + " spot" + (r.spots === 1 ? "" : "s") + (r.end > r.t ? " · to " + esc(fmt(r.end)) : "") + "</span></button>";
      });
    }
    box.innerHTML = h;
    box.hidden = !h;
    box.classList.toggle("us-empty", U.tab === "redact" ? !runs.length : !hits.length);   // nothing for this tab: no empty strip
    $("usClear").hidden = !h;
    const n = hits.length + runs.length;
    $("usBtn").classList.toggle("has", n > 0);
    $("usCount").textContent = n ? String(n) : "";
  }

  function statusText() {
    const f = $("findStatus"), r = $("redactStatus");
    const ft = f && !f.hidden ? f.textContent : "", rt = r && !r.hidden ? r.textContent : "";
    return U.mode === "redact" ? rt || ft : ft || rt;
  }
  function refresh() {
    if (!U.ok && !$("usPanel")) return;
    const s = $("usStatus");
    s.textContent = statusText();
    s.hidden = !s.textContent;
    const running = (T.search && T.search.running) || (T.redact && T.redact.running);
    $("usStop").hidden = !running;
    $("usFind").disabled = !!(T.search && T.search.running);
    $("usRedact").disabled = !!(T.redact && T.redact.running);
    $("usBtn").classList.toggle("busy", !!running);
    const S = T.search, has = !!(S && S.hasBest && S.hasBest());
    $("usBestWrap").hidden = !has;
    $("usBest").checked = !!(S && S.bestOnly && S.bestOnly());
    $("usBestN").textContent = has && S.allHits ? "(" + S.allHits.filter((h) => h.best).length + " of " + S.allHits.length + ")" : "";
    results();
  }
  U.refresh = refresh;

  /* ---------- jump + highlight ---------- */
  function clearHighlight() { document.querySelectorAll(".us-hl").forEach((n) => n.remove()); clearTimeout(U._hlT); }
  function highlight(cam, boxes) {
    clearHighlight();
    const tile = T.player.tiles && T.player.tiles[cam];
    if (!tile) return 0;
    const video = tile.vids[T.player.active];
    const tw = tile.tile.clientWidth, th = tile.tile.clientHeight;
    const iw = (video && video.videoWidth) || 16, ih = (video && video.videoHeight) || 9;
    const s = Math.min(tw / iw, th / ih), w = iw * s, hh = ih * s, x0 = (tw - w) / 2, y0 = (th - hh) / 2;
    let n = 0;
    for (const b of boxes || []) {
      const d = el("div", { class: "us-hl" });
      d.style.cssText = "left:" + (x0 + b.x * w - 4) + "px;top:" + (y0 + b.y * hh - 4) + "px;width:" + (b.w * w + 8) + "px;height:" + (b.h * hh + 8) + "px";
      tile.tile.appendChild(d); n++;
    }
    U._hlT = setTimeout(clearHighlight, 4000);
    return n;
  }
  U.select = (kind, i) => {
    if (kind === "find") {
      const btn = document.querySelectorAll("#findHits .find-hit")[i];   // search.js openHit: seek, switch camera, gold box
      if (btn) btn.click();
      else if (T.search.hits[i]) { if (T.search.openHit) T.search.openHit(T.search.hits[i]); else T.player.seek(T.search.hits[i].t); }
    } else {
      const r = U.redactRuns()[i];
      if (!r) return;
      if (T.focus && T.focus.focus) T.focus.focus(r.cam);
      T.player.seek(r.t);
      U.lastHighlight = { cam: r.cam, t: r.t };
      requestAnimationFrame(() => setTimeout(() => { U.lastHighlight.n = highlight(r.cam, r.boxes); }, 120));
    }
    document.querySelectorAll("#usResults .us-item").forEach((b) => b.classList.toggle("picked", b.dataset.kind === kind && +b.dataset.i === i));
    if (U.narrow()) { const q = $("usQuery"); if (document.activeElement === q) q.blur(); }   // drop the keyboard so the video shows
  };

  /* ---------- build ---------- */
  function build() {
    if (!$("findQuery") || !$("redactQuery") || !$("btnFind") || !$("btnRedact")) throw new Error("classic search bars missing");
    if (typeof MutationObserver !== "function") throw new Error("MutationObserver unavailable");
    const svg = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>';
    const btn = el("button", { class: "chip us-btn", id: "usBtn", type: "button", "aria-label": "Search", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "usPanel", title: "Search: find a moment, or hide text, plates and faces (/ or Ctrl+K)" },
      svg + '<span class="us-lbl">Search</span><span class="us-count" id="usCount"></span>');
    const clock = $("clockLabel");
    clock.parentNode.insertBefore(btn, clock.nextSibling);
    built.push(btn);
    const rsvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M7 10h10M7 14.5h6" stroke-width="3"/></svg>';
    const rbtn = el("button", { class: "chip us-btn rd-btn", id: "rdBtn", type: "button", "aria-label": "Redact", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "usPanel", title: "Redact: hide plates, faces and text, or draw your own region" },
      rsvg + '<span class="us-lbl">Redact</span>');
    btn.parentNode.insertBefore(rbtn, btn.nextSibling);
    built.push(rbtn);
    // tap-redact: when the show chips scroll inside their strip (narrow window), fade the right edge so it is clear there is more
    const chips = $("chips");
    if (chips) {
      const more = () => chips.classList.toggle("more-r", chips.scrollWidth - chips.clientWidth - chips.scrollLeft > 2);
      chips.addEventListener("scroll", more, { passive: true });
      if (typeof ResizeObserver === "function") new ResizeObserver(more).observe(chips); else window.addEventListener("resize", more);
      more();
    }

    const presets = [...document.querySelectorAll(".redact-presets button")].map((b) => '<button type="button" class="us-chip' + (b.classList.contains("text-only") ? " text-only" : "") + '" data-q="' + esc(b.getAttribute("data-q")) + '">' + esc(b.textContent) + "</button>").join("");
    const p = el("div", { class: "us-panel", id: "usPanel", role: "dialog", "aria-label": "Search the video", hidden: "" },
      '<div class="us-grab" aria-hidden="true"></div>' +
      '<div class="us-head" id="usHead"><span class="us-grip" id="usGrip" role="button" tabindex="-1" aria-label="Move the window (arrow keys, Shift for bigger steps)" title="Drag to move · arrow keys move it">' +
      '<svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="3" cy="3" r="1.4"/><circle cx="7" cy="3" r="1.4"/><circle cx="3" cy="8" r="1.4"/><circle cx="7" cy="8" r="1.4"/><circle cx="3" cy="13" r="1.4"/><circle cx="7" cy="13" r="1.4"/></svg><span id="usHeadLbl" class="us-headlbl">Search</span></span>' +
      '<div class="us-tabs" id="usTabs" role="tablist" aria-label="Search or redact"><button type="button" role="tab" class="us-tab" id="usTabFind" aria-selected="true" aria-controls="usPanel">Find</button><button type="button" role="tab" class="us-tab" id="usTabRedact" aria-selected="false" aria-controls="usPanel" tabindex="-1">Redact</button></div>' +
      '<button type="button" class="btn icon sm us-more" id="usMore" aria-expanded="false" aria-haspopup="true" aria-label="More: regions file, classic search bars" title="More"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button>' +
      '<button type="button" class="btn icon sm us-float" id="usFloat" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true" class="i-float"><rect x="3" y="12" width="18" height="9" rx="2"/><rect x="7" y="3" width="12" height="7" rx="1.5"/></svg><svg viewBox="0 0 24 24" aria-hidden="true" class="i-dock"><rect x="3" y="3" width="18" height="11" rx="2"/><path d="M3 19h18"/></svg></button>' +
      '<button type="button" class="btn icon sm us-pin" id="usPin" aria-pressed="false" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 14v7"/></svg></button>' +
      '<button type="button" class="btn icon sm us-x" id="usClose" aria-label="Close search (Esc)" title="Close (Esc)"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>' +
      '<div class="us-row">' + svg + '<input id="usQuery" type="search" enterkeyhint="search" autocomplete="off" spellcheck="false" placeholder="A cyclist in the bike lane · text Oak Ave · 20:53:46 · 2:30" aria-label="Search"></div>' +
      '<div class="us-actions"><select id="usCam" class="select small" aria-label="Cameras"><option value="front">Front camera</option><option value="around">All cameras</option></select>' +
      '<button type="button" class="btn primary small us-t-find" id="usFind" title="Find the moment that matches the words (Enter)">Find moment</button>' +
      '<button type="button" class="btn small text-only us-t-redact" id="usRedact" title="Blur this text wherever it appears, on every camera (Shift+Enter)">Blur text</button>' +
      '<button type="button" class="btn ghost small" id="usStop" hidden>Stop</button></div>' +
      '<div class="us-style res-style us-t-find" role="group" aria-label="How matches look"><span class="res-style-lbl">Matches</span>' +
      '<button type="button" class="style-tgl" data-style="hl" id="usHl" aria-pressed="true"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1"/></svg>Highlight</button>' +
      '<button type="button" class="style-tgl" data-style="rd" id="usRd" aria-pressed="false"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1" class="fill"/></svg>Redact</button>' +
      '</div>' +
      '<div class="us-auto-h us-t-redact" id="usAutoH">Automatic: hide text, plates and faces</div>' +
      '<div class="us-presets us-t-redact">' + presets + "</div>" +
      '<div class="us-style res-style us-t-redact" id="usShowRow"><button type="button" class="style-tgl blur-shown" id="usRedactShow" aria-pressed="true" hidden title="Show or hide the blur from Blur text, Blur plates, Blur faces, Street signs and All text (the export follows)">Show blur</button></div>' +
      '<div class="q-chips us-t-find" id="usChips" hidden></div>' +
      '<div class="us-status" id="usStatus" hidden></div>' +
      '<label class="us-best us-t-find" id="usBestWrap" hidden title="Show only the best-matching plate or text (best text match × read confidence)"><input type="checkbox" id="usBest"> Best match only <span id="usBestN"></span></label>' +
      '<div class="us-results" id="usResults" role="listbox" aria-label="Results" hidden></div>' +
      '<div class="us-foot" id="usFoot"><label title="Show the original Find and Redact bars under the video"><input type="checkbox" id="usClassic"> Classic search bars</label><button type="button" class="btn ghost small" id="usClear" hidden>Clear results</button></div>');
    // dock: a strip in normal page flow between the video area and the transport (never over a camera)
    const dock = el("div", { class: "us-dock", id: "usDock", hidden: "" });
    const tp = $("transport");
    tp.parentNode.insertBefore(dock, tp);
    dock.appendChild(p);
    built.push(p, dock);
    wireDrag(p);

    // Settings drawer toggle
    const body = document.querySelector("#settings .drawer-body");
    if (body) {
      const sec = el("section", { id: "setSearchSec" }, '<h3>Search</h3><div class="row"><span>Classic search bars</span><input type="checkbox" id="setClassicSearch"></div><p class="hint">Shows the original Find and Redact bars under the video instead of the floating search.</p>');
      body.insertBefore(sec, body.lastElementChild);
      built.push(sec);
      $("setClassicSearch").addEventListener("change", (e) => U.setClassic(e.target.checked));
    }

    btn.addEventListener("click", () => U.toggleTab("find"));
    rbtn.addEventListener("click", () => U.toggleTab("redact"));
    $("usTabFind").addEventListener("click", () => setTab("find"));
    $("usTabRedact").addEventListener("click", () => setTab("redact"));
    $("usTabs").addEventListener("keydown", (e) => {   // tabs: Left / Right / Home / End move between them
      const k = e.key; if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(k)) return;
      e.preventDefault(); e.stopPropagation();
      const t = k === "ArrowLeft" || k === "Home" ? "find" : "redact"; setTab(t); const b = $(t === "find" ? "usTabFind" : "usTabRedact"); if (b) b.focus();
    });
    $("usClose").addEventListener("click", () => U.hide());
    $("usMore").addEventListener("click", () => { const on = !p.classList.contains("more-open"); U.closePops("usMore"); setPop("usMore", on); });
    document.addEventListener("click", (e) => {   // a click outside an open popover (and outside its button) folds it
      const t = e.target; if (!t || !t.closest || t.closest("#usMore, #crRegBtn, #crInfo, #crList, #crHint, #crFileRow, #usFoot")) return; U.closePops();
    });
    $("usFloat").addEventListener("click", () => U.setMode(W.mode === "float" ? "dock" : "float"));
    $("usPin").addEventListener("click", () => U.setPinned(!W.pinned));
    $("usFind").addEventListener("click", () => U.find());
    $("usRedact").addEventListener("click", () => U.redact());
    $("usStop").addEventListener("click", U.stop);
    $("usRedactShow").addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); if (T.redact && T.redact.setShown) T.redact.setShown(!T.redact.shown()); });
    $("usClear").addEventListener("click", U.clear);
    $("usClassic").addEventListener("change", (e) => U.setClassic(e.target.checked));
    $("usBest").addEventListener("change", (e) => { if (T.search.setBestOnly) T.search.setBestOnly(e.target.checked); refresh(); if (T.searchStrip && T.searchStrip.ok) T.searchStrip.update(); });
    $("usQuery").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? U.redact() : U.find(); }
      else if (e.key === "ArrowDown") { const f = $("usResults").querySelector(".us-item"); if (f) { e.preventDefault(); f.focus(); } }
    });
    p.querySelectorAll(".us-chip").forEach((c) => c.addEventListener("click", () => { $("usQuery").value = c.dataset.q; U.redact(c.dataset.q); }));
    $("usResults").addEventListener("click", (e) => { const b = e.target.closest(".us-item"); if (b) U.select(b.dataset.kind, +b.dataset.i); });
    $("usResults").addEventListener("keydown", (e) => {
      const items = [...$("usResults").querySelectorAll(".us-item")], i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown" && i >= 0) { e.preventDefault(); (items[i + 1] || items[i]).focus(); }
      else if (e.key === "ArrowUp" && i >= 0) { e.preventDefault(); (items[i - 1] || $("usQuery")).focus(); }
    });

    // shortcuts (capture phase, so Esc closes search before ui.js leaves focus/full screen)
    window.addEventListener("keydown", (e) => {
      const typing = e.target.matches && e.target.matches("input, textarea, select, [contenteditable]");
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "k" || e.key === "K")) { e.preventDefault(); e.stopImmediatePropagation(); U.open && U.tab === "find" && document.activeElement === $("usQuery") ? U.hide() : U.show(true, "find"); }
      else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopImmediatePropagation(); U.show(true, "find"); }
      else if (e.key === "Escape" && U.open) { e.preventDefault(); e.stopImmediatePropagation(); if (!U.closePops()) U.hide(); }   // Esc folds an open popover first
    }, true);
    // (no tap-outside close: docked and floating panels stay until closed with × / Esc / the Search button)

    const v = vv();
    if (v) { v.addEventListener("resize", placeSheet); v.addEventListener("scroll", placeSheet); }
    $("usQuery").addEventListener("focus", () => setTimeout(placeSheet, 300));   // iOS reports the keyboard late
    window.addEventListener("resize", () => { placeSheet(); placeFloat(); });
    $("usQuery").addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== $("usQuery")) typing(false); }, 150));

    const mo = new MutationObserver(() => refresh());
    for (const id of ["findHits", "findStatus", "redactStatus", "btnFindStop", "btnRedactStop", "btnRedactClear", "btnFindClear"]) if ($(id)) mo.observe($(id), { childList: true, characterData: true, subtree: true, attributes: true });
    if (T.on) T.on("player-open", () => { clearHighlight(); setTimeout(refresh, 0); });
    U._mo = mo;
  }

  U.init = () => {
    try {
      if (window.__TDC_SEARCHUI_FAIL) throw new Error("forced failure (test)");
      build();
      U.ok = true;
      U.setClassic(U.classic());
      if (T.search && T.search.syncStyle) T.search.syncStyle();
      document.body.classList.add("usearch");
      setTab(U.tab, { remember: false });
      applyMode();
      placeSheet();
      refresh();
    } catch (err) {
      // fallback: remove anything half-built; the classic Find and Redact bars stay as they were
      U.ok = false; U.error = String((err && err.message) || err);
      console.warn("[search-ui] falling back to the classic search bars:", err);
      built.forEach((n) => n.remove()); built = [];
      document.body.classList.remove("usearch");
    }
    return U.ok;
  };
})();
