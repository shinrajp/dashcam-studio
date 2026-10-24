// Installable offline PWA: loads the app from a tiny local server under /dashcam-studio/ (the GitHub Pages sub-path), then goes offline.
// Checks: manifest + icons valid, service worker installs with a relative scope, core cache holds the app shell, the extra pack (models, wasm, OCR)
// fills, an OFFLINE reload still boots the app (TDC up, help card opens), a model file is served from the cache while offline, no video/footage is
// cached. (No service worker on plain-http LAN pages is checked in test/decrypt-slow.js.)
// Chromium only (Playwright's WebKit has no offline service worker support); the code itself is plain Service Worker API, which iOS Safari 11.3+ supports.
// Usage: node test/pwa-offline.js     (PW_SLOW=1 skips the extra-pack wait)
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, ".."), PREFIX = "/dashcam-studio/";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".onnx": "application/octet-stream" };
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 500) : "")); if (!c) fails++; };
(async () => {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]); hits.push(u);
    if (!u.startsWith(PREFIX)) { res.writeHead(404); return res.end(); }
    let f = path.join(ROOT, u.slice(PREFIX.length) || "index.html"); if (u.endsWith("/")) f = path.join(f, "index.html");
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(f).pipe(res);
  }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}${PREFIX}`;
  const pw = require("playwright");
  const b = await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const ctx = await b.newContext({ viewport: { width: 430, height: 900 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(base + "index.html?sw=1", { waitUntil: "load" });
  await p.waitForFunction(() => TDC.pwa && TDC.pwa.state === "ready", null, { timeout: 30000 }).catch(() => {});
  const st = await p.evaluate(async () => ({ state: TDC.pwa.state, err: TDC.pwa.error, scope: (await navigator.serviceWorker.getRegistration()).scope, ctl: !!navigator.serviceWorker.controller }));
  ok("service worker installed and active, scope is the sub-path", st.state === "ready" && st.scope.endsWith(PREFIX), st);
  // manifest
  const man = await p.evaluate(async () => { const l = document.querySelector('link[rel=manifest]'); const r = await fetch(l.href); const m = await r.json(); const icons = []; for (const i of m.icons) { const x = await fetch(new URL(i.src, l.href)); icons.push({ src: i.src, sizes: i.sizes, ok: x.ok, type: x.headers.get("content-type") }); } return { m, icons, apple: [...document.querySelectorAll('link[rel=apple-touch-icon]')].map((a) => a.getAttribute("href")), meta: [...document.querySelectorAll('meta[name^=apple-mobile-web-app]')].map((a) => a.name) }; });
  ok("manifest: name, standalone, relative start_url and scope", /Dashcam Studio/.test(man.m.name) && man.m.display === "standalone" && !/^\/|^https?:/.test(man.m.start_url) && !/^\/|^https?:/.test(man.m.scope), man.m);
  ok("manifest icons load as PNG (192 and 512 present)", man.icons.every((i) => i.ok && /png/.test(i.type)) && man.icons.some((i) => /192/.test(i.sizes)) && man.icons.some((i) => /512/.test(i.sizes)), man.icons);
  ok("apple-touch-icon and apple-mobile-web-app meta tags", man.apple.length >= 1 && man.meta.includes("apple-mobile-web-app-capable"), { apple: man.apple, meta: man.meta });
  // core cache
  const core = await p.evaluate(async () => { const names = await caches.keys(); const core = names.find((n) => /^dcs-core-/.test(n)); const keys = core ? (await (await caches.open(core)).keys()).map((r) => new URL(r.url).pathname) : []; return { names, n: keys.length, keys }; });
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, "precache.json"), "utf8"));
  ok("core cache holds the whole app shell (every file in precache.json core)", core.n === list.core.length && core.keys.includes(PREFIX + "index.html") && core.keys.includes(PREFIX + "js/crypto.js") && core.keys.includes(PREFIX + "js/crypto-worker.js"), { n: core.n, want: list.core.length });
  const ver = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8").match(/const VER = "([^"]+)"/)[1];
  ok("core cache name carries the asset version", core.names.includes("dcs-core-" + ver), core.names);
  // extra pack
  if (!process.env.PW_SLOW) {
    await p.evaluate(() => navigator.serviceWorker.ready.then((r) => r.active.postMessage({ type: "FILL_EXTRA" })));
    await p.waitForFunction((n) => TDC.pwa.extraTotal && TDC.pwa.extraHave >= n, list.extra.length, { timeout: 120000 }).catch(() => {});
  }
  const ex = await p.evaluate(() => ({ have: TDC.pwa.extraHave, total: TDC.pwa.extraTotal }));
  ok("extra pack (models, ORT wasm, OCR) fully cached", process.env.PW_SLOW ? true : ex.have === list.extra.length && ex.total === list.extra.length, ex);
  // no footage ever cached
  const vids = await p.evaluate(async () => { const out = []; for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) if (/\.(mp4|mov|m4v|webm)(\?|$)/i.test(r.url)) out.push(r.url); return out; });
  ok("no video files in any cache", vids.length === 0, vids);
  // offline
  await ctx.setOffline(true); hits.length = 0;
  await p.reload({ waitUntil: "load" }); await W(800);
  const off = await p.evaluate(async () => ({ tdc: !!window.TDC && !!TDC.library && !!TDC.crypto, title: document.title, ctl: !!navigator.serviceWorker.controller, online: navigator.onLine, grid: !!document.querySelector("#grid, .grid, main") }));
  ok("OFFLINE reload boots the app (TDC up, served by the service worker)", off.tdc && off.ctl, off);
  ok("offline reload made no request that reached the server", hits.length === 0, hits.slice(0, 5));
  await p.evaluate(() => TDC.pwa.openHelp()); await W(100);
  const help = await p.evaluate(() => { const m = document.getElementById("pwaModal"); return { open: !m.hidden, t: m.textContent }; });
  ok("offline: help card opens with iPhone steps and the https address", help.open && /Add to Home Screen/i.test(help.t) && /shinrajp\.github\.io\/dashcam-studio/.test(help.t), help.t.slice(0, 200));
  if (!process.env.PW_SLOW) {
    const m = await p.evaluate(async () => { const r = await fetch("models/yolo11n.onnx"); const b = await r.arrayBuffer(); return { ok: r.ok, n: b.byteLength }; });
    ok("offline: a model file is served from the cache", m.ok && m.n > 1e6, m);
    const w = await p.evaluate(async () => { const r = await fetch("vendor/ort/ort-wasm-simd-threaded.wasm"); return { ok: r.ok, n: (await r.arrayBuffer()).byteLength }; });
    ok("offline: the ONNX Runtime wasm is served from the cache", w.ok && w.n > 1e6, w);
  }
  const fn = await p.evaluate(async () => { try { const a = await TDC.crypto.decryptFile ? true : false; return a; } catch (_) { return false; } });
  ok("offline: crypto module present", fn === true);
  await ctx.setOffline(false);
  // an uncached, never-seen path must fall through to the network (404 here) rather than be answered by the shell
  const nf = await p.evaluate(async () => (await fetch("nope-" + Date.now() + ".js")).status);
  ok("unknown paths are not answered from the cache (404 from the server)", nf === 404, nf);
  ok("no page errors", errs.length === 0, errs);
  await b.close(); srv.close();
  console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("ERR", e); process.exit(2); });
