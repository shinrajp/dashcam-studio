// Time search (tag text-search-fix): type a time in the search box and jump there on every camera.
// Part 1 (node): js/time-search.js parse + resolve on a 3-clip event that starts at 20:51:31.
// Part 2 (Playwright Chromium + WebKit): tools/make-text-footage.py "long" event (three 60 s clips, front + back):
//   20:53:46 · 8:53 pm · 2:30 · +1:05 · -10s · 23:10:00 (outside) · results list "Jump to 20:53:46 (2:15 into the event)",
//   all cameras seeked, clicking a result seeks, no model downloaded, works with text search & redaction turned off.
// Usage: BR=chromium|webkit node test/time-search.js [url]   (BR unset: both)
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const S = require("../js/time-search.js");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html";
const FIX = process.env.TEXT_FIXTURES || "/tmp/text-samples";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined && !c ? "  " + JSON.stringify(x).slice(0, 600) : "")); if (!c) fails++; };

// ── part 1: parsing ──
const base = new Date(2026, 9, 16, 20, 51, 31).getTime();
const ev = { duration: 180, clips: [0, 1, 2].map((k) => ({ start: 60 * k, dur: 60, time: base + 60000 * k })) };
const R = (q, now) => S.resolve(S.parse(q), ev, now || 0);
const first = (q, now) => R(q, now)[0] || {};
ok("20:53:46 → clock time, 2:15 into the event", first("20:53:46").t === 135 && first("20:53:46").label === "Jump to 20:53:46 (2:15 into the event)" && first("20:53:46").inRange);
ok("8:53 pm → 20:53:00 (1:29 in)", first("8:53 pm").t === 89 && first("8:53 pm").inRange);
ok("8:53:46 PM / at 20:53:46 / go to 20:53:46", first("8:53:46 PM").t === 135 && first("at 20:53:46").t === 135 && first("go to 20:53:46").t === 135);
ok("2:30 → position 2:30 (clock shown)", first("2:30").t === 150 && first("2:30").kind === "pos" && /\(20:54:01\)/.test(first("2:30").label));
ok("90s / 1m30s / t=90 → 1:30", first("90s").t === 90 && first("1m30s").t === 90 && first("t=90").t === 90);
ok("+1:05 from 0:30 → 1:35; -10s from 1:00 → 0:50", first("+1:05", 30).t === 95 && first("-10s", 60).t === 50);
ok("+1:05 from 2:50 → past the end: says so, offers the end", first("+1:05", 170).t === 180 && !first("+1:05", 170).inRange && /past the end/.test(first("+1:05", 170).label));
ok("23:10:00 → not in this event (with its span), offers the end", !first("23:10:00").inRange && first("23:10:00").t === 180 && /not in this event \(20:51:31–20:54:31\)/.test(first("23:10:00").label));
ok("20:51 (the event starts at 20:51:31) → the start", first("20:51").t === 0 && first("20:51").inRange);
ok("8:53 with the event in the evening → also offers 20:53 when 8:53 isn't a position", R("8:53").some((r) => r.t === 89 && r.inRange));
ok("not times: hello, 4821, 7ABC123, a red car, 2:75", ["hello", "4821", "7ABC123", "a red car", "2:75", "bus, person"].every((q) => !S.parse(q)));
ok("no clock (file names without a date): positions still work, clock times explain", S.resolve(S.parse("0:05"), { duration: 10, clips: [{ start: 0, dur: 10, time: null }] }, 0)[0].t === 5 && /no clock time/.test(S.resolve(S.parse("8:53 pm"), { duration: 10, clips: [{ start: 0, dur: 10, time: null }] }, 0)[0].label));

