// Phase 6 part B — optional cloud boost, headless Chrome with ALL provider APIs MOCKED (request interception).
// No real API keys are used or needed; this checks request shapes, headers, consent, key storage, rate limit, parsing,
// error messages and that the key never goes anywhere except the chosen provider's host.
// Needs the repo served (python3 -m http.server 8796) and tools/make-plate-footage.py footage (/tmp/plate-samples).
// Usage: node test/phase6-cloud.js [url]     SHOTS=dir saves screenshots/phase6-cloud-*.png
const puppeteer = require("puppeteer-core"); const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8796/index.html";
const FIX = process.env.PLATE_FIXTURES || "/tmp/plate-samples", SHOTS = process.env.SHOTS || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(FIX + "/TeslaCam")) execFileSync("python3", [path.join(__dirname, "../tools/make-plate-footage.py"), FIX], { stdio: "inherit" });
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) w(q); else files.push(q); } })(FIX + "/TeslaCam");
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x).slice(0, 400) : "")); if (!c) fails++; };
const KEYS = { grok: "xai-MOCK-KEY-1111", claude: "sk-ant-MOCK-KEY-2222", gemini: "AIzaMOCK-KEY-3333" };
const HOSTS = { "api.x.ai": "grok", "api.anthropic.com": "claude", "generativelanguage.googleapis.com": "gemini" };
const calls = [], leaks = []; let mode = "ok";
function reply(prov, task) {
  if (mode === "401") return { status: 401, body: { error: { message: "Incorrect API key" } } };
  const obj = task === "plate" ? '{"plates":[{"text":"7TST123","confidence":0.93,"box":[0.2,0.3,0.6,0.3]}]}' : '{"objects":[{"label":"car","text":"","confidence":0.81,"box":[0.40,0.50,0.20,0.15]}]}';
  if (prov === "grok") return { status: 200, body: { choices: [{ message: { role: "assistant", content: "```json\n" + obj + "\n```" } }] } };
  if (prov === "claude") return { status: 200, body: { content: [{ type: "thinking", thinking: "{not json}" }, { type: "text", text: obj }] } };
  // Gemini: native box_2d [ymin,xmin,ymax,xmax] 0..1000
  const g = task === "plate" ? '{"plates":[{"text":"7TST123","confidence":0.9,"box_2d":[300,200,600,800]}]}' : '{"objects":[{"label":"car","confidence":0.8,"box_2d":[500,400,650,600]}]}';
  return { status: 200, body: { candidates: [{ content: { parts: [{ text: g }] } }] } };
}
async function open(b) {
  const p = await b.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message));
  await p.setViewport({ width: 1440, height: 900 });
  await p.setRequestInterception(true);
  p.on("request", (rq) => {
    const u = new URL(rq.url()), all = rq.url() + JSON.stringify(rq.headers()) + (rq.postData() || "");
    const prov = HOSTS[u.hostname];
    for (const [k, key] of Object.entries(KEYS)) if (all.includes(key) && HOSTS[u.hostname] !== k) leaks.push({ url: rq.url(), key: k });
    if (prov) {
      if (rq.method() === "OPTIONS") return rq.respond({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST" } });
      if (mode === "offline") return rq.abort("internetdisconnected");
      let body = {}; try { body = JSON.parse(rq.postData() || "{}"); } catch (_) {}
      const task = /licence plate/.test(rq.postData() || "") ? "plate" : "find";
      calls.push({ prov, url: rq.url(), headers: rq.headers(), body, task, at: Date.now() });
      const r = reply(prov, task);
      return rq.respond({ status: r.status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(r.body) });
    }
    if (!/^(127\.0\.0\.1|localhost)$/.test(u.hostname) && !/^(data|blob):/.test(rq.url())) return rq.abort();   // nothing else external
    rq.continue();
  });
  await p.goto(URL_, { waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important}" });
  await (await p.$("#fileInput")).uploadFile(...files);
  for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
  await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); return TDC.ui.activate(TDC.library.events[0]); });
  await W(1200);
  return p;
}
const startFind = (p, q, cam) => p.evaluate((q, cam) => { document.getElementById("findQuery").value = q; document.getElementById("findCam").value = cam || "front"; TDC.search.run(); }, q, cam);
const waitFind = async (p) => { for (let i = 0; i < 900 && (await p.evaluate(() => TDC.search.running)); i++) await W(200);
  return p.evaluate(() => ({ hits: TDC.search.hits.map((h) => ({ t: h.t, cam: h.cam, label: h.label, text: h.text, box: h.box, cloud: h.cloud })), status: document.getElementById("findStatus").textContent })); };
