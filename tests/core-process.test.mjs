import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {directoryLink, unixOnly} from './fixtures/filesystem.mjs';

const modulePath = path.resolve('extensions/apex-core/process.mjs');
const node = path.isAbsolute(process.execPath) ? process.execPath : process.env.PATH.split(path.delimiter).map(folder => path.join(folder, process.execPath)).find(file => {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
});
const safeEnv = {PATH: `${path.dirname(node)}:/usr/bin:/bin`, LANG: 'C'};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function load() {
  assert.ok(existsSync(modulePath), 'background process management must be implemented');
  return import(pathToFileURL(modulePath).href);
}
function fixture() { return mkdtempSync(path.resolve('core-process-fixture-')); }
function call(tool, input, signal) { return tool.execute('test-call', input, signal, undefined, {}); }
function data(result) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.structuredContent.text, result.content[0].text);
  assert.ok(Buffer.byteLength(result.content[0].text) <= 10000);
  return result.structuredContent;
}
const nodeCommand = source => `${JSON.stringify(node)} -e ${JSON.stringify(source)}`;
async function until(fn, timeout = 3000) {
  const end = Date.now() + timeout;
  do { if (await fn()) return; await pause(20); } while (Date.now() < end);
  assert.fail('owned fixture did not reach expected state');
}
async function cleanup(tool, id, cwd, removeFixture = true) {
  if (id) {
    await call(tool, {action: 'kill', id, signal: 'SIGKILL'}).catch(() => {});
    await until(async () => (await call(tool, {action: 'poll', id})).structuredContent.status === 'exited').catch(() => {});
  }
  if (removeFixture) rmSync(cwd, {recursive: true, force: true});
}

// Losing laziness must fail before creating a process or any state directory.
test('factory and import have no process or filesystem side effects', async () => {
  const {createBackgroundTool} = await load();
  const cwd = fixture();
  try {
    const tool = createBackgroundTool({cwd, env: safeEnv, spawn: () => { throw Error('unexpected factory spawn'); }});
    assert.equal(tool.name, 'bg');
    assert.deepEqual(readdirSync(cwd), []);
  } finally { rmSync(cwd, {recursive: true, force: true}); }
});

// Timeout mutations must affect the same native input, including nested calls.
test('bash timeout defaults preserve valid explicit values and block malformed values', async () => {
  const {applyBashTimeout} = await load();
  const event = {toolName: 'bash', input: {command: 'true'}};
  assert.equal(applyBashTimeout(event), undefined);
  assert.equal(event.input.timeout, 60);
  const nested = {toolName: 'bash', input: {command: 'true', timeout: 7}, parentToolCallId: 'outer'};
  assert.equal(applyBashTimeout(nested, {defaultSeconds: 9, maxSeconds: 10}), undefined);
  assert.equal(nested.input.timeout, 7);
  const other = {toolName: 'read', input: {path: 'file'}};
  applyBashTimeout(other);
  assert.equal(other.input.timeout, undefined);
  for (const timeout of [0, -1, '30', null, Infinity, NaN, 10.5, 11]) {
    const invalid = {toolName: 'bash', input: {command: 'true', timeout}};
    assert.equal(applyBashTimeout(invalid, {maxSeconds: 10}).block, true);
    assert.equal(invalid.input.timeout, timeout);
  }
  assert.equal(applyBashTimeout({toolName: 'bash', input: {}}, {defaultSeconds: 0}).block, true);
  const limited = {toolName: 'bash', input: {command: 'true'}};
  assert.equal(applyBashTimeout(limited, {maxSeconds: 5}), undefined);
  assert.equal(limited.input.timeout, 5);
  const fractional = {toolName: 'bash', input: {command: 'true', timeout: 0.5}};
  assert.equal(applyBashTimeout(fractional, {maxSeconds: 5}), undefined);
  assert.equal(fractional.input.timeout, 0.5);
});

