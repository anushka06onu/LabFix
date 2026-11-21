const get = id => document.getElementById(id);
const labels = {open:'Open',working:'In progress',review:'Needs review',resolved:'Resolved',created:'Opened',linked:'Report linked',reopened:'Reopened after repair',merged:'Merged'};
const state = {config:null,view:'report',asset:null,token:'',incidents:[],active:null,request:0,key:null,busy:false};
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
function drawMap() {
  get('assetMap').replaceChildren(...['A','B','C'].map(row=>{
    const line=el('div','','map-row');
    line.append(el('span',row));
    for (const asset of state.config.assets.filter(item=>item.row===row)) {
      const button=action(asset.id,()=>choose(asset.id),'seat');
      button.setAttribute('aria-label',asset.id+', row '+asset.row+', seat '+asset.seat);
      button.setAttribute('aria-pressed',String(state.asset===asset.id));
      button.dataset.asset=asset.id;
      line.append(button);
    }
    return line;
  }));
}
function choose(asset) {
  state.asset=asset;
  state.key=null;
  setMessage('assetChoice',asset ? 'Selected workstation · '+asset : 'Workstation unknown');
  for (const button of get('assetMap').querySelectorAll('button'))
    button.setAttribute('aria-pressed',String(button.dataset.asset===asset));
}
function setView(view) {
  state.view=view;
  state.request++;
  const operator=view==='operator';
  get('reportView').hidden=operator;
  get('operatorView').hidden=!operator;
  get('reportTab').setAttribute('aria-pressed',String(!operator));
  get('opsTab').setAttribute('aria-pressed',String(operator));
  setMessage('title',operator?'Lab maintenance desk.':'Get a workstation fixed.');
  setMessage('intro',operator?'Review incoming reports, record repairs, and see which problems return.':'Report a problem in English, বাংলা, or Banglish. A lab operator can use your report to trace the issue and its repair history.');
  setMessage('globalMessage','');
  if (operator && state.config) refresh();
}
function resetDetail() {
  state.active=null;
  get('detail').replaceChildren(el('h2','Incident detail'),el('p','Select an incident to view reports and repair history.','muted'));
}
function drawQueue() {
  const selection=get('filter').value;
  const filtered=state.incidents.filter(item=>selection==='all'||item.status===selection);
  get('queue').replaceChildren(...filtered.map(item=>{
    const button=action('',()=>openDetail(item.id),'incident');
    button.setAttribute('aria-pressed',String(item.id===state.active));
    button.append(el('strong',(item.asset||'Unknown workstation')+' · '+state.config.faults[item.fault]),
      el('small','LF-'+item.id+' · '+labels[item.status]+' · '+item.report_count+' report'+(item.report_count===1?'':'s')+
        (item.repeats?' · '+item.repeats+' recurrence'+(item.repeats===1?'':'s'):'')));
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
        status:get('editStatus').value,asset:get('editAsset').value||null,fault:get('editFault').value,note:note.value}});
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
      editForm(item));
    if(item.status==='review' && state.incidents.some(i=>['open','working'].includes(i.status))) detail.append(mergeForm(item));
  } catch(error) {
    if(request===state.request) get('detail').replaceChildren(el('p',error.message,'feedback'));
  }
}
get('reportTab').onclick=()=>setView('report');
get('opsTab').onclick=()=>setView('operator');
get('clearAsset').onclick=()=>choose(null);
get('filter').onchange=drawQueue;
get('refresh').onclick=async()=>{await refresh();if(state.active) await openDetail(state.active);};
get('lab').onchange=()=>{choose(null);resetDetail();setMessage('receipt','');if(state.view==='operator')refresh();};
get('login').onsubmit=event=>{event.preventDefault();state.token=get('token').value.trim();get('token').value='';refresh();};
get('description').oninput=()=>{state.key=null;};
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
    choose(null);
    const messages={created:'A new incident was opened.',review:'A lab operator will review it.',linked:'It was added to the existing incident.',reopened:'The previous incident was reopened.',received:'Your report is already recorded.'};
    setMessage('receipt','Report #'+result.report+' received. '+messages[result.action]);
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
  if(state.view==='operator')refresh();
} catch(error){setMessage('globalMessage','Unable to load the workspace. Refresh to try again.');}
