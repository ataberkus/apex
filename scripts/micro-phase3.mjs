import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
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
import {denyBunNetwork, environmentNamesAllowed, fixtureEnvironment, fixtureShellPath, LIVE_BUILTINS, liveBuiltinsLoaded, PINNED_PI_VERSION,
  whitelistedEnvironment, WINDOWS_FIXTURE_ENV} from './micro-session.mjs';

// Importing this gate loads only Node builtins. SDK, factories, fixtures and
// processes exist only inside a bounded, deliberately offline child run.
const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const modelId = 'meta/muse-spark-1.3-contributor';
const modelName = `openrouter/${modelId}`;
// Bun keeps its transpiler cache under HOME, which is the fixture on Windows; the children disable it
// (BUN_RUNTIME_TRANSPILER_CACHE_PATH=0) so it never pollutes the fixture worktree, Git index or checkpoints.
const permittedEnv = ['PATH', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'PI_OFFLINE', 'PI_CODING_AGENT_DIR',
  'BUN_RUNTIME_TRANSPILER_CACHE_PATH',
  ...(process.platform === 'win32' ? WINDOWS_FIXTURE_ENV : [])];
const counters = () => ({network: 0, auth: 0, inference: 0, credentials: 0});
const hash = value => createHash('sha256').update(value).digest('hex');
const textOf = result => (result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const allZero = value => Object.values(value).every(count => count === 0);

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

async function offlineRuntime(pi, calls, observed, selection = 'muse') {
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
  const windows = selection === 'windows' ? await import('../lib/windows-target.mjs') : undefined;
  const model = windows ? runtime.getPhysicalModel(windows.WINDOWS_PROVIDER, windows.WINDOWS_MODEL_ID) :
    runtime.getPhysicalModel('openrouter', modelId);
  const thinking = windows?.WINDOWS_THINKING ?? 'xhigh';
  if (model?.thinkingLevelMap?.[thinking] !== thinking) throw new Error('physical_model_contract_missing');
  return {runtime, model, thinking, denyInference: deny('inference')};
}

function fixtureLoader(pi, spec, settings, factories) {
  settings.setProjectTrusted(false);
  const loader = new pi.DefaultResourceLoader({cwd: spec.fixture, agentDir: path.join(spec.fixture, 'agent'),
    additionalSkillPaths: spec.fixtureMode === 'ambient-discovery' ?
      [path.join(path.dirname(spec.fixture), '.agents', 'skills')] : [],
    settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true, appendSystemPrompt: [], extensionFactories: factories,
    agentsFilesOverride: () => ({agentsFiles: [{path: path.join(spec.fixture, 'AGENTS.md'),
      content: 'PHASE3_NATIVE_CONTEXT: explicitly supplied native project instructions.'}]})});
  // Pi 1.4.0 resolves packages before applying no* flags. Keep both actual
  // discovery seams local, while allowing selected resources_discover paths.
  if (spec.fixtureMode !== 'ambient-discovery') {
    if (typeof loader.packageManager?.resolve !== 'function' ||
      typeof loader.packageManager?.resolveExtensionSources !== 'function') throw Error('resource_discovery_contract_missing');
    const empty = async () => ({extensions: [], skills: [], prompts: [], themes: []});
    loader.packageManager.resolve = empty;
    loader.packageManager.resolveExtensionSources = empty;
  }
  return loader;
}

async function makeSession(pi, spec, shared, {flags = 'all', coreFlags = '', contextFlags = '', evalMode = false, manager} = {}) {
  const {createApexFeatures} = await import('../extensions/apex-features/index.mjs');
  const factories = [];
  if (contextFlags) {
    const {default: context} = await import('../extensions/apex-context/index.mjs');
    factories.push(api => context(new Proxy(api, {get(target, name) {
      if (name === 'getFlag') return flag => flag === 'apex-context-flags' ? contextFlags : target.getFlag(flag);
      return Reflect.get(target, name);
    }})));
  }
  if (coreFlags) {
    const {createApexCore} = await import('../extensions/apex-core/index.mjs');
    factories.push(api => createApexCore()(new Proxy(api, {get(target, name) {
      if (name === 'getFlag') return flag => flag === 'apex-core-flags' ? coreFlags : target.getFlag(flag);
      return Reflect.get(target, name);
    }})));
  }
  factories.push(api => {
    createApexFeatures()(new Proxy(api, {get(target, name) {
      if (name === 'getFlag') return flag => ({'apex-feature-flags': flags, 'apex-eval': evalMode})[flag] ?? target.getFlag(flag);
      if (name === 'registerFlag') return (flag, options) => {
        shared.registered_flags.set(flag, options.default);
        return target.registerFlag(flag, options);
      };
      if (name === 'on') return (event, handler) => {
        if (spec.fixtureMode === 'missing-plan-gate' && event === 'tool_call') return () => {};
        return target.on(event, handler);
      };
      return Reflect.get(target, name);
    }}));
    // A real deferred callable mutator tests native nested validation + hooks
    // even when /plan removed direct write from its active model loadout.
    api.registerTool({name: 'phase3_fixture_mutate', label: 'Fixture mutation', description: 'Offline fixture-only mutator.',
      exposure: 'deferred', parameters: {type: 'object', properties: {path: {type: 'string'}}, required: ['path'], additionalProperties: false},
      annotations: {readOnlyHint: false, destructiveHint: true},
      execute: async (_id, input) => {
        shared.deferred_executions++;
        const file = path.resolve(spec.fixture, input.path);
        if (!file.startsWith(`${spec.fixture}${path.sep}`)) throw Error('fixture_path_denied');
        await writeFile(file, 'deferred fixture mutation\n');
        return {content: [{type: 'text', text: 'fixture mutation executed'}], structuredContent: {ok: true, fixtureOnly: true}};
      }});
    api.on('session_start', () => {shared.session_starts++;});
    api.on('tool_call', event => {
      shared.tool_events.push({name: event.toolName, parent: event.parentToolCallId ?? null});
    });
  });
  manager ??= pi.SessionManager.create(spec.fixture, path.join(spec.fixture, 'sessions'));
  if (!manager.getEntries().some(entry => entry.type === 'model_change')) manager.appendModelChange(shared.model.provider, shared.model.id);
  if (!manager.getEntries().some(entry => entry.type === 'thinking_level_change')) manager.appendThinkingLevelChange(shared.thinking);
  const settings = pi.SettingsManager.inMemory({compaction: {enabled: false, keepRecentTokens: 96, reserveTokens: 256},
    shellPath: fixtureShellPath(), cacheWarming: 'off', retry: {enabled: false, maxRetries: 0}, packages: [], extensions: [], codemode: {mode: 'on', inlineBudget: 3000}});
  const loader = fixtureLoader(pi, spec, settings, factories);
  await loader.reload();
  if (loader.getExtensions().errors.length) throw Error('fixture_extension_failed_to_load');
  const {session} = await pi.createAgentSession({cwd: spec.fixture, agentDir: path.join(spec.fixture, 'agent'),
    modelRuntime: shared.runtime, model: shared.model, thinkingLevel: shared.thinking, settingsManager: settings,
    sessionManager: manager, resourceLoader: loader});
  session.agent.streamFunction = shared.denyInference;
  await session.bindExtensions({onError: event => {shared.extension_errors.push({event: event.event, error: String(event.error)});}});
  let clock = 0, toolIndex = 0, turnIndex = 0;
  const zeroUsage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
  // Each script-seeded assistant message stands for one model request. Pi 1.4.0's agent loop
  // records the active-tool delta as a system message before every request (declareToolChanges);
  // do the same so the transcript carries the loadout that resume restores.
  const declareTools = () => {
    const changes = shared.ai.getToolStateChanges(shared.ai.getCurrentTools(manager.buildSessionContext().messages),
      session.agent.state.tools.map(shared.ai.toToolDeclaration));
    if (!changes.toolsAdded.length && !changes.toolsRemoved.length) return;
    manager.appendMessage({role: 'system', content: '', ...(changes.toolsAdded.length ? {toolsAdded: changes.toolsAdded} : {}),
      ...(changes.toolsRemoved.length ? {toolsRemoved: changes.toolsRemoved} : {}), timestamp: ++clock});
  };
  const assistant = (content, stopReason = 'stop', usage = zeroUsage) => (declareTools(), {role: 'assistant', content, api: shared.model.api,
    provider: shared.model.provider, model: shared.model.id, usage, stopReason, timestamp: ++clock});
  const sync = () => {session.agent.state.messages = manager.buildSessionContext().messages;};
  const command = async (name, args = '') => {
    const definition = session.extensionRunner.getRegisteredCommands().find(item => item.invocationName === name);
    if (!definition) throw Error(`fixture_command_missing:${name}`);
    return definition.handler(args, session.extensionRunner.createCommandContext());
  };
  const execute = async (name, input, {allowError = false} = {}) => {
    const toolCall = {type: 'toolCall', id: `phase3-native-${++toolIndex}`, name, arguments: input};
    manager.appendMessage(assistant([toolCall], 'toolUse'));
    sync();
    const definition = session.getToolDefinition(name);
    if (!definition) throw Error(`fixture_native_tool_missing:${name}`);
    const prepared = definition.prepareArguments ? definition.prepareArguments(input) : input;
    const interception = await session.agent.beforeToolCall({toolCall, args: prepared});
    let raw;
    if (interception?.block) raw = {content: [{type: 'text', text: interception.reason ?? 'Blocked by native hook.'}], isError: true};
    else {
      await session.extensionRunner.emit({type: 'tool_execution_start', toolCallId: toolCall.id, toolName: name, args: prepared});
      try {
        raw = await definition.execute(toolCall.id, prepared, undefined, undefined,
          session.extensionRunner.createToolContext(toolCall.id, undefined));
      } catch (error) {raw = {content: [{type: 'text', text: String(error.message)}], isError: true};}
      await session.extensionRunner.emit({type: 'tool_execution_end', toolCallId: toolCall.id, toolName: name,
        result: raw, isError: raw.isError ?? false});
    }
    const native = await session.agent.afterToolCall({toolCall, args: prepared, result: raw, isError: raw.isError ?? false});
    const result = native ? {...raw, ...native} : raw;
    if (raw.structuredContent !== undefined && JSON.stringify(raw.structuredContent) !== JSON.stringify(result.structuredContent)) {
      // Secure shaping intentionally replaces the known native shell display schema.
      // Unknown structured results must remain byte-identical, as in the original gate.
      const shapedShell = name === 'bash' && result.details?.apexShape && result.structuredContent?.truncated === true &&
        result.structuredContent.exit_code === raw.structuredContent.exit_code &&
        result.structuredContent.wall_time_seconds === raw.structuredContent.wall_time_seconds;
      if (!shapedShell) shared.structured_results_preserved = false;
    }
    manager.appendMessage({role: 'toolResult', toolCallId: toolCall.id, toolName: name, content: result.content,
      details: result.details, ...(result.structuredContent === undefined ? {} : {structuredContent: result.structuredContent}),
      isError: result.isError ?? false, timestamp: ++clock});
    sync();
    if (result.isError && !allowError) throw Error(`fixture_tool_failed:${name}`);
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
  const beginTurn = async () => {
    await session.extensionRunner.emit({type: 'turn_start', turnIndex: ++turnIndex, timestamp: ++clock});
  };
  const turn = async (text = 'Script-seeded native assistant boundary.', usage = zeroUsage) => {
    const message = assistant([{type: 'text', text}], 'stop', usage);
    manager.appendMessage(message);
    sync();
    return session.agent.finishTurn({message, toolResults: []});
  };
  const dispose = async () => {
    try {await session.extensionRunner.emit({type: 'session_shutdown', reason: 'exit'});}
    finally {session._nestedToolCalls?.clear(); session.dispose();}
  };
  return {session, manager, settings, loader, command, execute, start, beginTurn, turn, sync, assistant, dispose};
}

async function gitFixture(spec) {
  const env = whitelistedEnvironment(permittedEnv);
  Object.assign(env, {GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0'});
  const git = args => new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Native fixture',
      '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', ...args],
    {cwd: spec.fixture, env, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '', bytes = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.stdout.on('data', chunk => {bytes += chunk.length; if (bytes > 65536) child.kill('SIGKILL'); else output += chunk;});
    child.stderr.on('data', chunk => {bytes += chunk.length; if (bytes > 65536) child.kill('SIGKILL');});
    child.once('error', () => {clearTimeout(timer); reject(Error('fixture_git_failed'));});
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal) reject(Error('fixture_git_failed')); else resolve(output.trim());
    });
  });
  await git(['init', '--template=', '-q']);
  await writeFile(path.join(spec.fixture, '.gitignore'), '.apex/\nagent/\nsessions/\n');
  await writeFile(path.join(spec.fixture, 'tracked.txt'), 'committed\n');
  await git(['add', '.']);
  await git(['commit', '-qm', 'owned fixture']);
  await writeFile(path.join(spec.fixture, 'tracked.txt'), 'staged source\n');
  await git(['add', 'tracked.txt']);
  await writeFile(path.join(spec.fixture, 'tracked.txt'), 'dirty source\n');
  await writeFile(path.join(spec.fixture, 'untracked.txt'), 'untracked source\n');
  return {indexHash: hash(await readFile(path.join(spec.fixture, '.git', 'index')))};
}

