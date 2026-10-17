// node test/plate-text.test.js — unit tests for js/plate-text.js (decode, CA normalisation, query parsing, matching).
const P = require("../js/plate-text.js");
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x) : "")); if (!c) fails++; };
const A = P.ALPHABET, K = A.length;
function probs(spec) {   // spec: [[char, p, alt, altP], ...] padded to 10 slots
  const out = new Float32Array(10 * K);
  for (let s = 0; s < 10; s++) {
    const [c, p, alt, ap] = spec[s] || ["_", 0.99];
    out[s * K + A.indexOf(c)] = p;
    if (alt) out[s * K + A.indexOf(alt)] = ap;
  }
  return out;
}
const sp = (t, p) => t.split("").map((c) => [c, p || 0.97]);
let r = P.decode(probs(sp("7TST123")), 10, K);
ok("decode reads 7 chars, drops padding", r.raw === "7TST123" && r.chars.length === 7, r.raw);
ok("decode confidence is the weakest char", Math.abs(r.conf - 0.97) < 1e-6);
let n = P.normalizeCA(P.decode(probs([["7", .9], ["T", .9], ["S", .9], ["T", .9], ["I", .8], ["2", .9], ["3", .9]]), 10, K));
ok("CA: I in a digit place → 1", n.text === "7TST123" && n.format === "CA" && n.fixed === 1, n);
ok("CA: fixed char loses confidence", n.chars[4] < 0.8);
n = P.normalizeCA(P.decode(probs([["8", .9], ["D", .9], ["E", .9], ["M", .9], ["O", .6, "0", .3], ["4", .9], ["2", .9]]), 10, K));
ok("CA: runner-up 0 used for O in a digit place", n.text === "8DEM042" && n.chars[4] >= 0.3, n);
n = P.normalizeCA(P.decode(probs([["4", .9], ["0", .7], ["Z", .9], ["X", .9], ["9", .9], ["0", .9], ["7", .9]]), 10, K));
ok("CA: 0 in a letter place → O", n.text === "4OZX907", n.text);
n = P.normalizeCA(P.decode(probs(sp("SAMPLE1")), 10, K));
ok("vanity plate kept as read", n.text === "SAMPLE1" && n.format === null, n);
n = P.normalizeCA(P.decode(probs(sp("ABC123")), 10, K));
ok("6-char plate kept as read", n.text === "ABC123" && n.format === null);
const q = (s) => P.parseQuery(s);
ok("query 'plate 7AB*'", q("plate 7AB*").kind === "plate" && q("plate 7AB*").pattern === "7AB*");
ok("query '7ABC 23' (bare)", q("7ABC 23").kind === "plate" && q("7ABC 23").pattern === "7ABC23");
ok("query 'plates' = all plates", q("plates").all === true);
ok("query 'license plate 1ABC234'", q("license plate 1ABC234").pattern === "1ABC234");
ok("query 'street Palm Ave'", q("street Palm Ave").kind === "text" && q("street Palm Ave").phrase === "Palm Ave");
ok("query 'car' not ours", q("car") === null && q("white car") === null && q("person in a hoodie") === null);
const m = P.matchPlate;
ok("exact", m("7TST123", "7TST123") === 1);
ok("partial with space", m("7TST 12", "7TST123") === 0.9);
ok("wildcard *", m("7TS*", "7TST123") >= 0.95 && m("8DE*", "7TST123") === 0);
ok("wildcard ?", m("7T?T123", "7TST123") >= 0.95);
ok("look-alike O/0", m("4QZX9O7", "4QZX907") >= 0.8, m("4QZX9O7", "4QZX907"));
ok("one wrong char (fuzzy)", m("7TST124", "7TST123") === 0.7);
ok("unrelated", m("5SMP260", "7TST123") === 0);
ok("too short partial", m("12", "7TST123") === 0);
ok("street match with abbreviation", P.matchText("Palm Avenue", "PALM AVE") === 1 && P.matchText("palm", "Palm Ave") === 1);
ok("street one typo", P.matchText("Pakm Ave", "Palm Ave") > 0.8);
ok("street text without spaces", P.matchText("Palm Ave", "PalmAve.") >= 0.9);
ok("street no match", P.matchText("Oak St", "Palm Ave") === 0);
console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
