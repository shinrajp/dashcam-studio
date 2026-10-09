/* crypto.js — Tesla encrypted dashcam clips (firmware 2026.20+ "EncryptedClips"), decrypted locally.
 * Container layout (eCryptfs-style; reverse-engineered, NOT documented by Tesla):
 *   0x00 u64 BE plaintext size · 0x08/0x0C u32 pair whose XOR is 0x3C81B7F5 · 0x10 u32 0x03000002
 *   0x14 u32 header extent size (0x1000) · 0x18 u16 extent count (2) → ciphertext starts at 0x2000
 *   0x1000 key area: u32 key_id, EC public key (0x04…, 57–65 B) [0x00], VIN (17), u64 timestamp, wrapped key (44 B)
 *   data: 4096-byte pages, AES-128-CBC, IV(page) = MD5( MD5(key) ‖ ascii(page) zero-padded to 16 B )
 * The 16-byte file key is obtained from Tesla (undocumented endpoint) by unwrapping the wrapped key.
 * Works in browsers; the pure functions (classify, parseKeyArea, md5bytes, pageIv) also load in Node. */
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else { root.TDC = root.TDC || {}; root.TDC.crypto = m; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const PAGE = 4096, KEY_AREA = 0x1000, DATA = 0x2000, MAGIC = 0x3c81b7f5, VERSION_FLAGS = 0x03000002;
  const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
  const subtle = typeof crypto !== "undefined" && crypto && crypto.subtle ? crypto.subtle : null;
  const PAD_BLOCK = new Uint8Array(16).fill(0x10);
  function md5bytes(input) {
    const msg = input instanceof Uint8Array ? input : new Uint8Array(input);
    function cmn(q, a, b, x, s, t) {
      a = (a + q + x + t) | 0;
      return (((a << s) | (a >>> (32 - s))) + b) | 0;
    }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

    const n = msg.length;
    const words = [];
    for (let i = 0; i < n; i++) {
      words[i >> 2] |= msg[i] << ((i % 4) * 8);
    }
    words[n >> 2] |= 0x80 << ((n % 4) * 8);
    const bitLen = n * 8;
    const size = (((n + 8) >> 6) + 1) * 16;
    while (words.length < size) words.push(0);
    words[size - 2] = bitLen & 0xffffffff;
    words[size - 1] = (bitLen / 0x100000000) | 0;

    let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
    for (let i = 0; i < words.length; i += 16) {
      const oa = a, ob = b, oc = c, od = d;
      a = ff(a, b, c, d, words[i + 0], 7, 0xd76aa478);
      d = ff(d, a, b, c, words[i + 1], 12, 0xe8c7b756);
      c = ff(c, d, a, b, words[i + 2], 17, 0x242070db);
      b = ff(b, c, d, a, words[i + 3], 22, 0xc1bdceee);
      a = ff(a, b, c, d, words[i + 4], 7, 0xf57c0faf);
      d = ff(d, a, b, c, words[i + 5], 12, 0x4787c62a);
      c = ff(c, d, a, b, words[i + 6], 17, 0xa8304613);
      b = ff(b, c, d, a, words[i + 7], 22, 0xfd469501);
      a = ff(a, b, c, d, words[i + 8], 7, 0x698098d8);
      d = ff(d, a, b, c, words[i + 9], 12, 0x8b44f7af);
      c = ff(c, d, a, b, words[i + 10], 17, 0xffff5bb1);
      b = ff(b, c, d, a, words[i + 11], 22, 0x895cd7be);
      a = ff(a, b, c, d, words[i + 12], 7, 0x6b901122);
      d = ff(d, a, b, c, words[i + 13], 12, 0xfd987193);
      c = ff(c, d, a, b, words[i + 14], 17, 0xa679438e);
      b = ff(b, c, d, a, words[i + 15], 22, 0x49b40821);
      a = gg(a, b, c, d, words[i + 1], 5, 0xf61e2562);
      d = gg(d, a, b, c, words[i + 6], 9, 0xc040b340);
      c = gg(c, d, a, b, words[i + 11], 14, 0x265e5a51);
      b = gg(b, c, d, a, words[i + 0], 20, 0xe9b6c7aa);
      a = gg(a, b, c, d, words[i + 5], 5, 0xd62f105d);
      d = gg(d, a, b, c, words[i + 10], 9, 0x02441453);
      c = gg(c, d, a, b, words[i + 15], 14, 0xd8a1e681);
      b = gg(b, c, d, a, words[i + 4], 20, 0xe7d3fbc8);
      a = gg(a, b, c, d, words[i + 9], 5, 0x21e1cde6);
      d = gg(d, a, b, c, words[i + 14], 9, 0xc33707d6);
      c = gg(c, d, a, b, words[i + 3], 14, 0xf4d50d87);
      b = gg(b, c, d, a, words[i + 8], 20, 0x455a14ed);
      a = gg(a, b, c, d, words[i + 13], 5, 0xa9e3e905);
      d = gg(d, a, b, c, words[i + 2], 9, 0xfcefa3f8);
      c = gg(c, d, a, b, words[i + 7], 14, 0x676f02d9);
      b = gg(b, c, d, a, words[i + 12], 20, 0x8d2a4c8a);
      a = hh(a, b, c, d, words[i + 5], 4, 0xfffa3942);
      d = hh(d, a, b, c, words[i + 8], 11, 0x8771f681);
      c = hh(c, d, a, b, words[i + 11], 16, 0x6d9d6122);
      b = hh(b, c, d, a, words[i + 14], 23, 0xfde5380c);
      a = hh(a, b, c, d, words[i + 1], 4, 0xa4beea44);
      d = hh(d, a, b, c, words[i + 4], 11, 0x4bdecfa9);
      c = hh(c, d, a, b, words[i + 7], 16, 0xf6bb4b60);
      b = hh(b, c, d, a, words[i + 10], 23, 0xbebfbc70);
      a = hh(a, b, c, d, words[i + 13], 4, 0x289b7ec6);
      d = hh(d, a, b, c, words[i + 0], 11, 0xeaa127fa);
      c = hh(c, d, a, b, words[i + 3], 16, 0xd4ef3085);
      b = hh(b, c, d, a, words[i + 6], 23, 0x04881d05);
      a = hh(a, b, c, d, words[i + 9], 4, 0xd9d4d039);
      d = hh(d, a, b, c, words[i + 12], 11, 0xe6db99e5);
      c = hh(c, d, a, b, words[i + 15], 16, 0x1fa27cf8);
      b = hh(b, c, d, a, words[i + 2], 23, 0xc4ac5665);
      a = ii(a, b, c, d, words[i + 0], 6, 0xf4292244);
      d = ii(d, a, b, c, words[i + 7], 10, 0x432aff97);
      c = ii(c, d, a, b, words[i + 14], 15, 0xab9423a7);
      b = ii(b, c, d, a, words[i + 5], 21, 0xfc93a039);
      a = ii(a, b, c, d, words[i + 12], 6, 0x655b59c3);
      d = ii(d, a, b, c, words[i + 3], 10, 0x8f0ccc92);
      c = ii(c, d, a, b, words[i + 10], 15, 0xffeff47d);
      b = ii(b, c, d, a, words[i + 1], 21, 0x85845dd1);
      a = ii(a, b, c, d, words[i + 8], 6, 0x6fa87e4f);
      d = ii(d, a, b, c, words[i + 15], 10, 0xfe2ce6e0);
      c = ii(c, d, a, b, words[i + 6], 15, 0xa3014314);
      b = ii(b, c, d, a, words[i + 13], 21, 0x4e0811a1);
      a = ii(a, b, c, d, words[i + 4], 6, 0xf7537e82);
      d = ii(d, a, b, c, words[i + 11], 10, 0xbd3af235);
      c = ii(c, d, a, b, words[i + 2], 15, 0x2ad7d2bb);
      b = ii(b, c, d, a, words[i + 9], 21, 0xeb86d391);
      a = (a + oa) | 0; b = (b + ob) | 0; c = (c + oc) | 0; d = (d + od) | 0;
    }

    const out = new Uint8Array(16);
    const regs = [a, b, c, d];
    for (let i = 0; i < 4; i++) {
      out[i * 4] = regs[i] & 0xff;
      out[i * 4 + 1] = (regs[i] >>> 8) & 0xff;
      out[i * 4 + 2] = (regs[i] >>> 16) & 0xff;
      out[i * 4 + 3] = (regs[i] >>> 24) & 0xff;
    }
    return out;
  }

  // Standard AES S-box / inv S-box / Rcon (compact tables)
  const SBOX = new Uint8Array([
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
  ]);
  const INV_SBOX = new Uint8Array(256);
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
  const RCON = new Uint8Array([0x00,0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36]);

  function aesMul(a, b) {
    let p = 0;
    for (let i = 0; i < 8; i++) {
      if (b & 1) p ^= a;
      const hi = a & 0x80;
      a = (a << 1) & 0xff;
      if (hi) a ^= 0x1b;
      b >>= 1;
    }
    return p;
  }

  function aesExpandKey128(key) {
    const w = new Uint8Array(176);
    w.set(key.subarray(0, 16), 0);
    for (let i = 4; i < 44; i++) {
      let t0 = w[(i - 1) * 4], t1 = w[(i - 1) * 4 + 1], t2 = w[(i - 1) * 4 + 2], t3 = w[(i - 1) * 4 + 3];
      if (i % 4 === 0) {
        const old0 = t0;
        t0 = SBOX[t1] ^ RCON[i / 4];
        t1 = SBOX[t2];
        t2 = SBOX[t3];
        t3 = SBOX[old0];
      }
      w[i * 4] = w[(i - 4) * 4] ^ t0;
      w[i * 4 + 1] = w[(i - 4) * 4 + 1] ^ t1;
      w[i * 4 + 2] = w[(i - 4) * 4 + 2] ^ t2;
      w[i * 4 + 3] = w[(i - 4) * 4 + 3] ^ t3;
    }
    return w;
  }

  function aesDecryptBlock(input, off, out, oOff, rk) {
    const s = new Uint8Array(16);
    for (let i = 0; i < 16; i++) s[i] = input[off + i] ^ rk[160 + i];
    for (let round = 9; round >= 1; round--) {
      // InvShiftRows
      let t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;
      t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
      t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
      // InvSubBytes
      for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
      // AddRoundKey
      const rko = round * 16;
      for (let i = 0; i < 16; i++) s[i] ^= rk[rko + i];
      // InvMixColumns
      for (let c = 0; c < 4; c++) {
        const i = c * 4;
        const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
        s[i] = aesMul(a0, 0x0e) ^ aesMul(a1, 0x0b) ^ aesMul(a2, 0x0d) ^ aesMul(a3, 0x09);
        s[i + 1] = aesMul(a0, 0x09) ^ aesMul(a1, 0x0e) ^ aesMul(a2, 0x0b) ^ aesMul(a3, 0x0d);
        s[i + 2] = aesMul(a0, 0x0d) ^ aesMul(a1, 0x09) ^ aesMul(a2, 0x0e) ^ aesMul(a3, 0x0b);
        s[i + 3] = aesMul(a0, 0x0b) ^ aesMul(a1, 0x0d) ^ aesMul(a2, 0x09) ^ aesMul(a3, 0x0e);
      }
    }
    // Final round
    let t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;
    t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
    t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
    for (let i = 0; i < 16; i++) out[oOff + i] = INV_SBOX[s[i]] ^ rk[i];
  }

  function aes128CbcDecryptRaw(keyBytes, iv, ciphertext) {
    if (keyBytes.length !== 16) throw new Error("AES-128 key required");
    if (iv.length !== 16) throw new Error("IV must be 16 bytes");
    if (ciphertext.length % 16 !== 0) throw new Error("Ciphertext must be block-aligned");
    const rk = aesExpandKey128(keyBytes);
    const out = new Uint8Array(ciphertext.length);
    const prev = new Uint8Array(16);
    prev.set(iv);
    const block = new Uint8Array(16);
    for (let i = 0; i < ciphertext.length; i += 16) {
      aesDecryptBlock(ciphertext, i, block, 0, rk);
      for (let j = 0; j < 16; j++) {
        out[i + j] = block[j] ^ prev[j];
        prev[j] = ciphertext[i + j];
      }
    }
    return out;
  }
  const beU32 = (u8, o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
  const beU64 = (u8, o) => beU32(u8, o) * 0x100000000 + beU32(u8, o + 4);
  const isZero = (u8) => { for (let i = 0; i < u8.length; i++) if (u8[i]) return false; return true; };
  const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
  function b64(u8) { let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return typeof btoa === "function" ? btoa(s) : Buffer.from(u8).toString("base64"); }
  function unb64(str) {
  if (typeof str !== "string" || !str.length || str.length > 4096) return null;
  try {
    const bin = typeof atob === "function" ? atob(str.replace(/\s+/g, "")) : Buffer.from(str, "base64").toString("binary");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (_) { return null; }
  }
  const isMp4 = (u8) => u8 && u8.length >= 12 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70;

  function parseKeyArea(u8) {
  const base = KEY_AREA;
  if (u8.length < base + 0x100) return { ok: false, reason: "Key area unreadable" };
  if (isZero(u8.subarray(base, base + 0x100))) return { ok: false, reason: "Blank key area (copied while still recording?)" };
  const keyId = beU32(u8, base), pk = base + 4;
  if (u8[pk] !== 0x04) return { ok: false, reason: "Key area has no public key" };
  const cands = [];
  let end = pk;
  while (end < pk + 66 && u8[end] !== 0) end++;
  const scan = end - pk;
  if (scan >= 57 && scan <= 65) cands.push({ len: scan, vin: end + 1 }, { len: scan, vin: end });
  cands.push({ len: 65, vin: pk + 65 });
  for (let len = 65; len >= 57; len--) cands.push({ len, vin: pk + len }, { len, vin: pk + len + 1 });
  for (const c of cands) {
    const vinB = u8.subarray(c.vin, c.vin + 17), wrapped = u8.subarray(c.vin + 25, c.vin + 25 + 44);
    if (vinB.length !== 17 || wrapped.length !== 44) continue;
    const vin = String.fromCharCode(...vinB);
    if (!VIN_RE.test(vin)) continue;
    if (isZero(wrapped)) return { ok: false, reason: "Blank wrapped key (copied while still recording?)" };
    return { ok: true, header: { vin, key_id: keyId, timestamp: beU64(u8, c.vin + 17), wrapped_key: b64(wrapped), public_key: b64(u8.subarray(pk, pk + c.len)), wrappedHex: toHex(wrapped) } };
  }
  return { ok: false, reason: "Unrecognised key area layout" };
  }

  /** Classify a file from its first 8 KiB: plain | encrypted | undecryptable | unknown | empty. */
  function classify(u8, fileSize) {
  if (!fileSize) return { kind: "empty", reason: "Empty file" };
  if (isMp4(u8)) return { kind: "plain" };
  if (u8.length < 32 || ((beU32(u8, 8) ^ beU32(u8, 12)) >>> 0) !== MAGIC) return { kind: "unknown", reason: "Not an MP4 or Tesla encrypted clip" };
  const problems = [];
  if (beU32(u8, 16) !== VERSION_FLAGS) problems.push("version flags");
  if (beU32(u8, 20) !== KEY_AREA) problems.push("header extent size");
  if (fileSize % PAGE !== 0) problems.push("size not a multiple of 4096 (incomplete copy?)");
  const plain = beU64(u8, 0);
  if (!(plain > 0) || Math.ceil(plain / PAGE) * PAGE > fileSize - DATA) problems.push("bad plaintext size");
  if (problems.length) return { kind: "undecryptable", reason: "Encrypted file damaged: " + problems.join(", ") };
  const ka = parseKeyArea(u8);
  if (!ka.ok) return { kind: "undecryptable", reason: ka.reason };
  ka.header.plaintext_size = plain;
  return { kind: "encrypted", header: ka.header };
  }

  function pageIv(rootIv, page) {
  const m = new Uint8Array(32);
  m.set(rootIv, 0);
  const s = String(page);
  for (let i = 0; i < s.length && i < 15; i++) m[16 + i] = s.charCodeAt(i);
  return md5bytes(m);
  }

  // Web Crypto AES-CBC strips PKCS#7 on decrypt, so append a crafted block that decrypts to a full padding
  // block; N pages are decrypted in one call (as if chained), then each page's first block is corrected.
  async function decryptPagesWebCrypto(key, rootIv, ct, firstPage) {
  const n = ct.length / PAGE;
  const padEnc = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv: ct.slice(ct.length - 16) }, key, PAD_BLOCK));
  const buf = new Uint8Array(ct.length + 16);
  buf.set(ct, 0); buf.set(padEnc.subarray(0, 16), ct.length);
  const plain = new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv: pageIv(rootIv, firstPage) }, key, buf));
  if (plain.length !== ct.length) throw new Error("Web Crypto length mismatch");
  for (let k = 1; k < n; k++) {
    const off = k * PAGE, iv = pageIv(rootIv, firstPage + k);
    for (let j = 0; j < 16; j++) plain[off + j] ^= ct[off - 16 + j] ^ iv[j];
  }
  return plain;
  }
  function decryptPagesJs(keyBytes, rootIv, ct, firstPage) {
  const out = new Uint8Array(ct.length);
  for (let k = 0; k * PAGE < ct.length; k++) out.set(aes128CbcDecryptRaw(keyBytes, pageIv(rootIv, firstPage + k), ct.subarray(k * PAGE, (k + 1) * PAGE)), k * PAGE);
  return out;
  }

  /** Decrypt a Blob/File → File (video/mp4). Verifies the 'ftyp' box after the first page (wrong key → WRONG_KEY). */
  async function decryptFile(file, plaintextSize, keyBytes, opts) {
  opts = opts || {};
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 16) throw Object.assign(new Error("Key is not 16 bytes"), { code: "BAD_KEY" });
  const pages = Math.ceil(plaintextSize / PAGE);
  if (DATA + pages * PAGE > file.size) throw Object.assign(new Error("Ciphertext truncated"), { code: "CORRUPT" });
  const rootIv = md5bytes(keyBytes);
  let key = null;
  if (subtle) { try { key = await subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["encrypt", "decrypt"]); } catch (_) { key = null; } }
  const parts = [];
  let page = 0, written = 0;
  while (page < pages) {
    if (opts.cancelled && opts.cancelled()) throw Object.assign(new Error("cancelled"), { code: "ABORTED" });
    const n = page === 0 ? 1 : Math.min(256, pages - page);
    const start = DATA + page * PAGE;
    const ct = new Uint8Array(await file.slice(start, start + n * PAGE).arrayBuffer());
    let plain = key ? await decryptPagesWebCrypto(key, rootIv, ct, page) : decryptPagesJs(keyBytes, rootIv, ct, page);
    if (page === 0 && !isMp4(plain)) throw Object.assign(new Error("Wrong key — the decrypted data is not an MP4"), { code: "WRONG_KEY" });
    if (plain.length > plaintextSize - written) plain = plain.subarray(0, plaintextSize - written);
    parts.push(new Blob([plain]));
    written += plain.length; page += n;
    if (opts.onProgress) opts.onProgress(written / plaintextSize);
    if (!key) await new Promise((r) => setTimeout(r, 0));
  }
  return new File(parts, opts.name || "decrypted.mp4", { type: "video/mp4" });
  }

  return { classify, parseKeyArea, decryptFile, md5bytes, pageIv, b64, unb64, toHex, isMp4, PAGE, DATA, PROBE: DATA };
});
