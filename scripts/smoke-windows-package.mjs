import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, lstatSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {runWindowsPreflight, windowsProbeEnvironment} from './preflight-windows.mjs';
import {PI_VERSION} from '../lib/launcher.mjs';
import {fixtureEnvironment, fixtureShellPath, WINDOWS_FIXTURE_ENV} from './micro-session.mjs';

/** bun.lock keys reachable from root package names. A nested key `parent/child` is `child` as resolved from `parent`;
 * like node_modules, Bun resolves a dependency of key K nearest-first: `K/dep`, then each ancestor key, then `dep`. */
export function lockSubtree(packages, roots) {
  const keep = new Set();
  const parent = key => {
    const parts = key.split('/');
    return parts.slice(0, parts.length - (parts.at(-2)?.startsWith('@') ? 2 : 1)).join('/');
  };
  const visit = (from, name, required) => {
    for (let base = from; ; base = parent(base)) {
      const key = base ? `${base}/${name}` : name;
      if (packages[key]) {
        if (keep.has(key)) return;
        keep.add(key);
        const {dependencies = {}, optionalDependencies = {}, peerDependencies = {}} = packages[key][2] ?? {};
        for (const dependency of Object.keys(dependencies)) visit(key, dependency, true);
        for (const dependency of Object.keys({...optionalDependencies, ...peerDependencies})) visit(key, dependency, false);
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
  // The user's Bun cache (bunfig/BUN_INSTALL_CACHE_DIR respected). The install itself runs in a confined
  // profile, so the cache is passed explicitly; `--offline` makes Bun refuse the network instead of falling back.
  const cacheQuery = spawnSync(process.execPath, ['pm', 'cache'], {cwd: root, encoding: 'utf8', shell: false, windowsHide: true, timeout: 30000});
  const cache = cacheQuery.status === 0 ? cacheQuery.stdout.trim() : '';
  if (!cache || !path.isAbsolute(cache) || !existsSync(cache)) {result.reason = 'bun-local-cache-unavailable'; return result;}
  mkdirSync(evidence, {recursive: true});
  const scratch = mkdtempSync(path.join(root, '.windows-package-'));
  const env = fixtureEnvironment(['PATH','SystemRoot','WINDIR','PI_OFFLINE','PI_CODING_AGENT_DIR', ...WINDOWS_FIXTURE_ENV],
    scratch, windowsProbeEnvironment(root), 'win32');
  Object.assign(env, {PI_OFFLINE: '1', PI_CODING_AGENT_DIR: path.join(scratch, 'agent')});
  const run = (name, command, args, options = {}) => {
    const child = spawnSync(command, args, {cwd: scratch, env, shell: false, windowsHide: true,
      encoding: 'utf8', timeout: 120000, maxBuffer: 4194304, ...options});
    writeFileSync(path.join(evidence, `${name}.log`), `exit=${child.status}\n${child.stdout ?? ''}\n${child.stderr ?? ''}`);
    return child;
  };
  const offline = ['--offline', '--cache-dir', cache, '--linker=hoisted', '--ignore-scripts'];
  const missingFromCache = child => [...`${child.stderr ?? ''}`.matchAll(/--offline: "([^"]+)" is not in the cache/g)].map(match => match[1]);
  const readLock = folder => Bun.JSONC.parse(readFileSync(path.join(folder, 'bun.lock'), 'utf8')).packages ?? {};
  try {
    const packed = run('pack', process.execPath, ['pm', 'pack', '--ignore-scripts', '--quiet', '--destination', evidence], {cwd: root});
    if (packed.error || packed.status !== 0) {result.reason = 'local-pack-failed'; return result;}
    const tarball = packed.stdout.trim();
    if (path.dirname(tarball) !== evidence || !tarball.endsWith('.tgz') || !existsSync(tarball)) throw new Error('Invalid package filename');
    const tarballBytes = readFileSync(tarball);
    result.package_sha256 = createHash('sha256').update(tarballBytes).digest('hex');
    const prefix = path.join(scratch, 'install');
    // Bootstrap the exact peer and runtime dependency trees from the source bun.lock: a frozen lock needs no
    // registry metadata, only cached tarballs. Only lock entries reachable from those roots are kept, so dev-only
    // test tooling never enters the install. No host dependency copy or junction, registry re-resolution, or
    // repacked peer is used.
    const sourceLock = Bun.JSONC.parse(readFileSync(path.join(root, 'bun.lock'), 'utf8'));
    const peerPin = sourceLock.packages?.['@earendil-works/pi-coding-agent'];
    if (peerPin?.[0] !== `@earendil-works/pi-coding-agent@${PI_VERSION}` || peerPin[1] !== '' ||
        !/^sha512-[A-Za-z0-9+/]+=*$/.test(peerPin[3] ?? '')) throw new Error('Invalid pinned peer artifact');
    mkdirSync(prefix);
    const {dependencies = {}} = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const bootstrap = {name: 'apex-windows-install-smoke', version: '0.0.0', private: true,
      dependencies, devDependencies: {'@earendil-works/pi-coding-agent': PI_VERSION}};
    writeFileSync(path.join(prefix, 'package.json'), JSON.stringify(bootstrap));
    const packages = {};
    for (const key of lockSubtree(sourceLock.packages, ['@earendil-works/pi-coding-agent', ...Object.keys(dependencies)])) packages[key] = sourceLock.packages[key];
    writeFileSync(path.join(prefix, 'bun.lock'), JSON.stringify({lockfileVersion: sourceLock.lockfileVersion,
      configVersion: sourceLock.configVersion, workspaces: {'': {name: bootstrap.name, dependencies,
        devDependencies: bootstrap.devDependencies}}, packages}, null, 2));
    const peerInstall = run('peer-install', process.execPath, ['install', '--frozen-lockfile', ...offline], {cwd: prefix});
    if (peerInstall.error || peerInstall.status !== 0) {
      result.reason = 'offline-peer-bootstrap-unavailable; inspect peer-install.log, no online fallback attempted';
      result.missing_from_bun_cache = missingFromCache(peerInstall);
      return result;
    }
    const installed = run('install', process.execPath, ['add', '--exact', ...offline, tarball], {cwd: prefix});
    if (installed.error || installed.status !== 0) {
      result.reason = 'offline-install-unavailable; inspect install.log, no online fallback attempted';
      result.missing_from_bun_cache = missingFromCache(installed);
      return result;
    }
    result.status = 'FAIL';
    const packageRoot = path.join(prefix, 'node_modules', '@apex-agent', 'pi');
    const peerRoot = path.join(prefix, 'node_modules', '@earendil-works', 'pi-coding-agent');
    const installedLock = readLock(prefix);
    result.checks.real_package_install = !lstatSync(packageRoot).isSymbolicLink() &&
      installedLock['@apex-agent/pi']?.at(-1) === `sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`;
    result.checks.real_pinned_peer = !lstatSync(peerRoot).isSymbolicLink() &&
      JSON.parse(readFileSync(path.join(peerRoot, 'package.json'), 'utf8')).version === PI_VERSION &&
      installedLock['@earendil-works/pi-coding-agent']?.at(-1) === peerPin[3];
    if (!result.checks.real_package_install || !result.checks.real_pinned_peer) throw new Error('Installed package/peer verification failed');
    const bin = path.join(prefix, 'node_modules', '.bin');
    // Bun's Windows bin shim: apex.exe plus apex.bunx (UTF-16LE: bin path relative to node_modules, then the
    // shebang program). The shim resolves `bun` from PATH, so the runtime directory follows the bin folder.
    env.PATH = [bin, path.dirname(process.execPath), env.PATH].join(path.delimiter);
    const shim = readFileSync(path.join(bin, 'apex.bunx')).toString('utf16le');
    writeFileSync(path.join(evidence, 'bun-apex.bunx.txt'), shim);
    result.checks.bun_shim_targets_packaged_bin = existsSync(path.join(bin, 'apex.exe')) &&
      shim.startsWith('@apex-agent\\pi\\bin\\apex"\0bun ');
    const powershell = path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    run('powershell-command-diagnostic', powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Write-Output "native-powershell-started"; Get-Command apex,bun.exe | Select-Object Name,CommandType,Source | ConvertTo-Json -Compress']);
    const help = run('powershell-shim', powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '& apex --apex-help; exit $LASTEXITCODE']);
    result.checks.powershell_apex_command = help.status === 0 && help.stdout.includes('--apex-target windows');
    const cmd = path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
    const cmdHelp = run('cmd-shim', cmd, ['/d', '/s', '/c', 'apex --apex-help']);
    result.checks.cmd_apex_command = cmdHelp.status === 0 && cmdHelp.stdout.includes('--apex-target windows');
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
