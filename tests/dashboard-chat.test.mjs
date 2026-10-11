import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInContext} from 'node:vm';
import {JSDOM} from 'jsdom';
import {renderMarkdown, renderMessage, renderThought} from '../dashboard/chat-content.mjs';
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
  const state = {workspaces: [{path: 'C:\\project', live: sessions, saved: [], archived: []}], models: [], groups: [], auth: {'openai-codex': {label: 'Codex', type: 'oauth', signedIn: true}}};
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
  Object.assign(window, attachments, {renderMarkdown, renderMessage, renderThought});
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
const messages = panel => [...panel.querySelectorAll('.queue-text')].map(node => node.title);

test('steering is visible while queued without disturbing the streaming assistant', async t => {
  const c = await chat(t);
  c.emit({type: 'message_start', message: {role: 'assistant', content: []}});
  c.emit({type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: 'Still working.'}});
  c.emit(queue(['Change direction now']));
  assert.equal(c.$('queued').hidden, false);
  assert.deepEqual(messages(c.$('queued')), ['Change direction now']);
  assert.equal(c.$('queued').querySelector('.queue-count').textContent, '1 message queued');
  assert.equal(c.$('queued').querySelector('.queue-text').textContent, '[Steer] Change direction now');
  assert.equal(c.$('send').textContent, 'Steer');
  assert.equal(c.$('box').disabled, false);
  assert.equal(c.$('log').querySelector('.user'), null);

  c.emit(queue(['Change direction now'])); // snapshots must replace, not append
  c.emit({type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: ' Finishing this tool.'}});
  assert.equal(c.$('queued').querySelectorAll('.queue-text').length, 1);
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
  assert.equal(c.$('queued').querySelector('.queue-count').textContent, '4 messages queued');
  assert.deepEqual([...c.$('queued').querySelectorAll('.queue-actions')].map(a => [...a.children].map(b => b.title)),
    [['Edit', 'Remove'], ['Edit', 'Remove'], ['Edit', 'Remove'], ['Send now', 'Edit', 'Remove']]);
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

test('Add to queue sends a follow-up while running and is hidden when idle', async t => {
  const c = await chat(t);
  assert.equal(c.$('queue-send').hidden, false);
  c.$('box').value = 'Then write the summary';
  assert.equal(c.$('queue-send').textContent, 'Add to queue');
  await c.$('form').onsubmit({preventDefault() {}, submitter: c.$('queue-send')});
  assert.deepEqual(c.requests, [{id: 'first', message: 'Then write the summary', mode: 'followUp'}]);
  c.select(1);
  assert.equal(c.$('queue-send').hidden, true);
});

test('session exit keeps undelivered steering visible with an honest status', async t => {
  const c = await chat(t);
  c.emit(queue(['Do not lose this instruction']));
  c.sessions[0].status = 'error';
  c.emit({type: 'dashboard_exit', code: 1, stderr: 'Fixture stopped'});
  assert.deepEqual(messages(c.$('queued')), ['Do not lose this instruction']);
  assert.equal(c.$('queued').querySelector('.queue-count').textContent, '1 message not delivered — session ended');
  assert.equal(c.$('queued').querySelector('button'), null, 'nothing to re-queue into an ended session');
  assert.equal(c.$('log').querySelector('.user'), null);
  c.select(1);
  assert.equal(c.$('queued').hidden, true);
});

// One turn: thinking, then read, bash, edit (with Pi's diff), grep and a repeated read, then the reply.
const DIFF = ' 1 keep\n-2 old\n+2 new\n+3 added';
const CALLS = [
  ['r1', 'read', {path: 'C:\\p\\dashboard\\app.js'}, {content: [{type: 'text', text: 'source'}]}],
  ['b1', 'bash', {command: 'npm test\necho second line'}, {content: [{type: 'text', text: 'ok'}]}],
  ['e1', 'edit', {path: 'dashboard/chat-content.mjs'}, {content: [{type: 'text', text: 'edited'}], details: {diff: DIFF}}],
  ['g1', 'grep', {pattern: 'thinking_(start|end)'}, {content: [{type: 'text', text: 'match'}]}],
  ['r2', 'read', {path: 'C:\\p\\dashboard\\app.js'}, {content: [{type: 'text', text: 'source'}]}],
];
const THOUGHT = '**Check the config first.**\nThen edit.';
const shape = log => [...log.children].map(n => n.matches('.activity')
  ? ['activity', n.querySelector('summary').textContent, [...n.querySelectorAll('.step>summary')].map(s => s.textContent), n.querySelectorAll('.step .diff').length]
  : [n.className, n.textContent]);
const EXPECTED = [
  ['activity', 'Thought, read 1 file, ran a command, edited 1 file, searched code+2\u22121',
    ['ThoughtCheck the config first.', 'Readapp.js', 'Rannpm test', 'Editedchat-content.mjs+2\u22121', 'Searchedthinking_(start|end)', 'Readapp.js'], 1],
  ['assistant', 'Done.'],
];

