import assert from 'node:assert/strict';
import test from 'node:test';

const load = () => import('../extensions/apex-context/lazy.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

async function fixture() {
  const {registerLazyTools} = await load();
  assert.equal(typeof registerLazyTools, 'function', 'Apex lazy registration is missing');
  const {createExtensionRuntime, createEventBus, ExtensionRunner, SessionManager} =
    await import('@earendil-works/pi-coding-agent');
  const {loadExtensionFromFactory} = await import(
    '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js');
  const runtime = createExtensionRuntime();
  let names;
  const extension = await loadExtensionFromFactory(pi => { names = registerLazyTools(pi); },
    process.cwd(), createEventBus(), runtime);
  const manager = SessionManager.inMemory();
  const runner = new ExtensionRunner([extension], runtime, process.cwd(), manager, {});
  const active = [];
  runtime.getActiveTools = () => active.slice();
  runtime.setActiveTools = requested => { active.splice(0, active.length, ...requested); };
  runtime.getSettings = () => ({codemode: {inlineBudget: 3000, mode: 'on'}});
  runtime.getAllTools = () => [...runner.getAllRegisteredTools().map(tool => tool.definition), ...rare];
  const rare = [{name: 'rare_outline', description: 'Extract source symbols with line numbers.',
    exposure: 'deferred', namespace: {name: 'local', description: 'Local test fixture tools.'},
    parameters: {type: 'object', properties: {}}, execute: async () => ({content: []})},
  {name: 'inline_compare', description: 'Compare small local values.', exposure: 'codemode',
    parameters: {type: 'object', properties: {}}, execute: async () => ({content: []})}];
  return {names, runtime, runner, rare, active};
}

test('native lazy registration stays inactive and adds no MCP or model router', async () => {
  const {names, runtime, runner, active} = await fixture();
  assert.deepEqual(names, ['codemode', 'tool_search']);
  assert.equal(Object.isFrozen(names), true);
  assert.deepEqual(active, []);
  assert.deepEqual(runner.getAllRegisteredTools().map(tool => tool.definition.name).sort(), ['codemode', 'tool_search']);
  for (const name of names) {
    assert.equal(runner.getToolDefinition(name).defaultActive, false);
    assert.equal(runner.getToolDefinition(name).exposure, 'model-only');
  }
  assert.equal(runtime.pendingProviderRegistrations.length, 0);
  assert.equal(runtime.pendingVirtualModelRegistrations.length, 0);
  assert.equal(runtime.mcpServers.list().length, 0);
});

test('native codemode loadout omits deferred declarations and classifier access', async () => {
  const {runner, rare} = await fixture();
  const codemode = runner.getToolDefinition('codemode');
  const loadout = {declared: [codemode], callable: rare, registered: [codemode, ...rare],
    getExposure: name => name === 'codemode' ? 'model-only' : rare.find(tool => tool.name === name).exposure,
    getNamespace: name => rare.find(tool => tool.name === name)?.namespace};
  const before = codemode.prepareLoadout(loadout).descriptions.codemode;
  assert.match(before, /inline_compare/);
  assert.doesNotMatch(before, /Extract source symbols|rare_outline\(/);
  assert.doesNotMatch(before, /models\.classify|models\.getAvailableOfType/);
  const after = codemode.prepareLoadout({...loadout, declared: [codemode, rare[0]]}).descriptions.codemode;
  assert.equal(after, before, 'direct discovery must not redeclare codemode');
});

test('native tool_search loads matching deferred tools only for the next declaration set', async () => {
  const {runner, rare, active} = await fixture();
  active.push('codemode', 'tool_search');
  const search = runner.getToolDefinition('tool_search');
  const result = await search.execute('offline-search', {query: 'source symbols outline line numbers', limit: 1});
  assert.deepEqual(result.details.loaded, ['rare_outline']);
  assert.deepEqual(active, ['codemode', 'tool_search', 'rare_outline']);
  assert.match(result.content[0].text, /next call/);
  const noRepeat = await search.execute('offline-search-again', {query: 'source symbols outline line numbers', limit: 1});
  assert.deepEqual(noRepeat.details.loaded, []);
  assert.equal(rare[0].exposure, 'deferred');
});
