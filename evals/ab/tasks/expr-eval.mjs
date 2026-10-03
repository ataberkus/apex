import {gitRepo, hiddenTests, verdict, writeTree} from '../lib.mjs';

const PROMPT = `evaluate(text) in src/evaluate.js computes arithmetic expressions. It must support:

- numbers: integers and decimals, including forms like 3.5, .5 and 2.
- binary + - * / with the usual precedence, left-associative
- ^ for exponentiation: right-associative (2^3^2 = 512) and binding tighter than unary minus (-2^2 = -4, 2^-1 = 0.5)
- unary minus, including repeated (--3 = 3) and before parentheses (-(1+2) = -3)
- parentheses and whitespace anywhere between tokens

Any invalid input (unknown characters, unbalanced parentheses, a missing operand, trailing tokens, an empty string) must throw a SyntaxError. Several of these cases are broken right now; fix the implementation so that everything above works.`;

const files = {
  'package.json': JSON.stringify({type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'src/tokenize.js': `/** Split an expression into number and operator tokens. */
export function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ') { i++; continue; }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9]/.test(text[j])) j++;
      tokens.push({type: 'number', value: Number(text.slice(i, j))});
      i = j;
      continue;
    }
    if ('+-*/^()'.includes(ch)) { tokens.push({type: 'op', value: ch}); i++; continue; }
    throw new SyntaxError('Unexpected character ' + ch);
  }
  return tokens;
}
`,
  'src/parse.js': `/** Recursive-descent parser producing a small AST. */
export function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const take = value => {
    const token = tokens[pos];
    if (!token || (value !== undefined && token.value !== value)) throw new SyntaxError('Unexpected token ' + (token ? token.value : 'end of input'));
    pos++;
    return token;
  };
  function expression() {
    let node = term();
    while (peek() && (peek().value === '+' || peek().value === '-')) node = {op: take().value, left: node, right: term()};
    return node;
  }
  function term() {
    let node = power();
    while (peek() && (peek().value === '*' || peek().value === '/')) node = {op: take().value, left: node, right: power()};
    return node;
  }
  function power() {
    let node = unary();
    while (peek() && peek().value === '^') node = {op: take().value, left: node, right: unary()};
    return node;
  }
  function unary() {
    if (peek() && peek().value === '-') { take(); return {op: 'neg', arg: primary()}; }
    return primary();
  }
  function primary() {
    const token = take();
    if (token.type === 'number') return {value: token.value};
    if (token.value === '(') { const node = expression(); take(')'); return node; }
    throw new SyntaxError('Unexpected token ' + token.value);
  }
  return expression();
}
`,
  'src/evaluate.js': `import {tokenize} from './tokenize.js';
import {parse} from './parse.js';

function run(node) {
  if ('value' in node) return node.value;
  if (node.op === 'neg') return -run(node.arg);
  const a = run(node.left), b = run(node.right);
  switch (node.op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return a / b;
    case '^': return a ** b;
  }
}

export function evaluate(text) {
  return run(parse(tokenize(text)));
}
`,
  'test/evaluate.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/evaluate.js';
test('precedence', () => assert.equal(evaluate('1 + 2 * 3'), 7));
test('parentheses', () => assert.equal(evaluate('(1 + 2) * 3'), 9));
test('decimals', () => assert.equal(evaluate('1.5 * 2'), 3));
`,
};

const FIXED_TOKENIZE = files['src/tokenize.js']
  .replace("if (ch === ' ') { i++; continue; }", "if (/\\s/.test(ch)) { i++; continue; }")
  .replace("if (/[0-9]/.test(ch)) {\n      let j = i;\n      while (j < text.length && /[0-9]/.test(text[j])) j++;",
    "if (/[0-9.]/.test(ch)) {\n      let j = i;\n      while (j < text.length && /[0-9.]/.test(text[j])) j++;\n      if (!/^(\\d+\\.?\\d*|\\.\\d+)$/.test(text.slice(i, j))) throw new SyntaxError('Bad number ' + text.slice(i, j));");
const FIXED_PARSE = files['src/parse.js']
  .replace("function power() {\n    let node = unary();\n    while (peek() && peek().value === '^') node = {op: take().value, left: node, right: unary()};\n    return node;\n  }",
    "function power() {\n    const node = primary();\n    if (peek() && peek().value === '^') return {op: take().value, left: node, right: unary()};\n    return node;\n  }")
  .replace("function term() {\n    let node = power();", "function term() {\n    let node = unary();")
  .replace("right: power()};", "right: unary()};")
  .replace("return {op: 'neg', arg: primary()}; }\n    return primary();", "return {op: 'neg', arg: unary()}; }\n    return power();")
  .replace('  return expression();\n}', "  const node = expression();\n  if (pos !== tokens.length) throw new SyntaxError('Unexpected token ' + tokens[pos].value);\n  return node;\n}");

export default {
  id: 'expr-eval',
  category: 'parser bugs across modules',
  prompt: PROMPT,
  setup: root => gitRepo(root, [['Expression evaluator', files]]),
  solve: root => writeTree(root, {'src/tokenize.js': FIXED_TOKENIZE, 'src/parse.js': FIXED_PARSE}),
  verify(root) {
    const hidden = hiddenTests(root, `import test from 'node:test';
import assert from 'node:assert/strict';
const {evaluate} = await import('@ROOT@src/evaluate.js');
const ok = {'1 + 2 * 3': 7, '(1 + 2) * 3': 9, '1.5 * 2': 3, '.5 + .25': 0.75, '2. * 3': 6, '2^3^2': 512, '-2^2': -4, '2^-1': 0.5,
  '--3': 3, '-(1+2)': -3, '10 - 4 - 3': 3, '8 / 4 / 2': 1, ' ( 3 )\\t*\\n2 ': 6, '-3 * -2': 6, '2 * -(3 - 5)^2': -8, '(2^2)^3': 64, '1 - -1': 2};
const bad = ['', '   ', '1 +', '(1 + 2', '1 + 2)', '2 $ 3', '1 2', '*3', '()', '1..2', '3 ^', '-'];
test('valid expressions', () => { for (const [text, value] of Object.entries(ok)) assert.equal(evaluate(text), value, text); });
test('invalid input throws SyntaxError', () => { for (const text of bad) assert.throws(() => evaluate(text), SyntaxError, JSON.stringify(text)); });`);
    return verdict({spec_cases: hidden.pass}, {hidden: hidden.output});
  },
};
