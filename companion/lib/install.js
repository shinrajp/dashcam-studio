/* install.js — start the companion at login.
 *  macOS:   ~/Library/LaunchAgents/com.tesladashcamstudio.companion.plist (launchctl bootstrap gui/<uid>)
 *  Windows: a hidden-window .vbs launcher in the Startup folder (no admin); --task-scheduler uses schtasks /SC ONLOGON
 *  Linux:   ~/.config/autostart/*.desktop */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const { spawnSync } = require("child_process");
const P = require("./platform");

const LABEL = "com.tesladashcamstudio.companion";
const SCRIPT = path.resolve(__dirname, "..", "dashcam-companion.js");
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

function plist(node, script, logFile) {
  const PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(script)}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${PATH}</string></dict>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
}
function vbs(node, script) {
  const q = (s) => '""' + s + '""';
  return `' Starts the Tesla Dashcam Studio companion at login (hidden window). Delete this file to stop it.\r\nCreateObject("WScript.Shell").Run "${q(node)} ${q(script)} run", 0, False\r\n`;
}
function desktop(node, script) {
  return `[Desktop Entry]\nType=Application\nName=Tesla Dashcam Studio companion\nExec="${node}" "${script}" run\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n`;
}

function targets() {
  const h = P.home();
  if (P.IS_MAC) return { kind: "launchagent", file: path.join(h, "Library", "LaunchAgents", LABEL + ".plist") };
  if (P.IS_WIN) return { kind: "startup", file: path.join(process.env.APPDATA || path.join(h, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Tesla Dashcam Studio companion.vbs") };
  return { kind: "autostart", file: path.join(process.env.XDG_CONFIG_HOME || path.join(h, ".config"), "autostart", "tesla-dashcam-studio-companion.desktop") };
}

/** Homebrew's process.execPath is a versioned Cellar path that `brew upgrade` deletes; use the stable symlink to the same binary. */
function stableNode(exec) {
  if (!/[\\/]Cellar[\\/]/.test(exec)) return exec;
  let real; try { real = fs.realpathSync(exec); } catch (_) { return exec; }
  for (const c of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) { try { if (fs.realpathSync(c) === real) return c; } catch (_) {} }
  return exec;
}

/** Returns a list of {file, content} (dry run) or performs the install. */
function install(opts) {
  opts = opts || {};
  const node = stableNode(process.execPath), logFile = path.join(P.configDir(), "companion.log");
  const plat = opts.platform || process.platform;
  const t = opts.platform ? { darwin: { kind: "launchagent", file: `~/Library/LaunchAgents/${LABEL}.plist` }, win32: { kind: "startup", file: "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Tesla Dashcam Studio companion.vbs" }, linux: { kind: "autostart", file: "~/.config/autostart/tesla-dashcam-studio-companion.desktop" } }[plat] : targets();
  const content = plat === "darwin" ? plist(node, SCRIPT, logFile) : plat === "win32" ? vbs(node, SCRIPT) : desktop(node, SCRIPT);
  if (opts.dryRun) return [{ file: t.file, content }];
  fs.mkdirSync(path.dirname(t.file), { recursive: true });
  fs.writeFileSync(t.file, content);
  const steps = [`wrote ${t.file}`];
  if (plat === "darwin") {
    const uid = process.getuid();
    spawnSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`]);
    let r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, t.file], { encoding: "utf8" });
    if (r.status !== 0) r = spawnSync("launchctl", ["load", "-w", t.file], { encoding: "utf8" });
    steps.push(r.status === 0 ? "started with launchctl (runs at every login)" : "launchctl failed: " + (r.stderr || "").trim());
  } else if (plat === "win32") {
    if (opts.taskScheduler) {
      const r = spawnSync("schtasks", ["/Create", "/F", "/SC", "ONLOGON", "/RL", "LIMITED", "/TN", "Tesla Dashcam Studio companion", "/TR", `"${node}" "${SCRIPT}" run`], { encoding: "utf8", windowsHide: true });
      steps.push(r.status === 0 ? "Task Scheduler entry created" : "schtasks failed (needs admin?) — the Startup-folder launcher still works: " + (r.stderr || "").trim());
    }
    spawnSync("wscript.exe", [t.file], { detached: true, stdio: "ignore", windowsHide: true });
    steps.push("started now (and at every login via the Startup folder)");
  } else steps.push("will start at next login (XDG autostart); run `node dashcam-companion.js run` to start now");
  return steps;
}

function uninstall() {
  const t = targets(), steps = [];
  if (P.IS_MAC) { spawnSync("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`]); steps.push("stopped launch agent"); }
  if (P.IS_WIN) spawnSync("schtasks", ["/Delete", "/F", "/TN", "Tesla Dashcam Studio companion"], { windowsHide: true });
  try { fs.unlinkSync(t.file); steps.push("removed " + t.file); } catch (_) { steps.push("nothing to remove at " + t.file); }
  return steps;
}

module.exports = { install, uninstall, plist, vbs, LABEL, targets, stableNode };
