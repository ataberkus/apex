import {spawn} from 'node:child_process';
import fs, {existsSync} from 'node:fs';
import fsPromises, {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {denyBunNetwork, environmentNamesAllowed, fixtureEnvironment, fixtureShellPath, LIVE_BUILTINS, liveBuiltinsLoaded, PINNED_PI_VERSION, WINDOWS_FIXTURE_ENV} from './micro-session.mjs';

// Importing this gate loads only Node builtins. SDK, factories, fixtures and
// processes exist only inside a bounded, deliberately offline child run.
const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const modelId = 'meta/muse-spark-1.3-contributor';
const modelName = `openrouter/${modelId}`;
// Bun keeps its transpiler cache under HOME, the fixture on Windows; children disable it so the runtime never fills
// the fixture (BUN_RUNTIME_TRANSPILER_CACHE_PATH=0).
const permittedEnv = ['PATH', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'PI_OFFLINE', 'PI_CODING_AGENT_DIR',
  'BUN_RUNTIME_TRANSPILER_CACHE_PATH', ...(process.platform === 'win32' ? WINDOWS_FIXTURE_ENV : [])];
const counters = () => ({network: 0, auth: 0, inference: 0, credentials: 0});
const textOf = result => (result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const allZero = value => Object.values(value).every(count => count === 0);
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

function denyExternal(calls) {
  const deny = () => {calls.network++; throw new Error('offline_network_denied');};
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
  const runtime = await pi.ModelRuntime.create({credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false});
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
  // The pinned registry schedules catalog-availability refreshes even with
  // allowNetwork:false. Only this documented local test boundary is suppressed.
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
    noThemes: true, noContextFiles: true, appendSystemPrompt: [], extensionFactories: factories,
    agentsFilesOverride: () => ({agentsFiles: [{path: path.join(spec.fixture, 'AGENTS.md'),
      content: 'NATIVE_CONTEXT_SENTINEL: preserve this explicitly supplied fixture context.'}]})});
  // no* flags apply after package resolution in Pi 1.4.0. Isolate the actual
  // package-manager discovery seam as well, rather than trusting flags alone.
  if (spec.fixtureMode !== 'ambient-discovery') {
    if (typeof loader.packageManager?.resolve !== 'function' ||
      typeof loader.packageManager?.resolveExtensionSources !== 'function') throw new Error('resource_discovery_contract_missing');
    const empty = async () => ({extensions: [], skills: [], prompts: [], themes: []});
    loader.packageManager.resolve = empty;
    loader.packageManager.resolveExtensionSources = empty;
  }
  return loader;
}