test('a live turn groups thinking and tools under one summary with a spinner and current step, closed by the reply', async t => {
  const c = await chat(t), update = assistantMessageEvent => c.emit({type: 'message_update', assistantMessageEvent});
  c.emit({type: 'message_start', message: {role: 'assistant', content: []}});
  update({type: 'thinking_start', contentIndex: 0});
  update({type: 'thinking_delta', contentIndex: 0, delta: '**Check the config'});
  update({type: 'thinking_delta', contentIndex: 0, delta: ' first.**\nThen edit.'});
  const group = c.$('log').querySelector('.activity'), summary = group.querySelector('summary');
  assert.ok(summary.querySelector('.spinner'));
  assert.equal(summary.querySelector('.doing').textContent, 'Thinking');
  assert.equal(group.querySelector('.step.thought i').textContent, 'Check the config first.');
  update({type: 'thinking_end', contentIndex: 0, content: THOUGHT});
  c.emit({type: 'message_end', message: {role: 'assistant', content: [{type: 'thinking', thinking: THOUGHT}, ...CALLS.map(([id, name, args]) => ({type: 'toolCall', id, name, arguments: args}))]}});
  for (const [id, name, args, result] of CALLS) {
    c.emit({type: 'tool_execution_start', toolCallId: id, toolName: name, args});
    if (id === 'b1') assert.equal(summary.querySelector('.doing').textContent, 'Running npm test');
    c.emit({type: 'tool_execution_end', toolCallId: id, toolName: name, result, isError: false});
  }
  assert.ok(summary.querySelector('.spinner'), 'still live until the reply');
  assert.equal(summary.querySelector('.doing'), null, 'no step running');
  c.emit({type: 'message_start', message: {role: 'assistant', content: []}});
  update({type: 'text_delta', contentIndex: 0, delta: 'Done.'});
  c.emit({type: 'message_end', message: {role: 'assistant', content: [{type: 'text', text: 'Done.'}]}});
  assert.equal(summary.querySelector('.spinner'), null);
  assert.deepEqual(shape(c.$('log')), EXPECTED);
  const thought = group.querySelector('.step.thought');
  assert.equal(thought.open, false);
  assert.equal(thought.querySelector('.step-body').textContent, 'Check the config first.Then edit.'); // full Markdown, <br> between lines
});

test('a get_messages replay of the same turn builds the same groups as the live stream', async t => {
  const c = await chat(t);
  c.emit({type: 'response', command: 'get_messages', success: true, data: {messages: [
    {role: 'assistant', content: [{type: 'thinking', thinking: THOUGHT}, ...CALLS.map(([id, name, args]) => ({type: 'toolCall', id, name, arguments: args}))]},
    ...CALLS.map(([id, name, , result]) => ({role: 'toolResult', toolCallId: id, toolName: name, ...result, isError: false})),
    {role: 'assistant', content: [{type: 'text', text: 'Done.'}]},
  ]}});
  assert.deepEqual(shape(c.$('log')), EXPECTED);
  assert.equal(c.$('log').querySelector('.spinner'), null);
});

test('Codex reasoning without a summary (empty text, encrypted signature) adds no Thought row', async t => {
  const c = await chat(t), update = assistantMessageEvent => c.emit({type: 'message_update', assistantMessageEvent});
  c.emit({type: 'message_start', message: {role: 'assistant', content: []}});
  update({type: 'thinking_start', contentIndex: 0});
  update({type: 'thinking_end', contentIndex: 0, content: ''});
  c.emit({type: 'message_end', message: {role: 'assistant', content: [{type: 'thinking', thinking: '', thinkingSignature: '{"type":"reasoning","encrypted_content":"x"}'}, {type: 'toolCall', id: 'b', name: 'bash', arguments: {command: 'ls'}}]}});
  c.emit({type: 'tool_execution_start', toolCallId: 'b', toolName: 'bash', args: {command: 'ls'}});
  c.emit({type: 'tool_execution_end', toolCallId: 'b', toolName: 'bash', result: {content: []}, isError: false});
  c.emit({type: 'agent_end', messages: []});
  assert.deepEqual(shape(c.$('log')), [['activity', 'Ran a command', ['Ranls'], 0]]);
});

test('a thinking-only message still shows its thought', async t => {
  const c = await chat(t);
  c.emit({type: 'message_start', message: {role: 'assistant', content: []}});
  c.emit({type: 'message_end', message: {role: 'assistant', content: [{type: 'thinking', thinking: 'Only thoughts.'}]}});
  assert.equal(c.$('log').querySelector('.activity .step.thought i').textContent, 'Only thoughts.');
});

test('auto-approvals and extension notes during a turn stay in its group; approval arguments stay folded', async t => {
  const c = await chat(t);
  const start = (id, command) => c.emit({type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: {command}});
  const end = id => c.emit({type: 'tool_execution_end', toolCallId: id, toolName: 'bash', result: {content: []}, isError: false});
  start('a', 'npm test'); end('a');
  const huge = {path: 'C:\\p\\server.ts', edits: [{oldText: 'x', newText: 'y'.repeat(3000)}]};
  c.emit({type: 'dashboard_auto_approved', message: `Tool: edit\nArguments: ${JSON.stringify(huge)}\nThis tool can change files.\nTool annotation hints are unverified.`});
  c.emit({type: 'extension_ui_request', method: 'notify', message: 'Checkpoint saved'});
  start('b', 'rm -rf build'); // Pi starts the tool, then the safety gate asks
  c.emit({type: 'dashboard_auto_approved', message: `Tool: bash\nArguments: {"command":"rm -rf bu [truncated]\nReason`});
  end('b');
  const log = c.$('log'), rows = [...log.querySelector('.steps').children];
  assert.equal(log.querySelectorAll('.activity').length, 1);
  assert.ok(log.querySelector('.activity summary .spinner'), 'still live');
  assert.deepEqual(rows.map(n => n.querySelector('summary')?.textContent ?? n.textContent),
    ['Rannpm test', 'Auto-approvededit', 'Checkpoint saved', 'Ranrm -rf buildauto-approved']);
  assert.equal(rows[3].querySelector('pre'), null, 'the matching row already shows the command');
  assert.equal(rows[1].open, false);
  assert.deepEqual(JSON.parse(rows[1].querySelector('pre').textContent), huge, 'unmatched approval: full arguments, pretty, on demand');
  assert.equal(log.querySelector('.activity summary .what').textContent, 'Ran 2 commands');
});
