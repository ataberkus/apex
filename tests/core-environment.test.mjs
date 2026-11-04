import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {delimiter, join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {directoryLink, fileLink, unixOnly} from './fixtures/filesystem.mjs';

const moduleUrl = new URL('../extensions/apex-core/environment.mjs', import.meta.url);
const bunExecutable = process.execPath;
const liveBuiltins = new URL('../scripts/live-builtins.mjs', import.meta.url);
const load = () => import(moduleUrl).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const safeEnv = extra => ({PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', ...extra});

async function fixture(t) {
  const cwd = await mkdtemp(join(process.cwd(), '.test-environment-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  return cwd;
}

async function put(cwd, path, text = '') {
  await mkdir(join(cwd, path, '..'), {recursive: true});
  await writeFile(join(cwd, path), text);
}

async function api() {
  const loaded = await load();
  assert.equal(typeof loaded.captureEnvironment, 'function', 'bounded environment capture is missing');
  assert.equal(typeof loaded.rankEntryPoints, 'function', 'deterministic entry ranking is missing');
  return loaded;
}

const noTools = async () => { throw Object.assign(new Error('not installed'), {code: 'ENOENT'}); };
const withRg = async command => {
  if (command === 'rg') return {code: 0, stdout: 'ripgrep fixture', stderr: ''};
  return noTools();
};

function child(script, cwd, env = safeEnv()) {
  return new Promise((resolve, reject) => {
    const process = spawn(bunExecutable, ['--preload', fileURLToPath(liveBuiltins), '--input-type=module', '-e', script],
      {cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 4000, killSignal: 'SIGKILL'});
    let stdout = '', stderr = '';
    process.stdout.on('data', value => { stdout += value; });
    process.stderr.on('data', value => { stderr += value; });
    process.on('error', reject);
    process.on('close', code => resolve({code, stdout, stderr}));
  });
}

test('snapshot respects the UTF-8 byte ceiling, including a smaller caller budget', async t => {
  const {captureEnvironment} = await api();
  const cwd = await fixture(t);
  for (let i = 0; i < 25; i++) await put(cwd, `src/${i}-éééééééé.mjs`);
  const full = await captureEnvironment({cwd, task: 'PRIVATE_TASK_MARKER', entrypoints: true,
    maxBytes: 100000, runCommand: noTools});
  assert.ok(Buffer.byteLength(full.text) <= 2400);
  assert.doesNotMatch(full.text, /PRIVATE_TASK_MARKER|\uFFFD/);
  assert.equal(full.details.entryPoints.length, 10);
  const small = await captureEnvironment({cwd, maxBytes: 97, runCommand: noTools});
  assert.ok(Buffer.byteLength(small.text) <= 97);
  assert.doesNotMatch(small.text, /\uFFFD/);
  assert.equal((await captureEnvironment({cwd, maxBytes: 0, runCommand: noTools})).text, '');
});

test('the default byte budget includes all ten byte-heavy entry paths (escaped control names on POSIX)', async t => {
  const {captureEnvironment} = await api();
  const cwd = await fixture(t);
  for (let i = 0; i < 10; i++) await put(cwd, `src/${i}${process.platform === 'win32' ? '漢'.repeat(80) : '\u0001'.repeat(40)}.mjs`);
  const result = await captureEnvironment({cwd, entrypoints: true, runCommand: noTools});
  const section = result.text.split('Entry points (ranked, paths may be abbreviated):\n')[1];
  assert.ok(section, 'entry point section is visible');
  assert.ok(section.includes('\nLocal tools:'), 'all entry points fit before local tool observations');
  const entries = section.split('\nLocal tools:')[0].split('\n');
  assert.equal(entries.length, 10);
  assert.ok(entries.every(line => line.startsWith('"src/')));
  assert.ok(Buffer.byteLength(result.text) <= 2400);
});

test('snapshot obeys ignore rules, avoids dependency trees, stops at depth two and follows no symlinks', async t => {
  const {captureEnvironment} = await api();
  const cwd = await fixture(t);
  const outside = await fixture(t);
  await put(cwd, '.gitignore', 'ignored/\n*.scratch\n!keep.scratch\n');
  await put(cwd, 'src/.gitignore', '*.local\n');
  for (const path of ['ignored/leak.mjs', 'node_modules/dependency.mjs', '.apex/state.json',
    'src/deep/third.mjs', 'src/drop.local', 'drop.scratch', 'keep.scratch', 'src/main.mjs']) {
    await put(cwd, path);
  }
  await put(outside, 'package.json', '{"main":"EXTERNAL_SECRET"}');
  await directoryLink(outside, join(cwd, 'external'));
  await t.test('file symlink manifest is never read', async t => {
    if (!await fileLink(t, join(outside, 'package.json'), join(cwd, 'package.json'))) return;
    const capture = await captureEnvironment({cwd, entrypoints: true, runCommand: noTools});
    assert.ok(!capture.details.files.some(item => item.path === 'package.json'));
    assert.doesNotMatch(capture.text, /EXTERNAL_SECRET/);
  });
  const result = await captureEnvironment({cwd, entrypoints: true, runCommand: noTools});
  const paths = result.details.files.map(item => item.path);
  assert.ok(paths.includes('src/main.mjs'));
  assert.ok(paths.includes('keep.scratch'));
  assert.ok(!paths.some(path => /ignored|node_modules|third|drop|external|package\.json|\.apex/.test(path)));
  assert.doesNotMatch(result.text, /EXTERNAL_SECRET|dependency\.mjs/);
});

test('manifest discovery reports scripts and entry paths without executing scripts or reading source', async t => {
  const {captureEnvironment} = await api();
  const cwd = await fixture(t);
  await put(cwd, 'package.json', JSON.stringify({name: 'local-app', main: './src/main.mjs',
    scripts: {test: `touch ${join(cwd, 'SCRIPT_EXECUTED')}`, install: 'curl https://example.com'},
    bin: {local: './cli.mjs'}}));
  await put(cwd, 'src/main.mjs', 'throw new Error("SOURCE_MUST_NOT_BE_READ");');
  await put(cwd, 'cli.mjs', 'console.log("CLI_MUST_NOT_EXECUTE");');
  const result = await captureEnvironment({cwd, entrypoints: true, runCommand: noTools});
  assert.deepEqual(result.details.manifests[0].scripts, ['install', 'test']);
  assert.ok(result.details.entryPoints.some(item => item.path === 'src/main.mjs'));
  assert.ok(result.details.entryPoints.some(item => item.path === 'cli.mjs'));
  await assert.rejects(readFile(join(cwd, 'SCRIPT_EXECUTED')), {code: 'ENOENT'});
  assert.doesNotMatch(result.text, /SOURCE_MUST_NOT_BE_READ|CLI_MUST_NOT_EXECUTE|touch |curl https/);
});

test('snapshot explicitly reports distro, shell and current user through safe local sources', async t => {
  const cwd = await fixture(t);
  const script = `const {captureEnvironment} = await import(${JSON.stringify(moduleUrl.href)});\n` +
    `console.log(JSON.stringify(await captureEnvironment({cwd: ${JSON.stringify(cwd)}, runCommand: async () => ({code: 1})})));`;
  const shell = process.platform === 'win32' ? {ComSpec: 'C:\\fixture-shell.exe'} : {SHELL: '/bin/fixture-shell'};
  const result = await child(script, cwd, safeEnv(shell));
  assert.equal(result.code, 0, result.stderr);
  const capture = JSON.parse(result.stdout);
  assert.ok(capture.details.shell && capture.details.distro && capture.details.user, 'safe identity fields are missing');
  assert.equal(capture.details.shell.path, shell.ComSpec ?? shell.SHELL);
  assert.equal(capture.details.shell.source, 'environment');
  assert.ok(['available', 'unavailable'].includes(capture.details.distro.status));
  assert.ok(capture.details.distro.name.length > 0);
  assert.ok(['available', 'unavailable'].includes(capture.details.user.status));
  assert.match(capture.text, /Distro:/);
  assert.match(capture.text, /Shell:.*fixture-shell/);
  assert.match(capture.text, /User:/);
  assert.ok(Buffer.byteLength(capture.text) <= 2400);
});

test('an unavailable OS user lookup is labeled without failing environment capture', async t => {
  const cwd = await fixture(t);
  const script = `const os = await import('node:os'); os.default.userInfo = () => { throw new Error('unavailable'); };\n` +
    `const {captureEnvironment} = await import(${JSON.stringify(moduleUrl.href)});\n` +
    `console.log(JSON.stringify(await captureEnvironment({cwd: ${JSON.stringify(cwd)}, runCommand: async () => ({code: 1})})));`;
  const result = await child(script, cwd);
  assert.equal(result.code, 0, result.stderr);
  const capture = JSON.parse(result.stdout);
  assert.ok(capture.details.user, 'best-effort user observation is missing');
  assert.equal(capture.details.user.status, 'unavailable');
  assert.match(capture.text, /User: unavailable/);
});

test('package manager versions and static declarations are reported without npm or install operations', async t => {
  const {captureEnvironment} = await api();
  const cwd = await fixture(t);
  await put(cwd, 'package.json', '{"packageManager":"pnpm@9.0.0"}');
  await put(cwd, 'package-lock.json', '{}');
  await put(cwd, 'uv.lock', '# local lockfile');
  const calls = [];
  const runCommand = async (command, args, options) => {
    calls.push({command, args, options});
    if (command === 'pip3') return {code: 0, stdout: 'pip 24.0', stderr: ''};
    if (command === 'uv') return {code: 0, stdout: 'uv 0.4.0', stderr: ''};
    return noTools();
  };
  const result = await captureEnvironment({cwd, runCommand});
  assert.ok(result.details.packageManagers, 'package manager observations are missing');
  assert.equal(result.details.packageManagers.pip.status, 'available');
  assert.equal(result.details.packageManagers.uv.status, 'available');
  assert.equal(result.details.packageManagers.pnpm.declaredVersion, '9.0.0');
  assert.ok(result.details.packageManagers.npm.hints.includes('package-lock.json'));
  assert.ok(result.details.packageManagers.uv.hints.includes('uv.lock'));
  assert.ok(calls.filter(call => ['pip3', 'uv'].includes(call.command)).every(call =>
    call.args.length === 1 && call.args[0] === '--version' && !call.options.networkAllowed));
  assert.ok(!calls.some(call => ['npm', 'pnpm', 'yarn', 'corepack'].includes(call.command)));
  assert.match(result.text, /Package managers:.*pip.*24\.0.*uv.*0\.4\.0.*pnpm/);
});

test('Makefile targets and pyproject build/test tools become static hints without running recipes', async t => {
  const {captureEnvironment, rankEntryPoints} = await api();
  const cwd = await fixture(t);
  await put(cwd, 'Makefile', `DANGER := $(shell touch ${join(cwd, 'MAKE_EXECUTED')})\n.PHONY: build test\nbuild:\n\ttouch ${join(cwd, 'MAKE_EXECUTED')}\ntest check:\n\ttouch ${join(cwd, 'MAKE_EXECUTED')}\n`);
  await put(cwd, 'pyproject.toml', '[build-system]\nrequires = ["setuptools"]\nbuild-backend = "setuptools.build_meta"\n[tool.pytest.ini_options]\n[tool.ruff]\n[tool.poetry]\n');
  await put(cwd, 'tests/Makefile', 'SECRET_TARGET:\n\techo VERIFIER_RECIPE\n');
  const result = await captureEnvironment({cwd, entrypoints: true, runCommand: noTools});
  const make = result.details.manifests.find(manifest => manifest.path === 'Makefile');
  const python = result.details.manifests.find(manifest => manifest.path === 'pyproject.toml');
  assert.ok(make && python, 'static Makefile/pyproject hints are missing');
  assert.deepEqual(make.targets, ['build', 'check', 'test']);
  assert.deepEqual(python.tools, ['poetry', 'pytest', 'ruff']);
  assert.equal(python.buildBackend, 'setuptools.build_meta');
  assert.ok(!result.details.manifests.some(manifest => manifest.path === 'tests/Makefile'));
  assert.match(result.text, /Build\/test hints:.*Makefile.*build.*test.*pyproject.*pytest/);
  assert.doesNotMatch(result.text, /MAKE_EXECUTED|SECRET_TARGET|VERIFIER_RECIPE|\$\(shell/);
  const entries = await rankEntryPoints({cwd, task: 'Find build and test entry points', runCommand: noTools});
  assert.match(entries.find(entry => entry.path === 'Makefile').reason, /build\/test targets/);
  assert.match(entries.find(entry => entry.path === 'pyproject.toml').reason, /build\/test tools/);
  await assert.rejects(readFile(join(cwd, 'MAKE_EXECUTED')), {code: 'ENOENT'});
});

test('entry ranking is deterministic and promotes an explicitly relevant source path', async t => {
  const {rankEntryPoints} = await api();
  const cwd = await fixture(t);
  await put(cwd, 'package.json', '{"main":"src/main.mjs"}');
  for (const path of ['src/main.mjs', 'src/billing.mjs', 'src/search.mjs', 'README.md', 'cli.mjs']) {
    await put(cwd, path);
  }
  const first = await rankEntryPoints({cwd, task: 'Fix billing handling', limit: 3, runCommand: noTools});
  const second = await rankEntryPoints({cwd, task: 'Fix billing handling', limit: 3, runCommand: noTools});
  assert.deepEqual(first, second);
  assert.equal(first.length, 3);
  assert.equal(first[0].path, 'src/billing.mjs');
  assert.ok(first[0].score > first[1].score);
  assert.ok(first.every(item => typeof item.reason === 'string' && item.reason.length > 0));
  assert.deepEqual(await rankEntryPoints({cwd, task: 'billing', limit: 0, runCommand: noTools}), []);
});

test('entry discovery promotes a nested source identifier and declared symbol over a filename match', async t => {
  const {captureEnvironment, rankEntryPoints} = await api();
  const cwd = await fixture(t);
  await put(cwd, 'src/reconcileInvoice.mjs', 'export function unrelated() {}');
  await put(cwd, 'src/orders/ledger.mjs', 'export function reconcileInvoice(invoice) { return invoice; }');
  const entries = await rankEntryPoints({cwd, task: 'Fix reconcileInvoice', runCommand: withRg});
  assert.equal(entries[0].path, 'src/orders/ledger.mjs');
  assert.match(entries[0].reason, /content identifier/);
  assert.match(entries[0].reason, /declared symbol/);
  const snapshot = await captureEnvironment({cwd, task: 'Fix reconcileInvoice', entrypoints: true, runCommand: withRg});
  assert.equal(snapshot.details.entryPoints[0].path, 'src/orders/ledger.mjs');
  assert.ok(!snapshot.details.files.some(file => file.path === 'src/orders/ledger.mjs'));
  assert.doesNotMatch(snapshot.text, /return invoice|export function/);
});

test('missing ripgrep keeps metadata ranking and explicitly reports the content fallback', async t => {
  const {captureEnvironment, rankEntryPoints} = await api();
  const cwd = await fixture(t);
  await put(cwd, 'src/main.mjs', 'export function unrelated() {}');
  await put(cwd, 'src/orders/ledger.mjs', 'export function reconcileInvoice() {}');
  const entries = await rankEntryPoints({cwd, task: 'Fix reconcileInvoice', runCommand: noTools});
  assert.equal(entries[0].path, 'src/main.mjs');
  assert.ok(entries.every(entry => /metadata only.*rg unavailable/.test(entry.reason)));
  const snapshot = await captureEnvironment({cwd, task: 'Fix reconcileInvoice', entrypoints: true, runCommand: noTools});
  assert.equal(snapshot.details.entryPointDiscovery.status, 'metadata-only');
  assert.deepEqual(snapshot.details.entryPointDiscovery.sourceFiles, []);
});

test('entry source reads exclude generic tests and verifiers and enforce byte/file bounds', async t => {
  const {captureEnvironment} = await api();
  const cwd = await fixture(t);
  await put(cwd, 'src/main.mjs', 'export function unrelated() {}');
  await put(cwd, 'src/00-large.mjs', `${' '.repeat(65536)}export function hiddenIdentifier() {}`);
  for (let i = 1; i < 23; i++) await put(cwd, `src/${String(i).padStart(2, '0')}.mjs`,
    i === 22 ? 'export function hiddenIdentifier() {}' : 'export function unrelated() {}');
  await put(cwd, 'src/check.test.mjs', 'export function hiddenIdentifier() {}');
  await put(cwd, 'src/verifier.mjs', 'export function hiddenIdentifier() {}');
  await put(cwd, 'tests/hiddenIdentifier.mjs', 'export function hiddenIdentifier() {}');
  const result = await captureEnvironment({cwd, task: 'Find hiddenIdentifier', entrypoints: true, runCommand: withRg});
  assert.ok(result.details.entryPointDiscovery.sourceFiles.length <= 20);
  assert.ok(!result.details.entryPointDiscovery.sourceFiles.some(path => /test|verifier|22\.mjs/.test(path)));
  assert.ok(result.details.entryPoints.every(entry => !/content identifier|declared symbol/.test(entry.reason)));
  assert.equal(result.details.entryPoints[0].path, 'src/main.mjs');
});

test('a manifest cannot promote an entry target that escapes the project', async t => {
  const {rankEntryPoints} = await api();
  const cwd = await fixture(t);
  await put(cwd, 'package.json', '{"main":"../escape.mjs"}');
  await put(cwd, 'escape.mjs');
  const entries = await rankEntryPoints({cwd, task: '', runCommand: noTools});
  assert.doesNotMatch(entries.find(entry => entry.path === 'escape.mjs').reason, /manifest entry/);
});

test('gitignore character classes and anchored recursive patterns filter the snapshot', async t => {
  const {captureEnvironment} = await api();
  const cwd = await fixture(t);
  await put(cwd, '.gitignore', 'src/[ab].mjs\n/docs/**\n');
  for (const path of ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'docs/guide.md', 'other/docs.mjs']) {
    await put(cwd, path);
  }
  const result = await captureEnvironment({cwd, runCommand: noTools});
  const paths = result.details.files.map(file => file.path);
  assert.ok(!paths.includes('src/a.mjs'));
  assert.ok(!paths.includes('src/b.mjs'));
  assert.ok(!paths.includes('docs/guide.md'));
  assert.ok(paths.includes('src/c.mjs'));
  assert.ok(paths.includes('other/docs.mjs'));
});

test('untrusted ignore patterns cannot throw or stall snapshot discovery', async t => {
  const cwd = await fixture(t);
  await put(cwd, '.gitignore', `[z-a].mjs\n${'*a'.repeat(30)}b\n`);
  await put(cwd, `${'a'.repeat(70)}.mjs`);
  const script = `const {captureEnvironment} = await import(${JSON.stringify(moduleUrl.href)});\n` +
    `const result = await captureEnvironment({cwd: ${JSON.stringify(cwd)}, runCommand: async () => ({code: 1})}); console.log(result.details.files.length);`;
  const result = await child(script, cwd);
  assert.equal(result.code, 0, result.stderr || 'ignore matching exceeded its bounded local work');
  assert.equal(result.stdout.trim(), '1');
});

test('missing tools and a missing project are labeled unavailable without failing capture', async t => {
  const {captureEnvironment} = await api();
  const cwd = await fixture(t);
  const result = await captureEnvironment({cwd: join(cwd, 'missing'), runCommand: noTools});
  assert.equal(result.details.project.status, 'unavailable');
  assert.ok(Object.values(result.details.tools).every(tool => tool.status === 'unavailable'));
  assert.match(result.text, /unavailable/i);
  assert.equal(result.details.network.status, 'skipped');
});

test('external reachability stays skipped by default and requires a literal true authorization', async t => {
  const {captureEnvironment} = await api();
  const cwd = await fixture(t);
  const called = [];
  const runCommand = async (command, args, options) => {
    called.push({command, args, options});
    return {code: 0, stdout: 'fixture version', stderr: ''};
  };
  const first = await captureEnvironment({cwd, runCommand});
  const second = await captureEnvironment({cwd, networkAllowed: 'true', runCommand});
  assert.equal(first.details.network.status, 'skipped');
  assert.equal(second.details.network.status, 'skipped');
  assert.match(first.text, /external.*skipped/i);
  assert.ok(!called.some(call => call.command === 'curl' || call.args.some(arg => /^https?:/.test(arg))));
  assert.ok(called.every(call => call.options.networkAllowed === false));
});

test('an explicitly authorized reachability probe is capped at two seconds without real network calls', async t => {
  const {captureEnvironment} = await api();
  const cwd = await fixture(t);
  let external;
  const runCommand = async (command, args, options) => {
    if (options.networkAllowed) external = {command, args, options};
    return {exitCode: 0, stdout: 'HTTP/2 200\n', stderr: ''};
  };
  const result = await captureEnvironment({cwd, networkAllowed: true, runCommand});
  assert.equal(result.details.network.status, 'available');
  assert.equal(external.options.timeoutMs, 2000);
  assert.ok(external.options.maxOutputBytes <= 2048);
  assert.equal(external.command, 'curl');
  assert.ok(external.args.some(arg => arg === 'https://example.com'));
});

test('native probes terminate hanging binaries, cap flood output and inherit no secret environment', {skip: unixOnly}, async t => {
  const {captureEnvironment} = await api();
  const cwd = await fixture(t);
  const bin = await fixture(t);
  await writeFile(join(bin, 'git'), `#!${bunExecutable}\nprocess.stdout.write('é'.repeat(20000)); setInterval(() => {}, 1000);\n`, {mode: 0o700});
  await writeFile(join(bin, 'python3'), `#!${bunExecutable}\nsetInterval(() => {}, 1000);\n`, {mode: 0o700});
  await writeFile(join(bin, 'node'), `#!${bunExecutable}\nprocess.stdout.write(process.env.TEST_SECRET ? 'LEAKED' : 'safe-node');\n`, {mode: 0o700});
  const script = `const {captureEnvironment} = await import(${JSON.stringify(moduleUrl.href)});\n` +
    `console.log(JSON.stringify(await captureEnvironment({cwd: ${JSON.stringify(cwd)}})));`;
  const start = performance.now();
  const result = await child(script, cwd, safeEnv({PATH: bin, TEST_SECRET: 'must-not-inherit'}));
  assert.equal(result.code, 0, result.stderr);
  const captured = JSON.parse(result.stdout);
  assert.equal(captured.details.tools.python3.timedOut, true);
  assert.equal(captured.details.tools.git.truncated, true);
  assert.equal(captured.details.tools.node.stdout, 'safe-node');
  assert.ok(Object.values(captured.details.tools).every(tool =>
    Buffer.byteLength(tool.stdout ?? '') + Buffer.byteLength(tool.stderr ?? '') <= 2048));
  assert.doesNotMatch(captured.text, /LEAKED|\uFFFD/);
  assert.ok(performance.now() - start < 6000, 'local probes must finish promptly');
});

test('native probes preserve UTF-8 characters split across output chunks', {skip: unixOnly}, async t => {
  const cwd = await fixture(t);
  const bin = await fixture(t);
  await writeFile(join(bin, 'python3'), `#!${bunExecutable}\nconst b = Buffer.from('🙂'); process.stdout.write(b.subarray(0, 2)); setTimeout(() => process.stdout.write(b.subarray(2)), 15);\n`, {mode: 0o700});
  const script = `const {captureEnvironment} = await import(${JSON.stringify(moduleUrl.href)});\n` +
    `console.log(JSON.stringify((await captureEnvironment({cwd: ${JSON.stringify(cwd)}})).details.tools.python3));`;
  const result = await child(script, cwd, safeEnv({PATH: bin}));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).stdout, '🙂');
});

test('native tool lookup excludes PATH directories inside the project', async t => {
  const cwd = await fixture(t);
  const bin = join(cwd, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'git'), `#!${bunExecutable}\nimport('node:fs').then(fs => fs.writeFileSync('PROJECT_SCRIPT_EXECUTED', 'bad'));\n`, {mode: 0o700});
  const script = `const {captureEnvironment} = await import(${JSON.stringify(moduleUrl.href)});\n` +
    `console.log(JSON.stringify((await captureEnvironment({cwd: ${JSON.stringify(cwd)}})).details.tools.git));`;
  const result = await child(script, cwd, safeEnv({PATH: bin}));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'unavailable');
  await assert.rejects(readFile(join(cwd, 'PROJECT_SCRIPT_EXECUTED')), {code: 'ENOENT'});
});

test('an injected command that ignores cancellation is still bounded by the probe deadline', async t => {
  const {captureEnvironment} = await api();
  const cwd = await fixture(t);
  const start = performance.now();
  const result = await captureEnvironment({cwd, runCommand: async () => new Promise(() => {})});
  assert.ok(performance.now() - start < 4000);
  assert.ok(Object.values(result.details.tools).every(tool => tool.timedOut));
});

test('import creates no processes or files and returns promptly', async t => {
  await api();
  const cwd = await fixture(t);
  const bin = join(cwd, 'fixture-bin');
  await mkdir(bin);
  await writeFile(join(bin, 'git'), `#!${bunExecutable}\nawait import('node:fs/promises').then(fs => fs.writeFile('IMPORT_SIDE_EFFECT', 'bad'));\n`, {mode: 0o700});
  const result = await child(`await import(${JSON.stringify(moduleUrl.href)}); console.log('imported');`, cwd,
    safeEnv({PATH: bin}));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'imported');
  await assert.rejects(readFile(join(cwd, 'IMPORT_SIDE_EFFECT')), {code: 'ENOENT'});
});

