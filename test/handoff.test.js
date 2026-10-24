// Hand-off cue + people registry — pure logic (tags handoff-m2, handoff-m4). Usage: node test/handoff.test.js
const H = require("../js/handoff.js"), PE = require("../js/people.js");
let fails = 0, n = 0; const ok = (name, c, x) => { n++; console.log((c ? "PASS " : "FAIL ") + name + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 400) : "")); if (!c) fails++; };

// ── adjacency: fixed physical table ──
const want = { "front/left": "left_pillar/right", "front/right": "right_pillar/left", "right_pillar/left": "front/right", "right_pillar/right": "right_repeater/left",
  "right_repeater/left": "right_pillar/right", "right_repeater/right": "back/left", "back/left": "right_repeater/right", "back/right": "left_repeater/left",
  "left_repeater/left": "back/right", "left_repeater/right": "left_pillar/left", "left_pillar/left": "left_repeater/right", "left_pillar/right": "front/left" };
const got = {}; for (const p of H.pairs()) got[p.from + "/" + p.exit] = p.to + "/" + p.entry;
ok("adjacency table: 12 exits, each with the right neighbour and entry edge", JSON.stringify(got) === JSON.stringify(want), got);
ok("adjacency is symmetric (leave A→B at an edge: B's opposite exit leads back to A)", H.pairs().every((p) => { const back = H.entryFor(p.to, p.entry); return back && back.to === p.from && back.entry === p.exit; }));
ok("pillar↔repeater on each side, left_pillar↔front↔right_pillar, repeater↔back↔repeater", H.entryFor("left_pillar", "left").to === "left_repeater" && H.entryFor("right_pillar", "right").to === "right_repeater" && H.entryFor("left_pillar", "right").to === "front" && H.entryFor("front", "right").to === "right_pillar" && H.entryFor("right_repeater", "right").to === "back" && H.entryFor("back", "right").to === "left_repeater");
ok("a walk around the car visits every camera once and returns (chain is a ring of 6)", (() => { let c = "front", seen = []; for (let i = 0; i < 6; i++) { seen.push(c); c = H.entryFor(c, "right").to; } return c === "front" && new Set(seen).size === 6; })());
ok("adjacency does not depend on layout: a function of camera + raw side only", H.entryFor.length === 2);

// ── exit prediction ──
const tr = (o) => Object.assign({ x: 0.5, y: 0.3, w: 0.08, h: 0.3, vx: 0, vy: 0, n: 3, seen: 10, t: 10 }, o);
let c = H.predictExit("right_repeater", tr({ x: 0.8, vx: 0.15 }), 10);
ok("walking right, 0.12 from the edge at 0.15/s → exit right in 0.8 s, REAR left edge", c && c.side === "right" && c.to === "back" && c.entry === "left" && Math.abs(c.eta - 0.8) < 0.01, c);
c = H.predictExit("back", tr({ x: 0.1, vx: -0.2 }), 10);
ok("walking left in REAR → RIGHT REPEATER's right edge", c && c.to === "right_repeater" && c.entry === "right", c);
ok("standing still / slow → no cue", H.predictExit("back", tr({ x: 0.9, vx: 0.01 }), 10) === null);
ok("moving inwards from the right edge (towards the far left edge) → no cue", H.predictExit("back", tr({ x: 0.9, vx: -0.2 }), 10) === null);
ok("far from the edge (0.4 away at 0.1/s = 4 s) → no cue yet", H.predictExit("front", tr({ x: 0.5, vx: 0.1 }), 10) === null);
ok("box already against the edge and moving out → immediate cue", (c = H.predictExit("front", tr({ x: 0.9, w: 0.1, vx: 0.08 }), 10)) && c.eta === 0 && c.to === "right_pillar");
ok("a single sighting (n=1, no speed) → no cue; stale track → no cue", H.predictExit("front", tr({ x: 0.9, vx: 0.3, n: 1 }), 10) === null && H.predictExit("front", tr({ x: 0.9, vx: 0.3 }), 20) === null);
ok("lag: the box is as of its last look, it has moved on since", (c = H.predictExit("front", tr({ x: 0.7, vx: 0.2, t: 9.5, seen: 9.5 }), 10)) && Math.abs(c.eta - (0.22 / 0.2 - 0.5)) < 0.01, c);
ok("scheduler boost: the neighbour of an imminent exit is looked at sooner, others not", H.camBoost("back", [{ to: "back", strength: 1 }]) > 2 && H.camBoost("front", [{ to: "back", strength: 1 }]) === 1);

