/* teslacam.js — TeslaCam folder conventions shared by the web app and the companion (Node):
 * file-name parsing, grouping into events/clips, event.json trigger labels. Pure functions only. */
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else { root.TDC = root.TDC || {}; root.TDC.teslacam = m; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const CAM_ALIASES = { front: "front", back: "back", rear: "back", left_repeater: "left_repeater", right_repeater: "right_repeater", left_pillar: "left_pillar", right_pillar: "right_pillar" };
  const NAME_RE = /(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(front|back|rear|left_repeater|right_repeater|left_pillar|right_pillar)\.mp4$/i;
  const LOOSE = [
    ["left_pillar", /left[_\-\s]?pillar/i], ["right_pillar", /right[_\-\s]?pillar/i],
    ["left_repeater", /left[_\-\s]?repeater/i], ["right_repeater", /right[_\-\s]?repeater/i],
    ["front", /(^|[_\-\s.])front([_\-\s.]|$)/i], ["back", /(^|[_\-\s.])(back|rear)([_\-\s.]|$)/i],
  ];
  const SOURCES = ["SavedClips", "SentryClips", "RecentClips"];

  /** { cam, stamp ("YYYY-MM-DD_HH-MM-SS"), time (ms, local clock) } or null for non-camera files. */
  function parseName(name) {
    const m = NAME_RE.exec(name);
    if (m) {
      const time = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
      return { cam: CAM_ALIASES[m[7].toLowerCase()], stamp: `${m[1]}-${m[2]}-${m[3]}_${m[4]}-${m[5]}-${m[6]}`, time };
    }
    if (!/\.(mp4|mov|m4v)$/i.test(name)) return null;
    for (const [cam, re] of LOOSE) if (re.test(name)) return { cam, stamp: null, time: null };
    return null;
  }

  function sourceOf(path) {
    const parts = String(path).split(/[\\/]/);
    for (const s of SOURCES) if (parts.some((p) => p.toLowerCase() === s.toLowerCase())) return s;
    return "Files";
  }
  const dirOf = (path) => { const s = String(path).replace(/\\/g, "/"); const i = s.lastIndexOf("/"); return i < 0 ? "" : s.slice(0, i); };
  const baseName = (path) => String(path).replace(/\\/g, "/").split("/").pop();

  /** Parse "2026-10-07T14:33:41" (local car time) → ms */
  function parseIsoLocal(s) {
    const m = /(\d{4})-(\d{2})-(\d{2})[T _](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ""));
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
  }

  const REASONS = [
    [/^sentry_aware_object_detection/, "Sentry · object detected", "sentry"],
    [/^sentry_aware_accel/, "Sentry · vehicle bumped", "sentry"],
    [/^sentry_locked_handle_pulls/, "Sentry · door handle pulled", "sentry"],
    [/^sentry_panic_alarm|^sentry_.*alarm/, "Sentry · alarm triggered", "sentry"],
    [/^sentry/, "Sentry event", "sentry"],
    [/^user_interaction_dashcam_icon_tapped/, "Saved · dashcam icon tapped", "user"],
    [/^user_interaction_dashcam_panel_save/, "Saved · dashcam panel", "user"],
    [/^user_interaction_dashcam_launcher_action_tapped/, "Saved · launcher button", "user"],
    [/^user_interaction_honk/, "Saved · horn honked", "user"],
    [/^user_interaction_voice/, "Saved · voice command", "user"],
    [/^user_interaction/, "Saved by driver", "user"],
    [/^vehicle_auto_emergency_braking/, "Automatic emergency braking", "safety"],
    [/collision|crash|airbag/, "Collision detected", "safety"],
    [/^vehicle_/, "Vehicle-triggered save", "safety"],
  ];
  /** Friendly trigger: { label, kind: sentry | user | safety | recent | files, raw } */
  function triggerOf(reason, source) {
    const r = String(reason || "").toLowerCase();
    if (r) {
      for (const [re, label, kind] of REASONS) if (re.test(r)) return { label, kind, raw: reason };
      return { label: r.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()), kind: "user", raw: reason };
    }
    if (source === "SentryClips") return { label: "Sentry event", kind: "sentry", raw: null };
    if (source === "SavedClips") return { label: "Saved clip", kind: "user", raw: null };
    if (source === "RecentClips") return { label: "Recent driving", kind: "recent", raw: null };
    return { label: "Loaded files", kind: "files", raw: null };
  }

  /**
   * Group files into events → clips → cameras.
   * items: [{ path, name, size, ...anything }]; jsonByDir: { dir: parsedEventJson }
   * looseJson: [parsedEventJson] read from files without a folder path (multi-file picker, single dropped files);
   * they are matched to folder-less events by their "timestamp".
   * Consecutive clips in one folder belong to the same event unless the gap exceeds gapMs.
   * An event.json is never applied to more than one event; when the match is ambiguous the event gets none.
   */
  function group(items, jsonByDir, gapMs, looseJson) {
    gapMs = gapMs || 90000;
    const byDir = new Map();
    const loose = [];
    for (const it of items) {
      const p = parseName(it.name);
      if (!p) continue;
      it.cam = p.cam; it.stamp = p.stamp; it.time = p.time;
      if (!p.stamp) { loose.push(it); continue; }
      const dir = dirOf(it.path);
      if (!byDir.has(dir)) byDir.set(dir, new Map());
      const clips = byDir.get(dir);
      if (!clips.has(p.stamp)) clips.set(p.stamp, { stamp: p.stamp, time: p.time, files: {} });
      const c = clips.get(p.stamp);
      if (!c.files[p.cam] || (it.size || 0) > (c.files[p.cam].size || 0)) c.files[p.cam] = it;
    }
    const events = [];
    for (const [dir, clipMap] of byDir) {
      const clips = [...clipMap.values()].sort((a, b) => a.time - b.time);
      let cur = null;
      for (const c of clips) {
        if (!cur || c.time - cur.clips[cur.clips.length - 1].time > gapMs) {
          cur = { dir, source: sourceOf(dir + "/x"), clips: [] };
          events.push(cur);
        }
        cur.clips.push(c);
      }
    }
    if (loose.length) {
      const files = {};
      for (const it of loose) if (!files[it.cam]) files[it.cam] = it;
      events.push({ dir: "", source: "Files", clips: [{ stamp: null, time: null, files }] });
    }
    assignMeta(events, jsonByDir, looseJson);
    for (const ev of events) {
      ev.time = ev.clips[0].time;
      ev.id = (ev.dir || "files") + "|" + (ev.clips[0].stamp || "loose");
      ev.trigger = triggerOf(ev.meta && ev.meta.reason, ev.source);
      ev.eventTime = ev.meta ? parseIsoLocal(ev.meta.timestamp) : null;
      const lat = ev.meta ? parseFloat(ev.meta.est_lat) : NaN, lon = ev.meta ? parseFloat(ev.meta.est_lon) : NaN;
      ev.location = { city: (ev.meta && ev.meta.city) || null, lat: Number.isFinite(lat) && lat !== 0 ? lat : null, lon: Number.isFinite(lon) && lon !== 0 ? lon : null };
      const cams = new Set();
      ev.clips.forEach((c) => Object.keys(c.files).forEach((k) => cams.add(k)));
      ev.cams = [...cams];
    }
    events.sort((a, b) => (b.time || 0) - (a.time || 0));
    return events;
  }

  const CLIP_MS = 60000, MATCH_SLACK_MS = 60000;
  /** ms between an event.json timestamp and an event's clip span [first clip start, last clip start + 60 s]. */
  function distanceTo(ev, t) {
    const a = ev.clips[0].time, b = ev.clips[ev.clips.length - 1].time;
    if (a == null || b == null) return Infinity;
    return t < a ? a - t : t > b + CLIP_MS ? t - (b + CLIP_MS) : 0;
  }
  /** Match event.json objects to candidate events by timestamp. Returns Map(event → json); ambiguous → no entry. */
  function matchByTime(jsons, cands) {
    const got = new Map(); // event → [json…]
    for (const j of jsons) {
      const t = parseIsoLocal(j && j.timestamp);
      if (t == null) continue;
      let best = null, bestD = Infinity, tie = false;
      for (const ev of cands) {
        const d = distanceTo(ev, t);
        if (d > MATCH_SLACK_MS) continue;
        if (d < bestD) { best = ev; bestD = d; tie = false; } else if (d === bestD) tie = true;
      }
      if (best && !tie) { if (!got.has(best)) got.set(best, []); got.get(best).push(j); }
    }
    const out = new Map();
    for (const [ev, js] of got) if (js.length === 1) out.set(ev, js[0]); // two event.json files → can't tell which
    return out;
  }
  function assignMeta(events, jsonByDir, looseJson) {
    for (const ev of events) ev.meta = null;
    const byDir = new Map();
    for (const ev of events) { if (!byDir.has(ev.dir)) byDir.set(ev.dir, []); byDir.get(ev.dir).push(ev); }
    const loose = (looseJson || []).slice();
    if (jsonByDir && jsonByDir[""]) loose.push(jsonByDir[""]);
    for (const [dir, evs] of byDir) {
      if (dir === "") continue;
      const j = jsonByDir && jsonByDir[dir];
      if (!j) continue;
      if (evs.length === 1) { evs[0].meta = j; continue; }       // the normal case: one event per folder
      for (const [ev, m] of matchByTime([j], evs)) ev.meta = m;  // folder split into several events by gaps
    }
    const cands = byDir.get("") || [];
    if (!cands.length || !loose.length) return;
    if (cands.length === 1 && loose.length === 1 && parseIsoLocal(loose[0] && loose[0].timestamp) == null) { cands[0].meta = loose[0]; return; }
    for (const [ev, m] of matchByTime(loose, cands)) ev.meta = m;
  }

  return { parseName, sourceOf, dirOf, baseName, group, triggerOf, parseIsoLocal, SOURCES };
});
