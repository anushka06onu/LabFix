import {matchReport} from '/matching.mjs';

const get = id => document.getElementById(id);
const labels = {open:'Open',working:'In progress',review:'Needs review',resolved:'Resolved',created:'Opened',linked:'Report linked',reopened:'Reopened after repair',merged:'Merged',priority:'Priority changed',assignment:'Assignment changed'};
const state = {config:null,view:'report',asset:null,token:'',incidents:[],active:null,request:0,key:null,busy:false,visible:[],map:new Map(),mapRequest:0};
const el = (tag,text='',className='') => Object.assign(document.createElement(tag),{textContent:text,className});
function option(label,value) {return Object.assign(el('option',label),{value});}
function action(label,handler,className='quiet') {
  const button = Object.assign(el('button',label,className),{type:'button'});
  button.addEventListener('click',handler);
  return button;
}
function setMessage(id,value) {get(id).textContent=value;}
function date(value) {return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(value);}
async function api(path,{method='GET',body}={}) {
  const headers = {};
  if (body) headers['Content-Type']='application/json';
  if (path.startsWith('/api/operator/') && state.token) headers.Authorization='Bearer '+state.token;
  const response = await fetch(path,{method,headers,body:body ? JSON.stringify(body) : undefined,signal:AbortSignal.timeout(10000)});
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
    setMessage('mapCount',state.map.size+' of '+state.config.assets.length+' affected');
    drawMap();
  } catch {
    if(request===state.mapRequest) {state.map.clear();drawMap();setMessage('mapCount','Status unavailable');}
  }
}
function drawMap() {
  get('assetMap').replaceChildren(...['A','B','C'].map(row=>{
    const line=el('div','','map-row');
    line.append(el('span',row));
    for (const asset of state.config.assets.filter(item=>item.row===row)) {
      const button=action('',()=>choose(asset.id),'seat');
      const health=state.map.get(asset.id);
      const marker=el('span','','monitor');
      marker.setAttribute('aria-hidden','true');
      button.append(marker,el('span',asset.id));
      button.dataset.health=health?.recurrent ? 'recurrent' : health?.active ? 'active' : 'clear';
      const condition=health?.recurrent?'recurring fault':health?.active?'open incident':'no open incident';
      button.setAttribute('aria-label',asset.id+', row '+asset.row+', seat '+asset.seat+', '+condition);
      button.setAttribute('aria-pressed',String(state.asset===asset.id));
      button.dataset.asset=asset.id;
      line.append(button);
    }
    return line;
  }));
}
function choose(asset) {
  if(state.busy) return;
  state.asset=asset;
  state.key=null;
  setMessage('assetChoice',asset ? 'Selected workstation · '+asset : 'Workstation unconfirmed');
  for (const button of get('assetMap').querySelectorAll('button'))
    button.setAttribute('aria-pressed',String(button.dataset.asset===asset));
  updatePreview();
}
function setView(view) {
  state.view=view;
  state.request++;
  const views={report:'reportView',track:'trackView',operator:'operatorView'};
  const tabs={report:'reportTab',track:'trackTab',operator:'opsTab'};
  const copy={
    report:['CAMPUS LAB MAINTENANCE','Get a workstation','back online.','Choose a PC or describe what happened in English, বাংলা, or Banglish. You’ll get a private code to follow the repair.'],
    track:['STUDENT RECEIPTS','Follow your','repair.','Check whether your report is awaiting review, in progress, or resolved.'],
    operator:['MAINTENANCE OPERATIONS','See what needs','attention.','Review reports, assign work, and see which faults return after repair.'],
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
  if (view==='operator' && state.config) refresh();
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
  setMessage('predictionClue',match.explanation+(needsReview?' · Operator review required':' · Ready to match against the incident queue'));
}
function resetDetail() {
  state.active=null;
  get('detail').replaceChildren(el('h2','Incident detail'),el('p','Select an incident to view reports and repair history.','muted'));
}
function drawQueue() {
  const selection=get('filter').value;
  const query=get('search').value.trim().toLowerCase();
  const order=get('order').value;
  const rank={urgent:3,high:2,normal:1};
  const filtered=state.incidents.filter(item=>(selection==='all'||item.status===selection)&&
    ['LF-'+item.id,item.asset,item.assignee,state.config.faults[item.fault]].filter(Boolean).join(' ').toLowerCase().includes(query));
  filtered.sort((a,b)=>(order==='priority' ? rank[b.priority]-rank[a.priority] : order==='repeat' ? b.repeats-a.repeats : 0)||b.updated-a.updated);
  state.visible=filtered;
  setMessage('queueCount',filtered.length+' shown · '+state.incidents.length+' recent incidents');
  get('queue').replaceChildren(...filtered.map(item=>{
    const button=action('',()=>openDetail(item.id),'incident');
    button.setAttribute('aria-pressed',String(item.id===state.active));
    button.append(el('strong',(item.asset||'Unknown workstation')+' · '+state.config.faults[item.fault]),
      el('small','LF-'+item.id+' · '+labels[item.status]+' · '+item.report_count+' report'+(item.report_count===1?'':'s')+
        (item.repeats?' · '+item.repeats+' recurrence'+(item.repeats===1?'':'s'):'')));
    const metadata=el('div','','between');
    metadata.append(el('span',item.priority,'pill '+item.priority),el('small',item.assignee||'Unassigned'));
    button.append(metadata);
    return button;
  }));
  if(!filtered.length) get('queue').append(el('p','No incidents match this filter.','muted'));
}
async function refresh() {
  const request=++state.request;
  if (!state.config.demo && !state.token) {get('login').hidden=false;get('desk').hidden=true;return;}
  try {
    const result=await api('/api/operator/incidents?lab='+encodeURIComponent(get('lab').value));
    if(request!==state.request) return;
    get('login').hidden=true;
    get('desk').hidden=false;
    state.incidents=result.incidents;
    const titles={active:'Active incidents',review:'Needs review',resolved:'Resolved',recurrences:'Post-repair recurrences',reports:'Reports received'};
    get('metrics').replaceChildren(...Object.entries(titles).map(([key,title])=>{
      const card=el('div','','metric');
      card.append(el('strong',String(result.metrics[key])),el('span',title));
      return card;
    }));
    if (state.active && !state.incidents.some(item=>item.id===state.active)) resetDetail();
    drawQueue();
    drawAnalytics(result.analytics);
  } catch(error) {
    if(request!==state.request) return;
    if(error.status===401) {
      state.token='';
      get('login').hidden=false;
      get('desk').hidden=true;
      setMessage('loginMessage','The operator token was rejected.');
    } else setMessage('globalMessage',error.message);
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
  form.append(el('h3','Update incident'),grid,label,note,button,feedback);
  form.addEventListener('submit',async event=>{
    event.preventDefault();button.disabled=true;
    try {
      await api('/api/operator/incidents/'+incident.id,{method:'PATCH',body:{
        status:get('editStatus').value,asset:get('editAsset').value||null,fault:get('editFault').value,priority:get('editPriority').value,assignee:assignee.value,note:note.value}});
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
      await api('/api/operator/incidents/'+incident.id+'/merge',{method:'POST',body:{target}});
      if(state.active===incident.id && state.view==='operator'){await refresh();if(state.view==='operator') await openDetail(target);}
    } catch(error){feedback.textContent=error.message;}
    finally {button.disabled=false;}
  });
  return form;
}
const runbooks = {
  power:['Confirm whether the entire workstation powers off or just the display.','Record when the issue occurs and whether another workstation shows the same symptoms.'],
  display:['Record whether the monitor shows a message or has no indication.','Compare the symptom with a known working display or connection if available.'],
  network:['Record whether nearby PCs are affected and note the exact error.','Check whether the issue happens on campus services, external sites, or both.'],
  input:['Confirm which device and which keys or controls fail.','Record whether a known working device reproduces the behavior.'],
  software:['Record the app name, version, and exact error message.','Try the same task on a known working lab workstation and compare.'],
  thermal:['Record whether the fault occurs at startup or only during a workload.','Take the workstation out of student use and refer it to lab staff if overheating is suspected.'],
};
function troubleshooting(item) {
  const section=el('details','','troubleshooting');
  section.append(el('summary','Triage checklist and workstation history'));
  const steps=runbooks[item.fault];
  if(steps){
    const list=el('ol');
    list.append(...steps.map(step=>el('li',step)));
    section.append(list);
  } else section.append(el('p','Confirm the reported symptoms and workstation before assigning the incident.','muted'));
  if(item.history.length){
    section.append(timeline('Recent incidents on this workstation',item.history,
      row=>['LF-'+row.id+' · '+state.config.faults[row.fault]+' · '+labels[row.status],row.repair||'No repair note recorded.']));
  }
  return section;
}
async function openDetail(id) {
  const request=++state.request;
  state.active=id;
  drawQueue();
  try {
    const item=await api('/api/operator/incidents/'+id);
    if(request!==state.request) return;
    const detail=get('detail');
    detail.replaceChildren(el('p','LF-'+item.id+' · '+labels[item.status],'muted'),
      el('h2',(item.asset||'Unknown workstation')+' · '+state.config.faults[item.fault]),
      timeline('Student reports',item.reports,report=>[report.explanation,report.description]),
      timeline('Repair history',item.events,event=>[labels[event.type]||event.type,event.note]),
      troubleshooting(item),editForm(item));
    if(item.status==='review' && state.incidents.some(i=>['open','working'].includes(i.status))) detail.append(mergeForm(item));
  } catch(error) {
    if(request===state.request) get('detail').replaceChildren(el('p',error.message,'feedback'));
  }
}
function setDeskView(charts) {
  get('queueView').hidden=charts;
  get('analyticsView').hidden=!charts;
  get('queueTab').setAttribute('aria-pressed',String(!charts));
  get('analyticsTab').setAttribute('aria-pressed',String(charts));
  animate(get(charts?'analyticsView':'queueView'));
}
function exportQueue() {
  const columns=['ID','Workstation','Fault','Status','Priority','Assignee','Reports','Recurrences','Updated UTC'];
  const escape=value=>{
    const raw=String(value??'');
    const safe=/^[\s]*[=+@-]|^[\t\r\n]/.test(raw)?"'"+raw:raw;
    return '"'+safe.replaceAll('"','""')+'"';
  };
  const rows=state.visible.map(item=>['LF-'+item.id,item.asset,state.config.faults[item.fault],labels[item.status],
    item.priority,item.assignee,item.report_count,item.repeats,new Date(item.updated).toISOString()]);
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
get('reportTab').onclick=()=>setView('report');
get('opsTab').onclick=()=>setView('operator');
get('trackTab').onclick=()=>setView('track');
get('queueTab').onclick=()=>setDeskView(false);
get('analyticsTab').onclick=()=>setDeskView(true);
get('export').onclick=exportQueue;
get('search').oninput=drawQueue;
get('order').onchange=drawQueue;
for(const button of document.querySelectorAll('[data-example]')) button.onclick=()=>{
  if(state.busy) return;
  get('description').value=button.dataset.example;
  state.key=null;
  updatePreview();
  get('description').focus();
};
get('trackForm').onsubmit=async event=>{
  event.preventDefault();
  const target=get('trackResult');
  const button=event.currentTarget.querySelector('button');
  if(button.disabled) return;
  button.disabled=true;
  target.textContent='Checking report…';
  try {
    const result=await api('/api/track',{method:'POST',body:{code:get('trackCode').value.trim().toLowerCase()}});
    const lab=state.config?.labs.find(item=>item.id===result.lab)?.name||result.lab;
    target.replaceChildren(el('strong','Report #'+result.report+' · '+labels[result.status]),
      el('p',lab+' · '+(result.asset||'Workstation unconfirmed')),
      el('small','Incident last updated '+date(result.updated)));
  } catch(error) {target.textContent=error.message;}
  finally {button.disabled=false;}
};
get('clearAsset').onclick=()=>choose(null);
get('filter').onchange=drawQueue;
get('refresh').onclick=async()=>{await refresh();if(state.active) await openDetail(state.active);};
get('lab').onchange=()=>{choose(null);resetDetail();setMessage('receipt','');if(state.view==='operator')refresh();state.map.clear();drawMap();refreshMap();};
get('login').onsubmit=event=>{event.preventDefault();state.token=get('token').value.trim();get('token').value='';refresh();};
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
    const track=action('Track this report',()=>{
      get('trackCode').value=result.tracking;
      setView('track');
      get('trackForm').requestSubmit();
    });
    receipt.replaceChildren(el('strong','Report #'+result.report+' received. '+messages[result.action]),
      el('code',result.tracking),track);
    animate(receipt);
    refreshMap();
    if(state.view==='operator')refresh();
  } catch(error){setMessage('receipt',error.message+' You can retry.');}
  finally {state.busy=false;button.disabled=false;get('lab').disabled=false;get('description').readOnly=false;}
};
try {
  state.config=await api('/api/config');
  get('lab').replaceChildren(...state.config.labs.map(lab=>option(lab.name+' · '+lab.location,lab.id)));
  get('lab').disabled=false;
  setMessage('footerNote',state.config.demo?'Demo workspace · sample maintenance data':'Workstation maintenance');
  drawMap();
  get('environment').hidden=!state.config.demo;
  refreshMap();
  if(state.view==='operator')refresh();
} catch(error){setMessage('globalMessage','Unable to load the workspace. Refresh to try again.');}
