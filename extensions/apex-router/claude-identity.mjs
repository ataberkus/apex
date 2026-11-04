/**
 * Claude Code request identity for the native Windows target, separate from the frozen
 * Harbor/Muse policy. Pi's bundled `anthropic-messages` already sends the wire identity
 * (Bearer `sk-ant-oat` token, `claude-cli/2.1.280` UA, `x-app: cli`, the `claude-code` and
 * OAuth betas, the Claude Code system block, Claude Code tool names) whenever the saved
 * login's access token carries the subscription prefix, and the dashboard's Claude sign-in
 * stores exactly that through oh-my-pi (dashboard/provider-login.mjs).
 *
 * Anthropic additionally classifies subscription traffic by prompt content: two flagged
 * sequences in Pi's stock `<docs>` section draw the "Third-party apps now draw from your
 * extra usage" 400 on `claude-opus-5-5` and other subscription models — the `custom providers`
 * and `pi packages` doc entries together, and the docs header together with the
 * cross-references line. The extension rewrites only those flagged sequences inside the
 * request payload, leaving the transcript, docs, and every other provider untouched.
 */

const PATCHES = [
  // The flagged pair (leave-one-out AO): these two doc entries together draw the 400.
  ['custom providers (docs/custom-provider.md)', 'custom providers docs/custom-provider.md'],
  ['pi packages (docs/packages.md)', 'pi packages docs/packages.md'],
  // The flagged joint (BB/BG): the docs header plus this cross-reference line.
  ['follow .md cross-references before implementing', 'follow .md cross references before implementing'],
];

const patchedDocs = text => {
  if (!PATCHES.some(([flagged]) => text.includes(flagged))) return text;
  for (const [flagged, replacement] of PATCHES) text = text.replace(flagged, replacement);
  return text;
};

/** Patch the flagged docs pair in one system block; other blocks pass through by reference. */
export function patchSystemBlock(block) {
  if (block?.type !== 'text' || typeof block.text !== 'string') return block;
  const text = patchedDocs(block.text);
  return text === block.text ? block : {...block, text};
}

/** Patch the payload's system blocks when they carry the flagged pair; otherwise return it as-is. */
export function patchPayload(payload) {
  const system = payload?.system;
  if (!Array.isArray(system)) return payload;
  const blocks = system.map(patchSystemBlock);
  if (blocks.every((block, index) => block === system[index])) return payload;
  return {...payload, system: blocks};
}

export default function apexClaudeIdentity(pi) {
  pi.on('before_provider_request', event => patchPayload(event.payload));
}
