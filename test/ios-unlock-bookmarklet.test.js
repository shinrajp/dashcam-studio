// Unit test for connector/ios-unlock-bookmarklet.js and the generated bookmarklet (js/ios-unlock-src.js), in a vm
// with a tiny fake DOM and a mocked fetch. Covers: request from #hash / sessionStorage / clipboard, origin pinning of
// postMessage, the token never leaving the page (not in postMessage, clipboard or overlay), error states.
// Usage: node test/ios-unlock-bookmarklet.test.js
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const root = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(root, "connector/ios-unlock-bookmarklet.js"), "utf8");
const gen = {}; vm.runInNewContext(fs.readFileSync(path.join(root, "js/ios-unlock-src.js"), "utf8"), { window: gen });
const BOOKMARKLET = decodeURIComponent(gen.TDC.IOS_BOOKMARKLET.replace(/^javascript:/, "")); // what the browser runs
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? " " + JSON.stringify(x) : "")); if (!c) fails++; };
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
const W_ = (ms) => new Promise((r) => setTimeout(r, ms));

function el() {
  const e = { style: {}, children: [], hidden: false, textContent: "", id: "", onclick: null, removed: false,
    append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); }, remove() { this.removed = true; } };
  return e;
}
function b64u(o) { return Buffer.from(JSON.stringify(o), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
const ITEMS = [{ id: "r1", vin: "TESTVIN0000000001", key_id: "k1", timestamp: 1, wrapped_key: "AAAA", public_key: "BBBB" }, { id: "r2", vin: "TESTVIN0000000001", key_id: "k2", timestamp: 2, wrapped_key: "CCCC", public_key: "DDDD" }];
const hashFor = (gpo, items = ITEMS) => `#gridplayer=0123456789abcdef0123456789abcdef&gpo=${encodeURIComponent(gpo)}&gpi=${b64u({ items, batches: [items] })}`;

/** Run the code (source or generated) in a fresh fake page. opts: hash, host, session, local, cookie, clip, fetch, opener */
async function page(code, o = {}) {
  const body = el(), all = [];
  const store = (init) => { const m = new Map(Object.entries(init || {})); return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; };
  const posted = [], clip = { text: o.clip, writes: [] }, fetches = [];
  const opener = o.opener === undefined ? null : o.opener === "open" ? { closed: false, postMessage: (d, t) => posted.push({ d, t }) } : o.opener;
  const document_ = { body, cookie: o.cookie || "", getElementById: () => null, createElement: () => { const e = el(); all.push(e); return e; },
    execCommand: () => false };
  const loc = { hostname: o.host || "dashcam.tesla.com", hash: o.hash || "", pathname: "/", search: "" };
  const win = { document: document_, navigator: null, sessionStorage: store(o.session), localStorage: store(o.local), opener, location: loc, __x: 1 };
  const navigator_ = { clipboard: {
    readText: () => (o.clip === undefined ? Promise.reject(new Error("denied")) : Promise.resolve(clip.text)),
    writeText: (t) => { clip.writes.push(t); return o.clipFail ? Promise.reject(new Error("no")) : Promise.resolve(); } } };
  win.navigator = navigator_;
  const fetch_ = async (url, init) => { fetches.push({ url, init }); return o.fetch ? o.fetch(url, init, fetches.length) : { ok: true, status: 200, json: async () => ({ results: [{ id: "r1", key: "a2V5MTIzNDU2Nzg5MDEyMw==" }, { id: "r2", key: "b3RoZXJrZXkxMjM0NTY3OA==" }] }) }; };
  const ctx = { window: win, document: document_, navigator: navigator_, location: loc, history: { state: null, replaceState: (s, t, u) => { loc.hash = ""; loc._replaced = u; } }, fetch: fetch_, URL, escape, atob, Date, JSON, console,
    sessionStorage: win.sessionStorage, localStorage: win.localStorage, Promise, Array, Number, String, Object, Math, decodeURIComponent, encodeURIComponent, setTimeout };
  win.history = ctx.history; win.fetch = fetch_;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  await W_(30);
  const overlay = body.children[0];
  const btn = () => overlay.children[2], msg = () => overlay.children[1].textContent;
  return { overlay, btn, msg, posted, clip, fetches, win, loc, all, W_, everything: () => JSON.stringify([overlay && overlay.children.map((c) => c.textContent), clip.writes, posted]) };
}

(async () => {
  for (const [label, code] of [["source", SRC], ["generated", BOOKMARKLET]]) {
    const P = label + ": ";
    // 1. request from the page address, signed in (token in localStorage), opener = hosted app
    let p = await page(code, { hash: hashFor("https://shinrajp.github.io"), local: { access_token: TOKEN }, opener: "open" });
    ok(P + "fetches Tesla's own endpoint, same origin, with the token in the header", p.fetches.length === 1 && p.fetches[0].url === "/api/1/decrypt/batch" && p.fetches[0].init.headers.Authorization === "Bearer " + TOKEN && p.fetches[0].init.credentials === "include", p.fetches[0]);
    ok(P + "sends the clip requests parsed from the hash", JSON.parse(p.fetches[0].init.body).items.length === 2 && JSON.parse(p.fetches[0].init.body).items[0].wrapped_key === "AAAA");
    ok(P + "hash is removed from the address bar", p.loc.hash === "" && p.loc._replaced === "/");
    ok(P + "posts keys to the opener, pinned to the hosted origin, with the nonce", p.posted.length === 1 && p.posted[0].t === "https://shinrajp.github.io" && p.posted[0].d.type === "tesla-dashcam-keys" && p.posted[0].d.nonce === "0123456789abcdef0123456789abcdef" && p.posted[0].d.results.length === 2, p.posted);
    ok(P + "overlay is green with a Copy keys button", p.btn().textContent === "Copy keys" && !p.btn().hidden && p.overlay.style.borderColor === "#3c6", [p.btn().textContent, p.overlay.style.borderColor]);
    await p.btn().onclick(); await p.W_(20);
    ok(P + "Copy keys writes keys JSON on tap", p.clip.writes.length === 1 && JSON.parse(p.clip.writes[0]).results.length === 2 && /copied/.test(p.msg()), p.clip.writes);
    ok(P + "the token is nowhere: not in posted data, clipboard, or overlay text", !p.everything().includes(TOKEN) && !p.everything().includes("eyJ"));
    ok(P + "request list was cleared from sessionStorage after success", p.win.sessionStorage.getItem("tdcIosUnlockReq") === null);

    // 2. origin pinning: every non-allowed origin gets nothing; allowed ones get the exact origin
    for (const bad of ["https://evil.example", "http://192.168.1.1.evil.com", "http://0xc0.168.1.1", "https://shinrajp.github.io.evil.com", "http://172.32.0.1", "http://11.0.0.1", "*", "null", "", "https://user:pw@shinrajp.github.io", "http://shinrajp.github.io"]) {
      p = await page(code, { hash: hashFor(bad), local: { access_token: TOKEN }, opener: "open" });
      ok(P + "no postMessage to " + JSON.stringify(bad), p.posted.length === 0 && p.btn().textContent === "Copy keys", p.posted);
    }
    for (const good of ["http://localhost:8771", "http://127.0.0.1:8770", "http://192.168.1.20:8771", "http://10.1.2.3", "http://172.16.0.9:8080", "http://my-mac.local:8771", "https://shinrajp.github.io"]) {
      p = await page(code, { hash: hashFor(good), local: { access_token: TOKEN }, opener: "open" });
      ok(P + "posts to allowed origin " + good, p.posted.length === 1 && p.posted[0].t === good, p.posted);
    }
    p = await page(code, { hash: hashFor("https://shinrajp.github.io"), local: { access_token: TOKEN }, opener: { closed: true, postMessage() { throw new Error("must not post"); } } });
    ok(P + "closed opener: no post, Copy keys still offered", p.btn().textContent === "Copy keys");
    p = await page(code, { hash: hashFor("https://shinrajp.github.io"), local: { access_token: TOKEN } });
    ok(P + "no opener (iOS): no post, Copy keys offered", p.posted.length === 0 && p.btn().textContent === "Copy keys");

    // 3. token sources
    p = await page(code, { hash: hashFor("https://shinrajp.github.io"), cookie: "foo=1; access_token=" + TOKEN });
    ok(P + "token from cookie", p.fetches[0].init.headers.Authorization === "Bearer " + TOKEN);
    p = await page(code, { hash: hashFor("https://shinrajp.github.io"), session: { "auth.state": JSON.stringify({ accessToken: TOKEN, refresh_token: "eyJzzzzzzzzz.zzzzzzzzzz.zzzzzzzzzz" }) } });
    ok(P + "token from JSON in sessionStorage (accessToken)", p.fetches[0].init.headers.Authorization === "Bearer " + TOKEN);
    p = await page(code, { hash: hashFor("https://shinrajp.github.io"), local: { somekey: "x " + TOKEN + " y", refreshToken: "eyJrrrrrrrrr.rrrrrrrrrr.rrrrrrrrrr" } });
    ok(P + "token: any JWT in storage, refresh keys ignored", p.fetches[0].init.headers.Authorization === "Bearer " + TOKEN);

    // 4. errors
    p = await page(code, { hash: hashFor("https://shinrajp.github.io"), fetch: async () => ({ ok: false, status: 401, json: async () => ({ error: "no" }) }) });
    ok(P + "401 / no token: clear sign-in message, red, Try again, nothing sent", /not signed in/.test(p.msg()) && p.btn().textContent === "Try again" && p.overlay.style.borderColor === "#e33" && p.posted.length === 0, p.msg());
    p = await page(code, { hash: hashFor("https://shinrajp.github.io"), local: { access_token: TOKEN }, fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
    ok(P + "HTTP 500: shows the failure, Try again", /Tesla sent no keys/.test(p.msg()) && /500/.test(p.msg()) && p.btn().textContent === "Try again", p.msg());
    p = await page(code, { hash: hashFor("https://shinrajp.github.io"), local: { access_token: TOKEN }, fetch: async () => { throw new TypeError("Load failed"); } });
    ok(P + "network error: shown, no crash", /Tesla sent no keys/.test(p.msg()) && p.btn().textContent === "Try again", p.msg());
    p = await page(code, { hash: hashFor("https://shinrajp.github.io"), local: { access_token: TOKEN }, fetch: async () => ({ ok: true, status: 200, json: async () => ({ results: [{ id: "r1", key: TOKEN, note: TOKEN }] }) }) });
    ok(P + "a reply that contains the token is never sent or copied", /stopped/.test(p.msg()) && p.posted.length === 0 && p.clip.writes.length === 0 && !p.btn().textContent);
    p = await page(code, { hash: `#gridplayer=0123456789abcdef0123456789abcdef&gpo=${encodeURIComponent("https://shinrajp.github.io")}&gpi=${b64u({ items: Array.from({ length: 65 }, (_, i) => ({ id: "r" + i, wrapped_key: "W" + i })) })}`, local: { access_token: TOKEN }, fetch: async (u, i, c) => (c === 2 ? { ok: false, status: 429, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ results: [{ id: "a" + c, key: "k" }] }) }) });
    ok(P + "no batches in request: split into 30s (30/30/5), failed batch reported, other keys kept", p.fetches.length === 3 && p.fetches.map((f) => JSON.parse(f.init.body).items.length).join() === "30,30,5" && /1 batch\(es\) failed/.test(p.msg()) && p.btn().textContent === "Copy keys", [p.fetches.length, p.msg()]);

    // 5. other places the request comes from
    p = await page(code, { hash: "", local: { access_token: TOKEN }, session: { tdcIosUnlockReq: JSON.stringify({ nonce: "0123456789abcdef0123456789abcdef", gpo: "https://shinrajp.github.io", items: ITEMS, ts: Date.now() }) } });
    ok(P + "request from sessionStorage (second tap after sign-in)", p.fetches.length === 1 && JSON.parse(p.fetches[0].init.body).items.length === 2);
    p = await page(code, { hash: "", local: { access_token: TOKEN }, session: { tdcIosUnlockReq: JSON.stringify({ nonce: "0123456789abcdef0123456789abcdef", gpo: "https://shinrajp.github.io", items: ITEMS, ts: Date.now() - 2 * 36e5 }) } });
    ok(P + "stale sessionStorage request (>1 h) is ignored → asks to paste", p.fetches.length === 0 && p.btn().textContent === "Paste unlock request");
    p = await page(code, { hash: "", local: { access_token: TOKEN }, clip: "https://dashcam.tesla.com/" + hashFor("https://shinrajp.github.io") });
    ok(P + "no request yet → asks, no fetch, blue", p.fetches.length === 0 && p.btn().textContent === "Paste unlock request" && p.overlay.style.borderColor === "#36f");
    await p.btn().onclick(); await p.W_(40);
    ok(P + "Paste unlock request reads the clipboard, then fetches + saves it", p.fetches.length === 1 && JSON.parse(p.fetches[0].init.body).items.length === 2 && p.btn().textContent === "Copy keys");
    p = await page(code, { hash: "", local: { access_token: TOKEN }, clip: "just some text" });
    await p.btn().onclick(); await p.W_(30);
    ok(P + "clipboard without a request: red message, can retry", p.fetches.length === 0 && /no unlock request on the clipboard/.test(p.msg()) && p.btn().textContent === "Paste unlock request" && p.overlay.style.borderColor === "#e33");
    p = await page(code, { hash: "", local: { access_token: TOKEN } }); // clipboard read denied
    await p.btn().onclick(); await p.W_(30);
    ok(P + "clipboard read denied: same clear message", /no unlock request on the clipboard/.test(p.msg()));
    p = await page(code, { hash: "#gridplayer=zz&gpi=!!!", local: { access_token: TOKEN } });
    ok(P + "garbage hash does not crash and asks to paste", p.fetches.length === 0 && p.btn().textContent === "Paste unlock request");
    p = await page(code, { hash: hashFor("https://shinrajp.github.io", []), local: { access_token: TOKEN } });
    ok(P + "empty request list is rejected", p.fetches.length === 0);

    // 6. wrong site, clipboard failures
    p = await page(code, { host: "example.com", hash: hashFor("https://shinrajp.github.io"), local: { access_token: TOKEN } });
    ok(P + "on another site: only a message, no fetch", p.fetches.length === 0 && /dashcam\.tesla\.com/.test(p.msg()));
    p = await page(code, { hash: hashFor("https://shinrajp.github.io"), local: { access_token: TOKEN }, clipFail: true });
    await p.btn().onclick(); await p.W_(20);
    ok(P + "copy failure: red message, button stays", /copy failed/.test(p.msg()) && p.btn().textContent === "Copy keys");
    p = await page(code, { hash: hashFor("https://shinrajp.github.io"), local: { access_token: TOKEN }, fetch: async () => ({ ok: true, status: 200, json: async () => ({ results: [{ id: "r1", key: "a", extra: "ignored", note: TOKEN }] }) }) });
    ok(P + "only id/key/error/wrapped_key fields of each result are kept (extra fields dropped)", !p.everything().includes("extra") && !p.everything().includes(TOKEN));
    ok(P + "overlay has a close button", typeof p.overlay.children[0].onclick === "function");
  }
  // generated bookmarklet: self-contained, no outside loads, size, ES2018-safe syntax
  ok("bookmarklet is a javascript: URL", gen.TDC.IOS_BOOKMARKLET.startsWith("javascript:"));
  ok("bookmarklet has no outside loads (no src=, import, importScripts, http(s) scripts)", !/\bimport\s*\(|importScripts|createElement\(["']script|\.src\s*=|XMLHttpRequest|sendBeacon/.test(BOOKMARKLET));
  ok("bookmarklet only mentions the allowed player origin literal, no other hosts", [...BOOKMARKLET.matchAll(/https?:\/\/[^\s"'\\)]+/g)].map((m) => m[0]).every((u) => u === "https://shinrajp.github.io"), [...BOOKMARKLET.matchAll(/https?:\/\/[^\s"'\\)]+/g)].map((m) => m[0]));
  ok("bookmarklet size < 6 KB (recorded: " + gen.TDC.IOS_BOOKMARKLET.length + " bytes)", gen.TDC.IOS_BOOKMARKLET.length < 6000);
  ok("no ES2020+ syntax (?. ?? ||= **=) in the bookmarklet", !/\?\.[a-z_$(\[]|\?\?|\|\|=|&&=|\*\*=/i.test(BOOKMARKLET.replace(/"(?:[^"\\]|\\.)*"/g, '""')));
  ok("generated file is up to date with the source (run tools/build-bookmarklet.js)", (() => { try { const { execFileSync } = require("child_process"); const t = path.join(root, "js/ios-unlock-src.js"); const before = fs.readFileSync(t, "utf8"); execFileSync("node", [path.join(root, "tools/build-bookmarklet.js")], { env: Object.assign({}, process.env, { NODE_PATH: process.env.NODE_PATH || "/workspace/tdc-test/pw/node_modules" }), stdio: "pipe" }); return fs.readFileSync(t, "utf8") === before; } catch (e) { return "skip: " + e.message.slice(0, 40); } })() !== false);
  console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
