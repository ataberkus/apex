import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import path from 'node:path';
import {runtimePolicy, SELECTED_MODEL} from '../extensions/apex-context/config.mjs';
import {fileLink} from './fixtures/filesystem.mjs';

const load = () => import('../extensions/apex-core/models.mjs').catch(() => ({}));
const paid = {paid_runs_enabled:true, execution_policy:'paid-enabled', allowed_model:SELECTED_MODEL, thinking_level:'xhigh'};
const usage = (input=2,output=3) => ({input,output,cacheRead:1,cacheWrite:0,totalTokens:999,cost:{input:.01,output:.02,cacheRead:.001,cacheWrite:0,total:999}});
const text = result => result.content.filter(x=>x.type==='text').map(x=>x.text).join('\n');
async function fixture(t) { const cwd=await mkdtemp(path.join(process.cwd(),'.models-test-')); t.after(()=>rm(cwd,{recursive:true,force:true})); return cwd; }
async function exports() {const result=await load(); assert.equal(typeof result.createSubagentTools,'function','model-backed tools factory missing'); return result;}

// Removing a policy check would invoke the sentinel adapters or hostile cwd getter.
test('offline subagent denial precedes prompt reads, cwd access, session and check adapters',async()=>{
 const {createSubagentTools}=await exports(); let called=0;
 const tools=createSubagentTools({policy:runtimePolicy(),runSession:()=>{called++;throw Error('session');},runChecks:()=>{called++;throw Error('checks');}});
 assert.deepEqual(tools.map(x=>x.name),['explore','verify']);
 const ctx={get cwd(){throw Error('cwd accessed before denial');}};
 for(const tool of tools){ const result=await tool.execute('offline',{task:'task',commands:['npm test']},undefined,undefined,ctx); assert.equal(result.isError,true); assert.equal(result.details.status,'blocked'); assert.match(text(result),/offline|authorization/i);assert.equal(result.details.usage.totalTokens,0);}
 assert.equal(called,0);
});

test('future subagents use exact prompt files, independent task-only contexts and depth-one read tools',async t=>{
 const {createSubagentTools}=await exports();const cwd=await fixture(t);const requests=[];
 const tools=createSubagentTools({policy:paid,runSession:async request=>{requests.push(request); return {text:'Evidence',usage:usage()};}});
 for(const tool of tools){const result=await tool.execute('fresh',{task:'explicit task'},undefined,undefined,{cwd,history:['SECRET'],systemPrompt:'INHERITED',assumptions:['WRONG']}); assert.equal(result.isError,undefined);assert.equal(result.details.usage.totalTokens,6);assert.equal(result.details.usage.cost.total,.031);}
 for(const request of requests){assert.equal(request.model,SELECTED_MODEL);assert.equal(request.thinkingLevel,'xhigh');assert.equal(request.depth,1);assert.deepEqual(request.tools,['read','grep','find','ls']);assert.deepEqual(request.history,[]);assert.ok(request.task.startsWith('explicit task'));if(request.kind==='explore')assert.equal(request.task,'explicit task');else assert.match(request.task,/inspect files only/);assert.equal(request.systemPrompt,await readFile(new URL(`../prompts/${request.kind}.md`,import.meta.url),'utf8'));assert.equal(request.maxTurns,8);assert.equal(request.maxOutputBytes,4096);assert.equal(request.cwd,cwd);assert.equal(JSON.stringify(request).includes('SECRET'),false);}
 assert.notEqual(requests[0].history,requests[1].history);
});

test('model and thinking violations are denied before deterministic session work',async()=>{
 const {createSubagentTools}=await exports();let calls=0;
 for(const policy of [{...paid,allowed_model:'other/model'},{...paid,thinking_level:'high'},{...paid,execution_policy:'unauthorized'},{...paid,paid_runs_enabled:false}]){
 const result=await createSubagentTools({policy,runSession:()=>{calls++;}})[0].execute('bad',{task:'task'},undefined,undefined,{cwd:process.cwd()});assert.equal(result.isError,true);
 }assert.equal(calls,0);
});

test('nested subagents and invalid tasks never start a session',async()=>{
 const {createSubagentTools}=await exports();let calls=0;const tool=createSubagentTools({policy:paid,runSession:()=>{calls++;}})[0];
 for(const [params,ctx] of [[{task:'task'},{cwd:process.cwd(),depth:1}],[{task:'task'},{cwd:process.cwd(),subagentDepth:1}],[{task:''},{cwd:process.cwd()}],[{task:'x'.repeat(20001)},{cwd:process.cwd()}]]){const result=await tool.execute('bad',params,undefined,undefined,ctx);assert.equal(result.isError,true);}
 assert.equal(calls,0);
});

test('subagent output and usage are bounded and inconsistent totals are rebuilt',async()=>{
 const {createSubagentTools}=await exports();const tool=createSubagentTools({policy:paid,runSession:async()=>({text:'😀'.repeat(5000),usage:usage(),model:SELECTED_MODEL,thinkingLevel:'xhigh'})})[0];
 const result=await tool.execute('bound',{task:'task'},undefined,undefined,{cwd:process.cwd()});assert.ok(Buffer.byteLength(text(result))<=4096);assert.equal(result.details.truncated,true);assert.equal(result.details.usage.totalTokens,6);assert.equal(result.details.usage.cost.total,.031);
 const invalid=createSubagentTools({policy:paid,runSession:async()=>({text:'ok',usage:{input:Infinity,output:-1,cost:{total:Infinity}}})})[0];assert.equal((await invalid.execute('invalid',{task:'task'},undefined,undefined,{cwd:process.cwd()})).isError,true);
});

