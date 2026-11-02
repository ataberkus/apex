// Runs `bun run test:windows` (or `bun run test` off Windows) in a checkout and records wall time plus the named
// pass/skip/fail sets: bun run-suite.mjs <checkout> <label> <outdir> [APEX_TEST_PARALLEL]
// A temporary bunfig.toml adds Bun's JUnit reporter (parallel runs print no per-test lines); it is removed afterwards.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import path from 'node:path';

const [checkout, label, outdir, parallel] = process.argv.slice(2);
if (!checkout || !label || !outdir) throw new Error('Usage: bun run-suite.mjs <checkout> <label> <outdir> [parallel]');
mkdirSync(outdir, { recursive: true });
const junit = path.resolve(outdir, `${label}.junit.xml`);
const bunfig = path.join(checkout, 'bunfig.toml');
if (existsSync(bunfig)) throw new Error(`${bunfig} already exists; refusing to overwrite it`);
writeFileSync(bunfig, `[test.reporter]\njunit = ${JSON.stringify(junit)}\n`);
rmSync(junit, { force: true });
const env = { ...process.env };
if (parallel) env.APEX_TEST_PARALLEL = parallel; else delete env.APEX_TEST_PARALLEL;
const log = createWriteStream(path.resolve(outdir, `${label}.log`));
const started = performance.now();
let output = '';
const status = await new Promise(resolve => {
  const child = spawn(process.execPath, ['run', process.platform === 'win32' ? 'test:windows' : 'test'], { cwd: checkout, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; log.write(chunk); process.stdout.write(chunk); });
  child.once('error', error => { output += String(error); resolve(null); });
  child.once('close', code => resolve(code));
});
const wallSeconds = Math.round((performance.now() - started) / 100) / 10;
await new Promise(resolve => log.end(resolve));
rmSync(bunfig, { force: true });

const decode = text => text.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const attr = (attrs, name) => { const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs); return match ? decode(match[1]) : ''; };
const cases = [];
if (existsSync(junit)) {
  const xml = readFileSync(junit, 'utf8');
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const body = match[2] ?? '';
    const failure = /<(failure|error)\b([^>]*)>?/.exec(body);
    cases.push({ file: attr(match[1], 'file'), name: attr(match[1], 'name'), time: Number(attr(match[1], 'time')) || 0,
      outcome: failure ? 'fail' : /<skipped\b/.test(body) ? 'skip' : /<todo\b/.test(body) ? 'todo' : 'pass',
      ...(failure ? { message: decode(attr(failure[2], 'message') || body.replace(/<[^>]+>/g, ' ')).slice(0, 400) } : {}) });
  }
}
const count = outcome => cases.filter(entry => entry.outcome === outcome).length;
const timeoutLines = output.split(/\r?\n/).filter(line => /watchdog|timed out|deadline|ETIMEDOUT|timeout/i.test(line) && !/--timeout=/.test(line)).slice(0, 40);
const summary = { label, parallel: parallel ?? 'default', status, wallSeconds, junit: existsSync(junit),
  counts: { pass: count('pass'), skip: count('skip'), fail: count('fail'), todo: count('todo'), total: cases.length },
  bunSummary: output.split(/\r?\n/).filter(line => /^\s*\d+ (pass|skip|fail|todo)\b|^Ran \d+ tests/.test(line)),
  failures: cases.filter(entry => entry.outcome === 'fail').map(({ file, name, message }) => ({ file, name, message })),
  timeoutLines, slowest: [...cases].sort((a, b) => b.time - a.time).slice(0, 8).map(({ file, name, time }) => ({ file, name, seconds: Math.round(time * 10) / 10 })) };
writeFileSync(path.resolve(outdir, `${label}.json`), JSON.stringify({ ...summary, cases: cases.map(({ file, name, outcome }) => ({ file, name, outcome })) }, null, 1));
console.log(`\nSUITE-SUMMARY ${JSON.stringify(summary)}`);
process.exit(0);
