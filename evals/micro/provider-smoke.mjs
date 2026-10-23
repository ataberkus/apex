import {appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {PI_VERSION} from '../../lib/launcher.mjs';

export const SMOKE_MODEL = 'meta/muse-spark-1.3-contributor';
const PROVIDER = 'openrouter';
const BASE_URL = 'https://openrouter.ai/api/v1';
const RESPONSE_MODELS = new Set([SMOKE_MODEL, 'meta/muse-spark-1.3-contributor-20260902']);
const DEFAULT_MAX_REQUESTS = 4;
const PROFILE_SPEND_CAPS = new Map([[4, 0.02], [6, 0.03]]);
const MAX_PAYLOAD_BYTES = 32768;
const MAX_OUTPUT_TOKENS = 6144;
const PROTOCOL_TOKENS_PER_REQUEST = 4096;
const TOTAL_TIMEOUT_MS = 120000;
const TOOL_NAMES = ['read', 'edit', 'write', 'bash'];
export const VERIFICATION_COMMAND = 'bun -e \'const fs=require("node:fs"); const assert=require("node:assert/strict"); ' +
  'assert.equal(fs.readFileSync("sample.txt","utf8"),"alpha\\ndelta\\ngamma\\n"); ' +
  'assert.deepEqual(JSON.parse(fs.readFileSync("summary.json","utf8")),{lines:3,second:"delta"}); ' +
  'console.log("APEX_SMOKE_VERIFIED");\'';

function fail(code) { throw new Error(code); }
function validateModel(model) {
  if (model?.type !== 'chat' || model.provider !== PROVIDER || model.id !== SMOKE_MODEL ||
      model.api !== 'openai-completions' || model.baseUrl !== BASE_URL) fail('model_mismatch');
}
function validateRequestProfile(maxRequests, maxSpendUsd) {
  if (!PROFILE_SPEND_CAPS.has(maxRequests)) fail('request_profile_invalid');
  if (!Number.isFinite(maxSpendUsd) || maxSpendUsd <= 0 || maxSpendUsd > PROFILE_SPEND_CAPS.get(maxRequests)) fail('budget_invalid');
}

/** Current execution permission, independent of a historical budget or credential. */
export function assertPaidRunAuthorized(config, ledger, {runId, maxSpendUsd}) {
  if (config?.paid_runs_enabled !== true || config.execution_policy === 'offline-only') fail('paid_runs_disabled');
  const selected = `${PROVIDER}/${SMOKE_MODEL}`;
  if (config.main_model !== selected || config.fast_model !== selected || config.thinking_level !== 'xhigh' ||
      !Array.isArray(config.allowed_models) || config.allowed_models.length !== 1 || config.allowed_models[0] !== selected) fail('paid_model_policy_invalid');
  const amount = value => Number.isFinite(value) && value >= 0;
  if (!amount(config.budget_cap_usd) || config.budget_cap_usd === 0 ||
      ledger?.budget_cap_usd !== config.budget_cap_usd || !amount(ledger.confirmed_spend_usd) ||
      !amount(ledger.reserved_usd) || !Array.isArray(ledger.reservations)) fail('paid_budget_invalid');
  const active = ledger.reservations.filter(item => item?.status === 'reserved');
  if (active.some(item => !amount(item.reserved_usd) || item.reserved_usd === 0)) fail('paid_budget_invalid');
  const reserved = active.reduce((sum, item) => sum + item.reserved_usd, 0);
  if (Math.abs(reserved - ledger.reserved_usd) > 1e-12 ||
      ledger.confirmed_spend_usd + reserved > config.budget_cap_usd + 1e-12) fail('paid_budget_invalid');
  const matches = active.filter(item => item.run_id === runId);
  if (!amount(maxSpendUsd) || maxSpendUsd === 0 || matches.length !== 1 ||
      matches[0].model !== selected || matches[0].reserved_usd < maxSpendUsd) fail('paid_reservation_invalid');
}

function checkPaidRunPolicy(projectRoot, options) {
  let config;
  let ledger;
  try { config = JSON.parse(readFileSync(join(resolve(projectRoot), 'evals', 'config.json'), 'utf8')); }
  catch { fail('paid_policy_unavailable'); }
  // Refuse free mode without touching credentials, SDK state or even the ledger.
  if (config?.paid_runs_enabled !== true || config.execution_policy === 'offline-only') fail('paid_runs_disabled');
  try { ledger = JSON.parse(readFileSync(join(resolve(projectRoot), 'evals', 'spend.json'), 'utf8')); }
  catch { fail('paid_policy_unavailable'); }
  assertPaidRunAuthorized(config, ledger, options);
}

/** Pure request policy; wrapFetch counts physical sends, including failed HTTP responses. */
export function createRequestGuard({model, maxSpendUsd, maxRequests = DEFAULT_MAX_REQUESTS}) {
  validateModel(model);
  validateRequestProfile(maxRequests, maxSpendUsd);
  for (const component of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    if (!Number.isFinite(model.cost?.[component]) || model.cost[component] < 0) fail('catalog_price_unknown');
  }
  // UTF-8 bytes bound text token count conservatively; protocol overhead and reasoning
  // are covered separately. This is a catalog token estimate, not an invoice guarantee.
  const inputRate = Math.max(model.cost.input, model.cost.cacheRead, model.cost.cacheWrite);
  const reservedUpperBoundUsd = maxRequests *
    ((MAX_PAYLOAD_BYTES + PROTOCOL_TOKENS_PER_REQUEST) * inputRate + MAX_OUTPUT_TOKENS * model.cost.output) / 1e6;
  if (reservedUpperBoundUsd > maxSpendUsd) fail('budget_insufficient');
  let sentRequests = 0;
  const responseModels = new Set();
  const sends = [];
  const blockedReasons = new Set();
  function block(code) { blockedReasons.add(code); fail(code); }
  function validatePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) block('payload_invalid');
    if (payload.model !== SMOKE_MODEL) block('model_mismatch');
    for (const key of ['models', 'route', 'fallback', 'fallbacks']) {
      if (Object.hasOwn(payload, key)) block('fallback_forbidden');
    }
    if (payload.stream !== true || payload.stream_options?.include_usage !== true) block('usage_required');
    if (payload.reasoning?.effort !== 'xhigh') block('thinking_effort_mismatch');
    const limits = [payload.max_tokens, payload.max_completion_tokens].filter(value => value !== undefined);
    if (limits.length !== 1 || !Number.isInteger(limits[0]) || limits[0] <= 0 || limits[0] > MAX_OUTPUT_TOKENS) block('output_limit');
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PAYLOAD_BYTES) block('payload_limit');
  }
  return {
    maxRequests, maxPayloadBytes: MAX_PAYLOAD_BYTES, reservedUpperBoundUsd,
    get sentRequests() { return sentRequests; },
    get responseModels() { return [...responseModels]; },
    get sends() { return [...sends]; },
    get blockedReasons() { return [...blockedReasons]; },
    validateModel(model) { try { validateModel(model); } catch { block('model_mismatch'); } },
    validatePayload,
    observeResponseModel(id) {
      if (!RESPONSE_MODELS.has(id)) block('response_model_mismatch');
      responseModels.add(id);
    },
    wrapFetch(transport) {
      return async (input, init) => {
        const isRequest = input instanceof Request;
        const url = isRequest ? input.url : String(input);
        const method = String(init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
        if (url !== `${BASE_URL}/chat/completions` || method !== 'POST') block('endpoint_forbidden');
        const body = init?.body ?? (isRequest ? await input.clone().text() : undefined);
        if (typeof body !== 'string') block('payload_invalid');
        const bytes = Buffer.byteLength(body, 'utf8');
        if (bytes > MAX_PAYLOAD_BYTES) block('payload_limit');
        let payload;
        try { payload = JSON.parse(body); } catch { block('payload_invalid'); }
        validatePayload(payload);
        if (sentRequests >= maxRequests) block('request_limit');
        sentRequests++;
        sends.push({ordinal: sentRequests, payload_bytes: bytes, thinking_effort: payload.reasoning.effort, sent_at: new Date().toISOString()});
        // A 307/308 follow would resend POST outside this counter and endpoint check.
        return transport(input, {...init, redirect: 'error'});
      };
    },
  };
}

