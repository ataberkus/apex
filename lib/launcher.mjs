import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContextFlags, SELECTED_MODEL } from '../extensions/apex-context/config.mjs';
import {parseFeatureFlags} from '../extensions/apex-features/config.mjs';
import {parseCoreFlags,parseTimeBudget,parseAttempts,runtimePolicy} from '../extensions/apex-core/config.mjs';
import {assertWindowsTarget, windowsScope, WINDOWS_MODEL} from './windows-target.mjs';

export const PI_VERSION = '0.99.2';

export function resolvePi() {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const root = path.resolve(path.dirname(entry), '..');
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.version !== PI_VERSION) {
    throw new Error(`Apex requires Pi ${PI_VERSION}; found ${manifest.version}. Run the upgrade checks first.`);
  }
  return {cli: path.join(root, manifest.bin.pi), version: manifest.version};
}

export function buildPiInvocation(args, cli, {platform = process.platform} = {}) {
  let profile = 'default', target;
  let features=[];
  let contextSelected=false;
  let coreFeatures=[],coreSelected=false,timeBudget,attempts;
  let dailyFeatures=[],evalMode=false;
  const owned=new Set(['--profile','--apex-target','--apex-context','--apex-core','--time-budget','--apex-attempts','--apex-features','--apex-eval']);
  const supplied=new Set();
  let cursor = 0;
  // Apex owns only the prefix; Pi option values and task text are never scanned for Apex flags.
  while (owned.has(args[cursor]?.split('=')[0])) {
    const option=args[cursor].split('=')[0],equals=args[cursor].includes('=');
    if(supplied.has(option))throw new Error('Repeated '+option+' option');
    supplied.add(option);
    if(option==='--apex-eval'){if(equals)throw Error('--apex-eval is a boolean switch');evalMode=true;cursor++;continue;}
    const value=equals?args[cursor].slice(option.length+1):args[cursor+1];
    if(!value||value.startsWith('--'))throw new Error(option+' needs a value');
    if(option==='--apex-target'){
      if(value!=='windows')throw new Error('--apex-target supports only windows; omit it for the original benchmark selection.');
      target=value;
    }
    else if(option==='--apex-context'){contextSelected=true;features=parseContextFlags(value);}
    else if(option==='--apex-core'){coreSelected=true;coreFeatures=parseCoreFlags(value);}
    else if(option==='--apex-features')dailyFeatures=parseFeatureFlags(value);
    else if(option==='--time-budget')timeBudget=parseTimeBudget(value);
    else if(option==='--apex-attempts')attempts=parseAttempts(value);
    else profile=value;
    cursor+=equals?1:2;
  }
  const forwarded = args.slice(cursor);
  if(target==='windows')assertWindowsTarget({platform,context:features,core:coreFeatures});
  if(timeBudget!==undefined&&!coreFeatures.includes('time'))throw new Error('--time-budget requires the time core feature');
  if(attempts!==undefined&&!coreFeatures.includes('max'))throw new Error('--apex-attempts requires the max core feature');
  if(coreFeatures.includes('max')&&profile!=='max')throw new Error('The max feature requires the separate max profile');
  if (profile === 'max') {
    if(!coreFeatures.includes('max'))throw new Error('max profile is not implemented without explicit --apex-core max');
    if(!runtimePolicy().paid_runs_enabled)throw new Error('max profile is disabled by the free-only offline policy');
  }
  if (!['default', 'headless'].includes(profile)) throw new Error(`Unknown profile: ${profile}`);
  const valueOptions = new Set(['--provider', '--model', '--api-key', '--system-prompt', '--append-system-prompt',
    '--name', '-n', '--session', '--session-id', '--fork', '--session-dir', '--models', '--tools', '-t',
    '--exclude-tools', '-xt', '--thinking', '--export', '--extension', '-e', '--skill', '--prompt-template',
    '--theme', '--use-theme', '--tui-mode', '--apex-context-flags','--apex-feature-flags','--apex-core-flags','--apex-time-budget','--apex-attempts']);
  if (target==='windows'||features.length||coreFeatures.length||dailyFeatures.length||evalMode) {
    const selected={};
    const selectedIndexes={};
    let modelsScope;
    for(let i=0;i<forwarded.length;i++) {
      const arg=forwarded[i];
      if(arg==='--') break;
      if(valueOptions.has(arg)) {
        if(target==='windows'&&arg==='--api-key')throw new Error('The Windows target uses saved logins, not an API-key override.');
        if(target==='windows'&&arg==='--models'){if(modelsScope!==undefined)throw new Error('Repeated --models option');modelsScope=forwarded[i+1]??'';}
        if (['--model','--provider','--thinking'].includes(arg)) {
          if(selected[arg]!==undefined) throw new Error('Repeated model/thinking selection');
          selected[arg]=forwarded[i+1];
          selectedIndexes[arg]=i+1;
          if(!selected[arg]) throw new Error(arg+' needs a value');
        }
        i++;continue;
      }
      if(target==='windows'&&/^--(?:model|provider|thinking|models|api-key)=/.test(arg))throw new Error('Use separate Pi model option values, not equals-form arguments.');
      if(arg==='--print'||arg==='-p'||arg==='--list-models'||arg==='--mode'||
        (arg.startsWith('--')&&!arg.includes('='))) {
        const next=forwarded[i+1];
        if(next!==undefined&&!next.startsWith('@')&&(!next.startsWith('-')||next.startsWith('---')))i++;
      }
    }
    const route=features.includes('route');
    const model=selected['--model'];
    if(target==='windows') {
      const scope=windowsScope(selected['--provider'],model);
      if(modelsScope!==undefined&&modelsScope!==scope)throw new Error('The Windows target model scope must be exactly '+scope);
    } else {
      const allowedModels=[SELECTED_MODEL,'meta/muse-spark-1.3-contributor',...(route?['apex/auto']:[])];
      if(model!==undefined&&!allowedModels.includes(model))throw new Error('Apex experiments are restricted to the selected Muse model');
      const expectedProvider=model==='apex/auto'?'apex':'openrouter';
      if(selected['--provider']!==undefined&&selected['--provider']!==expectedProvider) throw new Error('Apex provider selection conflicts with the model policy');
    }
    const effectiveModel=route?'apex/auto':(model??(target==='windows'?WINDOWS_MODEL:SELECTED_MODEL));
    if(selected['--thinking']!==undefined&&selected['--thinking']!=='xhigh') throw new Error('Apex thinking policy is xhigh');
    if(route) {
      if(selectedIndexes['--model']!==undefined)forwarded[selectedIndexes['--model']]='apex/auto';
      if(selectedIndexes['--provider']!==undefined)forwarded[selectedIndexes['--provider']]='apex';
    }
    const prefix=[];
    if(features.length)prefix.push('--extension',fileURLToPath(new URL('../extensions/apex-context/index.mjs',import.meta.url)),
      '--apex-context-flags',features.join(','));
    if(coreFeatures.length)prefix.push('--extension',fileURLToPath(new URL('../extensions/apex-core/index.mjs',import.meta.url)),
      '--apex-core-flags',coreFeatures.join(','));
    if(dailyFeatures.length||evalMode)prefix.push('--extension',fileURLToPath(new URL('../extensions/apex-features/index.mjs',import.meta.url)),
      '--apex-feature-flags',dailyFeatures.join(','));
    if(evalMode)prefix.push('--apex-eval=true');
    if(timeBudget!==undefined)prefix.push('--apex-time-budget',String(timeBudget));
    if(route)prefix.push('--extension',fileURLToPath(new URL('../extensions/apex-router/index.mjs',import.meta.url)));
    if(target==='windows'&&selected['--provider']===undefined)prefix.push('--provider','openai-codex');
    if(model===undefined)prefix.push('--model',effectiveModel);
    if(selected['--thinking']===undefined)prefix.push('--thinking','xhigh');
    forwarded.unshift(...prefix);
  }
  if (profile === 'headless') {
    // Value arity follows pinned Pi's cli/args.js, including --print's optional prompt.
    let hasPrint = false;
    let hasMode = false;
    for (let i = 0; i < forwarded.length; i++) {
      const arg = forwarded[i];
      if (arg === '--') break;
      if (valueOptions.has(arg)) { if (i + 1 < forwarded.length) i++; continue; }
      if (arg === '--mode') {
        if (forwarded[i + 1] !== 'json') throw new Error('headless profile requires --mode json');
        hasMode = true;
        i++;
      } else if (arg.startsWith('--mode=')) {
        throw new Error('Pi requires --mode json, not an equals-mode argument');
      } else if (arg === '--print' || arg === '-p') {
        hasPrint = true;
        const next = forwarded[i + 1];
        if (next !== undefined && !next.startsWith('@') && (!next.startsWith('-') || next.startsWith('---'))) i++;
      } else if (arg === '--list-models' || (arg.startsWith('--') && !arg.includes('='))) {
        const next = forwarded[i + 1];
        if (next !== undefined && !next.startsWith('-') && !next.startsWith('@')) i++;
      }
    }
    const prefix = [];
    if (!hasPrint) prefix.push('--print');
    if (!hasMode) prefix.push('--mode', 'json');
    forwarded.unshift(...prefix);
  }
  return {cli, args: forwarded, ...(target?{target}: {})};
}
