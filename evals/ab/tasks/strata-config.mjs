import {gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

// Fixture sources are String.raw (no backticks or dollar-brace inside). md() turns \` into a backtick, \$ into $ and \{ into {.
const md = text => text.replaceAll('\\`', '`').replaceAll('\\$', '$').replaceAll('\\{', '{');

/** Replace each anchor, which must occur exactly once, so a drifting anchor fails loudly at import time. */
function patch(text, pairs) {
  for (const [from, to] of pairs) {
    if (text.split(from).length !== 2) throw Error('strata-config: patch anchor not unique: ' + from);
    text = text.replace(from, () => to);
  }
  return text;
}

const SPEC = md(String.raw`# Strata configuration language

Strata reads layered configuration files into one JSON-like object. This document is the complete specification of the library in \`src/\`, exported from \`src/index.js\`:

- \`load(entry, files, options)\` loads a configuration and returns it (section 9), or throws a \`StrataError\` (section 10).
- \`files\` is a plain object that maps file names to source text. It is the only file system Strata sees; Strata never reads the disk. File names are \`/\`-separated paths without a leading \`/\` and without \`.\` or \`..\` segments, such as \`main.st\` or \`conf/db.st\`.
- \`entry\` is the name of the file to load; it is always a key of \`files\`.
- \`options\` may be omitted. \`options.overrides\` (default \`[]\`) is an array of override lines (section 8).

## 1. Lines

A source is split into lines at every LF; a CR immediately before an LF belongs to the line break, not to the line. Lines are numbered from 1. There are no multi-line constructs: every line is tokenized and parsed on its own.

## 2. Tokens

Within a line, spaces and tabs separate tokens and are otherwise ignored. A \`#\` outside a string starts a comment that runs to the end of the line. A line without tokens (blank, or only a comment) does nothing.

The line is tokenized from left to right and the first problem found is reported. A line is tokenized completely before it is parsed, so a lexical error wins over any syntax error on the same line.

- **Operators**: \`+=\`, \`-=\`, \`?=\` (two characters, no space between them; these are matched before anything else), then \`=\`, \`[\`, \`]\`, \`,\`, \`.\`, \`*\`.
- **Word**: a maximal run of the characters \`A-Z\`, \`a-z\`, \`0-9\`, \`_\` and \`-\`, except that a word never includes a \`-\` that is immediately followed by \`=\`. So \`a-=1\` is the word \`a\`, the operator \`-=\` and the word \`1\`, while \`a-b\` and \`-5\` are single words.
- **Directive**: \`@\` followed by a word, which may be empty. The word is the directive's name.
- **Raw string**: \`'\` up to the next \`'\` on the line. Its content is taken literally: no escapes, no references. Without a closing \`'\` the error is \`unterminated string\`.
- **String**: \`"\` up to the closing \`"\`. Inside it, from left to right:
  - A backslash starts an escape: \`\\\`, \`\"\`, \`\n\` (LF), \`\t\` (tab) and \`\\$\` (a literal \`$\`). A backslash followed by any other character C is the error \`invalid escape "\C"\`.
  - \`\${\` starts a reference, which ends at the next \`}\` on the line; the search for that \`}\` ignores quotes and backslashes. If there is no \`}\` after it, the error is \`unterminated reference\`. The text between the braces must be zero or more \`.\` followed by one or more bare keys (section 3) separated by \`.\`, and nothing else, not even spaces; otherwise the error is \`invalid reference "TEXT"\`, TEXT being the text between the braces. The string continues after the \`}\`.
  - A \`$\` that is not followed by \`{\` is an ordinary character.
  - If the line ends before the closing \`"\` (also right after a backslash), the error is \`unterminated string\`.
- Any other character is the error \`syntax error\`.

Strings and raw strings are both *strings*; they differ only in how their content is written.

## 3. Statements

A line with tokens must be exactly one of the statements below; anything else is the error \`syntax error\`. Statements are parsed from left to right and the first problem is reported. Two problems have their own messages:

- A directive whose name is not \`include\`, \`unset\` or \`merge\` is the error \`unknown directive "@NAME"\`, whatever follows it.
- When the strategy of \`@merge\` is a word that is not one of the four strategy names (section 6), the error is \`unknown strategy "NAME"\`. If it is not a word at all, or is missing, that is a syntax error.

**Key paths.** A key path is one or more keys separated by \`.\`. A key is either a *bare key*, a word that starts with a letter or \`_\`, or a string of either kind whose content is the key. A string used as a key must not contain references (syntax error); its escapes work as usual, so \`"\\$\{x}"\` is the key \`\${x}\`. Keys are case-sensitive, and the empty string is a valid key.

**Values.** A scalar is a string, the word \`true\`, the word \`false\`, or an integer. An integer is a word that matches \`-?(0|[1-9](_?[0-9])*)\`: an optional minus sign, then \`0\` or a decimal number without leading zeros whose digits may be separated by single underscores (\`1_000_000\`). Its value must be between -(2^53 - 1) and 2^53 - 1 inclusive, otherwise the error is \`integer out of range\` (reported when the parser reaches that word, so in \`a = [99999999999999999999, x]\` it wins over the syntax error at \`x\`). \`-0\` is 0. Any other word is not a value: \`yes\`, \`007\`, \`1__0\`, \`1_\` are syntax errors. A value is a scalar or a list: \`[\`, then zero or more scalars separated by \`,\`, with an optional \`,\` after the last one, then \`]\`. Lists cannot contain lists.

The statements:

1. Section header: \`[\` key path \`]\`.
2. Assignment: key path, one of the operators \`=\`, \`?=\`, \`+=\`, \`-=\`, value.
3. \`@include\` followed by one string (either kind) without references: the path of a file.
4. \`@unset\` followed by a key path.
5. \`@merge\` followed by a pattern and a strategy. A pattern is written like a key path, except that any of its keys may be the operator \`*\`. The strategy is a word.

## 4. Evaluation

The entry file is evaluated statement by statement from top to bottom, evaluating other files where \`@include\` says so, and builds one tree of tables. A table maps keys to values; its keys keep the order in which they were added. The first error stops everything.

The *current section* is a key path, initially empty (the root table). A section header \`[p]\` sets it to \`p\`, always counted from the root and never relative to the previous section, and opens the table at \`p\` (4.1). Key paths in assignments, \`@unset\` and \`@merge\` are relative to the current section: in section \`server\`, \`tls.port = 1\` assigns \`server.tls.port\`.

### 4.1 Opening tables

To open the table at a path, walk the path from the root. A key that does not exist yet is created holding an empty table; an existing key whose value is not a table is the error \`key P is not a table\`, P being the path up to and including that key. So a section header on its own creates an empty table, and \`[a.b]\` fails if \`a\` holds an integer.

### 4.2 Assignment

For an assignment \`p OP v\` in section s, the full path is F = s followed by p. The last key of F is K, and the keys before it are the *parent path* of F.

1. The value v is evaluated first: the references in its strings are made absolute (4.4).
2. The table at the parent path is opened (4.1).
3. If K exists in that table and holds a table, \`?=\` does nothing and every other operator is the error \`cannot assign to table F\`.
4. Then, depending on the operator:
   - \`=\`: as F's merge strategy says (section 6).
   - \`?=\`: K is set to v if K does not exist; otherwise nothing happens.
   - \`+=\`: if K does not exist, it is set to v. If K holds a list, the elements of v (when v is a list) or v itself (when v is a scalar) are appended to it. If K and v are both integers, K becomes their sum, which must be in the integer range (\`integer out of range\`). Anything else is the error \`cannot apply "+=" to T1 and T2\`, T1 being the type of K's value and T2 the type of v.
   - \`-=\`: K must hold a list. It becomes that list without every element that is equal (6.1) to v, when v is a scalar, or to any element of v, when v is a list. If K does not exist, the error is \`cannot apply "-=" to undefined and T2\`; if it holds something else, \`cannot apply "-=" to T1 and T2\`.

The types are named \`string\`, \`integer\`, \`boolean\`, \`list\` and \`table\`. Setting a key that already exists keeps its position in its table; a new key is added last.

### 4.3 Unset

\`@unset p\` in section s removes the key at the path s followed by p from its table, whatever it holds (tables included). If that key does not exist, or a key on the way does not exist or does not hold a table, nothing happens. A removed key that is set again is added last, like any new key.

### 4.4 References

A reference without leading dots is absolute: \`\${db.host}\` refers to the key path \`db.host\`. A reference with leading dots is relative to the parent path of the key being assigned (4.2), which includes the key path's own prefix and not just the current section: one \`.\` means the parent path itself, and every further \`.\` goes one level up. So in section \`a\`, the assignment \`b.c = "\${.d}"\` refers to \`a.b.d\`, and \`b.c = "\${..d}"\` to \`a.d\`. A reference that would go above the root is the error \`reference TEXT escapes the root\`, TEXT being the text between the braces.

This happens when the value is evaluated, even when the assignment then changes nothing (\`?=\` on an existing key, the \`keep\` strategy). References are only made absolute here; their values are read much later (section 7).

## 5. Includes

\`@include "path"\` resolves the path against the directory of the file that contains the directive (\`conf\` for \`conf/db.st\`, the root for \`main.st\`), or against the root if the path starts with \`/\`. The path is split at \`/\`; empty segments and \`.\` are skipped, \`..\` removes the last segment so far, and any other segment is appended. The resulting segments joined with \`/\` are the name of the included file. Then, in this order:

1. If a \`..\` would remove a segment when there is none left, the error is \`include path "RAW" escapes the root\`, RAW being the path as written.
2. If the name is not a key of \`files\`, the error is \`cannot include "NAME"\`.
3. If that file is already being evaluated (it is the entry, or a file whose \`@include\` led to this one), the error is \`include cycle: A -> B -> A\`: the names of the files being evaluated, starting with the earlier occurrence of NAME and in the order they were included, followed by NAME again.

Otherwise the included file is evaluated at that point, starting at the root section; its section headers do not affect the including file, which continues in its own current section afterwards. Including the same file several times, not recursively, is allowed and evaluates it each time.

## 6. Merge strategies

\`@merge pattern strategy\` in section s declares the strategy of every \`=\` assignment evaluated after it whose full path matches s followed by the pattern. A pattern matches a path of the same length whose keys are equal to the pattern's keys, where \`*\` matches any single key (the string \`"*"\` is the ordinary key \`*\`). When several declarations match, the one evaluated last wins; when none matches, the strategy is \`replace\`. Declarations are never undone and apply across files.

For \`=\` with value v on full path F:

- \`replace\`: K is set to v.
- \`keep\`: K is set to v if K does not exist; otherwise nothing happens.
- \`append\`: if K holds a list and v is a list, K becomes its elements followed by the elements of v. Otherwise like \`replace\`.
- \`union\`: if K holds a list and v is a list, K becomes its elements followed by each element of v that is not equal to an element already in the result (including the elements of v added before it). Otherwise like \`replace\`; in particular, duplicates inside v are kept when K does not hold a list.

Strategies only affect \`=\`. \`?=\`, \`+=\` and \`-=\` always behave as described in 4.2, and \`=\` in an override always replaces (section 8).

### 6.1 Equality

Elements are compared as written, before interpolation. Integers and booleans are equal when they have the same type and value. Two strings are equal when they consist of the same sequence of literal text and references, references being compared by their absolute path (4.4). So \`'a'\` equals \`"a"\`, and \`"\${.x}"\` assigned to a key of table \`t\` equals \`"\${t.x}"\`, but \`"\\$\{x}"\` (the literal text \`\${x}\`) does not equal \`"\${x}"\`. Values of different types are never equal.

## 7. Interpolation

After the entry file and the overrides have been evaluated, the strings of the final tree are interpolated: every reference is replaced by the text of the value at its path in the final tree.

- If the path does not exist (also when a key on the way does not hold a table), the error is \`undefined reference P\`.
- If it holds a table or a list, the error is \`cannot interpolate table P\` or \`cannot interpolate list P\`.
- An integer is written in decimal (\`-12\`) and a boolean as \`true\` or \`false\`.
- A string is replaced by its own interpolated text.

Strings are interpolated in the document order of the final tree: tables depth-first, keys in table order, list elements in order. Within a string, references are handled from left to right, and each is resolved completely, recursively, before the next. The string held by a key is interpolated only once; later references to it reuse the result. An error is reported at the file and line where the string containing the failing reference was written.

If interpolating the string held by key P requires the string held by P itself, directly or through other keys, the error is \`interpolation cycle: P -> Q -> P\`: the keys in the order they were reached, starting with P (the first key reached a second time) and ending with P again. It is reported at the string whose reference reached P the second time. The checks for one reference are made in the order of the list above, so a reference to a list is reported as \`cannot interpolate list\` even if the list is being interpolated.

## 8. Overrides

The elements of \`options.overrides\` are lines that are evaluated after the entry file (and everything it includes), in array order, as if they were the lines of a file named \`<override>\`: the first override is line 1, the second line 2, and so on. Each override is tokenized and parsed like any line, in the root section, and must be an assignment; a line that parses as anything else, including an empty line or a comment, is the error \`syntax error\`. In an override, \`=\` always replaces, whatever \`@merge\` declared.

## 9. Result

The result is a plain object for the root table: tables are plain objects with their keys in table order, lists are arrays, integers are numbers, booleans are booleans and strings are their interpolated text.

## 10. Errors

\`StrataError\` extends \`Error\`. Its \`name\` is \`"StrataError"\`, its \`file\` and \`line\` properties are the file name (or \`<override>\`) and the line number where the error was found, and its \`message\` is \`TEXT (FILE:LINE)\`, for example \`unterminated string (conf/db.st:3)\`.

A path in a message is written as its keys joined with \`.\`. A key that is not a bare key is written as a string: in double quotes, with every backslash and \`"\` inside preceded by a backslash. For example: \`servers."eu west".port\`.

| TEXT | Section |
|---|---|
| \`syntax error\`, \`unterminated string\`, \`invalid escape "\C"\`, \`unterminated reference\`, \`invalid reference "TEXT"\` | 2 |
| \`unknown directive "@NAME"\`, \`unknown strategy "NAME"\`, \`integer out of range\` | 3 |
| \`key P is not a table\`, \`cannot assign to table P\`, \`cannot apply "OP" to T1 and T2\`, \`integer out of range\`, \`reference TEXT escapes the root\` | 4 |
| \`include path "RAW" escapes the root\`, \`cannot include "NAME"\`, \`include cycle: A -> B -> A\` | 5 |
| \`undefined reference P\`, \`cannot interpolate table P\`, \`cannot interpolate list P\`, \`interpolation cycle: P -> Q -> P\` | 7 |
`);

const ERRORS_JS = String.raw`/** Every problem Strata reports is a StrataError; see docs/STRATA.md section 10. */
export class StrataError extends Error {
  constructor(text, file, line) {
    super(text + ' (' + file + ':' + line + ')');
    this.name = 'StrataError';
    this.file = file;
    this.line = line;
  }
}

export function fail(text, at) {
  throw new StrataError(text, at.file, at.line);
}
`;

const PATHS_JS = String.raw`const BARE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** A key path as error messages write it (docs/STRATA.md section 10). */
export const show = keys => keys.map(key => BARE.test(key) ? key : '"' + key.replace(/[\\"]/g, '\\$&') + '"').join('.');
`;

const LEXER_JS = String.raw`import {fail} from './errors.js';

const WORD = /^[A-Za-z0-9_-]$/;
const REFERENCE = /^\.*[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/;
const ESCAPES = {'\\': '\\', '"': '"', n: '\n', t: '\t', $: '$'};
const OPERATORS = ['+=', '-=', '?=', '=', '[', ']', ',', '.', '*'];

/**
 * Tokens of one line (docs/STRATA.md section 2): {type: 'op' | 'word' | 'directive', value}
 * or {type: 'string', parts}, where parts are literal texts and {ref} references.
 */
export function tokenize(text, at) {
  const tokens = [];
  let i = 0;
  const isWordChar = j => j < text.length && WORD.test(text[j]) && !(text[j] === '-' && text[j + 1] === '=');
  const word = () => {
    const start = i;
    while (isWordChar(i)) i++;
    return text.slice(start, i);
  };
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '#') break;
    const op = OPERATORS.find(o => text.startsWith(o, i));
    if (op) { tokens.push({type: 'op', value: op}); i += op.length; continue; }
    if (c === '@') { i++; tokens.push({type: 'directive', value: word()}); continue; }
    if (isWordChar(i)) { tokens.push({type: 'word', value: word()}); continue; }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) fail('unterminated string', at);
      const content = text.slice(i + 1, end);
      tokens.push({type: 'string', parts: content ? [content] : []});
      i = end + 1;
      continue;
    }
    if (c !== '"') fail('syntax error', at);
    i++;
    const parts = [];
    let literal = '';
    for (;;) {
      if (i >= text.length) fail('unterminated string', at);
      const d = text[i];
      if (d === '"') break;
      if (d === '\\') {
        if (i + 1 >= text.length) fail('unterminated string', at);
        const e = String.fromCodePoint(text.codePointAt(i + 1));
        if (!Object.hasOwn(ESCAPES, e)) fail('invalid escape "\\' + e + '"', at);
        literal += ESCAPES[e];
        i += 2;
      } else if (d === '$' && text[i + 1] === '{') {
        const end = text.indexOf('}', i + 2);
        if (end < 0) fail('unterminated reference', at);
        const ref = text.slice(i + 2, end);
        if (!REFERENCE.test(ref)) fail('invalid reference "' + ref + '"', at);
        if (literal) parts.push(literal);
        literal = '';
        parts.push({ref});
        i = end + 1;
      } else {
        literal += d;
        i++;
      }
    }
    if (literal) parts.push(literal);
    tokens.push({type: 'string', parts});
    i++;
  }
  return tokens;
}
`;

const PARSER_JS = String.raw`import {fail} from './errors.js';

/** The * key of a @merge pattern. */
export const STAR = Symbol('*');

const BARE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const INTEGER = /^-?(0|[1-9](_?[0-9])*)$/;
const LIMIT = 2n ** 53n - 1n;
const STRATEGIES = ['replace', 'keep', 'append', 'union'];
const ASSIGN = ['=', '?=', '+=', '-='];

/** One statement of docs/STRATA.md section 3, or null for a line without tokens. */
export function parse(tokens, at) {
  if (tokens.length === 0) return null;
  let k = 0;
  const syntax = () => fail('syntax error', at);
  const isOp = (value, token = tokens[k]) => token?.type === 'op' && token.value === value;
  const done = () => { if (k < tokens.length) syntax(); };
  const plain = token => token?.type === 'string' && token.parts.every(part => typeof part === 'string');
  const key = star => {
    const token = tokens[k++];
    if (token?.type === 'word' && BARE.test(token.value)) return token.value;
    if (plain(token)) return token.parts.join('');
    if (star && isOp('*', token)) return STAR;
    return syntax();
  };
  const path = (star = false) => {
    const keys = [key(star)];
    while (isOp('.')) { k++; keys.push(key(star)); }
    return keys;
  };
  const scalar = () => {
    const token = tokens[k++];
    if (token?.type === 'string') return {parts: token.parts, at};
    if (token?.type === 'word') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (INTEGER.test(token.value)) {
        const n = BigInt(token.value.replaceAll('_', ''));
        if (n > LIMIT || n < -LIMIT) fail('integer out of range', at);
        return Number(n);
      }
    }
    return syntax();
  };
  const value = () => {
    if (!isOp('[')) return scalar();
    k++;
    const list = [];
    while (!isOp(']')) {
      list.push(scalar());
      if (isOp(',')) k++;
      else if (!isOp(']')) syntax();
    }
    k++;
    return list;
  };

  const first = tokens[0];
  if (isOp('[')) {
    k++;
    const keys = path();
    if (!isOp(']')) syntax();
    k++;
    done();
    return {type: 'section', path: keys};
  }
  if (first.type === 'directive') {
    k++;
    if (first.value === 'include') {
      const token = tokens[k++];
      if (!plain(token)) syntax();
      done();
      return {type: 'include', path: token.parts.join('')};
    }
    if (first.value === 'unset') {
      const keys = path();
      done();
      return {type: 'unset', path: keys};
    }
    if (first.value === 'merge') {
      const pattern = path(true);
      const token = tokens[k++];
      if (token?.type !== 'word') syntax();
      if (!STRATEGIES.includes(token.value)) fail('unknown strategy "' + token.value + '"', at);
      done();
      return {type: 'merge', pattern, strategy: token.value};
    }
    fail('unknown directive "@' + first.value + '"', at);
  }
  const keys = path();
  const op = tokens[k++];
  if (op?.type !== 'op' || !ASSIGN.includes(op.value)) syntax();
  const v = value();
  done();
  return {type: 'assign', path: keys, op: op.value, value: v};
}
`;

const EVALUATE_JS = String.raw`import {fail} from './errors.js';
import {tokenize} from './lexer.js';
import {parse, STAR} from './parser.js';
import {show} from './paths.js';

export const typeOf = value => value instanceof Map ? 'table' : Array.isArray(value) ? 'list'
  : typeof value === 'number' ? 'integer' : typeof value === 'boolean' ? 'boolean' : 'string';

/** Equality of docs/STRATA.md 6.1, before interpolation. Strings are {parts, at}. */
export function same(a, b) {
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;
  return a.parts.length === b.parts.length && a.parts.every((part, i) => {
    const other = b.parts[i];
    if (typeof part === 'string' || typeof other === 'string') return part === other;
    return part.path.length === other.path.length && part.path.every((key, j) => key === other.path[j]);
  });
}

/** Evaluate the entry file, its includes and the overrides into a tree of Maps (docs/STRATA.md sections 4 to 8). */
export function evaluate(entry, files, overrides) {
  const root = new Map();
  const merges = [];
  const including = [];

  const open = (keys, at) => {
    let table = root;
    keys.forEach((key, i) => {
      if (!table.has(key)) table.set(key, new Map());
      table = table.get(key);
      if (!(table instanceof Map)) fail('key ' + show(keys.slice(0, i + 1)) + ' is not a table', at);
    });
    return table;
  };

  const absolute = (value, parent, at) => {
    if (Array.isArray(value)) return value.map(item => absolute(item, parent, at));
    if (typeof value !== 'object') return value;
    return {at: value.at, parts: value.parts.map(part => {
      if (typeof part === 'string') return part;
      const dots = part.ref.match(/^\.*/)[0].length;
      const keys = part.ref.slice(dots).split('.');
      if (dots === 0) return {ref: part.ref, path: keys};
      if (dots - 1 > parent.length) fail('reference ' + part.ref + ' escapes the root', at);
      return {ref: part.ref, path: [...parent.slice(0, parent.length - (dots - 1)), ...keys]};
    })};
  };

  const strategy = path => {
    for (let i = merges.length - 1; i >= 0; i--) {
      const {pattern, how} = merges[i];
      if (pattern.length === path.length && pattern.every((key, j) => key === STAR || key === path[j])) return how;
    }
    return 'replace';
  };

  const assign = (section, {path, op, value}, at, merging) => {
    const full = [...section, ...path];
    const parent = full.slice(0, -1);
    const key = full.at(-1);
    const v = absolute(value, parent, at);
    const table = open(parent, at);
    const has = table.has(key);
    const old = table.get(key);
    const set = result => { table.set(key, result); };
    if (old instanceof Map) {
      if (op === '?=') return;
      fail('cannot assign to table ' + show(full), at);
    }
    if (op === '?=') {
      if (!has) set(v);
    } else if (op === '=') {
      const how = merging ? strategy(full) : 'replace';
      if (how === 'keep') {
        if (!has) set(v);
      } else if ((how === 'append' || how === 'union') && Array.isArray(old) && Array.isArray(v)) {
        const result = [...old];
        for (const item of v) if (how === 'append' || !result.some(other => same(other, item))) result.push(item);
        set(result);
      } else set(v);
    } else if (op === '+=') {
      if (!has) set(v);
      else if (Array.isArray(old)) set(old.concat(v));
      else if (typeof old === 'number' && typeof v === 'number') {
        if (!Number.isSafeInteger(old + v)) fail('integer out of range', at);
        set(old + v);
      } else fail('cannot apply "+=" to ' + typeOf(old) + ' and ' + typeOf(v), at);
    } else {
      if (!has) fail('cannot apply "-=" to undefined and ' + typeOf(v), at);
      if (!Array.isArray(old)) fail('cannot apply "-=" to ' + typeOf(old) + ' and ' + typeOf(v), at);
      const remove = Array.isArray(v) ? v : [v];
      set(old.filter(item => !remove.some(other => same(item, other))));
    }
  };

  const unset = keys => {
    let table = root;
    for (const key of keys.slice(0, -1)) {
      table = table.get(key);
      if (!(table instanceof Map)) return;
    }
    table.delete(keys.at(-1));
  };

  const resolve = (from, raw, at) => {
    const keys = raw.startsWith('/') ? [] : from.split('/').slice(0, -1);
    for (const segment of raw.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment !== '..') keys.push(segment);
      else if (keys.pop() === undefined) fail('include path "' + raw + '" escapes the root', at);
    }
    return keys.join('/');
  };

  const run = name => {
    including.push(name);
    let section = [];
    files[name].split(/\r?\n/).forEach((line, index) => {
      const at = {file: name, line: index + 1};
      const statement = parse(tokenize(line, at), at);
      if (!statement) return;
      if (statement.type === 'section') {
        section = statement.path;
        open(section, at);
      } else if (statement.type === 'assign') assign(section, statement, at, true);
      else if (statement.type === 'unset') unset([...section, ...statement.path]);
      else if (statement.type === 'merge') merges.push({pattern: [...section, ...statement.pattern], how: statement.strategy});
      else {
        const target = resolve(name, statement.path, at);
        if (!Object.hasOwn(files, target)) fail('cannot include "' + target + '"', at);
        const earlier = including.indexOf(target);
        if (earlier >= 0) fail('include cycle: ' + [...including.slice(earlier), target].join(' -> '), at);
        run(target);
      }
    });
    including.pop();
  };

  run(entry);
  overrides.forEach((text, index) => {
    const at = {file: '<override>', line: index + 1};
    const statement = parse(tokenize(text, at), at);
    if (statement?.type !== 'assign') fail('syntax error', at);
    assign([], statement, at, false);
  });
  return root;
}
`;

const INTERPOLATE_JS = String.raw`import {fail} from './errors.js';
import {show} from './paths.js';

/** Interpolate the strings of the evaluated tree and return plain data (docs/STRATA.md sections 7 and 9). */
export function interpolate(root) {
  const done = new Map();
  const active = [];
  const lookup = keys => {
    let value = root;
    for (const key of keys) {
      if (!(value instanceof Map) || !value.has(key)) return undefined;
      value = value.get(key);
    }
    return value;
  };
  const text = string => string.parts.map(part => typeof part === 'string' ? part : reference(part.path, string.at)).join('');
  const reference = (keys, at) => {
    const value = lookup(keys);
    if (value === undefined) fail('undefined reference ' + show(keys), at);
    if (value instanceof Map) fail('cannot interpolate table ' + show(keys), at);
    if (Array.isArray(value)) fail('cannot interpolate list ' + show(keys), at);
    if (typeof value !== 'object') return String(value);
    return keyText(keys, value, at);
  };
  const keyText = (keys, string, at) => {
    const id = JSON.stringify(keys);
    const index = active.findIndex(entry => entry.id === id);
    if (index >= 0) fail('interpolation cycle: ' + [...active.slice(index), {keys}].map(entry => show(entry.keys)).join(' -> '), at);
    if (!done.has(id)) {
      active.push({id, keys});
      done.set(id, text(string));
      active.pop();
    }
    return done.get(id);
  };
  const plain = (value, keys) => {
    if (value instanceof Map) {
      const object = {};
      for (const [key, child] of value) {
        Object.defineProperty(object, key, {value: plain(child, [...keys, key]), enumerable: true, writable: true, configurable: true});
      }
      return object;
    }
    if (Array.isArray(value)) return value.map(item => typeof item === 'object' ? text(item) : item);
    if (typeof value === 'object') return keyText(keys, value, value.at);
    return value;
  };
  return plain(root, []);
}
`;

const INDEX_JS = String.raw`import {evaluate} from './evaluate.js';
import {interpolate} from './interpolate.js';

export {StrataError} from './errors.js';

/** Load a Strata configuration (docs/STRATA.md). */
export function load(entry, files, options = {}) {
  return interpolate(evaluate(entry, files, options.overrides ?? []));
}
`;

// ---- The fixture: an early version that is incomplete and deviates from the spec in places. ----

const FIXTURE_LEXER = patch(LEXER_JS, [
  ['const REFERENCE = /^\\.*[A-Za-z_]', 'const REFERENCE = /^[A-Za-z_]'],
  ["n: '\\n', t: '\\t', $: '$'};", "n: '\\n', t: '\\t'};"],
  ["const OPERATORS = ['+=', '-=', '?=',", "const OPERATORS = ['+=', '?=',"],
  [" && WORD.test(text[j]) && !(text[j] === '-' && text[j + 1] === '=');", ' && WORD.test(text[j]);'],
]);

const FIXTURE_PARSER = patch(PARSER_JS, [
  ["/** The * key of a @merge pattern. */\nexport const STAR = Symbol('*');\n\n", ''],
  ["const INTEGER = /^-?(0|[1-9](_?[0-9])*)$/;\nconst LIMIT = 2n ** 53n - 1n;\nconst STRATEGIES = ['replace', 'keep', 'append', 'union'];\nconst ASSIGN = ['=', '?=', '+=', '-='];",
    "const INTEGER = /^-?(0|[1-9][0-9]*)$/;\nconst ASSIGN = ['=', '?=', '+='];"],
  [`  const key = star => {
    const token = tokens[k++];
    if (token?.type === 'word' && BARE.test(token.value)) return token.value;
    if (plain(token)) return token.parts.join('');
    if (star && isOp('*', token)) return STAR;
    return syntax();
  };
  const path = (star = false) => {
    const keys = [key(star)];
    while (isOp('.')) { k++; keys.push(key(star)); }`, `  const key = () => {
    const token = tokens[k++];
    if (token?.type === 'word' && BARE.test(token.value)) return token.value;
    if (plain(token)) return token.parts.join('');
    return syntax();
  };
  const path = () => {
    const keys = [key()];
    while (isOp('.')) { k++; keys.push(key()); }`],
  [`        const n = BigInt(token.value.replaceAll('_', ''));
        if (n > LIMIT || n < -LIMIT) fail('integer out of range', at);
        return Number(n);`, `        const n = Number(token.value);
        if (!Number.isSafeInteger(n)) fail('integer out of range', at);
        return n;`],
  [`    if (first.value === 'merge') {
      const pattern = path(true);
      const token = tokens[k++];
      if (token?.type !== 'word') syntax();
      if (!STRATEGIES.includes(token.value)) fail('unknown strategy "' + token.value + '"', at);
      done();
      return {type: 'merge', pattern, strategy: token.value};
    }
`, ''],
]);

const FIXTURE_EVALUATE = String.raw`import {fail} from './errors.js';
import {tokenize} from './lexer.js';
import {parse} from './parser.js';
import {show} from './paths.js';

export const typeOf = value => value instanceof Map ? 'table' : Array.isArray(value) ? 'list'
  : typeof value === 'number' ? 'integer' : typeof value === 'boolean' ? 'boolean' : 'string';

/** Evaluate the entry file and its includes into a tree of Maps (docs/STRATA.md section 4). */
export function evaluate(entry, files) {
  const root = new Map();

  const open = (keys, at) => {
    let table = root;
    keys.forEach((key, i) => {
      if (!table.has(key)) table.set(key, new Map());
      table = table.get(key);
      if (!(table instanceof Map)) fail('"' + show(keys.slice(0, i + 1)) + '" is not a table', at);
    });
    return table;
  };

  const assign = (section, {path, op, value}, at) => {
    const full = [...section, ...path];
    const table = open(full.slice(0, -1), at);
    const key = full.at(-1);
    const old = table.get(key);
    if (old instanceof Map) {
      if (op === '?=') return;
      fail('cannot assign to table ' + show(full), at);
    }
    if (op === '?=') {
      if (!table.has(key)) table.set(key, value);
    } else if (op === '=' || !table.has(key)) table.set(key, value);
    else if (Array.isArray(old)) table.set(key, old.concat(value));
    else if (typeof old === 'number' && typeof value === 'number') table.set(key, old + value);
    else fail('cannot apply "+=" to ' + typeOf(old) + ' and ' + typeOf(value), at);
  };

  const unset = keys => {
    let table = root;
    for (const key of keys.slice(0, -1)) {
      table = table.get(key);
      if (!(table instanceof Map)) return;
    }
    table.delete(keys.at(-1));
  };

  const run = name => {
    let section = [];
    files[name].split('\n').forEach((line, index) => {
      const at = {file: name, line: index + 1};
      const statement = parse(tokenize(line, at), at);
      if (!statement) return;
      if (statement.type === 'section') {
        section = statement.path;
        open(section, at);
      } else if (statement.type === 'assign') assign(section, statement, at);
      else if (statement.type === 'unset') unset([...section, ...statement.path]);
      else {
        const target = statement.path.replace(/^\//, '');
        if (!Object.hasOwn(files, target)) fail('cannot include "' + target + '"', at);
        run(target);
      }
    });
  };

  run(entry);
  return root;
}
`;

const FIXTURE_INTERPOLATE = String.raw`import {fail} from './errors.js';
import {typeOf} from './evaluate.js';

/** Interpolate the strings of the evaluated tree and return plain data (docs/STRATA.md sections 7 and 9). */
export function interpolate(root) {
  const lookup = keys => {
    let value = root;
    for (const key of keys) {
      if (!(value instanceof Map) || !value.has(key)) return undefined;
      value = value.get(key);
    }
    return value;
  };
  const text = string => string.parts.map(part => {
    if (typeof part === 'string') return part;
    const value = lookup(part.ref.split('.'));
    if (value === undefined) fail('undefined reference ' + part.ref, string.at);
    if (value instanceof Map || Array.isArray(value)) fail('cannot interpolate ' + typeOf(value) + ' ' + part.ref, string.at);
    return typeof value === 'object' ? text(value) : String(value);
  }).join('');
  const plain = value => {
    if (value instanceof Map) return Object.fromEntries([...value].map(([key, child]) => [key, plain(child)]));
    if (Array.isArray(value)) return value.map(plain);
    return value !== null && typeof value === 'object' ? text(value) : value;
  };
  return plain(root);
}
`;

const FIXTURE_INDEX = String.raw`import {evaluate} from './evaluate.js';
import {interpolate} from './interpolate.js';

export {StrataError} from './errors.js';

/** Load a Strata configuration (docs/STRATA.md). */
export function load(entry, files) {
  return interpolate(evaluate(entry, files));
}
`;

const VISIBLE = `import test from 'node:test';
import assert from 'node:assert/strict';
import {load, StrataError} from '../src/index.js';

test('sections, dotted keys and scalars', () => {
  const main = [
    '# billing service',
    'name = "billing"',
    "motto = 'raw \\\\n text'",
    '[server]',
    'port = 8080',
    'tls.enabled = true',
    '[server.limits]',
    'ids = [1, 2, 3,]',
    'empty = []',
  ].join('\\n');
  assert.deepEqual(load('main.st', {'main.st': main}), {
    name: 'billing',
    motto: 'raw \\\\n text',
    server: {port: 8080, tls: {enabled: true}, limits: {ids: [1, 2, 3], empty: []}},
  });
});

test('includes are evaluated where they appear', () => {
  const files = {
    'main.st': 'mode = "dev"\\n@include "defaults.st"\\n[app]\\nmode = "prod"',
    'defaults.st': '[app]\\nmode = "test"\\nworkers = 4',
  };
  assert.deepEqual(load('main.st', files), {mode: 'dev', app: {mode: 'prod', workers: 4}});
});

test('strings are interpolated with the final values', () => {
  const main = 'title = "\${name} v\${version} (\${beta})"\\nname = "api"\\nversion = 2\\nversion = 3\\nbeta = false';
  assert.deepEqual(load('main.st', {'main.st': main}), {title: 'api v3 (false)', name: 'api', version: 3, beta: false});
});

test('?=, += and @unset', () => {
  const main = [
    'retries ?= 3',
    'retries ?= 5',
    'hosts = ["a"]',
    'hosts += "b"',
    'hosts += ["c", "d"]',
    'count = 1',
    'count += 41',
    'tmp = 1',
    '@unset tmp',
  ].join('\\n');
  assert.deepEqual(load('main.st', {'main.st': main}), {retries: 3, hosts: ['a', 'b', 'c', 'd'], count: 42});
});

test('errors name the file and line', () => {
  const files = {'main.st': 'a = 1\\n@include "b.st"', 'b.st': '\\n\\nname = "oops'};
  assert.throws(() => load('main.st', files), error => error instanceof StrataError && error.name === 'StrataError'
    && error.message === 'unterminated string (b.st:3)' && error.file === 'b.st' && error.line === 3);
  assert.throws(() => load('main.st', {'main.st': 'n = 1\\nt.x = 1\\nt = 2'}), {message: 'cannot assign to table t (main.st:3)'});
  assert.throws(() => load('main.st', {'main.st': '@import "x.st"'}), {message: 'unknown directive "@import" (main.st:1)'});
});
`;

const files = {
  'package.json': JSON.stringify({name: 'strata', version: '0.4.0', private: true, type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'README.md': '# strata\n\nLayered configuration files: sections, includes, merge strategies and late-bound interpolation. The language is specified in docs/STRATA.md.\n\n```js\nimport {load} from \'./src/index.js\';\nload(\'main.st\', {\'main.st\': \'[db]\\nport = 5432\'}); // {db: {port: 5432}}\n```\n',
  'docs/STRATA.md': SPEC,
  'src/index.js': FIXTURE_INDEX,
  'src/errors.js': ERRORS_JS,
  'src/paths.js': PATHS_JS,
  'src/lexer.js': FIXTURE_LEXER,
  'src/parser.js': FIXTURE_PARSER,
  'src/evaluate.js': FIXTURE_EVALUATE,
  'src/interpolate.js': FIXTURE_INTERPOLATE,
  'test/strata.test.js': VISIBLE,
};

const REFERENCE = {
  'src/index.js': INDEX_JS, 'src/errors.js': ERRORS_JS, 'src/paths.js': PATHS_JS, 'src/lexer.js': LEXER_JS,
  'src/parser.js': PARSER_JS, 'src/evaluate.js': EVALUATE_JS, 'src/interpolate.js': INTERPOLATE_JS,
};

const main = text => ({'main.st': text});

// [name, files, overrides, expected]: load('main.st', files, {overrides}) must deep-equal expected, with the same key order.
const CASES = [
  ['integers', main('a = 1_000\nb = -0\nc = 9007199254740991\nd = -9_007_199_254_740_991\ne = 0\nf = -12'),
    [], {a: 1000, b: 0, c: 9007199254740991, d: -9007199254740991, e: 0, f: -12}],
  ['string escapes', main(String.raw`a = "q\"\\\t\n\$x $ {y} $"`), [], {a: 'q"\\\t\n$x $ {y} $'}],
  ['raw strings and quoted keys', main("'x y' = 'no ${ref} \\n'\n\"a.b\".c = 1\n\"\" = true\n\"\\${x}\" = 2\n'tab'\t=\t''"),
    [], {'x y': 'no ${ref} \\n', 'a.b': {c: 1}, '': true, '${x}': 2, tab: ''}],
  ['lists', main('a = []\nb = [1, "x", true,]\nc = [\'a\']\nd=[-1,0]'), [], {a: [], b: [1, 'x', true], c: ['a'], d: [-1, 0]}],
  ['words around -=', main('xs = [1, 2, 3, 2, 1]\nxs-=[2, 1]\nk-d = 3\nm = -5\nm+=-5\nn-1 = [-1]\nn-1-=-1'),
    [], {xs: [3], 'k-d': 3, m: -10, 'n-1': []}],
  ['comments and CRLF', {'main.st': 'a = 1 # c\r\n# full\r\n\r\nb = "#not" # x\r\nc = \'#\'#\r\n'}, [], {a: 1, b: '#not', c: '#'}],
  ['section headers are absolute and create tables', main('[a.b]\nx = 1\n[c]\n[a]\ny.z = 2\n[ a . "b" ]\nw = 3'),
    [], {a: {b: {x: 1, w: 3}, y: {z: 2}}, c: {}}],
  ['key order with replace and unset', main('a = 1\nb = 2\nc = 3\na = 4\n@unset b\nb = 5'), [], {a: 4, c: 3, b: 5}],
  ['unset tables and missing paths', main('a.b.c = 1\n@unset a.b\n@unset q.r\n@unset a.b.c\ns = 1\n@unset s.t'), [], {a: {}, s: 1}],
  ['unset is relative to the section', main('[srv]\nport = 1\nhost = "h"\n@unset port\n[other]\n@unset srv'), [], {srv: {host: 'h'}, other: {}}],
  ['?= tests existence at that point', main('a ?= 1\na ?= 2\nt.x = 1\nt ?= 5\nb ?= 1\nb = 2'), [], {a: 1, t: {x: 1}, b: 2}],
  ['+= on lists and integers', main('l += [1]\nl += 2\nl += ["x", 3]\nn = 1\nn += 2\ns += "x"\ne += []'),
    [], {l: [1, 2, 'x', 3], n: 3, s: 'x', e: []}],
  ['-= compares strings as written', main('b = "B"\n[t]\nxs = ["${.a}", \'a\', "\\${a}", 1, true, "a${b}"]\nxs -= ["${t.a}", "a", "a${..b}"]'),
    [], {b: 'B', t: {xs: ['${a}', 1, true]}}],
  ['-= with a scalar', main('xs = [1, "1", true, 1, false]\nxs -= 1\nys = [true, "true"]\nys -= "true"'), [], {xs: ['1', true, false], ys: [true]}],
  ['append and union', main('@merge tags append\ntags = ["a"]\ntags = ["b", "a"]\n@merge tags union\ntags = ["b", "c", "c"]'),
    [], {tags: ['a', 'b', 'a', 'c']}],
  ['union keeps duplicates of a new key', main('@merge u union\nu = [1, 1]\nu = [1, 2, true, "1"]'), [], {u: [1, 1, 2, true, '1']}],
  ['keep only affects =', main('@merge name keep\nname = "a"\nname = "b"\nname ?= "c"\n@merge n keep\nn = 1\nn += 1\nn = 9'), [], {name: 'a', n: 2}],
  ['patterns: wildcards, sections, last declaration wins',
    main('[servers]\n@merge *.tags union\n@merge eu.tags append\n[servers.eu]\ntags = [1]\ntags = [1, 2]\n[servers.us]\ntags = [1]\ntags = [1, 2]'),
    [], {servers: {eu: {tags: [1, 1, 2]}, us: {tags: [1, 2]}}}],
  ['a quoted * is an ordinary key', main('@merge "*" append\n"*" = [1]\n"*" = [2]\nx = [1]\nx = [2]'), [], {'*': [1, 2], x: [2]}],
  ['declarations apply to later assignments only', main('a = [1]\na = [2]\n@merge a append\na = [3]'), [], {a: [2, 3]}],
  ['strategies fall back to replace', main('@merge v append\nv = 1\nv = [2]\nv = [3]\nv = "s"'), [], {v: 's'}],
  ['patterns match whole paths', main('@merge a.* append\na.b = [1]\na.b = [2]\na.c.d = [1]\na.c.d = [2]'), [], {a: {b: [1, 2], c: {d: [2]}}}],
  ['strategies declared in an include apply afterwards', {'main.st': '@include "policy.st"\n[db]\nhosts = ["a"]\nhosts = ["b"]', 'policy.st': '[db]\n@merge hosts append'},
    [], {db: {hosts: ['a', 'b']}}],
  ['overrides replace whatever @merge says', main('@merge l append\nl = [1]\nl = [2]'),
    ['l = [3]', 'p.q = 5', 'p.q += 1', "r = '${l}'", 'l += 4'], {l: [3, 4], p: {q: 6}, r: '${l}'}],
  ['overrides use relative references', main('top = "file"'), ['a.b = "${.c}-${..top}"', 'a.c = 1', 'top = "T"'], {top: 'T', a: {b: '1-T', c: 1}}],
  ['includes resolve against the including file', {
    'main.st': '@include "conf/app.st"\nafter = true',
    'conf/app.st': '[app]\nname = "x"\n@include "db.st"\nport = 1',
    'conf/db.st': '[db]\nhost = "h"',
    'db.st': 'wrong = true',
  }, [], {app: {name: 'x', port: 1}, db: {host: 'h'}, after: true}],
  ['.., / and . in include paths', {
    'main.st': '@include "a/b/x.st"',
    'a/b/x.st': '@include "../../top.st"\n@include "/a/y.st"\n@include "././/z.st"\n@include "../b/../../a/./b//z.st"',
    'top.st': 't = 1', 'a/y.st': 'y = 2', 'a/b/z.st': 'z += 3',
  }, [], {t: 1, y: 2, z: 6}],
  ['a file included twice is evaluated twice', {'main.st': '@include "inc.st"\n@include "inc.st"', 'inc.st': 'n += 1\nl += ["x"]'}, [], {n: 2, l: ['x', 'x']}],
  ['included files start at the root section', {'main.st': '[s]\n@include "inc.st"\nb = 2', 'inc.st': 'a = 1\n[t]\nc = 3'}, [], {s: {b: 2}, a: 1, t: {c: 3}}],
  ['late binding', main('url = "${host}:${port}"\nhost = "a"\nport = 80\nhost = "b"'), [], {url: 'b:80', host: 'b', port: 80}],
  ['relative references use the key path prefix', main('name = "n"\n[db]\nhost = "h"\nurl = "${.host}/${..name}"\nnested.k = "${.v}${..host}"\nnested.v = true'),
    [], {name: 'n', db: {host: 'h', url: 'h/n', nested: {k: 'trueh', v: true}}}],
  ['chains of references', main('a = "${b}-${c}"\nb = "${d}"\nd = -12\nc = false\ne = "$${d}$"'), [], {a: '-12-false', b: '-12', d: -12, c: false, e: '$-12$'}],
  ['strings in lists are interpolated', main('l = ["${x}", \'y\', 1, "${.x}"]\nx = "X"\n[t]\nm = ["${.u}${..x}"]\nu = 0'),
    [], {l: ['X', 'y', 1, 'X'], x: 'X', t: {m: ['0X'], u: 0}}],
  ['references with dashes and underscores', main('a-b = 1\n_c = "${a-b}"\nd = "${_c}${a-b}"'), [], {'a-b': 1, _c: '1', d: '11'}],
];

const SYNTAX = ['a = 007', 'a = 1__0', 'a = 1_', 'a = yes', 'a = [[1]]', 'a == 1', '1a = 2', 'a = +1', '[a', '[a] x', 'a. = 1', '"${x}" = 1',
  '@include "${x}.st"', '@include x', '@include', 'a = 1,', 'a = [1 2]', 'a = [,]', 'a = [1,,]', 'a = [1,', 'a', 'a = ', '= 1', '@merge a "keep"', '@merge a',
  '@merge a keep extra', '@unset', '@unset a b', 'a.*.b = 1', 'a = -', 'a = 1 2', 'a = "x" y', 'a ~= 1', '-a = 1', '[]', 'a = _1', 'a = TRUE'];

// [name, files, overrides, message, file, line]: load must throw this StrataError.
const ERRORS = [
  ...SYNTAX.map(line => ['syntax: ' + line, main('ok = 1\n' + line), [], 'syntax error', 'main.st', 2]),
  ['unterminated string', main('a = 1\nb = "abc'), [], 'unterminated string', 'main.st', 2],
  ['lexical errors win over syntax errors', main('= = "x\\q"'), [], 'invalid escape "\\q"', 'main.st', 1],
  ['backslash at the end of the line', main('a = "abc\\'), [], 'unterminated string', 'main.st', 1],
  ['unterminated raw string', main("a = 'abc"), [], 'unterminated string', 'main.st', 1],
  ['unterminated reference', main('a = "${b"'), [], 'unterminated reference', 'main.st', 1],
  ['reference search ignores quotes', main('a = "${b" "}"'), [], 'invalid reference "b" ""', 'main.st', 1],
  ['spaces in a reference', main('a = "${ b }"'), [], 'invalid reference " b "', 'main.st', 1],
  ['empty reference', main('a = "${}"'), [], 'invalid reference ""', 'main.st', 1],
  ['double dot in a reference', main('a = "${a..b}"'), [], 'invalid reference "a..b"', 'main.st', 1],
  ['only dots', main('a = "${..}"'), [], 'invalid reference ".."', 'main.st', 1],
  ['first problem from the left', main('a = "\\q${"'), [], 'invalid escape "\\q"', 'main.st', 1],
  ['unknown directive needs a valid line', main('@includ "x'), [], 'unterminated string', 'main.st', 1],
  ['unknown directive whatever follows', main('@includ x y ] z'), [], 'unknown directive "@includ"', 'main.st', 1],
  ['empty directive name', main('@ x'), [], 'unknown directive "@"', 'main.st', 1],
  ['unknown strategy', main('@merge a.b deep'), [], 'unknown strategy "deep"', 'main.st', 1],
  ['unknown strategy before trailing tokens', main('@merge * Keep x'), [], 'unknown strategy "Keep"', 'main.st', 1],
  ['integer just out of range', main('a = 9007199254740992'), [], 'integer out of range', 'main.st', 1],
  ['integer beyond float precision', main('a = 9007199254740993'), [], 'integer out of range', 'main.st', 1],
  ['range error before a later syntax error', main('a = [-9_007_199_254_740_992, x]'), [], 'integer out of range', 'main.st', 1],
  ['section through a scalar', main('a = 1\n[a.b]'), [], 'key a is not a table', 'main.st', 2],
  ['quoted keys in messages', main(String.raw`'q"\ x' = 1` + '\n' + String.raw`'q"\ x'.r = 1`), [], String.raw`key "q\"\\ x" is not a table`, 'main.st', 2],
  ['cannot assign to a table', {'main.st': '[t.u]\n@include "r.st"', 'r.st': 't = 1'}, [], 'cannot assign to table t', 'r.st', 1],
  ['keep does not protect tables', main('@merge t keep\nt.x = 1\nt = 2'), [], 'cannot assign to table t', 'main.st', 3],
  ['-= on a table', main('t.x = 1\nt -= 1'), [], 'cannot assign to table t', 'main.st', 2],
  ['quoted key of a table', main('s."a b".k = 1\ns."a b" += [1]'), [], 'cannot assign to table s."a b"', 'main.st', 2],
  ['?= opens the parent', main('a.b = 1\na.b.c ?= 2'), [], 'key a.b is not a table', 'main.st', 2],
  ['+= on strings', main('s = "a"\ns += "b"'), [], 'cannot apply "+=" to string and string', 'main.st', 2],
  ['+= integer and list', main('n = 1\nn += [1]'), [], 'cannot apply "+=" to integer and list', 'main.st', 2],
  ['+= boolean and integer', main('b = true\nb += 1'), [], 'cannot apply "+=" to boolean and integer', 'main.st', 2],
  ['+= overflow', main('n = 9007199254740991\nn += 1'), [], 'integer out of range', 'main.st', 2],
  ['+= negative overflow', main('n = -9007199254740991\nn += -9007199254740991'), [], 'integer out of range', 'main.st', 2],
  ['-= on a missing key', main('x -= 1'), [], 'cannot apply "-=" to undefined and integer', 'main.st', 1],
  ['-= on a string', main('x = "a"\nx -= ["a"]'), [], 'cannot apply "-=" to string and list', 'main.st', 2],
  ['reference escapes the root', main('a = "${..x}"'), [], 'reference ..x escapes the root', 'main.st', 1],
  ['reference escapes the root from a section', main('[s]\nok = "${..x}"\nk = "${...x}"'), [], 'reference ...x escapes the root', 'main.st', 3],
  ['references checked even when ?= changes nothing', main('a = 1\na ?= "${..q}"'), [], 'reference ..q escapes the root', 'main.st', 2],
  ['the value is evaluated before the path', main('a = 1\na.b = "${...x}"'), [], 'reference ...x escapes the root', 'main.st', 2],
  ['missing include', main('@include "conf/x.st"'), [], 'cannot include "conf/x.st"', 'main.st', 1],
  ['missing include from a directory', {'main.st': 'x = 1\n@include "conf/a.st"', 'conf/a.st': '\n@include "../b.st"', 'conf/b.st': ''}, [], 'cannot include "b.st"', 'conf/a.st', 2],
  ['include escapes the root', main('@include "../x.st"'), [], 'include path "../x.st" escapes the root', 'main.st', 1],
  ['include escapes before missing', {'main.st': '@include "a/b.st"', 'a/b.st': '@include "./../../a/b.st"'}, [], 'include path "./../../a/b.st" escapes the root', 'a/b.st', 1],
  ['include cycle', {'main.st': 'x = 1\n@include "a.st"', 'a.st': '@include "sub/b.st"', 'sub/b.st': '\n@include "/a.st"'}, [], 'include cycle: a.st -> sub/b.st -> a.st', 'sub/b.st', 2],
  ['self include', main('@include "./main.st"'), [], 'include cycle: main.st -> main.st', 'main.st', 1],
  ['undefined reference through a scalar', main('a = "x${b.c}"\nb = 1'), [], 'undefined reference b.c', 'main.st', 1],
  ['cannot interpolate a table', main('[t]\nx = "${t}"'), [], 'cannot interpolate table t', 'main.st', 2],
  ['cannot interpolate a list', main('l = []\ns = "${l}"'), [], 'cannot interpolate list l', 'main.st', 2],
  ['list check comes before the cycle check', main('l = ["${l}"]'), [], 'cannot interpolate list l', 'main.st', 1],
  ['interpolation cycle', main('c = "${a}"\na = "${b}"\nb = "x${a}"'), [], 'interpolation cycle: a -> b -> a', 'main.st', 3],
  ['self reference', main('a = "${a}"'), [], 'interpolation cycle: a -> a', 'main.st', 1],
  ['cycle reached from a list', main('l = ["${a}"]\na = "${.b}"\nb = "${a}"'), [], 'interpolation cycle: a -> b -> a', 'main.st', 3],
  ['relative cycle', main('[s]\nx = "${.y}"\ny = "${..s.x}"'), [], 'interpolation cycle: s.x -> s.y -> s.x', 'main.st', 3],
  ['document order of errors', main('first = "${missing}"\nsecond = "${a}"\na = "${a}"'), [], 'undefined reference missing', 'main.st', 1],
  ['depth-first order', main('[z]\nq = "${nope}"\n[a]\nr = "${a}"\n[z]\nlast = "${z}"'), [], 'undefined reference nope', 'main.st', 2],
  ['references resolve completely from left to right', main('s = "${a}${missing}"\na = "${b}"\nb = []'), [], 'cannot interpolate list b', 'main.st', 2],
  ['error inside an included string', {'main.st': '@include "x/y.st"\nv = "${w}"', 'x/y.st': '[q]\nw = "${..zz}"'}, [], 'undefined reference zz', 'x/y.st', 2],
  ['override reference error', main('a = 1'), ['b = "${zz}"'], 'undefined reference zz', '<override>', 1],
  ['override must be an assignment', main('a = 1'), ['a = 2', '[s]'], 'syntax error', '<override>', 2],
  ['empty override', main('a = 1'), [''], 'syntax error', '<override>', 1],
  ['comment override', main('a = 1'), ['b = 1', '# note'], 'syntax error', '<override>', 2],
  ['directive override', main('a = 1'), ['@merge a keep'], 'syntax error', '<override>', 1],
  ['override lexical error', main('a = 1'), ['a = "x'], 'unterminated string', '<override>', 1],
  ['override through a scalar', main('a = 1'), ['a.b = 2'], 'key a is not a table', '<override>', 1],
  ['file errors come before overrides', main('a = 1\nb = "'), ['c = "'], 'unterminated string', 'main.st', 2],
  ['lone CR is not a line break', main('a = 1\rb = 2'), [], 'syntax error', 'main.st', 1],
];

const HIDDEN = `import test from 'node:test';
import assert from 'node:assert/strict';
const {load, StrataError} = await import('@ROOT@src/index.js');
for (const [name, files, overrides, expected] of ${JSON.stringify(CASES)}) {
  test('value: ' + name, () => {
    const result = load('main.st', files, overrides.length ? {overrides} : undefined);
    assert.deepStrictEqual(result, expected);
    assert.equal(JSON.stringify(result), JSON.stringify(expected), 'key order');
  });
}
for (const [name, files, overrides, message, file, line] of ${JSON.stringify(ERRORS)}) {
  test('error: ' + name, () => assert.throws(() => load('main.st', files, {overrides}), error => {
    assert.ok(error instanceof StrataError, 'not a StrataError: ' + error);
    assert.deepStrictEqual({name: error.name, message: error.message, file: error.file, line: error.line},
      {name: 'StrataError', message: message + ' (' + file + ':' + line + ')', file, line});
    return true;
  }));
}
`;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];
const tweak = (file, pairs) => root => writeTree(root, {[file]: patch(REFERENCE[file], pairs)});

export default {
  id: 'strata-config',
  category: 'invented configuration language',
  prompt: 'The Strata configuration library in src/ (`load` and `StrataError`, exported from src/index.js) is an early version: it is incomplete and also deviates from its specification, docs/STRATA.md, in places. Make the library implement docs/STRATA.md completely and exactly: every section, including error messages, error locations and evaluation order. Use only Node built-ins and add no dependencies. Do not modify, delete or rename any existing file under test/ (you may add new test files); `npm test` must pass.',
  setup: root => gitRepo(root, [['Strata configuration language: early implementation and specification', files]]),
  solve: root => writeTree(root, REFERENCE),
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
    // union drops duplicates of the new list even when the key held no list.
    tweak('src/evaluate.js', [['&& Array.isArray(old) && Array.isArray(v)) {\n        const result = [...old];', '&& Array.isArray(v)) {\n        const result = Array.isArray(old) ? [...old] : [];']]),
    // Relative references resolved against the current section instead of the key's parent path.
    tweak('src/evaluate.js', [['const v = absolute(value, parent, at);', 'const v = absolute(value, section, at);']]),
    // Cycle listed from the first key being interpolated rather than from the key reached twice.
    tweak('src/interpolate.js', [['[...active.slice(index), {keys}]', '[...active, {keys}]']]),
    // Includes resolved against the root instead of the including file's directory.
    tweak('src/evaluate.js', [["raw.startsWith('/') ? [] : from.split('/').slice(0, -1)", '[]']]),
    // The first matching @merge declaration wins.
    tweak('src/evaluate.js', [['for (let i = merges.length - 1; i >= 0; i--) {', 'for (let i = 0; i < merges.length; i++) {']]),
    // Overrides honour @merge strategies.
    tweak('src/evaluate.js', [['assign([], statement, at, false);', 'assign([], statement, at, true);']]),
    // Strings compared by the reference text as written instead of the absolute path.
    tweak('src/evaluate.js', [['return part.path.length === other.path.length && part.path.every((key, j) => key === other.path[j]);', 'return part.ref === other.ref;']]),
    // A visible test edited.
    root => writeTree(root, {'test/strata.test.js': VISIBLE.replace("test('errors name the file and line'", "test.skip('errors name the file and line'")}),
  ],
};
