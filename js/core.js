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
    mapDock: "over",   // over (on the video) | aside (docked beside it) | float (anywhere in the window, js/overlays.js)
    autohide: "3",   // ui-glass-2: Settings ▸ Appearance ▸ Auto-hide — "2" | "3" | "5" seconds | "never"; ?autohide= overrides for one visit
    glass: "auto",   // ui-glass-1: Settings ▸ Appearance ▸ Glass — "auto" (tint follows the video) | "clear" | "solid"; ?glass= overrides for one visit
    mapFloat: { fx: -1, fy: -1, pin: 0 },   // floating map: left / top as fractions of the free window area (-1 = default spot); export never uses this
    panels: {
      hud: { fx: 0.5, fy: 0.975 },
      map: { fx: 0.985, fy: 0.975, wu: 400, hu: 300 },
      fsd: { fx: 0.5, fy: 0.035 },
    },
    export: { preset: "compat", codec: "h264", res: "native", range: "full", extras: "auto", order: "viewer" },   // extras: auto | overlay | fill | panel (auto = Fill black area when the picture has one, else Add panel); order: viewer | standard
    rate: 1,
    cameraBar: { on: true, hintSeen: false, dock: "over", side: "top", grid: { fx: -1, fy: -1 }, focus: { fx: -1, fy: -1 }, from: "over", float: { fx: -1, fy: -1 } },   // dock: over | beside | float (ui-glass-5: anywhere in the window; from = where it docks back; float = left / top as fractions of the free window area)
    cue: true,   // hand-off cue (js/handoff.js)
    carView: false,   // top-down car with tracked people (js/car-view.js)
    carPanel: { pinned: false, collapsed: false, w: 0, fx: -1, fy: -1 },   // floating car view: pinned = locked, w = width px (0 = default), fx/fy = left/top as fractions of the window (-1 = default corner)
    crossCam: "auto",   // cross-camera matching (beta): auto | on | off (js/people.js)
    show360: false,   // show the 360 view (beta) button + the 360 export preset (off by default, Settings ▸ Labs; ?show360=1 forces it on for this visit, ?show360=0 off)
    layout: "auto",   // camera layout preset: auto | current | rear | mirror (js/layout.js)
    camsHidden: { left_pillar: false, front: false, right_pillar: false, left_repeater: false, back: false, right_repeater: false },
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
  /** Is the 360 view (beta) offered? Pref show360 (default off); a ?show360=1 / =0 in the URL overrides it for this visit only. */
  T.show360On = () => {
    try { const m = /(?:[?&#])show360=([01])\b/.exec(location.search + location.hash); if (m) return m[1] === "1"; } catch (_) {}
    return !!T.prefs.show360;
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
  /** iPhone / iPad (iPadOS reports itself as a Mac, but with touch). */
  T.isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  /** Can this browser hand files to the system share sheet (iOS: Save Video / Save to Files / AirDrop)? */
  T.canShareFiles = (files) => { try { return !!(navigator.canShare && navigator.share && navigator.canShare({ files })); } catch (_) { return false; } };
  T.blobReader = (blob) => ({ size: blob.size, read: async (a, b) => new Uint8Array(await blob.slice(a, b).arrayBuffer()) });

  let toastTimer = 0, placeTimer = 0, toastWatch = null;
  /** tap-redact: the toast never sits on the draw bar, the floating Search / Redact buttons or the Redact panel. It moves up above the one in
   *  the way (or to the free side of a tall docked panel). Measured from its layout box, so the slide-in transform does not matter. */
  function placeToast(t) {
    t.style.bottom = ""; t.style.left = ""; t.style.maxWidth = "";
    try {
      const vw = innerWidth, vh = innerHeight, seen = (e) => { if (!e || e.hidden) return null; const cs = getComputedStyle(e); if (cs.display === "none" || cs.visibility === "hidden") return null; const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1 ? r : null; };
      const obs = []; ["crBar", "usBtn", "rdBtn", "usPanel", "stageBar"].forEach((id) => { const e = T.$(id), r = id === "stageBar" && !(e && (e.closest("#stage") || e.classList.contains("bar-floating"))) ? null : seen(e); if (r && id === "stageBar" && +getComputedStyle(e).opacity < 0.05) return; if (r) obs.push(r); if (id === "crBar" && r) [...e.children].forEach((c) => { const q = seen(c); if (q) obs.push(q); }); });
      if (!obs.length) return;
      let w = t.offsetWidth; const h = t.offsetHeight; let bottom = parseFloat(getComputedStyle(t).bottom) || 0, cx = vw / 2;
      for (let k = 0; k < 6; k++) {
        const L = cx - w / 2, R = cx + w / 2, B = vh - bottom, Tp = B - h;
        const o = obs.find((r) => r.left < R + 6 && r.right > L - 6 && r.top < B + 6 && r.bottom > Tp - 6); if (!o) break;
        const up = vh - o.top + 8;
        if (vh - up - h >= 56 && o.height <= vh * 0.7) { bottom = up; continue; }
        const left = o.left, right = vw - o.right, room = Math.max(left, right);   // a tall panel: use the free side
        if (room < Math.min(w, 220) + 16) break;
        cx = left >= right ? left / 2 : o.right + right / 2; t.style.maxWidth = Math.round(room - 16) + "px"; w = t.offsetWidth;
      }
      if (bottom !== (parseFloat(getComputedStyle(t).bottom) || 0)) t.style.bottom = Math.round(bottom) + "px";
      if (cx !== vw / 2) t.style.left = Math.round(cx) + "px";
    } catch (_) {}
  }
  T.toast = (text, kind, ms) => {
    const t = T.$("toast");
    if (!t) return;
    t.textContent = text;
    t.className = "toast show" + (kind ? " " + kind : "");
    if (!toastWatch && typeof MutationObserver === "function" && document.body) { toastWatch = new MutationObserver(() => { if (t.classList.contains("show")) placeToast(t); }); toastWatch.observe(document.body, { attributes: true, attributeFilter: ["class"] }); }   // a panel / draw bar opening while it shows
    placeToast(t); clearTimeout(placeTimer); placeTimer = setTimeout(() => { if (t.classList.contains("show")) placeToast(t); }, 300);   // again once a bar / panel that was just opened has settled
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = "toast"; }, ms || 3800);
  };
})();
