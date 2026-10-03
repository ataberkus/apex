import assert from 'node:assert/strict';
import test from 'node:test';
import {chmod, mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createEditToolDefinition} from '@earendil-works/pi-coding-agent';
import {directoryLink, fileLink} from './fixtures/filesystem.mjs';

const load = () => import('../extensions/apex-core/control.mjs').catch(() => ({}));
async function moduleApi() {
  const api = await load();
  for (const name of ['prepareCorrectableArguments', 'correctToolCall', 'createLoopBreaker', 'createTimeTracker', 'createDiagnostics'])
    assert.equal(typeof api[name], 'function', `${name} implementation missing`);
  return api;
}
async function fixture(t) {
  const cwd = await mkdtemp(path.join(process.cwd(), '.core-control-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  return cwd;
}
const call = (toolName, input, id = 'call') => ({type: 'tool_call', toolName, input, toolCallId: id});
const result = (toolName, input, text, isError = false, id = 'result') =>
  ({type: 'tool_result', toolName, input, content: [{type: 'text', text}], isError, toolCallId: id});

test('pre-schema preparation supports aliases without mutating raw model arguments', async () => {
  const {prepareCorrectableArguments} = await moduleApi();
  const input = {file_path: 'file.txt', edits: [{old_string: 'a', new_string: 'b'}]};
  assert.deepEqual(prepareCorrectableArguments('edit', input), {path: 'file.txt', edits: [{oldText: 'a', newText: 'b'}]});
  assert.deepEqual(input, {file_path: 'file.txt', edits: [{old_string: 'a', new_string: 'b'}]});
  assert.throws(() => prepareCorrectableArguments('edit', {path: 'file', oldText: 'a', old_string: 'c', newText: 'b'}), /conflict/i);
  assert.deepEqual(prepareCorrectableArguments('bash', {cmd: 'echo ok'}), {command: 'echo ok'});
  assert.deepEqual(prepareCorrectableArguments('custom', {cmd: 3}), {cmd: 3});
});

test('correction mutates the native input object and supports nested sibling paths independently', async t => {
  const cwd = await fixture(t);
  await writeFile(path.join(cwd, 'one.txt'), 'one');
  await writeFile(path.join(cwd, 'two.txt'), 'two');
  const {correctToolCall} = await moduleApi();
  const first = call('read', {file_path: 'one.txt', start_line: 1, max_lines: 2}, 'p/1');
  first.parentToolCallId = 'p';
  const second = call('write', {filePath: 'two.txt', text: 'new'}, 'p/2');
  second.parentToolCallId = 'p';
  const firstInput = first.input;
  const secondInput = second.input;
  assert.deepEqual(await Promise.all([correctToolCall(first, {cwd}), correctToolCall(second, {cwd})]), [undefined, undefined]);
  assert.equal(first.input, firstInput);
  assert.equal(second.input, secondInput);
  assert.deepEqual(first.input, {path: path.join(cwd, 'one.txt'), offset: 1, limit: 2});
  assert.deepEqual(second.input, {path: path.join(cwd, 'two.txt'), content: 'new'});
  assert.equal(await readFile(path.join(cwd, 'two.txt'), 'utf8'), 'two');
});

test('conflicting aliases and invalid post-hook native argument types block without partial mutation', async t => {
  const cwd = await fixture(t);
  const {correctToolCall} = await moduleApi();
  for (const [name, input] of [
    ['read', {path: 'one', file_path: 'two'}], ['bash', {command: 'echo ok', cmd: 'echo bad'}],
    ['write', {path: 'one', content: 5}], ['read', {path: 'one', offset: 0}],
    ['grep', {pattern: 'x', ignoreCase: 'yes'}], ['edit', {path: 'one', edits: [{oldText: 'a', newText: 2}]}],
  ]) {
    const event = call(name, input);
    const original = structuredClone(input);
    const blocked = await correctToolCall(event, {cwd});
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /conflict|must|requires|invalid/i);
    assert.deepEqual(input, original);
  }
});

test('confinement rejects lexical escapes, existing symlinks and dangling symlink writes', async t => {
  const cwd = await fixture(t);
  const outside = await fixture(t);
  await writeFile(path.join(outside, 'file.txt'), 'outside');
  await directoryLink(outside, path.join(cwd, 'external'));
  const {correctToolCall} = await moduleApi();
  for (const input of [{path: '../escape.txt', content: 'x'}, {path: 'external/file.txt', content: 'x'},
    {path: 'external/new/nested.txt', content: 'x'}, {path: '/tmp/outside.txt', content: 'x'}]) {
    const blocked = await correctToolCall(call('write', input), {cwd});
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /outside|confined/);
  }
  await t.test('dangling file symlink write refused', async t => {
    if (!await fileLink(t, path.join(outside, 'absent.txt'), path.join(cwd, 'dangling'))) return;
    const blocked = await correctToolCall(call('write', {path: 'dangling', content: 'x'}), {cwd});
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /outside|confined/);
  });
  await mkdir(path.join(cwd, 'inside'));
  await directoryLink(path.join(cwd, 'inside'), path.join(cwd, 'alias'));
  const insideAlias = call('write', {path: 'alias/new/nested.txt', content: 'x'});
  assert.equal(await correctToolCall(insideAlias, {cwd}), undefined);
  assert.equal(insideAlias.input.path, path.join(cwd, 'inside', 'new', 'nested.txt'));
  assert.equal(await readFile(path.join(outside, 'file.txt'), 'utf8'), 'outside');
});

