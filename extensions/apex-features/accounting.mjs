/** Offline native usage accounting. This module never imports an SDK or provider. */
const COMPONENTS = ['input', 'cacheRead', 'cacheWrite', 'output'];
const SUBSETS = ['thinking', 'cacheWrite1h'];
const CATEGORY_NAMES = ['user', 'assistant', 'thinking', 'toolCalls', 'toolResults', 'summaries', 'system', 'custom', 'other'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const token = value => Number.isSafeInteger(value) && value >= 0;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const round = value => Number(value.toFixed(12));
const empty = () => Object.fromEntries([...COMPONENTS, 'totalTokens', ...SUBSETS].map(key => [key, 0]));
const fingerprint = (value, depth = 0) => {
  if (depth > 64) throw new Error('Session data exceeds nesting depth limit.');
  if (Array.isArray(value)) return `[${value.map(item => fingerprint(item, depth + 1)).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${fingerprint(value[key], depth + 1)}`).join(',')}}`;
  return JSON.stringify(value);
};

const checkEntries = entries => {if (!Array.isArray(entries) || entries.length > 100000) throw new Error('Session entries exceed the supported limit.');};
const checkLeaf = (state, activeLeaf) => {
  if (activeLeaf !== undefined && activeLeaf !== null && (!id(activeLeaf) || !state.byId.has(activeLeaf))) throw new Error('Unknown active session leaf.');
};

/** Unique entries of entries[from..], admitted into state; null when one is a parent an earlier task walk found absent. */
function admit(state, entries, from) {
  const unique = [];
  for (let index = from; index < entries.length; index++) {
    const entry = entries[index];
    if (!object(entry) || !id(entry.type)) throw new Error('Invalid session entry.');
    if (entry.type === 'session') continue;
    if (entry.id !== undefined) {
      if (!id(entry.id)) throw new Error('Invalid session entry identity.');
      if (state.byId.has(entry.id)) {
        if (fingerprint(state.byId.get(entry.id)) !== fingerprint(entry)) throw new Error('Conflicting session entry identity.');
        state.duplicateEntries++; continue;
      }
      if (state.missingParents.has(entry.id)) return null;
      state.byId.set(entry.id, entry);
    }
    unique.push(entry);
  }
  return unique;
}

function selectBranch(unique, byId, branch) {
  if (branch === undefined) return unique;
  if (Array.isArray(branch)) {
    const ids = new Set(branch.map(entry => typeof entry === 'string' ? entry : entry?.id));
    if ([...ids].some(key => !byId.has(key))) throw new Error('Unknown branch entry.');
    return unique.filter(entry => ids.has(entry.id));
  }
  if (branch === null) return [];
  if (!id(branch) || !byId.has(branch)) throw new Error('Unknown branch leaf.');
  const path = []; const seen = new Set(); let current = byId.get(branch);
  while (current) {
    if (seen.has(current.id)) throw new Error('Session parent cycle.');
    seen.add(current.id); path.push(current);
    if (current.parentId === null || current.parentId === undefined) break;
    current = byId.get(current.parentId);
    if (!current) throw new Error('Missing session parent.');
  }
  return path.reverse();
}

function explicitTask(entry) {
  if (entry.type === 'custom' && ['apex-task-state', 'apex-todo', 'apex-contract'].includes(entry.customType)) {
    return id(entry.data?.taskId) ? entry.data.taskId : id(entry.data?.control?.taskId) ? entry.data.control.taskId : null;
  }
  if (entry.type === 'compaction') {
    const state = entry.details?.apexState;
    const task = state?.['apex-task-state']?.taskId ?? state?.['apex-todo']?.control?.taskId ?? state?.['apex-todo']?.taskId;
    return id(task) ? task : null;
  }
  return null;
}

function incurredExtractionTask(entry) {
  const data = entry.type === 'compaction' ? entry.details?.apexState?.['apex-task-state'] ??
    entry.details?.apexState?.['apex-todo']?.control :
    entry.type === 'custom' && entry.customType === 'apex-task-state' ? entry.data :
      entry.type === 'custom' && entry.customType === 'apex-todo' ? entry.data?.control : null;
  if (data?.extraction?.attempted === true && object(data.extraction.usage) && id(data.taskId)) return data.taskId;
  if (entry.type === 'custom' && entry.customType === 'apex-contract' && entry.data?.source === 'automatic' && object(entry.data.usage) && id(entry.data.taskId)) return entry.data.taskId;
  return null;
}

function taskResolver(byId, missingParents) {
  const cache = new Map();
  return entry => {
    const seen = new Set(); const path = []; let current = entry; let task = null;
    while (current) {
      if (seen.has(current.id)) throw new Error('Session parent cycle.');
      seen.add(current.id); path.push(current);
      if (cache.has(current.id)) {task = cache.get(current.id); break;}
      task = explicitTask(current); if (task !== null) break;
      const parentId = current.parentId; current = byId.get(parentId);
      // The cached attribution of this path holds only until that parent arrives.
      if (!current && id(parentId)) missingParents.add(parentId);
    }
    for (const value of path) if (value.id !== undefined) cache.set(value.id, task);
    return task;
  };
}

function usageRecord(entry) {
  const message = entry.message;
  if (entry.type === 'message' && message?.role === 'assistant') {
    return {usage: message.usage, provider: message.provider, model: message.model, kind: 'assistant',
      complete: !['pending', 'error', 'aborted', 'deferred'].includes(message.stopReason), requestId: message.responseId};
  }
  if (entry.type === 'message' && message?.role === 'toolResult') {
    const aux = message.details?.apexAux;
    if (message.usage === undefined && aux?.attempted !== true) return null;
    return {usage: message.usage, provider: aux?.attempted === true ? aux.provider : null,
      model: aux?.attempted === true ? aux.model : null, kind: 'tool',
      complete: !aux || aux.version === 1 && aux.attempted === true && aux.complete === true};
  }
  if (['compaction', 'branch_summary', 'usage'].includes(entry.type)) {
    return {usage: entry.usage, provider: entry.provider, model: entry.model, kind: entry.type, complete: true};
  }
  if (entry.type === 'custom' && entry.customType === 'apex-helper-usage') {
    const data = entry.data;
    return {usage: data?.usage, provider: data?.provider, model: data?.model, kind: 'helper',
      taskId: id(data?.taskId) ? data.taskId : null, requestId: data?.requestId,
      complete: data?.version === 1 && id(data?.requestId) && data?.complete === true && !['aborted', 'error'].includes(data?.status)};
  }
  if (entry.usage !== undefined || message?.usage !== undefined) {
    return {usage: entry.usage ?? message.usage, kind: 'unsupported', complete: false};
  }
  return null;
}

function inspectUsage(usage, complete) {
  const values = empty(); const known = new Set(); const issues = [];
  for (const key of COMPONENTS) {
    if (token(usage?.[key])) {values[key] = usage[key]; known.add(key);} else issues.push('missing_usage_component');
  }
  const sum = COMPONENTS.reduce((total, key) => total + values[key], 0);
  if (known.size === 4 && Number.isSafeInteger(sum) && token(usage?.totalTokens) && usage.totalTokens === sum) {
    values.totalTokens = sum; known.add('totalTokens');
  } else issues.push('invalid_total_tokens');
  for (const [key, source, parent] of [['thinking', 'reasoning', 'output'], ['cacheWrite1h', 'cacheWrite1h', 'cacheWrite']]) {
    if (usage?.[source] !== undefined) {
      if (token(usage[source]) && known.has(parent) && usage[source] <= values[parent]) {values[key] = usage[source]; known.add(key);}
      else issues.push('invalid_usage_subset');
    }
  }
  if (!complete) issues.push('partial_usage');
  if (sum === 0) issues.push('zero_usage_placeholder');
  const valid = issues.length === 0;
  const nativeCost = number(usage?.cost?.total) ? usage.cost.total : null;
  return {values, known, valid, issues, nativeCost};
}

function findRates(pricing, provider, model, selectedModel) {
  if (!id(provider) || !id(model) || !object(pricing)) return null;
  let rates;
  if (Array.isArray(pricing.models)) rates = pricing.models.find(value => value?.provider === provider && (value?.model ?? value?.id) === model);
  else if (object(pricing[`${provider}/${model}`])) rates = pricing[`${provider}/${model}`];
  else if (pricing.provider === provider && (pricing.model ?? pricing.id) === model) rates = pricing.cost ?? pricing;
  else if (selectedModel?.provider === provider && selectedModel?.id === model && pricing.provider === undefined && pricing.model === undefined) rates = pricing;
  if (!object(rates)) return null;
  const aliases = {cacheRead: 'cache_read', cacheWrite: 'cache_write', cacheWrite1h: 'cache_write_1h'};
  return Object.fromEntries([...COMPONENTS, 'cacheWrite1h'].map(key => [key, rates[key] ?? rates[aliases[key]]]));
}

function pricedUsage(parsed, rates) {
  if (!rates) return null;
  let cost = 0;
  for (const key of COMPONENTS) {
    if (!parsed.known.has(key) || !number(rates[key])) return null;
    if (key === 'cacheWrite' && parsed.values.cacheWrite > 0 && rates.cacheWrite1h !== undefined) {
      if (!parsed.known.has('cacheWrite1h') || !number(rates.cacheWrite1h)) return null;
      cost += (parsed.values.cacheWrite - parsed.values.cacheWrite1h) * rates.cacheWrite + parsed.values.cacheWrite1h * rates.cacheWrite1h;
    } else cost += parsed.values[key] * rates[key];
  }
  return number(cost) ? round(cost / 1000000) : null;
}

function bucket() {
  return {knownTotals: empty(), allKnown: new Set([...COMPONENTS, 'totalTokens', ...SUBSETS]),
    usage: true, nativeCost: true, pricedCost: true, knownNativeEstimateUsd: 0, knownPricingEstimateUsd: 0, records: 0, issues: new Set()};
}
const cloneBucket = value => ({...value, knownTotals: {...value.knownTotals}, allKnown: new Set(value.allKnown), issues: new Set(value.issues)});
function accumulate(target, parsed, priced) {
  target.records++;
  for (const key of Object.keys(target.knownTotals)) {
    if (parsed.known.has(key)) target.knownTotals[key] += parsed.values[key];
    else target.allKnown.delete(key);
    if (!Number.isSafeInteger(target.knownTotals[key])) throw new Error('Session token totals exceed numeric limit.');
  }
  target.usage &&= parsed.valid;
  target.nativeCost &&= parsed.nativeCost !== null;
  target.pricedCost &&= priced !== null;
  if (parsed.nativeCost !== null) target.knownNativeEstimateUsd += parsed.nativeCost;
  if (priced !== null) target.knownPricingEstimateUsd += priced;
  if (!Number.isFinite(target.knownNativeEstimateUsd) || !Number.isFinite(target.knownPricingEstimateUsd)) throw new Error('Session cost totals exceed numeric limit.');
  for (const issue of parsed.issues) target.issues.add(issue);
}
function finish(target) {
  const totals = {};
  for (const key of Object.keys(target.knownTotals)) {
    // Partial requests invalidate full base totals, while keeping observed subtotals.
    totals[key] = target.allKnown.has(key) && target.usage ? target.knownTotals[key] : null;
  }
  const cost = {label: 'estimate, not invoice',
    nativeEstimateUsd: target.records > 0 && target.usage && target.nativeCost ? round(target.knownNativeEstimateUsd) : null,
    knownNativeEstimateUsd: round(target.knownNativeEstimateUsd),
    pricingEstimateUsd: target.records > 0 && target.usage && target.pricedCost ? round(target.knownPricingEstimateUsd) : null,
    knownPricingEstimateUsd: round(target.knownPricingEstimateUsd)};
  return {totals, knownTotals: {...target.knownTotals}, cost,
    completeness: {usage: target.usage, cost: cost.pricingEstimateUsd !== null, thinking: target.usage && target.allKnown.has('thinking'), issues: [...target.issues].sort()}};
}

function categorySizes(entry) {
  const sizes = Object.fromEntries(CATEGORY_NAMES.map(key => [key, 0]));
  const add = (key, text) => {if (typeof text === 'string') sizes[key] += Buffer.byteLength(text, 'utf8');};
  const content = (value, category) => {
    if (typeof value === 'string') return add(category, value);
    if (!Array.isArray(value)) return;
    for (const part of value) {
      if (part?.type === 'text') add(category, part.text);
      else if (part?.type === 'thinking') add('thinking', part.thinking);
      else if (part?.type === 'toolCall') add('toolCalls', JSON.stringify(part.arguments ?? {}));
      else if (part?.type === 'image') add('other', part.data);
    }
  };
  if (entry.type === 'message') {
    const role = entry.message?.role;
    if (role === 'bashExecution') {add('toolCalls', entry.message.command); add('toolResults', entry.message.output);}
    else if (role === 'compactionSummary' || role === 'branchSummary') add('summaries', entry.message.summary);
    else content(entry.message?.content, {user: 'user', assistant: 'assistant', toolResult: 'toolResults', system: 'system', custom: 'custom'}[role] ?? 'other');
  } else if (['compaction', 'branch_summary'].includes(entry.type)) {
    add('summaries', entry.summary); content(entry.systemMessage?.content, 'system');
  } else if (entry.type === 'custom_message') content(entry.content, 'custom');
  return sizes;
}

function newState(key) {
  const byId = new Map(); const missingParents = new Set();
  return {key, count: 0, last: undefined, byId, missingParents, resolveTask: taskResolver(byId, missingParents), duplicateEntries: 0,
    selected: 0, total: bucket(), tasks: new Map(), seenRequests: new Map(), incurredTasks: new Set(), accountedExtractionTasks: new Set(),
    sizes: Object.fromEntries(CATEGORY_NAMES.map(key => [key, 0])), topConsumers: [], duplicateRequests: 0, lastModel: null};
}

function account(state, selected, model, pricing) {
  state.selected += selected.length;
  for (const entry of selected) {
    const incurredTask = incurredExtractionTask(entry); if (incurredTask !== null) state.incurredTasks.add(incurredTask);
    if (entry.type === 'custom' && entry.customType === 'apex-helper-usage' && entry.data?.kind === 'contract' && id(entry.data?.taskId)) state.accountedExtractionTasks.add(entry.data.taskId);
    if (entry.type === 'model_change' && id(entry.provider) && id(entry.modelId)) state.lastModel = {provider: entry.provider, id: entry.modelId};
    if (entry.message?.role === 'assistant' && id(entry.message.provider) && id(entry.message.model)) state.lastModel = {provider: entry.message.provider, id: entry.message.model};
    const record = usageRecord(entry);
    // Pi 1.4.0 writes native compaction and branch-summary usage without the model; it runs them on the session model.
    if (record && ['compaction', 'branch_summary'].includes(record.kind) && entry.fromHook !== true &&
      !id(record.provider) && !id(record.model) && state.lastModel) Object.assign(record, {provider: state.lastModel.provider, model: state.lastModel.id});
    if (record) {
      const key = id(record.requestId) ? `${record.kind}:${record.provider}:${record.model}:${record.requestId}` : null;
      if (key && state.seenRequests.has(key)) {
        if (state.seenRequests.get(key) !== fingerprint(record)) throw new Error('Conflicting request usage identity.');
        state.duplicateRequests++; continue;
      }
      if (key) state.seenRequests.set(key, fingerprint(record));
      const parsed = inspectUsage(record.usage, record.complete);
      const selectedModel = id(model?.provider) && id(model?.id) ? model : null;
      const priced = pricedUsage(parsed, findRates(pricing, record.provider, record.model, selectedModel));
      if (!id(record.provider) || !id(record.model)) parsed.issues.push('unattributed_model');
      if (priced === null) parsed.issues.push('unknown_pricing');
      accumulate(state.total, parsed, priced);
      const taskId = record.taskId ?? state.resolveTask(entry);
      if (!state.tasks.has(taskId)) state.tasks.set(taskId, bucket());
      accumulate(state.tasks.get(taskId), parsed, priced);
    }
    const entrySizes = categorySizes(entry); let bytes = 0;
    for (const key of CATEGORY_NAMES) {state.sizes[key] += entrySizes[key]; bytes += entrySizes[key];}
    if (bytes > 0) {
      // Keeps the stable descending sort's first ten: an entry ranks after earlier ones of equal size.
      const top = state.topConsumers; let at = top.findIndex(value => value.bytes < bytes); if (at === -1) at = top.length;
      if (at < 10) top.splice(at, 0, {entryId: id(entry.id) ? entry.id : null,
        type: ['message', 'compaction', 'branch_summary', 'custom_message'].includes(entry.type) ? entry.type : 'other',
        bytes, estimatedTokens: bytes / 4});
      if (top.length > 10) top.pop();
    }
  }
}

// Reads state without changing its totals, so an incremental summarizer can keep accounting after it.
function output(state, entries, activeLeaf, context, model, branch, selected) {
  const total = cloneBucket(state.total); const tasks = new Map(state.tasks);
  let missingHelperRecords = 0;
  for (const taskId of state.incurredTasks) if (!state.accountedExtractionTasks.has(taskId)) {
    missingHelperRecords++; total.usage = false; total.issues.add('missing_helper_record');
    const task = tasks.has(taskId) ? cloneBucket(tasks.get(taskId)) : bucket(); tasks.set(taskId, task);
    task.usage = false; task.issues.add('missing_helper_record');
  }
  const currentModel = id(model?.provider) && id(model?.id) ? {provider: model.provider, id: model.id} : state.lastModel && {...state.lastModel};
  const windowValue = context?.contextWindow ?? context?.window ?? model?.contextWindow;
  const window = number(windowValue) && windowValue > 0 ? windowValue : null;
  const tokens = token(context?.tokens) ? context.tokens : null;
  const percent = tokens !== null && window !== null ? round(tokens / window * 100) : null;
  const categories = {estimateMethod: 'utf8-bytes/4', label: 'stored content proxy, not exact input attribution'};
  for (const key of CATEGORY_NAMES) categories[key] = {bytes: state.sizes[key], estimatedTokens: state.sizes[key] / 4};
  const leaf = activeLeaf === null ? null : activeLeaf !== undefined ? state.byId.get(activeLeaf) :
    branch === undefined ? entries.findLast(entry => entry.type !== 'session') : selected.at(-1);
  const currentTaskId = leaf ? state.resolveTask(leaf) : null;
  return {...finish(total), scope: branch === undefined ? 'session' : 'branch', model: currentModel,
    currentTaskId, context: {tokens, window, percent}, categories,
    topConsumers: state.topConsumers.map(value => ({...value})),
    tasks: [...tasks].map(([taskId, value]) => ({taskId, ...finish(value)})),
    counts: {entries: state.selected, usageRecords: total.records, duplicateEntries: state.duplicateEntries,
      duplicateRequests: state.duplicateRequests, missingHelperRecords}};
}

/** Native usage excludes cached tokens from input. Thinking is an output subset. */
export function summarizeSession(entries, {branch, activeLeaf, context, model, pricing} = {}) {
  checkEntries(entries);
  const state = newState(); const unique = admit(state, entries, 0);
  checkLeaf(state, activeLeaf);
  const selected = selectBranch(unique, state.byId, branch);
  account(state, selected, model, pricing);
  return output(state, entries, activeLeaf, context, model, branch, selected);
}

// Only plain JSON pricing keys the incremental cache: its fingerprint then tells apart every value findRates can.
const plain = (value, depth = 0) => {
  if (depth > 32) return false;
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object') return false;
  const array = Array.isArray(value); const prototype = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) && (array || prototype !== null)) return false;
  return Reflect.ownKeys(value).every(key => {
    if (array && key === 'length') return true;
    const property = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && property.enumerable && 'value' in property && plain(property.value, depth + 1);
  });
};

/** summarizeSession for the whole session, accounting only the entries appended since the previous call. */
export function createSessionSummarizer() {
  let state = null;
  return {summarize(entries, {branch, activeLeaf, context, model, pricing} = {}) {
    try {
      if (branch !== undefined) {state = null; return summarizeSession(entries, {branch, activeLeaf, context, model, pricing});}
      checkEntries(entries);
      // Prices are fixed per record, so other pricing or another selected model reprices from scratch.
      const key = plain(pricing) ? fingerprint([id(model?.provider) && id(model?.id) ? [model.provider, model.id] : null, pricing ?? null]) : null;
      if (key === null) {state = null; return summarizeSession(entries, {activeLeaf, context, model, pricing});}
      // Pi only appends, reusing its entry objects: a shorter list or another object at the last processed index is another history.
      if (state?.key !== key || entries.length < state.count || state.count > 0 && entries[state.count - 1] !== state.last) state = newState(key);
      let unique = admit(state, entries, state.count);
      if (unique === null) {state = newState(key); unique = admit(state, entries, 0);}
      checkLeaf(state, activeLeaf);
      account(state, unique, model, pricing);
      state.count = entries.length; state.last = entries[entries.length - 1];
      return output(state, entries, activeLeaf, context, model);
    } catch (error) {state = null; throw error;}
  }};
}

/** Compact footer retains usage, routing, active task and honest estimate labels. */
export function formatCost(summary) {
  const totals = summary?.totals ?? {};
  const display = value => token(value) ? String(value) : 'unknown';
  const money = value => value > 0 && value < 0.0001 ? '<$0.0001' : `$${value.toFixed(4)}`;
  const costText = value => number(value?.cost?.pricingEstimateUsd) ? `estimate ${money(value.cost.pricingEstimateUsd)}` :
    `unknown${value?.completeness?.usage === false ? ' (incomplete)' : ''}${number(value?.cost?.nativeEstimateUsd) ? `; native estimate ${money(value.cost.nativeEstimateUsd)}` : ''}`;
  const prompt = [totals.input, totals.cacheRead, totals.cacheWrite].every(token) ? totals.input + totals.cacheRead + totals.cacheWrite : null;
  const hit = prompt !== null && prompt > 0 ? `${(totals.cacheRead / prompt * 100).toFixed(1)}%` : 'unknown';
  const context = number(summary?.context?.percent) ? `${summary.context.percent.toFixed(1)}%` : 'unknown';
  const model = id(summary?.model?.provider) && id(summary?.model?.id) ? `${summary.model.provider}/${summary.model.id}`.replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 96) : 'model unknown';
  const sections = [`in ${display(totals.input)}`, `cache-read ${display(totals.cacheRead)}/write ${display(totals.cacheWrite)}`,
    `out ${display(totals.output)}`, `hit ${hit}`, `ctx ${context}`, model,
    `${summary?.scope === 'branch' ? 'branch' : 'session'} ${costText(summary)}`];
  if (id(summary?.currentTaskId)) {
    const task = summary?.tasks?.find(value => value.taskId === summary.currentTaskId);
    sections.push(`task ${costText(task)}`);
  }
  return `${sections.join(' · ')} (not invoice)`;
}
