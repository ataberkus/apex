import {fileURLToPath} from 'node:url';
import {markFeatureMode} from './lifecycle.mjs';
import {AUTOCOMPACT_TOKENS,parseFeatureFlags,runtimePolicy} from './config.mjs';

// codemode is a container: every tool its script calls fires tool_call itself, so mutating nested calls capture before they run.
const NO_CAPTURE=new Set(['read','grep','find','ls','tool_search','codemode']);
const SKILLS=['debugging','test-writing','profiling','build-systems','python-packaging','numerics','http','databases','git-surgery','security-hardening'];
const STATE='apex-features-state';
const reason=error=>String(error?.message??error).slice(0,1000);
const notify=(ctx,message)=>{if(typeof ctx.ui?.notify==='function')ctx.ui.notify(message,'info');};
const latest=(branch,type)=>{let value;for(const entry of branch){if(entry.type==='custom'&&entry.customType===type)value=entry.data;else if(entry.type==='compaction'&&entry.details?.apexState?.[type])value=entry.details.apexState[type];}return value;};

/** Hooks and flags only at construction. Every capability defaults off. */
export function createApexFeatures({policy=runtimePolicy(),checkpointFactory}={}){
 return pi=>{
  pi.registerFlag('apex-feature-flags',{type:'string',default:'',description:'Opt-in daily-driver features; every feature defaults off.'});
  pi.registerFlag('apex-eval',{type:'boolean',default:false,description:'Explicit eval isolation: disables project learnings and interactive safety prompts.'});
  let flags=new Set(),evalMode=false,accounting,checkpoints,plan,learnings,safety,workflows;
  let meta={version:1,turnCounter:0,checkpointIds:[]},turnId,baseTools,captured=false,releaseMode=()=>{};const owner=Symbol('Apex feature mode');
  const persist=()=>pi.appendEntry(STATE,structuredClone(meta));
  const summary=ctx=>accounting.summarizeSession(ctx.sessionManager.getEntries(),{context:ctx.getContextUsage?.(),model:ctx.model,pricing:ctx.model?.cost,activeLeaf:ctx.sessionManager.getLeafId?.()??ctx.sessionManager.getBranch().at(-1)?.id??null});
  const updateCost=ctx=>{if(flags.has('cost')&&ctx.hasUI&&typeof ctx.ui?.setStatus==='function')ctx.ui.setStatus('apex-cost',accounting.formatCost(summary(ctx)));};
  const rememberCheckpoint=id=>{if(!meta.checkpointIds.includes(id))meta.checkpointIds.push(id);persist();};
  const closeTurn=async()=>{if(checkpoints&&turnId&&captured){await checkpoints.finish(turnId);rememberCheckpoint(turnId);}turnId=undefined;captured=false;};
  const command=(name,description,handler)=>pi.registerCommand(name,{description,async handler(args,ctx){try{return await handler(args,ctx);}catch(error){const r={ok:false,reason:reason(error)};notify(ctx,r.reason);return r;}}});
  const checkpointed=async(operation,ctx)=>{
   if(!checkpoints)return operation();
   meta.turnCounter++;persist();const id=String(meta.turnCounter);
   await checkpoints.capture(id,{signal:ctx.signal});
   try{return await operation();}finally{await checkpoints.finish(id);rememberCheckpoint(id);}
  };
  const initialize=async(_event,ctx)=>{
   await checkpoints?.shutdown();releaseMode();
   // Tree navigation has already moved the branch. Do not append old plan state into it.
   if(plan?.isActive()&&baseTools)pi.setActiveTools(baseTools);
   checkpoints=plan=learnings=safety=workflows=accounting=undefined;turnId=undefined;captured=false;
   flags=new Set(parseFeatureFlags(pi.getFlag('apex-feature-flags')));evalMode=pi.getFlag('apex-eval')===true;
   meta={version:1,turnCounter:0,checkpointIds:[]};baseTools=undefined;
   if(!flags.size&&!evalMode)return;
   releaseMode=markFeatureMode(ctx,{owner,safety:flags.has('safety'),evalMode});
   if(!flags.size)return;
   const branch=ctx.sessionManager.getBranch();const stored=latest(branch,STATE);
   if(stored?.version===1&&Number.isSafeInteger(stored.turnCounter)&&stored.turnCounter>=0)meta={version:1,turnCounter:stored.turnCounter,checkpointIds:Array.isArray(stored.checkpointIds)?stored.checkpointIds.filter(id=>typeof id==='string'&&/^\d+$/.test(id)).slice(-50):[]};
   if(flags.has('cost')||flags.has('report')){
    accounting=await import('./accounting.mjs');
    if(flags.has('cost'))command('cost','Show Apex token and estimated cost totals',async(_args,ctx)=>{const r=summary(ctx);notify(ctx,accounting.formatCost(r));return r;});
    if(flags.has('report'))command('report','Show this session token categories and largest consumers',async(_args,ctx)=>{const r=summary(ctx);notify(ctx,JSON.stringify({totals:r.totals,cost:r.cost,categories:r.categories,topConsumers:r.topConsumers,completeness:r.completeness}));return r;});
    updateCost(ctx);
   }
   if(flags.has('checkpoints')){
    const factory=checkpointFactory??(await import('./checkpoints.mjs')).createCheckpointManager;
    checkpoints=factory({cwd:ctx.cwd,sessionId:ctx.sessionManager.getSessionId()});
    for(const entry of ctx.sessionManager.getEntries()){const state=entry.type==='custom'&&entry.customType===STATE?entry.data:entry.type==='compaction'?entry.details?.apexState?.[STATE]:undefined;if(Number.isSafeInteger(state?.turnCounter)&&state.turnCounter>=0)meta.turnCounter=Math.max(meta.turnCounter,state.turnCounter);}
    for(const entry of await checkpoints.list()){if(/^\d+$/.test(entry.turnId)&&Number.isSafeInteger(Number(entry.turnId)))meta.turnCounter=Math.max(meta.turnCounter,Number(entry.turnId));}
    command('undo','Restore a completed Apex turn (optional turn ID)',async(args,ctx)=>{
     if(plan?.isActive()){const r={ok:false,reason:'Cancel or save the active plan before undo.'};notify(ctx,r.reason);return r;}
     await ctx.waitForIdle();await closeTurn();
     const entries=(await checkpoints.list({signal:ctx.signal})).filter(entry=>meta.checkpointIds.includes(entry.turnId));
     const id=args.trim()||[...entries].reverse().find(entry=>entry.status==='finished')?.turnId;
     if(!id||!entries.some(entry=>entry.turnId===id)){const r={ok:false,reason:'No finished checkpoint is available on the active branch.'};notify(ctx,r.reason);return r;}
     const r=await checkpoints.restore(id,{signal:ctx.signal});notify(ctx,`Turn ${id}: ${r.status}; ${r.changedPaths.length} paths.${r.skippedPaths?.length?` ${r.skippedPaths.length} oversized files were not tracked and are unchanged.`:''}`);return r;
    });
   }
   if(flags.has('plan')||flags.has('review'))workflows=await import('./workflows.mjs');
   if(flags.has('plan')){
    baseTools=latest(branch,'apex-plan-state')?.tools??pi.getActiveTools();
    plan=workflows.createPlanManager({cwd:ctx.cwd,pi,policy,branch,persist:entry=>pi.appendEntry(entry.customType,entry.data)});
    command('plan','Enter read-only planning, save literal Markdown, or cancel',async(args,ctx)=>{
     await ctx.waitForIdle();
     let r;
     if(args==='cancel')r=await plan.cancel(ctx);
     else if(args.startsWith('save '))r=await checkpointed(()=>plan.save(args.slice(5),ctx),ctx);
     else r=await plan.start(args.trim()||'Inspect the current project and write a concrete implementation plan.',ctx);
     notify(ctx,r.reason??(r.path?'Plan saved to PLAN.md; prior tools restored.':'Plan mode updated.'));return r;
    });
   }
   if(flags.has('review'))command('review','Independently verify the current diff',async(args,ctx)=>{
    await ctx.waitForIdle();const r=await workflows.runReview({cwd:ctx.cwd,task:args.trim()||'Verify the current changes against their requirements and check for regressions.',policy},ctx);
    notify(ctx,r.reason??r.result?.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n')??'Review completed.');return r;
   });
   if(flags.has('remember')&&!evalMode){
    const {createLearnings}=await import('./learnings.mjs');learnings=createLearnings({cwd:ctx.cwd,evalMode:false});pi.registerTool(learnings.tool());
   }
   if(flags.has('safety'))safety=(await import('./safety.mjs')).createSafetyGate({pi,evalMode});
   if(flags.has('resume'))command('resume-info','Inspect the current session without replaying tools',async(args,ctx)=>{
    const file=args.trim()||ctx.sessionManager.getSessionFile?.();
    if(!file){const r={ok:false,replayPerformed:false,reason:'This in-memory session has no file to inspect.'};notify(ctx,r.reason);return r;}
    const {inspectResume}=await import('../../lib/session-report.mjs');const r=await inspectResume(file);
    notify(ctx,`${r.branchIds.length} entries; ${r.pendingTools.length} pending calls; inspection never replays tool side effects.`);return r;
   });
  };
  pi.on('session_start',initialize);pi.on('session_tree',initialize);pi.on('session_fork',initialize);
  pi.on('resources_discover',()=>flags.has('skills')?{skillPaths:SKILLS.map(name=>fileURLToPath(new URL(`../../skills/${name}/SKILL.md`,import.meta.url)))}:undefined);
  pi.on('before_agent_start',async(event)=>{
   if(!learnings||evalMode)return;
   const loaded=await learnings.load();
   if(loaded.ok&&loaded.content)event.systemPromptOptions.contextFiles=[...(event.systemPromptOptions.contextFiles??[]),{path:loaded.path,content:loaded.content}];
  });
  pi.on('turn_start',async()=>{
   if(!checkpoints)return;await closeTurn();meta.turnCounter++;turnId=String(meta.turnCounter);persist();
  });
  pi.on('tool_call',async(event,ctx)=>{
   if(!flags.size)return;
   const planning=plan?.gate(event);if(planning?.block)return planning;
   const denied=await safety?.check(event,ctx);if(denied?.block)return denied;
   if(checkpoints&&!NO_CAPTURE.has(event.toolName)){
    if(!turnId){meta.turnCounter++;turnId=String(meta.turnCounter);persist();}
    try{await checkpoints.capture(turnId,{signal:ctx.signal});captured=true;}catch(error){return {block:true,reason:'Checkpoint failed; mutation blocked: '+reason(error)};}
   }
  });
  pi.on('turn_end',async(_event,ctx)=>{await closeTurn();updateCost(ctx);});
  pi.on('agent_before_settle',async(event,ctx)=>{
   if(!plan?.isActive())return;
   if(event.outcome==='completed'&&event.continue!==true&&!event.context?.pendingMessages?.length)
    return checkpointed(()=>plan.finish(event,ctx),ctx);
   return plan.finish(event,ctx);
  });
  pi.on('agent_settled',async(_event,ctx)=>{
   await closeTurn();updateCost(ctx);
   // Settled means no retry, continuation or compaction is pending, so Pi's abort-first manual compaction loses no work.
   const usage=flags.has('autocompact')&&!plan?.isActive()?ctx.getContextUsage?.():undefined;
   if(usage?.tokens>AUTOCOMPACT_TOKENS&&usage.contextWindow>AUTOCOMPACT_TOKENS)ctx.compact({
    onComplete:()=>{notify(ctx,`Compacted at ${Math.round(usage.tokens/1000)}k context tokens.`);updateCost(ctx);},
    onError:error=>notify(ctx,'Autocompact failed: '+reason(error)),
   });
  });
  pi.on('session_shutdown',async(_event,ctx)=>{
   try{await closeTurn();await plan?.shutdown(ctx);}finally{releaseMode();await checkpoints?.shutdown();if(flags.has('cost')&&ctx.hasUI)ctx.ui?.setStatus?.('apex-cost',undefined);}
   flags=new Set();checkpoints=plan=learnings=safety=workflows=accounting=undefined;turnId=undefined;captured=false;
  });
 };
}
export default createApexFeatures();
