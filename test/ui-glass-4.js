// ui-glass-4 (toggles capsule + eye): the toggles strip (#chips: Labels, HUD, Map, Self-Driving, Time, Hand-off, Car view, White balance) is a glass
// capsule (css/toggles.css); in phone landscape (body.mbar, short landscape) one eye button in the slim bar fans the same #chips node out in a glass
// popover (js/toggles.js). Desktop and phone portrait keep the strip where it was (controls row / pull-up sheet), skin only.
//   Playwright, BR=chromium|webkit (default both), mock footage (tools/make-mock-footage.py -> /tmp/ho-mock). Serves the repo on PORT (default 8814).
//   Devices: desktop 1440x900 (mouse), phone 390x844 and 844x390 (touch).
//   Checks: 1 capsule (and the eye only in phone landscape); 2 no layout change vs toggles.css off (desktop, portrait bar + sheet);
//   3 every toggle flips its pref, saves it and flips back, the same in every layout (popover stays open while toggling);
//   4 keyboard (Tab to a toggle, Enter; eye: Enter opens + focus, Esc closes + focus back, the strip goes back to its place; H shortcut);
//   5 touch targets >= 44 px (eye, popover toggles, sheet toggles); 6 auto-hide (holds while the popover is open, hides with the bar);
//   7 glass modes (popover tint, blur within the budget, none in Solid); 8 reduced motion (no fan animation);
//   9 no overlap: the eye vs the slim-row controls, the popover on screen and above the bar, on top of the floated map, also in full screen;
//   10 outside tap closes (nothing else happens), the sheet and the popover never both open; 11 no page errors.
//   SHOTS=dir PREFIX=before-|after- writes <prefix><dev>-controls.png, -sheet.png (phones), -eye.png (phone landscape, popover open, if the eye exists).
//   ONLY_SHOTS=1 only writes the pictures (for "before").
const fs = require("fs"), path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", PORT = +(process.env.PORT || 8814), SHOTS = process.env.SHOTS || "", PREFIX = process.env.PREFIX || "", ONLY = process.env.ONLY_SHOTS === "1";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
const info = (n, x) => console.log("INFO " + n + " " + JSON.stringify(x).slice(0, 600));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".onnx": "application/octet-stream", ".wasm": "application/wasm" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html"; fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; r.end(); return; } r.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }).listen(PORT, "127.0.0.1", () => res(s)); });
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

const offCss = (p, off) => p.evaluate((o) => { document.querySelectorAll('link[href*="toggles.css"]').forEach((l) => { l.disabled = o; }); window.dispatchEvent(new Event("resize")); }, off).then(() => W(400));
const RECTS = () => { const o = {}; document.querySelectorAll("[id]").forEach((e) => { if (!e.getClientRects().length) return; const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return; o[e.id] = [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 2) / 2); });
  o["--tp-h"] = [getComputedStyle(document.documentElement).getPropertyValue("--tp-h")]; return o; };
const diff = (a, b) => Object.keys(a).concat(Object.keys(b)).filter((k, i, all) => all.indexOf(k) === i).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]) && !/^(ahLine|toast|tlTip|tgPop|tgEye)/.test(k));   // the eye and popover are js/toggles.js pieces (checked in 1, 5, 9)
const alphaOf = (bg) => { const m = /rgba?\(([^)]+)\)/.exec(bg); if (!m) return 0; const v = m[1].split(",").map(parseFloat); return v.length > 3 ? v[3] : 1; };
const shot = async (p, n) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, PREFIX + n + ".png") }); } };
const setSheet = (p, v) => p.evaluate((o) => { if (TDC.mobileBar && TDC.mobileBar.on) TDC.mobileBar.setOpen(o); }, v).then(() => W(450));
const eyeShown = (p) => p.evaluate(() => { const e = document.getElementById("tgEye"); return !!(e && e.isConnected && e.getClientRects().length && getComputedStyle(e).display !== "none"); });
const popOpen = (p) => p.evaluate(() => !!(TDC.toggles && TDC.toggles.open));
const center = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, sel);
async function tap(p, touch, sel) { const c = await center(p, sel); if (!c) return false; if (touch) await p.touchscreen.tap(c[0], c[1]); else await p.mouse.click(c[0], c[1]); await W(320); return true; }
// what a toggle changes: the prefs object, every tdc.* localStorage key except the sheet state, and each chip's on / aria-pressed
const STATE = () => { const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^tdc\./.test(k) && k !== "tdc.mbarOpen") ls[k] = localStorage.getItem(k); }
  const chips = [...document.querySelectorAll("#chips .chip")].map((c) => (c.id || c.dataset.show) + ":" + (c.classList.contains("on") ? 1 : 0) + (c.getAttribute("aria-pressed") || ""));
  return { prefs: JSON.stringify(TDC.prefs), ls, chips }; };
