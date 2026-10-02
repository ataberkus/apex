import {existsSync, realpathSync} from 'node:fs';
import path from 'node:path';

/** Native daily-driver selection, separate from the frozen Harbor/Muse policy. */
export const WINDOWS_MODEL = 'openai-codex/gpt-6.1-sol';
// Providers the dashboard signs in to: ChatGPT and Claude subscriptions through OAuth, OpenCode Go through a saved key.
export const WINDOWS_PROVIDERS = Object.freeze(['openai-codex', 'anthropic', 'opencode-go']);
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*$/i;
export const WINDOWS_UNAVAILABLE = Object.freeze({
  context: Object.freeze(['route', 'output']), // These policies are Muse-specific.
  core: Object.freeze(['bg', 'max', 'recovery']),
});
export const WINDOWS_DEFERRED = Object.freeze([
  'Harbor/Terminal-Bench and two-model performance acceptance',
  'OCI proposer execution and container-backed evolution',
  'Unix owned-process survival and process-group cleanup',
]);
// Everything that works on Windows/Sol without prompts or policy-denied model calls. Left out: safety (asks on every
// write/shell call), compact (cancels, which disables Pi's own compaction), subagents/review (model calls denied).
export const WINDOWS_AUTO = Object.freeze({
  context: 'cache,shape,mask,read,search,edit,patch,lazy',
  core: 'snapshot,entrypoints,contract,todo,verify,loops,correct,diagnostics',
  features: 'cost,plan,remember,skills,report,resume',
});
const SELECTION = new Set(['--apex-target', '--apex-context', '--apex-core', '--apex-features', '--apex-eval']);
const PREFIX = new Set([...SELECTION, '--profile', '--time-budget', '--apex-attempts']);

/** Bare `apex` on native Windows gets WINDOWS_AUTO; any explicit selection is kept as-is; `--apex-off` runs stock Pi. */
export function withWindowsDefaults(args, {platform = process.platform, cwd = process.cwd()} = {}) {
  if (args[0] === '--apex-off') return args.slice(1);
  if (platform !== 'win32') return args;
  let profile;
  for (let i = 0; PREFIX.has(args[i]?.split('=')[0]);) {
    const [option, inline] = args[i].split(/=(.*)/s);
    if (SELECTION.has(option)) return args;
    if (option === '--profile') profile = inline ?? args[i + 1];
    i += inline !== undefined ? 1 : 2;
  }
  const root = path.resolve(cwd);
  // Checkpoints block every mutation without root Git metadata, a canonical path, or past Git's Windows path limit.
  let checkpoints = root.length <= 156 && ['.git', 'version-control'].some(dir => existsSync(path.join(root, dir, 'HEAD')));
  try { checkpoints &&= realpathSync(root) === root; } catch { checkpoints = false; }
  return ['--apex-target', 'windows', '--apex-context', WINDOWS_AUTO.context,
    '--apex-core', WINDOWS_AUTO.core + (profile === 'headless' ? ',headless' : ''),
    '--apex-features', WINDOWS_AUTO.features + (checkpoints ? ',checkpoints' : ''), ...args];
}

/** Exact Sol by default. Another model needs an explicit login provider and a plain catalog id: no fallbacks, no `:thinking`. */
export function windowsScope(provider, model) {
  if (provider === undefined || (provider === 'openai-codex' && model === undefined)) {
    if (![undefined, WINDOWS_MODEL, 'gpt-6.1-sol'].includes(model)) throw new Error('The Windows target defaults to exact Sol. Pass --provider to choose another signed-in model.');
    return WINDOWS_MODEL;
  }
  if (!WINDOWS_PROVIDERS.includes(provider)) throw new Error(`The Windows target runs only ${WINDOWS_PROVIDERS.join(', ')} through saved logins.`);
  if (provider === 'openai-codex' && model === WINDOWS_MODEL) return WINDOWS_MODEL;
  if (model === undefined || !MODEL_ID.test(model)) throw new Error(`Name one ${provider} model by its plain catalog id.`);
  return `${provider}/${model}`;
}

export function assertWindowsTarget({platform = process.platform, context = [], core = []} = {}) {
  if (platform !== 'win32') throw new Error('The Windows target requires native Windows Node, not WSL.');
  for (const [group, selected] of [['context', context], ['core', core]]) {
    const unavailable = selected.filter(name => WINDOWS_UNAVAILABLE[group].includes(name));
    if (unavailable.length) throw new Error(`Unavailable in the Windows target: ${group} ${unavailable.join(',')}. Select supported flags explicitly instead of all.`);
  }
}
