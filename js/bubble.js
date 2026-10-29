/* bubble.js — ui-glass-6: the tools bubble (css/bubble.css).
 *  - One round glass bubble (#toolBubble, main button #tbMain) at the bottom right holds Redact (#rdBtn), Search (#usBtn), Events and Settings.
 *    A tap fans them out along a short arc (labels outside the arc), the + turns into ×, the corner dims. Export stays in the top bar.
 *  - Folds back on a second tap, Esc, a tap anywhere else (that tap only folds it), or after an item is used. Keyboard: Enter / Space opens and
 *    moves focus to the first item; arrow keys, Home and End move between items; Esc closes and returns focus to the bubble. aria-expanded on #tbMain.
 *  - Drag it (6 px threshold, no pointer capture on pointerdown, a real click handler so mouse / trackpad clicks work in Mac Safari): it snaps to
 *    the nearest corner of the free area (under the top bar, above the bottom controls) and prefs.bubble.corner remembers it.
 *  - Events opens #library as a slide-in glass sheet from the left (on every window size; the permanent desktop sidebar is gone, the video gets the width).
 *  - #usBtn / #rdBtn are the same buttons as before (same ids, handlers, aria-expanded and shortcuts), now living in the fan.
 *  - The bubble steps away while Settings, the Events sheet, the draw bar / camera pick, the phone sheet or (on phones) the Search / Redact panel is open.
 *    Auto-hide: never hides while the fan or the sheet is open; when the controls hide it shrinks to a faint dot. Reduced motion: no springs.
 *  If anything here fails, the buttons stay where they were (nothing is moved before the bubble exists). */
