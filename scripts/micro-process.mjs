import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINNED_PI_VERSION } from './micro-session.mjs';

// A tool mechanics check: no AgentSession, model, auth store, or provider call.
// Only the CLI main path allocates resources; importing this module is inert.
const script = fileURLToPath(import.meta.url);
const allowedHostEnv = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'];
const serviceWatchdogMs = 3500;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

async function executable(candidates) {
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return path.resolve(candidate); } catch {}
  }
  return null;
}

const serviceSource = `
import http from 'node:http';
import {writeFileSync} from 'node:fs';
const token = process.argv[2];
const allowed = ['PATH','HOME','TMPDIR','LANG','LC_ALL','PWD','SHLVL','_'];
let stopping = false;
function stop(reason) {
  if (stopping) return;
  stopping = true;
  try { writeFileSync('stopped.json', JSON.stringify({pid:process.pid,reason})); }
  finally { process.exit(0); }
}
process.on('SIGTERM', () => stop('SIGTERM'));
// A parent crash or failed cleanup cannot leave a persistent service.
setTimeout(() => stop('watchdog'), ${serviceWatchdogMs});
const server = http.createServer((req,res) => {
  if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(403).end(); return; }
  if (req.method === 'GET' && req.url === '/health') {
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({pid:process.pid,cwd:process.cwd(),
      environment_sanitized:Object.keys(process.env).every(name => allowed.includes(name))}));
  } else if (req.method === 'POST' && req.url === '/shutdown') {
    res.writeHead(202, {'content-type':'application/json'});
    res.end(JSON.stringify({pid:process.pid}), () => setImmediate(() => process.kill(process.pid,'SIGTERM')));
  } else { res.writeHead(404).end(); }
});
server.on('error', () => stop('startup-error'));
server.listen(0,'127.0.0.1', () => writeFileSync('ready.json',JSON.stringify({
  pid:process.pid,port:server.address().port,address:server.address().address})));
`;

function request(info, token, route, method = 'GET') {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error); else resolve(value);
    };
    const req = http.request({hostname: '127.0.0.1', port: info.port, path: route,
      method, agent: false, headers: {authorization: `Bearer ${token}`}}, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 2048) req.destroy(); });
      res.on('end', () => {
        try {
          if (res.statusCode !== (route === '/shutdown' ? 202 : 200)) throw new Error('unexpected_http_status');
          finish(null, JSON.parse(body));
        } catch (error) { finish(error); }
      });
      res.on('error', finish);
      res.on('aborted', () => finish(new Error('loopback_response_aborted')));
    });
    const deadline = setTimeout(() => {
      req.destroy();
      finish(new Error('loopback_timeout'));
    }, 300);
    req.on('error', finish);
    req.end();
  });
}

async function toolHost(spec) {
  const {createBashTool} = await import('@earendil-works/pi-coding-agent');
  const tool = createBashTool(spec.fixture, {shellPath: spec.bash, exposeSessionEnvironment: false});
  const command = `${quote(spec.setsid)} ${quote(spec.nohup)} ${quote(spec.runtime)} server.mjs ${quote(spec.token)} < /dev/null > server.log 2>&1 &\nprintf '%s\\n' "$!" > launch.pid`;
  const result = await tool.execute('phase0-process-micro', {command, timeout: 2}, undefined, undefined);
  await writeFile(path.join(spec.fixture, 'host.json'), JSON.stringify({
    environment_sanitized: Object.keys(process.env).every(name => allowedHostEnv.includes(name)),
    native_bash_exit_code: result.structuredContent?.exit_code,
    native_bash_is_error: result.isError === true,
  }));
  if (result.isError || result.structuredContent?.exit_code !== 0) process.exitCode = 1;
  // Natural runtime exit proves that neither the native tool nor service holds the host open.
}

function waitHost(child) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL'); // Only this directly spawned tool host; never a bare service PID.
      finish({exit_code: null, signal: 'SIGKILL', timed_out: true});
    }, 4000);
    child.once('error', () => finish({exit_code: null, spawn_failed: true}));
    child.once('close', (exit_code, signal) => finish({exit_code, signal}));
  });
}

async function waitReady(fixture, milliseconds) {
  const deadline = Date.now() + milliseconds;
  do {
    try {
      const info = await readJson(path.join(fixture, 'ready.json'));
      if (Number.isInteger(info.pid) && info.pid > 1 && Number.isInteger(info.port) &&
          info.port > 0 && info.port <= 65535 && info.address === '127.0.0.1') return info;
    } catch {}
    await pause(25);
  } while (Date.now() < deadline);
  return null;
}

async function cleanService(fixture, info, token) {
  // The authenticated fixture service signals process.pid itself. A reused PID
  // cannot cause a signal to an unrelated process, including on repeated cleanup.
  if (!info) return {owned_pid_only: true, process_terminated: false, health_unavailable: false};
  try {
    const reply = await request(info, token, '/shutdown', 'POST');
    if (reply.pid !== info.pid) throw new Error('shutdown_identity_mismatch');
  } catch {}
  const deadline = Date.now() + 1000;
  let terminated = false;
  let unavailable = false;
  do {
    try {
      const stopped = await readJson(path.join(fixture, 'stopped.json'));
      terminated = stopped.pid === info.pid && stopped.reason === 'SIGTERM';
    } catch {}
    try { await request(info, token, '/health'); unavailable = false; } catch { unavailable = true; }
    if (terminated && unavailable) break;
    await pause(25);
  } while (Date.now() < deadline);
  return {owned_pid_only: true, process_terminated: terminated && unavailable,
    health_unavailable: unavailable, method: 'authenticated self-SIGTERM'};
}

