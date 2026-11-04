// A browser that opens a session gets its /api/events replay; live watchers get every line as it happens. The replay
// leaves out lines app.js never renders, so it must build exactly the chat a live watcher sees.
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {PassThrough} from 'node:stream';
import {StringDecoder} from 'node:string_decoder';
import {runInContext} from 'node:vm';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {renderMarkdown, renderMessage, renderThought} from '../dashboard/chat-content.mjs';
import * as attachments from '../dashboard/attachments.mjs';
import {startDashboard} from './fixtures/dashboard-server.mjs';

const serverPath = fileURLToPath(new URL('../dashboard/server.mjs', import.meta.url));
const [html, script, server] = await Promise.all([
  readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../dashboard/app.js', import.meta.url), 'utf8'),
  readFile(serverPath, 'utf8'),
]);
// Importing server.mjs would start a dashboard, so the functions under test are taken from its source.
const source = name => new RegExp(`^function ${name}\\([\\s\\S]*?^}$`, 'm').exec(server)[0], constant = name => new RegExp(`^const ${name} = .*;$`, 'm').exec(server)[0];
const replayLine = new Function(`return ${source('replayLine')}`)(), eachLine = new Function(`return ${source('eachLine')}`)();
const enhanceInput = new Function(`${['textOf', 'clip', 'defuse'].map(constant).join('\n')}\nreturn ${source('enhanceInput')}`)();
// record()'s retention without the 20k cap.
const compact = lines => {
  const session = {log: [], deltaTail: 0};
  for (const line of lines) { const kept = replayLine(session, JSON.parse(line), line); if (kept !== null) session.log.push(kept); }
  return session.log;
};

// eachLine as of d0c6d2b, the reference for the single-scan version.
function eachLineBefore(stream, onLine) {
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffered += chunk;
    for (let end; (end = buffered.indexOf('\n')) >= 0;) {
      const line = buffered.slice(0, end).replace(/\r$/, '');
      buffered = buffered.slice(end + 1);
      if (line) onLine(line);
    }
  });
}

