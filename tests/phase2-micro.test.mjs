import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import test from 'node:test';
import {PI_VERSION} from '../lib/launcher.mjs';

const gateUrl = new URL('../scripts/micro-phase2.mjs', import.meta.url);
const load = () => import(gateUrl).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

test('Phase 2 gate import leaves SDK, extension factories and fixture allocation inert', async () => {
  const module = await load();
  assert.equal(typeof module.runPhase2Micro, 'function', 'offline Phase 2 gate is missing');
  // Bun skips onResolve for some bare package specifiers, so the trap refuses SDK/extension module loads; the first
  // matching onLoad wins, so it is registered before live-builtins, which then makes the gate's named fs imports see
  // the mkdtemp traps.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import fs from 'node:fs'; import fsPromises from 'node:fs/promises';
     Bun.plugin({name: 'deny-sdk', setup(build) {
       build.onLoad({filter: /[\\\\/](?:@earendil-works|extensions)[\\\\/]/}, () => {throw Error('SDK import during inert load');});
     }});
     await import(${JSON.stringify(new URL('../scripts/live-builtins.mjs', import.meta.url).href)});
     if (globalThis.__apexLiveBuiltins !== true) throw Error('live builtins not loaded');
     fs.mkdtempSync = fsPromises.mkdtemp = () => {throw Error('fixture allocated during inert load');};
     await import(${JSON.stringify(gateUrl.href)}); console.log('inert');`],
  {encoding: 'utf8', timeout: 3000, env: {PATH: process.env.PATH ?? ''}});
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'inert');
});

test('native Phase 2 gate proves supported opt-in state and reports Unix-only process proof honestly', {timeout: 330000}, async t => {
  const {runPhase2Micro} = await load();
  assert.equal(typeof runPhase2Micro, 'function', 'offline Phase 2 gate is missing');
  const result = await runPhase2Micro();
  assert.equal(result.kind, 'offline_phase2_contract');
  assert.equal(result.status, process.platform === 'win32' ? 'FAIL' : 'PASS', JSON.stringify(result));
  if (process.platform === 'win32') {
    assert.equal(result.failure, 'native_background_requires_unix', JSON.stringify(result));
    assert.equal(result.background.status, 'SKIP');
    assert.ok(result.background.reason);
    assert.equal(result.checks.native_bg_survives_agent_exit, false);
    assert.equal(result.checks.native_bg_owned_cleanup, false);
    t.diagnostic('Supported native checks exercised; owned-process survival/cleanup unexercised on Windows.');
  }
  assert.equal(result.pi_version, PI_VERSION);
  assert.equal(result.model, 'openrouter/meta/muse-spark-1.3-contributor');
  assert.equal(result.thinking_level, 'xhigh');
  assert.equal(result.model_performance_measured, false);
  assert.equal(result.provider_calls, 0);
  assert.equal(result.benchmark_runs, 0);
  assert.deepEqual(result.attempted_calls, {network: 0, auth: 0, inference: 0, credentials: 0});
  assert.equal(result.resource_discovery_attempts, 0);
  for (const check of ['default_features_off', 'native_registration', 'effective_model', 'offline_settings',
    'native_tools_executed', 'auxiliary_denied_before_auth', 'native_gate_two_continuations',
    'native_verification_after_mutation', 'native_todo_drop_reason', 'native_todo_steer_once',
    'native_loop_notes_bounded', 'native_time_notes_bounded', 'native_profile_preserves_context',
    'native_branch_restoration', 'native_nested_tool_ordering', 'native_initial_context_persisted',
    'native_phase1_boundary_composition', 'environment_sanitized', 'no_ambient_discovery', 'no_extension_errors']) {
    assert.equal(result.checks[check], true, check);
  }
  assert.equal(result.gate.forced_continuations, 2);
  assert.equal(result.gate.initial_context_can_continue, false);
  assert.equal(result.gate.after_cap_continue, false);
  assert.equal(result.gate.after_verified_continue, false);
  assert.equal(result.notes.todo_steers, 1);
  assert.equal(result.notes.loop_notes, 2);
  assert.deepEqual(result.notes.time_thresholds, [50, 75, 90]);
  assert.equal(result.nested.call_count, 2);
  assert.equal(result.nested.successful_check_after_write, true);
  if (process.platform !== 'win32') {
    assert.equal(result.checks.native_bg_survives_agent_exit, true);
    assert.equal(result.checks.native_bg_owned_cleanup, true);
    assert.equal(result.background.parent_exited, true);
    assert.equal(result.background.survived_parent_exit, true);
    assert.equal(result.background.owned_kill_succeeded, true);
    assert.equal(result.background.external_network_used, false);
  }
  assert.equal(result.cleanup.owned_processes_removed, true);
  assert.equal(result.cleanup.fixture_removed, true);
  assert.equal(existsSync(result.fixture), false);
});

test('missing native settlement gate fails instead of inventing offline verification success', {timeout: 40000}, async () => {
  const {runPhase2Micro} = await load();
  assert.equal(typeof runPhase2Micro, 'function', 'offline Phase 2 gate is missing');
  const result = await runPhase2Micro({fixtureMode: 'missing-gate'});
  assert.equal(result.status, 'FAIL');
  assert.equal(result.checks.native_gate_two_continuations, false);
  assert.equal(result.gate.forced_continuations, 0);
  assert.equal(result.provider_calls, 0);
  assert.deepEqual(result.attempted_calls, {network: 0, auth: 0, inference: 0, credentials: 0});
  assert.equal(result.cleanup.fixture_removed, true);
});

test('Phase 2 gate denies ambient package/resource discovery outside the fixture', {timeout: 30000}, async () => {
  const {runPhase2Micro} = await load();
  assert.equal(typeof runPhase2Micro, 'function', 'offline Phase 2 gate is missing');
  const result = await runPhase2Micro({fixtureMode: 'ambient-discovery'});
  assert.equal(result.status, 'FAIL');
  assert.ok(result.resource_discovery_attempts > 0);
  assert.equal(result.provider_calls, 0);
  assert.equal(result.network_attempts, 0);
  assert.equal(result.cleanup.fixture_removed, true);
});

test('lost bg startup report recovers only fixture-owned IDs and acknowledges their cleanup', {timeout: 330000,
  skip: process.platform === 'win32' ? 'Requires Unix native owned-process start and process-group cleanup.' : false}, async () => {
  const {runPhase2Micro} = await load();
  assert.equal(typeof runPhase2Micro, 'function', 'offline Phase 2 gate is missing');
  const result = await runPhase2Micro({fixtureMode: 'lost-background-report'});
  assert.equal(result.status, 'FAIL');
  assert.equal(result.failure, 'background_report_lost');
  assert.equal(result.cleanup.recovered_owned_ids, 1);
  assert.equal(result.cleanup.owned_processes_removed, true);
  assert.equal(result.cleanup.fixture_removed, true);
  assert.deepEqual(result.attempted_calls, {network: 0, auth: 0, inference: 0, credentials: 0});
  assert.equal(existsSync(result.fixture), false);
});

test('Windows-scoped Phase 2 acceptance proves unsupported bg refusal without claiming Unix survival',
  {timeout: 45000, skip: process.platform !== 'win32' && 'Requires native Windows'}, async () => {
  const {runPhase2Micro} = await load();
  const result = await runPhase2Micro({scope: 'windows'});
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.equal(result.kind, 'offline_phase2_windows_contract');
  assert.equal(result.scope, 'windows');
  assert.equal(result.background.status, 'NOT_APPLICABLE');
  assert.equal(result.checks.windows_bg_refused_before_allocation, true);
  assert.ok(!Object.hasOwn(result.checks, 'native_bg_survives_agent_exit'));
  assert.ok(Object.values(result.checks).every(value => value === true));
  assert.deepEqual(result.attempted_calls, {network: 0, auth: 0, inference: 0, credentials: 0});
  assert.equal(result.cleanup.fixture_removed, true);
  const fault = await runPhase2Micro({scope: 'windows', fixtureMode: 'missing-gate'});
  assert.equal(fault.status, 'FAIL');
  assert.equal(fault.checks.native_gate_two_continuations, false);
});

test('Phase 2 gate rejects invalid scopes before allocation', async () => {
  const {runPhase2Micro} = await load();
  await assert.rejects(runPhase2Micro({scope: 'unknown'}), /unknown_micro_scope/);
  if (process.platform !== 'win32') await assert.rejects(runPhase2Micro({scope: 'windows'}), /requires_native_windows/);
});

test('Phase 2 gate rejects unknown fault modes before fixture allocation', async () => {
  const {runPhase2Micro} = await load();
  assert.equal(typeof runPhase2Micro, 'function', 'offline Phase 2 gate is missing');
  await assert.rejects(runPhase2Micro({fixtureMode: 'untrusted-mode'}), /unknown_fixture_mode/);
});
