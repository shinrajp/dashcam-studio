// In-app camera calibration end to end, in the page (Chromium / Chrome): a synthetic clip of a KNOWN rig
// (tools/rig/make-footage.py: textured road, the real drive's path, SEI telemetry) is opened like any drive, Settings ▸
// Camera calibration ▸ Calibrate from this drive runs (worker, WebCodecs), and the result must give the rig back, be saved
// per car, survive a reload, export / import, and Reset to measured.
// Usage: node test/rig-calib-page.js <url> [<event folder> <truth.json>]   (without a folder: renders one into /tmp first, ~1 min)
//   env: PW = path of a playwright(-core) package; CHANNEL = chrome to use the installed Chrome (default: Playwright's Chromium)
const fs = require("fs"), path = require("path"), os = require("os"), { execFileSync } = require("child_process");
const R = require("../js/rig.js");
let [URL_, DIR, TRUTH] = process.argv.slice(2);
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, n = 0; const ok = (name, c, x) => { n++; console.log((c ? "PASS " : "FAIL ") + name + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 700) : "")); if (!c) fails++; };
const CAMS = (process.env.CAMS || "front,left_pillar,right_repeater,back").split(",");

function makeTruth(file) {
  const pre = R.preset("model_y");
  const OFF = { front: [2.5, -1.5, 0.8, 1.04], back: [-3, 4, -1.0, 0.97], left_pillar: [-4, 2, 1.2, 1.05], right_pillar: [3, -2.5, -0.7, 0.96], left_repeater: [3.5, 1.5, -1.1, 1.03], right_repeater: [-2.5, -2, 0.9, 1.05] };
  const DELAY = { front: 0.03, back: -0.05, left_pillar: 0.06, right_pillar: -0.02, left_repeater: 0.0, right_repeater: 0.04 }, cams = {};
  for (const c of R.CAMS) { const s = pre.cams[c], o = OFF[c]; cams[c] = Object.assign({}, s, { yaw: s.yaw + o[0], pitch: s.pitch + o[1], roll: s.roll + o[2], f: s.f * o[3], k: [s.k[0] + 0.015, s.k[1] + 0.003, 0], pos: [s.pos[0], s.pos[1] - 0.03, s.pos[2]], thmax: Math.min(s.thmax + 10, 100) }); }
  fs.writeFileSync(file, JSON.stringify({ preset: "model_y", cams, delay: DELAY }, null, 1));
}

