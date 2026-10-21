/* vehicle-attrs.js — vehicle details (beta): pure helpers, no DOM, so they run in the browser (TDC.vehicleAttrs) and in node tests.
 *  - parse(): "red tour bus", "white police car", "ambulance", "Tesla Model Y", "blue Toyota" → { cls, color, type, make, model }
 *  - colorFromPixels(): dominant paint colour of a vehicle crop (HSV votes, centre-weighted; glass, tyres, shadow and grey
 *    road count less). Named colours: white, black, gray, silver, red, blue, green, yellow, orange, brown, beige, purple.
 *    Under street lights at night (orange sodium light, very dark crops) colours are unreliable; lowLight says so.
 *  - colorMatch(): how well an estimate matches the colour asked for (near colours like silver/gray get partial credit).
 *  - TYPES (roles: tour bus, city bus, police car, ambulance, fire truck…) and MAKES (brand → models) with CLIP prompts. */
(function (root) {
  "use strict";
  const COLORS = ["white", "black", "gray", "silver", "red", "blue", "green", "yellow", "orange", "brown", "beige", "purple"];
  const COLOR_SYN = { grey: "gray", maroon: "red", burgundy: "red", crimson: "red", navy: "blue", teal: "blue", turquoise: "blue", cyan: "blue", gold: "yellow", golden: "yellow", tan: "beige", cream: "beige", champagne: "beige", violet: "purple", pink: "red", charcoal: "gray", lime: "green", olive: "green" };
  // type id → YOLO (COCO) classes it can show up as, query words, CLIP prompts (ensembled)
  const TYPES = [
    { id: "tour bus", cls: ["bus"], words: ["tour bus", "tour coach", "coach bus", "charter bus", "sightseeing bus", "double decker bus", "double-decker bus", "double decker", "double-decker", "intercity bus", "greyhound bus", "greyhound", "coach"], prompts: ["a photo of a coach", "a photo of a tour bus", "a photo of a double-decker sightseeing tour bus", "a photo of a coach bus"] },
    { id: "city bus", cls: ["bus"], words: ["city bus", "transit bus", "local bus", "street bus", "public bus", "metro bus", "muni bus", "regular bus", "commuter bus", "articulated bus", "local street bus", "regular local bus"], prompts: ["a photo of a city bus", "a photo of a transit bus", "a photo of a public bus"] },
    { id: "school bus", cls: ["bus"], words: ["school bus", "schoolbus"], prompts: ["a photo of a school bus"] },
    { id: "shuttle bus", cls: ["bus", "truck", "car"], words: ["shuttle bus", "airport shuttle", "shuttle", "minibus", "mini bus"], prompts: ["a photo of a minibus", "a photo of a shuttle bus"] },
    { id: "police car", cls: ["car", "truck"], words: ["police car", "police cruiser", "police suv", "patrol car", "squad car", "cop car", "highway patrol", "sheriff car", "sheriff", "police", "cops", "cop", "cruiser", "chp"], prompts: ["a photo of a police car with a light bar on the roof", "a photo of a police patrol car with police markings"] },
    { id: "ambulance", cls: ["truck", "car", "bus"], words: ["ambulance", "ambulances", "paramedic", "paramedics", "ems"], prompts: ["a photo of an ambulance", "a photo of an emergency ambulance van"] },
    { id: "fire truck", cls: ["truck", "bus"], words: ["fire truck", "fire engine", "firetruck", "fire-truck", "ladder truck", "fire trucks", "fire engines"], prompts: ["a photo of a red fire truck", "a photo of a fire engine"] },
    { id: "taxi", cls: ["car"], words: ["taxi", "taxis", "cab", "taxicab", "yellow cab"], prompts: ["a photo of a taxi cab with a taxi sign"] },
    { id: "delivery van", cls: ["truck", "car"], words: ["delivery van", "delivery truck", "cargo van", "ups truck", "fedex truck", "amazon van", "mail truck", "postal truck", "van", "vans"], prompts: ["a photo of a delivery van", "a photo of a cargo van"] },
    { id: "pickup truck", cls: ["truck", "car"], words: ["pickup truck", "pick-up truck", "pick up truck", "pickup", "pickups", "pick-up"], prompts: ["a photo of a pickup truck"] },
    { id: "semi truck", cls: ["truck"], words: ["semi truck", "semi", "18 wheeler", "18-wheeler", "big rig", "tractor trailer", "lorry"], prompts: ["a photo of a semi truck", "a photo of a tractor trailer truck"] },
    { id: "box truck", cls: ["truck"], words: ["box truck", "moving truck", "u-haul"], prompts: ["a photo of a box truck"] },
    { id: "suv", cls: ["car", "truck"], words: ["suv", "suvs", "crossover"], prompts: ["a photo of an SUV"] },
    { id: "sedan", cls: ["car"], words: ["sedan", "sedans", "saloon"], prompts: ["a photo of a sedan car", "a photo of a four-door sedan"] },
    { id: "hatchback", cls: ["car"], words: ["hatchback"], prompts: ["a photo of a hatchback car"] },
    { id: "sports car", cls: ["car"], words: ["sports car", "convertible"], prompts: ["a photo of a sports car"] },
  ];
  const CLASS_WORDS = { car: "car", cars: "car", vehicle: ["car", "truck", "bus"], vehicles: ["car", "truck", "bus"], automobile: "car", bus: "bus", buses: "bus", busses: "bus", truck: "truck", trucks: "truck", motorcycle: "motorcycle", motorcycles: "motorcycle", motorbike: "motorcycle", scooter: "motorcycle", moped: "motorcycle" };
  // brand → models (current and recent US models; CLIP knows many of them by name). Aliases are matched as whole words.
  const MAKES = [
    { make: "Tesla", alias: ["tesla"], models: [["Model S", ["model s"]], ["Model 3", ["model 3", "model three"]], ["Model X", ["model x"]], ["Model Y", ["model y"]], ["Cybertruck", ["cybertruck", "cyber truck"]]] },
    { make: "Toyota", alias: ["toyota"], models: [["Prius", ["prius"]], ["Camry", ["camry"]], ["Corolla", ["corolla"]], ["RAV4", ["rav4", "rav 4"]], ["Tacoma", ["tacoma"]], ["Tundra", ["tundra"]], ["Highlander", ["highlander"]], ["Sienna", ["sienna"]], ["4Runner", ["4runner"]]] },
    { make: "Honda", alias: ["honda"], models: [["Civic", ["civic"]], ["Accord", ["accord"]], ["CR-V", ["cr-v", "crv"]], ["Odyssey", ["odyssey"]], ["Pilot", ["pilot"]], ["HR-V", ["hr-v", "hrv"]]] },
    { make: "Ford", alias: ["ford"], models: [["F-150", ["f-150", "f150", "f 150"]], ["Mustang", ["mustang"]], ["Explorer", ["explorer"]], ["Transit", ["transit van", "ford transit"]], ["Bronco", ["bronco"]], ["Escape", ["escape"]], ["Ranger", ["ranger"]]] },
    { make: "Chevrolet", alias: ["chevrolet", "chevy"], models: [["Silverado", ["silverado"]], ["Tahoe", ["tahoe"]], ["Suburban", ["suburban"]], ["Bolt", ["bolt"]], ["Malibu", ["malibu"]], ["Equinox", ["equinox"]], ["Corvette", ["corvette"]], ["Camaro", ["camaro"]]] },
    { make: "Nissan", alias: ["nissan"], models: [["Altima", ["altima"]], ["Leaf", ["leaf"]], ["Rogue", ["rogue"]], ["Sentra", ["sentra"]], ["Frontier", ["frontier"]]] },
    { make: "BMW", alias: ["bmw", "beemer"], models: [["3 Series", ["3 series", "3-series"]], ["5 Series", ["5 series"]], ["X5", ["x5"]], ["X3", ["x3"]], ["i3", ["i3"]]] },
    { make: "Mercedes-Benz", alias: ["mercedes-benz", "mercedes benz", "mercedes", "benz"], models: [["C-Class", ["c-class", "c class"]], ["E-Class", ["e-class", "e class"]], ["G-Class", ["g-class", "g wagon", "g-wagon"]], ["Sprinter", ["sprinter"]]] },
    { make: "Audi", alias: ["audi"], models: [["A4", ["a4"]], ["Q5", ["q5"]], ["e-tron", ["e-tron", "etron"]]] },
    { make: "Volkswagen", alias: ["volkswagen", "vw"], models: [["Golf", ["golf"]], ["Jetta", ["jetta"]], ["Beetle", ["beetle"]], ["ID.4", ["id.4", "id4", "id 4"]], ["Tiguan", ["tiguan"]]] },
    { make: "Subaru", alias: ["subaru"], models: [["Outback", ["outback"]], ["Forester", ["forester"]], ["Crosstrek", ["crosstrek"]]] },
    { make: "Hyundai", alias: ["hyundai"], models: [["Ioniq 5", ["ioniq 5", "ioniq"]], ["Elantra", ["elantra"]], ["Sonata", ["sonata"]], ["Tucson", ["tucson"]]] },
    { make: "Kia", alias: ["kia"], models: [["EV6", ["ev6"]], ["Soul", ["soul"]], ["Telluride", ["telluride"]], ["Sorento", ["sorento"]]] },
    { make: "Jeep", alias: ["jeep"], models: [["Wrangler", ["wrangler"]], ["Grand Cherokee", ["grand cherokee", "cherokee"]]] },
    { make: "Rivian", alias: ["rivian"], models: [["R1T", ["r1t"]], ["R1S", ["r1s"]]] },
    { make: "Lexus", alias: ["lexus"], models: [["RX", ["lexus rx"]], ["ES", ["lexus es"]]] },
    { make: "Mazda", alias: ["mazda"], models: [["CX-5", ["cx-5", "cx5"]], ["Miata", ["miata", "mx-5"]]] },
    { make: "Ram", alias: ["ram", "dodge ram"], models: [["1500", ["ram 1500"]]] },
    { make: "Dodge", alias: ["dodge"], models: [["Charger", ["charger"]], ["Challenger", ["challenger"]], ["Durango", ["durango"]]] },
    { make: "GMC", alias: ["gmc"], models: [["Sierra", ["sierra"]], ["Yukon", ["yukon"]]] },
    { make: "Porsche", alias: ["porsche"], models: [["911", ["porsche 911"]], ["Taycan", ["taycan"]], ["Cayenne", ["cayenne"]]] },
    { make: "Volvo", alias: ["volvo"], models: [["XC90", ["xc90"]], ["XC60", ["xc60"]]] },
    { make: "Lucid", alias: ["lucid"], models: [["Air", ["lucid air"]]] },
    { make: "Mini", alias: ["mini cooper", "mini"], models: [["Cooper", ["cooper"]]] },
    { make: "Cadillac", alias: ["cadillac"], models: [["Escalade", ["escalade"]]] },
    { make: "Polestar", alias: ["polestar"], models: [["2", ["polestar 2"]]] },
  ];
  const STOP = new Set(["a", "an", "the", "any", "all", "every", "some", "find", "search", "for", "show", "me", "look", "where", "is", "are", "locate", "get", "with", "on", "in", "at", "near", "next", "to", "by", "of", "my", "ahead", "behind", "front", "passing", "parked", "driving", "moving", "turning", "street", "road", "lane", "highway", "freeway", "video", "clip", "please", "that", "this", "and", "or", "like", "one", "ones", "colored", "coloured", "color", "colour", "big", "large", "small", "little", "local", "regular", "car's", "s"]);

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordRx = (w) => new RegExp("(^|[^a-z0-9])" + esc(w) + "(?=$|[^a-z0-9])", "i");
  const clsOf = (v) => (Array.isArray(v) ? v.slice() : [v]);

  /** Query → { cls:[COCO classes], color, type, make, model, chips:[…], label } or null (not a vehicle query → other searches). */
  function parse(q) {
    let s = " " + String(q || "").toLowerCase().replace(/[.!?,]+/g, " ").replace(/\s+/g, " ").trim() + " ";
    if (s.trim().length < 2 || s.length > 90) return null;
    const take = (w) => { const rx = wordRx(w); if (!rx.test(s)) return false; s = s.replace(rx, "$1 "); return true; };
    const out = { cls: null, color: null, type: null, make: null, model: null };
    // make / model first ("Model 3" must not be read as a plate or a colour)
    for (const mk of MAKES) {
      for (const [name, al] of mk.models) if (!out.model && al.some((a) => take(a))) { out.make = mk.make; out.model = name; }
      if (mk.alias.some((a) => take(a))) { if (out.make && out.make !== mk.make) continue; out.make = mk.make; }
    }
    // types: longest phrase wins
    const words = [];
    TYPES.forEach((t) => t.words.forEach((w) => words.push([w, t])));
    words.sort((a, b) => b[0].length - a[0].length);
    for (const [w, t] of words) if (!out.type && take(w)) out.type = t.id;
    for (const c of COLORS.concat(Object.keys(COLOR_SYN))) if (!out.color && take(c)) out.color = COLOR_SYN[c] || c;
    for (const w of Object.keys(CLASS_WORDS).sort((a, b) => b.length - a.length)) if (take(w)) { const c = clsOf(CLASS_WORDS[w]); out.cls = out.cls ? out.cls.concat(c) : c; }
    const left = s.trim().split(" ").filter((x) => x && !STOP.has(x));
    if (!out.type && !out.make && !out.cls) return null;   // "red", "a person in a hoodie" → not ours
    if (left.length > 2) return null;                       // lots of other words → the picture search understands them better
    const T = out.type && TYPES.find((t) => t.id === out.type);
    if (T) out.cls = T.cls.slice();   // the role decides which detector classes to look at
    if (!out.cls || !out.cls.length) out.cls = T ? T.cls.slice() : out.model === "Cybertruck" || /F-150|Silverado|Tacoma|Tundra|Sierra|1500|R1T|Ranger|Frontier|Sprinter|Transit/.test(out.model || "") ? ["truck", "car"] : ["car", "truck"];
    out.cls = [...new Set(out.cls)];
    out.extra = left;
    out.chips = [];
    if (out.color) out.chips.push("color: " + out.color);
    if (out.type) out.chips.push("type: " + out.type);
    if (out.make) out.chips.push("make: " + out.make);
    if (out.model) out.chips.push("model: " + out.model);
    out.chips.push("detector: " + out.cls.join(" / "));
    out.label = [out.color, out.make, out.model, out.type || (out.make ? null : out.cls[0])].filter(Boolean).join(" ");
    return out;
  }

  // CIELAB (D65) of an sRGB pixel (0..1): neutral test by chroma relative to lightness (tag wb-color)
  const LIN = new Float32Array(256); for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  const lin1 = (c) => { const x = Math.max(0, Math.min(255, c * 255)), i = x | 0, f = x - i; return i >= 255 ? LIN[255] : LIN[i] + (LIN[i + 1] - LIN[i]) * f; };
  const fL = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  function lab(r, g, b) {
    const R = lin1(r), G = lin1(g), B = lin1(b);
    const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
    const fx = fL(X), fy = fL(Y), fz = fL(Z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  /** A pixel reads as neutral (white / silver / gray / black) when its CIELAB chroma is small FOR ITS LIGHTNESS:
   *  C* < NEUTRAL_C0 + NEUTRAL_CK × L*, ×NEUTRAL_WARM for dim warm-hued pixels (night, streetlight: a slightly yellow
   *  grey is grey, not beige / brown). Real brown (C* ≈ 25 at L* ≈ 35) and beige (C* ≈ 15 at L* ≈ 80) stay colours. */
  const NEUTRAL_C0 = 4, NEUTRAL_CK = 0.1, NEUTRAL_WARM = 1.5;
  /** Brightness (HSV value) thresholds for white / silver / gray (below: black). At night under a streetlight (a white
   *  point below ~4500 K was found and applied: opts.night) a white vehicle is lit far less than by daylight, so the
   *  steps are lower: a white bus under a streetlight sits around 0.65–0.7, silver paint around 0.45. */
  const GRAY_DAY = [0.72, 0.5, 0.28], GRAY_NIGHT = [0.6, 0.4, 0.22];

  /** rgba = Uint8ClampedArray of a w×h crop of ONE vehicle (box from the detector). opts.gains = [r,g,b] white-balance
   *  gains applied to every pixel first (WB.classifyGains, from the mirror cameras' white point).
   *  → { name, conf, scores, lowLight, corrected } */
  const LINT = new Float32Array(256); for (let i = 0; i < 256; i++) { const c = i / 255; LINT[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  const ENCT = new Float32Array(4097); for (let i = 0; i <= 4096; i++) { const c = i / 4096; ENCT[i] = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }
  const ENC = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : ENCT[Math.round(v * 4096)]);
  /** Lit lamps (tag taillight-fix). Seen from behind at night, tail / brake lamps are clipped cores with a saturated red
   *  (or amber) ring, and their glow tints the body around them (often the whole rear of a white bus pink). Seeds: clipped
   *  pixels (raw ≥ LAMP_CLIP; only in a dark crop, where nothing else clips) and bright, saturated red / amber pixels clearly
   *  brighter than the body (or very saturated on a pale body). Seeds + a halo of LAMP_HALO × the crop's short side are left
   *  out of the vote (clipped: the DARKEST raw channel ≥ LAMP_CLIP, so bright red paint with R at 255 is not a lamp), and red / amber pixels within twice that, more saturated than the body, too (glow gradient). Many seeds
   *  (> LAMP_MAX of the crop) = paint, not lamps: only clipped seeds are kept, or none. */
  const LAMP_CLIP = 0.88, LAMP_HALO = 0.07, LAMP_MAX = 0.18, LAMP_BLOB = 0.03;
  /** At night (and wherever lamps were found) a red / pink / magenta reading needs real saturation: a red cast on a white
   *  body (lamp glow, a pink-leaning white balance) sits at s ≈ 0.2–0.35 at v ≈ 0.5, red paint at ≥ 0.5. Dark pixels
   *  (v < 0.35: dark red paint at night, s ≈ 0.35–0.55) need only 0.3, since a white body is never that dark. Below → neutral. */
  const RED_MIN_S = { day: 0.16, lamps: 0.35, night: 0.42 };
  let BUF = null;
  const redAmber = (hue) => hue < 50 || hue >= 320;
  function colorFromPixels(rgba, w, h, opts) {
    const gn = opts && opts.gains, g0 = gn ? gn[0] : 1, g1 = gn ? gn[1] : 1, g2 = gn ? gn[2] : 1;
    const M = opts && opts.matrix, night = !!(opts && opts.night), dbg = opts && opts.debug;
    const GT = night ? GRAY_NIGHT : GRAY_DAY;
    const sc = {}; COLORS.forEach((c) => (sc[c] = 0));
    const N = w * h;
    if (!BUF || BUF.n < N) BUF = { n: N, R: new Float32Array(N), G: new Float32Array(N), B: new Float32Array(N), V: new Float32Array(N), S: new Float32Array(N), HU: new Float32Array(N), RAW: new Float32Array(N) };   // reused: no garbage per crop (phones)
    const { R, G, B, V, S, HU, RAW } = BUF;
    for (let p = 0, i = 0; p < N; p++, i += 4) {
      let r, g, b;
      if (M) {   // colour-constancy prototype: a 3×3 in LINEAR sRGB (CAT16 / Bradford / linear gains), then back to sRGB
        const lr = LINT[rgba[i]], lg = LINT[rgba[i + 1]], lb = LINT[rgba[i + 2]];
        r = ENC(M[0][0] * lr + M[0][1] * lg + M[0][2] * lb); g = ENC(M[1][0] * lr + M[1][1] * lg + M[1][2] * lb); b = ENC(M[2][0] * lr + M[2][1] * lg + M[2][2] * lb);
      } else { r = Math.min(1, (rgba[i] / 255) * g0); g = Math.min(1, (rgba[i + 1] / 255) * g1); b = Math.min(1, (rgba[i + 2] / 255) * g2); }
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
      let hue = 0;
      if (c > 1e-6) { if (mx === r) hue = ((g - b) / c) % 6; else if (mx === g) hue = (b - r) / c + 2; else hue = (r - g) / c + 4; hue *= 60; if (hue < 0) hue += 360; }
      R[p] = r; G[p] = g; B[p] = b; V[p] = mx; S[p] = mx ? c / mx : 0; HU[p] = hue; RAW[p] = Math.min(rgba[i], rgba[i + 1], rgba[i + 2]) / 255;   // all channels high = a lamp core (red paint clips only R)
    }
    // body brightness / saturation: medians of the non-dark pixels
    const med = (arr) => { const a = []; for (let p = 0; p < N; p++) if (V[p] >= 0.2) a.push(arr[p]); if (!a.length) return 0; a.sort((x, y) => x - y); return a[a.length >> 1]; };
    const medV = med(V), medS = med(S), dark = night || medV < 0.45;
    // lots of saturated red = red paint: then a "lens" must stand clearly above the paint's own brightness
    const redV = []; for (let p = 0; p < N; p++) if ((HU[p] < 20 || HU[p] >= 320) && S[p] >= 0.45 && V[p] >= 0.2) redV.push(V[p]);
    redV.sort((x, y) => x - y);
    const lensMinV = redV.length > 0.25 * N ? Math.max(0.9, redV[redV.length >> 1] + 0.3) : 0.6;
    // lamp seeds
    // seed types: 1 = red / amber lens, 2 = clipped, 3 = headlight / LED (very bright blue-white, dark crop only)
    const seed = new Uint8Array(N); let nSeed = 0, nClip = 0, nRed = 0, nLens = 0;
    for (let p = 0; p < N; p++) {
      const clip = dark && RAW[p] >= LAMP_CLIP;
      const lens = redAmber(HU[p]) && S[p] >= 0.5 && V[p] >= lensMinV && (V[p] >= medV + 0.2 || (S[p] >= 0.75 && medS < 0.3));
      const cool = dark && V[p] >= Math.max(0.75, medV + 0.35) && (S[p] < 0.2 || (HU[p] >= 180 && HU[p] < 275 && S[p] < 0.7));
      if (clip || lens || cool) { seed[p] = clip ? 2 : lens ? 1 : 3; nSeed++; if (clip) nClip++; else if (lens) nLens++; if (lens && !clip && (HU[p] < 20 || HU[p] >= 320)) nRed++; }
    }
    // a lamp is a small blob: a big connected red patch is paint (a bright red car close up), not a lamp
    if (nLens) {
      const lab = new Int32Array(N), stack = [];
      for (let p0 = 0; p0 < N; p0++) {
        if (seed[p0] !== 1 || lab[p0]) continue;
        const comp = []; lab[p0] = 1; stack.push(p0);
        while (stack.length) { const q = stack.pop(); comp.push(q); const x = q % w; for (const nb of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, q - w, q + w]) if (nb >= 0 && nb < N && seed[nb] === 1 && !lab[nb]) { lab[nb] = 1; stack.push(nb); } }
        if (comp.length > LAMP_BLOB * N) for (const q of comp) { seed[q] = 0; nSeed--; nLens--; if (HU[q] < 20 || HU[q] >= 320) nRed--; }
      }
    }
    if (nSeed > LAMP_MAX * N) { for (let p = 0; p < N; p++) if (seed[p] !== 2) seed[p] = 0; nSeed = nClip; nRed = 0; nLens = 0; if (nClip > LAMP_MAX * N) { seed.fill(0); nSeed = 0; } }
    // lit red lamps = we see the vehicle's rear with its lamps on: red on its body may be their glow, so red counts less.
    // Red lenses, or lamps that clip to white with a red ring (most real tail lamps at night): see after the halo below.
    let rearLit = nRed >= Math.max(2, N * 0.004);
    const lampMask = new Uint8Array(N);   // 1 = lamp + halo, 2 = glow zone (red / amber pixels there are dropped if saturated)
    if (nSeed) {
      const r1 = Math.max(1, Math.round(Math.min(w, h) * LAMP_HALO)), r2 = r1 * 2;
      const dist = new Float32Array(N).fill(1e9);   // chessboard distance to the nearest seed (two-pass)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = y * w + x; if (seed[p]) { dist[p] = 0; continue; } let d = dist[p]; if (x) d = Math.min(d, dist[p - 1] + 1); if (y) { d = Math.min(d, dist[p - w] + 1); if (x) d = Math.min(d, dist[p - w - 1] + 1); if (x < w - 1) d = Math.min(d, dist[p - w + 1] + 1); } dist[p] = d; }
      for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) { const p = y * w + x; let d = dist[p]; if (x < w - 1) d = Math.min(d, dist[p + 1] + 1); if (y < h - 1) { d = Math.min(d, dist[p + w] + 1); if (x < w - 1) d = Math.min(d, dist[p + w + 1] + 1); if (x) d = Math.min(d, dist[p + w - 1] + 1); } dist[p] = d; }
      let ring = 0, ringRed = 0;   // a BRIGHT red ring round the seeds (dim red paint round a headlight is not a lamp's glow)
      for (let p = 0; p < N; p++) {
        lampMask[p] = dist[p] <= r1 ? 1 : dist[p] <= r2 ? 2 : 0;
        if (dist[p] > 0 && dist[p] <= r1 && V[p] >= 0.2) { ring++; if ((HU[p] < 20 || HU[p] >= 320) && S[p] >= 0.3 && V[p] >= Math.max(0.45, medV + 0.15)) ringRed++; }
      }
      if (ring >= 4 && ringRed >= 0.3 * ring) rearLit = true;
    }
    const redMin = night ? RED_MIN_S.night : nSeed ? RED_MIN_S.lamps : RED_MIN_S.day;
    let total = 0, all = 0, vSum = 0, n = 0, warm = 0, dropped = 0, nDarkC = 0;
    for (let y = 0; y < h; y++) {
      const dy = (y + 0.5) / h - 0.55;
      for (let x = 0; x < w; x++) {
        const dx = (x + 0.5) / w - 0.5;
        let wt = Math.exp(-(dx * dx) / (2 * 0.3 * 0.3) - (dy * dy) / (2 * 0.32 * 0.32));   // centre of the body counts most
        const p = y * w + x, r = R[p], g = G[p], b = B[p], v = V[p], s = S[p], hue = HU[p], c = v - Math.min(r, g, b);
        vSum += v; n++;
        all += wt;
        if (lampMask[p] === 1 || (lampMask[p] === 2 && redAmber(hue) && s > Math.max(0.2, medS + 0.08))) { dropped += wt; continue; }   // lamp, its halo, its glow
        // uniform panels count more than edges, lettering and reflections (local brightness spread, 4-neighbours)
        if (x > 0 && y > 0 && x < w - 1 && y < h - 1) { const sd = (Math.abs(V[p - 1] - v) + Math.abs(V[p + 1] - v) + Math.abs(V[p - w] - v) + Math.abs(V[p + w] - v)) / 4; wt /= 1 + 6 * sd; }
        if (hue >= 20 && hue <= 45 && s > 0.35) warm++;
        let name, k = 1;
        const redHue = hue < 12 || hue >= 290;
        const gray = () => (v > GT[0] ? "white" : v > GT[1] ? "silver" : v > GT[2] ? "gray" : "black");
        if (v < 0.2) {   // also glass, tyres and deep shadow
          // dark paint at night (a red car under a streetlight sits at v ≈ 0.15–0.2): a clearly coloured dark pixel votes
          // for its hue, weakly; a black car's noise is rarely saturated AND consistent (see the consistency check below)
          // (not warm hues 12–68°: a dark yellowish-brown pixel at night is the streetlight's leftover, not paint)
          if (night && v >= 0.1 && s >= 0.4 && c >= 0.05 && !(hue >= 12 && hue < 68)) { name = redHue ? "red" : hue < 165 ? "green" : hue < 255 ? "blue" : "purple"; k = 0.5; nDarkC++; }
          else { name = "black"; k = 0.55; }
        }
        else if (s < 0.16 || c < 0.07 || neutral(r, g, b, v, hue) || (redHue && s < (night && v < 0.35 ? 0.3 : redMin))) { name = gray(); k = name === "black" ? 0.55 : 0.85; }
        else {
          k = 0.6 + s;   // saturated paint is the strongest clue
          if (hue < 12 || hue >= 335) name = !night && v < 0.35 && s < 0.5 ? "brown" : "red";   // at night a red-hued dark pixel is dark red (brown paint is orange-hued)
          else if (hue < 36) name = s < 0.38 && v > 0.55 ? "beige" : v < 0.55 ? "brown" : "orange";
          else if (hue < 68) name = s < 0.32 && v > 0.55 ? "beige" : v < 0.42 ? "brown" : "yellow";
          else if (hue < 165) name = "green";
          else if (hue < 255) { if (s < (night ? 0.42 : 0.35)) { name = gray(); k = 0.85; } else name = "blue"; }   // pale blue = sky reflected in paint or glass
          else if (hue < 290) name = "purple";
          else name = "red";
        }
        if (rearLit && (name === "red" || name === "purple" || name === "brown") && !(s >= 0.7 && v >= 0.3)) k *= 0.5;   // glow of its own lamps (strong red paint stays)
        if (dbg) dbg[p] = name[0] + (name === "gray" ? "y" : name === "black" ? "k" : name === "brown" ? "n" : "");
        sc[name] += wt * k; total += wt * k;
      }
    }
    const share = {}; COLORS.forEach((c) => (share[c] = total ? sc[c] / total : 0));
    const chrom = ["red", "blue", "green", "yellow", "orange", "brown", "beige", "purple"];
    let topC = chrom.reduce((a, b) => (share[b] > share[a] ? b : a));
    const light = ["white", "silver", "gray"].reduce((a, b) => (share[b] > share[a] ? b : a));
    const nonBlack = 1 - share.black || 1;
    const lampFrac = all ? dropped / all : 0;
    // lamps lit and a lamp-coloured answer (red, orange, purple, brown): it must be a clear majority, else the less
    // saturated reading wins (glow and reflections are what's left after the masks)
    const lampHue = (rearLit || nLens >= Math.max(2, N * 0.004)) && (topC === "red" || topC === "orange" || topC === "purple" || topC === "brown");
    const minShare = lampHue ? (night ? 0.45 : 0.35) : 0.25;
    // at night dark gray is what dark paint in shade, glass and the road all read as: a consistent colour over a quarter of
    // the body beats it (a red car at night next to its own headlights), unless the vehicle's red lamps are lit
    // (red and purple together: a blue-heavy night correction turns dark red paint magenta)
    const rp = (topC === "red" || topC === "purple") && night ? share.red + share.purple : share[topC];
    const darkPaint = night && light === "gray" && !(rearLit && lampHue) && rp / nonBlack >= 0.25 && rp >= 0.5 * share.gray;
    if (darkPaint && rp > share[topC]) { topC = share.red >= 0.8 * share.purple ? "red" : "purple"; share[topC] = rp; }
    let name, conf;
    // paint colour wins when it is a real part of the non-dark pixels and not clearly beaten by white/silver/gray
    if (share.black >= 0.7 && share[topC] < 0.15) { name = "black"; conf = Math.min(1, share.black * 1.4); }   // a dark car at night: a few coloured reflections don't make it blue / brown
    else if (share[topC] / nonBlack >= minShare && (share[topC] >= (lampHue ? 1.2 : 0.85) * share[light] || darkPaint)) { name = topC; conf = Math.min(1, (share[topC] / nonBlack) * 1.3); }
    else if (share.black >= 0.5) { name = "black"; conf = Math.min(1, share.black * 1.4); }
    else {
      name = light;
      if (name === "silver" && share.white >= 0.75 * share.silver) name = "white";   // white paint in shade reads as silver
      conf = Math.min(1, (share[name] / nonBlack) * 1.3);
    }
    // a dark vehicle at night whose colour is weak or contradictory (red glow on top, blue-white reflections below): dark,
    // not an arbitrary hue
    const fam = (c) => (c === "red" || c === "purple" || c === "brown" || c === "orange" || c === "yellow" || c === "beige" ? "warm" : "cool");
    const second = chrom.filter((c) => c !== topC).reduce((a, b) => (share[b] > share[a] ? b : a));
    let darkV = false;
    if (night && medV < 0.5 && chrom.includes(name) && share[second] / nonBlack >= 0.12 && fam(second) !== fam(topC) && share[second] >= 0.4 * share[topC]) {
      name = medV < 0.3 ? "black" : "gray"; conf = Math.min(conf, 0.4); darkV = true;
    }
    // too little body left after the lamp masks: say it, lean neutral
    const thin = lampFrac > 0.6;
    if (thin) { if (lampHue && name === topC) name = light; conf *= 0.6; }
    const meanV = n ? vSum / n : 0;
    const lowLight = meanV < 0.18 || (n && warm / n > 0.6 && name !== "orange" && name !== "yellow");   // night, or orange sodium light
    if (lowLight) conf *= 0.5;
    return { name, conf: Math.round(conf * 100) / 100, scores: share, lowLight: !!lowLight, corrected: !!(gn || M), lamps: Math.round(lampFrac * 100) / 100, thin, rearLit, dark: darkV, dbgSeeds: dbg ? [nSeed, nClip, nLens, nRed, +medV.toFixed(2), +medS.toFixed(2)] : undefined };
  }
  function neutral(r, g, b, v, hue) {
    const [L, A, B] = lab(r, g, b), C = Math.hypot(A, B);
    const warm = hue >= 15 && hue <= 70 && v < 0.5;
    return C < (NEUTRAL_C0 + NEUTRAL_CK * L) * (warm ? NEUTRAL_WARM : 1);
  }

  const NEAR = { silver: { gray: 0.7, white: 0.5, beige: 0.3 }, gray: { silver: 0.7, black: 0.35, white: 0.25 }, white: { silver: 0.5, beige: 0.3, gray: 0.25 }, black: { gray: 0.4 },
    red: { orange: 0.35, brown: 0.25, purple: 0.2 }, orange: { red: 0.35, yellow: 0.35, brown: 0.3 }, yellow: { orange: 0.4, beige: 0.25 }, brown: { beige: 0.45, orange: 0.3, red: 0.25, gray: 0.2 },
    beige: { brown: 0.45, white: 0.3, silver: 0.3, yellow: 0.25 }, blue: { purple: 0.2, gray: 0.15 }, green: {}, purple: { blue: 0.3, red: 0.2 } };
  /** 0..1: is this estimate the colour asked for? */
  function colorMatch(want, est) {
    if (!want) return 1;
    if (!est || !est.name) return 0;
    if (est.name === want) return 1;
    const near = (NEAR[want] && NEAR[want][est.name]) || 0;
    const sh = est.scores ? est.scores[want] || 0 : 0;   // a strong second colour (two-tone bus, livery) also counts
    return Math.max(near, sh >= 0.15 ? Math.min(0.8, sh * 2.5) : 0);
  }

  /** Make/model prompts for CLIP zero-shot: [{make, model, prompt}] */
  function makePrompts() {
    const out = [];
    for (const mk of MAKES) for (const [m] of mk.models) out.push({ make: mk.make, model: m, prompt: "a photo of a " + mk.make + " " + m + ", a type of car." });
    return out;
  }

  const api = { COLORS, TYPES, MAKES, parse, colorFromPixels, colorMatch, makePrompts, lab };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root && typeof window !== "undefined") { root.TDC = root.TDC || {}; root.TDC.vehicleAttrs = api; }
})(typeof window !== "undefined" ? window : globalThis);
