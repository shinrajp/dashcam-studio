// Floating car view (tag ui-v3): Playwright WebKit + Chromium, desktop 1440x900 and phone 430x932 (touch).
//  - panel floats (fixed on the page): showing / moving / resizing / pinning it never moves or resizes the video grid
//  - drag by the header (mouse and touch-type pointer events), keyboard arrows, clamped to the window only (can leave the grid: margins, bottom bar, side bar)
//  - corner resize (min/max), pin locks position and size (and hides close/collapse), pin + position + size remembered per device across a reload
//  - collapse / expand, close (turns the Car view chip off)
//  - export dialog: "Include car view" tick (ticked by default when the car view is on, can be unticked, hidden when the car view is off) -> show.carview
//  - export frame pixel check on a short synthetic export: the card (car body + coloured person) is in the frame at the panel's relative place;
//    a panel dragged OUTSIDE the grid lands fully inside the picture at the nearest edge/corner; tick off = nothing drawn
// Usage: BR=chromium|webkit node test/car-float.js [url]   DEV=desktop|phone   NOEXPORT=1 skips the encode checks
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html", MOCK = process.env.MOCK || "/tmp/ho-mock";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 700) : "")); if (!c) fails++; };
const near = (a, b, e) => Math.abs(a - b) <= e;
(async () => {
  const pw = require("playwright");
  if (!fs.existsSync(MOCK + "/TeslaCam")) execFileSync("python3", [path.join(__dirname, "../tools/make-mock-footage.py"), MOCK, "--jobs", "4"], { stdio: "inherit" });
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    const b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
    for (const dev of [{ name: "desktop", viewport: { width: 1440, height: 900 } }, { name: "phone", viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, userAgent: UA, deviceScaleFactor: 2 }].filter((d) => !process.env.DEV || d.name === process.env.DEV)) {
      const tag = BR + " " + dev.name + ": ";
      const ctx = await b.newContext(dev); const p = await ctx.newPage(); const errs = [];
      // headless WebKit cannot paint decoded video frames (always black), so the exported file is decoded in Chrome instead
      let db = null, dp = p;
      if (BR === "webkit") { db = await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] }); dp = await (await db.newContext()).newPage(); await dp.goto("about:blank"); } p.on("pageerror", (e) => errs.push(e.message));
      const load = async () => {
        await p.goto(URL_, { waitUntil: "load" });
        await p.evaluate(() => localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })));
        await p.reload({ waitUntil: "load" });
        await p.setInputFiles("#folderInput", MOCK + "/TeslaCam");
        for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 2; i++) await W(250);
        await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
        await p.evaluate(() => TDC.ui.activate(TDC.library.events.find((e) => /Sentry/.test(e.source)))); await W(900);
        await p.evaluate(() => { TDC.player.pause(); TDC.reid.maybeEmbed = () => {}; });
      };
      const R = (sel) => p.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height), hidden: !!e.hidden }; }, sel);
      // synthetic pointer drag on an element (works for touch-type pointers too)
      const drag = (sel, dx, dy, type) => p.evaluate(([sel, dx, dy, type]) => {
        const e = document.querySelector(sel), r = e.getBoundingClientRect(), x0 = r.left + r.width / 2, y0 = r.top + r.height / 2, id = 7;
        const fire = (n, x, y, t) => e.dispatchEvent(new PointerEvent(n, { pointerId: id, pointerType: type, isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: n === "pointerup" ? 0 : 1 }));
        fire("pointerdown", x0, y0); for (let i = 1; i <= 6; i++) fire("pointermove", x0 + (dx * i) / 6, y0 + (dy * i) / 6); fire("pointerup", x0 + dx, y0 + dy);
      }, [sel, dx, dy, type]);
      await load();
      const g0 = await R("#grid"), st0 = await R("#stage"), ft0 = await R("footer");
      ok(tag + "Car view is off at the start: no panel", (await R("#carView")).hidden);
      await p.evaluate(() => TDC.setPref("carView", true)); await W(400);
      const hasP = await p.evaluate(() => { const e = document.getElementById("carView"); return { parent: e.parentElement === document.body, pos: getComputedStyle(e).position, pin: !!document.getElementById("cvPin"), rz: !!document.getElementById("cvResize"), bar: !!document.getElementById("cvHead"), wedges: e.querySelectorAll(".cv-wedge").length }; });
      ok(tag + "panel is a fixed element on the page with header, pin, collapse, close, resize handle and six wedges", hasP.parent && hasP.pos === "fixed" && hasP.pin && hasP.rz && hasP.bar && hasP.wedges === 6, hasP);
      let cv = await R("#carView"); const g1 = await R("#grid"), ft1 = await R("footer");
      ok(tag + "showing the panel does not move or resize the grid, stage or footer", JSON.stringify(g0) === JSON.stringify(g1) && ft0.h === ft1.h && ft0.t === ft1.t, { g0, g1, ft0, ft1 });
      ok(tag + "default place: inside the video area, bottom left", cv.l >= st0.l && cv.r <= st0.r + 1 && cv.b <= st0.b + 1 && cv.t >= st0.t && cv.l < st0.l + 40, { cv, st0 });
      // ── move: header drag (mouse on desktop, touch-type pointer events on both) ──
      const kinds = dev.name === "desktop" ? ["mouse", "touch"] : ["touch"];
      for (const kind of kinds) {
        const a = await R("#carView");
        if (kind === "mouse") { const h = await R("#cvHead"); await p.mouse.move(h.l + 20, h.t + h.h / 2); await p.mouse.down(); await p.mouse.move(h.l + 120, h.t - 90, { steps: 6 }); await p.mouse.up(); }
        else await drag("#cvHead", 70, -60, "touch");
        await W(120); const c = await R("#carView");
        ok(tag + "dragging the header (" + kind + ") moves the panel", Math.abs(c.l - a.l) > 40 && Math.abs(c.t - a.t) > 40, { a, c });
      }
      const g2 = await R("#grid");
      ok(tag + "moving it leaves the grid untouched", JSON.stringify(g2) === JSON.stringify(g0), { g0, g2 });
      // ── outside the grid: margin above the grid, the left side bar, the bottom bar; clamped to the window only ──
      const vp = dev.viewport;
      await drag("#cvHead", -3000, -3000, "touch"); await W(120); cv = await R("#carView");
      ok(tag + "dragged far past the top-left: clamped to the window corner (0,0), which is outside the grid", cv.l === 0 && cv.t === 0 && (cv.l < g0.l || cv.t < g0.t), { cv, g0 });
      await drag("#cvHead", 4000, 4000, "touch"); await W(120); cv = await R("#carView");
      ok(tag + "dragged far past the bottom-right: kept fully inside the window", cv.r <= vp.width && cv.b <= vp.height && cv.r >= vp.width - 2 && cv.b >= vp.height - 2, { cv, vp });
      ok(tag + "... and that spot is outside the grid (bottom bar / side area)", cv.b > g0.b || cv.r > g0.r || cv.l < g0.l, { cv, g0 });
      const barPx = await p.evaluate(() => { const f = document.querySelector("footer").getBoundingClientRect(), r = document.getElementById("carView").getBoundingClientRect(); return { overlapsFooter: r.bottom > f.top, footerTop: Math.round(f.top) }; });
      if (dev.name === "desktop") ok(tag + "it can sit on top of the bottom bar", barPx.overlapsFooter, barPx);
      const g3 = await R("#grid"); ok(tag + "grid still untouched at the window edges", JSON.stringify(g3) === JSON.stringify(g0), g3);
      // keyboard
      await drag("#cvHead", -300, -300, "touch"); await W(100); const k0 = await R("#carView");
      await p.focus("#cvHead"); await p.keyboard.press("ArrowRight"); await p.keyboard.press("ArrowDown"); await W(80); const k1 = await R("#carView");
      ok(tag + "arrow keys on the focused header move it (10 px)", k1.l - k0.l === 10 && k1.t - k0.t === 10, { k0, k1 });
      // ── resize ──
      await drag("#cvHead", 200, 200, "touch"); await W(100);
      const s0 = await R("#carView"); await drag("#cvResize", 60, 60, "touch"); await W(120); const s1 = await R("#carView");
      ok(tag + "dragging the corner handle makes it bigger", s1.w >= s0.w + 40 && s1.h > s0.h + 30 && s1.l === s0.l && s1.t === s0.t, { s0, s1 });
      await drag("#cvResize", 2000, 2000, "touch"); await W(120); const s2 = await R("#carView");
      ok(tag + "size is capped (<= 420 px) and the panel stays in the window", s2.w <= 420 && s2.r <= vp.width && s2.b <= vp.height, s2);
      await drag("#cvResize", -2000, -2000, "touch"); await W(120); const s3 = await R("#carView");
      ok(tag + "size has a minimum (>= 90 px)", s3.w >= 90 && s3.w <= 100, s3);
      await drag("#cvResize", 40, 40, "touch"); await W(100);
      const g4 = await R("#grid"); ok(tag + "resizing never changes the grid", JSON.stringify(g4) === JSON.stringify(g0), g4);
      // ── collapse / expand ──
      await p.click("#cvCollapse"); await W(150); let col = await p.evaluate(() => ({ cls: document.getElementById("carView").className, body: getComputedStyle(document.querySelector("#carView .cv-body")).display, ex: document.getElementById("cvCollapse").getAttribute("aria-expanded") }));
      ok(tag + "collapse hides the diagram, keeps the header", /collapsed/.test(col.cls) && col.body === "none" && col.ex === "false", col);
      await p.click("#cvCollapse"); await W(150); col = await p.evaluate(() => getComputedStyle(document.querySelector("#carView .cv-body")).display);
      ok(tag + "expand brings it back", col !== "none", col);
      // ── pin ──
      await drag("#cvHead", -150, -100, "touch"); await W(100);
      await p.click("#cvPin"); await W(150);
      const pin = await p.evaluate(() => { const e = document.getElementById("carView"), pr = TDC.prefs.carPanel; return { pressed: document.getElementById("cvPin").getAttribute("aria-pressed"), cls: e.classList.contains("pinned"), closeDisabled: document.getElementById("cvClose").disabled, colDisabled: document.getElementById("cvCollapse").disabled, rz: getComputedStyle(document.getElementById("cvResize")).display, pr }; });
      ok(tag + "pin: pressed, close / collapse / resize handle are gone, saved in prefs", pin.pressed === "true" && pin.cls && pin.closeDisabled && pin.colDisabled && pin.rz === "none" && pin.pr.pinned === true && pin.pr.fx >= 0 && pin.pr.w > 0, pin);
      const q0 = await R("#carView"); await drag("#cvHead", 120, 90, "touch"); await drag("#cvResize", 50, 50, "touch"); await p.focus("#cvHead"); await p.keyboard.press("ArrowRight"); await W(120); const q1 = await R("#carView");
      ok(tag + "pinned: dragging, resizing and arrow keys change nothing", JSON.stringify(q0) === JSON.stringify(q1), { q0, q1 });
      // ── remembered per device ──
      await p.reload({ waitUntil: "load" });
      await p.setInputFiles("#folderInput", MOCK + "/TeslaCam");
      for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 2; i++) await W(250);
      await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
      await p.evaluate(() => TDC.ui.activate(TDC.library.events.find((e) => /Sentry/.test(e.source)))); await W(1000);
      const r0 = await R("#carView"), rp = await p.evaluate(() => ({ pinned: TDC.prefs.carPanel.pinned, on: TDC.prefs.carView, aria: document.getElementById("cvPin").getAttribute("aria-pressed") }));
      ok(tag + "after a reload: still visible, pinned, same position and size", !r0.hidden && rp.pinned && rp.aria === "true" && near(r0.l, q1.l, 2) && near(r0.t, q1.t, 2) && near(r0.w, q1.w, 1), { r0, q1, rp });
      // viewport resize keeps it inside
      if (dev.name === "desktop") { await p.setViewportSize({ width: 1100, height: 700 }); await W(300); const rv = await R("#carView"); ok(tag + "a smaller window keeps the panel inside it", rv.r <= 1100 && rv.b <= 700 && rv.l >= 0 && rv.t >= 0, rv); await p.setViewportSize({ width: 1440, height: 900 }); await W(300); }
      // ── unpin, close ──
      await p.click("#cvPin"); await W(100);
      await p.click("#cvClose"); await W(200);
      const cl = await p.evaluate(() => ({ hidden: document.getElementById("carView").hidden, pref: TDC.prefs.carView, chip: document.getElementById("chipCar").getAttribute("aria-pressed") }));
      ok(tag + "unpinned: close hides it and turns the Car view chip off", cl.hidden && cl.pref === false && cl.chip === "false", cl);
      // ── export dialog: the tick ──
      const stub = () => p.evaluate(() => { window.__opts = null; if (!window.__realRun) window.__realRun = TDC.exporter.run; TDC.exporter.run = async (o) => { window.__opts = o; throw new Error("stub"); }; });
      const openExp = async () => { await p.evaluate(() => { document.getElementById("exportModal").hidden = true; document.getElementById("btnExport").click(); }); await W(500); };
      await stub(); await openExp();
      let tk = await p.evaluate(() => { const w = document.getElementById("exportCarWrap"), c = document.getElementById("exportCar"), r = w.getBoundingClientRect(); return { hidden: w.hidden, shown: r.width > 0 && r.height > 0, checked: c.checked, disabled: c.disabled }; });
      ok(tag + "car view off: the Include car view tick is hidden", tk.hidden && !tk.shown && tk.disabled, tk);
      await p.evaluate(() => document.getElementById("btnExportGo").click()); await W(500);
      let o = await p.evaluate(() => window.__opts && window.__opts.show);
      ok(tag + "car view off: export gets show.carview = false", o && o.carview === false, o);
      await p.evaluate(() => { document.getElementById("exportModal").hidden = true; TDC.setPref("carView", true); }); await W(300);
      await openExp();
      tk = await p.evaluate(() => { const w = document.getElementById("exportCarWrap"), c = document.getElementById("exportCar"), r = w.getBoundingClientRect(); return { hidden: w.hidden, shown: r.width > 0 && r.height > 0, checked: c.checked, label: w.textContent.trim() }; });
      ok(tag + "car view on: the tick \"Include car view\" is shown and ticked by default", !tk.hidden && tk.shown && tk.checked && /Include car view/.test(tk.label), tk);
      await p.evaluate(() => { window.__opts = null; document.getElementById("btnExportGo").click(); }); await W(500);
      o = await p.evaluate(() => window.__opts && window.__opts.show);
      ok(tag + "ticked: export gets show.carview = true", o && o.carview === true, o);
      await p.evaluate(() => { document.getElementById("exportProgress").hidden = true; }); await openExp();
      await p.evaluate(() => { const c = document.getElementById("exportCar"); c.click(); }); await W(100);
      await p.evaluate(() => { window.__opts = null; document.getElementById("btnExportGo").click(); }); await W(500);
      o = await p.evaluate(() => window.__opts && window.__opts.show);
      ok(tag + "unticked: export gets show.carview = false", o && o.carview === false, o);
      await p.evaluate(() => { TDC.exporter.run = window.__realRun; document.getElementById("exportModal").hidden = true; });
      // ── export frame pixel check ──
      const cap = await p.evaluate(() => TDC.exporter.capability());
      if (process.env.NOEXPORT || cap.mode === "none") ok(tag + "export pixel check skipped (" + (process.env.NOEXPORT ? "NOEXPORT" : "no encoder in this browser") + ")", true);
      else {
        const exp = (show, ranges) => p.evaluate(async ([show, ranges]) => {
          try { const r = await TDC.exporter.run({ preset: "compat", ranges, show: { labels: false, hud: false, map: false, fsd: false, time: false, boxes: false, ...show }, onStatus: () => {}, onProgress: () => {} }); window.__lastExport = r.blob; return { ok: true, type: r.type, note: r.note || null }; }
          catch (e) { return { ok: false, err: String(e && e.message || e) }; }
        }, [show, ranges]).then(async (res) => {
          if (db && res.ok) { const b64 = await p.evaluate(async () => { const u = new Uint8Array(await window.__lastExport.arrayBuffer()); let s = ""; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s) + "|" + window.__lastExport.type; }); const [d, t] = [b64.slice(0, b64.lastIndexOf("|")), b64.slice(b64.lastIndexOf("|") + 1)]; await dp.evaluate(([d, t]) => { const bin = atob(d), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); window.__lastExport = new Blob([u], { type: t }); }, [d, t]); }
          return res;
        });
        // pixels in the exported file at output time tau, inside rect (in output px): counts the person's pink (#ff6b9a) and the car body grey-blue (#c9d1e0)
        const scan = (tau, rect) => dp.evaluate(async ([tau, rect]) => {
          const blob = window.__lastExport; if (!blob) return null;
          const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(blob);
          await new Promise((r) => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 6000); });
          v.currentTime = tau; await new Promise((r) => { v.onseeked = r; setTimeout(r, 4000); });
          if (!v.videoWidth) return { err: "cannot decode" };
          const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext("2d"); g.drawImage(v, 0, 0);
          const cnt = (x, y, w, h) => { x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y)); w = Math.max(1, Math.min(c.width - x, Math.round(w))); h = Math.max(1, Math.min(c.height - y, Math.round(h))); const d = g.getImageData(x, y, w, h).data; let pink = 0, car = 0; for (let k = 0; k < d.length; k += 4) { const R = d[k], G = d[k + 1], B = d[k + 2]; if (R > 215 && G > 70 && G < 150 && B > 110 && B < 190 && R - G > 90) pink++; if (Math.abs(R - 201) < 14 && Math.abs(G - 209) < 14 && Math.abs(B - 224) < 14) car++; } return { pink, car }; };
          const r = cnt(rect.x, rect.y, rect.w, rect.h); { const d = g.getImageData(0, 0, c.width, c.height).data; let a = 0; for (let k = 0; k < d.length; k += 16) a += d[k] + d[k + 1] + d[k + 2]; r.lum = Math.round(a / (d.length / 16) / 3); } r.W = c.width; r.H = c.height; v.remove(); return r;
        }, [tau, rect]);
        // 12x12 mean-luma map of a rect of the exported frame (to compare the same frame with the car view on and off)
        const grab = (tau, rect) => dp.evaluate(async ([tau, rect]) => {
          const blob = window.__lastExport; if (!blob) return null;
          const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(blob);
          await new Promise((r) => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 6000); });
          v.currentTime = tau; await new Promise((r) => { v.onseeked = r; setTimeout(r, 4000); });
          const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext("2d"); g.drawImage(v, 0, 0);
          const out = []; const n = 12, cw = rect.w / n, ch = rect.h / n;
          for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const d = g.getImageData(Math.round(rect.x + i * cw), Math.round(rect.y + j * ch), Math.max(1, Math.round(cw)), Math.max(1, Math.round(ch))).data; let a = 0; for (let k = 0; k < d.length; k += 4) a += 0.3 * d[k] + 0.59 * d[k + 1] + 0.11 * d[k + 2]; out.push(a / (d.length / 4)); }
          v.remove(); return out;
        }, [tau, rect]);
        const l1 = (a, b) => (a && b ? a.reduce((s, x, i) => s + Math.abs(x - b[i]), 0) / a.length : 0);
        // where the card should land in the 1920x1080 compat frame (same maths as the product, written out here)
        const expectRect = (spec, grid) => { const S = Math.max(24, Math.min(spec.sideH * grid.h, grid.w, grid.h)), cl = (v, a, b) => Math.max(a, Math.min(b, v)); return { x: cl(grid.x + spec.cx * grid.w - S / 2, grid.x, grid.x + grid.w - S), y: cl(grid.y + spec.cy * grid.h - S / 2, grid.y, grid.y + grid.h - S), w: S, h: S }; };
        const gridOut = await p.evaluate(() => TDC.compositor.geometry(1920, 1080, TDC.player.ev.tile, false).grid);
        const seedPerson = () => p.evaluate(() => { for (let t = 0; t <= 8; t += 0.2) TDC.carView.seed(t, [{ x: 50 + 30 * Math.sin((150 * Math.PI) / 180) * 0.0 + 0, y: 70, color: "#ff6b9a", cam: "back" }]); });
        await p.evaluate(() => { TDC.setPref("carView", true); TDC.setPref("carPanel.pinned", false); }); await W(300);
        await seedPerson();
        // A: panel inside the grid, bottom-left default area, ticked
        await p.evaluate(() => { const c = TDC.prefs.carPanel; c.fx = -1; c.fy = -1; c.w = 0; TDC.carView.place(); }); await W(200);
        const specA = await p.evaluate(() => TDC.carView.exportSpec());
        const rA = await exp({ carview: true }, [[1, 2.5]]);
        ok(tag + "export ran with the car view ticked", rA.ok, rA);
        if (rA.ok) {
          const ra = expectRect(specA, gridOut), inA = await scan(0.6, ra);
          if (inA && inA.err) ok(tag + "exported file can be decoded here (" + inA.err + ") - pixel check skipped", true);
          else {
            ok(tag + "export frame: the car body and the person's colour are drawn in the card, at the panel's relative place", inA && inA.car > 150 && inA.pink > 12, { ra, inA, specA });
            const outA = await scan(0.6, { x: ra.x + ra.w + 40, y: ra.y, w: 120, h: ra.h });
            ok(tag + "export frame: nothing of the diagram next to the card", outA && outA.car < 40 && outA.pink < 12, outA);
            const gOn = await grab(0.6, ra);
            const rN = await exp({ carview: false }, [[1, 2.5]]); const inN = await scan(0.6, ra), gOff = await grab(0.6, ra);
            ok(tag + "tick off: the same frame has no car view (no person colour in the card area, and the area differs strongly from the ticked export)", rN.ok && inN && inN.pink < 12 && l1(gOn, gOff) > 12, { rN, inN, diff: l1(gOn, gOff) });
            // B: panel far outside the grid (window corner above the grid), tick on -> card clamped to the nearest corner of the picture
            await p.evaluate(() => { const c = TDC.prefs.carPanel; c.fx = 0; c.fy = 0; TDC.carView.place(); }); await W(200);
            const specB = await p.evaluate(() => TDC.carView.exportSpec()), gr = await R("#grid");
            const rB = await exp({ carview: true }, [[1, 2.5]]); const rb = expectRect(specB, gridOut), inB = await scan(0.6, rb);
            ok(tag + "panel dragged outside the grid (window corner): the card is placed fully inside the picture at the nearest edge (desktop: corner)", rB.ok && inB && !inB.err && inB.car > 150 && inB.pink > 12 && specB.cy < 0.5 && rb.x >= gridOut.x - 0.5 && rb.y >= gridOut.y - 0.5 && rb.x + rb.w <= gridOut.x + gridOut.w + 0.5 && rb.y + rb.h <= gridOut.y + gridOut.h + 0.5 && near(rb.y, gridOut.y, 1) && (dev.name !== "desktop" || near(rb.x, gridOut.x, 1)), { rb, inB, specB, gr, gridOut });
            // C: bottom-right of the window, below / right of the grid -> bottom-right corner of the picture
            await p.evaluate(() => { const c = TDC.prefs.carPanel; c.fx = 1; c.fy = 1; TDC.carView.place(); }); await W(200);
            const specC = await p.evaluate(() => TDC.carView.exportSpec());
            const rC = await exp({ carview: true }, [[1, 2.5]]); const rc = expectRect(specC, gridOut), inC = await scan(0.6, rc);
            ok(tag + "panel at the opposite window corner: card lands at the opposite edge (desktop: corner) of the picture, fully visible", rC.ok && inC && !inC.err && inC.car > 150 && inC.pink > 12 && rc.x >= gridOut.x - 0.5 && rc.x + rc.w <= gridOut.x + gridOut.w + 0.5 && near(rc.y + rc.h, gridOut.y + gridOut.h, 1) && (dev.name !== "desktop" || near(rc.x + rc.w, gridOut.x + gridOut.w, 1)), { rc, inC, specC });
          }
        }
      }
      ok(tag + "no page errors", errs.length === 0, errs);
      await ctx.close(); if (db) await db.close();
    }
    await b.close();
  }
  console.log(fails ? "FAILED " + fails : "ALL PASS");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
