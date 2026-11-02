import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {runInContext} from 'node:vm';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {renderMarkdown, renderMessage, renderThought} from '../dashboard/chat-content.mjs';
import * as attachments from '../dashboard/attachments.mjs';

const server = fileURLToPath(new URL('../dashboard/server.mjs', import.meta.url));
const [html, script] = await Promise.all([
  readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../dashboard/app.js', import.meta.url), 'utf8'),
]);

const transcript = [
  {role: 'user', content: 'List the files', timestamp: 1},
  {role: 'assistant', content: [{type: 'text', text: 'Looking.'}, {type: 'toolCall', id: 'call-1', name: 'bash', arguments: {command: 'ls'}}], timestamp: 2},
  {role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{type: 'text', text: 'a.txt'}], isError: false, timestamp: 3},
  {role: 'assistant', content: [{type: 'text', text: 'One file: a.txt'}], timestamp: 4},
];
const sessionLines = cwd => [{type: 'session', version: 3, id: 'sess', timestamp: '2026-01-01T00:00:00.000Z', cwd},
  ...transcript.map((message, i) => ({type: 'message', id: `m${i}`, parentId: i ? `m${i - 1}` : null, timestamp: '2026-01-01T00:00:00.000Z', message}))]
  .map(line => JSON.stringify(line)).join('\n') + '\n';

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

test('/api/transcript returns a listed workspace session file and refuses files outside its session folder, starting no agent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'apex-dash-transcript-'));
  const port = 41000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [server], {env: {...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), APEX_DASH_PORT: String(port)}, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true});
  try {
    const token = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Dashboard startup timed out')), 20000);
      child.once('error', reject);
      child.stdout.on('data', chunk => { const match = /\?t=(\S+)/.exec(String(chunk)); if (match) { clearTimeout(timer); resolve(match[1]); } });
    });
    const headers = {cookie: (await call(port, {path: `/?t=${token}`})).headers['set-cookie'][0].split(';')[0]};
    const get = file => call(port, {path: '/api/transcript?file=' + encodeURIComponent(file), headers});
    const project = join(home, 'project'); await mkdir(project);
    const added = await call(port, {method: 'POST', path: '/api/workspaces', headers: {...headers, origin: `http://127.0.0.1:${port}`}, body: JSON.stringify({path: project})});
    const cwd = JSON.parse(added.text).path;
    const dir = join(home, 'agent', 'sessions', `--${cwd.replace(/^[\\/]/, '').replace(/[\\/:]/g, '-')}--`);
    await mkdir(dir, {recursive: true});
    const file = join(dir, 'saved.jsonl'), outside = join(home, 'outside.jsonl'), unlisted = join(home, 'agent', 'sessions', '--elsewhere--', 'other.jsonl');
    await writeFile(file, sessionLines(cwd));
    await writeFile(outside, sessionLines(cwd));
    await mkdir(join(home, 'agent', 'sessions', '--elsewhere--'));
    await writeFile(unlisted, sessionLines(cwd));

    const ok = await get(file);
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.text).messages, transcript);

    for (const path of [outside, join(dir, '..', '..', '..', 'outside.jsonl'), unlisted, join(dir, 'missing.jsonl'), join(home, 'dashboard.json')]) {
      const refused = await get(path);
      assert.equal(refused.status, 404, path);
      assert.match(refused.text, /not found in a listed workspace/);
    }
    assert.equal((await call(port, {path: '/api/transcript?file=x'})).status, 403, 'the startup token still guards reads');
    assert.deepEqual(JSON.parse((await call(port, {path: '/api/state', headers})).text).workspaces[0].live, [], 'reading starts no agent');
  } finally {
    child.kill();
    await rm(home, {recursive: true, force: true});
  }
});

test('clicking a saved session shows its transcript read-only, without the launch dialog or an agent, and Resume opens the dialog', async t => {
  const dom = new JSDOM(html, {url: 'http://127.0.0.1:4777', runScripts: 'outside-only'});
  t.after(async () => { await new Promise(resolve => setImmediate(resolve)); dom.window.close(); });
  const {window} = dom, requests = [], streams = [];
  const saved = {file: 'C:\\agent\\sessions\\--C--project--\\saved.jsonl', title: 'List the files', mtime: Date.now()};
  const state = {workspaces: [{path: 'C:\\project', live: [], saved: [saved], archived: []}], models: [], groups: [], auth: {}, defaults: {context: [], core: [], features: []}};
  window.fetch = async (path, options) => {
    requests.push(path);
    if (path === '/api/state') return {ok: true, json: async () => state};
    assert.equal(path, '/api/transcript?file=' + encodeURIComponent(saved.file));
    assert.equal(options, undefined);
    return {ok: true, json: async () => ({messages: transcript})};
  };
  window.EventSource = class { constructor(url) { streams.push(url); } close() {} };
  let opened = 0;
  window.HTMLDialogElement.prototype.showModal = () => { opened++; };
  Object.assign(window, attachments, {renderMarkdown, renderMessage, renderThought, structuredClone});
  window.setInterval = () => 0;
  window.setTimeout = (callback, delay) => { if (delay === 50) callback(); return 0; };
  runInContext(script.replace(/^import .* from .*;\r?\n/gm, ''), dom.getInternalVMContext());
  await new Promise(resolve => setImmediate(resolve));
  const $ = id => window.document.getElementById(id);

  [...$('groups').querySelectorAll('.saved-row .row')].find(b => b.textContent.includes(saved.title)).click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened, 0, 'no launch dialog');
  assert.deepEqual(streams, [], 'no agent event stream');
  assert.ok(!requests.includes('/api/start'));
  const log = $('log');
  assert.equal(log.querySelector('.user').textContent, 'List the files');
  assert.equal(log.querySelector('.activity summary').textContent, 'Ran a command');
  assert.match(log.querySelector('.activity .step summary').textContent, /^Ran\s*ls/);
  assert.match(log.textContent, /One file: a\.txt/);
  assert.equal($('form').hidden, true, 'no sending or model changes while read-only');
  assert.equal($('resume').hidden, false);
  assert.equal($('end').hidden, true);
  assert.equal($('title').textContent, saved.title);

  $('resume').click();
  assert.equal(opened, 1);
  assert.equal($('launch-h').textContent, 'Resume session');
});
