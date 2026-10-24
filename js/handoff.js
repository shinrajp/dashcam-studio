/* handoff.js — hand-off cue (tag handoff-m2).
 * A person walking out of one camera's picture walks into a neighbour's. The cue predicts the exit from a tile edge (outward speed
 * from the live tracker) and lights up the neighbouring tile's ENTRY edge — wherever that tile currently sits (layout preset, mirror,
 * portrait grid, focused camera), because the neighbour is looked up from a fixed PHYSICAL table, not from the screen.
 *
 * Physical model. Seen from above, the six cameras look in these directions (degrees clockwise from the car's nose; approximate):
 *     front 0 · right_pillar ~105 · right_repeater ~150 · back 180 · left_repeater ~210 · left_pillar ~255
 * Every Tesla camera feed is a normal (un-mirrored) picture, so the right edge of a picture is always the direction of INCREASING
 * bearing: someone leaving a tile through its RIGHT edge moves clockwise around the car and enters the next camera on the chain
 * through that camera's LEFT edge; leaving through the LEFT edge goes counter-clockwise, entering the previous camera on its RIGHT edge.
 *   left_pillar ↔ front ↔ right_pillar · left_repeater ↔ back ↔ right_repeater · pillar ↔ repeater on each side
 *   (chain order: front → right_pillar → right_repeater → back → left_repeater → left_pillar → front)
 * Raw (un-mirrored) picture coordinates everywhere; screen sides are derived with T.layout (mirror) at draw time.
 * Pure functions are exported for node tests (module.exports). */
