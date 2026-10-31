// track-ui (tag track-v2): the region tools around tracking, in the real page.
//   1. zoom: a box drawn while the camera is zoomed in lands where it was drawn on the PICTURE (same size and place after zooming out)
//   2. lanes: one colour-coded bar per region under the timeline; dragging its end trims the region; "Whole clip" in the list undoes it
//   3. the list marks a tracked region with a Tracking badge and its timeline colour
//   4. Highlight: a region that outlines the object (box / circle / outline, a colour) and hides nothing, in the viewer
//   5. hand-off: the tracked sign drives out of the FRONT camera on the right; the next camera (right pillar) is searched with the detector
//      (stubbed here: a "car" near its left edge), the video pauses with "Is this it?", Yes makes a linked, tracking region there
//   6. hand-off with no detector: "Draw it myself" → the region drawn on the right pillar is linked to the first one
// Footage: /tmp/track-footage-ho = tools/make-track-footage.py --exit plus a right_pillar file (a copy of the front one).
// Usage: node test/track-ui.js [url]
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const URL0 = process.argv[2] || "http://127.0.0.1:8771/index.html";
const FIX = process.env.FIX || "/tmp/track-footage-ho";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 600) : "")); if (!c) fails++; };
if (!fs.existsSync(FIX + "/track-truth.json")) {
  execFileSync("python3", [path.join(__dirname, "../tools/make-track-footage.py"), FIX, "--exit"], { stdio: "inherit" });
}
{ const d = path.join(FIX, "TeslaCam/SavedClips", fs.readdirSync(path.join(FIX, "TeslaCam/SavedClips"))[0]), f = fs.readdirSync(d).find((x) => x.endsWith("-front.mp4")), rp = path.join(d, f.replace("-front.mp4", "-right_pillar.mp4")); if (!fs.existsSync(rp)) fs.copyFileSync(path.join(d, f), rp); }
const TRUTH = JSON.parse(fs.readFileSync(FIX + "/track-truth.json", "utf8"));

