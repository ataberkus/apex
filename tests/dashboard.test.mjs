import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {IMAGE_HELP, MAX_IMAGES} from '../dashboard/attachments.mjs';
import {buildPiInvocation, resolvePi} from '../lib/launcher.mjs';
import {withWindowsDefaults} from '../lib/windows-target.mjs';
import net from 'node:net';
import {freePort, startDashboard} from './fixtures/dashboard-server.mjs';

const server = fileURLToPath(new URL('../dashboard/server.mjs', import.meta.url));
// The fixture replaces child_process.spawn; live-builtins makes the server's named `spawn` import see that.
const preload = fixture => ['--preload', fileURLToPath(new URL('../scripts/live-builtins.mjs', import.meta.url)), '--preload', fileURLToPath(fixture)];

function call(port, {method = 'GET', path = '/', headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, method, path, headers: {host: `127.0.0.1:${port}`, ...headers}}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('dashboard refuses requests without the startup token, loopback Host or same-origin writes, and never starts unlisted folders', async () => {
  const home = await mkdtemp(join(tmpdir(), 'apex-dash-test-'));
  const {child, port, token} = await startDashboard({args: [server], env: {...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent')}});
  try {
    assert.equal((await call(port, {path: '/api/state'})).status, 403);
    assert.equal((await call(port, {path: '/?t=wrong'})).status, 403);
    const login = await call(port, {path: `/?t=${token}`});
    assert.equal(login.status, 302);
    const cookie = {cookie: login.headers['set-cookie'][0].split(';')[0]};
    assert.equal((await call(port, {path: '/api/state', headers: cookie})).status, 200);
    assert.equal((await call(port, {path: '/api/state', headers: {...cookie, host: 'evil.example'}})).status, 403);
    const write = {method: 'POST', path: '/api/start', body: JSON.stringify({cwd: home})};
    assert.equal((await call(port, {...write, headers: cookie})).status, 403);
    const sameOrigin = {...cookie, origin: `http://127.0.0.1:${port}`};
    const refused = await call(port, {...write, headers: sameOrigin});
    assert.equal(refused.status, 400);
    assert.match(refused.text, /Add the folder as a workspace first/);
    const post = (path, payload) => call(port, {method: 'POST', path, headers: {...sameOrigin, 'content-type': 'application/json'}, body: JSON.stringify(payload)});
    assert.equal((await post('/api/workspaces', {path: home})).status, 200);
    const reject = async (payload, pattern) => { const r = await post('/api/start', {cwd: home, ...payload}); assert.equal(r.status, 400); assert.match(r.text, pattern); };
    if (process.platform === 'win32') {
      await reject({model: 'sol', context: ['route']}, /Unavailable in the Windows target: context route/);
      await reject({model: 'sol', core: ['bg']}, /Unavailable in the Windows target: core bg/);
    } else await reject({model: 'sol', context: ['read']}, /only on Muse/);
    await reject({model: 'muse', core: ['max']}, /blocked by the offline-only policy/);
    await reject({model: 'muse', core: ['time']}, /time budget/i);
    await reject({model: 'muse', core: ['not-a-feature']}, /Unknown/);
    const catalog = JSON.parse((await call(port, {path: '/api/state', headers: cookie})).text);
    assert.deepEqual(Object.keys(catalog.auth), ['openai-codex', 'anthropic', 'opencode-go']);
    assert.equal(catalog.auth['openai-codex'].signedIn, false);
    assert.equal(catalog.auth.anthropic.signedIn, false);
    assert.deepEqual([catalog.auth.anthropic.type, catalog.auth['opencode-go'].type], ['oauth', 'api_key']);
    assert.ok(catalog.models.some(m => m.provider === 'anthropic') && catalog.models.some(m => m.provider === 'opencode-go'));
    for (const path of ['/api/auth/login', '/api/auth/respond', '/api/auth/cancel', '/api/auth/key', '/api/auth/logout']) {
      const request = {method: 'POST', path, body: JSON.stringify({provider: 'anthropic'})};
      assert.equal((await call(port, request)).status, 403);
      assert.equal((await call(port, {...request, headers: cookie})).status, 403);
    }
    for (const provider of ['openai-codex', 'anthropic']) {
      const expired = await post('/api/auth/respond', {provider, loginId: 'expired', value: 'http://localhost:1455/auth/callback?code=x&state=y'});
      assert.equal(expired.status, 400);
      assert.match(expired.text, /no longer active/);
    }
    assert.match((await post('/api/auth/login', {provider: 'openrouter'})).text, /Unknown sign-in provider/);
    assert.match((await post('/api/auth/login', {provider: '__proto__'})).text, /Unknown sign-in provider/);
    assert.equal((await post('/api/auth/login', {provider: 'opencode-go'})).status, 404, 'API-key providers have no OAuth flow');
    assert.equal((await post('/api/auth/key', {provider: 'anthropic', value: 'sk-test-value'})).status, 404, 'OAuth providers take no pasted key');
    assert.match((await post('/api/auth/key', {provider: 'opencode-go', value: 'has spaces in it'})).text, /one line with no spaces/);
  } finally {
    child.kill();
    await rm(home, {recursive: true, force: true});
  }
});

// A Windows runner's random port 49697 was taken: the server exited at once, but the test waited out its 20 s deadline.
test('a dashboard whose port is taken fails that start at once with its own message and starts on another port', async () => {
  const home = await mkdtemp(join(tmpdir(), 'apex-dash-port-'));
  const blocker = net.createServer(), taken = await freePort();
  await new Promise(resolve => blocker.listen(taken, '127.0.0.1', resolve));
  let dashboard;
  try {
    const started = performance.now();
    dashboard = await startDashboard({args: [server], env: {...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent')}, ports: [taken], timeoutMs: 120000});
    assert.ok(performance.now() - started < 60000, 'the taken port failed on the server exit, not at the deadline');
    assert.deepEqual(dashboard.failures.map(failure => failure.port), [taken]);
    assert.match(dashboard.failures[0].reason, /in use|EADDRINUSE/i);
    assert.notEqual(dashboard.port, taken);
    assert.equal((await call(dashboard.port, {path: `/?t=${dashboard.token}`})).status, 302);
  } finally {
    if (dashboard && dashboard.child.exitCode === null && dashboard.child.signalCode === null) {
      const exited = new Promise(resolve => dashboard.child.once('exit', resolve));
      dashboard.child.kill();
      await exited;
    }
    await new Promise(resolve => blocker.close(resolve));
    await rm(home, {recursive: true, force: true});
  }
});

test('sessions delete only their own .jsonl in a listed workspace, and workspace order takes only a full permutation and persists', async () => {
  const home = await mkdtemp(join(tmpdir(), 'apex-dash-delete-')), agent = join(home, 'agent');
  const env = {...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: agent};
  const login = async ({port, token}) => {
    const cookie = (await call(port, {path: `/?t=${token}`})).headers['set-cookie'][0].split(';')[0];
    const headers = {cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json'};
    return {
      post: (path, payload, extra = {}) => call(port, {method: 'POST', path, headers: {...headers, ...extra}, body: JSON.stringify(payload)}),
      state: async () => JSON.parse((await call(port, {path: '/api/state', headers: {cookie}})).text),
    };
  };
  let dashboard = await startDashboard({args: [server], env});
  try {
    const first = await login(dashboard), {post} = first;
    let {state} = first;
    for (const name of ['a', 'b', 'c']) { await mkdir(join(home, name)); assert.equal((await post('/api/workspaces', {path: join(home, name)})).status, 200); }
    const paths = (await state()).workspaces.map(w => w.path);
    // The server's sessionDir(cwd) naming.
    const dir = join(agent, 'sessions', `--${paths[0].replace(/^[\\/]/, '').replace(/[\\/:]/g, '-')}--`);
    await mkdir(dir, {recursive: true});
    const saved = join(dir, 'saved.jsonl'), kept = join(dir, 'archived.jsonl'), outside = join(home, 'outside.jsonl');
    for (const file of [saved, kept, outside]) await writeFile(file, '');
    assert.equal((await post('/api/sessions/archive', {file: kept})).status, 200);
    const listed = (await state()).workspaces[0];
    assert.deepEqual([listed.saved.map(s => s.file), listed.archived.map(s => s.file)], [[saved], [kept]]);

    assert.equal((await post('/api/sessions/delete', {file: saved}, {origin: 'http://evil.example'})).status, 403);
    assert.ok(existsSync(saved));
    assert.equal((await post('/api/sessions/delete', {file: outside})).status, 400);
    assert.ok(existsSync(outside), 'a .jsonl outside every workspace session folder stays');
    assert.equal((await post('/api/sessions/delete', {file: join(dir, 'missing.jsonl')})).status, 400);
    await writeFile(join(dir, 'notes.txt'), '');
    assert.equal((await post('/api/sessions/delete', {file: join(dir, 'notes.txt')})).status, 400);
    assert.equal((await post('/api/sessions/delete', {file: saved})).status, 200);
    assert.equal((await post('/api/sessions/delete', {file: kept})).status, 200);
    assert.ok(!existsSync(saved) && !existsSync(kept));
    const after = (await state()).workspaces[0];
    assert.deepEqual([after.saved, after.archived], [[], []]);
    assert.deepEqual(JSON.parse(await readFile(join(home, 'dashboard.json'), 'utf8')).archived, [], 'deleted files leave the archived list');

    for (const bad of [paths.slice(0, 2), [...paths, join(home, 'extra')], [paths[0], paths[0], paths[1]], 'not a list']) {
      assert.equal((await post('/api/workspaces/order', {paths: bad})).status, 400);
    }
    assert.deepEqual((await state()).workspaces.map(w => w.path), paths, 'a refused order changes nothing');
    const order = [paths[2], paths[0], paths[1]];
    assert.equal((await post('/api/workspaces/order', {paths: order})).status, 200);
    assert.deepEqual((await state()).workspaces.map(w => w.path), order);

    dashboard.child.kill();
    dashboard = await startDashboard({args: [server], env});
    ({state} = await login(dashboard));
    assert.deepEqual((await state()).workspaces.map(w => w.path), order, 'the order survives a restart');
  } finally {
    dashboard.child.kill();
    await rm(home, {recursive: true, force: true});
  }
});

test('Codex sessions start and accept prompts above the former cap', async () => {
  const budget = JSON.parse(await readFile(new URL('../evals/codex-budget.json', import.meta.url), 'utf8'));
  const matrix = JSON.parse(await readFile(new URL('../evals/final-validation.json', import.meta.url), 'utf8'));
  assert.equal(budget.spending_policy, 'unlimited');
  assert.equal(budget.execution_scope, 'codex-oauth-only');
  assert.equal(budget.budget_cap_usd, null);
  assert.equal(budget.remaining_catalog_equivalent_usd, null);
  assert.equal(matrix.codex_oauth_testing_budget_cap_usd, null);
  const home = await mkdtemp(join(tmpdir(), 'apex-dash-uncapped-'));
  await writeFile(join(home, 'dashboard.json'), JSON.stringify({workspaces: []}));
  const fixture = new URL('./fixtures/dashboard-rpc.mjs', import.meta.url).href;
  const {child, port, token} = await startDashboard({args: [...preload(fixture), server], env: {...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), APEX_FIXTURE_ARGV: join(home, 'argv.jsonl')}});
  try {
    const login = await call(port, {path: `/?t=${token}`});
    const cookie = {cookie: login.headers['set-cookie'][0].split(';')[0]};
    const state = async () => JSON.parse((await call(port, {path: '/api/state', headers: cookie})).text);
    const post = (path, body) => call(port, {method: 'POST', path, headers: {...cookie, origin: `http://127.0.0.1:${port}`}, body: JSON.stringify(body)});
    assert.deepEqual((await state()).usage, {}, 'no saved subscription login, so oh-my-pi is never asked for usage');
    assert.equal((await post('/api/workspaces', {path: home})).status, 200);
    const started = await post('/api/start', {cwd: home, model: 'sol'});
    assert.equal(started.status, 200, started.text);
    // Plain agent picks nothing, so bin/apex's Windows defaults must not apply. On native Windows a signed-in model
    // still takes the bare target, which adds only the Claude identity patch; elsewhere it runs stock Pi.
    const [plain] = (await readFile(join(home, 'argv.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(plain.filter((arg, index) => plain[index - 1] === '--extension').map(file => file.split(/[/\\]/).at(-1)),
      process.platform === 'win32' ? ['claude-identity.mjs'] : [], 'nothing picked adds no Apex feature');
    assert.ok(!plain.some(arg => /^--apex-(?:context|core|feature)-flags$/.test(arg)));
    const {id} = JSON.parse(started.text);
    // The dashboard starts Pi itself with exactly the invocation bin/apex would build from the launch arguments.
    const launched = (await state()).workspaces.flatMap(w => w.live).find(s => s.id === id), sol = (await state()).models.find(m => m.id === 'sol');
    const launchArgs = [...(launched.target ? ['--apex-target', launched.target] : ['--apex-off']), '--provider', sol.provider, '--model', sol.model, '--thinking', launched.thinking, '--mode', 'rpc'];
    assert.deepEqual(plain, buildPiInvocation(withWindowsDefaults(launchArgs, {cwd: home}), resolvePi().cli).args);
    const sent = await post('/api/send', {id, message: 'Offline fixture prompt'});
    assert.equal(sent.status, 200, sent.text);
    const settings = async body => { const r = await post('/api/settings', {id, ...body}); return {...JSON.parse(r.text), code: r.status}; };
    const thought = await settings({thinking: 'medium'});
    assert.equal(thought.code, 200); assert.equal(thought.thinking, 'medium'); assert.deepEqual(thought.levels, ['low', 'medium', 'high', 'xhigh']);
    assert.equal((await settings({thinking: 'max'})).thinking, 'xhigh', 'the agent clamps unsupported levels and the dashboard reports what it chose');
    // A plain session on a signed-in model carries the bare Windows target on native Windows, so it stays on signed-in models.
    const switched = await settings({model: 'muse'});
    if (process.platform === 'win32') assert.match(switched.error, /switch between signed-in models/);
    else { assert.equal(switched.model, 'muse'); assert.deepEqual(switched.input, ['text']); }
    assert.match((await settings({thinking: 'loud'})).error, /Unknown thinking level/);
    assert.match((await settings({model: 'nope'})).error, /Choose a model/);
    assert.equal((await post('/api/stop', {id})).status, 200);
    if (process.platform === 'win32') {
      // Without the Windows target the launcher restricts features to Muse, so this start proves Sol gets it.
      const featured = await post('/api/start', {cwd: home, model: 'sol', thinking: 'low', context: ['read', 'search'], features: ['checkpoints']});
      assert.equal(featured.status, 200, featured.text);
      const session = (await state()).workspaces.flatMap(w => w.live).find(s => s.id === JSON.parse(featured.text).id);
      assert.equal(session.thinking, 'low', 'features keep the chosen thinking level');
      assert.deepEqual([session.lock, session.target], [undefined, 'windows']);
      const raised = await settings({id: session.id, thinking: 'high'});
      assert.deepEqual([raised.code, raised.thinking], [200, 'high'], 'features change thinking live');
      const opus = await settings({id: session.id, model: 'anthropic/claude-opus-5-5'});
      assert.deepEqual([opus.code, opus.model, opus.thinking, opus.logins, opus.relaunched], [200, 'anthropic/claude-opus-5-5', 'high', ['anthropic'], false], 'features switch signed-in models live, keeping the level');
      assert.match((await settings({id: session.id, model: 'muse'})).error, /switch between signed-in models/);
      // A pair the agent did not load restarts it on the same session, keeping the features.
      const pair = {plan: {model: 'anthropic/claude-opus-5-5', thinking: 'high'}, build: {model: 'anthropic/claude-sonnet-5-5', thinking: 'low'}};
      const paired = await settings({id: session.id, pair});
      assert.equal(paired.code, 200, paired.error);
      assert.equal(paired.relaunched, true); assert.notEqual(paired.id, session.id);
      assert.deepEqual([paired.model, paired.pair.plan, paired.pair.build.model, paired.logins, paired.flags.features], ['apex/pair', pair.plan, pair.build.model, ['anthropic'], ['checkpoints']]);
      assert.equal(paired.thinking, 'low', 'the build level comes from the restart');
      const single = await settings({id: paired.id, model: 'sol'});
      assert.deepEqual([single.model, single.relaunched, single.pair.plan.model], ['sol', false, pair.plan.model], 'the loaded pair stays available');
      const back = await settings({id: paired.id, pair: {...pair, build: {...pair.build, thinking: 'medium'}}});
      assert.deepEqual([back.model, back.relaunched, back.thinking, back.logins], ['apex/pair', false, 'medium', ['anthropic']], 'the same pair comes back live at a new build level');
      assert.match((await settings({id: paired.id, pair: {...pair, plan: {...pair.plan, thinking: 'off'}}})).error, /Opus 5.5 planning runs at low, medium, high, xhigh, max/);
      assert.equal((await post('/api/stop', {id: paired.id})).status, 200);
      const started = await post('/api/start', {cwd: home, pair: {plan: {model: 'anthropic/claude-opus-5-5', thinking: 'high'}, build: {model: 'openai-codex/gpt-6-luna'}}});
      assert.equal(started.status, 200, started.text);
      const mixed = (await state()).workspaces.flatMap(w => w.live).find(s => s.id === JSON.parse(started.text).id);
      assert.deepEqual([mixed.model, mixed.thinking, mixed.logins], ['apex/pair', 'medium', ['anthropic', 'openai-codex']]);
      assert.equal((await post('/api/stop', {id: mixed.id})).status, 200);
      // The extended Windows target accepts every signed-in provider through the same launcher parser.
      // Without a chosen level a Windows model starts at medium, or at its top level when it has no medium.
      for (const [model, level] of [['anthropic/claude-opus-5-5', 'medium'], ['opencode-go/kimi-k3', 'max']]) {
        const other = await post('/api/start', {cwd: home, model, context: ['read'], core: ['todo']});
        assert.equal(other.status, 200, other.text);
        const live = (await state()).workspaces.flatMap(w => w.live).find(s => s.id === JSON.parse(other.text).id);
        assert.deepEqual([live.model, live.provider, live.thinking], [model, model.split('/')[0], level]);
        assert.equal((await post('/api/stop', {id: live.id})).status, 200);
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    await rm(home, {recursive: true, force: true});
  }
});

test('a running session changes its autocompact threshold through /autocompact; ended, eval and featureless sessions refuse', async () => {
  const home = await mkdtemp(join(tmpdir(), 'apex-dash-autocompact-'));
  const fixture = new URL('./fixtures/dashboard-rpc.mjs', import.meta.url).href;
  const {child, port, token} = await startDashboard({args: [...preload(fixture), server], env: {...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent')}});
  try {
    const login = await call(port, {path: `/?t=${token}`});
    const cookie = {cookie: login.headers['set-cookie'][0].split(';')[0]};
    const post = (path, body) => call(port, {method: 'POST', path, headers: {...cookie, origin: `http://127.0.0.1:${port}`}, body: JSON.stringify(body)});
    const live = async id => JSON.parse((await call(port, {path: '/api/state', headers: cookie})).text).workspaces.flatMap(w => w.live).find(s => s.id === id);
    const start = async body => { const r = await post('/api/start', {cwd: home, model: 'muse', ...body}); assert.equal(r.status, 200, r.text); return JSON.parse(r.text).id; };
    const settings = async (id, autocompactTokens) => { const r = await post('/api/settings', {id, autocompactTokens}); return {...JSON.parse(r.text), code: r.status}; };
    assert.equal((await post('/api/workspaces', {path: home})).status, 200);

    // A Muse experiment keeps its model (lock), yet its threshold changes: it adds no prompt or tool.
    const id = await start({features: ['autocompact'], autocompactTokens: 300000});
    assert.equal((await live(id)).flags.autocompactTokens, 300000);
    const raised = await settings(id, 500000);
    assert.equal(raised.code, 200, raised.error);
    assert.deepEqual([raised.flags.autocompactTokens, raised.relaunched, raised.id], [500000, false, id]);
    const after = await live(id);
    assert.deepEqual([after.flags.autocompactTokens, after.status, after.settled], [500000, 'idle', 0], 'the command ran in place: no model run started');
    for (const [bad, pattern] of [[0, /between 1 and 100000000/], [100000001, /between 1 and 100000000/], [1.5, /whole number/], ['lots', /whole number/], [null, /whole number/]]) {
      const refused = await settings(id, bad);
      assert.equal(refused.code, 400, `${bad} is refused`); assert.match(refused.error, pattern);
    }
    assert.equal((await live(id)).flags.autocompactTokens, 500000, 'a refused value keeps the last threshold');
    // A threshold typed in the chat reaches the agent the same way, and the reported value follows it.
    assert.equal((await post('/api/send', {id, message: '/autocompact 400000'})).status, 200);
    assert.equal((await live(id)).flags.autocompactTokens, 400000);
    // A clean exit leaves the live list (404 Unknown session); a failed one stays visible as ended.
    assert.equal((await post('/api/send', {id, message: 'exit on SIGTERM'})).status, 200);
    assert.equal((await post('/api/stop', {id})).status, 200);
    for (let i = 0; i < 50 && ['idle', 'running'].includes((await live(id)).status); i++) await new Promise(resolve => setTimeout(resolve, 20));
    const ended = await settings(id, 300000);
    assert.equal(ended.code, 409); assert.match(ended.error, /has ended/);

    const without = await start({features: ['cost']});
    const off = await settings(without, 300000);
    assert.equal(off.code, 409); assert.match(off.error, /Autocompact is off/);
    const isolated = await start({features: ['autocompact'], evalMode: true});
    const evalRefused = await settings(isolated, 500000);
    assert.equal(evalRefused.code, 409); assert.match(evalRefused.error, /eval isolation/);
    assert.equal((await live(isolated)).flags.autocompactTokens, 300000);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    await rm(home, {recursive: true, force: true});
  }
});

test('a login saved while the agent runs reaches it: the switch restarts the agent instead of failing in Pi', async () => {
  const home = await mkdtemp(join(tmpdir(), 'apex-dash-late-login-')), agent = join(home, 'agent');
  await mkdir(agent, {recursive: true});
  // Provider ids only: the fixture agent, like Pi, reads which logins are saved when it starts.
  const saveLogins = providers => writeFile(join(agent, 'auth.json'), JSON.stringify(Object.fromEntries(providers.map(provider => [provider, {type: 'api_key', key: 'fixture'}]))));
  await saveLogins(['opencode-go']);
  const fixture = new URL('./fixtures/dashboard-rpc.mjs', import.meta.url).href;
  const {child, port, token} = await startDashboard({args: [...preload(fixture), server], env: {...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: agent, APEX_FIXTURE_AUTH: '1'}});
  try {
    const login = await call(port, {path: `/?t=${token}`});
    const cookie = {cookie: login.headers['set-cookie'][0].split(';')[0]};
    const post = (path, body) => call(port, {method: 'POST', path, headers: {...cookie, origin: `http://127.0.0.1:${port}`}, body: JSON.stringify(body)});
    const settings = async (id, body) => { const r = await post('/api/settings', {id, ...body}); return {...JSON.parse(r.text), code: r.status}; };
    assert.equal((await post('/api/workspaces', {path: home})).status, 200);
    const started = await post('/api/start', {cwd: home, model: 'opencode-go/deepseek-v4.1-flash'});
    assert.equal(started.status, 200, started.text);
    const {id} = JSON.parse(started.text);
    const opus = {model: 'anthropic/claude-opus-4-8', thinking: 'high'};
    const unsigned = await settings(id, opus);
    assert.deepEqual([unsigned.code, unsigned.error], [409, 'Sign in to Claude using the dashboard button, then switch to Claude Opus 4.8.']);
    await saveLogins(['opencode-go', 'anthropic']); // the Claude sign-in, saved after the agent started
    const switched = await settings(id, opus);
    assert.equal(switched.code, 200, switched.error);
    assert.deepEqual([switched.model, switched.provider, switched.thinking, switched.logins, switched.relaunched], [opus.model, 'anthropic', 'high', ['anthropic'], true]);
    assert.notEqual(switched.id, id);
    // The restarted agent loaded both logins, so later switches stay live.
    const back = await settings(switched.id, {model: 'opencode-go/deepseek-v4.1-flash'});
    assert.deepEqual([back.code, back.model, back.relaunched], [200, 'opencode-go/deepseek-v4.1-flash', false]);
    const again = await settings(switched.id, {model: opus.model});
    assert.deepEqual([again.code, again.model, again.relaunched], [200, opus.model, false]);
    assert.equal((await post('/api/stop', {id: switched.id})).status, 200);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    await rm(home, {recursive: true, force: true});
  }
});

test('auto-approve answers safety prompts for one session, including waiting ones, and never catastrophic confirmations', async () => {
  const home = await mkdtemp(join(tmpdir(), 'apex-dash-auto-'));
  const fixture = new URL('./fixtures/dashboard-rpc.mjs', import.meta.url).href;
  const {child, port, token} = await startDashboard({args: [...preload(fixture), server], env: {...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent')}});
  try {
    const login = await call(port, {path: `/?t=${token}`});
    const cookie = {cookie: login.headers['set-cookie'][0].split(';')[0]};
    const post = (path, body) => call(port, {method: 'POST', path, headers: {...cookie, origin: `http://127.0.0.1:${port}`}, body: JSON.stringify(body)});
    assert.equal((await post('/api/workspaces', {path: home})).status, 200);
    const {id} = JSON.parse((await post('/api/start', {cwd: home, model: 'sol'})).text);
    const session = async () => JSON.parse((await call(port, {path: '/api/state', headers: cookie})).text).workspaces.flatMap(w => w.live).find(s => s.id === id);
    const titles = async () => (await session()).pending.map(p => p.title).sort();
    const log = () => new Promise(resolve => {
      const req = http.get({host: '127.0.0.1', port, path: `/api/events?id=${id}`, headers: {host: `127.0.0.1:${port}`, ...cookie}}, res => {
        let text = ''; res.on('data', chunk => { text += chunk; }); res.on('error', () => {});
        setTimeout(() => { resolve(text); req.destroy(); }, 200);
      });
      req.on('error', () => {});
    });
    assert.equal((await session()).autoApprove, false);
    assert.equal((await post('/api/send', {id, message: 'needs approval'})).status, 200);
    assert.deepEqual(await titles(), ['Confirm catastrophic command', 'Confirm tool action'], 'off by default');
    const on = await post('/api/auto-approve', {id, on: true});
    assert.equal(on.status, 200, on.text); assert.equal(JSON.parse(on.text).autoApprove, true);
    assert.deepEqual(await titles(), ['Confirm catastrophic command'], 'the waiting safety prompt is answered; the catastrophic one still asks');
    assert.equal((await post('/api/send', {id, message: 'needs approval'})).status, 200);
    assert.deepEqual(await titles(), ['Confirm catastrophic command', 'Confirm catastrophic command']);
    let text = await log();
    assert.match(text, /answered Confirm tool action#0\.25 true/); assert.match(text, /answered Confirm tool action#0\.5 true/);
    assert.doesNotMatch(text, /answered Confirm catastrophic/);
    assert.equal((text.match(/dashboard_auto_approved/g) ?? []).length, 2);
    assert.equal(JSON.parse((await post('/api/auto-approve', {id, on: false})).text).autoApprove, false);
    assert.equal((await post('/api/send', {id, message: 'needs approval'})).status, 200);
    assert.ok((await titles()).includes('Confirm tool action'), 'turning it off asks again');
    text = await log();
    assert.doesNotMatch(text, /answered Confirm tool action#0\.75/);
    assert.equal((await post('/api/stop', {id})).status, 200);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    await rm(home, {recursive: true, force: true});
  }
});

test('an agent killed by a signal ends its session with the exit code bin/apex reported for it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'apex-dash-signal-'));
  const fixture = new URL('./fixtures/dashboard-rpc.mjs', import.meta.url).href;
  const {child, port, token} = await startDashboard({args: [...preload(fixture), server], env: {...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent')}});
  try {
    const login = await call(port, {path: `/?t=${token}`});
    const cookie = {cookie: login.headers['set-cookie'][0].split(';')[0]};
    const post = (path, body) => call(port, {method: 'POST', path, headers: {...cookie, origin: `http://127.0.0.1:${port}`}, body: JSON.stringify(body)});
    const live = async () => JSON.parse((await call(port, {path: '/api/state', headers: cookie})).text).workspaces.flatMap(w => w.live);
    const exitOf = id => new Promise(resolve => {
      const req = http.get({host: '127.0.0.1', port, path: `/api/events?id=${id}`, headers: {host: `127.0.0.1:${port}`, ...cookie}}, res => {
        let text = ''; res.on('data', chunk => { text += chunk; }); res.on('error', () => {});
        setTimeout(() => { req.destroy(); resolve(text.split('\n\n').map(event => event.slice('data: '.length)).filter(Boolean).map(JSON.parse).find(event => event.type === 'dashboard_exit')); }, 200);
      });
      req.on('error', () => {});
    });
    assert.equal((await post('/api/workspaces', {path: home})).status, 200);
    const ids = {};
    for (const signal of ['SIGTERM', 'SIGINT']) {
      ids[signal] = JSON.parse((await post('/api/start', {cwd: home, model: 'sol'})).text).id;
      assert.equal((await post('/api/send', {id: ids[signal], message: `exit on ${signal}`})).status, 200);
      assert.equal((await post('/api/stop', {id: ids[signal]})).status, 200);
    }
    for (let tries = 0; (await live()).some(s => s.status !== 'error') && tries < 200; tries++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual((await live()).map(s => s.status), ['error', 'error'], 'a signalled agent stays listed as failed');
    assert.equal((await exitOf(ids.SIGTERM)).code, 1);
    assert.equal((await exitOf(ids.SIGINT)).code, 130);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    await rm(home, {recursive: true, force: true});
  }
});

test('the update check endpoint reports GitHub releases, names failures, refuses cross-origin writes and /api/state never calls GitHub', async () => {
  const home = await mkdtemp(join(tmpdir(), 'apex-dash-update-'));
  const answer = join(home, 'github.json'), requests = join(home, 'github.log'), local = join(home, 'local');
  const tag = 'v99.0.0', url = `https://github.com/ataberkus/apex/releases/tag/${tag}`;
  await writeFile(answer, JSON.stringify([{tag_name: tag, draft: false, prerelease: false, html_url: url, assets: []}]));
  await writeFile(requests, '');
  const fixture = new URL('./fixtures/github-releases-fetch.mjs', import.meta.url).href;
  const {child, port, token} = await startDashboard({args: [...preload(fixture), server], env: {...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'),
    LOCALAPPDATA: local, GH_TOKEN: 'test-token', APEX_TEST_GITHUB: answer, APEX_TEST_GITHUB_LOG: requests}});
  try {
    const cookie = {cookie: (await call(port, {path: `/?t=${token}`})).headers['set-cookie'][0].split(';')[0]};
    const check = headers => call(port, {method: 'POST', path: '/api/update/check', headers: {...headers, 'content-type': 'application/json'}, body: '{}'});
    assert.equal((await check(cookie)).status, 403, 'no Origin header');
    assert.equal((await check({...cookie, origin: 'http://evil.example'})).status, 403);
    assert.equal((await call(port, {method: 'POST', path: '/api/update/check', headers: {...cookie, origin: `http://127.0.0.1:${port}`}, body: '[]'})).status, 400);
    assert.equal(await readFile(requests, 'utf8'), '', 'refused requests never reach GitHub');

    const sameOrigin = {...cookie, origin: `http://127.0.0.1:${port}`};
    const installed = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
    const ok = await check(sameOrigin);
    assert.equal(ok.status, 200);
    const result = JSON.parse(ok.text);
    assert.equal(result.installed, installed);
    assert.equal(result.latest, '99.0.0');
    assert.equal(result.url, url);
    assert.equal(result.dev, installed === '0.0.0');
    assert.equal(result.available, installed !== '0.0.0');
    assert.equal(result.selfUpdate, process.platform === 'win32');
    assert.match(result.command, /^bun ".+[\\/]bin[\\/]apex" update$/);
    assert.equal(JSON.parse(await readFile(join(local, 'Apex', 'update.json'), 'utf8')).latestVersion, '99.0.0', 'the check is stored like apex update --check');

    const seen = (await readFile(requests, 'utf8')).split('\n').filter(Boolean).length;
    const state = JSON.parse((await call(port, {path: '/api/state', headers: cookie})).text);
    assert.equal(state.update.installed, installed);
    assert.equal(state.update.latest, '99.0.0', 'the page sees the stored answer');
    assert.equal(state.update.command, result.command);
    assert.equal((await readFile(requests, 'utf8')).split('\n').filter(Boolean).length, seen, '/api/state makes no GitHub request');

    await writeFile(answer, 'fail');
    const failed = await check(sameOrigin);
    assert.equal(failed.status, 502);
    assert.match(JSON.parse(failed.text).error, /Could not reach GitHub while listing Apex releases: fetch failed/);
  } finally {
    child.kill();
    await rm(home, {recursive: true, force: true});
  }
});

test('the sidebar shows the stored update hint and the button shows the check result with the install command', async () => {
  class Element {
    children = [];
    textContent = '';
    value = '';
    style = {};
    attributes = {};
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener() {}
    querySelector() { return null; }
  }
  const nodes = new Map();
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); },
    createElement() { return new Element(); },
    querySelectorAll() { return []; },
  };
  const command = 'bun "C:\\Users\\me\\AppData\\Local\\Programs\\Apex\\bin\\apex" update';
  const state = {workspaces: [], models: [], groups: [], auth: {}, usage: {}, update: {installed: '1.2.0', latest: '1.3.0', available: true, command, selfUpdate: true}};
  let answer, release;
  const pending = new Promise(resolve => { release = resolve; });
  const posts = [];
  const fetch = async (path, init) => {
    if (path !== '/api/update/check') return {ok: true, json: async () => state};
    posts.push(init);
    await pending;
    return answer;
  };
  const script = (await readFile(new URL('../dashboard/app.js', import.meta.url), 'utf8')).replace(/^import .* from .*;\r?\n/gm, '');
  runInNewContext(script, {document, localStorage: {}, IMAGE_HELP, MAX_IMAGES, fetch, setInterval() {}});
  await new Promise(resolve => setImmediate(resolve));
  const text = node => typeof node === 'string' ? node : [node.textContent, ...node.children.map(text)].join(' ');
  assert.equal(nodes.get('update-version').textContent, 'Apex 1.2.0');
  assert.equal(nodes.get('update-hint').hidden, false);
  assert.match(text(nodes.get('update-hint')), /Apex 1\.3\.0 is available\. Close this dashboard .* then run in a terminal:/);
  assert.ok(text(nodes.get('update-hint')).includes(command));

  const button = nodes.get('update-check');
  answer = {ok: true, json: async () => ({installed: '1.2.0', dev: false, latest: '1.3.0', tag: 'v1.3.0', url: 'https://github.com/ataberkus/apex/releases/tag/v1.3.0', available: true, command, selfUpdate: true})};
  const click = button.onclick();
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Checking…');
  assert.equal(nodes.get('update').attributes['aria-busy'], 'true');
  await button.onclick(); // a second click while busy sends nothing
  release();
  await click;
  assert.equal(posts.length, 1);
  assert.equal(posts[0].method, 'POST');
  assert.equal(posts[0].body, '{}');
  assert.equal(button.disabled, false);
  assert.equal(nodes.get('update').attributes['aria-busy'], undefined);
  const status = text(nodes.get('update-status'));
  assert.match(status, /Installed: Apex 1\.2\.0 .*Latest: .*Apex 1\.3\.0 .*Apex 1\.3\.0 is available\. Close this dashboard/);
  assert.ok(status.includes(command));
  assert.equal(nodes.get('update-status').children[1].children[0].href, 'https://github.com/ataberkus/apex/releases/tag/v1.3.0');
  assert.equal(nodes.get('update-hint').hidden, true, 'the result replaces the hint');

  answer = {ok: true, json: async () => ({installed: '0.0.0', dev: true, latest: null, tag: null, url: 'https://github.com/ataberkus/apex/releases', available: false, command, selfUpdate: true})};
  await button.onclick();
  assert.match(text(nodes.get('update-status')), /Installed: Apex 0\.0\.0 \(Git or development checkout; apex update never replaces it\) .*no published release .*Update this checkout with Git\./);

  answer = {ok: true, json: async () => ({installed: '1.3.0', dev: false, latest: '1.3.0', tag: 'v1.3.0', url: 'https://github.com/ataberkus/apex/releases/tag/v1.3.0', available: false, command, selfUpdate: false})};
  await button.onclick();
  assert.match(text(nodes.get('update-status')), /Apex is up to date\./);

  answer = {ok: false, json: async () => ({error: 'Timed out while listing Apex releases.'})};
  await button.onclick();
  assert.equal(nodes.get('update-error').hidden, false);
  assert.equal(nodes.get('update-error').textContent, 'Could not check for updates: Timed out while listing Apex releases.');
  assert.equal(button.disabled, false);
});

test('dashboard shows oh-my-pi subscription windows and resets, and flags unavailable usage', async () => {
  class Element {
    children = [];
    textContent = '';
    value = '';
    style = {};
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    removeAttribute() {}
    addEventListener() {}
    querySelector() { return null; }
  }
  const nodes = new Map();
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); },
    createElement() { return new Element(); },
    querySelectorAll() { return []; },
  };
  const resetsAt = Date.now() + 2 * 3600000 + 60000;
  const state = {workspaces: [], models: [], groups: [], auth: {'openai-codex': {label: 'Codex', type: 'oauth', signedIn: false}},
    usage: {anthropic: {label: 'Claude', limits: [{label: 'Claude 5 Hour', used: 0.42, resetsAt}, {label: 'Claude 7 Day', used: 0.07}]},
      'openai-codex': {label: 'Codex', error: 'HTTP401', signIn: true}, other: {label: 'Other', error: 'HTTP429', signIn: false}}};
  const script = (await readFile(new URL('../dashboard/app.js', import.meta.url), 'utf8')).replace(/^import .* from .*;\r?\n/gm, '');
  runInNewContext(script, {
    document, localStorage: {}, IMAGE_HELP, MAX_IMAGES, fetch: async () => ({json: async () => state}), setInterval() {},
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.get('subscription-usage').textContent, 'Claude: 5 Hour 42% used, 7 Day 7% used · Codex: usage unavailable · Other: usage unavailable');
  const text = node => [node.textContent, ...node.children.map(text)].join(' ');
  assert.match(text(nodes.get('p-use')), /Subscription usage.*Claude 5 Hour 42% used, resets in 2 h.*Claude 7 Day 7% used .*Codex: usage unavailable\. Sign in again if this persists\..*Other: usage unavailable \(HTTP429\), retrying\./);
  assert.doesNotMatch(text(nodes.get('p-use')), /estimate|allowance/);
});
