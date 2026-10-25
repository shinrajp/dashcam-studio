// "Manual console method" polish in the Unlock dialog (js/unlock-ux.js): device-aware steps, numbered cards, paste → auto-apply
// (tolerates console noise), plain-English results, Advanced collapsed, and the ORIGINAL paths still working end to end
// (Apply keys button with plain keys JSON, real decrypt of synthetic encrypted clips). Mock data only (/workspace/encfix, made by
// test/mkenc.js: 4 synthetic encrypted Sentry clips + fake keys).
// Usage: node test/unlock-ux.js [url]     BR=chromium|webkit (one per process)   FIX=/workspace/encfix   SHOTS=<dir for screenshots>
//   Without a url it serves this repo itself (python3 -m http.server on PORT, default 8793).
const pw = require("playwright"); const fs = require("fs"), path = require("path"), cp = require("child_process");
const FIX = process.env.FIX || "/workspace/encfix", dir = path.join(FIX, "SentryClips/2026-10-05_09-00-00");
const files = fs.readdirSync(dir).map((f) => path.join(dir, f)); const KEYS = JSON.parse(fs.readFileSync(path.join(FIX, "keys.json"), "utf8"));
const SHOTS = process.env.SHOTS || ""; if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? " " + JSON.stringify(x) : "")); if (!c) fails++; };
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const PROFILES = {
  mac: { dev: "mac", opts: { viewport: { width: 1280, height: 800 }, userAgent: MAC_UA }, init: "Object.defineProperty(navigator,'platform',{get:()=>'MacIntel'});" },
  pc: { dev: "pc", opts: { viewport: { width: 1280, height: 800 }, userAgent: WIN_UA }, init: "Object.defineProperty(navigator,'platform',{get:()=>'Win32'});" },
  iphone: { dev: "phone", opts: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: IPHONE_UA, deviceScaleFactor: 2 } },
};
const CLIP_INIT = `(()=>{const c={text:""};window.__clip=c;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>{c.text=String(t)},readText:async()=>c.text}});})();`;
const sub = (ids) => ({ results: KEYS.results.filter((_, i) => ids.includes(i)) });

