import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const skip = process.platform !== 'win32' && 'Requires native Windows cmd.exe';
const shim = fileURLToPath(new URL('../bin/apex.cmd', import.meta.url));
const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const cmdExe = path.join(system32, 'cmd.exe');

// cmd.exe parses its own command line, so it is passed verbatim: /s strips the outer quotes of /c "...".
function cmd(line, {cwd, env = process.env}) {
  return spawnSync(cmdExe, ['/d', '/s', '/c', `"${line}"`], {cwd, env, encoding: 'utf8', windowsVerbatimArguments: true, timeout: 60000});
}

// Windows names it Path; dropping every spelling keeps the child's PATH unambiguous.
function withPath(entries) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH'));
  return {...env, PATH: entries.join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD'};
}

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'apex cmd shim (')));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}

test('bin\\apex.cmd runs the real bin/apex from a foreign folder', {skip}, t => {
  const cwd = fixture(t);
  const result = cmd(`"${shim}" --version`, {cwd});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\d+\.\d+\.\d+\s*$/);
});

test('apex resolves through PATH, keeps the caller folder and passes arguments unchanged', {skip}, t => {
  const root = fixture(t);
  // The shipped shim next to a probe named "apex", exactly as bin\apex.cmd sits next to bin\apex.
  const bin = path.join(root, 'bin');
  const work = path.join(root, 'project & co');
  mkdirSync(bin); mkdirSync(work);
  copyFileSync(shim, path.join(bin, 'apex.cmd'));
  writeFileSync(path.join(bin, 'apex'), 'console.log(JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2)}));\n');
  const env = withPath([bin, path.dirname(process.execPath), system32]);
  const result = cmd('apex --session "id with spaces" --apex-help', {cwd: work, env});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {cwd: work, args: ['--session', 'id with spaces', '--apex-help']});
});

test('apex without Bun on PATH fails with the setup message and exit code 1', {skip}, t => {
  const cwd = fixture(t);
  const result = cmd(`"${shim}" --version`, {cwd, env: withPath([system32])});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Apex needs Bun 1\.4\.3 or newer on PATH/);
  assert.match(result.stderr, /bun run preflight:windows/);
});
