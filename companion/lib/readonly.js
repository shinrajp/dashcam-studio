/* readonly.js — the ONLY way the companion touches a Tesla drive: read-only opens, stat, readdir.
 * Every write the companion makes goes through assertNotOnDrive(), which refuses any path inside a TeslaCam root. */
"use strict";
const fs = require("fs"), path = require("path");

const roots = new Set();
const norm = (p) => { const r = path.resolve(p); return process.platform === "win32" ? r.toLowerCase() : r; };
function registerRoot(p) { roots.add(norm(p)); }

function assertNotOnDrive(p) {
  const t = norm(p);
  for (const r of roots) if (t === r || t.startsWith(r + path.sep)) throw new Error("Refusing to write inside a TeslaCam drive: " + p);
  return p;
}

/** Random-access reader used by mp4.js / sei.js / crypto.js: { size, read(start, end) → Uint8Array }. */
async function reader(file) {
  const fh = await fs.promises.open(file, "r"); // "r" = O_RDONLY
  const { size } = await fh.stat();
  return {
    size,
    async read(a, b) {
      b = Math.min(b, size);
      const buf = Buffer.alloc(Math.max(0, b - a));
      if (buf.length) await fh.read(buf, 0, buf.length, a);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
    },
    close: () => fh.close(),
  };
}
async function head(file, n) { const r = await reader(file); try { return await r.read(0, n); } finally { await r.close(); } }
const stream = (file) => fs.createReadStream(file, { flags: "r" });
const readdir = (d) => fs.promises.readdir(d, { withFileTypes: true });
const stat = (p) => fs.promises.stat(p);
const readText = (p) => fs.promises.readFile(p, { encoding: "utf8", flag: "r" });

/** Safe write helpers (outputs, cache, state) — never on a drive. */
async function writeFile(p, data) { assertNotOnDrive(p); await fs.promises.mkdir(path.dirname(p), { recursive: true }); await fs.promises.writeFile(p, data); }
async function mkdir(p) { assertNotOnDrive(p); await fs.promises.mkdir(p, { recursive: true }); }

module.exports = { registerRoot, assertNotOnDrive, reader, head, stream, readdir, stat, readText, writeFile, mkdir, roots };
