/* render-ffmpeg.js — fallback renderer when no Chrome/Edge is installed (or the browser render fails).
 * One ffmpeg filter_complex: per camera, the event's clips are normalised (scale/pad/fps), gaps filled with dark
 * frames, concatenated, then xstack'ed into the 3×2 grid. Overlays are an ASS subtitle track generated from the
 * SEI telemetry (camera labels, clock, speed · gear · Autopilot state · blinkers · brake) and burned in with libass.
 * The graphical HUD dials and the map need the browser renderer; this path is "everything as text".
 * Encoder: first that works of videotoolbox (macOS) / nvenc, qsv, amf (Windows) / libx264. */
"use strict";
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os");
const RO = require("./readonly");
const MP4 = require("../../js/mp4.js"), SEI = require("../../js/sei.js");
const { log } = require("./notify");

const GRID = ["left_pillar", "front", "right_pillar", "left_repeater", "back", "right_repeater"];
const LABEL = { left_pillar: "LEFT PILLAR", front: "FRONT", right_pillar: "RIGHT PILLAR", left_repeater: "LEFT REPEATER", back: "REAR", right_repeater: "RIGHT REPEATER" };
const AP = { 1: "Self-Driving", 2: "Autosteer", 3: "TACC" };
const GEAR = ["P", "D", "R", "N"];
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

