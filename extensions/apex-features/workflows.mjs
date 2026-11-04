/** Native planning boundaries and guarded independent review. Factories perform no filesystem I/O. */
import path from 'node:path';
import {constants} from 'node:fs';
import {lstat,open,realpath,rename,unlink,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {SELECTED_MODEL} from '../apex-context/config.mjs';

const TYPE='apex-plan-state';
const fill=(template,values)=>template.replace(/\{(task|diff)\}/g,(whole,key)=>Object.hasOwn(values,key)?values[key]:whole);
const READ_TOOLS=Object.freeze(['read','grep','find','ls']);
const READ_SET=new Set(READ_TOOLS);
const PLAN_BYTES=128*1024;
const reasonOf=error=>String(error?.message??error).slice(0,1000);
const toolsValid=tools=>Array.isArray(tools)&&tools.length<=256&&tools.every(name=>typeof name==='string'&&name.length>0&&name.length<=100);
function checkSignal(signal){if(signal?.aborted){const error=Error('Operation aborted.');error.name='AbortError';throw error;}}
function assertPolicy(policy){
 if(policy?.paid_runs_enabled!==true||policy?.execution_policy!=='paid-enabled')throw Error('Model work is blocked by offline-only authorization.');
 if(policy.allowed_model!==SELECTED_MODEL)throw Error(`Model must be exactly ${SELECTED_MODEL}.`);
 if(policy.thinking_level!=='xhigh')throw Error('Thinking must be exactly xhigh.');
}
function assertPlanModel(ctx,pi){
 const model=ctx?.model;
 const physical=model?.provider==='openrouter'&&model.id==='meta/muse-spark-1.3-contributor'&&model.api!=='pi-virtual';
 const routed=model?.provider==='apex'&&model.id==='auto'&&model.api==='pi-virtual';
 if(!physical&&!routed)throw Error(`Planning requires ${SELECTED_MODEL} or the fixed Apex Muse router.`);
 if((ctx.thinkingLevel??pi.getThinkingLevel?.())!=='xhigh')throw Error('Planning requires xhigh thinking.');
}
async function fileIdentity(file){
 try{const info=await lstat(file);if(info.isSymbolicLink())throw Error('PLAN.md cannot be a symbolic link.');if(!info.isFile())throw Error('PLAN.md must be a regular file.');return {dev:info.dev,ino:info.ino,size:info.size,mtimeMs:info.mtimeMs};}
 catch(error){if(error.code==='ENOENT')return null;throw error;}
}
async function writePlan(cwd,markdown,signal){
 if(typeof markdown!=='string'||!markdown.trim()||Buffer.byteLength(markdown)>PLAN_BYTES||markdown.includes('\0'))throw Error('Plan must be nonempty literal Markdown of at most 128 KiB without NUL.');
 if(typeof cwd!=='string'||!path.isAbsolute(cwd))throw Error('Plan cwd must be an absolute path.');
 checkSignal(signal);const root=await realpath(cwd);const target=path.join(root,'PLAN.md');const previous=await fileIdentity(target);
 const temporary=path.join(root,`.apex-plan-${randomUUID()}.tmp`);let handle;
 try{
  handle=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);
  await handle.writeFile(markdown,'utf8');await handle.sync();await handle.close();handle=undefined;checkSignal(signal);
  if(await realpath(cwd)!==root)throw Error('Plan directory changed during save.');
  if(JSON.stringify(await fileIdentity(target))!==JSON.stringify(previous))throw Error('PLAN.md changed during save; refusing to overwrite a concurrent change.');
  await rename(temporary,target);return path.join(cwd,'PLAN.md');
 }finally{await handle?.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
const planStateOf=entry=>entry?.type==='custom'&&entry.customType===TYPE?entry.data:entry?.type==='compaction'?entry.details?.apexState?.[TYPE]:undefined;
const sameSet=(left,right)=>left.length===right.length&&left.every(name=>right.includes(name));
/**
 * Tool names the branch declares, folded like Pi's getCurrentTools(): Pi's agent loop records the
 * active-tool delta as a system message before each model request, and resume or /tree replays every
 * one on the branch, including those before a compaction (Pi 1.4.0 _restoreToolsFromTranscript).
 * Undefined when the branch declares no tools, in which case Pi leaves the loadout alone.
 */
export function recordedToolNames(messages){
 let tools;
 for(const message of messages??[]){
  if(message?.role!=='system'||(!message.toolsAdded&&!message.toolsRemoved))continue;
  tools??=new Set();
  for(const tool of message.toolsRemoved??[])tools.delete(tool.name);
  for(const tool of message.toolsAdded??[])tools.add(tool.name);
 }
 return tools&&[...tools];
}
function restoredState(branch){
 let found;let index=-1;let loadout=-1;
 (branch??[]).forEach((entry,position)=>{
  const candidate=planStateOf(entry);
  if(candidate!==undefined){found=candidate;index=position;}
  // Pi records each tool-loadout change as a system message before the next model request.
  if(entry?.type==='message'&&entry.message?.role==='system'&&(entry.message.toolsAdded||entry.message.toolsRemoved))loadout=position;
 });
 if(found?.version===1&&typeof found.active==='boolean'&&typeof found.task==='string'&&found.task.length<=20000&&toolsValid(found.tools)&&toolsValid(found.readTools??READ_TOOLS))
  return {state:{...structuredClone(found),readTools:structuredClone(found.readTools??READ_TOOLS)},loadoutStale:loadout<index};
 return {state:{version:1,active:false,task:'',tools:[],readTools:[...READ_TOOLS]},loadoutStale:false};
}

/**
 * persist accepts a detached {customType,data} entry; callers adapt it to pi.appendEntry().
 * recordedTools: recordedToolNames() of the branch messages Pi restored the loadout from.
 */
export function createPlanManager({cwd,pi,persist=()=>{},branch=[],recordedTools,policy}={}){
 const restored=restoredState(branch);let state=restored.state;let queue=Promise.resolve();
 const serial=operation=>{const next=queue.then(operation);queue=next.catch(()=>{});return next;};
 const record=()=>persist({customType:TYPE,data:structuredClone(state)});
 const result=(ok,extra={})=>({ok,active:state.active,...extra});
 // Reconstruct the model loadout as well as the gate when resuming an active branch.
 if(state.active)pi.setActiveTools([...state.readTools]);
 // A saved/cancelled plan restores its prior tools, but Pi records that only before the next model
 // request. Resuming before then, Pi restores the plan's read-only declarations: reinstate the prior
 // tools, keeping tools other extensions activated since, but not the plan's extra read tools.
 else if(state.tools.length&&restored.loadoutStale&&recordedTools&&sameSet(recordedTools,state.readTools))
  pi.setActiveTools([...new Set([...state.tools,...pi.getActiveTools().filter(name=>!state.readTools.includes(name))])]);
 const restore=async()=>{
  const previous=[...state.tools];state.active=false;state.restorationPending=true;let failure;
  try{pi.setActiveTools(previous);state.restorationPending=false;}catch(error){failure=error;}
  try{await record();}catch(error){state.restorationPending=true;failure??=error;}
  if(failure)throw failure;
 };
 const save=async(markdown,ctx)=>{
  if(!state.active)return result(false,{reason:'No plan is active.'});
  let planPath;let failure;
  try{planPath=await writePlan(cwd,markdown,ctx?.signal);}catch(error){failure=error;}
  try{await restore();}catch(error){failure??=error;}
  return result(!failure,{...(planPath?{path:planPath}:{}),...(failure?{reason:reasonOf(failure)}:{})});
 };
 return {
  isActive:()=>state.active,
  gate(event){if(state.active&&!READ_SET.has(event?.toolName))return {block:true,reason:'Plan mode permits only read, grep, find and ls; nested and deferred calls use the same rule.'};},
  start(task,ctx){return serial(async()=>{
   if(state.active)return result(false,{reason:'A plan is already active; save or cancel it first.'});
   try{
    if(state.restorationPending)await restore();
    if(typeof task!=='string'||!task.trim()||task.length>20000)throw Error('Plan task must be a nonempty string of at most 20000 characters.');
    const prior=pi.getActiveTools();if(!toolsValid(prior))throw Error('Invalid active tool selection.');
    state={version:1,active:true,id:randomUUID(),task,tools:[...prior],readTools:[...READ_TOOLS],restorationPending:false};
    pi.setActiveTools([...state.readTools]);await record();
    // Entering the offline mode is useful on its own. Sending a user message ALWAYS allocates a turn.
    if(policy?.paid_runs_enabled===true||policy?.execution_policy==='paid-enabled'){
     assertPolicy(policy);checkSignal(ctx?.signal);assertPlanModel(ctx,pi);
     const prompt=await readFile(new URL('../../templates/apex-plan.md',import.meta.url),'utf8');
     assertPolicy(policy);checkSignal(ctx?.signal);assertPlanModel(ctx,pi);
     await pi.sendUserMessage(fill(prompt,{task}),{expandPromptTemplates:false});
     return result(true,{prompted:true});
    }
    return result(true,{prompted:false,reason:'Plan mode is active with read-only tools; /plan itself started no model request. Your next message is planned without changes and its final answer is saved to PLAN.md. /plan save MARKDOWN saves your own text instead; /plan cancel exits.'});
   }catch(error){let reason=reasonOf(error);if(state.active)try{await restore();}catch(cleanup){reason+=`; restoration failed: ${reasonOf(cleanup)}`;}return result(false,{reason});}
  });},
  save:(markdown,ctx)=>serial(()=>save(markdown,ctx)),
  cancel:ctx=>serial(async()=>{if(!state.active&&!state.restorationPending)return result(true,{canceled:false});try{await restore();return result(true,{canceled:true});}catch(error){return result(false,{reason:reasonOf(error)});}}),
  shutdown:ctx=>serial(async()=>{if(!state.active&&!state.restorationPending)return result(true);try{await restore();return result(true);}catch(error){return result(false,{reason:reasonOf(error)});}}),
  finish(event,ctx){return serial(async()=>{
   const response={entries:[...(event?.entries??[])]};if(!state.active)return response;
   if(event?.outcome==='completed'&&(event.continue===true||event.context?.pendingMessages?.length))return response;
   if(event?.outcome!=='completed'){
    let reason=`Planning ended with ${event?.outcome??'an unknown outcome'}; PLAN.md was not saved.`;
    try{await restore();}catch(error){reason+=` Restoration failed: ${reasonOf(error)}`;}
    response.entries.push({type:'custom_message',customType:'apex-plan-error',content:reason,display:false});return response;
   }
   const currentBranch=ctx?.sessionManager?.getBranch?.();let marker=-1;
   for(let index=0;index<(currentBranch?.length??0);index++){
    const entry=currentBranch[index];const data=entry?.type==='custom'&&entry.customType===TYPE?entry.data:entry?.type==='compaction'?entry.details?.apexState?.[TYPE]:undefined;
    if(data?.active===true&&(state.id?data.id===state.id:data.task===state.task))marker=index;
   }
   // A previous task's final assistant is not planning output. The persistent marker
   // survives reload and compaction and confines completion to this active branch.
   const messages=currentBranch?currentBranch.slice(marker+1).filter(entry=>entry?.type==='message').map(entry=>entry.message):event.context?.contextMessages??[];
   const final=[...messages].reverse().find(message=>message?.role==='assistant');
   const text=final?.content?.filter(part=>part?.type==='text'&&typeof part.text==='string').map(part=>part.text).join('\n');
   const invalid=marker<0&&currentBranch||['error','aborted','toolUse'].includes(final?.stopReason)||final?.content?.some(part=>part.type==='toolCall');
   const saved=await save(invalid?'':text,ctx);
   response.entries.push({type:'custom_message',customType:saved.ok?'apex-plan-complete':'apex-plan-error',content:saved.ok?'Plan saved to PLAN.md; prior tools restored.':`Plan was not completed: ${saved.reason}`,display:false,details:saved});return response;
  });},
 };
}

function currentDiff(cwd,signal){
 checkSignal(signal);
 return new Promise((resolve,reject)=>{
  const env={PATH:process.env.PATH,LANG:'C',LC_ALL:'C',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
  const child=spawn('git',['--no-pager','diff','--no-ext-diff','--no-textconv','--no-color','HEAD','--','.'],{cwd,env,stdio:['ignore','pipe','pipe']});
  const chunks=[];let bytes=0;let truncated=false;let stderr='';let failure;
  const stop=()=>{failure=Error('Review diff capture aborted.');child.kill('SIGTERM');};
  const timer=setTimeout(()=>{failure=Error('Review diff capture exceeded its 5 second bound.');child.kill('SIGTERM');},5000);
  signal?.addEventListener('abort',stop,{once:true});
  child.stdout.on('data',chunk=>{const remaining=12000-bytes;if(remaining>0){const part=chunk.subarray(0,remaining);chunks.push(part);bytes+=part.length;}if(chunk.length>remaining)truncated=true;});
  child.stderr.on('data',chunk=>{if(stderr.length<1000)stderr+=chunk.toString().slice(0,1000-stderr.length);});
  child.on('error',error=>{failure=error;});
  child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);if(failure)return reject(failure);if(code!==0)return reject(Error(`Current Git diff is unavailable: ${stderr.trim()}`));resolve({text:Buffer.concat(chunks).toString('utf8').replace(/\ufffd$/,''),truncated});});
 });
}

