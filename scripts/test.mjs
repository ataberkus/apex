import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pythonRuntime } from './python-runtime.mjs';

const root = process.cwd();
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => arg !== '--windows')) throw new Error('Usage: node scripts/test.mjs [--windows]');
const windows = args[0] === '--windows';
if (windows && process.platform !== 'win32') throw new Error('Windows tests require native Windows Node.');
if (windows) console.log('Windows-native Node tests; Python/Harbor analysis tests remain in the separate full npm test command. Capability skips are retained.');
const files = readdirSync('tests').filter(name => name.endsWith('.test.mjs')).map(name => `tests/${name}`);
// Bound offline unit-file concurrency: native SDK fixture watchdogs retain
// their existing deadlines. This never changes Harbor task resources/timeouts.
const node = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...files], {stdio: 'inherit', shell: false});
if (node.status !== 0) process.exit(node.status ?? 1);
if (!windows) {
  const python = pythonRuntime(root);
  const result = spawnSync(python.command, [...python.prefix, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'], {stdio: 'inherit', shell: false});
  process.exit(result.status ?? 1);
}
