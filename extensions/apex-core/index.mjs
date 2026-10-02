import {featureSafetyManaged} from '../apex-features/lifecycle.mjs';
import {readFile} from 'node:fs/promises';
import {parseCoreFlags,parseTimeBudget,parseAttempts,runtimePolicy} from './config.mjs';
import {parseContextFlags,contextFeaturesFor} from '../apex-context/config.mjs';

const noninteractive=Object.freeze({CI:'1',DEBIAN_FRONTEND:'noninteractive',PAGER:'cat',GIT_PAGER:'cat',
  PIP_NO_INPUT:'1',npm_config_yes:'true',GIT_TERMINAL_PROMPT:'0',TERM:'dumb'});
const draft=(customType,content,details)=>({type:'custom_message',customType,content,display:false,...(details?{details}:{})});
const activePlan=ctx=>{let active=false;for(const e of ctx.sessionManager.getBranch()){if(e.type==='custom'&&e.customType==='apex-plan-state')active=e.data?.active===true;else if(e.type==='compaction'&&e.details?.apexState?.['apex-plan-state'])active=e.details.apexState['apex-plan-state'].active===true;}return active;};
const promptFile=name=>readFile(new URL(`../../prompts/${name}.md`,import.meta.url),'utf8');

/** Factories register hooks only. Allocation/probes/tool registration start with session_start. */
export function createApexCore({now=()=>performance.now(),policy=runtimePolicy(),captureEnvironment:injectedCapture}={}) {
  return pi=>{
    pi.registerFlag('apex-core-flags',{type:'string',default:'',description:'Opt-in Apex success-rate experiments, comma-separated; all default off.'});
    pi.registerFlag('headless',{type:'boolean',default:false,description:'Use noninteractive Apex mode when the headless experiment is selected.'});
    pi.registerFlag('apex-time-budget',{type:'string',default:'',description:'Evaluator-supplied time budget in seconds; never changes the evaluator timeout.'});
    pi.registerFlag('apex-attempts',{type:'string',default:'2',description:'Separate max configuration attempts; current free-only policy blocks inference.'});
    let features=new Set(),state,control,processTools,models,capture,diagnostics,loops,time,modePrompt='',loopPrompt='',timePrompt='';
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
      state=control=processTools=models=capture=diagnostics=loops=time=undefined;notes=[];
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
      setMode(ctx);
      if(features.has('headless'))modePrompt=(await promptFile(headless?'mode-headless':'mode-interactive')).trim();
      if(['contract','todo','verify'].some(name=>features.has(name))) {
        const {createTaskState}=await import('./state.mjs');
        state=createTaskState({cwd:ctx.cwd,branch,persist,policy,enforceTodo:features.has('todo'),enforceContract:features.has('contract')});
        if(features.has('contract'))pi.registerTool(state.contractTool());
        if(features.has('todo'))pi.registerTool(state.todoTool());
      }
      if(features.has('snapshot')||features.has('entrypoints'))capture=injectedCapture??(await import('./environment.mjs')).captureEnvironment;
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
      restoreEnv();features=new Set();notes=[];state=control=processTools=models=capture=diagnostics=loops=time=undefined;
      modePrompt='';
    });
    pi.on('before_agent_start',async(event,ctx)=>{
      if(!features.size||activePlan(ctx))return;
      if(modePrompt)event.systemPromptOptions.sections.apex_mode=modePrompt;
      // before_agent_start is a user prompt boundary, not an automatic continuation.
      await state?.begin(event.prompt,{newRun:true});
      loops?.reset();time?.reset();diagnostics?.reset();notes=[];
      meta={version:1,loopNotes:0,timeThresholds:[]};
      if(time){timeOriginNow=now();elapsedBase=0;Object.assign(meta,{budgetSeconds,timeElapsedSeconds:0,timeStartedAtWall:Date.now()});}
      if(features.has('loops')||features.has('time'))saveMeta();
      const content=[];const details={};
      if(capture){
        const snapshot=await capture({cwd:ctx.cwd,task:event.prompt,entrypoints:features.has('entrypoints'),networkAllowed:false,maxBytes:2400});
        content.push(snapshot.text);details.environment=snapshot.details;
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
        const denied=await control.correctToolCall(event,ctx,{headless:headless||featureSafetyManaged(ctx),confirm:ctx.mode==='tui'&&ctx.hasUI?
          command=>ctx.ui.confirm('Confirm catastrophic command',command):undefined});
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
          if(pi.getThinkingLevel?.()!=='xhigh')pi.setThinkingLevel('xhigh');
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
    pi.on('agent_settled',()=>{
      if(features.size&&(features.has('loops')||features.has('time')))saveMeta();
    });
  };
}
export default createApexCore();
