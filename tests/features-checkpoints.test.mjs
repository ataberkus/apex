import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, chmod, readdir, link } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createCheckpointManager } from '../extensions/apex-features/checkpoints.mjs';
import {directoryLink, fileLink, unixOnly} from './fixtures/filesystem.mjs';

const exec = promisify(execFile);
const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'CODEX_PRIMARY_RUNTIME_NODE'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
const gitEnv = { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
const git = (cwd, args) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Checkpoint fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, env: gitEnv });
const runGitCommand = (args, opts) => { const execution = exec('git', args, opts); execution.child.stdin.on('error', () => {}); execution.child.stdin.end(opts.input); return execution; };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const indexHash = async cwd => hash(await readFile(path.join(cwd, '.git/index')));
async function fixture(t, options = {}, prefix = 'tests/.checkpoint-fixture-') {
  const cwd = await mkdtemp(path.join(process.cwd(), prefix));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await git(cwd, ['init', '--template=', '-q']);
  await writeFile(path.join(cwd, '.gitignore'), 'ignored/\n.apex/\n.env\n');
  await writeFile(path.join(cwd, 'tracked.txt'), 'committed\n');
  await writeFile(path.join(cwd, 'deleted.txt'), 'keep original\n');
  await git(cwd, ['add', '.']);
  await git(cwd, ['commit', '-qm', 'fixture']);
  await writeFile(path.join(cwd, 'tracked.txt'), 'staged\n');
  await git(cwd, ['add', 'tracked.txt']);
  await writeFile(path.join(cwd, 'tracked.txt'), 'dirty source\n');
  await writeFile(path.join(cwd, 'untracked.txt'), 'untracked original\n');
  return { cwd, manager: createCheckpointManager({ cwd, sessionId: 'session-a', ...options }) };
}

test('factory is inert and invalid/cancelled methods fail before Git', async () => {
  let calls = 0;
  const manager = createCheckpointManager({ cwd: '/nonexistent/apex-checkpoint-test', sessionId: 'inert', runGit: () => { calls++; throw Error('Git touched'); } });
  assert.equal(calls, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(manager.capture('turn', { signal: controller.signal }), /abort|cancel/i);
  await assert.rejects(manager.capture(''), /turn/i);
  assert.equal(calls, 0);
  await manager.shutdown();
  await assert.rejects(manager.list(), /closed|shutdown/i);
});

test('real private shadow Git restores dirty/untracked/delete/create/mode without changing user index', async t => {
  const { cwd, manager } = await fixture(t);
  const beforeIndex = await indexHash(cwd);
  await chmod(path.join(cwd, 'tracked.txt'), 0o640);
  const captured = await manager.capture('turn-1');
  assert.equal(captured.status, 'captured');
  assert.match(captured.beforeCommit, /^[a-f0-9]{40,64}$/);
  await writeFile(path.join(cwd, 'tracked.txt'), 'agent changed\n');
  await chmod(path.join(cwd, 'tracked.txt'), 0o755);
  await rm(path.join(cwd, 'deleted.txt'));
  await writeFile(path.join(cwd, 'untracked.txt'), 'agent untracked changed\n');
  await mkdir(path.join(cwd, 'created'));
  await writeFile(path.join(cwd, 'created/new.txt'), 'agent addition\n');
  const finished = await manager.finish('turn-1');
  assert.deepEqual(finished.changedPaths, ['created/new.txt', 'deleted.txt', 'tracked.txt', 'untracked.txt']);
  assert.equal(await indexHash(cwd), beforeIndex);
  const restored = await manager.restore('turn-1');
  assert.equal(restored.status, 'restored');
  assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'dirty source\n');
  await t.test('POSIX mode restored', {skip: unixOnly}, async () => {
    assert.equal((await stat(path.join(cwd, 'tracked.txt'))).mode & 0o777, 0o640);
  });
  assert.equal(await readFile(path.join(cwd, 'deleted.txt'), 'utf8'), 'keep original\n');
  assert.equal(await readFile(path.join(cwd, 'untracked.txt'), 'utf8'), 'untracked original\n');
  await assert.rejects(readFile(path.join(cwd, 'created/new.txt')), { code: 'ENOENT' });
  assert.equal(await indexHash(cwd), beforeIndex);
  assert.equal((await manager.restore('turn-1')).status, 'already-restored');
  assert.equal((await manager.list())[0].status, 'restored');
  const sessions = await readdir(path.join(cwd, '.apex/checkpoints'));
  const shadow = path.join(cwd, '.apex/checkpoints', sessions[0], 'shadow');
  assert.equal((await git(shadow, ['rev-list', '--count', 'HEAD'])).stdout.trim(), '2');
});

