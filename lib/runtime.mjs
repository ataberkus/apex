import {existsSync, statSync} from 'node:fs';
import path from 'node:path';

// Apex runs on Bun: bin/apex, the dashboard and every Pi child start under the executable running this process.
// A long-lived dashboard can outlive that file (Bun reinstalled or moved); then `bun` on PATH is used instead.

export function runtimeExecutable({execPath = process.execPath, env = process.env, platform = process.platform} = {}) {
  if (path.isAbsolute(execPath) && existsSync(execPath)) return execPath;
  const names = platform === 'win32' ? ['bun.exe'] : ['bun'];
  for (const folder of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(folder, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return execPath; // spawn fails with ENOENT and spawnFailure names the missing runtime
}

export const isDirectory = folder => { try { return statSync(folder).isDirectory(); } catch { return false; } };

/** libuv reports a missing cwd as `spawn <executable> ENOENT`, naming the executable; say which one is actually gone. */
export function spawnFailure(error, {command, cwd = process.cwd()}) {
  if (error?.code !== 'ENOENT') return error?.message ?? String(error);
  if (!isDirectory(cwd)) return `The folder ${cwd} does not exist (moved or deleted). Restore it, or remove it and add the new location.`;
  if (!existsSync(command)) return `Bun was not found at ${command}. Install Bun (https://bun.sh) or put bun on PATH, then restart Apex.`;
  return error.message;
}
