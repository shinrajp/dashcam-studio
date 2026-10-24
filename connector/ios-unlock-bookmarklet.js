/* ios-unlock-bookmarklet.js — "Dashcam Unlock" bookmarklet for iPhone / iPad Safari (no extension needed).
 * SOURCE file: tools/build-bookmarklet.js minifies it into js/ios-unlock-src.js (TDC.IOS_BOOKMARKLET), which the
 * player's "Copy bookmarklet" button hands out. Self-contained (Tesla's CSP blocks outside scripts), ES2018.
 *
 * Tap it on dashcam.tesla.com (signed in). It
 *  1. reads the clip key requests from the page address (#gridplayer=<nonce>&gpo=<player origin>&gpi=<requests>,
 *     put there by Dashcam Studio's "Sign in with Tesla"), or from this tab's sessionStorage (saved by an earlier
 *     tap), or from the clipboard ("Copy unlock request" in Dashcam Studio → "Paste unlock request" button here);
 *  2. POSTs them to Tesla's own /api/1/decrypt/batch on this origin (same as the userscript connector);
 *  3. sends ONLY the per-clip keys back: postMessage to the Dashcam Studio tab that opened this one, pinned to its
 *     origin and only if that origin is the hosted app, localhost or a home-network address; and always offers a
 *     "Copy keys" button (keys JSON for "Paste keys from clipboard").
 * The Tesla session token is never posted, copied or shown. Request lists are not secret (VIN, key ids, wrapped keys). */
