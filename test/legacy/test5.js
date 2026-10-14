const puppeteer=require('puppeteer-core');
(async()=>{const b=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',headless:'new',args:['--no-sandbox']});
const p=await b.newPage();await p.setViewport({width:1280,height:820});
await p.goto('file:///workspace/tdc-test/exports/index.html');await new Promise(r=>setTimeout(r,500));
await p.screenshot({path:'/workspace/tesla-dashcam-demo/screenshots/13-companion-library-static.png'});
await p.goto('file:///workspace/tdc-test/exports2/index.html');await new Promise(r=>setTimeout(r,300));
await p.screenshot({path:'/workspace/tesla-dashcam-demo/screenshots/14-companion-library-needs-signin.png'});
await b.close();})();
