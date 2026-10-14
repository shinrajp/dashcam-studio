const puppeteer = require("puppeteer-core"); const path = require("path"); const fs=require("fs");
const URL_ = process.argv[2] || "http://127.0.0.1:8765/index.html";
(async () => {
  const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox","--autoplay-policy=no-user-gesture-required"] });
  const p = await b.newPage(); const errs = [];
  p.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|tile\.openstreetmap/.test(m.text())) errs.push("console: " + m.text()); });
  if (process.env.NO_IDB) await p.evaluateOnNewDocument(() => { Object.defineProperty(window, "indexedDB", { get() { throw new Error("blocked"); } }); });
  await p.goto(URL_, { waitUntil: "load" });
  const files = []; (function w(d){ for (const f of fs.readdirSync(d)) { const q=path.join(d,f); fs.statSync(q).isDirectory()?w(q):(f!=="base.mp4"&&files.push(q)); } })("/workspace/fixtures");
  const input = await p.$("#fileInput"); await input.uploadFile(...files);
  try { await p.waitForFunction(() => window.TDC.library.events.length >= 2, { timeout: 15000 }); } catch (e) { console.log("events:", await p.evaluate(() => window.TDC.library.events.length + " items:" + window.TDC.library.items.size), errs); throw e; }
  const r = await p.evaluate(async () => {
    const T = window.TDC, out = {};
    out.events = T.library.events.map((e) => ({ cams: e.cams.length, clips: e.clips.length, locked: e.locked }));
    await T.ui.activate(T.library.events[0]); T.player.play(); await new Promise((r) => setTimeout(r, 1500));
    out.playTime = T.player.time; T.player.pause();
    // console key path: helper must be valid JS and buttons present
    out.helperBtn = !!document.getElementById("btnCopyHelper"); out.applyBtn = !!document.getElementById("btnApplyKeys");
    // simulate 72 encrypted requests across 12 six-angle sessions
    const lib = T.library; const cams = ["front","back","left_repeater","right_repeater","left_pillar","right_pillar"]; let n = 0;
    for (let s = 0; s < 12; s++) for (const c of cams) { const hex = "ab" + (n++).toString(16).padStart(86, "0"); lib.items.set("fake" + n, { key: "fake" + n, path: `TeslaCam/SentryClips/x/2026-10-02_10-${String(s).padStart(2,"0")}-00-${c}.mp4`, name: "f", kind: "encrypted", header: { wrappedHex: hex, id: "id" + n, vin: "V", key_id: 1, timestamp: 1, wrapped_key: "w", public_key: "p" } }); }
    out.batchSizes = lib.pendingKeyBatches().map((b) => b.length);
    const src = T.auth.helperSource(); try { new Function(src); out.helperParses = true; } catch (e) { out.helperParses = e.message; }
    out.helperHasBatches = /const batches = \[\[/.test(src);
    out.applyBogus = lib.applyKeys([{ id: "id1", key: "AAAAAAAAAAAAAAAAAAAAAA==" }]);
    for (const k of [...lib.items.keys()]) if (k.startsWith("fake")) lib.items.delete(k);
    out.extra = window.__extraChecks ? await window.__extraChecks() : null;
    return out;
  });
  console.log(JSON.stringify(r, null, 1)); console.log("ERRORS:", errs.length ? errs : "none");
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
