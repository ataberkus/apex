import { readFile } from 'node:fs/promises';
import { parseContextFlags, runtimePolicy, markContextFeatures } from './config.mjs';
import { capRoutinePayload, createCacheLedger } from './cache.mjs';

export default function apexContext(pi) {
  pi.registerFlag('apex-context-flags',{type:'string',default:'',description:'Opt-in Apex context feature names, comma-separated; all experiments default off.'});
  let releaseFeatures=()=>{};
  let features=new Set(),ledger=createCacheLedger(),shape,mask,compact,prompt='',browser,computer;
  // The browser tool owns a Chrome/Edge process and the computer tool a PowerShell host; every re-initialisation and shutdown closes them.
  const closeTools=async()=>{const open=[browser,computer];browser=computer=undefined;await Promise.all(open.map(tool=>tool?.close()));};

  const restoreLedger=ctx=>{
    ledger=createCacheLedger();
    for(const entry of ctx.sessionManager.getBranch()) if(entry.type==='message')ledger.observeMessage(entry.message);
  };
  const observePrefix=ctx=>{
    if(!features.has('cache'))return;
    const active=pi.getActiveTools();
    const selected=new Set(active);
    ledger.observePrefix({sections:prompt?{apex_efficiency:prompt}:{},active_names:active,
      tools:pi.getAllTools().filter(tool=>selected.has(tool.name)).map(tool=>({name:tool.name,parameters:tool.parameters,description:tool.description})),
      thinkingLevel:ctx.thinkingLevel??'xhigh'});
  };
  const initialize=async(_event,ctx)=>{
    await closeTools();
    releaseFeatures();features=new Set(parseContextFlags(pi.getFlag('apex-context-flags')));releaseFeatures=markContextFeatures(ctx,features);
    restoreLedger(ctx);
    shape=mask=compact=undefined;prompt='';
    if(!features.size)return;
    if(features.has('shape'))shape=(await import('./shaping.mjs')).shapeToolResult;
    if(features.has('mask'))mask=(await import('./masking.mjs')).planMasking;
    if(features.has('compact'))compact=(await import('./compaction.mjs')).createCompactionHandler({policy:runtimePolicy()});
    if(features.has('output'))prompt=(await readFile(new URL('../../prompts/context-efficiency.md',import.meta.url),'utf8')).trim();
    if([...features].some(name=>['read','search','edit','patch'].includes(name))) {
      const tools=(await import('./tools.mjs')).createEfficientTools({cwd:ctx.cwd,features});
      for(const tool of tools)pi.registerTool(tool);
      pi.setActiveTools([...new Set([...pi.getActiveTools(),...tools.filter(tool=>
        !['deferred','codemode','hidden'].includes(tool.exposure)&&tool.defaultActive!==false).map(tool=>tool.name)])]);
    }
    if(features.has('lazy')) {
      const names=(await import('./lazy.mjs')).registerLazyTools(pi);
      pi.setActiveTools([...new Set([...pi.getActiveTools(),...names])]);
    }
    if(features.has('browser')) {
      browser=(await import('./browser.mjs')).createBrowserTool();
      pi.registerTool(browser);
      pi.setActiveTools([...new Set([...pi.getActiveTools(),browser.name])]);
    }
    if(features.has('computer')) {
      computer=(await import('./computer.mjs')).createComputerTool();
      pi.registerTool(computer);
      pi.setActiveTools([...new Set([...pi.getActiveTools(),computer.name])]);
    }
  };
  pi.on('session_start',initialize);
  pi.on('session_tree',initialize);
  pi.on('session_fork',initialize);
  pi.on('session_shutdown',async()=>{releaseFeatures();features=new Set();shape=mask=compact=undefined;prompt='';ledger=createCacheLedger();await closeTools();});
  pi.on('before_agent_start',(event,ctx)=>{
    if(prompt)event.systemPromptOptions.sections.apex_efficiency=prompt;
    observePrefix(ctx);
  });
  // Observe every request without rewriting its messages or prefix.
  pi.on('context',(_event,ctx)=>{observePrefix(ctx);});
  pi.on('tool_result',(event,ctx)=>shape?shape(event,{cwd:ctx.cwd}):undefined);
  pi.on('turn_end',(event,ctx)=>mask?mask(event,ctx):undefined);
  pi.on('session_before_compact',(event,ctx)=>compact?compact(event,ctx):undefined);
  pi.on('message_end',event=>{if(features.has('cache'))ledger.observeMessage(event.message);});
  pi.on('agent_settled',()=>{if(features.has('cache'))pi.appendEntry('apex-cache',ledger.snapshot());});
  pi.on('before_provider_request',(event,ctx)=>{
    if(!features.has('output'))return;
    const branch=ctx.sessionManager.getBranch();
    const messages=branch.filter(entry=>entry.type==='message').map(entry=>entry.message);
    const last=messages.findLast(message=>message.role==='assistant');
    const signal=branch.findLast(entry=>entry.type==='custom'&&entry.customType==='apex-routing')?.data;
    const routine=messages.filter(message=>message.role==='assistant'&&!['error','aborted'].includes(message.stopReason)).length>10 &&
      !messages.slice(-4).some(message=>message.role==='toolResult'&&message.isError) &&
      !['error','aborted'].includes(last?.stopReason)&&signal?.phase!=='verification';
    const next=capRoutinePayload(event.payload,{routine});
    if(next!==event.payload)return next;
  });
}
