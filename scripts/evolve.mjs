import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {pythonRuntime} from './python-runtime.mjs';

const runtime = pythonRuntime(process.cwd());
const args = process.argv.slice(2);
const micro = args[0] === '--micro';
if (micro && args.length !== 1) throw Error('--micro takes no other arguments.');
const env = {PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf8', PI_OFFLINE: '1'};
for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) if (process.env[key] !== undefined) env[key] = process.env[key];
// Offline commands inherit no credentials. Only an explicitly authorized run may receive the selected key.
if (!micro && args[0] === 'run') {
  let policyFile = 'evals/config.json';
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--config') policyFile = args[++i];
    else if (args[i].startsWith('--config=')) policyFile = args[i].slice('--config='.length);
  }
  const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
  if (policy.paid_runs_enabled === true && policy.execution_policy === 'paid-enabled' && process.env.OPENROUTER_API_KEY !== undefined) env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
}
const result = spawnSync(runtime.command, [...runtime.prefix, '-B', '-m', micro ? 'evolve.micro' : 'evolve', ...(micro ? [] : args)],
  {shell: false, env, ...(micro ? {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000} : {stdio: 'inherit'})});
if (micro && typeof result.stdout === 'string') {
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) writeFileSync('validation/phase4-micro.json', result.stdout);
}
process.exit(result.status ?? 1);
