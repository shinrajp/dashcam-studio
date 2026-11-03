// In-app camera calibration (js/rig-calib.js) on synthetic data: a known rig, the real drive's car motion
// (test/fixtures/rig-telemetry-2026-10-19.json), a static world of points projected through the known cameras, noise and
// outliers added — the solver must give the rig back. Also: presets (js/rig.js), the tracker, road height by road-surface
// alignment, preset matching. Usage: node test/rig-calib.test.js [--all]   (--all: all six cameras; default four)
const R = require("../js/rig.js"), C = require("../js/rig-calib.js");
let fails = 0, n = 0; const ok = (name, c, x) => { n++; console.log((c ? "PASS " : "FAIL ") + name + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 500) : "")); if (!c) fails++; };
const near = (a, b, e) => Math.abs(a - b) <= e;
const D2R = Math.PI / 180, ALL = process.argv.includes("--all");

// ── presets ──
ok("a preset for every model: Model 3, Model Y, Model YL, Model S, Model X, Cybertruck", ["model_3", "model_y", "model_yl", "model_s", "model_x", "cybertruck"].every((id) => R.PRESETS[id] && R.preset(id)));
ok("only the Model X preset is measured; the others say estimated", R.PRESETS.model_x.measured && Object.keys(R.PRESETS).filter((k) => k !== "model_x").every((k) => !R.PRESETS[k].measured && /estimated/.test(R.PRESETS[k].note)));
ok("the Model X preset is the measured rig (same angles, lenses, positions)", R.CAMS.every((c) => JSON.stringify(R.preset("model_x").cams[c]) === JSON.stringify(R.MEASURED[c])));
ok("presets mirror left and right, and put the cameras inside the car's outline", Object.keys(R.PRESETS).every((id) => { const p = R.preset(id), d = R.PRESETS[id].dims; return p.cams.left_pillar.pos[0] === -p.cams.right_pillar.pos[0] && R.CAMS.every((c) => Math.abs(p.cams[c].pos[0]) < d[1] / 2 + 0.05 && p.cams[c].pos[1] < d[2] && p.cams[c].pos[2] < d[0]); }));
R.set(R.preset("cybertruck"));
ok("set(preset): the Cybertruck's cameras sit higher, its body boxes are used, current() says so", R.get("front").pos[1] > 1.5 && R.bodyBoxes().length === R.PRESETS.cybertruck.body.length && R.current().preset === "cybertruck" && R.current().source === "preset");
ok("…a road point still maps back to where it is with the new positions", (() => { const P = R.pixel("left_pillar", [-4, 0, 3]), g = R.ground("left_pillar", P.u, P.v); return g && near(g.x, -4, 0.01) && near(g.z, 3, 0.01); })());
R.reset();
ok("reset(): back to the measured Model X and its body", R.current().source === "measured" && R.bodyBoxes().length === R.BODY.length && R.get("front").pos[1] === R.MEASURED.front.pos[1]);
const cp = R.closestPreset({ front: 1.31, back: 0.99, left_pillar: 1.34, right_pillar: 1.29, left_repeater: 1.0, right_repeater: 0.97 });
ok("closest preset: the measured Model X heights look like a Model X", cp[0].id === "model_x" && cp[0].rms < 0.03, cp.slice(0, 2));
ok("…Cybertruck heights look like a Cybertruck, Model 3 heights like a Model 3", R.closestPreset({ front: 1.63, back: 1.1, left_pillar: 1.46, left_repeater: 1.13 })[0].id === "cybertruck" && R.closestPreset({ front: 1.17, back: 0.94, left_pillar: 1.1, right_repeater: 0.87 })[0].id === "model_3");
ok("clock(): a calibrated camera's picture delay is added to its file offset", (() => { R.set({ cams: { back: Object.assign({}, R.MEASURED.back, { delay: 0.04 }) } }); const v = R.clock("back", { front: 0, back: 0.3 }); R.reset(); return near(v, 0.34, 1e-9) && R.clock("back", { front: 0, back: 0.3 }) === 0.3; })());

