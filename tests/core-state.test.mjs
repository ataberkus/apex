import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createTaskState } from '../extensions/apex-core/state.mjs';
import {directoryLink, fileLink} from './fixtures/filesystem.mjs';

const offline = { allowed_model: 'openrouter/meta/muse-spark-1.3-contributor', thinking_level: 'xhigh', paid_runs_enabled: false, execution_policy: 'offline-only' };
const authorized = { ...offline, paid_runs_enabled: true, execution_policy: 'paid-enabled' };
const usage = { input: 17, output: 9, cacheRead: 0, cacheWrite: 0, totalTokens: 26, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const criterion = { id: 'R1', requirement: 'Keep literal $(never execute) `touch bad`\nline.', check: 'npm test' };
const boundary = (overrides = {}) => ({ type: 'agent_before_settle', entries: [], continue: false, outcome: 'completed', context: { canContinue: true, pendingMessages: [] }, ...overrides });
const call = (id, name, input) => ({ type: 'tool_call', toolCallId: id, toolName: name, input });
const result = (id, name, input, overrides = {}) => ({ type: 'tool_result', toolCallId: id, toolName: name, input, content: [{ type: 'text', text: 'ok' }], isError: false, ...overrides });
const execute = (tool, params, signal) => tool.execute('synthetic-tool', params, signal, undefined, {});
const verify = (state, id = 'v', command = 'npm test', overrides = {}) => {
  state.observeTool(call(id, 'bash', { command }));
  state.observeTool(result(id, 'bash', { command }, { structuredContent: { exit_code: 0, output: 'all pass' }, ...overrides }));
};
async function fixture(t, options = {}) {
  const cwd = await mkdtemp(path.join(process.cwd(), 'tests/.state-fixture-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const entries = [];
  const state = createTaskState({ cwd, policy: offline, persist: (customType, data) => entries.push({ type: 'custom', customType, data: structuredClone(data) }), ...options });
  await state.begin('Implement the requested task');
  return { state, cwd, entries };
}

test('offline extraction denies before registry/auth/completion and exposes manual criteria', async t => {
  let touched = 0;
  const { state } = await fixture(t, { complete: () => { touched++; throw new Error('must not run'); } });
  const ctx = { get modelRegistry() { touched++; throw new Error('registry access'); } };
  const denied = await state.extractContract('Implement the requested task', ctx);
  assert.equal(denied.status, 'blocked');
  assert.equal(touched, 0);
  const response = await execute(state.contractTool(), { action: 'set', criteria: [criterion] });
  assert.equal(state.contractTool().name, 'contract');
  assert.deepEqual(state.snapshot().contract.criteria, [criterion]);
  assert.deepEqual(response.structuredContent.criteria, [criterion]);
  assert.equal(state.snapshot().contract.source, 'manual');
});

test('future authorized extraction uses one native exact FAST/xhigh completion and records usage', async t => {
  const model = { provider: 'openrouter', id: 'meta/muse-spark-1.3-contributor', api: 'openai-completions', reasoning: true, maxTokens: 8000 };
  let requests = 0;
  const { state } = await fixture(t, { policy: authorized, complete: async (selected, context, options) => {
    requests++;
    assert.equal(selected, model);
    assert.equal(options.reasoningEffort, 'xhigh');
    assert.deepEqual(context.tools, []);
    assert.match(context.messages[0].content[0].text, /Extract the acceptance criteria.*JSON array/s);
    return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify([criterion]) }], usage };
  } });
  const ctx = { modelRegistry: { find: (provider, id) => { assert.equal(provider, 'openrouter'); assert.equal(id, model.id); return model; } } };
  assert.equal((await state.extractContract(state.snapshot().task, ctx)).status, 'complete');
  assert.equal((await state.extractContract(state.snapshot().task, ctx)).status, 'already-attempted');
  assert.equal(requests, 1);
  assert.deepEqual(state.snapshot().contract.usage, usage);
  assert.deepEqual(state.snapshot().contract.criteria, [criterion]);
  assert.equal(state.snapshot().todos.length, 1);
});

test('extraction fails closed on alternate models, cancellation, malformed criteria and missing usage', async t => {
  for (const mode of ['model', 'aborted', 'json', 'usage']) {
    let calls = 0;
    const { state } = await fixture(t, { policy: authorized, complete: async () => { calls++; return { stopReason: 'stop', content: [{ type: 'text', text: mode === 'json' ? '[{"id":"R1"}]' : JSON.stringify([criterion]) }], ...(mode === 'usage' ? {} : { usage }) }; } });
    const signal = new AbortController();
    if (mode === 'aborted') signal.abort();
    const model = { provider: mode === 'model' ? 'alternate' : 'openrouter', id: 'meta/muse-spark-1.3-contributor', api: 'openai-completions', reasoning: true };
    assert.notEqual((await state.extractContract(state.snapshot().task, { modelRegistry: { find: () => model } }, { signal: signal.signal })).status, 'complete');
    assert.equal(state.snapshot().contract.criteria.length, 0);
    if (['model', 'aborted'].includes(mode)) assert.equal(calls, 0);
  }
});

