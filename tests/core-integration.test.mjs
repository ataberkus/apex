import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
const extension=await import('../extensions/apex-core/index.mjs').catch(()=>null);
function harness(flags='',{mode='print',time=''}={}) {
  const hooks=new Map(),tools=[],branch=[];
  let active=['read','write','edit','bash'];
  const values={'apex-core-flags':flags,'apex-time-budget':time};
  const api={registerFlag(name,options){if(!(name in values))values[name]=options.default;},getFlag(name){return values[name];},
    on(name,handler){hooks.set(name,handler);},registerTool(tool){tools.push(tool);},getActiveTools(){return [...active];},
    setActiveTools(names){active=[...names];},getAllTools(){return tools;},
    appendEntry(customType,data){branch.push({type:'custom',customType,data});},getThinkingLevel(){return 'xhigh';},
    setThinkingLevel(value){assert.equal(value,'xhigh');}};
  const ctx={cwd:process.cwd(),mode,hasUI:false,thinkingLevel:'xhigh',
    sessionManager:{getBranch(){return structuredClone(branch);}},modelRegistry:new Proxy({}, {get(){throw Error('registry access forbidden');}})};
  return {hooks,tools,api,ctx,branch};
}
test('default Phase 2 factory and lifecycle are inert',async()=>{
  assert.ok(extension,'Phase 2 coordinator missing');
  const h=harness();extension.default(h.api);assert.equal(h.tools.length,0);
  await h.hooks.get('session_start')({reason:'startup'},h.ctx);
  const event={messageType:'user',prompt:'task',systemPromptOptions:{sections:{native:'preserve'}}};
  assert.equal(await h.hooks.get('before_agent_start')(event,h.ctx),undefined);
  assert.deepEqual(event.systemPromptOptions.sections,{native:'preserve'});
  assert.equal(h.branch.length,0);assert.equal(h.tools.length,0);
  await h.hooks.get('session_shutdown')({},h.ctx);
  await h.hooks.get('session_shutdown')({},h.ctx);
});
test('initial snapshot is a context message and static mode sections retain native guidance',async()=>{
  assert.ok(extension,'Phase 2 coordinator missing');
  let captured=0;
  const h=harness('snapshot,headless');
  extension.createApexCore({captureEnvironment:async()=>{captured++;return {text:'local fixture',details:{fixture:true}};}})(h.api);
  await h.hooks.get('session_start')({reason:'startup'},h.ctx);
  const event={messageType:'user',prompt:'task',systemPromptOptions:{sections:{native:'keep'}}};
  const first=await h.hooks.get('before_agent_start')(event,h.ctx);
  assert.ok(first.message.content.includes('local fixture'));
  assert.equal(event.systemPromptOptions.sections.native,'keep');
  assert.match(event.systemPromptOptions.sections.apex_mode,/Headless mode/);
  assert.equal(Object.values(event.systemPromptOptions.sections).join('').includes('local fixture'),false);
  const boundary={outcome:'completed',entries:[],context:{canContinue:true,pendingMessages:[]}};
  await h.hooks.get('turn_end')({...boundary,toolResults:[],turnIndex:0},h.ctx);
  assert.equal(captured,1);
});
test('an extension-triggered custom run keeps the mode section without starting a new task',async()=>{
  assert.ok(extension,'Phase 2 coordinator missing');
  let captured=0;
  const h=harness('snapshot,headless');
  extension.createApexCore({captureEnvironment:async()=>{captured++;return {text:'local fixture',details:{}};}})(h.api);
  await h.hooks.get('session_start')({reason:'startup'},h.ctx);
  const custom={messageType:'custom',message:{role:'custom',customType:'other-extension',content:'wake',display:false},
    systemPromptOptions:{sections:{native:'keep'}}};
  assert.equal(await h.hooks.get('before_agent_start')(custom,h.ctx),undefined);
  assert.match(custom.systemPromptOptions.sections.apex_mode,/Headless mode/);
  assert.equal(captured,0);
});
test('time appends threshold notes without volatile prompt edits or forced continuation',async()=>{
  assert.ok(extension,'Phase 2 coordinator missing');
  let ms=0;
  const h=harness('time',{time:'100'});extension.createApexCore({now:()=>ms})(h.api);
  await h.hooks.get('session_start')({reason:'startup'},h.ctx);
  await h.hooks.get('before_agent_start')({messageType:'user',prompt:'task',systemPromptOptions:{sections:{}}},h.ctx);
  ms=91_000;
  const sentinel={type:'custom',customType:'other-extension',data:{keep:true}};
  const boundary={outcome:'completed',entries:[sentinel],context:{canContinue:true,pendingMessages:[]},toolResults:[],turnIndex:0};
  const result=await h.hooks.get('turn_end')(boundary,h.ctx);
  assert.notEqual(result.continue,true);
  assert.deepEqual(result.entries[0],sentinel);
  assert.equal(result.entries.filter(e=>e.customType==='apex-time-note').length,3);
  const again=await h.hooks.get('turn_end')({...boundary,turnIndex:1},h.ctx);
  assert.equal(again?.entries?.some(e=>e.customType==='apex-time-note')??false,false);
});
test('core correction preserves the selected Phase 1 edit shape through the native hook',async()=>{
  assert.ok(extension,'Phase 2 coordinator missing');
  const cwd=await mkdtemp(path.join(process.cwd(),'.correction-compat-'));
  try{
    await writeFile(path.join(cwd,'fixture.txt'),'before\n');
    const h=harness('correct');h.ctx.cwd=cwd;
    const original=h.api.getFlag;h.api.getFlag=name=>name==='apex-context-flags'?'read,edit':original(name);
    extension.default(h.api);await h.hooks.get('session_start')({},h.ctx);
    const definition=h.tools.find(tool=>tool.name==='edit');
    const args=definition.prepareArguments({file_path:'fixture.txt',old_text:'before',new_text:'after'});
    const call={type:'tool_call',toolName:'edit',toolCallId:'compat',input:args};
    const denied=await h.hooks.get('tool_call')(call,h.ctx);assert.notEqual(denied?.block,true);
    const result=await definition.execute('compat',call.input,undefined,undefined,h.ctx);
    assert.equal(await readFile(path.join(cwd,'fixture.txt'),'utf8'),'after\n');
    assert.ok(result.details.apexEdit);
    assert.deepEqual(h.api.getActiveTools(),['read','write','edit','bash']);
  }finally{await rm(cwd,{recursive:true,force:true});}
});
test('core correction asks RPC clients with a bounded confirm and blocks catastrophic commands without one',async t=>{
  assert.ok(extension,'Phase 2 coordinator missing');
  const bash=command=>({type:'tool_call',toolName:'bash',toolCallId:'danger',input:{command}});
  const rpc=harness('correct',{mode:'rpc'});const asked=[];let answer=async()=>false;
  rpc.ctx.hasUI=true;rpc.ctx.ui={confirm:(...args)=>{asked.push(args);return answer(...args);}};
  extension.default(rpc.api);await rpc.hooks.get('session_start')({},rpc.ctx);
  assert.deepEqual(await rpc.hooks.get('tool_call')(bash('rm -rf /'),rpc.ctx),{block:true,reason:'Catastrophic command was not confirmed'});
  assert.equal(asked[0][0],'Confirm catastrophic command');assert.equal(asked[0][1],'rm -rf /');assert.equal(asked[0][2].timeout,15000);assert.equal(asked[0][2].signal.aborted,true);
  answer=async()=>true;assert.equal(await rpc.hooks.get('tool_call')(bash('rm -rf /'),rpc.ctx),undefined);
  assert.equal(await rpc.hooks.get('tool_call')(bash('npm test'),rpc.ctx),undefined);assert.equal(asked.length,2);
  t.mock.timers.enable({apis:['setTimeout']});let late;answer=()=>new Promise(resolve=>{late=resolve;});
  const pending=rpc.hooks.get('tool_call')(bash('rm -rf /'),rpc.ctx);for(let i=0;i<10&&asked.length<3;i++)await Promise.resolve();
  assert.equal(asked.length,3);t.mock.timers.tick(15000);
  assert.deepEqual(await pending,{block:true,reason:'Catastrophic command was not confirmed'});late(true);t.mock.timers.reset();
  for(const ui of [undefined,{confirm:async()=>assert.fail('print mode never asks')}]){
    const print=harness('correct');print.ctx.hasUI=ui!==undefined;print.ctx.ui=ui;
    extension.default(print.api);await print.hooks.get('session_start')({},print.ctx);
    assert.deepEqual(await print.hooks.get('tool_call')(bash('rm -rf /'),print.ctx),{block:true,reason:'Catastrophic command blocked: no interactive approval available'});
    assert.equal(await print.hooks.get('tool_call')(bash('npm test'),print.ctx),undefined);
  }
});
test('reload retains elapsed time and does not repeat earlier time thresholds',async()=>{
  assert.ok(extension,'Phase 2 coordinator missing');
  let ms=0;
  const h=harness('time',{time:'100'});
  h.branch.push({type:'custom',customType:'apex-core-control',data:{version:1,loopNotes:0,timeThresholds:[0.5],
    budgetSeconds:100,timeElapsedSeconds:80,timeStartedAtWall:Date.now()-80_000}});
  extension.createApexCore({now:()=>ms})(h.api);
  await h.hooks.get('session_start')({reason:'reload'},h.ctx);ms=11_000;
  const result=await h.hooks.get('turn_end')({outcome:'completed',entries:[],context:{canContinue:false,pendingMessages:[]}},h.ctx);
  assert.deepEqual(result.entries.filter(x=>x.customType==='apex-time-note').map(x=>x.details.threshold),[0.75,0.9]);
  assert.notEqual(result.continue,true);
});
// Pi's setThinkingLevel: clamps to the model's levels and emits thinking_level_select only when the level changes.
function thinking(h,initial,levels=['off','minimal','low','medium','high','xhigh','max']){
  let current=initial;const calls=[];
  const apply=value=>{const next=levels.includes(value)?value:levels.at(-1);if(next===current)return;const previousLevel=current;current=next;
    h.hooks.get('thinking_level_select')?.({type:'thinking_level_select',level:next,previousLevel});};
  h.api.getThinkingLevel=()=>current;h.api.setThinkingLevel=value=>{calls.push(value);apply(value);};
  return {calls,current:()=>current,choose:apply};
}
const userPrompt=(h,prompt='task')=>h.hooks.get('before_agent_start')({messageType:'user',prompt,systemPromptOptions:{sections:{}}},h.ctx);
const failure=(h,command='npm test')=>h.hooks.get('tool_result')({type:'tool_result',toolName:'bash',toolCallId:'f',input:{command},
  content:[{type:'text',text:'Failure'}],isError:true},h.ctx);
