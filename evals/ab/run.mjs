#!/usr/bin/env node
/**
 * Live A/B: stock Pi (--apex-off) vs Apex's native Windows defaults, same model and thinking level, on the
 * task suite in evals/ab/tasks. Each attempt runs the real bin/apex CLI in a fresh Git workspace under the OS
 * temp folder; hidden verifiers run afterwards from outside that workspace. Raw JSON event streams, stderr,
 * the workspace diff and the verdict are kept under runs/ab/<run-id>/ (gitignored).
 *
 *   node evals/ab/run.mjs --self-test                 # no model calls: fixtures fail, reference fixes pass
 *   node evals/ab/run.mjs --run-id ab-001 [--tasks a,b] [--arms stock,apex] [--attempts 3] [--concurrency 4]
 *                         [--model openai-codex/gpt-6.1-sol] [--thinking max] [--timeout-min 20] [--apex-root DIR] [--max-usd N]
 *   node evals/ab/run.mjs --run-id ab-001 --resume    # rerun only attempts missing from results.jsonl
 *
 * Arms: `stock` (--apex-off), `apex` (the Windows defaults), `apex-no-FLAG` (the defaults minus one flag, e.g.
 * `--arms apex,apex-no-checkpoints`) and `apex+FLAG[+FLAG…]` (the defaults plus flags, e.g. `apex+todo+verify`).
 * The report pairs every later arm with every earlier one.
 *
 * --apex-root runs a frozen copy made by `node evals/ab/snapshot.mjs DIR`, so editing Apex mid-run changes nothing;
 * its apex-snapshot.json and patch are recorded with the results. --resume reuses the run's stored settings.
 *
 * Model calls use the saved OAuth logins through PI_CODING_AGENT_DIR (default %LOCALAPPDATA%\Apex\sol-oauth), exactly
 * as the dashboard does: Codex by default, the Claude login for `--model anthropic/...`. This script never reads that
 * directory itself. Only Codex runs are added to evals/codex-budget.json.
 */
import {spawn, spawnSync} from 'node:child_process';
import {appendFileSync, copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {git, snapshot} from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const DEFAULT_MODEL = 'openai-codex/gpt-6.1-sol';

/** Tasks live in tasks/<id>.mjs. Named tasks import only their own files, so a broken sibling cannot stop them. */
export async function loadTasks(names) {
  const dir = path.join(here, 'tasks');
  const ids = (names ? [...new Set(names.split(','))] : readdirSync(dir).filter(name => name.endsWith('.mjs')).map(name => name.slice(0, -4))).sort();
  const unknown = ids.filter(id => !existsSync(path.join(dir, id + '.mjs')));
  if (unknown.length) throw Error('Unknown task(s): ' + unknown.join(', '));
  const tasks = [];
  for (const id of ids) {
    const task = (await import(pathToFileURL(path.join(dir, id + '.mjs')).href)).default;
    if (task.id !== id) throw Error(`tasks/${id}.mjs declares id ${task.id}`);
    tasks.push(task);
  }
  return tasks;
}

const workspace = (label) => mkdtempSync(path.join(os.tmpdir(), `ab-${label}-`));
const cleanup = dir => { for (const target of [dir, dir + '-hidden']) rmSync(target, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}); };

/** Without a model: every verifier must reject the untouched fixture and accept the reference fix. */
async function selfTest(tasks) {
  let ok = true;
  for (const task of tasks) {
    const results = {};
    for (const mode of ['fixture', 'reference']) {
      const dir = workspace(`self-${task.id}`);
      try {
        task.setup(dir);
        const before = snapshot(dir);
        if (mode === 'reference') task.solve(dir);
        results[mode] = task.verify(dir, before);
      } finally { cleanup(dir); }
    }
    // A forbidden change on top of the reference fix must still fail, so a relaxed check cannot accept everything.
    const accepted = [];
    for (const [n, violate] of (task.mustReject ?? []).entries()) {
      const dir = workspace(`self-${task.id}-reject${n}`);
      try {
        task.setup(dir);
        const before = snapshot(dir);
        task.solve(dir); violate(dir);
        if (task.verify(dir, before).pass) accepted.push(n + 1);
      } finally { cleanup(dir); }
    }
    const good = !results.fixture.pass && results.reference.pass && !accepted.length;
    ok &&= good;
    console.log(`${good ? 'ok  ' : 'FAIL'} ${task.id.padEnd(18)} fixture fails [${results.fixture.failed.join(',')}]; reference ${results.reference.pass ? 'passes' : 'FAILS ' + JSON.stringify(results.reference).slice(0, 1500)}` +
      (task.mustReject ? `; ${accepted.length ? `ACCEPTS forbidden change ${accepted.join(',')}` : `rejects ${task.mustReject.length} forbidden change(s)`}` : ''));
  }
  return ok;
}

