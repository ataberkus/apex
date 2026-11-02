import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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
