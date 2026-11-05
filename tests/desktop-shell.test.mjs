import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {linkAction, parseReady, restoreBounds, startupUrl, tail, versionLabel} from '../desktop/shell.mjs';

test('versionLabel names a Git checkout instead of showing 0.0.0', () => {
  assert.equal(versionLabel('0.0.8'), '0.0.8');
  assert.equal(versionLabel('0.0.0'), '(development checkout)');
});

const page = 'file:///C:/apex/desktop/startup.html';
const origin = 'http://127.0.0.1:53121';

test('parseReady accepts only a loopback dashboard URL with a token', () => {
  assert.equal(parseReady('{"apexDashboard":"http://127.0.0.1:53121/?t=abc"}'), 'http://127.0.0.1:53121/?t=abc');
  for (const line of ['Apex dashboard: http://127.0.0.1:1/?t=x', '{"apexDashboard":"http://127.0.0.1:53121.evil.example/?t=x"}', '{"apexDashboard":"https://127.0.0.1:53121/?t=x"}',
    '{"apexDashboard":"http://127.0.0.1:53121/"}', '{"apexDashboard":42}', '{', 'null', ''])
    assert.equal(parseReady(line), null, line);
});

test('linkAction keeps the window on the dashboard and sends everything else to the browser or drops it', () => {
  assert.equal(linkAction(`${origin}/api/state`, origin, page), 'allow');
  assert.equal(linkAction(`${page}?state=failed&detail=x`, origin, page), 'allow');
  assert.equal(linkAction(`${page}?state=retry`, null, page), 'retry');
  assert.equal(linkAction('https://chatgpt.com/auth', origin, page), 'external');
  assert.equal(linkAction('http://127.0.0.1:4777/', origin, page), 'external');
  assert.equal(linkAction('mailto:someone@example.com', origin, page), 'external');
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/System32/calc.exe', 'apex:retry', 'not a url', 'https://user:pw@example.com/'])
    assert.equal(linkAction(url, origin, page), 'drop', url);
});

test('startupUrl carries state and detail as query text', () => {
  const url = new URL(startupUrl(page, 'failed', 'line 1\n<b>& "x"'));
  assert.equal(url.href.split('?')[0], page);
  assert.equal(url.searchParams.get('state'), 'failed');
  assert.equal(url.searchParams.get('detail'), 'line 1\n<b>& "x"');
  assert.equal(new URL(startupUrl(page, 'starting')).searchParams.has('detail'), false);
});

test('restoreBounds keeps saved bounds that are big enough and on a screen, including a left-hand monitor', () => {
  const screens = [{x: 0, y: 0, width: 1920, height: 1040}, {x: -1920, y: 0, width: 1920, height: 1040}];
  assert.deepEqual(restoreBounds({x: 100, y: 50, width: 1200, height: 800, maximized: true}, screens), {x: 100, y: 50, width: 1200, height: 800, maximized: true});
  assert.deepEqual(restoreBounds({x: -1500, y: 10, width: 1000, height: 700}, screens), {x: -1500, y: 10, width: 1000, height: 700, maximized: false});
});

test('restoreBounds falls back to the default size when saved bounds are off-screen, tiny or malformed', () => {
  const screens = [{x: 0, y: 0, width: 1920, height: 1040}];
  for (const saved of [null, {}, 'x', {x: 3000, y: 0, width: 1200, height: 800}, {x: 1870, y: 0, width: 1200, height: 800}, {x: 0, y: 0, width: 200, height: 100}, {x: 'a', y: 0, width: 1200, height: 800}])
    assert.deepEqual(restoreBounds(saved, screens), {width: 1400, height: 900, maximized: false}, JSON.stringify(saved));
});

test('tail keeps only the most recent text', () => {
  assert.equal(tail('ab', 'cd', 3), 'bcd');
  assert.equal(tail('', 'x'.repeat(9000)).length, 8192);
});

test('desktop/icon.ico is a valid PNG-in-ICO with the standard Windows sizes', () => {
  const ico = readFileSync(new URL('../desktop/icon.ico', import.meta.url));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1, 'icon type');
  const count = ico.readUInt16LE(4), sizes = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + 16 * i, size = ico[entry] || 256, length = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
    assert.equal(ico.subarray(offset, offset + 8).toString('hex'), '89504e470d0a1a0a', `PNG at ${size}px`);
    assert.equal(ico.readUInt32BE(offset + 16), size, 'PNG width matches the directory entry');
    assert.ok(offset + length <= ico.length);
    sizes.push(size);
  }
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
});