async function guardedCli(spec, args) {
  const cli = path.join(root, 'bin', 'apex');
  const env = whitelistedEnvironment(permittedEnv);
  // Bun skips onResolve for bare package specifiers and the first matching onLoad wins, so the SDK trap is
  // registered before live-builtins (which then makes bin/apex and lib/ see the patched module objects below).
  const source = `import fs from 'node:fs'; import http from 'node:http'; import https from 'node:https';
    import net from 'node:net'; import tls from 'node:tls'; import dns from 'node:dns'; import dgram from 'node:dgram';
    const calls={network:0,auth:0,inference:0,credentials:0}; let sdkLoads=0;
    Bun.plugin({name:'phase3-cli-sdk-guard',setup(build){build.onLoad({filter:/[\\\\/]@earendil-works[\\\\/]/},()=>{sdkLoads++;throw Error('offline_cli_sdk_load_denied');});}});
    await import(${JSON.stringify(pathToFileURL(LIVE_BUILTINS).href)});
    if(!(${liveBuiltinsLoaded.toString()})())throw Error('live_builtins_unavailable');
    ${denyBunNetwork.toString()}
    (${denyExternal.toString()})(calls);
    const read=fs.readFileSync; fs.readFileSync=(file,...rest)=>{if(/[\\\\/]auth\\.json$/.test(String(file))){calls.credentials++;throw Error('offline_cli_credentials_denied');}return read(file,...rest);};
    process.once('exit',()=>process.stdout.write('PHASE3_CLI_GUARD:'+JSON.stringify({calls,sdkLoads})+'\\n'));
    process.argv=[process.execPath,${JSON.stringify(cli)},...${JSON.stringify(args)}];
    await import(${JSON.stringify(new URL('../bin/apex', import.meta.url).href)});`;
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source],
      {cwd: spec.fixture, env, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '', bytes = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
    const count = chunk => {bytes += chunk.length; if (bytes > 131072) child.kill('SIGKILL');};
    child.stdout.on('data', chunk => {count(chunk); if (bytes <= 131072) stdout += chunk;});
    child.stderr.on('data', chunk => {count(chunk); if (bytes <= 131072) stderr += chunk;});
    child.once('error', () => {clearTimeout(timer); resolve({status: null, guard: null});});
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      const lines = stdout.trim().split('\n');
      const guardLine = lines.findLast(line => line.startsWith('PHASE3_CLI_GUARD:'));
      let guard;
      try {guard = JSON.parse(guardLine?.slice('PHASE3_CLI_GUARD:'.length));} catch {}
      resolve({status: signal ? null : status, guard, stderr,
        output: lines.filter(line => !line.startsWith('PHASE3_CLI_GUARD:')).join('\n')});
    });
  });
}

