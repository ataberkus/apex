import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInContext} from 'node:vm';
import {JSDOM} from 'jsdom';
import {renderMarkdown, renderMessage} from '../dashboard/chat-content.mjs';
import * as attachments from '../dashboard/attachments.mjs';

const [html, script] = await Promise.all([
  readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../dashboard/app.js', import.meta.url), 'utf8'),
]);

async function chat(t) {
  const dom = new JSDOM(html, {url: 'http://127.0.0.1:4777', runScripts: 'outside-only'});
  t.after(async () => { await new Promise(resolve => setImmediate(resolve)); dom.window.close(); });
  const {window} = dom, streams = [], requests = [];
  const sessions = [
    {id: 'first', title: 'Working session', cwd: 'C:\\project', model: 'sol', thinking: 'xhigh', status: 'running', pending: [], settled: 0},
    {id: 'second', title: 'Other session', cwd: 'C:\\project', model: 'sol', thinking: 'xhigh', status: 'idle', pending: [], settled: 0},
  ];
  const state = {workspaces: [{path: 'C:\\project', live: sessions, saved: []}], models: [], groups: [], codex: {signedIn: true}};
  let sendError = null;
  window.fetch = async (path, options) => {
    if (path === '/api/state') return {ok: true, json: async () => state};
    assert.equal(path, '/api/send');
    requests.push(JSON.parse(options.body));
    return {ok: !sendError, json: async () => sendError ? {error: sendError} : {}};
  };
  window.EventSource = class {
    constructor(url) { this.url = url; streams.push(this); }
    close() { this.closed = true; }
  };
  Object.assign(window, attachments, {renderMarkdown, renderMessage});
  window.setInterval = () => 0;
  window.setTimeout = (callback, delay) => { if (delay === 50) callback(); return 0; }; // advance Markdown paint time, not polling
  const context = dom.getInternalVMContext();
  runInContext(script.replace(/^import .* from .*;\r?\n/gm, ''), context);
  await new Promise(resolve => setImmediate(resolve));
  const select = (index = 0) => runInContext(`select(${JSON.stringify(sessions[index])})`, context);
  select();
  return {
    $: id => window.document.getElementById(id), sessions, streams, requests, select,
    emit: event => streams.at(-1).onmessage({data: JSON.stringify(event)}),
    rejectSend: error => { sendError = error; },
  };
}

const queue = (steering = [], followUp = []) => ({type: 'queue_update', steering, followUp});
const user = content => ({type: 'message_end', message: {role: 'user', content}});
const messages = panel => [...panel.querySelectorAll('.user p')].map(node => node.textContent);

test('steering is visible while queued without disturbing the streaming assistant', async t => {
  const c = await chat(t);
  c.emit({type: 'message_start', message: {role: 'assistant', content: []}});
  c.emit({type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: 'Still working.'}});
  c.emit(queue(['Change direction now']));
  assert.equal(c.$('queued').hidden, false);
  assert.deepEqual(messages(c.$('queued')), ['Change direction now']);
  assert.equal(c.$('queued').querySelector('.queued-label').textContent, 'Queued steering');
  assert.equal(c.$('send').textContent, 'Steer');
  assert.equal(c.$('box').disabled, false);
  assert.equal(c.$('log').querySelector('.user'), null);

  c.emit(queue(['Change direction now'])); // snapshots must replace, not append
  c.emit({type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: ' Finishing this tool.'}});
  assert.equal(c.$('queued').querySelectorAll('.user').length, 1);
  assert.equal(c.$('log').querySelector('.assistant').textContent, 'Still working. Finishing this tool.');

  c.emit({type: 'message_end', message: {role: 'assistant', content: [{type: 'text', text: 'Still working. Finishing this tool.'}]}});
  c.emit(queue()); // Pi dequeues before the authoritative user message
  c.emit({type: 'message_start', message: {role: 'user', content: 'Change direction now'}});
  c.emit(user('Change direction now'));
  assert.equal(c.$('queued').hidden, true);
  assert.equal(c.$('queued').children.length, 0);
  assert.equal(c.$('log').querySelectorAll('.user').length, 1);
  assert.equal(c.$('log').querySelector('.user').textContent, 'Change direction now');
});

