import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createInterface} from 'node:readline';
import {PassThrough} from 'node:stream';
import {test} from 'bun:test';
import {createComputerTool, createWindowsBackend} from '../extensions/apex-context/computer.mjs';
import apexContext from '../extensions/apex-context/index.mjs';

const PNG = Buffer.from('PNGDATA').toString('base64');

// Real pixels in and out, like the Windows host.
function fakeDesktop({width = 2560, height = 1440, cursor = {x: 0, y: 0}} = {}) {
  const calls = [];
  const desktop = {
    closed: 0,
    async screen() { calls.push(['screen']); return {width, height}; },
    async capture(w, h) { calls.push(['capture', w, h]); return PNG; },
    async cursor() { return {...cursor}; },
    async move(x, y) { calls.push(['move', x, y]); cursor = {x, y}; },
    async click(button, count) { calls.push(['click', button, count]); },
    async drag(from, to, button) { calls.push(['drag', from, to, button]); cursor = {x: to[0], y: to[1]}; },
    async scroll(deltaX, deltaY) { calls.push(['scroll', deltaX, deltaY]); },
    async type(text) { calls.push(['type', text]); },
    async key(codes) { calls.push(['key', codes]); },
    async close() { desktop.closed++; },
  };
  return {desktop, calls};
}

function tool(options) {
  const fake = fakeDesktop(options);
  let opens = 0;
  return {...fake, opens: () => opens, tool: createComputerTool({backend: async () => { opens++; return fake.desktop; }})};
}

const input = calls => calls.filter(call => call[0] !== 'screen');

test('construction starts nothing; each action maps screenshot coordinates to real pixels', async () => {
  const t = tool();
  assert.equal(t.opens(), 0, 'construction must not start the backend');

  const shot = await t.tool.execute('1', {action: 'screenshot'});
  assert.deepEqual(shot.structuredContent, {action: 'screenshot', width: 1280, height: 720, screenWidth: 2560, screenHeight: 1440, scale: 0.5, bytes: 7,
    text: 'computer screenshot: 1280x720 of the 2560x1440 primary monitor (scale 0.5)'});
  assert.deepEqual(shot.content, [{type: 'text', text: shot.structuredContent.text}, {type: 'image', data: PNG, mimeType: 'image/png'}]);
  assert.deepEqual(shot.details.apexComputer, shot.structuredContent);

  assert.deepEqual((await t.tool.execute('2', {action: 'move', x: 640, y: 360})).structuredContent, {action: 'move', x: 640, y: 360, text: 'computer move: cursor (640, 360)'});
  assert.deepEqual((await t.tool.execute('3', {action: 'click', x: 1279, y: 719, button: 'right'})).structuredContent,
    {action: 'click', x: 1279, y: 719, text: 'computer click: right at cursor (1279, 719)'});
  await t.tool.execute('4', {action: 'double_click'});
  assert.deepEqual((await t.tool.execute('5', {action: 'drag', startX: 0, startY: 0, x: 100, y: 50})).structuredContent,
    {action: 'drag', x: 100, y: 50, text: 'computer drag: left from (0, 0), cursor (100, 50)'});
  assert.deepEqual((await t.tool.execute('6', {action: 'scroll', deltaY: 3, x: 10, y: 20})).structuredContent,
    {action: 'scroll', deltaX: 0, deltaY: 3, x: 10, y: 20, text: 'computer scroll: 0,3 notches at cursor (10, 20)'});
  assert.deepEqual((await t.tool.execute('7', {action: 'type', text: 'héllo\n'})).structuredContent, {action: 'type', characters: 6, text: 'computer type: 6 characters'});
  assert.deepEqual((await t.tool.execute('8', {action: 'key', key: 'Control+Shift+Escape'})).structuredContent, {action: 'key', key: 'Control+Shift+Escape', text: 'computer key: Control+Shift+Escape'});
  assert.deepEqual((await t.tool.execute('9', {action: 'cursor_position'})).structuredContent, {action: 'cursor_position', x: 10, y: 20, text: 'computer cursor_position: cursor (10, 20)'});

  assert.deepEqual(input(t.calls), [
    ['capture', 1280, 720], ['move', 1281, 721], ['move', 2559, 1439], ['click', 'right', 1], ['click', 'left', 2],
    ['drag', [1, 1], [201, 101], 'left'], ['move', 21, 41], ['scroll', 0, 3], ['type', 'héllo\n'], ['key', [0x11, 0x10, 0x1b]],
  ]);
  assert.equal(t.opens(), 1, 'one backend serves the whole session');
});

