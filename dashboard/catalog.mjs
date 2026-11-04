// What the dashboard can launch. Summaries restate README.md / PHASE2_LOCAL.md in plain words; the flag lists
// are checked against the extensions' own exports at load, so adding a flag without describing it fails fast.
import {CONTEXT_FEATURES} from '../extensions/apex-context/config.mjs';
import {CORE_FEATURES} from '../extensions/apex-core/config.mjs';
import {FEATURE_FEATURES} from '../extensions/apex-features/config.mjs';
import {WINDOWS_MODEL, WINDOWS_UNAVAILABLE} from '../lib/windows-target.mjs';
import {levelsOf} from '../extensions/apex-router/pair.mjs';
import {LOGINS} from './provider-login.mjs';

const f = (flag, label, summary, extra = {}) => ({flag, label, summary, ...extra});

export const GROUPS = [
  {id: 'context', option: '--apex-context', title: 'Context and tokens', blurb: 'Spend fewer tokens per step.', features: [
    f('cache', 'Cache ledger', 'Records prompt-prefix hashes and the provider cache counters, outside the model context.'),
    f('shape', 'Shape long output', 'Moves very long tool output to a file under .apex/out and returns a short version. The full text stays recoverable.'),
    f('mask', 'Mask old results', 'Replaces old tool results in the saved context with short markers, including reads a newer read of the same file replaced. Recent reads, errors and latest results are kept.'),
    f('compact', 'Compaction', 'Native compaction handler. Summaries need a model call, which the current policy cancels.', {limited: 'Cancels before any summary is written'}),
    f('read', 'Short reads', 'Reads default to 80 lines with offset and limit, plus an outline mode of symbols. With edit, records which lines were shown.'),
    f('search', 'Bounded search', 'grep, find and ls return 80 results by default and say when a total is unknown; grep caps each file at 20 matches and pages files with skip. Adds ast_grep structural code search. Needs rg and fd on PATH.'),
    f('edit', 'Edit with old_string/new_string', 'Same exact-match edits, with clearer names, a closest-match similarity when a match fails, and (with read) a refusal for lines never shown.'),
    f('patch', 'Unified patch tool', 'Adds apply_patch for one existing file, with exact context and strict hunk counts.'),
    f('lazy', 'Defer optional tools', 'Hides apply_patch and ast_grep until the model asks for them. Only matters together with the patch or search tools.'),
    f('route', 'Auto model route', 'Selects the virtual apex/auto model, which routes back to the same Muse model.'),
    f('output', 'Short answers', 'Adds a short, stable output-style section and lowers the output cap on routine turns.'),
    f('browser', 'Browser', 'Adds a browser tool that drives your installed Chrome or Edge headless with a temporary profile: open http(s) pages, read them, click, type, take screenshots and read console errors. Never downloads a browser.'),
    f('computer', 'Computer use', 'Adds a computer tool that sees and controls this desktop: screenshots of the primary monitor, mouse moves, clicks, drags, scrolling, typing and key presses on your real screen.', {limited: 'Windows only'}),
  ]},
  {id: 'core', option: '--apex-core', title: 'Success rate', blurb: 'Keep long tasks on track.', features: [
    f('snapshot', 'Environment snapshot', 'Injects one bounded observation of the OS, shell, tools, package managers and git state at the start.'),
    f('entrypoints', 'Entry points', 'Ranks likely files and symbols for the task by name, with reasons.'),
    f('headless', 'Noninteractive mode', 'Adds a section and environment suited to unattended runs.'),
    f('contract', 'Acceptance criteria', 'Adds a tool to write and list explicit criteria, with checks on named files. Automatic extraction is off.'),
    f('todo', 'Todo list', 'Adds a todo tool. Dropping a step needs a reason, and one reminder fires if multi-step work has no list.'),
    f('verify', 'Verify before finishing', 'Tracks edits and later successful checks, and sends at most two continuations before the model stops.'),
    f('loops', 'Loop detection', 'Notes repeated failures, repeated reads and edit ping-pong.'),
    f('bg', 'Background processes', 'Start, poll and stop detached commands that outlive the agent.', {limited: 'Unix only; not available on Windows'}),
    f('time', 'Time budget', 'Appends notes at 50, 75 and 90 percent of a time budget you set. Never changes any hard timeout.', {needs: 'timeBudget'}),
    f('correct', 'Argument repair', 'Repairs tool-call aliases and checks paths and edit preconditions before running. Catastrophic shell commands ask first, and are blocked when nobody can be asked.'),
    f('diagnostics', 'New-error diagnostics', 'Runs installed checkers before and after edit, write and apply_patch, and reports only new errors.'),
    f('subagents', 'Read-only subagents', 'Adds explore (up to four tasks in parallel) and verify helpers.', {limited: 'Helper model calls are denied by the current policy'}),
    f('max', 'Best of several attempts', 'Runs separate attempts and ranks them. Needs the max profile.', {blocked: 'paid'}),
    f('recovery', 'Retry profile', 'Temporary settings with bounded provider retries.', {blocked: 'paid'}),
  ]},
  {id: 'features', option: '--apex-features', title: 'Daily driver', blurb: 'Commands you use while working.', features: [
    f('cost', 'Cost', 'Adds /cost with session totals, cache-hit percent and context use. Estimates, not invoices.', {commands: ['/cost']}),
    f('checkpoints', 'Checkpoints and undo', 'Snapshots files before each turn in a private shadow Git and adds /undo.', {commands: ['/undo']}),
    f('review', 'Independent review', 'Adds /review to verify the current diff.', {limited: 'Needs a helper model call, which the current policy denies', commands: ['/review']}),
    f('plan', 'Read-only planning', 'Adds /plan: read-only tools only, then /plan save writes PLAN.md.', {commands: ['/plan']}),
    f('remember', 'Remember project facts', 'Adds a tool that appends short facts to .apex/LEARNINGS.md for later sessions.'),
    f('skills', 'Ten on-demand skills', 'Debugging, testing, profiling, builds and more. Bodies load only when used.'),
    f('safety', 'Ask before risky tool calls', 'Pauses risky calls and asks you here before they run; the terminal can allow a tool for the session. Catastrophic commands always ask, and are blocked without a UI. A guardrail, not a sandbox.'),
    f('report', 'Token report', 'Adds /report with token categories for this session.', {commands: ['/report']}),
    f('resume', 'Session inspection', 'Adds /resume-info to check a session file without replaying tools.', {commands: ['/resume-info']}),
    f('autocompact', 'Autocompact', 'Summarizes the session with Pi\'s own compaction once a finished run passes the context-token threshold you set (300k by default), so later requests send less. Adds /autocompact to show or change it.', {needs: 'autocompactTokens', commands: ['/autocompact']}),
  ]},
];

