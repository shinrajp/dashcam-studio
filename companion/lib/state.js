/* state.js — remembers which events were already exported (by content fingerprint) so they are skipped next time. */
"use strict";
const fs = require("fs"), path = require("path");
const P = require("./platform"), RO = require("./readonly");

const file = () => path.join(P.configDir(), "state.json");
let cache = null;
function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(file(), "utf8")); } catch (_) { cache = {}; }
  cache.events = cache.events || {};
  return cache;
}
function save() { const f = file(); RO.assertNotOnDrive(f); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + ".tmp", JSON.stringify(cache, null, 1)); fs.renameSync(f + ".tmp", f); }
const get = (fp) => load().events[fp] || null;
function put(fp, rec) { load().events[fp] = { ...(load().events[fp] || {}), ...rec, updated: Date.now() }; save(); }
const isDone = (fp) => { const r = get(fp); return !!(r && r.status === "done"); };
module.exports = { load, save, get, put, isDone, file };
