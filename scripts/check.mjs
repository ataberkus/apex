import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PI_VERSION, resolvePi } from '../lib/launcher.mjs';
import { pythonRuntime } from './python-runtime.mjs';
import { CONTEXT_FEATURES } from '../extensions/apex-context/config.mjs';
import {FEATURE_FEATURES} from '../extensions/apex-features/config.mjs';
import {CORE_FEATURES} from '../extensions/apex-core/config.mjs';

const root = process.cwd();
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => arg !== '--windows')) throw new Error('Usage: bun scripts/check.mjs [--windows]');
if (!process.versions.bun) throw new Error('Run the checks with Bun: bun scripts/check.mjs');
const windows = args[0] === '--windows';
if (windows && process.platform !== 'win32') throw new Error('Windows checks require native Windows Bun.');
function sourceFiles(directory) {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : [file];
  });
}
// Bun has no `--check`: parsing each file with Bun's transpiler reports the same syntax errors without running it.
const transpiler = new Bun.Transpiler({loader: 'js'});
let syntaxErrors = 0;
for (const file of ['bin/apex', 'dashboard/app.js', ...['lib', 'scripts', 'tests', 'evals', 'evolve', 'extensions', 'skills', 'dashboard', 'desktop'].flatMap(sourceFiles).filter(file => file.endsWith('.mjs'))]) {
  try { transpiler.transformSync(readFileSync(file, 'utf8')); }
  catch (error) {
    syntaxErrors++;
    for (const item of error.errors ?? [error]) console.error(`${file}:${item.position?.line ?? 0}:${item.position?.column ?? 0}: SyntaxError: ${item.message}`);
  }
}
if (syntaxErrors) process.exit(1);
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
if (manifest.devDependencies['@earendil-works/pi-coding-agent'] !== PI_VERSION) throw new Error('Pi launcher and package pin disagree');
// bun.lock is JSONC (trailing commas), so it is parsed here rather than with the other JSON in check_python.py.
const lockedPi = Bun.JSONC.parse(readFileSync('bun.lock', 'utf8')).packages?.['@earendil-works/pi-coding-agent']?.[0];
if (lockedPi !== `@earendil-works/pi-coding-agent@${PI_VERSION}`) throw new Error('Pi launcher and bun.lock pin disagree');
resolvePi();
const ablations=JSON.parse(readFileSync('evals/phase1-ablations.json','utf8'));
if (JSON.stringify(ablations.features.map(row=>row.flag))!==JSON.stringify(CONTEXT_FEATURES) ||
    ablations.features.some(row=>row.default_enabled!==false||row.promotion_status!=='pending-model-evals') ||
    JSON.stringify(manifest.pi.extensions)!==JSON.stringify(['./extensions/apex-context/index.mjs','./extensions/apex-core/index.mjs','./extensions/apex-features/index.mjs'])) {
  throw new Error('Phase 1 flags, ablation registry and package resources disagree');
}
const coreAblations=JSON.parse(readFileSync('evals/phase2-ablations.json','utf8'));
if(JSON.stringify(coreAblations.features.map(row=>row.flag))!==JSON.stringify(CORE_FEATURES)||
  coreAblations.features.some(row=>row.default_enabled!==false||row.promotion_status!=='pending-model-evals'))throw new Error('Phase 2 flags and ablation registry disagree');
const featureAblations=JSON.parse(readFileSync('evals/phase3-ablations.json','utf8'));
if(JSON.stringify(featureAblations.features.map(row=>row.flag))!==JSON.stringify(FEATURE_FEATURES)||featureAblations.features.some(row=>row.default_enabled!==false||row.promotion_status!=='pending-model-evals'))throw Error('Phase 3 flags and ablation registry disagree');
if(manifest.pi.skills.length||manifest.pi.prompts.length||manifest.pi.themes.length)throw Error('Resources must be explicitly opted in');
if (windows) {
  for (const file of ['evals', 'evolve', 'research'].flatMap(sourceFiles).filter(file => file.endsWith('.json'))) {
    JSON.parse(readFileSync(file, 'utf8'));
  }
  const {runWindowsPreflight} = await import('./preflight-windows.mjs');
  const report = runWindowsPreflight({projectRoot: root});
  if (report.readiness !== 'tooling-ready') {console.log(JSON.stringify(report)); process.exit(2);}
  console.log('Native Windows syntax, JSON, package resources and Pi checks passed. Python/Harbor/container acceptance is separate.');
} else {
  const python = pythonRuntime(root);
  const result = spawnSync(python.command, [...python.prefix, '-m', 'scripts.check_python'], {stdio: 'inherit', shell: false});
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log('Syntax, JSON, source pins, price registry, and installed Pi checks passed.');
}