/** Agent core reads both the iterator and result(); redact before either reaches
 * its context or SessionManager, including detached copies of mutable partials. */
export function redactProviderStream(source, credential) {
  function copy(value) {
    if (typeof value === 'string') return credential ? value.replaceAll(credential, '<redacted-api-key>') : value;
    if (Array.isArray(value)) return value.map(copy);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [copy(key), copy(entry)]));
    return value;
  }
  return {
    async *[Symbol.asyncIterator]() { for await (const event of source) yield copy(event); },
    async result() { return copy(await source.result()); },
  };
}

function validateRunOptions({runId, harnessCommit}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId ?? '') || runId === '.' || runId === '..') fail('run_id_invalid');
  if (!/^[a-fA-F0-9]{40}$/.test(harnessCommit ?? '')) fail('harness_commit_invalid');
}

const settings = {
  defaultProvider: PROVIDER, defaultModel: SMOKE_MODEL, defaultThinkingLevel: 'xhigh',
  defaultProjectTrust: 'never', enableAnalytics: false, cacheWarming: 'off',
  compaction: {enabled: false}, retry: {enabled: false, maxRetries: 0, provider: {maxRetries: 0, timeoutMs: TOTAL_TIMEOUT_MS}},
  packages: [], extensions: [], skills: [], prompts: [], themes: [],
};

