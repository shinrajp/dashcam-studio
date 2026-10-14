const puppeteer=require('puppeteer-core');const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const browser=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',headless:'new',protocolTimeout:600000,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
 const page=await browser.newPage();page.on('console',m=>{if(m.type()!=='log')console.log('PAGE',m.type(),m.text())});
 await page.goto('file:///workspace/tesla-dashcam-demo/index.html');await page.evaluate(()=>{localStorage.clear();});await page.reload();await page.click('.switch');
 await page.evaluate(async()=>{const list=await (await fetch('http://127.0.0.1:18766/list')).json();const out=[];for(const p of list){const b=await (await fetch('http://127.0.0.1:18766/'+p)).blob();out.push({file:new File([b],p.split('/').pop()),path:p});}await TDC.ui.ingest(out);});
 await page.evaluate(async()=>{await TDC.ui.activate(TDC.library.events.find(e=>e.id.includes('2026-10-07')));});
 await page.waitForFunction(()=>TDC.telemetry.status==='ready',{timeout:30000});
 for(const mode of ['recover','fail']){
 const r=await page.evaluate(async(mode)=>{TDC.ui.clearSegs();TDC.ui.addSeg(1,3);TDC.ui.addSeg(5,7.5);delete window.VideoEncoder;
   const P=HTMLMediaElement.prototype, op=P.play; let armed=false;
   const iv=setInterval(()=>{if(TDC.player.playing&&!armed){armed=true;P.play=function(){return Promise.resolve();};document.querySelectorAll('#grid video').forEach(v=>HTMLMediaElement.prototype.pause.call(v));if(mode==='recover')setTimeout(()=>{P.play=op;},2500);}},50);
   const t0=performance.now();
   try{const res=await TDC.exporter.run({preset:'compat',ranges:TDC.ui.ranges(),onProgress:()=>{}});return {ok:true,size:res.blob.size,secs:(performance.now()-t0)/1000};}
   catch(e){return {ok:false,err:e.message,secs:(performance.now()-t0)/1000};}
   finally{clearInterval(iv);P.play=op;}
 },mode);
 console.log(mode,JSON.stringify(r));}
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
