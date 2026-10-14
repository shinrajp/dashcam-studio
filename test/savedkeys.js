const puppeteer = require("puppeteer-core");
const URL_ = "http://127.0.0.1:8770/index.html";
(async () => {
  const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"], userDataDir: "/tmp/tdc-sk-" + Date.now() });
  const p = await b.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("dialog", (d) => d.accept());
  await p.evaluateOnNewDocument((noidb) => {
    if (noidb) Object.defineProperty(window, "indexedDB", { get() { throw new Error("blocked"); } });
    window.__inject = () => { const lib = window.TDC.library; for (let i = 1; i <= 3; i++) lib.items.set("f" + i, { key: "f" + i, path: `SentryClips/x/2026-10-02_10-00-00-cam${i}.mp4`, name: "c" + i, size: 100, kind: "encrypted", header: { wrappedHex: "hex" + i, id: "id" + i } }); lib.pendingKeyItems(); };
    window.__wait = (ms) => new Promise((r) => setTimeout(r, ms));
  }, !!process.env.NO_IDB);
  const KEY = "AAECAwQFBgcICQoLDA0ODw==";
  await p.goto(URL_); await new Promise((r) => setTimeout(r, 500));
  const R = {};
  R.defaultOff = await p.evaluate(async (KEY) => { const S = TDC.keyStore; __inject(); TDC.library.applyKeys([{ id: "id1", key: KEY }]); await __wait(300); return { enabled: S.enabled(), saved: await S.count(), checkbox: document.getElementById("chkRememberKeys").checked, available: S.available, info: document.getElementById("savedKeysInfo").textContent.slice(0, 60) }; }, KEY);
  R.turnOn = await p.evaluate(async (KEY) => { const c = document.getElementById("chkRememberKeys"); c.checked = true; c.dispatchEvent(new Event("change")); await __wait(300);
    TDC.library.applyKeys([{ id: "id2", key: KEY }]); await __wait(300); return { saved: await TDC.keyStore.count() }; }, KEY);
  await p.reload(); await new Promise((r) => setTimeout(r, 700));
  R.afterReload = await p.evaluate(async () => { __inject(); const before = TDC.auth.items().length; await TDC.library.ingest([]); const after = TDC.auth.items().length;
    document.getElementById("unlockModal").hidden = false; await __wait(100);
    return { pendingBefore: before, pendingAfter: after, keysInCache: TDC.library.keyCache.size, label: document.querySelector("#btnUnlockGo span").textContent, helperStillWorks: TDC.auth.helperSource().includes("const batches") }; });
  R.clearIndex = await p.evaluate(async () => { document.getElementById("btnClearIndex").click(); await __wait(400); return { savedAfterClearIndex: await TDC.keyStore.count() }; });
  R.forget = await p.evaluate(async () => { document.getElementById("btnForgetKeys").click(); await __wait(400); return { saved: await TDC.keyStore.count() }; });
  R.offOffersForget = await p.evaluate(async (KEY) => { TDC.library.applyKeys([{ id: "id3", key: KEY }]); await __wait(300); const n = await TDC.keyStore.count(); const c = document.getElementById("chkRememberKeys"); c.checked = false; c.dispatchEvent(new Event("change")); await __wait(400); return { savedBeforeOff: n, savedAfterOff: await TDC.keyStore.count(), enabled: TDC.keyStore.enabled() }; }, KEY);
  console.log(JSON.stringify(R, null, 1), "ERRORS:", errs); await b.close();
})();
