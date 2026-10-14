const puppeteer = require("puppeteer-core"); const fs = require("fs");
const dir = "/workspace/encfix/SentryClips/2026-10-05_09-00-00", files = fs.readdirSync(dir).map((f) => dir + "/" + f);
const keys = fs.readFileSync("/workspace/encfix/keys.json", "utf8");
(async () => {
  const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"], userDataDir: "/tmp/tdc-ra-" + Date.now() });
  const p = await b.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("dialog", (d) => d.accept());
  if (process.env.NO_IDB) await p.evaluateOnNewDocument(() => { Object.defineProperty(window, "indexedDB", { get() { throw new Error("blocked"); } }); });
  await p.goto("http://127.0.0.1:8770/index.html"); await new Promise((r) => setTimeout(r, 500));
  const W = (ms) => new Promise((r) => setTimeout(r, ms));
  const state = () => p.evaluate(() => { const ev = TDC.library.events[0]; const badge = document.querySelector("#libList .ev .saved-note"); return ev ? { events: TDC.library.events.length, locked: ev.locked, enc: ev.encrypted, pending: TDC.auth.items().length, note: badge ? badge.textContent : null, savedCount: (document.getElementById("savedKeyCount") || {}).textContent || null } : { events: 0 }; });
  const R = {};
  await p.evaluate(() => { const c = document.getElementById("chkRememberKeys"); c.checked = true; c.dispatchEvent(new Event("change")); });
  await (await p.$("#fileInput")).uploadFile(...files); await W(1500); R.loaded = await state();
  await p.evaluate((k) => { document.getElementById("pasteKeys").value = k; document.getElementById("btnApplyKeys").click(); }, keys); await W(1500);
  R.afterPaste = await state(); R.savedInDb = await p.evaluate(() => TDC.keyStore.count());
  const removeAll = () => p.evaluate(() => { document.querySelectorAll("#libList .ev-x").forEach((x) => x.click()); });
  await removeAll(); await W(500); R.afterRemove = await state(); R.savedAfterRemove = await p.evaluate(() => TDC.keyStore.count());
  await (await p.$("#fileInput")).uploadFile(...files); await W(2000); R.readdFilePicker = await state();
  await removeAll(); await W(500);
  await (await p.$("#folderInput")).uploadFile(...files); await W(2000); R.readdFolderInput = await state();
  await removeAll(); await W(500);
  // drag-drop path: build Files in-page and drop them on the window
  const blobs = files.map((f) => ({ name: f.split("/").pop(), b64: fs.readFileSync(f).toString("base64") }));
  await p.evaluate(async (blobs) => { const dt = new DataTransfer(); for (const x of blobs) dt.items.add(new File([Uint8Array.from(atob(x.b64), (c) => c.charCodeAt(0))], x.name, { type: "video/mp4" }));
    const ev = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }); document.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true })); (document.getElementById("viewport") || document.body).dispatchEvent(ev); }, blobs);
  await W(2000); R.readdDragDrop = await state();
  await removeAll(); await W(300); await p.evaluate(() => TDC.library.keyCache.clear()); // simulate fresh tab memory
  await p.reload(); await W(800);
  await (await p.$("#fileInput")).uploadFile(...files); await W(2000); R.afterReloadReadd = await state();
  console.log(JSON.stringify(R, null, 1), "ERRORS:", errs); await b.close();
})();
