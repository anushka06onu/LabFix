import {DatabaseSync} from 'node:sqlite';

export const libraryVersion = '1.1';
const references = [
  ['KB-P01','power','Unexpected shutdown or restart',
    'power restarts restart shutdown turns off বিদ্যুৎ বন্ধ রিস্টার্ট off hoy power cable',
    'A full workstation shutdown affects fans and indicator lights. A blank monitor can look similar while the computer stays powered.',
    ['Ask whether the fans or power light stop when the screen goes blank.','Record when the shutdown occurs and whether other workstations are affected.','If there is a smell, smoke, or visible damage, keep the workstation out of use and notify facilities.']],
  ['KB-P02','power','Power fault after a repair',
    'power cable loose recurrence recurring returned repeat replaced reboot বারবার',
    'A symptom recurring after a repair warrants checking the previous repair record and reproducing the same symptom before assigning a cause.',
    ['Review the previous repair note and distinguish the old symptom from the new report.','Ask authorized lab staff to verify the external power connection with the workstation switched off.','Escalate to the hardware team if the same fault continues after an external connection check.']],
  ['KB-D01','display','Blank screen or no signal',
    'display blank black screen monitor no signal HDMI স্ক্রিন মনিটর সিগন্যাল',
    'A monitor reporting “no signal” is consistent with an input or signal-path problem. It does not by itself identify the failed component.',
    ['Record the monitor indicator state and any on-screen message.','Ask lab staff to check the active input and compare against a known working display or cable.','Record whether the workstation remains powered while the display is blank.']],
  ['KB-D02','display','Intermittent display flicker',
    'display monitor flickering lines flashing HDMI flicker blinking ঝিলমিল কাঁপে',
    'Distinguish intermittent flicker from sustained loss of signal. Affected displays, applications, and timing narrow the investigation.',
    ['Record whether the flicker happens continuously or during a specific task.','Compare the symptom with a known working display and note whether it follows the monitor.']],
  ['KB-N01','network','Single workstation offline',
    'network offline internet ethernet disconnect cable browser নেট ইন্টারনেট chole na',
    'When nearby workstations are online, the issue may be limited to one workstation or connection.',
    ['Check whether a nearby workstation can reach the same campus service.','Record the error message and whether campus and public sites are both affected.','Ask lab staff to check the visible Ethernet indicator and document the connection state.']],
  ['KB-N02','network','Lab-wide network interruption',
    'network entire whole multiple all computers outage lab shared nearby সবার ইন্টারনেট',
    'Reports from several seats at the same time may indicate a shared outage. Confirm scope before combining reports.',
    ['Identify two or more affected workstations and the approximate time the issue started.','Record whether both campus and external services are affected.','Refer a confirmed multi-seat outage to campus IT with the lab name and timing.']],
  ['KB-I01','input','Keyboard or mouse unresponsive',
    'keyboard mouse input key cursor typing frozen কীবোর্ড মাউস কাজ',
    'An input issue may affect one peripheral or coincide with a frozen application or workstation.',
    ['Identify the device and the keys or actions that fail.','Check whether the issue also occurs outside the current application.','Ask lab staff to compare with a known working peripheral.']],
  ['KB-I02','input','Intermittent or isolated keys',
    'keyboard intermittent specific keys sticky repeated typing modifier trackpad বোতাম',
    'Failure in only certain keys is different from the whole keyboard disconnecting.',
    ['Record the exact keys or gestures and when the failure occurs.','Check whether the symptom follows the peripheral on a known working workstation.']],
  ['KB-S01','software','Application crash or startup failure',
    'software app application program crash error startup version সফটওয়্যার বন্ধ',
    'The app version, error message, and reproduction steps let staff compare one machine with another.',
    ['Record the application name, version, and exact error message.','Reproduce the same task on a known working lab workstation where permitted.','Escalate with reproduction steps if the failure affects several workstations.']],
  ['KB-S02','software','Application freezes during a task',
    'software hangs freezing freeze stuck lag file task অ্যাপ হ্যাং আটকে',
    'A frozen application can leave the operating system responsive. Distinguish app-specific symptoms from system-wide symptoms.',
    ['Record the task, file type, and approximate time of the freeze.','Confirm whether other applications remain responsive.']],
  ['KB-T01','thermal','Overheating and loud fan',
    'thermal overheating hot high temperature fan noise heat গরম তাপ ফ্যান',
    'Suspected overheating should be assessed by lab staff. Student reports may mention loud fans, heat, or a shutdown during use.',
    ['Take the workstation out of student use if overheating is suspected.','Record whether the issue occurs at startup or under a workload.','Refer the workstation to authorized lab staff for inspection.']],
  ['KB-T02','thermal','Heat-related shutdown under load',
    'thermal shutdown workload high load temperature fan hot heavy গরম বন্ধ',
    'Shutdowns during sustained workloads may involve heat or power. Confirm the symptom and preserve the conditions under which it occurred.',
    ['Record the application and how long the workstation had been running.','Avoid repeated stress testing and refer suspected overheating to authorized staff.']],
  ['KB-X01','other','Confirm location and symptoms',
    'unknown unclear uncertain location workstation symptom ambiguous confirmation পর্যালোচনা',
    'An ambiguous report needs a confirmed workstation and a clearly described symptom before a repair can be assigned.',
    ['Confirm the lab, workstation number, or row and seat with the reporter if available.','Collect the visible symptom, affected device, and any error message.']],
].map(([id,fault,title,keywords,summary,checks])=>({id,fault,title,keywords,summary,
  checks:checks.map((text,index)=>({id:id+'.'+(index+1),text}))}));

