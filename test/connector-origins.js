// Connector 1.4.4 player-origin check: home-network origins are trusted, lookalikes are not.
// Run: node test/connector-origins.js
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "connector", "Tesla-Grid-Player-Connector.user.js"), "utf8");
const m = /\/\/ <origin-check>[\s\S]*?\n([\s\S]*?)\/\/ <\/origin-check>/.exec(src);
if (!m) { console.error("FAIL origin-check block not found"); process.exit(1); }
const isPrivateOrigin = new Function(m[1] + "\nreturn isPrivateOrigin;")();
const allow = (src.match(/const ALLOWED_PLAYER_ORIGINS = [^\n]*/) || [""])[0];
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };
const yes = ["http://192.168.68.89:8771", "http://192.168.0.1", "https://192.168.255.254:8443", "http://10.0.0.5:8080", "http://10.255.255.255",
  "http://172.16.0.1:3000", "http://172.31.255.1", "http://localhost:8770", "http://127.0.0.1:9999", "http://[::1]:8770", "http://my-nas.local:8080", "https://mac-mini.home.local"];
const no = ["http://192.168.1.1.evil.com", "http://evil.com", "http://192.169.1.1", "http://172.15.0.1", "http://172.32.0.1", "http://11.0.0.1", "http://8.8.8.8",
  "http://256.168.1.1", "http://192.168.1", "http://0xc0.168.1.1", "http://3232235777", "http://192.168.1.1/", "http://192.168.1.1/x", "http://user@192.168.1.1",
  "ftp://192.168.1.1", "file://192.168.1.1", "null", "", "*", null, undefined, 42, "http://local", "http://evil.local.com", "http://192.168.1.1:8080.evil.com",
  "http://192.168.1.1%2e.evil.com", "http://evil.com#192.168.1.1", "http://192.168.1.1@evil.com", "HTTP://192.168.1.1", "javascript:alert(1)"];
for (const o of yes) ok("trusts " + o, isPrivateOrigin(o) === true);
for (const o of no) ok("rejects " + JSON.stringify(o), isPrivateOrigin(o) === false);
ok("explicit allowlist kept (github.io)", /shinrajp\\\.github\\\.io/.test(allow));
ok("originAllowed = allowlist OR private", /ALLOWED_PLAYER_ORIGINS\.some\(\(re\) => re\.test\(o\)\) \|\| isPrivateOrigin\(o\)/.test(src));
ok("nonce check kept", /gridplayer=\(\[0-9a-f\]\{16,64\}\)/.test(src));
ok("token still only to localhost players", /if \(LOCAL_PLAYER_ORIGINS\.some\(\(re\) => re\.test\(playerOrigin\)\)\) post\(\{ type: TOKEN/.test(src));
const vers = [...src.matchAll(/(?:@version\s+|MY_VERSION = "|const VERSION = ")(\d+\.\d+\.\d+)/g)].map((x) => x[1]);
ok("version 1.4.4 everywhere in script", vers.length === 3 && vers.every((v) => v === "1.4.4"));
const emb = fs.readFileSync(path.join(__dirname, "..", "js", "connector-src.js"), "utf8");
ok("embedded copy matches (run tools/embed-connector.js)", emb.includes(JSON.stringify(src)));
console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
