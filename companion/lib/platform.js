/* platform.js — OS-specific locations: config dir, default export folder, cloud folders, browsers, fonts, volumes. */
"use strict";
const os = require("os"), path = require("path"), fs = require("fs");

const IS_MAC = process.platform === "darwin", IS_WIN = process.platform === "win32";
const home = () => os.homedir();
const exists = (p) => { try { fs.accessSync(p); return true; } catch (_) { return false; } };

function configDir() {
  if (process.env.TDC_HOME) return path.resolve(process.env.TDC_HOME);
  if (IS_MAC) return path.join(home(), "Library", "Application Support", "Tesla Dashcam Studio");
  if (IS_WIN) return path.join(process.env.APPDATA || path.join(home(), "AppData", "Roaming"), "Tesla Dashcam Studio");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home(), ".config"), "tesla-dashcam-studio");
}

function defaultOutputDir() {
  if (IS_MAC) return path.join(home(), "Movies", "TeslaCam Exports");
  return path.join(home(), "Videos", "TeslaCam Exports"); // Windows: %USERPROFILE%\Videos\TeslaCam Exports
}

/** Synced folders of the common cloud apps. The cloud app creates the share link; we only drop the file there. */
function cloudFolders() {
  const h = home(), out = {};
  const cs = path.join(h, "Library", "CloudStorage");
  const csList = exists(cs) ? fs.readdirSync(cs) : [];
  // iCloud Drive
  const icloud = IS_MAC ? path.join(h, "Library", "Mobile Documents", "com~apple~CloudDocs") : path.join(h, "iCloudDrive");
  if (exists(icloud)) out.icloud = icloud;
  // OneDrive
  const od = [process.env.OneDrive, process.env.OneDriveConsumer, ...csList.filter((n) => /^OneDrive/i.test(n)).map((n) => path.join(cs, n)), path.join(h, "OneDrive")].filter(Boolean);
  for (const p of od) if (exists(p)) { out.onedrive = p; break; }
  // Dropbox
  const db = [...csList.filter((n) => /^Dropbox/i.test(n)).map((n) => path.join(cs, n)), path.join(h, "Dropbox")];
  for (const p of db) if (exists(p)) { out.dropbox = p; break; }
  return out;
}

/** Candidate roots that may hold a TeslaCam folder (the drive root). `override` simulates /Volumes for tests. */
function volumeRoots(override) {
  const list = [];
  const scan = (dir) => { try { for (const n of fs.readdirSync(dir)) if (!n.startsWith(".")) list.push(path.join(dir, n)); } catch (_) {} };
  if (override) { scan(override); return list; }
  if (IS_MAC) scan("/Volumes");
  else if (IS_WIN) { for (let c = 68; c <= 90; c++) list.push(String.fromCharCode(c) + ":\\"); } // D: … Z:
  else {
    const u = os.userInfo().username;
    scan(path.join("/media", u)); scan(path.join("/run/media", u)); scan("/mnt");
  }
  return list;
}

/** True when p is a mounted drive's root (only then is the whole volume treated as read-only, not a user folder such as ~/Movies). */
function isDriveRoot(p, override) {
  const r = path.resolve(p);
  if (path.parse(r).root === r) return true;
  return volumeRoots(override).some((v) => path.resolve(v) === r);
}

function findBrowser(override) {
  if (override) return exists(override) ? override : null;
  const c = [];
  if (IS_MAC) {
    for (const base of ["/Applications", path.join(home(), "Applications")]) c.push(
      path.join(base, "Google Chrome.app/Contents/MacOS/Google Chrome"),
      path.join(base, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
      path.join(base, "Chromium.app/Contents/MacOS/Chromium"),
      path.join(base, "Brave Browser.app/Contents/MacOS/Brave Browser"));
  } else if (IS_WIN) {
    const pf = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean);
    for (const b of pf) c.push(path.join(b, "Google/Chrome/Application/chrome.exe"));
    for (const b of pf) c.push(path.join(b, "Microsoft/Edge/Application/msedge.exe"));
  } else {
    for (const d of (process.env.PATH || "").split(path.delimiter))
      for (const n of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) c.push(path.join(d, n));
  }
  return c.find(exists) || null;
}

function fontFile() {
  const c = IS_MAC ? ["/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc"]
    : IS_WIN ? ["C:\\Windows\\Fonts\\arial.ttf", "C:\\Windows\\Fonts\\segoeui.ttf"]
    : ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf"];
  return c.find(exists) || null;
}

module.exports = { IS_MAC, IS_WIN, home, exists, configDir, defaultOutputDir, cloudFolders, volumeRoots, isDriveRoot, findBrowser, fontFile };
