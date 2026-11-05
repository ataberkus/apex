/**
 * `apex update`: upgrades the per-user Windows install in place from the project's GitHub releases. It downloads the
 * release's apex-setup-<version>.exe, checks it against the release's SHA256SUMS and starts it silently and detached
 * over the registered install; Inno Setup keeps the folder and the chosen tasks (UsePreviousAppDir/UsePreviousTasks).
 * The automatic check only reads releases and prints a notice; it never installs.
 */
import {spawn as nodeSpawn, spawnSync as nodeSpawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseVersion} from '../scripts/build-installer.mjs';

export const REPOSITORY = 'ataberkus/apex';
export const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
export const RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`;
/** installer/apex.iss AppId; Inno Setup registers the install under "<AppId>_is1". */
export const APP_ID = '{F4E2BAF6-9DFA-4FE8-89CD-4F9CE5E5C11C}';
const UNINSTALL_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_ID}_is1`;
/** Silent upgrade: progress window only, no prompts, no reboot. No /DIR or /TASKS, so the previous folder and tasks stay. */
export const INSTALLER_SWITCHES = Object.freeze(['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS']);
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const OPT_OUT = 'APEX_NO_UPDATE_CHECK';
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEV_VERSION = '0.0.0';
const USER_AGENT = 'apex-updater (+https://github.com/ataberkus/apex)';
const API_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const AUTO_TIMEOUT_MS = 3_000;
const MAX_SUMS_BYTES = 64 * 1024;

export const installerName = version => `apex-setup-${version}.exe`;

/** "vX.Y.Z" → "X.Y.Z" under scripts/build-installer.mjs parseVersion's rule, or null. */
export function parseReleaseTag(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) return null;
  const version = parseVersion([tag.slice(1)]);
  return version instanceof Error ? null : version;
}

