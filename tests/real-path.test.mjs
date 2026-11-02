import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';
import {createCheckpointManager} from '../extensions/apex-features/checkpoints.mjs';
import {linkFreeRealpath} from '../lib/real-path.mjs';
import {checkpointsUsable} from '../lib/windows-target.mjs';
import {directoryLink, fileLink, shortPath} from './fixtures/filesystem.mjs';

const exec = promisify(execFile);
const windowsOnly = process.platform !== 'win32' && 'Windows 8.3 names and drive-letter case';
const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
const git = (cwd, args) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Real path fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', ...args],
  {cwd, env: {...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0'}});

// The names run past eight characters so a volume with 8.3 names gives each its own short alias.
async function repository(t) {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'apex-real-path-')));
  t.after(() => rmSync(base, {recursive: true, force: true}));
  const cwd = path.join(base, 'a-long-project-directory');
  mkdirSync(cwd);
  await git(cwd, ['init', '--template=', '-q']);
  writeFileSync(path.join(cwd, '.gitignore'), '.apex/\n');
  writeFileSync(path.join(cwd, 'tracked.txt'), 'committed\n');
  await git(cwd, ['add', '.']);
  await git(cwd, ['commit', '-qm', 'fixture']);
  return {base, cwd};
}
function shortened(t, target) {
  const short = shortPath(target);
  if (short === target) t.skip('This volume has no 8.3 names; the short spelling is unexercised');
  return short === target ? undefined : short;
}

test('linkFreeRealpath maps another spelling of the same entries to the canonical path and refuses a junction, however it is spelled', {skip: windowsOnly}, async t => {
  const {base, cwd} = await repository(t);
  assert.equal(await linkFreeRealpath(cwd), cwd);
  assert.equal(await linkFreeRealpath(cwd[0].toLowerCase() + cwd.slice(1)), cwd, 'drive letter case');
  assert.equal(await linkFreeRealpath(cwd.toUpperCase()), cwd, 'component case');
  const short = shortened(t, cwd);
  if (!short) return;
  assert.equal(await linkFreeRealpath(short), cwd);

  const link = path.join(base, 'a-long-junction-name');
  await directoryLink(base, link);
  assert.equal(await linkFreeRealpath(link), undefined);
  const through = path.join(link, 'a-long-project-directory');
  assert.equal(await linkFreeRealpath(through), undefined);
  const hidden = shortPath(through);
  assert.notEqual(hidden, through);
  assert.equal(await linkFreeRealpath(hidden), undefined, 'a short alias of the junction itself');
});

test('linkFreeRealpath refuses a directory symlink ancestor', async t => {
  const {base, cwd} = await repository(t);
  const link = path.join(base, 'a-long-symlink-name');
  if (!await fileLink(t, base, link, 'dir')) return;
  assert.equal(await linkFreeRealpath(cwd), cwd);
  assert.equal(await linkFreeRealpath(path.join(link, path.basename(cwd))), undefined);
});

test('checkpoints capture and restore from a short path and still refuse link ancestors', {skip: windowsOnly, timeout: 120000}, async t => {
  const {base, cwd} = await repository(t);
  const short = shortened(t, cwd);
  if (!short) return;
  const manager = createCheckpointManager({cwd: short, sessionId: 'short-path'});
  t.after(() => manager.shutdown());
  await manager.capture('turn');
  await writeFile(path.join(short, 'tracked.txt'), 'mutated\n');
  await manager.finish('turn');
  assert.deepEqual((await manager.list()).map(entry => entry.turnId), ['turn']);
  await manager.restore('turn');
  assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'committed\n');

  // state.json is shared across spellings: the session resumes under the long path and a lowercase drive letter.
  for (const spelling of [cwd, cwd[0].toLowerCase() + cwd.slice(1)]) {
    const resumed = createCheckpointManager({cwd: spelling, sessionId: 'short-path'});
    t.after(() => resumed.shutdown());
    assert.deepEqual((await resumed.list()).map(entry => entry.turnId), ['turn']);
  }

  const link = path.join(base, 'a-long-junction-name');
  await directoryLink(base, link);
  const through = path.join(link, path.basename(cwd));
  for (const spelling of [through, shortPath(through)]) {
    const linked = createCheckpointManager({cwd: spelling, sessionId: 'linked'});
    t.after(() => linked.shutdown());
    await assert.rejects(linked.list(), {code: 'symlink', message: 'Checkpoint cwd must be a real directory without symlink ancestors'});
  }
});

test('checkpoints refuse a directory symlink ancestor', async t => {
  const {base, cwd} = await repository(t);
  const link = path.join(base, 'a-long-symlink-name');
  if (!await fileLink(t, base, link, 'dir')) return;
  const manager = createCheckpointManager({cwd: path.join(link, path.basename(cwd)), sessionId: 'symlinked'});
  t.after(() => manager.shutdown());
  await assert.rejects(manager.list(), {code: 'symlink'});
});

test('bare Windows apex keeps checkpoints on a short path and drops them behind a junction', {skip: windowsOnly}, async t => {
  const {base, cwd} = await repository(t);
  const short = shortened(t, cwd);
  if (!short) return;
  assert.equal(checkpointsUsable(short), true);
  const link = path.join(base, 'a-long-junction-name');
  await directoryLink(base, link);
  assert.equal(checkpointsUsable(path.join(link, path.basename(cwd))), false);
});