test('contract and todo custom data retain exact JSON and restore through compaction', async t => {
  const { state, cwd, entries } = await fixture(t, { enforceTodo: true, enforceContract: true });
  await execute(state.contractTool(), { action: 'set', criteria: [criterion] });
  await execute(state.todoTool(), { action: 'done', id: 'R1' });
  verify(state);
  const snap = state.snapshot();
  const apexState = {};
  for (const entry of entries) apexState[entry.customType] = entry.data;
  const restored = createTaskState({ cwd, branch: [{ type: 'compaction', details: { apexState } }], policy: offline, enforceTodo: true, enforceContract: true });
  assert.deepEqual(restored.snapshot(), snap);
  const r = await restored.beforeSettle(boundary());
  assert.equal(r.continue, undefined);
  assert.equal(restored.snapshot().contract.criteria[0].requirement, criterion.requirement);
  const beforeId = restored.snapshot().taskId;
  await restored.begin(snap.task);
  assert.equal(restored.snapshot().taskId, beforeId);
  await restored.begin(snap.task, { newRun: true });
  assert.notEqual(restored.snapshot().taskId, beforeId);
  assert.equal(restored.snapshot().todos.length, 0);
  assert.equal(restored.snapshot().ledger.verification, null);
});

test('todo serializes concurrent deltas and requires concrete dropped reasons', async t => {
  const { state } = await fixture(t);
  const tool = state.todoTool();
  assert.equal(tool.name, 'todo');
  assert.equal(tool.executionMode, 'sequential');
  const responses = await Promise.all([execute(tool, { action: 'add', text: 'one' }), execute(tool, { action: 'add', text: 'two' })]);
  assert.deepEqual(responses.map(r => r.structuredContent.delta[0].id), ['T1', 'T2']);
  assert.equal(responses[1].structuredContent.delta.length, 1);
  await assert.rejects(execute(tool, { action: 'drop', id: 'T1' }), /reason/i);
  await execute(tool, { action: 'update', id: 'T1', status: 'in_progress' });
  await execute(tool, { action: 'drop', id: 'T1', reason: 'User removed this requirement' });
  await execute(tool, { action: 'done', id: 'T2' });
  assert.equal(state.snapshot().todos[0].reason, 'User removed this requirement');
  assert.equal((await execute(tool, { action: 'list' })).structuredContent.todos.length, 2);
  await assert.rejects(execute(tool, { action: 'update', id: 'missing', status: 'done' }), /unknown/i);
});

test('snapshot is detached and task reset cannot preserve foreign branch criteria', async t => {
  const { state, cwd, entries } = await fixture(t);
  await execute(state.contractTool(), { action: 'set', criteria: [criterion] });
  const snapshot = state.snapshot();
  snapshot.contract.criteria[0].check = 'forged';
  assert.equal(state.snapshot().contract.criteria[0].check, 'npm test');
  await state.begin('A different user task');
  assert.equal(state.snapshot().contract.criteria.length, 0);
  const foreign = entries.find(e => e.customType === 'apex-contract');
  const restored = createTaskState({ cwd, branch: [...entries, foreign], policy: offline });
  assert.equal(restored.snapshot().task, 'A different user task');
  assert.equal(restored.snapshot().contract.criteria.length, 0);
});

test('gate caps forced continuations at two and preserves prior boundary drafts', async t => {
  const { state } = await fixture(t, { enforceTodo: true, enforceContract: true });
  const prior = { type: 'custom', customType: 'another-extension', data: { keep: true } };
  for (let n = 0; n < 2; n++) {
    const response = await state.beforeSettle(boundary({ entries: [prior] }));
    assert.equal(response.entries[0], prior);
    assert.equal(response.continue, true);
    assert.match(response.entries.at(-1).content, /Before finishing, these items are still open/);
  }
  const capped = await state.beforeSettle(boundary({ entries: [prior] }));
  assert.deepEqual(capped.entries, [prior]);
  assert.equal(capped.continue, undefined);
  assert.equal(state.snapshot().gateContinuations, 2);
});

test('unverified gate names the checks it accepts so the model need not guess', async t => {
  const { state } = await fixture(t);
  state.observeTool(call('m', 'edit', { path: 'lib/a.js' }));
  state.observeTool(result('m', 'edit', { path: 'lib/a.js' }));
  // A passing ad hoc script cannot count: the ledger cannot tell it from a mutation.
  verify(state, 'adhoc', 'node -e "assert.equal(1, 1)"');
  const response = await state.beforeSettle(boundary());
  assert.equal(response.continue, true);
  const content = response.entries.at(-1).content;
  for (const accepted of ['npm test', 'bun test', 'node --test', 'pytest', 'tsc --noEmit', 'cargo test', 'go test']) assert.ok(content.includes(accepted), `${accepted} missing from: ${content}`);
  assert.match(content, /shell operators/);
  assert.match(content, /ad hoc|node -e/i);
});

test('aborted/error/pending/malformed boundaries never consume caps or force requests', async t => {
  const { state } = await fixture(t, { enforceTodo: true, enforceContract: true });
  const prior = { type: 'custom', customType: 'keep', data: {} };
  for (const overrides of [{ outcome: 'aborted' }, { outcome: 'error' }, { context: { pendingMessages: [] } }, { context: { canContinue: true, pendingMessages: [{}] } }]) {
    const response = await state.beforeSettle(boundary({ entries: [prior], ...overrides }));
    assert.deepEqual(response.entries, [prior]);
    assert.equal(response.continue, undefined);
  }
  assert.equal(state.snapshot().gateContinuations, 0);
});

test('completed final-assistant boundary becomes continuable through its own nonempty native draft', async t => {
  const { state } = await fixture(t, { enforceContract: true });
  const response = await state.beforeSettle(boundary({ context: { canContinue: false, pendingMessages: [], llmMessages: [{ role: 'assistant', content: [] }] } }));
  assert.equal(response.continue, true);
  assert.equal(response.entries.at(-1).type, 'custom_message');
  assert.ok(response.entries.at(-1).content.length > 0);
  assert.equal(state.snapshot().gateContinuations, 1);
});

