// Builds the per-user Windows installer dist/apex-setup-<version>.exe. The release workflow and local builds both run
// "bun run build:installer <version>": the version comes from the release tag, package.json stays 0.0.0 in Git.
// It packs this checkout exactly as the release tarball (`bun pm pack`), stamps the version into the staged
// package.json, installs the locked dependencies beside it the way the release gate does (Pi is a devDependency, so a
// production install would drop it) and the desktop app's Electron binary, checks that the staged launcher resolves the
// pinned Pi, then compiles installer/apex.iss with Inno Setup 6 (ISCC.exe from ISCC, PATH or the default install folders).
import {spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PI_VERSION} from '../lib/launcher.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const ISS = path.join(root, 'installer', 'apex.iss');
const USAGE = 'Usage: bun scripts/build-installer.mjs <version>   (X.Y.Z, the release tag without "v")';
// Inno Setup 6 Setup cannot write a path longer than MAX_PATH (259 characters). The default folder,
// C:\Users\<name>\AppData\Local\Programs\Apex\, is 38 characters plus the user name; this leaves room for 32.
const MAX_RELATIVE_PATH = 259 - 38 - 32;

/** The X.Y.Z release version, or an Error naming the usage. Inno's VersionInfoVersion caps each part at 65535. */
export function parseVersion(args) {
  if (args.length !== 1 || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(args[0]) ||
      args[0].split('.').some(part => Number(part) > 65535)) return new Error(USAGE);
  return args[0];
}

/** ISCC.exe: $ISCC, then PATH, then Inno Setup's per-machine and per-user install folders. */
export function findIscc(env = process.env) {
  if (env.ISCC) return existsSync(env.ISCC) ? env.ISCC : null;
  const onPath = Bun.which('ISCC', {PATH: env.PATH ?? env.Path ?? ''});
  if (onPath) return onPath;
  const bases = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')];
  return bases.filter(Boolean).map(base => path.join(base, 'Inno Setup 6', 'ISCC.exe')).find(file => existsSync(file)) ?? null;
}

/** Directory names the script clears before an upgrade ([InstallDelete] filesandordirs "{app}\<name>"). */
export function installDeleteDirectories(script) {
  const section = script.match(/^\[InstallDelete\][^\S\r\n]*\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? '';
  return [...section.matchAll(/^Type:\s*filesandordirs;\s*Name:\s*"\{app\}\\([^"\\]+)"/gim)].map(match => match[1]);
}

function run(command, args, options = {}) {
  const child = spawnSync(command, args, {cwd: root, encoding: 'utf8', shell: false, windowsHide: true,
    maxBuffer: 64 * 1024 * 1024, ...options});
  if (child.error || child.status !== 0) {
    throw new Error(`${path.basename(command)} ${args.join(' ')} failed (exit ${child.status ?? child.error?.code}):\n` +
      `${child.stdout ?? ''}${child.stderr ?? ''}`.trim());
  }
  return child.stdout;
}

// Inno Setup follows a junction or symlink and would ship its target, so the stage must contain neither.
function walk(directory, relative = '') {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const name = relative ? `${relative}\\${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Staged file is a link, which Inno Setup would follow: ${name}`);
    return entry.isDirectory() ? walk(path.join(directory, entry.name), name) : [name];
  });
}

export function buildInstaller(version, {env = process.env, log = console.log} = {}) {
  if (process.platform !== 'win32') throw new Error('The installer is built on native Windows.');
  const iscc = findIscc(env);
  if (!iscc) throw new Error('ISCC.exe (Inno Setup 6) was not found: install it (choco install innosetup) or set ISCC to its path.');
  const script = readFileSync(ISS, 'utf8');
  const bun = process.execPath;
  const stage = mkdtempSync(path.join(os.tmpdir(), 'apex-installer-'));
  try {
    const packDir = path.join(stage, 'pack'), app = path.join(stage, 'app');
    mkdirSync(packDir); mkdirSync(app);
    const tarball = run(bun, ['pm', 'pack', '--ignore-scripts', '--quiet', '--destination', packDir]).trim();
    if (path.dirname(tarball) !== packDir || !tarball.endsWith('.tgz')) throw new Error(`Unexpected pack output: ${tarball}`);
    // Windows' bsdtar; every packed path sits under package/.
    const tar = path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    run(tar, ['-xzf', path.basename(tarball), '-C', app, '--strip-components=1'], {cwd: packDir});
    run(bun, ['pm', 'version', version, '--no-git-tag-version'], {cwd: app});
    copyFileSync(path.join(root, 'bun.lock'), path.join(app, 'bun.lock'));
    // The release gate's install. Hoisted (this lock's default) keeps node_modules free of links.
    run(bun, ['install', '--frozen-lockfile', '--ignore-scripts', '--linker=hoisted'], {cwd: app});
    // The desktop app's Electron: its install script (skipped above) downloads the binary and checks it against the
    // checksums in the locked electron package.
    run(bun, [path.join(app, 'node_modules', 'electron', 'install.js')], {cwd: app});
    if (!existsSync(path.join(app, 'node_modules', 'electron', 'dist', 'electron.exe'))) throw new Error('Staged Electron has no dist\\electron.exe');
    const pi = JSON.parse(readFileSync(path.join(app, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8'));
    if (pi.version !== PI_VERSION) throw new Error(`Staged Pi is ${pi.version}, not the pinned ${PI_VERSION}`);
    const staged = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8'));
    if (staged.version !== version) throw new Error(`Staged package.json is ${staged.version}, not ${version}`);
    // The staged launcher must resolve the bundled Pi, not one from this checkout.
    const reported = run(bun, [path.join(app, 'bin', 'apex'), '--version'], {cwd: stage}).trim();
    if (reported !== PI_VERSION) throw new Error(`Staged "apex --version" printed ${reported}, not ${PI_VERSION}`);
    const files = walk(app);
    const longest = files.reduce((a, b) => b.length > a.length ? b : a, '');
    if (longest.length > MAX_RELATIVE_PATH) throw new Error(`Staged path too long for Inno Setup 6 (${longest.length} > ${MAX_RELATIVE_PATH}): ${longest}`);
    // An upgrade first clears every staged top-level folder, so no file of an older version survives in it.
    const directories = readdirSync(app, {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    const cleared = installDeleteDirectories(script).sort();
    if (JSON.stringify(directories) !== JSON.stringify(cleared)) {
      throw new Error(`installer/apex.iss [InstallDelete] must clear exactly the staged folders ${directories.join(', ')}; it clears ${cleared.join(', ')}`);
    }
    mkdirSync(path.join(root, 'dist'), {recursive: true});
    const output = path.join(root, 'dist', `apex-setup-${version}.exe`);
    rmSync(output, {force: true});
    log(`Compiling ${path.relative(root, ISS)} with ${iscc}: ${files.length} staged files, Pi ${pi.version}`);
    run(iscc, ['/Q', `/DAppVersion=${version}`, `/DStageDir=${app}`, ISS]);
    if (!existsSync(output)) throw new Error(`ISCC succeeded but ${output} is missing`);
    log(output);
    return output;
  } finally {
    rmSync(stage, {recursive: true, force: true});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = parseVersion(process.argv.slice(2));
  if (version instanceof Error) {
    console.error(version.message);
    process.exitCode = 1;
  } else {
    try { buildInstaller(version); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
