// Phase 5 worker robustness, in Chromium AND WebKit (Playwright): the detector must load and run
//  (a) from a normal server on localhost, (b) from a server with WRONG MIME types on a non-localhost http IP
//  (test/serve-badmime.js — reproduces "Detection worker failed: script error" in WebKit before the fix),
//  (c) with the CDN blocked (vendor/ort only). Also: real error messages, picture-search labels without %, and
//  small-umbrella recall with tiles on test/fixtures/small-umbrella-*.png.
// Usage: node test/phase5-worker.js <goodUrl> <badMimeLanUrl>   (needs playwright with chromium+webkit)
const { chromium, webkit } = require("playwright");
const GOOD = process.argv[2] || "http://127.0.0.1:8770/index.html", BAD = process.argv[3] || "http://172.30.0.2:18792/index.html";
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x) : "")); if (!c) fails++; };
const run = (p) => p.evaluate(async () => { try { const D = TDC.detect; const t0 = performance.now(); const info = await D.load("nano"); const c = document.createElement("canvas"); c.width = 960; c.height = 720; const a = performance.now(); await D.detectImage(c, 960, 720); return { ok: true, backend: info.backend, loadMs: Math.round(a - t0), frameMs: Math.round(performance.now() - a) }; } catch (e) { return { ok: false, err: e.message }; } });
(async () => {
  for (const [name, bt] of [["chromium", chromium], ["webkit", webkit]]) {
    const b = await bt.launch(name === "chromium" ? { executablePath: "/usr/bin/google-chrome" } : {});
    for (const [tag, url, block] of [["localhost", GOOD, false], ["LAN http + wrong MIME", BAD, false], ["CDN blocked", BAD, true]]) {
      const ctx = await b.newContext(); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
      if (block) await ctx.route(/cdn\.jsdelivr\.net/, (r) => r.abort());
      await p.goto(url);
      const r = await run(p);
      ok(name + " · " + tag + ": detector loads and runs", r.ok && r.backend === "wasm", r);
      ok(name + " · " + tag + ": no page errors", errs.length === 0, errs);
      await ctx.close();
    }
    // real error text instead of "script error"
    { const p = await b.newPage(); await p.goto(GOOD);
      const e = await p.evaluate(async () => { const D = TDC.detect; const keep = D.config.ortBases; D.config.ortBases = ["nowhere/"]; try { await D.load("nano"); return "loaded?"; } catch (x) { return x.message; } finally { D.config.ortBases = keep; } });
      ok(name + ": missing runtime gives a real reason", /couldn't fetch ort|HTTP 404/i.test(e) && !/script error/i.test(e), e);
      const L = await p.evaluate(() => { const B = TDC.burnBoxes, box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }; return [B.labelFor({ score: 0.08, box }, "umbrella", 0.08), B.labelFor({ score: 0.04, box }, "umbrella", 0.08), B.labelFor({ cls: 25, label: "umbrella", conf: 0.41, det: true, box }, "")]; });
      ok(name + ": picture-search labels have no fake %", L[0] === "umbrella? (best match)" && L[1] === "umbrella? (match)" && L[2] === "umbrella 41%", L);
      const tr = await p.evaluate(() => { const D = TDC.detect; D.tracks = [{ cam: "front", from: 0, to: 2, text: "umbrella", track: { label: "car", pts: [{ t: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.2, conf: 0.83 }, { t: 2, x: 0.3, y: 0.1, w: 0.2, h: 0.2, conf: 0.83 }] } }]; const a = D.boxesAt("front", 1)[0].text; D.tracks[0].text = "cars"; const b = D.boxesAt("front", 1)[0].text; D.tracks = []; return [a, b]; });
      ok(name + ": picture-search box followed onto a car is not called 'umbrella 83%'", tr[0] === "umbrella? (match)" && tr[1] === "car 83%", tr);
      if (name === "chromium") {
        const um = await p.evaluate(async () => { const D = TDC.detect, out = {}; const old = D.prefs().model;
          for (const model of ["nano", "small"]) { D.setPref("model", model); await D.load(model);
            for (const w of [70, 45, 30]) { const img = new Image(); img.src = "test/fixtures/small-umbrella-" + w + ".png"; await img.decode();
              const conf = D.classConf("umbrella"); const f = (await D.detectImage(img, img.naturalWidth, img.naturalHeight, { conf })).filter((d) => d.label === "umbrella");
              const t = (await D.detectImage(img, img.naturalWidth, img.naturalHeight, { conf, tiles: true, tilesOnly: true })).filter((d) => d.label === "umbrella");
              out[model + " " + w + "px"] = { full: f.length ? Math.round(f[0].conf * 100) : 0, tiles: t.length ? Math.round(t[0].conf * 100) : 0, thr: Math.round(conf * 100) }; } }
          D.setPref("model", old); return out; });
        console.log("UMBRELLA", JSON.stringify(um));
        ok("small umbrella: tiles find the 45 px umbrella (nano + small) that the full frame misses", um["nano 45px"].tiles > 0 && um["small 45px"].tiles > 0 && um["nano 45px"].full === 0, um);
        ok("umbrella uses a lower threshold (35% → 21%)", um["nano 45px"].thr === 21);
      }
      await p.close(); }
    await b.close();
  }
  console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