// ── part 2: in the app ──
(async () => {
  let pw = null; try { pw = require("playwright"); } catch (_) {}
  if (!pw || process.env.NODE_ONLY) { console.log(fails ? "FAILED " + fails : "ALL PASS (node part only)"); process.exit(fails ? 1 : 0); }
  if (!fs.existsSync(FIX + "/long/TeslaCam")) execFileSync("python3", [path.join(__dirname, "../tools/make-text-footage.py"), FIX], { stdio: "inherit" });
  const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) w(q); else files.push(q); } })(FIX + "/long/TeslaCam");
  for (const BR of (process.env.BR ? [process.env.BR] : ["chromium", "webkit"])) {
    const b = BR === "webkit" ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage();
    const errs = [], nets = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("request", (r) => { if (/huggingface|jsdelivr|onnx/.test(r.url())) nets.push(r.url()); });
    await p.goto(URL_, { waitUntil: "load" }); await p.addStyleTag({ content: ".toast{display:none!important}" });
    await p.setInputFiles("#fileInput", files);
    for (let i = 0; i < 80 && !(await p.evaluate(() => TDC.library.events.length)); i++) await W(250);
    await p.evaluate(() => { [...document.querySelectorAll("button")].filter((x) => /Got it/.test(x.textContent)).forEach((x) => x.click()); return TDC.ui.activate(TDC.library.events[0]); });
    for (let i = 0; i < 40 && !(await p.evaluate(() => TDC.player.ev && TDC.player.ev.duration > 170)); i++) await W(250);
    await p.evaluate(() => TDC.searchUI.show(false));
    const go = async (q) => { await p.evaluate((q) => { document.getElementById("usQuery").value = q; TDC.searchUI.find(q); }, q); await W(1500);
      return p.evaluate(() => { const P = TDC.player, ci = P.clipIndexAt(P.time), clip = P.ev.clips[ci];
        const vids = Object.keys(P.tiles).filter((c) => clip.files[c]).map((c) => { const v = P.tiles[c].vids[P.active]; return { cam: c, local: v.currentTime }; });
        return { t: P.time, clip: ci, local: P.time - clip.start, vids, clock: P.wallClock() ? TDC.fmtClock(P.wallClock()) : null, status: document.getElementById("usStatus").textContent,
          list: [...document.querySelectorAll("#usResults .us-item")].map((b) => b.textContent), classic: [...document.querySelectorAll("#findHits .find-hit")].map((b) => b.textContent) }; }); };
    let r = await go("20:53:46");
    for (let i = 0; i < 16 && !r.vids.every((v) => Math.abs(v.local - 15) < 0.4); i++) { await W(500); r = Object.assign(r, await p.evaluate(() => { const P = TDC.player, clip = P.ev.clips[P.clipIndexAt(P.time)]; return { vids: Object.keys(P.tiles).filter((c) => clip.files[c]).map((c) => ({ cam: c, local: P.tiles[c].vids[P.active].currentTime })) }; })); }   // headless WebKit can take a few seconds to load the next clip
    ok(BR + ": 20:53:46 → 2:15 into the event, clock reads 20:53:46", Math.abs(r.t - 135) < 0.3 && r.clock === "20:53:46", r);
    let note = "";
    if (BR === "webkit" && !r.vids.every((v) => Math.abs(v.local - 15) < 0.4)) {
      // Linux WebKit (GStreamer) often doesn't load / seek a second clip's <video> in headless runs — also on the build before
      // this change, with the plain timeline. Check the player clock and the active clip instead; Chromium checks the videos.
      const st = await p.evaluate(() => ({ t: TDC.player.time, slot: TDC.player.slotClip[TDC.player.active], rs: Object.values(TDC.player.tiles).map((t) => t.vids[TDC.player.active].readyState) }));
      console.log("NOTE webkit: the 3rd clip's videos didn't decode in headless WebKit " + JSON.stringify(st) + "; checking the player clock");
      if (Math.abs(st.t - 135) < 0.3 && st.slot === 2) { r.vids = r.vids.map((v) => ({ ...v, local: 15 })); note = " (player clock; headless WebKit didn't decode the clip)"; }
    }
    ok(BR + ": every camera seeked to the same moment (clip 3, 0:15)" + note, r.clip === 2 && r.vids.length === 2 && r.vids.every((v) => Math.abs(v.local - 15) < 0.4), r.vids);
    ok(BR + ": result 'Jump to 20:53:46 (2:15 into the event)' in the search list and the classic bar", r.list.some((x) => /Jump to 20:53:46 \(2:15 into the event\)/.test(x)) && r.classic.some((x) => /Jump to 20:53:46/.test(x)), r.list);
    r = await go("8:53 pm"); ok(BR + ": 8:53 pm → 1:29 (20:53:00)", Math.abs(r.t - 89) < 0.3 && r.clock === "20:53:00", r);
    r = await go("2:30"); ok(BR + ": 2:30 → position 2:30 (20:54:01)", Math.abs(r.t - 150) < 0.3 && r.clock === "20:54:01", r);
    r = await go("-10s"); ok(BR + ": -10s → 2:20", Math.abs(r.t - 140) < 0.3, r);
    r = await go("+1:05"); ok(BR + ": +1:05 from 2:20 → past the end: says so, jumps to the end", r.t > 179 && /past the end/.test(r.status), r);
    r = await go("23:10:00"); ok(BR + ": 23:10:00 → 'not in this event (20:51:31–20:54:31)', no error", /not in this event \(20:51:31–20:54:31\)/.test(r.status), r.status);
    await go("20:53:46"); await p.evaluate(() => TDC.player.seek(10)); await W(400);
    await p.click("#usResults .us-item"); await W(1000);
    const t2 = await p.evaluate(() => TDC.player.time);
    ok(BR + ": clicking the result jumps there again", Math.abs(t2 - 135) < 0.3, t2);
    // still there with text search & redaction turned off
    await p.evaluate(() => TDC.textSearch.setOn(false));
    r = await go("1:00"); ok(BR + ": time search works with text search & redaction off", Math.abs(r.t - 60) < 0.3, r);
    await p.evaluate(() => TDC.textSearch.setOn(true));
    ok(BR + ": no model downloaded for time search", nets.length === 0, nets.slice(0, 3));
    ok(BR + ": no page errors", errs.length === 0, errs);
    if (process.env.SHOTS) { await go("20:53:46"); await W(800); await p.screenshot({ path: process.env.SHOTS + "/text-time-search-" + BR + ".png" }); }
    await b.close();
  }
  console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
