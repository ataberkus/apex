import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import test from 'node:test';

const gateUrl = new URL('../scripts/micro-phase3.mjs', import.meta.url);
const load = () => import(gateUrl).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const safeEnv = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'CODEX_PRIMARY_RUNTIME_NODE'].filter(name =>
  process.env[name] !== undefined).map(name => [name, process.env[name]]));

test('Phase 3 gate import leaves SDK, extensions and fixtures inert', async () => {
  const module = await load();
  assert.equal(typeof module.runPhase3Micro, 'function', 'offline Phase 3 gate is missing');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import fs from 'node:fs'; import promises from 'node:fs/promises';
     import {registerHooks, syncBuiltinESMExports} from 'node:module';
     registerHooks({resolve(specifier, context, nextResolve) {
       if (specifier.startsWith('@earendil-works/') || specifier.includes('/extensions/')) throw Error('SDK loaded during import');
       return nextResolve(specifier, context);
     }});
     fs.mkdtempSync = promises.mkdtemp = () => {throw Error('fixture allocated during import');};
     syncBuiltinESMExports();
     await import(${JSON.stringify(gateUrl.href)}); console.log('inert');`],
  {encoding: 'utf8', timeout: 3000, env: safeEnv});
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'inert');
});

test('native Phase 3 gate exercises commands, tools, resources and persisted state offline', {timeout: 45000}, async () => {
  const {runPhase3Micro} = await load();
  assert.equal(typeof runPhase3Micro, 'function', 'offline Phase 3 gate is missing');
  const result = await runPhase3Micro();
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.equal(result.kind, 'offline_phase3_contract');
  assert.equal(result.pi_version, '0.99.2');
  assert.equal(result.model, 'openrouter/meta/muse-spark-1.3-contributor');
  assert.equal(result.thinking_level, 'xhigh');
  assert.equal(result.provider_calls, 0);
  assert.equal(result.benchmark_runs, 0);
  assert.equal(result.model_performance_measured, false);
  assert.deepEqual(result.attempted_calls, {network: 0, auth: 0, inference: 0, credentials: 0});
  assert.equal(result.resource_discovery_attempts, 0);
  for (const check of ['default_features_off', 'native_registration', 'effective_model', 'offline_settings',
    'native_plan_read_allowed', 'native_plan_mutations_blocked', 'native_plan_nested_blocked',
    'native_plan_deferred_blocked', 'native_plan_saved_exactly', 'native_plan_loadout_restored',
    'native_plan_core_cooperation', 'native_remember_append', 'native_learnings_context',
    'native_eval_remember_absent', 'native_eval_learnings_pre_io', 'native_skills_discovery',
    'native_skill_expansion', 'native_usage_accounting', 'native_report',
    'native_checkpoint_undo', 'native_checkpoint_reopen', 'source_git_index_unchanged',
    'native_resume_custom_state', 'native_resume_recent_read', 'native_resume_pending_not_replayed',
    'native_review_guarded', 'guarded_cli_commands', 'structured_results_preserved',
    'environment_sanitized', 'no_ambient_discovery', 'no_extension_errors']) {
    assert.equal(result.checks[check], true, check);
  }
  assert.deepEqual(result.accounting.clean_native_totals, {input: 101, output: 23, cacheRead: 7, cacheWrite: 3,
    totalTokens: 134, thinking: 5, cacheWrite1h: null});
  assert.equal(result.accounting.clean_native_estimate_usd, 0.0001492);
  assert.equal(result.accounting.actual_provider_spend_measured, false);
  assert.equal(result.accounting.cost.nativeEstimateUsd, null);
  assert.equal(result.accounting.known_totals.input, 101);
  assert.deepEqual(result.cli.denied_statuses, [1, 1, 1, 1]);
  assert.equal(result.cli.report_status, 0);
  assert.equal(result.cli.sdk_initializations, 0);
  assert.equal(result.resume.unfinished_tool_replayed, false);
  assert.equal(result.cleanup.fixture_removed, true);
  assert.equal(result.cleanup.owned_processes_removed, true);
  assert.equal(existsSync(result.fixture), false);
});

test('missing native plan enforcement fails without provider calls', {timeout: 45000}, async () => {
  const {runPhase3Micro} = await load();
  assert.equal(typeof runPhase3Micro, 'function', 'offline Phase 3 gate is missing');
  const result = await runPhase3Micro({fixtureMode: 'missing-plan-gate'});
  assert.equal(result.status, 'FAIL');
  assert.equal(result.checks.native_plan_mutations_blocked, false);
  assert.deepEqual(result.attempted_calls, {network: 0, auth: 0, inference: 0, credentials: 0});
  assert.equal(result.cleanup.fixture_removed, true);
});

test('Phase 3 gate rejects ambient discovery and cleans fault fixtures', {timeout: 45000}, async () => {
  const {runPhase3Micro} = await load();
  assert.equal(typeof runPhase3Micro, 'function', 'offline Phase 3 gate is missing');
  const discovered = await runPhase3Micro({fixtureMode: 'ambient-discovery'});
  assert.equal(discovered.status, 'FAIL');
  assert.ok(discovered.resource_discovery_attempts > 0);
  assert.deepEqual(discovered.attempted_calls, {network: 0, auth: 0, inference: 0, credentials: 0});
  assert.equal(discovered.cleanup.fixture_removed, true);
  const failed = await runPhase3Micro({fixtureMode: 'interrupted-fixture'});
  assert.equal(failed.status, 'FAIL');
  assert.equal(failed.failure, 'fixture_interrupted');
  assert.equal(failed.cleanup.fixture_removed, true);
  assert.deepEqual(failed.attempted_calls, {network: 0, auth: 0, inference: 0, credentials: 0});
});

test('Windows Sol native gate composes real context tools, private storage and undo without auth or inference',
  {timeout: 90000, skip: process.platform !== 'win32' && 'Requires native Windows'}, async () => {
  const {runPhase3Micro} = await load();
  const result = await runPhase3Micro({selection: 'windows-sol'});
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.equal(result.kind, 'offline_windows_sol_contract');
  assert.equal(result.model, 'openai-codex/gpt-6.1-sol');
  for (const name of ['windows_literal_paths_crlf', 'windows_context_tools', 'windows_shape_checkpoint_composition',
    'windows_composed_undo', 'windows_sol_launcher']) assert.equal(result.checks[name], true, name);
  assert.deepEqual(result.attempted_calls, {network: 0, auth: 0, inference: 0, credentials: 0});
  assert.equal(result.model_performance_measured, false);
  assert.equal(result.cleanup.fixture_removed, true);
});

test('Phase 3 gate rejects unknown model selections before allocation', async () => {
  const {runPhase3Micro} = await load();
  await assert.rejects(runPhase3Micro({selection: 'any-provider'}), /unknown_model_selection/);
  if (process.platform !== 'win32') await assert.rejects(runPhase3Micro({selection: 'windows-sol'}), /requires_native_windows/);
});

test('Phase 3 gate rejects unknown faults before allocation', async () => {
  const {runPhase3Micro} = await load();
  assert.equal(typeof runPhase3Micro, 'function', 'offline Phase 3 gate is missing');
  await assert.rejects(runPhase3Micro({fixtureMode: 'untrusted-mode'}), /unknown_fixture_mode/);
});
