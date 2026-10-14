// ==UserScript==
// @name         Tesla Grid Player Connector
// @namespace    tesla-dashcam-grid
// @version      1.4.3
// @description  One-click key fetch for Tesla Dashcam Studio (and the earlier Grid Player). Runs on dashcam.tesla.com ONLY when that tab was opened by the player's “Unlock with Tesla” button; fetches decryption keys from Tesla's own endpoint and hands them back to the player window.
// @match        https://dashcam.tesla.com/*
// @run-at       document-idle
// @inject-into  auto
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Tesla Dashcam Studio — connector (protocol-compatible with the earlier Tesla Grid Player; same @name/@namespace
 * so Userscripts/Tampermonkey update the old copy instead of installing a second one).
 *
 * How it works
 *  1. The Grid Player opens  https://dashcam.tesla.com/#gridplayer=<nonce>&gpo=<player origin>  in a popup.
 *     Without that marker (or without window.opener) this script does nothing at all.
 *  2. Handshake: we post {type:"tesla-dashcam-hello", nonce} to window.opener; the player answers with
 *     {type:"tesla-dashcam-items", nonce, items} — the key requests for the clips you dropped.
 *     We only accept the answer from window.opener, with the same nonce, from an allowed player origin
 *     (the browser fills in event.origin, so it can't be faked).
 *  3. Once you are signed in, we try to read Tesla's access token from this page.
 *     If automatic detection fails (current Tesla site), a banner button lets you paste the Bearer token
 *     from the Network tab.
 *  4. We POST the items to /api/1/decrypt/batch on dashcam.tesla.com itself.
 *  5. The key results go back to the player (and the token, for players on localhost only). Then this window closes.
 * Nothing is sent anywhere except Tesla's own endpoint on this origin and the Grid Player window that opened us.
 */
(function () {
  "use strict";
  // ES2018-only syntax; everything wrapped so a failure shows a red badge instead of dying silently.
  var LOG = "[DashcamStudio]";
  function errorBadge(msg) {
    try {
      var put = function () {
        if (!document.body) return setTimeout(put, 200);
        var b = document.getElementById("tdc-connector-error") || document.createElement("div");
        b.id = "tdc-connector-error";
        b.style.cssText = "position:fixed;z-index:2147483647;left:12px;bottom:40px;max-width:420px;padding:4px 8px;border-radius:6px;font:600 11px -apple-system,system-ui,sans-serif;color:#fff;background:#b91c1c";
        b.textContent = "Dashcam Studio connector error: " + msg;
        if (!document.body.contains(b)) document.body.appendChild(b);
      };
      put();
    } catch (_) {}
  }
  // Version guard: if a newer copy of the connector already claimed this page, this (older) copy steps aside.
  var MY_VERSION = "1.4.3";
  var cmp = function (a, b) { var x = String(a).split("."), y = String(b).split("."); for (var i = 0; i < 3; i++) { var d = (+x[i] || 0) - (+y[i] || 0); if (d) return d; } return 0; };
  try {
    var claimed = document.documentElement && document.documentElement.getAttribute("data-tdc-connector");
    if (claimed && cmp(claimed, MY_VERSION) >= 0) { console.info(LOG, "connector", claimed, "already active; skipping duplicate", MY_VERSION); return; }
    if (document.documentElement) document.documentElement.setAttribute("data-tdc-connector", MY_VERSION);
  } catch (_) {}
  console.info(LOG, "connector", MY_VERSION, "starting on", location.href.split("#")[0]);
  try { (function main() {
  "use strict";

  // Player origins allowed to receive keys without asking. Add your own, e.g. "http://my-nas.local:8080".
  const LOCAL_PLAYER_ORIGINS = [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/, /^http:\/\/\[::1\](:\d+)?$/];
  const ALLOWED_PLAYER_ORIGINS = LOCAL_PLAYER_ORIGINS.concat([/^https:\/\/shinrajp\.github\.io$/]); // + hosted Dashcam Studio (GitHub Pages)
  const HELLO = "tesla-dashcam-hello", ITEMS = "tesla-dashcam-items", STATUS = "tesla-dashcam-status";
  const KEYS = "tesla-dashcam-keys", KEYS_ERROR = "tesla-dashcam-keys-error", TOKEN = "tesla-dashcam-token";
  const STORE = "teslaGridPlayerConnector";   // sessionStorage: survives the sign-in redirects inside this tab
  const MANUAL_TOKEN_KEY = "manualTeslaToken";
  const SIGNIN_TIMEOUT_MS = 5 * 60 * 1000;
  const VERSION = "1.4.3";

  if (location.origin !== "https://dashcam.tesla.com" || window.top !== window) return;

  // Always show a small badge so you can tell the connector is installed and running on this page.
  var badgeText = "";
  var badgeObs = null;
  function badge(text) {
    badgeText = "Dashcam Studio connector v" + VERSION + " active" + (text ? " · " + text : "");
    try {
      if (!document.body) { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { badge(text); }, { once: true }); else setTimeout(function () { badge(text); }, 200); return; }
      var b = document.getElementById("tdc-connector-badge");
      if (!b) {
        b = document.createElement("div"); b.id = "tdc-connector-badge";
        b.setAttribute("style", "position:fixed;z-index:2147483647;left:12px;bottom:12px;padding:4px 8px;border-radius:6px;font:600 11px -apple-system,system-ui,sans-serif;color:#fff;background:#3E6AE1;opacity:.92;pointer-events:none");
      }
      b.textContent = badgeText;
      if (!document.body.contains(b)) document.body.appendChild(b);
      // Tesla's single-page app may re-render <body>; put the badge back when that happens.
      if (!badgeObs && window.MutationObserver) {
        badgeObs = new MutationObserver(function () { if (!document.getElementById("tdc-connector-badge") && document.body) { var n = b; n.textContent = badgeText; document.body.appendChild(n); } });
        badgeObs.observe(document.documentElement, { childList: true, subtree: true });
      }
    } catch (e) { console.warn("[DashcamStudio] badge failed", e); }
  }


  // ── 1. Marker: from the URL hash (first load) or this tab's sessionStorage (after sign-in redirects) ──
  let job = null;
  const m = /[#&]gridplayer=([0-9a-f]{16,64})(?:&gpo=([^&]*))?/i.exec(location.hash);
  if (m) {
    job = { nonce: m[1], gpo: decodeURIComponent(m[2] || "*"), ts: Date.now() };
    try { sessionStorage.setItem(STORE, JSON.stringify(job)); } catch (_) {}
    // Safari/Userscripts: the opener link may be missing or unusable from the script's world, so the player also
    // puts the key requests (no secrets: VIN, key ids, wrapped keys) in the URL hash. Never sent to Tesla's server.
    try {
      const g = /[#&]gpi=([A-Za-z0-9_-]+)/.exec(location.hash);
      if (g) {
        const b64 = g[1].replace(/-/g, "+").replace(/_/g, "/");
        const j = JSON.parse(decodeURIComponent(escape(atob(b64))));
        if (j && Array.isArray(j.items)) sessionStorage.setItem(STORE + ".items", JSON.stringify({ nonce: job.nonce, items: j.items.slice(0, 5000), batches: Array.isArray(j.batches) ? j.batches : null, origin: null, fromHash: true }));
      }
    } catch (_) {}
    // Remove the marker from the address bar so Tesla's app routing isn't confused.
    try { history.replaceState(history.state, "", location.pathname + location.search); } catch (_) {}
  } else {
    try { job = JSON.parse(sessionStorage.getItem(STORE) || "null"); } catch (_) { job = null; }
    if (job && !(Date.now() - job.ts < 15 * 60 * 1000)) job = null;
  }
  if (!job) { badge("not linked — open it from Dashcam Studio's Sign in with Tesla"); setInterval(() => badge("not linked — open it from Dashcam Studio's Sign in with Tesla"), 3000); return; }
  badge(window.opener ? "linked to Dashcam Studio" : "Dashcam Studio window link lost");

  // ── small on-page banner (no alerts) ──
  let banner = null, bannerText = null, bannerBtn = null;
  function show(text, kind, button) {
    if (!banner) {
      banner = document.createElement("div");
      banner.setAttribute("role", "status");
      banner.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:380px;padding:10px 14px;border-radius:10px;" +
        "font:500 13px/1.4 -apple-system,system-ui,sans-serif;color:#f3f4f6;background:#171a21;border:1px solid #3E6AE1;box-shadow:0 8px 24px rgba(0,0,0,.35)";
      const title = document.createElement("div");
      title.textContent = "Tesla Dashcam Connector";
      title.style.cssText = "font-weight:700;font-size:11px;letter-spacing:.04em;text-transform:uppercase;opacity:.7;margin-bottom:3px";
      bannerText = document.createElement("div");
      bannerBtn = document.createElement("button");
      bannerBtn.style.cssText = "margin-top:8px;padding:5px 10px;border-radius:6px;border:0;background:#3E6AE1;color:#fff;font:600 12px -apple-system,system-ui,sans-serif;cursor:pointer";
      banner.append(title, bannerText, bannerBtn);
    }
    if (!document.body.contains(banner)) document.body.appendChild(banner); // SPA re-renders may drop it
    bannerText.textContent = text;
    banner.style.borderColor = kind === "err" ? "#ef4444" : kind === "ok" ? "#3BD16F" : "#3E6AE1";
    bannerBtn.hidden = !button;
    if (button) { bannerBtn.textContent = button.label; bannerBtn.onclick = button.onClick; }
  }

  // ── 2. Handshake ──
  let playerOrigin = null; // verified origin of the player (event.origin of its reply)
  let items = null, batches = null, fromHash = false;
  const opener = window.opener; // may be null if Tesla's sign-in redirects severed the link
  // Items saved earlier in this tab survive the sign-in redirects even if the opener link does not.
  try { const saved = JSON.parse(sessionStorage.getItem(STORE + ".items") || "null"); if (saved && saved.nonce === job.nonce) { items = saved.items; batches = saved.batches || null; playerOrigin = saved.origin; fromHash = !!saved.fromHash; } } catch (_) {}
  if (items && !batches) { batches = []; for (let i = 0; i < items.length; i += 30) batches.push(items.slice(i, i + 30)); }
  // Items from the hash: the origin is only claimed, so keys go back with targetOrigin = that claimed origin
  // (the browser refuses delivery to any other origin) — or by the copy button.
  if (items && !playerOrigin) playerOrigin = job.gpo === "*" ? "null" : job.gpo;
  const helloTarget = job.gpo === "*" || job.gpo === "null" ? "*" : job.gpo; // hello carries no secrets
  function post(msg, target) { try { if (opener && !opener.closed) opener.postMessage(Object.assign({ nonce: job.nonce }, msg), target); } catch (_) {} }

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || typeof d !== "object" || d.type !== ITEMS || d.nonce !== job.nonce || !Array.isArray(d.items)) return;
    // Safari content-script worlds may wrap window objects, so ev.source === opener can be false even for the
    // real opener. The 128-bit nonce plus the browser-filled ev.origin identify the player instead.
    if (ev.source !== opener && !(job.gpo === "*" || job.gpo === "null" || ev.origin === job.gpo)) return;
    if (items && !fromHash) return;
    fromHash = false;
    playerOrigin = ev.origin; // "null" for file:// pages
    items = d.items.slice(0, 5000);
    // Newer players send session-aware batches of ≤30; older ones only send items → split here.
    const MAX = 30;
    if (Array.isArray(d.batches) && d.batches.length && d.batches.every((b) => Array.isArray(b) && b.length <= MAX)) batches = d.batches;
    else { batches = []; for (let i = 0; i < items.length; i += MAX) batches.push(items.slice(i, i + MAX)); }
    try { sessionStorage.setItem(STORE + ".items", JSON.stringify({ nonce: job.nonce, items, batches, origin: playerOrigin })); } catch (_) {}
    badge("linked · " + items.length + " clip(s) to unlock");
  });

  let helloTries = 0;
  const helloTimer = setInterval(() => {
    if (items || ++helloTries > 30) { clearInterval(helloTimer); return; }
    post({ type: HELLO, version: VERSION }, helloTarget);
  }, 1000);
  post({ type: HELLO, version: VERSION }, helloTarget);

  // ── 3. Token picker (automatic + manual fallback) ──
  function pickToken() {
    try {
      const bad = /refresh|id_?token|csrf|xsrf/i;
      const clean = (v) => String(v || "").replace(/^Bearer\s+/i, "").replace(/^"|"$/g, "").trim();
      const fromJson = (v) => { try { const o = JSON.parse(v); if (o && typeof o === "object") for (const k of ["access_token", "accessToken"]) if (typeof o[k] === "string" && o[k].length > 20) return o[k]; } catch (_) {} return null; };
      const ck = document.cookie.split(";").map((s) => s.trim());
      for (const k of ["access_token", "tesla_access_token", "dashcam_token", "token"]) {
        const h = ck.find((x) => x.startsWith(k + "="));
        if (h) { const v = clean(decodeURIComponent(h.slice(k.length + 1))); if (v.length > 20) return v; }
      }
      const stores = [sessionStorage, localStorage];
      const passes = [(k) => /access[_-]?token/i.test(k), (k) => /token|auth/i.test(k)];
      for (const test of passes) for (const st of stores) for (let i = 0; i < st.length; i++) {
        const key = st.key(i);
        if (!key || key === STORE || bad.test(key) || !test(key)) continue;
        const val = st.getItem(key) || "";
        const j = fromJson(val);
        if (j) return clean(j);
        if (val.length > 40 && !/^[\[{]/.test(val.trim())) return clean(val);
      }
      for (const st of stores) for (let i = 0; i < st.length; i++) {
        const key = st.key(i);
        if (!key || key === STORE || bad.test(key)) continue;
        const mm = (st.getItem(key) || "").match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
        if (mm) return mm[0];
      }
    } catch (_) {}

    // Manual fallback (stored from the paste button)
    try {
      const manual = sessionStorage.getItem(MANUAL_TOKEN_KEY);
      if (manual && manual.length > 20) return manual.replace(/^Bearer\s+/i, "").trim();
    } catch (_) {}

    return null;
  }

  // In-page token box (no prompt()/alert(): Safari content scripts may suppress native dialogs).
  function promptManualToken() {
    let box = document.getElementById("tdc-token-box");
    if (!box) {
      box = document.createElement("div"); box.id = "tdc-token-box";
      box.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:150px;width:360px;padding:10px;border-radius:10px;background:#171a21;border:1px solid #3E6AE1;font:13px -apple-system,system-ui,sans-serif;color:#f3f4f6";
      box.innerHTML = '<div style="margin-bottom:6px">Paste the Bearer token (DevTools → Network → /api/1/decrypt/batch → Authorization):</div><textarea rows="3" style="width:100%;font:11px ui-monospace,monospace"></textarea><div style="margin-top:6px;text-align:right"><button type="button" style="padding:5px 10px;border:0;border-radius:6px;background:#3E6AE1;color:#fff;font-weight:600">Use token</button></div><div class="tdc-err" style="color:#ef4444;margin-top:4px"></div>';
      document.body.appendChild(box);
      box.querySelector("button").onclick = () => {
        const token = box.querySelector("textarea").value.replace(/^Authorization:\s*/i, "").replace(/^Bearer\s+/i, "").trim();
        if (token.length < 20) { box.querySelector(".tdc-err").textContent = "That doesn’t look like a valid token (too short)."; return; }
        try { sessionStorage.setItem(MANUAL_TOKEN_KEY, token); } catch (_) {}
        box.remove(); setTimeout(run, 100);
      };
    }
    box.querySelector("textarea").focus();
  }

  function originAllowed(o) { return ALLOWED_PLAYER_ORIGINS.some((re) => re.test(o)); }

  // ── 4. Wait for sign-in, fetch keys on Tesla's origin, send them back ──
  const started = Date.now();
  let busy = false, done = false, warned = false, confirmed = false;
  const tick = setInterval(run, 1000);
  run();

  async function run() {
    if (busy || done) return;
    if (!opener && !items) { stop(); return show("The link to Dashcam Studio was lost during sign-in (the browser cut it) before the clip list arrived. Go back to Dashcam Studio and click Sign in with Tesla again — you're signed in now, so it should work — or use the console helper.", "err"); }
    if (opener && opener.closed) { stop(); return show("The Grid Player window was closed.", "err"); }
    if (!items && helloTries > 30) { stop(); return show("The Grid Player didn't answer. Close this window and click “Unlock with Tesla” again.", "err"); }
    if (!items) return show("Connecting to the dashcam player…");
    // Where may keys go? http(s) players must be on the allow-list; file:// players (origin "null") need one click.
    if (playerOrigin !== "null" && !originAllowed(playerOrigin)) {
      stop();
      post({ type: KEYS_ERROR, error: "Connector refused: player origin " + playerOrigin + " is not in ALLOWED_PLAYER_ORIGINS" }, playerOrigin);
      return show("Refused to send keys to " + playerOrigin + " (not an allowed player origin — edit ALLOWED_PLAYER_ORIGINS in the script).", "err");
    }
    const token = pickToken();
    if (!token) {
      post({ type: STATUS, state: "waiting-signin" }, target());
      if (Date.now() - started > SIGNIN_TIMEOUT_MS) {
        stop();
        post({ type: KEYS_ERROR, error: "No Tesla access token found on dashcam.tesla.com (signed in?)" }, target());
        return show("Couldn't find a Tesla access token. Click the button and paste the one from the Network tab.", "err", {
          label: "Paste token from Network tab",
          onClick: promptManualToken
        });
      }
      if (Date.now() - started > 60000) warned = true;
      return show(warned
        ? "Still no Tesla session found. Click the button to paste a token from the Network tab."
        : "Sign in to your Tesla account here — or paste a token if you're already signed in.",
        "", {
          label: "Paste token from Network tab",
          onClick: promptManualToken
        });
    }
    if (playerOrigin === "null" && !confirmed) {
      // A local-file player can't be told apart from other "null"-origin pages, so ask once.
      return show("Send the keys for " + items.length + " clip(s) to the dashcam player opened from a local file?", "", {
        label: "Send keys to the dashcam player", onClick: () => { confirmed = true; run(); },
      });
    }
    busy = true;
    try {
      show("Fetching keys for " + items.length + " clip(s)…");
      post({ type: STATUS, state: "fetching" }, target());
      const results = [], errs = [];
      for (let i = 0; i < batches.length; i++) {
        show("Fetching keys: batch " + (i + 1) + " of " + batches.length + " (" + batches[i].length + " clips)…");
        try {
          const r = await fetch("/api/1/decrypt/batch", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
            body: JSON.stringify({ items: batches[i] }),
          });
          const txt = await r.text();
          let data = null;
          try { data = JSON.parse(txt); } catch (_) {}
          if (!r.ok || !data) { errs.push("batch " + (i + 1) + ": HTTP " + r.status + (data && data.error ? " " + data.error : txt ? " " + txt.slice(0, 120) : "")); continue; }
          results.push(...(Array.isArray(data) ? data : data.results || []));
        } catch (e) { errs.push("batch " + (i + 1) + ": " + String((e && e.message) || e)); }
      }
      if (!results.length) {
        const err = errs.join("; ") || "no keys returned";
        stop();
        post({ type: KEYS_ERROR, error: err }, target());
        return show("Tesla refused the key request (" + err + ").", "err");
      }
      if (errs.length) post({ type: STATUS, state: "partial", errors: errs }, target());
      if (!opener || opener.closed) {
        stop();
        const clean = JSON.stringify({ results });
        const copyKeys = async () => {
          try { await navigator.clipboard.writeText(clean); show("✓ Keys copied. Switch back to Dashcam Studio — it applies keys from the clipboard when you return (or paste them into Paste keys).", "ok"); }
          catch (_) { show("Copy failed. Use the console helper instead.", "err"); }
        };
        return show("Keys fetched, but the link back to Dashcam Studio was lost (the sign-in redirect cut it). Click to copy the keys, then return to Dashcam Studio.", "", { label: "Copy keys for Dashcam Studio", onClick: copyKeys });
      }
      post({ type: KEYS, results }, target());
      // The Tesla session token only goes to players on this computer (the companion helper's sign-in page) —
      // never to an unverifiable file:// page or a hosted website; those only need the per-clip keys.
      if (LOCAL_PLAYER_ORIGINS.some((re) => re.test(playerOrigin))) post({ type: TOKEN, token }, playerOrigin);
      stop();
      const clean2 = JSON.stringify({ results });
      show("✓ Keys sent to Dashcam Studio. If it didn't unlock, copy them and switch back — it applies keys from the clipboard.", "ok", {
        label: "Copy keys for Dashcam Studio",
        onClick: async () => { try { await navigator.clipboard.writeText(clean2); show("✓ Keys copied. Switch back to Dashcam Studio (or paste into Paste keys).", "ok"); } catch (_) { show("Copy failed — use the console helper.", "err"); } },
      });
    } catch (e) {
      stop();
      post({ type: KEYS_ERROR, error: String((e && e.message) || e) }, target());
      show("Key request failed: " + String((e && e.message) || e), "err");
    } finally {
      busy = false;
    }
  }
  function target() { return playerOrigin === "null" ? "*" : playerOrigin; }
  function stop() { done = true; clearInterval(tick); clearInterval(helloTimer); try { sessionStorage.removeItem(STORE); sessionStorage.removeItem(STORE + ".items"); } catch (_) {} }
  })(); } catch (e) {
    console.error(LOG, "connector crashed", e);
    errorBadge(String((e && e.message) || e));
  }
  window.addEventListener("unhandledrejection", function (ev) { var m = String((ev.reason && ev.reason.message) || ev.reason || ""); if (/tdc|dashcam/i.test(m)) errorBadge(m); });
})();
