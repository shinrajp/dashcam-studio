/* library-page.js — index.json + a self-contained index.html "library" in the export folder (works offline,
 * double-clickable, and inside iCloud/OneDrive/Dropbox). The live companion server serves the same page. */
"use strict";
const fs = require("fs"), path = require("path");
const RO = require("./readonly");
const P = require("./platform");

const libFile = () => path.join(P.configDir(), "library.json");
function loadLib() { try { return JSON.parse(fs.readFileSync(libFile(), "utf8")); } catch (_) { return { events: {} }; } }
function saveLib(lib) { fs.mkdirSync(path.dirname(libFile()), { recursive: true }); fs.writeFileSync(libFile(), JSON.stringify(lib, null, 1)); }

/** Merge indexed events (+ their processing status) into the persistent library. */
function upsert(events, extra) {
  const lib = loadLib();
  for (const ev of events) {
    const prev = lib.events[ev.fingerprint] || {};
    lib.events[ev.fingerprint] = {
      ...prev,
      id: ev.id, fingerprint: ev.fingerprint, source: ev.source, trigger: ev.trigger, time: ev.time, eventTime: ev.eventTime || null,
      location: ev.location, duration: Math.round(ev.duration * 10) / 10, durationApprox: !!ev.durationApprox, cams: ev.cams,
      clips: ev.clips.length, encrypted: ev.encrypted, broken: ev.broken, drive: (extra && extra.drive) || prev.drive || null,
      indexed: Date.now(),
    };
  }
  saveLib(lib);
  return lib;
}
function setStatus(fp, patch) { const lib = loadLib(); if (lib.events[fp]) { Object.assign(lib.events[fp], patch); saveLib(lib); } return lib; }

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pad2 = (n) => String(n).padStart(2, "0");
const fmtDur = (s) => { s = Math.round(s || 0); return s >= 3600 ? `${Math.floor(s / 3600)}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}` : `${Math.floor(s / 60)}:${pad2(s % 60)}`; };
const ICON = { sentry: "◉", user: "★", safety: "⚠", recent: "▶", files: "▤" };