test('missing todo steer occurs once after two turns only for an explicit multi-step task', async t => {
  const { state } = await fixture(t, { enforceTodo: true });
  await state.begin('1. Inspect sources\n2. Implement a fix\n3. Verify the result');
  const turn = i => boundary({ type: 'turn_end', turnIndex: i, message: { role: 'assistant', stopReason: 'stop', content: [] }, messageEntryId: `m${i}` });
  assert.equal((await state.onTurn(turn(0))).continue, undefined);
  assert.equal((await state.onTurn(turn(1))).continue, true);
  assert.equal((await state.onTurn(turn(2))).continue, undefined);
  assert.equal(state.snapshot().todoSteers, 1);
  assert.equal(state.snapshot().turns, 3);
  await state.begin('Read one file');
  await state.onTurn(turn(0));
  assert.equal((await state.onTurn(turn(1))).continue, undefined);
});

test('verification must be an actual successful known checker after the final mutation', async t => {
  const { state } = await fixture(t);
  verify(state);
  assert.ok(state.snapshot().ledger.verification);
  state.observeTool(call('edit', 'edit', { path: 'file.js', oldText: 'a', newText: 'b' }));
  state.observeTool(result('edit', 'edit', { path: 'file.js' }));
  assert.equal(state.snapshot().ledger.verification, null);
  verify(state, 'fake', 'echo tests pass');
  assert.equal(state.snapshot().ledger.verification, null);
  verify(state, 'failed', 'npm test', { isError: true, structuredContent: { exit_code: 1 } });
  assert.equal(state.snapshot().ledger.verification, null);
  verify(state, 'text', 'npm test', { structuredContent: undefined, content: [{ type: 'text', text: 'PASS exit code 0' }] });
  assert.equal(state.snapshot().ledger.verification, null);
  verify(state, 'real', 'node --test tests/*.test.mjs');
  assert.equal((await state.beforeSettle(boundary())).continue, undefined);
  assert.equal(state.snapshot().ledger.verification.toolCallId, 'real');
});

test('read-only observation chains keep a passing check; any mutating or ambiguous part voids it', async t => {
  const { state } = await fixture(t);
  for (const command of ['git status --porcelain=v1 && git status', 'git diff --check; git log -1', 'git log --oneline | head -5', 'git rev-parse HEAD || pwd']) {
    verify(state, `v:${command}`);
    state.observeTool(call(`o:${command}`, 'bash', { command }));
    state.observeTool(result(`o:${command}`, 'bash', { command }, { structuredContent: { exit_code: 0 } }));
    assert.ok(state.snapshot().ledger.verification, `${command} voided the check`);
  }
  for (const command of ['git status && touch x', 'git status & touch x', 'cat a > b', 'git log | xargs rm', 'cat $(touch x)',
    'git diff --output=x', "git diff '--output=x'", 'rg --pre=sh x', "rg '--pre=sh' x", 'git show --ext-dif\\f']) {
    verify(state, `v:${command}`);
    state.observeTool(call(`m:${command}`, 'bash', { command }));
    assert.equal(state.snapshot().ledger.verification, null, `${command} kept the check`);
  }
});

test('only an && chain can carry a verifier success; pipes, || and ; cannot', async t => {
  const { state } = await fixture(t);
  verify(state, 'chained', 'npm test && git status --short');
  assert.equal(state.snapshot().ledger.verification?.toolCallId, 'chained');
  for (const command of ['npm test | tail -5', 'npm test || git status', 'npm test; git status']) {
    verify(state, `x:${command}`, command);
    assert.equal(state.snapshot().ledger.verification, null, `${command} counted as verification`);
  }
});

test('unknown bash and apply_patch invalidate stale checks even on error', async t => {
  const { state } = await fixture(t);
  for (const [id, name, input] of [['u', 'bash', { command: 'python custom.py' }], ['p', 'apply_patch', { patch: 'invalid' }], ['w', 'write', { path: 'out', content: 'x' }]]) {
    verify(state, `v-${id}`);
    state.observeTool(call(id, name, input));
    assert.equal(state.snapshot().ledger.verification, null);
    state.observeTool(result(id, name, input, { isError: true }));
    assert.equal(state.snapshot().ledger.verification, null);
  }
});

test('sibling verifier begun before an edit cannot prove success after that edit', async t => {
  const { state } = await fixture(t);
  state.observeTool(call('v', 'bash', { command: 'npm test' }));
  state.observeTool(call('w', 'write', { path: 'x', content: 'new' }));
  state.observeTool(result('w', 'write', { path: 'x' }));
  state.observeTool(result('v', 'bash', { command: 'npm test' }, { structuredContent: { exit_code: 0 } }));
  assert.equal(state.snapshot().ledger.verification, null);
  verify(state, 'fresh');
  assert.ok(state.snapshot().ledger.verification);
});

test('verifier completed while sibling mutation remains pending cannot clear the gate', async t => {
  const { state } = await fixture(t);
  state.observeTool(call('w', 'write', { path: 'x', content: 'new' }));
  verify(state);
  assert.equal(state.snapshot().ledger.verification, null);
  assert.equal(state.snapshot().ledger.pending.length, 1);
  state.observeTool(result('w', 'write', { path: 'x' }));
  assert.equal(state.snapshot().ledger.verification, null);
  verify(state, 'fresh');
  assert.ok(state.snapshot().ledger.verification);
});

