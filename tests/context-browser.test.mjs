import assert from 'node:assert/strict';
import {mock, test} from 'bun:test';
import {createBrowserTool} from '../extensions/apex-context/browser.mjs';

function fakeBrowser({snapshot} = {}) {
  const calls = [];
  const page = {
    address: 'about:blank',
    async goto(url, options) { calls.push(['goto', url, options.waitUntil]); page.address = url; return {status: () => 200}; },
    url: () => page.address,
    async title() { return 'Fixture page'; },
    async evaluate(_fn, arg) { calls.push(['evaluate', arg]); return snapshot ?? {title: 'Fixture page', url: page.address, text: 'Hello', textLength: 5, total: 1,
      elements: [{ref: 'e1', tag: 'button', name: 'Go'}]}; },
    async click(selector) { calls.push(['click', selector]); },
    async fill(selector, text) { calls.push(['fill', selector, text]); },
    keyboard: {async press(key) { calls.push(['press', key]); }},
    async screenshot(options) { calls.push(['screenshot', options.type]); return Buffer.from('PNGDATA'); },
    async goBack() { calls.push(['back']); page.address = 'https://example.test/previous'; return {}; },
    listeners: {},
    on(event, handler) { (page.listeners[event] ??= []).push(handler); },
    emit(event, value) { for (const handler of page.listeners[event] ?? []) handler(value); },
  };
  const browser = {closed: 0, async newPage() { return page; }, async close() { browser.closed++; }, on() {}};
  return {browser, page, calls};
}

function launcher(fake = fakeBrowser()) {
  const launches = [];
  const launch = async options => { launches.push(options); return fake.browser; };
  return {launch, launches, fake};
}

test('every action returns bounded structured results and drives the page', async () => {
  const {launch, launches, fake} = launcher();
  const tool = createBrowserTool({launch});
  assert.equal(launches.length, 0, 'construction must not launch');

  const navigated = await tool.execute('1', {action: 'navigate', url: 'https://example.test/'});
  assert.deepEqual(launches, [{channel: 'chrome', headless: true}]);
  assert.deepEqual(navigated.structuredContent, {action: 'navigate', url: 'https://example.test/', title: 'Fixture page', status: 200, text: 'browser navigate: "Fixture page" https://example.test/'});
  assert.deepEqual(navigated.content, [{type: 'text', text: navigated.structuredContent.text}]);

  const snapshot = await tool.execute('2', {action: 'snapshot'});
  assert.equal(snapshot.structuredContent.truncated, false);
  assert.equal(snapshot.structuredContent.elements, 1);
  assert.match(snapshot.content[0].text, /\[e1\] button "Go"\nText:\nHello$/);

  assert.equal((await tool.execute('3', {action: 'click', selector: 'e1'})).structuredContent.action, 'click');
  await tool.execute('4', {action: 'click', selector: 'text=More'});
  await tool.execute('5', {action: 'type', selector: 'e2', text: ''});
  await tool.execute('6', {action: 'press', key: 'Enter'});
  const shot = await tool.execute('7', {action: 'screenshot'});
  assert.deepEqual(shot.content[1], {type: 'image', data: Buffer.from('PNGDATA').toString('base64'), mimeType: 'image/png'});
  assert.equal(shot.structuredContent.bytes, 7);
  const back = await tool.execute('8', {action: 'back'});
  assert.equal(back.structuredContent.url, 'https://example.test/previous');
  assert.equal(back.structuredContent.navigated, true);
  assert.deepEqual(fake.calls.filter(call => !['goto', 'evaluate'].includes(call[0])), [
    ['click', '[data-apex-ref="e1"]'], ['click', 'text=More'], ['fill', '[data-apex-ref="e2"]', ''], ['press', 'Enter'], ['screenshot', 'png'], ['back'],
  ]);

  assert.equal((await tool.execute('9', {action: 'close'})).structuredContent.closed, true);
  assert.equal(fake.browser.closed, 1);
  assert.equal((await tool.execute('10', {action: 'close'})).structuredContent.closed, false);
  await assert.rejects(tool.execute('11', {action: 'snapshot'}), /navigate first/);
  assert.equal(launches.length, 1, 'page actions never launch a browser');
});

