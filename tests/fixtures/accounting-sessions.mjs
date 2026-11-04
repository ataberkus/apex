// Seeded synthetic native sessions and call schedules for the accounting differential tests.
export const random = seed => () => {
  seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296;
};
const tools = rnd => ({pick: values => values[Math.floor(rnd() * values.length)], chance: p => rnd() < p});

/**
 * One session of n entries. 'clean' sessions bill only fully known, priceable usage; 'mixed' ones add every input the
 * accounting treats as partial, unattributed, duplicated or late; 'errors' ones also add the inputs it must refuse.
 */
export function generate(rnd, n, mode) {
  const {pick, chance} = tools(rnd); const clean = mode === 'clean'; const errors = mode === 'errors';
  const entries = []; const ids = []; const late = []; let parent = null; let next = 0;
  const usage = () => {
    const value = {input: 1 + Math.floor(rnd() * 50), output: Math.floor(rnd() * 500), cacheRead: Math.floor(rnd() * 9000), cacheWrite: Math.floor(rnd() * 300)};
    value.totalTokens = clean || chance(0.95) ? value.input + value.output + value.cacheRead + value.cacheWrite : 5;
    if (chance(0.4)) value.reasoning = clean || chance(0.95) ? Math.floor(value.output / 2) : value.output + 1;
    if (chance(0.3)) value.cacheWrite1h = Math.floor(value.cacheWrite / 3);
    if (chance(0.6)) value.cost = {total: clean || chance(0.97) ? rnd() / 100 : 'x'};
    if (clean) return value;
    if (chance(0.02)) delete value.cacheRead;
    if (chance(0.02)) Object.assign(value, {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0});
    // Two of either overflow the session totals.
    if (errors && chance(0.03)) Object.assign(value, {input: 5e15, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5e15});
    if (errors && chance(0.03)) value.cost = {total: 1e308};
    return value;
  };
  // Few distinct sizes, so top consumers often tie on bytes.
  const text = () => pick(['', 'a', 'é', '😀']).repeat(pick([0, 100, 100, 200, 300]));
  const task = () => pick(['task-1', 'task-2', 'task-3']);
  const parentFor = () => {
    const r = rnd();
    if (r < 0.8 || clean && r < 0.95) return parent;
    if (r < 0.88 && ids.length) return pick(ids);
    if (r < 0.93) {const id = `late${next}`; late.push(id); return id;}
    if (r < 0.96) return null;
    if (r < 0.98) return 'header';
    return undefined;
  };
  const push = (entry, {id = `e${next++}`, parentId = parentFor(), anonymous = false} = {}) => {
    if (!anonymous) entry.id = id;
    if (parentId !== undefined) entry.parentId = parentId;
    entries.push(entry); if (!anonymous) {ids.push(id); if (chance(0.9)) parent = id;}
    return entry;
  };
  const responses = []; const helpers = [];
  push({type: 'model_change', provider: 'anthropic', modelId: 'm1'}, {parentId: null});
  while (entries.length < n) {
    const r = rnd();
    if (r < 0.22) {
      const provider = clean ? 'anthropic' : pick(['anthropic', 'anthropic', 'openai', 'fixture', '', undefined]);
      const message = {role: 'assistant', provider, model: provider === 'anthropic' ? 'm1' : provider ? pick(['m1', 'm2']) : undefined, usage: usage(),
        stopReason: clean ? pick(['toolUse', 'stop']) : pick(['toolUse', 'toolUse', 'stop', 'stop', 'aborted', 'error', 'pending']), responseId: chance(0.8) ? `r${next}` : undefined,
        content: [{type: 'text', text: text()}, {type: 'thinking', thinking: text()}, {type: 'toolCall', id: 'c', name: 'edit', arguments: chance(0.9) ? {x: text()} : undefined}]};
      if (chance(0.05)) message.content.push({type: 'image', data: text()});
      responses.push(push({type: 'message', message}));
    } else if (r < 0.25 && responses.length) {
      // A replayed response: identical usage is billed once, different usage under one response ID is refused.
      const message = structuredClone(pick(responses).message);
      if (errors && chance(0.05)) message.usage = usage();
      push({type: 'message', message});
    } else if (r < 0.35) {
      const aux = !clean && chance(0.3) ? {details: {apexAux: {version: pick([1, 1, 2]), attempted: chance(0.8), complete: chance(0.8), provider: 'openai', model: 'm2'}}} : {};
      push({type: 'message', message: {role: 'toolResult', content: [{type: 'text', text: text()}], ...(!clean && chance(0.3) ? {usage: usage()} : {}), ...aux}});
    } else if (r < 0.4) {
      push({type: 'message', message: {role: 'user', content: chance(0.5) ? text() : [{type: 'text', text: text()}, {type: 'image', data: text()}]}});
    } else if (r < 0.43) {
      const role = pick(['bashExecution', 'compactionSummary', 'branchSummary', 'custom', 'system', 'other']);
      push({type: 'message', message: {role, command: text(), output: text(), summary: text(), content: text()}});
    } else if (r < 0.46) {
      push(clean ? {type: 'model_change', provider: 'anthropic', modelId: 'm1'} : {type: 'model_change', provider: pick(['anthropic', 'openai', 'fixture']), modelId: pick(['m1', 'm2'])});
    } else if (r < 0.5) {
      const state = clean ? (chance(0.5) ? {'apex-task-state': {taskId: task()}} : undefined) :
        chance(0.5) ? {'apex-task-state': {taskId: task(), extraction: {attempted: chance(0.5), usage: chance(0.8) ? {} : null}}} :
          chance(0.5) ? {'apex-todo': {control: {taskId: task(), extraction: {attempted: true, usage: {}}}}} : undefined;
      push({type: 'compaction', summary: text(), usage: clean || chance(0.9) ? usage() : undefined, fromHook: !clean && chance(0.2),
        ...(!clean && chance(0.2) ? {provider: 'openai', model: 'm2'} : {}), ...(state ? {details: {apexState: state}} : {}),
        ...(chance(0.3) ? {systemMessage: {content: [{type: 'text', text: text()}]}} : {})});
    } else if (r < 0.53) {
      push({type: 'branch_summary', summary: text(), usage: usage(), fromHook: !clean && chance(0.3)});
    } else if (r < 0.58) {
      push(clean ? {type: 'custom', customType: 'apex-task-state', data: {taskId: task()}} : {type: 'custom', customType: pick(['apex-task-state', 'apex-todo']),
        data: chance(0.5) ? {taskId: task(), extraction: {attempted: chance(0.5), usage: {a: 1}}} : {control: {taskId: task(), extraction: {attempted: true, usage: {}}}}});
    } else if (r < 0.63 && !clean) {
      const reuse = helpers.length && chance(0.2);
      const data = reuse ? structuredClone(pick(helpers).data) : {version: pick([1, 1, 1, 2]), kind: pick(['contract', 'contract', 'other']), taskId: chance(0.9) ? task() : 5,
        requestId: `h${Math.floor(rnd() * 30)}`, complete: chance(0.9), status: pick(['complete', 'complete', 'aborted', 'error']), usage: usage(), provider: 'openai', model: 'm2'};
      if (reuse && errors && chance(0.1)) data.usage = usage();
      helpers.push(push({type: 'custom', customType: 'apex-helper-usage', data}));
    } else if (r < 0.66 && !clean) {
      push({type: 'custom', customType: 'apex-contract', data: {source: pick(['automatic', 'manual']), usage: {}, taskId: task()}});
    } else if (r < 0.69) {
      push({type: 'usage', kind: 'cache_warm', provider: clean ? 'anthropic' : 'openai', model: clean ? 'm1' : pick(['m1', 'm2']), usage: usage(),
        ...(chance(0.3) ? {requestId: `w${Math.floor(rnd() * 5)}`} : {})});
    } else if (r < 0.72) {
      push({type: 'custom_message', content: chance(0.5) ? text() : [{type: 'text', text: text()}]});
    } else if (r < 0.74 && !clean) {
      push(chance(0.5) ? {type: 'weird', usage: usage()} : {type: 'custom', customType: 'other', message: {usage: usage()}});
    } else if (r < 0.77) {
      entries.push(entries[Math.floor(rnd() * entries.length)]); // the same object again
    } else if (r < 0.79) {
      const copy = structuredClone(entries[Math.floor(rnd() * entries.length)]);
      if (errors && chance(0.15) && copy?.id !== undefined) copy.extra = 1;
      entries.push(copy);
    } else if (r < 0.84 && late.length) {
      // The parent an earlier entry named arrives, often carrying the task those entries now belong to.
      const id = late.splice(Math.floor(rnd() * late.length), 1)[0];
      push(chance(0.6) ? {type: 'custom', customType: 'apex-task-state', data: {taskId: task()}} : {type: 'message', message: {role: 'user', content: text()}},
        {id, parentId: chance(0.3) ? pick(ids) : parentFor()});
    } else if (r < 0.85) {
      push({type: 'session', version: 3}, {id: chance(0.5) ? 'header' : `late${next}`, parentId: null});
    } else if (r < 0.87) {
      push({type: 'message', message: {role: 'user', content: text()}}, {anonymous: true});
    } else if (r < 0.88 && errors) {
      entries.push(pick([null, [], {type: ''}, {type: 'custom', id: ''}, {type: 'custom', id: 7}, 'entry']));
    } else if (r < 0.885 && errors) {
      // A parent cycle without task state between its members.
      const a = `cycle${next++}`; const b = `cycle${next++}`;
      push({type: 'message', message: {role: 'assistant', provider: 'openai', model: 'm2', usage: usage(), stopReason: 'stop'}}, {id: a, parentId: b});
      push({type: 'custom', customType: 'other', data: {}}, {id: b, parentId: a});
    } else if (r < 0.89 && errors) {
      let deep = {}; for (let depth = 0; depth < 70; depth++) deep = {deep};
      push({type: 'custom', customType: 'apex-helper-usage', data: {version: 1, requestId: 'deep', complete: true, provider: 'openai', model: 'm2', usage: {...usage(), deep}}});
    } else {
      push({type: 'custom', customType: 'apex-features-state', data: {version: 1, turnCounter: next}});
    }
  }
  return entries.slice(0, n);
}

