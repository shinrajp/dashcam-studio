// worker-fix (tag worker-fix): when the detection worker can't start, the message says why and what to try.
// A tiny node server serves the tree; MODE switches how js/detect-worker.js is answered:
//  ok    – normal: nano loads through the blob worker (how = "blob", no first error)
//  500   – the script answers HTTP 500 for every request (blob fetch AND new Worker(url) fail, bare "error" event without a message):
//          the error text must name the first failure ("HTTP 500"), the diagnostics ("Checked: … HTTP 500"), a test worker that DID start
//          (fetch/IndexedDB/WebAssembly ok) and the "What to try" line
//  html  – a web page (200 text/html) instead of the script (what a proxy interstitial would send): the message names it
//  plates – the plate worker explains itself the same way
// Usage: BR=chromium|webkit node test/worker-fix.js
const fs = require("fs"), path = require("path"), http = require("http");
const ROOT = path.join(__dirname, ".."), BR = process.env.BR || "chromium", PORT = +process.env.PORT || 8861;
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 1200) : "")); if (!c) fails++; };
let MODE = "ok";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webmanifest": "application/json" };
const srv = http.createServer((q, s) => {
  const u = decodeURIComponent(q.url.split("?")[0]); let f = path.join(ROOT, u === "/" ? "index.html" : u);
  if (!f.startsWith(ROOT)) { s.writeHead(403); return s.end(); }
  if (u === "/js/detect-worker.js" && MODE === "500") { s.writeHead(500, { "content-type": "text/plain" }); return s.end("boom"); }
  if (u === "/js/detect-worker.js" && MODE === "html") { s.writeHead(200, { "content-type": "text/html" }); return s.end("<!doctype html><html><body>One more step</body></html>"); }
  fs.readFile(f, (e, b) => { if (e) { s.writeHead(404); return s.end(); } s.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); s.end(b); });
});
(async () => {
  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  const pw = require("playwright");
  const b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const tag = BR + ": ";
  const open = async () => { const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } }); const p = await ctx.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message)); await p.goto("http://127.0.0.1:" + PORT + "/index.html?nosw=1", { waitUntil: "load" }); return p; };
  const load = (p, m) => p.evaluate(async (m) => { const D = TDC.detect; D.unload(); try { const i = await D.load(m); return { ok: true, backend: i.backend, status: D.status }; } catch (e) { return { ok: false, err: e.message, status: D.status }; } }, m);
  // ok
  MODE = "ok"; let p = await open();
  const r0 = await load(p, "nano");
  ok(tag + "normal: nano loads", r0.ok === true && /Ready/.test(r0.status), r0);
  ok(tag + "normal: worker-start still exposes start/describe/explain/diagnose", await p.evaluate(() => ["start", "describe", "explain", "diagnose", "TRY"].every((k) => !!TDC.workerStart[k])));
  ok(tag + "describe: a worker error WITH a message is unchanged", await p.evaluate(() => TDC.workerStart.describe({ message: "boom", filename: "http://x/js/a.js", lineno: 7 }, "", "blob") === "boom (a.js:7)"));
  ok(tag + "describe: killed after it started → the old 'out of memory' text", await p.evaluate(() => /stopped the worker while loading/.test(TDC.workerStart.describe({}, "loading", "blob"))));
  ok(tag + "describe: bare error before any report names how and the first failure", await p.evaluate(() => { const t = TDC.workerStart.describe({}, "", "file js/detect-worker.js", "HTTP 429 for js/detect-worker.js"); return /could not start \(file js\/detect-worker\.js; the first try failed with: HTTP 429/.test(t); }));
  // diagnose against a healthy script
  const dg = await p.evaluate(() => TDC.workerStart.diagnose({ worker: "js/detect-worker.js" }).then((d) => ({ text: d.text, probe: d.probe, syntax: d.syntax, script: d.script })));
  ok(tag + "diagnose (healthy): script 200, syntax ok, test worker started with fetch/IndexedDB/WebAssembly ok", /^HTTP 200/.test(dg.script) && dg.syntax === "ok" && dg.probe && dg.probe.fetch === 200 && dg.probe.idbOpen === "ok" && dg.probe.wasmOk === true && !dg.probe.err, dg);
  await p.context().close();
  // 500
  MODE = "500"; p = await open();
  const t0 = Date.now(); const r1 = await load(p, "nano");
  ok(tag + "500: load fails with 'Detection worker failed'", r1.ok === false && /^Detection worker failed: the worker script could not start \(file js\/detect-worker\.js; the first try failed with: HTTP 500/.test(r1.err), r1);
  ok(tag + "500: diagnostics say what the script answered", /Checked: js\/detect-worker\.js → HTTP 500 text\/plain/.test(r1.err || ""), r1.err);
  ok(tag + "500: the test worker started and its abilities are listed", /Test worker: started; fetch \d+, IndexedDB ok, WebAssembly ok, importScripts function/.test(r1.err || ""), r1.err);
  ok(tag + "500: 'What to try' line with ?nosw=1 and clear-site-data", /What to try: reload with \?nosw=1/.test(r1.err || "") && /Manage Website Data/.test(r1.err || ""), r1.err);
  ok(tag + "500: status line shows the same text, and it took < 12 s (" + (Date.now() - t0) + " ms)", /^Detection unavailable: Detection worker failed/.test(r1.status) && Date.now() - t0 < 12000, r1.status);
  const r1b = await p.evaluate(async () => { const D = TDC.detect; try { await D.load("small"); return "loaded"; } catch (e) { return e.message.slice(0, 60); } });
  ok(tag + "500: a second model fails the same way (no hang)", /^Detection worker failed/.test(r1b), r1b);
  // plates
  const pl = await p.evaluate(async () => { try { await TDC.plates.load(); return "loaded"; } catch (e) { return e.message; } });
  ok(tag + "500: plate worker explains itself too", /^Plate worker failed: the worker script could not start/.test(pl) && /Checked: js\/detect-worker\.js/.test(pl) && /What to try/.test(pl), pl);
  await p.context().close();
  // html
  MODE = "html"; p = await open();
  const r2 = await load(p, "nano");
  ok(tag + "html: fails with a message that names it (Chromium: worker's own error; WebKit: bare error, diagnostics)", r2.ok === false && /Detection worker failed: /.test(r2.err) && (/The server sent a web page instead of the script\. What to try/.test(r2.err) || /Checked: js\/detect-worker\.js → HTTP 200 text\/html \d+ bytes \(this is a web page, not the script\); syntax Unexpected token '<'/.test(r2.err)), r2);
  console.log("INFO html message: " + (r2.err || "").slice(0, 400));
  await p.context().close();
  // back to normal after a failure, in the same page: fixed server → loads
  MODE = "500"; p = await open(); await load(p, "nano"); MODE = "ok";
  const r3 = await load(p, "nano");
  ok(tag + "recovery: once the script is served again the same page loads the model", r3.ok === true, r3);
  ok(tag + "no page errors", p.errs.length === 0, p.errs);
  await b.close(); srv.close();
  console.log(fails ? "FAILED " + fails : "ALL PASSED"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
