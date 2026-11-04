const fs=require('fs'),path=require('path');const ROOT=process.argv[2],OUT=process.argv[3],TAG=process.argv[4];
(async()=>{const pw=require(process.env.PW || 'playwright');
const b=await pw.chromium.launch({channel:'chrome',args:['--use-angle=metal','--enable-unsafe-swiftshader']});const p=await (await b.newContext({viewport:{width:1280,height:800}})).newPage();const errs=[];
p.on('pageerror',e=>errs.push(e.message));
await p.route('http://mock.test/**',async r=>{const u=new URL(r.request().url());let f=path.join(ROOT,decodeURIComponent(u.pathname));let body=fs.readFileSync(f);if(f.endsWith('index.html'))body='<!doctype html><html><head><meta charset="utf-8"></head><body>'+body+'</body></html>';r.fulfill({body,contentType:f.endsWith('.html')?'text/html':f.endsWith('.json')?'application/json':'image/jpeg'})});
await p.goto('http://mock.test/index.html');await p.waitForFunction(()=>document.getElementById('status').hidden,null,{timeout:60000});await p.click('#hide');
for(const [k,v,t] of [[0,'rear',0],[0,'rear',1],[12,'chase',0],[12,'top',1]]){await p.fill('#pos',String(k));await p.dispatchEvent('#pos','input');await p.click(`[data-v=${v}]`);
 if((await p.getAttribute('#tint','aria-pressed'))!==String(!!t))await p.click('#tint');await p.waitForTimeout(1500);await p.screenshot({path:`${OUT}/${TAG}-${k}-${v}${t?'-tint':''}.png`});}
console.log('errors:',errs.join(' | ')||'none');await b.close();})();
