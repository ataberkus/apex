import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {open, opendir, realpath} from 'node:fs/promises';
import {availableParallelism, arch, freemem, platform, totalmem, userInfo} from 'node:os';
import {basename, delimiter, isAbsolute, relative, resolve, sep} from 'node:path';
import {StringDecoder} from 'node:string_decoder';

const SNAPSHOT_BYTES = 2400;
const PROBE_BYTES = 2048;
const LOCAL_TIMEOUT_MS = 1000;
const MAX_FILES = 400;
const MAX_DIRECTORY_ENTRIES = 1024;
const READ_BYTES = 32768;
const ENTRY_DEPTH = 6;
const ENTRY_PATHS = 600;
const ENTRY_SCAN_MS = 750;
const SOURCE_FILES = 20;
const SOURCE_BYTES = 65536;
const IGNORED_TREES = new Set(['node_modules', '.git', '.apex', '.cache', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.next', '.nuxt', '.turbo', 'coverage',
  'dist', 'build', 'target', 'vendor', 'venv', '.venv', 'out']);
const MAKEFILES = new Set(['Makefile', 'makefile', 'GNUmakefile']);
const MANIFESTS = new Set(['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', ...MAKEFILES]);
const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|c|cc|cpp|h|hpp|sh|rb|php|html)$/i;
const TEST_TREES = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'fixtures', 'e2e',
  'eval', 'evals', 'bench', 'benchmark', 'benchmarks', 'verifier', 'verifiers']);
const SOURCE_TREES = new Set(['src', 'lib', 'app', 'cmd', 'internal', 'pkg', 'source', 'sources',
  'extensions', 'scripts', 'server', 'client', 'components', 'pages', 'routes', 'services']);
const TEST_FILE = /(?:^|[_.-])(?:test|spec|verify|verifier)(?:[_.-]|$)/i;
const PROBES = [
  ['node', ['--version']], ['python3', ['--version']], ['git', ['--version']],
  ['bash', ['--version']], ['rg', ['--version']], ['fd', ['--version']],
  ['go', ['version']], ['rustc', ['--version']],
  ['make', ['--version']],
];
const PACKAGE_PROBES = [['pip', 'pip3'], ['uv', 'uv']];
const LOCKFILE_MANAGERS = new Map([['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'],
  ['uv.lock', 'uv'], ['poetry.lock', 'poetry'], ['pdm.lock', 'pdm'], ['requirements.txt', 'pip']]);

function boundedText(value, maxBytes) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let length = 0, result = '';
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (length + bytes > maxBytes) break;
    length += bytes;
    result += character;
  }
  return result;
}

