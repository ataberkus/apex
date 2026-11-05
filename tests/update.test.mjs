import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {parseLocalCommand} from '../lib/commands.mjs';
import {automaticUpdateNotice, cachedUpdateState, CHECK_INTERVAL_MS, checkForUpdate, compareVersions, downloadInstaller, fetchLatestRelease, parseReleaseTag,
  readState, runInstaller, runUpdate, selectAssets, verifySha256} from '../lib/update.mjs';

const INSTALLER = Buffer.from('MZ fake Apex setup program');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ASSET_BASE = 'https://github.invalid/ataberkus/apex/releases/download';
const API_ASSETS = 'https://api.github.com/repos/ataberkus/apex/releases/assets';

function temporary(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'apex-update-test-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  return directory;
}

/** An install folder whose package.json carries `version`; `installed` adds the setup program's uninstaller. */
function install(t, version, {installed = true} = {}) {
  const root = temporary(t);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: '@apex-agent/pi', version}));
  if (installed) writeFileSync(path.join(root, 'unins000.exe'), '');
  return root;
}

/** The automatic check with an explicit token, so no test runs the real GitHub CLI. */
const auto = options => automaticUpdateNotice({token: null, ...options});

function release(tag, {draft = false, prerelease = false, assets} = {}) {
  const version = tag.replace(/^v/, '');
  return {tag_name: tag, draft, prerelease, html_url: `https://github.com/ataberkus/apex/releases/tag/${tag}`,
    assets: assets ?? [
      [`apex-${version}.tgz`, 10], [`apex-setup-${version}.exe`, INSTALLER.length], ['SHA256SUMS', 200],
    ].map(([name, size]) => ({name, size, url: `${API_ASSETS}/${encodeURIComponent(`${tag}/${name}`)}`, browser_download_url: `${ASSET_BASE}/${tag}/${name}`}))};
}

/** A fetch that answers the releases API and asset URLs from tables and records every request. */
function mockFetch({releases = [release('v1.3.0')], sums, body = INSTALLER, apiStatus = 200, apiHeaders = {}} = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({url, init});
    // The API asset URL redirects to a pre-signed download, as GitHub does for public and private releases.
    if (url.startsWith(`${API_ASSETS}/`)) {
      return new Response(null, {status: 302, headers: {location: `${ASSET_BASE}/${decodeURIComponent(url.slice(API_ASSETS.length + 1))}`}});
    }
    if (url.startsWith('https://api.github.com/')) {
      return new Response(apiStatus === 200 ? JSON.stringify(releases) : '{"message":"denied"}', {status: apiStatus, headers: apiHeaders});
    }
    if (url.endsWith('/SHA256SUMS')) {
      const version = url.split('/').at(-2).slice(1);
      return new Response(sums ?? `${sha('tarball')}  ./apex-${version}.tgz\n${sha(INSTALLER)}  ./apex-setup-${version}.exe\n`);
    }
    if (url.endsWith('.exe')) return new Response(body);
    return new Response('missing', {status: 404});
  };
  return {fetch, calls};
}

/** A child_process.spawn stand-in that reports a successful start. */
function mockSpawn() {
  const calls = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.unref = () => { child.unrefed = true; };
    calls.push({file, args, options, child});
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  return {spawn, calls};
}

const registered = location => () => ({status: 0, stdout:
  `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{F4E2BAF6-9DFA-4FE8-89CD-4F9CE5E5C11C}_is1\r\n    InstallLocation    REG_SZ    ${location}\\\r\n\r\n`});
/** net.connect stand-in: `listening` decides whether a dashboard answers on the port. */
const dashboard = listening => () => {
  const socket = new EventEmitter();
  socket.setTimeout = () => {};
  socket.destroy = () => {};
  queueMicrotask(() => listening ? socket.emit('connect') : socket.emit('error', Object.assign(new Error('refused'), {code: 'ECONNREFUSED'})));
  return socket;
};

function updateOptions(t, root, overrides = {}) {
  const state = temporary(t);
  const logs = [];
  return {root, env: {LOCALAPPDATA: state}, platform: 'win32', token: null, spawnSync: registered(root), connect: dashboard(false),
    tempRoot: temporary(t), log: line => logs.push(line), logs, ...overrides};
}

