import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const server = fileURLToPath(new URL('../dashboard/server.mjs', import.meta.url));

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({host: '127.0.0.1', port, path, headers: {host: `127.0.0.1:${port}`, ...headers}}, res => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject);
  });
}

// Starts the real dashboard server against a throwaway home; no session or model call is ever made.
async function start(t, args, env = {}) {
  const home = await mkdtemp(join(tmpdir(), 'apex-desktop-test-'));
  const child = spawn(process.execPath, [server, ...args], {env: {...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), ...env}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    await rm(home, {recursive: true, force: true});
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const lines = [];
  createInterface({input: child.stdout}).on('line', line => lines.push(line));
  const exited = once(child, 'exit').then(([code]) => ({code, stderr}));
  return {child, lines, exited};
}
const waitFor = async (check, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await delay(50)) { const value = check(); if (value) return value; }
  throw new Error('timed out');
};

test('--port 0 --desktop binds a free port, prints a ready line and accepts only that port as Host', async t => {
  const {lines} = await start(t, ['--port', '0', '--desktop']);
  const ready = await waitFor(() => lines.find(line => line.startsWith('{')));
  const url = new URL(JSON.parse(ready).apexDashboard);
  const port = Number(url.port);
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(port > 0 && port !== 4777, `free port, got ${port}`);
  const login = await get(port, `/?t=${url.searchParams.get('t')}`);
  assert.equal(login.statusCode, 302);
  const cookie = {cookie: login.headers['set-cookie'][0].split(';')[0]};
  assert.equal((await get(port, '/api/state', cookie)).statusCode, 200);
  for (const host of ['127.0.0.1:0', '127.0.0.1:4777']) assert.equal((await get(port, '/api/state', {...cookie, host})).statusCode, 403, host);
});

test('closing stdin stops a --desktop server cleanly', async t => {
  const {child, lines, exited} = await start(t, ['--port', '0', '--desktop']);
  await waitFor(() => lines.find(line => line.startsWith('{')));
  child.stdin.end();
  const {code} = await Promise.race([exited, delay(5000).then(() => ({code: 'still running after 5 s'}))]);
  assert.equal(code, 0);
});

test('without --desktop the server prints no ready line and ignores stdin closing', async t => {
  const {child, lines} = await start(t, ['--port', '0']);
  await waitFor(() => lines.find(line => line.startsWith('Apex dashboard: ')));
  child.stdin.end();
  await delay(1000);
  assert.equal(child.exitCode, null, 'still running');
  assert.equal(lines.some(line => line.startsWith('{')), false);
});

test('--port overrides APEX_DASH_PORT, and an invalid port is refused with exit code 2', async t => {
  const ok = await start(t, ['--port', '0'], {APEX_DASH_PORT: 'not-a-port'});
  await waitFor(() => ok.lines.find(line => line.startsWith('Apex dashboard: ')));
  for (const [args, env] of [[['--port', 'abc'], {}], [['--port'], {}], [['--port', '70000'], {}], [[], {APEX_DASH_PORT: 'not-a-port'}]]) {
    const {code, stderr} = await (await start(t, args, env)).exited;
    assert.equal(code, 2, JSON.stringify({args, env}));
    assert.match(stderr, /Port must be a whole number from 0 to 65535/);
  }
});
