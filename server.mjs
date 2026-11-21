import {createServer} from 'node:http';
import {timingSafeEqual,createHash} from 'node:crypto';
import {readFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {openStore,labs,statuses} from './store.mjs';
import {assets,faults} from './matching.mjs';

const demo = process.env.LABFIX_DEMO === '1';
const token = process.env.LABFIX_OPERATOR_TOKEN || '';
if (!demo && token.length < 24) throw new Error('Set LABFIX_OPERATOR_TOKEN to at least 24 characters, or enable the local demo.');
const base = new URL('./public/',import.meta.url);
const files = {'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/app.css':['app.css','text/css'],'/matching.mjs':['../matching.mjs','text/javascript']};
const dbPath = process.env.LABFIX_DB || (demo ? './data/demo.sqlite' : './data/labfix.sqlite');
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath),{recursive:true});
const store = openStore(dbPath);
if (demo) store.seed();
const headers = {
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Cache-Control':'no-store'
};
const send = (res,status,body) => {
  res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(body));
};
const digest = value => createHash('sha256').update(value).digest();
const expected = digest('Bearer '+token);
const authorized = req => demo || timingSafeEqual(digest(req.headers.authorization || ''),expected);
const assetValid = id => assets().some(a=>a.id===id);
const labValid = id => labs.some(lab=>lab.id===id);
const limits = new Map();
let lastCleanup = 0;
function allowed(req, type, maximum) {
  const now = Date.now();
  if (now-lastCleanup > 60_000) {
    for (const [key,record] of limits) if (record.until <= now) limits.delete(key);
    lastCleanup = now;
  }
  // Trust the direct socket address. The operator can enforce per-client limits at the edge.
  const key = type + ':' + req.socket.remoteAddress;
  const record = limits.get(key);
  if (!record || record.until <= now) {
    if (limits.size >= 10000) return false;
    limits.set(key,{count:1,until:now+60_000});
    return true;
  }
  return ++record.count <= maximum;
}
async function readBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return {status:415};
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({destroyOnReturn:false})) {
    bytes += chunk.length;
    if (bytes > 8192) {req.resume(); return {status:413};}
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? {data} : {status:400};
  } catch { return {status:400}; }
}
const server = createServer({requestTimeout:15000}, async (req,res) => {
  try {
    const url = new URL(req.url,'http://localhost');
    const {pathname} = url;
    const method = req.method;
    if (method==='GET' && Object.hasOwn(files,pathname)) {
      const [filename,type] = files[pathname];
      res.writeHead(200,{...headers,'Content-Type':type+'; charset=utf-8'});
      res.end(readFileSync(new URL(filename,base)));
      return;
    }
    if (method==='GET' && pathname==='/healthz') return send(res,200,{status:'ok'});
    if (method==='GET' && pathname==='/api/config') return send(res,200,{labs,assets:assets(),faults,demo});
    if (method==='GET' && pathname==='/api/map') {
      const lab = url.searchParams.get('lab');
      return labValid(lab) ? send(res,200,{status:store.mapStatus(lab)}) : send(res,400,{error:'Unknown lab.'});
    }
    if (method==='POST' && pathname==='/api/track') {
      if (!allowed(req,'tracking',40)) return send(res,429,{error:'Please wait before checking another receipt.'});
      const {data} = await readBody(req);
      const code = typeof data?.code==='string' && /^[a-f0-9]{24}$/.test(data.code) ? data.code : null;
      const receipt = code && store.track(code);
      return receipt ? send(res,200,receipt) : send(res,404,{error:'Tracking code not found.'});
    }
    if (pathname==='/api/reports' && method==='POST') {
      if (!allowed(req,'report',30)) return send(res,429,{error:'Please wait before sending another report.'});
      const {data,status} = await readBody(req);
      if (!data) return send(res,status,{error:'Send a valid JSON report of up to 8 KB.'});
      const {lab,asset,key} = data;
      const description = typeof data.description==='string' ? data.description.trim() : '';
      if (!labValid(lab) || (asset!=null && !assetValid(asset)) || description.length<8 || description.length>600 ||
        (key!=null && (typeof key!=='string' || !/^[a-zA-Z0-9-]{16,80}$/.test(key))))
        return send(res,400,{error:'Choose a lab and enter a report between 8 and 600 characters.'});
      const result = store.report({lab,asset,description,key});
      return send(res,201,{report:result.report,tracking:result.tracking,action:result.action});
    }
    if (pathname.startsWith('/api/operator/')) {
      if (!authorized(req)) return send(res,allowed(req,'auth',25) ? 401 : 429,{error:'Operator access required.'});
      if (method==='GET' && pathname==='/api/operator/incidents') {
        const lab = url.searchParams.get('lab');
        if (!labValid(lab)) return send(res,400,{error:'Unknown lab.'});
        return send(res,200,{incidents:store.list(lab),metrics:store.metrics(lab),analytics:store.analytics(lab)});
      }
      const route = pathname.match(/^\/api\/operator\/incidents\/(\d{1,12})(\/merge)?$/);
      if (route) {
        const id = Number(route[1]);
        if (method==='GET' && !route[2]) {
          const result = store.detail(id);
          return send(res,result ? 200 : 404,result || {error:'Incident not found.'});
        }
        if ((method==='PATCH' && !route[2]) || (method==='POST' && route[2])) {
          const {data,status} = await readBody(req);
          if (!data) return send(res,status,{error:'Invalid update.'});
          let result;
          if (route[2]) {
            if (!Number.isSafeInteger(data.target) || data.target<1) return send(res,400,{error:'Enter a valid destination incident ID.'});
            result = store.merge(id,data.target);
          } else {
            const {status:next,asset,fault,priority,assignee} = data;
            const note = typeof data.note==='string' ? data.note.trim() : '';
            if (!statuses.includes(next) || (asset!=null && !assetValid(asset)) ||
              (fault!=null && !Object.hasOwn(faults,fault)) || note.length>500 ||
              (priority!=null && !['normal','high','urgent'].includes(priority)) ||
              (assignee!=null && (typeof assignee!=='string'||assignee.length>60)))
              return send(res,400,{error:'Check the workstation, status, and repair note.'});
            result = store.update(id,{status:next,asset,fault,note,priority,assignee:assignee?.trim()});
          }
          return send(res,result ? (result.error ? 409 : 200) : 404,result || {error:'Incident not found.'});
        }
      }
    }
    return send(res,404,{error:'Route not found.'});
  } catch (error) {
    console.error(error.message);
    if (!res.headersSent) send(res,500,{error:'LabFix could not complete the request.'});
    else res.end();
  }
});
const host = demo ? '127.0.0.1' : (process.env.HOST || '127.0.0.1');
const portFlag = process.argv.indexOf('--port');
const port = portFlag >= 0 ? process.argv[portFlag+1] : process.env.PORT ?? 8080;
server.listen(Number(port),host,()=>console.log('LabFix ready http://'+host+':'+server.address().port));
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>server.close(()=>{store.close();process.exit(0);}));
