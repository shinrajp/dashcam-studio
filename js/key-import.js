/* key-import.js — in-app key / Bearer-token import (Phase 2). Progressive enhancement: if anything here fails,
 * the original "Copy key helper → console → Paste keys" flow in the same dialog is untouched.
 * - Keys JSON (pasted or from a file) is applied directly.
 * - A Bearer token is used to call Tesla's decrypt endpoint in session-aware batches of ≤30.
 *   Browsers only allow that if Tesla's server permits cross-site requests (CORS). If it doesn't,
 *   we say so and point to the console helper / connector. The token is kept in memory only, never stored. */
(function () {
  "use strict";
  const T = window.TDC;
  const ENDPOINT = "https://dashcam.tesla.com/api/1/decrypt/batch";
  const K = (T.keyImport = {});
  const $ = (id) => document.getElementById(id);
  const say = (text, kind) => { const n = $("inAppNotice"); if (!n) return; n.textContent = text || ""; n.className = "notice" + (kind ? " " + kind : ""); n.hidden = !text; };

  /** Classify pasted text: { kind: "keys", results } | { kind: "token", token } | { kind: "bad" } */
  K.parse = (raw) => {
    let s = String(raw || "").trim().replace(/^HTTP\s*\d+\s*/i, "").replace(/^["']|["']$/g, "").trim();
    if (!s) return { kind: "bad" };
    if (/^[\[{]/.test(s)) {
      try {
        const j = JSON.parse(s);
        const results = Array.isArray(j) ? j : j && (j.results || j.keys);
        if (Array.isArray(results)) return { kind: "keys", results };
      } catch (_) {}
      return { kind: "bad" };
    }
    const tok = s.replace(/^Authorization:\s*/i, "").replace(/^Bearer\s+/i, "").trim();
    if (/^[A-Za-z0-9._~+\/=-]{20,16384}$/.test(tok)) return { kind: "token", token: tok };
    return { kind: "bad" };
  };

  K.applyKeys = async (results, via) => {
    if (!T.auth || !T.auth.applyAndDecrypt) throw new Error("Unlock module not loaded");
    return T.auth.applyAndDecrypt(results, via);
  };

  /** Fetch keys with a Bearer token from this page, batch by batch. */
  K.fetchWithToken = async (token, fetchImpl) => {
    const f = fetchImpl || window.fetch.bind(window);
    const batches = T.auth.batches();
    if (!batches.length) { say("No encrypted clips are waiting for keys.", ""); return null; }
    const run = await T.batching.runSequential(batches.map((b) => ({ entries: b })), async (b, i) => {
      say(`Fetching keys: batch ${i + 1} of ${batches.length} (${b.entries.length} clips)…`, "");
      let r;
      try {
        r = await f(ENDPOINT, { method: "POST", mode: "cors", credentials: "omit", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ items: b.entries }) });
      } catch (e) { const err = new Error("CORS/network: Tesla's server did not allow this page to call it directly"); err.cors = true; throw err; }
      const txt = await r.text();
      let data = null; try { data = JSON.parse(txt); } catch (_) {}
      if (!r.ok || !data) throw new Error("HTTP " + r.status + (r.status === 401 || r.status === 403 ? " (token expired or wrong?)" : "") + (txt ? ": " + txt.slice(0, 120) : ""));
      return Array.isArray(data) ? data : data.results || [];
    });
    return run;
  };

  async function onApply() {
    const p = K.parse($("inAppKeyText").value);
    if (p.kind === "bad") return say("That doesn't look like keys JSON or a Bearer token.", "err");
    try {
      if (p.kind === "keys") { await K.applyKeys(p.results, "Imported keys"); say("Keys applied — see the status above.", "ok"); return; }
      const run = await K.fetchWithToken(p.token);
      $("inAppKeyText").value = ""; // don't leave the token on screen
      if (!run) return;
      const cors = run.errors.length && run.errors.every((e) => /CORS/.test(e.error));
      if (run.results.length) await K.applyKeys(run.results, "Fetched with token");
      if (cors && !run.results.length) return say("Your browser blocked the direct request to Tesla (CORS). Use the manual console method below, or the connector — both run on Tesla's own page.", "err");
      if (run.errors.length) say(`${run.errors.length} batch(es) failed: ` + run.errors.map((e) => `#${e.batch}/${e.of} ${e.error}`).join("; ").slice(0, 400) + ". Keys from successful batches were applied.", "err");
      else say(`Fetched ${run.results.length} key(s).`, "ok");
    } catch (e) { console.error(e); say("Import failed: " + (e.message || e) + " — the manual console method below still works.", "err"); }
  }

  K.init = () => {
    try {
      $("btnInAppApply")?.addEventListener("click", onApply);
      $("btnImportKeysFile")?.addEventListener("click", () => $("keysFileInput").click());
      $("keysFileInput")?.addEventListener("change", async (e) => {
        const f = e.target.files && e.target.files[0]; e.target.value = "";
        if (!f) return;
        if (f.size > 5e6) return say("That file is too big to be a keys file.", "err");
        const p = K.parse(await f.text());
        if (p.kind !== "keys") return say("No keys found in that file.", "err");
        try { await K.applyKeys(p.results, "Keys file"); say("Keys file applied.", "ok"); } catch (err) { say("Import failed: " + err.message, "err"); }
      });
    } catch (e) { console.warn("in-app key import disabled", e); const b = $("inAppKeys"); if (b) b.hidden = true; }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", K.init); else K.init();
})();
