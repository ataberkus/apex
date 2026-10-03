import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// PowerShell startup plus Add-Type compilation costs several seconds on slow or loaded hosts, so one
// helper per process serves every request. Startup and each request are bounded separately.
const STARTUP_MS = 60000, REQUEST_MS = 15000;
// Requests run one at a time; each takes the live helper at its turn, so one failure only costs itself.
let helper, queue = Promise.resolve();

function startHelper() {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    const source = Object.keys(process.env).find(item => item.toUpperCase() === key.toUpperCase());
    if (source !== undefined) env[key] = process.env[source];
  }
  const systemRoot = env.SystemRoot ?? 'C:\\Windows';
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = fileURLToPath(new URL('../extensions/apex-context/private-spill.ps1', import.meta.url));
  // A neutral cwd: a long-lived child must not pin any project directory against deletion.
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-Serve'],
    {cwd: systemRoot, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  const state = {child, buffer: '', stderr: '', waiting: undefined, failure: undefined};
  state.fail = error => {
    state.failure ??= error;
    if (helper === state) helper = undefined;
    const waiting = state.waiting; state.waiting = undefined;
    waiting?.reject(state.failure);
    child.kill();
  };
  child.stdout.setEncoding('ascii');
  child.stdout.on('data', text => {
    state.buffer += text;
    for (let end; (end = state.buffer.indexOf('\n')) >= 0;) {
      const line = state.buffer.slice(0, end).replace(/\r$/, '');
      state.buffer = state.buffer.slice(end + 1);
      const waiting = state.waiting; state.waiting = undefined;
      if (waiting) waiting.resolve(line);
      else state.fail(new Error('Windows private storage helper wrote unexpected output.'));
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => {state.stderr = (state.stderr + text).slice(-65536);});
  child.on('error', error => state.fail(error));
  child.on('close', code => state.fail(new Error(state.stderr.trim() || `Windows private storage helper exited ${code}`)));
  child.stdin.on('error', error => state.fail(error));
  // An idle helper never keeps the process alive; a pending request's timer does.
  for (const handle of [child, child.stdin, child.stdout, child.stderr]) handle.unref?.();
  state.ready = nextLine(state, STARTUP_MS).then(line => {
    if (line !== 'ready') throw new Error('Windows private storage helper failed to start.');
  });
  state.ready.catch(() => {});
  return state;
}

function nextLine(state, ms) {
  return new Promise((resolve, reject) => {
    if (state.failure) return reject(state.failure);
    const timer = setTimeout(() => state.fail(new Error(`Windows private storage helper exceeded its ${ms / 1000} second bound.`)), ms);
    state.waiting = {resolve: line => {clearTimeout(timer); resolve(line);}, reject: error => {clearTimeout(timer); reject(error);}};
  });
}

const aborted = () => new Error('Windows private storage operation aborted.');

/** Atomic ACL creation/verification. No chmod fallback or policy bypass. */
export async function runWindowsPrivateHelper(root, {name, raw = '', signal} = {}) {
  if (process.platform !== 'win32') throw new Error('Windows private storage requires native Windows.');
  if (signal?.aborted) throw aborted();
  const request = [Buffer.from(root, 'utf8').toString('base64'), name || '-', Buffer.from(raw, 'utf8').toString('base64')].join(' ');
  const run = queue.then(async () => {
    if (signal?.aborted) throw aborted();
    const state = helper ??= startHelper();
    // An abort during startup or mid-request discards the helper, whose state is then unknown.
    const onAbort = () => state.fail(aborted());
    signal?.addEventListener('abort', onAbort, {once: true});
    try {
      await state.ready;
      const reply = nextLine(state, REQUEST_MS);
      state.child.stdin.write(request + '\n');
      const line = await reply;
      if (line === 'ok') return;
      if (line.startsWith('error ')) throw new Error(Buffer.from(line.slice(6), 'base64').toString('utf8').trim());
      throw new Error('Windows private storage helper returned a malformed reply.');
    } finally { signal?.removeEventListener('abort', onAbort); }
  });
  queue = run.catch(() => {});
  return run;
}

export const ensureWindowsPrivateApex = (root, signal) => runWindowsPrivateHelper(root, {signal});
