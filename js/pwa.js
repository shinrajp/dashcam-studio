/* pwa.js — slow-mode note (no Web Crypto = plain http), "Install / use offline" help card, service worker registration.
 * The service worker (sw.js) is registered only on a secure context (https or localhost), never on http://LAN-address pages,
 * and not in automated browsers unless the URL has ?sw=1. Escape hatch for development: ?nosw=1 (also unregisters). */
(function () {
  "use strict";
  const T = window.TDC, $ = (id) => document.getElementById(id);
  const VER = (() => { try { return new URL(document.currentScript.src).searchParams.get("v") || ""; } catch (_) { return ""; } })();
  const q = new URLSearchParams(location.search);
  const P = (T.pwa = { version: VER, state: "off", extraHave: 0, extraTotal: 0 });
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} } };

  // ── slow mode note ──
  const secure = window.isSecureContext !== false;
  P.slow = !T.crypto.fast;
  function showSlow() {
    const n = $("slowNote"); if (!n) return;
    if (!P.slow || store.get("tdc.slowNote.v1") === "1") return;
    n.hidden = false;
    $("slowNoteX").onclick = () => { n.hidden = true; store.set("tdc.slowNote.v1", "1"); };
    $("slowNoteHow").onclick = () => P.openHelp();
  }

  // ── help card ──
  function statusLine() {
    const parts = [];
    parts.push(T.crypto.fast ? "Fast decrypting: on (browser crypto available)." : "Fast decrypting: off, this page is " + (secure ? "missing browser crypto" : "plain http") + ", so decrypting is slower.");
    if (P.state === "ready") parts.push(P.extraTotal && P.extraHave < P.extraTotal ? `Offline: app is saved; models ${P.extraHave} of ${P.extraTotal} downloaded.` : "Offline: ready, works with no connection.");
    else if (P.state === "installing") parts.push("Offline: saving the app…");
    else parts.push(secure ? "Offline: not installed yet (open this page once while online)." : "Offline: needs the https address (see below).");
    return parts.join(" ");
  }
  P.openHelp = () => { const m = $("pwaModal"); if (!m) return; $("pwaStatus").textContent = statusLine(); m.hidden = false; };
  if ($("linkPwa")) $("linkPwa").onclick = (e) => { e.preventDefault(); P.openHelp(); };
  T.on("pwa", () => { const m = $("pwaModal"); if (m && !m.hidden) $("pwaStatus").textContent = statusLine(); });

  // ── service worker ──
  const auto = !!navigator.webdriver && q.get("sw") !== "1";
  const host = location.hostname, local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  async function register() {
    if (!("serviceWorker" in navigator)) { P.state = "unsupported"; return; }
    if (q.get("nosw") === "1") { try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); for (const k of await caches.keys()) if (/^dcs-/.test(k)) await caches.delete(k); } catch (_) {} P.state = "off"; return; }
    if (!(window.isSecureContext || local) || auto) { P.state = "off"; return; }
    try {
      P.state = "installing"; T.emit("pwa");
      const reg = await navigator.serviceWorker.register("sw.js", { scope: "./" });
      P.reg = reg;
      const watch = (w) => w && w.addEventListener("statechange", () => {
        if (w.state === "installed" && navigator.serviceWorker.controller) offerUpdate(w);   // an older version is running: wait for the user
        if (w.state === "activated") { P.state = "ready"; T.emit("pwa"); }
      });
      watch(reg.installing);
      reg.addEventListener("updatefound", () => watch(reg.installing));
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      navigator.serviceWorker.addEventListener("message", (e) => { const d = e.data || {}; if (d.type === "EXTRA") { P.extraHave = d.have; P.extraTotal = d.total; T.emit("pwa"); } else if (d.type === "STATUS") { P.extraHave = d.extraHave; P.extraTotal = d.extraTotal; T.emit("pwa"); } });
      // the page itself may come from the offline cache, so ask the network whether a newer worker exists
      const check = () => { try { reg.update().catch(() => {}); } catch (_) {} };
      check(); document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
      const ready = await navigator.serviceWorker.ready;
      P.state = "ready"; T.emit("pwa");
      // after the page has settled, let the worker fetch models in the background (once online; retried on later visits)
      const go = () => { try { (ready.active || reg.active).postMessage({ type: "FILL_EXTRA" }); (ready.active || reg.active).postMessage({ type: "STATUS" }); } catch (_) {} };
      if (document.readyState === "complete") setTimeout(go, 4000); else window.addEventListener("load", () => setTimeout(go, 4000));
    } catch (e) { P.state = "error"; P.error = String((e && e.message) || e); console.warn("service worker not registered", e); T.emit("pwa"); }
  }
  let reloading = false;
  function offerUpdate(w) {
    const n = $("updNote"); if (!n) return;
    n.hidden = false;
    $("updX").onclick = () => { n.hidden = true; };
    $("updGo").onclick = () => { reloading = true; try { w.postMessage({ type: "SKIP_WAITING" }); } catch (_) { location.reload(); } };
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("controllerchange", () => { if (reloading) location.reload(); });

  showSlow();
  register();
})();
