import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createCorpusTools, runProposer} from '../evolve/proposer.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'apex-proposer-tools-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const corpus = path.join(root, 'corpus'), output = path.join(root, 'output');
  await mkdir(corpus); await mkdir(output);
  await writeFile(path.join(corpus, 'raw.jsonl'), '{"text":"raw α evidence"}\n{"text":"second"}\n');
  const tools = await createCorpusTools(corpus, output);
  return {root, corpus, output, tool: name => tools.find(tool => tool.name === name)};
}

test('proposer reads exact raw pages, not summaries, with UTF-8 framing', async t => {
  const {tool} = await fixture(t);
  const page = JSON.parse((await tool('evolve_read').execute('one', {path: 'raw.jsonl', offset: 2, limit: 1})).content[0].text);
  assert.equal(page.text, '{"text":"second"}');
  assert.equal(page.offset, 2);
});

test('proposer refuses traversal, absolute OS paths, and links into hidden evaluator data', async t => {
  const {root, corpus, tool} = await fixture(t);
  for (const relative of ['../secret', '/proc/self/environ', 'C:\\secret', 'a/../../secret']) {
    await assert.rejects(tool('evolve_read').execute('one', {path: relative}));
  }
  const privateDir = path.join(root, 'private');
  await mkdir(privateDir); await writeFile(path.join(privateDir, 'heldout.jsonl'), 'DO_NOT_READ');
  await symlink(privateDir, path.join(corpus, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(tool('evolve_read').execute('one', {path: 'escape/heldout.jsonl'}), /links/);
  await assert.rejects(tool('evolve_list').execute('one', {path: 'escape'}), /links/);
});

test('listing is paginated without hiding later prior harness versions', async t => {
  const {corpus, tool} = await fixture(t);
  for (let n = 0; n < 102; n++) await writeFile(path.join(corpus, `version-${String(n).padStart(3, '0')}`), 'source');
  const first = JSON.parse((await tool('evolve_list').execute('one', {path: '.'})).content[0].text);
  const second = JSON.parse((await tool('evolve_list').execute('two', {path: '.', offset: 101})).content[0].text);
  assert.equal(first.more, true);
  assert.equal(second.more, false);
  assert.deepEqual(second.entries, ['version-099', 'version-100', 'version-101']);
});

test('concurrent submissions persist exactly one declared change', async t => {
  const {output, tool} = await fixture(t);
  const change = {kind: 'prompt', change: 'General verification', patch: 'patch text validated later by evaluator'};
  const replies = await Promise.allSettled([tool('evolve_submit').execute('one', change), tool('evolve_submit').execute('two', {...change, change: 'Second change'})]);
  assert.equal(replies.filter(reply => reply.status === 'fulfilled').length, 1);
  const saved = JSON.parse(await readFile(path.join(output, 'proposal.json'), 'utf8'));
  assert.equal(saved.change, replies[0].status === 'fulfilled' ? 'General verification' : 'Second change');
  assert.equal(saved.schema_version, 1);
});

test('unbounded raw pages and malformed proposals are refused', async t => {
  const {corpus, output, tool} = await fixture(t);
  await writeFile(path.join(corpus, 'long.jsonl'), 'x'.repeat(12001));
  await assert.rejects(tool('evolve_read').execute('one', {path: 'long.jsonl', limit: 1}), /12000 bytes/);
  for (const proposal of [{kind: 'code', change: '', patch: 'x'}, {kind: 'answer', change: 'wrong kind', patch: 'x'}, {kind: 'code', change: 'oversized', patch: 'x'.repeat(1048577)}]) {
    await assert.rejects(tool('evolve_submit').execute('one', proposal), /Invalid proposal/);
  }
  await assert.rejects(readFile(path.join(output, 'proposal.json')), /ENOENT/);
});

test('offline native proposer denies before SDK import, credential lookup or file allocation', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'apex-proposer-denial-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const corpus = path.join(root, 'does-not-exist');
  await assert.rejects(runProposer({authorization: {config: {paid_runs_enabled: false, execution_policy: 'offline-only'}, ledger: null, runId: 'denied'}, corpus, output: corpus}), /paid_runs_disabled/);
  await assert.rejects(readFile(path.join(corpus, 'proposer.jsonl')), /ENOENT/);
});