test('confinement lets read, and only read, reach the packaged Apex skills outside cwd', async t => {
  const cwd = await fixture(t);
  const skill = path.resolve('skills', 'debugging', 'SKILL.md');
  const {correctToolCall} = await moduleApi();
  const read = call('read', {path: skill});
  assert.equal(await correctToolCall(read, {cwd}), undefined);
  assert.equal(read.input.path, skill);
  for (const event of [call('write', {path: skill, content: 'x'}), call('read', {path: path.resolve('package.json')}),
    call('read', {path: path.join(path.resolve('skills'), '..', 'package.json')})]) {
    const blocked = await correctToolCall(event, {cwd});
    assert.equal(blocked?.block, true);
    assert.match(blocked.reason, /outside|confined/);
  }
});

test('edit precondition accepts native multi-edit and native whitespace/BOM/CRLF modes without writing', async t => {
  const cwd = await fixture(t);
  const file = path.join(cwd, 'file.txt');
  const original = '\ufeffkeep  \r\nvalue = “old”  \r\nother\r\n';
  await writeFile(file, original);
  const {correctToolCall} = await moduleApi();
  const event = call('edit', {path: 'file.txt', edits: [{old_string: 'value = "old"\n', new_string: 'value = "new"\n'},
    {oldText: 'other', newText: 'OTHER'}]});
  assert.equal(await correctToolCall(event, {cwd}), undefined);
  assert.deepEqual(event.input.edits, [{oldText: 'value = "old"\n', newText: 'value = "new"\n'}, {oldText: 'other', newText: 'OTHER'}]);
  assert.equal(await readFile(file, 'utf8'), original);
  await createEditToolDefinition(cwd).execute('native', event.input, undefined, undefined, {cwd});
  assert.equal(await readFile(file, 'utf8'), '\ufeffkeep  \r\nvalue = "new"\r\nOTHER\r\n');
});

