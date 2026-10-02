// Local multi-workspace dashboard: one `apex --mode rpc` child per live session, streamed to the browser over SSE.
// Loopback only. Every request needs the startup token cookie and a loopback Host; writes also need a same-origin Origin.
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {buildPiInvocation, resolvePi} from '../lib/launcher.mjs';
import {readSessionReport} from '../lib/session-report.mjs';
import {runtimePolicy} from '../extensions/apex-core/config.mjs';
import {GROUPS, modelCatalog} from './catalog.mjs';
import {createLogins, LOGINS} from './provider-login.mjs';
import {MAX_SEND_BODY_BYTES} from './attachments.mjs';
import {promptCommand} from './chat-request.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const apexDir = process.env.APEX_DASH_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'Apex');
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(apexDir, 'sol-oauth');
const store = join(apexDir, 'dashboard.json');
const budgetFile = join(root, 'evals', 'codex-budget.json');
const port = Number(process.env.APEX_DASH_PORT ?? 4777);
const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const DIALOGS = new Set(['select', 'confirm', 'input', 'editor']);
const ASSETS = Object.fromEntries(['app.css', 'app.js', 'chat-content.mjs', 'attachments.mjs'].map(name =>
  ['/' + name, {path: new URL(name, import.meta.url), type: name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'}]));
ASSETS['/vendor/marked.js'] = {path: fileURLToPath(import.meta.resolve('marked')), type: 'text/javascript; charset=utf-8'};
const token = randomBytes(18).toString('base64url');
const runtime = await ModelRuntime.create({
  authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
});
const logins = createLogins(runtime);
const loginFor = provider => {
  if (!Object.hasOwn(logins, provider)) throw new Error('Unknown sign-in provider');
  return logins[provider];
};
// Public sign-in metadata plus progress; credentials stay in Pi's auth file.
const authState = async () => Object.fromEntries(await Promise.all(Object.entries(logins).map(async ([id, login]) => {
  const {label, site, account, type, code} = LOGINS[id];
  return [id, {label, site, account, type, code: Boolean(code), ...await login.status()}];
})));

let saved = (() => { try { return JSON.parse(readFileSync(store, 'utf8')); } catch { return {}; } })();
let workspaces = saved.workspaces ?? [];
const spend = {sol: Number(saved.spend?.sol) || 0};
const persist = () => { mkdirSync(apexDir, {recursive: true}); writeFileSync(store, JSON.stringify({workspaces, spend}, null, 1)); };

const sessionDir = cwd => join(agentDir, 'sessions', `--${cwd.replace(/^[\\/]/, '').replace(/[\\/:]/g, '-')}--`);

function titleOf(file) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(65536);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.toString('utf8', 0, length).split('\n')) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'message' && entry.message?.role === 'user') {
          const content = entry.message.content;
          const text = typeof content === 'string' ? content : content?.find(part => part.type === 'text')?.text;
          if (text) return text.slice(0, 90);
        }
      } catch { /* partial last line */ }
    }
  } finally { closeSync(fd); }
  return 'Untitled session';
}

function savedSessions(cwd) {
  const dir = sessionDir(cwd);
  try {
    return readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => join(dir, name))
      .map(file => ({file, mtime: statSync(file).mtimeMs})).sort((a, b) => b.mtime - a.mtime).slice(0, 15)
      .map(session => ({...session, title: titleOf(session.file)}));
  } catch { return []; }
}

// Recorded Codex test costs plus what this dashboard has measured since.
// Catalog-token estimates, not invoices or a spending gate.
function codexUsage() {
  try {
    const budget = JSON.parse(readFileSync(budgetFile, 'utf8'));
    return {used: (budget.observed_catalog_token_cost_usd ?? 0) + spend.sol};
  } catch { return null; }
}

const live = new Map();
const send = (session, command) => session.child.stdin.write(JSON.stringify(command) + '\n');
const active = session => session.status === 'idle' || session.status === 'running';
// Apex features and eval isolation were validated against the launch model at xhigh, so those sessions keep both.
const locked = session => Boolean(session.flags.evalMode) || GROUPS.some(group => session.flags[group.id]?.length);

