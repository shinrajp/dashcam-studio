/* track-real.js — run the region tracker on a real clip, outside the browser, the way the page drives it: a look about every 0.1 s, the blur
 * goes when the object leaves the picture or stays unseen for coastT, then the whole frame is searched every 0.3 s.
 * Writes the boxes per look as JSON (and optionally PNG frames with the box drawn, via tools/track-real-draw.py).
 * Usage: node tools/track-real.js <clip.mp4> <x,y,w,h at t0 (0..1)> [t0=0] [t1=end] [out.json]
 * Needs ffmpeg. The frame is decoded grey at full size; each look draws the part the tracker asks for, like grabGrey() does. */
const { spawn, execFileSync } = require("child_process"), fs = require("fs"), path = require("path");
const PT = require(path.join(__dirname, "../js/patch-track.js"));
const [clip, boxS, t0S, t1S, outS] = process.argv.slice(2);
if (!clip || !boxS) { console.error("usage: node tools/track-real.js clip.mp4 x,y,w,h [t0] [t1] [out.json]"); process.exit(2); }
const [bx, by, bw, bh] = boxS.split(",").map(Number), T0 = +(t0S || 0), T1 = t1S ? +t1S : Infinity, OUT = outS || "track-real.json";
const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", clip]).toString()).streams[0];
const FW = info.width, FH = info.height, HZ = 10;
/** Area-averaged draw of the part `plan` of the frame (like drawImage with smoothing), grey. */
function grab(frame, plan) {
  const { SW, SH } = plan, g = new Float32Array(SW * SH);
  const x0 = plan.nx * FW, y0 = plan.ny * FH, sx = plan.nw * FW / SW, sy = plan.nh * FH / SH;
  if (sx <= 1.5 && sy <= 1.5) {   // bilinear
    for (let j = 0; j < SH; j++) for (let i = 0; i < SW; i++) {
      let x = x0 + (i + 0.5) * sx - 0.5, y = y0 + (j + 0.5) * sy - 0.5;
      x = Math.max(0, Math.min(FW - 1, x)); y = Math.max(0, Math.min(FH - 1, y));
      const xi = x | 0, yi = y | 0, x1 = Math.min(FW - 1, xi + 1), y1 = Math.min(FH - 1, yi + 1), fx = x - xi, fy = y - yi;
      const a = frame[yi * FW + xi], b = frame[yi * FW + x1], c = frame[y1 * FW + xi], d = frame[y1 * FW + x1];
      g[j * SW + i] = a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    }
  } else {   // box average
    for (let j = 0; j < SH; j++) {
      const ya = Math.max(0, Math.floor(y0 + j * sy)), yb = Math.min(FH, Math.max(ya + 1, Math.floor(y0 + (j + 1) * sy)));
      for (let i = 0; i < SW; i++) {
        const xa = Math.max(0, Math.floor(x0 + i * sx)), xb = Math.min(FW, Math.max(xa + 1, Math.floor(x0 + (i + 1) * sx)));
        let s = 0, n = 0;
        for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) { s += frame[y * FW + x]; n++; }
        g[j * SW + i] = n ? s / n : 0;
      }
    }
  }
  return { g, W: SW, H: SH, ox: plan.nx, oy: plan.ny, ow: plan.nw, oh: plan.nh };
}
const ff = spawn("ffmpeg", ["-loglevel", "error", "-ss", String(T0), "-i", clip, ...(isFinite(T1) ? ["-t", String(T1 - T0)] : []), "-vf", "fps=" + HZ, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
const size = FW * FH; let buf = Buffer.alloc(0), n = 0, tr = null, hidden = false, lastSearch = -9;
const rows = [], box0 = { x: bx, y: by, w: bw, h: bh }, ms = [];
function look(frame, t) {
  const t0 = Date.now();
  if (!tr) { tr = PT.create(grab(frame, PT.createPlan(box0, { fw: FW, fh: FH })), box0, t, { fw: FW, fh: FH }); rows.push({ t, box: box0, state: "start" }); return; }
  if (hidden) {
    if (t - lastSearch >= 0.3 - 1e-6) {
      lastSearch = t;
      const r = tr.reacquire(grab(frame, tr.searchPlan()), t);
      if (r) { hidden = false; rows.push({ t, box: null, state: "found", score: +r.score.toFixed(2), dbg: tr._rdbg }); ms.push(Date.now() - t0); return; }
      rows.push({ t, box: null, state: "search", dbg: tr._rdbg }); ms.push(Date.now() - t0); return;
    }
    rows.push({ t, box: null, state: "hidden" }); return;
  }
  const res = tr.update(grab(frame, tr.plan(t)), t);
  ms.push(Date.now() - t0);
  if (res.ok && res.probation) { rows.push({ t, box: null, state: "confirm", score: +(res.score || 0).toFixed(2) }); return; }
  if (!res.ok && res.hide) { hidden = true; lastSearch = t; rows.push({ t, box: null, state: res.unconfirmed ? "refused" : res.gone ? "left" : "lost", score: +(res.score || 0).toFixed(2) }); return; }
  rows.push({ t, box: res.box, state: res.ok ? (res.fit ? "fit" : res.flow ? "flow" : res.part ? "part" : "ok") : "coast", score: +(res.score || 0).toFixed(2), scale: res.scale, ms: tr._msdbg });
}
PT.debug = true;
ff.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= size) {
    const fr = new Float32Array(size); for (let i = 0; i < size; i++) fr[i] = buf[i];
    buf = buf.subarray(size);
    look(fr, +(T0 + n / HZ).toFixed(3)); n++;
  }
});
ff.on("close", () => {
  fs.writeFileSync(OUT, JSON.stringify({ clip, FW, FH, box0, rows }));
  const st = {}; for (const r of rows) st[r.state] = (st[r.state] || 0) + 1;
  ms.sort((a, b) => a - b);
  console.log("looks " + rows.length + " · " + JSON.stringify(st) + " · ms/look median " + ms[ms.length >> 1] + ", p95 " + ms[Math.floor(ms.length * 0.95)] + " → " + OUT);
});
