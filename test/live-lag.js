// Live boxes keep up with a moving car (tag live-lag). The user's iPhone (Safari): the gold "Detect while playing" boxes
// trailed moving cars, worst in the 6-camera grid, still a little in the single-camera view, at speed "Fast".
// Footage: PLATE_MOTION=fast tools/make-plate-footage.py (made-up car + plate sliding across the front camera, speeding
// up; plate-truth.json has the plate box per frame). The other five cameras show the same still scene (copies of back).
// The detector is a mock that answers with the TRUE car box of the frame it was handed, after INF ms (a phone's frame
// grab + YOLO11n-320 on WASM + colour, default 150 ms), so only the app's scheduling, tracker and painting are measured.
// Every paint of the front tile (burnBoxes.at, called by search.js paintBoxes on each animation frame) is compared with the
// truth for the frame being presented (rVFC mediaTime): centre error in tile CSS px and video px, and as time (error ÷ speed).
// iPhone emulation (440×956, DPR 3, iPhone UA); Chromium also gets a CDP CPU throttle (THR, default 4×). WebKit has no throttle.
// Usage: node test/live-lag.js [url]   (BR=chromium,webkit THR=4 INF=150 MODES=grid,focused LIVE_FIX=dir OUT=file.json
//        ASSERT=1: fail when the lag is over the limits of tag live-lag)
const pw = require("playwright"), fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL0 = process.argv[2] || "http://127.0.0.1:8770/index.html", URL_ = URL0 + (URL0.includes("?") ? "&" : "?") + "debug=det";
const FIX = process.env.LIVE_FIX || "/tmp/live-lag-fix";
const THR = +(process.env.THR || 4), INF = +(process.env.INF || 150), MODES = (process.env.MODES || "grid,focused").split(",");
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const STAMP = "2026-10-16_12-00-00", CAMS = ["left_repeater", "right_repeater", "left_pillar", "right_pillar"];
if (!fs.existsSync(FIX + "/plate-truth.json")) {
  execFileSync("python3", [path.join(__dirname, "../tools/make-plate-footage.py"), FIX], { stdio: "inherit", env: { ...process.env, PLATE_MOTION: "fast" } });
}
const clipDir = path.join(FIX, "TeslaCam/SavedClips", STAMP);
// the still cameras at 480×360 (headless WebKit decodes in software: six full-size videos stall it)
const small = path.join(clipDir, ".back-small.mp4");
if (!fs.existsSync(small)) { try { execFileSync("ffmpeg", ["-v", "error", "-y", "-i", path.join(clipDir, STAMP + "-back.mp4"), "-vf", "scale=480:360", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "24", "-f", "mp4", small]); } catch (_) { fs.copyFileSync(path.join(clipDir, STAMP + "-back.mp4"), small); } }
for (const c of CAMS.concat(["back"])) { const f = path.join(clipDir, STAMP + "-" + c + ".mp4"); if (c !== "back" && !fs.existsSync(f) || c === "back" && fs.statSync(f).size !== fs.statSync(small).size) fs.copyFileSync(small, f); }
// the front video gets its frame number as blocks (tools/stamp-frame-code.py): truth by picture, not by a browser clock
const frontF = path.join(clipDir, STAMP + "-front.mp4"), mark = path.join(clipDir, ".front-coded");
if (!fs.existsSync(mark)) { const tmp = path.join(clipDir, ".coded.mp4"); execFileSync("python3", [path.join(__dirname, "../tools/stamp-frame-code.py"), frontF, tmp]); fs.renameSync(tmp, frontF); fs.writeFileSync(mark, "1"); }
const truth = JSON.parse(fs.readFileSync(FIX + "/plate-truth.json", "utf8")).front.frames;
const files = fs.readdirSync(clipDir).filter((f) => !f.startsWith(".")).map((f) => path.join(clipDir, f));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x).slice(0, 700) : "")); if (!c) fails++; };
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const results = [];
(async () => {
  for (const bn of (process.env.BR || "chromium,webkit").split(",")) {
    for (const mode of MODES) {
      const b = await pw[bn].launch(bn === "chromium" ? { executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] } : {});
      const ctx = await b.newContext({ viewport: { width: 440, height: 956 }, deviceScaleFactor: +(process.env.DPR || 3), isMobile: true, hasTouch: true, userAgent: UA });
      const p = await ctx.newPage();
      const errs = []; p.on("pageerror", (e) => errs.push(e.message));
      await p.goto(URL_, { waitUntil: "load" });
      await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, live: true, model: "nano", speed: "fast", liveCams: "all" })); localStorage.removeItem("tdc.plates.v1"); });
      await p.reload({ waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important}" });
      // the mock detector: the true car box of the frame it was handed (front), a parked car elsewhere, after INF ms
      await p.evaluate(({ truth, INF }) => {
        const D = TDC.detect, fps = 24;
        const carAt = (mt) => { const i = Math.max(0, Math.min(truth.length - 1, Math.floor(mt * fps + 1e-3))), pb = truth[i].box; const cx = pb.x + pb.w / 2, cy = pb.y + pb.h / 2; return { x: cx - 0.12, y: cy - 0.13, w: 0.24, h: 0.2 }; };
        const cc = document.createElement("canvas"); cc.width = 224; cc.height = 16; const cx = cc.getContext("2d", { willReadFrequently: true });
        const readCode = (src) => { cx.drawImage(src, 0, 40, 224, 16, 0, 0, 224, 16); const d = cx.getImageData(0, 0, 224, 16).data; let n = 0; for (let i = 0; i < 9; i++) if (d[(8 * 224 + 8 + 24 * i + 12) * 4 + 1] > 128) n |= 1 << i; return n; };
        window.__lag = { dets: [], paints: [], carAt };
        D._mock = async (img) => {
          const P = TDC.player, cam = P && P.tiles ? Object.keys(P.tiles).find((c) => P.tiles[c].vids.includes(img)) : null;
          const mt = img.currentTime, t0 = performance.now();
          let code = null;
          try { const bm = await createImageBitmap(img); code = readCode(bm); bm.close && bm.close(); } catch (_) {}
          const fr = code != null ? code / fps : mt;   // the frame the detector really got
          await new Promise((r) => setTimeout(r, Math.max(0, INF - (performance.now() - t0))));
          __lag.dets.push({ cam, mt: fr, clock: mt, at: performance.now() });
          return cam === "front" ? [{ ...carAt(fr), cls: 2, conf: 0.9 }] : [{ x: 0.4, y: 0.45, w: 0.2, h: 0.18, cls: 2, conf: 0.9 }];
        };
        const at0 = TDC.burnBoxes.at;
        TDC.burnBoxes.at = function (cam, tc) {
          const out = at0.apply(this, arguments);
          try {
            const P = TDC.player;
            if (cam === "front" && P && P.playing && P.tiles) {
              const v = P.tiles.front.vids[P.active], pr = v._pres, now = performance.now();
              const rv = pr && now - pr.at < 250 ? pr.mt : v.currentTime;
              let mt = rv; try { mt = readCode(v) / fps; } catch (_) {}   // the frame on screen, by picture
              const bx = out && out[0];
              __lag.paints.push({ now, tc, mt, rv, ct: v.currentTime, pt: P.time, pa: pr ? now - pr.at : -1, x: bx ? bx.x + bx.w / 2 : null, tw: P.tiles.front.tile.clientWidth, th: P.tiles.front.tile.clientHeight, vw: v.videoWidth, vh: v.videoHeight });
            }
          } catch (_) {}
          return out;
        };
      }, { truth, INF });
      await p.setInputFiles("#fileInput", files);
      for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
      await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); });
      await p.evaluate(async (mode) => { await TDC.ui.activate(TDC.library.events[0]); TDC.focus.focus(mode === "grid" ? null : "front"); }, mode);
      await W(2500);
      let cdp = null;
      if (bn === "chromium" && THR > 1) { cdp = await ctx.newCDPSession(p); await cdp.send("Emulation.setCPUThrottlingRate", { rate: THR }); }
      const run = await p.evaluate(async () => {
        const P = TDC.player; __lag.dets = []; __lag.paints = [];
        await P.seek(0.2); await new Promise((r) => setTimeout(r, 400)); P.play();
        const t0 = performance.now();
        while (P.playing && performance.now() - t0 < 12000) await new Promise((r) => setTimeout(r, 200));
        P.pause();
        const vis = TDC.detect.liveCams();
        const dbg = TDC.detect.debugInfo ? TDC.detect.debugInfo() : null;
        return { dets: __lag.dets, paints: __lag.paints, vis, dbg, wall: performance.now() - t0 };
      });
      if (cdp) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      // compare every paint with the truth of the presented frame
      const fps = 24, carX = (mt) => { const i = Math.max(0, Math.min(truth.length - 1, Math.floor(mt * fps + 1e-3))); return truth[i].box.x + truth[i].box.w / 2; };
      const speed = (mt) => (carX(mt + 0.25) - carX(mt - 0.25)) / 0.5;
      const ps = run.paints.filter((x) => x.mt >= 2 && x.mt <= 7.5);
      const have = ps.filter((x) => x.x != null);
      const dxPx = [], dxV = [], lagMs = [], tcOff = [], bySec = {};
      let fit = null;
      for (const x of have) {
        // the video is letterboxed (contain) in the tile
        const s = Math.min(x.tw / x.vw, x.th / x.vh), wpx = x.vw * s;
        fit = { tileW: x.tw, tileH: x.th, videoCssW: +wpx.toFixed(1) };
        const e = x.x - carX(x.mt);
        tcOff.push((x.mt - x.tc) * 1000); (bySec[Math.floor(x.mt)] = bySec[Math.floor(x.mt)] || []).push((-(x.x - carX(x.mt)) / speed(x.mt)) * 1000);
        dxPx.push(Math.abs(e) * wpx); dxV.push(Math.abs(e) * x.vw); lagMs.push((-e / speed(x.mt)) * 1000);
      }
      const front = run.dets.filter((d) => d.cam === "front" && d.mt >= 2 && d.mt <= 7.5);
      const r = {
        browser: bn, mode, throttle: bn === "chromium" ? THR : 1, infMs: INF, camsLive: run.vis.length,
        paints: ps.length, boxShare: +(have.length / Math.max(1, ps.length)).toFixed(3),
        frontDetHz: +(front.length / 5.5).toFixed(2), allDetHz: +(run.dets.filter((d) => d.mt >= 2 && d.mt <= 7.5).length / 5.5).toFixed(2),
        errCssPx: { med: +q(dxPx, 0.5).toFixed(1), p90: +q(dxPx, 0.9).toFixed(1), max: +Math.max(...dxPx).toFixed(1) },
        errVideoPx: { med: +q(dxV, 0.5).toFixed(1), p90: +q(dxV, 0.9).toFixed(1) },
        lagMs: { med: Math.round(q(lagMs, 0.5)), p10: Math.round(q(lagMs, 0.1)), p90: Math.round(q(lagMs, 0.9)) },
        paintVsFrameMs: Math.round(q(tcOff, 0.5)), paintHz: +(ps.length / 5.5).toFixed(1), lagBySec: Object.fromEntries(Object.entries(bySec).map(([k, a]) => [k, Math.round(q(a, 0.5))])), fit, dbg: run.dbg,
      };
      if (process.env.DUMP) console.log("DUMP " + JSON.stringify(ps.slice(40, 52).map((x) => [x.now, x.tc, x.mt, x.rv, x.ct, x.pa].map((v) => +(+v).toFixed(3)))));
      results.push(r);
      console.log("RESULT " + JSON.stringify(r));
      const dd = await p.evaluate(() => { const e = document.getElementById("detDebug"); return e ? e.textContent : null; });
      ok(bn + " " + mode + ": ?debug=det readout (backend, per-camera looks, model ms, prediction)", !!dd && /det-debug/.test(dd) && /looks/.test(dd) && /prediction on/.test(dd) && /front/.test(dd), (dd || "").slice(0, 300));
      ok(bn + " " + mode + ": boxes painted while playing", have.length > 20, { paints: ps.length, have: have.length });
      if (process.env.ASSERT) {
        const lim = mode === "grid" ? { p90: 14, lag: 60 } : { p90: 8, lag: 40 };
        ok(bn + " " + mode + ": box stays on the car (p90 error ≤ " + lim.p90 + " CSS px, |median lag| ≤ " + lim.lag + " ms)", r.errCssPx.p90 <= lim.p90 && Math.abs(r.lagMs.med) <= lim.lag, r);
        ok(bn + " " + mode + ": a box on ≥ 98 % of paints", r.boxShare >= 0.98, r.boxShare);
      }
      ok(bn + " " + mode + ": no page errors", !errs.length, errs);
      await b.close();
    }
  }
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(results, null, 1));
  console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})();
