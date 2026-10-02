export {runtimePolicy,SELECTED_MODEL} from '../apex-context/config.mjs';
export const FEATURE_FEATURES=Object.freeze(['cost','checkpoints','review','plan','remember','skills','safety','report','resume']);
export function parseFeatureFlags(value){
 if(value===undefined||value==='')return Object.freeze([]);
 if(typeof value!=='string')throw Error('Apex features must be a comma-separated string');
 if(value==='all')return FEATURE_FEATURES;
 const names=value.split(',');
 if(names.some(name=>!FEATURE_FEATURES.includes(name))||new Set(names).size!==names.length)throw Error('Unknown or duplicate Apex feature; use '+FEATURE_FEATURES.join(','));
 return Object.freeze(names);
}