// ── the car's path from the telemetry ──
const FX = require("./fixtures/rig-telemetry-2026-10-19.json");
const rows = FX.cams.front.map(([t, v, h]) => [t, v, h]), path = C.Path(rows), st = C.driveStats(rows);
ok("the fixture drive: moving most of the minute, two right-angle turns", st.movingS > 40 && st.turnDeg > 150 && st.bestTurnDeg > 70, st);
const m = path.rel(20, 21);
ok("path: one second's move matches the speed, along the car's forward axis", near(Math.hypot(m.T[0], m.T[2]), path.speed(20.5), 0.15) && m.T[2] > 0.9 * Math.hypot(m.T[0], m.T[2]), { m, v: path.speed(20.5) });

// ── tracker: a textured picture moved by a known sub-pixel shift ──
const tex = (x, y) => 128 + 40 * Math.sin(x * 0.31 + Math.sin(y * 0.17) * 2) + 30 * Math.sin(y * 0.23 + x * 0.05) + 25 * Math.sin((x + y) * 0.71) * Math.cos(x * 0.13 - y * 0.29);
const W0 = 240, H0 = 160, img = (dx, dy) => { const g = new Float32Array(W0 * H0); for (let y = 0; y < H0; y++) for (let x = 0; x < W0; x++) g[y * W0 + x] = tex(x - dx, y - dy); return g; };
const tk = C.Tracker({ max: 80 }); tk.push(img(0, 0), W0, H0); tk.push(img(3.4, -1.7), W0, H0);
const f0 = tk.frames[0], f1 = tk.frames[1], errs = [];
for (let i = 0; i < f1.ids.length; i++) { const k = f0.ids.indexOf(f1.ids[i]); if (k >= 0) errs.push(Math.hypot(f1.x[i] - f0.x[k] - 3.4, f1.y[i] - f0.y[k] + 1.7)); }
ok("tracker: corners found and followed across a (3.4, −1.7) px shift within 0.05 px (median)", errs.length > 30 && C.median(errs) < 0.05, { n: errs.length, med: C.median(errs) });

