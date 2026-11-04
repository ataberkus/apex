import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {rmSync, readdirSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {runWindowsPreflight, windowsProbeEnvironment} from '../scripts/preflight-windows.mjs';

import {windowsFixture, nativeProbe} from './fixtures/windows.mjs';

test('native Windows readiness needs no Harbor/Python/Docker/auth and performs only bounded credential-free probes', t => {
  const {root, env} = windowsFixture(t), calls = [];
  const before = readdirSync(root);
  const report = runWindowsPreflight({projectRoot: root, platform: 'win32', sourceEnv: env,
    run(command, args, options) {calls.push({command, args, options}); return nativeProbe(command, args);}});
  assert.equal(report.readiness, 'tooling-ready');
  assert.equal(report.target, 'windows');
  assert.equal(report.auth_checked, false);
  assert.equal(report.paid_execution, false);
  assert.equal(report.provider_calls, 0);
  assert.equal(calls.length, 5);
  for (const call of calls) {
    assert.equal(call.options.shell, false);
    assert.ok(call.options.timeout > 0 && call.options.timeout <= 5000);
    assert.ok(call.options.maxBuffer > 0 && call.options.maxBuffer <= 32768);
    assert.ok(!JSON.stringify(call.options).includes('DO_NOT_PRINT_SECRET'));
    assert.ok(Object.keys(call.options.env).every(name => ['PATH','SystemRoot','WINDIR','TEMP','TMP','LANG','LC_ALL','PATHEXT'].includes(name)));
  }
  assert.deepEqual(readdirSync(root), before);
  assert.ok(!JSON.stringify(report).includes('DO_NOT_PRINT_SECRET'));
});

test('missing Windows prerequisites, workspace-only tools and wrong Pi cannot report ready', t => {
  for (const missing of ['git.exe', 'bash.exe', 'fd.exe', 'rg.exe']) {
    const {root, file, env} = windowsFixture(t);
    rmSync(path.join(root, 'bin', missing));
    file(`.tools/bin/${missing}`); // the installed launcher never searches the dev workspace
    const result = runWindowsPreflight({projectRoot: root, platform: 'win32', sourceEnv: env, run: nativeProbe});
    assert.equal(result.readiness, 'blocked', missing);
  }
  for (const found of ['0.99.2', '1.3.0', '1.4.0-beta', '1.4.0+local']) {
    const {root, file, env} = windowsFixture(t);
    file('node_modules/@earendil-works/pi-coding-agent/package.json', JSON.stringify({version: found}));
    assert.equal(runWindowsPreflight({projectRoot: root, platform: 'win32', sourceEnv: env, run: nativeProbe}).readiness, 'blocked');
  }
});

test('PowerShell policy/NET failures stay blocked without leaking stderr or bypassing execution policy', t => {
  const {root, env} = windowsFixture(t);
  for (const failed of [{status: 2, stderr: 'DO_NOT_PRINT_SECRET'}, {status: null, error: {code: 'ETIMEDOUT'}}]) {
    const result = runWindowsPreflight({projectRoot: root, platform: 'win32', sourceEnv: env,
      run(command, args) {
        assert.ok(!args.includes('Bypass'));
        return path.basename(command).toLowerCase() === 'powershell.exe' ? failed : nativeProbe(command, args);
      }});
    assert.equal(result.readiness, 'blocked');
    assert.equal(result.checks.find(row => row.id === 'windows-powershell-net').status, 'blocked');
    assert.ok(!JSON.stringify(result).includes('DO_NOT_PRINT_SECRET'));
  }
});

test('nonnative host refuses Windows readiness before any probes or temporary allocations', t => {
  const {root, env} = windowsFixture(t);
  const result = runWindowsPreflight({projectRoot: root, platform: 'linux', sourceEnv: env,
    run() {throw Error('No process should be started');}});
  assert.equal(result.readiness, 'blocked');
  assert.deepEqual(result.checks.map(row => row.id), ['native-windows']);
});

test('Windows environment canonicalizes Path without inheriting credentials or account profiles', () => {
  const env = windowsProbeEnvironment('C:\\workspace', {Path: 'native-path', SYSTEMROOT: 'C:\\Windows',
    USERPROFILE: 'private-home', OPENAI_API_KEY: 'secret', DOCKER_CONTEXT: 'remote'});
  assert.ok(env.PATH.endsWith('native-path'));
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.PATHEXT, '.COM;.EXE;.BAT;.CMD');
  assert.ok(!Object.hasOwn(env, 'Path'));
  assert.ok(!Object.hasOwn(env, 'USERPROFILE'));
  assert.ok(!JSON.stringify(env).includes('secret'));
});

test('Windows preflight CLI rejects unknown flags without any dependency probes', () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/preflight-windows.mjs', import.meta.url)), '--execute'],
    {encoding: 'utf8', shell: false, timeout: 5000});
  assert.equal(child.status, 2);
  assert.equal(child.stderr, '');
  assert.equal(JSON.parse(child.stdout).reason, 'unsupported-arguments');
});

test('Windows preflight import never starts processes, allocates files or imports the SDK', () => {
  const url = new URL('../scripts/preflight-windows.mjs', import.meta.url).href;
  const liveBuiltins = new URL('../scripts/live-builtins.mjs', import.meta.url).href;
  // Bun has no module hooks: onResolve skips bare packages and the first matching onLoad wins, so this load trap
  // precedes live-builtins, which in turn lets the module's named imports see the spawn/fs traps.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import cp from 'node:child_process';
    Bun.plugin({name: 'windows-preflight-inert-guard', setup(build) {
      build.onLoad({filter: /[\\\\/]@earendil-works[\\\\/]/}, () => {throw Error('SDK during import');});
    }});
    await import(${JSON.stringify(liveBuiltins)});
    if (!globalThis.__apexLiveBuiltins) throw Error('live builtins not installed');
    const deny = () => {throw Error('Work during import');};
    fs.mkdtempSync = fs.mkdirSync = fs.writeFileSync = cp.spawnSync = deny;
    await import(${JSON.stringify(url)}); console.log('inert');`], {encoding: 'utf8', timeout: 5000});
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'inert');
});
