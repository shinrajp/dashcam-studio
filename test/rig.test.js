// Camera rig (js/rig.js) — measured lens + mounting, picture ↔ road, body, entry prediction, clocks. Usage: node test/rig.test.js
const R = require("../js/rig.js");
let fails = 0, n = 0; const ok = (name, c, x) => { n++; console.log((c ? "PASS " : "FAIL ") + name + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 400) : "")); if (!c) fails++; };
const near = (a, b, e) => Math.abs(a - b) <= e;

// ── lens: picture → ray → picture ──
let worst = 0;
for (const cam of R.CAMS) for (let i = 1; i < 10; i++) for (let j = 1; j < 10; j++) {
  const d = R.ray(cam, i / 10, j / 10); if (!d) continue;
  const c = R.get(cam), p = R.pixel(cam, [c.pos[0] + 5 * d[0], c.pos[1] + 5 * d[1], c.pos[2] + 5 * d[2]]);
  worst = Math.max(worst, Math.hypot(p.u - i / 10, p.v - j / 10));
}
ok("ray → pixel round trip on every camera (9 × 9 points)", worst < 1e-6, worst);
ok("picture centres point where the cameras were measured to (front ahead, back behind, sides out)", near(R.bearing("front", 0.5, 0.5), 0, 1.5) && Math.abs(R.bearing("back", 0.5, 0.5)) > 175 && near(R.bearing("left_pillar", 0.5, 0.5), -70, 2) && near(R.bearing("right_pillar", 0.5, 0.5), 71, 2) && near(R.bearing("left_repeater", 0.5, 0.5), -140, 2) && near(R.bearing("right_repeater", 0.5, 0.5), 140, 2));
ok("left and right cameras are mirror images (yaw within 1.5°, height within 0.1 m)", near(-R.get("left_pillar").yaw, R.get("right_pillar").yaw, 1.5) && near(-R.get("left_repeater").yaw, R.get("right_repeater").yaw, 1.5) && near(R.get("left_pillar").pos[1], R.get("right_pillar").pos[1], 0.1) && near(R.get("left_repeater").pos[1], R.get("right_repeater").pos[1], 0.1));
ok("no lens folds inside its measured reach (radius keeps growing)", R.CAMS.every((cam) => { const c = R.get(cam); let prev = -1; for (let th = 0; th <= c.thmax; th += 0.5) { const t = th * Math.PI / 180, t2 = t * t, r = t * (1 + t2 * (c.k[0] + t2 * (c.k[1] + t2 * c.k[2]))); if (r <= prev) return false; prev = r; } return true; }));
ok("rays straight up / behind the lens give no picture position", R.pixel("front", [0, 50, 1.9]) === null && R.pixel("front", [0, 1.3, -20]) === null);

// ── road ──
const fc = R.get("front");
let g = R.ground("front", 0.5, 0.9);
ok("front, bottom middle of the picture: the road a few metres ahead, straight on", g && g.z > 4 && g.z < 9 && near(g.x, 0, 0.3), g);
ok("above the horizon there is no road", R.ground("front", 0.5, 0.3) === null);
const P = R.pixel("left_pillar", [-4, 0, 2]), g2 = R.ground("left_pillar", P.u, P.v);
ok("a road point seen by the left pillar maps back to where it is (cm)", g2 && near(g2.x, -4, 0.01) && near(g2.z, 2, 0.01), g2);

