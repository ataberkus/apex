import { readFile } from 'node:fs/promises';

const ALLOWED_MODEL = 'openrouter/meta/muse-spark-1.3-contributor';
const STATE_TYPES = ['apex-contract', 'apex-todo','apex-core-control','apex-plan-state','apex-features-state'];

function allowed(policy) {
  return policy?.allowed_model === ALLOWED_MODEL && policy.thinking_level === 'xhigh'
    && policy.paid_runs_enabled === true && policy.execution_policy === 'paid-enabled';
}

// Sorting keys changes no JSON value or array order. Non-JSON data is rejected
// instead of silently losing requirements through JSON.stringify coercions.
function stableJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || seen.has(value)) throw new Error('Branch state must be acyclic JSON');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error('Branch state must be plain JSON');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${Array.from(value, item => stableJson(item, seen)).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key], seen)}`).join(',')}}`;
  } finally { seen.delete(value); }
}

function branchState(branch) {
  const state = {};
  for (const entry of branch) {
    if (entry.type === 'compaction' && entry.details?.apexState) {
      for (const type of STATE_TYPES) {
        if (Object.hasOwn(entry.details.apexState, type)) state[type] = entry.details.apexState[type];
      }
    } else if (entry.type === 'custom' && STATE_TYPES.includes(entry.customType)) {
      state[entry.customType] = entry.data;
    }
  }
  return JSON.parse(stableJson(state));
}

function addPaths(target, paths) {
  if (!(paths instanceof Set) && !Array.isArray(paths)) throw new Error('Invalid file operations');
  for (const path of paths) {
    if (typeof path !== 'string') throw new Error('Invalid file operation path');
    target.add(path);
  }
}

function fileLists(preparation, branch) {
  const read = new Set();
  const modified = new Set();
  addPaths(read, preparation.fileOps.read);
  addPaths(modified, preparation.fileOps.written);
  addPaths(modified, preparation.fileOps.edited);
  // Native prepareCompaction does not carry details from previous hook-produced
  // compactions. Union the active branch's bookkeeping explicitly.
  for (const entry of branch) {
    if (entry.type !== 'compaction') continue;
    if (Array.isArray(entry.details?.readFiles)) addPaths(read, entry.details.readFiles);
    if (Array.isArray(entry.details?.modifiedFiles)) addPaths(modified, entry.details.modifiedFiles);
  }
  return { readFiles: [...read].filter(path => !modified.has(path)).sort(), modifiedFiles: [...modified].sort() };
}

function formatFiles({ readFiles, modifiedFiles }) {
  return [readFiles.length ? `<read-files>\n${readFiles.join('\n')}\n</read-files>` : '',
    modifiedFiles.length ? `<modified-files>\n${modifiedFiles.join('\n')}\n</modified-files>` : ''].filter(Boolean).join('\n\n');
}

function validPreparation(preparation, branch) {
  return preparation && typeof preparation.firstKeptEntryId === 'string'
    && branch.some(entry => entry.id === preparation.firstKeptEntryId)
    && Number.isFinite(preparation.tokensBefore) && preparation.tokensBefore >= 0
    && Array.isArray(preparation.messagesToSummarize) && Array.isArray(preparation.turnPrefixMessages)
    && (preparation.messagesToSummarize.length > 0 || preparation.turnPrefixMessages.length > 0)
    && Number.isFinite(preparation.settings?.reserveTokens) && preparation.settings.reserveTokens > 0
    && preparation.fileOps;
}

function validUsage(usage) {
  return usage && ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']
    .every(key => Number.isFinite(usage[key]) && usage[key] >= 0);
}

/**
 * A native session_before_compact handler. An injected completion has the same
 * model/context/options contract as ModelRegistry.complete, and cannot bypass
 * the offline policy. Every failure cancels instead of default-summary fallback.
 */