test('subagent cancellation is reported coherently and retains incurred usage',async()=>{
 const {createSubagentTools}=await exports();const controller=new AbortController();controller.abort();let calls=0;
 const tool=createSubagentTools({policy:paid,runSession:()=>{calls++;}})[0];const result=await tool.execute('aborted',{task:'task'},controller.signal,undefined,{cwd:process.cwd()});assert.equal(result.details.status,'aborted');assert.equal(calls,0);
 const running=new AbortController();const other=createSubagentTools({policy:paid,runSession:async()=>{running.abort();return {text:'partial',usage:usage()};}})[0];const partial=await other.execute('partial',{task:'task'},running.signal,undefined,{cwd:process.cwd()});assert.equal(partial.details.status,'aborted');assert.equal(partial.details.usage.totalTokens,6);
});

test('verify explicit commands provide real bounded evidence without inheriting main history',async()=>{
 const {createSubagentTools}=await exports();let received;const verify=createSubagentTools({policy:paid,runChecks:async request=>{assert.deepEqual(request.commands,['node --test tests/unit.test.mjs']);return [{command:request.commands[0],exitCode:1,output:'failure evidence',durationMs:12}];},runSession:async request=>{received=request;return {text:'VERDICT: FAIL',usage:usage()};}})[1];
 assert.equal(verify.parameters.properties.commands.maxItems,4);const result=await verify.execute('verify',{task:'requirements',commands:['node --test tests/unit.test.mjs']},undefined,undefined,{cwd:process.cwd(),history:['secret']});assert.match(received.task,/failure evidence/);assert.equal(received.task.includes('secret'),false);assert.equal(result.details.checks[0].exitCode,1);assert.equal(result.details.checks[0].command,'node --test tests/unit.test.mjs');
});

test('verify rejects shell syntax, installs and unbounded command lists before adapters',async()=>{
 const {createSubagentTools}=await exports();let calls=0;const verify=createSubagentTools({policy:paid,runChecks:()=>{calls++;},runSession:()=>{calls++;}})[1];
 for(const commands of [['npm install'],['node --test; echo bad'],['npm test $(secret)'],['curl example.test'],Array(5).fill('npm test')]){const result=await verify.execute('unsafe',{task:'requirements',commands},undefined,undefined,{cwd:process.cwd()});assert.equal(result.isError,true);}
 assert.equal(calls,0);
});

test('offline max denial precedes isolation, attempts, verification, judge and cwd reads',async()=>{
 const {runMaxAttempts}=await exports();let calls=0;const options={policy:runtimePolicy(),get cwd(){throw Error('cwd accessed');},task:'task',createIsolation:()=>{calls++;},runAttempt:()=>{calls++;},verifyAttempt:()=>{calls++;},judge:()=>{calls++;}};
 await assert.rejects(runMaxAttempts(options),/offline|authorization/i);assert.equal(calls,0);
});

test('max ranks successful verification above score and sums nested usage before cleanup',async()=>{
 const {runMaxAttempts}=await exports();const cleaned=[],seen=[];let judged=0;
 const result=await runMaxAttempts({policy:paid,cwd:process.cwd(),task:'task',attempts:3,createIsolation:async({index})=>({cwd:`/candidate/${index}`,cleanup:async()=>cleaned.push(index)}),runAttempt:async request=>{seen.push(request);return {text:`candidate ${request.index}`,usage:usage()};},verifyAttempt:async({index})=>({passed:index!==0,score:index===0?999:index,usage:usage(1,1)}),judge:()=>{judged++;}});
 assert.equal(result.configuration,'max');assert.equal(result.winner.index,2);assert.equal(result.candidates.length,3);assert.equal(result.usage.totalTokens,27);assert.deepEqual(cleaned,[2,1,0]);assert.equal(judged,0);assert.deepEqual(seen.map(x=>x.cwd),['/candidate/0','/candidate/1','/candidate/2']);for(const x of seen){assert.equal(x.model,SELECTED_MODEL);assert.equal(x.thinkingLevel,'xhigh');assert.deepEqual(x.history,[]);}assert.notEqual(seen[0].history,seen[1].history);
});

test('max uses guarded judge only for tied passing candidates and includes its usage',async()=>{
 const {runMaxAttempts}=await exports();let request;
 const result=await runMaxAttempts({policy:paid,cwd:process.cwd(),task:'task',createIsolation:async({index})=>({cwd:`/tie/${index}`,cleanup:async()=>{}}),runAttempt:async()=>({text:'candidate',usage:usage()}),verifyAttempt:async()=>({passed:true,score:1}),judge:async args=>{request=args;return {index:1,usage:usage()};}});
 assert.equal(result.winner.index,1);assert.equal(result.usage.totalTokens,18);assert.equal(request.candidates.length,2);assert.equal(request.model,SELECTED_MODEL);assert.equal(request.thinkingLevel,'xhigh');assert.deepEqual(request.history,[]);
});

test('max refuses malformed judge selections and cleans every candidate',async()=>{
 const {runMaxAttempts}=await exports();let cleaned=0;
 await assert.rejects(runMaxAttempts({policy:paid,cwd:process.cwd(),task:'task',createIsolation:async({index})=>({cwd:`/bad/${index}`,cleanup:async()=>{cleaned++;}}),runAttempt:async()=>({text:'candidate',usage:usage()}),verifyAttempt:async()=>({passed:true}),judge:async()=>({index:99,usage:usage()})}),/judge/i);assert.equal(cleaned,2);
});

test('all failed candidates remain failed without invoking judge',async()=>{
 const {runMaxAttempts}=await exports();let judges=0;const result=await runMaxAttempts({policy:paid,cwd:process.cwd(),task:'task',createIsolation:async({index})=>({cwd:`/fail/${index}`,cleanup:async()=>{}}),runAttempt:async()=>({text:'candidate'}),verifyAttempt:async()=>({passed:false,score:10}),judge:()=>{judges++;}});assert.equal(result.winner,null);assert.equal(result.status,'failed');assert.equal(judges,0);
});

