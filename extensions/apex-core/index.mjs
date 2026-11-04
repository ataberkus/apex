import {featureEvalMode,featureSafetyPrompts} from '../apex-features/lifecycle.mjs';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {parseCoreFlags,parseTimeBudget,parseAttempts,runtimePolicy} from './config.mjs';
import {parseContextFlags,contextFeaturesFor} from '../apex-context/config.mjs';

const noninteractive=Object.freeze({CI:'1',DEBIAN_FRONTEND:'noninteractive',PAGER:'cat',GIT_PAGER:'cat',
  PIP_NO_INPUT:'1',npm_config_yes:'true',GIT_TERMINAL_PROMPT:'0',TERM:'dumb'});
const draft=(customType,content,details)=>({type:'custom_message',customType,content,display:false,...(details?{details}:{})});
const activePlan=ctx=>{let active=false;for(const e of ctx.sessionManager.getBranch()){if(e.type==='custom'&&e.customType==='apex-plan-state')active=e.data?.active===true;else if(e.type==='compaction'&&e.details?.apexState?.['apex-plan-state'])active=e.details.apexState['apex-plan-state'].active===true;}return active;};
const promptFile=name=>readFile(new URL(`../../prompts/${name}.md`,import.meta.url),'utf8');
const LEVELS=['off','minimal','low','medium','high','xhigh','max'];
const contentText=content=>typeof content==='string'?content:Array.isArray(content)?content.filter(part=>part?.type==='text').map(part=>part.text).join('\n'):'';
// Pi's projection already drops other branches, compacted entries and context_edit removals. The newest projected
// snapshot that carried its text must still carry this exact text unedited for the model to see it.
const snapshotVisible=(ctx,hash,text)=>{
  const latest=ctx.sessionManager?.buildSessionProjection?.()?.entries?.findLast(x=>x.sourceEntry?.type==='custom_message'&&
    x.sourceEntry.customType==='apex-initial-context'&&typeof x.sourceEntry.details?.environmentHash==='string'&&
    x.sourceEntry.details.environmentRepeated!==true&&x.messages?.length>0);
  return latest?.sourceEntry.details.environmentHash===hash&&latest.messages.some(message=>contentText(message.content).includes(text));
};
const CONFIRM_TIMEOUT=15000;
// An RPC client (the dashboard) may never answer: deny on timeout, abort or a UI failure, and ignore a late answer.
const timedConfirm=async(ctx,message)=>{
  if(ctx.signal?.aborted)return false;
  const controller=new AbortController();let cancel,timer;
  const canceled=new Promise(resolve=>{cancel=()=>{controller.abort();resolve(false);};timer=setTimeout(cancel,CONFIRM_TIMEOUT);});
  ctx.signal?.addEventListener('abort',cancel,{once:true});
  try{return await Promise.race([Promise.resolve().then(()=>ctx.ui.confirm('Confirm catastrophic command',message,{signal:controller.signal,timeout:CONFIRM_TIMEOUT})),canceled])===true&&!controller.signal.aborted;}
  catch{return false;}
  finally{clearTimeout(timer);ctx.signal?.removeEventListener('abort',cancel);controller.abort();}
};

