import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createLearnings} from '../extensions/apex-features/learnings.mjs';
import {directoryLink, fileLink} from './fixtures/filesystem.mjs';
async function fixture(t){const cwd=await mkdtemp(path.join(process.cwd(),'tests/.learnings-fixture-'));t.after(()=>rm(cwd,{recursive:true,force:true}));return cwd;}
test('learnings are deferred, explicit, literal and supply a detached context file',async t=>{
 const cwd=await fixture(t);await writeFile(path.join(cwd,'AGENTS.md'),'existing context');const store=createLearnings({cwd,evalMode:false});assert.equal(store.tool().name,'remember');assert.equal(store.tool().exposure,'deferred');
 const fact='Use `literal` and $(never execute)\nKeep the follow-up.';const result=await store.tool().execute('r',{fact},undefined,undefined,{cwd});assert.equal(result.isError,undefined);assert.equal(result.structuredContent.ok,true);const loaded=await store.load();assert.equal(loaded.ok,true);assert.equal(loaded.path,path.join(cwd,'.apex','LEARNINGS.md'));assert.match(loaded.content,/Use `literal` and \$\(never execute\)/);assert.match(loaded.content,/Keep the follow-up/);assert.equal(await readFile(path.join(cwd,'AGENTS.md'),'utf8'),'existing context');loaded.content='changed';assert.notEqual((await store.load()).content,'changed');
});
test('eval denial happens before filesystem access and tool callbacks',async()=>{
 const options={evalMode:true,get cwd(){assert.fail('disabled cwd read');}};const store=createLearnings(options);assert.equal((await store.load()).ok,false);assert.equal((await store.append('fact')).ok,false);const result=await store.tool().execute('x',{get fact(){assert.fail('disabled tool parameter read');}},undefined);assert.equal(result.isError,true);assert.match(result.structuredContent.reason,/eval/i);
});
test('concurrent appends across instances serialize without lost facts or duplicate facts',async t=>{
 const cwd=await fixture(t);const a=createLearnings({cwd}),b=createLearnings({cwd});const results=await Promise.all(Array.from({length:16},(_,i)=>(i%2?a:b).append(`fact ${i}`)));assert.equal(results.every(r=>r.ok),true);await Promise.all([a.append('one duplicate'),b.append('one duplicate')]);const content=(await a.load()).content;for(let i=0;i<16;i++)assert.equal(content.includes(`- fact ${i}\n`),true);assert.equal(content.match(/- one duplicate/g).length,1);
});
test('missing load creates no files, malformed/oversized facts and abort are refused',async t=>{
 const cwd=await fixture(t);const store=createLearnings({cwd});assert.equal((await store.load()).content,'');await assert.rejects(readFile(path.join(cwd,'.apex','LEARNINGS.md')),{code:'ENOENT'});for(const fact of ['',null,'a'.repeat(5000),'nul\0fact'])assert.equal((await store.append(fact)).ok,false);
 const controller=new AbortController();controller.abort();const result=await store.tool().execute('x',{fact:'blocked'},controller.signal);assert.equal(result.isError,true);assert.equal((await store.load()).content,'');
});
test('directory/file symlinks and oversized existing content are refused',async t=>{
 const cwd=await fixture(t);const outside=path.join(cwd,'outside');await mkdir(outside);await directoryLink(outside,path.join(cwd,'.apex'));const store=createLearnings({cwd});assert.equal((await store.append('blocked')).ok,false);assert.equal((await store.load()).ok,false);await rm(path.join(cwd,'.apex'));await mkdir(path.join(cwd,'.apex'));
 await t.test('file symlink refused without changing target',async t=>{
  const protectedFile=path.join(outside,'protected');await writeFile(protectedFile,'protected');
  if(!await fileLink(t,protectedFile,path.join(cwd,'.apex','LEARNINGS.md')))return;
  assert.equal((await store.append('blocked')).ok,false);assert.equal((await store.load()).ok,false);assert.equal(await readFile(protectedFile,'utf8'),'protected');await rm(path.join(cwd,'.apex','LEARNINGS.md'));
 });
 await writeFile(path.join(cwd,'.apex','LEARNINGS.md'),'a'.repeat(70000));assert.equal((await store.append('blocked')).ok,false);assert.equal((await store.load()).ok,false);
});
test('fact count/UTF8 byte caps are enforced for append and load',async t=>{
 const cwd=await fixture(t);const store=createLearnings({cwd});assert.equal((await store.append('é'.repeat(513))).ok,false);await mkdir(path.join(cwd,'.apex'));await writeFile(path.join(cwd,'.apex','LEARNINGS.md'),'# Apex learnings\n\n'+Array.from({length:128},(_,i)=>`- fact ${i}\n`).join(''));assert.equal((await store.append('new fact')).ok,false);assert.equal((await store.load()).ok,true);await writeFile(path.join(cwd,'.apex','LEARNINGS.md'),Array.from({length:129},(_,i)=>`- fact ${i}\n`).join(''));assert.equal((await store.load()).ok,false);
});