// Keep drafts until Pi confirms acceptance (image decoding and extension input handlers can reject a prompt).
function request(session, command) {
  return new Promise((resolveRequest, rejectRequest) => {
    const id = randomBytes(8).toString('hex');
    const finish = (error, data) => {
      clearTimeout(timer); session.requests.delete(id);
      if (error) rejectRequest(error); else resolveRequest(data);
    };
    const timer = setTimeout(() => finish(new Error('The agent did not confirm acceptance. Check the chat before retrying.')), 30000);
    timer.unref(); session.requests.set(id, finish);
    session.child.stdin.write(JSON.stringify({...command, id}) + '\n', error => { if (error) finish(error); });
  });
}

function record(session, line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === 'agent_start') session.status = 'running';
  if (event.type === 'agent_settled') { session.status = 'idle'; session.settled++; }
  if (event.type === 'agent_settled' || event.type === 'turn_end') send(session, {id: 'stats', type: 'get_session_stats'});
  if (event.type === 'agent_settled') send(session, {id: 'state', type: 'get_state'});
  if (event.type === 'response') session.requests.get(event.id)?.(event.success ? null : new Error(event.error || 'The agent rejected the message.'), event.data);
  if (event.type === 'response' && event.id === 'state' && event.success) {
    session.file = event.data.sessionFile ?? session.file;
    session.input = event.data.model?.input ?? ['text'];
    if (event.data.thinkingLevel) session.thinking = event.data.thinkingLevel;
  }
  if (event.type === 'response' && event.id === 'levels' && event.success) session.levels = event.data.levels ?? session.levels;
  if (event.type === 'response' && event.id === 'stats' && event.success) {
    const cost = Number(event.data.cost) || 0;
    session.base ??= session.file && session.resumed ? cost : 0; // a resumed file arrives with its earlier cost already recorded
    const delta = Math.max(0, cost - session.base);
    if (session.provider === 'openai-codex' && delta > session.counted) { spend.sol += delta - session.counted; persist(); }
    session.counted = Math.max(session.counted, delta);
  }
  if (event.type === 'extension_ui_request' && DIALOGS.has(event.method)) {
    session.pending.set(event.id, event);
    if (event.timeout) setTimeout(() => session.pending.delete(event.id), event.timeout + 500).unref(); // the agent auto-resolves after its timeout
  }
  if (event.type === 'message_end' && event.message?.role === 'user' && !session.title) {
    const content = event.message.content;
    session.title = (typeof content === 'string' ? content : content?.find(part => part.type === 'text')?.text ?? '').slice(0, 90);
  }
  session.log.push(line);
  if (session.log.length > 20000) session.log.shift(); // ponytail: replay drops oldest events past 20k; reload via get_messages if this matters
  for (const client of session.clients) client.write(`data: ${line}\n\n`);
}

// Validates the whole launch request, then returns the arguments for bin/apex.
function launchArguments(body, file) {
  const model = modelCatalog(runtime).find(candidate => candidate.id === body.model);
  if (!model) throw new Error('Choose a model');
  let thinking = body.thinking ?? 'xhigh';
  if (!THINKING.includes(thinking)) throw new Error('Unknown thinking level');
  const picked = {}, apexArgs = [];
  for (const group of GROUPS) {
    const wanted = new Set(Array.isArray(body[group.id]) ? body[group.id] : []);
    for (const flag of wanted) if (!group.features.some(feature => feature.flag === flag)) throw new Error(`Unknown ${group.title.toLowerCase()} feature: ${flag}`);
    picked[group.id] = group.features.map(feature => feature.flag).filter(flag => wanted.has(flag));
    for (const flag of picked[group.id]) {
      const feature = group.features.find(candidate => candidate.flag === flag);
      if (feature.blocked === 'paid' && !runtimePolicy().paid_runs_enabled) throw new Error(`${feature.label} is blocked by the offline-only policy`);
    }
    if (picked[group.id].length) apexArgs.push(group.option, picked[group.id].join(','));
  }
  const anyFeature = Object.values(picked).some(list => list.length);
  if (anyFeature || body.evalMode) {
    if (!model.apex) throw new Error('Apex features and eval isolation run only on Muse Spark 1.3 or, on native Windows, signed-in models');
    thinking = 'xhigh';
    if (model.target) apexArgs.unshift('--apex-target', model.target);
  }
  let timeBudget;
  if (picked.core.includes('time')) {
    timeBudget = Number(body.timeBudget);
    if (!Number.isFinite(timeBudget) || timeBudget <= 0 || timeBudget > 86400) throw new Error('Set a time budget between 1 and 86400 seconds');
    apexArgs.push('--time-budget', String(timeBudget));
  }
  if (body.evalMode) apexArgs.push('--apex-eval');
  const args = [...apexArgs, '--provider', model.provider, '--model', model.model, '--thinking', thinking, '--mode', 'rpc', ...(file ? ['--session', file] : [])];
  buildPiInvocation([...args], resolvePi().cli); // same parser bin/apex uses, so a refusal reads clearly here instead of as a crashed child
  return {args, model, thinking, flags: {...picked, timeBudget, evalMode: Boolean(body.evalMode)}};
}

