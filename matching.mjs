export const faults = {
  power:'Power / restarting', display:'Display / video', network:'Network', input:'Keyboard / mouse',
  software:'Software', thermal:'Overheating', other:'Unclassified'
};
const vocabulary = {
  power:'restart restarting restarts reboot rebooting shutdown power turns off shuts down won t start বন্ধ রিস্টার্ট চালু হয় না চালু হয় না off hoy bondho',
  display:'monitor display screen blank flicker no signal স্ক্রিন মনিটর সিগন্যাল ডিসপ্লে screen e kichu dekha jay na',
  network:'internet wifi wi fi network ethernet offline ইন্টারনেট নেট ওয়াইফাই ওয়াইফাই net chole na',
  input:'keyboard mouse typing key cursor কিবোর্ড কীবোর্ড মাউস টাইপ',
  software:'java eclipse vscode compiler compilation software freezes ide error কম্পাইল সফটওয়্যার জাভা',
  thermal:'overheat overheating heat hot fan গরম ফ্যান gorom fan noise'
};
const phrases = {
  power:['turns off','shuts down','won t start','চালু হয় না','চালু হয় না','off hoy'],
  display:['no signal','screen e kichu dekha jay na'],
  network:['net chole na'],thermal:['fan noise']
};
export function normalize(value) {
  return value.normalize('NFKC').toLowerCase().replace(/[০-৯]/g, c => '০১২৩৪৫৬৭৮৯'.indexOf(c))
    .replace(/[\u200c\u200d]/g,'').replace(/[^\p{L}\p{M}\p{N}]+/gu,' ').trim();
}
export function assets() {
  return ['A','B','C'].flatMap((row, index) => [1,2,3,4,5,6].map(seat => ({
    id:'PC-' + String(index*6+seat).padStart(2,'0'), row, seat,
  })));
}
const contains = (s, p) => (' '+s+' ').includes(' '+normalize(p)+' ');
const tokens = s => normalize(s).split(' ').filter(Boolean);
const ngrams = s => {
  const chars = Array.from(s);
  return new Set(chars.slice(2).map((_,i) => chars.slice(i,i+3).join('')));
};
const similarity = (a,b) => {
  let overlap = 0;
  for (const term of a) if (b.has(term)) overlap++;
  return overlap / (Math.sqrt(a.size * b.size) || 1);
};
const examples = {
  power:['computer keeps cycling off and on','restarts without warning','হঠাৎ বন্ধ হয়ে যায়','bondho hoye abar chalu hoy'],
  display:['screen goes black','nothing shows on display','পর্দা কালো হয়ে গেছে','screen e kisu dekha jay na'],
  network:['cannot connect to the internet','websites won t load','নেট কানেকশন নেই','net dhore na'],
  input:['certain keys won t register','pointer does not move','মাউস নড়ে না','keyboard kaj kore na'],
  software:['java ide crashes on launch','compiler fails to build','প্রোগ্রাম রান হয় না','code run hoy na'],
  thermal:['fan spins loudly and case gets hot','অতিরিক্ত গরম হয়ে যাচ্ছে','cpu onek gorom'],
};
const prototypeIndexes = Object.fromEntries(Object.entries(examples).map(([fault,items]) =>
  [fault,items.map(item=>ngrams(normalize(item)))]));
const keywordIndexes = Object.entries(vocabulary).map(([fault, words]) => ({
  fault, words:tokens(words).filter(word => word.length > 2), grams:ngrams(normalize(words)),
}));
export function matchReport(description, selected, mode = 'hybrid') {
  const query = normalize(description);
  const explicit = [...query.matchAll(/(?:^| )(?:pc|computer|কম্পিউটার|পিসি)\s*(\d{1,3})(?= |$)/gu)]
    .map(([,number]) => 'PC-'+String(Number(number)).padStart(2,'0'));
  const seats = mode === 'baseline' ? [] : [...query.matchAll(/(?:^| )(?:row|সারি) ([abc]) (?:seat|সিট) (\d)(?= |$)|(?:^| )(?:last row|শেষ সারি|last sarir|shesh row) (?:seat|সিট|last seat|শেষ সিট)\s*(\d)?(?= |$)/gu)]
    .map(([whole,row,seat,last]) => row ? [row.toUpperCase(),Number(seat)] : ['C',Number(last || (/last seat|শেষ সিট/u.test(whole) ? 6 : 0))])
    .map(([row,seat]) => assets().find(a => a.row===row && a.seat===seat)?.id ?? 'unknown');
  const ids = [...new Set([...explicit,...seats])];
  const conflict = ids.length > 1 || (selected && ids.some(id => id !== selected));
  const candidate = selected || ids[0];
  const asset = !conflict && assets().some(a => a.id === candidate) ? candidate : null;
  const grams = ngrams(query);
  const ranked = keywordIndexes.map(({fault,words,grams:indexed}) => {
    const lexical = new Set(words.filter(word => contains(query,word))).size;
    const phrase = (phrases[fault] || []).filter(term => contains(query,term)).length;
    const prototype = Math.max(...prototypeIndexes[fault].map(vector=>similarity(grams,vector)));
    const score = mode === 'baseline' ? (query.match(/^[\x00-\x7f]+$/) ? lexical : 0)
      : lexical + 1.7 * phrase + (mode === 'lexical' ? 0 : .45 * similarity(grams,indexed) + 1.65 * prototype);
    return {fault,score};
  }).sort((a,b) => b.score-a.score);
  const [best,next] = ranked;
  const fault = best.score >= 1 && best.score-next.score >= .42 ? best.fault : 'other';
  return {asset,fault,explanation:conflict ? 'Conflicting workstation clues' :
    asset ? (selected ? 'Workstation selected on the map' : 'Matched workstation clue') : 'Workstation needs confirmation',
    signals:ranked.filter(item => item.score >= 1).map(item=>item.fault)};
}