function rng(seed) {
  return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// The chat app.js builds from a sequence of SSE data lines: #log, the queue panel and the side-panel state.
async function render(lines) {
  const dom = new JSDOM(html, {url: 'http://127.0.0.1:4777', runScripts: 'outside-only'}), {window} = dom, streams = [];
  const session = {id: 'live', title: 'Session', cwd: 'C:\\project', model: 'sol', thinking: 'xhigh', status: 'running', pending: [], settled: 0};
  const state = {workspaces: [{path: 'C:\\project', live: [session], saved: [], archived: []}], models: [], groups: [], auth: {}};
  window.fetch = async () => ({ok: true, json: async () => state});
  window.EventSource = class { constructor(url) { this.url = url; streams.push(this); } close() {} };
  Object.assign(window, attachments, {renderMarkdown, renderMessage, renderThought});
  window.setInterval = () => 0;
  window.setTimeout = (callback, delay) => { if (delay === 50) callback(); return 0; }; // paint streamed Markdown at once
  const context = dom.getInternalVMContext();
  runInContext(script.replace(/^import .* from .*;\r?\n/gm, ''), context);
  await new Promise(resolve => setImmediate(resolve));
  runInContext(`select(${JSON.stringify(session)})`, context);
  for (const data of lines) streams.at(-1).onmessage({data});
  await new Promise(resolve => setImmediate(resolve));
  const $ = id => window.document.getElementById(id);
  const chat = {log: $('log').innerHTML, queued: $('queued').innerHTML,
    view: runInContext('JSON.stringify({...view, todos: [...view.todos], files: [...view.files], statuses: [...view.statuses], widgets: [...view.widgets]})', context)};
  window.close();
  return chat;
}

// Seeded Pi RPC output shaped like real runs: thinking/text/tool-call deltas with notes, queue snapshots, statuses,
// responses and auto-approvals landing between them, tool progress snapshots, errors, a run still streaming.
function randomRun(seed) {
  const rnd = rng(seed), int = (a, b) => a + Math.floor(rnd() * (b - a + 1)), chance = p => rnd() < p, pick = list => list[int(0, list.length - 1)];
  const lines = [], emit = event => lines.push(JSON.stringify(event));
  const WORDS = ['alpha ', '**bold** ', '`code` ', 'ü ', '\n', '- item\n', '漢字', '\u2028', 'end. ', '# Head\n', '| a | b |\n'];
  const prose = n => Array.from({length: n}, () => pick(WORDS)).join('');
  const TOOLS = [['read', () => ({path: pick(['a.js', 'C:\\p\\b.mjs'])})], ['bash', () => ({command: pick(['ls', 'npm test\nsecond'])})], ['grep', () => ({pattern: 'x'})],
    ['edit', () => ({path: 'c.mjs'})], ['write', () => ({path: 'd.txt', content: 'one\ntwo'})], ['ls', () => ({})], ['todo', () => ({action: 'list'})], ['custom_tool', () => ({})]];
  const aside = () => pick([
    () => emit({type: 'extension_ui_request', id: 'n' + lines.length, method: 'notify', message: 'note ' + lines.length}),
    () => emit({type: 'queue_update', steering: chance(0.5) ? ['steer ' + lines.length] : [], followUp: chance(0.3) ? ['later'] : []}),
    () => emit({type: 'extension_ui_request', id: 's' + lines.length, method: 'setStatus', statusKey: 'k', ...(chance(0.7) ? {statusText: 'status ' + lines.length} : {})}),
    () => emit({type: 'extension_ui_request', id: 'w' + lines.length, method: 'setWidget', widgetKey: 'w', widgetLines: chance(0.7) ? ['widget'] : []}),
    () => emit({type: 'response', id: 'stats', command: 'get_session_stats', success: true, data: {cost: lines.length / 100}}),
    () => emit({type: 'dashboard_auto_approved', message: 'Tool: bash\nArguments: {"command":"ls"}'}),
    () => emit({type: 'response', id: 'x' + lines.length, command: 'set_model', success: false, error: 'refused ' + lines.length}),
  ])();
  const maybeAside = p => { if (chance(p)) aside(); };
  emit({type: 'response', id: 'state', command: 'get_state', success: true, data: {thinkingLevel: 'high'}});
  emit({type: 'response', id: 'commands', command: 'get_commands', success: true, data: {commands: [{name: 'cost' + seed}, {name: 'compact'}]}});
  emit({type: 'response', id: 'levels', command: 'get_available_thinking_levels', success: true, data: {levels: ['low', 'high']}});
  if (chance(0.4)) emit({type: 'response', id: 'history', command: 'get_messages', success: true, data: {messages: [
    {role: 'user', content: 'earlier ask'}, {role: 'assistant', content: [{type: 'thinking', thinking: 'old thought'}, {type: 'toolCall', id: 'h1', name: 'read', arguments: {path: 'h.js'}}]},
    {role: 'toolResult', toolCallId: 'h1', toolName: 'read', content: [{type: 'text', text: 'h'}], isError: false}, {role: 'assistant', content: [{type: 'text', text: 'Earlier reply.'}]}]}});
  emit({type: 'response', id: 'stats', command: 'get_session_stats', success: true, data: {cost: 0}});
  let calls = 0;
  const assistant = ({streaming = false} = {}) => {
    emit({type: 'message_start', message: {role: 'assistant', content: []}});
    const content = [], called = [];
    for (const [index, kind] of Array.from({length: int(1, 4)}, () => pick(['thinking', 'text', 'thinking', 'toolCall'])).entries()) {
      if (kind === 'toolCall') {
        const [name, input] = pick(TOOLS), id = 'c' + calls++, args = input();
        emit({type: 'message_update', assistantMessageEvent: {type: 'toolcall_start', contentIndex: index, id, toolName: name}});
        for (let i = int(0, 3); i > 0; i--) { emit({type: 'message_update', assistantMessageEvent: {type: 'toolcall_delta', contentIndex: index, delta: '{"x":'}}); maybeAside(0.05); }
        emit({type: 'message_update', assistantMessageEvent: {type: 'toolcall_end', contentIndex: index, toolCall: {type: 'toolCall', id, name, arguments: args}}});
        content.push({type: 'toolCall', id, name, arguments: args}); called.push([id, name, args]);
        continue;
      }
      const full = chance(0.1) ? '' : prose(int(1, 10));
      emit({type: 'message_update', assistantMessageEvent: {type: kind + '_start', contentIndex: index}});
      for (let at = 0; at < full.length;) {
        const size = int(1, 6);
        emit({type: 'message_update', assistantMessageEvent: {type: kind + '_delta', contentIndex: index, delta: full.slice(at, at += size)}});
        maybeAside(0.06);
        if (streaming && chance(0.15)) return; // still streaming when the browser connects
      }
      emit({type: 'message_update', assistantMessageEvent: {type: kind + '_end', contentIndex: index, content: full}});
      // Completed content is authoritative and may extend what streamed; like pi-ai it never empties a streamed block.
      content.push({type: kind, [kind]: full && chance(0.15) ? full + ' (final)' : full});
    }
    if (streaming) return;
    const error = chance(0.06);
    emit({type: 'message_end', message: {role: 'assistant', content, stopReason: error ? 'error' : called.length ? 'toolUse' : 'stop', ...(error ? {errorMessage: 'Provider failed ' + lines.length} : {})}});
    for (const [id, name, args] of error ? [] : called) {
      emit({type: 'tool_execution_start', toolCallId: id, toolName: name, args});
      let output = '';
      for (let i = int(0, 6); i > 0; i--) { output += `line ${i}\n`; emit({type: 'tool_execution_update', toolCallId: id, toolName: name, args, partialResult: {content: [{type: 'text', text: output}]}}); }
      maybeAside(0.1);
      const result = {content: [{type: 'text', text: name === 'todo' ? JSON.stringify([{id: 't' + id, text: 'task', status: 'pending'}]) : 'ok ' + id}],
        ...(name === 'edit' ? {details: {diff: ' 1 keep\n-2 old\n+2 new'}} : {})};
      const isError = chance(0.1);
      emit({type: 'tool_execution_end', toolCallId: id, toolName: name, result, isError});
      emit({type: 'message_start', message: {role: 'toolResult', toolCallId: id, toolName: name, ...result, isError}});
      emit({type: 'message_end', message: {role: 'toolResult', toolCallId: id, toolName: name, ...result, isError}});
    }
    emit({type: 'turn_end', message: {role: 'assistant', content}, toolResults: []});
    maybeAside(0.3);
    return {role: 'assistant', content};
  };
  for (let run = int(1, 4); run > 0; run--) {
    const ask = 'ask ' + run + ' ' + prose(2);
    emit({type: 'message_start', message: {role: 'user', content: ask}});
    emit({type: 'message_end', message: {role: 'user', content: ask}});
    emit({type: 'agent_start'});
    const messages = Array.from({length: int(1, 4)}, () => assistant());
    emit({type: 'agent_end', messages, willRetry: false});
    emit({type: 'agent_settled'});
    emit({type: 'response', id: 'state', command: 'get_state', success: true, data: {thinkingLevel: 'high'}});
    maybeAside(0.3);
  }
  if (chance(0.3)) { emit({type: 'agent_start'}); assistant({streaming: true}); }
  else if (chance(0.2)) emit({type: 'dashboard_exit', code: chance(0.5) ? 0 : 1, stderr: 'stopped'});
  return lines;
}

test('compacted replays of seeded runs build the same chat as the live stream, whenever the browser connects', async () => {
  let before = 0, after = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const lines = randomRun(seed), replay = compact(lines), rnd = rng(seed * 31);
    before += lines.length; after += replay.length;
    const live = await render(lines);
    assert.deepEqual(await render(replay), live, `seed ${seed}: replay after the run`);
    assert.equal(enhanceInput('Draft', {log: replay}, 1), enhanceInput('Draft', {log: lines}, 1), `seed ${seed}: the enhancer reads the same conversation`);
    // Connecting mid-run: the replay so far, then the rest live.
    for (let i = 0; i < 6; i++) {
      const at = 1 + Math.floor(rnd() * lines.length);
      assert.deepEqual(await render([...compact(lines.slice(0, at)), ...lines.slice(at)]), live, `seed ${seed}: reconnect after line ${at}`);
    }
    // Between runs the replay alone already shows what a live watcher sees. (Right after an assistant message_end, a
    // thought group built from message_end alone has its summary filled by the next tool start or settle instead.)
    for (const [at, line] of lines.entries()) {
      if (line !== '{"type":"agent_settled"}') continue;
      const prefix = lines.slice(0, at + 1);
      assert.deepEqual(await render(compact(prefix)), await render(prefix), `seed ${seed}: replay after line ${at}`);
    }
  }
  assert.ok(after < before * 0.7, `the replay keeps ${after} of ${before} lines`);
});

