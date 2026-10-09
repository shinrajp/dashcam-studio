/* pipeline.js — what happens when a TeslaCam drive (or folder) shows up:
 * index (read-only) → library page → decrypt (optional) → render each new event → thumbnails/share copy → notify. */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const { spawnSync } = require("child_process");
const RO = require("./readonly"), I = require("./indexer"), S = require("./state"), LIB = require("./library-page");
const K = require("./keychain"), TS = require("./tesla"), FF = require("./render-ffmpeg"), BR = require("./render-browser");
const P = require("./platform"), C = require("./config");
const { notify, log } = require("./notify");

const SRC_ORDER = { SavedClips: 0, SentryClips: 1, RecentClips: 2, Files: 3 };

/** Split long events (RecentClips runs) into parts of ≤ maxMin minutes. */
function chunks(ev, maxMin) {
  const max = Math.max(1, maxMin || 15) * 60, out = [];
  let cur = [], dur = 0;
  for (const c of ev.clips) {
    if (cur.length && dur + (c.dur || 60) > max + 1) { out.push(cur); cur = []; dur = 0; }
    cur.push(c); dur += c.dur || 60;
  }
  if (cur.length) out.push(cur);
  return out.map((clips, i) => ({ ...ev, clips, part: out.length > 1 ? i + 1 : 0, parts: out.length, duration: clips.reduce((a, c) => a + (c.dur || 60), 0) }));
}

function thumbnail(video, outDir) {
  const rel = path.join(".thumbs", path.basename(video).replace(/\.\w+$/, ".jpg"));
  const dest = RO.assertNotOnDrive(path.join(outDir, rel));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-ss", "2", "-i", video, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", dest], { windowsHide: true, timeout: 60000 });
  return r.status === 0 ? rel.split(path.sep).join("/") : null;
}

class Pipeline {
  constructor(cfg, server, opts) {
    this.cfg = cfg; this.server = server; this.opts = opts || {};
    this.keys = new Map();          // wrappedHex → key (memory only)
    this.waitingKeys = new Map();   // fingerprint → { ev, base }
    this.browser = cfg.renderer === "ffmpeg" ? null : P.findBrowser(cfg.browserPath);
    this.cacheRoot = path.join(P.configDir(), "cache");
  }

