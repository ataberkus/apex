import assert from 'node:assert/strict';
import {execFile, spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, readFile, writeFile, rm, readdir} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {createCheckpointManager} from '../extensions/apex-features/checkpoints.mjs';
import {createLearnings} from '../extensions/apex-features/learnings.mjs';
import {shapeToolResult} from '../extensions/apex-context/shaping.mjs';
import {ensureWindowsPrivateApex} from '../lib/windows-private-storage.mjs';
import {whitelistedEnvironment} from '../scripts/micro-session.mjs';

const exec = promisify(execFile);
const native = {skip: process.platform !== 'win32' && 'Requires native Windows ACLs', timeout: 60000};
async function fixture(t) {
  const cwd = await mkdtemp(path.join(process.cwd(), 'tests/windows storage ç-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  return cwd;
}
async function git(cwd, args) {
  return exec('git', ['-c', 'core.hooksPath=/dev/null', ...args],
    {cwd, env: {...whitelistedEnvironment(['PATH','SystemRoot','WINDIR']), GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0'}, timeout: 10000});
}
async function acl(cwd, relative) {
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const target = path.join(cwd, relative).replaceAll("'", "''");
  const {stdout} = await exec(executable, ['-NoProfile', '-NonInteractive', '-Command',
    `$a=Get-Acl -LiteralPath '${target}'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); @{Protected=$a.AreAccessRulesProtected; Owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; Sid=$sid; Rules=@($rules | ForEach-Object {$_.IdentityReference.Value})} | ConvertTo-Json -Compress`],
    {env: whitelistedEnvironment(['PATH','SystemRoot','WINDIR','TEMP','TMP']), timeout: 30000});
  return JSON.parse(stdout);
}
async function shaped(cwd) {
  const raw = 'raw Windows output ç\r\n'.repeat(700);
  const result = await shapeToolResult({toolName: 'bash', toolCallId: 'windows-composition', input: {command: 'fixture'},
    content: [{type: 'text', text: raw}], structuredContent: {output: raw, truncated: false, exit_code: 7, wall_time_seconds: 0.1}},
    {cwd, maxBytes: 1024, maxLines: 12});
  assert.ok(result?.details?.apexShape, 'Secure shaping must not silently fall back to the unshaped result.');
  assert.equal(result.structuredContent.exit_code, 7);
  assert.equal(await readFile(result.details.apexShape.logPath, 'utf8'), raw);
  assert.ok(Buffer.byteLength(result.structuredContent.output) <= 1024);
  const security = await acl(cwd, '.apex');
  assert.equal(security.Protected, true);
  assert.equal(security.Owner, security.Sid);
  assert.deepEqual(security.Rules, [security.Sid]);
  return result;
}

test('checkpoint-first Windows storage composes with secure shaping and restores exact CRLF bytes without touching the Git index', native, async t => {
  const cwd = await fixture(t);
  await git(cwd, ['init', '--template=', '-q']);
  const original = 'alpha\r\nβeta\r\n';
  await writeFile(path.join(cwd, 'spaced ü file.txt'), original);
  await git(cwd, ['add', '--', 'spaced ü file.txt']);
  const index = await readFile(path.join(cwd, '.git', 'index'));
  const manager = createCheckpointManager({cwd, sessionId: 'windows-composition'});
  t.after(() => manager.shutdown());
  await manager.capture('1');
  await writeFile(path.join(cwd, 'spaced ü file.txt'), 'mutated\n');
  await manager.finish('1');
  await shaped(cwd);
  await manager.restore('1');
  assert.equal(await readFile(path.join(cwd, 'spaced ü file.txt'), 'utf8'), original);
  assert.deepEqual(await readFile(path.join(cwd, '.git', 'index')), index);
  const security = await acl(cwd, '.apex/checkpoints');
  assert.equal(security.Owner, security.Sid);
  assert.ok(security.Rules.every(sid => sid === security.Sid));
});

test('remember-first Windows storage composes with private spill recovery', native, async t => {
  const cwd = await fixture(t);
  const store = createLearnings({cwd});
  assert.equal((await store.append('Keep Unicode paths and CRLF intact.')).ok, true);
  await shaped(cwd);
  assert.match((await store.load()).content, /Keep Unicode paths/);
  const security = await acl(cwd, '.apex/LEARNINGS.md');
  assert.equal(security.Owner, security.Sid);
  assert.ok(security.Rules.every(sid => sid === security.Sid));
});

test('existing public Windows roots refuse private snapshot/fact writes without silently changing ACLs', native, async t => {
  const cwd = await fixture(t);
  await git(cwd, ['init', '--template=', '-q']);
  await writeFile(path.join(cwd, 'source.txt'), 'untouched');
  await mkdir(path.join(cwd, '.apex'));
  const before = await acl(cwd, '.apex');
  const manager = createCheckpointManager({cwd, sessionId: 'public-root'});
  t.after(() => manager.shutdown());
  await assert.rejects(manager.capture('1'), /owner-only Windows ACL/);
  const result = await createLearnings({cwd}).append('must not be written');
  assert.equal(result.ok, false);
  assert.match(result.reason, /owner-only Windows ACL/);
  assert.deepEqual(await acl(cwd, '.apex'), before);
  assert.deepEqual(await readdir(path.join(cwd, '.apex')), []);
  assert.equal(await readFile(path.join(cwd, 'source.txt'), 'utf8'), 'untouched');
});

test('the private root stays out of the user repository status, and a user-edited ignore file is kept', native, async t => {
  const cwd = await fixture(t);
  await git(cwd, ['init', '--template=', '-q']);
  await writeFile(path.join(cwd, 'source.txt'), 'tracked');
  await git(cwd, ['add', 'source.txt']);
  const manager = createCheckpointManager({cwd, sessionId: 'status-clean'});
  t.after(() => manager.shutdown());
  await manager.capture('1');
  await manager.finish('1');
  assert.equal((await git(cwd, ['status', '--porcelain', '--untracked-files=all'])).stdout, 'A  source.txt\n');
  const ignore = path.join(cwd, '.apex', '.gitignore');
  assert.equal(await readFile(ignore, 'utf8'), '*\n');
  await writeFile(ignore, '*\n!keep.md\n');
  await ensureWindowsPrivateApex(cwd);
  assert.equal(await readFile(ignore, 'utf8'), '*\n!keep.md\n');
});

test('cancelled private directory preparation allocates nothing', native, async t => {
  const cwd = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(ensureWindowsPrivateApex(cwd, controller.signal), /aborted/);
  assert.deepEqual(await readdir(cwd), []);
});

test('warm private storage calls reuse one helper instead of paying PowerShell startup each time', native, async t => {
  const roots = await Promise.all([1, 2, 3, 4].map(() => fixture(t)));
  await ensureWindowsPrivateApex(roots[0]);
  for (const root of roots.slice(1)) {
    const started = performance.now();
    await ensureWindowsPrivateApex(root);
    assert.ok(performance.now() - started < 1500, `warm call took ${Math.round(performance.now() - started)} ms`);
    assert.deepEqual(await readdir(root), ['.apex']);
  }
  const security = await acl(roots[3], '.apex');
  assert.deepEqual(security.Rules, [security.Sid]);
});

test('parallel private storage calls on separate roots all complete privately', native, async t => {
  const roots = await Promise.all([1, 2, 3, 4, 5].map(() => fixture(t)));
  await Promise.all(roots.map(root => ensureWindowsPrivateApex(root)));
  // Success already means the helper's RequirePrivate check passed; inspect one root independently.
  for (const root of roots) assert.deepEqual(await readdir(root), ['.apex']);
  const security = await acl(roots[4], '.apex');
  assert.equal(security.Protected, true);
  assert.deepEqual(security.Rules, [security.Sid]);
});

test('cancelling while the helper is still starting stops promptly and allocates nothing', native, async t => {
  const root = await fixture(t);
  const url = new URL('../lib/windows-private-storage.mjs', import.meta.url).href;
  // A fresh process guarantees a cold helper, whose startup takes seconds on slow hosts.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const m = await import(${JSON.stringify(url)}); const controller = new AbortController();
    setTimeout(() => controller.abort(), 100); const started = performance.now();
    try { await m.ensureWindowsPrivateApex(${JSON.stringify(root)}, controller.signal); console.log('completed'); }
    catch (error) { console.log(JSON.stringify({message: error.message, ms: Math.round(performance.now() - started)})); }`],
    {encoding: 'utf8', timeout: 50000});
  assert.equal(child.status, 0, child.stderr);
  const outcome = JSON.parse(child.stdout);
  assert.match(outcome.message, /aborted/);
  assert.ok(outcome.ms < 1500, `cancellation took ${outcome.ms} ms`);
  assert.deepEqual(await readdir(root), []);
});

test('a process that used private storage still exits on its own', native, async t => {
  const root = await fixture(t);
  const url = new URL('../lib/windows-private-storage.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(url)}); await m.ensureWindowsPrivateApex(${JSON.stringify(root)}); console.log('done');`],
    {encoding: 'utf8', timeout: 50000});
  assert.equal(child.error, undefined, 'process did not exit after its last private storage call');
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'done');
});

test('Windows private storage helper import performs no process or filesystem work', () => {
  const url = new URL('../lib/windows-private-storage.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    const deny=()=>{throw Error('allocation during import');};
    cp.spawn=fs.mkdirSync=fs.writeFileSync=deny; syncBuiltinESMExports();
    await import(${JSON.stringify(url)}); console.log('inert');`], {encoding: 'utf8', timeout: 5000});
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'inert');
});
