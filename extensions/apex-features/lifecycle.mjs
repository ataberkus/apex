/** Explicit lifecycle coordination across Pi's extension-local flag APIs. No I/O. */
const modes=new WeakMap();
const key=ctx=>{const manager=ctx?.sessionManager;return manager!==null&&typeof manager==='object'?manager:null;};
export function markFeatureMode(ctx,{owner,safety=false,evalMode=false}){
 const id=key(ctx);if(id===null)return ()=>{};
 modes.set(id,{owner,safety,evalMode});
 return ()=>{if(modes.get(id)?.owner===owner)modes.delete(id);};
}
/** A TUI or RPC (dashboard) client that can answer a confirmation. */
export function interactiveApproval(ctx){return ['tui','rpc'].includes(ctx?.mode)&&ctx?.hasUI===true&&typeof ctx?.ui?.confirm==='function';}
/** The selected safety feature prompts for this session, so core leaves catastrophic commands to it. */
export function featureSafetyPrompts(ctx){const mode=modes.get(key(ctx));return mode?.safety===true&&mode.evalMode!==true&&interactiveApproval(ctx);}
/** `--apex-eval` never prompts or waits. */
export function featureEvalMode(ctx){return modes.get(key(ctx))?.evalMode===true;}
