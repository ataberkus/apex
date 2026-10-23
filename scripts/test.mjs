import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pythonRuntime } from './python-runtime.mjs';

const root = process.cwd();
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => arg !== '--windows')) throw new Error('Usage: bun scripts/test.mjs [--windows]');
if (!process.versions.bun) throw new Error('Run the tests with Bun: bun scripts/test.mjs');
const windows = args[0] === '--windows';
if (windows && process.platform !== 'win32') throw new Error('Windows tests require native Windows Bun.');
if (windows) console.log('Windows-native Bun tests; Python/Harbor analysis tests remain in the separate full test command. Capability skips are retained.');
const files = readdirSync('tests').filter(name => name.endsWith('.test.mjs')).map(name => `./tests/${name}`);
// Two isolated worker processes bound offline unit-file concurrency; native SDK fixture watchdogs keep their own
// per-test deadlines, so Bun's 5 s default per-test timeout is lifted. live-builtins lets fixtures patch builtins
// the way Node's syncBuiltinESMExports() did. This never changes Harbor task resources/timeouts.
const bun = spawnSync(process.execPath, ['test', '--parallel=2', '--timeout=600000', '--preload', './scripts/live-builtins.mjs', ...files], {stdio: 'inherit', shell: false});
if (bun.status !== 0) process.exit(bun.status ?? 1);
if (!windows) {
  const python = pythonRuntime(root);
  const result = spawnSync(python.command, [...python.prefix, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'], {stdio: 'inherit', shell: false});
  process.exit(result.status ?? 1);
}
