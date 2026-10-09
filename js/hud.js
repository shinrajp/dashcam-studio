/* hud.js — telemetry HUD and self-driving badge renderers (canvas, unit-based, used live and in export). */
(function () {
  "use strict";
  const T = window.TDC;
  const D = T.draw;
  const H = (T.hud = {});
  H.HEIGHT = 150;
  const ITEM_W = { speed: 176, gear: 56, steering: 132, brake: 92, accel: 76, compass: 132, gforce: 132, gps: 200 };
  const ORDER = ["speed", "gear", "steering", "brake", "accel", "compass", "gforce", "gps"];
  H.ITEMS = [
    ["speed", "Speed gauge"], ["gear", "Gear (P R N D)"], ["steering", "Steering wheel"], ["signals", "Turn signals"],
    ["brake", "Brake lamp"], ["accel", "Accelerator pedal"], ["compass", "Heading compass"], ["gforce", "G-force ball"], ["gps", "GPS coordinates"],
  ];
  const DIM = "rgba(255,255,255,0.45)", FAINT = "rgba(255,255,255,0.12)";

  /** Layout from the user's toggles. Returns { w, h, items: [{ k, x, w }], mode } */
  H.layout = (status) => {
    if (status !== "ready" && status !== "partial") return { w: 560, h: 96, items: [], mode: "message" };
    const on = T.prefs.hudItems;
    const items = [];
    let x = 14;
    if (on.signals) { items.push({ k: "sigL", x, w: 64 }); x += 64; }
    for (const k of ORDER) if (on[k]) { items.push({ k, x, w: ITEM_W[k] }); x += ITEM_W[k]; }
    if (on.signals) { items.push({ k: "sigR", x, w: 64 }); x += 64; }
    if (!items.length) return { w: 0, h: 0, items, mode: "empty" };
    return { w: x + 14, h: H.HEIGHT, items, mode: "full" };
  };

  function speedItem(ctx, w, st) {
    const cx = w / 2, cy = 70, r = 56;
    const kmh = T.prefs.units === "kmh";
    const v = Math.max(0, st.m.speed || 0) * (kmh ? 3.6 : 2.236936);
    const max = kmh ? 160 : 100;
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    ctx.lineCap = "round";
    ctx.lineWidth = 9; ctx.strokeStyle = FAINT;
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke();
    const f = T.clamp(v / max, 0, 1);
    if (f > 0.002) {
      const g = ctx.createLinearGradient(cx - r, 0, cx + r, 0);
      g.addColorStop(0, "#9fb7ff"); g.addColorStop(1, "#ffffff");
      ctx.strokeStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * f); ctx.stroke();
    }
    ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,0.25)";
    for (let i = 0; i <= 10; i++) {
      const a = a0 + ((a1 - a0) * i) / 10;
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (r - 13), cy + Math.sin(a) * (r - 13)); ctx.lineTo(cx + Math.cos(a) * (r - (i % 5 ? 17 : 21)), cy + Math.sin(a) * (r - (i % 5 ? 17 : 21))); ctx.stroke();
    }
    D.text(ctx, String(Math.round(v)), cx, cy + 2, 46, "#fff", "center", 700);
    D.text(ctx, kmh ? "KM/H" : "MPH", cx, cy + 34, 14, DIM, "center", 700);
  }

  function gearItem(ctx, w, st) {
    const g = T.sei.GEAR[st.m.gear] || "P";
    ["P", "R", "N", "D"].forEach((l, i) => {
      const y = 33 + i * 28;
      if (l === g) {
        D.rr(ctx, w / 2 - 16, y - 13, 32, 26, 7);
        ctx.fillStyle = "rgba(255,255,255,0.14)"; ctx.fill();
        D.text(ctx, l, w / 2, y + 1, 21, "#fff", "center", 800);
      } else D.text(ctx, l, w / 2, y + 1, 18, "rgba(255,255,255,0.3)", "center", 600);
    });
  }

  function steeringItem(ctx, w, st) {
    let a = st.steer || 0;
    if (T.prefs.steerInvert) a = -a;
    const assisted = st.m.ap === 1 || st.m.ap === 2;
    D.wheel(ctx, w / 2, 64, 40, a, assisted ? T.TESLA_BLUE : "#ffffff", 8);
    const s = Math.round(a);
    D.text(ctx, (s > 0 ? "+" : s < 0 ? "−" : "") + Math.abs(s) + "°", w / 2, 128, 17, DIM, "center", 600, true);
  }

  function brakeItem(ctx, w, st) {
    D.brakeLamp(ctx, w / 2, 62, 27, !!st.m.brake);
    D.text(ctx, "BRAKE", w / 2, 128, 13, st.m.brake ? "#FF6B61" : DIM, "center", 700);
  }

  function accelItem(ctx, w, st) {
    const bw = 22, bh = 86, x = w / 2 - bw / 2, y = 20;
    D.rr(ctx, x, y, bw, bh, 8); ctx.fillStyle = FAINT; ctx.fill();
    const f = T.clamp(st.pedalPct / 100, 0, 1);
    if (f > 0.005) {
      ctx.save(); D.rr(ctx, x, y, bw, bh, 8); ctx.clip();
      const g = ctx.createLinearGradient(0, y + bh, 0, y);
      g.addColorStop(0, "#2EE66E"); g.addColorStop(1, "#b6ffcf");
      ctx.fillStyle = g; ctx.fillRect(x, y + bh * (1 - f), bw, bh * f);
      ctx.restore();
    }
    D.text(ctx, Math.round(st.pedalPct) + "%", w / 2, 128, 16, DIM, "center", 600, true);
  }

  const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  function compassItem(ctx, w, st) {
    const cx = w / 2, cy = 62, r = 42;
    const h = ((st.m.heading % 360) + 360) % 360;
    ctx.lineWidth = 2; ctx.strokeStyle = FAINT;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    for (let i = 0; i < 36; i++) {
      const a = (i * 10 * Math.PI) / 180, len = i % 9 === 0 ? 8 : 4;
      ctx.strokeStyle = i % 9 === 0 ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.18)";
      ctx.beginPath(); ctx.moveTo(cx + Math.sin(a) * r, cy - Math.cos(a) * r); ctx.lineTo(cx + Math.sin(a) * (r - len), cy - Math.cos(a) * (r - len)); ctx.stroke();
    }
    [["N", 0], ["E", 90], ["S", 180], ["W", 270]].forEach(([l, d]) => {
      const a = (d * Math.PI) / 180;
      D.text(ctx, l, cx + Math.sin(a) * (r - 17), cy - Math.cos(a) * (r - 17) + 1, 12, l === "N" ? "#FF6B61" : DIM, "center", 800);
    });
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate((h * Math.PI) / 180);
    ctx.fillStyle = T.TESLA_BLUE;
    ctx.beginPath(); ctx.moveTo(0, -r + 6); ctx.lineTo(9, 6); ctx.lineTo(0, 1); ctx.lineTo(-9, 6); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(0, 0, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    D.text(ctx, `${DIRS[Math.round(h / 45) % 8]} ${Math.round(h)}°`, cx, 128, 16, DIM, "center", 600, true);
  }

  function gforceItem(ctx, w, st) {
    const cx = w / 2, cy = 62, r = 42, G = 9.80665;
    ctx.lineWidth = 2; ctx.strokeStyle = FAINT;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r / 2, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();
    const a = T.telemetry.accel(st.m);
    const gx = T.clamp((a.lat || 0) / G, -1, 1), gy = T.clamp((a.lon || 0) / G, -1, 1);
    const mag = Math.hypot(gx, gy);
    const px = cx + gx * r, py = cy - gy * r;
    ctx.save();
    ctx.shadowColor = "rgba(62,106,225,0.9)"; ctx.shadowBlur = 10;
    ctx.fillStyle = mag > 0.5 ? "#FFB020" : "#ffffff";
    ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    D.text(ctx, mag.toFixed(2) + " g", cx, 128, 16, DIM, "center", 600, true);
  }

  function gpsItem(ctx, w, st) {
    const m = st.m;
    const has = !(m.lat === 0 && m.lon === 0);
    D.pin(ctx, 26, 50, 16, has ? "#FF6B61" : "rgba(255,255,255,0.25)");
    D.text(ctx, "GPS", 26, 82, 12, DIM, "center", 700);
    if (has) {
      D.text(ctx, `${Math.abs(m.lat).toFixed(5)}° ${m.lat >= 0 ? "N" : "S"}`, 52, 50, 17, "#fff", "left", 600, true);
      D.text(ctx, `${Math.abs(m.lon).toFixed(5)}° ${m.lon >= 0 ? "E" : "W"}`, 52, 78, 17, "#fff", "left", 600, true);
    } else D.text(ctx, "No fix", 52, 64, 17, DIM, "left", 600);
    D.text(ctx, "LAT / LON", 52, 128, 13, DIM, "left", 700);
  }

  function messageCard(ctx, w, h, status, info) {
    D.panel(ctx, w, h, 20);
    const cx = 48, cy = h / 2;
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = 4; ctx.lineCap = "round";
    if (status === "parsing" || status === "queued") {
      const a = (performance.now() / 300) % (Math.PI * 2);
      ctx.strokeStyle = T.TESLA_BLUE;
      ctx.beginPath(); ctx.arc(cx, cy, 18, a, a + Math.PI * 1.4); ctx.stroke();
    } else {
      // antenna with slash
      ctx.beginPath(); ctx.arc(cx, cy + 4, 16, Math.PI * 1.2, Math.PI * 1.8); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy + 4, 8, Math.PI * 1.2, Math.PI * 1.8); ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.55)"; ctx.beginPath(); ctx.arc(cx, cy + 6, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#FF6B61"; ctx.beginPath(); ctx.moveTo(cx - 20, cy - 16); ctx.lineTo(cx + 20, cy + 20); ctx.stroke();
    }
    ctx.restore();
    const title = { parsing: "Reading telemetry…", queued: "Reading telemetry…", locked: "Telemetry locked", none: "No telemetry in these clips", idle: "No clips loaded" }[status] || "No telemetry";
    const sub = { parsing: info || "Scanning the H.264 stream for Tesla SEI data", queued: info || "", locked: "Unlock the encrypted clips to read speed, steering and GPS", none: "Tesla embeds driving data from firmware 2025.44.25+ on HW3/HW4", idle: "" }[status] || "";
    D.text(ctx, title, 84, cy - 12, 21, "#fff", "left", 700);
    ctx.font = D.font(14, 500);
    D.text(ctx, D.fitText(ctx, sub, w - 100), 84, cy + 15, 14, DIM, "left", 500);
  }

  /** Draw the HUD at the canvas origin in units (caller scales). st = telemetry state or null. */
  H.draw = (ctx, lay, st, status, info) => {
    if (lay.mode === "message") return messageCard(ctx, lay.w, lay.h, status, info);
    if (lay.mode === "empty") return;
    D.panel(ctx, lay.w, lay.h, 22);
    if (!st) {
      D.text(ctx, "No telemetry at this moment", lay.w / 2, lay.h / 2, 18, DIM, "center", 600);
      return;
    }
    lay.items.forEach((it, i) => {
      ctx.save();
      ctx.translate(it.x, 0);
      if (i > 0 && it.k !== "sigR" && lay.items[i - 1].k !== "sigL") {
        ctx.fillStyle = "rgba(255,255,255,0.07)"; ctx.fillRect(0, 26, 1.5, lay.h - 52);
      }
      switch (it.k) {
        case "sigL": D.arrow(ctx, it.w / 2, 64, 40, -1, st.litL); break;
        case "sigR": D.arrow(ctx, it.w / 2, 64, 40, 1, st.litR); break;
        case "speed": speedItem(ctx, it.w, st); break;
        case "gear": gearItem(ctx, it.w, st); break;
        case "steering": steeringItem(ctx, it.w, st); break;
        case "brake": brakeItem(ctx, it.w, st); break;
        case "accel": accelItem(ctx, it.w, st); break;
        case "compass": compassItem(ctx, it.w, st); break;
        case "gforce": gforceItem(ctx, it.w, st); break;
        case "gps": gpsItem(ctx, it.w, st); break;
      }
      ctx.restore();
    });
  };

  // ── self-driving badge ──
  const AP_STYLE = {
    1: { text: "Self-Driving", fill: "#3E6AE1", stroke: "#3E6AE1", color: "#ffffff", icon: "#ffffff" },
    2: { text: "Autosteer", fill: "rgba(62,106,225,0.22)", stroke: "#3E6AE1", color: "#B9CBFF", icon: "#3E6AE1" },
    3: { text: "Traffic-Aware Cruise", fill: "rgba(255,255,255,0.08)", stroke: "rgba(190,200,215,0.7)", color: "#DCE2EA", icon: "#DCE2EA", cruise: true },
    0: { text: "Manual driving", fill: "rgba(12,14,18,0.6)", stroke: "rgba(255,255,255,0.16)", color: "rgba(255,255,255,0.6)", icon: "rgba(255,255,255,0.45)" },
  };
  H.BADGE_H = 46;
  H.badgeWidth = (ctx, st) => {
    const s = AP_STYLE[st ? st.m.ap : 0] || AP_STYLE[0];
    ctx.font = D.font(19, 700);
    return Math.ceil(ctx.measureText(s.text).width) + 76;
  };
  H.badgeStyle = (ap) => AP_STYLE[ap] || AP_STYLE[0];
  H.drawBadge = (ctx, w, st) => {
    const s = AP_STYLE[st ? st.m.ap : 0] || AP_STYLE[0];
    const h = H.BADGE_H;
    ctx.save();
    D.rr(ctx, 1, 1, w - 2, h - 2, h / 2);
    ctx.fillStyle = s.fill; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = s.stroke; ctx.stroke();
    if (st && st.m.ap === 1) { ctx.shadowColor = "rgba(62,106,225,0.8)"; ctx.shadowBlur = 16; ctx.fill(); ctx.shadowBlur = 0; }
    if (s.cruise) {
      ctx.strokeStyle = s.icon; ctx.lineWidth = 3; ctx.lineCap = "round";
      ctx.beginPath(); ctx.arc(30, h / 2 + 4, 12, Math.PI, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(30, h / 2 + 4); ctx.lineTo(38, h / 2 - 4); ctx.stroke();
    } else D.wheel(ctx, 30, h / 2, 12, 0, s.icon, 3.2);
    D.text(ctx, s.text, 52, h / 2 + 1, 19, s.color, "left", 700);
    ctx.restore();
  };
})();
