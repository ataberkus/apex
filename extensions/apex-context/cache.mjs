import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const count=value=>Number.isSafeInteger(value)&&value>=0;

export function createCacheLedger() {
  let prefixHash, prefixChanges=0, requests=0;
  const usage={uncached_input:0,cache_read:0,cache_write:0,output:0};
  return {
    observePrefix(prefix) {
      const next=hash(prefix);
      if (prefixHash!==undefined && next!==prefixHash) prefixChanges++;
      prefixHash=next;
    },
    observeMessage(message) {
      if (message.role!=='assistant' || !message.usage) return;
      requests++;
      for (const [output,input] of [['uncached_input','input'],['cache_read','cacheRead'],['cache_write','cacheWrite'],['output','output']]) {
        usage[output]=usage[output]===null||!count(message.usage[input])?null:usage[output]+message.usage[input];
      }
    },
    snapshot() {
      const input=[usage.uncached_input,usage.cache_read,usage.cache_write];
      const total=input.every(count)?input.reduce((a,b)=>a+b,0):null;
      return {kind:'apex-cache-observation',prefix_hash:prefixHash??null,prefix_changes:prefixChanges,
        assistant_usage_records:requests,usage:{...usage},cache_hit_fraction:total?usage.cache_read/total:null,
        scope:'Apex stable components; actual provider prefix/cache behavior unmeasured'};
    },
  };
}

export function capRoutinePayload(payload,{routine=false,cap=4096}={}) {
  if (!routine || !Number.isSafeInteger(cap) || cap<=0 || !payload || Array.isArray(payload) ||
      payload.model!=='meta/muse-spark-1.3-contributor' || payload.reasoning?.effort!=='xhigh' ||
      ['models','route','fallback','fallbacks'].some(key=>Object.hasOwn(payload,key))) return payload;
  const fields=['max_tokens','max_completion_tokens'].filter(key=>Object.hasOwn(payload,key));
  if (fields.length!==1 || !Number.isSafeInteger(payload[fields[0]]) || payload[fields[0]]<=0) return payload;
  if (payload[fields[0]]<=cap) return payload;
  return {...payload,[fields[0]]:cap};
}
