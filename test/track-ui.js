// track-ui (tag track-v2): the region tools round tracking, in the real page (Chromium).
//   A. zoom: a box drawn while zoomed in lands on the same part of the PICTURE
//   B. shapes: Box, Circle, Outline (point by point), Freehand (one stroke, closes on release); Highlight in a picked colour hides nothing
//   C. undo right after saving a box / circle / highlight (still in the drawing tray) takes it away
//   D. a region is pressed and dragged directly while the Redact panel is open (no Move first); Track then follows THAT region (decided later)
//   E. Track drawing: a pill says it is on (also in the six-camera view); turning it off ends the drawing: a click on a camera draws nothing
//   F. the tracking pass: the path is built through the clip without playing; it follows the sign and has no box once it left
//   G. region bars sit in the timeline's empty sections lane (no extra row); dragging a bar's end trims the region; Whole clip in the list
//   H. hand-off with a (stubbed) detector: the sign leaves the FRONT camera on the right; the right pillar is searched; the player goes there
//      and asks "Is this it?"; Yes makes a linked region there, tracked, same colour
//   I. hand-off with no detector: "Draw it myself" → the region drawn on the right pillar is linked and tracked
// Footage: /tmp/track-footage-ho = tools/make-track-footage.py --exit plus a right_pillar file (a copy of the front one).
// Usage: node test/track-ui.js [url]
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL0 = process.argv[2] || "http://127.0.0.1:8771/index.html";
const FIX = process.env.FIX || "/tmp/track-footage-ho";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 700) : "")); if (!c) fails++; };
if (!fs.existsSync(FIX + "/track-truth.json")) execFileSync("python3", [path.join(__dirname, "../tools/make-track-footage.py"), FIX, "--exit"], { stdio: "inherit" });
{ const d = path.join(FIX, "TeslaCam/SavedClips", fs.readdirSync(path.join(FIX, "TeslaCam/SavedClips"))[0]), f = fs.readdirSync(d).find((x) => x.endsWith("-front.mp4")), rp = path.join(d, f.replace("-front.mp4", "-right_pillar.mp4")); if (!fs.existsSync(rp)) fs.copyFileSync(path.join(d, f), rp); }
const TRUTH = JSON.parse(fs.readFileSync(FIX + "/track-truth.json", "utf8"));
const truthAt = (t) => TRUTH.frames[Math.max(0, Math.min(TRUTH.frames.length - 1, Math.round(t * TRUTH.fps)))];