test('max attempts are bounded and fail before isolation on bad policy/configuration',async()=>{
 const {runMaxAttempts}=await exports();let calls=0;for(const attempts of [0,6,2.5])await assert.rejects(runMaxAttempts({policy:paid,cwd:process.cwd(),task:'task',attempts,createIsolation:()=>{calls++;},runAttempt:async()=>{},verifyAttempt:async()=>{}}),/attempts/);assert.equal(calls,0);
 await assert.rejects(runMaxAttempts({policy:{...paid,thinking_level:'low'},cwd:process.cwd(),task:'task',createIsolation:()=>{calls++;}}),/xhigh/);assert.equal(calls,0);
});

test('max cancellation and attempt errors retain usage and clean allocated isolation',async()=>{
 const {runMaxAttempts}=await exports();const controller=new AbortController();let cleaned=0;let attempts=0;
 await assert.rejects(runMaxAttempts({policy:paid,cwd:process.cwd(),task:'task',signal:controller.signal,createIsolation:async()=>({cwd:'/abort/0',cleanup:async()=>{cleaned++;}}),runAttempt:async()=>{attempts++;controller.abort();return {text:'partial',usage:usage()};},verifyAttempt:()=>assert.fail('verification after cancellation')}),error=>error.name==='AbortError'&&error.usage.totalTokens===6);assert.equal(attempts,1);assert.equal(cleaned,1);
 const failed=Error('attempt failed');failed.usage=usage();await assert.rejects(runMaxAttempts({policy:paid,cwd:process.cwd(),task:'task',createIsolation:async()=>({cwd:'/failure/0',cleanup:async()=>{cleaned++;}}),runAttempt:async()=>{throw failed;},verifyAttempt:async()=>({passed:true})}),error=>error.message==='attempt failed'&&error.usage.totalTokens===6);assert.equal(cleaned,2);
});

test('max default copies isolate current source changes and cleanup owned directories',async t=>{
 const {runMaxAttempts}=await exports();const cwd=await fixture(t);await writeFile(path.join(cwd,'source.txt'),'source');await mkdir(path.join(cwd,'.apex'));await writeFile(path.join(cwd,'.apex','sensitive.log'),'omit');const copies=[];
 const result=await runMaxAttempts({policy:paid,cwd,task:'task',runAttempt:async request=>{copies.push(request.cwd);assert.equal(await readFile(path.join(request.cwd,'source.txt'),'utf8'),'source');await assert.rejects(readFile(path.join(request.cwd,'.apex','sensitive.log')));await writeFile(path.join(request.cwd,'source.txt'),`candidate${request.index}`);return {text:'changed'};},verifyAttempt:async({index,cwd:copy})=>({passed:(await readFile(path.join(copy,'source.txt'),'utf8'))===`candidate${index}`,score:index})});
 assert.equal(result.winner.index,1);assert.equal(await readFile(path.join(cwd,'source.txt'),'utf8'),'source');assert.notEqual(copies[0],copies[1]);for(const copy of copies)await assert.rejects(readFile(path.join(copy,'source.txt')));
});

test('recovery native settings are disabled offline and bounded only under exact paid policy',async()=>{
 const {recoverySettings}=await exports();assert.equal(typeof recoverySettings,'function');const off=recoverySettings({policy:runtimePolicy(),maxRetries:99,baseDelayMs:Infinity});assert.equal(off.retry.enabled,false);assert.equal(off.retry.maxRetries,0);assert.equal(off.retry.provider.maxRetries,0);
 const enabled=recoverySettings({policy:paid,maxRetries:2,baseDelayMs:1000});assert.deepEqual(enabled.retry,{enabled:true,maxRetries:2,baseDelayMs:1000,maxAgentDelayMs:8000,provider:{maxRetries:0,maxRetryDelayMs:8000,timeoutMs:60000}});
 for(const maxRetries of [-1,4,1.2])assert.throws(()=>recoverySettings({policy:paid,maxRetries}),/retries/i);for(const baseDelayMs of [0,10001,Infinity])assert.throws(()=>recoverySettings({policy:paid,baseDelayMs}),/delay/i);assert.throws(()=>recoverySettings({policy:{...paid,allowed_model:'bad'}}),/model/i);
});

test('default verifier checks run real subprocesses inside a copy and preserve source files',async t=>{
 const {createSubagentTools}=await exports();const cwd=await fixture(t);await writeFile(path.join(cwd,'data.txt'),'original');await writeFile(path.join(cwd,'check.test.mjs'),"import {test} from 'bun:test';import {writeFileSync} from 'node:fs';test('isolated modification',()=>{writeFileSync('data.txt','modified');console.log('REAL CHECK EVIDENCE');});");let request;
 const verify=createSubagentTools({policy:paid,runSession:async value=>{request=value;return {text:'VERDICT: PASS',usage:usage()};}})[1];const result=await verify.execute('checks',{task:'requirement',commands:['bun test check.test.mjs']},undefined,undefined,{cwd});assert.equal(result.details.status,'complete');assert.equal(result.details.checks[0].exitCode,0);assert.match(request.task,/REAL CHECK EVIDENCE/);assert.equal(await readFile(path.join(cwd,'data.txt'),'utf8'),'original');
});

test('max rejects reused/source isolation paths and preserves cleanup errors',async()=>{
 const {runMaxAttempts}=await exports();let calls=0;const options={policy:paid,cwd:process.cwd(),task:'task',runAttempt:async()=>{calls++;return {text:'task'};},verifyAttempt:async()=>({passed:true,score:calls}),createIsolation:async()=>({cwd:process.cwd(),cleanup:async()=>{}})};await assert.rejects(runMaxAttempts(options),/distinct isolated/);assert.equal(calls,0);
 options.createIsolation=async()=>({cwd:'/unique/path',cleanup:async()=>{}});await assert.rejects(runMaxAttempts(options),/distinct isolated/);assert.equal(calls,1);
 options.attempts=1;options.createIsolation=async()=>({cwd:'/unique/path',cleanup:async()=>{throw Error('cleanup fault');}});await assert.rejects(runMaxAttempts(options),error=>error instanceof AggregateError&&error.message.includes('cleanup')&&error.usage.totalTokens===0);
});

