// Dark car + blue sky reflections in daylight (tag safari-feedback). A glossy black car in the shade reflects the blue sky
// on its windows and in long streaks along the body; the user's black hatchback read "blue car 73%". Pure classifier
// (js/vehicle-attrs.js), synthetic side-view crops in sRGB (what the camera stores):
//  - black car: black paint + bluish glass (upper part of the box) + pale-blue sky streaks on the body → black (gray at worst)
//  - the same with stronger / brighter reflections, with a sunlit road under it, and a rear view → black / gray, never blue
//  - real blues stay blue: navy car, mid-blue car, blue car in shade, blue car with the same sky reflections
//  - other dark colours unaffected: dark red car → red, dark gray car → gray
// Usage: node test/dark-car-color.js [url]   (url: also run the cases in Chromium and WebKit)
const A = require(process.env.ATTRS || "../js/vehicle-attrs.js");
const URL_ = process.argv[2] || "";
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x).slice(0, 400) : "")); if (!c) fails++; };
function rnd(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const mix = (a, b, u) => a.map((x, i) => x + (b[i] - x) * u);
/** spec: { paint:[r,g,b] sRGB body, glass:[r,g,b], sky:[r,g,b] streak colour, streaks: 0..1 share of body rows, bright: extra highlight streak,
 *          road:[r,g,b] below the car, view:"side"|"rear", seed } */
function crop(spec, W = 96, H = 64) {
  const R = rnd(spec.seed || 5), d = new Uint8ClampedArray(W * H * 4);
  const glass = spec.glass || [58, 78, 104], sky = spec.sky || [88, 116, 150], road = spec.road || [112, 112, 110];
  const rear = spec.view === "rear";
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W, v = y / H, i = (y * W + x) * 4;
    let c;
    const roof = rear ? v < 0.1 || u < 0.08 || u > 0.92 : v < 0.1 || (v < 0.2 && (u < 0.18 || u > 0.9));
    if (roof) c = [150, 170, 185];                                                  // background (trees / buildings / sky)
    else if (v > 0.9) c = road;                                                     // road under the car
    else if (!rear && v > 0.7 && ((u - 0.22) ** 2 / 0.012 + (v - 0.82) ** 2 / 0.012 < 1 || (u - 0.78) ** 2 / 0.012 + (v - 0.82) ** 2 / 0.012 < 1)) c = [18, 18, 19];   // tyres
    else if (v < 0.42 && (rear ? u > 0.22 && u < 0.78 : u > 0.2 && u < 0.86)) c = mix(glass, sky, Math.max(0, Math.min(1, 0.3 + 0.9 * (u - 0.4) + 0.6 * (0.3 - v))));   // windows: sky reflected, brighter toward one side
    else {
      c = spec.paint.slice();
      const row = (v - 0.42) / 0.48, band = Math.floor(row * 10);
      if (spec.streaks && ((band * 7) % 10) / 10 < spec.streaks) c = mix(c, sky, 0.75);           // long sky streaks along the doors
      if (spec.bright && Math.abs(row - 0.18) < 0.05) c = mix(sky, [200, 215, 235], 0.6);            // the shoulder line catches the bright sky
      if (rear && v > 0.5 && v < 0.58 && (u < 0.3 || u > 0.7)) c = [190, 40, 45];                  // tail lamps (off, red lenses)
    }
    const n = (R() - 0.5) * 8;
    d[i] = c[0] + n; d[i + 1] = c[1] + n; d[i + 2] = c[2] + n; d[i + 3] = 255;
  }
  return { d, w: W, h: H };
}
const BLACK = [22, 24, 28];
const CASES = [
  { name: "black car, bluish glass + sky streaks", spec: { paint: BLACK, streaks: 0.3 }, want: ["black", "gray"] },
  { name: "black car, strong sky streaks + bright shoulder line", spec: { paint: BLACK, streaks: 0.5, bright: true, sky: [96, 128, 168] }, want: ["black", "gray"] },
  { name: "black car, deep-blue sky reflections", spec: { paint: BLACK, streaks: 0.4, sky: [60, 96, 150], glass: [40, 62, 98] }, want: ["black", "gray"] },
  { name: "black car on a sunlit road, shade", spec: { paint: [28, 30, 36], streaks: 0.35, road: [150, 148, 140], seed: 9 }, want: ["black", "gray"] },
  { name: "black car from behind (rear window + lamps)", spec: { paint: BLACK, streaks: 0.3, view: "rear" }, want: ["black", "gray"] },
  { name: "navy car", spec: { paint: [28, 44, 98] }, want: ["blue"] },
  { name: "navy car with the same sky streaks", spec: { paint: [28, 44, 98], streaks: 0.3 }, want: ["blue"] },
  { name: "mid-blue car", spec: { paint: [40, 86, 170] }, want: ["blue"] },
  { name: "blue car in shade", spec: { paint: [30, 58, 118], streaks: 0.2 }, want: ["blue"] },
  { name: "dark red car with sky streaks", spec: { paint: [110, 22, 28], streaks: 0.3 }, want: ["red"] },
  { name: "dark gray car with sky streaks", spec: { paint: [70, 72, 76], streaks: 0.3 }, want: ["gray", "silver", "black"] },
];
const built = CASES.map((c) => ({ ...c, img: crop(c.spec) }));
for (const c of built) {
  const r = A.colorFromPixels(c.img.d, c.img.w, c.img.h, {});
  ok("node: " + c.name + " → " + c.want.join("/"), c.want.includes(r.name), { got: r.name, conf: r.conf, blue: +(r.scores.blue || 0).toFixed(2), black: +(r.scores.black || 0).toFixed(2) });
}
(async () => {
  if (URL_) {
    const pw = require("playwright");
    for (const bn of (process.env.BR || "chromium,webkit").split(",")) {
      const b = await pw[bn].launch(bn === "chromium" ? { executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] } : {});
      const p = await (await b.newContext()).newPage();
      await p.goto(URL_);
      await p.waitForFunction(() => window.TDC && TDC.vehicleAttrs);
      const got = await p.evaluate((cases) => cases.map((c) => ({ name: c.name, got: TDC.vehicleAttrs.colorFromPixels(new Uint8ClampedArray(c.d), c.w, c.h, {}).name })), built.map((c) => ({ name: c.name, d: Array.from(c.img.d), w: c.img.w, h: c.img.h })));
      for (const g of got) { const c = built.find((x) => x.name === g.name); ok(bn + ": " + g.name + " → " + c.want.join("/"), c.want.includes(g.got), { got: g.got }); }
      await b.close();
    }
  }
  console.log(fails ? fails + " FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);
})();
