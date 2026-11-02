import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {createApexFeatures} from '../extensions/apex-features/index.mjs';
import {createApexCore} from '../extensions/apex-core/index.mjs';
function fixture(flags='',evalMode=false){
 const hooks=new Map(),commands=new Map(),tools=[],branch=[];let active=['read','write','edit','bash'];
 const values={'apex-feature-flags':flags,'apex-eval':evalMode};
 const pi={registerFlag(n,o){if(!(n in values))values[n]=o.default;},getFlag:n=>values[n],on(n,h){const a=hooks.get(n)??[];a.push(h);hooks.set(n,a);},registerCommand(n,c){commands.set(n,c);},registerTool:t=>tools.push(t),getActiveTools:()=>[...active],setActiveTools:a=>{active=[...a];},getAllTools:()=>tools,appendEntry(customType,data){branch.push({type:'custom',id:String(branch.length),customType,data});},getThinkingLevel:()=> 'xhigh'};
 const ctx={cwd:process.cwd(),mode:'print',hasUI:false,sessionManager:{getBranch:()=>structuredClone(branch),getEntries:()=>structuredClone(branch),getSessionId:()=> 'fixture'},isIdle:()=>true,ui:{notify(){},setStatus(){}},waitForIdle:async()=>{},getContextUsage:()=>undefined};
 const emit=async(n,e={})=>{let result;for(const h of hooks.get(n)??[])result=await h(e,ctx)??result;return result;};
 return {pi,ctx,branch,commands,tools,emit,values};
}
test('default features startup and shutdown are completely inert',async()=>{
 const h=fixture();createApexFeatures()(h.pi);
 h.ctx.sessionManager=new Proxy({}, {get(){throw Error('default session access');}});
 await h.emit('session_start');assert.equal(h.commands.size,0);assert.equal(h.tools.length,0);
 assert.equal(await h.emit('resources_discover'),undefined);assert.equal(await h.emit('before_agent_start',{systemPromptOptions:{contextFiles:[]}}),undefined);
 await h.emit('session_shutdown');await h.emit('session_shutdown');assert.equal(h.branch.length,0);
});
test('selected cost exposes native status/report without model work',async()=>{
 const h=fixture('cost,report');createApexFeatures()(h.pi);await h.emit('session_start');
 assert.deepEqual([...h.commands.keys()],['cost','report']);
 const s=await h.commands.get('cost').handler('',h.ctx);assert.equal(s.cost.label,'estimate, not invoice');
 assert.equal(h.tools.length,0);assert.equal(await h.emit('resources_discover'),undefined);
});
test('cost status and commands equal a full summary across turns, repricing, model switches and tree navigation',async()=>{
 const {summarizeSession,formatCost}=await import('../extensions/apex-features/accounting.mjs');
 const h=fixture('cost,report');h.ctx.hasUI=true;const statuses=[];h.ctx.ui.setStatus=(key,text)=>statuses.push([key,text]);
 // Pi hands out its own entry objects in a fresh array on every call.
 let entries=[];h.ctx.sessionManager.getEntries=()=>[...entries];h.ctx.sessionManager.getLeafId=()=>entries.at(-1)?.id??null;
 h.ctx.model={provider:'fixture',id:'model',contextWindow:1000,cost:{input:1,output:2,cacheRead:0.1,cacheWrite:0.5}};
 h.ctx.getContextUsage=()=>({tokens:entries.length*10,contextWindow:1000});
 const full=()=>summarizeSession(entries,{context:h.ctx.getContextUsage(),model:h.ctx.model,pricing:h.ctx.model?.cost,activeLeaf:entries.at(-1)?.id??null});
 const status=()=>['apex-cost',formatCost(full())];
 const turn=n=>{const usage={input:n+1,output:4,cacheRead:2,cacheWrite:1,totalTokens:n+8};
  entries.push({type:'message',id:`a${n}`,parentId:entries.at(-1)?.id??null,message:{role:'assistant',provider:'fixture',model:'model',usage,stopReason:'toolUse',responseId:`r${n}`,content:[{type:'text',text:'x'.repeat(n*10)}]}},
   {type:'message',id:`t${n}`,parentId:`a${n}`,message:{role:'toolResult',content:[{type:'text',text:'y'.repeat(n*20)}]}});};
 createApexFeatures()(h.pi);await h.emit('session_start');assert.deepEqual(statuses.at(-1),status());
 for(let n=0;n<8;n++){
  // An extraction stays unaccounted until its helper record lands two turns later.
  if(n===2)entries.push({type:'custom',id:'s',parentId:entries.at(-1).id,customType:'apex-task-state',data:{taskId:'task-1',extraction:{attempted:true,usage:{}}}});
  if(n===3)h.ctx.model.cost.output=4;
  if(n===4)entries.push({type:'custom',id:'h',parentId:entries.at(-1).id,customType:'apex-helper-usage',data:{version:1,requestId:'task-1:contract:1',taskId:'task-1',kind:'contract',provider:'fixture',model:'model',usage:{input:7,output:2,cacheRead:0,cacheWrite:0,totalTokens:9},complete:true,status:'complete'}});
  if(n===5)h.ctx.model={...h.ctx.model,id:'model-2'};
  if(n===6){h.ctx.model={provider:'other',id:'m2',contextWindow:2000,cost:{input:9,output:9,cacheRead:1,cacheWrite:1}};entries.push({type:'model_change',id:'m',parentId:entries.at(-1).id,provider:'other',modelId:'m2'});}
  turn(n);await h.emit('turn_end');assert.deepEqual(statuses.at(-1),status());
  await h.emit('agent_settled');assert.deepEqual(statuses.at(-1),status());
  assert.deepEqual(await h.commands.get('cost').handler('',h.ctx),full());
 }
 assert.deepEqual(await h.commands.get('report').handler('',h.ctx),full());
 // Tree navigation re-initializes; the branch is then seen through other entry objects.
 entries=structuredClone(entries.slice(0,11));await h.emit('session_tree');assert.deepEqual(statuses.at(-1),status());
 assert.deepEqual(await h.commands.get('cost').handler('',h.ctx),full());
 await h.emit('session_shutdown');assert.deepEqual(statuses.at(-1),['apex-cost',undefined]);
});
test('plan gates any nested/deferred mutator, retains readonly and cancels tools',async()=>{
 const h=fixture('plan');createApexFeatures()(h.pi);await h.emit('session_start');
 const r=await h.commands.get('plan').handler('inspect this project',h.ctx);assert.equal(r.active,true);assert.equal(r.prompted,false);
 assert.equal((await h.emit('tool_call',{toolName:'codemode',input:{},parentToolCallId:'p'})).block,true);
 assert.equal(await h.emit('tool_call',{toolName:'read',input:{}}),undefined);
 await h.commands.get('plan').handler('cancel',h.ctx);assert.deepEqual(h.pi.getActiveTools(),['read','write','edit','bash']);
});
test('eval remember never creates tool or accesses learning cwd',async()=>{
 const h=fixture('remember',true);Object.defineProperty(h.ctx,'cwd',{get(){throw Error('eval cwd accessed');}});
 createApexFeatures()(h.pi);await h.emit('session_start');assert.equal(h.tools.length,0);
 assert.equal(await h.emit('before_agent_start',{systemPromptOptions:{contextFiles:[]}}),undefined);
});
test('skills discovery is explicit and excludes shared scanner/templates',async()=>{
 const h=fixture('skills');createApexFeatures()(h.pi);await h.emit('session_start');const r=await h.emit('resources_discover');
 assert.equal(r.skillPaths.length,10);assert.equal(r.promptPaths,undefined);assert.ok(r.skillPaths.every(p=>path.basename(p)==='SKILL.md'));
});
test('core todo and verification do not force planning continuations',async()=>{
 const h=fixture('plan');h.values['apex-core-flags']='todo,verify';createApexCore()(h.pi);createApexFeatures()(h.pi);await h.emit('session_start');
 await h.commands.get('plan').handler('study entry point',h.ctx);
 const boundary={outcome:'completed',entries:[],context:{canContinue:true,pendingMessages:[]}};
 await h.emit('before_agent_start',{messageType:'user',prompt:'plan',systemPromptOptions:{sections:{}}});
 assert.notEqual((await h.emit('turn_end',{...boundary,turnIndex:1,toolResults:[]}))?.continue,true);
 // An error restores the active tools and persists a concrete planning failure.
 const settled=await h.emit('agent_before_settle',{...boundary,outcome:'error'});assert.notEqual(settled?.continue,true);assert.deepEqual(h.pi.getActiveTools(),['read','write','edit','bash']);
});