test('native legacy edit forms normalize but missing, ambiguous and overlapping regions block with bounded candidates', async t => {
  const cwd = await fixture(t);
  const file = path.join(cwd, 'file.txt');
  await writeFile(file, 'alpha = 1\nbeta = 2\nrepeat\nrepeat\n');
  const {correctToolCall} = await moduleApi();
  for (const edits of [{oldText: 'alpha', newText: 'ALPHA'}, JSON.stringify([{oldText: 'alpha', newText: 'ALPHA'}])])
    assert.equal(await correctToolCall(call('edit', {path: 'file.txt', edits}), {cwd}), undefined);
  const legacy = call('edit', {path: 'file.txt', old_string: 'beta', new_string: 'BETA'});
  assert.equal(await correctToolCall(legacy, {cwd}), undefined);
  assert.deepEqual(legacy.input.edits, [{oldText: 'beta', newText: 'BETA'}]);
  for (const edits of [[{oldText: 'alpha = 9', newText: 'x'}], [{oldText: 'repeat', newText: 'x'}],
    [{oldText: 'alpha', newText: 'x'}, {oldText: 'alpha = 1', newText: 'y'}]]) {
    const blocked = await correctToolCall(call('edit', {path: 'file.txt', edits}), {cwd});
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /Closest candidates/);
    assert.ok(Buffer.byteLength(blocked.reason) < 4000);
  }
  assert.equal(await readFile(file, 'utf8'), 'alpha = 1\nbeta = 2\nrepeat\nrepeat\n');
});

test('catastrophic confirmation occurs only in a real TUI and never in headless or RPC', async t => {
  const cwd = await fixture(t);
  const {correctToolCall} = await moduleApi();
  let confirmations = 0;
  const confirm = async () => { confirmations++; return false; };
  const command = () => call('bash', {cmd: 'rm -rf /'});
  for (const [ctx, options] of [[{cwd, mode: 'tui', hasUI: true}, {headless: true, confirm}],
    [{cwd, mode: 'rpc', hasUI: true}, {headless: false, confirm}], [{cwd, mode: 'tui', hasUI: false}, {headless: false, confirm}]])
    assert.equal(await correctToolCall(command(), ctx, options), undefined);
  assert.equal(confirmations, 0);
  assert.equal((await correctToolCall(command(), {cwd, mode: 'tui', hasUI: true}, {headless: false, confirm})).block, true);
  assert.equal(confirmations, 1);
  assert.equal(await correctToolCall(command(), {cwd, mode: 'tui', hasUI: true}, {headless: false, confirm: async () => true}), undefined);
  assert.equal(await correctToolCall(call('bash', {command: 'rm -f build/output.txt'}), {cwd, mode: 'tui', hasUI: true}, {headless: false, confirm}), undefined);
});

test('quoted root and expanded home operands require TUI confirmation across rm option forms', async t => {
  const cwd = await fixture(t);
  const {correctToolCall} = await moduleApi();
  const dangerous = [
    'rm -rf "/"', "rm -fr '/'", 'rm -Rf /', 'rm --recursive --force -- "/"',
    'rm -rf "$HOME"', 'rm -rf "${HOME}/"', 'sudo rm -rf -- "$HOME"',
    'sudo -u root -- /bin/rm -R -f -- "/"', 'true && sudo rm --force --recursive "$HOME"',
  ];
  for (const command of dangerous) {
    let confirmations = 0;
    const confirm = async () => { confirmations++; return false; };
    const event = call('bash', {command});
    assert.equal((await correctToolCall(event, {cwd, mode: 'tui', hasUI: true}, {headless: false, confirm}))?.block,
      true, `confirmation bypass for ${command}`);
    assert.equal(confirmations, 1, `missing confirmation for ${command}`);
    assert.equal(event.input.command, command);
    for (const context of [{cwd, mode: 'rpc', hasUI: true}, {cwd, mode: 'tui', hasUI: false}]) {
      assert.equal(await correctToolCall(call('bash', {command}), context, {headless: false, confirm}), undefined);
      assert.equal(confirmations, 1);
    }
    assert.equal(await correctToolCall(call('bash', {command}), {cwd, mode: 'tui', hasUI: true}, {headless: true, confirm}), undefined);
    assert.equal(confirmations, 1);
  }
});

