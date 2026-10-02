# Phase 3 local delivery

Phase 3 implements all nine daily-driver flags on Pi 0.99.2, without a fork, new dependencies or default promotion. The current free-only policy remains binding. Local completion means verified commands, hooks, assets and guarded model seams; benchmark acceptance and the full project definition of done remain pending.

| Flag | Implemented and verified locally | Limit |
| --- | --- | --- |
| cost | Native usage/helper/summary aggregation, task/session estimates, cache/context/model footer and `/cost` | Estimates are not invoices; incomplete usage and missing prices remain unknown |
| checkpoints | Persistent shadow Git, first-mutation capture, sibling queue, staged/dirty/untracked undo, branch IDs, conflict/rollback/caps | Regular files/local Git only; 50 records; no cross-process lock, empty-directory lifecycle or automatic interrupted-restore recovery |
| review | Internal template and guarded independent Phase 2 verify on bounded current diff | Inference blocked offline; tracked diff requires HEAD; untracked/binary coverage is limited |
| plan | Native `/plan`, nested/deferred read-only gate, exact atomic PLAN.md, prior-tool restoration, core/compaction cooperation | Offline mode does not start inference; literal save is supported; model-generated plan quality unmeasured |
| remember | Deferred bounded explicit facts, serialized `.apex/LEARNINGS.md`, selected native context-file load | Disabled before access in explicit eval; serialization is in-process |
| skills | Ten short on-demand Pi skills with real offline static domain probes | Mechanical descriptions/probes do not measure model routing accuracy or solve quality |
| safety | Bounded, abortable per-call approval in TUI and dashboard RPC sessions using tool hints and native classifications | Hints are unverified; headless/eval has no dialog; approval UX is not a sandbox |
| report | Actual standalone read-only native JSONL CLI, token categories/top consumers, torn/replayed/incomplete handling | Stored-content UTF-8 bytes/4 estimates are not exact provider input attribution |
| resume | Exact native persisted-session restoration, `/resume-info`, guarded CLI inspection/restore | No in-flight tool replay; pending/torn sessions refuse automatic CLI resume; pi-durable API/integration unverified |

## Final verification

`npm run check`, `npm test` and `npm run micro` pass. **586 unit tests** (440 Node + 146 Python), **one optional TypeScript skip**, **31 native Phase 3 checks**, and all prior Phase 0/1/2 gates pass. Final positive Phase 3 network/auth/inference/credentials/ambient-discovery counters and standalone CLI SDK initialization count are zero. The initial passed and failed runs remain alongside the final logs. `validation/phase3-local.json` records the exact scope; source/history and the 18 original raw-evidence files are hash-checked during packaging.

## Native integration and reviews

Real Pi extension command handlers, resources, session persistence and nested tool execution exercise plan enforcement, learnings/eval isolation, static skill-body reads, script-seeded accounting, shadow-Git restore and pending-call inspection. Actual guarded CLI subprocesses prove report succeeds without SDK initialization and resume/model/max refusals precede prohibited allocation. Passing native evidence records zero network/auth/inference/credentials/ambient-discovery attempts. Fake assistant/usage records are explicitly synthetic; no model response or provider spend is implied.

Independent reviews corrected six integration defects: session-wide checkpoint IDs, active-branch undo filtering, extension-local flag visibility/duplicate confirmations, boolean eval prompt loss, encoded filesystem URLs, and preservation of Phase 1 tool schemas under core correction. They also corrected torn-tail task/subset accounting, nonblocking FIFO-race reads checkpoint growth allocation caps, and literal prompt placeholder filling. Tests reproduce real reader failures before their fixes. The full suite also exposed a detached-service startup/deadline race and a session fault hitting its unchanged five-second child deadline under heavy unit-file concurrency. A delayed-start regression corrected the former; the offline unit runner caps file concurrency at two for the latter, without changing fixture or benchmark timeouts/resources. Initial failed logs remain preserved. Review reports and raw global verification logs are included under validation/.

Lifecycle coordination uses immutable owner-scoped WeakMaps keyed by the native session manager, because Pi flags are scoped to their declaring extension. Custom feature state persists numeric high-water and branch checkpoint IDs, and compaction copies that state and active plan state verbatim. No hook changes existing machine-readable tool results. Factories register flags/hooks only; shutdown restores owned tool selections/statuses and stops private manager work.

## Spend and remaining work

Phase 3 provider requests/spend: **0 / $0**. Historical nine Muse requests total **$0.002482108**; remaining **$0.997517892** is frozen, reserved **$0**. MAIN=FAST remains openrouter/meta/muse-spark-1.3-contributor, thinking xhigh. No account operation, new paid service/container, dependency install or Pi core patch occurred.

Every Phase 3 flag has null pass-rate/CI/token/dollar/wall-time deltas, zero model runs and default_enabled=false in evals/phase3-ablations.json. Top five benchmark failure classes remain unknown because no baseline trajectories exist. Full dev/held-out/Terminal-Bench results, cost-per-solve targets, real planning/review/routing behavior and the eventual two-MAIN-model comparison remain unmeasured. Native Windows and real container execution remain untested. A future empirical baseline needs renewed model-execution authorization, a container host, immutable image digests and a reviewed whole-run estimate; the existing cap does not override free-only policy.

The next local engineering phase is Phase 4's proposer/evaluation loop infrastructure; it must retain held-out isolation and remain guarded against priced execution until authorized. No Phase 4 iteration is started by this delivery.
