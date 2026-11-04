import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js';

import { createCompactionHandler } from '../extensions/apex-context/compaction.mjs';
const allowedModel = 'openrouter/meta/muse-spark-1.3-contributor';
const offline = { allowed_model: allowedModel, thinking_level: 'xhigh', paid_runs_enabled: false, execution_policy: 'offline-only' };
// This enables only a dependency-injected fixture; it never authorizes a real request.
const fixturePolicy = { ...offline, paid_runs_enabled: true, execution_policy: 'paid-enabled' };
const model = { provider: 'openrouter', id: 'meta/muse-spark-1.3-contributor', api: 'openai-completions', reasoning: true, maxTokens: 8192, thinkingLevelMap: { xhigh: 'xhigh' } };
const usage = { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const response = { role: 'assistant', content: [{ type: 'text', text: '## Current state\nNative fixture completed.' }], api: 'openai-completions', provider: 'openrouter', model: model.id, usage, stopReason: 'stop', timestamp: 0 };

function fixture() {
  const manager = SessionManager.inMemory(process.cwd());
  manager.appendMessage({ role: 'user', content: 'Build the exact fixture', timestamp: 0 });
  const kept = manager.appendMessage({ role: 'user', content: 'Recent context retained', timestamp: 0 });
  return { manager, event: { type: 'session_before_compact', reason: 'manual', willRetry: false, signal: new AbortController().signal,
    branchEntries: manager.getBranch(), preparation: { firstKeptEntryId: kept, messagesToSummarize: [{ role: 'user', content: 'Build the exact fixture', timestamp: 0 }],
      turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 1000, fileOps: { read: new Set(['src/read.js']), written: new Set(['src/write.js']), edited: new Set(['src/edit.js']) },
      settings: { enabled: true, reserveTokens: 4096, keepRecentTokens: 100 } } } };
}
function context(manager, registryOverrides = {}) {
  return { cwd: process.cwd(), sessionManager: manager, modelRegistry: { find(provider, id) { assert.equal(`${provider}/${id}`, allowedModel); return model; },
    getApiKeyAndHeaders() { throw new Error('No explicit auth lookup is allowed'); }, complete() { throw new Error('Real complete is forbidden in fixture'); }, ...registryOverrides } };
}

test('Phase 2 loop and time counters survive coding compaction verbatim',async()=>{
  const {manager,event}=fixture();
  const controls={version:1,loopNotes:2,timeThresholds:[0.5,0.75],budgetSeconds:100,timeElapsedSeconds:80,timeStartedAtWall:123};
  manager.appendCustomEntry('apex-core-control',controls);event.branchEntries=manager.getBranch();
  const result=await createCompactionHandler({policy:fixturePolicy,complete:async()=>response})(event,context(manager));
  assert.deepEqual(result.compaction.details.apexState['apex-core-control'],controls);
  assert.ok(result.compaction.summary.includes('apex-core-control'));
});

test('offline compaction cancels before touching registry/auth or injected completion', async () => {
  const { manager, event } = fixture();
  let registryAccesses = 0;
  let completions = 0;
  const ctx = { sessionManager: manager, get modelRegistry() { registryAccesses += 1; throw new Error('Registry access before offline guard'); } };
  const handler = createCompactionHandler({ policy: offline, complete() { completions += 1; throw new Error('Offline injected completion attempted'); } });
  assert.deepEqual(await handler(event, ctx), { cancel: true });
  assert.deepEqual(await createCompactionHandler({ policy: { ...fixturePolicy, execution_policy: 'offline-only' } })(event, ctx), { cancel: true });
  assert.equal(registryAccesses, 0);
  assert.equal(completions, 0);
});

test('invalid policy model/thinking/enable flag cancels without registry access', async () => {
  const { event } = fixture();
  let registryAccesses = 0;
  const ctx = { get modelRegistry() { registryAccesses += 1; throw new Error('invalid policy must not resolve models'); } };
  for (const policy of [undefined, { ...fixturePolicy, allowed_model: 'openrouter/another-model' }, { ...fixturePolicy, thinking_level: 'low' }, { ...fixturePolicy, paid_runs_enabled: false }]) {
    assert.deepEqual(await createCompactionHandler({ policy, complete: async () => response })(event, ctx), { cancel: true });
  }
  assert.equal(registryAccesses, 0);
});

test('compaction retains exact native cutoff, state JSON and reported summary usage', async () => {
  const { manager, event } = fixture();
  manager.appendCustomEntry('apex-contract', { z: ['exact/path', 'line\nvalue'], a: { punctuation: '$(literal) `literal`', bool: false } });
  manager.appendCustomEntry('apex-todo', [{ done: false, id: 3, text: 'Do exactly this' }]);
  event.branchEntries = manager.getBranch();
  const result = await createCompactionHandler({ policy: fixturePolicy, complete: async () => response })(event, context(manager));
  assert.equal(result?.compaction?.firstKeptEntryId, event.preparation.firstKeptEntryId);
  assert.equal(result?.compaction?.tokensBefore, 1000);
  assert.deepEqual(result?.compaction?.usage, usage);
  assert.match(result?.compaction?.summary ?? '', /Native fixture completed/);
  assert.ok(result?.compaction?.summary.includes('{"a":{"bool":false,"punctuation":"$(literal) `literal`"},"z":["exact/path","line\\nvalue"]}'));
  assert.ok(result?.compaction?.summary.includes('[{"done":false,"id":3,"text":"Do exactly this"}]'));
  assert.deepEqual(result?.compaction?.details.apexState['apex-todo'], [{ done: false, id: 3, text: 'Do exactly this' }]);
  const compact = result.compaction;
  manager.appendCompaction(compact.summary, compact.firstKeptEntryId, compact.tokensBefore, compact.details, true, compact.usage);
  const rebuilt = SessionManager.inMemory(process.cwd(), undefined, [manager.getHeader(), ...manager.getBranch()]);
  assert.match(rebuilt.buildSessionContext().messages.find(message => message.role === 'compactionSummary').summary, /Do exactly this/);
  assert.ok(rebuilt.buildSessionContext().messages.some(message => message.role === 'user' && message.content === 'Recent context retained'));
});

test('compaction passes exact physical model, API reasoning option and split prefix to injected completion', async () => {
  const { manager, event } = fixture();
  event.preparation.previousSummary = 'Prior established facts';
  event.preparation.isSplitTurn = true;
  event.preparation.turnPrefixMessages = [{ role: 'user', content: 'Prefix acceptance condition', timestamp: 0 }];
  const handler = createCompactionHandler({ policy: fixturePolicy, complete: async (selected, request, options) => {
    assert.equal(selected, model);
    assert.equal(options.reasoningEffort, 'xhigh');
    assert.equal(options.maxTokens, 4096);
    assert.equal(options.signal, event.signal);
    assert.equal(options.cacheRetention, 'none');
    assert.match(request.systemPrompt, /Summarize this coding session/);
    assert.match(request.messages[0].content[0].text, /Prior established facts/);
    assert.match(request.messages[0].content[0].text, /Prefix acceptance condition/);
    assert.deepEqual(request.tools, []);
    return response;
  } });
  assert.ok((await handler(event, context(manager)))?.compaction);
});

test('compaction unions previous hook file lists and removes modified paths from read-only lists', async () => {
  const { manager, event } = fixture();
  manager.appendCompaction('previous hook summary', event.preparation.firstKeptEntryId, 100,
    { readFiles: ['old/read.js', 'src/edit.js'], modifiedFiles: ['old/write.js'], apexState: { 'apex-contract': { paths: ['preserved'] } } }, true);
  manager.appendMessage({ role: 'user', content: 'new work', timestamp: 0 });
  event.branchEntries = manager.getBranch();
  const result = await createCompactionHandler({ policy: fixturePolicy, complete: async () => response })(event, context(manager));
  assert.deepEqual(result?.compaction?.details.readFiles, ['old/read.js', 'src/read.js']);
  assert.deepEqual(result?.compaction?.details.modifiedFiles, ['old/write.js', 'src/edit.js', 'src/write.js']);
  assert.match(result?.compaction?.summary ?? '', /<modified-files>\nold\/write\.js\nsrc\/edit\.js\nsrc\/write\.js\n<\/modified-files>/);
  assert.deepEqual(result?.compaction?.details.apexState['apex-contract'], { paths: ['preserved'] });
});

test('compaction chooses active branch state rather than abandoned branch state', async () => {
  const { manager, event } = fixture();
  const branchPoint = manager.getLeafId();
  manager.appendCustomEntry('apex-todo', ['wrong branch']);
  manager.branch(branchPoint);
  manager.appendCustomEntry('apex-todo', ['active branch']);
  event.branchEntries = manager.getBranch();
  const result = await createCompactionHandler({ policy: fixturePolicy, complete: async () => response })(event, context(manager));
  assert.deepEqual(result?.compaction?.details.apexState['apex-todo'], ['active branch']);
  assert.doesNotMatch(result?.compaction?.summary ?? '', /wrong branch/);
});

test('compaction cancels on malformed preparation, unsupported model, abort or incomplete output', async () => {
  const { manager, event } = fixture();
  for (const preparation of [undefined, { ...event.preparation, firstKeptEntryId: 'missing' }, { ...event.preparation, tokensBefore: NaN }]) {
    assert.deepEqual(await createCompactionHandler({ policy: fixturePolicy, complete: async () => response })({ ...event, preparation }, context(manager)), { cancel: true });
  }
  assert.deepEqual(await createCompactionHandler({ policy: fixturePolicy, complete: async () => response })(event, context(manager, { find: () => ({ ...model, provider: 'wrong' }) })), { cancel: true });
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await createCompactionHandler({ policy: fixturePolicy, complete: async () => response })({ ...event, signal: controller.signal }, context(manager)), { cancel: true });
  for (const broken of [{ ...response, stopReason: 'length' }, { ...response, stopReason: 'error' }, { ...response, content: [] }, { ...response, content: [{ type: 'toolCall', id: 'bad', name: 'bash', arguments: {} }] }]) {
    assert.deepEqual(await createCompactionHandler({ policy: fixturePolicy, complete: async () => broken })(event, context(manager)), { cancel: true });
  }
  assert.deepEqual(await createCompactionHandler({ policy: fixturePolicy, complete: async () => { throw new Error('fixture summary failure'); } })(event, context(manager)), { cancel: true });
});

