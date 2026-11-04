# Apex Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native Windows "Apex" app window (Start-menu/desktop shortcut, own taskbar identity) that starts, shows and stops the existing Apex dashboard by itself.

**Architecture:** An Electron main process (`desktop/main.mjs`) spawns the unchanged dashboard server on system Node with two new flags (`--port 0 --desktop`), reads a JSON ready line for the tokenised URL, and loads it in a sandboxed, navigation-locked `BrowserWindow`. Closing the window ends the server's stdin, which triggers the server's existing graceful shutdown. Electron-free logic lives in `desktop/shell.mjs` so `node:test` covers it.

**Tech Stack:** Node ≥22.19 (ESM `.mjs`), Electron 44.5.1 (pinned devDependency), `node:test`, no other new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-03-desktop-app-design.md`

## Global Constraints

- Work in a separate git worktree off `multi-model-pair-dashboard` (another session is editing the main working tree); commit only files this plan names.
- Node ≥22.19.0; ESM `.mjs`; no new runtime dependencies. `electron` is a **devDependency pinned exactly to `44.5.1`**.
- `npm run dashboard` must behave exactly as before; without `--desktop` the server never reads stdin and prints no JSON line.
- Server port precedence: `--port` > `APEX_DASH_PORT` > `4777`; `0` = any free port.
- Ready line, exactly: `{"apexDashboard":"http://127.0.0.1:<port>/?t=<token>"}`.
- Window: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no preload. The window never leaves the dashboard origin (or `desktop/startup.html`).
- AppUserModelID: `Apex.Desktop`. userData folder: `%APPDATA%\Apex Desktop`.
- Timeouts: server ready 30 s; graceful shutdown 5 s then kill. Stderr tail kept: 8 KiB.
- Match repository style: terse one-line comments explaining *why*, two-space indent, single quotes, long lines allowed.

## Review Focus

1. **Smoke run while the user's own Apex window is open** — the smoke must not hit the single-instance lock or share window state; smoke mode skips the lock and uses a temporary userData folder (Task 4, smoke script run with app open in manual acceptance).
2. **Saved window position on a monitor that is no longer attached** — window must open visible at the default size (Task 2, `restoreBounds` off-screen tests).
3. **Hostile or odd links in chat answers** (`javascript:`, `file:`, credentials in URL, look-alike `127.0.0.1:53121.evil` ready lines) — dropped, never navigated or opened (Task 2, `linkAction`/`parseReady` tests).
4. **Bad port input** (`--port abc`, `--port` with no value, `70000`, junk `APEX_DASH_PORT`) — clear error, exit code 2, no half-started server (Task 1 test).
5. **Sign-in popup and chat links in the real Electron window** — must reach the default browser and leave the Apex window on the dashboard (Task 4 smoke probes with `openExternal` recorded).

---

### Task 1: Dashboard server `--port` and `--desktop` flags

**Files:**
- Modify: `dashboard/server.mjs` (the `const port = …` line near line 27; the block from `server.on('error', …)` to end of file, lines ~469–480)
- Create: `tests/dashboard-desktop.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: CLI contract used by Task 4 — `node dashboard/server.mjs --port 0 --desktop` prints one stdout line `{"apexDashboard":"http://127.0.0.1:<port>/?t=<token>"}` after listening, and exits 0 when its stdin ends. Invalid port → stderr `Port must be a whole number from 0 to 65535, got "<text>".`, exit 2.

- [ ] **Step 1: Write the failing tests**

