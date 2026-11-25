import {createServer} from 'node:http';
import {timingSafeEqual,createHash} from 'node:crypto';
import {readFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {openStore,labs,statuses,responseHours} from './store.mjs';
import {assets,faults} from './matching.mjs';
import {createCopilot,focusLabels,modelFromEnv} from './copilot.mjs';
import {labRunbook,libraryVersion,openKnowledge} from './knowledge.mjs';

const demo = process.env.LABFIX_DEMO === '1';
const token = process.env.LABFIX_OPERATOR_TOKEN || '';
if (!demo && token.length < 24) throw new Error('Set LABFIX_OPERATOR_TOKEN to at least 24 characters, or enable the local demo.');
const base = new URL('./public/',import.meta.url);
const files = {'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/app.css':['app.css','text/css'],
  '/agent-ui.js':['agent-ui.js','text/javascript'],'/matching.mjs':['../matching.mjs','text/javascript'],
  '/lab-hero.jpg':['lab-hero.jpg','image/jpeg']};
const dbPath = process.env.LABFIX_DB || (demo ? './data/demo.sqlite' : './data/labfix.sqlite');
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath),{recursive:true});
const store = openStore(dbPath);
if (demo) store.seed();
const evidenceIndex = openKnowledge(store.publishedRunbooks());
const inference = modelFromEnv();
const draftTriage = createCopilot(evidenceIndex,inference);
let copilotBusy = false;
let modelProbe;
let lastModelStatus;
async function modelStatus() {
  if (lastModelStatus && Date.now()-lastModelStatus.checkedAt<15_000) return lastModelStatus;
  if (!modelProbe) {
    modelProbe=(inference ? inference.check() : Promise.resolve('evidence'))
      .then(status=>lastModelStatus={status,model:inference?.id??null,checkedAt:Date.now()})
      .finally(()=>{modelProbe=null;});
  }
  return modelProbe;
}
const headers = {
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
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
      res.writeHead(200,{...headers,'Content-Type':type.startsWith('image/') ? type : type+'; charset=utf-8'});
      res.end(readFileSync(new URL(filename,base)));
      return;
    }
    if (method==='GET' && pathname==='/healthz') {
      const ready=store.healthy();
      return send(res,ready?200:503,{status:ready?'ok':'unavailable'});
    }
    if (method==='GET' && pathname==='/api/config') return send(res,200,{labs,assets:assets(),faults,responseHours,demo,
      copilot:{model:inference?.id || null,focus:focusLabels}});
    if (method==='GET' && pathname==='/api/evaluation') {
      const metrics = file => JSON.parse(readFileSync(new URL('./eval/'+file,import.meta.url),'utf8')).metrics;
      return send(res,200,{original:metrics('results.json'),challenge:metrics('challenge-results.json')});
    }
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
      if (method==='GET' && pathname==='/api/operator/copilot/status') return send(res,200,await modelStatus());
      const runbookRoute=pathname.match(/^\/api\/operator\/knowledge(?:\/LAB-(\d{1,12}))?$/);
      if (runbookRoute) {
        const lab=url.searchParams.get('lab');
        if (lab && !labValid(lab)) return send(res,400,{error:'Unknown lab.'});
        if (method==='GET' && !runbookRoute[1]) {
          const query=url.searchParams.get('q')?.trim().slice(0,160);
          const fault=url.searchParams.get('fault');
          if (fault && !Object.hasOwn(faults,fault)) return send(res,400,{error:'Unknown fault category.'});
          const entries=query ? evidenceIndex.search(query,fault || null,{lab,fallback:false,limit:30}) : evidenceIndex.list(lab,fault);
          const archived=lab ? store.archivedRunbooks(lab).map(labRunbook) : [];
          return send(res,200,{entries,archived,version:libraryVersion});
        }
        if (method==='POST' && !runbookRoute[1]) {
          if (!labValid(lab)) return send(res,400,{error:'Select the lab for this runbook.'});
          const {data,status}=await readBody(req);
          if (!data) return send(res,status,{error:'Invalid runbook.'});
          const fields=['fault','title','keywords','summary'];
          const values=Object.fromEntries(fields.map(key=>[key,typeof data[key]==='string' ? data[key].trim() : '']));
          const checks=Array.isArray(data.checks) ? data.checks.map(check=>typeof check==='string' ? check.trim() : '') : [];
          if (!Object.hasOwn(faults,values.fault) || values.title.length<5 || values.title.length>100 ||
            values.summary.length<12 || values.summary.length>500 || values.keywords.length>180 ||
            checks.length<2 || checks.length>5 || checks.some(check=>check.length<8 || check.length>200) ||
            new Set(checks).size!==checks.length) return send(res,400,{error:'Enter a fault category, title, summary, and 2–5 distinct diagnostic checks.'});
          return send(res,201,evidenceIndex.register(store.addRunbook(lab,{...values,checks})));
        }
        if (method==='PATCH' && runbookRoute[1]) {
          if (!labValid(lab)) return send(res,400,{error:'Select the lab for this runbook.'});
          const {data,status}=await readBody(req);
          if (!data) return send(res,status,{error:'Invalid runbook update.'});
          if (typeof data.archived!=='boolean') return send(res,400,{error:'Choose whether the runbook is archived.'});
          const row=store.setRunbookArchive(lab,Number(runbookRoute[1]),data.archived);
          return row ? send(res,200,evidenceIndex.register(row)) : send(res,404,{error:'Runbook not found.'});
        }
      }
      const triage = pathname.match(/^\/api\/operator\/incidents\/(\d{1,12})\/triage(?:\/(\d{1,12}))?$/);
      if (triage) {
        const id = Number(triage[1]);
        if (method==='GET' && !triage[2]) {
          const drafts = store.listDrafts(id);
          return send(res,drafts ? 200 : 404,drafts ? {drafts} : {error:'Incident not found.'});
        }
        if (method==='PATCH' && triage[2]) {
          const {data,status} = await readBody(req);
          if (!data) return send(res,status,{error:'Invalid review.'});
          const note = typeof data.note==='string' ? data.note.trim() : '';
          if (!note || note.length>500) return send(res,400,{error:'Enter a review note of up to 500 characters.'});
          let handoff=null;
          if (data.handoff!=null) {
            const assignee=typeof data.handoff.assignee==='string' ? data.handoff.assignee.trim() : '';
            const priority=data.handoff.priority;
            if (!assignee || assignee.length>60 || typeof priority!=='string' || !Object.hasOwn(responseHours,priority))
              return send(res,400,{error:'Choose an assignee and priority for the handoff.'});
            handoff={assignee,priority};
          }
          const draft = store.reviewDraft(id,Number(triage[2]),note,handoff);
          return send(res,draft ? (draft.error?409:200) : 404,draft || {error:'Triage draft not found.'});
        }
        if (method==='POST' && !triage[2]) {
          if (!allowed(req,'copilot',10)) return send(res,429,{error:'Please wait before generating another draft.'});
          const {data,status} = await readBody(req);
          if (!data) return send(res,status,{error:'Invalid triage request.'});
          const {focus} = data;
          if (typeof focus!=='string' || !Object.hasOwn(focusLabels,focus))
            return send(res,400,{error:'Choose a triage focus.'});
          const ticket = store.copilotContext(id);
          if (!ticket) return send(res,404,{error:'Incident not found.'});
          if (copilotBusy) return send(res,429,{error:'A triage draft is already running. Try again shortly.'});
          const disconnected = new AbortController();
          res.once('close',()=>disconnected.abort());
          copilotBusy=true;
          try {
            const result=await draftTriage(ticket,focus,AbortSignal.any([AbortSignal.timeout(65_000),disconnected.signal]));
            if (res.destroyed) return;
            const draft=store.saveDraft(ticket,result);
            return send(res,draft ? (draft.error?409:201) : 404,draft || {error:'Incident not found.'});
          } finally {copilotBusy=false;}
        }
      }
      if (method==='GET' && pathname==='/api/operator/incidents') {
        const lab = url.searchParams.get('lab');
        if (!labValid(lab)) return send(res,400,{error:'Unknown lab.'});
        return send(res,200,{incidents:store.list(lab),metrics:store.metrics(lab),analytics:store.analytics(lab),
          workstations:store.inventory(lab)});
      }
      const workstation = pathname.match(/^\/api\/operator\/workstations\/(PC-\d{2})$/);
      if (workstation && ['GET','PATCH'].includes(method)) {
        const lab = url.searchParams.get('lab');
        const asset = workstation[1];
        if (!labValid(lab) || !assetValid(asset)) return send(res,400,{error:'Choose a valid lab and workstation.'});
        if (method==='GET') return send(res,200,{history:store.workstationHistory(lab,asset)});
        const {data,status} = await readBody(req);
        if (!data) return send(res,status,{error:'Invalid availability update.'});
        const note = typeof data.note==='string' ? data.note.trim() : '';
        if (typeof data.offline!=='boolean' || !note || note.length>500)
          return send(res,400,{error:'Add an availability note of up to 500 characters.'});
        const result = store.setAvailability(lab,asset,data.offline,note);
        return send(res,result.error ? 409 : 200,result);
      }
      const route = pathname.match(/^\/api\/operator\/incidents\/(\d{1,12})(\/merge)?$/);
      if (route) {
        const id = Number(route[1]);
        if (method==='GET' && !route[2]) {
          const result = store.detail(id);
          if (!result) return send(res,404,{error:'Incident not found.'});
          const checklist=evidenceIndex.list(result.lab,result.fault)[0]?.checks??[];
          return send(res,200,{...result,checklist});
        }
        if ((method==='PATCH' && !route[2]) || (method==='POST' && route[2])) {
          const {data,status} = await readBody(req);
          if (!data) return send(res,status,{error:'Invalid update.'});
          if (data.revision!=null && (!Number.isSafeInteger(data.revision) || data.revision<0))
            return send(res,400,{error:'Invalid incident revision.'});
          let result;
          if (route[2]) {
            if (!Number.isSafeInteger(data.target) || data.target<1) return send(res,400,{error:'Enter a valid destination incident ID.'});
            result = store.merge(id,data.target,Date.now(),data.revision);
          } else {
            const {status:next,asset,fault,priority,assignee} = data;
            const note = typeof data.note==='string' ? data.note.trim() : '';
            if (!statuses.includes(next) || (asset!=null && !assetValid(asset)) ||
              (fault!=null && !Object.hasOwn(faults,fault)) || note.length>500 ||
              (priority!=null && (typeof priority!=='string' || !Object.hasOwn(responseHours,priority))) ||
              (assignee!=null && (typeof assignee!=='string'||assignee.length>60)))
              return send(res,400,{error:'Check the workstation, status, and repair note.'});
            result = store.update(id,{status:next,asset,fault,note,priority,assignee:assignee?.trim(),revision:data.revision});
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
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>server.close(()=>{
  evidenceIndex.close();
  store.close();
  process.exit(0);
}));
