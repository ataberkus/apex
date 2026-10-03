import {gitRepo, hiddenTests, npm, read, verdict, writeTree} from '../lib.mjs';

const PROMPT = `Release version 1.3.0 of this stats library with a new mode() function. All of the following are required:

1. Add mode(values) to src/stats.js: it returns the most frequent number in the array; when several values tie, return the smallest of them; for an empty array, throw a RangeError with the message "mode of empty array".
2. Export mode from src/index.js as well.
3. Add at least three tests for mode to test/stats.test.js, including the tie and empty-array cases.
4. Document mode in README.md as a new bullet in the existing "## API" section, in the same style as the other bullets.
5. Add a "## 1.3.0" section at the top of CHANGELOG.md (above 1.2.0) with a bullet that mentions mode.
6. Bump the version in package.json from 1.2.0 to 1.3.0.

\`npm test\` must pass.`;

const files = {
  'package.json': JSON.stringify({name: 'tinystats', version: '1.2.0', type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'src/stats.js': `export function mean(values) {
  if (!values.length) throw new RangeError('mean of empty array');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values) {
  if (!values.length) throw new RangeError('median of empty array');
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
`,
  'src/index.js': `export {mean, median} from './stats.js';\n`,
  'test/stats.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import {mean, median} from '../src/stats.js';

test('mean', () => assert.equal(mean([1, 2, 3, 4]), 2.5));
test('median odd', () => assert.equal(median([3, 1, 2]), 2));
test('median even', () => assert.equal(median([4, 1, 3, 2]), 2.5));
test('empty throws', () => assert.throws(() => mean([]), RangeError));
`,
  'README.md': `# tinystats

Tiny descriptive statistics.

## API

- \`mean(values)\` — arithmetic mean; throws RangeError for an empty array.
- \`median(values)\` — middle value (average of the two middle values for even lengths); throws RangeError for an empty array.

## License

MIT
`,
  'CHANGELOG.md': `# Changelog

## 1.2.0

- Add median.

## 1.1.0

- Add mean.
`,
};

export default {
  id: 'multi-deliverable',
  category: 'many explicit requirements',
  prompt: PROMPT,
  setup: root => gitRepo(root, [['tinystats 1.2.0', files]]),
  solve(root) {
    writeTree(root, {
      'src/stats.js': files['src/stats.js'] + `
export function mode(values) {
  if (!values.length) throw new RangeError('mode of empty array');
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best;
  for (const [value, count] of counts) if (best === undefined || count > counts.get(best) || (count === counts.get(best) && value < best)) best = value;
  return best;
}
`,
      'src/index.js': `export {mean, median, mode} from './stats.js';\n`,
      'test/stats.test.js': files['test/stats.test.js'].replace("import {mean, median}", "import {mean, median, mode}") +
        "test('mode', () => assert.equal(mode([1, 2, 2, 3]), 2));\ntest('mode tie', () => assert.equal(mode([3, 1, 3, 1]), 1));\ntest('mode empty', () => assert.throws(() => mode([]), RangeError));\n",
      'README.md': files['README.md'].replace('\n\n## License', '\n- `mode(values)` — most frequent value (smallest on ties); throws RangeError for an empty array.\n\n## License'),
      'CHANGELOG.md': files['CHANGELOG.md'].replace('## 1.2.0', '## 1.3.0\n\n- Add mode.\n\n## 1.2.0'),
      'package.json': files['package.json'].replace('1.2.0', '1.3.0'),
    });
  },
  verify(root) {
    const suite = npm(root, 'test');
    const passed = Number(/(?:#|ℹ) pass (\d+)/.exec(suite.stdout + suite.stderr)?.[1] ?? 0);
    const hidden = hiddenTests(root, `import test from 'node:test';
import assert from 'node:assert/strict';
const stats = await import('@ROOT@src/stats.js');
const index = await import('@ROOT@src/index.js');
test('mode', () => {
  assert.equal(stats.mode([5]), 5);
  assert.equal(stats.mode([1, 2, 2, 3, 3, 3]), 3);
  assert.equal(stats.mode([4, 4, 2, 2, 9]), 2);
  assert.equal(stats.mode([-1, -3, -1, -3, 0]), -3);
  assert.throws(() => stats.mode([]), {name: 'RangeError', message: 'mode of empty array'});
  assert.equal(index.mode([7, 7, 1]), 7);
  assert.equal(index.mean([2, 4]), 3);
});`);
    const tests = read(root, 'test/stats.test.js'), readme = read(root, 'README.md').replace(/\r\n/g, '\n');
    const changelog = read(root, 'CHANGELOG.md').replace(/\r\n/g, '\n');
    const api = readme.slice(readme.indexOf('## API'), readme.indexOf('## License'));
    const top = changelog.indexOf('## 1.3.0'), next = changelog.indexOf('## 1.2.0');
    return verdict({
      mode_correct_and_exported: hidden.pass,
      tests_added: (tests.match(/mode\(/g) ?? []).length >= 3 && passed >= 7,
      readme_api_bullet: /^- `mode\(/m.test(api),
      changelog_entry: top > 0 && top < next && /mode/.test(changelog.slice(top, next)),
      version_bumped: JSON.parse(read(root, 'package.json')).version === '1.3.0',
      suite_passes: suite.status === 0,
    }, {hidden: hidden.output});
  },
};