/** Factories register hooks only. Allocation/probes/tool registration start with session_start. */
export function createApexCore({now=()=>performance.now(),policy=runtimePolicy(),captureEnvironment:injectedCapture}={}) {
  return pi=>{
    pi.registerFlag('apex-core-flags',{type:'string',default:'',description:'Opt-in Apex success-rate experiments, comma-separated; all default off.'});
    pi.registerFlag('headless',{type:'boolean',default:false,description:'Use noninteractive Apex mode when the headless experiment is selected.'});
    pi.registerFlag('apex-time-budget',{type:'string',default:'',description:'Evaluator-supplied time budget in seconds; never changes the evaluator timeout.'});
    pi.registerFlag('apex-attempts',{type:'string',default:'2',description:'Separate max configuration attempts; current free-only policy blocks inference.'});
    let features=new Set(),state,control,processTools,models,capture,probeCache,diagnostics,loops,time,modePrompt='',loopPrompt='',timePrompt='';
    let headless=true,notes=[],savedEnv=new Map(),meta={version:1,loopNotes:0,timeThresholds:[]};
    let timeOriginNow=0,elapsedBase=0,budgetSeconds;
    const persist=(type,data)=>pi.appendEntry(type,data);
    const saveMeta=()=>{
      if(time)meta.timeElapsedSeconds=Math.min(86400,Math.max(elapsedBase,elapsedBase+(now()-timeOriginNow)/1000));
      persist('apex-core-control',structuredClone(meta));
    };
    const restoreEnv=()=>{
      for(const [name,old]of savedEnv)old===undefined?delete process.env[name]:process.env[name]=old;
      savedEnv.clear();
    };
    const setMode=ctx=>{
      headless=pi.getFlag('headless')===true||ctx.mode!=='tui'||!process.stdout.isTTY;
      if(features.has('headless')&&headless)for(const [name,value]of Object.entries(noninteractive)){
        if(!savedEnv.has(name))savedEnv.set(name,process.env[name]);process.env[name]=value;
      }
    };
    const initialize=async(_event,ctx)=>{
      restoreEnv();features=new Set(parseCoreFlags(pi.getFlag('apex-core-flags')));
      state=control=processTools=models=capture=probeCache=diagnostics=loops=time=undefined;notes=[];
      modePrompt=loopPrompt=timePrompt='';
      meta={version:1,loopNotes:0,timeThresholds:[]};
      if(!features.size)return;
      const branch=ctx.sessionManager.getBranch();
      let stored;
      for(const entry of branch){
        if(entry.type==='custom'&&entry.customType==='apex-core-control')stored=entry.data;
        else if(entry.type==='compaction'&&entry.details?.apexState?.['apex-core-control'])stored=entry.details.apexState['apex-core-control'];
      }
      if(stored?.version===1&&Number.isInteger(stored.loopNotes)&&stored.loopNotes>=0&&stored.loopNotes<=2&&
        Array.isArray(stored.timeThresholds)&&stored.timeThresholds.every(value=>[0.5,0.75,0.9].includes(value)))meta=structuredClone(stored);
      const restore=meta.thinkingRestore;
      if(restore!==undefined&&!(LEVELS.includes(restore?.from)&&LEVELS.includes(restore?.to)))delete meta.thinkingRestore;
      setMode(ctx);
      if(features.has('headless'))modePrompt=(await promptFile(headless?'mode-headless':'mode-interactive')).trim();
      if(['contract','todo','verify'].some(name=>features.has(name))) {
        const {createTaskState}=await import('./state.mjs');
        state=createTaskState({cwd:ctx.cwd,branch,persist,policy,enforceTodo:features.has('todo'),enforceContract:features.has('contract')});
        if(features.has('contract'))pi.registerTool(state.contractTool());
        if(features.has('todo'))pi.registerTool(state.todoTool());
      }
      // Version probes are reused for the session (session_start/tree/fork); only available results are kept.
      if(features.has('snapshot')||features.has('entrypoints')){capture=injectedCapture??(await import('./environment.mjs')).captureEnvironment;probeCache=new Map();}
      if(['loops','time','correct','diagnostics'].some(name=>features.has(name)))control=await import('./control.mjs');
      if(features.has('loops')){loops=control.createLoopBreaker();loopPrompt=(await promptFile('loop-breaker')).trim();}
      if(features.has('time')){
        const value=pi.getFlag('apex-time-budget');
        if(value!==undefined&&value!==''){
          budgetSeconds=parseTimeBudget(value);timeOriginNow=now();elapsedBase=0;
          if(meta.budgetSeconds===budgetSeconds&&Number.isFinite(meta.timeStartedAtWall)&&meta.timeStartedAtWall<=Date.now()&&
            Number.isFinite(meta.timeElapsedSeconds)&&meta.timeElapsedSeconds>=0){
            elapsedBase=Math.min(86400,Math.max(meta.timeElapsedSeconds,(Date.now()-meta.timeStartedAtWall)/1000));
          }else{meta.timeStartedAtWall=Date.now();meta.timeThresholds=[];}
          meta.budgetSeconds=budgetSeconds;
          time=control.createTimeTracker({seconds:budgetSeconds,elapsedSeconds:elapsedBase,now});
        }
        timePrompt=(await promptFile('time-note')).trim();
      }
      if(features.has('diagnostics'))diagnostics=control.createDiagnostics({cwd:ctx.cwd});
      if(features.has('bg')){
        processTools=await import('./process.mjs');pi.registerTool(processTools.createBackgroundTool({cwd:ctx.cwd}));
      }
      if(features.has('correct')){
        const {createCorrectionTools}=await import('./correction-tools.mjs');
        const active=pi.getActiveTools();
        for(const definition of createCorrectionTools({cwd:ctx.cwd,contextFeatures:contextFeaturesFor(ctx)??parseContextFlags(pi.getFlag('apex-context-flags'))}))pi.registerTool(definition);
        pi.setActiveTools(active);
      }
      if(['subagents','max','recovery'].some(name=>features.has(name)))models=await import('./models.mjs');
      if(features.has('subagents'))for(const tool of models.createSubagentTools({policy}))pi.registerTool(tool);
      if(features.has('max'))parseAttempts(pi.getFlag('apex-attempts'));
      // Native registrations activate only direct definitions; keep the native loadout untouched otherwise.
    };
    pi.on('session_start',initialize);pi.on('session_tree',initialize);pi.on('session_fork',initialize);
    pi.on('session_shutdown',()=>{
      restoreEnv();features=new Set();notes=[];state=control=processTools=models=capture=probeCache=diagnostics=loops=time=undefined;
      modePrompt='';
    });
    pi.on('before_agent_start',async(event,ctx)=>{
      if(!features.size||activePlan(ctx))return;
      if(modePrompt)event.systemPromptOptions.sections.apex_mode=modePrompt;
      // Pi 1.2+ also emits this for idle pi.sendMessage(...,{triggerTurn:true}) runs (messageType 'custom', no prompt).
      // Only a user prompt is an Apex task boundary; custom runs keep the stable mode section and current task state.
      if(event.messageType!=='user')return;
      // A loop escalation lasts for the task that looped. The next task gets back the level it replaced, unless the level
      // changed since; this runs before the task's first provider request.
      const restore=meta.thinkingRestore;
      if(restore&&pi.getThinkingLevel?.()===restore.to)pi.setThinkingLevel(restore.from);
      await state?.begin(event.prompt,{newRun:true});
      loops?.reset();time?.reset();diagnostics?.reset();notes=[];
      meta={version:1,loopNotes:0,timeThresholds:[]};
      if(time){timeOriginNow=now();elapsedBase=0;Object.assign(meta,{budgetSeconds,timeElapsedSeconds:0,timeStartedAtWall:Date.now()});}
      if(restore||features.has('loops')||features.has('time'))saveMeta();
      const content=[];const details={};
      if(capture){
        const snapshot=await capture({cwd:ctx.cwd,task:event.prompt,entrypoints:features.has('entrypoints'),networkAllowed:false,maxBytes:2400,probeCache});
        const environmentHash=createHash('sha256').update(snapshot.text).digest('hex');
        details.environment=snapshot.details;details.environmentHash=environmentHash;
        // An identical copy of text the model still sees adds only tokens.
        if(snapshotVisible(ctx,environmentHash,snapshot.text))details.environmentRepeated=true;else content.push(snapshot.text);
      }
      if(features.has('contract')){
        const extraction=await state.extractContract(event.prompt,ctx,{signal:ctx.signal});
        content.push(extraction?.status==='complete'?'Task acceptance criteria are recorded in the contract.':
          'Automatic contract extraction is blocked by the free-only policy. Use contract to record concrete acceptance criteria.');
        details.contract=state.snapshot().extraction;
      }
      if(features.has('recovery')){
        const profile=models.recoverySettings({policy});
        details.recovery=profile;
        content.push('Apex recovery is disabled by the free-only policy. Native host retry settings are configured by the launcher profile, not an extension setter.');
      }
      if(features.has('time')&&!time)content.push('Time awareness has no evaluator-supplied budget; no deadline is assumed.');
      if(content.length)return {message:{customType:'apex-initial-context',content:content.join('\n\n'),display:false,details}};
    });
    pi.on('tool_call',async(event,ctx)=>{
      if(!features.size)return;
      if(features.has('correct')){
        const confirms=ctx.hasUI===true&&typeof ctx.ui?.confirm==='function'&&!featureEvalMode(ctx);
        const approval=featureSafetyPrompts(ctx)?'delegate':confirms&&!headless&&ctx.mode==='tui'?
          command=>ctx.ui.confirm('Confirm catastrophic command',String(command).slice(0,2000)):
          confirms&&ctx.mode==='rpc'?command=>timedConfirm(ctx,String(command).slice(0,2000)):undefined;
        const denied=await control.correctToolCall(event,ctx,{approval});
        if(denied?.block)return denied;
      }
      if(processTools){const denied=processTools.applyBashTimeout(event);if(denied?.block)return denied;}
      state?.observeTool(event);
      if(diagnostics)await diagnostics.before(event);
    });
    pi.on('tool_result',async(event,ctx)=>{
      if(!features.size)return;
      state?.observeTool(event);
      if(loops&&meta.loopNotes<2){
        const note=loops.observe(event);
        if(note){
          meta.loopNotes++;saveMeta();
          notes.push(draft('apex-loop-note',loopPrompt.replace('{n}',String(note.n)).replace('{failure_summary}',note.failure_summary),note));
          const before=pi.getThinkingLevel?.();
          if(before!=='xhigh'){
            pi.setThinkingLevel('xhigh');
            // Pi clamps to the model's levels: record what was actually replaced, once per task, so it can be restored.
            const after=pi.getThinkingLevel?.();
            if(!meta.thinkingRestore&&LEVELS.includes(before)&&LEVELS.includes(after)&&after!==before){meta.thinkingRestore={from:before,to:after};saveMeta();}
          }
          persist('apex-routing',{phase:'verification',source:'loop-breaker'});
        }
      }
      if(diagnostics){
        const result=await diagnostics.after(event);
        if(result.newErrors?.length)notes.push(draft('apex-diagnostics',`New ${result.checker} errors after the edit:\n${result.newErrors.join('\n')}`,result));
      }
      // No content rewriting: programmatic callers retain their exact machine-readable result.
    });
    const appendNotes=event=>{
      if(time&&event.outcome==='completed'){
        for(const note of time.poll())if(!meta.timeThresholds.includes(note.threshold)){
          meta.timeThresholds.push(note.threshold);
          const remaining=`${Math.max(0,Math.ceil(note.remaining))}s`,total=`${note.total}s`;
          notes.push(draft('apex-time-note',timePrompt.replace('{remaining}',remaining).replace('{total}',total),note));
        }
        saveMeta();
      }
      if(!notes.length)return event;
      const entries=[...event.entries,...notes];notes=[];
      return {...event,entries};
    };
    pi.on('turn_end',async(event,ctx)=>{
      if(!features.size)return;
      const combined=appendNotes(event);
      if(features.has('todo')&&!activePlan(ctx))return state.onTurn(combined);
      if(combined!==event)return {entries:combined.entries};
    });
    pi.on('agent_before_settle',async(event,ctx)=>{
      if(!features.size)return;
      const combined=appendNotes(event);
      if(features.has('verify')&&!activePlan(ctx))return state.beforeSettle(combined);
      if(combined!==event)return {entries:combined.entries};
    });
    // Choosing any other level by hand cancels the pending restore; the escalation's own event carries level===to.
    pi.on('thinking_level_select',event=>{if(meta.thinkingRestore&&event?.level!==meta.thinkingRestore.to)delete meta.thinkingRestore;});
    pi.on('agent_settled',()=>{
      if(features.size&&(features.has('loops')||features.has('time')))saveMeta();
    });
  };
}
export default createApexCore();
