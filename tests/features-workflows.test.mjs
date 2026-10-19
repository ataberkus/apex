import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileLink} from './fixtures/filesystem.mjs';
import {createPlanManager,recordedToolNames,runReview} from '../extensions/apex-features/workflows.mjs';

const offline={allowed_model:'openrouter/meta/muse-spark-1.3-contributor',thinking_level:'xhigh',paid_runs_enabled:false,execution_policy:'offline-only'};
const paid={...offline,paid_runs_enabled:true,execution_policy:'paid-enabled'};
const call=(name,parentToolCallId)=>({type:'tool_call',toolCallId:parentToolCallId?'p/1':'x',parentToolCallId,toolName:name,input:{}});
const boundary=changes=>({type:'agent_before_settle',entries:[],outcome:'completed',continue:false,context:{pendingMessages:[],canContinue:true,contextMessages:[]},...changes});
async function fixture(t,options={}) {
 const cwd=await mkdtemp(path.join(process.cwd(),'tests/.plan-fixture-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 let active=['read','bash','edit','write','grep','find','ls'];const entries=[];const sent=[];
 const pi={getActiveTools:()=>[...active],setActiveTools:tools=>{active=[...tools];},sendUserMessage:(...args)=>{sent.push(args);}};
 const ctx={cwd,mode:'json',hasUI:false,sessionManager:{getBranch:()=>entries}};
 const manager=createPlanManager({cwd,pi,policy:offline,persist:entry=>entries.push({type:'custom',...structuredClone(entry)}),...options});
 return {cwd,pi,ctx,manager,entries,sent,active:()=>active};
}
test('offline plan enters without prompting and gates nested/deferred/unknown calls',async t=>{
 const f=await fixture(t);Object.defineProperty(f.ctx,'model',{get(){assert.fail('offline model read');}});
 const started=await f.manager.start('Plan the change',f.ctx);assert.equal(started.ok,true);assert.equal(f.manager.isActive(),true);assert.equal(f.sent.length,0);
 assert.deepEqual(f.active(),['read','grep','find','ls']);
 for(const name of ['read','grep','find','ls'])assert.equal(f.manager.gate(call(name,'parent')),undefined);
 for(const name of ['bash','write','edit','remember','deferred_mutator','codemode','unknown'])assert.equal(f.manager.gate(call(name,'parent')).block,true,name);
 assert.equal(f.entries.at(-1).data.active,true);
});
test('manual save keeps literal markdown at exact PLAN.md and restores tools',async t=>{
 const f=await fixture(t);await f.manager.start('task',f.ctx);const markdown='# Plan\n\n- Keep literal $(touch bad) `rm -rf /`\n';
 const result=await f.manager.save(markdown,f.ctx);assert.equal(result.ok,true);assert.equal(result.path,path.join(f.cwd,'PLAN.md'));assert.equal(await readFile(result.path,'utf8'),markdown);
 assert.equal(f.manager.isActive(),false);assert.deepEqual(f.active(),['read','bash','edit','write','grep','find','ls']);assert.equal(f.entries.at(-1).data.active,false);
 await assert.rejects(readFile(path.join(f.cwd,'bad')),{code:'ENOENT'});
});
test('cancel/shutdown restore tools without creating a plan',async t=>{
 for(const method of ['cancel','shutdown']){const f=await fixture(t);await f.manager.start('task',f.ctx);await f.manager[method](f.ctx);assert.equal(f.manager.isActive(),false);assert.equal(f.active().includes('write'),true);await assert.rejects(readFile(path.join(f.cwd,'PLAN.md')),{code:'ENOENT'});}
});
test('plan write rejects symlink and restores on failure',async t=>{
 const f=await fixture(t);const target=path.join(f.cwd,'outside.md');await writeFile(target,'protected');if(!await fileLink(t,target,path.join(f.cwd,'PLAN.md')))return;await f.manager.start('task',f.ctx);
 const result=await f.manager.save('# unsafe',f.ctx);assert.equal(result.ok,false);assert.match(result.reason,/symbolic|symlink/i);assert.equal(await readFile(target,'utf8'),'protected');assert.equal(f.manager.isActive(),false);assert.equal(f.active().includes('write'),true);
});
test('reload active branch and compaction restore prior tool selection',async t=>{
 const f=await fixture(t);await f.manager.start('first',f.ctx);const stored=structuredClone(f.entries.at(-1));
 for(const branch of [[stored],[{type:'compaction',details:{apexState:{'apex-plan-state':stored.data}}}]]){
  const manager=createPlanManager({cwd:f.cwd,pi:f.pi,policy:offline,branch,persist:()=>{}});assert.equal(manager.isActive(),true);assert.equal(manager.gate(call('write')).block,true);await manager.cancel(f.ctx);assert.equal(f.active().includes('write'),true);
 }
 const other=createPlanManager({cwd:f.cwd,pi:f.pi,policy:offline,branch:[]});assert.equal(other.isActive(),false);
});
test('resume after a saved plan undoes only a stale read-only loadout Pi restored from the transcript',async t=>{
 const f=await fixture(t);await f.manager.start('task',f.ctx);
 const declared=(added,removed=[])=>({type:'message',message:{role:'system',content:'',...(added.length?{toolsAdded:added.map(name=>({name}))}:{}),...(removed.length?{toolsRemoved:removed.map(name=>({name}))}:{})}});
 // Pi's agent loop declared the plan's read-only loadout as deltas before the planning request.
 const branch=[declared(['read','bash','edit','write']),f.entries[0],declared(['grep','find','ls'],['bash','edit','write'])];
 await f.manager.save('# Plan\n',f.ctx);branch.push(f.entries.at(-1));
 const recorded=recordedToolNames(branch.map(entry=>entry.message).filter(Boolean));
 assert.deepEqual(recorded.sort(),['find','grep','ls','read']);
 // Pi restored the declared read loadout; another extension then activated its own tool.
 const resume=(entries,tools)=>{f.pi.setActiveTools(tools);createPlanManager({cwd:f.cwd,pi:f.pi,policy:offline,branch:entries,recordedTools:recordedToolNames(entries.map(entry=>entry.message).filter(Boolean)),persist:()=>{}});return f.active();};
 assert.deepEqual(resume(branch,['read','grep','find','ls','todo']),['read','bash','edit','write','grep','find','ls','todo']);
 // Once a later request declared the restored tools, Pi's own restoration is authoritative.
 const later=[...branch,declared(['bash','edit','write'],['grep','find','ls'])];
 assert.deepEqual(resume(later,['read','bash','edit','write']),['read','bash','edit','write']);
 // A later read-only loadout the user chose is declared after the plan state and is not overridden.
 const chosen=[...later,declared(['grep','find','ls'],['bash','edit','write'])];
 assert.deepEqual(resume(chosen,['read','grep','find','ls']),['read','grep','find','ls']);
});
test('completed boundary saves final assistant text and preserves existing drafts',async t=>{
 const f=await fixture(t);await f.manager.start('task',f.ctx);f.entries.push({type:'message',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'# Native plan\n'},{type:'text',text:'- Check result'}]}});
 const original={type:'custom',customType:'other',data:{keep:true}};const event=boundary({entries:[original]});const result=await f.manager.finish(event,f.ctx);
 assert.deepEqual(result.entries[0],original);assert.equal(result.entries.at(-1).customType,'apex-plan-complete');assert.equal(await readFile(path.join(f.cwd,'PLAN.md'),'utf8'),'# Native plan\n\n- Check result');assert.equal(f.manager.isActive(),false);assert.equal(f.active().includes('write'),true);assert.deepEqual(event.entries,[original]);
});
test('pending continuation does not save while aborted/error outcomes restore honestly',async t=>{
 const f=await fixture(t);await f.manager.start('task',f.ctx);f.entries.push({type:'message',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'# premature'}]}});
 const response=await f.manager.finish(boundary({context:{pendingMessages:[{role:'user',content:'next'}]}}),f.ctx);assert.equal(response.entries.length,0);assert.equal(f.manager.isActive(),true);await assert.rejects(readFile(path.join(f.cwd,'PLAN.md')),{code:'ENOENT'});
 for(const outcome of ['error','aborted']){if(!f.manager.isActive())await f.manager.start('task',f.ctx);const result=await f.manager.finish(boundary({outcome}),f.ctx);assert.equal(result.entries.some(e=>e.customType==='apex-plan-complete'),false);assert.equal(f.manager.isActive(),false);assert.equal(f.active().includes('write'),true);}
});
test('completed boundary without final text refuses completion and restores',async t=>{
 const f=await fixture(t);await f.manager.start('task',f.ctx);const result=await f.manager.finish(boundary(),f.ctx);assert.equal(result.entries.at(-1).customType,'apex-plan-error');assert.equal(f.manager.isActive(),false);await assert.rejects(readFile(path.join(f.cwd,'PLAN.md')),{code:'ENOENT'});
});
test('future plan prompting requires exact policy/model/xhigh and actual sendUserMessage',async t=>{
 for(const mode of ['exact','virtual','other','reasoning']){const f=await fixture(t,{policy:paid});f.ctx.model=mode==='virtual'?{provider:'apex',id:'auto',api:'pi-virtual'}:{provider:mode==='other'?'other':'openrouter',id:'meta/muse-spark-1.3-contributor',api:'openai-completions'};f.ctx.thinkingLevel=mode==='reasoning'?'high':'xhigh';
  const result=await f.manager.start('task',f.ctx);assert.equal(f.sent.length,['exact','virtual'].includes(mode)?1:0);assert.equal(result.ok,['exact','virtual'].includes(mode));if(f.sent.length){assert.equal(f.sent[0][1].expandPromptTemplates,false);assert.match(f.sent[0][0],/task/);}else assert.equal(f.active().includes('write'),true);
 }
});
test('send/persist errors restore tools and never retain an active flag',async t=>{
 const f=await fixture(t,{policy:paid});f.ctx.model={provider:'openrouter',id:'meta/muse-spark-1.3-contributor'};f.ctx.thinkingLevel='xhigh';f.pi.sendUserMessage=()=>{throw Error('send failed');};const result=await f.manager.start('task',f.ctx);assert.equal(result.ok,false);assert.equal(f.manager.isActive(),false);assert.equal(f.active().includes('write'),true);
});
test('prior assistant text is never saved for a new or reloaded task',async t=>{
 const f=await fixture(t);f.entries.push({type:'message',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'# Previous task'}]}});await f.manager.start('new task',f.ctx);
 const reloaded=createPlanManager({cwd:f.cwd,pi:f.pi,policy:offline,branch:f.entries,persist:entry=>f.entries.push({type:'custom',...entry})});const result=await reloaded.finish(boundary(),f.ctx);assert.equal(result.entries.at(-1).customType,'apex-plan-error');await assert.rejects(readFile(path.join(f.cwd,'PLAN.md')),{code:'ENOENT'});assert.equal(reloaded.isActive(),false);
});
test('nonfinal assistant tool-use text cannot be presented as a complete plan',async t=>{
 const f=await fixture(t);await f.manager.start('task',f.ctx);f.entries.push({type:'message',message:{role:'assistant',stopReason:'toolUse',content:[{type:'text',text:'# Partial'},{type:'toolCall',name:'read'}]}});const result=await f.manager.finish(boundary(),f.ctx);assert.equal(result.entries.at(-1).customType,'apex-plan-error');await assert.rejects(readFile(path.join(f.cwd,'PLAN.md')),{code:'ENOENT'});
});
test('failed restoration is honest and shutdown retries the original tools',async t=>{
 const f=await fixture(t);await f.manager.start('task',f.ctx);const original=f.pi.setActiveTools;let attempts=0;f.pi.setActiveTools=tools=>{if(attempts++===0)throw Error('transient restore failure');original(tools);};const result=await f.manager.cancel(f.ctx);assert.equal(result.ok,false);assert.match(result.reason,/restore failure/);assert.equal(f.active().includes('write'),false);assert.equal((await f.manager.shutdown(f.ctx)).ok,true);assert.equal(f.active().includes('write'),true);
});
test('failed persistence during finish never claims completion and later shutdown clears stale active state',async t=>{
 const f=await fixture(t);let fail=false;const manager=createPlanManager({cwd:f.cwd,pi:f.pi,policy:offline,persist:entry=>{if(fail)throw Error('persist failure');f.entries.push({type:'custom',...entry});}});await manager.start('task',f.ctx);fail=true;const result=await manager.save('# saved but restoration not persisted',f.ctx);assert.equal(result.ok,false);assert.equal(f.entries.at(-1).data.active,true);fail=false;assert.equal((await manager.shutdown(f.ctx)).ok,true);assert.equal(f.entries.at(-1).data.active,false);
});
test('review guards policy before reading cwd/task/context or invoking verify',async()=>{
 const options={policy:offline,get cwd(){assert.fail('cwd touched');},get task(){assert.fail('task touched');},verify:()=>assert.fail('verify called')};const result=await runReview(options,{get modelRegistry(){assert.fail('registry touched');}});assert.equal(result.ok,false);assert.equal(result.blocked,true);assert.match(result.reason,/offline/i);
});
test('authorized review sends current staged and unstaged diff plus requirements to native verify seam',async t=>{
 const f=await fixture(t);const env={PATH:process.env.PATH,LANG:'C',LC_ALL:'C',PI_OFFLINE:'1',npm_config_offline:'true',npm_config_registry:'http://127.0.0.1:9'};
 const git=args=>{const result=spawnSync('git',args,{cwd:f.cwd,env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);};git(['init','-q']);await writeFile(path.join(f.cwd,'file.txt'),'before\n');git(['add','file.txt']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','before']);await writeFile(path.join(f.cwd,'file.txt'),'staged\n');git(['add','file.txt']);await writeFile(path.join(f.cwd,'file.txt'),'current\n');
 const index=path.join(f.cwd,'.git','index');const digest=async()=>createHash('sha256').update(await readFile(index)).digest('hex');const before=await digest();
 let request;const result=await runReview({cwd:f.cwd,task:'Keep current behavior and literal {diff}, $& and $$',policy:paid,verify:async value=>{request=value;return {content:[{type:'text',text:'reviewed'}],details:{status:'complete'}};}},f.ctx);assert.equal(result.ok,true);assert.ok(request.task.includes('Keep current behavior and literal {diff}, $& and $$'));assert.equal(request.task.split('{diff}').length,2);assert.match(request.task,/\+current/);assert.match(request.task,/-before/);assert.equal(request.cwd,f.cwd);assert.deepEqual(request.commands,[]);assert.equal(await digest(),before);
});
test('invalid review policy identities refuse before verify and failed seam stays honest',async t=>{
 const f=await fixture(t);for(const policy of [{...paid,allowed_model:'other'},{...paid,thinking_level:'high'}])assert.equal((await runReview({cwd:f.cwd,task:'task',policy,verify:()=>assert.fail('verify')},f.ctx)).ok,false);
 const result=await runReview({cwd:f.cwd,task:'task',policy:paid,verify:()=>{throw Error('verify should not run in non-git fixture');}},f.ctx);assert.equal(result.ok,false);assert.equal(result.blocked,false);
});
test('review never claims success for malformed or non-complete native verification evidence',async t=>{
 const f=await fixture(t);const env={PATH:process.env.PATH,LANG:'C',LC_ALL:'C',PI_OFFLINE:'1'};for(const args of [['init','-q'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','initial']]){const r=spawnSync('git',args,{cwd:f.cwd,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
 for(const value of [undefined,{}, {content:[{type:'text',text:'not complete'}],details:{status:'error'}}])assert.equal((await runReview({cwd:f.cwd,task:'task',policy:paid,verify:async()=>value},f.ctx)).ok,false);
});
