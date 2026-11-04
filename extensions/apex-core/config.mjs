export {runtimePolicy,SELECTED_MODEL} from '../apex-context/config.mjs';
export const CORE_FEATURES=Object.freeze(['snapshot','entrypoints','headless','contract','todo','verify','loops','bg','time','correct','diagnostics','subagents','max','recovery']);

export function parseCoreFlags(value) {
  if(value===undefined||value==='')return Object.freeze([]);
  if(typeof value!=='string')throw new Error('Apex core features must be a comma-separated string');
  if(value==='all')return CORE_FEATURES;
  const names=value.split(',');
  if(names.some(name=>!CORE_FEATURES.includes(name))||new Set(names).size!==names.length)
    throw new Error('Unknown or duplicate Apex core feature; use '+CORE_FEATURES.join(','));
  return Object.freeze(names);
}
export function parseTimeBudget(value) {
  if(value===undefined)return undefined;
  if((typeof value!=='string'&&typeof value!=='number')||
    !/^\d+(?:\.\d+)?$/.test(String(value)))throw new Error('Time budget must be positive seconds');
  const seconds=Number(value);
  if(!Number.isFinite(seconds)||seconds<=0||seconds>86400)throw new Error('Time budget must be at most 86400 positive seconds');
  return seconds;
}
export function parseAttempts(value) {
  if(value===undefined)return 2;
  if((typeof value!=='string'&&typeof value!=='number')||!/^\d+$/.test(String(value)))throw new Error('Apex attempts must be an integer');
  const attempts=Number(value);
  if(!Number.isInteger(attempts)||attempts<2||attempts>5)throw new Error('Apex attempts must be between two and five');
  return attempts;
}
