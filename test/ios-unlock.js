// iPhone / iPad Unlock card (js/ios-unlock.js + js/tesla-auth.js iOS wording), WebKit + Chromium, 430x932 iPhone UA,
// iPadOS "desktop" UA, and desktop (card hidden, old flow untouched). Uses synthetic encrypted clips + fake keys
// (/workspace/encfix, made by test/mkenc.js) and an in-memory clipboard.
// Usage: node test/ios-unlock.js [url]     BR=webkit,chromium   FIX=/workspace/encfix
const pw = require("playwright"); const fs = require("fs"), path = require("path");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.FIX || "/workspace/encfix", dir = path.join(FIX, "SentryClips/2026-10-05_09-00-00");
const files = fs.readdirSync(dir).map((f) => path.join(dir, f)); const KEYS = fs.readFileSync(path.join(FIX, "keys.json"), "utf8");
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? " " + JSON.stringify(x) : "")); if (!c) fails++; };
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const PROFILES = [
  { name: "iPhone 430x932", ios: true, opts: { viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, userAgent: IPHONE_UA, deviceScaleFactor: 3 } },
  { name: "iPad (desktop UA)", ios: true, opts: { viewport: { width: 1024, height: 768 }, hasTouch: true, userAgent: MAC_UA }, init: "Object.defineProperty(navigator,'platform',{get:()=>'MacIntel'});Object.defineProperty(navigator,'maxTouchPoints',{get:()=>5});" },
  { name: "Mac desktop", ios: false, opts: { viewport: { width: 1280, height: 800 }, userAgent: MAC_UA } },
];
// in-memory clipboard (deterministic in both engines; tap-gesture rules are not what is under test)
const CLIP_INIT = `(()=>{const c={text:"",deny:false};window.__clip=c;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>{c.text=String(t)},readText:async()=>{if(c.deny)throw new DOMException('denied','NotAllowedError');return c.text}}});})();`;