test('quoted command descriptions and literal home strings do not request catastrophic confirmation', async t => {
  const cwd = await fixture(t);
  const {correctToolCall} = await moduleApi();
  const harmless = ['echo "rm -rf /"', "printf '%s\\n' 'sudo rm -rf /'", 'echo "mkfs.ext4 /dev/sda"',
    "echo ':(){ :|:& };:'", "rm -rf '$HOME'", 'rm -rf "~"', 'rm -f "/"', 'rm -RF "/"', 'rm -rf -- build/output',
    'command -v rm', 'echo ok # rm -rf /'];
  for (const command of harmless) {
    let confirmations = 0;
    assert.equal(await correctToolCall(call('bash', {command}), {cwd, mode: 'tui', hasUI: true},
      {headless: false, confirm: async () => { confirmations++; return false; }}), undefined, command);
    assert.equal(confirmations, 0, command);
  }
});

test('loop breaker notes repeat failures at three, bounds output and does not lower Muse effort', async () => {
  const {createLoopBreaker} = await moduleApi();
  const loop = createLoopBreaker({maxNotes: 2});
  const fail = result('bash', {command: 'npm test'}, 'Failure: ' + 'x'.repeat(9000), true);
  assert.equal(loop.observe(fail), undefined);
  assert.equal(loop.observe(fail), undefined);
  const note = loop.observe(fail);
  assert.equal(note.kind, 'failure');
  assert.equal(note.n, 3);
  assert.equal(note.thinking, 'xhigh');
  assert.ok(Buffer.byteLength(note.failure_summary) <= 1200);
  for (let i = 0; i < 200; i++) loop.observe(fail);
  assert.equal(loop.observe(fail), undefined);
  loop.reset();
  assert.equal(loop.observe(fail), undefined);
  assert.equal(loop.observe(result('bash', {command: 'different'}, 'different', true)), undefined);
  assert.equal(loop.observe(fail), undefined);
  assert.equal(loop.observe(fail)?.n, 3);
});

test('repeated reads require identical result bytes and edit ping-pong requires successful reversed edits', async () => {
  const {createLoopBreaker} = await moduleApi();
  const loop = createLoopBreaker({maxNotes: 4});
  const read = text => result('read', {path: 'file', offset: 1, limit: 2}, text);
  loop.observe(read('one'));
  loop.observe(read('two'));
  loop.observe(read('one'));
  assert.equal(loop.observe(read('one')).kind, 'read');
  const edit = (oldText, newText, isError = false) => result('edit', {path: 'file', edits: [{oldText, newText}]}, 'edited', isError);
  assert.equal(loop.observe(edit('a', 'b')), undefined);
  assert.equal(loop.observe(edit('b', 'a', true)), undefined);
  assert.equal(loop.observe(edit('b', 'a')), undefined);
  assert.equal(loop.observe(edit('a', 'b')).kind, 'ping-pong');
});

test('time thresholds emit once at monotonic boundaries including catch-up and reset without timers', async () => {
  const {createTimeTracker} = await moduleApi();
  let clock = 100;
  const tracker = createTimeTracker({seconds: 100, now: () => clock});
  assert.deepEqual(tracker.poll(), []);
  clock = 50100;
  assert.deepEqual(tracker.poll(), [{threshold: 0.5, remaining: 50, total: 100, elapsed: 50}]);
  clock = 10100;
  assert.deepEqual(tracker.poll(), []);
  clock = 96100;
  assert.deepEqual(tracker.poll(), [{threshold: 0.75, remaining: 4, total: 100, elapsed: 96},
    {threshold: 0.9, remaining: 4, total: 100, elapsed: 96}]);
  clock = 150100;
  assert.deepEqual(tracker.poll(), []);
  tracker.reset();
  assert.deepEqual(tracker.poll(), []);
  clock += 50000;
  assert.equal(tracker.poll()[0].remaining, 50);
  for (const seconds of [0, -1, Infinity, '2']) assert.throws(() => createTimeTracker({seconds}), /positive|finite/);
});

