// 3D view (debug, js/view3d.js) on a real drive: two labelled hand-offs (test/fixtures/handoff-labels.json) become tracked objects, each
// seen by two cameras; the 3D view opens and draws the car path, the six fields of view, both objects with each camera's estimate.
// Checks: the chip shows only in debug mode, the panel opens / closes, the car path comes from telemetry, both objects are placed
// (each camera's estimate within 6 m of the other at the hand-off), the three camera views draw, no page errors.
// Usage: node test/view3d-page.js <url> <folder with the 2026-10-19 drive's six .mp4>   env: PW = playwright(-core), SHOTS = dir for screenshots
const fs = require("fs"), path = require("path");
const [URL_, DIR] = process.argv.slice(2);
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/handoff-labels.json"), "utf8")).cases.filter((c) => c.drive === "10-19");
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };

(async () => {
  const pw = require(process.env.PW || "playwright");
  const b = await pw.chromium.launch({ channel: process.env.CHANNEL || "chrome" });
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage(), errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(URL_ + "?nosw=1&debug=0", { waitUntil: "load" });
  await p.evaluate(() => { localStorage.removeItem("tdc.regions.v1"); localStorage.removeItem("tdc.view3d"); });
  await p.reload({ waitUntil: "load" });
  ok(!(await p.isVisible("#chip3d")), "the 3D chip is hidden outside debug mode");
  await p.goto(URL_ + "?nosw=1&debug=1", { waitUntil: "load" });
  await p.setInputFiles("#folderInput", DIR);
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => { TDC.ui.activate(TDC.library.events[0]); }); await W(1500);
  await p.evaluate(() => TDC.player.pause());
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.telemetry.status)) !== "done"; i++) await W(250);
  await p.evaluate(async () => { await TDC.rig.clocksFor(TDC.player.ev, 0); });
  // two labelled hand-offs → two objects, each a mark on the camera it leaves and one on the camera it enters
  const picks = [FX[9], FX[7]];
  await p.evaluate((picks) => {
    const G = TDC.regions, flat = (K) => { const a = []; for (const k of K) a.push(k[0], k[1], k[2], k[3], k[4]); return a; };
    picks.forEach((c, i) => {
      const k0 = c.exit[0], tr = c.truth[0], k1 = tr[0];
      const a = G.clean({ cam: c.cam, mode: "mark", x: k0[1], y: k0[2], w: k0[3], h: k0[4], path: flat(c.exit) });
      const b = G.clean({ cam: c.to, mode: "mark", x: k1[1], y: k1[2], w: k1[3], h: k1[4], path: flat(tr) });
      a.ci = i; b.ci = i; b.link = a.id; G.list.push(a, b);
    });
    G.save(); TDC.emit("regions", G.list.length);
  }, picks);
  ok(await p.isVisible("#chip3d"), "the 3D chip shows in debug mode");
  await p.click("#chip3d"); await W(300);
  ok(await p.isVisible("#view3d"), "the panel opens");
  const shots = process.env.SHOTS;
  for (const [ci, c] of picks.entries()) {
    const t = Math.min(c.exit[c.exit.length - 1][0], c.truth[0][c.truth[0].length - 1][0]) - 0.15;
    await p.evaluate((t) => TDC.player.seek(t), t); await W(600);
    const r = await p.evaluate((ci) => {
      const V = TDC.view3d, P = (() => { const tel = TDC.telemetry, ev = tel.event, rows = []; ev.clips.forEach((c, i) => { const tr = tel.tracks[i]; if (tr) for (let k = 0; k < tr.n; k++) rows.push([c.start + tr.pts[k], tr.msgs[k].speed, tr.msgs[k].heading]); }); return V.egoPath(rows.sort((a, b) => a[0] - b[0])); })();
      const G = TDC.regions, PT = TDC.patchTrack, t = TDC.player.time, est = [];
      for (const r of G.list.filter((r) => r.ci === ci)) { const b = PT.pathAt(r.path, t); const f = b && TDC.rig.footprint(r.cam, b, 80); if (f) { const w = V.toWorld(V.poseAt(P, t + TDC.rig.clock(r.cam)), f.x, f.z); est.push({ cam: r.cam, x: w[0], z: w[1], d: f.dist }); } }
      return { n: P.n, len: Math.hypot(P.x[P.n - 1], P.z[P.n - 1]), est, info: document.getElementById("v3dInfo").textContent };
    }, ci);
    console.log(`object ${ci + 1} at ${t.toFixed(2)} s:`, r.est.map((e) => `${e.cam} ${e.d.toFixed(1)} m`).join(", "), r.est.length === 2 ? `→ ${Math.hypot(r.est[0].x - r.est[1].x, r.est[0].z - r.est[1].z).toFixed(1)} m apart` : "", "|", r.info);
    if (ci === 0) { ok(r.n > 100 && r.len > 50, "the car path comes from telemetry (" + r.n + " rows, " + r.len.toFixed(0) + " m)"); ok(/Camera geometry: .*· 2 tracked/.test(r.info), "the info line names the rig and counts 2 objects"); }
    ok(r.est.length === 2 && Math.hypot(r.est[0].x - r.est[1].x, r.est[0].z - r.est[1].z) < 6, "object " + (ci + 1) + ": both cameras place it, within 6 m of each other");
    for (const v of ["chase", "top", "orbit"]) {
      await p.click(`#view3d [data-v=${v}]`); await W(250);
      const lit = await p.evaluate(() => { const c = document.getElementById("v3dCanvas"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 16) if (d[i] + d[i + 1] + d[i + 2] > 120) n++; return n / (d.length / 16); });
      ok(lit > 0.01, `${v} view draws (${(lit * 100).toFixed(1)} % lit)`);
      if (shots) await p.screenshot({ path: path.join(shots, `view3d-${ci + 1}-${v}.png`), clip: await p.evaluate(() => { const r = document.getElementById("view3d").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }) });
    }
  }
  await p.click("#v3dClose"); await W(200);
  ok(!(await p.isVisible("#view3d")), "the panel closes");
  ok(!errs.length, "no page errors: " + errs.join(" | "));
  console.log(`view3d-page: ${pass} pass, ${fail} fail`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