test('concurrent sibling captures wait for one persistent snapshot and finish is idempotent', async t => {
  let captures = 0;
  const { cwd, manager } = await fixture(t, { runGit: async (args, opts) => {
    if (args.includes('commit')) captures++;
    return runGitCommand(args, opts);
  } });
  const result = await Promise.all(Array.from({ length: 8 }, () => manager.capture('siblings')));
  assert.equal(captures, 1);
  assert.equal(new Set(result.map(r => r.beforeCommit)).size, 1);
  await writeFile(path.join(cwd, 'tracked.txt'), 'changed');
  await manager.finish('siblings');
  assert.equal((await manager.finish('siblings')).status, 'finished');
  assert.equal(captures, 2);
});

test('undo outlasts a brief Windows sharing lock on the restored file', {skip: process.platform !== 'win32' && 'Requires Windows file sharing modes', timeout: 120000}, async t => {
  const { cwd, manager } = await fixture(t);
  await manager.capture('locked');
  await writeFile(path.join(cwd, 'tracked.txt'), 'agent changed\n');
  await manager.finish('locked');
  // Opening without FileShare.Delete is what antivirus and indexers do; a rename onto the file fails until it closes.
  const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const target = path.join(cwd, 'tracked.txt').replaceAll("'", "''");
  const holder = execFile(shell, ['-NoProfile', '-NonInteractive', '-Command',
    `$f=[System.IO.File]::Open('${target}','Open','Read','Read'); [Console]::Out.WriteLine('locked'); Start-Sleep -Milliseconds 1500; $f.Close()`]);
  t.after(() => holder.kill());
  await new Promise((resolve, reject) => { holder.stdout.on('data', text => String(text).includes('locked') && resolve()); holder.once('exit', reject); });
  assert.equal((await manager.restore('locked')).status, 'restored');
  assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'dirty source\n');
});

test('reopen persists records, session isolation and detached list objects', async t => {
  const { cwd, manager } = await fixture(t);
  await manager.capture('persist');
  await writeFile(path.join(cwd, 'tracked.txt'), 'changed');
  await manager.finish('persist');
  await manager.shutdown();
  const reopened = createCheckpointManager({ cwd, sessionId: 'session-a' });
  const records = await reopened.list();
  assert.equal(records[0].turnId, 'persist');
  records[0].changedPaths.push('../evil');
  assert.deepEqual((await reopened.list())[0].changedPaths, ['tracked.txt']);
  assert.deepEqual(await createCheckpointManager({ cwd, sessionId: 'session-b' }).list(), []);
  await reopened.restore('persist');
  assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'dirty source\n');
});

const deepFixture = (t, length) => fixture(t, {}, `tests/.checkpoint-fixture-${'deep-'.repeat(Math.max(1, Math.ceil((length - 33 - process.cwd().length) / 5)))}`);
test('projects past Windows MAX_PATH and Git $GIT_DIR limits capture and undo', async t => {
  // Live Windows /undo failed locking .apex/checkpoints/<sha>/shadow/.git/refs/apex/restored/<sha> past 260 chars.
  const { cwd, manager } = await deepFixture(t, 135);
  const gitDir = path.join(cwd, '.apex/checkpoints', hash('session-a'), 'shadow/.git');
  assert.ok(gitDir.length > 220 && path.join(gitDir, 'refs/apex/restored', hash('deep')).length > 260);
  await manager.capture('deep');
  await writeFile(path.join(cwd, 'tracked.txt'), 'agent');
  await manager.finish('deep');
  assert.equal((await manager.restore('deep')).status, 'restored');
  assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'dirty source\n');
});

