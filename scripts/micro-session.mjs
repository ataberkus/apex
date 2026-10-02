import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs, { existsSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This fixture checks native transcript mechanics, never model performance.
// Importing it allocates nothing and imports no Pi/provider implementation.
const script = fileURLToPath(import.meta.url);
const modelId = 'meta/muse-spark-1.3-contributor';
const modelName = `openrouter/${modelId}`;
export const WINDOWS_FIXTURE_ENV = Object.freeze([
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'SYSTEMDRIVE', 'USERNAME', 'USERDOMAIN', 'LOGONSERVER', 'PATHEXT',
]);
const permittedEnv = ['PATH', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'PI_OFFLINE',
  ...(process.platform === 'win32' ? WINDOWS_FIXTURE_ENV : [])];
const counters = () => ({network: 0, auth: 0, inference: 0, credentials: 0});
const text = message => typeof message.content === 'string' ? message.content :
  (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');

// Windows environment names are case-insensitive, including injected SYSTEMROOT.
// Emit canonical whitelist names so Path/PATH cannot compete in a child spawn.
export function whitelistedEnvironment(names, source = process.env, platform = process.platform) {
  const env = {};
  for (const name of names) {
    const key = platform === 'win32' ?
      Object.keys(source).find(key => key.toUpperCase() === name.toUpperCase()) : name;
    if (key !== undefined && source[key] !== undefined) env[name] = source[key];
  }
  return env;
}

export function fixtureEnvironment(names, fixture, source = process.env, platform = process.platform) {
  const env = whitelistedEnvironment(names, source, platform);
  if (platform === 'win32') {
    const root = path.win32.parse(fixture).root;
    // Windows launchers may inject account/profile defaults. Supply empty account
    // metadata and a real confined home rather than admitting the user's profile.
    Object.assign(env, {TEMP:fixture, TMP:fixture, HOME:fixture, USERPROFILE:fixture,
      HOMEDRIVE:root.slice(0, -1), HOMEPATH:fixture.slice(root.length - 1),
      SYSTEMDRIVE:path.win32.parse(env.SystemRoot ?? 'C:\\Windows').root.slice(0, -1),
      USERNAME:'', USERDOMAIN:'', LOGONSERVER:'', PATHEXT:'.COM;.EXE;.BAT;.CMD'});
  }
  return env;
}

export function environmentNamesAllowed(names, source = process.env, platform = process.platform, fixture) {
  const normalize = name => platform === 'win32' ? name.toUpperCase() : name;
  const allowed = new Set(names.map(normalize));
  if (!Object.keys(source).every(name => allowed.has(normalize(name)))) return false;
  if (platform !== 'win32' || fixture === undefined) return true;
  const actual = whitelistedEnvironment(WINDOWS_FIXTURE_ENV, source, platform);
  const expected = fixtureEnvironment(names, fixture, source, platform);
  return WINDOWS_FIXTURE_ENV.every(name => actual[name] === expected[name]);
}

export function fixtureShellPath() {
  if (process.platform !== 'win32') return undefined;
  const env = whitelistedEnvironment(['PATH']);
  const candidates = (env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute).flatMap(dir =>
    [path.join(dir, 'bash.exe'), path.resolve(dir, '../bin/bash.exe')]);
  return candidates.find(file => !/(?:^|[\\/])\.(?:agents|pi)(?:[\\/]|$)/i.test(file) &&
    !/[\\/]Windows[\\/](?:System32|Sysnative)[\\/]bash\.exe$/i.test(file) && existsSync(file));
}

function denyExternal(calls) {
  const deny = () => { calls.network++; throw new Error('offline_network_denied'); };
  globalThis.fetch = deny;
  if ('WebSocket' in globalThis) globalThis.WebSocket = class { constructor() { deny(); } };
  http.request = http.get = https.request = https.get = deny;
  http.Agent.prototype.createConnection = https.Agent.prototype.createConnection = deny;
  net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = deny;
  syncBuiltinESMExports();
}

function denyAmbientDiscovery(fixture, discovery) {
  const inside = file => typeof file === 'string' &&
    (path.resolve(file) === fixture || path.resolve(file).startsWith(`${fixture}${path.sep}`));
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
      owner[name] = (file, ...args) => { guard(file); return original(file, ...args); };
    }
  }
  syncBuiltinESMExports();
}

