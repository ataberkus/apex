import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/micro-session.mjs', import.meta.url));
const load = () => import('../scripts/micro-session.mjs').catch(() => ({}));

test('session gate exposes an inert import instead of running or allocating a fixture', async () => {
  const module = await load();
  assert.equal(typeof module.runSessionMicro, 'function', 'offline session gate is missing');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(new URL('../scripts/micro-session.mjs', import.meta.url).href)}); console.log('inert');`],
    {encoding: 'utf8', timeout: 3000, env: {PATH: process.env.PATH ?? ''}});
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'inert');
});

test('offline child environments preserve Windows name semantics without admitting credentials', async () => {
  const {whitelistedEnvironment, environmentNamesAllowed} = await load();
  const allowed = ['PATH', 'SystemRoot', 'PI_OFFLINE'];
  const source = {Path: 'C:\\local\\bin', SYSTEMROOT: 'C:\\Windows', PI_OFFLINE: '1', OPENROUTER_API_KEY: 'denied'};
  const env = whitelistedEnvironment(allowed, source, 'win32');
  assert.deepEqual(env, {PATH: 'C:\\local\\bin', SystemRoot: 'C:\\Windows', PI_OFFLINE: '1'});
  assert.equal(environmentNamesAllowed(allowed, {...env, SYSTEMROOT: env.SystemRoot}, 'win32'), true);
  assert.equal(environmentNamesAllowed(allowed, source, 'win32'), false);
  assert.equal(environmentNamesAllowed(allowed, {PATH: '/bin', SystemRoot: '/root', PI_OFFLINE: '1'}, 'linux'), true);
  assert.equal(environmentNamesAllowed(allowed, {Path: '/bin'}, 'linux'), false);
  assert.deepEqual(whitelistedEnvironment(allowed, source, 'linux'), {PI_OFFLINE: '1'});
});

test('Windows fixture profiles cannot inherit or substitute the user credential home', async () => {
  const {fixtureEnvironment, environmentNamesAllowed, WINDOWS_FIXTURE_ENV} = await load();
  const allowed = ['PATH', 'SystemRoot', ...WINDOWS_FIXTURE_ENV];
  const fixture = 'C:\\isolated\\fixture';
  const source = {Path:'C:\\tools', SYSTEMROOT:'C:\\Windows', USERPROFILE:'C:\\private',
    USERNAME:'private-user', OPENROUTER_API_KEY:'denied'};
  const env = fixtureEnvironment(allowed, fixture, source, 'win32');
  assert.equal(environmentNamesAllowed(allowed, env, 'win32', fixture), true);
  assert.equal(environmentNamesAllowed(allowed, {...env, USERPROFILE:source.USERPROFILE}, 'win32', fixture), false);
  assert.equal(environmentNamesAllowed(allowed, {...env, USERNAME:source.USERNAME}, 'win32', fixture), false);
  assert.equal(environmentNamesAllowed(allowed, {...env, OPENROUTER_API_KEY:source.OPENROUTER_API_KEY}, 'win32', fixture), false);
});

test('native offline compaction preserves recent context and branch state through fresh-process torn-tail recovery', {timeout: 20000}, async () => {
  const {runSessionMicro} = await load();
  assert.equal(typeof runSessionMicro, 'function', 'offline session gate is missing');
  const result = await runSessionMicro();
  assert.equal(result.kind, 'offline_session_contract');
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.equal(result.model, 'openrouter/meta/muse-spark-1.3-contributor');
  assert.equal(result.thinking_level, 'xhigh');
  assert.equal(result.model_performance_measured, false);
  assert.deepEqual(result.attempted_calls, {network: 0, auth: 0, inference: 0, credentials: 0});
  assert.deepEqual(result.compaction.read_files, ['read-only.txt']);
  assert.deepEqual(result.compaction.modified_files, ['changed.txt', 'new.txt']);
  for (const check of ['native_compaction', 'recent_context_preserved', 'summary_contract_preserved',
    'branch_state_preserved', 'builtin_file_results_verified', 'fresh_process_reopen', 'fresh_sdk_restore',
    'no_ambient_discovery',
    'partial_tail_recovery', 'append_after_recovery', 'environment_sanitized']) {
    assert.equal(result.checks[check], true, check);
  }
  assert.equal(result.cleanup.fixture_removed, true);
  assert.equal(existsSync(result.fixture), false);
  assert.equal(result.recovery.malformed_fragment_retained, true);
  assert.equal(result.recovery.malformed_fragment_reconstructed, false);
  assert.equal(result.recovery.power_loss_durability_tested, false);
});

test('a cancelled hook fails the gate without appending compaction or attempting auth/inference', {timeout: 15000}, async () => {
  const {runSessionMicro} = await load();
  assert.equal(typeof runSessionMicro, 'function', 'offline session gate is missing');
  const result = await runSessionMicro({fixtureMode: 'cancel'});
  assert.equal(result.status, 'FAIL');
  assert.equal(result.failure, 'compaction_cancelled');
  assert.equal(result.compaction.entry_count, 0);
  assert.deepEqual(result.attempted_calls, {network: 0, auth: 0, inference: 0, credentials: 0});
  assert.equal(result.cleanup.fixture_removed, true);
});

test('default resource discovery is blocked before reading user or ancestor resources', {timeout: 15000}, async () => {
  const {runSessionMicro} = await load();
  assert.equal(typeof runSessionMicro, 'function', 'offline session gate is missing');
  const result = await runSessionMicro({fixtureMode: 'ambient-discovery'});
  assert.equal(result.status, 'FAIL');
  assert.ok(result.resource_discovery_attempts > 0);
  assert.equal(result.provider_calls, 0);
  assert.equal(result.cleanup.fixture_removed, true);
});

test('a custom summary that loses the fixture contract cannot produce a passing gate', {timeout: 15000}, async () => {
  const {runSessionMicro} = await load();
  assert.equal(typeof runSessionMicro, 'function', 'offline session gate is missing');
  const result = await runSessionMicro({fixtureMode: 'omit-contract'});
  assert.equal(result.status, 'FAIL');
  assert.equal(result.checks.summary_contract_preserved, false);
  assert.deepEqual(result.attempted_calls, {network: 0, auth: 0, inference: 0, credentials: 0});
  assert.equal(result.cleanup.fixture_removed, true);
});

test('missing deterministic hook blocks default auth and inference instead of passing silently', {timeout: 15000}, async () => {
  const {runSessionMicro} = await load();
  assert.equal(typeof runSessionMicro, 'function', 'offline session gate is missing');
  const result = await runSessionMicro({fixtureMode: 'missing-hook'});
  assert.equal(result.status, 'FAIL');
  assert.ok(result.attempted_calls.auth > 0, JSON.stringify(result));
  assert.ok(result.attempted_calls.inference > 0, JSON.stringify(result));
  assert.equal(result.provider_calls, 0);
  assert.equal(result.network_attempts, 0);
  assert.equal(result.cleanup.fixture_removed, true);
});
