// Settings ▸ Recognition (tag safari-feedback): five switches + speed on top, everything else under "Advanced recognition
// settings" (collapsed by default, open / closed remembered). Playwright Chromium + WebKit + WebKit iPhone (touch).
//  - the switches show and set the same prefs as before (detect / plates / vehicle), dependent ones turn their base on
//  - Advanced is collapsed by default; tapping its summary opens it (touch on the phone), the state survives a reload
//  - every old control is still there (models, thresholds, cameras, street signs, make & model, cloud, index buttons) and
//    reachable once Advanced is open; the five duplicated switches are hidden inside Advanced
//  - an advanced change (e.g. plEnabled) updates the switches; tap targets ≥ 40 px tall on the phone
// Usage: node test/recog-settings.js [url]   (SHOTS=dir: screenshots)
const pw = require("playwright"), path = require("path");
const URL_ = process.argv[2] || "http://127.0.0.1:8770/index.html", SHOTS = process.env.SHOTS || "";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x).slice(0, 500) : "")); if (!c) fails++; };
const OLD = ["detModel", "detConf", "detSmall", "detLiveCams", "detTest", "plModel", "plConf", "plRead", "plFar", "plStreet", "plForget", "vehMakes", "vehClear"];
(async () => {
  for (const [bn, opt] of [["chromium", {}], ["webkit", {}], ["webkit", { iphone: true }]]) {
    const tag = bn + (opt.iphone ? " iPhone" : "");
    const b = await pw[bn].launch(bn === "chromium" ? { executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] } : {});
    const ctx = await b.newContext(opt.iphone ? { ...pw.devices["iPhone 13"] } : { viewport: { width: 1280, height: 1000 } });
    const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
    await p.goto(URL_); await p.evaluate(() => { for (const k of ["tdc.detect.v1", "tdc.plates.v1", "tdc.recogAdv.v1"]) localStorage.removeItem(k); }); await p.reload();
    await p.evaluate(() => { document.getElementById("btnSettings").click(); if (TDC.settings) TDC.settings.show("redact"); /* ui-glass-8 groups */ }); await W(500);
    const s0 = await p.evaluate(() => ({ adv: document.getElementById("recogAdv").open, sw: [...document.querySelectorAll("#setRecog input[type=checkbox]")].map((x) => x.id), seg: !!document.getElementById("rsSpeed"), old: (ids) => 0 }));
    ok(tag + ": five switches + speed on top, Advanced collapsed by default", s0.sw.join() === "rsFind,rsLive,rsVehicle,rsPlates,rsBlur" && s0.seg && s0.adv === false, s0);
    // (closed <details>: content-visibility hidden, so boxes still measure; checkVisibility / the closed ancestor say it)
    const hidden = await p.evaluate((ids) => ids.filter((id) => { const e = document.getElementById(id); if (!e) return true; const shut = !!e.closest("details:not([open])"); return !(shut && (e.checkVisibility ? !e.checkVisibility() : true)); }), OLD);
    ok(tag + ": advanced controls exist but are out of the way while collapsed", hidden.length === 0, hidden);
    // switches → prefs
    const tapSw = async (id) => { const l = p.locator("label[for=" + id + "]"); await l.scrollIntoViewIfNeeded(); if (opt.iphone) await l.tap(); else await l.click(); await W(150); };
    await tapSw("rsBlur");
    const a = await p.evaluate(() => ({ pl: TDC.plates.prefs(), sw: { plates: document.getElementById("rsPlates").checked, blur: document.getElementById("rsBlur").checked } }));
    ok(tag + ": 'Blur licence plates' sets blur and turns plate reading on", a.pl.blur === true && a.pl.enabled === true && a.sw.plates && a.sw.blur, a);
    await tapSw("rsLive");
    const d = await p.evaluate(() => ({ det: TDC.detect.prefs(), seg: [...document.querySelectorAll("#rsSpeed button")].map((x) => x.disabled) }));
    ok(tag + ": 'Show boxes while playing' sets live and turns object detection on; speed buttons enabled", d.det.live === true && d.det.enabled === true && d.seg.every((x) => !x), d);
    await p.locator("#rsSpeed button[data-v=battery]").click(); await W(100);
    ok(tag + ": speed buttons set the detection speed", (await p.evaluate(() => TDC.detect.prefs().speed)) === "battery");
    await tapSw("rsVehicle");
    ok(tag + ": 'Vehicle colour & type' sets vehicle details", await p.evaluate(() => TDC.vehicle.prefs().enabled === true));
    if (SHOTS) { await p.evaluate(() => document.getElementById("recogSec").scrollIntoView({ block: "start" })); await W(200); await p.screenshot({ path: path.join(SHOTS, "recog-settings-" + tag.replace(/ /g, "-") + ".png") }); }
    // open Advanced (tap on the phone)
    const sum = p.locator("#recogAdv > summary"); await sum.scrollIntoViewIfNeeded(); if (opt.iphone) await sum.tap(); else await sum.click(); await W(300);
    const vis = await p.evaluate((ids) => ({ open: document.getElementById("recogAdv").open, missing: ids.filter((id) => { const e = document.getElementById(id); return !e || e.getBoundingClientRect().height === 0; }), dupVisible: ["detEnabled", "detLive", "plEnabled", "plBlur", "vehEnabled", "detSpeed"].filter((id) => { const e = document.getElementById(id); return e && e.getBoundingClientRect().height > 0; }), cloud: document.getElementById("setCloud").children.length }), OLD);
    ok(tag + ": Advanced opens on " + (opt.iphone ? "tap" : "click") + "; every old control is shown, the five twins are hidden", vis.open && !vis.missing.length && !vis.dupVisible.length && vis.cloud > 0, vis);
    if (SHOTS) { await p.evaluate(() => document.getElementById("recogAdv").scrollIntoView({ block: "start" })); await W(200); await p.screenshot({ path: path.join(SHOTS, "recog-settings-advanced-" + tag.replace(/ /g, "-") + ".png") }); }
    // advanced change → switches follow
    await p.evaluate(() => { const c = document.getElementById("plEnabled"); c.checked = false; c.dispatchEvent(new Event("change", { bubbles: true })); }); await W(150);
    ok(tag + ": an advanced change (plate reading off) updates the switches", await p.evaluate(() => !document.getElementById("rsPlates").checked && !TDC.plates.prefs().enabled));
    if (opt.iphone) { const hs = await p.evaluate(() => [...document.querySelectorAll("#setRecog label.rs-switch, #recogAdv > summary")].map((e) => Math.round(e.getBoundingClientRect().height))); ok(tag + ": tap targets ≥ 40 px tall", hs.every((h) => h >= 40), hs); }
    await p.reload(); await p.evaluate(() => { document.getElementById("btnSettings").click(); if (TDC.settings) TDC.settings.show("redact"); /* ui-glass-8 groups */ }); await W(400);
    ok(tag + ": Advanced open state remembered after a reload", await p.evaluate(() => document.getElementById("recogAdv").open === true && localStorage.getItem("tdc.recogAdv.v1") === "1"));
    await p.evaluate(() => { const a = document.getElementById("recogAdv"); a.open = false; }); await W(200);
    ok(tag + ": closing it is remembered too", await p.evaluate(() => localStorage.getItem("tdc.recogAdv.v1") === "0"));
    ok(tag + ": no page errors", !errs.length, errs);
    await b.close();
  }
  console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})();
