// Export panel (tag export-panel): Playwright WebKit + Chromium, desktop 1440x900 and phone 430x932 (touch).
//  - layout planner: Fill black area (1920x1080 letterbox), Add panel (grid unscaled + strip, even sizes), side strip for a tall grid, ticks off
//  - camera order: Match viewer (Current / Rear view / Mirrored bottom row) vs Standard fixed order, incl. the flipped bottom row
//  - encoder limits: X.plan falls back (size cap, hardware-aware thinner strip) with a visible note
//  - dialog: default (Fill when there is a black area, else Add panel), remembered choice, Include ticks, output-size read-out
//  - pixel checks on short synthetic exports (decoded in Chrome for WebKit): car view / HUD / map land in their rectangles, nothing there when ticked off
// Usage: BR=chromium|webkit node test/export-panel.js [url]   DEV=desktop|phone   NOEXPORT=1 skips the encode checks
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html", MOCK = process.env.MOCK || "/tmp/ho-mock";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
(async () => {
  const pw = require("playwright");
  if (!fs.existsSync(MOCK + "/TeslaCam")) execFileSync("python3", [path.join(__dirname, "../tools/make-mock-footage.py"), MOCK, "--jobs", "4"], { stdio: "inherit" });
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    const b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
    for (const dev of [{ name: "desktop", viewport: { width: 1440, height: 900 } }, { name: "phone", viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, userAgent: UA, deviceScaleFactor: 2 }].filter((d) => !process.env.DEV || d.name === process.env.DEV)) {
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
        await p.evaluate(() => TDC.ui.activate(TDC.library.events.find((e) => /Sentry/.test(e.source)))); await W(900);
        await p.evaluate(() => { TDC.player.pause(); TDC.reid.maybeEmbed = () => {}; TDC.setPref("mapTiles", false); });
      };
      await load();
      const ev = await p.evaluate(() => ({ tile: TDC.player.ev.tile, fps: TDC.player.ev.fps, dur: TDC.player.ev.duration }));
      console.log(tag + "event tile", JSON.stringify(ev));

      // ── 1. layout planner (pure geometry) ──
      const g = await p.evaluate(() => {
        const C = TDC.compositor, tile = TDC.player.ev.tile, all = { hud: true, map: true, car: true }, av = { hud: true, map: true }, evenOk = (l) => l.W % 2 === 0 && l.H % 2 === 0;
        const inside = (r, o) => r.x >= o.x - 1 && r.y >= o.y - 1 && r.x + r.w <= o.x + o.w + 1 && r.y + r.h <= o.y + o.h + 1;
        const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        const fill = C.layout({ mode: "fill", W: 1920, H: 1080, tile, exact: false, want: all, avail: av, time: true });
        const panel = C.layout({ mode: "panel", W: tile.w * 3, H: tile.h * 2, tile, exact: true, want: all, avail: av, time: true });
        const panelC = C.layout({ mode: "panel", W: 1920, H: 1080, tile, exact: false, want: all, avail: av, time: true });
        const tall = C.layout({ mode: "panel", W: 600, H: 1800, tile: { w: 200, h: 900 }, exact: true, want: all, avail: av, time: true });
        const none = C.layout({ mode: "panel", W: tile.w * 3, H: tile.h * 2, tile, exact: true, want: { hud: false, map: false, car: false }, avail: av, time: true });
        const fillNone = C.layout({ mode: "fill", W: 1920, H: 1080, tile, exact: false, want: { hud: false, map: false, car: false }, avail: av, time: true });
        const fillExact = C.layout({ mode: "fill", W: tile.w * 3, H: tile.h * 2, tile, exact: true, want: all, avail: av, time: true });
        const two = C.layout({ mode: "panel", W: tile.w * 3, H: tile.h * 2, tile, exact: true, want: { hud: false, map: true, car: true }, avail: av, time: true });
        const noAv = C.layout({ mode: "panel", W: tile.w * 3, H: tile.h * 2, tile, exact: true, want: all, avail: { hud: false, map: false }, time: true });
        const pan = (l) => ({ W: l.W, H: l.H, mode: l.mode, grid: l.grid, strip: l.strip, band: l.band, panels: l.panels.map((q) => ({ k: q.k, x: q.x, y: q.y, w: q.w, h: q.h })), note: l.note, even: evenOk(l) });
        const chk = (l) => { const ps = l.panels; return { in: ps.every((q) => inside(q, l.strip)), noOverlap: ps.every((a, i) => ps.every((c, j) => i === j || !overlap(a, c))), outsideGrid: ps.every((q) => !overlap(q, l.grid)) }; };
        return { tile, fill: pan(fill), fillChk: chk(fill), panel: pan(panel), panelChk: chk(panel), panelC: pan(panelC), panelCChk: chk(panelC), tall: pan(tall), tallChk: chk(tall), none: pan(none), fillNone: pan(fillNone), fillExact: pan(fillExact), two: pan(two), noAv: pan(noAv) };
      });
      const t3 = g.tile;
      ok(tag + "Fill black area: output stays 1920x1080, camera grid unchanged at the top, panels (HUD, map, car) sit inside the black strip, no overlaps", g.fill.W === 1920 && g.fill.H === 1080 && g.fill.mode === "fill" && g.fill.panels.map((q) => q.k).join() === "hud,map,car" && g.fillChk.in && g.fillChk.noOverlap && g.fillChk.outsideGrid && g.fill.strip.y >= g.fill.grid.h - 1, g.fill);
      ok(tag + "Fill black area keeps a time row at the top of the black strip", g.fill.band && g.fill.band.y >= g.fill.grid.h - 1 && g.fill.band.h >= 28 && g.fill.panels.every((q) => q.y >= g.fill.band.y + g.fill.band.h - 1), g.fill);
      ok(tag + "Add panel (original): the grid is native 3x2 tiles, unscaled, strip added below, even output size", g.panel.mode === "panel" && g.panel.grid.w === t3.w * 3 && g.panel.grid.h === t3.h * 2 && g.panel.grid.x === 0 && g.panel.grid.y === 0 && g.panel.W === t3.w * 3 && g.panel.H === t3.h * 2 + g.panel.strip.h && g.panel.strip.y === t3.h * 2 && g.panel.even && g.panel.strip.h >= 120 && g.panel.strip.h <= Math.round(t3.h * 2 * 0.35) + 2 && g.panelChk.in && g.panelChk.noOverlap && g.panelChk.outsideGrid, g.panel);
      ok(tag + "Add panel (compatible): 1920-wide grid unscaled, output taller than 1080-letterbox-free grid + strip, even", g.panelC.mode === "panel" && g.panelC.W === 1920 && g.panelC.grid.w === 1920 && g.panelC.H === g.panelC.grid.h + g.panelC.strip.h && g.panelC.even && g.panelCChk.in && g.panelCChk.outsideGrid, g.panelC);
      ok(tag + "tall grid: the strip goes at the side (output wider, same height)", g.tall.mode === "panel" && g.tall.H === 1800 && g.tall.W === 600 + g.tall.strip.w && g.tall.strip.x === 600 && g.tallChk.in && g.tallChk.noOverlap && g.tall.even, g.tall);
      ok(tag + "all ticks off: no strip, native size, no panels", g.none.W === t3.w * 3 && g.none.H === t3.h * 2 && !g.none.panels.length && g.fillNone.W === 1920 && g.fillNone.H === 1080 && !g.fillNone.panels.length, { none: g.none, fillNone: g.fillNone });
      ok(tag + "Fill on an output with no black area falls back to Add panel with a note", g.fillExact.mode === "panel" && /no black area/.test(g.fillExact.note || ""), g.fillExact);
      ok(tag + "only ticked + available panels are placed (HUD off -> map and car; nothing available -> none)", g.two.panels.map((q) => q.k).join() === "map,car" && g.noAv.panels.map((q) => q.k).join() === "car", { two: g.two.panels, noAv: g.noAv.panels });

      // ── 2. camera order: Match viewer vs Standard ──
      const ord = await p.evaluate(() => {
        const C = TDC.compositor, out = {};
        out.std = C.cameraOrder("standard");
        for (const c of ["current", "rear", "mirror"]) { TDC.layout.set(c); out[c] = C.cameraOrder("viewer"); }
        TDC.layout.set("current"); out.stdAfter = C.cameraOrder("standard");
        return out;
      });
      const G = ["left_pillar", "front", "right_pillar", "left_repeater", "back", "right_repeater"];
      ok(tag + "Standard fixed order is always the fixed grid and never flipped", JSON.stringify(ord.std.order) === JSON.stringify(G) && !ord.std.mirror.length && JSON.stringify(ord.stdAfter.order) === JSON.stringify(G), ord.std);
      ok(tag + "Match viewer: Current = fixed grid", JSON.stringify(ord.current.order) === JSON.stringify(G) && !ord.current.mirror.length, ord.current);
      ok(tag + "Match viewer: Rear view swaps the bottom repeaters (RR | rear | LR)", JSON.stringify(ord.rear.order) === JSON.stringify(["left_pillar", "front", "right_pillar", "right_repeater", "back", "left_repeater"]) && !ord.rear.mirror.length, ord.rear);
      ok(tag + "Match viewer: Mirrored bottom row = LR | rear | RR, bottom three flipped", JSON.stringify(ord.mirror.order) === JSON.stringify(G) && JSON.stringify(ord.mirror.mirror.sort()) === JSON.stringify(["back", "left_repeater", "right_repeater"]), ord.mirror);

      // ── 3. encoder limits (X.plan with a pretend VideoEncoder) ──
      const lim = await p.evaluate(async () => {
        const X = TDC.exporter, ev = TDC.player.ev, real = window.VideoEncoder, res = {};
        const fake = (rule) => { window.VideoEncoder = function () {}; window.VideoEncoder.isConfigSupported = async (cfg) => { const r = rule(cfg); return r ? { supported: true, config: { ...cfg, hardwareAcceleration: r } } : { supported: false, config: cfg }; }; };
        const show = { hud: true, map: true, carview: true, time: true }, so = X.sizeOptions(ev)[0];
        try {
          fake(() => "prefer-hardware");   // everything fits
          const a = await X.plan({ preset: "original", sizeId: "native", show, extras: { mode: "panel" }, order: "standard" }, ev);
          res.all = { W: a.pick.cand.W, H: a.pick.cand.H, tag: a.pick.cand.tag, note: a.note };
          fake((cfg) => (cfg.width * cfg.height <= so.W * so.H * 1.05 ? "prefer-hardware" : null));   // the plain grid fits, the strip does not, at any strip size
          const b = await X.plan({ preset: "original", sizeId: "native", show, extras: { mode: "panel" }, order: "standard" }, ev);
          res.capped = { W: b.pick.cand.W, H: b.pick.cand.H, tag: b.pick.cand.tag, note: b.note, mode: b.pick.cand.geo.mode };
          // hardware takes the plain grid + a thin strip, software would take the full strip
          const full = X.candidates({ preset: "original", sizeId: "native", show, extras: { mode: "panel" }, order: "standard" }, ev);
          const thinArea = full[1].W * full[1].H, fullArea = full[0].W * full[0].H;
          fake((cfg) => (cfg.width * cfg.height <= thinArea ? "prefer-hardware" : cfg.hardwareAcceleration === "prefer-hardware" ? null : "no-preference"));
          const c = await X.plan({ preset: "original", sizeId: "native", show, extras: { mode: "panel" }, order: "standard" }, ev);
          res.thin = { W: c.pick.cand.W, H: c.pick.cand.H, tag: c.pick.cand.tag, note: c.note, thinH: full[1].H, fullH: full[0].H, thinArea, fullArea };
          // nothing but 1920x1088 works
          fake((cfg) => (cfg.width <= 1920 && cfg.height <= 1088 ? "prefer-hardware" : null));
          const d0 = await X.plan({ preset: "original", sizeId: "native", show, extras: { mode: "panel" }, order: "standard" }, ev); void d0;
          const d = await X.plan({ preset: "original", sizeId: "native", show, extras: { mode: "panel" }, order: "standard" }, ev);
          res.small = { W: d.pick.cand.W, H: d.pick.cand.H, mode: d.pick.cand.geo.mode, note: d.note };
          fake(() => "prefer-hardware");
          const e = await X.plan({ preset: "compat", show, extras: { mode: "panel" }, order: "standard" }, ev);
          res.compat = { W: e.pick.cand.W, H: e.pick.cand.H, mode: e.pick.cand.geo.mode, note: e.note };
          fake((cfg) => (cfg.height <= 1080 ? "no-preference" : null));   // 1920x1080 only: panel strip too tall -> fill
          const f = await X.plan({ preset: "compat", show, extras: { mode: "panel" }, order: "standard" }, ev);
          res.compatCap = { W: f.pick.cand.W, H: f.pick.cand.H, mode: f.pick.cand.geo.mode, note: f.note };
        } finally { window.VideoEncoder = real; }
        return res;
      });
      ok(tag + "limits: when everything fits the full strip is used, no warning", lim.all.tag === "full" && !lim.all.note, lim.all);
      ok(tag + "limits: nothing past the plain grid is accepted -> falls back (never above the cap) and says so", lim.capped.W * lim.capped.H <= lim.thin.fullArea && lim.capped.tag !== "full" && /can't be encoded|thinner/.test(lim.capped.note || ""), lim.capped);
      ok(tag + "limits: hardware takes only a thin strip -> the strip is thinned (not software), with a warning", lim.thin.tag === "thin" && lim.thin.H === lim.thin.thinH && lim.thin.thinH < lim.thin.fullH && /thinner/.test(lim.thin.note || ""), lim.thin);
      ok(tag + "limits: a 1920x1088 ceiling -> a smaller picture, even size, note", lim.small.W <= 1920 && lim.small.H <= 1088 && lim.small.W % 2 === 0 && lim.small.H % 2 === 0 && !!lim.small.note, lim.small);
      ok(tag + "limits: compatible + Add panel keeps its taller picture when the encoder takes it", lim.compat.mode === "panel" && lim.compat.W === 1920 && lim.compat.H > 1080 - 400 && !lim.compat.note, lim.compat);
      ok(tag + "limits: compatible + Add panel with a 1080 ceiling -> back to Fill black area at 1920x1080", lim.compatCap.mode === "fill" && lim.compatCap.W === 1920 && lim.compatCap.H === 1080 && !!lim.compatCap.note, lim.compatCap);

      // ── 4. dialog ──
      const dlg = async () => p.evaluate(async () => {
        document.getElementById("btnExport").click(); await new Promise((r) => setTimeout(r, 700));
        const q = (id) => document.getElementById(id), seg = (id) => { const e = q(id).querySelector("button.on"); return e && e.dataset.v; };
        return { extras: seg("segExtras"), order: seg("segOrder"), hudWrap: q("exportHudWrap").hidden, mapWrap: q("exportMapWrap").hidden, carWrap: q("exportCarWrap").hidden, fillDisabled: q("segExtrasFill").disabled, line: q("exportSizeLine").textContent, extrasRowHidden: q("extrasRow").hidden, ordLabel: q("segOrder").querySelector('[data-v="viewer"]').textContent };
      });
      const waitLine = async (re) => { for (let i = 0; i < 40; i++) { const l = await p.evaluate(() => document.getElementById("exportSizeLine").textContent); if (re.test(l)) return l; await W(250); } return await p.evaluate(() => document.getElementById("exportSizeLine").textContent); };
      const closeDlg = () => p.evaluate(() => { document.getElementById("exportModal").hidden = true; });
      let d0 = await dlg(); d0.line = await waitLine(/^Output: 1920×1080/);
      ok(tag + "dialog default (Most Compatible): Fill black area is selected and Match viewer is the camera order", d0.extras === "fill" && d0.order === "viewer" && !d0.fillDisabled && /^Output: 1920×1080/.test(d0.line), d0);
      ok(tag + "dialog: the HUD tick is hidden when there is no telemetry, the car-view tick while the car view is off (the map tick stays: the event has a location)", d0.hudWrap && d0.carWrap && !d0.mapWrap, d0);
      ok(tag + "camera-order button names the viewer's layout", /Match viewer \(/.test(d0.ordLabel), d0.ordLabel);
      await closeDlg();
      // pretend telemetry + route; car view on
      await p.evaluate(() => {
        const T = TDC, tel = T.telemetry; tel.status = "ready"; const lat0 = 37.4, lon0 = -122.1; const pts = [];
        for (let i = 0; i < 80; i++) { const lat = lat0 + i * 0.00012, lon = lon0 + Math.sin(i / 9) * 0.0004 + i * 0.0001, m = tel.merc(lat, lon); pts.push({ t: i * 0.1, lat, lon, x: m[0], y: m[1], h: 40, ap: 0 }); }
        tel.route = () => pts; tel.at = () => ({ m: { speed: 14, gear: 4, brake: false, ap: 0, heading: 40, lat: lat0, lon: lon0 }, steer: 20, pedalPct: 35, litL: false, litR: false });
        tel.positionAt = (t) => { const i = Math.max(0, Math.min(pts.length - 1, Math.round(t * 10))); return pts[i]; };
        T.setPref("carView", true); T.emit("telemetry");
      });
      await W(500);
      let d1 = await dlg();
      ok(tag + "dialog: HUD, map and car-view ticks show when available / on", !d1.hudWrap && !d1.mapWrap && !d1.carWrap, d1);
      await closeDlg();
      // choose Add panel -> remembered across reload; Standard order remembered
      await p.evaluate(async () => { document.getElementById("btnExport").click(); await new Promise((r) => setTimeout(r, 400)); document.querySelector('#segExtras [data-v="panel"]').click(); document.querySelector('#segOrder [data-v="standard"]').click(); await new Promise((r) => setTimeout(r, 300)); });
      const remembered = await p.evaluate(() => JSON.parse(localStorage.getItem("tdc.prefs.v1")).export);
      ok(tag + "dialog: the chosen layout and camera order are saved as preferences", remembered.extras === "panel" && remembered.order === "standard", remembered);
      const lineP = await waitLine(/camera grid/);
      ok(tag + "dialog: the output size read-out shows the grown picture for Add panel", /^Output: 1920×\d+ — camera grid 1920×\d+ \+ \d+ px panel strip below for/.test(lineP), lineP);
      await closeDlg();
      // default again for the non-compat preset ("auto" choice): Add panel (no letterbox in the native grid)
      await p.evaluate(() => { TDC.setPref("export.extras", "auto"); TDC.setPref("export.order", "viewer"); TDC.setPref("advanced", true); document.body.classList.toggle("simple", false); });
      const dOrig = await p.evaluate(async () => { document.getElementById("btnExport").click(); await new Promise((r) => setTimeout(r, 500)); document.querySelector('input[name=preset][value=original]').click(); document.querySelector('input[name=preset][value=original]').dispatchEvent(new Event("change", { bubbles: true })); await new Promise((r) => setTimeout(r, 500)); const q = (id) => document.getElementById(id); const e = q("segExtras").querySelector("button.on"); return { extras: e && e.dataset.v, fillDisabled: q("segExtrasFill").disabled }; });
      dOrig.line = await waitLine(/camera grid/);
      ok(tag + "dialog default (Original resolution): no black area -> Add panel, Fill is disabled, size shows native grid + strip", dOrig.extras === "panel" && dOrig.fillDisabled && /camera grid \d+×\d+/.test(dOrig.line), dOrig);
      await p.evaluate(() => { document.querySelector('input[name=preset][value=equirect]').click(); });
      const dEq = { line: await waitLine(/2048/), rowHidden: await p.evaluate(() => document.getElementById("extrasRow").hidden) };
      ok(tag + "dialog: 360 export hides the layout choices and shows its fixed size", dEq.rowHidden && /2048×1024/.test(dEq.line), dEq);
      await closeDlg();
      await p.evaluate(() => { TDC.setPref("export.extras", "auto"); });
      ok(tag + "no page errors so far", errs.length === 0, errs);

      // ── 5. pixel checks on real (short) exports ──
      const cap = await p.evaluate(() => TDC.exporter.capability());
      if (process.env.NOEXPORT || cap.mode === "none") ok(tag + "export pixel checks skipped (" + (process.env.NOEXPORT ? "NOEXPORT" : "no encoder in this browser") + ")", true);
      else {
        const runExp = (o) => p.evaluate(async (o) => {
          try { const r = await TDC.exporter.run({ ranges: [[0, 1.2]], onStatus: () => {}, onProgress: () => {}, ...o, show: { labels: false, fsd: false, time: false, boxes: false, hud: false, map: false, carview: false, ...o.show } }); window.__lastExport = r.blob; return { ok: true, W: r.W, H: r.H, layout: r.layout, grid: r.grid, panels: r.panels, note: r.note || null, key: r.key }; }
          catch (e) { return { ok: false, err: String(e && e.message || e) }; }
        }, o).then(async (res) => {
          if (db && res.ok) { const b64 = await p.evaluate(async () => { const u = new Uint8Array(await window.__lastExport.arrayBuffer()); let s = ""; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s) + "|" + window.__lastExport.type; }); const [d, t] = b64.split("|"); await dp.evaluate(([d, t]) => { const bin = atob(d), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); window.__lastExport = new Blob([u], { type: t }); }, [d, t]); }
          return res;
        });
        // measure the decoded frame at tau: per rect pink (#ff6b9a person), car body (#c9d1e0), "lit" pixels (not black), plus 12x12 luma maps for cells
        const measure = (tau, rects, maps) => dp.evaluate(async ([tau, rects, maps]) => {
          const blob = window.__lastExport; if (!blob) return null;
          const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(blob);
          await new Promise((r) => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 6000); });
          v.currentTime = tau; await new Promise((r) => { v.onseeked = r; setTimeout(r, 4000); });
          if (!v.videoWidth) return { err: "cannot decode" };
          const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext("2d"); g.drawImage(v, 0, 0);
          const out = { W: c.width, H: c.height, rects: [], maps: [] };
          for (const r of rects) {
            const x = Math.max(0, Math.round(r.x)), y = Math.max(0, Math.round(r.y)), w = Math.max(1, Math.min(c.width - x, Math.round(r.w))), h = Math.max(1, Math.min(c.height - y, Math.round(r.h)));
            const d = g.getImageData(x, y, w, h).data; let pink = 0, car = 0, lit = 0;
            for (let k = 0; k < d.length; k += 4) { const R = d[k], G = d[k + 1], B = d[k + 2]; if (R > 220 && G > 80 && G < 140 && B > 120 && B < 190) pink++; if (Math.abs(R - 201) < 14 && Math.abs(G - 209) < 14 && Math.abs(B - 224) < 14) car++; if (R + G + B > 120) lit++; }
            out.rects.push({ pink, car, lit, n: d.length / 4 });
          }
          for (const r of maps) {
            const n = 12, cw = r.w / n, ch = r.h / n, m = [];
            for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const d = g.getImageData(Math.round(r.x + i * cw), Math.round(r.y + j * ch), Math.max(1, Math.round(cw)), Math.max(1, Math.round(ch))).data; let a = 0; for (let k = 0; k < d.length; k += 4) a += 0.3 * d[k] + 0.59 * d[k + 1] + 0.11 * d[k + 2]; m.push(a / (d.length / 4)); }
            out.maps.push(m);
          }
          v.remove(); return out;
        }, [tau, rects, maps || []]);
        await p.evaluate(() => { for (let t = 0; t <= 8; t += 0.2) TDC.carView.seed(t, [{ x: 50, y: 70, color: "#ff6b9a", cam: "back" }]); TDC.setPref("carView", true); TDC.setPref("carPanel.pinned", false); });
        const allOn = { hud: true, map: true, carview: true };

        // Fill black area (compatible 1920x1080)
        let r = await runExp({ preset: "compat", extras: { mode: "fill" }, order: "standard", show: allOn });
        ok(tag + "export Fill black area: 1920x1080, layout fill, panels in the strip", r.ok && r.W === 1920 && r.H === 1080 && r.layout === "fill" && r.panels.length === 3, r);
        if (r.ok) {
          const rects = r.panels.map((q) => ({ x: q.x, y: q.y, w: q.w, h: q.h })), car = r.panels.findIndex((q) => q.k === "car"), hud = r.panels.findIndex((q) => q.k === "hud"), map = r.panels.findIndex((q) => q.k === "map");
          const m = await measure(0.5, rects);
          ok(tag + "export Fill: the car view (car body + the coloured person) is drawn in the black area", m && m.rects && m.rects[car].car > 40 && m.rects[car].pink > 5, m);
          ok(tag + "export Fill: HUD and map are drawn in their rectangles (not black)", m && m.rects && m.rects[hud].lit > m.rects[hud].n * 0.05 && m.rects[map].lit > m.rects[map].n * 0.03, m);
          const over = await measure(0.5, [{ x: r.grid.x, y: r.grid.y, w: r.grid.w, h: r.grid.h }]);
          const base0 = await runExp({ preset: "compat", extras: { mode: "fill" }, order: "standard", show: {} }), baseM = base0.ok && await measure(0.5, [{ x: r.grid.x, y: r.grid.y, w: r.grid.w, h: r.grid.h }]);
          ok(tag + "export Fill: nothing floats on the camera grid (no person colour; the grid matches an export with nothing ticked)", over && over.rects && baseM && baseM.rects && over.rects[0].pink === 0 && Math.abs(over.rects[0].car - baseM.rects[0].car) < 300 && Math.abs(over.rects[0].lit - baseM.rects[0].lit) < 3000, { over, baseM });
        }
        // ticks off
        r = await runExp({ preset: "compat", extras: { mode: "fill" }, order: "standard", show: { hud: false, map: true, carview: false } });
        ok(tag + "export Fill with HUD and car view off: only the map is placed", r.ok && r.panels.length === 1 && r.panels[0].k === "map", r);
        if (r.ok) { const m = await measure(0.5, [{ x: 0, y: r.grid.h + 60, w: 600, h: 1080 - r.grid.h - 60 }]); ok(tag + "export Fill: the area where the HUD would be stays black when the HUD tick is off", m && m.rects && m.rects[0].lit < m.rects[0].n * 0.002, m); }
        r = await runExp({ preset: "compat", extras: { mode: "fill" }, order: "standard", show: { hud: false, map: false, carview: false } });
        if (r.ok) { const m = await measure(0.5, [{ x: 0, y: r.grid.h + 4, w: 1920, h: 1080 - r.grid.h - 4 }]); ok(tag + "export Fill with everything off: the black area is completely black", r.W === 1920 && r.H === 1080 && !r.panels.length && m && m.rects && m.rects[0].lit === 0, { r, m }); } else ok(tag + "export Fill with everything off ran", false, r);

        // Add panel (original, 50%) — the grid is scaled to 50% by the size choice; the strip is added below it
        const so = await p.evaluate(() => TDC.exporter.sizeOptions(TDC.player.ev).find((s) => s.id === "p50"));
        r = await runExp({ preset: "original", sizeId: "p50", codec: "h264", extras: { mode: "panel" }, order: "standard", show: allOn });
        ok(tag + "export Add panel (original 50%): the picture is grid " + so.W + "x" + so.H + " + a strip, even dimensions", r.ok && r.layout === "panel" && r.W === so.W && r.H > so.H && r.H % 2 === 0 && r.grid.w === so.W && r.grid.h === so.H, r);
        if (r.ok && r.layout === "panel") {
          const rects = r.panels.map((q) => ({ x: q.x, y: q.y, w: q.w, h: q.h })), car = r.panels.findIndex((q) => q.k === "car"), hud = r.panels.findIndex((q) => q.k === "hud"), map = r.panels.findIndex((q) => q.k === "map");
          const m = await measure(0.5, rects);
          ok(tag + "export Add panel: decoded size = planned size, car view / HUD / map are in the added strip", m && m.W === r.W && m.H === r.H && m.rects[car].car > 40 && m.rects[car].pink > 5 && m.rects[hud].lit > m.rects[hud].n * 0.05 && m.rects[map].lit > m.rects[map].n * 0.03, m);
        }
        r = await runExp({ preset: "original", sizeId: "p50", codec: "h264", extras: { mode: "panel" }, order: "standard", show: { hud: false, map: false, carview: false } });
        ok(tag + "export Add panel with every tick off: no strip, plain native-shape picture", r.ok && r.W === so.W && r.H === so.H && !r.panels.length, r);

        // Match viewer vs Standard: flipped / swapped bottom row
        const cells = (W, H) => [3, 4, 5].map((i) => ({ x: (i % 3) * (W / 3), y: H / 2, w: W / 3, h: H / 2 }));
        const bottom = async (layout, order) => {
          await p.evaluate((l) => TDC.layout.set(l), layout);
          const r = await runExp({ preset: "compat", extras: { mode: "overlay" }, order, show: {} });
          if (!r.ok) return { err: r };
          const m = await measure(0.4, cells(r.grid.w, r.grid.h).map((c) => ({ ...c, x: c.x + r.grid.x, y: c.y })), cells(r.grid.w, r.grid.h).map((c) => ({ ...c, x: c.x + r.grid.x, y: c.y })));
          return { r, m: m && m.maps };
        };
        const l1 = (a, b) => a.reduce((s, x, i) => s + Math.abs(x - b[i]), 0) / a.length;
        const flipMap = (a) => { const o = []; for (let j = 0; j < 12; j++) for (let i = 0; i < 12; i++) o.push(a[j * 12 + 11 - i]); return o; };
        const std = await bottom("current", "standard");
        if (!std.m) ok(tag + "order test: standard export ran", false, std);
        else {
          const diffLR = l1(std.m[0], std.m[2]);
          ok(tag + "order test premise: the left and right repeater pictures differ in the mock footage", diffLR > 3, diffLR);
          const cur = await bottom("current", "viewer"), rear = await bottom("rear", "viewer"), mir = await bottom("mirror", "viewer"), rearStd = await bottom("rear", "standard"), mirStd = await bottom("mirror", "standard");
          ok(tag + "Match viewer + Current layout = the Standard picture", cur.m && l1(cur.m[0], std.m[0]) < 3 && l1(cur.m[2], std.m[2]) < 3, cur.m && [l1(cur.m[0], std.m[0]), l1(cur.m[2], std.m[2])]);
          ok(tag + "Match viewer + Rear view: the left and right repeater pictures swap places", rear.m && l1(rear.m[0], std.m[2]) < 3 && l1(rear.m[2], std.m[0]) < 3 && l1(rear.m[0], std.m[0]) > 2, rear.m && [l1(rear.m[0], std.m[2]), l1(rear.m[2], std.m[0]), l1(rear.m[0], std.m[0])]);
          ok(tag + "Match viewer + Mirrored bottom row: each bottom picture is flipped left-right (like the viewer)", mir.m && [0, 1, 2].every((i) => l1(mir.m[i], flipMap(std.m[i])) < 3) && l1(mir.m[0], std.m[0]) > 2, mir.m && [0, 1, 2].map((i) => [l1(mir.m[i], flipMap(std.m[i])), l1(mir.m[i], std.m[i])]));
          ok(tag + "Standard fixed order ignores the viewer's Rear / Mirrored layout", rearStd.m && mirStd.m && [0, 1, 2].every((i) => l1(rearStd.m[i], std.m[i]) < 3 && l1(mirStd.m[i], std.m[i]) < 3), rearStd.m && mirStd.m && [0, 1, 2].map((i) => [l1(rearStd.m[i], std.m[i]), l1(mirStd.m[i], std.m[i])]));
        }
        await p.evaluate(() => TDC.layout.set("current"));
      }
      ok(tag + "no page errors", errs.length === 0, errs);
      await ctx.close(); if (db) await db.close();
    }
    await b.close();
  }
  console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASSED");
  process.exit(fails ? 1 : 0);
})();
