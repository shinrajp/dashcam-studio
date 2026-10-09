/* notify.js — desktop notifications (best effort; always logged too). */
"use strict";
const { spawn } = require("child_process");
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a); // local time
let enabled = true;
function notify(title, body) {
  log("🔔", title, "—", body);
  if (!enabled || process.env.TDC_NO_NOTIFY) return;
  try {
    if (process.platform === "darwin") {
      const q = (s) => '"' + String(s).replace(/(["\\])/g, "\\$1") + '"';
      spawn("/usr/bin/osascript", ["-e", `display notification ${q(body)} with title ${q(title)} sound name "Glass"`], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "win32") {
      const x = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
      const xml = `<toast><visual><binding template="ToastGeneric"><text>${x(title)}</text><text>${x(body)}</text></binding></visual></toast>`;
      const ps = "$xml=[Console]::In.ReadToEnd();" +
        "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]>$null;" +
        "[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]>$null;" +
        "$x=New-Object Windows.Data.Xml.Dom.XmlDocument;$x.LoadXml($xml);" +
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show((New-Object Windows.UI.Notifications.ToastNotification $x))";
      const ch = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      ch.on("error", () => {}); ch.stdin.end(xml);
    } else {
      spawn("notify-send", ["-a", "Tesla Dashcam Studio", title, body], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    }
  } catch (_) {}
}
module.exports = { notify, log, setEnabled: (v) => { enabled = !!v; } };
