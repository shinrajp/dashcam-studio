// bar-fix (tag bar-fix): the custom-redaction draw bar (#crBar: Save region / Draw again / Cancel / Options) must never block drawing.
//   1. the bar is one compact row (no wrapping at 390 px) and click-through: only its grip and buttons catch the pointer
//   2. a stroke that starts in the bar's gaps / runs through the bar's area is recorded (mouse; real touch on Chromium)
//   3. the bar glides to the opposite edge when the stroke starts / grows near it (never under the finger), and back again when needed
//   4. the grip drags the bar anywhere on screen (kept inside the viewport), the position is remembered for the session
//   5. Save region / Draw again / Cancel / Options still work; worst-case labels still fit in one row
// Playwright, Chromium (system Chrome) and WebKit (BR=chromium|webkit), desktop 1280x800 + phone 390x844 (DEV=desktop|phone). Mock footage only
// (tools/make-mock-footage.py -> /tmp/ho-mock on first run). Serves the repo itself on PORT (default 8801).  SHOTS=dir writes mock-data screenshots.
// Usage: BR=chromium|webkit [DEV=phone] [SHOTS=dir] node test/bar-fix.js
const fs = require("fs"), path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", PORT = +(process.env.PORT || 8801), SHOTS = process.env.SHOTS || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 800) : "")); if (!c) fails++; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".onnx": "application/octet-stream", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html"; fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; return r.end(); } r.setHeader("Content-Type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }).listen(PORT, "127.0.0.1", () => res(s)); });
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const BASE = `http://127.0.0.1:${PORT}/index.html?nosw=1`;

async function openEvent(p) {
  await p.goto(BASE, { waitUntil: "load" });
  await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.prefs.v1"); localStorage.removeItem("tdc.regions.v1"); localStorage.removeItem("tdc.searchPanel.v1"); sessionStorage.removeItem("dcs.crBarPos.v1"); });
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events[0]); }); await W(1500);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); });
}
const vis = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return !e.hidden && getComputedStyle(e).display !== "none" && r.width > 0 && r.height > 0; }, sel);
const barInfo = (p) => p.evaluate(() => {
  const b = document.getElementById("crBar"), r = b.getBoundingClientRect(), bs = [...b.querySelectorAll("button")].filter((x) => x.offsetParent).map((x) => { const q = x.getBoundingClientRect(); return { id: x.id, t: q.top, b: q.bottom, l: q.left, r: q.right, h: q.height }; });
  return { hidden: b.hidden, l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, edge: b.dataset.edge, free: b.classList.contains("free"), btns: bs, pe: getComputedStyle(b).pointerEvents, safeTop: 0 };
});
const startDraw = async (p, shape) => {
  await p.evaluate(() => { TDC.regions.ui.shape = "rect"; });
  if (shape) await p.evaluate((s) => { TDC.regions.ui.shape = s; TDC.regions.UI.sync(); }, shape);
  await p.evaluate(() => document.getElementById("crDraw").click()); await W(500);
};
const resetBar = async (p) => { await p.evaluate(() => { TDC.regions.UI.barReset(); try { sessionStorage.removeItem("dcs.crBarPos.v1"); } catch (_) {} }); };
const cancelDraw = async (p) => { await p.evaluate(() => { const b = document.getElementById("crBarCancel"); if (b && b.offsetParent) b.click(); else document.getElementById("crCancel").click(); }); await W(250); };
const drawMouse = async (p, pts, hold) => { await p.mouse.move(pts[0][0], pts[0][1]); await p.mouse.down(); for (const q of pts.slice(1)) { await p.mouse.move(q[0], q[1], { steps: 4 }); await W(30); } if (hold) return; await p.mouse.up(); await W(150); };
const drawState = (p) => p.evaluate(() => { const S = TDC.regions.ui; return { drawing: S.drawing, draft: S.draft ? JSON.parse(JSON.stringify(S.draft)) : null }; });
const tileRect = (p) => p.evaluate(() => { const c = TDC.regions.ui.cam, t = TDC.player.tiles[c].tile.getBoundingClientRect(); const f = TDC.regions.screenFit ? null : null; return { l: t.left, t: t.top, r: t.right, b: t.bottom }; });


