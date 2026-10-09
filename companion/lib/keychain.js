/* keychain.js — store the Tesla access token in the OS credential store, never in a plain file.
 *  macOS:   login keychain via /usr/bin/security (secret passed on stdin, not argv)
 *  Windows: Credential Locker (Windows.Security.Credentials.PasswordVault) via Windows PowerShell 5.1 (token on stdin)
 *  Linux:   libsecret's `secret-tool` if installed
 *  Fallback: memory only for the current run (you'll be asked to sign in again after a restart).
 *  TDC_INSECURE_TEST_KEYCHAIN=<file> exists ONLY for automated tests and stores the token in plain text. */
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const SERVICE = process.env.TDC_KEYCHAIN_SERVICE || "Tesla Dashcam Studio", ACCOUNT = "tesla-access-token", CHUNKS = "tdc-chunks:"; // service override: self-tests only
let memory = null;

function run(cmd, args, input) {
  const r = spawnSync(cmd, args, { input: input || "", encoding: "utf8", windowsHide: true, timeout: 20000 });
  return { ok: r.status === 0 && !r.error, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() || (r.error && r.error.message) };
}
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const PS_VAULT = "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];$v=New-Object Windows.Security.Credentials.PasswordVault;";

function backend() {
  if (process.env.TDC_INSECURE_TEST_KEYCHAIN) return "test-file";
  if (process.platform === "darwin") return "macos-keychain";
  if (process.platform === "win32") return "windows-credential-locker";
  if (run("sh", ["-c", "command -v secret-tool"]).ok) return "libsecret";
  return "memory";
}

function set(token) {
  const b = backend();
  if (b === "test-file") { fs.writeFileSync(process.env.TDC_INSECURE_TEST_KEYCHAIN, token, { mode: 0o600 }); return b; }
  if (b === "macos-keychain") {
    // `security -i` reads commands from stdin, so the token never shows up in the process list.
    // `security -i` truncates input lines at ~4 KB, so long tokens are stored in ≤3000-char parts.
    const q = (s) => '"' + String(s).replace(/(["\\])/g, "\\$1") + '"';
    const parts = token.length <= 3000 ? [token] : token.match(/[\s\S]{1,3000}/g);
    const lines = parts.length === 1 ? [[ACCOUNT, token]] : [[ACCOUNT, CHUNKS + parts.length], ...parts.map((p, i) => [ACCOUNT + "#" + (i + 1), p])];
    const r = run("/usr/bin/security", ["-i"], lines.map(([a, w]) => `add-generic-password -U -s ${q(SERVICE)} -a ${q(a)} -w ${q(w)}\n`).join(""));
    if (!r.ok || r.err || get() !== token) throw new Error("Keychain write failed: " + (r.err || "read-back mismatch"));
    return b;
  }
  if (b === "windows-credential-locker") {
    const r = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$t=[Console]::In.ReadToEnd().Trim();${PS_VAULT}try{$o=$v.Retrieve(${psq(SERVICE)},${psq(ACCOUNT)});$v.Remove($o)}catch{};$v.Add((New-Object Windows.Security.Credentials.PasswordCredential(${psq(SERVICE)},${psq(ACCOUNT)},$t)))`], token);
    if (!r.ok) throw new Error("Credential Locker write failed: " + r.err);
    return b;
  }
  if (b === "libsecret") {
    const r = run("secret-tool", ["store", "--label=" + SERVICE, "service", SERVICE, "account", ACCOUNT], token);
    if (!r.ok) throw new Error("secret-tool failed: " + r.err);
    return b;
  }
  memory = token; return b;
}

function get() {
  const b = backend();
  if (b === "test-file") { try { return fs.readFileSync(process.env.TDC_INSECURE_TEST_KEYCHAIN, "utf8").trim() || null; } catch (_) { return null; } }
  if (b === "macos-keychain") {
    const rd = (a) => { const r = run("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", a, "-w"]); return r.ok && r.out ? r.out : null; };
    const v = rd(ACCOUNT);
    if (!v || !v.startsWith(CHUNKS)) return v;
    const n = +v.slice(CHUNKS.length), parts = [];
    for (let i = 1; i <= n; i++) { const p = rd(ACCOUNT + "#" + i); if (!p) return null; parts.push(p); }
    return parts.join("");
  }
  if (b === "windows-credential-locker") {
    const r = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${PS_VAULT}try{$o=$v.Retrieve(${psq(SERVICE)},${psq(ACCOUNT)});$o.RetrievePassword();[Console]::Out.Write($o.Password)}catch{exit 1}`]);
    return r.ok && r.out ? r.out : null;
  }
  if (b === "libsecret") { const r = run("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT]); return r.ok && r.out ? r.out : null; }
  return memory;
}

function remove() {
  const b = backend();
  if (b === "test-file") { try { fs.unlinkSync(process.env.TDC_INSECURE_TEST_KEYCHAIN); } catch (_) {} }
  else if (b === "macos-keychain") for (const a of [ACCOUNT, ...Array.from({ length: 16 }, (_, i) => ACCOUNT + "#" + (i + 1))]) run("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", a]);
  else if (b === "windows-credential-locker") run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${PS_VAULT}try{$v.Remove($v.Retrieve(${psq(SERVICE)},${psq(ACCOUNT)}))}catch{}`]);
  else if (b === "libsecret") run("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT]);
  memory = null;
}

module.exports = { set, get, remove, backend, SERVICE, ACCOUNT };
