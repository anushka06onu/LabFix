import {createCopilot,modelFromEnv} from '../copilot.mjs';
import {knowledge,openKnowledge} from '../knowledge.mjs';

const cases = [
  ['repair reopens','power','recurrence','Switches off again after a loose power cable was replaced. Same shutdown as before.','KB-P02'],
  ['power or screen','power','triage','PC shuts down and the fan stops. The monitor goes dark when it restarts.','KB-P01'],
  ['flickering display','display','triage','The monitor flickers with flashing lines during lectures.','KB-D02'],
  ['no signal','display','triage','স্ক্রিনে সিগন্যাল নেই, মনিটর কালো।','KB-D01'],
  ['single seat offline','network','triage','PC is offline, the browser reports a connection error and Ethernet disconnects.','KB-N01'],
  ['shared outage','network','escalation','Multiple computers in the whole lab went offline at once; shared network outage.','KB-N02'],
  ['sticky key','input','triage','The keyboard repeats specific sticky keys, especially the Shift modifier.','KB-I02'],
  ['app freeze','software','triage','অ্যাপ হ্যাং হয়ে ফাইল খোলার সময় আটকে থাকে। Other apps respond.','KB-S02'],
  ['heat under load','thermal','escalation','Hot PC shuts down under sustained workload and heavy use.','KB-T02'],
  ['unconfirmed seat','other','triage','Something near the window does not work.','KB-X01'],
];
const inference=process.argv.includes('--live') ? modelFromEnv() : null;
if (process.argv.includes('--live') && !inference) {
  console.error('Set LABFIX_MODEL and start a local model endpoint for live evaluation.');
  process.exit(1);
}
const index=openKnowledge();
try {
  const run=createCopilot(index,inference);
  const rows=[];
  for (const [name,fault,focus,description,expected] of cases) {
    const id=name==='unconfirmed seat'?null:'PC-17';
    const repairs=focus==='recurrence'?[{id:7,incident:1,note:'Replaced a loose power cable and verified a clean boot.',created:1}]:[];
    const result=await run({fault,asset:id,repeats:repairs.length,repairs,reports:[{description}]},focus,AbortSignal.timeout(65_000));
    const found=result.trace[0].ids;
    const baseline=knowledge.find(item=>item.fault===fault)?.id;
    const valid=result.checks.every(check=>result.sources.find(source=>source.id===check.source)?.checks.some(item=>item.id===check.id));
    rows.push({name,expected,categoryOnly:baseline===expected,top1:found[0]===expected,top2:found.includes(expected),
      cited:result.citations.includes(expected),mode:result.mode,validChecks:valid,ms:result.durationMs});
  }
  console.table(rows);
  const totals=Object.fromEntries(['categoryOnly','top1','top2','cited','validChecks'].map(key=>[key,rows.filter(row=>row[key]).length]));
  console.log(JSON.stringify({authoredCases:cases.length,model:inference?.id??null,modelDrafts:rows.filter(row=>row.mode==='llm').length,...totals},null,2));
  if (!rows.every(row=>row.validChecks) || (inference && !rows.some(row=>row.mode==='llm'))) process.exitCode=1;
} finally {
  index.close();
}
