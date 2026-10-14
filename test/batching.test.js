const assert = require("assert");
const B = require("../js/batching.js");
const SIX = ["front","back","left_repeater","right_repeater","left_pillar","right_pillar"], FOUR = SIX.slice(0,4);
function mk(dir, n, cams, startMin = 0) {
  const out = [];
  for (let i = 0; i < n; i++) { const mm = String(startMin + i).padStart(2,"0");
    for (const c of cams) out.push({ path: `TeslaCam/${dir}/2026-10-0${1}_12-${mm}-00-${c}.mp4`, request: { id: dir+i+c } }); }
  return out;
}
let pass = 0; const t = (name, fn) => { fn(); pass++; console.log("ok -", name); };
t("angle detection", () => { assert.equal(B.angleCount(SIX), 6); assert.equal(B.angleCount(FOUR), 4); assert.equal(B.angleCount(["front","rear".replace("rear","back")]), 4); });
t("parse rear alias", () => assert.equal(B.parse("2026-01-01_00-00-00-rear.mp4").cam, "back"));
for (const [label, cams] of [["6-angle", SIX], ["4-angle", FOUR]]) {
  for (const sessions of [1, 5, 6, 12, 40]) t(`${label} x${sessions} sessions (${sessions*cams.length} files)`, () => {
    const e = mk("SentryClips/ev", sessions, cams);
    const b = B.planBatches(e, 30);
    assert.ok(b.every((x) => x.entries.length <= 30), "≤30 per batch");
    assert.equal(b.reduce((a, x) => a + x.entries.length, 0), e.length, "nothing lost");
    for (const x of b) assert.equal(x.entries.length % cams.length, 0, "whole sessions only");
    assert.equal(new Set(b.flatMap((x) => x.entries.map((y) => y.request.id))).size, e.length, "no dupes");
  });
}
t("mixed 4+6 over 30", () => {
  const e = mk("SavedClips/a", 7, FOUR).concat(mk("SavedClips/b", 9, SIX));
  const b = B.planBatches(e, 30);
  assert.ok(b.every((x) => x.entries.length <= 30));
  const ss = B.sessionsOf(e); assert.equal(ss.filter(s=>s.angles===4).length, 7); assert.equal(ss.filter(s=>s.angles===6).length, 9);
});
t("oversized session splits", () => { const b = B.planBatches(mk("x", 1, SIX), 4); assert.deepEqual(b.map(x=>x.entries.length), [4,2]); });
(async () => {
  const e = mk("ev", 12, SIX); const b = B.planBatches(e, 30);
  const r = await B.runSequential(b, async (x, i) => { if (i === 1) throw new Error("HTTP 413"); return x.entries.map((y) => ({ id: y.request.id })); });
  assert.equal(r.errors.length, 1); assert.equal(r.errors[0].batch, 2); assert.equal(r.results.length, e.length - b[1].entries.length);
  console.log("ok - sequential run keeps going after a rejected batch"); pass++;
  console.log(`\n${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