async function makeSession(pi, spec, shared, {flags = 'all', phase1 = false, manager, now = () => 0} = {}) {
  const {createApexCore} = await import('../extensions/apex-core/index.mjs');
  const core = createApexCore({now});
  const factory = api => {
    const nativeGetFlag = api.getFlag.bind(api);
    core(new Proxy(api, {get(target, name) {
      if (name === 'getFlag') return flag => ({'apex-core-flags': flags, 'apex-time-budget': flags === 'all' ? '1' : '',
        'apex-attempts': '2', headless: true})[flag] ?? nativeGetFlag(flag);
      if (name === 'registerFlag') return (flag, options) => {
        shared.registered_flags.set(flag, options.default);
        return target.registerFlag(flag, options);
      };
      if (name === 'on') return (event, handler) => {
        if (spec.fixtureMode === 'missing-gate' && event === 'agent_before_settle') return () => {};
        return target.on(event, handler);
      };
      return Reflect.get(target, name);
    }}));
    api.on('session_start', () => {shared.session_starts++;});
  };
  const factories = [factory];
  if (phase1) {
    const {default: context} = await import('../extensions/apex-context/index.mjs');
    factories.unshift(api => context(new Proxy(api, {get(target, name) {
      if (name === 'getFlag') return flag => flag === 'apex-context-flags' ? 'mask,compact,output,lazy' : target.getFlag(flag);
      return Reflect.get(target, name);
    }})));
  }
  manager ??= pi.SessionManager.create(spec.fixture, path.join(spec.fixture, 'sessions'));
  manager.appendModelChange(shared.model.provider, shared.model.id);
  manager.appendThinkingLevelChange('xhigh');
  const settings = pi.SettingsManager.inMemory({compaction: {enabled: false, keepRecentTokens: 96, reserveTokens: 256},
    shellPath: fixtureShellPath(), cacheWarming: 'off', retry: {enabled: false, maxRetries: 0}, packages: [], extensions: [], codemode: {mode: 'on', inlineBudget: 3000}});
  const loader = fixtureLoader(pi, spec, settings, factories);
  await loader.reload();
  if (loader.getExtensions().errors.length) throw new Error('fixture_extension_failed_to_load');
  const {session} = await pi.createAgentSession({cwd: spec.fixture, agentDir: path.join(spec.fixture, 'agent'),
    modelRuntime: shared.runtime, model: shared.model, thinkingLevel: 'xhigh', settingsManager: settings,
    sessionManager: manager, resourceLoader: loader});
  session.agent.streamFunction = shared.denyInference;
  await session.bindExtensions({onError: event => {shared.extension_errors.push({event: event.event, error: String(event.error)});}});
  let clock = 0, toolIndex = 0;
  const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
  const assistant = (content, stopReason = 'stop') => ({role: 'assistant', content, api: shared.model.api,
    provider: shared.model.provider, model: shared.model.id, usage, stopReason, timestamp: ++clock});
  const sync = () => {session.agent.state.messages = manager.buildSessionContext().messages;};
  const execute = async (name, input, {allowError = false} = {}) => {
    const toolCall = {type: 'toolCall', id: `phase2-native-${++toolIndex}`, name, arguments: input};
    manager.appendMessage(assistant([toolCall], 'toolUse'));
    sync();
    const definition = session.getToolDefinition(name);
    if (!definition) throw new Error('fixture_native_tool_missing');
    const prepared = definition.prepareArguments ? definition.prepareArguments(input) : input;
    const interception = await session.agent.beforeToolCall({toolCall, args: prepared});
    let raw;
    if (interception?.block) raw = {content: [{type: 'text', text: interception.reason ?? 'Blocked by hook.'}], isError: true};
    else {
      await session.extensionRunner.emit({type: 'tool_execution_start', toolCallId: toolCall.id, toolName: name, args: prepared});
      try {
        raw = await definition.execute(toolCall.id, prepared, undefined, undefined,
          session.extensionRunner.createToolContext(toolCall.id, undefined));
      } catch (error) {raw = {content: [{type: 'text', text: String(error.message)}], isError: true};}
      await session.extensionRunner.emit({type: 'tool_execution_end', toolCallId: toolCall.id, toolName: name,
        result: raw, isError: raw.isError ?? false});
    }
    const hook = await session.agent.afterToolCall({toolCall, args: prepared, result: raw, isError: raw.isError ?? false});
    const result = hook ? {...raw, ...hook} : raw;
    manager.appendMessage({role: 'toolResult', toolCallId: toolCall.id, toolName: name, content: result.content,
      details: result.details, ...(result.structuredContent === undefined ? {} : {structuredContent: result.structuredContent}),
      isError: result.isError ?? false, timestamp: ++clock});
    sync();
    if (result.isError && !allowError) throw new Error('fixture_tool_failed');
    return result;
  };
  // Mirrors Pi 1.4.0 AgentSession._prepareRun for a user trigger: emit, let the live loadout win
  // unless a handler edited selectedTools, then record the prompt/tool loadout.
  const start = async task => {
    const before = session._baseSystemPromptOptions.selectedTools;
    const result = await session.extensionRunner.emitBeforeAgentStart({messageType: 'user', prompt: task}, session._baseSystemPromptOptions);
    const selected = result.systemPromptOptions.selectedTools;
    if (selected.length === before.length && selected.every((name, index) => name === before[index]))
      result.systemPromptOptions.selectedTools = session.getActiveToolNames();
    const update = session._preparePromptAndToolLoadout(result.systemPromptOptions);
    session._runSystemPromptOptions = result.systemPromptOptions;
    if (update) manager.appendMessage(update);
    manager.appendMessage({role: 'user', content: task, timestamp: ++clock});
    for (const message of result.messages) manager.appendCustomMessageEntry(message.customType,
      message.content ?? [], message.display, message.details);
    sync();
    return result;
  };
  const turn = async (text = 'Script-seeded local assistant boundary.', stopReason = 'stop') => {
    const message = assistant([{type: 'text', text}], stopReason);
    manager.appendMessage(message);
    sync();
    return session.agent.finishTurn({message, toolResults: []});
  };
  return {session, manager, settings, loader, execute, start, turn, sync, assistant,
    dispose: () => {session._nestedToolCalls?.clear(); session.dispose();}};
}