// ── boxes: where it stands, how big ──
let b = R.boxAt("front", -2.5, 12, 1.5, 1.8), f = b && R.footprint("front", b);
ok("a car 12 m ahead, 2.5 m left: its box gives back where it stands and its size", f && near(f.x, -2.5, 0.15) && near(f.z, 12, 0.3) && near(f.hM, 1.5, 0.1) && near(f.wM, 1.8, 0.25), { b, f });
ok("size check: that box is a car's height (≈1), a person's would be off", near(R.sizeRatio("front", b, "car"), 1, 0.1) && R.sizeRatio("front", b, "person") < 0.95);
b = R.boxAt("back", 0.5, -8, 1.7, 0.6); f = b && R.footprint("back", b);
ok("a person 7 m behind in the back fisheye: placed within 0.3 m, height within 0.15 m", f && near(f.z, -8, 0.3) && near(f.x, 0.5, 0.3) && near(f.hM, 1.7, 0.15), { b, f });
ok("a box whose foot is cut off by the bottom edge has no footprint", R.footprint("front", { x: 0.4, y: 0.6, w: 0.2, h: 0.4 }) === null);

// ── the car's own body ──
ok("body: the front camera sees none of the car; the repeaters see the car's side at their inner edge", R.bodyShare("front", { x: 0, y: 0, w: 1, h: 1 }) === 0 && R.bodyShare("left_repeater", { x: 0, y: 0.5, w: 0.05, h: 0.5 }) > 0.3 && R.bodyShare("right_repeater", { x: 0.95, y: 0.5, w: 0.05, h: 0.5 }) > 0.3 && R.bodyShare("left_repeater", { x: 0.6, y: 0.3, w: 0.2, h: 0.3 }) === 0);
ok("body: the back camera sees the bumper at the bottom of its picture", R.bodyShare("back", { x: 0.4, y: 0.93, w: 0.2, h: 0.07 }) > 0.5);

// ── coverage round the car ──
const cov = R.coverage(8), seenBy = (b) => (cov.find((c) => c.bearing === b) || { cams: [] }).cams;
ok("8 m out: ahead = front, behind = back, left = left pillar, right = right pillar", seenBy(0).includes("front") && seenBy(-180).includes("back") && seenBy(-90).includes("left_pillar") && seenBy(90).includes("right_pillar"), cov.filter((c) => [0, -180, -90, 90].includes(c.bearing)));
ok("neighbours overlap: pillars ∩ repeaters, repeaters ∩ back, on both sides", cov.some((c) => c.cams.includes("left_pillar") && c.cams.includes("left_repeater")) && cov.some((c) => c.cams.includes("right_pillar") && c.cams.includes("right_repeater")) && cov.some((c) => c.cams.includes("left_repeater") && c.cams.includes("back")) && cov.some((c) => c.cams.includes("right_repeater") && c.cams.includes("back")));
ok("blind wedges between the front and each pillar (no camera sees the road ~25° off ahead at 8 m)", seenBy(-25).length === 0 && seenBy(25).length === 0);
console.log("  coverage at 8 m:", cov.map((c) => c.bearing + ":" + c.cams.map((k) => ({ front: "F", back: "B", left_pillar: "LP", right_pillar: "RP", left_repeater: "LR", right_repeater: "RR" })[k]).join("+")).join(" "));