function eachLineOver(impl, chunks) {
  const lines = [];
  let onData;
  impl({setEncoding() {}, on(event, listener) { onData = listener; }}, line => lines.push(line));
  for (const chunk of chunks) onData(chunk);
  return lines;
}
// Decoded the way setEncoding('utf8') hands a child's stdout to eachLine.
const decodedChunks = (bytes, sizes) => {
  const decoder = new StringDecoder('utf8'), chunks = [];
  for (let at = 0, i = 0; at < bytes.length; i++) chunks.push(decoder.write(bytes.subarray(at, at += sizes[i % sizes.length])));
  return chunks.concat(decoder.end() || []);
};

test('eachLine splits lines exactly as before for any chunking', async () => {
  const rnd = rng(2028), PIECES = ['a', '{"x":1}', 'ü', '€', '𝄞', '\u2028', '\r', '\n', '\r\n', '\n\n', ' '];
  for (let round = 0; round < 400; round++) {
    const text = Array.from({length: 1 + Math.floor(rnd() * 60)}, () => PIECES[Math.floor(rnd() * PIECES.length)]).join('');
    const bytes = Buffer.from(text), sizes = Array.from({length: 4}, () => 1 + Math.floor(rnd() * (rnd() < 0.2 ? 64 : 5)));
    const chunks = decodedChunks(bytes, sizes);
    assert.deepEqual(eachLineOver(eachLine, chunks), eachLineOver(eachLineBefore, chunks), JSON.stringify({text, sizes}));
  }
  // The awkward cases by name: a line split mid-way and mid-character, a CR ending one chunk with its LF starting the
  // next, U+2028 inside a JSON string, an empty line, a 2 MB line over many chunks, and an unfinished last line.
  const big = JSON.stringify({type: 'agent_end', text: 'ü'.repeat(1024 * 1024)});
  const named = [['{"a":"gr', Buffer.from('ü').subarray(0, 1)], [Buffer.from('ü').subarray(1), 'ße"}\r'], ['\n\n{"b":"\u2028"}\r\n', ...big.match(/[^]{1,65536}/g)],
    ['\n{"c":', '"unfinished"}']].flat();
  const decoder = new StringDecoder('utf8'), chunks = named.map(piece => typeof piece === 'string' ? piece : decoder.write(piece));
  const expected = ['{"a":"grüße"}', '{"b":"\u2028"}', big];
  assert.deepEqual(eachLineOver(eachLine, chunks), expected);
  assert.deepEqual(eachLineOver(eachLineBefore, chunks), expected);
  // Through a real stream with setEncoding, as the server reads a child's stdout.
  const bytes = Buffer.from(`${expected[0]}\n\n${expected[1]}\r\n${big}\n`), stream = new PassThrough(), lines = [];
  eachLine(stream, line => lines.push(line));
  for (let at = 0; at < bytes.length; at += 7919) stream.write(bytes.subarray(at, at + 7919));
  stream.end();
  await new Promise(resolve => stream.on('end', resolve));
  assert.deepEqual(lines, expected);
});