/** `apex-no-FLAG` is the snapshot's Windows default minus FLAG and `apex+FLAG[+FLAG…]` the default plus those flags,
 * so one run can pair either with `apex`. `groups` maps each selection option to the flag names it takes. */
export function armArgs(arm, {model, thinking, sessionDir, prompt, cwd, defaults, groups}) {
  const [provider, id] = model.split(/\/(.*)/s);
  const route = ['--provider', provider, '--model', id, '--thinking', thinking, '--session-dir', sessionDir, prompt];
  if (arm === 'stock') return ['--apex-off', '--print', '--mode', 'json', ...route];
  if (arm === 'apex') return ['--profile', 'headless', ...route];
  const ablated = /^apex-no-([a-z]+)$/.exec(arm)?.[1];
  const added = /^apex(\+[a-z]+)+$/.test(arm) ? arm.split('+').slice(1) : [];
  if (!ablated && !added.length) throw Error('Unknown arm ' + arm);
  const selection = defaults(['--profile', 'headless'], {cwd}), args = [], unplaced = new Set(added);
  let removed = false;
  for (let i = 0; i < selection.length; i++) {
    if (!Object.hasOwn(groups, selection[i])) { args.push(selection[i]); continue; }
    const option = selection[i], flags = selection[++i].split(','), extra = added.filter(flag => groups[option].includes(flag));
    for (const flag of extra) { if (flags.includes(flag)) throw Error(`${arm}: ${flag} is already in the Windows defaults here`); unplaced.delete(flag); }
    removed ||= flags.includes(ablated);
    const kept = [...flags.filter(flag => flag !== ablated), ...extra];
    if (kept.length) args.push(option, kept.join(',')); // an emptied list drops its option
  }
  if (ablated && !removed) throw Error(`${arm}: ${ablated} is not in the Windows defaults here`);
  if (unplaced.size) throw Error(`${arm}: ${[...unplaced].join(',')} is not a flag of any list in the Windows defaults here`);
  return [...args, ...route];
}

/** Split Pi's JSONL on LF only (Unicode separators are valid inside JSON strings). */
export function parseEvents(text) {
  const events = [];
  for (const line of text.split('\n')) {
    const record = line.replace(/\r$/, '');
    if (!record) continue;
    try { events.push(JSON.parse(record)); } catch { events.push({type: 'unparsable', length: record.length}); }
  }
  return events;
}

export function metrics(events) {
  const m = {requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, peakContext: 0,
    toolCalls: 0, toolErrors: 0, byTool: {}, toolErrorsByTool: {}, compactions: 0, retries: 0, providerErrors: 0, stopReasons: {}, finalText: ''};
  for (const event of events) {
    if (event.type === 'compaction_start') m.compactions++;
    if (event.type === 'auto_retry_start') m.retries++;
    if (event.type !== 'message_end') continue;
    const message = event.message ?? {};
    if (message.role === 'assistant') {
      const usage = message.usage ?? {};
      m.requests++;
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) m[key] += usage[key] ?? 0;
      m.costUsd += usage.cost?.total ?? 0;
      m.peakContext = Math.max(m.peakContext, (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0));
      m.stopReasons[message.stopReason] = (m.stopReasons[message.stopReason] ?? 0) + 1;
      if (message.stopReason === 'error') m.providerErrors++;
      for (const part of message.content ?? []) if (part.type === 'toolCall') { m.toolCalls++; m.byTool[part.name] = (m.byTool[part.name] ?? 0) + 1; }
      const text = (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
      if (text) m.finalText = text.slice(0, 2000);
    } else if (message.role === 'toolResult' && message.isError) {
      m.toolErrors++; m.toolErrorsByTool[message.toolName] = (m.toolErrorsByTool[message.toolName] ?? 0) + 1;
    }
  }
  return m;
}

function killTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true});
  else child.kill('SIGKILL');
}

async function attempt({task, arm, n, runDir, model, thinking, timeoutMs, agentDir, apexRoot, defaults, groups}) {
  const outDir = path.join(runDir, task.id, `${arm}-${n}`);
  rmSync(outDir, {recursive: true, force: true}); // an attempt interrupted before a --resume restarts clean
  mkdirSync(outDir, {recursive: true});
  const dir = workspace(`${task.id}-${arm}${n}`);
  const started = Date.now();
  let timedOut = false, exit;
  try {
    task.setup(dir);
    const before = snapshot(dir);
    const args = armArgs(arm, {model, thinking, sessionDir: path.join(outDir, 'session'), prompt: task.prompt, cwd: dir, defaults, groups});
    const child = spawn(process.execPath, [path.join(apexRoot, 'bin', 'apex'), ...args],
      {cwd: dir, env: {...process.env, PI_CODING_AGENT_DIR: agentDir}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    const events = createWriteStream(path.join(outDir, 'events.jsonl')), errors = createWriteStream(path.join(outDir, 'stderr.log'));
    child.stdout.pipe(events); child.stderr.pipe(errors);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    exit = await new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
    clearTimeout(timer);
    await Promise.all([new Promise(r => events.end(r)), new Promise(r => errors.end(r))]);
    const wallSec = (Date.now() - started) / 1000;
    const m = metrics(parseEvents(readFileSync(path.join(outDir, 'events.jsonl'), 'utf8')));
    let result;
    try { result = task.verify(dir, before); } catch (error) { result = {pass: false, failed: ['verifier_crashed'], error: String(error?.stack ?? error)}; }
    writeFileSync(path.join(outDir, 'workspace.diff'), (git(dir, 'status', '--porcelain', '--untracked-files=all').stdout + '\n' +
      git(dir, 'diff', 'HEAD').stdout).slice(0, 400000));
    const record = {task: task.id, category: task.category, arm, attempt: n, pass: result.pass === true && !timedOut, verifierPass: result.pass === true,
      failed: result.failed, timedOut, exitCode: exit.code, wallSec, apexDirCreated: existsSync(path.join(dir, '.apex')), ...m,
      thinking, model, finishedAt: new Date().toISOString()};
    writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({...record, verdict: result}, null, 2) + '\n');
    return record;
  } finally { cleanup(dir); }
}

async function pool(jobs, size, worker) {
  const results = []; let next = 0;
  await Promise.all(Array.from({length: Math.min(size, jobs.length)}, async () => {
    while (next < jobs.length) { const job = jobs[next++]; results.push(await worker(job)); }
  }));
  return results;
}

async function main() {
  const {values} = parseArgs({options: {'self-test': {type: 'boolean'}, 'run-id': {type: 'string'}, tasks: {type: 'string'},
    arms: {type: 'string', default: 'stock,apex'}, attempts: {type: 'string', default: '3'}, concurrency: {type: 'string', default: '4'},
    model: {type: 'string', default: DEFAULT_MODEL}, thinking: {type: 'string', default: 'max'}, 'timeout-min': {type: 'string', default: '20'},
    'apex-root': {type: 'string'}, 'max-usd': {type: 'string'}, resume: {type: 'boolean'}}});
  if (values['self-test']) { process.exitCode = await selfTest(await loadTasks(values.tasks)) ? 0 : 1; return; }
  const runId = values['run-id'];
  if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(runId ?? '')) throw Error('--run-id must be lower-case letters, digits and dashes');
  const runDir = path.join(root, 'runs', 'ab', runId);
  const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.LOCALAPPDATA ?? '', 'Apex', 'sol-oauth'));
  const concurrency = Number(values.concurrency);
  let meta;
  if (values.resume) {
    // --resume continues an interrupted run with its recorded settings, skipping attempts already in results.jsonl.
    meta = JSON.parse(readFileSync(path.join(runDir, 'meta.json'), 'utf8'));
    meta.resumedAt = [...(meta.resumedAt ?? []), new Date().toISOString()];
  } else {
    if (existsSync(runDir)) throw Error('Run directory exists; pick a new --run-id or pass --resume: ' + runDir);
    mkdirSync(runDir, {recursive: true});
    // --apex-root runs a frozen copy of Apex (with its apex-snapshot.json) so this tree can change during a long run.
    const apexRoot = path.resolve(values['apex-root'] ?? root);
    const snapshotFile = path.join(apexRoot, 'apex-snapshot.json');
    const apexSnapshot = existsSync(snapshotFile) ? JSON.parse(readFileSync(snapshotFile, 'utf8')) : undefined;
    const harness = apexSnapshot?.head ?? git(root, 'rev-parse', 'HEAD').stdout.trim();
    const dirty = apexSnapshot ? apexSnapshot.dirty : git(root, 'status', '--porcelain', '--', '.', ':(exclude).claude').stdout.trim() !== '';
    if (!/^[a-z0-9-]+\/[^/:\s]+$/.test(values.model)) throw Error('--model must be provider/id, for example anthropic/claude-sonnet-5-5');
    const maxUsd = values['max-usd'] === undefined ? null : Number(values['max-usd']);
    if (maxUsd !== null && !(maxUsd > 0)) throw Error('--max-usd must be a positive dollar amount');
    meta = {runId, model: values.model, thinking: values.thinking, maxUsd, arms: values.arms.split(','), attempts: Number(values.attempts),
      concurrency, timeoutMs: Number(values['timeout-min']) * 60000, tasks: (await loadTasks(values.tasks)).map(task => task.id),
      harnessCommit: harness, harnessDirty: dirty, apexRoot, apexSnapshot, startedAt: new Date().toISOString(), platform: process.platform};
    if (existsSync(path.join(apexRoot, 'apex-snapshot.patch'))) copyFileSync(path.join(apexRoot, 'apex-snapshot.patch'), path.join(runDir, 'apex-snapshot.patch'));
  }
  writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  const {arms, attempts, timeoutMs, apexRoot} = meta, tasks = await loadTasks(meta.tasks.join(','));
  const {withWindowsDefaults: defaults} = await import(pathToFileURL(path.join(apexRoot, 'lib', 'windows-target.mjs')).href);
  // Each selection option's flag names come from the same Apex copy, to place `apex+FLAG` arms.
  const groups = {};
  for (const [option, name, list] of [['--apex-context', 'apex-context', 'CONTEXT_FEATURES'], ['--apex-core', 'apex-core', 'CORE_FEATURES'],
    ['--apex-features', 'apex-features', 'FEATURE_FEATURES']]) groups[option] = (await import(pathToFileURL(path.join(apexRoot, 'extensions', name, 'config.mjs')).href))[list];
  // Resolve every arm once in a real task workspace, so a bad arm fails before any model call.
  const probe = workspace('arms');
  try { tasks[0].setup(probe); for (const arm of arms) armArgs(arm, {model: meta.model, thinking: meta.thinking, sessionDir: probe, prompt: 'probe', cwd: probe, defaults, groups}); }
  finally { cleanup(probe); }
  const resultsFile = path.join(runDir, 'results.jsonl');
  const previous = existsSync(resultsFile) ? readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const done = new Set(previous.map(row => `${row.task}/${row.arm}/${row.attempt}`));
  // Interleave arms so drift in provider latency or load hits both equally.
  const jobs = [];
  for (let n = 1; n <= attempts; n++) for (const task of tasks) for (const arm of (n % 2 ? arms : [...arms].reverse()))
    if (!done.has(`${task.id}/${arm}/${n}`)) jobs.push({task, arm, n});
  console.log(`A/B ${runId}: ${jobs.length} attempts${done.size ? ` (${done.size} already done)` : ''}, ${tasks.length} tasks × ${arms.join('/')} × ${attempts}, ${meta.model} at ${meta.thinking}, concurrency ${concurrency}`);
  // --max-usd (catalog estimate) stops launching once the spend so far plus one costliest-yet attempt per running slot
  // would pass it. ponytail: nothing is reserved before the first attempt finishes and running attempts are never killed,
  // so up to --concurrency attempts can run past the cap; use --concurrency 1 for a tight cap, kill-on-cap if that is too slow.
  let spent = previous.reduce((total, row) => total + (row.costUsd ?? 0), 0), worst = 0, running = 0, skipped = 0;
  await pool(jobs, concurrency, async job => {
    if (meta.maxUsd && spent + (running + 1) * worst > meta.maxUsd) { skipped++; return; }
    running++;
    let record;
    try { record = await attempt({...job, runDir, model: meta.model, thinking: meta.thinking, timeoutMs, agentDir, apexRoot, defaults, groups}); }
    catch (error) { record = {task: job.task.id, arm: job.arm, attempt: job.n, pass: false, harnessError: String(error?.stack ?? error)}; }
    appendFileSync(resultsFile, JSON.stringify(record) + '\n');
    running--; spent += record.costUsd ?? 0; worst = Math.max(worst, record.costUsd ?? 0);
    console.log(`${record.pass ? 'PASS' : 'fail'} ${job.task.id.padEnd(18)} ${job.arm.padEnd(5)} #${job.n}  ${(record.wallSec ?? 0).toFixed(0)}s  $${(record.costUsd ?? 0).toFixed(4)}  ${record.requests ?? 0} req  ${record.failed?.length ? '[' + record.failed.join(',') + ']' : ''}${record.harnessError ? ' HARNESS ' + record.harnessError.slice(0, 200) : ''}`);
    return record;
  });
  if (skipped) console.log(`Stopped at --max-usd $${meta.maxUsd}: $${spent.toFixed(2)} spent, ${skipped} attempts not run; --resume continues them under the same cap.`);
  writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({...meta, finishedAt: new Date().toISOString()}, null, 2) + '\n');
  // Usage first, so a report error cannot drop recorded spend.
  if (meta.model.startsWith('openai-codex/')) recordUsage(runDir, meta);
  else console.log(`Usage for ${meta.model} stays in ${path.relative(root, runDir)}; evals/codex-budget.json records Codex runs only.`);
  const {report} = await import('./report.mjs');
  const {markdown} = report(runDir);
  console.log(markdown);
}

