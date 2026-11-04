import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function pythonRuntime(root, probeOptions = {}) {
  const configured = process.env.APEX_PYTHON;
  if (configured) return {command: configured, prefix: []};
  const local = process.platform === 'win32'
    ? path.join(root, '.tools', 'uv', 'harbor', 'Scripts', 'python.exe')
    : path.join(root, '.tools', 'uv', 'harbor', 'bin', 'python');
  if (existsSync(local)) return {command: local, prefix: []};
  for (const candidate of process.platform === 'win32'
    ? [{command: 'py', prefix: ['-3']}, {command: 'python', prefix: []}]
    : [{command: 'python3', prefix: []}, {command: 'python', prefix: []}]) {
    const result = spawnSync(candidate.command, [...candidate.prefix, '--version'], {encoding: 'utf8', ...probeOptions});
    if (result.status === 0) return candidate;
  }
  throw new Error('Python 3.12+ is required. Set APEX_PYTHON to the Harbor Python executable.');
}
