/* config.js — config.json in the companion's config dir. Every key is optional; defaults below. */
"use strict";
const fs = require("fs"), path = require("path");
const P = require("./platform");

const DEFAULTS = {
  outputDir: null,            // null → ~/Movies/TeslaCam Exports (macOS) or %USERPROFILE%\Videos\TeslaCam Exports (Windows)
  share: null,                // null | "icloud" | "onedrive" | "dropbox" | "/any/synced/folder" → also copy the compatible MP4 there
  sources: ["SavedClips", "SentryClips"], // add "RecentClips" to also render the rolling dashcam buffer (can be hours)
  exportOriginal: false,      // also render the native-resolution stitched video (tileW·3 × tileH·2)
  originalCodec: "h264",      // h264 | hevc  (browser renderer can also do av1 / vp9)
  renderer: "auto",           // auto (headless Chrome/Edge, else ffmpeg) | browser | ffmpeg
  browserPath: null,          // override Chrome/Edge location
  decrypt: false,             // auto-decrypt encrypted clips (needs one Tesla sign-in; see README)
  notify: true,
  pollSeconds: 4,
  maxChunkMinutes: 15,        // long RecentClips runs are split into parts of at most this length
  port: 18780,                // local-only server (127.0.0.1) for the renderer, sign-in page and live library
  overlays: { labels: true, hud: true, map: true, fsd: true, time: true },
  prefs: {},                  // extra web-app prefs for renders, e.g. {"units":"kmh","mapTiles":false}
  extraFolders: [],           // folders to watch besides removable drives (e.g. a NAS copy of TeslaCam)
};

const file = () => path.join(P.configDir(), "config.json");

function load() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(file(), "utf8")); } catch (_) {}
  const cfg = { ...DEFAULTS, ...user, overlays: { ...DEFAULTS.overlays, ...(user.overlays || {}) } };
  cfg.outputDir = cfg.outputDir ? path.resolve(expand(cfg.outputDir)) : P.defaultOutputDir();
  return cfg;
}
function expand(p) { return String(p).replace(/^~(?=$|[\\/])/, P.home()); }

function saveUser(patch) {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(file(), "utf8")); } catch (_) {}
  Object.assign(user, patch);
  fs.mkdirSync(P.configDir(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(user, null, 2) + "\n");
  return user;
}

/** Where to copy the compatible MP4 for a share link, or null. */
function shareDir(cfg) {
  if (!cfg.share) return null;
  const clouds = P.cloudFolders();
  const base = clouds[cfg.share] || (/[\\/]/.test(cfg.share) ? expand(cfg.share) : null);
  return base ? path.join(base, "TeslaCam Exports") : null;
}

module.exports = { DEFAULTS, load, saveUser, file, shareDir, expand };
