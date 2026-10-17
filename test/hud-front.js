// Regression: HUD, self-driving badge and time pill must stay visible (not hidden, non-zero, on top) in every view,
// not only "All cameras": one camera, a subset, front hidden, full screen, phone full screen + thumbnail strip,
// with a gold search box / detector boxes on the shown tile (.tile.find-on used to sit above the overlays).
// Also checks the export frame still burns them in. Usage: node test/hud-front.js [url] [shotDir]
const { chromium, webkit } = require("playwright"); const fs = require("fs"), path = require("path");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html", SHOTS = process.argv[3] || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) { if (!/2026-10-08_09-01-00/.test(q)) w(q); } else if (/\.(mp4|json)$/.test(f) && f !== "base.mp4") files.push(q); } })(process.env.FIXTURES || "/workspace/photo-samples/TeslaCam");
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? " " + JSON.stringify(x) : "")); if (!c) fails++; };
const HIT = "{ t: 4.0, cam: 'front', score: 0.9, conf: 0.9, label: 'car', det: true, box: { x: 0.4, y: 0.45, w: 0.2, h: 0.2 } }";
// [name, setup js, phoneOnly?]
const MODES = [
  ["all", "TDC.focus.grid()"],
  ["front", "TDC.focus.focus('front')"],
  ["back", "TDC.focus.focus('back')"],
  ["subset", "['left_pillar','right_pillar','left_repeater'].forEach((c) => TDC.focus.setHidden(c, true))"],
  ["no-front", "['front','left_pillar','right_pillar'].forEach((c) => TDC.focus.setHidden(c, true))"],
  ["fullscreen-front", "TDC.focus.fullscreen(true); TDC.focus.focus('front')"],
  ["search-hit-front", `TDC.search.phrase = 'car'; TDC.search.hits = [${HIT}]; TDC.search.renderHits(); TDC.search.openHit(TDC.search.hits[0])`],
  ["search-hit-fullscreen", `TDC.focus.fullscreen(true); TDC.search.phrase = 'car'; TDC.search.hits = [${HIT}]; TDC.search.renderHits(); TDC.search.openHit(TDC.search.hits[0])`],
  ["detector-boxes-front", "TDC.detect.boxesAt = () => [{ x: 0.3, y: 0.3, w: 0.4, h: 0.4, label: 'car', conf: 0.8 }]; TDC.focus.focus('front')"],
];
const RESET = "TDC.search.clear && TDC.search.clear(); TDC.focus.fullscreen(false); TDC.setPref('camsHidden', {}); TDC.focus.grid(); if (window.__boxesAt) TDC.detect.boxesAt = window.__boxesAt;";
const probe = () => {
  const stage = document.getElementById("stage").getBoundingClientRect(), out = {};
  for (const [k, id] of [["hud", "panel-hud"], ["fsd", "panel-fsd"], ["time", "stageTime"]]) {
    const el = document.getElementById(id), b = el.getBoundingClientRect(), cs = getComputedStyle(el);
    const cx = Math.min(Math.max(b.left + b.width / 2, stage.left + 1), stage.right - 1), cy = Math.min(Math.max(b.top + b.height / 2, stage.top + 1), stage.bottom - 1);
    const pe = el.style.pointerEvents; el.style.pointerEvents = "auto";   // the time pill is click-through; make it hit-testable for the check
    const top = document.elementFromPoint(cx, cy); el.style.pointerEvents = pe;
    const inside = b.left >= stage.left - 1 && b.top >= stage.top - 1 && b.right <= stage.right + 1 && b.bottom <= stage.bottom + 1;
    out[k] = { shown: !el.hidden && cs.display !== "none" && cs.visibility !== "hidden" && +cs.opacity > 0, w: Math.round(b.width), h: Math.round(b.height), inside, onTop: !!top && (top === el || el.contains(top)), top: top ? (top.id || top.className || top.tagName) : null };
  }
  out.findOn = [...document.querySelectorAll(".tile.find-on")].map((t) => t.dataset.cam);
  out.tiles = [...document.querySelectorAll(".tile:not(.off)")].map((t) => t.dataset.cam);
  return out;
};
(async () => {
  for (const [name, bt] of [["chromium", chromium], ["webkit", webkit]]) {
    if (process.env.BR && !process.env.BR.includes(name)) continue;
    const b = await bt.launch(name === "chromium" ? { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] } : {});
    for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844, isMobile: true }]) {
      const ctx = await b.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile && name === "chromium", hasTouch: !!vp.isMobile, deviceScaleFactor: vp.isMobile ? 2 : 1 });
      const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
      const tag = name + " " + (vp.isMobile ? "phone" : "desktop");
      await p.goto(URL_, { waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important}" });
      await p.setInputFiles("#fileInput", files);
      for (let i = 0; i < 80 && (await p.evaluate(() => TDC.library.events.length)) < 3; i++) await W(250);
      await p.evaluate(() => { TDC.ui.activate(TDC.library.events.find((e) => /18-22/.test(e.id))); TDC.prefs.show = { ...TDC.prefs.show, hud: true, fsd: true, time: true }; TDC.emit("prefs", "show"); });
      await W(1500); await p.evaluate(() => { TDC.player.seek(4); window.__boxesAt = TDC.detect && TDC.detect.boxesAt; if (TDC.focus.dismissHint) TDC.focus.dismissHint(); }); await W(700);
      for (const [mode, js] of MODES) {
        await p.evaluate((r) => eval(r), RESET); await W(250);
        await p.evaluate((js) => eval(js), js);
        await W(900); await p.evaluate(() => TDC.overlays.render()); await W(150);
        const r = await p.evaluate(probe);
        for (const k of ["hud", "fsd", "time"]) ok(`${tag} ${mode}: ${k} visible on top`, r[k].shown && r[k].w > 0 && r[k].h > 0 && r[k].inside && r[k].onTop, { ...r[k], findOn: r.findOn, tiles: r.tiles });
        if (SHOTS && /^(front|search-hit-front|search-hit-fullscreen|no-front)$/.test(mode)) await p.screenshot({ path: `${SHOTS}/hud-front-${name}-${vp.isMobile ? "phone" : "desktop"}-${mode}.png` });
      }
      // export burns HUD/badge/time in, whatever the live view is (still focused on the gold-boxed front tile)
      const ex = await p.evaluate(() => {
        const geo = TDC.compositor.geometry(1280, 720, { w: 1448, h: 938 });
        const draw = (show) => { const c = document.createElement("canvas"); c.width = 1280; c.height = 720; const x = c.getContext("2d"); TDC.compositor.drawFrame(x, geo, 4, {}, show); return x.getImageData(0, 0, 1280, 720).data; };
        const off = draw({ labels: false, hud: false, map: false, fsd: false, time: false });
        const res = {};
        for (const k of ["hud", "fsd", "time"]) { const on = draw({ labels: false, hud: false, map: false, fsd: false, time: false, [k]: true }); let n = 0; for (let i = 0; i < on.length; i += 16) if (on[i] !== off[i] || on[i + 1] !== off[i + 1]) n++; res[k] = n; }
        return res;
      });
      for (const k of ["hud", "fsd", "time"]) ok(`${tag} export burns ${k}`, ex[k] > 50, ex);
      ok(`${tag} no page errors`, errs.length === 0, errs.slice(0, 3));
      await ctx.close();
    }
    await b.close();
  }
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