test('native recovery application gates before session access and applies only supported settings seam',async()=>{
 const {applyRecoverySettings}=await exports();assert.equal(typeof applyRecoverySettings,'function');const hostile={get settingsManager(){throw Error('native session accessed');}};assert.equal(applyRecoverySettings(hostile,{policy:runtimePolicy()}).applied,false);let applied;const session={settingsManager:{applyOverrides:value=>{applied=value;}}};const result=applyRecoverySettings(session,{policy:paid,maxRetries:2,baseDelayMs:1000});assert.equal(result.applied,true);assert.deepEqual(applied,result.settings);assert.equal(applied.retry.maxRetries,2);assert.equal(applied.retry.provider.maxRetries,0);assert.throws(()=>applyRecoverySettings({}, {policy:paid}),/native.*settings/i);
});

test('native future SDK injection cannot fall through to default runtime or provider auth',async t=>{
 const {createSubagentTools}=await exports();const cwd=await fixture(t);
 let calls=0;const sentinel=createSubagentTools({policy:paid,loadSdk:async()=>{calls++;throw Error('NATIVE_SDK_SENTINEL');}})[0];const blocked=await sentinel.execute('sentinel',{task:'task'},undefined,undefined,{cwd});assert.equal(text(blocked),'NATIVE_SDK_SENTINEL');assert.equal(calls,1);
 const offline=createSubagentTools({policy:runtimePolicy(),loadSdk:async()=>assert.fail('SDK after offline policy')})[0];assert.equal((await offline.execute('offline',{task:'task'},undefined,undefined,{cwd})).details.status,'blocked');
});

test('stub-only native future path suppresses ambient resources and binds before prompting',async t=>{
 const {createSubagentTools}=await exports();const cwd=await fixture(t);await writeFile(path.join(cwd,'AGENTS.md'),'FORBIDDEN PROJECT HISTORY');await mkdir(path.join(cwd,'.pi'));await writeFile(path.join(cwd,'.pi','settings.json'),'{"cacheWarming":"idle","extensions":["./hostile.mjs"]}');
 // Real settings/resource/tool constructors are pure. All runtime/session/provider methods are stubs.
 const real=await import('@earendil-works/pi-coding-agent');const captures=[];let promptCalls=0;let listener;let session;
 const model={provider:'openrouter',id:'meta/muse-spark-1.3-contributor',api:'openai-completions',thinkingLevelMap:{xhigh:'xhigh'}};
 const runtime={getModel:()=>model,getAuth:()=>assert.fail('native auth invoked')};
 const loadSdk=async()=>({...real,ModelRuntime:{create:async options=>{assert.equal(options.modelsPath,null);assert.equal(options.allowModelNetwork,false);assert.equal(options.refreshOnCreate,false);return runtime;}},createAgentSession:async options=>{
   captures.push(options);assert.notEqual(options.modelRuntime,runtime);assert.equal(options.modelRuntime.getModel('openrouter','meta/muse-spark-1.3-contributor'),model);assert.equal(options.model,model);
   session={model,thinkingLevel:'xhigh',messages:[],bindExtensions:async()=>{options.resourceLoader.extendResources({skillPaths:[],promptPaths:[],themePaths:[]});captures.push({bound:true});},subscribe:callback=>{listener=callback;return()=>{};},prompt:async task=>{assert.equal(captures[1].bound,true);promptCalls++;assert.match(task,/explicit task/);const message={role:'assistant',content:[{type:'text',text:'native fixture evidence'}],usage:usage(),stopReason:'stop'};session.messages.push(message);listener({type:'message_end',message});},abort:async()=>{},dispose:()=>{}};return {session};
 }});
 const result=await createSubagentTools({policy:paid,loadSdk})[0].execute('native',{task:'explicit task'},undefined,undefined,{cwd});assert.equal(result.details.status,'complete',text(result));assert.equal(promptCalls,1);assert.equal(result.details.usage.totalTokens,6);assert.equal(captures[1].bound,true);
 const options=captures[0];assert.deepEqual(options.tools,['read','grep','find','ls']);assert.equal(options.sessionManager.getSessionFile(),undefined);assert.equal(options.settingsManager.getCacheWarmingMode(),'off');assert.equal(options.settingsManager.getRetrySettings().enabled,false);assert.equal(options.settingsManager.getProviderRetrySettings().maxRetries,0);assert.deepEqual(options.resourceLoader.getAgentsFiles().agentsFiles,[]);assert.deepEqual(options.resourceLoader.getSkills().skills,[]);assert.deepEqual(options.resourceLoader.getPrompts().prompts,[]);assert.deepEqual(options.resourceLoader.getExtensions().extensions,[]);assert.equal(options.resourceLoader.getSystemPrompt(),await readFile(new URL('../prompts/explore.md',import.meta.url),'utf8'));assert.equal(options.customTools.some(tool=>['bash','write','edit','explore','verify'].includes(tool.name)),false);
});

test('default max copies preserve internal symlinks without shared writes and reject external links',async t=>{
 const {runMaxAttempts}=await exports();const cwd=await fixture(t);await writeFile(path.join(cwd,'target.txt'),'original');if(!await fileLink(t,'target.txt',path.join(cwd,'link.txt')))return;
 const result=await runMaxAttempts({policy:paid,cwd,task:'task',attempts:1,runAttempt:async({cwd:copy})=>{await writeFile(path.join(copy,'link.txt'),'candidate');return {text:'candidate'};},verifyAttempt:async({cwd:copy})=>({passed:(await readFile(path.join(copy,'target.txt'),'utf8'))==='candidate'})});assert.equal(result.status,'complete');assert.equal(await readFile(path.join(cwd,'target.txt'),'utf8'),'original');if(!await fileLink(t,path.join(process.cwd(),'package.json'),path.join(cwd,'external.json')))return;let attempts=0;await assert.rejects(runMaxAttempts({policy:paid,cwd,task:'task',attempts:1,runAttempt:()=>{attempts++;},verifyAttempt:()=>{}}),/external symlinks/);assert.equal(attempts,0);
});