test('nested native events are coherent and duplicate execution events are idempotent', async t => {
  const { state } = await fixture(t);
  state.observeTool(call('parent', 'codemode', { code: 'tools.write(...)' }));
  const nested = { ...call('parent/1', 'write', { path: 'x', content: 'new' }), parentToolCallId: 'parent' };
  state.observeTool(nested);
  state.observeTool({ type: 'tool_execution_start', toolCallId: 'parent/1', toolName: 'write', args: nested.input, parentToolCallId: 'parent' });
  state.observeTool({ ...result('parent/1', 'write', nested.input), parentToolCallId: 'parent' });
  const afterResult = state.snapshot().ledger.lastMutation;
  state.observeTool({ type: 'tool_execution_end', toolCallId: 'parent/1', toolName: 'write', result: { content: [] }, isError: false, parentToolCallId: 'parent' });
  assert.equal(state.snapshot().ledger.lastMutation, afterResult);
  verify(state);
  state.observeTool(result('parent', 'codemode', {}, { nestedCalls: { complete: true, calls: [{ id: 'parent/1', name: 'write', arguments: nested.input, status: 'ok' }] } }));
  assert.ok(state.snapshot().ledger.verification);
  assert.equal(state.snapshot().ledger.pending.length, 0);
});

test('unseen or incomplete nested mutation summaries invalidate instead of inventing verification', async t => {
  const { state } = await fixture(t);
  verify(state);
  state.observeTool(result('unknown-parent', 'codemode', {}, { nestedCalls: { complete: false, calls: [{ id: 'unknown/1', name: 'write', status: 'ok' }] } }));
  assert.equal(state.snapshot().ledger.verification, null);
});

test('explicit artifacts check confined paths and parsed format without executing check strings', async t => {
  const { state, cwd } = await fixture(t, { enforceContract: true });
  await writeFile(path.join(cwd, 'out.json'), '{"answer":42}');
  const criteria = [{ id: 'R1', requirement: 'Deliver JSON', check: 'touch MUST_NOT_EXIST', artifact: { path: 'out.json', format: 'json' } }];
  await execute(state.contractTool(), { action: 'set', criteria });
  verify(state);
  assert.equal((await state.beforeSettle(boundary())).continue, undefined);
  await assert.rejects(import('node:fs/promises').then(fs => fs.access(path.join(cwd, 'MUST_NOT_EXIST'))));
  await writeFile(path.join(cwd, 'out.json'), 'not json');
  const unmet = await state.beforeSettle(boundary());
  assert.equal(unmet.continue, true);
  assert.match(unmet.entries.at(-1).content, /out.json.*json/i);
});

test('artifact validation rejects traversal, external absolutes, symlinks and conflicting formats', async t => {
  const { state, cwd } = await fixture(t, { enforceContract: true });
  await writeFile(path.join(cwd, 'data.json'), '{}');
  for (const artifact of [{ path: '../escape.json', format: 'json' }, { path: '/outside.json', format: 'json' }, { path: 'data.json', format: 'pdf' }, { path: 'data.json', format: 'shell' }]) {
    await assert.rejects(execute(state.contractTool(), { action: 'set', criteria: [{ ...criterion, artifact }] }), /path|format/i);
  }
  await t.test('file symlink artifact refused', async t => {
    if (!await fileLink(t, 'data.json', path.join(cwd, 'linked.json'))) return;
    await execute(state.contractTool(), { action: 'set', criteria: [{ ...criterion, artifact: { path: 'linked.json', format: 'json' } }] });
    verify(state);
    assert.match((await state.beforeSettle(boundary())).entries.at(-1).content, /symlink/i);
  });
});

test('criteria do not claim semantic compliance from file existence or opaque check text', async t => {
  const { state, cwd } = await fixture(t, { enforceContract: true });
  await writeFile(path.join(cwd, 'out.txt'), 'not the answer');
  await execute(state.contractTool(), { action: 'set', criteria: [{ ...criterion, artifact: { path: 'out.txt', format: 'text', contains: 'exact answer' } }] });
  verify(state);
  assert.match((await state.beforeSettle(boundary())).entries.at(-1).content, /content|contains/i);
  assert.equal(state.snapshot().contract.criteria[0].check, criterion.check);
});

test('checker help/version requests and later failed checks cannot preserve a passing gate', async t => {
  const { state } = await fixture(t);
  verify(state, 'pass');
  verify(state, 'help', 'node --check --help');
  assert.equal(state.snapshot().ledger.verification, null);
  verify(state, 'pass-again');
  verify(state, 'failed-after-pass', 'npm test', { isError: true, structuredContent: { exit_code: 1 } });
  assert.equal(state.snapshot().ledger.verification, null);
});

test('changing a criterion resets resolved matching todo instead of reusing old acceptance', async t => {
  const { state } = await fixture(t);
  await execute(state.contractTool(), { action: 'set', criteria: [criterion] });
  await execute(state.todoTool(), { action: 'done', id: 'R1' });
  await execute(state.contractTool(), { action: 'set', criteria: [{ ...criterion, requirement: 'A changed requirement' }] });
  assert.equal(state.snapshot().todos[0].status, 'pending');
  assert.equal(state.snapshot().todos[0].text, 'A changed requirement');
});

test('valid extraction usage is retained even when generated criteria are invalid', async t => {
  const { state } = await fixture(t, { policy: authorized, complete: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: 'not JSON' }], usage }) });
  const model = { provider: 'openrouter', id: 'meta/muse-spark-1.3-contributor', api: 'openai-completions', reasoning: true };
  await state.extractContract(state.snapshot().task, { modelRegistry: { find: () => model } });
  assert.deepEqual(state.snapshot().extraction.usage, usage);
  assert.equal(state.snapshot().contract.criteria.length, 0);
});

