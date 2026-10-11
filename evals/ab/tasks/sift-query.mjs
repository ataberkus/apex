import {gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

// Fixture sources are String.raw (no backticks or dollar-brace inside). md() turns \` into a backtick and \$ into $.
const md = text => text.replaceAll('\\`', '`').replaceAll('\\$', '$');

/** Replace each anchor, which must occur exactly once, so a drifting anchor fails loudly at import time. */
function patch(text, pairs) {
  for (const [from, to] of pairs) {
    if (text.split(from).length !== 2) throw Error('sift-query: patch anchor not unique: ' + from);
    text = text.replace(from, () => to);
  }
  return text;
}

const SPEC = md(String.raw`# Sift expression language

Sift expressions compute a value from one record. This document is the complete specification of the library in \`src/\`, exported from \`src/index.js\`:

- \`compile(source)\` compiles the expression in the string \`source\` and returns a function \`(record) => value\`. \`record\` is always a plain object.
- \`evaluate(source, record)\` is the same as \`compile(source)(record)\`.
- \`SiftError\` is the class of every error Sift reports (section 8).

Sift values are JSON values: \`null\`, booleans, numbers (always finite), strings, arrays and plain objects. Error messages name a value's type with one of the words \`null\`, \`boolean\`, \`number\`, \`string\`, \`array\`, \`object\`.

## 1. Positions

A position is a line and a column, both starting at 1. Lines and columns count Unicode code points, not UTF-16 code units: a character outside the Basic Multilingual Plane, such as 😀, is one column, and so is a tab. A line break is an LF, a CR LF pair, or a CR that is not followed by LF; each counts as one line break, and the character after it is column 1 of the next line.

The *end position* of a source is the position just after its last character, including trailing whitespace and comments: it is 1:6 for the source \`1 +\` followed by two spaces, 2:1 for \`1 +\` followed by one line break, and 1:1 for the empty source.

## 2. Tokens

Whitespace (space, tab, CR, LF) separates tokens and is otherwise ignored. \`#\` starts a comment that runs up to (not including) the next line break or the end of the source; comments are ignored like whitespace.

- **Number**: starts with a digit \`0-9\`. The token is the longest run of characters that are ASCII letters, digits, \`_\` or \`.\` starting there. The run must match \`digits ( "." digits )?\`, where \`digits\` is one or more decimal digits that may be split by single underscores between two digits (\`1_000\`, \`3.141_59\`); its value is the decimal number with underscores removed, and it must be finite. Otherwise the error is \`invalid number "RUN"\` (RUN being the whole run) at the start of the run: \`1.\`, \`1..2\`, \`1__0\`, \`1_\`, \`12ab\`, \`0x1F\`. There are no negative literals (\`-\` is an operator) and no exponents.
- **String**: \`"\` ... \`"\`. A backslash starts an escape: \`\"\`, \`\\\`, \`\n\` (LF), \`\t\` (tab), or \`\u{H}\` where \`H\` is 1 to 6 hexadecimal digits (either case) whose value is at most 10FFFF and not in D800-DFFF, meaning that code point. A backslash followed by anything else (including a line break or the end of the source) is the error \`invalid escape\` at the backslash. A string cannot contain a raw line break: when a line break or the end of the source comes before the closing quote, the error is \`unterminated string\` at the opening quote. The string is read from left to right and the first problem found is reported.
- **Identifier**: \`[A-Za-z_][A-Za-z0-9_]*\`. The words \`and\`, \`or\`, \`not\`, \`in\`, \`null\`, \`true\`, \`false\` are keywords in any combination of upper and lower case (\`AND\`, \`Null\`, \`tRUE\`); every other identifier is a name.
- **Quoted name**: a backtick, then one or more characters other than backtick and line breaks, then a backtick, for example \`\` \`first name\` \`\` or \`\` \`true\` \`\`. It is always a name, never a keyword, whatever its content. If a line break or the end of the source comes before the closing backtick, the error is \`unterminated name\`; if there is nothing between the backticks, \`empty name\`; both at the opening backtick.
- **Operators and punctuation**: \`!=\` \`<=\` \`>=\` \`??\` \`+\` \`-\` \`*\` \`/\` \`%\` \`^\` \`&\` \`=\` \`<\` \`>\` \`(\` \`)\` \`[\` \`]\` \`,\` \`.\`, always taking the longest match (\`<=\` is one token).
- Any other character, including \`!\` or \`?\` that do not start \`!=\` or \`??\`, is the error \`unexpected character "C"\` at that character, where \`C\` is the character itself (one code point).

The whole source is tokenized before parsing starts, so a lexical error is reported even when a syntax error comes before it in the source: \`) + "abc\` reports \`unterminated string\` at 1:5.

## 3. Syntax

    expression := or
    or         := and ( "or" and )*
    and        := not ( "and" not )*
    not        := "not" not | comparison
    comparison := additive [ ( "=" | "!=" | "<" | "<=" | ">" | ">=" | "in" ) additive ]
    additive   := multiplicative ( ( "+" | "-" | "&" ) multiplicative )*
    multiplicative := unary ( ( "*" | "/" | "%" ) unary )*
    unary      := "-" unary | power
    power      := coalesce [ "^" unary ]
    coalesce   := postfix ( "??" postfix )*
    postfix    := primary ( "." field | "[" expression "]" )*
    primary    := NUMBER | STRING | "null" | "true" | "false"
                | IDENTIFIER "(" [ expression ( "," expression )* ] ")"
                | NAME | "(" expression ")" | "[" [ expression ( "," expression )* ] "]"
    field      := NAME | keyword

So, from loosest to tightest: \`or\`, \`and\`, \`not\`, the comparisons, \`+ - &\` (one level, left to right), \`* / %\`, unary minus, \`^\`, \`??\`, then postfix field and index access. Notable consequences: \`^\` is right-associative and its right operand may start with a minus (\`2 ^ -1\`), \`-2 ^ 2\` is \`-(2 ^ 2)\`, \`??\` binds tighter than every other binary operator (\`1 + x ?? 2 * 3\` is \`1 + (x ?? 2) * 3\`), and \`"a" & 1 + 2\` is \`("a" & 1) + 2\`.

- A function call is an identifier followed by \`(\` (whitespace and comments may come between them). A quoted name never calls a function: \`\` \`len\`(x) \`\` is a syntax error at \`(\`.
- After \`.\`, a keyword is an ordinary field name, spelled exactly as written: \`a.NULL\` reads the field \`NULL\`.
- Comparisons do not chain. When a comparison operator follows a complete comparison (\`a < b < c\`, \`a = b in c\`), the error is \`comparison operators cannot be chained\` at that second operator.
- Any other token where the grammar does not allow it is the error \`unexpected token "TEXT"\` at that token, where TEXT is the token exactly as written in the source (a string token with its quotes and escapes, a keyword in its original case). When the source ends too early, the error is \`unexpected end of input\` at the end position (section 1). Tokens left over after a complete expression are unexpected tokens.

## 4. Function checks

After the whole expression has parsed successfully, every function call is checked, in the order the function names appear in the source. A name that is not one of the functions of section 6 (names are case-sensitive) is the error \`unknown function "NAME"\`; a known function with a number of arguments it does not accept is \`wrong number of arguments for "NAME"\`. Both are reported at the function name. Because parsing comes first, a syntax error anywhere wins over these.

\`compile\` reports every error of sections 2 to 4 and never evaluates anything. All errors of section 5 are raised only when the compiled function runs, and \`compile\` succeeds for expressions such as \`1 / 0\`.

## 5. Evaluation

Operands and arguments are evaluated from left to right, and the first error raised stops evaluation. Every number produced by an operator or function must be finite; otherwise the error is \`number out of range\` (this includes NaN). A computed negative zero is returned as \`0\`.

Errors of this section are reported at the operator token (for \`and\`, \`or\`, \`not\`, \`in\` the keyword), at the \`.\` or \`[\` of a field or index access, and at the function name of a call. Messages name operators as written in this document, keywords in lower case.

### 5.1 Names, fields and indexes

A NAME in primary position is a field of the record: its value if the record has an own property of that name, otherwise \`null\`.

\`value.field\`:
- object: the own property's value, or \`null\` if there is none;
- \`null\`: \`null\`;
- array: an array of the same length with \`.field\` applied to each element by these same rules (so nested arrays are mapped recursively);
- anything else: \`cannot read field "FIELD" of TYPE\`.

\`value[index]\` (both are evaluated first):
- if either is \`null\`, the result is \`null\`;
- array or string with a number index: the index must be an integer, otherwise \`index must be an integer\`. Negative indexes count from the end (\`-1\` is the last element). Out of range gives \`null\`. Strings are indexed by code point, and the result is a one-code-point string;
- object with a string index: the own property's value, or \`null\`;
- anything else: \`cannot index TYPE with TYPE\` (the value's type, then the index's).

### 5.2 Arithmetic

\`+ - * / % ^\` and unary \`-\`: if any operand is \`null\` the result is \`null\`. Otherwise every operand must be a number, otherwise \`cannot apply "OP" to TYPE and TYPE\` (unary: \`cannot apply "-" to TYPE\`). \`/\` and \`%\` with a zero divisor are \`division by zero\`. \`%\` is the floored modulo: a non-zero result has the sign of the divisor (\`-7 % 3\` is \`2\`, \`7 % -3\` is \`-2\`, \`5.5 % 2\` is \`1.5\`). \`^\` is exponentiation.

### 5.3 Concatenation

\`a & b\` converts both operands to text (section 7) and joins them. \`null\` is the empty text here; it does not propagate. If either operand is an array or object: \`cannot apply "&" to TYPE and TYPE\`.

### 5.4 Comparison

- \`=\` and \`!=\` compare any two values and never fail: values of different types are unequal, numbers and strings compare by value, \`null = null\` is \`true\`, arrays are equal when they have the same length and equal elements in order, and objects when they have the same own keys (in any order) with equal values.
- \`< <= > >=\`: if either operand is \`null\`, the result is \`null\`. Two numbers compare numerically; two strings compare by code points, element by element, a proper prefix being smaller. Anything else: \`cannot apply "OP" to TYPE and TYPE\`.
- \`a in b\`: if \`b\` is \`null\` the result is \`null\`. If \`b\` is an array, \`true\` exactly when some element \`=\` \`a\` (\`a\` may be any value, including \`null\`). If \`b\` is a string or an object: \`null\` when \`a\` is \`null\`; otherwise \`a\` must be a string, and the result is whether it is a substring of \`b\` (the empty string is in every string) or an own key of \`b\`, respectively. Every other combination: \`cannot apply "in" to TYPE and TYPE\`.

### 5.5 Logic

Sift has three-valued logic over \`true\`, \`false\` and \`null\` (unknown). Every operand of \`not\`, \`and\` and \`or\` must be a boolean or \`null\`, otherwise \`cannot apply "OP" to TYPE\` with the type of the offending operand. Each operand is checked right after it is evaluated.

- \`not\`: \`not null\` is \`null\`.
- \`a and b\`: if \`a\` is \`false\` the result is \`false\` and \`b\` is not evaluated. Otherwise \`b\` is evaluated: if it is \`false\` the result is \`false\`; if both are \`true\`, \`true\`; otherwise \`null\`.
- \`a or b\`: if \`a\` is \`true\` the result is \`true\` and \`b\` is not evaluated. Otherwise \`b\` is evaluated: if it is \`true\` the result is \`true\`; if both are \`false\`, \`false\`; otherwise \`null\`.

### 5.6 Other forms

- \`a ?? b\` is \`a\` when \`a\` is not \`null\` (then \`b\` is not evaluated), otherwise \`b\`.
- \`[a, b, ...]\` is an array of the element values; \`[]\` is the empty array.
- Literals are their values; \`null\`, \`true\`, \`false\` in any case.

## 6. Functions

| Function | Arguments | Result |
|---|---|---|
| \`len(x)\` | 1 | string: number of code points; array: number of elements; object: number of own keys; \`null\`: \`null\` |
| \`lower(s)\`, \`upper(s)\` | 1 | string: \`toLowerCase()\` / \`toUpperCase()\`; \`null\`: \`null\` |
| \`round(x)\` | 1 | number: the nearest integer, ties to the even integer (\`round(2.5)\` is \`2\`, \`round(-1.5)\` is \`-2\`); \`null\`: \`null\` |
| \`sum(a)\` | 1 | array: the sum of its numbers, added from left to right starting from \`0\`, skipping \`null\` elements (\`sum([])\` is \`0\`), and any other element is a bad argument; \`null\`: \`null\` |
| \`join(a, sep)\` | 2 | both arguments are evaluated. \`a\` \`null\`: \`null\`. Otherwise \`a\` must be an array whose elements are all \`null\`, booleans, numbers or strings, and \`sep\` must be a string; the result is the elements converted to text (section 7) joined with \`sep\` |
| \`keys(o)\` | 1 | object: its own keys sorted by code points (as \`<\` compares strings); \`null\`: \`null\` |
| \`if(c, a, b)\` | 3 | \`c\` is evaluated first and must be a boolean or \`null\`. \`true\`: evaluates and returns \`a\`; \`false\` or \`null\`: evaluates and returns \`b\`. The other branch is not evaluated |
| \`coalesce(x1, ...)\` | 1 or more | evaluates the arguments from left to right and returns the first that is not \`null\`, without evaluating the rest; \`null\` if all are \`null\` |

An argument of a type the table does not allow is the error \`bad argument for "NAME"\`.

## 7. Text conversion

\`null\` is the empty text, strings are themselves, booleans are \`true\` and \`false\`, and numbers are converted with JavaScript's \`String(number)\` (\`0.1 + 0.2\` gives \`0.30000000000000004\`). Arrays and objects have no text form.

## 8. Errors

\`SiftError\` extends \`Error\`. Its \`name\` is \`"SiftError"\`, its \`line\` and \`column\` properties are the position of the error as numbers, and its \`message\` is \`TEXT at LINE:COLUMN\`, for example \`unexpected token ")" at 2:7\`. TEXT is one of the texts defined above:

| TEXT | Section |
|---|---|
| \`invalid number "RUN"\`, \`invalid escape\`, \`unterminated string\`, \`unterminated name\`, \`empty name\`, \`unexpected character "C"\` | 2 |
| \`unexpected token "TEXT"\`, \`unexpected end of input\`, \`comparison operators cannot be chained\` | 3 |
| \`unknown function "NAME"\`, \`wrong number of arguments for "NAME"\` | 4 |
| \`cannot read field "FIELD" of TYPE\`, \`cannot index TYPE with TYPE\`, \`index must be an integer\`, \`cannot apply "OP" to TYPE and TYPE\`, \`cannot apply "OP" to TYPE\`, \`division by zero\`, \`number out of range\`, \`bad argument for "NAME"\` | 5, 6 |
`);

const ERRORS_JS = String.raw`/** Every compile-time and run-time problem is a SiftError; see docs/SIFT.md section 8. */
export class SiftError extends Error {
  constructor(text, at) {
    super(text + ' at ' + at.line + ':' + at.column);
    this.name = 'SiftError';
    this.line = at.line;
    this.column = at.column;
  }
}

export function fail(text, at) {
  throw new SiftError(text, at);
}
`;

const LEXER_JS = String.raw`import {fail} from './errors.js';

const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'null', 'true', 'false']);
const OPERATORS = ['!=', '<=', '>=', '??', '+', '-', '*', '/', '%', '^', '&', '=', '<', '>', '(', ')', '[', ']', ',', '.'];
const BACKTICK = '\x60';
const NUMBER = /^[0-9]+(_[0-9]+)*(\.[0-9]+(_[0-9]+)*)?$/;
const isDigit = c => c !== undefined && c >= '0' && c <= '9';
const isNameStart = c => c !== undefined && /^[A-Za-z_]$/.test(c);
const isNameChar = c => c !== undefined && /^[A-Za-z0-9_]$/.test(c);

/** Tokens are {type, value, text, line, column}; the list ends with an 'end' token. See docs/SIFT.md sections 1 and 2. */
export function tokenize(source) {
  const chars = [...source];
  const tokens = [];
  let i = 0, line = 1, column = 1;
  const here = () => ({line, column});
  const advance = () => {
    const c = chars[i++];
    if (c === '\n' || (c === '\r' && chars[i] !== '\n')) { line++; column = 1; }
    else column++;
    return c;
  };
  while (i < chars.length) {
    const c = chars[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { advance(); continue; }
    if (c === '#') { while (i < chars.length && chars[i] !== '\n' && chars[i] !== '\r') advance(); continue; }
    const at = here();
    const start = i;
    const push = (type, value) => tokens.push({type, value, text: chars.slice(start, i).join(''), line: at.line, column: at.column});
    if (isDigit(c)) {
      while (isNameChar(chars[i]) || chars[i] === '.') advance();
      const run = chars.slice(start, i).join('');
      const value = Number(run.replaceAll('_', ''));
      if (!NUMBER.test(run) || !Number.isFinite(value)) fail('invalid number "' + run + '"', at);
      push('number', value);
    } else if (isNameStart(c)) {
      while (isNameChar(chars[i])) advance();
      const word = chars.slice(start, i).join('');
      if (KEYWORDS.has(word.toLowerCase())) push('keyword', word.toLowerCase());
      else push('name', word);
    } else if (c === BACKTICK) {
      advance();
      while (i < chars.length && chars[i] !== BACKTICK && chars[i] !== '\n' && chars[i] !== '\r') advance();
      if (chars[i] !== BACKTICK) fail('unterminated name', at);
      advance();
      if (i - start === 2) fail('empty name', at);
      push('quoted', chars.slice(start + 1, i - 1).join(''));
    } else if (c === '"') {
      advance();
      let value = '';
      for (;;) {
        const d = chars[i];
        if (d === undefined || d === '\n' || d === '\r') fail('unterminated string', at);
        if (d === '"') { advance(); break; }
        if (d !== '\\') { value += advance(); continue; }
        const escape = here();
        advance();
        const e = chars[i];
        if (e === '"' || e === '\\') value += advance();
        else if (e === 'n') { advance(); value += '\n'; }
        else if (e === 't') { advance(); value += '\t'; }
        else if (e === 'u' && chars[i + 1] === '{') {
          advance(); advance();
          let hex = '';
          while (i < chars.length && /^[0-9A-Fa-f]$/.test(chars[i])) hex += advance();
          const code = parseInt(hex, 16);
          if (chars[i] !== '}' || hex.length < 1 || hex.length > 6 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) fail('invalid escape', escape);
          advance();
          value += String.fromCodePoint(code);
        } else fail('invalid escape', escape);
      }
      push('string', value);
    } else {
      const op = OPERATORS.find(o => chars.slice(i, i + o.length).join('') === o);
      if (!op) fail('unexpected character "' + c + '"', at);
      for (let n = 0; n < op.length; n++) advance();
      push('op', op);
    }
  }
  tokens.push({type: 'end', value: null, text: '', line, column});
  return tokens;
}
`;

const PARSER_JS = String.raw`import {fail} from './errors.js';

const COMPARISONS = ['=', '!=', '<', '<=', '>', '>='];

/** Recursive descent over docs/SIFT.md section 3. Nodes carry 'at', the token their run-time errors are reported at. */
export function parse(tokens) {
  let k = 0;
  const peek = () => tokens[k];
  const next = () => tokens[k++];
  const isOp = (token, ...ops) => token.type === 'op' && ops.includes(token.value);
  const isKeyword = (token, word) => token.type === 'keyword' && token.value === word;
  const isComparison = token => isOp(token, ...COMPARISONS) || isKeyword(token, 'in');
  const unexpected = token => fail(token.type === 'end' ? 'unexpected end of input' : 'unexpected token "' + token.text + '"', token);
  const expect = op => { const token = next(); if (!isOp(token, op)) unexpected(token); return token; };
  const binary = (type, at, left, right) => ({type, op: at.value, at, left, right});

  const or = () => {
    let left = and();
    while (isKeyword(peek(), 'or')) { const at = next(); left = binary('or', at, left, and()); }
    return left;
  };
  const and = () => {
    let left = not();
    while (isKeyword(peek(), 'and')) { const at = next(); left = binary('and', at, left, not()); }
    return left;
  };
  const not = () => {
    if (!isKeyword(peek(), 'not')) return comparison();
    const at = next();
    return {type: 'not', op: 'not', at, operand: not()};
  };
  const comparison = () => {
    const left = additive();
    if (!isComparison(peek())) return left;
    const at = next();
    const node = binary('binary', at, left, additive());
    if (isComparison(peek())) fail('comparison operators cannot be chained', peek());
    return node;
  };
  const additive = () => {
    let left = multiplicative();
    while (isOp(peek(), '+', '-', '&')) { const at = next(); left = binary('binary', at, left, multiplicative()); }
    return left;
  };
  const multiplicative = () => {
    let left = unary();
    while (isOp(peek(), '*', '/', '%')) { const at = next(); left = binary('binary', at, left, unary()); }
    return left;
  };
  const unary = () => {
    if (!isOp(peek(), '-')) return power();
    const at = next();
    return {type: 'negate', op: '-', at, operand: unary()};
  };
  const power = () => {
    const base = coalesce();
    if (!isOp(peek(), '^')) return base;
    const at = next();
    return binary('binary', at, base, unary());
  };
  const coalesce = () => {
    let left = postfix();
    while (isOp(peek(), '??')) { const at = next(); left = binary('coalesce', at, left, postfix()); }
    return left;
  };
  const postfix = () => {
    let node = primary();
    for (;;) {
      if (isOp(peek(), '.')) {
        const at = next();
        const name = next();
        if (name.type !== 'name' && name.type !== 'quoted' && name.type !== 'keyword') unexpected(name);
        node = {type: 'field', at, object: node, name: name.type === 'keyword' ? name.text : name.value};
      } else if (isOp(peek(), '[')) {
        const at = next();
        const index = expression();
        expect(']');
        node = {type: 'index', at, object: node, index};
      } else return node;
    }
  };
  const list = close => {
    const items = [];
    if (isOp(peek(), close)) { next(); return items; }
    for (;;) {
      items.push(expression());
      const token = next();
      if (isOp(token, close)) return items;
      if (!isOp(token, ',')) unexpected(token);
    }
  };
  const primary = () => {
    const token = next();
    switch (token.type) {
      case 'number':
      case 'string':
        return {type: 'literal', value: token.value};
      case 'keyword':
        if (token.value === 'null') return {type: 'literal', value: null};
        if (token.value === 'true' || token.value === 'false') return {type: 'literal', value: token.value === 'true'};
        break;
      case 'name':
        if (isOp(peek(), '(')) { next(); return {type: 'call', at: token, name: token.value, args: list(')')}; }
        return {type: 'field', at: token, object: null, name: token.value};
      case 'quoted':
        return {type: 'field', at: token, object: null, name: token.value};
      case 'op':
        if (token.value === '(') { const node = expression(); expect(')'); return node; }
        if (token.value === '[') return {type: 'array', items: list(']')};
    }
    return unexpected(token);
  };
  const expression = or;

  const tree = expression();
  if (peek().type !== 'end') unexpected(peek());
  return tree;
}
`;

const CHECK_JS = String.raw`import {fail} from './errors.js';
import {FUNCTIONS} from './functions.js';

/** docs/SIFT.md section 4: after a successful parse, check every call in source order (a pre-order walk). */
export function check(node) {
  if (!node) return;
  if (node.type === 'call') {
    if (!Object.hasOwn(FUNCTIONS, node.name)) fail('unknown function "' + node.name + '"', node.at);
    const [min, max] = FUNCTIONS[node.name].arity;
    if (node.args.length < min || node.args.length > max) fail('wrong number of arguments for "' + node.name + '"', node.at);
  }
  for (const child of [node.object, node.index, node.left, node.right, node.operand, ...(node.args ?? []), ...(node.items ?? [])]) check(child);
}
`;

const VALUES_JS = String.raw`import {fail} from './errors.js';

export function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Deep equality of docs/SIFT.md section 5.4. */
export function equal(a, b) {
  if (a === b) return true;
  const type = typeName(a);
  if (type !== typeName(b)) return false;
  if (type === 'array') return a.length === b.length && a.every((item, i) => equal(item, b[i]));
  if (type === 'object') {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
  }
  return false;
}

/** Order of two strings by code points. */
export function compareText(a, b) {
  const x = [...a], y = [...b];
  for (let i = 0; i < x.length && i < y.length; i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** Text form of docs/SIFT.md section 7, or undefined for arrays and objects. */
export function toText(value) {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** Every computed number is finite and never negative zero. */
export function finite(n, at) {
  if (!Number.isFinite(n)) fail('number out of range', at);
  return n === 0 ? 0 : n;
}
`;

const FUNCTIONS_JS = String.raw`import {fail} from './errors.js';
import {compareText, finite, toText, typeName} from './values.js';

const bad = (name, at) => fail('bad argument for "' + name + '"', at);

/** docs/SIFT.md section 6. call(args, ev, at) gets the argument nodes unevaluated; ev(node) evaluates one. */
export const FUNCTIONS = {
  len: {arity: [1, 1], call([x], ev, at) {
    const value = ev(x);
    if (value === null) return null;
    if (typeof value === 'string') return [...value].length;
    if (Array.isArray(value)) return value.length;
    if (typeof value === 'object') return Object.keys(value).length;
    return bad('len', at);
  }},
  lower: {arity: [1, 1], call([x], ev, at) {
    const value = ev(x);
    if (value === null) return null;
    return typeof value === 'string' ? value.toLowerCase() : bad('lower', at);
  }},
  upper: {arity: [1, 1], call([x], ev, at) {
    const value = ev(x);
    if (value === null) return null;
    return typeof value === 'string' ? value.toUpperCase() : bad('upper', at);
  }},
  round: {arity: [1, 1], call([x], ev, at) {
    const value = ev(x);
    if (value === null) return null;
    if (typeof value !== 'number') return bad('round', at);
    const floor = Math.floor(value), rest = value - floor;
    return finite(rest < 0.5 ? floor : rest > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1, at);
  }},
  sum: {arity: [1, 1], call([x], ev, at) {
    const value = ev(x);
    if (value === null) return null;
    if (!Array.isArray(value)) return bad('sum', at);
    let total = 0;
    for (const item of value) {
      if (item === null) continue;
      if (typeof item !== 'number') return bad('sum', at);
      total += item;
    }
    return finite(total, at);
  }},
  join: {arity: [2, 2], call([a, sep], ev, at) {
    const list = ev(a), separator = ev(sep);
    if (list === null) return null;
    if (!Array.isArray(list) || typeof separator !== 'string') return bad('join', at);
    const texts = list.map(toText);
    return texts.includes(undefined) ? bad('join', at) : texts.join(separator);
  }},
  keys: {arity: [1, 1], call([x], ev, at) {
    const value = ev(x);
    if (value === null) return null;
    return typeName(value) === 'object' ? Object.keys(value).sort(compareText) : bad('keys', at);
  }},
  if: {arity: [3, 3], call([c, a, b], ev, at) {
    const condition = ev(c);
    if (condition === true) return ev(a);
    if (condition === false || condition === null) return ev(b);
    return bad('if', at);
  }},
  coalesce: {arity: [1, Infinity], call(args, ev) {
    for (const arg of args) {
      const value = ev(arg);
      if (value !== null) return value;
    }
    return null;
  }},
};
`;

const EVALUATE_JS = String.raw`import {fail} from './errors.js';
import {FUNCTIONS} from './functions.js';
import {compareText, equal, finite, toText, typeName} from './values.js';

const ARITHMETIC = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
  '%': (a, b) => { const r = a % b; return r !== 0 && (r < 0) !== (b < 0) ? r + b : r; },
  '^': (a, b) => a ** b,
};

/** Evaluate a parsed expression against one record (docs/SIFT.md section 5). */
export function evaluate(node, record) {
  const ev = child => evaluate(child, record);
  switch (node.type) {
    case 'literal': return node.value;
    case 'array': return node.items.map(ev);
    case 'field':
      if (node.object === null) return Object.hasOwn(record, node.name) ? record[node.name] : null;
      return field(ev(node.object), node.name, node.at);
    case 'index': {
      const object = ev(node.object);
      return index(object, ev(node.index), node.at);
    }
    case 'negate': {
      const value = ev(node.operand);
      if (value === null) return null;
      if (typeof value !== 'number') fail('cannot apply "-" to ' + typeName(value), node.at);
      return finite(-value, node.at);
    }
    case 'not': {
      const value = logical(ev(node.operand), node);
      return value === null ? null : !value;
    }
    case 'and': {
      const left = logical(ev(node.left), node);
      if (left === false) return false;
      const right = logical(ev(node.right), node);
      if (right === false) return false;
      return left && right ? true : null;
    }
    case 'or': {
      const left = logical(ev(node.left), node);
      if (left === true) return true;
      const right = logical(ev(node.right), node);
      if (right === true) return true;
      return left === false && right === false ? false : null;
    }
    case 'coalesce': {
      const left = ev(node.left);
      return left !== null ? left : ev(node.right);
    }
    case 'binary': {
      const left = ev(node.left);
      return binary(node.op, left, ev(node.right), node.at);
    }
    case 'call': return FUNCTIONS[node.name].call(node.args, ev, node.at);
  }
  throw Error('unknown node ' + node.type);
}

function logical(value, node) {
  if (value !== null && typeof value !== 'boolean') fail('cannot apply "' + node.op + '" to ' + typeName(value), node.at);
  return value;
}

function field(value, name, at) {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(item => field(item, name, at));
  if (typeof value === 'object') return Object.hasOwn(value, name) ? value[name] : null;
  return fail('cannot read field "' + name + '" of ' + typeName(value), at);
}

function index(object, index, at) {
  if (object === null || index === null) return null;
  if ((Array.isArray(object) || typeof object === 'string') && typeof index === 'number') {
    if (!Number.isInteger(index)) fail('index must be an integer', at);
    const items = typeof object === 'string' ? [...object] : object;
    const i = index < 0 ? items.length + index : index;
    return i >= 0 && i < items.length ? items[i] : null;
  }
  if (typeName(object) === 'object' && typeof index === 'string') return Object.hasOwn(object, index) ? object[index] : null;
  return fail('cannot index ' + typeName(object) + ' with ' + typeName(index), at);
}

function binary(op, a, b, at) {
  const mismatch = () => fail('cannot apply "' + op + '" to ' + typeName(a) + ' and ' + typeName(b), at);
  if (Object.hasOwn(ARITHMETIC, op)) {
    if (a === null || b === null) return null;
    if (typeof a !== 'number' || typeof b !== 'number') return mismatch();
    if ((op === '/' || op === '%') && b === 0) fail('division by zero', at);
    return finite(ARITHMETIC[op](a, b), at);
  }
  switch (op) {
    case '&': {
      const x = toText(a), y = toText(b);
      return x === undefined || y === undefined ? mismatch() : x + y;
    }
    case '=': return equal(a, b);
    case '!=': return !equal(a, b);
    case 'in':
      if (b === null) return null;
      if (Array.isArray(b)) return b.some(item => equal(a, item));
      if (typeof b === 'string' || typeName(b) === 'object') {
        if (a === null) return null;
        if (typeof a !== 'string') return mismatch();
        return typeof b === 'string' ? b.includes(a) : Object.hasOwn(b, a);
      }
      return mismatch();
  }
  if (a === null || b === null) return null;
  let order;
  if (typeof a === 'number' && typeof b === 'number') order = a < b ? -1 : a > b ? 1 : 0;
  else if (typeof a === 'string' && typeof b === 'string') order = compareText(a, b);
  else return mismatch();
  return op === '<' ? order < 0 : op === '<=' ? order <= 0 : op === '>' ? order > 0 : order >= 0;
}
`;

const INDEX_JS = String.raw`import {check} from './check.js';
import {evaluate as run} from './evaluate.js';
import {tokenize} from './lexer.js';
import {parse} from './parser.js';

export {SiftError} from './errors.js';

/** Compile a Sift expression (docs/SIFT.md) into a function of one record. */
export function compile(source) {
  const tree = parse(tokenize(source));
  check(tree);
  return record => run(tree, record);
}

export const evaluate = (source, record) => compile(source)(record);
`;

// ---- The fixture: an early version that is incomplete and deviates from the spec in places. ----

const FIXTURE_LEXER = patch(LEXER_JS, [
  ["const OPERATORS = ['!=', '<=', '>=', '??', '+', '-', '*', '/', '%', '^', '&',", "const OPERATORS = ['!=', '<=', '>=', '+', '-', '*', '/', '%', '&',"],
  ["const BACKTICK = '\\x60';\n", ''],
  ['const NUMBER = /^[0-9]+(_[0-9]+)*(\\.[0-9]+(_[0-9]+)*)?$/;', 'const NUMBER = /^[0-9]+(\\.[0-9]+)?$/;'],
  ['const chars = [...source];', "const chars = source.split('');"],
  ['let i = 0, line = 1, column = 1;', 'let i = 0, line = 1, column = 1, lastEnd = {line, column};'],
  ["if (c === '\\n' || (c === '\\r' && chars[i] !== '\\n')) { line++; column = 1; }", "if (c === '\\n') { line++; column = 1; }"],
  ["    if (c === '#') { while (i < chars.length && chars[i] !== '\\n' && chars[i] !== '\\r') advance(); continue; }\n", ''],
  ["const push = (type, value) => tokens.push(", "const push = (type, value) => (lastEnd = here(), tokens.push("],
  ["line: at.line, column: at.column});", "line: at.line, column: at.column}));"],
  ["if (KEYWORDS.has(word.toLowerCase())) push('keyword', word.toLowerCase());", "if (KEYWORDS.has(word)) push('keyword', word);"],
  [`    } else if (c === BACKTICK) {
      advance();
      while (i < chars.length && chars[i] !== BACKTICK && chars[i] !== '\\n' && chars[i] !== '\\r') advance();
      if (chars[i] !== BACKTICK) fail('unterminated name', at);
      advance();
      if (i - start === 2) fail('empty name', at);
      push('quoted', chars.slice(start + 1, i - 1).join(''));
`, ''],
  [`        else if (e === 'u' && chars[i + 1] === '{') {
          advance(); advance();
          let hex = '';
          while (i < chars.length && /^[0-9A-Fa-f]$/.test(chars[i])) hex += advance();
          const code = parseInt(hex, 16);
          if (chars[i] !== '}' || hex.length < 1 || hex.length > 6 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) fail('invalid escape', escape);
          advance();
          value += String.fromCodePoint(code);
        } else fail('invalid escape', escape);`, "        else fail('invalid escape', escape);"],
  ["tokens.push({type: 'end', value: null, text: '', line, column});", "tokens.push({type: 'end', value: null, text: '', ...lastEnd});"],
]);

const FIXTURE_PARSER = patch(PARSER_JS, [
  ["import {fail} from './errors.js';", "import {fail} from './errors.js';\nimport {FUNCTIONS} from './functions.js';"],
  ["const isComparison = token => isOp(token, ...COMPARISONS) || isKeyword(token, 'in');", 'const isComparison = token => isOp(token, ...COMPARISONS);'],
  [`    const left = additive();
    if (!isComparison(peek())) return left;
    const at = next();
    const node = binary('binary', at, left, additive());
    if (isComparison(peek())) fail('comparison operators cannot be chained', peek());
    return node;`, `    let left = additive();
    while (isComparison(peek())) { const at = next(); left = binary('binary', at, left, additive()); }
    return left;`],
  ["if (!isOp(peek(), '-')) return power();", "if (!isOp(peek(), '-')) return postfix();"],
  [`  const power = () => {
    const base = coalesce();
    if (!isOp(peek(), '^')) return base;
    const at = next();
    return binary('binary', at, base, unary());
  };
  const coalesce = () => {
    let left = postfix();
    while (isOp(peek(), '??')) { const at = next(); left = binary('coalesce', at, left, postfix()); }
    return left;
  };
`, ''],
  ["if (name.type !== 'name' && name.type !== 'quoted' && name.type !== 'keyword') unexpected(name);", "if (name.type !== 'name') unexpected(name);"],
  ["name: name.type === 'keyword' ? name.text : name.value};", 'name: name.value};'],
  ["if (isOp(peek(), '(')) { next(); return {type: 'call', at: token, name: token.value, args: list(')')}; }", `if (isOp(peek(), '(')) {
          if (!FUNCTIONS[token.value]) fail('unknown function "' + token.value + '"', token);
          next();
          const node = {type: 'call', at: token, name: token.value, args: list(')')};
          const [min, max] = FUNCTIONS[node.name].arity;
          if (node.args.length < min || node.args.length > max) fail('wrong number of arguments for "' + node.name + '"', token);
          return node;
        }`],
  [`      case 'quoted':
        return {type: 'field', at: token, object: null, name: token.value};
`, ''],
]);

const FIXTURE_VALUES = patch(VALUES_JS, [
  [`/** Order of two strings by code points. */
export function compareText(a, b) {
  const x = [...a], y = [...b];
  for (let i = 0; i < x.length && i < y.length; i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

`, ''],
  ['/** Every computed number is finite and never negative zero. */', '/** Every computed number is finite. */'],
  ['return n === 0 ? 0 : n;', 'return n;'],
]);

const FIXTURE_EVALUATE = patch(EVALUATE_JS, [
  ["import {compareText, equal, finite, toText, typeName} from './values.js';", "import {equal, finite, toText, typeName} from './values.js';"],
  ["'%': (a, b) => { const r = a % b; return r !== 0 && (r < 0) !== (b < 0) ? r + b : r; },", "'%': (a, b) => a % b,"],
  ["  '^': (a, b) => a ** b,\n", ''],
  ['if (left === false) return false;', 'if (left !== true) return left;'],
  ['if (left === true) return true;', 'if (left !== false) return left;'],
  [`    case 'coalesce': {
      const left = ev(node.left);
      return left !== null ? left : ev(node.right);
    }
`, ''],
  ['  if (Array.isArray(value)) return value.map(item => field(item, name, at));\n', ''],
  ["if (typeof value === 'object') return Object.hasOwn(value, name)", "if (typeName(value) === 'object') return Object.hasOwn(value, name)"],
  ["const items = typeof object === 'string' ? [...object] : object;", "const items = typeof object === 'string' ? object.split('') : object;"],
  ['const i = index < 0 ? items.length + index : index;', 'const i = index;'],
  [`    case 'in':
      if (b === null) return null;
      if (Array.isArray(b)) return b.some(item => equal(a, item));
      if (typeof b === 'string' || typeName(b) === 'object') {
        if (a === null) return null;
        if (typeof a !== 'string') return mismatch();
        return typeof b === 'string' ? b.includes(a) : Object.hasOwn(b, a);
      }
      return mismatch();
`, ''],
  ['order = compareText(a, b);', 'order = a < b ? -1 : a > b ? 1 : 0;'],
]);

const FIXTURE_FUNCTIONS = String.raw`import {fail} from './errors.js';

const bad = (name, at) => fail('bad argument for "' + name + '"', at);

/** docs/SIFT.md section 6. call(args, ev, at) gets the argument nodes unevaluated; ev(node) evaluates one. */
export const FUNCTIONS = {
  len: {arity: [1, 1], call([x], ev, at) {
    const value = ev(x);
    if (value === null) return null;
    if (typeof value === 'string' || Array.isArray(value)) return value.length;
    if (typeof value === 'object') return Object.keys(value).length;
    return bad('len', at);
  }},
  lower: {arity: [1, 1], call([x], ev, at) {
    const value = ev(x);
    if (value === null) return null;
    return typeof value === 'string' ? value.toLowerCase() : bad('lower', at);
  }},
  upper: {arity: [1, 1], call([x], ev, at) {
    const value = ev(x);
    if (value === null) return null;
    return typeof value === 'string' ? value.toUpperCase() : bad('upper', at);
  }},
  if: {arity: [3, 3], call(args, ev, at) {
    const [condition, a, b] = args.map(ev);
    if (condition === true) return a;
    if (condition === false || condition === null) return b;
    return bad('if', at);
  }},
  coalesce: {arity: [1, Infinity], call(args, ev) {
    return args.map(ev).find(value => value !== null) ?? null;
  }},
};
`;

const FIXTURE_INDEX = String.raw`import {evaluate as run} from './evaluate.js';
import {tokenize} from './lexer.js';
import {parse} from './parser.js';

export {SiftError} from './errors.js';

/** Compile a Sift expression (docs/SIFT.md) into a function of one record. */
export function compile(source) {
  const tree = parse(tokenize(source));
  return record => run(tree, record);
}

export const evaluate = (source, record) => compile(source)(record);
`;

const VISIBLE = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {compile, evaluate, SiftError} from '../src/index.js';

const person = {name: 'Ada', age: 36, tags: ['math', 'code'], address: {city: 'London'}, score: null};

test('arithmetic and precedence', () => {
  assert.equal(evaluate('1 + 2 * 3', {}), 7);
  assert.equal(evaluate('(1 + 2) * 3', {}), 9);
  assert.equal(evaluate('10 - 4 - 3', {}), 3);
  assert.equal(evaluate('7 / 2', {}), 3.5);
});

test('fields and indexes', () => {
  assert.equal(evaluate('name', person), 'Ada');
  assert.equal(evaluate('address.city', person), 'London');
  assert.equal(evaluate('tags[1]', person), 'code');
  assert.equal(evaluate('tags[2]', person), null);
  assert.equal(evaluate('missing', person), null);
  assert.equal(evaluate('missing.deeper', person), null);
});

test('null propagates through arithmetic', () => {
  assert.equal(evaluate('score * 2', person), null);
});

test('comparison and logic', () => {
  assert.equal(evaluate('age >= 18 and name = "Ada"', person), true);
  assert.equal(evaluate('not (age < 18) or false', person), true);
  assert.equal(evaluate('tags = ["math", "code"]', person), true);
});

test('concatenation', () => {
  assert.equal(evaluate('name & " is " & age', person), 'Ada is 36');
});

test('functions', () => {
  assert.equal(evaluate('upper(name)', person), 'ADA');
  assert.equal(evaluate('len(tags)', person), 2);
  assert.equal(evaluate('coalesce(score, 0)', person), 0);
});

test('compiled expressions are reusable', () => {
  const adult = compile('age >= 18');
  assert.equal(adult({age: 20}), true);
  assert.equal(adult({age: 3}), false);
});

test('syntax errors carry a position', () => {
  assert.throws(() => compile('1 +\n  * 2'), error => error instanceof SiftError && error.message === 'unexpected token "*" at 2:3' && error.line === 2 && error.column === 3);
});

test('type errors are raised when evaluating', () => {
  const double = compile('name * 2');
  assert.throws(() => double(person), {name: 'SiftError', message: 'cannot apply "*" to string and number at 1:6'});
});
`;

const files = {
  'package.json': JSON.stringify({name: 'sift', version: '0.3.0', private: true, type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'README.md': '# sift\n\nA small expression language for filtering and projecting JSON records. The language is specified in docs/SIFT.md.\n\n```js\nimport {evaluate} from \'./src/index.js\';\nevaluate(\'age >= 18 and upper(name) = "ADA"\', {name: \'Ada\', age: 36}); // true\n```\n',
  'docs/SIFT.md': SPEC,
  'src/index.js': FIXTURE_INDEX,
  'src/errors.js': ERRORS_JS,
  'src/lexer.js': FIXTURE_LEXER,
  'src/parser.js': FIXTURE_PARSER,
  'src/values.js': FIXTURE_VALUES,
  'src/evaluate.js': FIXTURE_EVALUATE,
  'src/functions.js': FIXTURE_FUNCTIONS,
  'test/sift.test.js': VISIBLE,
};

