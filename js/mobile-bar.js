/* mobile-bar.js — phones: a slim playback bar (play / pause, the time, the timeline) and a pull-up sheet with every
 * other transport control (stop, frame steps, speed, camera bar, full screen, sections / trim, the chips).
 * On iPhone the full transport took about a third of the portrait screen (tag mobile-bar). The DOM nodes are moved,
 * not copied, so every existing handler, shortcut and test id keeps working; leaving the phone layout (rotate to a
 * wide window) puts them back exactly where they were. Desktop and tablets never see any of this.
 *  - the slim bar is in normal page flow (the camera grid gets the freed height); the sheet overlays the cameras
 *  - handle: the grip strip on top of the bar and the ⌃ button — tap to toggle, drag up / down; touch-action: none
 *    there only, so the timeline scrub and the page are untouched (no edge swipe: the home indicator stays free)
 *  - tap the cameras / top bar to close; Esc closes; animation is transform-only, off with prefers-reduced-motion
 *  - starts collapsed; the open / closed state is remembered (localStorage tdc.mbarOpen)
 *  - sections: the timeline (with the sections lane and its hint) moves into the open sheet; adding a section opens
 *    the sheet at the trim row; the handle shows how many sections there are */
(function () {
  "use strict";
  const T = (window.TDC = window.TDC || {});
  const $ = (id) => document.getElementById(id);
  const MQ = "(max-width: 760px), (max-height: 500px) and (orientation: landscape) and (pointer: coarse)";
  const KEY = "tdc.mbarOpen";
  const M = (T.mobileBar = { on: false, open: false });
  let tp, bar, grip, more, row, sheet, badge, mq, swallowClick = false, drag = null, suppressClick = false, lastEvOpen = 0, segN = 0;
  const homes = new Map();   // node → placeholder comment (where it lives on desktop)
  const store = (v) => { try { localStorage.setItem(KEY, v ? "1" : "0"); } catch (_) {} };
  const stored = () => { try { return localStorage.getItem(KEY) === "1"; } catch (_) { return false; } };
  const el = (tag, attrs, html) => { const e = document.createElement(tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (html) e.innerHTML = html; return e; };
  function park(node) { if (!node || homes.has(node)) return; const c = document.createComment("mb:" + (node.id || "")); node.parentNode.insertBefore(c, node); homes.set(node, c); }
  function unpark(node) { const c = homes.get(node); if (!c) return; c.parentNode.insertBefore(node, c); c.remove(); homes.delete(node); }
  const redraw = () => { try { T.ui && T.ui.drawTimeline && T.ui.drawTimeline(); } catch (_) {} };

  /** The timeline sits in the slim bar when the sheet is closed, and in the sheet (taller, with the sections lane)
   *  when it is open. */
  function placeTimeline(inSheet) {
    const tl = $("timeline"); if (!tl) return;
    if (inSheet) { const c = homes.get(tl); if (c && tl.parentNode !== c.parentNode) c.parentNode.insertBefore(tl, c); }
    else if (tl.parentNode !== row) row.insertBefore(tl, more);
    document.body.classList.toggle("mb-slim", !inSheet);
    requestAnimationFrame(redraw);
  }
  function setOpen(v, opt) {
    if (!M.on) return;
    v = !!v; M.open = v;
    if (v) placeTimeline(true);
    tp.classList.toggle("mb-open", v);
    sheet.setAttribute("aria-hidden", v ? "false" : "true");
    if ("inert" in sheet) sheet.inert = !v;
    for (const b of [grip, more]) { b.setAttribute("aria-expanded", String(v)); b.setAttribute("aria-label", v ? "Fewer controls" : "More controls"); }
    if (!v) placeTimeline(false);
    if (!opt || opt.remember !== false) store(v);
    if (v && opt && opt.to) { const t = $(opt.to); if (t && t.offsetParent) t.scrollIntoView({ block: "nearest" }); }
  }
  M.setOpen = (v) => setOpen(v);
  M.toggle = () => setOpen(!M.open);

  function enter() {
    if (M.on) return;
    tp = $("transport"); if (!tp) return;
    M.on = true; document.body.classList.add("mbar");
    sheet = el("div", { class: "mb-sheet", id: "mbSheet", role: "region", "aria-label": "Playback controls", "aria-hidden": "true" });
    while (tp.firstChild) sheet.appendChild(tp.firstChild);   // every transport child, in order
    const gripSvg = '<span class="mb-grip-line" aria-hidden="true"></span>';
    grip = el("button", { type: "button", class: "mb-grip", id: "mbGrip", "aria-controls": "mbSheet", "aria-expanded": "false", "aria-label": "More controls", title: "More controls (drag up)" }, gripSvg);
    more = el("button", { type: "button", class: "btn icon mb-more", id: "mbMore", "aria-controls": "mbSheet", "aria-expanded": "false", "aria-label": "More controls", title: "More controls" },
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg><span class="mb-badge" id="mbBadge" hidden></span>');
    badge = more.querySelector(".mb-badge");
    row = el("div", { class: "mb-row", id: "mbRow" });
    bar = el("div", { class: "mb-bar", id: "mbBar" });
    bar.append(grip, row);
    tp.append(sheet, bar);   // (in the document first: getElementById below)
    for (const id of ["btnPlay", "timeLabel", "timeline"]) { const n = $(id); if (n) { park(n); row.appendChild(n); } }
    row.appendChild(more);
    usBtnOut();
    for (const b of [grip, more]) wireHandle(b);
    setOpen(stored(), { remember: false });
    sizeBar();
  }
  function leave() {
    if (!M.on) return;
    M.on = false; M.open = false;
    tp.classList.remove("mb-open");
    for (const n of [...homes.keys()]) unpark(n);
    while (sheet.firstChild) tp.insertBefore(sheet.firstChild, sheet);
    usBtnIn();
    sheet.remove(); bar.remove();
    document.body.classList.remove("mbar", "mb-slim");
    requestAnimationFrame(redraw);
  }
  // the floating search button (js/search-ui.js puts it in the controls row and floats it on phones): out of the
  // transformed sheet, so position: fixed stays relative to the screen
  function usBtnOut() { const b = $("usBtn"); if (b && sheet && sheet.contains(b)) { park(b); tp.insertBefore(b, bar); } }
  function usBtnIn() { const b = $("usBtn"); if (b) unpark(b); }
  function sizeBar() { if (M.on) document.documentElement.style.setProperty("--mb-bar", bar.offsetHeight + "px"); }

  function wireHandle(h) {
    h.addEventListener("click", (e) => { if (suppressClick) { suppressClick = false; return; } e.preventDefault(); M.toggle(); });
    h.addEventListener("pointerdown", (e) => {
      if (e.button > 0 || !M.on) return;
      suppressClick = false;   // a new touch: its own click counts (only the click that ends a drag is dropped)
      drag = { id: e.pointerId, y0: e.clientY, last: [[e.timeStamp, e.clientY]], moved: false, h, wasOpen: M.open };
      try { h.setPointerCapture(e.pointerId); } catch (_) {}
    });
    h.addEventListener("pointermove", (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      const dy = e.clientY - drag.y0;
      if (!drag.moved) {
        if (Math.abs(dy) < 8) return;
        drag.moved = true;
        if (!drag.wasOpen) placeTimeline(true);   // the sheet's final height before measuring it
        drag.full = sheet.offsetHeight + bar.offsetHeight;
        tp.classList.add("mb-drag");
      }
      const off = Math.max(0, Math.min(drag.full, (drag.wasOpen ? 0 : drag.full) + dy));
      drag.off = off;
      sheet.style.transform = "translateY(" + off + "px)";
      drag.last.push([e.timeStamp, e.clientY]); if (drag.last.length > 5) drag.last.shift();
      e.preventDefault();
    });
    const end = (e, cancel) => {
      if (!drag || drag.id !== e.pointerId) return;
      const d = drag; drag = null;
      if (!d.moved) return;   // a tap: the click toggles
      suppressClick = true; setTimeout(() => { suppressClick = false; }, 450);
      const a = d.last[0], b = d.last[d.last.length - 1], v = (b[1] - a[1]) / Math.max(1, b[0] - a[0]);   // px/ms, + is down
      let open = d.off < d.full / 2;
      if (v < -0.35) open = true; else if (v > 0.35) open = false;
      if (cancel) open = d.wasOpen;
      tp.classList.remove("mb-drag"); sheet.style.transform = "";
      if (!open && !d.wasOpen) placeTimeline(false);
      setOpen(open);
    };
    h.addEventListener("pointerup", (e) => end(e, false));
    h.addEventListener("pointercancel", (e) => end(e, true));
  }

  // tap outside (the cameras or the top bar) closes the sheet; that tap does nothing else
  function outside(e) {
    if (!M.on || !M.open) return false;
    const t = e.target;
    if (!t || !t.closest || tp.contains(t)) return false;
    return !!t.closest("#viewport, .topbar") && !t.closest(".cam-menu, .us-panel, .us-dock, [role=dialog], .drawer, .modal");
  }
  function init() {
    if (typeof window.matchMedia !== "function") return;
    mq = window.matchMedia(MQ);
    const apply = () => { if (mq.matches) enter(); else leave(); };
    if (mq.addEventListener) mq.addEventListener("change", apply); else if (mq.addListener) mq.addListener(apply);
    apply();
    document.addEventListener("pointerdown", (e) => { if (outside(e)) { setOpen(false); swallowClick = true; setTimeout(() => { swallowClick = false; }, 600); e.stopPropagation(); e.preventDefault(); } }, true);
    for (const type of ["click", "pointerup", "mousedown", "mouseup"]) document.addEventListener(type, (e) => { if (swallowClick && !tp.contains(e.target)) { e.stopPropagation(); e.preventDefault(); if (type === "click") swallowClick = false; } }, true);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && M.on && M.open && !document.querySelector(".us-panel:not([hidden])")) setOpen(false); });
    // search-ui may (re)build its button later
    if (typeof MutationObserver === "function") new MutationObserver(() => { if (M.on) usBtnOut(); }).observe(tp, { childList: true, subtree: true });
    if (typeof ResizeObserver === "function") new ResizeObserver(sizeBar).observe(document.body);
    // sections: a count on the handle; adding one opens the sheet at the trim row (not the sections an event loads with)
    if (T.on) T.on("player-open", () => { lastEvOpen = Date.now(); });
    const info = $("segInfo");
    if (info && typeof MutationObserver === "function") new MutationObserver(() => {
      const n = parseInt(info.textContent, 10) || 0, prev = segN; segN = n;
      if (badge) { badge.textContent = n ? String(n) : ""; badge.hidden = !n; }
      if (M.on && n > prev && Date.now() - lastEvOpen > 1500 && document.body.classList.contains("simple") === false) setOpen(true, { to: "segBar" });
    }).observe(info, { childList: true, characterData: true, subtree: true });
  }
  M.init = init;
})();