test('invalid input fails before any launch', async () => {
  const {launch, launches} = launcher();
  const tool = createBrowserTool({launch});
  for (const [input, pattern] of [
    [undefined, /Invalid browser action/], [{action: 'eval'}, /Invalid browser action/],
    [{action: 'navigate'}, /requires url/], [{action: 'navigate', url: 'example.test'}, /absolute http or https/],
    [{action: 'navigate', url: 'file:///C:/Windows/win.ini'}, /refuses file:/], [{action: 'navigate', url: 'javascript:alert(1)'}, /refuses javascript:/],
    [{action: 'navigate', url: `https://example.test/${'a'.repeat(2048)}`}, /url must be/],
    [{action: 'click'}, /requires selector/], [{action: 'click', selector: ' '}, /selector must be/], [{action: 'click', selector: 'x'.repeat(1025)}, /selector must be/],
    [{action: 'type', selector: 'e1'}, /requires text/], [{action: 'type', selector: 'e1', text: 'a\0b'}, /text must be/], [{action: 'type', selector: 'e1', text: 7}, /text must be/],
    [{action: 'press'}, /requires key/], [{action: 'press', key: 'K'.repeat(65)}, /key must be/],
  ]) await assert.rejects(tool.execute('bad', input), pattern);
  assert.equal(launches.length, 0);
});

test('abort is checked before and after browser steps', async () => {
  const {launch, launches, fake} = launcher();
  const tool = createBrowserTool({launch});
  const aborted = AbortSignal.abort();
  await assert.rejects(tool.execute('a', {action: 'navigate', url: 'https://example.test/'}, aborted), /Browser operation aborted/);
  assert.equal(launches.length, 0);

  const controller = new AbortController();
  fake.page.goto = async () => { controller.abort(); return null; };
  await assert.rejects(tool.execute('b', {action: 'navigate', url: 'https://example.test/'}, controller.signal), /Browser operation aborted/);
  await assert.rejects(tool.execute('c', {action: 'snapshot'}, controller.signal), /Browser operation aborted/);
  await tool.close();
  assert.equal(fake.browser.closed, 1);
});

test('snapshots cap text bytes and element count and report truncation', async () => {
  const text = 'é'.repeat(8192);
  const elements = Array.from({length: 100}, (_, i) => ({ref: `e${i + 1}`, tag: 'a', name: `link ${i}`}));
  const {launch, fake} = launcher(fakeBrowser({snapshot: {title: 'T'.repeat(500), url: 'https://example.test/', text, textLength: 20000, elements, total: 150}}));
  const tool = createBrowserTool({launch});
  await tool.execute('1', {action: 'navigate', url: 'https://example.test/'});
  const {structuredContent} = await tool.execute('2', {action: 'snapshot'});
  assert.deepEqual(fake.calls.find(call => call[0] === 'evaluate')[1], {textChars: 8192, elementLimit: 100, nameChars: 80});
  assert.equal(structuredContent.truncated, true);
  assert.equal(structuredContent.textTruncated, true);
  assert.equal(structuredContent.elementsTruncated, true);
  assert.equal(structuredContent.textBytes, 8192);
  assert.equal(structuredContent.totalElements, 150);
  assert.equal(structuredContent.title.length, 200);
  assert.match(structuredContent.text, /Elements \(100 of 150\):/);
  await tool.close();
});

test('a missing browser names both channels and the next call retries', async () => {
  const tried = [];
  const tool = createBrowserTool({launch: async ({channel}) => { tried.push(channel); throw new Error(`Chromium distribution '${channel}' is not found\n    at stack`); }});
  await assert.rejects(tool.execute('1', {action: 'navigate', url: 'https://example.test/'}),
    error => /Google Chrome, then Microsoft Edge/.test(error.message) && /chrome: Chromium distribution 'chrome' is not found; msedge:/.test(error.message) && !/at stack/.test(error.message) && /never downloads/.test(error.message));
  assert.deepEqual(tried, ['chrome', 'msedge']);
  await assert.rejects(tool.execute('2', {action: 'navigate', url: 'https://example.test/'}), /could not launch/);
  assert.deepEqual(tried, ['chrome', 'msedge', 'chrome', 'msedge']);
});