Create `tests/dashboard-desktop.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const server = fileURLToPath(new URL('../dashboard/server.mjs', import.meta.url));

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({host: '127.0.0.1', port, path, headers: {host: `127.0.0.1:${port}`, ...headers}}, res => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject);
  });
}

// Starts the real dashboard server against a throwaway home; no session or model call is ever made.
async function start(t, args, env = {}) {
  const home = await mkdtemp(join(tmpdir(), 'apex-desktop-test-'));
  const child = spawn(process.execPath, [server, ...args], {env: {...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), ...env}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    await rm(home, {recursive: true, force: true});
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const lines = [];
  createInterface({input: child.stdout}).on('line', line => lines.push(line));
  const exited = once(child, 'exit').then(([code]) => ({code, stderr}));
  return {child, lines, exited};
}
const waitFor = async (check, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await delay(50)) { const value = check(); if (value) return value; }
  throw new Error('timed out');
};

test('--port 0 --desktop binds a free port, prints a ready line and accepts only that port as Host', async t => {
  const {lines} = await start(t, ['--port', '0', '--desktop']);
  const ready = await waitFor(() => lines.find(line => line.startsWith('{')));
  const url = new URL(JSON.parse(ready).apexDashboard);
  const port = Number(url.port);
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(port > 0 && port !== 4777, `free port, got ${port}`);
  const login = await get(port, `/?t=${url.searchParams.get('t')}`);
  assert.equal(login.statusCode, 302);
  const cookie = {cookie: login.headers['set-cookie'][0].split(';')[0]};
  assert.equal((await get(port, '/api/state', cookie)).statusCode, 200);
  for (const host of ['127.0.0.1:0', '127.0.0.1:4777']) assert.equal((await get(port, '/api/state', {...cookie, host})).statusCode, 403, host);
});

test('closing stdin stops a --desktop server cleanly', async t => {
  const {child, lines, exited} = await start(t, ['--port', '0', '--desktop']);
  await waitFor(() => lines.find(line => line.startsWith('{')));
  child.stdin.end();
  const {code} = await Promise.race([exited, delay(5000).then(() => ({code: 'still running after 5 s'}))]);
  assert.equal(code, 0);
});

test('without --desktop the server prints no ready line and ignores stdin closing', async t => {
  const {child, lines} = await start(t, ['--port', '0']);
  await waitFor(() => lines.find(line => line.startsWith('Apex dashboard: ')));
  child.stdin.end();
  await delay(1000);
  assert.equal(child.exitCode, null, 'still running');
  assert.equal(lines.some(line => line.startsWith('{')), false);
});

test('--port overrides APEX_DASH_PORT, and an invalid port is refused with exit code 2', async t => {
  const ok = await start(t, ['--port', '0'], {APEX_DASH_PORT: 'not-a-port'});
  await waitFor(() => ok.lines.find(line => line.startsWith('Apex dashboard: ')));
  for (const [args, env] of [[['--port', 'abc'], {}], [['--port'], {}], [['--port', '70000'], {}], [[], {APEX_DASH_PORT: 'not-a-port'}]]) {
    const {code, stderr} = await (await start(t, args, env)).exited;
    assert.equal(code, 2, JSON.stringify({args, env}));
    assert.match(stderr, /Port must be a whole number from 0 to 65535/);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/dashboard-desktop.test.mjs`
Expected: FAIL — the first two time out (no `{` line), the invalid-port test fails (`listen` throws or code ≠ 2). The "without --desktop" test may already pass.

- [ ] **Step 3: Implement the port flag**

In `dashboard/server.mjs` replace:

```js
const port = Number(process.env.APEX_DASH_PORT ?? 4777);
```

with:

```js
const portFlag = process.argv.indexOf('--port');
const portText = portFlag < 0 ? process.env.APEX_DASH_PORT ?? '4777' : process.argv[portFlag + 1] ?? '';
let port = /^\d+$/.test(portText) ? Number(portText) : NaN; // becomes the bound port once listening, so --port 0 picks a free one
if (!(port <= 65535)) { console.error(`Port must be a whole number from 0 to 65535, got "${portText}".`); process.exit(2); }
const desktop = process.argv.includes('--desktop'); // started by the Electron shell: ready line on stdout, stops when stdin closes
```

(`port` stays the variable the Host check `['127.0.0.1:' + port, 'localhost:' + port]` already reads, so updating it after `listen` is enough.)

- [ ] **Step 4: Implement the ready line and stdin shutdown**

Replace the end of `dashboard/server.mjs`, from `server.on('error', …` to the last line (the `for (const signal of ['SIGINT', 'SIGTERM'])` line), with:

```js
server.on('error', error => { console.error(error.message); process.exit(1); });
server.listen(port, '127.0.0.1', () => {
  port = server.address().port;
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  console.log(`Apex dashboard: ${url}`);
  if (desktop) return console.log(JSON.stringify({apexDashboard: url}));
  if (!process.argv.includes('--open')) return;
  const opener = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  spawn(opener, args, {detached: true, stdio: 'ignore', windowsHide: true})
    .on('error', error => console.warn(`Could not open the browser: ${error.message}. Open the URL above instead.`))
    .unref();
});
function shutdown() {
  for (const login of Object.values(logins)) if (login.flow) void login.cancel(login.flow.id);
  for (const session of live.values()) session.child.stdin.end();
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
// Windows kills child processes without signals, so the desktop shell asks for shutdown by closing stdin.
if (desktop) { process.stdin.on('end', shutdown); process.stdin.resume(); }
```

