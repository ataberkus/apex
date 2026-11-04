# Phase 2 local implementation

The opt-in success-rate harness is implemented on pinned Pi 0.99.2, with no Pi core patches or new dependencies. All fourteen features remain off by default. **Phase 2 benchmark acceptance is pending:** same-model pass-rate improvement outside the confidence interval has not been measured.

Verification: npm run check PASS; npm test **432 passed** (302 Node + 130 Python), **one optional TypeScript skip**; npm run micro PASS, including **22 native Phase 2 checks**, all earlier Phase 0 gates and 16 native Phase 1 checks. Raw evidence is recorded in validation/phase2-local.json and the check/unit/micro logs. The native gate executes the real Pi SDK, hooks, registered tools, nested execution, persistence and settlement boundaries with script-seeded inputs. Deterministic stub completions test future model seams; they are not model behavior or benchmark results.

| Flag | Local implementation and evidence | Remaining limit |
| --- | --- | --- |
| snapshot | Bounded distro/shell/user/resources/tools/package managers/manifests/git/services observation, injected once | Best effort; 2,400 bytes approximate 600 tokens; external reachability explicitly skipped |
| entrypoints | Filename/identifier/symbol ranking with reasons, gitignore-aware normal source scans | Depth/file/time/chunk bounds can miss candidates; generic test/fixture conventions excluded |
| headless | Native named mode section and noninteractive environment, preserving context/tool guidance | Opt-in only; no whole-run prompt-effect measurement |
| contract | Manual criteria and confined structural artifact checks; guarded one-call FAST extraction | Inference denied offline; existence/format is not semantic compliance |
| todo | Serialized list/deltas, required drop reasons, one missing-todo steer, restored exact state | Heuristic multistep detection and model compliance unmeasured |
| verify | Mutation start/completion ledger, later successful check, criteria/artifacts, at most two continuations | Native mechanics proven; model-directed acceptance unmeasured |
| loops | Repeated failure/read/edit-ping-pong detection, bounded notes and xhigh metadata | Heuristics need ablations; user thinking remains xhigh |
| bg | Detached redirected owned services; poll/tail and authenticated nonce kill mailboxes | Unix foreground-group ownership only; supervisor freshness is not service health |
| time | Explicit deadline, 50/75/90% appended notes, monotonic elapsed/threshold restoration | Observed at boundaries, not during a hung call; evaluator deadlines unchanged |
| correct | Pre-schema aliases, explicit hook validation, confined paths/edit preconditions, TUI-only confirmation | Narrow shell parsing is not general static analysis |
| diagnostics | Installed fixed checkers, before/after baseline, only new bounded errors, stripped environment | Optional TypeScript checker absent; project checkers are not OS-sandboxed |
| subagents | Fresh depth-one read/search explore/verify SDK paths, per-request model/effort/policy guards, usage | Actual inference denied; independent repository copy is not an OS jail |
| max | Bounded independent-copy orchestrator, verification ranking, guarded tie judge, cleanup and total usage | Separate configuration; current launcher refuses before allocation; authorized execution/backend remains unmeasured |
| recovery | Bounded native retry settings and temporary launcher-owned settings profile | Current policy refuses before profile/Pi launch; real provider retries unmeasured |

## Native integration and review

The native gate proves manual contract/todo transitions, drop reasons, initial context persistence, two gate continuations, post-mutation verification, nested write/check ordering, one todo steer, two loop notes, three time notes, branch restore and Phase 1 masking composition. Actual bg services keep advancing after their native-session host exits; a new manager authenticates poll/tail/kill and independently confirms a stopped heartbeat. Denial and fault cases fail rather than invent success; lost startup reports recover only newly owned fixture IDs. Final positive fixtures report zero auth, credentials, inference, external transport and ambient discovery attempts.

Independent reviews found and fixed quoted catastrophic-command bypasses, concurrent kill overwrite, incomplete ownership-key publication, scientific deadline forwarding, omitted helper usage after abort/stale/error, and mid-session auxiliary policy revocation. Regression evidence is recorded in per-module reports and final raw logs. Time controls also survive compaction/reload; direct helper accounting prices known usage once and marks partial/missing/unattributed usage incomplete.

The offline validation watchdog reserves its own bounded cleanup envelope; no benchmark task timeout or resources change. Native cleanup never sends a signal to an unchecked persisted PID. Fixtures use owned IDs, direct captured child handles or stop files. Managed execution boundaries have distinct PID namespaces, so cross-command process survival is not a full-container proof.

## Spending and development exceptions

New provider requests/inference and spend: **0 / $0**. Historical nine Muse requests total **$0.002482108**; the unused historical cap remains frozen with no outstanding reservation. MAIN=FAST is openrouter/meta/muse-spark-1.3-contributor and thinking is xhigh. No account operation, cloud/container allocation or system install was used.

An early stub fixture used an unsupported SDK injection seam and reached a credential-availability lookup, failing with no available key; no provider request or spending occurred. The fixture was corrected with explicit SDK/runtime stubs and per-request guards. A worker's unsanitized broad check was stopped by automatic approval review over observed registry access; it is not final verification evidence. Final global checks use an explicit environment whitelist (including the public absolute Node runtime path) and offline npm registry settings. The first stripped-environment full run retained in phase2-unit-initial.log failed eight child fixtures because that public runtime path was omitted; all eight passed when restored to the whitelist, before the fresh full rerun. These exceptions are retained in worker reports.

## Remaining empirical work

No stock Pi dev/held-out/full baseline or Phase 2 model ablation has run. Top five benchmark failure classes, CI effects, token/dollar/wall-time deltas and model-directed tool/contract/todo/verification behavior remain unavailable. evals/phase2-ablations.json records a separate add/remove configuration for every flag, null deltas, zero model runs and no promotion. Phase 0 empirical and Phase 1 cost acceptance remain pending too.

Renewed model-execution authorization and a container host are needed before a priced baseline. Next empirical work is stock Pi first, then one-flag dev ablations and untouched held-out validation. The single-model restriction excludes the brief's eventual two-MAIN-model comparison. Native Windows, actual Cargo/Go/type checkers, provider retry/billing and full max container execution remain unmeasured.
