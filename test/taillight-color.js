// Vehicle colour with lit tail / brake lamps (tag taillight-fix). Pure classifier (js/vehicle-attrs.js), synthetic crops:
// a vehicle seen from behind under a warm (~2800 K) streetlight, the camera's raw pixels, then the white-balance gains the
// app uses for colour (WB.classifyGains, 100 % white point). Lit lamps: clipped cores, a saturated red ring and a red glow
// that spreads over the body (the user's report: a white city bus read "red bus").
//  - white bus rear, lamps on (with glow, with brake-bright glow, pink cast over the whole rear) → white (or silver at
//    worst; never red / purple / orange)
//  - white car rear with lamps → white / silver
//  - true reds stay red: red car (no lamps), red car with lamps, red bus without lamps, red bus with lamps; daylight red car
//  - other colours unaffected: blue bus with lamps → blue, black car with lamps → black, silver car with lamps → silver/gray
//  - amber turn signal on a white car → not orange
//  - box tracker (js/detect.js, live boxes): a big stale track snaps to a much smaller detection (no "box spans the
//    frame"), small moves are still smoothed; live-sample interpolation doesn't blend a huge and a small box
// Usage: node test/taillight-color.js [url]   (url: also run the classifier cases + tracker in Chromium and WebKit)
const A = require(process.env.ATTRS || "../js/vehicle-attrs.js");
const URL_ = process.argv[2] || "";
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x).slice(0, 400) : "")); if (!c) fails++; };

// ── synthetic crops (deterministic) ──
const enc = (v) => { v = Math.max(0, Math.min(1, v)); return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; };
const dec = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const ILLUM = { warm: [1.0, 0.6, 0.3], day: [1, 1, 1] };
function rnd(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
/** spec: { paint:[r,g,b] linear reflectance, light:"warm"|"day", exp, lamps:"none"|"tail"|"brake"|"amber", glow (0..), cast:[r,g,b] extra light on the whole body, kind:"bus"|"car" } */
function crop(spec, W = 64, H = 64) {
  const L = ILLUM[spec.light || "warm"], exp = spec.exp == null ? 0.55 : spec.exp, R = rnd(spec.seed || 7), d = new Uint8ClampedArray(W * H * 4);
  const bus = spec.kind !== "car";
  const lampCol = spec.lamps === "amber" ? [1, 0.45, 0.02] : spec.lamps === "head" ? [0.6, 0.8, 1.4] : [1, 0.06, 0.04];
  const lampsAt = spec.lamps === "amber" ? [[0.1, bus ? 0.68 : 0.55]] : spec.lamps === "head" ? [[0.14, 0.55], [0.86, 0.55]]
    : spec.lamps === "bar" ? Array.from({ length: 15 }, (_, k) => [0.08 + k * 0.06, 0.36])   // a full-width tail-light bar (RAV4, many new SUVs)
    : spec.lamps === "bar2" ? Array.from({ length: 29 }, (_, k) => [0.04 + k * 0.033, 0.42]).concat([[0.46, 0.1], [0.5, 0.1], [0.54, 0.1]])   // continuous bar + high brake light
    : spec.lamps && spec.lamps !== "none" ? [[0.1, bus ? 0.66 : 0.55], [0.9, bus ? 0.66 : 0.55], [0.1, bus ? 0.76 : 0.6], [0.9, bus ? 0.76 : 0.6]] : [];
  const lampR = spec.lamps === "bar" ? 0.025 : bus ? 0.045 : 0.06, glowK = spec.glow == null ? (spec.lamps === "brake" ? 0.9 : 0.45) : spec.glow;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x + 0.5) / W, v = (y + 0.5) / H, i = (y * W + x) * 4;
    let refl = spec.paint.slice(), em = [0, 0, 0];
    // window (dark glass), bumper / tyres (black), road strip at the bottom
    const win = bus ? u > 0.14 && u < 0.86 && v > 0.08 && v < 0.45 : u > 0.18 && u < 0.82 && v > 0.12 && v < 0.38;
    if (win) refl = [0.03, 0.03, 0.035];
    if (v > (bus ? 0.86 : 0.8)) refl = spec.road ? [0.14, 0.14, 0.14] : [0.04, 0.04, 0.04];
    if (spec.lower && v > 0.62 && v <= 0.8) refl = spec.lower;   // lower bumper / cladding
    if (bus && u > 0.28 && u < 0.72 && v > 0.58 && v < 0.74) refl = refl.map((c) => c * 0.35);   // ad panel / number plate area
    let lit = L.map((c) => c * exp * (0.92 + 0.12 * (1 - v)));
    if (spec.cast) lit = lit.map((c, k) => c + spec.cast[k] * exp);
    for (const [lx, ly] of lampsAt) {
      const dd = Math.hypot((u - lx) * W, (v - ly) * H) / W;   // in box widths
      if (dd < lampR * 0.55) em = em.map((c, k) => c + 6);   // clipped core
      else if (dd < lampR) em = em.map((c, k) => c + lampCol[k] * 1.4);   // lens
      if (glowK) { const g = glowK * Math.exp(-(dd * dd) / (2 * 0.12 * 0.12)) * 0.5; if (!win) lit = lit.map((c, k) => c + lampCol[k] * g); else em = em.map((c, k) => c + lampCol[k] * g * 0.15); }
    }
    if (spec.lamps === "bar2" && win && Math.abs(v - 0.3) < 0.02) em = em.map((c, k) => c + lampCol[k] * 0.12);   // the bar reflected in the rear glass
    for (let k = 0; k < 3; k++) { const n = (R() - 0.5) * 0.02; d[i + k] = Math.round(enc(refl[k] * lit[k] + em[k] + n * 0.1) * 255); }
    d[i + 3] = 255;
    if (spec.redCast) redCast(d, i, spec.redCast);
  }
  return { d, w: W, h: H };
}
/** The night front-camera cast of user report 3: red ADDED to the dark parts of the picture (sky, glass, dark road go
 *  maroon; the bright crosswalk stays near neutral), so no white-balance gain removes it. */
