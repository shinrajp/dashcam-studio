/* people.js — one colour / one global ID per person across cameras (tags handoff-m2 colours, handoff-m4 linking).
 * The live tracker (detect.js) gives every person a per-camera track id ("RR3"). This registry keeps a PERSON per walker and links the
 * track a person leaves on one camera to the track that starts on a neighbouring camera. The score of a link is a product:
 *     spatio-temporal prior (physical adjacency table + entry edge + timing + direction of travel)  ×  appearance
 * where appearance is an embedding cosine (when a re-ID model is plugged in, js/reid.js) or, without one, a clothing-colour histogram.
 * It is a BEST GUESS: every link carries a confidence and is labelled as such in the UI. Dark pictures, the fisheye REAR camera,
 * crowds and people in the same clothes defeat it, and it can pick the wrong neighbour; it never merges two tracks that are visible
 * at the same time unless one is leaving through the edge the other is entering by.
 * Pure (no DOM): exported for node tests. */
(function (root) {
  "use strict";
  const H = typeof module !== "undefined" && module.exports ? require("./handoff.js") : (root.TDC && root.TDC.handoff);
  // colours readable on the dark video and on the light page: saturated mid-tones, each also carries a dark outline when drawn
  const PALETTE = ["#ffd23f", "#2ee6d6", "#ff6b9a", "#7ddc5a", "#ff9f43", "#b388ff", "#4aa3ff", "#ff5252"];
  const DEF = { ttl: 10, minScore: 0.22, margin: 0.06, win: [-3, 10], edgeNear: 0.3 };

  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  /** Bhattacharyya coefficient of two L1-normalised histograms (1 = identical). */
  function bhat(a, b) { if (!a || !b || a.length !== b.length) return null; let s = 0; for (let i = 0; i < a.length; i++) s += Math.sqrt(a[i] * b[i]); return s; }
  function cosine(a, b) { if (!a || !b || a.length !== b.length) return null; let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na * nb) || 1); }
  /** 0..1 appearance similarity of two track snapshots, with the kind of evidence used. */
  function appearance(a, b) {
    const c = cosine(a.emb, b.emb);
    if (c != null) return { s: clamp01((c - 0.35) / 0.5), kind: "embedding", raw: c };
    const h = bhat(a.hist, b.hist);
    if (h != null) return { s: clamp01((h - 0.55) / 0.4), kind: "colour", raw: h };
    return { s: 0.5, kind: "none", raw: null };
  }
  /** Timing: seconds between A's last sighting and B's first (negative: they overlapped). */
  function timing(dt, win) {
    if (dt < win[0] || dt > win[1]) return 0;
    if (dt >= -1 && dt <= 3) return 1;
    if (dt < -1) return 0.5 + 0.5 * ((dt - win[0]) / (-1 - win[0]));
    return Math.max(0.15, 1 - 0.85 * ((dt - 3) / (win[1] - 3)));
  }
  /** Spatial prior for "B is the continuation of A". A: last snapshot (raw picture coords), B: first snapshot. */
  function spatial(A, B, edgeNear) {
    const ax = A.x + A.w / 2, bx = B.x + B.w / 2;
    if (A.cam === B.cam) { // the same camera again (hidden for a moment, track lost): close to where A vanished
      const d = Math.hypot(ax - bx, (A.y + A.h / 2) - (B.y + B.h / 2));
      return d < 0.2 ? 0.6 : d < 0.45 ? 0.35 : 0.08;
    }
    const sides = [];
    if (A.vx > 0.02) sides.push("right"); else if (A.vx < -0.02) sides.push("left"); else { if (A.x + A.w > 1 - edgeNear) sides.push("right"); if (A.x < edgeNear) sides.push("left"); }
    for (const side of sides) {
      const e = H.entryFor(A.cam, side);
      if (e && e.to === B.cam) {
        const nearEntry = e.entry === "left" ? B.x < edgeNear : B.x + B.w > 1 - edgeNear;
        const leaving = side === "right" ? A.x + A.w > 1 - edgeNear * 1.3 || A.exited : A.x < edgeNear * 1.3 || A.exited;
        return (nearEntry ? 1 : 0.5) * (leaving ? 1 : 0.7);
      }
    }
    // a neighbour on the chain through the other edge, or two steps away (a camera was skipped / not looked at in time)
    const ia = H.CHAIN.indexOf(A.cam), ib = H.CHAIN.indexOf(B.cam), d = Math.min((ia - ib + 6) % 6, (ib - ia + 6) % 6);
    return d === 1 ? 0.18 : d === 2 ? 0.12 : 0.03;
  }
  function direction(A, B) { if (Math.abs(A.vx || 0) < 0.03 || Math.abs(B.vx || 0) < 0.03) return 1; return Math.sign(A.vx) === Math.sign(B.vx) ? 1 : 0.3; }
  /** Score of linking snapshot A (a person's latest track) to snapshot B (a new track). */
  function score(A, B, opt) {
    const o = Object.assign({}, DEF, opt || {});
    const dt = (B.first != null ? B.first : B.seen) - A.seen;
    const sp = spatial(A, B, o.edgeNear), tm = timing(dt, o.win), dr = direction(A, B), ap = appearance(A, B);
    const total = sp * tm * (0.5 + 0.5 * dr) * (0.1 + 0.9 * ap.s);
    return { score: total, sp, tm, dr, ap: ap.s, kind: ap.kind, raw: ap.raw, dt };
  }

  function Registry(opt) {
    this.o = Object.assign({}, DEF, opt || {});
    this.persons = new Map(); this.byTrack = new Map(); this.next = 1; this.stats = { links: 0, news: 0 };
  }
  Registry.prototype.colorFor = function (now) {
    const used = new Set(); for (const p of this.persons.values()) if (now - p.seen <= this.o.ttl + 5) used.add(p.color);
    for (const c of PALETTE) if (!used.has(c)) return c;
    return PALETTE[(this.next - 1) % PALETTE.length];
  };
  /** tracks: current person tracks [{cam,id,x,y,w,h,vx,vy,n,seen,first,hist?,emb?}] at event time `now`. Returns [{...track, gid, color, conf, bestGuess}]. */
  Registry.prototype.update = function (tracks, now) {
    const o = this.o, key = (t) => t.cam + ":" + t.id;
    // refresh known tracks; collect new ones
    const fresh = [], held = new Set();
    for (const t of tracks) {
      const k = key(t), gid = this.byTrack.get(k);
      if (gid != null && this.persons.has(gid)) { const p = this.persons.get(gid); p.last = Object.assign({}, t); p.seen = Math.max(p.seen, t.seen); p.trs.add(k); if (t.hist && !p.hist) p.hist = t.hist; }
      else if (this.o.hold && this.o.hold(t, now)) held.add(k);   // wait a moment for its colour / appearance (reid.js), then decide
      else fresh.push(t);
    }
    // candidate links: new track B ↔ person P (by P's latest snapshot)
    const cands = [];
    for (const B of fresh) for (const P of this.persons.values()) {
      if (now - P.seen > o.ttl) continue;
      const A = P.last; if (!A) continue;
      // a person is "busy" if one of their tracks is still active ON THAT CAMERA (a second box on the same camera is a second person)
      if ([...P.trs].some((k) => k !== key(B) && k.startsWith(B.cam + ":") && tracks.some((t) => key(t) === k))) continue;
      const stillHere = tracks.some((t) => key(t) === A.cam + ":" + A.id);
      const Aeff = Object.assign({}, A, { exited: !stillHere });
      // overlap (A still visible): only when A is at the edge B is entering by (spatial() returns the low prior otherwise)
      const s = score(Aeff, B, o);
      if (s.score >= o.minScore) cands.push({ B, P, s });
    }
    cands.sort((a, b) => b.s.score - a.s.score);
    const usedB = new Set(), usedP = new Set(), res = new Map();
    for (const c of cands) {
      const kb = key(c.B); if (usedB.has(kb) || usedP.has(c.P.gid)) continue;
      // margin: the runner-up for the same new track must not be nearly as good (ambiguous crowd → rather a new person)
      const rival = cands.find((d) => d !== c && key(d.B) === kb && d.P !== c.P);
      const rivalP = cands.find((d) => d !== c && d.P === c.P && key(d.B) !== kb && !usedB.has(key(d.B)));
      const amb = (rival && c.s.score - rival.s.score < o.margin) || (rivalP && c.s.score - rivalP.s.score < o.margin * 0.5);
      if (amb) continue;
      usedB.add(kb); usedP.add(c.P.gid); res.set(kb, c);
    }
    for (const B of fresh) {
      const k = key(B), c = res.get(k);
      if (c) {
        this.byTrack.set(k, c.P.gid); c.P.trs.add(k); c.P.last = Object.assign({}, B); c.P.seen = Math.max(c.P.seen, B.seen);
        c.P.link = { conf: c.s.score, kind: c.s.kind, from: c.P.lastCam || null, at: now, parts: c.s }; c.P.bestGuess = true; this.stats.links++;
      } else {
        const gid = this.next++, p = { gid, color: this.colorFor(now), seen: B.seen, first: B.first != null ? B.first : B.seen, trs: new Set([k]), last: Object.assign({}, B), hist: B.hist || null, bestGuess: false, link: null };
        this.persons.set(gid, p); this.byTrack.set(k, gid); this.stats.news++;
      }
    }
    // forget persons that are long gone
    for (const [gid, p] of this.persons) if (now - p.seen > o.ttl + 20) { this.persons.delete(gid); for (const k of p.trs) this.byTrack.delete(k); }
    return tracks.map((t) => { const p = this.persons.get(this.byTrack.get(key(t))); return Object.assign({}, t, p ? { gid: p.gid, color: p.color, bestGuess: p.bestGuess, linkConf: p.link ? p.link.conf : 1 } : { pending: held.has(key(t)) }); });
  };
  Registry.prototype.reset = function () { this.persons.clear(); this.byTrack.clear(); this.next = 1; this.stats = { links: 0, news: 0 }; };
  Registry.prototype.list = function (now, within) { return [...this.persons.values()].filter((p) => now - p.seen <= (within == null ? this.o.ttl : within)); };

  const api = { PALETTE, Registry, score, spatial, timing, appearance, bhat, cosine, DEF };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }

  const T = (root.TDC = root.TDC || {});
  const P = (T.people = Object.assign({ reg: new Registry(), now: [] }, api));
  /** Cross-camera matching (beta): on / off / auto (auto = on once it has passed the perf budget on this device — see reid.js). */
  P.linkOn = () => { const v = T.prefs && T.prefs.crossCam; if (v === "on") return true; if (v === "off") return false; return !(T.reid && T.reid.autoOff && T.reid.autoOff()); };
  /** Current person tracks with their global id and colour (linking only when Cross-camera matching is on: else one person per track). */
  P.current = (t) => {
    const nowMs = performance.now();
    if (P._at && nowMs - P._at < 40 && Math.abs((P._t || 0) - t) < 0.2) return P.now;   // one pass per frame, shared by the cue, the car view and the box colours
    const D = T.detect; if (!D || !D.personTracks) return [];
    const tracks = D.personTracks(t);
    const hist = T.reid && T.reid.annotate ? T.reid.annotate(tracks, t) : tracks;
    let out;
    if (!P.linkOn()) { // no linking: each track is its own person, colour by track
      out = hist.map((x) => { const k = x.cam + ":" + x.id; if (!P._solo) P._solo = new Map(); if (!P._solo.has(k)) P._solo.set(k, PALETTE[P._solo.size % PALETTE.length]); return Object.assign({}, x, { gid: k, color: P._solo.get(k), bestGuess: false, linkConf: 1 }); });
    } else out = P.reg.update(hist, t);
    P.now = out; P._at = nowMs; P._t = t;
    return out;
  };
  /** Short name for a person (P1, P2, …) — "?" when the identity came from linking cameras (a best guess). */
  P.num = (gid) => { if (!P._nums) P._nums = new Map(); if (!P._nums.has(gid)) P._nums.set(gid, P._nums.size + 1); return P._nums.get(gid); };
  P.name = (m) => "P" + P.num(m.gid) + (m.bestGuess ? "?" : "");
  P.selected = null;
  P.select = (gid) => { P.selected = P.selected === gid ? null : gid; if (T.emit) T.emit("people-select", P.selected); if (T.search && T.search.paintBoxes) T.search.paintBoxes(); };
  /** Viewer only: person boxes get their person's colour (same on every camera) and the tapped person is drawn heavier. */
  P.styleBoxes = (cam, boxes) => {
    if (!P.now || !P.now.length || performance.now() - (P._at || 0) > 700) return boxes;
    return boxes.map((b) => {
      if (!b.pid || b.label !== "person") return b;
      const m = P.now.find((x) => x.cam === cam && x.id === b.pid); if (!m) return b;
      return Object.assign({}, b, { color: m.color, hl: P.selected != null && P.selected === m.gid, text: b.text + " \u00b7 " + P.name(m) });
    });
  };
  P.reg.o.hold = (t, now) => !!(T.reid && T.reid.pending && T.reid.pending(t, now));
  P.reset = () => { P.reg.reset(); P._solo = null; P._nums = null; P.selected = null; P.now = []; P._at = 0; };
  if (typeof T.on === "function") T.on("player-open", P.reset);
})(typeof window !== "undefined" ? window : globalThis);
