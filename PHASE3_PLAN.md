# Phase 3 implementation plan

> For workers: execute test-first with disjoint ownership, then independent review. The user’s autonomous agreement selects parallel local execution without additional design/plan handoffs.

Goal: locally deliver the nine default-off daily-driver features on existing Pi0.99.2 with no new paid execution.
Architecture: accounting, shadow checkpoint, workflow/learnings/safety, and deferred asset/session modules behind native hooks; root owns coordinator/launcher/adapters/gates/docs/commits.
Stack: Node ESM, existing pinned Pi/Git/Python; no new dependencies.
Spec: PHASE3_DESIGN.md and APEX_BUILD.md §5.

## Constraints and review focus

Free-only; sole Muse/xhigh; all flags off; no account/key/provider requests, core patches, install or remote operations. Only root runs global npm/check/micro/commits. Workers run their focused tests with PATH/LANG/LC_ALL/CODEX_PRIMARY_RUNTIME_NODE whitelist, PI_OFFLINE and npm offline/localhost registry settings.

Review: sibling mutation vs snapshots, unchanged user Git index, restoration conflicts/partial failure, symlink/ignored/private files, pending/torn/duplicate usage, readonly nested/deferred calls, task/branch isolation and eval learnings denial before I/O.

## Task 1 accounting/report (worker)

Files: extensions/apex-features/accounting.mjs, lib/session-report.mjs, tests/features-accounting.test.mjs, tests/session-report.test.mjs, validation/phase3-accounting-report.md.
Interfaces: summarizeSession(entries,{branch?,context?,model?,pricing?}={}) → detached structured totals/categories/top consumers/tasks/completeness; formatCost(summary) → short status; readSessionReport(file,{maxBytes?}={}) → parsed bounded report; inspectResume(file) → exact native session metadata/pending/torn status. Do not call SDK/providers.
- [x] Write/run failing tests for real JSONL, branch/all totals, helper replay/missing/subsets, unknown context/prices, UTF8 category estimates, no payload echo, malformed/torn/oversized/symlink files, resume without replay.
- [x] Implement pure aggregation/bounded reader, run focused tests/report limits; root later runs globals.

## Task 2 persistent checkpoints (worker)

Files: extensions/apex-features/checkpoints.mjs, tests/features-checkpoints.test.mjs, validation/phase3-checkpoints-report.md.
Interface: createCheckpointManager({cwd,sessionId,runGit?}) → capture(turnId),finish(turnId),list(),restore(turnId),shutdown(). All methods awaitable; no factory processes/I/O. Snapshot before changes with private mirror/shadow Git; queue siblings; metadata scoped session; conflict refusal and bounded restore.
- [x] Test-first real Git dirty/untracked/delete/create, user index hash invariance, ignored/private/symlink rejection, concurrent capture, persisted reopen, manual post-turn conflicts, failure rollback, caps and cancellation.
- [x] Implement, run focused tests and report exact restore/limits. No bare PID signals/user git reset/clean/stash.

## Task 3 workflows/learnings/safety (worker)

Files: extensions/apex-features/workflows.mjs, learnings.mjs, safety.mjs, tests/features-workflows.test.mjs, features-learnings.test.mjs, features-safety.test.mjs, templates/apex-plan.md, templates/apex-review.md, validation/phase3-workflows-report.md.
Interfaces: createPlanManager({cwd,pi,persist,branch=[],policy}) → start(task,ctx),save(markdown,ctx),cancel(ctx),finish(event,ctx),isActive(),gate(event),shutdown(ctx); runReview({cwd,task,policy,verify?},ctx) → guarded result; createLearnings({cwd,evalMode}) → tool(),load(),append(fact); createSafetyGate({pi,evalMode}) → check(event,ctx). Use actual source APIs; no inferred session prompt method.
- [x] Test-first readonly nested/deferred calls, tool restore/cancel/error/reload, exact PLAN path/symlinks, offline before send, guarded review before model callback, concurrent remember/eval pre-I/O refusal, hints/TUI/eval/no-UI approval/cancel.
- [x] Implement and focused tests/report; do not edit coordinator/core/launcher/shared files.

## Task 4 deferred skills (worker)

Files: ten skills/*/SKILL.md with scripts/probe.mjs, tests/features-skills.test.mjs, validation/phase3-skills-report.md; replace skills/README.md.
Interface: valid short named skills with exact relative probe paths; scripts --cwd PATH produce bounded JSON domain-specific static/installed-runtime evidence. Read-only/offline, no shell scripts/database clients/live network/install/production state. Domain names: debugging,test-writing,profiling,build-systems,python-packaging,numerics,http,databases,git-surgery,security-hardening.
- [x] Write/run failing integrity/routing/real-domain probe tests, implement short assets/scripts and run actual probes in synthetic fixtures.
- [x] Report mechanical routing limits; user brief authorizes project Pi assets, not personal skill installation. Root commits package assets.

## Task 5 integration (root)

Files: features config/index, launcher/bin/package/checks/Harbor flags+eval mode, evals/phase3-ablations.json, native gate + tests and analysis reports.
- [x] Test-first feature/prefix/default/model/eval/report/resume parsing and lifecycle/coordinator invariants.
- [x] Integrate native commands/status/tool_call gates/resources/plan-core cooperation/compaction, preserving machine-readable results.
- [x] Native offline gate actual registration/commands/checkpoint/read-only/remember/eval/skills/cost/report/resume reload; fault/denial regressions, no extra model calls.

## Task 6 review/evidence/delivery (root)

- [x] Obtain independent spec/quality reviews; fix findings with regressions.
- [x] Run check/full tests/micro under safe whitelist; preserve initial failures; cleanup owned fixtures.
- [x] Update NOTES/DECISIONS/RESULTS/PROGRESS/README/PHASE3_LOCAL and machine evidence; report limits/spend and pending empirical targets.
Delivery follows committed source: pack/smoke/hash/scan full source/history/raw evidence, verify original traces unchanged, save new phase3 artifacts. No main merge/remote push or new paid authorization is assumed.
