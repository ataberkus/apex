/** Explicit project facts. Eval mode is rejected before resolving cwd, parameters or files. */
import path from 'node:path';
import {constants} from 'node:fs';
import {lstat,mkdir,open,realpath,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ensureWindowsPrivateApex} from '../../lib/windows-private-storage.mjs';

const queues=new Map();
const MAX_BYTES=32768;
const MAX_FACT_BYTES=1024;
const MAX_FACTS=128;
const HEADER='# Apex learnings\n\n';
const disabled={ok:false,reason:'Project learnings are disabled in eval mode.'};
const reasonOf=error=>String(error?.message??error).slice(0,1000);
function abort(signal){if(signal?.aborted)throw Error('Remember operation aborted.');}
async function location(cwd,{create=false}={}){
 if(typeof cwd!=='string'||!path.isAbsolute(cwd))throw Error('Learnings cwd must be an absolute path.');
 const root=await realpath(cwd);const directory=path.join(root,'.apex');
 try{const info=await lstat(directory);if(info.isSymbolicLink()||!info.isDirectory())throw Error('Learnings directory must be a real directory, not a symbolic link.');}
 catch(error){if(error.code!=='ENOENT')throw error;if(!create)return {root,directory,file:path.join(directory,'LEARNINGS.md'),missing:true};if(process.platform!=='win32')await mkdir(directory,{mode:0o700});}
 if(create&&process.platform==='win32')await ensureWindowsPrivateApex(root);
 if(await realpath(directory)!==directory)throw Error('Learnings directory is outside the project.');
 const info=await lstat(directory);
 return {root,directory,file:path.join(directory,'LEARNINGS.md'),identity:{dev:info.dev,ino:info.ino}};
}
async function read(location){
 if(location.missing)return '';
 let handle;
 try{
  const info=await lstat(location.file);if(info.isSymbolicLink()||!info.isFile())throw Error('Learnings must be a regular file, not a symbolic link.');
  handle=await open(location.file,constants.O_RDONLY|constants.O_NONBLOCK|(constants.O_NOFOLLOW??0));const current=await handle.stat();
  if(!current.isFile()||current.size>MAX_BYTES)throw Error('Learnings exceed the bounded 32 KiB context limit.');
  const bytes=Buffer.alloc(current.size+1);const {bytesRead}=await handle.read(bytes,0,bytes.length,0);if(bytesRead>MAX_BYTES)throw Error('Learnings exceed the bounded 32 KiB context limit.');
  const content=bytes.subarray(0,bytesRead).toString('utf8');if(content.includes('\0'))throw Error('Learnings must contain text without NUL.');return content;
 }catch(error){if(error.code==='ENOENT')return '';throw error;}finally{await handle?.close();}
}
async function write(location,content,previous,signal){
 const temporary=path.join(location.directory,`.learnings-${randomUUID()}.tmp`);let handle;
 try{
  handle=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);await handle.writeFile(content,'utf8');await handle.sync();await handle.close();handle=undefined;abort(signal);
  const info=await lstat(location.directory);if(info.isSymbolicLink()||info.dev!==location.identity.dev||info.ino!==location.identity.ino||await realpath(location.directory)!==location.directory)throw Error('Learnings directory changed during append.');
  if(await read(location)!==previous)throw Error('Learnings changed during append; refusing to overwrite a concurrent change.');
  await rename(temporary,location.file);
 }finally{await handle?.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
function serial(key,operation){const previous=queues.get(key)??Promise.resolve();const next=previous.catch(()=>{}).then(operation);queues.set(key,next);return next.finally(()=>{if(queues.get(key)===next)queues.delete(key);});}
function toolResult(result){return {content:[{type:'text',text:result.ok?(result.duplicate?'Fact was already recorded.':'Project fact recorded.'):result.reason}],structuredContent:result,details:result,...(result.ok?{}:{isError:true})};}

export function createLearnings(options={}){
 const evalMode=options.evalMode===true;
 const append=(fact,signal)=>{
  if(evalMode)return Promise.resolve({...disabled});
  try{
   abort(signal);if(typeof fact!=='string'||!fact.trim()||Buffer.byteLength(fact)>MAX_FACT_BYTES||fact.includes('\0'))throw Error('Fact must be nonempty text of at most 1024 bytes without NUL.');
   const cwd=options.cwd;const key=path.resolve(cwd);const normalized=fact.replace(/\r\n/g,'\n').trim();
   return serial(key,async()=>{
    try{
     abort(signal);const target=await location(cwd,{create:true});abort(signal);const previous=await read(target);
     const bullet='- '+normalized.replace(/\n/g,'\n  ')+'\n';
     const facts=previous.match(/^- /gm)??[];
     if(previous.split(/(?=^- )/m).some(item=>item===bullet))return {ok:true,path:target.file,duplicate:true};
     if(facts.length>=MAX_FACTS)throw Error('Learnings are bounded to 128 facts.');
     const content=(previous||HEADER)+(previous&&!previous.endsWith('\n')?'\n':'')+bullet;
     if(Buffer.byteLength(content)>MAX_BYTES)throw Error('Learnings exceed the bounded 32 KiB context limit.');abort(signal);await write(target,content,previous,signal);return {ok:true,path:target.file};
    }catch(error){return {ok:false,reason:reasonOf(error)};}
   });
  }catch(error){return Promise.resolve({ok:false,reason:reasonOf(error)});}
 };
 return {
  append,
  async load(){
   if(evalMode)return {...disabled};
   try{const target=await location(options.cwd);const content=await read(target);if((content.match(/^- /gm)??[]).length>MAX_FACTS)throw Error('Learnings are bounded to 128 facts.');return {ok:true,path:target.file,content};}
   catch(error){return {ok:false,reason:reasonOf(error)};}
  },
  tool(){return {name:'remember',label:'Remember project fact',exposure:'deferred',executionMode:'sequential',description:'Explicitly record one bounded project fact in .apex/LEARNINGS.md for future selected project context. Never modifies AGENTS.md. Disabled before filesystem access in eval mode.',annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},parameters:{type:'object',properties:{fact:{type:'string',minLength:1,maxLength:1024}},required:['fact'],additionalProperties:false},
   async execute(_id,params,signal){if(evalMode)return toolResult({...disabled});return toolResult(await append(params?.fact,signal));},
  };},
 };
}
