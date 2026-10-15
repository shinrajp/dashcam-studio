/* burn-boxes.js — optional export overlay: draws the gold search/detection boxes and their labels into exported frames.
 * Uses the same data as the viewer's gold box (TDC.search.hits with a located .box, normalised 0..1 to the source frame).
 * Off by default; the choice is kept in localStorage ("tdc.export.burnBoxes"). Any missing data → draws nothing. */
(function () {
  const T = (window.TDC = window.TDC || {});
  const KEY = "tdc.export.burnBoxes";
  const NEAR = 2.5;   // seconds; same window the viewer uses to keep the gold box on screen
  const B = (T.burnBoxes = {});
  B.enabled = () => { try { return localStorage.getItem(KEY) === "1"; } catch (_) { return false; } };
  B.setEnabled = (v) => { try { v ? localStorage.setItem(KEY, "1") : localStorage.removeItem(KEY); } catch (_) {} };

  const num = (v) => typeof v === "number" && isFinite(v);
  const validBox = (b) => b && num(b.x) && num(b.y) && num(b.w) && num(b.h) && b.w > 0 && b.h > 0;

  /** Label text: class name + confidence. Future detector hits carry {label|cls, conf}; Phase 4 text-search hits use the phrase + match score. */
  // (CLIP scores are not probabilities, so text-search hits show a relative match: score ÷ best score in the results.)
  B.labelFor = (hit, phrase, best) => {
    const name = String(hit.label || hit.cls || hit.box.label || phrase || "match").slice(0, 40);
    let c = num(hit.conf) ? hit.conf : num(hit.box.conf) ? hit.box.conf : num(hit.score) && num(best) && best > 0 ? hit.score / best : null;
    if (c == null) return name;
    if (c > 1) c = c / 100;
    return name + " " + Math.round(Math.max(0, Math.min(1, c)) * 100) + "%";
  };

  /** Boxes to burn for one camera at event time t: [{x,y,w,h,text}] (normalised). */
  B.at = (cam, t, hits, phrase) => {
    try {
      const S = T.search;
      hits = hits || (S && S.hits) || [];
      phrase = phrase != null ? phrase : (S && S.phrase) || "";
      if (!Array.isArray(hits) || !num(t)) return [];
      if (T.detect && T.detect.boxesAt) { const tr = T.detect.boxesAt(cam, t); if (tr) return tr; }   // Phase 5: tracked / detected boxes
      const out = [];
      const best = hits.reduce((m, h) => (h && num(h.score) && h.score > m ? h.score : m), 0);
      for (const h of hits) {
        if (!h || h.tracked || h.cam !== cam || !num(h.t) || Math.abs(h.t - t) > NEAR || !validBox(h.box)) continue;
        out.push({ x: h.box.x, y: h.box.y, w: h.box.w, h: h.box.h, text: B.labelFor(h, phrase, best) });
      }
      return out;
    } catch (_) { return []; }
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
        ctx.strokeStyle = "#e6b450"; ctx.lineWidth = lw; ctx.strokeRect(x, y, w, h);
        if (!b.text) continue;
        const pad = Math.round(fs * 0.35), th = fs + pad * 2;
        const tw = Math.min(fw, ctx.measureText(b.text).width + pad * 2);
        let ly = y - th; if (ly < fy) ly = y + h <= fy + fh - th ? y + h : fy;   // above the box, else below, else top edge
        const lx = Math.max(fx, Math.min(x, fx + fw - tw));
        ctx.fillStyle = "rgba(0,0,0,0.78)"; ctx.fillRect(lx, ly, tw, th);
        ctx.strokeStyle = "#000"; ctx.lineWidth = Math.max(2, fs / 6); ctx.strokeText(b.text, lx + pad, ly + th / 2, tw - pad * 2);
        ctx.fillStyle = "#ffe3a3"; ctx.fillText(b.text, lx + pad, ly + th / 2, tw - pad * 2);
      }
      ctx.restore();
      return boxes.length;
    } catch (_) { try { ctx.restore(); } catch (_) {} return 0; }
  };
})();
