/* text-search.js — read the text in an event once, then find it and blur it.
 * One OCR pass (redact.js: bundled PP-OCR in ONNX Runtime WASM, on this device) over every camera's sampled frames
 * builds an index of text lines {t, cam, box, text, conf}. Searching ("text Zender Bakery", "\"4821\"", ZENDER BAKERY)
 * and text redaction ("blur Quillby Ave", All text, Street signs) both read that index, so a second query on the same
 * event is instant. Samples are 1 s apart (wider on long events / phones), with extra samples where text appears or
 * disappears; redact.js links the boxes into tracks and interpolates between samples, so the blur follows the text.
 * Results carry the time, the camera and a small thumbnail of the frame. Off switch: Settings ▸ Search ▸
 * "Show text search & redaction (beta)" (TS.on()). If this file is missing, redaction falls back to its old per-frame path. */
(function () {
  "use strict";
  const T = window.TDC;
  const TS = (T.textSearch = { index: new Map(), scanning: false });
  const TM = () => T.textMatch;
  const $ = (id) => document.getElementById(id);
  const CAM_LABEL = { front: "Front", back: "Rear", left_repeater: "Left repeater", right_repeater: "Right repeater", left_pillar: "Left pillar", right_pillar: "Right pillar" };
  const isMobile = () => (T.detect && T.detect.isMobile ? T.detect.isMobile() : /iPhone|iPad|Android/i.test(navigator.userAgent));

  // ── the beta switch (remembered) ──
  const KEY = "tdc.textSearch.v1";
  TS.DEFAULT_ON = true;
  TS.on = () => { try { const v = localStorage.getItem(KEY); return v == null ? TS.DEFAULT_ON : v === "1"; } catch (_) { return TS.DEFAULT_ON; } };
  TS.setOn = (on) => {
    try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (_) {}
    document.body.classList.toggle("no-text-search", !on);
    const c = $("setTextSearch"); if (c) c.checked = !!on;
    if (!on && T.redact && T.redact.clearText) T.redact.clearText();
    if (T.searchUI && T.searchUI.syncText) T.searchUI.syncText();
    T.emit && T.emit("text-search", !!on);
  };

  TS.parseQuery = (q) => (TM() ? TM().parseTextQuery(q) : null);
  TS.camsWithVideo = (ev) => (T.GRID || ["front", "back", "left_repeater", "right_repeater", "left_pillar", "right_pillar"]).filter((c) => ev.clips.some((clip) => clip.files[c] && clip.files[c].blob));
  /** Seconds between samples: 1 s, wider when the event × cameras would exceed the frame budget. */
  TS.stepFor = (ev, cams) => {
    const budget = isMobile() ? 240 : 720, min = isMobile() ? 1.5 : 1;
    return Math.min(4, Math.max(min, Math.ceil((ev.duration * cams.length / budget) * 4) / 4));
  };

  let vid = null, cv = null, cx = null;
  async function grab(ev, cam, t) {
    const clip = ev.clips[T.player.clipIndexAt(t)], it = clip && clip.files[cam];
    if (!it || !it.blob) return null;
    vid = vid || Object.assign(document.createElement("video"), { muted: true, playsInline: true, preload: "auto" });
    await T.search.seekSample(vid, it, Math.max(0, t - clip.start));
    if (!vid.videoWidth) return null;
    const w = Math.min(isMobile() ? 1280 : 1920, vid.videoWidth), h = Math.round(vid.videoHeight * (w / vid.videoWidth));   // full resolution: small text is read from real pixels
    cv = cv || document.createElement("canvas"); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    cx = cx || cv.getContext("2d", { willReadFrequently: true });
    cx.drawImage(vid, 0, 0, w, h);
    return cv;
  }
  async function thumb(canvas, lines) {
    try {
      const c = document.createElement("canvas"); c.width = 128; c.height = Math.round(128 * canvas.height / canvas.width);
      const x = c.getContext("2d"); x.drawImage(canvas, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => (c.toBlob ? c.toBlob(r, "image/jpeg", 0.7) : r(null)));
      return blob ? URL.createObjectURL(blob) : null;
    } catch (_) { return null; }
  }
  const sig = (lines) => lines.filter((l) => l.text).map((l) => TM().canon(l.text)).sort().join("|");

  /** Read every camera of the event (only what isn't in the index yet). ui: {status(text), stopped()} */
  TS.scan = async (ev, cams, ui) => {
    ui = ui || {}; const say = ui.status || (() => {}), stopped = ui.stopped || (() => false);
    cams = (cams || TS.camsWithVideo(ev)).filter((c) => TS.camsWithVideo(ev).includes(c));
    if (!cams.length) throw new Error("No playable camera in this event yet. Unlock encrypted clips first.");
    if (!T.redact || !T.redact.ocrFrame) throw new Error("The text reader (redact.js) is missing.");
    let X = TS.index.get(ev.id);
    const step = X ? X.step : TS.stepFor(ev, cams);
    if (!X) { X = { eventId: ev.id, step, samples: {}, thumbs: [], errors: 0, frames: 0, ms: 0 }; TS.index.set(ev.id, X); }
    const todo = [];
    for (const cam of cams) {
      const have = new Set((X.samples[cam] || []).map((s) => s.t.toFixed(2)));
      for (let t = Math.min(0.25, ev.duration / 2); t < ev.duration - 0.05; t += step) if (!have.has(t.toFixed(2))) todo.push({ cam, t });
    }
    if (!todo.length) return X;
    TS.scanning = true;
    const t0 = performance.now(), dark = {};
    let n = 0, total = todo.length, fails = 0;
    const one = async (cam, t) => {
      const f = await grab(ev, cam, t); if (!f) return null;
      if (dark[cam] == null) dark[cam] = T.redact.isDark ? T.redact.isDark(f) : false;
      const lines = await T.redact.ocrFrame(f, { night: dark[cam] });
      const s = { t: Math.round(t * 100) / 100, lines };
      if (lines.some((l) => l.text) && X.thumbs.length < 400) { s.thumb = await thumb(f, lines); if (s.thumb) X.thumbs.push(s.thumb); }
      (X.samples[cam] = X.samples[cam] || []).push(s);
      X.frames++;
      return s;
    };
    try {
      await T.redact.loadText();
      for (const job of todo) {
        if (stopped()) throw new Error("stopped");
        n++;
        say("Reading text · frame " + n + " of " + total + " · " + (CAM_LABEL[job.cam] || job.cam) + " · " + T.fmtTime(job.t, true) + ". Read on this device; the video is not uploaded.");
        try { await one(job.cam, job.t); }
        catch (err) { fails++; X.errors++; console.warn("text: frame skipped", job, err); if (fails >= 6 && fails === n) throw err; }
        if ((n & 3) === 0) await new Promise((r) => setTimeout(r, 0));
      }
      // extra samples halfway where the text changes (appears, leaves, moves on): sharper start / end of the blur
      const extra = [];
      for (const cam of cams) {
        const list = (X.samples[cam] || []).slice().sort((a, b) => a.t - b.t);
        for (let i = 1; i < list.length; i++) if (list[i].t - list[i - 1].t > step * 0.75 && sig(list[i].lines) !== sig(list[i - 1].lines)) extra.push({ cam, t: (list[i].t + list[i - 1].t) / 2 });
      }
      const cap = Math.ceil(total * 0.6);
      for (const job of extra.slice(0, cap)) {
        if (stopped()) throw new Error("stopped");
        n++;
        say("Reading text · checking where it starts and ends · " + (CAM_LABEL[job.cam] || job.cam) + " · " + T.fmtTime(job.t, true) + ".");
        try { await one(job.cam, job.t); } catch (err) { X.errors++; console.warn("text: frame skipped", job, err); }
      }
    } finally {
      TS.scanning = false;
      for (const cam of Object.keys(X.samples)) X.samples[cam].sort((a, b) => a.t - b.t);
      X.ms += Math.round(performance.now() - t0);
    }
    if (fails && T.redact.lastOcrError) X.lastError = String(T.redact.lastOcrError.message || T.redact.lastOcrError);
    return X;
  };
  TS.scanned = (ev, cams) => { const X = TS.index.get(ev.id); return !!X && cams.every((c) => X.samples[c]); };
  TS.forget = (evId) => { const X = TS.index.get(evId); if (X) { for (const u of X.thumbs) URL.revokeObjectURL(u); TS.index.delete(evId); } };

  /** Boxes to hide per sample: {cam: [{t, boxes}]}. want: {phrases:[…], all, sign} */
  TS.redactSamples = (ev, want) => {
    const X = TS.index.get(ev.id), M = TM(), out = {};
    if (!X || !M) return out;
    const phrases = (want.phrases || []).filter(Boolean);
    for (const cam of Object.keys(X.samples)) {
      out[cam] = X.samples[cam].map((s) => {
        const boxes = [];
        for (const l of s.lines) {
          const letters = (l.text.match(/[A-Za-z0-9]/g) || []).length;
          if (want.all) { boxes.push({ ...l.box, text: l.text, conf: l.conf }); continue; }
          if (want.sign && letters >= 3 && l.box.y < 0.62 && /[A-Za-z]{2}/.test(l.text)) { boxes.push({ ...l.box, text: l.text, conf: l.conf }); continue; }
          if (phrases.some((p) => M.phraseScore(p, l.text) >= 0.6)) boxes.push({ ...l.box, text: l.text, conf: l.conf, hitPhrase: true });
        }
        // a generic word of the phrase read as its own box next to a matched one ("AVE" beside "QUILLBY")
        if (phrases.length) for (const l of s.lines) {
          if (boxes.some((b) => b.x === l.box.x && b.y === l.box.y)) continue;
          const nb = boxes.find((b) => b.hitPhrase && Math.abs((b.y + b.h / 2) - (l.box.y + l.box.h / 2)) < Math.max(b.h, l.box.h) * 0.6 && Math.min(Math.abs(l.box.x - (b.x + b.w)), Math.abs(b.x - (l.box.x + l.box.w))) < b.h * 3);
          if (nb && phrases.some((p) => M.genericNeighbour(p, l.text))) boxes.push({ ...l.box, text: l.text, conf: l.conf });
        }
        return { t: s.t, boxes };
      });
    }
    return out;
  };

  /** Search results for a phrase: one per camera and stretch of time where it was read (best reading kept). */
  TS.find = (ev, phrase, cams) => {
    const X = TS.index.get(ev.id), M = TM(); if (!X || !M) return [];
    const rows = [];
    for (const cam of Object.keys(X.samples)) {
      if (cams && !cams.includes(cam)) continue;
      for (const s of X.samples[cam]) for (const l of s.lines) {
        const m = M.phraseMatch(phrase, l.text);
        if (m.score >= 0.6) rows.push({ cam, t: s.t, box: l.box, reading: l.text, conf: l.conf, match: m.score, part: m.part, thumb: s.thumb });
      }
    }
    const runs = [];
    for (const r of rows.sort((a, b) => a.cam.localeCompare(b.cam) || a.t - b.t)) {
      const g = runs.find((x) => x.cam === r.cam && r.t - x.to <= X.step * 2.6 + 0.01 && M.iou(x.last, r.box) > 0 || (x.cam === r.cam && r.t - x.to <= X.step * 2.6 + 0.01 && M.textSim(x.last.reading || "", r.reading) > 0.6));
      if (!g) { runs.push({ cam: r.cam, from: r.t, to: r.t, best: r, last: { ...r.box, reading: r.reading }, pts: [{ t: r.t, ...r.box, conf: r.conf }], n: 1 }); continue; }
      g.to = r.t; g.n++; g.last = { ...r.box, reading: r.reading }; g.pts.push({ t: r.t, ...r.box, conf: r.conf });
      if (r.match * (0.5 + r.conf) > g.best.match * (0.5 + g.best.conf)) g.best = r;
    }
    const pc = (v) => Math.round(Math.max(0, Math.min(1, v)) * 100) + "%";
    const out = runs.map((g) => {
      const b = g.best, text = "“" + b.reading.slice(0, 40) + "” · read " + pc(b.conf) + (b.match < 0.95 ? " · match " + pc(b.match) : "") + (g.n > 1 ? " · " + g.n + " frames" : "");
      return { t: b.t, cam: g.cam, box: { ...b.box }, score: b.match * (0.5 + b.conf), match: b.match, conf: b.conf, reading: b.reading, text, boxText: text, label: "text " + phrase, det: true, streetText: true, textHit: true, thumb: b.thumb, from: g.from, to: g.to, pts: g.pts, weak: b.conf < 0.5 || b.part };
    });
    out.sort((a, b) => b.score - a.score);
    const top = out.length ? out[0].score : 0;
    out.forEach((h) => { h.best = h.score >= top - 0.02; });
    return out.slice(0, 30).sort((a, b) => a.t - b.t || a.cam.localeCompare(b.cam));
  };
  /** Everything read, for the status line ("12 lines on 6 cameras"). */
  TS.summary = (ev) => { const X = TS.index.get(ev.id); if (!X) return null; let lines = 0; for (const c of Object.keys(X.samples)) for (const s of X.samples[c]) lines += s.lines.filter((l) => l.text).length; return { frames: X.frames, cams: Object.keys(X.samples).length, lines, step: X.step, errors: X.errors, ms: X.ms }; };

  TS.init = () => {
    document.body.classList.toggle("no-text-search", !TS.on());
    // Settings ▸ Search: the switch (in the floating search's section, or its own section with the classic bars)
    try {
      if (!$("setTextSearch")) {
        let sec = $("setSearchSec");
        const body = document.querySelector("#settings .drawer-body");
        if (!sec && body) { sec = document.createElement("section"); sec.id = "setTextSec"; sec.innerHTML = "<h3>Search</h3>"; body.insertBefore(sec, body.lastElementChild); }
        if (sec) {
          const row = document.createElement("div"); row.className = "row"; row.innerHTML = '<span>Show text search &amp; redaction (beta)</span><input type="checkbox" id="setTextSearch">';
          const hint = document.createElement("p"); hint.className = "hint"; hint.id = "setTextSearchHint";
          hint.textContent = "Reads the text in the video on this device (signs, shop names, house numbers, words on trucks) so you can search for it (text Oak Ave) or blur it (Blur text, Street signs, All text). Readings can be wrong; check the result. Off hides those controls. Plate and face blur (Settings ▸ Plates & text) and time search (20:53:46, 2:30, +1:05) stay available.";
          sec.append(row, hint);
          $("setTextSearch").checked = TS.on();
          $("setTextSearch").addEventListener("change", (e) => TS.setOn(e.target.checked));
        }
      }
    } catch (e) { console.warn("text search setting", e); }
    T.on && T.on("player-open", (ev) => { for (const id of [...TS.index.keys()]) if (!ev || id !== ev.id) TS.forget(id); });
  };
})();
