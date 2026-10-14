// Builds synthetic Tesla-format encrypted clips (per crypto.js layout) from base.mp4 with known keys.
const fs = require("fs"), nc = require("crypto"), C = require("/workspace/dashcam-studio-v2/js/crypto.js");
const plain = fs.readFileSync("/workspace/fixtures/base.mp4"), PAGE = 4096;
const out = "/workspace/encfix/SentryClips/2026-10-05_09-00-00", keys = [];
["front", "back", "left_repeater", "right_repeater"].forEach((cam, i) => {
  const key = nc.randomBytes(16), rootIv = C.md5bytes(key), pages = Math.ceil(plain.length / PAGE);
  const padded = Buffer.alloc(pages * PAGE); plain.copy(padded);
  const f = Buffer.alloc(0x2000 + pages * PAGE);
  f.writeBigUInt64BE(BigInt(plain.length), 0); f.writeUInt32BE(0x11111111, 8); f.writeUInt32BE((0x11111111 ^ 0x3c81b7f5) >>> 0, 12);
  f.writeUInt32BE(0x03000002, 16); f.writeUInt32BE(0x1000, 20); f.writeUInt16BE(2, 24);
  let o = 0x1000; f.writeUInt32BE(7, o); o += 4; f[o] = 4; nc.randomBytes(64).copy(f, o + 1); o += 65; f[o++] = 0;
  f.write("5YJ3E1EA7KF000001", o, "latin1"); o += 17; f.writeBigUInt64BE(1700000000n, o); o += 8;
  const wrapped = nc.randomBytes(44); wrapped.copy(f, o);
  for (let p = 0; p < pages; p++) { const c = nc.createCipheriv("aes-128-cbc", key, Buffer.from(C.pageIv(rootIv, p))); c.setAutoPadding(false);
    Buffer.concat([c.update(padded.subarray(p * PAGE, (p + 1) * PAGE)), c.final()]).copy(f, 0x2000 + p * PAGE); }
  fs.writeFileSync(`${out}/2026-10-05_08-59-00-${cam}.mp4`, f);
  keys.push({ wrapped_key: wrapped.toString("base64"), key: key.toString("base64") });
});
fs.writeFileSync("/workspace/encfix/keys.json", JSON.stringify({ results: keys }));