function startSession(cwd, file, launch) {
  const id = randomBytes(4).toString('hex');
  const child = spawn(process.execPath, [join(root, 'bin', 'apex'), ...launch.args], {cwd, env: {...process.env, PI_CODING_AGENT_DIR: agentDir}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  const session = {id, cwd, child, file, resumed: Boolean(file), title: file ? titleOf(file) : '', status: 'idle', log: [], clients: new Set(), stderr: '',
    pending: new Map(), requests: new Map(), provider: launch.model.provider, model: launch.model.id, input: launch.model.input,
    thinking: launch.thinking, levels: THINKING, flags: launch.flags, counted: 0, base: undefined, settled: 0};
  live.set(id, session);
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffered += chunk;
    for (let end; (end = buffered.indexOf('\n')) >= 0;) { // LF only: JSON strings may hold U+2028
      const line = buffered.slice(0, end).replace(/\r$/, '');
      buffered = buffered.slice(end + 1);
      if (line) record(session, line);
    }
  });
  child.stderr.on('data', chunk => { session.stderr = (session.stderr + chunk).slice(-2000); });
  child.on('error', error => { session.stderr = error.message; });
  child.stdin.on('error', error => { for (const finish of session.requests.values()) finish(error); });
  child.on('close', code => {
    session.status = code === 0 ? 'done' : 'error';
    session.pending.clear();
    for (const finish of session.requests.values()) finish(new Error('The agent stopped before accepting the message. Resume the session to retry.'));
    record(session, JSON.stringify({type: 'dashboard_exit', code, stderr: session.stderr}));
    for (const client of session.clients) client.end();
    if (code === 0) live.delete(id); // clean exits reappear as saved sessions; failed ones stay visible with stderr
  });
  send(session, {id: 'state', type: 'get_state'});
  send(session, {id: 'commands', type: 'get_commands'});
  send(session, {id: 'levels', type: 'get_available_thinking_levels'});
  if (file) send(session, {id: 'history', type: 'get_messages'});
  send(session, {id: 'stats', type: 'get_session_stats'});
  return session;
}

function pickFolder() {
  return new Promise((resolvePath, reject) => {
    if (process.platform !== 'win32') return reject(new Error('The folder picker needs Windows. Type the path instead.'));
    const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Choose a project folder'; if($d.ShowDialog() -eq 'OK'){[Console]::Out.Write($d.SelectedPath)}";
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {stdio: ['ignore', 'pipe', 'ignore']});
    let out = '';
    const timer = setTimeout(() => child.kill(), 300000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', () => { clearTimeout(timer); resolvePath(out.trim()); });
  });
}

const json = (res, status, body) => { res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(body)); };
const fail = (res, status, error) => json(res, status, {error});

async function readBody(req, limit = 1_000_000) {
  const tooLarge = () => Object.assign(new Error('Request too large. Use smaller images.'), {status: 413});
  if (Number(req.headers['content-length']) > limit) { req.resume(); throw tooLarge(); }
  return new Promise((resolveBody, rejectBody) => {
    let size = 0, rejected = false;
    const chunks = [];
    req.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) { rejected = true; chunks.length = 0; rejectBody(tooLarge()); }
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try { resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (error) { rejectBody(error); }
    });
    req.on('error', rejectBody);
    req.on('aborted', () => rejectBody(new Error('Request interrupted. Retry your message.')));
  });
}

