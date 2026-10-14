const puppeteer = require("puppeteer-core"); const fs = require("fs"); const https = require("https");
const dir = "/workspace/encfix/SentryClips/2026-10-05_09-00-00", files = fs.readdirSync(dir).map((f) => dir + "/" + f);
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const ctl = (path, body) => new Promise((res) => { const r = https.request({ host: "127.0.0.1", port: 8443, path, method: body ? "POST" : "GET", rejectUnauthorized: false }, (s) => { let d = ""; s.on("data", (c) => (d += c)); s.on("end", () => res(d)); }); if (body) r.write(JSON.stringify(body)); r.end(); });
async function scenario(name, opt) {
  await ctl("/__mode", opt);
  const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, userDataDir: "/tmp/tdc-cn-" + Date.now(),
    args: ["--no-sandbox", "--ignore-certificate-errors", "--host-resolver-rules=MAP dashcam.tesla.com:443 127.0.0.1:8443"] });
  const ctx = b.defaultBrowserContext();
  for (const o of ["http://127.0.0.1:8770", "https://dashcam.tesla.com"]) await ctx.overridePermissions(o, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
  const p = await b.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("dialog", (d) => d.accept());
  await p.goto("http://127.0.0.1:8770/index.html"); await W(500);
  if (opt.forgetFirst) await p.evaluate(() => localStorage.setItem("tdc.noClipboardApply", "1"));
  await (await p.$("#fileInput")).uploadFile(...files); await W(1500);
  if (opt.severOpener && !opt.severAtStart) { // after a sign-in redirect: connector stored the items earlier; opener is gone now
    const items = await p.evaluate(() => TDC.auth.items());
    await p.evaluate(() => { const o = window.open; window.open = (u, n, f) => { const w = o(u, n, f); TDC.__nonce = /gridplayer=([0-9a-f]+)/.exec(u)[1]; return w; }; });
    // we need the nonce before the page loads; pre-generate by patching crypto is overkill: reuse the nonce via a second request
    opt._items = items;
  }
  const popupP = new Promise((res) => { const h = async (t) => { if (t.type() !== "page") return; b.off("targetcreated", h); res(await t.page()); }; b.on("targetcreated", h); });
  await p.evaluate(() => { document.getElementById("unlockModal").hidden = false; document.getElementById("btnUnlockGo").click(); });
  const tp = await popupP;
  if (opt.severOpener && !opt.severAtStart) {
    const nonce = await p.evaluate(() => TDC.auth.job.nonce);
    await ctl("/__mode", { ...opt, preItems: { job: { nonce, gpo: "http://127.0.0.1:8770", ts: Date.now() }, items: { nonce, items: opt._items, batches: [opt._items], origin: "http://127.0.0.1:8770" } } });
    await tp.goto("https://dashcam.tesla.com/after-signin");
  }
  await W(opt.wait || 4000);
  const R = { name };
  R.badge = await tp.evaluate(() => (document.getElementById("tdc-connector-badge") || {}).textContent || null).catch(() => "closed");
  R.teslaBanner = await tp.evaluate(() => { const d = document.querySelector("div[role=status]"); return d ? d.innerText.slice(0, 110) : null; }).catch(() => "closed");
  if (opt.severOpener) {
    await tp.bringToFront();
    await tp.evaluate(() => [...document.querySelectorAll("div[role=status] button")].find((x) => !x.hidden).click()); await W(500);
    await p.bringToFront(); await p.evaluate(() => window.dispatchEvent(new Event("focus"))); await W(2500);
  }
  R.badgeCount = await tp.evaluate(() => document.querySelectorAll("#tdc-connector-badge").length).catch(() => "closed");
  R.batches = JSON.parse(await ctl("/__log"));
  R.appNotice = await p.evaluate(() => document.getElementById("unlockNotice").textContent.slice(0, 170));
  R.locked = await p.evaluate(() => TDC.library.events[0].locked); R.errs = errs;
  console.log(JSON.stringify(R)); await b.close();
}
(async () => {
  const only = process.argv[2];
  const S = { dupSpa: { token: false, duplicate: true, spaWipe: true, wait: 3500 }, safariWrapped: { token: true, wrapOpener: true, noDialogs: true }, safariNoOpener: { token: true, severOpener: true, severAtStart: true, noDialogs: true }, ok: { token: true }, notoken: { token: false, wait: 3000 }, refused: { token: true, refuse: true }, severed: { token: true, severOpener: true, forgetFirst: true }, noconnector: { noConnector: true, wait: 21500 } };
  for (const [k, v] of Object.entries(S)) if (!only || only === k) await scenario(k, v);
})();
