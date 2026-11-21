import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {assets, faults, matchReport} from './matching.mjs';

export const labs = [{id:'innovation',name:'Innovation Lab',location:'Level 2 · Room 204'},
  {id:'systems',name:'Systems Lab',location:'Level 3 · Room 308'}];
export const statuses = ['open','working','resolved','review'];
const repeatWindow = 30*86400_000;

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
    CREATE INDEX IF NOT EXISTS incident_match ON incidents(lab,asset,fault,status,updated);
    CREATE INDEX IF NOT EXISTS report_incident ON reports(incident,id);
    CREATE INDEX IF NOT EXISTS event_incident ON events(incident,id);
  `);
  const columns = (table) => new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map(column => column.name));
  db.exec('BEGIN IMMEDIATE');
  try {
    const incidentColumns = columns('incidents');
    const reportColumns = columns('reports');
    if (!incidentColumns.has('priority')) db.exec("ALTER TABLE incidents ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'");
    if (!incidentColumns.has('assignee')) db.exec("ALTER TABLE incidents ADD COLUMN assignee TEXT NOT NULL DEFAULT ''");
    if (!reportColumns.has('tracking')) db.exec('ALTER TABLE reports ADD COLUMN tracking TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS report_tracking ON reports(tracking); COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const event = (id,type,note,now) => db.prepare('INSERT INTO events(incident,type,note,created) VALUES(?,?,?,?)').run(id,type,note,now);
  const getIncident = id => db.prepare('SELECT * FROM incidents WHERE id=?').get(id);
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
        id = Number(db.prepare('INSERT INTO incidents(lab,asset,fault,status,created,updated) VALUES(?,?,?,?,?,?)')
          .run(lab,matched.asset,matched.fault,status,now,now).lastInsertRowid);
        action = status === 'review' ? 'review' : 'created';
      } else if (incident.status === 'resolved') {
        action = 'reopened';
        db.prepare("UPDATE incidents SET status='open',resolved=NULL,updated=?,repeats=repeats+1 WHERE id=?").run(now,id);
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
      if (!current) return null;
      const {status, note} = patch;
      const priority = patch.priority ?? current.priority;
      const assignee = patch.assignee ?? current.assignee;
      const asset = patch.asset ?? current.asset;
      const fault = patch.fault ?? current.fault;
      if (status !== 'review' && (!asset || fault==='other')) return {error:'Select a workstation and a fault class first.'};
      if (status === 'resolved' && current.status !== 'resolved' && !note) return {error:'Add a repair note before resolving.'};
      if (['open','working'].includes(status)) {
        const active = db.prepare("SELECT id FROM incidents WHERE id<>? AND lab=? AND asset=? AND fault=? AND status IN ('open','working') LIMIT 1").get(id,current.lab,asset,fault);
        if (active) return {error:'An active incident already covers this workstation and fault.',existing:active.id};
      }
      db.prepare('UPDATE incidents SET asset=?,fault=?,status=?,updated=?,resolved=?,priority=?,assignee=? WHERE id=?')
        .run(asset,fault,status,now,status==='resolved' ? current.resolved ?? now : null,priority,assignee,id);
      if (priority !== current.priority) event(id,'priority','Priority set to ' + priority,now);
      if (assignee !== current.assignee) event(id,'assignment',assignee ? 'Assigned to ' + assignee : 'Assignment cleared',now);
      event(id,status,note || 'Operator updated the incident',now);
      return getIncident(id);
    });
  }
  function merge(id, target, now = Date.now()) {
    return transaction(() => {
      const source = getIncident(id);
      const destination = getIncident(target);
      if (!source || !destination) return null;
      if (id===target || source.lab!==destination.lab || source.status!=='review' || !['open','working'].includes(destination.status))
        return {error:'A review item can only be merged into an active incident in the same lab.'};
      db.prepare('UPDATE reports SET incident=? WHERE incident=?').run(target,id);
      db.prepare('UPDATE events SET incident=? WHERE incident=?').run(target,id);
      db.prepare('DELETE FROM incidents WHERE id=?').run(id);
      db.prepare('UPDATE incidents SET updated=? WHERE id=?').run(now,target);
      event(target,'merged','Operator merged review item LF-'+id,now);
      return getIncident(target);
    });
  }
  function list(lab) {
    return db.prepare(`SELECT i.*, (SELECT COUNT(*) FROM reports r WHERE r.incident=i.id) AS report_count
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
  function metrics(lab) {
    return db.prepare(`SELECT COUNT(*) FILTER(WHERE status IN ('open','working')) AS active,
      COUNT(*) FILTER(WHERE status='review') AS review, COUNT(*) FILTER(WHERE status='resolved') AS resolved,
      COALESCE(SUM(repeats),0) AS recurrences,
      (SELECT COUNT(*) FROM reports JOIN incidents ON reports.incident=incidents.id WHERE incidents.lab=?) AS reports
      FROM incidents WHERE lab=?`).get(lab,lab);
  }
  function track(code) {
    return db.prepare(`SELECT r.id AS report,r.created AS submitted,i.status,i.asset,i.updated,i.lab
      FROM reports r JOIN incidents i ON r.incident=i.id WHERE r.tracking=?`).get(code);
  }
  function mapStatus(lab) {
    return db.prepare(`SELECT asset, COUNT(*) AS active, MAX(repeats>0) AS recurrent
      FROM incidents WHERE lab=? AND status IN ('open','working') AND asset IS NOT NULL GROUP BY asset`).all(lab);
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
    add('innovation',null,'ইন্টারনেট চলছে না, পেছনের দিকে বসেছিলাম',51);
    add('systems','PC-08','PC 8 internet is offline.',75);
  }
  return {report,update,merge,list,detail,metrics,mapStatus,track,analytics,seed,close:()=>db.close()};
}
