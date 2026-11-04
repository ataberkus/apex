import assert from 'node:assert/strict';
import test from 'node:test';

const config = await import('../extensions/apex-context/config.mjs').catch(() => null);
test('Phase 1 flag selection defaults off and is immutable', () => {
  assert.ok(config, 'Phase 1 configuration module missing');
  assert.deepEqual(config.parseContextFlags(undefined), []);
  const flags = config.parseContextFlags('shape,mask,read');
  assert.deepEqual(flags, ['shape','mask','read']);
  assert.ok(Object.isFrozen(flags));
});
test('all is explicit and unknown or ambiguous flags fail', () => {
  assert.ok(config, 'Phase 1 configuration module missing');
  assert.deepEqual(config.parseContextFlags('all'), config.CONTEXT_FEATURES);
  for (const input of ['shape,shape', 'all,read', 'unknown', 'shape,,read', ',read', 'false']) {
    assert.throws(() => config.parseContextFlags(input), /context|feature/i);
  }
  assert.throws(() => config.parseContextFlags(true), /context|feature/i);
});
test('current runtime policy remains offline, exact-model and xhigh', () => {
  assert.ok(config, 'Phase 1 configuration module missing');
  assert.deepEqual(config.runtimePolicy(), {allowed_model:'openrouter/meta/muse-spark-1.3-contributor',
    thinking_level:'xhigh',paid_runs_enabled:false,execution_policy:'offline-only'});
});
