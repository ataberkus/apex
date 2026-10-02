# Phase 2 implementation plan

> For agentic workers: use test-first execution with disjoint workers and final independent review. The user's autonomous agreement authorizes execution without additional design approval.

Goal: deliver and verify the complete opt-in local Phase 2 harness without paid or provider operations.

Architecture: small modules coordinated by native Pi hooks; all defaults off, model-backed calls gated before any external side effect. Shared launcher, package, adapters, gate integration and evidence are root-owned.

Tech stack: Node ESM, existing pinned Pi 0.99.2, Python 3/Harbor; no new dependencies.

Spec: PHASE2_DESIGN.md and APEX_BUILD.md §4.

## Global constraints

- Free-only, no new provider requests or spending; final fixtures deny credential/auth/external transport before use. Record development isolation exceptions rather than hide them. No Pi core changes or engine/cloud/system installations.
- Physical MAIN=FAST `openrouter/meta/muse-spark-1.3-contributor`; thinking `xhigh`.
- Every experiment off by default; empirical effects/CI/cost deltas unknown.
- No task/verifier/dataset detection or cross-task memory.
- Root owns shared files, commits and final verification; workers own only their assigned modules/tests/report.

## Review focus

- Parallel/nested mutation and verification ordering must invalidate stale success.
- Reload/fork/new-task state must not inherit another task's counters or criteria.
- Untrusted path/format, symlink and conflicting argument aliases must fail without damaging files.
- Denied auxiliary inference must occur before auth, SDK allocation and process/isolation creation.
- Background ownership, permissions and output inheritance must prevent hangs and accidental kills.

## Task 1: environment and entry points

Create `extensions/apex-core/environment.mjs`, `tests/core-environment.test.mjs`, `validation/phase2-environment-report.md`.

Produces `captureEnvironment({cwd,task='',entrypoints=false,networkAllowed=false,maxBytes=2400,runCommand?}) -> Promise<{text,details}>`, `rankEntryPoints({cwd,task,limit=10,runCommand?}) -> Promise<Array<{path,reason,score}>>`. No product side effects on import.

- [x] Write/run failing tests for snapshot bounds, manifest probing without script execution, ignored trees, entry ranking, missing tools, output/timeout bounds, no external probe by default.
- [x] Implement and run the focused offline tests; report exact results and limits.

## Task 2: contracts, todos and verification state

Create `extensions/apex-core/state.mjs`, `tests/core-state.test.mjs`, `validation/phase2-state-report.md`.

Produces `createTaskState({cwd,branch=[],persist=()=>{},policy,complete?})`. Object methods: `begin(task)`, `snapshot()`, `extractContract(task,ctx,{signal}={})`, `contractTool()`, `todoTool()`, `observeTool(event)`, `onTurn(event)`, `beforeSettle(event)`. Boundary methods return drafts via `{entries,continue?}`; preserve/combine `event.entries`. Tools use native definitions. State restoration and task identity are explicit. Automatic extraction denied offline; manual contract available. Gate cap two, todo steer cap one.

- [x] Write/run failing tests for manual/guarded extraction, exact verbatim state, todo transitions/drop reasons/deltas, mutations vs later successful verification, artifacts, sibling/nested ordering, branch restoration/new-task reset, continuation caps and canceled boundaries.
- [x] Implement with serialized updates and usage bookkeeping; run focused tests and report limits.

## Task 3: process management

Create `extensions/apex-core/process.mjs`, `tests/core-process.test.mjs`, `validation/phase2-process-report.md`.

Produces `createBackgroundTool({cwd,env?,platform?,spawn?}) -> native ToolDefinition`, `applyBashTimeout(event,{defaultSeconds=60,maxSeconds?}) -> block result or undefined`. Tool name `bg`; actions start/poll/tail/kill; signals and caps honored; no factory processes. Parent exits without killing required services.

- [x] Write/run failing real child-process tests for survival after parent exit, bounded logs, owned kill, forged/symlink IDs, restrictive permissions, malformed/timeouts/abort and no inherited stdout.
- [x] Implement with owned metadata and detached process group; clean only owned fixtures, run tests and report exact survival evidence.

## Task 4: correction, loops, time and diagnostics

Create `extensions/apex-core/control.mjs`, `tests/core-control.test.mjs`, `validation/phase2-control-report.md`.

Produces `correctToolCall(event,ctx,{headless=true,confirm?}={})`, `createLoopBreaker({maxNotes=2})` with `observe(event)`/`reset()`, `createTimeTracker({seconds,now=()=>performance.now()})` with `poll()`/`reset()`, `createDiagnostics({cwd,runCommand?})` with `before(event)`/`after(event)`/`reset()`. Exact native hook argument mutation; coherent result metadata. Diagnostics baseline before mutations, only new errors afterward; checker timeout/cap, no installs. Loop returns bounded note data, time returns threshold/remaining/total. Root renders supplied runtime prompts.

