import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [version, sourceCommit] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !/^[0-9a-f]{40}$/.test(sourceCommit ?? '')) {
  console.error('Usage: node scripts/upgrade-pi.mjs VERSION FULL_SOURCE_COMMIT\nInspect the new source before upgrading. Checks must pass before any paid eval.');
  process.exit(2);
}
const oldPins = JSON.parse(readFileSync('evals/versions.json', 'utf8'));
if (version === oldPins.pi.version) throw new Error('New version must differ from the current pin');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(args) {
  // npm.cmd is launched via cmd on Windows; argv here contains validated versions and fixed script names only.
  const result = spawnSync(npm, args, {stdio: 'inherit', shell: process.platform === 'win32'});
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['install', '--save-dev', '--save-exact', '--ignore-scripts', `@earendil-works/pi-coding-agent@${version}`]);
const pins = {...oldPins, pi: {...oldPins.pi, version, source_commit: sourceCommit}};
writeFileSync('evals/versions.json', JSON.stringify(pins, null, 2) + '\n');
// Keep explicit runtime pins in sync; schema/API regression tests deliberately remain unchanged.
for (const file of ['lib/launcher.mjs', 'evals/harbor/apex.py', 'evals/harbor/plan.py']) {
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll(oldPins.pi.version, version));
}
for (const script of ['check', 'test', 'micro']) run(['run', script]);
console.log('Unpaid upgrade checks passed. Re-audit NOTES.md and run budget-approved model micro-evals before adopting the upgrade.');
