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
  /** Same requests split into session-aware batches of ≤30 (Tesla rejects larger batches). */
  A.batches = () => {
    if (A.itemsOverride) { const b = [], it = A.itemsOverride, n = (T.batching && T.batching.MAX_PER_BATCH) || 30; for (let i = 0; i < it.length; i += n) b.push(it.slice(i, i + n)); return b; }
    return T.library.pendingKeyBatches ? T.library.pendingKeyBatches() : [A.items()];
  };
  const notice = (text, kind) => { const n = T.$("unlockNotice"); if (n) { n.textContent = text || ""; n.className = "notice" + (kind ? " " + kind : ""); n.hidden = !text; } };

  A.newNonce = () => { const b = new Uint8Array(16); crypto.getRandomValues(b); return T.crypto.toHex(b); };
  /** https://dashcam.tesla.com/#gridplayer=<nonce>&gpo=<our origin>&gpi=<key requests>. The key requests are not
   * secret (VIN, key ids, wrapped keys) and a hash is never sent to a server; skipped when too long for a URL. */
  A.unlockUrl = (items, nonce) => {
    let url = `${ORIGIN}/#gridplayer=${nonce}&gpo=${encodeURIComponent(SELF_ORIGIN || "*")}`;
    // Also pass the key requests in the hash for browsers where the connector can't use the opener link (Safari +
    // Userscripts, the iPhone bookmarklet).
    try {
      const raw = JSON.stringify({ items, batches: A.batches() });
      const gpi = btoa(unescape(encodeURIComponent(raw))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      if (gpi.length < 60000) url += "&gpi=" + gpi;
    } catch (_) {}
    return url;
  };

  /** Must be called from a click handler (popup blockers). */
  A.start = () => {
    const items = A.items();
    if (!items.length) {
      // Nothing to unlock: no folder loaded (e.g. after Clear), or every clip already has a key. Say so loudly
      // instead of silently not opening Tesla.
      const locked = T.library.lockedCount ? T.library.lockedCount() : 0;
      const msg = !T.library.items.size
        ? "No clips are loaded (the list was cleared). Open your TeslaCam folder again, then click Sign in with Tesla."
        : locked ? "These clips already have keys — they are decrypting or failed to decrypt. Reload the folder to try again."
        : "No encrypted clips are waiting for keys — everything loaded is already unlocked or unencrypted.";
      notice(msg, "err");
      try { T.toast(msg, "err", 7000); } catch (_) {}
      return false;
    }
    if (A.job) clearTimeout(A.job.timer);
    try { if (A.popup && !A.popup.closed) A.popup.close(); } catch (_) {}
    const nonce = A.newNonce();
    const url = A.unlockUrl(items, nonce);
    // iPhone / iPad: there is no userscript, so also leave the unlock request on the clipboard (a tap just happened) —
    // the Dashcam Unlock bookmark reads it when Tesla's sign-in redirects dropped the address hash.
    try { if (T.iosUnlock && T.iosUnlock.isIOS() && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).catch(() => {}); } catch (_) {}
    let w = null;
    try { w = window.open(url, "tdcUnlock_" + nonce, "width=980,height=800"); } catch (_) {}
    if (!w) { notice("Popup blocked — allow pop-ups for this page, then click Unlock with Tesla again.", "err"); return false; }
    A.popup = w;
    // Sign-in is an explicit request for keys: allow the clipboard hand-off again (disabled by Forget).
    A.suppressClipboard = false; try { localStorage.removeItem("tdc.noClipboardApply"); } catch (_) {}
    A.job = { nonce, popup: w, hello: false, done: false, state: "opened", timer: setTimeout(notDetected, 20000) };
    if (A.watch) clearInterval(A.watch);
    A.watch = setInterval(() => {
      const j = A.job; if (!j || j.done) { clearInterval(A.watch); return; }
      let closed = false; try { closed = j.popup.closed; } catch (_) {}
      if (closed) { clearInterval(A.watch); j.done = true; clearTimeout(j.timer);
        if (ios()) { notice(T.iosUnlock.closedText(), "err"); return; }
        notice(j.hello ? "The Tesla window was closed before keys came back. If it said “Keys copied”, they will apply when you return here; otherwise click Sign in with Tesla again or use the console helper." : "The Tesla window was closed and the connector never answered. See the setup steps, or use the console helper.", "err"); }
    }, 1000);
    T.$("connectorSetup").hidden = true;
    notice(ios() ? T.iosUnlock.openedText() : "Tesla opened in a new window — sign in there if asked. Waiting for the connector…", "");
    return true;
  };

  const ios = () => !!(T.iosUnlock && T.iosUnlock.isIOS());

  function notDetected() {
    if (!A.job || A.job.hello || A.job.done) return;
    if (ios()) { // iPhone / iPad: no userscript unless the user installed one — point at the bookmark (and Userscripts)
      T.$("connectorSetup").hidden = true;
      T.iosUnlock.show();
      notice(T.iosUnlock.notDetectedText(), "err");
      return;
    }
    T.$("connectorSetup").hidden = false;
    let seen = false; try { seen = localStorage.getItem(SEEN_KEY) === "1"; } catch (_) {}
    T.$("connectorSetupTitle").textContent = seen ? "The connector didn't answer" : "One-time setup: install the Tesla connector";
    const safari = /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg/.test(navigator.userAgent);
    notice("Connector not detected (20 s). On the Tesla page, look for a blue “Dashcam Studio connector v1.4.x active” badge at the bottom left. "
      + (safari
        ? "No badge in Safari → the Userscripts extension isn't running the connector: Safari ▸ Settings ▸ Extensions ▸ tick “Userscripts”, then click Edit Websites… and set dashcam.tesla.com to Allow. Click Download connector below, open the Userscripts app and save the file into its scripts folder (or open the .user.js in Safari and use the Userscripts toolbar icon ▸ Install), make sure it's switched on, then reload the Tesla page. If the Userscripts icon isn't in the toolbar, the extension isn't enabled yet. In the Userscripts app, delete any older “Tesla Grid Player Connector” (1.4.0 or earlier — it can't run on Tesla's page in Safari) and any empty “NewScript-…” entries, so only v1.4.4+ remains. To see errors: Safari ▸ Settings ▸ Advanced ▸ “Show features for web developers”, then on the Tesla tab Develop ▸ Show JavaScript Console and look for lines starting with [DashcamStudio]. "
        : "No badge → the userscript isn't running: in Chrome open chrome://extensions → Tampermonkey → Details → turn on “Allow user scripts” (or Developer mode), and make sure the script is enabled for dashcam.tesla.com. ")
      + "Badge says “link lost” → use the “Copy keys for Dashcam Studio” button on the Tesla page, then return here. "
      + "The console helper below always works.", "err");
  }

  let applying = false;
  T.on("decrypt", (i) => { if (applying && i && !i.finished && T.ui && T.ui.decryptLine) notice(T.ui.decryptLine(i), ""); });
  async function applyAndDecrypt(results, via) {
    const r = T.library.applyKeys(results);
    if (!r.applied) { notice(`No usable keys${r.errors ? ` — Tesla refused ${r.errors} clip(s)` : ""}${r.invalid ? `, ${r.invalid} invalid` : ""}.`, "err"); return r; }
    notice(`${via}: ${r.applied} key(s) received. Decrypting on this computer…`, "ok");
    applying = true;
    let d;
    try { d = await T.library.decryptReady((done, total) => notice(`Decrypting ${done}/${total} file(s) locally…`, "")); } finally { applying = false; }
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
      A.job.hello = true; A.job.version = d.version || "?"; clearTimeout(A.job.timer);
      try { localStorage.setItem(SEEN_KEY, "1"); } catch (_) {}
      T.$("connectorSetup").hidden = true;
      try { ev.source.postMessage({ type: ITEMS, nonce: A.job.nonce, items: A.items(), batches: A.batches() }, ORIGIN); } catch (_) {}
      notice(`Connector v${A.job.version} detected on the Tesla page — sign in there if asked.`, "");
    } else if (d.type === STATUS && d.state === "partial") {
      const errs = Array.isArray(d.errors) ? d.errors.map(String).slice(0, 5) : [];
      notice("Some key batches were refused by Tesla (" + errs.join("; ").slice(0, 300) + "). Keys from the other batches will still be applied — run Unlock again for the rest.", "err");
    } else if (d.type === STATUS) {
      A.job.state = d.state;
      notice(d.state === "fetching" ? "Connector detected, token found — fetching keys from Tesla…" : "Connector detected, but no Tesla sign-in token yet — sign in on the Tesla page, or use its “Paste token” button.", "");
    } else if (d.type === KEYS) {
      A.job.done = true;
      T.emit("tesla-keys", d.results);
      if (!A.itemsOverride) applyAndDecrypt(d.results, "Unlocked via Tesla");
      else notice("Keys received from Tesla.", "ok");
    } else if (d.type === KEYS_ERROR) {
      A.job.done = true;
      const e = String(d.error || "unknown error").slice(0, 300);
      notice((/HTTP\s*\d/.test(e) ? "Tesla refused the key request: " : /token/i.test(e) ? "Connector detected but found no Tesla token: " : "Unlock failed: ") + e, "err");
    } else if (d.type === TOKEN && typeof d.token === "string" && d.token.length >= 20 && d.token.length <= 16384) {
      A.token = d.token;
      T.emit("tesla-token", d.token);
    }
  });

  /** Console helper for manual key fetch (run on dashcam.tesla.com while signed in).
   * Works even when the token is not in cookies/storage — the user can paste a Bearer token when prompted. */
  A.helperSource = () => {
    const batches = JSON.stringify(A.batches());
    return `(async()=>{
  const batches = ${batches};
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
  const results = [], failed = [];
  for (let i = 0; i < batches.length; i++) {
    const items = batches[i];
    try {
      const r = await fetch("/api/1/decrypt/batch", {
        method: "POST", credentials: "include", headers,
        body: JSON.stringify({ items })
      });
      const txt = await r.text();
      console.log("Batch " + (i + 1) + "/" + batches.length + " (" + items.length + " files): HTTP", r.status);
      let data = null;
      try { data = JSON.parse(txt); } catch (_) {}
      if (!r.ok || !data) { console.error("Batch " + (i + 1) + " failed", r.status, txt.slice(0, 200)); failed.push(i + 1); continue; }
      results.push(...(Array.isArray(data) ? data : (data.results || [])));
    } catch (e) { console.error("Batch " + (i + 1) + " failed", e); failed.push(i + 1); }
  }
  if (failed.length) console.warn("Batches that failed: " + failed.join(", ") + " — keys from the other batches are still sent. Run the helper again for the rest.");
  if (!results.length) { console.error("No keys fetched."); return; }
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
      // Show how many clips are waiting whenever the dialog opens, so an empty list is obvious before clicking.
      const modal = T.$("unlockModal");
      if (modal && window.MutationObserver) new MutationObserver(() => {
        if (modal.hidden) return;
        const n = A.items().length, lbl = T.$("btnUnlockGo")?.querySelector("span");
        if (lbl) lbl.textContent = n ? `Sign in with Tesla (${n} clip${n === 1 ? "" : "s"})` : "Sign in with Tesla (no clips waiting)";
      }).observe(modal, { attributes: true, attributeFilter: ["hidden"] });
      T.$("btnUnlockRetry")?.addEventListener("click", () => A.start());
      T.$("btnDownloadConnector")?.addEventListener("click", () => T.download(new Blob([T.CONNECTOR_SRC], { type: "text/javascript" }), T.CONNECTOR_FILENAME));
      // navigator.clipboard only exists on https/localhost; on http://<LAN IP> fall back to a selected textarea + execCommand("copy")
      async function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext !== false) { try { await navigator.clipboard.writeText(text); return; } catch (_) {} }
        const ta = document.createElement("textarea");
        ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px";
        document.body.appendChild(ta); ta.focus(); ta.select(); try { ta.setSelectionRange(0, text.length); } catch (_) {}
        let ok = false; try { ok = document.execCommand("copy"); } catch (_) {}
        ta.remove();
        if (!ok) throw new Error("copy blocked");
      }
      A.copyText = copyText;
      T.$("btnCopyConnector")?.addEventListener("click", async () => {
        try { await copyText(T.CONNECTOR_SRC); notice("Connector copied — create a new script in Userscripts / Tampermonkey and paste it.", "ok"); }
        catch (_) { notice("Copy failed — use Download instead.", "err"); }
      });
      T.$("btnCopyHelper")?.addEventListener("click", async () => {
        A.suppressClipboard = false; try { localStorage.removeItem("tdc.noClipboardApply"); } catch (_) {}
        const src = A.helperSource();
        try { await copyText(src); notice("Helper copied. Open dashcam.tesla.com, sign in, open the console, paste, press Enter.", "ok"); }
        catch (_) { notice("Copy failed — select and copy the helper manually.", "err"); }
      });
      T.$("btnApplyKeys")?.addEventListener("click", async () => {
        // The polished flow (js/unlock-ux.js) shows plain-English results next to the box; the original code below is the fallback.
        if (T.unlockUx && T.unlockUx.onApplyClick) { try { await T.unlockUx.onApplyClick(); return; } catch (e) { console.warn("unlock-ux apply failed, using the original path", e); } }
        A.suppressClipboard = false; try { localStorage.removeItem("tdc.noClipboardApply"); } catch (_) {}
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
          if (A.suppressClipboard) return; try { if (localStorage.getItem("tdc.noClipboardApply") === "1") return; } catch (_) {} // after "Forget saved keys"; re-enabled by Copy key helper / Apply keys
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
