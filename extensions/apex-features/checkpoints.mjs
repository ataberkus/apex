import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, realpath, mkdir, open, writeFile, readdir, rename, unlink, rmdir, rm, chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {ensureWindowsPrivateApex} from '../../lib/windows-private-storage.mjs';

// Windows refuses a rename while another process (antivirus, an indexer) holds either file without
// share-delete. Those holds are brief, so retry for about five seconds before failing.
async function renameRetrying(from, to) {
  for (let delay = 20; ; delay *= 2) {
    try { return await rename(from, to); } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || delay > 2560) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

const exec = promisify(execFile);
const queues = new Map();
// gitTimeoutMs guards against hung Git, not slow Git: a session's first capture runs `git add --all` over the whole
// tree into an empty shadow store. On Windows, 660 files / 37 MB took 8.9–38.3 s across fresh copies.
const DEFAULTS = Object.freeze({ maxFiles: 5000, maxBytes: 64 * 1024 * 1024, maxFileBytes: 8 * 1024 * 1024, maxCheckpoints: 50, maxStoredBytes: 256 * 1024 * 1024, maxMetadataBytes: 16 * 1024 * 1024, maxGitOutputBytes: 4 * 1024 * 1024, gitTimeoutMs: 120000 });
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message, details) => Object.assign(new Error(message), { name: 'CheckpointError', code, ...(details ? { details } : {}) });
const cancelled = signal => { if (signal?.aborted) throw fail('cancelled', 'Checkpoint operation cancelled'); };
const equal = (a, b) => (!a && !b) || Boolean(a && b && a.hash === b.hash && a.size === b.size && a.mode === b.mode);
// Oversized files are in neither snapshot, so their absence is not a change: undo never writes or deletes them.
const changes = record => { const skipped = new Set(record.skippedPaths ?? []); return [...new Set([...Object.keys(record.before), ...Object.keys(record.after)])].filter(name => !skipped.has(name) && !equal(record.before[name], record.after[name])).sort(); };
// History is the content (by SHA-256) the records hold; Git stores identical content once.
const charged = records => { const sizes = new Map(); for (const record of records) for (const file of [...Object.values(record.before), ...Object.values(record.after ?? {})]) sizes.set(file.hash, file.size); let total = 0; for (const size of sizes.values()) total += size; return total; };
const hex = (value, lengths = [64]) => typeof value === 'string' && lengths.includes(value.length) && /^[a-f0-9]+$/.test(value);
const privatePart = value => /^(?:\.git|version-control|\.apex|\.ssh|\.aws|\.gnupg|\.codex|\.cache|\.tools|node_modules)$/i.test(value) || /^(?:\.env(?:[.\-].*)?|auth\.json|credentials(?:\.json)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i.test(value);
function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value) || value.split('/').some(p => !p || p === '.' || p === '..' || privatePart(p))) throw fail('unsafe-path', 'Checkpoint path is private, external or invalid');
  return value;
}
function validTurn(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw fail('invalid-turn', 'Checkpoint turn ID is invalid');
  return value;
}
async function maybeStat(file) { try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function boundedRead(handle, initialSize, maxBytes, signal) {
  const buffer = Buffer.alloc(Math.min(Number(initialSize) + 1, maxBytes + 1));
  let length = 0;
  while (length < buffer.length) {
    cancelled(signal);
    const { bytesRead } = await handle.read(buffer, length, Math.min(128 * 1024, buffer.length - length), length);
    cancelled(signal);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return buffer.subarray(0, length);
}

/** Factory is inert. Only explicit methods perform bounded local I/O. */
export function createCheckpointManager({ cwd, sessionId, runGit, limits: configured = {} } = {}) {
  if (typeof cwd !== 'string' || !cwd || typeof sessionId !== 'string' || !sessionId || sessionId.length > 4096) throw fail('invalid-options', 'Checkpoint cwd and stable sessionId are required');
  if (runGit !== undefined && typeof runGit !== 'function') throw fail('invalid-options', 'runGit must be a function');
  const limits = { ...DEFAULTS, ...configured };
  for (const [name, value] of Object.entries(limits)) if (!Object.hasOwn(DEFAULTS, name) || !Number.isSafeInteger(value) || value < 1 || value > DEFAULTS[name]) throw fail('invalid-options', `Checkpoint limit ${name} is invalid or exceeds the hard cap`);
  const root = path.resolve(cwd);
  const sessionKey = sha(sessionId);
  const store = path.join(root, '.apex', 'checkpoints', sessionKey);
  const shadow = path.join(store, 'shadow');
  const stateFile = path.join(store, 'state.json');
  const lockKey = `${root}\0${sessionKey}`;
  const lifecycle = new AbortController();
  const pending = new Set();
  const captures = new Map();
  let closed = false;

  const cleanEnv = () => ({ ...Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'CODEX_PRIMARY_RUNTIME_NODE'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
  async function git(args, workdir, signal, encoding = 'utf8', input) {
    cancelled(signal);
    // ponytail: Git for Windows cannot run from a cwd of 247+ chars and Node crashes spawning past MAX_PATH;
    // project roots up to ~156 chars fit. A shorter store layout would raise this but orphan existing checkpoints.
    if (process.platform === 'win32' && workdir.length > 246) throw fail('path-too-long', 'Checkpoint storage exceeds the Windows Git working-directory limit; use a shorter project path');
    // Shadow paths stay relative to cwd=shadow: Git for Windows rejects an absolute $GIT_DIR over PATH_MAX-40,
    // and core.longpaths lets refs/objects under .apex/checkpoints/<sha256>/shadow exceed MAX_PATH.
    const shadowArgs = workdir === shadow ? ['--git-dir', '.git', '--work-tree', '.'] : [];
    const commands = ['-c', 'core.longpaths=true', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.excludesFile=/dev/null', '-c', 'core.attributesFile=/dev/null', '-c', 'core.autocrlf=false', '-c', 'core.filemode=true', '-c', 'commit.gpgsign=false', '-c', 'user.name=Apex checkpoints', '-c', 'user.email=checkpoint@localhost', ...shadowArgs, ...args];
    const timeout = new AbortController();
    const merged = AbortSignal.any([signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(), limits.gitTimeoutMs);
    let abortListener;
    try {
      const abort = new Promise((_, reject) => { abortListener = () => reject(fail(timeout.signal.aborted ? 'git-timeout' : 'cancelled', timeout.signal.aborted ? 'Checkpoint Git time limit exceeded' : 'Checkpoint operation cancelled')); merged.addEventListener('abort', abortListener, { once: true }); });
      const maxOutput = encoding === 'buffer' ? limits.maxFileBytes : limits.maxGitOutputBytes;
      const options = { cwd: workdir, env: { ...cleanEnv(), ...(workdir === shadow ? { GIT_COMMON_DIR: '.git', GIT_OBJECT_DIRECTORY: '.git/objects' } : {}) }, signal: merged, timeout: limits.gitTimeoutMs, maxBuffer: maxOutput, encoding, ...(input !== undefined ? { input } : {}) };
      let execution;
      if (runGit) execution = runGit(commands, options);
      else {
        execution = exec('git', commands, options);
        execution.child.stdin.on('error', () => {});
        execution.child.stdin.end(input);
      }
      const result = await Promise.race([execution, abort]);
      cancelled(signal);
      const code = result?.code ?? result?.exitCode ?? 0;
      if (code !== 0 && !(args.includes('check-ignore') && code === 1)) throw fail('git-failed', 'Checkpoint Git command failed');
      const output = result?.stdout ?? '';
      if (Buffer.byteLength(output) > maxOutput) throw fail('cap', 'Checkpoint Git output byte cap exceeded');
      return output;
    } finally { clearTimeout(timer); if (abortListener) merged.removeEventListener('abort', abortListener); }
  }

  async function ensureDir(relative, create = false) {
    let current = root;
    for (const component of relative.split('/')) {
      current = path.join(current, component);
      let info = await maybeStat(current);
      if (!info && create) {
        if (process.platform === 'win32' && component === '.apex') await ensureWindowsPrivateApex(root);
        else await mkdir(current, { mode: 0o700 });
        info = await lstat(current);
      }
      if (!info) return false;
      if (info.isSymbolicLink()) throw fail('symlink', 'Checkpoint private storage contains a symlink');
      if (!info.isDirectory()) throw fail('unsafe-path', 'Checkpoint private storage is not a directory');
    }
    return true;
  }
  async function validateRoot() {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw fail('symlink', 'Checkpoint cwd must be a real directory without symlink ancestors');
  }
  async function userGit(signal) {
    cancelled(signal);
    for (const candidate of ['.git', 'version-control']) {
      const metadata = path.join(root, candidate);
      const info = await maybeStat(metadata);
      if (!info) continue;
      if (info.isSymbolicLink() || !info.isDirectory()) throw fail('symlink', 'Checkpoint repository metadata must be a local directory');
      const head = await maybeStat(path.join(metadata, 'HEAD'));
      if (!head) continue;
      if (!head.isFile() || head.isSymbolicLink()) throw fail('symlink', 'Checkpoint repository HEAD must be a regular file');
      for (const name of ['config', 'index', 'info', 'info/exclude', 'commondir']) {
        const entry = await maybeStat(path.join(metadata, name));
        if (entry?.isSymbolicLink()) throw fail('symlink', 'Checkpoint repository metadata contains an external symlink');
        if (entry && name === 'commondir') throw fail('metadata', 'Checkpoint external repository indirection is unsupported');
      }
      return ['--git-dir', metadata, '--work-tree', root];
    }
    throw fail('no-repository', 'Checkpoints require local Git metadata');
  }
  async function checkedParents(relative, create = false, created = []) {
    safePath(relative);
    let current = root;
    for (const part of relative.split('/').slice(0, -1)) {
      current = path.join(current, part);
      let info = await maybeStat(current);
      if (!info && create) { await mkdir(current, { mode: 0o755 }); created.push(current); info = await lstat(current); }
      if (!info) return false;
      if (info.isSymbolicLink()) throw fail('symlink', 'Checkpoint path has a symlink ancestor');
      if (!info.isDirectory()) throw fail('conflict', 'Checkpoint path ancestor is not a directory');
    }
    return true;
  }
  async function sourceFile(relative, signal) {
    cancelled(signal);
    if (!await checkedParents(relative)) return null;
    const file = path.join(root, relative);
    const info = await maybeStat(file);
    if (!info) return null;
    if (info.isSymbolicLink()) throw fail('symlink', 'Checkpoint source contains a symlink');
    if (!info.isFile() || info.nlink !== 1) throw fail('unsafe-path', 'Checkpoint source must be a regular file with one link');
    if (info.size > limits.maxFileBytes) throw fail('cap', 'Checkpoint per-file byte cap exceeded');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limits.maxFileBytes)) throw fail('unsafe-path', 'Checkpoint file changed type or exceeds its byte cap');
      const bytes = await boundedRead(handle, before.size, limits.maxFileBytes, signal);
      const after = await handle.stat({ bigint: true });
      cancelled(signal);
      if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || bytes.length !== Number(before.size)) throw fail('conflict', 'Checkpoint source changed during snapshot');
      return { descriptor: { hash: sha(bytes), size: bytes.length, mode: Number(after.mode & 0o777n) }, bytes };
    } finally { await handle.close(); }
  }
  async function ignored(paths, repo, signal) {
    if (!paths.length) return new Set();
    // NUL-delimited stdin preserves literal newlines/tabs in filenames.
    const found = new Set();
    for (let i = 0; i < paths.length; i += 100) {
      try {
        const output = await git([...repo, 'check-ignore', '--no-index', '-z', '--stdin'], root, signal, 'utf8', paths.slice(i, i + 100).join('\0') + '\0');
        for (const name of String(output).split('\0').filter(Boolean)) found.add(name);
      } catch (error) { if (error.code !== 1) throw error; }
    }
    return found;
  }
  async function collect(signal) {
    const repo = await userGit(signal);
    const output = await git([...repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], root, signal);
    const candidates = [...new Set(String(output).split('\0').filter(Boolean))].filter(name => {
      if (name.split('/').some(privatePart)) return false;
      safePath(name); return true;
    }).sort();
    if (candidates.length > limits.maxFiles) throw fail('cap', 'Checkpoint file count cap exceeded');
    const excluded = await ignored(candidates, repo, signal);
    // Smallest first, so past maxBytes the large files (assets, datasets) are the ones left out, not source code.
    // A stat error sorts the path first and leaves sourceFile to report it as before.
    const sized = [];
    for (const relative of candidates) if (!excluded.has(relative)) { cancelled(signal); sized.push([relative, await lstat(path.join(root, relative)).then(info => info.size, () => 0)]); }
    sized.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
    const files = Object.create(null); const contents = new Map(); const skipped = []; let bytes = 0;
    for (const [relative, size] of sized) {
      // A file that does not fit is skipped unread: a large repository must not block every mutation, nor be read in full per capture.
      if (bytes + size > limits.maxBytes) { skipped.push(relative); continue; }
      let file;
      // One oversized file (a dataset, a build artifact) must not block every mutation: leave it out and record it.
      try { file = await sourceFile(relative, signal); } catch (error) { if (error.code !== 'cap') throw error; skipped.push(relative); continue; }
      if (!file) continue;
      if (bytes + file.bytes.length > limits.maxBytes) { skipped.push(relative); continue; }
      bytes += file.bytes.length;
      files[relative] = file.descriptor; contents.set(relative, file.bytes);
    }
    return { files, contents, bytes, repo, skipped: skipped.sort() };
  }
  const blank = () => ({ version: 1, sessionKey, cwd: root, storedBytes: 0, records: [] });
  function validateState(state) {
    // maxCheckpoints + 1: save exempts the turn being captured until finish knows whether it changed anything.
    if (!state || state.version !== 1 || state.sessionKey !== sessionKey || state.cwd !== root || !Array.isArray(state.records) || state.records.length > limits.maxCheckpoints + 1 || !Number.isSafeInteger(state.storedBytes) || state.storedBytes < 0 || state.storedBytes > limits.maxStoredBytes) throw fail('metadata', 'Checkpoint metadata is invalid or foreign');
    const ids = new Set();
    for (const record of state.records) {
      validTurn(record.turnId);
      if (ids.has(record.turnId) || !['captured', 'finished', 'restored'].includes(record.status) || !hex(record.beforeCommit, [40, 64]) || !Array.isArray(record.changedPaths) || record.skippedPaths !== undefined && (!Array.isArray(record.skippedPaths) || record.skippedPaths.length > limits.maxFiles * 2)) throw fail('metadata', 'Checkpoint record metadata is invalid');
      ids.add(record.turnId);
      for (const name of [...record.changedPaths, ...record.skippedPaths ?? []]) safePath(name);
      for (const stage of ['before', ...(record.status !== 'captured' ? ['after'] : [])]) {
        const files = record[stage]; let bytes = 0;
        if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length > limits.maxFiles) throw fail('metadata', 'Checkpoint file metadata is invalid');
        for (const [name, file] of Object.entries(files)) {
          safePath(name);
          if (!file || !hex(file.hash) || !hex(file.blob, [40, 64]) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > limits.maxFileBytes || !Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777) throw fail('metadata', 'Checkpoint file metadata is invalid');
          bytes += file.size;
        }
        if (bytes > limits.maxBytes) throw fail('metadata', 'Checkpoint file metadata exceeds its byte cap');
      }
      if (record.status !== 'captured') {
        if (!hex(record.afterCommit, [40, 64])) throw fail('metadata', 'Checkpoint post-turn commit metadata is invalid');
        if (JSON.stringify(changes(record)) !== JSON.stringify(record.changedPaths)) throw fail('metadata', 'Checkpoint changed path metadata is inconsistent');
      }
    }
    return state;
  }
  async function privateFile(file, maxBytes = limits.maxMetadataBytes, signal) {
    cancelled(signal);
    const info = await maybeStat(file);
    if (!info) return null;
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw fail('metadata', 'Checkpoint private file is unsafe or exceeds its cap');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)) throw fail('metadata', 'Checkpoint private file changed type or exceeds its cap');
      const bytes = await boundedRead(handle, before.size, maxBytes, signal);
      const after = await handle.stat({ bigint: true });
      cancelled(signal);
      if (bytes.length > maxBytes || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || bytes.length !== Number(before.size)) throw fail('metadata', 'Checkpoint private file changed during its bounded read');
      return bytes;
    } finally { await handle.close(); }
  }
  async function load(signal) {
    cancelled(signal);
    await validateRoot();
    if (!await ensureDir(`.apex/checkpoints/${sessionKey}`)) return blank();
    const bytes = await privateFile(stateFile, limits.maxMetadataBytes, signal);
    if (!bytes) return blank();
    try { return validateState(JSON.parse(bytes.toString('utf8'))); } catch (error) { if (error.name === 'CheckpointError') throw error; throw fail('metadata', 'Checkpoint metadata is malformed'); }
  }
  async function save(state, keep) {
    // Drop the oldest records instead of failing: a long session must keep capturing, and only their undo is lost.
    // Records are independent snapshots, so the ones that remain restore exactly as before. A capture in flight is not
    // counted: most turns change nothing, and evicting a real record for each of them would empty undo.
    const room = limits.maxCheckpoints + (keep?.status === 'captured' ? 1 : 0);
    let data;
    for (;;) {
      state.storedBytes = charged(state.records);
      data = Buffer.from(JSON.stringify(state));
      if (state.records.length <= room && data.length <= limits.maxMetadataBytes) break;
      if (state.records.length < 2) throw fail('cap', 'Checkpoint metadata byte cap exceeded');
      state.records.splice(state.records[0] === keep ? 1 : 0, 1);
    }
    validateState(state);
    await ensureDir(`.apex/checkpoints/${sessionKey}`, true);
    const temporary = path.join(store, `state-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    try { await renameRetrying(temporary, stateFile); } catch (error) { await unlink(temporary); throw error; }
  }
  async function shadowReady(signal) {
    await ensureDir(`.apex/checkpoints/${sessionKey}`, true);
    if (!await ensureDir(`.apex/checkpoints/${sessionKey}/shadow`)) {
      await git(['init', '--template=', '-q', shadow], store, signal);
      await chmod(shadow, 0o700);
    }
    if (!await ensureDir(`.apex/checkpoints/${sessionKey}/shadow/.git`)) throw fail('metadata', 'Checkpoint shadow Git metadata is missing');
    let entries = 0;
    async function checkTree(directory) {
      for (const name of await readdir(directory)) {
        cancelled(signal);
        if (++entries > limits.maxFiles * limits.maxCheckpoints * 4 + 1000) throw fail('cap', 'Checkpoint shadow metadata entry cap exceeded');
        const file = path.join(directory, name); const info = await lstat(file);
        if (info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw fail('symlink', 'Checkpoint shadow Git metadata contains an unsafe link or file');
        if (info.isDirectory()) await checkTree(file);
      }
    }
    await checkTree(path.join(shadow, '.git'));
    for (const filename of ['commondir', 'gitdir', 'objects/info/alternates', 'info/attributes']) if (await maybeStat(path.join(shadow, '.git', filename))) throw fail('metadata', 'Checkpoint shadow Git external indirection or custom attributes are unsupported');
  }
  async function storageBudget(reserve, signal) {
    let bytes = 0; let entries = 0;
    async function visit(directory) {
      for (const name of await readdir(directory)) {
        cancelled(signal);
        if (++entries > limits.maxFiles * limits.maxCheckpoints * 4 + 1000) throw fail('cap', 'Checkpoint private storage entry cap exceeded');
        const file = path.join(directory, name); const info = await lstat(file);
        if (info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw fail('symlink', 'Checkpoint private storage contains an unsafe link or file');
        if (info.isDirectory()) await visit(file);
        else bytes += info.size;
        if (bytes + reserve > limits.maxStoredBytes) throw fail('cap', 'Checkpoint private storage byte cap exceeded');
      }
    }
    if (reserve > limits.maxStoredBytes) throw fail('cap', 'Checkpoint private storage byte cap exceeded');
    await visit(store);
  }
  async function snapshot(collected, state, turnId, stage, signal) {
    // Git stores identical content once, so history is charged only for content no record already holds;
    // charging every full snapshot blocked a 37 MB project after three turns. storageBudget still bounds real disk use.
    const held = new Set(state.records.flatMap(record => [...Object.values(record.before), ...Object.values(record.after ?? {})].map(file => file.hash)));
    let added = 0;
    for (const file of Object.values(collected.files)) if (!held.has(file.hash)) { held.add(file.hash); added += file.size; }
    if (state.storedBytes + added > limits.maxStoredBytes) throw fail('cap', 'Checkpoint history byte cap exceeded');
    await shadowReady(signal);
    for (const entry of await readdir(shadow, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      // This is owned private scratch only, never the user's worktree.
      if (entry.isSymbolicLink()) throw fail('symlink', 'Checkpoint shadow worktree contains a symlink');
      await rm(path.join(shadow, entry.name), { recursive: true });
    }
    // Reserve a full new mirror and uncompressed object allowance, including
    // abandoned snapshots/retained recovery backups in the existing budget. The previous mirror is cleared first:
    // counting it too failed the second snapshot of a project with 64 MiB of incompressible kept files.
    await storageBudget(collected.bytes * 2 + collected.contents.size * 1024 + 65536, signal);
    const names = new Map();
    for (const [relative, bytes] of collected.contents) {
      cancelled(signal);
      // Opaque payload names keep source .gitattributes and .gitignore inert.
      const opaque = `payload/${sha(relative)}`; names.set(opaque, relative);
      const file = path.join(shadow, opaque);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, bytes, { mode: collected.files[relative].mode });
      await chmod(file, collected.files[relative].mode);
    }
    await git(['add', '--all', '--', '.'], shadow, signal);
    await git(['commit', '--allow-empty', '--no-verify', '-qm', `apex ${sha(turnId)} ${stage}`], shadow, signal);
    const commit = String(await git(['rev-parse', 'HEAD'], shadow, signal)).trim();
    const tree = String(await git(['ls-tree', '-r', '-z', '--full-tree', commit], shadow, signal));
    const files = Object.create(null);
    for (const entry of tree.split('\0').filter(Boolean)) {
      const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(entry);
      const relative = match && names.get(match[3]);
      if (!match || !relative || !collected.files[relative]) throw fail('metadata', 'Checkpoint shadow Git tree is inconsistent');
      files[relative] = { ...collected.files[relative], blob: match[2] };
    }
    if (Object.keys(files).length !== Object.keys(collected.files).length || !hex(commit, [40, 64])) throw fail('metadata', 'Checkpoint shadow Git snapshot is incomplete');
    return { commit, files };
  }
  const result = record => structuredClone({ turnId: record.turnId, status: record.status, beforeCommit: record.beforeCommit, ...(record.afterCommit ? { afterCommit: record.afterCommit } : {}), changedPaths: record.changedPaths, skippedPaths: record.skippedPaths ?? [], capturedAt: record.capturedAt, ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}) });
  function schedule(options, work) {
    if (closed) return Promise.reject(fail('closed', 'Checkpoint manager is closed after shutdown'));
    const signal = options?.signal ? AbortSignal.any([lifecycle.signal, options.signal]) : lifecycle.signal;
    try { cancelled(signal); } catch (error) { return Promise.reject(error); }
    const previous = queues.get(lockKey) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      cancelled(signal);
      if (process.platform === 'win32') {
        const apex = await maybeStat(path.join(root, '.apex'));
        // Preserve normal symlink/type refusal diagnostics. Existing public roots
        // must never be silently permission-modified or used for private snapshots.
        if (apex?.isDirectory() && !apex.isSymbolicLink()) await ensureWindowsPrivateApex(root, signal);
      }
      cancelled(signal); return work(signal);
    });
    const tail = job.catch(() => {});
    queues.set(lockKey, tail); pending.add(job);
    job.finally(() => { pending.delete(job); if (queues.get(lockKey) === tail) queues.delete(lockKey); }).catch(() => {});
    return job;
  }

  function capture(turnId, options = {}) {
    try { validTurn(turnId); cancelled(options.signal); } catch (error) { return Promise.reject(error); }
    if (captures.has(turnId)) return captures.get(turnId);
    const job = schedule(options, async signal => {
      const state = await load(signal); const existing = state.records.find(record => record.turnId === turnId);
      if (existing) return result(existing);
      const collected = await collect(signal);
      const before = await snapshot(collected, state, turnId, 'before', signal);
      cancelled(signal);
      const record = { turnId, status: 'captured', beforeCommit: before.commit, before: before.files, changedPaths: [], skippedPaths: collected.skipped, capturedAt: new Date().toISOString() };
      state.records.push(record);
      await save(state, record);
      return result(record);
    });
    captures.set(turnId, job); job.finally(() => captures.delete(turnId)).catch(() => {});
    return job;
  }
  function finish(turnId, options = {}) {
    try { validTurn(turnId); } catch (error) { return Promise.reject(error); }
    return schedule(options, async signal => {
      const state = await load(signal); const record = state.records.find(item => item.turnId === turnId);
      if (!record) throw fail('unknown-turn', 'Unknown checkpoint turn');
      if (record.status !== 'captured') return result(record);
      const collected = await collect(signal);
      const skippedPaths = [...new Set([...record.skippedPaths ?? [], ...collected.skipped])].sort();
      // A turn that changed nothing (tests or a read through bash) has nothing to undo; keeping it would only evict one that does.
      if (!changes({ before: record.before, after: collected.files, skippedPaths }).length) {
        state.records.splice(state.records.indexOf(record), 1);
        await save(state);
        return { ...result(record), status: 'unchanged' };
      }
      const after = await snapshot(collected, state, turnId, 'after', signal);
      cancelled(signal);
      record.after = after.files; record.afterCommit = after.commit; record.skippedPaths = skippedPaths;
      record.changedPaths = changes(record);
      record.status = 'finished'; record.finishedAt = new Date().toISOString();
      await save(state, record);
      return result(record);
    });
  }

  function restore(turnId, options = {}) {
    try { validTurn(turnId); } catch (error) { return Promise.reject(error); }
    return schedule(options, async signal => {
      const state = await load(signal); const record = state.records.find(item => item.turnId === turnId);
      if (!record) throw fail('unknown-turn', 'Unknown checkpoint turn');
      if (record.status === 'restored') return { ...result(record), status: 'already-restored' };
      if (record.status !== 'finished') throw fail('unfinished', 'Checkpoint turn must finish before undo');
      for (const relative of record.changedPaths) await checkedParents(relative);
      const repo = await userGit(signal);
      const excluded = await ignored(record.changedPaths, repo, signal);
      if (excluded.size) throw fail('ignored', 'Checkpoint restoration includes a currently ignored path');
      await shadowReady(signal);
      const previous = new Map(); const desired = new Map(); let total = 0;
      for (const relative of record.changedPaths) {
        const current = await sourceFile(relative, signal);
        if (!equal(current?.descriptor, record.after[relative])) throw fail('conflict', 'Checkpoint post-turn conflict; no files restored', { paths: [relative] });
        previous.set(relative, current);
        const before = record.before[relative];
        if (!before) { desired.set(relative, null); continue; }
        const bytes = Buffer.from(await git(['cat-file', 'blob', before.blob], shadow, signal, 'buffer'));
        if (bytes.length !== before.size || sha(bytes) !== before.hash) throw fail('metadata', 'Checkpoint snapshot content does not match its recorded hash');
        total += bytes.length + (current?.bytes.length ?? 0);
        if (total > limits.maxBytes * 2) throw fail('cap', 'Checkpoint restoration byte cap exceeded');
        desired.set(relative, { descriptor: before, bytes });
      }
      cancelled(signal);
      const transaction = path.join(store, `restore-${randomUUID()}`);
      await storageBudget([...previous.values(), ...desired.values()].reduce((sum, value) => sum + (value?.bytes.length ?? 0), 0) + 65536, signal);
      await mkdir(transaction, { mode: 0o700 });
      const created = []; const applied = []; let marker = false; let committed = false;
      const ref = `refs/apex/restored/${sha(turnId)}`;
      try {
        // Fully prepare both directions before the first source mutation.
        for (let i = 0; i < record.changedPaths.length; i++) {
          const relative = record.changedPaths[i];
          for (const [prefix, value] of [['before', desired.get(relative)], ['rollback', previous.get(relative)]]) if (value) {
            const file = path.join(transaction, `${prefix}-${i}`); await writeFile(file, value.bytes, { mode: 0o600 }); await chmod(file, value.descriptor.mode);
          }
        }
        for (let i = 0; i < record.changedPaths.length; i++) {
          const relative = record.changedPaths[i]; cancelled(signal);
          const current = await sourceFile(relative, signal);
          if (!equal(current?.descriptor, previous.get(relative)?.descriptor)) throw fail('conflict', 'Checkpoint source changed during restoration');
          const value = desired.get(relative);
          await checkedParents(relative, Boolean(value), created);
          if (value) await renameRetrying(path.join(transaction, `before-${i}`), path.join(root, relative));
          else if (current) await unlink(path.join(root, relative));
          applied.push({ relative, index: i });
        }
        // Durable shadow marker is written only after actual file restoration.
        await git(['update-ref', ref, record.beforeCommit], shadow, signal); marker = true;
        record.status = 'restored'; record.restoredAt = new Date().toISOString();
        await save(state, record);
        committed = true;
        await rm(transaction, { recursive: true });
        return result(record);
      } catch (error) {
        if (committed) throw fail('cleanup-failed', 'Checkpoint was restored but private transaction cleanup failed', { turnId, status: 'restored', transaction: path.basename(transaction), cause: error.message });
        const failures = [];
        // Rollback deliberately ignores cancellation, but rechecks applied hashes.
        const rollbackSignal = new AbortController().signal;
        for (const { relative, index } of applied.reverse()) {
          try {
            const current = await sourceFile(relative, rollbackSignal);
            if (!equal(current?.descriptor, desired.get(relative)?.descriptor)) throw fail('conflict', 'Checkpoint rollback refused a concurrent manual edit');
            await checkedParents(relative, Boolean(previous.get(relative)), created);
            if (previous.get(relative)) await renameRetrying(path.join(transaction, `rollback-${index}`), path.join(root, relative));
            else if (current) await unlink(path.join(root, relative));
          } catch (rollbackError) { failures.push({ path: relative, message: rollbackError.message }); }
        }
        if (marker) try { await git(['update-ref', '-d', ref], shadow, rollbackSignal); } catch (rollbackError) { failures.push({ path: 'shadow-marker', message: rollbackError.message }); }
        for (const directory of created.reverse()) try { await rmdir(directory); } catch (cleanupError) { if (!['ENOENT', 'ENOTEMPTY'].includes(cleanupError.code)) failures.push({ path: path.relative(root, directory), message: cleanupError.message }); }
        if (failures.length) throw fail('rollback-failed', 'Checkpoint restoration failed and rollback requires manual recovery; private backups retained', { cause: error.message, failures, transaction: path.basename(transaction) });
        await rm(transaction, { recursive: true });
        throw error;
      }
    });
  }
  return {
    capture, finish, restore,
    list: (options = {}) => schedule(options, async signal => (await load(signal)).records.map(result)),
    shutdown: async () => { closed = true; lifecycle.abort(); await Promise.allSettled([...pending]); },
  };
}
