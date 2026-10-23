import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [version, sourceCommit] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !/^[0-9a-f]{40}$/.test(sourceCommit ?? '')) {
  console.error('Usage: bun scripts/upgrade-pi.mjs VERSION FULL_SOURCE_COMMIT\nInspect the new source before upgrading. Checks must pass before any paid eval.');
  process.exit(2);
}
const oldPins = JSON.parse(readFileSync('evals/versions.json', 'utf8'));
if (version === oldPins.pi.version) throw new Error('New version must differ from the current pin');
if (!process.versions.bun) throw new Error('Run the upgrade with Bun: bun scripts/upgrade-pi.mjs');
function run(args) {
  // Bun itself is the package manager and script runner; argv holds validated versions and fixed script names only.
  const result = spawnSync(process.execPath, args, {stdio: 'inherit', shell: false});
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// Re-pins package.json and bun.lock (the only dependency lock) to the exact new Pi and its integrity.
run(['add', '--dev', '--exact', '--ignore-scripts', `@earendil-works/pi-coding-agent@${version}`]);
const pins = {...oldPins, pi: {...oldPins.pi, version, source_commit: sourceCommit}};
writeFileSync('evals/versions.json', JSON.stringify(pins, null, 2) + '\n');
// Keep explicit runtime pins in sync (JS runtime code imports PI_VERSION from lib/launcher.mjs);
// schema/API regression tests deliberately remain unchanged and must be re-pinned by review.
for (const file of ['lib/launcher.mjs', 'scripts/micro-session.mjs', 'scripts/preflight.mjs', 'evals/harbor/apex.py', 'evals/harbor/plan.py']) {
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll(oldPins.pi.version, version).replaceAll(oldPins.pi.source_commit, sourceCommit));
}
for (const script of ['check', 'test', 'micro']) run(['run', script]);
console.log('Unpaid upgrade checks passed. Re-audit NOTES.md and run budget-approved model micro-evals before adopting the upgrade.');
