import {spawn as nodeSpawn} from 'node:child_process';
import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {access, link, lstat, mkdir, open, realpath, unlink} from 'node:fs/promises';
import path from 'node:path';

const LOG_BYTES = 65536;
const TEXT_BYTES = 8192;
const ID = /^[a-f0-9]{32}$/;
const SIGNS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT']);
const ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM'];
const CONTROL_SLOTS = 64;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const abort = signal => { if (signal?.aborted) throw new Error('Background operation aborted'); };
const signature = (key, data) => createHmac('sha256', key).update(JSON.stringify(data)).digest('hex');
// Atomic record publication may unlink a still-open previous inode. Such an FD
// remains safe; multiple hard links are rejected because they escape the namespace.
const validOwner = info => info.uid === process.getuid() && (info.mode & 0o077) === 0 && info.nlink <= 1;

async function boundedRead(handle, limit) {
  const bytes = Buffer.alloc(limit + 1);
  const {bytesRead} = await handle.read(bytes, 0, bytes.length, 0);
  if (bytesRead > limit) throw new Error('Background ownership file exceeds its byte limit');
  return bytes.subarray(0, bytesRead);
}

function cleanEnvironment(source) {
  const result = {};
  for (const key of ENV_KEYS) if (typeof source?.[key] === 'string' && !source[key].includes('\0') && Buffer.byteLength(source[key]) <= 8192) result[key] = source[key];
  result.PATH ??= '/usr/bin:/bin';
  result.LANG ??= 'C';
  return result;
}

async function directory(file, {create = false, privateDirectory = true} = {}) {
  if (create) await mkdir(file, {mode: 0o700}).catch(error => { if (error.code !== 'EEXIST') throw error; });
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error) { throw new Error(`Unsafe background directory (symlink or missing): ${error.code}`); }
  const info = await handle.stat();
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & (privateDirectory ? 0o077 : 0o022))) {
    await handle.close();
    throw new Error('Background directory must be owned and restrictive');
  }
  return handle;
}

async function storage(cwd, create) {
  const root = await realpath(cwd);
  let base;
  let bg;
  try {
    base = await directory(path.join(root, '.apex'), {create, privateDirectory: false});
    const location = path.join(root, '.apex', 'bg');
    bg = await directory(location, {create});
    const baseInfo = await base.stat();
    const bgInfo = await bg.stat();
    const verify = async () => {
      for (const [file, expected] of [[path.join(root, '.apex'), baseInfo], [location, bgInfo]]) {
        const current = await lstat(file);
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) throw new Error('Background directory ownership changed');
      }
    };
    await verify();
    const ownerFile = `${location}/.owner`;
    if (create) {
      const temporary = await privateTemporary(location, randomBytes(32));
      try {
        await verify();
        await link(temporary, ownerFile);
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      finally { await unlink(temporary); }
    }
    let owner;
    // Publication is complete before visibility. Retry only the brief second
    // hard link while the successful publisher unlinks its private temporary.
    for (let attempt = 0; attempt < 20; attempt++) {
      try { owner = await secureFile(ownerFile, {maxBytes: 32}); break; }
      catch (error) { if (error.code !== 'APEX_BG_LINKED' || attempt === 19) throw error; await delay(10); }
    }
    let key;
    try { key = await boundedRead(owner, 32); } finally { await owner.close(); }
    if (key.length !== 32) throw new Error('Invalid background ownership key');
    await verify();
    return {root, bg, location, key, verify, directoryIdentity: {base: {dev: baseInfo.dev, ino: baseInfo.ino}, bg: {dev: bgInfo.dev, ino: bgInfo.ino}}, close: () => bg.close()};
  } catch (error) { await bg?.close(); throw error; }
  finally { await base?.close(); }
}

async function secureFile(file, {flags = constants.O_RDONLY, maxBytes} = {}) {
  let handle;
  try { handle = await open(file, flags | constants.O_NOFOLLOW); }
  catch (error) { throw new Error(`Unsafe background file (symlink or missing): ${error.code}`); }
  const info = await handle.stat();
  if (!info.isFile() || !validOwner(info) || (maxBytes && info.size > maxBytes)) {
    await handle.close();
    const error = new Error('Background ownership requires a restrictive regular file');
    if (info.isFile() && info.uid === process.getuid() && !(info.mode & 0o077) && info.nlink === 2 && (!maxBytes || info.size <= maxBytes)) error.code = 'APEX_BG_LINKED';
    throw error;
  }
  return handle;
}

