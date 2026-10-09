/* render-browser.js — renders an event with the web app itself, in the user's installed Chrome/Edge running headless.
 * Why: the export then matches the in-app preview exactly (same compositor, graphical HUD, map, badge) and uses
 * WebCodecs with hardware encoders (VideoToolbox on Apple Silicon; Media Foundation → NVENC/QSV/AMF on Windows).
 * No puppeteer/CDP needed: the page drives itself in ?companion=1 mode and talks to our local server. */
"use strict";
const { spawn } = require("child_process");
const path = require("path"), fs = require("fs"), crypto = require("crypto");
const { log } = require("./notify");

function chromeArgs(profileDir, url) {
  const a = ["--headless=new", `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--autoplay-policy=no-user-gesture-required", "--mute-audio", "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--window-size=1600,900", "--hide-scrollbars"];
  if (process.platform === "linux" && (process.getuid && process.getuid() === 0 || process.env.TDC_CHROME_NO_SANDBOX)) a.push("--no-sandbox");
  a.push(url);
  return a;
}

/**
 * Render one or more job events (already decrypted / plain) in one browser session.
 * jobEvents: [{ id, files:[{abs, path, name}], presets:["compat","original"] }]
 * Resolves → { results:[{event,preset,file,W,H,codec,hw,...}], errors:[{event,preset,error}] }
 */
function render(server, cfg, browserPath, jobEvents, outDir, onProgress) {
  return new Promise((resolve) => {
    const id = crypto.randomBytes(6).toString("hex");
    const fileList = [];
    const pub = {
      id, codec: cfg.originalCodec || "h264", sizeId: "native", show: cfg.overlays, prefs: cfg.prefs || {},
      events: jobEvents.map((ev) => ({
        id: ev.id, presets: ev.presets,
        files: ev.files.map((f) => { fileList.push(f.abs); return { url: `/f/${id}/${fileList.length - 1}?token=${server.token}`, name: f.name, path: f.path }; }),
      })),
    };
    const results = [], errors = [];
    let finished = false, child = null, lastActivity = Date.now();
    const finish = (why) => {
      if (finished) return; finished = true;
      clearInterval(watchdog);
      server.job = null;
      if (child && child.exitCode === null) { try { child.kill(); } catch (_) {} }
      if (why) errors.push({ event: null, error: why });
      resolve({ results, errors });
    };
    server.job = {
      id, public: pub, fileList, outDir,
      onProgress: (p) => { lastActivity = Date.now(); if (p.state === "error" || p.state === "fatal") errors.push({ event: p.event, preset: p.preset, error: p.error }); if (onProgress) onProgress(p); },
      onResult: (r) => { lastActivity = Date.now(); results.push(r); log(`  ✓ ${r.name} (${r.W}×${r.H} ${r.codec}, ${r.hw ? "hardware" : "software"} encoder per the browser)`); if (r.note) log(`    note: ${r.note}`); },
      onDone: () => finish(null),
    };
    const profile = path.join(require("./platform").configDir(), "render-profile");
    fs.mkdirSync(profile, { recursive: true });
    const url = server.url(`/app/index.html?companion=1&token=${server.token}`);
    child = spawn(browserPath, chromeArgs(profile, url), { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let errTail = "";
    child.stderr.on("data", (d) => { errTail = (errTail + d).slice(-2000); });
    child.on("error", (e) => finish("Browser failed to start: " + e.message));
    child.on("exit", (code) => { if (!finished) finish(`Browser exited (code ${code}) before finishing. ${errTail.split("\n").slice(-3).join(" ")}`); });
    const IDLE = (+process.env.TDC_RENDER_IDLE_SECONDS || 240) * 1000;
    const watchdog = setInterval(() => { if (Date.now() - lastActivity > IDLE) finish("Renderer stalled (no progress for " + IDLE / 1000 + " s)"); }, 5000);
  });
}

module.exports = { render, chromeArgs };
