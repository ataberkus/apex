import assert from 'node:assert/strict';
import test from 'node:test';

const load = () => import('../extensions/apex-features/accounting.mjs').catch(() => ({}));
const usage = (input = 10, output = 4, extra = {}) => ({input, output, cacheRead: 2, cacheWrite: 1,
  totalTokens: input + output + 3, cost: {input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037}, ...extra});
const assistant = (id, parentId, value = usage(), content = [{type: 'text', text: 'SECRET assistant'}]) =>
  ({type: 'message', id, parentId, message: {role: 'assistant', provider: 'fixture', model: 'model',
    content, usage: value, stopReason: 'stop'}});
const rates = {provider: 'fixture', model: 'model', input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5};
const helper = (id, parentId, requestId, value = usage(7, 2), extra = {}) =>
  ({type: 'custom', id, parentId, customType: 'apex-helper-usage', data: {version: 1, requestId,
    taskId: 'task-1', kind: 'contract', provider: 'fixture', model: 'model', usage: value, complete: true, status: 'complete', ...extra}});

test('session and selected native branch have separate totals without mutating source snapshots', async () => {
  const {summarizeSession} = await load(); assert.equal(typeof summarizeSession, 'function');
  const entries = [assistant('a', null), assistant('b', 'a', usage(20, 8)), assistant('c', 'a', usage(5, 2))];
  const before = structuredClone(entries);
  const all = summarizeSession(entries, {pricing: rates});
  assert.deepEqual(all.totals, {input: 35, output: 14, cacheRead: 6, cacheWrite: 3, totalTokens: 58, thinking: null, cacheWrite1h: null});
  assert.equal(all.scope, 'session'); assert.equal(all.cost.pricingEstimateUsd, 0.0000651);
  const branch = summarizeSession(entries, {branch: 'c', pricing: rates});
  assert.equal(branch.scope, 'branch'); assert.equal(branch.totals.input, 15); assert.equal(branch.totals.totalTokens, 27);
  assert.equal(summarizeSession(entries, {branch: [entries[0], entries[2]]}).totals.input, 15);
  all.tasks[0].totals.input = -99; all.model.id = 'changed';
  assert.deepEqual(entries, before);
});

test('helper replay and state snapshots are billed once while distinct identical requests remain distinct', async () => {
  const {summarizeSession} = await load(); assert.equal(typeof summarizeSession, 'function');
  const one = helper('h1', null, 'task-1:contract:1');
  const entries = [one, structuredClone(one), helper('h2', 'h1', 'task-1:contract:1'),
    {type: 'custom', id: 'state', parentId: 'h2', customType: 'apex-task-state', data: {taskId: 'task-1', extraction: {usage: usage(7, 2)}}},
    helper('h3', 'state', 'task-1:contract:2')];
  const value = summarizeSession(entries, {pricing: rates});
  assert.equal(value.counts.usageRecords, 2); assert.equal(value.totals.input, 14);
  assert.equal(value.counts.duplicateEntries, 1); assert.equal(value.counts.duplicateRequests, 1);
  assert.equal(value.tasks.find(t => t.taskId === 'task-1').totals.output, 4);
});

test('partial or missing helper records preserve known amounts and make full cost unknown', async () => {
  const {summarizeSession, formatCost} = await load(); assert.equal(typeof summarizeSession, 'function');
  const value = summarizeSession([assistant('a', null), helper('h', 'a', 'one', usage(7, 2), {complete: false, status: 'aborted'}),
    helper('missing', 'h', 'two', undefined, {usage: null, complete: false})], {pricing: rates});
  assert.equal(value.completeness.usage, false); assert.equal(value.totals.input, null); assert.equal(value.knownTotals.input, 17);
  assert.equal(value.cost.pricingEstimateUsd, null); assert.ok(value.cost.knownPricingEstimateUsd > 0);
  assert.match(formatCost(value), /unknown|incomplete/i); assert.doesNotMatch(formatCost(value), /\$0\.0000(?:\s|$)/);
});

test('thinking and one-hour cache writes are subsets rather than additional billable tokens', async () => {
  const {summarizeSession} = await load(); assert.equal(typeof summarizeSession, 'function');
  const value = summarizeSession([assistant('a', null, usage(10, 4, {reasoning: 3, cacheWrite1h: 1}))], {pricing: {...rates, cacheWrite1h: 3}});
  assert.equal(value.totals.totalTokens, 17); assert.equal(value.totals.thinking, 3); assert.equal(value.totals.cacheWrite1h, 1);
  assert.equal(value.cost.pricingEstimateUsd, 0.0000212);
  const unknown = summarizeSession([assistant('a', null, usage(10, 4, {reasoning: 3})), assistant('b', 'a')]);
  assert.equal(unknown.totals.thinking, null); assert.equal(unknown.knownTotals.thinking, 3);
});

