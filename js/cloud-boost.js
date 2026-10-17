/* cloud-boost.js — Phase 6 part B: OPTIONAL cloud boost on top of the on-device plate reader and detector.
 * Off by default. The user picks Grok (xAI), Claude (Anthropic) or Gemini (Google) and pastes their OWN API key.
 * The key stays in this tab (sessionStorage) unless "Remember key" is ticked (localStorage); it is sent only to the
 * chosen provider's API host (or to the local companion proxy on 127.0.0.1 if the user turns that on). Before the first
 * send to a provider, a consent dialog says that frames leave the device and that calls cost money.
 * Uses: (1) re-check low-confidence plate readings (sends a small crop around the plate),
 *       (2) "ask <anything>" searches on a few sampled frames (sends downscaled frames), returning JSON boxes.
 * Rate limited (one call at a time, minimum gap, max calls per run). Any failure → a readable message; nothing else changes. */
(function () {
  "use strict";
  const T = (window.TDC = window.TDC || {});
  const KEY = "tdc.cloud.v1", SECRET = "tdc.cloud.key.";
  const PROVIDERS = {
    grok: { label: "Grok (xAI)", host: "api.x.ai", url: "https://api.x.ai/v1/chat/completions", model: "grok-4.3", keyHint: "xai-…", docs: "https://docs.x.ai/docs/models" },
    claude: { label: "Claude (Anthropic)", host: "api.anthropic.com", url: "https://api.anthropic.com/v1/messages", model: "claude-haiku-5-5", keyHint: "sk-ant-…", docs: "https://docs.anthropic.com/en/docs/about-claude/models/overview" },
    gemini: { label: "Gemini (Google)", host: "generativelanguage.googleapis.com", url: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", model: "gemini-3.5-flash-lite", keyHint: "AIza…", docs: "https://ai.google.dev/gemini-api/docs/models" },
  };
  const C = (T.cloud = { PROVIDERS, calls: 0, busy: false, log: [] });
  C.defaults = () => ({ provider: "off", models: {}, remember: false, maxCalls: 12, gapMs: 1500, maxPx: 1024, viaCompanion: false, consent: {} });
  C.prefs = () => { const d = C.defaults(); try { const v = JSON.parse(localStorage.getItem(KEY) || "null"); if (v && typeof v === "object") { if (v.provider !== "off" && !PROVIDERS[v.provider]) v.provider = "off"; return { ...d, ...v, consent: { ...(v.consent || {}) } }; } } catch (_) {} return d; };
  C.setPref = (k, v) => { const p = C.prefs(); p[k] = v; try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (_) {} C.renderSettings(); };
  C.provider = () => { const p = C.prefs().provider; return PROVIDERS[p] ? p : null; };
  C.model = (prov) => (C.prefs().models || {})[prov] || PROVIDERS[prov].model;

  // ── API key: this tab only, unless "Remember key" ──
  C.getKey = (prov) => { try { return sessionStorage.getItem(SECRET + prov) || localStorage.getItem(SECRET + prov) || ""; } catch (_) { return ""; } };
  C.setKey = (prov, key, remember) => {
    try {
      sessionStorage.removeItem(SECRET + prov); localStorage.removeItem(SECRET + prov);
      key = String(key || "").trim();
      if (key) (remember ? localStorage : sessionStorage).setItem(SECRET + prov, key);
    } catch (_) {}
  };
  C.forgetKeys = () => { for (const k of Object.keys(PROVIDERS)) C.setKey(k, ""); };
  C.ready = () => { const p = C.provider(); return !!p && !!C.getKey(p); };

  // ── consent ──
  C.confirm = (prov, what, calls) => new Promise((resolve) => {
    const P = PROVIDERS[prov];
    const wrap = document.createElement("div"); wrap.className = "modal"; wrap.id = "cloudConsent"; wrap.style.zIndex = "80";
    wrap.innerHTML = '<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="cloudConsentT"><div class="modal-head"><h2 id="cloudConsentT">Send frames to ' + P.label + "?</h2></div>" +
      '<div class="modal-body"><p><b>Pictures from your footage will leave this device.</b> ' + what + " will be sent to <b>" + P.host + "</b> (" + P.label + ") with your API key, and nowhere else.</p>" +
      "<p>About <b>" + calls + " call" + (calls === 1 ? "" : "s") + "</b>, each with one JPEG (≤ " + C.prefs().maxPx + " px, roughly 1–2 thousand input tokens). Each call is billed to your " + P.label + " account; check their pricing. The provider's own data policy applies.</p>" +
      '<label class="row"><span>Don\'t ask again for ' + P.label + '</span><input type="checkbox" id="cloudConsentKeep"></label></div>' +
      '<div class="modal-foot"><button class="btn ghost" id="cloudConsentNo">Cancel</button><button class="btn primary" id="cloudConsentYes">Send</button></div></div>';
    document.body.appendChild(wrap);
    const done = (v) => { if (v && wrap.querySelector("#cloudConsentKeep").checked) { const c = C.prefs().consent; c[prov] = true; C.setPref("consent", c); } wrap.remove(); resolve(v); };
    wrap.querySelector("#cloudConsentYes").onclick = () => done(true);
    wrap.querySelector("#cloudConsentNo").onclick = () => done(false);
    wrap.querySelector("#cloudConsentYes").focus();
  });
  async function consent(prov, what, calls) { if (C.prefs().consent[prov]) return true; return C.confirm(prov, what, calls); }

  // ── images ──
  let cv = null;
  /** Draw (a crop of) img into a JPEG data URL, longest side ≤ maxPx (and ≥ minPx for small crops). */
  C.jpeg = (img, iw, ih, crop, minPx) => {
    const c = crop || { x: 0, y: 0, w: 1, h: 1 }, sw = iw * c.w, sh = ih * c.h, maxPx = C.prefs().maxPx;
    let s = Math.min(1, maxPx / Math.max(sw, sh)); if (minPx && Math.max(sw, sh) * s < minPx) s = Math.min(maxPx / Math.max(sw, sh), minPx / Math.max(sw, sh));
    cv = cv || document.createElement("canvas"); cv.width = Math.max(8, Math.round(sw * s)); cv.height = Math.max(8, Math.round(sh * s));
    cv.getContext("2d").drawImage(img, iw * c.x, ih * c.y, sw, sh, 0, 0, cv.width, cv.height);
    return cv.toDataURL("image/jpeg", 0.85);
  };

  // ── prompts + parsing ──
  const BOX_RULE = 'Coordinates are fractions of the image width/height (0 to 1), box = [x, y, w, h] with x,y the top-left corner. Reply with JSON only, no prose.';
  C.prompt = (task, q) => task === "plate"
    ? 'This is a crop from a car dashcam around one licence plate (likely a US / California plate, format like 1ABC234). Read the plate characters exactly. Use "?" for a character you cannot see. ' + BOX_RULE + ' Schema: {"plates":[{"text":"1ABC234","confidence":0.0-1.0,"box":[x,y,w,h]}]}. If there is no readable plate, return {"plates":[]}.'
    : 'This is one frame from a car dashcam. Find every instance of: "' + String(q).replace(/"/g, "'").slice(0, 200) + '". ' + BOX_RULE + ' Schema: {"objects":[{"label":"short name","text":"any readable text on it or empty","confidence":0.0-1.0,"box":[x,y,w,h]}]}. If there is none, return {"objects":[]}.';
  /** Pull the first JSON object out of a model reply and normalise boxes. Accepts [x,y,w,h] 0..1, {x,y,w,h}, or Gemini box_2d [ymin,xmin,ymax,xmax] 0..1000. */
  C.parse = (text) => {
    const s = String(text || ""); const a = s.indexOf("{"), z = s.lastIndexOf("}");
    if (a < 0 || z <= a) throw new Error("the reply had no JSON");
    let j; try { j = JSON.parse(s.slice(a, z + 1)); } catch (e) { throw new Error("the reply's JSON could not be read"); }
    const list = j.plates || j.objects || j.items || (Array.isArray(j) ? j : []);
    const clamp = (v) => Math.max(0, Math.min(1, +v || 0));
    return list.map((o) => {
      let b = o.box || o.bbox || null;
      if (o.box_2d && o.box_2d.length === 4) { const [y0, x0, y1, x1] = o.box_2d.map((v) => +v / 1000); b = [x0, y0, x1 - x0, y1 - y0]; }
      if (b && !Array.isArray(b)) b = [b.x, b.y, b.w, b.h];
      if (b && b.some((v) => +v > 1.5)) b = b.map((v) => +v / 1000);   // 0..1000 by mistake
      const box = b && b.length === 4 ? { x: clamp(b[0]), y: clamp(b[1]), w: clamp(b[2]), h: clamp(b[3]) } : null;
      return { label: String(o.label || (j.plates ? "plate" : "object")).slice(0, 40), text: j.plates ? String(o.text || "").toUpperCase().replace(/[^A-Z0-9?]/g, "") : String(o.text || "").slice(0, 60), conf: clamp(o.confidence != null ? o.confidence : o.conf != null ? o.conf : 0.5), box: box && box.w > 0 && box.h > 0 ? box : null };
    });
  };

  // ── providers ──
  C.request = (prov, key, model, prompt, dataUrl) => {
    const b64 = dataUrl.split(",")[1];
    if (prov === "grok") return { url: PROVIDERS.grok.url, headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: { model, temperature: 0, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUrl, detail: "high" } }, { type: "text", text: prompt }] }] } };
    if (prov === "claude") return { url: PROVIDERS.claude.url, headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: { model, max_tokens: 1024, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } }, { type: "text", text: prompt }] }] } };
    if (prov === "gemini") return { url: PROVIDERS.gemini.url.replace("{model}", encodeURIComponent(model)), headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: { contents: [{ role: "user", parts: [{ inline_data: { mime_type: "image/jpeg", data: b64 } }, { text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: "application/json" } } };
    throw new Error("unknown provider");
  };
  C.replyText = (prov, j) => {
    if (prov === "grok") return j && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : "";
    if (prov === "claude") return ((j && j.content) || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (prov === "gemini") return ((j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map((p) => p.text || "").join("\n");
    return "";
  };
  const errText = (prov, status, j) => {
    const m = (j && ((j.error && (j.error.message || j.error)) || j.message)) || "";
    if (status === 401 || status === 403) return PROVIDERS[prov].label + " refused the API key (" + status + "). Check the key in Settings ▸ Cloud boost.";
    if (status === 429) return PROVIDERS[prov].label + " rate limit or quota reached (429). Try later or lower the calls per run.";
    if (status === 404) return PROVIDERS[prov].label + " doesn't know the model “" + C.model(prov) + "” (404). Pick another model name in Settings.";
    return PROVIDERS[prov].label + " error " + status + (m ? ": " + String(m).slice(0, 160) : "");
  };

  let last = 0;
  /** One rate-limited call. → [{label,text,conf,box}] */
  C.ask = async (task, dataUrl, q) => {
    const prov = C.provider(); if (!prov) throw new Error("Cloud boost is off.");
    const key = C.getKey(prov); if (!key) throw new Error("Paste your " + PROVIDERS[prov].label + " API key in Settings ▸ Cloud boost first.");
    const gap = C.prefs().gapMs, wait = last + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const req = C.request(prov, key, C.model(prov), C.prompt(task, q), dataUrl);
    const P = C.prefs(), companion = P.viaCompanion && T.auto && T.auto.companion && T.auto.token;
    let r;
    try {
      r = companion
        ? await fetch("/api/cloud", { method: "POST", headers: { "Content-Type": "application/json", "X-TDC-Token": T.auto.token }, body: JSON.stringify({ url: req.url, headers: req.headers, body: req.body }) })
        : await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), credentials: "omit", referrerPolicy: "no-referrer" });
    } catch (e) { throw new Error("Couldn't reach " + PROVIDERS[prov].host + " (" + (e.message || e) + "). Offline, or the browser blocked it (CORS)." + (companion ? "" : " If it keeps failing, the local companion can relay it: Settings ▸ Cloud boost ▸ Use companion.")); }
    C.calls++;
    let j = null; try { j = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(errText(prov, r.status, j));
    const out = C.parse(C.replyText(prov, j));
    C.log.push({ at: Date.now(), prov, task, n: out.length }); if (C.log.length > 50) C.log.shift();
    return out;
  };

  const plausible = (t) => /^[A-Z0-9]{2,8}$/.test(t);
  /** Use 1: re-check weak plate readings of the open event. ui: {status, stopped} → {checked, changed} */
  C.recheckPlates = async (ev, ui) => {
    ui = ui || {}; const say = ui.status || (() => {}), stopped = ui.stopped || (() => false);
    const prov = C.provider(); if (!C.ready()) throw new Error(prov ? "Paste your " + PROVIDERS[prov].label + " API key in Settings ▸ Cloud boost first." : "Pick a cloud provider in Settings ▸ Cloud boost first.");
    const X = T.libIndex.text, sc = X.get(ev.id); if (!sc) throw new Error("Search this event for plates first.");
    const L = T.plates, minRead = L.prefs().minRead;
    // one item per (camera, reading) cluster: the weakest-looking ones first
    const seen = new Set(), todo = [], keyOf = (i) => i.cam + "|" + i.text + "|" + Math.round(i.t / 4);
    const weak = sc.items.filter((i) => i.kind === "plate" && !i.cloud && i.conf < minRead);
    const groups = new Map(); for (const i of weak) { const k = keyOf(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
    for (const it of weak.slice().sort((a, b) => a.conf - b.conf)) { const k = keyOf(it); if (seen.has(k)) continue; seen.add(k); todo.push(it); }
    const max = Math.min(todo.length, C.prefs().maxCalls);
    if (!max) return { checked: 0, changed: 0 };
    if (!(await consent(prov, "Small crops around " + max + " plate" + (max === 1 ? "" : "s"), max))) throw new Error("cancelled");
    let changed = 0, checked = 0;
    C.busy = true;
    try {
      for (const it of todo.slice(0, max)) {
        if (stopped()) break;
        say("Asking " + PROVIDERS[prov].label + " about plate " + (checked + 1) + " of " + max + "…");
        const f = await L.grab(it.cam, it.t); if (!f) continue;
        const b = it.box, crop = { x: Math.max(0, b.x - b.w * 0.6), y: Math.max(0, b.y - b.h * 1.2), w: Math.min(1, b.w * 2.2), h: Math.min(1, b.h * 3.4) };
        crop.w = Math.min(crop.w, 1 - crop.x); crop.h = Math.min(crop.h, 1 - crop.y);
        const res = await C.ask("plate", C.jpeg(f.img, f.w, f.h, crop, 320));
        checked++;
        const best = res.filter((x) => plausible(x.text)).sort((a, c) => c.conf - a.conf)[0];
        const group = groups.get(keyOf(it)) || [it];
        if (!best) { for (const o of group) o.cloud = { prov, text: null, conf: 0 }; continue; }
        // every reading of the same plate in the same ~4 s cluster gets the cloud answer too
        for (const o of group) {
          o.cloud = { prov, text: best.text, conf: best.conf, local: o.text };
          if (best.text !== o.text) { o.localText = o.text; o.text = best.text; changed++; }
          o.conf = Math.max(o.conf, Math.min(0.95, best.conf));
        }
      }
    } finally { C.busy = false; }
    await X.put(sc);
    return { checked, changed };
  };

  /** Use 2: open-vocabulary "ask <anything>" on sampled frames of the open event. → rows for search.js */
  C.handlesQuery = (q) => C.provider() && /^(ask|cloud)\s*:?\s+\S/i.test(String(q || "").trim());
  C.queryOf = (q) => String(q || "").trim().replace(/^(ask|cloud)\s*:?\s+/i, "");
  C.estimate = (ev, cams) => Math.min(C.prefs().maxCalls, Math.max(1, Math.ceil(ev.duration / 2)) * cams.length);
  C.find = async (q, ev, cams, ui) => {
    ui = ui || {}; const say = ui.status || (() => {}), stopped = ui.stopped || (() => false);
    const prov = C.provider(); if (!C.ready()) throw new Error(prov ? "Paste your " + PROVIDERS[prov].label + " API key in Settings ▸ Cloud boost first." : "Pick a cloud provider in Settings ▸ Cloud boost first.");
    const what = C.queryOf(q);
    cams = cams.filter((c) => ev.clips.some((clip) => clip.files[c] && clip.files[c].blob));
    const n = C.estimate(ev, cams), per = Math.max(1, Math.floor(n / cams.length));
    if (!(await consent(prov, n + " downscaled frame" + (n === 1 ? "" : "s"), n))) throw new Error("cancelled");
    const rows = []; let k = 0;
    C.busy = true;
    try {
      for (const cam of cams) for (let i = 0; i < per; i++) {
        if (stopped()) break;
        const t = Math.min(ev.duration - 0.1, (i + 0.5) * ev.duration / per);
        k++; say("Asking " + PROVIDERS[prov].label + " · frame " + k + " of " + n + " · " + cam + ". Frames are being sent to " + PROVIDERS[prov].host + ".");
        const f = await T.plates.grab(cam, t); if (!f) continue;
        const res = await C.ask("find", C.jpeg(f.img, f.w, f.h), what);
        for (const o of res) if (o.box) rows.push({ t, cam, score: o.conf, conf: o.conf, label: o.label || what, text: (o.text ? o.text + " " : "") + Math.round(o.conf * 100) + "% · " + PROVIDERS[prov].label.split(" ")[0], det: true, cloud: prov, box: o.box });
      }
    } finally { C.busy = false; }
    return rows;
  };

  // ── Settings ▸ Cloud boost ──
  C.renderSettings = () => {
    const box = document.getElementById("setCloud"); if (!box) return;
    const P = C.prefs(), prov = C.provider();
    box.innerHTML = "";
    const row = (html) => { const d = document.createElement("div"); d.className = "row"; d.innerHTML = html; box.appendChild(d); return d; };
    row('<span>Provider</span><select class="select" id="cbProvider"><option value="off"' + (!prov ? " selected" : "") + ">Off (default: nothing leaves this device)</option>" + Object.entries(PROVIDERS).map(([k, p]) => '<option value="' + k + '"' + (k === prov ? " selected" : "") + ">" + p.label + "</option>").join("") + "</select>");
    if (prov) {
      const have = !!C.getKey(prov);
      row('<span>API key</span><input class="input" type="password" id="cbKey" autocomplete="off" spellcheck="false" placeholder="' + PROVIDERS[prov].keyHint + '" value="">');
      box.querySelector("#cbKey").value = have ? "••••••••" : "";
      row('<label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" id="cbRemember"' + (P.remember ? " checked" : "") + "> Remember key on this device (otherwise only this tab)</label>");
      row('<span>Model</span><input class="input" id="cbModel" spellcheck="false" value="' + C.model(prov).replace(/"/g, "") + '">');
      row('<span>Calls per run (max)</span><input class="input" type="number" id="cbMax" min="1" max="60" value="' + P.maxCalls + '">');
      if (T.auto && T.auto.companion) row('<label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" id="cbProxy"' + (P.viaCompanion ? " checked" : "") + "> Use companion (relay through 127.0.0.1 if the browser blocks the provider)</label>");
      const note = document.createElement("p"); note.className = "hint";
      note.textContent = "Optional. Used only when you ask: “Re-check weak plates” after a plate search, or a search starting with “ask ”, e.g. ask a red umbrella. Frames (downscaled) or plate crops go to " + PROVIDERS[prov].host + " with your key, and nowhere else. You'll be asked before the first send. Calls are billed to your account.";
      box.appendChild(note);
      const b = document.createElement("button"); b.className = "btn ghost"; b.id = "cbForget"; b.textContent = "Forget API keys"; box.appendChild(b);
      b.onclick = () => { C.forgetKeys(); C.setPref("consent", {}); T.toast && T.toast("Cloud API keys forgotten", "ok"); };
      const save = () => { const v = box.querySelector("#cbKey").value; if (v && !/^•+$/.test(v)) C.setKey(prov, v, box.querySelector("#cbRemember").checked); };
      box.querySelector("#cbKey").onchange = save;
      box.querySelector("#cbRemember").onchange = (e) => { const k = C.getKey(prov); C.setPref("remember", e.target.checked); if (k) C.setKey(prov, k, e.target.checked); };
      box.querySelector("#cbModel").onchange = (e) => { const m = { ...(C.prefs().models || {}) }; m[prov] = e.target.value.trim() || PROVIDERS[prov].model; C.setPref("models", m); };
      box.querySelector("#cbMax").onchange = (e) => C.setPref("maxCalls", Math.max(1, Math.min(60, +e.target.value || 12)));
      const px = box.querySelector("#cbProxy"); if (px) px.onchange = (e) => C.setPref("viaCompanion", e.target.checked);
    } else {
      const note = document.createElement("p"); note.className = "hint"; note.textContent = "Off. Plates, text and objects are found on this device only."; box.appendChild(note);
    }
    box.querySelector("#cbProvider").onchange = (e) => C.setPref("provider", e.target.value);
  };

  /** "Re-check weak plates with <provider>" button under the Find status (only when it applies). */
  C.syncButton = () => {
    try {
      const S = T.search, ev = T.player && T.player.ev, prov = C.provider();
      const sc = ev && T.libIndex && T.libIndex.text && T.libIndex.text.get(ev.id);
      const weak = sc && T.plates ? sc.items.filter((i) => i.kind === "plate" && !i.cloud && i.conf < T.plates.prefs().minRead).length : 0;
      const show = !!(prov && S && S.hits && S.hits.some((h) => h.plate) && weak);
      // one button under the classic Find status and one under the floating search status (whichever is visible)
      for (const [id, after] of [["btnCloudRecheck", "findStatus"], ["usCloudRecheck", "usStatus"]]) {
        let b = document.getElementById(id);
        const anchor = document.getElementById(after);
        if (!b && (!show || !anchor)) continue;
        if (!b) {
          b = document.createElement("button"); b.type = "button"; b.className = "btn ghost small"; b.id = id;
          b.style.cssText = "margin:4px 0 2px;align-self:flex-start;font-size:12px;padding:4px 10px";
          anchor.insertAdjacentElement("afterend", b);
          b.onclick = C.runRecheck;
        }
        b.hidden = !show;
        if (show) b.textContent = "Re-check " + weak + " weak plate" + (weak === 1 ? "" : "s") + " with " + PROVIDERS[prov].label.split(" ")[0];
      }
    } catch (_) {}
  };
  C.runRecheck = async () => {
    const st = document.getElementById("findStatus"), say = (s) => { if (st) { st.hidden = false; st.textContent = s; } };
    if (C.busy) return;
    try { const r = await C.recheckPlates(T.player.ev, { status: say }); say(PROVIDERS[C.provider()].label + " checked " + r.checked + " weak reading" + (r.checked === 1 ? "" : "s") + (r.changed ? ", corrected " + r.changed + "." : ", no changes.") + " Search again to use them."); }
    catch (e) { say(String(e.message) === "cancelled" ? "Nothing was sent." : "Cloud check failed: " + (e.message || e)); }
    C.syncButton();
  };

  C.init = () => {
    try {
      C.renderSettings();
      if (T.on) { T.on("textindex", C.syncButton); T.on("player-open", C.syncButton); }
    } catch (e) { console.warn("cloud init", e); }
  };
})();
