import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/** Atomic ACL creation/verification. No chmod fallback or policy bypass. */
export async function runWindowsPrivateHelper(root, {name, raw = '', signal} = {}) {
  if (process.platform !== 'win32') throw new Error('Windows private storage requires native Windows.');
  if (signal?.aborted) throw new Error('Windows private storage operation aborted.');
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    const source = Object.keys(process.env).find(item => item.toUpperCase() === key.toUpperCase());
    if (source !== undefined) env[key] = process.env[source];
  }
  const executable = path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const helper = fileURLToPath(new URL('../extensions/apex-context/private-spill.ps1', import.meta.url));
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper, '-Root', root,
    ...(name ? ['-Name', name] : ['-DirectoryOnly'])];
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {cwd: root, env, signal, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe']});
    let stderr = '', failure;
    const timer = setTimeout(() => {failure = new Error('Windows private storage helper exceeded its 15 second bound.'); child.kill();}, 15000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => {stderr = (stderr + text).slice(-65536);});
    child.on('error', error => {failure = error;});
    child.stdin.on('error', error => {failure ??= error;});
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && !failure) resolve();
      else reject(failure ?? new Error(stderr.trim() || `Windows private storage helper exited ${code}`));
    });
    child.stdin.end(raw, 'utf8');
  });
}

export const ensureWindowsPrivateApex = (root, signal) => runWindowsPrivateHelper(root, {signal});
