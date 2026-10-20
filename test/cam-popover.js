// Cameras picker popover (tag cam-popover): the "Cameras" menu of the camera bar is never clipped or covered, wherever
// the bar is: floating at the top (default), floating at the bottom, docked beside the video (below or above it), in
// full screen and in the phone layout. Checks: the menu is fully inside the viewport, elementFromPoint at each option
// is that option (nothing covers it), it opens upward when the bar is at the bottom, it follows the bar while dragged,
// tap toggles a camera, keyboard: Enter opens and focuses the first camera, arrows move, Space toggles, Esc closes.
// Playwright Chromium + WebKit, tools/make-moving-footage.py footage.   Usage: node test/cam-popover.js [url]
const pw = require("playwright"); const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.MOVING_SAMPLES || "/tmp/moving-samples";
const SHOTS = process.env.SHOTS || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(FIX + "/truth.json")) execFileSync("python3", [path.join(__dirname, "../tools/make-moving-footage.py"), FIX], { stdio: "inherit" });
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) w(q); else files.push(q); } })(FIX + "/TeslaCam");
const SAFARI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const SIX_DIR = process.env.SIX_CAMS || "/workspace/photo-samples/TeslaCam/SavedClips";   // any 6-camera event (tiles only)
const SIX = fs.existsSync(SIX_DIR) ? (() => { const o = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) w(q); else o.push(q); } })(SIX_DIR); return o; })() : files;
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x).slice(0, 600) : "")); if (!c) fails++; };
async function load(p, list) {
  await p.goto(URL_, { waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important}" });
  await p.setInputFiles("#fileInput", list || files);
  for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
  await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); return TDC.ui.activate(TDC.library.events[0]); });
  await W(1200);
}
/** Where the bar is: "top" / "bottom" floating on the video, or docked "beside" (above / below the video). */
const setBar = (p, where) => p.evaluate(async (where) => {
  const F = TDC.focus; if (F.camMenu) F.camMenu(false); else document.getElementById("camMenu").hidden = true;
  if (where.startsWith("beside")) F.setBarDock("beside", where === "beside-top" ? "top" : "bottom");
  else { F.setBarDock("over"); TDC.prefs.cameraBar.grid = where === "bottom" ? { fx: 0.5, fy: 1 } : { fx: -1, fy: -1 }; TDC.savePrefs(); F.placeBar(); }
  await new Promise((r) => setTimeout(r, 400));
}, where);
/** Open the menu by tapping the button and measure it. */
const openMeasure = (p) => p.evaluate(async () => {
  const m = document.getElementById("camMenu"), b = document.getElementById("btnCams");
  if (m.hidden) b.click();
  await new Promise((r) => setTimeout(r, 300));
  return measure();
  function measure() {
    const r = m.getBoundingClientRect(), br = b.getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
    const rows = [...m.querySelectorAll(".cm-row")].map((row) => {
      row.scrollIntoView({ block: "nearest" });
      const q = row.getBoundingClientRect(), x = q.left + q.width / 2, y = q.top + q.height / 2, el = document.elementFromPoint(x, y);
      return { ok: !!el && (el === row || row.contains(el)), hit: el ? (el.id || el.className || el.tagName) + "" : null, inside: q.top >= r.top - 1 && q.bottom <= r.bottom + 1 };
    });
    const bar = document.getElementById("stageBar").getBoundingClientRect(), st = document.getElementById("stage") ? document.getElementById("stage").getBoundingClientRect() : null;
    return { open: !m.hidden, dir: m.dataset.dir, inView: r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh && r.width > 0, rect: [r.left, r.top, r.right, r.bottom].map(Math.round), btn: [br.left, br.top, br.right, br.bottom].map(Math.round), vw, vh, above: r.bottom <= br.top + 1, belowBtn: r.top >= br.bottom - 1, rows, covered: rows.filter((x) => !x.ok).map((x) => x.hit), expanded: b.getAttribute("aria-expanded"), parent: m.parentElement.tagName, barMid: Math.round(bar.top + bar.height / 2), stageMid: st ? Math.round(st.top + st.height / 2) : null };
  }
});
const good = (m) => m.open && m.inView && m.rows.length === 6 && m.covered.length === 0 && m.rows.every((x) => x.inside);
async function shot(p, name, bn) { if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `cam-popover-${name}-${bn}.png`) }); }
(async () => {
  for (const bn of (process.env.BR || "chromium,webkit").split(",")) {
    const b = await pw[bn].launch(bn === "chromium" ? { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] } : {});
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => { if (!sessionStorage.getItem("cp")) { sessionStorage.setItem("cp", "1"); localStorage.removeItem("tdc.prefs.v1"); } });
    const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
    await load(p); const tag = bn;
    // the floating search and the map open too: the menu must be above them
    await p.evaluate(() => { try { const s = TDC.prefs.show; s.map = true; TDC.savePrefs && TDC.savePrefs(); TDC.ui.applyShow && TDC.ui.applyShow(); } catch (_) {} });

    await setBar(p, "top");
    let m = await openMeasure(p);
    ok(tag + ": bar at the top (default): menu in a top-level layer, opens downward, fully inside the viewport, every option on top", good(m) && m.dir === "down" && m.belowBtn && m.parent === "BODY" && m.expanded === "true", m);
    await shot(p, "top", bn);

    await setBar(p, "bottom");
    m = await openMeasure(p);
    ok(tag + ": bar floating at the bottom of the video: opens upward, fully inside the viewport, no option covered", good(m) && m.dir === "up" && m.above, m);
    await shot(p, "floating-bottom", bn);

    await setBar(p, "beside-bottom");
    m = await openMeasure(p);
    ok(tag + ": bar docked beside the video (below it): opens upward over the video, fully inside, no option covered", good(m) && m.dir === "up" && m.above, m);
    await shot(p, "beside-bottom", bn);

    await setBar(p, "beside-top");
    m = await openMeasure(p);
    ok(tag + ": bar docked beside the video (above it): fully inside the viewport, no option covered", good(m) && m.dir === "down", m);
    await shot(p, "beside-top", bn);

    // tap an option: toggles that camera, the menu stays open and still on top
    await setBar(p, "bottom"); await openMeasure(p);
    const before = await p.evaluate(() => TDC.GRID.filter((c) => TDC.focus.isHidden ? TDC.focus.isHidden(c) : false).length);
    const row = p.locator("#camMenu .cm-row").nth(1); await row.click(); await W(300);
    m = await openMeasure(p);
    const t1 = await p.evaluate(() => [...document.querySelectorAll("#camMenu input")].map((x) => x.checked));
    await row.click(); await W(300);
    const t2 = await p.evaluate(() => [...document.querySelectorAll("#camMenu input")].map((x) => x.checked));
    ok(tag + ": tapping an option hides / shows that camera, the menu stays open and on top", t1[1] === false && t2[1] === true && good(m), { t1, t2, covered: m.covered });

    // follows the bar while it is dragged (top → bottom), flipping upward
    await setBar(p, "top"); await openMeasure(p);
    const g = await p.locator("#barGrip").boundingBox(), st = await p.locator("#stage").boundingBox();
    await p.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await p.mouse.down();
    for (let i = 1; i <= 12; i++) { await p.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + (st.y + st.height - 30 - g.y) * i / 12); await W(30); }
    await W(150);
    const mid = await openMeasure(p);
    await p.mouse.up(); await W(400);
    m = await openMeasure(p);
    ok(tag + ": stays open while the bar is dragged to the bottom and follows it (opens upward), still inside and on top", mid.open && good(m) && m.dir === "up" && m.above, { mid: [mid.open, mid.dir, mid.rect, mid.btn], m });
    await p.evaluate(() => TDC.focus.resetBarPos());

    // keyboard
    await p.evaluate(() => { if (TDC.focus.camMenu) TDC.focus.camMenu(false); else document.getElementById("camMenu").hidden = true; }); await W(100);
    await p.focus("#btnCams"); await p.keyboard.press("Enter"); await W(250);
    const k1 = await p.evaluate(() => ({ open: !document.getElementById("camMenu").hidden, focus: document.activeElement && document.activeElement.dataset.cam }));
    await p.keyboard.press("ArrowDown"); await W(50);
    const k2 = await p.evaluate(() => document.activeElement && document.activeElement.dataset.cam);
    await p.keyboard.press("Space"); await W(200);
    const k3 = await p.evaluate(() => [...document.querySelectorAll("#camMenu input")].map((x) => x.checked));
    await p.evaluate(() => { const i = document.querySelectorAll("#camMenu input")[1]; i.focus(); }); await p.keyboard.press("Space"); await W(200);
    await p.evaluate(() => document.querySelectorAll("#camMenu input")[0].focus()); await p.keyboard.press("Escape"); await W(200);
    const k4 = await p.evaluate(() => ({ open: !document.getElementById("camMenu").hidden, focus: document.activeElement && document.activeElement.id, checked: [...document.querySelectorAll("#camMenu input")].map((x) => x.checked) }));
    ok(tag + ": keyboard: Enter opens and focuses the first camera, ↓ moves, Space toggles, Esc closes and returns to the button", k1.open && !!k1.focus && k2 && k2 !== k1.focus && k3[1] === false && !k4.open && k4.focus === "btnCams" && k4.checked.every(Boolean), { k1, k2, k3, k4 });
    // a tap outside closes it
    await p.click("#btnCams"); await W(200); await p.mouse.click(5, 5); await W(200);
    ok(tag + ": a tap outside closes it (aria-expanded=false)", await p.evaluate(() => document.getElementById("camMenu").hidden && document.getElementById("btnCams").getAttribute("aria-expanded") === "false"));

    // full screen, bar at the bottom
    const fsOn = await p.evaluate(async () => { try { await TDC.focus.fullscreen(true); } catch (_) {} await new Promise((r) => setTimeout(r, 700)); return document.body.classList.contains("fs"); });
    await setBar(p, "bottom");
    m = await openMeasure(p);
    ok(tag + ": full screen, bar at the bottom: opens upward, inside, above the floating controls", fsOn && good(m) && m.dir === "up", m);
    await shot(p, "fullscreen", bn);
    await p.evaluate(async () => { if (TDC.focus.camMenu) TDC.focus.camMenu(false); else document.getElementById("camMenu").hidden = true; try { await TDC.focus.fullscreen(false); } catch (_) {} });
    await W(500);

    // phone portrait, bar at the bottom of the video and docked below it
    await p.setViewportSize({ width: 390, height: 844 }); await W(700);
    await setBar(p, "bottom");
    m = await openMeasure(p);
    ok(tag + ": phone portrait, bar at the bottom: inside the viewport, opens upward, no option covered", good(m) && m.dir === "up", m);
    await shot(p, "phone", bn);
    await setBar(p, "beside-bottom");
    m = await openMeasure(p);
    ok(tag + ": phone portrait, bar docked below the video: inside the viewport, no option covered", good(m), m);
    // short landscape phone: little room above or below → sideways or scrolling, still inside
    await p.setViewportSize({ width: 844, height: 390 }); await W(700);
    await setBar(p, "bottom");
    m = await openMeasure(p);
    const scrolls = await p.evaluate(() => { const e = document.getElementById("camMenu"); return { sh: e.scrollHeight, ch: e.clientHeight }; });
    ok(tag + ": short landscape phone: fully inside the viewport (sideways or scrolling), visible options not covered", m.open && m.inView && m.rows.length === 6 && m.covered.length === 0, { m, scrolls });
    await shot(p, "landscape", bn);
    await setBar(p, "top");
    ok(tag + ": no page errors", errs.length === 0, errs.slice(0, 3));

    // ── the user's Safari layout (tag cam-popover-fix): bar docked at the bottom under a 6-camera grid, small window
    //    (820×445), Safari desktop UA, white balance ON (filter / tint on the videos) ──
    const sctx = await b.newContext({ viewport: { width: 820, height: 445 }, userAgent: bn === "webkit" ? SAFARI_UA : undefined });
    await sctx.addInitScript(() => { if (!sessionStorage.getItem("cps")) { sessionStorage.setItem("cps", "1"); localStorage.removeItem("tdc.prefs.v1"); localStorage.setItem("tdc.wb.v1", "1"); } });
    const sp = await sctx.newPage(); const serrs = []; sp.on("pageerror", (e) => serrs.push(e.message));
    await load(sp, SIX);
    await sp.evaluate(() => { if (TDC.focus.dismissHint) TDC.focus.dismissHint(); TDC.focus.setBarDock("beside", "bottom"); }); await W(700);
    const sm = await openMeasure(sp);
    const extra = await sp.evaluate(() => {
      const m = document.getElementById("camMenu").getBoundingClientRect(), b = document.getElementById("btnCams").getBoundingClientRect(), tp = document.getElementById("transport").getBoundingClientRect();
      const cx = (m.left + m.right) / 2;
      return { centreInBtn: cx >= b.left && cx <= b.right, rightAligned: Math.abs(m.right - b.right) <= 2, bottomAboveBtn: m.bottom <= b.top + 0.5, overTimeline: m.bottom > tp.top + 0.5 && m.top < tp.bottom, wbOn: TDC.wb.isOn(), mode: TDC.wb.mode(), tiles: document.querySelectorAll("#grid .tile").length, inBody: document.getElementById("camMenu").parentElement === document.body, staticInBody: !!document.querySelector("body > #camMenu") };
    });
    ok(tag + ": Safari layout (820×445, bar docked below a 6-camera grid, white balance on): menu on <body>, anchored to the Cameras button (centre inside it or right-aligned), bottom above the button, opens upward",
      extra.inBody && extra.staticInBody && (extra.centreInBtn || extra.rightAligned) && extra.bottomAboveBtn && sm.dir === "up" && extra.wbOn && extra.tiles === 6, { extra, rect: sm.rect, btn: sm.btn });
    ok(tag + ": Safari layout: fully inside the window, all 6 options hittable (elementFromPoint = the option), not over the timeline", good(sm) && !extra.overTimeline, { covered: sm.covered, rect: sm.rect, vh: sm.vh });
    if (SHOTS) await sp.screenshot({ path: path.join(SHOTS, `cam-popover-safari-layout-${bn}.png`) });
    ok(tag + ": Safari layout: no page errors", serrs.length === 0, serrs.slice(0, 3));
    await sctx.close();
    await b.close();
  }
  console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
