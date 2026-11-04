import assert from 'node:assert/strict';
import test from 'node:test';

const extension=await import('../extensions/apex-context/index.mjs').catch(()=>null);
function harness(flags='') {
  const hooks=new Map(),tools=[],entries=[];
  let active=['read','write','edit','bash'];
  const api={registerFlag(){},getFlag(){return flags;},on(name,callback){hooks.set(name,callback);},
    registerTool(tool){tools.push(tool);},getActiveTools(){return [...active];},setActiveTools(names){active=[...names];},
    getAllTools(){return tools;},appendEntry(type,data){entries.push({type,data});}};
  const ctx={cwd:process.cwd(),sessionManager:{getBranch(){return [];}},modelRegistry:{complete(){throw Error('inference forbidden');}}};
  return {api,ctx,hooks,tools,entries,active:()=>active};
}
test('default extension starts no tools, prompt changes, filesystem or auxiliary calls',async()=>{
  assert.ok(extension,'Phase 1 extension missing');
  const h=harness();extension.default(h.api);
  assert.equal(h.tools.length,0);
  await h.hooks.get('session_start')({},h.ctx);
  assert.equal(h.tools.length,0);
  const event={systemPromptOptions:{sections:{native:'keep'},promptGuidelines:[]}};
  await h.hooks.get('before_agent_start')(event,h.ctx);
  assert.deepEqual(event.systemPromptOptions.sections,{native:'keep'});
  assert.equal(h.entries.length,0);
});
test('output section is stable and preserves native sections across turns',async()=>{
  assert.ok(extension,'Phase 1 extension missing');
  const h=harness('cache,output');extension.default(h.api);await h.hooks.get('session_start')({},h.ctx);
  const make=()=>({systemPromptOptions:{sections:{native:'keep'},promptGuidelines:[]}});
  const a=make(),b=make();await h.hooks.get('before_agent_start')(a,h.ctx);await h.hooks.get('before_agent_start')(b,h.ctx);
  assert.equal(a.systemPromptOptions.sections.native,'keep');
  assert.deepEqual(a.systemPromptOptions.sections,b.systemPromptOptions.sections);
  assert.ok(a.systemPromptOptions.sections.apex_efficiency);
  assert.equal(/\bbg\b|\bexplore\b|\bverify:\b/.test(a.systemPromptOptions.sections.apex_efficiency),false);
  await h.hooks.get('agent_settled')({},h.ctx);
  assert.equal(h.entries.length,1);assert.equal(h.entries[0].data.prefix_changes,0);
});
test('compact flag cancels offline before model lookup or auth',async()=>{
  assert.ok(extension,'Phase 1 extension missing');
  const h=harness('compact');extension.default(h.api);await h.hooks.get('session_start')({},h.ctx);
  h.ctx.modelRegistry=new Proxy({}, {get(){throw Error('lookup/auth forbidden');}});
  assert.deepEqual(await h.hooks.get('session_before_compact')({preparation:{},branchEntries:[],signal:new AbortController().signal},h.ctx),{cancel:true});
});
test('cache monitor observes mid-run tool delta without editing context messages',async()=>{
  assert.ok(extension,'Phase 1 extension missing');
  const h=harness('cache');extension.default(h.api);await h.hooks.get('session_start')({},h.ctx);
  const context={messages:[{role:'user',content:'preserve'}]};
  const before=structuredClone(context);
  assert.equal(typeof h.hooks.get('context'),'function','per-request cache monitor missing');
  await h.hooks.get('context')(context,h.ctx);
  h.api.setActiveTools([...h.active(),'grep']);
  await h.hooks.get('context')(context,h.ctx);
  await h.hooks.get('agent_settled')({},h.ctx);
  assert.equal(h.entries[0].data.prefix_changes,1);
  assert.deepEqual(context,before);
});
