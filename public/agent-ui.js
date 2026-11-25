const toolNames = {
  incident_retrieval:'Retrieved incident runbooks',
  search_runbooks:'Agent searched runbooks',
  read_repair_history:'Agent consulted repair history',
  repair_context:'Included same-workstation repair history',
};

export function buildCopilotPanel({incident,config,api,el,action,date,toast,onReview}) {
  const panel=el('section','','copilot-panel');
  const header=el('div','','copilot-header');
  const heading=el('div');
  heading.append(el('h3','Triage copilot'),el('p','Draft next checks from runbooks and workstation history.','muted'));
  header.append(heading,el('span',config.model ? 'LLM configured' : 'Evidence only','pill '+(config.model?'success':'normal')));
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
      if (entry.date) card.append(el('small','Recorded '+date(entry.date),'muted'));
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
      const label=toolNames[event.tool];
      const item=el('li');
      item.append(el('strong',label),el('p',[event.protocol,event.query,event.ids.join(', ')||'No matching records'].filter(Boolean).join(' · '),'muted'));
      events.append(item);
    }
    trace.append(events);
    result.replaceChildren(masthead,assessment,steps,evidence,trace);
    if (draft.reviewed) {
      const review=el('div','','draft-review');
      review.append(el('h4','Review recorded'),el('p',draft.review_note),el('small',date(draft.reviewed),'muted'));
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
    form.append(label,note,save,feedback);
    form.onsubmit=async event=>{
      event.preventDefault();
      save.disabled=true;
      setStatus(feedback,'Saving review…');
      try {
        const updated=await api(path+'/'+draft.id,{method:'PATCH',body:{note:note.value}});
        drafts=drafts.map(item=>item.id===draft.id?updated:item);
        if (panel.isConnected) {
          onReview(updated);
          if (active===draft.id) choose(draft.id);
          toast('Operator review recorded.');
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