// ── entry prediction: a parked car slides past as we drive ──
// we drive at 8 m/s; a parked car 3.5 m to the left starts 14 m ahead: relative to us it moves back at 8 m/s
const sim = (cam, x, z0, vz, t0, t1, hM, wM) => { const keys = []; for (let t = t0; t <= t1 + 1e-9; t += 1 / 30) { const bx = R.boxAt(cam, x, z0 + vz * t, hM, wM); if (bx) keys.push([+t.toFixed(4), bx]); } return keys; };
const firstIn = (cam, x, z0, vz, hM, wM) => { for (let t = 0; t < 10; t += 1 / 300) if (R.boxAt(cam, x, z0 + vz * t, hM, wM)) return t; return null; };
let keys = sim("front", -3.5, 14, -8, 0, 10, 1.5, 1.9); const lastF = keys[keys.length - 1][0];
let pr = R.predictEntry("front", keys, "left_pillar"), truth = firstIn("left_pillar", -3.5, 14, -8, 1.5, 1.9);
ok("parked car leaving the front camera: entry into the left pillar predicted to within 2 frames", pr && truth != null && Math.abs(pr.t - truth) < 2 / 30 + 1e-6, { pr: pr && pr.t, truth, lastF });
ok("…with the box where it comes in (its middle within 0.05 of the picture)", pr && (() => { const tb = R.boxAt("left_pillar", -3.5, 14 - 8 * truth, 1.5, 1.9); return tb && Math.abs((pr.box.x + pr.box.w / 2) - (tb.x + tb.w / 2)) < 0.05; })(), pr && pr.box);
keys = sim("left_pillar", -3.5, 14, -8, 0, 10, 1.5, 1.9);
pr = R.predictEntry("left_pillar", keys, "left_repeater"); truth = firstIn("left_repeater", -3.5, 14, -8, 1.5, 1.9);
ok("…and on from the left pillar into the left repeater (overlap: it may already be in view)", pr && truth != null && Math.abs(pr.t - Math.max(truth, keys[keys.length - 1][0])) < 3 / 30, { pr: pr && pr.t, truth, last: keys[keys.length - 1][0] });
keys = sim("back", 1.2, -6, -5, 0, 10, 1.5, 1.9);   // a car dropping back behind us, a lane to the right
pr = R.predictEntry("back", keys, "left_repeater");
ok("an object that never reaches the other camera gives no entry", pr === null, pr);
ok("too few looks, or feet the road can't place, give no prediction", R.predictEntry("front", keys.slice(0, 2), "left_pillar") === null && R.predictEntry("front", [[0, { x: 0.4, y: 0.1, w: 0.1, h: 0.05 }], [0.1, { x: 0.38, y: 0.1, w: 0.1, h: 0.05 }], [0.2, { x: 0.36, y: 0.1, w: 0.1, h: 0.05 }]], "left_pillar") === null);

// ── clocks: the six files of a clip don't start together ──
const T = require("./fixtures/rig-telemetry-2026-10-19.json");
const rows = {}; for (const cam of R.CAMS) rows[cam] = T.cams[cam].map(([t, speed, heading]) => [t, { speed, heading }]);
const off = R.clockOffsets(rows);
const want = { back: 0.348, left_pillar: 0.067, right_pillar: 0.177, left_repeater: -0.027, right_repeater: -0.03 };
ok("real drive: each file's offset from its own telemetry (back +0.35 s, right pillar +0.18 s, …) within 10 ms", Object.keys(want).every((c) => near(off[c], want[c], 0.01)) && off.front === 0, off);
const shifted = {}; for (const cam of R.CAMS) shifted[cam] = rows[cam].map(([t, m]) => [t + (cam === "left_pillar" ? -0.25 : 0), m]);
ok("a file that starts 0.25 s later shows 0.25 s more offset", near(R.clockOffsets(shifted).left_pillar - off.left_pillar, 0.25, 0.01));
const still = {}; for (const cam of R.CAMS) still[cam] = rows[cam].map(([t]) => [t, { speed: 0, heading: 90 }]);
ok("parked: nothing to line up, only the reference is known", JSON.stringify(R.clockOffsets(still)) === JSON.stringify({ front: 0 }));
ok("clock(cam) reads given offsets, 0 when unknown", R.clock("back", off) === off.back && R.clock("back", {}) === 0);

// ── replacing the rig ──
const took = R.set({ cams: { front: Object.assign({}, R.MEASURED.front, { yaw: 5, road: { height: 1.5 } }), back: { yaw: "x" } } });
ok("set(): takes a valid camera (with its measured road height), skips a broken one; reset() restores", took.join() === "front" && R.get("front").yaw === 5 && R.get("front").pos[1] === 1.5 && (R.reset(), R.get("front").yaw === R.MEASURED.front.yaw));
ok("ok(): a picture of another shape (HW3 1280×960) is not the measured rig", R.ok("front", 1448, 938) && R.ok("front", 2896, 1876) && !R.ok("front", 1280, 960));

console.log(fails ? `${fails} FAILED of ${n}` : `ALL PASS (${n})`);
process.exit(fails ? 1 : 0);
