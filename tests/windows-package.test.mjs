import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {windowsProbeEnvironment} from '../scripts/preflight-windows.mjs';
import {fixtureEnvironment, WINDOWS_FIXTURE_ENV} from '../scripts/micro-session.mjs';
import {lockSubtree} from '../scripts/smoke-windows-package.mjs';

test('isolated Windows PowerShell really invokes native Node and captures stdout (PATHEXT regression)',
  {skip: process.platform !== 'win32' && 'Requires native Windows PowerShell', timeout: 15000}, t => {
  const cwd = mkdtempSync(path.join(process.cwd(), 'tests/windows native shell ç-'));
  t.after(() => rmSync(cwd, {recursive: true, force: true}));
  const env = fixtureEnvironment(['PATH','SystemRoot','WINDIR', ...WINDOWS_FIXTURE_ENV], cwd,
    windowsProbeEnvironment(process.cwd()), 'win32');
  env.PATH = [path.dirname(process.execPath), env.PATH].join(path.delimiter);
  assert.equal(env.PATHEXT, '.COM;.EXE;.BAT;.CMD');
  const powershell = path.join(env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const child = spawnSync(powershell, ['-NoProfile','-NonInteractive','-Command',
    'Write-Output BEFORE; & node.exe --version; if($LASTEXITCODE -ne 0) { exit 1 }; Write-Output AFTER'],
    {cwd, env, shell: false, encoding: 'utf8', timeout: 10000});
  assert.equal(child.status, 0, child.stderr);
  assert.ok(child.stdout.includes(`v${process.versions.node}`), child.stdout);
  assert.ok(child.stdout.includes('BEFORE') && child.stdout.includes('AFTER'));
});

test('package-smoke import never installs, packs, reads credentials or initializes the SDK', () => {
  const url = new URL('../scripts/smoke-windows-package.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import cp from 'node:child_process';
    import {registerHooks,syncBuiltinESMExports} from 'node:module';
    const deny=()=>{throw Error('work during import');};
    fs.mkdtempSync=fs.mkdirSync=fs.writeFileSync=cp.spawnSync=deny; syncBuiltinESMExports();
    registerHooks({resolve(specifier,context,next){
      if(specifier.startsWith('@earendil-works/'))throw Error('SDK loaded during import');
      return next(specifier,context);
    }});
    await import(${JSON.stringify(url)}); console.log('inert');`], {encoding: 'utf8', timeout: 5000});
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'inert');
});

test('offline bootstrap lock keeps nested runtime dependencies and drops dev-only packages', () => {
  const packages = {
    'node_modules/peer': {dependencies: {shared: '^2'}, optionalDependencies: {absent: '1'}},
    'node_modules/peer/node_modules/shared': {version: '2.0.0'},
    'node_modules/shared': {version: '1.0.0', dependencies: {leaf: '1'}},
    'node_modules/leaf': {},
    'node_modules/runtime': {dependencies: {shared: '^1'}},
    'node_modules/devonly': {dependencies: {leaf: '1'}},
  };
  assert.deepEqual([...lockSubtree(packages, ['peer', 'runtime'])].sort(), [
    'node_modules/leaf', 'node_modules/peer', 'node_modules/peer/node_modules/shared', 'node_modules/runtime', 'node_modules/shared']);
  assert.throws(() => lockSubtree({'node_modules/peer': {dependencies: {gone: '1'}}}, ['peer']), /missing gone required by node_modules\/peer/);
});
