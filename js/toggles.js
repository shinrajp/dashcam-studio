/* toggles.js — ui-glass-4: phone landscape folds the toggles (the #chips strip: Labels, HUD, Map, Self-Driving, Time, Hand-off, Car view,
 * White balance) into one eye button in the slim bar (js/mobile-bar.js) that fans them out in a glass popover.
 *  - only while body.mbar and the screen is short landscape; desktop, tablets and phone portrait never see the eye (the strip stays where it is)
 *  - the same #chips node is moved into the popover when it opens and back to its place in the pull-up sheet when it closes, so every handler,
 *    saved pref (TDC.prefs.show / carView / handoff / wb), id and shortcut (H, M, D) is unchanged; nothing is copied
 *  - keyboard: the eye is a button (aria-expanded, aria-controls); opening moves focus to the first toggle, Esc closes and returns focus to the eye,
 *    tabbing out closes. Tap outside closes (that tap does nothing else on the video). Opening the sheet closes it and vice versa
 *  - auto-hide holds while it is open (js/autohide.js); js/glass.js may give it a blur within the budget */
(function () {
  "use strict";
  const T = (window.TDC = window.TDC || {});
  const $ = (id) => document.getElementById(id);
  const LAND = "(max-height: 500px) and (orientation: landscape)";
  const G = (T.toggles = { open: false });
  let eye = null, pop = null, home = null, mq = null, backT = 0, swallow = 0;
  const rm = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; } };
  const folded = () => !!(document.body && document.body.classList.contains("mbar") && mq && mq.matches);
  G.folded = folded;
  const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3.2"/></svg>';

  function build() {
    eye = document.createElement("button");
    eye.type = "button"; eye.className = "btn icon tg-eye"; eye.id = "tgEye";
    eye.setAttribute("aria-controls", "tgPop"); eye.setAttribute("aria-expanded", "false"); eye.setAttribute("aria-haspopup", "true");
    eye.setAttribute("aria-label", "Overlays"); eye.title = "Overlays: Labels, HUD, Map, Self-Driving, Time, Hand-off, Car view, White balance";
    eye.innerHTML = EYE;
    eye.addEventListener("click", (e) => { e.preventDefault(); G.toggle(); });
    pop = document.createElement("div");
    pop.className = "tg-pop"; pop.id = "tgPop"; pop.setAttribute("role", "group"); pop.setAttribute("aria-label", "Overlays"); pop.setAttribute("aria-hidden", "true");
    if ("inert" in pop) pop.inert = true;
    document.body.appendChild(pop);
  }
  /** the eye lives in the slim row, just before ⌃, and only while folded (the row is rebuilt each time the phone layout starts; the timeline
   *  moves in and out of it, so the row is watched to keep the eye beside ⌃) */
  let rowSeen = null;
  function place() {
    const row = $("mbRow");
    if (!row || !folded()) { if (G.open) close(true); if (eye && eye.parentNode) eye.remove(); return; }
    if (row !== rowSeen && typeof MutationObserver === "function") { rowSeen = row; new MutationObserver(() => { if (eye.parentNode === row) put(row); }).observe(row, { childList: true }); }
    put(row);
  }
  function put(row) { const more = $("mbMore"); const ref = more && more.parentNode === row ? more : null; if (eye.parentNode !== row || eye.nextSibling !== ref) row.insertBefore(eye, ref); }
  function position() {
    const r = eye.getBoundingClientRect(), de = document.documentElement, W = de.clientWidth, H = de.clientHeight;
    const bar = $("mbBar"), top = Math.min(r.top, bar ? bar.getBoundingClientRect().top : r.top);   // above the whole bar (its grip strip too)
    pop.style.right = Math.max(8, Math.round(W - r.right)) + "px";
    pop.style.bottom = Math.max(8, Math.round(H - top + 8)) + "px";
    pop.style.maxHeight = Math.max(60, Math.round(top - 16)) + "px";
  }
  function chipsBack() {
    clearTimeout(backT); backT = 0;
    const chips = $("chips");
    if (home && chips) { if (home.parentNode) home.parentNode.insertBefore(chips, home); home.remove(); }
    home = null;
  }
  function open() {
    if (G.open || !folded()) return;
    const chips = $("chips"); if (!chips) return;
    if (T.mobileBar && T.mobileBar.open) T.mobileBar.setOpen(false);
    clearTimeout(backT); backT = 0;
    if (!home) { home = document.createComment("tg:chips"); chips.parentNode.insertBefore(home, chips); }
    pop.appendChild(chips);
    [...chips.children].forEach((c, i) => c.style.setProperty("--i", String(i)));
    position();
    void pop.offsetWidth;   // the closed state first, so the toggles fan out
    G.open = true;
    pop.classList.add("open"); pop.setAttribute("aria-hidden", "false"); if ("inert" in pop) pop.inert = false;
    eye.setAttribute("aria-expanded", "true"); eye.setAttribute("aria-label", "Hide overlays");
    const first = chips.querySelector("button"); if (first) try { first.focus({ preventScroll: true }); } catch (_) {}
    if (T.autohide && T.autohide.wake) T.autohide.wake();
    if (T.glass && T.glass.budgetSoon) T.glass.budgetSoon();
  }
  function close(now, refocus) {
    if (!G.open) { if (now) chipsBack(); return; }
    G.open = false;
    const hadFocus = pop.contains(document.activeElement);
    pop.classList.remove("open"); pop.setAttribute("aria-hidden", "true"); if ("inert" in pop) pop.inert = true;
    eye.setAttribute("aria-expanded", "false"); eye.setAttribute("aria-label", "Overlays");
    if (now || rm()) chipsBack(); else backT = setTimeout(chipsBack, 220);   // after the fold-back
    if ((refocus || hadFocus) && eye.isConnected) try { eye.focus({ preventScroll: true }); } catch (_) {}
    if (T.glass && T.glass.budgetSoon) T.glass.budgetSoon();
  }
  G.show = open; G.hide = (now) => close(!!now); G.toggle = () => (G.open ? close(false) : open());

  function init() {
    if (typeof window.matchMedia !== "function" || !document.body) return;
    mq = window.matchMedia(LAND);
    build();
    const sync = () => place();
    if (mq.addEventListener) mq.addEventListener("change", sync); else if (mq.addListener) mq.addListener(sync);
    const tp = $("transport");
    if (tp && typeof MutationObserver === "function") {
      new MutationObserver(sync).observe(tp, { childList: true });
      new MutationObserver(() => { if (G.open && tp.classList.contains("mb-open")) close(true); }).observe(tp, { attributes: true, attributeFilter: ["class"] });
      new MutationObserver(() => { if (G.open && !folded()) close(true); }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    }
    sync();
    // tap outside closes; a tap on the video or the top bar does nothing else (like the sheet)
    document.addEventListener("pointerdown", (e) => {
      if (!G.open) return;
      const t = e.target; if (!t || !t.closest || pop.contains(t) || eye.contains(t)) return;
      close(false);
      if (t.closest("#viewport, .topbar")) { swallow = Date.now(); e.stopPropagation(); e.preventDefault(); }
    }, true);
    for (const type of ["click", "pointerup", "mousedown", "mouseup"]) document.addEventListener(type, (e) => {
      if (swallow && Date.now() - swallow < 600 && !pop.contains(e.target) && e.target && e.target.closest && e.target.closest("#viewport, .topbar")) { e.stopPropagation(); e.preventDefault(); if (type === "click") swallow = 0; }
    }, true);
    document.addEventListener("keydown", (e) => { if (G.open && e.key === "Escape") { e.stopPropagation(); close(false, true); } }, true);
    pop.addEventListener("focusout", (e) => { const n = e.relatedTarget; if (G.open && n && !pop.contains(n) && n !== eye) close(false); });
    window.addEventListener("resize", () => { if (G.open) { if (folded()) position(); else close(true); } });
  }
  G.init = init;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
