import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import test from 'node:test';

const gateUrl = new URL('../scripts/micro-phase1.mjs', import.meta.url);
const load = () => import(gateUrl).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

test('Phase 1 gate exposes an inert import without SDK loading or fixture allocation', async () => {
  const module = await load();
  assert.equal(typeof module.runPhase1Micro, 'function', 'offline Phase 1 gate is missing');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import fs from 'node:fs'; import fsPromises from 'node:fs/promises';
     import {registerHooks, syncBuiltinESMExports} from 'node:module';
     registerHooks({resolve(specifier, context, nextResolve) {
       if (specifier.startsWith('@earendil-works/') || specifier.includes('/extensions/')) throw Error('SDK import during inert load');
       return nextResolve(specifier, context);
     }});
     fs.mkdtempSync = fsPromises.mkdtemp = () => {throw Error('fixture allocated during inert load');};
     syncBuiltinESMExports();
     await import(${JSON.stringify(gateUrl.href)}); console.log('inert');`],
  {encoding: 'utf8', timeout: 3000, env: {PATH: process.env.PATH ?? ''}});
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'inert');
});

test('missing native compact policy cannot pass or reach a provider', {timeout: 25000}, async () => {
  const {runPhase1Micro} = await load();
  assert.equal(typeof runPhase1Micro, 'function', 'offline Phase 1 gate is missing');
  const result = await runPhase1Micro({fixtureMode: 'missing-compact'});
  assert.equal(result.status, 'FAIL');
  assert.equal(result.compaction.entry_count, 0);
  assert.equal(result.checks.native_compaction_cancelled, false);
  assert.ok(result.attempted_calls.auth > 0);
  assert.equal(result.provider_calls, 0);
  assert.equal(result.network_attempts, 0);
  assert.equal(result.cleanup.fixture_removed, true);
});

test('native codemode gate detects corrupt shaping of programmatic JSON results', {timeout: 25000}, async () => {
  const {runPhase1Micro} = await load();
  assert.equal(typeof runPhase1Micro, 'function', 'offline Phase 1 gate is missing');
  const result = await runPhase1Micro({fixtureMode: 'shape-programmatic-results'});
  assert.equal(result.status, 'FAIL');
  assert.equal(result.checks.native_result_hook, true);
  assert.equal(result.checks.codemode_programmatic_json_intact, false);
  assert.equal(result.codemode.programmatic_tiny_output, false);
  assert.deepEqual(result.attempted_calls, {network: 0, auth: 0, inference: 0, credentials: 0});
  assert.equal(result.cleanup.fixture_removed, true);
});

test('native Phase 1 factory initializes actual wrappers, lazy loadout and cancellation offline', {timeout: 25000}, async () => {
  const {runPhase1Micro} = await load();
  assert.equal(typeof runPhase1Micro, 'function', 'offline Phase 1 gate is missing');
  const result = await runPhase1Micro();
  assert.equal(result.kind, 'offline_phase1_contract');
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.equal(result.pi_version, '0.99.2');
  assert.equal(result.model, 'openrouter/meta/muse-spark-1.3-contributor');
  assert.equal(result.thinking_level, 'xhigh');
  assert.equal(result.model_performance_measured, false);
  assert.deepEqual(result.attempted_calls, {network: 0, auth: 0, inference: 0, credentials: 0});
  assert.equal(result.resource_discovery_attempts, 0);
  for (const check of ['native_session_start', 'registered_flag', 'effective_model', 'offline_settings',
    'actual_tool_definitions', 'native_tools_executed', 'native_result_hook', 'native_lazy_loadout',
    'codemode_models_disabled', 'codemode_programmatic_json_intact', 'native_router', 'persisted_masking', 'native_compaction_cancelled',
    'environment_sanitized', 'no_ambient_discovery']) assert.equal(result.checks[check], true, check);
  assert.ok(result.synthetic_metrics.shape.returned_bytes < result.synthetic_metrics.shape.original_bytes);
  assert.ok(result.synthetic_metrics.mask.returned_bytes < result.synthetic_metrics.mask.original_bytes);
  assert.equal(result.synthetic_metrics.provider_token_savings_measured, false);
  assert.equal(result.compaction.entry_count, 0);
  assert.equal(result.cleanup.fixture_removed, true);
  assert.equal(existsSync(result.fixture), false);
});

test('Phase 1 gate denies ambient resource discovery before reading outside its fixture', {timeout: 25000}, async () => {
  const {runPhase1Micro} = await load();
  assert.equal(typeof runPhase1Micro, 'function', 'offline Phase 1 gate is missing');
  const result = await runPhase1Micro({fixtureMode: 'ambient-discovery'});
  assert.equal(result.status, 'FAIL');
  assert.ok(result.resource_discovery_attempts > 0);
  assert.equal(result.provider_calls, 0);
  assert.equal(result.cleanup.fixture_removed, true);
});
