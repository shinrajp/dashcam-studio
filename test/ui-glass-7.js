// ui-glass-7 (Redact tray): the draw bar (#crBar) is a compact glass tray like the iOS markup pen tray: camera chip, Box / Freehand, Blur / Remove,
// Undo, Redo, Move, Draw again, Options, Cancel and Done. Undo / redo cover add, edit, move, delete (and on/off, file load) of regions for this
// session and event, with Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z. Move selects a saved region: drag moves it, a box's corner resizes it, arrows nudge it.
//   Playwright, BR=chromium|webkit (default both), mock footage (tools/make-mock-footage.py -> /tmp/ho-mock), PORT (default 8817).
//   Devices: desktop 1440x900 and 1024x553 (mouse, the Mac Safari window), phones 430x932 and 844x390 (touch).
//   Checks: 1 tray layout: every control there, on screen, <= 2 rows, icons only on phones (Done keeps its word), 44 px targets on touch;
//   2 tool / mode buttons follow and set Box / Freehand, Blur / Remove; 3 draw + Done saves (same storage as before); 4 undo / redo of a drawn
//   shape, an add, an edit (Blur -> Remove), a delete, via the buttons and the keyboard (Ctrl+Z / Meta+Z, Shift+..+Z); 5 Move: drag moves a region
//   (one undo step), a corner resizes a box, arrows nudge, Delete removes, Done closes; 6 the stored format / file and the burn-in are the same as
//   from G.add with the same shape (export parity); 7 the tray drags by its grip with mouse and touch (no pointer capture), and a stroke near the
//   bottom is not blocked (the tray steps away); 8 the bubble is out of the way; 9 reduced motion: the tray fades instead of springing; 10 no page errors.
//   SHOTS=dir PREFIX=after- writes <prefix>tray-<w>x<h>.png (drawing, a shape drawn) and <prefix>move-<w>x<h>.png (Move with a selected region).
const fs = require("fs"), path = require("path"), http = require("http");
const ROOT = path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", PORT = +(process.env.PORT || 8817), SHOTS = process.env.SHOTS || "", PREFIX = process.env.PREFIX || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".onnx": "application/octet-stream", ".wasm": "application/wasm" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html"; fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; r.end(); return; } r.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }).listen(PORT, "127.0.0.1", () => res(s)); });
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const R = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }, sel);
async function open(p, reduce) {
  await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1`, { waitUntil: "load" });
  await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.prefs.v1"); localStorage.removeItem("tdc.regions.v1"); localStorage.removeItem("tdc.mbarOpen"); sessionStorage.clear(); });
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events.find((e) => e.cams.length === 6) || TDC.library.events[0]); }); await W(1800);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); TDC.setPref("autohide", "never"); document.getElementById("settings").hidden = true; TDC.player.seek(3); if (TDC.focus.dismissHint) TDC.focus.dismissHint();
    document.querySelectorAll(".toast").forEach((t) => t.remove()); }); await W(500);
}
const ST = (p) => p.evaluate(() => { const S = TDC.regions.ui, G = TDC.regions; return { n: G.list.length, drawing: !!S.drawing, draft: !!S.draft, move: !!S.move, sel: S.sel || null, cam: S.cam, shape: S.shape, mode: S.mode, bar: !document.getElementById("crBar").hidden, cu: G.UI.canUndo(), cr: G.UI.canRedo() }; });
const IDS = ["crBarGrip", "crBarCam", "crBarBox", "crBarFree", "crBarBlur", "crBarRemove", "crBarUndo", "crBarRedo", "crBarMove", "crBarOpts", "crBarCancel", "crBarSave"];

async function run(b, BR, dev) {
  const tag = BR + " " + dev.name, touch = !!dev.touch, phone = dev.w <= 760, icons = phone || (touch && dev.h <= 500);
  const ctx = await b.newContext({ viewport: { width: dev.w, height: dev.h }, isMobile: touch && BR === "chromium", hasTouch: touch, userAgent: touch ? UA : undefined, deviceScaleFactor: touch ? 2 : 1, reducedMotion: dev.reduce ? "reduce" : "no-preference" });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(String(e.message || e)));
  const cdp = touch && BR === "chromium" ? await ctx.newCDPSession(p) : null;
  const shot = async (n) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await W(350); await p.screenshot({ path: path.join(SHOTS, PREFIX + n + "-" + dev.w + "x" + dev.h + ".png") }); } };
  const click = async (sel) => { const r = await R(p, sel); if (!r) return false; if (touch) await p.touchscreen.tap(r.cx, r.cy); else { await p.mouse.move(r.cx, r.cy); await p.mouse.click(r.cx, r.cy); } await W(300); return true; };
  const drag = async (pts, onCanvas) => {
    if (!touch) { await p.mouse.move(pts[0][0], pts[0][1]); await p.mouse.down(); for (const q of pts.slice(1)) { await p.mouse.move(q[0], q[1], { steps: 4 }); await W(20); } await p.mouse.up(); }
    else if (cdp) { const tp = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1, radiusX: 8, radiusY: 8 }] }); await tp("touchStart", pts[0][0], pts[0][1]); for (const q of pts.slice(1)) { await tp("touchMove", q[0], q[1]); await W(25); } await tp("touchEnd"); }
    else {   // WebKit harness: synthetic touch pointer events
      const ev = (type, x, y) => p.evaluate(([type, x, y]) => { const e = document.elementFromPoint(x, y); (e || document.body).dispatchEvent(new PointerEvent(type, { pointerId: 21, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1 })); }, [type, x, y]);
      await ev("pointerdown", pts[0][0], pts[0][1]); for (const q of pts.slice(1)) await ev("pointermove", q[0], q[1]); await ev("pointerup", pts[pts.length - 1][0], pts[pts.length - 1][1]);
    }
    await W(300);
  };
  const line = (a, z, n) => Array.from({ length: (n || 6) + 1 }, (_, k) => [a[0] + ((z[0] - a[0]) * k) / (n || 6), a[1] + ((z[1] - a[1]) * k) / (n || 6)]);
  const fit = () => p.evaluate(() => { const f = TDC.regions.screenFit(TDC.regions.ui.cam); return f && { x: f.x, y: f.y, w: f.w, h: f.h, m: !!f.mirrored }; });
  const at = (f, u, v) => [f.x + (f.m ? 1 - u : u) * f.w, f.y + v * f.h];
  const key = async (k) => { await p.keyboard.press(k); await W(250); };
  const MOD = BR === "webkit" ? "Meta" : "Control";

  await open(p);
  // start drawing on the front camera
  await p.evaluate(() => { TDC.focus.focus("front"); }); await W(500);
  await p.evaluate(() => TDC.regions.UI.draw()); await W(600);
  let s = await ST(p);
  ok(tag + " 0 Draw region arms drawing on the front camera with the tray up", s.drawing && s.cam === "front" && s.bar, s);
  // 1 layout
  const L = await p.evaluate((ids) => { const vw = innerWidth, vh = innerHeight, b = document.getElementById("crBar"), br = b.getBoundingClientRect();
    const items = ids.map((id) => { const e = document.getElementById(id); if (!e || !e.getClientRects().length) return { id, missing: true }; const r = e.getBoundingClientRect(), t = e.querySelector(".t"); return { id, l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, lbl: !!t && t.getClientRects().length > 0, lab: e.getAttribute("aria-label") || e.textContent.trim() }; });
    const rows = new Set(items.filter((x) => !x.missing).map((x) => Math.round((x.t + x.b) / 2 / 8))).size;
    const cs = getComputedStyle(b); return { items, rows, bar: { l: br.left, t: br.top, r: br.right, b: br.bottom, h: br.height }, vw, vh, role: b.getAttribute("role"), anim: cs.animationName, radius: parseFloat(cs.borderTopLeftRadius) }; }, IDS);
  const miss = L.items.filter((x) => x.missing).map((x) => x.id), off = L.items.filter((x) => !x.missing && (x.l < -0.5 || x.r > L.vw + 0.5 || x.t < -0.5 || x.b > L.vh + 0.5)).map((x) => x.id);
  ok(tag + " 1 tray has every control (camera, Box/Freehand, Blur/Remove, Undo, Redo, Move, Options, Cancel, Done), all on screen", !miss.length && !off.length && L.role === "toolbar", { miss, off });
  ok(tag + " 1 compact: " + (phone ? "at most 2 rows" : "one row") + ", capsule", L.rows <= (phone ? 2 : 1) && L.radius >= 18, { rows: L.rows, radius: L.radius, bar: L.bar });
  const lbls = L.items.filter((x) => !x.missing && x.id !== "crBarGrip" && x.id !== "crBarCam" && x.id !== "crBarSave" && x.lbl).map((x) => x.id);
  ok(tag + " 1 " + (icons ? "icons only on the phone (Done keeps its word), every button has a name" : "labels on the desktop (Undo / Redo icons), every button has a name"),
    (icons ? lbls.length === 0 : ["crBarBox", "crBarBlur", "crBarMove"].every((i) => lbls.includes(i)) && !lbls.includes("crBarUndo")) && L.items.every((x) => x.missing || !!x.lab), { lbls });
  if (touch) { const small = L.items.filter((x) => !x.missing && x.id !== "crBarGrip" && (x.w < 43.5 || x.h < 43.5)).map((x) => [x.id, x.w, x.h]); ok(tag + " 1 44 px targets on touch", !small.length, small); }
  ok(tag + " 9 the tray " + (dev.reduce ? "fades in (Reduce motion)" : "rises and springs in"), L.anim === (dev.reduce ? "crFade" : "crRise"), L.anim);
  // 8 bubble out of the way on phones
  if (phone) ok(tag + " 8 the tools bubble steps away while the tray is up", await p.evaluate(() => !TDC.bubble || !TDC.bubble.on || !!TDC.bubble.away));
  // 2 tool + mode
  await click("#crBarFree"); s = await ST(p);
  ok(tag + " 2 Freehand in the tray sets the tool and keeps drawing on the same camera", s.shape === "free" && s.drawing && s.cam === "front" && await p.evaluate(() => document.getElementById("crBarFree").getAttribute("aria-pressed") === "true" && document.querySelector('#crShape [data-v="free"]').getAttribute("aria-pressed") === "true"), s);
  await click("#crBarBox"); await click("#crBarRemove"); s = await ST(p);
  ok(tag + " 2 Box + Remove from the tray (the panel follows)", s.shape === "rect" && s.mode === "remove" && await p.evaluate(() => document.querySelector('#crMode [data-v="remove"]').getAttribute("aria-pressed") === "true"), s);
  await click("#crBarBlur");
  // 3 draw + Done
  let f = await fit(); const box1 = [at(f, 0.2, 0.3), at(f, 0.45, 0.55)];
  await drag(line(box1[0], box1[1])); s = await ST(p);
  ok(tag + " 3 a drag draws a box (Done enabled, Undo enabled)", s.draft && !s.drawing && s.cu && await p.evaluate(() => !document.getElementById("crBarSave").disabled && !document.getElementById("crBarUndo").disabled), s);
  await shot("tray");
  // 4a undo / redo of an unsaved shape (button)
  await click("#crBarUndo"); s = await ST(p);
  ok(tag + " 4 Undo takes the drawn shape away (drawing again), Redo enabled", !s.draft && s.drawing && s.cr, s);
  await click("#crBarRedo"); s = await ST(p);
  ok(tag + " 4 Redo brings it back", s.draft && !s.drawing, s);
  await click("#crBarSave"); await W(300); s = await ST(p);
  const r1 = await p.evaluate(() => JSON.parse(JSON.stringify(TDC.regions.list[0] || null)));
  ok(tag + " 3 Done saves one blur box on the front camera and closes the tray", s.n === 1 && !s.bar && r1 && r1.cam === "front" && r1.shape === "rect" && r1.mode === "blur", { s, r1 });
  // 6 storage / burn parity with G.add of the same region
  const par = await p.evaluate(() => { const G = TDC.regions, a = JSON.parse(JSON.stringify(G.list[0])); const stored = JSON.parse(localStorage.getItem(G.KEY) || "null"), evs = (stored || {}).events || {};
    const keys = Object.keys(a).sort().join();
    const src = document.createElement("canvas"); src.width = 160; src.height = 120; const sx = src.getContext("2d");
    for (let i = 0; i < 16; i++) { sx.fillStyle = "hsl(" + i * 23 + ",70%,50%)"; sx.fillRect((i % 4) * 40, Math.floor(i / 4) * 30, 40, 30); }
    const burn = () => { const c = document.createElement("canvas"); c.width = 160; c.height = 120; const x = c.getContext("2d"); x.drawImage(src, 0, 0); G.burn(x, "front", 3, { x: 0, y: 0, w: 160, h: 120 }, 160, 120, src); return c.toDataURL(); };
    const A = burn(), fileA = G.toJSON().replace(/"id":"[^"]+"/g, "");
    const { id, ...rest } = a; void id; G.clear(); G.add(rest); const B = burn(), fileB = G.toJSON().replace(/"id":"[^"]+"/g, "");
    G.undo(); G.undo();
    return { keys, stored: JSON.stringify(evs).includes(a.id), file: JSON.parse(fileA).type + " v" + JSON.parse(fileA).version, sameFile: fileA === fileB, sameBurn: A === B, changed: A !== (() => { const c = document.createElement("canvas"); c.width = 160; c.height = 120; c.getContext("2d").drawImage(src, 0, 0); return c.toDataURL(); })(), back: G.list.length === 1 && G.list[0].id === a.id }; });
  ok(tag + " 6 export parity: a tray region stores, saves to file and burns exactly like the same region added directly (v1 format)", par.keys === "cam,end,h,id,mode,on,shape,start,v,w,x,y" && par.stored && par.file === "dashcam-studio-regions v1" && par.sameFile && par.sameBurn && par.changed && par.back, par);
  // 4b keyboard undo / redo of add / edit / delete (outside the tray)
  await p.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  await key(MOD + "+z"); s = await ST(p);
  ok(tag + " 4 " + MOD + "+Z undoes the add (0 regions)", s.n === 0, s);
  await key(MOD + "+Shift+z"); s = await ST(p);
  ok(tag + " 4 " + MOD + "+Shift+Z redoes it (1 region, same id)", s.n === 1 && await p.evaluate((id) => TDC.regions.list[0].id === id, r1.id), s);
  await p.evaluate(() => { const G = TDC.regions; G.update(G.list[0].id, { mode: "remove" }); }); await W(150);
  await key(MOD + "+z");
  ok(tag + " 4 undo of an edit (Remove -> Blur)", await p.evaluate(() => TDC.regions.list[0].mode === "blur"));
  await key("Control+y");
  ok(tag + " 4 Ctrl+Y redoes the edit", await p.evaluate(() => TDC.regions.list[0].mode === "remove"));
  await p.evaluate(() => { const G = TDC.regions; G.update(G.list[0].id, { mode: "blur" }); G.remove(G.list[0].id); }); await W(150);
  await key(MOD + "+z"); s = await ST(p);
  ok(tag + " 4 undo of a delete brings the region back", s.n === 1 && await p.evaluate((id) => TDC.regions.list[0].id === id, r1.id), s);
  const typed = await p.evaluate(() => { const i = document.getElementById("crFrom"); i.focus(); return document.activeElement === i; });
  if (typed) { const n0 = (await ST(p)).n; await key(MOD + "+z"); ok(tag + " 4 Cmd/Ctrl+Z in a text field is left to the field", (await ST(p)).n === n0); await p.evaluate(() => document.activeElement.blur()); }
  // 5 Move
  await p.evaluate(() => TDC.regions.UI.draw()); await W(500);
  await click("#crBarMove"); s = await ST(p);
  ok(tag + " 5 Move: selects the camera's region, drawing paused, Move pressed", s.move && s.sel === r1.id && !s.drawing && await p.evaluate(() => document.getElementById("crBarMove").getAttribute("aria-pressed") === "true"), s);
  await shot("move");
  f = await fit(); const c0 = at(f, r1.x + r1.w / 2, r1.y + r1.h / 2), to = [c0[0] + f.w * 0.15 * (f.m ? -1 : 1), c0[1] + f.h * 0.1];
  const hBefore = await p.evaluate(() => TDC.regions.hist.u.length);
  await drag(line(c0, to, 8));
  let r2 = await p.evaluate(() => JSON.parse(JSON.stringify(TDC.regions.list[0])));
  ok(tag + " 5 a drag moves the region (same size, one undo step, still selected)", Math.abs(r2.x - (r1.x + 0.15)) < 0.02 && Math.abs(r2.y - (r1.y + 0.1)) < 0.02 && Math.abs(r2.w - r1.w) < 0.002 && (await p.evaluate(() => TDC.regions.hist.u.length)) === hBefore + 1, { r1, r2 });
  await click("#crBarUndo"); let r3 = await p.evaluate(() => JSON.parse(JSON.stringify(TDC.regions.list[0])));
  ok(tag + " 5 Undo puts it back where it was", Math.abs(r3.x - r1.x) < 0.001 && Math.abs(r3.y - r1.y) < 0.001, { r1, r3 });
  await click("#crBarRedo");
  r2 = await p.evaluate(() => JSON.parse(JSON.stringify(TDC.regions.list[0]))); f = await fit();
  const corner = at(f, r2.x + r2.w, r2.y + r2.h);
  await drag(line(corner, [corner[0] + f.w * 0.08 * (f.m ? -1 : 1), corner[1] + f.h * 0.06], 6));
  const r4 = await p.evaluate(() => JSON.parse(JSON.stringify(TDC.regions.list[0])));
  ok(tag + " 5 dragging the bottom-right corner resizes the box (top-left stays)", Math.abs(r4.x - r2.x) < 0.003 && Math.abs(r4.y - r2.y) < 0.003 && r4.w > r2.w + 0.04 && r4.h > r2.h + 0.03, { r2, r4 });
  await click("#crBarRemove");
  ok(tag + " 5 Remove in the tray changes the selected region's mode", await p.evaluate(() => TDC.regions.list[0].mode === "remove"));
  if (!touch) {
    await p.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
    const x0 = r4.x; await key("Shift+ArrowLeft"); const x1 = await p.evaluate(() => TDC.regions.list[0].x);
    ok(tag + " 5 Shift+Left nudges the region on the picture", Math.abs(Math.abs(x1 - x0) - 0.02) < 0.002, { x0, x1 });
    await key("Delete"); s = await ST(p);
    ok(tag + " 5 Delete removes the selected region; " + MOD + "+Z brings it back", s.n === 0, s);
    await key(MOD + "+z"); s = await ST(p); ok(tag + " 5 ... back", s.n === 1, s);
  }
  await click("#crBarSave"); s = await ST(p);
  ok(tag + " 5 Done closes the tray (the moves stay)", !s.bar && !s.move && s.n === 1, s);
  // 7 tray drag + bottom stroke not blocked
  await p.evaluate(() => { TDC.regions.UI.barReset && TDC.regions.UI.barReset(); TDC.regions.UI.draw(); }); await W(500);
  const g = await R(p, "#crBarGrip"), b0 = await R(p, "#crBar");
  const noCap = await p.evaluate(() => { window.__cap = 0; const o = Element.prototype.setPointerCapture; Element.prototype.setPointerCapture = function (id) { if (this.closest && this.closest("#crBar")) window.__cap++; return o.call(this, id); }; return true; });
  await drag(line([g.cx, g.cy], [g.cx + Math.min(120, dev.w * 0.15), g.cy - Math.min(160, dev.h * 0.3)], 6));
  const b1 = await R(p, "#crBar");
  ok(tag + " 7 the tray drags by its grip (" + (touch ? "touch" : "mouse") + "), no pointer capture on the tray", noCap && b1 && Math.abs(b1.t - b0.t) > 30 && (await p.evaluate(() => window.__cap)) === 0, { b0, b1 });
  await p.evaluate(() => TDC.regions.UI.barReset()); await W(300);
  f = await fit(); const tb = await R(p, "#crBar");
  const yb = Math.min(f.y + f.h - 6, tb.t + tb.h / 2), xa = Math.max(f.x + 6, tb.l + 10), xb = Math.min(f.x + f.w - 6, tb.r - 10);
  const n0 = (await ST(p)).n;
  await drag(line([xa, Math.max(f.y + 4, yb - f.h * 0.12)], [xb, yb], 6)); s = await ST(p);
  const tb2 = await R(p, "#crBar");
  const clear = f.y + f.h <= tb.t;   // the picture ends above the tray: nothing to block
  ok(tag + " 7 a stroke near the bottom of the picture is not blocked (" + (clear ? "the tray sits below the picture" : "the tray stepped away") + ")", s.draft && s.n === n0 && (clear || Math.abs(tb2.t - tb.t) > 20), { s, tb, tb2, f });
  await click("#crBarCancel");
  // 10
  ok(tag + " 10 no page errors", errs.length === 0, errs);
  await ctx.close();
}
(async () => {
  const pw = require("playwright"), srv = await server();
  const engines = (process.env.BR || "chromium,webkit").split(",");
  const DEVS = [{ name: "desktop-1440", w: 1440, h: 900 }, { name: "mac-1024", w: 1024, h: 553 }, { name: "phone-430", w: 430, h: 932, touch: 1 }, { name: "phone-844", w: 844, h: 390, touch: 1, reduce: 1 }];
  const only = process.env.DEV;
  for (const BR of engines) {
    let b; try { b = await pw[BR].launch(BR === "chromium" && fs.existsSync("/usr/bin/google-chrome") ? { executablePath: "/usr/bin/google-chrome" } : {}); } catch (e) { console.log("SKIP " + BR + ": " + e.message.split("\n")[0]); continue; }
    for (const d of DEVS) if (!only || d.name.includes(only)) { try { await run(b, BR, d); } catch (e) { ok(BR + " " + d.name + " ran without throwing", false, String(e.stack || e).slice(0, 600)); } }
    await b.close();
  }
  srv.close(); console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})();
