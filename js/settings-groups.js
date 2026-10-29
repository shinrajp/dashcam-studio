/* settings-groups.js — ui-glass-8: Settings as a compact glass panel with grouped sections, in the style of iOS Settings.
 * The old sections stay where they are in #settings .drawer-body, with the same ids, inputs, saved prefs and handlers: this file only
 * tags each one with a group (data-g) and shows one group at a time (a two-level list with a back button), plus a search field that
 * filters the rows of every group. Sections added later by other files (Search, text search) are tagged by a MutationObserver.
 * Nothing here reads or writes a pref. Export never uses any of this. */
(() => {
  const T = window.TDC = window.TDC || {};
  const $ = (id) => document.getElementById(id);
  const ICON = {
    playback: '<path d="M8 5v14l11-7z"/>',
    appearance: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"/>',
    overlays: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h4M7 11h10"/>',
    redact: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 10h8v4H8z" fill="currentColor"/>',
    export: '<path d="M12 4v11M7 9l5-5 5 5M5 19h14"/>',
    advanced: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>',
    keys: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l3 3"/>',
  };
  const GROUPS = [
    { g: "playback", name: "Playback", sub: "Camera bar, map, units, overlay size" },
    { g: "appearance", name: "Appearance", sub: "Glass, auto-hide, white balance" },
    { g: "overlays", name: "Overlays & HUD", sub: "Labels and HUD items" },
    { g: "redact", name: "Redaction & detection", sub: "Recognition, plates, search" },
    { g: "export", name: "Export", sub: "Cameras, quality, burn-in" },
    { g: "advanced", name: "Advanced & Labs", sub: "360 view, calibration, models, reset" },
    { g: "keys", name: "Keys & unlock", sub: "Encrypted clips, keyboard shortcuts" },
  ];
  const NAME = Object.fromEntries(GROUPS.map((x) => [x.g, x.name]));
  // which group an existing section belongs to (by id, then by its heading)
  const BY_ID = { appearSec: "appearance", calibSec: "advanced", recogSec: "redact", setSearchSec: "redact", setTextSec: "redact", setExportSec: "export", setKeysSec: "keys", setModelsSec: "advanced" };
  const BY_H = [[/^overlays$/i, "overlays"], [/^hud/i, "overlays"], [/^map$/i, "playback"], [/^units/i, "playback"], [/^camera bar/i, "playback"], [/^white balance/i, "appearance"], [/^labs/i, "advanced"], [/^calibration/i, "advanced"], [/^search/i, "redact"], [/recogn|detect|plate|redact/i, "redact"]];
  const groupOf = (sec) => {
    if (BY_ID[sec.id]) return BY_ID[sec.id];
    const h = sec.querySelector("h3"), t = h ? h.textContent.trim() : "";
    for (const [re, g] of BY_H) if (re.test(t)) return g;
    if (sec.querySelector("#btnResetAll, #btnResetLayout")) return "advanced";
    return "advanced";   // anything new and unknown stays reachable
  };
  const S = { view: "home", q: "" };
  let panel, body, home, back, title, filter, empty;

  const sections = () => [...body.children].filter((c) => c.tagName === "SECTION");
  function tag(sec) {
    if (sec.dataset.g) return;
    sec.dataset.g = groupOf(sec); sec.dataset.gname = NAME[sec.dataset.g]; sec.classList.add("set-sec");
    // long hints fold to two lines (a tap, a click or Enter / Space shows the rest); screen readers get the whole text either way
    for (const h of sec.querySelectorAll("p.hint")) {
      if (h.textContent.length < 120 || h.classList.contains("set-clamp") || h.id === "setEmpty") continue;
      h.classList.add("set-clamp"); h.tabIndex = 0; h.setAttribute("role", "button"); h.setAttribute("aria-expanded", "false");
      const flip = () => { const o = !h.classList.contains("open"); h.classList.toggle("open", o); h.setAttribute("aria-expanded", String(o)); };
      h.addEventListener("click", (e) => { if (!e.target.closest("a, button, input")) flip(); });
      h.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
    }
  }

  function extraSections() {
    // Export: its options live in the Export dialog (remembered there); this group says so and opens it
    const ex = document.createElement("section"); ex.id = "setExportSec";
    ex.innerHTML = '<h3>Export</h3><p class="hint">Cameras, layout, quality, sections and what is burned in (HUD, map, labels, redaction) are picked in the Export dialog and remembered for next time.</p><button type="button" class="btn ghost wide set-go" id="setOpenExport">Open Export…</button>';
    const keys = document.createElement("section"); keys.id = "setKeysSec";
    keys.innerHTML = '<h3>Unlock</h3><p class="hint">Some clips are encrypted by the car. Unlock them with your Tesla sign-in or a keys file; the video never leaves this device.</p><button type="button" class="btn ghost wide set-go" id="setOpenUnlock">Unlock encrypted clips…</button>' +
      '<h3 class="set-h3b">Keyboard shortcuts</h3><dl class="set-keys">' +
      [["Space", "Play / pause"], ["← →", "Step a frame (Shift: 5 s)"], ["1–6", "One camera"], ["G or 0", "All cameras"], ["[ ]", "Previous / next camera"], ["+ −", "Zoom (one camera)"], ["C", "Camera bar on / off"], ["L · H · M · D", "Labels · HUD · map · Self-Driving"], ["X · R", "Boxes · redact matches"], ["F", "Full screen"], ["⌘Z / Ctrl+Z", "Undo a redaction edit"], ["Esc", "Close / back to all cameras"]]
        .map(([k, v]) => "<div><dt><kbd>" + k + "</kbd></dt><dd>" + v + "</dd></div>").join("") + "</dl>";
    const models = document.createElement("section"); models.id = "setModelsSec";
    models.innerHTML = '<h3>Models</h3><p class="hint">Detection, plate and vehicle models, their size and speed, live detection and the optional cloud boost.</p><button type="button" class="btn ghost wide set-go" id="setOpenModels">Model settings…</button>';
    const reset = sections().find((s) => s.querySelector("#btnResetAll"));
    for (const s of [ex, keys, models]) body.insertBefore(s, reset || null);
    $("setOpenExport").addEventListener("click", () => { panel.hidden = true; const b = $("btnExport"); if (b) b.click(); });
    $("setOpenUnlock").addEventListener("click", () => { panel.hidden = true; const m = $("unlockModal"); if (m) m.hidden = false; });
    $("setOpenModels").addEventListener("click", () => { show("redact"); const d = $("recogAdv"); if (d && !d.open) d.open = true; if (d) try { d.scrollIntoView({ block: "start" }); } catch (_) {} });
  }

  function build() {
    panel = $("settings"); if (!panel || panel.dataset.grouped) return;
    body = panel.querySelector(".drawer-body"); const head = panel.querySelector(".drawer-head"); if (!body || !head) return;
    panel.dataset.grouped = "1"; panel.classList.add("set-panel");
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Settings");
    title = head.querySelector("h2"); title.id = "setTitle"; title.tabIndex = -1;
    back = document.createElement("button"); back.type = "button"; back.className = "btn icon set-back"; back.id = "setBack"; back.hidden = true;
    back.setAttribute("aria-label", "Back to all settings"); back.title = "All settings";
    back.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg><span>Settings</span>';
    head.insertBefore(back, title);
    const sw = document.createElement("div"); sw.className = "set-search";
    sw.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg><input type="search" id="setFilter" placeholder="Search settings" aria-label="Search settings" autocomplete="off" spellcheck="false">';
    head.after(sw); filter = $("setFilter");
    home = document.createElement("nav"); home.id = "setHome"; home.className = "set-home"; home.setAttribute("aria-label", "Settings groups");
    home.innerHTML = GROUPS.map((x) => '<button type="button" class="set-grp" data-g="' + x.g + '"><span class="set-ic"><svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[x.g] + '</svg></span><span class="set-tx"><b>' + x.name + '</b><small>' + x.sub + '</small></span><svg class="set-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>').join("");
    body.insertBefore(home, body.firstChild);
    empty = document.createElement("p"); empty.className = "hint set-empty"; empty.id = "setEmpty"; empty.hidden = true; empty.setAttribute("role", "status");
    body.insertBefore(empty, home.nextSibling);
    extraSections();
    sections().forEach(tag);
    new MutationObserver(() => { sections().forEach(tag); apply(); }).observe(body, { childList: true });
    home.addEventListener("click", (e) => { const b = e.target.closest(".set-grp"); if (b) show(b.dataset.g, true); });
    home.addEventListener("keydown", (e) => {   // Up / Down / Home / End move between the groups
      const bs = [...home.querySelectorAll(".set-grp")], i = bs.indexOf(document.activeElement); if (i < 0) return;
      const j = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: bs.length - 1 }[e.key]; if (j === undefined) return;
      e.preventDefault(); bs[(j + bs.length) % bs.length].focus();
    });
    back.addEventListener("click", () => { const was = S.view; show("home"); const b = home.querySelector('[data-g="' + was + '"]'); if (b) b.focus(); });
    filter.addEventListener("input", () => { S.q = filter.value.trim(); apply(); });
    filter.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (filter.value) { filter.value = ""; S.q = ""; apply(); } else panel.hidden = true; }
      else if (e.key === "Enter") { e.preventDefault(); const f = body.querySelector(".set-hit input, .set-hit button, .set-hit select, .set-hit summary"); if (f) f.focus(); }
    });
    // touch: a whole settings row with one switch is its target (44 px), the same click on the same checkbox
    body.addEventListener("click", (e) => {
      if (!matchMedia("(pointer: coarse)").matches) return;
      const row = e.target.closest(".row"); if (!row || e.target.closest("input, button, select, a, label, summary, textarea")) return;
      const cbs = row.querySelectorAll('input[type="checkbox"]'); if (cbs.length === 1 && !cbs[0].disabled) cbs[0].click();
    });
    // every time it opens: the group list, no search (like iOS); the × still folds it (ui.js)
    new MutationObserver(() => { if (panel.hidden) { S.next = null; return; } filter.value = ""; S.q = ""; const g = S.next || "home"; S.next = null; show(g); }).observe(panel, { attributes: true, attributeFilter: ["hidden"] });
    show("home");
  }

  const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ");
  function itemsOf(sec) { return [...sec.querySelectorAll(".row, .toggles > :not(.row), p.hint, .btn.wide, h4, .set-keys > div")].filter((n) => !n.closest(".set-keys") || n.parentElement.classList.contains("set-keys")); }
  /** A section with many rows (White balance, Recognition) shows the first ones and a "Show all" button (kept open for the session). */
  const FOLD_AT = 8, KEEP = 5;
  function fold(sec) {
    const rows = [...sec.querySelectorAll(".row")].filter((r) => !r.closest("details, #setShow, #setHud") && r.getClientRects().length + (r.classList.contains("set-x") ? 1 : 0));
    let btn = sec.querySelector(":scope > .set-more");
    if (rows.length < FOLD_AT) { if (btn) btn.hidden = true; sec.classList.remove("set-fold"); return; }
    if (!btn) {
      btn = document.createElement("button"); btn.type = "button"; btn.className = "btn ghost wide set-more";
      btn.addEventListener("click", () => { const o = !sec.classList.contains("open"); sec.classList.toggle("open", o); apply(); if (!o) btn.scrollIntoView({ block: "nearest" }); });
      sec.appendChild(btn);
    }
    sec.classList.add("set-fold"); btn.hidden = false;
    rows.forEach((r, i) => r.classList.toggle("set-x", i >= KEEP));
    // the hints and buttons after the last shown row fold with it
    const last = rows[KEEP - 1];
    [...sec.querySelectorAll(":scope p.hint, :scope .btn.wide:not(.set-more)")].forEach((n) => { if (!n.closest("details")) n.classList.toggle("set-x", !!(last.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) && !last.contains(n)); });
    const open = sec.classList.contains("open");
    btn.textContent = open ? "Show fewer" : "Show all " + (sec.querySelector("h3") ? sec.querySelector("h3").textContent.trim().replace(/\s*\(.*\)$/, "").toLowerCase() + " settings" : "settings") + " (" + (rows.length - KEEP) + " more)";
    btn.setAttribute("aria-expanded", String(open));
  }
  function apply() {
    if (!panel) return;
    const q = norm(S.q), filtering = !!q;
    panel.classList.toggle("set-filtering", filtering);
    panel.dataset.view = filtering ? "search" : S.view;
    home.hidden = filtering || S.view !== "home";
    back.hidden = filtering || S.view === "home";
    title.textContent = filtering ? "Search" : S.view === "home" ? "Settings" : NAME[S.view] || "Settings";
    let any = false;
    for (const sec of sections()) {
      sec.querySelectorAll(".set-miss, .set-hit").forEach((n) => n.classList.remove("set-miss", "set-hit"));
      if (!filtering) { sec.classList.toggle("set-off", sec.dataset.g !== S.view); if (sec.dataset.g === S.view) fold(sec); continue; }
      const hay = norm(sec.dataset.gname + " " + (sec.querySelector("h3") || {}).textContent);
      const secHit = hay.includes(q);
      let hits = 0;
      for (const it of itemsOf(sec)) {
        const ok = secHit || norm(it.textContent + " " + [...it.querySelectorAll("[title],[aria-label]")].map((x) => x.title + " " + x.getAttribute("aria-label")).join(" ")).includes(q);
        it.classList.add(ok ? "set-hit" : "set-miss"); if (ok && !it.matches("p.hint")) hits++;
      }
      const det = sec.querySelector("details");
      if (det) { const inDet = det.querySelector(".set-hit:not(p.hint)"); det.classList.toggle("set-miss", !inDet && !secHit); }
      const show = secHit || hits > 0;
      sec.classList.toggle("set-off", !show); if (show) any = true;
    }
    empty.hidden = !filtering || any;
    if (filtering && !any) empty.textContent = "No settings match “" + S.q + "”.";
  }
  function show(g, focus) {
    S.view = g || "home";
    apply();
    if (body) body.scrollTop = 0;
    if (focus && S.view !== "home") { try { title.focus({ preventScroll: true }); } catch (_) {} }
  }
  T.settings = { show: (g) => { if (!panel) return; S.next = g; if (panel.hidden) panel.hidden = false; else show(g); } /* S.next also wins over the reset from an open in the same tick */, view: () => S.view, groups: GROUPS.map((x) => x.g), groupOf: (el) => { const s = el && el.closest && el.closest("section[data-g]"); return s ? s.dataset.g : null; }, build };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