// ── people registry: one id/colour per walker across cameras ──
const hist = (k) => { const a = new Array(8).fill(0.02); a[k] = 0.86; return a; };   // a "clothing colour" fingerprint: person k has colour bin k
const T0 = (o) => Object.assign({ x: 0.4, y: 0.3, w: 0.08, h: 0.3, vx: 0.15, vy: 0, n: 4, conf: 0.6 }, o);
const reg = () => new PE.Registry();
{ // RR → REAR hand-off, same person, ~1 s apart
  const R = reg(); const out0 = R.update([T0({ cam: "right_repeater", id: "RR1", x: 0.88, seen: 10, first: 7, hist: hist(2) })], 10);
  const out1 = R.update([T0({ cam: "back", id: "B1", x: 0.04, seen: 11, first: 10.8, hist: hist(2), n: 2 })], 11);
  ok("hand-off RR→REAR: same global id and colour, labelled best guess with a confidence", out1[0].gid === out0[0].gid && out1[0].color === out0[0].color && out1[0].bestGuess === true && out1[0].linkConf > 0.3, [out0[0], out1[0]]);
}
{ // different clothing → not linked even though the geometry fits
  const R = reg(); const a = R.update([T0({ cam: "right_repeater", id: "RR1", x: 0.88, seen: 10, first: 7, hist: hist(2) })], 10)[0];
  const b = R.update([T0({ cam: "back", id: "B1", x: 0.04, seen: 11, first: 10.8, hist: hist(6), n: 2 })], 11)[0];
  ok("same place and time but very different clothing → two people, two colours", b.gid !== a.gid && b.color !== a.color, [a, b]);
}
{ // wrong direction / wrong camera
  const R = reg(); const a = R.update([T0({ cam: "right_repeater", id: "RR1", x: 0.88, seen: 10, first: 7, hist: hist(2) })], 10)[0];
  const b = R.update([T0({ cam: "left_repeater", id: "LR1", x: 0.04, seen: 11, first: 10.8, hist: hist(2), n: 2 })], 11)[0];
  ok("a track that appears on a camera that is not the neighbour → new person", b.gid !== a.gid, [a, b]);
}
{ // too late
  const R = reg(); const a = R.update([T0({ cam: "right_repeater", id: "RR1", x: 0.88, seen: 10, first: 7, hist: hist(2) })], 10)[0];
  const b = R.update([T0({ cam: "back", id: "B1", x: 0.04, seen: 40, first: 39.5, hist: hist(2), n: 2 })], 40)[0];
  ok("30 s later on the neighbour → a new visit, new person", b.gid !== a.gid);
}
{ // overlap: both cameras see the person at the same time (RR right edge + REAR left edge)
  const R = reg(); const a = R.update([T0({ cam: "right_repeater", id: "RR1", x: 0.9, w: 0.1, seen: 10, first: 7, hist: hist(3) })], 10)[0];
  const o = R.update([T0({ cam: "right_repeater", id: "RR1", x: 0.9, w: 0.1, seen: 10.4, first: 7, hist: hist(3) }), T0({ cam: "back", id: "B1", x: 0.0, seen: 10.4, first: 10.3, hist: hist(3), n: 2 })], 10.4);
  ok("overlap at the shared edge: both boxes are the same person", o[0].gid === o[1].gid && o[0].gid === a.gid, o);
}
{ // two different people on the same camera at once stay two
  const R = reg(); const o = R.update([T0({ cam: "front", id: "F1", x: 0.2, seen: 5, first: 3, hist: hist(1) }), T0({ cam: "front", id: "F2", x: 0.6, seen: 5, first: 4, hist: hist(5) })], 5);
  ok("two people on one camera: two ids, two colours", o[0].gid !== o[1].gid && o[0].color !== o[1].color);
}
{ // crowd: two walkers exit RR together with similar clothes, ONE new track appears on REAR: ambiguous → no link (a new person, not a wrong merge)
  const R = reg(); R.update([T0({ cam: "right_repeater", id: "RR1", x: 0.88, seen: 10, first: 7, hist: hist(2) }), T0({ cam: "right_repeater", id: "RR2", x: 0.86, seen: 10, first: 7.1, hist: hist(2) })], 10);
  const b = R.update([T0({ cam: "back", id: "B1", x: 0.04, seen: 11, first: 10.8, hist: hist(2), n: 2 })], 11)[0];
  ok("crowd of look-alikes: ambiguous link is NOT forced (new person)", b.bestGuess === false, b);
}
{ // the picture of a long walk F→RP→RR→B keeps ONE id
  const R = reg(); const ids = [];
  const path = [["front", "F1", 0.85, 0], ["right_pillar", "RP1", 0.04, 1.2], ["right_repeater", "RR1", 0.04, 3], ["back", "B1", 0.03, 5]];
  for (const [cam, id, x, t] of path) { ids.push(R.update([T0({ cam, id, x, seen: t + 0.5, first: t, hist: hist(4) })], t + 0.5)[0].gid); if (cam !== "back") R.update([], t + 1); }
  ok("one walker around the car (front → right pillar → right repeater → rear): one global id", new Set(ids).size === 1, ids);
}
{ // palette: 8 distinct colours for 8 simultaneous people
  const R = reg(); const tr8 = []; for (let i = 0; i < 8; i++) tr8.push(T0({ cam: ["front", "back"][i % 2], id: "X" + i, x: 0.05 + 0.1 * i, seen: 5, first: 1 + i * 0.01, hist: hist(i), vx: 0 }));
  const o = R.update(tr8, 5); ok("8 simultaneous people get 8 distinct colours", new Set(o.map((x) => x.color)).size === 8);
}
ok("appearance: embedding cosine used when both sides have one, colour histogram otherwise, neutral when none", PE.appearance({ emb: [1, 0], hist: null }, { emb: [1, 0] }).kind === "embedding" && PE.appearance({ hist: hist(1) }, { hist: hist(1) }).kind === "colour" && PE.appearance({}, {}).kind === "none");
console.log(fails ? "FAILED " + fails + " of " + n : "ALL PASS (" + n + ")"); process.exit(fails ? 1 : 0);