(function (root) {
  "use strict";
  const CHAIN = ["front", "right_pillar", "right_repeater", "back", "left_repeater", "left_pillar"];
  const HEADING = { front: 0, right_pillar: 105, right_repeater: 150, back: 180, left_repeater: 210, left_pillar: 255 };
  const SHORT = { front: "F", right_pillar: "RP", right_repeater: "RR", back: "B", left_repeater: "LR", left_pillar: "LP" };
  const OPPOSITE = { left: "right", right: "left" };
  /** Neighbour of a camera in a direction: "cw" (clockwise: the way the picture's right edge points) or "ccw". */
  function neighbor(cam, dir) {
    const i = CHAIN.indexOf(cam); if (i < 0) return null;
    return CHAIN[(i + (dir === "cw" ? 1 : CHAIN.length - 1)) % CHAIN.length];
  }
  /** Leaving `cam` through its raw `side` ("left"|"right") → { to, entry } (the neighbour and the raw edge it is entered through). */
  function entryFor(cam, side) {
    const to = neighbor(cam, side === "right" ? "cw" : "ccw");
    return to ? { to, entry: OPPOSITE[side] } : null;
  }
  /** Where in a neighbour's picture a person from `cam` appears (edge only: a pair table, for tests and docs). */
  function pairs() { const out = []; for (const c of CHAIN) for (const s of ["left", "right"]) { const e = entryFor(c, s); out.push({ from: c, exit: s, to: e.to, entry: e.entry }); } return out; }

  const DEFAULTS = { vmin: 0.05, horizon: 2.5, edgeGap: 0.02, maxAge: 1.6, minHits: 2 };
  /** Exit prediction for ONE tracked box in raw picture coordinates.
   *  tr: {x, y, w, h, vx, (vy), n, seen, t} — vx in picture widths per second (+ = rightwards), now in event seconds.
   *  → { cam?, side, eta, strength, to, entry } or null. A person who is standing still, moving inwards or far from the edge gives null. */
  function predictExit(cam, tr, now, opt) {
    const o = Object.assign({}, DEFAULTS, opt || {});
    if (!tr || (tr.n || 1) < o.minHits) return null;
    if (now != null && tr.seen != null && now - tr.seen > o.maxAge) return null;
    const vx = tr.vx || 0; if (Math.abs(vx) < o.vmin) return null;
    const side = vx > 0 ? "right" : "left";
    const gap = side === "right" ? 1 - (tr.x + tr.w) : tr.x;                 // distance from the box edge to the picture edge
    if (gap < -0.5) return null;
    const lag = now != null && tr.t != null ? Math.max(0, now - tr.t) : 0;   // the box is as of its last look: it has moved since
    const eta = Math.max(0, gap / Math.abs(vx) - lag);
    if (gap > o.edgeGap && eta > o.horizon) return null;
    const e = entryFor(cam, side); if (!e) return null;
    return { from: cam, side, eta, strength: Math.max(0.15, Math.min(1, 1 - eta / o.horizon)), to: e.to, entry: e.entry };
  }
  /** Weight for the live scheduler: the neighbour of a camera with an imminent exit is worth looking at sooner. */
  function camBoost(cam, cues) { let b = 1; for (const c of cues || []) if (c.to === cam) b = Math.max(b, 1 + 1.5 * c.strength); return b; }

  const api = { CHAIN, HEADING, SHORT, neighbor, entryFor, pairs, predictExit, camBoost, DEFAULTS };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }

  // ───────────────────────── browser part ─────────────────────────
  const T = (root.TDC = root.TDC || {});
  const H = (T.handoff = Object.assign({ cues: [], last: 0 }, api));
  const $ = (id) => document.getElementById(id);
  H.on = () => !(T.prefs && T.prefs.cue === false);
  /** All person tracks that are confirmed and current, with the picture-time they are as of. */
  H.tracks = (t) => {
    const D = T.detect;
    if (T.people && T.people.current) return T.people.current(t);   // with global id + colour
    return D && D.personTracks ? D.personTracks(t).map((x) => Object.assign(x, { color: "#ffd23f" })) : [];
  };
  /** Does the app want live detections for the cue (so the live loop keeps running even with no boxes shown)? */
  H.wantsLive = () => H.on() && !!(T.player && T.player.ev);
  /** Sentry events: person detection on every camera (weighted scheduling keeps the budget); phones included unless the phone is in low-power mode. */
  H.forceAll = () => {
    try {
      const ev = T.player && T.player.ev; if (!H.on() || !ev || !ev.trigger || ev.trigger.kind !== "sentry") return false;
      const D = T.detect; if (D && D.lowPower && D.lowPower()) return false;
      return true;
    } catch (_) { return false; }
  };
  /** Zoomed second looks for the live loop (detect.js): the regions where a person is most likely to be missed right now.
   *   1. around a person track of this camera that the full-frame look did not confirm (partly hidden / small)
   *   2. the ENTRY edge of this camera when a cue says someone is about to arrive (small head blob at the edge)
   *  A look costs a model run, so: Sentry events or a person already tracked, not in Fast / Battery speed, at most one per camera per
   *  gap (longer on phones), only while the average look is cheap enough. Returns [{x,y,w,h}] (normalised) or null. */
  H.zoomLast = {};
  H.zoomPlan = (cam, dets, t) => {
    try {
      const D = T.detect, ev = T.player && T.player.ev; if (!H.on() || !D || !ev) return null;
      if (T.prefs && T.prefs.personZoom === false) return null;
      const sp = D.speed ? D.speed() : "balanced"; if (sp === "fast" || sp === "battery") return null;
      const mobile = D.isMobile && D.isMobile(), now = performance.now();
      if (now - (H.zoomLast[cam] || 0) < (mobile ? 1800 : 700)) return null;
      if (D.avgMs && D.avgMs() > (mobile ? 260 : 450)) return null;
      const sentry = ev.trigger && ev.trigger.kind === "sentry";
      const tracks = H.tracks(t), anyPerson = tracks.length > 0;
      if (!sentry && !anyPerson) return null;
      const crops = [], persons = (dets || []).filter((d) => d.label === "person");
      const clamp = (c) => { c.w = Math.min(1, c.w); c.h = Math.min(1, c.h); c.x = Math.max(0, Math.min(1 - c.w, c.x)); c.y = Math.max(0, Math.min(1 - c.h, c.y)); return c; };
      const iouF = D.iou || (() => 0);
      for (const tr of tracks) {
        if (tr.cam !== cam) continue;
        if (persons.some((p) => iouF(p, tr) > 0.2)) continue;   // found again: nothing hidden
        const w = Math.max(0.3, tr.w * 2.4), h = Math.max(0.4, tr.h * 1.8);
        crops.push(clamp({ x: tr.x + tr.w / 2 - w / 2, y: tr.y + tr.h / 2 - h / 2, w, h }));
      }
      for (const c of H.cues) if (c.to === cam && crops.length < 2) crops.push(clamp(c.entry === "left" ? { x: 0, y: 0.15, w: 0.4, h: 0.7 } : { x: 0.6, y: 0.15, w: 0.4, h: 0.7 }));
      if (!crops.length) return null;
      H.zoomLast[cam] = now;
      return crops.slice(0, 2);
    } catch (_) { return null; }
  };
  H.boost = (cam) => camBoost(cam, H.cues);
  /** Compute cues for the current time from the live tracks. */
  H.compute = (t) => {
    const cues = [], tracks = H.tracks(t);
    for (const tr of tracks) {
      const c = predictExit(tr.cam, tr, t, { maxAge: tr.ex || DEFAULTS.maxAge });
      if (c) cues.push(Object.assign(c, { id: tr.id, gid: tr.gid, color: tr.color, box: { x: tr.x, y: tr.y, w: tr.w, h: tr.h } }));
    }
    cues.sort((a, b) => a.eta - b.eta);
    return cues;
  };
  const ARROW = { left: "→", right: "←" };   // shown on the SCREEN: entering at the screen's left edge walks rightwards
  function layer(cam) {
    const t = T.player && T.player.tiles && T.player.tiles[cam]; if (!t) return null;
    let el = t.tile.querySelector(":scope > .ho-cue");
    if (!el) {
      el = document.createElement("div"); el.className = "ho-cue"; el.setAttribute("aria-hidden", "true");
      el.innerHTML = '<div class="ho-glow"></div><div class="ho-arrow"></div>'; t.tile.appendChild(el);
    }
    return el;
  }
  /** Paint the cues: the entry edge of the neighbouring tile, on the SCREEN side that edge is on now (mirror-aware). */
  H.paint = (cues) => {
    const want = {};
    for (const c of cues || []) {
      const screen = T.layout ? T.layout.side(c.to, c.entry) : c.entry;
      const k = c.to; if (want[k] && want[k].eta <= c.eta) continue;   // the most imminent one per tile
      want[k] = Object.assign({}, c, { screen });
    }
    for (const cam of T.GRID) {
      const t = T.player.tiles && T.player.tiles[cam]; if (!t) continue;
      const w = want[cam], el = t.tile.querySelector(":scope > .ho-cue");
      if (!w) { if (el && el.dataset.on) { el.dataset.on = ""; el.hidden = true; el.removeAttribute("data-side"); } continue; }
      const e = el || layer(cam);
      const sig = w.screen + "|" + w.color + "|" + Math.round(w.strength * 4);
      e.hidden = false;
      if (e.dataset.on !== sig) {
        e.dataset.on = sig; e.dataset.side = w.screen; e.dataset.from = w.from;
        e.style.setProperty("--ho", w.color || "#ffd23f"); e.style.setProperty("--ho-s", String(0.45 + 0.55 * w.strength));
        e.querySelector(".ho-arrow").textContent = ARROW[w.screen] + (w.bestGuess ? "" : "");
        e.title = "Someone is leaving the " + (T.CAM_LABEL[w.from] || w.from).toLowerCase() + " camera toward here";
      }
    }
  };
  H.refresh = () => {
    if (!H.on() || !T.player || !T.player.ev) { if (H.cues.length) { H.cues = []; H.paint([]); } return; }
    const now = performance.now(); if (now - H.last < 60) return; H.last = now;
    const cues = H.compute(T.player.time || 0);
    const sig = cues.map((c) => c.from + c.side + c.to + (c.gid || c.id) + Math.round(c.strength * 4)).join(",");
    if (sig !== H._sig) { H._sig = sig; H.cues = cues; H.paint(cues); T.emit && T.emit("handoff", cues); }
    else H.cues = cues;
  };
  H.clear = () => { H.cues = []; H._sig = ""; if (T.player && T.player.tiles) H.paint([]); };
  H.init = () => {
    if (!T.on) return;
    T.on("time", H.refresh); T.on("layout", () => { H._sig = ""; H.refresh(); }); T.on("player-open", H.clear);
    const chip = $("chipCue");
    if (chip) {
      const sync = () => { chip.setAttribute("aria-pressed", String(H.on())); chip.classList.toggle("on", H.on()); };
      chip.addEventListener("click", () => { T.setPref("cue", !H.on()); sync(); H.clear(); });
      T.on("prefs", sync); sync();
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(H.init, 0)); else setTimeout(H.init, 0);
})(typeof window !== "undefined" ? window : globalThis);
