// Why auto-gc leaves seeded loose objects behind on Windows: bun gc-probe.mjs <checkout>. Builds the shadow store the
// way tests/features-checkpoints-io.test.mjs does, records every shadow Git command's stderr through runGit, then runs
// `git gc --auto` by hand in the checkpoint module's environment and in the full environment. Prints one JSON line.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, realpath, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const checkout = path.resolve(process.argv[2] ?? '.');
const { createCheckpointManager } = await import(pathToFileURL(path.join(checkout, 'extensions/apex-features/checkpoints.mjs')).href);
const base = await realpath(mkdtempSync(path.join(os.tmpdir(), 'apex-gc-probe-')));
const cwd = path.join(base, 'repo'); await mkdir(cwd);
const fixtureEnv = { ...Object.fromEntries(['PATH', 'LANG', 'LC_ALL'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const git = (args, dir = cwd, env = fixtureEnv) => exec('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env });
await git(['init', '--template=', '-q']);
await writeFile(path.join(cwd, '.gitignore'), '.apex/\n'); await writeFile(path.join(cwd, 'tracked.txt'), 'committed\n');
await git(['add', '.']); await git(['commit', '-qm', 'fixture']);
const log = [];
const runGit = (args, opts) => {
  const execution = exec('git', args, opts); execution.child.stdin.on('error', () => {}); execution.child.stdin.end(opts.input);
  const name = args.find(a => ['add', 'commit', 'rev-parse', 'ls-tree', 'check-ignore', 'ls-files', 'init', 'cat-file', 'read-tree', 'update-index', 'config', 'status', 'diff', 'write-tree'].includes(a)) ?? args.slice(-3).join(' ');
  execution.then(r => log.push({ cmd: name, stderr: String(r.stderr).trim().slice(0, 600) }), e => log.push({ cmd: name, code: e.code, stderr: String(e.stderr ?? '').trim().slice(0, 600) }));
  return execution;
};
const manager = createCheckpointManager({ cwd, sessionId: 'session-a', runGit });
await manager.capture('gc');
const shadow = path.join(cwd, '.apex/checkpoints', createHash('sha256').update('session-a').digest('hex'), 'shadow');
const objects = path.join(shadow, '.git/objects');
async function seed() {
  const seeded = [];
  for (let i = 0; seeded.length < 40; i++) { const body = Buffer.from(`seed ${i} ${Math.random()}\n`); const object = Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]); const id = createHash('sha1').update(object).digest('hex'); if (id.startsWith('17')) seeded.push({ id, object }); }
  await mkdir(path.join(objects, '17'), { recursive: true });
  const old = new Date('2020-01-01T00:00:00Z');
  for (const { id, object } of seeded) { const file = path.join(objects, '17', id.slice(2)); await writeFile(file, deflateSync(object)); await utimes(file, old, old); }
  return seeded;
}
const left = async seeded => { const remaining = await readdir(path.join(objects, '17')).catch(() => []); return seeded.filter(({ id }) => remaining.includes(id.slice(2))).length; };
const report = { platform: process.platform, git: String((await exec('git', ['--version'])).stdout).trim() };
let seeded = await seed();
await writeFile(path.join(cwd, 'tracked.txt'), 'agent');
await manager.finish('gc');
report.viaFinish = { remaining: await left(seeded), commands: log.filter(entry => entry.stderr || (entry.code !== undefined && !(entry.cmd === 'check-ignore' && entry.code === 1))) };
await manager.shutdown();
// By hand, in the module's environment (PATH, LANG, LC_ALL, no system or global config) plus the foreground settings.
const moduleEnv = { ...fixtureEnv, GIT_OPTIONAL_LOCKS: '0', GIT_COMMON_DIR: '.git', GIT_OBJECT_DIRECTORY: '.git/objects', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'gc.autoDetach', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'maintenance.autoDetach', GIT_CONFIG_VALUE_1: 'false' };
for (const [name, env] of [['gc-auto-module-env', moduleEnv], ['gc-auto-full-env', { ...process.env, ...moduleEnv, GIT_CONFIG_NOSYSTEM: '1' }], ['maintenance-auto-module-env', moduleEnv]]) {
  seeded = await seed();
  const args = name.startsWith('maintenance') ? ['maintenance', 'run', '--auto'] : ['gc', '--auto'];
  try { const r = await exec('git', args, { cwd: shadow, env }); report[name] = { remaining: await left(seeded), stderr: String(r.stderr).trim().slice(0, 600) }; }
  catch (error) { report[name] = { remaining: await left(seeded), error: String(error.message).slice(0, 600) }; }
}
try { report.countObjects = String((await exec('git', ['count-objects', '-v'], { cwd: shadow, env: moduleEnv })).stdout).trim().split(/\r?\n/); } catch (error) { report.countObjects = String(error.message).slice(0, 300); }
console.log(JSON.stringify(report));
try { rmSync(base, { recursive: true, force: true, maxRetries: 5 }); } catch {}
