import {spawn} from 'node:child_process';
import fs, {existsSync} from 'node:fs';
import fsPromises, {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {denyBunNetwork, environmentNamesAllowed, fixtureEnvironment, fixtureShellPath, LIVE_BUILTINS, liveBuiltinsLoaded, PINNED_PI_VERSION, WINDOWS_FIXTURE_ENV} from './micro-session.mjs';

// Importing this gate imports only Node builtins; fixtures and Pi live in a
// bounded child process. Every transcript message here is script-seeded.
const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const modelId = 'meta/muse-spark-1.3-contributor';
const modelName = `openrouter/${modelId}`;
// Bun keeps its transpiler cache under HOME, the fixture on Windows; children disable it so the runtime never fills
// the fixture (BUN_RUNTIME_TRANSPILER_CACHE_PATH=0).
const permittedEnv = ['PATH', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'PI_OFFLINE', 'PI_CODING_AGENT_DIR',
  'BUN_RUNTIME_TRANSPILER_CACHE_PATH', ...(process.platform === 'win32' ? WINDOWS_FIXTURE_ENV : [])];
const counters = () => ({network: 0, auth: 0, inference: 0, credentials: 0});
const textOf = result => (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const allZero = value => Object.values(value).every(count => count === 0);

function denyExternal(calls) {
  const deny = () => { calls.network++; throw new Error('offline_network_denied'); };
  globalThis.fetch = deny;
  if ('WebSocket' in globalThis) globalThis.WebSocket = class {constructor() {deny();}};
  http.request = http.get = https.request = https.get = deny;
  http.Agent.prototype.createConnection = https.Agent.prototype.createConnection = deny;
  net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = deny;
  dns.lookup = dns.resolve = dns.resolve4 = dns.resolve6 = dns.reverse = deny;
  dgram.createSocket = deny;
  denyBunNetwork(deny);
}

function denyAmbientDiscovery(fixture, discovery) {
  const inside = file => path.resolve(file) === fixture || path.resolve(file).startsWith(`${fixture}${path.sep}`);
  const guard = file => {
    if (file instanceof URL) file = fileURLToPath(file);
    if (Buffer.isBuffer(file)) file = file.toString();
    if (typeof file !== 'string' || inside(file)) return;
    const base = path.basename(file);
    if (/(?:^|[\\/])\.(?:agents|pi)(?:[\\/]|$)/.test(file) ||
      ['AGENTS.md', 'SYSTEM.md', 'APPEND_SYSTEM.md', 'auth.json', 'settings.json', 'models.json', 'models-store.json'].includes(base)) {
      discovery.attempts++;
      throw new Error('offline_resource_discovery_denied');
    }
  };
  for (const [owner, names] of [[fs, ['existsSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync',
    'accessSync', 'realpathSync', 'openSync']], [fsPromises, ['readFile', 'readdir', 'stat', 'lstat', 'access', 'realpath', 'open']]]) {
    for (const name of names) {
      const original = owner[name].bind(owner);
      owner[name] = (file, ...args) => {guard(file); return original(file, ...args);};
    }
  }
}

async function offlineRuntime(pi, calls, observed) {
  const deny = kind => () => {calls[kind]++; throw new Error(`offline_${kind}_denied`);};
  const credentials = Object.fromEntries(['read', 'list', 'modify', 'delete'].map(name => [name, deny('credentials')]));
  const runtime = await pi.ModelRuntime.create({credentials, modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false});
  for (const owner of [runtime, runtime.models]) {
    for (const name of ['getAuth', 'checkAuth', 'getApiKey', 'getAvailable', 'getAllAvailable', 'getAvailableOfType',
      'login', 'logout', 'getProviderAuthStatus', 'hasConfiguredAuth', 'isUsingOAuth', 'isUsingSubscription']) {
      if (typeof owner[name] === 'function') owner[name] = deny('auth');
    }
    for (const name of ['stream', 'complete', 'streamSimple', 'completeSimple', 'streamDeferred',
      'fetchDeferred', 'cancelDeferred', 'generateImages', 'classify']) {
      if (typeof owner[name] === 'function') owner[name] = deny('inference');
    }
    for (const name of ['setRuntimeApiKey', 'removeRuntimeApiKey', 'listCredentials']) {
      if (typeof owner[name] === 'function') owner[name] = deny('credentials');
    }
  }
  // Pi 1.3.0 registers virtual catalog entries synchronously, then schedules an
  // availability refresh even with allowNetwork:false. Suppress only that test
  // discovery boundary; never allow credentials or account availability reads.
  runtime.refresh = async options => {
    if (options?.allowNetwork !== false) return deny('auth')();
    observed.suppressed_local_refreshes++;
    return {aborted: false, errors: new Map()};
  };
  runtime.models.refresh = deny('auth');
  const model = runtime.getPhysicalModel('openrouter', modelId);
  if (model?.thinkingLevelMap?.xhigh !== 'xhigh') throw new Error('physical_model_contract_missing');
  return {runtime, model, denyInference: deny('inference')};
}

function fixtureLoader(pi, spec, settings, factories) {
  settings.setProjectTrusted(false);
  const loader = new pi.DefaultResourceLoader({cwd: spec.fixture, agentDir: path.join(spec.fixture, 'agent'),
    additionalSkillPaths: spec.fixtureMode === 'ambient-discovery' ?
      [path.join(path.dirname(spec.fixture), '.agents', 'skills')] : [],
    settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true, systemPrompt: 'Deterministic offline Phase 1 contract fixture.',
    appendSystemPrompt: [], extensionFactories: factories});
  // Same pinned package-resolution boundary as micro-session: no* flags run
  // after package resolution, so flags alone do not isolate ambient discovery.
  if (spec.fixtureMode !== 'ambient-discovery') {
    if (typeof loader.packageManager?.resolve !== 'function' ||
      typeof loader.packageManager?.resolveExtensionSources !== 'function') throw new Error('resource_discovery_contract_missing');
    const empty = async () => ({extensions: [], skills: [], prompts: [], themes: []});
    loader.packageManager.resolve = empty;
    loader.packageManager.resolveExtensionSources = empty;
  }
  return loader;
}

async function nativeFixture(spec, calls, observed) {
  observed.stage = 'sdk';
  const pi = await import('@earendil-works/pi-coding-agent');
  const version = JSON.parse(await readFile(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8')).version;
  if (version !== PINNED_PI_VERSION) throw new Error('unexpected_pi_version');
  const {default: contextIndex} = await import('../extensions/apex-context/index.mjs');
  const {default: routerIndex} = await import('../extensions/apex-router/index.mjs');
  const {runtime, model, denyInference} = await offlineRuntime(pi, calls, observed);
  const manager = pi.SessionManager.create(spec.fixture, path.join(spec.fixture, 'sessions'));
  manager.appendModelChange(model.provider, model.id);
  manager.appendThinkingLevelChange('xhigh');
  const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
  let clock = 0;
  const assistant = (content, stopReason = 'stop') => ({role: 'assistant', content, api: model.api,
    provider: model.provider, model: model.id, usage, stopReason, timestamp: ++clock});
  manager.appendMessage({role: 'user', content: 'Synthetic contract: preserve exact Muse/xhigh and perform only local fixture work.', timestamp: ++clock});
  const settings = pi.SettingsManager.inMemory({compaction: {enabled: false, keepRecentTokens: 96, reserveTokens: 256},
    shellPath: fixtureShellPath(), cacheWarming: 'off', retry: {enabled: false, maxRetries: 0}, packages: [], extensions: [],
    codemode: {mode: 'on', inlineBudget: 3000}});
  const observedFactory = api => {
    const nativeGetFlag = api.getFlag.bind(api);
    let selected;
    const flagApi = new Proxy(api, {get(target, name) {
      if (name === 'registerFlag') return (flag, options) => {
        const result = target.registerFlag(flag, options);
        if (flag === 'apex-context-flags') {
          observed.flag_registered = nativeGetFlag(flag) === '';
          selected = spec.fixtureMode === 'missing-compact' ? 'cache,shape,mask,read,search,edit,patch,lazy,route,output' : 'all';
        }
        return result;
      };
      // Select the fixture flags only after actual native flag registration.
      if (name === 'getFlag') return flag => flag === 'apex-context-flags' && selected !== undefined ? selected : nativeGetFlag(flag);
      if (name === 'on') return (event, handler) => target.on(event, (value, ctx) => {
        if (event === 'session_before_compact') observed.compact_hook++;
        if (event === 'tool_result' && spec.fixtureMode === 'shape-programmatic-results' && value.parentToolCallId !== undefined) {
          // Explicit fault injection: emulate a shaper that loses the nested
          // caller distinction. The native tool and codemode executor stay real.
          const legacy = {...value};
          delete legacy.parentToolCallId;
          return handler(legacy, ctx);
        }
        return handler(value, ctx);
      });
      return Reflect.get(target, name);
    }});
    contextIndex(flagApi);
    api.on('session_start', () => {observed.session_start++;});
  };
  const routerFactory = api => routerIndex(new Proxy(api, {get(target, name) {
    if (name === 'registerVirtualModel') return definition => {
      observed.router_definition = definition;
      return target.registerVirtualModel(definition);
    };
    return Reflect.get(target, name);
  }}));
  const loader = fixtureLoader(pi, spec, settings, [observedFactory, routerFactory]);
  observed.stage = 'resources';
  await loader.reload();
  if (loader.getExtensions().errors.length) throw new Error('fixture_extension_failed_to_load');
  observed.stage = 'session';
  const {session} = await pi.createAgentSession({cwd: spec.fixture, agentDir: path.join(spec.fixture, 'agent'),
    modelRuntime: runtime, model, thinkingLevel: 'xhigh', settingsManager: settings,
    sessionManager: manager, resourceLoader: loader});
  session.agent.streamFunction = denyInference;
  const extensionErrors = [];
  try {
    await session.bindExtensions({onError: event => {extensionErrors.push(event.event);}});
    const runner = session.extensionRunner;
    const ctx = runner.createContext();
    const requiredTools = ['read', 'edit', 'grep', 'find', 'ls', 'apply_patch', 'tool_search', 'codemode'];
    const registered = session.getAllTools();
    const checks = {
      native_session_start: observed.session_start === 1 && extensionErrors.length === 0,
      registered_flag: observed.flag_registered,
      effective_model: session.model.provider === 'openrouter' && session.model.id === modelId && session.thinkingLevel === 'xhigh',
      offline_settings: settings.getCacheWarmingMode() === 'off' && settings.getRetrySettings().enabled === false &&
        settings.getRetrySettings().maxRetries === 0 && settings.getCompactionSettings(model).enabled === false,
      actual_tool_definitions: requiredTools.every(name => session.getToolDefinition(name)) &&
        session.getToolDefinition('read').parameters.properties.mode.enum.includes('outline') &&
        Object.hasOwn(session.getToolDefinition('edit').parameters.properties.edits.items.properties, 'old_string'),
    };
    observed.stage = 'tools';
    await writeFile(path.join(spec.fixture, 'fixture.mjs'), 'export function needle() { return "before"; }\n');
    const noisy = Array.from({length: 700}, (_, index) => `fixture line ${index}: ${'local observation '.repeat(2)}`).join('\n') + '\n';
    await writeFile(path.join(spec.fixture, 'noise.log'), noisy);
    const operations = [
      ['read', {path: 'fixture.mjs'}],
      ['read', {path: 'fixture.mjs', mode: 'outline'}],
      ['grep', {pattern: 'needle', path: 'fixture.mjs'}],
      ['find', {pattern: '*.mjs', path: '.'}],
      ['ls', {path: '.'}],
      ['edit', {path: 'fixture.mjs', edits: [{old_string: '"before"', new_string: '"edited"'}]}],
      ['apply_patch', {patch: '--- a/fixture.mjs\n+++ b/fixture.mjs\n@@ -1 +1 @@\n-export function needle() { return "edited"; }\n+export function needle() { return "patched"; }\n'}],
      ['bash', {command: 'cat noise.log'}],
    ];
    const results = new Map();
    for (const [index, [name, args]] of operations.entries()) {
      observed.stage = `tool_${name}_${index}`;
      const parentId = `native-fixture-${index}`;
      manager.appendMessage(assistant([{type: 'toolCall', id: parentId, name, arguments: args}], 'toolUse'));
      session.agent.state.messages = manager.buildSessionContext().messages;
      const toolCtx = runner.createToolContext(parentId, undefined);
      // There is no public top-level session.executeTool. Execute its actual
      // registered definition with the native runner context and then the real
      // top-level result hook. ctx.executeTool is reserved for the nested
      // programmatic test below; nesting intentionally has different shaping.
      const definition = session.getToolDefinition(name);
      const prepared = definition.prepareArguments ? definition.prepareArguments(args) : args;
      const raw = await definition.execute(parentId, prepared, undefined, undefined, toolCtx);
      const hook = await runner.emitToolResult({type: 'tool_result', toolName: name, toolCallId: parentId,
        input: prepared, ...raw, isError: raw.isError ?? false});
      const result = hook ? {...raw, ...hook} : raw;
      if (result.isError) throw new Error('fixture_tool_failed');
      results.set(name, result);
      manager.appendMessage({role: 'toolResult', toolCallId: parentId, toolName: name,
        content: result.content, details: result.details,
        ...(result.structuredContent === undefined ? {} : {structuredContent: result.structuredContent}),
        isError: false, timestamp: ++clock});
    }
    checks.native_tools_executed = (await readFile(path.join(spec.fixture, 'fixture.mjs'), 'utf8')).includes('"patched"') &&
      textOf(results.get('grep')).includes('needle') && textOf(results.get('find')).includes('fixture.mjs') &&
      textOf(results.get('read')).includes('needle');
    const shaped = results.get('bash');
    const shape = shaped.details?.apexShape;
    checks.native_result_hook = shape?.logScope === 'hook-visible-result' &&
      shape.originalBytes === Buffer.byteLength(await readFile(shape.logPath, 'utf8')) &&
      shape.returnedBytes === Buffer.byteLength(textOf(shaped)) && shaped.structuredContent.output === textOf(shaped);
    const activeBeforeSearch = session.getActiveToolNames();
    const callable = runner.createToolContext('loadout-inspection', undefined).tools.map(tool => tool.name);
    const codemode = session.getToolDefinition('codemode');
    const declaredCodemode = session.agent.state.tools.find(tool => tool.name === 'codemode');
    const search = await session.getToolDefinition('tool_search').execute('lazy-local-search',
      {query: 'unified patch exact context existing file', limit: 1}, undefined, undefined,
      runner.createToolContext('lazy-local-search', undefined));
    checks.native_lazy_loadout = registered.find(tool => tool.name === 'apply_patch')?.exposure === 'deferred' &&
      !activeBeforeSearch.includes('apply_patch') && callable.includes('apply_patch') &&
      search.details.loaded.includes('apply_patch') && session.getActiveToolNames().includes('apply_patch') &&
      activeBeforeSearch.includes('codemode') && activeBeforeSearch.includes('tool_search');
    observed.stage = 'codemode';
    const codeResult = await codemode.execute('models-disabled-proof', {code: 'return typeof models;'},
      undefined, undefined, runner.createToolContext('models-disabled-proof', undefined));
    const codeHook = await runner.emitToolResult({type: 'tool_result', toolName: 'codemode',
      toolCallId: 'models-disabled-proof', input: {code: 'return typeof models;'}, ...codeResult, isError: false});
    checks.codemode_models_disabled = !/models\.(?:classify|getAvailableOfType|getModelsOfType)/.test(declaredCodemode.description) &&
      !Object.hasOwn(codemode.parameters.properties, 'models') &&
      /(?:^|\n)undefined(?:\n|$)/.test(textOf(codeHook ?? codeResult)) && !codeResult.isError;
    const programmatic = JSON.stringify(Array.from({length: 4096}, () => 'xx'));
    await writeFile(path.join(spec.fixture, 'programmatic.json'), programmatic);
    const jsonCode = 'const r = await tools.bash({command: "cat programmatic.json"}); return "native-json-count=" + JSON.parse(r.output).length;';
    manager.appendMessage(assistant([{type: 'toolCall', id: 'native-json-regression', name: 'codemode',
      arguments: {code: jsonCode}}], 'toolUse'));
    session.agent.state.messages = manager.buildSessionContext().messages;
    let jsonResult;
    let nestedRecord;
    try {
      jsonResult = await codemode.execute('native-json-regression', {code: jsonCode}, undefined, undefined,
        runner.createToolContext('native-json-regression', undefined));
    } finally {
      nestedRecord = session._nestedToolCalls?.takeRecord('native-json-regression');
    }
    checks.codemode_programmatic_json_intact = !jsonResult.isError && textOf(jsonResult).includes('native-json-count=4096') &&
      jsonResult.details.calls.length === 1 && jsonResult.details.calls[0].name === 'bash' &&
      nestedRecord?.calls?.calls?.[0]?.status === 'ok';
    observed.stage = 'router';
    const virtual = runtime.getModel('apex', 'auto');
    const route = observed.router_definition.route({model: virtual, reason: 'user', thinkingLevel: 'xhigh', messages: []}, ctx);
    manager.appendCustomEntry('pi.virtual-model-state', {provider: 'apex', modelId: 'auto', state: route.state});
    const continued = observed.router_definition.route({model: virtual, reason: 'continuation', thinkingLevel: 'xhigh',
      previous: {model: route.model, thinkingLevel: route.thinkingLevel}, state: route.state, messages: []}, ctx);
    checks.native_router = virtual?.api === 'pi-virtual' && route.model === model && continued.model === model &&
      route.thinkingLevel === 'xhigh' && continued.thinkingLevel === 'xhigh' &&
      manager.getBranch().some(entry => entry.customType === 'pi.virtual-model-state');
    observed.stage = 'mask';
    // Masking defaults skip structured shell payloads. This separate synthetic
    // text observation exercises eligible native persisted projection, without
    // pretending its bytes are a measured model observation or token saving.
    const maskText = 'synthetic local text-only observation\n'.repeat(700);
    const maskLog = path.join(spec.fixture, 'mask-observation.log');
    await writeFile(maskLog, maskText);
    manager.appendMessage(assistant([{type: 'toolCall', id: 'synthetic-mask', name: 'bash', arguments: {command: 'synthetic text fixture'}}], 'toolUse'));
    const maskTarget = manager.appendMessage({role: 'toolResult', toolCallId: 'synthetic-mask', toolName: 'bash',
      content: [{type: 'text', text: maskText}], details: {fullOutputPath: maskLog}, isError: false, timestamp: ++clock});
    let recent;
    for (let index = 0; index < 5; index++) {
      recent = assistant([{type: 'text', text: `Synthetic recent assistant ${index}: preserve local contract.`}]);
      manager.appendMessage(recent);
    }
    session.agent.state.messages = manager.buildSessionContext().messages;
    // Agent.finishTurn is Pi's real turn boundary and commits the coordinator's
    // append-only context_edit drafts to the native SessionManager.
    await session.agent.finishTurn({message: recent, toolResults: []});
    const projected = manager.buildSessionProjection().entries.find(entry => entry.sourceEntry.id === maskTarget)?.messages[0];
    const reopened = pi.SessionManager.open(manager.getSessionFile(), path.join(spec.fixture, 'sessions'), spec.fixture);
    const maskReturned = textOf(projected ?? {});
    checks.persisted_masking = maskReturned.startsWith('[elided:') &&
      textOf(reopened.buildSessionProjection().entries.find(entry => entry.sourceEntry.id === maskTarget)?.messages[0] ?? {}) === maskReturned &&
      textOf(reopened.getEntry(maskTarget).message) === maskText &&
      manager.getBranch().some(entry => entry.type === 'context_edit' && entry.targetId === maskTarget);
    observed.stage = 'compaction';
    let cancelled = false;
    try {await session.compact('Offline test: native extension must cancel before account or inference access.');}
    catch (error) {cancelled = error.message === 'Compaction cancelled';}
    const compactEntries = manager.getEntries().filter(entry => entry.type === 'compaction');
    checks.native_compaction_cancelled = cancelled && observed.compact_hook === 1 && compactEntries.length === 0 && allZero(calls);
    checks.no_extension_errors = extensionErrors.length === 0;
    return {pi_version: version, checks, settings: {cache_warming: 'off', retry_enabled: false, automatic_compaction_enabled: false},
      registration: {extension_count: loader.getExtensions().extensions.length, registered_tool_count: registered.length,
        active_tool_count_before_discovery: activeBeforeSearch.length, callable_tool_count: callable.length,
        names: requiredTools, post_registration_refreshes_suppressed: observed.suppressed_local_refreshes},
      compaction: {cancelled, hook_calls: observed.compact_hook, entry_count: compactEntries.length},
      codemode: {models_global: textOf(codeHook ?? codeResult).includes('undefined') ? 'undefined' : 'unverified',
        engine_source: 'pinned installed Pi QuickJS worker; no engine installation', native_script_executed: true,
        programmatic_json_bytes: Buffer.byteLength(programmatic), programmatic_json_item_count: 4096,
        programmatic_nested_call_count: jsonResult.details.calls.length,
        programmatic_tiny_output: !jsonResult.isError && textOf(jsonResult).includes('native-json-count=4096')},
      synthetic_metrics: {shape: {original_bytes: shape?.originalBytes, returned_bytes: shape?.returnedBytes,
        returned_ratio: shape ? shape.returnedBytes / shape.originalBytes : null, source: 'actual native bash hook-visible result'},
      mask: {original_bytes: Buffer.byteLength(maskText), returned_bytes: Buffer.byteLength(maskReturned),
        returned_ratio: Buffer.byteLength(maskReturned) / Buffer.byteLength(maskText), source: 'synthetic text observation in native persisted projection'},
      provider_token_savings_measured: false}};
  } finally {
    session._nestedToolCalls?.clear();
    session.dispose();
  }
}

async function childMain(spec) {
  const calls = counters();
  const discovery = {attempts: 0};
  const observed = {stage: 'guards', session_start: 0, compact_hook: 0, suppressed_local_refreshes: 0};
  // Without live builtins the fs guard would miss Pi's own reads and the gate could pass vacuously.
  if (!liveBuiltinsLoaded()) return {failure: 'live_builtins_unavailable', failure_stage: observed.stage,
    attempted_calls: calls, resource_discovery_attempts: 0};
  denyExternal(calls);
  denyAmbientDiscovery(spec.fixture, discovery);
  const environment_sanitized = process.env.PI_OFFLINE === '1' &&
    process.env.PI_CODING_AGENT_DIR === path.join(spec.fixture, 'agent') &&
    environmentNamesAllowed(permittedEnv, process.env, process.platform, spec.fixture);
  try {
    const result = await nativeFixture(spec, calls, observed);
    return {...result, environment_sanitized, attempted_calls: calls, resource_discovery_attempts: discovery.attempts};
  } catch (error) {
    const safeCodes = new Set(['unexpected_pi_version', 'physical_model_contract_missing', 'fixture_tool_failed',
      'fixture_extension_failed_to_load', 'resource_discovery_contract_missing', 'offline_resource_discovery_denied',
      'offline_network_denied', 'offline_auth_denied', 'offline_credentials_denied', 'offline_inference_denied']);
    return {failure: safeCodes.has(error.message) ? error.message : 'offline_phase1_fixture_operation_failed',
      failure_stage: observed.stage, environment_sanitized, attempted_calls: calls, resource_discovery_attempts: discovery.attempts};
  }
}

async function runChild(spec) {
  const env = {...fixtureEnvironment(permittedEnv, spec.fixture), PI_OFFLINE: '1', PI_CODING_AGENT_DIR: path.join(spec.fixture, 'agent'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0'};
  env.PATH = [path.dirname(process.execPath), path.join(root, '.tools/bin'), env.PATH].filter(Boolean).join(path.delimiter);
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--preload', LIVE_BUILTINS, script, '--phase1-micro-child', JSON.stringify(spec)],
      {cwd: spec.fixture, env, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', totalBytes = 0, exceeded = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    const count = chunk => {totalBytes += chunk.length; if (totalBytes > 65536) {exceeded = true; child.kill('SIGKILL');}};
    child.stdout.on('data', chunk => {count(chunk); if (!exceeded) stdout += chunk;});
    child.stderr.on('data', count);
    child.once('error', () => {clearTimeout(timer); resolve({failure: 'child_spawn_failed'});});
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      if (signal || exceeded) return resolve({failure: 'child_failed_or_timed_out'});
      try {
        const result = JSON.parse(stdout);
        if (status !== 0 && !result.failure) result.failure = 'child_failed';
        resolve(result);
      } catch {resolve({failure: 'invalid_child_report'});}
    });
  });
}

export async function runPhase1Micro({fixtureMode = 'success'} = {}) {
  if (!['success', 'ambient-discovery', 'missing-compact', 'shape-programmatic-results'].includes(fixtureMode)) throw new Error('unknown_fixture_mode');
  const artifact = {kind: 'offline_phase1_contract', status: 'FAIL', model: modelName, thinking_level: 'xhigh',
    transcript_source: 'script-seeded local native tool calls plus an explicitly synthetic text masking observation',
    model_performance_measured: false, provider_calls: 0, benchmark_runs: 0, network_attempts: 0, transport_attempts: 0,
    resource_discovery_attempts: 0, attempted_calls: counters(), checks: {}, cleanup: {fixture_removed: false}};
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'phase1-micro-'));
  artifact.fixture = fixture;
  try {
    const result = await runChild({fixture, fixtureMode});
    Object.assign(artifact, result);
    artifact.checks = {...result.checks, environment_sanitized: result.environment_sanitized === true,
      no_ambient_discovery: result.resource_discovery_attempts === 0};
    delete artifact.environment_sanitized;
    artifact.network_attempts = artifact.attempted_calls.network;
    artifact.transport_attempts = artifact.attempted_calls.inference;
    if (!artifact.failure && Object.values(artifact.checks).every(value => value === true) && allZero(artifact.attempted_calls)) artifact.status = 'PASS';
    else artifact.failure ??= 'offline_phase1_contract_failed';
  } catch {artifact.failure ??= 'offline_phase1_fixture_failed';}
  finally {
    try {await rm(fixture, {recursive: true, force: true});}
    catch {artifact.status = 'FAIL'; artifact.failure = 'fixture_cleanup_failed';}
    artifact.cleanup.fixture_removed = !existsSync(fixture);
  }
  return artifact;
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  let result;
  try {
    result = process.argv[2] === '--phase1-micro-child' ? await childMain(JSON.parse(process.argv[3])) : await runPhase1Micro();
  } catch {result = {kind: 'offline_phase1_contract', status: 'FAIL', failure: 'phase1_micro_cli_failed'};}
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'FAIL' || result.failure) process.exitCode = 1;
}
