# Phase 1 context worker evidence

Implemented `planMasking(event,ctx,{keepTurns=4,thresholdTokens=4000})` in `extensions/apex-context/masking.mjs` and `createCompactionHandler({policy,complete})` in `extensions/apex-context/compaction.mjs`. Imports have no runtime/session side effects. No shared coordinator, Pi core, dependencies, credentials, model/provider services or benchmark task/verifier files were changed or accessed.

Masking plans persisted `context_edit` drafts from the active native projection, preserves earlier extension drafts, and never requests continuation. Age follows assistant entries rather than resettable `turnIndex`. It protects task/state messages, recent observations, latest useful successful reads, errors, nontext output, unexpected structured fields and results without a recovery log. Existing/pending edits are not repeated. Recovery paths remain exact JSON-escaped strings; native full logs take priority over shaped hook-visible logs. The threshold is an explicit UTF-8 bytes/4 estimate, not measured provider tokens or dollar savings.

Compaction cancels before registry/auth/completion access unless policy explicitly enables `paid-enabled`, the exact Muse model and `xhigh`. Injected fixture callbacks cannot bypass offline policy. Disabled-at-creation policy cannot be enabled by later mutation; revocation is rechecked before completion. The enabled path uses native model lookup and completion facade with `reasoningEffort:'xhigh'`, the supplied abort signal, bounded native retention/reserve values and no cache retention. It reads the existing `prompts/compaction.md`, handles previous and split-prefix summaries, retains exact native cutoff/token bookkeeping, copies stable JSON contract/todo values after the summary, unions previous hook file lists, and includes returned summary usage. Malformed state/output/usage, errors, aborts and branch changes cancel instead of permitting default paid fallback.

Tests were written first: the initial 15 behavior tests failed as expected against missing modules, then passed. Additional targeted regression tests first exposed failed-reread masking, altered recovery paths, pending-summary branch changes, malformed file bookkeeping and policy-revocation access, then passed after fixes.

Fresh final verification:

- `node --check extensions/apex-context/masking.mjs`: exit 0.
- `node --check extensions/apex-context/compaction.mjs`: exit 0.
- `node --test tests/context-masking.test.mjs tests/context-compaction.test.mjs`: 22 passed, 0 failed, 0 skipped; exit 0.
- Owned-file trailing-whitespace check: passed.

Native SessionManager fixtures prove append-only original-history retention, disk reopening of mask edits, active-branch isolation and compaction-aware projection without constructing AgentSession or authenticating. Summary responses are deterministic test adapters only. Real provider requests and incremental provider spend were zero. Semantic summary quality, provider cache hits, dollars per solved task and benchmark pass-rate effects remain unmeasured.

The attempted `git diff --check` was unavailable through this worker's tool surface: Git resolved to no-index mode and exited 129 before the subsequent chained checks. Syntax/tests were rerun independently and passed; root owns VCS and whole-suite integration checks. Files are frozen for root integration.

## Scoped nested-parent review fix

Native parent observations can contain nested failures or the latest file read even when the parent succeeds. Masking now conservatively preserves every parent with nestedCalls or details.calls. Five regressions went RED→GREEN; the final combined context suite passed 27 tests. Independent source review confirmed this fix; full root suite later passed 272 tests.
