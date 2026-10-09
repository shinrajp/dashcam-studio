/* indexer.js — read-only scan of a TeslaCam folder → events (date, time, trigger, location, cameras, files).
 * Reuses the web app's own parsers (UMD): teslacam.js (naming/grouping/triggers), mp4.js, sei.js, crypto.js. */
"use strict";
const path = require("path"), crypto = require("crypto");
const RO = require("./readonly");
const TC = require("../../js/teslacam.js"), MP4 = require("../../js/mp4.js"), SEI = require("../../js/sei.js"), CR = require("../../js/crypto.js");

const VIDEO = /\.(mp4|mov|m4v)$/i;

async function walk(dir, out, depth) {
  if (depth > 4) return;
  let ents;
  try { ents = await RO.readdir(dir); } catch (_) { return; }
  for (const e of ents) {
    if (e.name.startsWith(".") || e.name.startsWith("._")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out, depth + 1);
    else if (e.isFile() && (VIDEO.test(e.name) || /^event\.json$/i.test(e.name))) out.push(p);
  }
}

async function pool(items, n, fn) {
  const q = items.slice(); const run = async () => { while (q.length) await fn(q.shift()); };
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, run));
}

/** First GPS fix in a plain clip's SEI (reads only the first ~60 samples' heads). */
async function gpsFromClip(file) {
  let r;
  try {
    r = await RO.reader(file);
    const tr = await MP4.demux(r);
    if (!/^avc[13]$/.test(tr.fmt) || !tr.description) return null;
    const lenSize = (tr.description[4] & 3) + 1;
    for (let i = 0; i < Math.min(tr.n, 60); i++) {
      const buf = await r.read(tr.offsets[i], tr.offsets[i] + Math.min(tr.sizes[i], 4096));
      let m = SEI.fromSample(buf, lenSize, true);
      if (!m && tr.sizes[i] > 4096) m = SEI.fromSample(await r.read(tr.offsets[i], tr.offsets[i] + tr.sizes[i]), lenSize, true);
      if (m && m.lat && m.lon && Math.abs(m.lat) > 0.01) return { lat: m.lat, lon: m.lon };
    }
  } catch (_) {} finally { if (r) await r.close().catch(() => {}); }
  return null;
}

async function durationOf(file) {
  let r;
  try { r = await RO.reader(file); const tr = await MP4.demux(r); return { dur: tr.duration, w: tr.width, h: tr.height, fps: tr.fps }; }
  catch (_) { return null; } finally { if (r) await r.close().catch(() => {}); }
}

/**
 * Scan <driveRoot>/TeslaCam (or a folder that IS a TeslaCam folder / contains clips).
 * @returns {Promise<{root, teslacam, events}>}
 */
async function scan(teslacamDir, opts) {
  opts = opts || {};
  const base = path.dirname(teslacamDir); // paths are reported relative to the drive root: "TeslaCam/SavedClips/…"
  const files = [];
  await walk(teslacamDir, files, 0);
  const items = [], jsonByDir = {};
  await pool(files, 8, async (abs) => {
    const rel = path.relative(base, abs).split(path.sep).join("/");
    const name = path.basename(abs);
    if (/^event\.json$/i.test(name)) { try { jsonByDir[TC.dirOf(rel)] = JSON.parse(await RO.readText(abs)); } catch (_) {} return; }
    try {
      const st = await RO.stat(abs);
      const head = st.size ? await RO.head(abs, CR.PROBE) : new Uint8Array(0);
      const c = CR.classify(head, st.size);
      if (c.kind === "unknown" || c.kind === "empty") return;
      items.push({ abs, path: rel, name, size: st.size, mtime: st.mtimeMs, kind: c.kind, header: c.header || null, reason: c.reason || null });
    } catch (_) {}
  });
  const groups = TC.group(items, jsonByDir);
  const events = [];
  for (const g of groups) {
    const clips = g.clips.map((c) => ({ stamp: c.stamp, time: c.time, files: Object.fromEntries(Object.entries(c.files).map(([cam, it]) => [cam, { abs: it.abs, path: it.path, name: it.name, size: it.size, kind: it.kind, header: it.header, reason: it.reason }])) }));
    let enc = 0, locked = 0, broken = 0, bytes = 0, fileCount = 0;
    for (const c of clips) for (const f of Object.values(c.files)) { fileCount++; bytes += f.size; if (f.kind === "encrypted") { enc++; locked++; } if (f.kind === "undecryptable") broken++; }
    const fp = crypto.createHash("sha1").update(g.id + "\n" + clips.flatMap((c) => Object.values(c.files).map((f) => f.name + ":" + f.size)).sort().join("\n")).digest("hex").slice(0, 16);
    events.push({
      id: g.id, fingerprint: fp, dir: g.dir, source: g.source, trigger: g.trigger, time: g.time, eventTime: g.eventTime,
      stamp: clips[0].stamp, location: { ...g.location, from: g.location.lat != null ? "event.json" : g.location.city ? "event.json" : null },
      cams: g.cams, clips, encrypted: enc, locked, broken, fileCount, bytes, meta: g.meta || null,
    });
  }
  // Durations + GPS fallback from SEI (plain files only; encrypted ones are filled in after decryption).
  await pool(events, 4, async (ev) => {
    let total = 0, approx = false;
    for (const c of ev.clips) {
      const f = ["front", "back", "left_repeater", "right_repeater", "left_pillar", "right_pillar"].map((k) => c.files[k]).find((x) => x && x.kind === "plain");
      const d = f ? await durationOf(f.abs) : null;
      if (d) c.dur = d.dur; else { c.dur = 60; approx = true; }
      total += c.dur;
    }
    ev.duration = total; ev.durationApprox = approx;
    if (ev.location.lat == null && !opts.noGps) await fillGps(ev);
  });
  return { teslacam: teslacamDir, base, events };
}

async function fillGps(ev, fileMap) {
  for (const c of ev.clips) {
    for (const cam of ["front", "back"]) {
      const f = c.files[cam]; if (!f) continue;
      const abs = fileMap ? fileMap(f) : f.kind === "plain" ? f.abs : null;
      if (!abs) continue;
      const g = await gpsFromClip(abs);
      if (g) { ev.location = { ...ev.location, lat: g.lat, lon: g.lon, from: "gps" }; return true; }
    }
  }
  return false;
}

/** Find TeslaCam folders under a drive root (TeslaCam/ directly, or the folder itself). */
async function findTeslaCam(root) {
  const cands = [path.join(root, "TeslaCam"), path.join(root, "teslacam")];
  for (const c of cands) {
    try {
      const st = await RO.stat(c);
      if (!st.isDirectory()) continue;
      const kids = (await RO.readdir(c)).map((e) => e.name);
      if (kids.some((k) => /^(SavedClips|SentryClips|RecentClips)$/i.test(k))) return c;
    } catch (_) {}
  }
  if (/^teslacam$/i.test(path.basename(root))) return root;
  return null;
}

module.exports = { scan, findTeslaCam, fillGps, gpsFromClip, durationOf };
