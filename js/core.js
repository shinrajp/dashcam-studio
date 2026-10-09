/* core.js — namespace, camera table, preferences, event bus, small helpers. */
(function () {
  "use strict";
  const T = (window.TDC = window.TDC || {});

  // Grid order: 3 columns × 2 rows.
  T.GRID = ["left_pillar", "front", "right_pillar", "left_repeater", "back", "right_repeater"];
  T.CAM_LABEL = {
    front: "Front", back: "Rear", left_pillar: "Left Pillar", right_pillar: "Right Pillar",
    left_repeater: "Left Repeater", right_repeater: "Right Repeater",
  };
  T.TESLA_BLUE = "#3E6AE1";

  // ── event bus ──
  const handlers = {};
  T.on = (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); };
  T.emit = (name, data) => { (handlers[name] || []).slice().forEach((fn) => { try { fn(data); } catch (e) { console.error(name, e); } }); };

  // ── preferences (localStorage) ──
  const PREFS_KEY = "tdc.prefs.v1";
  T.DEFAULT_PREFS = {
    advanced: false,
    show: { labels: true, hud: true, map: true, fsd: true, time: true },
    hudItems: { signals: true, speed: true, gear: true, steering: true, brake: true, accel: true, compass: true, gforce: true, gps: true },
    units: "mph",
    steerInvert: false,
    accelSwap: false,
    hudScale: 1,
    mapTiles: true,
    mapStyle: "osm",
    mapFollow: false,
    panels: {
      hud: { fx: 0.5, fy: 0.975 },
      map: { fx: 0.985, fy: 0.975, wu: 400, hu: 300 },
      fsd: { fx: 0.5, fy: 0.035 },
    },
    export: { preset: "compat", codec: "h264", res: "native", range: "full" },
    rate: 1,
  };
  function merge(def, val) {
    if (Array.isArray(def) || typeof def !== "object" || def === null) {
      return typeof val === typeof def ? val : def;
    }
    const out = {};
    for (const k of Object.keys(def)) out[k] = merge(def[k], val && typeof val === "object" ? val[k] : undefined);
    return out;
  }
  function loadPrefs() {
    try { return merge(T.DEFAULT_PREFS, JSON.parse(localStorage.getItem(PREFS_KEY) || "null")); }
    catch (_) { return merge(T.DEFAULT_PREFS, null); }
  }
  T.prefs = loadPrefs();
  T.savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(T.prefs)); } catch (_) {} };
  T.setPref = (path, value) => {
    const parts = path.split(".");
    let o = T.prefs;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    o[parts[parts.length - 1]] = value;
    T.savePrefs();
    T.emit("prefs", path);
  };
  T.resetPrefs = (section) => {
    if (section) T.prefs[section] = JSON.parse(JSON.stringify(T.DEFAULT_PREFS[section]));
    else T.prefs = merge(T.DEFAULT_PREFS, null);
    T.savePrefs();
    T.emit("prefs", section || "*");
  };

  // ── helpers ──
  T.$ = (id) => document.getElementById(id);
  T.el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  T.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  T.fmtTime = (s, withFrac) => {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), sec = s - m * 60;
    const whole = Math.floor(sec);
    const base = `${m}:${String(whole).padStart(2, "0")}`;
    return withFrac ? `${base}.${String(Math.floor((sec - whole) * 10))}` : base;
  };
  T.fmtBytes = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.round(n / 1e3) + " KB");
  T.pad2 = (n) => String(n).padStart(2, "0");
  T.fmtDate = (d) => `${d.getFullYear()}-${T.pad2(d.getMonth() + 1)}-${T.pad2(d.getDate())}`;
  T.fmtClock = (d) => `${T.pad2(d.getHours())}:${T.pad2(d.getMinutes())}:${T.pad2(d.getSeconds())}`;
  T.fmtDateLong = (d) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  /** Yield to the event loop without timer throttling (keeps working in background tabs). */
  T.yieldNow = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(0); });
  T.download = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  };
  T.blobReader = (blob) => ({ size: blob.size, read: async (a, b) => new Uint8Array(await blob.slice(a, b).arrayBuffer()) });

  let toastTimer = 0;
  T.toast = (text, kind, ms) => {
    const t = T.$("toast");
    if (!t) return;
    t.textContent = text;
    t.className = "toast show" + (kind ? " " + kind : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = "toast"; }, ms || 3800);
  };
})();