/** Numeric X.Y.Z comparison: negative, zero or positive. */
export function compareVersions(left, right) {
  const parts = value => {
    const version = parseVersion([value]);
    if (version instanceof Error) throw new Error(`Not an X.Y.Z version: ${value}`);
    return version.split('.').map(Number);
  };
  const a = parts(left), b = parts(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

/** The version stamped into the package.json next to the running code; 0.0.0 is a Git or development checkout. */
export function installedVersion(root = ROOT) {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

function githubHeaders(accept, token) {
  return {'User-Agent': USER_AGENT, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', ...(token ? {Authorization: `Bearer ${token}`} : {})};
}

/**
 * GH_TOKEN, GITHUB_TOKEN or the GitHub CLI's login, or null. A private repository answers 404 without one; a public one
 * works anonymously within GitHub's 60 requests per hour.
 */
export async function githubToken({env = process.env, spawn = nodeSpawn, timeoutMs = 5000} = {}) {
  const fromEnv = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  return new Promise(resolve => {
    let child;
    try { child = spawn('gh', ['auth', 'token', '--hostname', 'github.com'], {stdio: ['ignore', 'pipe', 'ignore'], shell: false, windowsHide: true}); }
    catch { return resolve(null); }
    let output = '';
    const timer = setTimeout(() => { child.kill(); resolve(null); }, timeoutMs);
    child.stdout.on('data', chunk => { output += chunk; });
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.once('close', code => { clearTimeout(timer); const token = output.trim(); resolve(code === 0 && /^[\w-]+$/.test(token) ? token : null); });
  });
}

function httpFailure(response, what) {
  const remaining = response.headers.get('x-ratelimit-remaining');
  if (response.status === 429 || (response.status === 403 && remaining === '0')) {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    const when = Number.isFinite(reset) && reset > 0 ? ` It resets at ${new Date(reset * 1000).toLocaleString()}.` : '';
    return new Error(`GitHub API rate limit exceeded while ${what}.${when} Try again later, or set GH_TOKEN for a higher limit.`);
  }
  if (response.status === 401) return new Error(`GitHub rejected the token (HTTP 401) while ${what}; check GH_TOKEN, GITHUB_TOKEN or "gh auth status".`);
  if (response.status === 404) {
    return new Error(`GitHub returned HTTP 404 while ${what}: ${REPOSITORY} is private or missing. Set GH_TOKEN or sign in with "gh auth login" using an account that can read it.`);
  }
  return new Error(`GitHub returned HTTP ${response.status} while ${what}.`);
}

function timeoutError(error, what) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError' ? new Error(`Timed out while ${what}.`)
    : new Error(`Could not reach GitHub while ${what}: ${error?.message ?? error}`);
}

/** The newest published (non-draft, non-prerelease) release with a vX.Y.Z tag, or null when there is none. */
export async function fetchLatestRelease({fetch = globalThis.fetch, token = null, timeoutMs = API_TIMEOUT_MS} = {}) {
  const what = 'listing Apex releases';
  let response;
  try {
    response = await fetch(RELEASES_API, {headers: githubHeaders('application/vnd.github+json', token), signal: AbortSignal.timeout(timeoutMs)});
  } catch (error) { throw timeoutError(error, what); }
  if (!response.ok) throw httpFailure(response, what);
  const releases = await response.json();
  if (!Array.isArray(releases)) throw new Error(`Unexpected GitHub response while ${what}.`);
  let latest = null;
  for (const release of releases) {
    if (!release || release.draft || release.prerelease) continue;
    const version = parseReleaseTag(release.tag_name);
    if (version && (!latest || compareVersions(version, latest.version) > 0)) {
      latest = {version, tag: release.tag_name, url: release.html_url, assets: Array.isArray(release.assets) ? release.assets : []};
    }
  }
  return latest;
}

/** The release's exactly named setup program and SHA256SUMS assets. */
export function selectAssets(release) {
  const name = installerName(release.version);
  const find = wanted => release.assets.find(asset => asset?.name === wanted && (typeof asset.url === 'string' || typeof asset.browser_download_url === 'string'));
  const installer = find(name), sums = find('SHA256SUMS');
  if (!installer) throw new Error(`Release ${release.tag} has no ${name} asset; see ${RELEASES_URL}.`);
  if (!sums) throw new Error(`Release ${release.tag} has no SHA256SUMS asset, so ${name} cannot be verified.`);
  return {installer, sums};
}

/** The hash `sha256sum ./<name>` wrote for one file, accepting "./name" or "name" in text or binary ("*") mode. */
export function expectedSha256(sums, name) {
  const found = new Set();
  for (const line of sums.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-fA-F]{64}) [ *](.+)$/);
    if (match && (match[2] === `./${name}` || match[2] === name)) found.add(match[1].toLowerCase());
  }
  if (found.size === 0) throw new Error(`SHA256SUMS has no line for ./${name}.`);
  if (found.size > 1) throw new Error(`SHA256SUMS lists conflicting hashes for ./${name}.`);
  return [...found][0];
}

/** Throws unless the SHA-256 of a downloaded file equals its SHA256SUMS entry. */
export function verifySha256(sums, name, actual) {
  const expected = expectedSha256(sums, name);
  if (actual.toLowerCase() !== expected) throw new Error(`Checksum mismatch for ${name}: SHA256SUMS lists ${expected}, the download is ${actual}.`);
  return expected;
}

/**
 * The API asset URL serves public and private releases alike; it redirects to a pre-signed download URL, which is
 * followed by hand so the token never leaves api.github.com.
 */
async function fetchAsset(fetch, asset, token, timeoutMs, what) {
  const signal = AbortSignal.timeout(timeoutMs);
  const viaApi = typeof asset.url === 'string' && asset.url.startsWith('https://api.github.com/');
  let url = viaApi ? asset.url : asset.browser_download_url;
  let response;
  try {
    response = await fetch(url, {headers: githubHeaders('application/octet-stream', viaApi ? token : null), redirect: 'manual', signal});
    for (let hops = 0; response.status >= 300 && response.status < 400 && hops < 5; hops++) {
      const location = response.headers.get('location');
      if (!location) break;
      url = new URL(location, url).href;
      response = await fetch(url, {headers: {'User-Agent': USER_AGENT, Accept: 'application/octet-stream'}, redirect: 'manual', signal});
    }
  } catch (error) { throw timeoutError(error, what); }
  if (!response.ok) throw httpFailure(response, what);
  return response;
}