test('projects past the Windows Git working-directory limit fail closed instead of crashing', {skip: process.platform !== 'win32'}, async t => {
  const { cwd, manager } = await deepFixture(t, 185);
  await assert.rejects(manager.capture('too-deep'), { code: 'path-too-long' });
  assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'dirty source\n');
});

test('manual post-turn edits and chmod refuse all restoration before any file changes', async t => {
  for (const conflict of ['content', 'mode', 'deleted']) await t.test(conflict, {skip: conflict === 'mode' && unixOnly}, async t => {
    const { cwd, manager } = await fixture(t);
    await manager.capture(conflict);
    await writeFile(path.join(cwd, 'tracked.txt'), 'agent');
    await writeFile(path.join(cwd, 'untracked.txt'), 'agent second');
    await manager.finish(conflict);
    if (conflict === 'content') await writeFile(path.join(cwd, 'untracked.txt'), 'manual');
    if (conflict === 'mode') await chmod(path.join(cwd, 'untracked.txt'), 0o755);
    if (conflict === 'deleted') await rm(path.join(cwd, 'untracked.txt'));
    await assert.rejects(manager.restore(conflict), /conflict/i);
    assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'agent');
  });
});

test('ignored and private paths are excluded, preserve mutations and never enter shadow history', async t => {
  const { cwd, manager } = await fixture(t);
  await mkdir(path.join(cwd, 'ignored'));
  await writeFile(path.join(cwd, 'ignored/dependency.txt'), 'ignored-before');
  await writeFile(path.join(cwd, '.env'), 'private-before');
  await writeFile(path.join(cwd, 'auth.json'), 'private-auth-before');
  await manager.capture('safe');
  await writeFile(path.join(cwd, 'ignored/dependency.txt'), 'ignored-after');
  await writeFile(path.join(cwd, '.env'), 'private-after');
  await writeFile(path.join(cwd, 'auth.json'), 'private-auth-after');
  await writeFile(path.join(cwd, 'tracked.txt'), 'agent');
  await manager.finish('safe');
  await manager.restore('safe');
  assert.equal(await readFile(path.join(cwd, 'ignored/dependency.txt'), 'utf8'), 'ignored-after');
  assert.equal(await readFile(path.join(cwd, '.env'), 'utf8'), 'private-after');
  assert.equal(await readFile(path.join(cwd, 'auth.json'), 'utf8'), 'private-auth-after');
  assert.deepEqual((await manager.list())[0].changedPaths, ['tracked.txt']);
});

test('symlink capture and later symlink target/ancestor restoration are rejected without external writes', async t => {
  const { cwd, manager } = await fixture(t);
  const external = path.join(cwd, 'ignored'); await mkdir(external);
  await writeFile(path.join(external, 'external.txt'), 'external');
  await t.test('file symlink capture', async t => {
    if (!await fileLink(t, 'ignored/external.txt', path.join(cwd, 'link.txt'))) return;
    await assert.rejects(manager.capture('link'), /symlink/i);
    await rm(path.join(cwd, 'link.txt'));
  });
  await mkdir(path.join(cwd, 'source'));
  await writeFile(path.join(cwd, 'source/file.txt'), 'before');
  await manager.capture('ancestor');
  await writeFile(path.join(cwd, 'source/file.txt'), 'agent');
  await manager.finish('ancestor');
  await rm(path.join(cwd, 'source'), { recursive: true });
  await directoryLink('ignored', path.join(cwd, 'source'));
  await assert.rejects(manager.restore('ancestor'), /symlink/i);
  assert.equal(await readFile(path.join(external, 'external.txt'), 'utf8'), 'external');
});

test('newly ignored restoration paths refuse undo', async t => {
  const { cwd, manager } = await fixture(t);
  await manager.capture('ignore');
  await writeFile(path.join(cwd, 'tracked.txt'), 'agent');
  await manager.finish('ignore');
  await writeFile(path.join(cwd, '.gitignore'), 'tracked.txt\n.apex/\n');
  await assert.rejects(manager.restore('ignore'), /ignored/i);
  assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'agent');
});