// Dropping group detachment, stdout redirection, or persistent ownership breaks this proof.
test('real service survives host exit and reload explicitly kills its owned group', {timeout: 12000, skip: unixOnly}, async t => {
  const {createBackgroundTool} = await load();
  const cwd = fixture();
  const tool = createBackgroundTool({cwd, env: safeEnv});
  let id;
  try {
    const command = nodeCommand(`const fs=require('fs');fs.writeFileSync('ready.json',JSON.stringify({pid:process.pid,secret:process.env.PROVIDER_SECRET??null}));setInterval(()=>fs.appendFileSync('heartbeat','x'),40);`);
    const source = `import {createBackgroundTool} from ${JSON.stringify(pathToFileURL(modulePath).href)};const t=createBackgroundTool({cwd:${JSON.stringify(cwd)},env:process.env});const r=await t.execute('host',{action:'start',command:${JSON.stringify(command)}});console.log(JSON.stringify({...r.structuredContent,hostPid:process.pid}));`;
    const host = spawnSync(node, ['--input-type=module', '-e', source], {
      cwd, env: {...safeEnv, PROVIDER_SECRET: 'must-not-inherit'}, encoding: 'utf8', timeout: 6000,
    });
    assert.equal(host.status, 0, host.stderr);
    assert.equal(host.stderr, '');
    const started = JSON.parse(host.stdout);
    id = started.id;
    assert.match(id, /^[a-f0-9]{32}$/);
    await until(() => existsSync(path.join(cwd, 'heartbeat')));
    const bytesBefore = statSync(path.join(cwd, 'heartbeat')).size;
    await until(() => statSync(path.join(cwd, 'heartbeat')).size > bytesBefore);
    const ready = JSON.parse(readFileSync(path.join(cwd, 'ready.json')));
    assert.equal(ready.secret, null);
    assert.equal(data(await call(tool, {action: 'poll', id})).status, 'running');
    const stopped = data(await call(tool, {action: 'kill', id, signal: 'SIGKILL'}));
    assert.equal(stopped.signal, 'SIGKILL');
    await until(async () => data(await call(tool, {action: 'poll', id})).status === 'exited');
    await pause(100);
    const bytesAfter = statSync(path.join(cwd, 'heartbeat')).size;
    await pause(100);
    assert.equal(statSync(path.join(cwd, 'heartbeat')).size, bytesAfter);
    assert.equal(data(await call(tool, {action: 'kill', id})).alreadyExited, true);
    t.diagnostic(JSON.stringify({proof: 'heartbeat grows after successful tool-host exit', hostExitCode: host.status,
      hostPid: started.hostPid, supervisorPid: started.pid, servicePid: ready.pid, id, bytesBeforeHostExitObservation: bytesBefore,
      bytesAfterOwnedKill: bytesAfter, observedAfterHostExit: true, environmentSanitized: ready.secret === null,
      ownedKillSignal: 'SIGKILL', repeatedKillSafe: true, externalNetworkCalls: 0}));
  } finally { await cleanup(tool, id, cwd); }
});

// A noisy child must not grow its disk log or either native result indefinitely.
test('real noisy child logs and tails are capped with restrictive permissions', {timeout: 10000, skip: unixOnly}, async () => {
  const {createBackgroundTool} = await load();
  const cwd = fixture();
  const tool = createBackgroundTool({cwd, env: safeEnv});
  let id;
  const previousUmask = process.umask(0);
  try {
    id = data(await call(tool, {action: 'start', command: nodeCommand(`process.stdout.write('a'.repeat(200000),()=>process.stdout.write('END_MARKER'));process.stderr.write('stderr captured');setInterval(()=>{},1000);`)})).id;
    await until(async () => data(await call(tool, {action: 'tail', id, maxBytes: 128})).output.includes('END_MARKER'));
    const tail = data(await call(tool, {action: 'tail', id, maxBytes: 128}));
    assert.ok(Buffer.byteLength(tail.output) <= 128);
    assert.equal(tail.truncated, true);
    const bg = path.join(cwd, '.apex', 'bg');
    assert.equal(statSync(bg).mode & 0o777, 0o700);
    for (const name of readdirSync(bg)) assert.equal(statSync(path.join(bg, name)).mode & 0o777, 0o600, name);
    assert.ok(statSync(path.join(bg, `${id}.log`)).size <= 65536);
  } finally { process.umask(previousUmask); await cleanup(tool, id, cwd); }
});