- [ ] **Step 5: Run the new tests and the existing dashboard tests**

Run: `node --test tests/dashboard-desktop.test.mjs tests/dashboard.test.mjs tests/dashboard-images.test.mjs`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/server.mjs tests/dashboard-desktop.test.mjs
git commit -m "Add --port and --desktop flags to the dashboard server"
```

---

### Task 2: Electron-free shell helpers

**Files:**
- Create: `desktop/shell.mjs`
- Create: `tests/desktop-shell.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Task 4's `desktop/main.mjs`):
  - `parseReady(line: string): string | null` — the dashboard URL from a ready line, or null.
  - `linkAction(url: string, origin: string | null, startupPage: string): 'allow' | 'retry' | 'external' | 'drop'` — `startupPage` is the `file:` URL of `startup.html` without query.
  - `startupUrl(startupPage: string, state: 'starting' | 'failed', detail?: string): string`
  - `restoreBounds(saved: unknown, workAreas: {x,y,width,height}[]): {x?, y?, width, height, maximized: boolean}`
  - `tail(previous: string, chunk: string, limit = 8192): string`

- [ ] **Step 1: Write the failing tests**

Create `tests/desktop-shell.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {linkAction, parseReady, restoreBounds, startupUrl, tail} from '../desktop/shell.mjs';

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/desktop-shell.test.mjs`
Expected: FAIL with `Cannot find module '…/desktop/shell.mjs'`.

- [ ] **Step 3: Implement `desktop/shell.mjs`**

```js
// Electron-free helpers for the desktop shell, so node:test can cover them.

// The dashboard prints {"apexDashboard": url} once listening; trust only a tokenised loopback URL.
export function parseReady(line) {
  let url;
  try { url = new URL(JSON.parse(line)?.apexDashboard); } catch { return null; }
  return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.searchParams.has('t') ? url.href : null;
}

// What the window does with a navigation: stay, restart the server, hand it to the browser, or ignore it.
export function linkAction(url, origin, startupPage) {
  let parsed;
  try { parsed = new URL(url); } catch { return 'drop'; }
  if (origin && parsed.origin === origin) return 'allow';
  if (url.split(/[?#]/)[0] === startupPage) return parsed.searchParams.get('state') === 'retry' ? 'retry' : 'allow';
  if (parsed.username || parsed.password) return 'drop';
  return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? 'external' : 'drop';
}

export function startupUrl(startupPage, state, detail) {
  return `${startupPage}?${new URLSearchParams(detail ? {state, detail} : {state})}`;
}

// Saved bounds are reused only when large enough and at least 100 px of them is on some screen.
export function restoreBounds(saved, workAreas) {
  const valid = saved && typeof saved === 'object' && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved[key]))
    && saved.width >= 900 && saved.height >= 600
    && workAreas.some(area => Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x) >= 100
      && Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y) >= 100);
  return valid ? {x: saved.x, y: saved.y, width: saved.width, height: saved.height, maximized: saved.maximized === true} : {width: 1400, height: 900, maximized: false};
}

export const tail = (previous, chunk, limit = 8192) => (previous + chunk).slice(-limit);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/desktop-shell.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/shell.mjs tests/desktop-shell.test.mjs
git commit -m "Add Electron-free desktop shell helpers"
```

---

### Task 3: App icon

**Files:**
- Create: `scripts/make-desktop-icon.mjs`
- Create: `desktop/icon.ico` (generated, committed)
- Modify: `tests/desktop-shell.test.mjs` (append one test)

**Interfaces:**
- Produces: `desktop/icon.ico` — PNG-in-ICO, sizes 16, 24, 32, 48, 64, 128, 256. Used by Task 4 (`BrowserWindow.icon`, shortcut icon).

- [ ] **Step 1: Write the failing test**

Append to `tests/desktop-shell.test.mjs`:

```js
import {readFileSync} from 'node:fs';

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
```

