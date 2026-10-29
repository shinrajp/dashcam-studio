// model-picker (tag model-picker): Settings ▸ Object detection ▸ Model ▸ "YOLO11 medium" with a file chosen on the device.
// The real yolo11m.onnx (git-ignored, ~80 MB; MEDIUM=path, default models/yolo11m.onnx next to this repo) is picked with setInputFiles. The app is served from a
// hard-linked COPY of the tree WITHOUT that file (so the "not found" path is real), plus once from the full tree to check the order
// stored file → models/yolo11m.onnx → pref. Nothing personal: tools/mock-stills only. SHOTS=dir writes screenshots.
//  1. not found → friendly message + Choose button + "Use YOLO11 small instead" + collapsible help (AGPL, export command), no 404 text, no outside requests
//  2. too-small file refused, junk ≥ 10 MB refused (and removed again); the real file is stored, status "Stored on this device: yolo11m.onnx, 80.7 MB"
//  3. detection runs a look with medium on a still (worker got the stored Blob), nano and small still load
//  4. reload → loads from the stored file, panel shows it; Remove → gone, message is back
//  5. IndexedDB refusing → works for this session, says so
//  6. full tree: models/yolo11m.onnx used when nothing stored; the stored file wins when both exist
//  7. phone: no medium option, no panel; precache has model-picker.js and never yolo11m.onnx; service worker file untouched in kind
// Usage: BR=chromium|webkit node test/model-picker.js
const fs = require("fs"), path = require("path"), cp = require("child_process");
const ROOT = path.join(__dirname, ".."), MEDIUM = process.env.MEDIUM || path.join(ROOT, "models/yolo11m.onnx"), SHOTS = process.env.SHOTS || "";
const TREE = process.env.TREE || "/workspace/tmp-mp-tree", W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
const sh = (c) => cp.execSync(c, { stdio: "ignore" });
(async () => {
  if (!fs.existsSync(MEDIUM)) { console.log("SKIP: no yolo11m.onnx at " + MEDIUM); return; }
  sh(`rm -rf ${TREE} && mkdir -p ${TREE} && cp -al ${ROOT}/. ${TREE}/ && rm -rf ${TREE}/.git ${TREE}/models/yolo11m.onnx`);
  const servers = [];
  const serve = (dir, port) => { servers.push(cp.spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: dir, stdio: "ignore" })); return `http://127.0.0.1:${port}/index.html`; };
  const URL_ = serve(TREE, 8795), FULL = serve(ROOT, 8796); await W(1000);
  fs.writeFileSync("/tmp/mp-small.onnx", Buffer.alloc(3 * 1048576, 1)); fs.writeFileSync("/tmp/mp-junk.onnx", require("crypto").randomBytes(11 * 1048576));
  const pw = require("playwright");
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  const BR = process.env.BR || "chromium";
  const b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const tag = BR + ": ";
  const open = async (ctx, url, prefs) => { const p = await ctx.newPage(); p.errs = []; p.ext = []; p.on("pageerror", (e) => p.errs.push(e.message)); p.on("request", (r) => { if (!/^(http:\/\/127\.0\.0\.1|blob:|data:|about:)/.test(r.url())) p.ext.push(r.url()); }); await p.goto(url + "?nosw=1", { waitUntil: "load" }); if (prefs) { await p.evaluate((v) => localStorage.setItem("tdc.detect.v1", JSON.stringify(v)), prefs); await p.reload({ waitUntil: "load" }); } return p; };
  const openSettings = async (p) => { await p.evaluate(() => { const a = document.getElementById("advToggle"); if (!a.checked) { a.checked = true; a.dispatchEvent(new Event("change")); } document.getElementById("recogAdv").open = true; const s = document.getElementById("settings"); if (s.hidden) document.getElementById("btnSettings").click(); if (TDC.settings) TDC.settings.show("redact"); /* ui-glass-8 groups */ }); await W(300); await p.evaluate(() => (document.getElementById("detModel") || document.getElementById("setDetect")).scrollIntoView({ block: "start" })); };
  const state = (p) => p.evaluate(() => (document.getElementById("medState") || {}).textContent || "");
  const waitFor = async (p, fn, ms = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p.evaluate(fn).catch(() => false)) return true; await W(300); } return false; };
  const still = (p) => p.evaluate(async () => { const im = new Image(); im.src = "tools/mock-stills/front.jpg"; await im.decode(); const D = TDC.detect; const t0 = performance.now(); const r = await D.detectImage(im, im.naturalWidth, im.naturalHeight, { conf: 0.25 }); return { n: r.length, labels: r.map((d) => d.label + ":" + d.conf.toFixed(2)).slice(0, 6), ms: Math.round(performance.now() - t0), stored: !!(D.info && D.info.stored), url: D.info && D.info.url, bytes: D.info && D.info.bytes, backend: D.info && D.info.backend }; });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  let p = await open(ctx, URL_, { enabled: true, model: "medium" });
  // ── 1. not found ──
  await openSettings(p);
  const s1 = await state(p);
  ok(tag + "medium selected, nothing stored → panel asks for the file", /needs a file from you/.test(s1) && !!(await p.$("#medChoose #medFile")) && !!(await p.$("#medUseSmall")) && !(await p.$("#medRemove")), s1);
  ok(tag + "help is collapsed and has the AGPL note + export command, no mirror link", await p.evaluate(() => { const d = document.getElementById("medHelp"); const t = d.textContent; return !d.open && /AGPL/.test(t) && /yolo export model=yolo11m\.pt format=onnx imgsz=640 opset=17 simplify=True/.test(t) && /ultralytics\/assets/.test(t) && !d.querySelector("a") && /Nothing is uploaded/.test(document.getElementById("detMedPanel").textContent); }));
  if (SHOTS) { await p.screenshot({ path: SHOTS + "/1-prompt-" + BR + ".png" }); }
  await p.evaluate(() => document.getElementById("detTest").click());
  ok(tag + "Load model now → friendly message, not a bare 404", await waitFor(p, () => TDC.detect.status.startsWith("YOLO11 medium isn't included in the app"), 20000) && !/404/.test(await p.evaluate(() => TDC.detect.status)), await p.evaluate(() => TDC.detect.status));
  const s1b = await state(p);
  ok(tag + "…and the panel shows that message with the Choose button", s1b === "YOLO11 medium isn't included in the app (it's an optional AGPL model). Choose the yolo11m.onnx file from your device." && !!(await p.$("#medChoose")), s1b);
  if (SHOTS) { await p.evaluate(() => document.getElementById("medHelp").open = true); await p.screenshot({ path: SHOTS + "/2-not-found-help-" + BR + ".png" }); await p.evaluate(() => document.getElementById("medHelp").open = false); }
  // ── 2. refusals, then the real file ──
  await p.setInputFiles("#medFile", "/tmp/mp-small.onnx"); await waitFor(p, () => /too small/.test((document.getElementById("medNote") || {}).textContent || ""), 10000);
  ok(tag + "a 3 MB file is refused, nothing stored", /too small/.test(await p.evaluate(() => document.getElementById("medNote").textContent)) && !(await p.evaluate(() => TDC.modelStore.meta("medium"))));
  await p.setInputFiles("#medFile", "/tmp/mp-junk.onnx");
  ok(tag + "an 11 MB junk file is refused and removed again", await waitFor(p, () => /couldn't be opened as an ONNX model/.test((document.getElementById("medNote") || {}).textContent || ""), 90000) && !(await p.evaluate(() => TDC.modelStore.meta("medium"))), await p.evaluate(() => (document.getElementById("medNote") || {}).textContent));
  const t0 = Date.now();
  await p.setInputFiles("#medFile", MEDIUM);
  const loaded = await waitFor(p, () => /^Loaded yolo11m\.onnx/.test((document.getElementById("medNote") || {}).textContent || ""), 180000);
  ok(tag + "the real file is stored and loads (" + Math.round((Date.now() - t0) / 1000) + " s)", loaded, await p.evaluate(() => [TDC.detect.status, (document.getElementById("medNote") || {}).textContent]));
  const s2 = await state(p);
  ok(tag + "status shows 'Stored on this device: yolo11m.onnx, 80.7 MB'", s2 === "Stored on this device: yolo11m.onnx, 80.7 MB.", s2);
  ok(tag + "Remove button + Replace label appear, Use small hidden", !!(await p.$("#medRemove")) && /Replace/.test(await p.evaluate(() => document.getElementById("medChoose").textContent)) && !(await p.$("#medUseSmall")));
  await waitFor(p, () => /differs|Loaded/.test((document.getElementById("medWarn") || document.getElementById("medNote") || {}).textContent || ""), 5000); await W(1500);
  const warn = await p.evaluate(() => (document.getElementById("medWarn") || {}).textContent || "");
  console.log("INFO sha/size warning: " + (warn || "(none: matches the tested export)"));
  if (SHOTS) await p.screenshot({ path: SHOTS + "/3-stored-" + BR + ".png" });
  // ── 3. detection with medium, other models ──
  const m1 = await still(p);
  ok(tag + "medium ran a look on a still using the stored file", m1.stored && /^user:medium#/.test(m1.url) && m1.bytes > 70e6 && Array.isArray(m1.labels), m1);
  console.log("INFO medium look:", JSON.stringify(m1));
  const others = await p.evaluate(async () => { const D = TDC.detect, out = {}; for (const k of ["nano", "small"]) { try { const i = await D.load(k); out[k] = { backend: i.backend, stored: !!i.stored, bytes: i.bytes }; } catch (e) { out[k] = { err: e.message }; } } return out; });
  ok(tag + "nano and small still load from their own files", others.nano.bytes > 5e6 && others.small.bytes > 30e6 && !others.nano.stored && !others.small.stored, others);
  await p.evaluate(() => TDC.detect.setPref("model", "medium"));
  // a different (valid) export: YOLO11 small chosen as "medium" loads, with a plain warning (not a block); then the real file is put back (Replace)
  await p.setInputFiles("#medFile", path.join(ROOT, "models/yolo11s.onnx"));
  ok(tag + "a different valid export (here yolo11s) loads with a warning, not a block", await waitFor(p, () => /differs from the export/.test((document.getElementById("medWarn") || {}).textContent || ""), 60000) && /Stored on this device: yolo11s\.onnx/.test(await state(p)), await p.evaluate(() => [(document.getElementById("medWarn") || {}).textContent, document.getElementById("medState").textContent]));
  await p.setInputFiles("#medFile", MEDIUM);
  ok(tag + "Replace puts the real file back", await waitFor(p, () => /Stored on this device: yolo11m\.onnx, 80\.7 MB/.test((document.getElementById("medState") || {}).textContent || "") && /^Loaded yolo11m/.test((document.getElementById("medNote") || {}).textContent || ""), 90000));
  // ── 4. reload persists, Remove ──
  await p.reload({ waitUntil: "load" }); await openSettings(p);
  ok(tag + "after reload the stored file is listed", /Stored on this device: yolo11m\.onnx, 80\.7 MB/.test(await state(p)) && !!(await p.$("#medRemove")), await state(p));
  const r2 = await p.evaluate(async () => { try { const i = await TDC.detect.load("medium"); return { stored: !!i.stored, bytes: i.bytes, status: TDC.detect.status }; } catch (e) { return { err: e.message }; } });
  ok(tag + "after reload medium loads from the stored file (no download)", r2.stored && r2.bytes > 70e6 && /from this device/.test(r2.status), r2);
  await p.click("#medRemove");
  ok(tag + "Remove stored model → gone, prompt is back", await waitFor(p, () => /Removed the stored model/.test((document.getElementById("medNote") || {}).textContent || ""), 10000) && !(await p.evaluate(() => TDC.modelStore.meta("medium"))) && !(await p.$("#medRemove")) && /needs a file|isn't included/.test(await state(p)), await state(p));
  const r3 = await p.evaluate(async () => { try { await TDC.detect.load("medium"); return { loaded: true }; } catch (e) { return { err: e.message, status: TDC.detect.status }; } });
  ok(tag + "after Remove, medium is 'not found' again (friendly)", !r3.loaded && /isn't included in the app/.test(r3.status || ""), r3);
  await p.evaluate(() => document.getElementById("medUseSmall") && document.getElementById("medUseSmall").click());
  ok(tag + "Use YOLO11 small instead switches the model", await p.evaluate(() => TDC.detect.prefs().model === "small" && !document.getElementById("detMedPanel")));
  ok(tag + "no page errors, no requests outside this server", p.errs.length === 0 && p.ext.length === 0, { errs: p.errs, ext: p.ext });
  await p.close();
  // ── 5. IndexedDB refuses (private mode, no quota) ──
  const ctx5 = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx5.addInitScript(() => { const o = IDBFactory.prototype.open; IDBFactory.prototype.open = function (n) { if (n === "tdc-user-models") throw new Error("QuotaExceededError (test)"); return o.apply(this, arguments); }; });
  p = await open(ctx5, URL_, { enabled: true, model: "medium" }); await openSettings(p);
  await p.setInputFiles("#medFile", MEDIUM);
  ok(tag + "IndexedDB refused: still works for this session and says so", await waitFor(p, () => /^Loaded yolo11m\.onnx/.test((document.getElementById("medNote") || {}).textContent || "") && /wouldn't keep it/.test(document.getElementById("medState").textContent), 180000), await p.evaluate(() => [document.getElementById("medState").textContent, (document.getElementById("medNote") || {}).textContent]));
  const m5 = await still(p); ok(tag + "…and detection runs with it", m5.stored && Array.isArray(m5.labels), m5);
  await p.close(); await ctx5.close();
  // ── 6. full tree: models/ file, stored file wins ──
  const ctx6 = await b.newContext({ viewport: { width: 1280, height: 900 } });
  p = await open(ctx6, FULL, { enabled: true, model: "medium" }); await openSettings(p); await waitFor(p, () => /Using models\/yolo11m\.onnx/.test((document.getElementById("medState") || {}).textContent || ""), 10000);
  ok(tag + "served with models/yolo11m.onnx: panel says so", /Using models\/yolo11m\.onnx from this site/.test(await state(p)), await state(p));
  const r6 = await p.evaluate(async () => { try { const i = await TDC.detect.load("medium"); return { stored: !!i.stored, url: i.url, bytes: i.bytes }; } catch (e) { return { err: e.message }; } });
  ok(tag + "…and medium loads from it when nothing is stored", !r6.stored && /models\/yolo11m\.onnx$/.test(r6.url || "") && r6.bytes > 70e6, r6);
  await p.setInputFiles("#medFile", MEDIUM);
  ok(tag + "choosing a file now: the stored one is used first", await waitFor(p, () => /^Loaded yolo11m\.onnx/.test((document.getElementById("medNote") || {}).textContent || ""), 180000) && await p.evaluate(() => TDC.detect.info.stored && /^user:/.test(TDC.detect.info.url)));
  await p.evaluate(() => TDC.modelStore.remove("medium")); await p.close(); await ctx6.close();
  // ── 7. phone, precache ──
  const ctx7 = await b.newContext({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, userAgent: UA, deviceScaleFactor: 2 });
  p = await open(ctx7, URL_, { enabled: true, model: "medium" }); await openSettings(p);
  ok(tag + "phone: no medium option, no panel, model falls back", await p.evaluate(() => ![...document.querySelectorAll("#detModel option")].some((o) => o.value === "medium") && !document.getElementById("detMedPanel") && TDC.detect.prefs().model !== "medium"));
  await p.close(); await ctx7.close();
  const pc = JSON.parse(fs.readFileSync(path.join(ROOT, "precache.json"), "utf8")), sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  ok("precache: js/model-picker.js in core, yolo11m never listed; sw.js does not mention the user-model database", pc.core.includes("js/model-picker.js") && ![...pc.core, ...pc.extra].some((f) => /yolo11m/.test(f)) && !/tdc-user-models/.test(sw));
  ok("detect.js still has the three older models' urls", /nano: \{[^}]*models\/yolo11n\.onnx/.test(fs.readFileSync(path.join(ROOT, "js/detect.js"), "utf8")));
  await b.close(); servers.forEach((s) => s.kill()); sh(`rm -rf ${TREE}; rm -f /tmp/mp-small.onnx /tmp/mp-junk.onnx`);
  console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log("ERR", e); process.exit(2); });
