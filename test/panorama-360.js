// (since ui-quick the 360 view is off by default: this test opens the page with ?show360=1)
// 360 view (prototype): nothing loads while off; WebGL2 + WebGL1 shaders compile; renders non-black from the sample
// clips in look-around and flat equirect; projection math; blind spot dark; calibration save/export/import;
// toggling off restores the grid; 360 equirect export (WebCodecs). SHOTS=dir saves panorama-*.png.
const puppeteer = require("puppeteer-core"); const fs = require("fs"), path = require("path");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.FIXTURES || "/workspace/photo-samples/TeslaCam", SHOTS = process.env.SHOTS || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); fs.statSync(q).isDirectory() ? w(q) : (/\.(mp4|json)$/.test(f) && f !== "base.mp4" && files.push(q)); } })(FIX);
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x) : "")); if (!c) fails++; };
const stats = (p, sel) => p.evaluate((sel) => { const c = document.querySelector(sel); const t = document.createElement("canvas"); t.width = 160; t.height = Math.round(160 * c.height / c.width); const x = t.getContext("2d"); x.drawImage(c, 0, 0, t.width, t.height); const d = x.getImageData(0, 0, t.width, t.height).data; let s = 0, bright = 0, n = d.length / 4; for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; s += l; if (l > 40) bright++; } return { mean: s / n, bright: bright / n, w: c.width, h: c.height }; }, sel);
async function load(b, vp, ua) {
  const p = await b.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message)); p.reqs = []; p.on("request", (r) => p.reqs.push(r.url())); await p.setViewport(vp); if (ua) await p.setUserAgent(ua);
  await p.goto(URL_ + (URL_.includes("?") ? "&" : "?") + "show360=1", { waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important}" });
  await (await p.$("#fileInput")).uploadFile(...files);
  for (let i = 0; i < 80 && (await p.evaluate(() => TDC.library.events.length)) < 3; i++) await W(250);
  await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); return TDC.ui.activate(TDC.library.events.find((e) => /18-22/.test(e.id)) || TDC.library.events[0]); });
  await W(1500); await p.evaluate(async () => { await TDC.player.seek(6); }); await W(900); return p;
}
(async () => {
  const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--hide-scrollbars", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"], userDataDir: "/tmp/tdc-pano-" + Date.now(), protocolTimeout: 600000 });
  const p = await load(b, { width: 1440, height: 900 });
  ok("off by default: pano.js not loaded", await p.evaluate(() => !TDC.pano && ![...document.scripts].some((s) => /pano\.js/.test(s.src))) && !p.reqs.some((u) => /\/pano\.js/.test(u)));
  ok("360 button in the camera bar", await p.evaluate(() => { const b = document.getElementById("btn360"); return !!b && b.offsetParent !== null; }));
  await p.click("#btn360"); await W(1500);
  const st = await p.evaluate(() => ({ on: TDC.pano.on, gl2: !!(TDC.pano && document.getElementById("panoCanvas")), frames: TDC.pano.frames, pressed: document.getElementById("btn360").getAttribute("aria-pressed") }));
  ok("360 turns on and renders", st.on && st.frames > 0 && st.pressed === "true", st);
  const comp = await p.evaluate(() => { const out = {}; for (const one of [false, true]) { try { const r = TDC.pano.makeRenderer(document.createElement("canvas"), one); out[one ? "webgl1" : "webgl2"] = r ? (r.two ? "webgl2" : "webgl1") : "none"; } catch (e) { out[one ? "webgl1" : "webgl2"] = "ERR " + e.message; } } return out; });
  ok("shaders compile: WebGL2 and WebGL1 fallback", comp.webgl2 === "webgl2" && comp.webgl1 === "webgl1", comp);
  await p.evaluate(() => { TDC.pano.yaw = 0; TDC.pano.pitch = -5; TDC.pano.fov = 90; TDC.pano.redraw(); }); await W(500);
  const look = await stats(p, "#panoCanvas");
  ok("look-around view is not black", look.mean > 25 && look.bright > 0.3, look);
  if (SHOTS) await p.screenshot({ path: SHOTS + "/panorama-look.png" });
  await p.evaluate(() => { TDC.pano.yaw = 150; TDC.pano.redraw(); }); await W(400);
  const lookBack = await stats(p, "#panoCanvas");
  ok("looking back-right shows the rear/repeater cameras", lookBack.mean > 20, lookBack);
  await p.evaluate(() => document.querySelector('#panoMode button[data-v="equirect"]').click()); await W(600);
  const eq = await stats(p, "#panoCanvas");
  ok("flat equirect view is not black", eq.mean > 20 && eq.bright > 0.2, eq);
  if (SHOTS) {
    await p.screenshot({ path: SHOTS + "/panorama-equirect-view.png" });
    const png = await p.evaluate(async () => { const P = TDC.pano, c = document.createElement("canvas"); c.width = 2048; c.height = 1024; P.drawEquirect(c.getContext("2d"), 2048, 1024, P.liveFrames()); return c.toDataURL("image/png"); });
    fs.writeFileSync(SHOTS + "/panorama-equirect.png", Buffer.from(png.split(",")[1], "base64"));
  }
  // projection math + blind spot
  const m = await p.evaluate(() => { const P = TDC.pano, C = P.calib(); return { front: P.project([0, 0, 1], C.front, 0.75), backFromFront: P.project([0, 0, -1], C.front, 0.75), back: P.project([0, 0, -1], C.back, 0.75), right: P.project([Math.sin(1.0), 0, Math.cos(1.0)], C.right_pillar, 0.75), up: P.CAMS.map((c) => P.project([0, 1, 0], C[c], 0.75)) }; });
  ok("projection: straight ahead hits the front image centre (pitch offset only)", m.front && Math.abs(m.front.u - 0.5) < 1e-6 && m.front.v < 0.5 && m.front.v > 0.4, m.front);
  ok("projection: behind is not in the front camera, is in the rear one", m.backFromFront === null && m.back && Math.abs(m.back.u - 0.5) < 1e-6, m);
  ok("projection: 57° right is seen by the right pillar near its centre", m.right && Math.abs(m.right.u - 0.5) < 0.05, m.right);
  ok("straight up: no camera sees it (blind spot)", m.up.every((x) => x === null), m.up);
  await p.evaluate(() => { TDC.pano.mode = "look"; TDC.pano.yaw = 0; TDC.pano.pitch = 85; TDC.pano.fov = 40; TDC.pano.redraw(); }); await W(500);
  const sky = await stats(p, "#panoCanvas");
  ok("blind spot rendered dark", sky.mean < 30, sky);
  // calibration
  const cal = await p.evaluate(() => { const P = TDC.pano; const c = P.calib(); c.front.yaw = 3; P.saveCalib(c); const saved = P.calib().front.yaw; const json = P.exportCalib(); P.resetCalib(); const reset = P.calib().front.yaw; const n = P.importCalib(json); let bad = null; try { P.importCalib('{"cameras":{"front":{"yaw":"x","fov":9999}}}'); } catch (e) { bad = e.message; } const after = P.calib().front; P.resetCalib(); return { saved, reset, n, back: after.yaw, fovClamp: after.fov, bad }; });
  ok("calibration: save, export, reset, import (sanitised)", cal.saved === 3 && cal.reset === 0 && cal.n === 6 && cal.back === 3 && cal.fovClamp === 220, cal);
  await p.evaluate(() => { TDC.setPref("advanced", true); document.body.classList.add("adv"); });
  await p.evaluate(() => TDC.pano.toggleCalib(true)); await W(300);
  ok("calibration panel opens with sliders", await p.evaluate(() => document.querySelectorAll("#panoCalibPanel input[type=range]").length === 5));
  if (SHOTS) { await p.evaluate(() => { TDC.pano.pitch = -5; TDC.pano.fov = 90; TDC.pano.redraw(); }); await W(400); await p.screenshot({ path: SHOTS + "/panorama-calibrate.png" }); }
  await p.evaluate(() => TDC.pano.toggleCalib(false));
  // off → grid back
  await p.click("#btn360"); await W(400);
  ok("toggle off restores the grid", await p.evaluate(() => !TDC.pano.on && document.getElementById("panoWrap").hidden && !document.getElementById("stage").classList.contains("pano-on") && [...document.querySelectorAll("#grid .tile")].some((t) => t.offsetWidth > 100)));
  const fr = await p.evaluate(async () => { const n = TDC.pano.frames; await new Promise((r) => setTimeout(r, 600)); return TDC.pano.frames - n; });
  ok("no rendering while off", fr === 0, fr);
  // export
  const ex = await p.evaluate(async () => { try { const r = await TDC.exporter.run({ preset: "equirect", ranges: [[5, 6]], show: { labels: false, hud: false, map: false, fsd: false, time: false } }); return { W: r.W, H: r.H, size: r.blob.size, name: r.name, note: r.note }; } catch (e) { return { err: e.message }; } });
  ok("360 equirect export (WebCodecs) gives a 2:1 video", !ex.err && ex.W === 2 * ex.H && ex.size > 10000, ex);
  const nx = await p.evaluate(async () => { try { const r = await TDC.exporter.run({ preset: "compat", ranges: [[5, 6]] }); return { W: r.W, H: r.H, size: r.blob.size }; } catch (e) { return { err: e.message }; } });
  ok("regular export still works (1920×1080 grid)", !nx.err && nx.W === 1920 && nx.H === 1080 && nx.size > 10000, nx);
  ok("no page errors", p.errs.length === 0, p.errs);
  // mobile: reduced resolution
  const m2 = await load(b, { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1");
  await m2.evaluate(() => TDC.toggle360(true)); await W(1200);
  const ms = await m2.evaluate(() => { const c = document.getElementById("panoCanvas"); return { w: c.width, cw: c.clientWidth, scale: TDC.pano.scale, on: TDC.pano.on }; });
  ok("phone: renders at reduced resolution", ms.on && ms.scale === 0.5 && ms.w <= ms.cw * 1.5 + 1, ms);
  if (SHOTS) await m2.screenshot({ path: SHOTS + "/panorama-mobile.png" });
  ok("phone: no page errors", m2.errs.length === 0, m2.errs);
  await b.close(); console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
