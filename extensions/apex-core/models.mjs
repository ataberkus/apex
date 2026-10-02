/** Guarded auxiliary model work. Import and tool registration allocate no sessions or processes. */
import path from 'node:path';
import {SELECTED_MODEL} from '../apex-context/config.mjs';

const READ_TOOLS=Object.freeze(['read','grep','find','ls']);
const MAX_OUTPUT_BYTES=4096;
const MAX_TURNS=8;
const DENIED='Auxiliary model work is blocked by offline-only authorization.';
const ACCOUNTING=Symbol('apex-usage-accounting');
const OPTIONAL_SUBSETS=['reasoning','cacheWrite1h'];

function assertPolicy(policy) {
  if (policy?.paid_runs_enabled!==true || policy?.execution_policy!=='paid-enabled') throw new Error(DENIED);
  if (policy.allowed_model!==SELECTED_MODEL) throw new Error(`Auxiliary model must be exactly ${SELECTED_MODEL}.`);
  if (policy.thinking_level!=='xhigh') throw new Error('Auxiliary thinking must be exactly xhigh.');
}
function abort(signal) { if(signal?.aborted) {const error=new Error('Auxiliary work aborted.');error.name='AbortError';throw error;} }
function validateTask(task) {if(typeof task!=='string'||!task.trim()||task.length>20000)throw new Error('Task must be a nonempty string of at most 20000 characters.');}
function emptyUsage() {return {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};}
function amount(value,name,limit) {if(value===undefined)return 0;if(!Number.isFinite(value)||value<0||value>limit)throw new Error(`Invalid bounded usage ${name}.`);return value;}
function usageComplete(value) {
  if(value?.[ACCOUNTING])return value[ACCOUNTING].calls>0&&value[ACCOUNTING].complete;
  return value!==null&&typeof value==='object'&&['input','output','cacheRead','cacheWrite'].reduce((sum,key)=>sum+(value[key]??0),0)>0&&['input','output','cacheRead','cacheWrite'].every(key=>Number.isFinite(value[key])&&value[key]>=0)&&['input','output','cacheRead','cacheWrite'].every(key=>Number.isFinite(value.cost?.[key])&&value.cost[key]>=0);
}
function annotateUsage(usage,metadata) {Object.defineProperty(usage,ACCOUNTING,{value:metadata,writable:true,configurable:true});return usage;}
function usageOf(value) {
  const usage=emptyUsage();
  for(const key of ['input','output','cacheRead','cacheWrite']){
    usage[key]=amount(value?.[key],key,1e12);
    usage.cost[key]=amount(value?.cost?.[key],`cost.${key}`,1e9);
  }
  for(const key of OPTIONAL_SUBSETS)if(value?.[key]!==undefined){
    const subset=amount(value[key],key,1e12);const parent=key==='reasoning'?'output':'cacheWrite';
    if(!Number.isInteger(subset)||(value[parent]!==undefined&&subset>usage[parent]))throw new Error(`Invalid bounded usage subset ${key}.`);
    usage[key]=subset;
  }
  // Optional subsets are already included in output/cacheWrite and never added twice.
  usage.totalTokens=usage.input+usage.output+usage.cacheRead+usage.cacheWrite;
  usage.cost.total=Number((usage.cost.input+usage.cost.output+usage.cost.cacheRead+usage.cost.cacheWrite).toFixed(12));
  return annotateUsage(usage,{calls:value?.[ACCOUNTING]?.calls??1,complete:usageComplete(value),known:Object.fromEntries(OPTIONAL_SUBSETS.map(key=>[key,usage[key]!==undefined]))});
}
function addUsage(total,value) {
  const usage=usageOf(value);const source=usage[ACCOUNTING];
  const prior=total[ACCOUNTING]??{calls:0,complete:true,known:Object.fromEntries(OPTIONAL_SUBSETS.map(key=>[key,true]))};
  for(const key of ['input','output','cacheRead','cacheWrite']) {total[key]+=usage[key];total.cost[key]+=usage.cost[key];}
  for(const key of OPTIONAL_SUBSETS){prior.known[key]=prior.known[key]&&source.known[key];if(prior.known[key])total[key]=(total[key]??0)+usage[key];else delete total[key];}
  prior.calls+=source.calls;prior.complete=prior.complete&&source.complete;annotateUsage(total,prior);
  total.totalTokens=total.input+total.output+total.cacheRead+total.cacheWrite;
  total.cost.total=Number((total.cost.input+total.cost.output+total.cost.cacheRead+total.cost.cacheWrite).toFixed(12));
}
function boundedText(value,maxBytes=MAX_OUTPUT_BYTES) {
  const bytes=Buffer.from(String(value??''),'utf8');
  if(bytes.length<=maxBytes)return {text:bytes.toString('utf8'),truncated:false};
  let end=maxBytes;
  while(end>0 && (bytes[end]&0xc0)===0x80)end--;
  return {text:bytes.subarray(0,end).toString('utf8'),truncated:true};
}
function identity(result) {
  if(result?.model!==undefined && result.model!==SELECTED_MODEL)throw new Error('Unexpected auxiliary physical model.');
  if(result?.thinkingLevel!==undefined && result.thinkingLevel!=='xhigh')throw new Error('Unexpected auxiliary thinking level.');
}
function nativeResult(text,{kind,status='complete',usage=emptyUsage(),checks=[],truncated=false,attempted=false,complete=false}={}) {
  const apexAux={version:1,kind,provider:'openrouter',model:'meta/muse-spark-1.3-contributor',attempted,complete};
  return {content:[{type:'text',text}],...(status==='complete'?{}:{isError:true}),...(attempted?{usage}:{}),details:{status,model:SELECTED_MODEL,thinkingLevel:'xhigh',depth:1,usage,checks,truncated,apexAux}};
}
function freshRequest(policy,{kind,task,cwd,systemPrompt,signal}) {
  return {policy,kind,task,cwd,systemPrompt,signal,model:SELECTED_MODEL,thinkingLevel:'xhigh',depth:1,tools:[...READ_TOOLS],history:[],maxTurns:MAX_TURNS,maxOutputBytes:MAX_OUTPUT_BYTES};
}

