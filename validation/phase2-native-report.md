# Phase 2 native offline gate

The gate in `scripts/micro-phase2.mjs` passes against the installed, pinned Pi 0.99.2 without provider requests, credential reads, authentication checks, inference attempts, or external network attempts. It exports inert `runPhase2Micro(options = {})` and follows the existing JSON CLI gate pattern.

## Verification

`node --test tests/phase2-micro.test.mjs`: **6 passed, 0 failed**, 16,757.49 ms on the final focused run. `node --check scripts/micro-phase2.mjs`: exit 0.

The initial test-first run failed all five original tests with “offline Phase 2 gate is missing.” Additional test-first assertions failed because nested native ordering was unreported, because lost-background-report mode did not exist, and because the initial repeat fixture emitted only one loop note. Each was implemented and rerun green. Whole-project checks and integrated micro execution remain root-owned.

## Actual native boundaries and tools

| Evidence | Observed behavior |
| --- | --- |
| Session construction | Real `ModelRuntime`, in-memory `SettingsManager`, `DefaultResourceLoader`, `SessionManager`, `createAgentSession`, and native extension binding. The package version is read and checked as 0.99.2. |
| Default and selected flags | Native registration retains the empty core flag default. A separate empty-flags native session has no contract, todo, bg, explore, or verify tool and creates no Apex state. The selected session registers all five native tools. |
| Model and settings | Physical `openrouter/meta/muse-spark-1.3-contributor`, `xhigh`; cache warming, automatic compaction, and retry disabled. |
| Contract and todo | Actual contract set/list and todo list/done/drop calls. A drop without a reason fails; the reason-bearing drop returns the expected item delta. |
| Extraction and auxiliary denials | Native `before_agent_start` persists attempted/blocked automatic extraction. Actual explore/verify definitions return policy denials. Offline max orchestration rejects before the supplied isolation/attempt callbacks run. All auth, credential, inference, and network counters remain zero. |
| Initial context and profile | Actual `before_agent_start` messages are committed through `SessionManager`; native prompt/loadout preparation preserves the supplied context sentinel and Pi tools/rules alongside Apex sections. |
| Settlement gate | The pinned native `AgentSession._runBeforeSettleBoundary()` commits real drafts and rechecks the resulting context. Ordinary final-assistant context initially has `canContinue=false`; the gate’s own nonempty custom message makes its next context runnable. Two continuations occur, the third is capped. No continuation request runs. |
| Verification ordering | A real failed `node --check` does not count. Actual write invalidates verification; settlement asks to continue. A later successful real `node --check` permits settlement. Artifact format/path/content checks run on the owned module. |
| Nested ordering | Actual Phase 1 codemode/installed QuickJS executes nested write followed by bash verification, with two successful recorded native calls. The parent’s machine-readable exit result remains intact, and the real gate accepts the later check. |
| Todo steering | Five native `Agent.finishTurn()` boundaries on an explicit three-step task create exactly one missing-todo steering message. |
| Loop cap | Three distinct repeated-read sequences execute actual native read definitions. Only two loop messages are committed. |
| Time thresholds | Native turn boundaries append exactly the 50%, 75%, and 90% messages; repeated later boundaries do not duplicate them. |
| Branch restoration | The persisted native session file is reopened into another real session. Todo resolution and manual criteria restore from the active branch. |
| Phase 1 composition | Real Phase 1 masking and Phase 2 append drafts coexist. The native projection contains the masking replacement while the original observation remains persisted. |
| Background lifetime and ownership | An actual bg tool starts the owned local heartbeat service in a separate native-session child. That child disposes its session and exits; the heartbeat continues advancing. Another native-session child reloads the manager, polls/tails the service, and sends an authenticated owned kill. Exited metadata and a stopped heartbeat confirm cleanup. No persisted PID is signaled by the gate. |

## Offline isolation and faults

Only a small environment whitelist enters each child. `PI_OFFLINE=1` and an owned fixture agent directory are required. Transport guards cover fetch/WebSocket, HTTP(S), TCP/TLS, DNS, and datagrams. Auth, credential, and inference methods have separate denial counters.

Pi’s `no*` resource flags run after package resolution, so the real loader’s package-manager `resolve` and `resolveExtensionSources` seams are isolated as well. Filesystem guards count and deny sensitive ambient discovery before reading outside the owned fixture. The pinned registry’s scheduled local availability refresh is suppressed solely at its explicit `allowNetwork:false` boundary, avoiding account availability queries.

Faults are observable failures:

- Removing the actual settlement hook produces zero forced continuations and fails the gate with no external attempts.
- Restoring ambient package discovery fails before an outside resource read; the resource-discovery counter is positive and provider/network counters stay zero.
- Losing the background startup report after the real service starts fails the gate. Cleanup recovers exactly one opaque ID from its own fixture metadata and uses the authentic native bg tool to validate ownership and terminate it. The service and fixture are removed.
- An unknown fault mode rejects before allocating a fixture.

Each native child has a 25-second timeout and a 128-KiB combined-output cap. The service writes only owned local files. Cleanup searches only the gate’s newly allocated fixture and retains its ownership evidence if native termination cannot be confirmed.

## Synthetic inputs and unmeasured outcomes

All user/assistant messages and tool arguments are script-seeded. No model generated the plan, contract, calls, or final response. Time uses an injected deterministic monotonic clock. The context sentinel is supplied through the native `agentsFilesOverride` seam; it is not ambient discovery. Phase 1 masking uses an explicitly synthetic text-only observation. Max callbacks are deterministic denial sentinels and are never invoked.

The runtime objects, registered tools, tool hooks, native nested executor, session projection/persistence, turn/settlement boundaries, files, detached background processes, and cleanup are real. Native continuation booleans do not measure a model response. Format and content checks do not claim semantic task compliance. Model success rate, provider retries/billing, benchmark runs, inference-backed extraction/subagents/max attempts, token savings, and performance deltas remain unmeasured.
