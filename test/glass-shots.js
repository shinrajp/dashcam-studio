// README screenshots of the Liquid Glass UI, mock data only.
//   Footage: the photo mock-up clips from tools/make-photo-footage.py (AI-generated stills in tools/mock-stills; no real drive, no real plates):
//     python3 tools/make-photo-footage.py tools/mock-stills /tmp/photo-mock
//   Run: FIX=/tmp/photo-mock PORT=8831 node test/glass-shots.js   (SHOTS=dir, default screenshots/; Chromium, CHROME=path optional)
//   Writes liquid-glass-desktop, -bubble, -tray, -settings, -lite (1440x900, mouse) and liquid-glass-phone, -phone-settings (430x932, touch).
//   Tiles are off (no map requests), object detection is off, nothing is saved outside the test browser profile.
const fs = require("fs"), path = require("path"), http = require("http");
const ROOT = path.join(__dirname, ".."), FIX = process.env.FIX || "/tmp/photo-mock", PORT = +(process.env.PORT || 8831), OUT = process.env.SHOTS || path.join(ROOT, "screenshots");
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".onnx": "application/octet-stream", ".wasm": "application/wasm" };
const server = () => new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html";
  fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; r.end(); return; } r.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream"); r.end(d); }); }); s.listen(PORT, "127.0.0.1", () => res(s)); });
(async () => {
  const { chromium } = require("playwright"); fs.mkdirSync(OUT, { recursive: true });
  const srv = await server(), b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  for (const dev of [{ w: 1440, h: 900 }, { w: 430, h: 932, touch: true }]) {
    const c = await b.newContext({ viewport: { width: dev.w, height: dev.h }, deviceScaleFactor: dev.touch ? 2 : 1, ...(dev.touch ? { hasTouch: true, isMobile: true } : {}) }), p = await c.newPage();
    const shot = async (n) => { await W(500); await p.screenshot({ path: path.join(OUT, "liquid-glass-" + n + ".png") }); console.log("wrote liquid-glass-" + n + ".png"); };
    await p.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1`, { waitUntil: "load" });
    await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.setItem("tdc.prefs.v1", JSON.stringify({ advanced: true, autohide: "never", mapTiles: false })); });
    await p.reload({ waitUntil: "load" });
    await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
    for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
    await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
    await p.evaluate(() => TDC.ui.activate(TDC.library.events.find((e) => e.cams.length === 6) || TDC.library.events[0])); await W(2000);
    await p.evaluate(() => { TDC.player.seek(9); TDC.player.pause(); if (TDC.focus && TDC.focus.dismissHint) TDC.focus.dismissHint(); document.querySelectorAll(".toast").forEach((t) => t.remove()); }); await W(1200);
    await p.evaluate(() => { for (let i = 0; i < 40; i++) TDC.glass.tick && TDC.glass.tick(); });
    if (!dev.touch) {
      await shot("desktop");
      await p.click("#tbMain"); await W(500); await shot("bubble"); await p.keyboard.press("Escape"); await W(400);
      await p.evaluate(() => { TDC.focus.focus("front"); }); await W(600); await p.evaluate(() => TDC.regions.UI.draw()); await W(800); await shot("tray");
      await p.evaluate(() => { const c = document.getElementById("crBarCancel"); if (c) c.click(); TDC.focus.focus(null); }); await W(600);
      await p.evaluate(() => { document.getElementById("settings").hidden = false; TDC.settings.show("home"); }); await shot("settings");
      await p.evaluate(() => { document.getElementById("settings").hidden = true; TDC.setPref("lite", "on"); }); await shot("lite");
    } else {
      await shot("phone");
      await p.evaluate(() => { document.getElementById("settings").hidden = false; TDC.settings.show("appearance"); }); await shot("phone-settings");
    }
    await c.close();
  }
  await b.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
