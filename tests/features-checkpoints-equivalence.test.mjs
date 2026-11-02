import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, readdir, lstat, link, symlink, readlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createCheckpointManager } from '../extensions/apex-features/checkpoints.mjs';
import { createCheckpointManager as createReference } from './fixtures/checkpoints-d0c6d2b.mjs';

// Differential test: the optimized module and the d0c6d2b reference run the same seeded random sessions side by side
// (two identical worktrees) and must agree on every result, error, persisted record, shadow tree and restored file.
const exec = promisify(execFile);
const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
const gitEnv = { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
const git = (cwd, args) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Checkpoint fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, env: gitEnv });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const SESSION = 'equivalence';
const shadowOf = cwd => path.join(cwd, '.apex/checkpoints', hash(SESSION), 'shadow');
const posix = process.platform !== 'win32';

function prng(seed) {
  return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

async function walk(root, relative = '') {
  const out = [];
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    if (!relative && (name === '.git' || name === '.apex')) continue;
    const child = relative ? `${relative}/${name}` : name; const info = await lstat(path.join(root, child));
    if (info.isDirectory()) out.push(...await walk(root, child)); else out.push({ name: child, info });
  }
  return out;
}
async function worktree(root) {
  const view = {};
  for (const { name, info } of await walk(root)) view[name] = info.isSymbolicLink() ? `link:${await readlink(path.join(root, name))}` : `${(info.mode & 0o777).toString(8)}:${hash(await readFile(path.join(root, name)))}`;
  return view;
}
const settled = promise => promise.then(value => ({ value }), error => ({ error }));
async function treeOf(cwd, commit) { return commit ? (await git(shadowOf(cwd), ['rev-parse', `${commit}^{tree}`])).stdout.trim() : undefined; }
async function record(cwd, value) {
  const { capturedAt, finishedAt, beforeCommit, afterCommit, ...rest } = value;
  assert.ok(!Number.isNaN(Date.parse(capturedAt)));
  return { ...rest, beforeTree: await treeOf(cwd, beforeCommit), afterTree: await treeOf(cwd, afterCommit), finished: Boolean(finishedAt) };
}
async function view(cwd, outcome) {
  if (outcome.error) {
    const { name, code, message, details } = outcome.error;
    return { error: { name, code, message: String(message).replaceAll(cwd, '<cwd>'), paths: details?.paths, failures: JSON.stringify(details?.failures)?.replaceAll(cwd, '<cwd>') } };
  }
  return Array.isArray(outcome.value) ? Promise.all(outcome.value.map(value => record(cwd, value))) : record(cwd, outcome.value);
}
async function stateView(cwd) {
  let state;
  try { state = JSON.parse(await readFile(path.join(cwd, '.apex/checkpoints', hash(SESSION), 'state.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  delete state.cwd;
  for (const [index, record] of state.records.entries()) {
    const { capturedAt, finishedAt, restoredAt, beforeCommit, afterCommit, ...rest } = record;
    state.records[index] = { ...rest, beforeTree: await treeOf(cwd, beforeCommit), afterTree: await treeOf(cwd, afterCommit), stamps: [capturedAt, finishedAt, restoredAt].map(Boolean) };
  }
  return JSON.stringify(state);
}

const DIRS = ['', 'src/', 'src/lib/', 'docs/', 'a b/', 'µ/', 'deep/er/est/', 'ignored/'];
const STEMS = ['f', 'n ', 'Ü', 'x-'];
const EXTS = ['.txt', '.md', '.bin', '.log', ''];
function generator(seed) {
  const rand = prng(seed); const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)); const pick = list => list[int(0, list.length - 1)];
  const size = () => { const r = rand(); return r < 0.6 ? int(0, 200) : r < 0.85 ? int(300, 3000) : r < 0.95 ? int(3000, 4096) : int(4097, 6000); };
  const bytes = length => Buffer.from(Array.from({ length }, () => int(0, 255)));
  const name = () => `${pick(DIRS)}${pick(STEMS)}${int(0, 999)}${pick(EXTS)}`;
  return { rand, int, pick, size, bytes, name, mode: () => pick([0o644, 0o644, 0o755, 0o600]) };
}

async function apply(root, ops) {
  for (const op of ops) {
    const file = path.join(root, op.path ?? '');
    if (op.type === 'write') { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, op.bytes); await chmod(file, op.mode); }
    else if (op.type === 'rm') await rm(file, { force: true });
    else if (op.type === 'chmod') await chmod(file, op.mode);
    else if (op.type === 'link') await link(path.join(root, op.target), file);
    else if (op.type === 'symlink') await symlink(op.target, file);
  }
}
function mutations(gen, files) {
  const ops = []; const live = files.filter(entry => entry.info.isFile());
  for (let count = gen.int(1, 6); count > 0; count--) {
    const kind = gen.rand(); const existing = live.length ? gen.pick(live) : undefined;
    if (existing && kind < 0.25) ops.push({ type: 'write', path: existing.name, bytes: gen.bytes(existing.info.size), mode: existing.info.mode & 0o777 });
    else if (existing && kind < 0.45) ops.push({ type: 'write', path: existing.name, bytes: gen.bytes(gen.size()), mode: existing.info.mode & 0o777 });
    else if (existing && kind < 0.6 && existing.name !== '.gitignore') ops.push({ type: 'rm', path: existing.name });
    else if (existing && kind < 0.7 && posix) ops.push({ type: 'chmod', path: existing.name, mode: gen.mode() });
    else if (kind < 0.75) ops.push({ type: 'write', path: '.gitignore', bytes: Buffer.from(`ignored/\n*.log\n.apex/\n${gen.pick(['', 'docs/\n', '*.md\n', 'src/lib/\n'])}`), mode: 0o644 });
    else ops.push({ type: 'write', path: gen.name(), bytes: gen.bytes(gen.size()), mode: gen.mode() });
  }
  return ops;
}

async function session(t, seed, limits) {
  const gen = generator(seed);
  const roots = await Promise.all([0, 1].map(() => mkdtemp(path.join(process.cwd(), 'tests/.checkpoint-fixture-eq-'))));
  t.after(() => Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))));
  const initial = [{ type: 'write', path: '.gitignore', bytes: Buffer.from('ignored/\n*.log\n.apex/\n'), mode: 0o644 }];
  for (let count = gen.int(25, 50); count > 0; count--) initial.push({ type: 'write', path: gen.name(), bytes: gen.bytes(gen.size()), mode: gen.mode() });
  for (const root of roots) {
    await git(root, ['init', '--template=', '-q']);
    await apply(root, initial);
    // A tracked file that is also ignored: ls-files lists it, check-ignore --no-index drops it.
    await writeFile(path.join(root, 'kept.log'), 'tracked but ignored\n');
    await git(root, ['add', '-A']); await git(root, ['add', '-f', 'kept.log']); await git(root, ['commit', '-qm', 'fixture']);
  }
  const dirty = mutations(generator(seed + 1), await walk(roots[0]));
  for (const root of roots) await apply(root, dirty);
  const managers = [createCheckpointManager({ cwd: roots[0], sessionId: SESSION, limits }), createReference({ cwd: roots[1], sessionId: SESSION, limits })];
  t.after(() => Promise.all(managers.map(manager => manager.shutdown())));
  const both = async call => {
    const outcomes = [];
    for (const [index, manager] of managers.entries()) outcomes.push(await view(roots[index], await settled(call(manager))));
    assert.deepEqual(outcomes[0], outcomes[1]);
    assert.equal(await stateView(roots[0]), await stateView(roots[1]));
    return outcomes[0];
  };
  const everywhere = async ops => { for (const root of roots) await apply(root, ops); };
  for (let turn = 1; turn <= 5; turn++) {
    const id = `turn-${turn}`; const files = await walk(roots[0]);
    const fault = gen.rand(); const live = files.filter(entry => entry.info.isFile());
    const faults = fault < 0.2 && live.length ? [{ type: 'link', path: `hard-${turn}.txt`, target: gen.pick(live).name }] : fault < 0.3 && posix ? [{ type: 'symlink', path: `soft-${turn}.txt`, target: 'ignored/outside.txt' }] : [];
    await everywhere(faults);
    let captured = await both(manager => manager.capture(id));
    if (faults.length) { await everywhere(faults.map(op => ({ type: 'rm', path: op.path }))); if (captured.error) captured = await both(manager => manager.capture(id)); }
    await both(manager => manager.capture(id));
    await everywhere(mutations(gen, await walk(roots[0])));
    const finished = await both(manager => manager.finish(id));
    if (finished.status === 'finished' && gen.rand() < 0.6) {
      if (gen.rand() < 0.25 && finished.changedPaths.length) {
        const conflict = gen.pick(finished.changedPaths);
        await everywhere([{ type: 'write', path: conflict, bytes: Buffer.from('manual edit after the turn'), mode: 0o644 }]);
      }
      await both(manager => manager.restore(id));
      assert.deepEqual(await worktree(roots[0]), await worktree(roots[1]));
    }
  }
  await both(manager => manager.list());
  assert.deepEqual(await worktree(roots[0]), await worktree(roots[1]));
}