async function readText(response, limit, what) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error(`Unexpectedly large response while ${what}.`);
  return new TextDecoder().decode(bytes);
}

/**
 * Downloads the release's setup program into a fresh temporary folder, hashing it while it streams, and verifies it
 * against SHA256SUMS. A short, mismatching or unlisted download is deleted before anything can run it.
 */
export async function downloadInstaller(release, {fetch = globalThis.fetch, token = null, tempRoot = os.tmpdir(), timeoutMs = DOWNLOAD_TIMEOUT_MS} = {}) {
  const {installer, sums} = selectAssets(release);
  const sumsText = await readText(await fetchAsset(fetch, sums, token, API_TIMEOUT_MS, 'downloading SHA256SUMS'), MAX_SUMS_BYTES, 'downloading SHA256SUMS');
  expectedSha256(sumsText, installer.name); // an unlisted installer is refused before it is downloaded
  const directory = mkdtempSync(path.join(tempRoot, 'apex-update-'));
  const file = path.join(directory, installer.name);
  try {
    const what = `downloading ${installer.name}`;
    const response = await fetchAsset(fetch, installer, token, timeoutMs, what);
    const announced = response.headers.get('content-length');
    const hash = createHash('sha256');
    let received = 0;
    const fd = openSync(file, 'w');
    try {
      if (!response.body) throw new Error(`Empty response while ${what}.`);
      for await (const chunk of response.body) {
        hash.update(chunk);
        received += chunk.byteLength;
        writeSync(fd, chunk);
      }
    } catch (error) {
      throw error?.name === 'TimeoutError' || error?.name === 'AbortError' ? timeoutError(error, what) : error;
    } finally { closeSync(fd); }
    const expectedSize = Number.isInteger(installer.size) ? installer.size : announced === null ? null : Number(announced);
    if (received === 0 || (expectedSize !== null && received !== expectedSize)) {
      throw new Error(`Incomplete download of ${installer.name}: received ${received} of ${expectedSize ?? 'unknown'} bytes.`);
    }
    verifySha256(sumsText, installer.name, hash.digest('hex'));
    return file;
  } catch (error) {
    rmSync(directory, {recursive: true, force: true});
    throw error;
  }
}

/**
 * Starts the verified setup detached with the silent upgrade switches and resolves once Windows has started it. The
 * desktop app adds /RELAUNCH=1, which makes the setup program open it again when it is done.
 */
export function runInstaller(file, {spawn = nodeSpawn, args = []} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...INSTALLER_SWITCHES, ...args], {detached: true, stdio: 'ignore', shell: false, windowsHide: false});
    child.once('error', error => reject(new Error(`Could not start ${path.basename(file)}: ${error.message}`)));
    child.once('spawn', () => { child.unref(); resolve(child.pid); });
  });
}

/** InstallLocation of this user's Inno Setup registration, or null when Apex is not installed by the setup program. */
export function registeredInstallLocation({spawnSync = nodeSpawnSync} = {}) {
  const result = spawnSync('reg.exe', ['query', UNINSTALL_KEY, '/v', 'InstallLocation'], {encoding: 'utf8', shell: false, windowsHide: true});
  if (result.error || result.status !== 0) return null;
  const match = String(result.stdout).match(/^\s*InstallLocation\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m);
  return match ? match[1] : null;
}

const samePath = (a, b) => path.win32.resolve(a).replace(/\\+$/, '').toLowerCase() === path.win32.resolve(b).replace(/\\+$/, '').toLowerCase();

