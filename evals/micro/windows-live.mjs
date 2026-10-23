import assert from 'node:assert/strict';
import {appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {delimiter, dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {PI_VERSION, resolvePi} from '../../lib/launcher.mjs';
import {assertWindowsTarget} from '../../lib/windows-target.mjs';
import {fixtureEnvironment, fixtureShellPath, WINDOWS_FIXTURE_ENV} from '../../scripts/micro-session.mjs';
import {windowsProbeEnvironment} from '../../scripts/preflight-windows.mjs';
import {redactProviderStream} from './provider-smoke.mjs';

export const PROFILE = Object.freeze({provider:'anthropic', model:'claude-opus-5-5', thinking:'medium',
  endpoint:'https://api.anthropic.com/v1/messages', maxRequests:16, maxPayloadBytes:262144, maxOutputTokens:16000,
  runCapUsd:4, deadlineMs:420000, maxVisibleBytes:524288,
  context:'cache,shape,mask,compact,read,search,edit,patch,lazy',
  core:'snapshot,entrypoints,headless,contract,todo,verify,loops,time,correct,diagnostics,subagents', daily:'all'});
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fail = code => {throw Error(code);};
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => writeFileSync(file, JSON.stringify(value,null,2)+'\n');
const hash = value => createHash('sha256').update(value).digest('hex');
const text = value => (value?.content??[]).filter(part=>part.type==='text').map(part=>part.text).join('\n');
const boundedInteger = value => Number.isSafeInteger(value)&&value>=0;
const USAGE_KEYS = ['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'];

/**
 * Counts physical attempts, including HTTP failures, before invoking transport. Each send must fit the run's catalog
 * cap at its worst case: payload bytes bound input tokens from above, and the guard lowers max_tokens to bound output.
 */
export function createWindowsGuard(model, {started=Date.now(), profile=PROFILE}={}) {
  if(model?.provider!==profile.provider||model.id!==profile.model||model.api!=='anthropic-messages'||
    model.baseUrl!=='https://api.anthropic.com'||model.thinkingLevelMap?.[profile.thinking]!==profile.thinking) fail('model_mismatch');
  if(!boundedInteger(model.maxTokens)||!model.maxTokens) fail('catalog_output_bound_missing');
  for(const key of ['input','output','cacheRead','cacheWrite']) if(!Number.isFinite(model.cost?.[key])||model.cost[key]<0) fail('catalog_price_missing');
  const maxOutputTokens = Math.min(profile.maxOutputTokens, model.maxTokens);
  const inputRate = Math.max(model.cost.input,model.cost.cacheRead,model.cost.cacheWrite);
  const worstUsd = bytes => (bytes*inputRate+maxOutputTokens*model.cost.output)/1e6;
  const usageUsd = usage => ((usage.input_tokens??0)*model.cost.input+(usage.cache_read_input_tokens??0)*model.cost.cacheRead+
    (usage.cache_creation_input_tokens??0)*model.cost.cacheWrite+(usage.output_tokens??0)*model.cost.output)/1e6;
  const sends=[],blocked=[],responses=new Map();
  let visibleBytes=0,current;
  const block = code => {blocked.push(code);fail(code);};
  const deadline = () => {if(Date.now()-started>=profile.deadlineMs) block('deadline_exceeded');};
  // A send without a completed usage report stays charged at its worst case.
  const committed = () => sends.reduce((sum,send)=>sum+(send.catalog_usd??send.worst_usd),0);
  const effort = value => value?.messages?.at(-1)?.output_config?.effort;
  function payload(value) {
    deadline();
    if(!value||value.model!==profile.model||value.thinking?.type!=='adaptive'||effort(value)!==profile.thinking) block('payload_model_thinking_mismatch');
    if(value.stream!==true) block('payload_stream_mismatch');
    for(const key of ['fallback','fallbacks','fallback_models','service_tier']) if(Object.hasOwn(value,key)) block('fallback_or_unsupported_parameter');
    const bounded={...value,max_tokens:Math.min(value.max_tokens??maxOutputTokens,maxOutputTokens)};
    if(Buffer.byteLength(JSON.stringify(bounded))>profile.maxPayloadBytes) block('payload_limit');
    return bounded;
  }
  return {sends,blocked,responses,maxOutputTokens,payload,committed,
    cost:()=>[...responses.values()].reduce((sum,response)=>sum+usageUsd(response.usage),0),
    observe(chunk) {
      if(chunk?.type==='message_start') {
        if(chunk.message?.model!==profile.model) block('response_model_mismatch');
        current={model:chunk.message.model,usage:{...chunk.message.usage},complete:false};responses.set(chunk.message.id,current);
        const send=sends.at(-1);if(send&&!send.response_id)send.response_id=chunk.message.id;
      } else if(chunk?.type==='message_delta'&&current) {
        for(const [key,value] of Object.entries(chunk.usage??{})) if(value!==null&&value!==undefined) current.usage[key]=value;
      } else if(chunk?.type==='message_stop'&&current) {
        const usage=current.usage;
        if(USAGE_KEYS.some(key=>usage[key]!==undefined&&usage[key]!==null&&!boundedInteger(usage[key]))||!boundedInteger(usage.input_tokens)||
          !boundedInteger(usage.output_tokens)||usage.output_tokens>maxOutputTokens||usage.input_tokens>profile.maxPayloadBytes) block('response_usage_bound');
        current.complete=true;
        const send=sends.find(item=>responses.get(item.response_id)===current);if(send)send.catalog_usd=usageUsd(usage);
        current=undefined;
      } else if(chunk?.type==='content_block_delta') {
        visibleBytes+=Buffer.byteLength(chunk.delta?.text??chunk.delta?.thinking??'');if(visibleBytes>profile.maxVisibleBytes) block('visible_output_limit');
      }
    },
    wrapFetch(transport, signal) {
      return async (input, init={}) => {
        deadline();
        let url;try {url=new URL(input instanceof Request?input.url:String(input));} catch {block('endpoint_forbidden');}
        if(url.origin+url.pathname!==profile.endpoint||[...url.searchParams.keys()].some(key=>key!=='beta')||String(init.method??'GET').toUpperCase()!=='POST') block('endpoint_forbidden');
        const body=init.body;
        if(!(typeof body==='string'||ArrayBuffer.isView(body))) block('payload_invalid');
        const bytes=Buffer.byteLength(body);
        if(bytes>profile.maxPayloadBytes) block('payload_limit');
        let value;try {value=JSON.parse(Buffer.from(body).toString('utf8'));}catch {block('payload_invalid');}
        payload(value);
        if(!boundedInteger(value.max_tokens)||value.max_tokens>maxOutputTokens) block('output_bound_missing');
        if(sends.length>=profile.maxRequests) block('request_limit');
        const worst=worstUsd(bytes);
        if(committed()+worst>profile.runCapUsd) block('run_cap_exceeded');
        const send={ordinal:sends.length+1,payload_bytes:bytes,payload_sha256:hash(body),model:value.model,thinking:effort(value),worst_usd:worst,sent_at:new Date().toISOString()};
        sends.push(send);
        try {const response=await transport(input,{...init,redirect:'error',signal:init.signal?AbortSignal.any([init.signal,signal]):signal});send.status=response.status;return response;}
        catch {send.transport_failed=true;throw Error('transport_failed');}
      };
    },
  };
}

function reserve(file,runId) {
  const ledger=json(file);
  if(ledger.execution_scope!=='claude-oauth-windows-acceptance'||ledger.provider!==PROFILE.provider||ledger.model!==PROFILE.model||ledger.thinking_level!==PROFILE.thinking||ledger.auth_type!=='oauth') fail('authorization_scope_mismatch');
  const reservations=ledger.reservations??[];
  const amount=value=>Number.isFinite(value)&&value>=0;
  if(!Array.isArray(ledger.runs)||!Array.isArray(reservations)||!amount(ledger.observed_catalog_token_cost_usd)||!amount(ledger.reserved_catalog_token_cost_usd)||
    !amount(ledger.budget_cap_usd)||reservations.some(item=>!amount(item.reserved_catalog_token_cost_usd))) fail('catalog_ledger_invalid');
  const retained=reservations.filter(item=>item.status==='reserved').reduce((sum,item)=>sum+item.reserved_catalog_token_cost_usd,0);
  if(Math.abs(retained-ledger.reserved_catalog_token_cost_usd)>1e-9) fail('catalog_ledger_inconsistent');
  if(reservations.some(item=>item.status==='reserved')) fail('active_reservation_exists');
  if(ledger.runs.some(item=>item.run_id===runId)||reservations.some(item=>item.run_id===runId)) fail('run_id_reused');
  if(ledger.observed_catalog_token_cost_usd+ledger.reserved_catalog_token_cost_usd+PROFILE.runCapUsd>ledger.budget_cap_usd) fail('catalog_budget_insufficient');
  const entry={run_id:runId,status:'reserved',reserved_catalog_token_cost_usd:PROFILE.runCapUsd,
    max_physical_requests:PROFILE.maxRequests,max_payload_bytes:PROFILE.maxPayloadBytes,max_output_tokens:PROFILE.maxOutputTokens,
    output_bound_source:'guard lowers each payload max_tokens and refuses a send whose worst case would pass the run cap',reserved_at:new Date().toISOString()};
  ledger.reservations=[...reservations,entry];ledger.reserved_catalog_token_cost_usd+=PROFILE.runCapUsd;
  ledger.remaining_catalog_equivalent_usd=ledger.budget_cap_usd-ledger.observed_catalog_token_cost_usd-ledger.reserved_catalog_token_cost_usd;
  save(file,ledger);
  return entry;
}
function reconcile(file,runId,guard,summary) {
  const ledger=json(file),reservation=ledger.reservations.find(item=>item.run_id===runId&&item.status==='reserved');
  if(!reservation) fail('reservation_lost');
  const complete=guard.sends.every(send=>guard.responses.get(send.response_id)?.complete===true);
  // An incomplete run stays charged at the worst case of every send without a usage report.
  const known=complete?summary.catalog_token_cost_usd:guard.committed();
  reservation.status='reconciled';reservation.physical_requests=guard.sends.length;
  reservation.usage_complete=complete;reservation.reconciled_at=new Date().toISOString();
  ledger.observed_catalog_token_cost_usd+=known;
  ledger.reserved_catalog_token_cost_usd=ledger.reservations.filter(item=>item.status==='reserved').reduce((sum,item)=>sum+item.reserved_catalog_token_cost_usd,0);
  ledger.remaining_catalog_equivalent_usd=ledger.budget_cap_usd-ledger.observed_catalog_token_cost_usd-ledger.reserved_catalog_token_cost_usd;
  ledger.runs.push({run_id:runId,purpose:'Native Windows enabled-features-together live acceptance (SDK)',physical_requests:guard.sends.length,
    catalog_token_cost_usd:known,billed_cost_usd:null,summary_file:`runs/model-smoke/${runId}/summary.json`,benchmark_result:false,usage_complete:complete});
  save(file,ledger);return {usage_complete:complete,ledger_remaining_catalog_equivalent_usd:ledger.remaining_catalog_equivalent_usd};
}

// Bun has no `--check`; the fixture's `check` script is a transpile-only syntax check of verify.cjs.
const VERIFY = 'bun verify.cjs';
const SYNTAX = 'bun run check';
const LARGE = 'bun large.cjs';
const packageSource = `${JSON.stringify({private:true,scripts:{check:'bun build --no-bundle verify.cjs'}})}\n`;
const verifySource = `const fs=require('node:fs'),a=require('node:assert/strict');a.equal(fs.readFileSync('sample.txt','utf8'),'alpha\\ndelta\\nomega\\n');a.deepEqual(JSON.parse(fs.readFileSync('summary.json','utf8')),{lines:3,second:'delta',third:'omega'});a.equal(fs.readFileSync('recovered.txt','utf8'),Array.from({length:180},(_,i)=>'ROW_'+String(i).padStart(3,'0')+'_'+'x'.repeat(64)).join('\\n')+'\\n');console.log('WINDOWS_LIVE_VERIFIED');\n`;
const largeSource = `console.log(Array.from({length:180},(_,i)=>'ROW_'+String(i).padStart(3,'0')+'_'+'x'.repeat(64)).join('\\n'));\n`;
function prompt(fixture) {
  return `Perform this bounded acceptance in ${fixture}; never access private credentials or the network. All supported Windows flags are enabled together. Use direct tool calls, never codemode; batch independent native tool calls in one response. Do not read outside this fixture. Bash timeout is in seconds: use 30 or omit it.\n`+
    `1. Set a contract criterion with id result, artifact summary.json format json containing omega. Add todo id acceptance. Read sample.txt and use grep for beta. Use read on .fixture-skills/debugging/SKILL.md (the loaded real debugging skill) to exercise skills.\n`+
    `2. Edit beta to delta using edit. Use tool_search to discover apply_patch and remember. Use apply_patch with an exact unified patch to replace gamma with omega. Use write to create summary.json exactly {"lines":3,"second":"delta","third":"omega"}.\n`+
    `3. Run Bash command exactly ${LARGE} directly, not through codemode. It emits 180 lines; recover the exact full hook-visible output from the Apex shaping .apex/out path using read(offset/limit ranges may be needed), then write recovered.txt exactly those 180 lines with final newline. Do not generate/recompute the output: read the spill.\n`+
    `4. Use remember to record fact "Windows live fixture uses delta and omega." Mark all todos done (including criterion-created result and acceptance). Before running verification, finish one response with exact text READY_FOR_VERIFICATION. This deliberately exercises the verification gate; when the native gate continues you, run Bash ${VERIFY}, then Bash ${SYNTAX}, and finish WINDOWS_LIVE_COMPLETE. Do not rerun mutations. Batch independent calls to limit requests. Never spawn a subagent or request auxiliary inference.`;
}

export async function runWindowsLive(options={}) {
  const lock=join(options.projectRoot??root,'evals','claude-budget.lock');
  try {mkdirSync(lock);}catch {fail('catalog_ledger_locked');}
  try {return await executeWindowsLive(options);}
  finally {rmdirSync(lock);}
}

async function executeWindowsLive({runId,projectRoot=root}={}) {
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(runId??'')||runId==='.'||runId==='..') fail('run_id_invalid');
  const started=Date.now();
  assertWindowsTarget({context:PROFILE.context.split(','),core:PROFILE.core.split(',')});resolvePi();
  const authDir=resolve(process.env.PI_CODING_AGENT_DIR??join(process.env.LOCALAPPDATA??'', 'Apex','sol-oauth'));
  if(!process.env.PI_CODING_AGENT_DIR&&!process.env.LOCALAPPDATA) fail('private_auth_path_missing');
  const insideRepo=relative(projectRoot,authDir);
  if(insideRepo===''||(!insideRepo.startsWith('..'+sep)&&insideRepo!=='..'&&!/^[A-Za-z]:/.test(insideRepo))) fail('auth_inside_repo_forbidden');
  const stored=json(join(authDir,'auth.json'))[PROFILE.provider];
  if(stored?.type!=='oauth'||typeof stored.access!=='string'||!stored.access||!Number.isFinite(stored.expires)||stored.expires<=Date.now()+PROFILE.deadlineMs+300000) fail('valid_private_oauth_required');
  const secrets=Object.values(stored).filter(value=>typeof value==='string'&&value.length>12);
  const redact=value=>{let result=JSON.stringify(value);for(const secret of secrets)result=result.replaceAll(secret,'<redacted-oauth>');return JSON.parse(result);};
  const directory=join(projectRoot,'runs','model-smoke',runId);mkdirSync(dirname(directory),{recursive:true});mkdirSync(directory);
  const fixture=join(directory,'fixture'),agentDir=join(directory,'agent'),sessionsDir=join(directory,'sessions');
  for(const dir of [fixture,agentDir,sessionsDir])mkdirSync(dir);
  const environment=fixtureEnvironment(['PATH','SystemRoot','WINDIR','LANG','LC_ALL',...WINDOWS_FIXTURE_ENV],fixture,windowsProbeEnvironment(projectRoot));
  environment.PATH=[dirname(process.execPath),environment.PATH].filter(Boolean).join(delimiter); // the declared commands run this Bun
  environment.BUN_RUNTIME_TRANSPILER_CACHE_PATH='0'; // HOME is the fixture: Bun children must not write .bun transpiler caches into it
  const shell=fixtureShellPath();if(!shell)fail('native_shell_missing');
  for(const name of Object.keys(process.env)) delete process.env[name];Object.assign(process.env,environment,{PI_OFFLINE:'1'});
  for(const [name,content] of [['sample.txt','alpha\nbeta\ngamma\n'],['verify.cjs',verifySource],['large.cjs',largeSource],['package.json',packageSource]])writeFileSync(join(fixture,name),content,{flag:'wx'});
  for(const args of [['init','--quiet'],['-c','user.name=Apex fixture','-c','user.email=fixture@invalid','add','.'],['-c','user.name=Apex fixture','-c','user.email=fixture@invalid','commit','--quiet','-m','fixture']]) {
    const result=spawnSync('git',args,{cwd:fixture,env:{...environment,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL',GIT_TERMINAL_PROMPT:'0'},encoding:'utf8',timeout:10000});if(result.status!==0)fail('git_fixture_failed');
  }
  const nativeFetch=globalThis.fetch.bind(globalThis);
  const external=[];globalThis.fetch=async()=>{external.push('unguarded_fetch');fail('network_forbidden');};
  if('WebSocket' in globalThis)globalThis.WebSocket=class {constructor(){external.push('websocket');fail('network_forbidden');}};
  const sdk=await import('@earendil-works/pi-coding-agent');
  const credentials={read:async provider=>provider===PROFILE.provider?stored:undefined,list:async()=>[],modify:async()=>fail('oauth_refresh_forbidden'),delete:async()=>fail('credential_delete_forbidden')};
  const runtime=await sdk.ModelRuntime.create({credentials,modelsPath:null,modelsStorePath:join(agentDir,'models-store.json'),allowModelNetwork:false,refreshOnCreate:false});
  runtime.refresh=async options=>{if(options?.allowNetwork!==false) fail('discovery_network_forbidden');return {aborted:false,errors:new Map()};};
  const model=runtime.getPhysicalModel(PROFILE.provider,PROFILE.model);
  const guard=createWindowsGuard(model,{started});
  const ledger=join(projectRoot,'evals','claude-budget.json');reserve(ledger,runId);
  const controller=new AbortController();let session,manager,timedOut=false,failure=null;const events=[],errors=[];
  const timer=setTimeout(()=>{timedOut=true;controller.abort();session?.agent.abort();},Math.max(1,PROFILE.deadlineMs-(Date.now()-started)));
  const rawFile=join(directory,'provider-events.jsonl'),eventsFile=join(directory,'events.jsonl');
  writeFileSync(rawFile,'',{flag:'wx'});writeFileSync(eventsFile,'',{flag:'wx'});
  const record=(file,value)=>appendFileSync(file,JSON.stringify(redact(value))+'\n');
  const factories=[];
  const wrap=(factory,flags)=>api=>factory(new Proxy(api,{get(target,name){
    if(name==='getFlag')return flag=>Object.hasOwn(flags,flag)?flags[flag]:target.getFlag(flag);
    if(name==='on')return (event,handler)=>target.on(event,event==='resources_discover'?async(...args)=>{
      const result=await handler(...args);
      if(!result?.skillPaths)return result;
      return {...result,skillPaths:result.skillPaths.map(source=>{
        const destination=join(fixture,'.fixture-skills',dirname(source).split(/[\\/]/).at(-1),'SKILL.md');
        mkdirSync(dirname(destination),{recursive:true});writeFileSync(destination,readFileSync(source));
        return destination;
      })};
    }:handler);
    return Reflect.get(target,name);
  }}));
  const {default:context}=await import('../../extensions/apex-context/index.mjs');
  const {default:claudeIdentity}=await import('../../extensions/apex-router/claude-identity.mjs');
  const {createApexCore}=await import('../../extensions/apex-core/index.mjs');
  const {createApexFeatures}=await import('../../extensions/apex-features/index.mjs');
  factories.push(claudeIdentity,wrap(context,{'apex-context-flags':PROFILE.context}),wrap(createApexCore(),{'apex-core-flags':PROFILE.core,'headless':true,'apex-time-budget':String(PROFILE.deadlineMs/1000)}),wrap(createApexFeatures(),{'apex-feature-flags':'all','apex-eval':false}));
  factories.push(api=>api.on('tool_call',event=>{
    const args=event.input??event.args??{};
    if(!['read','bash','edit','write','grep','find','ls','codemode','tool_search','contract','todo','apply_patch','remember'].includes(event.toolName))return {block:true,reason:'Live fixture tool scope forbids auxiliary or undeclared execution.'};
    if(event.toolName==='bash'&&![VERIFY,SYNTAX,LARGE].includes(args.command))return {block:true,reason:'Live fixture permits only the three declared local commands.'};
    if(['read','edit','write','grep','find','ls'].includes(event.toolName)&&typeof args.path==='string') {
      const location=resolve(fixture,args.path),rel=relative(fixture,location);
      if(rel==='..'||rel.startsWith('..'+sep)||/^[A-Za-z]:/.test(rel))return {block:true,reason:'Live fixture path boundary.'};
      if(['edit','write'].includes(event.toolName)&&!['sample.txt','summary.json','recovered.txt'].includes(rel))return {block:true,reason:'Live fixture verification scripts are immutable.'};
    }
    if(event.toolName==='apply_patch'&&(!/^--- (?:a\/)?sample\.txt\r?\n\+\+\+ (?:b\/)?sample\.txt\r?\n/.test(args.patch??'')))return {block:true,reason:'Live fixture patch may modify only sample.txt.'};
  }));
  const settings=sdk.SettingsManager.inMemory({defaultProvider:PROFILE.provider,defaultModel:PROFILE.model,defaultThinkingLevel:PROFILE.thinking,defaultProjectTrust:'never',enableAnalytics:false,
    shellPath:shell,cacheWarming:'off',compaction:{enabled:false},retry:{enabled:false,maxRetries:0,provider:{maxRetries:0}},packages:[],extensions:[],skills:[],prompts:[],themes:[],codemode:{mode:'off'}});
  const loader=new sdk.DefaultResourceLoader({cwd:fixture,agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:factories});
  const empty=async()=>({extensions:[],skills:[],prompts:[],themes:[]});loader.packageManager.resolve=empty;loader.packageManager.resolveExtensionSources=empty;
  const command=async(name,args='')=>{
    const definition=session.extensionRunner.getRegisteredCommands().find(item=>item.invocationName===name);
    if(!definition)fail('command_missing');return definition.handler(args,session.extensionRunner.createCommandContext());
  };
  const offline={};let accounting,resume,undo,fixtureOutcomes;
  try {
    await loader.reload();if(loader.getExtensions().errors.length)fail('extension_load_failed');
    manager=sdk.SessionManager.create(fixture,sessionsDir);manager.appendModelChange(PROFILE.provider,PROFILE.model);manager.appendThinkingLevelChange(PROFILE.thinking);
    const created=await sdk.createAgentSession({cwd:fixture,agentDir,modelRuntime:runtime,model,thinkingLevel:PROFILE.thinking,settingsManager:settings,sessionManager:manager,resourceLoader:loader});
    session=created.session;if(created.modelFallbackMessage||session.thinkingLevel!==PROFILE.thinking)fail('model_fallback_forbidden');
    await session.bindExtensions({onError:error=>{errors.push(redact({event:error.event,error:String(error.error)}));}});
    const fetch=guard.wrapFetch(nativeFetch,controller.signal);
    // Extension payload hooks (Claude identity, context cache ledger) run first, as in the CLI; the guard sees the final payload.
    const extensionPayload=value=>session.extensionRunner.hasHandlers('before_provider_request')?session.extensionRunner.emitBeforeProviderRequest(value):value;
    session.agent.streamFunction=(selected,context,options={})=>{
      if(selected.provider!==PROFILE.provider||selected.id!==PROFILE.model||selected.api!==model.api)fail('model_mismatch');
      return secrets.reduce((stream,secret)=>redactProviderStream(stream,secret),runtime.streamSimple(selected,context,{...options,reasoning:PROFILE.thinking,maxRetries:0,
        timeoutMs:Math.max(1,PROFILE.deadlineMs-(Date.now()-started)),env:{},signal:options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal,fetch,
        onPayload:async value=>guard.payload(await extensionPayload(value)),onProviderStreamEvent:chunk=>{record(rawFile,chunk);guard.observe(chunk);}}));
    };
    session.subscribe(event=>{if(event.type==='message_update')return;const safe=redact(event);events.push(safe);record(eventsFile,safe);});
    save(join(directory,'configuration.json'),{...PROFILE,run_id:runId,platform:process.platform,pi_version:PI_VERSION,auth_type:'oauth',runtimePolicy:'unchanged offline-only auxiliary inference',
      catalog_rates:model.cost,max_output_tokens:guard.maxOutputTokens,output_bound_source:'guard lowers payload max_tokens',run_cap_usd:PROFILE.runCapUsd,
      discovery_disabled:true,retries:0,auto_compaction:false,cache_warming:'off',isolation:'fixture cwd and tool hooks; not an OS sandbox',benchmark_result:false});
    await session.prompt(prompt(fixture));
    const terminal=events.filter(event=>event.type==='message_end'&&event.message?.role==='assistant').at(-1)?.message;
    if(['error','aborted'].includes(terminal?.stopReason))failure=terminal.errorMessage??'native_session_failed';
    const expectedOutput=Array.from({length:180},(_,i)=>'ROW_'+String(i).padStart(3,'0')+'_'+'x'.repeat(64)).join('\n')+'\n';
    const same=(name,expected)=>{try{return readFileSync(join(fixture,name),'utf8')===expected;}catch{return false;}};
    let summaryExact=false;try{assert.deepEqual(json(join(fixture,'summary.json')),{lines:3,second:'delta',third:'omega'});summaryExact=true;}catch{}
    fixtureOutcomes={sample:same('sample.txt','alpha\ndelta\nomega\n'),summary:summaryExact,recovered:same('recovered.txt',expectedOutput),
      verification_script_unchanged:same('verify.cjs',verifySource)&&same('package.json',packageSource),output_script_unchanged:same('large.cjs',largeSource)};
    accounting={cost:await command('cost'),report:await command('report')};resume=await command('resume-info');
    const before=guard.sends.length;
    offline.plan=await command('plan','Offline refusal inspection');offline.planCancel=await command('plan','cancel');offline.review=await command('review');
    for(const name of ['explore','verify']) {
      const tool=session.getToolDefinition(name);if(!tool)fail('subagent_tool_missing');
      offline[name]=await tool.execute('offline-refusal-'+name,{task:'Inspect fixture only',commands:[]},controller.signal,undefined,session.extensionRunner.createToolContext('offline-refusal-'+name,controller.signal));
    }
    const compaction=await session.extensionRunner.emit({type:'session_before_compact',preparation:{},customInstructions:undefined,signal:controller.signal});
    offline.compact=compaction;offline.physical_requests=guard.sends.length-before;
    // Undo a checkpoint containing a real model-created artifact, not an empty verifier turn.
    const {createCheckpointManager}=await import('../../extensions/apex-features/checkpoints.mjs');
    const inspection=createCheckpointManager({cwd:fixture,sessionId:manager.getSessionId()});
    let checkpoint;
    try {checkpoint=(await inspection.list()).findLast(item=>item.status==='finished'&&item.changedPaths.includes('recovered.txt'));}
    finally {await inspection.shutdown();}
    if(checkpoint){undo=await command('undo',checkpoint.turnId);undo.recovered_file_removed=!existsSync(join(fixture,'recovered.txt'));}
    else undo={ok:false,reason:'No completed real artifact mutation checkpoint.'};
  } catch(error) {failure=timedOut?'deadline_exceeded':redact(String(error?.message??error));}
  finally {
    await session?.abort();
    if(session?.sessionFile&&existsSync(session.sessionFile))writeFileSync(join(directory,'session.jsonl'),readFileSync(session.sessionFile,'utf8').split('\n').filter(Boolean).map(line=>JSON.stringify(redact(JSON.parse(line)))).join('\n')+'\n');
    await session?.extensionRunner.emit({type:'session_shutdown',reason:'exit'});session?.dispose();clearTimeout(timer);
  }
  if(session?.sessionFile&&existsSync(session.sessionFile)&&accounting) {
    let reopened;
    const before=guard.sends.length;
    const fixtureHashes=()=>Object.fromEntries(['sample.txt','summary.json','recovered.txt','verify.cjs','large.cjs','package.json'].map(name=>{
      try{return [name,hash(readFileSync(join(fixture,name)))];}catch(error){if(error.code==='ENOENT')return [name,null];throw error;}
    }));
    const beforeFiles=fixtureHashes();
    try {
      const resumedManager=sdk.SessionManager.open(session.sessionFile,sessionsDir,fixture);
      await loader.reload();
      reopened=(await sdk.createAgentSession({cwd:fixture,agentDir,modelRuntime:runtime,model,thinkingLevel:PROFILE.thinking,settingsManager:settings,sessionManager:resumedManager,resourceLoader:loader})).session;
      reopened.agent.streamFunction=()=>fail('resume_inference_forbidden');
      await reopened.bindExtensions({onError:error=>errors.push(redact({event:error.event,error:String(error.error)}))});
      const report=reopened.extensionRunner.getRegisteredCommands().find(item=>item.invocationName==='report');
      const resumedReport=await report.handler('',reopened.extensionRunner.createCommandContext());
      const {createLearnings}=await import('../../extensions/apex-features/learnings.mjs');
      const learned=await createLearnings({cwd:fixture}).load();
      resume={...resume,native_reopened:true,thinking:reopened.thinkingLevel,model:reopened.model?.id??model.id,
        accounting_preserved:JSON.stringify(resumedReport.knownTotals)===JSON.stringify(accounting.report.knownTotals),
        learnings_retained:learned.ok&&learned.content.includes('Windows live fixture uses delta and omega.'),
        physical_requests:guard.sends.length-before,fixture_unchanged:JSON.stringify(beforeFiles)===JSON.stringify(fixtureHashes())};
    } catch(error){failure??=redact(String(error?.message??error));}
    finally {await reopened?.extensionRunner.emit({type:'session_shutdown',reason:'exit'});reopened?.dispose();}
  }
  if(timedOut)failure='deadline_exceeded';
  const completed=events.filter(event=>event.type==='tool_execution_end'&&!event.isError),used=name=>completed.some(event=>event.toolName===name);
  const toolResults=events.filter(event=>event.type==='message_end'&&event.message?.role==='toolResult').map(event=>event.message);
  const shaped=completed.find(event=>event.toolName==='bash'&&event.result?.details?.apexShape)?.result??
    toolResults.find(result=>result.toolName==='bash'&&result.details?.apexShape);
  const assistants=events.filter(event=>event.type==='message_end'&&event.message?.role==='assistant').map(event=>event.message);
  const branch=manager?.getEntries()??[];
  const gate=branch.some(entry=>entry.type==='custom_message'&&entry.customType==='apex-verification-gate');
  const final=assistants.at(-1);
  const liveVerification=completed.some(event=>event.toolName==='bash'&&text(event.result).includes('WINDOWS_LIVE_VERIFIED'));
  const cost=guard.cost();
  const checks={native_session_completed:!failure,exact_model_thinking:guard.sends.length>0&&guard.sends.every(send=>send.model===PROFILE.model&&send.thinking===PROFILE.thinking),
    read:used('read'),search:used('grep'),edit:used('edit'),write:used('write'),bash:used('bash'),patch:used('apply_patch'),lazy:used('tool_search'),
    contract:used('contract'),todo:used('todo'),verification_gate:gate,fixture_exact:liveVerification&&Object.values(fixtureOutcomes??{missing:false}).every(Boolean),
    shaping:!!shaped,exact_recovery:liveVerification&&!!shaped,
    remember:used('remember')&&resume?.learnings_retained===true,skills:completed.some(event=>event.toolName==='read'&&events.some(start=>start.type==='tool_execution_start'&&start.toolCallId===event.toolCallId&&start.args?.path?.includes('SKILL.md'))),
    checkpoint:undo?.status==='restored'&&undo.recovered_file_removed===true,accounting:accounting?.report?.completeness?.usage===true,
    resume:resume?.replayPerformed===false&&resume.native_reopened===true&&resume.accounting_preserved===true&&resume.physical_requests===0&&resume.thinking===PROFILE.thinking&&resume.fixture_unchanged===true,
    offline_auxiliary_no_sends:offline.physical_requests===0&&offline.plan?.prompted===false&&offline.review?.blocked===true&&offline.explore?.details?.status==='blocked'&&offline.verify?.details?.status==='blocked'&&offline.compact?.cancel===true,
    network_policy:external.length===0&&guard.blocked.length===0,
    final_completed:final?.stopReason==='stop'&&text(final).includes('WINDOWS_LIVE_COMPLETE'),extensions_no_errors:errors.length===0};
  const summary={schema_version:1,kind:'windows_live_features_acceptance',run_id:runId,provider:PROFILE.provider,model:PROFILE.model,thinking:PROFILE.thinking,platform:process.platform,
    passed:Object.values(checks).every(Boolean),checks,failure,physical_requests:guard.sends.length,sends:guard.sends,blocked_reasons:guard.blocked,external_network_attempts:external,
    wall_seconds:(Date.now()-started)/1000,catalog_token_cost_usd:cost,billed_cost_usd:null,run_cap_usd:PROFILE.runCapUsd,max_output_tokens:guard.maxOutputTokens,
    output_bound_source:'guard-lowered payload max_tokens; a catalog estimate, not an invoice',responses:[...guard.responses].map(([id,response])=>({id,...response})),
    accounting,offline,undo,resume,fixtureOutcomes,extension_errors:errors,active_tools:session?.getActiveToolNames(),
    boundaries:{cache:'live prefix ledger; provider cache hit not guaranteed',mask:'enabled; short fixture may not reach rewrite threshold',compact:'offline-only refusal; no auxiliary model compaction',
      snapshot:'native before_agent_start snapshot',entrypoints:'fixture entrypoint probing',headless:'native SDK noninteractive mode, not Windows Terminal UI',
      loops:'enabled; repeated-error escalation not induced',time:`${PROFILE.deadlineMs/1000}-second budget configured; threshold warnings not forced`,correct:'enabled; safe commands only',diagnostics:'enabled; fixture has no external project checker',
      subagents:'offline-only refusals, not live auxiliary inference',plan:'offline read-only mode without model request',review:'offline-only refusal',safety:'safe fixture calls, no interactive risky action',
      unsupported:['context route/output Muse-only','core bg/max/recovery unsupported on Windows']},raw_provider_events_file:relative(projectRoot,rawFile),raw_events_file:relative(projectRoot,eventsFile),raw_session_file:`runs/model-smoke/${runId}/session.jsonl`,benchmark_result:false};
  Object.assign(summary,reconcile(ledger,runId,guard,summary));
  save(join(directory,'summary.json'),redact(summary));mkdirSync(join(projectRoot,'validation'),{recursive:true});save(join(projectRoot,'validation',`windows-live-${runId}.json`),redact(summary));
  return summary;
}

async function main() {
  const {values}=parseArgs({options:{'run-id':{type:'string'},help:{type:'boolean'}}});
  if(values.help){console.log('Usage: bun evals/micro/windows-live.mjs --run-id UNIQUE_ID\nNative Windows, private valid Claude OAuth, capped catalog reservation in evals/claude-budget.json, real pinned Pi SDK.');return;}
  const summary=await runWindowsLive({runId:values['run-id']});console.log(JSON.stringify({run_id:summary.run_id,passed:summary.passed,checks:summary.checks,failure:summary.failure,physical_requests:summary.physical_requests,catalog_estimate_usd:summary.catalog_token_cost_usd,ledger_remaining_usd:summary.ledger_remaining_catalog_equivalent_usd}));
  if(!summary.passed)process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{const code=String(error?.message??'');console.error(JSON.stringify({error:/^[a-z][a-z_]+$/.test(code)?code:'windows_live_preflight_failed',provider_calls:'inspect reservation and run evidence; no credentials printed'}));process.exitCode=1;});
