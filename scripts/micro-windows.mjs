import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runWindowsPreflight, windowsProbeEnvironment} from './preflight-windows.mjs';
import {fixtureEnvironment, WINDOWS_FIXTURE_ENV} from './micro-session.mjs';
import {WINDOWS_DEFERRED, WINDOWS_MODEL, WINDOWS_THINKING} from '../lib/windows-target.mjs';

const GATES = Object.freeze([
  {name: 'tools', file: 'micro-tools.mjs', kind: 'offline_tool_contract', timeout: 30000},
  {name: 'session', file: 'micro-session.mjs', kind: 'offline_session_contract', timeout: 30000},
  {name: 'context', file: 'micro-phase1.mjs', kind: 'offline_phase1_contract', timeout: 30000},
  {name: 'core', file: 'micro-phase2.mjs', args: ['--windows'], kind: 'offline_phase2_windows_contract', timeout: 330000},
  {name: 'features', file: 'micro-phase3.mjs', kind: 'offline_phase3_contract', timeout: 330000},
  {name: 'default', file: 'micro-phase3.mjs', args: ['--windows-default'], kind: 'offline_windows_default_contract', timeout: 330000},
]);

export function windowsContractPassed(name, result) {
  const kind = GATES.find(gate => gate.name === name)?.kind;
  if (!kind || result?.kind !== kind || result.provider_calls !== 0) return false;
  if (name === 'tools') return result.results?.length >= 8 && result.results.every(row => row.passed === true);
  return result.status === 'PASS' && !result.failure && result.model_performance_measured === false &&
    result.resource_discovery_attempts === 0 && result.attempted_calls &&
    ['network', 'auth', 'inference', 'credentials'].every(key => result.attempted_calls[key] === 0) &&
    Object.keys(result.checks ?? {}).length > 0 && Object.values(result.checks).every(value => value === true) &&
    result.cleanup?.fixture_removed === true &&
    (name !== 'default' || (result.model === WINDOWS_MODEL && result.thinking_level === WINDOWS_THINKING &&
      ['windows_literal_paths_crlf', 'windows_context_tools', 'windows_shape_checkpoint_composition', 'windows_composed_undo', 'windows_default_launcher']
        .every(key => result.checks[key] === true))) &&
    (name !== 'core' || (result.scope === 'windows' && result.checks.windows_bg_refused_before_allocation === true &&
      result.background?.status === 'NOT_APPLICABLE' && result.cleanup.owned_processes_removed === true));
}

/** Separate acceptance scope. It never rewrites the full offline-micro artifact. */
export function runWindowsMicro({projectRoot = process.cwd(), run = spawnSync,
  platform = process.platform, sourceEnv = process.env} = {}) {
  const root = path.resolve(projectRoot);
  const artifact = {schema_version: 1, kind: 'windows_native_micro', target: 'windows', status: 'BLOCKED',
    provider_calls: 0, benchmark_runs: 0, model_performance_measured: false, contracts: {},
    deferred: [...WINDOWS_DEFERRED], complete_project_acceptance: false};
  artifact.preflight = runWindowsPreflight({projectRoot: root, platform, sourceEnv, run});
  if (artifact.preflight.readiness !== 'tooling-ready') return artifact;
  const fixture = mkdtempSync(path.join(root, '.windows-micro-home-'));
  const names = ['PATH', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'PI_OFFLINE', 'PI_CODING_AGENT_DIR', ...WINDOWS_FIXTURE_ENV];
  const env = fixtureEnvironment(names, fixture, windowsProbeEnvironment(root, sourceEnv), 'win32');
  Object.assign(env, {PI_OFFLINE: '1', PI_CODING_AGENT_DIR: fixture});
  artifact.status = 'PASS';
  try {
    for (const gate of GATES) {
      let result;
      try {
        const child = run(process.execPath, [path.join(root, 'scripts', gate.file), ...(gate.args ?? [])],
          {cwd: root, env, encoding: 'utf8', shell: false, windowsHide: true, timeout: gate.timeout, maxBuffer: 1048576});
        const report = JSON.parse(child.stdout);
        const passed = !child.error && child.status === 0 && windowsContractPassed(gate.name, report);
        result = {status: passed ? 'PASS' : 'FAIL', exit_code: child.status, report};
      } catch {result = {status: 'FAIL', reason: 'missing-or-invalid-native-evidence'};}
      const calls = result.report?.provider_calls;
      if (!Number.isSafeInteger(calls) || calls < 0) artifact.provider_calls = null;
      else if (artifact.provider_calls !== null) artifact.provider_calls += calls;
      artifact.contracts[gate.name] = result;
      if (result.status !== 'PASS') artifact.status = 'FAIL';
    }
  } finally {
    try {rmSync(fixture, {recursive: true, force: true}); artifact.fixture_removed = true;}
    catch {artifact.fixture_removed = false; artifact.status = 'FAIL';}
  }
  return artifact;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    process.stdout.write(`${JSON.stringify({status: 'BLOCKED', reason: 'unsupported-arguments'})}\n`);
    process.exitCode = 2;
  } else {
    const report = runWindowsMicro();
    mkdirSync('validation', {recursive: true});
    writeFileSync('validation/windows-native-micro.json', `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.status === 'PASS' ? 0 : report.status === 'BLOCKED' ? 2 : 1;
  }
}