const CHIPS = ['[data-show="labels"]', '[data-show="hud"]', '[data-show="map"]', '[data-show="fsd"]', '[data-show="time"]', "#chipCue", "#chipCar", "#chipWb"];

async function open(p) {
  await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1`, { waitUntil: "load" });
  await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.prefs.v1"); localStorage.removeItem("tdc.regions.v1"); localStorage.removeItem("tdc.mbarOpen"); sessionStorage.clear(); }); await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events.find((e) => e.cams.length === 6) || TDC.library.events[0]); }); await W(1800);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); TDC.setPref("autohide", "never"); document.getElementById("settings").hidden = true; TDC.player.seek(3); }); await W(500);
}
// bring a toggle under the finger / mouse in this layout: desktop = the strip; portrait = the open sheet; landscape = the eye popover
async function reveal(p, mode, sel) {
  if (mode === "eye") { if (!(await popOpen(p))) await p.evaluate(() => TDC.toggles.show()); await W(300); }
  else if (mode === "sheet") await setSheet(p, true);
  await p.evaluate((s) => { const e = document.querySelector("#chips " + s); if (e) e.scrollIntoView({ block: "nearest", inline: "nearest" }); }, sel); await W(150);
}

async function run(b, BR, dev) {
  const tag = BR + " " + dev.name, touch = dev.touch, land = dev.w > dev.h && touch;
  const ctx = await b.newContext({ viewport: { width: dev.w, height: dev.h }, isMobile: !!touch && BR === "chromium", hasTouch: !!touch, userAgent: touch ? UA : undefined, deviceScaleFactor: touch ? 2 : 1 });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await open(p);
  if (!touch) await p.mouse.move(dev.w - 5, 5);
  await shot(p, dev.name + "-controls");
  if (touch) { await setSheet(p, true); await shot(p, dev.name + "-sheet"); await setSheet(p, false); }
  if (land && (await eyeShown(p))) { await p.evaluate(() => TDC.toggles.show()); await W(500); await shot(p, dev.name + "-eye"); await p.evaluate(() => TDC.toggles.hide(true)); await W(300); }
  if (ONLY) { await ctx.close(); return; }
  const mode = !touch ? "strip" : land ? "eye" : "sheet";
  // 1 capsule + eye placement
  if (touch) await setSheet(p, true);
  const cap = await p.evaluate(() => { const c = document.getElementById("chips"), cs = getComputedStyle(c), r = c.getBoundingClientRect(); return { r: parseFloat(cs.borderTopLeftRadius), bg: cs.backgroundColor, sh: cs.boxShadow.slice(0, 50), shown: cs.display !== "none" && r.width > 40, inCtl: !!c.closest(".tp-controls") }; });
  ok(tag + " 1 the toggles strip is a glass capsule (rounded >= 18 px, tinted) in its usual place" + (touch ? " (pull-up sheet)" : " (controls row)"), cap.shown && cap.inCtl && cap.r >= 18 && alphaOf(cap.bg) > 0, cap);
  if (touch) await setSheet(p, false);
  const es = await eyeShown(p);
  ok(tag + " 1 the eye button is " + (land ? "in the slim bar (phone landscape)" : "not shown (" + (touch ? "portrait" : "desktop") + ")"), land ? es && (await p.evaluate(() => document.getElementById("tgEye").parentNode.id === "mbRow")) : !es, es);
  // 2 skin only (desktop; portrait bar + sheet). Landscape: the eye takes 44 px of the slim row (checked in 9)
  if (!land) for (const o of touch ? [false, true] : [false]) {
    await setSheet(p, o);
    const on = await p.evaluate(RECTS); await offCss(p, true); const off = await p.evaluate(RECTS); await offCss(p, false);
    const d = diff(on, off);
    ok(tag + " 2 no layout change from the capsule" + (touch ? (o ? " (sheet open)" : " (bar)") : "") + ": same box for every element with an id", d.length === 0, d.slice(0, 6).map((k) => [k, on[k], off[k]]));
  }
  await setSheet(p, false);
  // 3 every toggle: flips its pref and saved state, flips back
  const bad = []; let staysOpen = true;
  for (const sel of CHIPS) {
    await reveal(p, mode, sel);
    const s0 = await p.evaluate(STATE);
    if (!(await tap(p, touch, "#chips " + sel))) { bad.push(sel + " missing"); continue; }
    await W(250);
    const s1 = await p.evaluate(STATE);
    if (mode === "eye" && !(await popOpen(p))) staysOpen = false;
    await reveal(p, mode, sel);
    await tap(p, touch, "#chips " + sel); await W(250);
    const s2 = await p.evaluate(STATE);
    const changed = s0.prefs !== s1.prefs || JSON.stringify(s0.ls) !== JSON.stringify(s1.ls), chipFlip = JSON.stringify(s0.chips) !== JSON.stringify(s1.chips);
    const back = s2.prefs === s0.prefs && JSON.stringify(s2.chips) === JSON.stringify(s0.chips);
    if (!changed || !chipFlip || !back) bad.push({ sel, changed, chipFlip, back });
    if (sel === "#chipCar") await p.evaluate(() => { const c = document.getElementById("carView"); if (c && TDC.prefs.carView) document.getElementById("chipCar").click(); });
  }
  if (mode === "eye") await p.evaluate(() => TDC.toggles.hide(true)); else if (mode === "sheet") await setSheet(p, false);
  ok(tag + " 3 every toggle flips its pref (saved) and its button, and flips back" + (mode === "eye" ? "; the popover stays open while toggling" : ""), bad.length === 0 && staysOpen, { bad, staysOpen });
  const saved = await p.evaluate(() => { const s = JSON.parse(localStorage.getItem("tdc.prefs.v1") || "{}"); return !!(s.show && typeof s.show.hud === "boolean"); });
  ok(tag + " 3 the toggles are saved in the prefs (tdc.prefs.v1)", saved);
  // 4 keyboard
  if (!touch) {
    const k = await p.evaluate(() => { const c = document.querySelector('#chips [data-show="hud"]'); return { tab: c.tabIndex >= 0 && !c.disabled, h0: TDC.prefs.show.hud }; });
    await p.focus('#chips [data-show="hud"]'); await p.keyboard.press("Enter"); await W(200);
    const h1 = await p.evaluate(() => TDC.prefs.show.hud); await p.keyboard.press("Enter"); await W(200);
    await p.evaluate(() => document.activeElement && document.activeElement.blur()); await p.keyboard.press("h"); await W(200);
    const h2 = await p.evaluate(() => TDC.prefs.show.hud); await p.keyboard.press("h"); await W(200);
    ok(tag + " 4 keyboard: a toggle is focusable and Enter flips it; the H shortcut still works", k.tab && h1 === !k.h0 && h2 === !k.h0 && (await p.evaluate(() => TDC.prefs.show.hud)) === k.h0, { k, h1, h2 });
  } else if (land) {
    const home0 = await p.evaluate(() => { const c = document.getElementById("chips"); return [c.parentNode.className, c.previousElementSibling && (c.previousElementSibling.id || c.previousElementSibling.className), c.nextElementSibling && c.nextElementSibling.id]; });
    await p.focus("#tgEye"); await p.keyboard.press("Enter"); await W(400);
    const k1 = await p.evaluate(() => ({ open: TDC.toggles.open, exp: document.getElementById("tgEye").getAttribute("aria-expanded"), focus: document.activeElement && (document.activeElement.dataset.show || document.activeElement.id), inPop: !!document.querySelector("#tgPop #chips") }));
    const l0 = await p.evaluate(() => TDC.prefs.show.labels); await p.keyboard.press("Enter"); await W(200); const l1 = await p.evaluate(() => TDC.prefs.show.labels); await p.keyboard.press("Enter"); await W(200);
    await p.keyboard.press("Escape"); await W(450);
    const k2 = await p.evaluate(() => ({ open: TDC.toggles.open, exp: document.getElementById("tgEye").getAttribute("aria-expanded"), focus: document.activeElement && document.activeElement.id, hidden: getComputedStyle(document.getElementById("tgPop")).visibility }));
    const home1 = await p.evaluate(() => { const c = document.getElementById("chips"); return [c.parentNode.className, c.previousElementSibling && (c.previousElementSibling.id || c.previousElementSibling.className), c.nextElementSibling && c.nextElementSibling.id]; });
    ok(tag + " 4 keyboard: Enter on the eye opens it (aria-expanded, focus on the first toggle), Enter flips a toggle, Esc closes and gives focus back to the eye", k1.open && k1.exp === "true" && k1.focus === "labels" && k1.inPop && l1 === !l0 && !k2.open && k2.exp === "false" && k2.focus === "tgEye" && k2.hidden === "hidden", { k1, l0, l1, k2 });
    ok(tag + " 4 closing puts the strip back exactly where it was (in the sheet's controls row)", JSON.stringify(home0) === JSON.stringify(home1) && /tp-controls/.test(home1[0]), { home0, home1 });
  }
  // 5 touch targets
  if (touch) {
    const small = await p.evaluate(async (land) => {
      const out = []; const chk = (e, n) => { const r = e.getBoundingClientRect(); if (r.width < 43.5 || r.height < 43.5) out.push(n + " " + Math.round(r.width) + "x" + Math.round(r.height)); };
      if (land) { chk(document.getElementById("tgEye"), "tgEye"); TDC.toggles.show(); await new Promise((r) => setTimeout(r, 350)); document.querySelectorAll("#tgPop .chip").forEach((c) => chk(c, "pop:" + (c.id || c.dataset.show))); TDC.toggles.hide(true); }
      else { TDC.mobileBar.setOpen(true); await new Promise((r) => setTimeout(r, 450)); document.querySelectorAll("#chips .chip").forEach((c) => chk(c, "sheet:" + (c.id || c.dataset.show))); TDC.mobileBar.setOpen(false); }
      return out; }, land);
    await W(400);
    ok(tag + " 5 touch targets >= 44 px (" + (land ? "the eye and every toggle in the popover" : "every toggle in the sheet") + ")", small.length === 0, small);
  }
  // 6 auto-hide
  if (!touch) await p.mouse.move(dev.w - 5, 5);
  if (land) {
    await p.evaluate(() => { TDC.toggles.show(); TDC.setPref("autohide", "2"); TDC.player.seek(0.5); TDC.player.play(); TDC.autohide.wake(); }); await W(2800);
    const held = await p.evaluate(() => ({ why: TDC.autohide.why, hidden: TDC.autohide.hidden, open: TDC.toggles.open }));
    await p.evaluate(() => TDC.toggles.hide(true));
    let gone = false; for (let i = 0; i < 40 && !gone; i++) { await W(100); gone = await p.evaluate(() => document.body.classList.contains("ah-gone")); }
    const ev = await p.evaluate(() => getComputedStyle(document.getElementById("tgEye")).visibility);
    ok(tag + " 6 auto-hide holds while the popover is open; after it closes the eye hides with the bar", held.why === "toggles" && !held.hidden && held.open && gone && ev === "hidden", { held, gone, ev });
  } else {
    await p.evaluate(() => { TDC.setPref("autohide", "2"); TDC.player.seek(0.5); TDC.player.play(); TDC.autohide.wake(); });
    let gone = false; for (let i = 0; i < 40 && !gone; i++) { await W(100); gone = await p.evaluate(() => document.body.classList.contains("ah-gone")); }
    const v = await p.evaluate(() => getComputedStyle(document.getElementById("chips")).visibility);
    ok(tag + " 6 auto-hide: the toggles capsule hides with the controls", gone && v === "hidden", { gone, v });
  }
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("autohide", "never"); TDC.autohide.wake(); }); await W(400);
  // 7 glass modes
  if (land) {
    await p.evaluate(() => TDC.toggles.show()); await W(400);
    const modes = {};
    for (const m of ["auto", "clear", "solid"]) { await p.evaluate((x) => { TDC.setPref("glass", x); TDC.glass.budget(); }, m); await W(300);
      modes[m] = await p.evaluate(() => { const e = document.getElementById("tgPop"), cs = getComputedStyle(e); const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor), v = m ? m[1].split(",").map(parseFloat) : [0, 0, 0, 0]; return { a: v.length > 3 ? v[3] : 1, bf: cs.backdropFilter || cs.webkitBackdropFilter || "none", n: TDC.glass.blurred.length, pop: TDC.glass.blurred.includes(e) }; }); }
    ok(tag + " 7 glass modes: the popover is tinted glass (Clear more see-through than Solid), blurred within the budget (<= 3), no blur in Solid", modes.clear.a < modes.solid.a && modes.solid.a >= 0.9 && modes.solid.bf === "none" && modes.auto.n <= 3 && modes.clear.n <= 3 && (!modes.auto.pop || /blur/.test(modes.auto.bf)), modes);
    await p.evaluate(() => { TDC.setPref("glass", "auto"); TDC.toggles.hide(true); }); await W(300);
  } else {
    const modes = {};
    for (const m of ["auto", "clear", "solid"]) { await p.evaluate((x) => TDC.setPref("glass", x), m); await W(250); modes[m] = await p.evaluate(() => { if (TDC.mobileBar.on) TDC.mobileBar.setOpen(true); const cs = getComputedStyle(document.getElementById("chips")); return { r: parseFloat(cs.borderTopLeftRadius), bg: cs.backgroundColor }; }); }
    await setSheet(p, false);
    ok(tag + " 7 glass modes: the toggles capsule is drawn in Automatic, Clear and Solid", ["auto", "clear", "solid"].every((m) => modes[m].r >= 18), modes);
    await p.evaluate(() => TDC.setPref("glass", "auto")); await W(200);
  }
  // 8 reduced motion
  if (land) {
    await p.emulateMedia({ reducedMotion: "reduce" }); await W(200);
    const rm = await p.evaluate(async () => { TDC.toggles.show(); await new Promise((r) => setTimeout(r, 60)); const e = document.getElementById("tgPop"), c = e.querySelector(".chip"); const o = { pop: getComputedStyle(e).transitionDuration, chip: getComputedStyle(c).transitionDuration, op: getComputedStyle(e).opacity, tf: getComputedStyle(c).transform };
      TDC.toggles.hide(); await new Promise((r) => setTimeout(r, 30)); o.backAtOnce = !!document.querySelector(".tp-controls #chips"); return o; });
    ok(tag + " 8 reduced motion: no fan animation (no transitions, shown at once, the strip goes back at once)", rm.pop.split(",").every((d) => parseFloat(d) <= 0.001) && rm.chip.split(",").every((d) => parseFloat(d) <= 0.001) && rm.op === "1" && rm.tf === "none" && rm.backAtOnce, rm);
    await p.emulateMedia({ reducedMotion: "no-preference" });
  } else {
    await p.emulateMedia({ reducedMotion: "reduce" }); await W(200);
    const t = await p.evaluate(() => getComputedStyle(document.getElementById("chips")).transitionDuration);
    ok(tag + " 8 reduced motion: the capsule has no transition", t.split(",").every((d) => parseFloat(d) <= 0.001), t);
    await p.emulateMedia({ reducedMotion: "no-preference" });
  }
  // 9 no overlap
  if (land) {
    const ov = await p.evaluate(async () => {
      const R = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; }, X = (a, b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
      const out = {}; const eye = R(document.getElementById("tgEye"));
      out.eyeHits = ["btnPlay", "timeLabel", "timeline", "mbMore"].filter((id) => { const e = document.getElementById(id); return e && e.closest("#mbRow") && X(eye, R(e)); });
      out.tlW = Math.round(document.getElementById("timeline").getBoundingClientRect().width);
      const hit = (e) => { const r = e.getBoundingClientRect(), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return h === e || e.contains(h); };
      out.eyeHit = hit(document.getElementById("tgEye"));
      const check = async (name) => { TDC.toggles.show(); await new Promise((r) => setTimeout(r, 400)); const pop = document.getElementById("tgPop"), pr = R(pop), bar = R(document.getElementById("mbBar"));
        const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
        out[name] = { onScreen: pr.l >= 0 && pr.t >= 0 && pr.r <= vw + 0.5 && pr.b <= vh + 0.5, aboveBar: pr.b <= bar.t + 0.5, chipsHit: [...pop.querySelectorAll(".chip")].every(hit), pr };
        TDC.toggles.hide(true); await new Promise((r) => setTimeout(r, 300)); };
      await check("normal");
      TDC.setPref("mapDock", "float"); await new Promise((r) => setTimeout(r, 500)); await check("mapFloat"); TDC.setPref("mapDock", "over"); await new Promise((r) => setTimeout(r, 300));
      document.body.classList.add("fs"); window.dispatchEvent(new Event("resize")); await new Promise((r) => setTimeout(r, 400)); await check("fs");
      document.body.classList.remove("fs"); window.dispatchEvent(new Event("resize")); await new Promise((r) => setTimeout(r, 400));
      return out; });
    const good = (c) => c && c.onScreen && c.aboveBar && c.chipsHit;
    ok(tag + " 9 no overlap: the eye sits beside play / time / timeline / ⌃ and takes its taps; the timeline keeps >= 200 px", ov.eyeHits.length === 0 && ov.eyeHit && ov.tlW >= 200, ov);
    ok(tag + " 9 the popover is on screen, above the bar and every toggle takes its own tap (normal, floated map, full screen)", good(ov.normal) && good(ov.mapFloat) && good(ov.fs), ov);
  } else {
    if (touch) await setSheet(p, true);
    const ov = await p.evaluate(() => { const c = document.querySelector("#chips .chip"); if (!c || !c.offsetParent) return { skipped: true }; c.scrollIntoView({ block: "nearest", inline: "nearest" }); const r = c.getBoundingClientRect(), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { ok: h === c || c.contains(h), vw: document.documentElement.scrollWidth <= innerWidth }; });
    if (touch) await setSheet(p, false);
    ok(tag + " 9 the toggles take their own taps" + (touch ? " in the sheet" : "") + " and the page does not scroll sideways", !ov.skipped && ov.ok && ov.vw, ov);
  }
  // 10 outside tap, sheet vs popover
  if (land) {
    await p.evaluate(() => TDC.toggles.show()); await W(400);
    const foc0 = await p.evaluate(() => (TDC.focus && TDC.focus.cam) || null), vp = await p.evaluate(() => { const r = document.getElementById("viewport").getBoundingClientRect(); return [r.left + r.width / 2, r.top + 40]; });
    await p.touchscreen.tap(vp[0], vp[1]); await W(400);
    const o1 = await p.evaluate(() => ({ open: TDC.toggles.open, cam: (TDC.focus && TDC.focus.cam) || null }));
    await p.evaluate(() => TDC.toggles.show()); await W(300); await tap(p, true, "#mbMore"); await W(400);
    const o2 = await p.evaluate(() => ({ pop: TDC.toggles.open, sheet: TDC.mobileBar.open, chipsInSheet: !!document.querySelector("#mbSheet #chips") }));
    await p.evaluate(() => TDC.toggles.show()); await W(400);
    const o3 = await p.evaluate(() => ({ pop: TDC.toggles.open, sheet: TDC.mobileBar.open }));
    await p.evaluate(() => TDC.toggles.hide(true)); await W(300);
    ok(tag + " 10 a tap on the video closes the popover and does nothing else", !o1.open && o1.cam === foc0, { o1, foc0 });
    ok(tag + " 10 the sheet and the popover are never open together (⌃ closes the popover, the eye closes the sheet)", !o2.pop && o2.sheet && o2.chipsInSheet && o3.pop && !o3.sheet, { o2, o3 });
  }
  ok(tag + " 11 no page errors", errs.length === 0, errs.slice(0, 3));
  await ctx.close();
}
(async () => {
  if (!fs.existsSync(FIX + "/TeslaCam")) execFileSync("python3", [path.join(ROOT, "tools/make-mock-footage.py"), FIX], { stdio: "inherit" });
  const srv = await server(); const pw = require("playwright");
  const DEVS = [{ name: "desktop-1440x900", w: 1440, h: 900, touch: 0 }, { name: "phone-390x844", w: 390, h: 844, touch: 1 }, { name: "phone-844x390", w: 844, h: 390, touch: 1 }];
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    let b;
    try { b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }); }
    catch (e) { console.log("SKIP " + BR + ": cannot launch (" + e.message.split("\n")[0] + ")"); continue; }
    for (const d of DEVS.filter((d) => !process.env.DEV || d.name.startsWith(process.env.DEV))) { try { await run(b, BR, d); } catch (e) { ok(BR + " " + d.name + " run threw: " + e.message.split("\n")[0], false); } }
    await b.close();
  }
  srv.close(); console.log(fails ? "FAILED " + fails : "ALL PASSED"); process.exit(fails ? 1 : 0);
})();