function denyRuntime(runtime, calls) {
  const deny = kind => () => { calls[kind]++; throw new Error(`offline_${kind}_denied`); };
  for (const owner of [runtime, runtime.models]) {
    for (const name of ['getAuth', 'checkAuth', 'getApiKey']) {
      if (typeof owner[name] === 'function') owner[name] = deny('auth');
    }
    for (const name of ['stream', 'complete', 'streamSimple', 'completeSimple', 'streamDeferred']) {
      if (typeof owner[name] === 'function') owner[name] = deny('inference');
    }
  }
  runtime.refresh = deny('auth');
  return deny('inference');
}

function lastFixtureState(manager) {
  return manager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === 'offline-fixture-state')?.data;
}

async function offlineRuntime(pi, calls) {
  const denyCredentials = () => { calls.credentials++; throw new Error('offline_credentials_denied'); };
  const runtime = await pi.ModelRuntime.create({credentials: {
    read: denyCredentials, list: denyCredentials, modify: denyCredentials, delete: denyCredentials,
  }, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false});
  const denyInference = denyRuntime(runtime, calls);
  const model = runtime.getPhysicalModel('openrouter', modelId);
  if (!model || model.thinkingLevelMap?.xhigh !== 'xhigh') throw new Error('physical_model_contract_missing');
  return {runtime, model, denyInference};
}

function fixtureLoader(pi, spec, settings, extensionFactories = []) {
  settings.setProjectTrusted(false);
  const loader = new pi.DefaultResourceLoader({cwd: spec.fixture, agentDir: path.join(spec.fixture, 'agent'),
    additionalSkillPaths: spec.fixtureMode === 'ambient-discovery' ?
      [path.join(path.dirname(spec.fixture), '.agents', 'skills')] : [],
    settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true, systemPrompt: 'Deterministic offline session fixture.',
    appendSystemPrompt: [], extensionFactories});
  // The no* flags are applied AFTER DefaultPackageManager.resolve(), which
  // otherwise scans home/ancestor skills. Replace only this test discovery boundary.
  if (spec.fixtureMode !== 'ambient-discovery') {
    if (typeof loader.packageManager?.resolve !== 'function' ||
      typeof loader.packageManager?.resolveExtensionSources !== 'function') throw new Error('resource_discovery_contract_missing');
    const empty = async () => ({extensions: [], skills: [], prompts: [], themes: []});
    loader.packageManager.resolve = empty;
    loader.packageManager.resolveExtensionSources = empty;
  }
  return loader;
}

