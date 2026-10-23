import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const MODEL = 'openrouter/meta/muse-spark-1.3-contributor';
const FORMATS = ['text', 'json', 'csv', 'pdf', 'png', 'jpeg', 'zip', 'docx', 'xlsx', 'pptx'];
const STATUSES = ['pending', 'in_progress', 'done', 'dropped'];
const EXTENSIONS = { json: ['.json'], csv: ['.csv'], pdf: ['.pdf'], png: ['.png'], jpeg: ['.jpg', '.jpeg'], zip: ['.zip'], docx: ['.docx'], xlsx: ['.xlsx'], pptx: ['.pptx'] };
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const copy = value => structuredClone(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const text = (value, name, limit = 2048) => { if (!nonblank(value) || value.length > limit) throw new Error(`${name} must be a nonempty string of at most ${limit} characters`); return value; };
const isAllowed = policy => policy?.allowed_model === MODEL && policy?.thinking_level === 'xhigh' && policy?.paid_runs_enabled === true && policy?.execution_policy === 'paid-enabled';
const inside = (root, candidate) => { const relative = path.relative(root, candidate); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const schemaString = { type: 'string' };
const resultSchema = { type: 'object', properties: {}, additionalProperties: true };

function artifactPath(cwd, artifact) {
  if (!plain(artifact) || !FORMATS.includes(artifact.format)) throw new Error('Unknown artifact format');
  text(artifact.path, 'Artifact path', 4096);
  if (artifact.path.includes('\0') || artifact.path.split(/[\\/]/).includes('..') || (process.platform !== 'win32' && /\\|^[A-Za-z]:/.test(artifact.path))) throw new Error('Artifact path must be confined to cwd');
  const absolute = path.resolve(cwd, artifact.path);
  if (absolute === cwd || !inside(cwd, absolute)) throw new Error('Artifact path must name a file within cwd');
  if (EXTENSIONS[artifact.format] && !EXTENSIONS[artifact.format].includes(path.extname(absolute).toLowerCase())) throw new Error('Artifact path extension conflicts with format');
  if (artifact.contains !== undefined) text(artifact.contains, 'Artifact contains', 4096);
  if (Object.keys(artifact).some(key => !['path', 'format', 'contains'].includes(key))) throw new Error('Unknown artifact field');
  return absolute;
}

function criteriaInput(cwd, criteria) {
  if (!Array.isArray(criteria) || criteria.length < 1 || criteria.length > 64) throw new Error('Contract requires 1 to 64 criteria');
  const seen = new Set();
  for (const criterion of criteria) {
    if (!plain(criterion)) throw new Error('Criterion must be an object');
    text(criterion.id, 'Criterion id', 64); text(criterion.requirement, 'Requirement'); text(criterion.check, 'Check');
    if (seen.has(criterion.id)) throw new Error('Duplicate criterion id');
    seen.add(criterion.id);
    if (criterion.artifact !== undefined) artifactPath(cwd, criterion.artifact);
    if (Object.keys(criterion).some(key => !['id', 'requirement', 'check', 'artifact'].includes(key))) throw new Error('Unknown criterion field');
  }
  if (Buffer.byteLength(JSON.stringify(criteria), 'utf8') > 32768) throw new Error('Contract exceeds 32768 bytes');
  return copy(criteria);
}

function validUsage(usage) {
  return plain(usage) && ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(key => Number.isFinite(usage[key]) && usage[key] >= 0)
    && (usage.cost === undefined || plain(usage.cost) && Object.values(usage.cost).every(value => Number.isFinite(value) && value >= 0));
}

function csvValid(value) {
  const widths = []; let quoted = false, closedQuote = false, columns = 1, atFieldStart = true;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) { if (c === '"' && value[i + 1] === '"') i++; else if (c === '"') { quoted = false; closedQuote = true; } continue; }
    if (closedQuote && ![',', '\r', '\n'].includes(c)) return false;
    if (c === '"') { if (!atFieldStart) return false; quoted = true; atFieldStart = false; }
    else if (c === ',') { columns++; atFieldStart = true; closedQuote = false; }
    else if (c === '\n') { widths.push(columns); columns = 1; atFieldStart = true; closedQuote = false; }
    else if (c !== '\r') atFieldStart = false;
  }
  if (quoted) return false;
  if (!value.endsWith('\n')) widths.push(columns);
  return widths.length > 0 && widths.every(width => width === widths[0]);
}

