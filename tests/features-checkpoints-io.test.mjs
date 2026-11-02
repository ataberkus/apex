import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat, symlink, link, utimes, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCheckpointManager } from '../extensions/apex-features/checkpoints.mjs';

// Batching, pooling and caching in the checkpoint module: the contracts they must keep, beyond the behavior that
// tests/features-checkpoints.test.mjs and the reference comparison in features-checkpoints-equivalence cover.
const exec = promisify(execFile);
const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
const liveBuiltins = fileURLToPath(new URL('../scripts/live-builtins.mjs', import.meta.url));
const moduleURL = new URL('../extensions/apex-features/checkpoints.mjs', import.meta.url).href;
const childEnv = fixtureArgs => ({ ...env, PI_OFFLINE: '1', npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1', CHECKPOINT_FIXTURE: JSON.stringify(fixtureArgs) });
const gitEnv = { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
const git = (cwd, args) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Checkpoint fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, env: gitEnv });
const runGitCommand = (args, opts) => { const execution = exec('git', args, opts); execution.child.stdin.on('error', () => {}); execution.child.stdin.end(opts.input); return execution; };
async function fixture(t, options = {}) {
  const cwd = await mkdtemp(path.join(process.cwd(), 'tests/.checkpoint-fixture-io-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await git(cwd, ['init', '--template=', '-q']);
  await writeFile(path.join(cwd, '.gitignore'), 'ignored/\n.apex/\n');
  await writeFile(path.join(cwd, 'tracked.txt'), 'committed\n');
  await git(cwd, ['add', '.']);
  await git(cwd, ['commit', '-qm', 'fixture']);
  return { cwd, manager: createCheckpointManager({ cwd, sessionId: 'session-a', ...options }) };
}
const sha256 = value => createHash('sha256').update(value).digest('hex');
const storeOf = cwd => path.join(cwd, '.apex/checkpoints', sha256('session-a'));
const payloadOf = (cwd, relative) => path.join(storeOf(cwd), 'shadow/payload', sha256(relative));
const blobOf = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const recordOf = async (cwd, turnId) => JSON.parse(await readFile(path.join(storeOf(cwd), 'state.json'), 'utf8')).records.find(record => record.turnId === turnId);
const treeOf = async (cwd, commit) => (await git(path.join(storeOf(cwd), 'shadow'), ['rev-parse', `${commit}^{tree}`])).stdout.trim();
// Holds a file open, so if it is removed and rewritten the new file cannot get the same inode number back.
async function pinned(t, file) { const handle = await open(file, 'r'); t.after(() => handle.close()); return (await handle.stat()).ino; }
// Runs `body` in a child Bun with live-builtins, so it can patch fs functions the checkpoint module imports by name.
async function child(t, cwd, body) {
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    const [cwd, moduleURL] = JSON.parse(process.env.CHECKPOINT_FIXTURE);
    const { createCheckpointManager } = await import(moduleURL);
    ${body}
  `;
  const result = await exec(process.execPath, ['--preload', liveBuiltins, '--input-type=module', '-e', script], { env: childEnv([cwd, moduleURL]), timeout: 20000, maxBuffer: 1 << 20 });
  return JSON.parse(result.stdout);
}

test('a collect runs one check-ignore however many files, and byte-capped batches keep every ignore decision', async t => {
  const inputs = [];
  const counting = (args, opts) => { if (args.includes('check-ignore')) inputs.push(Buffer.byteLength(opts.input)); return runGitCommand(args, opts); };
  const many = await fixture(t, { runGit: counting });
  for (let i = 0; i < 20; i++) await mkdir(path.join(many.cwd, `src/d${i}`), { recursive: true });
  await Promise.all(Array.from({ length: 1000 }, (_, i) => writeFile(path.join(many.cwd, `src/d${i % 20}/file-${i}.txt`), `content ${i}\n`)));
  assert.equal((await many.manager.capture('many')).skippedPaths.length, 0);
  assert.equal(inputs.length, 1);

  // Undo checks before and after paths together: under a 4 kB cap, 24 paths of ~300 bytes (each snapshot's 12 fit)
  // need two batches.
  for (const ignore of [false, true]) {
    const { cwd, manager } = await fixture(t, { runGit: counting, limits: { maxGitOutputBytes: 4096 } });
    const folder = `dir-${'d'.repeat(140)}`; await mkdir(path.join(cwd, folder));
    const name = (stage, i) => `${folder}/${stage}-${String(i).padStart(2, '0')}-${'x'.repeat(140)}.txt`;
    for (let i = 0; i < 12; i++) await writeFile(path.join(cwd, name('before', i)), `before ${i}`);
    await manager.capture('split');
    for (let i = 0; i < 12; i++) { await rm(path.join(cwd, name('before', i))); await writeFile(path.join(cwd, name('after', i)), `after ${i}`); }
    assert.equal((await manager.finish('split')).changedPaths.length, 24);
    // The last path sorts into the second batch, so refusing it proves that batch's output is used.
    if (ignore) await writeFile(path.join(cwd, '.gitignore'), `ignored/\n.apex/\n${name('before', 11)}\n`);
    inputs.length = 0;
    if (ignore) {
      await assert.rejects(manager.restore('split'), { code: 'ignored' });
      assert.equal(await readFile(path.join(cwd, name('after', 0)), 'utf8'), 'after 0');
    } else {
      assert.equal((await manager.restore('split')).status, 'restored');
      assert.equal(await readFile(path.join(cwd, name('before', 11)), 'utf8'), 'before 11');
    }
    assert.equal(inputs.length, 2);
    assert.ok(inputs.every(bytes => bytes <= 4096), JSON.stringify(inputs));
  }
});

test('cancelling mid-collect rejects only after every pooled source read has settled', async t => {
  const { cwd } = await fixture(t);
  await mkdir(path.join(cwd, 'src'));
  await Promise.all(Array.from({ length: 200 }, (_, i) => writeFile(path.join(cwd, `src/file-${i}.txt`), Buffer.alloc(4096, i))));
  const report = await child(t, cwd, `
    const controller = new AbortController();
    const originalOpen = fs.promises.open;
    let opens = 0, active = 0, late = 0, settledAt = null;
    const track = async work => { active++; try { return await work(); } finally { active--; if (settledAt !== null) late++; } };
    fs.promises.open = async (...args) => {
      if (!String(args[0]).startsWith(path.join(cwd, 'src'))) return originalOpen(...args);
      if (++opens === 8) controller.abort();
      const handle = await track(() => originalOpen(...args));
      for (const method of ['read', 'stat', 'close']) { const original = handle[method].bind(handle); handle[method] = (...rest) => track(() => original(...rest)); }
      return handle;
    };
    const manager = createCheckpointManager({ cwd, sessionId: 'session-a' });
    let code;
    try { await manager.capture('cancel', { signal: controller.signal }); } catch (error) { code = error.code; }
    settledAt = active;
    await new Promise(resolve => setTimeout(resolve, 100));
    process.stdout.write(JSON.stringify({ code, opens, activeAtRejection: settledAt, late, records: (await createCheckpointManager({ cwd, sessionId: 'session-a' }).list()).length }));
  `);
  assert.equal(report.code, 'cancelled');
  assert.ok(report.opens >= 8);
  assert.equal(report.activeAtRejection, 0);
  assert.equal(report.late, 0);
  assert.equal(report.records, 0);
});

test('state.json rewritten in place with the same length is reparsed and revalidated', async t => {
  const { cwd, manager } = await fixture(t);
  await manager.capture('abcd'); await writeFile(path.join(cwd, 'tracked.txt'), 'agent'); await manager.finish('abcd');
  const [session] = await readdir(path.join(cwd, '.apex/checkpoints'));
  const manifest = path.join(cwd, '.apex/checkpoints', session, 'state.json');
  const original = await readFile(manifest, 'utf8');
  assert.deepEqual((await manager.list()).map(record => record.turnId), ['abcd']);
  await writeFile(manifest, original.replaceAll('"abcd"', '"wxyz"'));
  assert.deepEqual((await manager.list()).map(record => record.turnId), ['wxyz']);
  await writeFile(manifest, original.replace('"version":1', '"version":2'));
  await assert.rejects(manager.list(), { code: 'metadata' });
  await writeFile(manifest, original);
  assert.equal((await manager.restore('abcd')).status, 'restored');
});

test('reused state is revalidated for a manager instance with stricter limits', async t => {
  const { cwd, manager } = await fixture(t);
  await writeFile(path.join(cwd, 'large.txt'), 'x'.repeat(100));
  await manager.capture('limits'); await writeFile(path.join(cwd, 'tracked.txt'), 'agent'); await manager.finish('limits');
  const strict = createCheckpointManager({ cwd, sessionId: 'session-a', limits: { maxFileBytes: 64 } });
  await assert.rejects(strict.list(), { code: 'metadata' });
  assert.deepEqual((await manager.list()).map(record => record.turnId), ['limits']);
  await assert.rejects(strict.restore('limits'), { code: 'metadata' });
  assert.equal((await manager.restore('limits')).status, 'restored');
});

test('a repeat capture is answered from memory only for a manager instance with the same limits', async t => {
  const { cwd, manager } = await fixture(t);
  await writeFile(path.join(cwd, 'large.txt'), 'x'.repeat(100));
  const strict = createCheckpointManager({ cwd, sessionId: 'session-a', limits: { maxFileBytes: 64 } });
  const small = createCheckpointManager({ cwd, sessionId: 'session-a', limits: { maxMetadataBytes: 256 } });
  const same = createCheckpointManager({ cwd, sessionId: 'session-a' });
  t.after(() => Promise.all([manager, strict, small, same].map(instance => instance.shutdown())));
  const first = await manager.capture('limits');
  // Right after the default instance's capture: the state it left breaks the stricter instance's limits.
  await assert.rejects(strict.capture('limits'), { code: 'metadata', message: 'Checkpoint file metadata is invalid' });
  await assert.rejects(strict.list(), { code: 'metadata' });
  assert.deepEqual(await manager.capture('limits'), first);
  await assert.rejects(strict.capture('limits'), { code: 'metadata', message: 'Checkpoint file metadata is invalid' });
  assert.deepEqual(await manager.capture('limits'), first);
  await assert.rejects(small.capture('limits'), { code: 'metadata', message: 'Checkpoint private file is unsafe or exceeds its cap' });
  assert.deepEqual(await manager.capture('limits'), first);
  assert.deepEqual(await same.capture('limits'), first);
});

test('a failed state save leaves no phantom record or status behind in the reused state', async t => {
  const { cwd } = await fixture(t);
  const report = await child(t, cwd, `
    const { createHash } = await import('node:crypto');
    const stateFile = path.join(cwd, '.apex/checkpoints', createHash('sha256').update('session-a').digest('hex'), 'state.json');
    const originalRename = fs.promises.rename; let failNext = false;
    fs.promises.rename = async (from, to) => {
      if (failNext && to === stateFile) { failNext = false; throw Object.assign(Error('injected rename failure'), { code: 'EIO' }); }
      return originalRename(from, to);
    };
    const manager = createCheckpointManager({ cwd, sessionId: 'session-a' });
    const statuses = async () => (await manager.list()).map(record => record.turnId + ':' + record.status);
    await manager.capture('kept');
    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'agent');
    failNext = true; const finishError = await manager.finish('kept').then(() => null, error => error.message);
    const afterFinish = await statuses();
    failNext = true; const captureError = await manager.capture('phantom').then(() => null, error => error.message);
    const afterCapture = await statuses();
    const retried = (await manager.finish('kept')).status;
    process.stdout.write(JSON.stringify({ finishError, afterFinish, captureError, afterCapture, retried, final: await statuses() }));
  `);
  assert.deepEqual(report, { finishError: 'injected rename failure', afterFinish: ['kept:captured'], captureError: 'injected rename failure', afterCapture: ['kept:captured'], retried: 'finished', final: ['kept:finished'] });
});

test('a repeat capture in the same turn reads no state until another job runs, and never outlives finish or shutdown', async t => {
  const { cwd } = await fixture(t);
  const report = await child(t, cwd, `
    const { createHash } = await import('node:crypto');
    const stateFile = path.join(cwd, '.apex/checkpoints', createHash('sha256').update('session-a').digest('hex'), 'state.json');
    let touches = 0;
    for (const name of ['open', 'lstat']) { const original = fs.promises[name]; fs.promises[name] = async (...args) => { if (args[0] === stateFile) touches++; return original(...args); }; }
    const manager = createCheckpointManager({ cwd, sessionId: 'session-a' });
    const first = await manager.capture('memo'); const afterFirst = touches;
    const repeats = []; for (let i = 0; i < 3; i++) repeats.push(await manager.capture('memo'));
    (await manager.capture('memo')).changedPaths.push('changed by a caller');
    const untouched = await manager.capture('memo'); const afterRepeats = touches;
    await manager.list(); const afterList = touches;
    const reloaded = await manager.capture('memo'); const afterReload = touches;
    // Another instance on the same session finishes the turn; the original instance must not answer from its memo.
    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'agent');
    const finished = await createCheckpointManager({ cwd, sessionId: 'session-a' }).finish('memo');
    const afterFinish = await manager.capture('memo');
    await manager.shutdown();
    const closed = await manager.capture('memo').then(() => 'resolved', error => error.code);
    process.stdout.write(JSON.stringify({ first, repeats, untouched, reloaded, afterFirst, afterRepeats, afterList, afterReload, finished, afterFinish, closed }));
  `);
  assert.equal(report.afterRepeats, report.afterFirst);
  for (const repeat of report.repeats) assert.deepEqual(repeat, report.first);
  assert.deepEqual(report.untouched, report.first);
  assert.ok(report.afterList > report.afterRepeats);
  assert.ok(report.afterReload > report.afterList);
  assert.deepEqual(report.reloaded, report.first);
  assert.equal(report.finished.status, 'finished');
  assert.deepEqual(report.afterFinish, report.finished);
  assert.equal(report.closed, 'closed');
});

test('snapshots keep unchanged mirror files, and a forced full rewrite of the same files yields the same tree', async t => {
  const { cwd, manager } = await fixture(t);
  for (const name of ['stable.txt', 'edited.txt']) await writeFile(path.join(cwd, name), `${name} original\n`);
  const inode = async relative => (await lstat(payloadOf(cwd, relative))).ino;
  await manager.capture('one');
  const stable = await pinned(t, payloadOf(cwd, 'stable.txt')); const edited = await pinned(t, payloadOf(cwd, 'edited.txt'));
  await writeFile(path.join(cwd, 'edited.txt'), 'edited by the agent\n');
  await manager.finish('one');
  assert.equal(await inode('stable.txt'), stable);
  assert.notEqual(await inode('edited.txt'), edited);
  const incremental = await treeOf(cwd, (await manager.capture('two')).beforeCommit);
  assert.equal(await inode('stable.txt'), stable);
  // shutdown drops the session's mirror map, so the next instance rewrites every file.
  await manager.shutdown();
  const reopened = createCheckpointManager({ cwd, sessionId: 'session-a' });
  const rewritten = await treeOf(cwd, (await reopened.capture('three')).beforeCommit);
  assert.notEqual(await inode('stable.txt'), stable);
  assert.equal(rewritten, incremental);
  for (const turn of ['one', 'two', 'three']) {
    for (const [name, file] of Object.entries((await recordOf(cwd, turn)).before)) {
      const bytes = turn === 'one' && name === 'edited.txt' ? Buffer.from('edited.txt original\n') : await readFile(path.join(cwd, name));
      assert.equal(file.blob, blobOf(bytes), `${turn} ${name}`);
    }
  }
  await reopened.shutdown();
});

test('mirror strays, links, directories and edits are removed or replaced without writing through them', { skip: process.platform === 'win32' && 'POSIX links' }, async t => {
  const { cwd, manager } = await fixture(t);
  const names = ['same-size.txt', 'removed.txt', 'symlinked.txt', 'hardlinked.txt', 'directory.txt', 'aliased.txt', 'kept.txt'];
  for (const name of names) await writeFile(path.join(cwd, name), `${name} content\n`);
  await mkdir(path.join(cwd, 'ignored'));
  for (const name of ['outside-a.txt', 'outside-b.txt']) await writeFile(path.join(cwd, 'ignored', name), `${name} must stay\n`);
  await manager.capture('one'); await writeFile(path.join(cwd, 'tracked.txt'), 'agent'); await manager.finish('one');
  const payload = path.join(storeOf(cwd), 'shadow/payload');
  const kept = await pinned(t, payloadOf(cwd, 'kept.txt'));
  await writeFile(payloadOf(cwd, 'same-size.txt'), 'XXXX-XXXX.txt content\n');
  await rm(payloadOf(cwd, 'removed.txt'));
  await rm(payloadOf(cwd, 'symlinked.txt')); await symlink(path.join(cwd, 'ignored/outside-a.txt'), payloadOf(cwd, 'symlinked.txt'));
  await rm(payloadOf(cwd, 'hardlinked.txt')); await link(path.join(cwd, 'ignored/outside-b.txt'), payloadOf(cwd, 'hardlinked.txt'));
  await rm(payloadOf(cwd, 'directory.txt')); await mkdir(payloadOf(cwd, 'directory.txt')); await writeFile(path.join(payloadOf(cwd, 'directory.txt'), 'inner'), 'inner');
  // A hard link made from outside to a mirror file shares its inode: the snapshot must replace the file, not write the alias.
  await link(payloadOf(cwd, 'aliased.txt'), path.join(cwd, 'ignored/alias'));
  await writeFile(path.join(payload, sha256('stray')), 'stray'); await mkdir(path.join(payload, 'stray-directory'));
  await manager.capture('two');
  assert.equal((await lstat(payloadOf(cwd, 'kept.txt'))).ino, kept);
  assert.deepEqual((await readdir(payload)).sort(), [...names, '.gitignore', 'tracked.txt'].map(sha256).sort());
  for (const name of ['outside-a.txt', 'outside-b.txt']) assert.equal(await readFile(path.join(cwd, 'ignored', name), 'utf8'), `${name} must stay\n`);
  assert.equal(await readFile(path.join(cwd, 'ignored/alias'), 'utf8'), 'aliased.txt content\n');
  const record = await recordOf(cwd, 'two');
  for (const name of names) {
    assert.equal(record.before[name].blob, blobOf(Buffer.from(`${name} content\n`)), name);
    const info = await lstat(payloadOf(cwd, name));
    assert.ok(info.isFile() && info.nlink === 1, name);
    assert.equal(await readFile(payloadOf(cwd, name), 'utf8'), `${name} content\n`);
  }
  for (const name of names) await writeFile(path.join(cwd, name), 'agent');
  await manager.finish('two');
  assert.equal((await manager.restore('two')).status, 'restored');
  for (const name of names) assert.equal(await readFile(path.join(cwd, name), 'utf8'), `${name} content\n`);
});

// Points a shadow index entry at another blob while keeping its stat data current, the way a tampered index would
// make `git add` trust it. Extensions (the cached tree) are dropped so the commit rebuilds trees from the entries.
async function misdirectIndex(shadow, entryName, blob, file) {
  const index = path.join(shadow, '.git/index');
  const data = await readFile(index);
  assert.equal(data.toString('latin1', 0, 4), 'DIRC'); assert.equal(data.readUInt32BE(4), 2);
  let offset = 12; let found = false;
  for (let i = 0, count = data.readUInt32BE(8); i < count; i++) {
    const end = data.indexOf(0, offset + 62);
    if (data.toString('utf8', offset + 62, end) === entryName) {
      // Only the size: Git zeroes it on a racily clean entry. The other stat fields stay as Git recorded them from its own
      // lstat, which on Git for Windows differs from Bun's (ctime is the creation time; dev, ino, uid and gid are its own).
      data.writeUInt32BE(Number((await lstat(file)).size) >>> 0, offset + 36);
      Buffer.from(blob, 'hex').copy(data, offset + 40); found = true;
    }
    offset += (Math.floor((end - offset) / 8) + 1) * 8;
  }
  assert.ok(found);
  const entries = data.subarray(0, offset);
  await writeFile(index, Buffer.concat([entries, createHash('sha1').update(entries).digest()]));
  // An index newer than the file makes the entry not racily clean, so Git trusts its stat data instead of rehashing.
  const later = new Date(Date.now() + 60000); await utimes(index, later, later);
}

test('a kept mirror file that Git maps to the wrong blob falls back to a full rewrite with the true blob', async t => {
  const { cwd, manager } = await fixture(t);
  await writeFile(path.join(cwd, 'stable.txt'), 'stable content\n');
  await manager.capture('one');
  const shadow = path.join(storeOf(cwd), 'shadow');
  const stable = await pinned(t, payloadOf(cwd, 'stable.txt'));
  const wrong = blobOf(Buffer.from('committed\n'));
  await misdirectIndex(shadow, `payload/${sha256('stable.txt')}`, wrong, payloadOf(cwd, 'stable.txt'));
  await writeFile(path.join(cwd, 'tracked.txt'), 'agent');
  const finished = await manager.finish('one');
  // The incremental attempt kept the file and Git reused the misdirected entry; the fallback rewrote the mirror.
  assert.notEqual((await lstat(payloadOf(cwd, 'stable.txt'))).ino, stable);
  assert.notEqual((await treeOf(cwd, `${finished.afterCommit}~1`)), await treeOf(cwd, finished.afterCommit));
  assert.match((await git(shadow, ['ls-tree', `${finished.afterCommit}~1`, `payload/${sha256('stable.txt')}`])).stdout, new RegExp(wrong));
  const record = await recordOf(cwd, 'one');
  assert.equal(record.after['stable.txt'].blob, blobOf(Buffer.from('stable content\n')));
  assert.equal((await manager.restore('one')).status, 'restored');
  assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'committed\n');
});

test('a written mirror file whose stored blob does not match its bytes is rewritten next time, not kept', async t => {
  // Git reporting another blob for freshly written bytes means they changed before `git add` read them. The record
  // keeps what Git stored, as before; the file must not be trusted as kept by the next snapshot.
  const truth = blobOf(Buffer.from('stable content\n')); const other = blobOf(Buffer.from('committed\n'));
  let lie = true;
  const { cwd, manager } = await fixture(t, { runGit: async (args, opts) => {
    const result = await runGitCommand(args, opts);
    if (lie && args.includes('ls-tree')) { lie = false; return { ...result, stdout: result.stdout.replace(truth, other) }; }
    return result;
  } });
  await writeFile(path.join(cwd, 'stable.txt'), 'stable content\n');
  await manager.capture('one');
  assert.equal((await recordOf(cwd, 'one')).before['stable.txt'].blob, other);
  const stable = await pinned(t, payloadOf(cwd, 'stable.txt')); const tracked = await pinned(t, payloadOf(cwd, 'tracked.txt'));
  await writeFile(path.join(cwd, '.gitignore'), 'ignored/\n.apex/\n# agent\n');
  await manager.finish('one');
  assert.notEqual((await lstat(payloadOf(cwd, 'stable.txt'))).ino, stable);
  assert.equal((await lstat(payloadOf(cwd, 'tracked.txt'))).ino, tracked);
  assert.equal((await recordOf(cwd, 'one')).after['stable.txt'].blob, truth);
});

test('a snapshot whose mirror writes fail for several files reports the first in order, as a sequential write did', async t => {
  const { cwd } = await fixture(t);
  await writeFile(path.join(cwd, 'a.txt'), 'a'); await writeFile(path.join(cwd, 'b.txt'), 'bb');
  const report = await child(t, cwd, `
    const { createHash } = await import('node:crypto');
    const sha256 = value => createHash('sha256').update(value).digest('hex');
    const payload = relative => path.join(cwd, '.apex/checkpoints', sha256('session-a'), 'shadow/payload', sha256(relative));
    // a.txt is written first (smallest file) but fails after b.txt has.
    const originalWriteFile = fs.promises.writeFile;
    fs.promises.writeFile = async (file, ...rest) => {
      if (file === payload('a.txt')) { await new Promise(resolve => setTimeout(resolve, 100)); throw Object.assign(Error('a.txt write failed'), { code: 'EIO' }); }
      if (file === payload('b.txt')) throw Object.assign(Error('b.txt write failed'), { code: 'EIO' });
      return originalWriteFile(file, ...rest);
    };
    const manager = createCheckpointManager({ cwd, sessionId: 'session-a' });
    process.stdout.write(JSON.stringify({ error: await manager.capture('one').then(() => null, error => error.message) }));
  `);
  assert.deepEqual(report, { error: 'a.txt write failed' });
});

test('a snapshot with nothing to store leaves no payload directory behind', async t => {
  const { cwd, manager } = await fixture(t);
  await manager.capture('empty');
  await lstat(path.join(storeOf(cwd), 'shadow/payload'));
  // Everything is now ignored, .gitignore included, so the after snapshot holds no file while the mirror is known.
  await writeFile(path.join(cwd, '.gitignore'), '*\n');
  const finished = await manager.finish('empty');
  assert.deepEqual(finished.changedPaths, ['.gitignore', 'tracked.txt']);
  await assert.rejects(lstat(path.join(storeOf(cwd), 'shadow/payload')), { code: 'ENOENT' });
});

test('two manager instances alternating on one session share the mirror and restore every turn', async t => {
  const { cwd, manager } = await fixture(t);
  const second = createCheckpointManager({ cwd, sessionId: 'session-a' });
  t.after(() => second.shutdown());
  const instances = [manager, second];
  for (let turn = 1; turn <= 4; turn++) {
    await instances[turn % 2].capture(`turn-${turn}`);
    await writeFile(path.join(cwd, 'tracked.txt'), `agent ${turn}`); await writeFile(path.join(cwd, `added-${turn}.txt`), `${turn}`);
    assert.deepEqual((await instances[(turn + 1) % 2].finish(`turn-${turn}`)).changedPaths, [`added-${turn}.txt`, 'tracked.txt']);
  }
  for (let turn = 4; turn >= 1; turn--) {
    assert.equal((await instances[turn % 2].restore(`turn-${turn}`)).status, 'restored');
    assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), turn === 1 ? 'committed\n' : `agent ${turn - 1}`);
    await assert.rejects(readFile(path.join(cwd, `added-${turn}.txt`)), { code: 'ENOENT' });
  }
});

test('auto-gc triggered by a shadow commit finishes inside the job instead of racing later store walks', async t => {
  const commits = [];
  const { cwd, manager } = await fixture(t, { runGit: (args, opts) => { if (args.includes('commit')) commits.push(opts.env); return runGitCommand(args, opts); } });
  await manager.capture('gc');
  // Git estimates loose objects from objects/17 alone (more than 27 there means past gc.auto's 6,700). These are
  // unreachable and old, so a completed gc prunes them.
  const objects = path.join(storeOf(cwd), 'shadow/.git/objects'); const seeded = [];
  for (let i = 0; seeded.length < 40; i++) {
    const body = Buffer.from(`seed ${i}\n`); const object = Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]);
    const id = createHash('sha1').update(object).digest('hex');
    if (id.startsWith('17')) seeded.push({ id, object });
  }
  await mkdir(path.join(objects, '17'), { recursive: true });
  const old = new Date('2020-01-01T00:00:00Z');
  for (const { id, object } of seeded) { const file = path.join(objects, '17', id.slice(2)); await writeFile(file, deflateSync(object)); await utimes(file, old, old); }
  await writeFile(path.join(cwd, 'tracked.txt'), 'agent');
  await manager.finish('gc');
  const remaining = await readdir(path.join(objects, '17')).catch(() => []);
  assert.equal(seeded.filter(({ id }) => remaining.includes(id.slice(2))).length, 0);
  await assert.rejects(lstat(path.join(storeOf(cwd), 'shadow/.git/gc.pid')), { code: 'ENOENT' });
  // Through the environment, so the command line (quoted by Git's error messages) is unchanged.
  assert.equal(commits.length, 2);
  for (const env of commits) assert.deepEqual([env.GIT_CONFIG_COUNT, env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0, env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1], ['2', 'gc.autoDetach', 'false', 'maintenance.autoDetach', 'false']);
  assert.equal((await manager.restore('gc')).status, 'restored');
  assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'committed\n');
});

// Stat-cache tests shorten the racy window (statWindowMs) and wait past it, so files are trusted once unchanged.
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
test('the stat cache notices same-size rewrites with restored mtime, and rename replacements', { skip: process.platform === 'win32' && 'The stat cache is off on Windows' }, async t => {
  const { cwd, manager } = await fixture(t, { statWindowMs: 10 });
  const { rename } = await import('node:fs/promises');
  // Whole-second mtimes, so putting one back below is exact to the nanosecond.
  const second = new Date('2020-01-01T00:00:00Z');
  for (const name of ['same.txt', 'renamed.txt']) { await writeFile(path.join(cwd, name), `${name} before\n`); await utimes(path.join(cwd, name), second, second); }
  await settle(40);
  await manager.capture('stat');
  // Same length, same mtime: only the change time tells.
  await writeFile(path.join(cwd, 'same.txt'), 'same.txt AFTER!\n'); await utimes(path.join(cwd, 'same.txt'), second, second);
  // Same length and mtime, new inode.
  await writeFile(path.join(cwd, 'replacement'), 'renamed.txt AFTER!\n'); await utimes(path.join(cwd, 'replacement'), second, second);
  await rename(path.join(cwd, 'replacement'), path.join(cwd, 'renamed.txt'));
  assert.deepEqual((await manager.finish('stat')).changedPaths, ['renamed.txt', 'same.txt']);
  assert.equal((await manager.restore('stat')).status, 'restored');
  for (const name of ['same.txt', 'renamed.txt']) assert.equal(await readFile(path.join(cwd, name), 'utf8'), `${name} before\n`);
});

test('a cache-hit file whose directory turns into a symlink after check-ignore is refused as sourceFile would', { skip: process.platform === 'win32' && 'The stat cache is off on Windows' }, async t => {
  const { cwd } = await fixture(t);
  await mkdir(path.join(cwd, 'dir')); await mkdir(path.join(cwd, 'ignored'));
  await writeFile(path.join(cwd, 'dir/file.txt'), 'file before\n');
  await settle(40);
  // check-ignore itself refuses a path beyond a symlink, so the swap lands right after the file's sizing lstat. The file
  // keeps its inode and times when its directory moves, so only the ancestor check can tell.
  const report = await child(t, cwd, `
    const target = path.join(cwd, 'dir/file.txt'); const originalLstat = fs.promises.lstat; let armed = false;
    fs.promises.lstat = async (...args) => {
      const info = await originalLstat(...args);
      if (armed && args[0] === target && args[1]?.bigint) { armed = false; fs.renameSync(path.join(cwd, 'dir'), path.join(cwd, 'ignored/moved')); fs.symlinkSync(path.join(cwd, 'ignored/moved'), path.join(cwd, 'dir')); }
      return info;
    };
    const manager = createCheckpointManager({ cwd, sessionId: 'session-a', statWindowMs: 10 });
    await manager.capture('one'); fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'agent'); await manager.finish('one');
    armed = true;
    const error = await manager.capture('two').then(() => null, error => ({ code: error.code, message: error.message }));
    process.stdout.write(JSON.stringify({ swapped: !armed, error }));
  `);
  assert.deepEqual(report, { swapped: true, error: { code: 'symlink', message: 'Checkpoint path has a symlink ancestor' } });
});

test('the stat cache reads a file again when only its inode or device number differs', { skip: process.platform === 'win32' && 'The stat cache is off on Windows' }, async t => {
  const { cwd } = await fixture(t);
  await writeFile(path.join(cwd, 'same.txt'), 'same before\n');
  await settle(40);
  // A real replacement also bumps the change time, which alone forces a read; fake the one field instead.
  const report = await child(t, cwd, `
    const target = path.join(cwd, 'same.txt'); const originalLstat = fs.promises.lstat; let field;
    fs.promises.lstat = async (...args) => {
      const info = await originalLstat(...args);
      if (!field || args[0] !== target || !args[1]?.bigint) return info;
      const faked = field; field = undefined;
      return new Proxy(info, { get: (stats, key) => key === faked ? stats[key] + 1n : typeof stats[key] === 'function' ? stats[key].bind(stats) : stats[key] });
    };
    const originalOpen = fs.promises.open; let opened = [];
    fs.promises.open = async (...args) => { const file = String(args[0]); if (file.startsWith(cwd + path.sep) && !file.includes(path.sep + '.apex' + path.sep)) opened.push(path.relative(cwd, file)); return originalOpen(...args); };
    const manager = createCheckpointManager({ cwd, sessionId: 'session-a', statWindowMs: 10 });
    const out = {};
    for (const [index, name] of ['ino', 'dev'].entries()) {
      await manager.capture('turn-' + index); opened = [];
      field = name; const status = (await manager.finish('turn-' + index)).status;
      out[name] = { faked: !field, status, opened: [...opened].sort() };
    }
    process.stdout.write(JSON.stringify(out));
  `);
  for (const name of ['ino', 'dev']) assert.deepEqual(report[name], { faked: true, status: 'unchanged', opened: ['same.txt'] }, name);
});

test('an unchanged file is not read again until its times leave the racy window, mtime and ctime both', { skip: process.platform === 'win32' && 'The stat cache is off on Windows' }, async t => {
  const { cwd } = await fixture(t);
  for (const name of ['a.txt', 'b.txt', 'touched.txt']) await writeFile(path.join(cwd, name), `${name}\n`);
  // The window must outlast the gap between touching touched.txt and the child's first read of it (a few process
  // spawns), even on a loaded machine.
  await settle(1700);
  const report = await child(t, cwd, `
    const originalOpen = fs.promises.open; let opened = [];
    fs.promises.open = async (...args) => { const file = String(args[0]); if (file.startsWith(cwd + path.sep) && !file.includes(path.sep + '.apex' + path.sep)) opened.push(path.relative(cwd, file)); return originalOpen(...args); };
    const take = () => { const names = [...opened].sort(); opened = []; return names; };
    // An old mtime but a fresh ctime (utimes itself changes the ctime) keeps this file racy for the next read.
    fs.utimesSync(path.join(cwd, 'touched.txt'), new Date('2020-01-01'), new Date('2020-01-01'));
    const manager = createCheckpointManager({ cwd, sessionId: 'session-a', statWindowMs: 1500 });
    await manager.capture('one'); const first = take();
    const unchanged = (await manager.finish('one')).status; const second = take();
    await manager.capture('two'); const third = take();
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'a.txt edited\\n');
    const changed = (await manager.finish('two')).changedPaths; const fourth = take();
    process.stdout.write(JSON.stringify({ first, unchanged, second, third, changed, fourth }));
  `);
  assert.deepEqual(report.first, ['.gitignore', 'a.txt', 'b.txt', 'touched.txt', 'tracked.txt']);
  assert.equal(report.unchanged, 'unchanged');
  assert.deepEqual(report.second, ['touched.txt']);
  assert.deepEqual(report.third.filter(name => name !== 'touched.txt'), []);
  assert.deepEqual(report.changed, ['a.txt']);
  assert.deepEqual(report.fourth.filter(name => name !== 'touched.txt'), ['a.txt']);
});

test('a cache-hit file the mirror must rewrite is read then and refused if it changed since collect', { skip: process.platform === 'win32' && 'The stat cache is off on Windows' }, async t => {
  const { cwd } = await fixture(t);
  await writeFile(path.join(cwd, 'stable.txt'), 'stable before\n');
  await settle(40);
  const report = await child(t, cwd, `
    const { createHash } = await import('node:crypto');
    const sha256 = value => createHash('sha256').update(value).digest('hex');
    const shadow = path.join(cwd, '.apex/checkpoints', sha256('session-a'), 'shadow');
    const originalReaddir = fs.promises.readdir; let armed = false;
    // Snapshot starts by listing the shadow worktree: change the source after collect described it.
    fs.promises.readdir = async (...args) => {
      if (armed && args[0] === shadow && args[1]?.withFileTypes) { armed = false; fs.writeFileSync(path.join(cwd, 'stable.txt'), 'stable AFTER!\\n'); }
      return originalReaddir(...args);
    };
    const manager = createCheckpointManager({ cwd, sessionId: 'session-a', statWindowMs: 10 });
    await manager.capture('one'); fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'agent'); await manager.finish('one');
    // The mirror lost the file, so the next snapshot must write it although collect trusted its cached hash.
    fs.rmSync(path.join(shadow, 'payload', sha256('stable.txt')));
    armed = true;
    const error = await manager.capture('two').then(() => null, error => ({ code: error.code, message: error.message }));
    const retried = (await manager.capture('two')).status;
    process.stdout.write(JSON.stringify({ error, retried, records: (await manager.list()).map(record => record.turnId) }));
  `);
  assert.deepEqual(report, { error: { code: 'conflict', message: 'Checkpoint source changed during snapshot' }, retried: 'captured', records: ['one', 'two'] });
});