async function childCreate(spec, calls) {
  const pi = await import('@earendil-works/pi-coding-agent');
  const packagePath = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url));
  const version = JSON.parse(await readFile(packagePath, 'utf8')).version;
  if (version !== '0.99.2') throw new Error('unexpected_pi_version');
  const {runtime, model, denyInference} = await offlineRuntime(pi, calls);
  const manager = pi.SessionManager.create(spec.fixture, path.join(spec.fixture, 'sessions'));
  manager.appendModelChange(model.provider, model.id);
  manager.appendThinkingLevelChange('xhigh');
  const timestamp = Date.now();
  const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
  const assistant = (content, stopReason = 'stop') => ({role: 'assistant', content,
    api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp});
  manager.appendMessage({role: 'user', content: 'OLD_FIXTURE: exercise read/write/edit bookkeeping.', timestamp});
  await writeFile(path.join(spec.fixture, 'read-only.txt'), 'read fixture\n');
  await writeFile(path.join(spec.fixture, 'changed.txt'), 'before\n');
  const tools = {
    read: pi.createReadTool(spec.fixture), write: pi.createWriteTool(spec.fixture), edit: pi.createEditTool(spec.fixture),
  };
  const operations = [
    ['read', {path: 'read-only.txt'}],
    ['write', {path: 'new.txt', content: 'new fixture\n'}],
    ['edit', {path: 'changed.txt', edits: [{oldText: 'before', newText: 'after'}]}],
    ['read', {path: 'changed.txt'}],
  ];
  for (const [index, [name, args]] of operations.entries()) {
    const id = `fixture-tool-${index}`;
    manager.appendMessage(assistant([{type: 'toolCall', id, name, arguments: args}], 'toolUse'));
    const result = await tools[name].execute(id, args, undefined, undefined);
    if (result.isError) throw new Error('fixture_tool_failed');
    manager.appendMessage({role: 'toolResult', toolCallId: id, toolName: name,
      content: result.content, details: result.details, structuredContent: result.structuredContent,
      isError: false, timestamp});
  }
  const branchPoint = manager.getLeafId();
  const abandonedId = manager.appendCustomEntry('offline-fixture-state', {branch: 'abandoned', todo: 'discard'});
  manager.branch(branchPoint);
  const activeId = manager.appendCustomEntry('offline-fixture-state', {branch: 'active', todo: 'preserve-fixture'});
  manager.appendMessage({role: 'user', content: `RECENT_USER: ${'retain this fixture context. '.repeat(100)}`, timestamp});
  const recentAssistantId = manager.appendMessage(assistant([{type: 'text', text: 'RECENT_ASSISTANT: fixture context retained.'}]));
  const beforeBranch = manager.getBranch().map(entry => entry.id);
  const beforeLeaf = manager.getLeafId();
  const observed = {hook_calls: 0, success_events: 0, hook_error: false};
  const settings = pi.SettingsManager.inMemory({compaction: {enabled: false, keepRecentTokens: 96, reserveTokens: 256},
    cacheWarming: 'off', retry: {enabled: false, maxRetries: 0}, packages: [], extensions: []});
  const factory = extension => {
    extension.on('session_before_compact', event => {
      observed.hook_calls++;
      try {
        if (spec.fixtureMode === 'cancel') return {cancel: true};
        const preparation = event.preparation;
        if (event.reason !== 'manual' || event.willRetry || event.signal.aborted ||
          !event.branchEntries.some(entry => entry.id === preparation.firstKeptEntryId)) return {cancel: true};
        const modified = new Set([...preparation.fileOps.written, ...preparation.fileOps.edited]);
        const readFiles = [...preparation.fileOps.read].filter(file => !modified.has(file)).sort();
        const modifiedFiles = [...modified].sort();
        const contract = spec.fixtureMode === 'omit-contract' ? '' : 'CONTRACT: ONLY_MUSE_XHIGH; TODO: preserve-fixture';
        return {compaction: {summary: `OFFLINE_FIXTURE_SUMMARY:${spec.marker}\n${contract}\n` +
          `<read-files>\n${readFiles.join('\n')}\n</read-files>\n<modified-files>\n${modifiedFiles.join('\n')}\n</modified-files>`,
        firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore,
        details: {readFiles, modifiedFiles, marker: spec.marker, deterministicFixture: true}}};
      } catch { observed.hook_error = true; return {cancel: true}; }
    });
    extension.on('session_compact', event => {
      if (event.fromExtension && event.reason === 'manual' && !event.willRetry) observed.success_events++;
    });
  };
  const loader = fixtureLoader(pi, spec, settings, spec.fixtureMode === 'missing-hook' ? [] : [factory]);
  await loader.reload();
  if (loader.getExtensions().errors.length) throw new Error('fixture_extension_failed_to_load');
  const {session} = await pi.createAgentSession({cwd: spec.fixture, agentDir: path.join(spec.fixture, 'agent'),
    modelRuntime: runtime, model, thinkingLevel: 'xhigh', settingsManager: settings,
    sessionManager: manager, resourceLoader: loader, noTools: 'all', tools: []});
  if (session.thinkingLevel !== 'xhigh' || session.model?.provider !== 'openrouter' || session.model?.id !== modelId) {
    session.dispose();
    throw new Error('effective_physical_model_contract_failed');
  }
  session.agent.streamFunction = denyInference;
  let cancelled = false;
  try { await session.compact('Deterministic fixture summary only; no inference.'); }
  catch (error) { if (error.message === 'Compaction cancelled') cancelled = true; else throw error; }
  finally { session.dispose(); }
  const compactions = manager.getEntries().filter(entry => entry.type === 'compaction');
  const entry = compactions.at(-1);
  const context = manager.buildSessionContext();
  const checks = {
    native_compaction: !cancelled && observed.hook_calls === 1 && observed.success_events === 1 &&
      !observed.hook_error && compactions.length === 1 && entry.fromHook === true && entry.parentId === beforeLeaf,
    recent_context_preserved: context.messages.some(message => text(message).startsWith('RECENT_USER:')) &&
      context.messages.some(message => text(message).startsWith('RECENT_ASSISTANT:')) &&
      !context.messages.some(message => text(message).startsWith('OLD_FIXTURE:')),
    summary_contract_preserved: entry?.summary.includes('CONTRACT: ONLY_MUSE_XHIGH; TODO: preserve-fixture') === true,
    branch_state_preserved: lastFixtureState(manager)?.branch === 'active' &&
      manager.getBranch().some(value => value.id === activeId) &&
      !manager.getBranch().some(value => value.id === abandonedId) &&
      manager.getEntries().some(value => value.id === abandonedId) &&
      beforeBranch.every(id => manager.getBranch().some(value => value.id === id)),
    builtin_file_results_verified: await readFile(path.join(spec.fixture, 'changed.txt'), 'utf8') === 'after\n' &&
      await readFile(path.join(spec.fixture, 'new.txt'), 'utf8') === 'new fixture\n',
  };
  const expected = {file: manager.getSessionFile(), sessionId: manager.getSessionId(),
    leafId: manager.getLeafId(), branchIds: manager.getBranch().map(value => value.id),
    context: context.messages, details: entry?.details, model: context.model, thinkingLevel: context.thinkingLevel,
    activeId, abandonedId, recentAssistantId};
  await writeFile(path.join(spec.fixture, 'expected.json'), JSON.stringify(expected));
  return {pi_version: version, checks, cancelled, compaction: {entry_count: compactions.length,
    read_files: entry?.details?.readFiles ?? [], modified_files: entry?.details?.modifiedFiles ?? [],
    deterministic_summary_only: true, inferred_summary: false}};
}