// Persisted metadata is not permission to signal a different process.
test('forged metadata, stale identity, traversal and symlinks cannot kill an unrelated real child', {timeout: 10000, skip: unixOnly}, async () => {
  const {createBackgroundTool} = await load();
  const cwd = fixture();
  const tool = createBackgroundTool({cwd, env: safeEnv});
  const innocent = spawn(node, ['-e', 'setInterval(()=>{},1000)'], {env: safeEnv, stdio: 'ignore'});
  let id;
  let original;
  try {
    id = data(await call(tool, {action: 'start', command: nodeCommand('setInterval(()=>{},1000)')})).id;
    const metadataPath = path.join(cwd, '.apex', 'bg', `${id}.json`);
    original = readFileSync(metadataPath);
    const forged = JSON.parse(original);
    forged.data.pid = innocent.pid;
    writeFileSync(metadataPath, JSON.stringify(forged));
    await assert.rejects(() => call(tool, {action: 'kill', id}), /ownership|signature/i);
    process.kill(innocent.pid, 0);
    writeFileSync(metadataPath, original);
    for (const bad of ['../x', '/tmp/x', id.toUpperCase(), `${id}.json`]) await assert.rejects(() => call(tool, {action: 'kill', id: bad}), /id/i);
    const logPath = path.join(cwd, '.apex', 'bg', `${id}.log`);
    rmSync(logPath);
    symlinkSync(path.join(cwd, 'secret'), logPath);
    writeFileSync(path.join(cwd, 'secret'), 'private fixture content');
    await assert.rejects(() => call(tool, {action: 'tail', id}), /symbolic|symlink|ownership|regular/i);
    const fakeId = '1'.repeat(32);
    symlinkSync(metadataPath, path.join(cwd, '.apex', 'bg', `${fakeId}.json`));
    await assert.rejects(() => call(tool, {action: 'kill', id: fakeId}), /symbolic|symlink|ownership|regular/i);
  } finally {
    if (original && id) writeFileSync(path.join(cwd, '.apex', 'bg', `${id}.json`), original);
    innocent.kill('SIGKILL'); // Direct ChildProcess handle created in this fixture, never a persisted PID.
    await new Promise(resolve => innocent.once('close', resolve));
    await cleanup(tool, id, cwd);
  }
});

test('symlink state directories, Windows, malformed starts and canceled calls allocate no child', async t => {
  const {createBackgroundTool} = await load();
  const cwd = fixture();
  const outside = fixture();
  try {
    const tool = createBackgroundTool({cwd, env: safeEnv});
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(() => call(tool, {action: 'start', command: 'true'}, aborted.signal), /abort/i);
    for (const input of [{action: 'oops'}, {action: 'start'}, {action: 'start', command: ' '}, {action: 'start', command: 'x\0y'}, {action: 'tail', id: 'x', maxBytes: -1}]) {
      await assert.rejects(() => call(tool, input), /action|command|id|bytes/i);
    }
    assert.deepEqual(readdirSync(cwd), []);
    const windows = createBackgroundTool({cwd, platform: 'win32', env: safeEnv});
    await assert.rejects(() => call(windows, {action: 'start', command: 'true'}), /Windows|unsupported/i);
    await t.test('Unix state directory links are refused before spawn', {skip: unixOnly}, async () => {
      await directoryLink(outside, path.join(cwd, '.apex'));
      await assert.rejects(() => call(tool, {action: 'start', command: 'true'}), /symbolic|symlink|directory/i);
      assert.deepEqual(readdirSync(outside), []);
      rmSync(path.join(cwd, '.apex'));
      mkdirSync(path.join(cwd, '.apex'), {mode: 0o700});
      await directoryLink(outside, path.join(cwd, '.apex', 'bg'));
      await assert.rejects(() => call(tool, {action: 'start', command: 'true'}), /symbolic|symlink|directory/i);
      assert.deepEqual(readdirSync(outside), []);
    });
  } finally { rmSync(cwd, {recursive: true, force: true}); rmSync(outside, {recursive: true, force: true}); }
});

// Spawn failure must leave bounded truthful state and no running fixture child.
test('failed supervisor spawn rejects instead of reporting a running process', {skip: unixOnly}, async () => {
  const {createBackgroundTool} = await load();
  const cwd = fixture();
  try {
    const tool = createBackgroundTool({cwd, env: safeEnv, spawn: (...args) => spawn('/definitely/missing/apex-node', args[1], args[2])});
    await assert.rejects(() => call(tool, {action: 'start', command: 'true'}), /ENOENT|spawn/i);
    const earlyExit = createBackgroundTool({cwd, env: safeEnv, spawn: (command, args, options) => spawn(command, [args[0], 'process.exit(17)'], options)});
    await assert.rejects(() => call(earlyExit, {action: 'start', command: 'true'}), /supervisor.*exit|readiness/i);
  } finally { rmSync(cwd, {recursive: true, force: true}); }
});

