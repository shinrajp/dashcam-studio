// Companion /api/cloud relay (optional proxy for the cloud boost): token required, allowlisted provider URLs only,
// only auth/content headers forwarded, upstream answer passed back. Upstream fetch is mocked — no network, no real keys.
// Usage: node test/companion-cloud.test.js
const http = require("http"), os = require("os");
const { Server } = require("../companion/lib/server.js");
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x) : "")); if (!c) fails++; };
const seen = []; const realFetch = global.fetch;
global.fetch = async (url, o) => { seen.push({ url, headers: o.headers, body: o.body }); return { status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"objects":[]}' } }] }) }; };
(async () => {
  const s = await new Server({ appDir: __dirname + "/..", outDir: os.tmpdir() }).start();
  const post = (path, body, headers) => new Promise((res) => { const d = JSON.stringify(body); const q = http.request({ host: "127.0.0.1", port: s.port, path, method: "POST", headers: { "Content-Type": "application/json", ...headers } }, (r) => { let t = ""; r.on("data", (c) => (t += c)); r.on("end", () => res({ status: r.statusCode, text: t })); }); q.end(d); });
  const tok = { "X-TDC-Token": s.token };
  const good = { url: "https://api.x.ai/v1/chat/completions", headers: { Authorization: "Bearer xai-TEST", Cookie: "nope", "X-Evil": "1" }, body: { model: "m" } };
  ok("no token → 403", (await post("/api/cloud", good)).status === 403);
  let r = await post("/api/cloud", good, tok);
  ok("x.ai chat/completions relayed", r.status === 200 && seen.length === 1 && seen[0].url === good.url, r);
  ok("only auth/content headers forwarded", seen[0].headers.authorization === "Bearer xai-TEST" && !seen[0].headers.cookie && !seen[0].headers["x-evil"], seen[0].headers);
  for (const u of ["https://evil.example/v1/messages", "http://api.anthropic.com/v1/messages", "https://api.anthropic.com/v1/files", "https://api.x.ai:8443/v1/chat/completions", "https://user:pw@api.x.ai/v1/chat/completions", "file:///etc/passwd", "https://generativelanguage.googleapis.com/v1beta/models/x:streamGenerateContent"]) {
    const n = seen.length; r = await post("/api/cloud", { ...good, url: u }, tok);
    ok("refused: " + u, r.status === 400 && seen.length === n);
  }
  r = await post("/api/cloud", { url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent", headers: { "x-goog-api-key": "AIzaTEST" }, body: { contents: [] } }, tok);
  ok("Gemini generateContent relayed with x-goog-api-key", r.status === 200 && seen[seen.length - 1].headers["x-goog-api-key"] === "AIzaTEST");
  r = await post("/api/cloud", { url: "https://api.anthropic.com/v1/messages", headers: { "x-api-key": "sk-ant-TEST", "anthropic-version": "2023-06-01" }, body: { model: "m" } }, tok);
  ok("Anthropic messages relayed", r.status === 200 && seen[seen.length - 1].headers["x-api-key"] === "sk-ant-TEST");
  global.fetch = async () => { throw new Error("offline"); };
  r = await post("/api/cloud", good, tok);
  ok("upstream failure → 502 with a readable message", r.status === 502 && /could not reach api\.x\.ai/.test(r.text), r);
  s.stop(); global.fetch = realFetch;
  console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})();