function childEnvironment(cwd) {
  // PATH is needed to locate local binaries; relative components can execute project files.
  const paths = (process.env.PATH || '/usr/bin:/bin').split(delimiter)
    .filter(path => isAbsolute(path) && !confined(cwd, resolve(path)));
  const env = {PATH: paths.join(delimiter), LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
    GOTELEMETRY: 'off', GOTOOLCHAIN: 'local', RUSTUP_AUTO_INSTALL: '0', RUSTUP_NO_UPDATE_CHECK: '1',
    GIT_CONFIG_GLOBAL: platform() === 'win32' ? 'NUL' : '/dev/null'};
  if (platform() === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

function nativeCommand(command, args, options) {
  return new Promise(resolveResult => {
    let child, stdout = '', stderr = '', timedOut = false, truncated = false, finished = false;
    let received = 0;
    const decoders = {stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8')};
    const stop = () => { try { child?.kill('SIGKILL'); } catch {} };
    const finish = result => {
      if (finished) return;
      finished = true;
      options.signal.removeEventListener('abort', abort);
      resolveResult({...result, stdout, stderr, timedOut, truncated});
    };
    const abort = () => { timedOut = true; stop(); };
    try {
      child = spawn(command, args, {cwd: options.cwd, env: options.env, shell: false,
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    } catch (error) {
      finish({code: null, error: error.code || 'spawn failed'});
      return;
    }
    options.signal.addEventListener('abort', abort, {once: true});
    if (options.signal.aborted) abort();
    const collect = stream => chunk => {
      const remaining = Math.max(0, options.maxOutputBytes - received);
      const selected = chunk.subarray(0, remaining);
      const text = decoders[stream].write(selected);
      received += selected.length;
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      if (chunk.length > remaining) { truncated = true; stop(); }
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', error => finish({code: null, error: error.code || 'spawn failed'}));
    child.on('close', code => finish({code}));
  });
}

async function probe(runCommand, command, args, cwd, {timeoutMs = LOCAL_TIMEOUT_MS,
  maxOutputBytes = PROBE_BYTES, networkAllowed = false} = {}) {
  const controller = new AbortController();
  let timer;
  const options = {cwd, timeoutMs, maxOutputBytes, networkAllowed, env: childEnvironment(cwd),
    signal: controller.signal};
  const deadline = new Promise(resolveResult => {
    timer = setTimeout(() => {
      controller.abort();
      resolveResult({code: null, timedOut: true, stdout: '', stderr: ''});
    }, timeoutMs);
  });
  try {
    const operation = Promise.resolve().then(() => (runCommand || nativeCommand)(command, args, options))
      .catch(error => ({code: null, error: boundedText(error.code || 'probe failed', 80)}));
    const result = await Promise.race([operation, deadline]);
    const stdout = boundedText(result?.stdout, maxOutputBytes);
    const stderr = boundedText(result?.stderr, maxOutputBytes - Buffer.byteLength(stdout));
    const code = result?.code ?? result?.exitCode ?? null;
    const truncated = Boolean(result?.truncated) || stdout !== String(result?.stdout ?? '') ||
      stderr !== String(result?.stderr ?? '');
    const timedOut = Boolean(result?.timedOut);
    return {status: timedOut ? 'timed-out' : code === 0 ? 'available' : 'unavailable',
      code, stdout, stderr, timedOut, truncated, ...(result?.error ? {error: boundedText(result.error, 80)} : {})};
  } finally { clearTimeout(timer); }
}

function confined(root, path) {
  const value = relative(root, path);
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function readProjectFile(root, path, {maxBytes = READ_BYTES, partial = false} = {}) {
  const absolute = resolve(root, path);
  if (!confined(root, absolute)) return null;
  let handle;
  try {
    if (!confined(root, await realpath(absolute))) return null;
    handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || (!partial && stat.size > maxBytes)) return null;
    const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    return new StringDecoder('utf8').write(buffer.subarray(0, bytesRead));
  } catch { return null; }
  finally { await handle?.close(); }
}

function globTokens(pattern) {
  const tokens = [];
  for (let i = 0; i < pattern.length; i++) {
    const character = pattern[i];
    if (character === '*') {
      if (pattern[i + 1] === '*') {
        while (pattern[i + 1] === '*') i++;
        if (pattern[i + 1] === '/') {
          tokens.push({kind: 'directories-start'}, {kind: 'directories-body'});
          i++;
        } else tokens.push({kind: 'many', slash: true});
      } else tokens.push({kind: 'many', slash: false});
    } else if (character === '?') tokens.push({kind: 'one'});
    else if (character === '[') {
      const end = pattern.indexOf(']', i + 1);
      const body = end < 0 ? '' : pattern.slice(i + 1, end);
      let expression;
      if (body && !body.includes('/') && !body.includes('\\') && !body.includes('[')) {
        try { expression = new RegExp(`^[${body.startsWith('!') ? `^${body.slice(1)}` : body}]$`); }
        catch { /* Malformed classes are literal patterns, never executable regular expressions. */ }
      }
      if (expression) { tokens.push({kind: 'class', expression}); i = end; }
      else tokens.push({kind: 'literal', value: '['});
    }
    else if (character === '\\' && i + 1 < pattern.length) {
      tokens.push({kind: 'literal', value: pattern[++i]});
    } else tokens.push({kind: 'literal', value: character});
  }
  return tokens;
}

function matchesGlob(tokens, path) {
  if (tokens.filter(token => ['literal', 'class', 'one'].includes(token.kind)).length > path.length) return false;
  const closure = states => {
    for (const index of states) {
      const kind = tokens[index]?.kind;
      if (kind === 'many') states.add(index + 1);
      else if (kind === 'directories-start') states.add(index + 2);
    }
    return states;
  };
  let states = closure(new Set([0]));
  for (const character of path) {
    const next = new Set();
    for (const index of states) {
      const token = tokens[index];
      if (!token) continue;
      if (token.kind === 'many' && (token.slash || character !== '/')) next.add(index);
      else if (token.kind === 'directories-start' || token.kind === 'directories-body') {
        next.add(token.kind === 'directories-start' ? index + 1 : index);
        if (character === '/') next.add(token.kind === 'directories-start' ? index + 2 : index + 1);
      } else if ((token.kind === 'literal' && token.value === character) ||
        (token.kind === 'one' && character !== '/') ||
        (token.kind === 'class' && character !== '/' && token.expression.test(character))) next.add(index + 1);
    }
    states = closure(next);
    if (states.size === 0) return false;
  }
  return states.has(tokens.length);
}

function ignoreRules(text, base) {
  const rules = [];
  for (let line of (text || '').split(/\r?\n/).slice(0, 256)) {
    line = line.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const directoryOnly = line.endsWith('/');
    if (directoryOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    if (!line) continue;
    rules.push({base, negate, directoryOnly, anchored: anchored || line.includes('/'), tokens: globTokens(line)});
  }
  return rules;
}

function ignored(path, isDirectory, rules) {
  let result = false;
  for (const rule of rules) {
    if (rule.base && !path.startsWith(`${rule.base}/`)) continue;
    const scoped = rule.base ? path.slice(rule.base.length + 1) : path;
    const target = rule.anchored ? scoped : scoped.slice(scoped.lastIndexOf('/') + 1);
    if ((!rule.directoryOnly || isDirectory) && matchesGlob(rule.tokens, target)) result = !rule.negate;
  }
  return result;
}

async function discover(cwd, {entryScan = false} = {}) {
  const files = [], manifests = [];
  let root, truncated = false;
  const start = performance.now();
  const maxFiles = entryScan ? ENTRY_PATHS : MAX_FILES;
  const maxDepth = entryScan ? ENTRY_DEPTH : 2;
  try { root = await realpath(resolve(cwd)); }
  catch { return {project: {status: 'unavailable'}, files, manifests, truncated}; }
  async function walk(directory, depth, inheritedRules) {
    if (entryScan && performance.now() - start >= ENTRY_SCAN_MS) { truncated = true; return true; }
    let entries = [], directoryHandle;
    const scopedRules = [...inheritedRules,
      ...ignoreRules(await readProjectFile(root, directory ? `${directory}/.gitignore` : '.gitignore'), directory)];
    try {
      directoryHandle = await opendir(resolve(root, directory));
      for await (const item of directoryHandle) {
        entries.push(item);
        if (entries.length >= MAX_DIRECTORY_ENTRIES) { truncated = true; break; }
      }
    } catch { return false; }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const item of entries) {
      if (files.length >= maxFiles || (entryScan && performance.now() - start >= ENTRY_SCAN_MS)) {
        truncated = true; break;
      }
      if (item.isSymbolicLink() || IGNORED_TREES.has(item.name) || item.name.startsWith('.')) continue;
      if (entryScan && ((item.isDirectory() && TEST_TREES.has(item.name.toLowerCase())) ||
        (item.isFile() && TEST_FILE.test(item.name)))) continue;
      const path = directory ? `${directory}/${item.name}` : item.name;
      if (ignored(path, item.isDirectory(), scopedRules)) continue;
      if (item.isDirectory()) {
        files.push({path: `${path}/`, type: 'directory'});
        if (depth < maxDepth) await walk(path, depth + 1, scopedRules);
      } else if (item.isFile()) files.push({path, type: 'file'});
    }
    return true;
  }
  const available = await walk('', 1, []);
  for (const item of files) {
    if (item.type !== 'file' || !MANIFESTS.has(basename(item.path)) || item.path.split('/').length > 2) continue;
    if (item.path.split('/').some(part => TEST_TREES.has(part.toLowerCase()))) continue;
    const text = await readProjectFile(root, item.path);
    manifests.push(parseManifest(item.path, text));
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return {project: {status: available ? 'available' : 'unavailable'}, files, manifests, truncated};
}

function manifestTarget(manifestPath, value) {
  if (typeof value !== 'string' || value.length > 512 || isAbsolute(value) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:|^\\\\/.test(value)) return null;
  value = value.replaceAll('\\', '/');
  if (value.split('/').includes('..')) return null;
  const directory = manifestPath.includes('/') ? manifestPath.slice(0, manifestPath.lastIndexOf('/')) : '';
  const path = relative(resolve('/'), resolve('/', directory, value)).split(sep).join('/');
  if (path.startsWith('../') || path.split('/').length > ENTRY_DEPTH) return null;
  return path;
}

function parseManifest(path, text) {
  const manifest = {path, type: basename(path), status: text === null ? 'unavailable' : 'available',
    scripts: [], entryTargets: []};
  if (text === null) return manifest;
  if (basename(path) === 'package.json') {
    try {
      const data = JSON.parse(text);
      manifest.name = boundedText(typeof data.name === 'string' ? data.name : '', 120);
      const manager = typeof data.packageManager === 'string'
        ? data.packageManager.match(/^(npm|pnpm|yarn|bun)(?:@(\d[\w.+-]{0,40}))?$/) : null;
      if (manager) manifest.packageManager = {name: manager[1], ...(manager[2] ? {version: manager[2]} : {})};
      manifest.scripts = data.scripts && typeof data.scripts === 'object' && !Array.isArray(data.scripts)
        ? Object.keys(data.scripts).sort().slice(0, 40).map(value => boundedText(value, 80)) : [];
      const targets = [data.main, data.module, data.source,
        ...(typeof data.bin === 'string' ? [data.bin] : Object.values(data.bin || {}))];
      const collectExports = (value, depth = 0) => {
        if (typeof value === 'string') targets.push(value);
        else if (value && typeof value === 'object' && depth < 3) {
          for (const item of Object.values(value).slice(0, 40)) collectExports(item, depth + 1);
        }
      };
      collectExports(data.exports);
      manifest.entryTargets = [...new Set(targets.map(value => manifestTarget(path, value)).filter(Boolean))].slice(0, 30);
    } catch { manifest.status = 'unavailable'; }
  } else if (MAKEFILES.has(basename(path))) {
    manifest.targets = [...new Set([...text.matchAll(/^([A-Za-z0-9_][\w.-]*(?:[ \t]+[A-Za-z0-9_][\w.-]*)*)[ \t]*:(?![=:])/gm)]
      .flatMap(match => match[1].split(/[ \t]+/)))].sort().slice(0, 40);
    manifest.buildTestTargets = manifest.targets.filter(target =>
      /^(?:all|build|test|check|lint|verify|format|fmt)(?:[_.-]|$)/i.test(target)).slice(0, 12);
  } else {
    const name = text.match(/(?:^|\n)\s*(?:name\s*=\s*["']([^"']+)["']|module\s+(\S+))/);
    if (name) manifest.name = boundedText(name[1] || name[2], 120);
    if (basename(path) === 'Cargo.toml') {
      manifest.entryTargets = [...text.matchAll(/(?:^|\n)\s*path\s*=\s*["']([^"']+)["']/g)]
        .map(match => manifestTarget(path, match[1])).filter(Boolean).slice(0, 30);
    }
    if (basename(path) === 'pyproject.toml') {
      manifest.tools = [...new Set([...text.matchAll(/^\[tool\.([A-Za-z0-9_-]+)(?:\.[^\]\r\n]+)?\][ \t]*(?:#.*)?$/gm)]
        .map(match => match[1].toLowerCase()))].sort().slice(0, 16);
      const build = text.match(/(?:^|\n)\[build-system\][ \t]*\r?\n([\s\S]*?)(?=\r?\n\[|$)/)?.[1] || '';
      const backend = build.match(/^build-backend[ \t]*=[ \t]*["']([A-Za-z0-9_.-]+)["']/m)?.[1];
      if (backend) manifest.buildBackend = boundedText(backend, 80);
    }
  }
  return manifest;
}

function taskTerms(task) {
  return [...new Set(String(task || '').slice(0, 4096).toLowerCase().match(/[a-z0-9_$]{3,}/g) || [])].slice(0, 40);
}

function rank(discovery, task, limit) {
  const terms = taskTerms(task);
  const declared = new Set(discovery.manifests.flatMap(manifest => manifest.entryTargets));
  const manifests = new Map(discovery.manifests.map(manifest => [manifest.path, manifest]));
  const candidates = [];
  for (const file of discovery.files) {
    if (file.type !== 'file') continue;
    const name = basename(file.path), lower = file.path.toLowerCase();
    let score = 0;
    const reasons = [];
    if (declared.has(file.path)) { score += 100; reasons.push('manifest entry'); }
    if (/^(?:index|main|app|server|cli|manage)\./i.test(name)) { score += 60; reasons.push('entry filename'); }
    if (MANIFESTS.has(name)) { score += 30; reasons.push('project manifest'); }
    const manifest = manifests.get(file.path);
    if (manifest?.buildTestTargets?.length) { score += 40; reasons.push('build/test targets'); }
    if (manifest?.tools?.length || manifest?.buildBackend) { score += 40; reasons.push('build/test tools'); }
    if (/^(?:README(?:\.[^/]+)?|Makefile)$/i.test(name)) { score += 20; reasons.push('project guide'); }
    if (SOURCE.test(name)) { score += 10; reasons.push('source file'); }
    const matched = terms.filter(term => lower.includes(term));
    if (matched.length && (SOURCE.test(name) || score > 0)) {
      score += matched.length * 200;
      reasons.unshift('matches task path');
    }
    if (score > 0) candidates.push({path: file.path, reason: reasons.join('; '), score});
  }
  return candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, 'en')).slice(0, limit);
}

function sourceEligible(path) {
  const parts = path.split('/');
  return SOURCE.test(path) && !TEST_FILE.test(basename(path)) &&
    (parts.length === 1 || SOURCE_TREES.has(parts[0].toLowerCase())) &&
    !parts.some(part => TEST_TREES.has(part.toLowerCase()));
}

async function discoverEntries(cwd, task, runCommand, rgResult) {
  const [discovery, rg] = await Promise.all([discover(cwd, {entryScan: true}),
    rgResult || probe(runCommand, 'rg', ['--version'], resolve(cwd))]);
  const candidates = rank(discovery, task, ENTRY_PATHS);
  const sourceFiles = [];
  const info = {status: rg.status === 'available' ? 'content-assisted' : 'metadata-only',
    reason: rg.status === 'available' ? 'bounded identifier and symbol reads' : 'rg unavailable',
    sourceFiles, maxSourceFiles: SOURCE_FILES, maxSourceBytes: SOURCE_BYTES,
    maxDepth: ENTRY_DEPTH, maxPaths: ENTRY_PATHS, scanTimeoutMs: ENTRY_SCAN_MS,
    truncated: discovery.truncated};
  if (rg.status !== 'available') {
    for (const entry of candidates) entry.reason += '; metadata only (rg unavailable)';
    return {entries: candidates, info};
  }
  const root = resolve(cwd), terms = taskTerms(task), started = performance.now();
  const sourceCandidates = candidates.filter(entry => sourceEligible(entry.path));
  for (const entry of sourceCandidates.slice(0, SOURCE_FILES)) {
    if (performance.now() - started >= ENTRY_SCAN_MS) { info.truncated = true; break; }
    const source = await readProjectFile(root, entry.path, {maxBytes: SOURCE_BYTES, partial: true});
    if (source === null) continue;
    sourceFiles.push(entry.path);
    const identifiers = new Set((source.match(/[A-Za-z_$][\w$]*/g) || []).map(value => value.toLowerCase()));
    const symbols = [...source.matchAll(/\b(?:function|class|def|fn|func|const|let|var)\s+([A-Za-z_$][\w$]*)/g)]
      .slice(0, 250).map(match => match[1].toLowerCase());
    const contentHits = terms.filter(term => identifiers.has(term));
    const symbolHits = terms.filter(term => symbols.some(symbol => symbol === term || symbol.includes(term)));
    if (contentHits.length) { entry.score += contentHits.length * 200; entry.reason = `content identifier hit; ${entry.reason}`; }
    if (symbolHits.length) { entry.score += symbolHits.length * 400; entry.reason = `declared symbol hit; ${entry.reason}`; }
    if (!symbolHits.length && symbols.some(symbol => /^(?:main|app|server|handler)$/.test(symbol))) {
      entry.score += 25;
      entry.reason = `declared entry symbol; ${entry.reason}`;
    }
  }
  if (sourceCandidates.length > SOURCE_FILES) info.truncated = true;
  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, 'en'));
  return {entries: candidates, info};
}

/** Rank local entry paths using metadata and bounded optional source identifier/symbol reads. */
export async function rankEntryPoints({cwd = process.cwd(), task = '', limit = 10, runCommand} = {}) {
  const count = Number.isInteger(limit) ? Math.max(0, Math.min(10, limit)) : 10;
  if (count === 0) return [];
  return (await discoverEntries(cwd, task, runCommand)).entries.slice(0, count);
}

function summary(name, value) {
  const version = value.status === 'available' ? boundedText(value.stdout || value.stderr, 70).split(/[\r\n]/)[0] : value.status;
  return `${name}: ${version || 'available'}${value.truncated ? ' (output capped)' : ''}`;
}

function displayPath(path, maxBytes = 88) {
  let escaped = '', bytes = 2, truncated = false;
  for (const character of path) {
    const part = JSON.stringify(character).slice(1, -1);
    const length = Buffer.byteLength(part);
    if (bytes + length + 3 > maxBytes) { truncated = true; break; }
    escaped += part;
    bytes += length;
  }
  return `"${escaped}${truncated ? '…' : ''}"`;
}

async function localIdentity() {
  let info;
  try { info = userInfo(); } catch {}
  const user = info && typeof info.username === 'string'
    ? {status: 'available', username: boundedText(info.username, 80), uid: info.uid, gid: info.gid}
    : {status: 'unavailable'};
  const environmentShell = platform() === 'win32' ? process.env.ComSpec : process.env.SHELL;
  const shellPath = environmentShell || info?.shell;
  const shell = typeof shellPath === 'string' && shellPath
    ? {status: 'available', path: boundedText(shellPath, 160), source: environmentShell ? 'environment' : 'os'}
    : {status: 'unavailable'};
  let distro = {status: 'unavailable', name: platform()};
  if (platform() === 'linux') {
    // Fixed system metadata only; never source os-release as a shell script.
    const release = await readProjectFile('/etc', 'os-release', {maxBytes: 4096}) ||
      await readProjectFile('/usr/lib', 'os-release', {maxBytes: 4096});
    if (release) {
      const fields = new Map([...release.matchAll(/^([A-Z_]+)=(.*)$/gm)].map(match =>
        [match[1], match[2].replace(/^(["'])(.*)\1$/, '$2')]));
      const name = fields.get('PRETTY_NAME') || fields.get('NAME') || fields.get('ID');
      if (name) distro = {status: 'available', name: boundedText(name, 120)};
    }
  }
  return {user, shell, distro};
}

function packageManagerInfo(discovery, probes) {
  const managers = Object.fromEntries(probes.map(([name, observation]) => [name, {...observation, hints: []}]));
  const hint = (name, path, version) => {
    const manager = managers[name] ||= {status: 'not-probed', hints: []};
    if (manager.hints.length < 12 && !manager.hints.includes(path)) manager.hints.push(path);
    if (version && !manager.declaredVersion) manager.declaredVersion = version;
  };
  for (const file of discovery.files) {
    if (file.type !== 'file' || file.path.split('/').some(part => TEST_TREES.has(part.toLowerCase()))) continue;
    const manager = LOCKFILE_MANAGERS.get(basename(file.path));
    if (manager) hint(manager, file.path);
  }
  for (const manifest of discovery.manifests) {
    if (manifest.packageManager) hint(manifest.packageManager.name, manifest.path, manifest.packageManager.version);
    for (const tool of manifest.tools || []) if (['poetry', 'pdm', 'hatch', 'uv'].includes(tool)) hint(tool, manifest.path);
  }
  return managers;
}

function buildTestHints(manifests) {
  const hints = [];
  for (const manifest of manifests) {
    if (manifest.buildTestTargets?.length) hints.push(`${manifest.path} targets ${manifest.buildTestTargets.join(',')}`);
    if (manifest.tools?.length || manifest.buildBackend) hints.push(`${manifest.path} tools ${(manifest.tools || []).join(',')}` +
      `${manifest.buildBackend ? `; backend ${manifest.buildBackend}` : ''}`);
  }
  return boundedText(hints.join('; '), 180);
}

/** Capture a bounded local snapshot. External reachability requires networkAllowed === true. */
export async function captureEnvironment({cwd = process.cwd(), task = '', entrypoints = false,
  networkAllowed = false, maxBytes = SNAPSHOT_BYTES, runCommand} = {}) {
  const root = resolve(cwd);
  const discoveryPromise = discover(root);
  const identityPromise = localIdentity();
  const packagePromise = Promise.all(PACKAGE_PROBES.map(async ([name, command]) =>
    [name, await probe(runCommand, command, ['--version'], root, {maxOutputBytes: 512})]));
  const toolResultsPromise = Promise.all(PROBES.map(async ([command, args]) =>
    [command, await probe(runCommand, command, args, root)]));
  const entriesPromise = entrypoints === true
    ? toolResultsPromise.then(tools => discoverEntries(root, task, runCommand, Object.fromEntries(tools).rg))
    : Promise.resolve({entries: [], info: {status: 'disabled', sourceFiles: []}});
  const gitPromise = probe(runCommand, 'git', ['--no-optional-locks', '-c', 'core.fsmonitor=false',
    'status', '--porcelain=v1', '--branch', '--untracked-files=no'], root, {maxOutputBytes: 1024});
  const servicesPromise = probe(runCommand, 'ss', ['-ltn'], root, {maxOutputBytes: 1024});
  const diskPromise = probe(runCommand, 'df', ['-Pk', root], root, {maxOutputBytes: 1024});
  const networkPromise = networkAllowed === true
    ? probe(runCommand, 'curl', ['--disable', '--head', '--max-time', '2', '--silent', '--show-error', 'https://example.com'],
      root, {timeoutMs: 2000, maxOutputBytes: 512, networkAllowed: true})
    : Promise.resolve({status: 'skipped', reason: 'external reachability disabled by free-only policy', timeoutMs: 2000});
  const [discovery, tools, git, services, disk, network, entryDiscovery, identity, packageProbes] = await Promise.all([
    discoveryPromise, toolResultsPromise, gitPromise, servicesPromise, diskPromise, networkPromise, entriesPromise,
    identityPromise, packagePromise]);
  const packageManagers = packageManagerInfo(discovery, packageProbes);
  const entryPoints = entryDiscovery.entries.slice(0, 10);
  const resources = {platform: platform(), architecture: arch(), cpuCount: availableParallelism(),
    totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), disk};
  const details = {...discovery, entryPoints, entryPointDiscovery: entryDiscovery.info,
    tools: Object.fromEntries(tools), resources, git, services, network, ...identity, packageManagers};
  const lines = ['APEX local environment (directory depth <=2)',
    `Project: ${discovery.project.status}${discovery.truncated ? ' (listing capped)' : ''}`,
    `External reachability: ${network.status}${network.status === 'skipped' ? ' (free-only; two-second probe disabled)' : ''}`,
    `Resources: ${resources.platform}/${resources.architecture}, ${resources.cpuCount} CPUs, ` +
      `${Math.round(resources.totalMemoryBytes / 1048576)} MiB RAM`];
  lines.push(`Distro: ${identity.distro.status === 'available' ? displayPath(identity.distro.name, 66) : 'unavailable'}`,
    `Shell: ${identity.shell.status === 'available' ? displayPath(identity.shell.path, 66) : 'unavailable'}`,
    `User: ${identity.user.status === 'available' ? displayPath(identity.user.username, 48) : 'unavailable'}`,
    `Package managers: ${boundedText(Object.entries(packageManagers).map(([name, value]) =>
      `${name}${value.declaredVersion ? `@${value.declaredVersion}` : ''} ` +
      `${value.status === 'available' ? boundedText(value.stdout || value.stderr, 28).split(/[\r\n]/)[0] || 'available' : value.hints.length ? 'declared' : value.status}`).join(', '), 160)}`);
  const buildHints = buildTestHints(discovery.manifests);
  if (buildHints) lines.push(`Build/test hints: ${buildHints}`);
  if (entrypoints === true) {
    lines.push(`Entry discovery: ${entryDiscovery.info.status} (${entryDiscovery.info.reason})`);
    lines.push('Entry points (ranked, paths may be abbreviated):');
    for (const entry of entryPoints) lines.push(`${displayPath(entry.path)}: ${boundedText(entry.reason, 36)}`);
    if (!entryPoints.length) lines.push('unavailable');
  }
  lines.push('Local tools:', ...tools.map(([name, value]) => summary(name, value)),
    summary('Git status', git), summary('Listening services', services), summary('Disk', disk));
  if (discovery.manifests.length) {
    lines.push('Manifests:', ...discovery.manifests.slice(0, 6).map(manifest =>
      `${JSON.stringify(manifest.path)}: ${manifest.status}${manifest.scripts.length ? `; scripts ${manifest.scripts.join(', ')}` : ''}`));
  }
  lines.push('Files:', ...discovery.files.map(file => JSON.stringify(file.path)));
  const bytes = Number.isInteger(maxBytes) ? Math.max(0, Math.min(SNAPSHOT_BYTES, maxBytes)) : SNAPSHOT_BYTES;
  return {text: boundedText(lines.join('\n'), bytes), details};
}
