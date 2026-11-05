import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {findIscc, ISS, parseVersion} from '../scripts/build-installer.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = readFileSync(ISS, 'utf8');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const fromInstaller = file => path.resolve(path.dirname(ISS), file.replaceAll('\\', '/'));

/** Entry lines of one [Section], without comments; "Key: value; ..." entries become objects. */
function entries(name) {
  const lines = [];
  let current;
  for (const line of script.split(/\r?\n/)) {
    const header = line.match(/^\[(\w+)\]\s*$/);
    if (header) { current = header[1]; continue; }
    if (current === name && line.trim() && !line.startsWith(';') && !line.startsWith('#')) lines.push(line.trim());
  }
  return lines;
}
const parameters = line => Object.fromEntries([...line.matchAll(/(\w+):\s*("(?:[^"]|"")*"|[^;]*)/g)]
  .map(([, key, value]) => [key, value.trim().replace(/^"|"$/g, '').replaceAll('""', '"')]));
const setup = Object.fromEntries(entries('Setup').map(line => line.split(/=(.*)/s).slice(0, 2).map(part => part.trim())));

// The package's own file list decides what the staged tarball holds (scripts/build-installer.mjs packs it).
function packaged(relative) {
  return manifest.files.some(entry => existsSync(path.join(root, entry)) && statSync(path.join(root, entry)).isDirectory()
    ? relative.startsWith(`${entry}/`) : new Bun.Glob(entry).match(relative));
}

test('every file the installer compiles in exists in the repository', () => {
  for (const line of entries('Files')) {
    const {Source} = parameters(line);
    if (Source.startsWith('{#StageDir}')) continue;
    assert.ok(existsSync(fromInstaller(Source)) && statSync(fromInstaller(Source)).isFile(), `[Files] Source ${Source} is missing`);
  }
  for (const [key, value] of Object.entries(setup)) {
    if (/File$/.test(key)) assert.ok(existsSync(fromInstaller(value)), `[Setup] ${key}=${value} is missing`);
  }
});

test('every installed file a shortcut starts is shipped, from an existing repository file', () => {
  const explicit = new Map(entries('Files').map(parameters).filter(({Source}) => !Source.startsWith('{#'))
    .map(({Source, DestDir}) => [`${DestDir}\\${path.win32.basename(Source)}`.toLowerCase(), fromInstaller(Source)]));
  const builder = readFileSync(path.join(root, 'scripts', 'build-installer.mjs'), 'utf8');
  for (const line of [...entries('Icons'), ...entries('Run')]) {
    const {Filename, Parameters = '', IconFilename = ''} = parameters(line);
    // Files under {app} the entry starts or shows: its program, a quoted script argument and its icon.
    const started = [Filename, ...[...Parameters.matchAll(/"(\{app\}\\[^"]+)"/g)].map(match => match[1]), IconFilename];
    for (const file of started.filter(file => file.startsWith('{app}\\'))) {
      const relative = file.slice('{app}\\'.length).replaceAll('\\', '/');
      const dependency = relative.match(/^node_modules\/([^/]+)\//)?.[1];
      if (dependency) {
        // Not in the package: the build installs it from bun.lock and runs its install script for the binary.
        assert.ok(manifest.dependencies?.[dependency] || manifest.devDependencies?.[dependency], `${file} needs ${dependency} in package.json`);
        assert.ok(builder.includes(`'node_modules', '${dependency}', 'install.js'`), `${file}: scripts/build-installer.mjs must run ${dependency}'s install script`);
        continue;
      }
      const source = explicit.get(file.toLowerCase()) ?? (packaged(relative) ? path.join(root, relative) : null);
      assert.ok(source, `${file} is neither a [Files] entry nor in package.json "files"`);
      assert.ok(existsSync(source), `${file} would come from ${source}, which is missing`);
    }
  }
});

test('the desktop shortcuts share the AppUserModelID the desktop app sets, and an update relaunches it', () => {
  const main = readFileSync(path.join(root, 'desktop', 'main.mjs'), 'utf8');
  const id = main.match(/const APP_ID = '([^']+)'/)?.[1];
  const desktop = entries('Icons').map(parameters).filter(({Filename}) => Filename.endsWith('\\electron.exe'));
  assert.equal(desktop.length, 2);
  for (const icon of desktop) assert.equal(icon.AppUserModelID, id);
  assert.match(main, /runInstaller\(file, \{args: \['\/RELAUNCH=1'\]\}\)/);
  assert.ok(entries('Run').map(parameters).some(({Check, Flags}) => Check === 'RelaunchRequested' && !/postinstall/.test(Flags)));
  assert.match(script, /\{param:relaunch\|0\}'\) = '1'/);
});

test('the installer version comes from the build, never from the script', () => {
  assert.doesNotMatch(script, /^\s*#define\s+AppVersion\b/m);
  assert.match(script, /^#ifndef AppVersion\r?\n\s*#error /m);
  for (const key of ['AppVersion', 'AppVerName', 'VersionInfoVersion', 'OutputBaseFilename']) {
    assert.match(setup[key], /\{#AppVersion\}/, `${key} must use the passed version`);
    assert.doesNotMatch(setup[key].replace('{#AppVersion}', ''), /\d+\.\d+/, `${key} hard-codes a version`);
  }
  assert.equal(parseVersion(['1.20.3']), '1.20.3');
  for (const args of [[], ['v1.2.3'], ['1.2'], ['1.2.3', 'extra'], ['01.2.3'], ['1.2.65536']]) {
    assert.ok(parseVersion(args) instanceof Error, `accepted ${JSON.stringify(args)}`);
  }
  const child = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-installer.mjs')], {cwd: root, encoding: 'utf8', timeout: 30000});
  assert.equal(child.status, 1);
  assert.match(child.stderr, /^Usage: bun scripts\/build-installer\.mjs <version>/);
});

const iscc = process.platform === 'win32' ? findIscc() : null;
test('Inno Setup refuses to compile the script without a version', {skip: !iscc && 'Requires ISCC.exe (Inno Setup 6)'}, t => {
  const stage = mkdtempSync(path.join(os.tmpdir(), 'apex installer stage '));
  t.after(() => rmSync(stage, {recursive: true, force: true}));
  const child = spawnSync(iscc, ['/Q', `/DStageDir=${stage}`, `/O${stage}`, ISS], {encoding: 'utf8', timeout: 60000});
  assert.equal(child.status, 2, child.stdout);
  assert.match(`${child.stdout}${child.stderr}`, /Pass the release version/);
});
