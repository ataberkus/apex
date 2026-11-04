import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {buildPiInvocation} from '../lib/launcher.mjs';

test('Phase 2 opt-in launcher loads the core and retains Muse/xhigh',()=>{
  const args=buildPiInvocation(['--apex-core','snapshot,todo,verify','--profile','headless','task'],'/pi.js').args;
  assert.equal(args[args.indexOf('--apex-core-flags')+1],'snapshot,todo,verify');
  assert.ok(args.some(value=>value.endsWith(path.join('apex-core','index.mjs'))));
  assert.equal(args[args.indexOf('--model')+1],'openrouter/meta/muse-spark-1.3-contributor');
  assert.equal(args[args.indexOf('--thinking')+1],'xhigh');
  assert.equal(args.filter(x=>x==='--mode').length,1);
});
test('Phase 1 and 2 flags compose, and time is only enabled by explicit feature',()=>{
  const args=buildPiInvocation(['--apex-core=time,correct','--time-budget','123.5','--apex-context=route,read','task'],'/pi.js').args;
  assert.equal(args[args.indexOf('--apex-time-budget')+1],'123.5');
  assert.equal(args[args.indexOf('--model')+1],'apex/auto');
  assert.equal(args.filter(x=>x==='--extension').length,3);
  for(const bad of [['--time-budget','10'],['--apex-core','todo','--time-budget','10'],
    ['--apex-core','time','--time-budget','0'],['--apex-core','time','--time-budget','10','--time-budget','10'],
    ['--apex-core','todo','--model','other/model'],['--apex-core','todo','--apex-context','route','--thinking','low'],
    ['--apex-core','todo','--apex-core','verify'],['--apex-core','todo','--thinking','loud']])assert.throws(()=>buildPiInvocation(bad,'/pi.js'));
  const low=buildPiInvocation(['--apex-core','todo','--thinking','low','task'],'/pi.js').args;
  assert.equal(low[low.indexOf('--thinking')+1],'low');
});
test('Apex options in literal task and Pi values retain their meanings',()=>{
  assert.deepEqual(buildPiInvocation(['--system-prompt','--apex-core','all'],'/pi.js').args,['--system-prompt','--apex-core','all']);
  const args=buildPiInvocation(['--apex-core=todo','--','--apex-core','all'],'/pi.js').args;
  assert.deepEqual(args.slice(-3),['--','--apex-core','all']);
});
test('max is separate, explicit and blocked by free-only policy before launching Pi',()=>{
  assert.throws(()=>buildPiInvocation(['--profile=max','--apex-core=max','--apex-attempts','2','task'],'/pi.js'),/offline|disabled|free-only/);
  assert.throws(()=>buildPiInvocation(['--apex-core=max','--apex-attempts','2','task'],'/pi.js'),/profile/);
  assert.throws(()=>buildPiInvocation(['--apex-core=todo','--apex-attempts','2','task'],'/pi.js'));
});