test('a session probe cache reuses available version probes and probes everything else again', async t => {
  const {captureEnvironment} = await api();
  const cwd = await fixture(t);
  await put(cwd, 'package.json', '{"name":"cached","scripts":{"test":"node --test"}}');
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'fd') return {code: 1, stdout: '', stderr: 'fd: broken'};
    if (command === 'go') throw Object.assign(new Error('not installed'), {code: 'ENOENT'});
    return {code: 0, stdout: `${command} fixture 1.0\nsecond line`, stderr: ''};
  };
  const stable = details => ({...details, resources: {...details.resources, freeMemoryBytes: 0}});
  const probeCache = new Map();
  const first = await captureEnvironment({cwd, task: 'fix', entrypoints: true, runCommand, probeCache});
  assert.equal(calls.length, 14);
  const uncached = await captureEnvironment({cwd, task: 'fix', entrypoints: true, runCommand});
  assert.equal(uncached.text, first.text);
  assert.deepEqual(stable(uncached.details), stable(first.details));
  calls.length = 0;
  const second = await captureEnvironment({cwd, task: 'fix', entrypoints: true, runCommand, probeCache});
  // Repository status, listening services and disk are live observations; unavailable tools may have been installed since.
  assert.deepEqual(calls.map(call => call.split(' ')[0]).sort(), ['df', 'fd', 'git', 'go', 'ss']);
  assert.match(calls.find(call => call.startsWith('git ')), / status /);
  assert.equal(second.text, first.text);
  assert.deepEqual(stable(second.details), stable(first.details));
  second.details.tools.node.stdout = 'tampered';
  second.details.packageManagers.pip.stdout = 'tampered';
  const third = await captureEnvironment({cwd, runCommand, probeCache});
  assert.equal(third.details.tools.node.stdout, 'node fixture 1.0\nsecond line');
  assert.equal(third.details.packageManagers.pip.stdout, 'pip3 fixture 1.0\nsecond line');
  calls.length = 0;
  const shared = new Map();
  const [left, right] = await Promise.all([captureEnvironment({cwd, runCommand, probeCache: shared}),
    captureEnvironment({cwd, runCommand, probeCache: shared})]);
  assert.equal(left.text, right.text);
  for (const command of ['node', 'python3', 'rustc', 'pip3', 'uv', 'fd', 'go']) assert.equal(calls.filter(call => call.startsWith(`${command} `)).length, 1, command);
  // The key holds the project root and the filtered PATH, so per-directory shims and PATH changes are probed afresh.
  calls.length = 0;
  const other = await fixture(t);
  await captureEnvironment({cwd: other, runCommand, probeCache});
  assert.equal(calls.length, 14);
  const original = process.env.PATH;
  try {
    process.env.PATH = `${original}${delimiter}/apex-probe-cache-test-path`;
    calls.length = 0;
    await captureEnvironment({cwd, runCommand, probeCache});
    assert.equal(calls.length, 14);
  } finally { process.env.PATH = original; }
});

test('a timed-out version probe is not cached and is probed again by the next capture', async t => {
  const {captureEnvironment} = await api();
  const cwd = await fixture(t);
  let rustc = 0;
  const runCommand = async command => {
    if (command === 'rustc' && ++rustc === 1) return new Promise(() => {});
    return {code: 0, stdout: `${command} fixture`, stderr: ''};
  };
  const probeCache = new Map();
  assert.equal((await captureEnvironment({cwd, runCommand, probeCache})).details.tools.rustc.status, 'timed-out');
  assert.equal((await captureEnvironment({cwd, runCommand, probeCache})).details.tools.rustc.status, 'available');
  await captureEnvironment({cwd, runCommand, probeCache});
  assert.equal(rustc, 2);
});
