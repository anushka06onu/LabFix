import assert from 'node:assert/strict';

const base = process.argv[2];
const token = process.env.LABFIX_OPERATOR_TOKEN;
const requireModel = process.argv.includes('--require-model');
if (!base || !token) throw new Error('Pass a disposable production-mode LabFix URL and set LABFIX_OPERATOR_TOKEN.');

async function request(path,{method='GET',body,operator=false,status=200}={}) {
  const headers={};
  if (operator) headers.Authorization='Bearer '+token;
  if (body) headers['Content-Type']='application/json';
  const response=await fetch(new URL(path,base),{method,headers,body:body?JSON.stringify(body):undefined,
    signal:AbortSignal.timeout(75_000)});
  const data=await response.json();
  assert.equal(response.status,status,method+' '+path+' returned '+JSON.stringify(data));
  return data;
}
const list='/api/operator/incidents';
const lab='innovation';
await request('/healthz');
assert.equal((await request('/api/config')).demo,false,'Smoke test requires production mode');
await request(list+'?lab='+lab,{status:401});
const connection=await request('/api/operator/copilot/status',{operator:true});
if (requireModel) assert.equal(connection.status,'connected','The configured model must be listed');

const runbook=await request('/api/operator/knowledge?lab='+lab,{
  method:'POST',operator:true,status:201,
  body:{fault:'display',title:'DisplayDock trace procedure',keywords:'displaydock',
    summary:'DisplayDock is the lab term for a recurring loss of display signal.',
    checks:['Record which indicator appears on the monitor.','Confirm the selected input before replacing equipment.']},
});
const elsewhere=await request('/api/operator/knowledge?q=displaydock&lab=systems',{operator:true});
assert.equal(elsewhere.entries.some(entry=>entry.id===runbook.id),false);

const description='PC 4 monitor DisplayDock trace procedure needed.';
const receipt=await request('/api/reports',{method:'POST',body:{lab,description},status:201});
assert.equal(receipt.action,'created');
const queue=await request(list+'?lab='+lab,{operator:true});
const incident=queue.incidents.find(item=>item.asset==='PC-04');
assert.equal(incident.fault,'display');
const triage=list+'/'+incident.id+'/triage';
const draft=await request(triage,{method:'POST',body:{focus:'triage'},operator:true,status:201});
assert.ok(draft.sources.some(source=>source.id===runbook.id),'The copilot must retrieve the published runbook');
assert.ok(draft.checks.every(check=>draft.sources.find(source=>source.id===check.source)?.checks.some(item=>item.id===check.id)));
if (requireModel) assert.equal(draft.mode,'llm',draft.reason);
const handoff=await request(triage+'/'+draft.id,{method:'PATCH',operator:true,
  body:{note:'Smoke test reviewed the cited checks.',handoff:{assignee:'Hardware',priority:'high'}}});
assert.equal(handoff.handoff.assignee,'Hardware');
assert.equal((await request('/api/track',{method:'POST',body:{code:receipt.tracking}})).status,'working');
const details=await request(list+'/'+incident.id,{operator:true});
assert.ok(details.events.some(entry=>entry.type==='copilot_handoff'));
assert.ok(details.first_response!=null);
await request(list+'/'+incident.id,{method:'PATCH',operator:true,body:{status:'resolved',note:'Smoke test repair confirmed.'}});
const repeat=await request('/api/reports',{method:'POST',body:{lab,description},status:201});
assert.equal(repeat.action,'reopened');
assert.equal((await request('/api/track',{method:'POST',body:{code:receipt.tracking}})).status,'open');
console.log('Production smoke passed: access, lab evidence, '+draft.mode+' triage, handoff, receipt, and recurrence.');
