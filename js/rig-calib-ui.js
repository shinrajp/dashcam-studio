/* rig-calib-ui.js — Settings ▸ Advanced & Labs ▸ Camera calibration: pick the car's model (a starting point), measure the car's
 * own cameras from the drive that is open (js/rig-calib.js in a worker), keep the result per car, export / import it.
 *
 * Storage: localStorage "tdc.rig.v1" = { active: "preset:<id>" | "car:<id>", cars: { <id>: { name, date, preset, quality,
 * rig: { cams, body, preset } } } }. The active rig is applied with T.rig.set() as soon as this file loads (before anything
 * places objects on the road). Nothing here touches the videos; the worker reads the files' own bytes and telemetry.
 * T.rigCal = { start, cancel, save, discard, use, forget, exportJSON, importJSON, state, result, store }. */
(function () {
  "use strict";
  const T = (window.TDC = window.TDC || {});
  const KEY = "tdc.rig.v1", CAMS = ["front", "left_pillar", "right_pillar", "left_repeater", "right_repeater", "back"];
  const NAME = { front: "Front", back: "Rear", left_pillar: "Left pillar", right_pillar: "Right pillar", left_repeater: "Left repeater", right_repeater: "Right repeater" };
  const $ = (id) => document.getElementById(id);
  const S = { state: "idle", worker: null, result: null, cancelled: false, msg: "" };

  // ── storage ──
  function load() { try { const v = JSON.parse(localStorage.getItem(KEY) || "null"); if (v && typeof v === "object" && v.cars && typeof v.cars === "object") return v; } catch (_) {} return { active: "preset:model_x", cars: {} }; }
  function store(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); return true; } catch (_) { return false; } }
  /** Apply what is stored as active (or a given key). Returns a short description. */
  function apply(key) {
    const RG = T.rig; if (!RG) return null;
    const v = load(), k = key || v.active || "preset:model_x";
    RG.reset();
    if (k.startsWith("car:")) { const c = v.cars[k.slice(4)]; if (c && c.rig) { RG.set(Object.assign({}, c.rig, { source: "calibrated", name: c.name })); return k; } }
    else if (k.startsWith("preset:")) { const id = k.slice(7); if (id !== "model_x" && RG.PRESETS[id]) RG.set(RG.preset(id)); return "preset:" + (RG.PRESETS[id] ? id : "model_x"); }
    return "preset:model_x";
  }
  function use(key) { const v = load(); v.active = apply(key); store(v); render(); }
  const startPreset = () => { const v = load(), k = v.active || ""; if (k.startsWith("preset:")) return k.slice(7); const c = v.cars[k.slice(4)]; return (c && c.preset) || "model_x"; };

  // ── the drive: which clip, its telemetry ──
  const rowsOf = (r) => (r || []).map(([t, m]) => [t, +m.speed || 0, +m.heading || 0]);
  async function clipRows(clip, cam) {
    const e = clip && clip.files && clip.files[cam]; if (!e || !e.blob || !e.info) return null;
    const r = await T.sei.parseClip(T.blobReader(e.blob), e.info, { yieldFn: T.yieldNow, cancelled: () => S.cancelled });
    return r && r.rows.length ? rowsOf(r.rows) : null;
  }
  /** The clip of the open event best for calibrating: the current one if it has a real turn, else the one (of up to 12 near it) with the biggest. */
  async function pickClip(ev) {
    const P = T.player, cur = P && P.clipIndexAt ? P.clipIndexAt(P.time) : 0, C = T.rigCalib, order = [cur];
    for (let d = 1; order.length < Math.min(12, ev.clips.length); d++) { if (cur + d < ev.clips.length) order.push(cur + d); if (cur - d >= 0 && order.length < 12) order.push(cur - d); if (d > ev.clips.length) break; }
    let best = null;
    for (let n = 0; n < order.length; n++) {
      if (S.cancelled) return null;
      const i = order[n]; progress("Reading the drive's telemetry" + (order.length > 1 ? " (clip " + (n + 1) + " of " + order.length + ")" : "") + "…", 0.02 * n / order.length);
      const cam = ["front", "back", "left_pillar"].find((c) => ev.clips[i].files && ev.clips[i].files[c] && ev.clips[i].files[c].blob);
      const rows = cam && await clipRows(ev.clips[i], cam); if (!rows) continue;
      const st = C.driveStats(rows), score = Math.min(st.bestTurnDeg, 90) + Math.min(st.movingS, 60) / 3;
      if (!best || score > best.score) best = { i, st, score };
      if (n === 0 && st.bestTurnDeg >= 45 && st.movingS >= 25) break;
    }
    return best;
  }

  // ── run ──
  function progress(text, frac) {
    S.msg = text; const t = $("rigRunText"), b = $("rigBar");
    if (t) t.textContent = text; if (b && frac != null) b.style.width = Math.round(100 * Math.max(0, Math.min(1, frac))) + "%";
  }
  function fail(text) { S.state = "failed"; S.msg = text; stopWorker(); render(); }
  function stopWorker() { if (S.worker) { try { S.worker.terminate(); } catch (_) {} S.worker = null; } }
  function cancel() { S.cancelled = true; stopWorker(); S.state = "idle"; S.msg = "Calibration cancelled."; render(); }

  async function start() {
    if (S.state === "running") return;
    const P = T.player, ev = P && P.ev, RG = T.rig, C = T.rigCalib;
    S.cancelled = false; S.result = null;
    if (!RG || !C || !C.workerSource) return fail("Camera calibration couldn't load. Reload the page.");
    if (!ev || !ev.clips || !ev.clips.length) return fail("Open a drive first, then calibrate from it.");
    if (typeof Worker === "undefined") return fail("This browser can't run background work (Web Workers).");
    if (typeof VideoDecoder === "undefined") return fail("This browser can't decode video in the background (WebCodecs). Use a current Chrome, Edge or Safari" + (window.isSecureContext ? "" : ", and open the app over https or localhost") + ".");
    const clip0 = ev.clips[0], anyInfo = CAMS.map((c) => clip0.files && clip0.files[c] && clip0.files[c].info).find(Boolean);
    if (anyInfo && !RG.ok("left_pillar", anyInfo.width, anyInfo.height)) return fail("This car records " + anyInfo.width + "×" + anyInfo.height + " pictures (HW3). Calibration works on HW4 cars (1448×938) for now; this drive keeps the direction-only guess.");
    S.state = "running"; render();
    progress("Reading the drive's telemetry…", 0);
    let pick; try { pick = await pickClip(ev); } catch (e) { return fail("Couldn't read the drive's telemetry: " + ((e && e.message) || e)); }
    if (S.cancelled) return;
    if (!pick) return fail("This drive has no telemetry in its files (older firmware, or still locked). Calibration needs the speed and heading the car records.");
    if (pick.st.movingS < 20) return fail("The car hardly moved in this drive (" + Math.round(pick.st.movingS) + " s of driving). Calibrate from a drive of a minute or more.");
    if (pick.st.bestTurnDeg < 30) return fail("This drive has no real turn (the biggest in 15 s was " + Math.round(pick.st.bestTurnDeg) + "°). Calibrate from a drive with at least one corner or roundabout: driving straight can't tell a wide lens from a narrow one.");
    const clip = ev.clips[pick.i], cams = CAMS.filter((c) => clip.files && clip.files[c] && clip.files[c].blob && clip.files[c].info);
    if (!cams.length) return fail("The clips of this drive are still locked. Unlock them first.");
    const pre = startPreset(), base = RG.preset(pre), out = { clip: pick.i, stats: pick.st, preset: pre, cams: {}, date: new Date().toISOString() };
    let w;
    try { w = new Worker(URL.createObjectURL(new Blob([C.workerSource(RG.factory, C.factory)], { type: "text/javascript" }))); }
    catch (e) { return fail("Couldn't start the calibration in the background: " + ((e && e.message) || e)); }
    S.worker = w;
    for (let n = 0; n < cams.length; n++) {
      const cam = cams[n];
      if (S.cancelled) return;
      progress(NAME[cam] + ": reading its telemetry…", n / cams.length);
      const rows = await clipRows(clip, cam);
      if (S.cancelled) return;
      if (!rows || rows.length < 30) { out.cams[cam] = { ok: false, judge: { pass: false, why: "no telemetry in this camera's file" } }; continue; }
      const e = clip.files[cam];
      const res = await new Promise((resolve) => {
        w.onmessage = (m) => {
          const d = m.data || {};
          if (d.cam !== cam) return;
          if (d.type === "progress") progress(NAME[cam] + (d.stage === "fit" ? ": fitting lens and angles…" : ": following points · " + Math.round(100 * d.done / Math.max(1, d.total)) + " %") + "  (" + (n + 1) + " of " + cams.length + ")", (n + (d.stage === "fit" ? 0.85 : 0.85 * d.done / Math.max(1, d.total))) / cams.length);
          else if (d.type === "result") resolve(d.result);
          else if (d.type === "error") resolve({ ok: false, error: d.message, judge: { pass: false, why: /no-webcodecs/.test(d.message) ? "this browser can't decode video in the background" : "couldn't read the video (" + d.message + ")" } });
        };
        w.onerror = (ev2) => { try { ev2.preventDefault(); } catch (_) {} resolve({ ok: false, judge: { pass: false, why: "the browser stopped the background work (" + ((ev2 && ev2.message) || "out of memory?") + ")" } }); };
        w.postMessage({ type: "cam", cam, blob: e.blob, info: e.info, rows, start: base.cams[cam], body: base.body });
      });
      if (S.cancelled) return;
      out.cams[cam] = res;
      if (!S.worker) return;   // (stopped)
    }
    stopWorker();
    finish(out);
  }

  /** Put the six results together: which pass, the preset it looks like, the rig to save. */
  function finish(out) {
    const RG = T.rig, heights = {}, pass = [];
    for (const cam of Object.keys(out.cams)) { const r = out.cams[cam]; if (r && r.judge && r.judge.pass) { pass.push(cam); if (r.road && r.road.height > 0) heights[cam] = r.road.height; } }
    out.pass = pass;
    out.looks = RG.closestPreset(heights);
    const m = out.looks[0] && out.looks[0].rms < 0.12 ? out.looks[0].id : out.preset;
    out.matched = m;
    const px = pass.map((c) => out.cams[c].fit.median_px).sort((a, b) => a - b);
    out.quality = px.length ? px[px.length >> 1] : null;
    // the rig to save: measured cameras where they passed (angles, lens, delay, height), the matched model's positions along
    // and across the car and its body; the cameras that didn't pass keep the starting values
    const P = RG.preset(m), rig = { preset: m, cams: {}, body: P.body };
    for (const cam of RG.CAMS) {
      const r = out.cams[cam], p = P.cams[cam];
      if (r && r.judge && r.judge.pass) rig.cams[cam] = { yaw: r.yaw, pitch: r.pitch, roll: r.roll, f: r.f, cx: r.cx, cy: r.cy, k: r.k, thmax: Math.max(r.thmax, 10), delay: r.delay,
        pos: [p.pos[0], r.road && r.road.height > 0.3 ? r.road.height : p.pos[1], p.pos[2]], px: r.fit.median_px, measured: true };
      else rig.cams[cam] = Object.assign({}, RG.preset(out.preset).cams[cam], { pos: p.pos.slice(), measured: false });
    }
    out.rig = rig;
    out.savable = pass.length > 0;
    S.result = out; S.state = "done"; S.msg = "";
    render();
  }

  function save(name) {
    const out = S.result; if (!out || !out.savable) return false;
    const v = load(), id = Date.now().toString(36);
    v.cars[id] = { name: (name || "").trim().slice(0, 40) || "My " + T.rig.PRESETS[out.matched].name, date: out.date, preset: out.matched, quality: out.quality, cams: out.pass, rig: out.rig };
    v.active = "car:" + id; store(v); apply(v.active);
    S.result = null; S.state = "idle"; S.msg = "Saved. The hand-off and the car view now use these cameras.";
    render(); return id;
  }
  function discard() { S.result = null; S.state = "idle"; S.msg = ""; render(); }
  function forget(key) { const v = load(), id = (key || v.active || "").replace(/^car:/, ""); if (!v.cars[id]) return; delete v.cars[id]; if (v.active === "car:" + id) v.active = "preset:" + (startPreset() || "model_x"); store(v); apply(v.active); render(); }

  // ── export / import ──
  function exportJSON() {
    const v = load(), k = v.active || "preset:model_x", RG = T.rig;
    let o;
    if (k.startsWith("car:") && v.cars[k.slice(4)]) { const c = v.cars[k.slice(4)]; o = { name: c.name, date: c.date, preset: c.preset, source: "calibrated", quality_px: c.quality, cams: c.rig.cams, body: c.rig.body }; }
    else { const id = k.slice(7) || "model_x", p = RG.preset(RG.PRESETS[id] ? id : "model_x"); o = { name: RG.PRESETS[p.preset].name + (RG.PRESETS[p.preset].measured ? " (measured)" : " (estimated)"), preset: p.preset, source: "preset", cams: p.cams, body: p.body }; }
    return Object.assign({ format: "dashcam-studio-rig", version: 1 }, o);
  }
  function importJSON(j) {
    const RG = T.rig; if (!j || typeof j !== "object") throw new Error("That file isn't a camera rig.");
    const src = j.cams || j; const probe = RG.CAMS.filter((c) => src[c] && ["yaw", "pitch", "roll", "f", "cx", "cy"].every((k) => isFinite(+src[c][k])) && Array.isArray(src[c].k));
    if (!probe.length) throw new Error("That file has no cameras in it (it needs yaw, pitch, roll, f, cx, cy and k for at least one camera).");
    const pre = RG.PRESETS[j.preset] ? j.preset : "model_x", base = RG.preset(pre), cams = {};
    for (const c of RG.CAMS) cams[c] = src[c] ? Object.assign({}, base.cams[c], src[c]) : base.cams[c];
    const v = load(), id = Date.now().toString(36);
    v.cars[id] = { name: String(j.name || "Imported rig").slice(0, 40), date: j.date || new Date().toISOString(), preset: pre, quality: isFinite(+j.quality_px) ? +j.quality_px : null, cams: probe, rig: { preset: pre, cams, body: Array.isArray(j.body) ? j.body : base.body } };
    v.active = "car:" + id; store(v); apply(v.active); render(); return id;
  }

  // ── Settings section ──
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const day = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); } catch (_) { return ""; } };
  function build() {
    const body = document.querySelector("#settings .drawer-body"); if (!body || $("rigSec")) return;
    const sec = document.createElement("section"); sec.id = "rigSec";
    sec.innerHTML = '<h3>Camera calibration</h3>' +
      '<p class="hint">Where each camera points, its lens and how high it sits. Following an object from camera to camera uses this to place it on the road round the car. Measured on a 2024 Model X; other models start from an estimate, and you can measure your own car from one of its drives.</p>' +
      '<div class="row"><span>Car</span><select class="select" id="rigPick" aria-label="Camera set"></select></div>' +
      '<p class="hint" id="rigStatus" role="status"></p>' +
      '<button type="button" class="btn ghost wide" id="rigCalibrate">Calibrate from this drive</button>' +
      '<div class="progress" id="rigRun" hidden><div class="bar"><div class="fill" id="rigBar"></div></div><div class="progress-text" id="rigRunText" aria-live="polite"></div><button type="button" class="btn ghost wide" id="rigCancel">Cancel</button></div>' +
      '<div id="rigResult" hidden></div>' +
      '<p class="hint">Needs a drive of a minute or more with at least one real turn. It runs in the background (about a minute per camera) while you keep watching.</p>' +
      '<button type="button" class="btn ghost wide" id="rigExport">Export camera set…</button>' +
      '<button type="button" class="btn ghost wide" id="rigImport">Import camera set…</button>' +
      '<button type="button" class="btn ghost wide" id="rigForget" hidden>Forget this car\'s calibration</button>' +
      '<button type="button" class="btn ghost wide" id="rigReset">Reset to measured (Model X)</button>' +
      '<input type="file" id="rigFile" accept=".json,application/json" hidden>';
    const reset = [...body.children].find((s) => s.tagName === "SECTION" && s.querySelector("#btnResetAll"));
    body.insertBefore(sec, reset || null);
    $("rigPick").addEventListener("change", (e) => use(e.target.value));
    $("rigCalibrate").addEventListener("click", () => { start(); });
    $("rigCancel").addEventListener("click", cancel);
    $("rigReset").addEventListener("click", () => use("preset:model_x"));
    $("rigForget").addEventListener("click", () => { const v = load(), c = v.cars[(v.active || "").slice(4)]; if (c && confirm("Forget the calibration “" + c.name + "”?")) forget(v.active); });
    $("rigExport").addEventListener("click", () => {
      const j = exportJSON(), a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(j, null, 1)], { type: "application/json" }));
      a.download = "camera-rig-" + String(j.name || "car").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".json";
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    });
    $("rigImport").addEventListener("click", () => $("rigFile").click());
    $("rigFile").addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f) return;
      try { importJSON(JSON.parse(await f.text())); S.msg = "Imported “" + f.name + "”."; } catch (err) { S.msg = (err && err.message) || "That file isn't a camera rig."; }
      render();
    });
    render();
  }
  function render() {
    const pick = $("rigPick"); if (!pick) return;
    const RG = T.rig, v = load(), act = v.active || "preset:model_x";
    const cars = Object.entries(v.cars).sort((a, b) => String(b[1].date).localeCompare(String(a[1].date)));
    pick.innerHTML = (cars.length ? '<optgroup label="Your cars">' + cars.map(([id, c]) => '<option value="car:' + id + '">' + esc(c.name) + "</option>").join("") + "</optgroup>" : "") +
      '<optgroup label="Starting points">' + Object.keys(RG.PRESETS).map((id) => '<option value="preset:' + id + '">' + esc(RG.PRESETS[id].name) + (RG.PRESETS[id].measured ? " (measured)" : " (estimated)") + "</option>").join("") + "</optgroup>";
    pick.value = act; pick.disabled = S.state === "running";
    const st = $("rigStatus"), car = act.startsWith("car:") ? v.cars[act.slice(4)] : null;
    let txt;
    if (car) txt = "Using your calibration from " + day(car.date) + ": looks like a " + (RG.PRESETS[car.preset] ? RG.PRESETS[car.preset].name : "Tesla") + (car.quality != null ? ", fit error " + car.quality.toFixed(2) + " px" : "") + (car.cams && car.cams.length < 6 ? " (" + car.cams.length + " of 6 cameras measured)" : "") + ".";
    else { const id = act.slice(7); txt = id === "model_x" || !RG.PRESETS[id] ? "Using the cameras measured on a 2024 Model X." : "Using an estimate for a " + RG.PRESETS[id].name + ": positions from its published size, angles from the Model X. Calibrate to measure your car."; }
    st.textContent = txt + (S.msg && S.state !== "running" ? " " + S.msg : "");
    $("rigRun").hidden = S.state !== "running";
    $("rigCalibrate").hidden = S.state === "running" || S.state === "done";
    $("rigForget").hidden = !car;
    const box = $("rigResult"), out = S.result;
    box.hidden = !(S.state === "done" && out);
    if (S.state === "done" && out) {
      const P = RG.PRESETS, rows = RG.CAMS.filter((c) => out.cams[c]).map((c) => {
        const r = out.cams[c], j = r.judge || {};
        return "<li>" + NAME[c] + ": " + (j.pass ? (j.grade === "good" ? "good" : "fair") + ", " + r.fit.median_px.toFixed(2) + " px" + (r.road ? ", " + r.road.height.toFixed(2) + " m above the road" : "") : "kept the starting values: " + esc(j.why || "no result")) + "</li>";
      }).join("");
      const looks = out.looks && out.looks[0], near = out.looks && out.looks[1] && looks && out.looks[1].rms - looks.rms < 0.03 ? " (or a " + P[out.looks[1].id].name + ")" : "";
      box.innerHTML = '<p class="hint"><b>' + (out.savable ? "Measured " + out.pass.length + " of " + Object.keys(out.cams).length + " cameras" + (out.quality != null ? ", fit error " + out.quality.toFixed(2) + " px" : "") + "." : "Not good enough to save.") + "</b> " +
        (looks ? "By the cameras' heights it looks like a " + P[looks.id].name + near + "." : "") + "</p><ul class=\"hint rig-list\">" + rows + "</ul>" +
        (out.savable ? '<div class="row"><span>Name</span><input type="text" id="rigName" maxlength="40" value="' + esc("My " + P[out.matched].name) + '" aria-label="Name for this car"></div><button type="button" class="btn primary wide" id="rigSave">Save for this car</button>'
          : '<p class="hint">Nothing was saved: the cameras keep what they had. Try a longer drive with a turn, in daylight, with the lenses clean.</p>') +
        '<button type="button" class="btn ghost wide" id="rigDiscard">' + (out.savable ? "Discard" : "OK") + "</button>";
      const sv = $("rigSave"); if (sv) sv.addEventListener("click", () => save($("rigName").value));
      $("rigDiscard").addEventListener("click", discard);
    }
  }

  // apply the stored rig now (before the hand-off places anything), then the section once Settings exists
  try { apply(); } catch (e) { console.warn("camera rig: stored calibration not applied", e); }
  T.rigCal = { start, cancel, save, discard, use, forget, exportJSON, importJSON, apply, load, store, get state() { return S.state; }, get result() { return S.result; }, get msg() { return S.msg; } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