export function createCompactionHandler({ policy, complete } = {}) {
  const selectedPolicy = policy && { allowed_model: policy.allowed_model, thinking_level: policy.thinking_level,
    paid_runs_enabled: policy.paid_runs_enabled, execution_policy: policy.execution_policy };
  return async (event, ctx) => {
    // This is deliberately before all model-registry, auth, prompt and SDK access.
    if (!allowed(selectedPolicy) || !allowed(policy)) return { cancel: true };
    try {
      if (event?.signal?.aborted) return { cancel: true };
      const branch = ctx?.sessionManager?.getBranch?.() ?? event?.branchEntries;
      const preparation = event?.preparation;
      if (!Array.isArray(branch) || !validPreparation(preparation, branch)) return { cancel: true };
      const branchIds = branch.map(entry => entry.id).join('\n');
      const state = branchState(branch);
      const lists = fileLists(preparation, branch);
      const registry = ctx.modelRegistry;
      const model = registry.find('openrouter', 'meta/muse-spark-1.3-contributor');
      if (!model || `${model.provider}/${model.id}` !== ALLOWED_MODEL || model.api !== 'openai-completions'
        || model.reasoning !== true || (model.thinkingLevelMap?.xhigh !== undefined && model.thinkingLevelMap.xhigh !== 'xhigh')) return { cancel: true };
      const maxTokens = Math.floor(Math.min(preparation.settings.reserveTokens,
        Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : preparation.settings.reserveTokens));
      if (maxTokens < 1) return { cancel: true };
      const prompt = await readFile(new URL('../../prompts/compaction.md', import.meta.url), 'utf8');
      const { convertToLlm, serializeConversation } = await import('@earendil-works/pi-coding-agent');
      const sections = [];
      if (preparation.previousSummary) sections.push(`# Previous summary\n${preparation.previousSummary}`);
      sections.push(`# Conversation to summarize\n${serializeConversation(convertToLlm(preparation.messagesToSummarize))}`);
      if (preparation.turnPrefixMessages.length > 0) {
        sections.push(`# Earlier prefix of retained turn\n${serializeConversation(convertToLlm(preparation.turnPrefixMessages))}`);
      }
      if (event.customInstructions !== undefined) {
        if (typeof event.customInstructions !== 'string') return { cancel: true };
        sections.push(`# Additional instructions\n${event.customInstructions}`);
      }
      const runComplete = complete ?? registry.complete.bind(registry);
      if (typeof runComplete !== 'function' || event.signal?.aborted || !allowed(policy)) return { cancel: true };
      const response = await runComplete(model, { systemPrompt: prompt, messages: [{ role: 'user',
        content: [{ type: 'text', text: sections.join('\n\n') }], timestamp: 0 }], tools: [] },
      { reasoningEffort: 'xhigh', maxTokens, cacheRetention: 'none', signal: event.signal });
      const currentBranch = ctx?.sessionManager?.getBranch?.() ?? event.branchEntries;
      if (event.signal?.aborted || !allowed(policy) || !Array.isArray(currentBranch)
        || currentBranch.map(entry => entry.id).join('\n') !== branchIds
        || response?.stopReason !== 'stop' || !validUsage(response.usage) || !Array.isArray(response.content)
        || response.content.some(block => !block || (block.type !== 'text' && block.type !== 'thinking')
          || (block.type === 'text' && typeof block.text !== 'string'))) return { cancel: true };
      let summary = response.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
      if (!summary) return { cancel: true };
      for (const type of STATE_TYPES) {
        if (Object.hasOwn(state, type)) summary += `\n\n## ${type} (verbatim JSON)\n\`\`\`json\n${stableJson(state[type])}\n\`\`\``;
      }
      const files = formatFiles(lists);
      if (files) summary += `\n\n${files}`;
      return { compaction: { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore,
        ...(response.usage === undefined ? {} : { usage: response.usage }), details: { ...lists, apexState: state } } };
    } catch {
      return { cancel: true };
    }
  };
}
