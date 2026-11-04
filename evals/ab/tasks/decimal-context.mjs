import {gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

// Fixture sources are String.raw: what you see is what lands in the file (no backticks or ${ inside).
const SPEC = String.raw`# Decimal arithmetic

src/decimal.js exports six functions: add, sub, mul, div, quantize and compare. Operands and results are strings
(see "Syntax" and "Formatting"). This document is the complete specification.

    add(a, b, context)        a + b
    sub(a, b, context)        a - b
    mul(a, b, context)        a * b
    div(a, b, context)        a / b
    quantize(a, exponent, context)
    compare(a, b)             -1, 0 or 1 (a number)

The context argument is optional everywhere it appears. compare takes no context.

## 1. Values

A decimal is a triple (sign, coefficient, exponent): the sign is + or -, the coefficient is a non-negative integer
of any size and the exponent is an integer. Its numeric value is (+/-) coefficient * 10^exponent.

- The exponent is part of the decimal, not only the numeric value: 1.5 (coefficient 15, exponent -1) and 1.50
  (coefficient 150, exponent -2) are different decimals with the same value.
- A zero can have either sign and any exponent: -0.00 is (-, 0, -2).
- The exponent of every operand and every result lies in the range -9999 to 9999 inclusive ("the exponent range").

## 2. Syntax

An operand must be a string of this form, with nothing before or after it (no whitespace):

    decimal  = [sign] integer ["." fraction] [exponent]
    sign     = "+" | "-"
    exponent = ("e" | "E") [sign] digits

- Digits are the ASCII characters 0-9 only.
- integer and fraction each consist of one or more digits, optionally split by underscores. A point must have at
  least one digit on each side: ".5" and "5." are invalid.
- In the integer part every underscore must be preceded by at least one digit and followed by exactly three digits
  before the next underscore or the end of the integer part. In the fraction part every underscore must be preceded
  by exactly three digits since the point or the previous underscore, and followed by at least one digit.
  Underscores are not allowed anywhere else (not in the exponent, not next to the sign or the point).
  Valid: 1_000, 1234_567, 12_345_678.123_45, 0.000_1, 0.123_456_7.
  Invalid: 1__000, _100, 100_, 10_00, 1_0000, 1.00_0, 1.000_, 1_.5, 1._5, 1e1_0.
- The exponent part may have any number of digits; leading zeros never matter (also not in integer).
- The decimal denoted: sign as written (+ when omitted), coefficient = the integer digits followed by the fraction
  digits, read as one integer, and exponent = (the value of the exponent part, 0 when absent) - (the number of
  fraction digits). Example: "-0012.340e-2" is (-, 12340, -5).
- If that exponent is outside the exponent range the operand is out of range, even when the same value could be
  written with an exponent inside the range: "1e10000" is out of range, while "10e9999" (10, 9999) and "0.1e10000"
  (1, 9999) are fine.

## 3. Context

A context is undefined or an object with two optional properties; other properties are ignored, and a property
whose value is undefined takes its default.

- precision: an integer (a number) from 1 to 5000 inclusive. Default 28.
- rounding: one of "half-even", "half-up", "half-down", "half-odd", "up", "down", "ceiling", "floor", "05up".
  Default "half-even".

## 4. Rounding

Rounding a decimal value v at exponent e (e larger than the exponent at which v is exact) produces the coefficient
c for exponent e as follows. Let x = |v| / 10^e, t = the integer part of x and r = x - t (0 <= r < 1). When r = 0
the result is t, whatever the mode. Otherwise:

- down: t. up: t + 1.
- ceiling: t + 1 when v is positive, t when v is negative. floor: t when v is positive, t + 1 when v is negative.
- half-up: t + 1 when r >= 1/2, else t. half-down: t + 1 when r > 1/2, else t.
- half-even: t + 1 when r > 1/2, t when r < 1/2; when r = 1/2, whichever of t and t + 1 is even.
- half-odd: like half-even, but when r = 1/2 whichever of t and t + 1 is odd.
- 05up: t + 1 when the last decimal digit of t is 0 or 5, otherwise t.

The result keeps the sign of v, even when c is 0.

### Rounding to precision

add, sub and mul compute the exact result and its ideal exponent (defined below). If the exact result written at
the ideal exponent has at most precision coefficient digits, that is the result. Otherwise it is rounded, using the
context's mode, at the smallest exponent at which the rounded coefficient has at most precision digits. For
example 9995 at precision 3 with half-even is (+, 100, 2), formatted 1.00e+4: at exponent 1 it would round to
1000, which has four digits. Coefficient digits are counted without leading zeros; the coefficient 0 has one digit.

### Exponent limits

These rules apply to the results of add, sub, mul and div:

- Lower limit: if the exponent chosen by the operation's rules is below -9999, the exact result is instead rounded
  at exponent -9999. This is a single rounding of the exact result, never a rounding of an already rounded value.
  The result may become a zero (keeping the sign of the exact result).
- Upper limit: if the exponent of the result is above 9999, the value is rewritten at exponent 9999 by appending
  zeros to the coefficient, provided the new coefficient has at most precision digits (a zero coefficient always
  qualifies). Otherwise the operation throws a RangeError "Overflow".

## 5. Operations

- add(a, b): the ideal exponent is the smaller of the two exponents; the exact sum at that exponent is rounded to
  precision. sub(a, b) is exactly add(a, -b), where -b is b with its sign flipped (also when b is a zero).
- Sign of a zero sum: when the exact sum is zero, its sign is - if both operands have sign -, + if both have
  sign +, and when the signs differ it is - under the rounding mode floor and + under every other mode. A nonzero
  sum has the sign of its value.
- mul(a, b): the ideal exponent is the sum of the exponents, the sign is - exactly when the operand signs differ
  (also for zeros), and the exact product is rounded to precision.
- div(a, b): the sign is - exactly when the operand signs differ (also for zeros). The ideal exponent E is the
  smallest of: the exponent of a, the exponent of b, and (exponent of a - exponent of b). Then the first rule that
  applies is used:
  1. b is zero: throw a RangeError "Division undefined" if a is also zero, else "Division by zero".
  2. a is zero: the result is a zero with exponent E.
  3. The exact quotient q is an integer multiple of 10^E: q is written at exponent E and rounded to precision like
     a sum.
  4. q can be written exactly with at most precision coefficient digits and an exponent of at least -9999: the
     result is q with the largest exponent that represents it exactly (its coefficient has no trailing zeros).
  5. Otherwise q is rounded to exactly precision digits: the exponent e is the one for which |q| / 10^e lies in
     [10^(precision-1), 10^precision), and |q| is rounded at e with the context's mode. If that produces the
     coefficient 10^precision, the result is 10^(precision-1) at exponent e + 1. If e is below -9999 the lower
     limit applies (q is rounded once, at exponent -9999).
- quantize(a, exponent): exponent must be a number that is an integer in the exponent range. The result has exactly
  that exponent and the sign of a: a's value rounded at that exponent with the context's mode, or, when the
  exponent is below a's exponent, a's coefficient with zeros appended. If the resulting coefficient has more than
  precision digits, throw a RangeError "Quantize exceeds precision". The exponent limits section does not apply.
- compare(a, b): -1, 0 or 1 as the value of a is smaller than, equal to or larger than the value of b. Exponents and
  the signs of zeros do not matter: compare("1.0", "1") and compare("-0", "0e5") are 0.

## 6. Formatting

Let c be the coefficient's decimal digits (no leading zeros; "0" for zero), n the number of digits, e the exponent
and adj = e + n - 1.

- If e <= 0 and adj >= -8, plain notation: c itself when e = 0; otherwise c with a point inserted so that exactly
  -e digits follow it, adding leading zeros (and a single 0 before the point) as needed: (12345, -2) is 123.45,
  (5, -3) is 0.005, (0, -2) is 0.00.
- Otherwise scientific notation: the first digit of c, then (only when n > 1) a point and the remaining digits, then
  a lower-case "e", then "+" when adj >= 0 or "-" when adj < 0, then |adj| in decimal: (12, 3) is 1.2e+4, (1, -9)
  is 1e-9, (0, 5) is 0e+5, (100, 2) is 1.00e+4.
- A "-" is put in front when the sign is -, including for zeros.

## 7. Errors

Arguments are validated in this order: the context, then the first operand, then the second argument, then the
operation's own rules (division by zero, quantize precision, overflow). The first problem found throws:

- context neither undefined nor a non-null object: TypeError "Invalid context".
- bad precision: RangeError "Invalid precision: <value>"; then a bad rounding: RangeError "Invalid rounding: <value>".
- an operand that is not a string: TypeError "Operand must be a string".
- a string that does not match the syntax: SyntaxError "Invalid decimal: <JSON>", where <JSON> is
  JSON.stringify(operand), for example Invalid decimal: "1.".
- an operand whose exponent is out of range: RangeError "Exponent out of range: <operand>" (the operand string as
  given).
- a bad quantize exponent: RangeError "Invalid exponent: <value>".

<value> is String(value) of the offending value.

## 8. Performance

Operands with thousands of digits are normal. One add, sub, mul, div or quantize at precision 5000 with operands of
up to 5000 digits must take well under 20 milliseconds on average.
`;

const NAIVE = String.raw`/** Decimal arithmetic on strings; see docs/DECIMAL.md. Work in progress: exact add/sub/mul only. */
const SYNTAX = /^([+-]?)(\d+)(?:\.(\d+))?$/;

function parse(text) {
  const m = SYNTAX.exec(text);
  if (!m) throw new SyntaxError('Invalid decimal: ' + JSON.stringify(text));
  const frac = m[3] ?? '';
  return {neg: m[1] === '-', coef: BigInt(m[2] + frac), exp: -frac.length};
}

function format({neg, coef, exp}) {
  let s = coef.toString();
  if (exp < 0) { s = s.padStart(-exp + 1, '0'); s = s.slice(0, exp) + '.' + s.slice(exp); }
  else s += '0'.repeat(exp);
  return (neg ? '-' : '') + s;
}

function align(x, y) {
  const exp = Math.min(x.exp, y.exp);
  const scale = v => v.coef * 10n ** BigInt(v.exp - exp) * (v.neg ? -1n : 1n);
  return [scale(x), scale(y), exp];
}

const fromSigned = (n, exp) => ({neg: n < 0n, coef: n < 0n ? -n : n, exp});

export function add(a, b) { const [x, y, exp] = align(parse(a), parse(b)); return format(fromSigned(x + y, exp)); }
export function sub(a, b) { const [x, y, exp] = align(parse(a), parse(b)); return format(fromSigned(x - y, exp)); }
export function mul(a, b) {
  const x = parse(a), y = parse(b);
  return format({neg: x.neg !== y.neg, coef: x.coef * y.coef, exp: x.exp + y.exp});
}
export function div() { throw new Error('div is not implemented yet'); }
export function quantize() { throw new Error('quantize is not implemented yet'); }
export function compare(a, b) { const [x, y] = align(parse(a), parse(b)); return x < y ? -1 : x > y ? 1 : 0; }
`;

const VISIBLE = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {add, sub, mul, div, quantize, compare} from '../src/decimal.js';

test('add and sub keep the smaller exponent', () => {
  assert.equal(add('1.20', '3'), '4.20');
  assert.equal(sub('1', '0.25'), '0.75');
});

test('mul adds exponents', () => assert.equal(mul('1.5', '1.5'), '2.25'));

test('underscores group digits', () => assert.equal(add('1_000.5', '0'), '1000.5'));

test('div', () => {
  assert.equal(div('1', '4'), '0.25');
  assert.equal(div('1', '3'), '0.3333333333333333333333333333');
  assert.equal(div('6.0', '2'), '3.0');
});

test('quantize rounds half-even by default', () => {
  assert.equal(quantize('2.345', -2), '2.34');
  assert.equal(quantize('2.355', -2), '2.36');
});

test('rounding to precision', () => assert.equal(add('123456', '0', {precision: 3}), '1.23e+5'));

test('compare', () => {
  assert.equal(compare('1.0', '1'), 0);
  assert.equal(compare('-2', '1'), -1);
});

test('syntax errors', () => assert.throws(() => add('1.', '1'), {name: 'SyntaxError', message: 'Invalid decimal: "1."'}));
`;

const files = {
  'package.json': JSON.stringify({name: 'decimal-strings', version: '1.0.0', type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'docs/DECIMAL.md': SPEC,
  'src/decimal.js': NAIVE,
  'test/decimal.test.js': VISIBLE,
};

const REFERENCE = String.raw`/** Decimal arithmetic on strings; see docs/DECIMAL.md. */
const EMIN = -9999, EMAX = 9999;
const MODES = new Set(['half-even', 'half-up', 'half-down', 'half-odd', 'up', 'down', 'ceiling', 'floor', '05up']);
const SYNTAX = /^([+-]?)(\d+(?:_\d{3})*)(?:\.((?:\d{3}_)*\d+))?(?:[eE]([+-]?\d+))?$/;

const p10 = n => 10n ** BigInt(n);
const digits = c => c.toString().length;

function context(ctx) {
  if (ctx === undefined) ctx = {};
  else if (ctx === null || typeof ctx !== 'object') throw new TypeError('Invalid context');
  const precision = ctx.precision === undefined ? 28 : ctx.precision;
  if (!Number.isInteger(precision) || precision < 1 || precision > 5000) throw new RangeError('Invalid precision: ' + String(precision));
  const rounding = ctx.rounding === undefined ? 'half-even' : ctx.rounding;
  if (!MODES.has(rounding)) throw new RangeError('Invalid rounding: ' + String(rounding));
  return {precision, rounding};
}

function parse(text) {
  if (typeof text !== 'string') throw new TypeError('Operand must be a string');
  const m = SYNTAX.exec(text);
  if (!m) throw new SyntaxError('Invalid decimal: ' + JSON.stringify(text));
  const int = m[2].replaceAll('_', ''), frac = (m[3] ?? '').replaceAll('_', '');
  const exp = BigInt(m[4] ?? '0') - BigInt(frac.length);
  if (exp < BigInt(EMIN) || exp > BigInt(EMAX)) throw new RangeError('Exponent out of range: ' + text);
  return {neg: m[1] === '-', coef: BigInt(int + frac), exp: Number(exp)};
}

function format({neg, coef, exp}) {
  const c = coef.toString(), n = c.length, adj = exp + n - 1;
  let s;
  if (exp <= 0 && adj >= -8) {
    const k = -exp;
    s = k === 0 ? c : n > k ? c.slice(0, n - k) + '.' + c.slice(n - k) : '0.' + '0'.repeat(k - n) + c;
  } else s = c[0] + (n > 1 ? '.' + c.slice(1) : '') + 'e' + (adj < 0 ? '-' : '+') + Math.abs(adj);
  return (neg ? '-' : '') + s;
}

/** n / d (n >= 0, d > 0) rounded to an integer with the given mode; neg is the sign of the value. */
function roundDiv(neg, n, d, mode) {
  const t = n / d, r = n % d;
  if (r === 0n) return t;
  const half = 2n * r < d ? -1 : 2n * r > d ? 1 : 0;
  let up;
  switch (mode) {
    case 'down': up = false; break;
    case 'up': up = true; break;
    case 'ceiling': up = !neg; break;
    case 'floor': up = neg; break;
    case 'half-up': up = half >= 0; break;
    case 'half-down': up = half > 0; break;
    case 'half-even': up = half > 0 || (half === 0 && t % 2n === 1n); break;
    case 'half-odd': up = half > 0 || (half === 0 && t % 2n === 0n); break;
    case '05up': up = t % 5n === 0n; break;
  }
  return up ? t + 1n : t;
}

/** Upper exponent limit: rewrite at EMAX or overflow. */
function clampMax(neg, coef, exp, precision) {
  if (exp > EMAX) {
    if (coef !== 0n && digits(coef) + exp - EMAX > precision) throw new RangeError('Overflow');
    coef *= p10(exp - EMAX);
    exp = EMAX;
  }
  return format({neg, coef, exp});
}

/** Exact value coef * 10^exp, rounded to precision with the lower exponent limit applied in the same rounding. */
function fit(neg, coef, exp, {precision, rounding}) {
  const n = digits(coef);
  let target = n > precision ? exp + n - precision : exp;
  if (target < EMIN) target = EMIN;
  if (target > exp) {
    coef = roundDiv(neg, coef, p10(target - exp), rounding);
    exp = target;
    if (digits(coef) > precision) { coef /= 10n; exp += 1; }
  }
  return clampMax(neg, coef, exp, precision);
}

function addParsed(x, y, ctx) {
  const exp = Math.min(x.exp, y.exp);
  const cx = x.coef * p10(x.exp - exp), cy = y.coef * p10(y.exp - exp);
  const sum = (x.neg ? -cx : cx) + (y.neg ? -cy : cy);
  const neg = sum === 0n ? (x.neg === y.neg ? x.neg : ctx.rounding === 'floor') : sum < 0n;
  return fit(neg, sum < 0n ? -sum : sum, exp, ctx);
}

export function add(a, b, ctx) {
  ctx = context(ctx);
  const x = parse(a), y = parse(b);
  return addParsed(x, y, ctx);
}

export function sub(a, b, ctx) {
  ctx = context(ctx);
  const x = parse(a), y = parse(b);
  return addParsed(x, {...y, neg: !y.neg}, ctx);
}

export function mul(a, b, ctx) {
  ctx = context(ctx);
  const x = parse(a), y = parse(b);
  return fit(x.neg !== y.neg, x.coef * y.coef, x.exp + y.exp, ctx);
}

export function div(a, b, ctx) {
  ctx = context(ctx);
  const x = parse(a), y = parse(b);
  if (y.coef === 0n) throw new RangeError(x.coef === 0n ? 'Division undefined' : 'Division by zero');
  const neg = x.neg !== y.neg, {precision, rounding} = ctx;
  const d = x.exp - y.exp, E = Math.min(x.exp, y.exp, d);
  if (x.coef === 0n) return fit(neg, 0n, E, ctx);
  const scaled = x.coef * p10(d - E);
  if (scaled % y.coef === 0n) return fit(neg, scaled / y.coef, E, ctx);
  // q = x.coef * 10^d / y.coef; find e with 10^(p-1) <= |q| / 10^e < 10^p.
  let e = digits(x.coef) - digits(y.coef) + d - precision;
  const at = e => e <= d ? [x.coef * p10(d - e), y.coef] : [x.coef, y.coef * p10(e - d)];
  let [num, den] = at(e);
  const top = p10(precision);
  while (num / den >= top) [num, den] = at(++e);
  while (num / den < top / 10n) [num, den] = at(--e);
  if (e < EMIN) [num, den] = at(e = EMIN);
  let coef;
  if (num % den === 0n) {
    coef = num / den;
    while (e < E && coef % 10n === 0n) { coef /= 10n; e += 1; }
  } else {
    coef = roundDiv(neg, num, den, rounding);
    if (coef === top) { coef /= 10n; e += 1; }
  }
  return clampMax(neg, coef, e, precision);
}

export function quantize(a, exponent, ctx) {
  ctx = context(ctx);
  const x = parse(a);
  if (!Number.isInteger(exponent) || exponent < EMIN || exponent > EMAX) throw new RangeError('Invalid exponent: ' + String(exponent));
  const coef = exponent >= x.exp ? roundDiv(x.neg, x.coef, p10(exponent - x.exp), ctx.rounding) : x.coef * p10(x.exp - exponent);
  if (digits(coef) > ctx.precision) throw new RangeError('Quantize exceeds precision');
  return format({neg: x.neg, coef, exp: exponent});
}

export function compare(a, b) {
  const x = parse(a), y = parse(b);
  const exp = Math.min(x.exp, y.exp);
  const value = v => (v.neg ? -1n : 1n) * v.coef * p10(v.exp - exp);
  const vx = value(x), vy = value(y);
  return vx < vy ? -1 : vx > vy ? 1 : 0;
}
`;

const E = (name, message) => ({error: [name, message]});
const P5000 = {precision: 5000};
const zeros = n => '0'.repeat(n);

// [function, args, expected string/number or E(name, message)]. Every expectation was derived by hand from docs/DECIMAL.md.
const CASES = [
  // Syntax, value and formatting (mul by "1" keeps the decimal unchanged).
  ['mul', ['1_234_567.890_1', '1'], '1234567.8901'],
  ['mul', ['1234_567', '1'], '1234567'],
  ['mul', ['0.123_456_7', '1'], '0.1234567'],
  ['mul', ['0.000_1', '1'], '0.0001'],
  ['mul', ['-0012.340e-2', '1'], '-0.12340'],
  ['mul', ['+7', '1'], '7'],
  ['mul', ['1e0000000000000000000003', '1'], '1e+3'],
  ['mul', ['1E-2', '1'], '0.01'],
  ['mul', ['10e9999', '1'], '1.0e+10000'],
  ['mul', ['0.1e10000', '1'], '1e+9999'],
  ['mul', ['-0.00', '1'], '-0.00'],
  ['mul', ['0.00000001', '1'], '0.00000001'],
  ['mul', ['0.000000001', '1'], '1e-9'],
  ['mul', ['123e-12', '1'], '1.23e-10'],
  ['mul', ['0.0000001234', '1'], '0.0000001234'],
  ['mul', ['0e5', '1'], '0e+5'],
  ['mul', ['0e-12', '1'], '0e-12'],
  ['mul', ['0.000000000', '1'], '0e-9'],
  ['mul', ['0.00000000', '1'], '0.00000000'],
  ['mul', ['100e2', '1'], '1.00e+4'],
  ['mul', ['12.5e1', '1'], '125'],
  ['mul', ['1.0e9999', '1'], '1.0e+9999'],
  ...['1__000', '_100', '100_', '10_00', '1_0000', '1.00_0', '1.000_', '1_.5', '1._5', '1e1_0', '.5', '5.', '+-1', '1e', '1e+',
    '', ' 1', '1 ', 'NaN', 'Infinity', '0x10', '1,000', '\uff11', '\u0661', '1_000_', '-_1', '1.5.5', '1e5e5', '1\n']
    .map(text => ['add', [text, '1'], E('SyntaxError', 'Invalid decimal: ' + JSON.stringify(text))]),
  ['add', ['1e10000', '1'], E('RangeError', 'Exponent out of range: 1e10000')],
  ['add', ['0.0001e-9996', '1'], E('RangeError', 'Exponent out of range: 0.0001e-9996')],
  ['add', ['0.1e-9999', '1'], E('RangeError', 'Exponent out of range: 0.1e-9999')],
  ['add', ['1', '-1e-10000'], E('RangeError', 'Exponent out of range: -1e-10000')],
  ['add', [1, '1'], E('TypeError', 'Operand must be a string')],
  ['add', ['1', null], E('TypeError', 'Operand must be a string')],
  // Context validation and order.
  ['add', ['1', '1', {precision: 0}], E('RangeError', 'Invalid precision: 0')],
  ['add', ['1', '1', {precision: 5001}], E('RangeError', 'Invalid precision: 5001')],
  ['add', ['1', '1', {precision: 2.5}], E('RangeError', 'Invalid precision: 2.5')],
  ['add', ['1', '1', {precision: '28'}], E('RangeError', 'Invalid precision: 28')],
  ['add', ['1', '1', {rounding: 'HALF_EVEN'}], E('RangeError', 'Invalid rounding: HALF_EVEN')],
  ['add', ['1', '1', {rounding: 'half_up'}], E('RangeError', 'Invalid rounding: half_up')],
  ['add', ['1', '1', null], E('TypeError', 'Invalid context')],
  ['add', ['1', '1', 'half-up'], E('TypeError', 'Invalid context')],
  ['add', ['bad', 'bad', {precision: 0, rounding: 'x'}], E('RangeError', 'Invalid precision: 0')],
  ['add', ['bad', 'bad', {rounding: 'x'}], E('RangeError', 'Invalid rounding: x')],
  ['add', ['1', '1', {precision: 5000, rounding: 'up', other: 'ignored'}], '2'],
  ['mul', ['bad', 2], E('SyntaxError', 'Invalid decimal: "bad"')],
  ['div', ['0', '0.0'], E('RangeError', 'Division undefined')],
  ['div', ['1', '-0e5'], E('RangeError', 'Division by zero')],
  ['div', ['1e10000', '0'], E('RangeError', 'Exponent out of range: 1e10000')],
  ['div', ['1', 'x'], E('SyntaxError', 'Invalid decimal: "x"')],
  ['div', ['1', '0', {precision: -1}], E('RangeError', 'Invalid precision: -1')],
  ['quantize', ['1', 1.5], E('RangeError', 'Invalid exponent: 1.5')],
  ['quantize', ['x', 1.5], E('SyntaxError', 'Invalid decimal: "x"')],
  ['quantize', ['1', 10000], E('RangeError', 'Invalid exponent: 10000')],
  ['quantize', ['1', -10000], E('RangeError', 'Invalid exponent: -10000')],
  ['quantize', ['1', '2'], E('RangeError', 'Invalid exponent: 2')],
  ['quantize', ['1', 2, {rounding: 'nearest'}], E('RangeError', 'Invalid rounding: nearest')],
  ['compare', ['1', 'one'], E('SyntaxError', 'Invalid decimal: "one"')],
  // add / sub.
  ['add', ['1e3', '1'], '1001'],
  ['add', ['1e3', '1e3'], '2e+3'],
  ['add', ['0.1', '0.2'], '0.3'],
  ['sub', ['1.30', '1.3'], '0.00'],
  ['add', ['5', '-5'], '0'],
  ['add', ['5', '-5', {rounding: 'floor'}], '-0'],
  ['add', ['-0', '-0'], '-0'],
  ['add', ['-0', '0'], '0'],
  ['add', ['-0', '0', {rounding: 'floor'}], '-0'],
  ['add', ['-1.0', '1.00'], '0.00'],
  ['add', ['-1.0', '1.00', {rounding: 'floor'}], '-0.00'],
  ['add', ['-1.0', '1.00', {rounding: 'ceiling'}], '0.00'],
  ['sub', ['0', '0'], '0'],
  ['sub', ['0', '0', {rounding: 'floor'}], '-0'],
  ['sub', ['-0', '0'], '-0'],
  ['sub', ['-0', '-0'], '0'],
  ['sub', ['1.5', '1.5', {rounding: 'floor'}], '-0.0'],
  ['sub', ['-2', '-2.0'], '0.0'],
  ['add', ['123456789', '0', {precision: 5, rounding: 'down'}], '1.2345e+8'],
  ['add', ['123456789', '0', {precision: 5, rounding: 'up'}], '1.2346e+8'],
  ['add', ['123456789', '0', {precision: 5, rounding: 'half-down'}], '1.2346e+8'],
  ['add', ['123.456', '0.0001', {precision: 5}], '123.46'],
  ...[['half-even', '1.234e+4'], ['half-odd', '1.235e+4'], ['half-up', '1.235e+4'], ['half-down', '1.234e+4'], ['up', '1.235e+4'],
    ['down', '1.234e+4'], ['ceiling', '1.235e+4'], ['floor', '1.234e+4'], ['05up', '1.234e+4']]
    .map(([rounding, want]) => ['add', ['12345', '0', {precision: 4, rounding}], want]),
  ...[['half-even', '-1.234e+4'], ['half-odd', '-1.235e+4'], ['half-up', '-1.235e+4'], ['half-down', '-1.234e+4'], ['up', '-1.235e+4'],
    ['down', '-1.234e+4'], ['ceiling', '-1.234e+4'], ['floor', '-1.235e+4'], ['05up', '-1.234e+4']]
    .map(([rounding, want]) => ['sub', ['-12345', '0', {precision: 4, rounding}], want]),
  ['add', ['12505', '0', {precision: 4, rounding: '05up'}], '1.251e+4'],
  ['add', ['12555', '0', {precision: 4, rounding: '05up'}], '1.256e+4'],
  ['add', ['12565', '0', {precision: 4, rounding: '05up'}], '1.256e+4'],
  ['add', ['12500', '0', {precision: 4, rounding: '05up'}], '1.250e+4'],
  ['add', ['-0.02501', '0', {precision: 3, rounding: '05up'}], '-0.0251'],
  ['add', ['1.' + zeros(27) + '49', '0'], '1.' + zeros(27)],
  ['add', ['1.' + zeros(27) + '5', '0'], '1.' + zeros(27)],
  ['add', ['1.' + zeros(26) + '15', '0'], '1.' + zeros(26) + '2'],
  ['add', ['1.' + zeros(26) + '25', '0'], '1.' + zeros(26) + '2'],
  ['add', ['1.' + zeros(27) + '51', '0'], '1.' + zeros(26) + '1'],
  ['add', ['9995', '0', {precision: 3}], '1.00e+4'],
  ['add', ['9995', '0', {precision: 3, rounding: 'half-down'}], '9.99e+3'],
  ['add', ['9991', '0', {precision: 3, rounding: 'up'}], '1.00e+4'],
  ['add', ['9991', '0', {precision: 3, rounding: '05up'}], '9.99e+3'],
  ['add', ['-9999.5', '0', {precision: 4, rounding: 'floor'}], '-1.000e+4'],
  ['add', ['0.99999', '0.000001', {precision: 2}], '1.0'],
  ['add', ['1e9999', '1e-9999'], '1.' + zeros(27) + 'e+9999'],
  ['add', ['1e9999', '1e-9999', {rounding: 'up'}], '1.' + zeros(26) + '1e+9999'],
  ['sub', ['1e9999', '1e-9999'], '1.' + zeros(27) + 'e+9999'],
  ['sub', ['1e9999', '1e-9999', {rounding: 'floor'}], '9.' + '9'.repeat(27) + 'e+9998'],
  ['add', ['9.99e9999', '1e9997', {precision: 3}], '1.00e+10000'],
  ['add', ['999e9999', '1e9999', {precision: 3}], E('RangeError', 'Overflow')],
  ['add', ['999e9999', '1e9999', {precision: 4}], '1.000e+10002'],
  ['add', ['9.99e9999', '1e9997', {precision: 4}], '1.000e+10000'],
  // mul.
  ['mul', ['-2', '0'], '-0'],
  ['mul', ['-2', '-0.0'], '0.0'],
  ['mul', ['-1.25', '0.1', {precision: 2, rounding: 'half-up'}], '-0.13'],
  ['mul', ['-1.25', '0.1', {precision: 2, rounding: 'half-down'}], '-0.12'],
  ['mul', ['-1.25', '0.1', {precision: 2, rounding: 'ceiling'}], '-0.12'],
  ['mul', ['-1.25', '0.1', {precision: 2, rounding: 'floor'}], '-0.13'],
  ['mul', ['1e5000', '1e5000'], '1.0e+10000'],
  ['mul', ['1e9999', '1e1'], '1.0e+10000'],
  ['mul', ['1e9999', '1e1', {precision: 1}], E('RangeError', 'Overflow')],
  ['mul', ['1e5000', '1e5100', {precision: 102}], '1.' + zeros(101) + 'e+10100'],
  ['mul', ['1e5000', '1e5100', {precision: 101}], E('RangeError', 'Overflow')],
  ['mul', ['0e9999', '0e9999'], '0e+9999'],
  ['mul', ['-0e9999', '0e9999', {precision: 1}], '-0e+9999'],
  ['mul', ['-0e-9999', '5e-9999'], '-0e-9999'],
  ['mul', ['1.5e-5000', '1e-5000'], '0e-9999'],
  ['mul', ['2.5e-5000', '-1e-5000', {rounding: 'up'}], '-1e-9999'],
  ['mul', ['1.4996e-5000', '1e-4999', {precision: 4, rounding: 'half-up'}], '1e-9999'],
  ['mul', ['1.4996e-5000', '1e-4999', {precision: 4}], '1e-9999'],
  ['mul', ['12.34e-5000', '1e-5000', {precision: 2}], '1e-9999'],
  ['mul', ['12.34e-4990', '1e-5000', {precision: 2}], '1.2e-9989'],
  ['mul', ['123456789', '987654321', {precision: 10}], '1.219326311e+17'],
  ['mul', ['3.0', '0.50'], '1.500'],
  // div.
  ['div', ['2', '3'], '0.6666666666666666666666666667'],
  ['div', ['-2', '3', {rounding: 'down'}], '-0.6666666666666666666666666666'],
  ['div', ['1', '0.5'], '2.0'],
  ['div', ['1.00', '1'], '1.00'],
  ['div', ['100', '1'], '100'],
  ['div', ['1e2', '1'], '100'],
  ['div', ['1e2', '1e1'], '1e+1'],
  ['div', ['12345', '1', {precision: 3}], '1.23e+4'],
  ['div', ['1', '8', {precision: 2}], '0.12'],
  ['div', ['1', '8', {precision: 2, rounding: 'half-up'}], '0.13'],
  ['div', ['1', '8', {precision: 3}], '0.125'],
  ['div', ['1', '64'], '0.015625'],
  ['div', ['7', '7e3'], '0.001'],
  ['div', ['7e3', '7'], '1000'],
  ['div', ['1.5', '0.03'], '50.00'],
  ['div', ['1', '3e5'], '0.00000' + '3'.repeat(28)],
  ['div', ['1', '3e9'], '3.' + '3'.repeat(27) + 'e-10'],
  ['div', ['0', '5'], '0'],
  ['div', ['-0.00', '5'], '-0.00'],
  ['div', ['0', '-0.5'], '-0.0'],
  ['div', ['0e5', '1e2'], '0e+2'],
  ['div', ['0e-9999', '1e9999'], '0e-9999'],
  ['div', ['1e9999', '1e-9999'], E('RangeError', 'Overflow')],
  ['div', ['1e9999', '3e-9999'], E('RangeError', 'Overflow')],
  ['div', ['1e-9999', '3'], '0e-9999'],
  ['div', ['1e-9999', '3', {rounding: 'up'}], '1e-9999'],
  ['div', ['2e-9999', '3'], '1e-9999'],
  ['div', ['1e-9999', '8'], '0e-9999'],
  ['div', ['1e-9998', '8'], '1e-9999'],
  ['div', ['1e-9996', '8'], '1.25e-9997'],
  ['div', ['1e-9999', '1e9999'], '0e-9999'],
  ['div', ['9.9999', '1', {precision: 3}], '10.0'],
  ['div', ['1', '1.003', {precision: 2}], '1.0'],
  ['div', ['-1', '3', {precision: 3, rounding: 'floor'}], '-0.334'],
  ['div', ['-1', '3', {precision: 3, rounding: 'ceiling'}], '-0.333'],
  ['div', ['1', '-7', {precision: 6, rounding: '05up'}], '-0.142857'],
  ['div', ['1', '-7', {precision: 5, rounding: '05up'}], '-0.14286'],
  ['div', ['2', '0.4e1'], '0.5'],
  ['div', ['22', '7', {precision: 1}], '3'],
  ['div', ['99', '10', {precision: 1}], '1e+1'],
  // quantize.
  ['quantize', ['1.2345', -2], '1.23'],
  ['quantize', ['1.235', -2], '1.24'],
  ['quantize', ['1.235', -2, {rounding: 'half-down'}], '1.23'],
  ['quantize', ['-0.004', -2], '-0.00'],
  ['quantize', ['1', -3], '1.000'],
  ['quantize', ['123', 2], '1e+2'],
  ['quantize', ['123', 2, {rounding: 'ceiling'}], '2e+2'],
  ['quantize', ['-123', 2, {rounding: 'ceiling'}], '-1e+2'],
  ['quantize', ['123.4', 0, {precision: 2}], E('RangeError', 'Quantize exceeds precision')],
  ['quantize', ['99.4', 0, {precision: 2}], '99'],
  ['quantize', ['99.5', 0, {precision: 2}], E('RangeError', 'Quantize exceeds precision')],
  ['quantize', ['1e3', 0], '1000'],
  ['quantize', ['9.99', -1], '10.0'],
  ['quantize', ['-2.5', 0, {rounding: 'half-odd'}], '-3'],
  ['quantize', ['-3.5', 0, {rounding: 'half-odd'}], '-3'],
  ['quantize', ['5e-9999', 9999], '0e+9999'],
  ['quantize', ['1e9999', -9999, P5000], E('RangeError', 'Quantize exceeds precision')],
  ['quantize', ['1e-9999', 9999, {rounding: 'up'}], '1e+9999'],
  // compare.
  ['compare', ['1.0', '1'], 0],
  ['compare', ['-0', '0e5'], 0],
  ['compare', ['-1', '-2'], 1],
  ['compare', ['1e-9999', '0'], 1],
  ['compare', ['2', '10'], -1],
  ['compare', ['1_000', '999.999'], 1],
  ['compare', ['-1e9999', '1e-9999'], -1],
];

const HIDDEN = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
const D = await import('@ROOT@src/decimal.js');
const CASES = @CASES@;
for (const [fn, args, want] of CASES) {
  const label = fn + '(' + args.map(a => JSON.stringify(a)).join(', ') + ')';
  if (want !== null && typeof want === 'object') {
    test(label + ' throws ' + want.error.join(': '), () => assert.throws(() => D[fn](...args),
      e => e instanceof globalThis[want.error[0]] && e.name === want.error[0] && e.message === want.error[1]));
  } else test(label, () => assert.strictEqual(D[fn](...args), want));
}

test('performance: precision 5000', () => {
  const big = '7'.repeat(4000) + '.' + '3'.repeat(1000), den = '1'.repeat(2500) + '.9';
  const start = performance.now();
  for (let i = 0; i < 40; i++) {
    D.div(big, den + i, {precision: 5000});
    D.mul(big, den + i, {precision: 5000});
    D.add(big + 'e-' + (1000 + i), den, {precision: 5000});
    D.quantize(big, -900 - i, {precision: 5000});
  }
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 6000, 'took ' + Math.round(elapsed) + ' ms');
  assert.strictEqual(D.div('1', '7', {precision: 5000}), '0.' + '142857'.repeat(833) + '14');
});

// Small random operations checked against a direct transcription of docs/DECIMAL.md over exact rationals.
const EMIN = -9999;
const pow = n => 10n ** BigInt(n);
const ndig = c => c.toString().length;
function lit(s) {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  const f = m[3] ?? '';
  return {neg: m[1] === '-', c: BigInt(m[2] + f), e: -f.length};
}
function show(neg, c, e) {
  const s = c.toString(), n = s.length, adj = e + n - 1;
  let body;
  if (e <= 0 && adj >= -8) body = e === 0 ? s : (n > -e ? s.slice(0, n + e) + '.' + s.slice(n + e) : '0.' + '0'.repeat(-e - n) + s);
  else body = s[0] + (n > 1 ? '.' + s.slice(1) : '') + 'e' + (adj < 0 ? '-' : '+') + Math.abs(adj);
  return (neg ? '-' : '') + body;
}
// |value| = N / Dn; coefficient at exponent e under mode.
function roundAt(neg, N, Dn, e, mode) {
  let num = N, den = Dn;
  if (e < 0) num *= pow(-e); else den *= pow(e);
  const t = num / den, r = num - t * den;
  if (r === 0n) return t;
  const cmp = 2n * r === den ? 0 : 2n * r > den ? 1 : -1;
  const up = {down: false, up: true, ceiling: !neg, floor: neg, 'half-up': cmp >= 0, 'half-down': cmp > 0,
    'half-even': cmp > 0 || (cmp === 0 && t % 2n === 1n), 'half-odd': cmp > 0 || (cmp === 0 && t % 2n === 0n),
    '05up': t % 10n === 0n || t % 10n === 5n}[mode];
  return up ? t + 1n : t;
}
function toPrecision(neg, N, Dn, E, p, mode) {
  let e = E;
  while (ndig(roundAt(neg, N, Dn, e, mode)) > p) e++;
  if (e < EMIN) e = EMIN;
  return show(neg, roundAt(neg, N, Dn, e, mode), e);
}
function oracle(op, a, b, p, mode) {
  const x = lit(a), y = op === 'quantize' ? null : lit(b);
  const val = v => [v.e >= 0 ? v.c * pow(v.e) : v.c, v.e >= 0 ? 1n : pow(-v.e)];
  if (op === 'quantize') {
    const [N, Dn] = val(x);
    const c = roundAt(x.neg, N, Dn, b, mode);
    return ndig(c) > p ? 'error' : show(x.neg, c, b);
  }
  const [xn, xd] = val(x), [yn, yd] = val(y);
  if (op === 'add' || op === 'sub') {
    const yneg = op === 'sub' ? !y.neg : y.neg;
    const sn = (x.neg ? -xn : xn) * yd + (yneg ? -yn : yn) * xd, sd = xd * yd;
    const neg = sn === 0n ? (x.neg === yneg ? x.neg : mode === 'floor') : sn < 0n;
    return toPrecision(neg, sn < 0n ? -sn : sn, sd, Math.min(x.e, y.e), p, mode);
  }
  const neg = x.neg !== y.neg;
  if (op === 'mul') return toPrecision(neg, xn * yn, xd * yd, x.e + y.e, p, mode);
  if (y.c === 0n) return 'error';
  const E = Math.min(x.e, y.e, x.e - y.e);
  if (x.c === 0n) return show(neg, 0n, E);
  const N = xn * yd, Dn = xd * yn;
  const atE = E < 0 ? N * pow(-E) : N, denE = E < 0 ? Dn : Dn * pow(E);
  if (atE % denE === 0n) return toPrecision(neg, N, Dn, E, p, mode);
  for (let e = E - 1; ; e--) {
    const num = e < 0 ? N * pow(-e) : N, den = e < 0 ? Dn : Dn * pow(e);
    if (num / den >= pow(p)) break;
    if (num % den === 0n) return show(neg, num / den, e);
  }
  let e = E;
  const fl = e => { const num = e < 0 ? N * pow(-e) : N, den = e < 0 ? Dn : Dn * pow(e); return num / den; };
  while (fl(e) >= pow(p)) e++;
  while (fl(e) < pow(p - 1)) e--;
  let c = roundAt(neg, N, Dn, e, mode);
  if (c === pow(p)) { c = pow(p - 1); e++; }
  return show(neg, c, e);
}
let seed = 20261011;
const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
function operand() {
  const len = 1 + rnd(7);
  let s = String(rnd(10) < 2 ? 0 : 1 + rnd(9)) + Array.from({length: len - 1}, () => rnd(10)).join('');
  const frac = rnd(5);
  if (frac) s = s.length > frac ? s.slice(0, -frac) + '.' + s.slice(-frac) : '0.' + s.padStart(frac, '0');
  return (rnd(3) === 0 ? '-' : '') + s;
}
const MODES = ['half-even', 'half-up', 'half-down', 'half-odd', 'up', 'down', 'ceiling', 'floor', '05up'];
test('random small operations follow the specification', () => {
  for (let i = 0; i < 3000; i++) {
    const op = ['add', 'sub', 'mul', 'div', 'quantize'][rnd(5)], p = 1 + rnd(6), mode = MODES[rnd(MODES.length)];
    const a = operand(), b = op === 'quantize' ? rnd(7) - 4 : operand();
    const want = oracle(op, a, b, p, mode);
    let got;
    try { got = D[op](a, b, {precision: p, rounding: mode}); } catch { got = 'error'; }
    assert.strictEqual(got, want, op + '(' + JSON.stringify(a) + ', ' + JSON.stringify(b) + ', {precision: ' + p + ', rounding: ' + mode + '})');
  }
});
`.replace('@CASES@', () => JSON.stringify(CASES));

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];

