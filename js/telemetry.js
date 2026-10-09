/* telemetry.js — per-clip telemetry tracks, time lookup, GPS route for the active event. */
(function () {
  "use strict";
  const T = window.TDC;
  const TOL = 0.0005;

  class Track {
    constructor(rows) {
      const n = (this.n = rows.length);
      this.pts = Float64Array.from(rows.map((r) => r[0]));
      this.msgs = rows.map((r) => r[1]);
      const d = [];
      for (let i = 1; i < n; i++) if (this.pts[i] > this.pts[i - 1]) d.push(this.pts[i] - this.pts[i - 1]);
      d.sort((a, b) => a - b);
      this.med = d.length ? d[d.length >> 1] : 1 / 30;
      this.maxGap = Math.max(0.15, 3 * this.med);
      const maxPedal = this.msgs.reduce((a, m) => Math.max(a, m.pedal || 0), 0);
      this.pedalScale = maxPedal <= 1.0001 ? 100 : 1;
      // Blinkers: if the flag is held for long runs it is the stalk state → flash like the car (~1.5 Hz).
      for (const side of ["L", "R"]) {
        const key = "blink" + side, start = new Float64Array(n), runs = [];
        for (let i = 0; i < n; i++) {
          const on = this.msgs[i][key];
          const cont = on && i > 0 && this.msgs[i - 1][key] && this.pts[i] - this.pts[i - 1] <= this.maxGap;
          start[i] = cont ? start[i - 1] : this.pts[i];
          if (on && (i === n - 1 || !this.msgs[i + 1][key])) runs.push(this.pts[i] - start[i] + this.med);
        }
        runs.sort((a, b) => a - b);
        this["run" + side] = start;
        this["flash" + side] = runs.length ? runs[runs.length >> 1] > 0.8 : false;
      }
      this.gps = [];
      for (let i = 0; i < n; i++) {
        const m = this.msgs[i];
        if ((m.lat === 0 && m.lon === 0) || !(Math.abs(m.lat) <= 85) || !(Math.abs(m.lon) <= 180)) continue;
        this.gps.push(i);
      }
    }
    index(t) {
      let lo = 0, hi = this.n - 1, idx = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (this.pts[mid] <= t + TOL) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
      return idx;
    }
    at(t) {
      const idx = this.index(t);
      if (idx < 0 || t - this.pts[idx] > this.maxGap) return null;
      const m = this.msgs[idx];
      let steer = m.steer;
      if (idx + 1 < this.n && this.pts[idx + 1] - this.pts[idx] <= this.maxGap && t > this.pts[idx]) {
        const f = Math.min(1, (t - this.pts[idx]) / (this.pts[idx + 1] - this.pts[idx]));
        steer = m.steer + (this.msgs[idx + 1].steer - m.steer) * f;
      }
      const lit = (on, flash, start) => on && (!flash || ((t - start) % 0.6667) < 0.4);
      return {
        m, idx, steer,
        litL: lit(m.blinkL, this.flashL, this.runL[idx]),
        litR: lit(m.blinkR, this.flashR, this.runR[idx]),
        pedalPct: T.clamp((m.pedal || 0) * this.pedalScale, 0, 100),
      };
    }
  }

  const tel = (T.telemetry = {
    event: null, tracks: [], state: [], token: 0, status: "idle", routeCache: null, parsed: 0, total: 0,
  });

  tel.reset = () => { tel.token++; tel.event = null; tel.tracks = []; tel.state = []; tel.status = "idle"; tel.routeCache = null; T.emit("telemetry"); };

  /** Pick the camera file to read telemetry from (front first). */
  function clipSources(clip) {
    return ["front", "back", "left_repeater", "right_repeater", "left_pillar", "right_pillar"].map((c) => clip.files[c]).filter((e) => e && e.blob && e.info);
  }

  async function parseClipIdx(ev, i, token) {
    tel.state[i] = "parsing";
    let track = null;
    for (const e of clipSources(ev.clips[i])) {
      try {
        const res = await T.sei.parseClip(T.blobReader(e.blob), e.info, { yieldFn: T.yieldNow, cancelled: () => token !== tel.token });
        if (token !== tel.token) return;
        if (res && res.rows.length) { track = new Track(res.rows); break; }
      } catch (err) { console.warn("telemetry parse failed", e.name, err); }
    }
    tel.tracks[i] = track;
    tel.state[i] = clipSources(ev.clips[i]).length ? "done" : "waiting"; // waiting = encrypted, not yet unlocked
    tel.routeCache = null;
  }

  function summarize() {
    const n = tel.state.length;
    const done = tel.state.filter((s) => s === "done").length;
    const any = tel.tracks.some((t) => t);
    tel.parsed = done; tel.total = n;
    if (done < n && tel.state.some((s) => s === "parsing" || s === "queued")) tel.status = any ? "partial" : "parsing";
    else tel.status = any ? "ready" : (tel.state.some((s) => s === "waiting") ? "locked" : "none");
  }

  /** (Re)start background parsing for an event. Current clip first, then forward, then backward. */
  tel.load = async (ev, startClip) => {
    const token = ++tel.token;
    if (tel.event !== ev) { tel.tracks = []; tel.state = []; }
    tel.event = ev;
    tel.routeCache = null;
    const n = ev.clips.length;
    for (let i = 0; i < n; i++) if (tel.state[i] !== "done") tel.state[i] = "queued";
    summarize(); T.emit("telemetry");
    const s = T.clamp(startClip || 0, 0, n - 1);
    const order = [];
    for (let i = s; i < n; i++) order.push(i);
    for (let i = s - 1; i >= 0; i--) order.push(i);
    for (const i of order) {
      if (token !== tel.token) return;
      if (tel.state[i] === "done") continue;
      await parseClipIdx(ev, i, token);
      if (token !== tel.token) return;
      summarize(); T.emit("telemetry");
    }
    summarize(); T.emit("telemetry");
  };

  /** Resolves when every clip has been parsed (used before export). */
  tel.whenComplete = async () => {
    while (tel.event && tel.state.some((s) => s === "queued" || s === "parsing")) await new Promise((r) => setTimeout(r, 100));
  };

  /** Telemetry at global event time t, or null. */
  tel.at = (t) => {
    const ev = tel.event;
    if (!ev) return null;
    const i = T.player ? T.player.clipIndexAt(t) : 0;
    const tr = tel.tracks[i];
    if (!tr) return null;
    return tr.at(t - ev.clips[i].start);
  };

  /** GPS route for the whole event: [{ t, lat, lon, x, y, h }] (x/y = Web-Mercator world px at zoom 0). */
  tel.route = () => {
    if (tel.routeCache) return tel.routeCache;
    const pts = [];
    const ev = tel.event;
    if (ev) ev.clips.forEach((c, i) => {
      const tr = tel.tracks[i];
      if (!tr) return;
      let lastT = -1;
      for (const k of tr.gps) {
        const t = c.start + tr.pts[k];
        if (t - lastT < 0.1) continue; // 10 Hz is plenty for drawing
        lastT = t;
        const m = tr.msgs[k];
        const w = tel.merc(m.lat, m.lon);
        pts.push({ t, lat: m.lat, lon: m.lon, x: w[0], y: w[1], h: m.heading, ap: m.ap });
      }
    });
    return (tel.routeCache = pts);
  };
  tel.merc = (lat, lon) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return [((lon + 180) / 360) * 256, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256];
  };
  /** Interpolated position on the route at time t: { x, y, lat, lon, h } or null. */
  tel.positionAt = (t) => {
    const r = tel.route();
    if (!r.length) return null;
    let lo = 0, hi = r.length - 1, i = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (r[mid].t <= t) { i = mid; lo = mid + 1; } else hi = mid - 1; }
    if (i < 0) return { ...r[0], before: true };
    if (i >= r.length - 1) return r[r.length - 1];
    const a = r[i], b = r[i + 1];
    if (b.t - a.t > 2) return a;
    const f = (t - a.t) / (b.t - a.t);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, h: a.h, t };
  };
  /** Accelerations (m/s²) honouring the swap-axes calibration. */
  tel.accel = (m) => (T.prefs.accelSwap ? { lon: m.ay, lat: m.ax, z: m.az } : { lon: m.ax, lat: m.ay, z: m.az });
  tel.Track = Track;
})();