test('diagnostics select fixed installed checkers and compare a before-edit baseline with only new errors', async t => {
  const cwd = await fixture(t);
  const file = path.join(cwd, 'file.py');
  await writeFile(file, 'old');
  const {createDiagnostics} = await moduleApi();
  const commands = [];
  const diagnostics = createDiagnostics({cwd, runCommand: async (command, args, options) => {
    commands.push({command, args, options});
    if (args[0] === '--version') return {code: command === 'ruff' ? 0 : 127, stdout: '', stderr: ''};
    assert.equal(command, 'ruff');
    assert.ok(args.includes('check'));
    assert.ok(args.includes('--no-cache'));
    assert.equal(options.networkAllowed, false);
    assert.ok(options.timeoutMs <= 5000);
    assert.ok(options.maxOutputBytes <= 65536);
    const changed = await readFile(file, 'utf8') === 'new';
    return {code: 1, stdout: `file.py:1:1: F401 old problem\n${changed ? 'file.py:2:1: F821 introduced problem\n' : ''}`, stderr: ''};
  }});
  const event = call('write', {path: 'file.py', content: 'new'}, 'write/1');
  event.parentToolCallId = 'write';
  const baseline = await diagnostics.before(event);
  assert.equal(baseline.status, 'baseline');
  assert.equal(baseline.checker, 'ruff');
  assert.deepEqual(baseline.newErrors, []);
  await writeFile(file, 'new');
  const after = await diagnostics.after(result('write', event.input, 'written', false, 'write/1'));
  assert.equal(after.status, 'diagnostics');
  assert.deepEqual(after.newErrors, ['file.py:2:1: F821 introduced problem']);
  assert.ok(commands.every(row => !row.args.some(arg => ['install', 'exec', 'npx'].includes(arg))));
  assert.equal((await diagnostics.after(result('write', event.input, 'written', false, 'write/1'))).status, 'skipped');
});

test('diagnostics retain independent parallel nested baselines and reset discards pending work', async t => {
  const cwd = await fixture(t);
  await writeFile(path.join(cwd, 'one.ts'), 'old');
  await writeFile(path.join(cwd, 'two.ts'), 'old');
  const {createDiagnostics} = await moduleApi();
  const diagnostics = createDiagnostics({cwd, runCommand: async (command, args) => {
    if (args[0] === '--version') return {code: command === 'tsc' ? 0 : 127, stdout: '', stderr: ''};
    const file = args.at(-1);
    const changed = (await readFile(path.join(cwd, file), 'utf8')) === 'new';
    return {exitCode: changed ? 2 : 0, stdout: changed ? `${file}(1,1): error TS2322: new error` : '', stderr: ''};
  }});
  const first = call('write', {path: 'one.ts', content: 'new'}, 'p/1');
  const second = call('edit', {path: 'two.ts', edits: [{oldText: 'old', newText: 'new'}]}, 'p/2');
  await Promise.all([diagnostics.before(first), diagnostics.before(second)]);
  await Promise.all([writeFile(path.join(cwd, 'one.ts'), 'new'), writeFile(path.join(cwd, 'two.ts'), 'new')]);
  const notes = await Promise.all([diagnostics.after(result('write', first.input, 'done', false, 'p/1')),
    diagnostics.after(result('edit', second.input, 'done', false, 'p/2'))]);
  assert.deepEqual(notes.map(note => note.newErrors), [['one.ts(1,1): error TS2322: new error'], ['two.ts(1,1): error TS2322: new error']]);
  await diagnostics.before(call('write', {path: 'one.ts', content: 'again'}, 'reset'));
  diagnostics.reset();
  assert.equal((await diagnostics.after(result('write', {path: 'one.ts'}, 'done', false, 'reset'))).status, 'skipped');
});

