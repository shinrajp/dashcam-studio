// Plate worker start, with Object detection OFF and Plates & text ON (the usual setup), served by a plain
// `python3 -m http.server` like on a Mac, on localhost and on the LAN address. Chromium + WebKit.
// Checks: the real models load and run; plates use the shared MIME-proof start without detection; Safari/WebKit
// gets WASM (not the WebGPU build that Safari 26 kills); a killed worker is explained (stage named) and retried on
// WASM; a missing runtime file or broken worker script gives its real reason, never a bare "could not start".
// Usage: node test/plate-worker.js   (ENGINES=chromium,webkit; PORT=8782; LAN=<box address> to override)
const { chromium, webkit } = require("playwright"); const { spawn } = require("child_process"); const os = require("os"), path = require("path");
const ENGINES = (process.env.ENGINES || "chromium,webkit").split(","), PORT = +process.env.PORT || 8782;
const LAN = process.env.LAN || (Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal) || {}).address;
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x) : "")); if (!c) fails++; };
const PREFS = () => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.setItem("tdc.plates.v1", JSON.stringify({ enabled: true })); };

async function page(b, url, init) {
  for (let a = 1; ; a++) {
    const ctx = await b.newContext(); await ctx.addInitScript(PREFS); if (init) await ctx.addInitScript(init);
    const p = await ctx.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message));
    try { await Promise.race([p.goto(url, { waitUntil: "load" }).then(() => p.waitForFunction(() => window.TDC && TDC.plates && TDC.workerStart)), W(60000).then(() => { throw new Error("load timed out"); })]); return p; }
    catch (e) { console.log("NOTE page load retry (" + e.message + ")"); await ctx.close().catch(() => {}); if (a >= 4) throw e; }
  }
}
const loadPlates = (p) => p.evaluate(async () => { try { const i = await TDC.plates.load(); return { ok: true, backend: i.backend, ocr: !!i.ocr, stage: TDC.plates.stage }; } catch (e) { return { ok: false, err: e.message, status: TDC.plates.status }; } });

