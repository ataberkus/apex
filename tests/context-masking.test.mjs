import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js';

import { planMasking } from '../extensions/apex-context/masking.mjs';
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistant(id, name, args) {
  return { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }], api: 'openai-completions', provider: 'openrouter', model: 'fixture', usage, stopReason: 'toolUse', timestamp: 0 };
}

function observe(manager, id, name = 'bash', args = { command: 'printf fixture' }, overrides = {}) {
  manager.appendMessage(assistant(id, name, args));
  const entryId = manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: name,
    content: [{ type: 'text', text: `${id}: ${'fixture output\n'.repeat(50)}` }],
    details: { apexShape: { logPath: `.apex/out/${id}.log`, logScope: 'hook-visible-result' } }, isError: false, timestamp: 0, ...overrides });
  return entryId;
}

function event(manager, entries = []) {
  const projection = manager.buildSessionProjection();
  return { type: 'turn_end', turnIndex: 0, entries, continue: false, outcome: 'completed',
    context: { contextEntries: projection.entries, contextMessages: projection.messages } };
}
function context(manager) { return { cwd: process.cwd(), sessionManager: manager }; }
function drafts(result) { return result?.entries?.filter(entry => entry.type === 'context_edit') ?? []; }

test('masking batches older assistant turns despite reset turnIndex and composes prior drafts', () => {
  const manager = SessionManager.inMemory(process.cwd());
  manager.appendMessage({ role: 'user', content: 'Keep task and requirements', timestamp: 0 });
  const old = observe(manager, 'old');
  const recent = observe(manager, 'recent');
  const latest = observe(manager, 'latest');
  const prior = { type: 'custom', customType: 'other-extension', data: { keep: true } };
  const result = planMasking(event(manager, [prior]), context(manager), { keepTurns: 2, thresholdTokens: 1 });
  assert.deepEqual(drafts(result).map(entry => entry.targetId), [old]);
  assert.equal(result.entries[0], prior);
  assert.equal(Object.hasOwn(result, 'continue'), false);
  assert.ok(!drafts(result).some(entry => entry.targetId === recent || entry.targetId === latest));
  assert.match(drafts(result)[0].replacement.content[0].text, /elided.*bash/);
  assert.match(drafts(result)[0].replacement.content[0].text, /\.apex\/out\/old\.log/);
  assert.match(drafts(result)[0].replacement.content[0].text, /hook-visible|observed/);
});

test('masking protects latest reads by canonical path and all task/contract/todo state', () => {
  const manager = SessionManager.inMemory(process.cwd());
  const task = manager.appendMessage({ role: 'user', content: 'Task contract', timestamp: 0 });
  manager.appendCustomEntry('apex-contract', { requirements: ['keep me'] });
  manager.appendCustomMessageEntry('apex-todo', 'Todo is model-visible', true);
  const oldRead = observe(manager, 'read-old', 'read', { path: './example.js' });
  const latestRead = observe(manager, 'read-latest', 'read', { path: join(process.cwd(), 'example.js') });
  observe(manager, 'middle');
  observe(manager, 'last');
  const result = planMasking(event(manager), context(manager), { keepTurns: 1, thresholdTokens: 1 });
  assert.ok(drafts(result).some(entry => entry.targetId === oldRead));
  assert.ok(!drafts(result).some(entry => entry.targetId === latestRead || entry.targetId === task));
  assert.ok(drafts(result).every(entry => manager.getEntry(entry.targetId).message.role === 'toolResult'));
});