test('release tags follow the installer version rule and compare numerically', () => {
  assert.equal(parseReleaseTag('v1.2.3'), '1.2.3');
  assert.equal(parseReleaseTag('v0.0.65535'), '0.0.65535');
  for (const tag of ['1.2.3', 'v1.2', 'v1.2.3.4', 'v01.2.3', 'v1.2.65536', 'v1.2.3-rc.1', 'V1.2.3', '', null]) assert.equal(parseReleaseTag(tag), null, String(tag));
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.ok(compareVersions('2.0.0', '10.0.0') < 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.throws(() => compareVersions('1.2', '1.2.3'));
});

test('the latest release skips drafts, prereleases and malformed tags', async () => {
  const {fetch, calls} = mockFetch({releases: [
    release('v1.4.0', {draft: true}), release('v1.5.0', {prerelease: true}), release('v9.0.0-beta'), release('nightly'),
    release('v1.10.0'), release('v1.9.0'),
  ]});
  const latest = await fetchLatestRelease({fetch});
  assert.equal(latest.version, '1.10.0');
  assert.equal(latest.tag, 'v1.10.0');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/api\.github\.com\/repos\/ataberkus\/apex\/releases/);
  assert.match(calls[0].init.headers['User-Agent'], /apex/);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(await fetchLatestRelease({fetch: mockFetch({releases: [release('v2.0.0', {draft: true})]}).fetch}), null);
});

