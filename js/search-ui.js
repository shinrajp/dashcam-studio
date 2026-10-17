/* search-ui.js — Phase 4: one floating search for both Find (object/scene) and Redact (text/plates/faces).
 * It drives the classic Find and Redact bars underneath (same inputs, same buttons), so search.js and
 * redact.js are unchanged. Collapsed to an icon by default; expands on tap, "/" or Cmd/Ctrl+K; Esc closes.
 * On phones it is a bottom sheet pinned above the on-screen keyboard with visualViewport (position: fixed,
 * the video grid is never resized). If anything here fails, body never gets the "usearch" class, so the
 * classic bars stay visible. Settings → "Classic search bars" (or ?search=classic) also shows them. */
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
  }
  function setOverlaysContent(on) {   // Android Chrome: keyboard overlays the page instead of resizing it
    const m = document.querySelector('meta[name="viewport"]');
    if (!m) return;
    if (on && !m.dataset.usOrig) { m.dataset.usOrig = m.content; if (!/interactive-widget/.test(m.content)) m.content += ", interactive-widget=overlays-content"; }
    else if (!on && m.dataset.usOrig) { m.content = m.dataset.usOrig; delete m.dataset.usOrig; }
  }

  U.show = (focus) => {
    const p = $("usPanel");
    if (!p) return;
    U.open = true;
    p.hidden = false;
    const sheet = U.narrow();
    p.classList.toggle("sheet", sheet);
    document.body.classList.add("us-open");
    $("usBtn").setAttribute("aria-expanded", "true");
    if (sheet) setOverlaysContent(true);
    placeSheet();
    refresh();
    if (focus !== false) { const q = $("usQuery"); try { q.focus({ preventScroll: true }); } catch (e) { q.focus(); } }
  };
  U.hide = () => {
    const p = $("usPanel");
    if (!p) return;
    U.open = false;
    p.hidden = true;
    document.body.classList.remove("us-open");
    $("usBtn").setAttribute("aria-expanded", "false");
    if (document.activeElement && p.contains(document.activeElement)) document.activeElement.blur();
    setOverlaysContent(false);
  };
  U.toggle = () => (U.open ? U.hide() : U.show());

  /* ---------- actions: drive the classic bars ---------- */
  function syncCam() { const v = $("usCam").value; if ($("findCam")) $("findCam").value = v; if ($("redactCam")) $("redactCam").value = v; }
  U.find = (q) => {
    q = (q != null ? q : $("usQuery").value).trim();
    if (!q) { $("usQuery").focus(); return; }
    syncCam(); $("findQuery").value = q; U.mode = "find"; $("btnFind").click(); refresh();
  };
  U.redact = (q) => {
    q = (q != null ? q : $("usQuery").value).trim();
    if (!q) { $("usQuery").focus(); return; }
    syncCam(); $("redactQuery").value = q; U.mode = "redact"; $("btnRedact").click(); refresh();
  };
  U.stop = () => { const a = $("btnFindStop"), b = $("btnRedactStop"); if (a && !a.hidden) a.click(); if (b && !b.hidden) b.click(); };
  U.clear = () => { if (T.search) T.search.clear(); if (T.redact) T.redact.clear(); clearHighlight(); refresh(); };

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
      h += '<div class="us-group">Find matches <span>' + hits.length + "</span></div>";
      hits.forEach((x, i) => {
        h += '<button type="button" class="us-item" role="option" data-kind="find" data-i="' + i + '"><span class="us-t">' + esc(fmt(x.t)) + "</span><span>" + esc(CAM[x.cam] || x.cam) + (x.text ? " · " + esc(x.text) : "") + (x.weak ? ' <em>weak</em>' : "") + "</span></button>";
      });
    }
    if (runs.length) {
      h += '<div class="us-group">' + (T.redact.action === "remove" ? "Removed" : "Blurred") + " text / regions <span>" + runs.length + "</span></div>";
      runs.forEach((r, i) => {
        h += '<button type="button" class="us-item" role="option" data-kind="redact" data-i="' + i + '"><span class="us-t">' + esc(fmt(r.t)) + "</span><span>" + esc(CAM[r.cam] || r.cam) + " · " + r.spots + " spot" + (r.spots === 1 ? "" : "s") + (r.end > r.t ? " · to " + esc(fmt(r.end)) : "") + "</span></button>";
      });
    }
    box.innerHTML = h;
    box.hidden = !h;
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
      else if (T.search.hits[i]) T.player.seek(T.search.hits[i].t);
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
    const btn = el("button", { class: "chip us-btn", id: "usBtn", type: "button", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "usPanel", title: "Search: find a moment, or hide text, plates and faces (/ or Ctrl+K)" },
      svg + '<span class="us-lbl">Search</span><span class="us-count" id="usCount"></span>');
    const clock = $("clockLabel");
    clock.parentNode.insertBefore(btn, clock.nextSibling);
    built.push(btn);

    const presets = [...document.querySelectorAll(".redact-presets button")].map((b) => '<button type="button" class="us-chip" data-q="' + esc(b.getAttribute("data-q")) + '">' + esc(b.textContent) + "</button>").join("");
    const p = el("div", { class: "us-panel", id: "usPanel", role: "dialog", "aria-label": "Search the video", hidden: "" },
      '<div class="us-grab" aria-hidden="true"></div>' +
      '<div class="us-row">' + svg + '<input id="usQuery" type="search" enterkeyhint="search" autocomplete="off" spellcheck="false" placeholder="A cyclist in the bike lane · or text to hide: Oak Ave" aria-label="Search">' +
      '<button type="button" class="btn icon us-x" id="usClose" aria-label="Close search (Esc)" title="Close (Esc)"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>' +
      '<div class="us-actions"><select id="usCam" class="select small" aria-label="Cameras"><option value="front">Front camera</option><option value="around">All cameras</option></select>' +
      '<button type="button" class="btn primary small" id="usFind" title="Find the moment that matches the words (Enter)">Find moment</button>' +
      '<button type="button" class="btn small" id="usRedact" title="Blur this text wherever it appears (Shift+Enter)">Blur text</button>' +
      '<button type="button" class="btn ghost small" id="usStop" hidden>Stop</button></div>' +
      '<div class="us-presets">' + presets + "</div>" +
      '<div class="us-status" id="usStatus" hidden></div>' +
      '<div class="us-results" id="usResults" role="listbox" aria-label="Results" hidden></div>' +
      '<div class="us-foot"><label title="Show the original Find and Redact bars under the video"><input type="checkbox" id="usClassic"> Classic search bars</label><button type="button" class="btn ghost small" id="usClear" hidden>Clear results</button></div>');
    document.body.appendChild(p);
    built.push(p);

    // Settings drawer toggle
    const body = document.querySelector("#settings .drawer-body");
    if (body) {
      const sec = el("section", { id: "setSearchSec" }, '<h3>Search</h3><div class="row"><span>Classic search bars</span><input type="checkbox" id="setClassicSearch"></div><p class="hint">Shows the original Find and Redact bars under the video instead of the floating search.</p>');
      body.insertBefore(sec, body.lastElementChild);
      built.push(sec);
      $("setClassicSearch").addEventListener("change", (e) => U.setClassic(e.target.checked));
    }

    btn.addEventListener("click", () => U.toggle());
    $("usClose").addEventListener("click", () => U.hide());
    $("usFind").addEventListener("click", () => U.find());
    $("usRedact").addEventListener("click", () => U.redact());
    $("usStop").addEventListener("click", U.stop);
    $("usClear").addEventListener("click", U.clear);
    $("usClassic").addEventListener("change", (e) => U.setClassic(e.target.checked));
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
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "k" || e.key === "K")) { e.preventDefault(); e.stopImmediatePropagation(); U.open && document.activeElement === $("usQuery") ? U.hide() : U.show(); }
      else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopImmediatePropagation(); U.show(); }
      else if (e.key === "Escape" && U.open) { e.preventDefault(); e.stopImmediatePropagation(); U.hide(); }
    }, true);
    // tap outside closes on desktop (not while a sheet is pinned above the keyboard)
    document.addEventListener("pointerdown", (e) => {
      if (!U.open || p.classList.contains("sheet")) return;
      if (p.contains(e.target) || btn.contains(e.target) || (e.target.closest && e.target.closest(".modal, .drawer"))) return;
      U.hide();
    }, true);

    const v = vv();
    if (v) { v.addEventListener("resize", placeSheet); v.addEventListener("scroll", placeSheet); }
    $("usQuery").addEventListener("focus", () => setTimeout(placeSheet, 300));   // iOS reports the keyboard late
    window.addEventListener("resize", () => { placeSheet(); if (U.open) p.classList.toggle("sheet", U.narrow()); });

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
      document.body.classList.add("usearch");
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
