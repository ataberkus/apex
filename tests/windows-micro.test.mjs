import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {readdirSync} from 'node:fs';
import {runWindowsMicro, windowsContractPassed} from '../scripts/micro-windows.mjs';
import {windowsFixture, nativeProbe} from './fixtures/windows.mjs';

function reportFor(name) {
  const kinds = {tools: 'offline_tool_contract', session: 'offline_session_contract', context: 'offline_phase1_contract',
    core: 'offline_phase2_windows_contract', features: 'offline_phase3_contract', sol: 'offline_windows_sol_contract'};
  return {kind: kinds[name], status: 'PASS', provider_calls: 0, model_performance_measured: false,
    results: Array.from({length: 8}, () => ({passed: true})), checks: {fixture_check: true},
    attempted_calls: {network: 0, auth: 0, inference: 0, credentials: 0}, resource_discovery_attempts: 0,
    cleanup: {fixture_removed: true, owned_processes_removed: true},
    ...(name === 'core' ? {scope: 'windows', checks: {windows_bg_refused_before_allocation: true}, background: {status: 'NOT_APPLICABLE'}} : {}),
    ...(name === 'sol' ? {model: 'openai-codex/gpt-6.1-sol', thinking_level: 'xhigh', checks: {windows_literal_paths_crlf: true, windows_context_tools: true,
      windows_shape_checkpoint_composition: true, windows_composed_undo: true, windows_sol_launcher: true}} : {})};
}
const names = ['tools', 'session', 'context', 'core', 'features', 'sol'];
const identify = args => {
  const file = path.basename(args[0]);
  return {'micro-tools.mjs': 'tools', 'micro-session.mjs': 'session', 'micro-phase1.mjs': 'context',
    'micro-phase2.mjs': 'core', 'micro-phase3.mjs': args.includes('--windows-sol') ? 'sol' : 'features'}[file];
};

test('Windows acceptance requires native evidence, not skips, nonzero access, empty checks or the old full-scope artifact', () => {
  for (const name of names) assert.equal(windowsContractPassed(name, reportFor(name)), true, name);
  for (const changes of [{status: 'SKIP'}, {checks: {}}, {checks: {one: false}}, {cleanup: {fixture_removed: false}},
    {attempted_calls: {network: 0, auth: 1, inference: 0, credentials: 0}}, {resource_discovery_attempts: 1},
    {provider_calls: 1}, {model_performance_measured: true}, {failure: 'native-failed'}]) {
    assert.equal(windowsContractPassed('session', {...reportFor('session'), ...changes}), false, JSON.stringify(changes));
  }
  assert.equal(windowsContractPassed('tools', {...reportFor('tools'), results: [{passed: true}]}), false);
  assert.equal(windowsContractPassed('core', {...reportFor('core'), kind: 'offline_phase2_contract'}), false);
  assert.equal(windowsContractPassed('core', {...reportFor('core'), checks: {another: true}}), false);
  assert.equal(windowsContractPassed('sol', {...reportFor('sol'), model: 'openrouter/meta/muse-spark-1.3-contributor'}), false);
  assert.equal(windowsContractPassed('sol', {...reportFor('sol'), checks: {one: true}}), false);
  assert.equal(windowsContractPassed('unknown', reportFor('session')), false);
});

test('Windows orchestration keeps every native gate, scrubs profiles and never invokes Python/Docker', t => {
  const {root, env} = windowsFixture(t), calls = [];
  const result = runWindowsMicro({projectRoot: root, platform: 'win32', sourceEnv: env,
    run(command, args, options) {
      const name = identify(args);
      if (!name) return nativeProbe(command, args);
      calls.push({name, args, options});
      assert.equal(options.shell, false);
      assert.ok(!JSON.stringify(options.env).includes('DO_NOT_PRINT_SECRET'));
      assert.equal(options.env.PI_OFFLINE, '1');
      assert.equal(options.env.PI_CODING_AGENT_DIR, options.env.USERPROFILE);
      return {status: 0, stdout: JSON.stringify(reportFor(name))};
    }});
  assert.equal(result.status, 'PASS');
  assert.equal(result.complete_project_acceptance, false);
  assert.equal(result.model_performance_measured, false);
  assert.equal(result.fixture_removed, true);
  assert.deepEqual(calls.map(call => call.name), names);
  assert.ok(calls.find(call => call.name === 'core').args.includes('--windows'));
  assert.ok(!readdirSync(root).some(name => name.startsWith('.windows-micro-home-')));
});

test('a real gate failure is not reclassified as out of scope and later Windows evidence is still collected', t => {
  const {root, env} = windowsFixture(t);
  for (const invalid of [{status: 1, stdout: JSON.stringify(reportFor('core'))},
    {status: 0, stdout: 'broken-json'}, {status: null, error: {code: 'ETIMEDOUT'}, stdout: ''}]) {
    const result = runWindowsMicro({projectRoot: root, platform: 'win32', sourceEnv: env,
      run(command, args) {
        const name = identify(args);
        if (!name) return nativeProbe(command, args);
        return name === 'core' ? invalid : {status: 0, stdout: JSON.stringify(reportFor(name))};
      }});
    assert.equal(result.status, 'FAIL');
    assert.equal(result.contracts.core.status, 'FAIL');
    assert.equal(result.contracts.features.status, 'PASS');
    assert.equal(result.provider_calls, invalid.status === 1 ? 0 : null);
    assert.equal(result.fixture_removed, true);
  }
});

test('missing native prerequisites stop Windows gates before allocating a fixture', t => {
  const {root, env} = windowsFixture(t);
  const before = readdirSync(root);
  const report = runWindowsMicro({projectRoot: root, platform: 'linux', sourceEnv: env,
    run() {throw new Error('No probes permitted');}});
  assert.equal(report.status, 'BLOCKED');
  assert.deepEqual(report.contracts, {});
  assert.deepEqual(readdirSync(root), before);
});
