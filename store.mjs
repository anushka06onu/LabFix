import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {assets, faults, matchReport} from './matching.mjs';

export const labs = [{id:'innovation',name:'Innovation Lab',location:'Level 2 · Room 204'},
  {id:'systems',name:'Systems Lab',location:'Level 3 · Room 308'}];
export const statuses = ['open','working','resolved','review'];
export const responseHours = Object.freeze({normal:24,high:8,urgent:2});
const hour = 3600_000;
const repeatWindow = 30*86400_000;
const responseDue = `cycle_started + CASE priority
  WHEN 'urgent' THEN ${responseHours.urgent * hour}
  WHEN 'high' THEN ${responseHours.high * hour}
  ELSE ${responseHours.normal * hour} END`;

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lab TEXT NOT NULL, asset TEXT, fault TEXT NOT NULL, status TEXT NOT NULL,
      created INTEGER NOT NULL, updated INTEGER NOT NULL, resolved INTEGER, repeats INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY, incident INTEGER NOT NULL REFERENCES incidents(id), description TEXT NOT NULL,
      explanation TEXT NOT NULL, created INTEGER NOT NULL, request_key TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, incident INTEGER NOT NULL REFERENCES incidents(id), type TEXT NOT NULL,
      note TEXT NOT NULL, created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workstation_events (
      id INTEGER PRIMARY KEY, lab TEXT NOT NULL, asset TEXT NOT NULL,
      offline INTEGER NOT NULL CHECK(offline IN (0,1)), note TEXT NOT NULL, created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS triage_drafts (
      id INTEGER PRIMARY KEY, incident INTEGER NOT NULL REFERENCES incidents(id),
      base_revision INTEGER NOT NULL, last_report INTEGER NOT NULL, created INTEGER NOT NULL,
      payload TEXT NOT NULL, reviewed INTEGER, review_note TEXT
    );
    CREATE TABLE IF NOT EXISTS lab_runbooks (
      id INTEGER PRIMARY KEY, lab TEXT NOT NULL, fault TEXT NOT NULL, title TEXT NOT NULL,
      keywords TEXT NOT NULL, summary TEXT NOT NULL, checks TEXT NOT NULL,
      created INTEGER NOT NULL, archived INTEGER
    );
    CREATE INDEX IF NOT EXISTS runbook_lab ON lab_runbooks(lab,archived,id);
    CREATE INDEX IF NOT EXISTS triage_incident ON triage_drafts(incident,id DESC);
    CREATE INDEX IF NOT EXISTS workstation_history ON workstation_events(lab,asset,id DESC);
    CREATE INDEX IF NOT EXISTS incident_match ON incidents(lab,asset,fault,status,updated);
    CREATE INDEX IF NOT EXISTS report_incident ON reports(incident,id);
    CREATE INDEX IF NOT EXISTS event_incident ON events(incident,id);
  `);
  const columns = (table) => new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map(column => column.name));
  db.exec('BEGIN IMMEDIATE');
  try {
    const incidentColumns = columns('incidents');
    const reportColumns = columns('reports');
    if (!columns('triage_drafts').has('handoff')) db.exec('ALTER TABLE triage_drafts ADD COLUMN handoff TEXT');
    if (!incidentColumns.has('priority')) db.exec("ALTER TABLE incidents ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'");
    if (!incidentColumns.has('assignee')) db.exec("ALTER TABLE incidents ADD COLUMN assignee TEXT NOT NULL DEFAULT ''");
    if (!incidentColumns.has('revision')) db.exec('ALTER TABLE incidents ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    if (!incidentColumns.has('cycle_started')) db.exec(`
      ALTER TABLE incidents ADD COLUMN cycle_started INTEGER;
      ALTER TABLE incidents ADD COLUMN first_response INTEGER;
      UPDATE incidents SET cycle_started=COALESCE(
        (SELECT MAX(created) FROM events WHERE incident=incidents.id AND type='reopened'),created);
      UPDATE incidents SET first_response=(
        SELECT MIN(created) FROM events WHERE incident=incidents.id
          AND type IN ('working','resolved') AND created>=cycle_started
          AND id>COALESCE((SELECT MAX(reopened.id) FROM events reopened
            WHERE reopened.incident=incidents.id AND reopened.type='reopened'),0));
    `);
    if (!reportColumns.has('tracking')) db.exec('ALTER TABLE reports ADD COLUMN tracking TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS report_tracking ON reports(tracking); COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const event = (id,type,note,now) => db.prepare('INSERT INTO events(incident,type,note,created) VALUES(?,?,?,?)').run(id,type,note,now);
  const getIncident = id => db.prepare(`SELECT *, ${responseDue} AS response_due FROM incidents WHERE id=?`).get(id);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function report({lab, asset, description, key}, now = Date.now()) {
    const matched = matchReport(description,asset);
    return transaction(() => {
      const prior = key && db.prepare('SELECT id,incident,tracking FROM reports WHERE request_key=?').get(key);
      if (prior) {
        const tracking = prior.tracking || randomBytes(12).toString('hex');
        if (!prior.tracking) db.prepare('UPDATE reports SET tracking=? WHERE id=?').run(tracking,prior.id);
        return {id:prior.incident,report:prior.id,tracking,action:'received'};
      }
      let incident;
      if (matched.asset && matched.fault !== 'other') {
        incident = db.prepare(`SELECT * FROM incidents WHERE lab=? AND asset=? AND fault=?
          AND (status IN ('open','working') OR (status='resolved' AND resolved BETWEEN ? AND ?))
          ORDER BY status='resolved', updated DESC,id DESC LIMIT 1`).get(lab,matched.asset,matched.fault,now-repeatWindow,now);
      }
      let action = 'created';
      let id = incident?.id;
      if (!incident) {
        const status = matched.asset && matched.fault !== 'other' ? 'open' : 'review';
        id = Number(db.prepare('INSERT INTO incidents(lab,asset,fault,status,created,updated,cycle_started) VALUES(?,?,?,?,?,?,?)')
          .run(lab,matched.asset,matched.fault,status,now,now,now).lastInsertRowid);
        action = status === 'review' ? 'review' : 'created';
      } else if (incident.status === 'resolved') {
        action = 'reopened';
        db.prepare("UPDATE incidents SET status='open',resolved=NULL,updated=?,repeats=repeats+1,cycle_started=?,first_response=NULL,revision=revision+1 WHERE id=?")
          .run(now,now,id);
      } else {
        action = 'linked';
        db.prepare('UPDATE incidents SET updated=? WHERE id=?').run(now,id);
      }
      const tracking = randomBytes(12).toString('hex');
      const reportId = Number(db.prepare('INSERT INTO reports(incident,description,explanation,created,request_key,tracking) VALUES(?,?,?,?,?,?)')
        .run(id,description,matched.explanation,now,key || null,tracking).lastInsertRowid);
      event(id,action,matched.explanation,now);
      return {id,report:reportId,tracking,action};
    });
  }
  function update(id, patch, now = Date.now()) {
    return transaction(() => {
      const current = getIncident(id);
      return current ? updateIncident(current,patch,now) : null;
    });
  }
  function updateIncident(current, patch, now) {
    const {id} = current;
    if (patch.revision != null && patch.revision !== current.revision)
      return {error:'This incident changed. Refresh before saving your update.'};
    const {status, note} = patch;
    const priority = patch.priority ?? current.priority;
    const assignee = patch.assignee ?? current.assignee;
    const asset = patch.asset === undefined ? current.asset : patch.asset;
    const fault = patch.fault ?? current.fault;
    if (status !== 'review' && (!asset || fault==='other')) return {error:'Select a workstation and a fault class first.'};
    if (status === 'resolved' && current.status !== 'resolved' && !note) return {error:'Add a repair note before resolving.'};
    if (['open','working'].includes(status)) {
      const active = db.prepare("SELECT id FROM incidents WHERE id<>? AND lab=? AND asset=? AND fault=? AND status IN ('open','working') LIMIT 1").get(id,current.lab,asset,fault);
      if (active) return {error:'An active incident already covers this workstation and fault.',existing:active.id};
    }
    const reopening = current.status==='resolved' && status!=='resolved';
    const firstResponse = (reopening ? null : current.first_response) ?? (['working','resolved'].includes(status) ? now : null);
    db.prepare('UPDATE incidents SET asset=?,fault=?,status=?,updated=?,resolved=?,priority=?,assignee=?,cycle_started=?,first_response=?,revision=revision+1 WHERE id=?')
      .run(asset,fault,status,now,status==='resolved' ? current.resolved ?? now : null,priority,assignee,
        reopening ? now : current.cycle_started,firstResponse,id);
    if (reopening) event(id,'reopened','Operator reopened the incident',now);
    if (priority !== current.priority) event(id,'priority','Priority set to ' + priority,now);
    if (assignee !== current.assignee) event(id,'assignment',assignee ? 'Assigned to ' + assignee : 'Assignment cleared',now);
    event(id,status,note || 'Operator updated the incident',now);
    return getIncident(id);
  }
  function merge(id, target, now = Date.now(), revision) {
    return transaction(() => {
      const source = getIncident(id);
      const destination = getIncident(target);
      if (!source || !destination) return null;
      if (revision != null && revision !== source.revision)
        return {error:'This incident changed. Refresh before merging it.'};
      if (id===target || source.lab!==destination.lab || source.status!=='review' || !['open','working'].includes(destination.status))
        return {error:'A review item can only be merged into an active incident in the same lab.'};
      db.prepare('UPDATE reports SET incident=? WHERE incident=?').run(target,id);
      db.prepare('UPDATE events SET incident=? WHERE incident=?').run(target,id);
      db.prepare('UPDATE triage_drafts SET incident=?,base_revision=-1 WHERE incident=?').run(target,id);
      db.prepare('DELETE FROM incidents WHERE id=?').run(id);
      db.prepare('UPDATE incidents SET updated=?,revision=revision+1 WHERE id=?').run(now,target);
      event(target,'merged','Operator merged review item LF-'+id,now);
      return getIncident(target);
    });
  }
  function list(lab) {
    return db.prepare(`SELECT i.*, ${responseDue} AS response_due, (SELECT COUNT(*) FROM reports r WHERE r.incident=i.id) AS report_count
      FROM incidents i WHERE i.lab=? ORDER BY i.updated DESC,i.id DESC LIMIT 250`).all(lab);
  }
  function detail(id) {
    const incident = getIncident(id);
    const history = incident?.asset ? db.prepare(`SELECT i.id,i.fault,i.status,i.updated,i.repeats,
        (SELECT e.note FROM events e WHERE e.incident=i.id AND e.type='resolved' ORDER BY e.id DESC LIMIT 1) AS repair
        FROM incidents i WHERE i.lab=? AND i.asset=? AND i.id<>? ORDER BY i.updated DESC LIMIT 5`)
      .all(incident.lab,incident.asset,id) : [];
    return incident ? {...incident,history, reports:db.prepare('SELECT id,description,explanation,created FROM reports WHERE incident=? ORDER BY id DESC').all(id),
      events:db.prepare('SELECT * FROM events WHERE incident=? ORDER BY id DESC').all(id)} : null;
  }
  const latestReport = db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM reports WHERE incident=?');
  function copilotContext(id, now=Date.now()) {
    const current = getIncident(id);
    if (!current) return null;
    const reports = db.prepare('SELECT id,description FROM reports WHERE incident=? ORDER BY id DESC LIMIT 3').all(id);
    const repairs = current.asset ? db.prepare(`SELECT e.id,e.incident,e.note,e.created
      FROM events e JOIN incidents i ON i.id=e.incident
      WHERE i.lab=? AND i.asset=? AND i.fault=? AND e.type='resolved'
      ORDER BY e.id DESC LIMIT 4`).all(current.lab,current.asset,current.fault) : [];
    const related = current.fault==='other' ? [] : db.prepare(`SELECT i.asset,MAX(r.created) AS latest,COUNT(*) AS reports
      FROM incidents i JOIN reports r ON r.incident=i.id
      WHERE i.lab=? AND i.fault=? AND i.asset IS NOT NULL AND i.asset IS NOT ? AND r.created BETWEEN ? AND ?
      GROUP BY i.asset ORDER BY latest DESC,i.asset`).all(current.lab,current.fault,current.asset,now-72*hour,now);
    return {...current,reports,repairs,related,lastReport:reports[0]?.id ?? 0};
  }
  const readDrafts = db.prepare('SELECT * FROM triage_drafts WHERE incident=? ORDER BY id DESC LIMIT 8');
  const readDraft = db.prepare('SELECT * FROM triage_drafts WHERE id=? AND incident=?');
  function draftView(row,current,lastReport) {
    const {payload,base_revision,last_report,handoff,...record} = row;
    return {...record,...JSON.parse(payload),handoff:handoff ? JSON.parse(handoff) : null,
      stale:base_revision!==current.revision || last_report!==lastReport};
  }
  function listDrafts(id) {
    const current=getIncident(id);
    if (!current) return null;
    const lastReport=latestReport.get(id).id;
    return readDrafts.all(id).map(row=>draftView(row,current,lastReport));
  }
  function saveDraft(ticket, payload, now = Date.now()) {
    return transaction(()=>{
      const current=getIncident(ticket.id);
      if (!current) return null;
      const lastReport=latestReport.get(ticket.id).id;
      if (ticket.revision!==current.revision || ticket.lastReport!==lastReport)
        return {error:'The incident received an update during analysis. Refresh and generate a new draft.'};
      const draft=Number(db.prepare('INSERT INTO triage_drafts(incident,base_revision,last_report,created,payload) VALUES(?,?,?,?,?)')
        .run(ticket.id,current.revision,lastReport,now,JSON.stringify(payload)).lastInsertRowid);
      return draftView(readDraft.get(draft,ticket.id),current,lastReport);
    });
  }
  function reviewDraft(id,draft,note,handoff=null,now = Date.now()) {
    return transaction(()=>{
      const row=readDraft.get(draft,id);
      if (!row) return null;
      const current=getIncident(id);
      const lastReport=latestReport.get(id).id;
      const view=draftView(row,current,lastReport);
      if (view.reviewed!=null) return {error:'A review was already recorded for this draft.'};
      if (view.stale) return {error:'A newer report or incident edit arrived. Generate a fresh draft before reviewing.'};
      let updated=current;
      if (handoff) {
        if (!['open','working'].includes(current.status) || !current.asset || current.fault==='other')
          return {error:'Confirm the incident’s workstation and fault before starting work.'};
        const labSources=view.citations.filter(source=>/^LAB-\d+$/.test(source));
        if (labSources.some(source=>!isPublished.get(current.lab,Number(source.slice(4)))))
          return {error:'A cited runbook was archived. Generate a new draft before starting work.'};
        updated=updateIncident(current,{...handoff,status:'working',note:'Started from triage draft '+draft+'.'},now);
        if (updated.error) return updated;
        event(id,'copilot_handoff','Assigned to '+handoff.assignee+' from draft '+draft+'.',now);
      }
      db.prepare('UPDATE triage_drafts SET reviewed=?,review_note=?,handoff=?,base_revision=? WHERE id=?')
        .run(now,note,handoff ? JSON.stringify(handoff) : null,updated.revision,draft);
      event(id,'copilot_reviewed','Triage draft '+draft+' reviewed. '+note,now);
      return draftView(readDraft.get(draft,id),updated,lastReport);
    });
  }
  const draftRunbook = row => row ? {...row,checks:JSON.parse(row.checks)} : null;
  const getRunbook = db.prepare('SELECT * FROM lab_runbooks WHERE lab=? AND id=?');
  const isPublished = db.prepare('SELECT id FROM lab_runbooks WHERE lab=? AND id=? AND archived IS NULL');
  function addRunbook(lab,{fault,title,keywords,summary,checks},now=Date.now()) {
    const id=Number(db.prepare('INSERT INTO lab_runbooks(lab,fault,title,keywords,summary,checks,created) VALUES(?,?,?,?,?,?,?)')
      .run(lab,fault,title,keywords,summary,JSON.stringify(checks),now).lastInsertRowid);
    return draftRunbook(getRunbook.get(lab,id));
  }
  function setRunbookArchive(lab,id,archived,now=Date.now()) {
    return transaction(()=>{
      const row=getRunbook.get(lab,id);
      if (!row) return null;
      if ((row.archived!=null)===archived) return draftRunbook(row);
      db.prepare('UPDATE lab_runbooks SET archived=? WHERE lab=? AND id=?').run(archived ? now : null,lab,id);
      return draftRunbook(getRunbook.get(lab,id));
    });
  }
  const publishedRunbooks = () => db.prepare('SELECT * FROM lab_runbooks WHERE archived IS NULL ORDER BY id DESC').all().map(draftRunbook);
  const archivedRunbooks = lab => db.prepare('SELECT * FROM lab_runbooks WHERE lab=? AND archived IS NOT NULL ORDER BY archived DESC,id DESC')
    .all(lab).map(draftRunbook);
  function metrics(lab, now = Date.now()) {
    return db.prepare(`SELECT COUNT(*) FILTER(WHERE status IN ('open','working')) AS active,
      COUNT(*) FILTER(WHERE status='review') AS review, COUNT(*) FILTER(WHERE status='resolved') AS resolved,
      COALESCE(SUM(repeats),0) AS recurrences,
      COUNT(*) FILTER(WHERE status<>'resolved' AND first_response IS NULL AND ${responseDue}<=?) AS overdue,
      (SELECT COUNT(*) FROM reports JOIN incidents ON reports.incident=incidents.id WHERE incidents.lab=?) AS reports
      FROM incidents WHERE lab=?`).get(now,lab,lab);
  }
  function track(code) {
    return db.prepare(`SELECT r.id AS report,r.created AS submitted,i.status,i.asset,i.updated,i.lab
      FROM reports r JOIN incidents i ON r.incident=i.id WHERE r.tracking=?`).get(code);
  }
  const latestChanges = db.prepare(`
    SELECT w.asset,w.offline,w.note,w.created FROM workstation_events w
    WHERE w.lab=? AND w.id=(SELECT MAX(id) FROM workstation_events WHERE lab=w.lab AND asset=w.asset)
  `);
  function inventory(lab) {
    const changes = new Map(latestChanges.all(lab).map(({asset,...change})=>[asset,change]));
    return assets().map(asset=>({...asset,offline:0,note:'',created:null,...changes.get(asset.id)}));
  }
  function mapStatus(lab) {
    const rows = db.prepare(`SELECT asset, COUNT(*) AS active, MAX(repeats>0) AS recurrent
      FROM incidents WHERE lab=? AND status IN ('open','working') AND asset IS NOT NULL GROUP BY asset`).all(lab);
    const byAsset = new Map(rows.map(row=>[row.asset,row]));
    for (const {asset,offline} of latestChanges.all(lab)) {
      if (offline) byAsset.set(asset,{asset,active:0,recurrent:0,...byAsset.get(asset),offline:true});
    }
    return [...byAsset.values()];
  }
  const workstationHistory = (lab,asset) => db.prepare(`
    SELECT offline,note,created FROM workstation_events WHERE lab=? AND asset=? ORDER BY id DESC LIMIT 20
  `).all(lab,asset);
  function setAvailability(lab, asset, offline, note, now = Date.now()) {
    return transaction(() => {
      const current = db.prepare('SELECT offline FROM workstation_events WHERE lab=? AND asset=? ORDER BY id DESC LIMIT 1')
        .get(lab,asset);
      if (Boolean(current?.offline) === offline) return {error:'Availability already changed. Refresh this workstation.'};
      db.prepare('INSERT INTO workstation_events(lab,asset,offline,note,created) VALUES(?,?,?,?,?)')
        .run(lab,asset,Number(offline),note,now);
      return {offline,history:workstationHistory(lab,asset)};
    });
  }
  function analytics(lab, now=Date.now()) {
    const end = Math.floor(now / 86400000) * 86400000 + 86400000;
    const start = end - 14 * 86400000;
    return {
      daily:db.prepare(`SELECT strftime('%Y-%m-%d',r.created/1000,'unixepoch') AS day,COUNT(*) AS total
        FROM reports r JOIN incidents i ON i.id=r.incident WHERE i.lab=? AND r.created>=? AND r.created<?
        GROUP BY day ORDER BY day`).all(lab,start,end),
      faults:db.prepare('SELECT fault,COUNT(*) AS total FROM incidents WHERE lab=? GROUP BY fault ORDER BY total DESC').all(lab),
      busiest:db.prepare(`SELECT asset,SUM(repeats) AS repeats,COUNT(*) AS incidents FROM incidents
        WHERE lab=? AND asset IS NOT NULL GROUP BY asset ORDER BY repeats DESC,incidents DESC,asset LIMIT 5`).all(lab),
      start, end,
    };
  }
  function seed() {
    if (db.prepare('SELECT COUNT(*) AS n FROM incidents').get().n) return;
    const now = Date.now();
    const add = (lab,asset,description,minutes) => report({lab,asset,description},now-minutes*60_000);
    const power = add('innovation','PC-17','PC 17 keeps restarting and shuts down during class.',7200);
    update(power.id,{status:'resolved',note:'Replaced loose power cable and verified a clean boot.'},now-6900*60_000);
    add('innovation',null,'পিসি ১৭ বারবার বন্ধ হয়ে যায়',150);
    add('innovation',null,'last row seat 5 off hoy every few minutes',23);
    const display = add('innovation','PC-03','The monitor flickers and then shows no signal.',180);
    update(display.id,{status:'working',note:'Testing with a spare HDMI cable.',priority:'high',assignee:'Hardware team'},now-105*60_000);
    const input = add('innovation','PC-12','PC-12 keyboard stops typing intermittently.',600);
    update(input.id,{status:'resolved',note:'Replaced keyboard and tested typing.'},now-455*60_000);
    add('innovation',null,'ইন্টারনেট চলছে না, পেছনের দিকে বসেছিলাম',1620);
    const network = add('innovation','PC-10','PC-10 lost its network connection during class.',205);
    update(network.id,{status:'open',priority:'urgent',assignee:'Campus IT',note:'Ethernet disconnects repeatedly.'},now-190*60_000);
    add('innovation','PC-04','PC-04 cannot reach the internet or campus site.',188);
    add('systems','PC-08','PC 8 internet is offline.',75);
    setAvailability('innovation','PC-06',true,'Reserved for a scheduled memory diagnostic.',now-90*60_000);
  }
  return {report,update,merge,list,detail,metrics,mapStatus,track,analytics,inventory,workstationHistory,setAvailability,
    copilotContext,listDrafts,saveDraft,reviewDraft,addRunbook,setRunbookArchive,publishedRunbooks,archivedRunbooks,seed,
    healthy:()=>db.prepare('SELECT 1 AS ok').get().ok===1,close:()=>db.close()};
}
