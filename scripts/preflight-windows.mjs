import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PI_VERSION} from '../lib/launcher.mjs';
import {WINDOWS_DEFERRED} from '../lib/windows-target.mjs';
import {whitelistedEnvironment} from './micro-session.mjs';

const ENV_NAMES = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'PATHEXT'];
const NET_PROBE = String.raw`$ErrorActionPreference='Stop'; if($PSVersionTable.PSVersion.Major -lt 5 -or $ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit 2 }; if((Get-ExecutionPolicy) -in @('Restricted','AllSigned')) { exit 2 }; [void][System.Security.AccessControl.DirectorySecurity]; [void][System.Security.Principal.WindowsIdentity]; Write-Output 'apex-windows-net-ready'`;
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : null;
const atLeast = (value, minimum) => {
  const a = version(value), b = version(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};
function readJson(file) {try {return JSON.parse(readFileSync(file, 'utf8'));} catch {return null;}}

export function windowsProbeEnvironment(root, source = process.env) {
  const env = whitelistedEnvironment(ENV_NAMES, source, 'win32');
  env.PATH = [path.join(root, '.tools', 'bin'), env.PATH].filter(Boolean).join(path.delimiter);
  // Windows PowerShell can silently fail to invoke native commands without it.
  // Supply only the native/script shim types we actually support.
  env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  return env;
}

/** Read-only native prerequisites; never reads auth, invokes Python, or probes Docker. */
export function runWindowsPreflight({projectRoot = process.cwd(), platform = process.platform,
  sourceEnv = process.env, run = spawnSync} = {}) {
  const root = path.resolve(projectRoot);
  const checks = [];
  const add = (id, passed, details = {}) => checks.push({id, status: passed ? 'pass' : 'blocked', required: true, ...details});
  add('native-windows', platform === 'win32', {message: 'Run with native Windows Bun, not WSL.'});
  const env = windowsProbeEnvironment(root, sourceEnv);
  const options = {cwd: root, env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000, maxBuffer: 32768};
  // Match runtime resolution: Pi finds Git Bash under Program Files, then PATH; Apex spawns git/rg/fd from
  // PATH only. Workspace .tools/bin serves dev probes/micro children, never an installed launcher.
  const runtimePath = whitelistedEnvironment(['PATH'], sourceEnv, 'win32').PATH ?? '';
  const locate = (name, extra = []) => [...extra, ...runtimePath.split(path.delimiter).filter(Boolean).map(folder => path.join(folder, name))]
    .find(file => path.isAbsolute(file) && existsSync(file) &&
      !/[\\/]Windows[\\/](?:System32|Sysnative)[\\/]bash\.exe$/i.test(file));
  const probe = (id, executable, args, matches) => {
    let passed = false, reason = 'missing-executable';
    if (executable) {
      try {
        const result = run(executable, args, options);
        passed = !result.error && result.status === 0 && matches(String(result.stdout ?? '').trim());
        reason = result.error?.code === 'ETIMEDOUT' ? 'timed-out' : 'probe-failed';
      } catch {reason = 'probe-failed';}
    }
    add(id, passed, passed ? {} : {reason});
  };
  if (platform === 'win32') {
    add('bun', atLeast(process.versions.bun, '1.4.3'), {observed: process.versions.bun, minimum: '1.4.3'});
    const pi = readJson(path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'));
    add('pi-pin', pi?.version === PI_VERSION, {observed: pi?.version === PI_VERSION ? PI_VERSION : null, expected: PI_VERSION});
    const locations = whitelistedEnvironment(['ProgramFiles', 'ProgramFiles(x86)'], sourceEnv, 'win32');
    const gitFolders = Object.values(locations).map(folder => path.join(folder, 'Git'));
    probe('git', locate('git.exe'), ['--version'], text => /^git version \d/.test(text));
    const bash = locate('bash.exe', gitFolders.map(folder => path.join(folder, 'bin', 'bash.exe')));
    probe('git-bash', bash, ['--noprofile', '--norc', '-c', 'printf apex-native-bash'], text => text === 'apex-native-bash');
    probe('ripgrep', locate('rg.exe'), ['--version'], text => /^ripgrep \d/.test(text));
    probe('fd', locate('fd.exe'), ['--version'], text => /^fd \d/.test(text));
    // Secure spill creation deliberately requires Windows PowerShell/.NET Framework,
    // not pwsh/.NET Core, and does not bypass effective execution policy.
    const powershell = path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    probe('windows-powershell-net', existsSync(powershell) ? powershell : null,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', NET_PROBE], text => text === 'apex-windows-net-ready');
    add('private-spill-helper', existsSync(path.join(root, 'extensions', 'apex-context', 'private-spill.ps1')));
  }
  const ready = checks.every(check => check.status === 'pass');
  return {schema_version: 1, kind: 'windows_native_preflight', readiness: ready ? 'tooling-ready' : 'blocked',
    target: 'windows', tooling_only: true, provider_calls: 0, paid_execution: false, auth_checked: false,
    checks, deferred: [...WINDOWS_DEFERRED],
    scope: 'Native tooling only. No installs, containers, credentials, inference, or benchmark acceptance.'};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const report = args.length > 1 || args.some(arg => arg !== '--json') ?
    {readiness: 'blocked', reason: 'unsupported-arguments', paid_execution: false} : runWindowsPreflight();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.readiness === 'tooling-ready' ? 0 : 2;
}