/** verify(request,ctx) is injectable; default delegates to Phase 2's guarded native verify definition. */
export async function runReview(options,ctx){
 try{assertPolicy(options?.policy);}catch(error){return {ok:false,blocked:true,reason:reasonOf(error)};}
 try{
  checkSignal(ctx?.signal);const cwd=options.cwd;const task=options.task;
  if(typeof cwd!=='string'||!path.isAbsolute(cwd))throw Error('Review cwd must be an absolute path.');
  if(typeof task!=='string'||!task.trim()||Buffer.byteLength(task)>6000)throw Error('Review task must be nonempty and at most 6000 bytes.');
  const diff=await currentDiff(cwd,ctx?.signal);assertPolicy(options.policy);checkSignal(ctx?.signal);
  const template=await readFile(new URL('../../templates/apex-review.md',import.meta.url),'utf8');
  const request={cwd,task:fill(template,{task,diff:diff.text||'(No tracked staged or unstaged changes.)'})+(diff.truncated?'\n\nDiff truncated at 12000 bytes; assess only the available evidence.':''),commands:[],signal:ctx?.signal,policy:options.policy};
  assertPolicy(options.policy);checkSignal(ctx?.signal);
  let verify=options.verify;
  if(!verify){const {createSubagentTools}=await import('../apex-core/models.mjs');const tool=createSubagentTools({policy:options.policy}).find(tool=>tool.name==='verify');verify=(request,ctx)=>tool.execute('apex-review',{task:request.task,commands:[]},request.signal,undefined,{...ctx,cwd:request.cwd});}
  assertPolicy(options.policy);checkSignal(ctx?.signal);const result=await verify(request,ctx);
  const blocked=result?.details?.status==='blocked';
  const text=Array.isArray(result?.content)?result.content.filter(part=>part?.type==='text'&&typeof part.text==='string').map(part=>part.text).join('\n'):'';
  const ok=result?.isError!==true&&result?.details?.status==='complete'&&text.trim().length>0;
  return {ok,blocked,result,...(!ok?{reason:text||'Independent review did not return complete native verification evidence.'}:{})};
 }catch(error){return {ok:false,blocked:/offline-only authorization|Model must be exactly|Thinking must be exactly/.test(reasonOf(error)),reason:reasonOf(error)};}
}
