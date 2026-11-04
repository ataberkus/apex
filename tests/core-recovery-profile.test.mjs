import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {unixOnly} from './fixtures/filesystem.mjs';
const module=await import('../lib/recovery-profile.mjs').catch(()=>null);
const paid={paid_runs_enabled:true,execution_policy:'paid-enabled',allowed_model:'openrouter/meta/muse-spark-1.3-contributor',thinking_level:'xhigh'};
test('recovery launch refuses offline before environment or filesystem access',async()=>{
  assert.ok(module,'Recovery launcher profile missing');
  const forbidden=new Proxy({}, {get(){throw Error('environment access forbidden');}});
  await assert.rejects(module.createRecoveryProfile({policy:{paid_runs_enabled:false},env:forbidden}),/offline|free-only/);
});
test('authorized profile stores only native retry settings and cleans its own agent directory',async t=>{
  assert.ok(module,'Recovery launcher profile missing');
  const cwd=await mkdtemp(path.join(process.cwd(),'.recovery-test-'));
  try{
    const result=await module.createRecoveryProfile({cwd,policy:paid,env:{MARKER:'fixture'},settings:{compaction:{enabled:false}}});
    assert.equal(result.env.MARKER,'fixture');
    const saved=JSON.parse(await readFile(path.join(result.agentDir,'settings.json'),'utf8'));
    assert.equal(saved.retry.enabled,true);assert.equal(saved.retry.maxRetries,2);assert.equal(saved.retry.provider.maxRetries,0);
    assert.equal(saved.defaultThinkingLevel,'xhigh');assert.deepEqual(saved.compaction,{enabled:false});
    await t.test('POSIX private retry files', {skip: unixOnly}, async()=>{
      assert.equal((await stat(result.agentDir)).mode&0o777,0o700);
      assert.equal((await stat(path.join(result.agentDir,'settings.json'))).mode&0o777,0o600);
    });
    assert.deepEqual(await readdir(result.agentDir),['settings.json']);
    await result.cleanup();await result.cleanup();
    await assert.rejects(stat(result.agentDir),/ENOENT/);
  }finally{await rm(cwd,{recursive:true,force:true});}
});
