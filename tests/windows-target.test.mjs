import assert from 'node:assert/strict';
import test from 'node:test';
import {buildPiInvocation} from '../lib/launcher.mjs';
import {WINDOWS_MODEL} from '../lib/windows-target.mjs';
import {runtimePolicy, SELECTED_MODEL} from '../extensions/apex-context/config.mjs';

const build = args => buildPiInvocation(['--apex-target', 'windows', ...args], '/pi.js', {platform: 'win32'});
const option = (args, name) => args[args.indexOf(name) + 1];

test('Windows target selects exact Sol/xhigh without automatically enabling a feature', () => {
  const invocation = build(['--profile', 'headless', 'task']);
  assert.equal(invocation.target, 'windows');
  assert.equal(option(invocation.args, '--provider'), 'openai-codex');
  assert.equal(option(invocation.args, '--model'), WINDOWS_MODEL);
  assert.equal(option(invocation.args, '--thinking'), 'xhigh');
  assert.equal(option(invocation.args, '--mode'), 'json');
  assert.ok(!invocation.args.includes('--extension'));
  assert.equal(invocation.args.at(-1), 'task');
});

test('Windows context/core/daily flags compose without changing the benchmark authorization', () => {
  const args = build(['--apex-context', 'read,search,edit,shape', '--apex-core', 'todo,verify',
    '--apex-features', 'cost,checkpoints,plan,report', '--model', 'gpt-6.1-sol', '--provider', 'openai-codex', '--thinking', 'xhigh', 'task']).args;
  assert.equal(args.filter(arg => arg === '--extension').length, 3);
  assert.equal(option(args, '--apex-context-flags'), 'read,search,edit,shape');
  assert.equal(option(args, '--apex-core-flags'), 'todo,verify');
  assert.equal(option(args, '--apex-feature-flags'), 'cost,checkpoints,plan,report');
  assert.equal(args.filter(arg => arg === '--provider').length, 1);
  assert.equal(args.filter(arg => arg === '--model').length, 1);
  assert.equal(runtimePolicy().allowed_model, SELECTED_MODEL);
  assert.equal(runtimePolicy().paid_runs_enabled, false);
  assert.equal(runtimePolicy().execution_policy, 'offline-only');
});

test('Windows selection refuses unavailable flags, nonnative hosts, fallback models and API keys', () => {
  for (const args of [
    ['--apex-core', 'bg'], ['--apex-core', 'max'], ['--apex-core', 'recovery'], ['--apex-core', 'all'],
    ['--apex-context', 'route'], ['--apex-context', 'output'], ['--apex-context', 'all'],
    ['--provider', 'openai'], ['--provider', 'openrouter'], ['--model', SELECTED_MODEL],
    ['--model', 'sol'], ['--model', `${WINDOWS_MODEL}:xhigh`], ['--thinking', 'max'], ['--thinking', 'low'],
    ['--api-key', 'must-not-print'], ['--api-key=must-not-print'], ['--provider=openai-codex'],
    ['--models', '*'], ['--models', `${WINDOWS_MODEL},other/model`],
    ['--apex-target', 'windows'],
  ]) assert.throws(() => build(args), undefined, JSON.stringify(args));
  assert.throws(() => buildPiInvocation(['--apex-target', 'windows'], 'x', {platform: 'linux'}), /native Windows/);
  assert.throws(() => buildPiInvocation(['--apex-target', 'linux'], 'x'), /only windows/);
  assert.doesNotThrow(() => build(['--models', WINDOWS_MODEL]));
});

test('Windows option-like task text and Pi values are preserved, not interpreted as target selection', () => {
  assert.deepEqual(buildPiInvocation(['--system-prompt', '--apex-target', 'windows'], 'x').args,
    ['--system-prompt', '--apex-target', 'windows']);
  const args = build(['--', '--api-key', 'literal', '--apex-core', 'bg']).args;
  assert.deepEqual(args.slice(-5), ['--', '--api-key', 'literal', '--apex-core', 'bg']);
  assert.doesNotThrow(() => build(['--system-prompt', '--api-key']));
  assert.doesNotThrow(() => build(['--print', 'task contains --apex-core bg']));
});

test('original opt-in and default-forwarding contracts retain the original model restriction', () => {
  assert.deepEqual(buildPiInvocation(['--provider', 'openai-codex', '--model', 'gpt-6.1-sol'], 'x').args,
    ['--provider', 'openai-codex', '--model', 'gpt-6.1-sol']);
  assert.throws(() => buildPiInvocation(['--apex-features', 'cost', '--model', WINDOWS_MODEL], 'x'), /Muse/);
  assert.equal(option(buildPiInvocation(['--apex-context', 'read'], 'x').args, '--model'), SELECTED_MODEL);
});

test('pinned Pi parses the Windows invocation and keeps its literal prompt', async () => {
  const {parseArgs} = await import('../node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js');
  const parsed = parseArgs(build(['--profile', 'headless', '--apex-features', 'cost', '--apex-eval',
    '--', '--api-key literal task']).args);
  assert.equal(parsed.provider, 'openai-codex');
  assert.equal(parsed.model, WINDOWS_MODEL);
  assert.equal(parsed.thinking, 'xhigh');
  assert.deepEqual(parsed.messages, ['--api-key literal task']);
  assert.equal(parsed.unknownFlags.get('apex-feature-flags'), 'cost');
});
