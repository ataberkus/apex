import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { buildPiInvocation } from '../lib/launcher.mjs';

test('default profile forwards prompt and tool arguments without shell interpolation', () => {
  const result = buildPiInvocation(['--model', 'provider/model', 'literal $(secret) `text`'], '/pi cli.js');
  assert.deepEqual(result, {cli: '/pi cli.js', args: ['--model', 'provider/model', 'literal $(secret) `text`']});
});

test('headless profile supplies JSON print mode exactly once', () => {
  const result = buildPiInvocation(['--profile', 'headless', '--print', '--mode', 'json', 'task'], '/pi.js');
  assert.deepEqual(result.args, ['--print', '--mode', 'json', 'task']);
  assert.deepEqual(buildPiInvocation(['--profile=headless', 'task'], '/pi.js').args, ['--print', '--mode', 'json', 'task']);
});

test('headless profile refuses contradictory modes and unimplemented max profile', () => {
  assert.throws(() => buildPiInvocation(['--profile', 'headless', '--mode', 'rpc'], '/pi.js'), /json/);
  assert.throws(() => buildPiInvocation(['--profile', 'max', 'task'], '/pi.js'), /not implemented/);
});

test('profile-looking words in the prompt remain untouched', () => {
  assert.deepEqual(buildPiInvocation(['--', '--profile', 'max'], '/pi.js').args, ['--', '--profile', 'max']);
});

test('Apex flags are prefix-only and never consume Pi option values', () => {
  assert.deepEqual(buildPiInvocation(['--system-prompt', '--profile', 'max'], '/pi.js').args, ['--system-prompt', '--profile', 'max']);
  assert.deepEqual(buildPiInvocation(['--system-prompt', '--profile=headless', 'task'], '/pi.js').args, ['--system-prompt', '--profile=headless', 'task']);
});

test('headless rejects equals-mode unsupported by Pi and repeated conflicting modes', () => {
  assert.throws(() => buildPiInvocation(['--profile=headless', '--mode=json', 'task'], '/pi.js'), /--mode json/);
  assert.throws(() => buildPiInvocation(['--profile=headless', '--mode', 'json', '--mode', 'rpc', 'task'], '/pi.js'), /json/);
  assert.deepEqual(buildPiInvocation(['--profile=headless', '--system-prompt', '--mode', 'task'], '/pi.js').args, ['--print', '--mode', 'json', '--system-prompt', '--mode', 'task']);
});

test('dry-run CLI resolves real pinned Pi without invoking a provider', {skip: !existsSync('node_modules/@earendil-works/pi-coding-agent')}, () => {
  const result = spawnSync(process.execPath, ['bin/apex', '--apex-dry-run', '--apex-off', '--profile', 'headless', 'hello'], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const invocation = JSON.parse(result.stdout);
  assert.equal(invocation.pi_version, '0.99.2');
  assert.deepEqual(invocation.args, ['--print', '--mode', 'json', 'hello']);
});

test('Phase 1 prefix selects individual flags and exact Muse/xhigh without changing prompt words', () => {
  const invocation=buildPiInvocation(['--apex-context','read,shape','--profile','headless','--','--apex-context','all'],'/pi.js');
  assert.ok(invocation.args.includes('--apex-context-flags'));
  assert.equal(invocation.args[invocation.args.indexOf('--apex-context-flags')+1],'read,shape');
  assert.equal(invocation.args[invocation.args.indexOf('--model')+1],'openrouter/meta/muse-spark-1.3-contributor');
  assert.equal(invocation.args[invocation.args.indexOf('--thinking')+1],'xhigh');
  assert.deepEqual(invocation.args.slice(-3),['--','--apex-context','all']);
});
test('Phase 1 rejects wrong models, route thinking, unknown and repeated feature options before Pi', () => {
  for(const args of [['--apex-context','unknown'],['--apex-context','shape','--apex-context','read'],
    ['--apex-context','read','--model','other/model'],['--apex-context','route','--thinking','low'],
    ['--apex-context','read','--provider','other']]) assert.throws(()=>buildPiInvocation(args,'/pi.js'));
  const low=buildPiInvocation(['--apex-context','read','--thinking','low','task'],'/pi.js').args;
  assert.equal(low[low.indexOf('--thinking')+1],'low');
  assert.deepEqual(buildPiInvocation(['--system-prompt','--apex-context','all'],'/pi.js').args,['--system-prompt','--apex-context','all']);
});
test('route selection loads its model before Pi selection and still keeps physical policy', () => {
  const args=buildPiInvocation(['--apex-context=route','task'],'/pi.js').args;
  assert.equal(args[args.indexOf('--model')+1],'apex/auto');
  const explicit=buildPiInvocation(['--apex-context=route','--model','meta/muse-spark-1.3-contributor','--provider','openrouter','task'],'/pi.js').args;
  assert.equal(explicit[explicit.indexOf('--model')+1],'apex/auto');
  assert.equal(explicit[explicit.indexOf('--provider')+1],'apex');
});
