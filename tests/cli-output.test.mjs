import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {createStyle} from '../lib/cli-style.mjs';
import {formatSessionReport} from '../lib/commands.mjs';
import {formatHelp} from '../lib/help.mjs';
import {readSessionReport} from '../lib/session-report.mjs';

const header = {type: 'session', version: 3, id: 'cli-output-fixture', timestamp: '2026-10-01T00:00:00Z', cwd: path.resolve('/fixture')};
const usage = {input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25}};
const row = (id, parentId, message) => ({type: 'message', id, parentId, timestamp: header.timestamp, message});
const longId = 'entry-' + 'x'.repeat(300) + '\x1b[31m';

async function sessionFile(t) {
  const dir = await mkdtemp(path.join(process.cwd(), '.cli-output-fixture-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'session.jsonl');
  const rows = [header, row('user', null, {role: 'user', content: 'question'}),
    row(longId, 'user', {role: 'assistant', provider: 'fixture', model: 'model', usage, stopReason: 'toolUse',
      content: [{type: 'toolCall', id: 'call-1', name: 'read', arguments: {path: 'a'.repeat(400)}}]})];
  await writeFile(file, rows.map(value => JSON.stringify(value)).join('\n') + '\n');
  return file;
}

const tty = (columns, colors = true) => ({isTTY: true, columns, hasColors: () => colors, getColorDepth: () => 24});
const strip = text => text.replace(/\x1b\[[0-9;]*m/g, '');
const width = line => [...line].length;

test('piped help and report are plain ASCII without escape codes, and --json stays raw JSON', async t => {
  const file = await sessionFile(t);
  const env = {...process.env, FORCE_COLOR: '1'};
  for (const args of [['--apex-help'], ['report', file]]) {
    const result = spawnSync(process.execPath, ['bin/apex', ...args], {encoding: 'utf8', env});
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /[^\x00-\x7f]/);
  }
  const report = spawnSync(process.execPath, ['bin/apex', 'report', file], {encoding: 'utf8', env}).stdout;
  assert.match(report, /^Apex session report$/m);
  assert.match(report, /^ {2}Native estimate {2}\$0\.250000 \(estimate, not invoice\)$/m);
  assert.match(report, /^ {2}1 pending tool call; replay is never performed by inspection\.$/m);
  assert.ok(report.includes('entry-' + 'x'.repeat(300) + '?[31m'), 'plain output keeps full entry IDs with control characters neutralized');
  const json = spawnSync(process.execPath, ['bin/apex', 'report', file, '--json'], {encoding: 'utf8', env});
  assert.equal(JSON.parse(json.stdout).header.id, 'cli-output-fixture');
});

test('errors keep the bare message on a pipe', () => {
  const result = spawnSync(process.execPath, ['bin/apex', 'report'], {encoding: 'utf8', env: {...process.env, FORCE_COLOR: '1'}});
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'report requires a session file\n');
});

test('NO_COLOR and TERM=dumb force plain output even on a color terminal', () => {
  for (const env of [{NO_COLOR: '1'}, {TERM: 'dumb'}]) {
    const style = createStyle(tty(120), env);
    assert.equal(style.rich, false);
    assert.doesNotMatch(formatHelp(style), /\x1b|[^\x00-\x7f]/);
  }
  assert.equal(createStyle(tty(120, false), {}).rich, false);
  assert.equal(createStyle({isTTY: false, columns: 120, hasColors: () => true, getColorDepth: () => 24}, {}).rich, false);
});

test('rich report frame and help fit narrow terminals and neutralize session control characters', async t => {
  const report = await readSessionReport(await sessionFile(t));
  for (const columns of [30, 52, 200]) {
    const style = createStyle(tty(columns), {});
    assert.equal(style.rich, true);
    const framed = formatSessionReport(report, style);
    assert.doesNotMatch(framed, /\x1b(?!\[[0-9;]*m)/, 'only SGR color sequences are emitted');
    const lines = strip(framed).split('\n');
    assert.ok(lines[0].startsWith('╭─ Apex session report') && lines.at(-1).startsWith('╰'));
    assert.equal(new Set(lines.map(width)).size, 1, `every frame line has one width at ${columns} columns`);
    assert.ok(width(lines[0]) <= columns - 1);
    for (const line of strip(formatHelp(style)).split('\n')) assert.ok(width(line) <= columns - 1, line);
  }
});