async function childReopen(spec, calls) {
  const pi = await import('@earendil-works/pi-coding-agent');
  const expected = JSON.parse(await readFile(path.join(spec.fixture, 'expected.json'), 'utf8'));
  const manager = pi.SessionManager.open(expected.file, path.join(spec.fixture, 'sessions'), spec.fixture);
  const context = manager.buildSessionContext();
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const intact = manager.getSessionId() === expected.sessionId && manager.getLeafId() === expected.leafId &&
    same(manager.getBranch().map(entry => entry.id), expected.branchIds) && same(context.messages, expected.context) &&
    same(context.model, expected.model) && context.thinkingLevel === 'xhigh' &&
    same(manager.getEntry(expected.leafId)?.details, expected.details) &&
    lastFixtureState(manager)?.branch === 'active' && !manager.getBranch().some(entry => entry.id === expected.abandonedId);
  if (spec.phase === 'recover') {
    const content = await readFile(expected.file, 'utf8');
    const malformedRetained = content.includes('TORN_FIXTURE_FRAGMENT') && content.endsWith('\n');
    const beforeAppend = manager.getEntries().length;
    const recoveryId = manager.appendCustomEntry('offline-recovery-checkpoint', {recovered: true});
    await writeFile(path.join(spec.fixture, 'recovery.json'), JSON.stringify({recoveryId, beforeAppend}));
    return {partial_tail_recovery: intact && malformedRetained,
      malformed_fragment_retained: malformedRetained, malformed_fragment_reconstructed: false,
      power_loss_durability_tested: false};
  }
  if (spec.phase === 'verify') {
    const recovery = JSON.parse(await readFile(path.join(spec.fixture, 'recovery.json'), 'utf8'));
    const entry = manager.getEntry(recovery.recoveryId);
    return {append_after_recovery: entry?.type === 'custom' && entry.customType === 'offline-recovery-checkpoint' &&
      entry.parentId === expected.leafId && manager.getLeafId() === recovery.recoveryId &&
      manager.getEntries().length === recovery.beforeAppend + 1 && same(context.messages, expected.context),
      malformed_fragment_retained: (await readFile(expected.file, 'utf8')).includes('TORN_FIXTURE_FRAGMENT')};
  }
  const {runtime, model, denyInference} = await offlineRuntime(pi, calls);
  const settings = pi.SettingsManager.inMemory({compaction: {enabled: false}, cacheWarming: 'off',
    retry: {enabled: false, maxRetries: 0}, packages: [], extensions: []});
  const loader = fixtureLoader(pi, spec, settings);
  await loader.reload();
  const {session} = await pi.createAgentSession({cwd: spec.fixture, agentDir: path.join(spec.fixture, 'agent'),
    modelRuntime: runtime, model, thinkingLevel: 'xhigh', settingsManager: settings,
    sessionManager: manager, resourceLoader: loader, noTools: 'all', tools: []});
  session.agent.streamFunction = denyInference;
  try {
    return {fresh_process_reopen: intact, fresh_sdk_restore:
      same(session.messages, expected.context) && same(session.agent.state.messages, expected.context) &&
      session.thinkingLevel === 'xhigh' && session.model.provider === 'openrouter' && session.model.id === modelId &&
      manager.getLeafId() === expected.leafId && lastFixtureState(manager)?.todo === 'preserve-fixture'};
  } finally { session.dispose(); }
}

