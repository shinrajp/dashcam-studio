// ==UserScript==
// @name         Tesla Grid Player Connector
// @namespace    tesla-dashcam-grid
// @version      1.2.0
// @description  One-click key fetch for Tesla Dashcam Studio (and the earlier Grid Player). Runs on dashcam.tesla.com ONLY when that tab was opened by the player's “Unlock with Tesla” button; fetches decryption keys from Tesla's own endpoint and hands them back to the player window.
// @match        https://dashcam.tesla.com/*
// @run-at       document-idle
// @inject-into  page
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
 *  3. Once you are signed in, we read Tesla's access token from this page (same logic as the player's
 *     Connect bookmarklet) and POST the items to /api/1/decrypt/batch on dashcam.tesla.com itself.
 *  4. The key results go back to the player (and the token, for players on localhost only). Then this window closes.
 * Nothing is sent anywhere except Tesla's own endpoint on this origin and the Grid Player window that opened us.
 */
(function () {
  "use strict";

  // Player origins allowed to receive keys without asking. Add your own, e.g. "http://my-nas.local:8080".
  const LOCAL_PLAYER_ORIGINS = [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/, /^http:\/\/\[::1\](:\d+)?$/];
  const ALLOWED_PLAYER_ORIGINS = LOCAL_PLAYER_ORIGINS.concat([/^https:\/\/shinrajp\.github\.io$/]); // + hosted Dashcam Studio (GitHub Pages)
  const HELLO = "tesla-dashcam-hello", ITEMS = "tesla-dashcam-items", STATUS = "tesla-dashcam-status";
  const KEYS = "tesla-dashcam-keys", KEYS_ERROR = "tesla-dashcam-keys-error", TOKEN = "tesla-dashcam-token";
  const STORE = "teslaGridPlayerConnector";   // sessionStorage: survives the sign-in redirects inside this tab
  const SIGNIN_TIMEOUT_MS = 5 * 60 * 1000;
  const VERSION = "1.2.0";

  // Not opened by another window (e.g. you visited Tesla yourself), not top-level, or not Tesla → do nothing.
  if (location.origin !== "https://dashcam.tesla.com" || window.top !== window || !window.opener) return;

  // ── 1. Marker: from the URL hash (first load) or this tab's sessionStorage (after sign-in redirects) ──
  let job = null;
  const m = /[#&]gridplayer=([0-9a-f]{16,64})(?:&gpo=([^&]*))?/i.exec(location.hash);
  if (m) {
    job = { nonce: m[1], gpo: decodeURIComponent(m[2] || "*"), ts: Date.now() };
    try { sessionStorage.setItem(STORE, JSON.stringify(job)); } catch (_) {}
    // Remove the marker from the address bar so Tesla's app routing isn't confused.
    try { history.replaceState(history.state, "", location.pathname + location.search); } catch (_) {}
  } else {
    try { job = JSON.parse(sessionStorage.getItem(STORE) || "null"); } catch (_) { job = null; }
    if (job && !(Date.now() - job.ts < 15 * 60 * 1000)) job = null;
  }
  if (!job) return; // no player marker → do nothing

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
  const opener = window.opener;
  const helloTarget = job.gpo === "*" || job.gpo === "null" ? "*" : job.gpo; // hello carries no secrets
  let playerOrigin = null; // verified origin of the player (event.origin of its reply)
  let items = null;
  function post(msg, target) { try { if (!opener.closed) opener.postMessage(Object.assign({ nonce: job.nonce }, msg), target); } catch (_) {} }

  window.addEventListener("message", (ev) => {
    if (ev.source !== opener || items) return;
    const d = ev.data;
    if (!d || typeof d !== "object" || d.type !== ITEMS || d.nonce !== job.nonce || !Array.isArray(d.items)) return;
    playerOrigin = ev.origin; // "null" for file:// pages
    items = d.items.slice(0, 500);
  });

  let helloTries = 0;
  const helloTimer = setInterval(() => {
    if (items || ++helloTries > 30) { clearInterval(helloTimer); return; }
    post({ type: HELLO, version: VERSION }, helloTarget);
  }, 1000);
  post({ type: HELLO, version: VERSION }, helloTarget);

  // ── 3. Token picker (same rules as the player's Connect bookmarklet) ──
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
    return null;
  }

  function originAllowed(o) { return ALLOWED_PLAYER_ORIGINS.some((re) => re.test(o)); }

  // ── 4. Wait for sign-in, fetch keys on Tesla's origin, send them back ──
  const started = Date.now();
  let busy = false, done = false, warned = false, confirmed = false;
  const tick = setInterval(run, 1000);
  run();

  async function run() {
    if (busy || done) return;
    if (opener.closed) { stop(); return show("The Grid Player window was closed.", "err"); }
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
        return show("Couldn't find a Tesla access token on this page. Make sure you're signed in (open any clip once), then click “Unlock with Tesla” in the player again.", "err");
      }
      if (Date.now() - started > 60000) warned = true;
      return show(warned
        ? "Still no Tesla session found. If you're already signed in, open any clip on this page — the connector looks for Tesla's access token in this page's cookies/storage."
        : "Sign in to your Tesla account here — keys go to the dashcam player automatically.");
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
      const r = await fetch("/api/1/decrypt/batch", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ items }),
      });
      const txt = await r.text();
      let data = null;
      try { data = JSON.parse(txt); } catch (_) {}
      if (!r.ok || !data) {
        const err = "HTTP " + r.status + (data && data.error ? ": " + data.error : txt ? ": " + txt.slice(0, 200) : "");
        stop();
        post({ type: KEYS_ERROR, error: err }, target());
        return show("Tesla refused the key request (" + err + ").", "err");
      }
      const results = Array.isArray(data) ? data : data.results || [];
      post({ type: KEYS, results }, target());
      // The Tesla session token only goes to players on this computer (the companion helper's sign-in page) —
      // never to an unverifiable file:// page or a hosted website; those only need the per-clip keys.
      if (LOCAL_PLAYER_ORIGINS.some((re) => re.test(playerOrigin))) post({ type: TOKEN, token }, playerOrigin);
      stop();
      show("✓ Keys sent to the dashcam player — you can close this window.", "ok");
      setTimeout(() => { try { window.close(); } catch (_) {} }, 2500);
    } catch (e) {
      stop();
      post({ type: KEYS_ERROR, error: String((e && e.message) || e) }, target());
      show("Key request failed: " + String((e && e.message) || e), "err");
    } finally {
      busy = false;
    }
  }
  function target() { return playerOrigin === "null" ? "*" : playerOrigin; }
  function stop() { done = true; clearInterval(tick); clearInterval(helloTimer); try { sessionStorage.removeItem(STORE); } catch (_) {} }
})();
