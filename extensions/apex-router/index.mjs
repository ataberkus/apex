/**
 * Opt-in virtual routing for the authorized Muse/xhigh policy.
 * Loading this extension registers apex/auto before Pi selects a model. The
 * launcher must load it only when the route feature is explicitly requested.
 * Registration and routing never initialize a provider or resolve credentials.
 */
export const APEX_MODEL = 'openrouter/meta/muse-spark-1.3-contributor';
export const APEX_ROUTING_SIGNAL = 'apex-routing';

const provider = 'openrouter';
const modelId = 'meta/muse-spark-1.3-contributor';
const phases = new Set(['planning', 'execution', 'verification']);
const reasons = new Set(['user', 'continuation', 'retry', 'direct']);

function assertIdentity(reference) {
  const allowed = typeof reference === 'string' ? reference === APEX_MODEL :
    reference !== null && typeof reference === 'object' && reference.provider === provider &&
      reference.id === modelId && reference.api !== 'pi-virtual';
  if (!allowed) throw new Error(`Apex routing model must be exactly ${APEX_MODEL}.`);
}

function assertThinking(level) {
  if (level !== 'xhigh') throw new Error('Apex routing thinking must remain xhigh.');
}

function deriveState(branch, previousState) {
  let assistantMessages = 0;
  let signalledPhase;
  for (const entry of branch) {
    const message = entry.type === 'message' ? entry.message : undefined;
    if (message?.role === 'assistant' && message.stopReason !== 'error' && message.stopReason !== 'aborted') {
      assistantMessages++;
    }
    if (entry.type === 'custom' && entry.customType === APEX_ROUTING_SIGNAL && phases.has(entry.data?.phase)) {
      signalledPhase = entry.data.phase;
    }
  }
  const phase = signalledPhase ?? (assistantMessages < 10 ? 'planning' : 'execution');
  if (previousState?.version === 1 && previousState.phase === phase &&
    previousState.assistantMessages === assistantMessages) return previousState;
  return {version: 1, phase, assistantMessages};
}

/**
 * Native ExtensionVirtualModel definition. MAIN and FAST may be the exact model
 * string or a native provider/id reference; both are validated immediately.
 * Branch custom entries {customType:'apex-routing',data:{phase}} may request a
 * phase. The latest valid signal on the active branch wins. Otherwise planning
 * covers the first ten successful assistants, then execution. The phase never
 * changes this policy's physical model or xhigh thinking.
 */
export function createApexRouter({main, fast, thinkingLevel = 'xhigh'} = {}) {
  assertIdentity(main);
  assertIdentity(fast);
  assertThinking(thinkingLevel);
  return {
    provider: 'apex', id: 'auto', name: 'Apex Auto (Muse xhigh)',
    thinkingLevels: Object.freeze(['xhigh']),
    route(request, ctx) {
      assertThinking(request.thinkingLevel);
      if (!reasons.has(request.reason)) throw new Error('Unknown Apex routing reason.');
      if (request.signal?.aborted) throw new Error('Apex routing request was aborted.');
      // Never trust a sticky reference from an earlier, unauthorized selection.
      const sticky = request.reason === 'retry' ? request.failed ?? request.previous :
        request.reason === 'continuation' ? request.previous : undefined;
      if (sticky) {
        assertIdentity(sticky.model);
        assertThinking(sticky.thinkingLevel ?? thinkingLevel);
      }
      // Only a read-only exact catalog lookup is needed; Pi dispatch performs
      // canonicalization/auth later, outside this router.
      const model = ctx.modelRegistry.find(provider, modelId);
      assertIdentity(model);
      if (typeof model.api !== 'string' || !model.api || model.thinkingLevelMap?.xhigh !== 'xhigh') {
        throw new Error('Apex physical model must support the exact xhigh mapping.');
      }
      const result = {model, thinkingLevel};
      if (request.reason !== 'direct') {
        result.state = deriveState(ctx.sessionManager.getBranch(), request.state);
      }
      return result;
    },
  };
}

export default function apexRouter(pi) {
  pi.registerVirtualModel(createApexRouter({main: APEX_MODEL, fast: APEX_MODEL, thinkingLevel: 'xhigh'}));
}