async function windowsContextFixture(pi, spec, shared) {
  const fixture = await makeSession(pi, spec, shared, {flags: 'checkpoints,plan,remember', contextFlags: 'read,search,edit,shape'});
  const file = 'win ü fixture/sample file.txt';
  const checks = {};
  try {
    await fixture.beginTurn();
    await fixture.execute('write', {path: file, content: 'alpha\r\nbeta\r\n'});
    const read = await fixture.execute('read', {path: 'win ü fixture/SAMPLE FILE.TXT', offset: 2, limit: 1});
    await fixture.execute('edit', {path: file, old_string: 'beta', new_string: 'gamma'});
    checks.windows_literal_paths_crlf = textOf(read).includes('beta') &&
      await readFile(path.join(spec.fixture, file), 'utf8') === 'alpha\r\ngamma\r\n';
    const grep = await fixture.execute('grep', {path: path.join(spec.fixture, 'win ü fixture'), pattern: 'gamma', limit: 5});
    const find = await fixture.execute('find', {path: path.join(spec.fixture, 'win ü fixture'), pattern: '*.txt', limit: 5});
    const ls = await fixture.execute('ls', {path: path.join(spec.fixture, 'win ü fixture'), limit: 5});
    checks.windows_context_tools = [grep, find, ls].every(result => !result.isError && textOf(result).includes('sample file.txt'));
    const output = await fixture.execute('bash', {command: "for ((i=0;i<700;i++)); do printf 'native-long-output\\r\\n'; done", timeout: 5});
    const shape = output.details?.apexShape;
    checks.windows_shape_checkpoint_composition = !!shape && output.structuredContent?.exit_code === 0 &&
      output.structuredContent.truncated === true && shape.returnedBytes < shape.originalBytes &&
      await readFile(shape.logPath, 'utf8') === 'native-long-output\r\n'.repeat(700);
    await fixture.turn();
    const undone = await fixture.command('undo');
    checks.windows_composed_undo = undone?.status === 'restored' && !existsSync(path.join(spec.fixture, file));
    return checks;
  } finally {await fixture.dispose();}
}

