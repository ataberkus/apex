import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {IMAGE_HELP, MAX_IMAGES} from '../dashboard/attachments.mjs';
import {buildPiInvocation, resolvePi} from '../lib/launcher.mjs';
import {withWindowsDefaults} from '../lib/windows-target.mjs';

const server = fileURLToPath(new URL('../dashboard/server.mjs', import.meta.url));

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
  const port = 47000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [server], {env: {...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), APEX_DASH_PORT: String(port)}, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true});
  try {
    const token = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', chunk => { const match = /\?t=(\S+)/.exec(String(chunk)); if (match) resolve(match[1]); });
    });
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
  const port = 48000 + Math.floor(Math.random() * 1000);
  const fixture = new URL('./fixtures/dashboard-rpc.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--import', fixture, server], {env: {...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), APEX_DASH_PORT: String(port), APEX_FIXTURE_ARGV: join(home, 'argv.jsonl')}, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true});
  try {
    const token = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Dashboard startup timed out')), 20000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Dashboard exited: ${code}`)); });
      child.stdout.on('data', chunk => { const match = /\?t=(\S+)/.exec(String(chunk)); if (match) { clearTimeout(timer); resolve(match[1]); } });
    });
    const login = await call(port, {path: `/?t=${token}`});
    const cookie = {cookie: login.headers['set-cookie'][0].split(';')[0]};
    const state = async () => JSON.parse((await call(port, {path: '/api/state', headers: cookie})).text);
    const post = (path, body) => call(port, {method: 'POST', path, headers: {...cookie, origin: `http://127.0.0.1:${port}`}, body: JSON.stringify(body)});
    assert.deepEqual((await state()).usage, {}, 'no saved subscription login, so oh-my-pi is never asked for usage');
    assert.equal((await post('/api/workspaces', {path: home})).status, 200);
    const started = await post('/api/start', {cwd: home, model: 'sol'});
    assert.equal(started.status, 200, started.text);
    // The child's bin/apex adds the Windows defaults to a launch without selection, so "Plain agent" must opt out.
    const [plainArgs] = (await readFile(join(home, 'argv.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(!buildPiInvocation(withWindowsDefaults(plainArgs), resolvePi().cli).args.includes('--extension'), 'nothing picked runs stock Pi');
    const {id} = JSON.parse(started.text);
    const sent = await post('/api/send', {id, message: 'Offline fixture prompt'});
    assert.equal(sent.status, 200, sent.text);
    const settings = async body => { const r = await post('/api/settings', {id, ...body}); return {...JSON.parse(r.text), code: r.status}; };
    const thought = await settings({thinking: 'medium'});
    assert.equal(thought.code, 200); assert.equal(thought.thinking, 'medium'); assert.deepEqual(thought.levels, ['low', 'medium', 'high', 'xhigh']);
    assert.equal((await settings({thinking: 'max'})).thinking, 'xhigh', 'the agent clamps unsupported levels and the dashboard reports what it chose');
    const switched = await settings({model: 'muse'});
    assert.equal(switched.model, 'muse'); assert.deepEqual(switched.input, ['text']);
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
      // Without a chosen level a model starts at xhigh, or at its top level when it has no xhigh.
      for (const [model, level] of [['anthropic/claude-opus-5-5', 'xhigh'], ['opencode-go/kimi-k3', 'max']]) {
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

test('auto-approve answers safety prompts for one session, including waiting ones, and never catastrophic confirmations', async () => {
  const home = await mkdtemp(join(tmpdir(), 'apex-dash-auto-'));
  const port = 49000 + Math.floor(Math.random() * 1000);
  const fixture = new URL('./fixtures/dashboard-rpc.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--import', fixture, server], {env: {...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), APEX_DASH_PORT: String(port)}, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true});
  try {
    const token = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Dashboard startup timed out')), 20000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', chunk => { const match = /\?t=(\S+)/.exec(String(chunk)); if (match) { clearTimeout(timer); resolve(match[1]); } });
    });
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
      'openai-codex': {label: 'Codex', error: true}}};
  const script = (await readFile(new URL('../dashboard/app.js', import.meta.url), 'utf8')).replace(/^import .* from .*;\r?\n/gm, '');
  runInNewContext(script, {
    document, localStorage: {}, IMAGE_HELP, MAX_IMAGES, fetch: async () => ({json: async () => state}), setInterval() {},
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.get('subscription-usage').textContent, 'Claude: 5 Hour 42% used, 7 Day 7% used · Codex: usage unavailable');
  const text = node => [node.textContent, ...node.children.map(text)].join(' ');
  assert.match(text(nodes.get('p-use')), /Subscription usage.*Claude 5 Hour 42% used, resets in 2 h.*Claude 7 Day 7% used .*Codex: usage unavailable/);
  assert.doesNotMatch(text(nodes.get('p-use')), /estimate|allowance/);
});