const coreControl=h=>h.branch.findLast(e=>e.customType==='apex-core-control').data;
test('a loop escalation lasts for its task and the next user prompt restores the level it replaced',async()=>{
  assert.ok(extension,'Phase 2 coordinator missing');
  const h=harness('loops');const level=thinking(h,'medium');extension.default(h.api);
  await h.hooks.get('session_start')({reason:'startup'},h.ctx);
  await userPrompt(h,'one');
  for(let i=0;i<3;i++)await failure(h);
  assert.equal(level.current(),'xhigh');assert.deepEqual(level.calls,['xhigh']);
  assert.deepEqual(coreControl(h).thinkingRestore,{from:'medium',to:'xhigh'});
  assert.deepEqual(h.branch.slice(-3).map(e=>e.customType),['apex-core-control','apex-core-control','apex-routing']);
  const custom={messageType:'custom',message:{role:'custom',customType:'other-extension',content:'wake',display:false},systemPromptOptions:{sections:{}}};
  await h.hooks.get('before_agent_start')(custom,h.ctx);
  assert.deepEqual(level.calls,['xhigh']);
  await userPrompt(h,'two');
  assert.equal(level.current(),'medium');assert.deepEqual(level.calls,['xhigh','medium']);
  assert.equal(coreControl(h).thinkingRestore,undefined);
  // A level chosen by hand after the escalation is the user's and stays.
  for(let i=0;i<3;i++)await failure(h);
  assert.equal(level.current(),'xhigh');
  level.choose('high');
  await userPrompt(h,'three');
  assert.equal(level.current(),'high');assert.deepEqual(level.calls,['xhigh','medium','xhigh']);
  // Picking away from the escalated level and back to it is still a hand choice: the restore stays cancelled.
  for(let i=0;i<3;i++)await failure(h);
  assert.equal(level.current(),'xhigh');assert.deepEqual(coreControl(h).thinkingRestore,{from:'high',to:'xhigh'});
  level.choose('high');level.choose('xhigh');
  await userPrompt(h,'four');
  assert.equal(level.current(),'xhigh');assert.deepEqual(level.calls,['xhigh','medium','xhigh','xhigh']);
});
test('a clamped escalation records the level actually set and a second note keeps the first record',async()=>{
  assert.ok(extension,'Phase 2 coordinator missing');
  const h=harness('loops');const level=thinking(h,'medium',['off','minimal','low','medium','high']);extension.default(h.api);
  await h.hooks.get('session_start')({reason:'startup'},h.ctx);
  await userPrompt(h);
  for(let i=0;i<3;i++)await failure(h);
  assert.equal(level.current(),'high');
  for(let i=0;i<3;i++)await failure(h,'npm run lint');
  assert.deepEqual(level.calls,['xhigh','xhigh']);
  assert.deepEqual(coreControl(h).thinkingRestore,{from:'medium',to:'high'});
  await userPrompt(h);
  assert.equal(level.current(),'medium');
});
test('a stored thinking restore survives reload and a malformed one is dropped',async()=>{
  assert.ok(extension,'Phase 2 coordinator missing');
  for(const [thinkingRestore,expected] of [[{from:'medium',to:'xhigh'},'medium'],[{from:'turbo',to:'xhigh'},'xhigh'],['medium','xhigh'],[{from:'low'},'xhigh'],[null,'xhigh']]){
    const h=harness('loops');const level=thinking(h,'xhigh');
    h.branch.push({type:'custom',customType:'apex-core-control',data:{version:1,loopNotes:1,timeThresholds:[],thinkingRestore}});
    extension.default(h.api);await h.hooks.get('session_start')({reason:'reload'},h.ctx);
    await userPrompt(h);
    assert.equal(level.current(),expected,JSON.stringify(thinkingRestore));
    assert.equal(coreControl(h).thinkingRestore,undefined);
  }
});
const sha256=text=>createHash('sha256').update(text).digest('hex');
// Pi appends the returned message; its projection drops compacted entries and empties context_edit removals.
function projected(h){
  const session=[],compacted=new Set(),removed=new Set(),edited=new Map();
  h.ctx.sessionManager.buildSessionProjection=()=>({entries:session.filter(entry=>!compacted.has(entry)).map(sourceEntry=>({sourceEntry,
    messages:removed.has(sourceEntry)?[]:[{role:'custom',customType:sourceEntry.customType,content:edited.get(sourceEntry)??sourceEntry.content,details:sourceEntry.details}]}))});
  const prompt=async()=>{const result=await userPrompt(h);if(result)session.push({type:'custom_message',...result.message});return result;};
  return {session,compacted,removed,edited,prompt};
}
test('an unchanged environment snapshot is not repeated while the model still sees it',async()=>{
  assert.ok(extension,'Phase 2 coordinator missing');
  let text='environment A',captured=0;
  const h=harness('snapshot');
  extension.createApexCore({captureEnvironment:async()=>{captured++;return {text,details:{text}};}})(h.api);
  await h.hooks.get('session_start')({reason:'startup'},h.ctx);
  const s=projected(h);
  const first=await s.prompt();
  assert.equal(first.message.content,'environment A');
  assert.deepEqual(first.message.details,{environment:{text:'environment A'},environmentHash:sha256('environment A')});
  assert.equal(await s.prompt(),undefined);assert.equal(captured,2);
  s.compacted.add(s.session[0]);
  assert.equal((await s.prompt())?.message.content,'environment A');
  text='environment B';
  assert.equal((await s.prompt())?.message.content,'environment B');
  text='environment A';
  assert.equal((await s.prompt())?.message.content,'environment A','the newest visible snapshot was B');
  assert.equal(await s.prompt(),undefined);
  s.removed.add(s.session.at(-1));
  assert.equal((await s.prompt())?.message.content,'environment A','a removed newest snapshot leaves B visible');
  s.edited.set(s.session.at(-1),'[elided]');
  assert.equal((await s.prompt())?.message.content,'environment A','an edited snapshot no longer shows the text');
  assert.equal(await s.prompt(),undefined);
});
test('a suppressed snapshot keeps other context and never counts as carrying the environment text',async()=>{
  assert.ok(extension,'Phase 2 coordinator missing');
  const h=harness('snapshot,time');
  extension.createApexCore({captureEnvironment:async()=>({text:'environment A',details:{}})})(h.api);
  await h.hooks.get('session_start')({reason:'startup'},h.ctx);
  const s=projected(h);
  const note='Time awareness has no evaluator-supplied budget; no deadline is assumed.';
  assert.equal((await s.prompt()).message.content,`environment A\n\n${note}`);
  const repeated=await s.prompt();
  assert.equal(repeated.message.content,note);
  assert.equal(repeated.message.details.environmentRepeated,true);
  assert.equal(repeated.message.details.environmentHash,sha256('environment A'));
  s.compacted.add(s.session[0]);
  assert.equal((await s.prompt()).message.content,`environment A\n\n${note}`);
});
test('version probes are reused across the prompts of a session and start fresh on session_start, tree and fork',async()=>{
  assert.ok(extension,'Phase 2 coordinator missing');
  const {captureEnvironment}=await import('../extensions/apex-core/environment.mjs');
  const cwd=await mkdtemp(path.join(process.cwd(),'.probe-cache-'));
  try{
    let spawned=0;const caches=[];
    const runCommand=async command=>{spawned++;return {code:0,stdout:`${command} fixture`,stderr:''};};
    const h=harness('snapshot');h.ctx.cwd=cwd;
    extension.createApexCore({captureEnvironment:options=>{caches.push(options.probeCache);return captureEnvironment({...options,runCommand});}})(h.api);
    for(const event of ['session_start','session_tree','session_fork']){
      await h.hooks.get(event)({},h.ctx);
      spawned=0;const first=await userPrompt(h);assert.equal(spawned,14,event);
      spawned=0;const second=await userPrompt(h);assert.equal(spawned,3,event);
      assert.equal(second.message.content,first.message.content);
    }
    assert.ok(caches.every(cache=>cache instanceof Map));
    assert.equal(new Set(caches).size,3);
  }finally{await rm(cwd,{recursive:true,force:true});}
});