test('corrupt/foreign metadata and private-store symlinks fail closed', async t => {
  const { cwd, manager } = await fixture(t);
  await manager.capture('owned');
  await writeFile(path.join(cwd, 'tracked.txt'), 'agent');
  await manager.finish('owned');
  const sessions = await readdir(path.join(cwd, '.apex/checkpoints'));
  const manifest = path.join(cwd, '.apex/checkpoints', sessions[0], 'state.json');
  const state = JSON.parse(await readFile(manifest, 'utf8'));
  state.records[0].changedPaths = ['../escape'];
  await writeFile(manifest, JSON.stringify(state));
  await assert.rejects(manager.restore('owned'), /metadata|path/i);
  assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'agent');
  const second = await fixture(t);
  await mkdir(path.join(second.cwd, 'ignored'));
  await directoryLink('ignored', path.join(second.cwd, '.apex'));
  await assert.rejects(second.manager.capture('private-link'), /symlink/i);
});

test('oversized files are recorded as skipped and undo never writes or deletes them', async t => {
  const { cwd, manager } = await fixture(t, { limits: { maxFileBytes: 64 } });
  await writeFile(path.join(cwd, 'big.bin'), Buffer.alloc(65, 1));
  await writeFile(path.join(cwd, 'shrinks.bin'), Buffer.alloc(65, 2));
  await writeFile(path.join(cwd, 'grows.txt'), 'small');
  assert.deepEqual((await manager.capture('big')).skippedPaths, ['big.bin', 'shrinks.bin']);
  await writeFile(path.join(cwd, 'tracked.txt'), 'agent');
  await writeFile(path.join(cwd, 'shrinks.bin'), 'small now');
  await writeFile(path.join(cwd, 'grows.txt'), Buffer.alloc(65, 3));
  const finished = await manager.finish('big');
  assert.deepEqual(finished.skippedPaths, ['big.bin', 'grows.txt', 'shrinks.bin']);
  assert.deepEqual(finished.changedPaths, ['tracked.txt']);
  assert.equal((await manager.restore('big')).status, 'restored');
  assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'dirty source\n');
  assert.equal(await readFile(path.join(cwd, 'shrinks.bin'), 'utf8'), 'small now');
  assert.equal((await stat(path.join(cwd, 'grows.txt'))).size, 65);
  assert.equal((await stat(path.join(cwd, 'big.bin'))).size, 65);
});

test('history charges unchanged content once, so long sessions in large projects keep capturing', async t => {
  const { cwd, manager } = await fixture(t, { limits: { maxStoredBytes: 450000 } });
  await writeFile(path.join(cwd, 'unchanged.bin'), Buffer.alloc(100000));
  for (let turn = 1; turn <= 4; turn++) {
    await manager.capture(`turn-${turn}`);
    await writeFile(path.join(cwd, 'tracked.txt'), `agent ${turn}`);
    assert.deepEqual((await manager.finish(`turn-${turn}`)).changedPaths, ['tracked.txt']);
  }
  assert.equal((await manager.restore('turn-4')).status, 'restored');
  assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'agent 3');
});

test('capture and restore enforce file and byte caps', async t => {
  for (const limits of [{ maxFiles: 1 }, { maxBytes: 2 }, { maxStoredBytes: 64 }]) {
    const { manager } = await fixture(t, { limits });
    await assert.rejects(manager.capture('cap'), /cap|limit/i);
    assert.deepEqual(await manager.list(), []);
  }
});

