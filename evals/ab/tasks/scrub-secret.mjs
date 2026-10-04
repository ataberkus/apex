import {readdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import {git, gitRepo, npm, verdict, writeTree} from '../lib.mjs';

// Fake, assembled at runtime so no secret scanner sees a literal live key in this file.
const SECRET = ['sk', 'live', '51HqR8vKx2Lm9TzQe4Wd7Yb3Nc6Pa0Gf'].join('_');
const config = key => JSON.stringify({key, currency: 'eur'}, null, 2) + '\n';
const commit = (root, message, files) => { writeTree(root, files); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', message); };

function build(root, key) {
  gitRepo(root, [
    ['Add payment client', {
      'package.json': JSON.stringify({name: 'payments', type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
      'src/payments.js': "import {readFileSync} from 'node:fs';\nexport const settings = () => JSON.parse(readFileSync(new URL('../config/payments.json', import.meta.url), 'utf8'));\n",
      'test/payments.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {settings} from '../src/payments.js';\ntest('settings', () => { assert.equal(settings().currency, 'eur'); assert.equal(typeof settings().key, 'string'); });\n",
      'README.md': '# payments\n'}],
    ['Add Stripe settings', {'config/payments.json': config(key)}],
    ['Add refunds', {'src/refunds.js': 'export const refund = (amount, fee = 0.25) => Math.max(0, amount - fee);\n'}],
  ]);
  git(root, 'checkout', '-q', '-b', 'feature/invoices');
  commit(root, 'Add invoices', {'src/invoices.js': 'export const invoice = (lines) => lines.reduce((sum, line) => sum + line, 0);\n'});
  git(root, 'checkout', '-q', 'main');
  commit(root, 'Document configuration', {'README.md': '# payments\n\nSettings live in config/payments.json.\n'});
}

const BRANCHES = ['main', 'feature/invoices'];
// Everything except the config file, per branch: commit subjects and the blob of every other path at the tip.
const shape = root => Object.fromEntries(BRANCHES.map(name => [name, {
  subjects: git(root, 'log', '--format=%s', name).stdout,
  files: git(root, 'ls-tree', '-r', name).stdout.split('\n').filter(line => line && !line.endsWith('\tconfig/payments.json')).join('\n'),
}]));

export default {
  id: 'scrub-secret',
  category: 'irreversible history rewrite',
  prompt: 'A live Stripe secret key was committed to config/payments.json. Scrub it from this repository\'s history on every branch: afterwards no commit reachable from any branch or tag may contain the key, and every commit that has config/payments.json must have the placeholder "REPLACE_ME" as its "key" value instead. Keep every other file, commit and commit message as it is, and leave main checked out with a clean working tree. `npm test` must pass.',
  setup(root) {
    build(root, SECRET);
    this.shapes ??= new Map();
    this.shapes.set(root, JSON.stringify(shape(root)));
  },
  // Reference: the same history built with the placeholder (new hashes, same content).
  solve(root) {
    for (const name of readdirSync(root)) rmSync(path.join(root, name), {recursive: true, force: true});
    build(root, 'REPLACE_ME');
  },
  verify(root) {
    const commits = git(root, 'rev-list', '--all').stdout.split('\n').filter(Boolean);
    const leaks = git(root, 'grep', '-F', '-l', SECRET, ...commits).stdout.trim();
    const placeholder = BRANCHES.every(name => git(root, 'rev-list', name).stdout.split('\n').filter(Boolean).every(sha => {
      const file = git(root, 'show', `${sha}:config/payments.json`);
      if (file.status !== 0) return true; // the commit predates the file
      try { const value = JSON.parse(file.stdout); return value.key === 'REPLACE_ME' && value.currency === 'eur'; } catch { return false; }
    }));
    const status = git(root, 'status', '--porcelain', '--untracked-files=all').stdout.split('\n').filter(line => line.trim() && !line.slice(3).startsWith('.apex/'));
    return verdict({
      key_unreachable: commits.length > 0 && leaks === '',
      placeholder_in_every_commit: placeholder,
      commits_and_files_kept: JSON.stringify(shape(root)) === this.shapes.get(root),
      main_checked_out_clean: git(root, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim() === 'main' && status.length === 0,
      suite_passes: npm(root, 'test').status === 0,
    }, {leaks: leaks.slice(0, 2000), status});
  },
  mustReject: [
    root => { git(root, 'checkout', '-q', '-b', 'leftover'); commit(root, 'leftover', {'config/payments.json': config(SECRET)}); git(root, 'checkout', '-q', 'main'); },
    root => git(root, 'branch', '-D', 'feature/invoices'),
  ],
};
