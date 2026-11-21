import {readFile,writeFile} from 'node:fs/promises';
import {matchReport} from '../matching.mjs';
const cases = JSON.parse(await readFile(new URL('cases.json',import.meta.url),'utf8'));
const rows = cases.map(([language,description,selected,asset,fault])=>{
  const baseline=matchReport(description,selected,'baseline');
  const hybrid=matchReport(description,selected);
  return {language,description,selected,expected:{asset,fault},baseline,hybrid};
});
const metric=(rows,mode)=>({
  cases:rows.length,
  workstation:rows.filter(row=>row[mode].asset===row.expected.asset).length,
  fault:rows.filter(row=>row[mode].fault===row.expected.fault).length,
  joint:rows.filter(row=>row[mode].asset===row.expected.asset&&row[mode].fault===row.expected.fault).length,
  falseAutomaticLinks:rows.filter(row=>row[mode].asset&&row[mode].fault!=='other'&&
    (row[mode].asset!==row.expected.asset||row[mode].fault!==row.expected.fault)).length
});
const metrics={};
for(const language of ['All',...new Set(rows.map(row=>row.language))]){
  const group=language==='All'?rows:rows.filter(row=>row.language===language);
  metrics[language]={baseline:metric(group,'baseline'),hybrid:metric(group,'hybrid')};
}
console.table(Object.entries(metrics).flatMap(([language,modes])=>Object.entries(modes).map(([mode,m])=>({language,mode,...m}))));
await writeFile(new URL('results.json',import.meta.url),JSON.stringify({metrics,rows},null,2)+'\n');
