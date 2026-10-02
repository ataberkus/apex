import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {directoryLink, fileLink, unixOnly} from './fixtures/filesystem.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const skills = join(root, 'skills');
const domains = ['debugging', 'test-writing', 'profiling', 'build-systems', 'python-packaging', 'numerics', 'http', 'databases', 'git-surgery', 'security-hardening'];
const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'CODEX_PRIMARY_RUNTIME_NODE'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
env.PI_OFFLINE = '1';
env.npm_config_offline = 'true';
env.npm_config_registry = 'http://127.0.0.1:9';

async function fixture(files = {}) {
  await mkdir(join(root, '.cache'), { recursive: true });
  const cwd = await mkdtemp(join(root, '.cache', 'phase3-skills-fixture-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(cwd, path, '..'), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
  return cwd;
}

function probe(domain, args) {
  const script = join(skills, domain, 'scripts', 'probe.mjs');
  const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 });
  assert.equal(result.error, undefined, `${domain}: ${result.error?.code}`);
  assert.ok(Buffer.byteLength(result.stdout) <= 16 * 1024, `${domain} output exceeds its bound`);
  assert.equal(result.stderr, '', `${domain}: unexpected stderr`);
  let json;
  assert.doesNotThrow(() => { json = JSON.parse(result.stdout); }, `${domain} must emit one JSON object`);
  return { status: result.status, json, raw: result.stdout };
}

async function snapshot(cwd) {
  const entries = [];
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const stat = await lstat(path);
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile()) entries.push([path.slice(cwd.length + 1), createHash('sha256').update(await readFile(path)).digest('hex'), stat.mode]);
      else entries.push([path.slice(cwd.length + 1), 'non-file']);
    }
  }
  await walk(cwd);
  return entries;
}

const cases = [
  ['debugging', { 'src/crash.mjs': 'try { throw new Error("bad"); } catch (error) { console.error(error); }\n' }, facts => { assert.ok(facts.diagnosticSites >= 1); assert.ok(facts.errorHandlingSites >= 1); }],
  ['test-writing', { 'test/sample.test.mjs': 'import test from "node:test"; import assert from "node:assert/strict"; test("x", () => assert.equal(1, 1));\n' }, facts => { assert.equal(facts.testFiles, 1); assert.ok(facts.frameworks.includes('node:test')); assert.ok(facts.assertionSites >= 1); }],
  ['profiling', { 'bench/timer.mjs': 'const start = performance.now(); console.log(process.hrtime.bigint());\n' }, facts => { assert.ok(facts.timingSites >= 2); assert.equal(facts.benchmarkFiles, 1); assert.match(facts.runtime.node, /^\d+\./); }],
  ['build-systems', { 'package.json': '{"scripts":{"build":"node build.mjs"}}', Makefile: 'all:\n\t@true\n', 'package-lock.json': '{"lockfileVersion":3}' }, facts => { assert.deepEqual(facts.manifests, ['Makefile', 'package.json']); assert.ok(facts.packageManagers.includes('npm')); assert.equal(facts.buildScriptDeclared, true); }],
  ['python-packaging', { 'pyproject.toml': '[build-system]\nrequires = ["setuptools"]\n[project]\nname = "fixture"\n', 'requirements.txt': 'numpy==1.0\n' }, facts => { assert.equal(facts.pyproject, true); assert.equal(facts.buildSystemTable, true); assert.equal(facts.projectTable, true); assert.equal(facts.requirementsFiles, 1); }],
  ['numerics', { 'fit.py': 'import numpy as np\nsolution = np.linalg.lstsq(a, b, rcond=None)\nrng = np.random.default_rng(7)\n' }, facts => { assert.ok(facts.libraries.includes('numpy')); assert.ok(facts.fittingSites >= 1); assert.ok(facts.randomSites >= 1); }],
  ['http', { 'server.mjs': 'import { createServer } from "node:http"; const server = createServer(() => {}); const timer = AbortSignal.timeout(500);\n' }, facts => { assert.ok(facts.frameworks.includes('node:http')); assert.ok(facts.serverSites >= 1); assert.ok(facts.timeoutSites >= 1); }],
  ['databases', { 'migrations/001.sql': 'CREATE TABLE widget (id INTEGER PRIMARY KEY); BEGIN; COMMIT;\n', 'query.py': 'cursor.execute("SELECT * FROM widget WHERE id = ?", (id,))\n' }, facts => { assert.equal(facts.migrationFiles, 1); assert.equal(facts.schemaSites, 1); assert.ok(facts.transactionSites >= 2); assert.ok(facts.querySites >= 1); assert.ok(facts.placeholderSites >= 1); }],
  ['git-surgery', { '.git/HEAD': 'ref: refs/heads/fixture\n', '.git/index': 'synthetic-index', '.git/config': '[remote "origin"]\nurl = https://SECRET_CANARY@invalid/\n', '.gitignore': 'build/\n', 'conflict.mjs': '<<<<<<< HEAD\nexport const x = 1;\n=======\nexport const x = 2;\n>>>>>>> topic\n' }, facts => { assert.equal(facts.repositoryMarker, 'directory'); assert.equal(facts.headMode, 'symbolic'); assert.equal(facts.indexPresent, true); assert.equal(facts.ignoreFilePresent, true); assert.equal(facts.conflictMarkerSites, 3); }],
  ['security-hardening', { 'security.mjs': 'import { timingSafeEqual, randomBytes } from "node:crypto"; randomBytes(32); timingSafeEqual(a, b); eval(input);\n', 'package.json': '{"dependencies":{"helmet":"1","bcrypt":"1"}}' }, facts => { assert.ok(facts.controlLibraries.includes('helmet')); assert.ok(facts.cryptoSites >= 2); assert.ok(facts.dynamicExecutionSites >= 1); }],
];

