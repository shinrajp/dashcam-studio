/* tesla.js — key requests + local decryption.
 * HONESTY NOTE: dashcam.tesla.com/api/1/decrypt/batch is an UNDOCUMENTED endpoint observed from Tesla's own web viewer.
 * It may change or stop working at any time, and this code has only been tested against a local mock of it.
 * Only the small key-request records (VIN, key id, wrapped key, public key) are sent; video never leaves the computer. */
"use strict";
const fs = require("fs"), path = require("path"), nodeCrypto = require("crypto");
const CR = require("../../js/crypto.js");
const RO = require("./readonly");

const BASE = () => process.env.TDC_TESLA_BASE || "https://dashcam.tesla.com"; // override only for tests (mock server)

function keyItems(events) {
  const seen = new Map(); let n = 0;
  for (const ev of events) for (const c of ev.clips) for (const f of Object.values(c.files)) {
    if (f.kind !== "encrypted" || !f.header) continue;
    const h = f.header;
    if (!seen.has(h.wrappedHex)) seen.set(h.wrappedHex, { id: "c" + (++n), vin: h.vin, key_id: h.key_id, timestamp: h.timestamp, wrapped_key: h.wrapped_key, public_key: h.public_key });
  }
  return [...seen.values()];
}

/** → Map(wrappedHex → 16-byte key). Throws {code:"AUTH"} when the token is rejected (expired). */
async function fetchKeys(token, items) {
  const out = new Map();
  for (let i = 0; i < items.length; i += 100) {
    const batch = items.slice(i, i + 100);
    const r = await fetch(BASE() + "/api/1/decrypt/batch", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ items: batch }),
    });
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error("Tesla sign-in expired (HTTP " + r.status + ")"), { code: "AUTH" });
    if (!r.ok) throw new Error("Key request failed: HTTP " + r.status);
    const data = await r.json();
    applyResults(Array.isArray(data) ? data : data.results || [], batch, out);
  }
  return out;
}

function applyResults(results, items, out) {
  out = out || new Map();
  const byId = new Map(items.map((it) => [it.id, it.wrapped_key]));
  for (const r of results || []) {
    if (!r || r.error) continue;
    const wk = (typeof r.id === "string" && byId.get(r.id)) || r.wrapped_key;
    const key = typeof r.key === "string" ? Buffer.from(r.key, "base64") : null;
    if (!wk || !key || key.length !== 16) continue;
    out.set(CR.toHex(Buffer.from(wk, "base64")), key);
  }
  return out;
}

/** Decrypt one Tesla-encrypted clip (read-only source) into dest using Node's AES (page IV = MD5(MD5(key)‖page#)). */
async function decryptFile(src, dest, header, key) {
  RO.assertNotOnDrive(dest);
  const plain = Number(header.plaintext_size);
  const rootIv = CR.md5bytes(new Uint8Array(key));
  const r = await RO.reader(src);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const fh = await fs.promises.open(dest + ".part", "w");
  try {
    const pages = Math.ceil(plain / CR.PAGE);
    for (let p = 0, written = 0; p < pages; p += 256) {
      const n = Math.min(256, pages - p);
      const ct = Buffer.from(await r.read(CR.DATA + p * CR.PAGE, CR.DATA + (p + n) * CR.PAGE));
      const pt = Buffer.alloc(ct.length);
      for (let k = 0; k < n; k++) {
        const d = nodeCrypto.createDecipheriv("aes-128-cbc", key, Buffer.from(CR.pageIv(rootIv, p + k)));
        d.setAutoPadding(false);
        Buffer.concat([d.update(ct.subarray(k * CR.PAGE, (k + 1) * CR.PAGE)), d.final()]).copy(pt, k * CR.PAGE);
      }
      if (p === 0 && !CR.isMp4(pt)) throw Object.assign(new Error("Wrong key (decrypted data is not an MP4)"), { code: "WRONG_KEY" });
      const take = Math.min(pt.length, plain - written);
      await fh.write(pt, 0, take);
      written += take;
    }
  } finally { await fh.close(); await r.close(); }
  await fs.promises.rename(dest + ".part", dest);
}

module.exports = { keyItems, fetchKeys, applyResults, decryptFile, BASE };