const overlapY = (a, b) => Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
async function overlapsTile(p) { const bi = await barInfo(p), tr = await tileRect(p); return overlapY({ t: bi.t, b: bi.b }, tr); }
const gripDrag = async (p, toY, toX) => {
  const g = await p.evaluate(() => { const r = document.getElementById("crBarGrip").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await p.mouse.move(g.x, g.y); await p.mouse.down(); await p.mouse.move(toX == null ? g.x : toX, (g.y + toY) / 2, { steps: 5 }); await p.mouse.move(toX == null ? g.x : toX, toY, { steps: 6 }); await p.mouse.up(); await W(250);
};
/** Put the bar (free mode, by its grip) over the low or high part of the picture. */
async function placeBar(p, where) {
  const tr = await tileRect(p), bi = await barInfo(p), cy = where === "low" ? tr.b - 38 : tr.t + 38;
  await gripDrag(p, Math.round(cy), null);
}
/** A stroke that starts just above (low) / below (high) the bar, runs through the bar's spot and on. Returns what happened. */
async function nearStroke(p, where, natural, shape) {
  if (!natural) await placeBar(p, where);
  const before = await barInfo(p), tr = await tileRect(p);
  const cx = Math.round((before.l + before.r) / 2), yMid = Math.round((before.t + before.b) / 2), cl = (y) => Math.min(tr.b - 5, Math.max(tr.t + 5, y));
  const pts = where === "low"
    ? [[cx - 80, cl(yMid - 70)], [cx - 100, cl(yMid - 40)], [cx - 100, cl(yMid)], [cx, cl(yMid + 6)], [cx + 100, cl(yMid)], [cx + 100, cl(yMid - 50)], [cx + 60, cl(yMid - 70)]]
    : [[cx - 80, cl(yMid + 70)], [cx - 100, cl(yMid + 40)], [cx - 100, cl(yMid)], [cx, cl(yMid - 6)], [cx + 100, cl(yMid)], [cx + 100, cl(yMid + 50)], [cx + 60, cl(yMid + 70)]];
  const last = pts[pts.length - 1];
  await drawMouse(p, shape === "rect" ? [pts[0], pts[2], pts[3]] : pts);
  const ds = await drawState(p), after = await barInfo(p);
  const fy = shape === "rect" ? pts[3][1] : last[1];
  const expect = fy > before.vh / 2 ? "top" : "bottom";
  const moved = Math.abs(after.t - before.t) > 20 || Math.abs(after.l - before.l) > 20;
  const under = last[0] > after.l - 6 && last[0] < after.r + 6 && fy > after.t - 6 && fy < after.b + 6;
  return { ds, before, after, expect, moved, under, tile: tr };
}

async function run(b, dev, tag) {
  const ctx = await b.newContext(dev.ctx); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await openEvent(p);
    await p.click("#usBtn"); await W(400);
  await p.evaluate(() => { document.getElementById("crSec").open = true; }); await W(200);
  await startDraw(p, "free");
  ok(tag + " 1 draw bar shown while drawing", await vis(p, "#crBar"));
  let bi = await barInfo(p);
  const top0 = Math.min(...bi.btns.map((x) => x.t)), bot0 = Math.max(...bi.btns.map((x) => x.b));
  ok(tag + " 1 one compact row: every control on the same line, bar height < 60", bot0 - top0 < 48 && bi.h < 60 && bi.btns.length >= 3, bi);
  ok(tag + " 1 inside the screen width", bi.l >= 0 && bi.r <= bi.vw, bi);
  ok(tag + " 1 buttons are 40 px tall (touch targets)", Math.min(...bi.btns.map((x) => x.h)) >= 40, bi);
  ok(tag + " 1 container ignores the pointer, the buttons and grip catch it", bi.pe === "none" && (await p.evaluate(() => [...document.querySelectorAll("#crBar button")].every((x) => getComputedStyle(x).pointerEvents === "auto"))));
  ok(tag + " 1 grip handle present", await vis(p, "#crBarGrip"));
  ok(tag + " 1 bottom edge by default, above the transport bar", bi.edge === "bottom" && bi.b <= bi.vh, bi);
  if (SHOTS) await p.screenshot({ path: SHOTS + "/bar-bottom-" + tag.replace(/\W+/g, "-") + ".png" });
  // click-through: a point in the bar's border / padding is NOT the bar
  const thru = await p.evaluate(() => { const b = document.getElementById("crBar"), r = b.getBoundingClientRect(), e = document.elementFromPoint(r.left + 1.5, r.top + 1.5); return { id: e && e.id, cls: e && e.className, inBar: !!e && b.contains(e) }; });
  ok(tag + " 2 the bar's own corner is click-through (not the bar)", !thru.inBar, thru);

  // --- 2/3: a stroke that runs through the bar's area is recorded; the bar steps aside to the edge away from the finger
  const natural = await overlapsTile(p);
  console.log("INFO " + tag + " default bar position overlaps the picture by " + Math.round(natural) + " px (" + (natural >= 30 ? "natural case" : "bar placed over the picture with the grip") + ")");
  let r1 = await nearStroke(p, "low", natural >= 30);
  ok(tag + " 2 freehand through the bar's spot is recorded (draft polygon with points)", !!r1.ds.draft && r1.ds.draft.shape === "poly" && r1.ds.draft.pts.length >= 8 && !r1.ds.drawing, r1.ds);
  ok(tag + " 3 the bar moved to the edge away from the finger (" + r1.expect + ")", !r1.after.free && r1.after.edge === r1.expect && r1.moved, r1);
  ok(tag + " 3 the bar is not under the finger afterwards, still one row, inside the screen", !r1.under && r1.after.l >= 0 && r1.after.r <= r1.after.vw && r1.after.h < 60, r1);
  if (SHOTS) await p.screenshot({ path: SHOTS + "/bar-moved-" + tag.replace(/\W+/g, "-") + ".png" });
  await W(300);
  ok(tag + " 3 it stays where it moved (no flip back on its own)", (await barInfo(p)).edge === r1.expect);
  await cancelDraw(p);

  // the other direction: bar over the TOP of the picture
  await resetBar(p); await startDraw(p, "rect");
  let r2 = await nearStroke(p, "high", false, "rect");
  ok(tag + " 3 a stroke near a bar over the top of the picture moves it to the far edge (" + r2.expect + ")", !r2.after.free && r2.after.edge === r2.expect && r2.moved && !r2.under, r2);
  ok(tag + " 2 box recorded too", !!r2.ds.draft && r2.ds.draft.shape === "rect" && r2.ds.draft.w > 0, r2.ds);
  await cancelDraw(p);

  // a box that STARTS on the bar's click-through frame (its border, between the grip and buttons) is recorded, and the bar steps aside
  await resetBar(p); await startDraw(p, "rect");
  await placeBar(p, "low");
  const tG = await tileRect(p);
  const gap = await p.evaluate(() => { const b = document.getElementById("crBar"), r = b.getBoundingClientRect(); for (let x = r.left + 3; x < r.right - 3; x++) { const y = r.top + 1.5, e = document.elementFromPoint(x, y); if (e && !b.contains(e) && e.classList.contains("cr-overlay")) return { x, y }; } return null; });
  ok(tag + " 2 the bar's frame is click-through down to the picture", !!gap);
  if (gap) {
    await drawMouse(p, [[gap.x, gap.y], [gap.x + 60, Math.max(tG.t + 5, gap.y - 120)]]);
    const d2 = await drawState(p);
    ok(tag + " 2 a box started on the bar's frame is recorded", !!d2.draft && d2.draft.shape === "rect" && d2.draft.w > 0 && d2.draft.h > 0, d2);
  }
  await cancelDraw(p);
  await resetBar(p);

  // --- 4: grip drag
  await resetBar(p); await startDraw(p, "rect");
  bi = await barInfo(p);
  const g = await p.evaluate(() => { const r = document.getElementById("crBarGrip").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const toY = Math.round(bi.vh * 0.35);
  await p.mouse.move(g.x, g.y); await p.mouse.down(); await p.mouse.move(g.x + 30, (g.y + toY) / 2, { steps: 5 }); await p.mouse.move(g.x + 30, toY, { steps: 5 }); await p.mouse.up(); await W(300);
  const bi4 = await barInfo(p);
  ok(tag + " 4 grip drag moves the bar to the new spot (free mode)", bi4.free && Math.abs(bi4.t + bi4.h / 2 - toY) < 24 && bi4.l > bi.l - 1, { bi, bi4, toY });
  if (SHOTS) await p.screenshot({ path: SHOTS + "/bar-dragged-" + tag.replace(/\W+/g, "-") + ".png" });
  // dragging off-screen is clamped
  const g2 = await p.evaluate(() => { const r = document.getElementById("crBarGrip").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await p.mouse.move(g2.x, g2.y); await p.mouse.down(); await p.mouse.move(-60, -60, { steps: 6 }); await p.mouse.up(); await W(250);
  let bi5 = await barInfo(p);
  ok(tag + " 4 dragged off-screen: the bar stays fully inside the viewport", bi5.l >= 0 && bi5.t >= 0 && bi5.r <= bi5.vw && bi5.b <= bi5.vh, bi5);
  await p.mouse.move(await p.evaluate(() => { const r = document.getElementById("crBarGrip").getBoundingClientRect(); return r.left + r.width / 2; }), await p.evaluate(() => { const r = document.getElementById("crBarGrip").getBoundingClientRect(); return r.top + r.height / 2; }));
  await p.mouse.down(); await p.mouse.move(bi.vw + 100, bi.vh + 100, { steps: 8 }); await p.mouse.up(); await W(250);
  bi5 = await barInfo(p);
  ok(tag + " 4 dragged past the bottom-right corner: still inside the viewport", bi5.l >= 0 && bi5.t >= 0 && bi5.r <= bi5.vw + 0.5 && bi5.b <= bi5.vh + 0.5, bi5);
  // remembered for the session: cancel, draw again -> same position
  const before = bi5;
  await cancelDraw(p); ok(tag + " 4 bar hidden after Cancel", !(await vis(p, "#crBar")));
  await startDraw(p, "rect");
  const aft = await barInfo(p);
  ok(tag + " 4 position remembered for the session (same spot when drawing again)", Math.abs(aft.l - before.l) < 2 && Math.abs(aft.t - before.t) < 2 && aft.free, { before, aft });
  ok(tag + " 4 stored in sessionStorage only (nothing in localStorage)", await p.evaluate(() => !!sessionStorage.getItem("dcs.crBarPos.v1") && !Object.keys(localStorage).some((k) => /crBarPos/.test(k))));
  // a free bar is also avoided: stroke near it moves it to an edge
  const rF = await barInfo(p);
  const trf = await tileRect(p);
  const midF = Math.round((rF.t + rF.b) / 2);
  if (midF > trf.t + 8 && midF < trf.b - 8) {
    await drawMouse(p, [[Math.round((rF.l + rF.r) / 2), rF.b + 18], [Math.round((rF.l + rF.r) / 2) + 20, rF.b + 40]]);
    const rF2 = await barInfo(p);
    ok(tag + " 3 a dragged (free) bar also steps aside to an edge when you draw near it", !rF2.free && (rF2.edge === "top" || rF2.edge === "bottom") && (rF2.b < rF.t || rF2.t > rF.b), { rF, rF2 });
  }
  await cancelDraw(p);

  // --- 5: buttons
  await resetBar(p); await startDraw(p, "rect");
  const t2 = await tileRect(p), cx = Math.round((t2.l + t2.r) / 2);
  const n0 = await p.evaluate(() => TDC.regions.list.length);
  await p.evaluate(() => { window.__ev = []; for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) document.addEventListener(t, (e) => window.__ev.push(t + ":" + e.target.tagName + ":" + Math.round(e.clientX) + "," + Math.round(e.clientY)), true); });
  await drawMouse(p, [[cx - 60, t2.t + 110], [cx + 60, t2.t + 190]]);
  ok(tag + " 5 draft exists, Save region enabled", await p.evaluate(() => !document.getElementById("crBarSave").disabled), { ev: await p.evaluate(() => window.__ev.slice(0, 8)), msg: await p.evaluate(() => document.getElementById("crBarMsg").textContent), live: await p.evaluate(() => !!TDC.regions.ui.live), st: await drawState(p), t2, cx, el: await p.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e && (e.tagName + "." + e.className + "#" + e.id); }, [cx, t2.t + 80]), bar: await barInfo(p) });
  await p.click("#crBarAgain"); await W(300);
  ok(tag + " 5 Draw again works (drawing, draft cleared)", await p.evaluate(() => TDC.regions.ui.drawing && !TDC.regions.ui.draft));
  await drawMouse(p, [[cx - 60, t2.t + 110], [cx + 60, t2.t + 190]]);
  await p.click("#crBarSave"); await W(300);
  ok(tag + " 5 Save region adds exactly one region", (await p.evaluate(() => TDC.regions.list.length)) === n0 + 1 && !(await vis(p, "#crBar")));
  await startDraw(p, "rect"); await p.click("#crBarCancel"); await W(250);
  ok(tag + " 5 Cancel works", !(await vis(p, "#crBar")) && !(await p.evaluate(() => TDC.regions.ui.drawing)));
  // Options toggle (panel steps aside on narrow screens only)
  await startDraw(p, "rect");
  const narrow = await p.evaluate(() => TDC.searchUI.narrow());
  if (narrow) {
    await p.click("#crBarOpts"); await W(400);
    ok(tag + " 5 Options opens the panel, label Back to drawing, still one row inside the width", (await vis(p, "#usPanel")) && (await p.evaluate(() => document.getElementById("crBarOpts").textContent)) === "Back to drawing");
    const wi = await barInfo(p); ok(tag + " 5 'Back to drawing' label: one row, inside the width", Math.max(...wi.btns.map((x) => x.b)) - Math.min(...wi.btns.map((x) => x.t)) < 48 && wi.l >= 0 && wi.r <= wi.vw, wi);
    await p.click("#crBarOpts"); await W(400);
    ok(tag + " 5 Options toggles back (panel tucked away)", !(await vis(p, "#usPanel")));
  }
  await cancelDraw(p);
  // worst-case labels: editing -> "Save changes" with a draft + Draw again + Cancel + Back to drawing
  await p.evaluate(() => { const r = TDC.regions.list[0]; TDC.regions.UI.edit(r.id); }); await W(300);
  if (narrow) { await p.evaluate(() => TDC.regions.UI.draw()); await W(300); await p.evaluate(() => { TDC.regions.ui.drawing = false; TDC.regions.ui.draft = TDC.regions.ui.draft || { shape: "rect", x: 0.2, y: 0.2, w: 0.2, h: 0.2 }; TDC.regions.UI.sync(); }); await p.evaluate(() => { const o = document.getElementById("crBarOpts"); o.click(); }); await W(400); }
  const wc = await barInfo(p);
  ok(tag + " 5 worst case ('Save changes' + 'Back to drawing'): one row, inside the width", !wc.hidden && Math.max(...wc.btns.map((x) => x.b)) - Math.min(...wc.btns.map((x) => x.t)) < 48 && wc.l >= 0 && wc.r <= wc.vw, wc);
  if (SHOTS) await p.screenshot({ path: SHOTS + "/bar-worst-" + tag.replace(/\W+/g, "-") + ".png" });
  await cancelDraw(p);
  ok(tag + " 5 no page errors", errs.filter((e) => !/arcTo|allowed range/.test(e)).length === 0, errs);
  await ctx.close();
}

// real touch on Chromium (CDP): a finger stroke over the bar's old spot is recorded and the bar moves
async function touchRun(b, dev, tag) {
  const ctx = await b.newContext(dev.ctx); const p = await ctx.newPage();
  await openEvent(p);
  await p.click("#usBtn"); await W(400);
  await p.evaluate(() => { document.getElementById("crSec").open = true; }); await W(200);
  await startDraw(p, "free");
  const cdp = await ctx.newCDPSession(p);
  if ((await overlapsTile(p)) < 30) await placeBar(p, "low");
  const bi = await barInfo(p), tr = await tileRect(p);
  const cx = Math.round((bi.l + bi.r) / 2), ym = Math.round((bi.t + bi.b) / 2), cl = (y) => Math.min(tr.b - 5, Math.max(tr.t + 5, y));
  const tp = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1, radiusX: 12, radiusY: 12 }] });
  const pts = [[cx - 90, cl(ym - 70)], [cx - 100, cl(ym - 40)], [cx - 100, cl(ym)], [cx, cl(ym + 6)], [cx + 100, cl(ym)], [cx + 100, cl(ym - 50)], [cx + 60, cl(ym - 70)]];
  await tp("touchStart", pts[0][0], pts[0][1]);
  for (const q of pts.slice(1)) { await tp("touchMove", q[0], q[1]); await W(40); }
  await tp("touchEnd"); await W(250);
  const ds = await drawState(p), b2 = await barInfo(p), expect = pts[6][1] > b2.vh / 2 ? "top" : "bottom";
  ok(tag + " T1 real finger stroke through the bar's spot is recorded", !!ds.draft && ds.draft.shape === "poly" && ds.draft.pts.length >= 8, ds);
  ok(tag + " T1 and the bar moved to the edge away from the finger (" + expect + ")", b2.edge === expect && !b2.free, { b2, expect });
  // tap on a button works with touch
  await p.touchscreen.tap(b2.btns.find((x) => x.id === "crBarCancel").l + 10, b2.btns.find((x) => x.id === "crBarCancel").t + 10); await W(300);
  ok(tag + " T2 tapping Cancel with a finger works", !(await vis(p, "#crBar")));
  // finger drag on the grip
  await startDraw(p, "rect"); const g = await p.evaluate(() => { const r = document.getElementById("crBarGrip").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const b3 = await barInfo(p);
  await tp("touchStart", g.x, g.y); for (let i = 1; i <= 6; i++) { await tp("touchMove", g.x + 20, g.y - i * 60); await W(30); } await tp("touchEnd"); await W(300);
  const b4 = await barInfo(p);
  ok(tag + " T3 finger drag on the grip moves the bar (and the page did not scroll)", b4.free && b4.t < b3.t - 150 && (await p.evaluate(() => scrollY === 0)), { b3, b4 });
  await ctx.close();
}

(async () => {
  if (!fs.existsSync(FIX + "/TeslaCam")) execFileSync("python3", [path.join(ROOT, "tools/make-mock-footage.py"), FIX], { stdio: "inherit" });
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await server(); const pw = require("playwright");
  const DEVS = [
    { name: "desktop", ctx: { viewport: { width: 1280, height: 800 } } },
    { name: "phone", ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: UA, deviceScaleFactor: 2 } },
    { name: "landscape", ctx: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, userAgent: UA, deviceScaleFactor: 2 } },
  ].filter((d) => !process.env.DEV || d.name === process.env.DEV);
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    let b;
    try { b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] }); }
    catch (e) { console.log("SKIP " + BR + ": cannot launch (" + e.message.split("\n")[0] + ")"); continue; }
    for (const dev of DEVS) {
      const tag = BR + " " + dev.name;
      try { await run(b, dev, tag); } catch (e) { ok(tag + " run threw: " + e.message.split("\n")[0], false); }
      if (BR === "chromium" && dev.name === "phone") { try { await touchRun(b, dev, tag); } catch (e) { ok(tag + " touchRun threw: " + e.message.split("\n")[0], false); } }
    }
    await b.close();
  }
  srv.close(); console.log(fails ? "FAILED " + fails : "ALL PASSED"); process.exit(fails ? 1 : 0);
})();
