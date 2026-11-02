import {spawn} from 'node:child_process';
import net from 'node:net';

// Below the ephemeral ranges that outgoing connections draw from (Windows 49152-65535, Linux 32768-60999 by default).
// Random ports in 44000-55000 collided there on a Windows runner: "Failed to start server. Is port 49697 in use?".
const LOW = 20000, SPAN = 12000;

/** A loopback port that no listener holds at the moment of the call (an excluded or busy port fails the probe). */
export async function freePort() {
  for (let tries = 0; tries < 100; tries++) {
    const port = LOW + Math.floor(Math.random() * SPAN);
    const free = await new Promise(resolve => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`No free loopback port in ${LOW}-${LOW + SPAN - 1}`);
}

const listenFailure = /in use|EADDRINUSE|EACCES/i;

/**
 * Starts dashboard/server.mjs (`args` follow the Bun executable; `env` without APEX_DASH_PORT) and resolves with its child,
 * port and startup token. A server that cannot listen exits with its own message: that attempt fails at once instead of
 * at the deadline, and the next one takes another port (between the probe and the server's listen, a parallel test can
 * take the same port). Any other exit or the deadline fails the start. `ports` fixes the ports tried, for this helper's
 * own test.
 */
export async function startDashboard({args, env, attempts = 3, timeoutMs = 20000, ports}) {
  const failures = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    const port = ports?.[attempt] ?? await freePort();
    const child = spawn(process.execPath, args, {env: {...env, APEX_DASH_PORT: String(port)}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); process.stderr.write(chunk); });
    try {
      const token = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Dashboard startup timed out on port ${port}`)), timeoutMs);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(Object.assign(new Error(`Dashboard exited (${code}) on port ${port}: ${stderr.trim()}`), {stderr})); });
        let out = '';
        child.stdout.on('data', chunk => {
          if (out === null) return;
          out += chunk; const match = /\?t=(\S+)/.exec(out);
          if (match) { out = null; clearTimeout(timer); resolve(match[1]); }
        });
      });
      return {child, port, token, failures};
    } catch (error) {
      failures.push({port, reason: error.message});
      if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
      if (!listenFailure.test(error.stderr ?? '')) throw error;
    }
  }
  throw new Error(`Dashboard could not listen: ${failures.map(failure => failure.reason).join('; ')}`);
}