const summary = session => ({id: session.id, cwd: session.cwd, status: session.status, title: session.title, file: session.file, model: session.model, provider: session.provider, input: session.input,
  thinking: session.thinking, levels: session.levels, locked: locked(session), flags: session.flags, pending: [...session.pending.values()], spent: session.counted, settled: session.settled});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (!['127.0.0.1:' + port, 'localhost:' + port].includes(req.headers.host)) return fail(res, 403, 'Host not allowed');
    if (url.pathname === '/' && url.searchParams.get('t') === token) {
      res.writeHead(302, {location: '/', 'set-cookie': `apex=${token}; HttpOnly; SameSite=Strict; Path=/`});
      return res.end();
    }
    if (!(req.headers.cookie ?? '').split(/;\s*/).includes('apex=' + token)) return fail(res, 403, 'Open the URL printed when the dashboard started');
    if (req.method === 'GET' && (url.pathname === '/' || ASSETS[url.pathname])) {
      const asset = ASSETS[url.pathname];
      res.writeHead(200, {'content-type': asset?.type ?? 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
      return res.end(readFileSync(asset?.path ?? new URL('index.html', import.meta.url)));
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const sessions = [...live.values()].map(summary);
      return json(res, 200, {thinking: THINKING, models: modelCatalog(runtime), groups: GROUPS, paid: Boolean(runtimePolicy().paid_runs_enabled), codexUsage: codexUsage(), auth: await authState(),
        workspaces: workspaces.map(path => ({path, live: sessions.filter(session => session.cwd === path),
          saved: savedSessions(path).filter(entry => !sessions.some(session => session.file === entry.file))}))});
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const session = live.get(url.searchParams.get('id'));
      if (!session) return fail(res, 404, 'Unknown session');
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store'});
      for (const line of session.log) res.write(`data: ${line}\n\n`);
      session.clients.add(res);
      return req.on('close', () => session.clients.delete(res));
    }
    if (req.method === 'GET' && url.pathname === '/api/report') {
      const session = live.get(url.searchParams.get('id'));
      if (!session?.file || !existsSync(session.file)) return fail(res, 404, 'No saved messages to report on yet');
      return json(res, 200, await readSessionReport(session.file));
    }
    if (req.method !== 'POST') return fail(res, 404, 'Not found');
    if (req.headers.origin !== `http://${req.headers.host}`) return fail(res, 403, 'Origin not allowed');
    const body = await readBody(req, url.pathname === '/api/send' ? MAX_SEND_BODY_BYTES : undefined);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'Expected a JSON object');
    if (url.pathname.startsWith('/api/auth/')) {
      const login = loginFor(body.provider), oauth = LOGINS[body.provider].type === 'oauth';
      const action = url.pathname.slice('/api/auth/'.length);
      if (action === 'logout') return json(res, 200, await login.logout());
      if (oauth && action === 'login') return json(res, 200, await login.start());
      if (oauth && action === 'cancel') return json(res, 200, await login.cancel(body.loginId));
      if (oauth && action === 'respond') {
        if (typeof body.value !== 'string' || body.value.length > 8192) return fail(res, 400, `Paste the full callback URL from ${LOGINS[body.provider].site}.`);
        login.respond(body.loginId, body.value);
        return json(res, 200, await login.status());
      }
      if (!oauth && action === 'key') {
        if (typeof body.value !== 'string' || body.value.length > 1024) return fail(res, 400, 'Paste the API key on one line.');
        return json(res, 200, await login.save(body.value));
      }
      return fail(res, 404, 'Not found');
    }
    if (url.pathname === '/api/workspaces') {
      const path = resolve(String(body.path ?? '')).replace(/^[a-z]:/, drive => drive.toUpperCase());
      if (!existsSync(path) || !statSync(path).isDirectory()) return fail(res, 400, 'Folder not found');
      if (!workspaces.includes(path)) { workspaces.push(path); persist(); }
      return json(res, 200, {path});
    }
    if (url.pathname === '/api/pick-folder') return json(res, 200, {path: await pickFolder()});
    if (url.pathname === '/api/workspaces/remove') { // list entry only; never touches files
      workspaces = workspaces.filter(path => path !== body.path);
      persist();
      return json(res, 200, {});
    }
    if (url.pathname === '/api/reveal') {
      if (!workspaces.includes(body.path)) return fail(res, 400, 'Not a listed workspace');
      spawn(process.platform === 'win32' ? 'explorer.exe' : 'xdg-open', [body.path], {detached: true, stdio: 'ignore'}).unref();
      return json(res, 200, {});
    }
    if (url.pathname === '/api/start') {
      if (!workspaces.includes(body.cwd)) return fail(res, 400, 'Add the folder as a workspace first');
      let file;
      if (body.file !== undefined) {
        file = resolve(String(body.file));
        if (!file.startsWith(sessionDir(body.cwd) + sep) || !existsSync(file)) return fail(res, 400, 'Session file not found for this workspace');
        if ([...live.values()].some(session => session.file === file && active(session))) return fail(res, 409, 'Session is already open');
      }
      const launch = launchArguments(body, file);
      return json(res, 200, {id: startSession(body.cwd, file, launch).id});
    }
    const session = live.get(body.id);
    if (!session) return fail(res, 404, 'Unknown session');
    if (url.pathname === '/api/send') {
      if (!active(session)) return fail(res, 409, 'This session has ended. Resume it before sending a message.');
      const command = promptCommand(body, session);
      const login = logins[session.provider];
      if (login && !(await login.status()).signedIn) return fail(res, 401, `Sign in to ${LOGINS[session.provider].label} using the dashboard button, then send your message again.`);
      await request(session, command);
      return json(res, 200, {});
    }
    if (url.pathname === '/api/settings') { // switch model or thinking level in place; Pi applies it from the next model call
      if (!active(session)) return fail(res, 409, 'This session has ended. Resume it to change its model.');
      if (locked(session)) return fail(res, 409, 'Sessions with Apex features or eval isolation keep the model and thinking level they started with.');
      if (body.model !== undefined && body.model !== session.model) {
        const model = modelCatalog(runtime).find(candidate => candidate.id === body.model);
        if (!model) return fail(res, 400, 'Choose a model');
        const data = await request(session, {type: 'set_model', provider: model.provider, modelId: model.model});
        Object.assign(session, {model: model.id, provider: model.provider, input: data?.input ?? model.input});
        session.levels = (await request(session, {type: 'get_available_thinking_levels'}))?.levels ?? THINKING;
      }
      if (body.thinking !== undefined) {
        if (!THINKING.includes(body.thinking)) return fail(res, 400, 'Unknown thinking level');
        await request(session, {type: 'set_thinking_level', level: body.thinking});
      }
      session.thinking = (await request(session, {type: 'get_state'}))?.thinkingLevel ?? session.thinking; // Pi clamps to what the model supports
      return json(res, 200, summary(session));
    }
    if (url.pathname === '/api/ui-response') {
      if (!session.pending.has(body.requestId)) return fail(res, 409, 'That question was already answered or timed out');
      session.pending.delete(body.requestId);
      const answer = body.cancelled ? {cancelled: true} : body.confirmed !== undefined ? {confirmed: Boolean(body.confirmed)} : {value: String(body.value ?? '')};
      session.child.stdin.write(JSON.stringify({type: 'extension_ui_response', id: body.requestId, ...answer}) + '\n');
      return json(res, 200, {});
    }
    if (url.pathname === '/api/abort') { send(session, {type: 'abort'}); return json(res, 200, {}); }
    if (url.pathname === '/api/stop') {
      session.child.stdin.end();
      setTimeout(() => session.child.kill(), 5000).unref();
      return json(res, 200, {});
    }
    return fail(res, 404, 'Not found');
  } catch (error) {
    fail(res, error.status ?? 400, error.message);
  }
});

server.on('error', error => { console.error(error.message); process.exit(1); });
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  console.log(`Apex dashboard: ${url}`);
  if (!process.argv.includes('--open')) return;
  const opener = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  spawn(opener, args, {detached: true, stdio: 'ignore', windowsHide: true})
    .on('error', error => console.warn(`Could not open the browser: ${error.message}. Open the URL above instead.`))
    .unref();
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { for (const login of Object.values(logins)) if (login.flow) void login.cancel(login.flow.id); for (const session of live.values()) session.child.stdin.end(); process.exit(0); });