(async () => {
  let server = null, URL_ = process.argv[2];
  if (!URL_) { const port = process.env.PORT || 8793; server = cp.spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: path.join(__dirname, ".."), stdio: "ignore" }); URL_ = `http://127.0.0.1:${port}/index.html`; await W(900); }
  const bn = process.env.BR || "chromium";
  const b = await pw[bn].launch(bn === "chromium" ? { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] } : {});
  async function open(profName, extra) {
    const prof = PROFILES[profName], opts = Object.assign({}, prof.opts, extra || {});
    const ctx = await b.newContext(opts); await ctx.addInitScript(CLIP_INIT + (prof.init || ""));
    const p = await ctx.newPage(); const errs = [], dialogs = [];
    p.on("pageerror", (e) => errs.push(e.message)); p.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
    await p.goto(URL_ + (URL_.includes("?") ? "&" : "?") + "nosw=1", { waitUntil: "load" }); await p.setInputFiles("#fileInput", files); await W(1800);
    await p.evaluate(() => { const t = document.getElementById("toast"); if (t) t.style.display = "none"; });
    await p.click("#btnUnlock"); await W(300);
    return { ctx, p, errs, dialogs };
  }
  const locked = (p) => p.evaluate(() => TDC.library.lockedCount());
  const vis = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return !e.hidden && cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0; }, sel);
  const txt = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return e ? e.innerText : ""; }, sel);
  const shot = async (p, name) => { if (!SHOTS) return; await p.evaluate(() => { const c = document.querySelector("#unlockModal .modal-card"); const m = document.querySelector("details.manual"); c.scrollTop = m.offsetTop - 60; }); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
  const paste = async (p, text, kind) => { // kind "paste": a real paste gesture's events; "type": input only
    await p.evaluate(([t, k]) => { const ta = document.getElementById("pasteKeys"); ta.value = t; if (k === "paste") ta.dispatchEvent(new Event("paste", { bubbles: true })); ta.dispatchEvent(new Event("input", { bubbles: true })); }, [text, kind]);
  };
  const result = (p) => p.evaluate(() => { const r = document.getElementById("uxResult"); return { t: r.textContent, k: r.className, hidden: r.hidden, still: [...document.querySelectorAll("#uxStill li")].map((l) => l.textContent) }; });

  // ───────── 1. Mac: steps, cards, Advanced ─────────
  { const { ctx, p, errs } = await open("mac"); const tag = bn + " mac: ";
    ok(tag + "detected Mac", (await p.getAttribute("#uxManual", "data-dev")) === "mac" && /Mac/.test(await txt(p, "#uxDeviceName")));
    ok(tag + "section is still the open details.manual", await p.evaluate(() => { const d = document.querySelector("details.manual"); return !!d && d.open && /Manual console method/.test(d.querySelector("summary").textContent); }));
    ok(tag + "four numbered cards", (await p.locator("#uxSteps > li.ux-card").count()) === 4);
    const heads = await p.$$eval("#uxSteps > li h4", (e) => e.map((x) => x.textContent.trim()));
    ok(tag + "card titles: copy helper / open Tesla / console / paste result", /Copy the helper/.test(heads[0]) && /Open Tesla/.test(heads[1]) && /console/i.test(heads[2]) && /Paste the result/.test(heads[3]), heads);
    ok(tag + "Copy key helper, Open dashcam.tesla.com, paste box, Apply keys all visible", (await Promise.all(["#btnCopyHelper", "#uxOpenTesla", "#pasteKeys", "#btnApplyKeys"].map((s) => vis(p, s)))).every(Boolean));
    const a = await p.$eval("#uxOpenTesla", (e) => ({ h: e.href, t: e.target, r: e.rel }));
    ok(tag + "Open dashcam.tesla.com: new tab, rel=noopener", a.h === "https://dashcam.tesla.com/" && a.t === "_blank" && /noopener/.test(a.r), a);
    const s3 = await txt(p, "#uxSteps > li:nth-child(3)");
    ok(tag + "Mac step: Safari Develop menu + shortcut + the one-time Advanced setting", /Develop/.test(s3) && /⌥⌘C/.test(s3) && /Show features for web developers/.test(s3) && /Settings/.test(s3), s3);
    ok(tag + "PC-only text hidden on a Mac", !/Ctrl\+Shift\+J/.test(s3));
    const main = await txt(p, "#uxManual"), adv0 = await p.$eval("#uxAdvanced", (d) => d.open);
    ok(tag + "Advanced is collapsed", adv0 === false);
    const mainVisible = await p.evaluate(() => { const w = document.getElementById("uxManual").cloneNode(true); w.querySelector("#uxAdvanced")?.remove(); w.querySelector(".ux-phone")?.remove(); return w.innerText; });
    ok(tag + "no CORS / 'undocumented' jargon outside Advanced", !/CORS|undocumented|untested/i.test(mainVisible), mainVisible.match(/CORS|undocumented|untested/i));
    ok(tag + "privacy line: stays on this device, never uploaded", /stay on this device and are never uploaded/.test(main));
    const pj = await p.$eval("#pendingItemsJson", (t) => ({ ro: t.readOnly, n: JSON.parse(t.value).length, inAdv: !!t.closest("#uxAdvanced"), collapsed: !t.closest("#uxAdvanced").open }));
    ok(tag + "pending-requests textarea still in the DOM (inside Advanced, hidden, 4 requests)", pj.n === 4 && pj.ro && pj.inAdv && pj.collapsed, pj);
    ok(tag + "CORS wording + undocumented note live in Advanced", await p.evaluate(() => { const t = document.getElementById("uxAdvanced").textContent; return /CORS/.test(t) && /undocumented/.test(t); }));
    ok(tag + "step 1 says how many clips are waiting", /4 encrypted clips are waiting/.test(await txt(p, "#uxNeed")));
    // a11y
    ok(tag + "labels + live regions", await p.evaluate(() => !!document.querySelector('label[for="pasteKeys"]') && !!document.querySelector('label[for="pendingItemsJson"]') && ["uxResult", "uxCopyNote"].every((i) => document.getElementById(i).getAttribute("aria-live") === "polite" && document.getElementById(i).getAttribute("role") === "status")));
    // toggle to other devices
    await p.click("#uxDeviceToggle"); ok(tag + "'Show steps for another device' reveals the picker", (await vis(p, "#uxDevicePick")) && (await p.getAttribute("#uxDeviceToggle", "aria-expanded")) === "true");
    await p.click('[data-pick="pc"]'); let t3 = await txt(p, "#uxSteps > li:nth-child(3)");
    ok(tag + "pick PC → Ctrl+Shift+J / Firefox shortcut, no Safari text", /Ctrl\+Shift\+J/.test(t3) && /Ctrl\+Shift\+K/.test(t3) && !/Develop/.test(t3), t3);
    ok(tag + "…picked button is pressed", (await p.getAttribute('[data-pick="pc"]', "aria-pressed")) === "true" && (await p.getAttribute('[data-pick="mac"]', "aria-pressed")) === "false");
    await p.click('[data-pick="phone"]');
    ok(tag + "pick iPhone/iPad → steps hidden, plain 'no console' message", !(await vis(p, "#uxSteps")) && (await vis(p, "#uxPhoneNote")) && /no developer console/.test(await txt(p, "#uxPhoneNote")));
    ok(tag + "…bookmark option hidden on a Mac (the iPhone card only exists on iOS), Mac/PC fallback offered", !(await vis(p, "#uxPhoneBookmark")) && /Mac or a PC/.test(await txt(p, "#uxPhoneNote")));
    await p.click("#uxShowMac"); ok(tag + "'Show steps for a Mac or PC' brings the steps back", (await vis(p, "#uxSteps")) && (await p.getAttribute("#uxManual", "data-dev")) === "mac");
    // copy helper
    await p.click("#btnCopyHelper"); await W(600);
    const cl = await p.evaluate(() => ({ clip: window.__clip.text, helper: TDC.auth.helperSource(), note: document.getElementById("uxCopyNote").textContent }));
    ok(tag + "Copy key helper copies the unchanged helper snippet (results JSON output format)", cl.clip === cl.helper && /\{ results \}/.test(cl.clip) && /JSON\.stringify\(\{ results \}\)/.test(cl.clip) && /\/api\/1\/decrypt\/batch/.test(cl.clip), cl.clip.slice(0, 60));
    ok(tag + "…and says so next to the button", /Copied/.test(cl.note), cl.note);
    ok(tag + "no page errors", errs.length === 0, errs); await ctx.close(); }

  // ───────── 2. PC and iPhone defaults ─────────
  { const { ctx, p, errs } = await open("pc"); const tag = bn + " pc: ";
    const t3 = await txt(p, "#uxSteps > li:nth-child(3)");
    ok(tag + "detected Windows/Linux PC, PC steps, no Mac text", (await p.getAttribute("#uxManual", "data-dev")) === "pc" && /Ctrl\+Shift\+J/.test(t3) && !/⌥⌘/.test(t3) && !/Develop/.test(t3), t3);
    ok(tag + "'allow pasting' hint shown", /allow pasting/.test(await txt(p, "#uxSteps")));
    ok(tag + "no page errors", errs.length === 0, errs); await ctx.close(); }
  { const { ctx, p, errs } = await open("iphone"); const tag = bn + " iphone: ";
    ok(tag + "detected iPhone → no-console message, steps hidden", (await p.getAttribute("#uxManual", "data-dev")) === "phone" && !(await vis(p, "#uxSteps")) && /no developer console/.test(await txt(p, "#uxPhoneNote")));
    ok(tag + "points at the Dashcam Unlock bookmark (iOS card shown)", (await vis(p, "#iosUnlock")) && (await vis(p, "#uxPhoneBookmark")) && /Dashcam Unlock bookmark/.test(await txt(p, "#uxPhoneBookmark")));
    await p.click("#uxGoBookmark"); await W(500);
    ok(tag + "…'Show the bookmark steps' scrolls to the iPhone card", await p.evaluate(() => { const r = document.getElementById("iosUnlock").getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }));
    ok(tag + "old iPhone flow untouched (bookmark buttons, paste from clipboard, in-app import)", (await Promise.all(["#btnCopyBookmarklet", "#btnCopyUnlockRequest", "#btnPasteKeysClip", "#btnInAppApply"].map((s) => p.$(s)))).every(Boolean));
    await p.evaluate(() => document.getElementById("unlockModal").querySelector(".modal-card").scrollTo(0, 0));
    await p.click("#uxShowMac").catch(() => {}); // may need scrolling; use the picker route as the fallback
    await p.evaluate(() => document.getElementById("uxShowMac").click()); await W(100);
    ok(tag + "'Show steps for a Mac or PC' reveals the steps on the phone too", await vis(p, "#uxSteps"));
    // layout at 390
    const lay = await p.evaluate(() => { const c = document.querySelector("#unlockModal .modal-card"); const h = (id) => document.getElementById(id).getBoundingClientRect().height; return { cardOver: c.scrollWidth - c.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth, copy: h("btnCopyHelper"), open: h("uxOpenTesla"), apply: h("btnApplyKeys"), font: parseFloat(getComputedStyle(document.getElementById("pasteKeys")).fontSize) }; });
    ok(tag + "390px: no sideways scroll", lay.cardOver <= 1 && lay.page <= 1, lay);
    ok(tag + "390px: big tap targets (>=44px) and 16px paste box (no iOS zoom)", lay.copy >= 44 && lay.open >= 44 && lay.apply >= 44 && lay.font >= 16, lay);
    ok(tag + "no page errors", errs.length === 0, errs); await ctx.close(); }

  // ───────── 3. failure messages (Apply keys button) ─────────
  { const { ctx, p, errs, dialogs } = await open("mac"); const tag = bn + " messages: ";
    const click = async (text) => { await p.evaluate((t) => { document.getElementById("pasteKeys").value = t; }, text); await p.click("#btnApplyKeys"); await W(300); return result(p); };
    let r = await click(""); ok(tag + "empty → 'Nothing to apply yet'", /Nothing to apply yet/.test(r.t) && /err/.test(r.k) && !r.hidden, r);
    r = await click("hello from the console"); ok(tag + "not JSON → plain English, no JSON.parse error", /doesn't look like the helper's result/.test(r.t) && !/Unexpected|position|SyntaxError/.test(r.t), r);
    r = await click("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ"); ok(tag + "token → refused, explains", /sign-in token, not keys/.test(r.t), r);
    r = await click('{"foo":1}'); ok(tag + "wrong shape → 'no keys in it'", /no keys in it/.test(r.t), r);
    r = await click('{"results":[]}'); ok(tag + "empty results → 'no keys in it'", /no keys in it/.test(r.t), r);
    r = await click("https://dashcam.tesla.com/#gridplayer=abcdef&gpi=1"); ok(tag + "unlock request → recognised", /unlock request, not the keys/.test(r.t), r);
    r = await click(JSON.stringify({ results: [{ id: "nope", key: "AAAAAAAAAAAAAAAAAAAAAA==" }] }));
    ok(tag + "ids that match no clip → 'None of these keys match', lists the 4 clips still locked", /None of these keys match/.test(r.t) && /err/.test(r.k) && r.still.length === 4 && r.still.every((n) => /\.mp4$/.test(n)), r);
    ok(tag + "all of those left the clips locked, with no browser alert() popups", (await locked(p)) === 4 && dialogs.length === 0, [await locked(p), dialogs]);
    await shot(p, "after-desktop-failure");
    ok(tag + "no page errors", errs.length === 0, errs); await ctx.close(); }

  // ───────── 4. auto-apply with messy text, partial then rest ─────────
  { const { ctx, p, errs, dialogs } = await open("mac"); const tag = bn + " auto-apply: ";
    const A = JSON.stringify(sub([0, 1])), B = JSON.stringify(sub([2, 3]));
    await paste(p, "garbage that is only typed", "type"); await W(900);
    ok(tag + "typing half-finished text shows no nagging message", (await result(p)).hidden);
    await paste(p, '{"results":[{"id":', "type"); await W(900);
    ok(tag + "…incomplete JSON typed → still quiet, nothing unlocked", (await result(p)).hidden && (await locked(p)) === 4);
    await paste(p, "< " + A + "\nundefined", "paste"); await W(2500);
    let r = await result(p);
    ok(tag + "pasting '< {…}' + 'undefined' applies by itself (no button) → '2 of 4 clips unlocked'", /\b2 of 4 clips unlocked/.test(r.t) && (await locked(p)) === 2, [r, await locked(p)]);
    ok(tag + "…and lists the 2 clips that still need keys", r.still.length === 2 && /still need keys/.test(r.t), r);
    await shot(p, "after-desktop-partial");
    await paste(p, "```json\n\"" + B.replace(/"/g, '\\"') + "\"\n```", "paste"); await W(2500);
    r = await result(p);
    ok(tag + "pasting a code fence + quoted \\\" escaped JSON unlocks the rest → '2 of 2 clips unlocked'", /2 of 2 clips unlocked/.test(r.t) && /ok/.test(r.k) && (await locked(p)) === 0 && r.still.length === 0, [r, await locked(p)]);
    await shot(p, "after-desktop-success");
    ok(tag + "…all four clips decrypted into playable blobs", await p.evaluate(() => [...TDC.library.items.values()].filter((i) => i.kind === "encrypted").every((i) => i.blob && i.blob.size > 1000)));
    await p.evaluate(() => document.getElementById("btnApplyKeys").click()); await W(400);
    ok(tag + "Apply keys again with everything unlocked → 'already unlocked'", /already unlocked/.test((await result(p)).t));
    ok(tag + "no page errors, no alert() popups", errs.length === 0 && dialogs.length === 0, [errs, dialogs]); await ctx.close(); }

  // ───────── 5. each messy form parses (page-side, fast) ─────────
  { const { ctx, p, errs } = await open("mac"); const tag = bn + " messy forms: ";
    const J = JSON.stringify(sub([0]));
    const forms = { plain: J, "double quotes": '"' + J.replace(/"/g, '\\"') + '"', "single quotes": "'" + J + "'", "fence": "```\n" + J + "\n```", "'< ' prefix": "< " + J, "undefined after": J + "\nundefined", "whitespace": "  \n\t " + J + " \n ", "log lines around": "Batch 1/1 (4 files): HTTP 200\n✓ Keys sent to Dashcam Studio\n" + J + "\nPromise {<fulfilled>: undefined}", "bare array": JSON.stringify(sub([0]).results), "smart quotes": J.replace(/"/g, "\u201c"), "HTTP prefix": "HTTP 200 " + J };
    const res = await p.evaluate((f) => Object.fromEntries(Object.entries(f).map(([k, v]) => { const r = TDC.keyImport.parseLoose(v); return [k, r.kind + ":" + (r.results ? r.results.length : "")]; })), forms);
    for (const k of Object.keys(forms)) ok(tag + k, res[k] === "keys:1", res[k]);
    const same = await p.evaluate(() => { const K = TDC.keyImport; const t = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ"; return [K.parse(t).kind, K.parseLoose(t).kind, K.parse("nope").kind, K.parseLoose("nope").kind, K.parse('{"results":[1]}').kind]; });
    ok(tag + "original K.parse unchanged (token / bad / keys)", same[0] === "token" && same[1] === "token" && same[2] === "bad" && same[3] === "bad" && same[4] === "keys", same);
    ok(tag + "no page errors", errs.length === 0, errs); await ctx.close(); }

  // ───────── 6. ORIGINAL path: keys set directly + Apply keys button; decrypt is byte-exact ─────────
  { const { ctx, p, errs } = await open("mac"); const tag = bn + " original path: ";
    await p.evaluate((k) => { document.getElementById("pasteKeys").value = k; document.getElementById("btnApplyKeys").click(); }, JSON.stringify(KEYS)); await W(2500);
    ok(tag + "old way (value set + Apply keys click, no events) unlocks all 4", (await locked(p)) === 0, await locked(p));
    ok(tag + "…and reports '4 of 4 clips unlocked'", /4 of 4 clips unlocked/.test((await result(p)).t), await result(p));
    const base = "/workspace/fixtures/base.mp4";
    if (fs.existsSync(base)) { const want = fs.statSync(base).size; ok(tag + "decrypted files are exactly the original size", await p.evaluate((n) => [...TDC.library.items.values()].filter((i) => i.kind === "encrypted").every((i) => i.blob && i.blob.size === n), want)); }
    ok(tag + "decrypt produced an MP4 (ftyp box)", await p.evaluate(async () => { const it = [...TDC.library.items.values()].find((i) => i.kind === "encrypted"); const u = new Uint8Array(await it.blob.slice(0, 12).arrayBuffer()); return String.fromCharCode(...u.slice(4, 8)) === "ftyp"; }));
    ok(tag + "no page errors", errs.length === 0, errs); await ctx.close(); }
  { // the iOS-style / in-app import box still shares the same parser: token / keys paths intact
    const { ctx, p, errs } = await open("mac"); const tag = bn + " in-app import: ";
    await p.fill("#inAppKeyText", JSON.stringify(KEYS)); await p.click("#btnInAppApply"); await W(2500);
    ok(tag + "'Unlock with pasted keys / token' still unlocks all 4", (await locked(p)) === 0, await locked(p));
    ok(tag + "no page errors", errs.length === 0, errs); await ctx.close(); }

  // ───────── 7. screenshots (mock data only) ─────────
  if (SHOTS) {
    for (const [name, prof, extra, set] of [["after-desktop-steps", "mac", { viewport: { width: 1280, height: 1500 } }], ["after-390-steps", "mac", { viewport: { width: 390, height: 1900 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }], ["after-390-iphone", "iphone", { viewport: { width: 390, height: 1900 } }], ["after-390-pc-picker", "pc", { viewport: { width: 390, height: 1900 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, async (p) => { await p.click("#uxDeviceToggle"); }]]) {
      const { ctx, p } = await open(prof, extra); if (set) await set(p); await shot(p, name); await ctx.close(); }
    const { ctx, p } = await open("mac", { viewport: { width: 390, height: 1900 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await paste(p, "< " + JSON.stringify(sub([0, 1])) + "\nundefined", "paste"); await W(2500); await shot(p, "after-390-partial");
    await paste(p, JSON.stringify(sub([2, 3])), "paste"); await W(2500); await shot(p, "after-390-success"); await ctx.close();
  }
  await b.close(); if (server) server.kill();
  console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
