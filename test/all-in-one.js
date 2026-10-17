// All-in-one integration check across merged features (Chromium + WebKit): 360 on/off with docked search, strip plate labels.
const { chromium, webkit } = require("playwright"); const fs = require("fs"), path = require("path");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) { if (!/2026-10-08_09-01-00/.test(q)) w(q); } else if (/\.(mp4|json)$/.test(f) && f !== "base.mp4") files.push(q); } })(process.env.FIXTURES || "/workspace/photo-samples/TeslaCam");
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? " " + JSON.stringify(x) : "")); if (!c) fails++; };
(async () => {
  for (const [name, bt] of [["chromium", chromium], ["webkit", webkit]]) {
    const b = await bt.launch(name === "chromium" ? { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } : {});
    for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844, isMobile: true }]) {
      const ctx = await b.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.isMobile });
      const tag = name + " " + vp.width; let p, errs;
      for (let a = 1; a <= 4; a++) {
        p = await ctx.newPage(); errs = []; const e2 = errs; p.on("pageerror", (e) => e2.push(e.message));
        const load = (async () => { await p.goto(URL_, { waitUntil: "load" }); await p.setInputFiles("#fileInput", files);
          for (let i = 0; i < 60 && (await p.evaluate(() => TDC.library.events.length)) < 3; i++) await W(250);
          await p.evaluate(() => TDC.ui.activate(TDC.library.events.find((e) => /18-2/.test(e.id)))); await W(1200); })();
        try { await Promise.race([load, W(45000).then(() => { throw new Error("timeout"); })]); break; } catch (e) { console.log("NOTE retry load " + a); await p.close().catch(() => {}); }
      }
      ok(tag + " all modules up", await p.evaluate(() => !!(TDC.searchUI.ok && TDC.searchStrip.ok && TDC.plates && TDC.detect && TDC.toggle360)));
      await p.evaluate(() => TDC.searchUI.show(false)); await W(300);
      let r = await p.evaluate(async () => { try { await TDC.toggle360(true); } catch (e) { return { err: String(e.message || e) }; } await new Promise((r) => setTimeout(r, 1200)); const w = document.querySelector(".pano-wrap"); return { on: !!w && !w.hidden, dock: document.getElementById("usPanel").classList.contains("docked") }; });
      ok(tag + " 360 turns on with the docked search open", r.on && r.dock, r);
      r = await p.evaluate(async () => { await TDC.toggle360(false); await new Promise((r) => setTimeout(r, 300)); const w = document.querySelector(".pano-wrap"); return { off: !w || w.hidden }; });
      ok(tag + " 360 turns off again", r.off, r);
      // plate result in strip
      await p.evaluate(() => { TDC.search.phrase = "plate 7ABC234"; TDC.search.hits = [{ t: 2.0, cam: "front", score: 0.9, conf: 0.91, label: "plate", text: "7ABC234 91%", det: true, plate: true, box: { x: 0.45, y: 0.6, w: 0.08, h: 0.04 } }]; TDC.search.renderHits(); TDC.searchUI.refresh(); TDC.searchStrip.phone = () => true; TDC.focus.focus("front"); TDC.focus.fullscreen(true); });
      await W(800);
      const lbl = await p.evaluate(() => { const n = document.querySelector("#ssRow .ss-item .ss-l"); return n && n.textContent; });
      ok(tag + " strip shows the plate reading", lbl === "7ABC234 91%", lbl);
      ok(tag + " no page errors", !errs.length, errs);
      await ctx.close();
    }
    await b.close();
  }
  console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