test('native future read tools confine paths and honor installed bounded read/search semantics',async t=>{
 const {createSubagentTools}=await exports();const cwd=await fixture(t);await writeFile(path.join(cwd,'file.txt'),'needle\nsecond\n');let definitions;
 const real=await import('@earendil-works/pi-coding-agent');const model={provider:'openrouter',id:'meta/muse-spark-1.3-contributor',api:'openai-completions',thinkingLevelMap:{xhigh:'xhigh'}};const runtime={getModel:()=>model,getAuth:()=>assert.fail('auth')};const fake={model,thinkingLevel:'xhigh',messages:[{role:'assistant',content:[{type:'text',text:'fixture'}],stopReason:'stop'}],bindExtensions:async()=>{},subscribe:()=>()=>{},prompt:async()=>{},abort:async()=>{},dispose:()=>{}};
 const loadSdk=async()=>({...real,ModelRuntime:{create:async()=>runtime},createAgentSession:async options=>{definitions=options.customTools;return {session:fake};}});const result=await createSubagentTools({policy:paid,loadSdk})[0].execute('definitions',{task:'task'},undefined,undefined,{cwd});assert.equal(result.details.status,'complete');
 const read=definitions.find(tool=>tool.name==='read');assert.match(text(await read.execute('read',{path:'file.txt',offset:1,limit:1})),/^needle/);await assert.rejects(read.execute('absolute',{path:path.join(process.cwd(),'package.json')}),/inside the repository/);
 await t.test('native read rejects outside file link',async t=>{
  if(!await fileLink(t,path.join(process.cwd(),'package.json'),path.join(cwd,'outside.json')))return;
  await assert.rejects(read.execute('outside',{path:'outside.json'}),/inside the repository/);
 });
 const grep=definitions.find(tool=>tool.name==='grep');assert.match(text(await grep.execute('grep',{path:'.',pattern:'needle',literal:true})),/file.txt:1:needle/);const find=definitions.find(tool=>tool.name==='find');assert.match(text(await find.execute('find',{path:'.',pattern:'*.txt'})),/file.txt/);
});

test('native future turn bound aborts tool loops and retains all partial usage',async t=>{
 const {createSubagentTools}=await exports();const cwd=await fixture(t);const real=await import('@earendil-works/pi-coding-agent');const model={provider:'openrouter',id:'meta/muse-spark-1.3-contributor',api:'openai-completions',thinkingLevelMap:{xhigh:'xhigh'}};let listener;let stopped=false;let disposed=false;const message={role:'assistant',content:[{type:'text',text:'partial'}],usage:usage(),stopReason:'toolUse'};
 const fake={model,thinkingLevel:'xhigh',messages:[message],bindExtensions:async()=>{},subscribe:callback=>{listener=callback;return()=>{};},prompt:async()=>{for(let index=0;index<20&&!stopped;index++){listener({type:'message_end',message});listener({type:'turn_end',message});}},abort:async()=>{stopped=true;},dispose:()=>{disposed=true;}};
 const loadSdk=async()=>({...real,ModelRuntime:{create:async()=>({getModel:()=>model,getAuth:()=>assert.fail('auth')})},createAgentSession:async()=>({session:fake})});const result=await createSubagentTools({policy:paid,loadSdk})[0].execute('bounded',{task:'task'},undefined,undefined,{cwd});assert.equal(result.details.status,'error');assert.match(text(result),/eight-turn/);assert.equal(result.details.usage.totalTokens,48);assert.equal(stopped,true);assert.equal(disposed,true);
});

test('verify rejects native test flags that open listeners or inject arbitrary startup modules',async()=>{
 const {createSubagentTools}=await exports();let calls=0;const verify=createSubagentTools({policy:paid,runChecks:async()=>{calls++;return [];},runSession:async()=>{calls++;return {text:'pass'};}})[1];for(const command of ['node --test --inspect=0 check.test.mjs','node --test --loader loader.mjs','node --test -r module.mjs','bun test --inspect=0 check.test.mjs','bun test --preload module.mjs','bun --inspect test','bun run dev','pytest -p arbitrary_plugin']){const result=await verify.execute('flags',{task:'task',commands:[command]},undefined,undefined,{cwd:process.cwd()});assert.equal(result.details.status,'error');}assert.equal(calls,0);
});

test('native future session may finish successfully on its eighth final turn',async t=>{
 const {createSubagentTools}=await exports();const cwd=await fixture(t);const real=await import('@earendil-works/pi-coding-agent');const model={provider:'openrouter',id:'meta/muse-spark-1.3-contributor',api:'openai-completions',thinkingLevelMap:{xhigh:'xhigh'}};let listener;let stopped=false;const fake={model,thinkingLevel:'xhigh',messages:[],bindExtensions:async()=>{},subscribe:callback=>{listener=callback;return()=>{};},prompt:async()=>{for(let index=0;index<8&&!stopped;index++){const message={role:'assistant',content:[{type:'text',text:index===7?'final answer':'partial'}],usage:usage(),stopReason:index===7?'stop':'toolUse'};fake.messages.push(message);listener({type:'message_end',message});listener({type:'turn_end',message});}},abort:async()=>{stopped=true;},dispose:()=>{}};const loadSdk=async()=>({...real,ModelRuntime:{create:async()=>({getModel:()=>model})},createAgentSession:async()=>({session:fake})});const result=await createSubagentTools({policy:paid,loadSdk})[0].execute('eighth',{task:'task'},undefined,undefined,{cwd});assert.equal(result.details.status,'complete');assert.equal(text(result),'final answer');assert.equal(result.details.usage.totalTokens,48);
});

