import { spawnSync } from 'node:child_process';
import { pythonRuntime } from './python-runtime.mjs';
const python = pythonRuntime(process.cwd());
const result = spawnSync(python.command, [...python.prefix, '-m', 'evals.micro.run'], {stdio: 'inherit', shell: false});
process.exit(result.status ?? 1);
