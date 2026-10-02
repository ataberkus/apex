import { symlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const unixOnly = process.platform === 'win32' ? 'Requires POSIX executable modes, FIFOs or Unix process groups; unexercised on Windows' : false;

export function directoryLink(target, filename) {
  return symlink(resolve(dirname(filename), target), filename, process.platform === 'win32' ? 'junction' : 'dir');
}

export async function fileLink(t, target, filename) {
  try {
    await symlink(target, filename, 'file');
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