  async processFolder(teslacam, label) {
    const cfg = this.cfg;
    const driveRoot = path.dirname(teslacam);
    RO.registerRoot(teslacam); if (P.isDriveRoot(driveRoot, this.opts.volumesRoot)) RO.registerRoot(driveRoot); // a TeslaCam copy in ~/Movies must not lock ~/Movies
    log(`Scanning ${teslacam} (read-only)…`);
    const t0 = Date.now();
    const { events, base } = await I.scan(teslacam);
    LIB.upsert(events, { drive: label || driveRoot });
    log(`Indexed ${events.length} events in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const todo = [], needKeys = [];
    for (const ev of events.sort((a, b) => (SRC_ORDER[a.source] - SRC_ORDER[b.source]) || (b.time - a.time))) {
      if (S.isDone(ev.fingerprint)) { log(`  skip (already exported): ${ev.trigger.label} ${new Date(ev.time).toLocaleString()}`); continue; }
      const st = S.get(ev.fingerprint);
      if (st && st.status === "failed" && st.attempts >= 3 && !this.opts.retry) { log(`  skip (failed 3×, use --retry): ${ev.trigger.label}`); continue; }
      if (!this.opts.all && !cfg.sources.includes(ev.source)) { LIB.setStatus(ev.fingerprint, { status: "skipped", skipReason: ev.source + " not selected" }); continue; }
      const playable = ev.clips.some((c) => Object.values(c.files).some((f) => f.kind === "plain"));
      if (ev.locked) {
        if (!cfg.decrypt) { LIB.setStatus(ev.fingerprint, { status: playable ? "indexed" : "needs-signin", skipReason: "auto-decrypt is off" }); if (!playable) continue; }
        else { needKeys.push({ ev, base }); if (!playable) continue; }
      }
      if (!ev.locked || !cfg.decrypt) todo.push({ ev, base });
    }
    LIB.write(cfg.outputDir);
    if (needKeys.length) await this.unlock(needKeys, todo);
    if (!todo.length) {
      log("Nothing new to export.");
      if (this.waitingKeys.size) notify("Encrypted clips need Tesla sign-in", `${this.waitingKeys.size} event(s) are waiting. Open the TeslaCam Library and click “Sign in with Tesla”.`);
      return { exported: 0 };
    }
    notify("TeslaCam drive found", `Exporting ${todo.length} new event${todo.length > 1 ? "s" : ""}… you can walk away.`);
    let ok = 0, failed = 0;
    const made = [];
    for (let i = 0; i < todo.length; i++) {
      const r = await this.renderEvent(todo[i].ev, todo[i].base, `${i + 1}/${todo.length}`);
      if (r.ok) { ok++; made.push(...r.outputs); } else failed++;
      LIB.write(cfg.outputDir);
    }
    const shareNote = C.shareDir(cfg) ? " (and copied to your cloud folder)" : "";
    const wait = this.waitingKeys.size ? ` ${this.waitingKeys.size} encrypted event${this.waitingKeys.size > 1 ? "s wait" : " waits"} for Tesla sign-in (see the library).` : "";
    notify(failed ? `Exported ${ok}, ${failed} failed` : `${ok} TeslaCam video${ok === 1 ? "" : "s"} ready`, `Saved to ${cfg.outputDir}${shareNote}. You can unplug the drive.${wait}`);
    return { exported: ok, failed, outputs: made };
  }

  /** Get keys (stored token → Tesla endpoint; else wait for the sign-in page), decrypt into the cache, queue renders. */
  async unlock(list, todo) {
    const items = TS.keyItems(list.map((x) => x.ev)).filter((it) => !this.keys.has(CRhex(it.wrapped_key)));
    if (items.length) {
      const token = K.get();
      if (token) {
        try {
          const got = await TS.fetchKeys(token, items);
          for (const [k, v] of got) this.keys.set(k, v);
          log(`Fetched ${got.size}/${items.length} keys with the stored Tesla sign-in`);
        } catch (e) {
          log("Key request failed:", e.message);
          if (e.code === "AUTH") notify("Tesla sign-in expired", "Open the TeslaCam Library and sign in again to unlock encrypted clips.");
        }
      }
    }
    for (const x of list) {
      const files = x.ev.clips.flatMap((c) => Object.values(c.files)).filter((f) => f.kind === "encrypted");
      if (files.every((f) => this.keys.has(f.header.wrappedHex))) { todo.push(x); this.waitingKeys.delete(x.ev.fingerprint); }
      else { this.waitingKeys.set(x.ev.fingerprint, x); LIB.setStatus(x.ev.fingerprint, { status: "needs-signin" }); }
    }
    if (this.server) this.server.signin = this.signinHooks();
  }

  signinHooks() {
    return {
      items: TS.keyItems([...this.waitingKeys.values()].map((x) => x.ev)),
      onToken: (tok) => { try { log(`Tesla token stored in ${K.backend()}`); K.set(tok); } catch (e) { log("Could not store token:", e.message); } },
      onKeys: (results) => {
        const items = this.server.signin.items;
        const got = TS.applyResults(results, items);
        for (const [k, v] of got) this.keys.set(k, v);
        log(`Received ${got.size} keys from the sign-in page`);
        if (this.onKeysReceived) this.onKeysReceived();
      },
    };
  }

  /** Re-run events that were waiting for keys (after sign-in). */
  async processWaiting() {
    const list = [...this.waitingKeys.values()], todo = [];
    if (!list.length) return { exported: 0 };
    await this.unlock(list, todo);
    let ok = 0;
    for (const x of todo) { const r = await this.renderEvent(x.ev, x.base, "unlocked"); if (r.ok) ok++; LIB.write(this.cfg.outputDir); }
    if (ok) notify(`${ok} unlocked video${ok === 1 ? "" : "s"} ready`, `Saved to ${this.cfg.outputDir}.`);
    return { exported: ok };
  }

  async renderEvent(ev, base, tag) {
    const cfg = this.cfg;
    const fp = ev.fingerprint;
    const cache = path.join(this.cacheRoot, fp);
    LIB.setStatus(fp, { status: "rendering" });
    log(`[${tag}] ${ev.trigger.label} · ${new Date(ev.time).toLocaleString()} · ${ev.location.city || "?"} · ${ev.clips.length} clip(s)`);
    const decrypted = new Map();
    try {
      // decrypt (local, Node crypto) into the cache — never next to the source
      for (const c of ev.clips) for (const f of Object.values(c.files)) {
        if (f.kind !== "encrypted") continue;
        const key = this.keys.get(f.header.wrappedHex);
        if (!key) continue;
        const dest = path.join(cache, f.path);
        await TS.decryptFile(f.abs, dest, f.header, key);
        decrypted.set(f.abs, dest);
      }
      if (decrypted.size) {
        log(`  decrypted ${decrypted.size} file(s) locally`);
        for (const c of ev.clips) { const f = Object.values(c.files).find((x) => decrypted.has(x.abs)); if (f) { const d = await I.durationOf(decrypted.get(f.abs)); if (d) c.dur = d.dur; } }
        ev.duration = ev.clips.reduce((a, c) => a + (c.dur || 60), 0); ev.durationApprox = false;
        if (ev.location.lat == null) await I.fillGps(ev, (f) => decrypted.get(f.abs) || (f.kind === "plain" ? f.abs : null));
        LIB.upsert([ev]);
      }
      const fileOf = (f) => decrypted.get(f.abs) || (f.kind === "plain" ? f.abs : null);
      const presets = ["compat"].concat(cfg.exportOriginal ? ["original"] : []);
      const outputs = [];
      for (const part of chunks(ev, cfg.maxChunkMinutes)) {
        const want = new Set(presets);
        if (this.browser && cfg.renderer !== "ffmpeg") {
          const files = [];
          for (const c of part.clips) for (const f of Object.values(c.files)) { const abs = fileOf(f); if (abs) files.push({ abs, name: f.name, path: f.path }); }
          const ej = path.join(base, ...ev.dir.split("/"), "event.json");
          if (ev.dir && fs.existsSync(ej)) files.push({ abs: ej, name: "event.json", path: ev.dir + "/event.json" });
          const t0 = Date.now(), lastPct = {};
          const res = await BR.render(this.server, cfg, this.browser, [{ id: ev.id + (part.part ? "#" + part.part : ""), files, presets }], cfg.outputDir,
            (p) => {
              if (p.state !== "encoding" || !p.total) return;
              const pct = Math.floor((p.done / p.total) * 100);
              if (process.stdout.isTTY) process.stdout.write(`\r  ${p.preset} ${pct}%   `);
              else if (pct >= (lastPct[p.preset] || 0) + 25 || pct === 100) { lastPct[p.preset] = pct; log(`  ${p.preset} ${pct}%`); }
            });
          if (process.stdout.isTTY) process.stdout.write("\r");
          for (const r of res.results) { outputs.push({ ...r, renderer: "browser", seconds: Math.round((Date.now() - t0) / 1000) }); want.delete(r.preset); }
          for (const e of res.errors) log("  browser renderer:", e.error);
        }
        for (const preset of want) {
          if (cfg.renderer === "browser") throw new Error("browser renderer failed and ffmpeg fallback is disabled");
          const r = await FF.render(part, preset, cfg, cfg.outputDir, fileOf, null);
          log(`  ✓ ${r.name} (${r.encoder}${r.hw ? ", hardware" : ""})`);
          outputs.push({ ...r, preset, renderer: "ffmpeg" });
        }
      }
      // thumbnails + share copy
      let thumb = null;
      for (const o of outputs) if (o.preset === "compat" && !thumb) thumb = thumbnail(o.file, cfg.outputDir);
      const share = C.shareDir(cfg);
      if (share) for (const o of outputs.filter((x) => x.preset === "compat")) {
        RO.assertNotOnDrive(share); fs.mkdirSync(share, { recursive: true });
        fs.copyFileSync(o.file, path.join(share, o.name)); log(`  shared copy → ${share}`);
      }
      const rec = outputs.map((o) => ({ name: path.basename(o.file || o.name), preset: o.preset, W: o.W, H: o.H, codec: o.codec, hw: !!o.hw, renderer: o.renderer }));
      S.put(fp, { status: "done", outputs: rec, id: ev.id });
      LIB.setStatus(fp, { status: "done", outputs: rec, thumb, error: null });
      return { ok: true, outputs: rec };
    } catch (e) {
      log("  ✗ failed:", e.message);
      const prev = S.get(fp) || {};
      S.put(fp, { status: "failed", error: e.message, attempts: (prev.attempts || 0) + 1, id: ev.id });
      LIB.setStatus(fp, { status: "failed", error: e.message });
      return { ok: false, error: e.message };
    } finally {
      fs.rmSync(cache, { recursive: true, force: true }); // decrypted copies are temporary
    }
  }
}
const CRhex = (b64) => Buffer.from(b64, "base64").toString("hex");

module.exports = { Pipeline, chunks };
