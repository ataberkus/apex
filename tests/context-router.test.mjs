import assert from 'node:assert/strict';
import test from 'node:test';

const identity = 'openrouter/meta/muse-spark-1.3-contributor';
const physical = {provider: 'openrouter', id: 'meta/muse-spark-1.3-contributor',
  api: 'openai-completions', thinkingLevelMap: {xhigh: 'xhigh'}};
const load = () => import('../extensions/apex-router/index.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

async function fixture() {
  const {createApexRouter} = await load();
  assert.equal(typeof createApexRouter, 'function', 'Apex router is missing');
  const {SessionManager} = await import('@earendil-works/pi-coding-agent');
  const manager = SessionManager.inMemory(process.cwd());
  const registry = new Proxy({find(provider, id) {
    assert.equal(provider, 'openrouter');
    assert.equal(id, 'meta/muse-spark-1.3-contributor');
    return physical;
  }}, {get(target, property) {
    if (property in target) return target[property];
    throw new Error(`Unexpected model runtime access: ${String(property)}`);
  }});
  return {router: createApexRouter({main: identity, fast: identity}), manager,
    ctx: {sessionManager: manager, modelRegistry: registry}};
}

function request(fields = {}) {
  return {model: {provider: 'apex', id: 'auto', api: 'pi-virtual'}, thinkingLevel: 'xhigh',
    reason: 'user', messages: [], ...fields};
}

function appendAssistant(manager, stopReason = 'stop') {
  return manager.appendMessage({role: 'assistant', provider: physical.provider, api: physical.api,
    model: physical.id, thinkingLevel: 'xhigh', stopReason, timestamp: 0,
    content: [{type: 'text', text: 'Synthetic offline assistant fixture.'}],
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}});
}

test('router rejects unauthorized MAIN, FAST and lower thinking before registration', async () => {
  const {createApexRouter} = await load();
  assert.equal(typeof createApexRouter, 'function', 'Apex router is missing');
  for (const options of [{}, {main: identity}, {main: 'other/model', fast: identity},
    {main: identity, fast: 'openrouter/meta/muse-spark-1.3-contributor-extra'},
    {main: identity, fast: identity, thinkingLevel: 'high'},
    {main: identity, fast: identity, thinkingLevel: 'off'},
    {main: identity, fast: identity, thinkingLevel: null}]) {
    assert.throws(() => createApexRouter(options), /model|thinking|xhigh/i);
  }
});

test('router is registered during native extension loading without model runtime initialization', async () => {
  const module = await load();
  assert.equal(typeof module.default, 'function', 'Apex router factory is missing');
  const {createExtensionRuntime, createEventBus, ExtensionRunner, SessionManager} =
    await import('@earendil-works/pi-coding-agent');
  const {loadExtensionFromFactory} = await import(
    '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js');
  const runtime = createExtensionRuntime();
  const extension = await loadExtensionFromFactory(module.default, process.cwd(), createEventBus(), runtime);
  assert.equal(runtime.pendingVirtualModelRegistrations.length, 1);
  const definition = runtime.pendingVirtualModelRegistrations[0].definition;
  assert.equal(definition.provider, 'apex');
  assert.equal(definition.id, 'auto');
  assert.deepEqual(definition.thinkingLevels, ['xhigh']);
  assert.equal(runtime.pendingProviderRegistrations.length, 0);
  assert.equal(runtime.mcpServers.list().length, 0);
  assert.deepEqual(new ExtensionRunner([extension], runtime, process.cwd(),
    SessionManager.inMemory(), {}).getAllRegisteredTools(), []);
});

test('first ten successful persisted assistants plan, then execute despite compacted request messages', async () => {
  const {router, manager, ctx} = await fixture();
  for (let index = 0; index < 9; index++) appendAssistant(manager);
  appendAssistant(manager, 'error');
  appendAssistant(manager, 'aborted');
  const planning = await router.route(request(), ctx);
  assert.equal(planning.model, physical);
  assert.equal(planning.thinkingLevel, 'xhigh');
  assert.deepEqual(planning.state, {version: 1, phase: 'planning', assistantMessages: 9});
  appendAssistant(manager, 'toolUse');
  const execution = await router.route(request({messages: [], state: planning.state}), ctx);
  assert.deepEqual(execution.state, {version: 1, phase: 'execution', assistantMessages: 10});
  const again = await router.route(request({state: execution.state}), ctx);
  assert.equal(again.state, execution.state, 'unchanged state must not create another Pi custom entry');
});

test('routing signals and assistant counts follow the active native branch rather than stale router state', async () => {
  const {router, manager, ctx} = await fixture();
  const branchPoint = appendAssistant(manager);
  manager.appendCustomEntry('apex-routing', {phase: 'verification'});
  const verification = await router.route(request(), ctx);
  assert.equal(verification.state.phase, 'verification');
  manager.branch(branchPoint);
  manager.appendCustomEntry('apex-routing', {phase: 'execution'});
  const active = await router.route(request({state: verification.state}), ctx);
  assert.deepEqual(active.state, {version: 1, phase: 'execution', assistantMessages: 1});
  manager.branch(branchPoint);
  const resumed = await router.route(request({state: active.state}), ctx);
  assert.deepEqual(resumed.state, {version: 1, phase: 'planning', assistantMessages: 1});
});

test('continuations and retries preserve the allowed physical identity and xhigh', async () => {
  const {router, ctx} = await fixture();
  const previous = {model: {...physical}, thinkingLevel: 'xhigh'};
  const failed = {...previous, message: {stopReason: 'error', errorMessage: 'Synthetic provider failure.'}};
  for (const fields of [{reason: 'continuation', previous}, {reason: 'retry', failed},
    {reason: 'retry', previous}, {reason: 'continuation', previous: {model: physical}}]) {
    const result = await router.route(request(fields), ctx);
    assert.equal(result.model, physical);
    assert.equal(result.thinkingLevel, 'xhigh');
  }
  const badPrevious = {model: {...physical, provider: 'other'}, thinkingLevel: 'xhigh'};
  assert.throws(() => router.route(request({reason: 'continuation', previous: badPrevious}), ctx), /model/i);
  assert.throws(() => router.route(request({reason: 'retry', failed: {...failed, thinkingLevel: 'low'}}), ctx), /thinking|xhigh/i);
  assert.throws(() => router.route(request({thinkingLevel: 'off'}), ctx), /thinking|xhigh/i);
});

test('direct summaries keep fixed Muse/xhigh and never return branch state', async () => {
  const {router, manager, ctx} = await fixture();
  manager.appendCustomEntry('apex-routing', {phase: 'verification'});
  const direct = await router.route(request({reason: 'direct', state: {phase: 'execution'}}), ctx);
  assert.equal(direct.model, physical);
  assert.equal(direct.thinkingLevel, 'xhigh');
  assert.equal(Object.hasOwn(direct, 'state'), false);
});

test('missing, virtual or misidentified physical catalog targets fail closed', async () => {
  const {router, ctx} = await fixture();
  for (const model of [undefined, {...physical, api: 'pi-virtual'}, {...physical, id: 'different'},
    {...physical, thinkingLevelMap: {xhigh: null}}]) {
    const invalid = {...ctx, modelRegistry: {find: () => model}};
    assert.throws(() => router.route(request(), invalid), /model|xhigh/i);
  }
});