// Even ownership-key compromise cannot redirect kill to a persisted arbitrary PID.
test('signed metadata cannot redirect an explicit owned kill to a different PID', {timeout: 10000, skip: unixOnly}, async () => {
  const {createBackgroundTool} = await load();
  const cwd = fixture();
  const innocent = spawn(node, ['-e', 'setInterval(()=>{},1000)'], {env: safeEnv, stdio: 'ignore'});
  let leader;
  const tool = createBackgroundTool({cwd, env: safeEnv, spawn: (...args) => { leader = spawn(...args); return leader; }});
  let id;
  try {
    id = data(await call(tool, {action: 'start', command: nodeCommand('setInterval(()=>{},1000)')})).id;
    leader.kill('SIGSTOP'); // Captured actual ChildProcess handle owned by this fixture.
    const bg = path.join(cwd, '.apex', 'bg');
    const record = JSON.parse(readFileSync(path.join(bg, `${id}.json`)));
    const key = readFileSync(path.join(bg, '.owner'));
    const save = () => {
      record.mac = createHmac('sha256', key).update(JSON.stringify(record.data)).digest('hex');
      writeFileSync(path.join(bg, `${id}.json`), JSON.stringify(record));
    };
    record.data.pid = innocent.pid;
    record.data.lastSeen = 0;
    save();
    await assert.rejects(() => call(tool, {action: 'kill', id}), /stale/i);
    process.kill(innocent.pid, 0);
    record.data.lastSeen = Date.now();
    save();
    const killed = call(tool, {action: 'kill', id, signal: 'SIGKILL'});
    leader.kill('SIGCONT');
    assert.equal(data(await killed).signal, 'SIGKILL');
    process.kill(innocent.pid, 0);
  } finally {
    leader?.kill('SIGCONT');
    innocent.kill('SIGKILL');
    await new Promise(resolve => innocent.once('close', resolve));
    await cleanup(tool, id, cwd);
  }
});

// Timeout and in-flight cancellation must return the owned ID without killing the service.
test('readiness timeout and in-flight abort retain an explicitly manageable real child', {timeout: 10000, skip: unixOnly}, async () => {
  const {createBackgroundTool} = await load();
  for (const canceled of [false, true]) {
    const cwd = fixture();
    const controller = new AbortController();
    const tool = createBackgroundTool({cwd, env: safeEnv, spawn: (command, args, options) => {
      const delayed = [...args];
      delayed[1] = `setTimeout(()=>{${args[1]}},250)`;
      const child = spawn(command, delayed, options);
      if (canceled) child.once('spawn', () => controller.abort());
      return child;
    }});
    let id;
    try {
      const started = data(await call(tool, {action: 'start', command: nodeCommand('setInterval(()=>{},1000)'), startTimeoutSeconds: 0.01}, controller.signal));
      id = started.id;
      assert.equal(started.status, 'starting');
      assert.equal(started.aborted, canceled);
      assert.equal(started.readinessTimedOut, !canceled);
      await until(async () => {
        try { return data(await call(tool, {action: 'poll', id})).status === 'running'; } catch { return false; }
      });
      assert.equal(data(await call(tool, {action: 'kill', id, signal: 'SIGKILL'})).signal, 'SIGKILL');
    } finally { await cleanup(tool, id, cwd); }
  }
});

// A TERM-resistant service must remain manageable until an explicit stronger signal.
test('TERM-resistant command remains owned and can receive a later explicit SIGKILL', {timeout: 10000, skip: unixOnly}, async () => {
  const {createBackgroundTool} = await load();
  const cwd = fixture();
  const tool = createBackgroundTool({cwd, env: safeEnv});
  let id;
  let explicitlyKilled = false;
  try {
    id = data(await call(tool, {action: 'start', command: nodeCommand("const fs=require('fs');process.on('SIGTERM',()=>{});fs.writeFileSync('ready','ready');setInterval(()=>{if(fs.existsSync('fixture-stop')){fs.writeFileSync('fixture-finished','done');process.exit(0)}},40)")})).id;
    await until(() => existsSync(path.join(cwd, 'ready')));
    assert.equal(data(await call(tool, {action: 'kill', id, signal: 'SIGTERM'})).signal, 'SIGTERM');
    await pause(250);
    assert.equal(data(await call(tool, {action: 'poll', id})).status, 'running');
    assert.equal(data(await call(tool, {action: 'kill', id, signal: 'SIGKILL'})).signal, 'SIGKILL');
    await until(async () => data(await call(tool, {action: 'poll', id})).status === 'exited');
    explicitlyKilled = true;
  } finally {
    if (!explicitlyKilled && existsSync(path.join(cwd, 'ready'))) {
      writeFileSync(path.join(cwd, 'fixture-stop'), 'owned fixture shutdown');
      await until(() => existsSync(path.join(cwd, 'fixture-finished')));
    }
    await cleanup(tool, id, cwd);
  }
});