function html(lib, opts) {
  opts = opts || {};
  const href = opts.href || ((name) => encodeURI(name));
  const evs = Object.values(lib.events).sort((a, b) => (b.time || 0) - (a.time || 0));
  const days = new Map();
  for (const e of evs) {
    const d = new Date(e.time || 0);
    const k = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(e);
  }
  const card = (e) => {
    const d = new Date(e.time || 0);
    const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const loc = e.location || {};
    const place = loc.city ? esc(loc.city) : loc.lat != null ? `${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}` : "Unknown location";
    const map = loc.lat != null ? `<a class="pin" href="https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lon}#map=16/${loc.lat}/${loc.lon}" target="_blank" rel="noopener">${place}</a>` : `<span class="pin">${place}</span>`;
    const outs = (e.outputs || []).map((o) => `<a class="btn${o.preset === "compat" ? " primary" : ""}" href="${esc(href(o.name))}">${o.preset === "compat" ? "▶ Play (1080p MP4)" : `Original ${o.W}×${o.H}`}</a>`).join("");
    const st = e.status || "indexed";
    const badge = { done: "", "needs-signin": `<span class="badge warn">Encrypted · sign in to unlock</span>`, failed: `<span class="badge err" title="${esc(e.error || "")}">Export failed</span>`, skipped: `<span class="badge">Not exported (${esc(e.skipReason || "source not selected")})</span>`, indexed: `<span class="badge">Waiting</span>`, rendering: `<span class="badge info">Exporting…</span>` }[st] || "";
    const thumb = e.thumb ? `<img loading="lazy" src="${esc(href(e.thumb))}" alt="">` : `<div class="noimg">${ICON[(e.trigger || {}).kind] || "▤"}</div>`;
    const first = (e.outputs || []).find((o) => o.preset === "compat") || (e.outputs || [])[0];
    return `<article class="card k-${esc((e.trigger || {}).kind)}">
  ${first ? `<a class="thumb" href="${esc(href(first.name))}">${thumb}</a>` : `<div class="thumb">${thumb}</div>`}
  <div class="body"><div class="row"><b>${time}</b><span class="dur">${e.durationApprox ? "≈" : ""}${fmtDur(e.duration)}</span></div>
  <div class="trig">${esc((e.trigger || {}).label || "Event")}</div>
  <div class="meta">${map} · ${esc(e.source)} · ${(e.cams || []).length} cams${e.encrypted ? " · 🔒 encrypted" : ""}</div>
  <div class="acts">${outs}${badge}</div></div></article>`;
  };
  const counts = { all: evs.length, done: evs.filter((e) => e.status === "done").length };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TeslaCam Library</title><style>
:root{color-scheme:dark;--bg:#0b0c10;--card:#15171d;--line:#262a33;--tx:#f3f4f6;--dim:#9aa3b2;--blue:#3E6AE1}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:14px;padding:14px 24px;background:rgba(11,12,16,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
header h1{font-size:17px;margin:0}header .sub{color:var(--dim);font-size:13px}header .sp{flex:1}
main{padding:8px 24px 40px;max-width:1400px;margin:0 auto}h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);margin:26px 0 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
.thumb{display:block;aspect-ratio:2.3/1;background:#0f1116;overflow:hidden}.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.noimg{height:100%;display:grid;place-items:center;font-size:34px;color:#3a3f4b}
.body{padding:10px 12px 12px}.row{display:flex;justify-content:space-between;align-items:baseline}.row b{font-size:16px}.dur{color:var(--dim);font-variant-numeric:tabular-nums}
.trig{font-weight:600;margin:2px 0}.meta{color:var(--dim);font-size:12.5px}.pin{color:var(--dim)}a.pin:hover{color:var(--tx)}
.acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.btn{padding:6px 10px;border-radius:8px;border:1px solid var(--line);color:var(--tx);text-decoration:none;font-size:12.5px;font-weight:600}
.btn.primary{background:var(--blue);border-color:var(--blue)}.btn:hover{filter:brightness(1.15)}
.badge{padding:5px 9px;border-radius:8px;font-size:12px;background:#22262f;color:var(--dim)}.badge.warn{background:#3a2f12;color:#f5c451}.badge.err{background:#3b1518;color:#ff8a8a}.badge.info{background:#18264a;color:#9db6ff}
.k-sentry .trig{color:#ff8a8a}.k-safety .trig{color:#f5c451}.empty{color:var(--dim);padding:60px 0;text-align:center}
footer{color:var(--dim);font-size:12px;text-align:center;padding:20px}
</style></head><body><header><div><h1>TeslaCam Library</h1><div class="sub">${counts.all} events · ${counts.done} exported · updated ${esc(new Date().toLocaleString())}</div></div><span class="sp"></span>${opts.signinUrl ? `<a class="btn primary" href="${esc(opts.signinUrl)}">Sign in with Tesla to unlock encrypted clips</a>` : ""}</header>
<main>${evs.length ? [...days].map(([k, list]) => `<h2>${esc(k)}</h2><div class="grid">${list.map(card).join("")}</div>`).join("") : `<div class="empty">No events yet — plug in your Tesla USB drive.</div>`}</main>
<footer>Made by Tesla Dashcam Studio companion · videos stay on this computer${opts.static ? " · open the MP4s with any player" : ""}</footer></body></html>`;
}

/** Write <outDir>/index.json + index.html (never on the drive). */
function write(outDir) {
  const lib = loadLib();
  RO.assertNotOnDrive(outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const evs = Object.values(lib.events).sort((a, b) => (b.time || 0) - (a.time || 0)).map((e) => ({
    id: e.id, date: new Date(e.time || 0).toISOString(), localTime: e.time ? new Date(e.time).toString() : null, trigger: e.trigger, source: e.source,
    location: e.location, duration: e.duration, cameras: e.cams, encrypted: e.encrypted, status: e.status || "indexed",
    outputs: (e.outputs || []).map((o) => ({ file: o.name, preset: o.preset, width: o.W, height: o.H, codec: o.codec, hardware: !!o.hw, renderer: o.renderer })),
    thumbnail: e.thumb || null, drive: e.drive, error: e.error || null,
  }));
  fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify({ generated: new Date().toISOString(), count: evs.length, events: evs }, null, 2));
  fs.writeFileSync(path.join(outDir, "index.html"), html(lib, { static: true }));
  return lib;
}

module.exports = { upsert, setStatus, loadLib, html, write, libFile };
