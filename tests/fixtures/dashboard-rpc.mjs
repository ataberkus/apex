// Offline dashboard fixture: no real agent child or provider request can start.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {syncBuiltinESMExports} from 'node:module';
import {PassThrough, Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {CodexLogin} from '../../dashboard/codex-login.mjs';

CodexLogin.prototype.status = async () => ({phase: 'idle', signedIn: true});
const apex = fileURLToPath(new URL('../../bin/apex', import.meta.url));
childProcess.spawn = (_command, args) => {
  assert.equal(args[0], apex, 'Only the fixture agent may be started');
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let cost = 0;
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
            emit({type: 'agent_settled'});
          } else {
            const data = command.type === 'get_session_stats' ? {cost} : command.type === 'get_messages' ? {messages: []} : command.type === 'get_commands' ? {commands: []} : {};
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
syncBuiltinESMExports();
