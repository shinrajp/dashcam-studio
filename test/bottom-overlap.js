// bottom-overlap (tag tap-redact): the Redact button (#rdBtn) must not make the bottom of the window taller or wider, must not push the page past the viewport, and
// nothing in the bottom-right corner may sit on top of anything else (Redact / Search buttons, draw bar, Redact panel, toast, camera bar, transport controls, Full screen).
//   Playwright, BR=chromium|webkit, mock footage (tools/make-mock-footage.py -> /tmp/ho-mock). Common Mac Safari window sizes + phone portrait / landscape.
//   For every size and state (idle, Redact panel open, tap-a-camera pick, drawing with a box + a long toast):
//     1. the page does not scroll: scrollWidth <= innerWidth, scrollTo(max) leaves scrollX at 0; desktop also scrollHeight <= innerHeight and scrollY 0
//        (phones: the closed "more controls" sheet below the screen has always made the document taller; printed as INFO, and check 2 holds it unchanged)
//     2. the bottom bar is exactly as tall as with the Redact button taken out (display: none), and the page is not wider / taller than without it
//     3. every visible control of the bottom bar is inside the window, and no two of the bottom-right items overlap (bounding boxes, ancestors excluded)
//   SHOTS=dir writes screenshots.  Usage: BR=chromium|webkit node test/bottom-overlap.js   SIZES='[["name",w,h,touch],...]' to pick sizes
const fs = require("fs"), path = require("path"), http = require("http"), { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/ho-mock", PORT = +(process.env.PORT || 8805), SHOTS = process.env.SHOTS || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 900) : "")); if (!c) fails++; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".onnx": "application/octet-stream", ".wasm": "application/wasm" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html"; fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; r.end(); return; } r.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }).listen(PORT, "127.0.0.1", () => res(s)); });
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const SIZES = process.env.SIZES ? JSON.parse(process.env.SIZES) : [
  ["1280x720", 1280, 720, 0], ["1440x800", 1440, 800, 0], ["1024x700", 1024, 700, 0], ["1152x720", 1152, 720, 0], ["1200x700", 1200, 700, 0], ["1512x982", 1512, 982, 0],
  ["390x844", 390, 844, 1], ["844x390", 844, 390, 1], ["360x640", 360, 640, 1]];

// what is where, measured inside the page. Only things you can see; fixed / absolute / transport children.
const MEASURE = () => {
  const vw = innerWidth, vh = innerHeight, de = document.documentElement;
  const shown = (e) => { if (!e || e.hidden) return false; const r = box(e), cs = getComputedStyle(e); return r.r - r.l > 1 && r.b - r.t > 1 && cs.display !== "none" && cs.visibility !== "hidden" && +cs.opacity > 0.05; };
  const box = (e) => { const r0 = e.getBoundingClientRect(), r = { left: r0.left, top: r0.top, right: r0.right, bottom: r0.bottom };
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) { const cs = getComputedStyle(a); if (cs.overflowX !== "visible" || cs.overflowY !== "visible") { const q = a.getBoundingClientRect(); r.left = Math.max(r.left, q.left); r.top = Math.max(r.top, q.top); r.right = Math.min(r.right, q.right); r.bottom = Math.min(r.bottom, q.bottom); } }   // what a scrolling strip clips is not on screen
    if (r.right < r.left) r.right = r.left; if (r.bottom < r.top) r.bottom = r.top; return { l: Math.round(r.left * 10) / 10, t: Math.round(r.top * 10) / 10, r: Math.round(r.right * 10) / 10, b: Math.round(r.bottom * 10) / 10 }; };
  const name = (e) => (e.id ? "#" + e.id : e.tagName.toLowerCase() + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/)[0] : "") + (e.dataset && e.dataset.show ? "[" + e.dataset.show + "]" : ""));
  const items = [];
  const add = (e, grp) => { if (shown(e)) items.push(Object.assign({ n: name(e), g: grp, el: e }, box(e))); };
  ["rdBtn", "usBtn", "crBar", "usPanel", "btnFullscreen", "chipCamBar"].forEach((id) => add(document.getElementById(id), "main"));
  const toast = document.getElementById("toast"); if (toast && toast.classList.contains("show")) add(toast, "main");
  document.querySelectorAll(".stage-bar").forEach((e) => add(e, "main"));
  document.querySelectorAll(".tp-controls button, .tp-controls select, .tp-controls .chip, #clockLabel").forEach((e) => { if (!items.some((i) => i.el === e)) add(e, "tp"); });
  const tp = document.getElementById("transport"), tr = tp ? box(tp) : null;
  const clipped = items.filter((i) => i.g === "tp" && (i.r > vw + 1 || i.b > vh + 1 || i.l < -1) && getComputedStyle(i.el.closest(".tp-controls") || document.body).overflowX !== "auto").map((i) => i.n + "@" + Math.round(i.r));
  const hits = [];
  for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
    const x = items[a], y = items[b]; if (x.el.contains(y.el) || y.el.contains(x.el)) continue;
    if (x.g === "tp" && y.g === "tp" && !(x.n !== y.n)) continue;
    const w = Math.min(x.r, y.r) - Math.max(x.l, y.l), h = Math.min(x.b, y.b) - Math.max(x.t, y.t);
    if (w > 2 && h > 2) hits.push(x.n + " x " + y.n + " (" + Math.round(w) + "x" + Math.round(h) + ")");
  }
  scrollTo(99999, 99999); const sx = scrollX, sy = scrollY; scrollTo(0, 0);
  return { vw, vh, sw: de.scrollWidth, sh: de.scrollHeight, sx, sy, tp: tr, tph: tr ? Math.round(tr.b - tr.t) : 0, clipped, hits, rd: items.find((i) => i.n === "#rdBtn") ? true : false };
};
const withoutRd = (p, f) => p.evaluate(() => { const e = document.getElementById("rdBtn"); e.dataset.dsp = e.style.display; e.style.setProperty("display", "none", "important"); window.dispatchEvent(new Event("resize")); }).then(() => W(250)).then(f).then(async (r) => { await p.evaluate(() => { const e = document.getElementById("rdBtn"); e.style.display = e.dataset.dsp || ""; window.dispatchEvent(new Event("resize")); }); await W(250); return r; });

