// Legs-fix (tag legs-fix): a person right behind the car (REAR fisheye, only legs / dark lower body in view) was labelled "cat".
// Synthetic only (a mock detector returns the boxes; no footage, no screenshots in the repo):
//  1. rules: a huge "cat" on the rear camera → person at once; a large one → weak person that needs 3 looks; a small or far cat/dog stays an animal;
//     a moderate animal on a side camera stays an animal; a real person box next to it wins; low-score legs-only person (rear, touching the bottom) → weak look
//  2. live (mock footage opened in the app): the rear camera's huge "cat" becomes a person TRACK (label person, not cat), appears in the people registry
//     and as a dot chip in the car view; the far cat on the front camera is still a cat; no page errors
//  3. private, local only: if PRIVATE_FRAME (default /workspace/wb-real/rear-legs/frame.png) exists the REAL model is run on it (skipped otherwise)
// Usage: BR=chromium|webkit [DEV=desktop|phone] [MOCK=/tmp/ho-mock] node test/legs-fix.js [url]
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html", MOCK = process.env.MOCK || "/tmp/ho-mock";
const PRIVATE = process.env.PRIVATE_FRAME || "/workspace/wb-real/rear-legs/frame.png";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 700) : "")); if (!c) fails++; };
(async () => {
  const pw = require("playwright");
  if (!fs.existsSync(MOCK + "/TeslaCam")) execFileSync("python3", [path.join(__dirname, "../tools/make-mock-footage.py"), MOCK, "--jobs", "4"], { stdio: "inherit" });
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium"])) {
    const b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
    for (const dev of [{ name: "desktop", viewport: { width: 1280, height: 800 } }, { name: "phone", viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, userAgent: UA, deviceScaleFactor: 2 }].filter((d) => !process.env.DEV || d.name === process.env.DEV)) {
      const tag = BR + " " + dev.name + ": ";
      const ctx = await b.newContext(dev); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
      await p.goto(URL_, { waitUntil: "load" });
      await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: true, live: true, model: "nano" })); });
      await p.reload({ waitUntil: "load" });
      // ── 1. rules ──
      const R = await p.evaluate(async () => {
        const D = TDC.detect, out = {}, B = (cls, x, y, w, h, conf) => ({ x, y, w, h, cls, conf: conf == null ? 0.8 : conf });   // cls: 0 person, 15 cat, 16 dog
        const run = async (dets, cam, look) => { D._mock = async () => dets.map((d) => ({ ...d })); const r = await D.detectImage({}, 1448, 938, { cam, look: !!look, conf: 0.35 }); return r.map((d) => ({ label: d.label, weak: !!d.weak, conf: +d.conf.toFixed(2), legs: !!d.legs })); };
        out.huge = await run([B(15, 0.07, 0.01, 0.5, 0.86, 0.87)], "back", true);
        out.hugeSearch = await run([B(15, 0.07, 0.01, 0.5, 0.86, 0.87)], undefined, false);
        out.largeLive = await run([B(15, 0.3, 0.5, 0.3, 0.42, 0.7)], "back", true);
        out.largeSearch = await run([B(15, 0.3, 0.5, 0.3, 0.42, 0.7)], "back", false);
        out.edgeLive = await run([B(16, 0.35, 0.62, 0.22, 0.38, 0.6)], "back", true);   // touches the bottom, 8 % of the frame, 38 % tall
        out.smallCat = await run([B(15, 0.5, 0.55, 0.05, 0.07, 0.8)], "back", true);
        out.farDog = await run([B(16, 0.2, 0.5, 0.08, 0.1, 0.7)], "back", true);
        out.midCatSide = await run([B(15, 0.3, 0.3, 0.3, 0.35, 0.7)], "right_repeater", true);   // 10.5 %: large on the rear, fine on a side camera
        out.hugeSide = await run([B(15, 0.1, 0.05, 0.6, 0.8, 0.8)], "front", true);   // 48 %
        out.horseSide = await run([B(17, 0.1, 0.2, 0.6, 0.6, 0.8)], "front", true);   // a horse beside the road (36 %): stays a horse
        out.bearRear = await run([B(21, 0.07, 0.01, 0.5, 0.86, 0.8)], "back", true);   // dark blob called a bear on the rear camera → person
        out.withPerson = await run([B(15, 0.1, 0.05, 0.5, 0.8, 0.8), B(0, 0.12, 0.05, 0.45, 0.85, 0.7)], "back", true);
        out.legsWeak = await run([B(0, 0.4, 0.55, 0.2, 0.44, 0.24)], "back", true);   // low-score person touching the bottom
        out.legsNotRear = await run([B(0, 0.4, 0.55, 0.2, 0.44, 0.24)], "front", true);
        out.legsSmallLow = await run([B(0, 0.4, 0.3, 0.04, 0.12, 0.24)], "back", true);   // far away: not kept
        localStorage.setItem("tdc.legsfix", "0"); out.off = await run([B(15, 0.07, 0.01, 0.5, 0.86, 0.87)], "back", true); localStorage.removeItem("tdc.legsfix");
        D._mock = null; return out;
      });
      const only = (a, l) => a.length === 1 && a[0].label === l;
      ok(tag + "huge 'cat' on the rear camera → person, strong (no waiting)", only(R.huge, "person") && !R.huge[0].weak && R.huge[0].legs, R.huge);
      ok(tag + "huge 'cat' in search/export (no camera info) → person too (same rule, consistent label)", only(R.hugeSearch, "person") && !R.hugeSearch[0].weak, R.hugeSearch);
      ok(tag + "large 'cat' on the rear camera, live → WEAK person (needs 3 looks)", only(R.largeLive, "person") && R.largeLive[0].weak, R.largeLive);
      ok(tag + "large 'cat' in search (no tracker) → person, not weak", only(R.largeSearch, "person") && !R.largeSearch[0].weak, R.largeSearch);
      ok(tag + "'dog' touching the bottom edge, big and tall, rear camera → weak person", only(R.edgeLive, "person") && R.edgeLive[0].weak, R.edgeLive);
      ok(tag + "small cat stays a cat", only(R.smallCat, "cat"), R.smallCat);
      ok(tag + "far dog stays a dog", only(R.farDog, "dog"), R.farDog);
      ok(tag + "moderate cat on a side camera stays a cat", only(R.midCatSide, "cat"), R.midCatSide);
      ok(tag + "huge animal on another camera (48 % of the frame) → person", only(R.hugeSide, "person"), R.hugeSide);
      ok(tag + "a big horse on the front camera stays a horse (pasture next to the road)", only(R.horseSide, "horse"), R.horseSide);
      ok(tag + "huge 'bear' on the rear camera → person (any animal class there)", only(R.bearRear, "person"), R.bearRear);
      ok(tag + "a real person box beside the 'cat': the person wins, the cat is dropped", only(R.withPerson, "person") && !R.withPerson[0].legs, R.withPerson);
      ok(tag + "rear camera: low-score person touching the bottom edge is kept as a weak look", only(R.legsWeak, "person") && R.legsWeak[0].weak, R.legsWeak);
      ok(tag + "same low-score person on the front camera is not kept (normal cut-off)", R.legsNotRear.length === 0, R.legsNotRear);
      ok(tag + "small far low-score person on the rear camera is not kept", R.legsSmallLow.length === 0, R.legsSmallLow);
      ok(tag + "tdc.legsfix=0 turns the rule off (cat stays cat)", only(R.off, "cat"), R.off);
      // ── 2. live ──
      await p.setInputFiles("#folderInput", MOCK + "/TeslaCam");
      for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 2; i++) await W(250);
      await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
      await p.evaluate(() => { if (TDC.reid) { TDC.reid.maybeEmbed = () => {}; TDC.reid.annotate = (tr) => tr; TDC.reid.pending = () => false; } TDC.ui.activate(TDC.library.events.find((e) => /Sentry/.test(e.source))); });
      await W(900);
      await p.evaluate(() => { if (!TDC.prefs.carView) document.getElementById("chipCar").click(); });
      await p.evaluate(() => {
        const D = TDC.detect;
        D.setPref("liveCams", "all");
        D._mock = async (img) => {
          const P = TDC.player, cam = Object.keys(P.tiles).find((c) => P.tiles[c].vids.includes(img));
          await new Promise((r) => setTimeout(r, 25));
          if (cam === "back") return [{ x: 0.07, y: 0.01, w: 0.5, h: 0.86, cls: 15, conf: 0.87 }];   // the legs, called a cat
          if (cam === "front") return [{ x: 0.45, y: 0.5, w: 0.04, h: 0.06, cls: 15, conf: 0.7 }];   // a far cat
          return [];
        };
        TDC.player.seek(0); TDC.player.play();
      });
      let st = null;
      for (let i = 0; i < 80 && !(st && st.backPerson); i++) { await W(150); st = await p.evaluate(() => { const L = TDC.detect.liveTracks; const lab = (c) => (L[c] || []).filter((x) => !x.weak).map((x) => x.label); return { back: lab("back"), front: lab("front"), backPerson: lab("back").includes("person"), pt: TDC.detect.personTracks(TDC.player.time).filter((x) => x.cam === "back").length }; }); }
      ok(tag + "live: the rear camera's 'cat' is tracked as a person", !!st && st.backPerson && !st.back.includes("cat"), st);
      ok(tag + "live: the far cat on the front camera is still a cat", !!st && st.front.includes("cat") && !st.front.includes("person"), st);
      await W(1500);
      const cv = await p.evaluate(() => { const t = TDC.player.time; const cur = TDC.people.current(t); return { cur: cur.filter((x) => x.cam === "back").length, chips: document.querySelectorAll("#carView .cv-chip").length, on: !!(TDC.prefs && TDC.prefs.carView), onRear: TDC.detect.personTracks(t).filter((x) => x.cam === "back").length }; });
      ok(tag + "live: the person on REAR is in the people registry (hand-off / car view source)", cv.cur >= 1 || cv.onRear >= 1, cv);
      console.log("   car view:", JSON.stringify(cv)); ok(tag + "live: a person chip / dot is shown in the car view", cv.on && cv.chips >= 1, cv);
      await p.evaluate(() => { TDC.player.pause(); TDC.detect._mock = null; });
      ok(tag + "no page errors", errs.length === 0, errs);
      // ── 3. private frame (never in the repo) ──
      if (fs.existsSync(PRIVATE) && (process.env.REAL || BR === "chromium") && dev.name === "desktop") {
        const b64 = fs.readFileSync(PRIVATE).toString("base64");
        const P = await p.evaluate(async (b64) => {
          const D = TDC.detect; D._mock = null; D.setPref("enabled", true);
          const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
          const res = {};
          for (const [name, fix] of [["before", true], ["after", false]]) {
            localStorage.setItem("tdc.legsfix", fix ? "0" : "1");
            for (const model of ["nano", "small"]) { D.setPref("model", model); await D.load(true).catch(() => {});
              const r = await D.detectImage(img, img.naturalWidth, img.naturalHeight, { cam: "back", look: true, conf: 0.25 });
              res[name + " " + model] = r.map((d) => `${d.label}${d.weak ? "(weak)" : ""} ${(d.conf * 100).toFixed(0)}% [${d.x.toFixed(2)},${d.y.toFixed(2)},${d.w.toFixed(2)},${d.h.toFixed(2)}]${d.from ? " from " + d.from + " " + (d.fromConf * 100).toFixed(0) + "%" : ""}`); }
          }
          localStorage.removeItem("tdc.legsfix"); return res;
        }, b64).catch((e) => ({ error: String(e) }));
        console.log("   private frame:", JSON.stringify(P));
        ok(tag + "private frame: before the fix 'cat', after the fix 'person' (nano)", !!P["before nano"] && /^cat/.test(P["before nano"][0] || "") && /^person/.test((P["after nano"] || [])[0] || ""), P);
      }
      await ctx.close();
    }
    await b.close();
  }
  console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("ERR", e); process.exit(2); });
