import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {windowsProbeEnvironment} from '../scripts/preflight-windows.mjs';
import {fixtureEnvironment, WINDOWS_FIXTURE_ENV} from '../scripts/micro-session.mjs';
import {lockSubtree} from '../scripts/smoke-windows-package.mjs';

test('isolated Windows PowerShell really invokes native Bun and captures stdout (PATHEXT regression)',
  {skip: process.platform !== 'win32' && 'Requires native Windows PowerShell', timeout: 15000}, t => {
  const cwd = mkdtempSync(path.join(process.cwd(), 'tests/windows native shell ç-'));
  t.after(() => rmSync(cwd, {recursive: true, force: true}));
  const env = fixtureEnvironment(['PATH','SystemRoot','WINDIR', ...WINDOWS_FIXTURE_ENV], cwd,
    windowsProbeEnvironment(process.cwd()), 'win32');
  env.PATH = [path.dirname(process.execPath), env.PATH].join(path.delimiter);
  assert.equal(env.PATHEXT, '.COM;.EXE;.BAT;.CMD');
  const powershell = path.join(env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const child = spawnSync(powershell, ['-NoProfile','-NonInteractive','-Command',
    'Write-Output BEFORE; & bun.exe --version; if($LASTEXITCODE -ne 0) { exit 1 }; Write-Output AFTER'],
    {cwd, env, shell: false, encoding: 'utf8', timeout: 10000});
  assert.equal(child.status, 0, child.stderr);
  assert.ok(child.stdout.split(/\r?\n/).includes(process.versions.bun), child.stdout);
  assert.ok(child.stdout.includes('BEFORE') && child.stdout.includes('AFTER'));
});

test('package-smoke import never installs, packs, reads credentials or initializes the SDK', () => {
  const url = new URL('../scripts/smoke-windows-package.mjs', import.meta.url).href;
  const liveBuiltins = new URL('../scripts/live-builtins.mjs', import.meta.url).href;
  // Bun has no module hooks: onResolve skips bare packages and the first matching onLoad wins, so this load trap
  // precedes live-builtins, which in turn lets the module's named imports see the spawn/fs traps.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import cp from 'node:child_process';
    Bun.plugin({name:'package-smoke-inert-guard',setup(build){
      build.onLoad({filter:/[\\\\/]@earendil-works[\\\\/]/},()=>{throw Error('SDK loaded during import');});
    }});
    await import(${JSON.stringify(liveBuiltins)});
    if(!globalThis.__apexLiveBuiltins)throw Error('live builtins not installed');
    const deny=()=>{throw Error('work during import');};
    fs.mkdtempSync=fs.mkdirSync=fs.writeFileSync=cp.spawnSync=deny;
    await import(${JSON.stringify(url)}); console.log('inert');`], {encoding: 'utf8', timeout: 5000});
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'inert');
});

test('offline bootstrap bun.lock keeps nearest nested runtime dependencies and drops dev-only packages', () => {
  const entry = (id, info = {}) => [id, '', info, `sha512-${id}`];
  const packages = {
    peer: entry('peer@1.0.0', {dependencies: {shared: '^2', '@scope/tool': '1'},
      optionalDependencies: {absent: '1', opt: '1'}, peerDependencies: {runtime: '*', ghost: '*'}, optionalPeers: ['ghost']}),
    'peer/shared': entry('shared@2.0.0', {dependencies: {leaf: '2'}}),
    'peer/leaf': entry('leaf@2.0.0'),
    opt: entry('opt@1.0.0'),
    '@scope/tool': entry('@scope/tool@1.0.0', {dependencies: {'@scope/inner': '1'}}),
    '@scope/tool/@scope/inner': entry('@scope/inner@1.0.0', {dependencies: {leaf: '3'}}),
    '@scope/tool/leaf': entry('leaf@3.0.0'),
    '@scope/inner': entry('@scope/inner@9.0.0'),
    shared: entry('shared@1.0.0', {dependencies: {leaf: '1'}}),
    leaf: entry('leaf@1.0.0'),
    runtime: entry('runtime@1.0.0', {dependencies: {shared: '^1'}}),
    devonly: entry('devonly@1.0.0', {dependencies: {leaf: '1'}}),
    'devonly/leaf': entry('leaf@4.0.0'),
  };
  assert.deepEqual([...lockSubtree(packages, ['peer', 'runtime'])].sort(), ['@scope/tool', '@scope/tool/@scope/inner',
    '@scope/tool/leaf', 'leaf', 'opt', 'peer', 'peer/leaf', 'peer/shared', 'runtime', 'shared']);
  assert.throws(() => lockSubtree({peer: entry('peer@1.0.0', {dependencies: {nested: '1'}}),
    'peer/nested': entry('nested@1.0.0', {dependencies: {gone: '1'}})}, ['peer']), /missing gone required by peer\/nested/);
  assert.throws(() => lockSubtree({}, ['peer']), /missing peer required by root/);
});