test('Edge is used when Chrome is absent, and close during launch still closes it', async () => {
  const fake = fakeBrowser();
  let release;
  const tool = createBrowserTool({launch: ({channel}) => channel === 'chrome' ? Promise.reject(new Error('no chrome')) : new Promise(resolve => { release = () => resolve(fake.browser); })});
  const navigating = tool.execute('1', {action: 'navigate', url: 'https://example.test/'});
  while (!release) await Bun.sleep(1);
  const closing = tool.close();
  release();
  assert.equal(await closing, true);
  await navigating;
  assert.equal(fake.browser.closed, 1);
});

const consoleMessage = (type, text, url) => ({type: () => type, text: () => text, location: () => (url ? {url, lineNumber: 4, columnNumber: 2} : {url: ''})});
const lines = result => result.structuredContent.text.split('\n').slice(1);

test('console returns new warnings, errors, page errors and failed requests since the last read', async () => {
  const {launch, fake} = launcher();
  const tool = createBrowserTool({launch});
  await assert.rejects(tool.execute('0', {action: 'console'}), /navigate first/);
  fake.page.goto = async url => {
    fake.page.address = url;
    fake.page.emit('console', consoleMessage('log', 'booted'));
    fake.page.emit('console', consoleMessage('warning', 'deprecated\nAPI'));
    fake.page.emit('console', consoleMessage('error', 'boom', 'https://example.test/app.js'));
    const error = new Error('Uncaught x');
    error.stack = 'Error: Uncaught x\n    at run (https://example.test/app.js:9:7)';
    fake.page.emit('pageerror', error);
    fake.page.emit('requestfailed', {method: () => 'GET', url: () => 'https://example.test/missing.js', failure: () => ({errorText: 'net::ERR_FAILED'})});
    return {status: () => 200};
  };
  await tool.execute('1', {action: 'navigate', url: 'https://example.test/'});
  const first = await tool.execute('2', {action: 'console'});
  assert.deepEqual(lines(first), ['2 warn deprecated API', '3 error boom https://example.test/app.js:5:3',
    '4 pageerror Uncaught x https://example.test/app.js:9:7', '5 requestfailed GET https://example.test/missing.js: net::ERR_FAILED']);
  assert.deepEqual({level: first.structuredContent.level, entries: first.structuredContent.entries, dropped: first.structuredContent.dropped, truncated: first.structuredContent.truncated},
    {level: 'default', entries: 4, dropped: 0, truncated: false});
  assert.deepEqual(lines(await tool.execute('3', {action: 'console'})), ['(no new entries)']);

  fake.page.emit('console', consoleMessage('info', 'ready'));
  fake.page.emit('console', consoleMessage('assert', 'Assertion failed'));
  assert.deepEqual(lines(await tool.execute('4', {action: 'console', level: 'all'})), ['6 info ready', '7 assert Assertion failed']);
  fake.page.emit('console', consoleMessage('debug', 'quiet'));
  assert.deepEqual(lines(await tool.execute('5', {action: 'console', level: 'default'})), ['(no new entries)']);
  assert.deepEqual(lines(await tool.execute('6', {action: 'console', level: 'all'})), ['(no new entries)'], 'the cursor passed filtered entries');

  await tool.close();
  await assert.rejects(tool.execute('7', {action: 'console'}), /navigate first/);
  fake.page.goto = async url => { fake.page.address = url; return {status: () => 200}; };
  await tool.execute('8', {action: 'navigate', url: 'https://example.test/'});
  fake.page.emit('console', consoleMessage('error', 'after reopen'));
  assert.deepEqual(lines(await tool.execute('9', {action: 'console'})), ['1 error after reopen'], 'closing resets buffer and cursor');
  await tool.close();
});

