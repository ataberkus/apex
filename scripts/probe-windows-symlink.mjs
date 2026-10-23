import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readFile, lstat, readlink, symlink, link, rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {directoryLink} from '../tests/fixtures/filesystem.mjs';
import {correctToolCall} from '../extensions/apex-core/control.mjs';
import {captureEnvironment} from '../extensions/apex-core/environment.mjs';
import {createLearnings} from '../extensions/apex-features/learnings.mjs';
import {createCheckpointManager} from '../extensions/apex-features/checkpoints.mjs';
import {readSessionReport} from '../lib/session-report.mjs';
import {whitelistedEnvironment} from './micro-session.mjs';

const prerequisite = 'Run this probe and the targeted tests in a native Windows environment already allowing unprivileged file symlinks (Developer Mode), or with SeCreateSymbolicLinkPrivilege already available to the non-elevated process token. This probe does not grant privileges, elevate, or change policy.';
const nativeProbe = String.raw`$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ApexFileSymlinkProbe {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.U1)]
  public static extern bool CreateSymbolicLinkW(string link, string target, uint flags);
}
'@
$root=$env:APEX_SYMLINK_PROBE_ROOT
$attempts=@()
foreach($item in @(
  @{name='file-privileged'; target=(Join-Path $root 'target.txt'); flags=0},
  @{name='file-unprivileged'; target=(Join-Path $root 'target.txt'); flags=2},
  @{name='file-relative'; target='target.txt'; flags=2},
  @{name='file-dangling'; target=(Join-Path $root 'absent.txt'); flags=2}
)) {
  $ok=[ApexFileSymlinkProbe]::CreateSymbolicLinkW((Join-Path $root $item.name), $item.target, [uint32]$item.flags)
  $code=if($ok){0}else{[Runtime.InteropServices.Marshal]::GetLastWin32Error()}
  $attempts+=@{name=$item.name; flags=$item.flags; created=$ok; win32_error=$code}
}
$developer=$null
try {$developer=(Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -Name AllowDevelopmentWithoutDevLicense -ErrorAction Stop).AllowDevelopmentWithoutDevLicense -eq 1} catch {}
$privileges=& (Join-Path $env:SystemRoot 'System32\whoami.exe') /priv /fo csv /nh
@{attempts=$attempts; developer_mode=$developer; symlink_privilege_listed=([bool]($privileges -match 'SeCreateSymbolicLinkPrivilege'))} | ConvertTo-Json -Depth 4 -Compress`;

async function verifyFileLink(filename) {
  assert.equal((await lstat(filename)).isSymbolicLink(), true);
  const target = await readlink(filename);
  assert.ok(target.endsWith('target.txt') || target.endsWith('absent.txt'));
  if (target.endsWith('target.txt')) assert.equal(await readFile(filename, 'utf8'), 'owned target\r\n');
  else await assert.rejects(readFile(filename), {code: 'ENOENT'});
}