async function childMain(spec) {
  const calls = counters();
  const discovery = {attempts: 0};
  denyExternal(calls);
  denyAmbientDiscovery(spec.fixture, discovery);
  const environment_sanitized = environmentNamesAllowed(permittedEnv, process.env, process.platform, spec.fixture);
  try {
    const result = spec.phase === 'create' ? await childCreate(spec, calls) : await childReopen(spec, calls);
    return {...result, environment_sanitized, attempted_calls: calls, resource_discovery_attempts: discovery.attempts};
  } catch (error) {
    const safeCodes = new Set(['unexpected_pi_version', 'physical_model_contract_missing',
      'effective_physical_model_contract_failed', 'fixture_tool_failed', 'fixture_extension_failed_to_load',
      'offline_credentials_denied', 'offline_auth_denied', 'offline_inference_denied', 'offline_network_denied',
      'offline_resource_discovery_denied', 'resource_discovery_contract_missing']);
    const failure = safeCodes.has(error.message) ? error.message :
      Object.values(calls).some(value => value > 0) ? 'blocked_external_attempt' : 'offline_fixture_operation_failed';
    return {failure, environment_sanitized, attempted_calls: calls, resource_discovery_attempts: discovery.attempts};
  }
}

async function runChild(spec) {
  const env = {...fixtureEnvironment(permittedEnv, spec.fixture), PI_OFFLINE: '1'};
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, '--session-micro-child', JSON.stringify(spec)],
      {cwd: spec.fixture, env, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', outputExceeded = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdout.on('data', value => {
      stdout += value;
      if (stdout.length > 65536) { outputExceeded = true; child.kill('SIGKILL'); }
    });
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); resolve({failure: 'child_spawn_failed'}); });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      if (signal || outputExceeded) return resolve({failure: 'child_failed_or_timed_out'});
      try {
        const report = JSON.parse(stdout);
        if (status !== 0 && !report.failure) report.failure = 'child_failed';
        resolve(report);
      } catch { resolve({failure: 'invalid_child_report'}); }
    });
  });
}

