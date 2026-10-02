import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {buildPiInvocation} from '../lib/launcher.mjs';
import {WINDOWS_MODEL, withWindowsDefaults} from '../lib/windows-target.mjs';
import {runtimePolicy, SELECTED_MODEL} from '../extensions/apex-context/config.mjs';
const option = (args, name) => args[args.indexOf(name) + 1];

test('bare Windows apex gets every supported prompt-free feature; explicit selection and --apex-off win', t => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'apex-auto-')));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const run = (args, cwd = dir) => buildPiInvocation(withWindowsDefaults(args, {platform: 'win32', cwd}), '/pi.js', {platform: 'win32'}).args;
  const plain = run(['--profile', 'headless', 'task']);
  assert.equal(option(plain, '--model'), WINDOWS_MODEL);
  assert.equal(option(plain, '--apex-core-flags'), 'snapshot,entrypoints,contract,todo,verify,loops,correct,diagnostics,headless');
  assert.ok(!option(plain, '--apex-feature-flags').includes('checkpoints'), 'no Git root: checkpoints would block every mutation');
  mkdirSync(path.join(dir, '.git'));
  writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.ok(option(run(['task']), '--apex-feature-flags').endsWith(',checkpoints'));
  const deep = path.join(dir, 'x'.repeat(160));
  mkdirSync(path.join(deep, '.git'), {recursive: true});
  writeFileSync(path.join(deep, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.ok(!option(run(['task'], deep), '--apex-feature-flags').includes('checkpoints'), 'path past Git limit');
  assert.equal(option(run(['--apex-features', 'cost', 'task']), '--apex-feature-flags'), 'cost');
  assert.ok(!run(['--apex-features', 'cost', 'task']).includes('--apex-context-flags'));
  assert.deepEqual(run(['--apex-off', 'task']), ['task']);
  assert.deepEqual(withWindowsDefaults(['task'], {platform: 'linux', cwd: dir}), ['task']);
});

const build = args => buildPiInvocation(['--apex-target', 'windows', ...args], '/pi.js', {platform: 'win32'});

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

test('Windows target runs any signed-in provider model with an explicit provider and keeps the xhigh policy', () => {
  for (const [provider, model] of [['anthropic', 'claude-opus-5-5'], ['opencode-go', 'kimi-k3'], ['openai-codex', 'gpt-6-luna']]) {
    const args = build(['--apex-context', 'read', '--provider', provider, '--model', model, '--models', `${provider}/${model}`, 'task']).args;
    assert.equal(option(args, '--provider'), provider);
    assert.equal(option(args, '--model'), model);
    assert.equal(option(args, '--thinking'), 'xhigh');
    assert.equal(args.filter(arg => arg === '--provider').length, 1);
  }
  for (const args of [
    ['--model', 'claude-opus-5-5'], // another model needs its provider named
    ['--provider', 'anthropic'], ['--provider', 'anthropic', '--model', WINDOWS_MODEL],
    ['--provider', 'anthropic', '--model', 'anthropic/claude-opus-5-5'], ['--provider', 'anthropic', '--model', 'claude-opus-5-5:high'],
    ['--provider', 'opencode', '--model', 'kimi-k3'], ['--provider', 'opencode-go', '--model', 'kimi-k3', '--thinking', 'low'],
    ['--provider', 'opencode-go', '--model', 'kimi-k3', '--models', WINDOWS_MODEL],
    ['--provider', 'opencode-go', '--model', 'kimi-k3', '--api-key', 'must-not-print'],
  ]) assert.throws(() => build(args), undefined, JSON.stringify(args));
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
