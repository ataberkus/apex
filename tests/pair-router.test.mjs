import assert from 'node:assert/strict';
import test from 'node:test';
import {buildPiInvocation} from '../lib/launcher.mjs';
import {createPairModel, formatPair, levelsOf, nextPhase, PAIR_FLAG, pairFromArgv, parsePair, STUCK} from '../extensions/apex-router/pair.mjs';

const option = (args, name) => args[args.indexOf(name) + 1];
const map = levels => Object.fromEntries(levels.map(level => [level, level]));
const models = {
  'anthropic/claude-opus-5-5': {provider: 'anthropic', id: 'claude-opus-5-5', name: 'Claude Opus 5.5', reasoning: true, thinkingLevelMap: {off: null, minimal: null, ...map(['low', 'medium', 'high', 'xhigh', 'max'])}, contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image']},
  'anthropic/claude-sonnet-5-5': {provider: 'anthropic', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', reasoning: true, thinkingLevelMap: {off: null, minimal: null, ...map(['low', 'medium', 'high'])}, contextWindow: 1_000_000, maxTokens: 64_000, input: ['text', 'image']},
  'openai-codex/gpt-6-luna': {provider: 'openai-codex', id: 'gpt-6-luna', name: 'GPT-6 Luna', reasoning: true, thinkingLevelMap: map(['xhigh']), contextWindow: 272_000, maxTokens: 128_000, input: ['text']},
};
const catalog = (provider, id) => models[`${provider}/${id}`];
const statuses = [];
const ctx = {hasUI: true, ui: {setStatus: (key, text) => statuses.push([key, text])}, modelRegistry: {find: catalog}};
const user = {role: 'user', content: 'Fix the bug'};
const call = {role: 'assistant', content: []};
const result = (toolName, isError = false) => ({role: 'toolResult', toolName, isError});
const opusSonnet = parsePair('anthropic/claude-opus-5-5:high,anthropic/claude-sonnet-5-5');
const route = (fields, model = createPairModel(opusSonnet, catalog)) =>
  model.route({model: {provider: 'apex', id: 'pair', api: 'pi-virtual'}, thinkingLevel: 'medium', reason: 'continuation', messages: [], ...fields}, ctx);

test('pair specs name any two catalog models; the planning level is required and the build level is optional', () => {
  assert.deepEqual(opusSonnet, {plan: {provider: 'anthropic', id: 'claude-opus-5-5', thinking: 'high'}, build: {provider: 'anthropic', id: 'claude-sonnet-5-5'}});
  const mixed = parsePair('anthropic/claude-opus-5-5:max, openai-codex/gpt-6.1-sol:low');
  assert.deepEqual(mixed.build, {provider: 'openai-codex', id: 'gpt-6.1-sol', thinking: 'low'});
  assert.equal(formatPair(mixed), 'anthropic/claude-opus-5-5:max,openai-codex/gpt-6.1-sol:low');
  assert.equal(formatPair(opusSonnet), 'anthropic/claude-opus-5-5:high,anthropic/claude-sonnet-5-5');
  assert.throws(() => parsePair('anthropic/claude-opus-5-5,anthropic/claude-sonnet-5-5'), /planning model a thinking level/);
  assert.throws(() => parsePair('anthropic/claude-opus-5-5:loud,anthropic/claude-sonnet-5-5'), /Unknown thinking level loud/);
  for (const bad of ['anthropic/claude-opus-5-5:high', 'a/b:high,c/d,e/f', 'claude-opus-5-5:high,anthropic/x', undefined]) assert.throws(() => parsePair(bad), /PLAN,BUILD/);
  assert.deepEqual(pairFromArgv(['node', 'pi', '--' + PAIR_FLAG, 'anthropic/claude-opus-5-5:high,anthropic/claude-sonnet-5-5']), opusSonnet);
  assert.equal(pairFromArgv(['node', 'pi']), undefined);
});

test('levels follow what Pi accepts: null-mapped levels drop out and xhigh or max must be mapped', () => {
  assert.deepEqual(levelsOf(models['anthropic/claude-opus-5-5']), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(levelsOf(models['anthropic/claude-sonnet-5-5']), ['low', 'medium', 'high']);
  assert.deepEqual(levelsOf({reasoning: true}), ['off', 'minimal', 'low', 'medium', 'high']);
  assert.deepEqual(levelsOf({reasoning: false}), ['off']);
});

test('each request plans at the fixed level, then the build model continues at the session level after the first successful edit', () => {
  const planned = route({reason: 'user', messages: [user]});
  assert.deepEqual([planned.model.id, planned.thinkingLevel, planned.state.phase], ['claude-opus-5-5', 'high', 'plan']);
  const reading = route({state: planned.state, messages: [user, call, result('read')]});
  assert.equal(reading.model.id, 'claude-opus-5-5');
  assert.equal(reading.state, planned.state, 'an unchanged phase keeps the stored state');
  assert.equal(route({state: planned.state, messages: [user, call, result('edit', true)]}).model.id, 'claude-opus-5-5', 'a failed edit does not start the build');
  for (const tool of ['edit', 'write', 'apply_patch']) {
    const built = route({state: planned.state, thinkingLevel: 'low', messages: [user, call, result('read'), result(tool)]});
    assert.deepEqual([built.model.id, built.thinkingLevel, built.state.phase], ['claude-sonnet-5-5', 'low', 'build']);
  }
  assert.equal(route({state: {version: 1, phase: 'build'}, messages: [user, call, result('edit'), call, result('bash')]}).model.id, 'claude-sonnet-5-5', 'build stays on the build model');
  assert.equal(route({reason: 'user', state: {version: 1, phase: 'build'}, messages: [user]}).model.id, 'claude-opus-5-5', 'a new message plans again');
  assert.deepEqual(statuses.at(-1), ['apex-pair', 'claude-opus-5-5 planning']);
});

test('repeated failed tool calls hand the rest of the request back to the planning model', () => {
  const build = {version: 1, phase: 'build'};
  const failures = n => [user, call, result('edit'), ...Array.from({length: n}, () => [call, result('bash', true)]).flat()];
  assert.equal(nextPhase({reason: 'continuation', state: build, messages: failures(STUCK - 1)}), 'build');
  const rescued = route({state: build, messages: failures(STUCK)});
  assert.deepEqual([rescued.model.id, rescued.thinkingLevel, rescued.state.phase], ['claude-opus-5-5', 'high', 'rescue']);
  assert.equal(nextPhase({reason: 'continuation', state: rescued.state, messages: [...failures(STUCK), call, result('edit')]}), 'rescue', 'no switch back within the request');
  assert.equal(nextPhase({reason: 'continuation', state: build, messages: [...failures(STUCK - 1), user, call, result('bash', true)]}), 'build', 'a message breaks the streak');
});

test('the virtual model takes the build levels and the tighter limits; direct requests go to the build model', () => {
  const model = createPairModel(opusSonnet, catalog);
  assert.deepEqual([model.provider, model.id, model.name, [...model.thinkingLevels]], ['apex', 'pair', 'Claude Opus 5.5 plans, Claude Sonnet 5.5 builds', ['low', 'medium', 'high']]);
  assert.deepEqual([model.contextWindow, model.maxTokens, model.input], [1_000_000, 64_000, ['text', 'image']]);
  const mixed = createPairModel(parsePair('anthropic/claude-opus-5-5:max,openai-codex/gpt-6-luna'), catalog);
  assert.deepEqual([[...mixed.thinkingLevels], mixed.contextWindow, mixed.input], [['off', 'minimal', 'low', 'medium', 'high', 'xhigh'], 272_000, ['text']]);
  const summary = route({reason: 'direct', thinkingLevel: 'high', state: {version: 1, phase: 'plan'}});
  assert.deepEqual([summary.model.id, summary.thinkingLevel, summary.state], ['claude-sonnet-5-5', 'high', undefined]);
  assert.throws(() => route({reason: 'direct', thinkingLevel: 'xhigh'}), /does not support xhigh/);
  assert.throws(() => route({reason: 'user'}, createPairModel(parsePair('anthropic/missing:high,anthropic/claude-sonnet-5-5'), catalog)), /not in the catalog/);
  assert.throws(() => route({reason: 'user'}, createPairModel(parsePair('anthropic/claude-sonnet-5-5:max,anthropic/claude-sonnet-5-5'), catalog)), /does not support max/);
  const aborted = new AbortController(); aborted.abort();
  assert.throws(() => route({signal: aborted.signal}), /aborted/);
});

test('the Windows target launches --apex-pair through the pair extension at the build level; single models keep xhigh', () => {
  const build = args => buildPiInvocation(['--apex-target', 'windows', ...args], '/pi.js', {platform: 'win32'}).args;
  const args = build(['--apex-pair', 'anthropic/claude-opus-5-5:high,anthropic/claude-sonnet-5-5:low', 'task']);
  assert.ok(option(args, '--extension').endsWith('pair.mjs'));
  assert.deepEqual([option(args, '--' + PAIR_FLAG), option(args, '--provider'), option(args, '--model'), option(args, '--thinking')],
    ['anthropic/claude-opus-5-5:high,anthropic/claude-sonnet-5-5', 'apex', 'pair', 'low']);
  assert.equal(option(build(['--apex-pair', 'anthropic/claude-opus-5-5:high,openai-codex/gpt-6-luna', 'task']), '--thinking'), 'medium');
  assert.equal(option(build(['--apex-pair', 'anthropic/claude-opus-5-5:high,anthropic/claude-sonnet-5-5', '--thinking', 'high', 'task']), '--thinking'), 'high');
  assert.throws(() => build(['--apex-pair', 'anthropic/claude-opus-5-5:high,anthropic/claude-sonnet-5-5:low', '--thinking', 'high', 'task']), /once/);
  assert.throws(() => build(['--apex-pair', 'anthropic/claude-opus-5-5:high,anthropic/claude-sonnet-5-5', '--thinking', 'loud', 'task']), /Unknown thinking level/);
  assert.throws(() => build(['--apex-pair', 'anthropic/claude-opus-5-5:high,anthropic/claude-sonnet-5-5', '--model', 'gpt-6-luna', 'task']), /chooses both models/);
  assert.throws(() => build(['--apex-pair', 'openrouter/x:high,anthropic/claude-sonnet-5-5', 'task']), /saved logins/);
  assert.throws(() => buildPiInvocation(['--apex-pair', 'anthropic/claude-opus-5-5:high,anthropic/claude-sonnet-5-5', 'task'], '/pi.js', {platform: 'win32'}), /Windows target/);
  assert.equal(option(build(['--provider', 'anthropic', '--model', 'claude-opus-5-5', '--thinking', 'high', 'task']), '--thinking'), 'high', 'a single model takes any level');
});