async function createNativeSession({fixtureDir, agentDir, sessionsDir, signal}) {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const packageFile = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), '..', 'package.json');
  if (JSON.parse(readFileSync(packageFile, 'utf8')).version !== PI_VERSION) fail('pi_version_mismatch');
  // Never read the user's normal auth/config files; public runtime overrides supply
  // the sole credential in memory after startup checks.
  const credentials = {
    read: async () => undefined, list: async () => [],
    modify: async () => fail('credential_persistence_forbidden'), delete: async () => fail('credential_persistence_forbidden'),
  };
  const modelRuntime = await sdk.ModelRuntime.create({credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, signal});
  const model = modelRuntime.getPhysicalModel(PROVIDER, SMOKE_MODEL);
  if (!model) fail('model_not_in_pinned_catalog');
  validateModel(model);
  const settingsManager = sdk.SettingsManager.inMemory(settings);
  const resourceLoader = new sdk.DefaultResourceLoader({cwd: fixtureDir, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true});
  await resourceLoader.reload();
  const sessionManager = sdk.SessionManager.create(fixtureDir, sessionsDir);
  const result = await sdk.createAgentSession({cwd: fixtureDir, agentDir, modelRuntime, model,
    thinkingLevel: 'xhigh', tools: TOOL_NAMES, resourceLoader, settingsManager, sessionManager});
  if (result.modelFallbackMessage) { result.session.dispose(); fail('model_fallback_forbidden'); }
  const session = result.session;
  const actualTools = session.getActiveToolNames();
  if (actualTools.length !== TOOL_NAMES.length || TOOL_NAMES.some(name => !actualTools.includes(name))) {
    session.dispose(); fail('tool_configuration_mismatch');
  }
  return {session, sessionManager, modelRuntime, model};
}

function fixturePrompt(fixtureDir) {
  return `Work only in the current fixture directory ${fixtureDir}. Read sample.txt using read. ` +
    `Use edit to replace its second line beta with delta, preserving the other lines. ` +
    `Use write to create summary.json containing {"lines":3,"second":"delta"}. ` +
    `The edit and write updates are independent: issue both tool calls together in the same response after reading. ` +
    `After both updates succeed, run this exact assertion command using bash: ${VERIFICATION_COMMAND}. ` +
    `Then finish with a brief completion message. Do not access files outside this fixture directory.`;
}

function safeFailure(error) {
  const message = String(error?.message ?? '');
  if (/^paid_(runs_disabled|model_policy_invalid|budget_invalid|reservation_invalid|policy_unavailable)$/.test(message)) return message;
  return /^(model_mismatch|request_profile_invalid|budget_invalid|budget_insufficient|catalog_price_unknown|payload_invalid|fallback_forbidden|usage_required|thinking_effort_mismatch|output_limit|payload_limit|request_limit|endpoint_forbidden|response_model_mismatch|model_not_in_pinned_catalog|pi_version_mismatch|model_fallback_forbidden|tool_configuration_mismatch|api_key_missing|run_id_invalid|harness_commit_invalid|deadline_exceeded)$/.test(message)
    ? message : 'native_session_failed';
}

