// "Stuck at Reading files" on a phone over plain http (no crypto.subtle): the page must show real progress, never hang, and decrypt fast.
// Loads the page from the box's LAN address (http://IP:port is NOT a secure context, so crypto.subtle really is missing, no mocking),
// adds the six cameras of ONE encrypted clip (tools/make-mock-footage.py --encrypted, synthetic keys) with their keys already known
// (the saved-key path decrypts inside the import step - the case that looked frozen), and checks:
//   slow-mode note (shown, dismissible, remembered) + help card, no service worker on http, "Reading files… n of 6" then
//   "Decrypting file i of 6 · % · MB/s" progress text, all six unlocked and playable, the page stays responsive (longest main-thread
//   stall), workers used (and the no-Worker fallback also finishes), a file that never delivers its bytes gives an error toast
//   after the timeout instead of a hang, and the throughput of the T-table code vs the old code in this browser.
// Usage: BR=chromium|webkit DEV=desktop|phone LAN=http://IP:8784/index.html OLD=http://IP:8783/index.html node test/decrypt-slow.js
const fs = require("fs"), path = require("path"), nc = require("crypto"), { execFileSync } = require("child_process");
const LAN = process.env.LAN || "http://172.30.0.2:8784/index.html", OLD = process.env.OLD || "", MOCK = process.env.MOCK || "/tmp/ho-enc";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 600) : "")); if (!c) fails++; };
(async () => {
  const pw = require("playwright");
  if (!fs.existsSync(MOCK + "/synthetic-keys.json")) execFileSync("python3", [path.join(__dirname, "../tools/make-mock-footage.py"), MOCK, "--encrypted", "--jobs", "4"], { stdio: "inherit" });
  const keys = JSON.parse(fs.readFileSync(MOCK + "/synthetic-keys.json", "utf8")), keyList = Object.entries(keys).map(([wrapped_key, key]) => ({ wrapped_key, key }));
  const dir = MOCK + "/TeslaCam/SavedClips/2026-10-08_09-01-00";
  // a larger synthetic encrypted file for the speed comparison (random bytes, never a real clip)
  const BIG = "/tmp/dcs-big-enc.bin", MB = 12;
  if (!fs.existsSync(BIG)) { const key = Buffer.alloc(16, 7), C = require("../js/crypto.js"), root = C.md5bytes(new Uint8Array(key)), pages = (MB << 20) / 4096, f = Buffer.alloc(0x2000 + pages * 4096), plain = nc.randomBytes(pages * 4096); plain.write("\0\0\0\x18ftypisom", 0, "latin1");
    for (let p = 0; p < pages; p++) { const c = nc.createCipheriv("aes-128-cbc", key, Buffer.from(C.pageIv(root, p))).setAutoPadding(false); Buffer.concat([c.update(plain.subarray(p * 4096, (p + 1) * 4096)), c.final()]).copy(f, 0x2000 + p * 4096); }
    fs.writeFileSync(BIG, f); }
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium"])) {
    const b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
    for (const dev of [{ name: "desktop", viewport: { width: 1280, height: 800 } }, { name: "phone", viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, userAgent: UA, deviceScaleFactor: 2 }].filter((d) => !process.env.DEV || d.name === process.env.DEV)) {
      const tag = BR + " " + dev.name + ": ";
      for (const variant of ["workers", "no-workers", "stuck-file"]) {
        const vt = tag + variant + ": ";
        const ctx = await b.newContext(dev); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
        if (variant === "no-workers") await ctx.addInitScript(() => { window.Worker = undefined; });   // as if workers were unavailable
        await p.goto(LAN, { waitUntil: "load" }); await W(500);
        const env = await p.evaluate(() => ({ secure: window.isSecureContext, subtle: !!(window.crypto && window.crypto.subtle), fast: TDC.crypto.fast, sw: !!navigator.serviceWorker && !!navigator.serviceWorker.controller, cores: navigator.hardwareConcurrency }));
        if (variant === "workers") {
          ok(vt + "http://IP page: not a secure context, no crypto.subtle (the real phone situation)", !env.secure && !env.subtle && env.fast === false, env);
          const vis = await p.evaluate(() => { const n = document.getElementById("slowNote"); return { shown: !n.hidden, text: n.textContent.slice(0, 90) }; });
          ok(vt + "slow-mode note is shown, one line of plain words", vis.shown && /slow/i.test(vis.text), vis);
          await p.click("#slowNoteHow"); await W(150);
          const help = await p.evaluate(() => { const m = document.getElementById("pwaModal"); return { open: !m.hidden, text: m.textContent }; });
          ok(vt + "'How' opens the Install / use offline card with the iPhone steps and the https address", help.open && /Add to Home Screen/.test(help.text) && /shinrajp\.github\.io\/dashcam-studio/.test(help.text), { open: help.open });
          await p.evaluate(() => { document.getElementById("pwaModal").hidden = true; });
          await p.click("#slowNoteX"); await W(100);
          ok(vt + "note can be dismissed", await p.evaluate(() => document.getElementById("slowNote").hidden));
          await p.reload({ waitUntil: "load" }); await W(400);
          ok(vt + "dismissal is remembered after a reload", await p.evaluate(() => document.getElementById("slowNote").hidden));
          ok(vt + "no service worker on plain http", env.sw === false && await p.evaluate(async () => !navigator.serviceWorker || !(await navigator.serviceWorker.getRegistrations()).length));
        }
        // keys already known in this tab → the import step decrypts (this is what looked stuck at "Reading files")
        await p.evaluate((k) => { TDC.library.applyKeys(k); }, keyList);
        if (variant === "stuck-file") await p.evaluate(() => { TDC.library.readTimeout = 1500; const orig = Blob.prototype.arrayBuffer; Blob.prototype.arrayBuffer = function () { return this.__stuck ? new Promise(() => {}) : orig.call(this); }; const sl = Blob.prototype.slice; Blob.prototype.slice = function (...a) { const r = sl.apply(this, a); if (this.name && /-front\.mp4$/.test(this.name)) r.__stuck = true; return r; }; });
        await p.evaluate(() => {
          window.__texts = []; window.__gaps = []; let last = performance.now();
          setInterval(() => { const n = performance.now(); window.__gaps.push(n - last); last = n; }, 30);
          const busy = document.getElementById("busy"), bt = document.getElementById("busyText");
          new MutationObserver(() => { if (!busy.hidden) { const t = bt.textContent; if (window.__texts[window.__texts.length - 1] !== t) window.__texts.push(t); } }).observe(bt, { childList: true, characterData: true, subtree: true });
        });
        const t0 = Date.now();
        await p.setInputFiles("#folderInput", dir);
        await p.waitForFunction(() => document.getElementById("busy").hidden && TDC.library.events.length > 0, null, { timeout: 90000 }).catch(() => {});
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        const r = await p.evaluate(() => { const items = [...TDC.library.items.values()]; return { texts: window.__texts.slice(), maxGap: Math.max(0, ...window.__gaps.slice(2)), busy: !document.getElementById("busy").hidden, n: items.length, enc: items.filter((i) => i.kind === "encrypted").length, open: items.filter((i) => i.blob && i.kind === "encrypted").length, unknown: items.filter((i) => i.kind === "unknown").length, mode: TDC.crypto.lastMode, toast: document.getElementById("toast").textContent, locked: TDC.library.lockedCount() }; });
        console.log(`  ${vt}finished in ${secs}s · mode ${r.mode} · longest main-thread stall ${r.maxGap.toFixed(0)} ms · cores ${env.cores} · texts: ${r.texts.slice(0, 3).join(" | ").slice(0, 150)} … ${r.texts.slice(-1)[0]}`);
        ok(vt + "overlay is gone, nothing left spinning", !r.busy, r);
        if (variant !== "stuck-file") {
          ok(vt + "6 encrypted files read, all unlocked and playable", r.n === 6 && r.enc === 6 && r.open === 6 && r.locked === 0, r);
          ok(vt + "overlay showed 'Reading files… n of 6'", r.texts.some((t) => /Reading files… \d of 6/.test(t)), r.texts.slice(0, 6));
          ok(vt + "overlay showed 'Decrypting file i of 6 · %' progress (with speed once known)", r.texts.some((t) => /Decrypting file \d of 6 · \d+%/.test(t)), r.texts.slice(-6));
          ok(vt + "decrypt used " + (variant === "workers" ? "Web Workers (off the main thread)" : "the main-thread fallback"), variant === "workers" ? r.mode === "worker" : r.mode === "main", r.mode);
          ok(vt + "page stayed responsive (no main-thread stall over 400 ms)", r.maxGap < 400, r.maxGap);
          const prep = await p.evaluate(async () => { const ev = TDC.library.events[0]; await TDC.library.prepare(ev); const infos = []; for (const c of ev.clips) for (const it of Object.values(c.files)) infos.push(!!it.info); return { files: infos.length, demuxed: infos.filter(Boolean).length }; });
          ok(vt + "decrypted files are real MP4s (demux works for all 6)", prep.files === 6 && prep.demuxed === 6, prep);
        } else {
          ok(vt + "a file that never delivers its bytes: 5 others still load, the stuck one is reported", r.n === 6 && r.unknown === 1 && r.enc === 5, r);
          ok(vt + "error toast names the problem in plain words", /could not be read/i.test(r.toast), r.toast);
        }
        ok(vt + "no page errors", errs.length === 0, errs);
        await ctx.close();
      }
      // speed in this browser: same 12 MB synthetic encrypted file, new code vs old code (old = the pre-fix build, if OLD is given)
      const speed = async (url, label) => {
        const ctx = await b.newContext(dev); const p = await ctx.newPage(); await p.goto(url, { waitUntil: "load" }); await W(300);
        await p.evaluate(() => { const i = document.createElement("input"); i.type = "file"; i.id = "bigIn"; document.body.appendChild(i); });
        await p.setInputFiles("#bigIn", BIG);
        const res = await p.evaluate(async (MB) => {
          const f = document.getElementById("bigIn").files[0], key = new Uint8Array(16).fill(7), out = {};
          const run = async (opts) => { const t = performance.now(); const o = await TDC.crypto.decryptFile(f, f.size - 0x2000, key, opts); return { mb: (MB / ((performance.now() - t) / 1000)), size: o.size, mode: TDC.crypto.lastMode }; };
          out.main = await run({ noWorker: true });
          if (TDC.crypto.concurrency) { out.worker = await run({}); const t = performance.now(); await Promise.all([run({}), run({}), run({})]); out.worker3 = 3 * MB / ((performance.now() - t) / 1000); }
          return out;
        }, MB);
        await ctx.close(); console.log(`  ${tag}speed ${label}: ` + JSON.stringify(res, (k, v) => (typeof v === "number" ? +v.toFixed(1) : v))); return res;
      };
      const nw = await speed(LAN, "new");
      ok(tag + "new code: main-thread fallback runs at least 20 MB/s", nw.main.mb > 20, nw.main);
      if (OLD) { const ol = await speed(OLD, "old"); ok(tag + "new is far faster than old (>= 20x)", nw.main.mb / ol.main.mb >= 20, { new: nw.main.mb, old: ol.main.mb }); }
    }
    await b.close();
  }
  console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})();