async function nativeFixture(pi, spec, shared, observed) {
  const off = await makeSession(pi, spec, shared, {flags: ''});
  let defaultsOff;
  try {
    const discovered = await off.session.extensionRunner.emitResourcesDiscover(spec.fixture, 'startup');
    defaultsOff = !off.session.getToolDefinition('remember') && off.loader.getSkills().skills.length === 0 &&
      discovered.skillPaths.length === 0 && discovered.promptPaths.length === 0 &&
      !off.session.extensionRunner.getRegisteredCommands().some(item => ['cost', 'undo', 'plan', 'review', 'report', 'resume-info'].includes(item.invocationName)) &&
      !off.manager.getBranch().some(entry => entry.customType?.startsWith('apex-feature'));
  } finally {await off.dispose();}
  const initialGit = await gitFixture(spec);
  const fixture = await makeSession(pi, spec, shared, {coreFlags: 'contract,todo,verify,subagents'});
  const {session, manager, execute, command, start, beginTurn, turn, sync, assistant} = fixture;
  const checks = {default_features_off: defaultsOff,
    native_registration: ['cost', 'undo', 'plan', 'review', 'report', 'resume-info'].every(name =>
      session.extensionRunner.getRegisteredCommands().some(item => item.invocationName === name)) &&
      session.getToolDefinition('remember')?.exposure === 'deferred' &&
      shared.registered_flags.get('apex-feature-flags') === '' && shared.registered_flags.get('apex-eval') === false,
    effective_model: session.model.provider === shared.model.provider && session.model.id === shared.model.id && session.thinkingLevel === shared.thinking,
    offline_settings: fixture.settings.getCacheWarmingMode() === 'off' && fixture.settings.getRetrySettings().enabled === false &&
      fixture.settings.getCompactionSettings(shared.model).enabled === false};
  try {
    observed.stage = 'native_plan';
    await start('Write the native fixture module, then verify it.');
    const originalTools = session.getActiveToolNames().slice().sort();
    const plan = await command('plan');
    await start('Inspect a plan without editing the fixture.');
    const read = await execute('read', {path: 'tracked.txt'});
    checks.native_plan_read_allowed = !read.isError && textOf(read).includes('dirty source');
    const write = await execute('write', {path: 'plan-blocked.txt', content: 'must be blocked\n'}, {allowError: true});
    const bash = await execute('bash', {command: 'printf forbidden > bash-blocked.txt'}, {allowError: true});
    checks.native_plan_mutations_blocked = write.isError === true && bash.isError === true &&
      !existsSync(path.join(spec.fixture, 'plan-blocked.txt')) && !existsSync(path.join(spec.fixture, 'bash-blocked.txt'));
    if (spec.fixtureMode === 'missing-plan-gate') return {checks,
      evidence: {fault: 'Actual native feature tool_call handlers removed; direct definitions executed without readonly enforcement.'}};
    const nativeNested = session.extensionRunner.createToolContext('phase3-plan-parent');
    const nestedRead = await nativeNested.executeTool('read', {path: 'tracked.txt'});
    const nestedWrite = await nativeNested.executeTool('write', {path: 'nested-blocked.txt', content: 'must be blocked\n'});
    checks.native_plan_nested_blocked = nestedRead.isError === false && nestedWrite.isError === true &&
      !existsSync(path.join(spec.fixture, 'nested-blocked.txt'));
    const beforeDeferred = shared.deferred_executions;
    const deferred = await nativeNested.executeTool('phase3_fixture_mutate', {path: 'deferred-blocked.txt'});
    const rememberedDuringPlan = await nativeNested.executeTool('remember', {fact: 'DO_NOT_PERSIST_DURING_PLAN'});
    checks.native_plan_deferred_blocked = deferred.isError === true && rememberedDuringPlan.isError === true &&
      shared.deferred_executions === beforeDeferred && !existsSync(path.join(spec.fixture, 'deferred-blocked.txt'));
    manager.appendMessage(assistant([{type: 'text', text: 'Offline readonly plan remains active until explicit save.'}]));
    sync();
    const cooperation = await session._runBeforeSettleBoundary();
    checks.native_plan_core_cooperation = cooperation === false &&
      manager.getBranch().some(entry => entry.type === 'custom' && /plan|feature/.test(entry.customType) && /active|readonly|readOnly/i.test(JSON.stringify(entry.data))) &&
      !manager.getBranch().some(entry => entry.type === 'custom_message' && /verification.*gate|todo.*steer/.test(entry.customType));
    // The real settlement hook may save the script-seeded completed planning
    // response. Open a second readonly phase for the explicit literal save.
    await command('plan', 'Save explicit user-supplied Markdown for this fixture.');
    const markdown = '# Explicit native plan\n\n1. Inspect the local fixture.\n2. Save this literal Markdown.\n';
    const saved = await command('plan', `save ${markdown}`);
    checks.native_plan_saved_exactly = await readFile(path.join(spec.fixture, 'PLAN.md'), 'utf8') === markdown;
    checks.native_plan_loadout_restored = JSON.stringify(session.getActiveToolNames().slice().sort()) === JSON.stringify(originalTools);
    // Pi 1.4.0 resume replays every tool loadout the branch recorded. Plan runs record the
    // read-only loadout and the next run records the restored one, so a session resumed after
    // /plan save (before any further run) must still come back with the original tools.
    observed.stage = 'native_plan_resume';
    const resumedFile = path.join(spec.fixture, 'resumed-sessions', path.basename(manager.getSessionFile()));
    await mkdir(path.dirname(resumedFile), {recursive: true});
    await fsPromises.copyFile(manager.getSessionFile(), resumedFile);
    const resumed = await makeSession(pi, spec, shared, {coreFlags: 'contract,todo,verify,subagents',
      manager: pi.SessionManager.open(resumedFile, path.dirname(resumedFile), spec.fixture)});
    try {
      // Precondition: the copied branch still declares the plan's read-only loadout.
      const recorded = shared.ai.getCurrentTools(resumed.manager.getBranch().flatMap(entry =>
        entry.type === 'message' && entry.message.role === 'system' ? [entry.message] : [])).map(tool => tool.name).sort();
      checks.native_plan_resume_restores_tools = JSON.stringify(recorded) === JSON.stringify(['find', 'grep', 'ls', 'read']) &&
        JSON.stringify(resumed.session.getActiveToolNames().slice().sort()) === JSON.stringify(originalTools);
    } finally {await resumed.dispose();}

    observed.stage = 'native_learnings';
    const fact = 'NATIVE_LEARNING_SENTINEL: verify fixture changes before reporting completion.';
    const remembered = await execute('remember', {fact});
    const learningsPath = path.join(spec.fixture, '.apex', 'LEARNINGS.md');
    checks.native_remember_append = remembered.structuredContent?.ok === true &&
      (await readFile(learningsPath, 'utf8')).includes(fact) && !(await readFile(learningsPath, 'utf8')).includes('DO_NOT_PERSIST_DURING_PLAN');
    const profile = await start('Inspect explicit native learnings and preserve existing project context.');
    // Learnings report the canonical path; a fixture under a short-path TEMP spells it differently.
    const canonicalLearnings = await fsPromises.realpath(learningsPath);
    checks.native_learnings_context = profile.systemPromptOptions.contextFiles.some(file => file.path === canonicalLearnings && file.content.includes(fact)) &&
      profile.systemPromptOptions.contextFiles.some(file => file.content.includes('PHASE3_NATIVE_CONTEXT')) && session.systemPrompt.includes(fact);
    let evalAttempts = 0;
    const originals = [];
    const guardLearning = file => {
      const candidate = file instanceof URL ? fileURLToPath(file) : Buffer.isBuffer(file) ? file.toString() : file;
      if (typeof candidate === 'string' && path.resolve(candidate) === learningsPath) {
        evalAttempts++;
        throw Error('eval_learnings_io_denied');
      }
    };
    for (const [owner, names] of [[fs, ['readFileSync', 'openSync', 'existsSync', 'lstatSync', 'statSync']],
      [fsPromises, ['readFile', 'writeFile', 'appendFile', 'open', 'stat', 'lstat', 'access']]]) {
      for (const name of names) {
        const original = owner[name]; originals.push([owner, name, original]);
        owner[name] = (file, ...args) => {guardLearning(file); return original.call(owner, file, ...args);};
      }
    }
    // live-builtins (preloaded in this child) carries these patches into Apex and Pi named imports.
    let evalFixture;
    try {
      evalFixture = await makeSession(pi, spec, shared, {flags: 'remember', evalMode: true});
      await evalFixture.start('Evaluation mode must not load prior learnings.');
      checks.native_eval_remember_absent = !evalFixture.session.getToolDefinition('remember') &&
        !evalFixture.session.getCallableToolNames().includes('remember') && !evalFixture.session.systemPrompt.includes(fact);
      checks.native_eval_learnings_pre_io = evalAttempts === 0;
    } finally {
      await evalFixture?.dispose();
      for (const [owner, name, original] of originals) owner[name] = original;
    }

    observed.stage = 'native_skills';
    const discovery = await session.extensionRunner.emitResourcesDiscover(spec.fixture, 'startup');
    const skills = fixture.loader.getSkills();
    const expectedSkills = ['debugging', 'test-writing', 'profiling', 'build-systems', 'python-packaging', 'numerics', 'http', 'databases', 'git-surgery', 'security-hardening'];
    checks.native_skills_discovery = skills.diagnostics.filter(item => item.type === 'error').length === 0 &&
      skills.skills.length === expectedSkills.length && expectedSkills.every(name => skills.skills.some(skill => skill.name === name)) &&
      discovery.skillPaths.length > 0 && discovery.promptPaths.length === 0 && fixture.loader.getPrompts().prompts.length === 0 &&
      skills.skills.every(skill => skill.sourceInfo?.metadata?.scope === 'temporary' || skill.sourceInfo?.scope === 'temporary');
    const expanded = session._expandSkillCommand('/skill:debugging Inspect the local fixture.');
    const skillFile = skills.skills.find(skill => skill.name === 'debugging')?.filePath;
    const actualRead = skillFile ? await execute('read', {path: skillFile}) : undefined;
    checks.native_skill_expansion = expanded.startsWith('<skill name="debugging"') && expanded.includes('Inspect the local fixture.') &&
      expanded.includes('scripts/probe.mjs') && actualRead && !actualRead.isError && textOf(actualRead).includes('name: debugging');

    observed.stage = 'native_accounting';
    const seededUsage = {input: 101, output: 23, cacheRead: 7, cacheWrite: 3, totalTokens: 134, reasoning: 5,
      cost: {input: 0.000101, output: 0.000046, cacheRead: 0.0000007, cacheWrite: 0.0000015, total: 0.0001492}};
    await turn('Script-seeded usage accounting fixture; this is no inference or measured spend.', seededUsage);
    const cost = await command('cost');
    const report = await command('report');
    const summary = cost?.summary ?? cost;
    const reported = report?.summary ?? report;
    const nativeStats = session.getSessionStats();
    // All earlier script-seeded tool-use assistants carry placeholder zero usage.
    // Accounting must expose those as unknown, retaining only the known subset.
    const incompleteKnown = summary?.totals?.input === null && summary.knownTotals?.input === 101 &&
      summary.knownTotals.output === 23 && summary.knownTotals.cacheRead === 7 && summary.knownTotals.cacheWrite === 3 &&
      summary.completeness?.issues?.includes('zero_usage_placeholder') && summary.cost?.nativeEstimateUsd === null &&
      summary.cost.knownNativeEstimateUsd === seededUsage.cost.total && nativeStats.tokens.input === 101 && nativeStats.tokens.output === 23;
    const cleanAccounting = await makeSession(pi, spec, shared, {flags: 'cost,report'});
    let cleanSummary, cleanReport;
    try {
      cleanAccounting.manager.appendMessage(cleanAccounting.assistant([{type: 'text', text: 'Single script-seeded native usage fixture.'}], 'stop', seededUsage));
      cleanAccounting.sync();
      cleanSummary = await cleanAccounting.command('cost');
      cleanReport = await cleanAccounting.command('report');
      const cleanStats = cleanAccounting.session.getSessionStats();
      checks.native_usage_accounting = incompleteKnown && cleanSummary?.totals?.input === 101 && cleanSummary.totals.output === 23 &&
        cleanSummary.totals.cacheRead === 7 && cleanSummary.totals.cacheWrite === 3 && cleanStats.tokens.input === 101 &&
        cleanStats.tokens.output === 23 && cleanSummary.cost?.nativeEstimateUsd === seededUsage.cost.total;
      checks.native_report = reported?.knownTotals?.input === 101 && reported.categories?.estimateMethod === 'utf8-bytes/4' &&
        cleanReport?.totals?.input === 101 && cleanReport.categories?.estimateMethod === 'utf8-bytes/4' &&
        Array.isArray(reported.topConsumers) && !JSON.stringify(reported).includes('NATIVE_LEARNING_SENTINEL');
    } finally {await cleanAccounting.dispose();}

    observed.stage = 'native_checkpoint';
    await beginTurn();
    await execute('write', {path: 'tracked.txt', content: 'native mutation\n'});
    await execute('write', {path: 'untracked.txt', content: 'native untracked mutation\n'});
    await execute('write', {path: 'created.txt', content: 'native creation\n'});
    await turn('Script-seeded completed native mutation boundary.');
    const indexAfterMutation = hash(await readFile(path.join(spec.fixture, '.git', 'index')));
    const undo = await command('undo');
    checks.native_checkpoint_undo = (await readFile(path.join(spec.fixture, 'tracked.txt'), 'utf8')) === 'dirty source\n' &&
      (await readFile(path.join(spec.fixture, 'untracked.txt'), 'utf8')) === 'untracked source\n' && !existsSync(path.join(spec.fixture, 'created.txt'));
    checks.source_git_index_unchanged = initialGit.indexHash === indexAfterMutation &&
      initialGit.indexHash === hash(await readFile(path.join(spec.fixture, '.git', 'index')));
    await beginTurn();
    await execute('write', {path: 'tracked.txt', content: 'persistent native mutation\n'});
    await turn('Script-seeded persisted checkpoint boundary.');
    await execute('read', {path: 'tracked.txt', limit: 1});
    const stateEntries = manager.getBranch().filter(entry => entry.type === 'custom').map(entry => [entry.customType, entry.data]);
    const recentRead = manager.getBranch().findLast(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName === 'read');
    manager.appendMessage(assistant([{type: 'toolCall', id: 'phase3-unfinished-native', name: 'write',
      arguments: {path: 'unfinished.txt', content: 'must never replay\n'}}], 'toolUse'));
    sync();
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) throw Error('native_session_file_missing');
    await fixture.dispose();
    const reopenedManager = pi.SessionManager.open(sessionFile, path.join(spec.fixture, 'sessions'), spec.fixture);
    const reopened = await makeSession(pi, spec, shared, {manager: reopenedManager, coreFlags: 'contract,todo,verify,subagents'});
    try {
      const reopenedState = reopened.manager.getBranch().filter(entry => entry.type === 'custom');
      checks.native_resume_custom_state = stateEntries.length > 0 && stateEntries.every(([type, data]) =>
        reopenedState.some(entry => entry.customType === type && JSON.stringify(entry.data) === JSON.stringify(data)));
      checks.native_resume_recent_read = reopened.manager.getBranch().some(entry => entry.id === recentRead?.id &&
        entry.message?.role === 'toolResult' && entry.message.toolName === 'read' && textOf(entry.message).includes('persistent native mutation'));
      const resume = await reopened.command('resume-info');
      const resumeSummary = resume?.summary ?? resume;
      checks.native_resume_pending_not_replayed = !existsSync(path.join(spec.fixture, 'unfinished.txt')) &&
        JSON.stringify(resumeSummary).includes('phase3-unfinished-native') &&
        reopened.manager.getBranch().some(entry => entry.message?.content?.some?.(part => part.id === 'phase3-unfinished-native')) &&
        !reopened.manager.getBranch().some(entry => entry.message?.toolCallId === 'phase3-unfinished-native');
      await reopened.command('undo');
      checks.native_checkpoint_reopen = (await readFile(path.join(spec.fixture, 'tracked.txt'), 'utf8')) === 'dirty source\n' &&
        initialGit.indexHash === hash(await readFile(path.join(spec.fixture, '.git', 'index')));
      observed.stage = 'native_review_guard';
      const review = await reopened.command('review', 'Review this exact owned fixture.');
      const verify = await reopened.execute('verify', {task: 'Verify only the owned fixture.'}, {allowError: true});
      const explore = await reopened.execute('explore', {task: 'Explore only the owned fixture.'}, {allowError: true});
      checks.native_review_guarded = /offline|authorization|disabled|blocked/i.test(JSON.stringify(review)) &&
        verify.isError === true && explore.isError === true && allZero(shared.calls);
    } finally {await reopened.dispose();}

    observed.stage = 'guarded_cli';
    const {buildPiInvocation} = await import('../lib/launcher.mjs');
    const denied = [
      ['--profile', 'max', '--apex-core', 'max'],
      ['--apex-features', 'all', '--model', 'openai/gpt-4.1'],
      // Single models take any level; the apex/auto route and eval isolation stay at xhigh.
      ['--apex-features', 'all', '--apex-context', 'route', '--thinking', 'low'],
      ['--apex-features', 'all', '--apex-eval', '--thinking', 'low'],
    ].map(args => {try {buildPiInvocation(args, '/unused-offline-cli'); return false;} catch {return true;}});
    const cliDenied = [];
    // Naming Muse keeps native Windows from implying --apex-target windows, so the offline max policy answers.
    for (const args of [['--profile', 'max', '--apex-core', 'max', '--model', 'openrouter/meta/muse-spark-1.3-contributor'],
      ['--apex-features', 'all', '--model', 'openai/gpt-4.1'], ['resume', sessionFile],
      ['resume', sessionFile, '--apex-dry-run']]) cliDenied.push(await guardedCli(spec, args));
    const cliReport = await guardedCli(spec, ['report', sessionFile, '--json']);
    let cliReported;
    try {cliReported = JSON.parse(cliReport.output);} catch {}
    const cliGuards = [...cliDenied, cliReport].every(result => result.guard?.sdkLoads === 0 && allZero(result.guard?.calls ?? {missing: 1}));
    for (const result of [...cliDenied, cliReport]) for (const kind of Object.keys(shared.calls))
      shared.calls[kind] += result.guard?.calls?.[kind] ?? 0;
    checks.guarded_cli_commands = denied.every(Boolean) && cliDenied.every(result => result.status === 1) &&
      /offline|policy|disabled/i.test(cliDenied[0].stderr) && /Muse|selected|model/i.test(cliDenied[1].stderr) &&
      /offline-only|disabled/i.test(cliDenied[2].stderr) && /unresolved|replay/i.test(cliDenied[3].stderr) &&
      cliReport.status === 0 && cliReported?.replayPerformed === false &&
      cliReported.pendingTools?.some(call => call.id === 'phase3-unfinished-native') && cliGuards && allZero(shared.calls);
    if (spec.selection === 'windows') {
      observed.stage = 'windows_context_composition';
      Object.assign(checks, await windowsContextFixture(pi, spec, shared));
      const cliWindows = await guardedCli(spec, ['--apex-dry-run', '--apex-target', 'windows', '--profile', 'headless',
        '--apex-context', 'read,search,edit,shape', '--apex-features', 'cost,checkpoints,plan,report', '--', 'literal --apex-core bg']);
      let invocation;
      try {invocation = JSON.parse(cliWindows.output);} catch {}
      const option = name => invocation?.args[invocation.args.indexOf(name) + 1];
      checks.windows_default_launcher = cliWindows.status === 0 && cliWindows.guard?.sdkLoads === 0 &&
        allZero(cliWindows.guard?.calls ?? {missing: 1}) && invocation?.target === 'windows' &&
        option('--model') === `${shared.model.provider}/${shared.model.id}` && option('--thinking') === shared.thinking &&
        invocation.args.at(-1) === 'literal --apex-core bg';
    }
    checks.structured_results_preserved = shared.structured_results_preserved && remembered.structuredContent?.ok === true;
    checks.no_extension_errors = shared.extension_errors.length === 0;
    return {checks,
      registration: {session_starts: shared.session_starts, flags: Object.fromEntries(shared.registered_flags),
        commands: ['cost', 'undo', 'plan', 'review', 'report', 'resume-info'], local_refreshes_suppressed: observed.suppressed_local_refreshes},
      plan: {read_allowed: checks.native_plan_read_allowed, direct_write_blocked: write.isError === true, bash_blocked: bash.isError === true,
        nested_write_blocked: nestedWrite.isError === true, deferred_blocked: deferred.isError === true,
        core_continuation: cooperation, literal_markdown_bytes: Buffer.byteLength(markdown), entered: !!plan, saved: !!saved},
      accounting: {source: 'Script-seeded native assistant usage, checked against native getSessionStats; no inference or real spend.',
        input: summary?.totals?.input, output: summary?.totals?.output, cache_read: summary?.totals?.cacheRead,
        cache_write: summary?.totals?.cacheWrite, known_totals: summary?.knownTotals, completeness: summary?.completeness,
        cost: summary?.cost, clean_native_totals: cleanSummary?.totals,
        clean_native_estimate_usd: cleanSummary?.cost?.nativeEstimateUsd,
        seeded_native_estimate_usd: seededUsage.cost.total, actual_provider_spend_measured: false},
      checkpoint: {source: 'Actual registered native writes, turn_start/finishTurn boundaries, private shadow Git and /undo command.',
        dirty_restored: checks.native_checkpoint_undo, reopened_restored: checks.native_checkpoint_reopen,
        user_git_index_unchanged: checks.source_git_index_unchanged, undo_status: undo?.status ?? null},
      resume: {source: 'Native SessionManager.open of exact persisted JSONL; no model prompt or automatic tool replay.',
        custom_state_preserved: checks.native_resume_custom_state, recent_read_preserved: checks.native_resume_recent_read,
        unfinished_tool_replayed: existsSync(path.join(spec.fixture, 'unfinished.txt'))},
      skills: {source: 'Native resources_discover -> DefaultResourceLoader.extendResources metadata, _expandSkillCommand and registered read.',
        names: skills.skills.map(skill => skill.name), prompt_templates_loaded: fixture.loader.getPrompts().prompts.length},
      cli: {source: 'Actual bin/apex imports in bounded offline subprocesses; SDK execution and credential reads are trapped.',
        denied_statuses: cliDenied.map(result => result.status), report_status: cliReport.status,
        sdk_initializations: [...cliDenied, cliReport].reduce((total, result) => total + (result.guard?.sdkLoads ?? 0), 0)},
      evidence: {transcript: 'Script-seeded user/assistant records; actual Pi native command handlers, definitions and hooks, no model completion.',
        nested: 'Actual createToolContext.executeTool uses native nested callable-tool validation and tool hooks; model-disabled direct write is refused by native validation.',
        eval: 'Actual eval session startup/before_agent_start with learnings path I/O traps; tool absent from registry/callable set.',
        discovery: 'Explicit fixture context and isolated package manager; selected project skill paths only.',
        accounting: 'Synthetic seeded token/cost fields are labeled fixtures, not claims about provider spend or benchmark performance.'},
      extension_errors: shared.extension_errors};
  } finally {
    // dispose may already have run before the native reopen stage.
    if (session.extensionRunner?.active !== false) {try {await fixture.dispose();} catch {}}
  }
}

