/** Native daily-driver selection, separate from the frozen Harbor/Muse policy. */
export const WINDOWS_MODEL = 'openai-codex/gpt-6.1-sol';
export const WINDOWS_UNAVAILABLE = Object.freeze({
  context: Object.freeze(['route', 'output']), // These policies are Muse-specific.
  core: Object.freeze(['bg', 'max', 'recovery']),
});
export const WINDOWS_DEFERRED = Object.freeze([
  'Harbor/Terminal-Bench and two-model performance acceptance',
  'OCI proposer execution and container-backed evolution',
  'Unix owned-process survival and process-group cleanup',
]);

export function assertWindowsTarget({platform = process.platform, context = [], core = []} = {}) {
  if (platform !== 'win32') throw new Error('The Windows target requires native Windows Node, not WSL.');
  for (const [group, selected] of [['context', context], ['core', core]]) {
    const unavailable = selected.filter(name => WINDOWS_UNAVAILABLE[group].includes(name));
    if (unavailable.length) throw new Error(`Unavailable in the Windows target: ${group} ${unavailable.join(',')}. Select supported flags explicitly instead of all.`);
  }
}
