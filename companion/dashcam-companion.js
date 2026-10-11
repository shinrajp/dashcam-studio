#!/usr/bin/env node
/* Tesla Dashcam Studio — companion. Plug in the Tesla USB drive, walk away, come back to finished videos.
 * Run `node dashcam-companion.js help` for commands. Requires Node 18+ and ffmpeg/ffprobe on PATH;
 * Chrome or Edge (recommended) gives the full graphical HUD + map. */
"use strict";
const path = require("path"), fs = require("fs"), { spawn, spawnSync } = require("child_process");
const C = require("./lib/config"), P = require("./lib/platform"), RO = require("./lib/readonly"), I = require("./lib/indexer");
const LIB = require("./lib/library-page"), S = require("./lib/state"), K = require("./lib/keychain"), FF = require("./lib/render-ffmpeg");
const { Server } = require("./lib/server"), { Pipeline } = require("./lib/pipeline"), INST = require("./lib/install");
const { notify, log, setEnabled } = require("./lib/notify");

const APP_DIR = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith("--") ? argv.shift() : "run";
const flag = (n) => argv.includes("--" + n);
const opt = (n) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : null; };
const VALUED = new Set(["--out", "--renderer", "--volumes-root"]);
const positional = argv.filter((a, i) => !a.startsWith("--") && !VALUED.has(argv[i - 1]));

function cfgWithOverrides() {
  const cfg = C.load();
  if (opt("out")) cfg.outputDir = path.resolve(C.expand(opt("out")));
  if (opt("renderer")) cfg.renderer = opt("renderer");
  if (flag("original")) cfg.exportOriginal = true;
  if (flag("all")) cfg.sources = ["SavedClips", "SentryClips", "RecentClips", "Files"];
  setEnabled(cfg.notify);
  return cfg;
}

function openUrl(url) {
  if (process.env.TDC_NO_OPEN || flag("no-open")) { log("Open this URL:", url); return; }
  const c = P.IS_MAC ? ["open", [url]] : P.IS_WIN ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(c[0], c[1], { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => log("Open this URL:", url)).unref();
}

async function startServer(cfg) {
  const s = new Server({ appDir: APP_DIR, outDir: cfg.outputDir, port: cfg.port });
  const href = (srv) => (n) => (n.startsWith(".thumbs/") ? "/thumbs/" : "/out/") + encodeURIComponent(path.basename(n)) + "?token=" + srv.token;
  s.libraryHtml = (srv) => LIB.html(LIB.loadLib(), { href: href(srv), signinUrl: pipelineRef && pipelineRef.waitingKeys.size ? "/signin" : null });
  await s.start();
  return s;
}
let pipelineRef = null;

/** Watch removable drives (+ extra folders) and process each new TeslaCam folder once per mount. */
async function run() {
  const cfg = cfgWithOverrides();
  const server = await startServer(cfg);
  const pipe = (pipelineRef = new Pipeline(cfg, server, { all: flag("all"), retry: flag("retry"), volumesRoot: opt("volumes-root") }));
  pipe.onKeysReceived = () => queue.push({ waiting: true });
  log(`Tesla Dashcam Studio companion · exports → ${cfg.outputDir}`);
  log(`Renderer: ${cfg.renderer === "ffmpeg" || !pipe.browser ? "ffmpeg" : "headless " + path.basename(pipe.browser)}${pipe.browser ? "" : " (install Chrome or Edge for the graphical HUD + map)"} · decrypt: ${cfg.decrypt ? "on" : "off"}`);
  log(`Live library: http://127.0.0.1:${server.port}/`);
  LIB.write(cfg.outputDir);
  const volRoot = opt("volumes-root"), extra = [...cfg.extraFolders, ...positional].map((p) => path.resolve(C.expand(p)));
  const seen = new Map(); const queue = []; let busy = false;
  const tick = async () => {
    const found = new Map();
    for (const root of [...P.volumeRoots(volRoot), ...extra]) {
      const tc = await I.findTeslaCam(root);
      if (!tc) continue;
      let idn = tc; try { const st = fs.statSync(tc); idn = `${tc}|${st.dev}|${st.ino}|${st.birthtimeMs}`; } catch (_) {}
      found.set(idn, tc);
    }
    for (const [idn, tc] of found) if (!seen.has(idn)) { seen.set(idn, tc); log(`TeslaCam found: ${tc}`); queue.push({ tc }); }
    for (const idn of [...seen.keys()]) if (!found.has(idn)) { log(`Drive removed: ${seen.get(idn)}`); seen.delete(idn); }
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const j = queue.shift();
        try { if (j.waiting) await pipe.processWaiting(); else await pipe.processFolder(j.tc, path.basename(path.dirname(j.tc))); }
        catch (e) { log("Error:", e.message); notify("TeslaCam export error", e.message); }
      }
    } finally { busy = false; }
    if (flag("once") && !queue.length && !(cfg.decrypt && pipe.waitingKeys.size && flag("wait-signin"))) { server.stop(); process.exit(0); }
  };
  await tick();
  setInterval(tick, Math.max(2, cfg.pollSeconds) * 1000);
}

