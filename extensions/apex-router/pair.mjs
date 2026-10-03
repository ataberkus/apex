/**
 * Plan + build model pairs for the native Windows target, separate from the frozen Muse apex/auto policy.
 * The launcher's --apex-pair PLAN,BUILD selects apex/pair, a virtual model that routes every request
 * to one physical model. PLAN is provider/model:level; BUILD is provider/model, and its thinking level
 * is the session's (the virtual model offers exactly the build model's levels, so it can change live).
 *
 * - plan: each message you write goes to the planning model at its fixed level.
 * - build: after the first successful edit of that request, the build model continues.
 * - rescue: STUCK consecutive failed tool calls on the build model hand the rest of the request back.
 *
 * Every switch re-sends the context without the other model's prompt cache, so a request switches
 * at most twice. Requests outside the agent loop, such as compaction summaries, go to the build
 * model. Pi turns the other model's thinking into plain text when the model changes.
 */
export const PAIR_FLAG = 'apex-pair-models';
export const LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch']);
export const STUCK = 3;
const MODEL = /^([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9._-]*)(?::([a-z]+))?$/i;

/** Levels Pi accepts for a catalog model, as pi-ai's getSupportedThinkingLevels computes them. */
export function levelsOf(model) {
  if (!model?.reasoning) return ['off'];
  return LEVELS.filter(level => {
    const mapped = model.thinkingLevelMap?.[level];
    return mapped !== null && (!['xhigh', 'max'].includes(level) || mapped !== undefined);
  });
}

/** `provider/model:level,provider/model[:level]` into {plan, build}; the plan level is required. */
export function parsePair(spec) {
  const parts = typeof spec === 'string' ? spec.split(',') : [];
  const [plan, build] = parts.map(part => MODEL.exec(part.trim()));
  if (parts.length !== 2 || !plan || !build) throw new Error('--apex-pair needs PLAN,BUILD as provider/model:level,provider/model[:level]');
  const slot = match => ({provider: match[1], id: match[2], ...(match[3] ? {thinking: match[3]} : {})});
  const pair = {plan: slot(plan), build: slot(build)};
  if (!pair.plan.thinking) throw new Error('Give the planning model a thinking level, for example anthropic/claude-opus-5-5:high');
  for (const {thinking} of [pair.plan, pair.build]) if (thinking && !LEVELS.includes(thinking)) throw new Error(`Unknown thinking level ${thinking}; use ${LEVELS.join(', ')}`);
  return pair;
}
export const formatPair = ({plan, build}) => `${plan.provider}/${plan.id}:${plan.thinking},${build.provider}/${build.id}${build.thinking ? ':' + build.thinking : ''}`;

/** Tool results after the latest assistant message: what the model just did. */
function latestResults(messages) {
  const results = [];
  for (let i = messages.length - 1; i >= 0 && messages[i].role === 'toolResult'; i--) results.push(messages[i]);
  return results;
}

/** Failed tool calls in a row, newest first, stopping at a success or a message that is not a tool exchange. */
function failureStreak(messages) {
  let streak = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'assistant') continue;
    if (message.role !== 'toolResult' || !message.isError) break;
    streak++;
  }
  return streak;
}

/** The phase for one agent-loop request. Pure, so it is tested without a session. */
export function nextPhase({reason, state, messages}) {
  if (reason === 'user' || !state) return 'plan';
  if (state.phase === 'plan' && latestResults(messages).some(result => EDIT_TOOLS.has(result.toolName) && !result.isError)) return 'build';
  if (state.phase === 'build' && failureStreak(messages) >= STUCK) return 'rescue';
  return state.phase;
}

/** The apex/pair definition. `catalog(provider, id)` reads the static catalog for limits and levels. */
export function createPairModel(pair, catalog = () => undefined) {
  const [plan, build] = [catalog(pair.plan.provider, pair.plan.id), catalog(pair.build.provider, pair.build.id)];
  const buildLevels = build ? levelsOf(build) : LEVELS;
  const limit = key => Math.min(...[plan?.[key], build?.[key]].map(value => value > 0 ? value : Infinity));
  const name = model => model?.name ?? model?.id;
  const physical = (ctx, slot, level) => {
    const model = ctx.modelRegistry.find(slot.provider, slot.id);
    if (!model) throw new Error(`Model ${slot.provider}/${slot.id} is not in the catalog`);
    if (!levelsOf(model).includes(level)) throw new Error(`${slot.provider}/${slot.id} does not support ${level} thinking`);
    return model;
  };
  return {
    provider: 'apex', id: 'pair', name: `${name(plan) ?? pair.plan.id} plans, ${name(build) ?? pair.build.id} builds`,
    thinkingLevels: buildLevels,
    ...(Number.isFinite(limit('contextWindow')) ? {contextWindow: limit('contextWindow')} : {}),
    ...(Number.isFinite(limit('maxTokens')) ? {maxTokens: limit('maxTokens')} : {}),
    ...(plan?.input && build?.input ? {input: plan.input.filter(type => build.input.includes(type))} : {}),
    route(request, ctx) {
      if (request.signal?.aborted) throw new Error('Apex routing request was aborted.');
      const builder = () => ({model: physical(ctx, pair.build, request.thinkingLevel), thinkingLevel: request.thinkingLevel});
      if (request.reason === 'direct') return builder();
      const phase = nextPhase(request);
      const state = request.state?.phase === phase ? request.state : {version: 1, phase};
      if (state !== request.state && ctx.hasUI) ctx.ui.setStatus?.('apex-pair', phase === 'build' ? `${pair.build.id} building` : `${pair.plan.id} ${phase === 'plan' ? 'planning' : 'taking over'}`);
      if (phase === 'build') return {...builder(), state};
      return {model: physical(ctx, pair.plan, pair.plan.thinking), thinkingLevel: pair.plan.thinking, state};
    },
  };
}

/** Pi parses extension flags only after loading, but the virtual model must exist before Pi selects one. */
export function pairFromArgv(argv = process.argv) {
  const index = argv.indexOf('--' + PAIR_FLAG);
  return index < 0 ? undefined : parsePair(argv[index + 1]);
}

export default async function apexPair(pi) {
  pi.registerFlag(PAIR_FLAG, {type: 'string', default: '', description: 'Plan and build models for apex/pair, set by the Apex launcher.'});
  const pair = pairFromArgv();
  if (!pair) return;
  // Read-only, offline catalog lookup for limits and the build model's levels; routing still uses the session registry.
  const {ModelRuntime} = await import('@earendil-works/pi-coding-agent');
  const runtime = await ModelRuntime.create({modelsPath: null, allowModelNetwork: false, refreshOnCreate: false});
  pi.registerVirtualModel(createPairModel(pair, (provider, id) => runtime.getModel(provider, id)));
}
