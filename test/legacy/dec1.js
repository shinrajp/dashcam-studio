const C=require('/workspace/tesla-dashcam-demo/js/crypto.js'),fs=require('fs');
const keys=require('./fake/synthetic-keys.json');
(async()=>{const buf=fs.readFileSync(process.argv[2]);
const cls=C.classify(new Uint8Array(buf.subarray(0,8192)),buf.length);
const key=C.unb64(keys[cls.header.wrapped_key]);
const f=await C.decryptFile(new Blob([buf]),cls.header.plaintext_size,key);
fs.writeFileSync(process.argv[3],Buffer.from(await f.arrayBuffer()));})();
