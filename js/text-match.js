/* text-match.js — pure helpers for text search and text redaction (no DOM; also runs in node tests).
 *  - phraseScore(phrase, line): does an OCR line contain the phrase? Case, spaces and punctuation are ignored, OCR
 *    look-alikes (0/O, 1/I/L, 5/S, 8/B, 2/Z, 6/G) count as equal, and a few letters may be wrong (0 for ≤ 3 characters,
 *    1 for 4–7, 2 for 8+). Multi-word phrases match across the spaces OCR drops or adds ("ZenderBakery", "ZEN DER").
 *    A line holding only a distinctive word of the phrase ("BAKERY" of "Zender Bakery": OCR often splits a sign into
 *    words) is a partial match; generic words (st, ave, the, …) alone never match.
 *  - buildTracks / boxAt: OCR samples are 0.5–1 s apart; link the same text across samples (by predicted position and
 *    text) and interpolate between them, so the blur moves with the text instead of jumping or missing frames, and
 *    hold it about half a sample past the first / last sighting. */
(function (root) {
  "use strict";
  const CANON = { o: "0", q: "0", d: "0", i: "1", l: "1", j: "1", "|": "1", s: "5", b: "8", z: "2", g: "6" };
  const GENERIC = new Set(["st", "street", "ave", "av", "avenue", "rd", "road", "dr", "drive", "ln", "lane", "ct", "court", "pl", "place", "blvd", "boulevard", "hwy", "highway", "way", "the", "a", "an", "of", "and", "co", "inc", "llc"]);
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const canon = (s) => norm(s).replace(/[a-z|]/g, (c) => CANON[c] || c);
  const words = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const allowed = (n) => (n <= 3 ? 0 : n <= 7 ? 1 : 2);
  /** Smallest edit distance of `needle` against any substring of `hay` (Sellers). */
  function subDist(needle, hay) {
    const n = needle.length, m = hay.length;
    if (!n) return 0;
    let prev = new Array(m + 1).fill(0), best = n;
    for (let i = 1; i <= n; i++) {
      const cur = new Array(m + 1); cur[0] = i;
      for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (needle[i - 1] === hay[j - 1] ? 0 : 1));
      prev = cur;
    }
    for (let j = 0; j <= m; j++) best = Math.min(best, prev[j]);
    return best;
  }
  /** Smallest edit distance of `needle` against a prefix of `hay`. */
  function preDist(needle, hay) {
    const n = needle.length, m = hay.length;
    let prev = Array.from({ length: m + 1 }, (_, j) => j);
    for (let i = 1; i <= n; i++) { const cur = [i]; for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (needle[i - 1] === hay[j - 1] ? 0 : 1)); prev = cur; }
    return Math.min.apply(null, prev);
  }
  /** Short phrases (≤ 5 characters) must start at a word start of the line ("MAIN" in "MAIN ST" / "MAINST", not in "DOMAIN"). */
  function lineDist(cp, line) {
    if (cp.length > 5) return subDist(cp, canon(line));
    const ws = words(line); let best = cp.length;
    for (let k = 0; k < ws.length; k++) best = Math.min(best, preDist(cp, canon(ws.slice(k).join(""))));
    return best;
  }
  function wordHit(w, line) {   // a distinctive word somewhere in the line
    const cw = canon(w);
    if (!cw || !canon(line)) return 0;
    const d = lineDist(cw, line);
    return d <= allowed(cw.length) ? 1 - d / Math.max(4, cw.length) : 0;
  }
  /** 0..1 (0 = no match). {score, part} part = only some words of the phrase. */
  function phraseMatch(phrase, line) {
    const cp = canon(phrase), cl = canon(line);
    if (!cp || !cl) return { score: 0, part: false };
    const d = lineDist(cp, line);
    if (d <= allowed(cp.length)) return { score: 1 - 0.5 * d / Math.max(4, cp.length), part: false };
    // OCR read only part of the line (it was cut by the frame edge, or the sign was split into words)
    const ws = words(phrase), dist = ws.filter((w) => !GENERIC.has(w) && (w.length >= 3 || /\d/.test(w)));
    let best = 0;
    for (const w of dist) if (w.length >= 4 || (/^\d+$/.test(w) && w.length >= 2)) best = Math.max(best, wordHit(w, line));
    if (best) return { score: 0.75 * best, part: true };
    // the line is a (long enough) piece of the phrase: "BAKER" of "ZENDER BAKERY"
    if (cl.length >= 4 && subDist(cl, cp) <= allowed(cl.length) - (cl.length <= 5 ? 1 : 0) && !GENERIC.has(norm(line))) return { score: 0.6, part: true };
    return { score: 0, part: false };
  }
  const phraseScore = (phrase, line) => phraseMatch(phrase, line).score;
  /** Generic word of the phrase ("AVE" of "Quillby Ave") read as its own box right next to a matched box: blur it too. */
  function genericNeighbour(phrase, line) {
    const n = norm(line);
    return n.length > 0 && words(phrase).some((w) => w === n || (n.length >= 2 && canon(w) === canon(n)));
  }

  const iou = (a, b) => { const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)), y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)); const i = x * y; return i / (a.w * a.h + b.w * b.h - i || 1); };
  const textSim = (a, b) => { const x = canon(a), y = canon(b); if (!x || !y) return 0; const d = subDist(x.length <= y.length ? x : y, x.length <= y.length ? y : x); return 1 - d / Math.max(1, Math.min(x.length, y.length)); };
  /** samples: [{t, boxes:[{x,y,w,h,text,conf,...}]}] (one camera). → tracks [{pts:[{t,x,y,w,h,text,conf}]}] */
  function buildTracks(samples, opt) {
    opt = opt || {};
    const maxGap = opt.maxGap || 1.6;
    const tracks = [];
    for (const f of samples.slice().sort((a, b) => a.t - b.t)) {
      const open = tracks.filter((tr) => f.t - tr.pts[tr.pts.length - 1].t <= maxGap + 1e-6);
      const pairs = [];
      f.boxes.forEach((d, di) => open.forEach((tr) => {
        const p = tr.pts[tr.pts.length - 1], q = tr.pts.length > 1 ? tr.pts[tr.pts.length - 2] : null;
        // predicted position (constant velocity), then compare centres in units of the box size
        const dt = f.t - p.t, vx = q ? ((p.x + p.w / 2) - (q.x + q.w / 2)) / (p.t - q.t || 1) : 0, vy = q ? ((p.y + p.h / 2) - (q.y + q.h / 2)) / (p.t - q.t || 1) : 0;
        const px = p.x + p.w / 2 + vx * dt, py = p.y + p.h / 2 + vy * dt;
        const dx = Math.abs(d.x + d.w / 2 - px) / Math.max(p.w, d.w, 0.02), dy = Math.abs(d.y + d.h / 2 - py) / Math.max(p.h, d.h, 0.01);
        const size = Math.max(d.h / p.h, p.h / d.h);
        const sim = d.text != null && p.text != null ? textSim(d.text, p.text) : 0.5;
        const ov = iou(p, d);
        if (size > 2.2 || (dx > 0.9 && ov < 0.05) || dy > 1.5) return;
        if (sim < 0.3 && ov < 0.2) return;
        pairs.push([ov + sim - 0.3 * dx - 0.2 * dy, di, tr]);
      }));
      pairs.sort((a, b) => b[0] - a[0]);
      const usedD = new Set(), usedT = new Set();
      for (const [, di, tr] of pairs) { if (usedD.has(di) || usedT.has(tr)) continue; usedD.add(di); usedT.add(tr); tr.pts.push({ t: f.t, ...f.boxes[di] }); }
      f.boxes.forEach((d, di) => { if (!usedD.has(di)) tracks.push({ pts: [{ t: f.t, ...d }] }); });
    }
    return tracks;
  }
  /** Box of a track at t: linear between samples, moved on with its speed up to `hold` s past either end. */
  function boxAt(tr, t, hold) {
    const p = tr.pts, h = hold == null ? 0.4 : hold;
    if (!p.length || t < p[0].t - h || t > p[p.length - 1].t + h) return null;
    const lerp = (a, b, u) => ({ t, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, w: a.w + (b.w - a.w) * u, h: a.h + (b.h - a.h) * u, text: u < 0.5 ? a.text : b.text, conf: u < 0.5 ? a.conf : b.conf });
    if (p.length === 1) return { ...p[0], t };
    if (t <= p[0].t) return lerp(p[0], p[1], (t - p[0].t) / (p[1].t - p[0].t || 1));
    const n = p.length;
    if (t >= p[n - 1].t) return lerp(p[n - 2], p[n - 1], (t - p[n - 2].t) / (p[n - 1].t - p[n - 2].t || 1));
    let i = 1; while (p[i].t < t) i++;
    return lerp(p[i - 1], p[i], (t - p[i - 1].t) / (p[i].t - p[i - 1].t || 1));
  }
  /** Clamp a box to the frame (0..1) after padding: grow by fx of its width / fy of its height on every side. */
  function pad(b, fx, fy) {
    const x0 = Math.max(0, b.x - b.w * fx), y0 = Math.max(0, b.y - b.h * fy), x1 = Math.min(1, b.x + b.w * (1 + fx)), y1 = Math.min(1, b.y + b.h * (1 + fy));
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  }
  /** "text ZENDER BAKERY", "sign: Pello", "\"4821\"", "find text quillby" → the phrase to look for, else null.
   *  A bare ALL-CAPS phrase that isn't a plate pattern ("ZENDER BAKERY") counts too: that's how signs are written. */
  function parseTextQuery(q) {
    let s = String(q || "").trim().replace(/\s+/g, " ");
    let m;
    s = s.replace(/^(?:please\s+)?(?:find|search(?:\s+for)?|look\s+for|show(?:\s+me)?|where\s+(?:is|are|does)|locate)\s+/i, "");
    if ((m = s.match(/^(?:the\s+)?(?:text|words?|sign|signs|street\s+sign|street|road|ocr)\s*(?:[:=]|\s)\s*(.+)$/i))) return { phrase: m[1].replace(/^["'“”‘’]|["'“”‘’]$/g, "").trim(), how: "prefix" };
    if ((m = s.match(/^["“‘']([^"”’']{1,60})["”’']$/))) return { phrase: m[1].trim(), how: "quoted" };
    if (/^[A-Z][A-Z0-9&'.\- ]{2,40}$/.test(s) && /[A-Z]{3}/.test(s) && /\s/.test(s) && !/^(?:[A-Z0-9]{1,8}\*?)$/.test(s.replace(/\s/g, ""))) return { phrase: s, how: "caps" };
    return null;
  }
  const api = { norm, canon, words, subDist, phraseMatch, phraseScore, genericNeighbour, buildTracks, boxAt, pad, iou, textSim, parseTextQuery, GENERIC };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) { root.TDC = root.TDC || {}; root.TDC.textMatch = api; }
})(typeof window !== "undefined" ? window : null);
