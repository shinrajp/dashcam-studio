// Hand-off cue, live (tags handoff-m2 / m4): Playwright WebKit + Chromium, desktop 1440x900 and phone 430x932.
//  A mock detector walks one "person" along the RIGHT REPEATER to its right edge, then onto the REAR camera (from its left edge).
//  - the cue appears on the REAR tile (entry edge LEFT) before the person gets there; it follows the layout: the edge is on the
//    screen side of the entry edge in Rear view (left), in Mirrored bottom row (right, flipped with the picture), and in Current (still REAR's left edge)
//  - in Rear view the glowing edge touches the right repeater tile (the walk is continuous on screen)
//  - the same person keeps ONE colour on both cameras (cross-camera matching), flagged best guess; Cross-camera matching off → one colour per track
//  - Sentry events track every camera by default (also on phones); Dashcam events keep Focused on phones; explicit choice wins
//  - weak (zoomed, 0.2–0.35) person looks need 3 looks to become a track; a strong look is a track at once; ids are per camera and stable
//  - the cue chip turns the cue off; no cue when detection has nothing
// Usage: BR=chromium|webkit node test/handoff-cue.js [url]   MOCK=/tmp/ho-mock
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const MOCK = process.env.MOCK || "/tmp/ho-mock";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 700) : "")); if (!c) fails++; };
(async () => {
  const pw = require("playwright");
  if (!fs.existsSync(MOCK + "/TeslaCam")) execFileSync("python3", [path.join(__dirname, "../tools/make-mock-footage.py"), MOCK, "--jobs", "4"], { stdio: "inherit" });
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    const b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
    for (const dev of [{ name: "desktop", viewport: { width: 1440, height: 900 } }, { name: "phone", viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, userAgent: UA, deviceScaleFactor: 2 }]) {
      const tag = BR + " " + dev.name + ": ";
      const ctx = await b.newContext(dev); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
      await p.goto(URL_, { waitUntil: "load" });
      await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, live: true, model: "nano" })); });   // liveCams NOT set: the defaults decide
      await p.reload({ waitUntil: "load" });
      await p.setInputFiles("#folderInput", MOCK + "/TeslaCam");
      for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 2; i++) await W(250);
      await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
      const open = async (re) => { await p.evaluate((re) => TDC.ui.activate(TDC.library.events.find((e) => new RegExp(re).test(e.source))), re); await W(800); };
      // ── scheduling defaults ──
      await open("Sentry");
      ok(tag + "Sentry event: person tracking on every camera by default" + (dev.name === "phone" ? " (phone too)" : ""), (await p.evaluate(() => TDC.detect.liveCamsMode())) === "all");
      await open("SavedClips");
      ok(tag + "Dashcam event: unchanged default (" + (dev.name === "phone" ? "Focused" : "All") + ")", (await p.evaluate(() => TDC.detect.liveCamsMode())) === (dev.name === "phone" ? "focused" : "all"));
      await open("Sentry");
      await p.evaluate(() => { const D = TDC.detect; D.setPref("liveCams", "focused"); });
      ok(tag + "an explicit Focused choice wins over the Sentry default", (await p.evaluate(() => TDC.detect.liveCamsMode())) === "focused");
      await p.evaluate(() => { const D = TDC.detect; D.setPref("liveCams", null); const pr = D.prefs(); delete pr.liveCams; localStorage.setItem("tdc.detect.v1", JSON.stringify(pr)); });
      // ── weak looks: accumulation + stable ids (tracker only) ──
      const weak = await p.evaluate(() => {
        const D = TDC.detect; D.clear(); const out = {}; const W = (t, conf, weak) => [{ x: 0.3, y: 0.3, w: 0.06, h: 0.2, label: "person", conf, weak, zoom: true }];
        D._track("front", 1, W(1, 0.24, true)); out.after1 = D.personTracks(1).length;
        D._track("front", 1.8, W(1.8, 0.25, true)); out.after2 = D.personTracks(1.8).length;
        D._track("front", 2.6, W(2.6, 0.26, true)); out.after3 = D.personTracks(2.6).length;
        D._track("back", 2.6, [{ x: 0.5, y: 0.3, w: 0.06, h: 0.2, label: "person", conf: 0.6 }]); out.strong = D.personTracks(2.6).filter((x) => x.cam === "back").length;
        D._track("left_pillar", 1, W(1, 0.22, true)); D._track("left_pillar", 5, W(5, 0.22, true)); D._track("left_pillar", 9, W(9, 0.22, true)); out.sparse = D.personTracks(9).filter((x) => x.cam === "left_pillar").length;
        out.ids = D.personTracks(2.6).map((x) => x.id).sort();
        D._track("front", 3.0, [{ x: 0.31, y: 0.3, w: 0.06, h: 0.2, label: "person", conf: 0.5 }]); out.idsAfter = D.personTracks(3.0).filter((x) => x.cam === "front").map((x) => x.id);
        D.clear(); return out;
      });
      ok(tag + "weak zoomed looks: 1 or 2 are not a track, the 3rd (within 3 s) confirms; one strong look is a track at once; sparse weak looks never confirm", weak.after1 === 0 && weak.after2 === 0 && weak.after3 === 1 && weak.strong === 1 && weak.sparse === 0, weak);
      ok(tag + "per-camera track ids are stable (the id survives a later look)", weak.ids.length === 2 && weak.idsAfter.length === 1 && weak.idsAfter[0] === weak.ids.find((x) => /^F/.test(x)), weak);
      // ── the walk, live ──
      await open("Sentry");
      await p.evaluate(() => {
        const D = TDC.detect; window.__calls = { full: 0, crop: 0 };
        const box = (x) => ({ x, y: 0.42, w: 0.08, h: 0.3, cls: 0, conf: 0.8 });
        D._mock = async (img, iw, ih, opts) => {
          const P = TDC.player, cam = Object.keys(P.tiles).find((c) => P.tiles[c].vids.includes(img)), t = P.time;
          await new Promise((r) => setTimeout(r, 25));
          if (opts && opts.crops) { __calls.crop++; return []; }
          __calls.full++;
          if (cam === "right_repeater") { const x = 0.45 + 0.13 * t; return x + 0.08 <= 0.995 ? [box(x)] : []; }
          if (cam === "back" && t > 3.3) { const x = 0.0 + 0.13 * (t - 3.3); return [box(Math.max(0.005, x))]; }
          return [];
        };
        TDC.player.seek(0); TDC.player.play();
      });
      let seen = null;
      for (let i = 0; i < 70 && !seen; i++) { await W(100); seen = await p.evaluate(() => { const e = document.querySelector('.tile[data-cam="back"] > .ho-cue'); if (!e || e.hidden || !e.dataset.on) return null; const r = document.querySelector('.tile[data-cam="right_repeater"]').getBoundingClientRect(), q = document.querySelector('.tile[data-cam="back"]').getBoundingClientRect(); return { side: e.dataset.side, from: e.dataset.from, color: e.style.getPropertyValue("--ho"), t: TDC.player.time, rrRight: Math.round(r.right), backLeft: Math.round(q.left), arrow: e.querySelector(".ho-arrow").textContent, layout: TDC.layout.preset }; }); }
      ok(tag + "cue appears on the REAR tile (entry edge: left) while the person is still on the right repeater", !!seen && seen.side === "left" && seen.from === "right_repeater" && seen.t < 3.6, seen);
      ok(tag + "Rear view: the glowing REAR edge touches the RIGHT REPEATER tile, arrow points right", !!seen && seen.layout === "rear" && Math.abs(seen.rrRight - seen.backLeft) <= 3 && /→/.test(seen.arrow), seen);
      // one person, one colour
      await W(2200);
      const ppl = await p.evaluate(() => { const t = TDC.player.time; const cur = TDC.people.current(t); return { t, cur: cur.map((x) => ({ cam: x.cam, id: x.id, gid: x.gid, color: x.color, bg: x.bestGuess, lc: x.linkConf && +x.linkConf.toFixed(2) })), n: TDC.people.reg.persons.size, calls: window.__calls }; });
      ok(tag + "the same walker has the same global id and colour on both cameras, marked best guess", ppl.n === 1 && ppl.cur.length >= 1 && new Set(ppl.cur.map((x) => x.gid)).size === 1 && (ppl.cur.length < 2 || ppl.cur.every((x) => x.bg)), ppl);
      await p.evaluate(() => TDC.player.pause());
      // follows the layout (cue computed from the neighbour table, painted on whichever side that edge is now)
      const cueNow = () => p.evaluate(() => { TDC.player.pause(); const t = TDC.player.time, D = TDC.detect;
        D.clear(); TDC.people.reset(); D._track("right_repeater", t - 0.4, [{ x: 0.78, y: 0.4, w: 0.08, h: 0.3, label: "person", conf: 0.8 }]); D._track("right_repeater", t, [{ x: 0.84, y: 0.4, w: 0.08, h: 0.3, label: "person", conf: 0.8 }]);
        TDC.handoff.H0 = 0; TDC.handoff.last = 0; TDC.handoff._sig = ""; TDC.handoff.refresh();
        const e = document.querySelector('.tile[data-cam="back"] > .ho-cue'); const q = document.querySelector('.tile[data-cam="back"]').getBoundingClientRect(), lr = document.querySelector('.tile[data-cam="left_repeater"]').getBoundingClientRect(), rr = document.querySelector('.tile[data-cam="right_repeater"]').getBoundingClientRect();
        return { side: e && !e.hidden ? e.dataset.side : null, arrow: e ? e.querySelector(".ho-arrow").textContent : "", mirrored: document.querySelector('.tile[data-cam="back"]').classList.contains("mirrored"), backL: q.left, backR: q.right, rrL: rr.left, rrR: rr.right, lrL: lr.left }; });
      await p.evaluate(() => TDC.layout.set("mirror")); await W(300);
      let c1 = await cueNow();
      ok(tag + "Mirrored bottom row: the cue edge flips with the picture (REAR's entry edge is on the screen's right), arrow points left", c1.mirrored && c1.side === "right" && /←/.test(c1.arrow), c1);
      await p.evaluate(() => TDC.layout.set("current")); await W(300);
      c1 = await cueNow();
      ok(tag + "Current layout: still REAR's left edge (the neighbour table does not depend on the layout)", c1.side === "left" && !c1.mirrored, c1);
      await p.evaluate(() => { TDC.layout.set("rear"); TDC.focus.focus("front"); }); await W(300);
      const foc = await p.evaluate(() => { TDC.handoff._sig = ""; TDC.handoff.last = 0; TDC.handoff.refresh(); const e = document.querySelector('.tile[data-cam="back"] > .ho-cue'); const t = document.querySelector('.tile[data-cam="back"]'); return { hiddenTile: t.classList.contains("off"), cue: !!e && !e.hidden }; });
      ok(tag + "focused on another camera: the hidden tile's cue is not visible and nothing breaks", foc.hiddenTile, foc);
      await p.evaluate(() => TDC.focus.focus(null)); await W(300);
      // chip
      await p.evaluate(() => { if (TDC.mobileBar && TDC.mobileBar.on) TDC.mobileBar.setOpen(true); }); await W(400);
      await p.click("#chipCue"); await W(200);
      const off = await p.evaluate(() => { TDC.handoff._sig = ""; TDC.handoff.last = 0; TDC.handoff.refresh(); const e = document.querySelector('.tile[data-cam="back"] > .ho-cue'); return { pref: TDC.prefs.cue, shown: !!e && !e.hidden && !!e.dataset.on, pressed: document.getElementById("chipCue").getAttribute("aria-pressed") }; });
      ok(tag + "Hand-off chip turns the cue off (pref saved, glow gone) and on again", off.pref === false && !off.shown && off.pressed === "false", off);
      await p.click("#chipCue"); await W(200);
      ok(tag + "…and back on", (await p.evaluate(() => TDC.prefs.cue)) === true);
      ok(tag + "no page errors", errs.length === 0, errs);
      await ctx.close();
    }
    await b.close();
  }
  console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})();