test('queue snapshots preserve repeated messages, multiline text and follow-ups until each is delivered', async t => {
  const c = await chat(t), long = '消息 🧭\n' + 'a'.repeat(500) + '\n<script>alert(1)</script>';
  c.emit(queue(['Same instruction', 'Same instruction', long], ['Afterwards, summarize']));
  assert.deepEqual(messages(c.$('queued')), ['Same instruction', 'Same instruction', long, 'Afterwards, summarize']);
  assert.equal(c.$('queued').querySelectorAll('.queued-label')[3].textContent, 'Queued follow-up');
  assert.equal(c.$('queued').querySelector('script'), null);
  assert.equal(c.$('queued').getAttribute('aria-live'), 'polite');

  c.emit(queue(['Same instruction', long], ['Afterwards, summarize']));
  c.emit(user('Same instruction'));
  c.emit(queue([long], ['Afterwards, summarize']));
  c.emit(user([{type: 'text', text: 'Same instruction'}]));
  assert.equal(c.$('log').querySelectorAll('.user').length, 2);
  assert.deepEqual(messages(c.$('queued')), [long, 'Afterwards, summarize']);
  c.emit(queue([], ['Afterwards, summarize']));
  c.emit(user(long));
  assert.deepEqual(messages(c.$('queued')), ['Afterwards, summarize']);
  c.emit(queue());
  c.emit(user('Afterwards, summarize'));
  assert.equal(c.$('queued').hidden, true);
  assert.equal(c.$('log').querySelectorAll('.user').length, 4);
});

test('switching sessions clears queued input and SSE replay restores only the current queue', async t => {
  const c = await chat(t), replay = [
    queue(['Delivered earlier', 'Still waiting']),
    queue(['Still waiting']),
    user('Delivered earlier'),
  ];
  for (const event of replay) c.emit(event);
  c.select(1);
  assert.equal(c.streams[0].closed, true);
  assert.equal(c.$('queued').hidden, true);
  assert.equal(c.$('queued').children.length, 0);
  assert.equal(c.$('log').querySelector('.user'), null);
  c.select(0);
  for (const event of replay) c.emit(event);
  assert.deepEqual(messages(c.$('queued')), ['Still waiting']);
  assert.equal(c.$('log').querySelectorAll('.user').length, 1);
  assert.equal(c.$('log').querySelector('.user').textContent, 'Delivered earlier');
});

test('cleared queues disappear and rejected sends retain the draft without a phantom queued message', async t => {
  const c = await chat(t);
  c.emit(queue(['Cancel this'], ['Cancel this too']));
  c.emit(queue());
  assert.equal(c.$('queued').hidden, true);
  assert.equal(c.$('log').querySelector('.user'), null);
  c.rejectSend('Sign in to Codex, then try again.');
  c.$('box').value = 'Try a steering message';
  await c.$('form').onsubmit({preventDefault() {}});
  assert.deepEqual(c.requests, [{id: 'first', message: 'Try a steering message'}]);
  assert.equal(c.$('box').value, 'Try a steering message');
  assert.equal(c.$('queued').hidden, true);
  assert.equal(c.$('log').querySelector('.note').textContent, 'Sign in to Codex, then try again.');
});

test('session exit keeps undelivered steering visible with an honest status', async t => {
  const c = await chat(t);
  c.emit(queue(['Do not lose this instruction']));
  c.sessions[0].status = 'error';
  c.emit({type: 'dashboard_exit', code: 1, stderr: 'Fixture stopped'});
  assert.deepEqual(messages(c.$('queued')), ['Do not lose this instruction']);
  assert.equal(c.$('queued').querySelector('.queued-label').textContent, 'Not delivered — session ended');
  assert.equal(c.$('log').querySelector('.user'), null);
  c.select(1);
  assert.equal(c.$('queued').hidden, true);
});