test('past maxCheckpoints the oldest records are dropped and history is recharged, so capture never blocks', async t => {
  // Every turn adds 100 kB of new content; history charged for dropped records would pass maxStoredBytes by turn 5.
  const { cwd, manager } = await fixture(t, { limits: { maxCheckpoints: 2, maxStoredBytes: 450000 } });
  for (let turn = 1; turn <= 6; turn++) {
    await manager.capture(`turn-${turn}`);
    await writeFile(path.join(cwd, 'tracked.txt'), `agent ${turn}`);
    await writeFile(path.join(cwd, 'big.bin'), Buffer.alloc(100000, turn));
    assert.deepEqual((await manager.finish(`turn-${turn}`)).changedPaths, ['big.bin', 'tracked.txt']);
  }
  // A turn that changed nothing (a test run through bash) has nothing to undo and must not evict one that did.
  await manager.capture('verify');
  assert.equal((await manager.finish('verify')).status, 'unchanged');
  assert.deepEqual((await manager.list()).map(record => record.turnId), ['turn-5', 'turn-6']);
  await assert.rejects(manager.restore('turn-4'), /unknown/i);
  assert.equal((await manager.restore('turn-6')).status, 'restored');
  assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'agent 5');
  assert.equal((await manager.restore('turn-5')).status, 'restored');
  assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'agent 4');
  assert.deepEqual(await readFile(path.join(cwd, 'big.bin')), Buffer.alloc(100000, 4));
});

test('post-apply durable Git failure rolls back every actual restored file and remains retryable', async t => {
  let fail = true;
  const { cwd, manager } = await fixture(t, { runGit: async (args, opts) => {
    if (args.includes('update-ref') && fail) { fail = false; throw Error('injected durable marker failure'); }
    return runGitCommand(args, opts);
  } });
  const index = await indexHash(cwd);
  await manager.capture('rollback');
  await writeFile(path.join(cwd, 'tracked.txt'), 'agent-one');
  await chmod(path.join(cwd, 'tracked.txt'), 0o755);
  await writeFile(path.join(cwd, 'untracked.txt'), 'agent-two');
  await rm(path.join(cwd, 'deleted.txt'));
  await writeFile(path.join(cwd, 'added.txt'), 'agent-added');
  await manager.finish('rollback');
  await assert.rejects(manager.restore('rollback'), /injected durable marker failure/);
  assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'agent-one');
  await t.test('POSIX mode rolled back', {skip: unixOnly}, async () => {
    assert.equal((await stat(path.join(cwd, 'tracked.txt'))).mode & 0o777, 0o755);
  });
  assert.equal(await readFile(path.join(cwd, 'untracked.txt'), 'utf8'), 'agent-two');
  assert.equal(await readFile(path.join(cwd, 'added.txt'), 'utf8'), 'agent-added');
  await assert.rejects(readFile(path.join(cwd, 'deleted.txt')), { code: 'ENOENT' });
  assert.equal((await manager.list())[0].status, 'finished');
  assert.equal(await indexHash(cwd), index);
  assert.equal((await manager.restore('rollback')).status, 'restored');
});

test('unfinished capture cannot undo and shutdown cancels a queued/in-flight capture', async t => {
  const { manager } = await fixture(t);
  await manager.capture('unfinished');
  await assert.rejects(manager.restore('unfinished'), /finish|unfinished/i);
  const controller = new AbortController();
  const other = await fixture(t, { runGit: async (args, opts) => {
    if (args.includes('ls-files')) { controller.abort(); throw Object.assign(Error('cancelled'), { code: 'ABORT_ERR' }); }
    return runGitCommand(args, opts);
  } });
  await assert.rejects(other.manager.capture('cancel', { signal: controller.signal }), /abort|cancel/i);
  assert.deepEqual(await other.manager.list(), []);
  await other.manager.shutdown();
});

test('session metadata supports safe custom version-control directory without ambient Git variables', async t => {
  const { cwd } = await fixture(t);
  const { rename } = await import('node:fs/promises');
  await rename(path.join(cwd, '.git'), path.join(cwd, 'version-control'));
  await writeFile(path.join(cwd, '.gitignore'), '.apex/\nversion-control/\n');
  const manager = createCheckpointManager({ cwd, sessionId: 'custom-meta' });
  await manager.capture('custom');
  await writeFile(path.join(cwd, 'tracked.txt'), 'agent');
  await manager.finish('custom');
  await manager.restore('custom');
  assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'dirty source\n');
});