export const knowledge = references.map(({keywords,...reference})=>reference);

export function labRunbook(row) {
  const id='LAB-'+row.id;
  return {...row,id,checks:row.checks.map((text,i)=>({id:id+'.'+(i+1),text}))};
}

export function openKnowledge(published=[]) {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE VIRTUAL TABLE reference_search USING fts5(id UNINDEXED,lab UNINDEXED,fault UNINDEXED,title,keywords,summary,tokenize='porter unicode61')");
  const insert = db.prepare('INSERT INTO reference_search VALUES(?,?,?,?,?,?)');
  const remove = db.prepare('DELETE FROM reference_search WHERE id=?');
  for (const entry of references) insert.run(entry.id,'',entry.fault,entry.title,entry.keywords,entry.summary);
  const match = db.prepare(`SELECT id FROM reference_search
    WHERE reference_search MATCH ? AND (lab='' OR lab=?) AND (? IS NULL OR fault=?)
    ORDER BY bm25(reference_search,0,0,0,3,2,1),lab DESC,id LIMIT ?`);
  const byId = new Map(knowledge.map(entry=>[entry.id,entry]));
  function register(row) {
    const entry=labRunbook(row);
    remove.run(entry.id);
    byId.delete(entry.id);
    if (entry.archived==null) {
      insert.run(entry.id,entry.lab,entry.fault,entry.title,entry.keywords,entry.summary);
      byId.set(entry.id,entry);
    }
    return entry;
  }
  for (const row of published) register(row);
  const list = (lab,fault) => [...byId.values()].filter(entry=>(!entry.lab||entry.lab===lab)&&(!fault||entry.fault===fault));
  return {
    list,register,
    search(query, fault=null, {fallback=true,lab=null,limit=4}={}) {
      const words = query.normalize('NFKC').toLowerCase().match(/[\p{L}\p{M}\p{N}]{2,32}/gu) || [];
      const terms = [...new Set(words)].slice(0,18).map(word=>'"'+word+'"').join(' OR ');
      const hits=terms ? match.all(terms,lab,fault,fault,limit).map(row=>byId.get(row.id)) : [];
      return hits.length || !fault || !fallback ? hits : list(lab,fault).slice(0,limit);
    },
    close:()=>db.close(),
  };
}