function zipEntries(buffer) {
  // Check central directory bounds and corresponding local headers, without
  // extracting any archive paths or executing office macros.
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0) throw new Error('Invalid zip directory');
  const count = buffer.readUInt16LE(end + 10), size = buffer.readUInt32LE(end + 12), offset = buffer.readUInt32LE(end + 16);
  if (count < 1 || count !== buffer.readUInt16LE(end + 8) || offset + size !== end) throw new Error('Invalid zip directory');
  const names = []; let cursor = offset;
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid zip entry');
    const filenameLength = buffer.readUInt16LE(cursor + 28), extra = buffer.readUInt16LE(cursor + 30), comment = buffer.readUInt16LE(cursor + 32), local = buffer.readUInt32LE(cursor + 42);
    if (cursor + 46 + filenameLength + extra + comment > end || local + 30 > offset || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid zip local header');
    const name = buffer.subarray(cursor + 46, cursor + 46 + filenameLength).toString('utf8');
    const localName = buffer.subarray(local + 30, local + 30 + buffer.readUInt16LE(local + 26)).toString('utf8');
    if (name !== localName) throw new Error('Invalid zip names');
    names.push(name); cursor += 46 + filenameLength + extra + comment;
  }
  if (cursor !== end) throw new Error('Invalid zip size');
  return names;
}

function checkFormat(buffer, artifact) {
  let utf8;
  if (['text', 'json', 'csv'].includes(artifact.format) || artifact.contains !== undefined) {
    utf8 = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (utf8.includes('\0')) throw new Error('NUL bytes are not text');
  }
  if (artifact.format === 'json') JSON.parse(utf8);
  if (artifact.format === 'csv' && !csvValid(utf8)) throw new Error('Invalid csv rows or quoting');
  if (artifact.format === 'pdf' && (!buffer.subarray(0, 8).toString('ascii').match(/^%PDF-1\.[0-7]|^%PDF-2\.0/) || !buffer.subarray(-1024).toString('ascii').includes('%%EOF'))) throw new Error('Invalid pdf signature or trailer');
  if (artifact.format === 'png' && (buffer.length < 45 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || buffer.subarray(12, 16).toString('ascii') !== 'IHDR' || buffer.subarray(-8, -4).toString('ascii') !== 'IEND')) throw new Error('Invalid png signature or chunks');
  if (artifact.format === 'jpeg' && (buffer.length < 4 || buffer[0] !== 255 || buffer[1] !== 216 || buffer.at(-2) !== 255 || buffer.at(-1) !== 217)) throw new Error('Invalid jpeg signature or trailer');
  if (['zip', 'docx', 'xlsx', 'pptx'].includes(artifact.format)) {
    const entries = zipEntries(buffer);
    const main = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' }[artifact.format];
    if (main && (!entries.includes('[Content_Types].xml') || !entries.includes(main))) throw new Error(`Missing ${artifact.format} container entries`);
  }
  if (artifact.contains !== undefined && !utf8.includes(artifact.contains)) throw new Error('Expected content is missing');
}

async function checkArtifact(cwd, artifact) {
  const candidate = artifactPath(cwd, artifact);
  const root = await realpath(cwd);
  const relative = path.relative(cwd, candidate); let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('symlink artifacts are not allowed');
  }
  const resolved = await realpath(current);
  if (!inside(root, resolved)) throw new Error('Artifact path escapes cwd');
  const file = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Artifact is not a regular file');
    if (info.size > MAX_ARTIFACT_BYTES) throw new Error('Artifact exceeds bounded 1 MiB format-check limit');
    if (await realpath(current) !== resolved) throw new Error('Artifact changed during path validation');
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size) throw new Error('Artifact changed during format validation');
    checkFormat(buffer.subarray(0, bytesRead), artifact);
  } finally { await file.close(); }
}

