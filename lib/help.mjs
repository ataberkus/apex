/** `apex --apex-help`: sectioned help with aligned flag and description columns, laid out like omp's CLI help. */
import {CONTEXT_FEATURES} from '../extensions/apex-context/config.mjs';
import {CORE_FEATURES} from '../extensions/apex-core/config.mjs';
import {FEATURE_FEATURES} from '../extensions/apex-features/config.mjs';
import {plainText, prose, renderLine, span, truncateLine, visibleWidth, wrapText} from './cli-style.mjs';

const USAGE = [
  ['apex', '[APEX OPTIONS] [Pi arguments]'],
  ['apex report', 'SESSION [--json]'],
  ['apex resume', 'SESSION [--apex-dry-run]'],
  ['apex update', '[--check | --skip]'],
];

// [flag, value placeholder, description]
const OPTIONS = [
  ['--apex-off', '', 'Run stock Pi'],
  ['--apex-target', 'windows', 'Windows target; native Windows only'],
  ['--profile', 'default|headless|max', 'Launch profile; headless runs Pi with --print --mode json'],
  ['--apex-context', 'FLAGS', 'Context features to enable'],
  ['--apex-core', 'FLAGS', 'Core features to enable'],
  ['--apex-features', 'FLAGS', 'Daily-driver features to enable'],
  ['--apex-eval', '', 'Eval isolation; thinking stays at xhigh'],
  ['--apex-pair', 'PLAN,BUILD', 'Plan on the first model and build on the second (Windows target)'],
  ['--time-budget', 'SECONDS', 'Deadline for the time core feature'],
  ['--autocompact-tokens', 'TOKENS', 'Context-token threshold for the autocompact feature; /autocompact N changes it in a running session'],
  ['--apex-dry-run', '', 'Resolve the launch and print it as JSON without launching Pi'],
  ['--apex-help', '', 'Show this help'],
];

const FLAG_SETS = [['context', CONTEXT_FEATURES], ['core', CORE_FEATURES], ['features', FEATURE_FEATURES]];

const LOCAL = [
  ['report', 'SESSION [--json]', 'Summarize a saved session; --json prints the raw report'],
  ['resume', 'SESSION [--apex-dry-run]', 'Resume a session without unresolved tool calls; --apex-dry-run only inspects it'],
  ['update', '[--check | --skip]', 'Install the newest GitHub release over the installed Apex; --check only reports versions, --skip hides the notice for the latest one'],
];

const NOTES = [
  ['WINDOWS DEFAULTS', 'native Windows without Apex selection options', [
    'Claude Opus 5.5 at medium plus only features that add no prompts, tools or continuations: context cache; core correct; features cost,plan,report,resume,autocompact, and checkpoints at a Git root.',
    'An explicit --apex-context/--apex-core/--apex-features selection replaces those features and stays on the Windows target unless it names a Muse model.',
    '--apex-off runs stock Pi. Elsewhere all experiments default off.',
  ]],
  ['WINDOWS TARGET', '', [
    'Exact anthropic/claude-opus-5-5 OAuth by default, or --provider openai-codex|anthropic|opencode-go with a plain --model id using saved dashboard logins; native Windows only.',
    '--apex-pair provider/model:level,provider/model[:level] plans on the first model and builds on the second.',
    'Thinking defaults to medium; --thinking picks another level, except that --apex-eval stays at xhigh.',
    'Excludes bg/max/recovery and Muse-specific route/output.',
  ]],
  ['ORIGINAL EXPERIMENTS', '', ['Muse Spark 1.3 Contributor at xhigh.']],
  ['UPDATES', 'Windows setup installs only', [
    'apex update downloads apex-setup-<version>.exe from github.com/ataberkus/apex/releases, verifies it against SHA256SUMS and runs it silently over the existing install; settings, shortcuts, PATH entry and dashboard state stay. Close the dashboard first. A Git checkout (version 0.0.0) is never updated.',
    'Interactive apex and the dashboard check for a newer release at most once a day and only print a notice; set APEX_NO_UPDATE_CHECK=1 to turn the check off.',
  ]],
  ['LIMITS', '', [
    'Auxiliary inference and automatic resume remain disabled.',
    'Automated live tests require bounded scope and request, usage and deadline limits.',
  ]],
];

/** Two aligned columns; the description wraps under itself, or drops below the flag on narrow terminals. */
function columns(style, rows) {
  const left = Math.max(...rows.map(([cell]) => visibleWidth(plainText(cell))));
  const room = style.width - 2 - left - 3;
  const out = [];
  for (const [cell, description] of rows) {
    const pad = ' '.repeat(left - visibleWidth(plainText(cell)));
    if (room < 28 && Number.isFinite(style.width)) {
      out.push([span('  '), ...cell]);
      for (const text of wrapText(description, style.width - 6)) out.push([span('      '), ...prose(text)]);
      continue;
    }
    wrapText(description, room).forEach((text, index) => {
      out.push(index === 0 ? [span('  '), ...cell, span(pad + '   '), ...prose(text)] : [span(' '.repeat(left + 5)), ...prose(text)]);
    });
  }
  return out;
}

function bullets(style, items) {
  const mark = style.glyph?.bullet ?? '-';
  return items.flatMap(item => wrapText(item, style.width - 4)
    .map((text, index) => [span(index === 0 ? `  ${mark} ` : '    ', index === 0 ? 'dim' : undefined), ...prose(text)]));
}

const flag = (name, value) => [span(name, 'accent'), ...(value ? [span(' '), span(value, 'muted')] : [])];

export function formatHelp(style) {
  const dot = style.glyph?.dot ?? '-';
  const heading = (title, note) => [span(title, undefined, true), ...(note ? [span(` ${dot} ${note}`, 'muted')] : [])];
  const lines = [
    [span('apex', 'accent', true), span(` ${dot} `, 'dim'), span('Apex launcher for Pi', 'muted')], [],
    heading('USAGE'),
    ...USAGE.map(([command, args]) => [span('  '), span('$ ', 'dim'), span(command, undefined, true), span(' '), span(args, 'muted')]), [],
    heading('OPTIONS', 'Apex options precede Pi arguments'),
    ...columns(style, OPTIONS.map(([name, value, description]) => [flag(name, value), description])), [],
    heading('FEATURE FLAGS', 'comma-separated FLAGS values'),
    ...columns(style, FLAG_SETS.map(([name, values]) => [[span(name, 'accent')], values.join(', ')])), [],
    heading('LOCAL COMMANDS'),
    ...columns(style, LOCAL.map(([name, args, description]) => [[span(name, 'accent'), span(' '), span(args, 'muted')], description])),
  ];
  for (const [title, note, items] of NOTES) lines.push([], heading(title, note), ...bullets(style, items));
  return lines.map(line => renderLine(style, truncateLine(style, line, style.width))).join('\n');
}