test('masking persists native context edits and reopening retains stubs with original history', () => {
  const directory = mkdtempSync(join(process.cwd(), 'tests/.masking-fixture-'));
  try {
    const manager = SessionManager.create(process.cwd(), directory);
    manager.appendMessage({ role: 'user', content: 'Task preserved', timestamp: 0 });
    const old = observe(manager, 'disk-old');
    observe(manager, 'disk-latest');
    const result = planMasking(event(manager), context(manager), { keepTurns: 1, thresholdTokens: 1 });
    assert.equal(drafts(result).length, 1);
    for (const entry of drafts(result)) manager.appendContextEdit(entry.targetId, entry.replacement);
    const reopened = SessionManager.open(manager.getSessionFile(), directory, process.cwd());
    const projected = reopened.buildSessionProjection().entries.find(entry => entry.sourceEntry.id === old);
    assert.match(projected.messages[0].content[0].text, /elided/);
    assert.match(reopened.getEntry(old).message.content[0].text, /fixture output/);
    assert.equal(projected.messages[0].toolCallId, 'disk-old');
    assert.equal(projected.messages[0].isError, false);
    assert.equal(planMasking(event(reopened), context(reopened), { keepTurns: 1, thresholdTokens: 1 }), undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('masking uses active branch and does not repeat pending or persisted edits', () => {
  const manager = SessionManager.inMemory(process.cwd());
  const root = manager.appendMessage({ role: 'user', content: 'branch root', timestamp: 0 });
  const discarded = observe(manager, 'discarded');
  observe(manager, 'discarded-tail');
  manager.branch(root);
  const active = observe(manager, 'active');
  observe(manager, 'active-tail');
  const result = planMasking(event(manager), context(manager), { keepTurns: 1, thresholdTokens: 1 });
  assert.deepEqual(drafts(result).map(entry => entry.targetId), [active]);
  assert.ok(!drafts(result).some(entry => entry.targetId === discarded));
  const pending = { type: 'context_edit', targetId: active, replacement: { content: [{ type: 'text', text: '[already shaped by another extension]' }] } };
  assert.equal(planMasking(event(manager, [pending]), context(manager), { keepTurns: 1, thresholdTokens: 1 }), undefined);
  manager.appendContextEdit(active, { content: [{ type: 'text', text: '[elided: previous batch]' }] });
  assert.equal(planMasking(event(manager), context(manager), { keepTurns: 1, thresholdTokens: 1 }), undefined);
});

test('masking skips errors, images, custom structured fields, and observations without recovery logs', () => {
  const manager = SessionManager.inMemory(process.cwd());
  observe(manager, 'error', 'bash', { command: 'false' }, { isError: true, content: [{ type: 'text', text: 'Command exited with code 1' }] });
  observe(manager, 'image', 'read', { path: 'image.png' }, { content: [{ type: 'image', data: 'fixture', mimeType: 'image/png' }] });
  observe(manager, 'structured', 'bash', undefined, { structuredContent: { unknown: 'payload' } });
  observe(manager, 'no-log', 'bash', undefined, { details: undefined });
  const allowed = observe(manager, 'text');
  observe(manager, 'tail');
  assert.deepEqual(drafts(planMasking(event(manager), context(manager), { keepTurns: 1, thresholdTokens: 1 })).map(entry => entry.targetId), [allowed]);
});

test('masking batches only when eligible observation region crosses the proxy threshold', () => {
  const manager = SessionManager.inMemory(process.cwd());
  observe(manager, 'threshold-old');
  observe(manager, 'threshold-tail');
  assert.equal(planMasking(event(manager), context(manager), { keepTurns: 1, thresholdTokens: 10_000 }), undefined);
  assert.equal(drafts(planMasking(event(manager), context(manager), { keepTurns: 1, thresholdTokens: 1 })).length, 1);
  assert.equal(planMasking(event(manager), context(manager), { keepTurns: -1, thresholdTokens: 1 }), undefined);
});

test('masking prefers native full logs over shaped observed logs', () => {
  const manager = SessionManager.inMemory(process.cwd());
  observe(manager, 'native', 'bash', undefined, { details: { fullOutputPath: '/fixture/native-full.log', apexShape: { logPath: '.apex/out/visible.log', logScope: 'hook-visible-result' } } });
  observe(manager, 'native-tail');
  const result = planMasking(event(manager), context(manager), { keepTurns: 1, thresholdTokens: 1 });
  assert.match(drafts(result)[0]?.replacement.content[0].text ?? '', /full log.*native-full\.log/);
  assert.doesNotMatch(drafts(result)[0]?.replacement.content[0].text ?? '', /visible\.log/);
});

test('failed rereads do not make the latest successful file observation maskable', () => {
  const manager = SessionManager.inMemory(process.cwd());
  const goodRead = observe(manager, 'good-read', 'read', { path: 'example.js' });
  observe(manager, 'bad-read', 'read', { path: './example.js' }, { isError: true, content: [{ type: 'text', text: 'Permission denied' }] });
  observe(manager, 'after-reread');
  const other = observe(manager, 'other-observation');
  observe(manager, 'after-all');
  const result = planMasking(event(manager), context(manager), { keepTurns: 1, thresholdTokens: 1 });
  assert.ok(!drafts(result).some(entry => entry.targetId === goodRead));
  assert.ok(drafts(result).some(entry => entry.targetId === other));
});

test('recovery pointer retains the exact JSON-escaped path', () => {
  const manager = SessionManager.inMemory(process.cwd());
  const path = '/fixture/path\nwith-newline.log';
  observe(manager, 'escaped-path', 'bash', undefined, { details: { fullOutputPath: path } });
  observe(manager, 'escaped-path-tail');
  const result = planMasking(event(manager), context(manager), { keepTurns: 1, thresholdTokens: 1 });
  assert.ok(drafts(result)[0]?.replacement.content[0].text.includes(JSON.stringify(path)));
});

test('a previously elided read does not displace the latest useful read protection', () => {
  const manager = SessionManager.inMemory(process.cwd());
  const useful = observe(manager, 'useful-read', 'read', { path: 'example.js' });
  const elided = observe(manager, 'elided-read', 'read', { path: './example.js' });
  manager.appendContextEdit(elided, { content: [{ type: 'text', text: '[elided: read by another extension]' }] });
  const other = observe(manager, 'other-after-read');
  observe(manager, 'latest-after-read');
  const result = planMasking(event(manager), context(manager), { keepTurns: 1, thresholdTokens: 1 });
  assert.ok(!drafts(result).some(entry => entry.targetId === useful));
  assert.ok(drafts(result).some(entry => entry.targetId === other));
});

const nestedParentFixtures = [
  ['native nested error with structured bash exit status', {
    nestedCalls: { complete: true, calls: [{ id: 'parent/1', name: 'bash', arguments: { command: 'exit 1' }, status: 'error', durationMs: 1, error: 'Command exited with code 1' }] },
    details: { calls: [{ id: 'parent/1', name: 'bash', args: '{"command":"exit 1"}', status: 'error', durationMs: 1, error: 'Command exited with code 1' }] },
  }],
  ['codemode details error without native nested record', {
    details: { calls: [{ id: 'parent/1', name: 'bash', args: '{"command":"exit 1"}', status: 'error', durationMs: 1, error: 'Command exited with code 1' }] },
  }],
  ['successful latest nested file read', {
    nestedCalls: { complete: true, calls: [{ id: 'parent/1', name: 'read', arguments: { path: 'src/latest.js' }, status: 'ok', durationMs: 1 }] },
    details: { calls: [{ id: 'parent/1', name: 'read', args: '{"path":"src/latest.js"}', status: 'ok', durationMs: 1 }] },
  }],
  ['incomplete nested record', {
    nestedCalls: { complete: false, calls: [{ id: 'parent/1', name: 'bash', status: 'unfinished' }] },
  }],
  ['custom unknown nested status', {
    details: { calls: [{ name: 'custom_tool', status: 'unknown', result: { exit_code: 7 } }] },
  }],
];

for (const [description, metadata] of nestedParentFixtures) {
  test(`masking preserves parent observation with ${description}`, () => {
    const manager = SessionManager.inMemory(process.cwd());
    const parent = observe(manager, 'parent', 'codemode', { code: 'text(await tools.bash({ command: "exit 1" }));' }, {
      ...metadata,
      content: [{ type: 'text', text: `Script completed\nOutput:\n${'{"output":"failure evidence","exit_code":1}\n'.repeat(40)}` }],
      details: { ...metadata.details, apexShape: { logPath: '.apex/out/parent.log', logScope: 'hook-visible-result' } },
      isError: false,
    });
    const ordinary = observe(manager, 'ordinary-after-parent');
    observe(manager, 'latest-after-parent');
    const result = planMasking(event(manager), context(manager), { keepTurns: 1, thresholdTokens: 1 });
    assert.deepEqual(drafts(result).map(entry => entry.targetId), [ordinary]);
    assert.ok(!drafts(result).some(entry => entry.targetId === parent));
    assert.match(manager.buildSessionProjection().entries.find(entry => entry.sourceEntry.id === parent).messages[0].content[0].text, /failure evidence/);
  });
}