- [x] Write/run failing tests for aliases/conflicts/edit preconditions, parallel/nested corrections, catastrophic TUI confirmation, repeat failure/read/ping-pong caps, monotonic threshold emission, checker selection/baseline/new errors and missing checkers.
- [x] Implement, run focused tests and report execution limits.

## Task 5: model-backed subagents, max and recovery

Create `extensions/apex-core/models.mjs`, `tests/core-models.test.mjs`, `validation/phase2-models-report.md`.

Produces `createSubagentTools({policy,runSession?}) -> [explore,verify]`, `runMaxAttempts({policy,cwd,task,attempts=2,createIsolation,runAttempt,verifyAttempt,judge,signal})`, `recoverySettings({policy,maxRetries=2,baseDelayMs=1000})`. All check offline gate before catalog/auth/session/isolation allocation; injected deterministic test adapters are not runtime fake completions. Read-only restricted fresh context, depth one, exact Muse/xhigh, report nested usage. Native retry settings are bounded and same-model router fallback remains sticky. Max candidates isolated, selection by checks, judge only ties, total usage and cleanup protected.

- [x] Write/run failing tests for all pre-side-effect denials, fresh context/read-only/depth, model/effort checks, bounded output/usage, cancellation, isolation cleanup, verification ranking and judge ties, retry limits/offline disablement.
- [x] Implement actual SDK-backed future path where supported, run focused tests and report unmeasured semantics.

## Task 6: integration and adapters (root)

Create core config/index, ablation registry, Python core flag validation, native gate and integration tests. Modify launcher/package/check scripts/Harbor planning and adapter with backward-compatible defaults.

- [x] Write/run failing tests for flag parsing, unchanged default launch, exact Muse/xhigh, time/max prefix validation, runtime profile/mode/flags, boundary composition/state persistence, inactive factory behavior, adapter quoting and actual timeout propagation.
- [x] Integrate modules, static mode sections, nested event ordering, bounded notes and source-backed recovery configuration.
- [x] Add native offline Phase 2 micro gate and fault/denial checks; run check, full unit tests and integrated micro.

## Task 7: review, evidence and delivery (root)

- [x] Independently review the whole change; fix substantive findings and rerun affected checks.
- [x] Record local outcome, unmeasured success-rate target, top remaining observable risks, zero spend and next actual-eval steps in NOTES/DECISIONS/RESULTS/PROGRESS and PHASE2_LOCAL.
Delivery follows the verified source commit: pack and validate the package, bundle full history and source/raw evidence, scan credentials, hash archives and save downloadable artifacts. The final manifest/checksums are generated outside source history from that exact committed head.

## Pre-flight interface review

| Pair | Produced/consumed seam | Ruling |
| --- | --- | --- |
| Environment / coordinator | snapshot text/details | compatible; snapshot once per run |
| State / Phase 1 compact | apex-contract/apex-todo | retain exact customType names |
| State / control | native tool events | root passes corrected inputs, including nested results |
| Process / control | mutable bash input | timeout before other execution, conflicts block |
| Models / coordinator | policy and native definitions | runtimePolicy stays offline-only |
| Coordinator / launcher/Harbor | core flags/time/attempts | root owns all shared edits |
| All five module tasks | files vs tests | disjoint; no worker commits or shared writes |

All tasks agree with the design. No benchmark promotion is implied by local tests. Root records subsequent rulings here.

## Source and review rulings

- Native final-assistant settlement starts with canContinue=false. The gate must append its own nonempty custom message before Pi recomputes continuation; abort/error/pending cases remain blocked, with two forced continuations maximum.
- Extension settings are a cloned view. Recovery uses a launcher-created native agent settings profile; current free-only policy refuses before profile allocation/Pi launch.
- Harbor time notes receive only an explicitly supplied effective deadline. Decimal serialization does not change the evaluator timeout.
- Background control uses authenticated bounded nonce mailboxes, not signals sent to persisted PIDs. Complete ownership keys are atomically published.
- Time elapsed/threshold state is preserved through reload and Phase 1 compaction; a new user request resets it.
- Contract usage on abort/stale/error is retained per originating request; workflow snapshots are not rebilled. Auxiliary policy is checked at every model request, including asynchronous preparation.
- Installed diagnostics run under a credential-stripped environment with explicit offline package settings. They are not an OS execution sandbox.
- One early worker fixture reached a credential-availability lookup (no request/spend); another broad command was rejected by automatic review over registry access. Final global checks use an explicit environment whitelist and offline npm settings.
- The offline Phase 2 gate watchdog reserves all primary and bounded owned-cleanup child deadlines (330 seconds maximum adverse-path envelope). This changes only local validation, never a benchmark task timeout or resource limit.
- First root global unit run exposed eight fixture ENOENT/checker failures because the whitelist omitted the public absolute Node runtime path. A one-variable eight-test rerun passed; final full checks retain that path and continue excluding credentials.
- The previously selected dedicated apex-phase2 branch is preserved with local commits and a full-history bundle. The finishing workflow adds no merge/push handoff: the user authorized autonomous local closure, and no remote or main-branch integration is requested.
