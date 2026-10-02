import {mkdtemp,mkdir,lstat,chmod,writeFile,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import {SELECTED_MODEL} from '../extensions/apex-core/config.mjs';
import {recoverySettings} from '../extensions/apex-core/models.mjs';

/** A native CLI settings profile, allocated only after future explicit paid authorization. */
export async function createRecoveryProfile({policy,cwd,settings={},env={}}={}) {
  if(policy?.paid_runs_enabled!==true||policy.execution_policy!=='paid-enabled')throw new Error('Recovery launch is disabled by the free-only offline policy');
  if(policy.allowed_model!==SELECTED_MODEL||policy.thinking_level!=='xhigh')throw new Error('Recovery requires exact Muse/xhigh');
  if(typeof cwd!=='string'||!path.isAbsolute(cwd))throw new Error('Recovery cwd must be absolute');
  const root=await realpath(cwd);
  for(const key of Object.keys(settings))if(!['compaction','cacheWarming','defaultProjectTrust','quietStartup'].includes(key))throw new Error('Unsupported recovery profile setting: '+key);
  for(const directory of [path.join(root,'.apex'),path.join(root,'.apex/runtime')]) {
    let created=false;
    try{await mkdir(directory,{mode:0o700});created=true;}catch(error){if(error.code!=='EEXIST')throw error;}
    const info=await lstat(directory);
    if(!info.isDirectory()||info.isSymbolicLink()||typeof process.getuid==='function'&&info.uid!==process.getuid())throw new Error('Recovery directory must be an owned nonsymlink directory');
    if(created)await chmod(directory,0o700);
    else if(info.mode&0o077)throw new Error('Recovery directory must be private');
  }
  const agentDir=await mkdtemp(path.join(root,'.apex/runtime/recovery-'));
  await chmod(agentDir,0o700);
  const info=await lstat(agentDir);
  let cleaned=false;
  const cleanup=async()=>{
    if(cleaned)return;
    try{
      const current=await lstat(agentDir);
      if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==info.dev||current.ino!==info.ino)throw new Error('Recovery profile ownership changed; refusing cleanup');
      await rm(agentDir,{recursive:true});cleaned=true;
    }catch(error){if(error.code==='ENOENT'){cleaned=true;return;}throw error;}
  };
  try{
    const profile={...settings,...recoverySettings({policy}),cacheWarming:'off',defaultProvider:'openrouter',
      defaultModel:'meta/muse-spark-1.3-contributor',defaultThinkingLevel:'xhigh'};
    await writeFile(path.join(agentDir,'settings.json'),JSON.stringify(profile)+'\n',{mode:0o600,flag:'wx'});
    await chmod(path.join(agentDir,'settings.json'),0o600);
    return {agentDir,env:{...env,PI_CODING_AGENT_DIR:agentDir},cleanup};
  }catch(error){await cleanup();throw error;}
}