/** Throws unless the running code is the setup program's registered install, the only copy self-update may replace. */
export function assertUpdatable({root = ROOT, platform = process.platform, spawnSync = nodeSpawnSync} = {}) {
  if (platform !== 'win32') throw new Error('Only the Windows setup program (apex-setup-<version>.exe) supports self-update; update this copy the way you installed it.');
  const version = installedVersion(root);
  if (version === DEV_VERSION) throw new Error(`This is a Git or development checkout (package.json version ${DEV_VERSION}) in ${root}; update it with Git. apex update only replaces the installed Apex.`);
  const location = registeredInstallLocation({spawnSync});
  if (!location) throw new Error(`No Apex installation is registered for this user. Install ${installerName('<version>')} from ${RELEASES_URL}.`);
  if (!samePath(location, root)) throw new Error(`This copy (${root}) is not the installed Apex (${location}); run apex update from the installed copy.`);
  return version;
}

/** True when something accepts connections on the dashboard's loopback port. */
export function dashboardListening({env = process.env, connect = net.connect, timeoutMs = 1000} = {}) {
  const port = Number(env.APEX_DASH_PORT ?? 4777);
  return new Promise(resolve => {
    const socket = connect({host: '127.0.0.1', port});
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** %LOCALAPPDATA%\Apex\update.json: the dashboard's state folder, which upgrading and uninstalling never touch. */
export function statePath(env = process.env) {
  return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Apex', 'update.json') : null;
}

export function readState(env = process.env) {
  const file = statePath(env);
  if (!file) return {};
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  } catch { return {}; }
}

export function writeState(env, changes) {
  const file = statePath(env);
  if (!file) return;
  const next = {...readState(env), ...changes};
  mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(next, null, 1));
  renameSync(temporary, file);
}

export const optedOut = env => Boolean(env[OPT_OUT]) && env[OPT_OUT] !== '0';

export function formatNotice(installed, latest, command = 'apex update') {
  return `Apex ${latest} is available (installed ${installed}). Run "${command}" to install it, or "${command} --skip" to hide this notice; ${OPT_OUT}=1 turns the check off.`;
}

/**
 * The automatic check: at most one GitHub request per 24 h, a short timeout and no error ever surfaces. Returns a
 * one-line notice when a newer release than the installed, not skipped version is known, otherwise null.
 */
export async function automaticUpdateNotice({root = ROOT, env = process.env, platform = process.platform, fetch = globalThis.fetch,
  token, now = Date.now(), timeoutMs = AUTO_TIMEOUT_MS, command} = {}) {
  try {
    if (optedOut(env) || platform !== 'win32' || !statePath(env)) return null;
    const installed = installedVersion(root);
    // Only the setup program's install (its uninstaller sits in the folder) can be updated; a checkout never is.
    if (installed === DEV_VERSION || !existsSync(path.join(root, 'unins000.exe'))) return null;
    const state = readState(env);
    let latest = typeof state.latestVersion === 'string' ? state.latestVersion : null;
    if (!(Number.isFinite(state.lastCheck) && now - state.lastCheck >= 0 && now - state.lastCheck < CHECK_INTERVAL_MS)) {
      let release = null;
      try { release = await fetchLatestRelease({fetch, token: token === undefined ? await githubToken({env, timeoutMs}) : token, timeoutMs}); } catch {}
      if (release) latest = release.version;
      try { writeState(env, {lastCheck: now, ...(release ? {latestVersion: release.version} : {})}); } catch {}
    }
    if (!latest || latest === state.skippedVersion || compareVersions(latest, installed) <= 0) return null;
    return formatNotice(installed, latest, command);
  } catch { return null; }
}

/**
 * The check behind `apex update --check` and the dashboard's button: reads the installed version and the newest release,
 * records them for the automatic check and returns {installed, dev, latest, tag, url, available}. GitHub errors throw.
 */
export async function checkForUpdate({root = ROOT, env = process.env, fetch = globalThis.fetch, token, now = Date.now()} = {}) {
  const installed = installedVersion(root);
  const dev = installed === DEV_VERSION;
  const release = await fetchLatestRelease({fetch, token: token === undefined ? await githubToken({env}) : token});
  try { writeState(env, {lastCheck: now, ...(release ? {latestVersion: release.version} : {})}); } catch {}
  return {installed, dev, latest: release?.version ?? null, tag: release?.tag ?? null, url: release?.url ?? RELEASES_URL,
    available: Boolean(release) && !dev && compareVersions(release.version, installed) > 0};
}

/**
 * The automatic check's last stored answer, without a network request: {installed, latest, available}. `available`
 * follows automaticUpdateNotice (a newer, not skipped release on the setup program's Windows install, not opted out).
 */
export function cachedUpdateState({root = ROOT, env = process.env, platform = process.platform} = {}) {
  try {
    const installed = installedVersion(root);
    const state = readState(env);
    const latest = typeof state.latestVersion === 'string' && parseVersion([state.latestVersion]) === state.latestVersion ? state.latestVersion : null;
    const updatable = !optedOut(env) && platform === 'win32' && installed !== DEV_VERSION && existsSync(path.join(root, 'unins000.exe'));
    const available = Boolean(latest) && updatable && latest !== state.skippedVersion && compareVersions(latest, installed) > 0;
    return {installed, latest, available};
  } catch { return {installed: null, latest: null, available: false}; }
}

/** `apex update [--check|--skip]`. */
export async function runUpdate(mode, {root = ROOT, env = process.env, platform = process.platform, fetch = globalThis.fetch, token,
  spawn = nodeSpawn, spawnSync = nodeSpawnSync, connect = net.connect, tempRoot = os.tmpdir(), now = Date.now(), log = console.log} = {}) {
  const installed = installedVersion(root);
  const auth = async () => token === undefined ? githubToken({env}) : token;
  if (mode === 'check') {
    log(`Installed: Apex ${installed}${installed === DEV_VERSION ? ' (Git or development checkout; apex update never replaces it)' : ''}`);
    const result = await checkForUpdate({root, env, fetch, token: await auth(), now});
    if (!result.latest) return log(`Latest:    no published release (${RELEASES_URL})`);
    log(`Latest:    Apex ${result.latest} (${result.url})`);
    if (!result.dev) log(result.available ? 'An update is available: run "apex update".' : 'Apex is up to date.');
    return;
  }
  assertUpdatable({root, platform, spawnSync});
  const credential = await auth();
  const release = await fetchLatestRelease({fetch, token: credential});
  try { writeState(env, {lastCheck: now, ...(release ? {latestVersion: release.version} : {})}); } catch {}
  if (!release) throw new Error(`No published Apex release was found at ${RELEASES_URL}.`);
  if (compareVersions(release.version, installed) <= 0) return log(`Apex ${installed} is up to date (latest release ${release.version}).`);
  if (mode === 'skip') {
    writeState(env, {skippedVersion: release.version});
    return log(`The automatic check will not announce Apex ${release.version} again; "apex update" still installs it.`);
  }
  selectAssets(release);
  // The dashboard serves its files from the install folder while it runs and the setup program cannot close it.
  if (await dashboardListening({env, connect})) {
    throw new Error(`An Apex dashboard seems to be running on 127.0.0.1:${env.APEX_DASH_PORT ?? 4777}. Close it (Ctrl+C in its window), then run apex update again.`);
  }
  log(`Downloading ${installerName(release.version)} (Apex ${installed} -> ${release.version})...`);
  const file = await downloadInstaller(release, {fetch, token: credential, tempRoot});
  log('Verified its SHA-256 against the release\'s SHA256SUMS.');
  await runInstaller(file, {spawn});
  log(`Started the Apex ${release.version} setup over the existing install in ${root}. It runs silently and keeps your settings, ` +
    'shortcuts, PATH entry and dashboard state; close other Apex windows and open a new one when its progress window closes.');
}
