import {gitRepo, npm, unchanged, verdict, writeTree} from '../lib.mjs';

const tests = {
  'test/slug.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import {slugify} from '../src/slug.js';
test('lowercases and joins words', () => assert.equal(slugify('Hello World'), 'hello-world'));
test('drops punctuation', () => assert.equal(slugify('Rock & Roll!'), 'rock-roll'));
test('strips accents', () => assert.equal(slugify('Crème Brûlée'), 'creme-brulee'));
test('collapses separators', () => assert.equal(slugify('  a -- b__c  '), 'a-b-c'));
`,
  'test/truncate.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import {truncate} from '../src/util.js';
test('keeps short text', () => assert.equal(truncate('abc', 5), 'abc'));
test('adds an ellipsis', () => assert.equal(truncate('abcdefgh', 5), 'abcd…'));
`,
};

export default {
  id: 'esm-config',
  category: 'broken project configuration',
  prompt: '`npm test` is broken in this project. Fix the project so that `npm test` runs every test file in test/ and they all pass. Do not modify the files in test/.',
  setup: root => gitRepo(root, [['Slug library', {
    'package.json': JSON.stringify({name: 'sluggo', version: '0.3.0', type: 'module', scripts: {test: 'node --test tests/*.test.js'}}, null, 2) + '\n',
    'src/slug.js': `const {collapse} = require('./util.js');

function slugify(text) {
  return collapse(text.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
}

module.exports = {slugify};
`,
    'src/util.js': `function collapse(text) {
  return text.replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function truncate(text, max) {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

module.exports = {collapse, truncate};
`,
    ...tests}]]),
  solve: root => writeTree(root, {
    'package.json': JSON.stringify({name: 'sluggo', version: '0.3.0', type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
    'src/slug.js': `import {collapse} from './util.js';\nexport function slugify(text) {\n  return collapse(text.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-'));\n}\n`,
    'src/util.js': `export function collapse(text) {\n  return text.replace(/-+/g, '-').replace(/^-|-$/g, '');\n}\nexport function truncate(text, max) {\n  return text.length <= max ? text : text.slice(0, max - 1) + '…';\n}\n`,
  }),
  verify(root, before) {
    const suite = npm(root, 'test');
    const output = suite.stdout + suite.stderr;
    const passed = Number(/(?:#|ℹ) pass (\d+)/.exec(output)?.[1] ?? 0), failed = Number(/(?:#|ℹ) fail (\d+)/.exec(output)?.[1] ?? -1);
    return verdict({tests_unchanged: unchanged(before, root, 'test/'), suite_passes: suite.status === 0, all_six_tests_ran: passed === 6 && failed === 0},
      {testsPassed: passed, testsFailed: failed, tail: output.slice(-800)});
  },
};