for (const [domain, files, check] of cases) test(`${domain} executes a real offline probe and returns its domain evidence`, async () => {
  const cwd = await fixture(files);
  try {
    const before = await snapshot(cwd);
    const { status, json, raw } = probe(domain, ['--cwd', cwd]);
    assert.equal(status, 0);
    assert.equal(json.schema, 1);
    assert.equal(json.domain, domain);
    assert.equal(json.mode, 'static-offline');
    assert.equal(json.ok, true);
    assert.ok(json.scan.filesRead >= 1);
    check(json.facts);
    assert.equal(raw.includes('SECRET_CANARY'), false);
    assert.deepEqual(await snapshot(cwd), before, `${domain} mutated its fixture`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('probes reject malformed arguments and missing roots with bounded JSON', () => {
  for (const args of [[], ['--cwd'], ['--cwd', root, '--unknown'], ['--cwd', root, '--cwd', root]]) {
    const { status, json } = probe('debugging', args);
    assert.equal(status, 1);
    assert.equal(json.ok, false);
    assert.equal(json.error, 'invalid-arguments');
  }
  assert.equal(probe('debugging', ['--cwd', join(root, '.cache', 'phase3-skills-missing')]).json.error, 'unreadable-root');
});

test('probes refuse root symlinks and do not follow child symlinks or private files', async t => {
  const outside = await fixture({ 'outside.mjs': 'console.error("SECRET_CANARY");\n' });
  const cwd = await fixture({ '.env': 'SECRET_CANARY', 'credentials.json': '{"key":"SECRET_CANARY"}', 'src/safe.mjs': 'export const x = 1;\n' });
  const link = `${cwd}-link`;
  try {
    await directoryLink(outside, join(cwd, 'linked'));
    await t.test('file link source excluded', async t => {
      if (!await fileLink(t, join(outside, 'outside.mjs'), join(cwd, 'source.mjs'))) return;
      for (const domain of domains) {
        const result = probe(domain, ['--cwd', cwd]);
        assert.equal(result.json.scan.filesRead, 1);
        assert.ok(result.json.scan.skipped.symlinks >= 2);
        assert.equal(result.raw.includes('SECRET_CANARY'), false);
      }
    });
    await directoryLink(cwd, link);
    assert.equal(probe('debugging', ['--cwd', link]).json.error, 'unsafe-root');
    for (const domain of domains) {
      const { status, json, raw } = probe(domain, ['--cwd', cwd]);
      assert.equal(status, 0);
      assert.equal(json.scan.filesRead, 1);
      assert.ok(json.scan.skipped.symlinks >= 1);
      assert.ok(json.scan.skipped.private >= 2);
      assert.equal(raw.includes('SECRET_CANARY'), false);
      if (domain === 'debugging') assert.equal(json.facts.diagnosticSites, 0);
    }
  } finally {
    await rm(link, { force: true });
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('all probes leave project scripts unexecuted and redact source contents', async () => {
  const cwd = await fixture({
    'package.json': '{"scripts":{"build":"node evil.mjs"},"dependencies":{"helmet":"SECRET_CANARY"}}',
    'evil.mjs': 'import fs from "node:fs"; fs.writeFileSync(new URL("executed", import.meta.url), "SECRET_CANARY"); console.error("SECRET_CANARY");\n',
    'auth.json': '{"api_key":"SECRET_CANARY"}',
  });
  try {
    const before = await snapshot(cwd);
    for (const domain of domains) {
      const { status, raw } = probe(domain, ['--cwd', cwd]);
      assert.equal(status, 0);
      assert.equal(raw.includes('SECRET_CANARY'), false);
    }
    assert.deepEqual(await snapshot(cwd), before);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('scanner enforces file, byte, depth and output bounds on real fixtures', async () => {
  const files = { 'huge.mjs': 'console.error("SECRET_CANARY");'.repeat(4000), 'a/b/c/d/e/deep.mjs': 'console.error("SECRET_CANARY");' };
  for (let index = 0; index < 160; index++) files[`src/${String(index).padStart(3, '0')}.mjs`] = 'export const x = 1;\n';
  const cwd = await fixture(files);
  try {
    const { status, json, raw } = probe('debugging', ['--cwd', cwd]);
    assert.equal(status, 0);
    assert.ok(json.scan.filesRead <= 128);
    assert.ok(json.scan.bytesRead <= 512 * 1024);
    assert.ok(json.scan.truncated);
    assert.ok(json.scan.skipped.oversized >= 1);
    assert.ok(json.scan.skipped.depth >= 1);
    assert.equal(raw.includes('SECRET_CANARY'), false);
    assert.equal(json.facts.diagnosticSites, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('total public text reads stop before the byte budget is exceeded', async () => {
  const files = {};
  for (let index = 0; index < 12; index++) files[`${index}.mjs`] = ' '.repeat(60 * 1024);
  const cwd = await fixture(files);
  try {
    const { status, json } = probe('debugging', ['--cwd', cwd]);
    assert.equal(status, 0);
    assert.equal(json.scan.filesRead, 8);
    assert.equal(json.scan.bytesRead, 480 * 1024);
    assert.equal(json.scan.truncated, true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('large real trees stop at directory and directory-entry budgets', async () => {
  const directories = {};
  const entries = {};
  for (let index = 0; index < 40; index++) directories[`dir${index}/source.mjs`] = 'export const x = 1;';
  for (let index = 0; index < 1030; index++) entries[`${index}.mjs`] = 'export const x = 1;';
  for (const [files, expected] of [[directories, { directories: 32, filesRead: 31 }], [entries, { entries: 1024, filesRead: 128 }]]) {
    const cwd = await fixture(files);
    try {
      const { status, json } = probe('debugging', ['--cwd', cwd]);
      assert.equal(status, 0);
      for (const [key, value] of Object.entries(expected)) assert.equal(json.scan[key], value);
      assert.equal(json.scan.truncated, true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }
});

test('Git probes never follow worktree pointers or oversized HEAD contents', async () => {
  const outside = await fixture({ '.git/HEAD': 'ref: refs/heads/SECRET_CANARY\n' });
  const cwd = await fixture({ '.git': `gitdir: ${join(outside, '.git')}\n` });
  try {
    const worktree = probe('git-surgery', ['--cwd', cwd]);
    assert.equal(worktree.json.facts.repositoryMarker, 'file');
    assert.equal(worktree.json.facts.headMode, 'unknown');
    assert.equal(worktree.raw.includes('SECRET_CANARY'), false);
    await rm(join(cwd, '.git'));
    await directoryLink(join(outside, '.git'), join(cwd, '.git'));
    assert.equal(probe('git-surgery', ['--cwd', cwd]).json.facts.repositoryMarker, 'absent');
    await rm(join(cwd, '.git'));
    await mkdir(join(cwd, '.git'));
    await writeFile(join(cwd, '.git/HEAD'), 'ref: refs/heads/SECRET_CANARY'.repeat(100));
    const oversized = probe('git-surgery', ['--cwd', cwd]);
    assert.equal(oversized.json.facts.headMode, 'unknown');
    assert.equal(oversized.json.limits.gitHeadBytes, 1024);
    assert.equal(oversized.raw.includes('SECRET_CANARY'), false);
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('empty projects do not invent installed packages or static evidence', async () => {
  const cwd = await fixture();
  try {
    for (const domain of domains) {
      const { status, json } = probe(domain, ['--cwd', cwd]);
      assert.equal(status, 0);
      assert.equal(json.scan.filesRead, 0);
      assert.equal(json.scan.bytesRead, 0);
      for (const [key, value] of Object.entries(json.facts)) {
        if (typeof value === 'number') assert.equal(value, 0, key);
        if (Array.isArray(value)) assert.deepEqual(value, [], key);
      }
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('hardlinked files are skipped rather than reading another name for private data', async () => {
  const cwd = await fixture({ 'credentials.json': 'console.error("SECRET_CANARY");' });
  try {
    await link(join(cwd, 'credentials.json'), join(cwd, 'public.mjs'));
    const { json, raw } = probe('debugging', ['--cwd', cwd]);
    assert.equal(json.scan.filesRead, 0);
    assert.equal(json.scan.skipped.special, 1);
    assert.equal(json.facts.diagnosticSites, 0);
    assert.equal(raw.includes('SECRET_CANARY'), false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('malformed public manifests do not fabricate dependency or build declarations', async () => {
  const cwd = await fixture({ 'package.json': '{"scripts":{"build":"SECRET_CANARY"},', 'source.mjs': 'export const x = 1;' });
  try {
    const { status, json, raw } = probe('build-systems', ['--cwd', cwd]);
    assert.equal(status, 0);
    assert.equal(json.facts.buildScriptDeclared, false);
    assert.deepEqual(json.facts.packageManagers, []);
    assert.equal(raw.includes('SECRET_CANARY'), false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a regular-file-to-FIFO replacement before the actual open cannot block or enter the scan', {skip: unixOnly}, async () => {
  const cwd = await fixture({ 'source.mjs': 'console.error("SECRET_CANARY");' });
  // A child-only preload makes the otherwise nondeterministic stat/open race
  // reproducible. The production reader still executes the real filesystem open.
  const preload = `
    import fs from 'node:fs/promises';
    import { spawnSync } from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    const target = join(process.argv[3], 'source.mjs');
    const original = fs.open;
    fs.open = async function(file, flags, ...rest) {
      if (file === target) {
        await fs.rename(target, target + '.original');
        const result = spawnSync('mkfifo', [target], { env: process.env });
        if (result.status !== 0) throw new Error('FIFO fixture setup failed');
      }
      return original.call(this, file, flags, ...rest);
    };
    syncBuiltinESMExports();
  `;
  try {
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, join(skills, 'debugging/scripts/probe.mjs'), '--cwd', cwd], { env, encoding: 'utf8', timeout: 2000, maxBuffer: 32 * 1024 });
    assert.equal(result.error, undefined, 'the real reader must refuse a FIFO replacement without blocking');
    assert.equal(result.stderr, '');
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.scan.filesRead, 0);
    assert.equal(json.scan.skipped.unreadable, 1);
    assert.equal(json.facts.diagnosticSites, 0);
    assert.equal(result.stdout.includes('SECRET_CANARY'), false);
    assert.equal((await lstat(join(cwd, 'source.mjs'))).isFIFO(), true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
