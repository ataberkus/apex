import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, lstatSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {runWindowsPreflight, windowsProbeEnvironment} from './preflight-windows.mjs';
import {PI_VERSION} from '../lib/launcher.mjs';
import {fixtureEnvironment, fixtureShellPath, WINDOWS_FIXTURE_ENV} from './micro-session.mjs';

/** Lock keys reachable from root package names, using node_modules nearest-ancestor resolution. */
export function lockSubtree(packages, roots) {
  const keep = new Set();
  const visit = (from, name, required) => {
    for (let base = from; ; base = base.includes('/node_modules/') ? base.slice(0, base.lastIndexOf('/node_modules/')) : '') {
      const key = `${base ? `${base}/` : ''}node_modules/${name}`;
      if (packages[key]) {
        if (keep.has(key)) return;
        keep.add(key);
        const entry = packages[key];
        for (const dependency of Object.keys(entry.dependencies ?? {})) visit(key, dependency, true);
        for (const dependency of Object.keys({...entry.optionalDependencies, ...entry.peerDependencies})) visit(key, dependency, false);
        return;
      }
      if (!base) { if (required) throw new Error(`Lock is missing ${name} required by ${from || 'root'}`); return; }
    }
  };
  for (const name of roots) visit('', name, true);
  return keep;
}