test('diagnostics skip missing checkers, failed mutations, unsafe files and incomplete baseline checks', async t => {
  const cwd = await fixture(t);
  await writeFile(path.join(cwd, 'file.py'), 'x');
  const {createDiagnostics} = await moduleApi();
  let checks = 0;
  const missing = createDiagnostics({cwd, runCommand: async () => { checks++; return {code: 127, stdout: '', stderr: ''}; }});
  assert.match((await missing.before(call('write', {path: 'file.py'}, 'missing'))).reason, /available|installed/);
  const count = checks;
  assert.equal((await missing.before(call('write', {path: '../out.py'}, 'escape'))).status, 'skipped');
  assert.equal(checks, count);
  const incomplete = createDiagnostics({cwd, runCommand: async (_command, args) => args[0] === '--version' ?
    {code: 0, stdout: '', stderr: ''} : {code: 1, stdout: 'file.py:1:1: F821 error', stderr: '', timedOut: true}});
  assert.equal((await incomplete.before(call('write', {path: 'file.py'}, 'timeout'))).status, 'skipped');
  assert.equal((await incomplete.after(result('write', {path: 'file.py'}, 'done', false, 'timeout'))).status, 'skipped');
  const normal = createDiagnostics({cwd, runCommand: async (_command, args) => ({code: 0, stdout: '', stderr: ''})});
  await normal.before(call('write', {path: 'file.py'}, 'failed'));
  assert.match((await normal.after(result('write', {path: 'file.py'}, 'failed', true, 'failed'))).reason, /failed/);
});

test('diagnostic output is bounded and runtime imports/factories do not launch commands', async t => {
  const cwd = await fixture(t);
  await writeFile(path.join(cwd, 'file.py'), 'x');
  const {createDiagnostics} = await moduleApi();
  let calls = 0;
  const diagnostics = createDiagnostics({cwd, runCommand: async (_command, args) => {
    calls++;
    if (args[0] === '--version') return {code: 0, stdout: '', stderr: ''};
    return {code: 1, stdout: Array.from({length: 1000}, (_, i) => `file.py:${i}:1: F821 ${'x'.repeat(1000)}`).join('\n'), stderr: ''};
  }});
  assert.equal(calls, 0);
  const baseline = await diagnostics.before(call('write', {path: 'file.py'}, 'large'));
  assert.equal(baseline.status, 'skipped');
  assert.ok(Buffer.byteLength(JSON.stringify(baseline)) < 10000);
  assert.equal(baseline.truncated, true);
});

test('diagnostics choose Go and Cargo through their real version syntax with offline compiler options', async t => {
  const cwd = await fixture(t);
  await writeFile(path.join(cwd, 'file.go'), 'package main');
  await mkdir(path.join(cwd, 'src'));
  await writeFile(path.join(cwd, 'src', 'lib.rs'), 'pub fn value() {}');
  await writeFile(path.join(cwd, 'Cargo.toml'), '[package]\nname="fixture"\nversion="0.0.0"\nedition="2021"\n');
  const {createDiagnostics} = await moduleApi();
  const diagnostics = createDiagnostics({cwd, runCommand: async (command, args, options) => {
    if (command === 'go' && args[0] === 'version' || command === 'cargo' && args[0] === '--version') return {code: 0, stdout: 'installed', stderr: ''};
    if (command === 'go' && args[0] === '--version') return {code: 2, stdout: '', stderr: 'use go version'};
    assert.equal(options.env.GOPROXY, 'off');
    assert.equal(options.env.GOTOOLCHAIN, 'local');
    assert.equal(options.env.CARGO_NET_OFFLINE, 'true');
    if (command === 'go') assert.deepEqual(args, ['vet', 'file.go']);
    if (command === 'cargo') {
      assert.ok(args.includes('--offline'));
      assert.ok(args.includes('--locked'));
      assert.ok(args.includes(path.join(cwd, 'Cargo.toml')));
    }
    return {code: 0, stdout: '', stderr: ''};
  }});
  assert.equal((await diagnostics.before(call('write', {path: 'file.go'}, 'go'))).checker, 'go');
  assert.equal((await diagnostics.before(call('write', {path: 'src/lib.rs'}, 'rust'))).checker, 'cargo');
});

