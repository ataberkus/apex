import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const script = path.resolve('scripts/micro-process.mjs');
// Children preload live-builtins so patched builtins reach micro-process.mjs's named imports, like syncBuiltinESMExports did.
const liveBuiltins = fileURLToPath(new URL('../scripts/live-builtins.mjs', import.meta.url));
const runtime = path.isAbsolute(process.execPath) ? process.execPath : (process.env.PATH ?? '')
  .split(path.delimiter).map(directory => path.join(directory, process.execPath)).find(candidate => {
    try { accessSync(candidate, constants.X_OK); return true; } catch { return false; }
  });
const childEnv = {PATH: `${path.dirname(runtime)}:/usr/bin:/bin`, LANG: 'C'};

// Catches accidental import-time execution or fixture allocation.
test('importing the process microcheck does not spawn processes or create fixtures', () => {
  const cwd = mkdtempSync(path.resolve('process-micro-import-'));
  try {
    const source = `
      import childProcess from 'node:child_process';
      if (globalThis.__apexLiveBuiltins !== true) throw new Error('live builtins not loaded');
      for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        childProcess[name] = () => { throw new Error('unexpected import-time process'); };
      }
      await import(${JSON.stringify(pathToFileURL(script).href)});
      console.log('import complete');
    `;
    const result = spawnSync(runtime, ['--preload', liveBuiltins, '--input-type=module', '-e', source], {
      cwd, env: childEnv, encoding: 'utf8', timeout: 3000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'import complete');
    assert.deepEqual(readdirSync(cwd), []);
  } finally {
    rmSync(cwd, {recursive: true, force: true});
  }
});

// Catches losing detachment, checking health before host exit, leaked resources,
// or credentials/ambient environment reaching the native tool host or service.
test('native Pi bash service survives tool-host exit and the owned process is cleaned up', {timeout: 10000}, t => {
  const started = Date.now();
  const result = spawnSync(runtime, [script], {
    env: {...childEnv, APEX_PROCESS_MICRO_UNSAFE_ENV: 'test-only-sentinel'},
    encoding: 'utf8', timeout: 9000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const artifact = JSON.parse(result.stdout);
  assert.equal(artifact.provider_calls, 0);
  assert.equal(artifact.platform, process.platform);
  if (artifact.status === 'SKIP') {
    assert.ok(artifact.skip_reason);
    assert.equal(artifact.post_exit_health.succeeded, false);
    if (artifact.skip_reason === 'native Pi package unavailable') {
      assert.throws(() => import.meta.resolve('@earendil-works/pi-coding-agent'),
        'an installed native Pi ESM package must not be misreported as unavailable');
    }
    t.skip(artifact.skip_reason);
    return;
  }
  assert.equal(artifact.status, 'PASS');
  assert.equal(artifact.proof, 'service survives native tool-host exit');
  assert.equal(artifact.network_scope, 'ephemeral loopback HTTP only');
  assert.equal(artifact.host.exited_successfully, true);
  assert.equal(artifact.host.exit_code, 0);
  assert.equal(artifact.host.environment_sanitized, true);
  assert.equal(artifact.native_bash.exit_code, 0);
  assert.equal(artifact.post_exit_health.succeeded, true);
  assert.equal(artifact.post_exit_health.observed_after_host_exit, true);
  assert.equal(artifact.post_exit_health.environment_sanitized, true);
  assert.equal(artifact.post_exit_health.cwd_matches_fixture, true);
  assert.equal(artifact.service.bound_address, '127.0.0.1');
  assert.ok(artifact.service.port > 0 && artifact.service.port <= 65535);
  assert.ok(artifact.service.pid > 1);
  assert.notEqual(artifact.service.pid, artifact.host.pid);
  assert.equal(artifact.cleanup.owned_pid_only, true);
  assert.equal(artifact.cleanup.process_terminated, true);
  assert.equal(artifact.cleanup.health_unavailable, true);
  assert.equal(artifact.cleanup.fixture_removed, true);
  assert.equal(artifact.cleanup.repeated_cleanup_safe, true);
  assert.equal(existsSync(artifact.fixture), false);
  assert.ok(Date.now() - started < 10000);
});

function loopback(info, token, route = '/health') {
  return new Promise((resolve, reject) => {
    const req = http.request({hostname: '127.0.0.1', port: info.port, path: route,
      method: route === '/shutdown' ? 'POST' : 'GET', agent: false,
      headers: token ? {authorization: `Bearer ${token}`} : {}}, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
      res.on('error', reject);
    });
    req.setTimeout(300, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function runWithBoundaryFault(cwd, fault) {
  // Fault injection stays in the test process wrapper. Pi and its detached
  // service remain real, and every child still receives the scrubbed environment.
  const source = `
    import fs from 'node:fs';
    import promises from 'node:fs/promises';
    import cp from 'node:child_process';
    import http from 'node:http';
    import path from 'node:path';
    const rawSpawn = cp.spawn;
    cp.spawn = (command,args,options) => {
      if (args[1] === '--tool-host') fs.writeFileSync('owned-spec.json',args[2]);
      return rawSpawn(command,args,options);
    };
    const rawWrite = promises.writeFile;
    promises.writeFile = (file, value, ...args) => {
      if (path.basename(file) === 'server.mjs' && ${Number(fault.startupDelayMs ?? 0)} > 0)
        value = value.replace('const token =', 'await new Promise(resolve => setTimeout(resolve, ${Number(fault.startupDelayMs ?? 0)}));\\nconst token =');
      return rawWrite(file, value, ...args);
    };
    const rawRead = promises.readFile;
    promises.readFile = async (file,...args) => {
      const value = await rawRead(file,...args);
      if (path.basename(file) === 'ready.json') {
        fs.writeFileSync('observed-ready.json',value);
        ${fault.read ?? ''}
      }
      return value;
    };
    ${fault.http ?? ''}
    if (globalThis.__apexLiveBuiltins !== true) throw new Error('live builtins not loaded');
    const {runProcessMicro} = await import(${JSON.stringify(pathToFileURL(script).href)});
    const artifact = await runProcessMicro();
    console.log(JSON.stringify(artifact));
    if (artifact.status === 'FAIL') process.exitCode = 1;
  `;
  return new Promise(resolve => {
    const child = spawn(runtime, ['--preload', liveBuiltins, '--input-type=module', '-e', source], {cwd, env: childEnv});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 9000);
    child.once('close', (status, signal) => { clearTimeout(timer); resolve({status, signal, stdout, stderr}); });
  });
}

async function cleanFaultFixture(cwd) {
  try {
    const spec = JSON.parse(readFileSync(path.join(cwd, 'owned-spec.json'), 'utf8'));
    const info = JSON.parse(readFileSync(path.join(cwd, 'observed-ready.json'), 'utf8'));
    await loopback(info, spec.token, '/shutdown').catch(() => {});
  } catch {}
  rmSync(cwd, {recursive: true, force: true});
}

// Catches returning/removing the fixture while a service with an unreadable
// readiness record is still alive. The real watchdog must expire before return.
test('missing readiness waits for the service watchdog before removing its fixture', {timeout: 10000}, async t => {
  if (process.platform !== 'linux') { t.skip('requires Linux'); return; }
  const cwd = mkdtempSync(path.resolve('process-micro-fault-'));
  try {
    const result = await runWithBoundaryFault(cwd, {
      read: "throw Object.assign(new Error('injected unreadable ready record'), {code:'ENOENT'});",
    });
    const artifact = JSON.parse(result.stdout);
    if (artifact.status === 'SKIP') { t.skip(artifact.skip_reason); return; }
    assert.equal(result.status, 1, result.stderr);
    const info = JSON.parse(readFileSync(path.join(cwd, 'observed-ready.json'), 'utf8'));
    await assert.rejects(() => loopback(info), 'owned service must be gone when the failed check returns');
    assert.equal(artifact.cleanup.watchdog_termination_confirmed, true, JSON.stringify(artifact));
    assert.equal(artifact.cleanup.fixture_removed, true);
    assert.ok(artifact.elapsed_ms < 9000);
  } finally { await cleanFaultFixture(cwd); }
});

// Catches a response-aborted promise that never rejects and skips finally cleanup.
test('an aborted loopback health response returns a failure artifact and cleans up', {timeout: 10000}, async t => {
  if (process.platform !== 'linux') { t.skip('requires Linux'); return; }
  const cwd = mkdtempSync(path.resolve('process-micro-fault-'));
  const broken = http.createServer((_req, res) => {
    res.writeHead(200, {'content-type': 'application/json'});
    res.write('{"pid":');
    setTimeout(() => res.destroy(), 20);
  });
  try {
    await new Promise(resolve => broken.listen(0, '127.0.0.1', resolve));
    const port = broken.address().port;
    const result = await runWithBoundaryFault(cwd, {http: `
      const rawRequest = http.request;
      let firstHealth = true;
      http.request = (options, callback) => {
        if (options.path === '/health' && firstHealth) {
          firstHealth = false;
          options = {...options,port:${port}};
        }
        return rawRequest(options,callback);
      };
    `});
    const artifact = result.stdout ? JSON.parse(result.stdout) : null;
    if (artifact?.status === 'SKIP') { t.skip(artifact.skip_reason); return; }
    assert.equal(result.status, 1, result.stderr);
    assert.ok(artifact, 'failed check must still produce a JSON artifact');
    assert.equal(artifact.status, 'FAIL');
    assert.equal(artifact.post_exit_health.succeeded, false);
    assert.equal(artifact.cleanup.process_terminated, true);
    assert.equal(artifact.cleanup.fixture_removed, true);
    assert.ok(artifact.elapsed_ms < 9000);
  } finally {
    await cleanFaultFixture(cwd);
    await new Promise(resolve => broken.close(resolve));
  }
});

// The detached Node program starts its watchdog after initialization, which can
// occur later than its tool host's exit even though process launch happened first.
test('delayed service initialization still confirms watchdog cleanup when readiness is unreadable',{timeout:10000},async t=>{
 if(process.platform!=='linux'){t.skip('requires Linux');return;}
 const cwd=mkdtempSync(path.resolve('process-micro-fault-'));
 try{
  const r=await runWithBoundaryFault(cwd,{startupDelayMs:750,read:"throw Object.assign(new Error('injected unreadable ready record'),{code:'ENOENT'});"});
  const a=JSON.parse(r.stdout);if(a.status==='SKIP'){t.skip(a.skip_reason);return;}
  assert.equal(r.status,1,r.stderr);assert.equal(a.cleanup.watchdog_termination_confirmed,true,JSON.stringify(a));
  assert.equal(a.cleanup.fixture_removed,true);const info=JSON.parse(readFileSync(path.join(cwd,'observed-ready.json'),'utf8'));
  await assert.rejects(()=>loopback(info));
 }finally{await cleanFaultFixture(cwd);}
});
