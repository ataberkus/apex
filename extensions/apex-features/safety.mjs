/** TUI/RPC (dashboard) approval UX; annotation hints are unverified and this is not an OS sandbox. */
const READ_ONLY=new Set(['read','grep','find','ls']);
const WRITES=new Set(['write','edit']);
const TIMEOUT=15000;
const denied=reason=>({block:true,reason});
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
async function confirm(ctx,message){
 if(ctx.signal?.aborted)return denied('Safety approval was canceled.');
 const controller=new AbortController();let cancel;let timer;
 const canceled=new Promise(resolve=>{cancel=()=>{controller.abort();resolve(false);};timer=setTimeout(cancel,TIMEOUT);});
 ctx.signal?.addEventListener('abort',cancel,{once:true});
 try{
  const approved=await Promise.race([Promise.resolve().then(()=>ctx.ui.confirm('Confirm tool action',message,{signal:controller.signal,timeout:TIMEOUT})),canceled]);
  return approved===true&&!controller.signal.aborted?undefined:denied('Tool action was not confirmed.');
 }catch(error){return denied(`Safety approval failed: ${String(error?.message??error).slice(0,500)}`);}
 finally{clearTimeout(timer);ctx.signal?.removeEventListener('abort',cancel);controller.abort();}
}

export function createSafetyGate({pi,evalMode=false}={}){
 return {async check(event,ctx){
  // No annotation queries, prompts or approval timers outside an interactive TUI or RPC client (dashboard Allow/Deny).
  if(evalMode||!['tui','rpc'].includes(ctx?.mode)||ctx.hasUI!==true||typeof ctx.ui?.confirm!=='function')return undefined;
  if(ctx.signal?.aborted)return denied('Safety approval was canceled.');
  const name=event?.toolName;
  if(READ_ONLY.has(name))return undefined;
  let why;
  if(WRITES.has(name))why='The native tool can modify or overwrite project files.';
  else if(name==='bash'||name==='powershell'){
   if(name==='bash'&&literalDisplay(event?.input?.command))return undefined;
   why='Shell commands can modify files, run programs or reach external systems.';
  }else{
   const annotations=pi?.getAllTools?.().find(tool=>tool.name===name)?.annotations;
   if(annotations?.readOnlyHint===true&&annotations.destructiveHint!==true&&annotations.openWorldHint!==true)return undefined;
   why=annotations?.destructiveHint===true?'The tool declares a destructive hint.':annotations?.openWorldHint===true?'The tool declares an open-world hint.':'The tool has no verified read-only classification.';
  }
  return confirm(ctx,`Tool: ${typeof name==='string'?name.slice(0,100):'unknown'}${event?.parentToolCallId?' (nested call)':''}\nArguments: ${argumentsText(event?.input)}\n${why}\nTool annotation hints are unverified. This approval is for this call only.`);
 }};
}