test('diagnostics do not label moved pre-existing errors as newly introduced errors', async t => {
  const cwd = await fixture(t);
  const file = path.join(cwd, 'file.py');
  await writeFile(file, 'before');
  const {createDiagnostics} = await moduleApi();
  const diagnostics = createDiagnostics({cwd, runCommand: async (_command, args) => {
    if (args[0] === '--version') return {code: 0, stdout: '', stderr: ''};
    return {code: 1, stdout: `file.py:${await readFile(file, 'utf8') === 'before' ? 1 : 3}:1: F821 same pre-existing error`, stderr: ''};
  }});
  await diagnostics.before(call('edit', {path: 'file.py'}, 'shift'));
  await writeFile(file, 'after');
  assert.deepEqual((await diagnostics.after(result('edit', {path: 'file.py'}, 'done', false, 'shift'))).newErrors, []);
});

test('new files have an empty pre-edit baseline and introduced errors are checked after creation', async t => {
  const cwd = await fixture(t);
  const {createDiagnostics} = await moduleApi();
  let checks = 0;
  const diagnostics = createDiagnostics({cwd, runCommand: async (_command, args) => {
    if (args[0] === '--version') return {code: 0, stdout: '', stderr: ''};
    checks++;
    return {code: 1, stdout: 'new.py:1:1: F821 undefined name', stderr: ''};
  }});
  const baseline = await diagnostics.before(call('write', {path: 'new.py', content: 'undefined_name'}, 'new'));
  assert.equal(baseline.status, 'baseline');
  assert.deepEqual(baseline.errors, []);
  assert.equal(checks, 0);
  await writeFile(path.join(cwd, 'new.py'), 'undefined_name');
  assert.deepEqual((await diagnostics.after(result('write', {path: 'new.py'}, 'created', false, 'new'))).newErrors,
    ['new.py:1:1: F821 undefined name']);
});