/** Replace exactly one occurrence, so a mustReject variant can never silently become a no-op. */
function patch(source, from, to) {
  if (source.split(from).length !== 2) throw Error('patch anchor not unique: ' + from);
  return source.replace(from, to);
}
const variant = (from, to) => root => writeTree(root, {'src/decimal.js': patch(REFERENCE, from, to)});

export default {
  id: 'decimal-context',
  category: 'exact arithmetic with rounding contexts',
  prompt: 'src/decimal.js implements only part of docs/DECIMAL.md (exact add/sub/mul; no div, quantize, rounding contexts or exponent limits). Make the module implement the specification completely and exactly. Use only Node built-ins and add no dependencies. Do not modify, delete or rename any existing file under test/ (you may add new test files); `npm test` must pass.',
  setup: root => gitRepo(root, [['Decimal strings: exact add, sub and mul', files]]),
  solve: root => writeTree(root, {'src/decimal.js': REFERENCE}),
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
    // Double rounding at the lower limit: round to precision first, then again at -9999.
    variant('let target = n > precision ? exp + n - precision : exp;\n  if (target < EMIN) target = EMIN;\n  if (target > exp) {',
      'let target = n > precision ? exp + n - precision : exp;\n  if (target > exp) { coef = roundDiv(neg, coef, p10(target - exp), rounding); exp = target; if (digits(coef) > precision) { coef /= 10n; exp += 1; } }\n  target = Math.max(exp, EMIN);\n  if (target > exp) {'),
    // Zero sums always positive when signs differ, ignoring the floor rule.
    variant("(x.neg === y.neg ? x.neg : ctx.rounding === 'floor')", '(x.neg && y.neg)'),
    // General Decimal Arithmetic's ideal exponent for division (ea - eb).
    variant('E = Math.min(x.exp, y.exp, d)', 'E = d'),
    // Plain notation down to adj >= -6 (the common to-sci-string threshold).
    variant('adj >= -8', 'adj >= -6'),
    // Range check on the written exponent instead of the adjusted one.
    variant("const exp = BigInt(m[4] ?? '0') - BigInt(frac.length);\n  if (exp < BigInt(EMIN) || exp > BigInt(EMAX))",
      "const exp = BigInt(m[4] ?? '0') - BigInt(frac.length);\n  if (BigInt(m[4] ?? '0') < BigInt(EMIN) || BigInt(m[4] ?? '0') > BigInt(EMAX))"),
    // 05up rounding away only after a final 0, forgetting 5.
    variant("case '05up': up = t % 5n === 0n; break;", "case '05up': up = t % 10n === 0n; break;"),
    // No rewriting at exponent 9999: every exponent above the limit overflows.
    variant("if (coef !== 0n && digits(coef) + exp - EMAX > precision) throw", "if (coef !== 0n) throw"),
    // A visible test edited.
    root => writeTree(root, {'test/decimal.test.js': VISIBLE.replace("test('div'", "test.skip('div'")}),
  ],
};
