// Offline image/RPC transport fixture. Intercept every child spawn; never call a model/provider. Preloaded after
// scripts/live-builtins.mjs, which makes the server's named `spawn` import call the replacement below.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {ApiKeyLogin, OAuthLogin} from '../../dashboard/provider-login.mjs';
import {resolvePi} from '../../lib/launcher.mjs';

OAuthLogin.prototype.status = ApiKeyLogin.prototype.status = async () => ({phase: 'idle', signedIn: true});
const cli = resolvePi().cli; // the dashboard starts Pi itself with the invocation bin/apex would build
childProcess.spawn = (_command, args, options) => {
  assert.equal(args[0], cli, 'Only the offline fixture agent may be started');
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const input = options.cwd.endsWith('text-only') ? ['text'] : ['text', 'image'];
  const emit = event => child.stdout.write(JSON.stringify(event) + '\n');
  let running = false;
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      try {
        for (const line of String(chunk).trim().split('\n')) {
          const command = JSON.parse(line);
          if (command.type === 'prompt') {
            appendFileSync(join(process.env.APEX_DASH_HOME, 'image-prompts.jsonl'), JSON.stringify(command) + '\n');
            if (command.message === 'reject') { emit({type: 'response', id: command.id, command: 'prompt', success: false, error: 'Offline fixture rejected the prompt'}); continue; }
            emit({type: 'response', id: command.id, command: 'prompt', success: true, data: {disposition: running ? 'queued' : 'started'}});
            emit({type: 'agent_start'}); running = true;
            if (command.message === 'keep running') continue;
            emit({type: 'message_end', message: {role: 'user', content: [...(command.message ? [{type: 'text', text: command.message}] : []), ...(command.images ?? [])]}});
            emit({type: 'message_start', message: {role: 'assistant', content: []}});
            emit({type: 'message_update', assistantMessageEvent: {type: 'text_delta', contentIndex: 0, delta: '**Image received.**'}});
            emit({type: 'message_end', message: {role: 'assistant', content: [{type: 'text', text: '**Image received.**'}]}});
            emit({type: 'agent_settled'}); running = false;
          } else {
            const data = command.type === 'get_state' ? {model: {input}} : command.type === 'get_session_stats' ? {cost: 0} : command.type === 'get_messages' ? {messages: []} : command.type === 'get_commands' ? {commands: []} : {};
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