// ── a synthetic drive: a known rig, the fixture's car motion, a static world ──
const W = 724, H = Math.round(W * R.ASPECT), rnd = C.rng(11);
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const fps = 15, t0 = rows[0][0] + 0.5, t1 = rows[rows.length - 1][0] - 0.5, ftimes = []; for (let t = t0; t < t1; t += 1 / fps) ftimes.push(t);
// world points: along the route, kerbside clutter (walls, poles, parked cars) and the road itself
const world = [];
for (let t = t0 - 3; t < t1 + 3; t += 0.12) {
  const p = path.pose(t), fx = Math.sin(p.h), fz = Math.cos(p.h), rx = Math.cos(p.h), rz = -Math.sin(p.h);
  for (let k = 0; k < 6; k++) {
    const side = rnd() < 0.5 ? -1 : 1, lat = side * (3 + 22 * rnd() ** 1.5), up = rnd() < 0.3 ? 0 : 6 * rnd(), ah = (rnd() - 0.5) * 3;
    world.push([p.e + rx * lat + fx * ah, up, p.n + rz * lat + fz * ah]);
  }
  for (let k = 0; k < 3; k++) { const lat = (rnd() - 0.5) * 16, ah = (rnd() - 0.5) * 3; world.push([p.e + rx * lat + fx * ah, 0, p.n + rz * lat + fz * ah]); }
}
// body pitch / roll on the suspension: a slow random walk of ~0.1°
const bodyP = [], bodyR = []; let bp = 0, br = 0; for (let i = 0; i < ftimes.length; i++) { const bs = process.env.NOBODY ? 0 : 0.03; bp = 0.95 * bp + bs * D2R * gauss(); br = 0.95 * br + bs * D2R * gauss(); bodyP.push(bp); bodyR.push(br); }
function observe(cam, truth, delay, noise) {
  const Rc = C.rot3(truth.yaw * D2R, truth.pitch * D2R, truth.roll * D2R), frames = [];
  for (let i = 0; i < ftimes.length; i++) {
    const p = path.pose(ftimes[i] + delay), Rb = C.rot3(0, bodyP[i], bodyR[i]), ids = [], xs = [], ys = [];
    for (let id = 0; id < world.length; id++) {
      const Wp = world[id], de = Wp[0] - p.e, dn = Wp[2] - p.n;
      const Xr = [de * Math.cos(p.h) - dn * Math.sin(p.h), Wp[1], de * Math.sin(p.h) + dn * Math.cos(p.h)];   // road-level car axes
      const Xb = [Rb[0] * Xr[0] + Rb[3] * Xr[1] + Rb[6] * Xr[2], Rb[1] * Xr[0] + Rb[4] * Xr[1] + Rb[7] * Xr[2], Rb[2] * Xr[0] + Rb[5] * Xr[1] + Rb[8] * Xr[2]];   // body axes
      const d = [Xb[0] - truth.pos[0], Xb[1] - truth.pos[1], Xb[2] - truth.pos[2]]; if (Math.hypot(d[0], d[2]) < 1.5 || Math.hypot(...d) > 45) continue;
      const b = [Rc[0] * d[0] + Rc[3] * d[1] + Rc[6] * d[2], Rc[1] * d[0] + Rc[4] * d[1] + Rc[7] * d[2], Rc[2] * d[0] + Rc[5] * d[1] + Rc[8] * d[2]];
      const q = C.project(b, truth.f, truth.cx, truth.cy, truth.k[0], truth.k[1], R.ASPECT);
      if (q.th > truth.thmax * D2R || q.u < 0.02 || q.u > 0.98 || q.v < 0.02 || q.v > 0.98) continue;
      let x = q.u * W + noise * gauss(), y = q.v * H + noise * gauss();
      if (!process.env.NOOUT && rnd() < 0.04) { x += 6 * gauss(); y += 6 * gauss(); }   // a few bad tracks (moving cars, reflections)
      ids.push(id); xs.push(x); ys.push(y);
    }
    frames.push({ ids: Int32Array.from(ids), x: Float32Array.from(xs), y: Float32Array.from(ys) });
  }
  return frames;
}
// the car: a Model Y (preset positions), its cameras mounted a few degrees off the Model X's, lenses a little different
const OFF = { front: [2.5, -1.5, 0.8, 1.04], back: [-3, 4, -1.0, 0.97], left_pillar: [-4, 2, 1.2, 1.05], right_pillar: [3, -2.5, -0.7, 0.96], left_repeater: [3.5, 1.5, -1.1, 1.03], right_repeater: [-2.5, -2, 0.9, 1.05] };
const DELAY = { front: 0.03, back: -0.05, left_pillar: 0.06, right_pillar: -0.02, left_repeater: 0.0, right_repeater: 0.04 };
const pre = R.preset("model_y"), cams = process.env.CAMS ? process.env.CAMS.split(",") : ALL ? R.CAMS : ["front", "back", "left_pillar", "right_repeater"], got = {};
for (const cam of cams) {
  const s = pre.cams[cam], o = OFF[cam];
  const truth = Object.assign({}, s, { yaw: s.yaw + o[0], pitch: s.pitch + o[1], roll: s.roll + o[2], f: s.f * o[3], k: [s.k[0] + 0.015, s.k[1] + 0.003, 0], pos: [s.pos[0], s.pos[1] - 0.03, s.pos[2]], thmax: Math.min(s.thmax + 10, 100) });
  const frames = observe(cam, truth, DELAY[cam], +(process.env.NOISE || 0.12)), tic = Date.now();
  const r = C.calibrateTracked(frames, ftimes, path, s, W, H, { wFull: cam === "front" ? 2896 : 1448, back: cam === "back", pairs: process.env.PP ? { perPair: +process.env.PP, maxPairs: +process.env.MP } : undefined });
  got[cam] = r;
  const wrap = (v) => ((v + 540) % 360) - 180, da = r.ok ? [wrap(r.yaw - truth.yaw), r.pitch - truth.pitch, r.roll - truth.roll].map((v) => +v.toFixed(3)) : null;
  console.log(`  ${cam}: ${Date.now() - tic} ms, ${r.fit ? r.fit.pairs + " pairs, " + r.fit.matches + " matches, median " + r.fit.median_track_px.toFixed(3) + " px (tracked) / " + r.fit.median_px.toFixed(2) + " px (full)" : r.why}; Δ yaw/pitch/roll ${da}; f ${r.f && (r.f / truth.f).toFixed(4)}; delay ${r.delay && r.delay.toFixed(3)} (true ${DELAY[cam]}); height ${r.road && r.road.height.toFixed(3)} (true ${truth.pos[1].toFixed(3)}, ${r.road && r.road.method})`);
  ok(`${cam}: yaw, pitch, roll recovered within 0.5° (started ${Math.max(...o.slice(0, 3).map(Math.abs))}° off)`, r.ok && da.every((v) => Math.abs(v) < 0.5), da);
  ok(`${cam}: lens width within 1.5 %, telemetry delay within 20 ms, fit passes the quality gate`, r.ok && near(r.f / truth.f, 1, 0.015) && near(r.delay, DELAY[cam], 0.02) && r.judge.pass, r.ok && { f: r.f / truth.f, delay: r.delay, judge: r.judge });
  ok(`${cam}: height above the road from triangulated road points within 5 cm`, r.roadPoints && near(r.roadPoints.height, truth.pos[1], 0.05), r.roadPoints);
}