(async () => {
  if (!DIR) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigcal-")); TRUTH = path.join(root, "truth.json"); makeTruth(TRUTH);
    DIR = path.join(root, "TeslaCam", "SavedClips", "2026-10-19_10-53-48");
    console.log("rendering a synthetic drive into", DIR);
    execFileSync("python3", [path.join(__dirname, "..", "tools", "rig", "make-footage.py"), TRUTH, DIR, "--sec", "30", "--cams", CAMS.join(",")], { stdio: "inherit" });
  }
  const truth = JSON.parse(fs.readFileSync(TRUTH, "utf8"));
  const pw = require(process.env.PW || "playwright");
  const b = await pw.chromium.launch(Object.assign({ args: ["--autoplay-policy=no-user-gesture-required"] }, process.env.CHANNEL ? { channel: process.env.CHANNEL } : {}));
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true }), p = await ctx.newPage(), errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(URL_ + (URL_.includes("?") ? "&" : "?") + "nosw=1", { waitUntil: "load" });
  await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.rig.v1"); });
  await p.reload({ waitUntil: "load" });
  ok("Settings has a Camera calibration section in Advanced & Labs", await p.evaluate(() => { const s = document.getElementById("rigSec"); return !!s && s.dataset.g === "advanced" && !!document.getElementById("rigCalibrate") && document.getElementById("rigPick").options.length >= 6; }));
  ok("at first the measured Model X is in use", await p.evaluate(() => TDC.rig.current().source === "measured" && /Model X/.test(document.getElementById("rigStatus").textContent)));
  // picking a preset applies it and is remembered
  await p.evaluate(() => { document.getElementById("settings").hidden = false; TDC.settings.show("advanced"); });
  await W(400); await p.evaluate(() => document.getElementById("rigSec").scrollIntoView());
  await p.screenshot({ path: path.join(os.tmpdir(), "rig-calib-settings.png") });
  await p.selectOption("#rigPick", "preset:model_y");
  ok("picking Model Y (estimated) applies its positions", await p.evaluate(() => TDC.rig.current().preset === "model_y" && Math.abs(TDC.rig.get("front").pos[1] - TDC.rig.PRESETS.model_y.pos.front[1]) < 1e-9 && /estimate/.test(document.getElementById("rigStatus").textContent)));

  ok("Calibrate with no drive open says so", await p.evaluate(async () => { await TDC.rigCal.start(); return TDC.rigCal.state === "failed" && /Open a drive/.test(TDC.rigCal.msg); }));
  await p.setInputFiles("#folderInput", path.dirname(path.dirname(DIR)));
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events[0]); }); await W(1500);
  await p.evaluate(() => TDC.player.play && TDC.player.play());

  // run it while the video plays; the page must keep answering
  const t0 = Date.now();
  await p.evaluate(() => { TDC.rigCal.start(); });
  let maxGap = 0, last = Date.now(), st = "running", seen = new Set();
  while (st === "running" && Date.now() - t0 < 20 * 60e3) {
    const a = Date.now(); const s = await p.evaluate(() => ({ st: TDC.rigCal.state, txt: (document.getElementById("rigRunText") || {}).textContent, bar: (document.getElementById("rigBar") || {}).style && document.getElementById("rigBar").style.width }));
    maxGap = Math.max(maxGap, Date.now() - a); st = s.st; if (s.txt && !seen.has(s.txt.replace(/\d+ %.*/, ""))) { seen.add(s.txt.replace(/\d+ %.*/, "")); console.log("   ", s.txt, s.bar); }
    await W(1000); last = Date.now();
  }
  void last;
  console.log(`  calibration took ${((Date.now() - t0) / 1000).toFixed(0)} s; slowest page answer ${maxGap} ms`);
  const res = await p.evaluate(() => { const r = TDC.rigCal.result; return r && { pass: r.pass, quality: r.quality, looks: r.looks, matched: r.matched, cams: Object.fromEntries(Object.entries(r.cams).map(([c, x]) => [c, { ok: x.ok, yaw: x.yaw, pitch: x.pitch, roll: x.roll, f: x.f, delay: x.delay, road: x.road, fit: x.fit, judge: x.judge, tracked: x.tracked, error: x.error }])) }; });
  ok("calibration finished with a result (state done)", st === "done" && !!res, { st, msg: await p.evaluate(() => TDC.rigCal.msg) });
  ok("progress was shown while it ran (tracking, fitting)", [...seen].some((s) => /following points/.test(s)) && [...seen].some((s) => /fitting/.test(s)), [...seen]);
  ok("the page kept answering while it ran (slowest answer under 1.5 s)", maxGap < 1500, maxGap);
  if (res) {
    const wrap = (v) => ((v + 540) % 360) - 180;
    for (const cam of CAMS) {
      const r = res.cams[cam], t = truth.cams[cam];
      const d = r && r.ok ? [wrap(r.yaw - t.yaw), r.pitch - t.pitch, r.roll - t.roll] : null;
      console.log(`  ${cam}: ${r && r.fit ? r.fit.pairs + " pairs, " + r.fit.inliers + "/" + r.fit.matches + " inliers, median " + r.fit.median_px.toFixed(2) + " px" : r && (r.error || (r.judge && r.judge.why))}; Δ ${d && d.map((v) => v.toFixed(2))}; f ${r && r.f && (r.f / t.f).toFixed(4)}; delay ${r && r.delay != null && r.delay.toFixed(3)} (${truth.delay[cam]}); height ${r && r.road && r.road.height.toFixed(2)} (${t.pos[1].toFixed(2)}, ${r && r.road && r.road.method}); ${r && r.tracked && JSON.stringify(r.tracked)}`);
      ok(`${cam}: angles within 0.5° of the known rig, passes the quality gate`, d && d.every((v) => Math.abs(v) < 0.5) && r.judge.pass, { d, judge: r && r.judge });
      ok(`${cam}: height above the road within 6 cm`, r && r.road && Math.abs(r.road.height - t.pos[1]) < 0.06, r && r.road);
    }
    ok("the result says which preset it looks like (a Model Y or Model YL)", res.looks && ["model_y", "model_yl"].includes(res.looks[0].id), res.looks);
  }
  // save → applied, remembered, survives a reload
  const saved = await p.evaluate(() => { const b = document.getElementById("rigSave"); if (!b) return null; document.getElementById("rigName").value = "Test car"; b.click(); return { cur: TDC.rig.current(), st: document.getElementById("rigStatus").textContent, store: JSON.parse(localStorage.getItem("tdc.rig.v1")) }; });
  ok("Save for this car: applied (source calibrated) and stored", saved && saved.cur.source === "calibrated" && /Test car|your calibration/i.test(saved.st + JSON.stringify(saved.store)) && saved.store.active.startsWith("car:"), saved);
  const lp = res && res.cams.left_pillar;
  await p.reload({ waitUntil: "load" });
  const after = await p.evaluate(() => ({ cur: TDC.rig.current(), lp: TDC.rig.get("left_pillar"), pick: document.getElementById("rigPick").value }));
  ok("after a reload the saved calibration is in use again", after.cur.source === "calibrated" && after.pick.startsWith("car:") && (!lp || !lp.ok || Math.abs(after.lp.yaw - lp.yaw) < 1e-6), after);
  // export → import → reset
  const exp = await p.evaluate(() => TDC.rigCal.exportJSON());
  ok("Export gives a camera-set file with the measured cameras", exp.format === "dashcam-studio-rig" && exp.source === "calibrated" && exp.cams && exp.cams.front && isFinite(exp.cams.front.yaw), exp);
  await p.evaluate(() => TDC.rigCal.use("preset:model_x"));
  ok("Reset to measured: the measured Model X again", await p.evaluate(() => TDC.rig.current().source === "measured" && TDC.rig.get("front").yaw === TDC.rig.MEASURED.front.yaw));
  const imp = await p.evaluate((j) => { try { TDC.rigCal.importJSON(j); } catch (e) { return { err: e.message }; } return { cur: TDC.rig.current(), front: TDC.rig.get("front").yaw }; }, exp);
  ok("Import of that file applies it", imp.cur && imp.cur.source === "calibrated" && Math.abs(imp.front - exp.cams.front.yaw) < 1e-9, imp);
  const bad = await p.evaluate(() => { try { TDC.rigCal.importJSON({ hello: 1 }); return null; } catch (e) { return e.message; } });
  ok("Import of a file that isn't a rig is refused with a reason", !!bad && /no cameras/.test(bad), bad);
  ok("no page errors", errs.length === 0, errs);
  await b.close();
  console.log(fails ? `${fails} FAILED of ${n}` : `ALL PASS (${n})`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