(Move the `readFileSync` import up to the other imports at the top of the file.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/desktop-shell.test.mjs`
Expected: FAIL with `ENOENT … desktop/icon.ico`.

- [ ] **Step 3: Write the generator**

Create `scripts/make-desktop-icon.mjs`:

```js
// Writes desktop/icon.ico: a monogram "A" in the dashboard's rail colours, as PNG-in-ICO from 16 to 256 px. No dependencies.
import {writeFileSync} from 'node:fs';
import {crc32, deflateSync} from 'node:zlib';

const RAIL = [0x1b, 0x1d, 0x33], MARK = [0xb7, 0xae, 0xff];
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// Distances in unit-square coordinates; coverage = how far inside the edge a pixel centre is, in pixels.
const segment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const roundedSquare = (px, py, r) => Math.hypot(Math.max(Math.abs(px - 0.5) - (0.5 - r), 0), Math.max(Math.abs(py - 0.5) - (0.5 - r), 0)) - r;
const coverage = (distance, size) => Math.min(1, Math.max(0, 0.5 - distance * size));

function rows(size) {
  const stride = size * 4 + 1, data = Buffer.alloc(size * stride); // each row starts with PNG filter byte 0
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = (x + 0.5) / size, py = (y + 0.5) / size;
    const glyph = Math.min(segment(px, py, 0.5, 0.2, 0.27, 0.8), segment(px, py, 0.5, 0.2, 0.73, 0.8), segment(px, py, 0.36, 0.58, 0.64, 0.58)) - 0.075;
    const ink = coverage(glyph, size), at = y * stride + 1 + x * 4;
    for (let c = 0; c < 3; c++) data[at + c] = Math.round(RAIL[c] + (MARK[c] - RAIL[c]) * ink);
    data[at + 3] = Math.round(coverage(roundedSquare(px, py, 0.22), size) * 255);
  }
  return data;
}

const chunk = (type, body) => {
  const head = Buffer.alloc(8), crc = Buffer.alloc(4);
  head.writeUInt32BE(body.length); head.write(type, 4, 'ascii');
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
  return Buffer.concat([head, body, crc]);
};
function png(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows(size))), chunk('IEND', Buffer.alloc(0))]);
}

const images = SIZES.map(png), directory = Buffer.alloc(6 + 16 * SIZES.length);
directory.writeUInt16LE(1, 2); directory.writeUInt16LE(SIZES.length, 4);
let offset = directory.length;
SIZES.forEach((size, i) => {
  const entry = 6 + 16 * i;
  directory[entry] = directory[entry + 1] = size % 256; // 0 means 256
  directory.writeUInt16LE(1, entry + 4); directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(images[i].length, entry + 8); directory.writeUInt32LE(offset, entry + 12);
  offset += images[i].length;
});
writeFileSync(new URL('../desktop/icon.ico', import.meta.url), Buffer.concat([directory, ...images]));
console.log(`desktop/icon.ico: ${SIZES.join(', ')} px`);
```

- [ ] **Step 4: Generate the icon and run the test**

Run: `node scripts/make-desktop-icon.mjs && node --test tests/desktop-shell.test.mjs`
Expected: prints `desktop/icon.ico: 16, 24, 32, 48, 64, 128, 256 px`; all tests PASS.

- [ ] **Step 5: Look at it**

Open `desktop/icon.ico` with the Read tool (or Explorer preview). Expected: a lavender "A" on a dark navy rounded square. If the glyph looks off, adjust the segment endpoints in `rows()`, regenerate, re-run the test.

- [ ] **Step 6: Commit**

```bash
git add scripts/make-desktop-icon.mjs desktop/icon.ico tests/desktop-shell.test.mjs
git commit -m "Add generated Apex desktop icon"
```

---

### Task 4: Electron shell, startup page and smoke test

**Files:**
- Create: `desktop/main.mjs`
- Create: `desktop/startup.html`
- Create: `scripts/smoke-desktop.mjs`
- Modify: `package.json` (devDependency, scripts, `files`), `package-lock.json` (via npm)
- Modify: `scripts/check.mjs:21` (add `'desktop'` to the syntax-checked directories)

**Interfaces:**
- Consumes: Task 1 CLI contract; Task 2 `parseReady`, `linkAction`, `startupUrl`, `restoreBounds`, `tail` from `./shell.mjs`; Task 3 `desktop/icon.ico`.
- Produces: `electron desktop/main.mjs [--smoke | --install-shortcuts]`. In `--smoke` mode prints exactly one stdout line `{"smoke":{…}}` — success shape `{"title":"Apex","state":200,"opened":[…3 URLs sorted],"stayed":true,"serverPid":<n>}`, failure shape `{"error":"<detail>"}` with exit code 1.

- [ ] **Step 1: Install Electron**

Run: `npm install --save-dev --save-exact electron@44.5.1`
Expected: `package.json` gains `"electron": "44.5.1"` under `devDependencies`; `node_modules/electron/dist/electron.exe` exists. (If installed with `--ignore-scripts`, run `node node_modules/electron/install.js` to download the binary.)

- [ ] **Step 2: Add scripts and package files**

In `package.json` `scripts`, after `"dashboard": …`, add:

```json
    "desktop": "electron desktop/main.mjs",
    "desktop:shortcut": "electron desktop/main.mjs --install-shortcuts",
    "smoke:desktop": "node scripts/smoke-desktop.mjs",
