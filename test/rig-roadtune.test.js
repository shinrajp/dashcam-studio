// ROAD_TUNE (js/rig.js): the road fine-tune of the angles kept outside the MEASURED block that tools/rig/to-js.py rewrites.
// With the tune on (default) the effective angles must equal, exactly, those of the tip before the split (pre-tv2-fix1, fa6a23d's
// hand-edited MEASURED). Usage: node test/rig-roadtune.test.js [old rig.js, default: git show pre-tv2-fix1:js/rig.js]
const path = require("path"), { execFileSync } = require("child_process"), fs = require("fs"), os = require("os");
let fails = 0, n = 0; const ok = (name, c, x) => { n++; console.log((c ? "PASS " : "FAIL ") + name + (c ? "" : "  " + JSON.stringify(x))); if (!c) fails++; };
const R = require("../js/rig.js");
let oldFile = process.argv[2];
if (!oldFile) {
  oldFile = path.join(os.tmpdir(), "rig-pre-tv2-fix1.js");
  try { fs.writeFileSync(oldFile, execFileSync("git", ["show", "pre-tv2-fix1:js/rig.js"], { cwd: path.join(__dirname, ".."), maxBuffer: 1 << 24 })); }
  catch (e) { console.log("SKIP no pre-tv2-fix1 tag here (pass the old js/rig.js as an argument)"); process.exit(0); }
}
const O = require(path.resolve(oldFile));
const A = ["yaw", "pitch", "roll"];
ok("tune on by default", R.roadTune() === true);
for (const cam of R.CAMS) for (const k of Object.keys(O.MEASURED[cam])) {
  const a = R.MEASURED[cam][k], b = O.MEASURED[cam][k];
  ok(`${cam}.${k} identical to the tip with the tune on`, JSON.stringify(a) === JSON.stringify(b), { a, b });
}
for (const cam of R.CAMS) ok(`${cam}: rig in use = the tip's rig (get)`, JSON.stringify(R.get(cam)) === JSON.stringify(O.get(cam)));
const px = (M, cam) => M.pixel(cam, [0.3, -0.4, 1]);
for (const cam of R.CAMS) ok(`${cam}: same projection`, JSON.stringify(px(R, cam)) === JSON.stringify(px(O, cam)), [px(R, cam), px(O, cam)]);
R.roadTune(false);
for (const cam of R.CAMS) for (const k of A) ok(`off: ${cam}.${k} = MEASURED as measured`, R.get(cam)[k] === R.MEASURED_RAW[cam][k]);
ok("off: front unchanged (reference)", R.get("front").yaw === O.MEASURED.front.yaw);
ok("off: back differs from the tuned value", R.get("back").pitch !== O.MEASURED.back.pitch);
R.roadTune(true);
for (const cam of R.CAMS) for (const k of A) ok(`on again: ${cam}.${k}`, R.get(cam)[k] === O.MEASURED[cam][k]);
const p = R.preset("model_y"); ok("presets take the tuned angles", p.cams.back.pitch === O.MEASURED.back.pitch);
console.log(fails ? `${fails} of ${n} FAILED` : `ALL PASS (${n})`); process.exit(fails ? 1 : 0);
