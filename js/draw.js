/* draw.js — canvas primitives shared by the live overlays and the exporter. All sizes in "units". */
(function () {
  "use strict";
  const T = window.TDC;
  const D = (T.draw = {});
  D.FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  D.MONO = '"SF Mono", ui-monospace, Menlo, Consolas, "Roboto Mono", monospace';
  D.font = (px, weight, mono) => `${weight || 600} ${px}px ${mono ? D.MONO : D.FONT}`;

  D.rr = (ctx, x, y, w, h, r) => {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };
  D.panel = (ctx, w, h, r) => {
    ctx.save();
    D.rr(ctx, 0, 0, w, h, r);
    ctx.fillStyle = "rgba(12,14,18,0.74)";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.stroke();
    ctx.restore();
  };
  D.text = (ctx, s, x, y, px, color, align, weight, mono) => {
    ctx.font = D.font(px, weight, mono);
    ctx.fillStyle = color;
    ctx.textAlign = align || "center";
    ctx.textBaseline = "middle";
    ctx.fillText(s, x, y);
  };
  D.fitText = (ctx, s, maxW) => {
    if (ctx.measureText(s).width <= maxW) return s;
    while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
    return s + "…";
  };

  /** Steering wheel icon centred at (cx, cy), radius r, rotated deg. */
  D.wheel = (ctx, cx, cy, r, deg, color, lw) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.strokeStyle = color; ctx.fillStyle = color;
    ctx.lineWidth = lw || r * 0.2;
    ctx.lineCap = "round";
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, r * 0.08, r * 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = (lw || r * 0.2) * 0.85;
    ctx.beginPath();
    ctx.moveTo(-r, 0); ctx.lineTo(-r * 0.3, r * 0.05);
    ctx.moveTo(r, 0); ctx.lineTo(r * 0.3, r * 0.05);
    ctx.moveTo(0, r * 0.38); ctx.lineTo(0, r);
    ctx.stroke();
    // top-dead-centre marker
    ctx.lineWidth = (lw || r * 0.2) * 1.05;
    ctx.strokeStyle = color === "#ffffff" ? "#3E6AE1" : "#ffffff";
    ctx.beginPath(); ctx.arc(0, 0, r, -Math.PI / 2 - 0.16, -Math.PI / 2 + 0.16); ctx.stroke();
    ctx.restore();
  };

  /** Tesla-style turn arrow. dir -1 = left, +1 = right. */
  D.arrow = (ctx, cx, cy, size, dir, lit) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(-dir, 1); // base path below points LEFT (tip at -s), so flip for right (+1)
    const s = size / 2;
    ctx.beginPath();
    ctx.moveTo(s, -s * 0.38); ctx.lineTo(-s * 0.05, -s * 0.38); ctx.lineTo(-s * 0.05, -s * 0.95);
    ctx.lineTo(-s, 0); ctx.lineTo(-s * 0.05, s * 0.95); ctx.lineTo(-s * 0.05, s * 0.38); ctx.lineTo(s, s * 0.38);
    ctx.closePath();
    if (lit) {
      ctx.shadowColor = "rgba(46, 230, 110, 0.9)"; ctx.shadowBlur = size * 0.45;
      ctx.fillStyle = "#2EE66E"; ctx.fill();
    } else {
      ctx.lineWidth = size * 0.06; ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.stroke();
    }
    ctx.restore();
  };

  /** ISO brake lamp: circle with side arcs. */
  D.brakeLamp = (ctx, cx, cy, r, lit) => {
    ctx.save();
    const c = lit ? "#FF3B30" : "rgba(255,255,255,0.22)";
    if (lit) { ctx.shadowColor = "rgba(255,59,48,0.9)"; ctx.shadowBlur = r * 0.9; }
    ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = r * 0.16; ctx.lineCap = "round";
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI * 0.72, Math.PI * 1.28); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI * 0.28, Math.PI * 0.28); ctx.stroke();
    ctx.font = D.font(r * 0.8, 800); ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("!", cx, cy + r * 0.04);
    ctx.restore();
  };

  /** Map pin icon. */
  D.pin = (ctx, cx, cy, r, color) => {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy - r * 0.35, r * 0.62, Math.PI * 0.85, Math.PI * 0.15);
    ctx.lineTo(cx, cy + r);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(12,14,18,0.9)";
    ctx.beginPath(); ctx.arc(cx, cy - r * 0.35, r * 0.25, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  };
})();