test('non-integer scales reach the last real pixel, and small screens are not enlarged', async () => {
  const wide = tool({width: 1920, height: 1080});
  assert.equal((await wide.tool.execute('1', {action: 'screenshot'})).structuredContent.width, 1280);
  await wide.tool.execute('2', {action: 'move', x: 1279, y: 719});
  assert.deepEqual(input(wide.calls).at(-1), ['move', 1919, 1079]);

  const small = tool({width: 1024, height: 768});
  assert.equal((await small.tool.execute('1', {action: 'screenshot'})).structuredContent.scale, 1);
  await small.tool.execute('2', {action: 'move', x: 1023, y: 767});
  assert.deepEqual(input(small.calls).at(-1), ['move', 1023, 767]);
  assert.match((await small.tool.execute('3', {action: 'cursor_position'})).structuredContent.text, /cursor \(1023, 767\)$/);

  const off = tool({width: 1024, height: 768, cursor: {x: -300, y: 900}});
  assert.deepEqual((await off.tool.execute('1', {action: 'cursor_position'})).structuredContent,
    {action: 'cursor_position', x: 0, y: 767, offScreen: true, text: 'computer cursor_position: cursor (0, 767) clamped; the cursor is off the primary monitor'});
});

test('invalid input fails before the backend starts; out-of-bounds coordinates send no input', async () => {
  const t = tool();
  for (const [value, pattern] of [
    [undefined, /Invalid computer action/], [{action: 'launch'}, /Invalid computer action/],
    [{action: 'move', x: 1}, /requires y/], [{action: 'click', x: 1}, /x and y must be given together/],
    [{action: 'move', x: -1, y: 0}, /x must be a nonnegative integer/], [{action: 'move', x: 1.5, y: 0}, /x must be/], [{action: 'move', x: '1', y: 0}, /x must be/],
    [{action: 'move', x: Infinity, y: 0}, /x must be/], [{action: 'drag', x: 1, y: 1}, /requires startX/],
    [{action: 'click', button: 'back'}, /button must be one of/],
    [{action: 'scroll'}, /nonzero deltaX or deltaY/], [{action: 'scroll', deltaY: 51}, /deltaY must be an integer/], [{action: 'scroll', deltaX: 0.5}, /deltaX must be/],
    [{action: 'type'}, /requires text/], [{action: 'type', text: ''}, /text must be/], [{action: 'type', text: 'a\0'}, /text must be/], [{action: 'type', text: 'x'.repeat(4097)}, /text must be/],
    [{action: 'key'}, /requires key/], [{action: 'key', key: 'K'.repeat(65)}, /key must be/], [{action: 'key', key: 'Control+Hyper'}, /unknown key "hyper"/],
    [{action: 'key', key: 'Control+'}, /unknown key ""/], [{action: 'key', key: 'constructor'}, /unknown key/], [{action: 'key', key: 'Ctrl+Control'}, /distinct keys/],
  ]) await assert.rejects(t.tool.execute('bad', value), pattern);
  assert.equal(t.opens(), 0);

  for (const value of [{action: 'move', x: 1280, y: 0}, {action: 'click', x: 0, y: 720}, {action: 'drag', startX: 1280, startY: 0, x: 0, y: 0}, {action: 'scroll', deltaY: 1, x: 5000, y: 1}]) {
    await assert.rejects(t.tool.execute('out', value), /outside the 1280x720 screenshot space/);
  }
  assert.deepEqual(input(t.calls), []);
});