test('compaction cancels instead of paraphrasing unsupported branch state', async () => {
  const { manager, event } = fixture();
  const cyclic = {}; cyclic.self = cyclic;
  manager.appendCustomEntry('apex-contract', cyclic);
  event.branchEntries = manager.getBranch();
  assert.deepEqual(await createCompactionHandler({ policy: fixturePolicy, complete: async () => response })(event, context(manager)), { cancel: true });
});

test('compaction cancels when the active branch changes while the summary is pending', async () => {
  const { manager, event } = fixture();
  const handler = createCompactionHandler({ policy: fixturePolicy, complete: async () => {
    manager.appendMessage({ role: 'user', content: 'New branch state must not be lost', timestamp: 0 });
    return response;
  } });
  assert.deepEqual(await handler(event, context(manager)), { cancel: true });
});

test('compaction requires valid response usage and file-operation collections', async () => {
  const { manager, event } = fixture();
  const badFileOps = { ...event.preparation.fileOps, read: 'src/not-a-path-list.js' };
  assert.deepEqual(await createCompactionHandler({ policy: fixturePolicy, complete: async () => response })({ ...event, preparation: { ...event.preparation, fileOps: badFileOps } }, context(manager)), { cancel: true });
  for (const broken of [{ ...response, usage: undefined }, { ...response, usage: { ...usage, output: NaN } }, { ...response, content: [...response.content, { type: 'text', text: undefined }] }]) {
    assert.deepEqual(await createCompactionHandler({ policy: fixturePolicy, complete: async () => broken })(event, context(manager)), { cancel: true });
  }
});