(function () {
  var W = window, D = document, N = navigator, SS = W.sessionStorage, SK = "tdcIosUnlockReq", keysJson = "";
  if (W.__tdcIosBusy) return;
  var box = D.getElementById("tdc-ios-unlock"), msg = D.createElement("p"), btn = D.createElement("button"), x = D.createElement("button");
  if (box) box.remove();
  box = D.createElement("div");
  box.id = "tdc-ios-unlock";
  box.style.cssText = "position:fixed;z-index:2147483647;left:8px;right:8px;bottom:8px;padding:12px;border-radius:14px;background:#222;color:#fff;font:16px system-ui;border:3px solid";
  x.textContent = "\u2715";
  x.style.cssText = "float:right;font-size:20px";
  x.onclick = function () { box.remove(); };
  btn.style.cssText = "width:90vw;min-height:50px;border-radius:10px;font:600 17px system-ui";
  box.append(x, msg, btn);
  D.body.appendChild(box);

  // kind: 0 info (blue), 1 error (red), 2 done (green)
  function say(text, kind, label, fn) {
    msg.textContent = "Dashcam Unlock: " + text;
    box.style.borderColor = ["#36f", "#e33", "#3c6"][kind];
    btn.hidden = !label;
    btn.textContent = label;
    btn.onclick = fn;
  }

  // Unlock request in a URL / clipboard text: #gridplayer=<nonce>&gpo=<origin>&gpi=<base64url {items,batches}>
  function parse(t) {
    var n = /gridplayer=([0-9a-f]{16,64})/i.exec(t), g = /[\x23&]gpi=([\w-]+)/.exec(t), o = /[\x23&]gpo=([^&\x23\s]*)/.exec(t), j;
    try {
      j = JSON.parse(decodeURIComponent(escape(atob(g[1].replace(/-/g, "+").replace(/_/g, "/")))));
      return j.items.length && { nonce: n[1], gpo: o ? decodeURIComponent(o[1]) : "", items: j.items.slice(0, 5000), batches: j.batches, ts: Date.now() };
    } catch (e) { return null; }
  }
  function save(r) { try { SS.setItem(SK, JSON.stringify(r)); } catch (e) {} }

  // Player origins that may receive keys: the hosted app, localhost, private LAN addresses, *.local.
  function okOrigin(o) {
    var u, h, a;
    try { u = new URL(o); } catch (e) { return false; }
    h = u.hostname; a = h.split(".").map(Number);
    return u.origin == o && /^https?:$/.test(u.protocol) && (o == "https://shinrajp.github.io" || h == "localhost" || h == "[::1]" ||
      (/^[\d.]+$/.test(h) ? a[0] == 10 || a[0] == 127 || (a[0] == 172 && a[1] > 15 && a[1] < 32) || (a[0] == 192 && a[1] == 168)
        : /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+local$/.test(h)));
  }

  // Tesla access token on this page (same search as the connector's pickToken). Only used for the same-origin
  // key request below; never posted, copied or shown.
  function token() {
    var bad = /refresh|id_?token|csrf|xsrf/i, st = [SS, W.localStorage], c = D.cookie.split(/;\s*/), i, p, s, k, v, m;
    var clean = function (z) { return z.replace(/^Bearer\s+/i, "").replace(/^"|"$/g, "").trim(); };
    for (i = 0; i < c.length; i++) {
      m = /^(access_token|tesla_access_token|dashcam_token|token)=(.{21,})/.exec(c[i]);
      if (m) try { return clean(decodeURIComponent(m[2])); } catch (e) {}
    }
    for (p = 0; p < 3; p++) for (s = 0; s < 2; s++) for (i = 0; i < st[s].length; i++) {
      k = st[s].key(i); v = st[s].getItem(k) || "";
      if (k == SK || bad.test(k)) continue;
      if (p > 1) { if ((m = v.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/))) return m[0]; continue; }
      if (!(p ? /token|auth/i : /access[_-]?token/i).test(k)) continue;
      try { m = JSON.parse(v); m = m.access_token || m.accessToken; if (m.length > 20) return clean(m); } catch (e) {}
      if (v.length > 40 && !/^\s*[[{]/.test(v)) return clean(v);
    }
  }

  async function go(r) {
    W.__tdcIosBusy = 1;
    try { await run(r); } catch (e) { say("something went wrong (" + String(e && e.message || e).slice(0, 80) + ").", 1, "Try again", function () { go(r); }); }
    W.__tdcIosBusy = 0;
  }
  async function run(r) {
    var t = token(), h = { "Content-Type": "application/json" }, b = r.batches, res = [], errs = [], i, q, d, sent, op = W.opener,
      again = function () { go(r); };
    if (t) h.Authorization = "Bearer " + t;
    if (!(b && b.length)) for (b = [], i = 0; i < r.items.length; i += 30) b.push(r.items.slice(i, i + 30));
    for (i = 0; i < b.length; i++) {
      say("fetching keys " + (i + 1) + "/" + b.length + "...", 0);
      try {
        q = await fetch("/api/1/decrypt/batch", { method: "POST", credentials: "include", headers: h, body: JSON.stringify({ items: b[i] }) });
        d = await q.json().catch(function () {});
        if (!q.ok || !d) throw "HTTP " + q.status;
        (d.results || d).forEach(function (z) { res.push({ id: z.id, key: z.key, error: z.error, wrapped_key: z.wrapped_key }); });
      } catch (e) { errs.push(e); }
    }
    if (!res.length) return say(!t || /40[13]/.test(errs[0])
      ? "not signed in. Sign in to Tesla in this tab, wait for the dashcam page, then tap the bookmark again."
      : "Tesla sent no keys (" + String(errs[0]).slice(0, 99) + ").", 1, "Try again", again);
    keysJson = JSON.stringify({ results: res });
    if (t && keysJson.indexOf(t) >= 0) return say("stopped, the reply held the sign-in token.", 1);
    try { SS.removeItem(SK); } catch (e) {}
    if (op && !op.closed && okOrigin(r.gpo)) try { op.postMessage({ type: "tesla-dashcam-keys", nonce: r.nonce, results: res }, r.gpo); sent = 1; } catch (e) {}
    say(res.length + " key(s)" + (errs.length ? ", " + errs.length + " batch(es) failed" : "") + (sent ? ", sent to Dashcam Studio" : "") +
      ". Tap Copy keys, go back to Dashcam Studio and tap Paste keys from clipboard.", 2, "Copy keys", copy);
  }

  function copy() {
    N.clipboard.writeText(keysJson).then(function () {
      say("keys copied. Go back to Dashcam Studio and tap Paste keys from clipboard.", 2, "Copy keys again", copy);
    }, function () { say("copy failed, tap again.", 1, "Copy keys", copy); });
  }

  function pasteReq() {
    N.clipboard.readText().then(function (t) { var r = parse(t); r ? (save(r), go(r)) : ask(1); }, function () { ask(1); });
  }
  function ask(e) {
    say((e ? "no unlock request on the clipboard. " : "no clip list here. ") + "In Dashcam Studio tap Copy unlock request, come back and tap below.", e, "Paste unlock request", pasteReq);
  }

  if (location.hostname != "dashcam.tesla.com") return say("use this on dashcam.tesla.com.", 1);
  var r = parse(location.hash), sv;
  if (r) {
    save(r);
    history.replaceState(history.state, "", location.pathname + location.search);
  } else {
    try { sv = JSON.parse(SS.getItem(SK)); if (Date.now() - sv.ts < 36e5) r = sv; } catch (e) {}
  }
  r ? go(r) : ask(0);
})();
