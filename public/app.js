import {matchReport} from '/matching.mjs';
import {buildCopilotPanel,modelBadge} from '/agent-ui.js';

const get = id => document.getElementById(id);
const labels = {open:'Open',working:'In progress',review:'Needs review',resolved:'Resolved',created:'Opened',linked:'Report linked',
  reopened:'Reopened after repair',merged:'Merged',priority:'Priority changed',assignment:'Assignment changed',
  copilot_reviewed:'Triage draft reviewed',copilot_handoff:'Repair handoff'};
const state = {
  config:null, view:'report', deskView:'queue', asset:null, token:'', incidents:[], workstations:[],
  active:null, workstation:null, key:null, busy:false, visible:[], map:new Map(), mapReady:false,
  mapRequest:0, queueRequest:0, detailRequest:0, workstationRequest:0, knowledgeRequest:0, modelRequest:0, connection:null,
  mapFilter:'all', priority:'all', receipts:[], evaluation:null, incidentPanel:'copilot',
};
const mapFilters = {all:'filterAllSeats',attention:'filterActiveSeats',clear:'filterClearSeats'};
const deskViews = {queue:['queueTab','queueView'],analytics:['analyticsTab','analyticsView'],
  workstations:['workstationsTab','workstationsView'],knowledge:['knowledgeTab','knowledgeView']};