/** Pricing shapes findRates accepts, plus values a fingerprint cannot key; shared is changed in place between calls. */
export function pricingVariants() {
  const shared = {input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75};
  const pricing = [undefined, null, {...shared, cacheWrite1h: 6},
    {provider: 'openai', model: 'm2', input: 1, output: 2, cache_read: 0.1, cache_write: 1},
    {models: [{provider: 'openai', model: 'm2', input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1}, {provider: 'anthropic', id: 'm1', cost: 1}]},
    {'openai/m2': {input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1}, 'anthropic/m1': {input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75}},
    {provider: 'anthropic', model: 'm1', cost: {input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75}},
    // fingerprint() reads NaN and null alike, but rates tell them apart: such pricing is never a cache key.
    {input: 3, output: 15, cacheRead: NaN, cache_read: 0.3, cacheWrite: 3.75}, {input: 3, output: 15, cacheRead: null, cache_read: 0.3, cacheWrite: 3.75},
    Object.create({input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75}), {input: -0, output: 15, cacheRead: 0.3, cacheWrite: 3.75}];
  return {shared, pricing};
}

/**
 * Calls an extension makes while a session grows: every prefix as a fresh array of the same entry objects, with the
 * selected model and pricing switching now and then, plus repeated, cloned, shortened, rewritten and branch-scoped calls.
 */
