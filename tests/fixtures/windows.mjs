import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function windowsFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'apex windows ç-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const file = (relative, content = '') => {
    const full = path.join(root, relative); mkdirSync(path.dirname(full), {recursive: true}); writeFileSync(full, content); return full;
  };
  file('node_modules/@earendil-works/pi-coding-agent/package.json', JSON.stringify({version: '0.99.2'}));
  for (const name of ['git.exe', 'bash.exe', 'fd.exe', 'rg.exe']) file(`bin/${name}`);
  file('Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
  file('extensions/apex-context/private-spill.ps1');
  const env = {Path: path.join(root, 'bin'), SYSTEMROOT: path.join(root, 'Windows'), TEMP: root,
    OPENROUTER_API_KEY: 'DO_NOT_PRINT_SECRET', OPENAI_API_KEY: 'DO_NOT_PRINT_SECRET',
    PI_CODING_AGENT_DIR: 'DO_NOT_PRINT_SECRET', BASH_ENV: 'DO_NOT_PRINT_SECRET',
    DOCKER_HOST: 'tcp://DO_NOT_PRINT_SECRET', HTTPS_PROXY: 'DO_NOT_PRINT_SECRET'};
  return {root, file, env};
}

export function nativeProbe(command, args) {
  const name = path.basename(command).toLowerCase();
  const stdout = { 'git.exe': 'git version 2.50.0.windows.1', 'bash.exe': 'apex-native-bash',
    'fd.exe': 'fd 10.3.0', 'rg.exe': 'ripgrep 14.1.1', 'powershell.exe': 'apex-windows-net-ready' }[name];
  assert.ok(stdout, `Unexpected dependency probe: ${name} ${args.join(' ')}`);
  return {status: 0, stdout};
}
