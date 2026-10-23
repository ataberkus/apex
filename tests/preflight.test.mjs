import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const moduleUrl = new URL('../scripts/preflight.mjs', import.meta.url).href;
const helperUrl = new URL('../scripts/python-runtime.mjs', import.meta.url).href;
const harborCommit = '99218a4611e3bd76e49ce3b5f977e8c8134ad3ac';
const piCommit = '71023aec1546d6d677a65669c5665c0927ce0dd0';
const baseEnv = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
const liveBuiltins = fileURLToPath(new URL('../scripts/live-builtins.mjs', import.meta.url));
const bunExecutable = path.isAbsolute(process.execPath) ? process.execPath
  : (baseEnv.PATH ?? baseEnv.Path ?? '').split(path.delimiter).map(directory => path.resolve(directory, process.platform === 'win32' ? 'bun.exe' : 'bun')).find(candidate => existsSync(candidate));

function temporaryRoot(t) {
  const root = mkdtempSync(path.join(projectRoot, '.preflight-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function runBun(source, options = {}) {
  return spawnSync(bunExecutable, ['--preload', liveBuiltins, '--input-type=module', '--eval', source], {
    cwd: projectRoot, env: baseEnv, encoding: 'utf8', timeout: 5000, maxBuffer: 32768, shell: false, ...options,
  });
}

function fixture(t, changes = {}) {
  const root = temporaryRoot(t);
  mkdirSync(path.join(root, 'evals'));
  writeFileSync(path.join(root, 'evals', 'versions.json'), JSON.stringify({
    pi: { version: '1.3.0', node_minimum: '22.19.0', source_commit: piCommit },
    harbor: { version: '0.23.0', commit: harborCommit },
    ...changes.pins,
  }));
  writeFileSync(path.join(root, 'evals', 'config.json'), JSON.stringify({
    paid_runs_enabled: false, execution_policy: 'offline-only', target_os: 'windows', container_environment: null,
    ...changes.config,
  }));
  const piDirectory = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent');
  mkdirSync(piDirectory, { recursive: true });
  writeFileSync(path.join(piDirectory, 'package.json'), JSON.stringify({ version: changes.piVersion ?? '1.3.0' }));
  return root;
}

function simulatedPreflight(root, responses = {}, env = {}) {
  return runBun(`
    import cp from 'node:child_process';
    import fs from 'node:fs';
    import path from 'node:path';
    const overrides = ${JSON.stringify(responses)};
    const calls = [];
    cp.spawnSync = (command, args, options) => {
      const kind = args.includes('-c') ? 'metadata'
        : command === 'docker' ? args.includes('info') ? 'info'
          : args.includes('compose') ? args.includes('up') ? 'composeHelp' : 'compose'
          : 'docker' : 'python';
      const configIndex = args.indexOf('--config');
      const configDirectory = configIndex < 0 ? null : args[configIndex + 1];
      calls.push({ command, args, options, configEmpty: configDirectory === null ? null : fs.readdirSync(configDirectory).length === 0 });
      if (Object.hasOwn(overrides, kind) && overrides[kind] === null) {
        return { status: null, error: { code: 'ENOENT' }, stdout: '', stderr: 'DO_NOT_PRINT_SECRET' };
      }
      const defaults = {
        python: 'Python 3.12.14',
        metadata: JSON.stringify({ python_version: '3.12.14', harbor_version: '0.23.0', harbor_commit: '${harborCommit}' }),
        docker: 'Docker version 29.1.0, build fixture', info: 'linux', compose: '2.39.1', composeHelp: 'Usage: docker compose up [OPTIONS] --wait Wait for services',
      };
      return { status: 0, stdout: overrides[kind] ?? defaults[kind], stderr: '' };
    };
    const { runPreflight } = await import(${JSON.stringify(moduleUrl)});
    const result = await runPreflight({ projectRoot: ${JSON.stringify(root)} });
    process.stdout.write(JSON.stringify({ result, calls }));
  `, { env: { ...baseEnv, ...env }, maxBuffer: 262144 });
}

function simulationResult(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('fallback Python version probes obey the caller subprocess limits and environment', t => {
  const root = temporaryRoot(t);
  const result = runBun(`
    import cp from 'node:child_process';
    let probe;
    cp.spawnSync = (command, args, options) => {
      probe = { command, args, options };
      return { status: 0, stdout: 'Python 3.12.14', stderr: '' };
    };
    const { pythonRuntime } = await import(${JSON.stringify(helperUrl)});
    pythonRuntime(${JSON.stringify(root)}, { env: { PATH: '/safe/path' }, timeout: 5000, maxBuffer: 32768, shell: false });
    process.stdout.write(JSON.stringify(probe));
  `);
  assert.equal(result.status, 0, result.stderr);
  const probe = JSON.parse(result.stdout);
  assert.deepEqual(probe.args.slice(-1), ['--version']);
  assert.deepEqual(probe.options.env, { PATH: '/safe/path' });
  assert.equal(probe.options.timeout, 5000);
  assert.equal(probe.options.maxBuffer, 32768);
  assert.equal(probe.options.shell, false);
});

test('readiness requires every required check to pass', async () => {
  const { classifyReadiness } = await import(moduleUrl);
  assert.equal(classifyReadiness([]), 'blocked');
  assert.equal(classifyReadiness([{ id: 'docker', status: 'blocked', required: true }]), 'blocked');
  assert.equal(classifyReadiness([{ id: 'docker', status: 'pass', required: true }, { id: 'note', status: 'blocked', required: false }]), 'tooling-ready');
  assert.equal(classifyReadiness([{ id: 'docker', status: 'pass', required: true }, { id: 'python', status: 'unknown', required: true }]), 'blocked');
});

test('importing preflight performs no probes or filesystem writes', t => {
  const root = temporaryRoot(t);
  const before = readdirSync(root);
  const result = runBun(`
    import cp from 'node:child_process';
    import fs from 'node:fs';
    const forbidden = () => { throw new Error('Import performed work'); };
    cp.spawnSync = forbidden;
    fs.mkdtempSync = forbidden;
    fs.writeFileSync = forbidden;
    const module = await import(${JSON.stringify(moduleUrl)});
    process.stdout.write(typeof module.runPreflight);
  `, { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'function');
  assert.deepEqual(readdirSync(root), before);
});

test('ready tooling uses only bounded local probes with no inherited credentials or remote contexts', t => {
  const root = fixture(t);
  const { result, calls } = simulationResult(simulatedPreflight(root, {}, {
    OPENROUTER_API_KEY: 'DO_NOT_PRINT_SECRET', DOCKER_HOST: 'tcp://remote.invalid:2376',
    DOCKER_CONTEXT: 'paid-remote', DOCKER_CUSTOM_HEADERS: 'Authorization=secret', HTTPS_PROXY: 'https://secret.invalid',
  }));
  assert.equal(result.readiness, 'tooling-ready');
  assert.equal(result.tooling_only, true);
  assert.equal(result.paid_execution, false);
  assert.equal(result.local_docker.daemon_os, 'linux');
  assert.equal(result.local_docker.ready, true);
  assert.ok(calls.some(call => call.args.includes('-c')), 'installed Python metadata is probed');
  const dockerCalls = calls.filter(call => call.command === 'docker');
  assert.ok(dockerCalls.some(call => call.args.includes('info')));
  assert.ok(dockerCalls.some(call => call.args.includes('compose') && call.args.includes('version')));
  for (const call of calls) {
    assert.equal(call.options.shell, false);
    assert.ok(call.options.timeout > 0 && call.options.timeout <= 5000);
    assert.ok(call.options.maxBuffer > 0 && call.options.maxBuffer <= 32768);
    assert.ok(Object.keys(call.options.env).every(key => ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'Temp', 'Tmp'].includes(key)));
  }
  for (const call of dockerCalls) {
    assert.equal(call.configEmpty, true);
    const configDirectory = call.args[call.args.indexOf('--config') + 1];
    assert.equal(path.dirname(configDirectory), root);
    const endpoint = call.args[call.args.indexOf('--host') + 1];
    assert.equal(endpoint, process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock');
    assert.ok(!call.args.some(arg => ['run', 'build', 'pull', 'create', 'start', 'login'].includes(arg)));
    if (call.args.includes('up')) assert.ok(call.args.includes('--help'));
  }
  assert.ok(!JSON.stringify(result).includes('DO_NOT_PRINT_SECRET'));
  assert.ok(!readdirSync(root).some(name => name.startsWith('.apex-preflight-')));
});

test('a same-version Harbor wheel without the pinned VCS commit blocks readiness', t => {
  const root = fixture(t);
  const { result } = simulationResult(simulatedPreflight(root, {
    metadata: JSON.stringify({ python_version: '3.12.14', harbor_version: '0.23.0', harbor_commit: null }),
  }));
  assert.equal(result.readiness, 'blocked');
  assert.equal(result.checks.find(check => check.id === 'harbor-pin').status, 'blocked');
});

test('prerelease or suffixed package versions cannot satisfy exact Pi and Harbor pins', t => {
  for (const suffix of ['-beta.1', '+local']) {
    const piRoot = fixture(t, { piVersion: `1.3.0${suffix}` });
    const pi = simulationResult(simulatedPreflight(piRoot)).result;
    assert.equal(pi.readiness, 'blocked');
    assert.equal(pi.checks.find(check => check.id === 'pi-pin').status, 'blocked');
    const harborRoot = fixture(t);
    const harbor = simulationResult(simulatedPreflight(harborRoot, {
      metadata: JSON.stringify({ python_version: '3.12.14', harbor_version: `0.23.0${suffix}`, harbor_commit: harborCommit }),
    })).result;
    assert.equal(harbor.readiness, 'blocked');
    assert.equal(harbor.checks.find(check => check.id === 'harbor-pin').status, 'blocked');
  }
});

test('old Python, changed Pi, or changed configured pins cannot report tooling ready', t => {
  for (const changes of [
    { piVersion: '0.99.2' },
    { pins: { pi: { version: '1.3.0', node_minimum: '22.19.0', source_commit: '0'.repeat(40) } } },
    { pins: { harbor: { version: '0.23.0', commit: '0'.repeat(40) } } },
    { config: { paid_runs_enabled: true } },
    { config: { execution_policy: 'allow-network' } },
  ]) {
    const root = fixture(t, changes);
    const { result } = simulationResult(simulatedPreflight(root));
    assert.equal(result.readiness, 'blocked');
    assert.equal(result.paid_execution, false);
  }
  const root = fixture(t);
  const { result } = simulationResult(simulatedPreflight(root, {
    metadata: JSON.stringify({ python_version: '3.11.14', harbor_version: '0.23.0', harbor_commit: harborCommit }),
  }));
  assert.equal(result.readiness, 'blocked');
  assert.equal(result.checks.find(check => check.id === 'python').status, 'blocked');
});

test('missing Docker, Windows daemon, or missing Compose wait support blocks local readiness', t => {
  for (const responses of [{ docker: null }, { info: 'windows' }, { compose: null }, { composeHelp: 'Usage: docker compose up [OPTIONS]' }]) {
    const root = fixture(t);
    const { result } = simulationResult(simulatedPreflight(root, responses));
    assert.equal(result.readiness, 'blocked');
    assert.equal(result.local_docker.ready, false);
    assert.ok(!JSON.stringify(result).includes('DO_NOT_PRINT_SECRET'));
  }
});

test('CLI reports blocked as JSON with exit 2 without printing command errors or environment secrets', t => {
  const root = fixture(t);
  const result = spawnSync(bunExecutable, [fileURLToPath(new URL(moduleUrl)), '--json'], {
    cwd: root, env: { ...baseEnv, PATH: '', Path: '', APEX_PYTHON: 'DO_NOT_PRINT_SECRET', OPENROUTER_API_KEY: 'DO_NOT_PRINT_SECRET', DOCKER_HOST: 'tcp://secret.invalid:2376' },
    encoding: 'utf8', timeout: 5000, maxBuffer: 32768, shell: false,
  });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, '');
  assert.ok(!result.stdout.includes('DO_NOT_PRINT_SECRET'));
  assert.ok(!result.stdout.includes('secret.invalid'));
  const report = JSON.parse(result.stdout);
  assert.equal(report.readiness, 'blocked');
  assert.equal(report.paid_execution, false);
  assert.equal(report.local_docker.ready, false);
});
