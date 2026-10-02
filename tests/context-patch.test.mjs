import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile, mkdir, readdir, chmod, stat} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {createEditToolDefinition} from '@earendil-works/pi-coding-agent';
import {fileLink, unixOnly} from './fixtures/filesystem.mjs';

const load = () => import('../extensions/apex-context/patch.mjs').catch(() => ({}));
const patchFor = (name = 'file.txt', from = 'two', to = 'TWO') => `--- a/${name}\n+++ b/${name}\n@@ -1,3 +1,3 @@\n one\n-${from}\n+${to}\n three\n`;
async function fixture(t, content = 'one\ntwo\nthree\n') {
  const cwd = await mkdtemp(path.join(process.cwd(), '.patch-test-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  await writeFile(path.join(cwd, 'file.txt'), content);
  const {createPatchTool} = await load();
  assert.equal(typeof createPatchTool, 'function', 'single-file patch tool missing');
  return {cwd, tool: createPatchTool({cwd}), file: path.join(cwd, 'file.txt')};
}

test('single-file unified patch uses exact context and compact coherent result', async t => {
  const {cwd, tool, file} = await fixture(t);
  assert.equal(tool.name, 'apply_patch');
  const result = await tool.execute('p', {patch: patchFor()}, undefined, undefined, {cwd});
  assert.equal(await readFile(file, 'utf8'), 'one\nTWO\nthree\n');
  assert.match(result.content[0].text, /TWO/);
  assert.equal(result.structuredContent.text, result.content[0].text);
});

test('multiple hunks have strict old/new positions and preserve BOM/CRLF', async t => {
  const {cwd, tool, file} = await fixture(t, '\ufeffone\r\ntwo\r\nthree\r\nfour\r\n');
  const patch = '--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,3 @@\n one\n+inserted\n two\n@@ -4 +5 @@\n-four\n+FOUR\n';
  await tool.execute('p', {patch}, undefined, undefined, {cwd});
  assert.equal(await readFile(file, 'utf8'), '\ufeffone\r\ninserted\r\ntwo\r\nthree\r\nFOUR\r\n');
});

test('no-newline markers faithfully change final newline status', async t => {
  const {cwd, tool, file} = await fixture(t, 'one\ntwo');
  const patch = '--- file.txt\n+++ file.txt\n@@ -2 +2 @@\n-two\n\\ No newline at end of file\n+TWO\n';
  await tool.execute('p', {patch}, undefined, undefined, {cwd});
  assert.equal(await readFile(file, 'utf8'), 'one\nTWO\n');
  const reverse = '--- file.txt\n+++ file.txt\n@@ -2 +2 @@\n-TWO\n+last\n\\ No newline at end of file\n';
  await tool.execute('p2', {patch: reverse}, undefined, undefined, {cwd});
  assert.equal(await readFile(file, 'utf8'), 'one\nlast');
});

test('invalid counts, context, new offsets, overlaps and unsupported formats never write', async t => {
  const {cwd, tool, file} = await fixture(t);
  const original = await readFile(file);
  const invalid = [
    patchFor().replace('@@ -1,3 +1,3 @@', '@@ -1,4 +1,3 @@'),
    patchFor().replace('@@ -1,3 +1,3 @@', '@@ -1,3 +2,3 @@'),
    patchFor().replace(' two', ' TWO').replace('-two', '-two '),
    patchFor() + '@@ -2 +2 @@\n-two\n+again\n',
    patchFor() + patchFor('other.txt'),
    patchFor().replace('--- a/file.txt', '--- /dev/null'),
    patchFor().replace('+++ b/file.txt', '+++ /dev/null'),
    patchFor().replace('+++ b/file.txt', '+++ b/other.txt'),
    patchFor().replace('a/file.txt', 'a/../file.txt').replace('b/file.txt', 'b/../file.txt'),
    '*** Begin Patch\n*** Update File: file.txt\n@@\n-two\n+TWO\n*** End Patch',
    'diff --git a/file.txt b/file.txt\n' + patchFor(),
    patchFor().replace(' one\n', 'one\n'),
    patchFor().replace('@@ -1,3 +1,3 @@', '@@ -0,3 +0,3 @@'),
  ];
  for (const patch of invalid) {
    await assert.rejects(tool.execute('bad', {patch}, undefined, undefined, {cwd}));
    assert.deepEqual(await readFile(file), original);
  }
});

test('later hunk failure is atomic, missing files are rejected and runtime cwd wins', async t => {
  const {cwd, tool, file} = await fixture(t);
  const original = await readFile(file);
  await assert.rejects(tool.execute('bad', {patch: patchFor() + '@@ -4 +4 @@\n-nope\n+yep\n'}, undefined, undefined, {cwd}));
  assert.deepEqual(await readFile(file), original);
  await assert.rejects(tool.execute('missing', {patch: patchFor('missing.txt')}, undefined, undefined, {cwd}), /existing|ENOENT/);
  const other = path.join(cwd, 'other');
  await mkdir(other);
  await writeFile(path.join(other, 'file.txt'), original);
  await tool.execute('p', {patch: patchFor()}, undefined, undefined, {cwd: other});
  assert.deepEqual(await readFile(file), original);
  assert.equal(await readFile(path.join(other, 'file.txt'), 'utf8'), 'one\nTWO\nthree\n');
});

test('patch and native edit siblings share queue including symlinks; aborted calls do not write', async t => {
  const {cwd, tool, file} = await fixture(t);
  await t.test('file symlink queue alias', async t => {
    if (!await fileLink(t, file, path.join(cwd, 'alias.txt'))) return;
    const native = createEditToolDefinition(cwd);
    await Promise.all([
      tool.execute('p', {patch: '--- file.txt\n+++ file.txt\n@@ -2 +2 @@\n-two\n+TWO\n'}, undefined, undefined, {cwd}),
      native.execute('e', {path: 'alias.txt', edits: [{oldText: 'three', newText: 'THREE'}]}, undefined, undefined, {cwd}),
    ]);
    assert.equal(await readFile(file, 'utf8'), 'one\nTWO\nTHREE\n');
  });
  const before = await readFile(file);
  await assert.rejects(tool.execute('abort', {patch: '--- file.txt\n+++ file.txt\n@@ -2 +2 @@\n-TWO\n+again\n'}, AbortSignal.abort(), undefined, {cwd}), /aborted/);
  assert.deepEqual(await readFile(file), before);
});

test('mixed unchanged line endings, mode bits and temp cleanup survive atomic replacement', async t => {
  const {cwd, tool, file} = await fixture(t, 'one\r\ntwo\nthree\r\n');
  await chmod(file, 0o640);
  await tool.execute('p', {patch: '--- file.txt\n+++ file.txt\n@@ -2 +2 @@\n-two\n+TWO\n'}, undefined, undefined, {cwd});
  assert.equal(await readFile(file, 'utf8'), 'one\r\nTWO\r\nthree\r\n');
  await t.test('POSIX mode preserved', {skip: unixOnly}, async () => {
    assert.equal((await stat(file)).mode & 0o777, 0o640);
  });
  assert.deepEqual(await readdir(cwd), ['file.txt']);
});

test('patch rejects binary/invalid UTF8, traversal and outside-cwd symlinks with no partial write', async t => {
  const {cwd, tool, file} = await fixture(t);
  for (const content of [Buffer.from([0, 1, 2]), Buffer.from([255, 254])]) {
    await writeFile(file, content);
    await assert.rejects(tool.execute('p', {patch: patchFor()}, undefined, undefined, {cwd}), /binary|UTF-8/);
    assert.deepEqual(await readFile(file), content);
  }
  const outside = await mkdtemp(path.join(process.cwd(), '.patch-outside-'));
  t.after(() => rm(outside, {recursive: true, force: true}));
  const target = path.join(outside, 'target.txt');
  await writeFile(target, 'one\ntwo\nthree\n');
  await t.test('outside file symlink rejected', async t => {
    if (!await fileLink(t, target, path.join(cwd, 'link.txt'))) return;
    await assert.rejects(tool.execute('p', {patch: patchFor('link.txt')}, undefined, undefined, {cwd}), /outside cwd/);
    assert.equal(await readFile(target, 'utf8'), 'one\ntwo\nthree\n');
  });
});

test('standard unified lines beginning with --- and +++ remain valid hunk data', async t => {
  const {cwd, tool, file} = await fixture(t, '-- old\n');
  await tool.execute('p', {patch: '--- file.txt\n+++ file.txt\n@@ -1 +1 @@\n--- old\n+++ new\n'}, undefined, undefined, {cwd});
  assert.equal(await readFile(file, 'utf8'), '++ new\n');
});
