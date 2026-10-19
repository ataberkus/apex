import {existsSync, realpathSync} from 'node:fs';
import path from 'node:path';

/** Native daily-driver selection, separate from the frozen Harbor/Muse policy. */
export const WINDOWS_PROVIDER = 'anthropic';
export const WINDOWS_MODEL_ID = 'claude-opus-5-5';
export const WINDOWS_MODEL = `${WINDOWS_PROVIDER}/${WINDOWS_MODEL_ID}`;
// Default level for any Windows-target model; eval isolation (and the Muse-only route) stay at xhigh.
export const WINDOWS_THINKING = 'medium';
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
// Only features that add no prompt section, tool or continuation: the cache ledger, user commands, late compaction,
// checkpoints, and `correct` (cwd-confined paths, edit pre-checks, and a TUI confirmation before catastrophic shell
// commands). Not invisible: `correct` changes failing tool results, checkpoints leave `.apex/` in the workspace and
// autocompact summarizes past 300k tokens. ab-002 measured the earlier everything-supported set at ×2.1 cost and ×2.3
// wall time against stock Pi with no pass-rate gain, so the rest is opt-in through explicit selection. `--profile headless`
// adds nothing here: core `headless`'s prompt section cost ×1.10–×1.28 on Sol with no measured behavior change (ab-008, ab-010).
export const WINDOWS_AUTO = Object.freeze({
  context: 'cache',
  core: 'correct',
  features: 'cost,plan,report,resume,autocompact',
});
const SELECTION = new Set(['--apex-context', '--apex-core', '--apex-features']);
const KEPT = new Set(['--apex-target', '--apex-eval']);
const PREFIX = new Set([...SELECTION, ...KEPT, '--profile', '--time-budget', '--autocompact-tokens', '--apex-attempts', '--apex-pair']);
// The frozen benchmark policy's own models. Naming one keeps an explicit selection off the Windows target.
const MUSE_PROVIDERS = new Set(['openrouter', 'apex']);
const MUSE_MODELS = new Set(['meta/muse-spark-1.3-contributor', 'openrouter/meta/muse-spark-1.3-contributor', 'apex/auto']);

/**
 * Bare `apex` on native Windows gets WINDOWS_AUTO. An explicit feature selection replaces it and still runs on the Windows
 * target unless it names a Muse model; `--apex-target` and `--apex-eval` invocations pass unchanged. `--apex-off` runs stock Pi.
 */
export function withWindowsDefaults(args, {platform = process.platform, cwd = process.cwd()} = {}) {
  if (args[0] === '--apex-off') return args.slice(1);
  if (platform !== 'win32') return args;
  let selected = false, i = 0;
  while (PREFIX.has(args[i]?.split('=')[0])) {
    const [option, inline] = args[i].split(/=(.*)/s);
    if (KEPT.has(option)) return args;
    selected ||= SELECTION.has(option);
    i += inline !== undefined ? 1 : 2;
  }
  if (selected) return namesMuse(args.slice(i)) ? args : ['--apex-target', 'windows', ...args];
  return ['--apex-target', 'windows', '--apex-context', WINDOWS_AUTO.context,
    '--apex-core', WINDOWS_AUTO.core,
    '--apex-features', WINDOWS_AUTO.features + (checkpointsUsable(cwd) ? ',checkpoints' : ''), ...args];
}

function namesMuse(args) {
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    if (args[i] === '--provider' && MUSE_PROVIDERS.has(args[i + 1])) return true;
    if (args[i] === '--model' && MUSE_MODELS.has(args[i + 1])) return true;
  }
  return false;
}

/** Checkpoints block every mutation without root Git metadata, a canonical path, or past Git's Windows path limit. */
export function checkpointsUsable(cwd) {
  const root = path.resolve(cwd);
  if (root.length > 156 || !['.git', 'version-control'].some(dir => existsSync(path.join(root, dir, 'HEAD')))) return false;
  try { return realpathSync(root) === root; } catch { return false; }
}

/** Exact Claude Opus 5.5 by default. Another model needs an explicit login provider and a plain catalog id: no fallbacks, no `:thinking`. */
export function windowsScope(provider, model) {
  if (provider === undefined || (provider === WINDOWS_PROVIDER && model === undefined)) {
    if (![undefined, WINDOWS_MODEL, WINDOWS_MODEL_ID].includes(model)) throw new Error('The Windows target defaults to exact Claude Opus 5.5. Pass --provider to choose another signed-in model.');
    return WINDOWS_MODEL;
  }
  if (!WINDOWS_PROVIDERS.includes(provider)) throw new Error(`The Windows target runs only ${WINDOWS_PROVIDERS.join(', ')} through saved logins.`);
  if (provider === WINDOWS_PROVIDER && model === WINDOWS_MODEL) return WINDOWS_MODEL;
  if (model === undefined || !MODEL_ID.test(model)) throw new Error(`Name one ${provider} model by its plain catalog id.`);
  return `${provider}/${model}`;
}

/** Both pair models run on saved logins, like a single Windows model. */
export function assertWindowsPair(pair) {
  for (const slot of [pair.plan, pair.build]) if (!WINDOWS_PROVIDERS.includes(slot.provider)) throw new Error(`The Windows target runs only ${WINDOWS_PROVIDERS.join(', ')} through saved logins.`);
}

export function assertWindowsTarget({platform = process.platform, context = [], core = []} = {}) {
  if (platform !== 'win32') throw new Error('The Windows target requires native Windows Node, not WSL.');
  for (const [group, selected] of [['context', context], ['core', core]]) {
    const unavailable = selected.filter(name => WINDOWS_UNAVAILABLE[group].includes(name));
    if (unavailable.length) throw new Error(`Unavailable in the Windows target: ${group} ${unavailable.join(',')}. Select supported flags explicitly instead of all.`);
  }
}
