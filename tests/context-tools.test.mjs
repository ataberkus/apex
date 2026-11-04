import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileLink} from './fixtures/filesystem.mjs';
import {SessionManager, createEditToolDefinition, createReadToolDefinition} from '@earendil-works/pi-coding-agent';

const load = () => import('../extensions/apex-context/tools.mjs').catch(() => ({}));
const text = result => result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
async function fixture(t) {
  const cwd = await mkdtemp(path.join(process.cwd(), '.tools-test-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  return cwd;
}
async function tool(cwd, feature, name = feature) {
  const {createEfficientTools} = await load();
  assert.equal(typeof createEfficientTools, 'function', 'efficient native tool factory missing');
  return createEfficientTools({cwd, features: {has: value => value === feature}}).find(item => item.name === name);
}
function observe(manager, id, result) {
  return manager.appendMessage({role: 'toolResult', toolCallId: id, toolName: 'read', content: result.content,
    details: result.details, isError: false, timestamp: 0});
}

test('feature selection is inert and conventional tools stay directly active with lazy', async t => {
  const cwd = await fixture(t);
  const {createEfficientTools} = await load();
  assert.equal(typeof createEfficientTools, 'function');
  assert.deepEqual(createEfficientTools({cwd, features: new Set()}), []);
  const enabled = createEfficientTools({cwd, features: new Set(['read', 'search', 'edit', 'patch', 'lazy'])});
  assert.deepEqual(enabled.map(item => item.name), ['read', 'grep', 'find', 'ls', 'edit', 'apply_patch']);
  for (const item of enabled.filter(item => item.name !== 'apply_patch')) {
    assert.equal(item.exposure ?? 'direct', 'direct');
    assert.notEqual(item.defaultActive, false);
  }
  assert.equal(enabled.at(-1).exposure, 'deferred');
});

test('bounded read retains native schema/range notices and runtime cwd wins', async t => {
  const cwd = await fixture(t);
  const other = path.join(cwd, 'other');
  await mkdir(other);
  await writeFile(path.join(cwd, 'large.txt'), 'wrong');
  await writeFile(path.join(other, 'large.txt'), Array.from({length: 301}, (_, i) => `line ${i + 1}`).join('\n'));
  const read = await tool(cwd, 'read');
  assert.ok(read.parameters.properties.offset);
  assert.ok(read.parameters.properties.limit);
  assert.ok(read.parameters.properties.mode);
  const result = await read.execute('read1', {path: 'large.txt'}, undefined, undefined, {cwd: other});
  assert.match(text(result), /line 80\n/);
  assert.doesNotMatch(text(result), /line 81\n/);
  assert.match(text(result), /offset=81/);
  const ranged = await read.execute('read2', {path: 'large.txt', offset: 150, limit: 2}, undefined, undefined, {cwd: other});
  assert.match(text(ranged), /^line 150\nline 151/);
  await assert.rejects(read.execute('bad', {path: 'large.txt', offset: 0}, undefined, undefined, {cwd: other}), /positive integer/);
  await assert.rejects(read.execute('bad', {path: 'large.txt', mode: 'typo'}, undefined, undefined, {cwd: other}), /mode/);
});

test('dedup needs unchanged range and exact unmasked original observation in native active context', async t => {
  const cwd = await fixture(t);
  await writeFile(path.join(cwd, 'file.txt'), 'alpha\nbeta\ngamma\n');
  const read = await tool(cwd, 'read');
  const manager = SessionManager.inMemory(cwd);
  const root = manager.appendMessage({role: 'user', content: 'task', timestamp: 0});
  const ctx = {cwd, sessionManager: manager};
  const first = await read.execute('r1', {path: 'file.txt', offset: 1, limit: 2}, undefined, undefined, ctx);
  const observation = observe(manager, 'r1', first);
  const repeated = await read.execute('r2', {path: 'file.txt', offset: 1, limit: 2}, undefined, undefined, ctx);
  assert.equal(repeated.details.apexRead.deduplicated, true);
  assert.match(text(repeated), /r1/);
  const different = await read.execute('r3', {path: 'file.txt', offset: 2, limit: 2}, undefined, undefined, ctx);
  assert.notEqual(different.details.apexRead.deduplicated, true);
  await writeFile(path.join(cwd, 'file.txt'), 'changed\nbeta\ngamma\n');
  const stale = await read.execute('r4', {path: 'file.txt', offset: 1, limit: 2}, undefined, undefined, ctx);
  assert.match(text(stale), /^changed/);
  observe(manager, 'r4', stale);
  const staleId = manager.getLeafId();
  manager.appendContextEdit(staleId, {content: '[elided]'});
  const masked = await read.execute('r5', {path: 'file.txt', offset: 1, limit: 2}, undefined, undefined, ctx);
  assert.match(text(masked), /^changed/);
  manager.branch(root);
  const branch = await read.execute('r6', {path: 'file.txt', offset: 1, limit: 2}, undefined, undefined, ctx);
  assert.match(text(branch), /^changed/);
  manager.branch(observation);
  manager.appendCompaction('summary', null, 1);
  const compacted = await read.execute('r7', {path: 'file.txt', offset: 1, limit: 2}, undefined, undefined, ctx);
  assert.match(text(compacted), /^changed/);
});

test('dedup never makes a pointer for missing/empty context or a fresh tool factory', async t => {
  const cwd = await fixture(t);
  await writeFile(path.join(cwd, 'file.txt'), 'content');
  const read = await tool(cwd, 'read');
  await read.execute('r1', {path: 'file.txt'}, undefined, undefined, {cwd});
  assert.equal(text(await read.execute('r2', {path: 'file.txt'}, undefined, undefined, {cwd})), 'content');
  const manager = SessionManager.inMemory(cwd);
  const first = await read.execute('r3', {path: 'file.txt'}, undefined, undefined, {cwd, sessionManager: manager});
  const id = observe(manager, 'r3', first);
  manager.appendContextEdit(id, {content: []});
  assert.equal(text(await read.execute('r4', {path: 'file.txt'}, undefined, undefined, {cwd, sessionManager: manager})), 'content');
  const fresh = await tool(cwd, 'read');
  assert.equal(text(await fresh.execute('r5', {path: 'file.txt'}, undefined, undefined, {cwd, sessionManager: manager})), 'content');
});

test('dedup hashes actual range bytes even when a native oversized-line notice is unchanged', async t => {
  const cwd = await fixture(t);
  const file = path.join(cwd, 'long.txt');
  await writeFile(file, 'x'.repeat(100000));
  const read = await tool(cwd, 'read');
  const manager = SessionManager.inMemory(cwd);
  const ctx = {cwd, sessionManager: manager};
  const first = await read.execute('r1', {path: 'long.txt'}, undefined, undefined, ctx);
  observe(manager, 'r1', first);
  await writeFile(file, 'y'.repeat(100000));
  const second = await read.execute('r2', {path: 'long.txt'}, undefined, undefined, ctx);
  assert.equal(text(first), text(second));
  assert.equal(second.details.apexRead.deduplicated, false);
  assert.notEqual(second.details.apexRead.rangeHash, first.details.apexRead.rangeHash);
});

test('a change outside the requested range also invalidates unchanged-file dedup', async t => {
  const cwd = await fixture(t);
  const file = path.join(cwd, 'file.txt');
  await writeFile(file, 'alpha\nbeta\ngamma\n');
  const read = await tool(cwd, 'read');
  const manager = SessionManager.inMemory(cwd);
  const ctx = {cwd, sessionManager: manager};
  const first = await read.execute('r1', {path: 'file.txt', limit: 2}, undefined, undefined, ctx);
  observe(manager, 'r1', first);
  await writeFile(file, 'alpha\nbeta\ndelta\n');
  const second = await read.execute('r2', {path: 'file.txt', limit: 2}, undefined, undefined, ctx);
  assert.equal(text(first), text(second));
  assert.equal(second.details.apexRead.deduplicated, false);
  assert.equal(second.details.apexRead.rangeHash, first.details.apexRead.rangeHash);
  assert.notEqual(second.details.apexRead.fileHash, first.details.apexRead.fileHash);
});

test('outline reports line numbers and explicitly labels approximate fallback', async t => {
  const cwd = await fixture(t);
  await writeFile(path.join(cwd, 'symbols.py'), 'class Widget:\n    pass\n\ndef render():\n    pass\n');
  const read = await tool(cwd, 'read');
  const result = await read.execute('outline', {path: 'symbols.py', mode: 'outline'}, undefined, undefined, {cwd});
  assert.match(text(result), /(?:ctags symbols|Approximate outline)/);
  assert.match(text(result), /1.*Widget/);
  assert.match(text(result), /4.*render/);
  assert.equal(result.details.apexRead.mode, 'outline');
});

test('images retain native payload; binary and huge lines produce bounded honest results', async t => {
  const cwd = await fixture(t);
  await writeFile(path.join(cwd, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+p8AAAAASUVORK5CYII=', 'base64'));
  await writeFile(path.join(cwd, 'binary.dat'), Buffer.from([0, 1, 255, 0, 2]));
  await writeFile(path.join(cwd, 'long.txt'), 'x'.repeat(100000));
  const read = await tool(cwd, 'read');
  const native = createReadToolDefinition(cwd);
  const image = await read.execute('img', {path: 'pixel.png'}, undefined, undefined, {cwd});
  const expected = await native.execute('img', {path: 'pixel.png'}, undefined, undefined, {cwd});
  assert.deepEqual(image.content, expected.content);
  assert.match(text(await read.execute('bin', {path: 'binary.dat'}, undefined, undefined, {cwd})), /Binary.*5 bytes/);
  assert.ok(Buffer.byteLength(text(await read.execute('long', {path: 'long.txt'}, undefined, undefined, {cwd}))) < 2000);
});

test('conventional edit aliases use native multi-edit and preserve BOM/CRLF/untouched whitespace', async t => {
  const cwd = await fixture(t);
  const file = path.join(cwd, 'file.txt');
  await writeFile(file, '\ufefffirst  \r\nsecond\r\nthird  \r\n');
  const edit = await tool(cwd, 'edit');
  const result = await edit.execute('e1', {path: 'file.txt', edits: [{old_string: 'first', new_string: 'FIRST'},
    {old_string: 'second', new_string: 'SECOND'}]}, undefined, undefined, {cwd});
  assert.equal(await readFile(file, 'utf8'), '\ufeffFIRST  \r\nSECOND\r\nthird  \r\n');
  assert.match(text(result), /FIRST/);
  await edit.execute('e2', edit.prepareArguments({path: 'file.txt', old_string: 'third', new_string: 'THIRD'}), undefined, undefined, {cwd});
  assert.equal(await readFile(file, 'utf8'), '\ufeffFIRST  \r\nSECOND\r\nTHIRD  \r\n');
});

test('edit requires at least one complete replacement pair before touching the file', async t => {
  const cwd = await fixture(t), file = path.join(cwd, 'file.txt');
  await writeFile(file, 'unchanged\n');
  const edit = await tool(cwd, 'edit');
  for (const input of [{path:'file.txt'}, {path:'file.txt', edits:[]}, {path:'file.txt', old_string:'unchanged'}]) {
    await assert.rejects(edit.execute('missing-pair', input, undefined, undefined, {cwd}), /Edit input requires/);
    assert.equal(await readFile(file, 'utf8'), 'unchanged\n');
  }
});

test('native edit whitespace matching, ambiguity and overlap fail atomically with bounded candidates', async t => {
  const cwd = await fixture(t);
  const file = path.join(cwd, 'file.txt');
  const original = 'keep  \nvalue = “old”  \nrepeat\nrepeat\n';
  await writeFile(file, original);
  const edit = await tool(cwd, 'edit');
  await edit.execute('e1', {path: 'file.txt', old_string: 'value = "old"\n', new_string: 'value = "new"\n'}, undefined, undefined, {cwd});
  assert.equal(await readFile(file, 'utf8'), 'keep  \nvalue = "new"\nrepeat\nrepeat\n');
  const before = await readFile(file);
  await assert.rejects(edit.execute('e2', {path: 'file.txt', edits: [{old_string: 'keep', new_string: 'oops'},
    {old_string: 'repeat', new_string: 'no'}]}, undefined, undefined, {cwd}), error => /occurrences/.test(error.message) && /Closest candidates/.test(error.message) && error.message.length < 5000);
  assert.deepEqual(await readFile(file), before);
  await assert.rejects(edit.execute('e3', {path: 'file.txt', edits: [{old_string: 'value', new_string: 'oops'},
    {old_string: 'value = "new"', new_string: 'no'}]}, undefined, undefined, {cwd}), /overlap/);
  assert.deepEqual(await readFile(file), before);
  await assert.rejects(edit.execute('e4', {path: 'file.txt', old_string: 'valu = "new"', new_string: 'x'}, undefined, undefined, {cwd}), /Closest candidates/);
});

test('wrapper and native sibling edits serialize against realpath aliases', async t => {
  const cwd = await fixture(t);
  await writeFile(path.join(cwd, 'file.txt'), 'a\nb\n');
  if (!await fileLink(t, path.join(cwd, 'file.txt'), path.join(cwd, 'alias.txt'))) return;
  const edit = await tool(cwd, 'edit');
  const native = createEditToolDefinition(cwd);
  await Promise.all([
    edit.execute('w', {path: 'file.txt', old_string: 'a', new_string: 'A'}, undefined, undefined, {cwd}),
    native.execute('n', {path: 'alias.txt', edits: [{oldText: 'b', newText: 'B'}]}, undefined, undefined, {cwd}),
  ]);
  assert.equal(await readFile(path.join(cwd, 'file.txt'), 'utf8'), 'A\nB\n');
});

test('search uses native caps with grouped grep and unknown overflow totals', async t => {
  const cwd = await fixture(t);
  await writeFile(path.join(cwd, 'alpha.txt'), 'needle\nneedle\nneedle\n');
  await writeFile(path.join(cwd, 'beta.txt'), 'needle\n');
  const grep = await tool(cwd, 'search', 'grep');
  const result = await grep.execute('g', {pattern: 'needle', limit: 2}, undefined, undefined, {cwd});
  assert.equal(result.details.matchLimitReached, 2);
  assert.equal(result.details.apexSearch.total, null);
  assert.equal(result.details.apexSearch.returned, 2);
  assert.match(text(result), /total unknown/i);
  assert.match(text(result), /alpha\.txt:/);
  const complete = await grep.execute('g2', {pattern: 'needle', limit: 20}, undefined, undefined, {cwd});
  assert.equal(complete.details.apexSearch.total, 4);
  const ls = await tool(cwd, 'search', 'ls');
  const listed = await ls.execute('ls', {limit: 1}, undefined, undefined, {cwd});
  assert.equal(listed.details.entryLimitReached, 1);
  assert.equal(listed.details.apexSearch.total, null);
  await assert.rejects(grep.execute('bad', {pattern: 'needle', limit: -1}, undefined, undefined, {cwd}), /positive integer/);
});

test('missing engines fail locally without fetching or installing and imports/factories are inert', async t => {
  const cwd = await fixture(t);
  const source = new URL('../extensions/apex-context/tools.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
    const {createEfficientTools} = await import(${JSON.stringify(source)});
    const tools = createEfficientTools({cwd: ${JSON.stringify(cwd)}, features: new Set(['search'])});
    process.env.PATH = '';
    for (const name of ['grep', 'find']) {
      try { await tools.find(tool => tool.name === name).execute('x', {pattern: 'x'}, undefined, undefined, {}); process.exit(2); }
      catch (error) { if (!error.message.includes('not available on PATH')) throw error; }
    }
    console.log('offline');`], {encoding: 'utf8', timeout: 10000});
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'offline');
});

test('ambiguous native filename rows do not fabricate search totals', {skip: process.platform === 'win32' ? 'Windows forbids literal newline filenames; ambiguous newline rows unexercised' : false}, async t => {
  const cwd = await fixture(t);
  await writeFile(path.join(cwd, 'name\nwith-newline.txt'), 'needle\n');
  const grep = await tool(cwd, 'search', 'grep');
  const found = await grep.execute('g', {pattern: 'needle'}, undefined, undefined, {cwd});
  assert.equal(found.details.apexSearch.total, null);
  assert.equal(found.details.apexSearch.returned, null);
  const ls = await tool(cwd, 'search', 'ls');
  const listed = await ls.execute('ls', {}, undefined, undefined, {cwd});
  assert.equal(listed.details.apexSearch.total, null);
});

test('edit argument preparation supports native legacy/object/string inputs without mutating raw arguments', async t => {
  const cwd = await fixture(t);
  const edit = await tool(cwd, 'edit');
  for (const edits of [{old_string: 'a', new_string: 'b'}, JSON.stringify([{old_string: 'a', new_string: 'b'}]),
    {oldText: 'a', newText: 'b'}]) {
    const input = {path: 'file.txt', edits};
    const snapshot = JSON.stringify(input);
    assert.deepEqual(edit.prepareArguments(input), {path: 'file.txt', edits: [{old_string: 'a', new_string: 'b'}]});
    assert.equal(JSON.stringify(input), snapshot);
  }
  assert.deepEqual(edit.prepareArguments({path: 'file.txt', oldText: 'a', newText: 'b'}),
    {path: 'file.txt', edits: [{old_string: 'a', new_string: 'b'}]});
});