async function metadata(store, id) {
  await store.verify();
  const handle = await secureFile(`${store.location}/${id}.json`, {maxBytes: 8192});
  let record;
  try { record = JSON.parse((await boundedRead(handle, 8192)).toString('utf8')); }
  catch { throw new Error('Invalid background ownership metadata'); }
  finally { await handle.close(); }
  const {data, mac} = record ?? {};
  const expected = data && signature(store.key, data);
  if (typeof mac !== 'string' || !/^[a-f0-9]{64}$/.test(mac) || !expected ||
      !timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex')) ||
      data.id !== id || data.cwd !== store.root || data.version !== 1 ||
      !Number.isSafeInteger(data.pid) || data.pid <= 1 ||
      !ID.test(data.runToken) || !Number.isSafeInteger(data.lastSeen) ||
      !['running', 'exited', 'terminating'].includes(data.status)) throw new Error('Background ownership signature or identity is invalid');
  return data;
}

async function liveState(data) {
  if (data.status === 'exited') return 'exited';
  if (data.status === 'terminating' && data.exitSignal === 'SIGKILL') return Date.now() - data.lastSeen >= 200 ? 'exited' : 'terminating';
  if (Date.now() - data.lastSeen > 2000 || data.lastSeen > Date.now() + 1000) return 'stale';
  return 'running';
}

async function privateTemporary(location, value) {
  const temporary = `${location}/${randomBytes(16).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(value);
    await handle.close(); handle = undefined;
    return temporary;
  } catch (error) { await handle?.close(); await unlink(temporary).catch(() => {}); throw error; }
}

async function publishRequest(store, request) {
  await store.verify();
  const temporary = await privateTemporary(store.location, JSON.stringify({data: request, mac: signature(store.key, request)}));
  try {
    const first = Number.parseInt(request.nonce.slice(0, 8), 16) % CONTROL_SLOTS;
    for (let offset = 0; offset < CONTROL_SLOTS; offset++) {
      const file = `${store.location}/${request.id}.control.${(first + offset) % CONTROL_SLOTS}`;
      try { await link(temporary, file); return; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    throw new Error('Background control capacity exceeded (64 pending requests); retry after acknowledgment');
  } finally { await unlink(temporary); }
}

async function acknowledgment(store, request) {
  let handle;
  try { handle = await secureFile(`${store.location}/${request.id}.${request.nonce}.ack`, {maxBytes: 2048}); }
  catch (error) { if (/missing.*ENOENT/.test(error.message)) return undefined; throw error; }
  let record;
  try { record = JSON.parse((await boundedRead(handle, 2048)).toString('utf8')); }
  finally { await handle.close(); }
  const {data, mac} = record ?? {};
  if (!data || data.id !== request.id || data.nonce !== request.nonce || data.runToken !== request.runToken ||
      !SIGNS.has(data.effectiveSignal) || typeof mac !== 'string' || !/^[a-f0-9]{64}$/.test(mac) ||
      !timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(signature(store.key, data), 'hex'))) throw new Error('Invalid background ownership acknowledgment');
  return data;
}

async function executable() {
  if (path.isAbsolute(process.execPath)) return process.execPath;
  for (const folder of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.resolve(folder, process.execPath);
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error('Cannot resolve current Node executable');
}

function result(action, data, extra = {}) {
  const structuredContent = {action, id: data.id, pid: data.pid, status: data.status, ...extra};
  const summary = `bg ${action}: ${data.id} ${structuredContent.status} (owned group ${data.pid})`;
  structuredContent.text = `${summary}${structuredContent.output ? `\n${structuredContent.output}` : ''}`;
  return {content: [{type: 'text', text: structuredContent.text}], structuredContent, details: {apexBg: {...structuredContent}}};
}

// This child is a detached session leader. It owns the command's pipes and keeps
// only the last 64 KiB in a private FD, so output never reaches the agent's pipes.
// The extra input pipe closes immediately after config; no parent IPC survives.
const WORKER = String.raw`
const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const config = JSON.parse(fs.readFileSync(3, 'utf8'));
fs.closeSync(3);
process.umask(0o077);
process.on('SIGHUP', () => {});
// Retain the control channel when a command elects to ignore TERM or INT.
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
const location = config.location;
function verifyDirectory() {
  for(const [file,expected] of [[config.cwd+'/.apex',config.directoryIdentity.base],[location,config.directoryIdentity.bg]]) {
    const current=fs.lstatSync(file);
    if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==expected.dev||current.ino!==expected.ino) throw new Error('Background directory ownership changed');
  }
}
let log = Buffer.alloc(0);
function append(value) {
  const incoming = Buffer.isBuffer(value) ? value : Buffer.from(value);
  log = Buffer.concat([log, incoming]).subarray(-65536);
  fs.writeSync(4, log, 0, log.length, 0);
  fs.ftruncateSync(4, log.length);
}
let data = {version:1,id:config.id,cwd:config.cwd,pid:process.pid,runToken:config.runToken,
  status:'running',createdAt:new Date().toISOString(),lastSeen:Date.now()};
