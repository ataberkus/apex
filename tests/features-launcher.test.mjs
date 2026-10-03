import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {buildPiInvocation} from '../lib/launcher.mjs';
import {FEATURE_FEATURES,parseFeatureFlags} from '../extensions/apex-features/config.mjs';
import {parseLocalCommand} from '../lib/commands.mjs';

test('nine Phase 3 flags are default off and strictly parsed',()=>{
 assert.equal(FEATURE_FEATURES.length,10);assert.deepEqual(parseFeatureFlags(),[]);
 assert.deepEqual(parseFeatureFlags('all'),FEATURE_FEATURES);
 for(const v of ['cost,cost','unknown',' cost',null,[]])assert.throws(()=>parseFeatureFlags(v));
});
test('Phase 3 prefix loads native extension and explicit eval without eating task',()=>{
 const args=buildPiInvocation(['--apex-features','cost,skills','--apex-eval','--profile','headless','task'],'/pi.js').args;
 assert.ok(args.some(s=>s.endsWith(path.join('apex-features','index.mjs'))));
 assert.equal(args[args.indexOf('--apex-feature-flags')+1],'cost,skills');
 assert.equal(args[args.indexOf('--model')+1],'openrouter/meta/muse-spark-1.3-contributor');
 assert.equal(args[args.indexOf('--thinking')+1],'xhigh');assert.equal(args.at(-1),'task');
 assert.ok(args.includes('--apex-eval=true'));
});
test('combined extensions retain context core features order and route',()=>{
 const args=buildPiInvocation(['--apex-context','route','--apex-core','todo','--apex-features','plan','task'],'/pi.js').args;
 const ex=args.filter(s=>path.basename(s)==='index.mjs');
 assert.match(ex[0],/apex-context/);assert.match(ex[1],/apex-core/);assert.match(ex[2],/apex-features/);
 assert.equal(args[args.indexOf('--model')+1],'apex/auto');
});
test('Phase 3 default forwards and selected variants reject model overrides',()=>{
 assert.deepEqual(buildPiInvocation(['--','--apex-features','all'],'x').args,['--','--apex-features','all']);
 assert.deepEqual(buildPiInvocation(['--system-prompt','--apex-features','all'],'x').args,['--system-prompt','--apex-features','all']);
 for(const a of [['--apex-features','cost','--model','other/model'],['--apex-features','cost','--apex-eval','--thinking','low'],['--apex-features','cost','--apex-features','report'],['--apex-features','cost','--apex-eval=true']])assert.throws(()=>buildPiInvocation(a,'x'));
 const low=buildPiInvocation(['--apex-features','cost','--thinking','low','task'],'x').args;
 assert.equal(low[low.indexOf('--thinking')+1],'low');
});
test('report and resume are exact local verbs with bounded literal option parser',()=>{
 assert.equal(parseLocalCommand(['--print','report']),null);
 assert.deepEqual(parseLocalCommand(['report','/some literal $(x).jsonl','--json']),{kind:'report',file:'/some literal $(x).jsonl',json:true});
 assert.deepEqual(parseLocalCommand(['resume','/x','--apex-dry-run']),{kind:'resume',file:'/x',dryRun:true});
 for(const a of [['report'],['report','x','--key'],['report','x','--json','--json'],['resume','x','--json'],['report','--json']])assert.throws(()=>parseLocalCommand(a));
});
test('actual resume free-policy denial precedes file or Pi resolution',()=>{
 const p=spawnSync(process.execPath,['bin/apex','resume','/not-present.jsonl'],{encoding:'utf8'});
 assert.equal(p.status,1);assert.match(p.stderr,/offline-only/);assert.doesNotMatch(p.stderr,/ENOENT/);
});

test('native Pi argument parser retains prompt after eval boolean with explicit model',async()=>{
 const {parseArgs}=await import('../node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js');
 const args=buildPiInvocation(['--apex-features','cost','--apex-eval','task','--model','openrouter/meta/muse-spark-1.3-contributor','--thinking','xhigh'],'/pi.js').args;
 const parsed=parseArgs(args);assert.deepEqual(parsed.messages,['task']);assert.equal(parsed.unknownFlags.get('apex-eval'),'true');
});
