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

  /** rgba = Uint8ClampedArray of a w×h crop of ONE vehicle (box from the detector). → { name, conf, scores, lowLight } */
  function colorFromPixels(rgba, w, h) {
    const sc = {}; COLORS.forEach((c) => (sc[c] = 0));
    let total = 0, vSum = 0, n = 0, warm = 0;
    for (let y = 0; y < h; y++) {
      const dy = (y + 0.5) / h - 0.55;
      for (let x = 0; x < w; x++) {
        const dx = (x + 0.5) / w - 0.5;
        const wt = Math.exp(-(dx * dx) / (2 * 0.3 * 0.3) - (dy * dy) / (2 * 0.32 * 0.32));   // centre of the body counts most
        const i = (y * w + x) * 4, r = rgba[i] / 255, g = rgba[i + 1] / 255, b = rgba[i + 2] / 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx, c = mx - mn, s = mx ? c / mx : 0;
        let hue = 0;
        if (c > 1e-6) { if (mx === r) hue = ((g - b) / c) % 6; else if (mx === g) hue = (b - r) / c + 2; else hue = (r - g) / c + 4; hue *= 60; if (hue < 0) hue += 360; }
        vSum += v; n++;
        if (hue >= 20 && hue <= 45 && s > 0.35) warm++;
        let name, k = 1;
        const gray = () => (v > 0.72 ? "white" : v > 0.5 ? "silver" : v > 0.28 ? "gray" : "black");
        if (v < 0.2) { name = "black"; k = 0.55; }   // also glass, tyres and deep shadow
        else if (s < 0.16 || c < 0.07) { name = gray(); k = name === "black" ? 0.55 : 0.85; }
        else {
          k = 0.6 + s;   // saturated paint is the strongest clue
          if (hue < 12 || hue >= 335) name = v < 0.35 && s < 0.5 ? "brown" : "red";
          else if (hue < 36) name = s < 0.38 && v > 0.55 ? "beige" : v < 0.55 ? "brown" : "orange";
          else if (hue < 68) name = s < 0.32 && v > 0.55 ? "beige" : v < 0.42 ? "brown" : "yellow";
          else if (hue < 165) name = "green";
          else if (hue < 255) { if (s < 0.35) { name = gray(); k = 0.85; } else name = "blue"; }   // pale blue = sky reflected in paint or glass
          else if (hue < 290) name = "purple";
          else name = "red";
        }
        sc[name] += wt * k; total += wt * k;
      }
    }
    const share = {}; COLORS.forEach((c) => (share[c] = total ? sc[c] / total : 0));
    const chrom = ["red", "blue", "green", "yellow", "orange", "brown", "beige", "purple"];
    const topC = chrom.reduce((a, b) => (share[b] > share[a] ? b : a));
    const light = ["white", "silver", "gray"].reduce((a, b) => (share[b] > share[a] ? b : a));
    const nonBlack = 1 - share.black || 1;
    let name, conf;
    // paint colour wins when it is a real part of the non-dark pixels and not clearly beaten by white/silver/gray
    if (share[topC] / nonBlack >= 0.25 && share[topC] >= 0.85 * share[light]) { name = topC; conf = Math.min(1, (share[topC] / nonBlack) * 1.3); }
    else if (share.black >= 0.5) { name = "black"; conf = Math.min(1, share.black * 1.4); }
    else {
      name = light;
      if (name === "silver" && share.white >= 0.75 * share.silver) name = "white";   // white paint in shade reads as silver
      conf = Math.min(1, (share[name] / nonBlack) * 1.3);
    }
    const meanV = n ? vSum / n : 0;
    const lowLight = meanV < 0.18 || (n && warm / n > 0.6 && name !== "orange" && name !== "yellow");   // night, or orange sodium light
    if (lowLight) conf *= 0.5;
    return { name, conf: Math.round(conf * 100) / 100, scores: share, lowLight: !!lowLight };
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

  const api = { COLORS, TYPES, MAKES, parse, colorFromPixels, colorMatch, makePrompts };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root && typeof window !== "undefined") { root.TDC = root.TDC || {}; root.TDC.vehicleAttrs = api; }
})(typeof window !== "undefined" ? window : globalThis);
