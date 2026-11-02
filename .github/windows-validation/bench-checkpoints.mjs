// Checkpoint timing, one version per process: bun bench-checkpoints.mjs <checkpoints.mjs> <label> [turns]
// Builds a fresh Git repository of 2,000 files / 16 MB, waits 2 s, then per turn times capture(id), a repeat capture(id),
// an edit to one file and finish(id). Prints one JSON line; medians are over turns 2..N.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [moduleFile, label = path.basename(path.dirname(path.dirname(path.dirname(moduleFile ?? '.')))), turnsText = '8'] = process.argv.slice(2);
if (!moduleFile) throw new Error('Usage: bun bench-checkpoints.mjs <checkpoints.mjs> <label> [turns]');
const turns = Number(turnsText);
const FILES = 2000, DIRS = 40, BYTES = 16 * 1024 * 1024, PER_FILE = BYTES / FILES;

// Deterministic, mostly-text content (mulberry32), so every run and version sees identical bytes.
let seed = 0x5eed;
const random = () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const WORDS = 'const let function return await async import export from class extends if else for while switch case break value result error index buffer stream promise resolve reject'.split(' ');
function content(size) {
  const parts = []; let length = 0;
  while (length < size) { const line = Array.from({ length: 4 + Math.floor(random() * 10) }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' ') + ` // ${Math.floor(random() * 1e9).toString(36)}\n`; parts.push(line); length += line.length; }
  return parts.join('').slice(0, size);
}

// realpath: a Windows TEMP given as an 8.3 short name (RUNNER~1) is refused as a symlink ancestor.
const base = await realpath(mkdtempSync(path.join(os.tmpdir(), 'apex-cp-bench-'))); // the same realpath validateRoot uses
const cwd = path.join(base, 'repo');
mkdirSync(cwd);
const git = args => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@example.invalid', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@example.invalid' } });
const files = [];
for (let index = 0; index < FILES; index++) {
  const dir = path.join(cwd, `pkg${String(index % DIRS).padStart(2, '0')}`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `module${String(index).padStart(4, '0')}.js`);
  // Sizes vary 0.25x..1.75x around the mean, so the total stays ~16 MB.
  writeFileSync(file, content(Math.round(PER_FILE * (0.25 + 1.5 * random()))));
  files.push(file);
}
git(['init', '-q']);
git(['-c', 'core.autocrlf=false', 'add', '--all']);
git(['-c', 'core.autocrlf=false', 'commit', '-q', '-m', 'fixture']);
await new Promise(resolve => setTimeout(resolve, 2000));

const { createCheckpointManager } = await import(pathToFileURL(path.resolve(moduleFile)).href);
const manager = createCheckpointManager({ cwd, sessionId: `bench-${label}` });
const time = async fn => { const start = performance.now(); const value = await fn(); return [performance.now() - start, value]; };
const rows = [];
for (let turn = 1; turn <= turns; turn++) {
  const id = `turn-${turn}`;
  const [capture] = await time(() => manager.capture(id));
  const [repeat] = await time(() => manager.capture(id));
  const [edit] = await time(async () => appendFileSync(files[(turn * 37) % FILES], `// edit ${turn}\n`));
  const [finish, finished] = await time(() => manager.finish(id));
  rows.push({ turn, capture, repeat, edit, finish, status: finished.status, changed: finished.changedPaths?.length });
}
await manager.shutdown?.();
const median = values => { const sorted = [...values].sort((a, b) => a - b); const mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
const later = rows.slice(1);
const round = value => Math.round(value * 10) / 10;
const summary = { label, platform: process.platform, bun: process.versions.bun, cpus: os.availableParallelism(), turns,
  first: { capture: round(rows[0].capture), finish: round(rows[0].finish) },
  median_from_turn_2: Object.fromEntries(['capture', 'repeat', 'finish'].map(key => [key, round(median(later.map(row => row[key])))])),
  statuses: [...new Set(rows.map(row => `${row.status}:${row.changed}`))],
  rows: rows.map(row => ({ ...row, capture: round(row.capture), repeat: round(row.repeat), edit: round(row.edit), finish: round(row.finish) })) };
console.log(JSON.stringify(summary));
try { rmSync(base, { recursive: true, force: true, maxRetries: 5 }); } catch (error) { console.error(`cleanup: ${error.message}`); }