/** Append this run's catalog-estimated usage to the Codex OAuth ledger (no cap; estimates, not billing). */
function recordUsage(runDir, meta) {
  const file = path.join(root, 'evals', 'codex-budget.json');
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  const rows = readFileSync(path.join(runDir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const cost = rows.reduce((total, row) => total + (row.costUsd ?? 0), 0);
  // A resumed run replaces its earlier entry instead of counting the same attempts twice.
  for (const previous of ledger.runs.filter(entry => entry.run_id === meta.runId)) ledger.observed_catalog_token_cost_usd -= previous.catalog_token_cost_usd;
  ledger.runs = ledger.runs.filter(entry => entry.run_id !== meta.runId);
  ledger.runs.push({run_id: meta.runId, purpose: `Live A/B: ${meta.arms.join(' vs ')}, ${meta.tasks.length} tasks × ${meta.attempts} attempts per arm`,
    thinking_level: meta.thinking, physical_requests: rows.reduce((total, row) => total + (row.requests ?? 0), 0),
    catalog_token_cost_usd: cost, billed_cost_usd: null, summary_file: path.relative(root, path.join(runDir, 'summary.json')).replace(/\\/g, '/'),
    benchmark_result: false, usage_complete: rows.every(row => !row.harnessError && row.requests > 0)});
  ledger.observed_catalog_token_cost_usd += cost;
  writeFileSync(file, JSON.stringify(ledger, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error?.stack ?? error); process.exitCode = 1; });
}