const consentUp = async (p) => { for (let i = 0; i < 100; i++) { if (await p.$("#cloudConsent")) return true; await W(100); } return false; };
const setProvider = (p, prov, key, remember) => p.evaluate((prov, key, remember) => {
  const s = document.getElementById("cbProvider"); s.value = prov; s.dispatchEvent(new Event("change"));
  if (prov === "off") return;
  if (remember !== undefined) { const r = document.getElementById("cbRemember"); r.checked = remember; r.dispatchEvent(new Event("change")); }
  const k = document.getElementById("cbKey"); k.value = key; k.dispatchEvent(new Event("change"));
}, prov, key, remember);

(async () => {
  const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--hide-scrollbars"], userDataDir: "/tmp/tdc-p6c-" + Date.now(), protocolTimeout: 900000 });
  const p = await open(b);
  // ── off by default ──
  ok("cloud boost OFF by default: no provider, 'ask …' not taken, no key field", await p.evaluate(() => !TDC.cloud.provider() && !TDC.cloud.handlesQuery("ask a red car") && !document.getElementById("cbKey") && document.getElementById("cbProvider").value === "off"));
  ok("provider list: Off / Grok (xAI) / Claude (Anthropic) / Gemini (Google)", await p.evaluate(() => [...document.getElementById("cbProvider").options].map((o) => o.textContent.split(" (")[0]).join("|") === "Off|Grok|Claude|Gemini"));
  // ── key storage ──
  await p.evaluate(() => document.getElementById("btnSettings").click()); await W(300);
  await setProvider(p, "grok", KEYS.grok);
  ok("key stays in this tab (sessionStorage), not localStorage", await p.evaluate((k) => sessionStorage.getItem("tdc.cloud.key.grok") === k && !JSON.stringify(localStorage).includes(k), KEYS.grok));
  ok("settings: key (masked), remember, model grok-4.3, calls per run, forget", await p.evaluate(() => document.getElementById("cbKey").type === "password" && !!document.getElementById("cbRemember") && document.getElementById("cbModel").value === "grok-4.3" && !!document.getElementById("cbMax") && !!document.getElementById("cbForget")));
  await p.evaluate(() => { const r = document.getElementById("cbRemember"); r.checked = true; r.dispatchEvent(new Event("change")); });
  ok("'Remember key' moves it to localStorage", await p.evaluate((k) => localStorage.getItem("tdc.cloud.key.grok") === k && !sessionStorage.getItem("tdc.cloud.key.grok"), KEYS.grok));
  await p.evaluate(() => { const r = document.getElementById("cbRemember"); r.checked = false; r.dispatchEvent(new Event("change")); });
  ok("unticking moves it back to the tab only", await p.evaluate((k) => !localStorage.getItem("tdc.cloud.key.grok") && sessionStorage.getItem("tdc.cloud.key.grok") === k, KEYS.grok));
  await p.evaluate(() => { const m = document.getElementById("cbMax"); m.value = 3; m.dispatchEvent(new Event("change")); });
  if (SHOTS) { await p.evaluate(() => document.getElementById("setCloud").scrollIntoView({ block: "center" })); await W(300); await p.screenshot({ path: SHOTS + "/phase6-cloud-settings.png" }); }
  await p.evaluate(() => document.getElementById("btnCloseSettings").click());
  // ── consent ──
  await startFind(p, "ask a car", "front");
  ok("consent dialog before the first send", await consentUp(p));
  const ctext = await p.evaluate(() => document.getElementById("cloudConsent").textContent);
  ok("dialog says frames leave the device, names api.x.ai, says it costs money, shows the estimate", /leave this device/.test(ctext) && /api\.x\.ai/.test(ctext) && /billed/.test(ctext) && /About 3 calls/.test(ctext), ctext);
  ok("nothing sent while the dialog is open", calls.length === 0);
  if (SHOTS) { await p.screenshot({ path: SHOTS + "/phase6-cloud-consent.png" }); }
  await p.click("#cloudConsentNo");
  let r = await waitFind(p);
  ok("Cancel → nothing sent, says so", calls.length === 0 && /Nothing was sent/.test(r.status), r.status);
  // accept
  await startFind(p, "ask a car", "front"); await consentUp(p); await p.click("#cloudConsentYes");
  r = await waitFind(p);
  const gc = calls.filter((c) => c.prov === "grok");
  ok("Grok: 3 calls (max per run), POST api.x.ai/v1/chat/completions", gc.length === 3 && gc.every((c) => c.url === "https://api.x.ai/v1/chat/completions"), gc.length);
  ok("Grok: Bearer key, model grok-4.3, image_url JPEG data URI + text prompt", gc.every((c) => c.headers.authorization === "Bearer " + KEYS.grok && c.body.model === "grok-4.3" && /^data:image\/jpeg;base64,/.test(c.body.messages[0].content[0].image_url.url) && /Find every instance of: "a car"/.test(c.body.messages[0].content[1].text)));
  const gaps = gc.slice(1).map((c, i) => c.at - gc[i].at);
  ok("rate limit: ≥ ~1.5 s between calls", gaps.every((g) => g >= 1400), gaps);
  const dims = await p.evaluate(async (u) => { const i = new Image(); i.src = u; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }, gc[0].body.messages[0].content[0].image_url.url);
  ok("frames downscaled to ≤ 1024 px", Math.max(...dims) <= 1024, dims);
  ok("hits from the JSON answer, box normalised, labelled with provider", r.hits.length >= 1 && r.hits.every((h) => h.cloud === "grok" && Math.abs(h.box.x - 0.4) < 1e-6 && Math.abs(h.box.w - 0.2) < 1e-6 && /81% · Grok/.test(h.text)), r);
  ok("status says it was the cloud model", /Grok \(xAI\) saw “a car”|where the cloud model said/.test(r.status), r.status);
  if (SHOTS) { await W(600); await p.screenshot({ path: SHOTS + "/phase6-cloud-find.png" }); }
  ok("second run: no dialog when 'don't ask again' was not ticked → asks again", await (async () => { await startFind(p, "ask a car", "front"); const up = await consentUp(p); await p.click("#cloudConsentNo"); await waitFind(p); return up; })());
  // ── Claude ──
  await p.evaluate(() => document.getElementById("btnSettings").click()); await W(200);
  await setProvider(p, "claude", KEYS.claude); await p.evaluate(() => document.getElementById("btnCloseSettings").click());
  calls.length = 0;
  await startFind(p, "ask a car", "front"); await consentUp(p);
  ok("consent names api.anthropic.com", /api\.anthropic\.com/.test(await p.evaluate(() => document.getElementById("cloudConsent").textContent)));
  await p.evaluate(() => { document.getElementById("cloudConsentKeep").checked = true; }); await p.click("#cloudConsentYes");
  r = await waitFind(p);
  const cc = calls.filter((c) => c.prov === "claude");
  ok("Claude: POST /v1/messages with x-api-key, anthropic-version, direct-browser-access header", cc.length === 3 && cc.every((c) => c.url === "https://api.anthropic.com/v1/messages" && c.headers["x-api-key"] === KEYS.claude && c.headers["anthropic-version"] === "2023-06-01" && c.headers["anthropic-dangerous-direct-browser-access"] === "true" && !c.headers.authorization));
  ok("Claude: model claude-haiku-5-5, base64 image block, max_tokens", cc.every((c) => c.body.model === "claude-haiku-5-5" && c.body.messages[0].content[0].type === "image" && c.body.messages[0].content[0].source.media_type === "image/jpeg" && c.body.max_tokens > 0));
  ok("Claude: thinking blocks ignored, text JSON parsed", r.hits.length >= 1 && r.hits[0].cloud === "claude", r);
  calls.length = 0; await startFind(p, "ask a car", "front"); await W(400);
  ok("'don't ask again' remembered per provider (no dialog)", !(await p.$("#cloudConsent")));
  await waitFind(p);
  // ── Gemini ──
  await p.evaluate(() => document.getElementById("btnSettings").click()); await W(200);
  await setProvider(p, "gemini", KEYS.gemini); await p.evaluate(() => document.getElementById("btnCloseSettings").click());
  calls.length = 0; await startFind(p, "ask a car", "front"); await consentUp(p); await p.click("#cloudConsentYes");
  r = await waitFind(p);
  const ge = calls.filter((c) => c.prov === "gemini");
  ok("Gemini: generateContent URL with model, x-goog-api-key header, key NOT in the URL", ge.length === 3 && ge.every((c) => c.url === "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent" && c.headers["x-goog-api-key"] === KEYS.gemini && !c.url.includes(KEYS.gemini)));
  ok("Gemini: inline_data JPEG + JSON response type", ge.every((c) => c.body.contents[0].parts[0].inline_data.mime_type === "image/jpeg" && c.body.generationConfig.responseMimeType === "application/json"));
  ok("Gemini box_2d [ymin,xmin,ymax,xmax]/1000 → x,y,w,h", r.hits.length >= 1 && Math.abs(r.hits[0].box.x - 0.4) < 1e-6 && Math.abs(r.hits[0].box.y - 0.5) < 1e-6 && Math.abs(r.hits[0].box.w - 0.2) < 1e-6 && Math.abs(r.hits[0].box.h - 0.15) < 1e-6, r.hits[0]);
  // ── errors ──
  mode = "401"; await startFind(p, "ask a car", "front"); await W(300); if (await p.$("#cloudConsent")) await p.click("#cloudConsentYes");
  r = await waitFind(p);
  ok("401 → readable message about the key", /refused the API key \(401\)/.test(r.status), r.status);
  mode = "offline"; await startFind(p, "ask a car", "front"); await W(300); if (await p.$("#cloudConsent")) await p.click("#cloudConsentYes");
  r = await waitFind(p);
  ok("network/CORS failure → readable message", /Couldn't reach generativelanguage\.googleapis\.com/.test(r.status), r.status);
  mode = "ok";
  // ── use 1: re-check weak plate readings ──
  await p.evaluate(() => { TDC.plates.setPref("enabled", true); });
  r = await (async () => { await startFind(p, "plate 7TST*", "front"); return waitFind(p); })();
  ok("local plate search still works with cloud on (no cloud calls)", r.hits.length > 0 && r.hits.every((h) => /7TST123/.test(h.label)) && !calls.some((c) => c.task === "plate"), r.hits.length);
  // pretend the local reader was unsure and wrong on the front camera (synthetic footage reads too well otherwise)
  await p.evaluate(async () => { const X = TDC.libIndex.text, s = X.get(TDC.player.ev.id); for (const i of s.items) if (i.kind === "plate" && i.cam === "front") { i.text = "7TST1Z3"; i.conf = 0.25; } await X.put(s); });
  r = await (async () => { await startFind(p, "plate 7TST1Z3", "front"); return waitFind(p); })();
  await W(300);
  const btn = await p.evaluate(() => { const b = document.getElementById("btnCloudRecheck"); return b && !b.hidden && b.textContent; });
  ok("'Re-check N weak plates with Gemini' appears after a plate search", /^Re-check \d+ weak plates? with Gemini$/.test(btn || ""), btn);
  await p.click("#usBtn"); await W(400);
  const ub = await p.evaluate(() => { const b = document.getElementById("usCloudRecheck"); return b && !b.hidden && b.offsetParent !== null && b.textContent; });
  ok("classic-bar copy hidden while the floating search is used", await p.evaluate(() => { const b = document.getElementById("btnCloudRecheck"); return !b || b.offsetParent === null; }));
  ok("same button in the floating search panel", /^Re-check \d+ weak plates? with Gemini$/.test(ub || ""), ub);
  if (SHOTS) await p.screenshot({ path: SHOTS + "/phase6-cloud-recheck-button.png" });
  calls.length = 0;
  await p.click("#usCloudRecheck");
  ok("re-check also asks for consent first (crops leave the device)", (await consentUp(p)) && /plate/.test(await p.evaluate(() => document.getElementById("cloudConsent").textContent)) && calls.length === 0);
  await p.click("#cloudConsentYes");
  for (let i = 0; i < 300 && !/checked/.test(await p.evaluate(() => document.getElementById("findStatus").textContent)); i++) await W(200);
  const st = await p.evaluate(() => document.getElementById("findStatus").textContent);
  const pc = calls.filter((c) => c.task === "plate");
  ok("plate re-check: crop sent (≥ 320 px, ≤ 1024 px) to Gemini only", pc.length >= 1 && pc.length <= 3 && pc.every((c) => c.prov === "gemini"), { n: pc.length, st });
  const crop = await p.evaluate(async (d) => { const i = new Image(); i.src = "data:image/jpeg;base64," + d; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }, pc[0].body.contents[0].parts[0].inline_data.data);
  ok("crop size", Math.max(...crop) >= 320 && Math.max(...crop) <= 1024, crop);
  ok("status reports corrections", /corrected \d+/.test(st), st);
  const idx = await p.evaluate(() => TDC.libIndex.text.get(TDC.player.ev.id).items.filter((i) => i.kind === "plate" && i.cam === "front").map((i) => ({ text: i.text, local: i.localText, cloud: i.cloud && i.cloud.prov })));
  ok("index keeps the local reading and adds the cloud one", idx.length && idx.every((i) => i.text === "7TST123" && i.local === "7TST1Z3" && i.cloud === "gemini"), idx.slice(0, 2));
  r = await (async () => { await startFind(p, "plate 7TST123", "front"); return waitFind(p); })();
  ok("search now finds the corrected plate, labelled 'checked by Gemini'", r.hits.length > 0 && r.hits.every((h) => /checked by Gemini/.test(h.text)), r.hits[0]);
  if (SHOTS) { await W(800); await p.screenshot({ path: SHOTS + "/phase6-cloud-recheck.png" }); }
  // ── off again / forget / privacy ──
  await p.evaluate(() => document.getElementById("btnSettings").click()); await W(200);
  await p.evaluate(() => document.getElementById("cbForget").click());
  ok("Forget API keys clears every key and consent", await p.evaluate((ks) => !Object.values(ks).some((k) => JSON.stringify(localStorage).includes(k) || JSON.stringify(sessionStorage).includes(k)) && !Object.keys(TDC.cloud.prefs().consent).length, KEYS));
  await setProvider(p, "off");
  ok("Off → 'ask …' falls back to the regular search routing", await p.evaluate(() => !TDC.cloud.handlesQuery("ask a car")));
  ok("the key never went anywhere but its own provider", leaks.length === 0, leaks);
  ok("player still plays", await p.evaluate(async () => { TDC.player.seek(1); TDC.player.play(); await new Promise((r) => setTimeout(r, 900)); const t = TDC.player.time; TDC.player.pause(); return t > 1.2; }));
  ok("no page errors", p.errs.length === 0, p.errs);
  await b.close();
  console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
