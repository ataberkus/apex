// Dashboard session probe: bun dashboard-probe.mjs <checkout> <label>
// Starts the dashboard the way dashboard.bat does (Windows) or `bun dashboard/server.mjs` (elsewhere), opens a session on
// a fresh Git workspace with the Windows defaults, counts the bun processes under the dashboard, tries to send a prompt
// (no credentials exist here, so the dashboard should refuse it with a sign-in message), presses Stop (/api/stop, what the
// End session button posts), and reports the dashboard_exit code and any process left behind. Prints one JSON line.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const [checkout, label = 'checkout'] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: bun dashboard-probe.mjs <checkout> <label>');
const win = process.platform === 'win32';
const base = mkdtempSync(path.join(os.tmpdir(), 'apex-dash-probe-'));
const home = path.join(base, 'home'); const workspace = path.join(base, 'workspace');
mkdirSync(home); mkdirSync(workspace);
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'probe', GIT_AUTHOR_EMAIL: 'probe@example.invalid', GIT_COMMITTER_NAME: 'probe', GIT_COMMITTER_EMAIL: 'probe@example.invalid' };
writeFileSync(path.join(workspace, 'README.md'), '# probe\n');
for (const args of [['init', '-q'], ['add', '--all'], ['commit', '-q', '-m', 'probe']]) execFileSync('git', args, { cwd: workspace, env: gitEnv });
const port = 47800 + Math.floor(Math.random() * 100);
const env = { ...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent'), APEX_DASH_PORT: String(port) };
delete env.ANTHROPIC_API_KEY; delete env.OPENROUTER_API_KEY; delete env.OPENAI_API_KEY;
const launcher = win ? spawn('cmd.exe', ['/d', '/c', path.join(checkout, 'dashboard.bat')], { cwd: checkout, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  : spawn(process.execPath, [path.join(checkout, 'dashboard', 'server.mjs')], { cwd: checkout, env, stdio: ['ignore', 'pipe', 'pipe'] });
let launcherOut = '';
launcher.stderr.on('data', chunk => { launcherOut += chunk; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { label, platform: process.platform, bun: process.versions.bun };

function processes() {
  if (win) {
    const out = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(out).map(p => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, args: p.CommandLine ?? '' }));
  }
  return execFileSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const [, pid, ppid, name, args] = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line); return { pid: Number(pid), ppid: Number(ppid), name, args };
  });
}
const descendants = (all, root) => { const out = []; const queue = [root]; while (queue.length) { const pid = queue.shift(); for (const p of all) if (p.ppid === pid && p.pid !== pid) { out.push(p); queue.push(p.pid); } } return out; };
const isBun = p => /^bun(\.exe)?$/i.test(p.name);
const brief = p => ({ pid: p.pid, ppid: p.ppid, name: p.name, args: p.args.replace(/\s+/g, ' ').slice(0, 160) });

function call(method, route, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: route, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end(body);
  });
}