test('abort is checked before and after every backend call', async () => {
  const t = tool();
  await assert.rejects(t.tool.execute('a', {action: 'click', x: 1, y: 1}, AbortSignal.abort()), /Computer operation aborted/);
  assert.equal(t.opens(), 0);

  const controller = new AbortController();
  t.desktop.screen = async () => { controller.abort(); return {width: 2560, height: 1440}; };
  await assert.rejects(t.tool.execute('b', {action: 'click', x: 1, y: 1}, controller.signal), /aborted/);
  assert.deepEqual(input(t.calls), [], 'no input after an abort during the screen query');

  const late = new AbortController();
  t.desktop.screen = async () => ({width: 2560, height: 1440});
  t.desktop.move = async (x, y) => { t.calls.push(['move', x, y]); late.abort(); };
  await assert.rejects(t.tool.execute('c', {action: 'click', x: 1, y: 1}, late.signal), /aborted/);
  assert.deepEqual(input(t.calls), [['move', 3, 3]], 'the click after an aborted move never fires');
});

test('close releases the backend once; a dead host is replaced on the next call', async () => {
  const t = tool();
  assert.equal(await t.tool.close(), false);
  await t.tool.execute('1', {action: 'cursor_position'});
  assert.equal(await t.tool.close(), true);
  assert.equal(t.desktop.closed, 1);
  assert.equal(await t.tool.close(), false);

  let opens = 0;
  const dead = {alive: false, screen: async () => { throw new Error('computer backend exited (1)'); }, close: async () => {}};
  const live = fakeDesktop().desktop;
  const restart = createComputerTool({backend: async () => ++opens === 1 ? dead : live});
  await assert.rejects(restart.execute('1', {action: 'screenshot'}), /backend exited/);
  await restart.execute('2', {action: 'screenshot'});
  assert.equal(opens, 2);

  let attempts = 0;
  const failing = createComputerTool({backend: async () => { attempts++; throw new Error('computer could not start Windows PowerShell'); }});
  await assert.rejects(failing.execute('1', {action: 'screenshot'}), /could not start Windows PowerShell/);
  await assert.rejects(failing.execute('2', {action: 'screenshot'}), /could not start/);
  assert.equal(attempts, 2, 'a failed start is retried rather than cached');
});

// A child process speaking the host's line protocol, for the Windows backend's client side.
function fakeChild(reply, {ready = {id: 0, ok: true}} = {}) {
  const child = new EventEmitter();
  Object.assign(child, {stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), lines: [], killed: 0});
  child.kill = () => { child.killed++; child.emit('exit', null, 'SIGTERM'); };
  createInterface({input: child.stdin}).on('line', line => { child.lines.push(line); child.stdout.write(`${JSON.stringify(reply(JSON.parse(line)))}\n`); });
  child.stdin.on('finish', () => child.emit('exit', 0, null));
  queueMicrotask(() => child.stdout.write(`noise\n${JSON.stringify(ready)}\n`));
  return child;
}

test('the Windows backend refuses other platforms and reports a missing PowerShell without spawning twice', async () => {
  let spawned = 0;
  const spawn = () => { spawned++; const child = new EventEmitter(); Object.assign(child, {stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {}});
    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), {code: 'ENOENT'}))); return child; };
  const linux = createComputerTool({backend: createWindowsBackend({platform: 'linux', spawn})});
  await assert.rejects(linux.execute('1', {action: 'screenshot'}), /native Windows only \(this platform is linux\); Apex installs no desktop backend/);
  const open = createWindowsBackend({platform: 'win32', spawn, env: {SystemRoot: 'D:\\Win'}});
  assert.equal(spawned, 0, 'creating the backend spawns nothing');
  await assert.rejects(open(), /could not start Windows PowerShell at D:\\Win\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe \(ENOENT\)/);
  assert.equal(spawned, 1);

  const blocked = createWindowsBackend({platform: 'win32', spawn: () => fakeChild(() => null, {ready: {id: 0, ok: false, error: 'Cannot add type. Compilation is disabled'}})});
  await assert.rejects(blocked(), /computer backend failed to start: Cannot add type/);
});

