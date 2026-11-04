import {gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

const PROMPT = 'The template renderer in src/template.js (`render(source, data)` and `TemplateError`) only handles plain `{{ name }}` substitution so far. ' +
  'Implement the complete template language specified in docs/TEMPLATES.md: every section of it, including whitespace control, raw blocks, ' +
  'and the exact error messages and positions. Keep the existing tests in test/ passing and unmodified (you may add new test files), and do not add any dependencies.';

const SPEC = `# Template language

\`render(source, data)\` in \`src/template.js\` turns the template string \`source\` into output text. \`data\` is a plain object whose own properties are the template's top-level variables. Data values are JSON-like: strings, numbers, booleans, \`null\`, arrays and plain objects (the template can also produce the value *missing*, which is JavaScript's \`undefined\`). Problems in a template are reported by throwing \`TemplateError\` (section 10); nothing is returned for an invalid template.

## 1. Text and tags

A template is literal text interrupted by tags. Scanning from left to right, the next tag starts at the first occurrence of one of three openers:

| Opener | Closer | Kind |
|---|---|---|
| \`{{\` | \`}}\` | output tag (section 3) |
| \`{%\` | \`%}\` | statement tag (sections 5, 6, 8, 9) |
| \`{#\` | \`#}\` | comment |

A tag ends at the first occurrence of its own closer after the opener (after the opener's \`-\` marker, if it has one; see section 7). This search is purely textual: a closer inside a string literal still ends the tag, and a tag may span several lines. A \`{\` that does not start an opener is ordinary text, and so is any \`}\`, \`%}\` or \`#}\` outside a tag.

Everything between tags is literal text and is copied to the output exactly as written: no escaping, and line breaks (including CRLF) are kept byte for byte. Comments produce no output; their content is ignored and may contain anything except \`#}\`.

## 2. Expressions

Output tags hold an expression; \`if\`, \`elif\` and \`for\` tags contain one as well.

    expression := primary ( "|" filter )*
    primary    := literal | path
    path       := NAME ( "." NAME | "[" INTEGER "]" )*
    filter     := NAME [ "(" literal ( "," literal )* ")" ]
    literal    := STRING | INTEGER | "true" | "false" | "none"

Tokens:

- NAME: \`[A-Za-z_][A-Za-z0-9_]*\`. When a primary is one of the names \`true\`, \`false\` or \`none\`, it is that literal (\`true\`, \`false\`, \`null\`). After a \`.\` these names are ordinary keys.
- INTEGER: \`[0-9]+\`, a non-negative decimal integer. There are no negative numbers, no decimals and no operators.
- STRING: \`"..."\` or \`'...'\`. The content is every character up to the next quote of the same kind. There are no escape sequences (a backslash is an ordinary character), so a string cannot contain its own quote character.
- punctuation: \`.\` \`[\` \`]\` \`(\` \`)\` \`,\` \`|\`

Whitespace (space, tab, CR, LF) may appear between any two tokens and around the expression, and is ignored. Any other character, or a token sequence that does not match the grammar, is the error \`bad syntax\`. In particular: filter arguments are literals only (\`default(name)\` is bad syntax), and an argument list, when present, has at least one argument (\`upper()\` is bad syntax; write \`upper\`).

### Looking up paths

The first NAME of a path is looked up in the current scope: the innermost enclosing \`for\` loop's variables first (its loop variable and \`loop\`), then the next enclosing loop's, and so on outward, and finally \`data\`. A name is found in a scope only if it is an own property of it (\`Object.hasOwn\`). A loop's variables shadow outer variables of the same name even when their value is \`null\`. A name found nowhere is missing.

Each further step applies to the value so far:

- \`.key\`: if the value is an object that is neither \`null\` nor an array, and \`key\` is an own property of it, the result is that property's value; otherwise the result is missing. So \`items.length\` on an array is missing, and inherited properties such as \`constructor\` are missing.
- \`[n]\`: if the value is an array and \`n\` is less than its length, the result is the element at index \`n\` (0-based); otherwise missing. Strings cannot be indexed (\`name[0]\` is missing).

A step applied to a missing value gives missing; looking things up never throws.

### Values as text

Whenever a value has to become text (in output tags, and in the filters that say so), it is converted like this:

- missing and \`null\`: the empty string
- strings: unchanged
- numbers and booleans: \`String(value)\`, e.g. \`3\`, \`1.5\`, \`true\`
- arrays: every element converted by these same rules, joined with \`,\` (no spaces); \`[1, null, [2, 3]]\` becomes \`1,,2,3\`
- other objects: the empty string

### Truthiness

A value is falsy if it is missing, \`null\`, \`false\`, \`0\`, the empty string, an empty array, or an object (not \`null\`, not an array) without own enumerable keys (\`Object.keys(value).length === 0\`). Every other value is truthy, including \`"0"\`, \`" "\`, \`[0]\` and \`{"a": null}\`.

## 3. Output tags and escaping

\`{{ expression }}\` evaluates the expression, applies its filters from left to right, converts the result to text, and HTML-escapes that text by replacing exactly these five characters (no others):

| Character | Replacement |
|---|---|
| \`&\` | \`&amp;\` |
| \`<\` | \`&lt;\` |
| \`>\` | \`&gt;\` |
| \`"\` | \`&quot;\` |
| \`'\` | \`&#39;\` |

Escaping happens once, on the final text, after all filters have run: \`{{ "a&b" | upper }}\` renders \`A&amp;B\`, and text that already contains entities is escaped again (\`&amp;\` becomes \`&amp;amp;\`). Literal text, comments and raw blocks are never escaped.

The \`safe\` filter turns escaping off for its tag, but only when it is the last filter of the chain. If any filter follows \`safe\`, the tag is escaped as usual: \`{{ "<b>" | safe | upper }}\` renders \`&lt;B&gt;\`. \`safe\` does not change the value, and it has no effect in \`if\`, \`elif\` and \`for\` tags.

## 4. Filters

A filter takes the current value and returns a new one. A name not in this table is the error \`unknown filter "NAME"\`. A filter must be given exactly the number and kind of arguments listed; anything else is the error \`bad arguments for filter "NAME"\`.

| Filter | Arguments | Result |
|---|---|---|
| \`upper\` | none | the value converted to text, then \`toUpperCase()\` |
| \`lower\` | none | the value converted to text, then \`toLowerCase()\` |
| \`length\` | none | arrays: number of elements; strings: \`.length\`; other objects (not \`null\`): number of own enumerable keys; anything else (missing, \`null\`, numbers, booleans): \`0\` |
| \`default(x)\` | one literal of any type | \`x\` if the value is missing, \`null\` or the empty string; otherwise the value unchanged (\`false\`, \`0\` and \`[]\` are kept) |
| \`join(sep)\` | one string literal | arrays: every element converted to text, joined with \`sep\`; any other value: the value converted to text |
| \`truncate(n)\` | one integer literal | let \`s\` be the value converted to text. If \`s.length <= n\`, the result is \`s\`. Otherwise it is the first \`n\` characters of \`s\` with any trailing whitespace (space, tab, CR, LF) removed, followed by \`...\` (three periods, not counted in \`n\`): \`"Hello world"\` with \`truncate(6)\` gives \`Hello...\` |
| \`safe\` | none | the value unchanged (see section 3) |

## 5. Conditionals

    {% if CONDITION %} ... {% elif CONDITION %} ... {% else %} ... {% endif %}

Any number of \`elif\` branches (including none) may follow the \`if\` branch, then at most one \`else\`, then \`endif\`. \`CONDITION\` is an expression, optionally preceded by the keyword \`not\`, which inverts its truthiness (at most one \`not\`; a leading word \`not\` is always this keyword). The first branch whose condition is truthy is rendered; if there is none, the \`else\` branch is rendered if present. Conditions may use filters (\`{% if items | length %}\`).

## 6. Loops

    {% for NAME in EXPRESSION %} body {% else %} empty body {% endfor %}

The \`else\` part is optional. If the expression's value is an array with at least one element, the body is rendered once per element, in order. Any other value (missing, \`null\`, an empty array, a string, an object, a number, ...) counts as an empty list: then the \`else\` body is rendered if present, otherwise nothing.

Each iteration of the body gets a new scope with two variables:

- \`NAME\`: the current element;
- \`loop\`: an object with \`index\` (1-based position), \`index0\` (0-based position), \`first\` (\`true\` only for the first element, otherwise \`false\`) and \`last\` (\`true\` only for the last element, otherwise \`false\`). In a one-element list, \`first\` and \`last\` are both \`true\`.

These shadow variables of the same names in enclosing loops and in \`data\`, so \`loop\` always refers to the innermost loop being rendered; after a loop ends, the enclosing names are visible again. The loop expression is evaluated in the scope around the \`for\` tag (in \`{% for x in x %}\`, the expression is the outer \`x\`), and the \`else\` body is rendered in that surrounding scope as well. Loops and conditionals nest to any depth.

## 7. Whitespace control

Any tag (output, statement or comment) may carry a \`-\` marker directly after its opener (\`{{-\`, \`{%-\`, \`{#-\`) and/or directly before its closer (\`-}}\`, \`-%}\`, \`-#}\`), with nothing in between. The markers are not part of the tag's content.

- An opening marker removes all whitespace characters (space, tab, CR and LF) from the end of the literal text immediately before the tag.
- A closing marker removes all whitespace characters from the start of the literal text immediately after the tag.

Only literal template text is affected, never text produced by output tags, and stripping never reaches past another tag: if there is no text between two tags, there is nothing to strip. Stripping applies to the template source, so a stripped loop body is stripped in every iteration. Without markers, whitespace and line breaks around tags are kept exactly; there is no other trimming.

For raw blocks (section 8), the closing marker of \`{% raw -%}\` strips the start of the raw content and the opening marker of \`{%- endraw %}\` strips its end; \`{%- raw %}\` and \`{% endraw -%}\` strip the text outside the block as usual.

## 8. Raw blocks

\`{% raw %}\` starts a raw block. Its content runs up to the first match, after the \`raw\` tag, of the regular expression \`/\\{%-?[ \\t\\r\\n]*endraw[ \\t\\r\\n]*-?%\\}/\` (the end tag), and it is copied to the output exactly as written: tags, comments and stray delimiters inside it are plain text and are not checked for errors. If no end tag follows, the error is \`unclosed block "raw"\` at the \`raw\` tag. Raw blocks may appear anywhere text may, including inside \`if\` and \`for\` bodies.

## 9. Statement tags

The first token of a statement tag's content is its name. The valid tags and their complete syntax:

    if CONDITION        elif CONDITION        else        endif
    for NAME in EXPRESSION                    endfor
    raw                                       endraw

\`else\`, \`endif\`, \`endfor\`, \`raw\` and \`endraw\` take nothing after the name. A tag whose first token is a NAME that is not one of these eight is the error \`unknown tag "NAME"\`. A tag whose content is empty or does not start with a NAME, or that does not match the syntax above, is \`bad syntax\`.

## 10. Errors

\`render\` throws a \`TemplateError\` (a subclass of \`Error\` whose \`name\` is \`"TemplateError"\`) with the message

    line L, column C: REASON

where \`L\` and \`C\` are the 1-based line and column of the first character (the \`{\`) of the offending tag. Lines are separated by LF; a CRLF counts as one line break (the CR is the last character of its line), and a lone CR is an ordinary character. Columns count UTF-16 code units (JavaScript string indices) from the start of the line, so a tab counts as 1 and a character outside the Basic Multilingual Plane as 2.

The whole template is validated before anything is rendered: errors are thrown even for tags in branches that would not be rendered, in loops over empty lists, and deep inside nested blocks. The template is checked from left to right and the first problem found is reported. Within one tag, its syntax is checked first, then its filters from left to right, then whether the tag may appear at that point. Blocks that are still open when the end of the template is reached are reported only after everything else.

Reasons (exact text; the double quotes are part of it):

| Reason | When |
|---|---|
| \`unclosed tag\` | an opener \`{{\`, \`{%\` or \`{#\` has no closer after it |
| \`bad syntax\` | sections 2 and 9 |
| \`unknown tag "NAME"\` | section 9 |
| \`unknown filter "NAME"\` | section 4 |
| \`bad arguments for filter "NAME"\` | section 4 |
| \`unexpected "TAG"\` | \`elif\` or \`else\` that the innermost open block does not accept, or an end tag (\`endif\`, \`endfor\`, \`endraw\`) when no block is open |
| \`unexpected "TAG", expected "END"\` | an end tag while a block is open whose end tag is a different one; \`END\` is the end tag of the innermost open block |
| \`unclosed block "KIND"\` | the template ends while a block is open (\`KIND\` is \`if\` or \`for\`), reported at the opening tag of the innermost open block; or a raw block without an end tag (section 8) |

Only the innermost open block decides whether \`elif\` or \`else\` is accepted: an \`if\` block accepts \`elif\` and \`else\` until its \`else\` has appeared; a \`for\` block accepts one \`else\` and never \`elif\`. Outside any block, \`elif\` and \`else\` are unexpected.
`;

const files = {
  'package.json': JSON.stringify({name: 'tinytpl', version: '0.1.0', type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'README.md': '# tinytpl\n\nA tiny HTML template renderer: `render(source, data)` from `src/template.js`. The language is specified in docs/TEMPLATES.md.\n',
  'docs/TEMPLATES.md': SPEC,
  'src/template.js': `/** Renders templates written in the language described in docs/TEMPLATES.md. */
export class TemplateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TemplateError';
  }
}

export function render(source, data = {}) {
  return source.replace(/\\{\\{\\s*([A-Za-z_][\\w.]*)\\s*\\}\\}/g, (_, path) => {
    let value = data;
    for (const key of path.split('.')) value = value == null ? undefined : value[key];
    return value == null ? '' : String(value);
  });
}
`,
  'test/template.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import {render} from '../src/template.js';

test('substitutes variables', () => assert.equal(render('Hello, {{ name }}!', {name: 'Ada'}), 'Hello, Ada!'));
test('follows dotted paths', () => assert.equal(render('{{ user.city }}', {user: {city: 'Paris'}}), 'Paris'));
test('missing values render as nothing', () => assert.equal(render('[{{ nope }}]', {}), '[]'));
`,
};

// Reference implementation (String.raw: regex backslashes stay as written; it contains no backticks or dollar-braces).
const SOLUTION = String.raw`/** Renders templates written in the language described in docs/TEMPLATES.md. */
export class TemplateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TemplateError';
  }
}

const OPENER = /\{[{%#]/g;
const CLOSERS = {'{': '}}', '%': '%}', '#': '#}'};
const RAW_END = /\{%-?[ \t\r\n]*endraw[ \t\r\n]*-?%\}/g;
const TOKEN = /[ \t\r\n]*(?:([A-Za-z_][A-Za-z0-9_]*)|([0-9]+)|"([^"]*)"|'([^']*)'|([.|()[\],]))/y;
const LITERALS = {true: true, false: false, none: null};
const ESCAPES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
const END_OF = {if: 'endif', for: 'endfor'};

const isObject = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = v => v == null ? '' : Array.isArray(v) ? v.map(text).join(',') : typeof v === 'object' ? '' : String(v);
const truthy = v => Array.isArray(v) ? v.length > 0 : isObject(v) ? Object.keys(v).length > 0 : Boolean(v);
const stripEnd = s => s.replace(/[ \t\r\n]+$/, '');
const stripStart = s => s.replace(/^[ \t\r\n]+/, '');

const FILTERS = {
  upper: {args: [], run: v => text(v).toUpperCase()},
  lower: {args: [], run: v => text(v).toLowerCase()},
  length: {args: [], run: v => Array.isArray(v) || typeof v === 'string' ? v.length : isObject(v) ? Object.keys(v).length : 0},
  safe: {args: [], run: v => v},
  default: {args: ['any'], run: (v, fallback) => v === undefined || v === null || v === '' ? fallback : v},
  join: {args: ['string'], run: (v, sep) => Array.isArray(v) ? v.map(text).join(sep) : text(v)},
  truncate: {args: ['integer'], run: (v, n) => { const s = text(v); return s.length <= n ? s : s.slice(0, n).replace(/[ \t\r\n]+$/, '') + '...'; }},
};

function position(source, index) {
  const before = source.slice(0, index);
  return 'line ' + before.split('\n').length + ', column ' + (index - (before.lastIndexOf('\n') + 1) + 1);
}

function tokenize(src) {
  const tokens = [];
  let pos = 0;
  while (/[^ \t\r\n]/.test(src.slice(pos))) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) return null;
    pos = TOKEN.lastIndex;
    if (m[1] !== undefined) tokens.push({type: 'name', value: m[1]});
    else if (m[2] !== undefined) tokens.push({type: 'literal', kind: 'integer', value: Number(m[2])});
    else if (m[5] === undefined) tokens.push({type: 'literal', kind: 'string', value: m[3] ?? m[4]});
    else tokens.push({type: m[5]});
  }
  return tokens;
}

// Parses tokens[k..] as one expression that must end the tag; validates its filters.
function expression(tokens, k, fail) {
  const first = tokens[k];
  const expr = {filters: []};
  if (first?.type === 'literal') { expr.literal = first.value; k++; }
  else if (first?.type === 'name' && Object.hasOwn(LITERALS, first.value)) { expr.literal = LITERALS[first.value]; k++; }
  else if (first?.type === 'name') {
    expr.path = [first.value];
    k++;
    for (;;) {
      if (tokens[k]?.type === '.' && tokens[k + 1]?.type === 'name') { expr.path.push(tokens[k + 1].value); k += 2; }
      else if (tokens[k]?.type === '[' && tokens[k + 1]?.kind === 'integer' && tokens[k + 2]?.type === ']') { expr.path.push(tokens[k + 1].value); k += 3; }
      else break;
    }
  } else throw fail('bad syntax');
  while (tokens[k]?.type === '|') {
    const name = tokens[k + 1];
    if (name?.type !== 'name') throw fail('bad syntax');
    const filter = {name: name.value, args: []};
    k += 2;
    if (tokens[k]?.type === '(') {
      k++;
      for (;;) {
        const arg = tokens[k];
        if (arg?.type === 'literal') filter.args.push(arg);
        else if (arg?.type === 'name' && Object.hasOwn(LITERALS, arg.value)) filter.args.push({kind: 'keyword', value: LITERALS[arg.value]});
        else throw fail('bad syntax');
        k++;
        if (tokens[k]?.type === ',') { k++; continue; }
        if (tokens[k]?.type === ')') { k++; break; }
        throw fail('bad syntax');
      }
    }
    expr.filters.push(filter);
  }
  if (k !== tokens.length) throw fail('bad syntax');
  for (const {name, args} of expr.filters) {
    if (!Object.hasOwn(FILTERS, name)) throw fail('unknown filter "' + name + '"');
    const want = FILTERS[name].args;
    if (args.length !== want.length || args.some((arg, n) => want[n] !== 'any' && arg.kind !== want[n])) throw fail('bad arguments for filter "' + name + '"');
  }
  return expr;
}

function parse(source) {
  const nodes = [];
  const stack = [{kind: 'root', body: nodes}];
  let i = 0, stripNext = false;
  for (;;) {
    OPENER.lastIndex = i;
    const open = OPENER.exec(source);
    const before = {type: 'text', value: source.slice(i, open ? open.index : source.length)};
    if (stripNext) before.value = stripStart(before.value);
    stack.at(-1).body.push(before);
    if (!open) break;
    const start = open.index, closer = CLOSERS[source[start + 1]];
    const fail = reason => new TemplateError(position(source, start) + ': ' + reason);
    let from = start + 2;
    if (source[from] === '-') { from++; before.value = stripEnd(before.value); }
    const end = source.indexOf(closer, from);
    if (end < 0) throw fail('unclosed tag');
    let inner = source.slice(from, end);
    stripNext = inner.endsWith('-');
    if (stripNext) inner = inner.slice(0, -1);
    i = end + 2;
    if (closer === '#}') continue;
    const tokens = tokenize(inner);
    if (!tokens) throw fail('bad syntax');
    const frame = stack.at(-1);
    if (closer === '}}') { frame.body.push({type: 'output', expr: expression(tokens, 0, fail)}); continue; }
    if (tokens[0]?.type !== 'name') throw fail('bad syntax');
    const name = tokens[0].value;
    if (['else', 'endif', 'endfor', 'raw', 'endraw'].includes(name) && tokens.length !== 1) throw fail('bad syntax');
    if (name === 'if' || name === 'elif') {
      const negate = tokens[1]?.type === 'name' && tokens[1].value === 'not';
      const branch = {negate, expr: expression(tokens, negate ? 2 : 1, fail), body: []};
      if (name === 'if') {
        const node = {type: 'if', branches: [branch], otherwise: null};
        frame.body.push(node);
        stack.push({kind: 'if', start, node, body: branch.body});
      } else {
        if (frame.kind !== 'if' || frame.node.otherwise) throw fail('unexpected "elif"');
        frame.node.branches.push(branch);
        frame.body = branch.body;
      }
    } else if (name === 'for') {
      if (tokens[1]?.type !== 'name' || tokens[2]?.type !== 'name' || tokens[2].value !== 'in') throw fail('bad syntax');
      const node = {type: 'for', name: tokens[1].value, expr: expression(tokens, 3, fail), body: [], otherwise: null};
      frame.body.push(node);
      stack.push({kind: 'for', start, node, body: node.body});
    } else if (name === 'else') {
      if (frame.kind === 'root' || frame.node.otherwise) throw fail('unexpected "else"');
      frame.body = frame.node.otherwise = [];
    } else if (name === 'endif' || name === 'endfor' || name === 'endraw') {
      if (frame.kind === 'root') throw fail('unexpected "' + name + '"');
      if (END_OF[frame.kind] !== name) throw fail('unexpected "' + name + '", expected "' + END_OF[frame.kind] + '"');
      stack.pop();
    } else if (name === 'raw') {
      RAW_END.lastIndex = i;
      const m = RAW_END.exec(source);
      if (!m) throw fail('unclosed block "raw"');
      let content = source.slice(i, m.index);
      if (stripNext) content = stripStart(content);
      if (m[0][2] === '-') content = stripEnd(content);
      frame.body.push({type: 'text', value: content});
      i = m.index + m[0].length;
      stripNext = m[0].at(-3) === '-';
    } else throw fail('unknown tag "' + name + '"');
  }
  if (stack.length > 1) {
    const open = stack.at(-1);
    throw new TemplateError(position(source, open.start) + ': unclosed block "' + open.kind + '"');
  }
  return nodes;
}

function lookup(scope, name) {
  for (let s = scope; s; s = s.parent) if (Object.hasOwn(s.vars, name)) return s.vars[name];
  return undefined;
}

function evaluate(expr, scope) {
  let value;
  if (expr.path) {
    value = lookup(scope, expr.path[0]);
    for (const step of expr.path.slice(1)) {
      if (typeof step === 'number') value = Array.isArray(value) && step < value.length ? value[step] : undefined;
      else value = isObject(value) && Object.hasOwn(value, step) ? value[step] : undefined;
    }
  } else value = expr.literal;
  let safe = false;
  for (const {name, args} of expr.filters) {
    safe = name === 'safe';
    value = FILTERS[name].run(value, ...args.map(arg => arg.value));
  }
  return {value, safe};
}

function renderNodes(nodes, scope, out) {
  for (const node of nodes) {
    if (node.type === 'text') out.push(node.value);
    else if (node.type === 'output') {
      const {value, safe} = evaluate(node.expr, scope);
      out.push(safe ? text(value) : text(value).replace(/[&<>"']/g, c => ESCAPES[c]));
    } else if (node.type === 'if') {
      const branch = node.branches.find(b => truthy(evaluate(b.expr, scope).value) !== b.negate);
      const body = branch ? branch.body : node.otherwise;
      if (body) renderNodes(body, scope, out);
    } else {
      const items = evaluate(node.expr, scope).value;
      if (Array.isArray(items) && items.length) {
        items.forEach((item, index) => renderNodes(node.body, {parent: scope, vars: {[node.name]: item,
          loop: {index: index + 1, index0: index, first: index === 0, last: index === items.length - 1}}}, out));
      } else if (node.otherwise) renderNodes(node.otherwise, scope, out);
    }
  }
}

export function render(source, data = {}) {
  const out = [];
  renderNodes(parse(source), {parent: null, vars: data}, out);
  return out.join('');
}
`;

// [name, template, data, expected output]; every expectation follows from docs/TEMPLATES.md.
const LOOP_VARS = '{% for x in xs %}{{ loop.index }}{{ loop.index0 }}{{ x }}{% if loop.first %}F{% endif %}{% if loop.last %}L{% endif %};{% endfor %}';
const FOR_ELSE = '{% for x in xs %}{{ x }}{% else %}none{% endfor %}';
const IF_CHAIN = '{% if a %}A{% elif b %}B{% else %}C{% endif %}';
const USERS = '{%- for user in users -%}\n{{ loop.index }}. {{ user.name | default("anonymous") | truncate(8) }}\n{%- if user.admin %} [admin]{% endif %}\n{% else -%}\nno users\n{% endfor -%}\ndone';
const CASES = [
  ['dotted path', '{{ user.name }}', {user: {name: 'Ada'}}, 'Ada'],
  ['integer indexes', '{{ xs[1] }}-{{ xs[5] }}-{{ m[0][1] }}', {xs: ['a', 'b'], m: [[1, 2]]}, 'b--2'],
  ['missing deep paths', '[{{ a.b.c }}][{{ nope[0].x }}]', {a: {}}, '[][]'],
  ['paths without spaces', '{{user.tags[0]}}', {user: {tags: ['x']}}, 'x'],
  ['no array props, string indexes or inherited keys', '[{{ xs.length }}][{{ s[0] }}][{{ user.constructor }}][{{ toString }}]', {xs: [1], s: 'abc', user: {}}, '[][][][]'],
  ['null and keywords after a dot', '[{{ n }}][{{ o.true }}][{{ o.none }}]', {n: null, o: {true: 'T', none: 'N'}}, '[][T][N]'],
  ['values as text', '{{ b }}|{{ f }}|{{ z }}|{{ num }}|{{ arr }}|{{ obj }}', {b: true, f: false, z: 0, num: 1.5, arr: [1, null, 'x', [2, 3]], obj: {a: 1}}, 'true|false|0|1.5|1,,x,2,3|'],
  ['literals', `{{ "it's" }}{{ 'say "hi"' }}{{ 42 }}{{ true }}{{ none }}{{ "a\\b" }}`, {}, 'it&#39;ssay &quot;hi&quot;42truea\\b'],
  ['escapes all five characters', '{{ s }}', {s: `<a href="x">Tom & Jerry's</a>`}, '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;'],
  ['literal text is not escaped', '<p>"Q&A" {{ s }}</p>', {s: '&'}, '<p>"Q&A" &amp;</p>'],
  ['escaping after filters', '{{ s | upper }}', {s: 'a&b'}, 'A&amp;B'],
  ['entities are escaped again', '{{ s }}', {s: '&amp;'}, '&amp;amp;'],
  ['safe as last filter', '{{ s | safe }}', {s: '<b>hi</b>'}, '<b>hi</b>'],
  ['safe followed by a filter', '{{ s | safe | upper }}', {s: '<b>hi</b>'}, '&lt;B&gt;HI&lt;/B&gt;'],
  ['join separator is escaped', '{{ xs | join("<br>") }}|{{ xs | join("<br>") | safe }}', {xs: ['a', 'b']}, 'a&lt;br&gt;b|a<br>b'],
  ['upper and lower chain', '{{ name | lower | upper }}{{ name | upper | lower }}', {name: 'MiXeD'}, 'MIXEDmixed'],
  ['length', '{{ xs | length }} {{ s | length }} {{ o | length }} {{ nope | length }} {{ n | length }}', {xs: [1, 2, 3], s: 'hello', o: {a: 1, b: 2}, n: 42}, '3 5 2 0 0'],
  ['default replaces only missing, null and empty string', '[{{ a | default("x") }}][{{ b | default("x") }}][{{ c | default("x") }}][{{ d | default("x") }}][{{ e | default("x") }}][{{ f | default("x") }}][{{ g | default(7) }}]', {b: null, c: '', d: false, e: 0, f: []}, '[x][x][x][false][0][][7]'],
  ['default then upper', "{{ who | default('anon') | upper }}", {}, 'ANON'],
  ['default with keyword literals', '[{{ a | default(none) }}][{{ a | default(true) }}]', {}, '[][true]'],
  ['default keeps zero length', '{{ xs | length | default("none") }}', {xs: []}, '0'],
  ['default output is escaped', `{{ x | default('"') }}`, {}, '&quot;'],
  ['join', '{{ xs | join(", ") }}|{{ ys | join("-") }}|{{ s | join("-") }}|{{ nope | join("-") }}', {xs: ['a', 1, null, true], ys: [], s: 'abc'}, 'a, 1, , true||abc|'],
  ['truncate', '{{ s | truncate(5) }}|{{ s | truncate(6) }}|{{ s | truncate(11) }}|{{ s | truncate(20) }}|{{ s | truncate(0) }}', {s: 'Hello world'}, 'Hello...|Hello...|Hello world|Hello world|...'],
  ['truncate removes trailing tabs and newlines', '{{ s | truncate(5) }}', {s: 'ab\n \tcd'}, 'ab...'],
  ['truncate then escape', '{{ s | truncate(3) }}', {s: 'a<b>c'}, 'a&lt;b...'],
  ['truncate non-strings', '{{ n | truncate(2) }}|{{ xs | truncate(3) }}', {n: 12345, xs: ['a', 'b', 'c']}, '12...|a,b...'],
  ['filter arguments with spaces', '{{ s | truncate( 2 ) | join( "x" ) }}', {s: 'abc'}, 'ab...'],
  ['if takes elif', IF_CHAIN, {a: 0, b: 'x'}, 'B'],
  ['empty array and object are falsy', IF_CHAIN, {a: [], b: {}}, 'C'],
  ['a space is truthy', IF_CHAIN, {a: ' '}, 'A'],
  ['truthiness table', '{% for v in vals %}{% if v %}T{% else %}F{% endif %}{% endfor %}', {vals: [null, false, 0, '', [], {}, '0', ' ', [0], {a: null}, true, 7, 'false']}, 'FFFFFFTTTTTTT'],
  ['not on empty list', '{% if not xs %}empty{% else %}{{ xs | length }}{% endif %}', {xs: []}, 'empty'],
  ['not on full list', '{% if not xs %}empty{% else %}{{ xs | length }}{% endif %}', {xs: [1]}, '1'],
  ['filters in conditions', '{% if items | length %}has{% endif %}{% if name | default("") %}N{% endif %}', {items: [1], name: ''}, 'has'],
  ['nested if', '{% if a %}{% if b %}ab{% elif c %}ac{% endif %}{% elif d %}d{% endif %}', {a: 1, c: 1}, 'ac'],
  ['third elif', '{% if n %}x{% elif m %}m{% elif k %}k{% endif %}', {k: 1}, 'k'],
  ['loop variables', LOOP_VARS, {xs: ['a', 'b', 'c']}, '10aF;21b;32cL;'],
  ['one-element loop is first and last', LOOP_VARS, {xs: ['z']}, '10zFL;'],
  ['for else on empty list', FOR_ELSE, {xs: []}, 'none'],
  ['for else on missing', FOR_ELSE, {}, 'none'],
  ['strings are not iterated', FOR_ELSE, {xs: 'abc'}, 'none'],
  ['objects are not iterated', FOR_ELSE, {xs: {a: 1}}, 'none'],
  ['separators with loop.last', '{% for x in xs %}{{ x }}{% if not loop.last %}, {% endif %}{% endfor %}', {xs: [1, 2, 3]}, '1, 2, 3'],
  ['inner loop restores outer loop', '{% for row in rows %}{% for c in row %}{{ loop.index }}{% endfor %}/{{ loop.index }} {% endfor %}', {rows: [['a', 'b'], ['c']]}, '12/1 1/2 '],
  ['loop variable shadows data', '{{ x }}{% for x in xs %}[{{ x }}]{% endfor %}{{ x }}', {x: 'out', xs: ['in']}, 'out[in]out'],
  ['null loop variable still shadows', '{% for x in xs %}[{{ x }}]{% endfor %}', {x: 'out', xs: [null, 'b']}, '[][b]'],
  ['loop expression uses the outer scope', '{% for x in x %}{% for x in x %}{{ x }}{% endfor %};{{ x | length }}|{% endfor %}', {x: [['a', 'b'], ['c']]}, 'ab;2|c;1|'],
  ['loop shadows data named loop', '{{ loop.index }}{% for x in xs %}{{ loop.index }}{% endfor %}{% for y in ys %}{% else %}{{ loop.index }}{% endfor %}', {loop: {index: 'D'}, xs: ['a', 'b'], ys: []}, 'D12D'],
  ['for else runs in the surrounding loop scope', '{% for a in as %}{% for b in bs %}{% else %}{{ a }}{{ loop.index }}{% endfor %}{% endfor %}', {as: ['p', 'q'], bs: []}, 'p1q2'],
  ['loops over nested data', '{% for u in data.users %}{{ u.name }}{% if u.tags %}({{ u.tags | join("/") }}){% endif %} {% endfor %}', {data: {users: [{name: 'a', tags: ['x', 'y']}, {name: 'b', tags: []}]}}, 'a(x/y) b '],
  ['loop.last of inner and outer loops', '{% for a in as %}{% for b in bs %}{% if loop.last %}{{ a }}{{ b }}{% endif %}{% endfor %}{% if loop.last %}!{% endif %}{% endfor %}', {as: [1, 2], bs: ['x', 'y']}, '1y2y!'],
  ['index paths in loops', '{% for p in pairs %}{{ p[0] }}={{ p[1] | default("?") }}{% if not loop.last %}&{% endif %}{% endfor %}', {pairs: [['a', 1], ['b'], ['c', 0]]}, 'a=1&b=?&c=0'],
  ['whitespace control on output tags', 'a  {{- x -}}  b', {x: 'X'}, 'aXb'],
  ['whitespace control strips newlines', '<ul>\n{%- for x in xs %}\n  <li>{{ x }}</li>\n{%- endfor %}\n</ul>', {xs: ['a', 'b']}, '<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>'],
  ['stripped loop body', '{% for x in xs -%}\n\t {{ x }} \r\n{%- endfor %}', {xs: [1, 2]}, '12'],
  ['whitespace control strips CRLF', 'A\r\n{{- x -}}\r\n\r\nB', {x: '-'}, 'A-B'],
  ['no trimming without markers', '{% if a %}\n  yes\n{% endif %}\n', {a: 1}, '\n  yes\n\n'],
  ['output text is never stripped', '{{ s }}{{- "b" }}|{{ "c" -}}{{ s }}', {s: ' a '}, ' a b|c a '],
  ['comments with markers', 'a {#- note -#} b|a {# note #} b', {}, 'ab|a  b'],
  ['stripping stops at the previous tag', '{{ x }}  {# c #}  {{- y }}', {x: 'X', y: 'Y'}, 'X  Y'],
  ['markers on else and endif (false)', '{% if a -%}\n  A\n{%- else -%}\n  B\n{%- endif %}', {a: 0}, 'B'],
  ['markers on else and endif (true)', '{% if a -%}\n  A\n{%- else -%}\n  B\n{%- endif %}', {a: 1}, 'A'],
  ['multi-line tag with markers', 'x {{-\n  name\n-}} y', {name: 'N'}, 'xNy'],
  ['markers inside raw', '<{% raw -%}  {{ x }}  {%- endraw %}>', {x: 1}, '<{{ x }}>'],
  ['markers outside raw', 'a  {%- raw %} b {% endraw -%}  c', {}, 'a b c'],
  ['raw block', '{% raw %}{{ x }}{% if %}{# c #}{{ unclosed{% endraw %}{{ x }}', {x: '<'}, '{{ x }}{% if %}{# c #}{{ unclosed&lt;'],
  ['raw inside a loop', '{% for i in xs %}{% raw %}{{i}}{% endraw %}{% endfor %}', {xs: [1, 2]}, '{{i}}{{i}}'],
  ['raw end tag spellings', '{% raw %}a{%endraw%}b{% raw %}c{%  endraw  %}', {}, 'abc'],
  ['comments hide tags', 'a{# line1\n {{ nope | bad }}\n {% if %} #}b', {}, 'ab'],
  ['stray delimiters are text', '}} %} #} { a } {x}', {}, '}} %} #} { a } {x}'],
  ['CRLF text is kept', 'a\r\n{{ x }}\r\n', {x: 1}, 'a\r\n1\r\n'],
  ['closer search is textual', '{{ "%}" }}{% if "}}" %}y{% endif %}', {}, '%}y'],
  ['users list', USERS, {users: [{name: 'Ada Lovelace', admin: true}, {name: null}, {name: "O'Neil"}]}, '1. Ada Love... [admin]\n2. anonymou...\n3. O&#39;Neil\ndone'],
  ['users list empty', USERS, {users: []}, 'no users\ndone'],
];

// [name, template, message]; data is always {} so nothing would render.
const NESTED = '{% if a %}\n  {% for x in xs %}\n    {% if x %}{{ x | shout }}{% endif %}\n  {% endfor %}\n{% endif %}';
const ERRORS = [
  ['unclosed output tag', 'Hello {{ name', 'line 1, column 7: unclosed tag'],
  ['unclosed comment', 'a\nb {# never closed', 'line 2, column 3: unclosed tag'],
  ['unclosed statement tag', '{% if x %}\n  {% endif', 'line 2, column 3: unclosed tag'],
  ['unknown filter deep in a false branch', NESTED, 'line 3, column 15: unknown filter "shout"'],
  ['inherited names are not filters', '{{ x | constructor }}', 'line 1, column 1: unknown filter "constructor"'],
  ['unknown tag', '{% for x in xs %}{% break %}{% endfor %}', 'line 1, column 18: unknown tag "break"'],
  ['mismatched end tag', '{% if a %}\n{% for x in xs %}\n{% endif %}', 'line 3, column 1: unexpected "endif", expected "endfor"'],
  ['end tag with no open block', 'ok\n  {%- endfor %}', 'line 2, column 3: unexpected "endfor"'],
  ['else outside blocks', '{% else %}', 'line 1, column 1: unexpected "else"'],
  ['elif inside for', '{% for x in xs %}{% elif y %}{% endfor %}', 'line 1, column 18: unexpected "elif"'],
  ['elif after else', '{% if a %}{% else %}{% elif b %}{% endif %}', 'line 1, column 21: unexpected "elif"'],
  ['second else in if', '{% if x %}{% else %}{% else %}{% endif %}', 'line 1, column 21: unexpected "else"'],
  ['second else in for', '{% for x in xs %}{% else %}{% else %}{% endfor %}', 'line 1, column 28: unexpected "else"'],
  ['elif in a for inside an if', '{% if a %}{% for x in xs %}{% elif b %}', 'line 1, column 28: unexpected "elif"'],
  ['innermost unclosed block', '{% if a %}\n{% for x in xs %}\n{{ x }}', 'line 2, column 1: unclosed block "for"'],
  ['unclosed if', 'text\n\n   {% if a %}{% endif %}{% if b %}', 'line 3, column 25: unclosed block "if"'],
  ['unclosed raw', 'a\n{% raw %}{% endraw', 'line 2, column 1: unclosed block "raw"'],
  ['endraw outside raw', '{% for x in xs %}{% endraw %}', 'line 1, column 18: unexpected "endraw", expected "endfor"'],
  ['empty output tag', 'x{{ }}', 'line 1, column 2: bad syntax'],
  ['empty statement tag', '{% %}', 'line 1, column 1: bad syntax'],
  ['trailing tokens', '{{ a b }}', 'line 1, column 1: bad syntax'],
  ['syntax before placement', '{% endif x %}', 'line 1, column 1: bad syntax'],
  ['for needs in', '{% for x of xs %}{% endfor %}', 'line 1, column 1: bad syntax'],
  ['path as filter argument', '{{ x | default(y) }}', 'line 1, column 1: bad syntax'],
  ['empty argument list', '{{ x | upper() }}', 'line 1, column 1: bad syntax'],
  ['closer inside a string', '{{ "a}}b" }}', 'line 1, column 1: bad syntax'],
  ['detached dash', '{{ x - }}', 'line 1, column 1: bad syntax'],
  ['syntax before filters', '{{ x | nope | }}', 'line 1, column 1: bad syntax'],
  ['not without condition', '{% if not %}{% endif %}', 'line 1, column 1: bad syntax'],
  ['truncate needs an integer', '{{ x | truncate("5") }}', 'line 1, column 1: bad arguments for filter "truncate"'],
  ['join needs an argument', '{{ x | join }}', 'line 1, column 1: bad arguments for filter "join"'],
  ['upper takes none', '{{ x | upper(1) }}', 'line 1, column 1: bad arguments for filter "upper"'],
  ['default takes one', '{{ x | default(1, 2) }}', 'line 1, column 1: bad arguments for filter "default"'],
  ['filters checked left to right (unknown first)', '{{ x | nope | join }}', 'line 1, column 1: unknown filter "nope"'],
  ['filters checked left to right (arguments first)', '{{ x | join | nope }}', 'line 1, column 1: bad arguments for filter "join"'],
  ['CRLF is one line break', 'a\r\nb\r\n  {{ x | nope }}', 'line 3, column 3: unknown filter "nope"'],
  ['lone CR is a character', 'ab\r{{ x | nope }}', 'line 1, column 4: unknown filter "nope"'],
  ['lines inside comments and tags count', '{#\ncomment\n#}{{\n x\n}} {% if %}', 'line 5, column 4: bad syntax'],
  ['tab counts as one column', '\t{{ x | nope }}', 'line 1, column 2: unknown filter "nope"'],
  ['astral character counts as two columns', '\u{1F600}{{ x | nope }}', 'line 1, column 3: unknown filter "nope"'],
  ['first error wins over later unclosed tag', '{{ x | nope }}{{ y', 'line 1, column 1: unknown filter "nope"'],
  ['tag error wins over unclosed block', '{% if a %}\n{{ x | nope }}', 'line 2, column 1: unknown filter "nope"'],
  ['raw content is not checked, later tags are', '{% raw %}{% bogus %}{% endraw %}{% bogus %}', 'line 1, column 33: unknown tag "bogus"'],
  ['position is the brace before the dash marker', 'x\n  {%- endif -%}', 'line 2, column 3: unexpected "endif"'],
];

const HIDDEN = `import test from 'node:test';
import assert from 'node:assert/strict';
const {render, TemplateError} = await import('@ROOT@src/template.js');
const cases = ${JSON.stringify(CASES)};
const errors = ${JSON.stringify(ERRORS)};
for (const [name, source, data, expected] of cases) test(name, () => assert.equal(render(source, data), expected));
for (const [name, source, message] of errors) test('error: ' + name, () => assert.throws(() => render(source, {}), error => {
  assert.ok(error instanceof TemplateError, 'not a TemplateError: ' + error);
  assert.equal(error.message, message);
  return true;
}));
test('TemplateError is a named Error', () => {
  const error = new TemplateError('x');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'TemplateError');
});
`;

const patch = (from, to) => root => {
  const source = read(root, 'src/template.js');
  if (!source.includes(from)) throw Error('mutation target missing: ' + from);
  writeTree(root, {'src/template.js': source.replace(from, to)});
};

export default {
  id: 'template-engine',
  category: 'spec with hidden edge cases',
  prompt: PROMPT,
  setup: root => gitRepo(root, [['tinytpl: variable substitution and language spec', files]]),
  solve: root => writeTree(root, {'src/template.js': SOLUTION}),
  verify(root, before) {
    let pkg = {};
    try { pkg = JSON.parse(read(root, 'package.json')); } catch {}
    const suite = npm(root, 'test');
    const hidden = hiddenTests(root, HIDDEN);
    return verdict({
      tests_kept: unchanged(before, root, 'test/', {allowAdded: true}),
      no_dependencies: ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].every(key => !Object.keys(pkg[key] ?? {}).length),
      suite_passes: suite.status === 0,
      hidden_cases: hidden.pass,
    }, {hidden: hidden.output});
  },
  mustReject: [
    patch(`"'": '&#39;'`, `"'": "'"`),
    patch(`const stripEnd = s => s.replace(/[ \\t\\r\\n]+$/, '');\nconst stripStart = s => s.replace(/^[ \\t\\r\\n]+/, '');`,
      `const stripEnd = s => s.replace(/[ \\t]+$/, '');\nconst stripStart = s => s.replace(/^[ \\t]+/, '');`),
    patch(`(index - (before.lastIndexOf('\\n') + 1) + 1)`, `(index - (before.lastIndexOf('\\n') + 1))`),
    patch(`last: index === items.length - 1}`, `last: index === items.length - 1 && index > 0}`),
    patch(`before.split('\\n').length`, `before.split(/\\r|\\n/).length`),
    patch(`safe = name === 'safe';`, `safe ||= name === 'safe';`),
    patch(`v === undefined || v === null || v === '' ? fallback : v`, `v || fallback`),
    patch(`Array.isArray(value) && step < value.length ? value[step]`, `value != null && step < value.length ? value[step]`),
    patch(`s.slice(0, n).replace(/[ \\t\\r\\n]+$/, '')`, `s.slice(0, n)`),
    root => writeTree(root, {'test/template.test.js': read(root, 'test/template.test.js').replace("'Hello, Ada!'", "render('Hello, {{ name }}!', {name: 'Ada'})")}),
    root => writeTree(root, {'package.json': JSON.stringify({...JSON.parse(read(root, 'package.json')), dependencies: {nunjucks: '^3.2.4'}}, null, 2) + '\n'}),
  ],
};