async function open(p) {
  await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1`, { waitUntil: "load" });
  await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.prefs.v1"); localStorage.removeItem("tdc.regions.v1"); localStorage.removeItem("tdc.search.v1"); });
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events.find((e) => e.cams.length === 6) || TDC.library.events[0]); }); await W(1800);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); });
}
const state = {
  idle: async (p) => { await p.evaluate(() => TDC.toast("Saved. A long message to see that it never sits on the buttons in the corner.", "ok", 60000)); await W(500); },
  panel: async (p) => { await p.evaluate(() => { TDC.toast("Hello from the corner, a longer message than usual", "ok", 60000); TDC.searchUI.show(false, "redact"); }); await W(900); },
  pick: async (p) => { await p.evaluate(() => { TDC.regions.UI.cancel(); TDC.searchUI.hide(); TDC.focus.grid && TDC.focus.grid(); TDC.regions.UI.draw(true); TDC.toast("Tap the camera you want to redact, and a longer text", "ok", 60000); }); await W(900); },
  drawing: async (p) => { await p.evaluate(() => { TDC.regions.UI.cancel(); TDC.searchUI.hide(); TDC.focus.focus("front"); TDC.regions.UI.draw(); }); await W(700);
    await p.evaluate(() => { const S = TDC.regions.ui; S.draft = { shape: "rect", x: .3, y: .3, w: .3, h: .25 }; S.drawing = false; TDC.regions.UI.sync(); TDC.toast("Shape drawn. Press Save region (or Draw again). A long one.", "ok", 60000); }); await W(700); },
};

async function run(b, size, tag) {
  const [name, w, h, touch] = size;
  const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: !!touch, hasTouch: !!touch, userAgent: touch ? UA : undefined, deviceScaleFactor: touch ? 2 : 1 });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await open(p);
  for (const st of ["idle", "panel", "pick", "drawing"]) {
    const t = tag + " " + name + " " + st;
    await p.evaluate(() => { try { TDC.regions.UI.cancel(); } catch (_) {} TDC.searchUI.hide(); document.getElementById("toast").classList.remove("show"); }); await W(300);
    await state[st](p);
    const m = await p.evaluate(MEASURE), m0 = await withoutRd(p, () => p.evaluate(MEASURE));
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: SHOTS + "/" + name + "-" + st + ".png" }); }
    if (!touch) ok(t + " | page does not scroll sideways or down (scrollTo max stays at 0,0; not wider than the window)", m.sx === 0 && m.sy === 0 && m.sw <= m.vw + 1, { sx: m.sx, sy: m.sy, sw: m.sw, vw: m.vw });
    else {   // phones: the closed "more controls" sheet (#mbSheet) waits below the screen and has always made the document taller (body overflow: hidden, so it can't be swiped to); not the Redact button's doing, checked below
      ok(t + " | page does not scroll sideways (scrollTo max stays at x 0; not wider than the window)", m.sx === 0 && m.sw <= m.vw + 1, { sx: m.sx, sw: m.sw, vw: m.vw });
      if (m.sy) console.log("INFO " + t + " document is " + m.sh + " px tall in a " + m.vh + " px window (closed #mbSheet below the screen; existed before the Redact button; unchanged by it)");
    }
    if (!touch) ok(t + " | desktop: document height <= window height", m.sh <= m.vh + 1, { sh: m.sh, vh: m.vh });
    ok(t + " | the Redact button adds no height to the bottom bar and nothing to the page size", m.tph === m0.tph && m.sw <= m0.sw + 1 && m.sh <= m0.sh + 1, { tph: [m.tph, m0.tph], sw: [m.sw, m0.sw], sh: [m.sh, m0.sh] });
    ok(t + " | every bottom-bar control is inside the window", m.clipped.length === 0, m.clipped);
    ok(t + " | no overlap between the corner items (buttons, panel, draw bar, toast, camera bar, controls)", m.hits.length === 0, m.hits.slice(0, 8));
  }
  ok(tag + " " + name + " | no page errors", errs.length === 0, errs.slice(0, 3));
  await ctx.close();
}
(async () => {
  if (!fs.existsSync(FIX + "/TeslaCam")) execFileSync("python3", [path.join(ROOT, "tools/make-mock-footage.py"), FIX], { stdio: "inherit" });
  const srv = await server(); const pw = require("playwright");
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    let b;
    try { b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] }); }
    catch (e) { console.log("SKIP " + BR + ": cannot launch (" + e.message.split("\n")[0] + ")"); continue; }
    for (const s of SIZES) { try { await run(b, s, BR); } catch (e) { ok(BR + " " + s[0] + " run threw: " + e.message.split("\n")[0], false); } }
    await b.close();
  }
  srv.close(); console.log(fails ? "FAILED " + fails : "ALL PASSED"); process.exit(fails ? 1 : 0);
})();