/** One-shot: index + export a specific TeslaCam folder (e.g. a copy on your disk). */
async function scanCmd() {
  const target = positional[0];
  if (!target) throw new Error("usage: scan <path to TeslaCam folder or drive>");
  const cfg = cfgWithOverrides();
  const root = path.resolve(C.expand(target));
  const tc = (await I.findTeslaCam(root)) || root;
  const server = await startServer(cfg);
  const pipe = (pipelineRef = new Pipeline(cfg, server, { all: flag("all"), retry: flag("retry") }));
  const res = await pipe.processFolder(tc, path.basename(root));
  if (pipe.waitingKeys.size && cfg.decrypt && flag("wait-signin")) {
    log(`${pipe.waitingKeys.size} encrypted event(s) need keys — opening the sign-in page…`);
    openUrl(server.url("/signin"));
    await new Promise((resolve) => { pipe.onKeysReceived = resolve; setTimeout(resolve, 15 * 60 * 1000); });
    await pipe.processWaiting();
  }
  server.stop();
  LIB.write(cfg.outputDir);
  log(`Library: ${path.join(cfg.outputDir, "index.html")}`);
  return res;
}

async function indexCmd() {
  const cfg = cfgWithOverrides();
  const root = path.resolve(C.expand(positional[0] || "."));
  const tc = (await I.findTeslaCam(root)) || root;
  RO.registerRoot(tc); if (P.isDriveRoot(path.dirname(tc))) RO.registerRoot(path.dirname(tc));
  const { events } = await I.scan(tc);
  LIB.upsert(events, { drive: path.basename(root) });
  LIB.write(cfg.outputDir);
  for (const e of events) console.log(`${new Date(e.time).toLocaleString()}  ${e.source.padEnd(11)} ${e.trigger.label.padEnd(34)} ${(e.location.city || (e.location.lat != null ? e.location.lat.toFixed(4) + "," + e.location.lon.toFixed(4) : "?")).padEnd(22)} ${e.cams.length} cams ${e.locked ? "🔒" : ""}`);
  log(`Wrote ${path.join(cfg.outputDir, "index.json")} and index.html`);
}

function doctor() {
  const cfg = C.load();
  const ok = (b) => (b ? "✓" : "✗");
  const ff = FF.capabilities();
  const br = P.findBrowser(cfg.browserPath);
  const nodeMajor = +process.versions.node.split(".")[0];
  console.log(`Node ${process.versions.node}  ${ok(nodeMajor >= 18)} (need 18+)`);
  console.log(`ffmpeg: ${ff.ok ? ff.version : "NOT FOUND"} ${ok(ff.ok)}${ff.ok ? `  libass ${ok(ff.ass)}  xstack ${ok(ff.xstack)}` : "  → macOS: brew install ffmpeg · Windows: winget install Gyan.FFmpeg"}`);
  if (ff.ok) console.log(`H.264 encoders that work here: ${FF.workingEncoders("h264").join(", ") || "none"}`);
  console.log(`Browser renderer: ${br || "not found (ffmpeg fallback: text overlays, no graphical HUD/map)"} ${ok(br)}`);
  console.log(`Token storage: ${K.backend()}`);
  console.log(`Config: ${C.file()}`);
  console.log(`Exports: ${cfg.outputDir}`);
  const clouds = P.cloudFolders();
  console.log(`Cloud folders: ${Object.entries(clouds).map(([k, v]) => k + " → " + v).join(" · ") || "none found"}${cfg.share ? `  (sharing to ${C.shareDir(cfg) || "?? not found"})` : ""}`);
  console.log(`Sources rendered: ${cfg.sources.join(", ")} · auto-decrypt ${cfg.decrypt ? "on" : "off"} · native-resolution export ${cfg.exportOriginal ? "on" : "off"}`);
}

