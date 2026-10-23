#!/usr/bin/env bun
/**
 * Freeze this Apex working tree into NEW_DEST so a long A/B run (`run.mjs --apex-root NEW_DEST`) is unaffected by
 * later edits. Copies tracked and untracked non-ignored files, links node_modules (so dependency changes still
 * reach the snapshot), and writes apex-snapshot.json (HEAD, tree hash) and apex-snapshot.patch beside them.
 *
 *   bun evals/ab/snapshot.mjs NEW_DEST
 */
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const source = fileURLToPath(new URL('../..', import.meta.url));
const dest = process.argv[2] && path.resolve(process.argv[2]);
if (!dest || existsSync(dest)) throw Error('usage: bun evals/ab/snapshot.mjs NEW_DEST (must not exist)');
const git = (...args) => spawnSync('git', args, {cwd: source, encoding: 'utf8', maxBuffer: 1 << 28});
const listed = flags => git('ls-files', ...flags, '--exclude-standard', '-z').stdout.split('\0')
  .filter(file => file && !file.startsWith('.claude/') && existsSync(path.join(source, file))).sort();
const files = listed(['-co']);
const tree = createHash('sha256');
for (const file of files) {
  const target = path.join(dest, file);
  mkdirSync(path.dirname(target), {recursive: true});
  copyFileSync(path.join(source, file), target);
  tree.update(file + '\0' + createHash('sha256').update(readFileSync(target)).digest('hex') + '\n');
}
symlinkSync(path.join(source, 'node_modules'), path.join(dest, 'node_modules'), 'junction');
// git diff HEAD omits untracked files, so each one is appended as a diff against /dev/null.
let patch = git('diff', 'HEAD', '--binary').stdout;
for (const file of listed(['-o'])) patch += git('diff', '--no-index', '--binary', '--', '/dev/null', file).stdout;
writeFileSync(path.join(dest, 'apex-snapshot.patch'), patch);
// Dirty means the copy differs from HEAD, so the untracked .claude/ left out of both does not count.
const meta = {head: git('rev-parse', 'HEAD').stdout.trim(), dirty: patch !== '',
  treeSha256: tree.digest('hex'), files: files.length, source, createdAt: new Date().toISOString()};
writeFileSync(path.join(dest, 'apex-snapshot.json'), JSON.stringify(meta, null, 2) + '\n');
console.log(JSON.stringify(meta));
