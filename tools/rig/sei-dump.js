#!/usr/bin/env node
/* sei-dump.js — telemetry rows of one clip as JSON (for the rig calibration tools).
 * node tools/rig/sei-dump.js <clip.mp4> [out.json] */
"use strict";
const fs = require("fs"), MP4 = require("../../js/mp4.js"), SEI = require("../../js/sei.js");
(async () => {
  const file = process.argv[2]; if (!file) { console.error("usage: sei-dump.js <clip.mp4> [out.json]"); process.exit(2); }
  const fd = fs.openSync(file, "r"), size = fs.fstatSync(fd).size;
  const reader = { size, read: async (a, b) => { const n = Math.max(0, Math.min(b, size) - a), buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, a); return new Uint8Array(buf.buffer, buf.byteOffset, n); } };
  const tr = await MP4.demux(reader), res = await SEI.parseClip(reader, tr);
  const out = { file: require("path").basename(file), fps: res.fps, duration: res.duration, rows: res.rows.map(([t, m]) => Object.assign({ t: +t.toFixed(4) }, m)) };
  const s = JSON.stringify(out); if (process.argv[3]) fs.writeFileSync(process.argv[3], s); else process.stdout.write(s);
  console.error(`${out.rows.length} rows, ${out.duration.toFixed(2)} s`);
})().catch((e) => { console.error(e.message); process.exit(1); });
