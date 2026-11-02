import { spawnSync } from 'node:child_process';
import { symlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const unixOnly = process.platform === 'win32' ? 'Requires POSIX executable modes, FIFOs or Unix process groups; unexercised on Windows' : false;

export function directoryLink(target, filename) {
  return symlink(resolve(dirname(filename), target), filename, process.platform === 'win32' ? 'junction' : 'dir');
}

/** The 8.3 spelling of an existing path; the same path back on a volume with short names turned off. */
export function shortPath(target) {
  const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"for %I in ("${target}") do @echo %~sI"`],
    {encoding: 'utf8', windowsVerbatimArguments: true, timeout: 60000});
  if (result.status !== 0) throw new Error(`Short path lookup failed: ${result.stderr || result.error}`);
  return result.stdout.trim();
}

export async function fileLink(t, target, filename, type = 'file') {
  try {
    await symlink(target, filename, type);
    return true;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
    const restriction = ['ENOSYS', 'ENOTSUP'].includes(error.code) ? 'runtime/filesystem unsupported' : 'permission restricted';
    const prerequisite = process.platform === 'win32' && restriction === 'permission restricted' ?
      '; requires an environment already allowing unprivileged file symlinks or SeCreateSymbolicLinkPrivilege (see scripts/probe-windows-symlink.mjs)' : '';
    t.skip(`File symlink creation unavailable (${error.code}; ${restriction}); boundary unexercised${prerequisite}`);
    return false;
  }
}