(async () => {
  const srv = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "0.0.0.0"], { cwd: path.join(__dirname, ".."), stdio: "ignore" });
  await W(1200);
  try {
    for (const name of ENGINES) {
      const b = await (name === "webkit" ? webkit : chromium).launch();
      for (const host of ["127.0.0.1", LAN].filter(Boolean)) {
        const url = "http://" + host + ":" + PORT + "/index.html", tag = name + " " + (host === "127.0.0.1" ? "localhost" : "LAN") + ":";
        // record what the page asks the worker for
        const p = await page(b, url, () => { const pm = Worker.prototype.postMessage; window.__wmsgs = []; Worker.prototype.postMessage = function (m, t) { if (m && m.type) __wmsgs.push({ type: m.type, preferGpu: m.preferGpu }); return pm.call(this, m, t); }; });
        ok(tag + " setup: detection off, plates on", await p.evaluate(() => !TDC.detect.enabled() && TDC.plates.enabled()));
        const r = await loadPlates(p);
        ok(tag + " plate finder + reader load from python http.server", r.ok && r.ocr && r.stage === "ready", r);
        const sent = await p.evaluate(() => __wmsgs);
        ok(tag + " only the plate worker started (detection stays off)", sent.filter((m) => m.type === "load").length === 1, sent);
        if (name === "webkit") ok(tag + " WebKit/Safari asks for WASM, not WebGPU", sent[0] && sent[0].preferGpu === false && r.backend === "wasm", { sent, r });
        const det = await p.evaluate(async () => { const c = document.createElement("canvas"); c.width = 1280; c.height = 960; const x = c.getContext("2d"); x.fillStyle = "#567"; x.fillRect(0, 0, 1280, 960); try { const d = await TDC.plates.detectPlates(c, 1280, 960, { tiles: false }); return { ok: Array.isArray(d) }; } catch (e) { return { ok: false, err: e.message }; } });
        ok(tag + " plate finder runs a frame", det.ok, det);
        ok(tag + " no page errors", p.errs.length === 0, p.errs);
        await p.context().close();
      }
      const url = "http://127.0.0.1:" + PORT + "/index.html";
      // Safari/WebKit detection (pure function)
      const p0 = await page(b, url);
      const ua = await p0.evaluate(() => {
        const k = TDC.workerStart.isWebKit;
        return { macSafari: k("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15"),
          iphone: k("Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1"),
          iosChrome: k("Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1"),
          macChrome: k("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"),
          edge: k("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0") };
      });
      ok(name + ": Safari (Mac, iPhone, iOS Chrome) → WASM; Chrome/Edge → WebGPU allowed", ua.macSafari && ua.iphone && ua.iosChrome && !ua.macChrome && !ua.edge, ua);
      const ov = await p0.evaluate(() => { localStorage.setItem("tdc.webgpu", "on"); const on = TDC.workerStart.gpuOk(); localStorage.setItem("tdc.webgpu", "off"); const off = TDC.workerStart.gpuOk(); localStorage.removeItem("tdc.webgpu"); return { on, off }; });
      ok(name + ": tdc.webgpu on/off override", ov.on === true && ov.off === false, ov);
      await p0.context().close();

      // A worker the browser kills while starting WebGPU (bare error event, no message): stage named, retried on WASM.
      const p1 = await page(b, url, () => {
        localStorage.setItem("tdc.webgpu", "on"); window.__fake = [];
        const Real = window.Worker;
        window.Worker = function (u, o) {
          const w = new Real(u, o), rec = { gpu: [] }; __fake.push(rec);
          if (__fake.length === 1) {   // first worker "dies" on WebGPU
            w.postMessage = function (m) { rec.gpu.push(m.preferGpu); setTimeout(() => { w.onmessage && w.onmessage({ data: { type: "stage", stage: "starting the model on WebGPU" } }); setTimeout(() => { const e = new Event("error"); w.onerror && w.onerror(e); }, 50); }, 50); };
          } else { const pm = w.postMessage.bind(w); w.postMessage = (m, t) => { rec.gpu.push(m.preferGpu); return pm(m, t); }; }
          return w;
        };
      });
      const r1 = await loadPlates(p1), f1 = await p1.evaluate(() => __fake.map((x) => x.gpu));
      ok(name + ": worker killed on WebGPU → retried once on WASM and loads", r1.ok && f1.length === 2 && f1[0][0] === true && f1[1][0] === false, { r1, f1 });
      await p1.context().close();
      const p2 = await page(b, url, () => {
        const Real = window.Worker;
        window.Worker = function (u, o) { const w = new Real(u, o); w.postMessage = function () { setTimeout(() => { w.onmessage({ data: { type: "stage", stage: "starting the model on WASM" } }); setTimeout(() => w.onerror(new Event("error")), 50); }, 50); }; return w; };
      });
      const r2 = await loadPlates(p2);
      ok(name + ": killed on WASM → message names the stage, not 'could not start'", !r2.ok && /stopped the worker while starting the model on WASM/.test(r2.err) && !/could not start/.test(r2.err) && /starting the model on WASM/.test(r2.status), r2);
      await p2.context().close();

      // Missing runtime file → the worker's own reason reaches the page
      const p3 = await page(b, url); await p3.route(/vendor\/ort\/ort\.(wasm|webgpu)\.min\.js/, (rt) => rt.fulfill({ status: 404, body: "nope" }));
      await p3.route(/raw\.githubusercontent|cdn\.jsdelivr/, (rt) => rt.abort());
      const r3 = await p3.evaluate(async () => { const D = TDC.detect; D.config.ortBases = ["vendor/ort/"]; try { await TDC.plates.load(); return { ok: true }; } catch (e) { return { ok: false, err: e.message }; } });
      ok(name + ": missing ort.wasm.min.js → 'couldn't fetch ort…' reason", !r3.ok && /ort\.(wasm|webgpu)\.min\.js/.test(r3.err) && /HTTP 404|couldn't fetch/.test(r3.err), r3);
      await p3.context().close();
      // Broken worker script → real text
      const p4 = await page(b, url); await p4.route(/js\/detect-worker\.js/, (rt) => rt.fulfill({ status: 200, contentType: "text/javascript", body: "self.addEventListener('error',e=>postMessage({type:'fatal',error:'worker: '+e.message}));\nthrow new Error('boom at start');" }));
      const r4 = await loadPlates(p4);
      ok(name + ": worker script throws → its message reaches the status", !r4.ok && /boom at start/.test(r4.err), r4);
      await p4.context().close();
      // Worker file missing everywhere → says the script couldn't start and how
      const p5 = await page(b, url); await p5.route(/js\/detect-worker\.js/, (rt) => rt.fulfill({ status: 404, body: "" }));
      const r5 = await p5.evaluate(async () => { try { await Promise.race([TDC.plates.load(), new Promise((_, j) => setTimeout(() => j(new Error("TIMEOUT")), 15000))]); return { ok: true }; } catch (e) { return { ok: false, err: e.message }; } });
      ok(name + ": worker file 404 → explained (script could not start, how)", !r5.ok && /could not start \(file js\/detect-worker\.js\)|Couldn't start the plate worker/.test(r5.err), r5);
      await p5.context().close();
      await b.close();
    }
  } finally { srv.kill(); }
  console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