export function classifySmokeFailure(failure, assistants, guard) {
  if (failure === 'deadline_exceeded') return failure;
  if (guard.blockedReasons.length) return guard.blockedReasons.at(-1);
  if (failure) return failure;
  if (['error', 'aborted'].includes(assistants.at(-1)?.stopReason)) return 'native_session_failed';
  return null;
}

export function summarizeReportedReasoning(assistants, reportedByResponseId, sentRequests) {
  const billable = assistants.filter(message => (typeof message.responseId === 'string' && message.responseId.length > 0) ||
    ['input', 'output', 'cacheRead', 'cacheWrite'].some(field => message.usage?.[field] > 0));
  const complete = billable.length > 0 && billable.length === sentRequests && billable.every(message => {
    const reasoning = reportedByResponseId.get(message.responseId);
    return Number.isInteger(reasoning) && reasoning >= 0 && reasoning <= message.usage?.output;
  });
  return {thinking_tokens: complete ? billable.reduce((total, message) => total + reportedByResponseId.get(message.responseId), 0) : null,
    reasoning_reporting_complete: complete, reasoning_included_in_output: true};
}

export function evaluateSmokeFixture(fixtureDir, events, assistants, guard, failure) {
  const completed = events.filter(event => event.type === 'tool_execution_end' && !event.isError);
  const used = name => completed.some(event => event.toolName === name);
  const editIndex = events.findIndex(event => event.type === 'tool_execution_end' && event.toolName === 'edit' && !event.isError);
  const writeIndex = events.findIndex(event => event.type === 'tool_execution_end' && event.toolName === 'write' && !event.isError);
  const verifications = events.map((event, index) => ({event, index})).filter(({event, index}) =>
    event.type === 'tool_execution_start' && event.toolName === 'bash' && event.args?.command === VERIFICATION_COMMAND &&
    events.slice(index + 1).some(end => end.type === 'tool_execution_end' && end.toolName === 'bash' &&
      end.toolCallId === event.toolCallId && !end.isError));
  let sampleCorrect = false;
  let summaryCorrect = false;
  try { sampleCorrect = readFileSync(join(fixtureDir, 'sample.txt'), 'utf8') === 'alpha\ndelta\ngamma\n'; } catch {}
  try {
    const summary = JSON.parse(readFileSync(join(fixtureDir, 'summary.json'), 'utf8'));
    summaryCorrect = Object.keys(summary).length === 2 && summary.lines === 3 && summary.second === 'delta';
  } catch {}
  const final = assistants.at(-1);
  return {
    native_session_completed: !failure && final?.stopReason === 'stop', read_used: used('read'), edit_used: used('edit'), write_used: used('write'),
    bash_used: used('bash'), bash_verification_succeeded: verifications.length > 0,
    bash_after_changes: editIndex >= 0 && writeIndex >= 0 && verifications.some(({index}) => index > editIndex && index > writeIndex),
    sample_correct: sampleCorrect, summary_correct: summaryCorrect,
    final_assistant_stop: final?.stopReason === 'stop',
    response_model_observed: guard.responseModels.length > 0,
    request_limit_observed: guard.sentRequests > 0 && guard.sentRequests <= guard.maxRequests,
  };
}