test('extraction cannot publish after an active native branch changes', async t => {
  let resolveCompletion;
  const { state } = await fixture(t, { policy: authorized, complete: () => new Promise(resolve => { resolveCompletion = resolve; }) });
  const model = { provider: 'openrouter', id: 'meta/muse-spark-1.3-contributor', api: 'openai-completions', reasoning: true };
  let activeBranch = [{ id: 'before' }];
  const response = state.extractContract(state.snapshot().task, { modelRegistry: { find: () => model }, sessionManager: { getBranch: () => activeBranch } });
  while (!resolveCompletion) await new Promise(resolve => setImmediate(resolve));
  activeBranch = [{ id: 'other-branch' }];
  resolveCompletion({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify([criterion]) }], usage });
  assert.equal((await response).status, 'stale');
  assert.equal(state.snapshot().contract.criteria.length, 0);
});

test('artifact format parser rejects invalid CSV after a closing quote and directory symlinks', async t => {
  const { state, cwd } = await fixture(t, { enforceContract: true });
  await writeFile(path.join(cwd, 'data.csv'), '"first"bad,second\n');
  await execute(state.contractTool(), { action: 'set', criteria: [{ ...criterion, artifact: { path: 'data.csv', format: 'csv' } }] });
  verify(state);
  assert.equal((await state.beforeSettle(boundary())).continue, true);
  await mkdir(path.join(cwd, 'real'));
  await writeFile(path.join(cwd, 'real', 'data.json'), '{}');
  await directoryLink('real', path.join(cwd, 'shortcut'));
  await execute(state.contractTool(), { action: 'set', criteria: [{ ...criterion, artifact: { path: 'shortcut/data.json', format: 'json' } }] });
  assert.match((await state.beforeSettle(boundary())).entries.at(-1).content, /symlink/);
});

test('Phase 1 compaction that retains only contract/todo still restores task identity and continuation caps', async t => {
  const { state, cwd, entries } = await fixture(t, { enforceContract: true });
  await execute(state.contractTool(), { action: 'set', criteria: [criterion] });
  await state.beforeSettle(boundary());
  await state.beforeSettle(boundary());
  const apexState = {};
  for (const entry of entries) if (['apex-contract', 'apex-todo'].includes(entry.customType)) apexState[entry.customType] = entry.data;
  const restored = createTaskState({ cwd, branch: [{ type: 'compaction', details: { apexState } }], enforceContract: true, policy: offline });
  assert.equal(restored.snapshot().taskId, state.snapshot().taskId);
  assert.deepEqual(restored.snapshot().contract, state.snapshot().contract);
  assert.equal(restored.snapshot().gateContinuations, 2);
  assert.equal((await restored.beforeSettle(boundary())).continue, undefined);
});

test('explicit three inline numbered steps trigger the same bounded missing-todo steering', async t => {
  const { state } = await fixture(t, { enforceTodo: true });
  await state.begin('Complete three local steps: 1. write a file; 2. verify it; 3. report the outcome.');
  await state.onTurn(boundary({ type: 'turn_end', messageEntryId: 'inline1', message: { stopReason: 'stop' } }));
  assert.equal((await state.onTurn(boundary({ type: 'turn_end', messageEntryId: 'inline2', message: { stopReason: 'stop' } }))).continue, true);
});

test('observation-looking shell hooks and incomplete checker results invalidate stale success', async t => {
  const { state } = await fixture(t);
  for (const command of ['rg --pre arbitrary-hook needle .', 'git diff --ext-diff', 'git --no-pager diff', 'cat file > changed']) {
    verify(state, `prior-${command}`);
    state.observeTool(call(command, 'bash', { command }));
    state.observeTool(result(command, 'bash', { command }, { structuredContent: { exit_code: 0 } }));
    assert.equal(state.snapshot().ledger.verification, null);
  }
});

test('pending mutation persistence is bounded while all live calls still block verification', async t => {
  const { state, entries } = await fixture(t);
  for (let i = 0; i < 150; i++) state.observeTool(call(`pending-${i}-${'x'.repeat(256)}`, 'write', { path: 'out', content: 'x' }));
  assert.ok(state.snapshot().ledger.pending.length <= 128);
  assert.equal(state.snapshot().ledger.pendingCount, 150);
  assert.ok(entries.filter(e => e.customType === 'apex-task-state').every(e => e.data.ledger.pending.length <= 128));
  verify(state);
  assert.equal(state.snapshot().ledger.verification, null);
});

test('completion usage is accounted to its originating task when abortion follows the response', async t => {
  const controller = new AbortController();
  const { state, entries } = await fixture(t, { policy: authorized, complete: async () => {
    controller.abort();
    return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify([criterion]) }], usage };
  } });
  const taskId = state.snapshot().taskId;
  const model = { provider: 'openrouter', id: 'meta/muse-spark-1.3-contributor', api: 'openai-completions', reasoning: true };
  const response = await state.extractContract(state.snapshot().task, { modelRegistry: { find: () => model } }, { signal: controller.signal });
  assert.equal(response.status, 'aborted');
  assert.deepEqual(response.usage, usage);
  assert.equal(response.taskId, taskId);
  assert.deepEqual(state.snapshot().extraction.usage, usage);
  assert.equal(state.snapshot().contract.criteria.length, 0);
  const accounting = entries.filter(e => e.customType === 'apex-helper-usage');
  assert.deepEqual(accounting.map(e => ({ taskId: e.data.taskId, usage: e.data.usage })), [{ taskId, usage }]);
  assert.equal(accounting[0].data.status, 'aborted');
  assert.equal(accounting[0].data.complete, true);
});