// Distinct managers must not overwrite a stronger unconsumed kill request.
test('concurrent KILL and TERM requests from fresh managers cannot lose the owned KILL', {timeout: 10000, skip: unixOnly}, async () => {
  const {createBackgroundTool} = await load();
  const cwd = fixture();
  let leader;
  const starter = createBackgroundTool({cwd, env: safeEnv, spawn: (...args) => { leader = spawn(...args); return leader; }});
  let id;
  let killed = false;
  let pending = [];
  try {
    id = data(await call(starter, {action: 'start', command: nodeCommand("const fs=require('fs');process.on('SIGTERM',()=>{});fs.writeFileSync('ready','ready');setInterval(()=>{if(fs.existsSync('fixture-stop')){fs.writeFileSync('fixture-finished','done');process.exit(0)}fs.appendFileSync('heartbeat','x')},30)")})).id;
    await until(() => existsSync(path.join(cwd, 'heartbeat')));
    leader.kill('SIGSTOP'); // Pause only the actual supervisor handle created above.
    const first = createBackgroundTool({cwd, env: safeEnv});
    const second = createBackgroundTool({cwd, env: safeEnv});
    pending.push(call(first, {action: 'kill', id, signal: 'SIGKILL'}));
    await pause(50);
    pending.push(call(second, {action: 'kill', id, signal: 'SIGTERM'}));
    await pause(50);
    leader.kill('SIGCONT');
    const outcomes = await Promise.allSettled(pending);
    assert.deepEqual(outcomes.map(value => value.status), ['fulfilled', 'fulfilled'], outcomes.map(value => value.reason?.message).join('; '));
    await until(async () => data(await call(first, {action: 'poll', id})).status === 'exited');
    const before = statSync(path.join(cwd, 'heartbeat')).size;
    await pause(120);
    assert.equal(statSync(path.join(cwd, 'heartbeat')).size, before);
    killed = true;
  } finally {
    leader?.kill('SIGCONT');
    await Promise.allSettled(pending);
    if (!killed && existsSync(path.join(cwd, 'ready'))) {
      writeFileSync(path.join(cwd, 'fixture-stop'), 'owned concurrent fixture shutdown');
      await until(() => existsSync(path.join(cwd, 'fixture-finished')));
    }
    await cleanup(starter, id, cwd);
  }
});

// Publishing an incomplete new key must not break another real first start.
test('concurrent first starts publish only complete ownership state', {timeout: 10000, skip: unixOnly}, async () => {
  const {createBackgroundTool} = await load();
  const cwd = fixture();
  const tool = createBackgroundTool({cwd, env: safeEnv});
  const source = `
    import fs from 'node:fs';
    import promises from 'node:fs/promises';
    import {syncBuiltinESMExports} from 'node:module';
    const originalOpen=promises.open;
    promises.open=async(...args)=>{
      const handle=await originalOpen(...args);
      const originalWrite=handle.writeFile.bind(handle);
      handle.writeFile=async(value,...rest)=>{
        if(Buffer.isBuffer(value)&&value.length===32){
          fs.writeFileSync('ownership-writer-paused','ready');
          await new Promise(resolve=>setTimeout(resolve,250));
        }
        return originalWrite(value,...rest);
      };
      return handle;
    };
    syncBuiltinESMExports();
    const {createBackgroundTool}=await import(${JSON.stringify(pathToFileURL(modulePath).href)});
    const tool=createBackgroundTool({cwd:${JSON.stringify(cwd)},env:process.env});
    const result=await tool.execute('first',{action:'start',command:${JSON.stringify(nodeCommand('setInterval(()=>{},1000);setTimeout(()=>process.exit(0),4000)'))}});
    console.log(JSON.stringify(result.structuredContent));
  `;
  const host = spawn(node, ['--input-type=module', '-e', source], {cwd, env: safeEnv, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '';
  let stderr = '';
  host.stdout.on('data', bytes => { stdout += bytes; });
  host.stderr.on('data', bytes => { stderr += bytes; });
  const closed = new Promise(resolve => host.once('close', status => resolve(status)));
  let firstId;
  let secondId;
  try {
    await until(() => existsSync(path.join(cwd, 'ownership-writer-paused')));
    secondId = data(await call(tool, {action: 'start', command: nodeCommand('setInterval(()=>{},1000);setTimeout(()=>process.exit(0),4000)')})).id;
    assert.equal(await closed, 0, stderr);
    firstId = JSON.parse(stdout).id;
    assert.notEqual(firstId, secondId);
    assert.equal(data(await call(tool, {action: 'poll', id: firstId})).status, 'running');
    assert.equal(data(await call(tool, {action: 'poll', id: secondId})).status, 'running');
  } finally {
    await closed;
    if (!firstId && stdout.trim()) firstId = JSON.parse(stdout).id;
    if (firstId) await cleanup(tool, firstId, cwd, false);
    await cleanup(tool, secondId, cwd);
  }
});