export async function runSessionMicro({fixtureMode = 'success'} = {}) {
  if (!['success', 'cancel', 'omit-contract', 'missing-hook', 'ambient-discovery'].includes(fixtureMode)) throw new Error('unknown_fixture_mode');
  const artifact = {kind: 'offline_session_contract', status: 'FAIL', model: modelName, thinking_level: 'xhigh',
    transcript_source: 'script-seeded assistant tool calls with actual native built-in tool results',
    summary_source: 'deterministic local extension fixture', model_performance_measured: false,
    provider_calls: 0, benchmark_runs: 0, network_attempts: 0, transport_attempts: 0, resource_discovery_attempts: 0,
    attempted_calls: counters(), checks: {}, cleanup: {fixture_removed: false}};
  const fixture = await mkdtemp(path.join(process.cwd(), 'session-micro-'));
  artifact.fixture = fixture;
  const spec = {fixture, fixtureMode, marker: randomUUID()};
  const absorb = result => {
    for (const key of Object.keys(artifact.attempted_calls)) artifact.attempted_calls[key] += result.attempted_calls?.[key] ?? 0;
    artifact.network_attempts = artifact.attempted_calls.network;
    artifact.transport_attempts = artifact.attempted_calls.inference;
    artifact.resource_discovery_attempts += result.resource_discovery_attempts ?? 0;
    artifact.checks.no_ambient_discovery = artifact.resource_discovery_attempts === 0;
    artifact.checks.environment_sanitized = artifact.checks.environment_sanitized !== false && result.environment_sanitized === true;
    if (result.failure) artifact.failure = result.failure;
  };
  try {
    const created = await runChild({...spec, phase: 'create'});
    absorb(created);
    Object.assign(artifact.checks, created.checks);
    artifact.pi_version = created.pi_version;
    artifact.compaction = created.compaction;
    if (created.cancelled) artifact.failure = 'compaction_cancelled';
    if (artifact.failure) return artifact;
    const reopened = await runChild({...spec, phase: 'reopen'});
    absorb(reopened);
    artifact.checks.fresh_process_reopen = reopened.fresh_process_reopen === true;
    artifact.checks.fresh_sdk_restore = reopened.fresh_sdk_restore === true;
    const expected = JSON.parse(await readFile(path.join(fixture, 'expected.json'), 'utf8'));
    await appendFile(expected.file, '{"type":"message","id":"TORN_FIXTURE_FRAGMENT"');
    const recovered = await runChild({...spec, phase: 'recover'});
    absorb(recovered);
    artifact.checks.partial_tail_recovery = recovered.partial_tail_recovery === true;
    artifact.recovery = {malformed_fragment_retained: recovered.malformed_fragment_retained === true,
      malformed_fragment_reconstructed: false, power_loss_durability_tested: false,
      scope: 'fresh-process transcript/state recovery; no in-flight tool or provider-stream continuation'};
    const verified = await runChild({...spec, phase: 'verify'});
    absorb(verified);
    artifact.checks.append_after_recovery = verified.append_after_recovery === true;
    const required = ['native_compaction', 'recent_context_preserved', 'summary_contract_preserved', 'branch_state_preserved',
      'builtin_file_results_verified', 'fresh_process_reopen', 'fresh_sdk_restore', 'partial_tail_recovery',
      'append_after_recovery', 'environment_sanitized', 'no_ambient_discovery'];
    if (!artifact.failure && required.every(key => artifact.checks[key] === true) &&
      Object.values(artifact.attempted_calls).every(value => value === 0)) artifact.status = 'PASS';
    else artifact.failure ??= 'offline_session_contract_failed';
  } catch { artifact.failure ??= 'offline_session_fixture_failed'; }
  finally {
    try { await rm(fixture, {recursive: true, force: true}); }
    catch { artifact.status = 'FAIL'; artifact.failure = 'fixture_cleanup_failed'; }
    artifact.cleanup.fixture_removed = !existsSync(fixture);
  }
  return artifact;
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  let result;
  try {
    result = process.argv[2] === '--session-micro-child' ?
      await childMain(JSON.parse(process.argv[3])) : await runSessionMicro();
  } catch { result = {kind: 'offline_session_contract', status: 'FAIL', failure: 'session_micro_cli_failed'}; }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'FAIL' || result.failure) process.exitCode = 1;
}