test('completion error usage is accounted once even when no criteria can be published', async t => {
  const failure = Object.assign(new Error('synthetic failed completion'), { usage });
  const { state, entries } = await fixture(t, { policy: authorized, complete: async () => { throw failure; } });
  const taskId = state.snapshot().taskId;
  const model = { provider: 'openrouter', id: 'meta/muse-spark-1.3-contributor', api: 'openai-completions', reasoning: true };
  const response = await state.extractContract(state.snapshot().task, { modelRegistry: { find: () => model } });
  assert.equal(response.status, 'failed');
  assert.deepEqual(response.usage, usage);
  assert.equal(response.taskId, taskId);
  assert.deepEqual(state.snapshot().extraction.usage, usage);
  assert.equal(state.snapshot().contract.criteria.length, 0);
  const accounting = entries.filter(e => e.customType === 'apex-helper-usage');
  assert.equal(accounting.length, 1);
  assert.equal(accounting[0].data.status, 'failed');
  assert.equal(accounting[0].data.complete, false);
});

test('stale branch and revoked policy still retain incurred completion usage without publishing criteria', async t => {
  for (const mode of ['branch', 'policy']) {
    const policy = { ...authorized };
    let activeBranch = [{ id: 'original' }];
    const { state, entries } = await fixture(t, { policy, complete: async () => {
      if (mode === 'branch') activeBranch = [{ id: 'other' }];
      else policy.paid_runs_enabled = false;
      return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify([criterion]) }], usage };
    } });
    const taskId = state.snapshot().taskId;
    const model = { provider: 'openrouter', id: 'meta/muse-spark-1.3-contributor', api: 'openai-completions', reasoning: true };
    const response = await state.extractContract(state.snapshot().task, { modelRegistry: { find: () => model }, sessionManager: { getBranch: () => activeBranch } });
    assert.equal(response.status, 'stale');
    assert.deepEqual(response.usage, usage);
    assert.equal(response.taskId, taskId);
    assert.deepEqual(state.snapshot().extraction.usage, usage);
    assert.equal(state.snapshot().contract.criteria.length, 0);
    const accounting = entries.filter(e => e.customType === 'apex-helper-usage');
    assert.deepEqual(accounting.map(e => e.data.taskId), [taskId]);
    assert.equal(accounting[0].data.status, 'stale');
    assert.equal(accounting[0].data.complete, true);
  }
});

test('a new user task never inherits a previous task completion or error usage', async t => {
  for (const mode of ['response', 'error']) {
    let activeState, nextTask;
    const { state, entries } = await fixture(t, { policy: authorized, complete: async () => {
      nextTask = activeState.begin('A fresh task that must retain zero usage', { newRun: true });
      if (mode === 'error') throw Object.assign(new Error('old-task completion failure'), { usage });
      return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify([criterion]) }], usage };
    } });
    activeState = state;
    const originTaskId = state.snapshot().taskId;
    const model = { provider: 'openrouter', id: 'meta/muse-spark-1.3-contributor', api: 'openai-completions', reasoning: true };
    const response = await state.extractContract(state.snapshot().task, { modelRegistry: { find: () => model } });
    await nextTask;
    assert.equal(response.status, 'stale');
    assert.deepEqual(response.usage, usage);
    assert.equal(response.taskId, originTaskId);
    assert.notEqual(state.snapshot().taskId, originTaskId);
    assert.equal(state.snapshot().extraction.usage, null);
    assert.equal(state.snapshot().extraction.attempted, false);
    assert.equal(state.snapshot().contract.criteria.length, 0);
    const accounting = entries.filter(e => e.customType === 'apex-helper-usage');
    assert.deepEqual(accounting.map(e => ({ taskId: e.data.taskId, usage: e.data.usage })), [{ taskId: originTaskId, usage }]);
    assert.equal(accounting[0].data.status, 'stale');
    assert.equal(accounting[0].data.complete, mode === 'response');
  }
});

test('actual extraction requests with missing usage report incomplete accounting and offline denials report none', async t => {
  const { state, entries } = await fixture(t, { policy: authorized, complete: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify([criterion]) }] }) });
  const taskId = state.snapshot().taskId;
  const model = { provider: 'openrouter', id: 'meta/muse-spark-1.3-contributor', api: 'openai-completions', reasoning: true };
  const ctx = { modelRegistry: { find: () => model } };
  assert.equal((await state.extractContract(state.snapshot().task, ctx)).status, 'failed');
  await state.extractContract(state.snapshot().task, ctx);
  const accounting = entries.filter(e => e.customType === 'apex-helper-usage');
  assert.equal(accounting.length, 1);
  assert.deepEqual(accounting[0].data, { version: 1, requestId: `${taskId}:contract:1`, taskId, kind: 'contract', provider: 'openrouter', model: 'meta/muse-spark-1.3-contributor', status: 'failed', complete: false });
  const denied = await fixture(t);
  await denied.state.extractContract(denied.state.snapshot().task, { get modelRegistry() { throw new Error('offline registry must not be reached'); } });
  assert.equal(denied.entries.filter(e => e.customType === 'apex-helper-usage').length, 0);
});