/** Only an explicit reviewable command list can run local checks; never use a shell. */
function checkCommand(command) {
  if(typeof command!=='string'||command.length>1000||!/^[\w./:@=+ -]+$/.test(command))throw new Error('Unsafe verification command syntax.');
  const argv=command.trim().split(/\s+/);
  const [program,...args]=argv;
  const allowed=(program==='node'&&args[0]==='--test') ||
    (program==='npm'&&(args.join(' ')==='test'||args.join(' ')==='run check')) ||
    ((program==='python3'||program==='python')&&args[0]==='-m'&&args[1]==='unittest') ||
    (program==='pytest');
  const safeNode=program!=='node'||args.slice(1).every(arg=>!arg.startsWith('-'));
  const safePytest=program!=='pytest'||args.every(arg=>!arg.startsWith('-')||['-q','-v','-x','--disable-warnings'].includes(arg)||/^--maxfail=[1-9]$/.test(arg));
  if(!allowed||!safeNode||!safePytest||args.some(arg=>arg.includes('..')||arg.startsWith('/')))throw new Error('Verification commands must be bounded noninteractive test/check invocations.');
  return {program,args};
}
function checkCommands(commands) {
  if(commands===undefined)return [];
  if(!Array.isArray(commands)||commands.length>4)throw new Error('At most four verification commands are allowed.');
  for(const command of commands)checkCommand(command);
  return [...commands];
}
function checkRecords(records,commands) {
  if(!Array.isArray(records)||records.length!==commands.length)throw new Error('Check runner must report every requested command.');
  return records.map((record,index)=>{
    if(record?.command!==commands[index]||!(record.exitCode===null||Number.isInteger(record.exitCode)))throw new Error('Invalid verification command evidence.');
    return {command:record.command,exitCode:record.exitCode,output:boundedText(record.output,4096).text,timedOut:record.timedOut===true,durationMs:amount(record.durationMs,'durationMs',60000)};
  });
}

