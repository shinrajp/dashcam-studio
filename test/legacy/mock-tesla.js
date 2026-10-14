// Mock dashcam.tesla.com: serves a page that "has" the userscript installed and a fake key endpoint. Never contacts Tesla.
const https=require('https'),fs=require('fs');
const keys=require('/workspace/tdc-test/fake/synthetic-keys.json');
const connector=fs.readFileSync('/workspace/tesla-dashcam-demo/connector/Tesla-Grid-Player-Connector.user.js','utf8');
const TOKEN='eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLXRlc3Q';
const log=[];
https.createServer({key:fs.readFileSync('key.pem'),cert:fs.readFileSync('cert.pem')},(q,r)=>{
 let body='';q.on('data',d=>body+=d);q.on('end',()=>{
  log.push(q.method+' '+q.url);fs.writeFileSync('mock-tesla.log',log.join('\n'));
  if(q.url.startsWith('/api/1/decrypt/batch')&&q.method==='POST'){
    if(q.headers.authorization!=='Bearer '+TOKEN){r.statusCode=401;return r.end('{"error":"unauthorized"}');}
    const items=JSON.parse(body).items||[];
    r.setHeader('Content-Type','application/json');
    return r.end(JSON.stringify({results:items.map(it=>keys[it.wrapped_key]?{id:it.id,key:keys[it.wrapped_key]}:{id:it.id,error:'unknown key'})}));
  }
  r.setHeader('Content-Type','text/html');
  r.end(`<!doctype html><title>Mock Tesla Dashcam</title><h1>Mock dashcam.tesla.com (signed in)</h1><script>sessionStorage.setItem('access_token','${TOKEN}');</script><script>${connector}</script>`);
 });}).listen(18443,()=>console.log('mock tesla on 18443'));
