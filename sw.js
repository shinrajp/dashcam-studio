/* sw.js — offline support for Dashcam Studio. Registered by js/pwa.js as plain sw.js (the version is the VER line below), relative scope (works at
 * /dashcam-studio/ on GitHub Pages and from any folder). Never registered on plain-http LAN pages (not a secure context).
 *   core cache  "dcs-core-<version>"  app shell, every script and style, small vendor files (must all arrive or the install fails;
 *                                      the old version keeps running). Replaced as a whole when the version changes.
 *   extra cache "dcs-extra-1"          models, ONNX Runtime wasm and OCR pack, fetched in the background after the first visit,
 *                                      any single failure is ignored; also holds other same-origin static files seen at run time.
 * Cache-first. Updates: a new version installs in the background and waits; the page offers "Reload" (js/pwa.js) and only then
 * does it take over (message SKIP_WAITING). Never cached: user footage (it is read from the device as File/Blob and is never
 * fetched), Range requests, video responses, other origins, /api/ calls, non-GET. */
"use strict";
const VER = "occluded-people";   // rewritten by tools/gen-precache.py (via tools/bump-asset-version.py); a changed byte here is what makes browsers install a new worker
const CORE = "dcs-core-" + VER, EXTRA = "dcs-extra-1";
const url = (p) => new URL(p, self.registration.scope).href;

async function loadList() {
  const r = await fetch(url("precache.json?v=" + encodeURIComponent(VER)), { cache: "no-store" });
  if (!r.ok) throw new Error("precache.json " + r.status);
  return r.json();
}
async function putFresh(cache, path) {
  const res = await fetch(new Request(url(path), { cache: "reload" }));
  if (!res.ok || res.status !== 200 || res.type === "opaque") throw new Error(path + " " + res.status);
  await cache.put(url(path), res);
}

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const list = await loadList(), cache = await caches.open(CORE);
    // a few at a time, so a phone on a slow link is not flooded
    const q = list.core.slice();
    await Promise.all(Array.from({ length: 6 }, async () => { while (q.length) await putFresh(cache, q.shift()); }));
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("dcs-core-") && k !== CORE) await caches.delete(k);
    await self.clients.claim();
  })());
});

let extraBusy = null;
async function fillExtra(notify) {
  if (extraBusy) return extraBusy;
  extraBusy = (async () => {
    let list; try { list = await loadList(); } catch (_) { return; }
    const cache = await caches.open(EXTRA), todo = [];
    for (const p of list.extra) if (!(await cache.match(url(p)))) todo.push(p);
    const total = list.extra.length; let have = total - todo.length;
    notify({ type: "EXTRA", have, total });
    for (const p of todo) {
      try { await putFresh(cache, p); have++; } catch (_) { /* offline or missing: try again next visit */ }
      notify({ type: "EXTRA", have, total });
    }
  })().finally(() => { extraBusy = null; });
  return extraBusy;
}
const tell = async (msg) => { for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage(msg); };

self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type === "SKIP_WAITING") self.skipWaiting();
  else if (d.type === "FILL_EXTRA") e.waitUntil(fillExtra(tell));
  else if (d.type === "STATUS") e.waitUntil((async () => {
    let list = null; try { list = await loadList(); } catch (_) {}
    const cache = await caches.open(EXTRA); let have = 0;
    if (list) for (const p of list.extra) if (await cache.match(url(p))) have++;
    if (e.source) e.source.postMessage({ type: "STATUS", version: VER, extraHave: have, extraTotal: list ? list.extra.length : 0, core: (await caches.has(CORE)) });
  })());
});

const SKIP = /\.(mp4|mov|m4v|webm)$/i;
self.addEventListener("fetch", (e) => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET" || u.origin !== self.location.origin || !u.href.startsWith(self.registration.scope)) return;
  if (req.headers.has("range") || SKIP.test(u.pathname) || /\/api\//.test(u.pathname)) return;
  e.respondWith((async () => {
    if (req.mode === "navigate") {
      const hit = await caches.match(url("index.html"), { ignoreSearch: true });
      if (hit) return hit;
      return fetch(req);
    }
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.status === 200 && res.type === "basic" && !/^(video|audio)\//.test(res.headers.get("content-type") || "")) {
      try { (await caches.open(EXTRA)).put(new Request(u.origin + u.pathname), res.clone()); } catch (_) {}
    }
    return res;
  })());
});