test('optimized checkpoints match the d0c6d2b reference over seeded random sessions', async t => {
  // Small caps so budget skips, per-file cap skips and budget-straddling files occur in every session.
  const cases = [[11, { maxFileBytes: 4096, maxBytes: 16384 }], [23, { maxFileBytes: 4096, maxBytes: 24576, maxGitOutputBytes: 4096 }], [37, { maxFileBytes: 2048, maxBytes: 12000 }], [41, {}]];
  // allSettled: cleanup must not start while another session is still writing its worktrees.
  const outcomes = await Promise.allSettled(cases.map(([seed, limits]) => session(t, seed, limits).catch(error => { error.message = `seed ${seed}: ${error.message}`; throw error; })));
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
});

async function directories(root) {
  const out = [root];
  for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) out.push(...await directories(path.join(root, entry.name)));
  return out;
}
test('store walks stop at the same first unsafe entry, entry cap or byte cap as the reference', { skip: !posix && 'Requires POSIX FIFOs' }, async t => {
  // Both modules probe one shared store. Every scenario plants an unsafe entry, so neither call gets past the walks;
  // a crowd of plain files and a large file compete to trip the entry cap (1,200 here) or the byte cap first.
  const limits = { maxFiles: 50, maxCheckpoints: 1, maxStoredBytes: 3000000 };
  const root = await mkdtemp(path.join(process.cwd(), 'tests/.checkpoint-fixture-eq-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '--template=', '-q']);
  await writeFile(path.join(root, '.gitignore'), '.apex/\n');
  for (let i = 0; i < 8; i++) await writeFile(path.join(root, `file-${i}.txt`), `content ${i}\n`);
  await git(root, ['add', '-A']); await git(root, ['commit', '-qm', 'fixture']);
  const managers = [createCheckpointManager({ cwd: root, sessionId: SESSION, limits }), createReference({ cwd: root, sessionId: SESSION, limits })];
  t.after(() => Promise.all(managers.map(manager => manager.shutdown())));
  await managers[0].capture('base'); await writeFile(path.join(root, 'file-0.txt'), 'agent'); await managers[0].finish('base');
  const store = path.join(root, '.apex/checkpoints', hash(SESSION));
  const metadata = await directories(path.join(store, 'shadow/.git'));
  const gen = generator(97); const seen = new Set();
  for (let scenario = 0; scenario < 24; scenario++) {
    const recovery = path.join(store, `restore-${scenario}`); await mkdir(recovery); await writeFile(path.join(recovery, 'before-0'), 'backup');
    // The unsafe entry cycles through the zones; the crowd and the large file usually share its zone, so they compete.
    const kind = gen.pick(['symlink', 'hardlink', 'fifo']); const zone = scenario % 4 === 3 && kind !== 'symlink' ? 2 : scenario % 4;
    const place = () => [() => gen.pick(metadata), () => store, () => recovery, () => path.join(store, 'shadow')][gen.rand() < 0.75 ? zone : gen.int(0, 2)]();
    const planted = [recovery];
    if (gen.rand() < 0.6) {
      const crowd = path.join(zone === 3 ? store : place(), `crowd-${scenario}`); await mkdir(crowd); planted.push(crowd);
      await Promise.all(Array.from({ length: gen.int(1000, 1600) }, (_, i) => writeFile(path.join(crowd, `entry-${i}`), '')));
    }
    if (gen.rand() < 0.5) { const large = path.join(zone === 3 ? store : place(), `large-${scenario}`); await writeFile(large, Buffer.alloc(gen.int(1500, 4000) * 1000)); planted.push(large); }
    const unsafe = path.join(place(), `unsafe-${scenario}`);
    if (kind === 'symlink') await symlink(path.join(root, 'file-1.txt'), unsafe);
    else if (kind === 'fifo') await exec('mkfifo', [unsafe]);
    else { await writeFile(unsafe, 'twin'); await link(unsafe, `${unsafe}-twin`); planted.push(`${unsafe}-twin`); }
    planted.push(unsafe);
    const outcomes = [];
    for (const manager of managers) outcomes.push(await settled(manager.capture(`probe-${scenario}`)).then(({ error }) => error ? { code: error.code, message: error.message } : 'accepted'));
    assert.deepEqual(outcomes[0], outcomes[1], `scenario ${scenario}`);
    assert.notEqual(outcomes[0], 'accepted');
    seen.add(`${outcomes[0].code}: ${outcomes[0].message}`);
    for (const file of planted.reverse()) await rm(file, { recursive: true, force: true });
  }
  // On ext4 this seed reaches all six stops (unsafe entry in either walk or the shadow worktree, either entry cap, the
  // byte cap); readdir order differs between filesystems, so only a floor is asserted.
  assert.ok(seen.size >= 4, [...seen].join('\n'));
  assert.deepEqual((await managers[1].list()).map(entry => entry.turnId), ['base']);
});