test('native future cleanup disposes even after abort failure and preserves incurred usage',async t=>{
 const {createSubagentTools}=await exports();const cwd=await fixture(t);const real=await import('@earendil-works/pi-coding-agent');const model={provider:'openrouter',id:'meta/muse-spark-1.3-contributor',api:'openai-completions',thinkingLevelMap:{xhigh:'xhigh'}};let listener;let disposed=false;const message={role:'assistant',content:[{type:'text',text:'answer'}],stopReason:'stop',usage:usage()};const fake={model,thinkingLevel:'xhigh',messages:[message],bindExtensions:async()=>{},subscribe:callback=>{listener=callback;return()=>{};},prompt:async()=>{listener({type:'message_end',message});},abort:async()=>{throw Error('abort cleanup fault');},dispose:()=>{disposed=true;}};const loadSdk=async()=>({...real,ModelRuntime:{create:async()=>({getModel:()=>model})},createAgentSession:async()=>({session:fake})});const result=await createSubagentTools({policy:paid,loadSdk})[0].execute('cleanup',{task:'task'},undefined,undefined,{cwd});assert.equal(disposed,true);assert.equal(result.details.status,'error');assert.equal(result.details.usage.totalTokens,6);assert.match(text(result),/cleanup/i);
});

test('native SDK rechecks policy before auth and streaming on every fresh-context turn',async t=>{
 const {createSubagentTools}=await exports();const cwd=await fixture(t);const real=await import('@earendil-works/pi-coding-agent');const policy={...paid};const model={provider:'openrouter',id:'meta/muse-spark-1.3-contributor',api:'openai-completions',thinkingLevelMap:{xhigh:'xhigh'}};let authCalls=0;let streams=0;let listener;let session;
 const runtime={getModel:()=>model,getAuth:async()=>{authCalls++;return {auth:{}};},streamSimple:async function(model,_context,options){await this.getAuth(model,{signal:options.signal});streams++;return {text:'first turn',usage:usage()};}};
 const loadSdk=async()=>({...real,ModelRuntime:{create:async()=>runtime},createAgentSession:async options=>{session={model,thinkingLevel:'xhigh',messages:[],bindExtensions:async()=>{},subscribe:callback=>{listener=callback;return()=>{};},prompt:async()=>{for(let index=0;index<2;index++){const value=await options.modelRuntime.streamSimple(model,{messages:[]},{reasoning:'xhigh'});const message={role:'assistant',content:[{type:'text',text:value.text}],usage:value.usage,stopReason:'toolUse'};session.messages.push(message);listener({type:'message_end',message});listener({type:'turn_end',message});policy.execution_policy='offline-only';policy.paid_runs_enabled=false;}},abort:async()=>{},dispose:()=>{}};return {session};}});
 const result=await createSubagentTools({policy,loadSdk})[0].execute('revoked',{task:'task'},undefined,undefined,{cwd});assert.equal(streams,1);assert.equal(authCalls,1);assert.equal(result.details.status,'blocked');assert.equal(result.details.usage.totalTokens,6);assert.equal(result.details.apexAux.attempted,true);assert.equal(result.details.apexAux.complete,false);
});

test('native SDK validates physical model, reasoning and cancellation before each request seam',async t=>{
 const {createSubagentTools}=await exports();const cwd=await fixture(t);const real=await import('@earendil-works/pi-coding-agent');const model={provider:'openrouter',id:'meta/muse-spark-1.3-contributor',api:'openai-completions',thinkingLevelMap:{xhigh:'xhigh'}};
 for(const mode of ['model','reasoning','signal']){let streams=0;let authCalls=0;const controller=new AbortController();const runtime={getModel:()=>model,getAuth:async()=>{authCalls++;return {};},streamSimple:()=>{streams++;return {};}};const fake={model,thinkingLevel:'xhigh',messages:[],bindExtensions:async()=>{},subscribe:()=>()=>{},prompt:async()=>{if(mode==='signal')controller.abort();return runtimeSeam.streamSimple(mode==='model'?{...model,id:'other'}:model,{messages:[]},{reasoning:mode==='reasoning'?'high':'xhigh',signal:controller.signal});},abort:async()=>{},dispose:()=>{}};let runtimeSeam;const loadSdk=async()=>({...real,ModelRuntime:{create:async()=>runtime},createAgentSession:async options=>{runtimeSeam=options.modelRuntime;return {session:fake};}});const result=await createSubagentTools({policy:paid,loadSdk})[0].execute(mode,{task:'task'},controller.signal,undefined,{cwd});assert.equal(streams,0,mode);assert.equal(authCalls,0,mode);assert.equal(result.isError,true);}
});

test('auxiliary usage reaches native tool-result events while pre-call denials omit usage',async t=>{
 const {createSubagentTools}=await exports();const cwd=await fixture(t);const real=await import('@earendil-works/pi-coding-agent');const tool=createSubagentTools({policy:paid,runSession:async()=>({text:'helper result',usage:usage()})})[0];const result=await tool.execute('usage',{task:'task'},undefined,undefined,{cwd});assert.deepEqual(result.usage,result.details.usage);assert.deepEqual(result.details.apexAux,{version:1,kind:'explore',provider:'openrouter',model:'meta/muse-spark-1.3-contributor',attempted:true,complete:true});let event;
 await real.AgentSession.prototype._afterToolCall.call({_extensionRunner:{hasHandlers:name=>name==='tool_result',emitToolResult:async value=>{event=value;}},_limitsModel:()=>undefined,settingsManager:{getImageAutoResize:()=>false}},{toolCall:{id:'usage',name:'explore'},args:{task:'task'},result,isError:false},'parent');assert.equal(event.type,'tool_result');assert.equal(event.parentToolCallId,'parent');assert.equal(event.usage.totalTokens,6);assert.deepEqual(event.details.apexAux,result.details.apexAux);
 const manager=real.SessionManager.inMemory(cwd);manager.appendMessage({role:'toolResult',toolCallId:event.toolCallId,toolName:event.toolName,content:event.content,details:event.details,usage:event.usage,isError:event.isError,timestamp:0});assert.equal(manager.getBranch().at(-1).message.usage.totalTokens,6);
 const blocked=await createSubagentTools({policy:runtimePolicy(),runSession:()=>assert.fail('session')})[0].execute('blocked',{task:'task'},undefined,undefined,{cwd});assert.equal(blocked.usage,undefined);assert.equal(blocked.details.apexAux.attempted,false);assert.equal(blocked.details.apexAux.complete,false);
});

