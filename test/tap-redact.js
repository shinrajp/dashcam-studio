// tap-redact (tag tap-redact): custom redaction has NO camera dropdown any more. "Draw region" asks you to tap the camera (grid / 6-up), a tap
// enlarges it and arms the drag, a drag that starts on a camera draws right there, one camera on screen = no question, a chip in the draw bar names
// the camera and re-picks.   Playwright, Chromium (system Chrome) and WebKit (BR=chromium|webkit), phone 390x844 (real touch) + desktop 1280x800.
// Mock footage only (tools/make-mock-footage.py -> /tmp/ho-mock). Serves the repo on PORT (8803).
//   A. the dropdown is gone (no #crCam, no <select> in Custom regions or the draw bar); hint text in the panel
//   B. grid: Draw region -> pick mode: hint "Tap the camera you want to redact", one real <button> per camera, panel steps aside, Cancel only, panels let the tap through
//   C. tap a camera (mouse click / finger) -> that camera is enlarged, chip names it, drag draws on it; saved region has that cam, raw coordinates (mirror undone), list names it
//   D. a drag that starts on a camera of the grid draws right there (no enlarge); the other tile can be tapped to switch
//   E. one camera on screen (focused / only one shown): no pick, the shown camera is the camera
//   F. chip: tap it -> back to the grid in pick mode, pick another camera; Draw again keeps the camera
//   G. keyboard: Tab between the camera buttons, Enter picks, Escape cancels (and the panel returns); Cancel button; camera bar / number key while picking picks that camera
//   H. storage format and export burn-in: saved region keys unchanged, G.at / burn use it; no page errors
// Usage: BR=chromium|webkit node test/tap-redact.js    DEV=desktop|phone   SHOTS=dir writes mock-data screenshots
const fs = require("fs"), path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", PORT = +(process.env.PORT || 8803), SHOTS = process.env.SHOTS || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".onnx": "application/octet-stream", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html"; fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; return r.end(); } r.setHeader("Content-Type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }); s.listen(PORT, "127.0.0.1", () => res(s)); });
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const BASE = `http://127.0.0.1:${PORT}/index.html?nosw=1`;

async function openEvent(p, n) {
  await p.goto(BASE, { waitUntil: "load" });
  await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.prefs.v1"); localStorage.removeItem("tdc.regions.v1"); localStorage.removeItem("tdc.searchPanel.v1"); sessionStorage.clear(); });
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate((n) => { TDC.ui.activate(TDC.library.events.find((e) => e.cams.length === n) || TDC.library.events[0]); }, n || 6); await W(1500);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); });
}
const vis = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return !e.hidden && getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden" && r.width > 0 && r.height > 0; }, sel);
const rectOf = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }, sel);
const st = (p) => p.evaluate(() => { const S = TDC.regions.ui, b = document.getElementById("crBar"), chip = document.getElementById("crBarCam"); return { pick: S.pick, drawing: S.drawing, cam: S.cam, focus: TDC.focus.cam, draft: !!S.draft, bar: !!b && !b.hidden, msg: (document.getElementById("crBarMsg") || {}).textContent, chip: chip && !chip.hidden ? chip.textContent : null, picks: document.querySelectorAll(".cr-pick").length, panel: !document.getElementById("usPanel").hidden && TDC.searchUI.open }; });
const tileC = (p, cam) => rectOf(p, ".tile[data-cam=" + cam + "]");
// true box of a raw 0..1 rectangle on screen, from the <video> element itself (independent of custom-redact.js); mirrored from the tile class
const screenBox = (p, cam, b) => p.evaluate(([cam, b]) => { const t = TDC.player.tiles[cam], v = t.vids[TDC.player.active], vr = v.getBoundingClientRect(), s = Math.min(vr.width / v.videoWidth, vr.height / v.videoHeight), w = v.videoWidth * s, h = v.videoHeight * s, x0 = vr.left + (vr.width - w) / 2, y0 = vr.top + (vr.height - h) / 2, m = t.tile.classList.contains("mirrored"); const xa = m ? 1 - (b.x + b.w) : b.x; return { x: x0 + xa * w, y: y0 + b.y * h, w: b.w * w, h: b.h * h, mirrored: m }; }, [cam, b]);
// a raw box of size w x h on this camera whose whole path is over the drawing canvas (not under the camera bar's buttons, which stay clickable while drawing)
const freeBox = async (p, cam, w, h) => {
  for (const y of [0.5, 0.62, 0.3, 0.42, 0.15, 0.7]) for (const x of [0.1, 0.4, 0.25, 0.5]) {
    const raw = { x, y, w, h }, sb = await screenBox(p, cam, raw);
    const okp = await p.evaluate(([sb]) => [[0, 0], [1, 1], [0.5, 0.5], [0.25, 0.25], [0.75, 0.75], [1, 0], [0, 1]].every(([fx, fy]) => { const e = document.elementFromPoint(sb.x + sb.w * fx, sb.y + sb.h * fy); return !!e && e.classList.contains("cr-overlay"); }), [sb]);
    if (okp) return { raw, sb };
  }
  const raw = { x: 0.2, y: 0.5, w, h }; return { raw, sb: await screenBox(p, cam, raw) };
};
const freePt = (p, cam) => p.evaluate((cam) => { const r = document.querySelector(".tile[data-cam=" + cam + "]").getBoundingClientRect(); for (const [fx, fy] of [[.5, .5], [.3, .7], [.7, .7], [.3, .3], [.7, .3], [.5, .85]]) { const x = r.left + r.width * fx, y = r.top + r.height * fy, e = document.elementFromPoint(x, y); if (e && e.classList.contains("cr-overlay")) return { cx: x, cy: y }; } return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }, cam);
const iou = (r, b) => { const x1 = Math.max(r.x, b.x), y1 = Math.max(r.y, b.y), x2 = Math.min(r.x + r.w, b.x + b.w), y2 = Math.min(r.y + r.h, b.y + b.h), i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (r.w * r.h + b.w * b.h - i); };

