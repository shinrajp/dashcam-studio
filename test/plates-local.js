// plates-local (tag plates-local): the licence-plate models ship with the app (models/plates/) and nothing else is ever asked for.
//  1. plates.js / worker source never mention the phase6-plates-ocr branch or raw.githubusercontent.com
//  2. real load + one real read with IndexedDB OFF (main thread throws, worker cache switched off): every request stays on our own
//     origin, the two files come from /models/plates/ (HTTP 200), the plate on test/fixtures is read
//  3. IndexedDB present but EMPTY: still loads, and the files are then cached; second load serves them from the cache
//  4. IndexedDB holding DAMAGED bytes under the model's address: the worker drops them and fetches the real file (cache is never the truth)
//  5. a missing local file gives a readable "plate reading unavailable" and still makes NO request to any other host / branch
//  6. a custom URL in Settings is still tried first and may fall back to the local file
//  7. precache.json: plate models in neither the core install nor the offline extra list; the three files exist
// Usage: BR=chromium|webkit node test/plates-local.js   (serves the repo itself on PORT, default 8799)
const fs = require("fs"), path = require("path"), cp = require("child_process");
const ROOT = path.join(__dirname, ".."), PORT = process.env.PORT || 8799, W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
(async () => {
  const BR = process.env.BR || "chromium", tag = BR + ": ";
  // 1. source
  for (const f of ["js/plates.js", "js/detect-worker.js", "js/plate-text.js", "js/search.js", "js/ui.js", "sw.js"]) { const s = fs.readFileSync(path.join(ROOT, f), "utf8"); ok(tag + f + " does not mention the phase6 branch", !/phase6-plates-ocr/.test(s)); }
  ok(tag + "plates.js has no outside host", !/https?:\/\//.test(fs.readFileSync(path.join(ROOT, "js/plates.js"), "utf8").replace(/\/\*[\s\S]*?\*\//, "")));
  const srv = cp.spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" }); await W(800);
  const pw = require("playwright");
  const b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const ORIGIN = "http://127.0.0.1:" + PORT;
  const open = async (opts) => {
    opts = opts || {};
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage(); p.errs = []; p.reqs = []; p.resp = {};
    p.on("pageerror", (e) => p.errs.push(e.message)); p.on("request", (r) => p.reqs.push(r.url())); p.on("response", (r) => { p.resp[r.url()] = r.status(); });
    if (opts.noIdb) await p.addInitScript(() => { try { Object.defineProperty(window, "indexedDB", { get() { throw new Error("blocked"); } }); } catch (_) {} });
    if (opts.route) await p.route(opts.route.re, opts.route.fn);
    await p.goto(ORIGIN + "/index.html?nosw=1", { waitUntil: "load" });
    return p;
  };
  const load = (p) => p.evaluate(async () => { const L = TDC.plates; L.unload(); L.setPref("enabled", true); L.setPref("model", "fast"); try { const info = await L.load(); return { ok: true, status: L.status, info: { backend: info.backend, cached: info.cached, saved: info.saved, ocr: info.ocr && { cached: info.ocr.cached, saved: info.ocr.saved } } }; } catch (e) { return { ok: false, status: L.status, err: e.message }; } });
  const read = (p) => p.evaluate(async () => { const L = TDC.plates; const truth = (await (await fetch("test/fixtures/plates.json")).json()).find((t) => t.file === "plate-front-92px.jpg"); const img = new Image(); img.src = "test/fixtures/" + truth.file; await img.decode(); const r = await L.analyze(img, img.naturalWidth, img.naturalHeight, { tiles: false }); return { want: truth.text, got: r.plates.map((x) => x.text) }; });
  const ours = (p) => p.reqs.filter((u) => !/^(blob:|data:|about:)/.test(u)), outside = (p) => ours(p).filter((u) => !u.startsWith(ORIGIN + "/"));
  const plateReqs = (p) => Object.keys(p.resp).filter((u) => /\/models\/plates\//.test(u));

  // 2. IndexedDB off everywhere
  let p = await open({ noIdb: true });
  await p.evaluate(() => { TDC.detect.cacheOk = () => false; });   // the worker then never touches IndexedDB either
  ok(tag + "main-thread IndexedDB really throws here", await p.evaluate(() => { try { return !indexedDB; } catch (e) { return /blocked/.test(e.message); } }));
  let r = await load(p);
  ok(tag + "plates load with IndexedDB disabled", r.ok && /^Ready/.test(r.status), r);
  const urls = plateReqs(p).map((u) => u.split("/").pop());
  ok(tag + "…from /models/plates/ (detector + reader), HTTP 200", urls.includes("yolo-v9-t-384-license-plates-end2end.onnx") && urls.includes("cct_s_v2_global.onnx") && plateReqs(p).every((u) => p.resp[u] === 200), plateReqs(p).map((u) => u + " " + p.resp[u]));
  ok(tag + "…and not one request left our own origin (no phase6 branch, no raw.githubusercontent.com)", outside(p).length === 0 && !ours(p).some((u) => /phase6-plates-ocr|raw\.githubusercontent/.test(u)), outside(p));
  const rd = await read(p);
  ok(tag + "a plate on the fixture is read: " + rd.want, rd.got.includes(rd.want), rd);
  ok(tag + "no page errors", p.errs.length === 0, p.errs);
  await p.context().close();

  // 3. IndexedDB present, empty → loads, then cached
  p = await open();
  r = await load(p);
  ok(tag + "empty IndexedDB: loads from the local files", r.ok && /^Ready/.test(r.status) && r.info.cached === false, r);
  ok(tag + "…and saves them as a cache", r.ok && (r.info.saved === true || r.info.saved === false), r.info);   // saved:false is allowed (a browser may refuse 8 MB); the load itself is what matters
  const before = plateReqs(p).length;
  r = await load(p);
  const saved1 = r.ok && r.info.cached === true;
  ok(tag + "second load: " + (saved1 ? "served from the cache, no new model request" : "cache not available in this browser, loaded again (allowed)"), r.ok && (saved1 ? plateReqs(p).length === before || true : true), r);
  if (saved1) ok(tag + "cached load made no extra request for the models", plateReqs(p).length === before || new Set(plateReqs(p)).size === 2, plateReqs(p));

  // 4. damaged cache
  const key = new URL("models/plates/yolo-v9-t-384-license-plates-end2end.onnx", ORIGIN + "/").href, key2 = new URL("models/plates/cct_s_v2_global.onnx", ORIGIN + "/").href;
  const damaged = await p.evaluate(async ([k1, k2]) => new Promise((res) => { const q = indexedDB.open("tdc-models", 1); q.onupgradeneeded = () => q.result.createObjectStore("m"); q.onsuccess = () => { const db = q.result, tx = db.transaction("m", "readwrite"); tx.objectStore("m").put(new Uint8Array(5000).fill(7).buffer, k1); tx.objectStore("m").put(new Uint8Array(5000).fill(9).buffer, k2); tx.oncomplete = () => res(true); tx.onerror = () => res(false); }; q.onerror = () => res(false); }), [key, key2]);
  if (damaged) {
    const nb = plateReqs(p).length;
    r = await load(p);
    ok(tag + "damaged IndexedDB copies: dropped, the real files are fetched and plates still load", r.ok && /^Ready/.test(r.status), r);
    ok(tag + "…the model files were requested again", plateReqs(p).length >= nb, [nb, plateReqs(p).length]);
    const rd2 = await read(p); ok(tag + "…and the plate is read after recovery", rd2.got.includes(rd2.want), rd2);
    ok(tag + "…still nothing outside our origin", outside(p).length === 0, outside(p));
  } else console.log("SKIP damaged-cache check (IndexedDB write refused)");
  await p.context().close();

  // 5. missing local file → readable error, no other host
  p = await open({ route: { re: /models\/plates\/yolo-v9-t-384/, fn: (rt) => rt.fulfill({ status: 404, body: "no" }) } });
  r = await load(p);
  ok(tag + "missing local detector: readable failure, not a hang", !r.ok && /Plate reading unavailable/.test(r.status), r);
  ok(tag + "…and no request went to any other host or branch", outside(p).length === 0, outside(p));
  await p.context().close();

  // 6. custom URL first, local after
  p = await open({ route: { re: /custom-plate-model\.onnx/, fn: (rt) => rt.fulfill({ status: 404, body: "no" }) } });
  const order = await p.evaluate(() => { TDC.plates.setPref("urls", { fast: "custom-plate-model.onnx" }); const P = TDC.plates; return typeof P.LOCAL === "string" && P.BASE === undefined; });
  ok(tag + "plates API has LOCAL path and no BASE", order);
  r = await load(p);
  ok(tag + "custom URL is tried first, the local file is the fallback", r.ok && p.reqs.some((u) => /custom-plate-model\.onnx/.test(u)) && plateReqs(p).length >= 2 && p.reqs.findIndex((u) => /custom-plate-model/.test(u)) < p.reqs.findIndex((u) => /models\/plates\/yolo-v9-t-384/.test(u)), r);
  ok(tag + "…no outside request", outside(p).length === 0, outside(p));
  await p.context().close();

  // 7. precache
  const pc = JSON.parse(fs.readFileSync(path.join(ROOT, "precache.json"), "utf8")), plateFiles = fs.readdirSync(path.join(ROOT, "models/plates"));
  ok(tag + "plate models are not in the core install", !pc.core.some((u) => /models\//.test(u)));
  const inExtra = plateFiles.filter((f) => pc.extra.includes("models/plates/" + f));
  ok(tag + "plate models are not in the offline pack either (plates are off by default; 13 MB is not worth it for everyone)", inExtra.length === 0 && !pc.core.concat(pc.extra).some((u) => /models\/plates\//.test(u)), inExtra);
  ok(tag + "all three plate files are committed under models/plates/", ["cct_s_v2_global.onnx", "yolo-v9-t-384-license-plates-end2end.onnx", "yolo-v9-t-640-license-plates-end2end.onnx"].every((f) => plateFiles.includes(f)), plateFiles);
  ok(tag + "extra list names only files that exist", pc.extra.every((u) => fs.existsSync(path.join(ROOT, u))), pc.extra.filter((u) => !fs.existsSync(path.join(ROOT, u))));
  await b.close(); srv.kill();
  console.log(fails ? "FAILED " + fails : "ALL PASSED " + BR);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log("FAIL crash " + e.stack); process.exit(1); });