export async function runProcessMicro() {
  const started = Date.now();
  const artifact = {kind: 'offline_process_contract', status: 'FAIL',
    proof: 'service survives native tool-host exit', platform: process.platform,
    provider_calls: 0, network_scope: 'ephemeral loopback HTTP only',
    host: {exited_successfully: false}, post_exit_health: {succeeded: false}, cleanup: {}};
  const skip = reason => ({...artifact, status: 'SKIP', skip_reason: reason,
    elapsed_ms: Date.now() - started});
  if (process.platform !== 'linux') return skip('requires Linux setsid and nohup');
  // The service and tool host run on the current JavaScript runtime (Bun), never a separately installed Node.
  const runtime = await executable(path.isAbsolute(process.execPath) ? [process.execPath] :
    (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, process.execPath)));
  const bash = await executable(['/bin/bash', '/usr/bin/bash']);
  const setsid = await executable(['/usr/bin/setsid', '/bin/setsid']);
  const nohup = await executable(['/usr/bin/nohup', '/bin/nohup']);
  if (!runtime || !bash || !setsid || !nohup) return skip('required runtime/bash/setsid/nohup executable missing');
  let piVersion;
  try {
    const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
    piVersion = (await readJson(path.resolve(path.dirname(entry), '../package.json'))).version;
  } catch { return skip('native Pi package unavailable'); }
  if (piVersion !== PINNED_PI_VERSION) return skip(`requires pinned native Pi ${PINNED_PI_VERSION}`);
  artifact.pi_version = piVersion;
  const fixture = await mkdtemp(path.join(process.cwd(), 'process-micro-'));
  const token = randomUUID();
  let info = null;
  let watchdogDeadline = Date.now() + 4000 + serviceWatchdogMs + 250;
  artifact.fixture = fixture;
  try {
    await writeFile(path.join(fixture, 'server.mjs'), serviceSource);
    const spec = {fixture, token, runtime, bash, setsid, nohup};
    const env = {PATH: `${path.dirname(runtime)}:/usr/bin:/bin`, HOME: fixture,
      TMPDIR: fixture, LANG: 'C', LC_ALL: 'C'};
    const child = spawn(runtime, [script, '--tool-host', JSON.stringify(spec)], {
      cwd: fixture, env, stdio: 'ignore', shell: false,
    });
    artifact.host = {pid: child.pid, ...await waitHost(child)};
    // The service was launched before the native host exited. Anchor its
    // fallback lease to host exit rather than to the earlier microcheck start.
    watchdogDeadline = Date.now() + serviceWatchdogMs + 250;
    artifact.host.exited_successfully = artifact.host.exit_code === 0 && !artifact.host.signal;
    if (!artifact.host.exited_successfully) throw new Error('native_tool_host_failed');
    const hostResult = await readJson(path.join(fixture, 'host.json'));
    artifact.host.environment_sanitized = hostResult.environment_sanitized;
    artifact.native_bash = {exit_code: hostResult.native_bash_exit_code};
    if (!hostResult.environment_sanitized || hostResult.native_bash_is_error || hostResult.native_bash_exit_code !== 0)
      throw new Error('native_bash_failed');
    info = await waitReady(fixture, 1000);
    if (!info) throw new Error('service_not_ready_after_host_exit');
    artifact.service = {pid: info.pid, port: info.port, bound_address: info.address};
    const health = await request(info, token, '/health');
    const valid = health.pid === info.pid && health.cwd === fixture && health.environment_sanitized === true;
    artifact.post_exit_health = {succeeded: valid, observed_after_host_exit: true,
      environment_sanitized: health.environment_sanitized, cwd_matches_fixture: health.cwd === fixture};
    if (!valid) throw new Error('post_exit_health_invalid');
    artifact.status = 'PASS';
  } catch (error) {
    artifact.failure = error.code ?? error.message;
  } finally {
    info ??= await waitReady(fixture, 100);
    // Process launch can precede host exit while detached runtime initialization
    // starts the lease later. A missing/unreadable endpoint must reserve its
    // full bounded watchdog after the final readiness observation attempt.
    if (!info) watchdogDeadline = Date.now() + serviceWatchdogMs + 250;
    artifact.cleanup = await cleanService(fixture, info, token);
    const second = await cleanService(fixture, info, token);
    artifact.cleanup.repeated_cleanup_safe = !info || (second.process_terminated && second.health_unavailable);
    const cleanupConfirmed = artifact.cleanup.process_terminated;
    // The bounded watchdog is a fallback if a failure prevents locating the endpoint.
    if (!cleanupConfirmed) {
      artifact.cleanup.watchdog_fallback_waited = true;
      do {
        try {
          const stopped = await readJson(path.join(fixture, 'stopped.json'));
          if (Number.isInteger(stopped.pid) && stopped.pid > 1 && stopped.reason === 'watchdog') {
            artifact.cleanup.watchdog_termination_confirmed = true;
            artifact.cleanup.process_terminated = true;
            break;
          }
        } catch {}
        await pause(25);
      } while (Date.now() < watchdogDeadline);
    }
    await rm(fixture, {recursive: true, force: true});
    await rm(fixture, {recursive: true, force: true});
    artifact.cleanup.fixture_removed = true;
    if (!cleanupConfirmed || !artifact.cleanup.repeated_cleanup_safe) {
      artifact.status = 'FAIL';
      artifact.failure ??= 'owned_service_cleanup_unconfirmed';
    }
  }
  artifact.elapsed_ms = Date.now() - started;
  return artifact;
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  if (process.argv[2] === '--tool-host') await toolHost(JSON.parse(process.argv[3]));
  else {
    const result = await runProcessMicro();
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'FAIL') process.exitCode = 1;
  }
}
