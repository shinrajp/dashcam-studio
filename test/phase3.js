const puppeteer = require("puppeteer-core"); const fs=require("fs"), path=require("path");
const URL_="http://127.0.0.1:8770/index.html";
(async () => {
  const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"], userDataDir: "/tmp/tdc-profile-" + Date.now() });
  const p = await b.newPage(); const errs=[]; p.on("pageerror", e=>errs.push(e.message));
  if (process.env.NO_IDB) await p.evaluateOnNewDocument(() => { Object.defineProperty(window, "indexedDB", { get() { throw new Error("blocked"); } }); });
  await p.goto(URL_);
  const files=[]; (function w(d){ for (const f of fs.readdirSync(d)) { const q=path.join(d,f); fs.statSync(q).isDirectory()?w(q):(f!=="base.mp4"&&files.push(q)); } })("/workspace/fixtures");
  await (await p.$("#fileInput")).uploadFile(...files);
  await p.waitForFunction(() => window.TDC.libIndex.events.size >= 2, { timeout: 15000 });
  const a = await p.evaluate(async () => { const X = window.TDC.libIndex;
    // fake an encrypted locked event to test filters
    await X.sync([{ id: "fake|enc", time: 1, trigger: { label: "Sentry" }, source: "SentryClips", cams: ["front","back","left_repeater","right_repeater"], clips: [{ stamp: "s", files: {} }], encrypted: 4, locked: 4, fileCount: 4 }]);
    const sel = document.getElementById("libFilter"); sel.value = "undecrypted"; sel.dispatchEvent(new Event("change"));
    const hiddenEv = [...document.querySelectorAll("#libList .ev")].filter(e => e.hidden).length;
    return { mode: X.mode, size: X.events.size, undec: X.list("undecrypted").length, dec: X.list("decrypted").length, hiddenLoadedWhenUndecFilter: hiddenEv, panelRows: document.querySelectorAll("#libIndexList > div").length, noVideo: !JSON.stringify([...X.events.values()]).includes("blob") }; });
  await p.reload(); await new Promise(r=>setTimeout(r,1500));
  const r2 = await p.evaluate(() => ({ mode: window.TDC.libIndex.mode, sizeAfterReload: window.TDC.libIndex.events.size, sidebarVisible: !document.getElementById("library").hidden, panelRows: document.querySelectorAll("#libIndexList > div").length }));
  // reopen same files -> known count
  await (await p.$("#fileInput")).uploadFile(...files);
  await p.waitForFunction(() => window.TDC.library.events.length >= 2, { timeout: 15000 });
  const r3 = await p.evaluate(async () => { await new Promise(r=>setTimeout(r,500)); const s = window.TDC.libIndex.lastScan; window.confirm = () => true; document.getElementById("btnClearIndex").click(); await new Promise(r=>setTimeout(r,500)); return { lastScan: s, afterClear: window.TDC.libIndex.events.size }; });
  await p.reload(); await new Promise(r=>setTimeout(r,1000));
  const r4 = await p.evaluate(() => window.TDC.libIndex.events.size);
  console.log(JSON.stringify({ a, r2, r3, sizeAfterClearAndReload: r4 }, null, 1), "ERRORS:", errs); await b.close();
})();