test('successful extraction records exactly one dedicated helper accounting entry', async t => {
  const { state, entries } = await fixture(t, { policy: authorized, complete: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify([criterion]) }], usage }) });
  const taskId = state.snapshot().taskId;
  const model = { provider: 'openrouter', id: 'meta/muse-spark-1.3-contributor', api: 'openai-completions', reasoning: true };
  const ctx = { modelRegistry: { find: () => model } };
  assert.equal((await state.extractContract(state.snapshot().task, ctx)).status, 'complete');
  await state.extractContract(state.snapshot().task, ctx);
  const accounting = entries.filter(e => e.customType === 'apex-helper-usage');
  assert.equal(accounting.length, 1);
  assert.deepEqual(accounting[0].data, { version: 1, requestId: `${taskId}:contract:1`, taskId, kind: 'contract', provider: 'openrouter', model: 'meta/muse-spark-1.3-contributor', usage, status: 'complete', complete: true });
});

test('pre-request registry errors cannot masquerade as incurred extraction usage', async t => {
  const { state, entries } = await fixture(t, { policy: authorized, complete: async () => { throw new Error('must not invoke completion'); } });
  const response = await state.extractContract(state.snapshot().task, { modelRegistry: { find: () => { throw Object.assign(new Error('synthetic registry failure'), { usage }); } } });
  assert.equal(response.status, 'failed');
  assert.equal(response.usage, null);
  assert.equal(state.snapshot().extraction.usage, null);
  assert.equal(entries.filter(e => e.customType === 'apex-helper-usage').length, 0);
});

test('partial error and aborted provider responses retain usage while reporting incomplete accounting', async t => {
  for (const stopReason of ['error', 'aborted']) {
    const controller = new AbortController();
    const { state, entries } = await fixture(t, { policy: authorized, complete: async () => {
      if (stopReason === 'aborted') controller.abort();
      return { stopReason, content: [], usage };
    } });
    const model = { provider: 'openrouter', id: 'meta/muse-spark-1.3-contributor', api: 'openai-completions', reasoning: true };
    const response = await state.extractContract(state.snapshot().task, { modelRegistry: { find: () => model } }, { signal: controller.signal });
    assert.equal(response.status, stopReason === 'aborted' ? 'aborted' : 'failed');
    assert.deepEqual(response.usage, usage);
    assert.equal(state.snapshot().contract.criteria.length, 0);
    const accounting = entries.filter(e => e.customType === 'apex-helper-usage');
    assert.equal(accounting.length, 1);
    assert.deepEqual(accounting[0].data.usage, usage);
    assert.equal(accounting[0].data.complete, false);
  }
});

test('a byte-identical state write is skipped: a read start appends nothing and its result one control pair', async t => {
  const { state, entries } = await fixture(t);
  // begin's trailing apex-todo would repeat the one saveTodo just wrote.
  assert.deepEqual(entries.map(e => e.customType), ['apex-contract', 'apex-todo', 'apex-task-state']);
  for (const id of ['r1', 'r2']) {
    const before = entries.length;
    state.observeTool(call(id, 'read', { path: 'a.txt' }));
    assert.equal(entries.length, before);
    state.observeTool(result(id, 'read', { path: 'a.txt' }));
    assert.deepEqual(entries.slice(before).map(e => e.customType), ['apex-task-state', 'apex-todo']);
    assert.deepEqual(entries.at(-1).data.control, entries.at(-2).data);
  }
  const before = entries.length;
  state.observeTool(call('e1', 'edit', { path: 'a.txt' }));
  assert.deepEqual(entries.slice(before).map(e => e.customType), ['apex-task-state', 'apex-todo']);
  assert.deepEqual(entries.at(-2).data.ledger.pending, ['e1']);
});

test('a todo change appends apex-todo once and a new run still records every state type', async t => {
  const { state, entries } = await fixture(t, { enforceTodo: true });
  let before = entries.length;
  await execute(state.todoTool(), { action: 'add', text: 'step one' });
  assert.deepEqual(entries.slice(before).map(e => e.customType), ['apex-todo']);
  assert.deepEqual(entries.at(-1).data.items, [{ id: 'T1', text: 'step one', status: 'pending' }]);
  assert.deepEqual(entries.at(-1).data.control, entries.findLast(e => e.customType === 'apex-task-state').data);
  before = entries.length;
  await execute(state.todoTool(), { action: 'list' });
  assert.equal(entries.length, before);
  const previous = state.snapshot().taskId;
  await state.begin(state.snapshot().task, { newRun: true });
  assert.deepEqual(entries.slice(before).map(e => e.customType), ['apex-contract', 'apex-todo', 'apex-task-state']);
  assert.ok(entries.slice(before).every(e => e.data.taskId !== previous));
});

