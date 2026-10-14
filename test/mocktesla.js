// Mock dashcam.tesla.com over HTTPS. Mode set via POST /__mode {token,refuse,severOpener,noConnector,preItems}
const https = require("https"), fs = require("fs");
const keyMap = Object.fromEntries(JSON.parse(fs.readFileSync("/workspace/encfix/keys.json")).results.map((r) => [r.wrapped_key, r.key]));
let mode = {}; const log = [];
https.createServer({ key: fs.readFileSync(__dirname + "/k.pem"), cert: fs.readFileSync(__dirname + "/c.pem") }, (req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    if (req.url === "/__mode") { mode = JSON.parse(body); log.length = 0; return res.end("ok"); }
    if (req.url === "/__log") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify(log)); }
    if (req.url.startsWith("/api/1/decrypt/batch")) {
      const items = JSON.parse(body).items; log.push(items.length); res.setHeader("Content-Type", "application/json");
      if (mode.refuse) { res.statusCode = 403; return res.end('{"error":"forbidden"}'); }
      return res.end(JSON.stringify({ results: items.map((i) => ({ id: i.id, key: keyMap[i.wrapped_key] })) }));
    }
    const conn = fs.readFileSync("/workspace/dashcam-studio-v2/connector/Tesla-Grid-Player-Connector.user.js", "utf8");
    const pre = (mode.token ? `localStorage.setItem("access_token","eyJhbGciOiJ.eyJzdWIiOiJ4.sig_mock_token_value");` : `localStorage.clear();`)
      + (mode.wrapOpener ? `(function(){const r=window.opener;Object.defineProperty(window,"opener",{value:{postMessage:(...a)=>r.postMessage(...a),get closed(){return r.closed}}});})();` : "") + (mode.noDialogs ? `window.prompt=window.alert=window.confirm=()=>{throw new Error("native dialog used")};` : "") + (mode.severOpener ? `Object.defineProperty(window,"opener",{value:null});` : "") + (mode.preItems ? `sessionStorage.setItem("teslaGridPlayerConnector",${JSON.stringify(JSON.stringify(mode.preItems.job))});sessionStorage.setItem("teslaGridPlayerConnector.items",${JSON.stringify(JSON.stringify(mode.preItems.items))});` : "");
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body><h1>mock tesla</h1><script>${pre}</script>${mode.noConnector ? "" : `<script>${conn}</script>`}${mode.duplicate ? `<script>${conn}</script>` : ""}${mode.spaWipe ? `<script>setTimeout(()=>{document.body.innerHTML="<div id=root>re-rendered</div>"},1500)</script>` : ""}</body></html>`);
  });
}).listen(8443, "127.0.0.1");
