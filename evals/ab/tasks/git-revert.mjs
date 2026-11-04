import {git, gitRepo, npm, read, verdict} from '../lib.mjs';

const math = pow => `export const add = (a, b) => a + b;
export const mul = (a, b) => a * b;

/** Integer power for exponent >= 0. */
export function pow(base, exponent) {
  let result = 1;
  for (let i = ${pow}; i < exponent; i++) result *= base;
  return result;
}
`;
const history = [
  ['Add math helpers with tests', {
    'package.json': JSON.stringify({name: 'calc', type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
    'src/math.js': math(0),
    'test/math.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import {add, mul, pow} from '../src/math.js';
test('add', () => assert.equal(add(2, 3), 5));
test('mul', () => assert.equal(mul(4, 5), 20));
test('pow', () => { assert.equal(pow(2, 10), 1024); assert.equal(pow(7, 0), 1); });
`,
    'README.md': '# calc\n\nSmall math helpers.\n'}],
  ['Document helpers in README', {'README.md': '# calc\n\nSmall math helpers: add, mul, pow.\n'}],
  ['Tidy pow loop', {'src/math.js': math(1)}],
  ['Add clamp helper', {
    'src/clamp.js': 'export const clamp = (value, low, high) => Math.min(high, Math.max(low, value));\n',
    'test/clamp.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import {clamp} from '../src/clamp.js';
test('clamp', () => { assert.equal(clamp(5, 0, 3), 3); assert.equal(clamp(-1, 0, 3), 0); });
`}],
  ['Mention clamp in README', {'README.md': '# calc\n\nSmall math helpers: add, mul, pow, clamp.\n'}],
];

export default {
  id: 'git-revert',
  category: 'git history investigation',
  prompt: 'This repository\'s test suite (`npm test`) passed at the first commit but fails now. Find the commit that introduced the failure and undo it with `git revert`, as exactly one new commit on top of the current branch. Do not rewrite or drop any existing commits and do not change anything else. Afterwards `npm test` must pass and `git status` must show a clean working tree.',
  setup(root) {
    gitRepo(root, history);
    this.heads ??= new Map();
    this.heads.set(root, git(root, 'rev-parse', 'HEAD').stdout.trim());
  },
  solve(root) {
    const bad = git(root, 'log', '--format=%H', '--grep', 'Tidy pow loop').stdout.trim();
    git(root, 'revert', '--no-edit', bad);
  },
  verify(root) {
    const original = this.heads.get(root);
    const bad = git(root, 'log', '--format=%H', '--grep', '^Tidy pow loop$').stdout.trim().split('\n').at(-1);
    const parent = git(root, 'rev-parse', 'HEAD^').stdout.trim();
    const message = git(root, 'log', '-1', '--format=%B').stdout;
    const changed = git(root, 'diff', '--name-only', 'HEAD^', 'HEAD').stdout.trim().split('\n').filter(Boolean);
    // Tool state (.apex/) is ignored here; anything else untracked or modified counts as dirty.
    const status = git(root, 'status', '--porcelain', '--untracked-files=all').stdout.split('\n')
      .filter(line => line.trim() && !line.slice(3).startsWith('.apex/'));
    const suite = npm(root, 'test');
    return verdict({
      one_new_commit_on_original_head: parent === original,
      is_revert_of_bad_commit: /^Revert /.test(message) && message.includes(bad),
      only_math_reverted: changed.length === 1 && changed[0] === 'src/math.js' && read(root, 'src/math.js').replace(/\r\n/g, '\n') === math(0),
      later_commits_kept: read(root, 'README.md').includes('clamp') && read(root, 'src/clamp.js').includes('clamp'),
      clean_tree: status.length === 0,
      suite_passes: suite.status === 0,
    }, {status, changed});
  },
};
