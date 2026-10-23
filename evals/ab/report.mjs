#!/usr/bin/env bun
/** Summarize runs/ab/<run-id>/results.jsonl: per-arm totals and, for every pair of arms, paired per-task deltas with bootstrap CIs over tasks. */
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
const sum = values => values.reduce((total, value) => total + value, 0);

/** Wilson score interval for k successes out of n. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [NaN, NaN];
  const p = k / n, denominator = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / denominator, half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Percentile bootstrap of statistic(sample) over resampled tasks; seeded so reports are reproducible. */
export function bootstrap(items, statistic, {resamples = 10000, seed = 12345} = {}) {
  let state = seed;
  const random = () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const values = [];
  for (let r = 0; r < resamples; r++) values.push(statistic(Array.from(items, () => items[Math.floor(random() * items.length)])));
  values.sort((a, b) => a - b);
  return [values[Math.floor(resamples * 0.025)], values[Math.floor(resamples * 0.975)]];
}

const fmt = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
const pct = value => Number.isFinite(value) ? (value * 100).toFixed(0) + '%' : 'n/a';
const signedPct = value => Number.isFinite(value) ? (value >= 0 ? '+' : '') + (value * 100).toFixed(0) + '%' : 'n/a';

export function report(runDir) {
  const rows = readFileSync(path.join(runDir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const meta = JSON.parse(readFileSync(path.join(runDir, 'meta.json'), 'utf8'));
  const arms = meta.arms;
  const valid = rows.filter(row => !row.harnessError);
  const byArm = Object.fromEntries(arms.map(arm => [arm, valid.filter(row => row.arm === arm)]));
  const tasks = [...new Set(valid.map(row => row.task))].sort();

  const armStats = Object.fromEntries(arms.map(arm => {
    const list = byArm[arm], passes = list.filter(row => row.pass).length, cost = sum(list.map(row => row.costUsd));
    return [arm, {attempts: list.length, passes, passRate: passes / list.length, passCI: wilson(passes, list.length), totalCostUsd: cost,
      costPerSolvedUsd: passes ? cost / passes : NaN, meanCostUsd: mean(list.map(row => row.costUsd)), meanWallSec: mean(list.map(row => row.wallSec)),
      meanRequests: mean(list.map(row => row.requests)), meanInput: mean(list.map(row => row.input)), meanCacheRead: mean(list.map(row => row.cacheRead)),
      meanOutput: mean(list.map(row => row.output)), meanReasoning: mean(list.map(row => row.reasoning)), meanPeakContext: mean(list.map(row => row.peakContext)),
      meanToolCalls: mean(list.map(row => row.toolCalls)), toolErrorRate: sum(list.map(row => row.toolErrors)) / Math.max(1, sum(list.map(row => row.toolCalls))),
      timeouts: list.filter(row => row.timedOut).length, compactions: sum(list.map(row => row.compactions ?? 0)),
      cacheHitRate: sum(list.map(row => row.cacheRead)) / Math.max(1, sum(list.map(row => row.cacheRead + row.input + row.cacheWrite)))}];
  }));

  const taskMean = (arm, task, key) => mean(byArm[arm].filter(row => row.task === task).map(row => typeof row[key] === 'boolean' ? Number(row[key]) : row[key]));
  const tokens = (arm, task) => taskMean(arm, task, 'input') + taskMean(arm, task, 'cacheRead') + taskMean(arm, task, 'output');
  const passDelta = list => mean(list.map(pair => pair.pass[1] - pair.pass[0]));
  const logRatio = key => list => mean(list.map(pair => Math.log(pair[key][1] / pair[key][0])));
  // Every later arm against every earlier one, on paired per-task means: each task contributes one pair regardless of attempt count.
  const comparisons = arms.flatMap((base, i) => arms.slice(i + 1).map(treat => {
    const both = value => [value(base), value(treat)];
    const paired = tasks.map(task => ({task, pass: both(arm => taskMean(arm, task, 'pass')), cost: both(arm => taskMean(arm, task, 'costUsd')),
      wall: both(arm => taskMean(arm, task, 'wallSec')), tokens: both(arm => tokens(arm, task)), requests: both(arm => taskMean(arm, task, 'requests'))}))
      .filter(pair => pair.pass.every(Number.isFinite));
    const deltas = {
      passRate: {estimate: passDelta(paired), ci: bootstrap(paired, passDelta)},
      ...Object.fromEntries(['cost', 'wall', 'tokens', 'requests'].map(key => {
        const usable = paired.filter(pair => pair[key][0] > 0 && pair[key][1] > 0);
        const [low, high] = bootstrap(usable, logRatio(key));
        return [key, {ratio: Math.exp(logRatio(key)(usable)), ci: [Math.exp(low), Math.exp(high)], tasks: usable.length}];
      })),
    };
    return {base, treat, paired, deltas};
  }));

  const lines = [];
  lines.push(`## A/B ${meta.runId}: ${arms.join(' vs ')}`, '',
    `${meta.model} at thinking ${meta.thinking}; ${tasks.length} tasks × ${meta.attempts} attempts per arm; harness ${meta.harnessCommit?.slice(0, 7)}${meta.harnessDirty ? ' (dirty tree)' : ''}${meta.apexSnapshot ? `, snapshot ${meta.apexSnapshot.treeSha256.slice(0, 12)}` : ''}. ` +
    `Costs are Pi catalog estimates, not billing. CIs: Wilson for pass rates, paired bootstrap over tasks for deltas.`, '',
    `| Metric | ${arms.join(' | ')} |`, `|---|${'---:|'.repeat(arms.length)}`);
  const row = (label, f) => lines.push(`| ${label} | ${arms.map(arm => f(armStats[arm])).join(' | ')} |`);
  row('Passed', s => `${s.passes}/${s.attempts} (${pct(s.passRate)}, CI ${pct(s.passCI[0])}–${pct(s.passCI[1])})`);
  row('Timeouts', s => String(s.timeouts));
  row('Total catalog cost', s => '$' + fmt(s.totalCostUsd, 3));
  row('Cost per solved task', s => '$' + fmt(s.costPerSolvedUsd, 4));
  row('Mean cost per attempt', s => '$' + fmt(s.meanCostUsd, 4));
  row('Mean wall time', s => fmt(s.meanWallSec, 0) + ' s');
  row('Mean model requests', s => fmt(s.meanRequests, 1));
  row('Mean uncached input tokens', s => fmt(s.meanInput, 0));
  row('Mean cache-read tokens', s => fmt(s.meanCacheRead, 0));
  row('Mean output tokens (incl. reasoning)', s => fmt(s.meanOutput, 0));
  row('Mean reasoning tokens', s => fmt(s.meanReasoning, 0));
  row('Cache hit rate', s => pct(s.cacheHitRate));
  row('Mean peak context', s => fmt(s.meanPeakContext, 0));
  row('Mean tool calls', s => fmt(s.meanToolCalls, 1));
  row('Tool error rate', s => pct(s.toolErrorRate));
  row('Compactions', s => String(s.compactions));
  for (const {base, treat, paired, deltas} of comparisons) lines.push('', `**Paired deltas (${treat} relative to ${base}, ${paired.length} tasks):** pass rate ${signedPct(deltas.passRate.estimate)} ` +
    `(CI ${signedPct(deltas.passRate.ci[0])} to ${signedPct(deltas.passRate.ci[1])}); ` +
    ['cost', 'tokens', 'wall', 'requests'].map(key => `${key} ×${fmt(deltas[key].ratio)} (CI ×${fmt(deltas[key].ci[0])}–×${fmt(deltas[key].ci[1])})`).join('; ') +
    '. A CI that crosses 0 (or ×1.00) is inconclusive.');
  const columns = [['pass', (arm, task) => pct(taskMean(arm, task, 'pass'))], ['$', (arm, task) => fmt(taskMean(arm, task, 'costUsd'), 4)],
    ['s', (arm, task) => fmt(taskMean(arm, task, 'wallSec'), 0)]];
  lines.push('', `| Task | ${columns.flatMap(([unit]) => arms.map(arm => `${arm} ${unit}`)).join(' | ')} |`, `|---|${'---:|'.repeat(columns.length * arms.length)}`);
  for (const task of tasks) lines.push(`| ${task} | ${columns.flatMap(([, cell]) => arms.map(arm => cell(arm, task))).join(' | ')} |`);
  const failures = valid.filter(row => !row.pass).map(row => `- ${row.task} / ${row.arm} #${row.attempt}: ${row.timedOut ? 'timeout' : (row.failed ?? []).join(', ') || 'unknown'}`);
  if (failures.length) lines.push('', '**Failed attempts**', ...failures);
  const harness = rows.filter(row => row.harnessError);
  if (harness.length) lines.push('', `**Harness errors (excluded):** ${harness.length}`);
  const summary = {meta, armStats, comparisons, failures: valid.filter(row => !row.pass).map(row => ({task: row.task, arm: row.arm, attempt: row.attempt, failed: row.failed, timedOut: row.timedOut})), harnessErrors: harness.length};
  writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  const markdown = lines.join('\n') + '\n';
  writeFileSync(path.join(runDir, 'report.md'), markdown);
  return {summary, markdown};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: bun evals/ab/report.mjs runs/ab/<run-id>'); process.exitCode = 2; }
  else console.log(report(path.resolve(dir)).markdown);
}