// ── road height by road-surface alignment, on rendered pictures of a textured road ──
{
  const cam = "left_pillar", s = pre.cams[cam], truth = Object.assign({}, s, { pos: [s.pos[0], 1.31, s.pos[2]] }), Rc = C.rot3(truth.yaw * D2R, truth.pitch * D2R, truth.roll * D2R);
  const road = (e, nn) => 110 + 50 * Math.sin(e * 7.1 + Math.sin(nn * 3.3) * 2) * Math.cos(nn * 5.3 - e * 1.7) + 30 * Math.sin((e + nn) * 13.7);
  const render = (fi) => {
    const p = path.pose(ftimes[fi]), g = new Float32Array(W * H), b = [0, 0, 0];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      C.unproject(x / W, y / H, truth.f, truth.cx, truth.cy, truth.k[0], truth.k[1], R.ASPECT, b, 0);
      const d = [Rc[0] * b[0] + Rc[1] * b[1] + Rc[2] * b[2], Rc[3] * b[0] + Rc[4] * b[1] + Rc[5] * b[2], Rc[6] * b[0] + Rc[7] * b[1] + Rc[8] * b[2]];
      if (d[1] > -0.01) { g[y * W + x] = 200; continue; }
      const sR = -truth.pos[1] / d[1], cx = truth.pos[0] + sR * d[0], cz = truth.pos[2] + sR * d[2];
      g[y * W + x] = road(p.e + cx * Math.cos(p.h) + cz * Math.sin(p.h), p.n - cx * Math.sin(p.h) + cz * Math.cos(p.h));
    }
    return g;
  };
  const pairs = C.roadPairs(ftimes, path, { every: 40, max: 4 }), imgs = new Map();
  for (const [i, j] of pairs) { imgs.set(i, render(i)); imgs.set(j, render(j)); }
  const fitCam = Object.assign({}, truth, { delay: 0 });
  const hr = C.heightFromRoad(imgs, pairs, W, H, ftimes, path, fitCam, null);
  ok("road-surface alignment: a pillar 1.31 m above a plain textured road measured within 3 cm", hr && near(hr.height, 1.31, 0.03) && hr.pairs >= 2, hr);
}

// ── quality gate refuses a poor fit ──
ok("quality gate: a fit with a 2 px median error, or with no turn, is refused", !C.judge({ ok: true, fit: { pairs: 200, turning: 30, inlierShare: 0.9, atBound: [], median_px: 2 } }).pass && !C.judge({ ok: true, fit: { pairs: 200, turning: 0, inlierShare: 0.9, atBound: [], median_px: 0.3 } }).pass && C.judge({ ok: true, fit: { pairs: 200, turning: 30, inlierShare: 0.9, atBound: [], median_px: 0.3 } }).pass);
// a straight drive alone can't fix the lens: refuse it
{
  const straight = rows.map(([t, v]) => [t, Math.max(v, 6), -112]), sp = C.Path(straight);
  ok("a drive with no turn is called out (best 15 s turn under 10°)", C.driveStats(straight).bestTurnDeg < 10);
  void sp;
}
// the measured heights point at the right preset
const hs = {}; for (const cam of cams) if (got[cam] && got[cam].road) hs[cam] = got[cam].road.height;
const guess = R.closestPreset(hs);
ok("from the recovered heights, the synthetic Model Y looks like a Model Y (Model YL is within a few cm: either may come first)", guess.length && guess.slice(0, 2).some((g) => g.id === "model_y") && ["model_y", "model_yl"].includes(guess[0].id), guess.slice(0, 3));

console.log(fails ? `${fails} FAILED of ${n}` : `ALL PASS (${n})`);
process.exit(fails ? 1 : 0);