test('binary/CRLF payloads and Unicode filenames survive source attributes without filters (newline name on POSIX)', async t => {
  const { cwd, manager } = await fixture(t);
  await writeFile(path.join(cwd, '.gitattributes'), '* text eol=lf\n');
  const filename = process.platform === 'win32' ? 'literal name-µ.txt' : 'literal\nname-µ.txt';
  const original = Buffer.from([0, 255, 13, 10, 13, 10, 65]);
  await writeFile(path.join(cwd, filename), original);
  await writeFile(path.join(cwd, 'crlf.txt'), 'source\r\n');
  await manager.capture('attributes');
  await writeFile(path.join(cwd, filename), 'agent');
  await writeFile(path.join(cwd, 'crlf.txt'), 'agent\r\n');
  await manager.finish('attributes');
  await manager.restore('attributes');
  assert.deepEqual(await readFile(path.join(cwd, filename)), original);
  assert.equal(await readFile(path.join(cwd, 'crlf.txt'), 'utf8'), 'source\r\n');
});

test('hard links and shadow object-directory symlinks fail closed', async t => {
  const { cwd, manager } = await fixture(t);
  await link(path.join(cwd, 'tracked.txt'), path.join(cwd, 'hardlink.txt'));
  await assert.rejects(manager.capture('hardlink'), /one link|regular file/i);
  await rm(path.join(cwd, 'hardlink.txt'));
  await manager.capture('objects');
  await writeFile(path.join(cwd, 'tracked.txt'), 'agent');
  await manager.finish('objects');
  const [session] = await readdir(path.join(cwd, '.apex/checkpoints'));
  const objects = path.join(cwd, '.apex/checkpoints', session, 'shadow/.git/objects');
  await mkdir(path.join(cwd, 'ignored'));
  const existing = await readdir(objects);
  const missing = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0')).find(name => !existing.includes(name));
  await directoryLink(path.join(cwd, 'ignored'), path.join(objects, missing));
  await assert.rejects(manager.restore('objects'), /symlink|unsafe link/i);
  assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'agent');
});

test('same-session manager instances serialize capture and user edits to unchanged paths remain', async t => {
  const { cwd, manager } = await fixture(t);
  const second = createCheckpointManager({ cwd, sessionId: 'session-a' });
  const records = await Promise.all([manager.capture('shared'), second.capture('shared')]);
  assert.equal(records[0].beforeCommit, records[1].beforeCommit);
  await writeFile(path.join(cwd, 'tracked.txt'), 'agent');
  await second.finish('shared');
  await writeFile(path.join(cwd, 'untracked.txt'), 'later manual unchanged path');
  await manager.restore('shared');
  assert.equal(await readFile(path.join(cwd, 'untracked.txt'), 'utf8'), 'later manual unchanged path');
});

test('actual shutdown cancels in-flight and queued captures, and Git timeouts are bounded', async t => {
  let ready; const entered = new Promise(resolve => { ready = resolve; });
  const { cwd, manager } = await fixture(t, { runGit: (args, opts) => {
    if (!args.includes('ls-files')) return runGitCommand(args, opts);
    ready(); return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Error('cancelled runner')), { once: true }));
  } });
  const active = manager.capture('active'); const queued = manager.capture('queued');
  const observed = Promise.allSettled([active, queued]);
  await entered; await manager.shutdown();
  assert.deepEqual((await observed).map(r => r.status), ['rejected', 'rejected']);
  assert.deepEqual(await createCheckpointManager({ cwd, sessionId: 'session-a' }).list(), []);
  const timeout = await fixture(t, { limits: { gitTimeoutMs: 20 }, runGit: () => new Promise(() => {}) });
  const start = Date.now();
  await assert.rejects(timeout.manager.capture('timeout'), /time limit/i);
  assert.ok(Date.now() - start < 1000);
});