test('missing helper usage remains explicitly incomplete and preserves known optional subsets',async()=>{
 const {createSubagentTools}=await exports();const missing=await createSubagentTools({policy:paid,runSession:async()=>({text:'unknown accounting'})})[0].execute('missing',{task:'task'},undefined,undefined,{cwd:process.cwd()});assert.equal(missing.details.apexAux.attempted,true);assert.equal(missing.details.apexAux.complete,false);assert.equal(missing.usage.totalTokens,0);
 const withSubsets={...usage(),reasoning:2,cacheWrite:3,cacheWrite1h:2};const result=await createSubagentTools({policy:paid,runSession:async()=>({text:'known accounting',usage:withSubsets})})[1].execute('subsets',{task:'task'},undefined,undefined,{cwd:process.cwd()});assert.equal(result.usage.reasoning,2);assert.equal(result.usage.cacheWrite1h,2);assert.equal(result.usage.totalTokens,9);assert.equal(result.usage.output,3);assert.equal(result.details.apexAux.complete,true);
});

test('max optional token subsets aggregate only when known for every accounting source',async()=>{
 const {runMaxAttempts}=await exports();const components={...usage(),reasoning:2,cacheWrite:3,cacheWrite1h:1};const args={policy:paid,cwd:process.cwd(),task:'task',attempts:1,createIsolation:async()=>({cwd:'/optional-copy',cleanup:async()=>{}}),runAttempt:async()=>({text:'candidate',usage:components}),verifyAttempt:async()=>({passed:true,usage:components})};const known=await runMaxAttempts(args);assert.equal(known.usage.reasoning,4);assert.equal(known.usage.cacheWrite1h,2);assert.equal(known.usage.output,6);assert.equal(known.usage.totalTokens,18);
 args.verifyAttempt=async()=>({passed:true,usage:usage()});const unknown=await runMaxAttempts(args);assert.equal(unknown.usage.reasoning,undefined);assert.equal(unknown.usage.cacheWrite1h,undefined);assert.equal(unknown.usage.totalTokens,15);
});

test('zero helper accounting is explicitly incomplete rather than evidence of a free request',async()=>{
 const {createSubagentTools}=await exports();const zero={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};const result=await createSubagentTools({policy:paid,runSession:async()=>({text:'unmeasured response',usage:zero})})[0].execute('zero',{task:'task'},undefined,undefined,{cwd:process.cwd()});assert.equal(result.details.apexAux.attempted,true);assert.equal(result.details.apexAux.complete,false);assert.deepEqual(result.usage,zero);
});

test('policy revoked during async auth preparation stops provider dispatch in the same turn',async t=>{
 const {createSubagentTools}=await exports();const cwd=await fixture(t);const real=await import('@earendil-works/pi-coding-agent');const policy={...paid};const model={provider:'openrouter',id:'meta/muse-spark-1.3-contributor',api:'openai-completions',thinkingLevelMap:{xhigh:'xhigh'}};let auth=0;let dispatch=0;const runtime={getModel:()=>model,getAuth:async()=>{auth++;policy.execution_policy='offline-only';policy.paid_runs_enabled=false;return {auth:{}};},streamSimple:async function(model,_context,options){await this.getAuth(model,options);dispatch++;return {text:'forbidden'};}};let seam;const fake={model,thinkingLevel:'xhigh',messages:[],bindExtensions:async()=>{},subscribe:()=>()=>{},prompt:async()=>seam.streamSimple(model,{messages:[]},{reasoning:'xhigh'}),abort:async()=>{},dispose:()=>{}};const loadSdk=async()=>({...real,ModelRuntime:{create:async()=>runtime},createAgentSession:async options=>{seam=options.modelRuntime;return {session:fake};}});const result=await createSubagentTools({policy,loadSdk})[0].execute('prepare',{task:'task'},undefined,undefined,{cwd});assert.equal(auth,1);assert.equal(dispatch,0);assert.equal(result.details.status,'blocked');assert.equal(result.details.apexAux.complete,false);
});

test('serialized max results retain explicit accounting completeness for every adapter source',async()=>{
 const {runMaxAttempts}=await exports();const base={policy:paid,cwd:process.cwd(),task:'task',attempts:1,createIsolation:async()=>({cwd:'/serialized-max',cleanup:async()=>{}}),runAttempt:async()=>({text:'candidate',usage:usage()}),verifyAttempt:async()=>({passed:true,usage:usage()})};
 const known=JSON.parse(JSON.stringify(await runMaxAttempts(base)));assert.equal(known.usageComplete,true);assert.equal(known.usage.totalTokens,12);assert.equal(known.candidates[0].usageComplete,true);
 const missingAttempt=JSON.parse(JSON.stringify(await runMaxAttempts({...base,runAttempt:async()=>({text:'candidate'})})));assert.equal(missingAttempt.usageComplete,false);assert.equal(missingAttempt.candidates[0].usageComplete,false);assert.equal(missingAttempt.usage.totalTokens,6);
 const missingVerify=JSON.parse(JSON.stringify(await runMaxAttempts({...base,verifyAttempt:async()=>({passed:true})})));assert.equal(missingVerify.usageComplete,false);assert.equal(missingVerify.usage.totalTokens,6);
 const zero={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};const zeroResult=JSON.parse(JSON.stringify(await runMaxAttempts({...base,runAttempt:async()=>({text:'candidate',usage:zero})})));assert.equal(zeroResult.usageComplete,false);
 const failed=JSON.parse(JSON.stringify(await runMaxAttempts({...base,verifyAttempt:async()=>({passed:false,usage:usage()})})));assert.equal(failed.status,'failed');assert.equal(failed.usageComplete,true);
});