/** Run exactly one synthetic tool fixture. Only the CLI executor supplies a key. */
export async function runProviderSmoke({runId, harnessCommit, maxSpendUsd, maxRequests = DEFAULT_MAX_REQUESTS, dryRun = false, projectRoot = process.cwd()}) {
  validateRunOptions({runId, harnessCommit});
  validateRequestProfile(maxRequests, maxSpendUsd);
  // Remove the credential before SDK tools can spawn bash. It never enters context.
  let apiKey;
  if (!dryRun) {
    checkPaidRunPolicy(projectRoot, {runId, maxSpendUsd});
    apiKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    if (typeof apiKey !== 'string' || apiKey.length === 0) fail('api_key_missing');
  }
  const runDirectory = join(resolve(projectRoot), 'runs', 'model-smoke', runId);
  mkdirSync(dirname(runDirectory), {recursive: true});
  mkdirSync(runDirectory); // An existing run is never overwritten.
  const fixtureDir = mkdtempSync(join(runDirectory, 'fixture-'));
  const agentDir = join(runDirectory, 'agent');
  const sessionsDir = join(runDirectory, 'sessions');
  mkdirSync(agentDir); mkdirSync(sessionsDir);
  writeFileSync(join(fixtureDir, 'sample.txt'), 'alpha\nbeta\ngamma\n', {flag: 'wx'});
  const started = Date.now();
  const controller = new AbortController();
  let native;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); native?.session.agent.abort(); }, TOTAL_TIMEOUT_MS);
  const events = [];
  const assistants = [];
  const responseModelsById = new Map();
  const reportedReasoningById = new Map();
  let guard;
  let failure = null;
  let stats;
  let unsubscribe;
  let sessionFile = null;
  const eventsPath = join(runDirectory, 'events.jsonl');
  const redact = text => apiKey ? text.replaceAll(apiKey, '<redacted-api-key>') : text;
  try {
    native = await createNativeSession({fixtureDir, agentDir, sessionsDir, signal: controller.signal});
    guard = createRequestGuard({model: native.model, maxSpendUsd, maxRequests});
    const configuration = {
      schema_version: 1, kind: 'synthetic_provider_smoke', run_id: runId, harness_commit: harnessCommit.toLowerCase(),
      pi_version: PI_VERSION, provider: PROVIDER, model: SMOKE_MODEL,
      requested_thinking_level: 'xhigh', effective_thinking_level: native.session.thinkingLevel,
      tools: native.session.getActiveToolNames(), discovery_disabled: true, retry_disabled: true,
      auto_compaction_disabled: true, cache_warming: 'off', system_prompt_override: false,
      max_tokens_per_request: MAX_OUTPUT_TOKENS, max_physical_requests: guard.maxRequests,
      max_payload_bytes: MAX_PAYLOAD_BYTES, protocol_tokens_reserved_per_request: PROTOCOL_TOKENS_PER_REQUEST,
      timeout_ms: TOTAL_TIMEOUT_MS, max_spend_usd: maxSpendUsd,
      reserved_catalog_upper_bound_usd: guard.reservedUpperBoundUsd,
      catalog_rates_usd_per_million_tokens: native.model.cost,
      cost_scope: 'catalog_token_estimate_only', billed_cost_usd: null,
      platform: process.platform, fixture_directory: fixtureDir,
      isolation: 'fresh fixture cwd and agentDir; native tools are not an OS filesystem sandbox',
      benchmark_result: false, dry_run: dryRun,
    };
    writeFileSync(join(runDirectory, 'configuration.json'), JSON.stringify(configuration, null, 2) + '\n', {flag: 'wx'});
    if (dryRun) return {configuration, run_directory: runDirectory, provider_calls: 0};
    await native.modelRuntime.setRuntimeApiKey(PROVIDER, apiKey, {signal: controller.signal});
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const guardedFetch = guard.wrapFetch(nativeFetch);
    native.session.agent.streamFunction = (model, context, options = {}) => {
      guard.validateModel(model);
      const remaining = TOTAL_TIMEOUT_MS - (Date.now() - started);
      if (remaining <= 0) fail('deadline_exceeded');
      const stream = native.modelRuntime.streamSimple(model, context, {
        ...options, apiKey, maxTokens: MAX_OUTPUT_TOKENS, maxRetries: 0, timeoutMs: remaining,
        signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
        fetch: guardedFetch,
        onPayload: payload => { guard.validatePayload(payload); return payload; },
        onProviderStreamEvent: chunk => {
          if (!chunk || typeof chunk !== 'object') return;
          if (Object.hasOwn(chunk, 'model')) {
            guard.observeResponseModel(chunk.model);
            if (typeof chunk.id === 'string') responseModelsById.set(chunk.id, chunk.model);
          }
          // The pinned adapter defaults native usage.reasoning to zero when the
          // provider omits it; retain only the actual raw reported breakdown.
          const rawUsage = chunk.usage ?? chunk.choices?.[0]?.usage;
          if (rawUsage && typeof chunk.id === 'string') {
            const reasoning = rawUsage.completion_tokens_details?.reasoning_tokens;
            reportedReasoningById.set(chunk.id, Number.isInteger(reasoning) && reasoning >= 0 ? reasoning : null);
          }
        },
      });
      return redactProviderStream(stream, apiKey);
    };
    appendFileSync(eventsPath, JSON.stringify(native.sessionManager.getHeader()) + '\n');
    unsubscribe = native.session.subscribe(event => {
      // Native final messages retain usage; cumulative streamed snapshots would
      // duplicate it and needlessly inflate the raw accounting trace.
      if (event.type === 'message_update') return;
      events.push(event);
      appendFileSync(eventsPath, redact(JSON.stringify(event)) + '\n');
      if (event.type === 'message_end' && event.message?.role === 'assistant') assistants.push(event.message);
    });
    await native.session.prompt(fixturePrompt(fixtureDir));
    if (timedOut) failure = 'deadline_exceeded';
  } catch (error) {
    failure = timedOut ? 'deadline_exceeded' : safeFailure(error);
  } finally {
    if (native) {
      await native.session.abort();
      stats = native.session.getSessionStats();
      if (native.session.sessionFile && existsSync(native.session.sessionFile)) {
        sessionFile = join(runDirectory, 'session.jsonl');
        copyFileSync(native.session.sessionFile, sessionFile);
      }
      unsubscribe?.();
      native.session.dispose();
      await native.modelRuntime.removeRuntimeApiKey(PROVIDER).catch(() => {});
    }
    clearTimeout(timer);
  }
  if (!guard) fail(failure ?? 'native_session_failed');
  failure = classifySmokeFailure(failure, assistants, guard);
  const checks = evaluateSmokeFixture(fixtureDir, events, assistants, guard, failure);
  const summary = {
    schema_version: 1, kind: 'synthetic_provider_smoke', run_id: runId, harness_commit: harnessCommit.toLowerCase(),
    provider: PROVIDER, model: SMOKE_MODEL, passed: Object.values(checks).every(Boolean), checks, failure,
    wall_seconds: (Date.now() - started) / 1000, physical_requests: guard.sentRequests, sends: guard.sends,
    response_models_observed: guard.responseModels, tokens: stats?.tokens ?? null,
    ...summarizeReportedReasoning(assistants, reportedReasoningById, guard.sentRequests),
    max_physical_requests: guard.maxRequests, blocked_reasons: guard.blockedReasons,
    observed_pi_catalog_token_cost_usd: stats?.cost ?? null,
    cost_scope: 'token_usage_only; excludes storage/tool/container fees and account discounts', billed_cost_usd: null,
    max_spend_usd: maxSpendUsd, reserved_catalog_upper_bound_usd: guard.reservedUpperBoundUsd,
    responses: assistants.map(message => ({responseId: message.responseId ?? null, provider: message.provider,
      model: message.model, responseModel: message.responseModel ?? responseModelsById.get(message.responseId) ?? null,
      stopReason: message.stopReason, usage: message.usage})),
    raw_events_file: eventsPath, raw_session_file: sessionFile, benchmark_result: false,
    limitations: ['Synthetic Linux SDK fixture; not a Harbor or Windows benchmark.',
      'Native tools use a fresh cwd but do not provide an OS filesystem sandbox.',
      'Pi catalog token costs and the conservative reservation are estimates; root reconciles provider receipts.'],
  };
  writeFileSync(join(runDirectory, 'summary.json'), redact(JSON.stringify(summary, null, 2)) + '\n', {flag: 'wx'});
  apiKey = undefined;
  return {summary, run_directory: runDirectory};
}

async function main() {
  const {values} = parseArgs({options: {'run-id': {type:'string'}, 'harness-commit': {type:'string'},
    'max-spend-usd': {type:'string'}, 'max-requests': {type:'string'}, 'dry-run': {type:'boolean'}, help: {type:'boolean'}}});
  if (values.help) {
    console.log('Usage: bun evals/micro/provider-smoke.mjs --run-id ID --harness-commit SHA40 --max-spend-usd CAP [--max-requests 4|6] [--dry-run]');
    return;
  }
  const result = await runProviderSmoke({runId: values['run-id'], harnessCommit: values['harness-commit'],
    maxSpendUsd: values['max-spend-usd'] === undefined ? undefined : Number(values['max-spend-usd']),
    maxRequests: values['max-requests'] === undefined ? DEFAULT_MAX_REQUESTS : Number(values['max-requests']), dryRun: values['dry-run'] ?? false});
  console.log(JSON.stringify(result, null, 2));
  if (result.summary && !result.summary.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({error: safeFailure(error)})); process.exitCode = 1; });
}
