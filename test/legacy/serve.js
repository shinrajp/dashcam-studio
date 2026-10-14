// tiny static server with CORS + /list for the fake TeslaCam tree
const http=require('http'),fs=require('fs'),path=require('path');
const root=process.argv[2], port=+process.argv[3]||8765;
function walk(d,o=[]){for(const n of fs.readdirSync(d)){const p=path.join(d,n);if(fs.statSync(p).isDirectory())walk(p,o);else o.push(path.relative(root,p));}return o;}
http.createServer((q,r)=>{r.setHeader('Access-Control-Allow-Origin','*');const u=decodeURIComponent(q.url.split('?')[0]);
if(u==='/list'){r.setHeader('Content-Type','application/json');return r.end(JSON.stringify(walk(root)));}
const p=path.join(root,u);if(!p.startsWith(root)||!fs.existsSync(p)){r.statusCode=404;return r.end();}
r.setHeader('Content-Type',p.endsWith('.json')?'application/json':'video/mp4');fs.createReadStream(p).pipe(r);}).listen(port,()=>console.log('serving',root,port));