function redCast(d, i, P) { const Y = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; d[i] = Math.min(255, d[i] + Math.round(255 * P * Math.max(0, 1 - 1.6 * Y))); d[i + 1] = Math.max(0, d[i + 1] - Math.round(255 * P * 0.08 * Math.max(0, 1 - 1.6 * Y))); }
/** The frame around the vehicle (for the scene cast): dark sky, dark road, a bright crosswalk, the same light and cast;
 *  the vehicle's box is BOX (left out by sceneCast). */
const BOX = { x: 0.36, y: 0.3, w: 0.3, h: 0.6 };
function scene(spec, W = 96, H = 60) {
  const L = ILLUM[spec.light || "warm"], exp = spec.exp == null ? 0.55 : spec.exp, R = rnd(11), d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x + 0.5) / W, v = (y + 0.5) / H, i = (y * W + x) * 4;
    const refl = v < 0.45 ? 0.01 + 0.015 * R() : v > 0.62 && v < 0.7 && Math.floor(u * 16) % 2 ? 0.7 : 0.04 + 0.04 * R();   // night: dark sky and road
    for (let k = 0; k < 3; k++) d[i + k] = Math.round(enc(refl * L[k] * exp * 1.1) * 255);
    d[i + 3] = 255;
    if (spec.redCast) redCast(d, i, spec.redCast);
  }
  return { d, w: W, h: H, boxes: [BOX] };
}
/** WB.classifyGains for this light: white point = a white body's raw pixel, full correction, clamp [0.4, 2.8]. */
function gains(spec) {
  const L = ILLUM[spec.light || "warm"], exp = spec.exp == null ? 0.55 : spec.exp;
  const w = L.map((c) => enc(0.85 * c * exp) * 255), mx = Math.max(...w), m = spec.gainMul || [1, 1, 1];
  return w.map((c, k) => Math.min(2.8, Math.max(0.4, (mx / Math.max(c, 1)) * m[k])));
}
const WHITE = [0.85, 0.85, 0.85], RED = [0.55, 0.04, 0.035], BLUE = [0.04, 0.12, 0.5], BLACK = [0.035, 0.035, 0.04], SILVER = [0.42, 0.42, 0.44];
const CASES = [
  // [name, spec, accepted labels]
  ["white bus rear, tail lamps on + glow", { paint: WHITE, kind: "bus", lamps: "tail" }, ["white", "silver"]],
  ["white bus rear, brake lamps (bright glow)", { paint: WHITE, kind: "bus", lamps: "brake" }, ["white", "silver"]],
  ["white bus rear, lamps + red cast on the whole rear", { paint: WHITE, kind: "bus", lamps: "brake", cast: [0.22, 0.0, 0.02] }, ["white", "silver"]],
  ["white bus rear, brake lamps, strong glow + cast (user report)", { paint: WHITE, kind: "bus", lamps: "brake", exp: 0.4, cast: [0.18, 0, 0.03], glow: 1.6 }, ["white", "silver"]],
  ["white bus rear, brake lamps, stronger glow + cast", { paint: WHITE, kind: "bus", lamps: "brake", exp: 0.4, cast: [0.25, 0, 0.04], glow: 2.2 }, ["white", "silver"]],
  ["white bus rear, tail lamps, strong glow", { paint: WHITE, kind: "bus", lamps: "tail", exp: 0.45, cast: [0.1, 0, 0.015], glow: 1.6 }, ["white", "silver"]],
  ["white bus rear, pink cast, dim (like the screenshot)", { paint: WHITE, kind: "bus", lamps: "brake", light: "day", exp: 0.2, cast: [0.12, 0, 0.025], glow: 1.2, night: true }, ["white", "silver", "gray"]],
  ["white bus rear, lamps, dimmer", { paint: WHITE, kind: "bus", lamps: "tail", exp: 0.38 }, ["white", "silver", "gray"]],
  ["white bus rear, no lamps", { paint: WHITE, kind: "bus", lamps: "none" }, ["white"]],
  ["white car rear, brake lamps", { paint: WHITE, kind: "car", lamps: "brake" }, ["white", "silver"]],
  ["white car, amber turn signal", { paint: WHITE, kind: "car", lamps: "amber", glow: 0.6 }, ["white", "silver"]],
  ["red car, no lamps", { paint: RED, kind: "car", lamps: "none" }, ["red"]],
  ["red car, brake lamps", { paint: RED, kind: "car", lamps: "brake" }, ["red"]],
  ["red car, dim, tail lamps", { paint: RED, kind: "car", lamps: "tail", exp: 0.4 }, ["red"]],
  ["red bus, no lamps", { paint: RED, kind: "bus", lamps: "none" }, ["red"]],
  ["red bus, tail lamps", { paint: RED, kind: "bus", lamps: "tail" }, ["red"]],
  ["red car, brake lamps, strong glow", { paint: RED, kind: "car", lamps: "brake", exp: 0.4, glow: 1.6 }, ["red"]],
  ["dark red car, dim, brake lamps", { paint: [0.3, 0.025, 0.025], kind: "car", lamps: "brake", exp: 0.35 }, ["red"]],
  ["red bus, brake lamps, strong glow", { paint: RED, kind: "bus", lamps: "brake", exp: 0.4, glow: 1.6 }, ["red"]],
  ["red car, daylight, brake lamps", { paint: RED, kind: "car", lamps: "brake", light: "day", exp: 0.8 }, ["red"]],
  ["white car, daylight, brake lamps", { paint: WHITE, kind: "car", lamps: "brake", light: "day", exp: 0.85, glow: 0.15 }, ["white"]],
  // second user report: a red Tesla seen from the front at night (blue-white headlights) read gray; a dark RAV4 from behind
  // (lit full-width tail bar, red glow, blue-grey lower cladding) read blue. Also with a white point that over-corrects to blue.
  ["dark red sedan, front, headlights on", { paint: [0.1, 0.007, 0.007], kind: "car", lamps: "head", exp: 0.3, glow: 0.3, road: true }, ["red"]],
  ["dark red sedan, front, headlights, blue-heavy correction", { paint: [0.1, 0.007, 0.007], kind: "car", lamps: "head", exp: 0.3, glow: 0.3, road: true, gainMul: [0.97, 1.05, 1.2] }, ["red"]],
  ["red car, front, headlights on", { paint: RED, kind: "car", lamps: "head", glow: 0.3 }, ["red"]],
  ["dark SUV rear, lit tail bar + glow", { paint: [0.05, 0.05, 0.055], kind: "car", lamps: "bar", glow: 1.4, cast: [0.12, 0, 0.02], lower: [0.1, 0.11, 0.13] }, ["black", "gray"]],
  ["dark SUV rear, tail bar, blue-heavy correction", { paint: [0.05, 0.05, 0.055], kind: "car", lamps: "bar", glow: 1.4, cast: [0.12, 0, 0.02], lower: [0.1, 0.11, 0.13], gainMul: [0.97, 1.05, 1.25] }, ["black", "gray"]],
  ["white car, front, headlights on", { paint: WHITE, kind: "car", lamps: "head", glow: 0.3 }, ["white", "silver"]],
  // third user report (tag glare-fix): the same dark grey RAV4 from behind read "red car 50%": a full-width lit tail bar,
  // its reflection in the glass, a high brake light, light grey lower bumper, and a red cast over the dark parts of the
  // whole frame. Judged with and without the white-balance gains, with the scene cast from the frame around it.
  ["dark grey SUV rear, lit bar + reflection + red frame cast (report 3)", { paint: [0.1, 0.1, 0.11], kind: "car", lamps: "bar2", glow: 0.7, lower: [0.32, 0.32, 0.33], redCast: 0.2, scene: true }, ["gray", "black", "silver"]],
  ["dark grey SUV rear, lit bar + red frame cast, no white balance", { paint: [0.1, 0.1, 0.11], kind: "car", lamps: "bar2", glow: 0.7, lower: [0.32, 0.32, 0.33], redCast: 0.2, scene: true, noGains: true, light: "day", exp: 0.3 }, ["gray", "black", "silver"]],
  ["dark grey SUV rear, brighter glow + stronger cast", { paint: [0.1, 0.1, 0.11], kind: "car", lamps: "bar2", glow: 1.2, lower: [0.32, 0.32, 0.33], redCast: 0.28, scene: true, noGains: true, light: "day", exp: 0.3 }, ["gray", "black", "silver"]],
  ["red SUV rear, lit bar + red frame cast → still red", { paint: RED, kind: "car", lamps: "bar2", glow: 0.7, redCast: 0.2, scene: true }, ["red"]],
  ["red SUV rear, lit bar + cast, no white balance → still red", { paint: RED, kind: "car", lamps: "bar2", glow: 0.7, redCast: 0.2, scene: true, noGains: true, light: "day", exp: 0.3 }, ["red"]],
  ["blue bus, tail lamps", { paint: BLUE, kind: "bus", lamps: "tail" }, ["blue"]],
  ["black car, brake lamps", { paint: BLACK, kind: "car", lamps: "brake" }, ["black"]],
  ["silver car, tail lamps", { paint: SILVER, kind: "car", lamps: "tail" }, ["silver", "gray", "white"]],
];
function runCases(Acls) {
  const out = [];
  for (const [name, spec, want] of CASES) {
    const c = crop(spec), g = spec.noGains ? null : gains(spec), night = spec.night != null ? spec.night : !spec.noGains && (spec.light || "warm") === "warm";
    const o = g ? { gains: g, night } : { night };
    if (spec.scene) { const f = scene(spec); o.cast = Acls.sceneCast(f.d, f.w, f.h, f.boxes, o); }
    const r = Acls.colorFromPixels(c.d, c.w, c.h, o);
    out.push({ name, want, got: r.name, conf: r.conf, lamps: r.lamps || 0 });
  }
  return out;
}
module.exports = { crop, gains, scene, CASES, runCases };
if (require.main !== module) return;

