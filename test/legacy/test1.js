const puppeteer=require('puppeteer-core');const fs=require('fs');
const OUT='/workspace/tesla-dashcam-demo/screenshots';
(async()=>{
 const browser=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',headless:'new',args:['--no-sandbox','--autoplay-policy=no-user-gesture-required','--window-size=1440,900','--enable-unsafe-swiftshader','--use-angle=swiftshader']});
 const page=await browser.newPage();await page.setViewport({width:1440,height:900});
 const logs=[];page.on('console',m=>logs.push(m.type()+': '+m.text()));page.on('pageerror',e=>logs.push('PAGEERROR '+e.message));
 await page.goto('file:///workspace/tesla-dashcam-demo/index.html');
 await page.evaluate(()=>localStorage.clear());await page.reload();
 await new Promise(r=>setTimeout(r,500));
 await page.screenshot({path:OUT+'/01-empty-state.png'});
 await page.evaluate(async()=>{const list=await (await fetch('http://127.0.0.1:18765/list')).json();const out=[];for(const p of list){if(p.endsWith('keys.json'))continue;const b=await (await fetch('http://127.0.0.1:18765/'+p)).blob();out.push({file:new File([b],p.split('/').pop()),path:p});}await TDC.ui.ingest(out);});
 const info=await page.evaluate(()=>TDC.library.events.map(e=>({id:e.id,src:e.source,trig:e.trigger.label,clips:e.clips.length,cams:e.cams.length,locked:e.locked,city:e.location.city})));
 console.log(JSON.stringify(info,null,1));
 // pick the SavedClips HW4 telemetry event
 await page.evaluate(async()=>{const ev=TDC.library.events.find(e=>e.id.includes('2026-10-07'));await TDC.ui.activate(ev);});
 await page.waitForFunction(()=>TDC.telemetry.status==='ready',{timeout:30000});
 const st=await page.evaluate(()=>({dur:TDC.player.ev.duration,tile:TDC.player.ev.tile,fps:TDC.player.ev.fps,route:TDC.telemetry.route().length,status:TDC.telemetry.status}));console.log(st);
 await page.evaluate(()=>TDC.player.seek(7.4));await new Promise(r=>setTimeout(r,1500));
 await page.screenshot({path:OUT+'/02-grid-hud-map-1440.png'});
 // sync test: play 2.5s across the clip boundary
 await page.evaluate(()=>{TDC.player.seek(4.5);TDC.player.play();});await new Promise(r=>setTimeout(r,2500));
 const sync=await page.evaluate(()=>{const P=TDC.player;const ts=TDC.GRID.map(c=>{const v=P.tiles[c].vids[P.active];return v._url?v.currentTime:null}).filter(x=>x!=null);return {t:P.time,clip:P.clipIndexAt(P.time),times:ts,drift:Math.max(...ts)-Math.min(...ts),playing:P.playing};});console.log('sync',sync);
 await page.evaluate(()=>TDC.player.pause());
 console.log(logs.filter(l=>!l.startsWith('log')).slice(0,30).join('\n'));
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