async function childMain(spec) {
  const calls = counters(), discovery = {attempts: 0};
  const observed = {stage: 'guards', suppressed_local_refreshes: 0};
  // Without live builtins (LIVE_BUILTINS preload) the fs/network guards would miss Pi's and Apex's named imports
  // and the gate could pass vacuously.
  if (!liveBuiltinsLoaded()) return {failure: 'live_builtins_unavailable', failure_stage: observed.stage,
    attempted_calls: calls, resource_discovery_attempts: 0};
  denyExternal(calls);
  denyAmbientDiscovery(spec.fixture, discovery);
  const environmentSanitized = process.env.PI_OFFLINE === '1' &&
    process.env.PI_CODING_AGENT_DIR === path.join(spec.fixture, 'agent') &&
    environmentNamesAllowed(permittedEnv, process.env, process.platform, spec.fixture);
  try {
    if (spec.fixtureMode === 'interrupted-fixture') {
      await mkdir(path.join(spec.fixture, 'owned-interrupted'));
      throw Error('fixture_interrupted');
    }
    observed.stage = 'sdk';
    const pi = await import('@earendil-works/pi-coding-agent');
    const version = JSON.parse(await readFile(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8')).version;
    if (version !== PINNED_PI_VERSION) throw Error('unexpected_pi_version');
    const runtime = await offlineRuntime(pi, calls, observed, spec.selection);
    // Pi's own tool-declaration helpers (pi-ai is Pi's exact-pinned dependency, hoisted by the lock).
    const ai = await import('@earendil-works/pi-ai');
    const shared = {...runtime, ai, calls, registered_flags: new Map(), session_starts: 0, extension_errors: [], tool_events: [],
      deferred_executions: 0, structured_results_preserved: true};
    observed.stage = 'native_session';
    const result = await nativeFixture(pi, spec, shared, observed);
    return {...result, pi_version: version, environment_sanitized: environmentSanitized,
      attempted_calls: calls, resource_discovery_attempts: discovery.attempts};
  } catch (error) {
    const safeCodes = new Set(['fixture_interrupted', 'unexpected_pi_version', 'physical_model_contract_missing',
      'fixture_extension_failed_to_load', 'resource_discovery_contract_missing', 'offline_resource_discovery_denied',
      'offline_network_denied', 'offline_auth_denied', 'offline_credentials_denied', 'offline_inference_denied',
      'native_session_file_missing', 'fixture_git_failed']);
    const safePrefix = /^(?:fixture_command_missing|fixture_native_tool_missing|fixture_tool_failed):[a-z0-9_-]+$/;
    return {failure: safeCodes.has(error.message) || safePrefix.test(error.message) ? error.message : 'offline_phase3_fixture_operation_failed',
      failure_stage: observed.stage, failure_code: error.code ?? null,
      environment_sanitized: environmentSanitized, attempted_calls: calls, resource_discovery_attempts: discovery.attempts};
  }
}

async function runChild(spec) {
  const env = {...fixtureEnvironment(permittedEnv, spec.fixture), PI_OFFLINE: '1', PI_CODING_AGENT_DIR: path.join(spec.fixture, 'agent'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0'};
  env.PATH = [path.dirname(process.execPath), path.join(root, '.tools/bin'), env.PATH].filter(Boolean).join(path.delimiter);
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--preload', LIVE_BUILTINS, script, '--phase3-micro-child', JSON.stringify(spec)],
      {cwd: spec.fixture, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', bytes = 0, exceeded = false;
    const terminate = () => {
      if (!child.pid) return;
      try {process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL');} catch {}
    };
    const timer = setTimeout(terminate, 30000);
    const count = chunk => {bytes += chunk.length; if (bytes > 196608) {exceeded = true; terminate();}};
    child.stdout.on('data', chunk => {count(chunk); if (!exceeded) stdout += chunk;});
    child.stderr.on('data', count);
    child.once('error', () => {clearTimeout(timer); terminate(); resolve({failure: 'child_spawn_failed'});});
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      // Only a fresh detached child group allocated by this function is signaled.
      // This also covers its bounded Git subprocesses on a fault/deadline.
      terminate();
      if (signal || exceeded) return resolve({failure: 'child_failed_or_timed_out'});
      try {
        const result = JSON.parse(stdout);
        if (status !== 0 && !result.failure) result.failure = 'child_failed';
        resolve(result);
      } catch {resolve({failure: 'invalid_child_report'});}
    });
  });
}

export async function runPhase3Micro({fixtureMode = 'success', selection = 'muse'} = {}) {
  if (!['muse', 'windows'].includes(selection)) throw Error('unknown_model_selection');
  if (selection === 'windows' && process.platform !== 'win32') throw Error('windows_micro_requires_native_windows');
  const windows = selection === 'windows' ? await import('../lib/windows-target.mjs') : undefined;
  if (!['success', 'missing-plan-gate', 'ambient-discovery', 'interrupted-fixture'].includes(fixtureMode)) throw Error('unknown_fixture_mode');
  const artifact = {kind: windows ? 'offline_windows_default_contract' : 'offline_phase3_contract',
    status: 'FAIL', model: windows?.WINDOWS_MODEL ?? modelName, thinking_level: windows?.WINDOWS_THINKING ?? 'xhigh',
    transcript_source: 'Script-seeded native commands/tools/resources/session boundaries; no model completion.',
    model_performance_measured: false, provider_calls: 0, benchmark_runs: 0, network_attempts: 0, transport_attempts: 0,
    resource_discovery_attempts: 0, attempted_calls: counters(), checks: {},
    cleanup: {fixture_removed: false, owned_processes_removed: true}};
  const fixture = await mkdtemp(path.join(os.tmpdir(), windows ? 'windows default ç-' : 'phase3-micro-'));
  artifact.fixture = fixture;
  try {
    const result = await runChild({fixture, fixtureMode, selection});
    Object.assign(artifact, result);
    artifact.checks = {...result.checks, environment_sanitized: result.environment_sanitized === true,
      no_ambient_discovery: result.resource_discovery_attempts === 0};
    delete artifact.environment_sanitized;
    if (!artifact.failure && Object.values(artifact.checks).every(value => value === true) && allZero(artifact.attempted_calls)) artifact.status = 'PASS';
    else artifact.failure ??= 'offline_phase3_contract_failed';
  } catch {artifact.failure ??= 'offline_phase3_fixture_failed';}
  finally {
    try {await rm(fixture, {recursive: true, force: true});}
    catch {artifact.status = 'FAIL'; artifact.failure = 'fixture_cleanup_failed';}
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
    if (process.argv[2] === '--phase3-micro-child') result = await childMain(JSON.parse(process.argv[3]));
    else {
      if (process.argv.slice(2).some(arg => arg !== '--windows-default') || process.argv.length > 3) throw Error('unknown_micro_argument');
      result = await runPhase3Micro({selection: process.argv[2] === '--windows-default' ? 'windows' : 'muse'});
    }
  } catch {result = {kind: 'offline_phase3_contract', status: 'FAIL', failure: 'phase3_micro_cli_failed'};}
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'FAIL' || result.failure) process.exitCode = 1;
}