(async () => {
  for (const bn of (process.env.BR || "webkit,chromium").split(",")) {
    const b = await pw[bn].launch(bn === "chromium" ? { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] } : {});
    for (const prof of PROFILES) {
      const tag = bn + " " + prof.name + ": ";
      const ctx = await b.newContext(prof.opts); await ctx.addInitScript(CLIP_INIT + (prof.init || ""));
      const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("dialog", (d) => d.accept());
      await p.goto(URL_, { waitUntil: "load" }); await p.setInputFiles("#fileInput", files); await W(1800);
      const locked = () => p.evaluate(() => TDC.library.lockedCount());
      ok(tag + "4 encrypted clips waiting", (await locked()) === 4, await locked());
      await p.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return { closed: false, close() {} }; }; });
      await p.click("#btnUnlock"); await W(300);
      const vis = (sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return !e.hidden && r.width > 0 && r.height > 0; }, sel);
      ok(tag + "iOS card " + (prof.ios ? "shown" : "hidden"), (await vis("#iosUnlock")) === prof.ios, await vis("#iosUnlock"));
      if (!prof.ios) {
        ok(tag + "old flow untouched: Copy key helper, Paste keys, in-app import all there", await p.evaluate(() => !!document.getElementById("btnCopyHelper") && !!document.getElementById("pasteKeys") && !!document.getElementById("btnInAppApply")));
        // unlock via the old Apply keys path still works
        await p.evaluate((k) => { document.getElementById("pasteKeys").value = k; document.getElementById("btnApplyKeys").click(); }, KEYS); await W(1500);
        ok(tag + "old Apply keys still decrypts all 4", (await locked()) === 0, await locked());
        // desktop: sign in → connector-not-detected path unchanged (setup shown, no iOS card)
        ok(tag + "no page errors", errs.length === 0, errs); await ctx.close(); continue;
      }
      // card content
      ok(tag + "card has Copy bookmarklet, Copy unlock request, big Paste keys from clipboard", await p.evaluate(() => ["btnCopyBookmarklet", "btnCopyUnlockRequest", "btnPasteKeysClip"].every((i) => document.getElementById(i) && document.getElementById(i).offsetHeight > 0)));
      const card = await p.evaluate(() => { const c = document.getElementById("iosUnlock"); return { text: c.textContent, ols: c.querySelectorAll("ol").length, sw: c.scrollWidth, cw: c.clientWidth }; });
      ok(tag + "steps mention bookmark + Edit + paste + Userscripts App Store alternative", /Add Bookmark/.test(card.text) && /Edit/.test(card.text) && /paste/i.test(card.text) && /Userscripts/.test(card.text) && /App Store/.test(card.text) && card.ols >= 2);
      ok(tag + "no horizontal overflow in the card", card.sw <= card.cw + 1, card);
      const tall = await p.evaluate(() => ["btnCopyBookmarklet", "btnCopyUnlockRequest", "btnPasteKeysClip"].map((i) => document.getElementById(i).getBoundingClientRect().height));
      ok(tag + "buttons are tap-sized (>= 40 px; Paste >= 48)", tall[0] >= 40 && tall[1] >= 40 && tall[2] >= 48, tall);
      const pg = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ok(tag + "page doesn't scroll sideways", pg <= 1, pg);
      await p.screenshot({ path: (process.env.SHOTS || "/tmp") + "/ios-unlock-" + bn + "-" + prof.name.split(" ")[0] + ".png" }).catch(() => {});
      // Copy bookmarklet
      await p.click("#btnCopyBookmarklet"); await W(200);
      let st = await p.evaluate(() => ({ clip: window.__clip.text, bm: TDC.IOS_BOOKMARKLET, n: document.getElementById("iosNotice").textContent, k: document.getElementById("iosNotice").className }));
      ok(tag + "Copy bookmarklet copies the javascript: code", st.clip === st.bm && st.clip.startsWith("javascript:") && st.clip.length > 1000, st.clip.slice(0, 30));
      ok(tag + "…and tells how to make the bookmark", /Add Bookmark/.test(st.n) && /ok/.test(st.k), st.n);
      // Copy unlock request
      await p.click("#btnCopyUnlockRequest"); await W(200);
      const req = await p.evaluate(() => window.__clip.text);
      const m = /^https:\/\/dashcam\.tesla\.com\/#gridplayer=([0-9a-f]{32})&gpo=([^&]+)&gpi=([\w-]+)$/.exec(req);
      let items = null; try { items = JSON.parse(Buffer.from(m[3].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")).items; } catch (_) {}
      ok(tag + "Copy unlock request: Tesla address with nonce, player origin, and the 4 clip requests", !!m && items && items.length === 4 && items[0].wrapped_key && !/Bearer|access_token|\.eyJ/.test(req + JSON.stringify(items)), req.slice(0, 80));
      ok(tag + "…gpo is this page's origin", m && decodeURIComponent(m[2]) === new URL(URL_).origin, m && m[2]);
      // Paste keys: good
      await p.evaluate((k) => { window.__clip.text = k; }, KEYS);
      await p.click("#btnPasteKeysClip"); await W(2500);
      st = await p.evaluate(() => ({ n: document.getElementById("iosNotice").textContent, k: document.getElementById("iosNotice").className, un: document.getElementById("unlockNotice").textContent }));
      ok(tag + "Paste keys from clipboard applies + decrypts all 4 clips", (await locked()) === 0 && /Applied 4 key/.test(st.n) && /ok/.test(st.k), [await locked(), st]);
      ok(tag + "…decrypted clips are playable blobs", await p.evaluate(() => [...TDC.library.items.values()].filter((i) => i.kind === "encrypted").every((i) => i.blob && i.blob.size > 1000)));
      // Paste keys: bad inputs (reload state not needed: the messages come before applying)
      const bad = async (label, text, re, deny) => {
        await p.evaluate(([t, d]) => { window.__clip.text = t; window.__clip.deny = !!d; }, [text, deny]);
        await p.click("#btnPasteKeysClip"); await W(250);
        const n = await p.evaluate(() => ({ t: document.getElementById("iosNotice").textContent, k: document.getElementById("iosNotice").className }));
        ok(tag + "Paste keys: " + label, re.test(n.t) && /err/.test(n.k), n);
        await p.evaluate(() => { window.__clip.deny = false; });
      };
      await bad("a Tesla token is refused (never fetched / stored)", "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ", /sign-in token, not keys/);
      await bad("an unlock request is recognised", req, /unlock request, not the keys/);
      await bad("garbage / empty clipboard", "hello", /doesn't hold keys/);
      await bad("empty clipboard", "", /doesn't hold keys/);
      await bad("keys that match no loaded clip", JSON.stringify({ results: [{ id: "nope", key: "AAAAAAAAAAAAAAAAAAAAAA==" }] }), /don't match/);
      await bad("clipboard read denied → paste-box fallback", "", /Touch and hold the box/, true);
      ok(tag + "…and the paste box is focused", await p.evaluate(() => document.activeElement && document.activeElement.id === "inAppKeyText"));
      // Sign in with Tesla on iOS: opens Tesla, leaves the unlock request on the clipboard, iOS wording
      await p.evaluate(() => { document.getElementById("iosNotice").hidden = true; window.__clip.text = "x"; TDC.library.items.forEach((i) => { if (i.kind === "encrypted") { i.blob = null; } }); TDC.library.keyCache.clear(); });
      ok(tag + "(re-locked for the sign-in check)", (await locked()) === 4, await locked());
      await p.click("#btnUnlockGo"); await W(300);
      const o = await p.evaluate(() => ({ opened: window.__opened.slice(-1)[0], clip: window.__clip.text, n: document.getElementById("unlockNotice").textContent }));
      ok(tag + "Sign in with Tesla opens dashcam.tesla.com with the #gridplayer hash", /^https:\/\/dashcam\.tesla\.com\/#gridplayer=[0-9a-f]{32}&gpo=.*&gpi=/.test(o.opened || ""), (o.opened || "").slice(0, 60));
      ok(tag + "…and leaves the same unlock request on the clipboard", o.clip === o.opened);
      ok(tag + "…iOS notice: new tab, bookmark, Paste keys from clipboard", /new tab/.test(o.n) && /Dashcam Unlock/.test(o.n) && /Paste keys from clipboard/.test(o.n), o.n);
      if (!process.env.FAST) {
        await W(20500);
        const nd = await p.evaluate(() => ({ n: document.getElementById("unlockNotice").textContent, k: document.getElementById("unlockNotice").className, setup: !document.getElementById("connectorSetup").hidden, card: !document.getElementById("iosUnlock").hidden }));
        ok(tag + "connector not detected (20 s): iPhone wording, mentions bookmark + Userscripts-free explanation, card kept, Mac setup not shown", /normal on iPhone/.test(nd.n) && /Dashcam Unlock/.test(nd.n) && /Paste keys from clipboard/.test(nd.n) && !/Develop|Option-Command/.test(nd.n) && nd.card && !nd.setup && /err/.test(nd.k), nd);
      }
      ok(tag + "no page errors", errs.length === 0, errs);
      await ctx.close();
    }
    await b.close();
  }
  console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
