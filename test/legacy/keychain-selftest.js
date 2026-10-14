// self-test of companion/lib/keychain.js against a throwaway Keychain service (TDC_KEYCHAIN_SERVICE=TDC-selftest)
process.env.TDC_KEYCHAIN_SERVICE = "TDC-selftest";
const K = require(process.argv[2] + "/companion/lib/keychain.js");
const crypto = require("crypto");
for (const n of [1200, 2400, 5300, 9100]) {
  const tok = "eyJ" + crypto.randomBytes(n).toString("base64url").slice(0, n);
  try { K.set(tok); const got = K.get(); console.log(n, got === tok ? "MATCH" : "MISMATCH " + (got || "").length); } catch (e) { console.log(n, "ERR", e.message.slice(0, 200)); }
}
K.remove(); console.log("after remove:", K.get());
