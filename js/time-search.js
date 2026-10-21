/* time-search.js — type a time in the search box and jump there (all cameras together).
 *   20:53:46 · 8:53 pm · 8:53:10pm · at 20:53   → clock time (the event's start from the file names + the position)
 *   2:30 · 1:05.5 · 90s · 1m30s · t=75          → position in the event (when it fits in the event)
 *   +1:05 · -10s · +30s                          → from where the player is now
 * A time that is ambiguous ("2:30" is also 02:30 / 14:30) prefers the position in the event when it fits; the other
 * meaning is offered as a second result when it also falls inside the event. Times outside the event never fail
 * silently: the result says so and offers the nearest end. Pure parsing (parse, resolve) also runs in node tests. */
(function (root) {
  "use strict";
  const pad = (n) => String(n).padStart(2, "0");
  const clockStr = (d) => pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  const posStr = (s) => { s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60); return h ? h + ":" + pad(m) + ":" + pad(x) : m + ":" + pad(x); };

  /** Text → what was typed: {mode: "clock"|"pos"|"rel"|"either", ...} or null (not a time). */
  function parse(q) {
    let s = String(q || "").trim().toLowerCase().replace(/\s+/g, " ");
    const tEq = /^t\s*=/.test(s);
    s = s.replace(/^(?:go\s*to|goto|jump\s*to|skip\s*to|seek(?:\s*to)?|time|at|@|t\s*=)\s*/, "").trim();
    let m;
    // relative: +1:05, -10s, +1m30s, + 90
    if ((m = s.match(/^([+-])\s*(.+)$/))) { const d = dur(m[2]); return d == null ? null : { mode: "rel", sec: (m[1] === "-" ? -1 : 1) * d, typed: q.trim() }; }
    // 12-hour clock: 8 pm, 8:53 pm, 8:53:10pm, 8.53 p.m.
    if ((m = s.match(/^(\d{1,2})(?:[:.](\d{2}))?(?:[:.](\d{2}))?\s*([ap])\.?\s*m\.?$/))) {
      let h = +m[1]; const mi = m[2] ? +m[2] : 0, se = m[3] ? +m[3] : 0;
      if (h < 1 || h > 12 || mi > 59 || se > 59) return null;
      if (m[4] === "p" && h !== 12) h += 12; if (m[4] === "a" && h === 12) h = 0;
      return { mode: "clock", h, m: mi, s: se, hasSec: !!m[3], typed: q.trim() };
    }
    // h:mm:ss → clock (24 h) when the event has a clock, else a position
    if ((m = s.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/))) {
      const h = +m[1], mi = +m[2], se = +m[3];
      if (mi > 59 || se > 59) return null;
      return { mode: "either", prefer: "clock", h, m: mi, s: se, hasSec: true, sec: h * 3600 + mi * 60 + se + (m[4] ? +("0." + m[4]) : 0), typed: q.trim() };
    }
    // m:ss → a position if it fits, else a clock time (hh:mm)
    if ((m = s.match(/^(\d{1,3}):(\d{2})(?:\.(\d+))?$/))) {
      const a = +m[1], b = +m[2];
      if (b > 59) return null;
      return { mode: "either", prefer: "pos", sec: a * 60 + b + (m[3] ? +("0." + m[3]) : 0), h: a, m: b, s: 0, hasSec: false, clockOk: a <= 23 && !m[3], typed: q.trim() };
    }
    const d = /[a-z]/.test(s) || tEq ? dur(s) : null;   // "90s", "1m30s", "2 min" (a bare number is not a time)
    if (d != null) return { mode: "pos", sec: d, typed: q.trim() };
    return null;
  }
  /** "1:05" | "65" | "65s" | "1m5s" | "1 min 5 sec" | "1.5s" → seconds, else null. */
  function dur(s) {
    s = String(s).trim().toLowerCase();
    let m;
    if ((m = s.match(/^(\d{1,3}):(\d{2})(?:\.(\d+))?$/))) return +m[2] > 59 ? null : +m[1] * 60 + +m[2] + (m[3] ? +("0." + m[3]) : 0);
    if ((m = s.match(/^(\d+(?:\.\d+)?)$/))) return +m[1];
    m = s.match(/^(?:(\d+)\s*h(?:ours?|rs?)?\s*)?(?:(\d+)\s*m(?:in(?:utes?)?|ins)?\s*)?(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?|ecs)?)?$/);
    if (m && (m[1] || m[2] || m[3])) return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
    return null;
  }
  /** Parsed time + the event → results [{t, inRange, label, kind, clock}] (first = best).
   *  ev: {duration, clips:[{start, dur, time(ms)|null}]}, now: player position (s). */
  function resolve(p, ev, now) {
    if (!p || !ev) return [];
    const D = ev.duration || 0, out = [];
    const clips = (ev.clips || []).filter((c) => c.time);
    const t0 = clips.length ? clips[0].time - clips[0].start * 1000 : null;   // wall clock (ms) at position 0
    const wallAt = (t) => { if (!clips.length) return null; let c = clips[0]; for (const k of clips) if (k.start <= t + 1e-6) c = k; return new Date(c.time + Math.round((t - c.start) * 1000)); };
    const posOf = (ms) => {   // wall clock → position (clips may have gaps between them)
      for (const c of clips) { const a = c.time, b = c.time + (c.dur || 60) * 1000; if (ms >= a - 500 && ms <= b + 500) return Math.max(0, Math.min(D, c.start + (ms - a) / 1000)); }
      return null;
    };
    const span = () => { const a = wallAt(0), b = wallAt(D); return a && b ? clockStr(a) + "–" + clockStr(b) : ""; };
    const posRes = (t, kind) => {
      if (t >= -0.001 && t <= D + 0.25) { const tt = Math.max(0, Math.min(D, t)), w = wallAt(tt); return { t: tt, inRange: true, kind, label: "Jump to " + posStr(tt) + " into the event" + (w ? " (" + clockStr(w) + ")" : "") }; }
      const end = t < 0 ? 0 : D;
      return { t: end, inRange: false, kind, label: posStr(Math.abs(t)) + (t < 0 ? " before the start" : " is past the end of this event (" + posStr(D) + " long)") + ". Jump to the " + (t < 0 ? "start" : "end") + " instead" };
    };
    const clockRes = (h, mi, se, hasSec) => {
      if (t0 == null) return null;
      const base = new Date(t0), cands = [];
      for (const dd of [0, 1, -1]) {
        const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dd, h, mi, se).getTime();
        const t = posOf(d);
        if (t != null) cands.push({ d, t });
        else if (!hasSec) { const t2 = posOf(d + 59000); if (t2 != null && d < (wallAt(0) || 0).getTime() + 1000) cands.push({ d, t: 0, minute: true }); }   // "20:53" and the event starts at 20:53:40
      }
      const label = pad(h) + ":" + pad(mi) + (hasSec ? ":" + pad(se) : "");
      if (cands.length) { const c = cands[0]; return { t: c.t, inRange: true, kind: "clock", clock: label, label: "Jump to " + label + " (" + posStr(c.t) + " into the event)" + (c.minute ? " · the event starts at " + clockStr(wallAt(0)) : "") }; }
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, mi, se).getTime(), before = d < t0;
      return { t: before ? 0 : D, inRange: false, kind: "clock", clock: label, label: label + " is not in this event (" + span() + "). Jump to the " + (before ? "start" : "end") + " instead" };
    };
    if (p.mode === "rel") { const r = posRes((now || 0) + p.sec, "rel"); r.label = (r.inRange ? "Jump " + (p.sec < 0 ? "back " : "ahead ") + posStr(Math.abs(p.sec)) + " to " + posStr(r.t) : r.label); out.push(r); }
    else if (p.mode === "pos") out.push(posRes(p.sec, "pos"));
    else if (p.mode === "clock") { const c = clockRes(p.h, p.m, p.s, p.hasSec); if (c) out.push(c); else out.push({ t: 0, inRange: false, kind: "clock", label: "This event has no clock time (its file names have no date). Try a position like 2:30 instead" }); }
    else if (p.mode === "either") {
      const pos = p.sec <= D + 0.25 ? posRes(p.sec, "pos") : null;
      const clk = (p.prefer === "clock" || p.clockOk) ? clockRes(p.h, p.m, p.s, p.hasSec) : null;
      const pm = p.prefer === "pos" && p.h >= 1 && p.h <= 11 ? clockRes(p.h + 12, p.m, p.s, p.hasSec) : null;   // "8:53" in the evening
      const good = [pos, clk && clk.inRange ? clk : null, pm && pm.inRange ? pm : null].filter(Boolean);
      if (p.prefer === "clock" && clk && clk.inRange) good.sort((a, b) => (b === clk) - (a === clk));
      if (good.length) out.push(...good);
      else if (p.prefer === "clock" && clk) out.push(clk);
      else if (clk) out.push(posRes(p.sec, "pos"), clk);
      else out.push(posRes(p.sec, "pos"));
    }
    return out.filter((r) => r && r.label);
  }
  const api = { parse, resolve, dur, posStr, clockStr };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    root.TDC = root.TDC || {};
    const T = root.TDC;
    T.timeSearch = Object.assign(T.timeSearch || {}, api);
    /** For search.js: the query is a time → results, else null. */
    T.timeSearch.lookup = (q) => {
      const p = parse(q); if (!p || !T.player || !T.player.ev) return null;
      return resolve(p, T.player.ev, T.player.time || 0);
    };
  }
})(typeof window !== "undefined" ? window : null);
