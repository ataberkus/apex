/** Explicit lifecycle coordination across Pi's extension-local flag APIs. No I/O. */
const modes=new WeakMap();
const key=ctx=>{const manager=ctx?.sessionManager;return manager!==null&&typeof manager==='object'?manager:null;};
export function markFeatureMode(ctx,{owner,safety=false,evalMode=false}){
 const id=key(ctx);if(id===null)return ()=>{};
 modes.set(id,{owner,safety,evalMode});
 return ()=>{if(modes.get(id)?.owner===owner)modes.delete(id);};
}
export function featureSafetyManaged(ctx){const mode=modes.get(key(ctx));return mode?.safety===true||mode?.evalMode===true;}
