/* multi-search.js — several things in one search: "bus, person, police car", "red car and cyclist", "bus + plate 7AB*".
 * The query is split into terms; ONE scan goes over every camera's sampled frames and each frame's detector output (all
 * classes, kept in TDC.detect.frameCache) feeds every object term. Vehicle details refine only the vehicle terms (colour /
 * type / make on that frame's boxes), picture-search (CLIP) terms score the same frames (fewer of them), plate terms use the
 * plate index (scanned once for all plate terms). Results keep their term: a coloured chip with a count per term, a filter
 * (one term or all), and each term's own box colour in the viewer and the export (gold stays for the opened result).
 * Pure parts (split) work without the models. If this file is missing, search works as before (one thing at a time). */
(function () {
  "use strict";
  const T = window.TDC;
  const M = (T.multi = {});
  const $ = (id) => document.getElementById(id);
  const CAM_LABEL = { front: "Front", back: "Rear", left_repeater: "Left", right_repeater: "Right", left_pillar: "Left pillar", right_pillar: "Right pillar" };
  M.COLORS = ["#4fc3f7", "#f06292", "#81c784", "#ba68c8", "#ff8a65", "#4dd0e1"];   // never the gold (#e6b450) of the opened result
  M.MAX = 6;
  const COLOR_WORDS = new Set(["white", "black", "gray", "grey", "silver", "red", "blue", "green", "yellow", "orange", "brown", "beige", "tan", "purple", "maroon", "navy", "gold", "dark", "light"]);
  const VERB = /^(?:please\s+)?(?:find|search\s+for|search|look\s+for|show\s+me|show|where\s+(?:is|are)|locate|any)\s+/i;
  const isPlateWords = (s) => /^(?:blur|hide|redact|mask|censor|licen[cs]e|plates?\b|tags?\b|street\b|road\b|sign\b|text\b)/i.test(s);

  /** Is this one thing a search already understands (object class, vehicle phrase, plate / street text)? */
  M.recognized = (s) => {
    try {
      if (T.detect && T.detect.classFor && T.detect.classFor(s)) return "det";
      if (T.plates && T.plates.parse && T.plates.parse(s)) return "plate";
      const v = T.vehicle && T.vehicle.parse && T.vehicle.parse(s);
      // only a clean vehicle phrase: "regular local street buses" (extra words) is part of a sentence, not a term
      // a vehicle phrase must name a colour / type / make ("red car", "tour bus"); a bare class is the detector's (classFor above),
      // so "regular local street buses" (filler words around "buses") is part of a sentence, not a term
      if (v && (v.color || v.type || v.make) && !(v.extra && v.extra.length)) return "vehicle";
    } catch (_) {}
    return null;
  };
  const tidy = (s) => String(s || "").replace(/\s+/g, " ").replace(/^[\s.!?]+|[\s.!?]+$/g, "").trim();
  /** Query → list of terms (one term = not a multi search). Commas, ";", "+", "/" and "&" always split; " and " / " or " only
   *  when every part is something the searches understand ("red car and cyclist"), so a sentence for the picture search
   *  ("a person in a hoodie and a mask") stays whole. Multi-word classes ("traffic light", "white police car") are never split,
   *  and a colour on its own is joined to what follows ("black and white police car"). */
  M.split = (q) => {
    let s = tidy(q);
    if (!s) return [];
    if (/^ask\b/i.test(s)) return [s];   // cloud questions are one sentence
    if (!isPlateWords(s)) s = s.replace(VERB, "");
    const hard = s.split(/\s*(?:,|;|\+|&|\s\/\s|\/(?=\s*[a-z]))\s*/i).map(tidy).filter(Boolean);
    let out = [];
    for (const piece of hard) {
      const soft = piece.split(/\s+(?:and|or)\s+/i).map(tidy).filter(Boolean);
      // colour-only parts join the next part ("black and white police car", "red or blue car")
      const merged = [];
      for (let i = 0; i < soft.length; i++) {
        let p = soft[i];
        while (i + 1 < soft.length && p.split(" ").every((w) => COLOR_WORDS.has(w.toLowerCase()))) { p = p + " and " + soft[i + 1]; i++; }
        merged.push(p);
      }
      if (merged.length > 1 && merged.every((p) => M.recognized(p) || M.recognized(p.replace(/^(?:a|an|the)\s+/i, "")))) out.push(...merged);
      else out.push(piece);
    }
    const seen = new Set();
    out = out.map((p) => p.replace(/^(?:a|an|the|any)\s+/i, "")).filter((p) => { const k = p.toLowerCase(); if (!p || seen.has(k)) return false; seen.add(k); return true; });
    if (out.length === 1 && hard.length === 1 && out[0] !== s) return [tidy(q)];   // nothing split: the query as typed
    return out.slice(0, M.MAX);
  };
  M.isMulti = (q) => M.split(q).length > 1;

  /** One term → what runs it: plate (plate index), vehicle (detector + vehicle details), det (detector class), clip (picture search). */
  M.classify = (term, i) => {
    const D = T.detect, V = T.vehicle, L = T.plates;
    const c = { term, i, color: M.COLORS[i % M.COLORS.length], kind: "clip" };
    const pl = L && L.parse && L.parse(term);
    if (pl && (pl.explicit || !(D && D.classFor(term)))) { c.kind = L.enabled() ? "plate" : "plate-off"; c.plate = pl; return c; }
    if (V && V.handlesQuery(term) && D && D.enabled()) { c.kind = "vehicle"; c.vq = V.parse(term); return c; }
    if (D && D.enabled() && D.prefs().model !== "gdino" && D.classFor(term)) { c.kind = "det"; c.cls = D.classFor(term); return c; }
    if (D && D.enabled() && D.prefs().model === "gdino") { c.kind = "gdino"; return c; }
    return c;
  };
  M.kindLabel = { det: "object", vehicle: "vehicle details", plate: "plate", "plate-off": "plate (off in Settings)", clip: "picture search", gdino: "Grounding DINO" };

  const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]);
  /** Chips: one per term (colour, name, count), plus "All". Tapping one shows only that term; tapping it again (or All) shows all. */
  M.renderChips = () => {
    const S = T.search, terms = S && S.terms;
    let html = "";
    if (terms && terms.length) {
      const all = S.allHits || [];
      html += '<button type="button" class="q-chip term-chip' + (S.termFilter == null ? " on" : "") + '" data-term="all" aria-pressed="' + (S.termFilter == null) + '">All · ' + (S.bestFiltered ? S.bestFiltered().length : all.length) + "</button>";
      for (const c of terms) {
        const n = all.filter((h) => h.ti === c.i).length;
        html += '<button type="button" class="q-chip term-chip' + (S.termFilter === c.i ? " on" : "") + (n ? "" : " none") + '" data-term="' + c.i + '" aria-pressed="' + (S.termFilter === c.i) + '" title="' + esc(M.kindLabel[c.kind] || c.kind) + '" style="--term:' + c.color + '"><i style="background:' + c.color + '"></i>' + esc(c.term) + " · " + n + "</button>";
      }
    }
    for (const id of ["findChips", "usChips", "ssChips"]) { const n = $(id); if (n) { n.innerHTML = html; n.hidden = !html; } }
  };
  document.addEventListener("click", (e) => {
    const b = e.target && e.target.closest && e.target.closest(".term-chip");
    if (!b || !T.search || !T.search.setTermFilter) return;
    const v = b.getAttribute("data-term"), i = v === "all" ? null : +v;
    T.search.setTermFilter(i === T.search.termFilter ? null : i);
  });

  const yieldUI = () => new Promise((r) => setTimeout(r, 0));
  /** The one pass. terms = classify()d terms, list = search.js detSamples (every camera), ui = { status, stopped }.
   *  → { rows: [{…hit, ti}], frames, ms, clipFrames, plateNote } */
  M.scan = async (terms, list, ui) => {
    const D = T.detect, V = T.vehicle, L = T.plates, S = T.search, ev = T.player.ev;
    const t0 = performance.now();
    const det = terms.filter((c) => c.kind === "det"), veh = terms.filter((c) => c.kind === "vehicle"), clip = terms.filter((c) => c.kind === "clip");
    const plate = terms.filter((c) => c.kind === "plate"), gd = terms.filter((c) => c.kind === "gdino");
    const rows = [];
    // vehicle terms: set up (CLIP for type / make loads here, once)
    for (const c of veh) c.st = await V.begin(c.term, ui);
    // picture-search terms: text vectors once, against a neutral road
    let neutral = null;
    if (clip.length) {
      await S.clip.load(ui.status);
      const vs = await S.clip.texts(["a dashcam photo of an ordinary road with cars and no matching subject"].concat(clip.map((c) => "a dashcam photo of " + c.term)));
      neutral = vs[0]; clip.forEach((c, k) => { c.vec = vs[k + 1]; c.scored = []; });
    }
    const needDet = det.length || veh.length;
    const minConf = Math.min(...det.map((c) => D.classConf(c.cls)), ...(veh.length ? [V.detConf()] : []), 1);
    const small = det.filter((c) => D.useTiles(c.cls));
    const clipEvery = clip.length ? Math.max(1, Math.ceil(list.length / (D && D.isMobile && D.isMobile() ? 60 : 140))) : 0;
    const canvas = clip.length ? (M.canvas || (M.canvas = document.createElement("canvas"))) : null;
    if (canvas) { canvas.width = 224; canvas.height = 224; }
    const names = terms.filter((c) => c.kind !== "plate-off").map((c) => c.term).join(", ");
    let frames = 0, clipFrames = 0, detRuns = 0;
    for (let i = 0; i < list.length; i++) {
      if (ui.stopped()) break;
      const s = list[i], key = s.cam + "|" + s.t.toFixed(2);
      const wantClip = clip.length && i % clipEvery === 0;
      if (!needDet && !wantClip) continue;
      ui.status("Looking for " + names + " in one pass · frame " + (i + 1) + " of " + list.length + " · " + (CAM_LABEL[s.cam] || s.cam) + ". The video stays on this computer.");
      let v = null, all = null;
      const getFrame = async () => (v = v || (await D.frameAt(s.cam, s.t)));
      const getAll = async () => {
        if (all) return all;
        const cached = D.frameCache.get(key);
        if (cached && cached.conf <= minConf) return (all = cached.dets);
        if (!(await getFrame())) return null;
        try { all = await D.detectImage(v, v.videoWidth, v.videoHeight, { conf: minConf }); detRuns++; D.frameCache.set(key, { conf: minConf, dets: all }); }
        catch (e) { if (!rows.length && i === 0) throw e; console.warn("frame skipped", e); return null; }
        return all;
      };
      frames++;
      if (det.length) {
        const dets = await getAll();
        if (dets) {
          let tiles = null;
          for (const c of det) {
            const conf = D.classConf(c.cls);
            let mine = dets.filter((d) => d.label === c.cls && d.conf >= conf);
            if (!mine.length && small.includes(c) && (await getFrame())) {   // small things: 2×2 zoomed tiles, once per frame for all small terms
              if (!tiles) try { tiles = await D.detectImage(v, v.videoWidth, v.videoHeight, { conf: Math.min(...small.map((x) => D.classConf(x.cls))), tiles: true, tilesOnly: true }); } catch (_) { tiles = []; }
              mine = tiles.filter((d) => d.label === c.cls && d.conf >= conf);
            }
            if (!mine.length) continue;
            const top = mine.reduce((a, b) => (b.conf > a.conf ? b : a));
            rows.push({ t: s.t, cam: s.cam, score: top.conf, conf: top.conf, cls: top.cls, label: top.label, det: true, tiled: !!top.tiled, count: mine.length, box: { x: top.x, y: top.y, w: top.w, h: top.h }, ti: c.i });
          }
        }
      }
      for (const c of veh) {
        try { await V.frame(c.st, s, getAll, getFrame); } catch (e) { console.warn("vehicle term", c.term, e); }
      }
      if (wantClip && (await getFrame())) {
        try {
          const ck = s.it.key + "|" + s.local.toFixed(1);
          let vec = S.cache.get(ck);
          if (!vec) { canvas.getContext("2d", { willReadFrequently: true }).drawImage(v, 0, 0, 224, 224); vec = await S.clip.image(canvas); S.cache.set(ck, vec); }
          clipFrames++;
          for (const c of clip) c.scored.push({ t: s.t, cam: s.cam, score: S.cos(vec, c.vec) - S.cos(vec, neutral), label: c.term, termVec: c.vec, ti: c.i });
        } catch (e) { console.warn("picture term frame skipped", e); }
      }
      if ((i & 3) === 0) await yieldUI();
    }
    const ms = performance.now() - t0;
    // live detections are results too (same model / threshold), as in the single search
    for (const c of det) if (D.liveRows) for (const r of D.liveRows(c.term)) rows.push({ ...r, ti: c.i });
    for (const c of veh) { const vr = await V.end(c.st, ms, frames); for (const r of vr) rows.push({ ...r, ti: c.i }); }
    for (const c of clip) {
      const strong = c.scored.filter((r) => r.score >= 0.02);
      const pick = strong.length ? strong : c.scored.slice().sort((a, b) => b.score - a.score).slice(0, 3).map((r) => ({ ...r, weak: true }));
      rows.push(...pick);
    }
    // plates: the plate index is built once (shared by every plate term), then each term is matched against it
    for (const c of plate) {
      if (ui.stopped()) break;
      try { const pr = await L.runSearch(c.term, ev, S.camsFor("around", ev), ui); for (const r of pr) rows.push({ ...r, ti: c.i }); } catch (e) { console.warn("plate term", c.term, e); }
    }
    // Grounding DINO: one prompt per run, so each term is its own detector pass (no shared output)
    for (const c of gd) {
      if (ui.stopped()) break;
      try { const gr = await D.runSearch(c.term, list, { ...ui, cams: list.cams }); for (const r of gr) rows.push({ ...r, ti: c.i }); } catch (e) { console.warn("gdino term", c.term, e); }
    }
    M.last = { ms: performance.now() - t0, loopMs: ms, frames, detRuns, clipFrames, terms: terms.map((c) => c.term + ":" + c.kind) };
    return { rows, ...M.last };
  };

  /** Group each term's rows like its single search does, and mark each hit with its term (colour, chip). */
  M.group = (terms, rows) => {
    const S = T.search, V = T.vehicle, L = T.plates, out = [];
    for (const c of terms) {
      const mine = rows.filter((r) => r.ti === c.i);
      if (!mine.length) continue;
      const g = c.kind === "vehicle" ? V.cluster(mine) : c.kind === "plate" && L.cluster ? L.cluster(mine) : S.cluster(mine);
      for (const h of g) {
        h.ti = c.i; h.term = c.term; h.termColor = c.color; h.termKind = c.kind;
        if (c.kind !== "plate") { if (c.kind !== "vehicle") h.best = false; }   // "Best match only" is for plates; vehicle labels keep their text
        if (c.kind === "clip") { h.label = c.term; }
        out.push(h);
      }
    }
    return out.sort((a, b) => a.t - b.t || a.ti - b.ti);
  };
})();
