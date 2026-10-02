import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInContext} from 'node:vm';
import {JSDOM} from 'jsdom';
import {renderMarkdown, renderMessage} from '../dashboard/chat-content.mjs';
import * as attachments from '../dashboard/attachments.mjs';

const PNG = {type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSfUAAAAASUVORK5CYII='};
const [html, app] = await Promise.all([readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8'), readFile(new URL('../dashboard/app.js', import.meta.url), 'utf8')]);
async function chat(t) {
  const dom = new JSDOM(html, {url: 'http://127.0.0.1:4777', runScripts: 'outside-only'});
  t.after(() => dom.window.close());
  const {window} = dom, streams = [], requests = [];
  Object.assign(window, attachments, {renderMarkdown, renderMessage});
  const sessions = [
    {id: 'first', title: 'Vision session', cwd: 'C:\\project', model: 'muse', input: ['text', 'image'], thinking: 'high', status: 'idle', pending: [], settled: 0},
    {id: 'second', title: 'Other session', cwd: 'C:\\project', model: 'muse', input: ['text', 'image'], thinking: 'high', status: 'idle', pending: [], settled: 0},
    {id: 'text', title: 'Text only', cwd: 'C:\\project', model: 'muse', input: ['text'], thinking: 'high', status: 'idle', pending: [], settled: 0},
    {id: 'unsigned', title: 'Unsigned Codex', cwd: 'C:\\project', model: 'sol', provider: 'openai-codex', input: ['text', 'image'], thinking: 'high', status: 'idle', pending: [], settled: 0},
  ];
  const state = {workspaces: [{path: 'C:\\project', live: sessions, saved: []}], models: [{id: 'muse', label: 'Muse', input: ['text', 'image']}], groups: [], auth: {'openai-codex': {label: 'Codex', type: 'oauth', signedIn: false}}};
  let error = null;
  window.fetch = async (path, options) => {
    if (path === '/api/state') return {ok: true, json: async () => state};
    assert.equal(path, '/api/send'); requests.push(JSON.parse(options.body));
    return {ok: !error, json: async () => error ? {error} : {}};
  };
  window.EventSource = class { constructor() { streams.push(this); } close() { this.closed = true; } };
  window.setInterval = () => 0;
  const context = dom.getInternalVMContext();
  runInContext(app.replace(/^import .* from .*;\r?\n/gm, ''), context);
  await new Promise(resolve => setImmediate(resolve));
  const select = (index = 0) => runInContext(`select(${JSON.stringify(sessions[index])})`, context);
  select();
  const file = (name = 'screen.png', type = 'image/png', bytes = Buffer.from(PNG.data, 'base64')) => new window.File([bytes], name, {type});
  return {
    window, state, sessions, requests, streams, select, file,
    $: id => window.document.getElementById(id),
    emit: event => streams.at(-1).onmessage({data: JSON.stringify(event)}),
    attach: files => { window.testFiles = files; return runInContext('attachImages(testFiles)', context); },
    paint: () => new Promise(resolve => setTimeout(resolve, 70)),
    submit: () => window.document.getElementById('form').onsubmit({preventDefault() {}}),
    reject: value => { error = value; },
  };
}

test('streamed Markdown is batched, supports multiple text blocks, and final content replaces partial output without duplicates', async t => {
  const c = await chat(t);
  c.emit({type: 'message_start', message: {role: 'assistant', content: []}});
  c.emit({type: 'message_update', assistantMessageEvent: {type: 'text_delta', contentIndex: 0, delta: '## Partial\n\n**Bold'}});
  c.emit({type: 'message_update', assistantMessageEvent: {type: 'text_delta', contentIndex: 0, delta: '**'}});
  c.emit({type: 'message_update', assistantMessageEvent: {type: 'text_delta', contentIndex: 2, delta: '*Second block*'}});
  await c.paint();
  assert.equal(c.$('log').querySelector('h2').textContent, 'Partial');
  assert.equal(c.$('log').querySelector('strong').textContent, 'Bold');
  assert.equal(c.$('log').querySelector('em').textContent, 'Second block');
  c.emit({type: 'message_update', assistantMessageEvent: {type: 'text_end', contentIndex: 0, content: '# Corrected'}});
  c.emit({type: 'message_end', message: {role: 'assistant', content: [{type: 'text', text: '**Authoritative final answer**'}]}});
  await c.paint();
  assert.equal(c.$('log').querySelectorAll('.assistant').length, 1);
  assert.equal(c.$('log').querySelector('strong').textContent, 'Authoritative final answer');
  assert.equal(c.$('log').querySelector('h1,h2,em'), null);
});

test('history and live user/tool messages retain image content and render Markdown safely', async t => {
  const c = await chat(t);
  c.emit({type: 'response', command: 'get_messages', success: true, data: {messages: [
    {role: 'user', content: [{type: 'text', text: '**Inspect**'}, PNG]},
    {role: 'assistant', content: [{type: 'text', text: '| A | B |\n| - | - |\n| 1 | 2 |'}]},
    {role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: [{type: 'text', text: '<script>raw tool output</script>'}, PNG]},
  ]}});
  c.emit({type: 'message_end', message: {role: 'user', content: [PNG]}});
  assert.equal(c.$('log').querySelectorAll('.user img').length, 2);
  assert.equal(c.$('log').querySelector('.user strong').textContent, 'Inspect');
  assert.ok(c.$('log').querySelector('.assistant table'));
  assert.ok(c.$('log').querySelector('.tool img'));
  assert.equal(c.$('log').querySelector('.tool pre').textContent, '<script>raw tool output</script>');
  assert.equal(c.$('log').querySelector('script'), null);
});

test('image-only sends include native image blocks and clear attachments only after successful acceptance', async t => {
  const c = await chat(t);
  assert.equal(c.$('send').disabled, true);
  await c.attach([c.file()]);
  assert.equal(c.$('attachments').querySelectorAll('img').length, 1);
  assert.equal(c.$('send').disabled, false);
  assert.equal(c.$('attachment-status').textContent, '1 image attached.');
  await c.submit();
  assert.deepEqual(c.requests, [{id: 'first', message: '', images: [PNG]}]);
  assert.equal(c.$('attachments').hidden, true);
  assert.equal(c.$('send').disabled, true);
});

test('rejected image sends preserve text and previews, and session switches never move or lose those drafts', async t => {
  const c = await chat(t);
  c.$('box').value = 'Inspect the screenshot';
  await c.attach([c.file()]); c.reject('Please sign in again.');
  const pending = c.submit(); c.select(1); await pending;
  assert.equal(c.$('box').value, ''); assert.equal(c.$('attachments').hidden, true);
  assert.equal(c.$('composer-error').hidden, true);
  c.$('box').value = 'Second draft'; c.select(0);
  assert.equal(c.$('box').value, 'Inspect the screenshot');
  assert.equal(c.$('attachments').querySelectorAll('img').length, 1);
  assert.equal(c.$('composer-error').textContent, 'Please sign in again.');
  c.select(1); assert.equal(c.$('box').value, 'Second draft');
});

test('asynchronous file reads stay with the owning session and overlapping uploads cannot unlock send early', async t => {
  const c = await chat(t), readers = [];
  c.window.FileReader = class { readAsDataURL() { readers.push(this); } };
  const pending = c.attach([c.file()]);
  assert.equal(c.$('send').disabled, true);
  c.$('box').value = 'Pending image';
  await c.attach([c.file('second.png')]);
  assert.equal(c.$('send').disabled, true);
  c.select(1);
  readers[0].result = attachments.imageDataUrl(PNG); readers[0].onload(); await pending;
  assert.equal(c.$('attachments').hidden, true);
  c.select(0);
  assert.equal(c.$('attachments').querySelectorAll('img').length, 1);
  assert.equal(c.$('box').value, 'Pending image');
  assert.equal(c.$('send').disabled, false);
});

test('text-only, unsigned and ended sessions disable image attachment affordances; text-only chat still works', async t => {
  const c = await chat(t);
  c.select(2);
  assert.equal(c.$('attach').disabled, true); assert.equal(c.$('image-files').disabled, true);
  assert.match(c.$('attachment-hint').textContent, /text only/);
  await c.attach([c.file()]); assert.match(c.$('composer-error').textContent, /does not support images/);
  c.$('box').value = 'Text is fine'; await c.submit();
  assert.deepEqual(c.requests, [{id: 'text', message: 'Text is fine'}]);
  c.select(3); assert.equal(c.$('attach').disabled, true); assert.equal(c.$('box').disabled, true);
  c.sessions[0].status = 'done'; c.select(0); assert.equal(c.$('attach').disabled, true); assert.equal(c.$('box').disabled, true);
});

test('invalid formats, forged PNGs, oversize files and too many files report actionable errors without discarding existing attachments', async t => {
  const c = await chat(t);
  await c.attach([c.file()]);
  await c.attach([c.file('x.svg', 'image/svg+xml', Buffer.from('<svg/>'))]);
  assert.match(c.$('composer-error').textContent, /PNG, JPEG, WebP or GIF/);
  await c.attach([c.file('bad.png', 'image/png', Buffer.from('not an image'))]);
  assert.match(c.$('composer-error').textContent, /contents do not match/);
  await c.attach([c.file('big.png', 'image/png', Buffer.alloc(attachments.MAX_IMAGE_BYTES + 1))]);
  assert.match(c.$('composer-error').textContent, /5 MB/);
  await c.attach(Array(4).fill(c.file())); assert.match(c.$('composer-error').textContent, /up to 4/);
  assert.equal(c.$('attachments').querySelectorAll('img').length, 1);
  c.$('attachments').querySelector('.ghost').click();
  assert.equal(c.$('attachments').hidden, true); assert.equal(c.$('composer-error').hidden, true);
});

test('paste and drag-and-drop use the same validated attachment flow without navigating the page', async t => {
  const c = await chat(t), readers = [];
  c.window.FileReader = class { readAsDataURL() { readers.push(this); } };
  let prevented = 0;
  c.$('box').onpaste({preventDefault() { prevented++; }, clipboardData: {items: [{kind: 'file', getAsFile: () => c.file('pasted.png')}]}});
  readers[0].result = attachments.imageDataUrl(PNG); readers[0].onload(); await new Promise(resolve => setImmediate(resolve));
  const transfer = {types: ['Files'], files: [c.file('dropped.png')]};
  c.$('chat').ondragenter({preventDefault() {}, dataTransfer: transfer});
  assert.equal(c.$('form').classList.contains('dropping'), true);
  c.$('chat').ondrop({preventDefault() { prevented++; }, dataTransfer: transfer});
  readers[1].result = attachments.imageDataUrl(PNG); readers[1].onload(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, 2); assert.equal(c.$('form').classList.contains('dropping'), false);
  assert.deepEqual([...c.$('attachments').querySelectorAll('img')].map(img => img.alt), ['pasted.png', 'dropped.png']);
});
