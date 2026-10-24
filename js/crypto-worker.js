/* crypto-worker.js — runs the T-table AES-CBC page decrypt of js/crypto.js off the main thread (used only when Web Crypto is
 * missing, i.e. plain http pages). Messages in: {id, keyBytes, rootIv, ct, firstPage}; out: {id, plain} or {id, error}. */
"use strict";
try {
  importScripts("crypto.js" + (self.location.search || ""));
  const C = self.TDC.crypto;
  self.onmessage = (e) => {
    const { id, keyBytes, rootIv, ct, firstPage } = e.data || {};
    try {
      const plain = C.decryptPagesJs(keyBytes, rootIv, ct, firstPage);
      self.postMessage({ id, plain: plain.buffer }, [plain.buffer]);
    } catch (x) { self.postMessage({ id, error: String((x && x.message) || x) }); }
  };
  self.postMessage({ ready: true });
} catch (x) { self.postMessage({ ready: false, error: String((x && x.message) || x) }); }
