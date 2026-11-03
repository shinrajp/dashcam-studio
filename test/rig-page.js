// Camera rig in the page (js/rig.js + custom-redact.js ho-rig) on a real six-camera event (Chromium / Chrome).
// Loads the event, then checks: the rig is loaded and taken for these pictures, each file's clock comes out of its own telemetry, and
// the hand-off's entry prediction is the road-based one (with the clock shift) for a real object leaving the front camera.
// Usage: node test/rig-page.js <url> <folder with the event's six .mp4> <dets.json from tools/rig/detect-tracks.py>
//   env: PW = path of a playwright(-core) package; CHANNEL = chrome (the installed Chrome) by default
const fs = require("fs"), path = require("path");
const [URL_, DIR, DETS] = process.argv.slice(2);
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, n = 0; const ok = (name, c, x) => { n++; console.log((c ? "PASS " : "FAIL ") + name + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 600) : "")); if (!c) fails++; };
const R = require("../js/rig.js");

(async () => {
  const pw = require(process.env.PW || "playwright");
  const b = await pw.chromium.launch({ channel: process.env.CHANNEL || "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage(), errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(URL_ + (URL_.includes("?") ? "&" : "?") + "nosw=1", { waitUntil: "load" });
  await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.regions.v1"); });
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", DIR);
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events[0]); }); await W(2000);
  await p.evaluate(() => TDC.player.pause());

  const st = await p.evaluate(() => ({ rig: !!(TDC.rig && TDC.rig.predictEntry), cams: TDC.player.ev.cams, info: Object.fromEntries(Object.entries(TDC.player.ev.clips[0].files).map(([c, e]) => [c, e.info && [e.info.width, e.info.height]])) }));
  ok("js/rig.js is loaded in the page", st.rig, st);
  ok("all six cameras in the event, HW4 pictures (the measured shape)", st.cams.length === 6 && R.CAMS.every((c) => st.info[c] && R.ok(c, st.info[c][0], st.info[c][1])), st);

  const clk = await p.evaluate(async () => TDC.rig.clocksFor(TDC.player.ev, 0));
  ok("each file's clock from its own telemetry, in the page (back +0.35 s …) within 10 ms of the offline measure", R.CAMS.every((c) => Math.abs((clk[c] || 0) - R.CLOCK0[c]) < 0.01), clk);

  // a real car leaving the front camera through its left edge (YOLO tracks from tools/rig/detect-tracks.py; clip time = event time here)
  const dets = JSON.parse(fs.readFileSync(DETS, "utf8"));
  const tr = dets.front.filter((t) => t.keys.length >= 8 && t.cls === "car").find((t) => { const L = t.keys[t.keys.length - 1][1]; return L.x < 0.03 && R.predictEntry("front", t.keys, "left_pillar"); });
  ok("a real car leaving the front camera on the left (from the detector's tracks)", !!tr);
  if (tr) {
    const want = R.predictEntry("front", tr.keys, "left_pillar"), shift = R.CLOCK0.front - R.CLOCK0.left_pillar;
    const got = await p.evaluate(async (keys) => TDC.regions.predictEntryRig("front", keys, "left_pillar", "right"), tr.keys);
    ok("hand-off prediction in the page is the road-based one, on the left pillar's clock", got && got.src === "rig" && Math.abs(got.t - (want.t + shift)) < 0.02 && Math.abs(got.box.x - want.box.x) < 1e-6, { got, want: want && want.t, shift });
    const off = await p.evaluate(async (keys) => TDC.regions.predictEntryRig("front", keys.map(([t, b]) => [t, { x: b.x, y: 0.02, w: b.w, h: 0.05 }]), "left_pillar", "right"), tr.keys);
    ok("an object whose feet can't be placed falls back to the direction-only guess (still on the left pillar's clock)", !off || off.src !== "rig", off);
  }
  ok("no page errors", errs.length === 0, errs);
  await b.close();
  console.log(fails ? `${fails} FAILED of ${n}` : `ALL PASS (${n})`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
