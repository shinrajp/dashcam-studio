const puppeteer = require("puppeteer-core"); const fs = require("fs");
const dir = "/workspace/encfix/SentryClips/2026-10-05_09-00-00", files = fs.readdirSync(dir).map((f) => dir + "/" + f);
const keys = fs.readFileSync("/workspace/encfix/keys.json", "utf8");
(async () => {
  const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"], userDataDir: "/tmp/tdc-fg-" + Date.now() });
  const p = await b.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("dialog", (d) => d.accept());
  // fake clipboard holding the keys JSON (simulates the helper's copy())
  await p.evaluateOnNewDocument((k) => { Object.defineProperty(navigator, "clipboard", { value: { readText: async () => k, writeText: async () => {} } }); }, keys);
  const W = (ms) => new Promise((r) => setTimeout(r, ms));
  const st = () => p.evaluate(() => { const ev = TDC.library.events[0]; const n = document.querySelector("#libList .ev .saved-note"); return ev ? { locked: ev.locked, note: n && n.textContent, cache: TDC.library.keyCache.size } : { events: 0, cache: TDC.library.keyCache.size }; });
  const focus = async () => { await p.evaluate(() => window.dispatchEvent(new Event("focus"))); await W(1500); };
  await p.goto("http://127.0.0.1:8770/index.html"); await W(500); const R = {};
  await p.evaluate(() => { const c = document.getElementById("chkRememberKeys"); c.checked = true; c.dispatchEvent(new Event("change")); });
  await (await p.$("#fileInput")).uploadFile(...files); await W(1500);
  await focus(); R.clipboardApplyWorksBefore = await st();
  R.saved = await p.evaluate(() => TDC.keyStore.count());
  await p.evaluate(() => { TDC.keyStore.openDialog(); document.getElementById("btnForgetKeys").click(); }); await W(1000);
  R.afterForget = await st(); R.savedAfterForget = await p.evaluate(() => TDC.keyStore.count());
  await focus(); R.focusAfterForget = await st();
  await p.evaluate(() => document.querySelectorAll("#libList .ev-x").forEach((x) => x.click())); await W(400);
  await (await p.$("#fileInput")).uploadFile(...files); await W(1500); await focus(); R.readdAfterForget = await st();
  await p.reload(); await W(600); await (await p.$("#fileInput")).uploadFile(...files); await W(1500); await focus(); R.reloadReadd = await st();
  R.savedAtEnd = await p.evaluate(() => TDC.keyStore.count());
  // supplying keys again via the console fallback works and re-enables the clipboard path
  await p.evaluate((k) => { document.getElementById("pasteKeys").value = k; document.getElementById("btnApplyKeys").click(); }, keys); await W(1500);
  R.manualAgain = await st();
  console.log(JSON.stringify(R), errs); await b.close(); })();