export function createSubagentTools({policy,runSession,runChecks=localChecks,loadSdk}={}) {
  const sessionRunner=runSession??(request=>nativeSession(request,loadSdk));
  return ['explore','verify'].map(kind=>({
    name:kind,label:kind,description:kind==='explore'?'Fresh-context read-only codebase exploration.':'Independent verification with optional explicit tests in an isolated copy.',
    parameters:{type:'object',properties:{task:{type:'string',minLength:1,maxLength:20000},...(kind==='verify'?{commands:{type:'array',maxItems:4,items:{type:'string',maxLength:1000}}}:{})},required:['task'],additionalProperties:false},
    async execute(_id,params,signal,_onUpdate,ctx) {
      let usage=emptyUsage();let checks=[];let attempted=false;
      try {
        // This must precede prompt reads, context access and every adapter invocation.
        assertPolicy(policy);abort(signal);validateTask(params?.task);
        if((ctx?.depth??0)>=1||(ctx?.subagentDepth??0)>=1)throw new Error('Subagents are restricted to depth one.');
        const cwd=ctx?.cwd;
        if(typeof cwd!=='string'||!path.isAbsolute(cwd))throw new Error('Subagent cwd must be an explicit absolute path.');
        const commands=kind==='verify'?checkCommands(params.commands):[];
        const {readFile}=await import('node:fs/promises');abort(signal);
        const systemPrompt=await readFile(new URL(`../../prompts/${kind}.md`,import.meta.url),'utf8');
        let task=params.task;
        if(commands.length) {
          assertPolicy(policy);abort(signal);
          checks=checkRecords(await runChecks({policy,cwd,task,commands,signal}),commands);abort(signal);
          task+=`\n\nActual explicit verification checks (executed in an isolated copy):\n${JSON.stringify(checks)}\nAssess this evidence; do not claim additional tests ran.`;
        } else if(kind==='verify') task+='\n\nNo test commands were supplied. This run can inspect files only; report execution-dependent requirements as unverified.';
        assertPolicy(policy);abort(signal);
        attempted=true;
        const result=await sessionRunner(freshRequest(policy,{kind,task,cwd,systemPrompt,signal}));
        usage=usageOf(result?.usage);identity(result);abort(signal);
        if(typeof result?.text!=='string')throw new Error('Subagent session did not return text.');
        const bounded=boundedText(result.text);
        return nativeResult(bounded.text,{kind,usage,checks,truncated:bounded.truncated,attempted,complete:usageComplete(result?.usage)});
      } catch(error) {
        if(error?.usage)addUsage(usage,error.usage);
        const status=error?.name==='AbortError'||signal?.aborted?'aborted':error?.message===DENIED?'blocked':'error';
        return nativeResult(boundedText(error instanceof Error?error.message:String(error)).text,{kind,status,usage,checks,attempted,complete:false});
      }
    },
  }));
}

/**
 * Guarded native SDK path. The supplied loader deliberately never discovers or
 * reloads package/project/global resources. Native tool names are string allowlists.
 */