async function mainFixture(pi, spec, shared, observed) {
  const off = await makeSession(pi, spec, shared, {flags: ''});
  let defaultFeaturesOff;
  try {
    await off.start('A local one-step fixture task.');
    defaultFeaturesOff = ['contract', 'todo', 'bg', 'explore', 'verify'].every(name => !off.session.getToolDefinition(name)) &&
      !off.manager.getBranch().some(entry => entry.customType?.startsWith('apex-'));
  } finally {off.dispose();}
  let now = 0;
  const fixture = await makeSession(pi, spec, shared, {phase1: true, now: () => now});
  const {session, manager, execute, start, turn, sync} = fixture;
  const checks = {default_features_off: defaultFeaturesOff,
    native_registration: ['contract', 'todo', 'bg', 'explore', 'verify'].every(name => !!session.getToolDefinition(name)) &&
      shared.registered_flags.get('apex-core-flags') === '',
    effective_model: session.model.provider === 'openrouter' && session.model.id === modelId && session.thinkingLevel === 'xhigh',
    offline_settings: fixture.settings.getCacheWarmingMode() === 'off' && fixture.settings.getRetrySettings().enabled === false &&
      fixture.settings.getCompactionSettings(shared.model).enabled === false};
  try {
    observed.stage = 'profile_and_todo';
    const task = 'Complete this local task:\n1. Write the fixture module.\n2. Verify its syntax.\n3. Report the result.';
    const profile = await start(task);
    const automaticExtraction = manager.getBranch().findLast(entry => entry.customType === 'apex-task-state')?.data?.extraction;
    const promptModule = await import(pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js')).href);
    const promptText = promptModule.buildSystemPrompt(profile.systemPromptOptions);
    checks.native_profile_preserves_context = profile.systemPromptOptions.forceSystemPrompt === undefined &&
      promptText.includes('NATIVE_CONTEXT_SENTINEL') && promptText.includes('<tools>') && promptText.includes('<rules>') &&
      Object.keys(profile.systemPromptOptions.sections).some(name => name.startsWith('apex')) &&
      session.systemPrompt.includes('NATIVE_CONTEXT_SENTINEL');
    checks.native_initial_context_persisted = manager.getBranch().filter(entry =>
      entry.type === 'custom_message' && entry.customType === 'apex-initial-context').length === 1;
    for (let index = 0; index < 5; index++) await turn(`Script-seeded orientation turn ${index}.`);
    observed.stage = 'contracts';
    // Recognized Bun verification: `bun test` on a fixture test that imports the module, so a missing or invalid
    // module fails. The tests are fixture scaffolding written directly, never tool mutations.
    const fixtureTest = name => `import {expect, test} from 'bun:test';\nimport * as module from './${name}.mjs';\n` +
      `test('${name} module exports', () => expect(Object.keys(module)).toEqual(['${name}']));\n`;
    await writeFile(path.join(spec.fixture, 'fixture.test.mjs'), fixtureTest('fixture'));
    await writeFile(path.join(spec.fixture, 'nested.test.mjs'), fixtureTest('nested'));
    const contract = await execute('contract', {action: 'set', criteria: [
      {id: 'R1', requirement: 'Create a valid local fixture module.', check: 'bun test ./fixture.test.mjs',
        artifact: {path: 'fixture.mjs', format: 'text', contains: 'export const fixture'}},
      {id: 'R2', requirement: 'Report the local check outcome.', check: 'Manual fixture reporting criterion.'},
    ]});
    const droppedWithoutReason = await execute('todo', {action: 'drop', id: 'R2'}, {allowError: true});
    const dropped = await execute('todo', {action: 'drop', id: 'R2', reason: 'Reporting is retained in this deterministic local artifact.'});
    await execute('todo', {action: 'done', id: 'R1'});
    checks.native_todo_drop_reason = droppedWithoutReason.isError === true &&
      dropped.structuredContent?.delta?.some(item => item.id === 'R2' && item.status === 'dropped' && !!item.reason);
    observed.stage = 'auxiliary_denials';
    const explore = await execute('explore', {task: 'Inspect only this local fixture.'}, {allowError: true});
    const verify = await execute('verify', {task: 'Verify only this local fixture.'}, {allowError: true});
    const models = await import('../extensions/apex-core/models.mjs');
    const config = await import('../extensions/apex-core/config.mjs');
    let maxBlocked = false, maxSideEffects = 0;
    try {
      await models.runMaxAttempts({policy: config.runtimePolicy(), cwd: spec.fixture, task,
        createIsolation: () => {maxSideEffects++; throw new Error('unexpected isolation');},
        runAttempt: () => {maxSideEffects++; throw new Error('unexpected attempt');}});
    } catch (error) {maxBlocked = /offline-only|offline|authorization/i.test(error.message);}
    checks.auxiliary_denied_before_auth = [explore, verify].every(result => result.isError === true) &&
      /offline-only|offline|authorization/i.test(textOf(explore)) && /offline-only|offline|authorization/i.test(textOf(verify)) &&
      automaticExtraction?.attempted === true && automaticExtraction?.status === 'blocked' &&
      /offline|policy/i.test(automaticExtraction.reason) &&
      maxBlocked && maxSideEffects === 0 && allZero(shared.calls);
    observed.stage = 'verification_gate';
    const beforeWriteCheck = await execute('bash', {command: 'bun test ./fixture.test.mjs'}, {allowError: true});
    await execute('write', {path: 'fixture.mjs', content: 'export const fixture = "native";\n'});
    const forced = [];
    let initiallyRunnable;
    for (let index = 0; index < 3; index++) {
      await turn(`Script-seeded final assistant before gate ${index}.`);
      initiallyRunnable ??= session._buildBoundaryContext([], 'agent_before_settle').canContinue;
      forced.push(await session._runBeforeSettleBoundary());
    }
    checks.native_gate_two_continuations = initiallyRunnable === false && forced[0] === true && forced[1] === true && forced[2] === false;
    // A new user run restores the gate budget and discards the earlier failure.
    await start(task);
    await execute('contract', {action: 'set', criteria: [{id: 'R1', requirement: 'Create a valid local fixture module.',
      check: 'bun test ./fixture.test.mjs', artifact: {path: 'fixture.mjs', format: 'text', contains: 'export const fixture'}}]});
    await execute('todo', {action: 'done', id: 'R1'});
    await execute('write', {path: 'fixture.mjs', content: 'export const fixture = "after";\n'});
    await turn('Script-seeded final assistant after mutation.');
    const staleContinuation = await session._runBeforeSettleBoundary();
    const verification = await execute('bash', {command: 'bun test ./fixture.test.mjs'});
    await turn('Script-seeded final assistant after successful verification.');
    const verifiedContinuation = await session._runBeforeSettleBoundary();
    checks.native_verification_after_mutation = beforeWriteCheck.isError === true && staleContinuation === true &&
      verification.structuredContent?.exit_code === 0 && verifiedContinuation === false &&
      (await readFile(path.join(spec.fixture, 'fixture.mjs'), 'utf8')).includes('"after"');
    checks.native_tools_executed = contract.structuredContent?.criteria?.length === 2 && !verification.isError &&
      (await readFile(path.join(spec.fixture, 'fixture.mjs'), 'utf8')).includes('export const fixture');
    observed.stage = 'nested_native_tools';
    const nestedCode = 'await tools.write({path:"nested.mjs",content:"export const nested = true;\\n"}); ' +
      'const result = await tools.bash({command:"bun test ./nested.test.mjs"}); return "native-nested-exit=" + result.exit_code;';
    const nestedResult = await execute('codemode', {code: nestedCode});
    const nestedParentId = manager.getBranch().findLast(entry => entry.type === 'message' && entry.message.role === 'toolResult')?.message.toolCallId;
    const nestedRecord = session._nestedToolCalls?.takeRecord(nestedParentId);
    await turn('Script-seeded final assistant after ordered native nested write/check.');
    const afterNestedContinuation = await session._runBeforeSettleBoundary();
    const nestedCalls = nestedResult.details?.calls ?? [];
    checks.native_nested_tool_ordering = !nestedResult.isError && textOf(nestedResult).includes('native-nested-exit=0') &&
      nestedCalls.length === 2 && nestedCalls[0].name === 'write' && nestedCalls[1].name === 'bash' &&
      nestedRecord?.calls?.calls?.every(call => call.status === 'ok') && afterNestedContinuation === false &&
      (await readFile(path.join(spec.fixture, 'nested.mjs'), 'utf8')).includes('export const nested = true;');
    observed.stage = 'loop_time_and_composition';
    const maskingText = 'Synthetic text-only local masking fixture.\n'.repeat(700);
    const maskingLog = path.join(spec.fixture, 'mask-observation.log');
    await writeFile(maskingLog, maskingText);
    manager.appendMessage(fixture.assistant([{type: 'toolCall', id: 'phase2-mask-composition', name: 'bash',
      arguments: {command: 'synthetic text observation'}}], 'toolUse'));
    const maskTarget = manager.appendMessage({role: 'toolResult', toolCallId: 'phase2-mask-composition', toolName: 'bash',
      content: [{type: 'text', text: maskingText}], details: {fullOutputPath: maskingLog}, isError: false, timestamp: Date.now()});
    sync();
    for (const input of [{path: 'fixture.mjs'}, {path: 'fixture.mjs', limit: 1},
      {path: 'fixture.mjs', offset: 1, limit: 1}]) {
      for (let index = 0; index < 4; index++) await execute('read', {...input});
    }
    for (let index = 0; index < 5; index++) await turn(`Script-seeded composition turn ${index}.`);
    for (const value of [510, 760, 910, 980, 999]) {now = value; await turn(`Script-seeded monotonic time ${value}.`);}
    const projected = manager.buildSessionProjection().entries.find(entry => entry.sourceEntry.id === maskTarget)?.messages[0];
    checks.native_phase1_boundary_composition = textOf(projected).startsWith('[elided:') &&
      manager.getBranch().some(entry => entry.type === 'context_edit' && entry.targetId === maskTarget);
    const custom = manager.getBranch().filter(entry => entry.type === 'custom_message');
    const todoSteers = custom.filter(entry => /todo.*steer|steer.*todo/.test(entry.customType));
    const loopNotes = custom.filter(entry => /loop/.test(entry.customType));
    const timeNotes = custom.filter(entry => /time/.test(entry.customType));
    const thresholds = timeNotes.map(entry => entry.details?.threshold ?? entry.details?.percent ??
      Number(String(entry.content).match(/(?:50|75|90)/)?.[0])).filter(Number.isFinite)
      .map(value => value > 0 && value <= 1 ? Math.round(value * 100) : value);
    checks.native_todo_steer_once = todoSteers.length === 1;
    checks.native_loop_notes_bounded = loopNotes.length === 2;
    checks.native_time_notes_bounded = timeNotes.length === 3 && JSON.stringify(thresholds) === '[50,75,90]';
    observed.stage = 'branch_restoration';
    const beforeBranch = await execute('todo', {action: 'list'});
    const reopened = pi.SessionManager.open(manager.getSessionFile(), path.join(spec.fixture, 'sessions'), spec.fixture);
    const restored = await makeSession(pi, spec, shared, {manager: reopened});
    try {
      const afterBranch = await restored.execute('todo', {action: 'list'});
      const restoredContract = await restored.execute('contract', {action: 'list'});
      checks.native_branch_restoration = JSON.stringify(afterBranch.structuredContent?.todos) === JSON.stringify(beforeBranch.structuredContent?.todos) &&
        restoredContract.structuredContent?.criteria?.[0]?.id === 'R1' &&
        reopened.getBranch().some(entry => entry.customType === 'apex-contract') &&
        reopened.getBranch().some(entry => entry.customType === 'apex-todo');
    } finally {restored.dispose();}
    if (spec.scope === 'windows') {
      const refused = await execute('bg', {action: 'start', command: 'printf must-not-start'}, {allowError: true});
      checks.windows_bg_refused_before_allocation = refused.isError === true &&
        textOf(refused).includes('Native Windows background management is unsupported') &&
        !existsSync(path.join(spec.fixture, '.apex', 'bg'));
    }
    checks.no_extension_errors = shared.extension_errors.length === 0;
    return {checks, gate: {initial_context_can_continue: initiallyRunnable,
      forced_continuations: forced.filter(Boolean).length, after_cap_continue: forced[2],
      before_verification_continue: staleContinuation, after_verified_continue: verifiedContinuation},
      notes: {todo_steers: todoSteers.length, loop_notes: loopNotes.length, time_thresholds: thresholds},
      registration: {session_starts: shared.session_starts, flags: Object.fromEntries(shared.registered_flags),
        names: ['contract', 'todo', 'bg', 'explore', 'verify'], post_registration_refreshes_suppressed: observed.suppressed_local_refreshes},
      auxiliary: {explore_blocked: explore.isError === true, verify_blocked: verify.isError === true,
        extraction_blocked: automaticExtraction?.status === 'blocked', max_blocked: maxBlocked, max_side_effects: maxSideEffects},
      nested: {call_count: nestedCalls.length, successful_check_after_write: checks.native_nested_tool_ordering,
        after_nested_continue: afterNestedContinuation},
      evidence: {transcript: 'Script-seeded user/assistant messages; no model completions.',
        tools: 'Actual Pi registered definitions with native tool-call/result and execution hooks; nested calls run through native codemode/QuickJS.',
        initial_context: 'Native before_agent_start messages committed through SessionManager alongside its native prompt/loadout preparation; no provider request.',
        settlement: 'Pinned Pi AgentSession._runBeforeSettleBoundary commits real native boundary drafts; no continuation request executed.',
        clock: 'Injected deterministic monotonic milliseconds; no live elapsed-time measurement.',
        context: 'Explicit fixture supplied through native agentsFilesOverride; ambient discovery remains denied.',
        masking: 'Synthetic text-only observation; real Phase 1 projection and context_edit persistence.'},
      extension_errors: shared.extension_errors};
  } finally {fixture.dispose();}
}

async function backgroundFixture(pi, spec, shared) {
  const fixture = await makeSession(pi, spec, shared, {flags: 'bg'});
  try {
    if (spec.mode === 'bg-start') {
      const workerPath = path.join(spec.fixture, 'owned-service.mjs');
      const heartbeatPath = path.join(spec.fixture, 'heartbeat.txt');
      await writeFile(workerPath, `import {writeFileSync} from 'node:fs';\nlet n=0;\nsetInterval(()=>{writeFileSync(${JSON.stringify(heartbeatPath)},String(++n));console.log('owned-heartbeat='+n);},40);\n`);
      const result = await fixture.execute('bg', {action: 'start', command: `${shellQuote(process.execPath)} ${shellQuote(workerPath)}`});
      return {background: {...result.structuredContent, heartbeat_path: heartbeatPath}};
    }
    const poll = await fixture.execute('bg', {action: 'poll', id: spec.background.id});
    const tail = await fixture.execute('bg', {action: 'tail', id: spec.background.id, maxBytes: 1024});
    const killed = await fixture.execute('bg', {action: 'kill', id: spec.background.id, signal: 'SIGKILL'});
    let finalPoll;
    for (let index = 0; index < 20; index++) {
      finalPoll = await fixture.execute('bg', {action: 'poll', id: spec.background.id});
      if (finalPoll.structuredContent?.status === 'exited') break;
      await pause(40);
    }
    return {background: {poll: poll.structuredContent, tail: tail.structuredContent,
      killed: killed.structuredContent, final_poll: finalPoll.structuredContent}};
  } finally {fixture.dispose();}
}

async function childMain(spec) {
  const calls = counters(), discovery = {attempts: 0};
  const observed = {stage: 'guards', suppressed_local_refreshes: 0};
  // Without live builtins the fs guard would miss Pi's own reads and the gate could pass vacuously.
  if (!liveBuiltinsLoaded()) return {failure: 'live_builtins_unavailable', failure_stage: observed.stage,
    attempted_calls: calls, resource_discovery_attempts: 0};
  denyExternal(calls);
  denyAmbientDiscovery(spec.fixture, discovery);
  const environmentSanitized = process.env.PI_OFFLINE === '1' &&
    process.env.PI_CODING_AGENT_DIR === path.join(spec.fixture, 'agent') &&
    environmentNamesAllowed(permittedEnv, process.env, process.platform, spec.fixture);
  try {
    observed.stage = 'sdk';
    const pi = await import('@earendil-works/pi-coding-agent');
    const version = JSON.parse(await readFile(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8')).version;
    if (version !== PINNED_PI_VERSION) throw new Error('unexpected_pi_version');
    const runtime = await offlineRuntime(pi, calls, observed);
    const shared = {...runtime, calls, registered_flags: new Map(), session_starts: 0, extension_errors: []};
    observed.stage = 'native_session';
    const result = spec.mode ? await backgroundFixture(pi, spec, shared) : await mainFixture(pi, spec, shared, observed);
    if (spec.loseReport) return {failure: 'background_report_lost', pi_version: version,
      environment_sanitized: environmentSanitized, attempted_calls: calls, resource_discovery_attempts: discovery.attempts};
    return {...result, pi_version: version, environment_sanitized: environmentSanitized,
      attempted_calls: calls, resource_discovery_attempts: discovery.attempts};
  } catch (error) {
    const safeCodes = new Set(['unexpected_pi_version', 'physical_model_contract_missing', 'fixture_tool_failed',
      'fixture_native_tool_missing', 'fixture_extension_failed_to_load', 'resource_discovery_contract_missing',
      'offline_resource_discovery_denied', 'offline_network_denied', 'offline_auth_denied', 'offline_credentials_denied', 'offline_inference_denied']);
    return {failure: safeCodes.has(error.message) ? error.message : 'offline_phase2_fixture_operation_failed',
      failure_stage: observed.stage, failure_code: error.code ?? null,
      environment_sanitized: environmentSanitized, attempted_calls: calls,
      resource_discovery_attempts: discovery.attempts};
  }
}

async function runChild(spec) {
  const env = {...fixtureEnvironment(permittedEnv, spec.fixture), PI_OFFLINE: '1', PI_CODING_AGENT_DIR: path.join(spec.fixture, 'agent'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0'};
  env.PATH = [path.dirname(process.execPath), path.join(root, '.tools/bin'), env.PATH].filter(Boolean).join(path.delimiter);
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--preload', LIVE_BUILTINS, script, '--phase2-micro-child', JSON.stringify(spec)],
      {cwd: spec.fixture, env, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', totalBytes = 0, exceeded = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    const count = chunk => {totalBytes += chunk.length; if (totalBytes > 131072) {exceeded = true; child.kill('SIGKILL');}};
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

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function heartbeatAdvanced(file) {
  let first;
  for (let index = 0; index < 30; index++) {
    try {
      const current = await readFile(file, 'utf8');
      if (first !== undefined && Number(current) > Number(first)) return true;
      first ??= current;
    } catch {}
    await pause(40);
  }
  return false;
}

export async function runPhase2Micro({fixtureMode = 'success', scope = 'full'} = {}) {
  if (!['full', 'windows'].includes(scope)) throw new Error('unknown_micro_scope');
  if (scope === 'windows' && process.platform !== 'win32') throw new Error('windows_micro_requires_native_windows');
  if (!['success', 'missing-gate', 'ambient-discovery', 'lost-background-report'].includes(fixtureMode) ||
      (scope === 'windows' && fixtureMode === 'lost-background-report')) throw new Error('unknown_fixture_mode');
  const artifact = {kind: scope === 'windows' ? 'offline_phase2_windows_contract' : 'offline_phase2_contract',
    scope, status: 'FAIL', model: modelName, thinking_level: 'xhigh',
    transcript_source: 'script-seeded native tools/boundaries; deterministic injected clock and synthetic masking observation',
    model_performance_measured: false, provider_calls: 0, benchmark_runs: 0, network_attempts: 0, transport_attempts: 0,
    resource_discovery_attempts: 0, attempted_calls: counters(), checks: {},
    cleanup: {fixture_removed: false, owned_processes_removed: true, recovered_owned_ids: 0}};
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'phase2-micro-'));
  artifact.fixture = fixture;
  let background, backgroundSpec, reaped = false;
  const mergeCounters = value => {
    for (const kind of Object.keys(artifact.attempted_calls)) artifact.attempted_calls[kind] += value.attempted_calls?.[kind] ?? 0;
    artifact.resource_discovery_attempts += value.resource_discovery_attempts ?? 0;
  };
  try {
    const result = await runChild({fixture, fixtureMode, scope});
    Object.assign(artifact, result);
    artifact.checks = {...result.checks, environment_sanitized: result.environment_sanitized === true,
      no_ambient_discovery: result.resource_discovery_attempts === 0};
    delete artifact.environment_sanitized;
    if (scope === 'windows') {
      artifact.background = {status: 'NOT_APPLICABLE',
        reason: 'Unix process survival is outside Windows-native acceptance; refusal before allocation is tested instead.'};
      if (artifact.checks.windows_bg_refused_before_allocation !== true && !artifact.failure) artifact.failure = 'windows_bg_refusal_unverified';
    } else if (!result.failure && ['success', 'lost-background-report'].includes(fixtureMode) && process.platform === 'win32') {
      artifact.background = {status: 'SKIP', reason: 'Native owned-process survival and Unix process-group cleanup require a Unix host.'};
      artifact.checks.native_bg_survives_agent_exit = false;
      artifact.checks.native_bg_owned_cleanup = false;
      artifact.failure = 'native_background_requires_unix';
    } else if (!result.failure && ['success', 'lost-background-report'].includes(fixtureMode)) {
      const backgroundDir = path.join(fixture, 'owned-background');
      await mkdir(backgroundDir);
      backgroundSpec = {fixture: backgroundDir, fixtureMode: 'success'};
      const started = await runChild({...backgroundSpec, mode: 'bg-start', loseReport: fixtureMode === 'lost-background-report'});
      mergeCounters(started);
      background = started.background;
      if (started.failure || !/^[0-9a-f]{32}$/.test(background?.id ?? '') || !Number.isSafeInteger(background?.pid)) {
        artifact.failure = started.failure ?? 'background_start_contract_failed';
      } else {
        const survived = await heartbeatAdvanced(background.heartbeat_path);
        const stopped = await runChild({...backgroundSpec, mode: 'bg-stop', background});
        mergeCounters(stopped);
        reaped = !stopped.failure && ['terminating', 'killed', 'exited'].includes(stopped.background?.killed?.status) &&
          stopped.background?.final_poll?.status === 'exited' && !await heartbeatAdvanced(background.heartbeat_path);
        artifact.background = {id: background.id, pid: background.pid, parent_exited: true,
          survived_parent_exit: survived, owned_kill_succeeded: reaped, external_network_used: false,
          start_status: background.status, poll_status: stopped.background?.poll?.status,
          tail_bytes: Buffer.byteLength(stopped.background?.tail?.output ?? ''), kill_status: stopped.background?.killed?.status,
          source: 'Actual registered native bg tool in separate bounded child processes; service writes only owned local files.'};
        artifact.checks.native_bg_survives_agent_exit = survived && stopped.background?.poll?.status === 'running';
        artifact.checks.native_bg_owned_cleanup = reaped && artifact.background.tail_bytes > 0 && artifact.background.tail_bytes <= 1024;
        artifact.checks.environment_sanitized &&= started.environment_sanitized === true && stopped.environment_sanitized === true;
      }
    }
    artifact.network_attempts = artifact.attempted_calls.network;
    artifact.transport_attempts = artifact.attempted_calls.inference;
    artifact.checks.no_ambient_discovery = artifact.resource_discovery_attempts === 0;
    if (!artifact.failure && Object.values(artifact.checks).every(value => value === true) && allZero(artifact.attempted_calls)) artifact.status = 'PASS';
    else artifact.failure ??= 'offline_phase2_contract_failed';
  } catch {artifact.failure ??= 'offline_phase2_fixture_failed';}
  finally {
    if (!reaped && backgroundSpec) {
      const candidates = [];
      if (background) candidates.push(background);
      else {
        // A child can exit after starting its owned service but before returning
        // its ID. Search only our own newly allocated fixture metadata; the
        // native bg tool validates ownership/HMAC before accepting any kill.
        let names = [];
        for (let index = 0; index < 20; index++) {
          try {names = (await readdir(path.join(backgroundSpec.fixture, '.apex', 'bg'))).filter(name => /^[0-9a-f]{32}\.json$/.test(name));}
          catch {}
          if (names.length) break;
          await pause(40);
        }
        if (names.length <= 8) for (const name of names) candidates.push({id: name.slice(0, -5),
          heartbeat_path: path.join(backgroundSpec.fixture, 'heartbeat.txt')});
        artifact.cleanup.recovered_owned_ids = candidates.length;
      }
      reaped = candidates.length > 0;
      for (const candidate of candidates) {
        const stopped = await runChild({...backgroundSpec, mode: 'bg-stop', background: candidate});
        mergeCounters(stopped);
        reaped &&= !stopped.failure && ['terminating', 'killed', 'exited'].includes(stopped.background?.killed?.status) &&
          stopped.background?.final_poll?.status === 'exited' && !await heartbeatAdvanced(candidate.heartbeat_path);
      }
    }
    artifact.cleanup.owned_processes_removed = !backgroundSpec || reaped;
    if (!artifact.cleanup.owned_processes_removed) {artifact.status = 'FAIL'; artifact.failure = 'owned_background_cleanup_failed';}
    // Keep ownership evidence if an owned service could not be reaped.
    if (artifact.cleanup.owned_processes_removed) {
      try {await rm(fixture, {recursive: true, force: true});}
      catch {artifact.status = 'FAIL'; artifact.failure = 'fixture_cleanup_failed';}
    }
    artifact.cleanup.fixture_removed = !existsSync(fixture);
  }
  artifact.network_attempts = artifact.attempted_calls.network;
  artifact.transport_attempts = artifact.attempted_calls.inference;
  if (!allZero(artifact.attempted_calls) || artifact.resource_discovery_attempts > 0) artifact.status = 'FAIL';
  return artifact;
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  let result;
  try {
    if (process.argv[2] === '--phase2-micro-child') result = await childMain(JSON.parse(process.argv[3]));
    else {
      if (process.argv.slice(2).some(arg => arg !== '--windows') || process.argv.length > 3) throw new Error('unknown_micro_argument');
      result = await runPhase2Micro({scope: process.argv[2] === '--windows' ? 'windows' : 'full'});
    }
  } catch {result = {kind: 'offline_phase2_contract', status: 'FAIL', failure: 'phase2_micro_cli_failed'};}
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'FAIL' || result.failure) process.exitCode = 1;
}
