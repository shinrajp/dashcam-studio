const puppeteer=require('puppeteer-core');const fs=require('fs');
const OUT='/workspace/tesla-dashcam-demo/screenshots';
(async()=>{
 const browser=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',headless:'new',args:['--no-sandbox','--autoplay-policy=no-user-gesture-required','--window-size=1440,900']});
 const page=await browser.newPage();
 const logs=[];page.on('console',m=>logs.push(m.type()+': '+m.text()));page.on('pageerror',e=>logs.push('PAGEERROR '+e.message));
 const cdp=await page.createCDPSession();await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:'/workspace/tdc-test/out'});
 await page.setViewport({width:1440,height:900});
 await page.goto('file:///workspace/tesla-dashcam-demo/index.html');
 await page.evaluate(()=>localStorage.clear());await page.reload();
 await page.evaluate(async()=>{const list=await (await fetch('http://127.0.0.1:18765/list')).json();const out=[];for(const p of list){if(p.endsWith('keys.json'))continue;const b=await (await fetch('http://127.0.0.1:18765/'+p)).blob();out.push({file:new File([b],p.split('/').pop()),path:p});}await TDC.ui.ingest(out);});
 console.log('active after ingest:',await page.evaluate(()=>TDC.ui.current.id));
 await page.evaluate(async()=>{await TDC.ui.activate(TDC.library.events.find(e=>e.id.includes('2026-10-07')));});
 await page.waitForFunction(()=>TDC.telemetry.status==='ready',{timeout:30000});
 await page.evaluate(()=>TDC.player.seek(8.2));await new Promise(r=>setTimeout(r,2500));
 await page.screenshot({path:OUT+'/02-grid-hud-map-1440x900.png'});
 for(const [w,h] of [[1280,800],[1920,1080],[1024,700]]){await page.setViewport({width:w,height:h});await new Promise(r=>setTimeout(r,1200));await page.screenshot({path:`${OUT}/03-layout-${w}x${h}.png`});}
 await page.setViewport({width:1440,height:900});
 const caps=await page.evaluate(async()=>({compat:await TDC.exporter.supportedCodecs(1920,1080,30),native:await TDC.exporter.supportedCodecs(4344,1876,36),max:await TDC.exporter.supportedCodecs(8688,3752,36)}));console.log('encoders',JSON.stringify(caps));
 for(const preset of ['compat','original']){
  const t0=Date.now();
  const r=await page.evaluate(async(preset)=>{const res=await TDC.exporter.run({preset,codec:'h264',sizeId:'native',onProgress:()=>{}});TDC.download(res.blob,res.name);return {name:res.name,size:res.blob.size,W:res.W,H:res.H,codec:res.codec,hw:res.hw,frames:res.frames,note:res.note,label:res.label};},preset);
  console.log(preset,JSON.stringify(r),'secs',(Date.now()-t0)/1000);
 }
 // export-all style on the Sentry (no telemetry, 4 cams) event to check placeholders
 const r3=await page.evaluate(async()=>{const ev=TDC.library.events.find(e=>e.source==='SentryClips');const res=await TDC.auto.exportEvent(ev,{});TDC.download(res.blob,res.name);return res.name;});console.log('sentry',r3);
 await page.evaluate(()=>TDC.player.seek(2));await new Promise(r=>setTimeout(r,1500));
 await page.screenshot({path:OUT+'/04-sentry-no-telemetry-missing-cams.png'});
 await new Promise(r=>setTimeout(r,2000));
 console.log(logs.filter(l=>/error|PAGEERROR|warn/i.test(l)).slice(0,20).join('\n'));
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
