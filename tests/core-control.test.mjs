import assert from 'node:assert/strict';
import test from 'node:test';
import {chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
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

test('null optional arguments count as absent, as strict function schemas send them', async () => {
  const {prepareCorrectableArguments} = await moduleApi();
  assert.deepEqual(prepareCorrectableArguments('read', {path: 'file.txt', offset: null, limit: null, mode: null}), {path: 'file.txt'});
  assert.deepEqual(prepareCorrectableArguments('grep', {pattern: 'x', path: null, glob: null, ignoreCase: null, literal: null, context: null, limit: null}), {pattern: 'x'});
  assert.deepEqual(prepareCorrectableArguments('bash', {command: 'echo ok', timeout: null}), {command: 'echo ok'});
  assert.throws(() => prepareCorrectableArguments('read', {path: null}), /path must be a string/);
  assert.throws(() => prepareCorrectableArguments('read', {path: 'file.txt', offset: 0}), /positive integer/);
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

// The Windows delete check used to be this regex; it is kept here only as the reference for equivalence tests.
const ORIGINAL_WINDOWS_DELETE = /\b(?:Remove-Item|del|rd)\b[^\n;]*(?:-Recurse|\/s)[^\n;]*\s(?:[A-Z]:\\|\$HOME)\s*$/i;
const seeded = seed => n => Math.floor((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32 * n);
async function asksConfirmation(correctToolCall, command, cwd = process.cwd()) {
  let confirmations = 0;
  const outcome = await correctToolCall(call('bash', {command}), {cwd, mode: 'tui', hasUI: true},
    {headless: false, confirm: async () => { confirmations++; return false; }});
  assert.equal(outcome?.block === true, confirmations === 1, command);
  if (outcome?.block) assert.equal(outcome.reason, 'Catastrophic command was not confirmed in the TUI');
  return confirmations === 1;
}

test('Windows recursive deletes of a drive root or $HOME need TUI confirmation and near misses do not', async t => {
  const cwd = await fixture(t);
  const {correctToolCall} = await moduleApi();
  const dangerous = ['Remove-Item -Recurse -Force C:\\', 'rd /s /q C:\\', 'del /s $HOME', 'cmd /c rd /S /Q c:\\   ', 'rd /s /q\nC:\\',
    'rd/s C:\\', 'Remove-Item -Path x -Recurse\t$home\r\n', 'echo ok; rd /s\u00a0Z:\\'];
  const harmless = ['rd /s /q C:\\build', 'del /s x; echo C:\\', 'Remove-Item -Recurse $HOME\\x', 'Remove-Item C:\\ -Recurse',
    'echo rd; /s C:\\', 'rd /s\n;C:\\', 'xrd /s C:\\', 'Remove-Items -Recurse C:\\', 'rd /s C:\\x', 'rd /s 1:\\', 'rd /s $HOMEx', 'rd /q C:\\'];
  for (const command of dangerous) {
    assert.equal(ORIGINAL_WINDOWS_DELETE.test(command), true, command);
    assert.equal(await asksConfirmation(correctToolCall, command, cwd), true, command);
  }
  for (const command of harmless) {
    assert.equal(ORIGINAL_WINDOWS_DELETE.test(command), false, command);
    assert.equal(await asksConfirmation(correctToolCall, command, cwd), false, command);
  }
});

test('the Windows delete check gives the original regex answer on seeded random commands', async () => {
  const {correctToolCall} = await moduleApi();
  // No token can form rm, dd, mkfs, shutdown or a fork bomb, so only the Windows branch can ask for confirmation.
  const tokens = ['rd', 'RD', 'del', 'DeL', 'Remove-Item', 'remove-item', 'Remove-Items', 'xrd', 'rdx', '-', '-Recurse', '-recurse',
    '/s', '/S', '/src', '/', 's', ' ', '  ', '\t', '\n', '\r', '\r\n', ';', '\u00a0', '\u2028', '\ufeff', '\u0085', '\u000b', 'C:\\', 'c:\\',
    'Z:\\', '1:\\', 'C:', '\\', ':', '$HOME', '$home', '$HOMEx', '$', 'HOME', 'a', '_', '9', '\u00e9', '\u017f', '/q', '"', "'", '|', '&', '#'];
  const tails = [' C:\\', ' $HOME', '\nC:\\', ' c:\\  ', ' $home\t', '\u00a0C:\\', ';C:\\', ' C:\\\n\r '];
  const random = seeded(20261102);
  let positives = 0;
  for (let i = 0; i < 50000; i++) {
    let command = '';
    for (let length = 1 + random(14); length > 0; length--) command += tokens[random(tokens.length)];
    if (random(3) === 0) command += tails[random(tails.length)];
    const expected = ORIGINAL_WINDOWS_DELETE.test(command);
    positives += expected;
    assert.equal(await asksConfirmation(correctToolCall, command), expected, JSON.stringify(command));
  }
  assert.ok(positives > 500, `only ${positives} positive cases`);
});

test('catastrophic confirmation matches the d0c6d2b check on seeded random POSIX and Windows commands', async () => {
  const {correctToolCall} = await moduleApi();
  const reference = await import('./fixtures/core-control-d0c6d2b.mjs');
  const tokens = ['rm', ' rm ', 'sudo ', 'command ', '-rf', ' -rf ', ' -fr', ' -R', ' -f', ' --', ' /', ' "/"', " '/'", ' ~', ' ~/', ' "$HOME"',
    ' ${HOME}', ' $HOME', 'dd', ' of=/dev/sda', 'mkfs.ext4', 'shutdown', ':(){ :|:& };:', '#', ';', '\n', ' && ', ' | ', '"', "'", '\\',
    'rd', ' /s', ' /q', 'del', 'Remove-Item', ' -Recurse', ' C:\\', ' c:\\', 'echo ', 'x', ' '];
  const random = seeded(7);
  let positives = 0;
  for (let i = 0; i < 20000; i++) {
    let command = '';
    for (let length = 1 + random(10); length > 0; length--) command += tokens[random(tokens.length)];
    const expected = await asksConfirmation(reference.correctToolCall, command);
    positives += expected;
    assert.equal(await asksConfirmation(correctToolCall, command), expected, JSON.stringify(command));
  }
  assert.ok(positives > 200, `only ${positives} positive cases`);
});

test('a 100 KB single-line command is checked for catastrophic deletes in linear time', async () => {
  const {correctToolCall} = await moduleApi();
  const grow = (target, prefix, item, joiner, suffix) => {
    const items = [];
    for (let i = 0, size = prefix.length + suffix.length; size < target; i++) { const value = item(i); items.push(value); size += value.length + joiner.length; }
    return prefix + items.join(joiner) + suffix;
  };
  // Each of these took 0.5-2 s at 23-48 KB with the old regex, and cubic growth made 100 KB take minutes.
  const shapes = {
    printf: size => grow(size, "printf '%s' 'import os\\n", i => i % 7 === 0 ? `    del cache[k${i}]` : i % 5 === 0 ? `    p = Path("/srv/app/src/m${i}.py")` : `    x${i} = compute(x${i - 1}) + 1`, '\\n', "\\n' > tool.py"),
    json: size => grow(size, "echo '[", i => `{"path":"/src/module${i}/index.js","addr":"${i} Main ${i % 20 === 0 ? 'Rd' : 'St'}"}`, ',', "]' > fixtures/data.json"),
    locale: size => grow(size, "echo '{", i => `"k${i}":"Configuraci\u00f3n del sistema ${i}","u${i}":"https://ex.com/search/${i}"`, ',', "}' > locales/es.json"),
  };
  for (const [name, shape] of Object.entries(shapes)) {
    // Grow step by step so that a regression fails at a small size instead of hanging the test run.
    for (const size of [6e3, 12e3, 25e3, 50e3, 100e3]) {
      const command = shape(size);
      const started = performance.now();
      assert.equal(await asksConfirmation(correctToolCall, command), false, name);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 500, `${name} at ${command.length} bytes took ${elapsed.toFixed(1)} ms`);
    }
    const started = performance.now();
    assert.equal(await asksConfirmation(correctToolCall, `${shape(100e3)} && rd /s /q C:\\`), true, name);
    assert.ok(performance.now() - started < 500, name);
  }
});

test('edit precondition gives the d0c6d2b results and normalized input for seeded random edits', async t => {
  const cwd = await fixture(t);
  const {correctToolCall} = await moduleApi();
  const reference = await import('./fixtures/core-control-d0c6d2b.mjs');
  const vocabulary = ['alpha = 1', 'beta = 2', 'repeat', '  indented  ', 'value = \u201cold\u201d', 'x', '', 'gamma(delta)', '\ttabbed', 'repeat'];
  const random = seeded(99);
  const pick = list => list[random(list.length)];
  let blocked = 0, accepted = 0;
  for (let i = 0; i < 400; i++) {
    const lines = Array.from({length: 2 + random(12)}, () => pick(vocabulary));
    const text = lines.join('\n') + (random(2) ? '\n' : '');
    const bytes = (random(4) === 0 ? '\ufeff' : '') + (random(3) === 0 ? text.replace(/\n/g, '\r\n') : text);
    const name = `case${i}.txt`;
    await writeFile(path.join(cwd, name), bytes);
    const oldText = () => {
      const kind = random(7);
      if (kind === 0) return 'missing text';
      if (kind === 1) return pick(vocabulary.filter(Boolean));
      if (kind === 2) return (pick(lines.filter(Boolean)) ?? 'x').replace(/ /g, '  ').replace(/[\u201c\u201d]/g, '"');
      const start = random(lines.length), end = start + 1 + random(3);
      return lines.slice(start, end).join('\n') || 'alpha';
    };
    const edits = Array.from({length: 1 + random(3)}, () => {
      const from = oldText();
      return random(6) === 0 ? {old_string: from, new_string: from} : {oldText: from, newText: pick(vocabulary)};
    });
    const input = random(5) === 0 ? {file_path: name, ...edits[0]} : {path: name, edits};
    const expectedEvent = call('edit', structuredClone(input)), actualEvent = call('edit', structuredClone(input));
    const expected = await reference.correctToolCall(expectedEvent, {cwd});
    const actual = await correctToolCall(actualEvent, {cwd});
    assert.deepEqual(actual, expected, JSON.stringify({bytes, input}));
    assert.deepEqual(actualEvent.input, expectedEvent.input);
    if (expected?.block) blocked++; else accepted++;
    assert.equal(await readFile(path.join(cwd, name), 'utf8'), bytes);
  }
  assert.ok(blocked > 50 && accepted > 50, `blocked ${blocked}, accepted ${accepted}`);
});

test('edit precondition stops at the native writer, skipping whole-file diff work, without writing', async t => {
  const cwd = await fixture(t);
  const {correctToolCall} = await moduleApi();
  const file = path.join(cwd, 'large.js');
  const lines = Array.from({length: 900}, (_, i) => `  const value${i} = compute(${i}, "some text here ${i % 97}"); // line ${i}`);
  const original = lines.join('\n') + '\n';
  await writeFile(file, original);
  const block = lines.slice(450, 850).join('\n');
  const edits = [{oldText: block, newText: block.replace(/compute/g, 'calc').replace(/line/g, 'L')}];
  const before = await stat(file);
  const times = [];
  for (let i = 0; i < 5; i++) {
    const event = call('edit', {path: 'large.js', edits});
    const started = performance.now();
    assert.equal(await correctToolCall(event, {cwd}), undefined);
    times.push(performance.now() - started);
    assert.deepEqual(event.input, {path: file, edits});
  }
  // Pi's two whole-file diffs of this 400-line rewrite took about 90 ms per pre-check; matching alone takes about 1 ms.
  const median = times.sort((a, b) => a - b)[2];
  assert.ok(median < 25, `median pre-check ${median.toFixed(1)} ms`);
  const after = await stat(file);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal(after.mtimeMs, before.mtimeMs);
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

test('real Bun syntax diagnostics detect introduced syntax errors without executing project code', async t => {
  const cwd = await fixture(t);
  const file = path.join(cwd, 'file.mjs');
  const executed = path.join(cwd, 'executed.txt');
  await writeFile(file, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(executed)}, 'ran'); export const value = 1;\n`);
  const {createDiagnostics} = await moduleApi();
  const diagnostics = createDiagnostics({cwd});
  const baseline = await diagnostics.before(call('write', {path: 'file.mjs'}, 'node'));
  assert.equal(baseline.status, 'baseline');
  assert.equal(baseline.checker, 'bun');
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
  const runtime = process.execPath;
  await writeFile(path.join(cwd, 'file.py'), 'x');
  const childSource = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(survivedFile)},'survived'),6000);setTimeout(()=>process.exit(0),6500)`;
  await writeFile(checker, `#!${runtime}\nimport {spawn} from 'node:child_process';\nimport {writeFileSync} from 'node:fs';\nif(process.argv.includes('--version')) { console.log('fixture checker'); }\nelse { const child=spawn(${JSON.stringify(runtime)},['-e',${JSON.stringify(childSource)}],{stdio:'inherit'}); writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>{},1000); }\n`);
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
