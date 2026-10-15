// Static server that sends WRONG MIME types (.js/.mjs as text/plain, .wasm as octet-stream), like some Windows
// python http.server setups and NAS web servers. Used to reproduce "Detection worker failed: script error".
// node test/serve-badmime.js <root> <port> [host]   (inline <script> tags still work: Chrome only blocks workers/modules)
const http = require("http"), fs = require("fs"), path = require("path");
const root = path.resolve(process.argv[2] || "."), port = +process.argv[3] || 8790, host = process.argv[4] || "0.0.0.0";
const T = { ".html": "text/html", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".js": "text/plain", ".mjs": "text/plain", ".wasm": "application/octet-stream" };
http.createServer((q, r) => {
  const f = path.join(root, decodeURIComponent(q.url.split("?")[0]).replace(/\/$/, "/index.html"));
  if (!f.startsWith(root)) { r.writeHead(403); return r.end(); }
  fs.stat(f, (e, st) => { if (e || !st.isFile()) { r.writeHead(404); return r.end("not found"); }
    r.writeHead(200, { "Content-Type": T[path.extname(f)] || "application/octet-stream", "Content-Length": st.size }); fs.createReadStream(f).pipe(r); });
}).listen(port, host, () => console.log("bad-MIME server on", host + ":" + port, "root", root));
