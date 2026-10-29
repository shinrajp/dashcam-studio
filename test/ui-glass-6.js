// ui-glass-6 (tools bubble): one round glass bubble (#toolBubble > #tbMain, js/bubble.js + css/bubble.css) at the bottom right holds Redact (#rdBtn),
// Search (#usBtn), Events (#tbEvents) and Settings (#tbSettings) and fans them out when tapped. Export stays in the top bar. The bubble drags to
// another corner (6 px threshold, no pointer capture, real click handler) and remembers it. Events opens #library as a slide-in sheet.
// Also the two iPhone feedback items: the floating map drags down to the window bottom (grip kept above the bar), and the phone event picker
// (#eventPick) is a 44 px pill with a visible chevron and date/time label.
//   Playwright, BR=chromium|webkit (default both), mock footage (tools/make-mock-footage.py -> /tmp/ho-mock). Serves the repo on PORT (default 8816).
//   Devices: desktop 1440x900 (mouse), phones 390x844, 430x932, 844x390 (touch).
//   Checks: 1 bubble placed in the corner, 52 px, closed; Export still in the top bar; 2 opens on tap/click (aria-expanded, items on screen, 44 px+,
//   no item overlaps another or the top bar / bottom controls), second tap closes; 3 Esc closes (focus back), outside tap closes and does nothing else;
//   4 items: Redact opens the Redact tab, Search opens Find, Settings opens the drawer, Events opens the sheet (closes on Esc / outside tap / pick);
//   5 keyboard: Enter opens and focuses the first item, arrows / Home / End move, Esc returns focus, Tab out closes; "/" still opens Search;
//   6 drag: snaps to the nearest corner, saved, kept after a reload, a < 6 px move still counts as a click, no pointer capture on pointerdown;
//   7 auto-hide: never hides while the fan is open, a faint dot when the controls hide; 8 glass modes and the 3-blur budget, none in Solid;
//   9 reduced motion; 10 steps away while drawing / picking a region; 11 floating map drags to the window bottom (grip above the bar);
//   12 phone event picker: 44 px, chevron, label, no overlap in the top bar; 13 no page errors.
//   14 docked Search/Redact panel (Mac Safari ~1024 px feedback), desktop 1024x553 / 1280x720 / 1440x900, both tabs: at most 30% of the window,
//   no overlap with the video or the controls, no sideways overflow, every control still reachable, help behind (i), saved list scrolls (small max height).
//   DEV=dock runs only part 14; SHOTS also writes <prefix>redact-docked-<w>x<h>.png and <prefix>find-docked-<w>x<h>.png.
//   SHOTS=dir PREFIX=after- writes <prefix><dev>-closed.png, -fan.png and (desktop) -events.png, plus <prefix>events-pick-<dev>.png (top bar).
const fs = require("fs"), path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", PORT = +(process.env.PORT || 8816), SHOTS = process.env.SHOTS || "", PREFIX = process.env.PREFIX || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".onnx": "application/octet-stream", ".wasm": "application/wasm" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html"; fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; r.end(); return; } r.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }).listen(PORT, "127.0.0.1", () => res(s)); });
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const shot = async (p, n, clip) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, PREFIX + n + ".png"), clip }); } };
const R = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }, sel);
const X = (a, b) => !!a && !!b && a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
async function open(p, keep) {
  await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1`, { waitUntil: "load" });
  if (!keep) { await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.prefs.v1"); localStorage.removeItem("tdc.regions.v1"); localStorage.removeItem("tdc.mbarOpen"); sessionStorage.clear(); }); await p.reload({ waitUntil: "load" }); }
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events.find((e) => e.cams.length === 6) || TDC.library.events[0]); }); await W(1800);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); TDC.setPref("autohide", "never"); document.getElementById("settings").hidden = true; TDC.player.seek(3); if (TDC.focus.dismissHint) TDC.focus.dismissHint();
    document.querySelectorAll(".toast").forEach((t) => t.remove()); }); await W(500);
}
const S = (p) => p.evaluate(() => { const b = TDC.bubble, m = document.getElementById("tbMain"), lib = document.getElementById("library"), a = document.activeElement;
  return { on: !!b.on, open: !!b.open, sheet: !!b.sheet, away: !!b.away, exp: m && m.getAttribute("aria-expanded"), corner: b.corner, pref: TDC.prefs.bubble && TDC.prefs.bubble.corner,
    fan: document.body.classList.contains("tb-fan-open"), libVis: !!lib && getComputedStyle(lib).visibility === "visible" && lib.getBoundingClientRect().right > 50, settings: !document.getElementById("settings").hidden,
    focus: a && (a.id || (a.classList && a.classList.contains("ev") ? "ev" : a.tagName)), us: !!TDC.searchUI.open, tab: TDC.searchUI.tab }; });
const items = (p) => p.evaluate(() => [...document.querySelectorAll("#tbFan .tb-item")].filter((e) => !e.hidden).map((e) => { const r = e.getBoundingClientRect(), l = e.querySelector(".us-lbl"), lr = l && l.getBoundingClientRect(), cs = getComputedStyle(e);
  return { id: e.id, l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, vis: cs.visibility, lbl: l ? { l: lr.left, t: lr.top, r: lr.right, b: lr.bottom, txt: l.textContent } : null }; }));
const TOPS = (p) => p.evaluate(() => { const H = innerHeight, out = []; const tb = document.querySelector(".topbar"); if (tb) { const r = tb.getBoundingClientRect(); out.push(["topbar", { l: r.left, t: r.top, r: r.right, b: r.bottom }]); }
  for (const id of ["transport", "mbBar"]) { const e = document.getElementById(id); if (!e || e.hidden || !e.getClientRects().length) continue; const r = e.getBoundingClientRect(); if (r.top > H * 0.4 && r.height > 1) out.push([id, { l: r.left, t: r.top, r: r.right, b: r.bottom }]); }
  return out; });

async function run(b, BR, dev) {
  const tag = BR + " " + dev.name, touch = dev.touch, phone = !!touch;
  const ctx = await b.newContext({ viewport: { width: dev.w, height: dev.h }, isMobile: !!touch && BR === "chromium", hasTouch: !!touch, userAgent: touch ? UA : undefined, deviceScaleFactor: touch ? 2 : 1 });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(String(e.message || e)));
  const act = async (sel) => { if (touch) await p.tap(sel); else await p.click(sel); await W(650); };
  const tapAt = async (x, y) => { if (touch) await p.touchscreen.tap(x, y); else await p.mouse.click(x, y); await W(650); };
  await open(p);
  // 1 placement
  let s = await S(p); const mr = await R(p, "#tbMain"), area = await p.evaluate(() => TDC.bubble.area());
  ok(tag + " 1 the bubble is built, 52 px, closed, in the bottom-right corner of the free area", s.on && !s.open && s.exp === "false" && mr && Math.abs(mr.w - 52) < 1 && Math.abs(mr.r - area.r) < 2 && Math.abs(mr.b - area.b) < 2, { s, mr, area });
  const exp = await R(p, "#btnExport"), inFan = await p.evaluate(() => ["rdBtn", "usBtn"].every((id) => !!document.getElementById(id).closest("#tbFan")));
  ok(tag + " 1 Export stays in the top bar, Redact and Search live in the fan (same ids)", !!exp && exp.t < 80 && inFan, { exp, inFan });
  await shot(p, dev.name + "-closed");
  // 2 open / second tap closes
  await act("#tbMain"); await W(400); s = await S(p); let it = await items(p); const tops = await TOPS(p);
  const vw = dev.w, vh = dev.h, onS = (r) => r.l >= -0.5 && r.t >= -0.5 && r.r <= vw + 0.5 && r.b <= vh + 0.5;
  const bad = it.filter((r) => !onS(r) || (r.lbl && !onS(r.lbl)) || r.w < 44 || r.h < 44 || r.vis !== "visible" || tops.some(([, t]) => X(r, t)));
  const pairs = []; for (let i = 0; i < it.length; i++) for (let j = i + 1; j < it.length; j++) { if (Math.hypot((it[i].l + it[i].r - it[j].l - it[j].r) / 2, (it[i].t + it[i].b - it[j].t - it[j].b) / 2) < (it[i].w + it[j].w) / 2 + 2) pairs.push([it[i].id, it[j].id]); /* round items: centre distance */ if (it[i].lbl && X(it[i].lbl, it[j])) pairs.push([it[i].id + ":lbl", it[j].id]); if (it[j].lbl && X(it[j].lbl, it[i])) pairs.push([it[j].id + ":lbl", it[i].id]); }
  ok(tag + " 2 a tap opens the fan: aria-expanded, Redact, Search, Events, Settings", s.open && s.exp === "true" && s.fan && it.map((x) => x.id).join() === "rdBtn,usBtn,tbEvents,tbSettings", { s, ids: it.map((x) => x.id) });
  ok(tag + " 2 fan items (and labels) on screen, >= 44 px, clear of the top bar / bottom controls and of each other", bad.length === 0 && pairs.length === 0, { bad, pairs, tops, it });
  await shot(p, dev.name + "-fan");
  await act("#tbMain"); s = await S(p);
  ok(tag + " 2 a second tap closes it", !s.open && s.exp === "false", s);
  // 3 Esc / outside tap
  await act("#tbMain"); await p.keyboard.press("Escape"); await W(300); s = await S(p);
  ok(tag + " 3 Esc closes the fan and focus returns to the bubble", !s.open && s.focus === "tbMain", s);
  await act("#tbMain"); const cam0 = await p.evaluate(() => TDC.focus.cam || null), vp = await R(p, "#viewport");
  await tapAt(vp.l + vp.w * 0.25, vp.t + vp.h * 0.3); s = await S(p); const cam1 = await p.evaluate(() => TDC.focus.cam || null);
  ok(tag + " 3 a tap outside closes the fan and does nothing else", !s.open && cam0 === cam1, { s, cam0, cam1 });
  // 4 items
  await act("#tbMain"); await act("#rdBtn"); s = await S(p);
  ok(tag + " 4 Redact opens the Redact tab and folds the fan", s.us && s.tab === "redact" && !s.open, s);
  await p.evaluate(() => TDC.searchUI.hide()); await W(500);
  await act("#tbMain"); await act("#usBtn"); s = await S(p);
  ok(tag + " 4 Search opens Find and folds the fan", s.us && s.tab === "find" && !s.open, s);
  await p.evaluate(() => TDC.searchUI.hide()); await W(500);
  await act("#tbMain"); await act("#tbSettings"); s = await S(p);
  ok(tag + " 4 Settings opens the drawer (bubble steps away)", s.settings && !s.open && s.away, s);
  await p.evaluate(() => document.getElementById("btnCloseSettings").click()); await W(500);
  await act("#tbMain"); await act("#tbEvents"); s = await S(p); const lr = await R(p, "#library");
  ok(tag + " 4 Events opens the slide-in sheet from the left, focus inside", s.sheet && s.libVis && lr && lr.l <= 1 && lr.w <= Math.min(320, vw - 48) + 1 && (s.focus === "ev" || s.focus === "libClose"), { s, lr });
  if (!phone) await shot(p, dev.name + "-events");
  else await shot(p, dev.name + "-events");
  await p.keyboard.press("Escape"); await W(500); s = await S(p);
  ok(tag + " 4 Esc closes the sheet", !s.sheet && !s.libVis, s);
  await act("#tbMain"); await act("#tbEvents"); await tapAt(vw - 30, vh * 0.35); s = await S(p);
  ok(tag + " 4 a tap outside closes the sheet", !s.sheet, s);
  await act("#tbMain"); await act("#tbEvents"); const ev0 = await p.evaluate(() => TDC.library.events.indexOf(TDC.ui.current));
  await p.evaluate(() => { const l = [...document.querySelectorAll("#libList .ev")]; const t = l.find((e) => !e.classList.contains("active")); t && t.click(); }); await W(1500); s = await S(p);
  const ev1 = await p.evaluate(() => TDC.library.events.indexOf(TDC.ui.current));
  ok(tag + " 4 picking an event loads it and closes the sheet", !s.sheet && ev1 !== ev0, { s, ev0, ev1 });
  await p.evaluate(() => { TDC.player.pause(); document.querySelectorAll(".toast").forEach((t) => t.remove()); }); await W(300);
  // 5 keyboard
  await p.evaluate(() => document.getElementById("tbMain").focus()); await p.keyboard.press("Enter"); await W(400); s = await S(p); const k1 = s.focus;
  await p.keyboard.press("ArrowDown"); const k2 = (await S(p)).focus; await p.keyboard.press("End"); const k3 = (await S(p)).focus; await p.keyboard.press("Home"); const k4 = (await S(p)).focus;
  await p.keyboard.press("Escape"); await W(300); const k5 = await S(p);
  ok(tag + " 5 keyboard: Enter opens and focuses the first item, arrows / End / Home move, Esc closes with focus back on the bubble", s.open && k1 === "rdBtn" && k2 === "usBtn" && k3 === "tbSettings" && k4 === "rdBtn" && !k5.open && k5.focus === "tbMain", { k1, k2, k3, k4, k5 });
  await p.keyboard.press("Enter"); await W(300); await p.evaluate(() => document.getElementById("btnExport").focus()); await W(200); s = await S(p);
  ok(tag + " 5 focus leaving the fan closes it", !s.open, s);
  await p.evaluate(() => document.activeElement && document.activeElement.blur()); await p.keyboard.press("/"); await W(500); s = await S(p);
  ok(tag + " 5 the / shortcut still opens Search", s.us && s.tab === "find", s);
  await p.evaluate(() => TDC.searchUI.hide()); await W(500);
  // 6 drag to a corner
  const cap = await p.evaluate(() => { let n = 0; const o = Element.prototype.setPointerCapture; Element.prototype.setPointerCapture = function (id) { if (this.closest && this.closest("#toolBubble")) n++; try { return o.call(this, id); } catch (_) {} }; window.__capN = () => n; return true; });
  let m = await R(p, "#tbMain");
  const dragTo = async (to, steps = 12) => {
    if (!touch) { await p.mouse.move(m.cx, m.cy); await p.mouse.down(); for (let i = 1; i <= steps; i++) await p.mouse.move(m.cx + (to.x - m.cx) * i / steps, m.cy + (to.y - m.cy) * i / steps); await W(60); await p.mouse.up(); await W(700); return; }
    const c = await ctx.newCDPSession(p);
    await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: m.cx, y: m.cy }] });
    for (let i = 1; i <= steps; i++) { await c.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: m.cx + (to.x - m.cx) * i / steps, y: m.cy + (to.y - m.cy) * i / steps }] }); await W(16); }
    await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await W(700); await c.detach();
  };
  await dragTo({ x: 60, y: area.t + 40 }); s = await S(p); m = await R(p, "#tbMain"); const a2 = await p.evaluate(() => TDC.bubble.area());
  ok(tag + " 6 dragged to the top left: snaps into that corner, saved, and the drag did not open the fan", s.corner === "tl" && s.pref === "tl" && Math.abs(m.l - a2.l) < 2 && Math.abs(m.t - a2.t) < 2 && !s.open, { s, m, a2 });
  ok(tag + " 6 no pointer capture on the bubble", (await p.evaluate(() => window.__capN())) === 0);
  if (touch) await dragTo({ x: m.cx + 3, y: m.cy + 2 }, 2); else await dragTo({ x: m.cx + 4, y: m.cy + 2 }, 3);
  s = await S(p);
  if (touch && !s.open) { console.log("INFO " + tag + " 6 a short CDP touch move gave no click in this emulation (checked with the mouse on desktop); plain tap instead"); await act("#tbMain"); s = await S(p); }
  else ok(tag + " 6 a move under 6 px still counts as a click (opens the fan)", s.open && s.corner === "tl", s);
  { it = await items(p); const bad2 = it.filter((r) => !onS(r) || (r.lbl && !onS(r.lbl)) || tops.some(([, t]) => X(r, t)));
    ok(tag + " 6 in the top-left corner the fan opens down / right, on screen, clear of the bars", bad2.length === 0, bad2); }
  await act("#tbMain");
  await open(p, true); s = await S(p);
  ok(tag + " 6 the corner is kept after a reload", s.corner === "tl", s);
  await p.evaluate(() => TDC.setPref("bubble.corner", "br")); await W(400);
  // 7 auto-hide
  await act("#tbMain");
  await p.evaluate(() => { TDC.setPref("autohide", "2"); TDC.player.seek(0.5); TDC.player.play(); TDC.autohide.wake(); });
  await W(3300); const ah1 = await p.evaluate(() => ({ gone: document.body.classList.contains("ah-gone") || document.body.classList.contains("idle"), why: TDC.autohide.why, open: TDC.bubble.open }));
  await act("#tbMain"); if (!touch) await p.mouse.move(vw / 2, vh * 0.35); let gone = false; for (let i = 0; i < 60 && !gone; i++) { await W(100); gone = await p.evaluate(() => document.body.classList.contains("idle")); }
  await W(500); const dot = await p.evaluate(() => { const cs = getComputedStyle(document.getElementById("toolBubble")); return { op: +cs.opacity, vis: cs.visibility }; });
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("autohide", "never"); TDC.autohide.wake(); }); await W(400);
  ok(tag + " 7 auto-hide: nothing hides while the fan is open (hold 'tools')", !ah1.gone && ah1.why === "tools" && ah1.open, ah1);
  ok(tag + " 7 auto-hide: when the controls hide the bubble stays as a faint dot", gone && dot.vis === "visible" && dot.op > 0.2 && dot.op < 0.8, { gone, dot });
  // 8 glass modes + budget
  const modes = {};
  for (const md of ["auto", "clear", "solid"]) { await p.evaluate((x) => { TDC.setPref("glass", x); TDC.glass.budget(); }, md); await act("#tbMain"); await p.evaluate(() => TDC.glass.budget()); await W(200);
    modes[md] = await p.evaluate(() => { const bf = (e) => { const cs = getComputedStyle(e); return cs.backdropFilter || cs.webkitBackdropFilter || "none"; }; return { n: TDC.glass.blurred.length, any: [...document.querySelectorAll("*")].filter((e) => bf(e) !== "none").length, main: bf(document.getElementById("tbMain")) }; });
    await act("#tbMain"); }
  await p.evaluate(() => TDC.setPref("glass", "auto")); await W(200);
  ok(tag + " 8 glass modes with the fan open: blur within the budget (<= 3), none in Solid", ["auto", "clear", "solid"].every((x) => modes[x].n <= 3 && modes[x].any <= 3) && modes.solid.any === 0, modes);
  // 9 reduced motion
  await p.emulateMedia({ reducedMotion: "reduce" }); await W(200);
  const rm = await p.evaluate(() => [document.getElementById("tbMain"), document.getElementById("toolBubble"), document.querySelector("#tbFan .tb-item"), document.getElementById("library")].map((e) => getComputedStyle(e).transitionDuration));
  await p.emulateMedia({ reducedMotion: "no-preference" });
  ok(tag + " 9 reduced motion: no springs on the bubble, fan or sheet", rm.every((d) => d.split(",").every((x) => parseFloat(x) <= 0.011)), rm);
  // 10 drawing / picking
  const aw = await p.evaluate(async () => { const o = {}; for (const c of ["cr-picking", "cr-bar-on"]) { document.body.classList.add(c); await new Promise((r) => setTimeout(r, 400)); o[c] = getComputedStyle(document.getElementById("toolBubble")).visibility; document.body.classList.remove(c); await new Promise((r) => setTimeout(r, 400)); } o.back = getComputedStyle(document.getElementById("toolBubble")).visibility; return o; });
  ok(tag + " 10 steps away while picking / drawing a region (tap-redact, draw bar), back after", aw["cr-picking"] === "hidden" && aw["cr-bar-on"] === "hidden" && aw.back === "visible", aw);
  // 11 floating map: down to the window bottom
  await p.evaluate(() => TDC.overlays.setMapHome("float", true)); await W(500);
  const g0 = await R(p, "#mapGrip"); const ctlTop = Math.min(vh, ...tops.filter(([id]) => id !== "topbar").map(([, r]) => r.t));
  if (g0) {
    m = g0; await dragTo({ x: g0.cx, y: vh - 3 }, 14);
    const mp = await R(p, "#panel-map"), g1 = await R(p, "#mapGrip"), fl = await p.evaluate(() => TDC.overlays.floatFloor());
    ok(tag + " 11 the floating map drags past the button row towards the window bottom (no hard stop above Search / Redact)", mp && mp.b > fl + 20 && mp.t < vh - 30, { mp, fl });
    ok(tag + " 11 ... its grip stays on screen and above the bottom bar", g1 && g1.t >= 0 && g1.b <= ctlTop + 0.5, { g1, ctlTop });
    await p.evaluate(() => TDC.overlays.setMapHome("aside", true)); await W(300);
  } else ok(tag + " 11 floating map grip found", false);
  // 12 phone event picker
  if (phone) {
    const ep = await p.evaluate(() => { const e = document.getElementById("eventPick"), r = e.getBoundingClientRect(), cs = getComputedStyle(e);
      const kids = [...document.querySelectorAll(".topbar .brand, .topbar .top-actions > *")].filter((x) => x.getClientRects().length && getComputedStyle(x).display !== "none").map((x) => { const q = x.getBoundingClientRect(); return { id: x.id || x.className, l: q.left, t: q.top, r: q.right, b: q.bottom }; });
      return { r: { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }, app: cs.webkitAppearance || cs.appearance, bg: cs.backgroundImage.slice(0, 30), txt: e.options[e.selectedIndex] && e.options[e.selectedIndex].textContent, vw: innerWidth, kids }; });
    const hit = ep.kids.filter((k) => X(ep.r, k));
    const adv = await p.evaluate(async () => { const a = document.getElementById("advToggle"); const was = a.checked; if (!was) { a.checked = true; a.dispatchEvent(new Event("change", { bubbles: true })); } await new Promise((r) => setTimeout(r, 400));
      const e = document.getElementById("eventPick").getBoundingClientRect(), o = { sw: document.documentElement.scrollWidth, vw: innerWidth, h: e.height, w: e.width, r: e.right };
      if (!was) { a.checked = false; a.dispatchEvent(new Event("change", { bubbles: true })); } return o; });
    ok(tag + " 12 Advanced mode too: the top bar fits (no sideways overflow), picker still >= 44 px", adv.sw <= adv.vw + 0.5 && adv.h >= 44 && adv.w >= 88, adv);
    ok(tag + " 12 the event picker is a >= 44 px target (>= 88 px wide) with a drawn chevron", ep.r.h >= 44 && ep.r.w >= 88 && /svg/.test(ep.bg) && ep.app === "none", ep);
    ok(tag + " 12 ... showing the date and time, on screen, overlapping nothing in the top bar", /\d\d-\d\d \d\d:\d\d/.test(ep.txt || "") && ep.r.l >= 0 && ep.r.r <= ep.vw && hit.length === 0, { r: ep.r, hit });
    const ti = await p.evaluate(() => { const e = document.getElementById("tbEvents"); return e ? e.getAttribute("aria-label") : null; });
    ok(tag + " 12 the bubble's Events item is labelled and was >= 44 px (checked in 2)", ti === "Events");
    await shot(p, "events-pick-" + dev.name, { x: 0, y: 0, width: dev.w, height: Math.min(dev.h, 120) });
  }
  ok(tag + " 13 no page errors", errs.length === 0, errs.slice(0, 3));
  await ctx.close();
}
async function dock(b, BR, w, h) {
  const tag = BR + " dock-" + w + "x" + h, ctx = await b.newContext({ viewport: { width: w, height: h } }), p = await ctx.newPage(), errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await open(p);
  await p.evaluate(() => { for (let i = 0; i < 4; i++) TDC.regions.add({ cam: ["back", "front", "left_repeater", "right_repeater"][i], shape: "rect", mode: i % 2 ? "remove" : "blur", x: 0.1 + 0.05 * i, y: 0.2, w: 0.2, h: 0.1 }); });
  const M = () => p.evaluate(() => { const r = (id) => { const e = document.getElementById(id); if (!e || !e.getClientRects().length) return null; const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, h: b.height, w: b.width }; };
    const pn = document.getElementById("usPanel"); return { dock: r("usDock"), panel: r("usPanel"), stage: r("stage"), tp: r("transport"), vh: innerHeight, vw: innerWidth, docked: document.body.classList.contains("us-docked") && pn.classList.contains("docked"), sw: pn.scrollWidth, cw: pn.clientWidth, dw: document.documentElement.scrollWidth }; });
  // reachable: on screen inside the panel after scrolling the panel to it (never clipped by the window)
  const reach = (ids) => p.evaluate((ids) => { const pn = document.getElementById("usPanel"), bad = [];
    for (const s of ids) { const e = document.querySelector(s); if (!e) { bad.push(s + " missing"); continue; } const cs = getComputedStyle(e); if (e.hidden || cs.display === "none" || cs.visibility === "hidden") { bad.push(s + " hidden"); continue; }
      e.scrollIntoView({ block: "nearest", inline: "nearest" }); const b = e.getBoundingClientRect(), q = pn.getBoundingClientRect();
      if (b.width < 8 || b.height < 8 || b.top < q.top - 1 || b.bottom > q.bottom + 1 || b.left < q.left - 1 || b.right > q.right + 1 || b.bottom > innerHeight || b.right > innerWidth) bad.push(s + " " + [b.left, b.top, b.width, b.height].map(Math.round)); }
    pn.scrollTop = 0; return bad; }, ids);
  for (const tab of ["redact", "find"]) {
    await p.evaluate((t) => TDC.searchUI.show(false, t), tab); await W(700);
    const m = await M(), t = tag + " " + tab;
    ok(t + " 14 docked below the video", m.docked && !!m.dock, m);
    ok(t + " 14 the dock takes at most 30% of the window height", m.dock.h <= m.vh * 0.30 + 1, { dock: m.dock.h, vh: m.vh, pct: Math.round(m.dock.h / m.vh * 1000) / 10 });
    ok(t + " 14 the video keeps the rest: no overlap with the video area or the controls", !X(m.dock, m.stage) && !X(m.dock, m.tp) && m.dock.b <= m.tp.t + 1, m);
    ok(t + " 14 no sideways overflow (panel and page)", m.sw <= m.cw + 1 && m.dw <= m.vw + 1, m);
    if (tab === "redact") {
      const bad = await reach(["#usTabFind", "#usTabRedact", "#usFloat", "#usClose", "#crDraw", "#crSave", "#crShape button[data-v=free]", "#crMode button[data-v=remove]", "#crWhole", "#crInfo", "#crExportFile", "#crImportFile", "#crList li:last-child [data-act]", "#usQuery", "#usCam", "#usRedact", "#usPanel .us-presets .us-chip:last-child", "#usClassic"]);
      ok(t + " 14 every Redact control is reachable inside the panel", bad.length === 0, bad);
      const lst = await p.evaluate(() => { const l = document.getElementById("crList"), cs = getComputedStyle(l); return { mh: parseFloat(cs.maxHeight), oy: cs.overflowY, sh: l.scrollHeight, ch: l.clientHeight, n: l.children.length }; });
      ok(t + " 14 the saved regions list scrolls, small max height (<= 90 px)", lst.n === 4 && lst.mh <= 90 && ["auto", "scroll"].includes(lst.oy) && lst.sh > lst.ch, lst);
      const hint0 = await p.evaluate(() => { const h = document.getElementById("crHint"), i = document.getElementById("crInfo"); return { hint: getComputedStyle(h).display !== "none", exp: i.getAttribute("aria-expanded"), ctl: i.getAttribute("aria-controls"), lbl: i.getAttribute("aria-label") }; });
      ok(t + " 14 the long help text is folded behind (i) (aria-expanded false, labelled)", !hint0.hint && hint0.exp === "false" && hint0.ctl === "crHint" && !!hint0.lbl, hint0);
      await p.click("#crInfo"); await W(200);
      const hint1 = await p.evaluate(() => ({ hint: getComputedStyle(document.getElementById("crHint")).display !== "none" && document.getElementById("crHint").getBoundingClientRect().height > 10, exp: document.getElementById("crInfo").getAttribute("aria-expanded"), txt: /tap the camera/i.test(document.getElementById("crHint").textContent) }));
      ok(t + " 14 (i) shows the help (aria-expanded true) and hides it again", hint1.hint && hint1.exp === "true" && hint1.txt, hint1);
      await p.keyboard.press("Enter"); await W(200);
      ok(t + " 14 ... the (i) works from the keyboard too", await p.evaluate(() => document.activeElement.id === "crInfo" && getComputedStyle(document.getElementById("crHint")).display === "none"));
      const auto = await p.evaluate(() => { const c = [...document.querySelectorAll("#usPanel .us-presets .us-chip")].filter((e) => e.getClientRects().length), tops = [...new Set(c.map((e) => Math.round(e.getBoundingClientRect().top)))];
        const q = document.getElementById("usQuery").getBoundingClientRect(), d = document.getElementById("crDraw").getBoundingClientRect(); return { rows: tops.length, n: c.length, qTop: q.top, drawTop: d.top, qL: q.left, dR: d.right }; });
      ok(t + " 14 automatic options sit in a compact block beside the custom regions (presets in <= 2 rows, side by side, not below)", auto.n >= 4 && auto.rows <= 2 && auto.qL > auto.dR && Math.abs(auto.qTop - auto.drawTop) < 60, auto);
      // behaviour unchanged: Draw region hides the panel, Cancel brings it back on Redact
      await p.click("#crDraw"); await W(700);
      ok(t + " 14 Draw region still hides the panel for drawing", await p.evaluate(() => !TDC.searchUI.open && !document.getElementById("crBar").hidden));
      await p.evaluate(() => document.getElementById("crBarCancel").click()); await W(600);
      ok(t + " 14 Cancel brings the docked panel back on Redact", await p.evaluate(() => TDC.searchUI.open && document.getElementById("usPanel").dataset.tab === "redact"));
      await p.evaluate(() => { const c = document.getElementById("crWhole"); if (c.checked) c.click(); }); await W(300);
      const bad2 = await reach(["#crFrom", "#crTo", "#crFromNow", "#crToNow"]);
      ok(t + " 14 time span fields (Whole clip off) are reachable too", bad2.length === 0, bad2);
      await p.evaluate(() => { const c = document.getElementById("crWhole"); if (!c.checked) c.click(); }); await W(300);
    } else {
      const bad = await reach(["#usTabFind", "#usTabRedact", "#usFloat", "#usClose", "#usQuery", "#usCam", "#usFind", "#usHl", "#usRd", "#usClassic"]);
      ok(t + " 14 every Find control is reachable inside the panel", bad.length === 0, bad);
      await p.fill("#usQuery", "a cyclist"); await W(100);
      ok(t + " 14 Find still types and keeps the Find tab", await p.evaluate(() => document.getElementById("usQuery").value === "a cyclist" && document.getElementById("usPanel").dataset.tab === "find"));
      await p.fill("#usQuery", "");
    }
    await shot(p, tab + "-docked-" + w + "x" + h);
  }
  await p.keyboard.press("Escape"); await W(300);
  ok(tag + " 14 Esc still closes the docked panel and the dock goes away", await p.evaluate(() => !TDC.searchUI.open && document.getElementById("usDock").hidden));
  ok(tag + " 14 no page errors", errs.length === 0, errs.slice(0, 3));
  await ctx.close();
}
(async () => {
  if (!fs.existsSync(FIX + "/TeslaCam")) execFileSync("python3", [path.join(ROOT, "tools/make-mock-footage.py"), FIX], { stdio: "inherit" });
  const srv = await server(); const pw = require("playwright");
  const DEVS = [{ name: "desktop-1440x900", w: 1440, h: 900, touch: 0 }, { name: "phone-390x844", w: 390, h: 844, touch: 1 }, { name: "phone-430x932", w: 430, h: 932, touch: 1 }, { name: "phone-844x390", w: 844, h: 390, touch: 1 }];
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    let b;
    try { b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }); }
    catch (e) { console.log("SKIP " + BR + ": cannot launch (" + e.message.split("\n")[0] + ")"); continue; }
    for (const d of DEVS.filter((d) => !process.env.DEV || d.name.startsWith(process.env.DEV))) { try { await run(b, BR, d); } catch (e) { ok(BR + " " + d.name + " run threw: " + e.message.split("\n")[0], false); } }
    if (!process.env.DEV || process.env.DEV === "dock") for (const [w, h] of [[1024, 553], [1280, 720], [1440, 900]]) { try { await dock(b, BR, w, h); } catch (e) { ok(BR + " dock-" + w + "x" + h + " run threw: " + e.message.split("\n")[0], false); } }
    await b.close();
  }
  srv.close(); console.log(fails ? "FAILED " + fails : "ALL PASSED"); process.exit(fails ? 1 : 0);
})();
