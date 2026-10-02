import assert from 'node:assert/strict';
import test from 'node:test';

const cache = await import('../extensions/apex-context/cache.mjs').catch(() => null);
test('cache ledger tracks stable prefix hashes without storing prompt values', () => {
  assert.ok(cache, 'Phase 1 cache module missing');
  const ledger=cache.createCacheLedger();
  const prefix={sections:{apex_efficiency:'PRIVATE_PROMPT_SENTINEL'},tools:[{name:'read',parameters:{type:'object'}}],thinkingLevel:'xhigh'};
  ledger.observePrefix(prefix); ledger.observePrefix(structuredClone(prefix));
  assert.equal(ledger.snapshot().prefix_changes,0);
  ledger.observePrefix({...prefix,tools:[{name:'write'}]});
  assert.equal(ledger.snapshot().prefix_changes,1);
  assert.equal(JSON.stringify(ledger.snapshot()).includes('PRIVATE_PROMPT_SENTINEL'),false);
});
test('cache ledger accounts native uncached/cache-read/cache-write without double counting', () => {
  assert.ok(cache, 'Phase 1 cache module missing');
  const ledger=cache.createCacheLedger();
  ledger.observeMessage({role:'assistant',usage:{input:100,cacheRead:800,cacheWrite:100,output:30}});
  ledger.observeMessage({role:'toolResult',usage:{input:999,cacheRead:999,output:999}});
  assert.deepEqual(ledger.snapshot().usage,{uncached_input:100,cache_read:800,cache_write:100,output:30});
  assert.equal(ledger.snapshot().cache_hit_fraction,0.8);
  ledger.observeMessage({role:'assistant',usage:{input:20,output:10}});
  assert.equal(ledger.snapshot().cache_hit_fraction,null);
  assert.equal(ledger.snapshot().usage.cache_read,null);
});
test('routine cap only lowers the exact Muse existing cap and preserves xhigh', () => {
  assert.ok(cache, 'Phase 1 cache module missing');
  const payload={model:'meta/muse-spark-1.3-contributor',reasoning:{effort:'xhigh'},max_completion_tokens:12000,messages:[{role:'user',content:'task'}]};
  const result=cache.capRoutinePayload(payload,{routine:true,cap:4096});
  assert.equal(result.max_completion_tokens,4096);
  assert.deepEqual(result.reasoning,{effort:'xhigh'});
  assert.equal(payload.max_completion_tokens,12000);
  assert.equal(cache.capRoutinePayload(payload,{routine:false}),payload);
  for (const input of [{...payload,model:'other'},{...payload,reasoning:{effort:'low'}},
    {...payload,max_tokens:1000},{...payload,models:['other']},{model:payload.model,reasoning:payload.reasoning}]) {
    assert.equal(cache.capRoutinePayload(input,{routine:true}),input);
  }
  assert.equal(cache.capRoutinePayload({...payload,max_completion_tokens:100},{routine:true}).max_completion_tokens,100);
});
