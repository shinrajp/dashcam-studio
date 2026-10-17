// Phase 6 in Chromium AND WebKit (Playwright): the plate finder + reader load and read a synthetic CA-style plate
//  (a) from a normal server on localhost, (b) from a WRONG-MIME server on a plain-http LAN address (test/serve-badmime.js;
//  like Windows python http.server reached from another machine), (c) with raw.githubusercontent / CDNs blocked.
// Usage: node test/phase6-webkit.js <goodUrl> <badMimeLanUrl>
const { chromium, webkit } = require("playwright");
const GOOD = process.argv[2] || "http://127.0.0.1:8796/index.html", BAD = process.argv[3] || "http://172.30.0.2:18796/index.html";
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x) : "")); if (!c) fails++; };
const run = (p) => p.evaluate(async () => { try { const L = TDC.plates; L.setPref("enabled", true); L.setPref("model", "fast"); const t0 = performance.now(); const info = await L.load();
  const img = new Image(); img.src = "test/fixtures/plate-front-50px.jpg"; await img.decode(); const a = performance.now(); const r = await L.analyze(img, img.naturalWidth, img.naturalHeight, { tiles: false });
  return { ok: true, backend: info.backend, loadMs: Math.round(a - t0), frameMs: Math.round(performance.now() - a), reads: r.plates.map((x) => x.text + " " + Math.round(x.conf * 100) + "%") }; } catch (e) { return { ok: false, err: e.message }; } });
(async () => {
  for (const [name, bt] of [["chromium", chromium], ["webkit", webkit]]) {
    const b = await bt.launch(name === "chromium" ? { executablePath: "/usr/bin/google-chrome" } : {});
    for (const [tag, url, block] of [["localhost", GOOD, false], ["LAN http + wrong MIME", BAD, false], ["offline CDNs/GitHub", BAD, true]]) {
      const ctx = await b.newContext(); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
      if (block) await ctx.route(/cdn\.jsdelivr\.net|raw\.githubusercontent\.com|huggingface/, (r) => r.abort());
      await p.goto(url);
      const r = await run(p);
      console.log(name, tag, JSON.stringify(r));
      ok(name + " · " + tag + ": plate finder + reader load and read 8DEM042", r.ok && r.reads.includes("8DEM042 100%") || (r.ok && r.reads.some((x) => /^8DEM042 /.test(x))), r);
      ok(name + " · " + tag + ": no page errors", errs.length === 0, errs);
      await ctx.close();
    }
    await b.close();
  }
  console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
