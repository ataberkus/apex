// Prints the results directory as compact RESULT lines for the job log: bun summarize.mjs <results>
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ?? 'results';
const read = name => existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), 'utf8') : undefined;
const jsonl = name => (read(name) ?? '').split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('{')).map(line => { try { return JSON.parse(line); } catch { return { unparsed: line.slice(0, 200) }; } });
const out = (tag, value) => console.log(`RESULT ${tag} ${typeof value === 'string' ? value : JSON.stringify(value)}`);

if (read('machine.json')) out('machine', JSON.parse(read('machine.json')));
for (const name of ['check.txt', 'micro.txt', 'smoke.txt', 'micro-smoke.txt']) if (read(name)) out(name, read(name).trim().split(/\r?\n/).join(' | '));

const suites = readdirSync(dir).filter(name => name.endsWith('.json') && name !== 'machine.json').map(name => JSON.parse(read(name))).filter(entry => entry.cases);
for (const suite of suites) {
  const { cases, slowest, ...rest } = suite;
  out(`suite ${suite.label}`, { ...rest, timeoutLines: rest.timeoutLines.length ? rest.timeoutLines : undefined, slowest });
}
const base = suites.find(entry => entry.label === 'base-default'), branch = suites.find(entry => entry.label === 'branch-default');
if (base && branch) {
  const key = entry => `${entry.file.replaceAll('\\', '/')} :: ${entry.name}`;
  const before = new Map(base.cases.map(entry => [key(entry), entry.outcome]));
  const after = new Map(branch.cases.map(entry => [key(entry), entry.outcome]));
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(name => before.get(name) !== after.get(name)).map(name => ({ test: name, base: before.get(name) ?? 'absent', branch: after.get(name) ?? 'absent' }));
  out('diff onlyOnBranchFails', changed.filter(entry => entry.branch === 'fail'));
  out('diff skipChanges', changed.filter(entry => entry.base === 'skip' || entry.branch === 'skip'));
  out('diff newOrRemoved', { addedOnBranch: changed.filter(entry => entry.base === 'absent').length, removedOnBranch: changed.filter(entry => entry.branch === 'absent').length });
  out('diff skippedOnBranch', branch.cases.filter(entry => entry.outcome === 'skip').map(key));
}
const parallel = suites.filter(entry => /^p\d-run\d$/.test(entry.label));
if (parallel.length) {
  const by = {};
  for (const run of parallel) (by[run.parallel] ??= []).push(run);
  for (const [p, runs] of Object.entries(by)) {
    const walls = runs.map(run => run.wallSeconds).sort((a, b) => a - b);
    out(`parallel ${p}`, { runs: runs.map(run => ({ label: run.label, status: run.status, wall: run.wallSeconds, ...run.counts, failures: run.failures.map(f => `${f.file} :: ${f.name}`), timeoutLines: run.timeoutLines.length })), medianWall: walls[walls.length >> 1] });
  }
}
for (const row of jsonl('checkpoints.jsonl')) { const { rows, ...rest } = row; out('checkpoints', { ...rest, perTurn: rows?.map(r => [r.turn, r.capture, r.repeat, r.finish, r.status]) }); }
for (const row of jsonl('dashboard.jsonl')) out('dashboard', row);
for (const row of jsonl('kill.jsonl')) out('kill', row);
for (const row of jsonl('stop.jsonl')) out('stop', row);
for (const row of jsonl('ps.jsonl')) out('powershell', row);
