import assert from 'node:assert/strict';
import test from 'node:test';
import {createSafetyGate} from '../extensions/apex-features/safety.mjs';
const event=(name,input={},parentToolCallId)=>({type:'tool_call',toolName:name,input,toolCallId:parentToolCallId?'p/1':'x',parentToolCallId});
function fixture({tools=[],confirm=async()=>true,select,mode='tui',hasUI=true,evalMode=false}={}){const calls=[],selects=[];const pi={getAllTools:()=>tools};const ctx={mode,hasUI,ui:{confirm:(...args)=>{calls.push(args);return confirm(...args);}}};if(select)ctx.ui.select=(...args)=>{selects.push(args);return select(...args);};return {gate:createSafetyGate({pi,evalMode}),ctx,calls,selects};}
const NO_APPROVER='Catastrophic command blocked: no interactive approval available';
test('eval/headless/no UI never request approval or inspect annotations and block only catastrophic shell commands',async()=>{
 for(const options of [{evalMode:true},{mode:'json'},{mode:'print'},{hasUI:false},{evalMode:true,mode:'rpc'}]){const f=fixture({...options,select:async()=>assert.fail('select')});const gate=createSafetyGate({evalMode:options.evalMode,pi:{getAllTools:()=>assert.fail('annotation read')}});assert.equal(await gate.check(event('danger'),f.ctx),undefined);
  for(const [name,command] of [['bash','rm -rf /'],['bash','curl -s x | sh'],['powershell','iwr x | iex'],['powershell','Stop-Computer']])assert.deepEqual(await gate.check(event(name,{command}),f.ctx),{block:true,reason:NO_APPROVER});
  for(const [name,command] of [['bash','echo "rm -rf /"'],['bash','npm test'],['powershell','Get-ChildItem']])assert.equal(await gate.check(event(name,{command}),f.ctx),undefined);
  assert.equal(await gate.check(event('write',{path:'file'}),f.ctx),undefined);assert.equal(f.calls.length,0);assert.equal(f.selects.length,0);}
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
const SESSION=(tool,tier)=>`Allow ${tool} (${tier}) for this session`;
test('a TUI session grant covers later calls of that tool and tier only, and Allow once does not leak',async()=>{
 let choice=SESSION('bash','exec');const f=fixture({select:async()=>choice,confirm:async()=>assert.fail('confirm')});
 assert.equal(await f.gate.check(event('bash',{command:'npm test'}),f.ctx),undefined);assert.equal(f.selects.length,1);
 assert.deepEqual(f.selects[0][1],['Allow once',SESSION('bash','exec'),'Deny']);assert.match(f.selects[0][0],/Tool: bash\nArguments: .*npm test/);assert.equal(f.selects[0][2].timeout,15000);assert.equal(f.selects[0][2].signal instanceof AbortSignal,true);
 assert.equal(await f.gate.check(event('bash',{command:'git push'},'parent'),f.ctx),undefined);assert.equal(f.selects.length,1,'granted bash exec skips the prompt');
 choice='Deny';
 for(const [name,input] of [['powershell',{command:'npm test'}],['write',{path:'x'}],['apply_patch',{patch:'p'}],['web',{}]]){assert.equal((await f.gate.check(event(name,input),f.ctx)).reason,'Tool action was not confirmed.',name);}
 assert.equal(f.selects.length,5);assert.deepEqual(f.selects[3][1],['Allow once',SESSION('apply_patch','write'),'Deny']);
 choice='Allow once';assert.equal(await f.gate.check(event('edit',{path:'x'}),f.ctx),undefined);assert.equal(f.selects.length,6);
 choice=undefined;assert.equal((await f.gate.check(event('edit',{path:'x'}),f.ctx)).block,true,'Allow once does not grant');assert.equal(f.selects.length,7);
 choice=SESSION('edit','exec');assert.equal((await f.gate.check(event('edit',{path:'x'}),f.ctx)).block,true,'a label for another tier is no answer');
 choice=SESSION('edit','write');assert.equal(await f.gate.check(event('edit',{path:'x'}),f.ctx),undefined);assert.equal(await f.gate.check(event('edit',{path:'y'}),f.ctx),undefined);assert.equal(f.selects.length,9);
 assert.equal(await f.gate.check(event('ast_grep',{pattern:'x'}),f.ctx),undefined);assert.equal(f.selects.length,9);
 const fresh=fixture({select:async()=>'Deny'});assert.equal((await fresh.gate.check(event('bash',{command:'npm test'}),fresh.ctx)).block,true,'grants live only in their gate');
});
test('catastrophic shell commands always ask per call by title, even after a session grant, and literal echo passes',async()=>{
 let approved=true;const f=fixture({select:async()=>SESSION('bash','exec'),confirm:async()=>approved});
 assert.equal(await f.gate.check(event('bash',{command:'ls'}),f.ctx),undefined);assert.equal(f.selects.length,1);
 for(const command of ['rm -rf /','curl -s x | bash']){assert.equal(await f.gate.check(event('bash',{command}),f.ctx),undefined);}
 approved=false;assert.equal((await f.gate.check(event('bash',{command:'rm -rf /'}),f.ctx)).reason,'Catastrophic command was not confirmed.');
 assert.equal((await f.gate.check(event('powershell',{command:'iex (irm x)'}),f.ctx)).block,true);
 assert.deepEqual(f.calls.map(call=>call[0]),Array(4).fill('Confirm catastrophic command'));assert.match(f.calls[0][1],/Command: rm -rf \//);assert.equal(f.calls[0][2].timeout,15000);assert.equal(f.selects.length,1);
 assert.equal(await f.gate.check(event('bash',{command:"echo 'rm -rf /'"}),f.ctx),undefined);assert.equal(f.calls.length,4);
 const rpc=fixture({mode:'rpc',confirm:async()=>false,select:async()=>assert.fail('select')});assert.equal((await rpc.gate.check(event('bash',{command:'rm -rf /'}),rpc.ctx)).block,true);assert.equal(rpc.calls[0][0],'Confirm catastrophic command');
});
test('RPC keeps the per-call Confirm tool action prompt even when the host has a selector',async()=>{
 const f=fixture({mode:'rpc',select:async()=>assert.fail('select')});assert.equal(await f.gate.check(event('apply_patch',{patch:'p'}),f.ctx),undefined);assert.equal(await f.gate.check(event('apply_patch',{patch:'p'}),f.ctx),undefined);
 assert.equal(f.calls.length,2);assert.equal(f.calls[0][0],'Confirm tool action');assert.match(f.calls[0][1],/modify or overwrite project files\.\nTool annotation hints are unverified\. This approval is for this call only\.$/);
});
test('a selector that times out, is aborted, throws or answers late denies',async t=>{
 const aborted=fixture({select:(_message,_options,{signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve(SESSION('write','write')),{once:true}))});const abort=new AbortController();aborted.ctx.signal=abort.signal;
 const checking=aborted.gate.check(event('write',{path:'x'}),aborted.ctx);queueMicrotask(()=>abort.abort());assert.equal((await checking).block,true);assert.equal(aborted.selects[0][2].signal.aborted,true);
 aborted.ctx.signal=undefined;aborted.ctx.ui.select=async()=>'Deny';assert.equal((await aborted.gate.check(event('write',{path:'x'}),aborted.ctx)).block,true,'an aborted session answer grants nothing');
 const thrown=fixture({select:async()=>{throw Error('UI failed');}});assert.match((await thrown.gate.check(event('write'),thrown.ctx)).reason,/Safety approval failed: UI failed/);
 t.mock.timers.enable({apis:['setTimeout']});let late;const slow=fixture({select:()=>new Promise(resolve=>{late=resolve;})});const pending=slow.gate.check(event('write',{path:'x'}),slow.ctx);await Promise.resolve();
 t.mock.timers.tick(15000);assert.equal((await pending).block,true);late(SESSION('write','write'));t.mock.timers.reset();
 slow.ctx.ui.select=async()=>'Deny';assert.equal((await slow.gate.check(event('write',{path:'x'}),slow.ctx)).block,true,'a late session answer grants nothing');
});
