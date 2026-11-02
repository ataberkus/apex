import {fileURLToPath} from 'node:url';
import {markFeatureMode} from './lifecycle.mjs';
import {parseAutocompactTokens,parseFeatureFlags,runtimePolicy} from './config.mjs';

// codemode is a container: every tool its script calls fires tool_call itself, so mutating nested calls capture before they run.
// todo/contract change only session state; explore/verify run fresh-context sessions or isolated copies outside the working tree.
const NO_CAPTURE=new Set(['read','grep','find','ls','tool_search','codemode','todo','contract','explore','verify']);
const SKILLS=['debugging','test-writing','profiling','build-systems','python-packaging','numerics','http','databases','git-surgery','security-hardening'];
const STATE='apex-features-state';
const reason=error=>String(error?.message??error).slice(0,1000);
const notify=(ctx,message,level='info')=>{if(typeof ctx.ui?.notify==='function')ctx.ui.notify(message,level);};
const latest=(branch,type)=>{let value;for(const entry of branch){if(entry.type==='custom'&&entry.customType===type)value=entry.data;else if(entry.type==='compaction'&&entry.details?.apexState?.[type])value=entry.details.apexState[type];}return value;};
// Message entries of the active branch: the source Pi 1.4.0 replays tool loadouts from on resume and /tree.
const branchMessages=ctx=>ctx.sessionManager.getBranch?.().flatMap(entry=>entry.type==='message'?[entry.message]:[]);
// Stand-ins for a safeguard that could not start, so the hooks' ordinary paths stay fail-closed: a rejected capture blocks the
// mutation, closeTurn never finishes what was not captured, and /undo and /plan save report the setup error.
const refusingCheckpoints=error=>{const refuse=async()=>{throw error;};return {capture:refuse,finish:refuse,restore:refuse,list:refuse,shutdown:async()=>{}};};
const refusingSafety=error=>({check:async()=>({block:true,reason:'Safety gate failed; tool blocked: '+reason(error)})});