/** Explicit local offline installation smoke; never part of the unit test command. */
export function smokeWindowsPackage() {
  const root = path.resolve(process.cwd());
  const evidence = path.join(root, 'artifacts', 'windows-native');
  const result = {schema_version: 1, kind: 'windows_clean_package_smoke', status: 'BLOCKED',
    provider_calls: 0, benchmark_runs: 0, dependency_junction_used: false, offline_install: true, checks: {}};
  result.preflight = runWindowsPreflight({projectRoot: root});
  if (result.preflight.readiness !== 'tooling-ready') return result;
  const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const workspaceCache = path.join(root, '.cache', 'npm');
  const cache = existsSync(workspaceCache) ? workspaceCache :
    process.env.npm_config_cache ?? (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'npm-cache'));
  if (!existsSync(npmCli) || !cache || !path.isAbsolute(cache)) {result.reason = 'npm-cli-or-local-cache-unavailable'; return result;}
  mkdirSync(evidence, {recursive: true});
  const scratch = mkdtempSync(path.join(root, '.windows-package-'));
  const env = fixtureEnvironment(['PATH','SystemRoot','WINDIR','PI_OFFLINE','PI_CODING_AGENT_DIR', ...WINDOWS_FIXTURE_ENV],
    scratch, windowsProbeEnvironment(root), 'win32');
  const userConfig = path.join(scratch, 'user.npmrc'), globalConfig = path.join(scratch, 'global.npmrc');
  writeFileSync(userConfig, ''); writeFileSync(globalConfig, '');
  Object.assign(env, {PI_OFFLINE: '1', PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
    npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
    npm_config_cache: cache, npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false'});
  const run = (name, command, args, options = {}) => {
    const child = spawnSync(command, args, {cwd: scratch, env, shell: false, windowsHide: true,
      encoding: 'utf8', timeout: 120000, maxBuffer: 4194304, ...options});
    writeFileSync(path.join(evidence, `${name}.log`), `exit=${child.status}\n${child.stdout ?? ''}\n${child.stderr ?? ''}`);
    return child;
  };
  try {
    const packed = run('pack', process.execPath, [npmCli, 'pack', root, '--offline', '--ignore-scripts', '--json', '--pack-destination', evidence]);
    if (packed.error || packed.status !== 0) {result.reason = 'local-pack-failed'; return result;}
    const info = JSON.parse(packed.stdout);
    if (info.length !== 1 || path.basename(info[0].filename) !== info[0].filename) throw new Error('Invalid package filename');
    const tarball = path.join(evidence, info[0].filename);
    result.package_sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    const prefix = path.join(scratch, 'install');
    // Bootstrap the exact peer and runtime dependency trees with npm ci: a tarball
    // cache does not imply registry packuments are cached. Only lock entries
    // reachable from those roots are kept, so dev-only test tooling never enters
    // the install. No host dependency copy or junction, registry re-resolution, or repacked peer is used.
    const sourceLock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const peerPin = sourceLock.packages?.['node_modules/@earendil-works/pi-coding-agent'];
    if (peerPin?.version !== PI_VERSION ||
        peerPin.resolved !== `https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-${PI_VERSION}.tgz` ||
        !/^sha512-[A-Za-z0-9+/]+=*$/.test(peerPin.integrity ?? '')) throw new Error('Invalid pinned peer artifact');
    mkdirSync(prefix);
    const {dependencies = {}} = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const bootstrap = {name: 'apex-windows-install-smoke', version: '0.0.0', private: true,
      dependencies, devDependencies: {'@earendil-works/pi-coding-agent': PI_VERSION}};
    writeFileSync(path.join(prefix, 'package.json'), JSON.stringify(bootstrap));
    const packages = {'': bootstrap};
    for (const key of lockSubtree(sourceLock.packages, ['@earendil-works/pi-coding-agent', ...Object.keys(dependencies)])) packages[key] = sourceLock.packages[key];
    writeFileSync(path.join(prefix, 'package-lock.json'), JSON.stringify({...sourceLock, name: bootstrap.name, packages}));
    const peerInstall = run('peer-ci', process.execPath, [npmCli, 'ci', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund']);
    if (peerInstall.error || peerInstall.status !== 0) {result.reason = 'offline-peer-bootstrap-unavailable; inspect peer-ci.log'; return result;}
    const installed = run('install', process.execPath, [npmCli, 'install', '--prefix', prefix, '--offline', '--ignore-scripts',
      '--no-audit', '--no-fund', '--save-exact', '--legacy-peer-deps', tarball]);
    if (installed.error || installed.status !== 0) {result.reason = 'offline-install-unavailable; inspect install.log, no online fallback attempted'; return result;}
    result.status = 'FAIL';
    const packageRoot = path.join(prefix, 'node_modules', '@apex-agent', 'pi');
    const peerRoot = path.join(prefix, 'node_modules', '@earendil-works', 'pi-coding-agent');
    result.checks.real_package_install = !lstatSync(packageRoot).isSymbolicLink();
    const installedPeerPin = JSON.parse(readFileSync(path.join(prefix, 'package-lock.json'), 'utf8'))
      .packages?.['node_modules/@earendil-works/pi-coding-agent'];
    result.checks.real_pinned_peer = !lstatSync(peerRoot).isSymbolicLink() &&
      JSON.parse(readFileSync(path.join(peerRoot, 'package.json'), 'utf8')).version === PI_VERSION &&
      installedPeerPin?.integrity === peerPin.integrity;
    if (!result.checks.real_package_install || !result.checks.real_pinned_peer) throw new Error('Installed package/peer verification failed');
    const bin = path.join(prefix, 'node_modules', '.bin');
    env.PATH = [bin, path.dirname(process.execPath), env.PATH].join(path.delimiter);
    for (const suffix of ['.ps1', '.cmd']) writeFileSync(path.join(evidence, `npm-apex${suffix}.txt`), readFileSync(path.join(bin, `apex${suffix}`)));
    const powershell = path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    run('powershell-command-diagnostic', powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Write-Output "native-powershell-started"; Get-Command apex,node.exe | Select-Object Name,CommandType,Source | ConvertTo-Json -Compress']);
    const help = run('powershell-shim', powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '& apex --apex-help; exit $LASTEXITCODE']);
    result.checks.powershell_apex_command = help.status === 0 && help.stdout.includes('--apex-target windows');
    const bash = fixtureShellPath();
    const bashHelp = bash && run('bash-shim', bash, ['--noprofile', '--norc', '-c', 'apex --apex-help']);
    result.checks.git_bash_apex_command = bashHelp?.status === 0 && bashHelp.stdout.includes('--apex-target windows');
    const dry = run('powershell-dry-run', powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '& apex --apex-dry-run --apex-target windows --profile headless --apex-context "read,shape" --apex-features "cost,plan" "literal task"; exit $LASTEXITCODE']);
    let invocation;
    try {invocation = JSON.parse(dry.stdout);} catch {}
    result.checks.packaged_windows_selection = dry.status === 0 && invocation?.target === 'windows' &&
      invocation.args[invocation.args.indexOf('--model') + 1] === 'anthropic/claude-opus-5-5' &&
      invocation.args[invocation.args.indexOf('--thinking') + 1] === 'medium' && invocation.args.at(-1) === 'literal task';
    const cliHelp = run('packaged-cli-help', process.execPath, [path.join(packageRoot, 'bin', 'apex'), '--apex-target', 'windows',
      '--apex-context', 'shape', '--apex-features', 'cost,plan', '--offline', '--help']);
    result.checks.packaged_feature_cli_loads = cliHelp.status === 0 && cliHelp.stdout.includes('--apex-context-flags') && cliHelp.stdout.includes('--apex-feature-flags');
    const fixture = path.join(scratch, 'packaged fixture ç'); mkdirSync(fixture);
    const smoke = path.join(scratch, 'spill.mjs');
    writeFileSync(smoke, `
      import assert from 'node:assert/strict'; import {readFile} from 'node:fs/promises';
      import {createBashTool} from ${JSON.stringify(pathToFileURL(path.join(peerRoot, 'dist/index.js')).href)};
      import {shapeToolResult} from ${JSON.stringify(pathToFileURL(path.join(packageRoot, 'extensions/apex-context/shaping.mjs')).href)};
      const cwd=${JSON.stringify(fixture)};
      const raw=await createBashTool(cwd,{shellPath:${JSON.stringify(bash)},exposeSessionEnvironment:false}).execute('packaged',
        {command:"for ((i=0;i<700;i++)); do printf 'packaged-native-output\\\\r\\\\n'; done",timeout:5});
      const shaped=await shapeToolResult({toolName:'bash',toolCallId:'packaged',input:{command:'fixture'},...raw},{cwd});
      assert.ok(shaped?.details?.apexShape); assert.equal(shaped.structuredContent.exit_code,0);
      assert.equal(await readFile(shaped.details.apexShape.logPath,'utf8'),raw.content.filter(p=>p.type==='text').map(p=>p.text).join('\\n'));
      console.log(JSON.stringify({status:'PASS',returned_bytes:shaped.details.apexShape.returnedBytes,raw_bytes:shaped.details.apexShape.originalBytes,exit_code:0,exact_raw_recovery:true}));
    `);
    const spill = run('packaged-native-spill', process.execPath, [smoke]);
    let spillReport;
    try {spillReport = JSON.parse(spill.stdout);} catch {}
    result.checks.packaged_native_spill = spill.status === 0 && spillReport?.status === 'PASS' &&
      spillReport.exact_raw_recovery === true && spillReport.returned_bytes < spillReport.raw_bytes;
    result.spill = spillReport ?? null;
    result.status = Object.values(result.checks).every(value => value === true) ? 'PASS' : 'FAIL';
    return result;
  } catch {result.status = 'FAIL'; result.reason = 'package-smoke-operation-failed'; return result;}
  finally {
    try {rmSync(scratch, {recursive: true, force: true}); result.temporary_install_removed = true;}
    catch {result.temporary_install_removed = false; result.status = 'FAIL';}
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = process.argv.length === 2 ? smokeWindowsPackage() : {status: 'BLOCKED', reason: 'unsupported-arguments'};
  mkdirSync('validation', {recursive: true});
  writeFileSync('validation/windows-package-smoke.json', `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === 'PASS' ? 0 : result.status === 'BLOCKED' ? 2 : 1;
}
