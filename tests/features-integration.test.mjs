import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
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
 await h.emit('before_agent_start',{prompt:'plan',systemPromptOptions:{sections:{}}});
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
 await h.emit('session_start');await h.emit('turn_start');const r=await h.emit('tool_call',{toolName:'write'});assert.equal(r.block,true);assert.match(r.reason,/bounded failure/);await h.emit('turn_end');
});
test('tree navigation restores base tools without old plan writes into new branch',async()=>{
 const h=fixture('plan');createApexFeatures()(h.pi);await h.emit('session_start');await h.commands.get('plan').handler('inspect',h.ctx);
 h.branch.length=0;await h.emit('session_tree');assert.deepEqual(h.pi.getActiveTools(),['read','write','edit','bash']);assert.equal(h.branch.length,0);
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