test('max exception serialization preserves missing callback accounting and known incurred usage',async()=>{
 const {runMaxAttempts}=await exports();const base={policy:paid,cwd:process.cwd(),task:'task',attempts:1,createIsolation:async()=>({cwd:'/exception-max',cleanup:async()=>{}}),runAttempt:async()=>({text:'candidate',usage:usage()}),verifyAttempt:async()=>{throw Error('unmeasured verification failure');}};
 await assert.rejects(runMaxAttempts(base),error=>{const serialized=JSON.parse(JSON.stringify(error));return serialized.usageComplete===false&&serialized.usage.totalTokens===6;});
 await assert.rejects(runMaxAttempts({...base,runAttempt:async()=>{const error=Error('known attempt failure');error.usage=usage();throw error;}}),error=>error.usageComplete===true&&error.usage.totalTokens===6);
 await assert.rejects(runMaxAttempts({...base,createIsolation:async()=>({cwd:'/exception-max',cleanup:async()=>{throw Error('cleanup');}}),verifyAttempt:async()=>({passed:true,usage:usage()})}),error=>error.usageComplete===true&&error.usage.totalTokens===12);
 await assert.rejects(runMaxAttempts({policy:runtimePolicy(),get cwd(){assert.fail('offline cwd read');}}),error=>error.usageComplete===false&&error.usage===undefined);
});

test('explore tasks run concurrently in fresh contexts, settle independently and sum usage',async()=>{
 const {createSubagentTools}=await exports();let active=0;let peak=0;let release;const gate=new Promise(resolve=>{release=resolve;});const requests=[];
 const explore=createSubagentTools({policy:paid,runSession:async request=>{requests.push(request);active++;peak=Math.max(peak,active);if(active===3)release();await Promise.race([gate,new Promise(resolve=>setTimeout(resolve,2000))]);active--;
  if(request.task==='fails'){const error=Error('boom');error.usage=usage(1,1);throw error;}return {text:`found ${request.task}`,usage:usage()};}})[0];
 const result=await explore.execute('batch',{tasks:['alpha','fails','gamma']},undefined,undefined,{cwd:process.cwd()});
 assert.equal(peak,3);assert.equal(requests.length,3);
 assert.equal(new Set(requests.map(request=>request.history)).size,3);assert.ok(requests.every(request=>request.history.length===0&&request.depth===1));
 assert.equal(result.isError,undefined);assert.equal(result.details.status,'complete');
 assert.equal(text(result),'## Task 1: complete\nfound alpha\n\n## Task 2: error\nboom\n\n## Task 3: complete\nfound gamma');
 assert.deepEqual(result.details.tasks.map(task=>task.status),['complete','error','complete']);
 assert.equal(result.details.usage.totalTokens,15);assert.equal(result.usage.totalTokens,15);assert.equal(result.details.apexAux.complete,false);
 const all=await createSubagentTools({policy:paid,runSession:async()=>({text:'x'.repeat(10000),usage:usage()})})[0].execute('all',{tasks:['a','b','c','d']},undefined,undefined,{cwd:process.cwd()});
 assert.equal(all.details.apexAux.complete,true);assert.equal(all.details.truncated,true);assert.ok(Buffer.byteLength(text(all))<=16384);assert.equal(all.details.usage.totalTokens,24);
});

test('explore batch reports an error only when every task fails',async()=>{
 const {createSubagentTools}=await exports();
 const result=await createSubagentTools({policy:paid,runSession:async request=>{throw Error(`failed ${request.task}`);}})[0].execute('fail',{tasks:['a','b']},undefined,undefined,{cwd:process.cwd()});
 assert.equal(result.isError,true);assert.equal(result.details.status,'error');assert.equal(text(result),'## Task 1: error\nfailed a\n\n## Task 2: error\nfailed b');assert.equal(result.details.apexAux.attempted,true);
});

test('aborting an explore batch stops new launches while launched tasks settle',async()=>{
 const {createSubagentTools}=await exports();const controller=new AbortController();let calls=0;
 const explore=createSubagentTools({policy:paid,runSession:async()=>{calls++;controller.abort();return {text:'late',usage:usage()};}})[0];
 const result=await explore.execute('abort',{tasks:['a','b','c']},controller.signal,undefined,{cwd:process.cwd()});
 assert.equal(calls,1);assert.equal(result.isError,true);assert.equal(result.details.status,'aborted');
 assert.deepEqual(result.details.tasks.map(task=>task.status),['aborted','aborted','aborted']);assert.equal(result.details.usage.totalTokens,6);
 assert.match(text(result),/## Task 2: aborted\nNot started/);
});

test('explore requires exactly one of task or tasks and offline policy blocks batches first',async()=>{
 const {createSubagentTools}=await exports();let calls=0;const explore=createSubagentTools({policy:paid,runSession:async()=>{calls++;return {text:'x',usage:usage()};}})[0];
 for(const [params,pattern] of [[{task:'a',tasks:['b']},/exactly one of task or tasks/],[{tasks:[]},/one to 4 tasks/],[{tasks:['a','b','c','d','e']},/one to 4 tasks/],[{tasks:['a','  ']},/nonempty string/],[{tasks:'a'},/one to 4 tasks/],[{},/nonempty string/]]){
  const result=await explore.execute('bad',params,undefined,undefined,{cwd:process.cwd()});assert.equal(result.isError,true);assert.equal(result.details.status,'error');assert.match(text(result),pattern);
 }
 assert.equal(calls,0);
 const offline=createSubagentTools({policy:runtimePolicy(),runSession:()=>{calls++;}})[0];
 const blocked=await offline.execute('offline',{tasks:['a','b']},undefined,undefined,{get cwd(){throw Error('cwd accessed before denial');}});
 assert.equal(blocked.details.status,'blocked');assert.equal(blocked.isError,true);assert.equal(calls,0);assert.equal(blocked.usage,undefined);
});