test('real Node syntax diagnostics detect introduced syntax errors without executing project code', async t => {
  const cwd = await fixture(t);
  const file = path.join(cwd, 'file.mjs');
  const executed = path.join(cwd, 'executed.txt');
  await writeFile(file, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(executed)}, 'ran'); export const value = 1;\n`);
  const {createDiagnostics} = await moduleApi();
  const diagnostics = createDiagnostics({cwd});
  const baseline = await diagnostics.before(call('write', {path: 'file.mjs'}, 'node'));
  assert.equal(baseline.status, 'baseline');
  assert.equal(baseline.checker, 'node');
  assert.deepEqual(baseline.errors, []);
  await assert.rejects(readFile(executed), /ENOENT/);
  await writeFile(file, 'export const = ;\n');
  const after = await diagnostics.after(result('write', {path: 'file.mjs'}, 'done', false, 'node'));
  assert.equal(after.status, 'diagnostics');
  assert.equal(after.newErrors.length, 1);
  assert.match(after.newErrors[0], /SyntaxError/);
  await assert.rejects(readFile(executed), /ENOENT/);
});

test('default diagnostics run an existing local TypeScript compiler without network and return new errors', async t => {
  const cwd = await fixture(t);
  const file = path.join(cwd, 'file.ts');
  await writeFile(file, 'const value: number = 1;\n');
  const {createDiagnostics} = await moduleApi();
  const diagnostics = createDiagnostics({cwd});
  const baseline = await diagnostics.before(call('write', {path: 'file.ts'}, 'tsc'));
  if (baseline.status !== 'baseline') {
    assert.match(baseline.reason, /available|installed|incomplete/);
    t.skip('No complete existing TypeScript checker available in this environment');
    return;
  }
  assert.equal(baseline.checker, 'tsc');
  await writeFile(file, 'const value: number = "bad";\n');
  const after = await diagnostics.after(result('write', {path: 'file.ts'}, 'done', false, 'tsc'));
  assert.equal(after.status, 'diagnostics');
  assert.equal(after.newErrors.length, 1);
  assert.match(after.newErrors[0], /TS2322/);
});

test('default diagnostic timeouts terminate inherited-output checker descendants within the checker budget', {timeout: 10000}, async t => {
  if (process.platform === 'win32') { t.skip('Unix process-group test'); return; }
  const cwd = await fixture(t);
  const checker = path.join(cwd, 'ruff');
  const pidFile = path.join(cwd, 'child.pid');
  const survivedFile = path.join(cwd, 'child-survived.txt');
  const nodeBinary = process.env.CODEX_PRIMARY_RUNTIME_NODE ?? process.execPath;
  await writeFile(path.join(cwd, 'file.py'), 'x');
  const childSource = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(survivedFile)},'survived'),6000);setTimeout(()=>process.exit(0),6500)`;
  await writeFile(checker, `#!${nodeBinary}\nimport {spawn} from 'node:child_process';\nimport {writeFileSync} from 'node:fs';\nif(process.argv.includes('--version')) { console.log('fixture checker'); }\nelse { const child=spawn(${JSON.stringify(nodeBinary)},['-e',${JSON.stringify(childSource)}],{stdio:'inherit'}); writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>{},1000); }\n`);
  await chmod(checker, 0o700);
  const originalPath = process.env.PATH;
  process.env.PATH = cwd;
  t.after(async () => {
    process.env.PATH = originalPath;
  });
  const {createDiagnostics} = await moduleApi();
  const started = performance.now();
  const baseline = await createDiagnostics({cwd}).before(call('edit', {path: 'file.py'}, 'timeout'));
  assert.equal(baseline.status, 'skipped');
  assert.match(baseline.reason, /incomplete/);
  assert.ok(Number(await readFile(pidFile, 'utf8')) > 0, 'checker descendant actually started');
  assert.ok(performance.now() - started < 6000, 'descendant stdout kept a timed-out checker alive beyond its five-second budget');
  await new Promise(resolve => setTimeout(resolve, 1300));
  await assert.rejects(readFile(survivedFile), /ENOENT/, 'checker descendant kept running after timeout');
});

test('restored monotonic budget starts at observed elapsed time',async()=>{
  const {createTimeTracker}=await moduleApi();let ms=0;
  const tracker=createTimeTracker({seconds:100,elapsedSeconds:80,now:()=>ms});
  assert.deepEqual(tracker.poll().map(x=>x.threshold),[0.5,0.75]);
  ms=11_000;assert.deepEqual(tracker.poll().map(x=>x.threshold),[0.9]);
});
test('diagnostic subprocess environment excludes inherited private values',async t=>{
  const cwd=await fixture(t);await writeFile(path.join(cwd,'file.mjs'),'export const x=1;\n');
  const previous=process.env.CHECK_TEST_SECRET;process.env.CHECK_TEST_SECRET='synthetic-private-fixture';
  t.after(()=>previous===undefined?delete process.env.CHECK_TEST_SECRET:process.env.CHECK_TEST_SECRET=previous);
  let env;
  const {createDiagnostics}=await moduleApi();
  const diagnostics=createDiagnostics({cwd,runCommand:async(_command,_args,options)=>{
    env=options.env;return {code:0,stdout:'',stderr:''};
  }});
  await diagnostics.before(call('edit',{path:'file.mjs'},'private-env'));
  assert.ok(env);assert.equal(env.CHECK_TEST_SECRET,undefined);
  assert.equal(env.CARGO_NET_OFFLINE,'true');
});