test('checkpoint hooks skip untouched turns and close one capture after sibling calls',async()=>{
 const h=fixture('checkpoints');const events=[];let captured=false;
 createApexFeatures({checkpointFactory:()=>({capture:async id=>{events.push('capture:'+id);captured=true;},finish:async id=>{assert.equal(captured,true);events.push('finish:'+id);captured=false;},shutdown:async()=>{},list:async()=>[]})})(h.pi);
 // codemode alone never captures; the mutating calls its script makes do.
 await h.emit('session_start');await h.emit('turn_start');await h.emit('tool_call',{toolName:'read'});await h.emit('tool_call',{toolName:'codemode'});await h.emit('turn_end');assert.deepEqual(events,[]);
 await h.emit('turn_start');await Promise.all([h.emit('tool_call',{toolName:'write'}),h.emit('tool_call',{toolName:'edit'}),h.emit('tool_call',{toolName:'bash',parentToolCallId:'codemode-1'})]);await h.emit('turn_end');
 assert.deepEqual(events,['capture:2','capture:2','capture:2','finish:2']);await h.emit('agent_settled');assert.equal(events.length,4);
});
test('checkpoint capture failure blocks mutation and does not finish missing state',async()=>{
 const h=fixture('checkpoints');createApexFeatures({checkpointFactory:()=>({capture:async()=>{throw Error('bounded failure');},list:async()=>[],finish:async()=>{throw Error('must not finish');},shutdown:async()=>{}})})(h.pi);
 await h.emit('session_start');await h.emit('turn_start');const r=await h.emit('tool_call',{toolName:'write'});assert.equal(r.block,true);assert.match(r.reason,/bounded failure/);
 // Session-state tools never touch the working tree, so a failed capture cannot block them.
 for(const toolName of ['todo','contract'])assert.equal(await h.emit('tool_call',{toolName}),undefined);await h.emit('turn_end');
});
test('tree navigation restores base tools without old plan writes into new branch',async()=>{
 const h=fixture('plan');createApexFeatures()(h.pi);await h.emit('session_start');await h.commands.get('plan').handler('inspect',h.ctx);
 h.branch.length=0;await h.emit('session_tree');assert.deepEqual(h.pi.getActiveTools(),['read','write','edit','bash']);assert.equal(h.branch.length,0);
});
test('tree navigation keeps the loadout Pi replayed from a compacted target branch',async()=>{
 const h=fixture('plan');createApexFeatures()(h.pi);await h.emit('session_start');await h.commands.get('plan').handler('inspect',h.ctx);
 // The target declares its tools only before its compaction, which carries no loadout snapshot.
 const tool=name=>({name,description:name,parameters:{}});
 h.branch.length=0;h.branch.push({type:'message',id:'s',message:{role:'system',content:'',toolsAdded:['read','grep','todo'].map(tool)}},{type:'compaction',id:'c',summary:'earlier work',firstKeptEntryId:'c',tokensBefore:1});
 h.pi.setActiveTools(['read','grep','todo']);await h.emit('session_tree');
 assert.deepEqual(h.pi.getActiveTools(),['read','grep','todo']);
});