const REFERENCE = {
  'src/index.js': INDEX_JS, 'src/lexer.js': LEXER_JS, 'src/parser.js': PARSER_JS, 'src/check.js': CHECK_JS,
  'src/values.js': VALUES_JS, 'src/evaluate.js': EVALUATE_JS, 'src/functions.js': FUNCTIONS_JS,
};

const people = {
  items: [{price: 1}, {price: 2}, {}, null],
  matrix: [[{a: 1}, {a: 2}], [{a: 3}]],
  o: {k: 1, b: 1, a: 2, B: 3, '\u{1F600}': 0, '\uFF5A': 0},
  s: 'h\u{1F600}llo',
};

// [source, record, expected value]
const VALUES = [
  ['1_000 + 2_5.5_0', {}, 1025.5],
  ['"a\\u{1F600}b\\u{41}\\u{000061}"', {}, 'a\u{1F600}bAa'],
  ['"\\"q\\" \\\\ \\t."', {}, '"q" \\ \t.'],
  ['len("\\u{1F600}x")', {}, 2],
  ['x # the field x\n + 1 # done', {x: 1}, 2],
  ['`first name` & "!"', {'first name': 'Ada'}, 'Ada!'],
  ['`true`', {true: 5}, 5],
  ['TRUE and NOT False', {}, true],
  ['nULL ?? 4', {}, 4],
  ['a.NULL + a.and', {a: {NULL: 3, and: 4}}, 7],
  ['a.`x y`', {a: {'x y': 9}}, 9],
  ['len (tags)', {tags: [1, 2, 3]}, 3],
  ['-2 ^ 2', {}, -4],
  ['2 ^ 3 ^ 2', {}, 512],
  ['2 ^ -1', {}, 0.5],
  ['2 ^ x ?? 3', {x: null}, 8],
  ['-x ?? 5', {x: null}, -5],
  ['1 + x ?? 2 * 3', {x: null}, 7],
  ['not a = b', {a: 1, b: 2}, true],
  ['-7 % 3', {}, 2],
  ['7 % -3', {}, -2],
  ['5.5 % 2', {}, 1.5],
  ['-6 % 3', {}, 0],
  ['0 * -1', {}, 0],
  ['-x', {x: 0}, 0],
  ['null / 0', {}, null],
  ['x % 0', {x: null}, null],
  ['round(2.5)', {}, 2],
  ['round(3.5)', {}, 4],
  ['round(-2.5)', {}, -2],
  ['round(-1.5)', {}, -2],
  ['round(2.4999)', {}, 2],
  ['round(-0.4)', {}, 0],
  ['round(null)', {}, null],
  ['sum([1, null, 2.5])', {}, 3.5],
  ['sum([])', {}, 0],
  ['sum(x)', {}, null],
  ['join(["a", 1, null, true], "-")', {}, 'a-1--true'],
  ['join(null, 1)', {}, null],
  ['keys(o)', people, ['B', 'a', 'b', 'k', '\uFF5A', '\u{1F600}']],
  ['keys(null)', {}, null],
  ['"\\u{1F600}" > "\\u{FF5A}"', {}, true],
  ['"Z" < "a" and "ab" < "abc" and "b" > "abc"', {}, true],
  ['x < 3', {x: null}, null],
  ['null = null', {}, true],
  ['1 = "1"', {}, false],
  ['a = b', {a: {x: [1, 2], y: null}, b: {y: null, x: [1, 2]}}, true],
  ['a != b', {a: {x: 1}, b: {x: 1, y: null}}, true],
  ['null and false', {}, false],
  ['null and true', {}, null],
  ['false and x', {x: 5}, false],
  ['true or x', {x: 5}, true],
  ['null or true', {}, true],
  ['null or false', {}, null],
  ['not null', {}, null],
  ['x in [1, 2, null]', {x: null}, true],
  ['[1] in [[1], 2]', {}, true],
  ['"b" in "abc" and "" in "abc"', {}, true],
  ['"k" in o', people, true],
  ['"constructor" in o', people, false],
  ['3 in null', {}, null],
  ['null in "abc"', {}, null],
  ['items.price', people, [1, 2, null, null]],
  ['matrix.a', people, [[1, 2], [3]]],
  ['items[-1]', people, null],
  ['items[-4].price', people, 1],
  ['items[9]', people, null],
  ['s[1] & s[-1]', people, '\u{1F600}o'],
  ['len(s)', people, 5],
  ['o["k"] + o["zz"] ?? 7', people, 8],
  ['items[null]', people, null],
  ['if(true, 1, 1 / 0)', {}, 1],
  ['if(null, 1 / 0, 2)', {}, 2],
  ['coalesce(null, 3, 1 / 0)', {}, 3],
  ['len(o)', people, 6],
  ['len(null)', {}, null],
  ['"n=" & (0.1 + 0.2)', {}, 'n=0.30000000000000004'],
  ['"" & 1000000 * 1000000 * 1000000 * 1000 & null & false', {}, '1e+21false'],
  ['[1, 2][0 + 1]', {}, 2],
  ['[]', {}, []],
  ['x.y', {x: null}, null],
  ['a ?? b ?? 3', {}, 3],
  ['not not true', {}, true],
  ['- - 3', {}, 3],
  ['constructor', {}, null],
];

