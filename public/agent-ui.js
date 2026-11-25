const toolNames = {
  incident_retrieval:'Retrieved incident runbooks',
  search_runbooks:'Agent searched runbooks',
  read_repair_history:'Agent consulted repair history',
  repair_context:'Included same-workstation repair history',
  check_lab_patterns:'Agent checked other workstations',
  lab_context:'Included related workstation reports',
};
const suggestedTeam={power:'Hardware',display:'Hardware',input:'Hardware',thermal:'Hardware',
  network:'Campus IT',software:'Desktop support'};

export function modelBadge(badge,status) {
  const states={connected:['Model connected','success'],evidence:['Evidence only','normal'],
    'not-listed':['Model unavailable','high'],unavailable:['Endpoint unavailable','high'],checking:['Checking connection','normal']};
  const [label,tone]=states[status]||states.checking;
  badge.textContent=label;
  badge.className='pill '+tone;
}

export function buildCopilotPanel({incident,config,connection,api,el,action,date,toast,onReview}) {
  const panel=el('section','','copilot-panel');
  const header=el('div','','copilot-header');
  const heading=el('div');
  heading.append(el('h3','Triage copilot'),el('p','Draft cited checks from runbooks and incident evidence.','muted'));
  const badge=el('span');
  badge.dataset.modelState='';
  modelBadge(badge,connection);
  header.append(heading,badge);
  const controls=el('div','','copilot-controls');
  const select=Object.assign(el('select'),{id:'copilotFocus'});
  for (const [value,label] of Object.entries(config.focus))
    select.append(Object.assign(el('option',label),{value}));
  select.value=incident.repeats?'recurrence':'triage';
  const focus=Object.assign(el('label','Triage focus'),{htmlFor:select.id});
  focus.append(select);
  const status=el('p','','copilot-status muted');
  status.setAttribute('role','status');
  const run=action('Generate draft',runDraft,'primary');
  controls.append(focus,run);
  const past=el('div','','draft-picker');
  const result=el('div','','copilot-result');
  panel.append(header,controls,status,past,result);
  const path='/api/operator/incidents/'+incident.id+'/triage';
  let drafts=[];
  let active=null;
  let running=false;

  function choose(id) {
    active=id;
    past.replaceChildren();
    const draft=drafts.find(entry=>entry.id===id);
    if (!draft) {
      result.replaceChildren(el('p','Generated drafts and operator reviews will appear here.','muted'));
      return;
    }
    if (drafts.length>1) {
      const label=Object.assign(el('label','Saved drafts'),{htmlFor:'copilotVersions'});
      const versions=Object.assign(el('select'),{id:'copilotVersions'});
      for (const entry of drafts) {
        versions.append(Object.assign(el('option',(entry.mode==='llm'?'LLM draft':'Evidence draft')+' · '+date(entry.created)),{value:entry.id}));
      }
      versions.value=id;
      versions.onchange=()=>choose(Number(versions.value));
      label.append(versions);
      past.append(label);
    }
    render(draft);
  }

  function render(draft) {
    const sources=new Map();
    const evidence=el('section','','draft-evidence');
    evidence.append(el('h4','Retrieved evidence'));
    for (const entry of draft.sources) {
      const card=el('details','','source-card');
      card.append(el('summary',entry.id+' · '+entry.title),el('p',entry.summary));
      if (entry.date) card.append(el('small',(entry.scope==='lab'?'Lab runbook · Published ':'Recorded ')+date(entry.date),'muted'));
      if (entry.checks.length) {
        const list=el('ul');
        for (const check of entry.checks) list.append(el('li',check.text));
        card.append(list);
      }
      sources.set(entry.id,card);
      evidence.append(card);
    }
    const citation=id=>action(id,()=>{
      const card=sources.get(id);
      card.open=true;
      card.querySelector('summary').focus();
      card.scrollIntoView({block:'nearest'});
    },'citation');
    const masthead=el('div','','draft-heading');
    masthead.append(el('span',draft.mode==='llm'?'LLM draft':'Evidence draft','pill '+(draft.mode==='llm'?'success':'normal')),
      el('small',[draft.model,'Library '+draft.libraryVersion,(draft.durationMs/1000).toFixed(1)+' s'].filter(Boolean).join(' · '),'muted'));
    const assessment=el('div','','draft-assessment');
    assessment.append(el('h4','Working assessment'),el('p',draft.assessment));
    if (draft.citations.length) assessment.append(citation(draft.citations[0]));
    if (draft.reason) masthead.append(el('p',draft.reason,'muted draft-message'));
    const steps=el('section','','draft-steps');
    const list=el('ol');
    for (const check of draft.checks) {
      const item=el('li');
      item.append(el('span',check.text),citation(check.source));
      list.append(item);
    }
    steps.append(el('h4','Suggested checks'),list);
    if (draft.question) steps.append(el('p','Follow-up question · '+draft.question,'muted'));
    const trace=el('details','','source-card copilot-trace');
    trace.append(el('summary','Retrieval activity'));
    const events=el('ol');
    for (const event of draft.trace) {
      const label=toolNames[event.tool]||event.tool;
      const item=el('li');
      item.append(el('strong',label),el('p',[event.protocol,event.query,event.ids.join(', ')||'No matching records'].filter(Boolean).join(' · '),'muted'));
      events.append(item);
    }
    trace.append(events);
    result.replaceChildren(masthead,assessment,steps,evidence,trace);
    if (draft.reviewed) {
      const review=el('div','','draft-review');
      review.append(el('h4',draft.handoff?'Review and handoff recorded':'Review recorded'),el('p',draft.review_note));
      if (draft.handoff) review.append(el('p','Assigned to '+draft.handoff.assignee+' · '+draft.handoff.priority+' priority','handoff-summary'));
      review.append(el('small',date(draft.reviewed),'muted'));
      result.append(review);
    } else if (draft.stale) {
      result.append(el('p','New incident activity arrived. Generate an updated draft before recording a review.','draft-stale'));
    } else {
      result.append(reviewForm(draft));
    }
  }

  function reviewForm(draft) {
    const form=el('form','','draft-review');
    const note=Object.assign(el('textarea'),{id:'copilotReviewNote',required:true,maxLength:500,rows:2,
      placeholder:'Record which checks you intend to use or why the suggestions need changes.'});
    const label=Object.assign(el('label','Operator review note'),{htmlFor:note.id});
    const save=el('button','Record review','quiet');
    const feedback=el('p','','feedback');
    feedback.setAttribute('role','status');
    const handoffToggle=Object.assign(el('input'),{type:'checkbox',id:'startHandoff'});
    const details=el('div','','handoff-fields edit-grid');
    details.hidden=true;
    const assignee=Object.assign(el('input'),{id:'handoffAssignee',value:incident.assignee||suggestedTeam[incident.fault]||'',
      required:true,maxLength:60,disabled:true});
    const priority=Object.assign(el('select'),{id:'handoffPriority',disabled:true});
    for (const value of ['normal','high','urgent']) priority.append(Object.assign(el('option',value),{value}));
    priority.value=incident.priority;
    const teamLabel=Object.assign(el('label','Assign to'),{htmlFor:assignee.id});
    teamLabel.append(assignee);
    const priorityLabel=Object.assign(el('label','Priority'),{htmlFor:priority.id});
    priorityLabel.append(priority);
    details.append(teamLabel,priorityLabel);
    handoffToggle.onchange=()=>{
      const enabled=handoffToggle.checked;
      details.hidden=!enabled;
      assignee.disabled=!enabled;
      priority.disabled=!enabled;
      save.textContent=enabled?'Record review and start work':'Record review';
    };
    form.append(label,note);
    if (incident.asset && incident.fault!=='other' && ['open','working'].includes(incident.status)) {
      const toggleLabel=Object.assign(el('label','','handoff-toggle'),{htmlFor:handoffToggle.id});
      toggleLabel.append(handoffToggle,el('span','Assign and move to In progress'));
      form.append(toggleLabel,details);
    }
    form.append(save,feedback);
    form.onsubmit=async event=>{
      event.preventDefault();
      save.disabled=true;
      setStatus(feedback,'Saving review…');
      try {
        const handoff=handoffToggle.checked ? {assignee:assignee.value,priority:priority.value} : null;
        const updated=await api(path+'/'+draft.id,{method:'PATCH',body:{note:note.value,handoff}});
        drafts=drafts.map(item=>item.id===draft.id?updated:item);
        if (panel.isConnected) {
          onReview(updated);
          if (active===draft.id) choose(draft.id);
          toast(updated.handoff?'Handoff recorded. The repair is in progress.':'Operator review recorded.');
        }
      } catch (error) {
        setStatus(feedback,error.message);
      } finally {save.disabled=false;}
    };
    return form;
  }

  function setStatus(target,message) {target.textContent=message;}
  async function runDraft() {
    if (running) return;
    running=true;
    run.disabled=true;
    select.disabled=true;
    setStatus(status,'Retrieving evidence and preparing a draft…');
    try {
      const draft=await api(path,{method:'POST',body:{focus:select.value},timeout:70_000});
      if (!panel.isConnected) return;
      drafts=[draft,...drafts].slice(0,8);
      choose(draft.id);
      setStatus(status,'Draft ready for operator review.');
    } catch (error) {
      setStatus(status,error.message);
    } finally {
      running=false;
      run.disabled=false;
      select.disabled=false;
    }
  }
  run.disabled=true;
  api(path).then(({drafts:records})=>{
    drafts=records;
    choose(drafts[0]?.id);
  }).catch(error=>setStatus(status,error.message)).finally(()=>{if(!running) run.disabled=false;});
  return panel;
}
