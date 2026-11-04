import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createAstGrepTool} from '../extensions/apex-context/ast.mjs';
import {createEfficientTools} from '../extensions/apex-context/tools.mjs';

const text = result => result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
async function fixture(t) {
  const cwd = await mkdtemp(path.join(process.cwd(), '.ast-test-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  await mkdir(path.join(cwd, 'src'));
  await writeFile(path.join(cwd, 'src', 'a.js'), 'function a(x) {\n  console.log(x);\n}\nconsole.log(1, 2);\n');
  await writeFile(path.join(cwd, 'src', 'b.js'), 'export const b = () => console.log("b");\n');
  return cwd;
}

test('ast_grep matches a JS pattern with file grouping, line:col and paging', async t => {
  const cwd = await fixture(t);
  const tool = createAstGrepTool({cwd});
  assert.equal(tool.name, 'ast_grep');
  assert.equal(tool.annotations.readOnlyHint, true);
  const result = await tool.execute('a', {pattern: 'console.log($$$ARGS)', path: 'src'}, undefined, undefined, {cwd});
  assert.match(text(result), /^src\/a\.js:\n  2:3: console\.log\(x\)\n  4:1: console\.log\(1, 2\)\nsrc\/b\.js:\n  1:24: console\.log\("b"\)\n/);
  assert.match(text(result), /\[3 matches in 2 of 2 files searched\]/);
  assert.deepEqual(result.structuredContent, {text: text(result)});
  assert.equal(result.details.apexAst.totalMatches, 3);
  const page = await tool.execute('b', {pattern: 'console.log($$$ARGS)', limit: 1}, undefined, undefined, {cwd});
  assert.match(text(page), /next page skip=1/);
  const next = await tool.execute('c', {pattern: 'console.log($$$ARGS)', limit: 1, skip: 1}, undefined, undefined, {cwd});
  assert.match(text(next), /4:1: console\.log\(1, 2\)/);
  const file = await tool.execute('d', {pattern: 'function $NAME($$$) { $$$ }', path: 'src/a.js', lang: 'js'}, undefined, undefined, {cwd});
  assert.match(text(file), /^src\/a\.js:\n  1:1: function a\(x\) \{/);
  const none = await tool.execute('e', {pattern: 'never_called($A)', glob: '*.js'}, undefined, undefined, {cwd});
  assert.match(text(none), /^No matches found\n/);
});

test('ast_grep validates arguments and refuses paths outside cwd', async t => {
  const cwd = await fixture(t);
  const tool = createAstGrepTool({cwd});
  const run = input => tool.execute('x', input, undefined, undefined, {cwd});
  for (const limit of [0, 201, 1.5, '5']) await assert.rejects(run({pattern: 'a', limit}), /limit must be an integer from 1 to 200/);
  for (const skip of [-1, 0.5]) await assert.rejects(run({pattern: 'a', skip}), /skip must be a non-negative integer/);
  for (const pattern of [undefined, '', '  ', 'x'.repeat(2001)]) await assert.rejects(run({pattern}), /pattern must be a nonempty string/);
  await assert.rejects(run({pattern: 'a', lang: 'x'.repeat(41)}), /lang must be a string/);
  await assert.rejects(run({pattern: 'a', glob: 'x'.repeat(501)}), /glob must be a string/);
  await assert.rejects(run({pattern: 'a', path: '..'}), /confined/);
  await assert.rejects(run({pattern: 'a', path: os.tmpdir()}), /confined/);
  await assert.rejects(run({pattern: 'a', path: 'missing'}), /Path not found/);
});

test('ast_grep registers under search and is deferred with lazy', async t => {
  const cwd = await fixture(t);
  const direct = createEfficientTools({cwd, features: new Set(['search'])}).find(item => item.name === 'ast_grep');
  assert.equal(direct.exposure ?? 'direct', 'direct');
  const deferred = createEfficientTools({cwd, features: new Set(['search', 'lazy'])}).find(item => item.name === 'ast_grep');
  assert.equal(deferred.exposure, 'deferred');
  assert.equal(createEfficientTools({cwd, features: new Set(['read', 'edit'])}).some(item => item.name === 'ast_grep'), false);
});