// [source, message, line, column]: compile() must throw.
const COMPILE_ERRORS = [
  ['1 + \u{1F600}', 'unexpected character "\u{1F600}"', 1, 5],
  ['"\u{1F600}" + ?', 'unexpected character "?"', 1, 7],
  ['1 +\r2 +\r\n3 + )', 'unexpected token ")"', 3, 5],
  ['"\u{1F600}\u{1F600}"\t)', 'unexpected token ")"', 1, 6],
  ['1 +  # tail', 'unexpected end of input', 1, 12],
  ['(1 + 2\n', 'unexpected end of input', 2, 1],
  ['', 'unexpected end of input', 1, 1],
  ['  \r', 'unexpected end of input', 2, 1],
  ['a < b < c', 'comparison operators cannot be chained', 1, 7],
  ['a = b IN c', 'comparison operators cannot be chained', 1, 7],
  ['1 2', 'unexpected token "2"', 1, 3],
  ['coalesce(1,)', 'unexpected token ")"', 1, 12],
  ['len("a" "b")', 'unexpected token ""b""', 1, 9],
  ['x "\\u{41}"', 'unexpected token ""\\u{41}""', 1, 3],
  ['1 + AND', 'unexpected token "AND"', 1, 5],
  ['`len`(1)', 'unexpected token "("', 1, 6],
  ['a.1', 'unexpected token "1"', 1, 3],
  ['1.', 'invalid number "1."', 1, 1],
  ['x + 1__0', 'invalid number "1__0"', 1, 5],
  ['12ab', 'invalid number "12ab"', 1, 1],
  ['1_', 'invalid number "1_"', 1, 1],
  ['3.1.4', 'invalid number "3.1.4"', 1, 1],
  ['"abc', 'unterminated string', 1, 1],
  ['x = "ab\ncd"', 'unterminated string', 1, 5],
  ['"\\q"', 'invalid escape', 1, 2],
  ['"ok" & "\\u{110000}"', 'invalid escape', 1, 9],
  ['"\\u{D800}"', 'invalid escape', 1, 2],
  ['"\\u{}"', 'invalid escape', 1, 2],
  ['"\\u{1234567}"', 'invalid escape', 1, 2],
  ['"a\\u41"', 'invalid escape', 1, 3],
  ['"\\q', 'invalid escape', 1, 2],
  ['``', 'empty name', 1, 1],
  ['1 + `abc', 'unterminated name', 1, 5],
  ['!x', 'unexpected character "!"', 1, 1],
  ['a ? b', 'unexpected character "?"', 1, 3],
  [') + "abc', 'unterminated string', 1, 5],
  ['1 + + 2 ~', 'unexpected character "~"', 1, 9],
  ['nope(1) +', 'unexpected end of input', 1, 10],
  ['len(1, 2) + nope()', 'wrong number of arguments for "len"', 1, 1],
  ['nope(len())', 'unknown function "nope"', 1, 1],
  ['x + len() + nope(1)', 'wrong number of arguments for "len"', 1, 5],
  ['coalesce()', 'wrong number of arguments for "coalesce"', 1, 1],
  ['constructor(1)', 'unknown function "constructor"', 1, 1],
  ['LEN(x)', 'unknown function "LEN"', 1, 1],
  ['x\n  + if(1, 2)', 'wrong number of arguments for "if"', 2, 5],
];