async function nativeSession(request,loadSdk=()=>import('@earendil-works/pi-coding-agent')) {
  assertPolicy(request.policy);abort(request.signal);
  const sdk=await loadSdk();assertPolicy(request.policy);abort(request.signal);
  const settingsManager=sdk.SettingsManager.inMemory({cacheWarming:'off',retry:{enabled:false,maxRetries:0,provider:{maxRetries:0,timeoutMs:60000}},compaction:{enabled:false},enableSkillCommands:false,packages:[],extensions:[],skills:[],prompts:[],themes:[],defaultProjectTrust:'never'});
  class ControlledLoader extends sdk.DefaultResourceLoader {
    getSystemPrompt(){return request.systemPrompt;}
    getAppendSystemPrompt(){return [];}
    getSystemPromptSource(){return undefined;}
    getAppendSystemPromptSources(){return [];}
    async reload(){} // Default reload performs discovery even with all five suppression flags.
    extendResources(resources){if(Object.values(resources).some(paths=>paths?.length))throw new Error('Auxiliary resource inheritance is disabled.');}
  }
  const resourceLoader=new ControlledLoader({cwd:request.cwd,agentDir:request.cwd,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:request.systemPrompt,appendSystemPrompt:[]});
  assertPolicy(request.policy);abort(request.signal);
  // No project model overlays, catalog refresh or persisted model/network cache.
  const nativeRuntime=await sdk.ModelRuntime.create({modelsPath:null,refreshOnCreate:false,allowModelNetwork:false,signal:request.signal});
  const modelRuntime=guardedRuntime(nativeRuntime,request);
  const model=modelRuntime.getModel('openrouter','meta/muse-spark-1.3-contributor');
  if(!model||model.provider!=='openrouter'||model.id!=='meta/muse-spark-1.3-contributor'||model.api==='pi-virtual'||model.thinkingLevelMap?.xhigh!=='xhigh')throw new Error('Exact physical Muse/xhigh is unavailable in the native catalog.');
  const customTools=await restrictedTools(sdk,request.cwd,request.signal);
  assertPolicy(request.policy);abort(request.signal);
  const {session}=await sdk.createAgentSession({cwd:request.cwd,agentDir:request.cwd,modelRuntime,model,thinkingLevel:'xhigh',tools:[...READ_TOOLS],customTools,resourceLoader,settingsManager,sessionManager:sdk.SessionManager.inMemory(request.cwd)});
  let turns=0;let limit=false;
  const usage=emptyUsage();let unsubscribe;let failure;
  const stop=()=>{try{void Promise.resolve(session.abort()).catch(()=>{});}catch{}};
  try {
    if(session.model?.provider!=='openrouter'||session.model?.id!=='meta/muse-spark-1.3-contributor'||session.thinkingLevel!=='xhigh')throw new Error('Native session changed required physical model or thinking.');
    // createAgentSession does not emit startup; binding initializes the native tools.
    await session.bindExtensions({mode:'headless'});
    unsubscribe=session.subscribe(event=>{
      if(event.type==='message_end'&&event.message?.role==='assistant')addUsage(usage,event.message.usage);
      if(event.type==='turn_end'&&++turns>=MAX_TURNS&&(event.message?.stopReason==='toolUse'||event.message?.content?.some(part=>part.type==='toolCall'))){limit=true;stop();}
    });
    request.signal?.addEventListener('abort',stop,{once:true});abort(request.signal);
    assertPolicy(request.policy);
    await session.prompt(request.task,{expandPromptTemplates:false});abort(request.signal);
    if(limit)throw new Error('Subagent exceeded its eight-turn bound.');
    const last=[...session.messages].reverse().find(message=>message.role==='assistant');
    if(!last||last.stopReason==='error'||last.stopReason==='aborted')throw new Error(last?.errorMessage??'Native auxiliary session failed.');
    return {text:last.content.filter(part=>part.type==='text').map(part=>part.text).join('\n'),usage,model:SELECTED_MODEL,thinkingLevel:'xhigh'};
  } catch(error) {failure=error;error.usage=usage;throw error;}
  finally {
    request.signal?.removeEventListener('abort',stop);const errors=[];
    try{unsubscribe?.();}catch(error){errors.push(error);}
    try{await session.abort();}catch(error){errors.push(error);}
    try{session.dispose();}catch(error){errors.push(error);}
    if(errors.length){if(failure)failure.cleanupErrors=errors.map(error=>String(error));else{const error=new AggregateError(errors,'Auxiliary session cleanup failed.');error.usage=usage;throw error;}}
  }
}

/** Guard every native runtime request, including lazy preparation and inner auth calls. */
function guardedRuntime(runtime,request) {
  const check=signal=>{assertPolicy(request.policy);abort(request.signal);abort(signal);};
  const physical=model=>{
    if(model?.provider!=='openrouter'||model?.id!=='meta/muse-spark-1.3-contributor'||model.api==='pi-virtual'||model.thinkingLevelMap?.xhigh!=='xhigh')throw new Error('Auxiliary request must use the exact physical Muse/xhigh model.');
  };
  // Pi 0.99.2 ModelRuntime uses ordinary properties, so preserving the proxy receiver
  // also guards its lazy prepareRequest -> getAuth chain without editing SDK code.
  return new Proxy(runtime,{get(target,name,receiver){
    check();const value=Reflect.get(target,name,receiver);
    if(typeof value!=='function')return value;
    return (...args)=>{
      check(args.at(-1)?.signal);
      if(name==='streamSimple'||name==='completeSimple') {physical(args[0]);if(args[2]?.reasoning!=='xhigh')throw new Error('Auxiliary native reasoning must remain exactly xhigh.');}
      if(name==='stream'||name==='complete')throw new Error('Auxiliary requests require the neutral streamSimple xhigh interface.');
      if(name==='getAuth'){if(typeof args[0]==='string'){if(args[0]!=='openrouter')throw new Error('Auxiliary auth must use the exact physical Muse provider.');}else physical(args[0]);}
      if(name==='hasConfiguredAuth'&&args[0]!=='openrouter')throw new Error('Auxiliary auth must use the exact physical Muse provider.');
      if(name==='resolveModel'){physical(args[0]);if(args[2]?.thinkingLevel!=='xhigh')throw new Error('Auxiliary native reasoning must remain exactly xhigh.');}
      const result=Reflect.apply(value,receiver,args);
      if(result&&typeof result.then==='function')return result.then(value=>{check(args.at(-1)?.signal);return value;});
      return result;
    };
  }});
}