const preload = ['--preload', fileURLToPath(new URL('../scripts/live-builtins.mjs', import.meta.url)), '--preload', fileURLToPath(new URL('./fixtures/dashboard-rpc.mjs', import.meta.url))];
function call(port, {method = 'GET', path = '/', headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, method, path, headers: {host: `127.0.0.1:${port}`, ...headers}}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers}));
    });
    req.on('error', reject);
    req.end(body);
  });
}
// Collects a session's SSE data lines until closed.
function listen(port, cookie, id) {
  const lines = [];
  let pending = '';
  const req = http.get({host: '127.0.0.1', port, path: `/api/events?id=${id}`, headers: {host: `127.0.0.1:${port}`, cookie}}, res => {
    res.setEncoding('utf8');
    res.on('data', chunk => {
      const events = (pending + chunk).split('\n\n');
      pending = events.pop();
      for (const event of events) lines.push(event.slice('data: '.length));
    });
    res.on('error', () => {});
  });
  req.on('error', () => {});
  return {lines, close: () => req.destroy()};
}
async function until(check, what) {
  for (const started = Date.now(); !check();) {
    if (Date.now() - started > 20000) throw new Error('Timed out waiting for ' + what);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('the server replays a finished run without progress snapshots or superseded deltas, and every line reaches live watchers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'apex-dash-replay-'));
  const {child, port, token} = await startDashboard({args: [...preload, serverPath], env: {...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent')}});
  const watchers = [];
  try {
    const cookie = (await call(port, {path: `/?t=${token}`})).headers['set-cookie'][0].split(';')[0];
    const post = (path, body) => call(port, {method: 'POST', path, headers: {cookie, origin: `http://127.0.0.1:${port}`}, body: JSON.stringify(body)});
    const cwd = JSON.parse((await post('/api/workspaces', {path: home})).text).path;
    const {id} = JSON.parse((await post('/api/start', {cwd, model: 'sol'})).text);
    const watch = () => { const watcher = listen(port, cookie, id); watchers.push(watcher); return watcher; };
    const live = watch();
    const states = lines => lines.filter(line => line.startsWith('{"type":"response","id":"state"')).length;
    await until(() => states(live.lines) === 1, 'the startup responses');

    assert.equal((await post('/api/send', {id, message: 'stream turn'})).status, 200);
    await until(() => states(live.lines) === 2, 'the run to settle'); // agent_settled asks for stats, then state
    const types = lines => lines.map(line => JSON.parse(line)).map(event => event.message?.role === 'toolResult' ? event.type + ':toolResult' : event.type);
    const count = (lines, type) => types(lines).filter(t => t === type).length;
    assert.equal(count(live.lines, 'tool_execution_update'), 20);
    assert.deepEqual([count(live.lines, 'turn_end'), count(live.lines, 'message_start:toolResult'), count(live.lines, 'message_end:toolResult')], [2, 1, 1]);
    assert.equal(JSON.parse(live.lines.find(line => line.startsWith('{"type":"agent_end"'))).messages.length, 4, 'live agent_end is sent as Pi wrote it');

    const replay = watch();
    await until(() => states(replay.lines) === 2, 'the replay');
    for (const type of ['tool_execution_update', 'turn_end', 'message_start:toolResult', 'message_end:toolResult']) assert.equal(count(replay.lines, type), 0, type);
    assert.ok(replay.lines.includes('{"type":"agent_end","willRetry":false}'));
    // The deltas before the mid-text note stay in place around it; the ones after it, and the whole streamed reply,
    // give way to their message_end.
    const note = lines => lines.findIndex(line => line.includes('"id":"note-1"'));
    assert.deepEqual(replay.lines.slice(0, note(replay.lines)), live.lines.slice(0, note(live.lines)));
    assert.equal(count(replay.lines.slice(note(replay.lines)), 'message_update'), 0);
    assert.equal(count(replay.lines, 'message_end'), 3, 'the user message and both replies');
    let at = 0;
    for (const line of replay.lines) {
      const expected = line === '{"type":"agent_end","willRetry":false}' ? live.lines.findIndex((other, i) => i >= at && other.startsWith('{"type":"agent_end"')) : live.lines.indexOf(line, at);
      assert.ok(expected >= at, `replay line out of order: ${line.slice(0, 120)}`);
      at = expected + 1;
    }

    // Awkward stdout chunking reaches the browser intact.
    assert.equal((await post('/api/send', {id, message: 'split lines'})).status, 200);
    await until(() => states(live.lines) === 3, 'the split-lines run');
    const notes = lines => lines.filter(line => line.includes('"id":"split"')).map(line => JSON.parse(line).message);
    assert.deepEqual(notes(live.lines), ['grüße ü€𝄞', 'line\u2028separator', 'x'.repeat(2 * 1024 * 1024) + 'ü']);
    assert.ok(live.lines.every(line => !line.endsWith('\r')));

    // A command's 20,001 progress snapshots no longer push the slash commands and model state out of the replay.
    assert.equal((await post('/api/send', {id, message: 'noisy bash'})).status, 200);
    await until(() => states(live.lines) === 4, 'the noisy run');
    assert.equal(count(live.lines, 'tool_execution_update'), 20 + 20001);
    const late = watch();
    await until(() => states(late.lines) === 4, 'the final replay');
    assert.ok(late.lines.some(line => line.startsWith('{"type":"response","id":"commands"')), 'get_commands survives in the replay');
    assert.equal(count(late.lines, 'tool_execution_update'), 0);
    assert.deepEqual(notes(late.lines), notes(live.lines));
    assert.deepEqual(await render(late.lines), await render(live.lines), 'the replay builds the chat the live watcher saw');
  } finally {
    for (const watcher of watchers) watcher.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    await rm(home, {recursive: true, force: true});
  }
});