function saveRecord(file,value) {
  verifyDirectory();
  const key = Buffer.from(config.key,'hex');
  const mac = crypto.createHmac('sha256',key).update(JSON.stringify(value)).digest('hex');
  const temporary = location + '/' + config.id + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  const fd = fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  fs.writeFileSync(fd,JSON.stringify({data:value,mac}));fs.closeSync(fd);
  fs.renameSync(temporary,location+'/'+file);
}
function save() { saveRecord(config.id+'.json',data); }
save();
const child = cp.spawn('/bin/sh',['-c',"trap '' HUP\n"+config.command],{cwd:config.cwd,env:config.env,stdio:['ignore','pipe','pipe']});
child.stdout.on('data',append);child.stderr.on('data',append);
child.once('error',error=>append('Background command failed: '+error.code+'\n'));
const acknowledgments=[];
const timer = setInterval(()=>{
  try {
    data.lastSeen=Date.now();save();
    const now=Date.now();
    while(acknowledgments.length&&acknowledgments[0].expires<=now){
      const ack=acknowledgments.shift();
      try{fs.unlinkSync(location+'/'+ack.file)}catch(error){if(error.code!=='ENOENT')throw error}
    }
    const pending=[];
    // Fixed exclusive slots bound disk queue size and all per-tick reads. A
    // complete request is published before reserving a slot; none overwrite.
    for(let slot=0;slot<64&&acknowledgments.length+pending.length<2048;slot++){
      let fd;
      const file=config.id+'.control.'+slot;
      try {
        fd=fs.openSync(location+'/'+file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
        const info=fs.fstatSync(fd);
        if(!info.isFile()||info.uid!==process.getuid()||(info.mode&0o077)||info.nlink>1||info.size>2048)continue;
        const bytes=Buffer.alloc(2049);const count=fs.readSync(fd,bytes,0,bytes.length,0);
        if(count>2048)continue;
        const record=JSON.parse(bytes.subarray(0,count).toString('utf8'));
        const request=record.data;
        if(!request||request.id!==config.id||request.runToken!==config.runToken||!/^[a-f0-9]{32}$/.test(request.nonce)||
           !Number.isSafeInteger(request.issuedAt)||!['SIGTERM','SIGKILL','SIGINT'].includes(request.signal))continue;
        const expected=crypto.createHmac('sha256',Buffer.from(config.key,'hex')).update(JSON.stringify(request)).digest('hex');
        if(record.mac!==expected)continue;
        if(now-request.issuedAt>10000||request.issuedAt>now+1000){fs.unlinkSync(location+'/'+file);continue}
        pending.push({request,file});
      } catch(error) { if(error.code!=='ENOENT')append('Ignored invalid background control request\n'); }
      finally { if(fd!==undefined)fs.closeSync(fd); }
    }
    if(!pending.length)return;
    const strongest=pending.some(({request})=>request.signal==='SIGKILL')?'SIGKILL':pending.some(({request})=>request.signal==='SIGTERM')?'SIGTERM':'SIGINT';
    // Acknowledge every nonce before signaling. Concurrent TERM cannot hide an
    // explicit KILL, including when the group terminates before either poll.
    for(const {request,file} of pending){
      const ackFile=config.id+'.'+request.nonce+'.ack';
      saveRecord(ackFile,{id:config.id,runToken:config.runToken,nonce:request.nonce,signal:request.signal,effectiveSignal:strongest});
      acknowledgments.push({file:ackFile,expires:now+3000});
      fs.unlinkSync(location+'/'+file);
    }
    data={...data,status:'terminating',lastSeen:Date.now(),killNonce:pending[0].request.nonce,exitSignal:strongest};save();
    // Every signal is explicit. The live leader signals only its own group.
    for(const signal of ['SIGINT','SIGTERM','SIGKILL'])if(pending.some(({request})=>request.signal===signal))process.kill(-process.pid,signal);
  } catch(error) { append('Background control processing unavailable\n'); }
},100);
child.once('close',(code,signal)=>{clearInterval(timer);data={...data,status:'exited',exitCode:code,exitSignal:signal??null};save();});
`;

function validate(input) {
  if (!input || !['start', 'poll', 'tail', 'kill'].includes(input.action)) throw new Error('Invalid bg action');
  if (input.action === 'start') {
    if (typeof input.command !== 'string' || !input.command.trim() || input.command.includes('\0') || Buffer.byteLength(input.command) > 16384) throw new Error('bg start command must be nonempty and at most 16384 bytes');
    if (input.startTimeoutSeconds !== undefined && (!Number.isFinite(input.startTimeoutSeconds) || input.startTimeoutSeconds < 0.01 || input.startTimeoutSeconds > 10)) throw new Error('bg start timeout must be 0.01..10 seconds');
  } else if (typeof input.id !== 'string' || !ID.test(input.id)) throw new Error('Invalid opaque bg id');
  if (input.maxBytes !== undefined && (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > TEXT_BYTES)) throw new Error('bg tail maxBytes must be 1..8192 bytes');
  if (input.signal !== undefined && !SIGNS.has(input.signal)) throw new Error('Invalid bg kill signal');
}

export function createBackgroundTool({cwd, env = process.env, platform = process.platform, spawn = nodeSpawn}) {
  // All allocation, including resolving cwd, is deliberately deferred to execute.
  const childEnv = cleanEnvironment(env);
  return {
    name: 'bg', label: 'Background processes',
    description: 'Start an owned detached command, poll its heartbeat, tail its bounded log, or explicitly kill its owned process group. Services survive agent exit. Unix only; use foreground commands without daemonizing or changing process groups.',
    promptSnippet: 'Manage detached background commands with opaque IDs',
    parameters: {type: 'object', properties: {
      action: {type: 'string', enum: ['start', 'poll', 'tail', 'kill']}, command: {type: 'string'}, id: {type: 'string'},
      maxBytes: {type: 'integer', minimum: 1, maximum: TEXT_BYTES},
      signal: {type: 'string', enum: [...SIGNS]}, startTimeoutSeconds: {type: 'number', minimum: 0.01, maximum: 10},
    }, required: ['action']},
    outputSchema: {type: 'object', properties: {text: {type: 'string'}, action: {type: 'string'}, id: {type: 'string'}, pid: {type: 'integer'}, status: {type: 'string'}}, required: ['text', 'action', 'id', 'pid', 'status']},
    async execute(_callId, input, signal) {
      abort(signal);
      validate(input);
      if (platform === 'win32' || typeof process.getuid !== 'function') throw new Error('Native Windows background management is unsupported');
      const store = await storage(cwd, input.action === 'start');
      try {
        abort(signal);
        if (input.action === 'start') {
          const id = randomBytes(16).toString('hex');
          const log = await open(`${store.location}/${id}.log`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          let child;
          try {
            await log.chmod(0o600);
            abort(signal);
            await store.verify();
            child = spawn(await executable(), ['-e', WORKER], {cwd: store.root, env: childEnv, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', log.fd]});
            let ended;
            child.once('exit', (code, exitSignal) => { ended = {code, signal: exitSignal}; });
            await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
            const stream = child.stdio[3];
            stream.on('error', () => {});
            stream.end(JSON.stringify({id, cwd: store.root, location: store.location, directoryIdentity: store.directoryIdentity, key: store.key.toString('hex'), runToken: randomBytes(16).toString('hex'), command: input.command, env: childEnv}));
            child.unref();
            const end = Date.now() + (input.startTimeoutSeconds ?? 3) * 1000;
            while (Date.now() < end) {
              try {
                const record = await metadata(store, id);
                return result('start', record, {status: await liveState(record), ...(signal?.aborted ? {aborted: true} : {})});
              } catch (error) {
                if (!/missing.*ENOENT/.test(error.message)) throw error;
              }
              if (ended) throw new Error(`Background supervisor exited before readiness (${ended.code ?? ended.signal})`);
              if (signal?.aborted) break;
              await delay(10);
            }
            // A started service is never killed as an effect of cancellation or
            // readiness timeout. Its opaque ID remains available for explicit kill.
            return result('start', {id, pid: child.pid, status: 'starting'}, {aborted: Boolean(signal?.aborted), readinessTimedOut: !signal?.aborted});
          } finally { await log.close(); }
        }
        const record = await metadata(store, input.id);
        abort(signal);
        const status = await liveState(record);
        if (input.action === 'poll') return result('poll', record, {status, exitCode: record.exitCode ?? null, exitSignal: record.exitSignal ?? null});
        if (input.action === 'tail') {
          const log = await secureFile(`${store.location}/${input.id}.log`, {maxBytes: LOG_BYTES});
          try {
            const size = (await log.stat()).size;
            const limit = input.maxBytes ?? TEXT_BYTES;
            const bytes = Buffer.alloc(Math.min(size, limit));
            const {bytesRead} = await log.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
            // Replacement bytes can expand a split UTF-8 character. Bound again.
            let output = bytes.subarray(0, bytesRead).toString('utf8');
            while (Buffer.byteLength(output) > limit) output = output.slice(1);
            return result('tail', record, {status, output, truncated: size > limit});
          } finally { await log.close(); }
        }
        if (status === 'stale') throw new Error('Stale background heartbeat; refusing kill request');
        if (status !== 'running') return result('kill', record, {status, alreadyExited: status === 'exited', ...(status === 'terminating' ? {signal: record.exitSignal} : {})});
        abort(signal);
        const requested = input.signal ?? 'SIGTERM';
        const request = {id: record.id, runToken: record.runToken, signal: requested, nonce: randomBytes(16).toString('hex'), issuedAt: Date.now()};
        await publishRequest(store, request);
        const end = Date.now() + 1500;
        try {
          while (Date.now() < end) {
            const updated = await metadata(store, record.id);
            const ack = await acknowledgment(store, request);
            if (ack) return result('kill', updated, {status: 'terminating', signal: requested, effectiveSignal: ack.effectiveSignal, alreadyExited: false});
            if (updated.status === 'exited' || (updated.status === 'terminating' && updated.exitSignal === 'SIGKILL')) return result('kill', updated, {
              status: await liveState(updated), signal: requested, effectiveSignal: updated.exitSignal, alreadyExited: updated.status === 'exited', superseded: true,
            });
            abort(signal);
            await delay(20);
          }
          throw new Error(`Owned background ${record.id} did not acknowledge kill; no persisted PID was signaled`);
        } finally { await unlink(`${store.location}/${record.id}.${request.nonce}.ack`).catch(() => {}); }
      } finally { await store.close(); }
    },
  };
}

export function applyBashTimeout(event, {defaultSeconds = 60, maxSeconds} = {}) {
  if (event?.toolName !== 'bash') return undefined;
  const fail = reason => ({block: true, reason});
  if (!Number.isFinite(defaultSeconds) || defaultSeconds <= 0 ||
      (maxSeconds !== undefined && (!Number.isFinite(maxSeconds) || maxSeconds <= 0))) return fail('Invalid bash timeout configuration');
  if (!event.input || typeof event.input !== 'object' || Array.isArray(event.input)) return fail('Invalid bash input for timeout');
  const timeout = event.input.timeout === undefined ? Math.min(defaultSeconds, maxSeconds ?? Infinity) : event.input.timeout;
  if (!Number.isFinite(timeout) || timeout <= 0 || (maxSeconds !== undefined && timeout > maxSeconds)) return fail('Bash timeout must be a positive finite number within the configured maximum');
  event.input.timeout = timeout;
  return undefined;
}
