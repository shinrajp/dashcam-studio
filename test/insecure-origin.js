// Insecure-context check (http://<LAN IP>, like a phone loading the app from the Mac): `caches` and
// navigator.clipboard are undefined there. Find must still start (model from network, no cache), Redact must
// work, and the copy buttons must fall back. Usage: node test/insecure-origin.js http://<non-localhost-ip>:PORT/index.html
const puppeteer = require("puppeteer-core"); const fs = require("fs"), path = require("path");
const URL_ = process.argv[2]; if (!URL_ || /localhost|127\.0\.0\.1/.test(URL_)) { console.error("give a non-localhost http URL"); process.exit(2); }
const FIX = process.env.FIXTURES || "/workspace/fixtures";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); fs.statSync(q).isDirectory() ? w(q) : (/\.(mp4|json)$/.test(f) && f !== "base.mp4" && files.push(q)); } })(FIX);
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x) : "")); if (!c) fails++; };
(async () => {
  const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"], userDataDir: "/tmp/tdc-insec-" + Date.now() });
  const p = await b.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(URL_, { waitUntil: "load" });
  const ctx = await p.evaluate(() => ({ secure: window.isSecureContext, caches: typeof caches, clipboard: typeof navigator.clipboard }));
  ok("origin is insecure (caches + clipboard undefined)", ctx.secure === false && ctx.caches === "undefined" && ctx.clipboard === "undefined", ctx);
  ok("cache probe reports unavailable", (await p.evaluate(() => TDC.search.cacheAvailable())) === false);
  await (await p.$("#fileInput")).uploadFile(...files);
  for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
  await p.evaluate(() => { const e = TDC.library.events.find((x) => !x.locked && x.cams.includes("front")); return TDC.ui.activate(e); }); await W(1200);
  // Find
  const notes = new Set();
  await p.evaluate(() => { document.getElementById("findCam").value = "front"; document.getElementById("findQuery").value = "a car on the road"; TDC.search.run(); });
  for (let i = 0; i < 600; i++) { await W(1000); const st = await p.evaluate(() => [TDC.search.running, document.getElementById("findStatus").textContent]); notes.add(st[1]); if (!st[0] && i > 1) break; }
  const fin = await p.evaluate(() => ({ hits: TDC.search.hits.length, status: document.getElementById("findStatus").textContent, cacheOk: TDC.search.cacheOk }));
  ok("Find initializes and returns matches without a cache", fin.hits > 0 && !/could not start/i.test(fin.status) && fin.cacheOk === false, fin);
  ok("status explains the missing cache", [...notes].some((n) => /Model cache unavailable on this connection \(not https\)|No model cache on this connection/.test(n)));
  // Redact (vendored OCR, no cache)
  await p.evaluate(() => TDC.redact.run("blur all text"));
  for (let i = 0; i < 300 && (await p.evaluate(() => TDC.redact.running)); i++) await W(1000);
  const rs = await p.evaluate(() => document.getElementById("redactStatus").textContent);
  ok("Redact runs on an insecure origin", !/could not start/i.test(rs), rs.slice(0, 140));
  // copy fallback
  await p.evaluate(() => { document.getElementById("unlockModal").hidden = false; });
  const copied = await p.evaluate(async () => { try { await TDC.auth.copyText("hello"); return "ok"; } catch (e) { return e.message; } });
  ok("copy works without navigator.clipboard (execCommand fallback)", copied === "ok", copied);
  ok("error messages: cache vs network are told apart", await p.evaluate(() => /blocked storage/.test(TDC.search.explain(new Error("Browser cache is not available in this environment."))) && /needs internet/.test(TDC.search.explain(new TypeError("Failed to fetch")))));
  ok("no page errors", !errs.length, errs);
  await b.close(); console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
