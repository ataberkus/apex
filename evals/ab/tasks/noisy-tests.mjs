import {gitRepo, hiddenTests, npm, unchanged, verdict, writeTree} from '../lib.mjs';

const noise = n => Array.from({length: 18}, (_, i) => `  console.log('[sync] warehouse ${n} shard ${i}: reconciling 1024 rows ... ok');`).join('\n');
const filler = Array.from({length: 120}, (_, n) => `test('warehouse ${n} reconciles', () => {\n${noise(n)}\n  assert.equal(totalValue([{price: ${n}, qty: 2}]), ${n * 2});\n});`).join('\n\n');

const files = {
  'package.json': JSON.stringify({name: 'inventory', version: '1.0.0', type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'src/inventory.js': `/** Inventory helpers. Prices are in dollars, quantities are whole units. */
export function totalValue(items) {
  let total = 0;
  for (const item of items) total += Math.floor(item.price * item.qty);
  return total;
}

export function lowStock(items, threshold = 5) {
  return items.filter(item => item.qty < threshold).map(item => item.sku);
}
`,
  'src/format.js': `/** Format a dollar amount like $1,234.50 (negative amounts as -$5.00). */
export function formatCurrency(amount) {
  const fixed = amount.toFixed(2);
  const [whole, cents] = fixed.split('.');
  const grouped = whole.length > 3 && whole.length <= 6 ? whole.slice(0, -3) + ',' + whole.slice(-3) : whole;
  return '$' + grouped + '.' + cents;
}
`,
  'test/inventory.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import {totalValue, lowStock} from '../src/inventory.js';

${filler}

test('fractional prices are summed exactly', () => {
  assert.equal(totalValue([{price: 0.5, qty: 3}, {price: 2.25, qty: 2}]), 6);
});

test('low stock lists skus under the threshold', () => {
  assert.deepEqual(lowStock([{sku: 'a', qty: 1}, {sku: 'b', qty: 9}, {sku: 'c', qty: 4}]), ['a', 'c']);
});
`,
  'test/format.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import {formatCurrency} from '../src/format.js';

test('groups thousands', () => assert.equal(formatCurrency(1234.5), '$1,234.50'));
test('small amounts', () => assert.equal(formatCurrency(7), '$7.00'));
test('negative amounts put the sign first', () => assert.equal(formatCurrency(-5), '-$5.00'));
test('millions', () => assert.equal(formatCurrency(1234567.891), '$1,234,567.89'));
`,
};

export default {
  id: 'noisy-tests',
  category: 'debugging under noisy output',
  prompt: '`npm test` fails in this project. Make the whole test suite pass by fixing the source code. Do not modify, delete or skip anything under test/.',
  setup: root => gitRepo(root, [['Initial inventory project', files]]),
  solve: root => writeTree(root, {
    'src/inventory.js': files['src/inventory.js'].replace('total += Math.floor(item.price * item.qty);', 'total += item.price * item.qty;'),
    'src/format.js': `export function formatCurrency(amount) {
  const [whole, cents] = Math.abs(amount).toFixed(2).split('.');
  return (amount < 0 ? '-' : '') + '$' + whole.replace(/\\B(?=(\\d{3})+$)/g, ',') + '.' + cents;
}
`}),
  verify(root, before) {
    const suite = npm(root, 'test');
    const hidden = hiddenTests(root, `import test from 'node:test';
import assert from 'node:assert/strict';
const {totalValue} = await import('@ROOT@src/inventory.js');
const {formatCurrency} = await import('@ROOT@src/format.js');
test('totals', () => { assert.equal(totalValue([{price: 19.99, qty: 3}]), 59.97); assert.equal(totalValue([]), 0); });
test('currency', () => {
  assert.equal(formatCurrency(0), '$0.00');
  assert.equal(formatCurrency(999.999), '$1,000.00');
  assert.equal(formatCurrency(-1234567), '-$1,234,567.00');
  assert.equal(formatCurrency(1000000000), '$1,000,000,000.00');
  assert.equal(formatCurrency(-0.5), '-$0.50');
});`);
    return verdict({tests_unchanged: unchanged(before, root, 'test/'), suite_passes: suite.status === 0, hidden_cases: hidden.pass},
      {hidden: hidden.output});
  },
};