/** Actual native calls in a fresh owned fixture, with separate junction/hard-link evidence. */
export async function probeWindowsSymlinks() {
  const report = {schema_version: 1, kind: 'windows_file_symlink_capability', status: 'BLOCKED',
    native_windows: process.platform === 'win32', bun: process.versions.bun, libuv: process.versions.uv,
    provider_calls: 0, elevation_requested: false, security_policy_changed: false,
    file_symlink_boundaries_passed: false, prerequisite, reachable_boundaries: []};
  if (!report.native_windows) {report.reason = 'native-windows-required'; return report;}
  const root = await mkdtemp(path.join(process.cwd(), '.windows-symlink-probe-'));
  try {
    await writeFile(path.join(root, 'target.txt'), 'owned target\r\n');
    report.node_attempts = [];
    for (const [name, target] of [['node-file', path.join(root, 'target.txt')],
      ['node-relative', 'target.txt'], ['node-dangling', path.join(root, 'absent.txt')]]) {
      let attempt;
      try {
        await symlink(target, path.join(root, name), 'file');
        await verifyFileLink(path.join(root, name));
        attempt = {name, type: 'file', created: true, verified_file_symlink: true};
      } catch (error) {
        if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
        attempt = {name, type: 'file', created: false, error_code: error.code, errno: error.errno, syscall: error.syscall};
      }
      report.node_attempts.push(attempt);
    }
    const env = {...whitelistedEnvironment(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']), APEX_SYMLINK_PROBE_ROOT: root};
    const result = spawnSync(path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', nativeProbe],
      {env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000, maxBuffer: 65536});
    if (result.error || result.status !== 0) {
      report.native_api = {status: 'UNVERIFIED', error_code: result.error?.code ?? null, exit_code: result.status};
    } else {
      report.native_api = JSON.parse(result.stdout);
      for (const attempt of report.native_api.attempts) if (attempt.created) {
        await verifyFileLink(path.join(root, attempt.name));
        attempt.verified_file_symlink = true;
      }
    }
    const attempts = report.native_api.attempts ?? [];
    const allNodeAvailable = report.node_attempts.every(attempt => attempt.created);
    const privilegeBlocked = attempts.length === 4 && attempts.every(attempt => !attempt.created && attempt.win32_error === 1314);
    report.runtime_support = allNodeAvailable || privilegeBlocked || attempts.some(attempt => attempt.created) ? 'AVAILABLE' : 'UNVERIFIED';
    report.status = allNodeAvailable ? 'AVAILABLE' : 'BLOCKED';
    report.reason = allNodeAvailable ? 'actual-file-symlinks-verified' : privilegeBlocked ? 'ERROR_PRIVILEGE_NOT_HELD' :
      attempts.some(attempt => attempt.created) ? 'node-native-capability-mismatch' : 'file-symlink-capability-unavailable';
    report.native_alternative_available = attempts.some(attempt => attempt.flags === 2 && attempt.created);
    if (allNodeAvailable) report.prerequisite = null;

    const outside = path.join(root, 'outside'), cwd = path.join(root, 'cwd');
    await mkdir(outside); await mkdir(cwd);
    await writeFile(path.join(outside, 'protected.txt'), 'protected\r\n');
    await writeFile(path.join(outside, 'package.json'), '{"main":"OUTSIDE_FIXTURE_ONLY"}');
    await directoryLink(outside, path.join(cwd, 'external'));
    assert.equal((await lstat(path.join(cwd, 'external'))).isSymbolicLink(), true);
    for (const name of ['external/protected.txt', 'external/new/nested.txt', '../outside/protected.txt']) {
      const blocked = await correctToolCall({type: 'tool_call', toolName: 'write', toolCallId: 'probe', input: {path: name, content: 'not written'}}, {cwd});
      assert.equal(blocked.block, true); assert.match(blocked.reason, /outside|confined/);
    }
    assert.equal(await readFile(path.join(outside, 'protected.txt'), 'utf8'), 'protected\r\n');
    await assert.rejects(lstat(path.join(outside, 'new')), {code: 'ENOENT'});
    report.reachable_boundaries.push({id: 'write-lexical-and-external-junction-confinement', link_type: 'directory-junction', status: 'PASS'});
    const capture = await captureEnvironment({cwd, entrypoints: true, runCommand: async () => ({available: false})});
    assert.ok(!capture.details.files.some(item => item.path.startsWith('external')));
    assert.doesNotMatch(capture.text, /OUTSIDE_FIXTURE_ONLY/);
    report.reachable_boundaries.push({id: 'environment-excludes-external-junction', link_type: 'directory-junction', status: 'PASS'});
    await directoryLink(outside, path.join(cwd, '.apex'));
    const store = createLearnings({cwd});
    assert.equal((await store.append('not written')).ok, false);
    assert.equal((await store.load()).ok, false);
    await assert.rejects(lstat(path.join(outside, 'LEARNINGS.md')), {code: 'ENOENT'});
    report.reachable_boundaries.push({id: 'learnings-junction-root-refused', link_type: 'directory-junction', status: 'PASS'});
    await rm(path.join(cwd, '.apex'));
    await writeFile(path.join(outside, 'session.jsonl'), JSON.stringify({type: 'session', version: 3,
      id: '00000000-0000-4000-8000-000000000001', timestamp: '2026-10-01T00:00:00Z', cwd}) + '\n');
    await assert.rejects(readSessionReport(path.join(cwd, 'external', 'session.jsonl')), /symlink/i);
    report.reachable_boundaries.push({id: 'session-junction-ancestor-refused', link_type: 'directory-junction', status: 'PASS'});
    await rm(path.join(cwd, 'external'));
    const git = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '--template=', '-q'],
      {cwd, env: {...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0'},
        encoding: 'utf8', windowsHide: true, shell: false, timeout: 10000, maxBuffer: 32768});
    assert.equal(git.error, undefined);
    assert.equal(git.status, 0);
    await writeFile(path.join(cwd, 'source.txt'), 'source\r\n');
    await link(path.join(cwd, 'source.txt'), path.join(outside, 'hardlink.txt'));
    assert.equal((await lstat(path.join(cwd, 'source.txt'))).nlink, 2);
    const manager = createCheckpointManager({cwd, sessionId: 'symlink-capability'});
    try {await assert.rejects(manager.capture('hardlink'), /one link|regular file/i);}
    finally {await manager.shutdown();}
    assert.equal(await readFile(path.join(outside, 'hardlink.txt'), 'utf8'), 'source\r\n');
    report.reachable_boundaries.push({id: 'checkpoint-multiple-file-links-refused', link_type: 'hard-link', status: 'PASS'});
    report.reachable_boundaries_are_file_symlink_evidence = false;
  } finally {
    await rm(root, {recursive: true, force: true});
    report.fixture_removed = true;
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('This probe accepts no arguments.');
  const report = await probeWindowsSymlinks();
  await writeFile(new URL('../validation/windows-symlink-capability.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === 'AVAILABLE' ? 0 : 2;
}
