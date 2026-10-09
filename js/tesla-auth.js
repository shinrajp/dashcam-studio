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

  window.addEventListener("message", (ev) => {
    if (ev.origin !== ORIGIN) return;
    const d = ev.data;
    if (!d || typeof d !== "object" || !A.job || d.nonce !== A.job.nonce || ev.source !== A.job.popup) return;
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
      // Only sent to http(s)://localhost players. Kept in memory; the companion (if running) may store it in the OS keychain.
      A.token = d.token;
      T.emit("tesla-token", d.token);
    }
  });

  /** Console helper for manual key fetch (run on dashcam.tesla.com while signed in). */
  A.helperSource = () => {
    const items = JSON.stringify(T.library.pendingKeyItems());
    return `(async()=>{const pick=()=>{for(const st of [sessionStorage,localStorage])for(let i=0;i<st.length;i++){const k=st.key(i);if(/refresh|id_?token|csrf/i.test(k))continue;const v=st.getItem(k)||"";const m=v.match(/eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+/);if(/token|auth/i.test(k)&&m)return m[0];}return null;};const t=pick();const h={"Content-Type":"application/json"};if(t)h.Authorization="Bearer "+t;const r=await fetch("/api/1/decrypt/batch",{method:"POST",credentials:"include",headers:h,body:JSON.stringify({items:${items}})});const txt=await r.text();console.log(txt);try{copy(txt);console.log("Copied — paste it into Dashcam Studio → Paste keys");}catch(e){}})();`;
  };

  A.init = () => {
    T.$("btnUnlockGo").addEventListener("click", () => A.start());
    T.$("btnUnlockRetry").addEventListener("click", () => A.start());
    T.$("btnDownloadConnector").addEventListener("click", () => T.download(new Blob([T.CONNECTOR_SRC], { type: "text/javascript" }), T.CONNECTOR_FILENAME));
    T.$("btnCopyConnector").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(T.CONNECTOR_SRC); notice("Connector copied — create a new script in Userscripts / Tampermonkey and paste it.", "ok"); }
      catch (_) { notice("Copy failed — use Download instead.", "err"); }
    });
    T.$("btnCopyHelper").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(A.helperSource()); notice("Helper copied. Open dashcam.tesla.com, sign in, open the browser console, paste, press Enter.", "ok"); }
      catch (_) { T.$("pasteKeys").value = A.helperSource(); }
    });
    T.$("btnApplyKeys").addEventListener("click", () => {
      let data = null;
      try { data = JSON.parse(T.$("pasteKeys").value); } catch (_) { return notice("That isn't valid JSON.", "err"); }
      applyAndDecrypt(Array.isArray(data) ? data : data.results || [], "Pasted keys");
    });
  };
})();