test('unknown context and absent or partial pricing never become free cost or invented context', async () => {
  const {summarizeSession, formatCost} = await load(); assert.equal(typeof summarizeSession, 'function');
  const value = summarizeSession([assistant('a', null)], {context: {tokens: null, contextWindow: 1000, percent: null}});
  assert.deepEqual(value.context, {tokens: null, window: 1000, percent: null});
  assert.equal(value.cost.pricingEstimateUsd, null); assert.equal(value.cost.nativeEstimateUsd, 0.037);
  assert.match(formatCost(value), /estimate/i); assert.match(formatCost(value), /unknown/i);
  assert.equal(summarizeSession([assistant('a', null)], {pricing: {...rates, output: null}}).cost.pricingEstimateUsd, null);
  assert.equal(summarizeSession([assistant('a', null)], {model: {provider: 'fixture', id: 'model', contextWindow: 1000}, context: {tokens: 250}}).context.percent, 25);
});

test('native compaction, branch summary, usage and attributed tool totals are included without guessed model', async () => {
  const {summarizeSession} = await load(); assert.equal(typeof summarizeSession, 'function');
  const entries = [assistant('a', null), {type: 'compaction', id: 'c', parentId: 'a', summary: 'secret', usage: usage(3, 1)},
    {type: 'branch_summary', id: 'b', parentId: 'c', summary: 'secret', usage: usage(2, 1)},
    {type: 'usage', id: 'u', parentId: 'b', kind: 'cache_warm', provider: 'fixture', model: 'model', usage: usage(1, 1)},
    {type: 'message', id: 't', parentId: 'u', message: {role: 'toolResult', content: [], usage: usage(4, 1),
      details: {apexAux: {version: 1, attempted: true, complete: true, provider: 'fixture', model: 'model'}}}}];
  const value = summarizeSession(entries, {pricing: rates});
  assert.equal(value.totals.input, 20); assert.equal(value.counts.usageRecords, 5);
  assert.equal(value.cost.nativeEstimateUsd, 0.185); assert.equal(value.cost.pricingEstimateUsd, null);
  assert.ok(value.completeness.issues.includes('unattributed_model'));
});

test('category byte estimates count UTF8 content once and top consumers never echo payloads', async () => {
  const {summarizeSession} = await load(); assert.equal(typeof summarizeSession, 'function');
  const entries = [{type: 'message', id: 'u', parentId: null, message: {role: 'user', content: '秘密😀'}},
    assistant('a', 'u', usage(), [{type: 'thinking', thinking: 'SECRET_THOUGHT'}, {type: 'toolCall', id: 'tool', name: 'write', arguments: {content: 'SECRET_TOOL'}}]),
    {type: 'message', id: 't', parentId: 'a', message: {role: 'toolResult', content: [{type: 'text', text: 'SECRET_RESULT'}]}},
    {type: 'custom', id: 's', parentId: 't', customType: 'apex-task-state', data: {task: 'SECRET_SNAPSHOT'}}];
  const value = summarizeSession(entries);
  assert.equal(value.categories.estimateMethod, 'utf8-bytes/4');
  assert.deepEqual(value.categories.user, {bytes: 10, estimatedTokens: 2.5});
  assert.equal(value.categories.thinking.bytes, 14); assert.equal(value.categories.toolResults.bytes, 13);
  assert.equal(value.topConsumers[0].entryId, 'a'); assert.ok(value.categories.toolCalls.bytes > 11);
  assert.doesNotMatch(JSON.stringify(value), /SECRET_|秘密/);
});

test('task identity follows each branch ancestor instead of latest sibling state', async () => {
  const {summarizeSession} = await load(); assert.equal(typeof summarizeSession, 'function');
  const entries = [{type: 'custom', id: 't1', parentId: null, customType: 'apex-task-state', data: {taskId: 'task-1'}},
    assistant('a1', 't1'), {type: 'custom', id: 't2', parentId: 't1', customType: 'apex-task-state', data: {taskId: 'task-2'}},
    assistant('a2', 't2', usage(20, 8)), assistant('a3', 'a1', usage(5, 2))];
  const value = summarizeSession(entries);
  assert.equal(value.tasks.find(t => t.taskId === 'task-1').totals.input, 15);
  assert.equal(value.tasks.find(t => t.taskId === 'task-2').totals.input, 20);
});

