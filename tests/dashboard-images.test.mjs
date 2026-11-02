import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MAX_SEND_BODY_BYTES} from '../dashboard/attachments.mjs';

const PNG = {type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSfUAAAAASUVORK5CYII='};
function call(port, {method = 'GET', path = '/', headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, method, path, headers: {host: `127.0.0.1:${port}`, ...headers}}, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject); req.end(body);
  });
}

test('authenticated image sending forwards native image blocks, honors live capabilities, rejects bad data and waits for RPC acceptance', {timeout: 30000}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'apex-dash-images-')), textOnly = join(home, 'text-only');
  await mkdir(textOnly);
  const port = 42000 + Math.floor(Math.random() * 1000);
  const server = fileURLToPath(new URL('../dashboard/server.mjs', import.meta.url));
  // The fixture replaces child_process.spawn; live-builtins makes the server's named `spawn` import see that.
  const preload = ['--preload', fileURLToPath(new URL('../scripts/live-builtins.mjs', import.meta.url)), '--preload', fileURLToPath(new URL('./fixtures/dashboard-images-rpc.mjs', import.meta.url))];
  const child = spawn(process.execPath, [...preload, server], {env: {...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), APEX_DASH_PORT: String(port)}, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true});
  try {
    const token = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Dashboard startup timed out')), 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Dashboard exited: ${code}`)); });
      child.stdout.on('data', chunk => { const match = /\?t=(\S+)/.exec(String(chunk)); if (match) { clearTimeout(timer); resolve(match[1]); } });
    });
    assert.equal((await call(port, {path: '/vendor/marked.js'})).status, 403);
    const login = await call(port, {path: `/?t=${token}`});
    const cookie = {cookie: login.headers['set-cookie'][0].split(';')[0]};
    for (const path of ['/app.js', '/chat-content.mjs', '/attachments.mjs', '/vendor/marked.js']) {
      const asset = await call(port, {path, headers: cookie});
      assert.equal(asset.status, 200); assert.match(asset.headers['content-type'], /javascript/);
      assert.equal(asset.headers['x-content-type-options'], 'nosniff');
    }
    const post = (path, payload, headers = {}) => call(port, {method: 'POST', path, headers: {...cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', ...headers}, body: JSON.stringify(payload)});
    const state = async () => JSON.parse((await call(port, {path: '/api/state', headers: cookie})).text);
    const vision = (await state()).models.filter(m => ['sol', 'muse'].includes(m.id));
    assert.equal(vision.length, 2); assert.ok(vision.every(m => m.input.includes('image')));
    for (const cwd of [home, textOnly]) assert.equal((await post('/api/workspaces', {path: cwd})).status, 200);
    const start = async cwd => { const r = await post('/api/start', {cwd, model: 'muse'}); assert.equal(r.status, 200, r.text); return JSON.parse(r.text).id; };
    const id = await start(home), textId = await start(textOnly);
    const send = (message, images, sessionId = id) => post('/api/send', {id: sessionId, message, ...(images === undefined ? {} : {images})});
    assert.equal((await send('Inspect this', [{...PNG, name: 'stripped.png'}])).status, 200);
    assert.equal((await send('', [PNG])).status, 200);
    assert.equal((await send('keep running')).status, 200);
    assert.equal((await send('Steer with an image', [PNG])).status, 200);
    const largeBytes = Buffer.alloc(900000); Buffer.from(PNG.data, 'base64').copy(largeBytes);
    assert.equal((await send('Larger than the old JSON limit', [{...PNG, data: largeBytes.toString('base64')}])).status, 200);
    const rejected = await send('reject', [PNG]);
    assert.equal(rejected.status, 400); assert.match(rejected.text, /fixture rejected/);
    const noVision = await send('Image', [PNG], textId);
    assert.equal(noVision.status, 400); assert.match(noVision.text, /does not support images/);
    assert.equal((await send('Plain text', undefined, textId)).status, 200);
    for (const images of [Array(5).fill(PNG), [{...PNG, data: 'bad!'}], [{...PNG, mimeType: 'image/svg+xml'}], null]) assert.equal((await send('bad', images)).status, 400);
    assert.equal((await send('')).status, 400);
    assert.equal((await post('/api/send', {id, message: 'x'}, {'content-length': String(MAX_SEND_BODY_BYTES + 1)})).status, 413);
    const commands = (await readFile(join(home, 'image-prompts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(commands[0].images, [PNG]);
    assert.equal(commands[1].message, ''); assert.deepEqual(commands[1].images, [PNG]);
    assert.equal(commands[3].streamingBehavior, 'steer'); assert.deepEqual(commands[3].images, [PNG]);
    assert.equal(commands.length, 7, 'invalid requests must never reach the agent');
    assert.ok(commands.every(c => c.type === 'prompt' && typeof c.id === 'string'));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    await rm(home, {recursive: true, force: true});
  }
});
