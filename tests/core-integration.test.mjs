import assert from 'node:assert/strict';
import test from 'node:test';
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
  const event={prompt:'task',systemPromptOptions:{sections:{native:'preserve'}}};
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
  const event={prompt:'task',systemPromptOptions:{sections:{native:'keep'}}};
  const first=await h.hooks.get('before_agent_start')(event,h.ctx);
  assert.ok(first.message.content.includes('local fixture'));
  assert.equal(event.systemPromptOptions.sections.native,'keep');
  assert.match(event.systemPromptOptions.sections.apex_mode,/Headless mode/);
  assert.equal(Object.values(event.systemPromptOptions.sections).join('').includes('local fixture'),false);
  const boundary={outcome:'completed',entries:[],context:{canContinue:true,pendingMessages:[]}};
  await h.hooks.get('turn_end')({...boundary,toolResults:[],turnIndex:0},h.ctx);
  assert.equal(captured,1);
});
test('time appends threshold notes without volatile prompt edits or forced continuation',async()=>{
  assert.ok(extension,'Phase 2 coordinator missing');
  let ms=0;
  const h=harness('time',{time:'100'});extension.createApexCore({now:()=>ms})(h.api);
  await h.hooks.get('session_start')({reason:'startup'},h.ctx);
  await h.hooks.get('before_agent_start')({prompt:'task',systemPromptOptions:{sections:{}}},h.ctx);
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
