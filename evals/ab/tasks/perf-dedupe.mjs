import {gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

const SLOW = `/**
 * Group records that share an email address.
 * Emails are compared after trimming and lower-casing; records without a
 * usable email (missing, not a string, or blank after trimming) are ignored.
 * Returns [{email, ids}] for every email used by two or more records, ordered
 * by the first appearance of each email; ids keep input order (duplicates included).
 */
export function findDuplicates(records) {
  const groups = [];
  for (let i = 0; i < records.length; i++) {
    const email = typeof records[i].email === 'string' ? records[i].email.trim().toLowerCase() : '';
    if (!email) continue;
    if (groups.some(group => group.email === email)) continue;
    const ids = [];
    for (let j = 0; j < records.length; j++) {
      const other = typeof records[j].email === 'string' ? records[j].email.trim().toLowerCase() : '';
      if (other === email) ids.push(records[j].id);
    }
    if (ids.length > 1) groups.push({email, ids});
  }
  return groups;
}
`;
const FAST = SLOW.slice(0, SLOW.indexOf('export function')) + `export function findDuplicates(records) {
  const map = new Map();
  for (const record of records) {
    const email = typeof record.email === 'string' ? record.email.trim().toLowerCase() : '';
    if (!email) continue;
    if (!map.has(email)) map.set(email, []);
    map.get(email).push(record.id);
  }
  return [...map].filter(([, ids]) => ids.length > 1).map(([email, ids]) => ({email, ids}));
}
`;

export default {
  id: 'perf-dedupe',
  category: 'performance fix preserving semantics',
  prompt: 'findDuplicates in src/dedupe.js is far too slow on large inputs: 200,000 records must finish in well under one second. Make it fast without changing its results in any way (same groups, same order, same edge-case behaviour as documented and as currently implemented). Keep the existing tests in test/ passing and unchanged.',
  setup: root => gitRepo(root, [['Dedupe module', {
    'package.json': JSON.stringify({type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
    'src/dedupe.js': SLOW,
    'test/dedupe.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import {findDuplicates} from '../src/dedupe.js';
test('groups by normalized email', () => {
  assert.deepEqual(findDuplicates([{id: 1, email: 'A@x.io'}, {id: 2, email: 'b@x.io'}, {id: 3, email: ' a@x.io '}]), [{email: 'a@x.io', ids: [1, 3]}]);
});
test('ignores blank emails', () => assert.deepEqual(findDuplicates([{id: 1, email: ' '}, {id: 2, email: ' '}, {id: 3}]), []));
`}]]),
  // The prompt protects the existing tests; a new regression test beside them is allowed.
  solve: root => writeTree(root, {'src/dedupe.js': FAST, 'test/dedupe.regression.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import {findDuplicates} from '../src/dedupe.js';
test('keeps first-appearance order', () => assert.deepEqual(findDuplicates([{id: 1, email: 'b'}, {id: 2, email: 'a'}, {id: 3, email: 'a'}, {id: 4, email: 'b'}]),
  [{email: 'b', ids: [1, 4]}, {email: 'a', ids: [2, 3]}]));
`}),
  // Applied after the reference fix; the verifier must still fail. An emptied test file keeps the suite green.
  mustReject: [root => writeTree(root, {'test/dedupe.test.js': '// emptied\n'})],
  verify(root, before) {
    const suite = npm(root, 'test');
    const hidden = hiddenTests(root, `import test from 'node:test';
import assert from 'node:assert/strict';
const {findDuplicates} = await import('@ROOT@src/dedupe.js');
const reference = ${new Function('return ' + SLOW.slice(SLOW.indexOf('export function') + 7))().toString()};
let seed = 42; const rand = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
const makeRecords = (n, pool) => Array.from({length: n}, (_, i) => {
  const kind = rand(20);
  if (kind === 0) return {id: i};
  if (kind === 1) return {id: i, email: 42};
  if (kind === 2) return {id: i, email: '   '};
  const base = 'user' + rand(pool) + '@example.com';
  return {id: rand(5) === 0 ? 'dup' : i, email: rand(3) === 0 ? '  ' + base.toUpperCase() + ' ' : base};
});
test('matches the original on random inputs', () => {
  for (const [n, pool] of [[0, 1], [1, 1], [50, 10], [500, 300], [2000, 5000]]) {
    const records = makeRecords(n, pool);
    assert.deepEqual(findDuplicates(records), reference(records));
  }
});
test('200k records in under a second', () => {
  // A quadratic implementation would take minutes at 200k; fail it fast on a smaller probe.
  let start = performance.now(); findDuplicates(makeRecords(5000, 4000));
  assert.ok(performance.now() - start < 250, 'already slow at 5,000 records: ' + Math.round(performance.now() - start) + ' ms');
  const records = makeRecords(200000, 150000);
  start = performance.now(); findDuplicates(records); const elapsed = performance.now() - start;
  assert.ok(elapsed < 1000, 'took ' + Math.round(elapsed) + ' ms');
});`);
    return verdict({existing_tests_unchanged: unchanged(before, root, 'test/', {allowAdded: true}), suite_passes: suite.status === 0, fast_and_equivalent: hidden.pass},
      {hidden: hidden.output});
  },
};
