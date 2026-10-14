/* lib-index-ui.js — filters + remembered-events panel for the library index (Phase 3). Fails closed: on any error
 * the panel is hidden and the original event list keeps working. */
(function () {
  "use strict";
  const T = window.TDC, X = T.libIndex;
  if (!X) return;
  const $ = (id) => document.getElementById(id);
  let bar, panel, list, info;

  function build() {
    const aside = $("library"), libList = $("libList");
    if (!aside || !libList) return false;
    bar = document.createElement("div");
    bar.id = "libIndexBar"; bar.className = "lib-index-bar";
    bar.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin:6px 0";
    bar.innerHTML = `<select id="libFilter" aria-label="Filter events" style="flex:1;min-width:0;font-size:0.8rem;padding:4px">
        <option value="all">All</option><option value="undecrypted">Undecrypted only</option><option value="decrypted">Already decrypted</option></select>
      <button class="btn small ghost" id="btnClearIndex" type="button" title="Forget every remembered event. Files are not touched.">Clear index</button>`;
    aside.insertBefore(bar, libList);
    panel = document.createElement("details");
    panel.id = "libIndexPanel"; panel.className = "lib-index-panel";
    panel.style.cssText = "margin-top:8px;font-size:0.8rem";
    panel.innerHTML = `<summary>Remembered events <span id="libIndexInfo"></span></summary><div id="libIndexList" style="max-height:40vh;overflow:auto"></div>`;
    aside.appendChild(panel);
    list = $("libIndexList"); info = $("libIndexInfo");
    $("libFilter").addEventListener("change", (e) => { X.filter = e.target.value; apply(); });
    $("btnClearIndex").addEventListener("click", async () => { if (confirm("Forget all remembered events? Your video files are not touched. Saved decryption keys are NOT removed (use Forget saved keys in the Unlock dialog).")) { await X.clear(); T.toast("Library index cleared", "ok"); } });
    return true;
  }

  function apply() {
    try {
      const evs = T.library.events;
      const els = [...document.querySelectorAll("#libList .ev")];
      els.forEach((el, i) => { const ev = evs[i]; const r = ev && X.events.get(ev.id); el.hidden = !!(r && !X.matches(r, X.filter)); });
      // day headers with no visible events
      [...document.querySelectorAll("#libList .lib-day")].forEach((d) => { let n = d.nextElementSibling, any = false; while (n && !n.classList.contains("lib-day")) { if (!n.hidden) any = true; n = n.nextElementSibling; } d.hidden = !any; });
      const loaded = new Set(evs.map((e) => e.id));
      const recs = X.list();
      info.textContent = `(${X.events.size}${X.mode === "memory" ? ", this session only" : ""})`;
      list.innerHTML = "";
      for (const r of recs.slice(0, 500)) {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:6px;align-items:center;padding:3px 0;border-bottom:1px solid rgba(127,127,127,.15)" + (loaded.has(r.id) ? "" : ";opacity:.65");
        const d = r.time ? new Date(r.time) : null;
        const st = r.status === "decrypted" ? "🔓" : r.status === "undecrypted" ? "🔒" : "▶";
        const txt = document.createElement("span"); txt.style.flex = "1";
        txt.textContent = `${st} ${d ? T.fmtDate(d) + " " + T.fmtClock(d).slice(0, 5) : "—"} · ${r.label} · ${r.angles}-cam · ${r.clips} clip${r.clips === 1 ? "" : "s"}${loaded.has(r.id) ? "" : " · not loaded"}`;
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!r.reviewed; cb.title = "Reviewed";
        cb.addEventListener("change", () => X.setReviewed(r.id, cb.checked));
        row.append(txt, cb); list.appendChild(row);
      }
      if (!recs.length) list.textContent = X.events.size ? "No events match this filter." : "Nothing remembered yet.";
      // Show the sidebar when we remember events even if no folder is open, so status is visible right away.
      const aside = $("library"); if (aside && X.events.size && aside.hidden && !T.library.events.length) { aside.hidden = false; aside.classList.add("index-only"); }
      else if (aside && T.library.events.length) aside.classList.remove("index-only");
    } catch (e) { console.warn("library index UI error", e); }
  }

  let syncTimer = null;
  function onLibrary() {
    setTimeout(apply, 0); // after ui.js has re-rendered the list
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { X.sync(T.library.events).then(apply).catch((e) => console.warn("index sync failed", e)); }, 150);
  }

  function init() {
    try {
      if (!build()) return;
      // Wrap ingest to report how many files were already known (incremental scan).
      const ingest = T.library.ingest;
      T.library.ingest = async (lst, onProgress) => {
        let known = 0;
        try { await X.ready; for (const { file, path } of lst) if (file && X.isKnownFile(path, file.size)) known++; } catch (_) {}
        const r = await ingest(lst, onProgress);
        r.knownFiles = known;
        if (known) setTimeout(() => T.toast(`${known} file(s) were already in your library index; ${Math.max(0, r.added - known)} new.`, "ok", 4000), 1200);
        return r;
      };
      T.on("library", onLibrary);
      T.on("unlocked", onLibrary);
      T.on("libindex", apply);
      X.ready.then(apply);
    } catch (e) { console.warn("library index UI disabled", e); if (bar) bar.hidden = true; if (panel) panel.hidden = true; }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
