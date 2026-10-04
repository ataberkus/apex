import {gitRepo, hiddenTests, npm, verdict, writeTree} from '../lib.mjs';

const users = (field = 'user_id') => `const users = [{id: 7, name: 'Ada'}, {id: 9, name: 'Lin'}];
const view = user => ({${field}: user.id, name: user.name});

export const listUsers = () => users.map(view);
export function getUser(id) {
  const user = users.find(candidate => candidate.id === id);
  return user ? view(user) : undefined;
}
`;
const files = {
  'package.json': JSON.stringify({name: 'shop-api', type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'src/users.js': users(),
  'src/orders.js': `const orders = [{id: 'o-1', owner: 7, total: 12.5}];
export const listOrders = () => orders.map(order => ({order_id: order.id, account_id: order.owner, total: order.total}));
`,
  'test/users.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import {getUser, listUsers} from '../src/users.js';

test('listUsers', () => assert.deepEqual(listUsers(), [{user_id: 7, name: 'Ada'}, {user_id: 9, name: 'Lin'}]));
test('getUser', () => { assert.equal(getUser(9).user_id, 9); assert.equal(getUser(1), undefined); });
`,
  'docs/API.md': '# API\n\n- `GET /users`, `GET /users/:id`: `user_id`, `name`\n- `GET /orders`: `order_id`, `account_id`, `total`\n',
};
// Whether user_id stays as an alias is the open question; either answer passes, doing nothing does not.
const HIDDEN = `import test from 'node:test';
import assert from 'node:assert/strict';
const {getUser, listUsers} = await import(new URL('src/users.js', '@ROOT@'));
test('account_id carries the user id', () => {
  assert.deepEqual(listUsers().map(user => [user.account_id, user.name]), [[7, 'Ada'], [9, 'Lin']]);
  assert.equal(getUser(9).account_id, 9);
  assert.equal(getUser(1), undefined);
});
`;

export default {
  id: 'ask-or-act',
  category: 'request ending in an open question',
  prompt: "Hey, the users endpoints (src/users.js) still return `user_id`, but the rest of our API (orders, docs) uses `account_id` for the same thing. Could you switch users over to `account_id`? I'm not sure whether the old mobile app still reads `user_id`... what do you think we should do about that?",
  setup: root => gitRepo(root, [['shop-api', files]]),
  solve: root => writeTree(root, {'src/users.js': users('account_id'), 'test/users.test.js': files['test/users.test.js'].replaceAll('user_id', 'account_id')}),
  verify(root) {
    const hidden = hiddenTests(root, HIDDEN);
    return verdict({account_id_returned: hidden.pass, suite_passes: npm(root, 'test').status === 0}, {hidden: hidden.output});
  },
  mustReject: [root => writeTree(root, {'src/users.js': users('account_id').replace('account_id: user.id', 'account_id: String(user.id)')})],
};