test('revoking a previously enabled fixture policy cancels before registry access', async () => {
  const { manager, event } = fixture();
  const mutablePolicy = { ...fixturePolicy };
  const handler = createCompactionHandler({ policy: mutablePolicy, complete: async () => response });
  mutablePolicy.paid_runs_enabled = false;
  let registryAccesses = 0;
  assert.deepEqual(await handler(event, { sessionManager: manager, get modelRegistry() { registryAccesses += 1; throw new Error('revoked policy attempted model access'); } }), { cancel: true });
  assert.equal(registryAccesses, 0);
});

test('enabled fixture can use the registry completion facade without explicit key lookup', async () => {
  const { manager, event } = fixture();
  const ctx = context(manager, { fixtureMarker: true, complete(selected, request, options) {
    assert.equal(this.fixtureMarker, true);
    assert.equal(selected, model);
    assert.equal(options.reasoningEffort, 'xhigh');
    assert.match(request.systemPrompt, /coding session/);
    return Promise.resolve(response);
  } });
  assert.ok((await createCompactionHandler({ policy: fixturePolicy })(event, ctx))?.compaction);
});

test('Phase 3 plan and checkpoint counters survive coding compaction verbatim',async()=>{
 const {manager,event}=fixture();
 const plan={version:1,active:true,task:'Exact plan',tools:['read','write','bash'],readTools:['read','grep','find','ls'],runId:'literal-fixture'};
 const featureState={version:1,turnCounter:12};
 manager.appendCustomEntry('apex-plan-state',plan);manager.appendCustomEntry('apex-features-state',featureState);event.branchEntries=manager.getBranch();
 const r=await createCompactionHandler({policy:fixturePolicy,complete:async()=>response})(event,context(manager));
 assert.deepEqual(r.compaction.details.apexState['apex-plan-state'],plan);assert.deepEqual(r.compaction.details.apexState['apex-features-state'],featureState);
});
