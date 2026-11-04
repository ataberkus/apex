import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pythonRuntime } from './python-runtime.mjs';

const root = process.cwd();
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => arg !== '--windows')) throw new Error('Usage: bun scripts/test.mjs [--windows]');
if (!process.versions.bun) throw new Error('Run the tests with Bun: bun scripts/test.mjs');
const windows = args[0] === '--windows';
if (windows && process.platform !== 'win32') throw new Error('Windows tests require native Windows Bun.');
const requested = process.env.APEX_TEST_PARALLEL || undefined;
if (requested !== undefined && !/^(?:[1-9]|1[0-6])$/.test(requested)) throw new Error('APEX_TEST_PARALLEL must be an integer from 1 to 16');
// Isolated worker processes bound offline unit-file concurrency. Two dates from a Node-era session watchdog fault under nine
// parallel files; up to four keeps every fixture watchdog's margin on Linux. Native Windows stays at two: on a two-vCPU
// Windows runner with Defender on (2026-11-02), four workers timed out session-micro fixture children in two of three
// runs (APEX_TEST_PARALLEL overrides either default).
const parallel = requested ? Number(requested) : process.platform === 'win32' ? 2 : Math.min(4, Math.max(2, os.availableParallelism()));
if (windows) console.log('Windows-native Bun tests; Python/Harbor analysis tests remain in the separate full test command. Capability skips are retained.');
const files = readdirSync('tests').filter(name => name.endsWith('.test.mjs')).map(name => `./tests/${name}`);

// Bun's --timings starts the slowest files first. The file is machine-local, rewritten by every run and ignored by Git;
// an invalid or unreadable one is dropped, so it can only cost ordering, never the run.
function timingArgs() {
  const file = path.join(root, '.cache', `test-timings-${process.platform}.json`);
  try {
    mkdirSync(path.dirname(file), {recursive: true});
    if (existsSync(file)) {
      let valid = false;
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        valid = data?.version === 1 && data.files !== null && typeof data.files === 'object' && !Array.isArray(data.files);
      } catch {}
      if (!valid) rmSync(file);
    }
    return [`--timings=${file}`, '--update-timings'];
  } catch { return []; }
}

// The Linux Python phase runs beside the Bun suite on otherwise idle cores. Its output goes to files (not pipes, which the
// blocking Bun spawn could leave full) and is replayed after Bun's, exactly as the sequential runner printed it.
let python, pythonError, pythonDone, logDir, outFd, errFd;
if (!windows) {
  try { python = pythonRuntime(root); } catch (error) { pythonError = error; }
  if (python) {
    logDir = mkdtempSync(path.join(os.tmpdir(), 'apex-python-tests-'));
    outFd = openSync(path.join(logDir, 'stdout'), 'w');
    errFd = openSync(path.join(logDir, 'stderr'), 'w');
    const child = spawn(python.command, [...python.prefix, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'], {stdio: ['ignore', outFd, errFd], shell: false});
    pythonDone = new Promise(resolve => { child.once('error', () => resolve({status: null})); child.once('close', status => resolve({status})); });
  }
}
const cleanup = () => {
  for (const fd of [outFd, errFd]) if (fd !== undefined) closeSync(fd);
  outFd = errFd = undefined;
  if (logDir) rmSync(logDir, {recursive: true, force: true});
};

// Native SDK fixture watchdogs keep their own per-test deadlines, so Bun's 5 s default per-test timeout is lifted.
// live-builtins lets fixtures patch builtins the way Node's syncBuiltinESMExports() did. This never changes Harbor task resources/timeouts.
const bun = spawnSync(process.execPath, ['test', `--parallel=${parallel}`, '--timeout=600000', '--preload', './scripts/live-builtins.mjs', ...timingArgs(), ...files], {stdio: 'inherit', shell: false});
if (bun.status !== 0) {
  // Let Python finish its temporary-directory cleanup, then report only Bun's failure, as before.
  if (pythonDone) await pythonDone;
  cleanup();
  process.exit(bun.status ?? 1);
}
if (!windows) {
  if (pythonError) { cleanup(); throw pythonError; }
  const result = await pythonDone;
  closeSync(outFd); closeSync(errFd); outFd = errFd = undefined;
  const out = readFileSync(path.join(logDir, 'stdout')), err = readFileSync(path.join(logDir, 'stderr'));
  cleanup();
  await new Promise(resolve => process.stdout.write(out, resolve));
  await new Promise(resolve => process.stderr.write(err, resolve));
  process.exit(result.status ?? 1);
}
