/* server.js — local-only HTTP server (127.0.0.1) used by the headless renderer and the sign-in page.
 * Security: binds to 127.0.0.1 only; rejects foreign Host headers (DNS rebinding); every API call and file needs the
 * per-process random token (GET ?token=…, POST X-TDC-Token header → cross-site pages can't send it without a CORS
 * preflight, which is never granted). Only the web app's own folders and files listed in the current job are served. */
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const RO = require("./readonly");
const { log } = require("./notify");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".mp4": "video/mp4", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webm": "video/webm" };
const APP_TOP = new Set(["index.html", "css", "js", "vendor"]);

class Server {
  constructor(opts) {
    this.appDir = opts.appDir; this.outDir = opts.outDir; this.port = opts.port || 0;
    this.token = crypto.randomBytes(18).toString("hex");
    this.job = null; this.signin = null; this.libraryHtml = opts.libraryHtml || (() => "<p>No library yet.</p>");
  }
  url(p) { return `http://127.0.0.1:${this.port}${p}`; }
  start() {
    return new Promise((resolve, reject) => {
      this.srv = http.createServer((q, r) => this.handle(q, r).catch((e) => { log("server error", e.message); try { r.writeHead(500); r.end(String(e.message)); } catch (_) {} }));
      this.srv.on("error", (e) => {
        if (e.code === "EADDRINUSE" && this.port) { log(`port ${this.port} busy, using a random port`); this.port = 0; this.srv.listen(0, "127.0.0.1"); } else reject(e);
      });
      this.srv.listen(this.port, "127.0.0.1", () => { this.port = this.srv.address().port; resolve(this); });
    });
  }
  stop() { if (this.srv) this.srv.close(); }

  async handle(q, r) {
    const u = new URL(q.url, "http://127.0.0.1");
    const host = String(q.headers.host || "");
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) { r.writeHead(421); return r.end("bad host"); }
    r.setHeader("X-Content-Type-Options", "nosniff");
    r.setHeader("Referrer-Policy", "no-referrer");
    r.setHeader("X-Frame-Options", "DENY");
    const p = u.pathname;
    const authed = q.method === "GET" ? u.searchParams.get("token") === this.token : q.headers["x-tdc-token"] === this.token;

    if (p === "/favicon.ico") { r.writeHead(204); return r.end(); }
    if (q.method === "GET" && (p === "/" || p === "/library")) return this.send(r, 200, this.libraryHtml(this), TYPES[".html"]);
    if (q.method === "GET" && p === "/signin") { r.writeHead(302, { Location: `/app/index.html?companion=1&signin=1&token=${this.token}` }); return r.end(); }
    if (q.method === "GET" && p.startsWith("/app/")) return this.serveApp(r, decodeURIComponent(p.slice(5)));
    if (!authed) { r.writeHead(403); return r.end("forbidden"); }
    if (q.method === "GET" && p.startsWith("/out/")) return this.serveFile(r, path.join(this.outDir, path.basename(decodeURIComponent(p.slice(5)))), q);
    if (q.method === "GET" && p.startsWith("/thumbs/")) return this.serveFile(r, path.join(this.outDir, ".thumbs", path.basename(decodeURIComponent(p.slice(8)))), q);

    if (q.method === "GET" && p.startsWith("/f/")) {
      const [, jobId, idx] = p.split("/").filter(Boolean);
      const f = this.job && this.job.id === jobId && this.job.fileList[+idx];
      if (!f) { r.writeHead(404); return r.end(); }
      return this.serveFile(r, f, q);
    }
    if (q.method === "GET" && p === "/api/job") return this.json(r, this.job ? this.job.public : { events: [] });
    if (q.method === "GET" && p === "/api/signin-job") return this.json(r, { items: (this.signin && this.signin.items) || [] });
    if (q.method !== "POST") { r.writeHead(404); return r.end(); }

    if (p === "/api/result") {
      if (!this.job) { r.writeHead(409); return r.end(); }
      const name = path.basename(u.searchParams.get("name") || "");
      if (!/^[\w.\-]+\.(mp4|webm)$/.test(name)) { r.writeHead(400); return r.end("bad name"); }
      const dest = RO.assertNotOnDrive(path.join(this.job.outDir, name));
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await new Promise((res, rej) => { const w = fs.createWriteStream(dest + ".part"); q.pipe(w); w.on("finish", res); w.on("error", rej); q.on("error", rej); });
      await fs.promises.rename(dest + ".part", dest);
      let info = {}; try { info = JSON.parse(u.searchParams.get("info") || "{}"); } catch (_) {}
      this.job.onResult({ event: u.searchParams.get("event"), preset: u.searchParams.get("preset"), file: dest, name, ...info });
      return this.json(r, { ok: true });
    }
    const body = await readJson(q);
    if (p === "/api/progress") { if (this.job) this.job.onProgress(body); return this.json(r, { ok: true }); }
    if (p === "/api/done") { if (this.job) this.job.onDone(body); return this.json(r, { ok: true }); }
    if (p === "/api/token") { if (this.signin && typeof body.token === "string" && body.token.length > 20) this.signin.onToken(body.token); return this.json(r, { ok: true }); }
    if (p === "/api/keys") { if (this.signin && Array.isArray(body.results)) this.signin.onKeys(body.results); return this.json(r, { ok: true }); }
    r.writeHead(404); r.end();
  }

  serveApp(r, rel) {
    const parts = rel.split("/").filter((s) => s && s !== "." && s !== "..");
    if (!parts.length || !APP_TOP.has(parts[0])) { r.writeHead(404); return r.end(); }
    return this.serveFile(r, path.join(this.appDir, ...parts));
  }
  serveFile(r, file, q) {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { r.writeHead(404); return r.end(); }
      const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
      const range = q && /^bytes=(\d+)-(\d*)$/.exec(q.headers.range || "");
      if (range) {
        const a = +range[1], b = range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
        r.writeHead(206, { "Content-Type": type, "Content-Length": b - a + 1, "Content-Range": `bytes ${a}-${b}/${st.size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
        return fs.createReadStream(file, { flags: "r", start: a, end: b }).pipe(r);
      }
      r.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
      fs.createReadStream(file, { flags: "r" }).pipe(r);
    });
  }
  send(r, code, body, type) { r.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" }); r.end(body); }
  json(r, o) { this.send(r, 200, JSON.stringify(o), TYPES[".json"]); }
}

function readJson(q) {
  return new Promise((res) => {
    let s = "", n = 0;
    q.on("data", (d) => { n += d.length; if (n < 4 << 20) s += d; });
    q.on("end", () => { try { res(JSON.parse(s || "{}")); } catch (_) { res({}); } });
    q.on("error", () => res({}));
  });
}

module.exports = { Server };