function classify(name, input) {
  if (['write', 'edit', 'apply_patch', 'patch'].includes(name)) return 'mutation';
  if (name !== 'bash') return ['codemode', 'powershell', 'bg'].includes(name) ? (name === 'codemode' ? 'container' : 'mutation') : 'observation';
  const command = input?.command;
  // Redirects, background jobs, expansion and substitutions make the result
  // ambiguous. Never parse/execute a criterion's opaque `check` string here.
  if (typeof command !== 'string' || /[<>`$\n\r]/.test(command)) return 'mutation';
  const separators = command.match(/&&|\|\||[;|&]/g) ?? [];
  if (separators.includes('&')) return 'mutation';
  // Splitting at every separator, quoted or not, still starts a part at each real command.
  const kinds = command.split(/&&|\|\||[;|]/).map(classifySimple);
  if (kinds.includes('mutation')) return 'mutation';
  if (!kinds.includes('verification')) return 'observation';
  // Only an && chain exits 0 exactly when every verifier in it passed.
  return separators.every(separator => separator === '&&') ? 'verification' : 'mutation';
}

function classifySimple(command) {
  const tokens = command.trim().split(/\s+/);
  // The shell removes quotes and backslashes, so check options as the program receives them.
  const options = tokens.map(token => token.replace(/['"\\]/g, ''));
  if (options.some(token => ['--help', '-h', '--version', '-v'].includes(token))) return 'mutation';
  if (options.some(token => /^--(?:pre|ext-diff|textconv|output)(?:=|$)/.test(token))) return 'mutation';
  const joined = tokens.join(' ');
  if (/^(?:npm|pnpm|yarn|bun) (?:test(?: .*)?|run (?:test|check|typecheck|lint)(?::[\w-]+)?(?: .*)?)$/.test(joined)
    || /^(?:pytest|ruff|pyright)(?: .*)?$/.test(joined)
    || /^python(?:3)? -m (?:pytest|unittest)(?: .*)?$/.test(joined)
    || /^node --(?:test|check)(?: .*)?$/.test(joined)
    || /^tsc --noEmit(?: .*)?$/.test(joined)
    || /^(?:cargo (?:test|check)|go (?:test|vet)|make (?:test|check))(?: .*)?$/.test(joined)) return 'verification';
  if (/^(?:git (?:status|diff|log|show|rev-parse)|(?:rg|cat|head|tail|ls|pwd|wc)(?:\s|$))/.test(joined)) return 'observation';
  return 'mutation';
}

// Mirrors classify(): naming the accepted checks saves the model from guessing after an ad hoc check.
const UNVERIFIED = 'Run a recognized verification action successfully after the last file change (with no pending mutations). '
  + 'Only a plain bash call without shell operators counts: npm test, bun test, npm|bun run test|check|typecheck|lint, node --test, node --check, '
  + 'pytest, python -m pytest|unittest, ruff, pyright, tsc --noEmit, cargo test|check, go test|vet, make test|check. '
  + 'Ad hoc scripts such as node -e do not count; if none of these applies here, say so instead of inventing one.';

function stepCount(task, criteria) {
  const explicit = (task.match(/(?:^|[\n;:])\s*(?:\d+[.)]|[-*])\s+\S/g) ?? []).length;
  return Math.max(criteria.length, explicit);
}

function initial() {
  return { task: '', taskId: null, contract: { criteria: [], source: null, usage: null }, todos: [], nextId: 1,
    turns: 0, todoSteers: 0, gateContinuations: 0, lastTurn: null,
    extraction: { attempted: false, status: 'idle', reason: null, usage: null },
    ledger: { sequence: 0, lastMutation: 0, verification: null, pending: [], pendingCount: 0 } };
}

/** Session-local contract/todo/gate state. Factories do no I/O or model work. */
export function createTaskState({ cwd, branch = [], persist = () => {}, policy, complete, enforceTodo = false, enforceContract = false } = {}) {
  if (!nonblank(cwd)) throw new Error('cwd is required');
  cwd = path.resolve(cwd);
  const selectedPolicy = policy && { allowed_model: policy.allowed_model, thinking_level: policy.thinking_level, paid_runs_enabled: policy.paid_runs_enabled, execution_policy: policy.execution_policy };
  let data = initial(), queue = Promise.resolve();
  const calls = new Map();
  const persisted = {};
  for (const entry of branch) {
    if (entry?.type === 'compaction' && plain(entry.details?.apexState)) {
      Object.assign(persisted, entry.details.apexState);
      if (!Object.hasOwn(entry.details.apexState, 'apex-task-state') && plain(entry.details.apexState['apex-todo']?.control)) persisted['apex-task-state'] = entry.details.apexState['apex-todo'].control;
    }
    if (entry?.type === 'custom' && ['apex-contract', 'apex-todo', 'apex-task-state'].includes(entry.customType)) persisted[entry.customType] = entry.data;
  }
  const control = persisted['apex-task-state'] ?? persisted['apex-todo']?.control;
  // Every envelope carries an explicit identity. Legacy Phase 1/custom entries
  // without an identity remain preserved by compaction but do not seed a task.
  if (plain(control) && control.version === 1 && nonblank(control.taskId) && typeof control.task === 'string') {
    try {
      const contract = persisted['apex-contract'], todo = persisted['apex-todo'];
      data.task = text(control.task, 'Task', 32768); data.taskId = control.taskId;
      if (contract?.taskId === data.taskId) {
        data.contract = { criteria: contract.criteria.length ? criteriaInput(cwd, contract.criteria) : [], source: contract.source ?? null, usage: validUsage(contract.usage) ? copy(contract.usage) : null };
      }
      if (todo?.taskId === data.taskId && Array.isArray(todo.items) && todo.items.length <= 128) {
        const seen = new Set();
        data.todos = todo.items.map(item => {
          text(item.id, 'Todo id', 64); text(item.text, 'Todo text');
          if (seen.has(item.id) || !STATUSES.includes(item.status) || item.status === 'dropped' && !nonblank(item.reason)) throw new Error('Invalid restored todo');
          seen.add(item.id); return copy(item);
        });
        data.nextId = Number.isSafeInteger(todo.nextId) && todo.nextId > 0 ? todo.nextId : 1;
      }
      for (const key of ['turns', 'todoSteers', 'gateContinuations']) if (Number.isSafeInteger(control[key]) && control[key] >= 0) data[key] = key === 'turns' ? control[key] : Math.min(control[key], key === 'todoSteers' ? 1 : 2);
      data.lastTurn = typeof control.lastTurn === 'string' ? control.lastTurn : null;
      if (plain(control.extraction) && typeof control.extraction.attempted === 'boolean') data.extraction = copy(control.extraction);
      if (plain(control.ledger) && Number.isSafeInteger(control.ledger.sequence) && Number.isSafeInteger(control.ledger.lastMutation) && control.ledger.sequence >= control.ledger.lastMutation && control.ledger.lastMutation >= 0) {
        data.ledger.sequence = control.ledger.sequence; data.ledger.lastMutation = control.ledger.lastMutation;
        const verification = control.ledger.verification;
        if (plain(verification) && verification.sequence > data.ledger.lastMutation && verification.sequence <= data.ledger.sequence && nonblank(verification.toolCallId) && classify(verification.toolName, { command: verification.command }) === 'verification' && verification.exitCode === 0) data.ledger.verification = copy(verification);
        if (Array.isArray(control.ledger.pending) && control.ledger.pending.length || control.ledger.pendingCount > 0) { data.ledger.sequence++; data.ledger.lastMutation = data.ledger.sequence; data.ledger.verification = null; }
      }
    } catch { data = initial(); }
  }
  const serialize = () => ({ version: 1, task: data.task, taskId: data.taskId, turns: data.turns, todoSteers: data.todoSteers, gateContinuations: data.gateContinuations, lastTurn: data.lastTurn, extraction: copy(data.extraction), ledger: copy(data.ledger) });
  // Embed the bounded control envelope in apex-todo as well: Phase 1's
  // compactor deliberately preserves only apex-contract and apex-todo verbatim.
  const saveControl = () => {
    const control = serialize();
    const recorded = persist('apex-task-state', control);
    const embedded = persist('apex-todo', { version: 1, taskId: data.taskId, items: copy(data.todos), nextId: data.nextId, control: copy(control) });
    return Promise.all([recorded, embedded]);
  };
  const saveContract = () => persist('apex-contract', { version: 1, taskId: data.taskId, ...copy(data.contract) });
  const saveTodo = () => persist('apex-todo', { version: 1, taskId: data.taskId, items: copy(data.todos), nextId: data.nextId, control: serialize() });
  const serial = action => { const pending = queue.then(action); queue = pending.catch(() => {}); return pending; };
  const checkSignal = signal => { if (signal?.aborted) throw new Error('Operation aborted'); };
  const toolResult = (structuredContent, message) => ({ content: [{ type: 'text', text: message }], structuredContent, details: { taskId: data.taskId } });
  const invalidate = () => { data.ledger.sequence++; data.ledger.lastMutation = data.ledger.sequence; data.ledger.verification = null; };
  const updatePending = () => {
    const pending = [...calls].filter(([, c]) => !c.finished && c.kind === 'mutation').map(([id]) => id);
    data.ledger.pendingCount = pending.length;
    data.ledger.pending = pending.slice(0, 128).map(id => id.slice(0, 256));
  };
  // Native Pi previews final-assistant context as canContinue=false before any
  // draft. Each continuation below first appends a nonempty custom_message;
  // Pi rechecks the resulting user-context projection before requesting again.
  const eligible = event => event?.outcome === 'completed' && typeof event?.context?.canContinue === 'boolean' && Array.isArray(event.context.pendingMessages) && event.context.pendingMessages.length === 0 && !event?.signal?.aborted;
  const boundaryDraft = event => ({ entries: [...(event?.entries ?? [])] });

  async function setContract(criteria, source, usageRecord, signal) {
    checkSignal(signal);
    const validated = criteriaInput(cwd, criteria);
    const previous = data.contract.criteria;
    // Manual edits retain existing todo resolution but seed new requirement IDs.
    const delta = [];
    const nextTodos = copy(data.todos);
    for (const criterion of validated) {
      const existing = nextTodos.find(item => item.id === criterion.id);
      if (!existing) {
        if (nextTodos.length >= 128) throw new Error('Todo limit reached');
        const item = { id: criterion.id, text: criterion.requirement, status: 'pending' }; nextTodos.push(item); delta.push(copy(item));
      } else if (JSON.stringify(previous.find(item => item.id === criterion.id)) !== JSON.stringify(criterion)) {
        existing.text = criterion.requirement; existing.status = 'pending'; delete existing.reason; delta.push(copy(existing));
      }
    }
    data.contract = { criteria: validated, source, usage: usageRecord ? copy(usageRecord) : null };
    data.todos = nextTodos;
    await saveContract(); await saveTodo(); await saveControl();
    return toolResult({ criteria: copy(validated), source, usage: usageRecord ? copy(usageRecord) : null, delta }, JSON.stringify({ criteria: validated, delta }));
  }

  const api = {
    begin(task, { newRun = false } = {}) {
      text(task, 'Task', 32768);
      if (!newRun && data.taskId && data.task === task) return Promise.resolve(api.snapshot());
      // Reset synchronously so in-flight extraction/tool requests cannot publish
      // into a later task. Writes are serialized separately by task identity.
      data = initial(); data.task = task; data.taskId = randomUUID(); calls.clear();
      const identity = data.taskId;
      return serial(async () => { if (data.taskId !== identity) return api.snapshot(); await saveContract(); await saveTodo(); await saveControl(); return api.snapshot(); });
    },
    snapshot() { return copy(data); },
    extractContract(task, ctx, { signal } = {}) {
      const identity = data.taskId;
      return serial(async () => {
        if (!identity || identity !== data.taskId || task !== data.task) return { status: 'stale', reason: 'Task identity changed' };
        if (data.extraction.attempted) return { status: 'already-attempted', reason: data.extraction.reason };
        data.extraction.attempted = true;
        if (!isAllowed(selectedPolicy) || !isAllowed(policy)) { data.extraction.status = 'blocked'; data.extraction.reason = 'Automatic extraction is disabled by offline policy; use contract set for explicit manual criteria'; await saveControl(); return copy(data.extraction); }
        let requestInvoked = false, incurredUsage = null, requestStatus = 'failed', observedTerminalCompletion = false;
        const requestId = `${identity}:contract:1`;
        const captureUsage = usage => {
          if (incurredUsage !== null || !validUsage(usage)) return;
          // Accounting belongs to the request's origin, even when cancellation,
          // a new task or a branch change makes publishing its contract invalid.
          incurredUsage = copy(usage);
          if (identity === data.taskId) data.extraction.usage = copy(incurredUsage);
        };
        const stale = reason => {
          requestStatus = 'stale';
          if (identity === data.taskId) { data.extraction.status = 'stale'; data.extraction.reason = reason; }
          return { status: 'stale', reason, taskId: identity, usage: incurredUsage === null ? null : copy(incurredUsage) };
        };
        try {
          checkSignal(signal);
          const branchFingerprint = () => ctx?.sessionManager?.getBranch?.().map(entry => entry.id).join('\n');
          const activeBranch = branchFingerprint();
          const registry = ctx?.modelRegistry;
          const model = registry?.find('openrouter', 'meta/muse-spark-1.3-contributor');
          if (!model || `${model.provider}/${model.id}` !== MODEL || model.api !== 'openai-completions' || model.reasoning !== true || (model.thinkingLevelMap?.xhigh !== undefined && model.thinkingLevelMap.xhigh !== 'xhigh')) throw new Error('Exact FAST Muse/xhigh model unavailable');
          const prompt = await readFile(new URL('../../prompts/contract.md', import.meta.url), 'utf8');
          checkSignal(signal);
          const runComplete = complete ?? registry.complete?.bind(registry);
          if (!isAllowed(policy) || identity !== data.taskId || typeof runComplete !== 'function') throw new Error('Contract request unavailable or stale');
          requestInvoked = true;
          const response = await runComplete(model, { messages: [{ role: 'user', content: [{ type: 'text', text: prompt.replace('{task}', task) }], timestamp: 0 }], tools: [] },
            { reasoningEffort: 'xhigh', maxTokens: Math.min(4096, Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? Math.floor(model.maxTokens) : 4096), cacheRetention: 'none', signal });
          captureUsage(response?.usage);
          observedTerminalCompletion = response?.stopReason === 'stop' && incurredUsage !== null;
          checkSignal(signal);
          if (!isAllowed(policy) || identity !== data.taskId || activeBranch !== branchFingerprint()) return stale('Task identity, active branch or policy changed during extraction');
          if (response?.stopReason !== 'stop' || !validUsage(response.usage) || !Array.isArray(response.content) || response.content.some(block => !block || !['text', 'thinking'].includes(block.type) || block.type === 'text' && typeof block.text !== 'string')) throw new Error('Invalid contract completion or usage');
          const extracted = JSON.parse(response.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
          await setContract(extracted, 'automatic', response.usage, signal);
          if (identity !== data.taskId) return stale('Task identity changed while saving extraction');
          data.extraction.status = 'complete'; data.extraction.reason = null; await saveControl();
          if (identity !== data.taskId) return stale('Task identity changed while saving extraction');
          requestStatus = 'complete';
          return { status: 'complete', taskId: identity, criteria: copy(data.contract.criteria), usage: copy(incurredUsage) };
        } catch (error) {
          if (requestInvoked) captureUsage(error?.usage);
          if (identity !== data.taskId) return stale('Task identity changed');
          requestStatus = signal?.aborted ? 'aborted' : 'failed';
          data.extraction.status = requestStatus; data.extraction.reason = String(error?.message ?? error).slice(0, 512); await saveControl();
          return { ...copy(data.extraction), taskId: identity };
        } finally {
          // Dedicated evidence is emitted exactly once per invoked request.
          // Partial error/aborted usage is retained but does not prove complete
          // billing; only a reported terminal stop with valid usage does.
          if (requestInvoked) await persist('apex-helper-usage', { version: 1, requestId, taskId: identity, kind: 'contract', provider: 'openrouter', model: 'meta/muse-spark-1.3-contributor',
            ...(incurredUsage === null ? {} : { usage: copy(incurredUsage) }), status: requestStatus, complete: observedTerminalCompletion });
        }
      });
    },
    contractTool() {
      return { name: 'contract', label: 'Task contract', description: 'Set or list explicit task acceptance criteria. check is descriptive text and is never executed. Optional artifacts use exact cwd-confined paths and explicit formats. Offline automatic extraction is disabled.',
        promptSnippet: 'Set or inspect explicit acceptance criteria.', executionMode: 'sequential', annotations: { readOnlyHint: false },
        parameters: { type: 'object', properties: { action: { type: 'string', enum: ['set', 'list'] }, criteria: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'object', properties: { id: schemaString, requirement: schemaString, check: schemaString, artifact: { type: 'object', properties: { path: schemaString, format: { type: 'string', enum: FORMATS }, contains: schemaString }, required: ['path', 'format'], additionalProperties: false } }, required: ['id', 'requirement', 'check'], additionalProperties: false } } }, required: ['action'], additionalProperties: false },
        outputSchema: resultSchema,
        execute(_id, params, signal) {
          const identity = data.taskId;
          return serial(async () => { checkSignal(signal); if (!identity || identity !== data.taskId) throw new Error('Task identity changed');
            if (params.action === 'list') return toolResult(copy(data.contract), JSON.stringify(data.contract));
            if (params.action !== 'set') throw new Error('Unknown contract action');
            return setContract(params.criteria, 'manual', null, signal);
          });
        } };
    },
    todoTool() {
      return { name: 'todo', label: 'Task todo', description: 'Manage task steps. add(text,id optional), update(id,text/status optional), done(id), drop(id,reason required), list.' +
        (enforceContract ? ' Each contract criterion is already a todo with the same id; update it instead of adding it.' : '') + ' Updates display only changed items; dropping requires a concrete reason.',
        promptSnippet: 'Track task steps and report only changes.', executionMode: 'sequential', annotations: { readOnlyHint: false },
        parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'add', 'update', 'done', 'drop'] }, id: schemaString, text: schemaString, status: { type: 'string', enum: STATUSES }, reason: schemaString }, required: ['action'], additionalProperties: false }, outputSchema: resultSchema,
        execute(_id, params, signal) {
          const identity = data.taskId;
          return serial(async () => {
            checkSignal(signal); if (!identity || identity !== data.taskId) throw new Error('Task identity changed');
            if (params.action === 'list') return toolResult({ todos: copy(data.todos), delta: [] }, JSON.stringify(data.todos));
            let item;
            if (params.action === 'add') {
              if (data.todos.length >= 128) throw new Error('Todo limit reached');
              const content = text(params.text, 'Todo text');
              let id = params.id;
              if (id === undefined) { do { id = `T${data.nextId++}`; } while (data.todos.some(todo => todo.id === id)); }
              text(id, 'Todo id', 64); if (data.todos.some(todo => todo.id === id)) throw new Error('Duplicate todo id');
              item = { id, text: content, status: 'pending' };
              data.todos.push(item);
            } else {
              if (!['update', 'done', 'drop'].includes(params.action)) throw new Error('Unknown todo action');
              item = data.todos.find(todo => todo.id === params.id); if (!item) throw new Error('Unknown todo id');
              const status = params.action === 'done' ? 'done' : params.action === 'drop' ? 'dropped' : params.status ?? item.status;
              if (!STATUSES.includes(status)) throw new Error('Unknown todo status');
              if (status === 'dropped') text(params.reason ?? (item.status === 'dropped' ? item.reason : undefined), 'Dropped todo reason');
              if (params.text !== undefined) text(params.text, 'Todo text');
              if (params.text !== undefined) item.text = params.text;
              item.status = status;
              if (status === 'dropped') item.reason = params.reason ?? item.reason;
              else delete item.reason;
            }
            await saveTodo(); await saveControl();
            const delta = [copy(item)];
            return toolResult({ delta }, JSON.stringify(delta));
          });
        } };
    },
    observeTool(event) {
      if (!data.taskId || !event || !['tool_call', 'tool_result', 'tool_execution_start', 'tool_execution_end'].includes(event.type)) return;
      const id = event.toolCallId, name = event.toolName;
      if (!nonblank(id) || !nonblank(name)) return;
      const start = event.type === 'tool_call' || event.type === 'tool_execution_start';
      const input = event.input ?? event.args ?? calls.get(id)?.input ?? {};
      const kind = classify(name, input);
      if (start) {
        if (calls.has(id)) return;
        if (kind === 'mutation') invalidate();
        calls.set(id, { input: kind === 'verification' ? { command: input.command } : {}, kind, startMutation: data.ledger.lastMutation, finished: false });
        updatePending(); return saveControl();
      }
      const nativeResult = event.type === 'tool_execution_end' ? { ...event.result, isError: event.isError } : event;
      if (calls.get(id)?.finished) return;
      const nested = nativeResult.nestedCalls ?? nativeResult.details?.nestedCalls;
      if (nested) {
        if (nested.complete !== true || !Array.isArray(nested.calls)) invalidate();
        for (const child of nested.calls ?? []) if (!calls.has(child.id)) {
          // Summaries do not contain successful verifier exit codes or causal
          // ordering. Unobserved calls can only invalidate, never prove success.
          const childKind = classify(child.name, child.arguments);
          if (childKind === 'mutation' || child.status === 'unfinished' || !child.arguments) invalidate();
          calls.set(child.id, { input: {}, kind: childKind, startMutation: data.ledger.lastMutation, finished: child.status !== 'unfinished' });
        }
      }
      const known = calls.get(id);
      if (known?.finished) return;
      const record = known ?? { input: kind === 'verification' ? { command: input.command } : {}, kind, startMutation: null, finished: false };
      record.finished = true; calls.set(id, record);
      if (record.kind === 'mutation') invalidate();
      else data.ledger.sequence++;
      updatePending();
      if (record.kind === 'verification' && nativeResult.isError !== true && nativeResult.structuredContent?.exit_code === 0 && record.startMutation !== null && record.startMutation === data.ledger.lastMutation && data.ledger.pending.length === 0) {
        data.ledger.verification = { sequence: data.ledger.sequence, toolCallId: id, toolName: name, command: record.input.command, exitCode: 0 };
      } else if (record.kind === 'verification' && (nativeResult.isError === true || nativeResult.structuredContent?.exit_code !== 0)) {
        data.ledger.verification = null;
      }
      // Bound finished identity storage without discarding any pending calls.
      if (calls.size > 2048) for (const [key, value] of calls) { if (calls.size <= 1024) break; if (value.finished) calls.delete(key); }
      return saveControl();
    },
    onTurn(event) {
      return serial(async () => {
        const response = boundaryDraft(event);
        if (!data.taskId || event?.outcome !== 'completed' || event?.message?.stopReason === 'aborted' || event?.message?.stopReason === 'error') return response;
        const turnId = event.messageEntryId ?? `turn:${event.turnIndex}`;
        if (data.lastTurn === turnId) return response;
        data.lastTurn = turnId; data.turns++;
        if (enforceTodo && data.turns >= 2 && data.todoSteers < 1 && data.todos.length === 0 && stepCount(data.task, data.contract.criteria) >= 3 && eligible(event)) {
          data.todoSteers++;
          response.entries.push({ type: 'custom_message', customType: 'apex-todo-steer', content: 'This task has three or more steps. Use todo to track the remaining steps, then proceed.', display: false });
          response.continue = true;
        }
        await saveControl(); return response;
      });
    },
    beforeSettle(event) {
      return serial(async () => {
        const response = boundaryDraft(event);
        if (!data.taskId || !eligible(event) || data.gateContinuations >= 2) return response;
        const identity = data.taskId, unmet = [];
        if (enforceTodo) {
          if (data.todos.length === 0 && stepCount(data.task, data.contract.criteria) >= 3) unmet.push('Create a todo list for the multi-step task.');
          for (const todo of data.todos) if (!['done', 'dropped'].includes(todo.status) || todo.status === 'dropped' && !nonblank(todo.reason)) unmet.push(`Todo ${todo.id}: ${todo.text}`);
        }
        if (!data.ledger.verification || data.ledger.verification.sequence <= data.ledger.lastMutation || data.ledger.pending.length) unmet.push(UNVERIFIED);
        if (enforceContract) {
          if (!data.contract.criteria.length) unmet.push('Set explicit acceptance criteria with the contract tool; automatic extraction is unavailable offline.');
          for (const criterion of data.contract.criteria) if (criterion.artifact) {
            try { await checkArtifact(cwd, criterion.artifact); }
            catch (error) { unmet.push(`${criterion.id} artifact ${criterion.artifact.path} (${criterion.artifact.format}): ${String(error.message).slice(0, 256)}`); }
          }
        }
        if (identity !== data.taskId || !unmet.length || !eligible(event)) return response;
        const prompt = await readFile(new URL('../../prompts/verification-gate.md', import.meta.url), 'utf8');
        if (identity !== data.taskId || !eligible(event)) return response;
        data.gateContinuations++;
        response.entries.push({ type: 'custom_message', customType: 'apex-verification-gate', content: prompt.replace('{unmet_items}', unmet.map(item => `- ${item}`).join('\n')), display: false, details: { unmet, semanticComplianceClaimed: false } });
        response.continue = true;
        await saveControl(); return response;
      });
    },
  };
  return api;
}
