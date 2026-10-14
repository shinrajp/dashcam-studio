// Phase 4 unified search: desktop 1440x900 + iPhone 390x844 (touch, simulated keyboard via visualViewport),
// jump-to-timestamp for Find and Redact results, shortcuts, Classic toggle, and fallback when init throws.
// Serve the repo (python3 -m http.server 8770) and put synthetic TeslaCam clips in /workspace/fixtures.
const puppeteer = require("puppeteer-core"); const fs = require("fs"), path = require("path");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.FIXTURES || "/workspace/fixtures";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); fs.statSync(q).isDirectory() ? w(q) : (/\.(mp4|json)$/.test(f) && f !== "base.mp4" && files.push(q)); } })(FIX);
let fails = 0; const ok = (name, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); if (!cond) fails++; };

async function page(b, vp, pre) {
  const p = await b.newPage(); await p.setViewport(vp);
  if (vp.isMobile) await p.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1");
  p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message));
  if (pre) await p.evaluateOnNewDocument(pre);
  await p.goto(URL_, { waitUntil: "load" });
  await (await p.$("#fileInput")).uploadFile(...files);
  for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);   // no waitForFunction: one fallback test removes MutationObserver
  await p.evaluate(() => { const e = TDC.library.events.find((x) => !x.locked && x.cams.includes("front")) || TDC.library.events[0]; return TDC.ui.activate(e); });
  await W(1500);
  return p;
}
const vis = (p, sel) => p.evaluate((s) => { const n = document.querySelector(s); if (!n) return false; const r = n.getBoundingClientRect(), cs = getComputedStyle(n); return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && r.bottom > 0 && r.top < innerHeight; }, sel);

async function common(p, tag) {
  ok(tag + " init ok", await p.evaluate(() => TDC.searchUI.ok && document.body.classList.contains("usearch")));
  ok(tag + " classic bars hidden", !(await vis(p, ".find-bar")) && !(await vis(p, ".redact-bar")));
  ok(tag + " icon visible, panel collapsed", (await vis(p, "#usBtn")) && (await p.evaluate(() => document.getElementById("usPanel").hidden)));
  await p.keyboard.press("/"); await W(150);
  ok(tag + " '/' opens + focuses", await p.evaluate(() => TDC.searchUI.open && document.activeElement.id === "usQuery"));
  await p.keyboard.press("Escape"); await W(100);
  ok(tag + " Esc closes", await p.evaluate(() => !TDC.searchUI.open));
  // Esc must close search but not leave a focused camera
  await p.evaluate(() => TDC.focus.focus("front")); await W(200);
  await p.keyboard.down("Control"); await p.keyboard.press("k"); await p.keyboard.up("Control"); await W(150);
  ok(tag + " Ctrl+K opens", await p.evaluate(() => TDC.searchUI.open));
  await p.keyboard.press("Escape"); await W(150);
  ok(tag + " Esc closes search only (camera stays focused)", await p.evaluate(() => !TDC.searchUI.open && TDC.focus.cam === "front"));
  await p.evaluate(() => TDC.focus.grid()); await W(200);
  // tap the icon
  await p.tap ? await p.tap("#usBtn") : await p.click("#usBtn"); await W(200);
  ok(tag + " tap icon expands", await p.evaluate(() => TDC.searchUI.open));
  // Find results (injected hits, the CLIP model is a 150 MB download) -> jump
  await p.evaluate(() => { TDC.search.hits = [{ t: 1.0, cam: "front", score: 0.1 }, { t: 3.2, cam: "front", score: 0.08, weak: true }]; TDC.searchUI.refresh(); });
  const groups = await p.evaluate(() => [...document.querySelectorAll("#usResults .us-group")].map((g) => g.textContent));
  ok(tag + " Find group in dropdown", groups.some((g) => /Find matches/.test(g)), groups);
  await p.evaluate(() => document.querySelector('#usResults .us-item[data-kind="find"][data-i="1"]').click()); await W(400);
  ok(tag + " Find result jumps to 3.2s", await p.evaluate(() => Math.abs(TDC.player.time - 3.2) < 0.25), await p.evaluate(() => TDC.player.time));
  await p.evaluate(() => { TDC.search.hits = []; TDC.searchUI.refresh(); });
  // Real redact (local OCR), then pick a result
  await p.evaluate(() => { document.getElementById("usQuery").value = "blur all text"; TDC.searchUI.redact(); });
  await p.waitForFunction(() => !TDC.redact.running, { timeout: 180000, polling: 500 });
  let runs = await p.evaluate(() => TDC.searchUI.redactRuns().length);
  if (!runs) { // no text in synthetic frames: inject a region so the jump path is still exercised
    await p.evaluate(() => { const R = TDC.redact; R.frames = { front: [{ t: 2.0, boxes: [{ x: 0.4, y: 0.6, w: 0.2, h: 0.08 }] }] }; R.active = true; R.eventId = TDC.player.ev.id; TDC.searchUI.refresh(); });
    runs = -1;
  }
  ok(tag + " Redact group in dropdown (real OCR runs: " + runs + ")", await p.evaluate(() => [...document.querySelectorAll("#usResults .us-group")].some((g) => /text \/ regions/.test(g.textContent))));
  const want = await p.evaluate(() => { const r = TDC.searchUI.redactRuns()[0]; document.querySelector('#usResults .us-item[data-kind="redact"]').click(); return r; });
  await W(700);
  const got = await p.evaluate(() => ({ t: TDC.player.time, cam: TDC.focus.cam, hl: document.querySelectorAll(".us-hl").length }));
  ok(tag + " Redact result jumps + focuses + highlights", Math.abs(got.t - want.t) < 0.25 && got.cam === want.cam && got.hl > 0, { want: { t: want.t, cam: want.cam }, got });
  await p.evaluate(() => TDC.focus.grid());
}

