/* mp4.js — minimal ISO-BMFF demuxer: reads only the moov box and returns the first video
 * track's sample table (offsets, sizes, presentation times, keyframes) plus codec info.
 * Works in browsers (Blob reader) and Node (file reader). Reader: { size, read(start, end) → Promise<Uint8Array> } */
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else { root.TDC = root.TDC || {}; root.TDC.mp4 = m; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const type4 = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");

  function boxes(u8, start, end) {
    const out = [];
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p), hdr = 8;
      const type = type4(u8, p + 4);
      if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) break;
      out.push({ type, start: p + hdr, end: p + size });
      p += size;
    }
    return out;
  }
  const child = (u8, box, t) => (box && boxes(u8, box.start, box.end).find((b) => b.type === t)) || null;
  const path = (u8, box, list) => { let b = box; for (const t of list) { b = child(u8, b, t); if (!b) return null; } return b; };

  function codecString(fmt, cfgType, c) {
    if (cfgType === "avcC") return `${fmt}.${hex2(c[1])}${hex2(c[2])}${hex2(c[3])}`;
    if (cfgType === "hvcC") {
      const space = ["", "A", "B", "C"][c[1] >> 6], tier = (c[1] >> 5) & 1 ? "H" : "L", profile = c[1] & 31;
      let flags = ((c[2] << 24) | (c[3] << 16) | (c[4] << 8) | c[5]) >>> 0, rev = 0;
      for (let i = 0; i < 32; i++) { rev = (rev << 1) | (flags & 1); flags >>>= 1; }
      const cons = Array.from(c.subarray(6, 12));
      while (cons.length && cons[cons.length - 1] === 0) cons.pop();
      return `${fmt}.${space}${profile}.${(rev >>> 0).toString(16).toUpperCase()}.${tier}${c[12]}` + (cons.length ? "." + cons.map(hex2).join(".") : "");
    }
    return null;
  }

  /** Locate and read the moov box. */
  async function readMoov(reader) {
    let pos = 0;
    while (pos + 8 <= reader.size) {
      const h = await reader.read(pos, Math.min(reader.size, pos + 16));
      const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
      let size = dv.getUint32(0), hdr = 8;
      const type = type4(h, 4);
      if (size === 1) { size = Number(dv.getBigUint64(8)); hdr = 16; } else if (size === 0) size = reader.size - pos;
      if (size < hdr) throw new Error("bad MP4 box");
      if (type === "moov") return reader.read(pos + hdr, pos + size);
      pos += size;
    }
    throw new Error("no moov box");
  }

  /** Demux the first video track. */
  async function demux(reader) {
    const u8 = await readMoov(reader);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const rootBox = { start: 0, end: u8.length };
    if (child(u8, rootBox, "mvex")) throw new Error("fragmented MP4 not supported");
    const mvhd = child(u8, rootBox, "mvhd");
    const mvTs = mvhd ? (u8[mvhd.start] === 1 ? dv.getUint32(mvhd.start + 20) : dv.getUint32(mvhd.start + 12)) : 1000;
    for (const trak of boxes(u8, 0, u8.length).filter((b) => b.type === "trak")) {
      const hdlr = path(u8, trak, ["mdia", "hdlr"]);
      if (!hdlr || type4(u8, hdlr.start + 8) !== "vide") continue;
      const mdhd = path(u8, trak, ["mdia", "mdhd"]);
      const ts = u8[mdhd.start] === 1 ? dv.getUint32(mdhd.start + 20) : dv.getUint32(mdhd.start + 12);
      const stbl = path(u8, trak, ["mdia", "minf", "stbl"]);
      const stsd = child(u8, stbl, "stsd");
      const entry = boxes(u8, stsd.start + 8, stsd.end)[0];
      if (!entry) throw new Error("no sample entry");
      const fmt = type4(u8, entry.start - 4);
      const width = dv.getUint16(entry.start + 24), height = dv.getUint16(entry.start + 26);
      const cfgBox = boxes(u8, entry.start + 78, entry.end).find((b) => ["avcC", "hvcC"].includes(b.type));
      if (!cfgBox) throw new Error("unsupported sample entry " + fmt);
      const description = u8.slice(cfgBox.start, cfgBox.end);
      const codec = codecString(fmt, cfgBox.type, description);
      const box = (t) => child(u8, stbl, t);
      const stts = box("stts"), ctts = box("ctts"), stsc = box("stsc"), stsz = box("stsz"), stss = box("stss");
      const stco = box("stco"), co64 = box("co64");
      if (!stts || !stsc || !stsz || !(stco || co64)) throw new Error("missing sample tables");
      const n = dv.getUint32(stsz.start + 8), fixed = dv.getUint32(stsz.start + 4);
      const sizes = new Uint32Array(n);
      for (let i = 0; i < n; i++) sizes[i] = fixed || dv.getUint32(stsz.start + 12 + i * 4);
      const dts = new Float64Array(n);
      { let i = 0, t = 0; const cnt = dv.getUint32(stts.start + 4);
        for (let e = 0; e < cnt; e++) { const c = dv.getUint32(stts.start + 8 + e * 8), d = dv.getUint32(stts.start + 12 + e * 8);
          for (let k = 0; k < c && i < n; k++) { dts[i++] = t; t += d; } } }
      const cts = Float64Array.from(dts);
      if (ctts) { const v1 = u8[ctts.start] === 1, cnt = dv.getUint32(ctts.start + 4); let i = 0;
        for (let e = 0; e < cnt; e++) { const c = dv.getUint32(ctts.start + 8 + e * 8);
          const off = v1 ? dv.getInt32(ctts.start + 12 + e * 8) : dv.getUint32(ctts.start + 12 + e * 8);
          for (let k = 0; k < c && i < n; k++, i++) cts[i] += off; } }
      const chunkOffsets = [];
      if (stco) { const c = dv.getUint32(stco.start + 4); for (let i = 0; i < c; i++) chunkOffsets.push(dv.getUint32(stco.start + 8 + i * 4)); }
      else { const c = dv.getUint32(co64.start + 4); for (let i = 0; i < c; i++) chunkOffsets.push(Number(dv.getBigUint64(co64.start + 8 + i * 8))); }
      const offsets = new Float64Array(n);
      { const cnt = dv.getUint32(stsc.start + 4), ents = [];
        for (let e = 0; e < cnt; e++) ents.push([dv.getUint32(stsc.start + 8 + e * 12), dv.getUint32(stsc.start + 12 + e * 12)]);
        let s = 0;
        for (let e = 0; e < ents.length; e++) {
          const first = ents[e][0], per = ents[e][1], last = e + 1 < ents.length ? ents[e + 1][0] - 1 : chunkOffsets.length;
          for (let ch = first; ch <= last && s < n; ch++) { let off = chunkOffsets[ch - 1]; for (let k = 0; k < per && s < n; k++) { offsets[s] = off; off += sizes[s]; s++; } }
        } }
      const isKey = new Uint8Array(n);
      if (stss) { const c = dv.getUint32(stss.start + 4); for (let i = 0; i < c; i++) { const k = dv.getUint32(stss.start + 8 + i * 4) - 1; if (k >= 0 && k < n) isKey[k] = 1; } }
      else isKey.fill(1);
      let mediaStart = 0, emptyDelay = 0;
      const elst = path(u8, trak, ["edts", "elst"]);
      if (elst) { const v1 = u8[elst.start] === 1, cnt = dv.getUint32(elst.start + 4); let p = elst.start + 8;
        for (let e = 0; e < cnt; e++) {
          const segDur = v1 ? Number(dv.getBigUint64(p)) : dv.getUint32(p);
          const mt = v1 ? Number(dv.getBigInt64(p + 8)) : dv.getInt32(p + 4);
          p += v1 ? 20 : 12;
          if (mt === -1) { emptyDelay += segDur / mvTs; continue; }
          mediaStart = mt; break;
        } }
      const pts = new Float64Array(n); // microseconds
      for (let i = 0; i < n; i++) pts[i] = Math.round(((cts[i] - mediaStart) / ts + emptyDelay) * 1e6);
      const sorted = Array.from(pts).sort((a, b) => a - b), deltas = [];
      for (let i = 1; i < sorted.length; i++) if (sorted[i] > sorted[i - 1]) deltas.push(sorted[i] - sorted[i - 1]);
      deltas.sort((a, b) => a - b);
      const med = deltas.length ? deltas[deltas.length >> 1] : 33333;
      let fps = 1e6 / med;
      fps = Math.abs(fps - Math.round(fps)) < 0.05 ? Math.round(fps) : Math.round(fps * 1000) / 1000;
      const duration = n ? (sorted[n - 1] + med) / 1e6 : 0;
      return { codec, fmt, description, width, height, n, sizes, offsets, pts, isKey, frameUs: med, fps, duration };
    }
    throw new Error("no video track");
  }

  return { demux, boxes };
});
