// Offline dashboard fixture: no real agent child or provider request can start.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {appendFileSync, readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {syncBuiltinESMExports} from 'node:module';
import {PassThrough, Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {ApiKeyLogin, OAuthLogin} from '../../dashboard/provider-login.mjs';

OAuthLogin.prototype.status = ApiKeyLogin.prototype.status = async () => ({phase: 'idle', signedIn: true});
const apex = fileURLToPath(new URL('../../bin/apex', import.meta.url));
childProcess.spawn = (_command, args) => {
  if (args.includes('--no-session')) return enhanceChild(); // the ✨ enhance print run
  assert.equal(args[0], apex, 'Only the fixture agent may be started');
  if (process.env.APEX_FIXTURE_ARGV) appendFileSync(process.env.APEX_FIXTURE_ARGV, JSON.stringify(args.slice(1)) + '\n');
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let cost = 0, thinking = args.includes('--thinking') ? args[args.indexOf('--thinking') + 1] : 'xhigh';
  const emit = event => child.stdout.write(JSON.stringify(event) + '\n');
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      try {
        for (const line of String(chunk).trim().split('\n')) {
          const command = JSON.parse(line);
          if (command.type === 'prompt') {
            emit({type: 'response', id: command.id, command: 'prompt', success: true, data: {disposition: 'started'}});
            cost += 0.25;
            emit({type: 'agent_start'});
            if (command.message === 'needs approval') for (const title of ['Confirm tool action', 'Confirm catastrophic command'])
              emit({type: 'extension_ui_request', id: `${title}#${cost}`, method: 'confirm', title, message: 'Tool: bash\nArguments: {}'});
            emit({type: 'agent_settled'});
          } else if (command.type === 'extension_ui_response') {
            emit({type: 'extension_ui_request', id: 'answer-' + command.id, method: 'notify', message: `answered ${command.id} ${command.confirmed}`});
          } else if (command.type === 'set_thinking_level') {
            thinking = command.level === 'max' ? 'xhigh' : command.level; // like Pi, clamp to what the model supports
            emit({type: 'response', id: command.id, command: command.type, success: true});
          } else {
            const data = command.type === 'get_state' ? {thinkingLevel: thinking} : command.type === 'get_available_thinking_levels' ? {levels: ['low', 'medium', 'high', 'xhigh']}
              : command.type === 'set_model' ? {provider: command.provider, id: command.modelId, input: ['text']} : command.type === 'get_session_stats' ? {cost} : command.type === 'get_messages' ? {messages: savedMessages(args)} : command.type === 'get_commands' ? {commands: []} : {};
            emit({type: 'response', id: command.id, command: command.type, success: true, data});
          }
        }
        done();
      } catch (error) { done(error); }
    },
  });
  child.stdin.on('finish', () => child.emit('close', 0));
  child.kill = () => { child.stdin.end(); return true; };
  return child;
};
// Like Pi, a resumed session's get_messages returns the messages saved in its --session file.
const savedMessages = args => !args.includes('--session') ? []
  : readFileSync(args[args.indexOf('--session') + 1], 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.type === 'message').map(entry => entry.message);
// An echo model for enhance runs: its rewrite is the draft itself, and a draft that mentions the output limit stops
// there, as a cut-off answer does. APEX_FIXTURE_ENHANCE collects each run's stdin.
function enhanceChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let input = '';
  child.stdin = new Writable({
    write(chunk, _encoding, done) { input += chunk; done(); },
    final(done) {
      if (process.env.APEX_FIXTURE_ENHANCE) appendFileSync(process.env.APEX_FIXTURE_ENHANCE, JSON.stringify(input) + '\n');
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
syncBuiltinESMExports();