(async () => {
  const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"], userDataDir: "/tmp/tdc-p4-" + Date.now() });
  // desktop
  const d = await page(b, { width: 1440, height: 900 });
  await common(d, "desktop");
  ok("desktop panel is a floating popover (not a sheet)", await d.evaluate(() => { const p = document.getElementById("usPanel"); return !p.classList.contains("sheet") && p.getBoundingClientRect().width <= 560; }));
  await d.mouse.click(300, 300); await W(150);
  ok("desktop click outside closes", await d.evaluate(() => !TDC.searchUI.open));
  // Classic toggle
  await d.evaluate(() => TDC.searchUI.setClassic(true));
  ok("Classic search bars shows old bars", (await vis(d, ".find-bar")) && (await vis(d, ".redact-bar")) && (await vis(d, "#usBtn")));
  await d.reload({ waitUntil: "load" }); await W(500);
  ok("Classic setting persists", await d.evaluate(() => document.body.classList.contains("usearch-classic") && document.getElementById("setClassicSearch").checked));
  await d.evaluate(() => TDC.searchUI.setClassic(false));
  ok("Classic off hides old bars", !(await vis(d, ".find-bar")));
  ok("desktop no page errors", !d.errs.length, d.errs);

  // phone
  const m = await page(b, { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await common(m, "phone");
  await m.evaluate(() => TDC.searchUI.show());
  await W(200);
  const before = await m.evaluate(() => { const r = document.getElementById("grid").getBoundingClientRect(); return { top: r.top, h: r.height, w: r.width, sheet: document.getElementById("usPanel").classList.contains("sheet"), bottom: document.getElementById("usPanel").getBoundingClientRect().bottom }; });
  ok("phone uses a bottom sheet at the bottom", before.sheet && Math.abs(before.bottom - 844) < 2, before);
  // simulated keyboard: the visual viewport shrinks by 336 px (iOS keyboard), the layout viewport does not
  await m.evaluate(() => {
    const fake = new EventTarget(); fake.height = 844 - 336; fake.offsetTop = 0; fake.width = 390; fake.scale = 1;
    Object.defineProperty(window, "visualViewport", { configurable: true, get: () => fake });
    document.getElementById("usQuery").focus(); fake.dispatchEvent(new Event("resize")); window.dispatchEvent(new Event("resize"));
  });
  await W(250);
  const after = await m.evaluate(() => { const r = document.getElementById("grid").getBoundingClientRect(); const pr = document.getElementById("usPanel").getBoundingClientRect(); return { top: r.top, h: r.height, w: r.width, panelBottom: pr.bottom, panelTop: pr.top, scrollY: window.scrollY, kb: TDC.searchUI.keyboard }; });
  ok("phone sheet sits above the keyboard", Math.abs(after.panelBottom - (844 - 336)) < 2 && after.panelTop >= 0, after);
  ok("phone grid not resized or moved by keyboard", after.top === before.top && after.h === before.h && after.w === before.w && after.scrollY === 0, { before, after });
  ok("phone input font >= 16px (no iOS zoom)", await m.evaluate(() => parseFloat(getComputedStyle(document.getElementById("usQuery")).fontSize) >= 16));
  await m.screenshot({ path: process.env.SHOT || "/tmp/p4-phone-kb.png" });
  ok("phone no page errors", !m.errs.length, m.errs);

  // fallback: init throws -> classic bars still reachable and usable
  const f = await page(b, { width: 1440, height: 900 }, () => { window.__TDC_SEARCHUI_FAIL = true; });
  ok("fallback (forced throw): no new UI, classic bars visible", !(await f.$("#usBtn")) && !(await f.$("#usPanel")) && (await vis(f, ".find-bar")) && (await vis(f, ".redact-bar")));
  await f.type("#findQuery", "a cyclist"); ok("fallback: Find input usable", await f.evaluate(() => document.getElementById("findQuery").value === "a cyclist"));
  const g = await page(b, { width: 1440, height: 900 }, () => { window.MutationObserver = undefined; });
  ok("fallback (MutationObserver missing): classic bars visible", !(await g.$("#usBtn")) && (await vis(g, ".find-bar")) && (await g.evaluate(() => !!TDC.searchUI.error)), await g.evaluate(() => TDC.searchUI.error));
  await b.close();
  console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