/** Native read schemas, confined paths and installed search binaries; no auto-downloads. */
async function restrictedTools(sdk,cwd,signal) {
  const fs=await import('node:fs/promises');const root=await fs.realpath(cwd);
  const definitions=[sdk.createReadToolDefinition(cwd),sdk.createGrepToolDefinition(cwd),sdk.createFindToolDefinition(cwd),sdk.createLsToolDefinition(cwd)];
  return definitions.map(definition=>({...definition,async execute(id,args,toolSignal,onUpdate) {
    abort(signal);abort(toolSignal);
    const target=path.resolve(root,args.path??'.');const real=await fs.realpath(target);
    if(real!==root&&!real.startsWith(root+path.sep))throw new Error('Auxiliary tool paths must remain inside the repository.');
    const parameters={...args,path:real,limit:Math.min(Number.isInteger(args.limit)&&args.limit>0?args.limit:120,200)};
    let result;
    if(definition.name==='grep'||definition.name==='find') {
      const argv=definition.name==='find'?['--files','--hidden','--no-require-git','--glob',String(args.pattern),'--',real]:['--line-number','--color=never','--hidden','--no-require-git','--max-count',String(parameters.limit),...(args.ignoreCase?['--ignore-case']:[]),...(args.literal?['--fixed-strings']:[]),...(args.glob?['--glob',args.glob]:[]),'--',String(args.pattern),real];
      const evidence=await runCommand('rg',argv,{cwd:root,signal:toolSignal??signal,maxBytes:16384,timeoutMs:10000});
      if(evidence.exitCode!==0&&evidence.exitCode!==1)throw new Error(`Installed rg search failed: ${evidence.output}`);
      result={content:[{type:'text',text:evidence.output||'No matches.'}],details:{truncated:evidence.truncated}};
    } else {
      if(definition.name==='read') {const stat=await fs.stat(real);if(stat.size>4*1024*1024||/\.(png|jpe?g|gif|webp|bmp|tiff?|ico|heic|avif)$/i.test(real))throw new Error('Auxiliary read supports bounded text files only.');}
      result=await definition.execute(id,parameters,toolSignal??signal,onUpdate,{cwd:root});
    }
    const bounded=boundedText(result.content.filter(part=>part.type==='text').map(part=>part.text).join('\n'),16384);
    return {...result,content:[{type:'text',text:bounded.text}],details:{...result.details,truncated:bounded.truncated||result.details?.truncated===true}};
  }}));
}

/** Fresh repository copies include current uncommitted files; never allocate while offline. */
async function copyIsolation({policy,cwd,signal}) {
  assertPolicy(policy);abort(signal);
  const fs=await import('node:fs/promises');const root=await fs.realpath(cwd);const stat=await fs.stat(root);
  if(!stat.isDirectory())throw new Error('Isolation cwd must be a repository directory.');
  // A sibling temporary directory cannot be recursively included in the source copy.
  const owned=await fs.mkdtemp(path.join(path.dirname(root),'.apex-isolation-'));await fs.chmod(owned,0o700);
  const destination=path.join(owned,'repository');let files=0;let bytes=0;let cleaned=false;
  const cleanup=async()=>{if(!cleaned){await fs.rm(owned,{recursive:true,force:true});cleaned=true;}};
  async function copy(from,to) {
    abort(signal);if(++files>50000)throw new Error('Repository isolation exceeds 50000 entries.');
    const info=await fs.lstat(from);
    if(info.isSymbolicLink()) {
      // Rewrite internal links into the copy; preserve relative executable/import behavior.
      const target=await fs.realpath(from);
      if(target!==root&&!target.startsWith(root+path.sep))throw new Error('Repository isolation rejects external symlinks.');
      const relative=path.relative(root,target);
      if(relative.split(path.sep).some(part=>['.git','.apex','__pycache__','.pytest_cache'].includes(part)))throw new Error('Repository isolation rejects links into excluded resources.');
      const copiedTarget=path.join(destination,relative);
      await fs.symlink(path.relative(path.dirname(to),copiedTarget)||'.',to);return;
    }
    if(info.isDirectory()) {
      await fs.mkdir(to,{mode:0o700});
      for(const entry of (await fs.readdir(from)).sort())if(!['.git','.apex','__pycache__','.pytest_cache'].includes(entry))await copy(path.join(from,entry),path.join(to,entry));
    } else if(info.isFile()) {
      bytes+=info.size;if(bytes>300*1024*1024)throw new Error('Repository isolation exceeds 300 MiB.');
      await fs.copyFile(from,to);await fs.chmod(to,info.mode&0o700);
    } else throw new Error('Repository isolation supports ordinary files only.');
  }
  try {await copy(root,destination);return {cwd:destination,cleanup};}catch(error){await cleanup();throw error;}
}

