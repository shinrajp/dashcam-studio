/* sei.js — Tesla dashcam telemetry from H.264 SEI (own implementation).
 * SEI NAL (type 6) → payloadType 5 (user_data_unregistered) → 16-byte marker (0x42 … 0x69) → protobuf SeiMetadata.
 * Usable in browsers and Node. */
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else { root.TDC = root.TDC || {}; root.TDC.sei = m; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  // field number → [name, kind]  (kind: b = bool, n = number)
  const FIELDS = {
    1: "version", 2: "gear", 3: "seq", 4: "speed", 5: "pedal", 6: "steer", 7: "blinkL", 8: "blinkR", 9: "brake",
    10: "ap", 11: "lat", 12: "lon", 13: "heading", 14: "ax", 15: "ay", 16: "az",
  };
  const BOOL = { 7: 1, 8: 1, 9: 1 };
  const GEAR = ["P", "D", "R", "N"]; // PARK0 DRIVE1 REVERSE2 NEUTRAL3
  const AP = ["NONE", "SELF_DRIVING", "AUTOSTEER", "TACC"];

  /** Remove H.264 emulation-prevention bytes (00 00 03 → 00 00). */
  function stripEpb(u8) {
    let has = false;
    for (let i = 2; i < u8.length; i++) if (u8[i] === 3 && u8[i - 1] === 0 && u8[i - 2] === 0) { has = true; break; }
    if (!has) return u8;
    const out = new Uint8Array(u8.length);
    let n = 0, zeros = 0;
    for (let i = 0; i < u8.length; i++) {
      const b = u8[i];
      if (zeros >= 2 && b === 3) { zeros = 0; continue; }
      out[n++] = b;
      zeros = b === 0 ? zeros + 1 : 0;
    }
    return out.subarray(0, n);
  }

  /** proto3 decoder for SeiMetadata. Returns null if nothing recognisable. Unknown fields are skipped. */
  function decode(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const m = { version: 0, gear: 0, seq: 0, speed: 0, pedal: 0, steer: 0, blinkL: false, blinkR: false, brake: false, ap: 0, lat: 0, lon: 0, heading: 0, ax: 0, ay: 0, az: 0 };
    let p = 0, known = 0;
    const varint = () => {
      let r = 0, mul = 1;
      for (let k = 0; k < 10; k++) {
        if (p >= b.length) throw new Error("truncated varint");
        const x = b[p++];
        r += (x & 0x7f) * mul; mul *= 128;
        if (!(x & 0x80)) return r;
      }
      throw new Error("bad varint");
    };
    while (p < b.length) {
      const key = varint(), f = Math.floor(key / 8), w = key % 8;
      if (f === 0) throw new Error("field 0");
      let v;
      if (w === 0) v = varint();
      else if (w === 1) { if (p + 8 > b.length) throw new Error("truncated"); v = dv.getFloat64(p, true); p += 8; }
      else if (w === 5) { if (p + 4 > b.length) throw new Error("truncated"); v = dv.getFloat32(p, true); p += 4; }
      else if (w === 2) { const len = varint(); p += len; if (p > b.length) throw new Error("truncated"); continue; }
      else throw new Error("wire type " + w);
      const name = FIELDS[f];
      if (!name) continue;
      known++;
      m[name] = BOOL[f] ? !!v : v;
    }
    return known >= 2 ? m : null;
  }

  /** Tesla protobuf bytes from one user_data_unregistered payload, or null. */
  function teslaPayload(pl) {
    let i = 0;
    while (i < pl.length && pl[i] === 0x42) i++;
    if (i >= 1 && i < pl.length && pl[i] === 0x69) return pl.subarray(i + 1);
    return null;
  }

  /** All SeiMetadata messages from one SEI NAL unit (header byte included, EPB not yet removed). */
  function fromSeiNal(nal) {
    const rb = stripEpb(nal.subarray(1));
    let p = 0;
    while (p + 2 <= rb.length) {
      if (p === rb.length - 1 && rb[p] === 0x80) break; // rbsp trailing bits
      let type = 0, size = 0;
      while (p < rb.length && rb[p] === 0xff) { type += 255; p++; }
      type += rb[p++];
      while (p < rb.length && rb[p] === 0xff) { size += 255; p++; }
      size += rb[p++];
      let end = p + size;
      if (end > rb.length) end = rb.length - (rb[rb.length - 1] === 0x80 ? 1 : 0); // tolerate a wrong size
      if (type === 5) {
        const pb = teslaPayload(rb.subarray(p, end));
        if (pb) { try { const m = decode(pb); if (m) return m; } catch (_) {} }
      }
      p = end;
    }
    return null;
  }

  /** Walk length-prefixed NAL units of one sample; returns the first Tesla message or null. */
  function fromSample(u8, lenSize, all) {
    let p = 0;
    while (p + lenSize <= u8.length) {
      let len = 0;
      for (let k = 0; k < lenSize; k++) len = len * 256 + u8[p + k];
      p += lenSize;
      if (len < 1 || p + len > u8.length) break;
      const t = u8[p] & 0x1f;
      if (t === 6) { const m = fromSeiNal(u8.subarray(p, p + len)); if (m) return m; }
      else if ((t === 1 || t === 5) && !all) break; // usually telemetry precedes the picture data; `all` keeps walking (Tesla's reference parser doesn't assume the order)
      p += len;
    }
    return null;
  }

  /**
   * Parse a whole clip. reader: { size, read(a,b) }. demux: result of mp4.demux (optional).
   * Returns { rows: [[tSeconds, msg], ...], fps, duration } — rows empty when the clip has no telemetry.
   * opts.yieldFn: async function called periodically; opts.cancelled(): boolean.
   */
  async function parseClip(reader, tr, opts) {
    opts = opts || {};
    const rows = [];
    if (!/^avc[13]$/.test(tr.fmt) || !tr.description || tr.description.length < 5) return { rows, fps: tr.fps, duration: tr.duration };
    const lenSize = (tr.description[4] & 3) + 1;
    let buf = null, bufStart = 0, misses = 0;
    for (let i = 0; i < tr.n; i++) {
      if (opts.cancelled && opts.cancelled()) return null;
      const off = tr.offsets[i], size = tr.sizes[i];
      // Only the head of each sample is needed (SEI precedes the slice data).
      const want = Math.min(size, 4096);
      if (!buf || off < bufStart || off + want > bufStart + buf.length) {
        buf = await reader.read(off, Math.min(reader.size, off + Math.max(want, 4 << 20)));
        bufStart = off;
      }
      const s = off - bufStart;
      let m = fromSample(buf.subarray(s, Math.min(buf.length, s + want)), lenSize, true);
      if (!m && size > want) m = fromSample(await reader.read(off, Math.min(reader.size, off + size)), lenSize, true); // SEI after the slice
      if (m) rows.push([tr.pts[i] / 1e6, m]);
      else if (!rows.length && ++misses > 90) break; // no telemetry in the first ~3 s → give up
      if ((i & 127) === 127 && opts.yieldFn) await opts.yieldFn();
    }
    rows.sort((a, b) => a[0] - b[0]);
    return { rows, fps: tr.fps, duration: tr.duration };
  }

  return { decode, fromSeiNal, fromSample, parseClip, stripEpb, GEAR, AP };
});