export function* schedule(rnd, entries, {shared, pricing}) {
  const {pick, chance} = tools(rnd);
  const models = [{provider: 'anthropic', id: 'm1', contextWindow: 200000}, {provider: 'openai', id: 'm2'}, {provider: 'fixture', id: 'm1', contextWindow: 0},
    undefined, {provider: '', id: 'm1'}];
  const settings = () => chance(0.5) ? {model: models[0], pricing: shared} : {model: pick(models), pricing: chance(0.3) ? shared : pick(pricing)};
  let current = settings();
  for (let k = 0; k <= entries.length; k++) {
    if (chance(0.03)) current = settings();
    if (chance(0.02)) shared.output = pick([15, 16, 30]);
    const prefix = entries.slice(0, k);
    const leafIds = prefix.flatMap(entry => entry?.type !== 'session' && typeof entry?.id === 'string' ? [entry.id] : []);
    const r = rnd();
    const activeLeaf = r < 0.15 ? null : r < 0.35 ? undefined : r < 0.37 ? 'missing-leaf' : r < 0.45 && leafIds.length ? pick(leafIds) : leafIds.at(-1);
    const opts = {activeLeaf, ...current, context: pick([undefined, {tokens: Math.floor(rnd() * 1e5), contextWindow: 200000}, {tokens: 5, window: 100}, {tokens: -1}])};
    yield {prefix, opts, label: `prefix ${k}`};
    const extra = rnd();
    if (extra < 0.05) yield {prefix: entries.slice(0, k), opts, label: `prefix ${k} again`};
    else if (extra < 0.06) yield {prefix: structuredClone(prefix), opts, label: `cloned prefix ${k}`};
    else if (extra < 0.07 && k > 0) yield {prefix: entries.slice(0, Math.floor(rnd() * k)), opts, label: `shorter than ${k}`};
    else if (extra < 0.08 && k > 0) {
      // Another history at least as long: a copy with one earlier entry replaced.
      const changed = structuredClone(entries.slice(0, k + 1)); const index = Math.floor(rnd() * k);
      changed[index] = {type: 'custom_message', id: changed[index]?.id, parentId: changed[index]?.parentId, content: 'changed history'};
      yield {prefix: changed, opts, label: `changed history at ${k}`};
    } else if (extra < 0.09) {
      const branch = pick([activeLeaf ?? null, pick([...leafIds, 'missing-leaf']), leafIds.slice(-3), prefix.filter(() => chance(0.5)), ['missing-leaf']]);
      yield {prefix, opts: {...opts, activeLeaf: chance(0.5) ? undefined : activeLeaf, branch}, label: `branch at ${k}`};
    }
  }
}