let caps = null;
function capabilities() {
  if (caps) return caps;
  const run = (args) => spawnSync("ffmpeg", ["-hide_banner", ...args], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  const v = run(["-version"]);
  if (v.error || v.status !== 0) return (caps = { ok: false });
  const filters = run(["-filters"]).stdout || "";
  const has = (f) => new RegExp("\\s" + f + "\\s").test(filters);
  // ffmpeg 8+ removed -filter_complex_script; 7.0+ reads an option value from a file with the "-/" prefix.
  const major = +((/ffmpeg version n?(\d+)\./.exec(v.stdout) || [])[1] || 0);
  const scriptOpt = major >= 7 || !/filter_complex_script/.test(run(["-h", "full"]).stdout || "") ? "-/filter_complex" : "-filter_complex_script";
  caps = { ok: true, version: (v.stdout.split("\n")[0] || "").trim(), ass: has("ass"), xstack: has("xstack"), scriptOpt, encoders: {} };
  return caps;
}

const CANDIDATES = {
  h264: process.platform === "darwin" ? ["h264_videotoolbox", "libx264"] : process.platform === "win32" ? ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"] : ["h264_nvenc", "h264_qsv", "h264_vaapi", "libx264"],
  hevc: process.platform === "darwin" ? ["hevc_videotoolbox", "libx265"] : process.platform === "win32" ? ["hevc_nvenc", "hevc_qsv", "hevc_amf", "libx265"] : ["hevc_nvenc", "hevc_qsv", "libx265"],
};
/** Encoders that actually work on this machine (a 0.2 s test encode each; cached). */
function workingEncoders(codec) {
  const c = capabilities();
  if (!c.ok) return [];
  if (c.encoders[codec]) return c.encoders[codec];
  const ok = [];
  for (const enc of CANDIDATES[codec] || CANDIDATES.h264) {
    if (enc.endsWith("vaapi")) continue; // needs device setup; skipped
    const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=black:s=640x360:r=30:d=0.2", "-pix_fmt", "yuv420p", "-c:v", enc, "-f", "null", "-"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
    if (r.status === 0) ok.push(enc);
  }
  return (c.encoders[codec] = ok);
}

function encoderArgs(enc, W, H, fps) {
  const br = Math.round(W * H * fps * 0.11 / 1000) + "k", max = Math.round(W * H * fps * 0.2 / 1000) + "k";
  const hevc = /hevc|265/.test(enc);
  const tag = hevc ? ["-tag:v", "hvc1"] : [];
  if (enc === "libx264") return ["-c:v", enc, "-preset", "veryfast", "-crf", "21", "-profile:v", "high", ...tag];
  if (enc === "libx265") return ["-c:v", enc, "-preset", "fast", "-crf", "24", ...tag];
  if (enc.endsWith("videotoolbox")) return ["-c:v", enc, "-b:v", br, "-maxrate", max, "-bufsize", max, ...(hevc ? [] : ["-profile:v", "high"]), ...tag];
  if (enc.endsWith("nvenc")) return ["-c:v", enc, "-preset", "p5", "-rc", "vbr", "-cq", "23", "-b:v", br, "-maxrate", max, ...tag];
  if (enc.endsWith("qsv")) return ["-c:v", enc, "-preset", "medium", "-b:v", br, "-maxrate", max, ...tag];
  if (enc.endsWith("amf")) return ["-c:v", enc, "-quality", "balanced", "-rc", "vbr_peak", "-b:v", br, "-maxrate", max, ...tag];
  return ["-c:v", enc, "-b:v", br, ...tag];
}

async function probe(abs) {
  let r;
  try { r = await RO.reader(abs); const tr = await MP4.demux(r); return { w: tr.width, h: tr.height, fps: tr.fps, dur: tr.duration, tr }; }
  catch (_) { return null; } finally { if (r) await r.close().catch(() => {}); }
}
async function telemetry(abs, info) {
  let r;
  try { r = await RO.reader(abs); const res = await SEI.parseClip(r, info.tr); return res ? res.rows : []; }
  catch (_) { return []; } finally { if (r) await r.close().catch(() => {}); }
}

const assTime = (t) => { t = Math.max(0, t); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60; return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`; };
const assText = (s) => String(s).replace(/[{}\\]/g, "").replace(/\n/g, " ");
const pad2 = (n) => String(n).padStart(2, "0");
const clock = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };

function buildAss(L, ev, clips, rows, cfg) {
  const font = process.platform === "linux" ? "DejaVu Sans" : "Arial";
  const fs1 = Math.max(14, Math.round(L.ch * 0.045)), fsBand = Math.max(18, Math.round((L.band || L.ch * 0.4) * 0.36));
  const show = cfg.overlays || {};
  const kmh = (cfg.prefs && cfg.prefs.units) === "kmh";
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${L.W}`, `PlayResY: ${L.H}`, "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Label,${font},${fs1},&H00FFFFFF,&H00FFFFFF,&H70000000,&H70000000,1,0,0,0,100,100,1,0,3,${Math.round(fs1 * 0.3)},0,7,0,0,0,1`,
    `Style: Band,${font},${fsBand},&H00F3F4F6,&H00FFFFFF,&H90000000,&H90000000,1,0,0,0,100,100,0,0,3,${Math.round(fsBand * 0.25)},0,2,0,0,0,1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const total = clips.reduce((a, c) => a + c.dur, 0);
  const dlg = (a, b, style, text) => lines.push(`Dialogue: 0,${assTime(a)},${assTime(b)},${style},,0,0,0,,${text}`);
  if (show.labels !== false) GRID.forEach((cam, i) => {
    const x = L.gx + (i % 3) * L.cw + Math.round(fs1 * 0.5), y = L.gy + Math.floor(i / 3) * L.ch + Math.round(fs1 * 0.5);
    dlg(0, total, "Label", `{\\pos(${x},${y})}${LABEL[cam]}`);
  });
  // placeholders for cameras missing in a clip (same wording as the web app)
  GRID.forEach((cam, i) => {
    const x = L.gx + (i % 3) * L.cw + L.cw / 2, y = L.gy + Math.floor(i / 3) * L.ch + L.ch / 2;
    for (const c of clips) if (!c.files[cam]) dlg(c.start, c.start + c.dur, "Band", `{\\an5\\pos(${Math.round(x)},${Math.round(y)})\\alpha&H40&}No ${LABEL[cam].toLowerCase()} footage`);
  });
  // clock (+ trigger · place in the band)
  const where = [ev.trigger && ev.trigger.label, ev.location && ev.location.city].filter(Boolean).map(assText).join(" · ");
  if (show.time !== false) for (const c of clips) {
    if (!c.time) continue;
    for (let s = 0; s < c.dur; s += 1) {
      const a = c.start + s, b = Math.min(c.start + c.dur, a + 1);
      if (L.band) dlg(a, b, "Band", `{\\an1\\pos(${L.gx + 12},${L.H - Math.round(L.band * 0.28)})}${clock(c.time + s * 1000)}`);
      else dlg(a, b, "Label", `{\\an9\\pos(${L.W - Math.round(fs1 * 0.5)},${Math.round(fs1 * 0.5)})}${clock(c.time + s * 1000)}`);
    }
  }
  if (L.band && where) dlg(0, total, "Band", `{\\an3\\pos(${L.gx + L.gw - 12},${L.H - Math.round(L.band * 0.28)})}${where}`);
  // telemetry line at 10 Hz (identical consecutive slots merged)
  if (show.hud !== false && rows.length) {
    const BLUE = "&HE16A3E&", GREEN = "&H6EE62E&", RED = "&H4444EF&";
    let prev = null, from = 0, k = 0;
    const flush = (to) => { if (prev !== null && prev !== "") dlg(from, to, "Band", L.band ? `{\\an2\\pos(${L.W / 2},${L.H - Math.round(L.band * 0.28)})}${prev}` : `{\\an2\\pos(${L.W / 2},${L.H - Math.round(fsBand * 0.6)})}${prev}`); };
    for (let t = 0; t < total; t += 0.1) {
      while (k + 1 < rows.length && rows[k + 1][0] <= t) k++;
      const m = rows[k] && Math.abs(rows[k][0] - t) < 1.5 ? rows[k][1] : null;
      let txt = "";
      if (m) {
        const v = Math.round(Math.max(0, m.speed || 0) * (kmh ? 3.6 : 2.236936));
        const flash = Math.floor(t * 3) % 2 === 0;
        const parts = [`${v} ${kmh ? "km/h" : "mph"}`, GEAR[m.gear] || "–"];
        if (show.fsd !== false && AP[m.ap]) parts.push(m.ap === 1 ? `{\\c${BLUE}}${AP[m.ap]}{\\c}` : AP[m.ap]);
        if (m.brake) parts.push(`{\\c${RED}}BRAKE{\\c}`);
        txt = (m.blinkL && flash ? `{\\c${GREEN}}←{\\c}  ` : "") + parts.join("  ·  ") + (m.blinkR && flash ? `  {\\c${GREEN}}→{\\c}` : "");
      }
      if (txt !== prev) { flush(t); prev = txt; from = t; }
    }
    flush(total);
  }
  return lines.join("\n") + "\n";
}

/**
 * ev: indexed event; fileOf(f) → absolute readable path (plain or decrypted) or null.
 * Returns { file, W, H, codec, encoder, hw, fps, frames? }.
 */
async function render(ev, preset, cfg, outDir, fileOf, onProgress) {
  const c = capabilities();
  if (!c.ok) throw new Error("ffmpeg not found on PATH");
  // probe files
  const sizes = new Map(); let fps = 0;
  const clips = [];
  let start = 0;
  for (const clip of ev.clips) {
    const files = {};
    let dur = 0;
    for (const cam of GRID) {
      const f = clip.files[cam]; const abs = f && fileOf(f);
      if (!abs) continue;
      const info = await probe(abs);
      if (!info) continue;
      files[cam] = { abs, info };
      dur = Math.max(dur, info.dur);
      const k = info.w + "x" + info.h; sizes.set(k, (sizes.get(k) || 0) + 1);
      if (cam === "front" || !fps) fps = info.fps;
    }
    if (!Object.keys(files).length) continue;
    clips.push({ ...clip, files, dur, start });
    start += dur;
  }
  if (!clips.length) throw new Error("No playable camera files");
  const [tw, th] = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0][0].split("x").map(Number);
  // layout
  let L;
  if (preset === "original") L = { W: even(tw * 3), H: even(th * 2), cw: tw, ch: th, gx: 0, gy: 0, band: 0, fps: Math.round(fps) || 36 };
  else {
    const W = 1920, H = 1080, band = 72;
    let cw = even(Math.floor(W / 3)), ch = even(cw * th / tw);
    if (2 * ch > H - band) { ch = even(Math.floor((H - band) / 2)); cw = even(ch * tw / th); }
    L = { W, H, cw, ch, gx: even((W - 3 * cw) / 2), gy: even((H - band - 2 * ch) / 2), band, fps: 30 };
  }
  L.gw = 3 * L.cw;
  // telemetry from the front camera (fallback: rear)
  const rows = [];
  for (const cl of clips) {
    const f = cl.files.front || cl.files.back;
    if (!f) continue;
    for (const [t, m] of await telemetry(f.abs, f.info)) rows.push([cl.start + t, m]);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tdc-ff-"));
  const args = ["-hide_banner", "-v", "error", "-y", "-nostdin"];
  const fl = [];
  let n = 0;
  GRID.forEach((cam, ci) => {
    const segs = [];
    clips.forEach((cl, j) => {
      const f = cl.files[cam], lbl = `s${ci}_${j}`;
      if (f) {
        args.push("-i", f.abs);
        fl.push(`[${n++}:v]setpts=PTS-STARTPTS,scale=${L.cw}:${L.ch}:force_original_aspect_ratio=decrease,pad=${L.cw}:${L.ch}:(ow-iw)/2:(oh-ih)/2:color=0x0b0c10,setsar=1,fps=${L.fps},tpad=stop_mode=clone:stop_duration=${cl.dur.toFixed(3)},trim=duration=${cl.dur.toFixed(3)},setpts=PTS-STARTPTS[${lbl}]`);
      } else fl.push(`color=c=0x16181d:s=${L.cw}x${L.ch}:r=${L.fps}:d=${cl.dur.toFixed(3)},setsar=1[${lbl}]`);
      segs.push(`[${lbl}]`);
    });
    fl.push(segs.length > 1 ? `${segs.join("")}concat=n=${segs.length}:v=1:a=0[c${ci}]` : `${segs[0]}null[c${ci}]`);
  });
  fl.push(`[c0][c1][c2][c3][c4][c5]xstack=inputs=6:layout=0_0|w0_0|w0+w1_0|0_h0|w0_h0|w0+w1_h0,pad=${L.W}:${L.H}:${L.gx}:${L.gy}:color=0x0b0c10`
    + (c.ass ? ",ass=overlay.ass" : "") + ",format=yuv420p[out]");
  if (c.ass) fs.writeFileSync(path.join(tmp, "overlay.ass"), buildAss(L, ev, clips, rows, cfg));
  fs.writeFileSync(path.join(tmp, "graph.txt"), fl.join(";\n"));
  const total = clips.reduce((a, cl) => a + cl.dur, 0);
  const codec = preset === "original" ? (cfg.originalCodec === "hevc" ? "hevc" : "h264") : "h264";
  const encs = workingEncoders(codec);
  if (!encs.length) throw new Error("No working " + codec + " encoder in this ffmpeg build");
  const d0 = new Date(clips[0].time || ev.time || Date.now());
  const stamp = `${d0.getFullYear()}-${pad2(d0.getMonth() + 1)}-${pad2(d0.getDate())}_${pad2(d0.getHours())}-${pad2(d0.getMinutes())}-${pad2(d0.getSeconds())}`;
  const name = `TeslaCam_${stamp}_${(ev.trigger && ev.trigger.kind) || "event"}_${preset === "original" ? "original" : "compatible"}_${L.W}x${L.H}_${codec}.mp4`;
  const dest = RO.assertNotOnDrive(path.join(outDir, name));
  fs.mkdirSync(outDir, { recursive: true });
  let lastErr = null;
  try {
    for (const enc of encs) {
      const full = [...args, c.scriptOpt, "graph.txt", "-map", "[out]", "-an", ...encoderArgs(enc, L.W, L.H, L.fps), "-r", String(L.fps), "-movflags", "+faststart", "-progress", "pipe:1", "-f", "mp4", dest + ".part"];
      log(`  ffmpeg ${preset} ${L.W}×${L.H} @${L.fps} fps with ${enc}${c.ass ? "" : " (no libass: overlays skipped)"}`);
      const res = await new Promise((resolve) => {
        const ch = spawn("ffmpeg", full, { cwd: tmp, windowsHide: true });
        let err = "";
        ch.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
        ch.stdout.on("data", (d) => { const m = /out_time_us=(\d+)/.exec(String(d)); if (m && onProgress) onProgress(Math.min(1, +m[1] / 1e6 / total)); });
        ch.on("error", (e) => resolve({ ok: false, err: e.message }));
        ch.on("close", (code) => resolve({ ok: code === 0, err }));
      });
      if (res.ok) {
        fs.renameSync(dest + ".part", dest);
        return { file: dest, name, W: L.W, H: L.H, codec, encoder: enc, hw: !/^lib/.test(enc), fps: L.fps, overlays: c.ass ? "text" : "none" };
      }
      lastErr = res.err; log(`  ${enc} failed: ${String(res.err).trim().split("\n").pop()}`);
      try { fs.unlinkSync(dest + ".part"); } catch (_) {}
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  throw new Error("ffmpeg failed: " + String(lastErr).trim().split("\n").slice(-2).join(" "));
}

module.exports = { render, capabilities, workingEncoders, buildAss };
