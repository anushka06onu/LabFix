import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {matchReport} from '../matching.mjs';
import {openStore} from '../store.mjs';

function fixture(t,path=':memory:') {
  const store=openStore(path);
  t.after(()=>store.close());
  return store;
}
function issue(store,description,overrides={},time=Date.now()) {
  return store.report({lab:'innovation',description,...overrides},time);
}
test('multilingual workstation clues and ambiguity',()=>{
  assert.equal(matchReport('শেষ সারি সিট ৫ বন্ধ হয়ে যায়').asset,'PC-17');
  assert.equal(matchReport('পিসি ১৭ বারবার বন্ধ হয়ে যায়').fault,'power');
  assert.equal(matchReport('PC 17 or PC 16 restart').asset,null);
  assert.equal(matchReport('PC 3 monitor blank','PC-04').asset,null);
  assert.equal(matchReport('monitor blank').fault,'display');
});
test('duplicates link, repair requires a note, and recurrence retains history',t=>{
  const store=fixture(t);
  const first=issue(store,'PC 17 keeps restarting and shuts down');
  assert.equal(first.action,'created');
  const linked=issue(store,'পিসি ১৭ বারবার বন্ধ হয়ে যায়');
  assert.equal(linked.id,first.id);
  assert.equal(linked.action,'linked');
  assert.ok(store.update(first.id,{status:'resolved'}).error);
  store.update(first.id,{status:'working',note:'Diagnosis started'});
  store.update(first.id,{status:'resolved',note:'Replaced the cable'});
  const recurrence=issue(store,'last row seat 5 off hoy');
  assert.equal(recurrence.id,first.id);
  assert.equal(recurrence.action,'reopened');
  const result=store.detail(first.id);
  assert.equal(result.repeats,1);
  assert.equal(result.reports.length,3);
  assert.ok(result.events.some(event=>event.note==='Replaced the cable'));
});
test('different labs or faults stay distinct and old repairs start a new incident',t=>{
  const store=fixture(t);
  const date=Date.now()-40*86400_000;
  const first=issue(store,'PC 3 screen blank',{},date);
  store.update(first.id,{status:'resolved',note:'New cable'},date+60000);
  const again=issue(store,'PC 3 screen blank');
  assert.notEqual(again.id,first.id);
  assert.notEqual(issue(store,'PC 3 screen blank',{lab:'systems'}).id,again.id);
  assert.notEqual(issue(store,'PC 3 mouse cursor broken').id,again.id);
});
test('review merge preserves original reports and idempotent retry IDs',t=>{
  const store=fixture(t);
  const first=issue(store,'PC 3 screen blank');
  const report=issue(store,'screen blank near the wall',{key:'test-retry-key-00001'});
  assert.equal(report.action,'review');
  assert.equal(issue(store,'screen blank near the wall',{key:'test-retry-key-00001'}).report,report.report);
  assert.equal(store.merge(report.id,first.id).id,first.id);
  assert.equal(store.detail(first.id).reports.length,2);
  assert.equal(store.detail(report.id),null);
  assert.equal(issue(store,'screen blank near the wall',{key:'test-retry-key-00001'}).id,first.id);
  assert.ok(issue(store,'mouse broken').id>report.id);
});
test('incidents persist after a new database connection',t=>{
  const folder=mkdtempSync(join(tmpdir(),'labfix-test-'));
  const path=join(folder,'persistent.sqlite');
  try {
    const first=openStore(path);
    const {id}=issue(first,'PC 2 monitor blank');
    first.close();
    const second=openStore(path);
    assert.equal(second.detail(id).asset,'PC-02');
    second.close();
  } finally {rmSync(folder,{recursive:true,force:true});}
});
test('production HTTP flow, input validation, and operator access',{timeout:15000},async t=>{
  const token='a-test-operator-token-long-enough';
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('../',import.meta.url),
    env:{...process.env,PORT:'0',HOST:'127.0.0.1',LABFIX_DB:':memory:',LABFIX_DEMO:'0',LABFIX_OPERATOR_TOKEN:token}});
  t.after(()=>child.kill());
  const [data]=await once(child.stdout,'data');
  const url=String(data).match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const auth={Authorization:'Bearer '+token};
  const operator='/api/operator/incidents';
  const headers={'Content-Type':'application/json'};
  const post=(path,body,extra={},method='POST')=>fetch(url+path,{method,headers:{...headers,...extra},body:JSON.stringify(body)});
  assert.equal((await fetch(url+'/healthz')).status,200);
  assert.match(await (await fetch(url)).text(),/New fault report/);
  assert.equal((await fetch(url+operator+'?lab=innovation')).status,401);
  assert.equal((await post('/api/reports',{lab:'other',description:'PC 3 monitor blank'})).status,400);
  const response=await post('/api/reports',{lab:'innovation',description:'PC 3 monitor blank'});
  assert.equal(response.status,201);
  const receipt=await response.json();
  assert.equal(receipt.action,'created');
  assert.match(receipt.tracking,/^[a-f0-9]{24}$/);
  const track=code=>post('/api/track',{code});
  assert.equal((await track('0'.repeat(24))).status,404);
  const tracking=await (await track(receipt.tracking)).json();
  assert.equal(tracking.status,'open');
  assert.equal(Object.hasOwn(tracking,'description'),false);
  assert.equal(Object.hasOwn(receipt,'description'),false);
  const result=await (await fetch(url+operator+'?lab=innovation',{headers:auth})).json();
  const id=result.incidents[0].id;
  assert.equal(result.metrics.active,1);
  assert.deepEqual(result.analytics.daily.map(day=>day.total),[1]);
  assert.equal((await (await fetch(url+'/api/map?lab=innovation')).json()).status[0].asset,'PC-03');
  assert.equal((await post(operator+'/'+id,{status:'working',priority:'invalid'},auth,'PATCH')).status,400);
  assert.equal((await post(operator+'/'+id,{status:'working',priority:'urgent',assignee:'Hardware'},auth,'PATCH')).status,200);
  assert.equal((await (await track(receipt.tracking)).json()).status,'working');
  assert.equal((await post(operator+'/'+id,{status:'resolved'},auth,'PATCH')).status,409);
  assert.equal((await post(operator+'/'+id,{status:'resolved',note:'Cable replaced'},auth,'PATCH')).status,200);
  const recurrence=await post('/api/reports',{lab:'innovation',description:'PC 3 monitor blank again'});
  assert.equal((await recurrence.json()).action,'reopened');
  const detail=await (await fetch(url+operator+'/'+id,{headers:auth})).json();
  assert.equal(detail.reports.length,2);
  assert.equal(detail.repeats,1);
  assert.equal(detail.assignee,'Hardware');
  assert.equal(detail.priority,'urgent');
  const pending=await (await post('/api/reports',{lab:'innovation',description:'monitor blank by the window'})).json();
  const list=await (await fetch(url+operator+'?lab=innovation',{headers:auth})).json();
  const review=list.incidents.find(item=>item.status==='review');
  assert.equal((await post(operator+'/'+review.id+'/merge',{target:id},auth)).status,200);
  const merged=await (await track(pending.tracking)).json();
  assert.equal(merged.report,pending.report);
  assert.equal(merged.asset,'PC-03');
  assert.equal(merged.status,'open');
});
test('the demo seed includes a genuine recurrence',t=>{
  const store=fixture(t);
  store.seed();
  assert.equal(store.metrics('innovation').recurrences,1);
  assert.equal(store.list('innovation').find(item=>item.asset==='PC-17').report_count,3);
});
