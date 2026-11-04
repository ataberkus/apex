import {gitRepo, hiddenTests, npm, projectFiles, read, verdict, writeTree} from '../lib.mjs';

const modules = ['profile', 'greeting', 'invoice', 'audit', 'mailer', 'badge', 'search', 'report', 'avatar', 'session'];
const moduleSource = (name, fn) => `import {${fn}} from './users.js';

/** ${name} view helpers. */
export function ${name}Label(user) {
  return '${name}: ' + ${fn}(user);
}

export function ${name}Many(users) {
  return users.map(user => ${fn}(user)).join(', ');
}
`;
const users = fn => `/** Display name for a user record: "First Last", or the handle when no name is set. */
export function ${fn}(user) {
  const name = [user.first, user.last].filter(Boolean).join(' ');
  return name || '@' + user.handle;
}
`;
const files = fn => ({
  'package.json': JSON.stringify({name: 'people', type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'src/users.js': users(fn),
  ...Object.fromEntries(modules.map(name => [`src/${name}.js`, moduleSource(name, fn)])),
  'src/index.js': `export {${fn}} from './users.js';\n` + modules.map(name => `export * from './${name}.js';`).join('\n') + '\n',
  'test/users.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import {${fn}, profileLabel, sessionMany} from '../src/index.js';

test('${fn} joins first and last', () => assert.equal(${fn}({first: 'Ada', last: 'Lovelace'}), 'Ada Lovelace'));
test('${fn} falls back to the handle', () => assert.equal(${fn}({handle: 'ada'}), '@ada'));
test('modules use ${fn}', () => {
  assert.equal(profileLabel({first: 'Ada'}), 'profile: Ada');
  assert.equal(sessionMany([{handle: 'a'}, {first: 'B'}]), '@a, B');
});
`,
  'README.md': `# people\n\nCall \`${fn}(user)\` to get the name to show for a user. Every view module (profile, greeting, ...) uses ${fn} internally.\n`,
  'docs/api.md': `## ${fn}(user)\n\nReturns "First Last" or "@handle".\n\nSee also: ${fn} is re-exported from src/index.js.\n`,
});

export default {
  id: 'rename',
  category: 'multi-file refactor',
  prompt: 'Rename the function getUserName to getDisplayName everywhere in this project: source, tests and docs. Keep backward compatibility with a deprecated alias, so `import {getUserName} from "./src/users.js"` (and from src/index.js) still works and behaves the same. Apart from that alias in src/users.js and its re-export in src/index.js, no file may still mention getUserName. `npm test` must pass.',
  setup: root => gitRepo(root, [['People project', files('getUserName')]]),
  solve(root) {
    writeTree(root, files('getDisplayName'));
    writeTree(root, {'src/users.js': users('getDisplayName') + '\n/** @deprecated Use getDisplayName. */\nexport const getUserName = getDisplayName;\n',
      'src/index.js': read(root, 'src/index.js').replace("export {getDisplayName} from './users.js';", "export {getDisplayName, getUserName} from './users.js';")});
  },
  verify(root) {
    const mentions = projectFiles(root).filter(name => read(root, name).includes('getUserName'));
    const suite = npm(root, 'test');
    const hidden = hiddenTests(root, `import test from 'node:test';
import assert from 'node:assert/strict';
const users = await import('@ROOT@src/users.js');
const index = await import('@ROOT@src/index.js');
test('new name and alias', () => {
  assert.equal(users.getDisplayName({first: 'Grace', last: 'Hopper'}), 'Grace Hopper');
  assert.equal(users.getUserName({handle: 'g'}), '@g');
  assert.equal(index.getDisplayName({handle: 'x'}), '@x');
  assert.equal(index.getUserName({first: 'Y'}), 'Y');
  assert.equal(index.avatarLabel({first: 'Z'}), 'avatar: Z');
});`);
    const tests = read(root, 'test/users.test.js'), readme = read(root, 'README.md'), api = read(root, 'docs/api.md');
    return verdict({
      only_alias_mentions_old_name: mentions.every(name => ['src/users.js', 'src/index.js'].includes(name)),
      docs_and_tests_renamed: [tests, readme, api].every(text => text.includes('getDisplayName')),
      modules_use_new_name: modules.every(name => read(root, `src/${name}.js`).includes('getDisplayName')),
      suite_passes: suite.status === 0, alias_works: hidden.pass,
    }, {mentions, hidden: hidden.output});
  },
};
