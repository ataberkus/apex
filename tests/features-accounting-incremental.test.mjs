import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createSessionSummarizer, summarizeSession} from '../extensions/apex-features/accounting.mjs';
// Byte-for-byte copy of accounting.mjs at d0c6d2b, before summarizeSession was split for incremental use.
import {summarizeSession as originalSummarizeSession} from './fixtures/accounting-d0c6d2b.mjs';
import {generate, pricingVariants, random, schedule} from './fixtures/accounting-sessions.mjs';

const ORIGINAL_SHA256 = '45687941b241e9438f46aebf7047a71a1d0e3d3f9c377a6c41de86ba6e766bfc';
const outcome = run => {try {return JSON.stringify(run());} catch (error) {return `${error?.name}: ${error?.message}`;}};

test('the frozen reference is the accounting module this refactor started from', () => {
  // A Windows checkout may convert line endings; the hash is of the committed LF text.
  const source = readFileSync(new URL('./fixtures/accounting-d0c6d2b.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(source).digest('hex'), ORIGINAL_SHA256);
});

// About 4 s alone; an explicit timeout keeps a plain `bun test` (5 s default) from failing on a loaded machine.
test('incremental, refactored and original session summaries agree on every prefix, errors included', {timeout: 60000}, () => {
  const rnd = random(20261102); const variants = pricingVariants();
  const refused = new Set(); let compared = 0; let priced = 0; let partial = 0;
  for (let session = 0; session < 120; session++) {
    const r = rnd(); const mode = r < 0.25 ? 'clean' : r < 0.7 ? 'mixed' : 'errors';
    const entries = generate(rnd, 20 + Math.floor(rnd() * 90), mode); const summarizer = createSessionSummarizer();
    for (const {prefix, opts, label} of schedule(rnd, entries, variants)) {
      const incremental = outcome(() => summarizer.summarize(prefix, opts));
      const full = outcome(() => summarizeSession(prefix, opts));
      const original = outcome(() => originalSummarizeSession(prefix, opts));
      assert.equal(full, original, `refactor differs from d0c6d2b: ${mode} session ${session}, ${label}`);
      assert.equal(incremental, full, `incremental differs: ${mode} session ${session}, ${label}`);
      compared++;
      if (!full.startsWith('{')) refused.add(full);
      else if (JSON.parse(full).cost.pricingEstimateUsd !== null) priced++;
      else if (JSON.parse(full).completeness.usage === false) partial++;
    }
  }
  // The generated calls must reach priced, partial and every refused outcome.
  assert.ok(compared > 8000 && priced > 500 && partial > 2000, JSON.stringify({compared, priced, partial}));
  assert.deepEqual([...refused].sort(), ['Unknown active session leaf.', 'Unknown branch entry.', 'Unknown branch leaf.', 'Missing session parent.',
    'Session parent cycle.', 'Invalid session entry.', 'Invalid session entry identity.', 'Conflicting session entry identity.', 'Conflicting request usage identity.',
    'Session data exceeds nesting depth limit.', 'Session token totals exceed numeric limit.', 'Session cost totals exceed numeric limit.'].map(message => `Error: ${message}`).sort());
});

test('summarizer reads only entries appended since its previous call', () => {
  let reads = 0; const watched = entry => new Proxy(entry, {get(target, key) {reads++; return Reflect.get(target, key);}});
  const usage = {input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17};
  const assistant = (id, parentId) => ({type: 'message', id, parentId, message: {role: 'assistant', provider: 'fixture', model: 'model', usage, stopReason: 'stop', responseId: id, content: [{type: 'text', text: id}]}});
  const entries = [watched({type: 'custom', id: 's', parentId: null, customType: 'apex-task-state', data: {taskId: 'task-1'}})];
  for (let index = 0; index < 2000; index++) entries.push(watched(assistant(`a${index}`, entries.at(-1).id)));
  const opts = {pricing: {input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5}, model: {provider: 'fixture', id: 'model'}};
  const summarizer = createSessionSummarizer(); summarizer.summarize(entries, {...opts, activeLeaf: 'a1999'});
  const appended = [...entries, assistant('next', 'a1999')]; reads = 0;
  const value = summarizer.summarize(appended, {...opts, activeLeaf: 'next'});
  assert.ok(reads < 10, `${reads} reads of earlier entries`);
  assert.deepEqual(value, summarizeSession(appended, {...opts, activeLeaf: 'next'}));
  assert.equal(value.counts.usageRecords, 2001); assert.equal(value.currentTaskId, 'task-1');
});

test('summaries are copies, so changing one leaves the next unchanged', () => {
  const usage = {input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17};
  const entries = [{type: 'custom', id: 's', parentId: null, customType: 'apex-task-state', data: {taskId: 'task-1', extraction: {attempted: true, usage: {}}}},
    {type: 'message', id: 'a', parentId: 's', message: {role: 'assistant', provider: 'fixture', model: 'model', usage, stopReason: 'stop', content: 'answer'}}];
  const summarizer = createSessionSummarizer(); const value = summarizer.summarize(entries);
  // With no selected model, the model is the session's last one.
  assert.deepEqual(value.model, {provider: 'fixture', id: 'model'}); assert.equal(value.counts.missingHelperRecords, 1);
  value.model.id = 'changed'; value.topConsumers[0].bytes = -1; value.tasks[0].totals.input = -1; value.tasks[0].completeness.issues.push('changed');
  value.categories.assistant.bytes = -1; value.completeness.issues.push('changed'); value.knownTotals.input = -1;
  assert.deepEqual(summarizer.summarize([...entries]), summarizeSession(entries));
});

test('pricing a fingerprint cannot tell apart is repriced on every call', () => {
  // fingerprint() writes NaN as null and skips inherited rates; findRates reads both.
  const variants = [{input: 3, output: 15, cacheRead: NaN, cache_read: 0.3, cacheWrite: 3.75}, {input: 3, output: 15, cacheRead: null, cache_read: 0.3, cacheWrite: 3.75},
    Object.create({input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75}), Object.create({input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5})];
  const model = {provider: 'fixture', id: 'model'}; const entries = []; const summarizer = createSessionSummarizer();
  for (let index = 0; index < 12; index++) {
    entries.push({type: 'message', id: `a${index}`, parentId: index ? `a${index - 1}` : null,
      message: {role: 'assistant', provider: 'fixture', model: 'model', usage: {input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17}, stopReason: 'stop'}});
    const opts = {model, pricing: variants[index % variants.length]};
    assert.deepEqual(summarizer.summarize([...entries], opts), summarizeSession(entries, opts));
  }
});

test('pricing that reuses one child many times takes the full path instead of an exponential walk', () => {
  // 21 levels, each holding the next level twice: 2^21 paths through 22 objects (seconds without the cap).
  let pricing = {input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75};
  for (let level = 0; level < 21; level++) pricing = {input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, left: pricing, right: pricing};
  const model = {provider: 'fixture', id: 'model'}; const summarizer = createSessionSummarizer();
  const entries = [{type: 'message', id: 'a0', parentId: null,
    message: {role: 'assistant', provider: 'fixture', model: 'model', usage: {input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17}, stopReason: 'stop'}}];
  const started = performance.now();
  assert.deepEqual(summarizer.summarize(entries, {model, pricing}), summarizeSession(entries, {model, pricing}));
  assert.ok(performance.now() - started < 2000, `${Math.round(performance.now() - started)} ms`);
});

test('another history as long as or longer than the last one is summarized from scratch', () => {
  const session = (prefix, n) => Array.from({length: n}, (_, index) => ({type: 'message', id: `${prefix}${index}`, parentId: index ? `${prefix}${index - 1}` : null,
    message: {role: 'assistant', provider: 'fixture', model: 'model', usage: {input: index + 1, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: index + 8}, stopReason: 'stop', content: prefix.repeat(index)}}));
  const summarizer = createSessionSummarizer(); const first = session('a', 5);
  summarizer.summarize(first);
  for (const other of [session('b', 5), session('c', 8)]) assert.deepEqual(summarizer.summarize(other), summarizeSession(other));
});

test('a refused summary is refused again until the history changes, then the summarizer recovers', () => {
  const summarizer = createSessionSummarizer();
  const a = {type: 'message', id: 'a', parentId: null, message: {role: 'user', content: 'hello'}};
  assert.throws(() => summarizer.summarize([a, {type: 'message', id: 'a', parentId: null, message: {role: 'user', content: 'other'}}]), /Conflicting session entry identity/);
  assert.throws(() => summarizer.summarize([a, null]), /Invalid session entry/);
  assert.throws(() => summarizer.summarize([a], {activeLeaf: 'missing'}), /Unknown active session leaf/);
  assert.throws(() => summarizer.summarize(new Array(100001).fill(a)), /supported limit/);
  assert.throws(() => summarizer.summarize('entries'), /supported limit/);
  assert.deepEqual(summarizer.summarize([a]), summarizeSession([a]));
  assert.deepEqual(summarizer.summarize([a], {branch: 'a'}), summarizeSession([a], {branch: 'a'}));
});