test('the Windows backend speaks ASCII JSON lines, surfaces host errors and closes by ending stdin', async () => {
  let child;
  const open = createWindowsBackend({platform: 'win32', env: {}, spawn: (exe, args, options) => {
    assert.equal(exe, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(args.slice(0, 6), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    assert.equal(options.windowsHide, true);
    return child = fakeChild(({id, op}) => op === 'screen' ? {id, ok: true, result: {width: 800, height: 600}}
      : op === 'capture' ? {id, ok: true, result: {png: PNG}} : op === 'click' ? {id, ok: false, error: 'SendInput inserted 0 of 2 events'} : {id, ok: true, result: null});
  }});
  const desktop = await open();
  assert.deepEqual(await desktop.screen(), {width: 800, height: 600});
  assert.equal(await desktop.capture(800, 600), PNG);
  await desktop.type('é😀\n');
  await desktop.drag([1, 2], [3, 4], 'left');
  await assert.rejects(desktop.click('left', 1), /SendInput inserted 0 of 2/);
  assert.ok(child.lines.every(line => /^[\x20-\x7e]+$/.test(line)), 'requests are ASCII');
  assert.deepEqual(child.lines.map(line => JSON.parse(line)), [
    {id: 1, op: 'screen', args: {}}, {id: 2, op: 'capture', args: {width: 800, height: 600}}, {id: 3, op: 'type', args: {text: 'é😀\n'}},
    {id: 4, op: 'drag', args: {fromX: 1, fromY: 2, toX: 3, toY: 4, button: 'left'}}, {id: 5, op: 'click', args: {button: 'left', count: 1}},
  ]);
  assert.equal(desktop.alive, true);
  await desktop.close();
  assert.equal(desktop.alive, false);
  assert.equal(child.killed, 0, 'a responsive host exits on end of input');
  await assert.rejects(desktop.screen(), /backend exited \(0\)/);
});

function harness(flags) {
  const hooks = new Map(), tools = [];
  let active = ['read', 'bash'];
  const pi = {registerFlag() {}, getFlag: () => flags, on(name, callback) { hooks.set(name, callback); },
    registerTool(tool) { tools.push(tool); }, getActiveTools: () => [...active], setActiveTools(names) { active = [...names]; }, getAllTools: () => tools, appendEntry() {}};
  const ctx = {cwd: process.cwd(), sessionManager: {getBranch: () => []}};
  apexContext(pi);
  return {tools, active: () => active, emit: (name, event = {}) => hooks.get(name)(event, ctx)};
}

test('the computer tool is registered and active only with the computer flag', async () => {
  const off = harness('read,browser');
  await off.emit('session_start');
  assert.equal(off.tools.some(tool => tool.name === 'computer'), false);
  await off.emit('session_shutdown');

  const on = harness('computer');
  await on.emit('session_start');
  assert.deepEqual(on.tools.map(tool => tool.name), ['computer']);
  assert.deepEqual(on.active(), ['read', 'bash', 'computer']);
  await on.emit('session_shutdown');
});

test('re-initialisation and session shutdown close the computer tool', async () => {
  const h = harness('computer');
  await h.emit('session_start');
  const closed = [];
  for (const event of ['session_tree', 'session_fork', 'session_start', 'session_shutdown']) {
    const current = h.tools.at(-1);
    current.close = async () => { closed.push(event); return true; };
    await h.emit(event);
  }
  assert.deepEqual(closed, ['session_tree', 'session_fork', 'session_start', 'session_shutdown']);
  assert.equal(h.tools.length, 4, 'each re-initialisation registers a fresh tool');
});