test('checkpoint turn IDs remain unique across tree navigation and undo stays on active branch',async()=>{
 const h=fixture('checkpoints');const all=[],records=[];const append=h.pi.appendEntry;
 h.pi.appendEntry=(type,data)=>{append(type,data);all.push(structuredClone(h.branch.at(-1)));};
 h.ctx.sessionManager.getEntries=()=>structuredClone(all);
 const capturedIds=[];createApexFeatures({checkpointFactory:()=>({capture:async id=>{capturedIds.push(id);if(!records.some(r=>r.turnId===id))records.push({turnId:id,status:'captured',changedPaths:[]});},finish:async id=>{const r=records.find(r=>r.turnId===id);r.status='finished';return r;},shutdown:async()=>{},list:async()=>structuredClone(records),restore:async id=>({turnId:id,status:'restored',changedPaths:[]})})})(h.pi);
 await h.emit('session_start');await h.emit('turn_start');await h.emit('tool_call',{toolName:'write'});await h.emit('turn_end');
 h.branch.length=0;await h.emit('session_tree');const noUndo=await h.commands.get('undo').handler('',h.ctx);assert.equal(noUndo.ok,false);
 await h.emit('turn_start');await h.emit('tool_call',{toolName:'write'});await h.emit('turn_end');assert.deepEqual(capturedIds,['1','2']);
 const rejected=await h.commands.get('undo').handler('1',h.ctx);assert.equal(rejected.ok,false);
 assert.equal((await h.commands.get('undo').handler('',h.ctx)).turnId,'2');
});