async function open(b, det) {
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage(), errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(URL0 + (URL0.includes("?") ? "&" : "?") + "nosw=1", { waitUntil: "load" });
  await p.evaluate(() => { localStorage.setItem("tdc.detect.v1", JSON.stringify({ enabled: false })); localStorage.removeItem("tdc.prefs.v1"); localStorage.removeItem("tdc.regions.v1"); localStorage.removeItem("tdc.regions.handoff"); localStorage.setItem("tdc.prefs.v1", JSON.stringify({ advanced: true })); });
  await p.reload({ waitUntil: "load" });
  await p.setInputFiles("#folderInput", FIX + "/TeslaCam");
  for (let i = 0; i < 120 && (await p.evaluate(() => TDC.library.events.length)) < 1; i++) await W(250);
  await p.evaluate(() => [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()));
  await p.evaluate(() => TDC.ui.activate(TDC.library.events[0])); await W(1500);
  await p.evaluate(() => { TDC.player.pause(); TDC.setPref("mapTiles", false); TDC.setPref("layout", "current"); if (!TDC.prefs.advanced) TDC.setPref("advanced", true); });
  for (let i = 0; i < 60 && !(await p.evaluate(() => { const t = TDC.player.tiles.front; const v = t && t.vids && t.vids[TDC.player.active]; return v && v.videoWidth; })); i++) await W(150);
  if (det) await p.evaluate(() => {   // the detector, stubbed: a car near the left edge of the right pillar's picture; nothing elsewhere
    const D = TDC.detect; D.enabled = () => true;
    D.detectImage = async (img, iw, ih, o) => (o && o.cam === "right_pillar" ? [{ x: 0.06, y: 0.42, w: 0.12, h: 0.1, label: "car", conf: 0.9 }] : []);
  });
  return { p, errs };
}
async function drag(p, cam, x0, y0, x1, y1, raw) {   // raw 0..1 of the picture → screen (through the current zoom), or screen px when raw = false
  const pts = raw === false ? [[x0, y0], [x1, y1]] : await p.evaluate(([cam, a, b, c, d]) => { const f = TDC.regions.screenFit(cam); return [TDC.regions.toScreen(f, a, b), TDC.regions.toScreen(f, c, d)]; }, [cam, x0, y0, x1, y1]);
  await p.mouse.move(pts[0][0], pts[0][1]); await p.mouse.down(); await p.mouse.move((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2, { steps: 4 }); await p.mouse.move(pts[1][0], pts[1][1], { steps: 4 }); await p.mouse.up(); await W(250);
}

(async () => {
  const pw = require("playwright");
  const b = await pw.chromium.launch({ args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  // ── 1-4 ──
  {
    const { p, errs } = await open(b, false);
    await p.evaluate(() => { TDC.focus.focus("front"); }); await W(600);
    // 1. zoom 2× round a point right of centre, then draw a box with the normal drawing (not Track)
    const want = { x: 0.52, y: 0.40, w: 0.10, h: 0.08 };
    const scr = await p.evaluate((wt) => {
      const tile = TDC.player.tiles.front.tile, tr = tile.getBoundingClientRect(), F = TDC.focus;
      const f0 = TDC.regions.screenFit("front");   // unzoomed
      F.zoomTo(2, 120, 40);
      const cx = tr.left + tile.clientWidth / 2, cy = tr.top + tile.clientHeight / 2, z = F.z;
      const S = (u, v) => [cx + F.x + (f0.x + u * f0.w - cx) * z, cy + F.y + (f0.y + v * f0.h - cy) * z];   // where that point of the picture is on screen, zoomed (independent of screenFit)
      return { a: S(wt.x, wt.y), b: S(wt.x + wt.w, wt.y + wt.h), z };
    }, want);
    await p.evaluate(() => TDC.regions.UI.draw()); await W(300);
    await drag(p, "front", scr.a[0], scr.a[1], scr.b[0], scr.b[1], false);
    await p.evaluate(() => TDC.regions.UI.done()); await W(300);
    await p.evaluate(() => TDC.focus.resetZoom()); await W(200);
    const r1 = await p.evaluate(() => TDC.regions.list[0] && { x: TDC.regions.list[0].x, y: TDC.regions.list[0].y, w: TDC.regions.list[0].w, h: TDC.regions.list[0].h });
    ok("zoomed in 2×: the box drawn lands on the same part of the picture (within 0.006)", r1 && ["x", "y", "w", "h"].every((k) => Math.abs(r1[k] - want[k]) < 0.006), { r1, want, z: scr.z });
    // 2. lanes
    const ln = await p.evaluate(() => { const el = document.getElementById("crLanes"); return el && !el.hidden && el.getBoundingClientRect().height; });
    ok("a colour-coded lane under the timeline for the region", ln > 6, ln);
    const tg = await p.evaluate(() => TDC.ui.tlGeom()), lr = await p.evaluate(() => { const r = document.getElementById("crLanesCanvas").getBoundingClientRect(); return { top: r.top }; });
    const dur = await p.evaluate(() => TDC.player.ev.duration); tg.x = (t) => tg.left + ((t - tg.v0) / tg.span) * tg.w;
    await p.mouse.move(tg.x(dur) - 3, lr.top + 3 + 5); await p.mouse.down(); await p.mouse.move(tg.x(3) , lr.top + 8, { steps: 6 }); await p.mouse.up(); await W(300);
    const e1 = await p.evaluate(() => TDC.regions.list[0].end);
    ok("dragging the bar's right end to 3 s ends the region at 3 s", e1 != null && Math.abs(e1 - 3) < 0.15, e1);
    const vis = await p.evaluate(async () => { TDC.player.seek(4); await new Promise((r) => setTimeout(r, 300)); return TDC.regions.at("front", TDC.player.time).length; });
    ok("after its end it is not drawn", vis === 0, vis);
    await p.evaluate(() => { const li = document.querySelector("#crList li"); li.querySelector('[data-act="time"]').click(); });
    await p.evaluate(() => { const c = document.querySelector('#crList input[data-act="whole"]'); c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true })); });
    const e2 = await p.evaluate(() => [TDC.regions.list[0].start, TDC.regions.list[0].end]);
    ok("Whole clip in the list puts it back on for the whole clip", e2[0] == null && e2[1] == null, e2);
    await p.evaluate(() => { const li = document.querySelector("#crList li"); if (!li.querySelector(".cr-when-ed")) li.querySelector('[data-act="time"]').click(); const c = li.querySelector('input[data-act="whole"]'); c.checked = false; c.dispatchEvent(new Event("change", { bubbles: true })); });
    await p.evaluate(() => { const li = document.querySelector("#crList li"); li.querySelector('input[data-k="start"]').value = "0:01.5"; li.querySelector('input[data-k="end"]').value = "0:04"; li.querySelector('[data-act="tapply"]').click(); });
    const e3 = await p.evaluate(() => [TDC.regions.list[0].start, TDC.regions.list[0].end]);
    ok("typed From / To in the list set its time range", Math.abs(e3[0] - 1.5) < 0.01 && Math.abs(e3[1] - 4) < 0.01, e3);
    // 3. tracking badge (Track on a second region round the sign)
    await p.evaluate(() => TDC.player.seek(0)); await W(500);
    const t0 = TRUTH.frames[0], pad = 0.012;
    await p.evaluate(() => TDC.regions.UI.track(true));
    await drag(p, "front", t0.x - pad, t0.y - pad, t0.x + t0.w + pad, t0.y + t0.h + pad);
    await p.evaluate(() => TDC.regions.UI.track(false));
    // (Track also picks up the region drawn just before, when it isn't tracked yet: so both follow; untrack the first to see a plain one)
    await p.evaluate(() => { const r = TDC.regions.list[0]; delete r.path; TDC.regions.ui.trackIds = TDC.regions.ui.trackIds.filter((x) => x !== r.id); TDC.regions.UI.sync(); });
    const bd = await p.evaluate(() => [...document.querySelectorAll("#crList li")].map((li) => ({ trk: !!li.querySelector(".cr-badge.trk"), lane: li.style.getPropertyValue("--lane") })));
    ok("the tracked region has a Tracking badge, the plain one none", bd.length === 2 && !bd[0].trk && bd[1].trk, bd);
    ok("each region has its own lane colour", bd.length === 2 && bd[0].lane && bd[1].lane && bd[0].lane !== bd[1].lane, bd);
    // 4. Highlight: a circle in red; the middle of the picture under it is NOT blurred, its edge is drawn
    await p.evaluate(() => { TDC.regions.clear(); TDC.regions.UI.setMode("mark"); TDC.regions.UI.setMark("ring", "#ff3b30"); TDC.regions.UI.draw(); }); await W(300);
    await drag(p, "front", 0.30, 0.30, 0.50, 0.55);
    await p.evaluate(() => TDC.regions.UI.done()); await W(400);
    const hl = await p.evaluate(() => {
      const r = TDC.regions.list[0], tile = TDC.player.tiles.front.tile, cv = tile.querySelector(".redact-layer"), dpr = cv.width / tile.clientWidth, f = TDC.regions.screenFit("front"), tr = tile.getBoundingClientRect();
      const px = (u, v) => { const [x, y] = TDC.regions.toScreen(f, u, v); return cv.getContext("2d").getImageData(Math.round((x - tr.left) * dpr), Math.round((y - tr.top) * dpr), 1, 1).data; };
      const mid = px(r.x + r.w / 2, r.y + r.h / 2), ring = px(r.x + r.w / 2, Math.max(0, r.y - r.h * 0.06));
      return { mode: r.mode, mk: r.mk, mc: r.mc, midA: mid[3], ring: [...ring] };
    });
    ok("Highlight region saved as a red circle", hl.mode === "mark" && hl.mk === "ring" && hl.mc === "#ff3b30", hl);
    ok("Highlight hides nothing (the middle of the layer is clear)", hl.midA === 0, hl);
    ok("Highlight draws its ring in red", hl.ring[3] > 200 && hl.ring[0] > 180 && hl.ring[1] < 120, hl);
    ok("no page errors (1-4)", !errs.length, errs);
    await p.context().close();
  }
  // ── 5. hand-off with the (stubbed) detector ──
  {
    const { p, errs } = await open(b, true);
    await p.evaluate(() => { TDC.focus.focus("front"); TDC.player.seek(0); }); await W(800);
    const t0 = TRUTH.frames[0], pad = 0.012;
    await p.evaluate(() => TDC.regions.UI.track(true));
    await drag(p, "front", t0.x - pad, t0.y - pad, t0.x + t0.w + pad, t0.y + t0.h + pad);
    await p.evaluate(() => { TDC.regions.UI.track(false); TDC.player.play(); });
    let asked = null;
    for (let i = 0; i < 60 && !asked; i++) { await W(150); asked = await p.evaluate(() => { const c = document.getElementById("crHo"); return c && !c.hidden ? { text: document.getElementById("crHoText").textContent, playing: TDC.player.playing, t: TDC.player.time, box: !!document.querySelector(".tile .cr-ho-box"), focus: TDC.focus.cam } : null; }); }
    ok("after it leaves the front camera on the right, the app asks about the right pillar", asked && /Right/i.test(asked.text) && /pillar|side/i.test(asked.text), asked);
    await W(1400); if (asked) asked.box = await p.evaluate(() => !!document.querySelector(".tile .cr-ho-box"));
    ok("the video pauses for the question, with a purple box on the candidate", asked && !asked.playing && asked.box, asked);
    ok("it asked only once the sign was mostly out of the picture (t > 1.85 s)", asked && asked.t > 1.85, asked);
    await p.evaluate(() => document.getElementById("crHoYes").click()); await W(600);
    const made = await p.evaluate(() => { const L = TDC.regions.list; return L.map((r) => ({ cam: r.cam, link: r.link, ci: r.ci, start: r.start, mode: r.mode })); });
    ok("Yes: a second region on the right pillar, linked to the first, same colour", made.length === 2 && made[1].cam === "right_pillar" && made[0].link && made[0].link === made[1].link && made[0].ci === made[1].ci, made);
    ok("it starts at the hand-off time", made.length === 2 && made[1].start != null && Math.abs(made[1].start - asked.t) < 0.6, { made, asked });
    const keys = await p.evaluate(() => { const r = TDC.regions.list[0]; const n0 = r.path.length / 5; TDC.regions.setTimes(r.id, 0, 6); TDC.regions.update(r.id, { on: false }); TDC.regions.update(r.id, { on: true }); return [n0, TDC.regions.list[0].path.length / 5]; });
    ok("the first region keeps its tracked path (hand-off, then a time range and off / on)", keys[0] >= 5 && keys[1] === keys[0], keys);
    await p.evaluate(() => TDC.regions.setTimes(TDC.regions.list[0].id, null, null));
    const lb = await p.evaluate(() => [...document.querySelectorAll("#crList li")].map((li) => ({ trk: !!li.querySelector(".cr-badge.trk"), lnk: (li.querySelector(".cr-badge.lnk") || {}).textContent || "" })));
    ok("the list shows both as tracking and linked (1/2, 2/2)", lb.length === 2 && lb.every((x) => x.trk) && lb[0].lnk === "1/2" && lb[1].lnk === "2/2", lb);
    const play = await p.evaluate(async () => { await new Promise((r) => setTimeout(r, 700)); return TDC.player.playing; });
    ok("playback goes on after Yes", play, play);
    ok("no page errors (5)", !errs.length, errs);
    await p.context().close();
  }
  // ── 6. hand-off with no detector: Draw it myself ──
  {
    const { p, errs } = await open(b, false);
    await p.evaluate(() => { TDC.focus.focus("front"); TDC.player.seek(0); }); await W(800);
    const t0 = TRUTH.frames[0], pad = 0.012;
    await p.evaluate(() => TDC.regions.UI.track(true));
    await drag(p, "front", t0.x - pad, t0.y - pad, t0.x + t0.w + pad, t0.y + t0.h + pad);
    await p.evaluate(() => { TDC.regions.UI.track(false); TDC.player.play(); });
    let asked = null;
    for (let i = 0; i < 60 && !asked; i++) { await W(150); asked = await p.evaluate(() => { const c = document.getElementById("crHo"); return c && !c.hidden ? { text: document.getElementById("crHoText").textContent, yes: !document.getElementById("crHoYes").hidden, playing: TDC.player.playing } : null; }); }
    ok("no detector: it asks you to point it out (no Yes button)", asked && !asked.yes && /Draw it myself/.test(asked.text) && !asked.playing, asked);
    await p.evaluate(() => document.getElementById("crHoDraw").click()); await W(700);
    const cam = await p.evaluate(() => TDC.focus.cam);
    ok("Draw it myself shows the right pillar", cam === "right_pillar", cam);
    await drag(p, "right_pillar", 0.05, 0.40, 0.20, 0.55);
    await W(300);
    const made = await p.evaluate(() => TDC.regions.list.map((r) => ({ cam: r.cam, link: r.link, ci: r.ci, start: r.start, tracked: !!r.path })));
    ok("the region you drew there is tracking, linked to the first, same colour", made.length === 2 && made[1].cam === "right_pillar" && made[1].tracked && made[0].link && made[0].link === made[1].link && made[0].ci === made[1].ci, made);
    ok("no page errors (6)", !errs.length, errs);
    await p.context().close();
  }
  await b.close();
  console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
