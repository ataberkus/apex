import {gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

// Fixture sources are String.raw templates: they never contain a backtick or "${".
const js = String.raw;

const SPEC = `# Access policy engine

\`src/acl.js\` exports \`compile(policy)\` and the error classes \`PolicyError\` and \`RequestError\`. \`compile\` validates a policy and returns an object with one method, \`authorize(request)\`, which returns a decision. Everything in this document is normative.

"Plain object" below means a value that is not \`null\`, has \`typeof\` \`'object'\` and is not an array. An optional property is *absent* only when it is not an own property of its object; a present optional property must be valid, even when its value is \`undefined\`.

## Policy

A policy is a plain object whose property \`roles\` is a plain object mapping role names to role definitions. Other policy properties are ignored.

- A role name matches \`^[a-z][a-z0-9_-]*$\`.
- A role definition is a plain object with two optional properties: \`inherits\`, an array of names of roles of the same policy (default \`[]\`), and \`rules\`, an array of rules (default \`[]\`). Other properties are ignored.
- A rule is a plain object with these properties (others are ignored):
  - \`effect\` (required): \`"allow"\` or \`"deny"\`.
  - \`actions\` (required): a non-empty array of action patterns.
  - \`resources\` (required): a non-empty array of resource patterns.
  - \`priority\` (optional, default \`0\`): an integer (\`Number.isInteger\`) from -1000 to 1000 inclusive.
  - \`when\` (optional): a condition.
- A rule is identified as \`<role>#<index>\`, where \`<role>\` is the name of the role whose \`rules\` array contains it and \`<index>\` its zero-based position in that array.

\`compile\` copies what it needs: mutating the policy object (or anything reachable from it) after \`compile\` returns never changes the decisions of the compiled policy.

## Requests

A request is a plain object:

- \`subject\` (required): a plain object with \`roles\`, an array of strings, and an optional \`attrs\`, a plain object (default \`{}\`).
- \`action\` (required): a string \`<service>:<verb>\` where both parts match \`^[a-z][a-z0-9-]*$\`.
- \`resource\` (required): a string of one or more segments separated by \`/\`, each segment matching \`^[A-Za-z0-9._-]+$\`.
- \`context\` (optional): a plain object (default \`{}\`).

## Patterns

An **action pattern** is either \`*\` (which means \`*:*\`) or \`<service>:<verb>\` where each part is either \`*\` or matches \`^[a-z][a-z0-9-]*$\`. A \`*\` part matches any part; a literal part matches exactly that text. Matching is case-sensitive.

A **resource pattern** is a string of one or more segments separated by \`/\`. Each segment is one of:

- a literal matching \`^[A-Za-z0-9._-]+$\`, which matches exactly that segment;
- \`*\`, which matches exactly one segment;
- \`{name}\`, where \`name\` matches \`^[a-z][a-z0-9_]*$\`, which matches exactly one segment and captures it as the variable \`name\`;
- \`**\`, which matches zero or more segments.

A resource pattern contains at most one \`**\` segment. A pattern matches a resource only when it matches the whole resource. A variable may occur several times in one pattern; the pattern then only matches when every occurrence captures the same text. (With at most one \`**\`, a matching pattern determines its captures uniquely.)

## Specificity

The **resource specificity** of a resource pattern is the triple (L, S, G): L is its number of literal segments, S its number of \`*\` and \`{name}\` segments, G is 1 when it contains \`**\` and 0 otherwise. Pattern A is more specific than pattern B when A has more literal segments; with equal L, when A has more single-segment wildcards (S); with equal L and S, when A has no \`**\` and B has one. Equal triples are equally specific.

The **action specificity** of an action pattern is its number of literal parts: 2 for \`docs:read\`, 1 for \`docs:*\` or \`*:read\`, 0 for \`*:*\` and \`*\`.

## Effective roles

The subject's effective roles are the policy roles named in \`subject.roles\`, plus every role they inherit, directly or transitively. Names in \`subject.roles\` that are not roles of the policy are ignored; they are not an error. A role reached more than once counts once.

## Conditions

A condition is a plain object with exactly one own property, the operator:

- \`{"all": [c, ...]}\` and \`{"any": [c, ...]}\`: an array (possibly empty) of conditions.
- \`{"not": c}\`: one condition.
- \`{"eq": [a, b]}\`, \`{"ne": [a, b]}\`, \`{"lt": [a, b]}\`, \`{"le": [a, b]}\`, \`{"gt": [a, b]}\`, \`{"ge": [a, b]}\`, \`{"in": [a, b]}\`, \`{"prefix": [a, b]}\`: an array of exactly two operands.
- \`{"has": path}\`: a path string.

An operand is a literal (a string, a finite number, a boolean, \`null\`, or an array whose elements are all such values) or a reference \`{"ref": path}\` (a plain object with exactly one own property, \`ref\`). A path is a string of parts separated by \`.\`: \`subject.<key>(.<key>)*\` reads \`subject.attrs\`, \`context.<key>(.<key>)*\` reads the request context (keys are non-empty), and \`resource.<name>\` (exactly two parts, \`<name>\` with the variable grammar above) reads a variable captured by the resource pattern being evaluated.

**Resolving** a path: start from the object named by the first part (\`subject.attrs\`, \`context\`, or the captures of the pattern) and follow the remaining parts. When the current value is not a plain object (arrays and \`null\` are not), or the key is not an own property of it, the reference is *missing*. Otherwise the final value, whatever it is (including \`null\`), is the operand's value.

Evaluation yields \`true\`, \`false\` or \`unknown\`:

- \`eq\`, \`ne\`, \`lt\`, \`le\`, \`gt\`, \`ge\`, \`in\`, \`prefix\`: \`unknown\` when either operand is a missing reference. Otherwise:
  - \`eq\`: \`true\` when neither value is an array or object and \`a === b\`; \`false\` otherwise (so two arrays are never \`eq\`).
  - \`ne\`: the negation of \`eq\`.
  - \`lt\`, \`le\`, \`gt\`, \`ge\`: when both values are numbers, or both are strings, the result of the JavaScript operator \`<\`, \`<=\`, \`>\`, \`>=\` (strings compare by UTF-16 code units); \`false\` for any other combination of types.
  - \`in\`: \`true\` when \`b\` is an array with an element that is \`eq\` to \`a\`; otherwise \`false\`.
  - \`prefix\`: \`true\` when both values are strings and \`a\` starts with \`b\`; otherwise \`false\`.
- \`has\`: \`true\` when the path resolves, \`false\` when it is missing. Never \`unknown\`.
- \`not\`: swaps \`true\` and \`false\`; \`unknown\` stays \`unknown\`.
- \`all\`: \`false\` when any member is \`false\`; otherwise \`unknown\` when any member is \`unknown\`; otherwise \`true\` (an empty \`all\` is \`true\`).
- \`any\`: \`true\` when any member is \`true\`; otherwise \`unknown\` when any member is \`unknown\`; otherwise \`false\` (an empty \`any\` is \`false\`).

## Applicable rules

Consider every rule of every effective role. A rule's action patterns that match the request action are its *matching action patterns*; likewise for resource patterns. A rule without a matching action pattern or without a matching resource pattern is not applicable.

Each matching resource pattern is evaluated separately: the rule's \`when\` condition is evaluated with that pattern's captures (no \`when\` counts as \`true\`). The pattern **applies** when the result is \`true\` or, for deny rules only, \`unknown\` (deny fails closed; allow needs a definite \`true\`). A rule is **applicable** when at least one of its matching resource patterns applies. Its resource specificity is that of its most specific *applying* pattern, and its action specificity that of its most specific matching action pattern.

## Decision

\`authorize(request)\` returns a new plain object with exactly two properties, \`decision\` and \`rule\`.

Without applicable rules it returns \`{decision: "deny", rule: null}\`. Otherwise the applicable rules are ordered by the following keys, each consulted only to break ties of the previous ones:

1. higher \`priority\` first;
2. more specific resource specificity first;
3. higher action specificity first;
4. deny before allow;
5. role name ascending, comparing UTF-16 code units;
6. lower rule index first.

The first rule in that order wins: the result is \`{decision: <its effect>, rule: "<role>#<index>"}\`.

## Errors

\`PolicyError\` and \`RequestError\` extend \`Error\`; their \`name\` is the class name. \`<name>\` and \`<value>\` below are \`String(JSON.stringify(x))\` of the offending role name or value (so a role \`ops\` appears as \`"ops"\`, and \`undefined\` as \`undefined\`).

\`compile(policy)\` checks the policy in this order and throws a \`PolicyError\` for the first problem:

1. \`policy\` or \`policy.roles\` is not a plain object: \`policy: roles must be an object\`.
2. Each role, in \`Object.keys(policy.roles)\` order, completely before the next role:
   1. invalid role name: \`role <name>: invalid name\`;
   2. the definition is not a plain object: \`role <name>: definition must be an object\`;
   3. \`inherits\` is present and not an array: \`role <name>: inherits must be an array\`; then each entry in order that is not the name (a string) of a role in \`policy.roles\`: \`role <name>: unknown inherited role <value>\`;
   4. \`rules\` is present and not an array: \`role <name>: rules must be an array\`; then each rule in order, with the prefix \`role <name> rule <index>: \`, checking its properties in this order: the rule is not a plain object: \`must be an object\`; \`invalid effect\`; \`actions\` is not a non-empty array: \`actions must be a non-empty array\`; then the first invalid entry: \`invalid action pattern <value>\`; \`resources\` is not a non-empty array: \`resources must be a non-empty array\`; then the first invalid entry: \`invalid resource pattern <value>\`; \`invalid priority\`; \`invalid condition\` (any problem anywhere inside \`when\`).
3. After all roles: inheritance cycles. Visit the roles depth-first, starting from each not yet visited role in \`Object.keys\` order and following each role's \`inherits\` in array order. The first time an \`inherits\` entry names a role that is on the current path, throw \`inheritance cycle: <cycle>\`, where \`<cycle>\` lists the role names (plain, without quotes) from that role along the path back to itself, joined by \` -> \`: \`inheritance cycle: b -> c -> b\`, or \`inheritance cycle: a -> a\` for a role inheriting itself.

\`authorize(request)\` checks the request in this order and throws a \`RequestError\`:

1. not a plain object: \`request must be an object\`;
2. invalid \`subject\` (including its \`roles\` and \`attrs\`): \`invalid subject\`;
3. invalid \`action\`: \`invalid action <value>\`;
4. invalid \`resource\`: \`invalid resource <value>\`;
5. invalid \`context\`: \`invalid context\`.
`;

const DRAFT = js`/** Access policy engine (early draft); see docs/POLICY.md. */
export class PolicyError extends Error {}
export class RequestError extends Error {}

const matches = (pattern, value) => pattern === '*' || pattern === value;

export function compile(policy) {
  if (!policy || typeof policy.roles !== 'object') throw new PolicyError('policy: roles must be an object');
  for (const [name, role] of Object.entries(policy.roles)) {
    for (const [index, rule] of (role.rules ?? []).entries()) {
      if (rule.effect !== 'allow' && rule.effect !== 'deny') throw new PolicyError('role ' + JSON.stringify(name) + ' rule ' + index + ': invalid effect');
    }
  }
  return {
    authorize(request) {
      let allow = null;
      for (const name of request.subject.roles) {
        for (const [index, rule] of (policy.roles[name]?.rules ?? []).entries()) {
          if (!rule.actions.some(p => matches(p, request.action)) || !rule.resources.some(p => matches(p, request.resource))) continue;
          if (rule.effect === 'deny') return {decision: 'deny', rule: name + '#' + index};
          allow ??= name + '#' + index;
        }
      }
      return allow ? {decision: 'allow', rule: allow} : {decision: 'deny', rule: null};
    },
  };
}
`;

const VISIBLE = js`import test from 'node:test';
import assert from 'node:assert/strict';
import {compile, PolicyError} from '../src/acl.js';

const policy = compile({roles: {
  reader: {rules: [{effect: 'allow', actions: ['docs:read'], resources: ['docs/**']}]},
  editor: {inherits: ['reader'], rules: [
    {effect: 'allow', actions: ['docs:*'], resources: ['docs/*']},
    {effect: 'deny', actions: ['docs:*'], resources: ['docs/*']},
  ]},
}});
const ask = (roles, action, resource) => policy.authorize({subject: {roles}, action, resource});

test('allow by a direct rule', () => {
  assert.deepEqual(ask(['reader'], 'docs:read', 'docs/a/b'), {decision: 'allow', rule: 'reader#0'});
});

test('nothing applicable: default deny', () => {
  assert.deepEqual(ask(['reader'], 'docs:write', 'docs/a'), {decision: 'deny', rule: null});
});

test('inherited rules apply', () => {
  assert.deepEqual(ask(['editor'], 'docs:read', 'docs/a/b'), {decision: 'allow', rule: 'reader#0'});
});

test('deny wins a tie', () => {
  assert.deepEqual(ask(['editor'], 'docs:delete', 'docs/a'), {decision: 'deny', rule: 'editor#1'});
});

test('invalid effect', () => {
  assert.throws(() => compile({roles: {ops: {rules: [{effect: 'permit', actions: ['*'], resources: ['**']}]}}}),
    error => error instanceof PolicyError && error.message === 'role "ops" rule 0: invalid effect');
});
`;

const REFERENCE = js`/** Access policy engine; see docs/POLICY.md. */
export class PolicyError extends Error {
  constructor(message) { super(message); this.name = 'PolicyError'; }
}
export class RequestError extends Error {
  constructor(message) { super(message); this.name = 'RequestError'; }
}

const ROLE = /^[a-z][a-z0-9_-]*$/;
const PART = /^[a-z][a-z0-9-]*$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const VARIABLE = /^\{([a-z][a-z0-9_]*)\}$/;
const NAME = /^[a-z][a-z0-9_]*$/;
const COMPARISONS = new Set(['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'in', 'prefix']);
const UNKNOWN = 'unknown';
const MISSING = Symbol('missing');

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isLiteral = value => value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
const show = value => String(JSON.stringify(value));

function parseAction(pattern) {
  if (pattern === '*') return ['*', '*'];
  if (typeof pattern !== 'string') return null;
  const parts = pattern.split(':');
  return parts.length === 2 && parts.every(part => part === '*' || PART.test(part)) ? parts : null;
}

function parseResource(pattern) {
  if (typeof pattern !== 'string') return null;
  const segments = [];
  let literals = 0, singles = 0, globs = 0;
  for (const text of pattern.split('/')) {
    const variable = VARIABLE.exec(text);
    if (text === '**') { globs++; segments.push({kind: 'glob'}); }
    else if (text === '*') { singles++; segments.push({kind: 'any'}); }
    else if (variable) { singles++; segments.push({kind: 'var', name: variable[1]}); }
    else if (SEGMENT.test(text)) { literals++; segments.push({kind: 'literal', text}); }
    else return null;
  }
  return globs > 1 ? null : {segments, specificity: [literals, singles, -globs]};
}

function validPath(path) {
  if (typeof path !== 'string') return false;
  const parts = path.split('.');
  if (parts[0] === 'resource') return parts.length === 2 && NAME.test(parts[1]);
  return (parts[0] === 'subject' || parts[0] === 'context') && parts.length >= 2 && parts.every(part => part !== '');
}

const validOperand = value => isLiteral(value) || (Array.isArray(value) && value.every(isLiteral)) ||
  (isObject(value) && Object.keys(value).length === 1 && Object.hasOwn(value, 'ref') && validPath(value.ref));

function validCondition(condition) {
  if (!isObject(condition) || Object.keys(condition).length !== 1) return false;
  const [op] = Object.keys(condition), arg = condition[op];
  if (op === 'all' || op === 'any') return Array.isArray(arg) && arg.every(validCondition);
  if (op === 'not') return validCondition(arg);
  if (op === 'has') return validPath(arg);
  return COMPARISONS.has(op) && Array.isArray(arg) && arg.length === 2 && arg.every(validOperand);
}

function resolve(path, scope) {
  const [root, ...keys] = path.split('.');
  let value = scope[root];
  for (const key of keys) {
    if (!isObject(value) || !Object.hasOwn(value, key)) return MISSING;
    value = value[key];
  }
  return value;
}

const isScalar = value => value === null || typeof value !== 'object';
const equal = (a, b) => isScalar(a) && isScalar(b) && a === b;
const comparable = (a, b) => (typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string');

function evaluate(condition, scope) {
  const [op] = Object.keys(condition), arg = condition[op];
  if (op === 'all' || op === 'any') {
    const decisive = op === 'any';
    let result = !decisive;
    for (const member of arg) {
      const value = evaluate(member, scope);
      if (value === decisive) return decisive;
      if (value === UNKNOWN) result = UNKNOWN;
    }
    return result;
  }
  if (op === 'not') { const value = evaluate(arg, scope); return value === UNKNOWN ? UNKNOWN : !value; }
  if (op === 'has') return resolve(arg, scope) !== MISSING;
  const [a, b] = arg.map(operand => isObject(operand) ? resolve(operand.ref, scope) : operand);
  if (a === MISSING || b === MISSING) return UNKNOWN;
  switch (op) {
    case 'eq': return equal(a, b);
    case 'ne': return !equal(a, b);
    case 'lt': return comparable(a, b) && a < b;
    case 'le': return comparable(a, b) && a <= b;
    case 'gt': return comparable(a, b) && a > b;
    case 'ge': return comparable(a, b) && a >= b;
    case 'in': return Array.isArray(b) && b.some(item => equal(a, item));
    default: return typeof a === 'string' && typeof b === 'string' && a.startsWith(b);
  }
}

function matchSegments(segments, parts, captures) {
  if (segments.length !== parts.length) return false;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i], part = parts[i];
    if (segment.kind === 'literal' && segment.text !== part) return false;
    if (segment.kind === 'var') {
      if (Object.hasOwn(captures, segment.name) && captures[segment.name] !== part) return false;
      captures[segment.name] = part;
    }
  }
  return true;
}

function matchResource(pattern, parts) {
  const captures = {};
  const glob = pattern.segments.findIndex(segment => segment.kind === 'glob');
  if (glob < 0) return matchSegments(pattern.segments, parts, captures) ? captures : null;
  const head = pattern.segments.slice(0, glob), tail = pattern.segments.slice(glob + 1);
  if (parts.length < head.length + tail.length) return null;
  return matchSegments(head, parts.slice(0, head.length), captures) &&
    matchSegments(tail, parts.slice(parts.length - tail.length), captures) ? captures : null;
}

/** Positive when specificity a beats b. */
function compareSpecificity(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function compileRule(rule, fail) {
  if (!isObject(rule)) fail('must be an object');
  if (rule.effect !== 'allow' && rule.effect !== 'deny') fail('invalid effect');
  if (!Array.isArray(rule.actions) || !rule.actions.length) fail('actions must be a non-empty array');
  const actions = rule.actions.map(pattern => parseAction(pattern) ?? fail('invalid action pattern ' + show(pattern)));
  if (!Array.isArray(rule.resources) || !rule.resources.length) fail('resources must be a non-empty array');
  const resources = rule.resources.map(pattern => parseResource(pattern) ?? fail('invalid resource pattern ' + show(pattern)));
  if (Object.hasOwn(rule, 'priority') && !(Number.isInteger(rule.priority) && rule.priority >= -1000 && rule.priority <= 1000)) fail('invalid priority');
  if (Object.hasOwn(rule, 'when') && !validCondition(rule.when)) fail('invalid condition');
  return {effect: rule.effect, actions, resources, priority: rule.priority ?? 0,
    when: Object.hasOwn(rule, 'when') ? structuredClone(rule.when) : null};
}

export function compile(policy) {
  if (!isObject(policy) || !isObject(policy.roles)) throw new PolicyError('policy: roles must be an object');
  const source = policy.roles;
  const roles = new Map();
  for (const name of Object.keys(source)) {
    const fail = message => { throw new PolicyError('role ' + show(name) + ': ' + message); };
    if (!ROLE.test(name)) fail('invalid name');
    const definition = source[name];
    if (!isObject(definition)) fail('definition must be an object');
    const inherits = Object.hasOwn(definition, 'inherits') ? definition.inherits : [];
    if (!Array.isArray(inherits)) fail('inherits must be an array');
    for (const parent of inherits) if (typeof parent !== 'string' || !Object.hasOwn(source, parent)) fail('unknown inherited role ' + show(parent));
    const rules = Object.hasOwn(definition, 'rules') ? definition.rules : [];
    if (!Array.isArray(rules)) fail('rules must be an array');
    const compiled = rules.map((rule, index) => compileRule(rule, message => {
      throw new PolicyError('role ' + show(name) + ' rule ' + index + ': ' + message);
    }));
    roles.set(name, {inherits: [...inherits], rules: compiled});
  }

  const state = new Map(), path = [];
  const visit = name => {
    state.set(name, 'open');
    path.push(name);
    for (const parent of roles.get(name).inherits) {
      if (state.get(parent) === 'open') throw new PolicyError('inheritance cycle: ' + [...path.slice(path.indexOf(parent)), parent].join(' -> '));
      if (!state.has(parent)) visit(parent);
    }
    path.pop();
    state.set(name, 'done');
  };
  for (const name of roles.keys()) if (!state.has(name)) visit(name);

  return {authorize: request => authorize(roles, request)};
}

function authorize(roles, request) {
  if (!isObject(request)) throw new RequestError('request must be an object');
  const {subject, action, resource} = request;
  if (!isObject(subject) || !Array.isArray(subject.roles) || !subject.roles.every(role => typeof role === 'string') ||
    (Object.hasOwn(subject, 'attrs') && !isObject(subject.attrs))) throw new RequestError('invalid subject');
  const verb = typeof action === 'string' ? action.split(':') : [];
  if (verb.length !== 2 || !verb.every(part => PART.test(part))) throw new RequestError('invalid action ' + show(action));
  const parts = typeof resource === 'string' ? resource.split('/') : [];
  if (!parts.length || !parts.every(part => SEGMENT.test(part))) throw new RequestError('invalid resource ' + show(resource));
  if (Object.hasOwn(request, 'context') && !isObject(request.context)) throw new RequestError('invalid context');
  const attrs = Object.hasOwn(subject, 'attrs') ? subject.attrs : {};
  const context = Object.hasOwn(request, 'context') ? request.context : {};

  const effective = new Set();
  const add = name => { if (effective.has(name)) return; effective.add(name); roles.get(name).inherits.forEach(add); };
  for (const name of subject.roles) if (roles.has(name)) add(name);

  let best = null;
  for (const role of effective) {
    roles.get(role).rules.forEach((rule, index) => {
      let actionSpecificity = -1;
      for (const [service, name] of rule.actions) {
        if ((service === '*' || service === verb[0]) && (name === '*' || name === verb[1])) {
          actionSpecificity = Math.max(actionSpecificity, (service !== '*') + (name !== '*'));
        }
      }
      if (actionSpecificity < 0) return;
      let resourceSpecificity = null;
      for (const pattern of rule.resources) {
        const captures = matchResource(pattern, parts);
        if (!captures) continue;
        const result = rule.when ? evaluate(rule.when, {subject: attrs, context, resource: captures}) : true;
        if (result === true || (result === UNKNOWN && rule.effect === 'deny')) {
          if (!resourceSpecificity || compareSpecificity(pattern.specificity, resourceSpecificity) > 0) resourceSpecificity = pattern.specificity;
        }
      }
      if (!resourceSpecificity) return;
      const candidate = {role, index, effect: rule.effect, priority: rule.priority, resourceSpecificity, actionSpecificity};
      if (!best || beats(candidate, best)) best = candidate;
    });
  }
  return best ? {decision: best.effect, rule: best.role + '#' + best.index} : {decision: 'deny', rule: null};
}

function beats(a, b) {
  if (a.priority !== b.priority) return a.priority > b.priority;
  const specificity = compareSpecificity(a.resourceSpecificity, b.resourceSpecificity);
  if (specificity) return specificity > 0;
  if (a.actionSpecificity !== b.actionSpecificity) return a.actionSpecificity > b.actionSpecificity;
  if (a.effect !== b.effect) return a.effect === 'deny';
  if (a.role !== b.role) return a.role < b.role;
  return a.index < b.index;
}
`;

// ---- Hidden cases ------------------------------------------------------------------------------
const A = (actions, resources, extra = {}) => ({effect: 'allow', actions, resources, ...extra});
const D = (actions, resources, extra = {}) => ({effect: 'deny', actions, resources, ...extra});
const ref = path => ({ref: path});
const req = (roles, action, resource, attrs, context) => ({subject: attrs === undefined ? {roles} : {roles, attrs}, action, resource, ...(context === undefined ? {} : {context})});
const ok = (decision, rule = null) => ({decision, rule});
const policyError = message => ({error: 'PolicyError', message});
const requestError = message => ({error: 'RequestError', message});

const ORG = {roles: {
  reader: {rules: [A(['docs:read'], ['org/{org}/docs/**'], {when: {eq: [ref('subject.org'), ref('resource.org')]}})]},
  writer: {inherits: ['reader'], rules: [A(['docs:write'], ['org/{org}/docs/*'], {when: {eq: [ref('subject.org'), ref('resource.org')]}})]},
  lead: {inherits: ['writer'], rules: [D(['docs:*'], ['org/{org}/docs/locked'])]},
  root: {rules: [A(['*'], ['**'], {priority: 5})]},
}};
const SPECIFIC = {roles: {s: {rules: [
  A(['x:read'], ['a/b/*']), D(['x:read'], ['a/*/*']), D(['x:read'], ['a/**']), A(['x:read'], ['a/*/c/*']), D(['x:read'], ['a/**/d']),
]}}};
const GLOB = {roles: {g: {rules: [D(['x:read'], ['a/b/**']), A(['x:read'], ['a/b'])]}}};
const ACTIONS = {roles: {act: {rules: [
  A(['x:read'], ['r/*']), D(['x:*'], ['r/*']), D(['*'], ['r/{id}']), A(['*:read'], ['r/s']), A(['y:read'], ['r/*']), D(['y:read'], ['r/{n}']),
]}}};
const PRIORITY = {roles: {p: {rules: [
  D(['x:read'], ['p/q/r']), A(['x:read'], ['**'], {priority: 1}), D(['x:read'], ['p/**'], {priority: 1}),
  A(['x:write'], ['p/q/r'], {priority: -1}), D(['x:write'], ['**'], {priority: -2}), A(['x:list'], ['**']), D(['x:list'], ['p/q/r'], {priority: -1}),
]}}};
const TIES = {roles: {
  beta: {rules: [A(['x:read'], ['t/*'])]},
  alpha: {rules: [D(['x:write'], ['t/*']), A(['x:read'], ['t/{v}'])]},
  'a_b': {rules: [A(['y:read'], ['t/*'])]},
  'a-b': {rules: [A(['y:read'], ['t/*'])]},
  same: {rules: [A(['z:write'], ['t/*']), A(['z:read'], ['t/*']), A(['z:read'], ['t/{v}'])]},
  heir: {inherits: ['beta', 'alpha'], rules: [A(['x:read'], ['t/*'])]},
}};
const CAPTURES = {roles: {cap: {rules: [
  A(['x:read'], ['a/b/c', 'a/{y}/**'], {when: {eq: [ref('resource.y'), 'b']}}),
  D(['x:read'], ['a/b/*']),
  A(['x:read'], ['**', 'k/{id}'], {when: {eq: [ref('resource.id'), 'k1']}}),
  D(['x:read'], ['k/**']),
  A(['x:list'], ['u/{x}/v/{x}']),
]}}};

// A deny on resource "z" guarded by the condition, under a blanket allow: the deny applies on true or unknown.
const denyIf = (name, when, attrs, context, applies) =>
  [name, {roles: {r: {rules: [A(['x:go'], ['**']), D(['x:go'], ['z'], {when})]}}}, req(['r'], 'x:go', 'z', attrs, context), applies ? ok('deny', 'r#1') : ok('allow', 'r#0')];
// An allow guarded by the condition: it only applies on true.
const allowIf = (name, when, attrs, context, applies) =>
  [name, {roles: {r: {rules: [A(['x:go'], ['z'], {when})]}}}, req(['r'], 'x:go', 'z', attrs, context), applies ? ok('allow', 'r#0') : ok('deny')];
const missingDept = {eq: [ref('subject.dept'), 'x']};

const VALID_RULE = A(['*'], ['**']);
const ruleError = (name, rule, message) => [name, {roles: {ops: {rules: [VALID_RULE, rule]}}}, null, policyError('role "ops" rule 1: ' + message)];
const SIMPLE = {roles: {r: {rules: [VALID_RULE]}}};

// [name, policy, request or null (compile must throw), expected]
const CASES = [
  ['unknown subject roles are ignored', ORG, req(['ghost', 'reader'], 'docs:read', 'org/acme/docs/a/b', {org: 'acme'}), ok('allow', 'reader#0')],
  ['only unknown roles: default deny', ORG, req(['ghost'], 'docs:read', 'org/acme/docs/a', {org: 'acme'}), ok('deny')],
  ['inheritance is transitive', ORG, req(['lead'], 'docs:read', 'org/acme/docs/x', {org: 'acme'}), ok('allow', 'reader#0')],
  ['condition false: default deny', ORG, req(['reader'], 'docs:read', 'org/acme/docs/x', {org: 'other'}), ok('deny')],
  ['** matches zero segments', ORG, req(['reader'], 'docs:read', 'org/acme/docs', {org: 'acme'}), ok('allow', 'reader#0')],
  ['more literal segments win', ORG, req(['lead'], 'docs:write', 'org/acme/docs/locked', {org: 'acme'}), ok('deny', 'lead#0')],
  ['more literal segments win over an inherited **', ORG, req(['lead'], 'docs:read', 'org/acme/docs/locked', {org: 'acme'}), ok('deny', 'lead#0')],
  ['priority beats specificity', ORG, req(['lead', 'root'], 'docs:write', 'org/acme/docs/locked', {org: 'acme'}), ok('allow', 'root#0')],
  ['* matches exactly one segment', ORG, req(['writer'], 'docs:write', 'org/acme/docs/a/b', {org: 'acme'}), ok('deny')],
  ['* matches exactly one segment (none)', SPECIFIC, req(['s'], 'x:read', 'a/b'), ok('deny', 's#2')],
  ['literals first', SPECIFIC, req(['s'], 'x:read', 'a/b/c'), ok('allow', 's#0')],
  ['then single wildcards', SPECIFIC, req(['s'], 'x:read', 'a/q/c'), ok('deny', 's#1')],
  ['single wildcards beat **', SPECIFIC, req(['s'], 'x:read', 'a/q/c/d'), ok('allow', 's#3')],
  ['** in the middle', SPECIFIC, req(['s'], 'x:read', 'a/q/r/d'), ok('deny', 's#4')],
  ['** after the only literal', SPECIFIC, req(['s'], 'x:read', 'a'), ok('deny', 's#2')],
  ['no ** beats **', GLOB, req(['g'], 'x:read', 'a/b'), ok('allow', 'g#1')],
  ['** below', GLOB, req(['g'], 'x:read', 'a/b/c'), ok('deny', 'g#0')],
  ['action specificity', ACTIONS, req(['act'], 'x:read', 'r/t'), ok('allow', 'act#0')],
  ['service wildcard beats *', ACTIONS, req(['act'], 'x:write', 'r/t'), ok('deny', 'act#1')],
  ['resource specificity before action specificity', ACTIONS, req(['act'], 'x:read', 'r/s'), ok('allow', 'act#3')],
  ['*:read does not match a write', ACTIONS, req(['act'], 'x:write', 'r/s'), ok('deny', 'act#1')],
  ['* as action matches any action', ACTIONS, req(['act'], 'zz-top:run', 'r/q'), ok('deny', 'act#2')],
  ['deny wins a full tie', ACTIONS, req(['act'], 'y:read', 'r/t'), ok('deny', 'act#5')],
  ['higher priority deny', PRIORITY, req(['p'], 'x:read', 'p/q/r'), ok('deny', 'p#2')],
  ['priority allow on **', PRIORITY, req(['p'], 'x:read', 'zz'), ok('allow', 'p#1')],
  ['negative priorities', PRIORITY, req(['p'], 'x:write', 'p/q/r'), ok('allow', 'p#3')],
  ['default priority beats a negative one', PRIORITY, req(['p'], 'x:list', 'p/q/r'), ok('allow', 'p#5')],
  ['role name breaks ties', TIES, req(['beta', 'alpha'], 'x:read', 't/1'), ok('allow', 'alpha#1')],
  ['role names compare by code units', TIES, req(['a_b', 'a-b'], 'y:read', 't/1'), ok('allow', 'a-b#0')],
  ['rule index breaks ties', TIES, req(['same'], 'z:read', 't/1'), ok('allow', 'same#1')],
  ['inherited roles take part in ties', TIES, req(['heir'], 'x:read', 't/1'), ok('allow', 'alpha#1')],
  ['duplicate subject roles', TIES, req(['beta', 'beta', 'heir'], 'x:write', 't/1'), ok('deny', 'alpha#0')],
  ['specificity of applying patterns only', CAPTURES, req(['cap'], 'x:read', 'a/b/c'), ok('deny', 'cap#1')],
  ['each pattern is evaluated with its own captures', CAPTURES, req(['cap'], 'x:read', 'k/k1'), ok('allow', 'cap#2')],
  ['repeated variable must agree', CAPTURES, req(['cap'], 'x:list', 'u/1/v/1'), ok('allow', 'cap#4')],
  ['repeated variable disagrees', CAPTURES, req(['cap'], 'x:list', 'u/1/v/2'), ok('deny')],
  ['case-sensitive resources', SPECIFIC, req(['s'], 'x:read', 'A/b/c'), ok('deny')],

  denyIf('deny applies on unknown', missingDept, {}, undefined, true),
  allowIf('allow does not apply on unknown', missingDept, {}, undefined, false),
  denyIf('not unknown is unknown', {not: missingDept}, {}, undefined, true),
  allowIf('not unknown never allows', {not: missingDept}, {}, undefined, false),
  denyIf('all: false dominates unknown', {all: [missingDept, {eq: [1, 2]}]}, {}, undefined, false),
  denyIf('all: unknown and true', {all: [missingDept, {eq: [1, 1]}]}, {}, undefined, true),
  allowIf('any: true dominates unknown', {any: [missingDept, {eq: [1, 1]}]}, {}, undefined, true),
  denyIf('any: unknown and false', {any: [missingDept, {eq: [1, 2]}]}, {}, undefined, true),
  allowIf('any: unknown and false never allows', {any: [missingDept, {eq: [1, 2]}]}, {}, undefined, false),
  allowIf('empty all is true', {all: []}, {}, undefined, true),
  denyIf('empty any is false', {any: []}, {}, undefined, false),
  allowIf('not false', {not: {any: [{eq: [1, 2]}, {lt: ['a', 1]}]}}, {}, undefined, true),
  denyIf('has is never unknown', {has: 'subject.dept'}, {}, undefined, false),
  denyIf('not has', {not: {has: 'subject.dept'}}, {}, undefined, true),
  allowIf('null is a value', {eq: [ref('subject.manager'), null]}, {manager: null}, undefined, true),
  allowIf('has null', {has: 'subject.manager'}, {manager: null}, undefined, true),
  denyIf('has through null', {has: 'subject.manager.id'}, {manager: null}, undefined, false),
  denyIf('ref through null is missing', {eq: [ref('subject.manager.id'), 1]}, {manager: null}, undefined, true),
  allowIf('nested attrs', {eq: [ref('subject.profile.level'), 3]}, {profile: {level: 3}}, undefined, true),
  denyIf('arrays are not traversed', {eq: [ref('subject.tags.0'), 'a']}, {tags: ['a']}, undefined, true),
  denyIf('inherited keys are not own', {eq: [ref('subject.profile.toString'), 1]}, {profile: {}}, undefined, true),
  allowIf('ne with a missing operand', {ne: [ref('subject.dept'), 'x']}, {}, undefined, false),
  denyIf('ne with a missing operand is unknown', {ne: [ref('subject.dept'), 'x']}, {}, undefined, true),
  allowIf('arrays are never eq, so ne', {ne: [ref('subject.tags'), ['a']]}, {tags: ['a']}, undefined, true),
  allowIf('arrays are never eq', {eq: [ref('subject.tags'), ref('subject.tags')]}, {tags: ['a']}, undefined, false),
  allowIf('objects are never eq', {eq: [ref('subject.profile'), ref('subject.profile')]}, {profile: {}}, undefined, false),
  allowIf('eq is strict', {eq: [ref('subject.level'), '3']}, {level: 3}, undefined, false),
  denyIf('lt across types is false', {lt: [ref('subject.age'), 18]}, {age: '17'}, undefined, false),
  denyIf('ge with null is false', {ge: [ref('subject.age'), 18]}, {age: null}, undefined, false),
  allowIf('lt numbers', {lt: [ref('subject.age'), 18]}, {age: 17}, undefined, true),
  allowIf('le equal', {le: [ref('subject.age'), 17]}, {age: 17}, undefined, true),
  allowIf('gt equal', {gt: [ref('subject.age'), 17]}, {age: 17}, undefined, false),
  allowIf('strings compare by code unit', {lt: ['B', 'a']}, {}, undefined, true),
  allowIf('strings compare by code unit (reverse)', {lt: ['a', 'B']}, {}, undefined, false),
  allowIf('accented letters sort after z', {gt: ['\u00e9', 'z']}, {}, undefined, true),
  allowIf('in a literal list', {in: [ref('subject.dept'), ['ops', 'dev']]}, {dept: 'dev'}, undefined, true),
  allowIf('in a non-array', {in: ['dev', ref('subject.dept')]}, {dept: 'dev'}, undefined, false),
  allowIf('in an attribute list', {in: ['a', ref('subject.tags')]}, {tags: ['b', 'a']}, undefined, true),
  denyIf('in with a missing operand', {in: [ref('subject.dept'), ['x']]}, {}, undefined, true),
  allowIf('prefix', {prefix: [ref('context.ip'), '10.']}, {}, {ip: '10.0.0.1'}, true),
  allowIf('prefix needs strings', {prefix: [ref('context.port'), '8']}, {}, {port: 8080}, false),
  denyIf('missing context defaults to {}', {eq: [ref('context.ip'), 'x']}, {}, undefined, true),
  denyIf('uncaptured resource variable is missing', {eq: [ref('resource.id'), 'z']}, {}, undefined, true),

  ['policy null', null, null, policyError('policy: roles must be an object')],
  ['roles is an array', {roles: []}, null, policyError('policy: roles must be an object')],
  ['roles missing', {}, null, policyError('policy: roles must be an object')],
  ['invalid role name', {roles: {ok: {}, Admin: {}}}, null, policyError('role "Admin": invalid name')],
  ['role name with a dot', {roles: {'a.b': {}}}, null, policyError('role "a.b": invalid name')],
  ['definition array', {roles: {a: []}}, null, policyError('role "a": definition must be an object')],
  ['definition null', {roles: {a: null}}, null, policyError('role "a": definition must be an object')],
  ['inherits not an array', {roles: {a: {inherits: 'b'}, b: {}}}, null, policyError('role "a": inherits must be an array')],
  ['unknown inherited role', {roles: {a: {inherits: ['b', 'zz']}, b: {}}}, null, policyError('role "a": unknown inherited role "zz"')],
  ['inherited role that is not a string', {roles: {a: {inherits: [7]}}}, null, policyError('role "a": unknown inherited role 7')],
  ['inherits checked before rules', {roles: {a: {rules: [{}], inherits: ['x']}}}, null, policyError('role "a": unknown inherited role "x"')],
  ['rules not an array', {roles: {a: {rules: {}}}}, null, policyError('role "a": rules must be an array')],
  ['earlier role first', {roles: {a: {rules: [VALID_RULE, {effect: 'allow', actions: ['bad'], resources: ['**']}]}, B: {}}}, null,
    policyError('role "a" rule 1: invalid action pattern "bad"')],
  ruleError('rule not an object', 'allow', 'must be an object'),
  ruleError('effect before actions', {effect: 'permit', actions: []}, 'invalid effect'),
  ruleError('actions empty', D([], ['**']), 'actions must be a non-empty array'),
  ruleError('actions missing', {effect: 'deny', resources: ['**']}, 'actions must be a non-empty array'),
  ruleError('action pattern without verb', A(['docs'], ['**']), 'invalid action pattern "docs"'),
  ruleError('action pattern upper case', A(['docs:read', 'Docs:read'], ['**']), 'invalid action pattern "Docs:read"'),
  ruleError('action pattern three parts', A(['a:b:c'], ['**']), 'invalid action pattern "a:b:c"'),
  ruleError('action pattern **', A(['**'], ['**']), 'invalid action pattern "**"'),
  ruleError('action pattern number', A([5], ['**']), 'invalid action pattern 5'),
  ruleError('actions before resources', A(['x'], []), 'invalid action pattern "x"'),
  ruleError('resources missing', {effect: 'allow', actions: ['*']}, 'resources must be a non-empty array'),
  ruleError('empty segment', A(['*'], ['a//b']), 'invalid resource pattern "a//b"'),
  ruleError('empty pattern', A(['*'], ['']), 'invalid resource pattern ""'),
  ruleError('two **', A(['*'], ['a/**/b/**']), 'invalid resource pattern "a/**/b/**"'),
  ruleError('upper-case variable', A(['*'], ['a/{Id}']), 'invalid resource pattern "a/{Id}"'),
  ruleError('partial wildcard', A(['*'], ['a/b*']), 'invalid resource pattern "a/b*"'),
  ruleError('first invalid resource pattern', A(['*'], ['ok', 'x y', 'a//']), 'invalid resource pattern "x y"'),
  ruleError('fractional priority', A(['*'], ['**'], {priority: 1.5}), 'invalid priority'),
  ruleError('priority too high', A(['*'], ['**'], {priority: 1001}), 'invalid priority'),
  ruleError('priority string', A(['*'], ['**'], {priority: '1'}), 'invalid priority'),
  ruleError('priority before condition', A(['*'], ['**'], {priority: null, when: 5}), 'invalid priority'),
  ruleError('comparison arity', A(['*'], ['**'], {when: {eq: [1]}}), 'invalid condition'),
  ruleError('unknown operator', A(['*'], ['**'], {when: {matches: [1, 2]}}), 'invalid condition'),
  ruleError('two operators', A(['*'], ['**'], {when: {eq: [1, 1], ne: [1, 2]}}), 'invalid condition'),
  ruleError('has a bare root', A(['*'], ['**'], {when: {has: 'subject'}}), 'invalid condition'),
  ruleError('resource path too deep', A(['*'], ['**'], {when: {eq: [ref('resource.a.b'), 1]}}), 'invalid condition'),
  ruleError('unknown path root', A(['*'], ['**'], {when: {eq: [ref('user.id'), 1]}}), 'invalid condition'),
  ruleError('empty path key', A(['*'], ['**'], {when: {has: 'context..ip'}}), 'invalid condition'),
  ruleError('nested array operand', A(['*'], ['**'], {when: {in: ['a', [['a']]]}}), 'invalid condition'),
  ruleError('ref with extra keys', A(['*'], ['**'], {when: {eq: [{ref: 'subject.a', x: 1}, 1]}}), 'invalid condition'),
  ruleError('not of an array', A(['*'], ['**'], {when: {not: []}}), 'invalid condition'),
  ruleError('deep invalid member', A(['*'], ['**'], {when: {all: [{any: [{eq: [1, 1]}, {has: 7}]}]}}), 'invalid condition'),
  ['priority -1000 and 1000 are valid', {roles: {r: {rules: [A(['*'], ['**'], {priority: -1000}), D(['*'], ['**'], {priority: 1000})]}}},
    req(['r'], 'a:b', 'c'), ok('deny', 'r#1')],
  ['per-role problems before cycles', {roles: {a: {inherits: ['b']}, b: {inherits: ['a']}, c: 'bad'}}, null, policyError('role "c": definition must be an object')],
  ['self inheritance', {roles: {a: {inherits: ['a']}}}, null, policyError('inheritance cycle: a -> a')],
  ['cycle starts at the repeated role', {roles: {a: {inherits: ['b']}, b: {inherits: ['c']}, c: {inherits: ['b']}}}, null, policyError('inheritance cycle: b -> c -> b')],
  ['depth-first in key order', {roles: {x: {inherits: ['y']}, y: {}, p: {inherits: ['q']}, q: {inherits: ['p']}}}, null, policyError('inheritance cycle: p -> q -> p')],
  ['depth-first from the first key', {roles: {q: {inherits: ['p']}, p: {inherits: ['q']}}}, null, policyError('inheritance cycle: q -> p -> q')],
  ['inherits in array order', {roles: {a: {inherits: ['c', 'b']}, b: {inherits: ['a']}, c: {inherits: ['d']}, d: {inherits: ['c']}}}, null,
    policyError('inheritance cycle: c -> d -> c')],
  ['diamond is not a cycle', {roles: {a: {inherits: ['b', 'c']}, b: {inherits: ['d']}, c: {inherits: ['d']}, d: {rules: [A(['*'], ['**'])]}}},
    req(['a'], 'a:b', 'c'), ok('allow', 'd#0')],

  ['request not an object', SIMPLE, 'nope', requestError('request must be an object')],
  ['subject missing', SIMPLE, {action: 'x:y', resource: 'r'}, requestError('invalid subject')],
  ['subject roles missing', SIMPLE, {subject: {}, action: 'x:y', resource: 'r'}, requestError('invalid subject')],
  ['subject roles not strings', SIMPLE, {subject: {roles: [1]}, action: 'x:y', resource: 'r'}, requestError('invalid subject')],
  ['subject attrs an array', SIMPLE, {subject: {roles: [], attrs: []}, action: 'x:y', resource: 'r'}, requestError('invalid subject')],
  ['subject checked before action', SIMPLE, {subject: [], action: 7, resource: 7}, requestError('invalid subject')],
  ['action without verb', SIMPLE, req(['r'], 'docs', 'r'), requestError('invalid action "docs"')],
  ['action wildcard', SIMPLE, req(['r'], 'docs:*', 'r'), requestError('invalid action "docs:*"')],
  ['action missing', SIMPLE, {subject: {roles: []}, resource: 'r'}, requestError('invalid action undefined')],
  ['action before resource', SIMPLE, req(['r'], 'Docs:read', ''), requestError('invalid action "Docs:read"')],
  ['empty resource', SIMPLE, req(['r'], 'x:y', ''), requestError('invalid resource ""')],
  ['resource with an empty segment', SIMPLE, req(['r'], 'x:y', 'a//b'), requestError('invalid resource "a//b"')],
  ['resource with a wildcard', SIMPLE, req(['r'], 'x:y', 'a/*'), requestError('invalid resource "a/*"')],
  ['resource not a string', SIMPLE, req(['r'], 'x:y', ['a']), requestError('invalid resource ["a"]')],
  ['context an array', SIMPLE, req(['r'], 'x:y', 'a', undefined, []), requestError('invalid context')],
  ['context null', SIMPLE, req(['r'], 'x:y', 'a', undefined, null), requestError('invalid context')],
];

const HIDDEN = `import test from 'node:test';
import assert from 'node:assert/strict';
const {compile, PolicyError, RequestError} = await import('@ROOT@src/acl.js');
const classes = {PolicyError, RequestError};
const isError = expected => error => error instanceof classes[expected.error] && error.name === expected.error && error.message === expected.message;
for (const [name, policy, request, expected] of ${JSON.stringify(CASES)}) {
  test(name, () => {
    if (request === null) return assert.throws(() => compile(policy), isError(expected));
    const compiled = compile(policy);
    if (expected.error) return assert.throws(() => compiled.authorize(request), isError(expected));
    const result = compiled.authorize(request);
    assert.deepStrictEqual(Object.keys(result), ['decision', 'rule']);
    assert.deepStrictEqual({...result}, expected);
  });
}
test('authorize(null) is a RequestError', () => {
  assert.throws(() => compile({roles: {}}).authorize(null), isError({error: 'RequestError', message: 'request must be an object'}));
});
test('undefined priority is present and invalid', () => {
  assert.throws(() => compile({roles: {a: {rules: [{effect: 'allow', actions: ['*'], resources: ['**'], priority: undefined}]}}}),
    isError({error: 'PolicyError', message: 'role "a" rule 0: invalid priority'}));
});
test('later mutation of the policy has no effect', () => {
  const when = {eq: [{ref: 'subject.team'}, 'red']};
  const policy = {roles: {base: {rules: []}, member: {inherits: ['base'], rules: [{effect: 'allow', actions: ['docs:read'], resources: ['docs/*'], when}]}}};
  const compiled = compile(policy);
  const request = {subject: {roles: ['member'], attrs: {team: 'red'}}, action: 'docs:read', resource: 'docs/a'};
  when.eq[1] = 'blue';
  policy.roles.member.rules[0].resources[0] = 'other/*';
  policy.roles.member.rules.push({effect: 'deny', actions: ['*'], resources: ['**'], priority: 9});
  policy.roles.base.rules.push({effect: 'deny', actions: ['*'], resources: ['**'], priority: 9});
  policy.roles.member.inherits.push('ghost');
  policy.roles.ghost = {rules: [{effect: 'deny', actions: ['*'], resources: ['**'], priority: 9}]};
  assert.deepStrictEqual({...compiled.authorize(request)}, {decision: 'allow', rule: 'member#0'});
});
`;

const files = {
  'package.json': JSON.stringify({name: 'access-policy', version: '0.3.0', type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'docs/POLICY.md': SPEC,
  'src/acl.js': DRAFT,
  'test/acl.test.js': VISIBLE,
};

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];

const patch = (from, to) => root => {
  if (!REFERENCE.includes(from)) throw Error('mustReject patch target missing: ' + from);
  writeTree(root, {'src/acl.js': REFERENCE.replace(from, to)});
};

export default {
  id: 'acl-precedence',
  category: 'rule engine with precedence',
  prompt: 'src/acl.js is an early draft of our access policy engine. Make it implement the specification in docs/POLICY.md completely and exactly: validation and error messages, role inheritance, patterns, conditions and decision precedence. Use only Node built-ins and add no dependencies. Do not modify, delete or rename any existing file under test/ (you may add new test files); `npm test` must pass.',
  setup: root => gitRepo(root, [['Access policy engine draft', files]]),
  solve: root => writeTree(root, {'src/acl.js': REFERENCE}),
  verify(root, before) {
    const suite = npm(root, 'test');
    const hidden = hiddenTests(root, HIDDEN);
    let pkg = {};
    try { pkg = JSON.parse(read(root, 'package.json')); } catch {}
    return verdict({
      tests_unchanged: unchanged(before, root, 'test/', {allowAdded: true}),
      no_dependencies: DEPENDENCY_FIELDS.every(field => pkg[field] === undefined),
      suite_passes: suite.status === 0,
      hidden_cases: hidden.pass,
    }, {suite: (suite.stdout + suite.stderr).slice(-2000), hidden: hidden.output});
  },
  mustReject: [
    // Allow rules also apply when the condition is unknown.
    patch("result === true || (result === UNKNOWN && rule.effect === 'deny')", 'result !== false'),
    // Specificity taken from every matching pattern, not only the applying ones.
    patch('const result = rule.when ?', 'resourceSpecificity = !resourceSpecificity || compareSpecificity(pattern.specificity, resourceSpecificity) > 0 ? pattern.specificity : resourceSpecificity;\n        const result = rule.when ?'),
    // Role names compared with localeCompare.
    patch('return a.role < b.role;', 'return a.role.localeCompare(b.role) < 0;'),
    // Cycle reported along the whole DFS path.
    patch('[...path.slice(path.indexOf(parent)), parent]', '[...path, parent]'),
    // The compiled policy keeps a live reference to the conditions.
    patch("structuredClone(rule.when)", 'rule.when'),
    // A visible test edited.
    root => writeTree(root, {'test/acl.test.js': VISIBLE.replace("test('deny wins a tie'", "test.skip('deny wins a tie'")}),
  ],
};