for (const [group, expected] of [['context', CONTEXT_FEATURES], ['core', CORE_FEATURES], ['features', FEATURE_FEATURES]]) {
  const described = GROUPS.find(entry => entry.id === group).features.map(feature => feature.flag);
  if (JSON.stringify(described) !== JSON.stringify(expected)) throw new Error(`Dashboard catalog is out of date for ${group} features`);
}

// Login providers list every chat model in the installed Pi catalog, so new models appear when Pi does. The agent
// child accepts only models whose login was saved when it started; changeRoute restarts it for a login saved since.
// Ids are provider/model except the two original entries, which keep their saved ids.
// Each runs Apex features only through the native Windows target (Muse-only and Unix-only flags refused).
// `levels` are the thinking levels Pi accepts for the model; any two of these models can also run as a plan + build pair.
const BILLING = {
  'openai-codex': 'Your ChatGPT subscription, signed in with OAuth.',
  anthropic: 'Your Claude Pro or Max subscription, signed in with OAuth.',
  'opencode-go': 'Your OpenCode Go subscription, with the API key saved from the dashboard.',
};
export function modelCatalog(runtime) {
  const windows = {apex: process.platform === 'win32', target: 'windows', unavailable: [...WINDOWS_UNAVAILABLE.context, ...WINDOWS_UNAVAILABLE.core]};
  const signedIn = Object.keys(LOGINS).flatMap(provider => runtime.getModels(provider).map(model => {
    const sol = provider === 'openai-codex' && model.id === 'gpt-6.1-sol';
    return {id: sol ? 'sol' : `${provider}/${model.id}`, provider, model: model.id, label: sol ? 'GPT-6.1 Sol' : model.name ?? model.id,
      group: LOGINS[provider].label, billing: BILLING[provider], input: [...(model.input ?? ['text'])], levels: levelsOf(model), contextWindow: model.contextWindow, ...windows};
  })).sort((a, b) => (b.id === WINDOWS_MODEL) - (a.id === WINDOWS_MODEL)); // the Windows default model leads the list
  const muse = {id: 'muse', provider: 'openrouter', model: 'meta/muse-spark-1.3-contributor', label: 'Muse Spark 1.3', group: 'OpenRouter',
    billing: 'OpenRouter. Needs OPENROUTER_API_KEY in the environment that started the dashboard.', apex: true, unavailable: []};
  const museModel = runtime.getModel(muse.provider, muse.model);
  // `keyMissing` hides Muse from the picker until an OpenRouter key is available to the agent.
  const keyMissing = !process.env.OPENROUTER_API_KEY && !runtime.hasConfiguredAuth?.(muse.provider);
  return [...signedIn, {...muse, keyMissing, input: [...(museModel?.input ?? ['text'])], levels: museModel ? levelsOf(museModel) : ['xhigh'], contextWindow: museModel?.contextWindow}];
}
