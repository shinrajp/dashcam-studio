// T-table AES-128-CBC (js/crypto.js, the Web-Crypto-free fallback): byte-identical to Node's OpenSSL AES and to the old textbook
// implementation, on random data and through the real file flow (4096-byte pages, IV = MD5(MD5(key) || page number)); the
// Web Crypto path and the JS path must give the same file. Synthetic data only. Usage: node test/crypto-aes.js   (BENCH=1 prints MB/s)
const nc = require("crypto"), C = require("../js/crypto.js");
let fails = 0; const ok = (n, c, x) => { console.log((c ? "PASS " : "FAIL ") + n + (c || x === undefined ? "" : "  " + JSON.stringify(x))); if (!c) fails++; };

// the textbook byte-wise AES decrypt that js/crypto.js used before (kept here as the reference)
const SB = new Uint8Array(256); { let p = 1, q = 1; do { p = p ^ ((p << 1) & 255) ^ (p & 0x80 ? 0x1b : 0); q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 255; if (q & 0x80) q ^= 0x09; const x = q ^ ((q << 1 | q >> 7) & 255) ^ ((q << 2 | q >> 6) & 255) ^ ((q << 3 | q >> 5) & 255) ^ ((q << 4 | q >> 4) & 255); SB[p] = (x ^ 0x63) & 255; } while (p !== 1); SB[0] = 0x63; }
const ISB = new Uint8Array(256); for (let i = 0; i < 256; i++) ISB[SB[i]] = i;
const mul = (a, b) => { let p = 0; for (let i = 0; i < 8; i++) { if (b & 1) p ^= a; const h = a & 0x80; a = (a << 1) & 255; if (h) a ^= 0x1b; b >>= 1; } return p; };
function slowCbc(key, iv, ct) {
  const w = new Uint8Array(176); w.set(key, 0); const RC = [0, 1, 2, 4, 8, 16, 32, 64, 128, 27, 54];
  for (let i = 4; i < 44; i++) { let t = [w[(i - 1) * 4], w[(i - 1) * 4 + 1], w[(i - 1) * 4 + 2], w[(i - 1) * 4 + 3]]; if (i % 4 === 0) t = [SB[t[1]] ^ RC[i / 4], SB[t[2]], SB[t[3]], SB[t[0]]]; for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - 4) * 4 + j] ^ t[j]; }
  const out = new Uint8Array(ct.length), prev = Uint8Array.from(iv), s = new Uint8Array(16);
  for (let o = 0; o < ct.length; o += 16) {
    for (let i = 0; i < 16; i++) s[i] = ct[o + i] ^ w[160 + i];
    for (let r = 9; r >= 0; r--) {
      let t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t; t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t; t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
      for (let i = 0; i < 16; i++) s[i] = ISB[s[i]];
      for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i];
      if (r > 0) for (let c = 0; c < 4; c++) { const i = c * 4, a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3]; s[i] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9); s[i + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13); s[i + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11); s[i + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14); }
    }
    for (let i = 0; i < 16; i++) { out[o + i] = s[i] ^ prev[i]; prev[i] = ct[o + i]; }
  }
  return out;
}
const nodeCbc = (key, iv, ct) => { const d = nc.createDecipheriv("aes-128-cbc", key, iv).setAutoPadding(false); return new Uint8Array(Buffer.concat([d.update(ct), d.final()])); };
const eq = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

