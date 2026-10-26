// Export cameras (tag export-cams): Playwright, chromium and webkit separately (BR=chromium|webkit), desktop and phone (390x844, touch).
//  - planner: grid shape for 1-6 cameras, native tile size / no letterbox / no overlap, extras in the free cell, 6 cameras = the old layout exactly
//  - camera order (Match viewer / Standard) and mirrored cameras are kept for any subset; file name suffix; normCams; native size options per shape
//  - dialog: Cameras row (chips, presets, Focused camera only when focused, last-camera guard, no-footage label, summary, layout picture,
//    360 hides the row, in-session memory only, mobile layout screenshot)
//  - real short exports (decoded in Chrome for WebKit, whose headless build cannot paint decoded video): every ticked camera lands in the right cell
//    at native size, the free cell holds the map / car view, only the ticked cameras are decoded, redaction / burned boxes get the moved cell rects,
//    all six passed explicitly = the default output
// Usage: BR=chromium|webkit node test/export-cams.js [url]   DEV=desktop|phone   NOEXPORT=1 skips encodes   SHOTS=dir for screenshots (mock data only)
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html", MOCK = process.env.MOCK || "/tmp/ho-mock", SHOTS = process.env.SHOTS || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 2500) : "")); if (!c) fails++; };
(async () => {
  const pw = require("playwright");
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  if (!fs.existsSync(MOCK + "/TeslaCam")) execFileSync("python3", [path.join(__dirname, "../tools/make-mock-footage.py"), MOCK, "--jobs", "4"], { stdio: "inherit" });
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    const b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
    for (const dev of [{ name: "desktop", viewport: { width: 1440, height: 900 } }, { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: UA, deviceScaleFactor: 2 }].filter((d) => !process.env.DEV || d.name === process.env.DEV)) {
      const tag = BR + " " + dev.name + ": ";
      const ctx = await b.newContext(dev); const p = await ctx.newPage(); const errs = [];
      let db = null, dp = p;   // headless WebKit cannot paint decoded video: decode the exported file in Chrome
      if (BR === "webkit") { db = await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] }); dp = await (await db.newContext()).newPage(); await dp.goto("about:blank"); }
      p.on("pageerror", (e) => errs.push(e.message));
      const load = async () => {
        await p.goto(URL_, { waitUntil: "load" });
        await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.prefs.v1"); });
        await p.reload({ waitUntil: "load" });
        await p.setInputFiles("#folderInput", MOCK + "/TeslaCam");
        for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 2; i++) await W(250);
        await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
        await p.evaluate(() => { TDC.ui.activate(TDC.library.events.find((e) => /Sentry/.test(e.source))); }); await W(1200);   // Sentry mock: front, rear, both repeaters (no pillars)
        await p.evaluate(() => { TDC.player.pause(); TDC.reid.maybeEmbed = () => {}; TDC.setPref("mapTiles", false); TDC.layout.set("current"); });
      };
      await load();

      // ── 1. planner (pure geometry) ──
      const g = await p.evaluate(() => {
        const C = TDC.compositor, X = TDC.exporter, tile = TDC.player.ev.tile, G = TDC.GRID, all = { hud: true, map: true, car: true }, av = { hud: true, map: true };
        const inside = (r, o) => r.x >= o.x - 1 && r.y >= o.y - 1 && r.x + r.w <= o.x + o.w + 1 && r.y + r.h <= o.y + o.h + 1;
        const overlap = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
        const res = { tile, shapes: {}, rows: [] };
        for (let n = 1; n <= 6; n++) {
          res.shapes[n] = C.shape(n, tile);
          const order = G.slice(0, n);
          for (const [label, o] of [["original-overlay", { mode: "overlay", W: 0, H: 0, exact: true }], ["original-panel", { mode: "panel", exact: true }], ["compat-fill", { mode: "fill", W: 1920, H: 1080, exact: false }], ["compat-panel", { mode: "panel", W: 1920, H: 1080, exact: false }], ["compat-overlay", { mode: "overlay", W: 1920, H: 1080, exact: false }]]) {
            const sh = C.shape(n, tile), oo = { ...o }; if (oo.exact) { oo.W = tile.w * sh.cols; oo.H = tile.h * sh.rows; }
            const l = C.layout({ ...oo, tile, want: all, avail: av, time: true, order, mirror: [] });
            const cells = order.map((c, i) => C.cellRect(l.grid, i, 0, l.cols, l.rows));
            const free = l.cols * l.rows > n ? C.cellRect(l.grid, n, 0, l.cols, l.rows) : null;
            const aspOk = cells.every((r) => Math.abs(r.w / r.h - tile.w / tile.h) < 0.01);
            res.rows.push({ n, label, W: l.W, H: l.H, even: l.W % 2 === 0 && l.H % 2 === 0, cols: l.cols, rows: l.rows, mode: l.mode, freeCell: !!l.freeCell,
              cellsInGrid: cells.every((r) => inside(r, l.grid)), gridInFrame: inside(l.grid, { x: 0, y: 0, w: l.W, h: l.H }),
              noOverlap: cells.every((a, i) => cells.every((c, j) => i === j || !overlap(a, c))), aspOk,
              nativeCell: o.exact ? Math.abs(cells[0].w - tile.w) < 1 && Math.abs(cells[0].h - tile.h) < 1 : null,
              fillsFrame: o.exact ? null : (Math.abs(l.grid.w - 1920) < 2 || Math.abs(l.grid.h - 1080) < 2) || l.mode === "panel",
              panelsInFree: free ? l.panels.every((q) => inside(q, free)) : null, panelsN: l.panels.length, panelsClear: l.panels.every((q) => cells.every((c) => !overlap(q, c))), panelsNoOverlap: l.panels.every((a, i) => l.panels.every((c, j) => i === j || !overlap(a, c))),
              strip: l.strip && !l.freeCell ? l.strip : null, hasFree: !!free });
          }
        }
        // six cameras: exactly the old layout (no shape fields needed)
        const old = C.geometry(1920, 1080, tile, false), neu = C.geometry(1920, 1080, tile, false, 3, 2);
        const lay6 = C.layout({ mode: "fill", W: 1920, H: 1080, tile, exact: false, want: all, avail: av, time: true }), lay6b = C.layout({ mode: "fill", W: 1920, H: 1080, tile, exact: false, want: all, avail: av, time: true, order: G.slice(), mirror: [] });
        const strip = (l) => JSON.stringify({ W: l.W, H: l.H, grid: l.grid, band: l.band, panels: l.panels, strip: l.strip });
        res.six = { geomSame: JSON.stringify(old) === JSON.stringify(neu), laySame: strip(lay6) === strip(lay6b), cellSame: JSON.stringify(C.cellRect({ x: 5, y: 7, w: 900, h: 600 }, 4, 0)) === JSON.stringify({ x: 5 + 300, y: 7 + 300, w: 300, h: 300 }), gapSame: JSON.stringify(C.cellRect({ x: 0, y: 0, w: 308, h: 202 }, 5, 4)) === JSON.stringify({ x: 2 * (100 + 4), y: 99 + 4, w: 100, h: 99 }) };
        // camera helpers
        res.norm = { none: X.normCams(undefined).length, empty: X.normCams([]).length, junk: X.normCams(["x"]).length, one: X.normCams(["back"]).join(), dup: X.normCams(["front", "front", "back"]).join(), sorted: X.normCams(["right_repeater", "front"]).join() };
        res.tags = { six: X.camsTag(G), none: X.camsTag(undefined), front: X.camsTag(["front"]), lp: X.camsTag(["left_pillar"]), three: X.camsTag(["front", "back", "left_pillar"]), five: X.camsTag(G.slice(0, 5)) };
        const evx = TDC.player.ev, nm = (cams) => X.fileName(evx, "original", { W: 10, H: 10 }, "h264", cams);
        res.names = { all: nm(undefined), six: nm(G), front: nm(["front"]), three: nm(["front", "back", "left_pillar"]) };
        // order / mirror for subsets under every viewer layout
        res.order = {};
        for (const lay of ["current", "rear", "mirror"]) {
          TDC.layout.set(lay);
          const full = X.layoutBase({ order: "viewer", show: {} }), part = X.layoutBase({ order: "viewer", show: {}, cams: ["back", "front", "left_repeater", "right_repeater"] }), std = X.layoutBase({ order: "standard", show: {}, cams: ["back", "left_repeater"] });
          res.order[lay] = { full: full.order, fullMirror: full.mirror, part: part.order, partMirror: part.mirror, std: std.order, stdMirror: std.mirror };
        }
        TDC.layout.set("current");
        // native size options follow the grid shape
        const s6 = X.sizeOptions(evx), s1 = X.sizeOptions(evx, C.shape(1, tile)), s3 = X.sizeOptions(evx, C.shape(3, tile));
        res.sizes = { six: s6[0], one: s1[0], three: s3[0], six75: s6.find((z) => z.id === "p75"), one75: s1.find((z) => z.id === "p75"), sixDefault: JSON.stringify(X.sizeOptions(evx)) === JSON.stringify(X.sizeOptions(evx, { cols: 3, rows: 2 })), oneMax: s1.find((z) => z.id === "max") };
        return res;
      });
      const t = g.tile, sh = g.shapes;
      ok(tag + "grid shape by count: 1 -> 1x1, 2 -> 2x1, 3 -> 2x2 (one free cell), 4 -> 2x2, 5 -> 3x2 (one free cell), 6 -> 3x2", [1, 2, 2, 2, 3, 3].every((c, i) => sh[i + 1].cols === c) && [1, 1, 2, 2, 2, 2].every((r, i) => sh[i + 1].rows === r), sh);
      for (const n of [1, 2, 3, 4, 5, 6]) {
        const rs = g.rows.filter((r) => r.n === n);
        ok(tag + n + " camera(s): even sizes, cells inside the grid, no overlap, tile shape kept (no stretching), grid inside the frame", rs.every((r) => r.even && r.cellsInGrid && r.noOverlap && r.aspOk && r.gridInFrame), rs.filter((r) => !(r.even && r.cellsInGrid && r.noOverlap && r.aspOk && r.gridInFrame)));
        ok(tag + n + " camera(s): Original = native tile size, no scaling; Compatible fills the frame (no extra letterbox)", rs.filter((r) => r.nativeCell !== null).every((r) => r.nativeCell) && rs.filter((r) => r.fillsFrame !== null).every((r) => r.fillsFrame), rs.filter((r) => r.nativeCell === false || r.fillsFrame === false));
        const fr = rs.filter((r) => r.hasFree && r.mode !== "overlay");
        if (n === 3 || n === 5) ok(tag + n + " cameras: the free cell holds HUD, map and car view (inside it, not on a camera), no strip added, output = the plain grid", fr.length === 3 && fr.every((r) => r.freeCell && r.panelsN === 3 && r.panelsInFree && r.panelsClear && r.panelsNoOverlap && !r.strip), fr);
        else ok(tag + n + " camera(s): no free cell, so Add panel adds the strip as before (strip outside the cameras) and nothing is placed on a camera", rs.filter((r) => r.mode === "panel").every((r) => r.strip && r.panelsClear && r.panelsNoOverlap), rs.filter((r) => r.mode === "panel"));
      }
      ok(tag + "six cameras: geometry, layout and cell rects are exactly the old ones (default output unchanged)", g.six.geomSame && g.six.laySame && g.six.cellSame && g.six.gapSame, g.six);
      ok(tag + "normCams: nothing / empty / junk = all six, unknown dropped, order = grid order, no duplicates", g.norm.none === 6 && g.norm.empty === 6 && g.norm.junk === 6 && g.norm.one === "back" && g.norm.dup === "front,back" && g.norm.sorted === "front,right_repeater", g.norm);
      ok(tag + "file name part: nothing for all six, 'front', 'left-pillar', '3cams', '5cams'", g.tags.six === "" && g.tags.none === "" && g.tags.front === "front" && g.tags.lp === "left-pillar" && g.tags.three === "3cams" && g.tags.five === "5cams", g.tags);
      ok(tag + "file name: all six = the old name, subsets get _front / _3cams after the trigger", g.names.all === g.names.six && !/_front_|_3cams_/.test(g.names.all) && /_sentry_front_original_/.test(g.names.front) && /_sentry_3cams_original_/.test(g.names.three), g.names);
      const GO = ["left_pillar", "front", "right_pillar", "left_repeater", "back", "right_repeater"];
      ok(tag + "Match viewer keeps the viewer's relative order for a subset (Current / Rear view / Mirrored bottom row) and only mirrors ticked cameras", JSON.stringify(g.order.current.part) === JSON.stringify(["front", "left_repeater", "back", "right_repeater"]) && JSON.stringify(g.order.rear.part) === JSON.stringify(["front", "right_repeater", "back", "left_repeater"]) && JSON.stringify(g.order.mirror.part) === JSON.stringify(["front", "left_repeater", "back", "right_repeater"]) && g.order.mirror.partMirror.slice().sort().join() === "back,left_repeater,right_repeater" && g.order.mirror.fullMirror.length === 3 && !g.order.current.partMirror.length && JSON.stringify(g.order.current.full) === JSON.stringify(GO), g.order);
      ok(tag + "Standard fixed order ignores the viewer layout for a subset", ["current", "rear", "mirror"].every((l) => JSON.stringify(g.order[l].std) === JSON.stringify(["left_repeater", "back"]) && !g.order[l].stdMirror.length), g.order);
      ok(tag + "native size options follow the cameras: 6 = 3x2 tiles as before, 1 camera = one tile, 3 cameras = 2x2; percentages scale the same; default arg unchanged", g.sizes.six.W === Math.round(t.w * 3 / 2) * 2 && g.sizes.six.H === Math.round(t.h * 2 / 2) * 2 && g.sizes.one.W === Math.round(t.w / 2) * 2 && g.sizes.one.H === Math.round(t.h / 2) * 2 && g.sizes.three.W === Math.round(t.w * 2 / 2) * 2 && g.sizes.three.H === Math.round(t.h * 2 / 2) * 2 && g.sizes.sixDefault && g.sizes.one75.W < g.sizes.one.W, g.sizes);

      // ── 2. dialog ──
      const q = (fn, ...a) => p.evaluate(fn, ...a);
      const openDlg = async () => { await q(() => { document.getElementById("exportModal").hidden = true; document.getElementById("btnExport").click(); }); await W(800); };
      const closeDlg = () => q(() => { document.getElementById("exportModal").hidden = true; });
      const state = () => q(() => {
        const e = (id) => document.getElementById(id), chips = [...document.querySelectorAll("#camGrid .cam-opt")];
        return { visible: !!e("camsBlock") && !e("camsBlock").hidden && e("camsBlock").offsetParent !== null, chips: chips.map((c) => ({ cam: c.dataset.cam, on: c.getAttribute("aria-checked") === "true", lock: c.getAttribute("aria-disabled") === "true", nofoot: !!c.querySelector(".cam-no"), role: c.getAttribute("role"), h: Math.round(c.getBoundingClientRect().height), w: Math.round(c.getBoundingClientRect().width) })),
          presets: [...document.querySelectorAll("#camPresets button")].map((c) => ({ id: c.dataset.preset, on: c.getAttribute("aria-pressed") === "true", h: Math.round(c.getBoundingClientRect().height) })), summary: e("camSummary").textContent, hint: e("camHint").textContent, line: e("exportSizeLine").textContent,
          cells: document.querySelectorAll("#camPreview .cp-cam").length, free: document.querySelectorAll("#camPreview .cp-free").length, panels: document.querySelectorAll("#camPreview .cp-panel").length, orig: e("originalDesc").textContent, size: e("exportSize").value, sizeOpts: [...e("exportSize").options].map((o) => o.textContent), scrollW: document.documentElement.scrollWidth, cardW: e("exportModal").querySelector(".modal-card").getBoundingClientRect().width };
      });
      const click = (sel) => q((s) => document.querySelector(s).click(), sel);
      const waitSum = async (re) => { for (let i = 0; i < 60; i++) { const [s, l] = await q(() => [document.getElementById("camSummary").textContent, document.getElementById("exportSizeLine").textContent]); if (re.test(s) && /^Output: \d/.test(l)) return s; await W(150); } return await q(() => document.getElementById("camSummary").textContent); };   // summary and picture follow the size plan, so wait for it
      await openDlg();
      await waitSum(/1920×1080/); let s0 = await state(); s0.summary = await waitSum(/1920×1080/);
      ok(tag + "dialog default: Cameras row visible, six chips all ticked (checkbox role), summary says all 6 cameras", s0.visible && s0.chips.length === 6 && s0.chips.every((c) => c.on && c.role === "checkbox") && /^Exporting all 6 cameras · 1920×1080/.test(s0.summary), s0);
      ok(tag + "chips follow the export order (Match viewer = the viewer's layout); presets All / Front only / Front + Rear / Sides, no Focused camera while nothing is focused; All is highlighted", s0.chips.map((c) => c.cam).join() === (await q(() => TDC.compositor.cameraOrder("viewer").order.join())) && s0.presets.map((x) => x.id).join() === "all,front,fr,sides" && s0.presets.find((x) => x.id === "all").on && s0.presets.filter((x) => x.on).length === 1, s0);
      ok(tag + "cameras with no footage in this event (pillars in the Sentry mock) are labelled 'No footage' but ticked by default", s0.chips.filter((c) => c.nofoot).map((c) => c.cam).sort().join() === "left_pillar,right_pillar" && s0.chips.filter((c) => c.nofoot).every((c) => c.on) && /no footage/.test(s0.hint), { chips: s0.chips, hint: s0.hint });
      ok(tag + "layout picture: six cells, no free cell", s0.cells === 6 && s0.free === 0, s0);
      ok(tag + "touch targets: chips and presets are at least 36 px tall" + (dev.name === "phone" ? " (44 on the phone)" : ""), s0.chips.every((c) => c.h >= (dev.name === "phone" ? 43 : 36)) && s0.presets.every((c) => c.h >= (dev.name === "phone" ? 43 : 22)), { chips: s0.chips.map((c) => c.h), presets: s0.presets.map((c) => c.h) });
      if (dev.name === "phone") ok(tag + "390 px layout: dialog fits the screen width, no horizontal scroll", s0.scrollW <= 392 && s0.cardW <= 391, { scrollW: s0.scrollW, cardW: s0.cardW });
      if (SHOTS) await p.screenshot({ path: SHOTS + "/" + BR + "-" + dev.name + "-1-default.png" });
      await click('#camPresets [data-preset="front"]');
      await waitSum(/^Exporting 1 of 6/); let s1 = await state(); s1.summary = await waitSum(/^Exporting 1 of 6/);
      ok(tag + "Front only: exactly the front chip ticked, summary '1 of 6 cameras (Front) · 1920×1080', one cell in the picture, preset highlighted", s1.chips.filter((c) => c.on).map((c) => c.cam).join() === "front" && /^Exporting 1 of 6 cameras \(Front\) · 1920×1080/.test(s1.summary) && s1.cells === 1 && s1.presets.find((x) => x.id === "front").on, s1);
      ok(tag + "last camera guard: the only ticked camera is locked (aria-disabled), clicking it does nothing and shows a hint", s1.chips.find((c) => c.cam === "front").lock, s1.chips);
      await q(() => document.querySelector('#camGrid [data-cam="front"]').click()); await W(200);
      let s1b = await state();
      ok(tag + "clicking the locked last camera keeps it ticked and explains why", s1b.chips.filter((c) => c.on).map((c) => c.cam).join() === "front" && /At least one camera/.test(s1b.hint), s1b);
      if (SHOTS) await p.screenshot({ path: SHOTS + "/" + BR + "-" + dev.name + "-2-front-only.png" });
      await click('#camPresets [data-preset="fr"]');
      await waitSum(/^Exporting 2 of 6/); let s2 = await state(); s2.summary = await waitSum(/^Exporting 2 of 6/);
      ok(tag + "Front + Rear: two chips, summary lists them in export order, 2 cells side by side", s2.chips.filter((c) => c.on).map((c) => c.cam).sort().join() === "back,front" && /^Exporting 2 of 6 cameras \((Front, Rear|Rear, Front)\)/.test(s2.summary) && s2.cells === 2, s2);
      await click('#camPresets [data-preset="sides"]');
      await waitSum(/^Exporting 4 of 6/); let s3 = await state(); s3.summary = await waitSum(/^Exporting 4 of 6/);
      ok(tag + "Sides: both pillars and both repeaters, 4 cells", s3.chips.filter((c) => c.on).map((c) => c.cam).sort().join() === "left_pillar,left_repeater,right_pillar,right_repeater" && s3.cells === 4, s3);
      // manual ticks: untick rear and left pillar from All -> 4; the picture shows 4 cells
      await click('#camPresets [data-preset="all"]');
      await q(() => { document.querySelector('#camGrid [data-cam="back"]').click(); });
      await q(() => { document.querySelector('#camGrid [data-cam="left_pillar"]').click(); });
      await waitSum(/^Exporting 4 of 6/); let s4 = await state(); s4.summary = await waitSum(/^Exporting 4 of 6/);
      ok(tag + "ticking a chip off updates the summary and picture; no preset matches so none is highlighted", s4.chips.filter((c) => !c.on).map((c) => c.cam).sort().join() === "back,left_pillar" && s4.cells === 4 && s4.presets.every((x) => !x.on) && /^Exporting 4 of 6/.test(s4.summary), s4);
      await q(() => { document.querySelector('#camGrid [data-cam="back"]').click(); });
      await waitSum(/^Exporting 5 of 6/); let s5 = await state(); s5.summary = await waitSum(/^Exporting 5 of 6/);
      ok(tag + "5 cameras: the picture shows one free cell holding the map (Add panel / Fill choices put it there) and the size line says so", s5.cells === 5 && s5.free === 1 && s5.panels >= 1 && /free spot of the camera grid/.test(s5.line), s5);
      if (SHOTS) await p.screenshot({ path: SHOTS + "/" + BR + "-" + dev.name + "-3-five-free-cell.png" });
      await click('#camPresets [data-preset="all"]');
      await q(() => { document.querySelector('#camGrid [data-cam="front"]').click(); document.querySelector('#camGrid [data-cam="left_pillar"]').click(); document.querySelector('#camGrid [data-cam="right_pillar"]').click(); });
      await waitSum(/^Exporting 3 of 6/); let s6 = await state(); s6.summary = await waitSum(/^Exporting 3 of 6/);
      ok(tag + "3 cameras: 2x2 with a free cell, map in it; summary names Rear, Left Repeater, Right Repeater", s6.cells === 3 && s6.free === 1 && s6.panels >= 1 && /free spot/.test(s6.line) && /Rear/.test(s6.summary), s6);
      if (SHOTS) await p.screenshot({ path: SHOTS + "/" + BR + "-" + dev.name + "-4-three.png" });
      // in-session memory: close and reopen keeps it
      await closeDlg(); await openDlg();
      let s7 = await state();
      ok(tag + "closing and reopening the dialog keeps this session's choice", s7.chips.filter((c) => c.on).length === 3 && s7.chips.filter((c) => c.on).every((c) => ["back", "left_repeater", "right_repeater"].includes(c.cam)), s7.chips);
      const stored = await q(() => JSON.stringify(localStorage));
      const pe = await q(() => JSON.stringify(TDC.prefs.export));
      ok(tag + "the choice is NOT saved in localStorage / preferences", !/cam/i.test(pe) && !/exportcams|camsel/i.test(stored), pe);
      // Original resolution: native size list follows the shape
      await q(() => { TDC.setPref("advanced", true); document.body.classList.remove("simple"); });
      await closeDlg(); await openDlg();
      await q(() => { const r = document.querySelector("input[name=preset][value=original]"); r.click(); r.dispatchEvent(new Event("change", { bubbles: true })); }); await W(700);
      const so = await state();
      ok(tag + "Original resolution with 3 cameras: size list and description are for a 2x2 grid", so.sizeOpts[0].includes(String(Math.round(t.w * 2 / 2) * 2) + "×" + String(Math.round(t.h * 2 / 2) * 2)) && /^3 cameras stitched pixel-for-pixel: /.test(so.orig), so);
      await click('#camPresets [data-preset="front"]');
      const so1 = await state();
      ok(tag + "Original resolution with the front camera only: the description and sizes are for one tile", /^The front camera pixel-for-pixel: /.test(so1.orig) && so1.sizeOpts[0].includes(String(Math.round(t.w / 2) * 2) + "×" + String(Math.round(t.h / 2) * 2)), so1);
      // 360 hides the row
      await q(() => { const r = document.querySelector("input[name=preset][value=equirect]"); r.click(); r.dispatchEvent(new Event("change", { bubbles: true })); }); await W(500);
      const s8 = await state();
      ok(tag + "360 equirect hides the Cameras row (it always needs all six)", !s8.visible && /2048×1024/.test(s8.line), s8);
      await q(() => { const r = document.querySelector("input[name=preset][value=compat]"); r.click(); r.dispatchEvent(new Event("change", { bubbles: true })); }); await W(500);
      ok(tag + "back on Most Compatible the row returns with the choice kept", (await state()).visible, null);
      await closeDlg();
      // Focused camera preset only while a camera is focused
      await q(() => { TDC.setPref("advanced", false); TDC.exportCams.reset(); TDC.focus.focus("back"); }); await W(300);
      await openDlg();
      const sf = await state();
      ok(tag + "Focused camera preset appears only while a camera is focused, and selects exactly it", sf.presets.some((x) => x.id === "focus"), sf.presets);
      await click('#camPresets [data-preset="focus"]');
      const sf2 = await state();
      ok(tag + "Focused camera = only the focused (rear) camera", sf2.chips.filter((c) => c.on).map((c) => c.cam).join() === "back", sf2.chips);
      await closeDlg(); await q(() => { TDC.focus.focus(null); TDC.exportCams.reset(); });
      await openDlg(); const sg = await state();
      ok(tag + "after Reset / no focus: Focused camera is gone again and all six are ticked", !sg.presets.some((x) => x.id === "focus") && sg.chips.every((c) => c.on), sg);
      await closeDlg();
      ok(tag + "no page errors so far", errs.length === 0, errs);
      // a fresh page load always starts with all six
      await load(); await openDlg(); const sh2 = await state();
      ok(tag + "after a reload the dialog starts with all six cameras again", sh2.chips.length === 6 && sh2.chips.every((c) => c.on), sh2.chips);
      await closeDlg();

      // ── 3. real short exports ──
      const cap = await p.evaluate(() => TDC.exporter.capability());
      if (process.env.NOEXPORT || cap.mode === "none") ok(tag + "export checks skipped (" + (process.env.NOEXPORT ? "NOEXPORT" : "no encoder in this browser") + ")", true);
      else {
        const runExp = (o) => p.evaluate(async (o) => {
          try { const r = await TDC.exporter.run({ ranges: [[0, 1.2]], onStatus: () => {}, onProgress: () => {}, ...o, show: { labels: false, fsd: false, time: false, boxes: false, hud: false, map: false, carview: false, ...o.show } }); window.__lastExport = r.blob; const u = new Uint8Array(await r.blob.arrayBuffer()); let mi = 0; for (let i = 4; i < u.length - 4; i++) if (u[i] === 0x6d && u[i + 1] === 0x64 && u[i + 2] === 0x61 && u[i + 3] === 0x74) { mi = i; break; } const h = await crypto.subtle.digest("SHA-256", u.subarray(mi)); return { ok: true, W: r.W, H: r.H, layout: r.layout, grid: r.grid, panels: r.panels, cams: r.cams, cols: r.cols, rows: r.rows, name: r.name, note: r.note || null, sha: [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("") }; }
          catch (e) { return { ok: false, err: String(e && e.message || e) }; }
        }, o).then(async (res) => {
          if (db && res.ok) { const b64 = await p.evaluate(async () => { const u = new Uint8Array(await window.__lastExport.arrayBuffer()); let s = ""; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s) + "|" + window.__lastExport.type; }); const [d, t2] = b64.split("|"); await dp.evaluate(([d, t2]) => { const bin = atob(d), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); window.__lastExport = new Blob([u], { type: t2 }); }, [d, t2]); }
          return res;
        });
        const measure = (tau, rects, maps) => dp.evaluate(async ([tau, rects, maps]) => {
          const blob = window.__lastExport; if (!blob) return null;
          const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(blob);
          await new Promise((r) => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 6000); });
          v.currentTime = tau; await new Promise((r) => { v.onseeked = r; setTimeout(r, 4000); });
          if (!v.videoWidth) return { err: "cannot decode" };
          const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; const g2 = c.getContext("2d"); g2.drawImage(v, 0, 0);
          const out = { W: c.width, H: c.height, rects: [], maps: [] };
          for (const r of rects) {
            const x = Math.max(0, Math.round(r.x)), y = Math.max(0, Math.round(r.y)), w = Math.max(1, Math.min(c.width - x, Math.round(r.w))), h = Math.max(1, Math.min(c.height - y, Math.round(r.h)));
            const d = g2.getImageData(x, y, w, h).data; let pink = 0, car = 0, lit = 0;
            for (let k = 0; k < d.length; k += 4) { const R = d[k], G = d[k + 1], B = d[k + 2]; if (R > 220 && G > 80 && G < 140 && B > 120 && B < 190) pink++; if (Math.abs(R - 201) < 14 && Math.abs(G - 209) < 14 && Math.abs(B - 224) < 14) car++; if (R + G + B > 120) lit++; }
            out.rects.push({ pink, car, lit, n: d.length / 4 });
          }
          for (const r of maps) {
            const n = 12, cw = r.w / n, ch = r.h / n, m = [];
            for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const d = g2.getImageData(Math.round(r.x + i * cw), Math.round(r.y + j * ch), Math.max(1, Math.round(cw)), Math.max(1, Math.round(ch))).data; let a = 0; for (let k = 0; k < d.length; k += 4) a += 0.3 * d[k] + 0.59 * d[k + 1] + 0.11 * d[k + 2]; m.push(a / (d.length / 4)); }
            out.maps.push(m);
          }
          v.remove(); return out;
        }, [tau, rects, maps || []]);
        const inFree = (r, o) => r.x >= o.x - 1 && r.y >= o.y - 1 && r.x + r.w <= o.x + o.w + 1 && r.y + r.h <= o.y + o.h + 1;
        const l1 = (a, b) => a.reduce((s, x, i) => s + Math.abs(x - b[i]), 0) / a.length;
        const flipMap = (a) => { const o = []; for (let j = 0; j < 12; j++) for (let i = 0; i < 12; i++) o.push(a[j * 12 + 11 - i]); return o; };
        const cellOf = (r, i) => { const w = r.grid.w / r.cols, h = r.grid.h / r.rows; return { x: r.grid.x + (i % r.cols) * w, y: r.grid.y + Math.floor(i / r.cols) * h, w, h }; };
        await p.evaluate(() => { for (let t2 = 0; t2 <= 8; t2 += 0.2) TDC.carView.seed(t2, [{ x: 50, y: 70, color: "#ff6b9a", cam: "back" }]); TDC.setPref("carView", true); TDC.setPref("carPanel.pinned", false); TDC.layout.set("current"); });
        const FOUR = ["front", "back", "left_repeater", "right_repeater"], base = { preset: "original", codec: "h264", sizeId: "native", extras: { mode: "overlay" }, order: "standard" };
        // reference: all six at native size (default path); cell i = T.GRID[i]
        const ref = await runExp({ ...base });
        const refM = ref.ok && (await measure(0.4, ["left_pillar", "front", "right_pillar", "left_repeater", "back", "right_repeater"].map((c, i) => cellOf(ref, i)), ["left_pillar", "front", "right_pillar", "left_repeater", "back", "right_repeater"].map((c, i) => cellOf(ref, i))));
        const refMap = (cam) => refM.maps[["left_pillar", "front", "right_pillar", "left_repeater", "back", "right_repeater"].indexOf(cam)];
        const refLuma = refM && refM.maps ? FOUR.map((c) => refMap(c).reduce((a, x) => a + x, 0) / 144) : [];
        ok(tag + "reference frames are real pictures (not black), so the cell comparisons below mean something", refLuma.length === 4 && refLuma.every((v) => v > 25), refLuma);
        ok(tag + "reference: all six cameras at native size, 3x2, default file name", ref.ok && ref.cols === 3 && ref.rows === 2 && ref.W === Math.round(t.w * 3 / 2) * 2 && ref.H === Math.round(t.h * 2 / 2) * 2 && !/_(front|\dcams)_/.test(ref.name) && refM && !refM.err, ref);
        const exp1 = await runExp({ ...base, cams: ["front", "back", "left_pillar", "left_repeater", "right_repeater"].slice(0, 0).concat(["right_repeater", "back", "front", "left_repeater"]) });   // unordered list on purpose
        const exp6 = await runExp({ ...base, cams: ["left_pillar", "front", "right_pillar", "left_repeater", "back", "right_repeater"] });
        ok(tag + "all six passed explicitly = the default output (same size, name, and the same encoded video bytes)", exp6.ok && exp6.W === ref.W && exp6.H === ref.H && exp6.name === ref.name && exp6.sha === ref.sha, { a: exp6, b: ref });
        const subsets = [["front"], ["front", "back"], ["front", "back", "left_repeater"], FOUR, ["front", "back", "left_repeater", "right_repeater", "left_pillar"]];
        for (const cams of subsets) {
          const n = cams.length, r = await runExp({ ...base, cams }), exp = TDCorder(cams);
          const shape = [[1, 1], [2, 1], [2, 2], [2, 2], [3, 2]][n - 1];
          ok(tag + n + " camera(s) [" + cams.join(",") + "]: exported at native size " + shape[0] + "x" + shape[1] + " cells, file name suffix, cameras in grid order", r.ok && r.cols === shape[0] && r.rows === shape[1] && r.W === Math.round(t.w * shape[0] / 2) * 2 && r.H === Math.round(t.h * shape[1] / 2) * 2 && JSON.stringify(r.cams) === JSON.stringify(exp) && (n === 1 ? /_sentry_front_original_/ : new RegExp("_sentry_" + n + "cams_original_")).test(r.name), r);
          const m = r.ok && (await measure(0.4, exp.map((c, i) => cellOf(r, i)), exp.map((c, i) => cellOf(r, i))));
          const good = m && m.maps && exp.every((c, i) => !FOUR.includes(c) || l1(m.maps[i], refMap(c)) < 3);
          ok(tag + n + " camera(s): every ticked camera's picture is in its cell (same pixels as in the six-camera export, native size)", !!good, m && m.maps && exp.map((c, i) => [c, FOUR.includes(c) ? l1(m.maps[i], refMap(c)) : null]));
          if (n === 5 || n === 3) {
            const free = cellOf(r, n);
            const mm = await measure(0.4, [free], []);
            ok(tag + n + " cameras, nothing else ticked: the free cell stays black (no extras)", mm && mm.rects && mm.rects[0].lit / mm.rects[0].n < 0.01, mm);
          }
        }
        // camera without footage keeps today's placeholder only when ticked
        const pl = await runExp({ ...base, cams: ["front", "left_pillar"] }), plM = pl.ok && (await measure(0.4, [cellOf(pl, 0), cellOf(pl, 1)], []));
        ok(tag + "a ticked camera without footage keeps the 'No … footage' placeholder cell (dark, not the picture); unticked it is gone", pl.ok && plM && plM.rects && plM.rects[0].lit / plM.rects[0].n < 0.2 && plM.rects[1].lit / plM.rects[1].n > 0.3 && JSON.stringify(pl.cams) === JSON.stringify(["left_pillar", "front"]), plM);
        // free cell holds the map + car view (3 cameras, Add panel & Fill black area), overlays off the cameras
        for (const mode of ["panel", "fill"]) {
          const three = ["front", "back", "left_repeater"], r = await runExp({ ...base, preset: "compat", cams: three, extras: { mode }, show: { map: true, carview: true } });
          const free = r.ok && r.cols === 2 ? cellOf(r, 3) : null, pc = r.ok && r.panels.find((x) => x.k === "car"), pm = r.ok && r.panels.find((x) => x.k === "map"), mm = pc && pm && (await measure(0.4, [pc, pm, cellOf(r, 0)], []));
          ok(tag + "3 cameras, " + mode + ": output stays 1920x1080, map + car view are drawn inside the free cell (lit, car pink)", r.ok && r.W === 1920 && r.H === 1080 && r.layout === "fill" && !!free && inFree(pc, free) && inFree(pm, free) && mm && mm.rects && mm.rects[0].car > 40 && mm.rects[0].pink > 5 && mm.rects[1].lit / mm.rects[1].n > 0.01 && mm.rects[2].pink === 0, { r, mm });
          if (SHOTS && mode === "panel") { await dp.evaluate(async () => { const v = document.createElement("video"); v.muted = true; v.src = URL.createObjectURL(window.__lastExport); await new Promise((q2) => { v.onloadeddata = q2; setTimeout(q2, 5000); }); v.currentTime = 0.4; await new Promise((q2) => { v.onseeked = q2; setTimeout(q2, 3000); }); const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext("2d").drawImage(v, 0, 0); window.__shot = c.toDataURL("image/png"); }); const du = await dp.evaluate(() => window.__shot); fs.writeFileSync(SHOTS + "/" + BR + "-" + dev.name + "-export-3cams-freecell.png", Buffer.from(du.split(",")[1], "base64")); }
        }
        // 5 cameras in the compatible preset with extras in the free cell
        const r5 = await runExp({ ...base, preset: "compat", cams: ["left_pillar", "front", "back", "left_repeater", "right_repeater"], extras: { mode: "panel" }, show: { map: true, carview: true } });
        const pc5 = r5.ok && r5.panels.find((x) => x.k === "car"), pm5 = r5.ok && r5.panels.find((x) => x.k === "map"), m5 = pc5 && pm5 && (await measure(0.4, [pc5, pm5], []));
        ok(tag + "5 cameras (compatible): the sixth slot carries the map + car view, still exactly 1920x1080", r5.ok && r5.W === 1920 && r5.H === 1080 && inFree(pc5, cellOf(r5, 5)) && inFree(pm5, cellOf(r5, 5)) && m5 && m5.rects && m5.rects[0].car > 40 && m5.rects[0].pink > 5 && m5.rects[1].lit / m5.rects[1].n > 0.01, { r5, m5 });
        // 1 or 4 cameras (4:3 grid in a 16:9 frame): the side areas hold the panels, grid flush left, nothing added below
        for (const cams of [["front"], FOUR]) {
          const r = await runExp({ ...base, preset: "compat", cams, extras: { mode: "fill" }, show: { map: true, carview: true } });
          const reg = r.ok && { x: r.grid.w, y: 0, w: 1920 - r.grid.w, h: 1080 }, pc = r.ok && r.panels.find((x) => x.k === "car"), pm = r.ok && r.panels.find((x) => x.k === "map"), mm = pc && pm && (await measure(0.4, [pc, pm], []));
          ok(tag + cams.length + " camera(s), Fill black area: 1920x1080, grid flush left at its own shape, map + car view in the side area (not on a camera), car pink", r.ok && r.W === 1920 && r.H === 1080 && r.layout === "fill" && r.grid.x === 0 && r.grid.h === 1080 && r.grid.w < 1900 && !!pc && !!pm && inFree(pc, reg) && inFree(pm, reg) && mm && mm.rects && mm.rects[0].car > 40 && mm.rects[0].pink > 5 && mm.rects[1].lit / mm.rects[1].n > 0.01, { r, mm });
          const pr = await runExp({ ...base, preset: "compat", cams, extras: { mode: "panel" }, show: { map: true, carview: true } });
          ok(tag + cams.length + " camera(s), Add panel: the output grows with a strip as before (grid keeps its 1920-wide shape)", pr.ok && pr.layout === "panel" && pr.W >= 1920 && pr.H > 1080, pr);
        }
        // order & mirror in a subset (Rear view swaps the repeaters; Mirrored bottom row flips the bottom three)
        const std = await runExp({ ...base, cams: ["front", "back", "left_repeater", "right_repeater"] }), stdM = std.ok && (await measure(0.4, [0, 1, 2, 3].map((i) => cellOf(std, i)), [0, 1, 2, 3].map((i) => cellOf(std, i))));
        const sub = ["front", "left_repeater", "right_repeater"];
        await p.evaluate(() => TDC.layout.set("rear"));
        const rear = await runExp({ ...base, order: "viewer", cams: sub }), rearM = rear.ok && (await measure(0.4, [0, 1, 2].map((i) => cellOf(rear, i)), [0, 1, 2].map((i) => cellOf(rear, i))));
        const stdMap = (cam) => stdM.maps[std.cams.indexOf(cam)];
        ok(tag + "Match viewer + Rear view with a subset: cells are front, right repeater, left repeater (relative order of the viewer kept)", rear.ok && JSON.stringify(rear.cams) === JSON.stringify(["front", "right_repeater", "left_repeater"]) && rearM && l1(rearM.maps[0], stdMap("front")) < 3 && l1(rearM.maps[1], stdMap("right_repeater")) < 3 && l1(rearM.maps[2], stdMap("left_repeater")) < 3, rear.cams);
        await p.evaluate(() => TDC.layout.set("mirror"));
        const mir = await runExp({ ...base, order: "viewer", cams: sub }), mirM = mir.ok && (await measure(0.4, [0, 1, 2].map((i) => cellOf(mir, i)), [0, 1, 2].map((i) => cellOf(mir, i))));
        ok(tag + "Match viewer + Mirrored bottom row with a subset: front as is, both repeaters flipped left-right", mir.ok && mirM && l1(mirM.maps[0], stdMap("front")) < 3 && l1(mirM.maps[1], flipMap(stdMap("left_repeater"))) < 3 && l1(mirM.maps[2], flipMap(stdMap("right_repeater"))) < 3 && l1(mirM.maps[1], stdMap("left_repeater")) > 1.5, mirM && [l1(mirM.maps[0], stdMap("front")), l1(mirM.maps[1], flipMap(stdMap("left_repeater"))), l1(mirM.maps[2], flipMap(stdMap("right_repeater"))), l1(mirM.maps[1], stdMap("left_repeater"))]);
        await p.evaluate(() => TDC.layout.set("current"));
        // burned boxes / redaction / car view get the moved cell rectangles
        const lineup = await p.evaluate(async () => {
          const T = TDC, rec = { box: [], red: [], car: [] }, ob = T.burnBoxes && T.burnBoxes.draw, or = T.redact && T.redact.burn, oc = T.carView && T.carView.drawExport;
          if (ob) T.burnBoxes.draw = function (ctx, cam, t2, r, w, h) { rec.box.push({ cam, r: { x: r.x, y: r.y, w: r.w, h: r.h } }); return ob.apply(this, arguments); };
          if (or) T.redact.burn = function (ctx, cam, t2, r) { rec.red.push({ cam, r: { x: r.x, y: r.y, w: r.w, h: r.h } }); return or.apply(this, arguments); };
          if (oc) T.carView.drawExport = function (ctx, grid) { rec.car.push({ x: grid.x, y: grid.y, w: grid.w, h: grid.h }); return oc.apply(this, arguments); };
          try {
            const r = await T.exporter.run({ preset: "original", codec: "h264", sizeId: "native", extras: { mode: "overlay" }, order: "standard", cams: ["front", "back", "left_repeater"], ranges: [[0, 0.4]], onStatus: () => {}, onProgress: () => {}, show: { boxes: true, carview: true, labels: false, fsd: false, time: false, hud: false, map: false } });
            return { ok: true, rec, grid: r.grid, cols: r.cols, rows: r.rows, cams: r.cams };
          } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
          finally { if (ob) T.burnBoxes.draw = ob; if (or) T.redact.burn = or; if (oc) T.carView.drawExport = oc; }
        });
        const cellsOf = (r) => r.cams.map((c, i) => ({ cam: c, ...(() => { const w = r.grid.w / r.cols, h = r.grid.h / r.rows; return { x: r.grid.x + (i % r.cols) * w, y: r.grid.y + Math.floor(i / r.cols) * h, w, h }; })() }));
        const near = (a, b) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1;
        ok(tag + "burned-in boxes, redaction and the car view are given the moved cell / grid rectangles of the ticked cameras only", lineup.ok && lineup.cams.join() === "front,left_repeater,back" && lineup.rec.box.length > 0 && lineup.rec.box.every((x) => lineup.cams.includes(x.cam) && near(x.r, cellsOf(lineup).find((c) => c.cam === x.cam))) && new Set(lineup.rec.box.map((x) => x.cam)).size === 3 && (lineup.rec.red.length === 0 || lineup.rec.red.every((x) => lineup.cams.includes(x.cam) && near(x.r, cellsOf(lineup).find((c) => c.cam === x.cam)))) && lineup.rec.car.length > 0 && lineup.rec.car.every((x) => near(x, lineup.grid)), lineup);
        // only the ticked cameras are decoded
        const dec = await p.evaluate(async () => {
          const Orig = window.VideoDecoder; let n = 0; window.VideoDecoder = class extends Orig { constructor(i) { super(i); n++; } };
          const run = async (cams) => { n = 0; const o = { preset: "original", codec: "h264", sizeId: "p50", extras: { mode: "overlay" }, order: "standard", ranges: [[0, 0.4]], onStatus: () => {}, onProgress: () => {}, show: { boxes: false, labels: false, fsd: false, time: false, hud: false, map: false } }; if (cams) o.cams = cams; await TDC.exporter.run(o); return n; };
          try { const all = await run(null), front = await run(["front"]), two = await run(["front", "back"]), nofoot = await run(["left_pillar", "front"]); return { all, front, two, nofoot }; } catch (e) { return { err: String(e.message || e) }; } finally { window.VideoDecoder = Orig; }
        });
        ok(tag + "only the ticked cameras are decoded: all six = 4 decoders (4 cameras have footage), Front only = 1, Front + Rear = 2, a ticked camera without footage costs none", dec.all === 4 && dec.front === 1 && dec.two === 2 && dec.nofoot === 1, dec);
        // default dialog path untouched: run() without cams = all cameras
        ok(tag + "no page errors", errs.length === 0, errs);
      }
      await ctx.close(); if (db) await db.close();
    }
    await b.close();
  }
  function TDCorder(cams) { const G = ["left_pillar", "front", "right_pillar", "left_repeater", "back", "right_repeater"]; return G.filter((c) => cams.includes(c)); }
  console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASSED");
  process.exit(fails ? 1 : 0);
})();