```

In `files`, after `"dashboard",` add `"desktop",`.

In `scripts/check.mjs` line 21, change `['lib', 'scripts', 'tests', 'evals', 'evolve', 'extensions', 'skills', 'dashboard']` to `['lib', 'scripts', 'tests', 'evals', 'evolve', 'extensions', 'skills', 'dashboard', 'desktop']`.

- [ ] **Step 3: Write the smoke script (the failing test)**

Create `scripts/smoke-desktop.mjs`:

```js
// Launches the desktop shell in smoke mode, checks the dashboard loaded and links left the window, then proves the server is gone.
import electron from 'electron';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const main = fileURLToPath(new URL('../desktop/main.mjs', import.meta.url));
const home = await mkdtemp(join(tmpdir(), 'apex-desktop-smoke-'));
const env = {...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent')};
delete env.ELECTRON_RUN_AS_NODE; // set by some editors' terminals; it would make electron.exe act as plain Node
const child = spawn(electron, [main, '--smoke'], {env, stdio: ['ignore', 'pipe', 'inherit']});
let out = '';
child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
const timer = setTimeout(() => child.kill(), 90_000);
const [code] = await once(child, 'exit');
clearTimeout(timer);
const line = out.split(/\r?\n/).find(text => text.startsWith('{"smoke"'));
const result = line ? JSON.parse(line).smoke : {error: `no smoke result; output: ${out.trim() || '(none)'}`};
let serverGone = true;
if (result.serverPid) try { process.kill(result.serverPid, 0); serverGone = false; } catch { /* ESRCH: exited */ }
await rm(home, {recursive: true, force: true});
const expected = ['https://example.com/apex-smoke/new-window', 'https://example.com/apex-smoke/same-window', 'https://example.com/apex-smoke/sign-in'];
const ok = code === 0 && result.title === 'Apex' && result.state === 200 && result.stayed === true
  && JSON.stringify(result.opened) === JSON.stringify(expected) && serverGone;
console.log(JSON.stringify({ok, code, ...result, serverGone}, null, 1));
process.exit(ok ? 0 : 1);
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm run smoke:desktop`
Expected: FAIL — `"ok": false`, Electron reports it cannot find `desktop/main.mjs`.

- [ ] **Step 5: Write the startup page**

Create `desktop/startup.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<meta name="color-scheme" content="dark light">
<title>Apex</title>
<style>
  :root { --paper:#0F111C; --ink:#E4E5F1; --muted:#9A9FBD; --line:#272A42; --mark:#ABA1FF; }
  @media (prefers-color-scheme: light) { :root { --paper:#F1F2F6; --ink:#191B2A; --muted:#5A5F77; --line:#D8DBE5; --mark:#4636D6; } }
  html, body { margin:0; height:100%; background:var(--paper); color:var(--ink); font:15px/1.5 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif; }
  main { max-width:720px; margin:0 auto; padding:18vh 24px 24px; }
  h1 { font:600 28px Bahnschrift,"Segoe UI",sans-serif; margin:0 0 8px; color:var(--mark); }
  p { margin:0 0 16px; color:var(--muted); }
  pre { white-space:pre-wrap; max-height:45vh; overflow:auto; padding:12px; border:1px solid var(--line); border-radius:6px; font:13px "Cascadia Mono",Consolas,monospace; }
  a { display:inline-block; padding:8px 16px; border-radius:6px; background:var(--mark); color:var(--paper); text-decoration:none; font-weight:600; }
</style>
</head>
<body>
<main>
  <h1>Apex</h1>
  <p id="status" role="status">Starting Apex…</p>
  <pre id="detail" hidden></pre>
  <a id="retry" href="?state=retry" hidden>Retry</a>
</main>
<script>
  const query = new URLSearchParams(location.search);
  if (query.get('state') === 'failed') {
    document.getElementById('status').textContent = 'Apex could not start.';
    const detail = document.getElementById('detail');
    detail.textContent = query.get('detail') || '';
    detail.hidden = !detail.textContent;
    document.getElementById('retry').hidden = false;
  }
</script>
</body>
</html>
```

- [ ] **Step 6: Write the Electron main process**

Create `desktop/main.mjs`:

```js
// Apex desktop shell: one native window over the local dashboard, whose server it starts and stops itself.
import {app, BrowserWindow, screen, shell} from 'electron';
import {spawn} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {linkAction, parseReady, restoreBounds, startupUrl, tail} from './shell.mjs';

const APP_ID = 'Apex.Desktop';
const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '..');
const serverPath = join(root, 'dashboard', 'server.mjs');
const iconPath = join(here, 'icon.ico');
const startupPage = pathToFileURL(join(here, 'startup.html')).href;
const smoke = process.argv.includes('--smoke');
const opened = []; // smoke mode records external links instead of opening a browser
const openExternal = url => { if (smoke) opened.push(url); else void shell.openExternal(url); };

app.setName('Apex');
app.setAppUserModelId(APP_ID);
app.setPath('userData', smoke ? join(app.getPath('temp'), `apex-desktop-smoke-${process.pid}`) : join(app.getPath('appData'), 'Apex Desktop'));

let win = null, child = null, origin = null, stderr = '', quitting = false, smoked = false;

const boundsFile = () => join(app.getPath('userData'), 'window.json');
function loadBounds() {
  let saved = null;
  try { saved = JSON.parse(readFileSync(boundsFile(), 'utf8')); } catch { /* first launch or unreadable: default size */ }
  return restoreBounds(saved, screen.getAllDisplays().map(display => display.workArea));
}
function saveBounds() {
  if (smoke) return;
  try {
    mkdirSync(app.getPath('userData'), {recursive: true});
    writeFileSync(boundsFile(), JSON.stringify({...win.getNormalBounds(), maximized: win.isMaximized()}));
  } catch { /* losing the window position is harmless */ }
}

function startServer() {
  if (child) return;
  origin = null; stderr = '';
  void win.loadURL(startupUrl(startupPage, 'starting'));
  // System Node, not Electron's: the server and its Pi children need the user's Node >=22.19 as process.execPath.
  const proc = child = spawn(process.env.APEX_NODE || 'node', [serverPath, '--port', '0', '--desktop'], {cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  const timer = setTimeout(() => fail(proc, 'Apex did not start within 30 seconds.'), 30_000);
  proc.on('error', error => fail(proc, error.code === 'ENOENT' ? 'Node was not found on PATH. Install Node 22.19 or newer, or set APEX_NODE to node.exe.' : error.message));
  proc.stdin.on('error', () => {}); // the pipe closes if the server already exited
  proc.stderr.setEncoding('utf8').on('data', chunk => { stderr = tail(stderr, chunk); });
  createInterface({input: proc.stdout}).on('line', line => {
    const url = parseReady(line);
    if (!url || origin || proc !== child) return;
    clearTimeout(timer);
    origin = new URL(url).origin;
    void win.loadURL(url);
  });
  proc.on('exit', code => { clearTimeout(timer); if (!quitting) fail(proc, `Apex stopped (exit code ${code ?? 'unknown'}).`); });
}

function fail(proc, message) {
  if (proc !== child) return;
  child = null; origin = null;
  if (proc.exitCode === null && proc.signalCode === null) proc.kill();
  const detail = [message, stderr.trim()].filter(Boolean).join('\n\n');
  if (smoke) { console.log(JSON.stringify({smoke: {error: detail}})); app.exit(1); return; }
  void win.loadURL(startupUrl(startupPage, 'failed', detail));
}

// The dashboard pre-opens a blank popup for sign-in, then points it at the provider; that page belongs in the real browser.
function handOffPopup(popup) {
  let handed = false;
  const handOff = url => {
    if (handed || !/^https?:/i.test(url)) return false;
    handed = true;
    openExternal(url);
    setImmediate(() => { if (!popup.isDestroyed()) popup.destroy(); });
    return true;
  };
  popup.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  popup.webContents.on('will-navigate', (event, url) => { if (handOff(url)) event.preventDefault(); });
  popup.webContents.on('will-redirect', (event, url) => { if (handOff(url)) event.preventDefault(); });
  popup.webContents.on('did-start-navigation', details => { if (handOff(details.url)) popup.webContents.stop(); });
}

async function runSmoke() {
  const contents = win.webContents;
  const page = await contents.executeJavaScript(`fetch('/api/state').then(response => ({title: document.title, state: response.status}))`);
  await contents.executeJavaScript(`(() => {
    const popup = window.open('about:blank', '_blank');
    popup.location.replace('https://example.com/apex-smoke/sign-in');
    const follow = (href, target) => { const a = document.createElement('a'); a.href = href; if (target) a.target = target; document.body.append(a); a.click(); a.remove(); };
    follow('https://example.com/apex-smoke/new-window', '_blank');
    follow('https://example.com/apex-smoke/same-window');
  })()`, true);
  await new Promise(done => setTimeout(done, 1500));
  console.log(JSON.stringify({smoke: {...page, opened: [...opened].sort(), stayed: contents.getURL().startsWith(origin), serverPid: child?.pid}}));
  app.quit();
}

function createWindow() {
  const {maximized, ...bounds} = loadBounds();
  win = new BrowserWindow({...bounds, minWidth: 900, minHeight: 600, title: 'Apex', icon: iconPath, autoHideMenuBar: true, backgroundColor: '#0F111C', show: false,
    webPreferences: {contextIsolation: true, nodeIntegration: false, sandbox: true}});
  if (maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', saveBounds);
  const contents = win.webContents;
  contents.on('will-navigate', (event, url) => {
    const action = linkAction(url, origin, startupPage);
    if (action === 'allow') return;
    event.preventDefault();
    if (action === 'retry') startServer();
    if (action === 'external') openExternal(url);
  });
  contents.setWindowOpenHandler(({url}) => {
    if (url === 'about:blank') return {action: 'allow', overrideBrowserWindowOptions: {show: false}};
    if (linkAction(url, origin, startupPage) === 'external') openExternal(url);
    return {action: 'deny'};
  });
  contents.on('did-create-window', handOffPopup);
  contents.on('did-finish-load', () => {
    if (smoke && !smoked && origin && contents.getURL().startsWith(origin)) { smoked = true; void runSmoke(); }
  });
}

if (process.argv.includes('--install-shortcuts')) {
  app.whenReady().then(() => {
    const links = [join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Apex.lnk'), join(app.getPath('desktop'), 'Apex.lnk')];
    const options = {target: process.execPath, args: `"${fileURLToPath(import.meta.url)}"`, cwd: root, icon: iconPath, iconIndex: 0, appUserModelId: APP_ID, description: 'Apex coding agent'};
    for (const link of links) if (!shell.writeShortcutLink(link, 'create', options)) { console.error(`Could not write ${link}`); app.exit(1); return; }
    console.log(`Created:\n${links.join('\n')}`);
    app.exit(0);
  });
} else if (!smoke && !app.requestSingleInstanceLock()) {
  app.quit(); // the running window is focused by its second-instance handler
} else {
  app.on('second-instance', () => { if (!win) return; if (win.isMinimized()) win.restore(); win.focus(); });
  app.on('window-all-closed', () => app.quit());
  // Closing stdin runs the server's own shutdown (cancel logins, end each agent's stdin); kill only if it hangs.
  app.on('before-quit', event => {
    const proc = child;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    const force = setTimeout(() => proc.kill(), 5000);
    proc.once('exit', () => { clearTimeout(force); child = null; app.quit(); });
    proc.stdin.end();
  });
  app.whenReady().then(() => { createWindow(); startServer(); });
}
```

- [ ] **Step 7: Run the smoke test to verify it passes**

Run: `npm run smoke:desktop`
Expected: exit 0 and JSON with `"ok": true`, `"title": "Apex"`, `"state": 200`, `"stayed": true`, `"opened"` listing the three `example.com/apex-smoke/…` URLs, `"serverGone": true`. An Apex window flashes up briefly; no browser tab opens.

If `opened` lacks `…/sign-in`, the popup interception did not fire: check which of `will-navigate` / `will-redirect` / `did-start-navigation` Electron 44 emits for `location.replace` on a popup (add a temporary `console.error` in each), keep the one that fires, re-run. Do not weaken the assertion — the spec's fallback (the dialog's visible link) is a fallback, not the design.

- [ ] **Step 8: Run the full Windows checks**

Run: `npm run check:windows` then `node --test tests/desktop-shell.test.mjs tests/dashboard-desktop.test.mjs tests/dashboard.test.mjs`
Expected: check prints `Native Windows syntax, JSON, package resources and Pi checks passed.` (if it exits 2 on preflight readiness for reasons unrelated to this change, e.g. rg/fd PATH, record that and confirm the same result on the base branch); tests PASS.

- [ ] **Step 9: Commit**

```bash
git add desktop/main.mjs desktop/startup.html scripts/smoke-desktop.mjs scripts/check.mjs package.json package-lock.json
git commit -m "Add Electron desktop shell for the Apex dashboard"
```

---

### Task 5: Shortcuts, docs and manual acceptance

**Files:**
- Create: `desktop/README.md`
- Modify: `README.md` (one paragraph after the "Native Windows (current scope)" install block)

**Interfaces:**
- Consumes: Task 4's `--install-shortcuts` mode and `npm run desktop` / `desktop:shortcut` / `smoke:desktop` scripts.

- [ ] **Step 1: Write `desktop/README.md`**

```markdown
# Apex desktop app

A native Windows window for the Apex dashboard. It starts the dashboard server itself on a free loopback port, shows it in its own window with the Apex icon, and stops the server and every agent it started when the window closes. Sessions are saved by Pi and can be resumed from the sidebar next time.

## Use

    npm install                 # downloads Electron (with --ignore-scripts, also run: node node_modules/electron/install.js)
    npm run desktop:shortcut    # creates "Apex" in the Start menu and on the desktop
    npm run desktop             # or start it from a terminal

The shortcuts run this checkout, so `git pull` updates the app. Re-run `npm run desktop:shortcut` if you move the folder.

## Behaviour

- One window: starting Apex again focuses it.
- Sign-in pages and links in answers open in your default browser; the window only ever shows the dashboard.
- Node comes from PATH (22.19 or newer); set `APEX_NODE` to a specific `node.exe` to override.
- If the server fails to start, the window shows its error output and a Retry button.
- Window size and position are kept in `%APPDATA%\Apex Desktop\window.json`.

## Checks

    node --test tests/desktop-shell.test.mjs tests/dashboard-desktop.test.mjs
    npm run smoke:desktop       # opens the real window briefly, checks it, closes it, confirms the server exited

The icon is generated by `node scripts/make-desktop-icon.mjs`; replace `desktop/icon.ico` with your own if you like.
```

- [ ] **Step 2: Add the README pointer**

In `README.md`, directly after the fenced PowerShell block that ends with `npm run smoke:windows-package` (in "Native Windows (current scope)"), insert:

```markdown
For a native app window instead of a browser tab, run `npm run desktop:shortcut` once and start **Apex** from the Start menu; see `desktop/README.md`.
```

- [ ] **Step 3: Create the shortcuts**

Run: `npm run desktop:shortcut`
Expected: prints `Created:` and the two `Apex.lnk` paths (Start menu Programs, Desktop). Both files exist.

- [ ] **Step 4: Manual acceptance (by the agent, with proof)**

1. Launch via the Start-menu shortcut: `powershell -NoProfile -Command "Start-Process (Join-Path ([Environment]::GetFolderPath('Programs')) 'Apex.lnk')"`.
2. Wait ~5 s, then screenshot the desktop (`computer` screenshot via the available desktop/browser tooling, or ask the user for one if no desktop screenshot tool exists) — expect the Apex window with the dashboard and the Apex taskbar icon. No console window, no browser tab.
3. Run the same Start-Process again — expect the existing window focused, still one `electron.exe` main process: `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object CommandLine -notmatch '--type=').Count"` → `1`.
4. Run `npm run smoke:desktop` while that window is open — expect `"ok": true` (Review Focus 1).
5. Close the window (`powershell -NoProfile -Command "Get-Process electron | Where-Object MainWindowTitle -eq 'Apex' | ForEach-Object { $_.CloseMainWindow() }"`), wait 6 s, then confirm nothing is left: `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object CommandLine -match 'dashboard\\\\server.mjs|bin\\\\apex' | Measure-Object | Select-Object -ExpandProperty Count"` → `0`.
6. Record results (commands, outputs, screenshot) in the final report to the user.

- [ ] **Step 5: Commit**

```bash
git add desktop/README.md README.md
git commit -m "Document the Apex desktop app"
```

---

## Self-review notes

- Spec coverage: server flags (T1), shell helpers incl. ready parsing / navigation / bounds / stderr tail (T2), icon (T3), lifecycle, failure page + Retry, window lockdown, popup hand-off, single instance, smoke (T4), shortcut with AppUserModelID, manual acceptance, docs (T5). `files` gains `desktop` (T4 step 2).
- Not automated (manual in T5): taskbar grouping, second-launch focus, no leftover processes after a real close, server-crash-after-ready failure page.