const el = (tag,text='',className='') => Object.assign(document.createElement(tag),{textContent:text,className});
function option(label,value) {return Object.assign(el('option',label),{value});}
function action(label,handler,className='quiet') {
  const button = Object.assign(el('button',label,className),{type:'button'});
  button.addEventListener('click',handler);
  return button;
}
function setMessage(id,value) {get(id).textContent=value;}
function date(value) {return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(value);}
function toast(message) {
  const item=el('div',message,'toast success');
  get('toastContainer').append(item);
  setTimeout(()=>item.remove(),3500);
}
async function api(path,{method='GET',body,timeout=10_000}={}) {
  const headers = {};
  if (body) headers['Content-Type']='application/json';
  if (path.startsWith('/api/operator/') && state.token) headers.Authorization='Bearer '+state.token;
  const response = await fetch(path,{method,headers,body:body ? JSON.stringify(body) : undefined,signal:AbortSignal.timeout(timeout)});
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error),{status:response.status});
  return data;
}
function animate(node) {
  node.classList.remove('reveal');
  void node.offsetWidth;
  node.classList.add('reveal');
}
async function refreshMap() {
  const request=++state.mapRequest;
  try {
    const result=await api('/api/map?lab='+encodeURIComponent(get('lab').value));
    if(request!==state.mapRequest) return;
    state.map=new Map(result.status.map(item=>[item.asset,item]));
    state.mapReady=true;
    setMessage('mapCount',state.map.size+' of '+state.config.assets.length+' affected');
    const offline=result.status.filter(item=>item.offline).length;
    const lab=state.config.labs.find(item=>item.id===get('lab').value);
    setMessage('labSummary',lab.location+'\n'+state.config.assets.length+' workstations · '+offline+' out of service');
    drawMap();
    showAssetChoice();
  } catch {
    if(request===state.mapRequest) {
      state.mapReady=false;
      state.map.clear();
      drawMap();
      showAssetChoice();
      setMessage('mapCount','Status unavailable');
      setMessage('labSummary','Workstation status unavailable');
    }
  }
}
function drawMap() {
  let shown=0;
  get('assetMap').replaceChildren(...['A','B','C'].map(row=>{
    const line=el('div','','map-row');
    line.append(el('span',row));
    for (const asset of state.config.assets.filter(item=>item.row===row)) {
      const button=action('',()=>choose(asset.id),'seat');
      const health=state.map.get(asset.id);
      const marker=el('span','','monitor-icon');
      marker.setAttribute('aria-hidden','true');
      button.append(marker,el('span',asset.id));
      const kind=health?.offline ? 'offline' : health?.recurrent ? 'recurrent' : health?.active ? 'active' : 'clear';
      const conditions={offline:'out of service',recurrent:'recurring fault',active:'open incident',clear:'no open incident'};
      const condition=state.mapReady ? conditions[kind] : 'status unavailable';
      button.dataset.health=state.mapReady ? kind : 'unknown';
      const visible=!state.mapReady || state.mapFilter==='all' || (state.mapFilter==='clear' ? kind==='clear' : kind!=='clear');
      button.classList.toggle('filtered-out',!visible);
      if (visible) shown++;
      button.setAttribute('aria-label',asset.id+', row '+asset.row+', seat '+asset.seat+', '+condition);
      button.setAttribute('aria-pressed',String(state.asset===asset.id));
      button.dataset.asset=asset.id;
      line.append(button);
    }
    return line;
  }));
  get('mapEmpty').hidden=shown>0;
  setMessage('mapEmpty',state.mapFilter==='clear' ? 'No available workstations match this filter.' : 'No workstations need attention.');
}
function showAssetChoice() {
  const badge=get('assetChoice');
  const offline=state.map.get(state.asset)?.offline;
  badge.textContent=state.asset ? state.asset+(offline ? ' · out of service' : ' selected') : 'Workstation unconfirmed';
  badge.className='status-pill '+(offline ? 'offline' : state.asset ? 'confirmed' : 'unconfirmed');
}
function choose(asset) {
  if(state.busy) return;
  state.asset=asset;
  state.key=null;
  showAssetChoice();
  get('clearAsset').disabled=!asset;
  for (const button of get('assetMap').querySelectorAll('button'))
    button.setAttribute('aria-pressed',String(button.dataset.asset===asset));
  updatePreview();
}
function setView(view) {
  state.view=view;
  document.body.dataset.view=view;
  state.queueRequest++;
  state.detailRequest++;
  state.workstationRequest++;
  const views={report:'reportView',track:'trackView',operator:'operatorView'};
  const tabs={report:'reportTab',track:'trackTab',operator:'opsTab'};
  const copy={
    report:['CAMPUS LAB MAINTENANCE','Get a workstation','back online.','Select a workstation or describe the problem in English, বাংলা, or Banglish. Use your private receipt to follow the repair.'],
    track:['STUDENT RECEIPTS','Follow your','repair.','Check whether your report is awaiting review, in progress, or resolved.'],
    operator:['MAINTENANCE OPERATIONS','Operator','desk','Review incidents, investigate faults, and manage workstation availability.'],
  };
  for (const key of Object.keys(views)) {
    get(views[key]).hidden=key!==view;
    get(tabs[key]).setAttribute('aria-pressed',String(key===view));
  }
  const [context,title,highlight,intro]=copy[view];
  setMessage('context',context);
  get('title').replaceChildren(document.createTextNode(title+' '),el('em',highlight));
  setMessage('intro',intro);
  get('lab').closest('.hero-tool').hidden=view==='track';
  setMessage('globalMessage','');
  animate(get(views[view]));
  if (view==='operator' && state.config) {
    refresh();
    if (state.active && state.deskView==='queue') openDetail(state.active);
    if (state.workstation && state.deskView==='workstations') openWorkstation(state.workstation);
  }
  if (view==='report' && state.config) refreshMap();
}
function updatePreview() {
  const value=get('description').value;
  setMessage('characterCount',value.length+' / 600');
  const show=Boolean(state.config && value.trim().length>=8);
  get('preview').hidden=!show;
  if (!show) return;
  const match=matchReport(value,state.asset);
  const fault=state.config.faults[match.fault];
  setMessage('predictionText',(match.asset||'Workstation unconfirmed')+' · '+fault);
  const needsReview=!match.asset||match.fault==='other';
  setMessage('predictionClue',match.explanation);
  const badge=get('predictionBadge');
  badge.textContent=needsReview ? 'Needs review' : 'Ready to route';
  badge.className='pill '+(needsReview ? 'high' : 'success');
}
function resetDetail() {
  state.detailRequest++;
  state.active=null;
  state.incidentPanel='copilot';
  get('detail').replaceChildren(el('h2','Incident detail'),el('p','Select an incident to review reports, assign work, or record a repair.','muted'));
  const sample=state.config?.demo&&state.incidents.find(item=>item.asset==='PC-17'&&item.repeats>0);
  if (sample) get('detail').append(action('Open sample recurrence · PC-17',()=>openDetail(sample.id),'quiet empty-sample'));
}
function responseStatus(item, now=Date.now()) {
  if (item.first_response!=null)
    return item.first_response<=item.response_due ? ['Responded within target','success'] : ['Responded after target','high'];
  if (item.response_due==null) return ['Response target unavailable','normal'];
  if (item.response_due<=now) return ['Response overdue','urgent'];
  return ['Response due '+date(item.response_due),'normal'];
}
function setPriority(priority) {
  state.priority=priority;
  for (const button of get('quickPriorityFilter').querySelectorAll('button'))
    button.setAttribute('aria-pressed',String(button.dataset.priority===priority));
}
function drawQueue() {
  const selection=get('filter').value;
  const query=get('search').value.trim().toLowerCase();
  const order=get('order').value;
  const rank={urgent:3,high:2,normal:1};
  const now=Date.now();
  const filtered=state.incidents.filter(item=>(selection==='all'||item.status===selection||
    (selection==='overdue'&&item.status!=='resolved'&&responseStatus(item,now)[1]==='urgent'))&&
    (state.priority==='all'||item.priority===state.priority)&&
    ['LF-'+item.id,item.asset,item.assignee,state.config.faults[item.fault]].filter(Boolean).join(' ').toLowerCase().includes(query));
  filtered.sort((a,b)=>(order==='priority' ? rank[b.priority]-rank[a.priority] :
    order==='repeat' ? b.repeats-a.repeats : 0)||b.updated-a.updated);
  state.visible=filtered;
  setMessage('queueCount',filtered.length+' shown · '+state.incidents.length+' recent incidents');
  get('queue').replaceChildren(...filtered.map(item=>{
    const button=action('',()=>openDetail(item.id),'incident');
    button.dataset.incident=item.id;
    button.setAttribute('aria-pressed',String(item.id===state.active));
    button.append(el('strong',(item.asset||'Unknown workstation')+' · '+state.config.faults[item.fault]),
      el('small','LF-'+item.id+' · '+labels[item.status]+' · '+item.report_count+' report'+(item.report_count===1?'':'s')+
        (item.repeats?' · '+item.repeats+' recurrence'+(item.repeats===1?'':'s'):'')));
    const metadata=el('div','','between');
    metadata.append(el('span',item.priority,'pill '+item.priority),el('small',item.assignee||'Unassigned'));
    button.append(metadata);
    if (item.status!=='resolved'&&item.first_response==null) {
      const [label,tone]=responseStatus(item,now);
      button.append(el('span',label,'pill response-pill '+tone));
    }
    return button;
  }));
  if(!filtered.length) get('queue').append(el('p','No incidents match this filter.','muted'));
}
async function refresh() {
  const request=++state.queueRequest;
  if (!state.config.demo && !state.token) {get('login').hidden=false;get('desk').hidden=true;return;}
  try {
    const result=await api('/api/operator/incidents?lab='+encodeURIComponent(get('lab').value));
    if(request!==state.queueRequest) return;
    get('login').hidden=true;
    get('desk').hidden=false;
    get('lockDesk').hidden=state.config.demo;
    state.incidents=result.incidents;
    state.workstations=result.workstations||[];
    const titles={active:'Active incidents',review:'Needs review',overdue:'Response overdue',resolved:'Resolved',recurrences:'Recurrences',reports:'Reports received'};
    get('metrics').replaceChildren(...Object.entries(titles).map(([key,title])=>{
      const card=key==='overdue' ? action('',()=>{
        setDeskView('queue');
        get('filter').value='overdue';
        get('search').value='';
        setPriority('all');
        drawQueue();
      },'metric metric-overdue') : el('div','','metric');
      card.append(el('strong',String(result.metrics[key]??0)),el('span',title));
      return card;
    }));
    if (!state.active || !state.incidents.some(item=>item.id===state.active)) resetDetail();
    drawQueue();
    drawAnalytics(result.analytics);
    drawInventory();
    if (!state.connection || Date.now()-state.connection.checkedAt>30_000) checkModel();
    if (state.deskView==='knowledge') await drawKnowledge();
  } catch(error) {
    if(request!==state.queueRequest) return;
    if(error.status===401) {
      state.token='';
      clearOperator();
      get('login').hidden=false;
      get('desk').hidden=true;
      setMessage('loginMessage','The operator token was rejected.');
    } else setMessage('globalMessage',error.message);
  }
}
async function checkModel(force=false) {
  const button=get('checkModel');
  if (button.disabled && !force) return;
  const request=++state.modelRequest;
  button.disabled=true;
  try {
    const status=await api('/api/operator/copilot/status');
    if (request!==state.modelRequest) return;
    state.connection=status;
    const info=status.model ? status.model+' · Checked '+date(status.checkedAt) : 'Runbook evidence is available for manual triage.';
    setMessage('modelConnectionInfo',info);
  } catch {
    if (request!==state.modelRequest) return;
    state.connection={status:'unavailable',checkedAt:Date.now()};
    setMessage('modelConnectionInfo','Could not check the inference endpoint.');
  } finally {
    if (request===state.modelRequest) {
      button.disabled=false;
      for (const badge of document.querySelectorAll('[data-model-state]')) modelBadge(badge,state.connection.status);
    }
  }
}
function field(label,id,entries,selected) {
  const wrapper=el('label',label);
  wrapper.htmlFor=id;
  const control=el('select');
  control.id=id;
  control.append(...entries.map(([value,text])=>option(text,value)));
  control.value=selected;
  wrapper.append(control);
  return wrapper;
}
function timeline(title,items,map) {
  const section=el('section');
  section.append(el('h3',title));
  const list=el('ul','','timeline');
  list.append(...items.map(item=>{
    const li=el('li');
    const [head,body]=map(item);
    li.append(el('small',head+' · '+date(item.created)),el('span',body));
    return li;
  }));
  section.append(list);
  return section;
}
function editForm(incident) {
  const form=el('form');
  const grid=el('div','','edit-grid');
  grid.append(field('Status','editStatus',Object.entries(labels).filter(([key])=>['open','working','review','resolved'].includes(key)),incident.status),
    field('Workstation','editAsset',[['','Unconfirmed'],...state.config.assets.map(a=>[a.id,a.id])],incident.asset||''),
    field('Fault class','editFault',Object.entries(state.config.faults),incident.fault));
  grid.append(field('Priority','editPriority',[['normal','Normal'],['high','High'],['urgent','Urgent']],incident.priority));
  const assignee=Object.assign(el('input'),{id:'editAssignee',value:incident.assignee,maxLength:60,placeholder:'e.g. Hardware team'});
  const assignment=el('label','Assigned to');
  assignment.htmlFor=assignee.id;
  assignment.append(assignee);
  grid.append(assignment);
  const note=Object.assign(el('textarea'),{id:'repairNote',maxLength:500,rows:2,placeholder:'What was checked or repaired?'});
  const label=el('label','Repair or triage note');
  label.htmlFor=note.id;
  const button=el('button','Save update','primary');
  const feedback=el('p','','feedback');
  feedback.setAttribute('role','status');
  form.className='incident-edit';
  form.append(el('h3','Update incident'),grid,label,note,button,feedback);
  form.addEventListener('submit',async event=>{
    event.preventDefault();button.disabled=true;
    try {
      await api('/api/operator/incidents/'+incident.id,{method:'PATCH',body:{
        status:get('editStatus').value,asset:get('editAsset').value||null,fault:get('editFault').value,
        priority:get('editPriority').value,assignee:assignee.value,note:note.value,revision:incident.revision}});
      toast('Incident updated.');
      if(state.active===incident.id && state.view==='operator') {await refresh();if(state.active===incident.id) await openDetail(incident.id);}
    } catch(error) {feedback.textContent=error.message;}
    finally {button.disabled=false;}
  });
  return form;
}
function mergeForm(incident) {
  const form=el('form');
  const targets=state.incidents.filter(item=>['open','working'].includes(item.status)).map(item=>[String(item.id),'LF-'+item.id+' · '+item.asset+' · '+state.config.faults[item.fault]]);
  if(!targets.length) return form;
  const mock=field('Link this report to an active incident','mergeTarget',[['','Select an incident'],...targets],'');
  const button=el('button','Merge review item','quiet');
  const feedback=el('p','','feedback');
  feedback.setAttribute('role','status');
  form.append(mock,button,feedback);
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    const target=Number(get('mergeTarget').value);
    if(!target){feedback.textContent='Select a destination incident.';return;}
    button.disabled=true;
    try {
      await api('/api/operator/incidents/'+incident.id+'/merge',{method:'POST',body:{target,revision:incident.revision}});
      toast('Reports merged into LF-'+target+'.');
      if(state.active===incident.id && state.view==='operator'){await refresh();if(state.view==='operator') await openDetail(target);}
    } catch(error){feedback.textContent=error.message;}
    finally {button.disabled=false;}
  });
  return form;
}
function troubleshooting(item) {
  const section=el('details','','troubleshooting');
  section.append(el('summary','Triage checklist and workstation history'));
  if(item.checklist?.length){
    const list=el('ol');
    list.append(...item.checklist.map(step=>el('li',step.text)));
    section.append(list);
  } else section.append(el('p','Confirm the reported symptoms and workstation before assigning the incident.','muted'));
  if(item.history.length){
    section.append(timeline('Recent incidents on this workstation',item.history,
      row=>['LF-'+row.id+' · '+state.config.faults[row.fault]+' · '+labels[row.status],row.repair||'No repair note recorded.']));
  }
  return section;
}
async function openDetail(id) {
  const request=++state.detailRequest;
  if (id!==state.active) state.incidentPanel='copilot';
  state.active=id;
  for (const button of get('queue').querySelectorAll('[data-incident]'))
    button.setAttribute('aria-pressed',String(Number(button.dataset.incident)===id));
  get('detail').replaceChildren(el('p','Loading incident…','muted'));
  try {
    const item=await api('/api/operator/incidents/'+id);
    if(request!==state.detailRequest) return;
    const detail=get('detail');
    const [label,tone]=responseStatus(item);
    const target=el('div','','response-card');
    const hours=state.config.responseHours?.[item.priority];
    target.append(el('span',label,'pill '+tone));
    if (hours) target.append(el('p',hours+'-hour first-response target · '+(item.first_response==null ?
      'Starts when the incident opens or reopens.' : 'First response recorded '+date(item.first_response)+'.'),'muted'));
    const info=el('div');
    info.append(target,editForm(item));
    if(item.status==='review' && state.incidents.some(i=>['open','working'].includes(i.status))) info.append(mergeForm(item));
    const history=el('div','','case-history');
    const renderHistory=events=>history.replaceChildren(troubleshooting(item),
      timeline('Student reports',item.reports,report=>[report.explanation,report.description]),
      timeline('Repair history',events,event=>[labels[event.type]||event.type,event.note]));
    renderHistory(item.events);
    const onReview=async draft=>{
      try {
        if (draft.handoff) {
          await refresh();
          if (request===state.detailRequest) await openDetail(item.id);
          return;
        }
        const updated=await api('/api/operator/incidents/'+item.id);
        if (request===state.detailRequest) renderHistory(updated.events);
      } catch (error) {
        if (request===state.detailRequest) history.prepend(el('p','Refresh to load the latest repair history.','feedback'));
      }
    };
    const copilot=buildCopilotPanel({incident:item,config:state.config.copilot,connection:state.connection?.status,
      api,el,action,date,toast,onReview});
    const chips=el('div','','case-tabs');
    chips.setAttribute('role','group');
    chips.setAttribute('aria-label','Incident workspace');
    const panels=[['copilot','Triage copilot',copilot],['details','Incident details',info],['history','Reports & history',history]];
    const selectPanel=(key)=>{
      state.incidentPanel=key;
      for (const [slug,,panel] of panels) panel.hidden=slug!==key;
      for (const button of chips.children) button.setAttribute('aria-pressed',String(button.dataset.panel===key));
    };
    for (const [slug,title] of panels) {
      const button=action(title,()=>selectPanel(slug),'case-tab');
      button.dataset.panel=slug;
      chips.append(button);
    }
    const header=el('div','','case-header');
    const identity=el('div');
    identity.append(el('p','LF-'+item.id+' · '+labels[item.status],'case-id'),
      el('h2',(item.asset||'Unknown workstation')+' · '+state.config.faults[item.fault]));
    header.append(identity,el('span',item.priority+' priority','pill '+item.priority));
    detail.replaceChildren(header,chips,copilot,info,history);
    selectPanel(state.incidentPanel);
  } catch(error) {
    if(request===state.detailRequest) get('detail').replaceChildren(el('p',error.message,'feedback'));
  }
}
function setDeskView(view) {
  state.deskView=view;
  for (const [name,[tab,panel]] of Object.entries(deskViews)) {
    get(panel).hidden=name!==view;
    get(tab).setAttribute('aria-pressed',String(name===view));
  }
  get('export').hidden=view!=='queue';
  animate(get(deskViews[view][1]));
  if (view==='knowledge') drawKnowledge();
}
async function drawKnowledge() {
  const request=++state.knowledgeRequest;
  const lab=get('lab').value;
  const query=new URLSearchParams({q:get('knowledgeSearch').value,fault:get('knowledgeFault').value,lab});
  const output=get('knowledgeResults');
  get('runbookForm').querySelector('button').textContent='Publish to '+state.config.labs.find(entry=>entry.id===lab).name;
  try {
    const {entries,version,archived}=await api('/api/operator/knowledge?'+query);
    if (request!==state.knowledgeRequest) return;
    setMessage('knowledgeCount',entries.length+' runbooks · Library '+version);
    output.replaceChildren(...entries.map(entry=>runbookCard(entry,lab)));
    const archive=archived||[];
    get('archivedRunbooks').hidden=!archive.length;
    get('archivedRunbookResults').replaceChildren(...archive.map(entry=>runbookCard(entry,lab)));
    if (!entries.length) output.append(el('p','No runbooks matched those symptoms.','muted'));
  } catch(error) {
    if (request===state.knowledgeRequest) output.replaceChildren(el('p',error.message,'feedback'));
  }
}
function runbookCard(entry,lab) {
  const card=el('article','','knowledge-card');
  const code=el('div','','knowledge-card-meta');
  code.append(el('span',entry.id,'source-code'),el('span',state.config.faults[entry.fault],'pill normal'));
  const details=el('details','','knowledge-checks');
  details.append(el('summary','Diagnostic checks'));
  const list=el('ol');
  for (const check of entry.checks) list.append(el('li',check.text));
  details.append(list);
  card.append(code,el('h3',entry.title),el('p',entry.summary,'muted'),details);
  if (!entry.lab) return card;
  card.classList.add('lab-runbook');
  const footer=el('div','','runbook-actions');
  const archive=entry.archived==null;
  const label=archive?'Archive runbook':'Restore runbook';
  const button=action(label,async()=>{
    button.disabled=true;
    try {
      await api('/api/operator/knowledge/'+entry.id+'?lab='+encodeURIComponent(lab),{method:'PATCH',body:{archived:archive}});
      if (get('lab').value===lab && state.view==='operator') {
        await drawKnowledge();
        toast(archive?'Runbook archived.':'Runbook restored.');
      }
    } catch(error) {setMessage('runbookMessage',error.message);get('runbookEditor').open=true;}
    finally {button.disabled=false;}
  },'quiet');
  button.setAttribute('aria-label',label+' · '+entry.title);
  footer.append(el('small','Lab runbook','muted'),button);
  card.append(footer);
  return card;
}
function drawInventory() {
  const offline=state.workstations.filter(item=>item.offline).length;
  setMessage('inventorySummary',state.workstations.length+' workstations · '+offline+' out of service');
  get('inventory').replaceChildren(...state.workstations.map(item=>{
    const button=action('',()=>openWorkstation(item.id),'inventory-card');
    button.dataset.workstation=item.id;
    button.setAttribute('aria-pressed',String(item.id===state.workstation));
    button.append(el('strong',item.id),el('small',item.offline?'Out of service':'In service',item.offline?'offline-text':''));
    return button;
  }));
}
function resetWorkstation() {
  state.workstationRequest++;
  state.workstation=null;
  get('workstationDetail').replaceChildren(el('h2','Workstation availability'),
    el('p','Select a workstation to change its availability or view its history.','muted'));
}
async function openWorkstation(asset) {
  const item=state.workstations.find(row=>row.id===asset);
  if (!item) return;
  const request=++state.workstationRequest;
  state.workstation=asset;
  for (const button of get('inventory').querySelectorAll('[data-workstation]'))
    button.setAttribute('aria-pressed',String(button.dataset.workstation===asset));
  const detail=get('workstationDetail');
  detail.replaceChildren(el('p','Loading workstation…','muted'));
  const path='/api/operator/workstations/'+asset+'?lab='+encodeURIComponent(get('lab').value);
  try {
    const {history}=await api(path);
    if (request!==state.workstationRequest) return;
    const offline=Boolean(history[0]?.offline);
    const form=el('form','','availability-form');
    const note=Object.assign(el('textarea'),{id:'availabilityNote',maxLength:500,rows:3,required:true,
      placeholder:offline ? 'Describe what was checked before returning this PC to use.' : 'Describe why this workstation is unavailable.'});
    const label=Object.assign(el('label','Internal availability note'),{htmlFor:note.id});
    const button=el('button',offline?'Return to service':'Mark out of service',offline?'primary':'quiet');
    const feedback=el('p','','feedback');
    feedback.setAttribute('role','status');
    form.append(label,note,el('p','Students see the availability on the map. Notes are visible to operators.','muted'),button,feedback);
    form.onsubmit=async event=>{
      event.preventDefault();
      button.disabled=true;
      try {
        await api(path,{method:'PATCH',body:{offline:!offline,note:note.value}});
        toast(asset+(offline?' returned to service.':' marked out of service.'));
        if (request===state.workstationRequest) {
          await refresh();
          if (request===state.workstationRequest) openWorkstation(asset);
        }
      } catch (error) {feedback.textContent=error.message;}
      finally {button.disabled=false;}
    };
    detail.replaceChildren(el('p','Row '+item.row+' · Seat '+item.seat,'muted'),el('h2',asset),
      el('span',offline?'Out of service':'In service','pill '+(offline?'urgent':'success')),form);
    if (history.length) detail.append(timeline('Availability history',history,row=>[row.offline?'Taken out of service':'Returned to service',row.note]));
    else detail.append(el('p','No availability changes recorded.','muted'));
  } catch (error) {
    if (request===state.workstationRequest) detail.replaceChildren(el('p',error.message,'feedback'));
  }
}
function clearOperator() {
  state.queueRequest++;
  state.knowledgeRequest++;
  state.modelRequest++;
  state.connection=null;
  get('checkModel').disabled=false;
  setMessage('modelConnectionInfo','Checking inference…');
  for (const badge of document.querySelectorAll('[data-model-state]')) modelBadge(badge,'checking');
  state.incidents=[];
  state.workstations=[];
  state.visible=[];
  get('desk').hidden=true;
  for (const id of ['metrics','queue','inventory','trend','faultBars','busiest','knowledgeResults','knowledgeCount','archivedRunbookResults']) get(id).replaceChildren();
  get('archivedRunbooks').hidden=true;
  resetDetail();
  resetWorkstation();
}
function exportQueue() {
  const columns=['ID','Workstation','Fault','Status','Priority','Assignee','Reports','Recurrences','Response target UTC','First response UTC','Updated UTC'];
  const escape=value=>{
    const raw=String(value??'');
    const safe=/^[\s]*[=+@-]|^[\t\r\n]/.test(raw)?"'"+raw:raw;
    return '"'+safe.replaceAll('"','""')+'"';
  };
  const iso=value=>value==null?'':new Date(value).toISOString();
  const rows=state.visible.map(item=>['LF-'+item.id,item.asset,state.config.faults[item.fault],labels[item.status],
    item.priority,item.assignee,item.report_count,item.repeats,iso(item.response_due),iso(item.first_response),iso(item.updated)]);
  const csv=[columns,...rows].map(row=>row.map(escape).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  const link=el('a');
  link.href=url;
  link.download='labfix-'+get('lab').value+'-incidents.csv';
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function drawAnalytics(data) {
  const counts=new Map(data.daily.map(item=>[item.day,item.total]));
  const chart=el('div','','chart');
  const peak=Math.max(1,...counts.values());
  for(let cursor=data.start;cursor<data.end;cursor+=86400000){
    const day=new Date(cursor).toISOString().slice(0,10);
    const total=counts.get(day)||0;
    const col=el('div','','chart-day');
    const bar=el('progress');
    bar.max=peak;
    bar.value=total;
    bar.setAttribute('aria-label',day+': '+total+' reports');
    bar.title=day+': '+total+' reports';
    col.append(el('span',String(total)),bar,el('span',day.slice(8)));
    chart.append(col);
  }
  get('trend').replaceChildren(chart);
  const breakdown=get('faultBars');
  const max=Math.max(1,...data.faults.map(row=>row.total));
  breakdown.replaceChildren(...data.faults.map(row=>{
    const bar=el('progress');
    const label=state.config.faults[row.fault];
    bar.value=row.total;
    bar.max=max;
    bar.setAttribute('aria-label',label+': '+row.total+' incidents');
    const heading=el('div','','between');
    heading.append(el('span',label),el('strong',String(row.total)));
    const line=el('div','','bar-row');
    line.append(heading,bar);
    return line;
  }));
  const busiest=get('busiest');
  busiest.replaceChildren(...data.busiest.map(row=>{
    const line=el('div','','bar-row between');
    line.append(el('strong',row.asset),el('span',row.repeats+' recurrences · '+row.incidents+' incidents','caption'));
    return line;
  }));
  if(!data.faults.length) breakdown.append(el('p','No incidents in this lab yet.','muted'));
  if(!data.busiest.length) busiest.append(el('p','No workstation history yet.','muted'));
}
function drawEvaluation() {
  if (!state.evaluation) return;
  const language=get('evaluationLanguage').value;
  const methods={baseline:'ASCII keyword baseline',lexical:'Multilingual rules',hybrid:'LabFix hybrid'};
  get('evaluationResults').replaceChildren(...Object.entries(state.evaluation).map(([group,languages])=>{
    const data=languages[language];
    const table=el('table');
    const name=group==='original'?'Original cases':'Challenge cases';
    const head=el('thead');
    const columns=el('tr');
    for (const title of ['Matching method','Exact matches','Incorrect auto-links'])
      columns.append(Object.assign(el('th',title),{scope:'col'}));
    head.append(columns);
    const rows=el('tbody');
    for (const [method,{joint,cases,falseAutomaticLinks}] of Object.entries(data)) {
      const row=el('tr','','evaluation-'+method);
      row.append(Object.assign(el('th',methods[method]),{scope:'row'}),el('td',joint+' / '+cases),
        el('td',String(falseAutomaticLinks)));
      rows.append(row);
    }
    table.append(el('caption',name),head,rows);
    return table;
  }));
}
get('evaluationLanguage').onchange=drawEvaluation;
get('openEvaluation').onclick=async()=>{
  get('evaluationDialog').showModal();
  if (state.evaluation) return;
  setMessage('evaluationStatus','Loading results…');
  try {
    state.evaluation=await api('/api/evaluation');
    drawEvaluation();
    setMessage('evaluationStatus','');
  } catch (error) {
    setMessage('evaluationStatus',error.message);
  }
};
get('reportTab').onclick=()=>setView('report');
get('opsTab').onclick=()=>setView('operator');
get('trackTab').onclick=()=>setView('track');
for (const [view,[tab]] of Object.entries(deskViews)) get(tab).onclick=()=>setDeskView(view);
get('export').onclick=exportQueue;
get('search').oninput=drawQueue;
get('order').onchange=drawQueue;
get('checkModel').onclick=()=>checkModel(true);
let knowledgeTimer;
get('knowledgeSearch').oninput=()=>{
  clearTimeout(knowledgeTimer);
  knowledgeTimer=setTimeout(drawKnowledge,180);
};
get('knowledgeFault').onchange=drawKnowledge;
get('runbookForm').onsubmit=async event=>{
  event.preventDefault();
  const lab=get('lab').value;
  const form=event.currentTarget;
  const button=form.querySelector('button');
  const {checks,...fields}=Object.fromEntries(new FormData(form));
  const body={...fields,checks:checks.split(/\r?\n/).map(check=>check.trim()).filter(Boolean)};
  button.disabled=true;
  setMessage('runbookMessage','Publishing runbook…');
  try {
    await api('/api/operator/knowledge?lab='+encodeURIComponent(lab),{method:'POST',body});
    form.reset();
    get('runbookEditor').open=false;
    setMessage('runbookMessage','');
    if (get('lab').value===lab && state.view==='operator') {
      get('knowledgeSearch').value='';
      get('knowledgeFault').value='';
      await drawKnowledge();
      toast('Runbook published and available to the copilot.');
    }
  } catch(error) {setMessage('runbookMessage',error.message);}
  finally {button.disabled=false;}
};
for (const button of get('quickPriorityFilter').querySelectorAll('button')) button.onclick=()=>{
  setPriority(button.dataset.priority);
  drawQueue();
};
for (const [filter,id] of Object.entries(mapFilters)) get(id).onclick=()=>{
  state.mapFilter=filter;
  for (const button of Object.values(mapFilters)) get(button).setAttribute('aria-pressed',String(button===id));
  if (state.config) drawMap();
};
for(const button of document.querySelectorAll('[data-example],[data-preset]')) button.onclick=()=>{
  if(state.busy) return;
  get('description').value=button.dataset.example||button.dataset.preset;
  state.key=null;
  updatePreview();
  get('description').focus();
};
function trackReceipt(code) {
  if (state.view!=='track') setView('track');
  get('trackCode').value=code;
  get('trackForm').requestSubmit();
}
function drawRecentReceipts() {
  get('recentTracksCard').hidden=!state.receipts.length;
  get('recentTracksList').replaceChildren(...state.receipts.map(item=>{
    const row=el('li');
    row.append(action('Report #'+item.report+' · '+labels[item.status],()=>trackReceipt(item.code)));
    return row;
  }));
}
get('clearRecent').onclick=()=>{
  state.receipts=[];
  drawRecentReceipts();
  get('trackCode').focus();
};
function trackResult(result, lab) {
  const progress=el('ol','','stepper-progress');
  progress.setAttribute('aria-label','Repair progress');
  const current={review:1,open:1,working:2,resolved:3}[result.status];
  for (const [index,step] of ['Received','Triage','In progress','Resolved'].entries()) {
    const item=el('li','','step-item'+(index===current?' active':index<current?' completed':''));
    if (index===current) item.setAttribute('aria-current','step');
    const marker=el('span',index<current?'✓':String(index+1),'step-dot');
    marker.setAttribute('aria-hidden','true');
    item.append(marker,el('span',step));
    progress.append(item);
  }
  get('trackResult').replaceChildren(el('strong','Report #'+result.report+' · '+labels[result.status]),
    el('p',lab+' · '+(result.asset||'Workstation unconfirmed')),progress,
    el('small','Submitted '+date(result.submitted)+' · Incident updated '+date(result.updated),'muted'));
}
get('trackForm').onsubmit=async event=>{
  event.preventDefault();
  const target=get('trackResult');
  const button=event.currentTarget.querySelector('button');
  if(button.disabled) return;
  const code=get('trackCode').value.trim().toLowerCase();
  if (!/^[a-f0-9]{24}$/.test(code)) {
    target.textContent='Enter the 24-character code shown on your receipt.';
    return;
  }
  button.disabled=true;
  target.textContent='Checking report…';
  try {
    const result=await api('/api/track',{method:'POST',body:{code}});
    const lab=state.config?.labs.find(item=>item.id===result.lab)?.name||result.lab;
    trackResult(result,lab);
    state.receipts=[{code,report:result.report,status:result.status},...state.receipts.filter(item=>item.code!==code)].slice(0,5);
    drawRecentReceipts();
  } catch(error) {target.textContent=error.message;}
  finally {button.disabled=false;}
};
get('clearAsset').onclick=()=>choose(null);
get('filter').onchange=drawQueue;
get('refresh').onclick=async()=>{
  await refresh();
  if (state.deskView==='queue'&&state.active) await openDetail(state.active);
  if (state.deskView==='workstations'&&state.workstation) await openWorkstation(state.workstation);
};
get('lab').onchange=()=>{
  state.mapReady=false;
  state.map.clear();
  choose(null);
  get('filterAllSeats').click();
  setMessage('receipt','');
  setMessage('mapCount','Loading status…');
  setMessage('labSummary','');
  clearOperator();
  if (state.view==='operator') refresh();
  refreshMap();
};
get('login').onsubmit=event=>{
  event.preventDefault();
  state.token=get('token').value.trim();
  get('token').value='';
  if (!state.token) {setMessage('loginMessage','Enter the operator token.');return;}
  setMessage('loginMessage','Checking access…');
  refresh();
};
get('lockDesk').onclick=()=>{
  state.token='';
  setMessage('loginMessage','Desk locked.');
  clearOperator();
  refresh();
  get('token').focus();
};
let refreshTimer;
get('autoRefreshToggle').onchange=event=>{
  clearInterval(refreshTimer);
  if (event.currentTarget.checked) refreshTimer=setInterval(()=>{
    if (state.view==='operator'&&!document.hidden&&!get('desk').hidden &&
      !get(deskViews[state.deskView][1]).contains(document.activeElement)) refresh();
  },15_000);
};
get('description').oninput=()=>{state.key=null;updatePreview();};
get('reportForm').onsubmit=async event=>{
  event.preventDefault();
  if(!state.config||state.busy)return;
  const description=get('description').value.trim();
  if(description.length<8){setMessage('receipt','Describe the issue in at least 8 characters.');return;}
  state.busy=true;
  const button=event.currentTarget.querySelector('button[type=submit]');
  button.disabled=true;
  get('lab').disabled=true;
  get('description').readOnly=true;
  setMessage('receipt','Submitting report…');
  const key=state.key || (state.key=[...crypto.getRandomValues(new Uint8Array(16))].map(n=>n.toString(16).padStart(2,'0')).join(''));
  try {
    const result=await api('/api/reports',{method:'POST',body:{lab:get('lab').value,asset:state.asset,description,key}});
    get('description').value='';
    state.busy=false;
    choose(null);
    const messages={created:'A new incident was opened.',review:'A lab operator will review it.',linked:'It was added to the existing incident.',reopened:'The previous incident was reopened.',received:'Your report is already recorded.'};
    const receipt=get('receipt');
    const code=el('code',result.tracking);
    const actions=el('div','','receipt-actions');
    actions.append(action('Track this report',()=>trackReceipt(result.tracking)),
      action('Copy receipt code',async()=>{
        try {
          await navigator.clipboard.writeText(result.tracking);
          toast('Receipt code copied.');
        } catch {
          const range=document.createRange();
          range.selectNodeContents(code);
          const selection=window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          toast('Receipt code selected for copying.');
        }
      }));
    receipt.replaceChildren(el('strong','Report #'+result.report+' received. '+messages[result.action]),code,actions);
    animate(receipt);
    refreshMap();
    if(state.view==='operator')refresh();
  } catch(error){setMessage('receipt',error.message+' You can retry.');}
  finally {state.busy=false;button.disabled=false;get('lab').disabled=false;get('description').readOnly=false;}
};
try {
  state.config=await api('/api/config');
  get('knowledgeFault').append(...Object.entries(state.config.faults).map(([id,label])=>option(label,id)));
  get('runbookFault').append(...Object.entries(state.config.faults).map(([id,label])=>option(label,id)));
  get('lab').replaceChildren(...state.config.labs.map(lab=>option(lab.name,lab.id)));
  get('lab').disabled=false;
  get('clearAsset').disabled=true;
  setMessage('footerNote',state.config.demo?'Demo workspace · sample maintenance data':'Workstation maintenance');
  drawMap();
  get('environment').hidden=!state.config.demo;
  refreshMap();
  if(state.view==='operator')refresh();
} catch(error){setMessage('globalMessage','Unable to load the workspace. Refresh to try again.');}
