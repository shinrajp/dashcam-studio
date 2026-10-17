/* plate-text.js — Phase 6: turn plate-OCR output into text, tidy it for California plates, and match search queries.
 * Pure functions (no DOM), so they run in the browser (TDC.plateText) and in node tests (require).
 *  - decode(): per-slot argmax over the fast-plate-ocr alphabet, with a confidence and the runner-up for every character.
 *  - normalizeCA(): California's standard format is 1ABC234 (digit, 3 letters, 3 digits). Where a character is the
 *    wrong kind for its place, use the runner-up if it fits, else fix the usual look-alikes (O/0, I/1, B/8, S/5, Z/2, G/6),
 *    and lower that character's confidence. Plates that don't fit (vanity, commercial, other states) are left as read.
 *  - matchPlate(): exact, partial ("7ABC 23"), wildcard ("7AB*", "7A?C234") and fuzzy (one look-alike or one wrong char). */
(function (root) {
  "use strict";
  const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_";
  const PAD = "_";
  const TO_DIGIT = { O: "0", Q: "0", D: "0", U: "0", I: "1", L: "1", J: "1", T: "7", Z: "2", S: "5", B: "8", G: "6", A: "4" };
  const TO_LETTER = { "0": "O", "1": "I", "2": "Z", "4": "A", "5": "S", "6": "G", "7": "T", "8": "B" };
  // look-alikes collapse to one symbol for fuzzy matching
  const CANON = { O: "0", Q: "0", D: "0", I: "1", L: "1", B: "8", S: "5", Z: "2", G: "6" };
  const isDigit = (c) => c >= "0" && c <= "9";
  const isLetter = (c) => c >= "A" && c <= "Z";

  /** probs: flat Float32Array/array [slots × classes] for ONE plate. → { raw, chars:[{c,p,alt,altP}], conf } */
  function decode(probs, slots, classes, alphabet) {
    alphabet = alphabet || ALPHABET; slots = slots || 10; classes = classes || alphabet.length;
    const chars = [];
    for (let s = 0; s < slots; s++) {
      let b = -1, bp = -1, a = -1, ap = -1;
      for (let k = 0; k < classes; k++) {
        const v = probs[s * classes + k];
        if (v > bp) { a = b; ap = bp; b = k; bp = v; } else if (v > ap) { a = k; ap = v; }
      }
      const c = alphabet[b];
      if (c === PAD || c == null) continue;
      chars.push({ c, p: bp, alt: a >= 0 ? alphabet[a] : null, altP: Math.max(0, ap) });
    }
    const raw = chars.map((x) => x.c).join("");
    return { raw, chars, conf: chars.length ? Math.min.apply(null, chars.map((x) => x.p)) : 0 };
  }

  const CA_STD = "DLLLDDD";   // 1ABC234 (1980 → today)
  /** → { text, raw, format: "CA" | null, conf, chars:[p], fixed } */
  function normalizeCA(read) {
    const chars = (read.chars || []).map((x) => ({ ...x }));
    const raw = read.raw != null ? read.raw : chars.map((x) => x.c).join("");
    const plain = { text: raw, raw, format: null, conf: read.conf != null ? read.conf : (chars.length ? Math.min.apply(null, chars.map((x) => x.p)) : 0), chars: chars.map((x) => x.p), fixed: 0 };
    if (chars.length !== 7) return plain;
    let fixed = 0;
    for (let i = 0; i < 7; i++) {
      const want = CA_STD[i] === "D" ? isDigit : isLetter, x = chars[i];
      if (want(x.c)) continue;
      if (x.alt && x.alt !== PAD && want(x.alt) && x.altP >= 0.02) { x.c = x.alt; x.p = Math.max(x.altP, x.p * 0.6); fixed++; continue; }
      const m = CA_STD[i] === "D" ? TO_DIGIT[x.c] : TO_LETTER[x.c];
      if (!m) return plain;   // can't make it fit: probably not a standard plate (vanity, commercial, other state)
      x.c = m; x.p = x.p * 0.85; fixed++;
    }
    if (fixed > 2) return plain;   // too many guesses: keep what was read
    return { text: chars.map((x) => x.c).join(""), raw, format: "CA", conf: Math.min.apply(null, chars.map((x) => x.p)), chars: chars.map((x) => x.p), fixed };
  }

  const clean = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9*?]/g, "");
  const canon = (s) => clean(s).replace(/[A-Z]/g, (c) => CANON[c] || c);

  function edits(a, b, cap) {
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i]; let lo = i;
      for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); lo = Math.min(lo, cur[j]); }
      if (lo > cap) return cap + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  /** Query → plate pattern, street/text phrase, or null (not ours). */
  function parseQuery(q) {
    const s = String(q || "").trim();
    let m;
    if ((m = s.match(/^(?:licen[cs]e\s+)?(?:plates?|tags?|number\s*plates?)\s*[:#]?\s*(.*)$/i))) {
      const p = clean(m[1]);
      return { kind: "plate", pattern: p, all: p.replace(/[*?]/g, "").length === 0, label: p || "any plate" };
    }
    if ((m = s.match(/^(?:street|road|sign|text)\s*(?:names?|signs?)?\s*[:#]?\s*(.*)$/i))) {
      const t = m[1].trim();
      return { kind: "text", phrase: t, all: !t, label: t || "any street text" };
    }
    // bare plate-like query: 3–8 letters/digits (spaces, dashes, * ? allowed) with at least one digit
    if (/^[A-Za-z0-9*?][A-Za-z0-9*?\s-]{1,11}$/.test(s) && /\d/.test(s)) {
      const p = clean(s);
      if (p.replace(/[*?]/g, "").length >= 2 && p.length <= 9) return { kind: "plate", pattern: p, all: false, label: p };
    }
    return null;
  }

  /** Score 0..1 of a plate text against a pattern (0 = no match). */
  function matchPlate(pattern, text) {
    const P = clean(pattern), X = clean(text);
    if (!X) return 0;
    if (!P || !P.replace(/[*?]/g, "")) return 0.5;   // "plates" → every plate
    if (/[*?]/.test(P)) {
      const rx = (s) => new RegExp("^" + s.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
      if (rx(P).test(X)) return 0.95;
      if (rx(canon(P)).test(canon(X))) return 0.8;
      return 0;
    }
    if (P === X) return 1;
    if (P.length >= 3 && X.includes(P)) return 0.9;
    const cp = canon(P), cx = canon(X);
    if (cp === cx) return 0.85;
    if (cp.length >= 3 && cx.includes(cp)) return 0.8;
    if (P.length >= 5) {
      const d = edits(cp, cx, 2);
      if (d <= 1) return 0.7;
      if (d === 2 && P.length >= 7) return 0.5;
    }
    return 0;
  }

  const ABBR = { st: "street", ave: "avenue", av: "avenue", blvd: "boulevard", dr: "drive", rd: "road", ln: "lane", ct: "court", pl: "place", hwy: "highway", pkwy: "parkway", way: "way" };
  const words = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  /** Street/sign text against a phrase: all phrase words must be found (abbreviations and one typo allowed). */
  function matchText(phrase, text) {
    const want = words(phrase), have = words(text);
    if (!have.length) return 0;
    if (!want.length) return 0.5;
    const cw = want.join(""), ch = have.join("");   // OCR often drops spaces: "PalmAve."
    const compact = cw.length >= 4 && ch.includes(cw) ? 0.9 : 0;
    let score = 0;
    for (const w of want) {
      let best = 0;
      for (const h of have) {
        if (h === w || ABBR[h] === w || ABBR[w] === h) best = 1;
        else if (w.length >= 4 && (h.startsWith(w) || w.startsWith(h) && h.length >= 3)) best = Math.max(best, 0.85);
        else if (w.length >= 4 && edits(w, h, 1) <= 1) best = Math.max(best, 0.75);
      }
      if (!best) return compact;
      score += best;
    }
    return Math.max(compact, score / want.length);
  }

  const api = { ALPHABET, decode, normalizeCA, parseQuery, matchPlate, matchText, canon, clean, edits };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) { root.TDC = root.TDC || {}; root.TDC.plateText = api; }
})(typeof window !== "undefined" ? window : null);
