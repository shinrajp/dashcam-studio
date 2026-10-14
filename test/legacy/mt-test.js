const puppeteer=require('puppeteer-core');const fs=require('fs');
const SS='/workspace/tesla-dashcam-demo/screenshots', OUT='/workspace/tdc-test/mtout';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const browser=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',headless:'new',protocolTimeout:600000,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required','--window-size=1440,900']});
 const page=await browser.newPage();
 const logs=[];page.on('console',m=>logs.push(m.type()+': '+m.text()));page.on('pageerror',e=>logs.push('PAGEERROR '+e.message));
 const cdp=await page.createCDPSession();await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:OUT});
 await page.setViewport({width:1440,height:900});
 await page.goto('file:///workspace/tesla-dashcam-demo/index.html');
 await page.evaluate(()=>{localStorage.clear();});await page.reload();
 await page.evaluate(()=>{TDC.setPref('units','mph');});
 await page.click('.switch'); // Advanced on (real click)
 await page.evaluate(async()=>{const list=await (await fetch('http://127.0.0.1:18766/list')).json();const out=[];for(const p of list){if(p.endsWith('keys.json'))continue;const b=await (await fetch('http://127.0.0.1:18766/'+p)).blob();out.push({file:new File([b],p.split('/').pop()),path:p});}await TDC.ui.ingest(out);});
 await page.evaluate(async()=>{await TDC.ui.activate(TDC.library.events.find(e=>e.id.includes('2026-10-07')));});
 await page.waitForFunction(()=>TDC.telemetry.status==='ready',{timeout:30000});
 const R=await page.evaluate(()=>{const r=document.getElementById('timeline').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height,dur:TDC.player.ev.duration,clip2:TDC.player.ev.clips[1].start};});
 console.log('timeline',JSON.stringify(R));
 const X=(t)=>R.x+t/R.dur*R.w, laneY=R.y+R.h-8-Math.round((R.h-16)*0.5)/2; // middle of section lane
 const upperY=R.y+12;
 const segs=()=>page.evaluate(()=>TDC.ui.sortedSegs().map(s=>[+s.start.toFixed(3),+s.end.toFixed(3),s.id===TDC.ui.selSeg?'sel':'']));
 const mdrag=async(x0,x1,y)=>{await page.mouse.move(x0,y);await page.mouse.down();for(let i=1;i<=8;i++){await page.mouse.move(x0+(x1-x0)*i/8,y);await sleep(16);}await page.mouse.up();await sleep(50);};
 const tdrag=async(x0,x1,y)=>{await page.touchscreen.touchStart(x0,y);for(let i=1;i<=8;i++){await page.touchscreen.touchMove(x0+(x1-x0)*i/8,y);await sleep(16);}await page.touchscreen.touchEnd();await sleep(50);};
 const res={};
 const vstate=()=>page.evaluate(()=>JSON.stringify({t:TDC.player.time,rs:[...document.querySelectorAll('#grid video')].slice(0,2).map(v=>[v.className,v.readyState,v.paused,+v.currentTime.toFixed(3),v.seeking])}));
 // S1 via button + mouse edge drags, then exact via keyboard I/O
 await page.evaluate(()=>TDC.player.seek(2.0)); await page.click('#btnAddSeg'); res.s1_added=await segs();
 await mdrag(X(res.s1_added[0][0])+1,X(1.0),laneY); await mdrag(X(res.s1_added[0][1])-1,X(3.0),laneY); res.s1_dragged=await segs();
 await page.evaluate(()=>TDC.player.seek(1.0)); await page.keyboard.press('i'); await page.evaluate(()=>TDC.player.seek(3.0)); await page.keyboard.press('o'); res.s1_exact=await segs();
 // S2 via 'A' key, move body with mouse, then end edge, then exact
 await page.evaluate(()=>TDC.player.seek(6.25)); await page.keyboard.press('a'); res.s2_added=await segs();
 const s2=res.s2_added.find(s=>s[2]==='sel');
 await mdrag(X((s2[0]+s2[1])/2),X((s2[0]+s2[1])/2+1.25),laneY); res.s2_moved=await segs();
 const s2m=res.s2_moved.find(s=>s[2]==='sel');
 await mdrag(X(s2m[1])-1,X(7.5),laneY); res.s2_end=await segs();
 await page.evaluate(()=>TDC.player.seek(5.0)); await page.click('#btnIn'); await page.evaluate(()=>TDC.player.seek(7.5)); await page.click('#btnOut'); res.s2_exact=await segs();
 // S3 via button, touch drags of both edges
 await page.evaluate(()=>TDC.player.seek(10.0)); await page.click('#btnAddSeg'); res.s3_added=await segs();
 const s3=res.s3_added.find(s=>s[2]==='sel');
 await tdrag(X(s3[0])+2,X(9.0),laneY); await tdrag(X(s3[1])-2,X(11.0),laneY); res.s3_touch=await segs();
 await page.evaluate(()=>TDC.player.seek(9.0)); await page.keyboard.press('i'); await page.evaluate(()=>TDC.player.seek(11.0)); await page.keyboard.press('o'); res.s3_exact=await segs();
 // playhead scrub in upper part over a section must NOT touch sections
 const before=JSON.stringify(await segs()); await mdrag(X(5.5),X(6.5),upperY); res.scrub_t=await page.evaluate(()=>TDC.player.time); res.scrub_untouched=JSON.stringify(await segs())===before;
 // tap on a section body selects it (touch)
 await page.touchscreen.tap(X(2.0),laneY); await sleep(50); res.tap_select=await segs(); res.tap_time=await page.evaluate(()=>TDC.player.time);
 // 4th section, delete with Delete key; another, delete with button
 await page.evaluate(()=>TDC.player.seek(4.0)); await page.click('#btnAddSeg'); res.s4_added=await segs(); await page.keyboard.press('Delete'); res.after_del_key=await segs();
 await page.evaluate(()=>TDC.player.seek(11.8)); await page.click('#btnAddSeg'); res.s5_added=await segs(); await page.click('#btnDelSeg'); res.after_del_btn=await segs();
 res.ranges=await page.evaluate(()=>TDC.ui.ranges()); res.info=await page.evaluate(()=>document.getElementById('segInfo').textContent);
 // screenshots: select S2, playhead inside S2
 await page.touchscreen.tap(X(6.2),laneY); await page.evaluate(()=>TDC.player.seek(6.6)); await sleep(1500);
 await sleep(2500); await page.mouse.move(X(6.6),upperY);await sleep(100);
 await page.screenshot({path:SS+'/17-multi-section-trim.png'});
 await page.screenshot({path:SS+'/17b-multi-section-timeline.png',clip:{x:0,y:900-62,width:1440,height:62}});
 // export dialog
 await page.click('#btnExport'); await sleep(600);

 res.dialog={range:await page.evaluate(()=>[...document.querySelectorAll('#segRange button')].map(b=>b.dataset.v+(b.classList.contains('on')?'*':'')+(b.disabled?'(disabled)':'')).join(' ')),hint:await page.evaluate(()=>document.getElementById('exportHint').textContent)};
 await page.screenshot({path:SS+'/17c-export-sections-joined.png'});
 await page.click('#btnExportCancel'); await page.setViewport({width:1024,height:700}); await sleep(800); await page.screenshot({path:SS+'/17e-multi-section-1024x700.png'}); await page.setViewport({width:1440,height:900}); await sleep(800); await page.click('#btnExport'); await sleep(300);
 // Play sections: from t=0, log times
 await page.click('#btnExportCancel'); await sleep(200);
 await page.click('#btnPlaySecs'); res.playSecsPressed=await page.evaluate(()=>document.getElementById('btnPlaySecs').getAttribute('aria-pressed'));
 await page.evaluate(()=>{TDC.player.seek(0);window.__tl=[];TDC.on('time',t=>window.__tl.push([+(performance.now()/1000).toFixed(3),+TDC.player.time.toFixed(3)]));});
 await page.click('#btnPlay');
 await page.waitForFunction(()=>!TDC.player.playing,{timeout:20000,polling:100});
 const tl=await page.evaluate(()=>window.__tl);
 const secs=res.ranges; let outside=tl.filter(([w,t])=>!secs.some(([a,b])=>t>=a-0.001&&t<=b+0.12));
 const visited=secs.map(([a,b])=>{const ins=tl.filter(([w,t])=>t>=a-0.001&&t<=b+0.12);return ins.length?[ins[0][1],ins[ins.length-1][1],+(ins[ins.length-1][0]-ins[0][0]).toFixed(2)]:null;});
 // order check: section index sequence non-decreasing
 const seq=tl.map(([w,t])=>secs.findIndex(([a,b])=>t>=a-0.001&&t<=b+0.12)).filter(i=>i>=0); let ordered=true; for(let i=1;i<seq.length;i++) if(seq[i]<seq[i-1]) ordered=false;
 res.playSections={samples:tl.length,outside:outside.slice(0,5),outsideCount:outside.length,visited,ordered,endTime:await page.evaluate(()=>TDC.player.time),wall:+(tl[tl.length-1][0]-tl[0][0]).toFixed(2)};
 console.log('after play-sections',await vstate()); await page.click('#btnStop'); console.log('after stop',await vstate()); await sleep(1000); console.log('after stop+1s',await vstate()); res.stopTime=await page.evaluate(()=>TDC.player.time);
 await page.evaluate(()=>TDC.player.seek(4.0)); await page.keyboard.press('Home'); res.homeTime=await page.evaluate(()=>TDC.player.time);
 console.log('after home',await vstate()); await sleep(1000); console.log('after home+1s',await vstate());
 fs.writeFileSync(OUT+'/ui-results.json',JSON.stringify(res,null,1));
 console.log(JSON.stringify(res,null,1));
 // ── EXPORT 1: WebCodecs path via the real dialog ──
 await page.evaluate(()=>{const C=TDC.compositor,o=C.drawFrame;window.__fl=[];C.drawFrame=function(ctx,geo,t,frames,show){const st=TDC.telemetry.at(t);const d=TDC.player.wallClock(t);window.__fl.push([+t.toFixed(4),d?TDC.fmtClock(d):null,st?+st.litL:null,st?+st.litR:null,st?st.m.ap:null,st?+st.m.speed.toFixed(2):null]);return o.apply(this,arguments);};window.__orig=o;});
 await page.click('#btnExport'); await sleep(400);
 const t0=Date.now(); await page.click('#btnExportGo');
 await page.waitForFunction(()=>!TDC.exporter.running&&window.__tdcLastExport,{timeout:180000,polling:200});
 const e1=await page.evaluate(()=>{const r=window.__tdcLastExport;return {name:r.name,size:r.blob.size,frames:r.frames,codec:r.codec,hw:r.hw,label:r.label,note:r.note,text:document.getElementById('exportText').textContent};});
 e1.secs=(Date.now()-t0)/1000; e1.frameLog=await page.evaluate(()=>window.__fl);
 fs.writeFileSync(OUT+'/export-webcodecs.json',JSON.stringify(e1));
 console.log('webcodecs',JSON.stringify({...e1,frameLog:e1.frameLog.length}));
 console.log('after webcodecs',await vstate()); await page.click('#btnExportCancel');
 if(process.env.NUDGE){await page.evaluate(()=>document.querySelectorAll('#grid video').forEach(v=>{if(v.seeking){v.currentTime=v.currentTime+0.001;}}));await sleep(1000);console.log('after nudge',await vstate());}
 // ── EXPORT 2: realtime MediaRecorder path (WebCodecs hidden) ──
 await page.evaluate(()=>{window.__fl=[];window.__VE=window.VideoEncoder;delete window.VideoEncoder;window.__tdcLastExport=null;});
 const t1=Date.now();
 const iv=setInterval(async()=>{try{console.log('rt-state',await page.evaluate(()=>JSON.stringify({t:TDC.player.time,playing:TDC.player.playing,running:TDC.exporter.running,fl:window.__fl.length,vis:document.visibilityState,slot:TDC.player.slotClip,active:TDC.player.active,rs:[...document.querySelectorAll('#grid video')].slice(0,4).map(v=>[v.className,v.readyState,v.paused,+v.currentTime.toFixed(3),v.seeking,v.ended,v.playbackRate,v._want])})));}catch(e){}},3000);
 const e2=await page.evaluate(async()=>{const res=await TDC.exporter.run({preset:'compat',ranges:TDC.ui.ranges(),onProgress:()=>{}});window.__rt=res;TDC.download(res.blob,'realtime-'+res.name);return {name:res.name,size:res.blob.size,type:res.type,note:res.note};});
 clearInterval(iv); e2.secs=(Date.now()-t1)/1000; e2.frameLog=await page.evaluate(()=>window.__fl);
 fs.writeFileSync(OUT+'/export-realtime.json',JSON.stringify(e2));
 console.log('realtime',JSON.stringify({...e2,frameLog:e2.frameLog.length}));
 await page.evaluate(()=>{window.VideoEncoder=window.__VE;});
 // ── clear all → whole event ──
 await page.click('#btnClearSegs'); res.afterClear={ranges:await page.evaluate(()=>TDC.ui.ranges()),pref:await page.evaluate(()=>TDC.prefs.export.range)};
 await page.click('#btnExport'); await sleep(300); res.afterClear.dialog=await page.evaluate(()=>[...document.querySelectorAll('#segRange button')].map(b=>b.dataset.v+(b.classList.contains('on')?'*':'')+(b.disabled?'(disabled)':'')).join(' '));
 console.log('afterClear',JSON.stringify(res.afterClear));
 await page.click('#btnExportCancel');
 // Advanced off with sections present → whole event, Stop → 0
 await page.evaluate(()=>{TDC.ui.addSeg(2,4);TDC.setPref('export.range','sections');});
 await page.click('.switch'); res.advOff={ranges:await page.evaluate(()=>TDC.ui.ranges())}; await page.evaluate(()=>TDC.player.seek(5)); await page.click('#btnStop'); res.advOff.stop=await page.evaluate(()=>TDC.player.time);
 res.advOff.barVisible=await page.evaluate(()=>getComputedStyle(document.getElementById('segBar')).display);
 // companion/auto path (full range, unchanged)
 const t2=Date.now(); res.auto=await page.evaluate(async()=>{const ev=TDC.library.events.find(e=>e.id.includes('2026-10-07'));const r=await TDC.auto.exportEvent(ev,{});TDC.download(r.blob,'auto-'+r.name);return {frames:r.frames,size:r.blob.size,name:r.name};}); res.auto.secs=(Date.now()-t2)/1000;
 console.log('advOff/auto',JSON.stringify({advOff:res.advOff,auto:res.auto}));
 await sleep(1500);
 console.log(logs.filter(l=>/error|PAGEERROR|warn/i.test(l)).slice(0,20).join('\n'));
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