test('rollback refuses concurrent manual edits and retains explicit private recovery backups', async t => {
  let cwd;
  const current = await fixture(t, { runGit: async (args, opts) => {
    if (args.includes('update-ref')) { await writeFile(path.join(cwd, 'tracked.txt'), 'manual during restore'); throw Error('durable marker failed'); }
    return runGitCommand(args, opts);
  } });
  cwd = current.cwd;
  await current.manager.capture('race');
  await writeFile(path.join(cwd, 'tracked.txt'), 'agent-one');
  await writeFile(path.join(cwd, 'untracked.txt'), 'agent-two');
  await current.manager.finish('race');
  await assert.rejects(current.manager.restore('race'), error => {
    assert.equal(error.code, 'rollback-failed');
    assert.equal(error.details.failures[0].path, 'tracked.txt');
    assert.match(error.details.transaction, /^restore-/);
    return true;
  });
  assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'manual during restore');
  assert.equal(await readFile(path.join(cwd, 'untracked.txt'), 'utf8'), 'agent-two');
  const [session] = await readdir(path.join(cwd, '.apex/checkpoints'));
  const retained = (await readdir(path.join(cwd, '.apex/checkpoints', session))).filter(name => name.startsWith('restore-'));
  assert.equal(retained.length, 1);
});

test('large allowed blobs restore beyond textual Git output cap, and external shadow indirection is refused', async t => {
  const { cwd, manager } = await fixture(t, { limits: { maxGitOutputBytes: 1024 } });
  const original = Buffer.alloc(8192, 42);
  await writeFile(path.join(cwd, 'large.bin'), original);
  await manager.capture('large');
  await writeFile(path.join(cwd, 'large.bin'), Buffer.alloc(8192, 45));
  await manager.finish('large');
  await manager.restore('large');
  assert.deepEqual(await readFile(path.join(cwd, 'large.bin')), original);
  const second = await fixture(t);
  await second.manager.capture('external');
  await writeFile(path.join(second.cwd, 'tracked.txt'), 'agent');
  await second.manager.finish('external');
  const [session] = await readdir(path.join(second.cwd, '.apex/checkpoints'));
  await writeFile(path.join(second.cwd, '.apex/checkpoints', session, 'shadow/.git/commondir'), path.join(second.cwd, '.git'));
  const index = await indexHash(second.cwd);
  await assert.rejects(second.manager.restore('external'), /external indirection/i);
  assert.equal(await indexHash(second.cwd), index);
  assert.equal(await readFile(path.join(second.cwd, 'tracked.txt'), 'utf8'), 'agent');
});

test('untrusted shadow attributes cannot invoke source filters', async t => {
  const { cwd, manager } = await fixture(t);
  await manager.capture('filter');
  const [session] = await readdir(path.join(cwd, '.apex/checkpoints'));
  const metadata = path.join(cwd, '.apex/checkpoints', session, 'shadow/.git');
  await mkdir(path.join(metadata, 'info'), { recursive: true });
  await writeFile(path.join(metadata, 'info/attributes'), 'payload/* filter=hostile\n');
  await writeFile(path.join(cwd, 'untracked.txt'), 'agent change reaches the after snapshot\n');
  await assert.rejects(manager.finish('filter'), /custom attributes|indirection/i);
  assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'dirty source\n');
});

