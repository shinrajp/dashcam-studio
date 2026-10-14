const puppeteer = require("puppeteer-core");
(async () => {
  const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage(); const errs=[]; p.on("pageerror", e=>errs.push(e.message));
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await p.goto(process.argv[2] || "http://127.0.0.1:8770/index.html");
  const r = await p.evaluate(async () => {
    const T = window.TDC, K = T.keyImport, lib = T.library, out = {};
    out.parse = [K.parse('{"results":[]}').kind, K.parse("Bearer eyJabc.def.ghi1234567890xyz").kind, K.parse("hello world").kind];
    const cams=["front","back","left_repeater","right_repeater","left_pillar","right_pillar"]; let n=0;
    for (let s=0;s<8;s++) for (const c of cams) { n++; lib.items.set("f"+n,{key:"f"+n,path:`SentryClips/z/2026-10-02_10-${String(s).padStart(2,"0")}-00-${c}.mp4`,name:"f",kind:"encrypted",header:{wrappedHex:"h"+n,id:"id"+n}}); }
    const sizes=[]; const mock = async (u,o) => { const it = JSON.parse(o.body).items; sizes.push(it.length); return new Response(JSON.stringify({results: it.map(i=>({id:i.id, error:"test"}))})); };
    const run = await K.fetchWithToken("tok", mock); out.sizes = sizes; out.results = run.results.length;
    const real = await K.fetchWithToken("eyJfake.token.value"); out.realErrors = real.errors.map(e=>e.error.slice(0,60));
    out.uiVisible = { inApp: !!document.getElementById("inAppKeys"), manualOpen: document.querySelector("details.manual").open, helper: !!document.getElementById("btnCopyHelper") };
    return out; });
  console.log(JSON.stringify(r,null,1), "ERRORS:", errs); await b.close();
})();