test('a rate-limited releases request says so', async () => {
  const {fetch} = mockFetch({apiStatus: 403, apiHeaders: {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1893456000'}});
  await assert.rejects(fetchLatestRelease({fetch}), /rate limit exceeded/);
  await assert.rejects(fetchLatestRelease({fetch: mockFetch({apiStatus: 500}).fetch}), /HTTP 500/);
});

test('a token reaches only api.github.com, never the pre-signed download it redirects to', async t => {
  const {fetch, calls} = mockFetch();
  const latest = await fetchLatestRelease({fetch, token: 'ghp_secret'});
  await downloadInstaller(latest, {fetch, token: 'ghp_secret', tempRoot: temporary(t)});
  const authorized = calls.filter(call => call.init.headers.Authorization === 'Bearer ghp_secret').map(call => new URL(call.url).host);
  assert.equal(authorized.length, 3, 'releases list, SHA256SUMS and installer requests');
  assert.deepEqual([...new Set(authorized)], ['api.github.com']);
  const downloads = calls.filter(call => !call.url.startsWith('https://api.github.com/'));
  assert.equal(downloads.length, 2);
  assert.ok(downloads.every(call => !('Authorization' in call.init.headers)));
  await assert.rejects(fetchLatestRelease({fetch: mockFetch({apiStatus: 404}).fetch}), /private or missing\. Set GH_TOKEN/);
});

test('a release without the exactly named setup program or SHA256SUMS is refused', () => {
  const base = {version: '1.3.0', tag: 'v1.3.0'};
  const assets = release('v1.3.0').assets;
  assert.throws(() => selectAssets({...base, assets: assets.filter(asset => asset.name !== 'apex-setup-1.3.0.exe')}), /no apex-setup-1\.3\.0\.exe asset/);
  assert.throws(() => selectAssets({...base, assets: assets.map(asset => asset.name.endsWith('.exe') ? {...asset, name: 'apex-setup-1.3.0-x.exe'} : asset)}), /no apex-setup-1\.3\.0\.exe asset/);
  assert.throws(() => selectAssets({...base, assets: assets.filter(asset => asset.name !== 'SHA256SUMS')}), /no SHA256SUMS asset/);
});

test('SHA256SUMS lines written by sha256sum ./file verify the matching download only', () => {
  const name = 'apex-setup-1.3.0.exe', hash = sha(INSTALLER);
  const sums = `${sha('tarball')}  ./apex-1.3.0.tgz\n${hash}  ./${name}\n`;
  assert.equal(verifySha256(sums, name, hash), hash);
  assert.equal(verifySha256(`${hash.toUpperCase()} *./${name}\r\n`, name, hash), hash);
  assert.throws(() => verifySha256(sums, name, sha('tampered')), /Checksum mismatch/);
  assert.throws(() => verifySha256(`${hash}  ./apex-setup-1.3.00.exe\n`, name, hash), /no line for \.\/apex-setup-1\.3\.0\.exe/);
  assert.throws(() => verifySha256(`${hash}  ./${name}\n${sha('other')}  ./${name}\n`, name, hash), /conflicting/);
});

test('the download is verified and a bad, short or unlisted one is deleted before anything runs it', async t => {
  const latest = await fetchLatestRelease({fetch: mockFetch().fetch});
  const good = temporary(t);
  const file = await downloadInstaller(latest, {fetch: mockFetch().fetch, tempRoot: good});
  assert.equal(path.basename(file), 'apex-setup-1.3.0.exe');
  assert.deepEqual(readFileSync(file), INSTALLER);

  const tampered = temporary(t);
  await assert.rejects(downloadInstaller(latest, {fetch: mockFetch({body: Buffer.from('MZ evil Apex setup program')}).fetch, tempRoot: tampered}), /Checksum mismatch/);
  assert.deepEqual(readdirSync(tampered), []);

  const short = temporary(t);
  await assert.rejects(downloadInstaller(latest, {fetch: mockFetch({body: INSTALLER.subarray(0, 5)}).fetch, tempRoot: short}), /Incomplete download/);
  assert.deepEqual(readdirSync(short), []);

  const unlisted = temporary(t);
  const {fetch, calls} = mockFetch({sums: `${sha('tarball')}  ./apex-1.3.0.tgz\n`});
  await assert.rejects(downloadInstaller(latest, {fetch, tempRoot: unlisted}), /no line for \.\/apex-setup-1\.3\.0\.exe/);
  assert.deepEqual(readdirSync(unlisted), []);
  assert.ok(!calls.some(call => call.url.endsWith('.exe')), 'the installer is not downloaded when SHA256SUMS does not list it');
});

test('the setup program starts detached with the silent upgrade switches and nothing that moves the install', async () => {
  const {spawn, calls} = mockSpawn();
  assert.equal(await runInstaller('C:\\Temp\\apex-setup-1.3.0.exe', {spawn}), 4242);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'C:\\Temp\\apex-setup-1.3.0.exe');
  assert.deepEqual(calls[0].args, ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS']);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.shell, false);
  assert.ok(calls[0].child.unrefed);
  // The desktop app's update asks the setup program to open it again.
  await runInstaller('C:\\Temp\\apex-setup-1.3.0.exe', {spawn, args: ['/RELAUNCH=1']});
  assert.deepEqual(calls[1].args, ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/RELAUNCH=1']);
  const failing = () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('blocked'))); return child; };
  await assert.rejects(runInstaller('C:\\Temp\\x.exe', {spawn: failing}), /Could not start x\.exe: blocked/);
});

test('apex update installs a newer release over the registered install', async t => {
  const root = install(t, '1.2.0');
  const {fetch} = mockFetch({releases: [release('v1.3.0'), release('v1.2.0')]});
  const {spawn, calls} = mockSpawn();
  const options = updateOptions(t, root, {fetch, spawn});
  await runUpdate('install', options);
  assert.equal(calls.length, 1);
  assert.equal(path.basename(calls[0].file), 'apex-setup-1.3.0.exe');
  assert.deepEqual(readFileSync(calls[0].file), INSTALLER);
  assert.deepEqual(calls[0].args, ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS']);
  assert.match(options.logs.at(-1), /over the existing install/);
  assert.equal(readState(options.env).latestVersion, '1.3.0');
});

test('apex update runs nothing for an equal or older release, a bad checksum or a running dashboard', async t => {
  for (const installed of ['1.3.0', '1.4.0']) {
    const {spawn, calls} = mockSpawn();
    const options = updateOptions(t, install(t, installed), {fetch: mockFetch().fetch, spawn});
    await runUpdate('install', options);
    assert.equal(calls.length, 0);
    assert.match(options.logs.at(-1), /is up to date/);
  }
  const bad = mockSpawn();
  const badOptions = updateOptions(t, install(t, '1.2.0'), {fetch: mockFetch({sums: `${sha('other')}  ./apex-setup-1.3.0.exe\n`}).fetch, spawn: bad.spawn});
  await assert.rejects(runUpdate('install', badOptions), /Checksum mismatch/);
  assert.equal(bad.calls.length, 0);
  assert.deepEqual(readdirSync(badOptions.tempRoot), []);

  const busy = mockSpawn();
  const busyOptions = updateOptions(t, install(t, '1.2.0'), {fetch: mockFetch().fetch, spawn: busy.spawn, connect: dashboard(true)});
  await assert.rejects(runUpdate('install', busyOptions), /dashboard seems to be running/);
  assert.equal(busy.calls.length, 0);
});

test('apex update refuses a 0.0.0 checkout, an unregistered copy and other platforms before any request', async t => {
  const refusals = [
    [install(t, '0.0.0', {installed: false}), {}, /Git or development checkout/],
    [install(t, '1.2.0'), {spawnSync: registered('C:\\Users\\someone\\AppData\\Local\\Programs\\Apex')}, /is not the installed Apex/],
    [install(t, '1.2.0'), {spawnSync: () => ({status: 1, stdout: ''})}, /No Apex installation is registered/],
    [install(t, '1.2.0'), {platform: 'linux'}, /Only the Windows setup program/],
  ];
  for (const [root, overrides, message] of refusals) {
    const {fetch, calls} = mockFetch();
    const spawned = mockSpawn();
    await assert.rejects(runUpdate('install', updateOptions(t, root, {fetch, spawn: spawned.spawn, ...overrides})), message);
    assert.equal(calls.length, 0);
    assert.equal(spawned.calls.length, 0);
  }
});

test('apex update --check reports both versions without installing, even for a checkout', async t => {
  const {spawn, calls} = mockSpawn();
  const options = updateOptions(t, install(t, '0.0.0', {installed: false}), {fetch: mockFetch().fetch, spawn});
  await runUpdate('check', options);
  assert.equal(calls.length, 0);
  assert.match(options.logs[0], /Installed: Apex 0\.0\.0 \(Git or development checkout/);
  assert.match(options.logs[1], /Latest: +Apex 1\.3\.0/);
  assert.equal(options.logs.length, 2, 'a checkout gets no verdict line');
  const installed = updateOptions(t, install(t, '1.2.0'), {fetch: mockFetch().fetch, spawn});
  await runUpdate('check', installed);
  assert.deepEqual(installed.logs, ['Installed: Apex 1.2.0', 'Latest:    Apex 1.3.0 (https://github.com/ataberkus/apex/releases/tag/v1.3.0)', 'An update is available: run "apex update".']);
  const current = updateOptions(t, install(t, '1.3.0'), {fetch: mockFetch().fetch, spawn});
  await runUpdate('check', current);
  assert.equal(current.logs.at(-1), 'Apex is up to date.');
  const none = updateOptions(t, install(t, '1.2.0'), {fetch: mockFetch({releases: []}).fetch, spawn});
  await runUpdate('check', none);
  assert.deepEqual(none.logs, ['Installed: Apex 1.2.0', 'Latest:    no published release (https://github.com/ataberkus/apex/releases)']);
});

test('checkForUpdate returns what --check reports and stores it for the automatic check', async t => {
  const env = {LOCALAPPDATA: temporary(t)};
  const now = Date.UTC(2026, 10, 4);
  const url = 'https://github.com/ataberkus/apex/releases/tag/v1.3.0';
  assert.deepEqual(await checkForUpdate({root: install(t, '1.2.0'), env, fetch: mockFetch().fetch, token: null, now}),
    {installed: '1.2.0', dev: false, latest: '1.3.0', tag: 'v1.3.0', url, available: true});
  assert.deepEqual(readState(env), {lastCheck: now, latestVersion: '1.3.0'});
  assert.deepEqual(await checkForUpdate({root: install(t, '1.3.0'), env, fetch: mockFetch().fetch, token: null, now}),
    {installed: '1.3.0', dev: false, latest: '1.3.0', tag: 'v1.3.0', url, available: false});
  assert.deepEqual(await checkForUpdate({root: install(t, '0.0.0', {installed: false}), env, fetch: mockFetch().fetch, token: null, now}),
    {installed: '0.0.0', dev: true, latest: '1.3.0', tag: 'v1.3.0', url, available: false}, 'a checkout is never offered an update');

  const empty = {LOCALAPPDATA: temporary(t)};
  assert.deepEqual(await checkForUpdate({root: install(t, '1.2.0'), env: empty, fetch: mockFetch({releases: [release('v2.0.0', {draft: true})]}).fetch, token: null, now}),
    {installed: '1.2.0', dev: false, latest: null, tag: null, url: 'https://github.com/ataberkus/apex/releases', available: false});
  assert.deepEqual(readState(empty), {lastCheck: now}, 'no release keeps the stored latest version');

  const failing = {LOCALAPPDATA: temporary(t)};
  await assert.rejects(checkForUpdate({root: install(t, '1.2.0'), env: failing, fetch: mockFetch({apiStatus: 404}).fetch, token: null, now}), /HTTP 404/);
  assert.deepEqual(readState(failing), {}, 'a failed request stores nothing');
  assert.ok(await checkForUpdate({root: install(t, '1.2.0'), env: {}, fetch: mockFetch().fetch, token: null, now}), 'no LOCALAPPDATA: nothing stored, no error');
});

test('cachedUpdateState reads the stored answer under the automatic check rules', async t => {
  const root = install(t, '1.2.0');
  const env = {LOCALAPPDATA: temporary(t)};
  assert.deepEqual(cachedUpdateState({root, env, platform: 'win32'}), {installed: '1.2.0', latest: null, available: false});
  await checkForUpdate({root, env, fetch: mockFetch().fetch, token: null});
  assert.deepEqual(cachedUpdateState({root, env, platform: 'win32'}), {installed: '1.2.0', latest: '1.3.0', available: true});
  assert.equal(cachedUpdateState({root, env, platform: 'linux'}).available, false);
  assert.equal(cachedUpdateState({root, env: {...env, APEX_NO_UPDATE_CHECK: '1'}, platform: 'win32'}).available, false);
  assert.equal(cachedUpdateState({root: install(t, '1.3.0'), env, platform: 'win32'}).available, false);
  assert.equal(cachedUpdateState({root: install(t, '1.2.0', {installed: false}), env, platform: 'win32'}).available, false);
  await runUpdate('skip', updateOptions(t, root, {env, fetch: mockFetch().fetch}));
  assert.deepEqual(cachedUpdateState({root, env, platform: 'win32'}), {installed: '1.2.0', latest: '1.3.0', available: false}, 'a skipped version is not offered');
});

test('the automatic check asks GitHub at most once a day and --skip silences one version', async t => {
  const root = install(t, '1.2.0');
  const env = {LOCALAPPDATA: temporary(t)};
  const {fetch, calls} = mockFetch();
  const now = Date.UTC(2026, 10, 4);
  assert.match(await auto({root, env, platform: 'win32', fetch, now}), /^Apex 1\.3\.0 is available \(installed 1\.2\.0\)/);
  assert.match(await auto({root, env, platform: 'win32', fetch, now: now + CHECK_INTERVAL_MS - 1}), /Apex 1\.3\.0 is available/);
  assert.equal(calls.length, 1, 'the cached result answers within 24 h');
  await auto({root, env, platform: 'win32', fetch, now: now + CHECK_INTERVAL_MS});
  assert.equal(calls.length, 2);
  assert.deepEqual(readState(env), {lastCheck: now + CHECK_INTERVAL_MS, latestVersion: '1.3.0'});
  assert.ok(existsSync(path.join(env.LOCALAPPDATA, 'Apex', 'update.json')), 'state lives in %LOCALAPPDATA%\\Apex, which upgrades keep');

  const options = updateOptions(t, root, {env, fetch, now: now + CHECK_INTERVAL_MS});
  await runUpdate('skip', options);
  assert.equal(readState(env).skippedVersion, '1.3.0');
  assert.equal(await auto({root, env, platform: 'win32', fetch, now: now + CHECK_INTERVAL_MS}), null);
});

test('the automatic check is opt-out, skips checkouts and never fails or waits on the network', async t => {
  const root = install(t, '1.2.0');
  const {fetch, calls} = mockFetch();
  for (const env of [{LOCALAPPDATA: temporary(t), APEX_NO_UPDATE_CHECK: '1'}, {}]) {
    assert.equal(await auto({root, env, platform: 'win32', fetch}), null);
  }
  assert.equal(await auto({root: install(t, '0.0.0', {installed: false}), env: {LOCALAPPDATA: temporary(t)}, platform: 'win32', fetch}), null);
  assert.equal(await auto({root, env: {LOCALAPPDATA: temporary(t)}, platform: 'linux', fetch}), null);
  assert.equal(calls.length, 0);

  const offline = {LOCALAPPDATA: temporary(t)};
  const refused = async () => { throw new TypeError('fetch failed'); };
  assert.equal(await auto({root, env: offline, platform: 'win32', fetch: refused, now: 1000}), null);
  assert.deepEqual(readState(offline), {lastCheck: 1000});

  const hanging = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const started = Date.now();
  assert.equal(await auto({root, env: {LOCALAPPDATA: temporary(t)}, platform: 'win32', fetch: hanging, timeoutMs: 50}), null);
  assert.ok(Date.now() - started < 2000);
  assert.equal(await auto({root, env: {LOCALAPPDATA: temporary(t)}, platform: 'win32', fetch: mockFetch({apiStatus: 403, apiHeaders: {'x-ratelimit-remaining': '0'}}).fetch}), null);
});

test('update is a local verb with --check and --skip only', () => {
  assert.deepEqual(parseLocalCommand(['update']), {kind: 'update', mode: 'install'});
  assert.deepEqual(parseLocalCommand(['update', '--check']), {kind: 'update', mode: 'check'});
  assert.deepEqual(parseLocalCommand(['update', '--skip']), {kind: 'update', mode: 'skip'});
  for (const args of [['update', '--self'], ['update', '--check', '--skip'], ['update', 'pi']]) assert.throws(() => parseLocalCommand(args), /Unsupported update option/);
  assert.equal(parseLocalCommand(['--apex-off', 'update']), null);
});
