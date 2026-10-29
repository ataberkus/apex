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
