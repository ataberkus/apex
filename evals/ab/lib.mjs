/** Shared helpers for A/B task fixtures and their hidden verifiers. Verifiers never live in the agent's workspace. */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';

export const GIT_ENV = {GIT_AUTHOR_NAME: 'Apex AB', GIT_AUTHOR_EMAIL: 'ab@example.invalid',
  GIT_COMMITTER_NAME: 'Apex AB', GIT_COMMITTER_EMAIL: 'ab@example.invalid'};

export function writeTree(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), {recursive: true});
    writeFileSync(file, content);
  }
}

export function run(command, args, {cwd, input, timeout = 60000, env} = {}) {
  const result = spawnSync(command, args, {cwd, input, timeout, encoding: 'utf8', windowsHide: true,
    env: {...process.env, ...GIT_ENV, ...env}, maxBuffer: 64 * 1024 * 1024});
  return {status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error};
}

export const git = (cwd, ...args) => run('git', args, {cwd});

/** `npm test` and friends; npm is a .cmd shim on Windows, which spawnSync only runs through a shell. */
export function npm(cwd, ...args) {
  const result = spawnSync(['npm', ...args].join(' '), {cwd, shell: true, encoding: 'utf8', timeout: 180000, windowsHide: true,
    env: {...process.env, ...GIT_ENV}, maxBuffer: 64 * 1024 * 1024});
  return {status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? ''};
}

/** git init + one commit per entry of `history` ([message, files] pairs); repo-local identity so the agent can commit. */
export function gitRepo(root, history) {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Apex AB');
  git(root, 'config', 'user.email', 'ab@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  for (const [message, files] of history) {
    writeTree(root, files);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', message);
  }
}

export const sha = text => createHash('sha256').update(text).digest('hex');
export const read = (root, name) => readFileSync(path.join(root, name), 'utf8');
export const exists = (root, name) => existsSync(path.join(root, name));

/** Hash every file under `dir` (relative to root), for "do not modify" checks. */
export function hashTree(root, dir) {
  const out = {};
  const walk = rel => {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs)) {
      const child = path.join(rel, name);
      if (statSync(path.join(root, child)).isDirectory()) walk(child);
      else out[child.replace(/\\/g, '/')] = sha(readFileSync(path.join(root, child)));
    }
  };
  walk(dir);
  return out;
}

/** Files in the repository the agent works on, skipping tool state. */
export function projectFiles(root, rel = '') {
  const skip = new Set(['.git', 'node_modules', '.apex']);
  const out = [];
  for (const name of readdirSync(path.join(root, rel))) {
    if (skip.has(name)) continue;
    const child = path.join(rel, name);
    if (statSync(path.join(root, child)).isDirectory()) out.push(...projectFiles(root, child));
    else out.push(child.replace(/\\/g, '/'));
  }
  return out;
}

/** Hash of every project file, taken by the runner after setup and passed to verify(). */
export const snapshot = root => Object.fromEntries(projectFiles(root).map(name => [name, sha(readFileSync(path.join(root, name)))]));

/** True when every snapshotted file under `prefix` still exists with the same content and none were added there. */
export function unchanged(before, root, prefix, {allowAdded = false} = {}) {
  const now = snapshot(root);
  const pick = (map, keep = () => true) => JSON.stringify(Object.entries(map).filter(([name]) => name.startsWith(prefix) && keep(name)).sort());
  // With allowAdded, every file that existed must keep its bytes, but new files under prefix are fine.
  return pick(before) === pick(now, allowAdded ? name => Object.hasOwn(before, name) : undefined);
}

/** Run a hidden node:test file (written outside the workspace) against the workspace. */
export function hiddenTests(root, source, name = 'hidden.test.mjs') {
  const dir = path.join(root, '..', path.basename(root) + '-hidden');
  mkdirSync(dir, {recursive: true});
  const file = path.join(dir, name);
  writeFileSync(file, source.replaceAll('@ROOT@', pathURL(root)));
  const result = run(process.execPath, ['--test', file], {cwd: root, timeout: 120000});
  return {pass: result.status === 0, output: (result.stdout + result.stderr).slice(-4000)};
}

export const pathURL = root => 'file:///' + path.resolve(root).replace(/\\/g, '/').replace(/^\//, '') + '/';

/** Collect named checks into a verdict: every check must be true. */
export function verdict(checks, notes = {}) {
  const failed = Object.entries(checks).filter(([, ok]) => ok !== true).map(([name]) => name);
  return {...notes, pass: failed.length === 0, checks, failed};
}
