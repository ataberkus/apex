import assert from 'node:assert/strict';
import test from 'node:test';
const config=await import('../extensions/apex-core/config.mjs').catch(()=>null);

test('Phase 2 features default off and immutable explicit selection covers fourteen flags',()=>{
  assert.ok(config,'Phase 2 configuration missing');
  assert.deepEqual(config.parseCoreFlags(),[]);
  assert.equal(config.CORE_FEATURES.length,14);
  assert.deepEqual(config.parseCoreFlags('all'),config.CORE_FEATURES);
  assert.ok(Object.isFrozen(config.parseCoreFlags('snapshot,todo,verify')));
  for(const bad of ['todo,todo','all,todo','unknown','todo,',' true',true,1])assert.throws(()=>config.parseCoreFlags(bad));
});
test('time and independent-attempt arguments are bounded and unambiguous',()=>{
  assert.ok(config,'Phase 2 configuration missing');
  assert.equal(config.parseTimeBudget('300.5'),300.5);
  assert.equal(config.parseTimeBudget(undefined),undefined);
  for(const bad of ['0','-2','Infinity','1e5','3s','',true,86401])assert.throws(()=>config.parseTimeBudget(bad));
  assert.equal(config.parseAttempts(undefined),2);
  assert.equal(config.parseAttempts('5'),5);
  for(const bad of ['1','6','2.2','',true])assert.throws(()=>config.parseAttempts(bad));
  assert.equal(config.runtimePolicy().paid_runs_enabled,false);
});