test('console bounds the ring buffer, entry text, and each read', async () => {
  const {launch, fake} = launcher();
  const tool = createBrowserTool({launch});
  await tool.execute('1', {action: 'navigate', url: 'https://example.test/'});
  for (let index = 1; index <= 250; index++) fake.page.emit('console', consoleMessage('error', `e${index}`));
  const first = await tool.execute('2', {action: 'console'});
  assert.deepEqual([first.structuredContent.entries, first.structuredContent.remaining, first.structuredContent.dropped, first.structuredContent.truncated], [50, 150, 50, true]);
  assert.equal(lines(first)[0], '51 error e51');
  assert.deepEqual(lines(first).slice(-2), ['[150 more entries; call console again]', '[50 unread entries dropped; buffer keeps 200]']);
  const second = await tool.execute('3', {action: 'console'});
  assert.deepEqual([lines(second)[0], second.structuredContent.remaining, second.structuredContent.dropped], ['101 error e101', 100, 0]);
  await tool.execute('4', {action: 'console'});
  assert.equal((await tool.execute('5', {action: 'console'})).structuredContent.remaining, 0);

  for (let index = 0; index < 10; index++) fake.page.emit('console', consoleMessage('error', `${'é'.repeat(3000)}\nsecond line`, `https://example.test/${'p'.repeat(1000)}`));
  const wide = await tool.execute('6', {action: 'console'});
  assert.deepEqual([wide.structuredContent.entries, wide.structuredContent.remaining], [1, 9]);
  const [, , text, location] = lines(wide)[0].split(' ');
  assert.equal(text.length, 2000);
  assert.ok(text.endsWith('…'));
  assert.equal(location.length, 500);
  while ((await tool.execute('drain', {action: 'console'})).structuredContent.remaining) { /* one wide entry per read */ }
  for (let index = 0; index < 10; index++) fake.page.emit('console', consoleMessage('error', 'é'.repeat(3000)));
  const capped = await tool.execute('7', {action: 'console'});
  assert.equal(capped.structuredContent.entries, 2, 'two clipped entries fit the 8 KiB read cap');
  assert.ok(Buffer.byteLength(lines(capped).slice(0, 2).join('\n')) <= 8192);
  await tool.close();
});

test('console rejects an invalid level before any launch', async () => {
  const {launch, launches} = launcher();
  const tool = createBrowserTool({launch});
  await assert.rejects(tool.execute('1', {action: 'console', level: 'verbose'}), /level must be default or all/);
  await assert.rejects(tool.execute('2', {action: 'console', level: 3}), /level must be default or all/);
  assert.equal(launches.length, 0);
});

// The extension imports playwright-core only on the first browser call; this fake stands in for it.
const launched = [];
mock.module('playwright-core', () => ({chromium: {launch: async options => { const fake = fakeBrowser(); launched.push({options, fake}); return fake.browser; }}}));
const {default: apexContext} = await import('../extensions/apex-context/index.mjs');

function harness(flags) {
  const hooks = new Map(), tools = [];
  let active = ['read', 'bash'];
  const pi = {registerFlag() {}, getFlag: () => flags, on(name, callback) { hooks.set(name, callback); },
    registerTool(tool) { tools.push(tool); }, getActiveTools: () => [...active], setActiveTools(names) { active = [...names]; }, getAllTools: () => tools, appendEntry() {}};
  const ctx = {cwd: process.cwd(), sessionManager: {getBranch: () => []}};
  apexContext(pi);
  return {tools, active: () => active, emit: (name, event = {}) => hooks.get(name)(event, ctx)};
}

test('the browser tool is registered and active only with the browser flag', async () => {
  const off = harness('read');
  await off.emit('session_start');
  assert.equal(off.tools.some(tool => tool.name === 'browser'), false);
  assert.equal(off.active().includes('browser'), false);

  const on = harness('browser');
  await on.emit('session_start');
  assert.deepEqual(on.tools.map(tool => tool.name), ['browser']);
  assert.deepEqual(on.active(), ['read', 'bash', 'browser']);
  assert.equal(launched.length, 0, 'registration never launches a browser');
  await on.emit('session_shutdown');
});

test('session shutdown and re-initialisation close the launched browser', async () => {
  launched.length = 0;
  const h = harness('browser');
  await h.emit('session_start');
  await h.tools[0].execute('1', {action: 'navigate', url: 'https://example.test/'});
  assert.deepEqual(launched.map(entry => entry.options), [{channel: 'chrome', headless: true}]);
  for (const event of ['session_tree', 'session_fork', 'session_start']) {
    await h.tools.at(-1).execute('n', {action: 'navigate', url: 'https://example.test/'});
    const before = launched.at(-1).fake.browser;
    await h.emit(event);
    assert.equal(before.closed, 1, `${event} must close the previous browser`);
  }
  await h.tools.at(-1).execute('last', {action: 'navigate', url: 'https://example.test/'});
  await h.emit('session_shutdown');
  assert.equal(launched.at(-1).fake.browser.closed, 1);
  assert.ok(launched.every(entry => entry.fake.browser.closed === 1), 'no browser leaks');
});