test('conflicting IDs, helper identities, invalid subsets, missing compaction and zero placeholders fail honestly', async () => {
  const {summarizeSession} = await load(); assert.equal(typeof summarizeSession, 'function');
  assert.throws(() => summarizeSession([assistant('a', null), assistant('a', null, usage(9, 1))]), /conflict/i);
  assert.throws(() => summarizeSession([helper('h', null, 'one'), helper('h2', 'h', 'one', usage(8, 2))]), /conflict/i);
  const invalid = summarizeSession([assistant('a', null, usage(10, 4, {reasoning: 5}))]);
  assert.equal(invalid.completeness.usage, false); assert.equal(invalid.totals.thinking, null);
  assert.equal(summarizeSession([{type: 'compaction', id: 'c', parentId: null, summary: 'synthetic'}]).completeness.usage, false);
  const zero = usage(0, 0, {cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {total: 0}});
  assert.equal(summarizeSession([assistant('a', null, zero)]).cost.pricingEstimateUsd, null);
});

test('partial subset totals stay unknown when a helper aborted after returning a known prefix', async () => {
  const {summarizeSession} = await load(); assert.equal(typeof summarizeSession, 'function');
  const value = summarizeSession([helper('h', null, 'one', usage(7, 2, {reasoning: 1, cacheWrite1h: 1}), {complete: false})]);
  assert.equal(value.totals.thinking, null); assert.equal(value.knownTotals.thinking, 1);
  assert.equal(value.totals.cacheWrite1h, null); assert.equal(value.knownTotals.cacheWrite1h, 1);
  assert.equal(value.completeness.thinking, false);
});

test('native parent topology does not accept unavailable array branches or sibling ancestry cycles', async () => {
  const {summarizeSession} = await load(); assert.equal(typeof summarizeSession, 'function');
  assert.throws(() => summarizeSession([assistant('a', 'missing')], {branch: 'a'}), /parent/i);
  assert.throws(() => summarizeSession([assistant('a', 'b'), assistant('b', 'a')]), /cycle/i);
  assert.throws(() => summarizeSession([assistant('a', null)], {branch: ['missing']}), /branch/i);
});

test('unsupported usage and unpaid no-attempt tool snapshots cannot be billed as valid helpers', async () => {
  const {summarizeSession} = await load(); assert.equal(typeof summarizeSession, 'function');
  const noAttempt = {type: 'message', id: 't', parentId: null, message: {role: 'toolResult', details: {usage: usage(), apexAux: {version: 1, attempted: false, complete: false}}, content: []}};
  assert.equal(summarizeSession([noAttempt]).counts.usageRecords, 0);
  const unsupported = summarizeSession([{type: 'custom', id: 'x', parentId: null, customType: 'unknown', usage: usage()}], {pricing: rates});
  assert.equal(unsupported.completeness.usage, false); assert.equal(unsupported.cost.pricingEstimateUsd, null);
});

test('unsafe numeric aggregates cannot silently round exact token and native cost totals', async () => {
  const {summarizeSession} = await load(); assert.equal(typeof summarizeSession, 'function');
  const big = {input: 4000000000000000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 4000000000000000, cost: {total: 1}};
  assert.throws(() => summarizeSession([assistant('a', null, big), assistant('b', 'a', big), assistant('c', 'b', big)]), /numeric|limit/i);
  const hugeCost = usage(1, 1, {cost: {total: 1e308}});
  assert.throws(() => summarizeSession([assistant('a', null, hugeCost), assistant('b', 'a', hugeCost)]), /numeric|limit/i);
});

test('identical main response replay is counted once but independent response IDs remain separate', async () => {
  const {summarizeSession} = await load(); assert.equal(typeof summarizeSession, 'function');
  const a = assistant('a', null); a.message.responseId = 'response-1';
  const b = assistant('b', 'a'); b.message.responseId = 'response-1';
  const c = assistant('c', 'b'); c.message.responseId = 'response-2';
  const value = summarizeSession([a, b, c]);
  assert.equal(value.totals.input, 20); assert.equal(value.counts.duplicateRequests, 1);
});

test('an incurred extraction snapshot without its dedicated helper record makes totals incomplete without replay billing', async () => {
  const {summarizeSession} = await load(); assert.equal(typeof summarizeSession, 'function');
  const state = {type: 'custom', id: 'state', parentId: 'a', customType: 'apex-task-state',
    data: {taskId: 'task-1', extraction: {attempted: true, status: 'complete', usage: usage(7, 2)}}};
  const missing = summarizeSession([assistant('a', null), state], {pricing: rates});
  assert.equal(missing.completeness.usage, false); assert.equal(missing.knownTotals.input, 10);
  assert.equal(missing.cost.pricingEstimateUsd, null); assert.ok(missing.completeness.issues.includes('missing_helper_record'));
  const present = summarizeSession([assistant('a', null), state, helper('h', 'state', 'task-1:contract:1')], {pricing: rates});
  assert.equal(present.completeness.usage, true); assert.equal(present.totals.input, 17);
  const blocked = structuredClone(state); blocked.data.extraction = {attempted: true, status: 'blocked', usage: null};
  assert.equal(summarizeSession([assistant('a', null), blocked]).completeness.usage, true);
});