let exitCode = 1;
try {
  const token = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dashboard did not start: ${launcherOut}`)), 60000);
    let out = '';
    launcher.stdout.on('data', chunk => { out += chunk; const match = /\?t=(\S+)/.exec(out); if (match) { clearTimeout(timer); resolve(match[1]); } });
    launcher.once('exit', code => reject(new Error(`launcher exited ${code}: ${out}${launcherOut}`)));
  });
  const login = await call('GET', `/?t=${token}`);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const headers = { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
  const post = (route, payload) => call('POST', route, { headers, body: JSON.stringify(payload) });
  const added = JSON.parse((await post('/api/workspaces', { path: workspace })).text);
  const state = JSON.parse((await call('GET', '/api/state', { headers: { cookie } })).text);
  const listed = state.workspaces.find(entry => entry.path === added.path);
  const model = state.models.find(entry => entry.apex && entry.target) ?? state.models.find(entry => entry.id === 'muse');
  const selection = model.id === 'muse' ? {} : { ...state.defaults, features: [...state.defaults.features, ...(listed?.checkpoints ? ['checkpoints'] : [])] };
  report.start = { model: model.id, selection, checkpointsUsable: listed?.checkpoints };
  const all0 = processes();
  const server = all0.find(p => isBun(p) && /dashboard[\\/]server\.mjs/.test(p.args) && descendants(all0, launcher.pid).some(d => d.pid === p.pid)) ?? all0.find(p => p.pid === launcher.pid);
  report.serverChain = all0.filter(p => p.pid === launcher.pid || descendants(all0, launcher.pid).some(d => d.pid === p.pid)).map(brief);
  const started = performance.now();
  const response = await post('/api/start', { cwd: added.path, model: model.id, thinking: model.levels?.includes('medium') ? 'medium' : undefined, ...selection });
  if (response.status !== 200) throw new Error(`start ${response.status}: ${response.text}`);
  const { id } = JSON.parse(response.text);
  const events = [];
  const stream = http.get({ host: '127.0.0.1', port, path: `/api/events?id=${id}`, headers: { host: `127.0.0.1:${port}`, cookie } }, res => {
    let buffered = ''; res.setEncoding('utf8');
    res.on('data', chunk => { buffered += chunk; let end; while ((end = buffered.indexOf('\n\n')) >= 0) { const line = buffered.slice(0, end).replace(/^data: /, ''); buffered = buffered.slice(end + 2); try { events.push({ at: performance.now() - started, event: JSON.parse(line) }); } catch {} } });
  });
  stream.on('error', () => {});
  const waitFor = async (predicate, ms) => { const until = performance.now() + ms; while (performance.now() < until) { const hit = events.find(entry => predicate(entry.event)); if (hit) return hit; await sleep(50); } return undefined; };
  const ready = await waitFor(event => event.type === 'response' && event.id === 'state', 60000);
  report.firstStateResponseMs = ready ? Math.round(ready.at) : null;
  if (!ready) report.stderrAtTimeout = JSON.parse((await call('GET', '/api/state', { headers: { cookie } })).text).workspaces.flatMap(w => w.live).map(s => s.stderr ?? s.status);
  const all1 = processes();
  const under = descendants(all1, server.pid);
  report.liveSession = { serverPid: server.pid, bunProcessesUnderServer: under.filter(isBun).length, processesUnderServer: under.map(brief) };
  const send = await post('/api/send', { id, message: 'Reply with the single word: ok' });
  report.send = { status: send.status, text: send.text.slice(0, 200) };
  const stopAt = performance.now();
  const stop = await post('/api/stop', { id });
  report.stop = { status: stop.status };
  const exit = await waitFor(event => event.type === 'dashboard_exit', 20000);
  report.stop.dashboardExit = exit ? { code: exit.event.code, afterStopMs: Math.round(exit.at - (stopAt - started)), stderr: String(exit.event.stderr ?? '').slice(-300) } : null;
  await sleep(1500);
  const all2 = processes();
  const pids = new Set(under.map(p => p.pid));
  report.afterStop = { survivors: all2.filter(p => pids.has(p.pid)).map(brief), bunProcessesUnderServer: descendants(all2, server.pid).filter(isBun).length };
  const after = JSON.parse((await call('GET', '/api/state', { headers: { cookie } })).text);
  report.afterStop.liveSessions = after.workspaces.flatMap(w => w.live).map(s => ({ id: s.id, status: s.status }));
  stream.destroy();
  exitCode = 0;
} catch (error) {
  report.error = String(error?.stack ?? error).slice(0, 2000);
} finally {
  if (win) { try { execFileSync('taskkill', ['/T', '/F', '/PID', String(launcher.pid)], { stdio: 'ignore' }); } catch {} } else launcher.kill();
  await sleep(1000);
  try { rmSync(base, { recursive: true, force: true, maxRetries: 5 }); } catch {}
}
console.log(JSON.stringify(report));
process.exit(exitCode);
