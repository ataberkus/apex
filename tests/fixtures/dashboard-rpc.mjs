// Offline dashboard fixture: no real agent child or provider request can start. Preloaded after scripts/live-builtins.mjs,
// which makes the server's named `spawn` import call the replacement below.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {appendFileSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {ApiKeyLogin, OAuthLogin} from '../../dashboard/provider-login.mjs';
import {resolvePi} from '../../lib/launcher.mjs';

// With APEX_FIXTURE_AUTH set, logins are the providers saved in the test's auth.json; otherwise every login counts as saved.
const authFile = join(process.env.PI_CODING_AGENT_DIR ?? '', 'auth.json');
const savedLogins = () => process.env.APEX_FIXTURE_AUTH ? Object.keys(JSON.parse(readFileSync(authFile, 'utf8'))) : undefined;
OAuthLogin.prototype.status = ApiKeyLogin.prototype.status = async function () { return {phase: 'idle', signedIn: savedLogins()?.includes(this.id) ?? true}; };
// Like Pi, the agent fixes the models set_model accepts when it starts, from the logins saved then.
const catalog = await ModelRuntime.create({authPath: authFile, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false});
const cli = resolvePi().cli; // the dashboard starts Pi itself with the invocation bin/apex would build
childProcess.spawn = (_command, args) => {
  if (args.includes('--no-session')) return enhanceChild(args); // the ✨ enhance print run
  assert.equal(args[0], cli, 'Only the fixture agent may be started');
  if (process.env.APEX_FIXTURE_ARGV) appendFileSync(process.env.APEX_FIXTURE_ARGV, JSON.stringify(args.slice(1)) + '\n');
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let cost = 0, thinking = args.includes('--thinking') ? args[args.indexOf('--thinking') + 1] : 'xhigh', signal;
  const saved = savedLogins(), launched = {provider: args[args.indexOf('--provider') + 1], id: args[args.indexOf('--model') + 1], input: ['text']};
  const available = [...catalog.getModels().filter(model => saved?.includes(model.provider) ?? true),
    ...(launched.provider === 'apex' ? [launched] : [])]; // the apex-router extension registers the virtual pair or auto model it loaded
  const emit = event => child.stdout.write(JSON.stringify(event) + '\n');
  // Like Pi with apex-features loaded: /autocompact is registered only with the feature, and a prompt naming a
  // registered command runs it on arrival, answering "handled" without starting a run.
  const features = args.includes('--apex-feature-flags') ? args[args.indexOf('--apex-feature-flags') + 1].split(',') : [];
  const commands = features.includes('autocompact') ? [{name: 'autocompact', description: 'Show or set the autocompact threshold in context tokens', source: 'extension'}] : [];
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      try {
        for (const line of String(chunk).trim().split('\n')) {
          const command = JSON.parse(line);
          const named = command.type === 'prompt' && /^\/(\S+)/.exec(command.message ?? '')?.[1];
          if (named && commands.some(registered => registered.name === named)) {
            emit({type: 'extension_ui_request', id: `notify-${command.id}`, method: 'notify', message: `ran ${command.message}`});
            emit({type: 'response', id: command.id, command: 'prompt', success: true, data: {disposition: 'handled'}});
          } else if (command.type === 'prompt') {
            emit({type: 'response', id: command.id, command: 'prompt', success: true, data: {disposition: 'started'}});
            cost += 0.25;
            emit({type: 'agent_start'});
            if (command.message === 'needs approval') for (const title of ['Confirm tool action', 'Confirm catastrophic command'])
              emit({type: 'extension_ui_request', id: `${title}#${cost}`, method: 'confirm', title, message: 'Tool: bash\nArguments: {}'});
            if (command.message === 'stream turn') streamTurn(emit, command.message);
            if (command.message === 'split lines') splitLines(child.stdout);
            if (command.message === 'noisy bash') { // a long command's progress snapshots outnumber the replay cap
              const input = {command: 'npm run build'};
              emit({type: 'tool_execution_start', toolCallId: 'noisy', toolName: 'bash', args: input});
              for (let i = 0; i <= 20000; i++) emit({type: 'tool_execution_update', toolCallId: 'noisy', toolName: 'bash', args: input, partialResult: {content: [{type: 'text', text: `step ${i}`}]}});
              emit({type: 'tool_execution_end', toolCallId: 'noisy', toolName: 'bash', result: {content: [{type: 'text', text: 'built'}]}, isError: false});
            }
            if (command.message?.startsWith('exit on ')) signal = command.message.slice('exit on '.length); // Pi then dies from this signal
            emit({type: 'agent_settled'});
          } else if (command.type === 'extension_ui_response') {
            emit({type: 'extension_ui_request', id: 'answer-' + command.id, method: 'notify', message: `answered ${command.id} ${command.confirmed}`});
          } else if (command.type === 'set_thinking_level') {
            thinking = command.level === 'max' ? 'xhigh' : command.level; // like Pi, clamp to what the model supports
            emit({type: 'response', id: command.id, command: command.type, success: true});
          } else if (command.type === 'set_model' && !available.some(model => model.provider === command.provider && model.id === command.modelId)) {
            emit({type: 'response', id: command.id, command: command.type, success: false, error: `Model not found: ${command.provider}/${command.modelId}`});
          } else {
            const data = command.type === 'get_state' ? {thinkingLevel: thinking} : command.type === 'get_available_thinking_levels' ? {levels: ['low', 'medium', 'high', 'xhigh']}
              : command.type === 'set_model' ? {provider: command.provider, id: command.modelId, input: ['text']} : command.type === 'get_available_models' ? {models: available}
              : command.type === 'get_session_stats' ? {cost} : command.type === 'get_messages' ? {messages: savedMessages(args)} : command.type === 'get_commands' ? {commands} : {};
            emit({type: 'response', id: command.id, command: command.type, success: true, data});
          }
        }
        done();
      } catch (error) { done(error); }
    },
  });
  child.stdin.on('finish', () => signal ? child.emit('close', null, signal) : child.emit('close', 0));
  child.kill = () => { child.stdin.end(); return true; };
  return child;
};
// One run as Pi's RPC mode streams it: deltas with a note arriving mid-text, a bash call with its 100 ms progress
// snapshots, the toolResult message, turn_end, then a plain reply and agent_end carrying every message of the run.
function streamTurn(emit, prompt) {
  const update = assistantMessageEvent => emit({type: 'message_update', assistantMessageEvent});
  const user = {role: 'user', content: [{type: 'text', text: prompt}]}, thinking = 'Check **the tests** first.', text = 'Running the suite now.\n\n- one\n- two';
  const call = {type: 'toolCall', id: 'bash-1', name: 'bash', arguments: {command: 'npm test'}};
  const first = {role: 'assistant', content: [{type: 'thinking', thinking}, {type: 'text', text}, call], stopReason: 'toolUse'};
  emit({type: 'message_start', message: user}); emit({type: 'message_end', message: user});
  emit({type: 'message_start', message: {role: 'assistant', content: []}});
  update({type: 'thinking_start', contentIndex: 0});
  for (const delta of thinking.match(/.{1,3}/gs)) update({type: 'thinking_delta', contentIndex: 0, delta});
  update({type: 'thinking_end', contentIndex: 0, content: thinking});
  update({type: 'text_start', contentIndex: 1});
  text.match(/.{1,2}/gs).forEach((delta, i) => {
    if (i === 6) emit({type: 'extension_ui_request', id: 'note-1', method: 'notify', message: 'Checkpoint saved'});
    update({type: 'text_delta', contentIndex: 1, delta});
  });
  update({type: 'text_end', contentIndex: 1, content: text});
  update({type: 'toolcall_start', contentIndex: 2, id: call.id, toolName: call.name});
  update({type: 'toolcall_delta', contentIndex: 2, delta: JSON.stringify(call.arguments)});
  update({type: 'toolcall_end', contentIndex: 2, toolCall: call});
  emit({type: 'message_end', message: first});
  emit({type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments});
  let output = '';
  for (let i = 1; i <= 20; i++) {
    output += `test ${i} ok\n`;
    emit({type: 'tool_execution_update', toolCallId: call.id, toolName: call.name, args: call.arguments, partialResult: {content: [{type: 'text', text: output}]}});
  }
  const result = {role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{type: 'text', text: output}], isError: false};
  emit({type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, result: {content: result.content}, isError: false});
  emit({type: 'message_start', message: result}); emit({type: 'message_end', message: result});
  emit({type: 'turn_end', message: first, toolResults: [result]});
  const reply = 'All **20** tests pass.', second = {role: 'assistant', content: [{type: 'text', text: reply}], stopReason: 'stop'};
  emit({type: 'message_start', message: {role: 'assistant', content: []}});
  update({type: 'text_start', contentIndex: 0});
  for (const delta of reply.match(/.{1,4}/gs)) update({type: 'text_delta', contentIndex: 0, delta});
  update({type: 'text_end', contentIndex: 0, content: reply});
  emit({type: 'message_end', message: second});
  emit({type: 'turn_end', message: second, toolResults: []});
  emit({type: 'agent_end', messages: [user, first, result, second], willRetry: false});
}
// Notes written in awkward pieces: a character split across writes, a CRLF split between two writes, U+2028 inside a
// JSON string, blank lines, and a 2 MB line written 64 KB at a time.
const SPLIT_NOTES = ['grüße ü€𝄞', 'line\u2028separator', 'x'.repeat(2 * 1024 * 1024) + 'ü'];
function splitLines(stdout) {
  const [first, second, big] = SPLIT_NOTES.map(message => JSON.stringify({type: 'extension_ui_request', id: 'split', method: 'notify', message}));
  const bytes = Buffer.from(`${first}\n\n${second}\r\n\r\n${big}\n`), cuts = new Set([0, bytes.length]);
  for (const [text, offset] of [['ü', 1], ['𝄞', 2], ['\r\n', 1]]) cuts.add(bytes.indexOf(text) + offset);
  for (let at = bytes.indexOf(big); at < bytes.length; at += 65536) cuts.add(at);
  cuts.add(bytes.lastIndexOf('ü') + 1);
  const sorted = [...cuts].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) stdout.write(bytes.subarray(sorted[i - 1], sorted[i]));
}
// Like Pi, a resumed session's get_messages returns the messages saved in its --session file.
const savedMessages = args => !args.includes('--session') ? []
  : readFileSync(args[args.indexOf('--session') + 1], 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.type === 'message').map(entry => entry.message);
// An echo model for enhance runs: its rewrite is the draft itself, and a draft that mentions the output limit stops
// there, as a cut-off answer does. APEX_FIXTURE_ENHANCE collects each run's stdin and thinking level.
function enhanceChild(args) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let input = '';
  child.stdin = new Writable({
    write(chunk, _encoding, done) { input += chunk; done(); },
    final(done) {
      if (process.env.APEX_FIXTURE_ENHANCE) appendFileSync(process.env.APEX_FIXTURE_ENHANCE, JSON.stringify({input, thinking: args[args.indexOf('--thinking') + 1]}) + '\n');
      const draft = /<draft>\n([\s\S]*)\n<\/draft>/.exec(input)[1];
      const message = {role: 'assistant', content: [{type: 'text', text: draft}], stopReason: draft.includes('output limit') ? 'length' : 'stop'};
      child.stdout.once('end', () => child.emit('close', 0));
      child.stdout.end(JSON.stringify({type: 'message_end', message}) + '\n');
      done();
    },
  });
  child.kill = () => true;
  return child;
}
