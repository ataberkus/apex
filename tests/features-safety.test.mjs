import assert from 'node:assert/strict';
import test from 'node:test';
import {createSafetyGate} from '../extensions/apex-features/safety.mjs';
const event=(name,input={},parentToolCallId)=>({type:'tool_call',toolName:name,input,toolCallId:parentToolCallId?'p/1':'x',parentToolCallId});
function fixture({tools=[],confirm=async()=>true,mode='tui',hasUI=true,evalMode=false}={}){const calls=[];const pi={getAllTools:()=>tools};const ctx={mode,hasUI,ui:{confirm:(...args)=>{calls.push(args);return confirm(...args);}}};return {gate:createSafetyGate({pi,evalMode}),ctx,calls};}
test('eval/headless/no UI never request approval or inspect annotations',async()=>{
 for(const options of [{evalMode:true},{mode:'json'},{mode:'print'},{hasUI:false}]){const f=fixture(options);const gate=createSafetyGate({evalMode:options.evalMode,pi:{getAllTools:()=>assert.fail('annotation read')}});assert.equal(await gate.check(event('danger'),f.ctx),undefined);assert.equal(f.calls.length,0);}
});
test('dashboard RPC sessions ask before writes and a denial blocks',async()=>{
 const f=fixture({mode:'rpc',confirm:async()=>false});assert.equal((await f.gate.check(event('write',{path:'file'}),f.ctx)).block,true);assert.equal(f.calls.length,1);
});
test('annotation hints are unverified, contradictory/destructive/open-world and unknown tools ask',async()=>{
 const tools=[{name:'readonly',annotations:{readOnlyHint:true}},{name:'destructive',annotations:{destructiveHint:true}},{name:'web',annotations:{readOnlyHint:true,openWorldHint:true}},{name:'contradiction',annotations:{readOnlyHint:true,destructiveHint:true}}];const f=fixture({tools});assert.equal(await f.gate.check(event('readonly'),f.ctx),undefined);assert.equal(f.calls.length,0);
 for(const name of ['destructive','web','contradiction','unknown'])assert.equal(await f.gate.check(event(name,{},'parent'),f.ctx),undefined);assert.equal(f.calls.length,4);assert.match(f.calls[0][1],/unverified/i);assert.equal(f.calls[0][2].timeout<=30000,true);assert.equal(f.calls[0][2].signal instanceof AbortSignal,true);
});
test('native builtins use conservative classifications with no annotations',async()=>{
 const native=await import('@earendil-works/pi-coding-agent');const tools=[native.createReadToolDefinition(process.cwd()),native.createGrepToolDefinition(process.cwd()),native.createFindToolDefinition(process.cwd()),native.createLsToolDefinition(process.cwd()),native.createWriteToolDefinition(process.cwd()),native.createEditToolDefinition(process.cwd())];assert.equal(tools.every(tool=>tool.annotations===undefined),true);
 const f=fixture({tools});for(const name of ['read','grep','find','ls'])assert.equal(await f.gate.check(event(name),f.ctx),undefined);assert.equal(f.calls.length,0);for(const name of ['write','edit'])assert.equal(await f.gate.check(event(name,{path:'file'}),f.ctx),undefined);assert.equal(f.calls.length,2);
});
test('literal echo avoids destructive false positives while direct and nested destructive shell asks',async()=>{
 const f=fixture();for(const command of ["echo 'rm -rf /'",'printf "%s\\n" "rm -rf /"','pwd'])assert.equal(await f.gate.check(event('bash',{command}),f.ctx),undefined);assert.equal(f.calls.length,0);
 for(const command of ['rm -rf /','echo $(rm -rf /)','git push origin main','curl https://example.invalid'])assert.equal(await f.gate.check(event('bash',{command},'p'),f.ctx),undefined);assert.equal(f.calls.length,4);
});
test('decline/throw/pre-abort/pending cancellation block and approvals do not leak across calls',async()=>{
 let approved=false;const f=fixture({confirm:async()=>approved});assert.equal((await f.gate.check(event('write'),f.ctx)).block,true);approved=true;assert.equal(await f.gate.check(event('write'),f.ctx),undefined);approved=false;assert.equal((await f.gate.check(event('write'),f.ctx)).block,true);
 const thrown=fixture({confirm:async()=>{throw Error('UI failed');}});assert.equal((await thrown.gate.check(event('write'),thrown.ctx)).block,true);
 const controller=new AbortController();controller.abort();const pre=fixture();pre.ctx.signal=controller.signal;assert.equal((await pre.gate.check(event('write'),pre.ctx)).block,true);assert.equal(pre.calls.length,0);
 const pending=fixture({confirm:(_title,_message,{signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve(false),{once:true}))});const abort=new AbortController();pending.ctx.signal=abort.signal;const checking=pending.gate.check(event('write'),pending.ctx);queueMicrotask(()=>abort.abort());assert.equal((await checking).block,true);assert.equal(pending.calls[0][2].signal.aborted,true);
});
test('approval is bounded even if UI ignores abort and a late approval is ignored',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let late;const f=fixture({confirm:()=>new Promise(resolve=>{late=resolve;})});const checking=f.gate.check(event('edit',{path:'concrete.txt'}),f.ctx);await Promise.resolve();assert.match(f.calls[0][1],/concrete.txt/);t.mock.timers.tick(15000);assert.equal((await checking).block,true);assert.equal(f.calls[0][2].signal.aborted,true);late(true);t.mock.timers.reset();
});