function configCmd() {
  const [k, ...rest] = positional;
  if (!k) { console.log(JSON.stringify(C.load(), null, 2)); return; }
  if (!rest.length) { console.log(JSON.stringify(C.load()[k], null, 2)); return; }
  let v = rest.join(" ");
  try { v = JSON.parse(v); } catch (_) {}
  if (!(k in C.DEFAULTS)) throw new Error(`unknown key "${k}". Keys: ${Object.keys(C.DEFAULTS).join(", ")}`);
  C.saveUser({ [k]: v });
  console.log(`${k} = ${JSON.stringify(v)}  (restart the companion or re-plug the drive to apply)`);
}

const HELP = `Tesla Dashcam Studio companion

  node dashcam-companion.js install        start automatically at login (LaunchAgent / Startup folder) + doctor
  node dashcam-companion.js uninstall
  node dashcam-companion.js run            watch for the Tesla drive and export new events (default)
        --once            process what's mounted now, then exit
        --volumes-root D  treat D as /Volumes (testing)       --all  include RecentClips
  node dashcam-companion.js scan <path>    export a TeslaCam folder once (e.g. a copy on disk)  [--wait-signin]
  node dashcam-companion.js index <path>   only index → index.json + index.html
  node dashcam-companion.js signin         open the Tesla sign-in page of the running companion
  node dashcam-companion.js signout        forget the stored Tesla token
  node dashcam-companion.js doctor         check ffmpeg, encoders, browser, token storage, folders
  node dashcam-companion.js config [key [value]]   e.g. config decrypt true · config share icloud · config exportOriginal true
  Common options: --out <folder>  --renderer auto|browser|ffmpeg  --original  --retry`;

(async () => {
  switch (cmd) {
    case "run": return run();
    case "scan": await scanCmd(); return;
    case "index": await indexCmd(); return;
    case "doctor": return doctor();
    case "config": return configCmd();
    case "signout": K.remove(); console.log("Stored Tesla token removed (" + K.backend() + ")."); return;
    case "signin": {
      const cfg = C.load();
      try { const r = await fetch(`http://127.0.0.1:${cfg.port}/library`); if (r.ok) { openUrl(`http://127.0.0.1:${cfg.port}/signin`); return; } } catch (_) {}
      console.log("The companion isn't running. Start it (install, or `run`) with the drive plugged in; it shows a sign-in link when encrypted clips are waiting.\nOr: node dashcam-companion.js scan <TeslaCam folder> --wait-signin");
      return;
    }
    case "install": {
      if (flag("dry-run")) { for (const pl of ["darwin", "win32"]) for (const f of INST.install({ dryRun: true, platform: pl })) console.log(`── ${f.file}\n${f.content}`); return; }
      const cfg = C.load();
      fs.mkdirSync(cfg.outputDir, { recursive: true });
      if (!fs.existsSync(C.file())) C.saveUser({ outputDir: null });
      for (const s of INST.install({ taskScheduler: flag("task-scheduler") })) console.log("•", s);
      console.log("");
      doctor();
      console.log(`\nDone. Plug in the Tesla drive; videos appear in ${cfg.outputDir} (library: index.html there).`);
      return;
    }
    case "uninstall": for (const s of INST.uninstall()) console.log("•", s); return;
    case "help": case "--help": case "-h": console.log(HELP); return;
    default: console.log(HELP); process.exitCode = 2;
  }
})().catch((e) => { console.error("Error:", e.message); process.exit(1); });
