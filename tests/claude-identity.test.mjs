import assert from 'node:assert/strict';
import test from 'node:test';
import {patchPayload, patchSystemBlock} from '../extensions/apex-router/claude-identity.mjs';
import apexClaudeIdentity from '../extensions/apex-router/claude-identity.mjs';

// Pi's stock <docs> section carries the two flagged sequences (see the extension header).
const DOCS = 'Pi documentation (read only when the user asks about pi itself, its SDK):\n'
  + '- When asked about: custom providers (docs/custom-provider.md), pi packages (docs/packages.md)\n'
  + '- When working on pi topics, read the docs and follow .md cross-references before implementing';

test('flagged docs sequences are rewritten, meaning preserved', () => {
  const patched = patchSystemBlock({type: 'text', text: DOCS});
  assert.ok(!patched.text.includes('(docs/custom-provider.md)') && !patched.text.includes('(docs/packages.md)'));
  assert.ok(!patched.text.includes('cross-references before implementing'));
  assert.ok(patched.text.includes('custom providers docs/custom-provider.md'));
  assert.ok(patched.text.includes('pi packages docs/packages.md'));
  assert.ok(patched.text.includes('cross references before implementing'));
});

test('payloads without flagged sequences pass through untouched', () => {
  const block = {type: 'text', text: 'Be helpful.'};
  assert.equal(patchSystemBlock(block), block);
  assert.equal(patchSystemBlock({type: 'image'}).type, 'image');
  const payload = {model: 'x', system: [block]};
  assert.equal(patchPayload(payload), payload);
  assert.equal(patchPayload({model: 'x'}).model, 'x');
  assert.equal(patchPayload(undefined), undefined);
});

test('the hook patches the payload in place of the request', async () => {
  let handler;
  apexClaudeIdentity({on: (event, fn) => { assert.equal(event, 'before_provider_request'); handler = fn; }});
  const payload = {system: [{type: 'text', text: 'You are Claude Code.'}, {type: 'text', text: DOCS}]};
  const patched = await handler({payload});
  assert.equal(patched.system[0].text, 'You are Claude Code.');
  assert.ok(!patched.system[1].text.includes('(docs/packages.md)'));
});
