/* burn-boxes.js — optional export overlay: draws the gold search/detection boxes and their labels into exported frames.
 * Uses the same data as the viewer's gold box (TDC.search.hits with a located .box, normalised 0..1 to the source frame).
 * Off by default; the choice is kept in localStorage ("tdc.export.burnBoxes"). Any missing data → draws nothing.
 * B.redactAt: the matches to blur (search Redact switch / per term), shared by the viewer and the export the same way. */
(function () {
  const T = (window.TDC = window.TDC || {});
  const KEY = "tdc.export.burnBoxes";
  const NEAR = 1.0;   // seconds around a result (not followed by tracking / live detection) that its box stays on screen; was 2.5,
                     // which made a box sit 2.5 s early at the spot the object only reaches later
  const B = (T.burnBoxes = {});
  B.enabled = () => { try { return localStorage.getItem(KEY) === "1"; } catch (_) { return false; } };
  B.setEnabled = (v) => { try { v ? localStorage.setItem(KEY, "1") : localStorage.removeItem(KEY); } catch (_) {} };

  const num = (v) => typeof v === "number" && isFinite(v);
  const iou = (a, b) => { const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h); const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (a.w * a.h + b.w * b.h - i || 1); };
  const validBox = (b) => b && num(b.x) && num(b.y) && num(b.w) && num(b.h) && b.w > 0 && b.h > 0;

  /** Label text: class name + confidence. Future detector hits carry {label|cls, conf}; Phase 4 text-search hits use the phrase + match score. */
  // (CLIP scores are not probabilities, so picture-search hits are labelled "phrase? (best match)" / "phrase? (match)" without a %.)
  B.labelFor = (hit, phrase, best) => {
    if (hit.boxText) return String(hit.boxText).slice(0, 80);   // Phase 6 plates / street text: one shared label format
    const name = String(hit.label || hit.cls || hit.box.label || phrase || "match").slice(0, 40);
    let c = num(hit.conf) ? hit.conf : num(hit.box.conf) ? hit.box.conf : null;
    // Picture-search (CLIP) hits have no real confidence: say it's a match, not a percentage.
    if (c == null) return !hit.det && (num(hit.score) || phrase) ? name + "? (" + (num(hit.score) && num(best) && hit.score >= best ? "best match" : "match") + ")" : name;
    if (c > 1) c = c / 100;
    return name + " " + Math.round(Math.max(0, Math.min(1, c)) * 100) + "%";
  };

  /** THE box set for one camera at event time t: [{x,y,w,h,text}] (normalised). The live viewer (search.js paintBoxes) and the
   *  export (compositor → draw) both call this, so they show the same boxes: followed tracks / live detections first, else every
   *  result (detector, picture, plate, vehicle; after the Best-match filter) within ±NEAR s of t on that camera.
   *  Highlight off (Boxes / X / the "Gold box" tick) → nothing, unless a term of a several-thing search was set to highlight. */
  B.at = (cam, t, hits, phrase) => {
    try {
      const S = T.search;
      hits = hits || (S && S.hits) || [];
      phrase = phrase != null ? phrase : (S && S.phrase) || "";
      if (!Array.isArray(hits) || !num(t)) return [];
      if (S && S.goldShown && !S.goldShown() && !(S.anyHl && S.anyHl())) return [];   // highlight off: nothing in the viewer, nothing burned
      const on = (ti) => !(S && S.termMode) || S.termMode(ti).hl;
      // several things in one search (multi-search.js): every term's results get the term's colour, gold stays for the opened
      // result (and what follows it); followed / live boxes and the other terms' results are shown together
      const multi = !!(S && S.terms && S.terms.length);
      let out = [];
      if (T.detect && T.detect.boxesAt) {   // Phase 5: tracked / detected boxes
        const tr = T.detect.boxesAt(cam, t);
        if (tr && !multi) return on(null) ? tr : [];
        if (tr) for (const b of tr) {
          const ti = b.hit ? b.hit.ti : termOfLive(b);
          if (!on(ti)) continue;
          const o = { x: b.x, y: b.y, w: b.w, h: b.h, text: b.text }; if (b.hit && b.hit !== S.openedHit && b.hit.termColor) o.color = b.hit.termColor;
          out.push(o);
        }
      }
      const best = hits.reduce((m, h) => (h && num(h.score) && h.score > m ? h.score : m), 0);
      const pre = out.length;
      for (const h of hits) {
        if (!h || h.tracked || h.cam !== cam || !num(h.t) || Math.abs(h.t - t) > NEAR || !validBox(h.box)) continue;
        if (multi && !on(h.ti)) continue;
        const o = { x: h.box.x, y: h.box.y, w: h.box.w, h: h.box.h, text: B.labelFor(h, phrase, best) };
        if (multi) {
          if (out.slice(0, pre).some((b) => iou(b, o) > 0.5)) continue;   // already drawn as a followed / live box
          if (h !== S.openedHit && h.termColor) o.color = h.termColor;
        }
        out.push(o);
      }
      return out;
    } catch (_) { return []; }
  };

  // live detection of a searched class → that term (several-thing search), else undefined (follows the switch)
  function termOfLive(b) {
    const S = T.search, D = T.detect;
    if (!b || !b.label || !S || !S.terms || !D || !D.classFor) return undefined;
    const c = S.terms.find((c) => { try { return D.classFor(c.term) === b.label; } catch (_) { return false; } });
    return c ? c.i : undefined;
  }

  /** Matches to REDACT (opaque blur) on one camera at time t: [{x,y,w,h}] normalised. Same sources as B.at (followed tracks,
   *  live detections, results within ±NEAR s), but: only what the search matched (live detections of other classes are left
   *  alone), every result (not just the chip / Best-match view, so a filter never un-hides something), and it does not depend
   *  on Highlight. Used by the viewer (redact.js blur layer) and the export (redact.burn), so both blur the same spots. */
  B.redactAt = (cam, t, hits) => {
    try {
      const S = T.search;
      if (!S || !S.anyRd || !S.anyRd() || !num(t)) return [];
      hits = hits || S.allHits || S.hits || [];
      if (!Array.isArray(hits) || !hits.length) return [];
      const multi = !!(S.terms && S.terms.length);
      const on = (ti) => S.termMode(ti).rd;
      let cls = null;
      if (!multi && T.detect && T.detect.classFor) { try { cls = T.detect.classFor(S.phrase || ""); } catch (_) {} }
      const out = [];
      const tr = T.detect && T.detect.boxesAt ? T.detect.boxesAt(cam, t) : null;
      if (tr) for (const b of tr) {
        let ti;
        if (b.hit) { if (!hits.includes(b.hit) && !(S.hits || []).includes(b.hit)) continue; ti = multi ? b.hit.ti : null; }
        else if (b.live) { if (multi) { ti = termOfLive(b); if (ti === undefined) continue; } else if (!cls || b.label !== cls) continue; else ti = null; }
        else continue;
        if (!on(ti)) continue;
        out.push({ x: b.x, y: b.y, w: b.w, h: b.h });
      }
      const pre = out.length;
      for (const h of hits) {
        if (!h || h.cam !== cam || !num(h.t) || Math.abs(h.t - t) > NEAR || !validBox(h.box)) continue;
        if (!on(multi ? h.ti : null)) continue;
        const o = { x: h.box.x, y: h.box.y, w: h.box.w, h: h.box.h };
        if (out.slice(0, pre).some((b) => iou(b, o) > 0.3)) continue;   // the followed box already covers it
        out.push(o);
      }
      return out.filter(validBox);
    } catch (_) { return []; }
  };

  /** Before an export: wait for gold-box tracking that is still running, and fill live detections for the export ranges,
   *  so frames are never encoded before their boxes exist. status(text) for the progress line. */
  B.prepare = async (ranges, status, cancelled) => {
    status = status || (() => {});
    const S = T.search;
    try {
      if (S && S.pending) {
        status("Finishing the gold-box tracking before export…");
        await Promise.race([S.pending, new Promise((r) => setTimeout(r, 120000))]);
      }
    } catch (_) {}
    let n = 0;
    try {
      if (T.detect && T.detect.prepareLive && !(S && (S.needBoxes ? !S.needBoxes() : S.goldShown && !S.goldShown())))
        n = await T.detect.prepareLive(ranges, (i, k, cam) => { status("Detecting objects for the burned-in boxes · " + i + " of " + k + (cam ? " · " + ((T.CAM_LABEL && T.CAM_LABEL[cam]) || cam) : "") + " (same as while playing)…"); if (B.onPrepare) B.onPrepare(i, k, cam); }, cancelled);
    } catch (e) { console.warn("burn boxes: live detection for export skipped", e); status("Couldn't run live detection for the export (" + (e.message || e) + "); burning the boxes that are ready."); }
    return n;
  };

  /** One hit → drawable box with the same label text the export uses (live viewer overlay). */
  B.forHit = (hit, hits, phrase) => {
    try {
      const S = T.search;
      if (!hit || !validBox(hit.box)) return null;
      hits = hits || (S && S.hits) || [];
      phrase = phrase != null ? phrase : (S && S.phrase) || "";
      const best = (Array.isArray(hits) ? hits : []).reduce((m, h) => (h && num(h.score) && h.score > m ? h.score : m), 0);
      return { x: hit.box.x, y: hit.box.y, w: hit.box.w, h: hit.box.h, text: B.labelFor(hit, phrase, best) };
    } catch (_) { return null; }
  };

  /** Draw onto an export canvas (or the viewer's per-tile layer). r = camera tile rect, iw/ih = source frame size (image is drawn "contain" in r). */
  B.draw = (ctx, cam, t, r, iw, ih, list, minFont) => {
    try {
      if (!iw || !ih || !r || r.w <= 0 || r.h <= 0) return 0;
      const boxes = list || B.at(cam, t);
      if (!boxes.length) return 0;
      const s = Math.min(r.w / iw, r.h / ih), fw = iw * s, fh = ih * s;
      const fx = r.x + (r.w - fw) / 2, fy = r.y + (r.h - fh) / 2;
      const lw = Math.max(2, Math.round(fh * 0.006));
      const fs = Math.max(minFont || 11, Math.round(fh * 0.045));   // font scales with tile height: readable on phone-size exports
      ctx.save();
      ctx.beginPath(); ctx.rect(fx, fy, fw, fh); ctx.clip();
      ctx.font = "700 " + fs + "px -apple-system, system-ui, sans-serif";
      ctx.textBaseline = "middle";
      for (const b of boxes) {
        const x = fx + b.x * fw, y = fy + b.y * fh, w = b.w * fw, h = b.h * fh;
        ctx.lineJoin = "round";
        ctx.strokeStyle = "rgba(0,0,0,0.75)"; ctx.lineWidth = lw + 2; ctx.strokeRect(x, y, w, h);
        ctx.strokeStyle = b.color || "#e6b450"; ctx.lineWidth = lw; ctx.strokeRect(x, y, w, h);
        if (!b.text) continue;
        const pad = Math.round(fs * 0.35), th = fs + pad * 2;
        const tw = Math.min(fw, ctx.measureText(b.text).width + pad * 2);
        let ly = y - th; if (ly < fy) ly = y + h <= fy + fh - th ? y + h : fy;   // above the box, else below, else top edge
        const lx = Math.max(fx, Math.min(x, fx + fw - tw));
        ctx.fillStyle = "rgba(0,0,0,0.78)"; ctx.fillRect(lx, ly, tw, th);
        if (b.color) { ctx.fillStyle = b.color; ctx.fillRect(lx, ly + th - Math.max(2, lw), tw, Math.max(2, lw)); }   // the term's colour under its label
        ctx.strokeStyle = "#000"; ctx.lineWidth = Math.max(2, fs / 6); ctx.strokeText(b.text, lx + pad, ly + th / 2, tw - pad * 2);
        ctx.fillStyle = "#ffe3a3"; ctx.fillText(b.text, lx + pad, ly + th / 2, tw - pad * 2);
      }
      ctx.restore();
      return boxes.length;
    } catch (_) { try { ctx.restore(); } catch (_) {} return 0; }
  };
})();