(async () => {
  // FIPS-197 appendix C.1 known answer (ECB = CBC with zero IV on one block)
  { const key = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex"), ct = Buffer.from("69c4e0d86a7b0430d8cdb78070b4c55a", "hex");
    ok("FIPS-197 known answer", Buffer.from(C.aes128CbcDecryptRaw(new Uint8Array(key), new Uint8Array(16), new Uint8Array(ct))).toString("hex") === "00112233445566778899aabbccddeeff"); }
  // random keys / IVs / sizes
  let bad = 0, n = 0;
  for (let i = 0; i < 60; i++) {
    const key = new Uint8Array(nc.randomBytes(16)), iv = new Uint8Array(nc.randomBytes(16)), len = 16 * (1 + Math.floor(Math.random() * (i < 50 ? 300 : 3000)));
    const ct = new Uint8Array(nc.randomBytes(len)), a = C.aes128CbcDecryptRaw(key, iv, ct), b = nodeCbc(key, iv, ct); n++;
    if (!eq(a, b)) bad++;
    if (i < 8 && !eq(a, slowCbc(key, iv, ct))) bad++;
  }
  ok("random data: identical to Node AES-128-CBC (" + n + " cases) and to the old textbook version (8 cases)", bad === 0, { bad });
  // unaligned views (Uint8Array with a byteOffset, like a subarray of a bigger buffer)
  { const key = new Uint8Array(nc.randomBytes(16)), iv = new Uint8Array(nc.randomBytes(16)), big = new Uint8Array(nc.randomBytes(8192 + 3)), view = big.subarray(3, 3 + 4096);
    ok("subarray with odd byteOffset", eq(C.aes128CbcDecryptRaw(key, iv, view), nodeCbc(key, iv, view))); }
  // real-shaped file: header page(s), ciphertext pages with IV = MD5(MD5(key) || page)
  const key = new Uint8Array(nc.randomBytes(16)), rootIv = new Uint8Array(nc.createHash("md5").update(key).digest());
  ok("md5bytes matches Node md5", eq(C.md5bytes(key), rootIv));
  const PAGE = 4096, pages = 700, size = pages * PAGE - 1234;      // not page aligned, like a real clip
  const plain = new Uint8Array(nc.randomBytes(pages * PAGE)); plain.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0);   // 'ftyp' box start
  const enc = new Uint8Array(0x2000 + pages * PAGE);
  for (let p = 0; p < pages; p++) {
    const m = Buffer.alloc(32); Buffer.from(rootIv).copy(m, 0); Buffer.from(String(p)).copy(m, 16);
    const iv = nc.createHash("md5").update(m).digest(), c = nc.createCipheriv("aes-128-cbc", key, iv).setAutoPadding(false);
    enc.set(Buffer.concat([c.update(plain.subarray(p * PAGE, (p + 1) * PAGE)), c.final()]), 0x2000 + p * PAGE);
    if (p < 3 && !eq(C.pageIv(rootIv, p), new Uint8Array(iv))) { ok("pageIv(" + p + ")", false); }
  }
  const file = new File([enc], "x.mp4");
  const want = plain.subarray(0, size);
  C._forceNoSubtle(true); ok("fast flag is false with Web Crypto off", C.fast === false);
  const seen = []; const j = new Uint8Array(await (await C.decryptFile(file, size, key, { noWorker: true, onProgress: (f) => seen.push(f) })).arrayBuffer());
  ok("file flow, JS fallback (main thread, time-sliced): identical to the plaintext", eq(j, want) && C.lastMode === "main", { mode: C.lastMode, len: j.length });
  ok("progress is monotonic and ends at 1", seen.length > 2 && seen.every((v, i) => !i || v >= seen[i - 1]) && seen[seen.length - 1] === 1, seen.slice(-3));
  C._forceNoSubtle(false);
  if (C.fast) { const w = new Uint8Array(await (await C.decryptFile(file, size, key, {})).arrayBuffer()); ok("file flow, Web Crypto path: identical to the plaintext (and so to the JS path)", eq(w, want) && C.lastMode === "webcrypto"); }
  else console.log("note: Web Crypto not available in this Node, Web Crypto path not compared");
  // wrong key is still caught, truncated input still caught
  C._forceNoSubtle(true);
  let code = ""; try { await C.decryptFile(file, size, new Uint8Array(nc.randomBytes(16)), { noWorker: true }); } catch (e) { code = e.code; }
  ok("wrong key → WRONG_KEY", code === "WRONG_KEY", code);
  code = ""; try { await C.decryptFile(new File([enc.subarray(0, 0x2000 + 5 * PAGE)], "t.mp4"), size, key, { noWorker: true }); } catch (e) { code = e.code; }
  ok("truncated file → CORRUPT", code === "CORRUPT", code);
  // a read that never finishes must fail with a clear error instead of hanging
  const stuck = { size: file.size, slice: () => ({ arrayBuffer: () => new Promise(() => {}) }) };
  code = ""; const t0 = Date.now(); try { await C.decryptFile(stuck, size, key, { noWorker: true, readTimeout: 300 }); } catch (e) { code = e.code; }
  ok("stuck file read → READ_TIMEOUT after the timeout, not a hang", code === "READ_TIMEOUT" && Date.now() - t0 < 3000, { code, ms: Date.now() - t0 });
  C._forceNoSubtle(false);
  // speed
  const MB = 32, big = new Uint8Array(nc.randomBytes(MB << 20)), k = new Uint8Array(nc.randomBytes(16)), iv0 = new Uint8Array(16);
  let t = process.hrtime.bigint(); C.aes128CbcDecryptRaw(k, iv0, big); const fastMs = Number(process.hrtime.bigint() - t) / 1e6;
  t = process.hrtime.bigint(); slowCbc(k, iv0, big.subarray(0, 1 << 20)); const slowMs = Number(process.hrtime.bigint() - t) / 1e6;
  const f = MB / (fastMs / 1000), s = 1 / (slowMs / 1000);
  console.log(`speed: T-table ${f.toFixed(0)} MB/s, old textbook ${s.toFixed(2)} MB/s (${(f / s).toFixed(0)}x)`);
  ok("T-table is at least 20x faster than the old code", f / s > 20, { f, s });
  console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
})();
