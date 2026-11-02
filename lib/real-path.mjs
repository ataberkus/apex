import {lstat, realpath} from 'node:fs/promises';
import path from 'node:path';

const parts = (value, root) => value.slice(root.length).split(path.sep).filter(Boolean);

/**
 * The canonical spelling of a resolved path, or undefined when reaching it crosses a symlink or junction. On Windows
 * realpath also expands 8.3 names and normalizes case, so a difference alone proves nothing: there the two spellings
 * must name the same entries, one for one, none of them a link. Everywhere else any difference is a link.
 */
export async function linkFreeRealpath(absolute) {
  const real = await realpath(absolute);
  if (real === absolute) return real;
  if (process.platform !== 'win32') return undefined;
  const given = path.parse(absolute).root, canonical = path.parse(real).root;
  const names = parts(absolute, given), realNames = parts(real, canonical);
  if (given.toUpperCase() !== canonical.toUpperCase() || names.length !== realNames.length) return undefined;
  let left = given, right = canonical;
  for (let index = 0; index < names.length; index++) {
    left = path.join(left, names[index]); right = path.join(right, realNames[index]);
    const [one, other] = await Promise.all([lstat(left, {bigint: true}), lstat(right, {bigint: true})]);
    if (one.isSymbolicLink() || other.isSymbolicLink() || one.dev !== other.dev || one.ino !== other.ino) return undefined;
  }
  return real;
}