// [source, record, message, line, column]: compile() succeeds, the compiled function throws.
const RUNTIME_ERRORS = [
  ['"a" < 1', {}, 'cannot apply "<" to string and number', 1, 5],
  ['true < false', {}, 'cannot apply "<" to boolean and boolean', 1, 6],
  ['1 / 0', {}, 'division by zero', 1, 3],
  ['5 % 0', {}, 'division by zero', 1, 3],
  ['10 ^ 400', {}, 'number out of range', 1, 4],
  ['(0 - 8) ^ 0.5', {}, 'number out of range', 1, 9],
  ['0 ^ -1', {}, 'number out of range', 1, 3],
  ['big * 10', {big: 1e308}, 'number out of range', 1, 5],
  ['"n=" & 0.1 + 0.2', {}, 'cannot apply "+" to string and number', 1, 12],
  ['1 and true', {}, 'cannot apply "and" to number', 1, 3],
  ['false OR 5', {}, 'cannot apply "or" to number', 1, 7],
  ['null AND "x"', {}, 'cannot apply "and" to string', 1, 6],
  ['NOT 3', {}, 'cannot apply "not" to number', 1, 1],
  ['null and 1 / 0 = 1', {}, 'division by zero', 1, 12],
  ['coalesce(null, 1 / 0)', {}, 'division by zero', 1, 18],
  ['if(5, 1, 2)', {}, 'bad argument for "if"', 1, 1],
  ['-"a"', {}, 'cannot apply "-" to string', 1, 1],
  ['name.first', {name: 'Ada'}, 'cannot read field "first" of string', 1, 5],
  ['items.price', {items: [{price: 1}, 7]}, 'cannot read field "price" of number', 1, 6],
  ['tags[1.5]', {tags: [1, 2]}, 'index must be an integer', 1, 5],
  ['tags["a"]', {tags: [1, 2]}, 'cannot index array with string', 1, 5],
  ['o[1]', {o: {}}, 'cannot index object with number', 1, 2],
  ['5[0]', {}, 'cannot index number with number', 1, 2],
  ['[1] & "x"', {}, 'cannot apply "&" to array and string', 1, 5],
  ['3 in 5', {}, 'cannot apply "in" to number and number', 1, 3],
  ['1 IN "a"', {}, 'cannot apply "in" to number and string', 1, 3],
  ['len(5)', {}, 'bad argument for "len"', 1, 1],
  ['1 + sum([1, "2"])', {}, 'bad argument for "sum"', 1, 5],
  ['sum(xs)', {xs: [1e308, 1e308]}, 'number out of range', 1, 1],
  ['join([[1]], ",")', {}, 'bad argument for "join"', 1, 1],
  ['join([1], 2)', {}, 'bad argument for "join"', 1, 1],
  ['keys([1])', {}, 'bad argument for "keys"', 1, 1],
  ['round("1")', {}, 'bad argument for "round"', 1, 1],
  ['x.y + 1 / 0', {x: 5}, 'cannot read field "y" of number', 1, 2],
];