async function runCommand(program,args,{cwd,signal,maxBytes=4096,timeoutMs=30000}) {
  abort(signal);const {spawn}=await import('node:child_process');abort(signal);
  return new Promise((resolve,reject)=>{
    const start=performance.now();let output=Buffer.alloc(0);let timedOut=false;let truncated=false;let settled=false;
    // Do not expose provider credentials or shell startup/node injection variables to check scripts.
    const env={PATH:process.env.PATH??'',LANG:'C.UTF-8',CI:'1',HOME:cwd,TMPDIR:cwd,PYTHONDONTWRITEBYTECODE:'1',npm_config_update_notifier:'false',npm_config_audit:'false',npm_config_fund:'false',npm_config_offline:'true'};
    const child=spawn(program,args,{cwd,env,shell:false,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
    const kill=()=>{try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
    const onAbort=()=>kill();signal?.addEventListener('abort',onAbort,{once:true});
    const timer=setTimeout(()=>{timedOut=true;kill();},timeoutMs);
    const collect=chunk=>{const available=maxBytes-output.length;if(chunk.length>available)truncated=true;if(available>0)output=Buffer.concat([output,chunk.subarray(0,available)]);};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    const finish=(error,code)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);if(error)return reject(error);if(signal?.aborted){const cancelled=new Error('Verification command aborted.');cancelled.name='AbortError';return reject(cancelled);}resolve({exitCode:code,output:boundedText(output.toString('utf8'),maxBytes).text,timedOut,truncated,durationMs:Math.min(60000,performance.now()-start)});};
    child.on('error',error=>finish(error));child.on('close',code=>finish(undefined,code));
    if(signal?.aborted)kill();
  });
}
async function localChecks({policy,cwd,commands,signal}) {
  assertPolicy(policy);abort(signal);const checked=checkCommands(commands);const isolation=await copyIsolation({policy,cwd,signal});
  try {
    const records=[];
    for(const command of checked){assertPolicy(policy);abort(signal);const {program,args}=checkCommand(command);records.push({command,...await runCommand(program,args,{cwd:isolation.cwd,signal})});}
    return records;
  }finally{await isolation.cleanup();}
}

/** Independent max configuration. Runtime callers must supply real attempt and verification adapters. */
export async function runMaxAttempts(options={}) {
  try{return await maxAttempts(options);}catch(error){if(typeof error.usageComplete!=='boolean')error.usageComplete=false;throw error;}
}

async function maxAttempts(options) {
  // Avoid destructuring cwd/adapters until the policy permits all auxiliary work.
  const policy=options.policy;assertPolicy(policy);
  const {cwd,task,attempts=2,createIsolation=copyIsolation,runAttempt,verifyAttempt,judge,signal}=options;
  abort(signal);validateTask(task);
  if(!Number.isInteger(attempts)||attempts<1||attempts>5)throw new Error('Max attempts must be an integer from one to five.');
  if(typeof cwd!=='string'||!path.isAbsolute(cwd))throw new Error('Max cwd must be an absolute repository path.');
  if(typeof runAttempt!=='function'||typeof verifyAttempt!=='function')throw new Error('Max requires real attempt and verification adapters.');
  const candidates=[];const isolations=[];const usedPaths=new Set();const usage=emptyUsage();let failure;let pendingHelper=false;
  const invoke=async(callback,request)=>{pendingHelper=true;const result=await callback(request);addUsage(usage,result?.usage);pendingHelper=false;return result;};
  try {
    for(let index=0;index<attempts;index++) {
      assertPolicy(policy);abort(signal);
      const isolation=await createIsolation({policy,cwd,index,signal});
      if(typeof isolation?.cleanup==='function')isolations.push(isolation);
      if(typeof isolation?.cwd!=='string'||!path.isAbsolute(isolation.cwd)||typeof isolation.cleanup!=='function'||path.resolve(isolation.cwd)===path.resolve(cwd)||usedPaths.has(path.resolve(isolation.cwd)))throw new Error('Max attempts require distinct isolated repository paths with cleanup.');
      usedPaths.add(path.resolve(isolation.cwd));abort(signal);
      const request={policy,cwd:isolation.cwd,task,index,signal,model:SELECTED_MODEL,thinkingLevel:'xhigh',history:[],configuration:'max'};
      assertPolicy(policy);const result=await invoke(runAttempt,request);identity(result);abort(signal);
      const bounded=boundedText(result?.text);assertPolicy(policy);
      const verification=await invoke(verifyAttempt,{...request,history:[],candidate:{text:bounded.text,truncated:bounded.truncated}});identity(verification);abort(signal);
      if(typeof verification?.passed!=='boolean'||(verification.score!==undefined&&!Number.isFinite(verification.score)))throw new Error('Max verification requires a boolean passed and finite score.');
      candidates.push({index,text:bounded.text,truncated:bounded.truncated,verification:{passed:verification.passed,score:verification.score??0,checks:boundedText(JSON.stringify(verification.checks??[])).text},usage:usageOf(result?.usage),usageComplete:usageComplete(result?.usage)});
    }
    const passing=candidates.filter(candidate=>candidate.verification.passed).sort((a,b)=>b.verification.score-a.verification.score||a.index-b.index);
    let winner=passing[0]??null;
    const ties=winner?passing.filter(candidate=>candidate.verification.score===winner.verification.score):[];
    if(ties.length>1) {
      if(typeof judge!=='function')throw new Error('Tied max candidates require an authorized judge adapter.');
      assertPolicy(policy);abort(signal);
      const decision=await invoke(judge,{policy,task,candidates:ties,signal,model:SELECTED_MODEL,thinkingLevel:'xhigh',history:[],configuration:'max'});identity(decision);abort(signal);
      winner=ties.find(candidate=>candidate.index===decision?.index);
      if(!winner)throw new Error('Judge selected a candidate outside the verified tie.');
    }
    return {configuration:'max',status:winner?'complete':'failed',winner,candidates,usage,usageComplete:usageComplete(usage)};
  }catch(error){
    failure=error;
    if(pendingHelper||error?.usage)try{addUsage(usage,error?.usage);}catch{addUsage(usage,undefined);}
    error.usage=usage;error.usageComplete=usageComplete(usage);throw error;
  }
  finally {
    const errors=[];
    for(const isolation of isolations.reverse())try{await isolation.cleanup();}catch(error){errors.push(error);}
    if(errors.length){if(failure)failure.cleanupErrors=errors.map(error=>String(error));else{const error=new AggregateError(errors,'Max isolation cleanup failed.');error.usage=usage;error.usageComplete=usageComplete(usage);throw error;}}
  }
}

/** Pi 0.99.2 Settings.retry: agent backoff only; no hidden provider retry multiplication. */
export function recoverySettings({policy,maxRetries=2,baseDelayMs=1000}={}) {
  if(policy?.paid_runs_enabled!==true||policy?.execution_policy!=='paid-enabled')return {retry:{enabled:false,maxRetries:0,baseDelayMs:1000,maxAgentDelayMs:8000,provider:{maxRetries:0,maxRetryDelayMs:8000,timeoutMs:60000}}};
  assertPolicy(policy);
  if(!Number.isInteger(maxRetries)||maxRetries<0||maxRetries>3)throw new Error('Recovery retries must be an integer from zero to three.');
  if(!Number.isInteger(baseDelayMs)||baseDelayMs<1||baseDelayMs>10000)throw new Error('Recovery delay must be an integer from 1 to 10000 milliseconds.');
  return {retry:{enabled:maxRetries>0,maxRetries,baseDelayMs,maxAgentDelayMs:8000,provider:{maxRetries:0,maxRetryDelayMs:8000,timeoutMs:60000}}};
}

/** Native SDK/session seam; ordinary extension ctx has no writable settings API. */
export function applyRecoverySettings(session,options={}) {
  const settings=recoverySettings(options);
  if(options.policy?.paid_runs_enabled!==true||options.policy?.execution_policy!=='paid-enabled')return {applied:false,settings,reason:DENIED};
  assertPolicy(options.policy);
  if(typeof session?.settingsManager?.applyOverrides!=='function')throw new Error('Recovery requires a native session SettingsManager.applyOverrides seam.');
  session.settingsManager.applyOverrides(settings);
  return {applied:true,settings};
}
