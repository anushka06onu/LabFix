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
      const prior = key && db.prepare('SELECT id,incident FROM reports WHERE request_key=?').get(key);
      if (prior) return {id:prior.incident,report:prior.id,action:'received'};
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
      const reportId = Number(db.prepare('INSERT INTO reports(incident,description,explanation,created,request_key) VALUES(?,?,?,?,?)')
        .run(id,description,matched.explanation,now,key || null).lastInsertRowid);
      event(id,action,matched.explanation,now);
      return {id,report:reportId,action};
    });
  }
  function update(id, patch, now = Date.now()) {
    return transaction(() => {
      const current = getIncident(id);
      if (!current) return null;
      const {status, note} = patch;
      if (status === 'resolved' && current.status === 'resolved') return current;
      const asset = patch.asset ?? current.asset;
      const fault = patch.fault ?? current.fault;
      if (status !== 'review' && (!asset || fault==='other')) return {error:'Select a workstation and a fault class first.'};
      if (status === 'resolved' && !note) return {error:'Add a repair note before resolving.'};
      if (['open','working'].includes(status)) {
        const active = db.prepare("SELECT id FROM incidents WHERE id<>? AND lab=? AND asset=? AND fault=? AND status IN ('open','working') LIMIT 1").get(id,current.lab,asset,fault);
        if (active) return {error:'An active incident already covers this workstation and fault.',existing:active.id};
      }
      db.prepare('UPDATE incidents SET asset=?,fault=?,status=?,updated=?,resolved=? WHERE id=?')
        .run(asset,fault,status,now,status==='resolved' ? now : null,id);
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
    return incident ? {...incident, reports:db.prepare('SELECT id,description,explanation,created FROM reports WHERE incident=? ORDER BY id DESC').all(id),
      events:db.prepare('SELECT * FROM events WHERE incident=? ORDER BY id DESC').all(id)} : null;
  }
  function metrics(lab) {
    return db.prepare(`SELECT COUNT(*) FILTER(WHERE status IN ('open','working')) AS active,
      COUNT(*) FILTER(WHERE status='review') AS review, COUNT(*) FILTER(WHERE status='resolved') AS resolved,
      COALESCE(SUM(repeats),0) AS recurrences,
      (SELECT COUNT(*) FROM reports JOIN incidents ON reports.incident=incidents.id WHERE incidents.lab=?) AS reports
      FROM incidents WHERE lab=?`).get(lab,lab);
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
    update(display.id,{status:'working',note:'Testing with a spare HDMI cable.'},now-105*60_000);
    const input = add('innovation','PC-12','PC-12 keyboard stops typing intermittently.',600);
    update(input.id,{status:'resolved',note:'Replaced keyboard and tested typing.'},now-455*60_000);
    add('innovation',null,'ইন্টারনেট চলছে না, পেছনের দিকে বসেছিলাম',51);
    add('systems','PC-08','PC 8 internet is offline.',75);
  }
  return {report,update,merge,list,detail,metrics,seed,close:()=>db.close()};
}
