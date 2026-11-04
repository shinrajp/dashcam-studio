#!/usr/bin/env node
/* telemetry.js — everything the depth replay needs from a drive's six files' own telemetry, as JSON:
 * per camera the frame times (display order, seconds of that file's clip) and the SEI rows (js/sei.js), the files' clock
 * offsets (js/rig.js clockOffsets), and the rig in use (js/rig.js MEASURED, or a rig JSON loaded with set(): an export of the
 * in-app calibration or tools/rig output — then per-camera `delay` comes with it).
 *
 *   node tools/depth3d/telemetry.js <out.json> cam=<clip.mp4> … [--rig rig.json]
 */
"use strict";
const fs = require("fs"), path = require("path");
const MP4 = require("../../js/mp4.js"), SEI = require("../../js/sei.js"), RIG = require("../../js/rig.js");

function reader(file) {
  const fd = fs.openSync(file, "r"), size = fs.fstatSync(fd).size;
  return { size, close: () => fs.closeSync(fd),
    read: async (a, b) => { const n = Math.max(0, Math.min(b, size) - a), buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, a); return new Uint8Array(buf.buffer, buf.byteOffset, n); } };
}

(async () => {
  const args = process.argv.slice(2), out = args.shift(); let rigFile = null; const clips = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rig") rigFile = args[++i];
    else { const m = /^([a-z_]+)=(.+)$/.exec(args[i]); if (!m) throw new Error("bad argument " + args[i]); clips[m[1]] = m[2]; }
  }
  if (!out || !Object.keys(clips).length) { console.error("usage: telemetry.js <out.json> cam=<clip.mp4> … [--rig rig.json]"); process.exit(2); }
  let took = null;
  if (rigFile) took = RIG.set(JSON.parse(fs.readFileSync(rigFile, "utf8")));
  const res = { cams: {}, rig: {}, body: RIG.bodyBoxes(), aspect: RIG.ASPECT, rigSource: rigFile ? { file: path.basename(rigFile), cams: took } : "js/rig.js MEASURED" };
  const rows = {};
  for (const [cam, file] of Object.entries(clips)) {
    const r = reader(file);
    try {
      const tr = await MP4.demux(r), p = await SEI.parseClip(r, tr);
      const frames = Array.from(tr.pts).sort((a, b) => a - b).map((u) => +(u / 1e6).toFixed(5));
      res.cams[cam] = { file: path.basename(file), width: tr.width, height: tr.height, fps: p.fps, duration: p.duration, frames,
        rows: p.rows.map(([t, m]) => ({ t: +t.toFixed(5), speed: m.speed, heading: m.heading, gear: m.gear })) };
      if (p.rows.length) rows[cam] = p.rows;
    } finally { r.close(); }
  }
  res.clocks = RIG.clockOffsets(rows);
  for (const cam of RIG.CAMS) { const c = RIG.get(cam); if (c) res.rig[cam] = c; }
  fs.writeFileSync(out, JSON.stringify(res));
  console.error(Object.entries(res.cams).map(([c, v]) => `${c}: ${v.frames.length} frames, ${v.rows.length} telemetry rows`).join("; "));
  console.error("clock offsets:", JSON.stringify(res.clocks));
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
