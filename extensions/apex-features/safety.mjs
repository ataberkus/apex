/**
 * TUI/RPC (dashboard) approval UX; annotation hints are unverified and this is not an OS sandbox. A TUI with a selector
 * may grant one tool and tier (write/exec) for the rest of this gate's session. Catastrophic shell commands always ask
 * per call, and without an interactive client (or in eval mode) they are blocked while everything else passes unasked.
 */
import {catastrophic} from '../../lib/catastrophic.mjs';
import {interactiveApproval} from './lifecycle.mjs';
const READ_ONLY=new Set(['read','grep','find','ls','ast_grep']);
const WRITES=new Set(['write','edit','apply_patch']);
const SHELLS=new Set(['bash','powershell']);
const TIMEOUT=15000;
const denied=reason=>({block:true,reason});
const dangerous=(name,input)=>SHELLS.has(name)&&typeof input?.command==='string'&&catastrophic(input.command);
function argumentsText(input){
 try{const text=JSON.stringify(input??{});return typeof text==='string'?text.slice(0,2000)+(text.length>2000?' [truncated]':''):'(unavailable)';}
 catch{return '(arguments unavailable)';}
}

// Only a single literal display command is exempted. Substitutions, redirects,
// separators, expansion and shell syntax outside quotes require approval.
function literalDisplay(command){
 if(typeof command!=='string'||command.length>10000)return false;
 let quote;let escaped=false;let executable='';let first=true;
 for(let index=0;index<command.length;index++){
  const char=command[index];
  if(escaped){escaped=false;if(first)executable+=char;continue;}
  if(char==='\\'&&quote!=="'"){escaped=true;continue;}
  if(quote){if(char===quote){quote=undefined;continue;}if(quote==='"'&&(char==='$'||char==='`'))return false;if(first)executable+=char;continue;}
  if(char==='"'||char==="'"){quote=char;continue;}
  if(/[;&|<>\n\r`()$]/.test(char))return false;
  if(/\s/.test(char)){if(executable)first=false;continue;}
  if(first)executable+=char;
 }
 return !quote&&!escaped&&['echo','printf','pwd','true'].includes(executable);
}
// Bounded by TIMEOUT and ctx.signal even if the UI ignores its abort signal; a late answer is ignored (undefined).
async function answer(ctx,ask){
 const controller=new AbortController();let cancel;let timer;
 const canceled=new Promise(resolve=>{cancel=()=>{controller.abort();resolve(undefined);};timer=setTimeout(cancel,TIMEOUT);});
 ctx.signal?.addEventListener('abort',cancel,{once:true});
 try{const value=await Promise.race([Promise.resolve().then(()=>ask({signal:controller.signal,timeout:TIMEOUT})),canceled]);return controller.signal.aborted?undefined:value;}
 finally{clearTimeout(timer);ctx.signal?.removeEventListener('abort',cancel);controller.abort();}
}
const failed=error=>denied(`Safety approval failed: ${String(error?.message??error).slice(0,500)}`);

export function createSafetyGate({pi,evalMode=false}={}){
 // Session grants (omp sessionApprovalScope): `${tool}\0${tier}`, held only by this gate instance.
 const grants=new Set();
 return {async check(event,ctx){
  const name=event?.toolName;
  // No annotation queries, prompts or approval timers outside an interactive TUI or RPC client (dashboard Allow/Deny).
  if(evalMode||!interactiveApproval(ctx))return dangerous(name,event?.input)?denied('Catastrophic command blocked: no interactive approval available'):undefined;
  if(ctx.signal?.aborted)return denied('Safety approval was canceled.');
  if(READ_ONLY.has(name))return undefined;
  const label=`Tool: ${typeof name==='string'?name.slice(0,100):'unknown'}${event?.parentToolCallId?' (nested call)':''}`;
  if(name==='bash'&&literalDisplay(event?.input?.command))return undefined;
  if(dangerous(name,event?.input)){
   // Never covered by a session grant, and the dashboard auto-approve answers only 'Confirm tool action'.
   try{return await answer(ctx,options=>ctx.ui.confirm('Confirm catastrophic command',`${label}\nCommand: ${event.input.command.slice(0,2000)}\nThis command matches a catastrophic pattern. This approval is for this call only.`,options))===true?undefined:denied('Catastrophic command was not confirmed.');}
   catch(error){return failed(error);}
  }
  const tier=WRITES.has(name)?'write':'exec';
  const key=`${name}\0${tier}`;
  if(grants.has(key))return undefined;
  let why;
  if(WRITES.has(name))why='The native tool can modify or overwrite project files.';
  else if(SHELLS.has(name))why='Shell commands can modify files, run programs or reach external systems.';
  else{
   const annotations=pi?.getAllTools?.().find(tool=>tool.name===name)?.annotations;
   if(annotations?.readOnlyHint===true&&annotations.destructiveHint!==true&&annotations.openWorldHint!==true)return undefined;
   why=annotations?.destructiveHint===true?'The tool declares a destructive hint.':annotations?.openWorldHint===true?'The tool declares an open-world hint.':'The tool has no verified read-only classification.';
  }
  const message=`${label}\nArguments: ${argumentsText(event?.input)}\n${why}\nTool annotation hints are unverified.`;
  try{
   if(ctx.mode==='tui'&&typeof ctx.ui.select==='function'){
    const session=`Allow ${typeof name==='string'?name.slice(0,100):'unknown'} (${tier}) for this session`;
    const choice=await answer(ctx,options=>ctx.ui.select(message,['Allow once',session,'Deny'],options));
    if(choice===session){grants.add(key);return undefined;}
    return choice==='Allow once'?undefined:denied('Tool action was not confirmed.');
   }
   return await answer(ctx,options=>ctx.ui.confirm('Confirm tool action',`${message} This approval is for this call only.`,options))===true?undefined:denied('Tool action was not confirmed.');
  }catch(error){return failed(error);}
 }};
}
