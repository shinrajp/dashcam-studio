/* auto.js — the automation layer inside the page.
 *  • "Export all": one click exports every event (Most Compatible preset, current overlay toggles).
 *  • Companion mode (?companion=1, page served by the local companion on 127.0.0.1): fetches a job, exports each
 *    event headlessly and uploads the results back to the companion; or (?signin=1) runs the one-time Tesla
 *    sign-in and hands the token + keys to the companion. */
(function () {
  "use strict";
  const T = window.TDC;
  const A = (T.auto = {});
  const params = new URLSearchParams(location.search);
  A.companion = params.has("companion") && /^https?:$/.test(location.protocol);

  /** Export one event with the Auto preset. Returns the exporter result. */
  A.exportEvent = async (ev, opts) => {
    opts = opts || {};
    await T.ui.activate(ev);
    ev.exportState = "running"; T.ui.renderLibrary();
    try {
      const res = await T.exporter.run({
        preset: opts.preset || "compat", codec: opts.codec || "h264", sizeId: opts.sizeId || "native",
        range: [0, ev.duration], show: opts.show || { ...T.prefs.show },
        onStatus: opts.onStatus, onProgress: opts.onProgress,
      });
      ev.exported = { name: res.name, at: Date.now() };
      return res;
    } finally { ev.exportState = null; T.ui.renderLibrary(); }
  };

  /** The "Export all" button. */
  A.exportAllInteractive = async () => {
    const U = T.ui;
    const evs = T.library.events.filter((e) => !e.exported);
    if (!evs.length) { T.toast("Every event has already been exported in this session.", "ok"); return; }
    if (window.showDirectoryPicker && !U.outDir && evs.length > 1) {
      try { U.outDir = await window.showDirectoryPicker({ id: "tdc-exports", mode: "readwrite", startIn: "videos" }); }
      catch (_) { U.outDir = null; } // cancelled → fall back to downloads
    }
    U.progressUi(`Exporting ${evs.length} event${evs.length > 1 ? "s" : ""}…`);
    const done = [], skipped = [];
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      if (T.exporter.cancelled && i > 0) break;
      const playable = ev.clips.some((c) => Object.values(c.files).some((f) => f.blob));
      if (!playable) { skipped.push(ev); continue; }
      const head = `Event ${i + 1} of ${evs.length} · ${ev.trigger.label}`;
      const t0 = performance.now();
      try {
        const res = await A.exportEvent(ev, {
          onStatus: (s) => U.progress(0, `${head} · ${s}`),
          onProgress: (d, tot) => { const el = (performance.now() - t0) / 1000; U.progress(((i + d / tot) / evs.length) * 100, `${head} · ${Math.floor((d / tot) * 100)}% · about ${T.fmtTime((el / d) * (tot - d))} left`); },
        });
        await U.save(res);
        done.push(res);
      } catch (e) {
        if (String(e.message) === "cancelled") break;
        console.error(e); skipped.push(ev);
      }
    }
    U.progress(100, `✓ Exported ${done.length} video${done.length === 1 ? "" : "s"}${U.outDir ? " to " + U.outDir.name : U.shareFiles && U.shareFiles.length ? " · tap Save / Share" : " (check your Downloads)"}${skipped.length ? ` · skipped ${skipped.length} (locked or failed)` : ""}.`);
    $("btnExportCancel").textContent = "Done";
    T.exporter.cancelled = false;
  };
  const $ = (id) => document.getElementById(id);

  // ── companion protocol ──
  async function api(path, body, type) {
    const r = await fetch(path, body === undefined ? {} : { method: "POST", body, headers: { "Content-Type": type || "application/json", "X-TDC-Token": A.token } });
    if (!r.ok) throw new Error(path + " → HTTP " + r.status);
    return r;
  }
  A.token = params.get("token") || "";
  const q = () => "token=" + encodeURIComponent(A.token);

  A.runCompanion = async () => {
    document.body.classList.add("companion");
    if (params.has("signin")) return signin();
    const job = await (await api("/api/job?" + q())).json();
    Object.assign(T.prefs.show, job.show || {});
    // Extra render prefs from the companion's config (not saved to this headless profile's localStorage).
    for (const [k, v] of Object.entries(job.prefs || {})) {
      if (v && typeof v === "object" && !Array.isArray(v) && T.prefs[k] && typeof T.prefs[k] === "object") Object.assign(T.prefs[k], v);
      else T.prefs[k] = v;
    }
    const results = [];
    for (let k = 0; k < job.events.length; k++) {
      const jev = job.events[k];
      await api("/api/progress?" + q(), JSON.stringify({ event: jev.id, state: "loading", index: k, total: job.events.length }));
      T.library.clear();
      const list = [];
      for (const f of jev.files) {
        const b = await (await fetch(f.url)).blob();
        list.push({ file: new File([b], f.name, { type: f.name.endsWith(".json") ? "application/json" : "video/mp4" }), path: f.path });
      }
      await T.library.ingest(list);
      const ev = T.library.events[0];
      if (!ev) { await api("/api/progress?" + q(), JSON.stringify({ event: jev.id, state: "error", error: "no playable camera files" })); continue; }
      for (const preset of jev.presets || ["compat"]) {
        let last = 0;
        try {
          const res = await A.exportEvent(ev, {
            preset, codec: job.codec, sizeId: job.sizeId,
            onProgress: (d, tot) => { const now = performance.now(); if (now - last > 1000 || d === tot) { last = now; api("/api/progress?" + q(), JSON.stringify({ event: jev.id, state: "encoding", preset, done: d, total: tot })).catch(() => {}); } },
          });
          await api(`/api/result?${q()}&event=${encodeURIComponent(jev.id)}&preset=${preset}&name=${encodeURIComponent(res.name)}&info=${encodeURIComponent(JSON.stringify({ W: res.W, H: res.H, codec: res.codec, hw: res.hw, frames: res.frames, note: res.note || null }))}`, res.blob, res.type);
          results.push(res.name);
        } catch (e) {
          await api("/api/progress?" + q(), JSON.stringify({ event: jev.id, state: "error", preset, error: String(e.message || e) }));
        }
      }
    }
    await api("/api/done?" + q(), JSON.stringify({ results }));
    document.title = "TDC-DONE";
  };

  async function signin() {
    const job = await (await api("/api/signin-job?" + q())).json();
    T.auth.itemsOverride = job.items || [];
    $("unlockModal").hidden = false;
    $("unlockModal").querySelector("p").textContent = `The Dashcam Studio companion found ${job.items.length} encrypted clip(s). Sign in with Tesla once so it can unlock them for you. Only key requests go to Tesla; videos never leave this computer.`;
    T.on("tesla-token", (tok) => api("/api/token?" + q(), JSON.stringify({ token: tok })).catch(() => {}));
    T.on("tesla-keys", (results) => api("/api/keys?" + q(), JSON.stringify({ results })).then(() => T.toast("Keys handed to the companion. You can close this tab.", "ok", 10000)).catch(() => {}));
  }
})();
