# Phase 2 state and models independent review

Reviewed `PHASE2_DESIGN.md`, `PHASE2_PLAN.md` tasks 2 and 5, the binding Phase 2 requirements in `APEX_BUILD.md`, `extensions/apex-core/state.mjs`, `models.mjs`, their tests/reports, and the relevant `index.mjs`, launcher, Phase 1 compaction and metrics consumers. This review made no source edits, provider/auth/account/network requests, real SDK/session calls, global test runs, or micro-eval runs. Execution was limited to deterministic own-module fixtures before and after the fixes under `env -i` with an explicitly whitelisted Node/PATH. All model, SDK and provider adapters in those fixtures were synthetic stubs.

Final scoped result: **no remaining material findings in the reviewed state/models implementation or the reviewed shared accounting seam**. Both initially confirmed P2 findings were fixed by their assigned workers and independently rechecked below. Whole-project/native verification remains root-owned; this scoped source verdict does not substitute for those gates. The root reports 432 whole-project tests passed with one optional TypeScript skip and 55 metrics tests passed; those commands were not rerun by this reviewer.

## Resolved findings

### Resolved P2 — Contract extraction lost incurred usage on cancellation, stale responses and thrown completion errors

**Original location:** `extensions/apex-core/state.mjs:292-303`. **Final fix:** `extensions/apex-core/state.mjs:279-330`.

The completed request's usage was copied only after the abort check and the task/branch/policy freshness check. A request that already consumed tokens and then returned after cancellation or a branch/policy change therefore reported no usage. The catch also ignored a completion error's valid `error.usage`. This violated Task 2's usage bookkeeping even though stale acceptance criteria were correctly refused.

A deterministic injected completion returned the same valid 26-token usage in three failure cases:

| Case | Returned status | Retained extraction usage |
| --- | --- | --- |
| Abort after completion produced its response | `aborted` | `null` |
| Completion rejects with valid `error.usage` | `failed` | `null` |
| Active branch changes before response handling | `stale` | `null` |

**Implemented fix and recheck:** response/error usage is captured before abort/freshness handling and associated with the originating task/request. Dedicated `apex-helper-usage` evidence is emitted once per actual completion invocation in `finally`, after freshness/publication checks, avoiding self-induced branch invalidation. A reported terminal stop with valid usage can establish complete accounting; thrown partial/missing usage cannot. Offline and pre-request failures produce no fabricated auxiliary record. Independent recheck confirmed all three cases return the 26-token originating usage and exactly one record. A fourth case reset the task during completion: the old usage was returned/recorded while the new task retained null usage and no foreign criteria. The worker reports 36/36 focused tests and syntax exit 0; source and added regressions were reread.

### Resolved P2 — Native subagent policy was checked once per prompt, rather than before every model request

**Original location:** `extensions/apex-core/models.mjs:138-143,151-157`; pinned SDK consumer `node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:250-260`. **Final fix:** `extensions/apex-core/models.mjs:155-161,190-212`.

`nativeSession` passed the raw `modelRuntime` into `createAgentSession` and checked policy before calling `session.prompt`. The SDK's agent loop calls `modelRuntime.streamSimple` for each subsequent turn. There was no policy guard at that per-request seam, so authorization withdrawal while an auxiliary session was running could leave subsequent requests permitted.

A fully stubbed SDK fixture produced a first synthetic `toolUse` turn, changed the supplied policy to offline-only, then made a second synthetic stream call. The observed call policies were `["paid-enabled", "offline-only"]`, and the tool returned `status:"complete"` with four synthetic tokens. No native SDK or provider path was executed. The pinned SDK source confirms that the second call represents the real multi-turn request seam.

**Implemented fix and recheck:** a guarded runtime proxy checks live policy, cancellation, physical Muse and xhigh at each request seam, including lazy preparation/auth calls and after asynchronous preparation. The entry gate remains. The pinned runtime uses ordinary instance properties, allowing the proxy receiver to guard its inner method calls; this source dependency is documented. Independent recheck of a fully synthetic two-turn session observed exactly one permitted stream and one synthetic auth callback. Revocation blocked the second request before either callback, with `status:"blocked"`, retained six-token usage and explicit incomplete accounting. Worker regressions additionally cover revocation during asynchronous auth preparation with zero provider dispatches and model/effort/signal violations. The worker reports 37/37 focused tests and syntax exit 0; source and added regressions were reread.

## Accounting integration recheck

- Subagents now expose native top-level `usage` for attempted work and `details.apexAux` attribution/completeness; pinned `_afterToolCall` carries these fields into native tool-result events. Offline/pre-callback denials omit top-level usage. Attempted missing/zero/partial usage is explicitly incomplete, retaining observed lower bounds.
- Valid `reasoning` and `cacheWrite1h` subsets are preserved without adding them to output/cache-write totals again. Aggregates omit an optional subset if any source lacks it, preserving the distinction between unknown and zero.
- Metrics recognize the dedicated per-request contract entry rather than billing repeated workflow snapshots. The final shared source also recognizes direct-helper `details.apexAux` physical attribution, keeps partial/missing accounting incomplete, and leaves blocked-before-work tools without a fabricated auxiliary observation. The `nonlocal missing_auxiliary` declaration ensures tool-level incomplete evidence actually reaches the run-level cost decision. Source and focused metrics regressions were reread; no new defect was found. Nested aggregate tool usage without physical attribution remains conservatively unpriced, as declared by the root coordinator.
- Max results, candidate attempt records and exceptions now carry enumerable `usageComplete` booleans. The source tracks pending adapter invocations, preserving known prior usage while marking thrown/missing/zero accounting incomplete. JSON regression cases cover complete callbacks, missing attempt/verifier data, unknown thrown helpers, all-failed known candidates and cleanup failures. This resolves the earlier serialization consideration; unknown completeness cannot disappear with private aggregation metadata.

## Other reviewed behavior

- The current frozen offline runtime denies extraction, subagents and max before the prohibited side effects; the findings concern future explicitly authorized paths, not a current offline bypass.
- Todo updates are serialized, drops require reasons, snapshots detach values, task identities isolate restored state, and the Phase 1-compatible todo envelope carries bounded counters through compaction.
- Mutation start/completion ordering, sibling overlap, nested-call deduplication and unobserved nested summaries conservatively invalidate stale verification. Numeric native exit-code evidence is required; checker narration cannot establish success.
- Gate continuations are bounded at two, todo steering at one. A completed final-assistant preview with `canContinue:false` is valid here: each continuation adds its own nonempty custom message, and native Pi checks the final projected context. That preview alone is not a defect.
- Max attempts check policy before adapter invocations, default copies include uncommitted state without shared file writes, selection prefers passing verification, tie judging is guarded, and cleanup preserves primary errors and accumulated usage.
- Auxiliary contexts use fresh histories and restricted read/search tools; the native resource loader suppresses automatic ambient inheritance. Recovery uses the explicit native settings seam and does not pretend ordinary extension context has a setter.
- The updated native cleanup block attempts unsubscribe, abort and disposal independently and retains usage on cleanup errors. No additional material finding was identified in these areas.

## Verdicts

**Specification compliance:** clear for the reviewed state/models scope and shared accounting seam after the resolved fixes. The offline implementation, state/gate contracts and documented unmeasured limits match the reviewed design. Full native verification remains root-owned evidence; future provider behavior and unattributed nested aggregate pricing remain unmeasured.

**Quality:** clear for the reviewed state/models scope after the resolved fixes. Focused regressions now cover incurred extraction usage on failure/task changes, authorization revocation inside multi-turn native sessions, and native usage propagation. No benchmark claim is made or inferred.
