import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm, mkdir, lstat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {directoryLink, fileLink, shortPath, unixOnly} from './fixtures/filesystem.mjs';

const load = () => import('../lib/session-report.mjs').catch(() => ({}));
const header = {type: 'session', version: 3, id: '00000000-0000-4000-8000-000000000001', timestamp: '2026-10-01T00:00:00Z', cwd: '/fixture'};
const usage = {input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
const row = (type, id, parentId, extra = {}) => ({type, id, parentId, timestamp: header.timestamp, ...extra});
const transcript = () => [header,
  row('model_change', 'model', null, {provider: 'fixture', modelId: 'native-model'}),
  row('thinking_level_change', 'think', 'model', {thinkingLevel: 'xhigh'}),
  row('message', 'user', 'think', {message: {role: 'user', content: 'PRIVATE prompt'}}),
  row('message', 'call', 'user', {message: {role: 'assistant', content: [{type: 'toolCall', id: 'read-1', name: 'read', arguments: {path: 'PRIVATE.txt'}}], provider: 'fixture', model: 'native-model', usage, stopReason: 'toolUse'}}),
  row('message', 'result', 'call', {message: {role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: [{type: 'text', text: 'PRIVATE result'}], isError: false}}),
  row('message', 'old', 'result', {message: {role: 'assistant', content: [{type: 'toolCall', id: 'discarded-1', name: 'write', arguments: {content: 'PRIVATE'}}], provider: 'fixture', model: 'native-model', usage, stopReason: 'toolUse'}}),
  row('message', 'active', 'result', {message: {role: 'assistant', content: [{type: 'toolCall', id: 'pending-1', name: 'edit', arguments: {content: 'PRIVATE'}}], provider: 'fixture', model: 'native-model', usage, stopReason: 'toolUse'}})];
async function fixture(t, rows = transcript(), tail = '\n') {
  const dir = await mkdtemp(path.join(process.cwd(), '.accounting-fixture-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'session.jsonl');
  await writeFile(file, rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + tail);
  return {dir, file};
}

test('bounded real native JSONL report aggregates all branches and exposes no prompt or tool payloads', async t => {
  const {readSessionReport} = await load(); assert.equal(typeof readSessionReport, 'function');
  const {file} = await fixture(t);
  const before = await readFile(file); const value = await readSessionReport(file);
  assert.deepEqual(value.header, header); assert.equal(value.entryCount, 7); assert.equal(value.leafId, 'active');
  assert.deepEqual(value.branchIds, ['model', 'think', 'user', 'call', 'result', 'active']);
  assert.equal(value.summary.totals.input, 24); assert.equal(value.summary.counts.usageRecords, 3);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE/); assert.deepEqual(await readFile(file), before);
});

test('resume metadata identifies only unresolved tools on native active branch and never replays or writes', async t => {
  const {inspectResume} = await load(); assert.equal(typeof inspectResume, 'function');
  const {file} = await fixture(t); const before = await readFile(file);
  const value = await inspectResume(file);
  assert.deepEqual(value.header, header); assert.deepEqual(value.model, {provider: 'fixture', id: 'native-model'});
  assert.equal(value.thinkingLevel, 'xhigh'); assert.equal(value.leafId, 'active');
  assert.deepEqual(value.pendingTools, [{id: 'pending-1', name: 'edit', entryId: 'active'}]);
  assert.equal(value.replaySafe, false); assert.equal(value.replayPerformed, false);
  assert.deepEqual(await readFile(file), before); assert.doesNotMatch(JSON.stringify(value), /PRIVATE/);
});

test('unterminated valid record and torn final fragment are distinguished without native tail repair', async t => {
  const {inspectResume, readSessionReport} = await load(); assert.equal(typeof inspectResume, 'function');
  const {file} = await fixture(t, transcript(), ''); const before = await readFile(file);
  const valid = await inspectResume(file); assert.equal(valid.tornTail, false); assert.equal(valid.unterminatedTail, true);
  assert.deepEqual(await readFile(file), before);
  await writeFile(file, Buffer.concat([before, Buffer.from('\n{"type":"message","id":"torn') ]));
  const tornBefore = await readFile(file); const torn = await inspectResume(file);
  assert.equal(torn.tornTail, true); assert.equal(torn.leafId, 'active');
  const report = await readSessionReport(file); assert.equal(report.summary.completeness.usage, false);
  assert.deepEqual(await readFile(file), tornBefore);
});

test('malformed interior records fail closed with line number rather than raw payload echo', async t => {
  const {readSessionReport} = await load(); assert.equal(typeof readSessionReport, 'function');
  const {file} = await fixture(t, [header, '{PRIVATE broken', ...transcript().slice(1)]);
  await assert.rejects(() => readSessionReport(file), error => /line 2/i.test(error.message) && !error.message.includes('PRIVATE'));
});

test('report rejects oversized files and invalid limits before reading a payload', async t => {
  const {readSessionReport} = await load(); assert.equal(typeof readSessionReport, 'function');
  const {file} = await fixture(t);
  await assert.rejects(() => readSessionReport(file, {maxBytes: 32}), /limit|large/i);
  for (const maxBytes of [0, -1, Infinity, 1.5, 1024 * 1024 * 1024]) await assert.rejects(() => readSessionReport(file, {maxBytes}), /limit/i);
});

test('report refuses file and parent symlinks and nonregular files', async t => {
  const {readSessionReport} = await load(); assert.equal(typeof readSessionReport, 'function');
  const {dir, file} = await fixture(t);
  await t.test('file symlink refused', async t => {
    const link = path.join(dir, 'link.jsonl');
    if (!await fileLink(t, file, link)) return;
    await assert.rejects(() => readSessionReport(link), /symlink/i);
  });
  const sub = path.join(dir, 'sub'); await mkdir(sub); const parentLink = path.join(dir, 'parent'); await directoryLink(dir, parentLink);
  await assert.rejects(() => readSessionReport(path.join(parentLink, 'session.jsonl')), /symlink/i);
  await assert.rejects(() => readSessionReport(sub), /regular|file/i);
});

test('report reads a short path but not a parent junction through its short alias', {skip: process.platform !== 'win32' && 'Windows 8.3 names'}, async t => {
  const {readSessionReport} = await load(); assert.equal(typeof readSessionReport, 'function');
  const {dir, file} = await fixture(t);
  const short = shortPath(file);
  if (short === file) return t.skip('This volume has no 8.3 names; the short spelling is unexercised');
  assert.equal((await readSessionReport(short)).id, (await readSessionReport(file)).id);
  const parent = path.join(dir, 'a-long-parent-junction'); await directoryLink(dir, parent);
  await assert.rejects(() => readSessionReport(shortPath(path.join(parent, 'session.jsonl'))), /symlink/i);
});

test('invalid UTF8, empty files and nonnative headers fail with bounded messages', async t => {
  const {readSessionReport} = await load(); assert.equal(typeof readSessionReport, 'function');
  const {file} = await fixture(t, []);
  await assert.rejects(() => readSessionReport(file), /header|empty/i);
  await writeFile(file, Buffer.from([255, 254])); await assert.rejects(() => readSessionReport(file), /UTF-8|encoding/i);
  for (const changed of [{...header, version: 4}, {...header, id: '../not-native'}, {...header, cwd: null}]) {
    await writeFile(file, JSON.stringify(changed) + '\n'); await assert.rejects(() => readSessionReport(file), /header|version|id/i);
  }
});

test('duplicate replay is reconciled but conflicting identity, broken parents and cycles are refused', async t => {
  const {readSessionReport} = await load(); assert.equal(typeof readSessionReport, 'function');
  const rows = transcript(); const {file} = await fixture(t, [...rows, rows[4]]);
  const value = await readSessionReport(file); assert.equal(value.summary.counts.usageRecords, 3);
  await writeFile(file, [...rows, {...rows[4], parentId: 'result'}].map(JSON.stringify).join('\n'));
  await assert.rejects(() => readSessionReport(file), /conflict/i);
  await writeFile(file, [header, row('label', 'broken', 'missing')].map(JSON.stringify).join('\n'));
  await assert.rejects(() => readSessionReport(file), /parent/i);
  await writeFile(file, [header, row('label', 'a', 'b'), row('label', 'b', 'a')].map(JSON.stringify).join('\n'));
  await assert.rejects(() => readSessionReport(file), /parent|cycle/i);
});

test('completed active branch reports no pending tool and preserves empty native branch metadata', async t => {
  const {inspectResume} = await load(); assert.equal(typeof inspectResume, 'function');
  const rows = transcript(); rows.push(row('message', 'done', 'active', {message: {role: 'toolResult', toolCallId: 'pending-1', toolName: 'edit', content: [], isError: false}}));
  const {file} = await fixture(t, rows); assert.deepEqual((await inspectResume(file)).pendingTools, []);
  await writeFile(file, JSON.stringify(header) + '\n');
  const empty = await inspectResume(file); assert.equal(empty.leafId, null); assert.deepEqual(empty.branchIds, []);
});

test('native safe custom session IDs and assistant model settings survive metadata inspection', async t => {
  const {inspectResume} = await load(); assert.equal(typeof inspectResume, 'function');
  const customHeader = {...header, id: 'offline.native-session_1'};
  const rows = [customHeader, row('message', 'a', null, {message: {role: 'assistant', provider: 'fixture', model: 'routed-model', usage, content: [], stopReason: 'stop'}})];
  const {file} = await fixture(t, rows);
  const value = await inspectResume(file);
  assert.equal(value.header.id, 'offline.native-session_1'); assert.deepEqual(value.model, {provider: 'fixture', id: 'routed-model'});
});

test('extra header payload and overlong native lines cannot leak through report metadata', async t => {
  const {readSessionReport} = await load(); assert.equal(typeof readSessionReport, 'function');
  const {file} = await fixture(t, [{...header, injected: 'PRIVATE'}, ...transcript().slice(1)]);
  await assert.rejects(() => readSessionReport(file), error => /header/i.test(error.message) && !error.message.includes('PRIVATE'));
  await writeFile(file, JSON.stringify(header) + '\n' + JSON.stringify(row('custom', 'big', null, {customType: 'fixture', data: 'x'.repeat(1024 * 1024)})) + '\n');
  await assert.rejects(() => readSessionReport(file), /line.*limit/i);
});

test('malformed native message shapes and excessive nesting cannot become an empty or successful report', async t => {
  const {readSessionReport} = await load(); assert.equal(typeof readSessionReport, 'function');
  const {file} = await fixture(t, [header, row('message', 'bad', null, {message: null})]);
  await assert.rejects(() => readSessionReport(file), /message|entry/i);
  const content = [{type: 'toolCall', id: 'call', name: 'edit', arguments: {}}];
  await writeFile(file, [header, row('message', 'bad', null, {message: {role: 'assistant', content: [{...content[0], id: null}], provider: 'fixture', model: 'native-model', usage}})].map(JSON.stringify).join('\n'));
  await assert.rejects(() => readSessionReport(file), /tool|message|entry/i);
  let nested = {}; for (let i = 0; i < 100; i++) nested = {child: nested};
  await writeFile(file, [header, row('custom', 'deep', null, {customType: 'fixture', data: nested})].map(JSON.stringify).join('\n'));
  await assert.rejects(() => readSessionReport(file), /depth|nest|limit/i);
});

test('the last physical replay record determines native resume leaf even when accounting deduplicates it', async t => {
  const {readSessionReport} = await load(); assert.equal(typeof readSessionReport, 'function');
  const rows = transcript(); const {file} = await fixture(t, [...rows, rows[4]]);
  const value = await readSessionReport(file);
  assert.equal(value.leafId, 'call'); assert.deepEqual(value.pendingTools, [{id: 'read-1', name: 'read', entryId: 'call'}]);
  assert.equal(value.summary.counts.usageRecords, 3);
});

test('torn tail invalidates full subset and task totals and estimates while retaining observed accounting', async t => {
  const {readSessionReport} = await load(); assert.equal(typeof readSessionReport, 'function');
  const rows = [header, row('custom', 'state', null, {customType: 'apex-task-state', data: {taskId: 'task-1'}}),
    row('message', 'a', 'state', {message: {role: 'assistant', provider: 'fixture', model: 'native-model', stopReason: 'stop',
      content: [{type: 'text', text: 'PRIVATE done'}], usage: {...usage, cacheWrite: 1, totalTokens: 11, reasoning: 1, cacheWrite1h: 1, cost: {total: 0.03}}}})];
  const {file} = await fixture(t, rows, '\n{"type":"message","id":"torn');
  const value = await readSessionReport(file);
  assert.equal(value.tornTail, true);
  for (const scope of [value.summary, value.summary.tasks[0]]) {
    assert.ok(Object.values(scope.totals).every(amount => amount === null));
    assert.equal(scope.completeness.usage, false); assert.equal(scope.completeness.cost, false); assert.equal(scope.completeness.thinking, false);
    assert.ok(scope.completeness.issues.includes('torn_tail'));
    assert.equal(scope.cost.nativeEstimateUsd, null); assert.equal(scope.cost.pricingEstimateUsd, null);
    assert.equal(scope.knownTotals.input, 8); assert.equal(scope.knownTotals.thinking, 1); assert.equal(scope.knownTotals.cacheWrite1h, 1);
    assert.equal(scope.cost.knownNativeEstimateUsd, 0.03);
  }
});

test('a regular session replaced by an unwritten FIFO before real open is refused without blocking', {timeout: 5000, skip: unixOnly}, async t => {
  const {dir, file} = await fixture(t);
  const moduleURL = new URL('../lib/session-report.mjs', import.meta.url).href;
  const preload = path.join(dir, 'fifo-preload.mjs');
  await writeFile(preload, `
    import fs from 'node:fs/promises';
    import {spawnSync} from 'node:child_process';
    const target = ${JSON.stringify(file)};
    const original = fs.open;
    globalThis.accountingFifoReplaced = false;
    fs.open = async function(candidate, flags, ...rest) {
      if (candidate === target && !globalThis.accountingFifoReplaced) {
        await fs.rename(target, target + '.original');
        const setup = spawnSync('mkfifo', [target], {env: process.env});
        if (setup.status !== 0) throw new Error('FIFO fixture setup failed');
        globalThis.accountingFifoReplaced = true;
      }
      return original.call(this, candidate, flags, ...rest);
    };
  `);
  const script = `
    const {readSessionReport} = await import(${JSON.stringify(moduleURL)});
    try {
      await readSessionReport(${JSON.stringify(file)});
      process.stdout.write(JSON.stringify({replaced: globalThis.accountingFifoReplaced, refused: false}));
    } catch (error) {
      process.stdout.write(JSON.stringify({replaced: globalThis.accountingFifoReplaced, refused: true, message: error.message}));
    }
  `;
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(env, {PI_OFFLINE: '1', npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:9'});
  // live-builtins makes the reader's named fs/promises imports see the preload's patch.
  const liveBuiltins = fileURLToPath(new URL('../scripts/live-builtins.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--preload', liveBuiltins, '--preload', preload, '--input-type=module', '-e', script],
    {env, encoding: 'utf8', timeout: 2000, maxBuffer: 8192});
  assert.equal(result.error, undefined, 'the real session reader must refuse a FIFO replacement without waiting for a writer');
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const refusal = JSON.parse(result.stdout);
  assert.equal(refusal.replaced, true); assert.equal(refusal.refused, true);
  assert.match(refusal.message, /regular|changed.*inspection/i); assert.doesNotMatch(result.stdout, /PRIVATE/);
  assert.equal((await lstat(file)).isFIFO(), true);
});