/** Hooks and flags only at construction. Every capability defaults off. */
export function createApexFeatures({policy=runtimePolicy(),checkpointFactory,safetyFactory}={}){
 return pi=>{
  pi.registerFlag('apex-feature-flags',{type:'string',default:'',description:'Opt-in daily-driver features; every feature defaults off.'});
  pi.registerFlag('apex-eval',{type:'boolean',default:false,description:'Explicit eval isolation: disables project learnings and interactive safety prompts.'});
  pi.registerFlag('apex-autocompact-tokens',{type:'string',default:'',description:'Context tokens past which autocompact compacts a settled session; empty means 300000.'});
  let flags=new Set(),evalMode=false,autocompactTokens,accounting,summarizer,checkpoints,plan,learnings,safety,workflows;
  let meta={version:1,turnCounter:0,checkpointIds:[]},turnId,baseTools,captured=false,releaseMode=()=>{};const owner=Symbol('Apex feature mode');
  const persist=()=>pi.appendEntry(STATE,structuredClone(meta));
  const summary=ctx=>summarizer.summarize(ctx.sessionManager.getEntries(),{context:ctx.getContextUsage?.(),model:ctx.model,pricing:ctx.model?.cost,activeLeaf:ctx.sessionManager.getLeafId?.()??ctx.sessionManager.getBranch().at(-1)?.id??null});
  const updateCost=ctx=>{if(flags.has('cost')&&ctx.hasUI&&typeof ctx.ui?.setStatus==='function')ctx.ui.setStatus('apex-cost',accounting.formatCost(summary(ctx)));};
  // A turn that changed nothing leaves no record (checkpoints.finish reports 'unchanged'), so there is nothing to undo.
  const rememberCheckpoint=(id,finished)=>{if(finished?.status==='unchanged')return;if(!meta.checkpointIds.includes(id))meta.checkpointIds=[...meta.checkpointIds,id].slice(-50);persist();};
  const closeTurn=async()=>{if(checkpoints&&turnId&&captured)rememberCheckpoint(turnId,await checkpoints.finish(turnId));turnId=undefined;captured=false;};
  const command=(name,description,handler)=>pi.registerCommand(name,{description,async handler(args,ctx){try{return await handler(args,ctx);}catch(error){const r={ok:false,reason:reason(error)};notify(ctx,r.reason);return r;}}});
  const checkpointed=async(operation,ctx)=>{
   if(!checkpoints)return operation();
   meta.turnCounter++;persist();const id=String(meta.turnCounter);
   await checkpoints.capture(id,{signal:ctx.signal});
   try{return await operation();}finally{rememberCheckpoint(id,await checkpoints.finish(id));}
  };
  const initialize=async(_event,ctx)=>{
   await checkpoints?.shutdown();releaseMode();
   // Tree navigation has already moved the branch. Do not append old plan state into it.
   // Pi 1.4 restores the target branch's recorded loadout first; only undo our read-only loadout when
   // the target declares none, so Pi left it in place.
   if(plan?.isActive()&&baseTools&&!workflows.recordedToolNames(branchMessages(ctx)))pi.setActiveTools(baseTools);
   checkpoints=plan=learnings=safety=workflows=accounting=summarizer=undefined;turnId=undefined;captured=false;
   flags=new Set(parseFeatureFlags(pi.getFlag('apex-feature-flags')));evalMode=pi.getFlag('apex-eval')===true;
   meta={version:1,turnCounter:0,checkpointIds:[]};baseTools=undefined;
   if(!flags.size&&!evalMode)return;
   releaseMode=markFeatureMode(ctx,{owner,safety:flags.has('safety'),evalMode});
   if(!flags.size)return;
   // Pi's runner reports a rejected session_start and carries on, so a feature that throws must not cost the ones after it.
   // A safeguard installs a refusing stand-in and keeps its flag (tool_call skips everything without flags); others just drop theirs.
   const failures=[];
   const setup=async(name,run,refuse)=>{
    if(!flags.has(name))return;
    try{await run();}catch(error){
     let effect='it is off for this session';
     if(refuse)effect=refuse(error);else flags.delete(name);
     const message=`Apex feature ${name} failed to start; ${effect}: ${reason(error)}`;
     failures.push(message);notify(ctx,message,'error');
    }
   };
   // First: core stands down its own prompts once safety is marked above, and this depends on nothing below.
   await setup('safety',async()=>{safety=(safetyFactory??(await import('./safety.mjs')).createSafetyGate)({pi,evalMode});},error=>{safety=refusingSafety(error);return 'every tool call is blocked';});
   await setup('autocompact',()=>{autocompactTokens=parseAutocompactTokens(pi.getFlag('apex-autocompact-tokens'));});
   const branch=ctx.sessionManager.getBranch();const stored=latest(branch,STATE);
   if(stored?.version===1&&Number.isSafeInteger(stored.turnCounter)&&stored.turnCounter>=0)meta={version:1,turnCounter:stored.turnCounter,checkpointIds:Array.isArray(stored.checkpointIds)?stored.checkpointIds.filter(id=>typeof id==='string'&&/^\d+$/.test(id)).slice(-50):[]};
   const loadAccounting=async()=>{accounting??=await import('./accounting.mjs');summarizer??=accounting.createSessionSummarizer();};
   await setup('cost',async()=>{await loadAccounting();command('cost','Show Apex token and estimated cost totals',async(_args,ctx)=>{const r=summary(ctx);notify(ctx,accounting.formatCost(r));return r;});updateCost(ctx);});
   await setup('report',async()=>{await loadAccounting();command('report','Show this session token categories and largest consumers',async(_args,ctx)=>{const r=summary(ctx);notify(ctx,JSON.stringify({totals:r.totals,cost:r.cost,categories:r.categories,topConsumers:r.topConsumers,completeness:r.completeness}));return r;});});
   await setup('checkpoints',async()=>{
    // Registered first, so a failed setup still answers /undo with its reason.
    command('undo','Restore a completed Apex turn (optional turn ID)',async(args,ctx)=>{
     if(plan?.isActive()){const r={ok:false,reason:'Cancel or save the active plan before undo.'};notify(ctx,r.reason);return r;}
     await ctx.waitForIdle();await closeTurn();
     const entries=(await checkpoints.list({signal:ctx.signal})).filter(entry=>meta.checkpointIds.includes(entry.turnId));
     const id=args.trim()||[...entries].reverse().find(entry=>entry.status==='finished')?.turnId;
     if(!id||!entries.some(entry=>entry.turnId===id)){const r={ok:false,reason:'No finished checkpoint is available on the active branch.'};notify(ctx,r.reason);return r;}
     const r=await checkpoints.restore(id,{signal:ctx.signal});notify(ctx,`Turn ${id}: ${r.status}; ${r.changedPaths.length} paths.${r.skippedPaths?.length?` ${r.skippedPaths.length} files over the checkpoint size caps were not tracked and are unchanged.`:''}`);return r;
    });
    const factory=checkpointFactory??(await import('./checkpoints.mjs')).createCheckpointManager;
    const manager=factory({cwd:ctx.cwd,sessionId:ctx.sessionManager.getSessionId()});
    try{
     for(const entry of ctx.sessionManager.getEntries()){const state=entry.type==='custom'&&entry.customType===STATE?entry.data:entry.type==='compaction'?entry.details?.apexState?.[STATE]:undefined;if(Number.isSafeInteger(state?.turnCounter)&&state.turnCounter>=0)meta.turnCounter=Math.max(meta.turnCounter,state.turnCounter);}
     for(const entry of await manager.list()){if(/^\d+$/.test(entry.turnId)&&Number.isSafeInteger(Number(entry.turnId)))meta.turnCounter=Math.max(meta.turnCounter,Number(entry.turnId));}
    }catch(error){await manager.shutdown();throw error;}
    checkpoints=manager;
   },error=>{checkpoints=refusingCheckpoints(error);return 'mutating tools are blocked';});
   if(!evalMode)await setup('remember',async()=>{
    // Register before plan restoration so a restored prior loadout can include this tool.
    const {createLearnings}=await import('./learnings.mjs');const created=createLearnings({cwd:ctx.cwd,evalMode:false});pi.registerTool(created.tool());learnings=created;
   });
   await setup('plan',async()=>{
    workflows=await import('./workflows.mjs');
    baseTools=latest(branch,'apex-plan-state')?.tools??pi.getActiveTools();
    plan=workflows.createPlanManager({cwd:ctx.cwd,pi,policy,branch,recordedTools:workflows.recordedToolNames(branchMessages(ctx)),
     persist:entry=>pi.appendEntry(entry.customType,entry.data)});
    command('plan','Enter read-only planning, save literal Markdown, or cancel',async(args,ctx)=>{
     await ctx.waitForIdle();
     let r;
     if(args==='cancel')r=await plan.cancel(ctx);
     else if(args.startsWith('save '))r=await checkpointed(()=>plan.save(args.slice(5),ctx),ctx);
     else r=await plan.start(args.trim()||'Inspect the current project and write a concrete implementation plan.',ctx);
     notify(ctx,r.reason??(r.path?'Plan saved to PLAN.md; prior tools restored.':r.canceled?'Plan canceled; prior tools restored.':r.canceled===false?'Plan mode is not active.':'Plan mode updated.'));return r;
    });
   });
   await setup('review',async()=>{
    workflows=await import('./workflows.mjs');
    command('review','Independently verify the current diff',async(args,ctx)=>{
     await ctx.waitForIdle();const r=await workflows.runReview({cwd:ctx.cwd,task:args.trim()||'Verify the current changes against their requirements and check for regressions.',policy},ctx);
     notify(ctx,r.reason??r.result?.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n')??'Review completed.');return r;
    });
   });
   await setup('resume',()=>command('resume-info','Inspect the current session without replaying tools',async(args,ctx)=>{
    const file=args.trim()||ctx.sessionManager.getSessionFile?.();
    if(!file){const r={ok:false,replayPerformed:false,reason:'This in-memory session has no file to inspect.'};notify(ctx,r.reason);return r;}
    const {inspectResume}=await import('../../lib/session-report.mjs');const r=await inspectResume(file);
    notify(ctx,`${r.branchIds.length} entries; ${r.pendingTools.length} pending calls; inspection never replays tool side effects.`);return r;
   }));
   // Without a UI notify is a no-op: Pi's own error report (stderr in print mode) is the only way this reaches anyone.
   if(failures.length&&!ctx.hasUI)throw Error(failures.join('\n'));
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
   const r=event.outcome==='completed'&&event.continue!==true&&!event.context?.pendingMessages?.length?
    await checkpointed(()=>plan.finish(event,ctx),ctx):await plan.finish(event,ctx);
   // The outcome entry stays out of the model context; the user still needs to see where the plan went.
   const outcome=r?.entries?.find(entry=>entry.customType==='apex-plan-complete'||entry.customType==='apex-plan-error');
   if(outcome)notify(ctx,outcome.content);
   return r;
  });
  pi.on('agent_settled',async(_event,ctx)=>{
   await closeTurn();updateCost(ctx);
   // Settled means no retry, continuation or compaction is pending, so Pi's abort-first manual compaction loses no work.
   const usage=flags.has('autocompact')&&!plan?.isActive()?ctx.getContextUsage?.():undefined;
   if(usage?.tokens>autocompactTokens&&usage.contextWindow>autocompactTokens)ctx.compact({
    onComplete:()=>{notify(ctx,`Compacted at ${Math.round(usage.tokens/1000)}k context tokens.`);updateCost(ctx);},
    onError:error=>notify(ctx,'Autocompact failed: '+reason(error)),
   });
  });
  pi.on('session_shutdown',async(_event,ctx)=>{
   try{await closeTurn();await plan?.shutdown(ctx);}finally{releaseMode();await checkpoints?.shutdown();if(flags.has('cost')&&ctx.hasUI)ctx.ui?.setStatus?.('apex-cost',undefined);}
   flags=new Set();checkpoints=plan=learnings=safety=workflows=accounting=summarizer=undefined;turnId=undefined;captured=false;
  });
 };
}
export default createApexFeatures();