(function () {
  "use strict";
  const T = window.TDC; if (!T) return;
  const $ = (id) => document.getElementById(id), body = () => document.body;
  const B = (T.bubble = { on: false, open: false, sheet: false, corner: "br", away: false });
  const CORNERS = ["tl", "tr", "bl", "br"], M = 12, S = 52, DRAG = 6, R = 124;
  const SVG = {
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    events: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M8 3v3M16 3v3M7.5 13.5h3M7.5 16.5h6"/></svg>',
    settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };
  let root, main, fan, dim, badge, evBtn, setBtn, swallow = 0, suppress = false, drag = null, retFocus = false;

  function el(tag, attrs, html) { const n = document.createElement(tag); for (const k in attrs || {}) n.setAttribute(k, attrs[k]); if (html) n.innerHTML = html; return n; }
  const shown = (e) => !!(e && !e.hidden && e.getClientRects().length && getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden");
  const items = () => (fan ? [...fan.querySelectorAll(".tb-item")].filter((b) => !b.hidden) : []);
  const vw = () => document.documentElement.clientWidth || innerWidth, vh = () => innerHeight;
  const px = (v) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(v)) || 0;
  B.cornerPref = () => { const c = T.prefs.bubble && T.prefs.bubble.corner; return CORNERS.includes(c) ? c : "br"; };

  /** the free area: under the top bar, above the bottom controls, inside the safe area */
  B.area = () => {
    const W = vw(), H = vh(); let top = px("--sa-t"), floor = H - px("--sa-b");
    const tb = document.querySelector(".topbar"); if (shown(tb)) top = Math.max(top, tb.getBoundingClientRect().bottom);
    const ids = body().classList.contains("mbar") && shown($("mbBar")) ? ["mbBar"] : ["mbBar", "transport"];   // phone: the slim bar, not the pull-up sheet
    for (const id of ids) { const e = $(id); if (!shown(e)) continue; const r = e.getBoundingClientRect(); if (r.height > 1 && r.top > H * 0.4 && r.top < floor) floor = r.top; }
    return { l: px("--sa-l") + M, r: W - px("--sa-r") - M, t: top + M, b: floor - M };
  };
  function xyFor(c) { const a = B.area(); return { x: c[1] === "l" ? a.l : a.r - S, y: c[0] === "t" ? a.t : a.b - S }; }

  /** puts the bubble in its corner and lays out the fan (vectors and label sides) */
  B.place = () => {
    if (!root || drag) return;
    const c = B.corner = B.cornerPref(), p = xyFor(c);
    root.style.left = Math.round(p.x) + "px"; root.style.top = Math.round(p.y) + "px"; root.dataset.corner = c;
    const sx = c[1] === "l" ? 1 : -1, sy = c[0] === "t" ? 1 : -1, list = items(), n = list.length;
    list.forEach((b, i) => {   // item 0 straight up (or down), the last one straight sideways
      const a = (n > 1 ? (90 - (90 * i) / (n - 1)) : 90) * Math.PI / 180;
      const dx = sx * R * Math.cos(a), dy = sy * R * Math.sin(a);
      b.style.setProperty("--x", dx.toFixed(1) + "px"); b.style.setProperty("--y", dy.toFixed(1) + "px"); b.style.setProperty("--i", String(i));
      b.dataset.lbl = Math.sin(a) > 0.75 ? (sy < 0 ? "t" : "b") : (sx < 0 ? "l" : "r");
    });
    if (dim) { dim.style.setProperty("--cx", (p.x + S / 2) + "px"); dim.style.setProperty("--cy", (p.y + S / 2) + "px"); }
  };

  /* ---------- fan ---------- */
  B.toggle = (on, opts) => {
    on = on === undefined ? !B.open : !!on; opts = opts || {};
    if (on && (B.away || !B.on)) return;
    if (on === B.open) return;
    B.open = on;
    if (on) B.place();
    root.classList.toggle("open", on); body().classList.toggle("tb-fan-open", on);
    main.setAttribute("aria-expanded", String(on)); main.setAttribute("aria-label", on ? "Close tools" : "Tools");
    if (on) { if (opts.focus !== false) { const f = items()[0]; if (f) f.focus({ preventScroll: true }); } }
    else if (opts.focus && root.contains(document.activeElement) && document.activeElement !== main) main.focus({ preventScroll: true });
    if (T.glass && T.glass.budgetSoon) T.glass.budgetSoon();
    if (T.autohide) T.autohide.wake();
  };
  B.close = (focus) => B.toggle(false, { focus });

  /* ---------- Events sheet ---------- */
  B.events = (on, opts) => {
    const lib = $("library"); opts = opts || {};
    on = on === undefined ? !B.sheet : !!on;
    if (on && (!lib || lib.hidden)) on = false;
    B.sheet = on; body().classList.toggle("lib-open", on);
    if (evBtn) evBtn.setAttribute("aria-expanded", String(on));
    if (lib) { if (on) lib.removeAttribute("aria-hidden"); else lib.setAttribute("aria-hidden", "true"); lib.inert = !on && body().classList.contains("tb-on"); }
    if (on && opts.focus !== false) {
      const t = lib.querySelector("#libList .ev.active, #libList .ev, #libList [tabindex='0'], #libList button"); retFocus = true;
      setTimeout(() => { try { (t || $("libClose")).focus({ preventScroll: true }); } catch (_) {} }, 60);
    }
    if (!on && opts.focus) refocus();
    sync();
  };
  function refocus() { requestAnimationFrame(() => { const a = document.activeElement; if (!a || a === document.body || !shown(a)) { if (!B.away) main.focus({ preventScroll: true }); else retFocus = true; } }); }

  /* ---------- away / visibility ---------- */
  function sync() {
    if (!root) return;
    const b = body(), tp = $("transport"), set = $("settings"), lib = $("library");
    const narrow = b.classList.contains("mbar") || (T.searchUI && T.searchUI.narrow && T.searchUI.narrow());
    const drawing = b.classList.contains("cr-bar-on") || b.classList.contains("cr-drawing");   // desktop keeps the bubble (Redact reopens the panel mid-drawing, as before) unless the draw bar covers its corner
    const away = b.classList.contains("no-event") || b.classList.contains("cr-picking") || (drawing && (narrow || over($("crBar")))) ||
      !!(set && !set.hidden) || B.sheet || !!(tp && tp.classList.contains("mb-open")) || (narrow && (b.classList.contains("us-open") || b.classList.contains("us-docked"))) || panelOver();
    if (evBtn) evBtn.hidden = !lib || lib.hidden;
    if (B.sheet && lib && lib.hidden) B.events(false);
    if (!away && !drag) B.place();
    if (away !== B.away) {
      B.away = away; b.classList.toggle("tb-away", away);
      if (away && B.open) B.close(false);
      if (!away) { if (retFocus) { retFocus = false; const a = document.activeElement; if (!a || a === document.body || !shown(a)) main.focus({ preventScroll: true }); } }
    }
  }
  B.sync = sync;   // (sync also re-places the bubble: bars can move without resizing, e.g. the phone's slim mode)
  /** a floating Search / Redact panel that covers the bubble's corner sends it away (desktop: the panel can sit at the bottom right) */
  function panelOver() { const up = $("usPanel"); return !!up && body().classList.contains("us-open") && over(up); }
  function over(el) {
    if (!root || !el || !shown(el)) return false;
    const a = el.getBoundingClientRect(), p = xyFor(B.cornerPref()), m = 4;
    return a.left < p.x + S + m && a.right > p.x - m && a.top < p.y + S + m && a.bottom > p.y - m;
  }
  function mirrorCount() { const c = $("usCount"); if (badge) badge.textContent = c ? c.textContent : ""; }

  /* ---------- after an item is used ---------- */
  function used(e) {
    if (!B.open) return;
    B.toggle(false, { focus: false });
    retFocus = true;
    requestAnimationFrame(() => requestAnimationFrame(() => { const a = document.activeElement; if (!a || a === document.body || (root.contains(a) && a !== main)) { if (!B.away) { retFocus = false; main.focus({ preventScroll: true }); } } else retFocus = false; sync(); }));
  }

  /* ---------- drag to a corner ---------- */
  function onDown(e) {
    if (e.button > 0 || !e.isPrimary) return;
    const r = root.getBoundingClientRect();
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, l: r.left, t: r.top, moved: false };
    suppress = false;
    addEventListener("pointermove", onMove, { passive: false }); addEventListener("pointerup", onUp); addEventListener("pointercancel", onUp);
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.moved) { if (Math.hypot(dx, dy) < DRAG) return; drag.moved = true; if (B.open) B.close(false); root.classList.add("dragging"); root.classList.remove("snap"); }
    if (e.cancelable) e.preventDefault();
    const x = Math.max(0, Math.min(vw() - S, drag.l + dx)), y = Math.max(0, Math.min(vh() - S, drag.t + dy));
    root.style.left = x + "px"; root.style.top = y + "px";
  }
  function onUp(e) {
    if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.id)) return;
    removeEventListener("pointermove", onMove); removeEventListener("pointerup", onUp); removeEventListener("pointercancel", onUp);
    const d = drag; drag = null;
    if (!d.moved) return;
    suppress = true; setTimeout(() => { suppress = false; }, 450);
    root.classList.remove("dragging");
    const r = root.getBoundingClientRect(), a = B.area(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const c = (cy < (a.t + a.b) / 2 ? "t" : "b") + (cx < (a.l + a.r) / 2 ? "l" : "r");
    root.classList.add("snap");
    if (!T.prefs.bubble || typeof T.prefs.bubble !== "object") T.prefs.bubble = { corner: "br" };
    T.setPref("bubble.corner", c);
    B.place();
    setTimeout(() => root.classList.remove("snap"), 400);
  }

  /* ---------- build ---------- */
  B.init = () => {
    if (B.on || !document.body || $("toolBubble")) return B.on;
    try {
      root = el("div", { class: "tool-bubble", id: "toolBubble" });
      main = el("button", { type: "button", class: "tb-main", id: "tbMain", "aria-expanded": "false", "aria-controls": "tbFan", "aria-label": "Tools", title: "Tools: Redact, Search, Events, Settings (drag to move it to another corner)" }, SVG.plus);
      badge = el("span", { class: "tb-badge", id: "tbBadge", "aria-hidden": "true" }); main.appendChild(badge);
      fan = el("div", { class: "tb-fan", id: "tbFan", role: "group", "aria-label": "Tools" });
      evBtn = el("button", { type: "button", class: "chip us-btn tb-item", id: "tbEvents", "aria-label": "Events", "aria-expanded": "false", "aria-controls": "library", title: "Events: every loaded clip" }, SVG.events + '<span class="us-lbl">Events</span>');
      setBtn = el("button", { type: "button", class: "chip us-btn tb-item", id: "tbSettings", "aria-label": "Settings", "aria-expanded": "false", "aria-controls": "settings", title: "Settings" }, SVG.settings + '<span class="us-lbl">Settings</span>');
      const rd = $("rdBtn"), us = $("usBtn");
      for (const b of [rd, us]) if (b) { b.classList.add("tb-item"); fan.appendChild(b); }
      fan.append(evBtn, setBtn);
      root.append(fan, main);
      dim = el("div", { class: "tb-dim", id: "tbDim", "aria-hidden": "true" });
      document.body.append(dim, root);
      const head = document.querySelector("#library .lib-head");
      if (head && !$("libClose")) head.appendChild(el("button", { type: "button", class: "btn icon sm lib-x", id: "libClose", "aria-label": "Close events", title: "Close (Esc)" }, SVG.close));
      const lib = $("library"); if (lib) { lib.setAttribute("role", "dialog"); lib.setAttribute("aria-label", "Events"); }
      body().classList.add("tb-on");
      B.on = true;
    } catch (err) { console.warn("[bubble] not built", err); B.error = String(err && err.message || err); return false; }

    main.addEventListener("pointerdown", onDown);
    main.addEventListener("click", (e) => { if (suppress) { suppress = false; e.preventDefault(); return; } B.toggle(undefined, { focus: true }); });
    evBtn.addEventListener("click", () => { used(); B.events(true); });
    setBtn.addEventListener("click", () => {
      used(); const s = $("settings"), was = s && !s.hidden;
      const sb = $("btnSettings"); if (sb) sb.click(); else if (s) s.hidden = !s.hidden;
      if (!was && s && !s.hidden) { retFocus = true; setTimeout(() => { const c = $("btnCloseSettings"); if (c) c.focus({ preventScroll: true }); }, 60); }
    });
    for (const id of ["rdBtn", "usBtn"]) { const b = $(id); if (b) b.addEventListener("click", used); }
    const lc = $("libClose"); if (lc) lc.addEventListener("click", () => B.events(false, { focus: true }));
    const ll = $("libList"), picked = (e) => e.target.closest && e.target.closest(".ev");
    if (ll) { ll.addEventListener("click", (e) => { if (picked(e)) setTimeout(() => B.events(false, { focus: true }), 0); });
      ll.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && picked(e)) setTimeout(() => B.events(false, { focus: true }), 0); }); }
    const xa = $("btnExportAll"); if (xa) xa.addEventListener("click", () => B.events(false));

    // keyboard inside the fan
    fan.addEventListener("keydown", (e) => {
      const list = items(), i = list.indexOf(document.activeElement); if (i < 0) return;
      let j = -1;
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") j = (i - 1 + list.length) % list.length;
      else if (e.key === "ArrowDown" || e.key === "ArrowRight") j = (i + 1) % list.length;
      else if (e.key === "Home") j = 0; else if (e.key === "End") j = list.length - 1;
      if (j >= 0) { e.preventDefault(); e.stopPropagation(); list[j].focus(); }
    });
    root.addEventListener("focusout", (e) => { if (B.open && e.relatedTarget && !root.contains(e.relatedTarget)) B.close(false); });
    // Esc: the fan first, then the Events sheet (before the app's own Esc handling)
    addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (B.open) { e.preventDefault(); e.stopImmediatePropagation(); B.close(true); }
      else if (B.sheet) { e.preventDefault(); e.stopImmediatePropagation(); B.events(false, { focus: true }); }
    }, true);
    // a tap anywhere else folds the fan (and closes the sheet); that tap does nothing else
    document.addEventListener("pointerdown", (e) => {
      const t = e.target;
      if (B.open && !root.contains(t)) { B.close(false); swallow = performance.now(); }
      else if (B.sheet && !$("library").contains(t) && !root.contains(t)) { B.events(false); swallow = performance.now(); }
    }, true);
    document.addEventListener("click", (e) => {
      if (!swallow) return; const age = performance.now() - swallow; swallow = 0;
      if (age < 800 && !root.contains(e.target)) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    // stay in the corner when things move
    addEventListener("resize", () => { B.place(); sync(); });
    if (window.visualViewport) { visualViewport.addEventListener("resize", () => B.place()); visualViewport.addEventListener("scroll", () => B.place()); }
    addEventListener("scroll", () => B.place(), { passive: true });   // bars measured in the viewport move if the page ever scrolls
    if (typeof ResizeObserver === "function") { const ro = new ResizeObserver(() => B.place()); for (const n of [$("transport"), $("mbBar"), document.querySelector(".topbar")]) if (n) ro.observe(n); }
    if (typeof MutationObserver === "function") {
      let crSeen = null;   // the draw bar is made on first use and can be dragged: watch it once it exists
      const mo = new MutationObserver(() => { const cb = $("crBar"); if (cb && cb !== crSeen) { crSeen = cb; mo.observe(cb, { attributes: true, attributeFilter: ["hidden", "style", "class"] }); } sync(); });
      mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
      for (const n of [$("settings"), $("transport"), $("library")]) if (n) mo.observe(n, { attributes: true, attributeFilter: ["hidden", "class"] });
      const up = $("usPanel"); if (up) mo.observe(up, { attributes: true, attributeFilter: ["hidden", "class", "style"] });
      const c = $("usCount"); if (c) new MutationObserver(mirrorCount).observe(c, { childList: true, characterData: true, subtree: true });
      const s = $("settings"); if (s) new MutationObserver(() => setBtn.setAttribute("aria-expanded", String(!s.hidden))).observe(s, { attributes: true, attributeFilter: ["hidden"] });
    }
    if (T.on) T.on("prefs", (k) => { if (k === "bubble" || k === "bubble.corner" || k === "*") B.place(); });
    B.events(false, { focus: false });
    sync(); mirrorCount(); B.place();
    requestAnimationFrame(() => { B.place(); dispatchEvent(new Event("resize")); });   // the sidebar left the layout: let the grid take the width
    return true;
  };
})();
