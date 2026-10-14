// Runs the generated console helper in a simulated dashcam.tesla.com page with a mocked endpoint.
const puppeteer = require("puppeteer-core");
(async () => {
  const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage(); await p.goto(process.argv[2] || "http://127.0.0.1:8770/index.html");
  const src = await p.evaluate(() => { const lib = window.TDC.library; const cams=["front","back","left_repeater","right_repeater"]; let n=0;
    for (let s=0;s<20;s++) for (const c of cams) { n++; lib.items.set("f"+n,{key:"f"+n,path:`SavedClips/y/2026-10-02_10-${String(s).padStart(2,"0")}-00-${c}.mp4`,name:"f",kind:"encrypted",header:{wrappedHex:"h"+n,id:"id"+n,vin:"V",key_id:1,timestamp:1,wrapped_key:"w",public_key:"p"}}); }
    return window.TDC.auth.helperSource(); });
  const res = await p.evaluate(async (src) => {
    const calls = []; let posted = null;
    localStorage.setItem("auth_token", "eyJhbGciOi.eyJzdWIiOi.sigsigsig");
    window.fetch = async (u, o) => { const items = JSON.parse(o.body).items; calls.push(items.length); if (calls.length === 2) return new Response("too many", { status: 413 }); return new Response(JSON.stringify({ results: items.map((i) => ({ id: i.id, key: "AAAAAAAAAAAAAAAAAAAAAA==" })) })); };
    window.copy = () => {};
    const out = await eval(src);
    return { calls, results: JSON.parse(out).results.length };
  }, src);
  console.log(JSON.stringify(res)); await b.close();
})();