test('native extension-local flag scoping still shares eval/safety ownership',async()=>{
 const h=fixture('safety');h.values['apex-core-flags']='correct';h.ctx.mode='tui';h.ctx.hasUI=true;
 const scoped=()=>{const declared=new Set();return {...h.pi,registerFlag(n,o){declared.add(n);h.pi.registerFlag(n,o);},getFlag:n=>declared.has(n)?h.values[n]:undefined};};
 const previous=Object.getOwnPropertyDescriptor(process.stdout,'isTTY');Object.defineProperty(process.stdout,'isTTY',{value:true,configurable:true});let confirmations=0;h.ctx.ui.confirm=async()=>{confirmations++;return false;};
 try{createApexCore()(scoped());createApexFeatures()(scoped());await h.emit('session_start');
  const r=await h.emit('tool_call',{toolName:'bash',input:{command:'rm -rf /'},toolCallId:'danger'});assert.equal(r.block,true);assert.equal(confirmations,1);
  await h.emit('session_shutdown');
 }finally{previous?Object.defineProperty(process.stdout,'isTTY',previous):delete process.stdout.isTTY;}
});

test('scoped native flags preserve Phase 1 edits when core corrections are enabled',async()=>{
 const {default:contextFactory}=await import('../extensions/apex-context/index.mjs');
 const h=fixture();h.values['apex-context-flags']='edit';h.values['apex-core-flags']='correct';
 const scoped=()=>{const names=new Set();return {...h.pi,registerFlag(n,o){names.add(n);h.pi.registerFlag(n,o);},getFlag:n=>names.has(n)?h.values[n]:undefined};};
 contextFactory(scoped());createApexCore()(scoped());await h.emit('session_start');
 const edit=h.tools.filter(t=>t.name==='edit').at(-1);assert.ok(edit.parameters.properties.edits.items.properties.old_string);
 await h.emit('session_shutdown');
});

test('future authorized planning fills task placeholder with literal dollar replacement syntax',async()=>{
 const h=fixture('plan');let prompted;
 h.pi.sendUserMessage=async text=>{prompted=text;};h.ctx.model={provider:'openrouter',id:'meta/muse-spark-1.3-contributor',api:'openai-completions'};
 const policy={allowed_model:'openrouter/meta/muse-spark-1.3-contributor',thinking_level:'xhigh',paid_runs_enabled:true,execution_policy:'paid-enabled'};
 createApexFeatures({policy})(h.pi);await h.emit('session_start');const task='Inspect literal $& and $$ replacement strings.';
 const r=await h.commands.get('plan').handler(task,h.ctx);assert.equal(r.prompted,true);assert.ok(prompted.includes(task));await h.emit('session_shutdown');
});
test('autocompact compacts a settled session past 300k context tokens, once per settle and never below it',async()=>{
 const h=fixture('autocompact');createApexFeatures()(h.pi);await h.emit('session_start');
 const calls=[];h.ctx.compact=options=>calls.push(options);
 for(const usage of [undefined,{tokens:null,contextWindow:1_000_000},{tokens:300_000,contextWindow:1_000_000},{tokens:310_000,contextWindow:272_000}]){
  h.ctx.getContextUsage=()=>usage;await h.emit('agent_settled');
 }
 assert.equal(calls.length,0,'unknown, at-threshold and small-window usage leave compaction to Pi');
 h.ctx.getContextUsage=()=>({tokens:300_001,contextWindow:1_000_000});await h.emit('agent_settled');
 assert.equal(calls.length,1);assert.equal(typeof calls[0].onComplete,'function');assert.equal(typeof calls[0].onError,'function');
 const off=fixture('cost');createApexFeatures()(off.pi);await off.emit('session_start');off.ctx.compact=()=>assert.fail('not selected');
 off.ctx.getContextUsage=()=>({tokens:900_000,contextWindow:1_000_000});await off.emit('agent_settled');
});
test('autocompact compacts at a custom threshold and keeps the model-window rule',async()=>{
 const h=fixture('autocompact');h.values['apex-autocompact-tokens']='200000';createApexFeatures()(h.pi);await h.emit('session_start');
 const calls=[];h.ctx.compact=options=>calls.push(options);
 for(const usage of [{tokens:200_000,contextWindow:1_000_000},{tokens:250_000,contextWindow:200_000}]){h.ctx.getContextUsage=()=>usage;await h.emit('agent_settled');}
 assert.equal(calls.length,0);
 h.ctx.getContextUsage=()=>({tokens:200_001,contextWindow:272_000});await h.emit('agent_settled');
 assert.equal(calls.length,1,'below the 300k default, past the custom threshold');
});