test('regular source/manifest replaced by FIFO after lstat refuses promptly at descriptor validation', {skip: unixOnly}, async t => {
  const moduleURL = new URL('../extensions/apex-features/checkpoints.mjs', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { execFileSync } from 'node:child_process';
    import path from 'node:path';
    import { createHash } from 'node:crypto';
    const [cwd, moduleURL, mode] = process.argv.slice(1);
    const sessionKey = createHash('sha256').update('session-a').digest('hex');
    const target = mode === 'source' ? path.join(cwd, 'tracked.txt') : path.join(cwd, '.apex/checkpoints', sessionKey, 'state.json');
    const original = fs.promises.lstat;
    let replaced = false;
    fs.promises.lstat = async (...args) => {
      const info = await original(...args);
      if (args[0] === target && !replaced) {
        replaced = true;
        await fs.promises.unlink(target);
        execFileSync('mkfifo', [target], { env: process.env });
      }
      return info;
    };
    syncBuiltinESMExports();
    const { createCheckpointManager } = await import(moduleURL);
    const manager = createCheckpointManager({ cwd, sessionId: 'session-a' });
    try {
      await (mode === 'source' ? manager.capture('fifo-race') : manager.list());
      throw Error('FIFO unexpectedly accepted');
    } catch (error) {
      process.stdout.write(JSON.stringify({ replaced, code: error.code, message: error.message }));
      if (!replaced || !['unsafe-path', 'metadata'].includes(error.code)) process.exitCode = 1;
    }
  `;
  for (const mode of ['source', 'manifest']) {
    const { cwd, manager } = await fixture(t);
    if (mode === 'manifest') await manager.capture('prepared');
    const result = await exec(process.execPath, ['--input-type=module', '-e', script, cwd, moduleURL, mode], { env: { ...env, PI_OFFLINE: '1', npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1' }, timeout: 3000, maxBuffer: 4096 });
    const refusal = JSON.parse(result.stdout);
    assert.equal(refusal.replaced, true);
    assert.match(refusal.message, /regular|type|unsafe/i);
  }
});

for (const mode of ['source', 'manifest']) test(`${mode} regular-file growth after fstat uses bounded chunk reads without readFile`, async t => {
  const { cwd, manager } = await fixture(t);
  if (mode === 'manifest') await manager.capture('prepared');
  const moduleURL = new URL('../extensions/apex-features/checkpoints.mjs', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import path from 'node:path';
    import { createHash } from 'node:crypto';
    const [cwd, moduleURL, mode] = process.argv.slice(1);
    const sessionKey = createHash('sha256').update('session-a').digest('hex');
    const target = mode === 'source' ? path.join(cwd, 'tracked.txt') : path.join(cwd, '.apex/checkpoints', sessionKey, 'state.json');
    const cap = mode === 'source' ? 128 : 4096;
    const originalOpen = fs.promises.open;
    let grown = false, unbounded = false, initialSize = 0, maxBuffer = 0, maxChunk = 0, totalRead = 0;
    fs.promises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] !== target) return handle;
      const originalStat = handle.stat.bind(handle);
      const originalRead = handle.read.bind(handle);
      handle.stat = async (...options) => {
        const info = await originalStat(...options);
        if (!grown) {
          initialSize = Number(info.size);
          fs.appendFileSync(target, Buffer.alloc(cap * 2, 45));
          grown = true;
        }
        return info;
      };
      handle.readFile = async () => { unbounded = true; throw Object.assign(Error('unbounded readFile was called'), { code: 'UNBOUNDED_READ' }); };
      handle.read = async (...options) => {
        maxBuffer = Math.max(maxBuffer, options[0].byteLength);
        maxChunk = Math.max(maxChunk, options[2]);
        const result = await originalRead(...options);
        totalRead += result.bytesRead;
        return result;
      };
      return handle;
    };
    syncBuiltinESMExports();
    const { createCheckpointManager } = await import(moduleURL);
    const reader = createCheckpointManager({ cwd, sessionId: 'session-a', limits: { maxFileBytes: 128, maxMetadataBytes: 4096 } });
    try {
      await (mode === 'source' ? reader.capture('growth') : reader.list());
      throw Error('growing file unexpectedly accepted');
    } catch (error) {
      const bound = Math.min(initialSize + 1, cap + 1);
      process.stdout.write(JSON.stringify({ grown, unbounded, initialSize, maxBuffer, maxChunk, totalRead, bound, code: error.code }));
      if (!grown || unbounded || !maxBuffer || maxBuffer > bound || maxChunk > 128 * 1024 || totalRead > bound || !['conflict', 'metadata'].includes(error.code)) process.exitCode = 1;
    }
  `;
  const result = await exec(process.execPath, ['--input-type=module', '-e', script, cwd, moduleURL, mode], { env: { ...env, PI_OFFLINE: '1', npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1' }, timeout: 3000, maxBuffer: 4096 });
  const read = JSON.parse(result.stdout);
  assert.equal(read.grown, true);
  assert.equal(read.unbounded, false);
  assert.ok(read.maxBuffer <= read.bound);
  assert.ok(read.maxChunk <= 128 * 1024);
  assert.ok(read.totalRead <= read.bound);
});
