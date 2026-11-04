export const SELECTED_MODEL = 'openrouter/meta/muse-spark-1.3-contributor';
export const CONTEXT_FEATURES = Object.freeze(['cache','shape','mask','compact','read','search','edit','patch','lazy','route','output','browser','computer']);

export function parseContextFlags(value) {
  if (value === undefined || value === '') return Object.freeze([]);
  if (typeof value !== 'string') throw new Error('Apex context features must be a comma-separated string');
  if (value === 'all') return CONTEXT_FEATURES;
  const names=value.split(',');
  if (names.some(name=>!CONTEXT_FEATURES.includes(name)) || new Set(names).size!==names.length) {
    throw new Error('Unknown or duplicate Apex context feature; use '+CONTEXT_FEATURES.join(','));
  }
  return Object.freeze(names);
}

export function runtimePolicy() {
  // The latest free-only authorization freezes auxiliary inference independently
  // of old cap/key state. A future authorized policy change requires explicit code/config review.
  return Object.freeze({allowed_model:SELECTED_MODEL,thinking_level:'xhigh',
    paid_runs_enabled:false,execution_policy:'offline-only'});
}

// Pi flags are extension-local. Share only explicit selected context definitions
// by the native session manager identity; this never performs resource discovery.
const selectedContexts=new WeakMap();
export function markContextFeatures(ctx,features){const manager=ctx.sessionManager;const value=Object.freeze([...features]);selectedContexts.set(manager,value);return ()=>{if(selectedContexts.get(manager)===value)selectedContexts.delete(manager);};}
export function contextFeaturesFor(ctx){return selectedContexts.get(ctx.sessionManager);}