const HIDDEN = `import test from 'node:test';
import assert from 'node:assert/strict';
const {compile, evaluate, SiftError} = await import('@ROOT@src/index.js');
const isError = (message, line, column) => error => {
  assert.ok(error instanceof SiftError, 'not a SiftError: ' + error);
  assert.deepStrictEqual({name: error.name, message: error.message, line: error.line, column: error.column}, {name: 'SiftError', message: message + ' at ' + line + ':' + column, line, column});
  return true;
};
for (const [source, record, expected] of ${JSON.stringify(VALUES)}) {
  test('value: ' + JSON.stringify(source), () => assert.deepStrictEqual(evaluate(source, record), expected));
}
for (const [source, message, line, column] of ${JSON.stringify(COMPILE_ERRORS)}) {
  test('compile error: ' + JSON.stringify(source), () => assert.throws(() => compile(source), isError(message, line, column)));
}
for (const [source, record, message, line, column] of ${JSON.stringify(RUNTIME_ERRORS)}) {
  test('runtime error: ' + JSON.stringify(source), () => {
    const run = compile(source);
    assert.throws(() => run(record), isError(message, line, column));
  });
}
`;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];
const solveWith = changes => root => writeTree(root, {...REFERENCE, ...changes});
const tweak = (file, pairs) => root => writeTree(root, {[file]: patch(REFERENCE[file], pairs)});

