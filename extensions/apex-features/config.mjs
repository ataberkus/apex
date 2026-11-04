export {runtimePolicy,SELECTED_MODEL} from '../apex-context/config.mjs';
export const FEATURE_FEATURES=Object.freeze(['cost','checkpoints','review','plan','remember','skills','safety','report','resume','autocompact']);
// Default context size at which autocompact asks Pi's native compaction to summarize a settled session.
export const AUTOCOMPACT_TOKENS=300_000;
// `--autocompact-tokens` text; empty means the default.
export function parseAutocompactTokens(value){
 if(value===undefined||value==='')return AUTOCOMPACT_TOKENS;
 if(!/^\d+$/.test(String(value)))throw Error('Autocompact threshold must be a whole number of tokens');
 const tokens=Number(value);
 if(tokens<1||tokens>100_000_000)throw Error('Autocompact threshold must be between 1 and 100000000 tokens');
 return tokens;
}
export function parseFeatureFlags(value){
 if(value===undefined||value==='')return Object.freeze([]);
 if(typeof value!=='string')throw Error('Apex features must be a comma-separated string');
 if(value==='all')return FEATURE_FEATURES;
 const names=value.split(',');
 if(names.some(name=>!FEATURE_FEATURES.includes(name))||new Set(names).size!==names.length)throw Error('Unknown or duplicate Apex feature; use '+FEATURE_FEATURES.join(','));
 return Object.freeze(names);
}