async function open(b, det) {
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage(), errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => { if (/track pass|hand-off/.test(m.text())) errs.push(m.text()); });
  await p.goto(URL0 + (URL0.includes("?") ? "&" : "?") + "nosw=1", { waitUntil: "load" });
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.setItem("tdc.prefs.v1", JSON.stringify({ advanced: true })); });
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => TDC.ui.activate(TDC.library.events[0])); await W(1500);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); TDC.setPref("layout", "current"); if (!TDC.prefs.advanced) TDC.setPref("advanced", true); });
  for (let i = 0; i < 60 && !(await p.evaluate(() => { const t = TDC.player.tiles.front; const v = t && t.vids && t.vids[TDC.player.active]; return v && v.videoWidth; })); i++) await W(150);
  if (det) await p.evaluate(() => {   // the detector, stubbed: a car near the left edge of the right pillar's picture; nothing elsewhere
    const D = TDC.detect; D.enabled = () => true; D.loadFast = async () => null;
    D.detectImage = async (img, iw, ih, o) => (o && o.cam === "right_pillar" ? [{ x: 0.06, y: 0.42, w: 0.12, h: 0.1, label: "car", conf: 0.9 }] : []);
  });
  return { p, errs };
}
const scr = (p, cam, pts) => p.evaluate(([cam, pts]) => { const f = TDC.regions.screenFit(cam); return pts.map((q) => TDC.regions.toScreen(f, q[0], q[1])); }, [cam, pts]);
async function drag(p, cam, x0, y0, x1, y1) {
  const s = await scr(p, cam, [[x0, y0], [x1, y1]]);
  await p.mouse.move(s[0][0], s[0][1]); await p.mouse.down(); await p.mouse.move((s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2, { steps: 4 }); await p.mouse.move(s[1][0], s[1][1], { steps: 4 }); await p.mouse.up(); await W(250);
}
const list = (p) => p.evaluate(() => TDC.regions.list.map((r) => ({ id: r.id, cam: r.cam, shape: r.shape, mode: r.mode, mc: r.mc, x: r.x, y: r.y, w: r.w, h: r.h, start: r.start, end: r.end, ci: r.ci, link: r.link, path: r.path ? r.path.length / 5 : 0 })));

(async () => {
  const pw = require("playwright");
  const b = await pw.chromium.launch({ args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  {
    const { p, errs } = await open(b, false);
    await p.evaluate(() => { TDC.focus.focus("front"); }); await W(600);
    // A. zoom
    const want = { x: 0.52, y: 0.40, w: 0.10, h: 0.08 };
    const z = await p.evaluate((wt) => {
      const tile = TDC.player.tiles.front.tile, tr = tile.getBoundingClientRect(), F = TDC.focus, f0 = TDC.regions.screenFit("front");
      F.zoomTo(2, 120, 40);
      const cx = tr.left + tile.clientWidth / 2, cy = tr.top + tile.clientHeight / 2;
      const S = (u, v) => [cx + F.x + (f0.x + u * f0.w - cx) * F.z, cy + F.y + (f0.y + v * f0.h - cy) * F.z];
      return { a: S(wt.x, wt.y), b: S(wt.x + wt.w, wt.y + wt.h) };
    }, want);
    await p.evaluate(() => TDC.regions.UI.draw()); await W(300);
    await p.mouse.move(...z.a); await p.mouse.down(); await p.mouse.move(...z.b, { steps: 6 }); await p.mouse.up(); await W(250);
    await p.evaluate(() => TDC.regions.UI.done()); await W(300);
    await p.evaluate(() => TDC.focus.resetZoom()); await W(200);
    let L = await list(p);
    ok("A. zoomed in 2×: the box lands on the same part of the picture", L[0] && ["x", "y", "w", "h"].every((k) => Math.abs(L[0][k] - want[k]) < 0.006), { r: L[0], want });
    // B. Circle + Highlight in a picked colour
    await p.evaluate(() => { const U = TDC.regions.UI; U.setShape("circle"); U.setMode("mark"); U.setMark(null, "#ff3b30"); U.draw(); }); await W(300);
    await drag(p, "front", 0.20, 0.55, 0.40, 0.80);
    await p.evaluate(() => TDC.regions.UI.done()); await W(300);
    L = await list(p);
    ok("B. Circle tool + Highlight: an ellipse region, red, Highlight", L[1] && L[1].shape === "ellipse" && L[1].mode === "mark" && L[1].mc === "#ff3b30", L[1]);
    const px = await p.evaluate(() => {
      const r = TDC.regions.list[1], tile = TDC.player.tiles.front.tile, cv = tile.querySelector(".redact-layer"), dpr = cv.width / tile.clientWidth, f = TDC.regions.screenFit("front"), tr = tile.getBoundingClientRect();
      const at = (u, v) => { const [x, y] = TDC.regions.toScreen(f, u, v); return [...cv.getContext("2d").getImageData(Math.round((x - tr.left) * dpr), Math.round((y - tr.top) * dpr), 1, 1).data]; };
      return { mid: at(r.x + r.w / 2, r.y + r.h / 2), top: at(r.x + r.w / 2, r.y + 0.002), corner: at(r.x + 0.01, r.y + 0.01) };
    });
    ok("B. Highlight hides nothing and draws a red ring (not a box: its corner is clear)", px.mid[3] === 0 && px.top[3] > 200 && px.top[0] > 180 && px.top[1] < 120 && px.corner[3] === 0, px);
    // the custom colour picker
    await p.evaluate(() => { const r = TDC.regions.list[1]; TDC.regions.ui.sel = r.id; TDC.regions.UI.move(true); const inp = document.querySelector("#crBarMarkRow input[type=color]"); inp.value = "#00e0ff"; inp.dispatchEvent(new Event("input", { bubbles: true })); TDC.regions.UI.move(false); });
    L = await list(p);
    ok("B. any colour from the picker recolours the selected highlight", L[1].mc === "#00e0ff", L[1]);
    // Outline: point by point, closed by tapping the first point
    await p.evaluate(() => { const U = TDC.regions.UI; U.setMode("blur"); U.setShape("outline"); U.draw(); }); await W(300);
    const op = await scr(p, "front", [[0.60, 0.45], [0.75, 0.47], [0.72, 0.63], [0.58, 0.60], [0.60, 0.45]]);
    for (const q of op) { await p.mouse.click(q[0], q[1]); await W(120); }
    await W(300);
    const od = await p.evaluate(() => ({ draft: TDC.regions.ui.draft && TDC.regions.ui.draft.shape, live: TDC.regions.ui.live && TDC.regions.ui.live.pts.length, msg: document.getElementById("crBarMsg").textContent }));
    await p.evaluate(() => TDC.regions.UI.done()); await W(300); L = await list(p);
    ok("B. Outline: tapped points make a polygon region (closed on the first point)", L.length === 3 && L[2].shape === "poly", { shapes: L.map((r) => r.shape), od });
    // Freehand: one stroke, saved on release (a region appears with Done, the stroke closes by itself)
    await p.evaluate(() => { const U = TDC.regions.UI; U.setShape("free"); U.draw(); }); await W(300);
    const fp = await scr(p, "front", Array.from({ length: 24 }, (_, i) => [0.40 + 0.08 * Math.cos(i / 23 * 2 * Math.PI), 0.55 + 0.08 * Math.sin(i / 23 * 2 * Math.PI)]));
    await p.mouse.move(...fp[0]); await p.mouse.down(); for (const q of fp.slice(1)) await p.mouse.move(q[0], q[1], { steps: 2 }); await p.mouse.up(); await W(300);
    const dr = await p.evaluate(() => (TDC.regions.ui.draft && TDC.regions.ui.draft.shape) || { live: TDC.regions.ui.live && TDC.regions.ui.live.pts.length, tool: TDC.regions.ui.tool, drawing: TDC.regions.ui.drawing, cam: TDC.regions.ui.cam, msg: document.getElementById("crBarMsg").textContent });
    ok("B. Freehand: one stroke closes into a shape on release", dr === "poly", dr);
    await p.evaluate(() => TDC.regions.UI.done()); await W(300);
    // C. undo right after saving (still drawing in the tray)
    await p.evaluate(() => { const U = TDC.regions.UI; U.setShape("rect"); U.setMode("mark"); U.draw(); }); await W(300);
    await drag(p, "front", 0.05, 0.05, 0.12, 0.12);
    const nBefore = (await list(p)).length;
    await p.evaluate(() => TDC.regions.UI.done()); await W(200);
    await p.evaluate(() => TDC.regions.UI.draw()); await W(200);
    const nSaved = (await list(p)).length;
    await p.evaluate(() => TDC.regions.UI.undo()); await W(200);
    const nUndone = (await list(p)).length;
    ok("C. Undo takes away the highlight box just saved, also while the tray is drawing", nSaved === nBefore + 1 && nUndone === nBefore, { nBefore, nSaved, nUndone });
    await p.evaluate(() => TDC.regions.UI.cancel()); await W(200);
    // D. press and drag a region directly (Redact panel open), then Track it
    await p.evaluate(() => { TDC.regions.clear(); TDC.player.seek(0); }); await W(600);
    const t0 = TRUTH.frames[0], pad = 0.012;
    await p.evaluate(() => { const U = TDC.regions.UI; U.setShape("rect"); U.setMode("blur"); U.draw(); }); await W(300);
    await drag(p, "front", t0.x - pad - 0.05, t0.y - pad, t0.x + t0.w + pad - 0.05, t0.y + t0.h + pad);   // drawn a little to the left
    await p.evaluate(() => TDC.regions.UI.done()); await W(300);
    await p.evaluate(() => { if (TDC.searchUI && TDC.searchUI.show) TDC.searchUI.show(false, "redact"); }); await W(400);
    const r0 = (await list(p))[0], c0 = await scr(p, "front", [[r0.x + r0.w / 2, r0.y + r0.h / 2], [r0.x + r0.w / 2 + 0.05, r0.y + r0.h / 2]]);
    await p.mouse.move(...c0[0]); await p.mouse.down(); await p.mouse.move(...c0[1], { steps: 6 }); await p.mouse.up(); await W(300);
    const r1 = (await list(p))[0];
    ok("D. pressing a region and dragging moves it (no Move button needed)", Math.abs(r1.x - (r0.x + 0.05)) < 0.006, { r0: r0.x, r1: r1.x });
    const selOk = await p.evaluate(() => TDC.regions.ui.move && TDC.regions.ui.sel === TDC.regions.list[0].id);
    ok("D. ... and selects it (the tray shows it)", selOk, selOk);
    await p.evaluate(() => TDC.regions.UI.track()); await W(200);
    const trackedNow = await p.evaluate(() => !!TDC.regions.list[0].path);
    ok("D. Track with a region selected follows THAT region (decided after drawing)", trackedNow, trackedNow);
    // F. the pass: path through the clip without playing
    const ps = await p.evaluate(() => TDC.regions.passDone(TDC.regions.list[0].id).then((x) => x && { done: x.done, err: x.err, t: x.t }));
    const path = await p.evaluate(() => TDC.regions.list[0].path);
    const at = (t) => { let k = -1; for (let i = 0; i < path.length; i += 5) if (path[i] <= t + 1e-6) k = i; return k < 0 ? null : path[k + 3] > 0 ? { x: path[k + 1], w: path[k + 3] } : null; };
    const errs1 = [0.5, 1.0, 1.4].map((t) => { const b2 = at(t), T = truthAt(t); return b2 ? Math.abs(b2.x + b2.w / 2 - T.x - T.w / 2) : 9; });
    ok("F. the pass ran to the end of the clip without playing", ps && ps.done && !ps.err, ps);
    ok("F. its path follows the sign (centre within 0.03 at 0.5 / 1.0 / 1.4 s)", errs1.every((e) => e < 0.03), errs1);
    ok("F. no box once the sign has left the picture (3 s)", at(3.0) === null, at(3.0));
    // G. bars in the empty sections lane; trim by dragging an end
    const lane = await p.evaluate(() => { const el = document.getElementById("crLanes"), g = TDC.ui.tlGeom(); return { inLane: el.classList.contains("in-lane"), parent: el.parentNode.id, laneH: g.laneH, h: el.getBoundingClientRect().height, sections: g.sections }; });
    ok("G. region bars sit inside the timeline's empty sections lane (no extra row)", lane.inLane && lane.parent === "timeline" && Math.abs(lane.h - lane.laneH) < 2, lane);
    const tg = await p.evaluate(() => TDC.ui.tlGeom()), cvr = await p.evaluate(() => { const r = document.getElementById("crLanesCanvas").getBoundingClientRect(); return { top: r.top, h: r.height }; });
    const dur = await p.evaluate(() => TDC.player.ev.duration), X = (t) => tg.left + ((t - tg.v0) / tg.span) * tg.w;
    const yb = await p.evaluate(() => { const r = document.getElementById("crLanesCanvas").getBoundingClientRect(); return r.top; });
    const rowY = yb + (await p.evaluate(() => { const g = TDC.ui.tlGeom(); const n = TDC.regions.list.length, lh = g.laneH, bh = Math.max(3, Math.min(10, (lh - 4) / n - 2)), gap = Math.max(1, Math.min(3, (lh - n * bh) / (n + 1))); return gap + bh / 2; }));
    await p.mouse.move(X(dur) - 3, rowY); await p.mouse.down(); await p.mouse.move(X(3), rowY, { steps: 6 }); await p.mouse.up(); await W(300);
    const e1 = (await list(p))[0].end;
    ok("G. dragging the bar's right end to 3 s ends the region at 3 s", e1 != null && Math.abs(e1 - 3) < 0.15, { e1, cvr });
    await p.evaluate(() => TDC.regions.setTimes(TDC.regions.list[0].id, null, null));
    // E. Track drawing pill; Track off ends drawing; a click on a camera then draws nothing
    await p.evaluate(() => { TDC.regions.UI.move(false); TDC.focus.grid && TDC.focus.grid(); }); await W(500);
    await p.evaluate(() => TDC.regions.UI.track(true)); await W(300);
    const pill = await p.evaluate(() => { const e = document.getElementById("crTrackPill"); return !!e && !e.hidden && document.body.classList.contains("cr-track-on"); });
    ok("E. Track drawing on: the pill shows (six-camera view)", pill, pill);
    await p.evaluate(() => document.getElementById("crTrackOff").click()); await W(300);
    const st = await p.evaluate(() => ({ pill: !document.getElementById("crTrackPill").hidden, drawing: TDC.regions.ui.drawing, pick: TDC.regions.ui.pick, track: TDC.regions.ui.track }));
    ok("E. Turn off: the pill goes and drawing ends completely", !st.pill && !st.drawing && !st.pick && !st.track, st);
    const n0 = (await list(p)).length;
    await drag(p, "back", 0.3, 0.3, 0.5, 0.5);
    const n1 = (await list(p)).length, d1 = await p.evaluate(() => !!TDC.regions.ui.draft);
    ok("E. after that, dragging on a camera draws nothing", n1 === n0 && !d1, { n0, n1, d1 });
    ok("no page errors (A-G)", !errs.length, errs);
    await p.context().close();
  }
  // ── H. hand-off with the (stubbed) detector ──
  {
    const { p, errs } = await open(b, true);
    await p.evaluate(() => { TDC.focus.focus("front"); TDC.player.seek(0); }); await W(800);
    const t0 = TRUTH.frames[0], pad = 0.012;
    await p.evaluate(() => TDC.regions.UI.track(true)); await W(300);
    await drag(p, "front", t0.x - pad, t0.y - pad, t0.x + t0.w + pad, t0.y + t0.h + pad);
    await p.evaluate(() => TDC.regions.UI.track(false)); await W(200);
    let asked = null;
    for (let i = 0; i < 120 && !asked; i++) { await W(200); asked = await p.evaluate(() => { const c = document.getElementById("crHo"); return c && !c.hidden ? { text: document.getElementById("crHoText").textContent, t: TDC.player.time, focus: TDC.focus.cam } : null; }); }
    await W(1400); if (asked) asked.box = await p.evaluate(() => !!document.querySelector(".tile .cr-ho-box"));
    ok("H. after the sign leaves the front camera, the app asks about the right pillar (without playing)", asked && /Right/i.test(asked.text), asked);
    ok("H. it shows the moment it was found (t > 1.85 s), on the right pillar, with the purple box", asked && asked.t > 1.85 && asked.focus === "right_pillar" && asked.box, asked);
    await p.evaluate(() => document.getElementById("crHoYes").click()); await W(600);
    const L = await list(p);
    ok("H. Yes: a region on the right pillar, linked, same colour, starting then, tracked", L.length === 2 && L[1].cam === "right_pillar" && L[0].link && L[0].link === L[1].link && L[0].ci === L[1].ci && Math.abs(L[1].start - asked.t) < 0.6 && L[1].path > 0, L);
    const lb = await p.evaluate(() => [...document.querySelectorAll("#crList li")].map((li) => ({ trk: !!li.querySelector(".cr-badge.trk"), lnk: (li.querySelector(".cr-badge.lnk") || {}).textContent || "" })));
    ok("H. the list shows both tracking and linked (1/2, 2/2)", lb.length === 2 && lb.every((x) => x.trk) && lb[0].lnk === "1/2" && lb[1].lnk === "2/2", lb);
    ok("no page errors (H)", !errs.length, errs);
    await p.context().close();
  }
  // ── I. hand-off with no detector: Draw it myself ──
  {
    const { p, errs } = await open(b, false);
    await p.evaluate(() => { TDC.focus.focus("front"); TDC.player.seek(0); }); await W(800);
    const t0 = TRUTH.frames[0], pad = 0.012;
    await p.evaluate(() => TDC.regions.UI.track(true)); await W(300);
    await drag(p, "front", t0.x - pad, t0.y - pad, t0.x + t0.w + pad, t0.y + t0.h + pad);
    await p.evaluate(() => TDC.regions.UI.track(false)); await W(200);
    let asked = null;
    for (let i = 0; i < 120 && !asked; i++) { await W(200); asked = await p.evaluate(() => { const c = document.getElementById("crHo"); return c && !c.hidden ? { text: document.getElementById("crHoText").textContent, yes: !document.getElementById("crHoYes").hidden } : null; }); }
    ok("I. no detector: it asks you to point it out (no Yes button)", asked && !asked.yes && /Draw it myself/.test(asked.text), asked);
    await p.evaluate(() => document.getElementById("crHoDraw").click()); await W(700);
    const cam = await p.evaluate(() => TDC.focus.cam);
    ok("I. Draw it myself shows the right pillar", cam === "right_pillar", cam);
    await drag(p, "right_pillar", 0.05, 0.40, 0.20, 0.55); await W(400);
    const L = await list(p);
    ok("I. the region drawn there is tracked, linked to the first, same colour", L.length === 2 && L[1].cam === "right_pillar" && L[1].path > 0 && L[0].link && L[0].link === L[1].link && L[0].ci === L[1].ci, L);
    const st = await p.evaluate(() => ({ track: TDC.regions.ui.track, pill: !(document.getElementById("crTrackPill") || { hidden: true }).hidden }));
    ok("I. ... and Track drawing ends after it", !st.track && !st.pill, st);
    ok("no page errors (I)", !errs.length, errs);
    await p.context().close();
  }
  await b.close();
  console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
