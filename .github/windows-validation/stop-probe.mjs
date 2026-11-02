// How long Pi takes to exit after its stdin closes (what the dashboard's Stop does first), with no 5 s kill fallback:
// bun stop-probe.mjs <checkout>. Variants isolate Bun's pipe EOF, stock Pi, the bare Windows target and the dashboard's
// default Apex selection. Prints one JSON line.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const checkout = path.resolve(process.argv[2] ?? '.');
const { buildPiInvocation, resolvePi } = await import(pathToFileURL(path.join(checkout, 'lib', 'launcher.mjs')).href);
const { withWindowsDefaults } = await import(pathToFileURL(path.join(checkout, 'lib', 'windows-target.mjs')).href);
const base = await realpath(mkdtempSync(path.join(os.tmpdir(), 'apex-stop-probe-')));
const workspace = path.join(base, 'workspace'); mkdirSync(workspace);
writeFileSync(path.join(workspace, 'README.md'), '# probe\n');
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'probe', GIT_AUTHOR_EMAIL: 'probe@example.invalid', GIT_COMMITTER_NAME: 'probe', GIT_COMMITTER_EMAIL: 'probe@example.invalid' };
for (const args of [['init', '-q'], ['add', '--all'], ['commit', '-q', '-m', 'probe']]) execFileSync('git', args, { cwd: workspace, env: gitEnv });
const env = { ...process.env, PI_CODING_AGENT_DIR: path.join(base, 'agent') };
const route = ['--provider', 'anthropic', '--model', 'claude-opus-5-5', '--thinking', 'medium', '--mode', 'rpc'];
const pi = args => { const built = buildPiInvocation(withWindowsDefaults(args, { cwd: workspace }), resolvePi().cli); return [built.cli, ...built.args]; };
const win = process.platform === 'win32';
const variants = {
  'bare-bun-end': ['-e', 'process.stdin.on("end", () => process.exit(0)); process.stdin.resume(); process.stdout.write(JSON.stringify({type:"response",id:"state"})+"\\n")'],
  'pi-stock': pi(['--apex-off', ...route]),
  ...(win ? { 'pi-target-bare': pi(['--apex-target', 'windows', ...route]),
    'pi-dashboard-defaults': pi(['--apex-target', 'windows', '--apex-context', 'cache', '--apex-core', 'correct', '--apex-features', 'cost,plan,report,resume,autocompact,checkpoints', ...route]) } : {}),
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function probe(name, args) {
  const child = spawn(process.execPath, args, { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '', closed;
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1500); });
  const done = new Promise(resolve => child.once('close', (code, signal) => { closed = { code, signal }; resolve(); }));
  const started = performance.now();
  child.stdin.write(JSON.stringify({ id: 'state', type: 'get_state' }) + '\n');
  while (!/"id":"state"/.test(stdout) && !closed && performance.now() - started < 60000) await sleep(25);
  const readyMs = Math.round(performance.now() - started);
  if (closed) return { name, readyMs, earlyExit: closed, stderr };
  const before = performance.now();
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 60000);
  await done; clearTimeout(timer);
  return { name, readyMs, exitAfterEofMs: Math.round(performance.now() - before), ...closed, killedAt60s: closed.signal !== null, stderr: stderr.trim().slice(-600) };
}
const results = [];
for (let round = 1; round <= 2; round++) for (const [name, args] of Object.entries(variants)) results.push({ round, ...(await probe(name, args)) });
console.log(JSON.stringify({ platform: process.platform, bun: process.versions.bun, checkout: path.basename(checkout), results }));
try { rmSync(base, { recursive: true, force: true, maxRetries: 5 }); } catch {}