test('a state write that throws is attempted again by the next identical save', async t => {
  const cwd = await mkdtemp(path.join(process.cwd(), 'tests/.state-fixture-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const entries = [];
  let failures = 1;
  const state = createTaskState({ cwd, policy: offline, persist: (customType, data) => {
    if (customType === 'apex-task-state' && failures-- > 0) throw new Error('disk full');
    entries.push({ customType, data: structuredClone(data) });
  } });
  await assert.rejects(state.begin('Implement the requested task'), /disk full/);
  assert.deepEqual(entries.map(e => e.customType), ['apex-contract', 'apex-todo']);
  state.observeTool(call('r1', 'read', { path: 'a.txt' }));
  assert.deepEqual(entries.map(e => e.customType), ['apex-contract', 'apex-todo', 'apex-task-state']);
});

test('deduplicated state entries restore what the d0c6d2b recording restores, at every step and across compaction', async t => {
  const cwd = await mkdtemp(path.join(process.cwd(), 'tests/.state-fixture-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const reference = await import('./fixtures/core-state-d0c6d2b.mjs');
  const model = { provider: 'openrouter', id: 'meta/muse-spark-1.3-contributor', api: 'openai-completions', reasoning: true };
  const complete = async () => ({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify([criterion]) }], usage });
  const options = { cwd, policy: authorized, complete, enforceTodo: true, enforceContract: true };
  const recorder = entries => (customType, data) => { entries.push({ type: 'custom', customType, data: structuredClone(data) }); };
  const oldEntries = [], newEntries = [];
  const expected = reference.createTaskState({ ...options, persist: recorder(oldEntries) });
  const actual = createTaskState({ ...options, persist: recorder(newEntries) });
  // Task identities are random UUIDs; map the reference instance's onto this instance's before comparing.
  const ids = [];
  const old = value => ids.reduce((json, [from, to]) => json.replaceAll(from, to), JSON.stringify(value) ?? 'undefined');
  const now = value => JSON.stringify(value) ?? 'undefined';
  const settle = async action => { try { return { value: await action() }; } catch (error) { return { error: error.message }; } };
  const restore = (factory, branch) => factory({ ...options, branch, persist: () => {} }).snapshot();
  const compacted = (entries, length) => {
    const apexState = {};
    for (const entry of entries.slice(0, length)) if (['apex-contract', 'apex-todo'].includes(entry.customType)) apexState[entry.customType] = entry.data;
    return [{ type: 'compaction', details: { apexState } }, ...entries.slice(length)];
  };
  const random = (seed => n => Math.floor((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32 * n))(31337);
  const pick = list => list[random(list.length)];
  const tasks = ['Implement the requested task', 'Do three things: 1. write a file; 2. verify it; 3. report.', 'Fix the parser'];
  const tools = [['read', { path: 'a.txt' }], ['grep', { pattern: 'x' }], ['edit', { path: 'a.txt', edits: [] }], ['write', { path: 'b.txt', content: 'x' }],
    ['bash', { command: 'npm test' }], ['bash', { command: 'git status' }], ['bash', { command: 'rm -f x' }], ['bash', { command: 'npm test && git diff' }]];
  const lengths = [];
  let calls = 0;
  for (let step = 0; step < 400; step++) {
    const kind = random(12);
    let action;
    if (kind === 0) {
      const task = pick(tasks), newRun = random(2) === 0;
      action = state => state.begin(task, { newRun });
    } else if (kind <= 5) {
      const [name, input] = pick(tools), id = `call-${calls++}`, phase = random(5);
      const outcome = { isError: random(5) === 0, structuredContent: { exit_code: random(4) === 0 ? 1 : 0 } };
      action = state => {
        const started = phase === 4 ? undefined : state.observeTool(call(id, name, input));
        return phase === 3 ? started : state.observeTool(result(id, name, input, outcome));
      };
    } else if (kind <= 7) {
      const params = pick([{ action: 'add', text: `step ${step}` }, { action: 'list' }, { action: 'done', id: pick(['T1', 'T2', 'R1']) },
        { action: 'update', id: pick(['T1', 'T2', 'R1']), status: pick(['pending', 'in_progress']) }, { action: 'drop', id: 'T1' },
        { action: 'drop', id: pick(['T1', 'T2']), reason: 'Not needed' }]);
      action = state => execute(state.todoTool(), params);
    } else if (kind === 8) {
      const params = random(2) ? { action: 'set', criteria: [criterion, { id: 'R2', requirement: `Requirement ${random(3)}`, check: 'npm test' }] } : { action: 'list' };
      action = state => execute(state.contractTool(), params);
    } else if (kind === 9) {
      const event = boundary({ type: 'turn_end', messageEntryId: `turn-${random(6)}`, message: { stopReason: pick(['stop', 'stop', 'aborted']) } });
      action = state => state.onTurn(event);
    } else if (kind === 10) {
      action = state => state.beforeSettle(boundary());
    } else {
      action = state => state.extractContract(state.snapshot().task, { modelRegistry: { find: () => model } });
    }
    const before = expected.snapshot().taskId;
    const oldResult = await settle(() => action(expected));
    const newResult = await settle(() => action(actual));
    if (expected.snapshot().taskId !== before) ids.push([expected.snapshot().taskId, actual.snapshot().taskId]);
    assert.equal(now(newResult), old(oldResult), `step ${step}`);
    assert.equal(now(actual.snapshot()), old(expected.snapshot()), `step ${step}`);
    assert.equal(now(restore(createTaskState, newEntries)), old(restore(reference.createTaskState, oldEntries)), `restore at step ${step}`);
    lengths.push([oldEntries.length, newEntries.length]);
  }
  for (const [oldLength, newLength] of lengths.filter((_, index) => index % 20 === 0)) {
    assert.equal(now(restore(createTaskState, compacted(newEntries, newLength))), old(restore(reference.createTaskState, compacted(oldEntries, oldLength))));
  }
  // The new recording is the reference recording minus entries that repeat the previous entry of their type byte for
  // byte; each dropped entry names the task of the nearest kept entry, so usage attribution is unchanged too.
  const previous = new Map();
  let next = 0, skipped = 0, nearest;
  for (const entry of oldEntries) {
    const json = old(entry);
    if (next < newEntries.length && json === now(newEntries[next])) { next++; nearest = entry; }
    else {
      skipped++;
      assert.equal(json, previous.get(entry.customType));
      assert.equal(entry.data.taskId ?? entry.data.control?.taskId, nearest.data.taskId ?? nearest.data.control?.taskId);
    }
    previous.set(entry.customType, json);
  }
  assert.equal(next, newEntries.length);
  assert.ok(skipped > 100 && newEntries.length > 100, `${skipped} skipped of ${oldEntries.length}`);
});
