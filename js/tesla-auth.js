/* tesla-auth.js — "Unlock with Tesla" for encrypted clips.
 * 1. We open https://dashcam.tesla.com/#gridplayer=<nonce>&gpo=<our origin> in a popup.
 * 2. The connector userscript there says hello (with the nonce); we answer with the key requests
 *    (clip id, VIN, key id, timestamp, wrapped key, public key — never video).
 * 3. After you sign in, it calls Tesla's (undocumented) /api/1/decrypt/batch on Tesla's own origin and posts
 *    the 16-byte file keys back. We decrypt locally (Web Crypto) and play.
 * Only messages from https://dashcam.tesla.com, from the popup we opened, carrying the current nonce, are accepted. */
(function () {
  "use strict";
  const T = window.TDC;
  const A = (T.auth = { job: null, popup: null });
  const ORIGIN = "https://dashcam.tesla.com";
  const HELLO = "tesla-dashcam-hello", ITEMS = "tesla-dashcam-items", STATUS = "tesla-dashcam-status";
  const KEYS = "tesla-dashcam-keys", KEYS_ERROR = "tesla-dashcam-keys-error", TOKEN = "tesla-dashcam-token";
  const SELF_ORIGIN = /^https?:$/.test(location.protocol) ? location.origin : null;
  const SEEN_KEY = "tdc.connectorSeen";

  /** Key requests to send: the library's pending clips, or a list handed over by the companion's sign-in page. */
  A.items = () => A.itemsOverride || T.library.pendingKeyItems();
  const notice = (text, kind) => { const n = T.$("unlockNotice"); if (n) { n.textContent = text || ""; n.className = "notice" + (kind ? " " + kind : ""); n.hidden = !text; } };

  /** Must be called from a click handler (popup blockers). */
  A.start = () => {
    const items = A.items();
    if (!items.length) { notice("No encrypted clips are waiting for keys.", ""); return false; }
    if (A.job) clearTimeout(A.job.timer);
    try { if (A.popup && !A.popup.closed) A.popup.close(); } catch (_) {}
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    const nonce = T.crypto.toHex(b);
    const url = `${ORIGIN}/#gridplayer=${nonce}&gpo=${encodeURIComponent(SELF_ORIGIN || "*")}`;
    let w = null;
    try { w = window.open(url, "tdcUnlock_" + nonce, "width=980,height=800"); } catch (_) {}
    if (!w) { notice("Popup blocked — allow pop-ups for this page, then click Unlock with Tesla again.", "err"); return false; }
    A.popup = w;
    A.job = { nonce, popup: w, hello: false, done: false, timer: setTimeout(notDetected, 8000) };
    T.$("connectorSetup").hidden = true;
    notice("Tesla opened in a new window — sign in there if asked. Waiting for the connector…", "");
    return true;
  };

  function notDetected() {
    if (!A.job || A.job.hello || A.job.done) return;
    T.$("connectorSetup").hidden = false;
    let seen = false; try { seen = localStorage.getItem(SEEN_KEY) === "1"; } catch (_) {}
    T.$("connectorSetupTitle").textContent = seen ? "The connector didn't answer" : "One-time setup: install the Tesla connector";
    notice("No answer from the connector on the Tesla page.", "err");
  }

  async function applyAndDecrypt(results, via) {
    const r = T.library.applyKeys(results);
    if (!r.applied) { notice(`No usable keys${r.errors ? ` — Tesla refused ${r.errors} clip(s)` : ""}${r.invalid ? `, ${r.invalid} invalid` : ""}.`, "err"); return r; }
    notice(`${via}: ${r.applied} key(s) received. Decrypting on this computer…`, "ok");
    const d = await T.library.decryptReady((done, total) => notice(`Decrypting ${done}/${total} file(s) locally…`, ""));
    notice(`Unlocked ${d.done - d.failed} file(s)${d.failed ? `, ${d.failed} failed (wrong key?)` : ""}.`, d.failed ? "err" : "ok");
    T.emit("unlocked", d);
    return r;
  }
  A.applyAndDecrypt = applyAndDecrypt;

  // Accept keys from the connector handshake OR from the manual console helper.
  // The helper posts {type: tesla-dashcam-keys, results} with no nonce. If Unlock
  // already opened the Tesla window, A.job is set — do not drop that message.
  window.addEventListener("message", (ev) => {
    if (ev.origin !== ORIGIN) return;
    const d = ev.data;
    if (!d || typeof d !== "object") return;

    if (d.type === KEYS && Array.isArray(d.results)) {
      if (d.nonce && A.job && d.nonce !== A.job.nonce) return;
      if (A.job) { A.job.done = true; clearTimeout(A.job.timer); }
      try { T.toast("Keys received from Tesla — decrypting…", "ok", 6000); } catch (_) {}
      applyAndDecrypt(d.results, "Auto-applied from Tesla page").then((r) => {
        const msg = (!r || !r.applied)
          ? "Keys arrived but none matched these clips. Reload the folder, copy the helper again, and retry."
          : "Unlocked " + r.applied + " clip key(s)";
        try { T.toast(msg, !r || !r.applied ? "err" : "ok", 8000); } catch (_) {}
      }).catch((e) => { try { T.toast("Apply failed: " + (e.message || e), "err", 8000); } catch (_) {} });
      return;
    }

    if (!A.job || d.nonce !== A.job.nonce || ev.source !== A.job.popup) return;
    if (d.type === HELLO) {
      A.job.hello = true; clearTimeout(A.job.timer);
      try { localStorage.setItem(SEEN_KEY, "1"); } catch (_) {}
      T.$("connectorSetup").hidden = true;
      try { ev.source.postMessage({ type: ITEMS, nonce: A.job.nonce, items: A.items() }, ORIGIN); } catch (_) {}
      notice("Connected to the Tesla page — sign in there if asked.", "");
    } else if (d.type === STATUS) {
      notice(d.state === "fetching" ? "Fetching keys from Tesla…" : "Waiting for you to sign in on the Tesla page…", "");
    } else if (d.type === KEYS) {
      A.job.done = true;
      T.emit("tesla-keys", d.results);
      if (!A.itemsOverride) applyAndDecrypt(d.results, "Unlocked via Tesla");
      else notice("Keys received from Tesla.", "ok");
    } else if (d.type === KEYS_ERROR) {
      A.job.done = true;
      notice("Unlock failed: " + String(d.error || "unknown error").slice(0, 300), "err");
    } else if (d.type === TOKEN && typeof d.token === "string" && d.token.length >= 20 && d.token.length <= 16384) {
      A.token = d.token;
      T.emit("tesla-token", d.token);
    }
  });

  /** Console helper for manual key fetch (run on dashcam.tesla.com while signed in).
   * Works even when the token is not in cookies/storage — the user can paste a Bearer token when prompted. */
  A.helperSource = () => {
    const items = JSON.stringify(A.items());
    return `(async()=>{
  const items = ${items};
  const pick = () => {
    try {
      for (const st of [sessionStorage, localStorage]) for (let i = 0; i < st.length; i++) {
        const k = st.key(i); if (/refresh|id_?token|csrf/i.test(k)) continue;
        const v = st.getItem(k) || "";
        const m = v.match(/eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+/);
        if (/token|auth/i.test(k) && m) return m[0];
      }
    } catch (_) {}
    return null;
  };
  let token = pick();
  if (!token) {
    const raw = prompt("No token found in storage.\\n\\nPaste the Bearer token from the Network tab\\n(DevTools → Network → /api/1/decrypt/batch → Authorization header):");
    if (!raw) { console.log("Cancelled"); return; }
    token = raw.replace(/^Bearer\\s+/i, "").trim();
  }
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const r = await fetch("/api/1/decrypt/batch", {
    method: "POST", credentials: "include", headers,
    body: JSON.stringify({ items })
  });
  const txt = await r.text();
  console.log("HTTP", r.status);
  let data = null;
  try { data = JSON.parse(txt); } catch (_) {}
  if (!r.ok || !data) {
    console.error("Key fetch failed", r.status, txt.slice(0, 200));
    return;
  }
  const results = Array.isArray(data) ? data : (data.results || []);
  const clean = JSON.stringify({ results });
  let nonce = null;
  try {
    const hm = /[#&]gridplayer=([0-9a-f]{16,64})/i.exec(location.hash);
    if (hm) nonce = hm[1];
    else {
      const saved = JSON.parse(sessionStorage.getItem("teslaGridPlayerConnector") || "null");
      if (saved && saved.nonce) nonce = saved.nonce;
    }
  } catch (_) {}
  const msg = { type: "tesla-dashcam-keys", results };
  if (nonce) msg.nonce = nonce;

  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(msg, "*");
      console.log("✓ Keys sent to Dashcam Studio" + (nonce ? " (nonce " + nonce.slice(0, 8) + "…)" : " (no nonce in this tab)"));
    } else {
      console.log("No opener — this tab was not opened by Dashcam Studio, so keys cannot be applied automatically.");
    }
  } catch (e) { console.warn("postMessage failed", e); }

  // Always leave a clipboard copy too, in case the opener ignores the message.
  console.log(clean);
  try { copy(clean); console.log("✓ Clean keys JSON also copied — paste into Dashcam Studio only if it did not unlock by itself"); } catch (_) {}
  return clean;
})();`;
  };

  A.init = () => {
    try {
      T.$("btnUnlockGo")?.addEventListener("click", () => A.start());
      T.$("btnUnlockRetry")?.addEventListener("click", () => A.start());
      T.$("btnDownloadConnector")?.addEventListener("click", () => T.download(new Blob([T.CONNECTOR_SRC], { type: "text/javascript" }), T.CONNECTOR_FILENAME));
      T.$("btnCopyConnector")?.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(T.CONNECTOR_SRC); notice("Connector copied — create a new script in Userscripts / Tampermonkey and paste it.", "ok"); }
        catch (_) { notice("Copy failed — use Download instead.", "err"); }
      });
      T.$("btnCopyHelper")?.addEventListener("click", async () => {
        const src = A.helperSource();
        try { await navigator.clipboard.writeText(src); notice("Helper copied. Open dashcam.tesla.com, sign in, open the console, paste, press Enter.", "ok"); }
        catch (_) { notice("Copy failed — select and copy the helper manually.", "err"); }
      });
      T.$("btnApplyKeys")?.addEventListener("click", async () => {
        let raw = (T.$("pasteKeys")?.value || "").trim();
        raw = raw.replace(/^HTTP\s*\d+\s*/i, "").replace(/^["']|["']$/g, "").trim();
        if (!raw) { alert("Paste the keys JSON first."); return; }
        let data = null;
        try { data = JSON.parse(raw); } catch (e) { alert("That isn't valid JSON.\n\n" + e.message); return; }
        const results = Array.isArray(data) ? data : (data.results || []);
        if (!results.length) { alert("No results found in the JSON."); return; }
        try {
          const r = await applyAndDecrypt(results, "Pasted keys");
          if (!r.applied) alert("No usable keys were applied. Check the message in the dialog.");
        } catch (e) {
          console.error(e);
          alert("Apply keys failed: " + (e.message || e));
        }
      });
      // Auto-apply keys from clipboard when the user returns to this page (safe — cannot break startup)
      try {
        let lastClip = "";
        async function tryAutoApplyFromClipboard() {
          if (!navigator.clipboard || !navigator.clipboard.readText) return;
          try {
            const text = (await navigator.clipboard.readText() || "").trim();
            if (!text || text === lastClip) return;
            lastClip = text;
            let clean = text.replace(/^HTTP\s*\d+\s*/i, "").replace(/^["']|["']$/g, "").trim();
            clean = clean.replace(/\\"/g, '"');
            const data = JSON.parse(clean);
            const results = Array.isArray(data) ? data : (data.results || []);
            if (!results.length || !results[0].key) return;
            notice("Keys found on clipboard — applying…", "ok");
            await applyAndDecrypt(results, "Auto-applied from clipboard");
          } catch (_) {}
        }
        window.addEventListener("focus", tryAutoApplyFromClipboard);
        document.addEventListener("visibilitychange", () => { if (!document.hidden) tryAutoApplyFromClipboard(); });
      } catch (e) { console.warn("clipboard auto-apply disabled", e); }
      const refreshPending = () => {
        const el = T.$("pendingItemsJson");
        if (el) el.value = JSON.stringify(A.items(), null, 2);
      };
      refreshPending();
      T.on("library", refreshPending);
    } catch (e) {
      console.warn("Tesla auth init skipped", e);
    }
  };
})();