async function run(b, dev, tag) {
  const ctx = await b.newContext(dev.ctx); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  const touch = !!dev.ctx.hasTouch, phone = touch, cdp = touch && /chromium/.test(tag) ? await ctx.newCDPSession(p) : null;
  const shot = async (n) => { if (SHOTS) { await W(300); await p.screenshot({ path: SHOTS + "/" + n + "-" + tag.replace(/\W+/g, "-") + ".png" }); } };
  await openEvent(p, 6);
  // pointer helpers: mouse on the desktop, a real finger on the phone (CDP on Chromium; synthetic touch pointer events on the WebKit harness)
  const tap = async (x, y) => { if (touch) await p.touchscreen.tap(x, y); else { await p.mouse.move(x, y); await p.mouse.click(x, y); } await W(450); };
  const drag = async (pts) => {
    if (!touch) { await p.mouse.move(pts[0][0], pts[0][1]); await p.mouse.down(); for (const q of pts.slice(1)) { await p.mouse.move(q[0], q[1], { steps: 4 }); await W(20); } await p.mouse.up(); }
    else if (cdp) { const tp = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1, radiusX: 8, radiusY: 8 }] }); await tp("touchStart", pts[0][0], pts[0][1]); for (const q of pts.slice(1)) { await tp("touchMove", q[0], q[1]); await W(25); } await tp("touchEnd"); }
    else {
      const ev = (type, x, y) => p.evaluate(([type, x, y]) => { const e = document.elementFromPoint(x, y), cv = e && e.classList.contains("cr-overlay") ? e : null; if (!cv) return "no canvas at " + x + "," + y; cv.dispatchEvent(new PointerEvent(type, { pointerId: 21, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1 })); return "ok"; }, [type, x, y]);
      await ev("pointerdown", pts[0][0], pts[0][1]); for (const q of pts.slice(1)) await ev("pointermove", q[0], q[1]); await ev("pointerup", pts[pts.length - 1][0], pts[pts.length - 1][1]);
    }
    await W(250);
  };
  const boxDrag = async (bx) => { if (process.env.DBG) await p.evaluate(() => { window.__l = []; for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) document.addEventListener(t, (e) => window.__l.push(t + ":" + e.pointerType + ":" + (e.target.className || e.target.id)), true); }); await boxDrag0(bx); if (process.env.DBG) console.log("DBG", JSON.stringify(await p.evaluate(() => window.__l.slice(0, 12)))); };
  const boxDrag0 = (bx) => drag([[bx.x, bx.y], ...[1, 2, 3, 4, 5, 6].map((k) => [bx.x + (bx.w * k) / 6, bx.y + (bx.h * k) / 6])]);
  const lastRegion = () => p.evaluate(() => { const l = TDC.regions.list; return JSON.parse(JSON.stringify(l[l.length - 1] || null)); });
  const grid = async () => { await p.evaluate(() => { TDC.focus.grid(); }); await W(400); };
  const startDraw = async () => { if (!(await p.evaluate(() => TDC.searchUI.open))) await p.evaluate(() => TDC.searchUI.show(false, "redact")); await W(250); if (touch && !(await vis(p, "#crDraw"))) await p.evaluate(() => TDC.searchUI.show(false, "redact")); await W(150); const r = await rectOf(p, "#crDraw"); if (touch) await p.touchscreen.tap(r.cx, r.cy); else await p.mouse.click(r.cx, r.cy); await W(450); };
  const cancel = async () => { await p.evaluate(() => TDC.regions.UI.cancel()); await W(300); };

  // ── A. no dropdown ──
  await p.evaluate(() => { TDC.layout.set("current"); TDC.focus.grid(); }); await W(300);
  await p.evaluate(() => TDC.searchUI.show(false, "redact")); await W(400);
  ok(tag + " A1 no camera dropdown: no #crCam anywhere, no <select> in Custom regions or the draw bar", await p.evaluate(() => !document.getElementById("crCam") && !document.querySelector("#crSec select") && !document.querySelector("#crBar select") && !document.querySelector("#crSec option")));
  ok(tag + " A2 the panel text tells the new way (tap the camera), the old 'Pick a camera' wording is gone", await p.evaluate(() => { const t = document.querySelector("#crSec .cr-hint").textContent; return /tap the camera/i.test(t) && !/pick a camera/i.test(t); }));
  ok(tag + " A3 Draw region is the first action of the Redact tab and enabled", (await vis(p, "#crDraw")) && (await p.evaluate(() => !document.getElementById("crDraw").disabled && /Draw region/.test(document.getElementById("crDraw").textContent))));
  ok(tag + " A4 six cameras in the grid", (await p.evaluate(() => TDC.GRID.filter((c) => !TDC.player.tiles[c].tile.classList.contains("off") && TDC.player.ev.cams.includes(c)).length)) === 6);

  // ── B. pick mode ──
  await startDraw(); await W(300);
  let s = await st(p);
  ok(tag + " B1 Draw region in the grid: pick mode, not drawing yet, no camera chosen", s.pick === true && s.drawing === false && s.cam === null && s.focus === null, s);
  ok(tag + " B2 hint 'Tap the camera you want to redact' is on screen", s.bar && /Tap the camera you want to redact/.test(s.msg) && (await vis(p, "#crBarMsg")), s);
  ok(tag + " B3 one real <button> per camera, inside its tile, labelled with the camera name", s.picks === 6 && await p.evaluate(() => TDC.GRID.every((c) => { const b = document.querySelector(".tile[data-cam=" + c + "] > button.cr-pick"); return !!b && b.tagName === "BUTTON" && b.textContent.includes(TDC.CAM_LABEL[c]) && /Redact the/.test(b.getAttribute("aria-label")) && b.getBoundingClientRect().width > 40; })), s);
  ok(tag + " B4 the panel stepped aside; the bar shows Cancel (no Save / Draw again / chip)", !s.panel && await p.evaluate(() => { const v = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && e.offsetParent !== null; }; return v("crBarCancel") && !v("crBarSave") && !v("crBarAgain") && !v("crBarCam"); }), s);
  ok(tag + " B5 the camera bar's Draw button label says 'Tap a camera'", await p.evaluate(() => /Tap a camera/.test(document.getElementById("crDraw").textContent)));
  ok(tag + " B6 every tile centre and corner (HUD / map / car panels included) hands the tap to that tile's own pick canvas", await p.evaluate(() => {
    const bad = []; for (const c of TDC.GRID) { const t = document.querySelector(".tile[data-cam=" + c + "]"), r = t.getBoundingClientRect(); for (const [fx, fy] of [[.5, .5], [.1, .1], [.9, .1], [.1, .9], [.9, .9]]) { const e = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy); if (!e || !e.classList.contains("cr-overlay") || e.parentNode !== t) bad.push(c + "@" + fx + "," + fy + ":" + (e && (e.id || e.className))); } }
    const fps = [...document.querySelectorAll(".float-panel")].filter((e) => e.offsetParent !== null).map((e) => { const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y); return hit && hit.closest && !!hit.closest(".float-panel"); });
    window.__fpHit = { bad, fps }; return bad.length === 0 && fps.every((h) => !h); }), await p.evaluate(() => window.__fpHit));
  ok(tag + " B7 the tile's own expand button is out of the way while picking", await p.evaluate(() => [...document.querySelectorAll(".tile-expand")].every((e) => getComputedStyle(e).display === "none")));
  await shot("pick-mode-6up");

  // ── C. tap right pillar -> enlarged + drawing; layout 'current' ──
  const rp = await tileC(p, "right_pillar");
  await tap(rp.cx, rp.cy);
  s = await st(p);
  ok(tag + " C1 tapping the right pillar picks it: enlarged, drawing armed, no pick layer left", s.cam === "right_pillar" && s.focus === "right_pillar" && s.drawing === true && s.pick === false && s.picks === 0, s);
  ok(tag + " C2 the chip names the camera (no dropdown)", s.chip === "Right Pillar" && s.bar && !s.panel, s);
  ok(tag + " C3 message tells what to do on the chosen camera", /Right Pillar/.test(s.msg) && /drag/i.test(s.msg), s);
  await shot("drawing-after-tap");
  const { raw: want1, sb: sb1 } = await freeBox(p, "right_pillar", 0.4, 0.25);
  await boxDrag(sb1); await W(250);
  s = await st(p);
  ok(tag + " C4 the drag drew a box (draft, Save region enabled)", s.draft && !s.drawing && await p.evaluate(() => !document.getElementById("crBarSave").disabled), { s, sb1, tile: await tileC(p, "right_pillar"), vp: await p.evaluate(() => [innerWidth, innerHeight]), bar: await rectOf(p, "#crBar"), top: await p.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e && (e.id || e.className); }, [sb1.x + 5, sb1.y + 5]) });
  await p.click("#crBarSave") .catch(async () => { await p.evaluate(() => TDC.regions.UI.save()); }); await W(400);
  let r1 = await lastRegion();
  ok(tag + " C5 saved region is on the right pillar with raw-frame coordinates (IoU > 0.85 with the box that was dragged; mirrored=" + sb1.mirrored + ")", r1 && r1.cam === "right_pillar" && r1.shape === "rect" && iou(r1, want1) > 0.85, { r1, want1 });
  ok(tag + " C6 storage format unchanged (id, cam, shape, x, y, w, h, mode, start, end, on, v)", r1 && ["id", "cam", "shape", "x", "y", "w", "h", "mode", "start", "end", "on", "v"].every((k) => k in r1) && r1.mode === "blur" && r1.start === null && r1.end === null && r1.on === true && r1.v === 1, r1);
  ok(tag + " C7 after Save the panel is back with the region listed by camera name; state reset", await p.evaluate(() => { const li = document.querySelector("#crList li"); return !!li && /Right Pillar/.test(li.textContent) && TDC.searchUI.open && TDC.regions.ui.cam === null && !TDC.regions.ui.pick; }));
  await shot("region-list-after-tap");
  ok(tag + " C8 the burn-in sees it (G.at for that camera at t = 0)", await p.evaluate(() => TDC.regions.at("right_pillar", 0).length === 1 && TDC.regions.at("front", 0).length === 0));

  // ── mirrored camera: 'mirror' layout, tap the rear camera ──
  await p.evaluate(() => { TDC.regions.clear(); TDC.layout.set("mirror"); TDC.focus.grid(); }); await W(500);
  await startDraw(); await W(300);
  const bk = await tileC(p, "back"); await tap(bk.cx, bk.cy);
  s = await st(p);
  const { raw: want2, sb: sb2 } = await freeBox(p, "back", 0.3, 0.2);
  ok(tag + " C9 mirror layout: rear camera picked and enlarged (tile mirrored=" + sb2.mirrored + ")", s.cam === "back" && s.focus === "back" && s.drawing, s);
  await boxDrag(sb2); await p.evaluate(() => TDC.regions.UI.save()); await W(300);
  const r2 = await lastRegion();
  ok(tag + " C10 mirrored camera: coordinates are the RAW frame (mirror undone), IoU > 0.85", r2 && r2.cam === "back" && iou(r2, want2) > 0.85 && sb2.mirrored, { r2, want2, m: sb2.mirrored });

  // ── D. drag from the grid ──
  await p.evaluate(() => { TDC.regions.clear(); TDC.layout.set("current"); TDC.focus.grid(); }); await W(500);
  await startDraw(); await W(300);
  const { raw: want3, sb: sb3 } = await freeBox(p, "left_repeater", 0.5, 0.3);
  await boxDrag(sb3); await W(200);
  s = await st(p);
  ok(tag + " D1 a drag that starts on a tile of the grid picks it and draws in place (grid stays, no pick layer, draft)", s.cam === "left_repeater" && s.focus === null && s.draft && s.picks === 0 && !s.pick, s);
  ok(tag + " D2 chip shows the camera", s.chip === "Left Repeater", s);
  await p.evaluate(() => TDC.regions.UI.save()); await W(300);
  const r3 = await lastRegion();
  ok(tag + " D3 saved on that camera, coordinates right (IoU > 0.8: the small grid tile)", r3 && r3.cam === "left_repeater" && iou(r3, want3) > 0.8, { r3, want3 });
  // armed in the grid: tapping another tile switches camera
  await p.evaluate(() => TDC.regions.clear()); await startDraw(); await W(200);
  const { sb: sb4 } = await freeBox(p, "front", 0.3, 0.3); await boxDrag(sb4);
  s = await st(p);
  ok(tag + " D4 (setup) drew on the front camera in the grid", s.cam === "front" && s.draft && s.focus === null, s);
  await p.evaluate(() => TDC.regions.UI.draw()); await W(300);   // Draw again keeps the camera
  s = await st(p);
  ok(tag + " D5 Draw again keeps the camera: no new pick, drawing armed on the front camera", s.cam === "front" && s.drawing && !s.pick && s.picks === 0, s);
  const sc = await freePt(p, "back"); await tap(sc.cx, sc.cy);
  s = await st(p);
  ok(tag + " D6 armed in the grid, a tap on another tile makes that tile the camera (enlarged)", s.cam === "back" && s.focus === "back" && s.drawing, s);
  await cancel();

  // ── E. one camera on screen ──
  await p.evaluate(() => { TDC.focus.focus("front"); }); await W(400);
  await startDraw(); await W(300);
  s = await st(p);
  ok(tag + " E1 one camera shown: no pick, drawing armed on that camera at once (no question)", s.cam === "front" && s.drawing && !s.pick && s.picks === 0 && /Front/.test(s.chip || ""), s);
  await cancel();
  ok(tag + " E2 Cancel leaves nothing behind (bar gone, panel back, no pick layer)", await p.evaluate(() => { const S = TDC.regions.ui; return !S.drawing && !S.pick && !S.draft && S.cam === null && document.getElementById("crBar").hidden && TDC.searchUI.open && !document.querySelector(".cr-pick") && !document.body.classList.contains("cr-drawing"); }));
  await grid();
  const only = await p.evaluate(() => { try { const h = {}; for (const c of TDC.GRID) if (c !== "left_pillar") h[c] = true; TDC.setPref("camsHidden", h); TDC.focus.grid(); return true; } catch (e) { return String(e); } }); await W(500);
  const vis1 = await p.evaluate(() => TDC.GRID.filter((c) => !TDC.player.tiles[c].tile.classList.contains("off") && TDC.player.ev.cams.includes(c)));
  if (vis1.length === 1) {
    await startDraw(); await W(300); s = await st(p);
    ok(tag + " E3 grid with only one camera visible: that camera, no pick", s.cam === vis1[0] && s.drawing && !s.pick, s);
    await cancel();
  } else console.log("INFO " + tag + " E3 skipped: could not hide cameras (" + only + ", " + vis1.length + " visible)");
  await p.evaluate(() => { TDC.setPref("camsHidden", {}); TDC.focus.grid(); }); await W(500);

  // ── F. chip re-pick ──
  await p.evaluate(() => TDC.focus.grid()); await W(300);
  await startDraw(); await W(300);
  const rp2 = await tileC(p, "right_pillar"); await tap(rp2.cx, rp2.cy);
  s = await st(p);
  ok(tag + " F0 (setup) right pillar picked", s.cam === "right_pillar" && s.drawing, s);
  const chip = await rectOf(p, "#crBarCam");
  ok(tag + " F1 the chip is a real, big-enough tap target", !!chip && chip.h >= (touch ? 36 : 28) && chip.w >= 40, chip);
  await tap(chip.cx, chip.cy);
  s = await st(p);
  ok(tag + " F2 tapping the chip goes back to all cameras in pick mode (no dropdown)", s.pick && s.cam === null && s.focus === null && s.picks === 6 && !s.chip, s);
  const lp = await tileC(p, "left_pillar"); await tap(lp.cx, lp.cy);
  s = await st(p);
  ok(tag + " F3 pick another camera: the chip changes", s.cam === "left_pillar" && s.chip === "Left Pillar" && s.drawing, s);
  await cancel();

  // ── G. keyboard + other ways to show one camera ──
  await p.evaluate(() => TDC.focus.grid()); await W(300);
  await p.evaluate(() => TDC.searchUI.show(false, "redact")); await W(300);
  await p.focus("#crDraw"); await p.keyboard.press("Enter"); await W(500);
  s = await st(p);
  ok(tag + " G1 Draw region by keyboard (Enter) enters pick mode and moves the focus to a camera button", s.pick && await p.evaluate(() => document.activeElement && document.activeElement.classList.contains("cr-pick")), s);
  const f0 = await p.evaluate(() => document.activeElement.dataset.cam);
  await p.keyboard.press("Tab"); await W(150);
  const f1 = await p.evaluate(() => document.activeElement && document.activeElement.classList.contains("cr-pick") && document.activeElement.dataset.cam);
  ok(tag + " G2 Tab moves between the camera buttons", !!f1 && f1 !== f0, { f0, f1 });
  await shot("keyboard-focus");
  await p.keyboard.press("Enter"); await W(500);
  s = await st(p);
  ok(tag + " G3 Enter on a camera button picks it (enlarged, drawing)", s.cam === f1 && s.focus === f1 && s.drawing && !s.pick, { s, f1 });
  await p.keyboard.press("Escape"); await W(400);
  ok(tag + " G4 Escape cancels drawing and brings the panel back", await p.evaluate(() => !TDC.regions.ui.drawing && TDC.searchUI.open));
  await p.evaluate(() => TDC.focus.grid()); await W(300);
  await p.evaluate(() => TDC.regions.UI.draw()); await W(400);
  await p.keyboard.press("Escape"); await W(400);
  ok(tag + " G5 Escape in pick mode leaves it (no pick layer, panel back)", await p.evaluate(() => !TDC.regions.ui.pick && !document.querySelector(".cr-pick") && TDC.searchUI.open && document.getElementById("crBar").hidden));
  await p.evaluate(() => TDC.regions.UI.draw()); await W(400);
  const cb = await rectOf(p, "#crBarCancel"); await tap(cb.cx, cb.cy);
  ok(tag + " G6 the bar's Cancel button leaves pick mode", await p.evaluate(() => !TDC.regions.ui.pick && !document.querySelector(".cr-pick") && TDC.searchUI.open));
  await p.evaluate(() => TDC.focus.grid()); await W(300);
  await p.evaluate(() => TDC.regions.UI.draw()); await W(400);
  await p.evaluate(() => TDC.focus.byNumber(2)); await W(500);
  s = await st(p);
  ok(tag + " G7 while picking, showing one camera by another way (number key / camera bar) picks that camera", s.cam === "back" && s.drawing && !s.pick && s.picks === 0, s);
  await cancel();
  // touch pick must not scroll or move the playhead
  const t0 = await p.evaluate(() => [TDC.player.time, scrollX, scrollY]);
  await p.evaluate(() => TDC.focus.grid()); await W(300); await p.evaluate(() => TDC.regions.UI.draw()); await W(300);
  const fr = await tileC(p, "front"); await tap(fr.cx, fr.cy);
  const t1 = await p.evaluate(() => [TDC.player.time, scrollX, scrollY]);
  ok(tag + " G8 picking does not scroll the page or move the playhead", JSON.stringify(t0) === JSON.stringify(t1), { t0, t1 });
  await cancel();

  // ── H. edit existing region keeps its camera, no pick ──
  await p.evaluate(() => { TDC.focus.grid(); TDC.regions.clear(); TDC.regions.add({ cam: "right_repeater", shape: "rect", mode: "blur", x: 0.3, y: 0.3, w: 0.2, h: 0.2 }); }); await W(400);
  await p.evaluate(() => TDC.searchUI.show(false, "redact")); await W(300);
  await p.evaluate(() => document.querySelector("#crList [data-act=edit]").click()); await W(400);
  s = await st(p);
  ok(tag + " H1 Edit: the region's own camera, enlarged, no pick; the chip is shown but not tappable", s.cam === "right_repeater" && s.focus === "right_repeater" && !s.pick, s);
  await p.evaluate(() => TDC.regions.UI.draw()); await W(300);
  s = await st(p);
  ok(tag + " H2 Draw region while editing redraws on the same camera (no pick)", s.cam === "right_repeater" && s.drawing && !s.pick && s.picks === 0 && await p.evaluate(() => document.getElementById("crBarCam").disabled), s);
  await cancel();
  // ── I. an event with five cameras: only those are offered ──
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events.find((e) => e.cams.length === 5)); }); await W(1800);
  await p.evaluate(() => { TDC.player.pause(); TDC.focus.grid(); }); await W(400);
  await p.evaluate(() => TDC.searchUI.show(false, "redact")); await W(300);
  await startDraw(); await W(300);
  s = await st(p);
  ok(tag + " I1 five-camera event: five camera buttons, none for the missing camera", s.pick && s.picks === 5 && await p.evaluate(() => !document.querySelector(".tile[data-cam=right_pillar] > .cr-pick")), s);
  await cancel();
  ok(tag + " H3 no page errors", errs.length === 0, errs);
  await ctx.close();
}

(async () => {
  if (!fs.existsSync(FIX + "/TeslaCam")) execFileSync("python3", [path.join(ROOT, "tools/make-mock-footage.py"), FIX], { stdio: "inherit" });
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await server(); const pw = require("playwright");
  const DEVS = [
    { name: "desktop", ctx: { viewport: { width: 1280, height: 800 } } },
    { name: "phone", ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: UA, deviceScaleFactor: 2 } },
  ].filter((d) => !process.env.DEV || d.name === process.env.DEV);
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    let b;
    try { b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] }); }
    catch (e) { console.log("SKIP " + BR + ": cannot launch (" + e.message.split("\n")[0] + ")"); continue; }
    for (const dev of DEVS) { const tag = BR + " " + dev.name; try { await run(b, dev, tag); } catch (e) { ok(tag + " run threw: " + e.message.split("\n")[0], false); } }
    await b.close();
  }
  srv.close(); console.log(fails ? "FAILED " + fails : "ALL PASSED"); process.exit(fails ? 1 : 0);
})();