export default {
  id: 'sift-query',
  category: 'invented expression language',
  prompt: 'The Sift expression library in src/ (`compile`, `evaluate` and `SiftError`, exported from src/index.js) is an early version: it is incomplete and also deviates from its specification, docs/SIFT.md, in places. Make the library implement docs/SIFT.md completely and exactly: every section, including positions, error messages and evaluation order. Use only Node built-ins and add no dependencies. Do not modify, delete or rename any existing file under test/ (you may add new test files); `npm test` must pass.',
  setup: root => gitRepo(root, [['Sift expression language: early implementation and specification', files]]),
  solve: solveWith({}),
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
    // Columns counted in UTF-16 code units.
    tweak('src/lexer.js', [['const chars = [...source];', "const chars = source.split('');"]]),
    // JavaScript remainder instead of floored modulo.
    tweak('src/evaluate.js', [["'%': (a, b) => { const r = a % b; return r !== 0 && (r < 0) !== (b < 0) ? r + b : r; },", "'%': (a, b) => a % b,"]]),
    // keys() sorted by UTF-16 code units.
    tweak('src/functions.js', [['Object.keys(value).sort(compareText)', 'Object.keys(value).sort()']]),
    // null and x short-circuits.
    tweak('src/evaluate.js', [['if (left === false) return false;', 'if (left !== true) return left;']]),
    // Negative zero leaks out.
    tweak('src/values.js', [['return n === 0 ? 0 : n;', 'return n;']]),
    // Unknown functions reported while parsing, before later syntax errors.
    tweak('src/parser.js', [["if (isOp(peek(), '(')) { next(); return", "if (isOp(peek(), '(')) { if (!['len', 'lower', 'upper', 'round', 'sum', 'join', 'keys', 'if', 'coalesce'].includes(token.value)) fail('unknown function \"' + token.value + '\"', token); next(); return"]]),
    // A visible test edited.
    root => writeTree(root, {'test/sift.test.js': VISIBLE.replace("test('compiled expressions are reusable'", "test.skip('compiled expressions are reusable'")}),
  ],
};
