// White balance in the 6-camera grid (tag safari-feedback). The user's Mac Safari: with White balance on, the Left Pillar
// tile (top-left) shifted its picture in the non-full-screen grid. Safari/iOS ("blend" mode) now puts NO CSS filter on the
// <video>: a multiply tint (per-channel) + a color-dodge lift (brightness) above it. Synthetic 6-camera footage
// (tools/make-mock-footage.py). Playwright Chromium + WebKit, both modes (svg, blend), grid at the default window size:
//  - every tile's video / tint / lift box = the tile box, on and off
//  - screenshots on vs off: each tile's picture is in the same place (edge-image cross-correlation, best shift 0 px)
//  - blend mode: no filter on any <video>; the on-screen colour change matches the gains (R/B ratio within 6 %)
//  - per-camera matching (WB.match): each tile gets its own gains (front ≠ rear when their offsets differ), brightness kept;
//    the matcher's neutral reading (grey → 0, warm grey → R up / B down, saturated / dark → none); on the mock footage the
//    live offsets stay within ±MATCH_MAX
//  - viewer look limits: daylight white ≈ no change, night blue limited, tint halved, day / night from the strip brightness
//  - full UI (tag pillar-shift, the user's Mac Safari still saw the Left Pillar picture move down): labels, buttons and the WB
//    badge visible, grid and the Left Pillar single view, daylight ~7800 K like the report, deviceScaleFactor 2. Stage, grid,
//    every tile and video rect identical on vs off at 40 / 200 / 700 / 1500 ms after turning WB on; every tile's rendered
//    picture at shift 0,0 with a sub-pixel estimate < 0.25 device px; nothing in the stage or a tile in normal flow; the SVG
//    filter defs absolute 0×0 without pointer events; the badge absolute without pointer events. FULL_ONLY=1 runs just this.
// Usage: node test/wb-grid.js [url]   (BR=chromium,webkit   MOCK=/tmp/tdc-mock: footage, generated if missing)
const pw = require("playwright"), fs = require("fs"), path = require("path"), os = require("os"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const MOCK = process.env.MOCK || "/tmp/tdc-mock", SHOTS = process.env.SHOTS || "";
if (!fs.existsSync(MOCK + "/TeslaCam/SavedClips")) execFileSync("python3", [path.join(__dirname, "../tools/make-mock-footage.py"), MOCK], { stdio: "inherit" });
const list = (d0) => { const o = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); fs.statSync(q).isDirectory() ? w(q) : o.push(q); } })(d0); return o; };
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x).slice(0, 500) : "")); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wbgrid-"));
// per tile: best (dx, dy) in ±6 px aligning the edge images of two screenshots, and the mean R/B ratio change
const compare = (a, b, tiles) => { fs.writeFileSync(tmp + "/a.png", a); fs.writeFileSync(tmp + "/b.png", b); fs.writeFileSync(tmp + "/t.json", JSON.stringify(tiles));
  return JSON.parse(execFileSync("python3", ["-c", `
import json, numpy as np; from PIL import Image
A=np.asarray(Image.open('${tmp}/a.png').convert('RGB')).astype(float); B=np.asarray(Image.open('${tmp}/b.png').convert('RGB')).astype(float)
out={}
for c,(x,y,w,h) in json.load(open('${tmp}/t.json')).items():
  x,y,w,h=int(x)+8,int(y)+8,int(w)-16,int(h)-16
  a=A[y:y+h,x:x+w]; b=B[y:y+h,x:x+w]
  def edges(m):
    l=m.mean(2); l=(l-l.mean())/(l.std()+1e-6); gx=np.abs(np.diff(l,axis=1))[:-1]; gy=np.abs(np.diff(l,axis=0))[:,:-1]; return gx+gy
  ea,eb=edges(a),edges(b); best=None
  for dy in range(-6,7):
    for dx in range(-6,7):
      s=ea[6+dy:ea.shape[0]-6+dy,6+dx:ea.shape[1]-6+dx]; t=eb[6:eb.shape[0]-6,6:eb.shape[1]-6]
      v=float((s*t).mean())
      if best is None or v>best[0]: best=(v,dx,dy)
  ok=(a.max(2)<160)&(b.max(2)<235)&(a.min(2)>12)
  ra=a[ok].mean(0); rb=b[ok].mean(0)
  out[c]={"dx":best[1],"dy":best[2],"off":[round(v,1) for v in ra],"on":[round(v,1) for v in rb]}
print(json.dumps(out))`]).toString()); };
// full-UI version (tag pillar-shift): picture region of each tile (labels / badge / buttons masked out by insets),
// best integer shift in ±6 px plus a sub-pixel estimate (gradient least squares) of on vs off
const compare2 = (a, b, tiles) => { fs.writeFileSync(tmp + "/a.png", a); fs.writeFileSync(tmp + "/b.png", b); fs.writeFileSync(tmp + "/t.json", JSON.stringify(tiles));
  return JSON.parse(execFileSync("python3", ["-c", `
import json, numpy as np; from PIL import Image
A=np.asarray(Image.open('${tmp}/a.png').convert('L')).astype(float); B=np.asarray(Image.open('${tmp}/b.png').convert('L')).astype(float)
out={}
for c,(x,y,w,h) in json.load(open('${tmp}/t.json')).items():
  x0,y0,x1,y1=int(x)+10,int(y)+40,int(x+w)-10,int(y+h)-46
  if x1-x0<40 or y1-y0<40: continue
  a=A[y0:y1,x0:x1]; b=B[y0:y1,x0:x1]
  n=lambda m:(m-m.mean())/(m.std()+1e-6)
  ea,eb=n(a),n(b); best=None
  for dy in range(-6,7):
    for dx in range(-6,7):
      s=ea[6+dy:ea.shape[0]-6+dy,6+dx:ea.shape[1]-6+dx]; t=eb[6:eb.shape[0]-6,6:eb.shape[1]-6]
      v=float((s*t).mean())
      if best is None or v>best[0]: best=(v,dx,dy)
  gy=np.gradient(ea,axis=0); gx=np.gradient(ea,axis=1); d=(eb-ea)[2:-2,2:-2]
  M=np.stack([gx[2:-2,2:-2].ravel(),gy[2:-2,2:-2].ravel(),np.ones(d.size)],1)
  sx,sy,_=np.linalg.lstsq(M,-d.ravel(),rcond=None)[0]
  out[c]={"dx":best[1],"dy":best[2],"sx":round(float(sx),3),"sy":round(float(sy),3)}
print(json.dumps(out))`]).toString()); };
// geometry of everything that could move: stage, grid, every tile and its visible video, and whether anything inside the
// stage / a tile (and the SVG filter defs) sits in normal flow
const geo = (p) => p.evaluate(() => {
  const r = (e) => { const x = e.getBoundingClientRect(); return [x.left, x.top, x.width, x.height].map((v) => Math.round(v * 100) / 100); };
  const flow = [];
  const chk = (e) => { if (e.hidden) return; const cs = getComputedStyle(e); if (cs.display === "none") return; if (cs.position !== "absolute" && cs.position !== "fixed") flow.push((e.id || e.className || e.tagName) + ":" + cs.position); };
  for (const t of Object.values(TDC.player.tiles)) for (const e of t.tile.children) chk(e);
  for (const e of document.getElementById("stage").children) if (!e.classList.contains("stage-bar")) chk(e);
  const defs = [...document.querySelectorAll("body > svg")].map((s) => { const cs = getComputedStyle(s), b = s.getBoundingClientRect(); return { pos: cs.position, w: b.width, h: b.height, pe: cs.pointerEvents }; });
  const ro = document.getElementById("wbReadout"), rr = ro && !ro.hidden ? ro.getBoundingClientRect() : null;
  // layer structure per tile: element, hidden, blend mode, will-change, transform (and the video's own filter in blend mode)
  const layers = Object.fromEntries(Object.entries(TDC.player.tiles).map(([c, t]) => [c, [...t.tile.children].map((e) => { const cs = getComputedStyle(e); return [e.tagName, (e.className || "").toString().replace(/\bwb-idle\b/, "").replace(/\b(on|find-on)\b/g, "").trim(), e.hidden, cs.mixBlendMode, cs.willChange, cs.transform, e.tagName === "VIDEO" ? e.style.filter : ""].join("|"); })]));
  return { layers, stage: r(document.getElementById("stage")), grid: r(document.getElementById("grid")), scroll: [scrollX, scrollY, document.documentElement.scrollHeight],
    tiles: Object.fromEntries(Object.entries(TDC.player.tiles).filter(([, t]) => !t.tile.classList.contains("off")).map(([c, t]) => [c, { tile: r(t.tile), v: r(t.vids[TDC.player.active]), fit: getComputedStyle(t.vids[TDC.player.active]).objectFit, vwh: [t.vids[TDC.player.active].videoWidth, t.vids[TDC.player.active].videoHeight] }])),
    flow, defs, badge: rr && rr.width > 0 ? { text: ro.textContent, pos: getComputedStyle(ro).position, pe: getComputedStyle(ro).pointerEvents } : null };
});
async function fullUi(bn, mode) {
  const b = await pw[bn].launch(bn === "chromium" ? { executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] } : {});
  const p = await (await b.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })).newPage();
  p.on("pageerror", (e) => console.log("PAGEERR", e.message));
  await p.goto(URL_); await p.evaluate((m) => { localStorage.setItem("tdc.wb.v1", "0"); localStorage.setItem("tdc.wb.mode", m); }, mode); await p.reload();
  await p.addStyleTag({ content: ".toast{display:none!important} .bar-hint{display:none!important} .tile video{transition:none!important}" });
  await p.setInputFiles("#fileInput", list(MOCK + "/TeslaCam/SavedClips"));
  for (let i = 0; i < 80 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); });
  await p.evaluate(async () => { await TDC.ui.activate(TDC.library.events.find((e) => /14-33-41/.test(e.id || e.name || "")) || TDC.library.events[0]); });
  await W(2500); await p.evaluate(async () => { if (TDC.player.playing) TDC.player.pause && TDC.player.pause(); await TDC.player.seek(3.0); }); await W(1500);
  const framing = {};
  for (const view of ["grid", "left_pillar"]) {
    const tag = bn + " [" + mode + ", full UI, " + view + "]";
    await p.evaluate((v) => { TDC.wb.set(false); TDC.focus.focus(v === "grid" ? null : v); }, view); await W(900);
    const g0 = await geo(p), s0 = await p.screenshot();
    // the user's case: daylight (bright strips), ~7800 K white → badge "7800 K · Daylight · both mirrors"
    await p.evaluate(() => { const W = TDC.wb; W.set(true); W.reset(); W.state.sceneY = 140; for (let i = 0; i < 6; i++) W.update([205, 222, 250]); W.apply(); W.render(); });
    const shots = [];
    for (const ms of [40, 200, 700, 1500]) { await W(ms - (shots.length ? [40, 200, 700, 1500][shots.length - 1] : 0)); await p.evaluate(() => { TDC.wb.state.sceneY = 140; TDC.wb.update([205, 222, 250]); TDC.wb.apply(); TDC.wb.render(); }); shots.push([ms, await p.screenshot(), await geo(p)]); }
    const g1 = shots[shots.length - 1][2];
    ok(tag + ": badge visible, absolutely positioned, no pointer events", !!g1.badge && g1.badge.pos === "absolute" && g1.badge.pe === "none", g1.badge);
    ok(tag + ": nothing in the stage or a tile is in normal flow (on and off); SVG defs absolute, 0×0, no pointer events", !g0.flow.length && !g1.flow.length && g1.defs.every((d) => d.pos === "absolute" && d.w === 0 && d.h === 0 && d.pe === "none"), { off: g0.flow, on: g1.flow, defs: g1.defs });
    // a clean capture for the framing check (labels, camera bar, HUD, map hidden; WB off)
    await p.evaluate(() => { TDC.wb.set(false); const st = document.createElement("style"); st.id = "frameOnly"; st.textContent = ".stage > :not(.grid){visibility:hidden!important} .tile > :not(video){visibility:hidden!important}"; document.head.appendChild(st); });
    await W(500); framing[view] = { shot: await p.screenshot(), g: g0 };
    await p.evaluate(() => { document.getElementById("frameOnly").remove(); });
    if (mode === "blend") ok(tag + ": the same layers on and off (tint + lift always there, only their colour changes; no blend / filter / will-change added or removed)", shots.every(([, , g]) => JSON.stringify(g.layers) === JSON.stringify(g0.layers)) && Object.values(g0.layers).every((l) => l.filter((x) => /wb-(tint|lift)\|false/.test(x)).length === 2), { off: g0.layers.left_pillar, on: shots[shots.length - 1][2].layers.left_pillar });
    const strip = (g) => JSON.stringify({ stage: g.stage, grid: g.grid, scroll: g.scroll, tiles: g.tiles });
    ok(tag + ": stage, grid, every tile and video rect identical on vs off at 40 / 200 / 700 / 1500 ms", shots.every(([, , g]) => strip(g) === strip(g0)), { off: g0.tiles.left_pillar, on: shots.map(([ms, , g]) => [ms, g.tiles.left_pillar]) });
    const tiles = Object.fromEntries(Object.entries(g0.tiles).map(([c, x]) => [c, x.tile.map((v) => v * 2)]));
    const res = shots.map(([ms, s]) => [ms, compare2(s0, s, tiles)]);
    ok(tag + ": rendered picture of every tile in place (integer shift 0,0 and sub-pixel |dx|,|dy| < 0.25 device px) at every moment", res.every(([, r]) => Object.values(r).length && Object.values(r).every((x) => x.dx === 0 && x.dy === 0 && Math.abs(x.sx) < 0.25 && Math.abs(x.sy) < 0.25)), res.map(([ms, r]) => [ms, r.left_pillar]));
    if (SHOTS) { fs.writeFileSync(path.join(SHOTS, "pillar-" + view + "-off-" + bn + "-" + mode + ".png"), s0); fs.writeFileSync(path.join(SHOTS, "pillar-" + view + "-on-" + bn + "-" + mode + ".png"), shots[shots.length - 1][1]); }
  }
  // grid tile vs the single-camera view: the same picture (object-fit contain, the video's own aspect), only scaled
  { const tag = bn + " [" + mode + "]", G = framing.grid.g.tiles.left_pillar, F = framing.left_pillar.g.tiles.left_pillar;
    const pic = (x) => { const [L, T_, w, h] = x.v, [vw, vh] = x.vwh, k = Math.min(w / vw, h / vh); return [L + (w - vw * k) / 2, T_ + (h - vh * k) / 2, vw * k, vh * k]; };
    const pg = pic(G), pf = pic(F), asp = G.vwh[0] / G.vwh[1];
    ok(tag + ": Left Pillar framing: object-fit contain in the grid and the single view, picture aspect = video aspect in both (±0.5 %)", G.fit === "contain" && F.fit === "contain" && Math.abs(pg[2] / pg[3] / asp - 1) < 0.005 && Math.abs(pf[2] / pf[3] / asp - 1) < 0.005, { grid: pg.map((v) => +v.toFixed(2)), single: pf.map((v) => +v.toFixed(2)), video: G.vwh });
    fs.writeFileSync(tmp + "/g.png", framing.grid.shot); fs.writeFileSync(tmp + "/f.png", framing.left_pillar.shot);
    const fr = JSON.parse(execFileSync("python3", ["-c", `
import json, numpy as np; from PIL import Image
pg=${JSON.stringify(pg.map((v) => v * 2))}; pf=${JSON.stringify(pf.map((v) => v * 2))}
G=Image.open('${tmp}/g.png').convert('L'); F=Image.open('${tmp}/f.png').convert('L')
m=0.12   # skip label / buttons / badge strips
def crop(im,p): x,y,w,h=p; return im.crop((round(x+w*m),round(y+h*m),round(x+w*(1-m)),round(y+h*(1-m))))
g=crop(G,pg); f=crop(F,pf).resize(g.size, Image.LANCZOS)
a=np.asarray(g,float); b=np.asarray(f,float); n=lambda z:(z-z.mean())/(z.std()+1e-6); a,b=n(a),n(b); best=None
for dy in range(-4,5):
  for dx in range(-4,5):
    v=float((a[4+dy:a.shape[0]-4+dy,4+dx:a.shape[1]-4+dx]*b[4:-4,4:-4]).mean())
    if best is None or v>best[0]: best=(v,dx,dy)
print(json.dumps({"ncc":round(best[0],3),"dx":best[1],"dy":best[2],"size":g.size}))`]).toString());
    ok(tag + ": Left Pillar grid tile = single view scaled down (same crop: best alignment within 1 device px = 0.5 CSS px of resampling, correlation > 0.9)", Math.abs(fr.dx) <= 1 && Math.abs(fr.dy) <= 1 && fr.ncc > 0.9, fr);
  }
  // ?debug=wb: the hidden geometry readout shows every tile's numbers
  if (mode === "blend") {
    await p.goto(URL_ + (URL_.includes("?") ? "&" : "?") + "debug=wb"); await W(800);
    const d0 = await p.evaluate(() => { const e = document.getElementById("wbDebug"); return !!e && /dpr/.test(e.textContent) && typeof TDC.wbDebug.snap === "function"; });
    await p.goto(URL_); await W(500);
    const d1 = await p.evaluate(() => !document.getElementById("wbDebug"));
    ok(bn + ": ?debug=wb shows the geometry readout; without it nothing is added", d0 && d1, { d0, d1 });
  }
  await b.close();
}
(async () => {
  for (const bn of (process.env.BR || "chromium,webkit").split(",")) for (const mode of ["svg", "blend"]) await fullUi(bn, mode);
  if (process.env.FULL_ONLY) { console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0); }
  for (const bn of (process.env.BR || "chromium,webkit").split(",")) {
    for (const mode of ["svg", "blend"]) {
      const b = await pw[bn].launch(bn === "chromium" ? { executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] } : {});
      const p = await (await b.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
      p.on("pageerror", (e) => console.log("PAGEERR", e.message));
      await p.goto(URL_); await p.evaluate((m) => { localStorage.setItem("tdc.wb.v1", "0"); localStorage.setItem("tdc.wb.mode", m); }, mode); await p.reload();
      await p.addStyleTag({ content: ".toast{display:none!important} .bar-hint{display:none!important} .wb-readout{visibility:hidden!important} .stage > :not(.grid){visibility:hidden!important} .tile > :not(video):not(.wb-tint):not(.wb-lift){visibility:hidden!important}" });   // only the pictures
      await p.setInputFiles("#fileInput", list(MOCK + "/TeslaCam/SavedClips"));
      for (let i = 0; i < 80 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
      await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); });
      await p.evaluate(async () => { await TDC.ui.activate(TDC.library.events.find((e) => /14-33-41/.test(e.id || e.name || "")) || TDC.library.events[0]); });
      await W(2500); await p.evaluate(async () => { if (TDC.player.playing) TDC.player.pause && TDC.player.pause(); await TDC.player.seek(3.0); }); await W(1500);
      const tag = bn + " [" + mode + "]";
      if (mode === "svg") {   // viewer look limits (WB.viewGains): day ≈ no change, night limited, tint halved
        const u = await p.evaluate(() => { const W = TDC.wb, L = (g) => g.map(Math.log); return { C: W.C, day7700: L(W.viewGains([205, 222, 250], 1)), day6300: L(W.viewGains([222, 228, 240], 1)), night3000: W.viewGains([255, 196, 110], 0), old3000: W.gains([255, 196, 110]),
          green: { view: L(W.viewGains([200, 240, 170], 0)), old: L(W.gains([200, 240, 170])) }, dn: [W.dayness(20), W.dayness(75), W.dayness(140), W.dayness(null)] }; });
        ok(bn + ": daylight 6300–7700 K white: viewer gains within ±4 % (no red cast added by day)", [...u.day7700, ...u.day6300].every((x) => Math.abs(x) < 0.04), { day7700: u.day7700.map((x) => +x.toFixed(3)), day6300: u.day6300.map((x) => +x.toFixed(3)) });
        ok(bn + ": night 3000 K: blue gain ≤ BLUE_MAX and below the old full gain (less blue), red still lowered", u.night3000[2] <= u.C.BLUE_MAX + 1e-6 && u.night3000[2] < u.old3000[2] && u.night3000[0] < 1, { night: u.night3000, old: u.old3000 });
        const tint = (l) => l[1] - (l[0] + l[2]) / 2;
        ok(bn + ": greenish light: the magenta (tint) part of the correction is halved", Math.abs(tint(u.green.view)) < 0.6 * Math.abs(tint(u.green.old)), { view: +tint(u.green.view).toFixed(3), old: +tint(u.green.old).toFixed(3) });
        const nm = await p.evaluate(() => { const mk = (rgb, noise) => { const c = document.createElement("canvas"); c.width = 64; c.height = 40; const x = c.getContext("2d"); for (let i = 0; i < 64; i++) for (let j = 0; j < 40; j++) { const k = ((i * 7 + j * 13) % 9) - 4; x.fillStyle = "rgb(" + rgb.map((v) => v + k * (noise || 0)).join(",") + ")"; x.fillRect(i, j, 1, 1); } c.videoWidth = 64; c.videoHeight = 40; c.readyState = 4; return c; };
          const W = TDC.wb; return { gray: W.neutralOf(mk([128, 128, 128], 3)), warm: W.neutralOf(mk([140, 128, 116], 3)), green: W.neutralOf(mk([60, 170, 60], 3)), dark: W.neutralOf(mk([10, 10, 10], 1)) }; });
        ok(bn + ": camera matcher: neutral grey → 0, warm grey → R up / B down, saturated or dark frames → no reading", Math.abs(nm.gray[0]) < 0.02 && Math.abs(nm.gray[1]) < 0.02 && nm.warm[0] > 0.05 && nm.warm[1] < -0.05 && nm.green === null && nm.dark === null, nm);
        ok(bn + ": day / night from the mirror strips' brightness (dark 0, bright 1, unknown = night)", u.dn[0] === 0 && u.dn[1] > 0 && u.dn[1] < 1 && u.dn[2] === 1 && u.dn[3] === 0, u.dn);
      }
      const rects = () => p.evaluate(() => Object.fromEntries(Object.entries(TDC.player.tiles).map(([c, t]) => { const r = (e) => { const x = e.getBoundingClientRect(); return [x.left, x.top, x.width, x.height].map((v) => Math.round(v * 10) / 10); }; const q = (s) => { const e = t.tile.querySelector(":scope > " + s); return e && !e.hidden ? r(e) : null; }; return [c, { tile: r(t.tile), v: r(t.vids[TDC.player.active]), tint: q(".wb-tint"), lift: q(".wb-lift"), filter: t.vids.map((v) => v.style.filter).join("|") }]; })));
      const off = await rects(), shotOff = await p.screenshot();
      // a warm night white point (strong gains) so a mismatch would show
      await p.evaluate(() => { TDC.wb.set(true); TDC.wb.reset(); TDC.wb.state.sceneY = 20; for (let i = 0; i < 6; i++) TDC.wb.update([240, 200, 130]); TDC.wb.apply(); });
      await W(300); await p.evaluate(() => { TDC.wb.state.sceneY = 20; for (let i = 0; i < 3; i++) TDC.wb.update([240, 200, 130]); TDC.wb.apply(); }); await W(400);
      const on = await rects(), shotOn = await p.screenshot(), gains = await p.evaluate(() => TDC.wb.applied && TDC.wb.applied.gains), perCam = await p.evaluate(() => Object.fromEntries(Object.keys(TDC.player.tiles).map((c) => [c, TDC.wb.gainsFor(c)])));
      if (SHOTS) { fs.writeFileSync(path.join(SHOTS, "wb-grid-off-" + bn + "-" + mode + ".png"), shotOff); fs.writeFileSync(path.join(SHOTS, "wb-grid-on-" + bn + "-" + mode + ".png"), shotOn); }
      const same = Object.keys(on).every((c) => JSON.stringify(on[c].v) === JSON.stringify(off[c].v) && JSON.stringify(on[c].v) === JSON.stringify(on[c].tile) && (mode !== "blend" || (JSON.stringify(on[c].tint) === JSON.stringify(on[c].tile) && JSON.stringify(on[c].lift) === JSON.stringify(on[c].tile))));
      ok(tag + ": video, tint and lift boxes = the tile box, on and off", same, { left_pillar: { off: off.left_pillar, on: on.left_pillar } });
      if (mode === "blend") ok(tag + ": no CSS filter on any <video> (tint + lift layers instead)", Object.values(on).every((x) => !x.filter.replace(/\|/g, "")), Object.fromEntries(Object.entries(on).map(([c, x]) => [c, x.filter])));
      else ok(tag + ": SVG filter on the videos", Object.values(on).every((x) => /url\(/.test(x.filter)), on.front.filter);
      const tiles = Object.fromEntries(Object.entries(on).map(([c, x]) => [c, x.tile]));
      const cmp = compare(shotOff, shotOn, tiles);
      ok(tag + ": every tile's picture stays in place (best edge alignment at 0,0 px)", Object.values(cmp).every((x) => x.dx === 0 && x.dy === 0), Object.fromEntries(Object.entries(cmp).map(([c, x]) => [c, [x.dx, x.dy]])));
      const rb = (c) => (cmp[c].on[0] / cmp[c].on[2]) / (cmp[c].off[0] / cmp[c].off[2]), want = (c) => perCam[c][0] / perCam[c][2];
      ok(tag + ": on-screen R/B change matches each tile's gains (±5 %)", Object.keys(cmp).every((c) => Math.abs(rb(c) / want(c) - 1) < 0.05), { shared: +(gains[0] / gains[2]).toFixed(3), got: Object.fromEntries(Object.keys(cmp).map((c) => [c, [+rb(c).toFixed(3), +want(c).toFixed(3)]])) });
      // per-camera matching: give the rear camera an offset, the front none → different gains, the same brightness
      const pc = await p.evaluate(() => { if (!TDC.wb.setMatch) return null; TDC.wb.setMatch({ back: [-0.08, 0.08], front: [0, 0] }); TDC.wb.apply(); const g = (c) => TDC.wb.gainsFor(c); const l = (x) => 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2]; return { front: g("front"), back: g("back"), lum: [l(g("front")), l(g("back"))] }; });
      const live = await p.evaluate(() => { TDC.wb.setMatch({}); TDC.wb.matchCams(); return { m: TDC.wb.match, max: TDC.wb.C.MATCH_MAX, n: Object.keys(TDC.wb.camNeutral) }; });
      ok(tag + ": camera matcher on the footage: offsets for the cameras, all within ±MATCH_MAX", live.n.length >= 4 && Object.values(live.m).every((o) => Math.abs(o[0]) <= live.max + 1e-9 && Math.abs(o[1]) <= live.max + 1e-9), live);
      if (pc) ok(tag + ": per-camera matching: rear gets its own (cooler) gains, brightness kept (±1 %)", pc.back[0] / pc.back[2] < pc.front[0] / pc.front[2] * 0.9 && Math.abs(pc.lum[1] / pc.lum[0] - 1) < 0.01, pc);
      await b.close();
    }
  }
  console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})();
