/* wb-debug.js — hidden geometry readout for the Left Pillar shift report (tag pillar-shift). Off unless the page URL has
 * ?debug=wb (or #debug=wb). Shows, per visible tile: the video's getBoundingClientRect, the picture rect that object-fit:
 * contain gives, videoWidth × videoHeight, the fractional device-pixel part of the tile edges, the WB layers present
 * (tint / lift / filter) and devicePixelRatio. Refreshes every 500 ms and on every White balance toggle; "Copy" puts the
 * numbers on the clipboard (also logged to the console as "wb-debug"). Reads only; changes nothing. */
(function () {
  "use strict";
  const T = (window.TDC = window.TDC || {});
  const on = () => { try { return /(?:[?&#])debug=wb\b/.test(location.search + location.hash); } catch (_) { return false; } };
  const r2 = (v) => Math.round(v * 100) / 100;
  const snap = () => {
    const P = T.player, dpr = window.devicePixelRatio || 1, out = { dpr, wb: !!(T.wb && T.wb.isOn && T.wb.isOn()), mode: T.wb && T.wb.mode ? T.wb.mode() : "", focus: (T.focus && T.focus.cam) || "grid", tiles: {} };
    if (!P || !P.tiles) return out;
    for (const [cam, t] of Object.entries(P.tiles)) {
      if (t.tile.classList.contains("off")) continue;
      const v = t.vids[P.active] || t.vids[0]; if (!v) continue;
      const b = v.getBoundingClientRect(), vw = v.videoWidth, vh = v.videoHeight;
      let pic = null;
      if (vw && vh) { const k = Math.min(b.width / vw, b.height / vh), w = vw * k, h = vh * k; pic = [r2(b.left + (b.width - w) / 2), r2(b.top + (b.height - h) / 2), r2(w), r2(h)]; }
      const q = (s) => { const e = t.tile.querySelector(":scope > " + s); return e ? (e.hidden ? "hidden" : getComputedStyle(e).mixBlendMode + (e.classList.contains("wb-idle") ? " idle" : "")) : "-"; };
      out.tiles[cam] = { rect: [r2(b.left), r2(b.top), r2(b.width), r2(b.height)], pic, video: [vw, vh], devFrac: [b.left, b.top, b.right, b.bottom].map((x) => r2((x * dpr) % 1)),
        tint: q(".wb-tint"), lift: q(".wb-lift"), filter: v.style.filter || "-", transform: getComputedStyle(v).transform };
    }
    return out;
  };
  T.wbDebug = { snap };
  T.wbDebugInit = () => {
    if (!on()) return;
    const box = document.createElement("div"); box.id = "wbDebug";
    box.style.cssText = "position:fixed;left:6px;top:6px;z-index:99999;max-width:min(560px,calc(100vw - 12px));max-height:60vh;overflow:auto;padding:6px 8px;border-radius:8px;background:rgba(0,0,0,.82);color:#cfe;font:10px/1.35 ui-monospace,Menlo,monospace;white-space:pre;pointer-events:auto";
    const pre = document.createElement("div"), btn = document.createElement("button");
    btn.type = "button"; btn.textContent = "Copy"; btn.style.cssText = "float:right;font:inherit;margin-left:8px";
    btn.addEventListener("click", () => { const s = JSON.stringify(snap()); try { navigator.clipboard.writeText(s); btn.textContent = "Copied"; setTimeout(() => (btn.textContent = "Copy"), 1200); } catch (_) {} });
    box.append(btn, pre); document.body.appendChild(box);
    const draw = (why) => {
      const s = snap();
      pre.textContent = `wb-debug  dpr ${s.dpr}  WB ${s.wb ? "on" : "off"} (${s.mode})  view ${s.focus}\n` + Object.entries(s.tiles).map(([c, x]) =>
        `${c.padEnd(15)} rect ${x.rect.join(",")}  pic ${x.pic ? x.pic.join(",") : "?"}  video ${x.video.join("x")}  devFrac ${x.devFrac.join(",")}  tint ${x.tint}  lift ${x.lift}  filter ${x.filter}`).join("\n");
      if (why) console.log("wb-debug", why, JSON.stringify(s));
    };
    setInterval(() => draw(), 500);
    const chip = document.getElementById("chipWb"); if (chip) chip.addEventListener("click", () => { draw("before toggle"); setTimeout(() => draw("after toggle"), 50); setTimeout(() => draw("after toggle +500ms"), 500); });
    draw("init");
  };
})();