(async () => {
  console.log("── node (js/vehicle-attrs.js) ──");
  for (const r of runCases(A)) ok("node: " + r.name + " → " + r.want.join("/"), r.want.includes(r.got), r);
  if (process.env.DUMP) { const fs = require("fs"); for (const [name, spec] of CASES) { const c = crop(spec, 128, 128); fs.writeFileSync("/tmp/tl-" + name.replace(/\W+/g, "_") + ".rgba", Buffer.from(c.d)); } }
  if (URL_) {
    const pw = require("playwright");
    for (const bn of (process.env.BR || "chromium,webkit").split(",")) {
      const b = await pw[bn].launch(bn === "chromium" ? { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] } : {});
      const p = await (await b.newContext()).newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
      await p.goto(URL_, { waitUntil: "load" }); await new Promise((r) => setTimeout(r, 800));
      const cases = CASES.map(([name, spec]) => { const c = crop(spec), f = spec.scene ? scene(spec) : null; return { name, d: Array.from(c.d), w: c.w, h: c.h, g: spec.noGains ? null : gains(spec), night: spec.night != null ? spec.night : !spec.noGains && (spec.light || "warm") === "warm", f: f && { d: Array.from(f.d), w: f.w, h: f.h, boxes: f.boxes } }; });
      const got = await p.evaluate((cases) => cases.map((c) => { const A = TDC.vehicleAttrs, o = c.g ? { gains: c.g, night: c.night } : { night: c.night }; if (c.f) o.cast = A.sceneCast(new Uint8ClampedArray(c.f.d), c.f.w, c.f.h, c.f.boxes, o); const r = A.colorFromPixels(new Uint8ClampedArray(c.d), c.w, c.h, o); return { name: c.name, got: r.name, conf: r.conf }; }), cases);
      got.forEach((r, i) => ok(bn + ": " + r.name + " → " + CASES[i][2].join("/"), CASES[i][2].includes(r.got), r));
      // live box tracker: a big stale box must not survive a much smaller detection of the same object
      const tr = await p.evaluate(() => {
        const D = TDC.detect; if (!D._track) return { missing: true };
        D.liveTracks = {}; const cam = "left_repeater";
        D._track(cam, 10, [{ label: "bus", conf: 0.9, x: 0.05, y: 0.02, w: 0.78, h: 0.66 }]);   // bus right next to the car
        D._track(cam, 11.8, [{ label: "bus", conf: 0.92, x: 0.05, y: 0.25, w: 0.16, h: 0.24 }]);   // it drove away: small
        const a = D.liveTracks[cam].slice();
        D._track(cam, 12.0, [{ label: "bus", conf: 0.92, x: 0.06, y: 0.25, w: 0.165, h: 0.245 }]);   // small move: smoothed
        const b = D.liveTracks[cam].slice();
        // interpolation between two live samples (export path / paused viewer)
        D.liveSamples = {}; D.live = {};
        D.addLiveSample(cam, { t: 20, dets: [{ label: "bus", conf: 0.9, x: 0.05, y: 0.02, w: 0.78, h: 0.66 }], hold: 1.2 });
        D.addLiveSample(cam, { t: 21, dets: [{ label: "bus", conf: 0.9, x: 0.05, y: 0.25, w: 0.16, h: 0.24 }], hold: 1.2 });
        const mid = D.liveAt(cam, 20.7);
        return { a: a.map((t) => [t.x, t.y, t.w, t.h].map((v) => +v.toFixed(3))), b: b.map((t) => [t.x, t.y, t.w, t.h].map((v) => +v.toFixed(3))), mid: mid && mid.dets.map((t) => [t.x, t.y, t.w, t.h].map((v) => +v.toFixed(3))) };
      });
      ok(bn + ": tracker hook present", !tr.missing, tr);
      if (!tr.missing) {
        ok(bn + ": one track after the big → small detection", tr.a.length === 1, tr.a);
        ok(bn + ": stale big box snaps to the small detection (w ≤ 0.2, h ≤ 0.3)", tr.a[0] && tr.a[0][2] <= 0.2 && tr.a[0][3] <= 0.3, tr.a[0]);
        ok(bn + ": a small move is still smoothed (x between 0.05 and 0.06)", tr.b[0] && tr.b[0][0] > 0.05 && tr.b[0][0] < 0.06, tr.b[0]);
        ok(bn + ": interpolation does not blend a frame-size box into a small one", tr.mid && tr.mid.length >= 1 && tr.mid.every((m) => m[2] <= 0.2 || m[2] >= 0.75), tr.mid);
      }
      ok(bn + ": no page errors", !errs.length, errs);
      await b.close();
    }
  }
  console.log(fails ? "FAILED " + fails : "ALL PASS");
  process.exit(fails ? 1 : 0);
})();