test('native bash execution, injected custom and summary message content contribute safe byte proxies', async () => {
  const {summarizeSession} = await load(); assert.equal(typeof summarizeSession, 'function');
  const value = summarizeSession([
    {type: 'message', id: 'bash', parentId: null, message: {role: 'bashExecution', command: 'echo secret', output: 'secret output'}},
    {type: 'message', id: 'custom', parentId: 'bash', message: {role: 'custom', content: 'private custom'}},
    {type: 'message', id: 'summary', parentId: 'custom', message: {role: 'compactionSummary', summary: 'private summary'}}]);
  assert.equal(value.categories.toolCalls.bytes, 11); assert.equal(value.categories.toolResults.bytes, 13);
  assert.equal(value.categories.custom.bytes, 14); assert.equal(value.categories.summaries.bytes, 15);
  assert.doesNotMatch(JSON.stringify(value), /secret|private/);
});

test('footer includes usage, cache-hit/context percentages, routed model and explicit active task cost', async () => {
  const {summarizeSession, formatCost} = await load(); assert.equal(typeof summarizeSession, 'function');
  const task = {type: 'custom', id: 'state', parentId: null, customType: 'apex-task-state', data: {taskId: 'active-task'}};
  const value = summarizeSession([task, assistant('a', 'state')], {pricing: rates, context: {tokens: 250, contextWindow: 1000}});
  const status = formatCost(value);
  assert.match(status, /in 10/i); assert.match(status, /cache-read 2/i); assert.match(status, /write 1/i);
  assert.match(status, /out 4/i); assert.match(status, /hit 15\.4%/i); assert.match(status, /ctx 25\.0%/i);
  assert.match(status, /fixture\/model/); assert.match(status, /session.*estimate/i); assert.match(status, /task.*estimate/i);
  assert.match(status, /not invoice/i); assert.equal(value.currentTaskId, 'active-task');
  assert.ok(status.length < 250);
});

test('footer chooses active leaf task rather than a sibling and keeps unknown values explicit', async () => {
  const {summarizeSession, formatCost} = await load(); assert.equal(typeof summarizeSession, 'function');
  const t1 = {type: 'custom', id: 't1', parentId: null, customType: 'apex-task-state', data: {taskId: 'task-1'}};
  const t2 = {type: 'custom', id: 't2', parentId: 't1', customType: 'apex-task-state', data: {taskId: 'task-2'}};
  const value = summarizeSession([t1, assistant('a1', 't1'), t2, assistant('a2', 't2', usage(20, 8)), assistant('a3', 'a1', usage(5, 2))]);
  assert.equal(value.currentTaskId, 'task-1');
  assert.match(formatCost(value), /ctx unknown/i); assert.match(formatCost(value), /session.*unknown/i);
  assert.match(formatCost(value), /task.*unknown/i); assert.doesNotMatch(formatCost(value), /task-2/);
  const noTask = formatCost(summarizeSession([assistant('a', null)]));
  assert.doesNotMatch(noTask, /task /i);
});

test('navigation active leaf selects explicit task without narrowing all-session accounting', async () => {
  const {summarizeSession} = await load(); assert.equal(typeof summarizeSession, 'function');
  const t1 = {type: 'custom', id: 't1', parentId: null, customType: 'apex-task-state', data: {taskId: 'task-1'}};
  const t2 = {type: 'custom', id: 't2', parentId: 't1', customType: 'apex-task-state', data: {taskId: 'task-2'}};
  const entries = [t1, assistant('a1', 't1'), t2, assistant('a2', 't2', usage(20, 8))];
  const current = summarizeSession(entries, {activeLeaf: 'a1', pricing: rates});
  assert.equal(current.currentTaskId, 'task-1'); assert.equal(current.scope, 'session');
  assert.equal(current.totals.input, 30); assert.equal(current.counts.usageRecords, 2);
  assert.equal(summarizeSession(entries).currentTaskId, 'task-2');
  assert.equal(summarizeSession(entries, {activeLeaf: null}).currentTaskId, null);
  assert.throws(() => summarizeSession(entries, {activeLeaf: 'missing'}), /active.*leaf/i);
});