// A UI session, so the safety gate is live and notifications are the channel a failure reports through.
const interactive=h=>{const notes=[];h.ctx.mode='tui';h.ctx.hasUI=true;h.ctx.ui.notify=(message,level)=>notes.push({message,level});return notes;};
const refused=()=>{throw Error('refused helper');};
const brokenCheckpoints={
 'its factory throws':()=>({checkpointFactory:refused,shutdowns:0}),
 'list() rejects':events=>({checkpointFactory:()=>({list:async()=>refused(),capture:async()=>events.push('capture'),finish:async()=>events.push('finish'),shutdown:async()=>events.push('shutdown')}),shutdowns:1}),
};
for(const [cause,fault] of Object.entries(brokenCheckpoints))test(`a checkpoint setup where ${cause} leaves later features registered and mutations blocked`,async()=>{
 const h=fixture('cost,checkpoints,remember,plan,review,safety,resume');const notes=interactive(h);const events=[];let confirmations=0;h.ctx.ui.confirm=async()=>{confirmations++;return true;};
 const {checkpointFactory,shutdowns}=fault(events);createApexFeatures({checkpointFactory})(h.pi);await h.emit('session_start');
 assert.equal(notes.length,1);assert.equal(notes[0].level,'error');assert.match(notes[0].message,/checkpoints.*refused helper/);
 assert.deepEqual(['cost','undo','plan','review','resume-info'].filter(name=>!h.commands.has(name)),[]);assert.ok(h.tools.some(tool=>tool.name==='remember'));
 await h.emit('turn_start');const blocked=await h.emit('tool_call',{toolName:'write',input:{}});
 assert.equal(blocked.block,true);assert.equal(blocked.reason,'Checkpoint failed; mutation blocked: refused helper');assert.equal(confirmations,1,'the safety gate decides first');
 assert.equal(await h.emit('tool_call',{toolName:'read',input:{}}),undefined);
 await h.emit('turn_end');await h.emit('agent_settled');
 const undo=await h.commands.get('undo').handler('',h.ctx);assert.equal(undo.ok,false);assert.equal(undo.reason,'refused helper');
 await h.emit('session_shutdown');assert.deepEqual(events,Array(shutdowns).fill('shutdown'),'the half-made manager is only released');
});
test('a session without UI hears of a failed feature from Pi, after later features registered',async()=>{
 const h=fixture('checkpoints,plan,resume');createApexFeatures({checkpointFactory:refused})(h.pi);
 await assert.rejects(h.emit('session_start'),/checkpoints.*refused helper/);
 assert.ok(h.commands.has('plan'));assert.ok(h.commands.has('resume-info'));assert.equal((await h.emit('tool_call',{toolName:'write',input:{}})).block,true);
});
test('tree navigation retries a failed checkpoint setup',async()=>{
 const h=fixture('checkpoints');const notes=interactive(h);const events=[];let broken=true;
 createApexFeatures({checkpointFactory:()=>{if(broken)refused();return {list:async()=>[],capture:async id=>events.push('capture:'+id),finish:async id=>events.push('finish:'+id),shutdown:async()=>{}};}})(h.pi);
 await h.emit('session_start');assert.equal((await h.emit('tool_call',{toolName:'write',input:{}})).block,true);assert.equal(notes.length,1);
 broken=false;await h.emit('session_tree');await h.emit('turn_start');assert.equal(await h.emit('tool_call',{toolName:'write',input:{}}),undefined);await h.emit('turn_end');
 assert.equal(notes.length,1);assert.equal(events.length,2);assert.match(events[0],/^capture:/);assert.match(events[1],/^finish:/);
});
test('a failed checkpoint setup refuses a plan write and leaves the plan cancellable',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'apex-failed-checkpoints-'));
 try{
  const h=fixture('checkpoints,plan');interactive(h);h.ctx.cwd=dir;createApexFeatures({checkpointFactory:refused})(h.pi);await h.emit('session_start');
  await h.commands.get('plan').handler('inspect',h.ctx);const saved=await h.commands.get('plan').handler('save # Plan',h.ctx);
  assert.equal(saved.ok,false);assert.equal(saved.reason,'refused helper');
  await assert.rejects(h.emit('agent_before_settle',{outcome:'completed',entries:[],context:{pendingMessages:[]}}),/refused helper/);
  assert.equal(existsSync(path.join(dir,'PLAN.md')),false);assert.equal((await h.commands.get('plan').handler('cancel',h.ctx)).canceled,true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
for(const flags of ['safety','safety,resume'])test(`a safety gate that cannot start blocks every tool with flags ${flags}`,async()=>{
 const h=fixture(flags);const notes=interactive(h);createApexFeatures({safetyFactory:()=>{throw Error('gate missing');}})(h.pi);await h.emit('session_start');
 assert.equal(notes.length,1);assert.equal(notes[0].level,'error');assert.match(notes[0].message,/safety.*gate missing/);
 for(const toolName of ['read','write','bash','codemode']){const r=await h.emit('tool_call',{toolName,input:{}});assert.equal(r.block,true);assert.match(r.reason,/gate missing/);}
 assert.equal(h.commands.has('resume-info'),flags.includes('resume'));
});
test('a failed cost status costs only the status: later features, turn hooks and autocompact keep working',async()=>{
 const h=fixture('cost,report,autocompact,plan');const notes=interactive(h);const compactions=[];h.ctx.compact=options=>compactions.push(options);let failing=true;
 h.ctx.getContextUsage=()=>{if(failing)throw Error('usage unavailable');return {tokens:300_001,contextWindow:1_000_000};};
 createApexFeatures()(h.pi);await h.emit('session_start');
 assert.equal(notes.length,1);assert.match(notes[0].message,/cost.*usage unavailable/);assert.ok(h.commands.has('report'));assert.ok(h.commands.has('plan'));
 await h.emit('turn_end');failing=false;await h.emit('agent_settled');assert.equal(compactions.length,1);
});
test('an invalid autocompact threshold costs only autocompact',async()=>{
 const h=fixture('autocompact,safety');const notes=interactive(h);h.values['apex-autocompact-tokens']='many';h.ctx.ui.confirm=async()=>false;h.ctx.compact=()=>assert.fail('off');
 h.ctx.getContextUsage=()=>({tokens:900_000,contextWindow:1_000_000});createApexFeatures()(h.pi);await h.emit('session_start');
 assert.equal(notes.length,1);assert.match(notes[0].message,/autocompact.*whole number/);
 assert.equal((await h.emit('tool_call',{toolName:'write',input:{}})).reason,'Tool action was not confirmed.');await h.emit('agent_settled');
});
test('a failed remember leaves planning and prompt assembly working',async()=>{
 const h=fixture('remember,plan');const notes=interactive(h);h.pi.registerTool=()=>{throw Error('tool rejected');};createApexFeatures()(h.pi);await h.emit('session_start');
 assert.equal(notes.length,1);assert.match(notes[0].message,/remember.*tool rejected/);assert.ok(h.commands.has('plan'));
 const event={systemPromptOptions:{contextFiles:[]}};await h.emit('before_agent_start',event);assert.deepEqual(event.systemPromptOptions.contextFiles,[]);
});
